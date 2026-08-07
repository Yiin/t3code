// @effect-diagnostics nodeBuiltinImport:off globalTimers:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { makeTerminalAgentDispatch, parseTerminalArtifact } from "./TerminalAgentDispatch.ts";

describe("TerminalAgentDispatch final assistant selection", () => {
  it("ignores protocol text outside the Codex final agent message", () => {
    const artifact = [
      JSON.stringify({ type: "item.completed", item: { type: "tool_output", text: "RALPH_DONE" } }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: 'RALPH_MSG: {"summary":"built","why":"needed"}' },
      }),
      JSON.stringify({ type: "turn.completed" }),
    ].join("\n");
    assert.equal(
      parseTerminalArtifact("codex", artifact).finalText,
      'RALPH_MSG: {"summary":"built","why":"needed"}',
    );
  });

  it("uses only the Claude result field", () => {
    const artifact = JSON.stringify({
      type: "result",
      result: "RALPH_DONE",
      session_id: "session-1",
      total_cost_usd: 1,
    });
    assert.deepEqual(parseTerminalArtifact("claude", artifact), {
      finalText: "RALPH_DONE",
      sessionId: "session-1",
      providerError: null,
    });
  });

  it("uses text from OpenCode's final stopped step", () => {
    const artifact = [
      JSON.stringify({ type: "text", sessionID: "s", part: { type: "text", text: "old" } }),
      JSON.stringify({ type: "step_finish", part: { reason: "tool-calls" } }),
      JSON.stringify({ type: "text", sessionID: "s", part: { type: "text", text: "RALPH_" } }),
      JSON.stringify({ type: "text", sessionID: "s", part: { type: "text", text: "DONE" } }),
      JSON.stringify({ type: "step_finish", part: { reason: "stop" } }),
    ].join("\n");
    assert.equal(parseTerminalArtifact("opencode", artifact).finalText, "RALPH_DONE");
  });

  it("uses Kimi's last assistant message without tool calls", () => {
    const artifact = [
      JSON.stringify({ role: "assistant", content: "tool preface", tool_calls: [{}] }),
      JSON.stringify({ role: "tool", content: "RALPH_DONE" }),
      JSON.stringify({ role: "assistant", content: "RALPH_MSG: final" }),
      JSON.stringify({ role: "meta", type: "session.resume_hint", session_id: "kimi-session" }),
    ].join("\n");
    assert.deepEqual(parseTerminalArtifact("kimi", artifact), {
      finalText: "RALPH_MSG: final",
      sessionId: "kimi-session",
      providerError: null,
    });
  });

  it("extracts nested structured provider errors", () => {
    const artifact = JSON.stringify({
      type: "error",
      error: { kind: "provider", detail: { message: "rate limit exceeded" } },
    });
    assert.include(
      parseTerminalArtifact("codex", artifact).providerError ?? "",
      "rate limit exceeded",
    );
  });
});

const makeWorker = (body: string) => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "terminal-dispatch-"));
  const worker = NodePath.join(directory, "worker.sh");
  NodeFS.writeFileSync(worker, `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`);
  NodeFS.chmodSync(worker, 0o755);
  return { directory, worker };
};

const startWorker = (
  body: string,
  options: { maxArtifactBytes?: number; timeoutSeconds?: number; stopGraceSeconds?: number } = {},
) =>
  Effect.gen(function* () {
    const fixture = yield* Effect.acquireRelease(
      Effect.sync(() => makeWorker(body)),
      ({ directory }) =>
        Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
    );
    const dispatch = makeTerminalAgentDispatch({
      harness: "worker-cmd",
      artifactsDirectory: fixture.directory,
      workerCommand: fixture.worker,
      ...options,
    });
    const handle = yield* dispatch.startIteration({
      runId: "run",
      iterationIndex: 0,
      cwd: fixture.directory,
      worktreePath: null,
      prompt: "test",
      selection: { instanceId: ProviderInstanceId.make("worker-cmd"), model: "test" },
    });
    yield* Effect.addFinalizer(() => handle.release.pipe(Effect.ignore));
    return { ...fixture, handle };
  });

it.live("bounds worker artifacts and keeps the final tail", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { handle } = yield* startWorker(
        "head -c 10000 /dev/zero | tr '\\0' x; echo RALPH_DONE",
        { maxArtifactBytes: 256 },
      );
      yield* handle.awaitSettled;
      assert.isAtMost(NodeFS.statSync(handle.ref).size, 256);
      assert.include((yield* handle.finalMessage).text ?? "", "RALPH_DONE");
    }),
  ),
);

it.live("times out with TERM then KILL and does not trust a generic exit", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { handle } = yield* startWorker("trap '' TERM; sleep 30", {
        timeoutSeconds: 0.05,
        stopGraceSeconds: 0.05,
      });
      const settled = yield* handle.awaitSettled;
      assert.isTrue(settled.timedOut);
      assert.isNull(settled.providerError);
    }),
  ),
);

it.live("reaps detached descendants after the leader exits", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { directory, handle } = yield* startWorker(
        "(trap '' TERM; sleep 30) >/dev/null 2>&1 & echo $! > descendant.pid; echo RALPH_DONE",
        { stopGraceSeconds: 0.05 },
      );
      yield* handle.awaitSettled;
      const descendant = Number(
        NodeFS.readFileSync(NodePath.join(directory, "descendant.pid"), "utf8"),
      );
      yield* handle.release;
      assert.throws(() => process.kill(descendant, 0));
    }),
  ),
);

it.live("clears timeout escalation when the child closes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { handle } = yield* startWorker("echo RALPH_DONE", {
        timeoutSeconds: 0.05,
        stopGraceSeconds: 0.05,
      });
      const settled = yield* handle.awaitSettled;
      assert.isFalse(settled.timedOut);
      yield* Effect.sleep("100 millis");
    }),
  ),
);

it.live("escalates a TERM-resistant interrupt and verifies exit", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { handle } = yield* startWorker("trap '' TERM; sleep 30", {
        stopGraceSeconds: 0.05,
      });
      yield* handle.interrupt;
      const settled = yield* handle.awaitSettled;
      assert.equal(settled.turnState, "interrupted");
    }),
  ),
);

const startStructuredHarness = (
  body: string,
  maxArtifactBytes = 1024,
  permissionMode?: string,
  useHarnessDefaultModel = false,
) =>
  Effect.gen(function* () {
    const fixture = yield* Effect.acquireRelease(
      Effect.sync(() => makeWorker(body)),
      ({ directory }) =>
        Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
    );
    const dispatch = makeTerminalAgentDispatch({
      harness: "codex",
      binary: fixture.worker,
      artifactsDirectory: fixture.directory,
      maxArtifactBytes,
      stopGraceSeconds: 0.05,
      ...(permissionMode === undefined ? {} : { permissionMode }),
      useHarnessDefaultModel,
    });
    const handle = yield* dispatch.startIteration({
      runId: "structured",
      iterationIndex: 0,
      cwd: fixture.directory,
      worktreePath: null,
      prompt: "test",
      selection: { instanceId: ProviderInstanceId.make("codex"), model: "test" },
    });
    yield* Effect.addFinalizer(() => handle.release.pipe(Effect.ignore));
    return { ...fixture, handle };
  });

it.live("preserves an early structured error after artifact truncation", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { handle } = yield* startStructuredHarness(
        `printf '%s\\n' '{"type":"event","payload":{"type":"error","error":{"message":"early rate limit"}}}'
head -c 10000 /dev/zero | tr '\\0' x
printf '\\n%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"final"}}'`,
        256,
      );
      const settled = yield* handle.awaitSettled;
      assert.include(settled.providerError ?? "", "early rate limit");
      assert.notInclude(NodeFS.readFileSync(handle.ref, "utf8"), "early rate limit");
    }),
  ),
);

it.live("reports Codex subagent event bookkeeping", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { handle } = yield* startStructuredHarness(
        `printf '%s\\n' '{"type":"item.started","item":{"type":"collab_tool_call","agents_states":{"child-1":{"status":"running"}}}}'
printf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"final"}}'`,
      );
      yield* handle.awaitSettled;
      assert.deepEqual(yield* handle.runningSubagents, {
        mode: "event-bookkeeping",
        running: 1,
      });
      assert.equal(handle.capabilities.terminalSignal, "process-exit");
    }),
  ),
);

it.live("passes the Codex bypass permission mode to the harness", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { directory, handle } = yield* startStructuredHarness(
        `printf '%s\n' "$@" > args
printf '%s\n' '{"type":"item.completed","item":{"type":"agent_message","text":"final"}}'`,
        1_024,
        "bypassPermissions",
      );
      yield* handle.awaitSettled;
      const args = NodeFS.readFileSync(NodePath.join(directory, "args"), "utf8");
      assert.include(args, "--dangerously-bypass-approvals-and-sandbox");
      assert.notInclude(args, "danger-full-access");
    }),
  ),
);

it.live("lets Codex select its default model when no model was configured", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { directory, handle } = yield* startStructuredHarness(
        `printf '%s\n' "$@" > args
printf '%s\n' '{"type":"item.completed","item":{"type":"agent_message","text":"final"}}'`,
        1_024,
        undefined,
        true,
      );
      yield* handle.awaitSettled;
      const args = NodeFS.readFileSync(NodePath.join(directory, "args"), "utf8").split("\n");
      assert.notInclude(args, "-m");
    }),
  ),
);

it.live("routes a fallback selection to its own harness", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* Effect.acquireRelease(
        Effect.sync(() =>
          makeWorker(`printf '%s\n' "$@" > args
printf '%s\n' '{"role":"assistant","content":"RALPH_DONE"}'`),
        ),
        ({ directory }) =>
          Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
      );
      const dispatch = makeTerminalAgentDispatch({
        harness: "claude",
        artifactsDirectory: fixture.directory,
        providerRoutes: [
          {
            instanceId: ProviderInstanceId.make("kimi"),
            driver: ProviderDriverKind.make("kimi"),
            harness: "kimi",
            binary: fixture.worker,
            model: "kimi-code/k3",
            primary: false,
          },
        ],
      });
      const handle = yield* dispatch.startIteration({
        runId: "fallback",
        iterationIndex: 0,
        cwd: fixture.directory,
        worktreePath: null,
        prompt: "test",
        selection: { instanceId: ProviderInstanceId.make("kimi"), model: "kimi-code/k3" },
      });
      yield* Effect.addFinalizer(() => handle.release.pipe(Effect.ignore));
      yield* handle.awaitSettled;
      assert.equal((yield* handle.finalMessage).text, "RALPH_DONE");
      assert.equal(handle.capabilities.finalMessage, "assistant-jsonl");
      const args = NodeFS.readFileSync(NodePath.join(fixture.directory, "args"), "utf8");
      assert.include(args, "kimi-code/k3");
    }),
  ),
);

it.live("applies Codex reasoning options from a fallback selection", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* Effect.acquireRelease(
        Effect.sync(() =>
          makeWorker(`printf '%s\n' "$@" > args
printf '%s\n' '{"type":"item.completed","item":{"type":"agent_message","text":"RALPH_DONE"}}'`),
        ),
        ({ directory }) =>
          Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
      );
      const dispatch = makeTerminalAgentDispatch({
        harness: "claude",
        artifactsDirectory: fixture.directory,
        providerRoutes: [
          {
            instanceId: ProviderInstanceId.make("codex"),
            driver: ProviderDriverKind.make("codex"),
            harness: "codex",
            binary: fixture.worker,
            model: "gpt-5.6-sol",
            primary: false,
          },
        ],
      });
      const handle = yield* dispatch.startIteration({
        runId: "fallback",
        iterationIndex: 0,
        cwd: fixture.directory,
        worktreePath: null,
        prompt: "test",
        selection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.6-sol",
          options: [{ id: "reasoningEffort", value: "high" }],
        },
      });
      yield* Effect.addFinalizer(() => handle.release.pipe(Effect.ignore));
      yield* handle.awaitSettled;
      assert.equal((yield* handle.finalMessage).text, "RALPH_DONE");
      const args = NodeFS.readFileSync(NodePath.join(fixture.directory, "args"), "utf8");
      assert.include(args, 'model_reasoning_effort="high"');
    }),
  ),
);
