// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  PROVIDER_SESSION_RESUME_SETTLED_ACTIVITY_KIND,
  type ProviderSessionResumeSettledActivityPayload,
  UNKNOWN_DRIVER_ATTACHMENT_CAPABILITY,
  type ChatAttachment,
  ModelSelection,
  ProviderRuntimeEvent,
  ProviderSession,
  ProviderDriverKind,
  ProviderInstanceId,
  SUBAGENT_STOP_ESCALATION_GRACE_MS,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import {
  ApprovalRequestId,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { afterEach, describe, expect, it, vi } from "@effect/vitest";

import { deriveServerPaths, ServerConfig } from "../../config.ts";
import { TextGenerationError } from "@t3tools/contracts";
import { ProviderAdapterRequestError } from "../../provider/Errors.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import {
  makeSqlitePersistenceLive,
  SqlitePersistenceMemory,
} from "../../persistence/Layers/Sqlite.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../../provider/Services/ProviderService.ts";
import { makeProviderRegistryLayer } from "../../provider/testUtils/providerRegistryMock.ts";
import { TextGeneration, type TextGenerationShape } from "../../textGeneration/TextGeneration.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { activityPayloadFields } from "../testUtils/activityPayload.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import {
  providerErrorLabel,
  providerErrorLabelFromInstanceHint,
  ProviderCommandReactorLive,
} from "./ProviderCommandReactor.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProviderCommandReactor } from "../Services/ProviderCommandReactor.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { QueuedTurnDeliveryReactor } from "../Services/QueuedTurnDeliveryReactor.ts";
import {
  QUEUED_DELIVERY_POLL_INTERVAL,
  QueuedTurnDeliveryReactorLive,
} from "./QueuedTurnDeliveryReactor.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import { ServerSettingsService } from "../../serverSettings.ts";
import { VcsStatusBroadcaster } from "../../vcs/VcsStatusBroadcaster.ts";
import * as GitWorkflowService from "../../git/GitWorkflowService.ts";

/**
 * Dispatch a command through the engine. Collapses the `engine.dispatch(...)`
 * call repeated throughout this file into one place.
 */
const dispatch = <C, A, E>(
  engine: { readonly dispatch: (command: C) => Effect.Effect<A, E> },
  command: C,
): Effect.Effect<A, E> => engine.dispatch(command);

const asProjectId = (value: string): ProjectId => ProjectId.make(value);
const asApprovalRequestId = (value: string): ApprovalRequestId => ApprovalRequestId.make(value);
const asMessageId = (value: string): MessageId => MessageId.make(value);
const asTurnId = (value: string): TurnId => TurnId.make(value);

/**
 * Poll a predicate on the real clock until it is true, or fail after
 * `timeoutMs`. The predicate may be plain or Effect-returning.
 */
const waitFor = <E = never>(
  predicate: () => boolean | Effect.Effect<boolean, E>,
  timeoutMs = 10_000,
): Effect.Effect<void, E> =>
  Effect.gen(function* () {
    const deadline = (yield* Clock.currentTimeMillis) + timeoutMs;
    while (true) {
      // Always cross a real async boundary before checking, even on the
      // first pass: the condition this polls for is often produced by a
      // background fiber (e.g. the reactor's command loop) that needs a
      // real tick to run before the predicate can see it.
      yield* Effect.sleep(0);
      const result = predicate();
      const ok = Effect.isEffect(result) ? yield* result : result;
      if (ok) {
        // Let cascading background-fiber work the predicate just observed
        // (e.g. a follow-up command dispatch and its projection update)
        // settle before the caller reads state right after this returns.
        yield* Effect.sleep(20);
        return;
      }
      if ((yield* Clock.currentTimeMillis) >= deadline) {
        return yield* Effect.die(new Error("Timed out waiting for expectation."));
      }
    }
  });

describe("ProviderCommandReactor", () => {
  const createdStateDirs = new Set<string>();
  const createdBaseDirs = new Set<string>();

  afterEach(() => {
    for (const stateDir of createdStateDirs) {
      NodeFS.rmSync(stateDir, { recursive: true, force: true });
    }
    createdStateDirs.clear();
    for (const baseDir of createdBaseDirs) {
      NodeFS.rmSync(baseDir, { recursive: true, force: true });
    }
    createdBaseDirs.clear();
  });

  describe("provider error attribution", () => {
    it("uses the current provider instance slug when current instance lookup fails", () => {
      expect(
        providerErrorLabelFromInstanceHint({
          instanceId: "codex_personal",
          modelSelectionInstanceId: "codex",
          sessionProvider: "codex",
        }),
      ).toBe("codex_personal");
    });

    it("uses the desired provider instance slug when desired instance lookup fails", () => {
      expect(
        providerErrorLabelFromInstanceHint({
          instanceId: "claude_openrouter",
        }),
      ).toBe("claude_openrouter");
    });

    it("uses the unknown driver kind when the resolved driver is not registered locally", () => {
      expect(providerErrorLabel("third_party_driver")).toBe("third_party_driver");
    });
  });

  const HARNESS_WORKTREE_PATH = "/tmp/provider-project-worktree";

  const createHarness = (input?: {
    readonly baseDir?: string;
    readonly threadModelSelection?: ModelSelection;
    readonly sessionModelSwitch?: "unsupported" | "in-session";
    readonly sessionResume?: "cursor" | "unsupported";
    readonly requiresNewThreadForModelChange?: boolean;
    readonly skillsRoot?: string;
    readonly projectWorkspaceRoot?: string;
    readonly providerSkills?: ReadonlyArray<{ readonly name: string; readonly enabled: boolean }>;
    readonly startSessionEffect?: (
      session: ProviderSession,
    ) => Effect.Effect<ProviderSession, ProviderAdapterRequestError>;
    readonly sendTurnEffect?: ProviderServiceShape["sendTurn"];
    readonly startQueuedTurnDelivery?: boolean;
    readonly useFilePersistence?: boolean;
    readonly useTestClock?: boolean;
  }) =>
    Effect.gen(function* () {
      // The reactor drops a thread's `worktreePath` when the directory is gone,
      // so a worktree a test attaches has to exist on disk to stay attached.
      NodeFS.mkdirSync(HARNESS_WORKTREE_PATH, { recursive: true });
      const now = "2026-01-01T00:00:00.000Z";
      const baseDir =
        input?.baseDir ?? NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-reactor-"));
      createdBaseDirs.add(baseDir);
      const { stateDir } = yield* deriveServerPaths(baseDir, undefined).pipe(
        Effect.provide(NodeServices.layer),
      );
      createdStateDirs.add(stateDir);
      const persistenceLayer = input?.useFilePersistence
        ? makeSqlitePersistenceLive(NodePath.join(stateDir, "state.sqlite"))
        : SqlitePersistenceMemory;
      const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();
      let nextSessionIndex = 1;
      const runtimeSessions: Array<ProviderSession> = [];
      const modelSelection = input?.threadModelSelection ?? {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      };
      const startSessionEffect = input?.startSessionEffect;
      const startSession = vi.fn<ProviderServiceShape["startSession"]>((_threadId, input) => {
        const sessionIndex = nextSessionIndex++;
        const inputModelSelection = input.modelSelection;
        const providerInstanceId = input.providerInstanceId ?? inputModelSelection?.instanceId;
        const session: ProviderSession = {
          provider:
            input.provider ??
            ProviderDriverKind.make(inputModelSelection?.instanceId ?? modelSelection.instanceId),
          ...(providerInstanceId ? { providerInstanceId } : {}),
          status: "ready" as const,
          runtimeMode: input.runtimeMode,
          ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
          ...((inputModelSelection?.model ?? modelSelection.model)
            ? { model: inputModelSelection?.model ?? modelSelection.model }
            : {}),
          threadId: input.threadId,
          resumeCursor: input.resumeCursor ?? { opaque: `resume-${sessionIndex}` },
          createdAt: now,
          updatedAt: now,
        };
        return (startSessionEffect?.(session) ?? Effect.succeed(session)).pipe(
          Effect.tap((startedSession) =>
            Effect.sync(() => {
              runtimeSessions.push(startedSession);
            }),
          ),
        );
      });
      const sendTurn = vi.fn<ProviderServiceShape["sendTurn"]>(
        input?.sendTurnEffect ??
          (() =>
            Effect.succeed({
              threadId: ThreadId.make("thread-1"),
              turnId: asTurnId("turn-1"),
            })),
      );
      const interruptTurn = vi.fn<ProviderServiceShape["interruptTurn"]>(() => Effect.void);
      const respondToRequest = vi.fn<ProviderServiceShape["respondToRequest"]>(() => Effect.void);
      const respondToUserInput = vi.fn<ProviderServiceShape["respondToUserInput"]>(
        () => Effect.void,
      );
      const stopSession = vi.fn<ProviderServiceShape["stopSession"]>(({ threadId }) =>
        Effect.sync(() => {
          const index = runtimeSessions.findIndex((session) => session.threadId === threadId);
          if (index >= 0) {
            runtimeSessions.splice(index, 1);
          }
        }),
      );
      const renameBranch = vi.fn<GitWorkflowService.GitWorkflowService["Service"]["renameBranch"]>(
        (input) => Effect.succeed({ branch: input.newBranch }),
      );
      const refreshStatus = vi.fn((_: string) =>
        Effect.succeed({
          isRepo: true,
          hasPrimaryRemote: true,
          isDefaultRef: false,
          refName: "renamed-branch",
          hasWorkingTreeChanges: false,
          workingTree: {
            files: [],
            insertions: 0,
            deletions: 0,
          },
          hasUpstream: true,
          aheadCount: 0,
          behindCount: 0,
          pr: null,
        }),
      );
      const generateBranchName = vi.fn<TextGenerationShape["generateBranchName"]>((_) =>
        Effect.fail(
          new TextGenerationError({
            operation: "generateBranchName",
            detail: "disabled in test harness",
          }),
        ),
      );
      const generateThreadTitle = vi.fn<TextGenerationShape["generateThreadTitle"]>((_) =>
        Effect.fail(
          new TextGenerationError({
            operation: "generateThreadTitle",
            detail: "disabled in test harness",
          }),
        ),
      );
      const providerSnapshots = [
        {
          instanceId: modelSelection.instanceId,
          ...(input?.requiresNewThreadForModelChange === true
            ? { requiresNewThreadForModelChange: true }
            : {}),
          ...(input?.providerSkills !== undefined ? { skills: input.providerSkills } : {}),
        },
      ];

      const unsupported = () => Effect.die(new Error("Unsupported provider call in test")) as never;
      const service: ProviderServiceShape = {
        startSession,
        sendTurn,
        interruptTurn,
        respondToRequest,
        respondToUserInput,
        stopSession,
        listSessions: () => Effect.succeed(runtimeSessions),
        hasLiveSession: (threadId) =>
          Effect.succeed(runtimeSessions.some((session) => session.threadId === threadId)),
        describeSessionResume: () => unsupported(),
        getCapabilities: (_provider) =>
          Effect.succeed({
            sessionModelSwitch: input?.sessionModelSwitch ?? "in-session",
            sessionLifecycle: { resume: input?.sessionResume ?? "cursor" },
            attachments: UNKNOWN_DRIVER_ATTACHMENT_CAPABILITY,
          }),
        getInstanceInfo: (instanceId) => {
          const raw = String(instanceId);
          const driverKind = ProviderDriverKind.make(
            raw.startsWith("claude") ? "claudeAgent" : raw.startsWith("codex") ? "codex" : raw,
          );
          return Effect.succeed({
            instanceId,
            driverKind,
            displayName: undefined,
            enabled: true,
            continuationIdentity: {
              driverKind,
              continuationKey:
                driverKind === ProviderDriverKind.make("codex")
                  ? "codex:home:/shared-codex"
                  : `${driverKind}:instance:${instanceId}`,
            },
          });
        },
        rollbackConversation: () => unsupported(),
        get streamEvents() {
          return Stream.fromPubSub(runtimeEventPubSub);
        },
      };

      const orchestrationLayer = OrchestrationEngineLive.pipe(
        Layer.provide(OrchestrationProjectionSnapshotQueryLive),
        Layer.provide(OrchestrationProjectionPipelineLive),
        Layer.provide(OrchestrationEventStoreLive),
        Layer.provide(OrchestrationCommandReceiptRepositoryLive),
        Layer.provide(RepositoryIdentityResolver.layer),
        Layer.provide(persistenceLayer),
      );
      const projectionSnapshotLayer = OrchestrationProjectionSnapshotQueryLive.pipe(
        Layer.provide(RepositoryIdentityResolver.layer),
        Layer.provide(persistenceLayer),
      );
      const liveLayer = ProviderCommandReactorLive.pipe(
        Layer.provideMerge(QueuedTurnDeliveryReactorLive),
        Layer.provideMerge(orchestrationLayer),
        Layer.provideMerge(projectionSnapshotLayer),
        Layer.provideMerge(Layer.succeed(ProviderService, service)),
        Layer.provideMerge(makeProviderRegistryLayer(providerSnapshots as never)),
        Layer.provideMerge(
          Layer.mock(GitWorkflowService.GitWorkflowService)({
            renameBranch,
          } satisfies Partial<GitWorkflowService.GitWorkflowService["Service"]>),
        ),
        Layer.provideMerge(
          Layer.succeed(VcsStatusBroadcaster, {
            getStatus: () => Effect.die("getStatus should not be called in this test"),
            peekStatus: () => Effect.die("peekStatus should not be called in this test"),
            refreshLocalStatus: () =>
              Effect.die("refreshLocalStatus should not be called in this test"),
            refreshStatus,
            streamStatus: () => Stream.die("streamStatus should not be called in this test"),
          }),
        ),
        Layer.provideMerge(
          Layer.mock(TextGeneration, {
            generateBranchName,
            generateThreadTitle,
          }),
        ),
        Layer.provideMerge(
          ServerSettingsService.layerTest(
            input?.skillsRoot !== undefined ? { skillsRoot: input.skillsRoot } : {},
          ),
        ),
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir)),
        Layer.provideMerge(NodeServices.layer),
      );
      const layer =
        input?.useTestClock === true
          ? liveLayer.pipe(Layer.provideMerge(TestClock.layer()))
          : liveLayer;

      // A forked child scope, not the ambient test scope directly: some tests
      // (the boot-restart test) need to close one harness's resources before
      // building a second harness against the same on-disk state.
      const parentScope = yield* Scope.Scope;
      const scope = yield* Scope.fork(parentScope, "sequential");
      const context = yield* Layer.build(layer).pipe(Scope.provide(scope));

      const engine = yield* Effect.service(OrchestrationEngineService).pipe(
        Effect.provide(context),
      );
      const snapshotQuery = yield* Effect.service(ProjectionSnapshotQuery).pipe(
        Effect.provide(context),
      );
      const reactor = yield* Effect.service(ProviderCommandReactor).pipe(Effect.provide(context));
      const queuedTurnDelivery = yield* Effect.service(QueuedTurnDeliveryReactor).pipe(
        Effect.provide(context),
      );
      yield* reactor.start().pipe(Scope.provide(scope));
      if (input?.startQueuedTurnDelivery === true) {
        yield* queuedTurnDelivery.start().pipe(Scope.provide(scope));
      }
      const drain = () => reactor.drain;
      const drainQueuedTurns = () => queuedTurnDelivery.drain;

      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-create"),
        projectId: asProjectId("project-1"),
        title: "Provider Project",
        workspaceRoot: input?.projectWorkspaceRoot ?? "/tmp/provider-project",
        defaultModelSelection: modelSelection,
        createdAt: now,
      });
      yield* engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-create"),
        threadId: ThreadId.make("thread-1"),
        projectId: asProjectId("project-1"),
        title: "Thread",
        modelSelection: modelSelection,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt: now,
      });

      return {
        engine,
        dispatch: (command: Parameters<typeof engine.dispatch>[0]) => engine.dispatch(command),
        readModel: () => snapshotQuery.getSnapshot(),
        startSession,
        sendTurn,
        interruptTurn,
        respondToRequest,
        respondToUserInput,
        stopSession,
        renameBranch,
        refreshStatus,
        generateBranchName,
        generateThreadTitle,
        runtimeSessions,
        stateDir,
        drain,
        drainQueuedTurns,
        dispose: () => Scope.close(scope, Exit.void),
        adjustClock: (duration: Duration.Input) =>
          TestClock.adjust(duration).pipe(Effect.provide(context)),
        setClock: (instant: number) => TestClock.setTime(instant).pipe(Effect.provide(context)),
      };
    });

  const prepareSubagentSteerHarness = (input?: {
    readonly includeProjectedSession?: boolean;
    readonly includeRuntimeSession?: boolean;
    readonly sendTurnEffect?: ProviderServiceShape["sendTurn"];
  }) =>
    Effect.gen(function* () {
      const harness = yield* createHarness(
        input?.sendTurnEffect !== undefined ? { sendTurnEffect: input.sendTurnEffect } : undefined,
      );
      const now = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));

      if (input?.includeRuntimeSession !== false) {
        harness.runtimeSessions.push({
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: ProviderInstanceId.make("codex"),
          status: "ready",
          runtimeMode: "approval-required",
          model: "gpt-5-codex",
          threadId: ThreadId.make("thread-1"),
          resumeCursor: { opaque: "resume-steer" },
          createdAt: now,
          updatedAt: now,
        });
      }

      if (input?.includeProjectedSession !== false) {
        yield* harness.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make("cmd-session-set-for-subagent-steer"),
          threadId: ThreadId.make("thread-1"),
          session: {
            threadId: ThreadId.make("thread-1"),
            status: "running",
            providerName: "codex",
            runtimeMode: "approval-required",
            activeTurnId: asTurnId("turn-1"),
            lastError: null,
            updatedAt: now,
          },
          createdAt: now,
        });
      }

      yield* harness.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make("cmd-subagent-started"),
        threadId: ThreadId.make("thread-1"),
        activity: {
          id: EventId.make("activity-subagent-started"),
          tone: "info",
          kind: "task.started",
          summary: "Inspect parser task started",
          payload: {
            taskId: "subagent-1",
            taskType: "local_agent",
            detail: "Inspect parser",
          },
          turnId: asTurnId("turn-1"),
          createdAt: now,
        },
        createdAt: now,
      });

      return { harness, now };
    });

  const prepareSubagentStopHarness = (input?: { readonly includeProjectedSession?: boolean }) =>
    Effect.gen(function* () {
      const harness = yield* createHarness({ useTestClock: true });
      const nowMillis = Date.parse("2026-01-01T00:00:00.000Z");
      yield* harness.setClock(nowMillis);
      const now = DateTime.formatIso(DateTime.makeUnsafe(nowMillis));

      harness.runtimeSessions.push({
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: ProviderInstanceId.make("codex"),
        status: "ready",
        runtimeMode: "approval-required",
        model: "gpt-5-codex",
        threadId: ThreadId.make("thread-1"),
        resumeCursor: { opaque: "resume-stop" },
        createdAt: now,
        updatedAt: now,
      });

      if (input?.includeProjectedSession !== false) {
        yield* harness.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make("cmd-session-set-for-subagent-stop"),
          threadId: ThreadId.make("thread-1"),
          session: {
            threadId: ThreadId.make("thread-1"),
            status: "running",
            providerName: "codex",
            runtimeMode: "approval-required",
            activeTurnId: asTurnId("turn-1"),
            lastError: null,
            updatedAt: now,
          },
          createdAt: now,
        });
      }

      yield* harness.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make("cmd-stop-subagent-started"),
        threadId: ThreadId.make("thread-1"),
        activity: {
          id: EventId.make("activity-stop-subagent-started"),
          tone: "info",
          kind: "task.started",
          summary: "Inspect parser task started",
          payload: { taskId: "subagent-1", taskType: "local_agent", detail: "Inspect parser" },
          turnId: asTurnId("turn-1"),
          createdAt: now,
        },
        createdAt: now,
      });

      return { harness, now };
    });

  it.live("delivers a stop instruction and escalates a still-running subagent", () =>
    Effect.gen(function* () {
      const { harness, now } = yield* prepareSubagentStopHarness();

      yield* harness.dispatch({
        type: "thread.subagent.stop",
        commandId: CommandId.make("stop-1"),
        threadId: ThreadId.make("thread-1"),
        subagentId: "subagent-1",
        createdAt: now,
      });
      yield* waitFor(() => harness.sendTurn.mock.calls.length === 1);
      expect(harness.sendTurn.mock.calls[0]?.[0]).toEqual({
        threadId: ThreadId.make("thread-1"),
        input:
          "[Stop request for subagent subagent-1 (Inspect parser)]\n" +
          "The user asked to stop this subagent now. End that work, collect what it completed, and report it. If it is still running in 30 seconds the whole turn will be interrupted.",
      });

      yield* harness.adjustClock(Duration.millis(SUBAGENT_STOP_ESCALATION_GRACE_MS));
      yield* waitFor(() => harness.interruptTurn.mock.calls.length === 1);
      // An in-process subagent has no thread of its own, so the escalation still
      // lands on the parent's turn. Pinned here because the thread-backed path
      // must never do this.
      expect(harness.interruptTurn.mock.calls[0]?.[0]).toEqual({
        threadId: ThreadId.make("thread-1"),
      });
      expect(harness.stopSession).not.toHaveBeenCalled();
      const thread = (yield* harness.readModel()).threads.find(
        (entry) => entry.id === ThreadId.make("thread-1"),
      );
      expect(
        thread?.activities.find((activity) => activity.kind === "subagent.stop.escalated"),
      ).toMatchObject({
        tone: "info",
        payload: { subagentId: "subagent-1", stopId: "stop-1" },
        turnId: asTurnId("turn-1"),
      });
    }),
  );

  it.live("does not escalate when the subagent completes during the grace period", () =>
    Effect.gen(function* () {
      const { harness, now } = yield* prepareSubagentStopHarness();
      yield* harness.dispatch({
        type: "thread.subagent.stop",
        commandId: CommandId.make("stop-completed"),
        threadId: ThreadId.make("thread-1"),
        subagentId: "subagent-1",
        createdAt: now,
      });
      yield* waitFor(() => harness.sendTurn.mock.calls.length === 1);
      yield* harness.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make("cmd-stop-subagent-completed"),
        threadId: ThreadId.make("thread-1"),
        activity: {
          id: EventId.make("activity-stop-subagent-completed"),
          tone: "info",
          kind: "task.completed",
          summary: "Subagent completed",
          payload: { taskId: "subagent-1", status: "completed" },
          turnId: asTurnId("turn-1"),
          createdAt: now,
        },
        createdAt: now,
      });

      yield* harness.adjustClock(Duration.millis(SUBAGENT_STOP_ESCALATION_GRACE_MS));
      yield* harness.drain();
      expect(harness.interruptTurn).not.toHaveBeenCalled();
      const thread = (yield* harness.readModel()).threads.find(
        (entry) => entry.id === ThreadId.make("thread-1"),
      );
      expect(
        thread?.activities.some((activity) => activity.kind === "subagent.stop.escalated"),
      ).toBe(false);
    }),
  );

  it.live("appends a failed stop activity when the thread has no projected session", () =>
    Effect.gen(function* () {
      const { harness, now } = yield* prepareSubagentStopHarness({
        includeProjectedSession: false,
      });
      yield* harness.dispatch({
        type: "thread.subagent.stop",
        commandId: CommandId.make("stop-no-session"),
        threadId: ThreadId.make("thread-1"),
        subagentId: "subagent-1",
        createdAt: now,
      });

      yield* waitFor(() =>
        Effect.gen(function* () {
          const thread = (yield* harness.readModel()).threads.find(
            (entry) => entry.id === ThreadId.make("thread-1"),
          );
          return (
            thread?.activities.some(
              (activity) => activity.kind === "provider.subagent.stop.failed",
            ) ?? false
          );
        }),
      );
      expect(harness.sendTurn).not.toHaveBeenCalled();
      const thread = (yield* harness.readModel()).threads.find(
        (entry) => entry.id === ThreadId.make("thread-1"),
      );
      expect(
        thread?.activities.find((activity) => activity.kind === "provider.subagent.stop.failed"),
      ).toMatchObject({
        tone: "error",
        payload: {
          subagentId: "subagent-1",
          stopId: "stop-no-session",
          detail: "No active provider session is bound to this thread.",
        },
      });
    }),
  );

  it.live("arms one escalation timer for duplicate stop activity events", () =>
    Effect.gen(function* () {
      const { harness, now } = yield* prepareSubagentStopHarness();
      const appendRequested = (suffix: string) =>
        harness.dispatch({
          type: "thread.activity.append",
          commandId: CommandId.make(`cmd-stop-duplicate-${suffix}`),
          threadId: ThreadId.make("thread-1"),
          activity: {
            id: EventId.make(`activity-stop-duplicate-${suffix}`),
            tone: "info",
            kind: "subagent.stop.requested",
            summary: "Stop requested",
            payload: { subagentId: "subagent-1", stopId: "duplicate-stop" },
            turnId: asTurnId("turn-1"),
            createdAt: now,
          },
          createdAt: now,
        });

      yield* appendRequested("one");
      yield* appendRequested("two");
      yield* waitFor(() => harness.sendTurn.mock.calls.length === 1);
      yield* harness.adjustClock(Duration.millis(SUBAGENT_STOP_ESCALATION_GRACE_MS));
      yield* waitFor(() => harness.interruptTurn.mock.calls.length === 1);
      expect(harness.sendTurn).toHaveBeenCalledTimes(1);
      expect(harness.interruptTurn).toHaveBeenCalledTimes(1);
    }),
  );

  const PARENT_THREAD_ID = ThreadId.make("thread-1");
  const CHILD_THREAD_ID = ThreadId.make("thread-child-1");

  /**
   * A parent whose `subagent-1` is thread-backed: it runs as `thread-child-1`,
   * which has its own provider session and its own turn.
   */
  const prepareThreadBackedStopHarness = (input?: { readonly childTurnRunning?: boolean }) =>
    Effect.gen(function* () {
      const harness = yield* createHarness({ useTestClock: true });
      const nowMillis = Date.parse("2026-01-01T00:00:00.000Z");
      yield* harness.setClock(nowMillis);
      const now = DateTime.formatIso(DateTime.makeUnsafe(nowMillis));

      yield* harness.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-create-child"),
        threadId: CHILD_THREAD_ID,
        projectId: asProjectId("project-1"),
        title: "Child",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt: now,
      });

      for (const [threadId, turnId] of [
        [PARENT_THREAD_ID, asTurnId("turn-1")],
        [CHILD_THREAD_ID, asTurnId("turn-child-1")],
      ] as const) {
        harness.runtimeSessions.push({
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: ProviderInstanceId.make("codex"),
          status: "ready",
          runtimeMode: "approval-required",
          model: "gpt-5-codex",
          threadId,
          resumeCursor: { opaque: `resume-${threadId}` },
          createdAt: now,
          updatedAt: now,
        });
        const childIsIdle = threadId === CHILD_THREAD_ID && input?.childTurnRunning === false;
        yield* harness.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make(`cmd-session-set-${threadId}`),
          threadId,
          session: {
            threadId,
            status: childIsIdle ? "ready" : "running",
            providerName: "codex",
            runtimeMode: "approval-required",
            activeTurnId: childIsIdle ? null : turnId,
            lastError: null,
            updatedAt: now,
          },
          createdAt: now,
        });
      }

      yield* harness.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make("cmd-child-subagent-started"),
        threadId: PARENT_THREAD_ID,
        activity: {
          id: EventId.make("activity-child-subagent-started"),
          tone: "info",
          kind: "task.started",
          summary: "Inspect parser task started",
          payload: { taskId: "subagent-1", taskType: "local_agent", detail: "Inspect parser" },
          turnId: asTurnId("turn-1"),
          createdAt: now,
        },
        createdAt: now,
      });
      yield* harness.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make("cmd-child-thread-linked"),
        threadId: PARENT_THREAD_ID,
        activity: {
          id: EventId.make("activity-child-thread-linked"),
          tone: "info",
          kind: "subagent.child-thread.linked",
          summary: "Subagent runs as a child thread",
          payload: { subagentId: "subagent-1", childThreadId: CHILD_THREAD_ID },
          turnId: asTurnId("turn-1"),
          createdAt: now,
        },
        createdAt: now,
      });

      return { harness, now };
    });

  it.live("stops a thread-backed subagent by interrupting the child, never the parent", () =>
    Effect.gen(function* () {
      const { harness, now } = yield* prepareThreadBackedStopHarness();

      yield* harness.dispatch({
        type: "thread.subagent.stop",
        commandId: CommandId.make("stop-child-1"),
        threadId: PARENT_THREAD_ID,
        subagentId: "subagent-1",
        createdAt: now,
      });

      yield* waitFor(() => harness.interruptTurn.mock.calls.length === 1);
      expect(harness.interruptTurn.mock.calls[0]?.[0]).toEqual({ threadId: CHILD_THREAD_ID });
      // The parent stays untouched: no stop instruction in its session, and no
      // interrupt of the turn that is waiting on this child's result.
      expect(harness.sendTurn).not.toHaveBeenCalled();

      yield* harness.adjustClock(Duration.millis(SUBAGENT_STOP_ESCALATION_GRACE_MS));
      yield* waitFor(() => harness.stopSession.mock.calls.length === 1);
      expect(harness.stopSession.mock.calls[0]?.[0]).toMatchObject({ threadId: CHILD_THREAD_ID });
      expect(harness.interruptTurn).toHaveBeenCalledTimes(1);

      const parent = (yield* harness.readModel()).threads.find(
        (entry) => entry.id === PARENT_THREAD_ID,
      );
      expect(
        parent?.activities.find((activity) => activity.kind === "subagent.stop.escalated"),
      ).toMatchObject({
        tone: "info",
        payload: { subagentId: "subagent-1", stopId: "stop-child-1" },
        turnId: asTurnId("turn-1"),
      });
    }),
  );

  it.live("does not stop a thread-backed child whose turn ended inside the grace", () =>
    Effect.gen(function* () {
      const { harness, now } = yield* prepareThreadBackedStopHarness({ childTurnRunning: false });

      yield* harness.dispatch({
        type: "thread.subagent.stop",
        commandId: CommandId.make("stop-child-idle"),
        threadId: PARENT_THREAD_ID,
        subagentId: "subagent-1",
        createdAt: now,
      });

      yield* waitFor(() => harness.interruptTurn.mock.calls.length === 1);
      yield* harness.adjustClock(Duration.millis(SUBAGENT_STOP_ESCALATION_GRACE_MS));
      yield* harness.drain();
      expect(harness.stopSession).not.toHaveBeenCalled();
      const parent = (yield* harness.readModel()).threads.find(
        (entry) => entry.id === PARENT_THREAD_ID,
      );
      expect(
        parent?.activities.some((activity) => activity.kind === "subagent.stop.escalated"),
      ).toBe(false);
    }),
  );

  it.live("queues a subagent follow-up on the live parent session and appends delivery", () =>
    Effect.gen(function* () {
      const { harness, now } = yield* prepareSubagentSteerHarness();

      yield* harness.dispatch({
        type: "thread.subagent.steer",
        commandId: CommandId.make("steer-1"),
        threadId: ThreadId.make("thread-1"),
        subagentId: "subagent-1",
        text: "Check the parser edge case",
        createdAt: now,
      });

      yield* waitFor(() => harness.sendTurn.mock.calls.length === 1);
      expect(harness.sendTurn.mock.calls[0]?.[0]).toEqual({
        threadId: ThreadId.make("thread-1"),
        input:
          "[Queued user follow-up for subagent subagent-1 (Inspect parser)]\n" +
          "This message arrived while that subagent was running. Apply it to the returned result, or resume the subagent if more work is needed:\n" +
          "Check the parser edge case",
      });

      yield* waitFor(() =>
        Effect.gen(function* () {
          const thread = (yield* harness.readModel()).threads.find(
            (entry) => entry.id === ThreadId.make("thread-1"),
          );
          return (
            thread?.activities.some((activity) => activity.kind === "subagent.steer.delivered") ??
            false
          );
        }),
      );
      const thread = (yield* harness.readModel()).threads.find(
        (entry) => entry.id === ThreadId.make("thread-1"),
      );
      expect(
        thread?.activities.find((activity) => activity.kind === "subagent.steer.delivered"),
      ).toMatchObject({
        tone: "info",
        summary: "Queued for parent",
        payload: { subagentId: "subagent-1", steerId: "steer-1" },
        turnId: asTurnId("turn-1"),
      });
    }),
  );

  it.live("appends a failed steer activity when the thread has no projected session", () =>
    Effect.gen(function* () {
      const { harness, now } = yield* prepareSubagentSteerHarness({
        includeProjectedSession: false,
        includeRuntimeSession: false,
      });

      yield* harness.dispatch({
        type: "thread.subagent.steer",
        commandId: CommandId.make("steer-no-session"),
        threadId: ThreadId.make("thread-1"),
        subagentId: "subagent-1",
        text: "Check the parser",
        createdAt: now,
      });

      yield* waitFor(() =>
        Effect.gen(function* () {
          const thread = (yield* harness.readModel()).threads.find(
            (entry) => entry.id === ThreadId.make("thread-1"),
          );
          return (
            thread?.activities.some(
              (activity) => activity.kind === "provider.subagent.steer.failed",
            ) ?? false
          );
        }),
      );
      expect(harness.sendTurn).not.toHaveBeenCalled();
      const thread = (yield* harness.readModel()).threads.find(
        (entry) => entry.id === ThreadId.make("thread-1"),
      );
      expect(
        thread?.activities.find((activity) => activity.kind === "provider.subagent.steer.failed"),
      ).toMatchObject({
        tone: "error",
        payload: {
          subagentId: "subagent-1",
          steerId: "steer-no-session",
          detail: "No active provider session is bound to this thread.",
        },
        turnId: asTurnId("turn-1"),
      });
    }),
  );

  it.live("does not create a provider session when the projected session is stale", () =>
    Effect.gen(function* () {
      const { harness, now } = yield* prepareSubagentSteerHarness({ includeRuntimeSession: false });

      yield* harness.dispatch({
        type: "thread.subagent.steer",
        commandId: CommandId.make("steer-stale-session"),
        threadId: ThreadId.make("thread-1"),
        subagentId: "subagent-1",
        text: "Check the parser",
        createdAt: now,
      });

      yield* waitFor(() =>
        Effect.gen(function* () {
          const thread = (yield* harness.readModel()).threads.find(
            (entry) => entry.id === ThreadId.make("thread-1"),
          );
          return (
            thread?.activities.some(
              (activity) => activity.kind === "provider.subagent.steer.failed",
            ) ?? false
          );
        }),
      );
      expect(harness.startSession).not.toHaveBeenCalled();
      expect(harness.sendTurn).not.toHaveBeenCalled();
    }),
  );

  it.live("delivers duplicate steer activity events only once", () =>
    Effect.gen(function* () {
      const { harness, now } = yield* prepareSubagentSteerHarness();
      const appendRequested = (suffix: string) =>
        harness.dispatch({
          type: "thread.activity.append",
          commandId: CommandId.make(`cmd-steer-duplicate-${suffix}`),
          threadId: ThreadId.make("thread-1"),
          activity: {
            id: EventId.make(`activity-steer-duplicate-${suffix}`),
            tone: "info",
            kind: "subagent.steer.requested",
            summary: "Queued user follow-up",
            payload: {
              subagentId: "subagent-1",
              text: "Check the parser",
              steerId: "duplicate-steer",
            },
            turnId: asTurnId("turn-1"),
            createdAt: now,
          },
          createdAt: now,
        });

      yield* appendRequested("one");
      yield* appendRequested("two");
      yield* harness.drain();

      expect(harness.sendTurn).toHaveBeenCalledTimes(1);
    }),
  );

  it.live("appends exact failure details when the provider rejects a steer", () =>
    Effect.gen(function* () {
      const { harness, now } = yield* prepareSubagentSteerHarness({
        sendTurnEffect: () =>
          Effect.fail(
            new ProviderAdapterRequestError({
              provider: ProviderDriverKind.make("codex"),
              method: "thread.turn.start",
              detail: "parent turn ended",
            }),
          ),
      });

      yield* harness.dispatch({
        type: "thread.subagent.steer",
        commandId: CommandId.make("steer-provider-failure"),
        threadId: ThreadId.make("thread-1"),
        subagentId: "subagent-1",
        text: "Check the parser",
        createdAt: now,
      });

      yield* waitFor(() =>
        Effect.gen(function* () {
          const thread = (yield* harness.readModel()).threads.find(
            (entry) => entry.id === ThreadId.make("thread-1"),
          );
          return (
            thread?.activities.some(
              (activity) => activity.kind === "provider.subagent.steer.failed",
            ) ?? false
          );
        }),
      );
      const thread = (yield* harness.readModel()).threads.find(
        (entry) => entry.id === ThreadId.make("thread-1"),
      );
      expect(
        thread?.activities.find((activity) => activity.kind === "provider.subagent.steer.failed"),
      ).toMatchObject({
        tone: "error",
        payload: {
          subagentId: "subagent-1",
          steerId: "steer-provider-failure",
          detail: expect.stringContaining("parent turn ended"),
        },
        turnId: asTurnId("turn-1"),
      });
    }),
  );

  it.live("reacts to thread.turn.start by ensuring session and sending provider turn", () =>
    Effect.gen(function* () {
      const harness = yield* createHarness();
      const now = "2026-01-01T00:00:00.000Z";

      yield* dispatch(harness.engine, {
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-1"),
          role: "user",
          text: "hello reactor",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      });

      yield* waitFor(() => harness.startSession.mock.calls.length === 1);
      yield* waitFor(() => harness.sendTurn.mock.calls.length === 1);
      expect(harness.startSession.mock.calls[0]?.[0]).toEqual(ThreadId.make("thread-1"));
      expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
        cwd: "/tmp/provider-project",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        runtimeMode: "approval-required",
      });

      const readModel = yield* harness.readModel();
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      expect(thread?.session?.threadId).toBe("thread-1");
      expect(thread?.session?.status).toBe("starting");
      expect(thread?.session?.runtimeMode).toBe("approval-required");
    }),
  );

  it.live("parks turn-boundary delivery until the active turn completes", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-1");
      const activeTurnId = asTurnId("turn-active-before-queued-message");
      const messageId = asMessageId("message-queued-until-turn-boundary");
      const startedAt = "2026-01-01T00:00:01.000Z";
      const harness = yield* createHarness({
        startQueuedTurnDelivery: true,
        useTestClock: true,
      });
      harness.runtimeSessions.push({
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: ProviderInstanceId.make("codex"),
        status: "running",
        runtimeMode: "approval-required",
        threadId,
        activeTurnId,
        cwd: "/tmp/provider-project",
        createdAt: startedAt,
        updatedAt: startedAt,
      });
      yield* harness.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-seed-running-turn-for-queued-delivery"),
        threadId,
        session: {
          threadId,
          status: "running",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "approval-required",
          activeTurnId,
          lastError: null,
          updatedAt: startedAt,
        },
        createdAt: startedAt,
      });
      const dispatchSpy = vi.spyOn(harness.engine, "dispatch");

      yield* harness.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-park-until-turn-boundary"),
        threadId,
        message: {
          messageId,
          role: "user",
          text: "send this after the current turn",
          attachments: [],
        },
        origin: "agent",
        delivery: "turn-boundary",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:02.000Z",
      });

      yield* waitFor(() =>
        Effect.gen(function* () {
          const thread = (yield* harness.readModel()).threads.find(
            (entry) => entry.id === threadId,
          );
          return (
            thread?.messages.find((message) => message.id === messageId)?.deliveryState === "queued"
          );
        }),
      );
      yield* harness.drain();
      let thread = (yield* harness.readModel()).threads.find((entry) => entry.id === threadId);
      expect(thread?.messages.find((message) => message.id === messageId)).toMatchObject({
        id: messageId,
        origin: "agent",
        deliveryState: "queued",
      });
      expect(harness.sendTurn).not.toHaveBeenCalled();

      yield* harness.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-complete-running-turn-for-queued-delivery"),
        threadId,
        session: {
          threadId,
          status: "ready",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: "2026-01-01T00:00:03.000Z",
        },
        createdAt: "2026-01-01T00:00:03.000Z",
      });
      yield* harness.adjustClock(QUEUED_DELIVERY_POLL_INTERVAL);
      yield* waitFor(() => harness.sendTurn.mock.calls.length === 1);
      yield* harness.drainQueuedTurns();
      yield* harness.drain();
      expect(harness.sendTurn).toHaveBeenCalledTimes(1);

      const redelivery = dispatchSpy.mock.calls
        .map(([command]) => command)
        .find(
          (command) =>
            command.type === "thread.turn.start" &&
            command.message.messageId === messageId &&
            command.delivery === undefined,
        );
      expect(redelivery).toMatchObject({
        type: "thread.turn.start",
        threadId,
        message: { messageId },
        origin: "agent",
      });
      thread = (yield* harness.readModel()).threads.find((entry) => entry.id === threadId);
      const deliveredMessages = thread?.messages.filter((message) => message.id === messageId);
      expect(deliveredMessages).toHaveLength(1);
      expect(deliveredMessages?.[0]?.deliveryState).toBeUndefined();
    }),
  );

  it.live("drains a queued turn-boundary message during the next boot", () =>
    Effect.gen(function* () {
      const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-reactor-restart-"));
      const threadId = ThreadId.make("thread-1");
      const activeTurnId = asTurnId("turn-active-before-restart");
      const messageId = asMessageId("message-queued-before-restart");
      const firstHarness = yield* createHarness({ baseDir, useFilePersistence: true });

      yield* firstHarness.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-seed-running-turn-before-restart"),
        threadId,
        session: {
          threadId,
          status: "running",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "approval-required",
          activeTurnId,
          lastError: null,
          updatedAt: "2026-01-01T00:00:01.000Z",
        },
        createdAt: "2026-01-01T00:00:01.000Z",
      });
      yield* firstHarness.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-park-before-restart"),
        threadId,
        message: {
          messageId,
          role: "user",
          text: "deliver this after restart",
          attachments: [],
        },
        delivery: "turn-boundary",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:02.000Z",
      });
      yield* firstHarness.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-complete-turn-before-restart"),
        threadId,
        session: {
          threadId,
          status: "ready",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: "2026-01-01T00:00:03.000Z",
        },
        createdAt: "2026-01-01T00:00:03.000Z",
      });
      const queuedThread = (yield* firstHarness.readModel()).threads.find(
        (entry) => entry.id === threadId,
      );
      expect(
        queuedThread?.messages.find((message) => message.id === messageId)?.deliveryState,
      ).toBe("queued");
      yield* firstHarness.drain();
      expect(firstHarness.sendTurn).not.toHaveBeenCalled();
      yield* firstHarness.dispose();

      const restartedHarness = yield* createHarness({
        baseDir,
        startQueuedTurnDelivery: true,
        useFilePersistence: true,
      });
      yield* waitFor(() => restartedHarness.sendTurn.mock.calls.length === 1);
      yield* restartedHarness.drainQueuedTurns();
      yield* restartedHarness.drain();
      expect(restartedHarness.sendTurn).toHaveBeenCalledTimes(1);

      const restartedThread = (yield* restartedHarness.readModel()).threads.find(
        (entry) => entry.id === threadId,
      );
      const deliveredMessages = restartedThread?.messages.filter(
        (message) => message.id === messageId,
      );
      expect(deliveredMessages).toHaveLength(1);
      expect(deliveredMessages?.[0]?.deliveryState).toBeUndefined();
    }),
  );

  it.live("adopts a steered turn result through the current running session", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-1");
      const turnId = asTurnId("turn-active-steer");
      const sessionUpdatedAt = "2026-01-01T00:00:01.000Z";
      const harness = yield* createHarness({
        sendTurnEffect: () =>
          Effect.succeed({
            threadId,
            turnId,
            steeredIntoActiveTurn: true,
          }),
      });
      const session = {
        threadId,
        status: "running" as const,
        providerName: "codex",
        providerInstanceId: ProviderInstanceId.make("codex"),
        runtimeMode: "approval-required" as const,
        activeTurnId: turnId,
        lastError: "preserve this",
        updatedAt: sessionUpdatedAt,
      };
      harness.runtimeSessions.push({
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: ProviderInstanceId.make("codex"),
        status: "running",
        runtimeMode: "approval-required",
        threadId,
        activeTurnId: turnId,
        cwd: "/tmp/provider-project",
        createdAt: sessionUpdatedAt,
        updatedAt: sessionUpdatedAt,
      });
      yield* harness.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-seed-active-steer"),
        threadId,
        session,
        createdAt: sessionUpdatedAt,
      });
      const dispatchSpy = vi.spyOn(harness.engine, "dispatch");

      yield* harness.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-adopt-active-steer"),
        threadId,
        message: {
          messageId: asMessageId("message-active-steer"),
          role: "user",
          text: "use the running turn",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:02.000Z",
      });

      yield* waitFor(() =>
        dispatchSpy.mock.calls.some(
          ([command]) =>
            command.type === "thread.session.set" && command.commandId !== "cmd-seed-active-steer",
        ),
      );
      yield* waitFor(() =>
        Effect.gen(function* () {
          const thread = (yield* harness.readModel()).threads.find(
            (entry) => entry.id === threadId,
          );
          return (
            thread?.messages.find((message) => message.id === "message-active-steer")?.turnId ===
            turnId
          );
        }),
      );
      const adoptedSessionSet = dispatchSpy.mock.calls
        .map(([command]) => command)
        .find((command) => command.type === "thread.session.set");
      expect(adoptedSessionSet).toMatchObject({
        type: "thread.session.set",
        threadId,
        session,
        createdAt: sessionUpdatedAt,
      });
    }),
  );

  it.live("attributes a steered message when the current session does not match", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-1");
      const currentTurnId = asTurnId("turn-current-before-steer");
      const steeredTurnId = asTurnId("turn-returned-steer");
      const sessionUpdatedAt = "2026-01-01T00:00:01.000Z";
      const harness = yield* createHarness({
        sendTurnEffect: () =>
          Effect.succeed({
            threadId,
            turnId: steeredTurnId,
            steeredIntoActiveTurn: true,
          }),
      });
      harness.runtimeSessions.push({
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: ProviderInstanceId.make("codex"),
        status: "running",
        runtimeMode: "approval-required",
        threadId,
        activeTurnId: currentTurnId,
        cwd: "/tmp/provider-project",
        createdAt: sessionUpdatedAt,
        updatedAt: sessionUpdatedAt,
      });
      yield* harness.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-seed-mismatched-steer"),
        threadId,
        session: {
          threadId,
          status: "running",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "approval-required",
          activeTurnId: currentTurnId,
          lastError: null,
          updatedAt: sessionUpdatedAt,
        },
        createdAt: sessionUpdatedAt,
      });
      const dispatchSpy = vi.spyOn(harness.engine, "dispatch");

      yield* harness.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-mismatched-steer"),
        threadId,
        message: {
          messageId: asMessageId("message-mismatched-steer"),
          role: "user",
          text: "attribute this genuine steer",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:02.000Z",
      });

      yield* waitFor(() =>
        Effect.gen(function* () {
          const thread = (yield* harness.readModel()).threads.find(
            (entry) => entry.id === threadId,
          );
          return (
            thread?.messages.find((message) => message.id === "message-mismatched-steer")
              ?.turnId === steeredTurnId
          );
        }),
      );
      yield* harness.drain();
      expect(
        dispatchSpy.mock.calls.filter(([command]) => command.type === "thread.session.set"),
      ).toHaveLength(0);
    }),
  );

  it.live("does not dispatch a session update for a fresh turn result", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-1");
      const turnId = asTurnId("turn-active-non-steer");
      const now = "2026-01-01T00:00:01.000Z";
      const harness = yield* createHarness({
        sendTurnEffect: () => Effect.succeed({ threadId, turnId }),
      });
      harness.runtimeSessions.push({
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: ProviderInstanceId.make("codex"),
        status: "running",
        runtimeMode: "approval-required",
        threadId,
        activeTurnId: turnId,
        cwd: "/tmp/provider-project",
        createdAt: now,
        updatedAt: now,
      });
      yield* harness.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-seed-non-steer"),
        threadId,
        session: {
          threadId,
          status: "running",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "approval-required",
          activeTurnId: turnId,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      });
      const dispatchSpy = vi.spyOn(harness.engine, "dispatch");

      yield* harness.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-non-steer-result"),
        threadId,
        message: {
          messageId: asMessageId("message-non-steer-result"),
          role: "user",
          text: "start normally",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:02.000Z",
      });

      yield* waitFor(() => harness.sendTurn.mock.calls.length === 1);
      yield* harness.drain();
      expect(
        dispatchSpy.mock.calls.filter(([command]) => command.type === "thread.session.set"),
      ).toHaveLength(0);
    }),
  );

  it.live(
    "expands registered slash skills only for OpenCode while preserving turn metadata and display",
    () =>
      Effect.gen(function* () {
        const skillsRoot = NodeFS.mkdtempSync(
          NodePath.join(NodeOS.tmpdir(), "t3code-reactor-skills-"),
        );
        createdBaseDirs.add(skillsRoot);
        const skillDirectory = NodePath.join(skillsRoot, "cook-it");
        NodeFS.mkdirSync(skillDirectory);
        NodeFS.writeFileSync(
          NodePath.join(skillDirectory, "SKILL.md"),
          "---\nname: cook-it\ndescription: Cook it\n---\nSkill instructions.\n",
        );
        const modelSelection = createModelSelection(
          ProviderInstanceId.make("opencode"),
          "opencode-model",
        );
        const harness = yield* createHarness({
          threadModelSelection: modelSelection,
          skillsRoot,
        });
        const attachment: ChatAttachment = {
          type: "image",
          id: "image-1",
          name: "proof.png",
          mimeType: "image/png",
          sizeBytes: 42,
        };

        yield* dispatch(harness.engine, {
          type: "thread.interaction-mode.set",
          commandId: CommandId.make("cmd-skill-interaction-mode"),
          threadId: ThreadId.make("thread-1"),
          interactionMode: "plan",
          createdAt: "2026-01-01T00:00:00.000Z",
        });
        yield* dispatch(harness.engine, {
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-turn-start-skill"),
          threadId: ThreadId.make("thread-1"),
          message: {
            messageId: asMessageId("user-message-skill"),
            role: "user",
            text: "/cook-it t3code-vst.17",
            attachments: [attachment],
          },
          modelSelection,
          interactionMode: "plan",
          runtimeMode: "approval-required",
          createdAt: "2026-01-01T00:00:00.000Z",
        });

        yield* waitFor(() => harness.sendTurn.mock.calls.length === 1);
        expect(harness.sendTurn.mock.calls[0]?.[0]).toEqual({
          threadId: ThreadId.make("thread-1"),
          input: expect.stringContaining(
            "The user invoked the /cook-it skill. Follow its instructions below.",
          ),
          attachments: [attachment],
          modelSelection,
          interactionMode: "plan",
        });
        expect(String(harness.sendTurn.mock.calls[0]![0].input)).toContain(
          "ARGUMENTS: t3code-vst.17",
        );
        const thread = (yield* harness.readModel()).threads.find(
          (entry) => entry.id === ThreadId.make("thread-1"),
        );
        expect(thread?.messages.at(-1)?.text).toBe("/cook-it t3code-vst.17");
      }),
  );

  it.live.each(["codex", "kimi", "claudeAgent"])(
    "passes slash skills through for %s sessions",
    (provider) =>
      Effect.gen(function* () {
        const skillsRoot = NodeFS.mkdtempSync(
          NodePath.join(NodeOS.tmpdir(), "t3code-reactor-skills-"),
        );
        createdBaseDirs.add(skillsRoot);
        const skillDirectory = NodePath.join(skillsRoot, "cook-it");
        NodeFS.mkdirSync(skillDirectory);
        NodeFS.writeFileSync(
          NodePath.join(skillDirectory, "SKILL.md"),
          "---\nname: cook-it\n---\nSkill instructions.\n",
        );
        const harness = yield* createHarness({
          threadModelSelection: createModelSelection(
            ProviderInstanceId.make(provider),
            "test-model",
          ),
          skillsRoot,
        });

        yield* dispatch(harness.engine, {
          type: "thread.turn.start",
          commandId: CommandId.make(`cmd-turn-start-${provider}`),
          threadId: ThreadId.make("thread-1"),
          message: {
            messageId: asMessageId(`user-message-${provider}`),
            role: "user",
            text: "/cook-it task",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: "2026-01-01T00:00:00.000Z",
        });

        yield* waitFor(() => harness.sendTurn.mock.calls.length === 1);
        expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({ input: "/cook-it task" });
      }),
  );

  it.live.each([
    "/unknown task",
    "$unknown task",
    "/cook-it-extra task",
    "/cook-it.foo",
    " /cook-it",
    " $cook-it",
  ])("passes non-matching OpenCode input through: %s", (messageText) =>
    Effect.gen(function* () {
      const skillsRoot = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3code-reactor-skills-"),
      );
      createdBaseDirs.add(skillsRoot);
      const skillDirectory = NodePath.join(skillsRoot, "cook-it");
      NodeFS.mkdirSync(skillDirectory);
      NodeFS.writeFileSync(
        NodePath.join(skillDirectory, "SKILL.md"),
        "---\nname: cook-it\n---\nSkill instructions.\n",
      );
      const harness = yield* createHarness({
        threadModelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "test-model",
        ),
        skillsRoot,
      });

      yield* dispatch(harness.engine, {
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-boundary-passthrough"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("message-boundary-passthrough"),
          role: "user",
          text: messageText,
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:00.000Z",
      });

      yield* waitFor(() => harness.sendTurn.mock.calls.length === 1);
      expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({ input: messageText.trim() });
    }),
  );

  it.live.each(["opencode", "kimi"])(
    "expands workspace skill invocations for %s sessions",
    (provider) =>
      Effect.gen(function* () {
        const skillsRoot = NodeFS.mkdtempSync(
          NodePath.join(NodeOS.tmpdir(), "t3code-reactor-skills-"),
        );
        createdBaseDirs.add(skillsRoot);
        const skillDirectory = NodePath.join(skillsRoot, "cook-it");
        NodeFS.mkdirSync(skillDirectory);
        NodeFS.writeFileSync(
          NodePath.join(skillDirectory, "SKILL.md"),
          "---\nname: cook-it\n---\nSkill instructions.\n",
        );
        const harness = yield* createHarness({
          threadModelSelection: createModelSelection(
            ProviderInstanceId.make(provider),
            "test-model",
          ),
          skillsRoot,
        });

        yield* harness.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make(`cmd-dollar-skill-${provider}`),
          threadId: ThreadId.make("thread-1"),
          message: {
            messageId: asMessageId(`message-dollar-skill-${provider}`),
            role: "user",
            text: "$cook-it t3code-vst.17",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: "2026-01-01T00:00:00.000Z",
        });

        yield* waitFor(() => harness.sendTurn.mock.calls.length === 1);
        const sent = harness.sendTurn.mock.calls[0]![0];
        expect(sent.input).toContain(
          "The user invoked the /cook-it skill. Follow its instructions below.",
        );
        expect(sent.input).toContain("ARGUMENTS: t3code-vst.17");
      }),
  );

  it.live(
    "rewrites a leading $skill to /skill for Claude when the provider reports the skill",
    () =>
      Effect.gen(function* () {
        const harness = yield* createHarness({
          threadModelSelection: createModelSelection(
            ProviderInstanceId.make("claudeAgent"),
            "claude-sonnet-5",
          ),
          providerSkills: [{ name: "pdf", enabled: true }],
        });

        yield* harness.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-claude-native-skill"),
          threadId: ThreadId.make("thread-1"),
          message: {
            messageId: asMessageId("message-claude-native-skill"),
            role: "user",
            text: "$pdf extract the tables",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: "2026-01-01T00:00:00.000Z",
        });

        yield* waitFor(() => harness.sendTurn.mock.calls.length === 1);
        expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
          input: "/pdf extract the tables",
        });
      }),
  );

  it.live("expands workspace $skills for Claude when the provider does not report them", () =>
    Effect.gen(function* () {
      const skillsRoot = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3code-reactor-skills-"),
      );
      createdBaseDirs.add(skillsRoot);
      const skillDirectory = NodePath.join(skillsRoot, "cook-it");
      NodeFS.mkdirSync(skillDirectory);
      NodeFS.writeFileSync(
        NodePath.join(skillDirectory, "SKILL.md"),
        "---\nname: cook-it\n---\nSkill instructions.\n",
      );
      const harness = yield* createHarness({
        threadModelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-sonnet-5",
        ),
        skillsRoot,
        providerSkills: [{ name: "pdf", enabled: true }],
      });

      yield* harness.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-claude-workspace-skill"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("message-claude-workspace-skill"),
          role: "user",
          text: "$cook-it task",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:00.000Z",
      });

      yield* waitFor(() => harness.sendTurn.mock.calls.length === 1);
      const sent = harness.sendTurn.mock.calls[0]![0];
      expect(sent.input).toContain(
        "The user invoked the /cook-it skill. Follow its instructions below.",
      );
    }),
  );

  it.live("prefers a project workspace skill over a global skill with the same name", () =>
    Effect.gen(function* () {
      const skillsRoot = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3code-reactor-skills-global-"),
      );
      createdBaseDirs.add(skillsRoot);
      const globalSkillDirectory = NodePath.join(skillsRoot, "cook-it");
      NodeFS.mkdirSync(globalSkillDirectory);
      NodeFS.writeFileSync(
        NodePath.join(globalSkillDirectory, "SKILL.md"),
        "---\nname: cook-it\n---\nGlobal instructions.\n",
      );

      const projectWorkspaceRoot = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3code-reactor-project-"),
      );
      createdBaseDirs.add(projectWorkspaceRoot);
      const projectSkillDirectory = NodePath.join(
        projectWorkspaceRoot,
        ".claude",
        "skills",
        "cook-it",
      );
      NodeFS.mkdirSync(projectSkillDirectory, { recursive: true });
      NodeFS.writeFileSync(
        NodePath.join(projectSkillDirectory, "SKILL.md"),
        "---\nname: cook-it\n---\nProject instructions.\n",
      );

      const harness = yield* createHarness({
        threadModelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-sonnet-5",
        ),
        skillsRoot,
        projectWorkspaceRoot,
        providerSkills: [],
      });

      yield* harness.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-project-skill-precedence"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("message-project-skill-precedence"),
          role: "user",
          text: "$cook-it task",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:00.000Z",
      });

      yield* waitFor(() => harness.sendTurn.mock.calls.length === 1);
      const sent = harness.sendTurn.mock.calls[0]![0];
      expect(sent.input).toContain("Project instructions.");
      expect(sent.input).not.toContain("Global instructions.");
    }),
  );

  it.live("passes unknown $tokens through for Claude", () =>
    Effect.gen(function* () {
      const harness = yield* createHarness({
        threadModelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-sonnet-5",
        ),
        providerSkills: [{ name: "pdf", enabled: true }],
      });

      yield* harness.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-claude-unknown-token"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("message-claude-unknown-token"),
          role: "user",
          text: "$HOME is where the heart is",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:00.000Z",
      });

      yield* waitFor(() => harness.sendTurn.mock.calls.length === 1);
      expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
        input: "$HOME is where the heart is",
      });
    }),
  );

  it.live.each([
    { text: "/cook-epic t3code-b93", expected: "/skill:cook-epic t3code-b93" },
    { text: "$cook-epic t3code-b93", expected: "/skill:cook-epic t3code-b93" },
    { text: "/plan-epic add Prime  support", expected: "/skill:plan-epic add Prime  support" },
    { text: "$plan-epic", expected: "/skill:plan-epic" },
    { text: "$skill:cook-epic t3code-b93", expected: "/skill:cook-epic t3code-b93" },
  ])("routes $text to Prime's native skill syntax", ({ text, expected }) =>
    Effect.gen(function* () {
      const skillsRoot = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3code-reactor-skills-"),
      );
      createdBaseDirs.add(skillsRoot);
      const harness = yield* createHarness({
        threadModelSelection: createModelSelection(
          ProviderInstanceId.make("primeAgent"),
          "anthropic/claude-opus-5",
        ),
        skillsRoot,
        providerSkills: [
          { name: "cook-epic", enabled: true },
          { name: "plan-epic", enabled: true },
          { name: "skill:cook-epic", enabled: true },
        ],
      });

      yield* harness.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-prime-native-skill"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("message-prime-native-skill"),
          role: "user",
          text,
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:00.000Z",
      });

      yield* waitFor(() => harness.sendTurn.mock.calls.length === 1);
      expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({ input: expected });
      const thread = (yield* harness.readModel()).threads.find(
        (entry) => entry.id === ThreadId.make("thread-1"),
      );
      expect(thread?.messages.at(-1)?.text).toBe(text);
    }),
  );

  it.live("keeps attachments and turn metadata on a Prime skill turn", () =>
    Effect.gen(function* () {
      const modelSelection = createModelSelection(
        ProviderInstanceId.make("primeAgent"),
        "anthropic/claude-opus-5",
      );
      const harness = yield* createHarness({
        threadModelSelection: modelSelection,
        providerSkills: [{ name: "cook-epic", enabled: true }],
      });
      const attachment: ChatAttachment = {
        type: "image",
        id: "image-1",
        name: "proof.png",
        mimeType: "image/png",
        sizeBytes: 42,
      };

      yield* harness.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-prime-skill-attachments"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("message-prime-skill-attachments"),
          role: "user",
          text: "$cook-epic t3code-b93",
          attachments: [attachment],
        },
        modelSelection,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:00.000Z",
      });

      yield* waitFor(() => harness.sendTurn.mock.calls.length === 1);
      expect(harness.sendTurn.mock.calls[0]?.[0]).toEqual({
        threadId: ThreadId.make("thread-1"),
        input: "/skill:cook-epic t3code-b93",
        attachments: [attachment],
        modelSelection,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      });
    }),
  );

  it.live("expands a workspace skill for Prime when Prime does not report it", () =>
    Effect.gen(function* () {
      const skillsRoot = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3code-reactor-skills-"),
      );
      createdBaseDirs.add(skillsRoot);
      const skillDirectory = NodePath.join(skillsRoot, "cook-it");
      NodeFS.mkdirSync(skillDirectory);
      NodeFS.writeFileSync(
        NodePath.join(skillDirectory, "SKILL.md"),
        "---\nname: cook-it\n---\nSkill instructions.\n",
      );
      const harness = yield* createHarness({
        threadModelSelection: createModelSelection(
          ProviderInstanceId.make("primeAgent"),
          "anthropic/claude-opus-5",
        ),
        skillsRoot,
        providerSkills: [{ name: "cook-epic", enabled: true }],
      });

      yield* harness.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-prime-workspace-skill"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("message-prime-workspace-skill"),
          role: "user",
          text: "/cook-it t3code-b93.10",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:00.000Z",
      });

      yield* waitFor(() => harness.sendTurn.mock.calls.length === 1);
      const sent = harness.sendTurn.mock.calls[0]![0];
      expect(sent.input).toContain(
        "The user invoked the /cook-it skill. Follow its instructions below.",
      );
      expect(sent.input).toContain("ARGUMENTS: t3code-b93.10");
    }),
  );

  it.live.each([
    " /cook-epic t3code-b93",
    " $cook-epic t3code-b93",
    "/cook-epic-extra t3code-b93",
    "/unknown task",
    "$unknown task",
    "run /cook-epic yourself",
  ])("passes non-matching Prime input through: %s", (messageText) =>
    Effect.gen(function* () {
      const skillsRoot = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3code-reactor-skills-"),
      );
      createdBaseDirs.add(skillsRoot);
      const harness = yield* createHarness({
        threadModelSelection: createModelSelection(
          ProviderInstanceId.make("primeAgent"),
          "anthropic/claude-opus-5",
        ),
        skillsRoot,
        providerSkills: [{ name: "cook-epic", enabled: true }],
      });

      yield* harness.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-prime-passthrough"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("message-prime-passthrough"),
          role: "user",
          text: messageText,
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:00.000Z",
      });

      yield* waitFor(() => harness.sendTurn.mock.calls.length === 1);
      expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({ input: messageText.trim() });
    }),
  );

  it.live("passes $skills through for Codex sessions", () =>
    Effect.gen(function* () {
      const skillsRoot = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3code-reactor-skills-"),
      );
      createdBaseDirs.add(skillsRoot);
      const skillDirectory = NodePath.join(skillsRoot, "cook-it");
      NodeFS.mkdirSync(skillDirectory);
      NodeFS.writeFileSync(
        NodePath.join(skillDirectory, "SKILL.md"),
        "---\nname: cook-it\n---\nSkill instructions.\n",
      );
      const harness = yield* createHarness({
        threadModelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5-codex"),
        skillsRoot,
      });

      yield* harness.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-codex-dollar-skill"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("message-codex-dollar-skill"),
          role: "user",
          text: "$cook-it task",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:00.000Z",
      });

      yield* waitFor(() => harness.sendTurn.mock.calls.length === 1);
      expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({ input: "$cook-it task" });
    }),
  );

  it.live("projects starting before a slow provider session finishes", () =>
    Effect.gen(function* () {
      const releaseStart = yield* Deferred.make<void>();
      const harness = yield* createHarness({
        startSessionEffect: (session) => Deferred.await(releaseStart).pipe(Effect.as(session)),
      });
      const now = "2026-01-01T00:00:00.000Z";

      yield* harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-slow-provider"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-slow-provider"),
          role: "user",
          text: "start slowly",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      });

      yield* waitFor(() => harness.startSession.mock.calls.length === 1);
      const duringStartup = yield* harness.readModel();
      expect(
        duringStartup.threads.find((entry) => entry.id === ThreadId.make("thread-1"))?.session
          ?.status,
      ).toBe("starting");
      expect(harness.sendTurn).not.toHaveBeenCalled();

      yield* Deferred.succeed(releaseStart, undefined);
      yield* waitFor(() => harness.sendTurn.mock.calls.length === 1);
    }),
  );

  it.live("settles a failed provider startup and allows a clean retry", () =>
    Effect.gen(function* () {
      let failStartup = true;
      const harness = yield* createHarness({
        startSessionEffect: (session) =>
          failStartup
            ? Effect.fail(
                new ProviderAdapterRequestError({
                  provider: "codex",
                  method: "thread.start",
                  detail: "deterministic startup failure",
                }),
              )
            : Effect.succeed(session),
      });
      const now = "2026-01-01T00:00:00.000Z";

      yield* harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-provider-failure"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-provider-failure"),
          role: "user",
          text: "fail once",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      });

      yield* waitFor(() =>
        Effect.gen(function* () {
          const readModel = yield* harness.readModel();
          return (
            readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"))?.session
              ?.status === "error"
          );
        }),
      );
      let readModel = yield* harness.readModel();
      let thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      expect(thread?.session?.lastError).toContain("deterministic startup failure");
      expect(harness.sendTurn).not.toHaveBeenCalled();

      failStartup = false;
      yield* harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-provider-retry"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-provider-retry"),
          role: "user",
          text: "retry",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:01.000Z",
      });

      yield* waitFor(() => harness.sendTurn.mock.calls.length === 1);
      readModel = yield* harness.readModel();
      thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      expect(thread?.session?.status).toBe("starting");
      expect(thread?.session?.lastError).toBeNull();
    }),
  );

  it.live("generates a thread title on the first turn", () =>
    Effect.gen(function* () {
      const harness = yield* createHarness();
      const now = "2026-01-01T00:00:00.000Z";
      const seededTitle = "Please investigate reconnect failures after restar...";
      harness.generateThreadTitle.mockReturnValue(Effect.succeed({ title: "Generated title" }));

      yield* dispatch(harness.engine, {
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-seed"),
        threadId: ThreadId.make("thread-1"),
        title: seededTitle,
      });

      yield* dispatch(harness.engine, {
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-title"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-title"),
          role: "user",
          text: "Please investigate reconnect failures after restarting the session.",
          attachments: [],
        },
        titleSeed: seededTitle,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      });

      yield* waitFor(() => harness.generateThreadTitle.mock.calls.length === 1);
      expect(harness.generateThreadTitle.mock.calls[0]?.[0]).toMatchObject({
        message: "Please investigate reconnect failures after restarting the session.",
      });

      yield* waitFor(() =>
        Effect.gen(function* () {
          const readModel = yield* harness.readModel();
          return (
            readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"))?.title ===
            "Generated title"
          );
        }),
      );
      const readModel = yield* harness.readModel();
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      expect(thread?.title).toBe("Generated title");
    }),
  );

  it.live("does not overwrite an existing custom thread title on the first turn", () =>
    Effect.gen(function* () {
      const harness = yield* createHarness();
      const now = "2026-01-01T00:00:00.000Z";
      const seededTitle = "Please investigate reconnect failures after restar...";

      yield* dispatch(harness.engine, {
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-custom"),
        threadId: ThreadId.make("thread-1"),
        title: "Keep this custom title",
      });

      yield* dispatch(harness.engine, {
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-title-preserve"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-title-preserve"),
          role: "user",
          text: "Please investigate reconnect failures after restarting the session.",
          attachments: [],
        },
        titleSeed: seededTitle,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      });

      yield* waitFor(() => harness.sendTurn.mock.calls.length === 1);
      expect(harness.generateThreadTitle).not.toHaveBeenCalled();

      const readModel = yield* harness.readModel();
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      expect(thread?.title).toBe("Keep this custom title");
    }),
  );

  it.live("matches the client-seeded title even when the outgoing prompt is reformatted", () =>
    Effect.gen(function* () {
      const harness = yield* createHarness();
      const now = "2026-01-01T00:00:00.000Z";
      const seededTitle = "Fix reconnect spinner on resume";
      harness.generateThreadTitle.mockReturnValue(
        Effect.succeed({
          title: "Reconnect spinner resume bug",
        }),
      );

      yield* dispatch(harness.engine, {
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-formatted-seed"),
        threadId: ThreadId.make("thread-1"),
        title: seededTitle,
      });

      yield* dispatch(harness.engine, {
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-title-formatted"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-title-formatted"),
          role: "user",
          text: "[effort:high]\\n\\nFix reconnect spinner on resume",
          attachments: [],
        },
        titleSeed: seededTitle,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      });

      yield* waitFor(() => harness.generateThreadTitle.mock.calls.length === 1);
      yield* waitFor(() =>
        Effect.gen(function* () {
          const readModel = yield* harness.readModel();
          return (
            readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"))?.title ===
            "Reconnect spinner resume bug"
          );
        }),
      );

      const readModel = yield* harness.readModel();
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      expect(thread?.title).toBe("Reconnect spinner resume bug");
    }),
  );

  it.live("generates a worktree branch name for the first turn", () =>
    Effect.gen(function* () {
      const harness = yield* createHarness();
      const now = "2026-01-01T00:00:00.000Z";

      yield* dispatch(harness.engine, {
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-branch"),
        threadId: ThreadId.make("thread-1"),
        branch: "t3code/1234abcd",
        worktreePath: HARNESS_WORKTREE_PATH,
      });

      harness.generateBranchName.mockImplementation((input) =>
        Effect.succeed({ branch: `feature/${input.modelSelection.model}` }),
      );

      yield* dispatch(harness.engine, {
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-branch-model"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-branch-model"),
          role: "user",
          text: "Add a safer reconnect backoff.",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      });

      yield* waitFor(() => harness.generateBranchName.mock.calls.length === 1);
      yield* waitFor(() => harness.refreshStatus.mock.calls.length === 1);
      expect(harness.generateBranchName.mock.calls[0]?.[0]).toMatchObject({
        message: "Add a safer reconnect backoff.",
      });
      expect(harness.refreshStatus.mock.calls[0]?.[0]).toBe("/tmp/provider-project-worktree");
    }),
  );

  it.live("forwards codex model options through session start and turn send", () =>
    Effect.gen(function* () {
      const harness = yield* createHarness();
      const now = "2026-01-01T00:00:00.000Z";

      yield* dispatch(harness.engine, {
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-fast"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-fast"),
          role: "user",
          text: "hello fast mode",
          attachments: [],
        },
        modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.3-codex", [
          { id: "reasoningEffort", value: "high" },
          { id: "fastMode", value: true },
        ]),
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      });

      yield* waitFor(() => harness.startSession.mock.calls.length === 1);
      yield* waitFor(() => harness.sendTurn.mock.calls.length === 1);
      expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
        modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.3-codex", [
          { id: "reasoningEffort", value: "high" },
          { id: "fastMode", value: true },
        ]),
      });
      expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
        threadId: ThreadId.make("thread-1"),
        modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.3-codex", [
          { id: "reasoningEffort", value: "high" },
          { id: "fastMode", value: true },
        ]),
      });
    }),
  );

  it.live("forwards claude effort options through session start and turn send", () =>
    Effect.gen(function* () {
      const harness = yield* createHarness({
        threadModelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-sonnet-4-6",
        },
      });
      const now = "2026-01-01T00:00:00.000Z";

      yield* dispatch(harness.engine, {
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-claude-effort"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-claude-effort"),
          role: "user",
          text: "hello with effort",
          attachments: [],
        },
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-sonnet-4-6",
          [{ id: "effort", value: "max" }],
        ),
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      });

      yield* waitFor(() => harness.startSession.mock.calls.length === 1);
      yield* waitFor(() => harness.sendTurn.mock.calls.length === 1);
      expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-sonnet-4-6",
          [{ id: "effort", value: "max" }],
        ),
      });
      expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
        threadId: ThreadId.make("thread-1"),
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-sonnet-4-6",
          [{ id: "effort", value: "max" }],
        ),
      });
    }),
  );

  it.live("forwards claude fast mode options through session start and turn send", () =>
    Effect.gen(function* () {
      const harness = yield* createHarness({
        threadModelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-opus-4-6",
        },
      });
      const now = "2026-01-01T00:00:00.000Z";

      yield* dispatch(harness.engine, {
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-claude-fast-mode"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-claude-fast-mode"),
          role: "user",
          text: "hello with fast mode",
          attachments: [],
        },
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-opus-4-6",
          [{ id: "fastMode", value: true }],
        ),
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      });

      yield* waitFor(() => harness.startSession.mock.calls.length === 1);
      yield* waitFor(() => harness.sendTurn.mock.calls.length === 1);
      expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-opus-4-6",
          [{ id: "fastMode", value: true }],
        ),
      });
      expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
        threadId: ThreadId.make("thread-1"),
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-opus-4-6",
          [{ id: "fastMode", value: true }],
        ),
      });
    }),
  );

  it.live("forwards plan interaction mode to the provider turn request", () =>
    Effect.gen(function* () {
      const harness = yield* createHarness();
      const now = "2026-01-01T00:00:00.000Z";

      yield* dispatch(harness.engine, {
        type: "thread.interaction-mode.set",
        commandId: CommandId.make("cmd-interaction-mode-set-plan"),
        threadId: ThreadId.make("thread-1"),
        interactionMode: "plan",
        createdAt: now,
      });

      yield* dispatch(harness.engine, {
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-plan"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-plan"),
          role: "user",
          text: "plan this change",
          attachments: [],
        },
        interactionMode: "plan",
        runtimeMode: "approval-required",
        createdAt: now,
      });

      yield* waitFor(() => harness.sendTurn.mock.calls.length === 1);
      expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
        threadId: ThreadId.make("thread-1"),
        interactionMode: "plan",
      });
    }),
  );

  it.live("preserves the active session model when in-session model switching is unsupported", () =>
    Effect.gen(function* () {
      const harness = yield* createHarness({ sessionModelSwitch: "unsupported" });
      const now = "2026-01-01T00:00:00.000Z";

      yield* dispatch(harness.engine, {
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-unsupported-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-unsupported-1"),
          role: "user",
          text: "first",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      });

      yield* waitFor(() => harness.sendTurn.mock.calls.length === 1);

      yield* dispatch(harness.engine, {
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-unsupported-2"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-unsupported-2"),
          role: "user",
          text: "second",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      });

      yield* waitFor(() => harness.sendTurn.mock.calls.length === 2);

      expect(harness.sendTurn.mock.calls[1]?.[0]).toMatchObject({
        threadId: ThreadId.make("thread-1"),
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
      });
    }),
  );

  it.live("rejects changing models after start when the provider requires a new thread", () =>
    Effect.gen(function* () {
      const harness = yield* createHarness({ requiresNewThreadForModelChange: true });
      const now = "2026-01-01T00:00:00.000Z";

      yield* harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-restricted-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-restricted-1"),
          role: "user",
          text: "first",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      });

      yield* waitFor(() => harness.sendTurn.mock.calls.length === 1);

      yield* harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-restricted-2"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-restricted-2"),
          role: "user",
          text: "second",
          attachments: [],
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.1-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      });

      yield* waitFor(() =>
        Effect.gen(function* () {
          const readModel = yield* harness.readModel();
          const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
          return (
            thread?.activities.some((activity) => activity.kind === "provider.turn.start.failed") ??
            false
          );
        }),
      );

      expect(harness.sendTurn).toHaveBeenCalledTimes(1);
      const readModel = yield* harness.readModel();
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      expect(
        thread?.activities.find((activity) => activity.kind === "provider.turn.start.failed"),
      ).toMatchObject({
        payload: {
          detail: expect.stringContaining(
            "cannot switch models after the conversation has started",
          ),
        },
      });
    }),
  );

  it.live(
    "starts a first turn on the requested provider instance even when it differs from the thread model",
    () =>
      Effect.gen(function* () {
        const harness = yield* createHarness({
          threadModelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
        });
        const now = "2026-01-01T00:00:00.000Z";

        yield* dispatch(harness.engine, {
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-turn-start-provider-first"),
          threadId: ThreadId.make("thread-1"),
          message: {
            messageId: asMessageId("user-message-provider-first"),
            role: "user",
            text: "hello claude",
            attachments: [],
          },
          modelSelection: {
            instanceId: ProviderInstanceId.make("claudeAgent"),
            model: "claude-opus-4-6",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: now,
        });

        yield* waitFor(() => harness.sendTurn.mock.calls.length === 1);

        expect(harness.startSession).toHaveBeenCalledTimes(1);
        expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
          provider: ProviderDriverKind.make("claudeAgent"),
          providerInstanceId: ProviderInstanceId.make("claudeAgent"),
          modelSelection: {
            instanceId: ProviderInstanceId.make("claudeAgent"),
            model: "claude-opus-4-6",
          },
        });

        const readModel = yield* harness.readModel();
        const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
        expect(thread?.session?.providerName).toBe("claudeAgent");
        expect(thread?.session?.providerInstanceId).toBe(ProviderInstanceId.make("claudeAgent"));
        expect(
          thread?.activities.find((activity) => activity.kind === "provider.turn.start.failed"),
        ).toBeUndefined();
      }),
  );

  it.live("reuses the same provider session when runtime mode is unchanged", () =>
    Effect.gen(function* () {
      const harness = yield* createHarness();
      const now = "2026-01-01T00:00:00.000Z";

      yield* dispatch(harness.engine, {
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-unchanged-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-unchanged-1"),
          role: "user",
          text: "first",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      });

      yield* waitFor(() => harness.startSession.mock.calls.length === 1);
      yield* waitFor(() => harness.sendTurn.mock.calls.length === 1);

      yield* dispatch(harness.engine, {
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-unchanged-2"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-unchanged-2"),
          role: "user",
          text: "second",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      });

      yield* waitFor(() => harness.sendTurn.mock.calls.length === 2);
      expect(harness.startSession.mock.calls.length).toBe(1);
      expect(harness.stopSession.mock.calls.length).toBe(0);
    }),
  );

  it.live("restarts an existing Codex thread on a compatible requested instance", () =>
    Effect.gen(function* () {
      const harness = yield* createHarness();
      const now = "2026-01-01T00:00:00.000Z";

      yield* dispatch(harness.engine, {
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-compatible-codex-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-compatible-codex-1"),
          role: "user",
          text: "first",
          attachments: [],
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      });

      yield* waitFor(() => harness.sendTurn.mock.calls.length === 1);

      yield* dispatch(harness.engine, {
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-compatible-codex-2"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-compatible-codex-2"),
          role: "user",
          text: "second",
          attachments: [],
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex_work"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:00.000Z",
      });

      yield* waitFor(() => harness.sendTurn.mock.calls.length === 2);

      expect(harness.startSession).toHaveBeenCalledTimes(2);
      expect(harness.startSession.mock.calls[1]?.[1]).toMatchObject({
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: ProviderInstanceId.make("codex_work"),
        resumeCursor: { opaque: "resume-1" },
      });

      const readModel = yield* harness.readModel();
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      expect(thread?.session?.providerInstanceId).toBe(ProviderInstanceId.make("codex_work"));
    }),
  );

  it.live("restarts the provider session when the thread workspace changes", () =>
    Effect.gen(function* () {
      const harness = yield* createHarness({
        threadModelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-sonnet-4-6",
        },
      });
      const now = "2026-01-01T00:00:00.000Z";

      yield* dispatch(harness.engine, {
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-workspace-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-workspace-1"),
          role: "user",
          text: "first in project root",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      });

      yield* waitFor(() => harness.startSession.mock.calls.length === 1);
      yield* waitFor(() => harness.sendTurn.mock.calls.length === 1);
      expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
        cwd: "/tmp/provider-project",
      });

      yield* dispatch(harness.engine, {
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-worktree-change"),
        threadId: ThreadId.make("thread-1"),
        worktreePath: HARNESS_WORKTREE_PATH,
      });

      yield* dispatch(harness.engine, {
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-workspace-2"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-workspace-2"),
          role: "user",
          text: "second in worktree",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      });

      yield* waitFor(() => harness.startSession.mock.calls.length === 2);
      yield* waitFor(() => harness.sendTurn.mock.calls.length === 2);
      expect(harness.stopSession.mock.calls.length).toBe(0);
      expect(harness.startSession.mock.calls[1]?.[1]).toMatchObject({
        threadId: ThreadId.make("thread-1"),
        cwd: HARNESS_WORKTREE_PATH,
        resumeCursor: { opaque: "resume-1" },
        modelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-sonnet-4-6",
        },
        runtimeMode: "approval-required",
      });
    }),
  );

  it.live("falls back to the project root and clears a worktree path that is gone", () =>
    Effect.gen(function* () {
      const harness = yield* createHarness();
      const now = "2026-01-01T00:00:00.000Z";
      // An epic worker's worktree, deleted by the runner after the child landed.
      const deletedWorktree = "/tmp/provider-project-worktree-deleted";
      NodeFS.rmSync(deletedWorktree, { recursive: true, force: true });

      yield* dispatch(harness.engine, {
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-worktree-deleted"),
        threadId: ThreadId.make("thread-1"),
        worktreePath: deletedWorktree,
      });

      yield* dispatch(harness.engine, {
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-worktree-deleted"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-worktree-deleted"),
          role: "user",
          text: "hello?",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      });

      yield* waitFor(() => harness.startSession.mock.calls.length === 1);

      // The provider is started in the project root, not the deleted directory.
      expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
        cwd: "/tmp/provider-project",
      });

      // And the dead path is dropped, so checkpointing and vcs status stop
      // resolving to it too.
      yield* waitFor(() =>
        Effect.gen(function* () {
          const readModel = yield* harness.readModel();
          const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
          return thread?.worktreePath === null;
        }),
      );
    }),
  );

  it.live("restarts claude sessions when claude effort changes", () =>
    Effect.gen(function* () {
      const harness = yield* createHarness({
        threadModelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-sonnet-4-6",
        },
      });
      const now = "2026-01-01T00:00:00.000Z";

      yield* dispatch(harness.engine, {
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-claude-effort-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-claude-effort-1"),
          role: "user",
          text: "first claude turn",
          attachments: [],
        },
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-sonnet-4-6",
          [{ id: "effort", value: "medium" }],
        ),
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      });

      yield* waitFor(() => harness.startSession.mock.calls.length === 1);
      yield* waitFor(() => harness.sendTurn.mock.calls.length === 1);

      yield* dispatch(harness.engine, {
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-claude-effort-2"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-claude-effort-2"),
          role: "user",
          text: "second claude turn",
          attachments: [],
        },
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-sonnet-4-6",
          [{ id: "effort", value: "max" }],
        ),
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      });

      yield* waitFor(() => harness.startSession.mock.calls.length === 2);
      yield* waitFor(() => harness.sendTurn.mock.calls.length === 2);
      expect(harness.startSession.mock.calls[1]?.[1]).toMatchObject({
        resumeCursor: { opaque: "resume-1" },
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-sonnet-4-6",
          [{ id: "effort", value: "max" }],
        ),
      });
    }),
  );

  it.live("restarts the provider session when runtime mode is updated on the thread", () =>
    Effect.gen(function* () {
      const harness = yield* createHarness();
      const now = "2026-01-01T00:00:00.000Z";

      yield* dispatch(harness.engine, {
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("cmd-runtime-mode-set-initial-full-access"),
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "full-access",
        createdAt: now,
      });

      yield* dispatch(harness.engine, {
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-runtime-mode-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-runtime-mode-1"),
          role: "user",
          text: "first",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        createdAt: now,
      });

      yield* waitFor(() => harness.startSession.mock.calls.length === 1);
      yield* waitFor(() => harness.sendTurn.mock.calls.length === 1);

      yield* dispatch(harness.engine, {
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("cmd-runtime-mode-set-1"),
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "approval-required",
        createdAt: now,
      });

      yield* waitFor(() =>
        Effect.gen(function* () {
          const readModel = yield* harness.readModel();
          const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
          return thread?.runtimeMode === "approval-required";
        }),
      );
      yield* waitFor(() => harness.startSession.mock.calls.length === 2);
      yield* dispatch(harness.engine, {
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-runtime-mode-2"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-runtime-mode-2"),
          role: "user",
          text: "second",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        createdAt: now,
      });

      yield* waitFor(() => harness.sendTurn.mock.calls.length === 2);

      expect(harness.stopSession.mock.calls.length).toBe(0);
      expect(harness.startSession.mock.calls[1]?.[1]).toMatchObject({
        threadId: ThreadId.make("thread-1"),
        resumeCursor: { opaque: "resume-1" },
        runtimeMode: "approval-required",
      });
      expect(harness.sendTurn.mock.calls[1]?.[0]).toMatchObject({
        threadId: ThreadId.make("thread-1"),
      });

      const readModel = yield* harness.readModel();
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      expect(thread?.session?.threadId).toBe("thread-1");
      expect(thread?.session?.runtimeMode).toBe("approval-required");
    }),
  );

  it.live(
    "does not inject derived model options when restarting claude on runtime mode changes",
    () =>
      Effect.gen(function* () {
        const harness = yield* createHarness({
          threadModelSelection: {
            instanceId: ProviderInstanceId.make("claudeAgent"),
            model: "claude-opus-4-6",
          },
        });
        const now = "2026-01-01T00:00:00.000Z";

        yield* dispatch(harness.engine, {
          type: "thread.session.set",
          commandId: CommandId.make("cmd-session-set-runtime-mode-claude"),
          threadId: ThreadId.make("thread-1"),
          session: {
            threadId: ThreadId.make("thread-1"),
            status: "ready",
            providerName: "claudeAgent",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: now,
          },
          createdAt: now,
        });

        yield* dispatch(harness.engine, {
          type: "thread.runtime-mode.set",
          commandId: CommandId.make("cmd-runtime-mode-set-claude-no-options"),
          threadId: ThreadId.make("thread-1"),
          runtimeMode: "approval-required",
          createdAt: now,
        });

        yield* waitFor(() => harness.startSession.mock.calls.length === 1);

        expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
          modelSelection: {
            instanceId: ProviderInstanceId.make("claudeAgent"),
            model: "claude-opus-4-6",
          },
          runtimeMode: "approval-required",
        });
      }),
  );

  it.live("does not stop the active session when restart fails before rebind", () =>
    Effect.gen(function* () {
      const harness = yield* createHarness();
      const now = "2026-01-01T00:00:00.000Z";

      yield* dispatch(harness.engine, {
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("cmd-runtime-mode-set-initial-full-access-2"),
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "full-access",
        createdAt: now,
      });

      yield* dispatch(harness.engine, {
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-restart-failure-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-restart-failure-1"),
          role: "user",
          text: "first",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        createdAt: now,
      });

      yield* waitFor(() => harness.startSession.mock.calls.length === 1);
      yield* waitFor(() => harness.sendTurn.mock.calls.length === 1);

      harness.startSession.mockImplementationOnce(
        () => Effect.fail("simulated restart failure") as never,
      );

      yield* dispatch(harness.engine, {
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("cmd-runtime-mode-set-restart-failure"),
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "approval-required",
        createdAt: now,
      });

      yield* waitFor(() =>
        Effect.gen(function* () {
          const readModel = yield* harness.readModel();
          const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
          return thread?.runtimeMode === "approval-required";
        }),
      );
      yield* waitFor(() => harness.startSession.mock.calls.length === 2);
      yield* harness.drain();

      expect(harness.stopSession.mock.calls.length).toBe(0);
      expect(harness.sendTurn.mock.calls.length).toBe(1);

      const readModel = yield* harness.readModel();
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      expect(thread?.session?.threadId).toBe("thread-1");
      expect(thread?.session?.runtimeMode).toBe("full-access");
    }),
  );

  it.live("rejects provider changes after a thread is already bound to a session provider", () =>
    Effect.gen(function* () {
      const harness = yield* createHarness();
      const now = "2026-01-01T00:00:00.000Z";

      yield* dispatch(harness.engine, {
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-provider-switch-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-provider-switch-1"),
          role: "user",
          text: "first",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      });

      yield* waitFor(() => harness.startSession.mock.calls.length === 1);
      yield* waitFor(() => harness.sendTurn.mock.calls.length === 1);

      yield* dispatch(harness.engine, {
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-provider-switch-2"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-provider-switch-2"),
          role: "user",
          text: "second",
          attachments: [],
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-opus-4-6",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      });

      yield* waitFor(() =>
        Effect.gen(function* () {
          const readModel = yield* harness.readModel();
          const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
          return (
            thread?.activities.some((activity) => activity.kind === "provider.turn.start.failed") ??
            false
          );
        }),
      );

      expect(harness.startSession.mock.calls.length).toBe(1);
      expect(harness.sendTurn.mock.calls.length).toBe(1);
      expect(harness.stopSession.mock.calls.length).toBe(0);

      const readModel = yield* harness.readModel();
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      expect(thread?.session?.threadId).toBe("thread-1");
      expect(thread?.session?.providerName).toBe("codex");
      expect(thread?.session?.runtimeMode).toBe("approval-required");
      expect(
        thread?.activities.find((activity) => activity.kind === "provider.turn.start.failed"),
      ).toMatchObject({
        payload: {
          detail: expect.stringContaining("cannot switch to 'claudeAgent'"),
        },
      });
    }),
  );

  it.live(
    "rejects cross-driver provider changes after the existing thread session has stopped",
    () =>
      Effect.gen(function* () {
        const harness = yield* createHarness();
        const now = "2026-01-01T00:00:00.000Z";

        yield* dispatch(harness.engine, {
          type: "thread.session.set",
          commandId: CommandId.make("cmd-session-set-stopped-provider-switch"),
          threadId: ThreadId.make("thread-1"),
          session: {
            threadId: ThreadId.make("thread-1"),
            status: "stopped",
            providerName: "codex",
            providerInstanceId: ProviderInstanceId.make("codex"),
            runtimeMode: "approval-required",
            activeTurnId: null,
            lastError: null,
            updatedAt: now,
          },
          createdAt: now,
        });

        yield* dispatch(harness.engine, {
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-turn-start-stopped-provider-switch"),
          threadId: ThreadId.make("thread-1"),
          message: {
            messageId: asMessageId("user-message-stopped-provider-switch"),
            role: "user",
            text: "continue with claude",
            attachments: [],
          },
          modelSelection: {
            instanceId: ProviderInstanceId.make("claudeAgent"),
            model: "claude-opus-4-6",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: now,
        });

        yield* waitFor(() =>
          Effect.gen(function* () {
            const readModel = yield* harness.readModel();
            const thread = readModel.threads.find(
              (entry) => entry.id === ThreadId.make("thread-1"),
            );
            return (
              thread?.activities.some(
                (activity) => activity.kind === "provider.turn.start.failed",
              ) ?? false
            );
          }),
        );

        expect(harness.startSession.mock.calls.length).toBe(0);
        expect(harness.sendTurn.mock.calls.length).toBe(0);
        const readModel = yield* harness.readModel();
        const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
        expect(
          thread?.activities.find((activity) => activity.kind === "provider.turn.start.failed"),
        ).toMatchObject({
          payload: {
            detail: expect.stringContaining("cannot switch to 'claudeAgent'"),
          },
        });
      }),
  );

  it.live("reacts to thread.turn.interrupt-requested by calling provider interrupt", () =>
    Effect.gen(function* () {
      const harness = yield* createHarness();
      const now = "2026-01-01T00:00:00.000Z";

      yield* dispatch(harness.engine, {
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-1"),
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      });

      yield* dispatch(harness.engine, {
        type: "thread.turn.interrupt",
        commandId: CommandId.make("cmd-turn-interrupt"),
        threadId: ThreadId.make("thread-1"),
        turnId: asTurnId("turn-1"),
        createdAt: now,
      });

      yield* waitFor(() => harness.interruptTurn.mock.calls.length === 1);
      expect(harness.interruptTurn.mock.calls[0]?.[0]).toEqual({
        threadId: "thread-1",
        turnId: "turn-1",
      });
    }),
  );

  it.live("does not interrupt a newer active turn for an older targeted request", () =>
    Effect.gen(function* () {
      const harness = yield* createHarness();
      const now = "2026-01-01T00:00:00.000Z";

      yield* dispatch(harness.engine, {
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-newer-turn"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-2"),
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      });

      yield* dispatch(harness.engine, {
        type: "thread.turn.interrupt",
        commandId: CommandId.make("cmd-turn-interrupt-old-turn"),
        threadId: ThreadId.make("thread-1"),
        turnId: asTurnId("turn-1"),
        createdAt: now,
      });

      yield* harness.drain();
      expect(harness.interruptTurn).not.toHaveBeenCalled();
    }),
  );

  it.live("uses the live provider turn to reject a stale targeted interrupt", () =>
    Effect.gen(function* () {
      const harness = yield* createHarness();
      const now = "2026-01-01T00:00:00.000Z";
      harness.runtimeSessions.push({
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: ProviderInstanceId.make("codex"),
        status: "running",
        runtimeMode: "approval-required",
        threadId: ThreadId.make("thread-1"),
        activeTurnId: asTurnId("turn-2"),
        createdAt: now,
        updatedAt: now,
      });
      yield* dispatch(harness.engine, {
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-stale-projection"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-1"),
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      });

      yield* dispatch(harness.engine, {
        type: "thread.turn.interrupt",
        commandId: CommandId.make("cmd-turn-interrupt-stale-live"),
        threadId: ThreadId.make("thread-1"),
        turnId: asTurnId("turn-1"),
        createdAt: now,
      });

      yield* harness.drain();
      expect(harness.interruptTurn).not.toHaveBeenCalled();
    }),
  );

  it.live("starts a fresh session when only projected session state exists", () =>
    Effect.gen(function* () {
      const harness = yield* createHarness();
      const now = "2026-01-01T00:00:00.000Z";

      yield* dispatch(harness.engine, {
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-stale"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      });

      yield* dispatch(harness.engine, {
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-stale"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-stale"),
          role: "user",
          text: "resume codex",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      });

      yield* waitFor(() => harness.startSession.mock.calls.length === 1);
      yield* waitFor(() => harness.sendTurn.mock.calls.length === 1);

      expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
        threadId: ThreadId.make("thread-1"),
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        runtimeMode: "approval-required",
      });
      expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
        threadId: ThreadId.make("thread-1"),
      });
    }),
  );

  it.live("rejects active runtime sessions that are missing provider instance ids", () =>
    Effect.gen(function* () {
      const harness = yield* createHarness();
      const now = "2026-01-01T00:00:00.000Z";

      yield* dispatch(harness.engine, {
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-missing-instance"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      });
      harness.runtimeSessions.push({
        provider: ProviderDriverKind.make("codex"),
        status: "ready",
        runtimeMode: "approval-required",
        threadId: ThreadId.make("thread-1"),
        cwd: "/tmp/provider-project",
        resumeCursor: { opaque: "resume-without-instance" },
        createdAt: now,
        updatedAt: now,
      });

      yield* dispatch(harness.engine, {
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-missing-instance"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-missing-instance"),
          role: "user",
          text: "resume codex",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      });

      yield* waitFor(() =>
        Effect.gen(function* () {
          const readModel = yield* harness.readModel();
          const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
          return (
            thread?.activities.some((activity) => activity.kind === "provider.turn.start.failed") ??
            false
          );
        }),
      );

      expect(harness.startSession.mock.calls.length).toBe(0);
      expect(harness.sendTurn.mock.calls.length).toBe(0);
      const readModel = yield* harness.readModel();
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      expect(
        thread?.activities.find((activity) => activity.kind === "provider.turn.start.failed"),
      ).toMatchObject({
        payload: {
          detail: expect.stringContaining("without a provider instance id"),
        },
      });
    }),
  );

  it.live("reacts to thread.approval.respond by forwarding provider approval response", () =>
    Effect.gen(function* () {
      const harness = yield* createHarness();
      const now = "2026-01-01T00:00:00.000Z";

      yield* dispatch(harness.engine, {
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-for-approval"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      });

      yield* dispatch(harness.engine, {
        type: "thread.approval.respond",
        commandId: CommandId.make("cmd-approval-respond"),
        threadId: ThreadId.make("thread-1"),
        requestId: asApprovalRequestId("approval-request-1"),
        decision: "accept",
        createdAt: now,
      });

      yield* waitFor(() => harness.respondToRequest.mock.calls.length === 1);
      expect(harness.respondToRequest.mock.calls[0]?.[0]).toEqual({
        threadId: "thread-1",
        requestId: "approval-request-1",
        decision: "accept",
      });
    }),
  );

  it.live("reacts to thread.user-input.respond by forwarding structured user input answers", () =>
    Effect.gen(function* () {
      const harness = yield* createHarness();
      const now = "2026-01-01T00:00:00.000Z";

      yield* dispatch(harness.engine, {
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-for-user-input"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      });

      yield* dispatch(harness.engine, {
        type: "thread.user-input.respond",
        commandId: CommandId.make("cmd-user-input-respond"),
        threadId: ThreadId.make("thread-1"),
        requestId: asApprovalRequestId("user-input-request-1"),
        answers: {
          sandbox_mode: "workspace-write",
        },
        createdAt: now,
      });

      yield* waitFor(() => harness.respondToUserInput.mock.calls.length === 1);
      expect(harness.respondToUserInput.mock.calls[0]?.[0]).toEqual({
        threadId: "thread-1",
        requestId: "user-input-request-1",
        answers: {
          sandbox_mode: "workspace-write",
        },
      });
    }),
  );

  it.live(
    "surfaces stale provider approval request failures without faking approval resolution",
    () =>
      Effect.gen(function* () {
        const harness = yield* createHarness();
        const now = "2026-01-01T00:00:00.000Z";
        harness.respondToRequest.mockImplementation(() =>
          Effect.fail(
            new ProviderAdapterRequestError({
              provider: ProviderDriverKind.make("codex"),
              method: "session/request_permission",
              detail: "Unknown pending permission request: approval-request-1",
            }),
          ),
        );

        yield* dispatch(harness.engine, {
          type: "thread.session.set",
          commandId: CommandId.make("cmd-session-set-for-approval-error"),
          threadId: ThreadId.make("thread-1"),
          session: {
            threadId: ThreadId.make("thread-1"),
            status: "running",
            providerName: "codex",
            runtimeMode: "approval-required",
            activeTurnId: null,
            lastError: null,
            updatedAt: now,
          },
          createdAt: now,
        });

        yield* dispatch(harness.engine, {
          type: "thread.activity.append",
          commandId: CommandId.make("cmd-approval-requested"),
          threadId: ThreadId.make("thread-1"),
          activity: {
            id: EventId.make("activity-approval-requested"),
            tone: "approval",
            kind: "approval.requested",
            summary: "Command approval requested",
            payload: {
              requestId: "approval-request-1",
              requestKind: "command",
            },
            turnId: null,
            createdAt: now,
          },
          createdAt: now,
        });

        yield* dispatch(harness.engine, {
          type: "thread.approval.respond",
          commandId: CommandId.make("cmd-approval-respond-stale"),
          threadId: ThreadId.make("thread-1"),
          requestId: asApprovalRequestId("approval-request-1"),
          decision: "acceptForSession",
          createdAt: now,
        });

        yield* waitFor(() =>
          Effect.gen(function* () {
            const readModel = yield* harness.readModel();
            const thread = readModel.threads.find(
              (entry) => entry.id === ThreadId.make("thread-1"),
            );
            if (!thread) return false;
            return thread.activities.some(
              (activity) => activity.kind === "provider.approval.respond.failed",
            );
          }),
        );

        const readModel = yield* harness.readModel();
        const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
        expect(thread).toBeDefined();

        const failureActivity = thread?.activities.find(
          (activity) => activity.kind === "provider.approval.respond.failed",
        );
        expect(failureActivity).toBeDefined();
        expect(failureActivity?.payload).toMatchObject({
          requestId: "approval-request-1",
          detail: expect.stringContaining("Stale pending approval request: approval-request-1"),
        });

        const resolvedActivity = thread?.activities.find(
          (activity) =>
            activity.kind === "approval.resolved" &&
            activityPayloadFields(activity.payload)?.requestId === "approval-request-1",
        );
        expect(resolvedActivity).toBeUndefined();
      }),
  );

  it.live("surfaces non-resumable provider user-input callbacks as stale failures", () =>
    Effect.gen(function* () {
      const harness = yield* createHarness();
      const now = "2026-01-01T00:00:00.000Z";
      harness.respondToUserInput.mockImplementation(() =>
        Effect.fail(
          new ProviderAdapterRequestError({
            provider: ProviderDriverKind.make("claudeAgent"),
            method: "item/tool/respondToUserInput",
            detail: "Unknown pending Codex user input request: user-input-request-1",
          }),
        ),
      );

      yield* dispatch(harness.engine, {
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-for-user-input-error"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "claudeAgent",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      });

      yield* dispatch(harness.engine, {
        type: "thread.activity.append",
        commandId: CommandId.make("cmd-user-input-requested"),
        threadId: ThreadId.make("thread-1"),
        activity: {
          id: EventId.make("activity-user-input-requested"),
          tone: "info",
          kind: "user-input.requested",
          summary: "User input requested",
          payload: {
            requestId: "user-input-request-1",
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
          turnId: null,
          createdAt: now,
        },
        createdAt: now,
      });

      yield* dispatch(harness.engine, {
        type: "thread.user-input.respond",
        commandId: CommandId.make("cmd-user-input-respond-stale"),
        threadId: ThreadId.make("thread-1"),
        requestId: asApprovalRequestId("user-input-request-1"),
        answers: {
          sandbox_mode: "workspace-write",
        },
        createdAt: now,
      });

      yield* waitFor(() =>
        Effect.gen(function* () {
          const readModel = yield* harness.readModel();
          const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
          if (!thread) return false;
          return thread.activities.some(
            (activity) => activity.kind === "provider.user-input.respond.failed",
          );
        }),
      );

      const readModel = yield* harness.readModel();
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      expect(thread).toBeDefined();

      const failureActivity = thread?.activities.find(
        (activity) => activity.kind === "provider.user-input.respond.failed",
      );
      expect(failureActivity).toBeDefined();
      expect(failureActivity?.payload).toMatchObject({
        requestId: "user-input-request-1",
        detail: expect.stringContaining("Stale pending user-input request: user-input-request-1"),
      });

      const resolvedActivity = thread?.activities.find(
        (activity) =>
          activity.kind === "user-input.resolved" &&
          activityPayloadFields(activity.payload)?.requestId === "user-input-request-1",
      );
      expect(resolvedActivity).toBeUndefined();
    }),
  );

  it.live(
    "reacts to thread.session.stop by stopping provider session and clearing thread session state",
    () =>
      Effect.gen(function* () {
        const harness = yield* createHarness();
        const now = "2026-01-01T00:00:00.000Z";

        yield* harness.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make("cmd-session-set-for-stop"),
          threadId: ThreadId.make("thread-1"),
          session: {
            threadId: ThreadId.make("thread-1"),
            status: "ready",
            providerName: "codex",
            providerInstanceId: ProviderInstanceId.make("codex_work"),
            runtimeMode: "approval-required",
            activeTurnId: null,
            lastError: "existing provider error",
            updatedAt: now,
          },
          createdAt: now,
        });

        yield* harness.engine.dispatch({
          type: "thread.session.stop",
          commandId: CommandId.make("cmd-session-stop"),
          threadId: ThreadId.make("thread-1"),
          createdAt: now,
        });

        yield* waitFor(() => harness.stopSession.mock.calls.length === 1);
        const readModel = yield* harness.readModel();
        const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
        expect(thread?.session).not.toBeNull();
        expect(thread?.session?.status).toBe("stopped");
        expect(thread?.session?.threadId).toBe("thread-1");
        expect(thread?.session?.providerInstanceId).toBe(ProviderInstanceId.make("codex_work"));
        expect(thread?.session?.activeTurnId).toBeNull();
        expect(thread?.session?.lastError).toBe("existing provider error");
      }),
  );

  it.live("uses a session-stop reason as the stopped session error", () =>
    Effect.gen(function* () {
      const harness = yield* createHarness();
      const now = "2026-01-01T00:00:00.000Z";

      yield* harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-for-reasoned-stop"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex_work"),
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: "existing provider error",
          updatedAt: now,
        },
        createdAt: now,
      });

      yield* harness.engine.dispatch({
        type: "thread.session.stop",
        commandId: CommandId.make("cmd-session-stop-reasoned"),
        threadId: ThreadId.make("thread-1"),
        createdAt: now,
        reason: "session reaped: no live provider process",
      });

      yield* waitFor(() => harness.stopSession.mock.calls.length === 1);
      const readModel = yield* harness.readModel();
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      expect(thread?.session?.status).toBe("stopped");
      expect(thread?.session?.lastError).toBe("session reaped: no live provider process");
    }),
  );
  describe("thread.session.resume", () => {
    const RESUME_KIND = PROVIDER_SESSION_RESUME_SETTLED_ACTIVITY_KIND;
    const now = "2026-01-01T00:00:00.000Z";

    const readResumeOutcome = (harness: Effect.Success<ReturnType<typeof createHarness>>) =>
      Effect.gen(function* () {
        const thread = (yield* harness.readModel()).threads.find(
          (entry) => entry.id === ThreadId.make("thread-1"),
        );
        const activity = thread?.activities.find((entry) => entry.kind === RESUME_KIND);
        return activity?.payload as ProviderSessionResumeSettledActivityPayload | undefined;
      });

    const requestResume = (
      harness: Effect.Success<ReturnType<typeof createHarness>>,
      commandId: string,
    ) =>
      Effect.gen(function* () {
        yield* harness.dispatch({
          type: "thread.session.resume",
          commandId: CommandId.make(commandId),
          threadId: ThreadId.make("thread-1"),
          createdAt: now,
        });
        yield* waitFor(() =>
          Effect.gen(function* () {
            return (yield* readResumeOutcome(harness)) !== undefined;
          }),
        );
        return (yield* readResumeOutcome(harness))!;
      });

    it.live("refuses on capability without starting a session", () =>
      Effect.gen(function* () {
        const harness = yield* createHarness({ sessionResume: "unsupported" });

        const settled = yield* requestResume(harness, "cmd-resume-unsupported");

        expect(settled.outcome).toEqual({
          _tag: "capability",
          detail: "Provider instance 'codex' cannot resume a past conversation.",
        });
        expect(settled.requestCommandId).toBe("cmd-resume-unsupported");
        // The whole point of the capability read: an adapter that cannot honour
        // a cursor never gets to start a session that looks like a resume.
        expect(harness.startSession).not.toHaveBeenCalled();
        expect(harness.sendTurn).not.toHaveBeenCalled();
      }),
    );

    it.live("stops the session and refuses when the provider started fresh", () =>
      Effect.gen(function* () {
        const harness = yield* createHarness({
          startSessionEffect: (session) =>
            Effect.succeed({ ...session, sessionOrigin: "started-fresh" as const }),
        });

        const settled = yield* requestResume(harness, "cmd-resume-started-fresh");

        expect(settled.outcome).toMatchObject({
          _tag: "not-continued",
          origin: "started-fresh",
        });
        // No prompt was sent, so the lost conversation costs nothing more.
        expect(harness.sendTurn).not.toHaveBeenCalled();
        yield* waitFor(() => harness.stopSession.mock.calls.length === 1);
        const thread = (yield* harness.readModel()).threads.find(
          (entry) => entry.id === ThreadId.make("thread-1"),
        );
        expect(thread?.session?.status).toBe("stopped");
      }),
    );

    it.live("treats an absent origin exactly like a fresh start", () =>
      Effect.gen(function* () {
        const harness = yield* createHarness();

        const settled = yield* requestResume(harness, "cmd-resume-absent-origin");

        // Absent is unknown, never resumed: an adapter that reports nothing
        // must not be believed.
        expect(settled.outcome).toMatchObject({ _tag: "not-continued", origin: "unknown" });
        expect(harness.sendTurn).not.toHaveBeenCalled();
        yield* waitFor(() => harness.stopSession.mock.calls.length === 1);
      }),
    );

    it.live("refuses with no durable state when the provider started a new conversation", () =>
      Effect.gen(function* () {
        const harness = yield* createHarness({
          startSessionEffect: (session) =>
            Effect.succeed({ ...session, sessionOrigin: "started" as const }),
        });

        const settled = yield* requestResume(harness, "cmd-resume-started");

        // `started` means the adapter was handed no cursor at all.
        expect(settled.outcome).toMatchObject({ _tag: "no-durable-state" });
        expect(harness.sendTurn).not.toHaveBeenCalled();
        yield* waitFor(() => harness.stopSession.mock.calls.length === 1);
      }),
    );

    it.live("resumes and keeps the session bound when the conversation continued", () =>
      Effect.gen(function* () {
        const harness = yield* createHarness({
          startSessionEffect: (session) =>
            Effect.succeed({ ...session, sessionOrigin: "resumed" as const }),
        });

        const settled = yield* requestResume(harness, "cmd-resume-ok");

        expect(settled.outcome).toEqual({ _tag: "resumed" });
        expect(harness.startSession).toHaveBeenCalledTimes(1);
        expect(harness.stopSession).not.toHaveBeenCalled();
        const thread = (yield* harness.readModel()).threads.find(
          (entry) => entry.id === ThreadId.make("thread-1"),
        );
        expect(thread?.session?.status).toBe("ready");
        expect(thread?.session?.providerInstanceId).toBe("codex");
      }),
    );
  });
});
