// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  epicRunIterationThreadId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  ProviderDriverKind,
  ProviderInstanceId,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { OrchestrationCommandInvariantError } from "../../orchestration/Errors.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { ProjectionTurnRepositoryLive } from "../../persistence/Layers/ProjectionTurns.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ServerConfig } from "../../config.ts";
import * as GitWorkflowService from "../../git/GitWorkflowService.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProviderCommandReactor } from "../../orchestration/Services/ProviderCommandReactor.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineLive } from "../../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { ProviderCommandReactorLive } from "../../orchestration/Layers/ProviderCommandReactor.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as ProviderSessionRuntime from "../../persistence/ProviderSessionRuntime.ts";
import { makeProviderRegistryLayer } from "../testUtils/providerRegistryMock.ts";
import { ProviderValidationError } from "../Errors.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import { ProviderSessionReaper } from "../Services/ProviderSessionReaper.ts";
import { ProviderService, type ProviderServiceShape } from "../Services/ProviderService.ts";
import { ProviderSessionDirectoryLive } from "./ProviderSessionDirectory.ts";
import { VcsStatusBroadcaster } from "../../vcs/VcsStatusBroadcaster.ts";
import { TextGeneration } from "../../textGeneration/TextGeneration.ts";
import {
  makeProviderSessionReaperLive,
  type ProviderSessionReaperLiveOptions,
} from "./ProviderSessionReaper.ts";

/**
 * Open the sequential scope and start the reaper inside it.
 *
 * Only for the cases that run on the default Effect runtime. The
 * `runtime!.runPromise` sites elsewhere in this file run on the test's own
 * ManagedRuntime and are not interchangeable with these.
 */
const startReaperScope = async (reaper: {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
}) => {
  const scope = await Effect.runPromise(Scope.make("sequential"));
  await Effect.runPromise(reaper.start().pipe(Scope.provide(scope)));
  return scope;
};

const defaultModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5-codex",
} as const;

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = (await Effect.runPromise(Clock.currentTimeMillis)) + timeoutMs;
  const poll = async (): Promise<void> => {
    if (await predicate()) {
      return;
    }
    if ((await Effect.runPromise(Clock.currentTimeMillis)) >= deadline) {
      throw new Error("Timed out waiting for expectation.");
    }
    await Effect.runPromise(Effect.yieldNow);
    return poll();
  };

  return poll();
}

/** A `lastSeenAt` that is stale for a 1s threshold and fresh for a 60s one. */
const idleForFiveSeconds = Effect.map(DateTime.now, (now) =>
  DateTime.formatIso(DateTime.subtractDuration(now, Duration.seconds(5))),
);

const drainFibers = Effect.forEach(Array.from({ length: 10 }), () => Effect.yieldNow, {
  discard: true,
});

const unsupported = () => Effect.die(new Error("Unsupported provider call in test")) as never;

function makeReadModel(
  threads: ReadonlyArray<{
    readonly id: ThreadId;
    readonly settledOverride?: "settled" | "active" | null;
    readonly activeSubagentCount?: number;
    readonly newestRunningSubagentUpdatedAt?: string | null;
    readonly session: {
      readonly threadId: ThreadId;
      readonly status: "starting" | "running" | "ready" | "interrupted" | "stopped" | "error";
      readonly providerName: "codex" | "claudeAgent";
      readonly runtimeMode: "approval-required" | "full-access" | "auto-accept-edits";
      readonly activeTurnId: TurnId | null;
      readonly lastError: string | null;
      readonly updatedAt: string;
    } | null;
  }>,
) {
  const now = "2026-01-01T00:00:00.000Z";
  const projectId = ProjectId.make("project-provider-session-reaper");

  return {
    snapshotSequence: 0,
    updatedAt: now,
    projects: [
      {
        id: projectId,
        title: "Provider Reaper Project",
        workspaceRoot: "/tmp/provider-reaper-project",
        defaultModelSelection,
        scripts: [],
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      },
    ],
    threads: threads.map((thread) => ({
      id: thread.id,
      projectId,
      title: `Thread ${thread.id}`,
      modelSelection: defaultModelSelection,
      interactionMode: "default" as const,
      runtimeMode: "full-access" as const,
      branch: null,
      worktreePath: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: thread.settledOverride ?? null,
      settledAt: null,
      latestUserMessageAt: null,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      hasActionableProposedPlan: false,
      activeSubagentCount: thread.activeSubagentCount ?? 0,
      newestRunningSubagentUpdatedAt: thread.newestRunningSubagentUpdatedAt ?? null,
      latestTurn: null,
      messages: [],
      session: thread.session,
      activities: [],
      proposedPlans: [],
      checkpoints: [],
      deletedAt: null,
      parentThreadId: null,
    })),
  };
}

describe("ProviderSessionReaper", () => {
  let runtime: ManagedRuntime.ManagedRuntime<
    ProviderSessionReaper | ProviderSessionRuntime.ProviderSessionRuntimeRepository,
    unknown
  > | null = null;
  let scope: Scope.Closeable | null = null;

  afterEach(async () => {
    if (scope) {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
    scope = null;
    if (runtime) {
      await runtime.dispose();
    }
    runtime = null;
  });

  async function createHarness(input: {
    readonly readModel: ReturnType<typeof makeReadModel>;
    readonly stopSessionImplementation?: (input: {
      readonly threadId: ThreadId;
    }) => ReturnType<ProviderServiceShape["stopSession"]>;
    readonly hasLiveSessionImplementation?: (
      threadId: ThreadId,
    ) => ReturnType<ProviderServiceShape["hasLiveSession"]>;
    readonly dispatchImplementation?: (
      command: OrchestrationCommand,
    ) => ReturnType<OrchestrationEngineShape["dispatch"]>;
    readonly reaperOptions?: ProviderSessionReaperLiveOptions;
  }) {
    const stoppedThreadIds = new Set<ThreadId>();
    const projectedStoppedThreadIds = new Set<ThreadId>();
    const dispatchedCommands: OrchestrationCommand[] = [];
    const dispatch = vi.fn<OrchestrationEngineShape["dispatch"]>((command) => {
      dispatchedCommands.push(command);
      const result = (
        input.dispatchImplementation
          ? input.dispatchImplementation(command)
          : Effect.succeed({ sequence: dispatchedCommands.length })
      ) as ReturnType<OrchestrationEngineShape["dispatch"]>;
      return result.pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            if (command.type === "thread.session.stop") {
              projectedStoppedThreadIds.add(command.threadId);
            }
          }),
        ),
      ) as ReturnType<OrchestrationEngineShape["dispatch"]>;
    });
    const stopSession = vi.fn<ProviderServiceShape["stopSession"]>(
      (request) =>
        (input.stopSessionImplementation
          ? input.stopSessionImplementation(request)
          : Effect.sync(() => {
              stoppedThreadIds.add(request.threadId);
            })) as ReturnType<ProviderServiceShape["stopSession"]>,
    );
    const hasLiveSession = vi.fn<ProviderServiceShape["hasLiveSession"]>((threadId) =>
      input.hasLiveSessionImplementation
        ? input.hasLiveSessionImplementation(threadId)
        : Effect.succeed(true),
    );

    const providerService: ProviderServiceShape = {
      startSession: () => unsupported(),
      sendTurn: () => unsupported(),
      interruptTurn: () => unsupported(),
      respondToRequest: () => unsupported(),
      respondToUserInput: () => unsupported(),
      stopSession,
      listSessions: () => Effect.succeed([]),
      hasLiveSession,
      getCapabilities: () => Effect.succeed({ sessionModelSwitch: "in-session" }),
      getInstanceInfo: (instanceId) => {
        const driverKind = ProviderDriverKind.make(String(instanceId));
        return Effect.succeed({
          instanceId,
          driverKind,
          displayName: undefined,
          enabled: true,
          continuationIdentity: {
            driverKind,
            continuationKey: `${driverKind}:instance:${instanceId}`,
          },
        });
      },
      rollbackConversation: () => unsupported(),
      streamEvents: Stream.empty,
    };

    const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
      Layer.provide(SqlitePersistenceMemory),
    );
    const providerSessionDirectoryLayer = ProviderSessionDirectoryLive.pipe(
      Layer.provide(runtimeRepositoryLayer),
    );
    const layer = makeProviderSessionReaperLive({
      inactivityThresholdMs: 1_000,
      sweepIntervalMs: 60_000,
      ...input.reaperOptions,
    }).pipe(
      Layer.provideMerge(providerSessionDirectoryLayer),
      Layer.provideMerge(runtimeRepositoryLayer),
      Layer.provideMerge(Layer.succeed(ProviderService, providerService)),
      Layer.provideMerge(
        Layer.succeed(OrchestrationEngineService, {
          readEvents: () => Stream.empty,
          dispatch,
          streamDomainEvents: Stream.empty,
          latestSequence: Effect.succeed(0),
        }),
      ),
      Layer.provideMerge(
        Layer.succeed(ProjectionSnapshotQuery, {
          getCommandReadModel: () => Effect.die("unused"),
          getSnapshot: () => Effect.die("unused"),
          getShellSnapshot: () => Effect.die("unused"),
          getArchivedShellSnapshot: () => Effect.die("unused"),
          getSnapshotSequence: () =>
            Effect.succeed({ snapshotSequence: input.readModel.snapshotSequence }),
          getCounts: () => Effect.die("unused"),
          getActiveProjectByWorkspaceRoot: () => Effect.die("unused"),
          getProjectShellById: () => Effect.die("unused"),
          getFirstActiveThreadIdByProjectId: () => Effect.die("unused"),
          listChildThreadIds: () => Effect.die("unused"),
          getThreadCheckpointContext: () => Effect.die("unused"),
          getFullThreadDiffContext: () => Effect.die("unused"),
          getThreadShellById: (threadId) =>
            Effect.succeed(
              input.readModel.threads.find((thread) => thread.id === threadId)
                ? Option.some(input.readModel.threads.find((thread) => thread.id === threadId)!)
                : Option.none(),
            ),
          getThreadSessionById: (threadId) =>
            Effect.succeed(
              Option.fromNullishOr(
                (() => {
                  const session = input.readModel.threads.find(
                    (thread) => thread.id === threadId,
                  )?.session;
                  return session && projectedStoppedThreadIds.has(threadId)
                    ? { ...session, status: "stopped" as const, activeTurnId: null }
                    : session;
                })(),
              ),
            ),
          getThreadSubagentLiveness: (threadId) => {
            const thread = input.readModel.threads.find((candidate) => candidate.id === threadId);
            return Effect.succeed({
              activeSubagentCount: thread?.activeSubagentCount ?? 0,
              newestRunningUpdatedAt: thread?.newestRunningSubagentUpdatedAt ?? null,
            });
          },
          getSubagentActivities: () =>
            Effect.succeed({ activities: [], hasMore: false, nextBefore: null }),
          getThreadDetailById: () => Effect.die("unused"),
          getThreadDetailSnapshot: () => Effect.die("unused"),
        }),
      ),
      Layer.provideMerge(NodeServices.layer),
    );

    runtime = ManagedRuntime.make(layer);
    return {
      stopSession,
      stoppedThreadIds,
      hasLiveSession,
      dispatch,
      dispatchedCommands,
    };
  }

  /** The `thread.session.stop` commands the reaper dispatched, in order. */
  function dispatchedSessionStops(harness: { dispatchedCommands: OrchestrationCommand[] }) {
    return harness.dispatchedCommands.filter(
      (command): command is Extract<OrchestrationCommand, { type: "thread.session.stop" }> =>
        command.type === "thread.session.stop",
    );
  }

  it("reconciles a dead binding before start returns without waiting for grace", async () => {
    const threadId = ThreadId.make("thread-boot-reconcile-dead");
    const turnId = TurnId.make("turn-boot-reconcile-dead");
    const now = "2026-01-01T00:00:00.000Z";
    const harness = await createHarness({
      readModel: makeReadModel([
        {
          id: threadId,
          session: {
            threadId,
            status: "running",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: turnId,
            lastError: null,
            updatedAt: now,
          },
        },
      ]),
      hasLiveSessionImplementation: () => Effect.succeed(false),
      reaperOptions: {
        inactivityThresholdMs: 60_000,
        deadSessionGraceMs: 60_000,
      },
    });
    const repository = await runtime!.runPromise(
      Effect.service(ProviderSessionRuntime.ProviderSessionRuntimeRepository),
    );
    await runtime!.runPromise(
      repository.upsert({
        threadId,
        providerName: "codex",
        providerInstanceId: null,
        adapterKey: "codex",
        runtimeMode: "full-access",
        status: "running",
        lastSeenAt: await runtime!.runPromise(idleForFiveSeconds),
        resumeCursor: { opaque: "resume-after-boot" },
        runtimePayload: null,
      }),
    );

    const reaper = await runtime!.runPromise(Effect.service(ProviderSessionReaper));
    scope = await runtime!.runPromise(Scope.make("sequential"));
    await runtime!.runPromise(reaper.start().pipe(Scope.provide(scope)));

    const stops = dispatchedSessionStops(harness);
    expect(stops).toHaveLength(1);
    expect(stops[0]?.threadId).toBe(threadId);
    expect(String(stops[0]?.commandId)).toMatch(
      new RegExp(`^session-stop-for-boot-reconcile:${threadId}:\\d+$`),
    );
    expect(stops[0]?.reason).toBe(
      "session interrupted: server restarted while the session was running",
    );
    expect(harness.hasLiveSession).toHaveBeenCalledTimes(2);
    expect(harness.stopSession).toHaveBeenCalledWith({ threadId });

    const binding = await runtime!.runPromise(repository.getByThreadId({ threadId }));
    expect(Option.getOrUndefined(binding)?.resumeCursor).toEqual({
      opaque: "resume-after-boot",
    });
  });

  it("reconciles error bindings and skips live or stopped bindings during boot", async () => {
    const liveThreadId = ThreadId.make("thread-boot-reconcile-live");
    const stoppedThreadId = ThreadId.make("thread-boot-reconcile-stopped");
    const errorThreadId = ThreadId.make("thread-boot-reconcile-error");
    const now = "2026-01-01T00:00:00.000Z";
    const harness = await createHarness({
      readModel: makeReadModel([
        {
          id: liveThreadId,
          session: {
            threadId: liveThreadId,
            status: "running",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: now,
          },
        },
        {
          id: stoppedThreadId,
          session: {
            threadId: stoppedThreadId,
            status: "stopped",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: now,
          },
        },
        {
          id: errorThreadId,
          session: {
            threadId: errorThreadId,
            status: "error",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: "old server stopped",
            updatedAt: now,
          },
        },
      ]),
      hasLiveSessionImplementation: (threadId) => Effect.succeed(threadId === liveThreadId),
      reaperOptions: { inactivityThresholdMs: 60_000 },
    });
    const repository = await runtime!.runPromise(
      Effect.service(ProviderSessionRuntime.ProviderSessionRuntimeRepository),
    );
    const lastSeenAt = await runtime!.runPromise(idleForFiveSeconds);
    for (const [threadId, status] of [
      [liveThreadId, "running"],
      [stoppedThreadId, "stopped"],
      [errorThreadId, "error"],
    ] as const) {
      await runtime!.runPromise(
        repository.upsert({
          threadId,
          providerName: "codex",
          providerInstanceId: null,
          adapterKey: "codex",
          runtimeMode: "full-access",
          status,
          lastSeenAt,
          resumeCursor: null,
          runtimePayload: null,
        }),
      );
    }

    const reaper = await runtime!.runPromise(Effect.service(ProviderSessionReaper));
    scope = await runtime!.runPromise(Scope.make("sequential"));
    await runtime!.runPromise(reaper.start().pipe(Scope.provide(scope)));
    await runtime!.runPromise(drainFibers);

    expect(harness.hasLiveSession).toHaveBeenCalledTimes(3);
    expect(harness.hasLiveSession).toHaveBeenCalledWith(liveThreadId);
    expect(harness.hasLiveSession).toHaveBeenCalledWith(errorThreadId);
    expect(dispatchedSessionStops(harness).map((command) => command.threadId)).toEqual([
      errorThreadId,
    ]);
    expect(harness.stopSession).toHaveBeenCalledWith({ threadId: errorThreadId });
  });

  it("abandons boot reconciliation when liveness replaces or stops the binding", async () => {
    const replacedThreadId = ThreadId.make("thread-boot-reconcile-replaced");
    const stoppedThreadId = ThreadId.make("thread-boot-reconcile-raced-stopped");
    const now = "2026-01-01T00:00:00.000Z";
    const livenessRaces = new Map<ThreadId, Effect.Effect<void>>();
    const harness = await createHarness({
      readModel: makeReadModel(
        [replacedThreadId, stoppedThreadId].map((threadId) => ({
          id: threadId,
          session: {
            threadId,
            status: "running" as const,
            providerName: "codex" as const,
            runtimeMode: "full-access" as const,
            activeTurnId: null,
            lastError: null,
            updatedAt: now,
          },
        })),
      ),
      hasLiveSessionImplementation: (threadId) =>
        (livenessRaces.get(threadId) ?? Effect.void).pipe(Effect.as(false)),
      reaperOptions: { inactivityThresholdMs: 60_000 },
    });
    const repository = await runtime!.runPromise(
      Effect.service(ProviderSessionRuntime.ProviderSessionRuntimeRepository),
    );
    const lastSeenAt = await runtime!.runPromise(idleForFiveSeconds);
    for (const threadId of [replacedThreadId, stoppedThreadId]) {
      await runtime!.runPromise(
        repository.upsert({
          threadId,
          providerName: "codex",
          providerInstanceId: defaultModelSelection.instanceId,
          adapterKey: "codex",
          runtimeMode: "full-access",
          status: "running",
          lastSeenAt,
          resumeCursor: null,
          runtimePayload: null,
        }),
      );
    }
    livenessRaces.set(
      replacedThreadId,
      repository
        .upsert({
          threadId: replacedThreadId,
          providerName: "claudeAgent",
          providerInstanceId: ProviderInstanceId.make("claudeAgent"),
          adapterKey: "claudeAgent",
          runtimeMode: "full-access",
          status: "running",
          lastSeenAt,
          resumeCursor: null,
          runtimePayload: null,
        })
        .pipe(Effect.orDie),
    );
    livenessRaces.set(
      stoppedThreadId,
      repository
        .upsert({
          threadId: stoppedThreadId,
          providerName: "codex",
          providerInstanceId: defaultModelSelection.instanceId,
          adapterKey: "codex",
          runtimeMode: "full-access",
          status: "stopped",
          lastSeenAt,
          resumeCursor: null,
          runtimePayload: null,
        })
        .pipe(Effect.orDie),
    );

    const reaper = await runtime!.runPromise(Effect.service(ProviderSessionReaper));
    scope = await runtime!.runPromise(Scope.make("sequential"));
    await runtime!.runPromise(reaper.start().pipe(Scope.provide(scope)));

    expect(dispatchedSessionStops(harness)).toEqual([]);
  });

  it("settles projected boot state and clears pending turns before start returns", async () => {
    const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-reaper-boot-"));
    const persistenceLayer = SqlitePersistenceMemory;
    const serverConfigLayer = ServerConfig.layerTest(process.cwd(), baseDir);
    const repositoryIdentityLayer = RepositoryIdentityResolver.layer.pipe(
      Layer.provide(serverConfigLayer),
      Layer.provide(NodeServices.layer),
    );
    const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
      Layer.provide(persistenceLayer),
    );
    const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));
    const projectionSnapshotLayer = OrchestrationProjectionSnapshotQueryLive.pipe(
      Layer.provide(repositoryIdentityLayer),
      Layer.provide(persistenceLayer),
    );
    const orchestrationLayer = OrchestrationEngineLive.pipe(
      Layer.provide(projectionSnapshotLayer),
      Layer.provide(OrchestrationProjectionPipelineLive),
      Layer.provide(OrchestrationEventStoreLive),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
      Layer.provide(repositoryIdentityLayer),
      Layer.provide(persistenceLayer),
    );
    const providerServiceLayer = Layer.effect(
      ProviderService,
      Effect.gen(function* () {
        const directory = yield* ProviderSessionDirectory;
        const stopSession: ProviderServiceShape["stopSession"] = Effect.fn(
          "ProviderSessionReaper.test.stopSession",
        )(function* ({ threadId }) {
          const binding = Option.getOrUndefined(yield* directory.getBinding(threadId));
          if (binding === undefined) {
            return;
          }
          yield* directory.upsert({ ...binding, status: "stopped" });
        });
        const unsupportedCall = () =>
          Effect.die(new Error("Unsupported provider call in boot integration test")) as never;

        return ProviderService.of({
          startSession: () => unsupportedCall(),
          sendTurn: () => unsupportedCall(),
          interruptTurn: () => unsupportedCall(),
          respondToRequest: () => unsupportedCall(),
          respondToUserInput: () => unsupportedCall(),
          stopSession,
          listSessions: () => Effect.succeed([]),
          hasLiveSession: () => Effect.succeed(false),
          getCapabilities: () => Effect.succeed({ sessionModelSwitch: "in-session" }),
          getInstanceInfo: (instanceId) => {
            const driverKind = ProviderDriverKind.make(String(instanceId));
            return Effect.succeed({
              instanceId,
              driverKind,
              displayName: undefined,
              enabled: true,
              continuationIdentity: {
                driverKind,
                continuationKey: `${driverKind}:instance:${instanceId}`,
              },
            });
          },
          rollbackConversation: () => unsupportedCall(),
          streamEvents: Stream.empty,
        });
      }),
    ).pipe(Layer.provide(directoryLayer));
    const providerRegistryLayer = makeProviderRegistryLayer([
      { instanceId: defaultModelSelection.instanceId },
    ] as never);
    const gitWorkflowLayer = Layer.mock(GitWorkflowService.GitWorkflowService)({
      renameBranch: () => Effect.die("renameBranch should not run during boot reconciliation"),
    });
    const vcsStatusLayer = Layer.succeed(VcsStatusBroadcaster, {
      getStatus: () => Effect.die("getStatus should not run during boot reconciliation"),
      peekStatus: () => Effect.die("peekStatus should not run during boot reconciliation"),
      refreshLocalStatus: () =>
        Effect.die("refreshLocalStatus should not run during boot reconciliation"),
      refreshStatus: () => Effect.die("refreshStatus should not run during boot reconciliation"),
      streamStatus: () => Stream.die("streamStatus should not run during boot reconciliation"),
    });
    const textGenerationLayer = Layer.mock(TextGeneration, {
      generateBranchName: () =>
        Effect.die("generateBranchName should not run during boot reconciliation"),
      generateThreadTitle: () =>
        Effect.die("generateThreadTitle should not run during boot reconciliation"),
    });
    const reactorLayer = ProviderCommandReactorLive.pipe(
      Layer.provideMerge(orchestrationLayer),
      Layer.provideMerge(projectionSnapshotLayer),
      Layer.provideMerge(providerServiceLayer),
      Layer.provideMerge(providerRegistryLayer),
      Layer.provideMerge(gitWorkflowLayer),
      Layer.provideMerge(vcsStatusLayer),
      Layer.provideMerge(textGenerationLayer),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provide(serverConfigLayer),
      Layer.provide(NodeServices.layer),
    );
    const reaperLayer = makeProviderSessionReaperLive({
      inactivityThresholdMs: 60_000,
      deadSessionGraceMs: 60_000,
      sweepIntervalMs: 60_000,
    }).pipe(
      Layer.provideMerge(directoryLayer),
      Layer.provideMerge(runtimeRepositoryLayer),
      Layer.provideMerge(providerServiceLayer),
      Layer.provideMerge(orchestrationLayer),
      Layer.provideMerge(projectionSnapshotLayer),
      Layer.provide(NodeServices.layer),
    );
    const turnRepositoryLayer = ProjectionTurnRepositoryLive.pipe(Layer.provide(persistenceLayer));
    const integratedRuntime = ManagedRuntime.make(
      Layer.mergeAll(reactorLayer, reaperLayer, turnRepositoryLayer).pipe(
        Layer.provide(serverConfigLayer),
        Layer.provide(NodeServices.layer),
      ),
    );
    const integratedScope = await Effect.runPromise(Scope.make("sequential"));

    try {
      const engine = await integratedRuntime.runPromise(Effect.service(OrchestrationEngineService));
      const reactor = await integratedRuntime.runPromise(Effect.service(ProviderCommandReactor));
      const reaper = await integratedRuntime.runPromise(Effect.service(ProviderSessionReaper));
      const snapshots = await integratedRuntime.runPromise(Effect.service(ProjectionSnapshotQuery));
      const turns = await integratedRuntime.runPromise(Effect.service(ProjectionTurnRepository));
      const repository = await integratedRuntime.runPromise(
        Effect.service(ProviderSessionRuntime.ProviderSessionRuntimeRepository),
      );
      const projectId = ProjectId.make("project-boot-reconcile-integration");
      const threadId = ThreadId.make("thread-boot-reconcile-integration");
      const mismatchedThreadId = ThreadId.make("thread-boot-reconcile-stopped-projection");
      const turnId = TurnId.make("turn-boot-reconcile-integration");
      const now = "2026-01-01T00:00:00.000Z";

      await integratedRuntime.runPromise(reactor.start().pipe(Scope.provide(integratedScope)));
      await integratedRuntime.runPromise(
        engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("cmd-boot-reconcile-project"),
          projectId,
          title: "Boot Reconcile Project",
          workspaceRoot: "/tmp/provider-reaper-boot-project",
          defaultModelSelection,
          createdAt: now,
        }),
      );
      await integratedRuntime.runPromise(
        engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd-boot-reconcile-mismatched-thread"),
          threadId: mismatchedThreadId,
          projectId,
          title: "Stopped Projection Thread",
          modelSelection: defaultModelSelection,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: now,
        }),
      );
      await integratedRuntime.runPromise(
        engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd-boot-reconcile-thread"),
          threadId,
          projectId,
          title: "Boot Reconcile Thread",
          modelSelection: defaultModelSelection,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: now,
        }),
      );
      await integratedRuntime.runPromise(
        engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make("cmd-boot-reconcile-stopped-projection"),
          threadId: mismatchedThreadId,
          session: {
            threadId: mismatchedThreadId,
            status: "stopped",
            providerName: "codex",
            providerInstanceId: defaultModelSelection.instanceId,
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: now,
          },
          createdAt: now,
        }),
      );
      await integratedRuntime.runPromise(
        engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make("cmd-boot-reconcile-running-session"),
          threadId,
          session: {
            threadId,
            status: "running",
            providerName: "codex",
            providerInstanceId: defaultModelSelection.instanceId,
            runtimeMode: "full-access",
            activeTurnId: turnId,
            lastError: null,
            updatedAt: now,
          },
          createdAt: now,
        }),
      );
      await integratedRuntime.runPromise(
        turns.upsertByTurnId({
          threadId,
          turnId,
          pendingMessageId: null,
          sourceProposedPlanThreadId: null,
          sourceProposedPlanId: null,
          assistantMessageId: null,
          state: "running",
          requestedAt: now,
          startedAt: now,
          completedAt: null,
          checkpointTurnCount: null,
          checkpointRef: null,
          checkpointStatus: null,
          checkpointFiles: [],
        }),
      );
      await integratedRuntime.runPromise(
        turns.replacePendingTurnStart({
          threadId,
          messageId: MessageId.make("message-boot-reconcile-pending"),
          sourceProposedPlanThreadId: null,
          sourceProposedPlanId: null,
          requestedAt: now,
        }),
      );
      await integratedRuntime.runPromise(
        repository.upsert({
          threadId,
          providerName: "codex",
          providerInstanceId: defaultModelSelection.instanceId,
          adapterKey: "codex",
          runtimeMode: "full-access",
          status: "running",
          lastSeenAt: await integratedRuntime.runPromise(idleForFiveSeconds),
          resumeCursor: { opaque: "resume-after-integrated-boot" },
          runtimePayload: null,
        }),
      );
      await integratedRuntime.runPromise(
        repository.upsert({
          threadId: mismatchedThreadId,
          providerName: "codex",
          providerInstanceId: defaultModelSelection.instanceId,
          adapterKey: "codex",
          runtimeMode: "full-access",
          status: "running",
          lastSeenAt: await integratedRuntime.runPromise(idleForFiveSeconds),
          resumeCursor: { opaque: "resume-after-mismatched-boot" },
          runtimePayload: null,
        }),
      );

      await integratedRuntime.runPromise(reaper.start().pipe(Scope.provide(integratedScope)));

      const session = Option.getOrUndefined(
        await integratedRuntime.runPromise(snapshots.getThreadSessionById(threadId)),
      );
      expect(session?.status).toBe("stopped");
      expect(session?.activeTurnId).toBeNull();
      expect(session?.lastError).toBe(
        "session interrupted: server restarted while the session was running",
      );
      const projectedTurns = await integratedRuntime.runPromise(turns.listByThreadId({ threadId }));
      expect(projectedTurns).toHaveLength(1);
      expect(projectedTurns[0]?.turnId).toBe(turnId);
      expect(projectedTurns[0]?.state).toBe("interrupted");
      expect(
        Option.isNone(
          await integratedRuntime.runPromise(turns.getPendingTurnStartByThreadId({ threadId })),
        ),
      ).toBe(true);
      const binding = Option.getOrUndefined(
        await integratedRuntime.runPromise(repository.getByThreadId({ threadId })),
      );
      expect(binding?.status).toBe("stopped");
      expect(binding?.resumeCursor).toEqual({ opaque: "resume-after-integrated-boot" });
      const mismatchedBinding = Option.getOrUndefined(
        await integratedRuntime.runPromise(
          repository.getByThreadId({ threadId: mismatchedThreadId }),
        ),
      );
      expect(mismatchedBinding?.status).toBe("stopped");
      expect(mismatchedBinding?.resumeCursor).toEqual({
        opaque: "resume-after-mismatched-boot",
      });
    } finally {
      await Effect.runPromise(Scope.close(integratedScope, Exit.void));
      await integratedRuntime.dispose();
      NodeFS.rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("reaps stale persisted sessions without active turns", async () => {
    const threadId = ThreadId.make("thread-reaper-stale");
    const now = "2026-01-01T00:00:00.000Z";
    const harness = await createHarness({
      readModel: makeReadModel([
        {
          id: threadId,
          session: {
            threadId,
            status: "ready",
            providerName: "claudeAgent",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: now,
          },
        },
      ]),
    });
    const repository = await runtime!.runPromise(
      Effect.service(ProviderSessionRuntime.ProviderSessionRuntimeRepository),
    );

    await runtime!.runPromise(
      repository.upsert({
        threadId,
        providerName: "claudeAgent",
        providerInstanceId: null,
        adapterKey: "claudeAgent",
        runtimeMode: "full-access",
        status: "running",
        lastSeenAt: "2026-04-14T00:00:00.000Z",
        resumeCursor: {
          opaque: "resume-stale",
        },
        runtimePayload: null,
      }),
    );

    const reaper = await runtime!.runPromise(Effect.service(ProviderSessionReaper));
    scope = await startReaperScope(reaper);

    await waitFor(() => dispatchedSessionStops(harness).length === 1);

    const stop = dispatchedSessionStops(harness)[0]!;
    expect(stop.threadId).toBe(threadId);
    expect(String(stop.commandId).startsWith(`session-stop-for-reap:${threadId}:`)).toBe(true);
    expect(stop.reason).toBe("session reaped: interactive session exceeded its idle limit");
    // The command path owns the stop; the direct call is only a fallback.
    expect(harness.stopSession).not.toHaveBeenCalled();
  });

  it("skips stale sessions when the thread still has an active turn", async () => {
    const threadId = ThreadId.make("thread-reaper-active-turn");
    const turnId = TurnId.make("turn-reaper-active");
    const now = "2026-01-01T00:00:00.000Z";
    const harness = await createHarness({
      readModel: makeReadModel([
        {
          id: threadId,
          session: {
            threadId,
            status: "running",
            providerName: "claudeAgent",
            runtimeMode: "full-access",
            activeTurnId: turnId,
            lastError: null,
            updatedAt: now,
          },
        },
      ]),
    });
    const repository = await runtime!.runPromise(
      Effect.service(ProviderSessionRuntime.ProviderSessionRuntimeRepository),
    );

    await runtime!.runPromise(
      repository.upsert({
        threadId,
        providerName: "claudeAgent",
        providerInstanceId: null,
        adapterKey: "claudeAgent",
        runtimeMode: "full-access",
        status: "running",
        // Stale for the 1s idle threshold, fresh for the 24h active-turn cap.
        lastSeenAt: await runtime!.runPromise(idleForFiveSeconds),
        resumeCursor: {
          opaque: "resume-active-turn",
        },
        runtimePayload: null,
      }),
    );

    const reaper = await runtime!.runPromise(Effect.service(ProviderSessionReaper));
    scope = await startReaperScope(reaper);
    await Effect.runPromise(drainFibers);

    expect(harness.dispatch).not.toHaveBeenCalled();
    expect(harness.stopSession).not.toHaveBeenCalled();
    const remaining = await runtime!.runPromise(repository.getByThreadId({ threadId }));
    expect(Option.isSome(remaining)).toBe(true);
  });

  it("reaps a session whose active turn outlived the skip cap", async () => {
    const threadId = ThreadId.make("thread-reaper-stale-active-turn");
    const turnId = TurnId.make("turn-reaper-that-died");
    const now = "2026-01-01T00:00:00.000Z";
    const harness = await createHarness({
      readModel: makeReadModel([
        {
          id: threadId,
          session: {
            threadId,
            status: "running",
            providerName: "claudeAgent",
            runtimeMode: "full-access",
            // Never cleared, because the turn died holding the pointer.
            activeTurnId: turnId,
            lastError: null,
            updatedAt: now,
          },
        },
      ]),
      reaperOptions: { activeTurnSkipCapMs: 1_000 },
    });
    const repository = await runtime!.runPromise(
      Effect.service(ProviderSessionRuntime.ProviderSessionRuntimeRepository),
    );

    await runtime!.runPromise(
      repository.upsert({
        threadId,
        providerName: "claudeAgent",
        providerInstanceId: null,
        adapterKey: "claudeAgent",
        runtimeMode: "full-access",
        status: "running",
        lastSeenAt: await runtime!.runPromise(idleForFiveSeconds),
        resumeCursor: {
          opaque: "resume-stale-active-turn",
        },
        runtimePayload: null,
      }),
    );

    const reaper = await runtime!.runPromise(Effect.service(ProviderSessionReaper));
    scope = await runtime!.runPromise(Scope.make("sequential"));
    await runtime!.runPromise(reaper.start().pipe(Scope.provide(scope)));

    await waitFor(() => dispatchedSessionStops(harness).length === 1);

    expect(dispatchedSessionStops(harness)[0]?.threadId).toBe(threadId);
    expect(dispatchedSessionStops(harness)[0]?.reason).toBe(
      "session reaped: active turn exceeded its inactivity limit",
    );
    expect(harness.stopSession).not.toHaveBeenCalled();
  });

  it("does not reap sessions that are still within the inactivity threshold", async () => {
    const threadId = ThreadId.make("thread-reaper-fresh");
    const now = DateTime.formatIso(await Effect.runPromise(DateTime.now));
    const harness = await createHarness({
      readModel: makeReadModel([
        {
          id: threadId,
          session: {
            threadId,
            status: "ready",
            providerName: "claudeAgent",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: now,
          },
        },
      ]),
    });
    const repository = await runtime!.runPromise(
      Effect.service(ProviderSessionRuntime.ProviderSessionRuntimeRepository),
    );

    await runtime!.runPromise(
      repository.upsert({
        threadId,
        providerName: "claudeAgent",
        providerInstanceId: null,
        adapterKey: "claudeAgent",
        runtimeMode: "full-access",
        status: "running",
        lastSeenAt: now,
        resumeCursor: {
          opaque: "resume-fresh",
        },
        runtimePayload: null,
      }),
    );

    const reaper = await runtime!.runPromise(Effect.service(ProviderSessionReaper));
    scope = await startReaperScope(reaper);
    await Effect.runPromise(drainFibers);

    expect(harness.dispatch).not.toHaveBeenCalled();
    expect(harness.stopSession).not.toHaveBeenCalled();
    const remaining = await runtime!.runPromise(repository.getByThreadId({ threadId }));
    expect(Option.isSome(remaining)).toBe(true);
  });

  it("skips persisted sessions that are already marked stopped", async () => {
    const threadId = ThreadId.make("thread-reaper-stopped");
    const now = "2026-01-01T00:00:00.000Z";
    const harness = await createHarness({
      readModel: makeReadModel([
        {
          id: threadId,
          session: {
            threadId,
            status: "stopped",
            providerName: "claudeAgent",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: now,
          },
        },
      ]),
    });
    const repository = await runtime!.runPromise(
      Effect.service(ProviderSessionRuntime.ProviderSessionRuntimeRepository),
    );

    await runtime!.runPromise(
      repository.upsert({
        threadId,
        providerName: "claudeAgent",
        providerInstanceId: null,
        adapterKey: "claudeAgent",
        runtimeMode: "full-access",
        status: "stopped",
        lastSeenAt: "2026-04-14T00:00:00.000Z",
        resumeCursor: {
          opaque: "resume-stopped",
        },
        runtimePayload: null,
      }),
    );

    const reaper = await runtime!.runPromise(Effect.service(ProviderSessionReaper));
    scope = await startReaperScope(reaper);
    await Effect.runPromise(drainFibers);

    expect(harness.dispatch).not.toHaveBeenCalled();
    expect(harness.stopSession).not.toHaveBeenCalled();
    const remaining = await runtime!.runPromise(repository.getByThreadId({ threadId }));
    expect(Option.isSome(remaining)).toBe(true);
  });

  it("continues reaping other sessions when one stop attempt fails", async () => {
    const failedThreadId = ThreadId.make("thread-reaper-stop-failure");
    const reapedThreadId = ThreadId.make("thread-reaper-stop-success");
    const now = "2026-01-01T00:00:00.000Z";
    const harness = await createHarness({
      readModel: makeReadModel([
        {
          id: failedThreadId,
          session: {
            threadId: failedThreadId,
            status: "ready",
            providerName: "claudeAgent",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: now,
          },
        },
        {
          id: reapedThreadId,
          session: {
            threadId: reapedThreadId,
            status: "ready",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: now,
          },
        },
      ]),
      // Dispatch refuses the first thread, and its direct-stop fallback fails
      // too — the sweep must still reach the second thread.
      dispatchImplementation: (command) =>
        command.type === "thread.session.stop" && command.threadId === failedThreadId
          ? Effect.fail(
              new OrchestrationCommandInvariantError({
                commandType: command.type,
                detail: "simulated dispatch refusal",
              }),
            )
          : Effect.succeed({ sequence: 1 }),
      stopSessionImplementation: (request) =>
        request.threadId === failedThreadId
          ? Effect.fail(
              new ProviderValidationError({
                operation: "ProviderSessionReaper.test",
                issue: "simulated stop failure",
              }),
            )
          : Effect.void,
    });
    const repository = await runtime!.runPromise(
      Effect.service(ProviderSessionRuntime.ProviderSessionRuntimeRepository),
    );

    await runtime!.runPromise(
      repository.upsert({
        threadId: failedThreadId,
        providerName: "claudeAgent",
        providerInstanceId: null,
        adapterKey: "claudeAgent",
        runtimeMode: "full-access",
        status: "running",
        lastSeenAt: "2026-04-14T00:00:00.000Z",
        resumeCursor: {
          opaque: "resume-failure",
        },
        runtimePayload: null,
      }),
    );
    await runtime!.runPromise(
      repository.upsert({
        threadId: reapedThreadId,
        providerName: "codex",
        providerInstanceId: null,
        adapterKey: "codex",
        runtimeMode: "full-access",
        status: "running",
        lastSeenAt: "2026-04-14T00:01:00.000Z",
        resumeCursor: {
          opaque: "resume-success",
        },
        runtimePayload: null,
      }),
    );

    const reaper = await runtime!.runPromise(Effect.service(ProviderSessionReaper));
    scope = await startReaperScope(reaper);

    await waitFor(() => dispatchedSessionStops(harness).length === 2);

    expect(dispatchedSessionStops(harness).map((command) => command.threadId)).toEqual([
      failedThreadId,
      reapedThreadId,
    ]);
    // Only the refused dispatch fell back to the direct stop, and that
    // fallback's failure did not block the second thread's reap.
    expect(harness.stopSession.mock.calls.map(([request]) => request.threadId)).toEqual([
      failedThreadId,
    ]);
  });

  it("continues reaping other sessions when one stop attempt defects", async () => {
    const defectThreadId = ThreadId.make("thread-reaper-stop-defect");
    const reapedThreadId = ThreadId.make("thread-reaper-stop-after-defect");
    const now = "2026-01-01T00:00:00.000Z";
    const harness = await createHarness({
      readModel: makeReadModel([
        {
          id: defectThreadId,
          session: {
            threadId: defectThreadId,
            status: "ready",
            providerName: "claudeAgent",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: now,
          },
        },
        {
          id: reapedThreadId,
          session: {
            threadId: reapedThreadId,
            status: "ready",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: now,
          },
        },
      ]),
      // A defect in one thread's stop dispatch is contained by the per-stop
      // catchCause and must not halt the sweep.
      dispatchImplementation: (command) =>
        command.type === "thread.session.stop" && command.threadId === defectThreadId
          ? Effect.die(new Error("simulated stop defect"))
          : Effect.succeed({ sequence: 1 }),
    });
    const repository = await runtime!.runPromise(
      Effect.service(ProviderSessionRuntime.ProviderSessionRuntimeRepository),
    );

    await runtime!.runPromise(
      repository.upsert({
        threadId: defectThreadId,
        providerName: "claudeAgent",
        providerInstanceId: null,
        adapterKey: "claudeAgent",
        runtimeMode: "full-access",
        status: "running",
        lastSeenAt: "2026-04-14T00:00:00.000Z",
        resumeCursor: {
          opaque: "resume-defect",
        },
        runtimePayload: null,
      }),
    );
    await runtime!.runPromise(
      repository.upsert({
        threadId: reapedThreadId,
        providerName: "codex",
        providerInstanceId: null,
        adapterKey: "codex",
        runtimeMode: "full-access",
        status: "running",
        lastSeenAt: "2026-04-14T00:01:00.000Z",
        resumeCursor: {
          opaque: "resume-after-defect",
        },
        runtimePayload: null,
      }),
    );

    const reaper = await runtime!.runPromise(Effect.service(ProviderSessionReaper));
    scope = await startReaperScope(reaper);

    await waitFor(() => dispatchedSessionStops(harness).length === 2);

    expect(dispatchedSessionStops(harness).map((command) => command.threadId)).toEqual([
      defectThreadId,
      reapedThreadId,
    ]);
    // A defect is a bug, not a refusal: it is logged, and the next sweep
    // retries — no fallback direct stop fires.
    expect(harness.stopSession).not.toHaveBeenCalled();
  });

  it("reaps an epic-run iteration thread on the short threshold while sparing a plain thread", async () => {
    const interactiveThreadId = ThreadId.make("thread-reaper-interactive-backstop");
    const iterationThreadId = ThreadId.make(
      epicRunIterationThreadId({
        runId: "0f1c9a4e-6b21-4a2c-9f31-7d0c5b8e2a10",
        iterationIndex: 2,
      }),
    );
    const now = "2026-01-01T00:00:00.000Z";
    const harness = await createHarness({
      readModel: makeReadModel([
        {
          id: interactiveThreadId,
          session: {
            threadId: interactiveThreadId,
            status: "ready",
            providerName: "claudeAgent",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: now,
          },
        },
        {
          id: iterationThreadId,
          session: {
            threadId: iterationThreadId,
            status: "ready",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: now,
          },
        },
      ]),
      reaperOptions: {
        interactiveIdleThresholdMs: 60_000,
        epicRunIterationIdleThresholdMs: 1_000,
        settledIdleThresholdMs: 1_000,
        sweepIntervalMs: 60_000,
      },
    });
    const repository = await runtime!.runPromise(
      Effect.service(ProviderSessionRuntime.ProviderSessionRuntimeRepository),
    );
    const idleFiveSecondsAgo = await runtime!.runPromise(idleForFiveSeconds);

    await runtime!.runPromise(
      repository.upsert({
        threadId: interactiveThreadId,
        providerName: "claudeAgent",
        providerInstanceId: null,
        adapterKey: "claudeAgent",
        runtimeMode: "full-access",
        status: "running",
        lastSeenAt: idleFiveSecondsAgo,
        resumeCursor: {
          opaque: "resume-interactive-backstop",
        },
        runtimePayload: null,
      }),
    );
    await runtime!.runPromise(
      repository.upsert({
        threadId: iterationThreadId,
        providerName: "codex",
        providerInstanceId: null,
        adapterKey: "codex",
        runtimeMode: "full-access",
        status: "running",
        lastSeenAt: idleFiveSecondsAgo,
        resumeCursor: {
          opaque: "resume-iteration-thread",
        },
        runtimePayload: null,
      }),
    );

    const reaper = await runtime!.runPromise(Effect.service(ProviderSessionReaper));
    scope = await runtime!.runPromise(Scope.make("sequential"));
    await runtime!.runPromise(reaper.start().pipe(Scope.provide(scope)));

    await waitFor(() => dispatchedSessionStops(harness).length === 1);
    await runtime!.runPromise(drainFibers);

    expect(dispatchedSessionStops(harness).map((command) => command.threadId)).toEqual([
      iterationThreadId,
    ]);
    expect(dispatchedSessionStops(harness)[0]?.reason).toBe(
      "session reaped: epic run iteration exceeded its idle limit",
    );
    expect(harness.stopSession).not.toHaveBeenCalled();
  });

  it("spares a quiet-main-stream session whose subagent is still fresh", async () => {
    const iterationThreadId = ThreadId.make(
      epicRunIterationThreadId({
        runId: "1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d",
        iterationIndex: 1,
      }),
    );
    const now = DateTime.formatIso(DateTime.nowUnsafe());
    const harness = await createHarness({
      readModel: makeReadModel([
        {
          id: iterationThreadId,
          // The incident shape: the adapter falsely reported turn end, so the
          // turn pointer is gone, but a Task subagent is still working.
          activeSubagentCount: 1,
          newestRunningSubagentUpdatedAt: now,
          session: {
            threadId: iterationThreadId,
            status: "ready",
            providerName: "claudeAgent",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: now,
          },
        },
      ]),
    });
    const repository = await runtime!.runPromise(
      Effect.service(ProviderSessionRuntime.ProviderSessionRuntimeRepository),
    );

    await runtime!.runPromise(
      repository.upsert({
        threadId: iterationThreadId,
        providerName: "claudeAgent",
        providerInstanceId: null,
        adapterKey: "claudeAgent",
        runtimeMode: "full-access",
        status: "running",
        // Stale for the 1s idle threshold; only the fresh subagent saves it.
        lastSeenAt: await runtime!.runPromise(idleForFiveSeconds),
        resumeCursor: {
          opaque: "resume-fresh-subagent",
        },
        runtimePayload: null,
      }),
    );

    const reaper = await runtime!.runPromise(Effect.service(ProviderSessionReaper));
    scope = await runtime!.runPromise(Scope.make("sequential"));
    await runtime!.runPromise(reaper.start().pipe(Scope.provide(scope)));
    await runtime!.runPromise(drainFibers);

    expect(harness.dispatch).not.toHaveBeenCalled();
    expect(harness.stopSession).not.toHaveBeenCalled();
    const remaining = await runtime!.runPromise(
      repository.getByThreadId({ threadId: iterationThreadId }),
    );
    expect(Option.isSome(remaining)).toBe(true);
  });

  it("reaps a quiet session whose running subagent row went stale", async () => {
    const iterationThreadId = ThreadId.make(
      epicRunIterationThreadId({
        runId: "9f8e7d6c-5b4a-4c3d-8e2f-1a0b9c8d7e6f",
        iterationIndex: 4,
      }),
    );
    const now = DateTime.nowUnsafe();
    const staleSubagentUpdatedAt = DateTime.formatIso(
      DateTime.subtractDuration(now, Duration.minutes(20)),
    );
    const harness = await createHarness({
      readModel: makeReadModel([
        {
          id: iterationThreadId,
          activeSubagentCount: 1,
          newestRunningSubagentUpdatedAt: staleSubagentUpdatedAt,
          session: {
            threadId: iterationThreadId,
            status: "ready",
            providerName: "claudeAgent",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: DateTime.formatIso(now),
          },
        },
      ]),
    });
    const repository = await runtime!.runPromise(
      Effect.service(ProviderSessionRuntime.ProviderSessionRuntimeRepository),
    );

    await runtime!.runPromise(
      repository.upsert({
        threadId: iterationThreadId,
        providerName: "claudeAgent",
        providerInstanceId: null,
        adapterKey: "claudeAgent",
        runtimeMode: "full-access",
        status: "running",
        lastSeenAt: await runtime!.runPromise(idleForFiveSeconds),
        resumeCursor: {
          opaque: "resume-stale-subagent",
        },
        runtimePayload: null,
      }),
    );

    const reaper = await runtime!.runPromise(Effect.service(ProviderSessionReaper));
    scope = await runtime!.runPromise(Scope.make("sequential"));
    await runtime!.runPromise(reaper.start().pipe(Scope.provide(scope)));

    await waitFor(() => dispatchedSessionStops(harness).length === 1);

    expect(dispatchedSessionStops(harness)[0]?.threadId).toBe(iterationThreadId);
  });

  it("reaps a settled thread on the short threshold", async () => {
    const settledThreadId = ThreadId.make("thread-reaper-settled");
    const now = "2026-01-01T00:00:00.000Z";
    const harness = await createHarness({
      readModel: makeReadModel([
        {
          id: settledThreadId,
          settledOverride: "settled",
          session: {
            threadId: settledThreadId,
            status: "ready",
            providerName: "claudeAgent",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: now,
          },
        },
      ]),
      reaperOptions: {
        interactiveIdleThresholdMs: 60_000,
        epicRunIterationIdleThresholdMs: 60_000,
        settledIdleThresholdMs: 1_000,
        sweepIntervalMs: 60_000,
      },
    });
    const repository = await runtime!.runPromise(
      Effect.service(ProviderSessionRuntime.ProviderSessionRuntimeRepository),
    );

    await runtime!.runPromise(
      repository.upsert({
        threadId: settledThreadId,
        providerName: "claudeAgent",
        providerInstanceId: null,
        adapterKey: "claudeAgent",
        runtimeMode: "full-access",
        status: "running",
        lastSeenAt: await runtime!.runPromise(idleForFiveSeconds),
        resumeCursor: {
          opaque: "resume-settled",
        },
        runtimePayload: null,
      }),
    );

    const reaper = await runtime!.runPromise(Effect.service(ProviderSessionReaper));
    scope = await runtime!.runPromise(Scope.make("sequential"));
    await runtime!.runPromise(reaper.start().pipe(Scope.provide(scope)));

    await waitFor(() => dispatchedSessionStops(harness).length === 1);

    expect(dispatchedSessionStops(harness)[0]?.threadId).toBe(settledThreadId);
    expect(dispatchedSessionStops(harness)[0]?.reason).toBe(
      "session reaped: settled session exceeded its idle limit",
    );
  });

  it("reports the keep-active backstop when it reaps a pinned session", async () => {
    const pinnedThreadId = ThreadId.make("thread-reaper-active-pin");
    const now = "2026-01-01T00:00:00.000Z";
    const harness = await createHarness({
      readModel: makeReadModel([
        {
          id: pinnedThreadId,
          settledOverride: "active",
          session: {
            threadId: pinnedThreadId,
            status: "ready",
            providerName: "claudeAgent",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: now,
          },
        },
      ]),
      reaperOptions: {
        interactiveIdleThresholdMs: 1_000,
        sweepIntervalMs: 60_000,
      },
    });
    const repository = await runtime!.runPromise(
      Effect.service(ProviderSessionRuntime.ProviderSessionRuntimeRepository),
    );

    await runtime!.runPromise(
      repository.upsert({
        threadId: pinnedThreadId,
        providerName: "claudeAgent",
        providerInstanceId: null,
        adapterKey: "claudeAgent",
        runtimeMode: "full-access",
        status: "running",
        lastSeenAt: await runtime!.runPromise(idleForFiveSeconds),
        resumeCursor: { opaque: "resume-active-pin" },
        runtimePayload: null,
      }),
    );

    const reaper = await runtime!.runPromise(Effect.service(ProviderSessionReaper));
    scope = await runtime!.runPromise(Scope.make("sequential"));
    await runtime!.runPromise(reaper.start().pipe(Scope.provide(scope)));

    await waitFor(() => dispatchedSessionStops(harness).length === 1);

    expect(dispatchedSessionStops(harness)[0]?.threadId).toBe(pinnedThreadId);
    expect(dispatchedSessionStops(harness)[0]?.reason).toBe(
      "session reaped: keep-active session exceeded its idle limit",
    );
  });

  it("falls back to a direct stop when the thread is missing from the read model", async () => {
    const orphanThreadId = ThreadId.make("thread-reaper-orphan-binding");
    // No thread in the read model at all: the binding outlived its thread, so
    // the stop dispatch is refused and only the direct call can stop the
    // adapter session.
    const harness = await createHarness({
      readModel: makeReadModel([]),
      dispatchImplementation: (command) =>
        Effect.fail(
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `Thread '${orphanThreadId}' does not exist.`,
          }),
        ),
    });
    const repository = await runtime!.runPromise(
      Effect.service(ProviderSessionRuntime.ProviderSessionRuntimeRepository),
    );

    await runtime!.runPromise(
      repository.upsert({
        threadId: orphanThreadId,
        providerName: "claudeAgent",
        providerInstanceId: null,
        adapterKey: "claudeAgent",
        runtimeMode: "full-access",
        status: "running",
        lastSeenAt: "2026-04-14T00:00:00.000Z",
        resumeCursor: {
          opaque: "resume-orphan",
        },
        runtimePayload: null,
      }),
    );

    const reaper = await runtime!.runPromise(Effect.service(ProviderSessionReaper));
    scope = await runtime!.runPromise(Scope.make("sequential"));
    await runtime!.runPromise(reaper.start().pipe(Scope.provide(scope)));

    await waitFor(() => harness.stopSession.mock.calls.length === 1);

    expect(dispatchedSessionStops(harness)[0]?.threadId).toBe(orphanThreadId);
    expect(harness.stopSession.mock.calls[0]?.[0]).toEqual({ threadId: orphanThreadId });
    expect(harness.stoppedThreadIds.has(orphanThreadId)).toBe(true);
  });

  it("reaps a dead running binding after grace and spares a live one", async () => {
    const deadThreadId = ThreadId.make("thread-reaper-dead-session");
    const liveThreadId = ThreadId.make("thread-reaper-live-session");
    const turnId = TurnId.make("turn-reaper-liveness");
    const now = "2026-01-01T00:00:00.000Z";
    const livenessReads = new Map<ThreadId, number>();
    const harness = await createHarness({
      readModel: makeReadModel([
        {
          id: deadThreadId,
          session: {
            threadId: deadThreadId,
            status: "running",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: turnId,
            lastError: null,
            updatedAt: now,
          },
        },
        {
          id: liveThreadId,
          session: {
            threadId: liveThreadId,
            status: "running",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: turnId,
            lastError: null,
            updatedAt: now,
          },
        },
      ]),
      hasLiveSessionImplementation: (threadId) =>
        Effect.sync(() => {
          const readCount = livenessReads.get(threadId) ?? 0;
          livenessReads.set(threadId, readCount + 1);
          return threadId === liveThreadId || readCount === 0;
        }),
      reaperOptions: {
        inactivityThresholdMs: 60_000,
        deadSessionGraceMs: 1_000,
      },
    });
    const repository = await runtime!.runPromise(
      Effect.service(ProviderSessionRuntime.ProviderSessionRuntimeRepository),
    );
    const lastSeenAt = await runtime!.runPromise(idleForFiveSeconds);

    for (const threadId of [deadThreadId, liveThreadId]) {
      await runtime!.runPromise(
        repository.upsert({
          threadId,
          providerName: "codex",
          providerInstanceId: null,
          adapterKey: "codex",
          runtimeMode: "full-access",
          status: "running",
          lastSeenAt,
          resumeCursor: { opaque: `resume-${threadId}` },
          runtimePayload: null,
        }),
      );
    }

    const reaper = await runtime!.runPromise(Effect.service(ProviderSessionReaper));
    scope = await runtime!.runPromise(Scope.make("sequential"));
    await runtime!.runPromise(reaper.start().pipe(Scope.provide(scope)));

    await waitFor(() => dispatchedSessionStops(harness).length === 1);
    await runtime!.runPromise(drainFibers);

    const stops = dispatchedSessionStops(harness);
    expect(stops).toHaveLength(1);
    expect(stops[0]?.threadId).toBe(deadThreadId);
    expect(String(stops[0]?.commandId)).toMatch(
      new RegExp(`^session-stop-for-reap:${deadThreadId}:\\d+$`),
    );
    expect(stops[0]?.reason).toBe("session reaped: no live provider process");
    expect(harness.stopSession).not.toHaveBeenCalled();

    const deadBinding = await runtime!.runPromise(
      repository.getByThreadId({ threadId: deadThreadId }),
    );
    expect(Option.getOrUndefined(deadBinding)?.resumeCursor).toEqual({
      opaque: `resume-${deadThreadId}`,
    });
  });

  it("abandons a dead-session reap when the adapter session resumes", async () => {
    const threadId = ThreadId.make("thread-reaper-resumed-during-sweep");
    const now = "2026-01-01T00:00:00.000Z";
    let livenessReadCount = 0;
    const harness = await createHarness({
      readModel: makeReadModel([
        {
          id: threadId,
          session: {
            threadId,
            status: "running",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: TurnId.make("turn-reaper-resumed"),
            lastError: null,
            updatedAt: now,
          },
        },
      ]),
      hasLiveSessionImplementation: () =>
        Effect.sync(() => {
          const readCount = livenessReadCount++;
          return readCount !== 1;
        }),
      reaperOptions: {
        inactivityThresholdMs: 60_000,
        deadSessionGraceMs: 1_000,
      },
    });
    const repository = await runtime!.runPromise(
      Effect.service(ProviderSessionRuntime.ProviderSessionRuntimeRepository),
    );
    await runtime!.runPromise(
      repository.upsert({
        threadId,
        providerName: "codex",
        providerInstanceId: null,
        adapterKey: "codex",
        runtimeMode: "full-access",
        status: "running",
        lastSeenAt: await runtime!.runPromise(idleForFiveSeconds),
        resumeCursor: { opaque: "resume-raced" },
        runtimePayload: null,
      }),
    );

    const reaper = await runtime!.runPromise(Effect.service(ProviderSessionReaper));
    scope = await runtime!.runPromise(Scope.make("sequential"));
    await runtime!.runPromise(reaper.start().pipe(Scope.provide(scope)));
    await runtime!.runPromise(drainFibers);

    expect(livenessReadCount).toBe(3);
    expect(harness.dispatch).not.toHaveBeenCalled();
    expect(harness.stopSession).not.toHaveBeenCalled();
  });
});
