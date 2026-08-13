// @effect-diagnostics nodeBuiltinImport:off
/**
 * Cross-surface regression coverage for the Prime provider, driven through the
 * real pipeline rather than a mocked adapter registry.
 *
 * Every test here builds `ProviderInstanceRegistryLive` over the real
 * `PrimeDriver`, wraps it in the real `ProviderAdapterRegistryLive`, and hands
 * that to the real `ProviderService` with a real SQLite-backed session
 * directory. The only fake is the binary: `scripts/prime-rpc-mock.ts` behind a
 * shell wrapper. No credentials, no network, no user daemon.
 *
 * The unit suites next door (`PrimeAdapter.test.ts`, `PrimeEventMapper.test.ts`)
 * pin adapter and mapper behaviour in isolation. This suite pins the seams
 * between them: canonical event projection out of `ProviderService.streamEvents`,
 * instance isolation, resume-cursor persistence across a stop, and per-turn
 * model/option selection reaching the process.
 *
 * @module provider/prime/PrimeEndToEnd.test
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTimersPromises from "node:timers/promises";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ApprovalRequestId,
  PRIME_AGENT_DRIVER_KIND,
  ProviderInstanceId,
  ThreadId,
  type ProviderInstanceConfig,
  type ProviderInstanceConfigMap,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import { EnvironmentAuth } from "../../auth/EnvironmentAuth.ts";
import { makeUnconfiguredEnvironmentAuth } from "../../auth/environmentAuthTestStub.ts";
import { ServerConfig } from "../../config.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as ProviderSessionRuntime from "../../persistence/ProviderSessionRuntime.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import * as AnalyticsService from "../../telemetry/AnalyticsService.ts";
import { PrimeDriver } from "../Drivers/PrimeDriver.ts";
import type { PrimeResumeCursor } from "../Layers/PrimeAdapter.ts";
import { ProviderAdapterRegistryLive } from "../Layers/ProviderAdapterRegistry.ts";
import { NoOpProviderEventLoggers, ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { ProviderInstanceRegistryLayer } from "../Layers/ProviderInstanceRegistryLive.ts";
import { makeProviderServiceLive } from "../Layers/ProviderService.ts";
import { ProviderSessionDirectoryLive } from "../Layers/ProviderSessionDirectory.ts";
import * as ProviderAdapterRegistry from "../Services/ProviderAdapterRegistry.ts";
import { NoOpProviderInstanceTeardownLive } from "../Services/ProviderInstanceTeardown.ts";
import * as ProviderService from "../Services/ProviderService.ts";
import * as ProviderSessionDirectory from "../Services/ProviderSessionDirectory.ts";
import { EpicWorkerScopeRegistry } from "../workerScope.ts";

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/prime-rpc-mock.ts");

const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/**
 * One executable wrapper for the whole file. Both configured instances point at
 * it, which is what makes the isolation assertions meaningful: same binary,
 * different instance identity.
 */
const fakePrimeRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "prime-e2e-cli-"));
const fakePrimeBinary = NodePath.join(fakePrimeRoot, "prime-agent");
NodeFS.writeFileSync(
  fakePrimeBinary,
  `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(mockAgentPath)} "$@"\n`,
  "utf8",
);
NodeFS.chmodSync(fakePrimeBinary, 0o755);

/** A real directory, because ProviderService checks the session cwd exists. */
const workspaceRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "prime-e2e-cwd-"));

const primaryId = ProviderInstanceId.make("primeAgent");
const secondaryId = ProviderInstanceId.make("primeAgent_second");

const primeInstance = (displayName: string): ProviderInstanceConfig => ({
  driver: PRIME_AGENT_DRIVER_KIND,
  displayName,
  enabled: true,
  // The fake CLI branches on this variable. The `adapter` scenario is the one
  // that speaks a full turn back over RPC.
  environment: [{ name: "T3_PRIME_RPC_SCENARIO", value: "adapter", sensitive: false }],
  config: { enabled: true, binaryPath: fakePrimeBinary, launchArgs: [] },
});

const configMap: ProviderInstanceConfigMap = {
  [primaryId]: primeInstance("Prime (primary)"),
  [secondaryId]: primeInstance("Prime (secondary)"),
};

// The Prime probe never reaches HTTP, but the registry's driver env is a union
// across every built-in driver, so the tag still has to resolve.
const testHttpClientLayer = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ version: "0.0.0" }))),
  ),
);

const driverEnvLayer = ServerConfig.layerTest(workspaceRoot, {
  prefix: "prime-end-to-end-test-",
}).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(ServerSettingsService.layerTest()),
  Layer.provideMerge(testHttpClientLayer),
  Layer.provideMerge(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
  Layer.provideMerge(NoOpProviderInstanceTeardownLive),
);

const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
  Layer.provide(SqlitePersistenceMemory),
);
const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));
const adapterRegistryLayer = ProviderAdapterRegistryLive.pipe(
  Layer.provide(ProviderInstanceRegistryLayer({ drivers: [PrimeDriver], configMap })),
);

const providerLayer = makeProviderServiceLive().pipe(
  Layer.provide(Layer.succeed(EnvironmentAuth, makeUnconfiguredEnvironmentAuth())),
  Layer.provide(AnalyticsService.layerTest),
  Layer.provide(EpicWorkerScopeRegistry.layer),
  Layer.provideMerge(adapterRegistryLayer),
  Layer.provideMerge(directoryLayer),
  Layer.provideMerge(driverEnvLayer),
);

/**
 * Poll instead of racing a deferred: the fake CLI answers on its own timers,
 * and every assertion below cares about a settled end state rather than the
 * exact instant an event landed.
 */
const waitFor = <E, R>(what: string, condition: () => Effect.Effect<boolean, E, R>) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 250; attempt += 1) {
      if (yield* condition()) return;
      // A real timer, not `Effect.sleep`: `it.effect` runs on the TestClock, and
      // the fake CLI answers on wall-clock timers no test can advance.
      yield* Effect.promise(() => NodeTimersPromises.setTimeout(20));
    }
    return yield* Effect.die(new Error(`Timed out waiting for ${what}.`));
  });

/** `getBinding` answers with an Option; every assertion below wants the row. */
const binding = Effect.fn("PrimeEndToEnd.binding")(function* (threadId: ThreadId) {
  const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
  return Option.getOrUndefined(yield* directory.getBinding(threadId));
});

const startPrimeThread = Effect.fn("PrimeEndToEnd.startPrimeThread")(function* (input: {
  readonly threadId: ThreadId;
  readonly instanceId: ProviderInstanceId;
}) {
  const provider = yield* ProviderService.ProviderService;
  return yield* provider.startSession(input.threadId, {
    threadId: input.threadId,
    providerInstanceId: input.instanceId,
    cwd: workspaceRoot,
    runtimeMode: "approval-required",
  });
});

const isCommand = (
  value: unknown,
  type: string,
): value is Record<string, unknown> & { readonly type: string } =>
  typeof value === "object" && value !== null && "type" in value && value.type === type;

/**
 * Every RPC command the fake CLI recorded for this thread. The mock echoes its
 * inbox back through `get_messages`, which the adapter surfaces as thread
 * items — so this reads what the *process* saw, not what the session record
 * claims.
 */
const commandsSeenByPrime = Effect.fn("PrimeEndToEnd.commandsSeenByPrime")(function* (input: {
  readonly threadId: ThreadId;
  readonly instanceId: ProviderInstanceId;
}) {
  const registry = yield* ProviderAdapterRegistry.ProviderAdapterRegistry;
  const adapter = yield* registry.getByInstance(input.instanceId);
  const snapshot = yield* adapter.readThread(input.threadId);
  return snapshot.turns.at(-1)?.items ?? [];
});

it.layer(providerLayer, { timeout: 60_000 })("Prime provider end to end", (it) => {
  it.effect("projects one Prime turn into canonical runtime events", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const threadId = ThreadId.make("prime-e2e-projection");
      const events: Array<ProviderRuntimeEvent> = [];
      const fiber = yield* Stream.runForEach(provider.streamEvents, (event) =>
        Effect.sync(() => {
          events.push(event);
        }),
      ).pipe(Effect.forkChild);

      yield* startPrimeThread({ threadId, instanceId: primaryId });
      yield* provider.sendTurn({ threadId, input: "full-turn", attachments: [] });

      yield* waitFor("the Prime turn to complete", () =>
        Effect.sync(() =>
          events.some((event) => event.threadId === threadId && event.type === "turn.completed"),
        ),
      );
      yield* Fiber.interrupt(fiber);

      const mine = events.filter((event) => event.threadId === threadId);
      const streamKinds = new Set(
        mine.flatMap((event) =>
          event.type === "content.delta" ? [String(event.payload.streamKind)] : [],
        ),
      );
      const itemTypes = new Set(
        mine.flatMap((event) =>
          event.type === "item.started" || event.type === "item.completed"
            ? [String(event.payload.itemType)]
            : [],
        ),
      );

      assert.isTrue(
        mine.some((event) => event.type === "turn.started"),
        "expected a turn start",
      );
      assert.isTrue(streamKinds.has("assistant_text"), "expected assistant text deltas");
      assert.isTrue(streamKinds.has("reasoning_text"), "expected reasoning deltas");
      assert.isTrue(itemTypes.has("assistant_message"), "expected an assistant message item");
      assert.isTrue(
        mine.some((event) => event.type === "task.started"),
        "expected a subagent task start",
      );
      assert.isTrue(
        mine.some((event) => event.type === "task.completed"),
        "expected a subagent task completion",
      );
      // The tool call projects as its own item, distinct from the message item.
      assert.isAbove(
        itemTypes.size,
        1,
        `expected a tool item alongside the message item, saw ${[...itemTypes].join(", ")}`,
      );
      // Every event routes back to the instance that produced it.
      assert.deepStrictEqual(
        [...new Set(mine.map((event) => event.providerInstanceId))],
        [primaryId],
      );
    }),
  );

  it.effect("opens and resolves a Prime permission request through the service", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const threadId = ThreadId.make("prime-e2e-permission");
      const events: Array<ProviderRuntimeEvent> = [];
      const fiber = yield* Stream.runForEach(provider.streamEvents, (event) =>
        Effect.sync(() => {
          events.push(event);
        }),
      ).pipe(Effect.forkChild);

      yield* startPrimeThread({ threadId, instanceId: primaryId });
      yield* provider.sendTurn({ threadId, input: "permission", attachments: [] });

      yield* waitFor("the Prime permission request to open", () =>
        Effect.sync(() =>
          events.some((event) => event.threadId === threadId && event.type === "request.opened"),
        ),
      );
      const opened = events.find(
        (event) => event.threadId === threadId && event.type === "request.opened",
      );
      assert.isDefined(opened?.requestId);

      yield* provider.respondToRequest({
        threadId,
        requestId: ApprovalRequestId.make(opened!.requestId!),
        decision: "accept",
      });

      yield* waitFor("the Prime permission request to resolve", () =>
        Effect.sync(() =>
          events.some((event) => event.threadId === threadId && event.type === "request.resolved"),
        ),
      );
      yield* Fiber.interrupt(fiber);

      const items = yield* commandsSeenByPrime({ threadId, instanceId: primaryId });
      assert.isTrue(
        items.some((item) => isCommand(item, "extension_ui_response")),
        "the decision must reach the Prime process",
      );
    }),
  );

  it.effect("keeps two Prime instances on separate sessions and cursors", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const primaryThread = ThreadId.make("prime-e2e-isolation-primary");
      const secondaryThread = ThreadId.make("prime-e2e-isolation-secondary");

      yield* startPrimeThread({ threadId: primaryThread, instanceId: primaryId });
      yield* startPrimeThread({ threadId: secondaryThread, instanceId: secondaryId });
      yield* provider.sendTurn({ threadId: primaryThread, input: "hello", attachments: [] });
      yield* provider.sendTurn({ threadId: secondaryThread, input: "hello", attachments: [] });

      yield* waitFor("both Prime bindings to carry a resume cursor", () =>
        Effect.gen(function* () {
          const first = yield* binding(primaryThread);
          const second = yield* binding(secondaryThread);
          return first?.resumeCursor != null && second?.resumeCursor != null;
        }),
      );

      const primaryBinding = yield* binding(primaryThread);
      const secondaryBinding = yield* binding(secondaryThread);

      assert.equal(primaryBinding?.providerInstanceId, primaryId);
      assert.equal(secondaryBinding?.providerInstanceId, secondaryId);
      assert.equal(primaryBinding?.provider, PRIME_AGENT_DRIVER_KIND);
      assert.equal(secondaryBinding?.provider, PRIME_AGENT_DRIVER_KIND);

      const primaryCursor = primaryBinding?.resumeCursor as PrimeResumeCursor;
      const secondaryCursor = secondaryBinding?.resumeCursor as PrimeResumeCursor;
      assert.equal(primaryCursor.schemaVersion, 1);
      assert.equal(primaryCursor.ownerThreadId, primaryThread);
      assert.equal(secondaryCursor.ownerThreadId, secondaryThread);
      assert.notEqual(
        primaryCursor.sessionId,
        secondaryCursor.sessionId,
        "two instances must not share one Prime session",
      );

      // Each adapter only knows its own thread.
      const primaryRegistry = yield* ProviderAdapterRegistry.ProviderAdapterRegistry;
      const primaryAdapter = yield* primaryRegistry.getByInstance(primaryId);
      const secondaryAdapter = yield* primaryRegistry.getByInstance(secondaryId);
      assert.notStrictEqual(primaryAdapter, secondaryAdapter);
      assert.isTrue(yield* primaryAdapter.hasSession(primaryThread));
      assert.isFalse(yield* primaryAdapter.hasSession(secondaryThread));
      assert.isTrue(yield* secondaryAdapter.hasSession(secondaryThread));
      assert.isFalse(yield* secondaryAdapter.hasSession(primaryThread));
    }),
  );

  it.effect("resumes an owned Prime session from the persisted cursor after a stop", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const threadId = ThreadId.make("prime-e2e-resume");

      yield* startPrimeThread({ threadId, instanceId: primaryId });
      yield* provider.sendTurn({ threadId, input: "hello", attachments: [] });
      yield* waitFor("the first Prime session to persist a cursor", () =>
        binding(threadId).pipe(Effect.map((row) => row?.resumeCursor != null)),
      );
      const before = (yield* binding(threadId))?.resumeCursor as PrimeResumeCursor;

      yield* provider.stopSession({ threadId });
      assert.isFalse(
        yield* provider.hasLiveSession(threadId),
        "the stop must really end the session, or the resume below proves nothing",
      );
      // A stop keeps the cursor, which is what leaves the thread resumable.
      const afterStop = yield* binding(threadId);
      assert.deepStrictEqual(afterStop?.resumeCursor, before);

      const verdict = yield* provider.describeSessionResume(threadId);
      assert.equal(verdict.resumable, "cursor");
      assert.equal(verdict.reason, "persisted-cursor");
      assert.equal(verdict.providerInstanceId, primaryId);

      yield* provider.sendTurn({ threadId, input: "hello", attachments: [] });
      yield* waitFor("the Prime session to come back", () => provider.hasLiveSession(threadId));
      const after = (yield* binding(threadId))?.resumeCursor as PrimeResumeCursor;
      assert.equal(
        after.sessionId,
        before.sessionId,
        "a resume must reuse the owning session, not fork a new one",
      );
      assert.equal(after.ownerThreadId, threadId);
    }),
  );

  it.effect("carries the selected model and options into the Prime process", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const threadId = ThreadId.make("prime-e2e-selection");

      yield* startPrimeThread({ threadId, instanceId: primaryId });
      yield* provider.sendTurn({
        threadId,
        input: "hello",
        attachments: [],
        modelSelection: {
          instanceId: primaryId,
          model: "prime/switched",
          options: [{ id: "thinking", value: "xhigh" }],
        },
      });

      yield* waitFor("the Prime session to report the switched model", () =>
        provider
          .listSessions()
          .pipe(
            Effect.map((sessions) =>
              sessions.some(
                (session) => session.threadId === threadId && session.model === "prime/switched",
              ),
            ),
          ),
      );

      const items = yield* commandsSeenByPrime({ threadId, instanceId: primaryId });
      assert.isTrue(
        items.some(
          (item) =>
            isCommand(item, "set_model") &&
            item.provider === "prime" &&
            item.modelId === "switched",
        ),
        "the model switch must reach the Prime process",
      );
      assert.isTrue(
        items.some((item) => isCommand(item, "set_thinking_level") && item.level === "xhigh"),
        "the thinking option must reach the Prime process",
      );
    }),
  );
});
