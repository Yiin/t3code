import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  EventId,
  MessageId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationThread,
  type OrchestrationThreadShell,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { spawnAgent } from "./handlers.ts";
import {
  clearAllSpawns,
  deregisterSpawn,
  findSpawnByChild,
  liveChildCount,
  listSpawnsOfParent,
  registerSpawn,
  spawnParentDepth,
  watchSpawnCancellations,
  type SpawnRegistration,
} from "./SpawnRegistry.ts";
import { DEFAULT_SPAWN_POLICY, type SpawnPolicy } from "./spawnPolicy.ts";

const PARENT_THREAD_ID = ThreadId.make("thread-parent");
const CHILD_TURN_ID = TurnId.make("turn-child");
const CHILD_MESSAGE_ID = MessageId.make("child-assistant-1");
const CHILD_TEXT = "Half an answer.";

const enabledPolicy: SpawnPolicy = { ...DEFAULT_SPAWN_POLICY, enabled: true };

const shell = (overrides: Partial<OrchestrationThreadShell> = {}): OrchestrationThreadShell => ({
  id: PARENT_THREAD_ID,
  projectId: ProjectId.make("project-1"),
  title: "Parent thread",
  modelSelection: { instanceId: ProviderInstanceId.make("claude"), model: "claude-opus-5" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: "mine",
  worktreePath: "/tmp/parent-worktree",
  latestTurn: null,
  createdAt: "2026-08-11T00:00:00.000Z",
  updatedAt: "2026-08-11T00:00:00.000Z",
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  session: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
  activeSubagentCount: 0,
  parentThreadId: null,
  ...overrides,
});

/**
 * The child the parent waits on. `running` never ends, so only a cancellation
 * can end the wait; `completed` is the ordinary settle, kept here only to prove
 * the registration falls away on that path too.
 */
type ChildTurnState = "running" | "completed";

const runningChildShell = (
  childThreadId: ThreadId,
  turnState: ChildTurnState = "running",
): OrchestrationThreadShell =>
  shell({
    id: childThreadId,
    parentThreadId: PARENT_THREAD_ID,
    latestTurn: {
      turnId: CHILD_TURN_ID,
      state: turnState,
      requestedAt: "2026-08-11T00:00:00.000Z",
      startedAt: "2026-08-11T00:00:00.000Z",
      completedAt: turnState === "running" ? null : "2026-08-11T00:00:05.000Z",
      assistantMessageId: CHILD_MESSAGE_ID,
    },
  });

/** The same child as a full thread, carrying the half answer it managed. */
const runningChildThread = (
  childThreadId: ThreadId,
  turnState: ChildTurnState = "running",
): OrchestrationThread => {
  const asShell = runningChildShell(childThreadId, turnState);
  return {
    id: childThreadId,
    projectId: asShell.projectId,
    title: "Subagent",
    modelSelection: asShell.modelSelection,
    runtimeMode: asShell.runtimeMode,
    interactionMode: asShell.interactionMode,
    branch: asShell.branch,
    worktreePath: asShell.worktreePath,
    latestTurn: asShell.latestTurn,
    createdAt: asShell.createdAt,
    updatedAt: asShell.updatedAt,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    parentThreadId: PARENT_THREAD_ID,
    messages: [
      {
        id: CHILD_MESSAGE_ID,
        role: "assistant",
        text: CHILD_TEXT,
        turnId: CHILD_TURN_ID,
        streaming: false,
        createdAt: "2026-08-11T00:00:04.000Z",
        updatedAt: "2026-08-11T00:00:05.000Z",
      },
    ],
    proposedPlans: [],
    subagents: [],
    activities: [],
    checkpoints: [],
    session: null,
  };
};

const invocation: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: PARENT_THREAD_ID,
  providerSessionId: "provider-session-1",
  providerInstanceId: ProviderInstanceId.make("claude"),
  capabilities: new Set(["preview", "spawn-agent"]),
  issuedAt: 1,
  expiresAt: 2,
};

const spawnInput = {
  agent_type: "Explore",
  description: "Audit the settings migrations",
  prompt: "Find every migration that writes to settings.",
};

const cancellationEvent = (
  type: "thread.turn-interrupt-requested" | "thread.session-stop-requested",
  threadId: ThreadId,
): OrchestrationEvent =>
  ({
    sequence: 1,
    eventId: EventId.make(`event-${type}-${threadId}`),
    aggregateKind: "thread",
    aggregateId: threadId,
    occurredAt: "2026-08-11T00:00:10.000Z",
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type,
    payload: { threadId, createdAt: "2026-08-11T00:00:10.000Z" },
  }) as OrchestrationEvent;

interface RunOptions {
  readonly policy?: SpawnPolicy;
  /** Command types whose dispatch dies, to prove cleanup never rethrows. */
  readonly dyingCommandTypes?: ReadonlySet<string>;
  readonly childTurnState?: ChildTurnState;
}

/**
 * Start one `spawn_agent` call against a child that never settles, with the
 * cancellation watch listening on a queue the test can push events onto.
 *
 * The handler runs on its own fiber so the test can act while it waits, which is
 * the whole point: every rule here is about something happening mid-wait.
 */
const startSpawn = (options: RunOptions = {}) =>
  Effect.gen(function* () {
    const dispatched = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
    const events = yield* Queue.make<OrchestrationEvent>();
    const parentShell = shell();
    const turnState = options.childTurnState ?? "running";
    const isChild = (threadId: ThreadId) => threadId !== PARENT_THREAD_ID;

    const engine: OrchestrationEngineService["Service"] = {
      readEvents: () => Stream.empty,
      dispatch: (command) =>
        Ref.update(dispatched, (commands) => [...commands, command]).pipe(
          Effect.andThen(
            options.dyingCommandTypes?.has(command.type) === true
              ? Effect.die(`dispatch failed for ${command.type}`)
              : Effect.succeed({ sequence: 1 }),
          ),
        ),
      streamDomainEvents: Stream.fromQueue(events),
      latestSequence: Effect.succeed(0),
    };

    const projection: ProjectionSnapshotQuery["Service"] = {
      getCommandReadModel: () => Effect.die("unused"),
      getSnapshot: () => Effect.die("unused"),
      getShellSnapshot: () => Effect.die("unused"),
      getArchivedShellSnapshot: () => Effect.die("unused"),
      getSnapshotSequence: () => Effect.die("unused"),
      getCounts: () => Effect.die("unused"),
      getActiveProjectByWorkspaceRoot: () => Effect.die("unused"),
      getProjectShellById: () => Effect.die("unused"),
      getFirstActiveThreadIdByProjectId: () => Effect.die("unused"),
      getThreadCheckpointContext: () => Effect.die("unused"),
      getFullThreadDiffContext: () => Effect.die("unused"),
      listSubagentTurnContributions: () => Effect.succeed([]),
      getThreadShellById: (threadId) =>
        Effect.succeed(
          Option.some(isChild(threadId) ? runningChildShell(threadId, turnState) : parentShell),
        ),
      getThreadSessionById: () => Effect.die("unused"),
      getThreadSubagentLiveness: () => Effect.die("unused"),
      getSubagentActivities: () => Effect.die("unused"),
      listChildThreadIds: () => Effect.succeed([]),
      listThreadIdsWithQueuedMessages: () => Effect.succeed([]),
      getThreadDetailById: (threadId) =>
        Effect.succeed(
          isChild(threadId) ? Option.some(runningChildThread(threadId, turnState)) : Option.none(),
        ),
      getThreadDetailSnapshot: (threadId) =>
        Effect.succeed(
          isChild(threadId)
            ? Option.some({ snapshotSequence: 1, thread: runningChildThread(threadId, turnState) })
            : Option.none(),
        ),
    };

    yield* watchSpawnCancellations.pipe(
      Effect.provideService(OrchestrationEngineService, engine),
      Effect.provideService(ProjectionSnapshotQuery, projection),
    );

    const fiber = yield* spawnAgent(options.policy ?? enabledPolicy, spawnInput).pipe(
      Effect.provideService(OrchestrationEngineService, engine),
      Effect.provideService(ProjectionSnapshotQuery, projection),
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
      Effect.result,
      Effect.forkChild({ startImmediately: true }),
    );

    // The rules all fire against a registered spawn, so nothing may be pushed
    // before the handler has registered one. Each nudge is far shorter than the
    // 2 s settle poll, so the child cannot settle underneath it.
    for (let attempt = 0; attempt < 100 && liveChildCount(PARENT_THREAD_ID) === 0; attempt += 1) {
      yield* TestClock.adjust(Duration.millis(5));
    }
    assert.strictEqual(liveChildCount(PARENT_THREAD_ID), 1, "the spawn never registered");
    const childThreadId = listSpawnsOfParent(PARENT_THREAD_ID)[0]?.childThreadId;
    assert.exists(childThreadId);

    return {
      fiber,
      events,
      childThreadId: childThreadId as ThreadId,
      dispatchedCommands: Ref.get(dispatched),
    };
  });

/** Every log line the body emitted, flattened to the values a logger receives. */
const withCapturedLogs = <A, E, R>(
  body: (messages: Array<unknown>) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> => {
  const messages: Array<unknown> = [];
  const logger = Logger.make<unknown, void>((options) => {
    if (Array.isArray(options.message)) {
      messages.push(...options.message);
    } else {
      messages.push(options.message);
    }
  });
  return body(messages).pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));
};

const loggedKey = (messages: ReadonlyArray<unknown>, key: string): boolean =>
  messages.some((message) => message === key);

const commandTypes = (commands: ReadonlyArray<OrchestrationCommand>): ReadonlyArray<string> =>
  commands.map((command) => command.type);

/** The body of every test: one shared clock, one scope for the watch fiber. */
const scenario = <A, E, R>(body: Effect.Effect<A, E, R>) =>
  Effect.sync(clearAllSpawns).pipe(
    Effect.andThen(body),
    Effect.scoped,
    Effect.provide(Layer.merge(TestClock.layer(), NodeServices.layer)),
  );

describe("SpawnRegistry", () => {
  it("counts and walks registrations without any Effect runtime", () => {
    clearAllSpawns();
    const child = ThreadId.make("subagent-thread-parent-1");
    const grandchild = ThreadId.make("subagent-subagent-thread-parent-1-2");
    const registration = (
      parentThreadId: ThreadId,
      childThreadId: ThreadId,
    ): SpawnRegistration => ({
      parentThreadId,
      childThreadId,
      startedAtMs: 0,
      target: {
        parentThreadId,
        parentTurnId: null,
        childThreadId,
        agentType: "Explore",
        description: "Audit",
        prompt: "Find things.",
      },
      cancel: Effect.void,
      complete: () => Effect.void,
    });

    assert.strictEqual(liveChildCount(PARENT_THREAD_ID), 0);
    assert.strictEqual(spawnParentDepth(PARENT_THREAD_ID), 0);

    registerSpawn(registration(PARENT_THREAD_ID, child));
    registerSpawn(registration(child, grandchild));

    assert.strictEqual(liveChildCount(PARENT_THREAD_ID), 1);
    assert.strictEqual(spawnParentDepth(child), 1);
    assert.strictEqual(spawnParentDepth(grandchild), 2);
    assert.strictEqual(findSpawnByChild(child)?.parentThreadId, PARENT_THREAD_ID);

    deregisterSpawn(PARENT_THREAD_ID, child);
    assert.strictEqual(liveChildCount(PARENT_THREAD_ID), 0);
    assert.strictEqual(spawnParentDepth(child), 0);
    assert.strictEqual(findSpawnByChild(child), undefined);

    clearAllSpawns();
    assert.strictEqual(liveChildCount(child), 0);
  });

  it.effect("stops every child when the parent's turn is interrupted", () =>
    scenario(
      Effect.gen(function* () {
        const spawn = yield* startSpawn();

        yield* Queue.offer(
          spawn.events,
          cancellationEvent("thread.turn-interrupt-requested", PARENT_THREAD_ID),
        );

        const result = yield* Fiber.join(spawn.fiber);
        assert.strictEqual(result._tag, "Success");
        if (result._tag !== "Success" || !result.success.spawned) return;
        assert.strictEqual(result.success.status, "interrupted");

        const dispatched = yield* spawn.dispatchedCommands;
        const cleanup = dispatched.filter(
          (command) =>
            command.type === "thread.turn.interrupt" || command.type === "thread.session.stop",
        );
        assert.deepStrictEqual(commandTypes(cleanup), [
          "thread.turn.interrupt",
          "thread.session.stop",
        ]);
        for (const command of cleanup) {
          assert.strictEqual(command.threadId, spawn.childThreadId);
        }
        // Forced, so the running-subagent guard cannot refuse the stop.
        const stop = cleanup[1];
        assert.strictEqual(stop?.type, "thread.session.stop");
        if (stop?.type !== "thread.session.stop") return;
        assert.strictEqual(stop.preserveRunningSubagents, undefined);

        const completed = dispatched.find(
          (command) =>
            command.type === "thread.activity.append" && command.activity.kind === "task.completed",
        );
        assert.strictEqual(completed?.type, "thread.activity.append");
        if (completed?.type !== "thread.activity.append") return;
        assert.strictEqual(completed.threadId, PARENT_THREAD_ID);
        assert.deepStrictEqual(completed.activity.payload, {
          taskId: spawn.childThreadId,
          status: "stopped",
          subagentType: "Explore",
          title: "Audit the settings migrations",
        });

        assert.strictEqual(liveChildCount(PARENT_THREAD_ID), 0);
      }),
    ),
  );

  it.effect("stops every child when the parent's session is stopped", () =>
    scenario(
      Effect.gen(function* () {
        const spawn = yield* startSpawn();

        yield* Queue.offer(
          spawn.events,
          cancellationEvent("thread.session-stop-requested", PARENT_THREAD_ID),
        );

        const result = yield* Fiber.join(spawn.fiber);
        assert.strictEqual(result._tag, "Success");
        if (result._tag !== "Success" || !result.success.spawned) return;
        assert.strictEqual(result.success.status, "interrupted");
        assert.strictEqual(liveChildCount(PARENT_THREAD_ID), 0);
      }),
    ),
  );

  it.effect("ends the parent's wait when the child is stopped from the drawer", () =>
    scenario(
      Effect.gen(function* () {
        const spawn = yield* startSpawn();

        yield* Queue.offer(
          spawn.events,
          cancellationEvent("thread.session-stop-requested", spawn.childThreadId),
        );

        const result = yield* Fiber.join(spawn.fiber);
        assert.strictEqual(result._tag, "Success");
        if (result._tag !== "Success" || !result.success.spawned) return;
        // The wait ends on the stop, not on the 30-minute bound, and carries
        // whatever the child had said by then.
        assert.strictEqual(result.success.status, "interrupted");
        assert.strictEqual(result.success.finalMessage, CHILD_TEXT);
        assert.match(result.success.note, /was stopped from its own thread/);

        // The drawer already stopped the child. Stopping it again would be the
        // parent killing a session that is already gone.
        const dispatched = yield* spawn.dispatchedCommands;
        assert.deepStrictEqual(
          commandTypes(dispatched).filter(
            (type) => type === "thread.turn.interrupt" || type === "thread.session.stop",
          ),
          [],
        );
        assert.strictEqual(liveChildCount(PARENT_THREAD_ID), 0);
      }),
    ),
  );

  it.effect("detaches instead of killing the child when the spawn call is aborted", () =>
    scenario(
      withCapturedLogs((messages) =>
        Effect.gen(function* () {
          const spawn = yield* startSpawn();

          yield* Fiber.interrupt(spawn.fiber);

          const dispatched = yield* spawn.dispatchedCommands;
          assert.deepStrictEqual(
            commandTypes(dispatched).filter(
              (type) => type === "thread.turn.interrupt" || type === "thread.session.stop",
            ),
            [],
          );
          assert.strictEqual(liveChildCount(PARENT_THREAD_ID), 0);
          assert.isTrue(loggedKey(messages, "subagent.spawn.detached"));
        }),
      ),
    ),
  );

  it.effect("drops the registration when the child settles on its own", () =>
    scenario(
      Effect.gen(function* () {
        const spawn = yield* startSpawn({ childTurnState: "completed" });

        yield* TestClock.adjust(Duration.seconds(30));

        const result = yield* Fiber.join(spawn.fiber);
        assert.strictEqual(result._tag, "Success");
        if (result._tag !== "Success" || !result.success.spawned) return;
        assert.strictEqual(result.success.status, "completed");
        assert.strictEqual(result.success.finalMessage, CHILD_TEXT);
        assert.strictEqual(liveChildCount(PARENT_THREAD_ID), 0);
      }),
    ),
  );

  it.effect("drops the registration when the wait times out", () =>
    scenario(
      Effect.gen(function* () {
        const spawn = yield* startSpawn({
          policy: { ...enabledPolicy, spawnWaitTimeoutMs: 5000 },
        });

        yield* TestClock.adjust(Duration.seconds(10));

        const result = yield* Fiber.join(spawn.fiber);
        assert.strictEqual(result._tag, "Success");
        if (result._tag !== "Success" || !result.success.spawned) return;
        assert.strictEqual(result.success.status, "timeout");
        // The child is still running, and the parent has stopped waiting for
        // it, so it must not go on spending the parent's concurrency budget.
        assert.strictEqual(liveChildCount(PARENT_THREAD_ID), 0);
      }),
    ),
  );

  it.effect("logs a failed cleanup dispatch instead of failing the tool call", () =>
    scenario(
      withCapturedLogs((messages) =>
        Effect.gen(function* () {
          const spawn = yield* startSpawn({
            dyingCommandTypes: new Set(["thread.turn.interrupt", "thread.session.stop"]),
          });

          yield* Queue.offer(
            spawn.events,
            cancellationEvent("thread.turn-interrupt-requested", PARENT_THREAD_ID),
          );

          const result = yield* Fiber.join(spawn.fiber);
          assert.strictEqual(result._tag, "Success");
          if (result._tag !== "Success" || !result.success.spawned) return;
          assert.strictEqual(result.success.status, "interrupted");
          assert.isTrue(loggedKey(messages, "subagent.spawn.cleanup-failed"));
          assert.strictEqual(liveChildCount(PARENT_THREAD_ID), 0);
        }),
      ),
    ),
  );
});
