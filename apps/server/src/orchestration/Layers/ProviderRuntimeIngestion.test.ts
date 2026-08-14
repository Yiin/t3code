// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  UNKNOWN_DRIVER_ATTACHMENT_CAPABILITY,
  decodeSubagentTranscriptActivityPayload,
  OrchestrationReadModel,
  ProviderDriverKind,
  ProviderRuntimeEvent,
  ProviderSession,
  ProviderInstanceId,
  type ModelSelection,
  type ProviderAccountLimit,
  type ProviderUsageSample,
  type ServerProvider,
} from "@t3tools/contracts";
import {
  ApprovalRequestId,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  epicRunIterationThreadId,
  EventId,
  MessageId,
  ProjectId,
  ProviderItemId,
  type ServerSettings,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "@effect/vitest";

import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../../provider/Services/ProviderService.ts";
import {
  ProviderRegistry,
  type ProviderRegistryShape,
} from "../../provider/Services/ProviderRegistry.ts";
import {
  ProviderAccountLimitsStore,
  type ProviderAccountLimitsStoreShape,
} from "../../persistence/Services/ProviderAccountLimits.ts";
import {
  ProviderUsageLedgerStore,
  type ProviderUsageLedgerStoreShape,
} from "../../persistence/Services/ProviderUsageLedger.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import { ProviderRuntimeIngestionLive } from "./ProviderRuntimeIngestion.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProviderRuntimeIngestionService } from "../Services/ProviderRuntimeIngestion.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";

/**
 * Dispatch a command through the engine. Collapses the
 * `engine.dispatch(...)` call repeated throughout this file into one place.
 */
const dispatch = <C, A, E>(
  engine: { readonly dispatch: (command: C) => Effect.Effect<A, E> },
  command: C,
): Effect.Effect<A, E> => engine.dispatch(command);

function makeTestServerSettingsLayer(overrides: Partial<ServerSettings> = {}) {
  return ServerSettingsService.layerTest(overrides);
}

const asProjectId = (value: string): ProjectId => ProjectId.make(value);
const asItemId = (value: string): ProviderItemId => ProviderItemId.make(value);
const asEventId = (value: string): EventId => EventId.make(value);
const asMessageId = (value: string): MessageId => MessageId.make(value);
const asThreadId = (value: string): ThreadId => ThreadId.make(value);
const asTurnId = (value: string): TurnId => TurnId.make(value);

const testProvider = (input: {
  readonly instanceId: string;
  readonly driver: string;
  readonly model: string;
  readonly displayName?: string;
}): ServerProvider => ({
  instanceId: ProviderInstanceId.make(input.instanceId),
  driver: ProviderDriverKind.make(input.driver),
  ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-01-01T00:00:00.000Z",
  availability: "available",
  models: [{ slug: input.model, name: input.model, isCustom: false, capabilities: null }],
  slashCommands: [],
  skills: [],
});

type LegacyProviderRuntimeEvent = {
  readonly type: string;
  readonly eventId: EventId;
  readonly provider: ProviderRuntimeEvent["provider"];
  readonly createdAt: string;
  readonly threadId: ThreadId;
  readonly turnId?: string | undefined;
  readonly itemId?: string | undefined;
  readonly requestId?: string | undefined;
  readonly payload?: unknown | undefined;
  readonly [key: string]: unknown;
};

type LegacyTurnCompletedEvent = LegacyProviderRuntimeEvent & {
  readonly type: "turn.completed";
  readonly payload?: undefined;
  readonly status: "completed" | "failed" | "interrupted" | "cancelled";
  readonly errorMessage?: string | undefined;
};

function isLegacyTurnCompletedEvent(
  event: LegacyProviderRuntimeEvent,
): event is LegacyTurnCompletedEvent {
  return (
    event.type === "turn.completed" &&
    event.payload === undefined &&
    typeof event.status === "string"
  );
}

function createProviderServiceHarness(options: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly continuationKeys?: Readonly<Record<string, string>>;
  readonly stopSessionFails?: boolean;
}) {
  return Effect.gen(function* () {
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();
    const runtimeSessions: ProviderSession[] = [];
    const stoppedThreadIds: ThreadId[] = [];

    const unsupported = () => Effect.die(new Error("Unsupported provider call in test")) as never;
    const service: ProviderServiceShape = {
      startSession: () => unsupported(),
      sendTurn: () => unsupported(),
      interruptTurn: () => unsupported(),
      respondToRequest: () => unsupported(),
      respondToUserInput: () => unsupported(),
      stopSession: ({ threadId }) => {
        if (options.stopSessionFails === true) {
          return Effect.die(new Error("provider refused to stop"));
        }
        return Effect.sync(() => {
          stoppedThreadIds.push(threadId);
          const index = runtimeSessions.findIndex((session) => session.threadId === threadId);
          if (index >= 0) runtimeSessions.splice(index, 1);
        });
      },
      listSessions: () => Effect.succeed([...runtimeSessions]),
      hasLiveSession: (threadId) =>
        Effect.succeed(runtimeSessions.some((session) => session.threadId === threadId)),
      describeSessionResume: () => unsupported(),
      getCapabilities: () =>
        Effect.succeed({
          sessionModelSwitch: "in-session",
          sessionLifecycle: { resume: "cursor" },
          attachments: UNKNOWN_DRIVER_ATTACHMENT_CAPABILITY,
        }),
      getInstanceInfo: (instanceId) => {
        const snapshot = options.providers.find((provider) => provider.instanceId === instanceId);
        if (snapshot === undefined) return unsupported();
        const driverKind = snapshot.driver;
        return Effect.succeed({
          instanceId,
          driverKind,
          displayName: snapshot.displayName,
          enabled: snapshot.enabled,
          continuationIdentity: {
            driverKind,
            continuationKey:
              options.continuationKeys?.[String(instanceId)] ?? `${driverKind}:shared-test-home`,
          },
        });
      },
      rollbackConversation: () => unsupported(),
      get streamEvents() {
        return Stream.fromPubSub(runtimeEventPubSub);
      },
    };

    const setSession = (session: ProviderSession): void => {
      const existingIndex = runtimeSessions.findIndex(
        (entry) => entry.threadId === session.threadId,
      );
      if (existingIndex >= 0) {
        runtimeSessions[existingIndex] = session;
        return;
      }
      runtimeSessions.push(session);
    };

    const normalizeLegacyEvent = (event: LegacyProviderRuntimeEvent): ProviderRuntimeEvent => {
      if (isLegacyTurnCompletedEvent(event)) {
        const normalized: Extract<ProviderRuntimeEvent, { type: "turn.completed" }> = {
          ...(event as Omit<Extract<ProviderRuntimeEvent, { type: "turn.completed" }>, "payload">),
          payload: {
            state: event.status,
            ...(typeof event.errorMessage === "string" ? { errorMessage: event.errorMessage } : {}),
          },
        };
        return normalized;
      }

      return event as ProviderRuntimeEvent;
    };

    // `publishUnsafe` is a genuine synchronous, non-blocking PubSub API (not
    // an Effect runtime), so `emit` stays a plain synchronous function that
    // test bodies can call without `yield*`.
    const emit = (event: LegacyProviderRuntimeEvent): void => {
      PubSub.publishUnsafe(runtimeEventPubSub, normalizeLegacyEvent(event));
    };

    return {
      service,
      emit,
      setSession,
      stoppedThreadIds,
    };
  });
}

type ProviderRuntimeTestReadModel = OrchestrationReadModel;
type ProviderRuntimeTestThread = ProviderRuntimeTestReadModel["threads"][number];
type ProviderRuntimeTestMessage = ProviderRuntimeTestThread["messages"][number];
type ProviderRuntimeTestProposedPlan = ProviderRuntimeTestThread["proposedPlans"][number];
type ProviderRuntimeTestActivity = ProviderRuntimeTestThread["activities"][number];
type ProviderRuntimeTestCheckpoint = ProviderRuntimeTestThread["checkpoints"][number];

function waitForThread<E>(
  readModel: () => Effect.Effect<ProviderRuntimeTestReadModel, E>,
  predicate: (thread: ProviderRuntimeTestThread) => boolean,
  timeoutMs = 2000,
  threadId: ThreadId = asThreadId("thread-1"),
): Effect.Effect<ProviderRuntimeTestThread, E> {
  return Effect.gen(function* () {
    const deadline = (yield* Clock.currentTimeMillis) + timeoutMs;
    const poll = (): Effect.Effect<ProviderRuntimeTestThread, E> =>
      Effect.gen(function* () {
        const snapshot = yield* readModel();
        const thread = snapshot.threads.find((entry) => entry.id === threadId);
        if (thread && predicate(thread)) {
          return thread;
        }
        if ((yield* Clock.currentTimeMillis) >= deadline) {
          return yield* Effect.die(new Error("Timed out waiting for thread state"));
        }
        yield* Effect.yieldNow;
        return yield* poll();
      });
    return yield* poll();
  });
}

describe("ProviderRuntimeIngestion", () => {
  function createHarness(options?: {
    readonly serverSettings?: Partial<ServerSettings>;
    readonly modelSelection?: ModelSelection;
    readonly providers?: ReadonlyArray<ServerProvider>;
    readonly accountLimits?: ReadonlyArray<ProviderAccountLimit>;
    readonly usageSamples?: ReadonlyArray<ProviderUsageSample>;
    readonly continuationKeys?: Readonly<Record<string, string>>;
    readonly stopSessionFails?: boolean;
    readonly threadId?: ThreadId;
  }) {
    return Effect.gen(function* () {
      const workspaceRoot = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3-provider-project-"),
      );
      // Registered first so it closes last (scope finalizers run LIFO),
      // matching the original teardown order: stop ingestion, dispose the
      // layer, then remove the temp workspace.
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          NodeFS.rmSync(workspaceRoot, { recursive: true, force: true });
        }),
      );
      NodeFS.mkdirSync(NodePath.join(workspaceRoot, ".git"));
      const modelSelection = options?.modelSelection ?? {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      };
      const providers = options?.providers ?? [
        testProvider({ instanceId: "codex", driver: "codex", model: "gpt-5-codex" }),
      ];
      const threadId = options?.threadId ?? ThreadId.make("thread-1");
      const provider = yield* createProviderServiceHarness({
        providers,
        ...(options?.continuationKeys === undefined
          ? {}
          : { continuationKeys: options.continuationKeys }),
        ...(options?.stopSessionFails === undefined
          ? {}
          : { stopSessionFails: options.stopSessionFails }),
      });
      const unsupported = () => Effect.die(new Error("Unsupported store call in test")) as never;
      const providerRegistry: ProviderRegistryShape = {
        getProviders: Effect.succeed(providers),
        refresh: () => Effect.succeed(providers),
        refreshInstance: () => Effect.succeed(providers),
        getProviderMaintenanceCapabilitiesForInstance: () => unsupported(),
        setProviderMaintenanceActionState: () => Effect.succeed(providers),
        streamChanges: Stream.empty,
      };
      const accountLimitsStore: ProviderAccountLimitsStoreShape = {
        recordLimit: () => unsupported(),
        listAll: Effect.succeed(options?.accountLimits ?? []),
        listForInstance: () => unsupported(),
        clearForInstance: () => unsupported(),
        clearExpired: () => unsupported(),
      };
      const usageLedgerStore: ProviderUsageLedgerStoreShape = {
        recordSamples: () => unsupported(),
        listAll: Effect.succeed(options?.usageSamples ?? []),
        listForInstance: () => unsupported(),
        pruneObservedBefore: () => unsupported(),
      };
      const orchestrationLayer = OrchestrationEngineLive.pipe(
        Layer.provide(OrchestrationProjectionSnapshotQueryLive),
        Layer.provide(OrchestrationProjectionPipelineLive),
        Layer.provide(OrchestrationEventStoreLive),
        Layer.provide(OrchestrationCommandReceiptRepositoryLive),
        Layer.provide(RepositoryIdentityResolver.layer),
        Layer.provide(SqlitePersistenceMemory),
      );
      const projectionSnapshotLayer = OrchestrationProjectionSnapshotQueryLive.pipe(
        Layer.provide(RepositoryIdentityResolver.layer),
        Layer.provide(SqlitePersistenceMemory),
      );
      const layer = ProviderRuntimeIngestionLive.pipe(
        Layer.provideMerge(orchestrationLayer),
        Layer.provideMerge(projectionSnapshotLayer),
        Layer.provideMerge(SqlitePersistenceMemory),
        Layer.provideMerge(Layer.succeed(ProviderService, provider.service)),
        Layer.provideMerge(Layer.succeed(ProviderRegistry, providerRegistry)),
        Layer.provideMerge(Layer.succeed(ProviderAccountLimitsStore, accountLimitsStore)),
        Layer.provideMerge(Layer.succeed(ProviderUsageLedgerStore, usageLedgerStore)),
        Layer.provideMerge(makeTestServerSettingsLayer(options?.serverSettings)),
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
        Layer.provideMerge(NodeServices.layer),
      );
      const context = yield* Layer.build(layer);
      const engine = Context.get(context, OrchestrationEngineService);
      const snapshotQuery = Context.get(context, ProjectionSnapshotQuery);
      const ingestion = Context.get(context, ProviderRuntimeIngestionService);
      // Registered after the layer above, so on teardown this closes first --
      // the same "stop ingestion before disposing the layer" order the
      // original explicit inner Scope enforced.
      yield* ingestion.start();

      const createdAt = "2026-01-01T00:00:00.000Z";
      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-provider-project-create"),
        projectId: asProjectId("project-1"),
        title: "Provider Project",
        workspaceRoot,
        defaultModelSelection: modelSelection,
        createdAt,
      });
      yield* engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-create"),
        threadId,
        projectId: asProjectId("project-1"),
        title: "Thread",
        modelSelection,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      });
      yield* engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-seed"),
        threadId,
        session: {
          threadId,
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          updatedAt: createdAt,
          lastError: null,
        },
        createdAt,
      });
      provider.setSession({
        provider: ProviderDriverKind.make("codex"),
        status: "ready",
        runtimeMode: "approval-required",
        threadId,
        createdAt,
        updatedAt: createdAt,
      });

      return {
        engine,
        readModel: () => snapshotQuery.getSnapshot(),
        emit: provider.emit,
        setProviderSession: provider.setSession,
        stoppedThreadIds: provider.stoppedThreadIds,
        threadId,
        drain: () => ingestion.drain,
      };
    });
  }

  type Harness = Effect.Success<ReturnType<typeof createHarness>>;

  it.live("maps turn started/completed events into thread session updates", () =>
    Effect.gen(function* () {
      const harness = yield* createHarness();
      const now = "2026-01-01T00:00:00.000Z";

      harness.emit({
        type: "turn.started",
        eventId: asEventId("evt-turn-started"),
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: now,
        turnId: asTurnId("turn-1"),
      });

      yield* waitForThread(
        harness.readModel,
        (thread) =>
          thread.session?.status === "running" && thread.session?.activeTurnId === "turn-1",
      );

      harness.emit({
        type: "turn.completed",
        eventId: asEventId("evt-turn-completed"),
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: "2026-01-01T00:00:00.000Z",
        turnId: asTurnId("turn-1"),
        payload: {
          state: "failed",
          errorMessage: "turn failed",
        },
      });

      const thread = yield* waitForThread(
        harness.readModel,
        (entry) =>
          entry.session?.status === "error" &&
          entry.session?.activeTurnId === null &&
          entry.session?.lastError === "turn failed",
      );
      expect(thread.session?.status).toBe("error");
      expect(thread.session?.lastError).toBe("turn failed");
    }),
  );

  it.live("rotates a failed turn completion and records the visible switch", () =>
    Effect.gen(function* () {
      const current = {
        instanceId: ProviderInstanceId.make("codex-work"),
        model: "gpt-custom",
      };
      const harness = yield* createHarness({
        modelSelection: current,
        providers: [
          testProvider({
            instanceId: "codex-work",
            driver: "codex",
            model: "gpt-custom",
            displayName: "Work",
          }),
          testProvider({
            instanceId: "codex-personal",
            driver: "codex",
            model: "gpt-5.6-sol",
            displayName: "Personal",
          }),
          testProvider({ instanceId: "claude-work", driver: "claudeAgent", model: "opus" }),
        ],
      });
      const turnId = asTurnId("turn-limit-rotation");

      harness.emit({
        type: "turn.completed",
        eventId: asEventId("evt-limit-turn-completed"),
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: current.instanceId,
        threadId: asThreadId("thread-1"),
        turnId,
        createdAt: "2026-01-01T00:00:02.000Z",
        payload: {
          state: "failed",
          errorMessage: "You've hit your usage limit for today.",
        },
      });

      const thread = yield* waitForThread(
        harness.readModel,
        (entry) =>
          entry.modelSelection.instanceId === ProviderInstanceId.make("codex-personal") &&
          entry.activities.some((activity) => activity.kind === "provider.account.rotated"),
      );
      const rotations = thread.activities.filter(
        (activity) => activity.kind === "provider.account.rotated",
      );
      expect(thread.modelSelection).toEqual({
        instanceId: ProviderInstanceId.make("codex-personal"),
        model: "gpt-5.6-sol",
        options: [{ id: "reasoningEffort", value: "high" }],
      });
      expect(rotations).toHaveLength(1);
      expect(rotations[0]?.summary).toBe(
        "Account 'Work' hit its usage limit. This thread now uses account 'Personal'. The model also changed from 'gpt-custom' to 'gpt-5.6-sol'.",
      );
      expect(rotations[0]?.payload).toMatchObject({
        fromInstanceId: "codex-work",
        toInstanceId: "codex-personal",
        reason: "spend-limit",
      });
      expect(harness.stoppedThreadIds).toEqual([asThreadId("thread-1")]);
    }),
  );

  it.live("rotates a runtime error once per turn and permits a later turn", () =>
    Effect.gen(function* () {
      const current = {
        instanceId: ProviderInstanceId.make("codex-work"),
        model: "gpt-5-codex",
      };
      const harness = yield* createHarness({
        modelSelection: current,
        providers: [
          testProvider({ instanceId: "codex-work", driver: "codex", model: "gpt-5-codex" }),
          testProvider({
            instanceId: "codex-personal",
            driver: "codex",
            model: "gpt-5-codex",
          }),
        ],
      });
      const threadId = asThreadId("thread-1");
      const firstTurnId = asTurnId("turn-limit-runtime-error");

      harness.emit({
        type: "runtime.error",
        eventId: asEventId("evt-limit-runtime-error"),
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: current.instanceId,
        threadId,
        turnId: firstTurnId,
        createdAt: "2026-01-01T00:00:01.000Z",
        payload: { message: "You've hit your usage limit for today." },
      });
      harness.emit({
        type: "turn.completed",
        eventId: asEventId("evt-limit-paired-completion"),
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: current.instanceId,
        threadId,
        turnId: firstTurnId,
        createdAt: "2026-01-01T00:00:02.000Z",
        payload: {
          state: "failed",
          errorMessage: "You've hit your usage limit for today.",
        },
      });

      let thread = yield* waitForThread(
        harness.readModel,
        (entry) => entry.modelSelection.instanceId === ProviderInstanceId.make("codex-personal"),
      );
      expect(
        thread.activities.filter((activity) => activity.kind === "provider.account.rotated"),
      ).toHaveLength(1);

      yield* dispatch(harness.engine, {
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-reselect-codex-work"),
        threadId,
        modelSelection: current,
      });
      harness.emit({
        type: "runtime.error",
        eventId: asEventId("evt-limit-runtime-error-later-turn"),
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: current.instanceId,
        threadId,
        turnId: asTurnId("turn-limit-runtime-error-later"),
        createdAt: "2026-01-01T00:01:00.000Z",
        payload: { message: "You've hit your usage limit for today." },
      });

      thread = yield* waitForThread(
        harness.readModel,
        (entry) =>
          entry.activities.filter((activity) => activity.kind === "provider.account.rotated")
            .length === 2,
      );
      expect(thread.modelSelection.instanceId).toBe(ProviderInstanceId.make("codex-personal"));
      expect(harness.stoppedThreadIds).toEqual([threadId, threadId]);
    }),
  );

  it.live("skips an exhausted sibling using the persisted account-limit store", () =>
    Effect.gen(function* () {
      const current = {
        instanceId: ProviderInstanceId.make("codex-work"),
        model: "gpt-5-codex",
      };
      const harness = yield* createHarness({
        modelSelection: current,
        providers: [
          testProvider({ instanceId: "codex-work", driver: "codex", model: "gpt-5-codex" }),
          testProvider({
            instanceId: "codex-exhausted",
            driver: "codex",
            model: "gpt-5-codex",
          }),
          testProvider({
            instanceId: "codex-personal",
            driver: "codex",
            model: "gpt-5-codex",
          }),
        ],
        accountLimits: [
          {
            providerInstanceId: ProviderInstanceId.make("codex-exhausted"),
            driver: ProviderDriverKind.make("codex"),
            kind: "usage-limit",
            detectedAt: "2026-01-01T00:00:00.000Z",
            resetsAt: "2026-01-01T02:00:00.000Z",
            resetsAtEstimated: false,
            source: "codex.app_server.read",
            detail: null,
          },
        ],
      });

      harness.emit({
        type: "turn.completed",
        eventId: asEventId("evt-limit-skip-exhausted-sibling"),
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: current.instanceId,
        threadId: harness.threadId,
        turnId: asTurnId("turn-limit-skip-exhausted-sibling"),
        createdAt: "2026-01-01T00:00:01.000Z",
        payload: {
          state: "failed",
          errorMessage: "Rate limit exceeded. Try again later.",
        },
      });

      const thread = yield* waitForThread(
        harness.readModel,
        (entry) => entry.modelSelection.instanceId === ProviderInstanceId.make("codex-personal"),
      );
      expect(thread.modelSelection.instanceId).toBe(ProviderInstanceId.make("codex-personal"));
    }),
  );

  it.live("keeps the original failure when no same-driver sibling is eligible", () =>
    Effect.gen(function* () {
      const current = {
        instanceId: ProviderInstanceId.make("codex-work"),
        model: "gpt-5-codex",
      };
      const harness = yield* createHarness({
        modelSelection: current,
        providers: [
          testProvider({ instanceId: "codex-work", driver: "codex", model: "gpt-5-codex" }),
          testProvider({ instanceId: "claude-work", driver: "claudeAgent", model: "opus" }),
        ],
      });

      harness.emit({
        type: "turn.completed",
        eventId: asEventId("evt-limit-no-sibling"),
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: current.instanceId,
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-limit-no-sibling"),
        createdAt: "2026-01-01T00:00:01.000Z",
        payload: {
          state: "failed",
          errorMessage: "Rate limit exceeded. Try again later.",
        },
      });

      const thread = yield* waitForThread(
        harness.readModel,
        (entry) => entry.session?.lastError === "Rate limit exceeded. Try again later.",
      );
      expect(thread.modelSelection).toEqual(current);
      expect(
        thread.activities.some((activity) => activity.kind === "provider.account.rotated"),
      ).toBe(false);
      expect(harness.stoppedThreadIds).toEqual([]);
    }),
  );

  it.live("refuses a sibling that cannot continue the provider conversation", () =>
    Effect.gen(function* () {
      const current = {
        instanceId: ProviderInstanceId.make("codex-work"),
        model: "gpt-5-codex",
      };
      const harness = yield* createHarness({
        modelSelection: current,
        providers: [
          testProvider({
            instanceId: "codex-work",
            driver: "codex",
            model: "gpt-5-codex",
            displayName: "Work",
          }),
          testProvider({
            instanceId: "codex-personal",
            driver: "codex",
            model: "gpt-5-codex",
            displayName: "Personal",
          }),
        ],
        continuationKeys: {
          "codex-work": "codex:home:/work",
          "codex-personal": "codex:home:/personal",
        },
      });

      harness.emit({
        type: "turn.completed",
        eventId: asEventId("evt-limit-incompatible-sibling"),
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: current.instanceId,
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-limit-incompatible-sibling"),
        createdAt: "2026-01-01T00:00:01.000Z",
        payload: {
          state: "failed",
          errorMessage: "You've hit your usage limit for today.",
        },
      });

      const thread = yield* waitForThread(harness.readModel, (entry) =>
        entry.activities.some((activity) => activity.kind === "provider.account.rotation.refused"),
      );
      expect(thread.modelSelection).toEqual(current);
      expect(thread.activities.at(-1)?.summary).toBe(
        "Account 'Work' hit its usage limit. T3 Code kept this account because 'Personal' cannot continue its provider session.",
      );
      expect(harness.stoppedThreadIds).toEqual([]);
    }),
  );

  it.live("does not rebind when the failing provider session cannot stop", () =>
    Effect.gen(function* () {
      const current = {
        instanceId: ProviderInstanceId.make("codex-work"),
        model: "gpt-5-codex",
      };
      const harness = yield* createHarness({
        modelSelection: current,
        providers: [
          testProvider({ instanceId: "codex-work", driver: "codex", model: "gpt-5-codex" }),
          testProvider({
            instanceId: "codex-personal",
            driver: "codex",
            model: "gpt-5-codex",
          }),
        ],
        stopSessionFails: true,
      });

      harness.emit({
        type: "runtime.error",
        eventId: asEventId("evt-limit-stop-failed"),
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: current.instanceId,
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-limit-stop-failed"),
        createdAt: "2026-01-01T00:00:01.000Z",
        payload: { message: "Rate limit exceeded. Try again later." },
      });

      const thread = yield* waitForThread(
        harness.readModel,
        (entry) => entry.session?.lastError === "Rate limit exceeded. Try again later.",
      );
      yield* harness.drain();
      expect(thread.modelSelection).toEqual(current);
      expect(
        thread.activities.some((activity) => activity.kind === "provider.account.rotated"),
      ).toBe(false);
      expect(harness.stoppedThreadIds).toEqual([]);
    }),
  );

  it.live("does not rotate a limit event without an instance id", () =>
    Effect.gen(function* () {
      const current = {
        instanceId: ProviderInstanceId.make("codex-work"),
        model: "gpt-5-codex",
      };
      const harness = yield* createHarness({
        modelSelection: current,
        providers: [
          testProvider({ instanceId: "codex-work", driver: "codex", model: "gpt-5-codex" }),
          testProvider({
            instanceId: "codex-personal",
            driver: "codex",
            model: "gpt-5-codex",
          }),
        ],
      });

      harness.emit({
        type: "runtime.error",
        eventId: asEventId("evt-limit-missing-instance"),
        provider: ProviderDriverKind.make("codex"),
        threadId: harness.threadId,
        turnId: asTurnId("turn-limit-missing-instance"),
        createdAt: "2026-01-01T00:00:01.000Z",
        payload: { message: "Rate limit exceeded. Try again later." },
      });

      yield* harness.drain();
      const thread = (yield* harness.readModel()).threads.find(
        (entry) => entry.id === harness.threadId,
      );
      expect(thread?.modelSelection).toEqual(current);
      expect(harness.stoppedThreadIds).toEqual([]);
    }),
  );

  it.live("leaves epic iteration account rotation to EpicRunner", () =>
    Effect.gen(function* () {
      const current = {
        instanceId: ProviderInstanceId.make("codex-work"),
        model: "gpt-5-codex",
      };
      const threadId = ThreadId.make(
        epicRunIterationThreadId({ runId: "rotation", iterationIndex: 1 }),
      );
      const harness = yield* createHarness({
        threadId,
        modelSelection: current,
        providers: [
          testProvider({ instanceId: "codex-work", driver: "codex", model: "gpt-5-codex" }),
          testProvider({
            instanceId: "codex-personal",
            driver: "codex",
            model: "gpt-5-codex",
          }),
        ],
      });

      harness.emit({
        type: "turn.completed",
        eventId: asEventId("evt-limit-epic-thread"),
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: current.instanceId,
        threadId,
        turnId: asTurnId("turn-limit-epic-thread"),
        createdAt: "2026-01-01T00:00:01.000Z",
        payload: {
          state: "failed",
          errorMessage: "Rate limit exceeded. Try again later.",
        },
      });

      yield* harness.drain();
      const thread = (yield* harness.readModel()).threads.find((entry) => entry.id === threadId);
      expect(thread?.modelSelection).toEqual(current);
      expect(harness.stoppedThreadIds).toEqual([]);
    }),
  );

  // Teardown regression net (t3code-f90.8): a dead provider must tear the
  // session down, and a finished turn must not. The contrast is the point —
  // conflating the two is what made the original report claim that every turn
  // end killed the session.
  it.live("stops the session on session.exited but only readies it on turn.completed", () =>
    Effect.gen(function* () {
      const harness = yield* createHarness();
      const now = "2026-01-01T00:00:00.000Z";

      harness.emit({
        type: "turn.started",
        eventId: asEventId("evt-turn-started-keepalive"),
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: now,
        turnId: asTurnId("turn-keepalive-1"),
      });

      yield* waitForThread(
        harness.readModel,
        (thread) =>
          thread.session?.status === "running" &&
          thread.session?.activeTurnId === "turn-keepalive-1",
      );

      harness.emit({
        type: "turn.completed",
        eventId: asEventId("evt-turn-completed-keepalive"),
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: now,
        turnId: asTurnId("turn-keepalive-1"),
        payload: { state: "completed" },
      });

      const readied = yield* waitForThread(
        harness.readModel,
        (thread) => thread.session?.activeTurnId === null && thread.session?.status !== "running",
      );
      // A completed turn releases the turn pointer and leaves the session alive.
      expect(readied.session?.status).toBe("ready");
      expect(readied.session?.lastError).toBeNull();

      harness.emit({
        type: "turn.started",
        eventId: asEventId("evt-turn-started-before-exit"),
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: now,
        turnId: asTurnId("turn-keepalive-2"),
      });

      yield* waitForThread(
        harness.readModel,
        (thread) =>
          thread.session?.status === "running" &&
          thread.session?.activeTurnId === "turn-keepalive-2",
      );

      harness.emit({
        type: "session.exited",
        eventId: asEventId("evt-session-exited-kills-session"),
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: now,
      });

      // A dead provider stops the session even mid-turn, and clears the pointer
      // so the reaper's active-turn guard cannot keep the binding immortal.
      const stopped = yield* waitForThread(
        harness.readModel,
        (thread) => thread.session?.status === "stopped",
      );
      expect(stopped.session?.status).toBe("stopped");
      expect(stopped.session?.activeTurnId).toBeNull();
    }),
  );

  it.live("applies provider session.state.changed transitions directly", () =>
    Effect.gen(function* () {
      const harness = yield* createHarness();
      const waitingAt = "2026-01-01T00:00:00.000Z";

      harness.emit({
        type: "session.state.changed",
        eventId: asEventId("evt-session-state-waiting"),
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: waitingAt,
        payload: {
          state: "waiting",
          reason: "awaiting approval",
        },
      });

      let thread = yield* waitForThread(
        harness.readModel,
        (entry) => entry.session?.status === "running" && entry.session?.activeTurnId === null,
      );
      expect(thread.session?.status).toBe("running");
      expect(thread.session?.lastError).toBeNull();

      harness.emit({
        type: "session.state.changed",
        eventId: asEventId("evt-session-state-error"),
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: "2026-01-01T00:00:00.000Z",
        payload: {
          state: "error",
          reason: "provider crashed",
        },
      });

      thread = yield* waitForThread(
        harness.readModel,
        (entry) =>
          entry.session?.status === "error" &&
          entry.session?.activeTurnId === null &&
          entry.session?.lastError === "provider crashed",
      );
      expect(thread.session?.status).toBe("error");
      expect(thread.session?.lastError).toBe("provider crashed");

      harness.emit({
        type: "session.state.changed",
        eventId: asEventId("evt-session-state-stopped"),
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: "2026-01-01T00:00:00.000Z",
        payload: {
          state: "stopped",
        },
      });

      thread = yield* waitForThread(
        harness.readModel,
        (entry) =>
          entry.session?.status === "stopped" &&
          entry.session?.activeTurnId === null &&
          entry.session?.lastError === "provider crashed",
      );
      expect(thread.session?.status).toBe("stopped");
      expect(thread.session?.lastError).toBe("provider crashed");

      harness.emit({
        type: "session.state.changed",
        eventId: asEventId("evt-session-state-ready"),
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: "2026-01-01T00:00:00.000Z",
        payload: {
          state: "ready",
        },
      });

      thread = yield* waitForThread(
        harness.readModel,
        (entry) =>
          entry.session?.status === "ready" &&
          entry.session?.activeTurnId === null &&
          entry.session?.lastError === null,
      );
      expect(thread.session?.status).toBe("ready");
      expect(thread.session?.lastError).toBeNull();
    }),
  );

  it.live("clears active turn when provider session becomes ready", () =>
    Effect.gen(function* () {
      const harness = yield* createHarness();
      const now = "2026-01-01T00:00:00.000Z";

      harness.emit({
        type: "turn.started",
        eventId: asEventId("evt-turn-started-session-ready"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: now,
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-session-ready"),
      });

      yield* waitForThread(
        harness.readModel,
        (thread) =>
          thread.session?.status === "running" &&
          thread.session?.activeTurnId === "turn-session-ready",
        10_000,
      );

      harness.emit({
        type: "session.state.changed",
        eventId: asEventId("evt-session-state-ready-with-active-turn"),
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: "2026-01-01T00:00:01.000Z",
        payload: {
          state: "ready",
        },
      });

      const thread = yield* waitForThread(
        harness.readModel,
        (entry) =>
          entry.session?.status === "ready" &&
          entry.session?.activeTurnId === null &&
          entry.session?.lastError === null,
        10_000,
      );
      expect(thread.session?.status).toBe("ready");
      expect(thread.session?.activeTurnId).toBeNull();
      expect(thread.session?.lastError).toBeNull();
    }),
  );

  it.live("keeps a reconnecting pending turn starting while ready clears stale active state", () =>
    Effect.gen(function* () {
      const harness = yield* createHarness();
      const threadId = asThreadId("thread-1");
      const staleTurnId = asTurnId("turn-stale-before-reconnect");

      yield* harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-pending-reconnect"),
        threadId,
        message: {
          messageId: MessageId.make("message-pending-reconnect"),
          role: "user",
          text: "resume after reconnect",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:01.000Z",
      });
      yield* harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-starting-pending-reconnect"),
        threadId,
        session: {
          threadId,
          status: "starting",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: staleTurnId,
          lastError: null,
          updatedAt: "2026-01-01T00:00:01.000Z",
        },
        createdAt: "2026-01-01T00:00:01.000Z",
      });

      harness.emit({
        type: "session.state.changed",
        eventId: asEventId("evt-session-ready-pending-reconnect"),
        provider: ProviderDriverKind.make("codex"),
        threadId,
        createdAt: "2026-01-01T00:00:02.000Z",
        payload: { state: "ready" },
      });

      let thread = yield* waitForThread(
        harness.readModel,
        (entry) => entry.session?.status === "starting" && entry.session.activeTurnId === null,
      );
      expect(thread.session?.status).toBe("starting");
      expect(thread.session?.activeTurnId).toBeNull();

      harness.emit({
        type: "session.started",
        eventId: asEventId("evt-session-started-pending-reconnect"),
        provider: ProviderDriverKind.make("codex"),
        threadId,
        createdAt: "2026-01-01T00:00:03.000Z",
      });
      yield* harness.drain();
      thread = (yield* harness.readModel()).threads.find((entry) => entry.id === threadId)!;
      expect(thread.session?.status).toBe("starting");
      expect(thread.session?.activeTurnId).toBeNull();

      harness.emit({
        type: "turn.started",
        eventId: asEventId("evt-turn-started-pending-reconnect"),
        provider: ProviderDriverKind.make("codex"),
        threadId,
        turnId: asTurnId("turn-after-reconnect"),
        createdAt: "2026-01-01T00:00:04.000Z",
      });
      thread = yield* waitForThread(
        harness.readModel,
        (entry) =>
          entry.session?.status === "running" &&
          entry.session.activeTurnId === asTurnId("turn-after-reconnect"),
      );
      expect(thread.session?.status).toBe("running");

      harness.emit({
        type: "session.started",
        eventId: asEventId("evt-session-started-duplicate-midturn"),
        provider: ProviderDriverKind.make("codex"),
        threadId,
        createdAt: "2026-01-01T00:00:05.000Z",
      });
      yield* harness.drain();
      thread = (yield* harness.readModel()).threads.find((entry) => entry.id === threadId)!;
      expect(thread.session?.status).toBe("running");
      expect(thread.session?.activeTurnId).toBe(asTurnId("turn-after-reconnect"));
    }),
  );

  it.live("keeps an aborted pending start stopped across duplicate exit events", () =>
    Effect.gen(function* () {
      const harness = yield* createHarness();
      const threadId = asThreadId("thread-1");
      const stoppedAt = "2026-01-01T00:00:02.000Z";

      yield* harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-before-stop"),
        threadId,
        message: {
          messageId: MessageId.make("message-before-stop"),
          role: "user",
          text: "stop this startup",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:01.000Z",
      });
      yield* harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-starting-before-stop"),
        threadId,
        session: {
          threadId,
          status: "starting",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: "2026-01-01T00:00:01.000Z",
        },
        createdAt: "2026-01-01T00:00:01.000Z",
      });
      yield* harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-stop-pending-start"),
        threadId,
        session: {
          threadId,
          status: "stopped",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: stoppedAt,
        },
        createdAt: stoppedAt,
      });

      harness.emit({
        type: "session.exited",
        eventId: asEventId("evt-session-exited-after-stop"),
        provider: ProviderDriverKind.make("codex"),
        threadId,
        createdAt: "2026-01-01T00:00:03.000Z",
      });
      harness.emit({
        type: "session.exited",
        eventId: asEventId("evt-duplicate-session-exited-after-stop"),
        provider: ProviderDriverKind.make("codex"),
        threadId,
        createdAt: "2026-01-01T00:00:04.000Z",
      });

      yield* harness.drain();
      const thread = (yield* harness.readModel()).threads.find((entry) => entry.id === threadId);
      expect(thread?.session?.status).toBe("stopped");
      expect(thread?.session?.activeTurnId).toBeNull();
    }),
  );

  it.live("does not clear active turn when session/thread started arrives mid-turn", () =>
    Effect.gen(function* () {
      const harness = yield* createHarness();
      const now = "2026-01-01T00:00:00.000Z";

      harness.emit({
        type: "turn.started",
        eventId: asEventId("evt-turn-started-midturn-lifecycle"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: now,
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-midturn-lifecycle"),
      });

      yield* waitForThread(
        harness.readModel,
        (thread) =>
          thread.session?.status === "running" &&
          thread.session?.activeTurnId === "turn-midturn-lifecycle",
        10_000,
      );

      harness.emit({
        type: "thread.started",
        eventId: asEventId("evt-thread-started-midturn-lifecycle"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        threadId: asThreadId("thread-1"),
      });
      harness.emit({
        type: "session.started",
        eventId: asEventId("evt-session-started-midturn-lifecycle"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        threadId: asThreadId("thread-1"),
      });

      yield* harness.drain();
      const midReadModel = yield* harness.readModel();
      const midThread = midReadModel.threads.find(
        (entry) => entry.id === ThreadId.make("thread-1"),
      );
      expect(midThread?.session?.status).toBe("running");
      expect(midThread?.session?.activeTurnId).toBe("turn-midturn-lifecycle");

      harness.emit({
        type: "turn.completed",
        eventId: asEventId("evt-turn-completed-midturn-lifecycle"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-midturn-lifecycle"),
        status: "completed",
      });

      yield* waitForThread(
        harness.readModel,
        (thread) => thread.session?.status === "ready" && thread.session?.activeTurnId === null,
        10_000,
      );
    }),
  );

  it.live("accepts claude turn lifecycle when seeded thread id is a synthetic placeholder", () =>
    Effect.gen(function* () {
      const harness = yield* createHarness();
      const seededAt = "2026-01-01T00:00:00.000Z";

      yield* dispatch(harness.engine, {
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-seed-claude-placeholder"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "claudeAgent",
          runtimeMode: "approval-required",
          activeTurnId: null,
          updatedAt: seededAt,
          lastError: null,
        },
        createdAt: seededAt,
      });

      harness.emit({
        type: "turn.started",
        eventId: asEventId("evt-turn-started-claude-placeholder"),
        provider: ProviderDriverKind.make("claudeAgent"),
        createdAt: "2026-01-01T00:00:00.000Z",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-claude-placeholder"),
      });

      yield* waitForThread(
        harness.readModel,
        (thread) =>
          thread.session?.status === "running" &&
          thread.session?.activeTurnId === "turn-claude-placeholder",
      );

      harness.emit({
        type: "turn.completed",
        eventId: asEventId("evt-turn-completed-claude-placeholder"),
        provider: ProviderDriverKind.make("claudeAgent"),
        createdAt: "2026-01-01T00:00:00.000Z",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-claude-placeholder"),
        status: "completed",
      });

      yield* waitForThread(
        harness.readModel,
        (thread) => thread.session?.status === "ready" && thread.session?.activeTurnId === null,
      );
    }),
  );

  it.live("ignores auxiliary turn completions from a different provider thread", () =>
    Effect.gen(function* () {
      const harness = yield* createHarness();
      const now = "2026-01-01T00:00:00.000Z";

      harness.emit({
        type: "turn.started",
        eventId: asEventId("evt-turn-started-primary"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: now,
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-primary"),
      });

      yield* waitForThread(
        harness.readModel,
        (thread) =>
          thread.session?.status === "running" && thread.session?.activeTurnId === "turn-primary",
      );

      harness.emit({
        type: "turn.completed",
        eventId: asEventId("evt-turn-completed-aux"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-aux"),
        status: "completed",
      });

      yield* harness.drain();
      const midReadModel = yield* harness.readModel();
      const midThread = midReadModel.threads.find(
        (entry) => entry.id === ThreadId.make("thread-1"),
      );
      expect(midThread?.session?.status).toBe("running");
      expect(midThread?.session?.activeTurnId).toBe("turn-primary");

      harness.emit({
        type: "turn.completed",
        eventId: asEventId("evt-turn-completed-primary"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-primary"),
        status: "completed",
      });

      yield* waitForThread(
        harness.readModel,
        (thread) => thread.session?.status === "ready" && thread.session?.activeTurnId === null,
      );
    }),
  );

  it.live("ignores non-active turn completion when runtime omits thread id", () =>
    Effect.gen(function* () {
      const harness = yield* createHarness();
      const now = "2026-01-01T00:00:00.000Z";

      harness.emit({
        type: "turn.started",
        eventId: asEventId("evt-turn-started-guarded"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: now,
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-guarded-main"),
      });

      yield* waitForThread(
        harness.readModel,
        (thread) =>
          thread.session?.status === "running" &&
          thread.session?.activeTurnId === "turn-guarded-main",
      );

      harness.emit({
        type: "turn.completed",
        eventId: asEventId("evt-turn-completed-guarded-other"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-guarded-other"),
        status: "completed",
      });

      yield* harness.drain();
      const midReadModel = yield* harness.readModel();
      const midThread = midReadModel.threads.find(
        (entry) => entry.id === ThreadId.make("thread-1"),
      );
      expect(midThread?.session?.status).toBe("running");
      expect(midThread?.session?.activeTurnId).toBe("turn-guarded-main");

      harness.emit({
        type: "turn.completed",
        eventId: asEventId("evt-turn-completed-guarded-main"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-guarded-main"),
        status: "completed",
      });

      yield* waitForThread(
        harness.readModel,
        (thread) => thread.session?.status === "ready" && thread.session?.activeTurnId === null,
      );
    }),
  );

  it.live("maps canonical content delta/item completed into finalized assistant messages", () =>
    Effect.gen(function* () {
      const harness = yield* createHarness();
      const now = "2026-01-01T00:00:00.000Z";

      harness.emit({
        type: "content.delta",
        eventId: asEventId("evt-message-delta-1"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: now,
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-2"),
        itemId: asItemId("item-1"),
        payload: {
          streamKind: "assistant_text",
          delta: "hello",
        },
      });
      harness.emit({
        type: "content.delta",
        eventId: asEventId("evt-message-delta-2"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: now,
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-2"),
        itemId: asItemId("item-1"),
        payload: {
          streamKind: "assistant_text",
          delta: " world",
        },
      });
      harness.emit({
        type: "item.completed",
        eventId: asEventId("evt-message-completed"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: now,
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-2"),
        itemId: asItemId("item-1"),
        payload: {
          itemType: "assistant_message",
          status: "completed",
        },
      });

      const thread = yield* waitForThread(harness.readModel, (entry) =>
        entry.messages.some(
          (message: ProviderRuntimeTestMessage) =>
            message.id === "assistant:item-1" && !message.streaming,
        ),
      );
      const message = thread.messages.find(
        (entry: ProviderRuntimeTestMessage) => entry.id === "assistant:item-1",
      );
      expect(message?.text).toBe("hello world");
      expect(message?.streaming).toBe(false);
    }),
  );

  it.live(
    "correlates terminal epic markers across projected streaming and rejects malformed markers",
    () =>
      Effect.gen(function* () {
        const harness = yield* createHarness({
          serverSettings: { enableAssistantStreaming: true },
        });
        const now = "2026-01-01T00:00:00.000Z";
        const emitMessage = (itemId: string, delta: string) => {
          harness.emit({
            type: "content.delta",
            eventId: asEventId(`evt-${itemId}-delta`),
            provider: ProviderDriverKind.make("codex"),
            createdAt: now,
            threadId: asThreadId("thread-1"),
            turnId: asTurnId(`turn-${itemId}`),
            itemId: asItemId(itemId),
            payload: { streamKind: "assistant_text", delta },
          });
          harness.emit({
            type: "item.completed",
            eventId: asEventId(`evt-${itemId}-complete`),
            provider: ProviderDriverKind.make("codex"),
            createdAt: now,
            threadId: asThreadId("thread-1"),
            turnId: asTurnId(`turn-${itemId}`),
            itemId: asItemId(itemId),
            payload: { itemType: "assistant_message", status: "completed" },
          });
        };

        emitMessage("item-valid-marker", 'Planned.\nT3_EPIC_PLAN: {"v":1,"epicId":"t3code-vst"}');
        let thread = yield* waitForThread(harness.readModel, (entry) =>
          entry.messages.some(
            (message: ProviderRuntimeTestMessage) =>
              message.id === "assistant:item-valid-marker" && !message.streaming,
          ),
        );
        expect(
          thread.messages.find(
            (message: ProviderRuntimeTestMessage) => message.id === "assistant:item-valid-marker",
          )?.correlation,
        ).toMatchObject({ epicId: "t3code-vst", threadId: "thread-1", projectId: "project-1" });

        emitMessage(
          "item-malformed-marker",
          'T3_EPIC_PLAN: {"v":1,"epicId":"wrong"}\ntrailing prose',
        );
        thread = yield* waitForThread(harness.readModel, (entry) =>
          entry.messages.some(
            (message: ProviderRuntimeTestMessage) =>
              message.id === "assistant:item-malformed-marker" && !message.streaming,
          ),
        );
        expect(
          thread.messages.find(
            (message: ProviderRuntimeTestMessage) =>
              message.id === "assistant:item-malformed-marker",
          )?.correlation,
        ).toBeUndefined();
      }),
  );

  it.live("correlates a terminal epic marker buffered until completion", () =>
    Effect.gen(function* () {
      const harness = yield* createHarness();
      const now = "2026-01-01T00:00:00.000Z";
      harness.emit({
        type: "content.delta",
        eventId: asEventId("evt-buffered-marker-delta"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: now,
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-buffered-marker"),
        itemId: asItemId("item-buffered-marker"),
        payload: {
          streamKind: "assistant_text",
          delta: 'Planned.\nT3_EPIC_PLAN: {"v":1,"epicId":"t3code-vst"}',
        },
      });
      harness.emit({
        type: "item.completed",
        eventId: asEventId("evt-buffered-marker-complete"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: now,
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-buffered-marker"),
        itemId: asItemId("item-buffered-marker"),
        payload: { itemType: "assistant_message", status: "completed" },
      });
      const thread = yield* waitForThread(harness.readModel, (entry) =>
        entry.messages.some(
          (message: ProviderRuntimeTestMessage) =>
            message.id === "assistant:item-buffered-marker" && !message.streaming,
        ),
      );
      expect(
        thread.messages.find(
          (message: ProviderRuntimeTestMessage) => message.id === "assistant:item-buffered-marker",
        )?.correlation,
      ).toMatchObject({ epicId: "t3code-vst" });
    }),
  );

  it.live("uses assistant item completion detail when no assistant deltas were streamed", () =>
    Effect.gen(function* () {
      const harness = yield* createHarness();
      const now = "2026-01-01T00:00:00.000Z";

      harness.emit({
        type: "item.completed",
        eventId: asEventId("evt-assistant-item-completed-no-delta"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: now,
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-no-delta"),
        itemId: asItemId("item-no-delta"),
        payload: {
          itemType: "assistant_message",
          status: "completed",
          detail: "assistant-only final text",
        },
      });

      const thread = yield* waitForThread(harness.readModel, (entry) =>
        entry.messages.some(
          (message: ProviderRuntimeTestMessage) =>
            message.id === "assistant:item-no-delta" && !message.streaming,
        ),
      );
      const message = thread.messages.find(
        (entry: ProviderRuntimeTestMessage) => entry.id === "assistant:item-no-delta",
      );
      expect(message?.text).toBe("assistant-only final text");
      expect(message?.streaming).toBe(false);
    }),
  );

  it.live("preserves completed tool metadata on projected tool activities", () =>
    Effect.gen(function* () {
      const harness = yield* createHarness();
      const now = "2026-01-01T00:00:00.000Z";

      harness.emit({
        type: "item.completed",
        eventId: asEventId("evt-tool-completed-with-data"),
        provider: ProviderDriverKind.make("cursor"),
        createdAt: now,
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-tool-completed"),
        itemId: asItemId("item-tool-completed"),
        payload: {
          itemType: "dynamic_tool_call",
          status: "completed",
          title: "Read file",
          data: {
            toolCallId: "tool-read-1",
            kind: "read",
            rawOutput: {
              content: 'import * as Effect from "effect/Effect"\n',
            },
          },
        },
      });

      const thread = yield* waitForThread(harness.readModel, (entry) =>
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.id === "evt-tool-completed-with-data",
        ),
      );
      const activity = thread.activities.find(
        (entry: ProviderRuntimeTestActivity) => entry.id === "evt-tool-completed-with-data",
      );
      const payload =
        activity?.payload && typeof activity.payload === "object"
          ? (activity.payload as Record<string, unknown>)
          : undefined;
      const data =
        payload?.data && typeof payload.data === "object"
          ? (payload.data as Record<string, unknown>)
          : undefined;
      const rawOutput =
        data?.rawOutput && typeof data.rawOutput === "object"
          ? (data.rawOutput as Record<string, unknown>)
          : undefined;

      expect(activity?.kind).toBe("tool.completed");
      expect(activity?.summary).toBe("Read file");
      expect(payload?.itemType).toBe("dynamic_tool_call");
      expect(payload?.detail).toBeUndefined();
      expect(data?.toolCallId).toBe("tool-read-1");
      expect(data?.kind).toBe("read");
      expect(rawOutput?.content).toBe('import * as Effect from "effect/Effect"\n');
    }),
  );

  it.live("normalizes command execution activities to ran-command summaries", () =>
    Effect.gen(function* () {
      const harness = yield* createHarness();
      const now = "2026-01-01T00:00:00.000Z";

      harness.emit({
        type: "item.completed",
        eventId: asEventId("evt-command-completed"),
        provider: ProviderDriverKind.make("cursor"),
        createdAt: now,
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-command-completed"),
        itemId: asItemId("item-command-completed"),
        payload: {
          itemType: "command_execution",
          status: "completed",
          title: "Ran command",
          detail: "bun run lint",
          data: {
            toolCallId: "tool-command-1",
            kind: "execute",
            command: "bun run lint",
          },
        },
      });

      const thread = yield* waitForThread(harness.readModel, (entry) =>
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.id === "evt-command-completed",
        ),
      );
      const activity = thread.activities.find(
        (entry: ProviderRuntimeTestActivity) => entry.id === "evt-command-completed",
      );
      const payload =
        activity?.payload && typeof activity.payload === "object"
          ? (activity.payload as Record<string, unknown>)
          : undefined;

      expect(activity?.summary).toBe("Ran command");
      expect(payload?.detail).toBe("bun run lint");
    }),
  );

  it.live("uses structured read-file paths when available", () =>
    Effect.gen(function* () {
      const harness = yield* createHarness();
      const now = "2026-01-01T00:00:00.000Z";

      harness.emit({
        type: "item.completed",
        eventId: asEventId("evt-read-path-completed"),
        provider: ProviderDriverKind.make("cursor"),
        createdAt: now,
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-read-path"),
        itemId: asItemId("item-read-path"),
        payload: {
          itemType: "dynamic_tool_call",
          status: "completed",
          title: "Read file",
          detail: "/tmp/app.ts",
          data: {
            toolCallId: "tool-read-path-1",
            kind: "read",
            locations: [{ path: "/tmp/app.ts" }],
          },
        },
      });

      const thread = yield* waitForThread(harness.readModel, (entry) =>
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.id === "evt-read-path-completed",
        ),
      );
      const activity = thread.activities.find(
        (entry: ProviderRuntimeTestActivity) => entry.id === "evt-read-path-completed",
      );
      const payload =
        activity?.payload && typeof activity.payload === "object"
          ? (activity.payload as Record<string, unknown>)
          : undefined;

      expect(activity?.summary).toBe("Read file");
      expect(payload?.detail).toBe("/tmp/app.ts");
    }),
  );

  it.live("projects completed plan items into first-class proposed plans", () =>
    Effect.gen(function* () {
      const harness = yield* createHarness();
      const now = "2026-01-01T00:00:00.000Z";

      harness.emit({
        type: "turn.proposed.completed",
        eventId: asEventId("evt-plan-item-completed"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: now,
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-plan-final"),
        payload: {
          planMarkdown: "## Ship plan\n\n- wire projection\n- render follow-up",
        },
      });

      const thread = yield* waitForThread(harness.readModel, (entry) =>
        entry.proposedPlans.some(
          (proposedPlan: ProviderRuntimeTestProposedPlan) =>
            proposedPlan.id === "plan:thread-1:turn:turn-plan-final",
        ),
      );
      const proposedPlan = thread.proposedPlans.find(
        (entry: ProviderRuntimeTestProposedPlan) =>
          entry.id === "plan:thread-1:turn:turn-plan-final",
      );
      expect(proposedPlan?.planMarkdown).toBe(
        "## Ship plan\n\n- wire projection\n- render follow-up",
      );
    }),
  );

  it.live("marks the source proposed plan implemented only after the target turn starts", () =>
    Effect.gen(function* () {
      const harness = yield* createHarness();
      const sourceThreadId = asThreadId("thread-plan");
      const targetThreadId = asThreadId("thread-implement");
      const sourceTurnId = asTurnId("turn-plan-source");
      const targetTurnId = asTurnId("turn-plan-implement");
      const createdAt = "2026-01-01T00:00:00.000Z";

      yield* dispatch(harness.engine, {
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-create-plan-source"),
        threadId: sourceThreadId,
        projectId: asProjectId("project-1"),
        title: "Plan Source",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: "plan",
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      });
      yield* dispatch(harness.engine, {
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-plan-source"),
        threadId: sourceThreadId,
        session: {
          threadId: sourceThreadId,
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          updatedAt: createdAt,
          lastError: null,
        },
        createdAt,
      });
      yield* dispatch(harness.engine, {
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-create-plan-target"),
        threadId: targetThreadId,
        projectId: asProjectId("project-1"),
        title: "Plan Target",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      });
      yield* dispatch(harness.engine, {
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-plan-target"),
        threadId: targetThreadId,
        session: {
          threadId: targetThreadId,
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          updatedAt: createdAt,
          lastError: null,
        },
        createdAt,
      });
      harness.setProviderSession({
        provider: ProviderDriverKind.make("codex"),
        status: "ready",
        runtimeMode: "approval-required",
        threadId: targetThreadId,
        createdAt,
        updatedAt: createdAt,
        activeTurnId: targetTurnId,
      });

      harness.emit({
        type: "turn.proposed.completed",
        eventId: asEventId("evt-plan-source-completed"),
        provider: ProviderDriverKind.make("codex"),
        createdAt,
        threadId: sourceThreadId,
        turnId: sourceTurnId,
        payload: {
          planMarkdown: "# Source plan",
        },
      });

      const sourceThreadWithPlan = yield* waitForThread(
        harness.readModel,
        (thread) =>
          thread.proposedPlans.some(
            (proposedPlan: ProviderRuntimeTestProposedPlan) =>
              proposedPlan.id === "plan:thread-plan:turn:turn-plan-source" &&
              proposedPlan.implementedAt === null,
          ),
        2_000,
        sourceThreadId,
      );
      const sourcePlan = sourceThreadWithPlan.proposedPlans.find(
        (entry: ProviderRuntimeTestProposedPlan) =>
          entry.id === "plan:thread-plan:turn:turn-plan-source",
      );
      expect(sourcePlan).toBeDefined();
      if (!sourcePlan) {
        throw new Error("Expected source plan to exist.");
      }

      yield* dispatch(harness.engine, {
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-plan-target"),
        threadId: targetThreadId,
        message: {
          messageId: asMessageId("msg-plan-target"),
          role: "user",
          text: "PLEASE IMPLEMENT THIS PLAN:\n# Source plan",
          attachments: [],
        },
        sourceProposedPlan: {
          threadId: sourceThreadId,
          planId: sourcePlan.id,
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:00.000Z",
      });

      const sourceThreadBeforeStart = yield* waitForThread(
        harness.readModel,
        (thread) =>
          thread.proposedPlans.some(
            (proposedPlan: ProviderRuntimeTestProposedPlan) =>
              proposedPlan.id === sourcePlan.id && proposedPlan.implementedAt === null,
          ),
        2_000,
        sourceThreadId,
      );
      expect(
        sourceThreadBeforeStart.proposedPlans.find((entry) => entry.id === sourcePlan.id),
      ).toMatchObject({
        implementedAt: null,
        implementationThreadId: null,
      });

      harness.emit({
        type: "turn.started",
        eventId: asEventId("evt-plan-target-started"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        threadId: targetThreadId,
        turnId: targetTurnId,
      });

      const sourceThreadAfterStart = yield* waitForThread(
        harness.readModel,
        (thread) =>
          thread.proposedPlans.some(
            (proposedPlan: ProviderRuntimeTestProposedPlan) =>
              proposedPlan.id === sourcePlan.id &&
              proposedPlan.implementedAt !== null &&
              proposedPlan.implementationThreadId === targetThreadId,
          ),
        2_000,
        sourceThreadId,
      );
      expect(
        sourceThreadAfterStart.proposedPlans.find((entry) => entry.id === sourcePlan.id),
      ).toMatchObject({
        implementationThreadId: "thread-implement",
      });
    }),
  );

  it.live(
    "does not mark the source proposed plan implemented for a rejected turn.started event",
    () =>
      Effect.gen(function* () {
        const harness = yield* createHarness();
        const sourceThreadId = asThreadId("thread-plan");
        const targetThreadId = asThreadId("thread-1");
        const sourceTurnId = asTurnId("turn-plan-source");
        const activeTurnId = asTurnId("turn-already-running");
        const staleTurnId = asTurnId("turn-stale-start");
        const createdAt = "2026-01-01T00:00:00.000Z";

        yield* harness.engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd-thread-create-plan-source-guarded"),
          threadId: sourceThreadId,
          projectId: asProjectId("project-1"),
          title: "Plan Source",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: "plan",
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt,
        });
        yield* harness.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make("cmd-session-set-plan-source-guarded"),
          threadId: sourceThreadId,
          session: {
            threadId: sourceThreadId,
            status: "ready",
            providerName: "codex",
            runtimeMode: "approval-required",
            activeTurnId: null,
            updatedAt: createdAt,
            lastError: null,
          },
          createdAt,
        });
        harness.setProviderSession({
          provider: ProviderDriverKind.make("codex"),
          status: "running",
          runtimeMode: "approval-required",
          threadId: targetThreadId,
          createdAt,
          updatedAt: createdAt,
          activeTurnId,
        });

        harness.emit({
          type: "turn.started",
          eventId: asEventId("evt-turn-started-already-running"),
          provider: ProviderDriverKind.make("codex"),
          createdAt,
          threadId: targetThreadId,
          turnId: activeTurnId,
        });

        yield* waitForThread(
          harness.readModel,
          (thread) =>
            thread.session?.status === "running" && thread.session?.activeTurnId === activeTurnId,
          2_000,
          targetThreadId,
        );

        harness.emit({
          type: "turn.proposed.completed",
          eventId: asEventId("evt-plan-source-completed-guarded"),
          provider: ProviderDriverKind.make("codex"),
          createdAt,
          threadId: sourceThreadId,
          turnId: sourceTurnId,
          payload: {
            planMarkdown: "# Source plan",
          },
        });

        const sourceThreadWithPlan = yield* waitForThread(
          harness.readModel,
          (thread) =>
            thread.proposedPlans.some(
              (proposedPlan: ProviderRuntimeTestProposedPlan) =>
                proposedPlan.id === "plan:thread-plan:turn:turn-plan-source" &&
                proposedPlan.implementedAt === null,
            ),
          2_000,
          sourceThreadId,
        );
        const sourcePlan = sourceThreadWithPlan.proposedPlans.find(
          (entry: ProviderRuntimeTestProposedPlan) =>
            entry.id === "plan:thread-plan:turn:turn-plan-source",
        );
        expect(sourcePlan).toBeDefined();
        if (!sourcePlan) {
          throw new Error("Expected source plan to exist.");
        }

        yield* dispatch(harness.engine, {
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-turn-start-plan-target-guarded"),
          threadId: targetThreadId,
          message: {
            messageId: asMessageId("msg-plan-target-guarded"),
            role: "user",
            text: "PLEASE IMPLEMENT THIS PLAN:\n# Source plan",
            attachments: [],
          },
          sourceProposedPlan: {
            threadId: sourceThreadId,
            planId: sourcePlan.id,
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: "2026-01-01T00:00:00.000Z",
        });

        harness.emit({
          type: "turn.started",
          eventId: asEventId("evt-turn-started-stale-plan-implementation"),
          provider: ProviderDriverKind.make("codex"),
          createdAt: "2026-01-01T00:00:00.000Z",
          threadId: targetThreadId,
          turnId: staleTurnId,
        });

        yield* harness.drain();

        const readModel = yield* harness.readModel();
        const sourceThreadAfterRejectedStart = readModel.threads.find(
          (entry) => entry.id === sourceThreadId,
        );
        expect(
          sourceThreadAfterRejectedStart?.proposedPlans.find((entry) => entry.id === sourcePlan.id),
        ).toMatchObject({
          implementedAt: null,
          implementationThreadId: null,
        });

        const targetThreadAfterRejectedStart = readModel.threads.find(
          (entry) => entry.id === targetThreadId,
        );
        expect(targetThreadAfterRejectedStart?.session?.status).toBe("running");
        expect(targetThreadAfterRejectedStart?.session?.activeTurnId).toBe(activeTurnId);
      }),
  );

  it.live(
    "accepts a conflicting turn.started for a pending turn start when the provider expects that turn",
    () =>
      Effect.gen(function* () {
        // Steering a running turn: the server requests a new turn while the old
        // one is still active, and providers like opencode open the new turn
        // without ever completing the superseded one. The new turn.started must
        // replace the active turn instead of being rejected as stale.
        const harness = yield* createHarness();
        const threadId = asThreadId("thread-1");
        const oldTurnId = asTurnId("turn-steered-over");
        const newTurnId = asTurnId("turn-from-steer");
        const createdAt = "2026-01-01T00:00:00.000Z";

        harness.setProviderSession({
          provider: ProviderDriverKind.make("codex"),
          status: "running",
          runtimeMode: "approval-required",
          threadId,
          createdAt,
          updatedAt: createdAt,
          activeTurnId: oldTurnId,
        });
        harness.emit({
          type: "turn.started",
          eventId: asEventId("evt-turn-started-steered-over"),
          provider: ProviderDriverKind.make("codex"),
          createdAt,
          threadId,
          turnId: oldTurnId,
        });
        yield* waitForThread(
          harness.readModel,
          (thread) =>
            thread.session?.status === "running" && thread.session?.activeTurnId === oldTurnId,
          2_000,
          threadId,
        );

        // The steer: a user-requested turn start while the old turn still runs.
        yield* dispatch(harness.engine, {
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-turn-start-steer"),
          threadId,
          message: {
            messageId: asMessageId("msg-steer"),
            role: "user",
            text: "actually, do 15 instead",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt,
        });

        // The provider session tracks the new turn before emitting turn.started
        // (sendTurn updates the session first).
        harness.setProviderSession({
          provider: ProviderDriverKind.make("codex"),
          status: "running",
          runtimeMode: "approval-required",
          threadId,
          createdAt,
          updatedAt: createdAt,
          activeTurnId: newTurnId,
        });
        harness.emit({
          type: "turn.started",
          eventId: asEventId("evt-turn-started-from-steer"),
          provider: ProviderDriverKind.make("codex"),
          createdAt,
          threadId,
          turnId: newTurnId,
        });

        const threadAfterSteer = yield* waitForThread(
          harness.readModel,
          (thread) =>
            thread.session?.status === "running" && thread.session?.activeTurnId === newTurnId,
          2_000,
          threadId,
        );
        expect(threadAfterSteer.session?.activeTurnId).toBe(newTurnId);
        expect(threadAfterSteer.latestTurn?.turnId).toBe(newTurnId);
        expect(threadAfterSteer.latestTurn?.state).toBe("running");
      }),
  );

  it.live("keeps the real active turn after a Codex steer is absorbed without turn.started", () =>
    Effect.gen(function* () {
      const harness = yield* createHarness();
      const threadId = asThreadId("thread-1");
      const activeTurnId = asTurnId("turn-codex-active");
      const phantomTurnId = asTurnId("turn-codex-phantom");
      const createdAt = "2026-01-01T00:00:00.000Z";

      harness.setProviderSession({
        provider: ProviderDriverKind.make("codex"),
        status: "running",
        runtimeMode: "approval-required",
        threadId,
        createdAt,
        updatedAt: createdAt,
        activeTurnId,
      });
      harness.emit({
        type: "turn.started",
        eventId: asEventId("evt-codex-active-started"),
        provider: ProviderDriverKind.make("codex"),
        createdAt,
        threadId,
        turnId: activeTurnId,
      });
      yield* waitForThread(
        harness.readModel,
        (thread) =>
          thread.session?.status === "running" && thread.session.activeTurnId === activeTurnId,
        2_000,
        threadId,
      );

      yield* dispatch(harness.engine, {
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-codex-absorbed-steer"),
        threadId,
        message: {
          messageId: asMessageId("msg-codex-absorbed-steer"),
          role: "user",
          text: "adjust the running turn",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:01.000Z",
      });

      // Codex emits no second turn.started for an absorbed steer. A stale
      // response id must not pass the pending-turn exception in the guard.
      harness.emit({
        type: "turn.started",
        eventId: asEventId("evt-codex-phantom-started"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:02.000Z",
        threadId,
        turnId: phantomTurnId,
      });
      yield* harness.drain();

      let thread = yield* waitForThread(
        harness.readModel,
        (entry) => entry.session?.activeTurnId === activeTurnId,
        2_000,
        threadId,
      );
      expect(thread.latestTurn?.turnId).toBe(activeTurnId);

      harness.emit({
        type: "turn.completed",
        eventId: asEventId("evt-codex-active-completed"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:03.000Z",
        threadId,
        turnId: activeTurnId,
        payload: { state: "completed" },
      });
      thread = yield* waitForThread(
        harness.readModel,
        (entry) => entry.session?.status === "ready" && entry.session.activeTurnId === null,
        2_000,
        threadId,
      );
      expect(thread.session?.lastError).toBeNull();
    }),
  );

  it.live(
    "does not mark the source proposed plan implemented for an unrelated turn.started when no thread active turn is tracked",
    () =>
      Effect.gen(function* () {
        const harness = yield* createHarness();
        const sourceThreadId = asThreadId("thread-plan");
        const targetThreadId = asThreadId("thread-implement");
        const sourceTurnId = asTurnId("turn-plan-source");
        const expectedTurnId = asTurnId("turn-plan-implement");
        const replayedTurnId = asTurnId("turn-replayed");
        const createdAt = "2026-01-01T00:00:00.000Z";

        yield* dispatch(harness.engine, {
          type: "thread.create",
          commandId: CommandId.make("cmd-thread-create-plan-source-unrelated"),
          threadId: sourceThreadId,
          projectId: asProjectId("project-1"),
          title: "Plan Source",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: "plan",
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt,
        });
        yield* dispatch(harness.engine, {
          type: "thread.session.set",
          commandId: CommandId.make("cmd-session-set-plan-source-unrelated"),
          threadId: sourceThreadId,
          session: {
            threadId: sourceThreadId,
            status: "ready",
            providerName: "codex",
            runtimeMode: "approval-required",
            activeTurnId: null,
            updatedAt: createdAt,
            lastError: null,
          },
          createdAt,
        });
        yield* dispatch(harness.engine, {
          type: "thread.create",
          commandId: CommandId.make("cmd-thread-create-plan-target-unrelated"),
          threadId: targetThreadId,
          projectId: asProjectId("project-1"),
          title: "Plan Target",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt,
        });
        yield* dispatch(harness.engine, {
          type: "thread.session.set",
          commandId: CommandId.make("cmd-session-set-plan-target-unrelated"),
          threadId: targetThreadId,
          session: {
            threadId: targetThreadId,
            status: "ready",
            providerName: "codex",
            runtimeMode: "approval-required",
            activeTurnId: null,
            updatedAt: createdAt,
            lastError: null,
          },
          createdAt,
        });

        harness.emit({
          type: "turn.proposed.completed",
          eventId: asEventId("evt-plan-source-completed-unrelated"),
          provider: ProviderDriverKind.make("codex"),
          createdAt,
          threadId: sourceThreadId,
          turnId: sourceTurnId,
          payload: {
            planMarkdown: "# Source plan",
          },
        });

        const sourceThreadWithPlan = yield* waitForThread(
          harness.readModel,
          (thread) =>
            thread.proposedPlans.some(
              (proposedPlan: ProviderRuntimeTestProposedPlan) =>
                proposedPlan.id === "plan:thread-plan:turn:turn-plan-source" &&
                proposedPlan.implementedAt === null,
            ),
          2_000,
          sourceThreadId,
        );
        const sourcePlan = sourceThreadWithPlan.proposedPlans.find(
          (entry: ProviderRuntimeTestProposedPlan) =>
            entry.id === "plan:thread-plan:turn:turn-plan-source",
        );
        expect(sourcePlan).toBeDefined();
        if (!sourcePlan) {
          throw new Error("Expected source plan to exist.");
        }

        yield* dispatch(harness.engine, {
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-turn-start-plan-target-unrelated"),
          threadId: targetThreadId,
          message: {
            messageId: asMessageId("msg-plan-target-unrelated"),
            role: "user",
            text: "PLEASE IMPLEMENT THIS PLAN:\n# Source plan",
            attachments: [],
          },
          sourceProposedPlan: {
            threadId: sourceThreadId,
            planId: sourcePlan.id,
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: "2026-01-01T00:00:00.000Z",
        });

        harness.setProviderSession({
          provider: ProviderDriverKind.make("codex"),
          status: "running",
          runtimeMode: "approval-required",
          threadId: targetThreadId,
          createdAt,
          updatedAt: createdAt,
          activeTurnId: expectedTurnId,
        });

        harness.emit({
          type: "turn.started",
          eventId: asEventId("evt-turn-started-unrelated-plan-implementation"),
          provider: ProviderDriverKind.make("codex"),
          createdAt: "2026-01-01T00:00:00.000Z",
          threadId: targetThreadId,
          turnId: replayedTurnId,
        });

        yield* harness.drain();

        const readModel = yield* harness.readModel();
        const sourceThreadAfterUnrelatedStart = readModel.threads.find(
          (entry) => entry.id === sourceThreadId,
        );
        expect(
          sourceThreadAfterUnrelatedStart?.proposedPlans.find(
            (entry) => entry.id === sourcePlan.id,
          ),
        ).toMatchObject({
          implementedAt: null,
          implementationThreadId: null,
        });
      }),
  );

  it.live(
    "finalizes buffered proposed-plan deltas into a first-class proposed plan on turn completion",
    () =>
      Effect.gen(function* () {
        const harness = yield* createHarness();
        const now = "2026-01-01T00:00:00.000Z";

        harness.emit({
          type: "turn.started",
          eventId: asEventId("evt-turn-started-plan-buffer"),
          provider: ProviderDriverKind.make("codex"),
          createdAt: now,
          threadId: asThreadId("thread-1"),
          turnId: asTurnId("turn-plan-buffer"),
        });

        yield* waitForThread(
          harness.readModel,
          (thread) =>
            thread.session?.status === "running" &&
            thread.session?.activeTurnId === "turn-plan-buffer",
        );

        harness.emit({
          type: "turn.proposed.delta",
          eventId: asEventId("evt-plan-delta-1"),
          provider: ProviderDriverKind.make("codex"),
          createdAt: now,
          threadId: asThreadId("thread-1"),
          turnId: asTurnId("turn-plan-buffer"),
          payload: {
            delta: "## Buffered plan\n\n- first",
          },
        });
        harness.emit({
          type: "turn.proposed.delta",
          eventId: asEventId("evt-plan-delta-2"),
          provider: ProviderDriverKind.make("codex"),
          createdAt: now,
          threadId: asThreadId("thread-1"),
          turnId: asTurnId("turn-plan-buffer"),
          payload: {
            delta: "\n- second",
          },
        });
        harness.emit({
          type: "turn.completed",
          eventId: asEventId("evt-turn-completed-plan-buffer"),
          provider: ProviderDriverKind.make("codex"),
          createdAt: now,
          threadId: asThreadId("thread-1"),
          turnId: asTurnId("turn-plan-buffer"),
          payload: {
            state: "completed",
          },
        });

        const thread = yield* waitForThread(harness.readModel, (entry) =>
          entry.proposedPlans.some(
            (proposedPlan: ProviderRuntimeTestProposedPlan) =>
              proposedPlan.id === "plan:thread-1:turn:turn-plan-buffer",
          ),
        );
        const proposedPlan = thread.proposedPlans.find(
          (entry: ProviderRuntimeTestProposedPlan) =>
            entry.id === "plan:thread-1:turn:turn-plan-buffer",
        );
        expect(proposedPlan?.planMarkdown).toBe("## Buffered plan\n\n- first\n- second");
      }),
  );

  it.live("buffers assistant deltas by default until completion", () =>
    Effect.gen(function* () {
      const harness = yield* createHarness();
      const now = "2026-01-01T00:00:00.000Z";

      harness.emit({
        type: "turn.started",
        eventId: asEventId("evt-turn-started-buffered"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: now,
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-buffered"),
      });
      yield* waitForThread(
        harness.readModel,
        (thread) =>
          thread.session?.status === "running" && thread.session?.activeTurnId === "turn-buffered",
      );

      harness.emit({
        type: "content.delta",
        eventId: asEventId("evt-message-delta-buffered"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: now,
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-buffered"),
        itemId: asItemId("item-buffered"),
        payload: {
          streamKind: "assistant_text",
          delta: "buffer me",
        },
      });

      yield* harness.drain();
      const midReadModel = yield* harness.readModel();
      const midThread = midReadModel.threads.find(
        (entry) => entry.id === ThreadId.make("thread-1"),
      );
      expect(
        midThread?.messages.some(
          (message: ProviderRuntimeTestMessage) => message.id === "assistant:item-buffered",
        ),
      ).toBe(false);

      harness.emit({
        type: "item.completed",
        eventId: asEventId("evt-message-completed-buffered"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: now,
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-buffered"),
        itemId: asItemId("item-buffered"),
        payload: {
          itemType: "assistant_message",
          status: "completed",
        },
      });

      const thread = yield* waitForThread(harness.readModel, (entry) =>
        entry.messages.some(
          (message: ProviderRuntimeTestMessage) =>
            message.id === "assistant:item-buffered" && !message.streaming,
        ),
      );
      const message = thread.messages.find(
        (entry: ProviderRuntimeTestMessage) => entry.id === "assistant:item-buffered",
      );
      expect(message?.text).toBe("buffer me");
      expect(message?.streaming).toBe(false);
    }),
  );

  it.live("excludes subagent-tagged deltas from buffered assistant text", () =>
    Effect.gen(function* () {
      const harness = yield* createHarness();
      const now = "2026-01-01T00:00:00.000Z";

      harness.emit({
        type: "turn.started",
        eventId: asEventId("evt-turn-started-buffered-subagent"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: now,
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-buffered-subagent"),
      });
      yield* waitForThread(
        harness.readModel,
        (thread) =>
          thread.session?.status === "running" &&
          thread.session?.activeTurnId === "turn-buffered-subagent",
      );

      harness.emit({
        type: "content.delta",
        eventId: asEventId("evt-message-delta-buffered-parent-before"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: now,
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-buffered-subagent"),
        itemId: asItemId("item-buffered-subagent"),
        payload: {
          streamKind: "assistant_text",
          delta: "Hello",
        },
      });
      harness.emit({
        type: "content.delta",
        eventId: asEventId("evt-message-delta-buffered-subagent"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: now,
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-buffered-subagent"),
        itemId: asItemId("item-buffered-subagent"),
        payload: {
          streamKind: "assistant_text",
          delta: "SUBAGENT",
          parentToolUseId: "toolu_spawn_1",
        },
      });
      harness.emit({
        type: "content.delta",
        eventId: asEventId("evt-message-delta-buffered-parent-after"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: now,
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-buffered-subagent"),
        itemId: asItemId("item-buffered-subagent"),
        payload: {
          streamKind: "assistant_text",
          delta: " world",
        },
      });
      harness.emit({
        type: "item.completed",
        eventId: asEventId("evt-message-completed-buffered-subagent"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: now,
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-buffered-subagent"),
        itemId: asItemId("item-buffered-subagent"),
        payload: {
          itemType: "assistant_message",
          status: "completed",
        },
      });

      const thread = yield* waitForThread(harness.readModel, (entry) =>
        entry.messages.some(
          (message: ProviderRuntimeTestMessage) =>
            message.id === "assistant:item-buffered-subagent" && !message.streaming,
        ),
      );
      const assistantMessages = thread.messages.filter((message: ProviderRuntimeTestMessage) =>
        message.id.startsWith("assistant:"),
      );
      expect(assistantMessages).toHaveLength(1);
      expect(assistantMessages[0]?.text).toBe("Hello world");
    }),
  );

  it.live("does not create an assistant message from only subagent-tagged deltas", () =>
    Effect.gen(function* () {
      const harness = yield* createHarness();
      const now = "2026-01-01T00:00:00.000Z";

      harness.emit({
        type: "turn.started",
        eventId: asEventId("evt-turn-started-only-subagent"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: now,
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-only-subagent"),
      });
      yield* waitForThread(
        harness.readModel,
        (thread) =>
          thread.session?.status === "running" &&
          thread.session?.activeTurnId === "turn-only-subagent",
      );

      harness.emit({
        type: "content.delta",
        eventId: asEventId("evt-message-delta-only-subagent"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: now,
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-only-subagent"),
        itemId: asItemId("item-only-subagent"),
        payload: {
          streamKind: "assistant_text",
          delta: "SUBAGENT",
          parentToolUseId: "toolu_spawn_1",
        },
      });
      harness.emit({
        type: "item.completed",
        eventId: asEventId("evt-message-completed-only-subagent"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: now,
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-only-subagent"),
        itemId: asItemId("item-only-subagent"),
        payload: {
          itemType: "assistant_message",
          status: "completed",
        },
      });
      harness.emit({
        type: "turn.completed",
        eventId: asEventId("evt-turn-completed-only-subagent"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: now,
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-only-subagent"),
        payload: {
          state: "completed",
        },
      });

      const thread = yield* waitForThread(
        harness.readModel,
        (entry) => entry.session?.status === "ready" && entry.session?.activeTurnId === null,
      );
      expect(
        thread.messages.filter((message: ProviderRuntimeTestMessage) =>
          message.id.startsWith("assistant:"),
        ),
      ).toHaveLength(0);
    }),
  );

  it.live("flushes and completes buffered assistant text when an approval request opens", () =>
    Effect.gen(function* () {
      const harness = yield* createHarness();
      const now = "2026-01-01T00:00:00.000Z";

      harness.emit({
        type: "turn.started",
        eventId: asEventId("evt-turn-started-buffered-request-flush"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: now,
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-buffered-request-flush"),
      });
      yield* waitForThread(
        harness.readModel,
        (thread) =>
          thread.session?.status === "running" &&
          thread.session?.activeTurnId === "turn-buffered-request-flush",
      );

      harness.emit({
        type: "content.delta",
        eventId: asEventId("evt-message-delta-buffered-request-flush"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: now,
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-buffered-request-flush"),
        itemId: asItemId("item-buffered-request-flush"),
        payload: {
          streamKind: "assistant_text",
          delta: "visible before approval",
        },
      });
      harness.emit({
        type: "request.opened",
        eventId: asEventId("evt-request-opened-buffered-request-flush"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: now,
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-buffered-request-flush"),
        requestId: ApprovalRequestId.make("req-buffered-request-flush"),
        payload: {
          requestType: "command_execution_approval",
          detail: "pwd",
        },
      });

      const thread = yield* waitForThread(harness.readModel, (entry) =>
        entry.messages.some(
          (message: ProviderRuntimeTestMessage) =>
            message.id === "assistant:item-buffered-request-flush" &&
            !message.streaming &&
            message.text === "visible before approval",
        ),
      );
      const message = thread.messages.find(
        (entry: ProviderRuntimeTestMessage) => entry.id === "assistant:item-buffered-request-flush",
      );
      expect(message?.streaming).toBe(false);
    }),
  );

  it.live("flushes and completes buffered assistant text when user input is requested", () =>
    Effect.gen(function* () {
      const harness = yield* createHarness();
      const now = "2026-01-01T00:00:00.000Z";

      harness.emit({
        type: "turn.started",
        eventId: asEventId("evt-turn-started-buffered-user-input-flush"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: now,
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-buffered-user-input-flush"),
      });
      yield* waitForThread(
        harness.readModel,
        (thread) =>
          thread.session?.status === "running" &&
          thread.session?.activeTurnId === "turn-buffered-user-input-flush",
      );

      harness.emit({
        type: "content.delta",
        eventId: asEventId("evt-message-delta-buffered-user-input-flush"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: now,
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-buffered-user-input-flush"),
        itemId: asItemId("item-buffered-user-input-flush"),
        payload: {
          streamKind: "assistant_text",
          delta: "visible before user input",
        },
      });
      harness.emit({
        type: "user-input.requested",
        eventId: asEventId("evt-user-input-requested-buffered-user-input-flush"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: now,
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-buffered-user-input-flush"),
        requestId: ApprovalRequestId.make("req-buffered-user-input-flush"),
        payload: {
          questions: [
            {
              id: "choice",
              header: "Choice",
              question: "Pick one",
              options: [{ label: "A", description: "Option A" }],
            },
          ],
        },
      });

      const thread = yield* waitForThread(harness.readModel, (entry) =>
        entry.messages.some(
          (message: ProviderRuntimeTestMessage) =>
            message.id === "assistant:item-buffered-user-input-flush" &&
            !message.streaming &&
            message.text === "visible before user input",
        ),
      );
      const message = thread.messages.find(
        (entry: ProviderRuntimeTestMessage) =>
          entry.id === "assistant:item-buffered-user-input-flush",
      );
      expect(message?.streaming).toBe(false);
    }),
  );

  it.live(
    "does not create assistant segments for whitespace-only buffered text at approval boundaries",
    () =>
      Effect.gen(function* () {
        const harness = yield* createHarness();
        const startedAt = "2026-03-28T06:28:00.000Z";
        const pausedAt = "2026-03-28T06:28:01.000Z";

        harness.emit({
          type: "turn.started",
          eventId: asEventId("evt-turn-started-buffered-whitespace-request"),
          provider: ProviderDriverKind.make("codex"),
          createdAt: startedAt,
          threadId: asThreadId("thread-1"),
          turnId: asTurnId("turn-buffered-whitespace-request"),
        });
        yield* waitForThread(
          harness.readModel,
          (thread) =>
            thread.session?.status === "running" &&
            thread.session?.activeTurnId === "turn-buffered-whitespace-request",
        );

        harness.emit({
          type: "content.delta",
          eventId: asEventId("evt-message-delta-buffered-whitespace-request"),
          provider: ProviderDriverKind.make("codex"),
          createdAt: startedAt,
          threadId: asThreadId("thread-1"),
          turnId: asTurnId("turn-buffered-whitespace-request"),
          itemId: asItemId("item-buffered-whitespace-request"),
          payload: {
            streamKind: "assistant_text",
            delta: "\n\n\n",
          },
        });
        harness.emit({
          type: "request.opened",
          eventId: asEventId("evt-request-opened-buffered-whitespace-request"),
          provider: ProviderDriverKind.make("codex"),
          createdAt: pausedAt,
          threadId: asThreadId("thread-1"),
          turnId: asTurnId("turn-buffered-whitespace-request"),
          requestId: ApprovalRequestId.make("req-buffered-whitespace-request"),
          payload: {
            requestType: "command_execution_approval",
            detail: "pwd",
          },
        });

        const thread = yield* waitForThread(harness.readModel, (entry) =>
          entry.activities.some(
            (activity: ProviderRuntimeTestActivity) => activity.kind === "approval.requested",
          ),
        );
        expect(
          thread.messages.some(
            (message: ProviderRuntimeTestMessage) =>
              message.id === "assistant:item-buffered-whitespace-request",
          ),
        ).toBe(false);
      }),
  );

  it.live(
    "starts a new buffered assistant message segment after approval and completes without duplication",
    () =>
      Effect.gen(function* () {
        const harness = yield* createHarness();
        const startedAt = "2026-03-28T06:07:00.000Z";
        const pausedAt = "2026-03-28T06:07:01.000Z";
        const resumedAt = "2026-03-28T06:07:02.000Z";
        const completedAt = "2026-03-28T06:07:03.000Z";

        harness.emit({
          type: "turn.started",
          eventId: asEventId("evt-turn-started-buffered-request-append"),
          provider: ProviderDriverKind.make("codex"),
          createdAt: startedAt,
          threadId: asThreadId("thread-1"),
          turnId: asTurnId("turn-buffered-request-append"),
        });
        yield* waitForThread(
          harness.readModel,
          (thread) =>
            thread.session?.status === "running" &&
            thread.session?.activeTurnId === "turn-buffered-request-append",
        );

        harness.emit({
          type: "content.delta",
          eventId: asEventId("evt-message-delta-buffered-request-append-initial"),
          provider: ProviderDriverKind.make("codex"),
          createdAt: startedAt,
          threadId: asThreadId("thread-1"),
          turnId: asTurnId("turn-buffered-request-append"),
          itemId: asItemId("item-buffered-request-append"),
          payload: {
            streamKind: "assistant_text",
            delta: "first half",
          },
        });
        harness.emit({
          type: "request.opened",
          eventId: asEventId("evt-request-opened-buffered-request-append"),
          provider: ProviderDriverKind.make("codex"),
          createdAt: pausedAt,
          threadId: asThreadId("thread-1"),
          turnId: asTurnId("turn-buffered-request-append"),
          requestId: ApprovalRequestId.make("req-buffered-request-append"),
          payload: {
            requestType: "command_execution_approval",
            detail: "pwd",
          },
        });

        yield* waitForThread(harness.readModel, (entry) =>
          entry.messages.some(
            (message: ProviderRuntimeTestMessage) =>
              message.id === "assistant:item-buffered-request-append" &&
              !message.streaming &&
              message.text === "first half",
          ),
        );

        harness.emit({
          type: "content.delta",
          eventId: asEventId("evt-message-delta-buffered-request-append-followup"),
          provider: ProviderDriverKind.make("codex"),
          createdAt: resumedAt,
          threadId: asThreadId("thread-1"),
          turnId: asTurnId("turn-buffered-request-append"),
          itemId: asItemId("item-buffered-request-append"),
          payload: {
            streamKind: "assistant_text",
            delta: " second half",
          },
        });
        harness.emit({
          type: "item.completed",
          eventId: asEventId("evt-message-completed-buffered-request-append"),
          provider: ProviderDriverKind.make("codex"),
          createdAt: completedAt,
          threadId: asThreadId("thread-1"),
          turnId: asTurnId("turn-buffered-request-append"),
          itemId: asItemId("item-buffered-request-append"),
          payload: {
            itemType: "assistant_message",
            status: "completed",
          },
        });

        const thread = yield* waitForThread(harness.readModel, (entry) =>
          entry.messages.some(
            (message: ProviderRuntimeTestMessage) =>
              message.id === "assistant:item-buffered-request-append:segment:1" &&
              !message.streaming &&
              message.text === " second half",
          ),
        );
        const firstMessage = thread.messages.find(
          (entry: ProviderRuntimeTestMessage) =>
            entry.id === "assistant:item-buffered-request-append",
        );
        const resumedMessage = thread.messages.find(
          (entry: ProviderRuntimeTestMessage) =>
            entry.id === "assistant:item-buffered-request-append:segment:1",
        );
        expect(firstMessage?.text).toBe("first half");
        expect(firstMessage?.streaming).toBe(false);
        expect(resumedMessage?.text).toBe(" second half");
        expect(resumedMessage?.streaming).toBe(false);

        const events = yield* Stream.runCollect(harness.engine.readEvents(0)).pipe(
          Effect.map((chunk) => Array.from(chunk)),
        );
        const assistantEvents = events.filter(
          (event): event is Extract<(typeof events)[number], { type: "thread.message-sent" }> =>
            event.type === "thread.message-sent" &&
            event.payload.messageId.startsWith("assistant:item-buffered-request-append"),
        );
        expect(assistantEvents).toHaveLength(4);
        expect(assistantEvents[0]?.payload.streaming).toBe(true);
        expect(assistantEvents[0]?.payload.text).toBe("first half");
        expect(assistantEvents[1]?.payload.streaming).toBe(false);
        expect(assistantEvents[1]?.payload.text).toBe("");
        expect(assistantEvents[2]?.payload.messageId).toBe(
          "assistant:item-buffered-request-append:segment:1",
        );
        expect(assistantEvents[2]?.payload.streaming).toBe(true);
        expect(assistantEvents[2]?.payload.text).toBe(" second half");
        expect(assistantEvents[3]?.payload.messageId).toBe(
          "assistant:item-buffered-request-append:segment:1",
        );
        expect(assistantEvents[3]?.payload.streaming).toBe(false);
        expect(assistantEvents[3]?.payload.text).toBe("");
      }),
  );

  it.live("starts a new streaming assistant message segment after approval", () =>
    Effect.gen(function* () {
      const harness = yield* createHarness({ serverSettings: { enableAssistantStreaming: true } });
      const startedAt = "2026-03-28T07:00:00.000Z";
      const pausedAt = "2026-03-28T07:00:01.000Z";
      const resumedAt = "2026-03-28T07:00:02.000Z";
      const completedAt = "2026-03-28T07:00:03.000Z";

      harness.emit({
        type: "turn.started",
        eventId: asEventId("evt-turn-started-streaming-request-segment"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: startedAt,
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-streaming-request-segment"),
      });
      yield* waitForThread(
        harness.readModel,
        (thread) =>
          thread.session?.status === "running" &&
          thread.session?.activeTurnId === "turn-streaming-request-segment",
      );

      harness.emit({
        type: "content.delta",
        eventId: asEventId("evt-message-delta-streaming-request-segment-initial"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: startedAt,
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-streaming-request-segment"),
        itemId: asItemId("item-streaming-request-segment"),
        payload: {
          streamKind: "assistant_text",
          delta: "before approval",
        },
      });
      harness.emit({
        type: "request.opened",
        eventId: asEventId("evt-request-opened-streaming-request-segment"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: pausedAt,
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-streaming-request-segment"),
        requestId: ApprovalRequestId.make("req-streaming-request-segment"),
        payload: {
          requestType: "command_execution_approval",
          detail: "pwd",
        },
      });

      yield* waitForThread(harness.readModel, (entry) =>
        entry.messages.some(
          (message: ProviderRuntimeTestMessage) =>
            message.id === "assistant:item-streaming-request-segment" &&
            !message.streaming &&
            message.text === "before approval",
        ),
      );

      harness.emit({
        type: "content.delta",
        eventId: asEventId("evt-message-delta-streaming-request-segment-followup"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: resumedAt,
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-streaming-request-segment"),
        itemId: asItemId("item-streaming-request-segment"),
        payload: {
          streamKind: "assistant_text",
          delta: " after approval",
        },
      });
      harness.emit({
        type: "item.completed",
        eventId: asEventId("evt-message-completed-streaming-request-segment"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: completedAt,
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-streaming-request-segment"),
        itemId: asItemId("item-streaming-request-segment"),
        payload: {
          itemType: "assistant_message",
          status: "completed",
        },
      });

      const thread = yield* waitForThread(harness.readModel, (entry) =>
        entry.messages.some(
          (message: ProviderRuntimeTestMessage) =>
            message.id === "assistant:item-streaming-request-segment:segment:1" &&
            !message.streaming &&
            message.text === " after approval",
        ),
      );
      expect(
        thread.messages.find(
          (message: ProviderRuntimeTestMessage) =>
            message.id === "assistant:item-streaming-request-segment",
        )?.text,
      ).toBe("before approval");
      expect(
        thread.messages.find(
          (message: ProviderRuntimeTestMessage) =>
            message.id === "assistant:item-streaming-request-segment:segment:1",
        )?.text,
      ).toBe(" after approval");
    }),
  );

  it.live("streams assistant deltas when thread.turn.start requests streaming mode", () =>
    Effect.gen(function* () {
      const harness = yield* createHarness({ serverSettings: { enableAssistantStreaming: true } });
      const now = "2026-01-01T00:00:00.000Z";

      yield* dispatch(harness.engine, {
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-streaming-mode"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("message-streaming-mode"),
          role: "user",
          text: "stream please",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      });
      yield* harness.drain();

      harness.emit({
        type: "turn.started",
        eventId: asEventId("evt-turn-started-streaming-mode"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: now,
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-streaming-mode"),
      });
      yield* waitForThread(
        harness.readModel,
        (thread) =>
          thread.session?.status === "running" &&
          thread.session?.activeTurnId === "turn-streaming-mode",
      );

      harness.emit({
        type: "content.delta",
        eventId: asEventId("evt-message-delta-streaming-mode"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: now,
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-streaming-mode"),
        itemId: asItemId("item-streaming-mode"),
        payload: {
          streamKind: "assistant_text",
          delta: "hello live",
        },
      });

      const liveThread = yield* waitForThread(harness.readModel, (entry) =>
        entry.messages.some(
          (message: ProviderRuntimeTestMessage) =>
            message.id === "assistant:item-streaming-mode" &&
            message.streaming &&
            message.text === "hello live",
        ),
      );
      const liveMessage = liveThread.messages.find(
        (entry: ProviderRuntimeTestMessage) => entry.id === "assistant:item-streaming-mode",
      );
      expect(liveMessage?.streaming).toBe(true);

      harness.emit({
        type: "item.completed",
        eventId: asEventId("evt-message-completed-streaming-mode"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: now,
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-streaming-mode"),
        itemId: asItemId("item-streaming-mode"),
        payload: {
          itemType: "assistant_message",
          status: "completed",
          detail: "hello live",
        },
      });

      const finalThread = yield* waitForThread(harness.readModel, (entry) =>
        entry.messages.some(
          (message: ProviderRuntimeTestMessage) =>
            message.id === "assistant:item-streaming-mode" && !message.streaming,
        ),
      );
      const finalMessage = finalThread.messages.find(
        (entry: ProviderRuntimeTestMessage) => entry.id === "assistant:item-streaming-mode",
      );
      expect(finalMessage?.text).toBe("hello live");
      expect(finalMessage?.streaming).toBe(false);
    }),
  );

  it.live("excludes subagent-tagged deltas from streaming assistant text", () =>
    Effect.gen(function* () {
      const harness = yield* createHarness({ serverSettings: { enableAssistantStreaming: true } });
      const now = "2026-01-01T00:00:00.000Z";

      harness.emit({
        type: "turn.started",
        eventId: asEventId("evt-turn-started-streaming-subagent"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: now,
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-streaming-subagent"),
      });
      yield* waitForThread(
        harness.readModel,
        (thread) =>
          thread.session?.status === "running" &&
          thread.session?.activeTurnId === "turn-streaming-subagent",
      );

      harness.emit({
        type: "content.delta",
        eventId: asEventId("evt-message-delta-streaming-parent-before"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: now,
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-streaming-subagent"),
        itemId: asItemId("item-streaming-subagent"),
        payload: {
          streamKind: "assistant_text",
          delta: "Hello",
        },
      });
      harness.emit({
        type: "content.delta",
        eventId: asEventId("evt-message-delta-streaming-subagent"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: now,
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-streaming-subagent"),
        itemId: asItemId("item-streaming-subagent"),
        payload: {
          streamKind: "assistant_text",
          delta: "SUBAGENT",
          parentToolUseId: "toolu_spawn_1",
        },
      });
      harness.emit({
        type: "content.delta",
        eventId: asEventId("evt-message-delta-streaming-parent-after"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: now,
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-streaming-subagent"),
        itemId: asItemId("item-streaming-subagent"),
        payload: {
          streamKind: "assistant_text",
          delta: " world",
        },
      });
      harness.emit({
        type: "item.completed",
        eventId: asEventId("evt-message-completed-streaming-subagent"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: now,
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-streaming-subagent"),
        itemId: asItemId("item-streaming-subagent"),
        payload: {
          itemType: "assistant_message",
          status: "completed",
        },
      });

      const thread = yield* waitForThread(harness.readModel, (entry) =>
        entry.messages.some(
          (message: ProviderRuntimeTestMessage) =>
            message.id === "assistant:item-streaming-subagent" && !message.streaming,
        ),
      );
      const assistantMessages = thread.messages.filter((message: ProviderRuntimeTestMessage) =>
        message.id.startsWith("assistant:"),
      );
      expect(assistantMessages).toHaveLength(1);
      expect(assistantMessages[0]?.text).toBe("Hello world");
    }),
  );

  it.live("spills oversized buffered deltas and still finalizes full assistant text", () =>
    Effect.gen(function* () {
      const harness = yield* createHarness();
      const now = "2026-01-01T00:00:00.000Z";
      const oversizedText = "x".repeat(40_000);

      harness.emit({
        type: "turn.started",
        eventId: asEventId("evt-turn-started-buffer-spill"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: now,
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-buffer-spill"),
      });
      yield* waitForThread(
        harness.readModel,
        (thread) =>
          thread.session?.status === "running" &&
          thread.session?.activeTurnId === "turn-buffer-spill",
      );

      harness.emit({
        type: "content.delta",
        eventId: asEventId("evt-message-delta-buffer-spill"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: now,
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-buffer-spill"),
        itemId: asItemId("item-buffer-spill"),
        payload: {
          streamKind: "assistant_text",
          delta: oversizedText,
        },
      });
      harness.emit({
        type: "item.completed",
        eventId: asEventId("evt-message-completed-buffer-spill"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: now,
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-buffer-spill"),
        itemId: asItemId("item-buffer-spill"),
        payload: {
          itemType: "assistant_message",
          status: "completed",
        },
      });

      const thread = yield* waitForThread(harness.readModel, (entry) =>
        entry.messages.some(
          (message: ProviderRuntimeTestMessage) =>
            message.id === "assistant:item-buffer-spill" && !message.streaming,
        ),
      );
      const message = thread.messages.find(
        (entry: ProviderRuntimeTestMessage) => entry.id === "assistant:item-buffer-spill",
      );
      expect(message?.text.length).toBe(oversizedText.length);
      expect(message?.text).toBe(oversizedText);
      expect(message?.streaming).toBe(false);
    }),
  );

  it.live(
    "does not duplicate assistant completion when item.completed is followed by turn.completed",
    () =>
      Effect.gen(function* () {
        const harness = yield* createHarness();
        const now = "2026-01-01T00:00:00.000Z";

        harness.emit({
          type: "turn.started",
          eventId: asEventId("evt-turn-started-for-complete-dedup"),
          provider: ProviderDriverKind.make("codex"),
          createdAt: now,
          threadId: asThreadId("thread-1"),
          turnId: asTurnId("turn-complete-dedup"),
        });

        yield* waitForThread(
          harness.readModel,
          (thread) =>
            thread.session?.status === "running" &&
            thread.session?.activeTurnId === "turn-complete-dedup",
        );

        harness.emit({
          type: "content.delta",
          eventId: asEventId("evt-message-delta-for-complete-dedup"),
          provider: ProviderDriverKind.make("codex"),
          createdAt: now,
          threadId: asThreadId("thread-1"),
          turnId: asTurnId("turn-complete-dedup"),
          itemId: asItemId("item-complete-dedup"),
          payload: {
            streamKind: "assistant_text",
            delta: "done",
          },
        });
        harness.emit({
          type: "item.completed",
          eventId: asEventId("evt-message-completed-for-complete-dedup"),
          provider: ProviderDriverKind.make("codex"),
          createdAt: now,
          threadId: asThreadId("thread-1"),
          turnId: asTurnId("turn-complete-dedup"),
          itemId: asItemId("item-complete-dedup"),
          payload: {
            itemType: "assistant_message",
            status: "completed",
          },
        });
        harness.emit({
          type: "turn.completed",
          eventId: asEventId("evt-turn-completed-for-complete-dedup"),
          provider: ProviderDriverKind.make("codex"),
          createdAt: now,
          threadId: asThreadId("thread-1"),
          turnId: asTurnId("turn-complete-dedup"),
          payload: {
            state: "completed",
          },
        });

        yield* waitForThread(
          harness.readModel,
          (thread) =>
            thread.session?.status === "ready" &&
            thread.session?.activeTurnId === null &&
            thread.messages.some(
              (message: ProviderRuntimeTestMessage) =>
                message.id === "assistant:item-complete-dedup" && !message.streaming,
            ),
        );

        const events = yield* Stream.runCollect(harness.engine.readEvents(0)).pipe(
          Effect.map((chunk) => Array.from(chunk)),
        );
        const completionEvents = events.filter((event) => {
          if (event.type !== "thread.message-sent") {
            return false;
          }
          return (
            event.payload.messageId === "assistant:item-complete-dedup" &&
            event.payload.streaming === false
          );
        });
        expect(completionEvents).toHaveLength(1);
      }),
  );

  it.live("maps canonical request events into approval activities with requestKind", () =>
    Effect.gen(function* () {
      const harness = yield* createHarness();
      const now = "2026-01-01T00:00:00.000Z";

      harness.emit({
        type: "request.opened",
        eventId: asEventId("evt-request-opened"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: now,
        threadId: asThreadId("thread-1"),
        requestId: ApprovalRequestId.make("req-open"),
        payload: {
          requestType: "command_execution_approval",
          detail: "pwd",
        },
      });

      harness.emit({
        type: "request.resolved",
        eventId: asEventId("evt-request-resolved"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: now,
        threadId: asThreadId("thread-1"),
        requestId: ApprovalRequestId.make("req-open"),
        payload: {
          requestType: "command_execution_approval",
          decision: "accept",
        },
      });

      yield* waitForThread(
        harness.readModel,
        (entry) =>
          entry.activities.some(
            (activity: ProviderRuntimeTestActivity) => activity.kind === "approval.requested",
          ) &&
          entry.activities.some(
            (activity: ProviderRuntimeTestActivity) => activity.kind === "approval.resolved",
          ),
      );

      const readModel = yield* harness.readModel();
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      expect(thread).toBeDefined();

      const requested = thread?.activities.find(
        (activity: ProviderRuntimeTestActivity) => activity.id === "evt-request-opened",
      );
      const requestedPayload =
        requested?.payload && typeof requested.payload === "object"
          ? (requested.payload as Record<string, unknown>)
          : undefined;
      expect(requestedPayload?.requestKind).toBe("command");
      expect(requestedPayload?.requestType).toBe("command_execution_approval");

      const resolved = thread?.activities.find(
        (activity: ProviderRuntimeTestActivity) => activity.id === "evt-request-resolved",
      );
      const resolvedPayload =
        resolved?.payload && typeof resolved.payload === "object"
          ? (resolved.payload as Record<string, unknown>)
          : undefined;
      expect(resolvedPayload?.requestKind).toBe("command");
      expect(resolvedPayload?.requestType).toBe("command_execution_approval");
    }),
  );

  it.live("maps runtime.error into errored session state", () =>
    Effect.gen(function* () {
      const harness = yield* createHarness();
      const now = "2026-01-01T00:00:00.000Z";

      harness.emit({
        type: "runtime.error",
        eventId: asEventId("evt-runtime-error"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: now,
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-3"),
        payload: {
          message: "runtime exploded",
        },
      });

      const thread = yield* waitForThread(
        harness.readModel,
        (entry) =>
          entry.session?.status === "error" &&
          entry.session?.activeTurnId === "turn-3" &&
          entry.session?.lastError === "runtime exploded",
      );
      expect(thread.session?.status).toBe("error");
      expect(thread.session?.lastError).toBe("runtime exploded");
    }),
  );

  it.live("records runtime.error activities from the typed payload message", () =>
    Effect.gen(function* () {
      const harness = yield* createHarness();
      const now = "2026-01-01T00:00:00.000Z";

      harness.emit({
        type: "runtime.error",
        eventId: asEventId("evt-runtime-error-activity"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: now,
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-runtime-error-activity"),
        payload: {
          message: "runtime activity exploded",
        },
      });

      const thread = yield* waitForThread(harness.readModel, (entry) =>
        entry.activities.some((activity) => activity.id === "evt-runtime-error-activity"),
      );
      const activity = thread.activities.find(
        (entry: ProviderRuntimeTestActivity) => entry.id === "evt-runtime-error-activity",
      );
      const activityPayload =
        activity?.payload && typeof activity.payload === "object"
          ? (activity.payload as Record<string, unknown>)
          : undefined;

      expect(activity?.kind).toBe("runtime.error");
      expect(activityPayload?.message).toBe("runtime activity exploded");
    }),
  );

  it.live("keeps the session running when a runtime.warning arrives during an active turn", () =>
    Effect.gen(function* () {
      const harness = yield* createHarness();
      const now = "2026-01-01T00:00:00.000Z";

      harness.emit({
        type: "turn.started",
        eventId: asEventId("evt-warning-turn-started"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: now,
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-warning"),
        payload: {},
      });

      harness.emit({
        type: "runtime.warning",
        eventId: asEventId("evt-warning-runtime"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: now,
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-warning"),
        payload: {
          message: "Reconnecting... 2/5",
          detail: {
            willRetry: true,
          },
        },
      });

      const thread = yield* waitForThread(
        harness.readModel,
        (entry) =>
          entry.session?.status === "running" &&
          entry.session?.activeTurnId === "turn-warning" &&
          entry.activities.some(
            (activity: ProviderRuntimeTestActivity) =>
              activity.id === "evt-warning-runtime" && activity.kind === "runtime.warning",
          ),
      );
      expect(thread.session?.status).toBe("running");
      expect(thread.session?.activeTurnId).toBe("turn-warning");
      expect(thread.session?.lastError).toBeNull();
    }),
  );

  it.live("maps session/thread lifecycle and item.started into session/activity projections", () =>
    Effect.gen(function* () {
      const harness = yield* createHarness();
      const now = "2026-01-01T00:00:00.000Z";

      harness.emit({
        type: "session.started",
        eventId: asEventId("evt-session-started"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: now,
        threadId: asThreadId("thread-1"),
        message: "session started",
      });
      harness.emit({
        type: "thread.started",
        eventId: asEventId("evt-thread-started"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: now,
        threadId: asThreadId("thread-1"),
      });
      harness.emit({
        type: "item.started",
        eventId: asEventId("evt-tool-started"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: now,
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-9"),
        payload: {
          itemType: "command_execution",
          status: "in_progress",
          title: "Read file",
          detail: "/tmp/file.ts",
        },
      });

      const thread = yield* waitForThread(
        harness.readModel,
        (entry) =>
          entry.session?.status === "ready" &&
          entry.session?.activeTurnId === null &&
          entry.activities.some(
            (activity: ProviderRuntimeTestActivity) => activity.kind === "tool.started",
          ),
      );

      expect(thread.session?.status).toBe("ready");
      expect(
        thread.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "tool.started",
        ),
      ).toBe(true);
    }),
  );

  it.live("consumes P1 runtime events into thread metadata, diff checkpoints, and activities", () =>
    Effect.gen(function* () {
      const harness = yield* createHarness();
      const now = "2026-01-01T00:00:00.000Z";

      harness.emit({
        type: "thread.metadata.updated",
        eventId: asEventId("evt-thread-metadata-updated"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: now,
        threadId: asThreadId("thread-1"),
        payload: {
          name: "Renamed by provider",
          metadata: { source: "provider" },
        },
      });

      harness.emit({
        type: "turn.plan.updated",
        eventId: asEventId("evt-turn-plan-updated"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: now,
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-p1"),
        payload: {
          explanation: "Working through the plan",
          plan: [
            { step: "Inspect files", status: "completed" },
            { step: "Apply patch", status: "in_progress" },
          ],
        },
      });

      harness.emit({
        type: "item.updated",
        eventId: asEventId("evt-item-updated"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: now,
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-p1"),
        itemId: asItemId("item-p1-tool"),
        payload: {
          itemType: "command_execution",
          status: "in_progress",
          title: "Run tests",
          detail: "bun test",
          data: { pid: 123 },
        },
      });

      harness.emit({
        type: "runtime.warning",
        eventId: asEventId("evt-runtime-warning"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: now,
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-p1"),
        payload: {
          message: "Provider got slow",
          detail: { latencyMs: 1500 },
        },
      });

      harness.emit({
        type: "turn.diff.updated",
        eventId: asEventId("evt-turn-diff-updated"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: now,
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-p1"),
        itemId: asItemId("item-p1-assistant"),
        payload: {
          unifiedDiff: "diff --git a/file.txt b/file.txt\n+hello\n",
        },
      });

      const thread = yield* waitForThread(
        harness.readModel,
        (entry) =>
          entry.title === "Renamed by provider" &&
          entry.activities.some(
            (activity: ProviderRuntimeTestActivity) => activity.kind === "turn.plan.updated",
          ) &&
          entry.activities.some(
            (activity: ProviderRuntimeTestActivity) => activity.kind === "tool.updated",
          ) &&
          entry.activities.some(
            (activity: ProviderRuntimeTestActivity) => activity.kind === "runtime.warning",
          ) &&
          entry.checkpoints.some(
            (checkpoint: ProviderRuntimeTestCheckpoint) => checkpoint.turnId === "turn-p1",
          ),
      );

      expect(thread.title).toBe("Renamed by provider");

      const planActivity = thread.activities.find(
        (activity: ProviderRuntimeTestActivity) => activity.id === "evt-turn-plan-updated",
      );
      const planPayload =
        planActivity?.payload && typeof planActivity.payload === "object"
          ? (planActivity.payload as Record<string, unknown>)
          : undefined;
      expect(planActivity?.kind).toBe("turn.plan.updated");
      expect(Array.isArray(planPayload?.plan)).toBe(true);

      // item.updated's activity id is derived from (threadId, itemId), not
      // eventId -- see runtimeEventToActivities's "item.updated" case -- so the
      // streamed chunks of one tool call collapse to a single upserted row.
      const toolUpdate = thread.activities.find(
        (activity: ProviderRuntimeTestActivity) =>
          activity.id === "tool-updated:thread-1:item-p1-tool",
      );
      const toolUpdatePayload =
        toolUpdate?.payload && typeof toolUpdate.payload === "object"
          ? (toolUpdate.payload as Record<string, unknown>)
          : undefined;
      expect(toolUpdate?.kind).toBe("tool.updated");
      expect(toolUpdatePayload?.itemType).toBe("command_execution");
      expect(toolUpdatePayload?.status).toBe("in_progress");

      const warning = thread.activities.find(
        (activity: ProviderRuntimeTestActivity) => activity.id === "evt-runtime-warning",
      );
      const warningPayload =
        warning?.payload && typeof warning.payload === "object"
          ? (warning.payload as Record<string, unknown>)
          : undefined;
      expect(warning?.kind).toBe("runtime.warning");
      expect(warningPayload?.message).toBe("Provider got slow");

      const checkpoint = thread.checkpoints.find(
        (entry: ProviderRuntimeTestCheckpoint) => entry.turnId === "turn-p1",
      );
      expect(checkpoint?.status).toBe("missing");
      expect(checkpoint?.assistantMessageId).toBe("assistant:item-p1-assistant");
      expect(checkpoint?.checkpointRef).toBe("provider-diff:evt-turn-diff-updated");
    }),
  );

  it.live("projects context window updates into normalized thread activities", () =>
    Effect.gen(function* () {
      const harness = yield* createHarness();
      const now = "2026-01-01T00:00:00.000Z";

      harness.emit({
        type: "thread.token-usage.updated",
        eventId: asEventId("evt-thread-token-usage-updated"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: now,
        threadId: asThreadId("thread-1"),
        payload: {
          usage: {
            usedTokens: 1075,
            totalProcessedTokens: 10_200,
            maxTokens: 128_000,
            inputTokens: 1000,
            cachedInputTokens: 500,
            outputTokens: 50,
            reasoningOutputTokens: 25,
            lastUsedTokens: 1075,
            lastInputTokens: 1000,
            lastCachedInputTokens: 500,
            lastOutputTokens: 50,
            lastReasoningOutputTokens: 25,
            compactsAutomatically: true,
          },
        },
      });

      const thread = yield* waitForThread(harness.readModel, (entry) =>
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "context-window.updated",
        ),
      );

      const usageActivity = thread.activities.find(
        (activity: ProviderRuntimeTestActivity) => activity.kind === "context-window.updated",
      );
      expect(usageActivity).toBeDefined();
      expect(usageActivity?.payload).toMatchObject({
        usedTokens: 1075,
        totalProcessedTokens: 10_200,
        maxTokens: 128_000,
        inputTokens: 1000,
        cachedInputTokens: 500,
        outputTokens: 50,
        reasoningOutputTokens: 25,
        lastUsedTokens: 1075,
        compactsAutomatically: true,
      });
    }),
  );

  it.live("projects Codex camelCase token usage payloads into normalized thread activities", () =>
    Effect.gen(function* () {
      const harness = yield* createHarness();
      const now = "2026-01-01T00:00:00.000Z";

      harness.emit({
        type: "thread.token-usage.updated",
        eventId: asEventId("evt-thread-token-usage-updated-camel"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: now,
        threadId: asThreadId("thread-1"),
        payload: {
          usage: {
            usedTokens: 126,
            totalProcessedTokens: 11_839,
            maxTokens: 258_400,
            inputTokens: 120,
            cachedInputTokens: 0,
            outputTokens: 6,
            reasoningOutputTokens: 0,
            lastUsedTokens: 126,
            lastInputTokens: 120,
            lastCachedInputTokens: 0,
            lastOutputTokens: 6,
            lastReasoningOutputTokens: 0,
            compactsAutomatically: true,
          },
        },
      });

      const thread = yield* waitForThread(harness.readModel, (entry) =>
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "context-window.updated",
        ),
      );

      const usageActivity = thread.activities.find(
        (activity: ProviderRuntimeTestActivity) => activity.kind === "context-window.updated",
      );
      expect(usageActivity?.payload).toMatchObject({
        usedTokens: 126,
        totalProcessedTokens: 11_839,
        maxTokens: 258_400,
        inputTokens: 120,
        cachedInputTokens: 0,
        outputTokens: 6,
        reasoningOutputTokens: 0,
        lastUsedTokens: 126,
        lastInputTokens: 120,
        lastOutputTokens: 6,
        compactsAutomatically: true,
      });
    }),
  );

  it.live(
    "projects Claude usage snapshots with context window into normalized thread activities",
    () =>
      Effect.gen(function* () {
        const harness = yield* createHarness();
        const now = "2026-01-01T00:00:00.000Z";

        harness.emit({
          type: "thread.token-usage.updated",
          eventId: asEventId("evt-thread-token-usage-updated-claude-window"),
          provider: ProviderDriverKind.make("claudeAgent"),
          createdAt: now,
          threadId: asThreadId("thread-1"),
          payload: {
            usage: {
              usedTokens: 31_251,
              lastUsedTokens: 31_251,
              maxTokens: 200_000,
              toolUses: 25,
              durationMs: 43_567,
            },
          },
          raw: {
            source: "claude.sdk.message",
            method: "claude/result/success",
            payload: {},
          },
        });

        const thread = yield* waitForThread(harness.readModel, (entry) =>
          entry.activities.some(
            (activity: ProviderRuntimeTestActivity) => activity.kind === "context-window.updated",
          ),
        );

        const usageActivity = thread.activities.find(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "context-window.updated",
        );
        expect(usageActivity?.payload).toMatchObject({
          usedTokens: 31_251,
          lastUsedTokens: 31_251,
          maxTokens: 200_000,
          toolUses: 25,
          durationMs: 43_567,
        });
      }),
  );

  it.live("projects compacted thread state into context compaction activities", () =>
    Effect.gen(function* () {
      const harness = yield* createHarness();
      const now = "2026-01-01T00:00:00.000Z";

      harness.emit({
        type: "thread.state.changed",
        eventId: asEventId("evt-thread-compacted"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: now,
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        payload: {
          state: "compacted",
          detail: { source: "provider" },
        },
      });

      const thread = yield* waitForThread(harness.readModel, (entry) =>
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "context-compaction",
        ),
      );

      const activity = thread.activities.find(
        (candidate: ProviderRuntimeTestActivity) => candidate.kind === "context-compaction",
      );
      expect(activity?.summary).toBe("Context compacted");
      expect(activity?.tone).toBe("info");
    }),
  );

  it.live("projects Codex task lifecycle chunks into thread activities", () =>
    Effect.gen(function* () {
      const harness = yield* createHarness();
      const now = "2026-01-01T00:00:00.000Z";

      harness.emit({
        type: "task.started",
        eventId: asEventId("evt-task-started"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: now,
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-task-1"),
        payload: {
          taskId: "turn-task-1",
          taskType: "plan",
        },
      });

      harness.emit({
        type: "task.progress",
        eventId: asEventId("evt-task-progress"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: now,
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-task-1"),
        payload: {
          taskId: "turn-task-1",
          description: "Comparing the desktop rollout chunks to the app-server stream.",
          summary: "Code reviewer is validating the desktop rollout chunks.",
        },
      });

      harness.emit({
        type: "task.completed",
        eventId: asEventId("evt-task-completed"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: now,
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-task-1"),
        payload: {
          taskId: "turn-task-1",
          status: "completed",
          summary: "<proposed_plan>\n# Plan title\n</proposed_plan>",
        },
      });
      harness.emit({
        type: "turn.proposed.completed",
        eventId: asEventId("evt-task-proposed-plan-completed"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: now,
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-task-1"),
        payload: {
          planMarkdown: "# Plan title",
        },
      });

      const thread = yield* waitForThread(
        harness.readModel,
        (entry) =>
          entry.activities.some(
            (activity: ProviderRuntimeTestActivity) => activity.kind === "task.completed",
          ) &&
          entry.proposedPlans.some(
            (proposedPlan: ProviderRuntimeTestProposedPlan) =>
              proposedPlan.id === "plan:thread-1:turn:turn-task-1",
          ),
      );

      const started = thread.activities.find(
        (activity: ProviderRuntimeTestActivity) => activity.id === "evt-task-started",
      );
      // task.progress activities coalesce onto a stable per-task id (not the
      // eventId) so a chatty task upserts one row -- see runtimeEventToActivities.
      const progress = thread.activities.find(
        (activity: ProviderRuntimeTestActivity) =>
          activity.id === "task-progress:thread-1:turn-task-1",
      );
      const completed = thread.activities.find(
        (activity: ProviderRuntimeTestActivity) => activity.id === "evt-task-completed",
      );

      const progressPayload =
        progress?.payload && typeof progress.payload === "object"
          ? (progress.payload as Record<string, unknown>)
          : undefined;
      const completedPayload =
        completed?.payload && typeof completed.payload === "object"
          ? (completed.payload as Record<string, unknown>)
          : undefined;

      expect(started?.kind).toBe("task.started");
      expect(started?.summary).toBe("Plan task started");
      expect(progress?.kind).toBe("task.progress");
      expect(progressPayload?.detail).toBe(
        "Code reviewer is validating the desktop rollout chunks.",
      );
      expect(progressPayload?.summary).toBe(
        "Code reviewer is validating the desktop rollout chunks.",
      );
      expect(completed?.kind).toBe("task.completed");
      expect(completedPayload?.detail).toBe("<proposed_plan>\n# Plan title\n</proposed_plan>");
      expect(
        thread.proposedPlans.find(
          (entry: ProviderRuntimeTestProposedPlan) => entry.id === "plan:thread-1:turn:turn-task-1",
        )?.planMarkdown,
      ).toBe("# Plan title");
    }),
  );

  it.live("keeps a background Bash task out of the subagent read model", () =>
    Effect.gen(function* () {
      const harness = yield* createHarness();
      const now = "2026-01-01T00:00:00.000Z";

      // One prompt that launches a Task subagent while a Bash command runs in
      // the background: the SDK reports both over task.started, and only the
      // subagent belongs in the roster.
      harness.emit({
        type: "task.started",
        eventId: asEventId("evt-bash-task-started"),
        provider: ProviderDriverKind.make("claudeAgent"),
        createdAt: now,
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-mixed-tasks"),
        payload: {
          taskId: "bredvmy3q",
          description: "Sleep 120 seconds then echo, in background",
          taskType: "local_bash",
        },
      });

      harness.emit({
        type: "task.started",
        eventId: asEventId("evt-agent-task-started"),
        provider: ProviderDriverKind.make("claudeAgent"),
        createdAt: now,
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-mixed-tasks"),
        payload: {
          taskId: "add5dd01c5351a641",
          description: "Run sleep command",
          taskType: "local_agent",
          subagentType: "general-purpose",
        },
      });

      // The wire completion carries no task kind; ingestion copies it forward
      // from task.started so the fold can still reject the Bash task.
      harness.emit({
        type: "task.completed",
        eventId: asEventId("evt-bash-task-completed"),
        provider: ProviderDriverKind.make("claudeAgent"),
        createdAt: now,
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-mixed-tasks"),
        payload: {
          taskId: "bredvmy3q",
          status: "completed",
          summary: "finished",
        },
      });

      const thread = yield* waitForThread(harness.readModel, (entry) =>
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.id === "evt-bash-task-completed",
        ),
      );

      expect(thread.subagents.map((subagent) => subagent.subagentId)).toEqual([
        "add5dd01c5351a641",
      ]);
      expect(thread.subagents[0]?.agentType).toBe("general-purpose");

      // The work log still carries the Bash task; only the roster rejects it.
      const completed = thread.activities.find(
        (activity: ProviderRuntimeTestActivity) => activity.id === "evt-bash-task-completed",
      );
      const completedPayload =
        completed?.payload && typeof completed.payload === "object"
          ? (completed.payload as Record<string, unknown>)
          : undefined;
      expect(completedPayload?.taskType).toBe("local_bash");
      expect(completedPayload?.title).toBe("Sleep 120 seconds then echo, in background");
    }),
  );

  it.live("titles task activities with the task description, including on completion", () =>
    Effect.gen(function* () {
      const harness = yield* createHarness();
      const now = "2026-01-01T00:00:00.000Z";

      harness.emit({
        type: "task.started",
        eventId: asEventId("evt-named-task-started"),
        provider: ProviderDriverKind.make("claudeAgent"),
        createdAt: now,
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-named-task"),
        payload: {
          taskId: "named-task-1",
          description: "Typecheck mobile app",
          taskType: "local_bash",
        },
      });

      harness.emit({
        type: "task.progress",
        eventId: asEventId("evt-named-task-progress"),
        provider: ProviderDriverKind.make("claudeAgent"),
        createdAt: now,
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-named-task"),
        payload: {
          taskId: "named-task-1",
          description: "Typecheck mobile app",
          summary: "Running tsc across the mobile workspace.",
        },
      });

      harness.emit({
        type: "task.completed",
        eventId: asEventId("evt-named-task-completed"),
        provider: ProviderDriverKind.make("claudeAgent"),
        createdAt: now,
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-named-task"),
        payload: {
          taskId: "named-task-1",
          status: "completed",
          summary: "Typecheck finished without errors.",
        },
      });

      const thread = yield* waitForThread(harness.readModel, (entry) =>
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.id === "evt-named-task-completed",
        ),
      );

      const progress = thread.activities.find(
        (activity: ProviderRuntimeTestActivity) =>
          activity.id === "task-progress:thread-1:named-task-1",
      );
      const completed = thread.activities.find(
        (activity: ProviderRuntimeTestActivity) => activity.id === "evt-named-task-completed",
      );

      const progressPayload =
        progress?.payload && typeof progress.payload === "object"
          ? (progress.payload as Record<string, unknown>)
          : undefined;
      const completedPayload =
        completed?.payload && typeof completed.payload === "object"
          ? (completed.payload as Record<string, unknown>)
          : undefined;

      expect(progress?.summary).toBe("Typecheck mobile app");
      expect(progressPayload?.title).toBe("Typecheck mobile app");
      expect(completed?.summary).toBe("Task completed");
      expect(completedPayload?.title).toBe("Typecheck mobile app");
      expect(completedPayload?.summary).toBe("Typecheck finished without errors.");
      expect(completedPayload?.detail).toBe("Typecheck finished without errors.");
    }),
  );

  it.live("titles task completion from task.started when no progress event carried the name", () =>
    Effect.gen(function* () {
      const harness = yield* createHarness();
      const now = "2026-01-01T00:00:00.000Z";

      harness.emit({
        type: "task.started",
        eventId: asEventId("evt-fast-task-started"),
        provider: ProviderDriverKind.make("claudeAgent"),
        createdAt: now,
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-fast-task"),
        payload: {
          taskId: "fast-task-1",
          description: "wait for codex review to finish",
          taskType: "local_bash",
        },
      });

      harness.emit({
        type: "task.completed",
        eventId: asEventId("evt-fast-task-completed"),
        provider: ProviderDriverKind.make("claudeAgent"),
        createdAt: now,
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-fast-task"),
        payload: {
          taskId: "fast-task-1",
          status: "completed",
        },
      });

      const thread = yield* waitForThread(harness.readModel, (entry) =>
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.id === "evt-fast-task-completed",
        ),
      );

      const completed = thread.activities.find(
        (activity: ProviderRuntimeTestActivity) => activity.id === "evt-fast-task-completed",
      );
      const completedPayload =
        completed?.payload && typeof completed.payload === "object"
          ? (completed.payload as Record<string, unknown>)
          : undefined;

      expect(completedPayload?.title).toBe("wait for codex review to finish");
    }),
  );

  it.live(
    "titles task completion from persisted activities after the description cache is swept",
    () =>
      Effect.gen(function* () {
        const harness = yield* createHarness();
        const now = "2026-01-01T00:00:00.000Z";

        harness.emit({
          type: "task.progress",
          eventId: asEventId("evt-swept-task-progress"),
          provider: ProviderDriverKind.make("claudeAgent"),
          createdAt: now,
          threadId: asThreadId("thread-1"),
          turnId: asTurnId("turn-swept-task"),
          payload: {
            taskId: "swept-task-1",
            description: "Watch round-3 CI and bots",
            summary: "Polling CI checks.",
          },
        });

        yield* waitForThread(harness.readModel, (entry) =>
          entry.activities.some(
            (activity: ProviderRuntimeTestActivity) =>
              activity.id === "task-progress:thread-1:swept-task-1",
          ),
        );

        // session.exited sweeps the in-memory description cache; the completion
        // that follows must recover the name from persisted activities.
        harness.emit({
          type: "session.exited",
          eventId: asEventId("evt-swept-task-session-exited"),
          provider: ProviderDriverKind.make("claudeAgent"),
          createdAt: now,
          threadId: asThreadId("thread-1"),
          payload: {},
        });

        harness.emit({
          type: "task.completed",
          eventId: asEventId("evt-swept-task-completed"),
          provider: ProviderDriverKind.make("claudeAgent"),
          createdAt: now,
          threadId: asThreadId("thread-1"),
          turnId: asTurnId("turn-swept-task"),
          payload: {
            taskId: "swept-task-1",
            status: "completed",
            summary: "CI is green.",
          },
        });

        const thread = yield* waitForThread(harness.readModel, (entry) =>
          entry.activities.some(
            (activity: ProviderRuntimeTestActivity) => activity.id === "evt-swept-task-completed",
          ),
        );

        const completed = thread.activities.find(
          (activity: ProviderRuntimeTestActivity) => activity.id === "evt-swept-task-completed",
        );
        const completedPayload =
          completed?.payload && typeof completed.payload === "object"
            ? (completed.payload as Record<string, unknown>)
            : undefined;

        expect(completedPayload?.title).toBe("Watch round-3 CI and bots");
      }),
  );

  it.live(
    "coalesces repeated task.progress events for one task into a single upserted activity row",
    () =>
      Effect.gen(function* () {
        const harness = yield* createHarness();
        const now = "2026-01-01T00:00:00.000Z";

        harness.emit({
          type: "task.started",
          eventId: asEventId("evt-chatty-task-started"),
          provider: ProviderDriverKind.make("claudeAgent"),
          createdAt: now,
          threadId: asThreadId("thread-1"),
          turnId: asTurnId("turn-chatty-task"),
          sessionSequence: 1,
          payload: {
            taskId: "chatty-task-1",
            description: "Sweep the repo for dead code",
          },
        });

        for (let index = 0; index < 50; index += 1) {
          harness.emit({
            type: "task.progress",
            eventId: asEventId(`evt-chatty-task-progress-${index}`),
            provider: ProviderDriverKind.make("claudeAgent"),
            createdAt: now,
            threadId: asThreadId("thread-1"),
            turnId: asTurnId("turn-chatty-task"),
            sessionSequence: 2 + index,
            payload: {
              taskId: "chatty-task-1",
              description: "Sweep the repo for dead code",
              summary: `Checked ${index + 1} files so far.`,
            },
          });
        }

        harness.emit({
          type: "task.completed",
          eventId: asEventId("evt-chatty-task-completed"),
          provider: ProviderDriverKind.make("claudeAgent"),
          createdAt: now,
          threadId: asThreadId("thread-1"),
          turnId: asTurnId("turn-chatty-task"),
          sessionSequence: 52,
          payload: {
            taskId: "chatty-task-1",
            status: "completed",
            summary: "No dead code found.",
          },
        });

        const thread = yield* waitForThread(harness.readModel, (entry) =>
          entry.activities.some(
            (activity: ProviderRuntimeTestActivity) => activity.id === "evt-chatty-task-completed",
          ),
        );

        const progressRows = thread.activities.filter(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "task.progress",
        );
        expect(progressRows).toHaveLength(1);
        expect(progressRows[0]?.id).toBe("task-progress:thread-1:chatty-task-1");
        const progressPayload = progressRows[0]?.payload as Record<string, unknown>;
        // The upsert replaced the row in place: the payload reflects the last event.
        expect(progressPayload?.summary).toBe("Checked 50 files so far.");

        // Sequence still tracks the latest event, keeping the coalesced row
        // ordered after task.started and before task.completed.
        const orderedIds = thread.activities
          .filter((activity: ProviderRuntimeTestActivity) =>
            [
              "evt-chatty-task-started",
              "task-progress:thread-1:chatty-task-1",
              "evt-chatty-task-completed",
            ].includes(activity.id),
          )
          .map((activity: ProviderRuntimeTestActivity) => activity.id);
        expect(orderedIds).toEqual([
          "evt-chatty-task-started",
          "task-progress:thread-1:chatty-task-1",
          "evt-chatty-task-completed",
        ]);
        expect(progressRows[0]?.sequence).toBe(51);
      }),
  );

  it.live("carries subagent linkage fields through task activity payloads", () =>
    Effect.gen(function* () {
      const harness = yield* createHarness();
      const now = "2026-01-01T00:00:00.000Z";

      harness.emit({
        type: "task.started",
        eventId: asEventId("evt-subagent-task-started"),
        provider: ProviderDriverKind.make("claudeAgent"),
        createdAt: now,
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-subagent-task"),
        payload: {
          taskId: "subagent-task-1",
          description: "Explore the persistence layer",
          subagentType: "Explore",
          toolUseId: "toolu-task-spawn-1",
          prompt: "Find every projection table and report its writer.",
        },
      });

      harness.emit({
        type: "task.completed",
        eventId: asEventId("evt-subagent-task-completed"),
        provider: ProviderDriverKind.make("claudeAgent"),
        createdAt: now,
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-subagent-task"),
        payload: {
          taskId: "subagent-task-1",
          status: "completed",
          summary: "Report written.",
          toolUseId: "toolu-task-spawn-1",
          outputFile: "/tmp/subagent-report.md",
        },
      });

      const thread = yield* waitForThread(harness.readModel, (entry) =>
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.id === "evt-subagent-task-completed",
        ),
      );

      const started = thread.activities.find(
        (activity: ProviderRuntimeTestActivity) => activity.id === "evt-subagent-task-started",
      );
      expect(started?.payload).toMatchObject({
        taskId: "subagent-task-1",
        subagentType: "Explore",
        toolUseId: "toolu-task-spawn-1",
        // spawnedByItemId mirrors toolUseId under its read-model name.
        spawnedByItemId: "toolu-task-spawn-1",
        prompt: "Find every projection table and report its writer.",
      });

      const completed = thread.activities.find(
        (activity: ProviderRuntimeTestActivity) => activity.id === "evt-subagent-task-completed",
      );
      expect(completed?.payload).toMatchObject({
        taskId: "subagent-task-1",
        toolUseId: "toolu-task-spawn-1",
        outputFile: "/tmp/subagent-report.md",
        // subagentType is absent from the task.completed wire payload; it is
        // remembered from task.started.
        subagentType: "Explore",
      });
    }),
  );

  it.live("projects task.updated runtime events into task.updated activities", () =>
    Effect.gen(function* () {
      const harness = yield* createHarness();
      const now = "2026-01-01T00:00:00.000Z";

      harness.emit({
        type: "task.started",
        eventId: asEventId("evt-bg-task-started"),
        provider: ProviderDriverKind.make("claudeAgent"),
        createdAt: now,
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-bg-task"),
        payload: {
          taskId: "bg-task-1",
          description: "Watch the release pipeline",
          subagentType: "general-purpose",
        },
      });

      harness.emit({
        type: "task.updated",
        eventId: asEventId("evt-bg-task-updated"),
        provider: ProviderDriverKind.make("claudeAgent"),
        createdAt: now,
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-bg-task"),
        payload: {
          taskId: "bg-task-1",
          patch: {
            status: "running",
            isBackgrounded: true,
          },
        },
      });

      const thread = yield* waitForThread(harness.readModel, (entry) =>
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "task.updated",
        ),
      );

      const updated = thread.activities.find(
        (activity: ProviderRuntimeTestActivity) => activity.id === "evt-bg-task-updated",
      );
      expect(updated?.kind).toBe("task.updated");
      expect(updated?.summary).toBe("Task moved to background");
      expect(updated?.payload).toMatchObject({
        taskId: "bg-task-1",
        status: "running",
        isBackgrounded: true,
        title: "Watch the release pipeline",
        subagentType: "general-purpose",
      });
    }),
  );

  it.live("upserts repeated tool.progress heartbeats for one task into a single activity row", () =>
    Effect.gen(function* () {
      const harness = yield* createHarness();
      const now = "2026-01-01T00:00:00.000Z";

      for (let index = 0; index < 5; index += 1) {
        harness.emit({
          type: "tool.progress",
          eventId: asEventId(`evt-heartbeat-${index}`),
          provider: ProviderDriverKind.make("claudeAgent"),
          createdAt: now,
          threadId: asThreadId("thread-1"),
          turnId: asTurnId("turn-heartbeat"),
          payload: {
            taskId: "heartbeat-task-1",
            toolUseId: `toolu-inner-${index}`,
            toolName: "Bash",
            summary: `Still running (${index + 1}0s)`,
            elapsedSeconds: (index + 1) * 10,
            parentToolUseId: "toolu-task-spawn-1",
          },
        });
      }

      // Wait for the LAST heartbeat to land so the row-count assertion below
      // sees all five events applied, not a prefix.
      const settled = yield* waitForThread(harness.readModel, (entry) =>
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) =>
            activity.kind === "tool.progress" &&
            (activity.payload as Record<string, unknown> | undefined)?.elapsedSeconds === 50,
        ),
      );

      const heartbeats = settled.activities.filter(
        (activity: ProviderRuntimeTestActivity) => activity.kind === "tool.progress",
      );
      expect(heartbeats).toHaveLength(1);
      expect(heartbeats[0]?.id).toBe("tool-progress:thread-1:heartbeat-task-1");
      expect(heartbeats[0]?.payload).toMatchObject({
        taskId: "heartbeat-task-1",
        toolName: "Bash",
        elapsedSeconds: 50,
        parentToolUseId: "toolu-task-spawn-1",
      });
    }),
  );

  it.live("persists parentToolUseId on subagent-attributed item lifecycle activities", () =>
    Effect.gen(function* () {
      const harness = yield* createHarness();
      const now = "2026-01-01T00:00:00.000Z";

      harness.emit({
        type: "item.updated",
        eventId: asEventId("evt-subagent-item-updated"),
        provider: ProviderDriverKind.make("claudeAgent"),
        createdAt: now,
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-subagent-item"),
        itemId: asItemId("item-subagent-tool"),
        payload: {
          itemType: "command_execution",
          status: "in_progress",
          title: "Run tests",
          detail: "bun test",
          parentToolUseId: "toolu-task-spawn-1",
          subagentType: "Explore",
        },
      });

      const thread = yield* waitForThread(harness.readModel, (entry) =>
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) =>
            activity.id === "tool-updated:thread-1:item-subagent-tool",
        ),
      );

      const toolUpdate = thread.activities.find(
        (activity: ProviderRuntimeTestActivity) =>
          activity.id === "tool-updated:thread-1:item-subagent-tool",
      );
      expect(toolUpdate?.payload).toMatchObject({
        itemType: "command_execution",
        parentToolUseId: "toolu-task-spawn-1",
        subagentType: "Explore",
      });
    }),
  );

  it.live("projects structured user input request and resolution as thread activities", () =>
    Effect.gen(function* () {
      const harness = yield* createHarness();
      const now = "2026-01-01T00:00:00.000Z";

      harness.emit({
        type: "user-input.requested",
        eventId: asEventId("evt-user-input-requested"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: now,
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-user-input"),
        requestId: ApprovalRequestId.make("req-user-input-1"),
        payload: {
          questions: [
            {
              id: "sandbox_mode",
              header: "Sandbox",
              question: "Which mode should be used?",
              options: [
                {
                  label: "workspace-write",
                  description: "Allow workspace writes only",
                },
              ],
            },
          ],
        },
      });

      harness.emit({
        type: "user-input.resolved",
        eventId: asEventId("evt-user-input-resolved"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-user-input"),
        requestId: ApprovalRequestId.make("req-user-input-1"),
        payload: {
          answers: {
            sandbox_mode: "workspace-write",
          },
        },
      });

      const thread = yield* waitForThread(
        harness.readModel,
        (entry) =>
          entry.activities.some(
            (activity: ProviderRuntimeTestActivity) => activity.kind === "user-input.requested",
          ) &&
          entry.activities.some(
            (activity: ProviderRuntimeTestActivity) => activity.kind === "user-input.resolved",
          ),
      );

      const requested = thread.activities.find(
        (activity: ProviderRuntimeTestActivity) => activity.id === "evt-user-input-requested",
      );
      expect(requested?.kind).toBe("user-input.requested");

      const resolved = thread.activities.find(
        (activity: ProviderRuntimeTestActivity) => activity.id === "evt-user-input-resolved",
      );
      const resolvedPayload =
        resolved?.payload && typeof resolved.payload === "object"
          ? (resolved.payload as Record<string, unknown>)
          : undefined;
      expect(resolved?.kind).toBe("user-input.resolved");
      expect(resolvedPayload?.answers).toEqual({
        sandbox_mode: "workspace-write",
      });
    }),
  );

  it.live("continues processing runtime events after a single event handler failure", () =>
    Effect.gen(function* () {
      const harness = yield* createHarness();
      const now = "2026-01-01T00:00:00.000Z";

      harness.emit({
        type: "content.delta",
        eventId: asEventId("evt-invalid-delta"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: now,
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-invalid"),
        itemId: asItemId("item-invalid"),
        payload: {
          streamKind: "assistant_text",
          delta: undefined,
        },
      } as unknown as ProviderRuntimeEvent);

      harness.emit({
        type: "runtime.error",
        eventId: asEventId("evt-runtime-error-after-failure"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-after-failure"),
        payload: {
          message: "runtime still processed",
        },
      });

      const thread = yield* waitForThread(
        harness.readModel,
        (entry) =>
          entry.session?.status === "error" &&
          entry.session?.activeTurnId === "turn-after-failure" &&
          entry.session?.lastError === "runtime still processed",
      );
      expect(thread.session?.status).toBe("error");
      expect(thread.session?.lastError).toBe("runtime still processed");
    }),
  );

  describe("subagent transcript ingestion", () => {
    function emitTranscriptDelta(
      harness: Harness,
      options: {
        eventId: string;
        delta: string;
        streamKind?: "assistant_text" | "reasoning_text";
        parentToolUseId?: string;
        sessionSequence?: number;
      },
    ) {
      harness.emit({
        type: "content.delta",
        eventId: asEventId(options.eventId),
        provider: ProviderDriverKind.make("claudeAgent"),
        createdAt: "2026-01-01T00:00:00.000Z",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-subagent-transcript"),
        itemId: asItemId("item-parent-assistant"),
        ...(options.sessionSequence !== undefined
          ? { sessionSequence: options.sessionSequence }
          : {}),
        payload: {
          streamKind: options.streamKind ?? "assistant_text",
          delta: options.delta,
          ...(options.parentToolUseId ? { parentToolUseId: options.parentToolUseId } : {}),
        },
      });
    }

    it.live(
      "projects parent-tagged assistant text without changing the parent assistant message",
      () =>
        Effect.gen(function* () {
          const harness = yield* createHarness();
          harness.emit({
            type: "task.started",
            eventId: asEventId("evt-subagent-text-task-started"),
            provider: ProviderDriverKind.make("claudeAgent"),
            createdAt: "2026-01-01T00:00:00.000Z",
            threadId: asThreadId("thread-1"),
            turnId: asTurnId("turn-subagent-transcript"),
            payload: {
              taskId: "subagent-text-task",
              toolUseId: "toolu-subagent-text",
              subagentType: "Explore",
            },
          });
          emitTranscriptDelta(harness, {
            eventId: "evt-subagent-text",
            delta: "Found the relevant module.",
            parentToolUseId: "toolu-subagent-text",
          });

          const thread = yield* waitForThread(harness.readModel, (entry) =>
            entry.activities.some(
              (activity: ProviderRuntimeTestActivity) => activity.kind === "subagent.text",
            ),
          );
          const activity = thread.activities.find(
            (entry: ProviderRuntimeTestActivity) => entry.kind === "subagent.text",
          );
          const decoded = decodeSubagentTranscriptActivityPayload(activity?.payload);

          expect(Option.isSome(decoded)).toBe(true);
          expect(Option.getOrUndefined(decoded)).toMatchObject({
            parentToolUseId: "toolu-subagent-text",
            text: "Found the relevant module.",
            subagentType: "Explore",
          });
          expect(thread.messages).toHaveLength(0);
        }),
    );

    it.live("projects only parent-tagged reasoning text", () =>
      Effect.gen(function* () {
        const harness = yield* createHarness();
        emitTranscriptDelta(harness, {
          eventId: "evt-parent-reasoning",
          delta: "Check the cache lifetime.",
          streamKind: "reasoning_text",
          parentToolUseId: "toolu-subagent-thinking",
        });
        emitTranscriptDelta(harness, {
          eventId: "evt-parentless-reasoning",
          delta: "Parent reasoning remains ignored.",
          streamKind: "reasoning_text",
        });
        yield* harness.drain();

        const thread = yield* waitForThread(harness.readModel, (entry) =>
          entry.activities.some(
            (activity: ProviderRuntimeTestActivity) => activity.kind === "subagent.thinking",
          ),
        );
        const thinking = thread.activities.filter(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "subagent.thinking",
        );
        expect(thinking).toHaveLength(1);
        expect(thinking[0]?.payload).toMatchObject({
          parentToolUseId: "toolu-subagent-thinking",
          text: "Check the cache lifetime.",
        });
      }),
    );

    it.live("coalesces a burst into one transcript row with concatenated text", () =>
      Effect.gen(function* () {
        const harness = yield* createHarness();
        for (const [index, delta] of ["one ", "two ", "three"].entries()) {
          emitTranscriptDelta(harness, {
            eventId: `evt-subagent-burst-${index}`,
            delta,
            parentToolUseId: "toolu-subagent-burst",
          });
        }

        const thread = yield* waitForThread(harness.readModel, (entry) =>
          entry.activities.some(
            (activity: ProviderRuntimeTestActivity) =>
              activity.id === "subagent-text:thread-1:toolu-subagent-burst:0" &&
              (activity.payload as Record<string, unknown>).text === "one two three",
          ),
        );
        const rows = thread.activities.filter(
          (activity: ProviderRuntimeTestActivity) =>
            activity.id === "subagent-text:thread-1:toolu-subagent-burst:0",
        );
        expect(rows).toHaveLength(1);

        const events = yield* Stream.runCollect(harness.engine.readEvents(0)).pipe(
          Effect.map((chunk) => Array.from(chunk)),
        );
        const transcriptDispatches = events.filter(
          (event) =>
            event.type === "thread.activity-appended" &&
            event.payload.activity.id === "subagent-text:thread-1:toolu-subagent-burst:0",
        );
        // One leading-edge dispatch plus one trailing-edge flush. The middle
        // delta only replaces the pending snapshot and dispatches no command.
        expect(transcriptDispatches).toHaveLength(2);
      }),
    );

    it.live("rotates transcript segments around a nested tool", () =>
      Effect.gen(function* () {
        const harness = yield* createHarness();
        emitTranscriptDelta(harness, {
          eventId: "evt-subagent-before-tool",
          delta: "Before tool.",
          parentToolUseId: "toolu-subagent-segments",
          sessionSequence: 1,
        });
        harness.emit({
          type: "item.started",
          eventId: asEventId("evt-subagent-nested-tool"),
          provider: ProviderDriverKind.make("claudeAgent"),
          createdAt: "2026-01-01T00:00:01.000Z",
          threadId: asThreadId("thread-1"),
          turnId: asTurnId("turn-subagent-transcript"),
          itemId: asItemId("item-subagent-nested-tool"),
          sessionSequence: 2,
          payload: {
            itemType: "command_execution",
            title: "Inspect files",
            parentToolUseId: "toolu-subagent-segments",
          },
        });
        emitTranscriptDelta(harness, {
          eventId: "evt-subagent-after-tool",
          delta: "After tool.",
          parentToolUseId: "toolu-subagent-segments",
          sessionSequence: 3,
        });

        const thread = yield* waitForThread(harness.readModel, (entry) =>
          entry.activities.some(
            (activity: ProviderRuntimeTestActivity) =>
              activity.id === "subagent-text:thread-1:toolu-subagent-segments:1",
          ),
        );
        const orderedIds = thread.activities
          .filter((activity: ProviderRuntimeTestActivity) =>
            [
              "subagent-text:thread-1:toolu-subagent-segments:0",
              "evt-subagent-nested-tool",
              "subagent-text:thread-1:toolu-subagent-segments:1",
            ].includes(activity.id),
          )
          .map((activity: ProviderRuntimeTestActivity) => activity.id);
        expect(orderedIds).toEqual([
          "subagent-text:thread-1:toolu-subagent-segments:0",
          "evt-subagent-nested-tool",
          "subagent-text:thread-1:toolu-subagent-segments:1",
        ]);
      }),
    );

    it.live("flushes pending transcript text when the session exits", () =>
      Effect.gen(function* () {
        const harness = yield* createHarness();
        emitTranscriptDelta(harness, {
          eventId: "evt-subagent-exit-first",
          delta: "first ",
          parentToolUseId: "toolu-subagent-exit",
        });
        emitTranscriptDelta(harness, {
          eventId: "evt-subagent-exit-second",
          delta: "second",
          parentToolUseId: "toolu-subagent-exit",
        });
        harness.emit({
          type: "session.exited",
          eventId: asEventId("evt-subagent-session-exited"),
          provider: ProviderDriverKind.make("claudeAgent"),
          createdAt: "2026-01-01T00:00:01.000Z",
          threadId: asThreadId("thread-1"),
        });

        const thread = yield* waitForThread(
          harness.readModel,
          (entry) =>
            entry.session?.status === "stopped" &&
            entry.activities.some(
              (activity: ProviderRuntimeTestActivity) =>
                activity.id === "subagent-text:thread-1:toolu-subagent-exit:0" &&
                (activity.payload as Record<string, unknown>).text === "first second",
            ),
        );
        expect(thread.session?.status).toBe("stopped");
      }),
    );

    it.live("flushes pending transcript text when the matching task completes", () =>
      Effect.gen(function* () {
        const harness = yield* createHarness();
        emitTranscriptDelta(harness, {
          eventId: "evt-subagent-task-first",
          delta: "first ",
          parentToolUseId: "toolu-subagent-task-flush",
        });
        emitTranscriptDelta(harness, {
          eventId: "evt-subagent-task-second",
          delta: "second",
          parentToolUseId: "toolu-subagent-task-flush",
        });
        harness.emit({
          type: "task.completed",
          eventId: asEventId("evt-subagent-task-flush-completed"),
          provider: ProviderDriverKind.make("claudeAgent"),
          createdAt: "2026-01-01T00:00:01.000Z",
          threadId: asThreadId("thread-1"),
          turnId: asTurnId("turn-subagent-transcript"),
          payload: {
            taskId: "subagent-task-flush",
            status: "completed",
            toolUseId: "toolu-subagent-task-flush",
          },
        });

        yield* waitForThread(harness.readModel, (entry) =>
          entry.activities.some(
            (activity: ProviderRuntimeTestActivity) =>
              activity.id === "subagent-text:thread-1:toolu-subagent-task-flush:0" &&
              (activity.payload as Record<string, unknown>).text === "first second",
          ),
        );
      }),
    );

    it.live("caps transcript text and marks the payload truncated", () =>
      Effect.gen(function* () {
        const harness = yield* createHarness();
        emitTranscriptDelta(harness, {
          eventId: "evt-subagent-capped",
          delta: "x".repeat(4_001),
          parentToolUseId: "toolu-subagent-capped",
        });

        const thread = yield* waitForThread(harness.readModel, (entry) =>
          entry.activities.some(
            (activity: ProviderRuntimeTestActivity) => activity.kind === "subagent.text",
          ),
        );
        const payload = thread.activities.find(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "subagent.text",
        )?.payload as Record<string, unknown>;
        expect(payload.truncated).toBe(true);
        expect((payload.text as string).length).toBeLessThanOrEqual(4_000);
      }),
    );
  });

  describe("tool.updated throttling", () => {
    function emitToolUpdate(
      harness: Harness,
      options: {
        eventId: string;
        threadId?: ThreadId;
        turnId: string;
        itemId: string;
        detail: string;
      },
    ) {
      harness.emit({
        type: "item.updated",
        eventId: asEventId(options.eventId),
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        threadId: options.threadId ?? asThreadId("thread-1"),
        turnId: asTurnId(options.turnId),
        itemId: asItemId(options.itemId),
        payload: {
          itemType: "command_execution",
          status: "in_progress",
          title: "Run tests",
          detail: options.detail,
        },
      });
    }

    it.live(
      "coalesces a burst of streamed item.updated chunks into one row carrying the last chunk's detail, with no terminal event ever arriving",
      () =>
        Effect.gen(function* () {
          const harness = yield* createHarness();
          const itemId = "item-throttle-burst";
          const activityId = `tool-updated:thread-1:${itemId}`;

          for (let index = 1; index <= 5; index += 1) {
            emitToolUpdate(harness, {
              eventId: `evt-throttle-burst-${index}`,
              turnId: "turn-throttle-burst",
              itemId,
              detail: `chunk-${index}`,
            });
          }

          // No item.completed, turn.completed, turn.aborted, session.exited, or
          // runtime.error is ever emitted for this item/thread -- the only thing
          // that can flush chunks 2-5 (held by the leading-edge throttle behind
          // chunk 1's immediate dispatch) is the trailing-edge timer, so this
          // proves that mechanism, not the terminal-event accelerator.
          const thread = yield* waitForThread(
            harness.readModel,
            (entry) =>
              (
                entry.activities.find(
                  (activity: ProviderRuntimeTestActivity) => activity.id === activityId,
                )?.payload as Record<string, unknown> | undefined
              )?.detail === "chunk-5",
          );

          const toolUpdates = thread.activities.filter(
            (activity: ProviderRuntimeTestActivity) => activity.id === activityId,
          );
          expect(toolUpdates).toHaveLength(1);
          expect(toolUpdates[0]?.kind).toBe("tool.updated");
          expect((toolUpdates[0]?.payload as Record<string, unknown> | undefined)?.detail).toBe(
            "chunk-5",
          );
        }),
    );

    it.live("does not coalesce two different itemIds in the same thread into each other", () =>
      Effect.gen(function* () {
        const harness = yield* createHarness();
        const activityIdA = "tool-updated:thread-1:item-throttle-a";
        const activityIdB = "tool-updated:thread-1:item-throttle-b";

        emitToolUpdate(harness, {
          eventId: "evt-throttle-a-1",
          turnId: "turn-throttle-two-items",
          itemId: "item-throttle-a",
          detail: "a-chunk-1",
        });
        emitToolUpdate(harness, {
          eventId: "evt-throttle-b-1",
          turnId: "turn-throttle-two-items",
          itemId: "item-throttle-b",
          detail: "b-chunk-1",
        });
        emitToolUpdate(harness, {
          eventId: "evt-throttle-a-2",
          turnId: "turn-throttle-two-items",
          itemId: "item-throttle-a",
          detail: "a-chunk-2",
        });
        emitToolUpdate(harness, {
          eventId: "evt-throttle-b-2",
          turnId: "turn-throttle-two-items",
          itemId: "item-throttle-b",
          detail: "b-chunk-2",
        });

        const thread = yield* waitForThread(harness.readModel, (entry) => {
          const a = entry.activities.find(
            (activity: ProviderRuntimeTestActivity) => activity.id === activityIdA,
          )?.payload as Record<string, unknown> | undefined;
          const b = entry.activities.find(
            (activity: ProviderRuntimeTestActivity) => activity.id === activityIdB,
          )?.payload as Record<string, unknown> | undefined;
          return a?.detail === "a-chunk-2" && b?.detail === "b-chunk-2";
        });

        const activityA = thread.activities.find(
          (activity: ProviderRuntimeTestActivity) => activity.id === activityIdA,
        );
        const activityB = thread.activities.find(
          (activity: ProviderRuntimeTestActivity) => activity.id === activityIdB,
        );
        expect((activityA?.payload as Record<string, unknown> | undefined)?.detail).toBe(
          "a-chunk-2",
        );
        expect((activityB?.payload as Record<string, unknown> | undefined)?.detail).toBe(
          "b-chunk-2",
        );
      }),
    );

    it.live(
      "still produces an activity for item.updated with no itemId, keyed by eventId (unthrottled fallback)",
      () =>
        Effect.gen(function* () {
          const harness = yield* createHarness();
          const now = "2026-01-01T00:00:00.000Z";

          harness.emit({
            type: "item.updated",
            eventId: asEventId("evt-throttle-no-item-id"),
            provider: ProviderDriverKind.make("codex"),
            createdAt: now,
            threadId: asThreadId("thread-1"),
            turnId: asTurnId("turn-throttle-no-item-id"),
            payload: {
              itemType: "command_execution",
              status: "in_progress",
              title: "Run tests",
              detail: "only-chunk",
            },
          });

          yield* harness.drain();
          const readModel = yield* harness.readModel();
          const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
          const activity = thread?.activities.find(
            (candidate: ProviderRuntimeTestActivity) => candidate.id === "evt-throttle-no-item-id",
          );
          expect(activity?.kind).toBe("tool.updated");
          expect((activity?.payload as Record<string, unknown> | undefined)?.detail).toBe(
            "only-chunk",
          );
        }),
    );

    it.live(
      "keeps item.started and item.completed on their own distinct rows, not overwritten by the tool.updated row for the same item",
      () =>
        Effect.gen(function* () {
          const harness = yield* createHarness();
          const now = "2026-01-01T00:00:00.000Z";
          const itemId = "item-throttle-lifecycle";

          harness.emit({
            type: "item.started",
            eventId: asEventId("evt-throttle-lifecycle-started"),
            provider: ProviderDriverKind.make("codex"),
            createdAt: now,
            threadId: asThreadId("thread-1"),
            turnId: asTurnId("turn-throttle-lifecycle"),
            itemId: asItemId(itemId),
            payload: {
              itemType: "command_execution",
              title: "Run tests",
              detail: "starting",
            },
          });
          emitToolUpdate(harness, {
            eventId: "evt-throttle-lifecycle-updated",
            turnId: "turn-throttle-lifecycle",
            itemId,
            detail: "running",
          });
          harness.emit({
            type: "item.completed",
            eventId: asEventId("evt-throttle-lifecycle-completed"),
            provider: ProviderDriverKind.make("codex"),
            createdAt: now,
            threadId: asThreadId("thread-1"),
            turnId: asTurnId("turn-throttle-lifecycle"),
            itemId: asItemId(itemId),
            payload: {
              itemType: "command_execution",
              title: "Run tests",
              detail: "done",
            },
          });

          yield* harness.drain();
          const readModel = yield* harness.readModel();
          const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));

          const started = thread?.activities.find(
            (activity: ProviderRuntimeTestActivity) =>
              activity.id === "evt-throttle-lifecycle-started",
          );
          const updated = thread?.activities.find(
            (activity: ProviderRuntimeTestActivity) =>
              activity.id === `tool-updated:thread-1:${itemId}`,
          );
          const completed = thread?.activities.find(
            (activity: ProviderRuntimeTestActivity) =>
              activity.id === "evt-throttle-lifecycle-completed",
          );

          expect(started?.kind).toBe("tool.started");
          expect(updated?.kind).toBe("tool.updated");
          expect(completed?.kind).toBe("tool.completed");
          expect((updated?.payload as Record<string, unknown> | undefined)?.detail).toBe("running");
          expect((completed?.payload as Record<string, unknown> | undefined)?.detail).toBe("done");
        }),
    );

    it.live(
      "flushes a throttled tool.updated immediately when item.completed arrives for the same item",
      () =>
        Effect.gen(function* () {
          const harness = yield* createHarness();
          const now = "2026-01-01T00:00:00.000Z";
          const itemId = "item-throttle-completed-accelerator";
          const activityId = `tool-updated:thread-1:${itemId}`;

          emitToolUpdate(harness, {
            eventId: "evt-throttle-completed-accel-1",
            turnId: "turn-throttle-completed-accelerator",
            itemId,
            detail: "chunk-1",
          });
          // Arrives inside the throttle window right behind chunk 1's immediate
          // (leading-edge) dispatch, so it is held pending rather than dispatched.
          emitToolUpdate(harness, {
            eventId: "evt-throttle-completed-accel-2",
            turnId: "turn-throttle-completed-accelerator",
            itemId,
            detail: "chunk-2-held",
          });
          harness.emit({
            type: "item.completed",
            eventId: asEventId("evt-throttle-completed-accel-done"),
            provider: ProviderDriverKind.make("codex"),
            createdAt: now,
            threadId: asThreadId("thread-1"),
            turnId: asTurnId("turn-throttle-completed-accelerator"),
            itemId: asItemId(itemId),
            payload: {
              itemType: "command_execution",
              title: "Run tests",
              detail: "done",
            },
          });

          // drain() alone proves this: it only waits for the queue this event was
          // processed on, not for the ~150ms trailing-edge timer, so chunk-2-held
          // must have been flushed synchronously by item.completed's accelerator.
          yield* harness.drain();
          const readModel = yield* harness.readModel();
          const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
          const updated = thread?.activities.find(
            (activity: ProviderRuntimeTestActivity) => activity.id === activityId,
          );
          expect((updated?.payload as Record<string, unknown> | undefined)?.detail).toBe(
            "chunk-2-held",
          );
        }),
    );

    it.live(
      "flushes a throttled tool.updated when turn.aborted arrives (interrupted turn, no turn.completed ever follows)",
      () =>
        Effect.gen(function* () {
          const harness = yield* createHarness();
          const now = "2026-01-01T00:00:00.000Z";
          const itemId = "item-throttle-turn-aborted";
          const activityId = `tool-updated:thread-1:${itemId}`;

          emitToolUpdate(harness, {
            eventId: "evt-throttle-turn-aborted-1",
            turnId: "turn-throttle-aborted",
            itemId,
            detail: "chunk-1",
          });
          emitToolUpdate(harness, {
            eventId: "evt-throttle-turn-aborted-2",
            turnId: "turn-throttle-aborted",
            itemId,
            detail: "chunk-2-held",
          });
          harness.emit({
            type: "turn.aborted",
            eventId: asEventId("evt-throttle-turn-aborted"),
            provider: ProviderDriverKind.make("codex"),
            createdAt: now,
            threadId: asThreadId("thread-1"),
            turnId: asTurnId("turn-throttle-aborted"),
            payload: {
              reason: "interrupted by user",
            },
          });

          yield* harness.drain();
          const readModel = yield* harness.readModel();
          const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
          const updated = thread?.activities.find(
            (activity: ProviderRuntimeTestActivity) => activity.id === activityId,
          );
          expect((updated?.payload as Record<string, unknown> | undefined)?.detail).toBe(
            "chunk-2-held",
          );
        }),
    );

    it.live(
      "flushes a throttled tool.updated when session.exited arrives (session exit, no turn.completed ever follows)",
      () =>
        Effect.gen(function* () {
          const harness = yield* createHarness();
          const now = "2026-01-01T00:00:00.000Z";
          const itemId = "item-throttle-session-exited";
          const activityId = `tool-updated:thread-1:${itemId}`;

          emitToolUpdate(harness, {
            eventId: "evt-throttle-session-exited-1",
            turnId: "turn-throttle-session-exited",
            itemId,
            detail: "chunk-1",
          });
          emitToolUpdate(harness, {
            eventId: "evt-throttle-session-exited-2",
            turnId: "turn-throttle-session-exited",
            itemId,
            detail: "chunk-2-held",
          });
          harness.emit({
            type: "session.exited",
            eventId: asEventId("evt-throttle-session-exited"),
            provider: ProviderDriverKind.make("codex"),
            createdAt: now,
            threadId: asThreadId("thread-1"),
            payload: {},
          });

          yield* harness.drain();
          const readModel = yield* harness.readModel();
          const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
          const updated = thread?.activities.find(
            (activity: ProviderRuntimeTestActivity) => activity.id === activityId,
          );
          expect((updated?.payload as Record<string, unknown> | undefined)?.detail).toBe(
            "chunk-2-held",
          );
        }),
    );

    it.live(
      "does not let the same itemId in two different threads collide on the global activity_id primary key",
      () =>
        Effect.gen(function* () {
          const harness = yield* createHarness();
          const otherThreadId = asThreadId("thread-throttle-other");
          const createdAt = "2026-01-01T00:00:00.000Z";
          const sharedItemId = "item-shared-across-threads";

          yield* harness.engine.dispatch({
            type: "thread.create",
            commandId: CommandId.make("cmd-thread-create-throttle-other"),
            threadId: otherThreadId,
            projectId: asProjectId("project-1"),
            title: "Other Thread",
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-5-codex",
            },
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            runtimeMode: "approval-required",
            branch: null,
            worktreePath: null,
            createdAt,
          });
          yield* harness.engine.dispatch({
            type: "thread.session.set",
            commandId: CommandId.make("cmd-session-set-throttle-other"),
            threadId: otherThreadId,
            session: {
              threadId: otherThreadId,
              status: "ready",
              providerName: "codex",
              runtimeMode: "approval-required",
              activeTurnId: null,
              updatedAt: createdAt,
              lastError: null,
            },
            createdAt,
          });

          emitToolUpdate(harness, {
            eventId: "evt-throttle-shared-thread-1",
            turnId: "turn-throttle-shared-thread-1",
            itemId: sharedItemId,
            detail: "thread-1-detail",
          });
          emitToolUpdate(harness, {
            eventId: "evt-throttle-shared-thread-2",
            threadId: otherThreadId,
            turnId: "turn-throttle-shared-thread-2",
            itemId: sharedItemId,
            detail: "thread-2-detail",
          });

          const activityId = `tool-updated:thread-1:${sharedItemId}`;
          const otherActivityId = `tool-updated:${otherThreadId}:${sharedItemId}`;

          const thread1 = yield* waitForThread(
            harness.readModel,
            (entry) =>
              (
                entry.activities.find(
                  (activity: ProviderRuntimeTestActivity) => activity.id === activityId,
                )?.payload as Record<string, unknown> | undefined
              )?.detail === "thread-1-detail",
            2000,
            asThreadId("thread-1"),
          );
          const thread2 = yield* waitForThread(
            harness.readModel,
            (entry) =>
              (
                entry.activities.find(
                  (activity: ProviderRuntimeTestActivity) => activity.id === otherActivityId,
                )?.payload as Record<string, unknown> | undefined
              )?.detail === "thread-2-detail",
            2000,
            otherThreadId,
          );

          // The bug this guards against: itemId is only unique within a
          // provider session, so without the threadId in the key, thread-2's
          // row for this itemId would upsert onto (and move) thread-1's row
          // instead of getting its own -- thread-1 would end up with no
          // tool.updated activity at all.
          expect(
            thread1.activities.some(
              (activity: ProviderRuntimeTestActivity) => activity.id === activityId,
            ),
          ).toBe(true);
          expect(
            thread2.activities.some(
              (activity: ProviderRuntimeTestActivity) => activity.id === otherActivityId,
            ),
          ).toBe(true);
          expect(
            thread1.activities.some(
              (activity: ProviderRuntimeTestActivity) => activity.id === otherActivityId,
            ),
          ).toBe(false);
        }),
    );
  });
});
