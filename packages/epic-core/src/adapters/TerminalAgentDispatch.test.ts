// @effect-diagnostics nodeBuiltinImport:off globalTimers:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { WorkerScopePreparation } from "../workerScope.ts";
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

  it("uses Prime's last completed assistant message text blocks", () => {
    const artifact = [
      JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "old" },
            { type: "thinking", thinking: "hidden" },
          ],
        },
      }),
      JSON.stringify({
        type: "message_end",
        message: { role: "toolResult", content: [{ type: "text", text: "RALPH_DONE" }] },
      }),
      JSON.stringify({
        type: "turn_end",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "RALPH_MSG: " },
            { type: "text", text: "final" },
          ],
        },
        toolResults: [],
      }),
    ].join("\n");
    assert.deepEqual(parseTerminalArtifact("prime", artifact), {
      finalText: "RALPH_MSG: final",
      sessionId: null,
      providerError: null,
    });
  });

  it("classifies only documented Prime structured failures", () => {
    const retryFailure = JSON.stringify({
      type: "auto_retry_end",
      success: false,
      attempt: 3,
      finalError: "rate limit exceeded",
    });
    assert.equal(parseTerminalArtifact("prime", retryFailure).providerError, "rate limit exceeded");

    const assistantFailure = JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "provider-error: ignored prose" }],
        stopReason: "error",
        errorMessage: "authentication failed",
      },
    });
    assert.deepEqual(parseTerminalArtifact("prime", assistantFailure), {
      finalText: "provider-error: ignored prose",
      sessionId: null,
      providerError: "authentication failed",
    });

    const artifact = JSON.stringify({
      type: "error",
      error: { kind: "provider", message: "rate limit exceeded" },
    });
    assert.deepEqual(parseTerminalArtifact("prime", artifact), {
      finalText: null,
      sessionId: null,
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
  options: {
    maxArtifactBytes?: number;
    timeoutSeconds?: number;
    stopGraceSeconds?: number;
    workerScope?: WorkerScopePreparation;
  } = {},
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

it.live("lets Claude iterations use the harness default model", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* Effect.acquireRelease(
        Effect.sync(() =>
          makeWorker(`printf '%s\n' "$@" > args
printf '%s\n' '{"type":"result","result":"final"}'`),
        ),
        ({ directory }) =>
          Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
      );
      const dispatch = makeTerminalAgentDispatch({
        harness: "claude",
        artifactsDirectory: fixture.directory,
        binary: fixture.worker,
        useHarnessDefaultModel: true,
      });
      const handle = yield* dispatch.startIteration({
        runId: "claude-default-model",
        iterationIndex: 0,
        cwd: fixture.directory,
        worktreePath: null,
        prompt: "test",
        selection: {
          instanceId: ProviderInstanceId.make("claude"),
          model: "claude-sonnet-5",
        },
      });
      yield* Effect.addFinalizer(() => handle.release.pipe(Effect.ignore));
      yield* handle.awaitSettled;
      const args = NodeFS.readFileSync(NodePath.join(fixture.directory, "args"), "utf8").split(
        "\n",
      );
      assert.notInclude(args, "--model");
      assert.notInclude(args, "claude-sonnet-5");
      assert.notInclude(args, "--no-session-persistence");
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

const primeEvent = JSON.stringify({
  type: "message_end",
  message: { role: "assistant", content: [{ type: "text", text: "RALPH_DONE" }] },
});

const startPrime = (input: {
  readonly useHarnessDefaultModel?: boolean;
  readonly worktreePath?: string | null;
  readonly environment?: NodeJS.ProcessEnv;
  readonly binary?: string;
}) =>
  Effect.gen(function* () {
    const fixture = yield* Effect.acquireRelease(
      Effect.sync(() =>
        makeWorker(`printf '%s\\n' "$@" > "$CAPTURE_DIR/args"
pwd > "$CAPTURE_DIR/cwd"
printf '%s\\n' "\${COOKEPIC_ROLE:-}" "\${COOKEPIC_FOLD:-}" "\${COOKEPIC_INSPECTOR:-}" > "$CAPTURE_DIR/env"
printf '%s\\n' '${primeEvent}'`),
      ),
      ({ directory }) =>
        Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
    );
    const effectiveCwd = input.worktreePath ?? fixture.directory;
    NodeFS.mkdirSync(effectiveCwd, { recursive: true });
    const dispatch = makeTerminalAgentDispatch({
      harness: "prime",
      artifactsDirectory: fixture.directory,
      binary: input.binary ?? fixture.worker,
      ...(input.useHarnessDefaultModel === undefined
        ? {}
        : { useHarnessDefaultModel: input.useHarnessDefaultModel }),
      environment: { CAPTURE_DIR: fixture.directory, ...input.environment },
    });
    const handle = yield* dispatch.startIteration({
      runId: "prime",
      iterationIndex: 0,
      cwd: fixture.directory,
      worktreePath: input.worktreePath ?? null,
      prompt: "cook child",
      selection: { instanceId: ProviderInstanceId.make("prime"), model: "prime/model" },
    });
    yield* Effect.addFinalizer(() => handle.release.pipe(Effect.ignore));
    return { ...fixture, effectiveCwd, handle };
  });

it.live("runs Prime workers with the effective cwd, model, and worker role", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const worktree = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "prime-worktree-"));
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(worktree, { recursive: true, force: true })),
      );
      const { directory, handle } = yield* startPrime({
        worktreePath: worktree,
        environment: { COOKEPIC_FOLD: "stale", COOKEPIC_INSPECTOR: "stale" },
      });
      const settled = yield* handle.awaitSettled;
      assert.deepEqual(settled, { turnState: "completed", timedOut: false, providerError: null });
      assert.deepEqual(
        NodeFS.readFileSync(NodePath.join(directory, "args"), "utf8").trim().split("\n"),
        [
          "--mode",
          "json",
          "--no-session",
          "--cwd",
          worktree,
          "--model",
          "prime/model",
          "--",
          "cook child",
        ],
      );
      assert.equal(NodeFS.readFileSync(NodePath.join(directory, "cwd"), "utf8").trim(), worktree);
      assert.deepEqual(
        NodeFS.readFileSync(NodePath.join(directory, "env"), "utf8").split("\n").slice(0, 3),
        ["worker", "", ""],
      );
      assert.equal((yield* handle.finalMessage).text, "RALPH_DONE");
      assert.equal(handle.capabilities.continuation, "none");
      assert.equal(handle.capabilities.providerErrors, "session-only");
      assert.equal(handle.capabilities.cost, "none");
    }),
  ),
);

it.live("omits the Prime model when the harness default is selected", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { directory, handle } = yield* startPrime({ useHarnessDefaultModel: true });
      yield* handle.awaitSettled;
      const args = NodeFS.readFileSync(NodePath.join(directory, "args"), "utf8").split("\n");
      assert.notInclude(args, "--model");
      assert.notInclude(args, "prime/model");
    }),
  ),
);

it.live("retains Prime final text before a bounded tail and ignores structured errors", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* Effect.acquireRelease(
        Effect.sync(() =>
          makeWorker(`printf '%s\\n' '${primeEvent}'
printf '%s\\n' '{"type":"error","error":{"message":"rate limit exceeded"}}'
printf '%s' '{"type":"agent_end","messages":[{"role":"assistant","content":"'
head -c 4096 /dev/zero | tr '\\0' x
printf '%s\\n' '"}]}'`),
        ),
        ({ directory }) =>
          Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
      );
      const dispatch = makeTerminalAgentDispatch({
        harness: "prime",
        artifactsDirectory: fixture.directory,
        binary: fixture.worker,
        maxArtifactBytes: 256,
      });
      const handle = yield* dispatch.startIteration({
        runId: "prime-bounded",
        iterationIndex: 0,
        cwd: fixture.directory,
        worktreePath: null,
        prompt: "test",
        selection: { instanceId: ProviderInstanceId.make("prime"), model: "default" },
      });
      yield* Effect.addFinalizer(() => handle.release.pipe(Effect.ignore));
      const settled = yield* handle.awaitSettled;
      assert.isNull(settled.providerError);
      assert.equal((yield* handle.finalMessage).text, "RALPH_DONE");
      assert.notInclude(NodeFS.readFileSync(handle.ref, "utf8"), "RALPH_DONE");
    }),
  ),
);

it.live("settles a documented Prime retry failure as a provider error", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* Effect.acquireRelease(
        Effect.sync(() =>
          makeWorker(
            `printf '%s\n' '{"type":"auto_retry_end","success":false,"attempt":3,"finalError":"rate limit exceeded"}'`,
          ),
        ),
        ({ directory }) =>
          Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
      );
      const dispatch = makeTerminalAgentDispatch({
        harness: "prime",
        artifactsDirectory: fixture.directory,
        binary: fixture.worker,
      });
      const handle = yield* dispatch.startIteration({
        runId: "prime-retry-failed",
        iterationIndex: 0,
        cwd: fixture.directory,
        worktreePath: null,
        prompt: "test",
        selection: { instanceId: ProviderInstanceId.make("prime"), model: "default" },
      });
      yield* Effect.addFinalizer(() => handle.release.pipe(Effect.ignore));
      assert.deepEqual(yield* handle.awaitSettled, {
        turnState: "error",
        timedOut: false,
        providerError: "rate limit exceeded",
      });
    }),
  ),
);

it.live("reports a missing Prime binary through the existing settle diagnostic", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const directory = yield* Effect.acquireRelease(
        Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "prime-missing-"))),
        (path) => Effect.sync(() => NodeFS.rmSync(path, { recursive: true, force: true })),
      );
      const missing = NodePath.join(directory, "missing-prime-agent");
      const dispatch = makeTerminalAgentDispatch({
        harness: "prime",
        artifactsDirectory: directory,
        binary: missing,
      });
      const handle = yield* dispatch.startIteration({
        runId: "prime-missing",
        iterationIndex: 0,
        cwd: directory,
        worktreePath: null,
        prompt: "test",
        selection: { instanceId: ProviderInstanceId.make("prime"), model: "default" },
      });
      yield* Effect.addFinalizer(() => handle.release.pipe(Effect.ignore));
      const settled = yield* handle.awaitSettled;
      assert.equal(settled.turnState, "error");
      assert.include(settled.providerError ?? "", "ENOENT");
      assert.include(settled.providerError ?? "", "missing-prime-agent");
    }),
  ),
);

it.live("separates unavailable commands from generic nonzero exits", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const unavailableBinary = yield* Effect.acquireRelease(
        Effect.sync(() => makeWorker("exit 127")),
        ({ directory }) =>
          Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
      );
      const unavailable = yield* startPrime({
        binary: unavailableBinary.worker,
      });
      const unavailableSettle = yield* unavailable.handle.awaitSettled;
      assert.equal(unavailableSettle.turnState, "error");
      assert.equal(unavailableSettle.providerError, "provider command unavailable (exit 127)");

      const genericBinary = yield* Effect.acquireRelease(
        Effect.sync(() => makeWorker("exit 1")),
        ({ directory }) =>
          Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
      );
      const generic = yield* startPrime({
        binary: genericBinary.worker,
      });
      const genericSettle = yield* generic.handle.awaitSettled;
      assert.equal(genericSettle.turnState, "error");
      assert.isNull(genericSettle.providerError);
    }),
  ),
);

it.live("runs Prime fold and inspector helpers with isolated roles", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* Effect.acquireRelease(
        Effect.sync(() =>
          makeWorker(`printf '%s\\n' "$@" > "$CAPTURE_DIR/$COOKEPIC_ROLE.args"
pwd > "$CAPTURE_DIR/$COOKEPIC_ROLE.cwd"
printf '%s\\n' "\${COOKEPIC_ROLE:-}" "\${COOKEPIC_FOLD:-}" "\${COOKEPIC_INSPECTOR:-}" > "$CAPTURE_DIR/$COOKEPIC_ROLE.env"
printf '%s\\n' '${primeEvent}'
printf '%s' '{"type":"agent_end","messages":[{"role":"assistant","content":"'
head -c 4096 /dev/zero | tr '\\0' x
printf '%s\\n' '"}]}'`),
        ),
        ({ directory }) =>
          Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
      );
      const dispatch = makeTerminalAgentDispatch({
        harness: "prime",
        artifactsDirectory: fixture.directory,
        binary: fixture.worker,
        maxArtifactBytes: 512,
        environment: {
          CAPTURE_DIR: fixture.directory,
          COOKEPIC_FOLD: "stale",
          COOKEPIC_INSPECTOR: "stale",
        },
      });
      const selection = { instanceId: ProviderInstanceId.make("prime"), model: "prime/model" };
      const fold = yield* dispatch.runAuxiliary({
        purpose: "epic-note-fold",
        cwd: fixture.directory,
        prompt: "fold notes",
        selection,
      });
      const inspector = yield* dispatch.runAuxiliary({
        purpose: "idle-inspection",
        cwd: fixture.directory,
        prompt: "inspect worker",
        selection,
      });
      assert.deepEqual(fold, { output: "RALPH_DONE", succeeded: true });
      assert.deepEqual(inspector, { output: "RALPH_DONE", succeeded: true });
      assert.deepEqual(
        NodeFS.readFileSync(NodePath.join(fixture.directory, "fold.args"), "utf8")
          .trim()
          .split("\n"),
        [
          "--mode",
          "json",
          "--no-session",
          "--cwd",
          fixture.directory,
          "--model",
          "prime/model",
          "--",
          "fold notes",
        ],
      );
      assert.deepEqual(
        NodeFS.readFileSync(NodePath.join(fixture.directory, "inspector.args"), "utf8")
          .trim()
          .split("\n"),
        [
          "--mode",
          "json",
          "--no-session",
          "--cwd",
          fixture.directory,
          "--no-tools",
          "--no-skills",
          "--no-context-files",
          "--no-extensions",
          "--no-prompt-templates",
          "--model",
          "prime/model",
          "--",
          "inspect worker",
        ],
      );
      assert.deepEqual(
        NodeFS.readFileSync(NodePath.join(fixture.directory, "fold.env"), "utf8")
          .split("\n")
          .slice(0, 3),
        ["fold", "1", ""],
      );
      assert.deepEqual(
        NodeFS.readFileSync(NodePath.join(fixture.directory, "inspector.env"), "utf8")
          .split("\n")
          .slice(0, 3),
        ["inspector", "", "1"],
      );
      assert.equal(
        NodeFS.readFileSync(NodePath.join(fixture.directory, "fold.cwd"), "utf8").trim(),
        fixture.directory,
      );
    }),
  ),
);

it.live("runs a Claude note fold and returns its final result", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* Effect.acquireRelease(
        Effect.sync(() =>
          makeWorker(`printf '%s\n' "$@" > args
printf '%s\n' '{"type":"result","result":"folded notes","session_id":"aux-session"}'`),
        ),
        ({ directory }) =>
          Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
      );
      const dispatch = makeTerminalAgentDispatch({
        harness: "claude",
        artifactsDirectory: fixture.directory,
        binary: fixture.worker,
        permissionMode: "bypassPermissions",
      });
      const result = yield* dispatch.runAuxiliary({
        purpose: "epic-note-fold",
        cwd: fixture.directory,
        prompt: "fold notes",
        selection: {
          instanceId: ProviderInstanceId.make("claude"),
          model: "claude-sonnet-5",
        },
      });
      assert.deepEqual(result, { output: "folded notes", succeeded: true });
      assert.deepEqual(
        NodeFS.readFileSync(NodePath.join(fixture.directory, "args"), "utf8").trim().split("\n"),
        [
          "-p",
          "--permission-mode",
          "bypassPermissions",
          "--output-format",
          "json",
          "--model",
          "claude-sonnet-5",
          "--exclude-dynamic-system-prompt-sections",
          "--no-session-persistence",
          "--",
          "fold notes",
        ],
      );
    }),
  ),
);

it.live("routes CCX idle inspection with tool and slash command restrictions", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* Effect.acquireRelease(
        Effect.sync(() =>
          makeWorker(`printf '%s\n' "$@" > args
pwd > cwd
printf '%s' "\${AUX_TEST_VALUE:-}" > env
printf '%s\n' '{"type":"result","result":"idle"}'`),
        ),
        ({ directory }) =>
          Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
      );
      const dispatch = makeTerminalAgentDispatch({
        harness: "prime",
        artifactsDirectory: fixture.directory,
        environment: { AUX_TEST_VALUE: "routed-environment" },
        providerRoutes: [
          {
            instanceId: ProviderInstanceId.make("ccx-account"),
            driver: ProviderDriverKind.make("claudeAgent"),
            harness: "ccx",
            binary: fixture.worker,
            model: "claude-opus-5",
            primary: false,
          },
        ],
      });
      const result = yield* dispatch.runAuxiliary({
        purpose: "idle-inspection",
        cwd: fixture.directory,
        prompt: "inspect worker",
        selection: {
          instanceId: ProviderInstanceId.make("ccx-account"),
          model: "claude-opus-5",
        },
      });
      assert.deepEqual(result, { output: "idle", succeeded: true });
      assert.deepEqual(
        NodeFS.readFileSync(NodePath.join(fixture.directory, "args"), "utf8").split("\n"),
        [
          "-p",
          "--permission-mode",
          "auto",
          "--output-format",
          "json",
          "--model",
          "claude-opus-5",
          "--exclude-dynamic-system-prompt-sections",
          "--no-session-persistence",
          "--tools",
          "",
          "--disable-slash-commands",
          "--",
          "inspect worker",
          "",
        ],
      );
      assert.equal(
        NodeFS.readFileSync(NodePath.join(fixture.directory, "cwd"), "utf8").trim(),
        fixture.directory,
      );
      assert.equal(
        NodeFS.readFileSync(NodePath.join(fixture.directory, "env"), "utf8"),
        "routed-environment",
      );
    }),
  ),
);

it.live("lets Claude auxiliaries use the harness default model", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* Effect.acquireRelease(
        Effect.sync(() =>
          makeWorker(`printf '%s\n' "$@" > args
printf '%s\n' '{"type":"result","result":"folded"}'`),
        ),
        ({ directory }) =>
          Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
      );
      const dispatch = makeTerminalAgentDispatch({
        harness: "claude",
        artifactsDirectory: fixture.directory,
        binary: fixture.worker,
        useHarnessDefaultModel: true,
      });
      yield* dispatch.runAuxiliary({
        purpose: "epic-note-fold",
        cwd: fixture.directory,
        prompt: "fold",
        selection: {
          instanceId: ProviderInstanceId.make("claude"),
          model: "claude-sonnet-5",
        },
      });
      const args = NodeFS.readFileSync(NodePath.join(fixture.directory, "args"), "utf8").split(
        "\n",
      );
      assert.notInclude(args, "--model");
      assert.notInclude(args, "claude-sonnet-5");
    }),
  ),
);

it.live("fails a Claude auxiliary with a structured provider error", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* Effect.acquireRelease(
        Effect.sync(() =>
          makeWorker(`printf '%s\n' '{"type":"result","is_error":true,"result":"rate limited"}'`),
        ),
        ({ directory }) =>
          Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
      );
      const dispatch = makeTerminalAgentDispatch({
        harness: "claude",
        artifactsDirectory: fixture.directory,
        binary: fixture.worker,
      });
      const result = yield* dispatch.runAuxiliary({
        purpose: "epic-note-fold",
        cwd: fixture.directory,
        prompt: "fold",
        selection: { instanceId: ProviderInstanceId.make("claude"), model: "sonnet" },
      });
      assert.deepEqual(result, { output: "rate limited", succeeded: false });
    }),
  ),
);

it.live("preserves a Claude auxiliary result before bounded output", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* Effect.acquireRelease(
        Effect.sync(() =>
          makeWorker(`printf '%s\n' '{"type":"result","result":"folded notes"}'
head -c 4096 /dev/zero | tr '\\0' x`),
        ),
        ({ directory }) =>
          Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
      );
      const dispatch = makeTerminalAgentDispatch({
        harness: "claude",
        artifactsDirectory: fixture.directory,
        binary: fixture.worker,
        maxArtifactBytes: 256,
      });
      const result = yield* dispatch.runAuxiliary({
        purpose: "epic-note-fold",
        cwd: fixture.directory,
        prompt: "fold",
        selection: { instanceId: ProviderInstanceId.make("claude"), model: "sonnet" },
      });
      assert.deepEqual(result, { output: "folded notes", succeeded: true });
    }),
  ),
);

it.live("rejects unsupported auxiliary harnesses with a dispatch error", () =>
  Effect.gen(function* () {
    const dispatch = makeTerminalAgentDispatch({
      harness: "opencode",
      artifactsDirectory: NodeOS.tmpdir(),
    });
    const error = yield* dispatch
      .runAuxiliary({
        purpose: "idle-inspection",
        cwd: NodeOS.tmpdir(),
        prompt: "inspect",
        selection: { instanceId: ProviderInstanceId.make("opencode"), model: "test" },
      })
      .pipe(Effect.flip);
    assert.equal(error._tag, "DispatchError");
    assert.include(error.detail, "opencode");
    assert.include(error.detail, "idle-inspection");
  }),
);

it.live("kills a TERM-resistant Prime auxiliary process group after timeout", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* Effect.acquireRelease(
        Effect.sync(() =>
          makeWorker(`(trap '' TERM; sleep 30) >/dev/null 2>&1 &
echo $! > descendant.pid
trap '' TERM
sleep 30`),
        ),
        ({ directory }) =>
          Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
      );
      const dispatch = makeTerminalAgentDispatch({
        harness: "prime",
        artifactsDirectory: fixture.directory,
        binary: fixture.worker,
        timeoutSeconds: 0.05,
        stopGraceSeconds: 0.05,
      });
      const result = yield* dispatch.runAuxiliary({
        purpose: "idle-inspection",
        cwd: fixture.directory,
        prompt: "inspect",
        selection: { instanceId: ProviderInstanceId.make("prime"), model: "default" },
      });
      assert.isFalse(result.succeeded);
      const descendant = Number(
        NodeFS.readFileSync(NodePath.join(fixture.directory, "descendant.pid"), "utf8"),
      );
      assert.throws(() => process.kill(descendant, 0));
    }),
  ),
);

const systemdScopeAvailable = (): boolean => {
  const probe = NodeChildProcess.spawnSync(
    "systemd-run",
    ["--user", "--scope", "--quiet", "--", "true"],
    {
      stdio: "ignore",
    },
  );
  return probe.status === 0;
};

it.live("runs the worker inside its named systemd scope when governance is active", () =>
  Effect.scoped(
    Effect.gen(function* () {
      if (!systemdScopeAvailable()) return;
      const unit = "cook-epic-testdispatch-iteration-0.scope";
      const { handle } = yield* startWorker("cat /proc/self/cgroup; echo RALPH_DONE", {
        workerScope: { scopeId: "testdispatch", active: true },
      });
      yield* handle.awaitSettled;
      const artifact = NodeFS.readFileSync(handle.ref, "utf8");
      assert.include(artifact, unit);
    }),
  ),
);

it.live("spawns unwrapped when scope governance is inactive", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { handle } = yield* startWorker("cat /proc/self/cgroup; echo RALPH_DONE", {
        workerScope: { scopeId: "testdispatch", active: false },
      });
      yield* handle.awaitSettled;
      const artifact = NodeFS.readFileSync(handle.ref, "utf8");
      assert.notInclude(artifact, "cook-epic-testdispatch");
    }),
  ),
);
