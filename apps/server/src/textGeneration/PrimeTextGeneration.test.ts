// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { PrimeSettings, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as Duration from "effect/Duration";

import { makePrimeTextGeneration } from "./PrimeTextGeneration.ts";

const mockPath = NodePath.join(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../../scripts/prime-rpc-mock.ts",
);
const decodeSettings = Schema.decodeSync(PrimeSettings);
const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
const selection = {
  instanceId: ProviderInstanceId.make("prime-one"),
  model: "prime/prime-model",
  options: [{ id: "thinking", value: "high" }],
} as const;

const makeWrapper = Effect.acquireRelease(
  Effect.promise(async () => {
    const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "prime-text-test-"));
    const path = NodePath.join(dir, "prime-agent");
    await NodeFSP.writeFile(
      path,
      `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(mockPath)} "$@"\n`,
      "utf8",
    );
    await NodeFSP.chmod(path, 0o755);
    return { dir, path };
  }),
  ({ dir }) => Effect.promise(() => NodeFSP.rm(dir, { recursive: true, force: true })),
);

it.layer(NodeServices.layer)("PrimeTextGeneration", (it) => {
  it.effect("generates and sanitizes all four operations after agent settlement", () =>
    Effect.gen(function* () {
      const wrapper = yield* makeWrapper;
      const service = yield* makePrimeTextGeneration(decodeSettings({ binaryPath: wrapper.path }), {
        ...process.env,
        T3_PRIME_RPC_SCENARIO: "text-ready",
      });
      const commit = yield* service.generateCommitMessage({
        cwd: process.cwd(),
        branch: "main",
        stagedSummary: "file.ts",
        stagedPatch: "+prime",
        includeBranch: true,
        modelSelection: selection,
      });
      assert.strictEqual(commit.subject, "Add Prime support");
      assert.strictEqual(commit.branch, "feature/prime-support");
      const pr = yield* service.generatePrContent({
        cwd: process.cwd(),
        baseBranch: "main",
        headBranch: "prime",
        commitSummary: "Prime",
        diffSummary: "1 file",
        diffPatch: "+prime",
        modelSelection: selection,
      });
      assert.strictEqual(pr.title, "Add Prime support");
      const branch = yield* service.generateBranchName({
        cwd: process.cwd(),
        message: "Add Prime",
        modelSelection: selection,
      });
      assert.strictEqual(branch.branch, "prime-support");
      const title = yield* service.generateThreadTitle({
        cwd: process.cwd(),
        message: "Add Prime",
        modelSelection: selection,
      });
      assert.strictEqual(title.title, "Prime Support!");
    }),
  );

  it.effect("fails on malformed and empty output", () =>
    Effect.gen(function* () {
      const wrapper = yield* makeWrapper;
      for (const scenario of ["text-malformed", "text-empty"] as const) {
        const service = yield* makePrimeTextGeneration(
          decodeSettings({ binaryPath: wrapper.path }),
          { ...process.env, T3_PRIME_RPC_SCENARIO: scenario },
        );
        const result = yield* Effect.result(
          service.generateThreadTitle({
            cwd: process.cwd(),
            message: "Add Prime",
            modelSelection: selection,
          }),
        );
        assert.strictEqual(result._tag, "Failure");
      }
    }),
  );

  it.effect("applies the qualified model and selected thinking level, then cleans up", () =>
    Effect.gen(function* () {
      const commands = Array<unknown>();
      const cleaned = yield* Ref.make(false);
      const service = yield* makePrimeTextGeneration(decodeSettings({}), process.env, {
        makeTransport: () =>
          Effect.acquireRelease(
            Effect.succeed({
              getState: () => Effect.die("unused"),
              getAvailableModels: () => Effect.die("unused"),
              setModel: (input) =>
                Effect.sync(() => {
                  commands.push({ type: "set_model", ...input });
                  return { provider: input.provider, id: input.modelId };
                }),
              setThinkingLevel: (level) =>
                Effect.sync(() => {
                  commands.push({ type: "set_thinking_level", level });
                }),
              prompt: () => Effect.void,
              steer: () => Effect.die("unused"),
              followUp: () => Effect.die("unused"),
              abort: Effect.die("unused"),
              getMessages: () => Effect.die("unused"),
              getForkMessages: () => Effect.die("unused"),
              fork: () => Effect.die("unused"),
              respondToExtensionUi: () => Effect.die("unused"),
              events: Stream.fromIterable([
                {
                  type: "message_update",
                  assistantMessageEvent: { type: "text_delta", delta: '{"title":"Prime"}' },
                },
                { type: "agent_settled" },
              ]),
              diagnostics: Effect.succeed({ stderr: "", stderrBytes: 0, stderrTruncated: false }),
              close: Effect.void,
            }),
            () => Ref.set(cleaned, true),
          ),
      });
      const result = yield* service.generateThreadTitle({
        cwd: process.cwd(),
        message: "Prime",
        modelSelection: selection,
      });
      assert.strictEqual(result.title, "Prime");
      assert.deepStrictEqual(commands, [
        { type: "set_model", provider: "prime", modelId: "prime-model" },
        { type: "set_thinking_level", level: "high" },
      ]);
      assert.strictEqual(yield* Ref.get(cleaned), true);
    }),
  );

  it.effect("fails promptly on error, timeout, and event-stream end", () =>
    Effect.gen(function* () {
      const wrapper = yield* makeWrapper;
      for (const scenario of ["text-error"] as const) {
        const service = yield* makePrimeTextGeneration(
          decodeSettings({ binaryPath: wrapper.path }),
          { ...process.env, T3_PRIME_RPC_SCENARIO: scenario },
          { timeoutMs: 100 },
        );
        const result = yield* Effect.result(
          service.generateThreadTitle({
            cwd: process.cwd(),
            message: "Prime",
            modelSelection: selection,
          }),
        );
        assert.strictEqual(result._tag, "Failure", scenario);
      }
    }),
  );

  it.effect("fails when the event stream ends without settlement", () =>
    Effect.gen(function* () {
      const service = yield* makePrimeTextGeneration(decodeSettings({}), process.env, {
        makeTransport: () =>
          Effect.succeed({
            getState: () => Effect.die("unused"),
            getAvailableModels: () => Effect.die("unused"),
            setModel: ({ provider, modelId }) => Effect.succeed({ provider, id: modelId }),
            setThinkingLevel: () => Effect.void,
            prompt: () => Effect.void,
            steer: () => Effect.die("unused"),
            followUp: () => Effect.die("unused"),
            abort: Effect.die("unused"),
            getMessages: () => Effect.die("unused"),
            getForkMessages: () => Effect.die("unused"),
            fork: () => Effect.die("unused"),
            respondToExtensionUi: () => Effect.die("unused"),
            events: Stream.empty,
            diagnostics: Effect.succeed({ stderr: "", stderrBytes: 0, stderrTruncated: false }),
            close: Effect.void,
          }),
      });
      const result = yield* Effect.result(
        service.generateThreadTitle({
          cwd: process.cwd(),
          message: "Prime",
          modelSelection: selection,
        }),
      );
      assert.strictEqual(result._tag, "Failure");
    }),
  );

  it.effect("times out a generation and closes its transport", () =>
    Effect.gen(function* () {
      const cleaned = yield* Ref.make(false);
      const pending = yield* Deferred.make<never>();
      const service = yield* makePrimeTextGeneration(decodeSettings({}), process.env, {
        timeoutMs: 20,
        makeTransport: () =>
          Effect.acquireRelease(
            Effect.succeed({
              getState: () => Effect.die("unused"),
              getAvailableModels: () => Effect.die("unused"),
              setModel: ({ provider, modelId }) => Effect.succeed({ provider, id: modelId }),
              setThinkingLevel: () => Effect.void,
              prompt: () => Effect.void,
              steer: () => Effect.die("unused"),
              followUp: () => Effect.die("unused"),
              abort: Effect.die("unused"),
              getMessages: () => Effect.die("unused"),
              getForkMessages: () => Effect.die("unused"),
              fork: () => Effect.die("unused"),
              respondToExtensionUi: () => Effect.die("unused"),
              events: Stream.fromEffect(Deferred.await(pending)),
              diagnostics: Effect.succeed({ stderr: "", stderrBytes: 0, stderrTruncated: false }),
              close: Effect.void,
            }),
            () => Ref.set(cleaned, true),
          ),
      });
      const fiber = yield* service
        .generateThreadTitle({
          cwd: process.cwd(),
          message: "Prime",
          modelSelection: selection,
        })
        .pipe(Effect.result, Effect.forkChild);
      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.seconds(1));
      const result = yield* Fiber.join(fiber);
      assert.strictEqual(result._tag, "Failure");
      assert.strictEqual(yield* Ref.get(cleaned), true);
    }),
  );

  it.effect("rejects unqualified models without starting a transport", () =>
    Effect.gen(function* () {
      let started = false;
      const service = yield* makePrimeTextGeneration(decodeSettings({}), process.env, {
        makeTransport: () => {
          started = true;
          return Effect.die("must not start");
        },
      });
      const result = yield* Effect.result(
        service.generateThreadTitle({
          cwd: process.cwd(),
          message: "Prime",
          modelSelection: { ...selection, model: "prime-model" },
        }),
      );
      assert.strictEqual(result._tag, "Failure");
      assert.strictEqual(started, false);
    }),
  );

  it.effect("closes the scoped transport when generation is interrupted", () =>
    Effect.gen(function* () {
      const cleaned = yield* Ref.make(false);
      const pending = yield* Deferred.make<never>();
      const service = yield* makePrimeTextGeneration(decodeSettings({}), process.env, {
        makeTransport: () =>
          Effect.acquireRelease(
            Effect.succeed({
              getState: () => Effect.die("unused"),
              getAvailableModels: () => Effect.die("unused"),
              setModel: ({ provider, modelId }) => Effect.succeed({ provider, id: modelId }),
              setThinkingLevel: () => Effect.void,
              prompt: () => Effect.void,
              steer: () => Effect.die("unused"),
              followUp: () => Effect.die("unused"),
              abort: Effect.die("unused"),
              getMessages: () => Effect.die("unused"),
              getForkMessages: () => Effect.die("unused"),
              fork: () => Effect.die("unused"),
              respondToExtensionUi: () => Effect.die("unused"),
              events: Stream.fromEffect(Deferred.await(pending)),
              diagnostics: Effect.succeed({ stderr: "", stderrBytes: 0, stderrTruncated: false }),
              close: Effect.void,
            }),
            () => Ref.set(cleaned, true),
          ),
      });
      const fiber = yield* service
        .generateThreadTitle({
          cwd: process.cwd(),
          message: "Prime",
          modelSelection: selection,
        })
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(fiber);
      assert.strictEqual(yield* Ref.get(cleaned), true);
    }),
  );
});
