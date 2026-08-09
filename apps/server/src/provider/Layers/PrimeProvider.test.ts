// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { PrimeSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Duration from "effect/Duration";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { PrimeRpcProtocolError, PrimeRpcRequestError } from "../prime/PrimeRpcTransport.ts";
import { checkPrimeProviderStatus } from "./PrimeProvider.ts";

const mockPath = NodePath.join(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../../../scripts/prime-rpc-mock.ts",
);
const decodeSettings = Schema.decodeSync(PrimeSettings);
const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

const makeWrapper = Effect.acquireRelease(
  Effect.promise(async () => {
    const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "prime-provider-test-"));
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

it.layer(NodeServices.layer)("PrimeProvider", (it) => {
  it.effect("maps typed models, capabilities, defaults, and duplicates", () =>
    Effect.gen(function* () {
      const wrapper = yield* makeWrapper;
      const snapshot = yield* checkPrimeProviderStatus(
        decodeSettings({ binaryPath: wrapper.path }),
        {
          ...process.env,
          T3_PRIME_RPC_SCENARIO: "health-ready",
        },
      );
      assert.strictEqual(snapshot.status, "ready");
      assert.strictEqual(snapshot.version, "1.2.3");
      assert.deepStrictEqual(
        snapshot.models.map((model) => model.slug),
        ["other/basic", "prime/prime-model"],
      );
      const model = snapshot.models.find((candidate) => candidate.slug === "prime/prime-model");
      const custom = snapshot.models.find((candidate) => candidate.slug === "other/basic");
      assert.strictEqual(model?.isDefault, true);
      assert.strictEqual(model?.name, "Prime Model");
      assert.strictEqual(custom?.isCustom, true);
      assert.strictEqual(model?.capabilities?.supportsImages, true);
      assert.deepStrictEqual(model?.capabilities?.optionDescriptors?.[0], {
        id: "thinking",
        label: "Thinking",
        type: "select",
        options: [
          { id: "high", label: "High" },
          { id: "low", label: "Low" },
        ],
      });
    }),
  );

  it.effect("covers disabled, missing, version, RPC, and secret-safe failures", () =>
    Effect.gen(function* () {
      const disabled = yield* checkPrimeProviderStatus(decodeSettings({ enabled: false }));
      assert.strictEqual(disabled.status, "disabled");

      const missing = yield* checkPrimeProviderStatus(
        decodeSettings({ binaryPath: NodePath.join(NodeOS.tmpdir(), "missing-prime-agent") }),
      );
      assert.strictEqual(missing.installed, false);

      const successfulVersion = Effect.succeed({ stdout: "1.2.3", stderr: "", code: 0 });
      const timeoutFiber = yield* checkPrimeProviderStatus(decodeSettings({}), process.env, {
        versionTimeoutMs: 10,
        versionProbe: Effect.never,
      }).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.seconds(1));
      const timeoutSnapshot = yield* Fiber.join(timeoutFiber);
      assert.strictEqual(timeoutSnapshot.status, "error");
      const rpcTimeoutFiber = yield* checkPrimeProviderStatus(decodeSettings({}), process.env, {
        versionProbe: successfulVersion,
        rpcTimeoutMs: 10,
        makeTransport: () => Effect.never,
      }).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.seconds(1));
      const rpcTimeoutSnapshot = yield* Fiber.join(rpcTimeoutFiber);
      assert.strictEqual(rpcTimeoutSnapshot.status, "error");
      const cases = [
        checkPrimeProviderStatus(decodeSettings({}), process.env, {
          versionProbe: Effect.succeed({ stdout: "", stderr: "failed", code: 7 }),
        }),
        checkPrimeProviderStatus(decodeSettings({}), process.env, {
          versionProbe: successfulVersion,
          makeTransport: () =>
            Effect.fail(new PrimeRpcProtocolError({ detail: "malformed super-secret-value" })),
        }),
        checkPrimeProviderStatus(decodeSettings({}), process.env, {
          versionProbe: successfulVersion,
          makeTransport: () =>
            Effect.fail(
              new PrimeRpcRequestError({
                command: "get_state",
                detail: "token=super-secret-value",
              }),
            ),
        }),
      ];
      for (const probe of cases) {
        const snapshot = yield* probe;
        assert.strictEqual(snapshot.status, "error");
        assert.strictEqual(snapshot.message?.includes("super-secret-value"), false);
      }
    }),
  );

  it.effect("closes the scoped RPC transport after a health check", () =>
    Effect.gen(function* () {
      const wrapper = yield* makeWrapper;
      const cleaned = yield* Ref.make(false);
      const snapshot = yield* checkPrimeProviderStatus(
        decodeSettings({ binaryPath: wrapper.path }),
        process.env,
        {
          makeTransport: () =>
            Effect.acquireRelease(
              Effect.succeed({
                getState: () =>
                  Effect.succeed({
                    model: { provider: "prime", id: "prime-model" },
                    thinkingLevel: "medium",
                    isStreaming: false,
                    isCompacting: false,
                    sessionFile: null,
                    sessionId: "health",
                    messageCount: 0,
                    pendingMessageCount: 0,
                  }),
                getAvailableModels: () =>
                  Effect.succeed([{ provider: "prime", id: "prime-model", name: "Prime" }]),
                setModel: () => Effect.die("unused"),
                setThinkingLevel: () => Effect.die("unused"),
                prompt: () => Effect.die("unused"),
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
              () => Ref.set(cleaned, true),
            ),
        },
      );
      assert.strictEqual(snapshot.status, "ready");
      assert.strictEqual(yield* Ref.get(cleaned), true);
    }),
  );

  it.effect("reports unauthenticated and empty-model warnings", () =>
    Effect.gen(function* () {
      const wrapper = yield* makeWrapper;
      const unauthenticated = yield* checkPrimeProviderStatus(
        decodeSettings({ binaryPath: wrapper.path }),
        { ...process.env, T3_PRIME_RPC_SCENARIO: "health-unauthenticated" },
      );
      assert.strictEqual(unauthenticated.status, "warning");
      assert.strictEqual(unauthenticated.auth.status, "unauthenticated");
      const empty = yield* checkPrimeProviderStatus(decodeSettings({ binaryPath: wrapper.path }), {
        ...process.env,
        T3_PRIME_RPC_SCENARIO: "health-no-models",
      });
      assert.strictEqual(empty.status, "warning");
      assert.strictEqual(empty.models.length, 0);
    }),
  );
});
