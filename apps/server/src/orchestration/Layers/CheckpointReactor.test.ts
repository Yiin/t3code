// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";

import {
  UNKNOWN_DRIVER_ATTACHMENT_CAPABILITY,
  ProviderDriverKind,
  ProviderRuntimeEvent,
  ProviderSession,
  ProviderInstanceId,
} from "@t3tools/contracts";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  type OrchestrationEvent,
  ProjectId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { vi } from "vite-plus/test";

import * as CheckpointStore from "../../checkpointing/CheckpointStore.ts";
import * as VcsDriverRegistry from "../../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import { VcsStatusBroadcaster } from "../../vcs/VcsStatusBroadcaster.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { CheckpointReactorLive } from "./CheckpointReactor.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import { RuntimeReceiptBusLive } from "./RuntimeReceiptBus.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import { CheckpointReactor } from "../Services/CheckpointReactor.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  RuntimeReceiptBus,
  type OrchestrationRuntimeReceipt,
} from "../Services/RuntimeReceiptBus.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../../provider/Services/ProviderService.ts";
import { checkpointRefForThreadTurn } from "../../checkpointing/Utils.ts";
import { ServerConfig } from "../../config.ts";
import * as WorkspaceEntries from "../../workspace/WorkspaceEntries.ts";
import * as WorkspacePaths from "../../workspace/WorkspacePaths.ts";

/**
 * Dispatch a command through the engine. Collapses the `engine.dispatch(...)`
 * call repeated throughout this file into one place.
 */
const dispatch = <C, A, E>(
  engine: { readonly dispatch: (command: C) => Effect.Effect<A, E> },
  command: C,
): Effect.Effect<A, E> => engine.dispatch(command);

const asProjectId = (value: string): ProjectId => ProjectId.make(value);
const asTurnId = (value: string): TurnId => TurnId.make(value);

type LegacyProviderRuntimeEvent = {
  readonly type: string;
  readonly eventId: EventId;
  readonly provider: ProviderDriverKind;
  readonly createdAt: string;
  readonly threadId: ThreadId;
  readonly turnId?: string | undefined;
  readonly itemId?: string | undefined;
  readonly requestId?: string | undefined;
  readonly payload?: unknown | undefined;
  readonly [key: string]: unknown;
};

function createProviderServiceHarness(
  cwd: string,
  hasSession = true,
  sessionCwd = cwd,
  providerName: ProviderSession["provider"] = ProviderDriverKind.make("codex"),
  peerSessions: ReadonlyArray<ProviderSession> = [],
) {
  return Effect.gen(function* () {
    const now = "2026-01-01T00:00:00.000Z";
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();
    const rollbackConversation = vi.fn(
      (_input: { readonly threadId: ThreadId; readonly numTurns: number }) => Effect.void,
    );

    const unsupported = <A>() =>
      Effect.die(new Error("Unsupported provider call in test")) as Effect.Effect<A, never>;
    const listSessions = () =>
      hasSession
        ? Effect.succeed([
            {
              provider: providerName,
              status: "ready",
              runtimeMode: "full-access",
              threadId: ThreadId.make("thread-1"),
              cwd: sessionCwd,
              createdAt: now,
              updatedAt: now,
            },
            ...peerSessions,
          ] satisfies ReadonlyArray<ProviderSession>)
        : Effect.succeed(peerSessions);
    const service: ProviderServiceShape = {
      startSession: () => unsupported(),
      sendTurn: () => unsupported(),
      interruptTurn: () => unsupported(),
      respondToRequest: () => unsupported(),
      respondToUserInput: () => unsupported(),
      stopSession: () => unsupported(),
      listSessions,
      hasLiveSession: (threadId) =>
        Effect.succeed(hasSession && threadId === ThreadId.make("thread-1")),
      describeSessionResume: () => unsupported(),
      getCapabilities: () =>
        Effect.succeed({
          sessionModelSwitch: "in-session",
          sessionLifecycle: { resume: "cursor" },
          attachments: UNKNOWN_DRIVER_ATTACHMENT_CAPABILITY,
        }),
      getInstanceInfo: (instanceId) =>
        Effect.succeed({
          instanceId,
          driverKind: ProviderDriverKind.make(providerName),
          displayName: undefined,
          enabled: true,
          continuationIdentity: {
            driverKind: ProviderDriverKind.make(providerName),
            continuationKey: `${providerName}:instance:${instanceId}`,
          },
        }),
      rollbackConversation,
      get streamEvents() {
        return Stream.fromPubSub(runtimeEventPubSub);
      },
    };

    const emit = (event: LegacyProviderRuntimeEvent) =>
      PubSub.publish(runtimeEventPubSub, event as unknown as ProviderRuntimeEvent);

    return {
      service,
      rollbackConversation,
      emit,
    };
  });
}

function waitForThread<E>(
  readModel: () => Effect.Effect<
    {
      readonly threads: ReadonlyArray<{
        readonly id: ThreadId;
        readonly latestTurn: { readonly turnId: string } | null;
        readonly checkpoints: ReadonlyArray<{ readonly checkpointTurnCount: number }>;
        readonly activities: ReadonlyArray<{ readonly kind: string }>;
      }>;
    },
    E
  >,
  predicate: (thread: {
    latestTurn: { turnId: string } | null;
    checkpoints: ReadonlyArray<{ checkpointTurnCount: number }>;
    activities: ReadonlyArray<{ kind: string }>;
  }) => boolean,
  timeoutMs = 15_000,
) {
  return Effect.gen(function* () {
    const deadline = (yield* Clock.currentTimeMillis) + timeoutMs;
    while (true) {
      const snapshot = yield* readModel();
      const thread = snapshot.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      if (thread && predicate(thread)) {
        return thread;
      }
      if ((yield* Clock.currentTimeMillis) >= deadline) {
        throw new Error("Timed out waiting for thread state.");
      }
      yield* Effect.sleep("10 millis");
    }
  });
}

function waitForEvent(
  engine: OrchestrationEngineShape,
  predicate: (event: { type: string }) => boolean,
  timeoutMs = 15_000,
) {
  return Effect.gen(function* () {
    const deadline = (yield* Clock.currentTimeMillis) + timeoutMs;
    while (true) {
      const events = yield* Stream.runCollect(engine.readEvents(0)).pipe(
        Effect.map((chunk) => Array.from(chunk)),
      );
      if (events.some(predicate)) {
        return events;
      }
      if ((yield* Clock.currentTimeMillis) >= deadline) {
        throw new Error("Timed out waiting for orchestration event.");
      }
      yield* Effect.sleep("10 millis");
    }
  });
}

function runGit(cwd: string, args: ReadonlyArray<string>) {
  return NodeChildProcess.execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
}

function createGitRepository() {
  const cwd = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-checkpoint-handler-"));
  runGit(cwd, ["init", "--initial-branch=main"]);
  runGit(cwd, ["config", "user.email", "test@example.com"]);
  runGit(cwd, ["config", "user.name", "Test User"]);
  NodeFS.writeFileSync(NodePath.join(cwd, "README.md"), "v1\n", "utf8");
  runGit(cwd, ["add", "."]);
  runGit(cwd, ["commit", "-m", "Initial"]);
  return cwd;
}

function gitRefExists(cwd: string, ref: string): boolean {
  try {
    runGit(cwd, ["show-ref", "--verify", "--quiet", ref]);
    return true;
  } catch {
    return false;
  }
}

function gitShowFileAtRef(cwd: string, ref: string, filePath: string): string {
  return runGit(cwd, ["show", `${ref}:${filePath}`]);
}

function waitForGitRefExists(cwd: string, ref: string, timeoutMs = 15_000) {
  return Effect.gen(function* () {
    const deadline = (yield* Clock.currentTimeMillis) + timeoutMs;
    while (true) {
      if (gitRefExists(cwd, ref)) {
        return;
      }
      if ((yield* Clock.currentTimeMillis) >= deadline) {
        throw new Error(`Timed out waiting for git ref '${ref}'.`);
      }
      yield* Effect.sleep("10 millis");
    }
  });
}

describe("CheckpointReactor", () => {
  function createHarness(options?: {
    readonly hasSession?: boolean;
    readonly seedFilesystemCheckpoints?: boolean;
    readonly projectWorkspaceRoot?: string;
    readonly threadWorktreePath?: string | null;
    readonly providerSessionCwd?: string;
    readonly providerName?: ProviderDriverKind;
    // Extra provider sessions listed beside thread-1's own, built from the
    // harness cwd so a peer can be placed in the same worktree.
    readonly peerSessions?: (cwd: string) => ReadonlyArray<ProviderSession>;
    readonly gitStatusRefreshCalls?: Array<string>;
    readonly receiptCalls?: Array<OrchestrationRuntimeReceipt>;
    readonly startReactor?: boolean;
    readonly useTestClock?: boolean;
  }) {
    return Effect.gen(function* () {
      const cwd = createGitRepository();
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(cwd, { recursive: true, force: true })),
      );
      const provider = yield* createProviderServiceHarness(
        cwd,
        options?.hasSession ?? true,
        options?.providerSessionCwd ?? cwd,
        options?.providerName ?? ProviderDriverKind.make("codex"),
        options?.peerSessions?.(cwd) ?? [],
      );
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

      const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
        prefix: "t3-checkpoint-reactor-test-",
      });
      const vcsStatusBroadcasterLayer = Layer.succeed(VcsStatusBroadcaster, {
        getStatus: () => Effect.die("getStatus should not be called in this test"),
        peekStatus: () => Effect.die("peekStatus should not be called in this test"),
        refreshLocalStatus: (cwd: string) =>
          Effect.sync(() => {
            options?.gitStatusRefreshCalls?.push(cwd);
          }).pipe(
            Effect.as({
              isRepo: true,
              hasPrimaryRemote: false,
              isDefaultRef: true,
              refName: "main",
              hasWorkingTreeChanges: false,
              workingTree: { files: [], insertions: 0, deletions: 0 },
            }),
          ),
        refreshStatus: () => Effect.die("refreshStatus should not be called in this test"),
        streamStatus: () => Stream.empty,
      });

      const receiptBusLayer = options?.receiptCalls
        ? Layer.succeed(RuntimeReceiptBus, {
            publish: (receipt) =>
              Effect.sync(() => {
                options.receiptCalls?.push(receipt);
              }),
            streamEventsForTest: Stream.empty,
          })
        : RuntimeReceiptBusLive;
      const liveLayer = CheckpointReactorLive.pipe(
        Layer.provideMerge(orchestrationLayer),
        Layer.provideMerge(projectionSnapshotLayer),
        Layer.provideMerge(receiptBusLayer),
        Layer.provideMerge(Layer.succeed(ProviderService, provider.service)),
        Layer.provideMerge(vcsStatusBroadcasterLayer),
        Layer.provideMerge(CheckpointStore.layer.pipe(Layer.provide(VcsDriverRegistry.layer))),
        Layer.provideMerge(
          WorkspaceEntries.layer.pipe(
            Layer.provide(WorkspacePaths.layer),
            Layer.provideMerge(VcsDriverRegistry.layer),
          ),
        ),
        Layer.provideMerge(WorkspacePaths.layer),
        Layer.provideMerge(VcsProcess.layer),
        Layer.provideMerge(ServerConfigLayer),
        Layer.provideMerge(NodeServices.layer),
      );
      const layer = options?.useTestClock
        ? liveLayer.pipe(Layer.provideMerge(TestClock.layer()))
        : liveLayer;

      const context = yield* Layer.build(layer);
      const engine = Context.get(context, OrchestrationEngineService);
      const snapshotQuery = Context.get(context, ProjectionSnapshotQuery);
      const reactor = Context.get(context, CheckpointReactor);
      const checkpointStore = Context.get(context, CheckpointStore.CheckpointStore);

      const scope = yield* Scope.make("sequential");
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
      const start = () => reactor.start().pipe(Scope.provide(scope));
      if (options?.startReactor ?? true) {
        yield* start();
      }
      const drain = () => reactor.drain;

      const createdAt = "2026-01-01T00:00:00.000Z";
      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-create"),
        projectId: asProjectId("project-1"),
        title: "Test Project",
        workspaceRoot: options?.projectWorkspaceRoot ?? cwd,
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      });
      yield* engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-create"),
        threadId: ThreadId.make("thread-1"),
        projectId: asProjectId("project-1"),
        title: "Thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: options?.threadWorktreePath ?? cwd,
        createdAt,
      });

      if (options?.seedFilesystemCheckpoints ?? true) {
        yield* checkpointStore.captureCheckpoint({
          cwd,
          checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), 0),
        });
        NodeFS.writeFileSync(NodePath.join(cwd, "README.md"), "v2\n", "utf8");
        yield* checkpointStore.captureCheckpoint({
          cwd,
          checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1),
        });
        NodeFS.writeFileSync(NodePath.join(cwd, "README.md"), "v3\n", "utf8");
        yield* checkpointStore.captureCheckpoint({
          cwd,
          checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), 2),
        });
      }

      return {
        engine,
        readModel: () => snapshotQuery.getSnapshot(),
        provider,
        cwd,
        start,
        drain,
        adjustClock: (duration: Duration.Input) =>
          TestClock.adjust(duration).pipe(Effect.provide(context)),
      };
    });
  }

  type Harness = Effect.Success<ReturnType<typeof createHarness>>;

  function setThreadSession(
    harness: Harness,
    input: {
      readonly status: "ready" | "running";
      readonly activeTurnId: TurnId | null;
      readonly commandId: string;
    },
  ) {
    const createdAt = "2026-01-01T00:00:00.000Z";
    return dispatch(harness.engine, {
      type: "thread.session.set",
      commandId: CommandId.make(input.commandId),
      threadId: ThreadId.make("thread-1"),
      session: {
        threadId: ThreadId.make("thread-1"),
        status: input.status,
        providerName: "codex",
        runtimeMode: "approval-required",
        activeTurnId: input.activeTurnId,
        lastError: null,
        updatedAt: createdAt,
      },
      createdAt,
    });
  }

  function seedCheckpoint(
    harness: Harness,
    input: {
      readonly turnId: TurnId;
      readonly status: "ready" | "missing";
      readonly assistantMessageId: MessageId;
      readonly commandId: string;
    },
  ) {
    return dispatch(harness.engine, {
      type: "thread.turn.diff.complete",
      commandId: CommandId.make(input.commandId),
      threadId: ThreadId.make("thread-1"),
      turnId: input.turnId,
      completedAt: "2026-01-01T00:00:01.000Z",
      checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1),
      status: input.status,
      files: [],
      assistantMessageId: input.assistantMessageId,
      checkpointTurnCount: 1,
      createdAt: "2026-01-01T00:00:01.000Z",
    });
  }

  function sendAssistantMessage(
    harness: Harness,
    input: { readonly turnId: TurnId; readonly messageId: string; readonly commandId: string },
  ) {
    return dispatch(harness.engine, {
      type: "thread.message.assistant.complete",
      commandId: CommandId.make(input.commandId),
      threadId: ThreadId.make("thread-1"),
      messageId: MessageId.make(input.messageId),
      turnId: input.turnId,
      createdAt: "2026-01-01T00:00:02.000Z",
    });
  }

  function readEvents(harness: Harness) {
    return Stream.runCollect(harness.engine.readEvents(0)).pipe(
      Effect.map((events) => Array.from(events)),
    );
  }

  function settleReactor(harness: Harness) {
    return Effect.gen(function* () {
      yield* Effect.sleep("5 millis");
      yield* harness.drain();
    });
  }

  function advanceRefreshTimer(harness: Harness) {
    return Effect.gen(function* () {
      yield* Effect.sleep("5 millis");
      yield* harness.adjustClock("25 seconds");
      yield* harness.drain();
    });
  }

  it.live(
    "captures pre-turn baseline on turn.started and post-turn checkpoint on turn.completed",
    () =>
      Effect.gen(function* () {
        const harness = yield* createHarness({ seedFilesystemCheckpoints: false });
        const createdAt = "2026-01-01T00:00:00.000Z";

        yield* dispatch(harness.engine, {
          type: "thread.session.set",
          commandId: CommandId.make("cmd-session-set-capture"),
          threadId: ThreadId.make("thread-1"),
          session: {
            threadId: ThreadId.make("thread-1"),
            status: "ready",
            providerName: "codex",
            runtimeMode: "approval-required",
            activeTurnId: null,
            lastError: null,
            updatedAt: createdAt,
          },
          createdAt,
        });

        yield* harness.provider.emit({
          type: "turn.started",
          eventId: EventId.make("evt-turn-started-1"),
          provider: ProviderDriverKind.make("codex"),

          createdAt: "2026-01-01T00:00:00.000Z",
          threadId: ThreadId.make("thread-1"),
          turnId: asTurnId("turn-1"),
        });
        yield* waitForGitRefExists(
          harness.cwd,
          checkpointRefForThreadTurn(ThreadId.make("thread-1"), 0),
        );

        NodeFS.writeFileSync(NodePath.join(harness.cwd, "README.md"), "v2\n", "utf8");
        yield* harness.provider.emit({
          type: "turn.completed",
          eventId: EventId.make("evt-turn-completed-1"),
          provider: ProviderDriverKind.make("codex"),

          createdAt: "2026-01-01T00:00:00.000Z",
          threadId: ThreadId.make("thread-1"),
          turnId: asTurnId("turn-1"),
          payload: { state: "completed" },
        });

        yield* waitForEvent(harness.engine, (event) => event.type === "thread.turn-diff-completed");
        const thread = yield* waitForThread(
          harness.readModel,
          (entry) => entry.latestTurn?.turnId === "turn-1" && entry.checkpoints.length === 1,
        );
        expect(thread.checkpoints[0]?.checkpointTurnCount).toBe(1);
        expect(
          gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.make("thread-1"), 0)),
        ).toBe(true);
        expect(
          gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1)),
        ).toBe(true);
        expect(
          gitShowFileAtRef(
            harness.cwd,
            checkpointRefForThreadTurn(ThreadId.make("thread-1"), 0),
            "README.md",
          ),
        ).toBe("v1\n");
        expect(
          gitShowFileAtRef(
            harness.cwd,
            checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1),
            "README.md",
          ),
        ).toBe("v2\n");
      }),
  );

  it.live("names the subagent children that wrote inside the captured checkpoint", () =>
    Effect.gen(function* () {
      const harness = yield* createHarness({ seedFilesystemCheckpoints: false });
      const createdAt = "2026-01-01T00:00:00.000Z";

      yield* dispatch(harness.engine, {
        type: "thread.create",
        commandId: CommandId.make("cmd-child-thread-create"),
        threadId: ThreadId.make("thread-child"),
        projectId: asProjectId("project-1"),
        title: "Reviewer",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: harness.cwd,
        parentThreadId: ThreadId.make("thread-1"),
        createdAt,
      });
      // The child settles inside the parent's turn, so its checkpoint lands
      // before the parent's capture and falls inside the parent's window.
      yield* dispatch(harness.engine, {
        type: "thread.turn.diff.complete",
        commandId: CommandId.make("cmd-child-turn-diff"),
        threadId: ThreadId.make("thread-child"),
        turnId: asTurnId("turn-child-1"),
        completedAt: "2026-01-01T00:00:02.000Z",
        checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-child"), 1),
        status: "ready",
        files: [{ path: "README.md", kind: "modified", additions: 1, deletions: 0 }],
        assistantMessageId: MessageId.make("message-child-1"),
        checkpointTurnCount: 1,
        createdAt: "2026-01-01T00:00:02.000Z",
      });

      yield* setThreadSession(harness, {
        status: "ready",
        activeTurnId: null,
        commandId: "cmd-session-set-subagent-attribution",
      });

      yield* harness.provider.emit({
        type: "turn.started",
        eventId: EventId.make("evt-turn-started-attribution"),
        provider: ProviderDriverKind.make("codex"),
        createdAt,
        threadId: ThreadId.make("thread-1"),
        turnId: asTurnId("turn-1"),
      });
      yield* waitForGitRefExists(
        harness.cwd,
        checkpointRefForThreadTurn(ThreadId.make("thread-1"), 0),
      );

      NodeFS.writeFileSync(NodePath.join(harness.cwd, "README.md"), "v2\n", "utf8");
      yield* harness.provider.emit({
        type: "turn.completed",
        eventId: EventId.make("evt-turn-completed-attribution"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:05.000Z",
        threadId: ThreadId.make("thread-1"),
        turnId: asTurnId("turn-1"),
        payload: { state: "completed" },
      });

      const events = yield* waitForEvent(
        harness.engine,
        (entry) =>
          entry.type === "thread.turn-diff-completed" &&
          (entry as OrchestrationEvent).aggregateId === "thread-1",
      );
      const captured = events.find(
        (entry): entry is Extract<OrchestrationEvent, { type: "thread.turn-diff-completed" }> =>
          entry.type === "thread.turn-diff-completed" && entry.aggregateId === "thread-1",
      );
      expect(captured?.payload.subagentContributions).toEqual([
        { threadId: "thread-child", title: "Reviewer", paths: ["README.md"] },
      ]);
    }),
  );

  it.live("anchors a synthetic placeholder replacement to the first assistant message", () =>
    Effect.gen(function* () {
      const harness = yield* createHarness();
      const turnId = asTurnId("turn-first-assistant");

      yield* dispatch(harness.engine, {
        type: "thread.message.assistant.complete",
        commandId: CommandId.make("cmd-first-assistant"),
        threadId: ThreadId.make("thread-1"),
        messageId: MessageId.make("message-first-assistant"),
        turnId,
        createdAt: "2026-01-01T00:00:01.000Z",
      });
      yield* dispatch(harness.engine, {
        type: "thread.message.assistant.complete",
        commandId: CommandId.make("cmd-second-assistant"),
        threadId: ThreadId.make("thread-1"),
        messageId: MessageId.make("message-second-assistant"),
        turnId,
        createdAt: "2026-01-01T00:00:02.000Z",
      });
      yield* dispatch(harness.engine, {
        type: "thread.turn.diff.complete",
        commandId: CommandId.make("cmd-synthetic-diff"),
        threadId: ThreadId.make("thread-1"),
        turnId,
        completedAt: "2026-01-01T00:00:03.000Z",
        checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1),
        status: "missing",
        files: [],
        assistantMessageId: MessageId.make(`assistant:${turnId}`),
        checkpointTurnCount: 1,
        createdAt: "2026-01-01T00:00:03.000Z",
      });

      const thread = yield* waitForThread(harness.readModel, (entry) =>
        entry.checkpoints.some((checkpoint) => checkpoint.checkpointTurnCount === 1),
      );
      expect(thread.checkpoints[0]).toMatchObject({
        checkpointTurnCount: 1,
        assistantMessageId: "message-first-assistant",
      });
    }),
  );

  it.live("coalesces assistant messages into one trailing checkpoint refresh", () =>
    Effect.gen(function* () {
      const receipts: OrchestrationRuntimeReceipt[] = [];
      const harness = yield* createHarness({
        receiptCalls: receipts,
        useTestClock: true,
      });
      const turnId = asTurnId("turn-refresh");
      const checkpointRef = checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1);
      const assistantMessageId = MessageId.make("message-anchor");

      yield* setThreadSession(harness, {
        status: "running",
        activeTurnId: turnId,
        commandId: "cmd-refresh-running",
      });
      yield* seedCheckpoint(harness, {
        turnId,
        status: "ready",
        assistantMessageId,
        commandId: "cmd-refresh-seed",
      });
      yield* settleReactor(harness);
      receipts.length = 0;

      NodeFS.writeFileSync(NodePath.join(harness.cwd, "NEW.md"), "new\n", "utf8");
      for (const index of [1, 2, 3]) {
        yield* sendAssistantMessage(harness, {
          turnId,
          messageId: `message-refresh-${index}`,
          commandId: `cmd-refresh-message-${index}`,
        });
        yield* Effect.sleep("5 millis");
        yield* harness.adjustClock("1 second");
      }
      yield* advanceRefreshTimer(harness);

      const events = yield* readEvents(harness);
      const refreshEvents = events.filter(
        (event) => event.type === "thread.turn-diff-completed" && event.payload.turnId === turnId,
      );
      expect(refreshEvents).toHaveLength(2);
      expect(refreshEvents[1]?.payload).toMatchObject({
        checkpointTurnCount: 1,
        checkpointRef,
        assistantMessageId,
        status: "ready",
      });
      expect(refreshEvents[1]).toMatchObject({
        payload: {
          files: expect.arrayContaining([
            { path: "NEW.md", kind: "modified", additions: 1, deletions: 0 },
          ]),
        },
      });

      const readModel = yield* harness.readModel();
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      expect(thread?.checkpoints).toEqual([
        expect.objectContaining({
          turnId,
          checkpointTurnCount: 1,
          checkpointRef,
          assistantMessageId,
          status: "ready",
        }),
      ]);
      expect(thread?.checkpoints[0]?.files).toContainEqual({
        path: "NEW.md",
        kind: "modified",
        additions: 1,
        deletions: 0,
      });
      expect(gitShowFileAtRef(harness.cwd, checkpointRef, "NEW.md")).toBe("new\n");
      expect(
        thread?.activities.filter((activity) => activity.kind === "checkpoint.captured"),
      ).toEqual([]);
      expect(receipts).toEqual([]);
    }),
  );

  it.live("cancels a pending refresh when the active turn settles", () =>
    Effect.gen(function* () {
      const harness = yield* createHarness({ useTestClock: true });
      const turnId = asTurnId("turn-settles");
      const assistantMessageId = MessageId.make("message-settles-anchor");

      yield* setThreadSession(harness, {
        status: "running",
        activeTurnId: turnId,
        commandId: "cmd-settles-running",
      });
      yield* seedCheckpoint(harness, {
        turnId,
        status: "ready",
        assistantMessageId,
        commandId: "cmd-settles-seed",
      });
      yield* advanceRefreshTimer(harness);
      yield* sendAssistantMessage(harness, {
        turnId,
        messageId: "message-before-settle",
        commandId: "cmd-message-before-settle",
      });
      yield* Effect.sleep("5 millis");
      yield* setThreadSession(harness, {
        status: "ready",
        activeTurnId: null,
        commandId: "cmd-settles-ready",
      });
      yield* settleReactor(harness);
      yield* harness.adjustClock("25 seconds");
      yield* harness.drain();

      const events = yield* readEvents(harness);
      expect(
        events.filter(
          (event) => event.type === "thread.turn-diff-completed" && event.payload.turnId === turnId,
        ),
      ).toHaveLength(1);
    }),
  );

  it.live("does not refresh a missing checkpoint", () =>
    Effect.gen(function* () {
      const harness = yield* createHarness({
        startReactor: false,
        useTestClock: true,
      });
      const turnId = asTurnId("turn-missing-refresh");

      yield* setThreadSession(harness, {
        status: "running",
        activeTurnId: turnId,
        commandId: "cmd-missing-running",
      });
      yield* seedCheckpoint(harness, {
        turnId,
        status: "missing",
        assistantMessageId: MessageId.make("message-missing-anchor"),
        commandId: "cmd-missing-seed",
      });
      yield* harness.start();
      yield* sendAssistantMessage(harness, {
        turnId,
        messageId: "message-missing-refresh",
        commandId: "cmd-message-missing-refresh",
      });
      yield* advanceRefreshTimer(harness);

      const events = yield* readEvents(harness);
      expect(
        events.filter(
          (event) => event.type === "thread.turn-diff-completed" && event.payload.turnId === turnId,
        ),
      ).toHaveLength(1);
    }),
  );

  it.live("does not refresh a checkpoint for a message from another turn", () =>
    Effect.gen(function* () {
      const harness = yield* createHarness({ useTestClock: true });
      const turnId = asTurnId("turn-primary-refresh");

      yield* setThreadSession(harness, {
        status: "running",
        activeTurnId: turnId,
        commandId: "cmd-primary-running",
      });
      yield* seedCheckpoint(harness, {
        turnId,
        status: "ready",
        assistantMessageId: MessageId.make("message-primary-anchor"),
        commandId: "cmd-primary-seed",
      });
      yield* advanceRefreshTimer(harness);
      yield* sendAssistantMessage(harness, {
        turnId: asTurnId("turn-other-refresh"),
        messageId: "message-other-turn",
        commandId: "cmd-message-other-turn",
      });
      yield* advanceRefreshTimer(harness);

      const events = yield* readEvents(harness);
      expect(
        events.filter(
          (event) => event.type === "thread.turn-diff-completed" && event.payload.turnId === turnId,
        ),
      ).toHaveLength(1);
    }),
  );

  it.live("keeps the primary refresh when an auxiliary turn completes", () =>
    Effect.gen(function* () {
      const harness = yield* createHarness({ useTestClock: true });
      const turnId = asTurnId("turn-primary-completion");

      yield* setThreadSession(harness, {
        status: "running",
        activeTurnId: turnId,
        commandId: "cmd-primary-completion-running",
      });
      yield* seedCheckpoint(harness, {
        turnId,
        status: "ready",
        assistantMessageId: MessageId.make("message-primary-completion-anchor"),
        commandId: "cmd-primary-completion-seed",
      });
      yield* advanceRefreshTimer(harness);
      NodeFS.writeFileSync(NodePath.join(harness.cwd, "AUX.md"), "kept\n", "utf8");
      yield* sendAssistantMessage(harness, {
        turnId,
        messageId: "message-before-aux-completion",
        commandId: "cmd-message-before-aux-completion",
      });
      yield* Effect.sleep("5 millis");

      yield* harness.provider.emit({
        type: "turn.completed",
        eventId: EventId.make("evt-aux-completed-during-refresh"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:03.000Z",
        threadId: ThreadId.make("thread-1"),
        turnId: asTurnId("turn-aux-completion"),
        payload: { state: "completed" },
      });
      yield* advanceRefreshTimer(harness);

      const events = yield* readEvents(harness);
      const refreshEvents = events.filter(
        (event) => event.type === "thread.turn-diff-completed" && event.payload.turnId === turnId,
      );
      expect(refreshEvents).toHaveLength(2);
      expect(refreshEvents[1]).toMatchObject({
        payload: {
          files: expect.arrayContaining([
            { path: "AUX.md", kind: "modified", additions: 1, deletions: 0 },
          ]),
        },
      });
    }),
  );

  it.live("refreshes local git status state on turn completion using the session cwd", () =>
    Effect.gen(function* () {
      const gitStatusRefreshCalls: string[] = [];
      const harness = yield* createHarness({
        seedFilesystemCheckpoints: false,
        gitStatusRefreshCalls,
      });

      yield* harness.provider.emit({
        type: "turn.completed",
        eventId: EventId.make("evt-turn-completed-refresh-local-status"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        threadId: ThreadId.make("thread-1"),
        turnId: asTurnId("turn-refresh-local-status"),
        payload: { state: "completed" },
      });

      yield* harness.drain();

      expect(gitStatusRefreshCalls).toEqual([harness.cwd]);
    }),
  );

  it.live("ignores auxiliary thread turn completion while primary turn is active", () =>
    Effect.gen(function* () {
      const harness = yield* createHarness({ seedFilesystemCheckpoints: false });
      const createdAt = "2026-01-01T00:00:00.000Z";

      yield* dispatch(harness.engine, {
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-primary-running"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-main"),
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      });

      yield* harness.provider.emit({
        type: "turn.started",
        eventId: EventId.make("evt-turn-started-main"),
        provider: ProviderDriverKind.make("codex"),

        createdAt: "2026-01-01T00:00:00.000Z",
        threadId: ThreadId.make("thread-1"),
        turnId: asTurnId("turn-main"),
      });
      yield* waitForGitRefExists(
        harness.cwd,
        checkpointRefForThreadTurn(ThreadId.make("thread-1"), 0),
      );

      NodeFS.writeFileSync(NodePath.join(harness.cwd, "README.md"), "v2\n", "utf8");

      yield* harness.provider.emit({
        type: "turn.completed",
        eventId: EventId.make("evt-turn-completed-aux"),
        provider: ProviderDriverKind.make("codex"),

        createdAt: "2026-01-01T00:00:00.000Z",
        threadId: ThreadId.make("thread-1"),
        turnId: asTurnId("turn-aux"),
        payload: { state: "completed" },
      });

      yield* harness.drain();
      const midReadModel = yield* harness.readModel();
      const midThread = midReadModel.threads.find(
        (entry) => entry.id === ThreadId.make("thread-1"),
      );
      expect(midThread?.checkpoints).toHaveLength(0);

      yield* harness.provider.emit({
        type: "turn.completed",
        eventId: EventId.make("evt-turn-completed-main"),
        provider: ProviderDriverKind.make("codex"),

        createdAt: "2026-01-01T00:00:00.000Z",
        threadId: ThreadId.make("thread-1"),
        turnId: asTurnId("turn-main"),
        payload: { state: "completed" },
      });

      const thread = yield* waitForThread(
        harness.readModel,
        (entry) => entry.latestTurn?.turnId === "turn-main" && entry.checkpoints.length === 1,
      );
      expect(thread.checkpoints[0]?.checkpointTurnCount).toBe(1);
    }),
  );

  it.live("captures pre-turn and completion checkpoints for claude runtime events", () =>
    Effect.gen(function* () {
      const harness = yield* createHarness({
        seedFilesystemCheckpoints: false,
        providerName: ProviderDriverKind.make("claudeAgent"),
      });
      const createdAt = "2026-01-01T00:00:00.000Z";

      yield* dispatch(harness.engine, {
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-capture-claude"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "claudeAgent",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      });

      yield* harness.provider.emit({
        type: "turn.started",
        eventId: EventId.make("evt-turn-started-claude-1"),
        provider: ProviderDriverKind.make("claudeAgent"),
        createdAt: "2026-01-01T00:00:00.000Z",
        threadId: ThreadId.make("thread-1"),
        turnId: asTurnId("turn-claude-1"),
      });
      yield* waitForGitRefExists(
        harness.cwd,
        checkpointRefForThreadTurn(ThreadId.make("thread-1"), 0),
      );

      NodeFS.writeFileSync(NodePath.join(harness.cwd, "README.md"), "v2\n", "utf8");
      yield* harness.provider.emit({
        type: "turn.completed",
        eventId: EventId.make("evt-turn-completed-claude-1"),
        provider: ProviderDriverKind.make("claudeAgent"),
        createdAt: "2026-01-01T00:00:00.000Z",
        threadId: ThreadId.make("thread-1"),
        turnId: asTurnId("turn-claude-1"),
        payload: { state: "completed" },
      });

      yield* waitForEvent(harness.engine, (event) => event.type === "thread.turn-diff-completed");
      const thread = yield* waitForThread(
        harness.readModel,
        (entry) => entry.latestTurn?.turnId === "turn-claude-1" && entry.checkpoints.length === 1,
      );

      expect(thread.checkpoints[0]?.checkpointTurnCount).toBe(1);
      expect(
        gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1)),
      ).toBe(true);
    }),
  );

  it.live("appends capture failure activity when turn diff summary cannot be derived", () =>
    Effect.gen(function* () {
      const harness = yield* createHarness({ seedFilesystemCheckpoints: false });
      const createdAt = "2026-01-01T00:00:00.000Z";

      yield* dispatch(harness.engine, {
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-missing-baseline-diff"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      });

      yield* harness.provider.emit({
        type: "turn.completed",
        eventId: EventId.make("evt-turn-completed-missing-baseline"),
        provider: ProviderDriverKind.make("codex"),

        createdAt: "2026-01-01T00:00:00.000Z",
        threadId: ThreadId.make("thread-1"),
        turnId: asTurnId("turn-missing-baseline"),
        payload: { state: "completed" },
      });

      yield* waitForEvent(harness.engine, (event) => event.type === "thread.turn-diff-completed");
      const thread = yield* waitForThread(
        harness.readModel,
        (entry) =>
          entry.checkpoints.length === 1 &&
          entry.activities.some((activity) => activity.kind === "checkpoint.capture.failed"),
      );

      expect(thread.checkpoints[0]?.checkpointTurnCount).toBe(1);
      expect(
        thread.activities.some((activity) => activity.kind === "checkpoint.capture.failed"),
      ).toBe(true);
    }),
  );

  it.live(
    "captures pre-turn baseline from project workspace root when thread worktree is unset",
    () =>
      Effect.gen(function* () {
        const harness = yield* createHarness({
          hasSession: false,
          seedFilesystemCheckpoints: false,
          threadWorktreePath: null,
        });

        yield* dispatch(harness.engine, {
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-turn-start-for-baseline"),
          threadId: ThreadId.make("thread-1"),
          message: {
            messageId: MessageId.make("message-user-1"),
            role: "user",
            text: "start turn",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: "2026-01-01T00:00:00.000Z",
        });

        yield* waitForGitRefExists(
          harness.cwd,
          checkpointRefForThreadTurn(ThreadId.make("thread-1"), 0),
        );
        expect(
          gitShowFileAtRef(
            harness.cwd,
            checkpointRefForThreadTurn(ThreadId.make("thread-1"), 0),
            "README.md",
          ),
        ).toBe("v1\n");
      }),
  );

  it.live(
    "captures turn completion checkpoint from project workspace root when provider session cwd is unavailable",
    () =>
      Effect.gen(function* () {
        const harness = yield* createHarness({
          hasSession: false,
          seedFilesystemCheckpoints: false,
          threadWorktreePath: null,
        });
        const createdAt = "2026-01-01T00:00:00.000Z";

        yield* dispatch(harness.engine, {
          type: "thread.session.set",
          commandId: CommandId.make("cmd-session-set-missing-provider-cwd"),
          threadId: ThreadId.make("thread-1"),
          session: {
            threadId: ThreadId.make("thread-1"),
            status: "running",
            providerName: "codex",
            runtimeMode: "approval-required",
            activeTurnId: asTurnId("turn-missing-cwd"),
            lastError: null,
            updatedAt: createdAt,
          },
          createdAt,
        });

        NodeFS.writeFileSync(NodePath.join(harness.cwd, "README.md"), "v2\n", "utf8");
        yield* harness.provider.emit({
          type: "turn.completed",
          eventId: EventId.make("evt-turn-completed-missing-provider-cwd"),
          provider: ProviderDriverKind.make("codex"),

          createdAt: "2026-01-01T00:00:00.000Z",
          threadId: ThreadId.make("thread-1"),
          turnId: asTurnId("turn-missing-cwd"),
          payload: { state: "completed" },
        });

        yield* waitForEvent(harness.engine, (event) => event.type === "thread.turn-diff-completed");
        expect(
          gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1)),
        ).toBe(true);
        expect(
          gitShowFileAtRef(
            harness.cwd,
            checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1),
            "README.md",
          ),
        ).toBe("v2\n");
      }),
  );

  it.live("ignores non-v2 checkpoint.captured runtime events", () =>
    Effect.gen(function* () {
      const harness = yield* createHarness();
      const createdAt = "2026-01-01T00:00:00.000Z";

      yield* dispatch(harness.engine, {
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-checkpoint-captured"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      });

      yield* harness.provider.emit({
        type: "checkpoint.captured",
        eventId: EventId.make("evt-checkpoint-captured-3"),
        provider: ProviderDriverKind.make("codex"),

        createdAt: "2026-01-01T00:00:00.000Z",
        threadId: ThreadId.make("thread-1"),
        turnId: asTurnId("turn-3"),
        turnCount: 3,
        status: "completed",
      });

      yield* harness.drain();
      const readModel = yield* harness.readModel();
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      expect(thread?.checkpoints.some((checkpoint) => checkpoint.checkpointTurnCount === 3)).toBe(
        false,
      );
    }),
  );

  it.live("continues processing runtime events after a single checkpoint runtime failure", () =>
    Effect.gen(function* () {
      const nonRepositorySessionCwd = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3-checkpoint-runtime-non-repo-"),
      );
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(nonRepositorySessionCwd, { recursive: true, force: true })),
      );

      const harness = yield* createHarness({
        seedFilesystemCheckpoints: false,
        providerSessionCwd: nonRepositorySessionCwd,
      });
      const createdAt = "2026-01-01T00:00:00.000Z";

      yield* dispatch(harness.engine, {
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-non-repo-runtime"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      });

      yield* harness.provider.emit({
        type: "turn.completed",
        eventId: EventId.make("evt-runtime-capture-failure"),
        provider: ProviderDriverKind.make("codex"),

        createdAt: "2026-01-01T00:00:00.000Z",
        threadId: ThreadId.make("thread-1"),
        turnId: asTurnId("turn-runtime-failure"),
        payload: { state: "completed" },
      });

      yield* harness.provider.emit({
        type: "turn.started",
        eventId: EventId.make("evt-turn-started-after-runtime-failure"),
        provider: ProviderDriverKind.make("codex"),

        createdAt: "2026-01-01T00:00:00.000Z",
        threadId: ThreadId.make("thread-1"),
        turnId: asTurnId("turn-after-runtime-failure"),
      });

      yield* waitForGitRefExists(
        harness.cwd,
        checkpointRefForThreadTurn(ThreadId.make("thread-1"), 0),
      );
      expect(
        gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.make("thread-1"), 0)),
      ).toBe(true);
    }),
  );

  it.live("executes provider revert and emits thread.reverted for checkpoint revert requests", () =>
    Effect.gen(function* () {
      const harness = yield* createHarness();
      const createdAt = "2026-01-01T00:00:00.000Z";

      yield* dispatch(harness.engine, {
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      });

      yield* dispatch(harness.engine, {
        type: "thread.turn.diff.complete",
        commandId: CommandId.make("cmd-diff-1"),
        threadId: ThreadId.make("thread-1"),
        turnId: asTurnId("turn-1"),
        completedAt: createdAt,
        checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1),
        status: "ready",
        files: [],
        checkpointTurnCount: 1,
        createdAt,
      });
      yield* dispatch(harness.engine, {
        type: "thread.turn.diff.complete",
        commandId: CommandId.make("cmd-diff-2"),
        threadId: ThreadId.make("thread-1"),
        turnId: asTurnId("turn-2"),
        completedAt: createdAt,
        checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), 2),
        status: "ready",
        files: [],
        checkpointTurnCount: 2,
        createdAt,
      });

      yield* dispatch(harness.engine, {
        type: "thread.checkpoint.revert",
        commandId: CommandId.make("cmd-revert-request"),
        threadId: ThreadId.make("thread-1"),
        turnCount: 1,
        createdAt,
      });

      yield* waitForEvent(harness.engine, (event) => event.type === "thread.reverted");
      const thread = yield* waitForThread(
        harness.readModel,
        (entry) => entry.checkpoints.length === 1,
      );

      expect(thread.latestTurn?.turnId).toBe("turn-1");
      expect(thread.checkpoints).toHaveLength(1);
      expect(thread.checkpoints[0]?.checkpointTurnCount).toBe(1);
      expect(harness.provider.rollbackConversation).toHaveBeenCalledTimes(1);
      expect(harness.provider.rollbackConversation).toHaveBeenCalledWith({
        threadId: ThreadId.make("thread-1"),
        numTurns: 1,
      });
      expect(NodeFS.readFileSync(NodePath.join(harness.cwd, "README.md"), "utf8")).toBe("v2\n");
      expect(
        gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.make("thread-1"), 2)),
      ).toBe(false);
    }),
  );

  it.live("executes provider revert and emits thread.reverted for claude sessions", () =>
    Effect.gen(function* () {
      const harness = yield* createHarness({
        providerName: ProviderDriverKind.make("claudeAgent"),
      });
      const createdAt = "2026-01-01T00:00:00.000Z";

      yield* dispatch(harness.engine, {
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-claude"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "claudeAgent",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      });

      yield* dispatch(harness.engine, {
        type: "thread.turn.diff.complete",
        commandId: CommandId.make("cmd-diff-claude-1"),
        threadId: ThreadId.make("thread-1"),
        turnId: asTurnId("turn-claude-1"),
        completedAt: createdAt,
        checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1),
        status: "ready",
        files: [],
        checkpointTurnCount: 1,
        createdAt,
      });
      yield* dispatch(harness.engine, {
        type: "thread.turn.diff.complete",
        commandId: CommandId.make("cmd-diff-claude-2"),
        threadId: ThreadId.make("thread-1"),
        turnId: asTurnId("turn-claude-2"),
        completedAt: createdAt,
        checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), 2),
        status: "ready",
        files: [],
        checkpointTurnCount: 2,
        createdAt,
      });

      yield* dispatch(harness.engine, {
        type: "thread.checkpoint.revert",
        commandId: CommandId.make("cmd-revert-request-claude"),
        threadId: ThreadId.make("thread-1"),
        turnCount: 1,
        createdAt,
      });

      yield* waitForEvent(harness.engine, (event) => event.type === "thread.reverted");
      expect(harness.provider.rollbackConversation).toHaveBeenCalledTimes(1);
      expect(harness.provider.rollbackConversation).toHaveBeenCalledWith({
        threadId: ThreadId.make("thread-1"),
        numTurns: 1,
      });
    }),
  );

  it.live("processes consecutive revert requests with deterministic rollback sequencing", () =>
    Effect.gen(function* () {
      const harness = yield* createHarness();
      const createdAt = "2026-01-01T00:00:00.000Z";

      yield* dispatch(harness.engine, {
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-inline-revert"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      });

      yield* dispatch(harness.engine, {
        type: "thread.turn.diff.complete",
        commandId: CommandId.make("cmd-inline-revert-diff-1"),
        threadId: ThreadId.make("thread-1"),
        turnId: asTurnId("turn-1"),
        completedAt: createdAt,
        checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1),
        status: "ready",
        files: [],
        checkpointTurnCount: 1,
        createdAt,
      });
      yield* dispatch(harness.engine, {
        type: "thread.turn.diff.complete",
        commandId: CommandId.make("cmd-inline-revert-diff-2"),
        threadId: ThreadId.make("thread-1"),
        turnId: asTurnId("turn-2"),
        completedAt: createdAt,
        checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), 2),
        status: "ready",
        files: [],
        checkpointTurnCount: 2,
        createdAt,
      });

      yield* dispatch(harness.engine, {
        type: "thread.checkpoint.revert",
        commandId: CommandId.make("cmd-sequenced-revert-request-1"),
        threadId: ThreadId.make("thread-1"),
        turnCount: 1,
        createdAt,
      });
      yield* dispatch(harness.engine, {
        type: "thread.checkpoint.revert",
        commandId: CommandId.make("cmd-sequenced-revert-request-0"),
        threadId: ThreadId.make("thread-1"),
        turnCount: 0,
        createdAt,
      });

      yield* harness.drain();

      expect(harness.provider.rollbackConversation).toHaveBeenCalledTimes(2);
      expect(harness.provider.rollbackConversation.mock.calls[0]?.[0]).toEqual({
        threadId: ThreadId.make("thread-1"),
        numTurns: 1,
      });
      expect(harness.provider.rollbackConversation.mock.calls[1]?.[0]).toEqual({
        threadId: ThreadId.make("thread-1"),
        numTurns: 1,
      });
    }),
  );

  it.live("refuses a revert while another session runs a turn in the same worktree", () =>
    Effect.gen(function* () {
      const createdAt = "2026-01-01T00:00:00.000Z";
      const harness = yield* createHarness({
        peerSessions: (cwd) => [
          {
            provider: ProviderDriverKind.make("codex"),
            status: "running",
            runtimeMode: "full-access",
            threadId: ThreadId.make("thread-child"),
            cwd,
            activeTurnId: asTurnId("turn-child-1"),
            createdAt,
            updatedAt: createdAt,
          },
        ],
      });

      yield* setThreadSession(harness, {
        status: "ready",
        activeTurnId: null,
        commandId: "cmd-session-set-busy-peer",
      });
      yield* dispatch(harness.engine, {
        type: "thread.turn.diff.complete",
        commandId: CommandId.make("cmd-busy-peer-diff-1"),
        threadId: ThreadId.make("thread-1"),
        turnId: asTurnId("turn-1"),
        completedAt: createdAt,
        checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1),
        status: "ready",
        files: [],
        checkpointTurnCount: 1,
        createdAt,
      });

      yield* dispatch(harness.engine, {
        type: "thread.checkpoint.revert",
        commandId: CommandId.make("cmd-revert-busy-peer"),
        threadId: ThreadId.make("thread-1"),
        turnCount: 1,
        createdAt,
      });

      yield* waitForThread(harness.readModel, (entry) =>
        entry.activities.some((activity) => activity.kind === "checkpoint.revert.failed"),
      );

      const snapshot = yield* harness.readModel();
      const failure = snapshot.threads
        .find((entry) => entry.id === ThreadId.make("thread-1"))
        ?.activities.find((activity) => activity.kind === "checkpoint.revert.failed");
      // @effect-diagnostics-next-line preferSchemaOverJson:off - asserts on the serialized payload text.
      expect(JSON.stringify(failure?.payload)).toContain("thread-child");
      expect(harness.provider.rollbackConversation).not.toHaveBeenCalled();
      // The worktree still holds the peer's in-flight state.
      expect(NodeFS.readFileSync(NodePath.join(harness.cwd, "README.md"), "utf8")).toBe("v3\n");
      const events = yield* readEvents(harness);
      expect(events.some((event) => event.type === "thread.reverted")).toBe(false);
    }),
  );

  it.live("allows a revert when the session sharing the worktree is idle", () =>
    Effect.gen(function* () {
      const createdAt = "2026-01-01T00:00:00.000Z";
      const harness = yield* createHarness({
        peerSessions: (cwd) => [
          {
            provider: ProviderDriverKind.make("codex"),
            status: "ready",
            runtimeMode: "full-access",
            threadId: ThreadId.make("thread-child"),
            cwd,
            createdAt,
            updatedAt: createdAt,
          },
        ],
      });

      yield* setThreadSession(harness, {
        status: "ready",
        activeTurnId: null,
        commandId: "cmd-session-set-idle-peer",
      });
      yield* dispatch(harness.engine, {
        type: "thread.turn.diff.complete",
        commandId: CommandId.make("cmd-idle-peer-diff-1"),
        threadId: ThreadId.make("thread-1"),
        turnId: asTurnId("turn-1"),
        completedAt: createdAt,
        checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1),
        status: "ready",
        files: [],
        checkpointTurnCount: 1,
        createdAt,
      });

      yield* dispatch(harness.engine, {
        type: "thread.checkpoint.revert",
        commandId: CommandId.make("cmd-revert-idle-peer"),
        threadId: ThreadId.make("thread-1"),
        turnCount: 1,
        createdAt,
      });

      yield* waitForEvent(harness.engine, (event) => event.type === "thread.reverted");
      expect(NodeFS.readFileSync(NodePath.join(harness.cwd, "README.md"), "utf8")).toBe("v2\n");
    }),
  );

  it.live("appends an error activity when revert is requested without an active session", () =>
    Effect.gen(function* () {
      const harness = yield* createHarness({ hasSession: false });
      const createdAt = "2026-01-01T00:00:00.000Z";

      yield* dispatch(harness.engine, {
        type: "thread.checkpoint.revert",
        commandId: CommandId.make("cmd-revert-no-session"),
        threadId: ThreadId.make("thread-1"),
        turnCount: 1,
        createdAt,
      });

      const thread = yield* waitForThread(harness.readModel, (entry) =>
        entry.activities.some((activity) => activity.kind === "checkpoint.revert.failed"),
      );

      expect(
        thread.activities.some((activity) => activity.kind === "checkpoint.revert.failed"),
      ).toBe(true);
      expect(harness.provider.rollbackConversation).not.toHaveBeenCalled();
    }),
  );
});
