// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
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
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { it as effectIt } from "@effect/vitest";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { deriveServerPaths, ServerConfig } from "../../config.ts";
import { TextGenerationError } from "@t3tools/contracts";
import { ProviderAdapterRequestError } from "../../provider/Errors.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../../provider/Services/ProviderService.ts";
import { makeProviderRegistryLayer } from "../../provider/testUtils/providerRegistryMock.ts";
import { TextGeneration, type TextGenerationShape } from "../../textGeneration/TextGeneration.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
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
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import { ServerSettingsService } from "../../serverSettings.ts";
import { VcsStatusBroadcaster } from "../../vcs/VcsStatusBroadcaster.ts";
import * as GitWorkflowService from "../../git/GitWorkflowService.ts";

/**
 * Dispatch a command through the engine and await it. Collapses the
 * `Effect.runPromise(engine.dispatch(...))` wrapper repeated throughout
 * this file into one place.
 */
const dispatch = <C, A, E>(
  engine: { readonly dispatch: (command: C) => Effect.Effect<A, E> },
  command: C,
): Promise<A> => Effect.runPromise(engine.dispatch(command));

const asProjectId = (value: string): ProjectId => ProjectId.make(value);
const asApprovalRequestId = (value: string): ApprovalRequestId => ApprovalRequestId.make(value);
const asMessageId = (value: string): MessageId => MessageId.make(value);
const asTurnId = (value: string): TurnId => TurnId.make(value);

const deriveServerPathsSync = (baseDir: string, devUrl: URL | undefined) =>
  Effect.runSync(deriveServerPaths(baseDir, devUrl).pipe(Effect.provide(NodeServices.layer)));

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 10_000,
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

describe("ProviderCommandReactor", () => {
  let runtime: ManagedRuntime.ManagedRuntime<
    OrchestrationEngineService | ProviderCommandReactor | ProjectionSnapshotQuery,
    unknown
  > | null = null;
  let scope: Scope.Closeable | null = null;
  const createdStateDirs = new Set<string>();
  const createdBaseDirs = new Set<string>();

  afterEach(async () => {
    if (scope) {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
    scope = null;
    if (runtime) {
      await runtime.dispose();
    }
    runtime = null;
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

  async function createHarness(input?: {
    readonly baseDir?: string;
    readonly threadModelSelection?: ModelSelection;
    readonly sessionModelSwitch?: "unsupported" | "in-session";
    readonly requiresNewThreadForModelChange?: boolean;
    readonly skillsRoot?: string;
    readonly providerSkills?: ReadonlyArray<{ readonly name: string; readonly enabled: boolean }>;
    readonly startSessionEffect?: (
      session: ProviderSession,
    ) => Effect.Effect<ProviderSession, ProviderAdapterRequestError>;
    readonly sendTurnEffect?: ProviderServiceShape["sendTurn"];
    readonly useTestClock?: boolean;
  }) {
    // The reactor drops a thread's `worktreePath` when the directory is gone,
    // so a worktree a test attaches has to exist on disk to stay attached.
    NodeFS.mkdirSync(HARNESS_WORKTREE_PATH, { recursive: true });
    const now = "2026-01-01T00:00:00.000Z";
    const baseDir =
      input?.baseDir ?? NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-reactor-"));
    createdBaseDirs.add(baseDir);
    const { stateDir } = deriveServerPathsSync(baseDir, undefined);
    createdStateDirs.add(stateDir);
    const runtimeEventPubSub = Effect.runSync(PubSub.unbounded<ProviderRuntimeEvent>());
    let nextSessionIndex = 1;
    const runtimeSessions: Array<ProviderSession> = [];
    const modelSelection = input?.threadModelSelection ?? {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5-codex",
    };
    const startSessionEffect = input?.startSessionEffect;
    const startSession = vi.fn((_: unknown, input: unknown) => {
      const sessionIndex = nextSessionIndex++;
      const resumeCursor =
        typeof input === "object" && input !== null && "resumeCursor" in input
          ? input.resumeCursor
          : undefined;
      const threadId =
        typeof input === "object" &&
        input !== null &&
        "threadId" in input &&
        typeof input.threadId === "string"
          ? ThreadId.make(input.threadId)
          : ThreadId.make(`thread-${sessionIndex}`);
      const inputModelSelection =
        typeof input === "object" && input !== null && "modelSelection" in input
          ? (input.modelSelection as ModelSelection | undefined)
          : undefined;
      const providerInstanceId =
        typeof input === "object" && input !== null && "providerInstanceId" in input
          ? (input.providerInstanceId as ProviderInstanceId | undefined)
          : inputModelSelection?.instanceId;
      const provider =
        typeof input === "object" &&
        input !== null &&
        "provider" in input &&
        typeof input.provider === "string"
          ? (input.provider as ProviderSession["provider"])
          : ProviderDriverKind.make(inputModelSelection?.instanceId ?? modelSelection.instanceId);
      const session: ProviderSession = {
        provider,
        ...(providerInstanceId ? { providerInstanceId } : {}),
        status: "ready" as const,
        runtimeMode:
          typeof input === "object" &&
          input !== null &&
          "runtimeMode" in input &&
          (input.runtimeMode === "approval-required" || input.runtimeMode === "full-access")
            ? input.runtimeMode
            : "full-access",
        ...(typeof input === "object" &&
        input !== null &&
        "cwd" in input &&
        typeof input.cwd === "string"
          ? { cwd: input.cwd }
          : {}),
        ...((inputModelSelection?.model ?? modelSelection.model)
          ? { model: inputModelSelection?.model ?? modelSelection.model }
          : {}),
        threadId,
        resumeCursor: resumeCursor ?? { opaque: `resume-${sessionIndex}` },
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
    const sendTurn = vi.fn(
      input?.sendTurnEffect ??
        ((_: unknown) =>
          Effect.succeed({
            threadId: ThreadId.make("thread-1"),
            turnId: asTurnId("turn-1"),
          })),
    );
    const interruptTurn = vi.fn((_: unknown) => Effect.void);
    const respondToRequest = vi.fn<ProviderServiceShape["respondToRequest"]>(() => Effect.void);
    const respondToUserInput = vi.fn<ProviderServiceShape["respondToUserInput"]>(() => Effect.void);
    const stopSession = vi.fn((input: unknown) =>
      Effect.sync(() => {
        const threadId =
          typeof input === "object" && input !== null && "threadId" in input
            ? (input as { threadId?: ThreadId }).threadId
            : undefined;
        if (!threadId) {
          return;
        }
        const index = runtimeSessions.findIndex((session) => session.threadId === threadId);
        if (index >= 0) {
          runtimeSessions.splice(index, 1);
        }
      }),
    );
    const renameBranch = vi.fn((input: unknown) =>
      Effect.succeed({
        branch:
          typeof input === "object" &&
          input !== null &&
          "newBranch" in input &&
          typeof input.newBranch === "string"
            ? input.newBranch
            : "renamed-branch",
      }),
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
      startSession: startSession as ProviderServiceShape["startSession"],
      sendTurn: sendTurn as ProviderServiceShape["sendTurn"],
      interruptTurn: interruptTurn as ProviderServiceShape["interruptTurn"],
      respondToRequest: respondToRequest as ProviderServiceShape["respondToRequest"],
      respondToUserInput: respondToUserInput as ProviderServiceShape["respondToUserInput"],
      stopSession: stopSession as ProviderServiceShape["stopSession"],
      listSessions: () => Effect.succeed(runtimeSessions),
      hasLiveSession: (threadId) =>
        Effect.succeed(runtimeSessions.some((session) => session.threadId === threadId)),
      getCapabilities: (_provider) =>
        Effect.succeed({
          sessionModelSwitch: input?.sessionModelSwitch ?? "in-session",
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
      Layer.provide(SqlitePersistenceMemory),
    );
    const projectionSnapshotLayer = OrchestrationProjectionSnapshotQueryLive.pipe(
      Layer.provide(RepositoryIdentityResolver.layer),
      Layer.provide(SqlitePersistenceMemory),
    );
    const liveLayer = ProviderCommandReactorLive.pipe(
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
    runtime = ManagedRuntime.make(layer);

    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const snapshotQuery = await runtime.runPromise(Effect.service(ProjectionSnapshotQuery));
    const reactor = await runtime.runPromise(Effect.service(ProviderCommandReactor));
    scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(reactor.start().pipe(Scope.provide(scope)));
    const drain = () => Effect.runPromise(reactor.drain);

    await Effect.runPromise(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-create"),
        projectId: asProjectId("project-1"),
        title: "Provider Project",
        workspaceRoot: "/tmp/provider-project",
        defaultModelSelection: modelSelection,
        createdAt: now,
      }),
    );
    await Effect.runPromise(
      engine.dispatch({
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
      }),
    );

    const managedRuntime = runtime;
    return {
      engine,
      dispatch: (command: Parameters<typeof engine.dispatch>[0]) =>
        managedRuntime.runPromise(engine.dispatch(command)),
      readModel: () => Effect.runPromise(snapshotQuery.getSnapshot()),
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
      adjustClock: (duration: Duration.Input) =>
        managedRuntime.runPromise(TestClock.adjust(duration)),
      setClock: (instant: number) => managedRuntime.runPromise(TestClock.setTime(instant)),
    };
  }

  async function prepareSubagentSteerHarness(input?: {
    readonly includeProjectedSession?: boolean;
    readonly includeRuntimeSession?: boolean;
    readonly sendTurnEffect?: ProviderServiceShape["sendTurn"];
  }) {
    const harness = await createHarness(
      input?.sendTurnEffect !== undefined ? { sendTurnEffect: input.sendTurnEffect } : undefined,
    );
    const now = await Effect.runPromise(DateTime.now.pipe(Effect.map(DateTime.formatIso)));

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
      await harness.dispatch({
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

    await harness.dispatch({
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
  }

  async function prepareSubagentStopHarness(input?: {
    readonly includeProjectedSession?: boolean;
  }) {
    const harness = await createHarness({ useTestClock: true });
    const nowMillis = Date.parse("2026-01-01T00:00:00.000Z");
    await harness.setClock(nowMillis);
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
      await harness.dispatch({
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

    await harness.dispatch({
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
  }

  it("delivers a stop instruction and escalates a still-running subagent", async () => {
    const { harness, now } = await prepareSubagentStopHarness();

    await harness.dispatch({
      type: "thread.subagent.stop",
      commandId: CommandId.make("stop-1"),
      threadId: ThreadId.make("thread-1"),
      subagentId: "subagent-1",
      createdAt: now,
    });
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.sendTurn.mock.calls[0]?.[0]).toEqual({
      threadId: ThreadId.make("thread-1"),
      input:
        "[Stop request for subagent subagent-1 (Inspect parser)]\n" +
        "The user asked to stop this subagent now. End that work, collect what it completed, and report it. If it is still running in 30 seconds the whole turn will be interrupted.",
    });

    await harness.adjustClock(Duration.millis(SUBAGENT_STOP_ESCALATION_GRACE_MS));
    await waitFor(() => harness.interruptTurn.mock.calls.length === 1);
    // An in-process subagent has no thread of its own, so the escalation still
    // lands on the parent's turn. Pinned here because the thread-backed path
    // must never do this.
    expect(harness.interruptTurn.mock.calls[0]?.[0]).toEqual({
      threadId: ThreadId.make("thread-1"),
    });
    expect(harness.stopSession).not.toHaveBeenCalled();
    const thread = (await harness.readModel()).threads.find(
      (entry) => entry.id === ThreadId.make("thread-1"),
    );
    expect(
      thread?.activities.find((activity) => activity.kind === "subagent.stop.escalated"),
    ).toMatchObject({
      tone: "info",
      payload: { subagentId: "subagent-1", stopId: "stop-1" },
      turnId: asTurnId("turn-1"),
    });
  });

  it("does not escalate when the subagent completes during the grace period", async () => {
    const { harness, now } = await prepareSubagentStopHarness();
    await harness.dispatch({
      type: "thread.subagent.stop",
      commandId: CommandId.make("stop-completed"),
      threadId: ThreadId.make("thread-1"),
      subagentId: "subagent-1",
      createdAt: now,
    });
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    await harness.dispatch({
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

    await harness.adjustClock(Duration.millis(SUBAGENT_STOP_ESCALATION_GRACE_MS));
    await harness.drain();
    expect(harness.interruptTurn).not.toHaveBeenCalled();
    const thread = (await harness.readModel()).threads.find(
      (entry) => entry.id === ThreadId.make("thread-1"),
    );
    expect(thread?.activities.some((activity) => activity.kind === "subagent.stop.escalated")).toBe(
      false,
    );
  });

  it("appends a failed stop activity when the thread has no projected session", async () => {
    const { harness, now } = await prepareSubagentStopHarness({ includeProjectedSession: false });
    await harness.dispatch({
      type: "thread.subagent.stop",
      commandId: CommandId.make("stop-no-session"),
      threadId: ThreadId.make("thread-1"),
      subagentId: "subagent-1",
      createdAt: now,
    });

    await waitFor(async () => {
      const thread = (await harness.readModel()).threads.find(
        (entry) => entry.id === ThreadId.make("thread-1"),
      );
      return (
        thread?.activities.some((activity) => activity.kind === "provider.subagent.stop.failed") ??
        false
      );
    });
    expect(harness.sendTurn).not.toHaveBeenCalled();
    const thread = (await harness.readModel()).threads.find(
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
  });

  it("arms one escalation timer for duplicate stop activity events", async () => {
    const { harness, now } = await prepareSubagentStopHarness();
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

    await appendRequested("one");
    await appendRequested("two");
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    await harness.adjustClock(Duration.millis(SUBAGENT_STOP_ESCALATION_GRACE_MS));
    await waitFor(() => harness.interruptTurn.mock.calls.length === 1);
    expect(harness.sendTurn).toHaveBeenCalledTimes(1);
    expect(harness.interruptTurn).toHaveBeenCalledTimes(1);
  });

  const PARENT_THREAD_ID = ThreadId.make("thread-1");
  const CHILD_THREAD_ID = ThreadId.make("thread-child-1");

  /**
   * A parent whose `subagent-1` is thread-backed: it runs as `thread-child-1`,
   * which has its own provider session and its own turn.
   */
  async function prepareThreadBackedStopHarness(input?: { readonly childTurnRunning?: boolean }) {
    const harness = await createHarness({ useTestClock: true });
    const nowMillis = Date.parse("2026-01-01T00:00:00.000Z");
    await harness.setClock(nowMillis);
    const now = DateTime.formatIso(DateTime.makeUnsafe(nowMillis));

    await harness.dispatch({
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
      await harness.dispatch({
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

    await harness.dispatch({
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
    await harness.dispatch({
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
  }

  it("stops a thread-backed subagent by interrupting the child, never the parent", async () => {
    const { harness, now } = await prepareThreadBackedStopHarness();

    await harness.dispatch({
      type: "thread.subagent.stop",
      commandId: CommandId.make("stop-child-1"),
      threadId: PARENT_THREAD_ID,
      subagentId: "subagent-1",
      createdAt: now,
    });

    await waitFor(() => harness.interruptTurn.mock.calls.length === 1);
    expect(harness.interruptTurn.mock.calls[0]?.[0]).toEqual({ threadId: CHILD_THREAD_ID });
    // The parent stays untouched: no stop instruction in its session, and no
    // interrupt of the turn that is waiting on this child's result.
    expect(harness.sendTurn).not.toHaveBeenCalled();

    await harness.adjustClock(Duration.millis(SUBAGENT_STOP_ESCALATION_GRACE_MS));
    await waitFor(() => harness.stopSession.mock.calls.length === 1);
    expect(harness.stopSession.mock.calls[0]?.[0]).toMatchObject({ threadId: CHILD_THREAD_ID });
    expect(harness.interruptTurn).toHaveBeenCalledTimes(1);

    const parent = (await harness.readModel()).threads.find(
      (entry) => entry.id === PARENT_THREAD_ID,
    );
    expect(
      parent?.activities.find((activity) => activity.kind === "subagent.stop.escalated"),
    ).toMatchObject({
      tone: "info",
      payload: { subagentId: "subagent-1", stopId: "stop-child-1" },
      turnId: asTurnId("turn-1"),
    });
  });

  it("does not stop a thread-backed child whose turn ended inside the grace", async () => {
    const { harness, now } = await prepareThreadBackedStopHarness({ childTurnRunning: false });

    await harness.dispatch({
      type: "thread.subagent.stop",
      commandId: CommandId.make("stop-child-idle"),
      threadId: PARENT_THREAD_ID,
      subagentId: "subagent-1",
      createdAt: now,
    });

    await waitFor(() => harness.interruptTurn.mock.calls.length === 1);
    await harness.adjustClock(Duration.millis(SUBAGENT_STOP_ESCALATION_GRACE_MS));
    await harness.drain();
    expect(harness.stopSession).not.toHaveBeenCalled();
    const parent = (await harness.readModel()).threads.find(
      (entry) => entry.id === PARENT_THREAD_ID,
    );
    expect(parent?.activities.some((activity) => activity.kind === "subagent.stop.escalated")).toBe(
      false,
    );
  });

  it("queues a subagent follow-up on the live parent session and appends delivery", async () => {
    const { harness, now } = await prepareSubagentSteerHarness();

    await harness.dispatch({
      type: "thread.subagent.steer",
      commandId: CommandId.make("steer-1"),
      threadId: ThreadId.make("thread-1"),
      subagentId: "subagent-1",
      text: "Check the parser edge case",
      createdAt: now,
    });

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.sendTurn.mock.calls[0]?.[0]).toEqual({
      threadId: ThreadId.make("thread-1"),
      input:
        "[Queued user follow-up for subagent subagent-1 (Inspect parser)]\n" +
        "This message arrived while that subagent was running. Apply it to the returned result, or resume the subagent if more work is needed:\n" +
        "Check the parser edge case",
    });

    await waitFor(async () => {
      const thread = (await harness.readModel()).threads.find(
        (entry) => entry.id === ThreadId.make("thread-1"),
      );
      return (
        thread?.activities.some((activity) => activity.kind === "subagent.steer.delivered") ?? false
      );
    });
    const thread = (await harness.readModel()).threads.find(
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
  });

  it("appends a failed steer activity when the thread has no projected session", async () => {
    const { harness, now } = await prepareSubagentSteerHarness({
      includeProjectedSession: false,
      includeRuntimeSession: false,
    });

    await harness.dispatch({
      type: "thread.subagent.steer",
      commandId: CommandId.make("steer-no-session"),
      threadId: ThreadId.make("thread-1"),
      subagentId: "subagent-1",
      text: "Check the parser",
      createdAt: now,
    });

    await waitFor(async () => {
      const thread = (await harness.readModel()).threads.find(
        (entry) => entry.id === ThreadId.make("thread-1"),
      );
      return (
        thread?.activities.some((activity) => activity.kind === "provider.subagent.steer.failed") ??
        false
      );
    });
    expect(harness.sendTurn).not.toHaveBeenCalled();
    const thread = (await harness.readModel()).threads.find(
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
  });

  it("does not create a provider session when the projected session is stale", async () => {
    const { harness, now } = await prepareSubagentSteerHarness({ includeRuntimeSession: false });

    await harness.dispatch({
      type: "thread.subagent.steer",
      commandId: CommandId.make("steer-stale-session"),
      threadId: ThreadId.make("thread-1"),
      subagentId: "subagent-1",
      text: "Check the parser",
      createdAt: now,
    });

    await waitFor(async () => {
      const thread = (await harness.readModel()).threads.find(
        (entry) => entry.id === ThreadId.make("thread-1"),
      );
      return (
        thread?.activities.some((activity) => activity.kind === "provider.subagent.steer.failed") ??
        false
      );
    });
    expect(harness.startSession).not.toHaveBeenCalled();
    expect(harness.sendTurn).not.toHaveBeenCalled();
  });

  it("delivers duplicate steer activity events only once", async () => {
    const { harness, now } = await prepareSubagentSteerHarness();
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

    await appendRequested("one");
    await appendRequested("two");
    await harness.drain();

    expect(harness.sendTurn).toHaveBeenCalledTimes(1);
  });

  it("appends exact failure details when the provider rejects a steer", async () => {
    const { harness, now } = await prepareSubagentSteerHarness({
      sendTurnEffect: () =>
        Effect.fail(
          new ProviderAdapterRequestError({
            provider: ProviderDriverKind.make("codex"),
            method: "thread.turn.start",
            detail: "parent turn ended",
          }),
        ),
    });

    await harness.dispatch({
      type: "thread.subagent.steer",
      commandId: CommandId.make("steer-provider-failure"),
      threadId: ThreadId.make("thread-1"),
      subagentId: "subagent-1",
      text: "Check the parser",
      createdAt: now,
    });

    await waitFor(async () => {
      const thread = (await harness.readModel()).threads.find(
        (entry) => entry.id === ThreadId.make("thread-1"),
      );
      return (
        thread?.activities.some((activity) => activity.kind === "provider.subagent.steer.failed") ??
        false
      );
    });
    const thread = (await harness.readModel()).threads.find(
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
  });

  it("reacts to thread.turn.start by ensuring session and sending provider turn", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await dispatch(harness.engine, {
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

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.startSession.mock.calls[0]?.[0]).toEqual(ThreadId.make("thread-1"));
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      cwd: "/tmp/provider-project",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      runtimeMode: "approval-required",
    });

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.session?.threadId).toBe("thread-1");
    expect(thread?.session?.status).toBe("starting");
    expect(thread?.session?.runtimeMode).toBe("approval-required");
  });

  it("adopts a steered turn result through the current running session", async () => {
    const threadId = ThreadId.make("thread-1");
    const turnId = asTurnId("turn-active-steer");
    const sessionUpdatedAt = "2026-01-01T00:00:01.000Z";
    const harness = await createHarness({
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
    await harness.dispatch({
      type: "thread.session.set",
      commandId: CommandId.make("cmd-seed-active-steer"),
      threadId,
      session,
      createdAt: sessionUpdatedAt,
    });
    const dispatchSpy = vi.spyOn(harness.engine, "dispatch");

    await harness.dispatch({
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

    await waitFor(() =>
      dispatchSpy.mock.calls.some(
        ([command]) =>
          command.type === "thread.session.set" && command.commandId !== "cmd-seed-active-steer",
      ),
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
  });

  it("does not dispatch a session update for a fresh turn result", async () => {
    const threadId = ThreadId.make("thread-1");
    const turnId = asTurnId("turn-active-non-steer");
    const now = "2026-01-01T00:00:01.000Z";
    const harness = await createHarness({
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
    await harness.dispatch({
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

    await harness.dispatch({
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

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    await harness.drain();
    expect(
      dispatchSpy.mock.calls.filter(([command]) => command.type === "thread.session.set"),
    ).toHaveLength(0);
  });

  it("expands registered slash skills only for OpenCode while preserving turn metadata and display", async () => {
    const skillsRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-reactor-skills-"));
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
    const harness = await createHarness({
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

    await dispatch(harness.engine, {
      type: "thread.interaction-mode.set",
      commandId: CommandId.make("cmd-skill-interaction-mode"),
      threadId: ThreadId.make("thread-1"),
      interactionMode: "plan",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    await dispatch(harness.engine, {
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

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.sendTurn.mock.calls[0]?.[0]).toEqual({
      threadId: ThreadId.make("thread-1"),
      input: expect.stringContaining(
        "The user invoked the /cook-it skill. Follow its instructions below.",
      ),
      attachments: [attachment],
      modelSelection,
      interactionMode: "plan",
    });
    expect(String((harness.sendTurn.mock.calls[0]![0] as { input: string }).input)).toContain(
      "ARGUMENTS: t3code-vst.17",
    );
    const thread = (await harness.readModel()).threads.find(
      (entry) => entry.id === ThreadId.make("thread-1"),
    );
    expect(thread?.messages.at(-1)?.text).toBe("/cook-it t3code-vst.17");
  });

  it.each(["codex", "kimi", "claudeAgent"])(
    "passes slash skills through for %s sessions",
    async (provider) => {
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
      const harness = await createHarness({
        threadModelSelection: createModelSelection(ProviderInstanceId.make(provider), "test-model"),
        skillsRoot,
      });

      await dispatch(harness.engine, {
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

      await waitFor(() => harness.sendTurn.mock.calls.length === 1);
      expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({ input: "/cook-it task" });
    },
  );

  it.each([
    "/unknown task",
    "$unknown task",
    "/cook-it-extra task",
    "/cook-it.foo",
    " /cook-it",
    " $cook-it",
  ])("passes non-matching OpenCode input through: %s", async (messageText) => {
    const skillsRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-reactor-skills-"));
    createdBaseDirs.add(skillsRoot);
    const skillDirectory = NodePath.join(skillsRoot, "cook-it");
    NodeFS.mkdirSync(skillDirectory);
    NodeFS.writeFileSync(
      NodePath.join(skillDirectory, "SKILL.md"),
      "---\nname: cook-it\n---\nSkill instructions.\n",
    );
    const harness = await createHarness({
      threadModelSelection: createModelSelection(ProviderInstanceId.make("opencode"), "test-model"),
      skillsRoot,
    });

    await dispatch(harness.engine, {
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

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({ input: messageText.trim() });
  });

  it.each(["opencode", "kimi"])(
    "expands workspace skill invocations for %s sessions",
    async (provider) => {
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
      const harness = await createHarness({
        threadModelSelection: createModelSelection(ProviderInstanceId.make(provider), "test-model"),
        skillsRoot,
      });

      await harness.dispatch({
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

      await waitFor(() => harness.sendTurn.mock.calls.length === 1);
      const sent = harness.sendTurn.mock.calls[0]![0] as { input: string };
      expect(sent.input).toContain(
        "The user invoked the /cook-it skill. Follow its instructions below.",
      );
      expect(sent.input).toContain("ARGUMENTS: t3code-vst.17");
    },
  );

  it("rewrites a leading $skill to /skill for Claude when the provider reports the skill", async () => {
    const harness = await createHarness({
      threadModelSelection: createModelSelection(
        ProviderInstanceId.make("claudeAgent"),
        "claude-sonnet-5",
      ),
      providerSkills: [{ name: "pdf", enabled: true }],
    });

    await harness.dispatch({
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

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      input: "/pdf extract the tables",
    });
  });

  it("expands workspace $skills for Claude when the provider does not report them", async () => {
    const skillsRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-reactor-skills-"));
    createdBaseDirs.add(skillsRoot);
    const skillDirectory = NodePath.join(skillsRoot, "cook-it");
    NodeFS.mkdirSync(skillDirectory);
    NodeFS.writeFileSync(
      NodePath.join(skillDirectory, "SKILL.md"),
      "---\nname: cook-it\n---\nSkill instructions.\n",
    );
    const harness = await createHarness({
      threadModelSelection: createModelSelection(
        ProviderInstanceId.make("claudeAgent"),
        "claude-sonnet-5",
      ),
      skillsRoot,
      providerSkills: [{ name: "pdf", enabled: true }],
    });

    await harness.dispatch({
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

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    const sent = harness.sendTurn.mock.calls[0]![0] as { input: string };
    expect(sent.input).toContain(
      "The user invoked the /cook-it skill. Follow its instructions below.",
    );
  });

  it("passes unknown $tokens through for Claude", async () => {
    const harness = await createHarness({
      threadModelSelection: createModelSelection(
        ProviderInstanceId.make("claudeAgent"),
        "claude-sonnet-5",
      ),
      providerSkills: [{ name: "pdf", enabled: true }],
    });

    await harness.dispatch({
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

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      input: "$HOME is where the heart is",
    });
  });

  it("passes $skills through for Codex sessions", async () => {
    const skillsRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-reactor-skills-"));
    createdBaseDirs.add(skillsRoot);
    const skillDirectory = NodePath.join(skillsRoot, "cook-it");
    NodeFS.mkdirSync(skillDirectory);
    NodeFS.writeFileSync(
      NodePath.join(skillDirectory, "SKILL.md"),
      "---\nname: cook-it\n---\nSkill instructions.\n",
    );
    const harness = await createHarness({
      threadModelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5-codex"),
      skillsRoot,
    });

    await harness.dispatch({
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

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({ input: "$cook-it task" });
  });

  effectIt.effect("projects starting before a slow provider session finishes", () =>
    Effect.gen(function* () {
      const releaseStart = yield* Deferred.make<void>();
      const harness = yield* Effect.promise(() =>
        createHarness({
          startSessionEffect: (session) => Deferred.await(releaseStart).pipe(Effect.as(session)),
        }),
      );
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

      yield* Effect.promise(() => waitFor(() => harness.startSession.mock.calls.length === 1));
      const duringStartup = yield* Effect.promise(() => harness.readModel());
      expect(
        duringStartup.threads.find((entry) => entry.id === ThreadId.make("thread-1"))?.session
          ?.status,
      ).toBe("starting");
      expect(harness.sendTurn).not.toHaveBeenCalled();

      yield* Deferred.succeed(releaseStart, undefined);
      yield* Effect.promise(() => waitFor(() => harness.sendTurn.mock.calls.length === 1));
    }),
  );

  effectIt.effect("settles a failed provider startup and allows a clean retry", () =>
    Effect.gen(function* () {
      let failStartup = true;
      const harness = yield* Effect.promise(() =>
        createHarness({
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
        }),
      );
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

      yield* Effect.promise(() =>
        waitFor(async () => {
          const readModel = await harness.readModel();
          return (
            readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"))?.session
              ?.status === "error"
          );
        }),
      );
      let readModel = yield* Effect.promise(() => harness.readModel());
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

      yield* Effect.promise(() => waitFor(() => harness.sendTurn.mock.calls.length === 1));
      readModel = yield* Effect.promise(() => harness.readModel());
      thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      expect(thread?.session?.status).toBe("starting");
      expect(thread?.session?.lastError).toBeNull();
    }),
  );

  it("generates a thread title on the first turn", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    const seededTitle = "Please investigate reconnect failures after restar...";
    harness.generateThreadTitle.mockReturnValue(Effect.succeed({ title: "Generated title" }));

    await dispatch(harness.engine, {
      type: "thread.meta.update",
      commandId: CommandId.make("cmd-thread-title-seed"),
      threadId: ThreadId.make("thread-1"),
      title: seededTitle,
    });

    await dispatch(harness.engine, {
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

    await waitFor(() => harness.generateThreadTitle.mock.calls.length === 1);
    expect(harness.generateThreadTitle.mock.calls[0]?.[0]).toMatchObject({
      message: "Please investigate reconnect failures after restarting the session.",
    });

    await waitFor(async () => {
      const readModel = await harness.readModel();
      return (
        readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"))?.title ===
        "Generated title"
      );
    });
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.title).toBe("Generated title");
  });

  it("does not overwrite an existing custom thread title on the first turn", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    const seededTitle = "Please investigate reconnect failures after restar...";

    await dispatch(harness.engine, {
      type: "thread.meta.update",
      commandId: CommandId.make("cmd-thread-title-custom"),
      threadId: ThreadId.make("thread-1"),
      title: "Keep this custom title",
    });

    await dispatch(harness.engine, {
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

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.generateThreadTitle).not.toHaveBeenCalled();

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.title).toBe("Keep this custom title");
  });

  it("matches the client-seeded title even when the outgoing prompt is reformatted", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    const seededTitle = "Fix reconnect spinner on resume";
    harness.generateThreadTitle.mockReturnValue(
      Effect.succeed({
        title: "Reconnect spinner resume bug",
      }),
    );

    await dispatch(harness.engine, {
      type: "thread.meta.update",
      commandId: CommandId.make("cmd-thread-title-formatted-seed"),
      threadId: ThreadId.make("thread-1"),
      title: seededTitle,
    });

    await dispatch(harness.engine, {
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

    await waitFor(() => harness.generateThreadTitle.mock.calls.length === 1);
    await waitFor(async () => {
      const readModel = await harness.readModel();
      return (
        readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"))?.title ===
        "Reconnect spinner resume bug"
      );
    });

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.title).toBe("Reconnect spinner resume bug");
  });

  it("generates a worktree branch name for the first turn", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await dispatch(harness.engine, {
      type: "thread.meta.update",
      commandId: CommandId.make("cmd-thread-branch"),
      threadId: ThreadId.make("thread-1"),
      branch: "t3code/1234abcd",
      worktreePath: HARNESS_WORKTREE_PATH,
    });

    harness.generateBranchName.mockImplementation((input: unknown) =>
      Effect.succeed({
        branch:
          typeof input === "object" &&
          input !== null &&
          "modelSelection" in input &&
          typeof input.modelSelection === "object" &&
          input.modelSelection !== null &&
          "model" in input.modelSelection &&
          typeof input.modelSelection.model === "string"
            ? `feature/${input.modelSelection.model}`
            : "feature/generated",
      }),
    );

    await dispatch(harness.engine, {
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

    await waitFor(() => harness.generateBranchName.mock.calls.length === 1);
    await waitFor(() => harness.refreshStatus.mock.calls.length === 1);
    expect(harness.generateBranchName.mock.calls[0]?.[0]).toMatchObject({
      message: "Add a safer reconnect backoff.",
    });
    expect(harness.refreshStatus.mock.calls[0]?.[0]).toBe("/tmp/provider-project-worktree");
  });

  it("forwards codex model options through session start and turn send", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await dispatch(harness.engine, {
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

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
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
  });

  it("forwards claude effort options through session start and turn send", async () => {
    const harness = await createHarness({
      threadModelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-sonnet-4-6",
      },
    });
    const now = "2026-01-01T00:00:00.000Z";

    await dispatch(harness.engine, {
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

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
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
  });

  it("forwards claude fast mode options through session start and turn send", async () => {
    const harness = await createHarness({
      threadModelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-opus-4-6",
      },
    });
    const now = "2026-01-01T00:00:00.000Z";

    await dispatch(harness.engine, {
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

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
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
  });

  it("forwards plan interaction mode to the provider turn request", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await dispatch(harness.engine, {
      type: "thread.interaction-mode.set",
      commandId: CommandId.make("cmd-interaction-mode-set-plan"),
      threadId: ThreadId.make("thread-1"),
      interactionMode: "plan",
      createdAt: now,
    });

    await dispatch(harness.engine, {
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

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
      interactionMode: "plan",
    });
  });

  it("preserves the active session model when in-session model switching is unsupported", async () => {
    const harness = await createHarness({ sessionModelSwitch: "unsupported" });
    const now = "2026-01-01T00:00:00.000Z";

    await dispatch(harness.engine, {
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

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await dispatch(harness.engine, {
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

    await waitFor(() => harness.sendTurn.mock.calls.length === 2);

    expect(harness.sendTurn.mock.calls[1]?.[0]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
    });
  });

  effectIt.effect(
    "rejects changing models after start when the provider requires a new thread",
    () =>
      Effect.gen(function* () {
        const harness = yield* Effect.promise(() =>
          createHarness({ requiresNewThreadForModelChange: true }),
        );
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

        yield* Effect.promise(() => waitFor(() => harness.sendTurn.mock.calls.length === 1));

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

        yield* Effect.promise(() =>
          waitFor(async () => {
            const readModel = await harness.readModel();
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

        expect(harness.sendTurn).toHaveBeenCalledTimes(1);
        const readModel = yield* Effect.promise(() => harness.readModel());
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

  it("starts a first turn on the requested provider instance even when it differs from the thread model", async () => {
    const harness = await createHarness({
      threadModelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
    });
    const now = "2026-01-01T00:00:00.000Z";

    await dispatch(harness.engine, {
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

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    expect(harness.startSession).toHaveBeenCalledTimes(1);
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      provider: ProviderDriverKind.make("claudeAgent"),
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      modelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-opus-4-6",
      },
    });

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.session?.providerName).toBe("claudeAgent");
    expect(thread?.session?.providerInstanceId).toBe(ProviderInstanceId.make("claudeAgent"));
    expect(
      thread?.activities.find((activity) => activity.kind === "provider.turn.start.failed"),
    ).toBeUndefined();
  });

  it("reuses the same provider session when runtime mode is unchanged", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await dispatch(harness.engine, {
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

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await dispatch(harness.engine, {
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

    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    expect(harness.startSession.mock.calls.length).toBe(1);
    expect(harness.stopSession.mock.calls.length).toBe(0);
  });

  it("restarts an existing Codex thread on a compatible requested instance", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await dispatch(harness.engine, {
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

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await dispatch(harness.engine, {
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

    await waitFor(() => harness.sendTurn.mock.calls.length === 2);

    expect(harness.startSession).toHaveBeenCalledTimes(2);
    expect(harness.startSession.mock.calls[1]?.[1]).toMatchObject({
      provider: ProviderDriverKind.make("codex"),
      providerInstanceId: ProviderInstanceId.make("codex_work"),
      resumeCursor: { opaque: "resume-1" },
    });

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.session?.providerInstanceId).toBe(ProviderInstanceId.make("codex_work"));
  });

  it("restarts the provider session when the thread workspace changes", async () => {
    const harness = await createHarness({
      threadModelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-sonnet-4-6",
      },
    });
    const now = "2026-01-01T00:00:00.000Z";

    await dispatch(harness.engine, {
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

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      cwd: "/tmp/provider-project",
    });

    await dispatch(harness.engine, {
      type: "thread.meta.update",
      commandId: CommandId.make("cmd-thread-worktree-change"),
      threadId: ThreadId.make("thread-1"),
      worktreePath: HARNESS_WORKTREE_PATH,
    });

    await dispatch(harness.engine, {
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

    await waitFor(() => harness.startSession.mock.calls.length === 2);
    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
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
  });

  it("falls back to the project root and clears a worktree path that is gone", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    // An epic worker's worktree, deleted by the runner after the child landed.
    const deletedWorktree = "/tmp/provider-project-worktree-deleted";
    NodeFS.rmSync(deletedWorktree, { recursive: true, force: true });

    await dispatch(harness.engine, {
      type: "thread.meta.update",
      commandId: CommandId.make("cmd-thread-worktree-deleted"),
      threadId: ThreadId.make("thread-1"),
      worktreePath: deletedWorktree,
    });

    await dispatch(harness.engine, {
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

    await waitFor(() => harness.startSession.mock.calls.length === 1);

    // The provider is started in the project root, not the deleted directory.
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      cwd: "/tmp/provider-project",
    });

    // And the dead path is dropped, so checkpointing and vcs status stop
    // resolving to it too.
    await waitFor(async () => {
      const readModel = await harness.readModel();
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      return thread?.worktreePath === null;
    });
  });

  it("restarts claude sessions when claude effort changes", async () => {
    const harness = await createHarness({
      threadModelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-sonnet-4-6",
      },
    });
    const now = "2026-01-01T00:00:00.000Z";

    await dispatch(harness.engine, {
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

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await dispatch(harness.engine, {
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

    await waitFor(() => harness.startSession.mock.calls.length === 2);
    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    expect(harness.startSession.mock.calls[1]?.[1]).toMatchObject({
      resumeCursor: { opaque: "resume-1" },
      modelSelection: createModelSelection(
        ProviderInstanceId.make("claudeAgent"),
        "claude-sonnet-4-6",
        [{ id: "effort", value: "max" }],
      ),
    });
  });

  it("restarts the provider session when runtime mode is updated on the thread", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await dispatch(harness.engine, {
      type: "thread.runtime-mode.set",
      commandId: CommandId.make("cmd-runtime-mode-set-initial-full-access"),
      threadId: ThreadId.make("thread-1"),
      runtimeMode: "full-access",
      createdAt: now,
    });

    await dispatch(harness.engine, {
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

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await dispatch(harness.engine, {
      type: "thread.runtime-mode.set",
      commandId: CommandId.make("cmd-runtime-mode-set-1"),
      threadId: ThreadId.make("thread-1"),
      runtimeMode: "approval-required",
      createdAt: now,
    });

    await waitFor(async () => {
      const readModel = await harness.readModel();
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      return thread?.runtimeMode === "approval-required";
    });
    await waitFor(() => harness.startSession.mock.calls.length === 2);
    await dispatch(harness.engine, {
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

    await waitFor(() => harness.sendTurn.mock.calls.length === 2);

    expect(harness.stopSession.mock.calls.length).toBe(0);
    expect(harness.startSession.mock.calls[1]?.[1]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
      resumeCursor: { opaque: "resume-1" },
      runtimeMode: "approval-required",
    });
    expect(harness.sendTurn.mock.calls[1]?.[0]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
    });

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.session?.threadId).toBe("thread-1");
    expect(thread?.session?.runtimeMode).toBe("approval-required");
  });

  it("does not inject derived model options when restarting claude on runtime mode changes", async () => {
    const harness = await createHarness({
      threadModelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-opus-4-6",
      },
    });
    const now = "2026-01-01T00:00:00.000Z";

    await dispatch(harness.engine, {
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

    await dispatch(harness.engine, {
      type: "thread.runtime-mode.set",
      commandId: CommandId.make("cmd-runtime-mode-set-claude-no-options"),
      threadId: ThreadId.make("thread-1"),
      runtimeMode: "approval-required",
      createdAt: now,
    });

    await waitFor(() => harness.startSession.mock.calls.length === 1);

    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      modelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-opus-4-6",
      },
      runtimeMode: "approval-required",
    });
  });

  it("does not stop the active session when restart fails before rebind", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await dispatch(harness.engine, {
      type: "thread.runtime-mode.set",
      commandId: CommandId.make("cmd-runtime-mode-set-initial-full-access-2"),
      threadId: ThreadId.make("thread-1"),
      runtimeMode: "full-access",
      createdAt: now,
    });

    await dispatch(harness.engine, {
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

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    harness.startSession.mockImplementationOnce(
      (_: unknown, __: unknown) => Effect.fail("simulated restart failure") as never,
    );

    await dispatch(harness.engine, {
      type: "thread.runtime-mode.set",
      commandId: CommandId.make("cmd-runtime-mode-set-restart-failure"),
      threadId: ThreadId.make("thread-1"),
      runtimeMode: "approval-required",
      createdAt: now,
    });

    await waitFor(async () => {
      const readModel = await harness.readModel();
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      return thread?.runtimeMode === "approval-required";
    });
    await waitFor(() => harness.startSession.mock.calls.length === 2);
    await harness.drain();

    expect(harness.stopSession.mock.calls.length).toBe(0);
    expect(harness.sendTurn.mock.calls.length).toBe(1);

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.session?.threadId).toBe("thread-1");
    expect(thread?.session?.runtimeMode).toBe("full-access");
  });

  it("rejects provider changes after a thread is already bound to a session provider", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await dispatch(harness.engine, {
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

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await dispatch(harness.engine, {
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

    await waitFor(async () => {
      const readModel = await harness.readModel();
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      return (
        thread?.activities.some((activity) => activity.kind === "provider.turn.start.failed") ??
        false
      );
    });

    expect(harness.startSession.mock.calls.length).toBe(1);
    expect(harness.sendTurn.mock.calls.length).toBe(1);
    expect(harness.stopSession.mock.calls.length).toBe(0);

    const readModel = await harness.readModel();
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
  });

  it("rejects cross-driver provider changes after the existing thread session has stopped", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await dispatch(harness.engine, {
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

    await dispatch(harness.engine, {
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

    await waitFor(async () => {
      const readModel = await harness.readModel();
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      return (
        thread?.activities.some((activity) => activity.kind === "provider.turn.start.failed") ??
        false
      );
    });

    expect(harness.startSession.mock.calls.length).toBe(0);
    expect(harness.sendTurn.mock.calls.length).toBe(0);
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(
      thread?.activities.find((activity) => activity.kind === "provider.turn.start.failed"),
    ).toMatchObject({
      payload: {
        detail: expect.stringContaining("cannot switch to 'claudeAgent'"),
      },
    });
  });

  it("reacts to thread.turn.interrupt-requested by calling provider interrupt", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await dispatch(harness.engine, {
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

    await dispatch(harness.engine, {
      type: "thread.turn.interrupt",
      commandId: CommandId.make("cmd-turn-interrupt"),
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-1"),
      createdAt: now,
    });

    await waitFor(() => harness.interruptTurn.mock.calls.length === 1);
    expect(harness.interruptTurn.mock.calls[0]?.[0]).toEqual({
      threadId: "thread-1",
    });
  });

  it("starts a fresh session when only projected session state exists", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await dispatch(harness.engine, {
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

    await dispatch(harness.engine, {
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

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

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
  });

  it("rejects active runtime sessions that are missing provider instance ids", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await dispatch(harness.engine, {
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

    await dispatch(harness.engine, {
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

    await waitFor(async () => {
      const readModel = await harness.readModel();
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      return (
        thread?.activities.some((activity) => activity.kind === "provider.turn.start.failed") ??
        false
      );
    });

    expect(harness.startSession.mock.calls.length).toBe(0);
    expect(harness.sendTurn.mock.calls.length).toBe(0);
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(
      thread?.activities.find((activity) => activity.kind === "provider.turn.start.failed"),
    ).toMatchObject({
      payload: {
        detail: expect.stringContaining("without a provider instance id"),
      },
    });
  });

  it("reacts to thread.approval.respond by forwarding provider approval response", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await dispatch(harness.engine, {
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

    await dispatch(harness.engine, {
      type: "thread.approval.respond",
      commandId: CommandId.make("cmd-approval-respond"),
      threadId: ThreadId.make("thread-1"),
      requestId: asApprovalRequestId("approval-request-1"),
      decision: "accept",
      createdAt: now,
    });

    await waitFor(() => harness.respondToRequest.mock.calls.length === 1);
    expect(harness.respondToRequest.mock.calls[0]?.[0]).toEqual({
      threadId: "thread-1",
      requestId: "approval-request-1",
      decision: "accept",
    });
  });

  it("reacts to thread.user-input.respond by forwarding structured user input answers", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await dispatch(harness.engine, {
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

    await dispatch(harness.engine, {
      type: "thread.user-input.respond",
      commandId: CommandId.make("cmd-user-input-respond"),
      threadId: ThreadId.make("thread-1"),
      requestId: asApprovalRequestId("user-input-request-1"),
      answers: {
        sandbox_mode: "workspace-write",
      },
      createdAt: now,
    });

    await waitFor(() => harness.respondToUserInput.mock.calls.length === 1);
    expect(harness.respondToUserInput.mock.calls[0]?.[0]).toEqual({
      threadId: "thread-1",
      requestId: "user-input-request-1",
      answers: {
        sandbox_mode: "workspace-write",
      },
    });
  });

  it("surfaces stale provider approval request failures without faking approval resolution", async () => {
    const harness = await createHarness();
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

    await dispatch(harness.engine, {
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

    await dispatch(harness.engine, {
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

    await dispatch(harness.engine, {
      type: "thread.approval.respond",
      commandId: CommandId.make("cmd-approval-respond-stale"),
      threadId: ThreadId.make("thread-1"),
      requestId: asApprovalRequestId("approval-request-1"),
      decision: "acceptForSession",
      createdAt: now,
    });

    await waitFor(async () => {
      const readModel = await harness.readModel();
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      if (!thread) return false;
      return thread.activities.some(
        (activity) => activity.kind === "provider.approval.respond.failed",
      );
    });

    const readModel = await harness.readModel();
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
        typeof activity.payload === "object" &&
        activity.payload !== null &&
        (activity.payload as Record<string, unknown>).requestId === "approval-request-1",
    );
    expect(resolvedActivity).toBeUndefined();
  });

  it("surfaces non-resumable provider user-input callbacks as stale failures", async () => {
    const harness = await createHarness();
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

    await dispatch(harness.engine, {
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

    await dispatch(harness.engine, {
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

    await dispatch(harness.engine, {
      type: "thread.user-input.respond",
      commandId: CommandId.make("cmd-user-input-respond-stale"),
      threadId: ThreadId.make("thread-1"),
      requestId: asApprovalRequestId("user-input-request-1"),
      answers: {
        sandbox_mode: "workspace-write",
      },
      createdAt: now,
    });

    await waitFor(async () => {
      const readModel = await harness.readModel();
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      if (!thread) return false;
      return thread.activities.some(
        (activity) => activity.kind === "provider.user-input.respond.failed",
      );
    });

    const readModel = await harness.readModel();
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
        typeof activity.payload === "object" &&
        activity.payload !== null &&
        (activity.payload as Record<string, unknown>).requestId === "user-input-request-1",
    );
    expect(resolvedActivity).toBeUndefined();
  });

  it("reacts to thread.session.stop by stopping provider session and clearing thread session state", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await runtime!.runPromise(
      harness.engine.dispatch({
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
      }),
    );

    await runtime!.runPromise(
      harness.engine.dispatch({
        type: "thread.session.stop",
        commandId: CommandId.make("cmd-session-stop"),
        threadId: ThreadId.make("thread-1"),
        createdAt: now,
      }),
    );

    await waitFor(() => harness.stopSession.mock.calls.length === 1);
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.session).not.toBeNull();
    expect(thread?.session?.status).toBe("stopped");
    expect(thread?.session?.threadId).toBe("thread-1");
    expect(thread?.session?.providerInstanceId).toBe(ProviderInstanceId.make("codex_work"));
    expect(thread?.session?.activeTurnId).toBeNull();
    expect(thread?.session?.lastError).toBe("existing provider error");
  });

  it("uses a session-stop reason as the stopped session error", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await runtime!.runPromise(
      harness.engine.dispatch({
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
      }),
    );

    await runtime!.runPromise(
      harness.engine.dispatch({
        type: "thread.session.stop",
        commandId: CommandId.make("cmd-session-stop-reasoned"),
        threadId: ThreadId.make("thread-1"),
        createdAt: now,
        reason: "session reaped: no live provider process",
      }),
    );

    await waitFor(() => harness.stopSession.mock.calls.length === 1);
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.session?.status).toBe("stopped");
    expect(thread?.session?.lastError).toBe("session reaped: no live provider process");
  });
});
