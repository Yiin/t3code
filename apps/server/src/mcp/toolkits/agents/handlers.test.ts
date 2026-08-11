import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  MessageId,
  type OrchestrationCommand,
  type OrchestrationSessionStatus,
  type OrchestrationThread,
  type OrchestrationThreadShell,
  type OrchestrationLatestTurnState,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { spawnAgent } from "./handlers.ts";
import {
  DEFAULT_SPAWN_POLICY,
  SUBAGENT_CHILD_THREAD_ID_PREFIX,
  type SpawnPolicy,
} from "./spawnPolicy.ts";

const PARENT_THREAD_ID = ThreadId.make("thread-parent");

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

const invocation: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: PARENT_THREAD_ID,
  providerSessionId: "provider-session-1",
  providerInstanceId: ProviderInstanceId.make("claude"),
  capabilities: new Set(["preview", "spawn-agent"]),
  issuedAt: 1,
  expiresAt: 2,
};

const enabledPolicy: SpawnPolicy = { ...DEFAULT_SPAWN_POLICY, enabled: true };

/** How the spawned child behaves while the parent's tool call waits on it. */
interface ChildFixture {
  readonly turnState?: OrchestrationLatestTurnState;
  readonly sessionStatus?: OrchestrationSessionStatus;
  readonly lastError?: string;
  /** The child's assistant text, or `null` for a turn that produced none. */
  readonly assistantText?: string | null;
}

const DEFAULT_CHILD: ChildFixture = {
  turnState: "completed",
  assistantText: "Three migrations write settings.",
};

const CHILD_MESSAGE_ID = MessageId.make("child-assistant-1");
const CHILD_TURN_ID = TurnId.make("turn-child");

/** The shell the settle watch polls: whatever the fixture says the child is. */
const childShell = (childThreadId: ThreadId, child: ChildFixture): OrchestrationThreadShell =>
  shell({
    id: childThreadId,
    parentThreadId: PARENT_THREAD_ID,
    latestTurn:
      child.turnState === undefined
        ? null
        : {
            turnId: CHILD_TURN_ID,
            state: child.turnState,
            requestedAt: "2026-08-11T00:00:00.000Z",
            startedAt: "2026-08-11T00:00:00.000Z",
            completedAt: child.turnState === "running" ? null : "2026-08-11T00:00:05.000Z",
            assistantMessageId: child.assistantText === null ? null : CHILD_MESSAGE_ID,
          },
    session:
      child.sessionStatus === undefined
        ? null
        : {
            threadId: childThreadId,
            status: child.sessionStatus,
            providerName: "claude",
            providerInstanceId: ProviderInstanceId.make("claude"),
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: child.lastError ?? null,
            updatedAt: "2026-08-11T00:00:05.000Z",
          },
  });

const childThread = (childThreadId: ThreadId, child: ChildFixture): OrchestrationThread => {
  const asShell = childShell(childThreadId, child);
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
    messages:
      child.assistantText === null || child.assistantText === undefined
        ? []
        : [
            {
              id: CHILD_MESSAGE_ID,
              role: "assistant",
              text: child.assistantText,
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
    session: asShell.session,
  };
};

const HUMAN_TURN_ID = TurnId.make("turn-human");
const HUMAN_MESSAGE_ID = MessageId.make("child-assistant-2");

/**
 * The child as it looks once a human has spoken to it from the drawer.
 *
 * A second turn is running, and its reply is still streaming — so it grows on
 * every read and never holds still. That is what made the unpinned read burn its
 * whole bound and then hand this text back as the spawner's answer.
 */
const withHumanTurn = (thread: OrchestrationThread, read: number): OrchestrationThread => ({
  ...thread,
  latestTurn: {
    turnId: HUMAN_TURN_ID,
    state: "running",
    requestedAt: "2026-08-11T00:00:06.000Z",
    startedAt: "2026-08-11T00:00:06.000Z",
    completedAt: null,
    assistantMessageId: HUMAN_MESSAGE_ID,
  },
  messages: [
    ...thread.messages,
    {
      id: HUMAN_MESSAGE_ID,
      role: "assistant",
      text: `Answering you now${".".repeat(read)}`,
      turnId: HUMAN_TURN_ID,
      streaming: true,
      createdAt: "2026-08-11T00:00:07.000Z",
      updatedAt: "2026-08-11T00:00:07.000Z",
    },
  ],
});

interface Fixture {
  readonly shells?: ReadonlyMap<string, OrchestrationThreadShell>;
  readonly childThreadIds?: ReadonlyArray<ThreadId>;
  readonly capabilities?: ReadonlySet<McpInvocationContext.McpCapability>;
  readonly child?: ChildFixture;
  /**
   * Whether a human message lands on the child after its first turn ended, in
   * the window between the settle wait and the final read.
   */
  readonly humanMessageAfterSettle?: boolean;
  /** How far the test clock is advanced while the tool call waits. */
  readonly advance?: Duration.Duration;
}

const run = (
  policy: SpawnPolicy,
  input: {
    readonly agent_type: string;
    readonly description: string;
    readonly prompt: string;
    readonly model?: string;
  },
  fixture: Fixture = {},
) =>
  Effect.gen(function* () {
    const dispatched = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
    const shells = fixture.shells ?? new Map([[PARENT_THREAD_ID, shell()]]);
    const child = fixture.child ?? DEFAULT_CHILD;
    // The child thread id is minted inside the handler, so the fixture answers
    // for any id it has not been told about explicitly.
    const isSpawnedChild = (threadId: ThreadId) =>
      !shells.has(threadId) && threadId.startsWith(SUBAGENT_CHILD_THREAD_ID_PREFIX);
    const spawnedChildShell = (threadId: ThreadId) =>
      isSpawnedChild(threadId) ? childShell(threadId, child) : undefined;
    // The human speaks once the settle wait is over, which is exactly one
    // detail read in. Every read after that carries the second turn.
    let detailReads = 0;
    const spawnedChild = (threadId: ThreadId) => {
      if (!isSpawnedChild(threadId)) return undefined;
      const thread = childThread(threadId, child);
      detailReads += 1;
      return fixture.humanMessageAfterSettle === true && detailReads > 1
        ? withHumanTurn(thread, detailReads)
        : thread;
    };

    const fiber = yield* spawnAgent(policy, input).pipe(
      Effect.provideService(OrchestrationEngineService, {
        readEvents: () => Stream.empty,
        dispatch: (command) =>
          Ref.update(dispatched, (commands) => [...commands, command]).pipe(
            Effect.as({ sequence: 1 }),
          ),
        streamDomainEvents: Stream.empty,
        latestSequence: Effect.succeed(0),
      }),
      Effect.provideService(ProjectionSnapshotQuery, {
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
        getThreadShellById: (threadId) => {
          const found = shells.get(threadId) ?? spawnedChildShell(threadId);
          return Effect.succeed(found === undefined ? Option.none() : Option.some(found));
        },
        getThreadSessionById: () => Effect.die("unused"),
        getThreadSubagentLiveness: () => Effect.die("unused"),
        getSubagentActivities: () => Effect.die("unused"),
        listChildThreadIds: () => Effect.succeed(fixture.childThreadIds ?? []),
        listThreadIdsWithQueuedMessages: () => Effect.succeed([]),
        getThreadDetailById: (threadId) => {
          const found = spawnedChild(threadId);
          return Effect.succeed(found === undefined ? Option.none() : Option.some(found));
        },
        getThreadDetailSnapshot: (threadId) => {
          const found = spawnedChild(threadId);
          return Effect.succeed(
            found === undefined
              ? Option.none()
              : Option.some({ snapshotSequence: 1, thread: found }),
          );
        },
      }),
      Effect.provideService(McpInvocationContext.McpInvocationContext, {
        ...invocation,
        ...(fixture.capabilities ? { capabilities: fixture.capabilities } : {}),
      }),
      Effect.result,
      Effect.forkChild({ startImmediately: true }),
    );
    // One shared test clock, so the mirror fiber the handler forks moves with
    // this adjustment instead of parking on a clock of its own.
    yield* TestClock.adjust(fixture.advance ?? Duration.seconds(10));
    const result = yield* Fiber.join(fiber);

    return { result, dispatched: yield* Ref.get(dispatched) };
  }).pipe(Effect.provide(Layer.merge(TestClock.layer(), NodeServices.layer)));

const spawnInput = {
  agent_type: "Explore",
  description: "Audit the settings migrations",
  prompt: "Find every migration that writes to settings.",
};

describe("spawn_agent handler", () => {
  it.effect("creates the child thread in the parent's worktree and starts its turn", () =>
    Effect.gen(function* () {
      const { result, dispatched } = yield* run(enabledPolicy, spawnInput);

      assert.strictEqual(result._tag, "Success");
      if (result._tag !== "Success") return;
      assert.strictEqual(result.success.spawned, true);
      if (!result.success.spawned) return;
      assert.match(result.success.childThreadId, /^subagent-thread-parent-/);
      assert.strictEqual(result.success.agentType, "Explore");
      assert.strictEqual(result.success.description, "Audit the settings migrations");

      // The trailing appends mirror the child onto the parent's subagent read
      // model, opening the row and closing it; `childMirror.test.ts` owns their
      // contents.
      assert.deepStrictEqual(
        dispatched.map((command) => command.type),
        [
          "thread.create",
          "thread.turn.start",
          "thread.activity.append",
          "thread.activity.append",
          "thread.activity.append",
        ],
      );
      const started = dispatched[2];
      assert.strictEqual(started?.type, "thread.activity.append");
      if (started?.type !== "thread.activity.append") return;
      assert.strictEqual(started.threadId, PARENT_THREAD_ID);
      assert.strictEqual(started.activity.kind, "task.started");
      assert.deepStrictEqual(started.activity.payload, {
        taskId: result.success.childThreadId,
        subagentType: "Explore",
        detail: "Audit the settings migrations",
        prompt: spawnInput.prompt,
      });

      const create = dispatched[0];
      assert.strictEqual(create?.type, "thread.create");
      if (create?.type !== "thread.create") return;
      assert.strictEqual(create.threadId, result.success.childThreadId);
      assert.strictEqual(create.parentThreadId, PARENT_THREAD_ID);
      assert.strictEqual(create.projectId, "project-1");
      assert.strictEqual(create.title, "Audit the settings migrations");
      assert.strictEqual(create.branch, "mine");
      assert.strictEqual(create.worktreePath, "/tmp/parent-worktree");
      assert.strictEqual(create.runtimeMode, "full-access");
      assert.deepStrictEqual(create.modelSelection, {
        instanceId: ProviderInstanceId.make("claude"),
        model: "claude-opus-5",
      });

      const turn = dispatched[1];
      assert.strictEqual(turn?.type, "thread.turn.start");
      if (turn?.type !== "thread.turn.start") return;
      assert.strictEqual(turn.threadId, result.success.childThreadId);
      assert.strictEqual(turn.message.messageId, `${result.success.childThreadId}-prompt`);
      assert.strictEqual(turn.message.text, spawnInput.prompt);
    }),
  );

  it.effect("overrides the model but never the parent's provider instance", () =>
    Effect.gen(function* () {
      const { dispatched } = yield* run(enabledPolicy, {
        ...spawnInput,
        model: "  claude-sonnet-5  ",
      });

      const create = dispatched[0];
      assert.strictEqual(create?.type, "thread.create");
      if (create?.type !== "thread.create") return;
      assert.deepStrictEqual(create.modelSelection, {
        instanceId: ProviderInstanceId.make("claude"),
        model: "claude-sonnet-5",
      });
    }),
  );

  it.effect("refuses without dispatching when the policy is disabled", () =>
    Effect.gen(function* () {
      const { result, dispatched } = yield* run(DEFAULT_SPAWN_POLICY, spawnInput);

      assert.strictEqual(result._tag, "Success");
      if (result._tag !== "Success") return;
      assert.strictEqual(result.success.spawned, false);
      if (result.success.spawned) return;
      assert.strictEqual(result.success.reason, "disabled");
      assert.deepStrictEqual(dispatched, []);
    }),
  );

  it.effect("refuses a grandchild because the parent is itself thread-backed", () =>
    Effect.gen(function* () {
      const grandparentId = ThreadId.make("thread-grandparent");
      const { result } = yield* run(enabledPolicy, spawnInput, {
        shells: new Map([
          [PARENT_THREAD_ID, shell({ parentThreadId: grandparentId })],
          [grandparentId, shell({ id: grandparentId })],
        ]),
      });

      assert.strictEqual(result._tag, "Success");
      if (result._tag !== "Success" || result.success.spawned) return;
      assert.strictEqual(result.success.reason, "depth-cap");
    }),
  );

  it.effect("counts only unsettled children against the concurrency cap", () =>
    Effect.gen(function* () {
      const live = ["child-a", "child-b", "child-c"].map((id) => ThreadId.make(id));
      const done = ThreadId.make("child-done");
      const childShells = new Map<string, OrchestrationThreadShell>([
        [PARENT_THREAD_ID, shell()],
        [
          done,
          shell({
            id: done,
            latestTurn: {
              turnId: TurnId.make("turn-done"),
              state: "completed",
              requestedAt: "2026-08-11T00:00:00.000Z",
              startedAt: "2026-08-11T00:00:00.000Z",
              completedAt: "2026-08-11T00:00:01.000Z",
              assistantMessageId: null,
            },
          }),
        ],
      ]);
      for (const childId of live) {
        childShells.set(
          childId,
          shell({
            id: childId,
            latestTurn: {
              turnId: TurnId.make(`turn-${childId}`),
              state: "running",
              requestedAt: "2026-08-11T00:00:00.000Z",
              startedAt: "2026-08-11T00:00:00.000Z",
              completedAt: null,
              assistantMessageId: null,
            },
          }),
        );
      }

      const settledOnly = yield* run(enabledPolicy, spawnInput, {
        shells: childShells,
        childThreadIds: [done],
      });
      assert.strictEqual(
        settledOnly.result._tag === "Success" ? settledOnly.result.success.spawned : null,
        true,
      );

      const atCap = yield* run(enabledPolicy, spawnInput, {
        shells: childShells,
        childThreadIds: [done, ...live],
      });
      assert.strictEqual(atCap.result._tag, "Success");
      if (atCap.result._tag !== "Success" || atCap.result.success.spawned) return;
      assert.strictEqual(atCap.result.success.reason, "concurrency-cap");
      assert.deepStrictEqual(atCap.dispatched, []);
    }),
  );

  it.effect("fails cleanly when the credential predates the spawn-agent capability", () =>
    Effect.gen(function* () {
      const { result, dispatched } = yield* run(enabledPolicy, spawnInput, {
        capabilities: new Set(["preview"]),
      });

      assert.strictEqual(result._tag, "Failure");
      if (result._tag !== "Failure") return;
      assert.strictEqual(result.failure.reason, "capability-unavailable");
      assert.deepStrictEqual(dispatched, []);
    }),
  );

  it.effect("fails when the calling thread is no longer active", () =>
    Effect.gen(function* () {
      const { result, dispatched } = yield* run(enabledPolicy, spawnInput, {
        shells: new Map(),
      });

      assert.strictEqual(result._tag, "Failure");
      if (result._tag !== "Failure") return;
      assert.strictEqual(result.failure.reason, "parent-thread-missing");
      assert.deepStrictEqual(dispatched, []);
    }),
  );

  it.effect("returns the child's final message once its first turn settles", () =>
    Effect.gen(function* () {
      const { result, dispatched } = yield* run(enabledPolicy, spawnInput);

      assert.strictEqual(result._tag, "Success");
      if (result._tag !== "Success" || !result.success.spawned) return;
      assert.strictEqual(result.success.status, "completed");
      assert.strictEqual(result.success.finalMessage, "Three migrations write settings.");
      // The settle costs one quiet period on the test clock, and nothing here
      // may report a wait it did not make.
      assert.ok(result.success.elapsedMs >= 1000, "elapsed covers the quiet period");

      const completed = dispatched.flatMap((command) =>
        command.type === "thread.activity.append" && command.activity.kind === "task.completed"
          ? [command.activity]
          : [],
      );
      assert.strictEqual(completed.length, 1);
    }),
  );

  it.effect("returns the settled turn's answer, not a reply meant for the human", () =>
    Effect.gen(function* () {
      const { result } = yield* run(enabledPolicy, spawnInput, {
        humanMessageAfterSettle: true,
        // Long enough for an unpinned read to burn `MAX_SETTLE_READS` and
        // return, so this fails on the wrong text rather than on a hang.
        advance: Duration.seconds(60),
      });

      assert.strictEqual(result._tag, "Success");
      if (result._tag !== "Success" || !result.success.spawned) return;
      assert.strictEqual(result.success.finalMessage, "Three migrations write settings.");
      assert.strictEqual(result.success.status, "completed");
      // The second turn is still running, so an unpinned read would have waited
      // out `MAX_SETTLE_READS` before returning it. One quiet period proves the
      // read never followed it.
      assert.ok(
        result.success.elapsedMs < 5000,
        `the pinned read settles at once, took ${String(result.success.elapsedMs)}ms`,
      );
    }),
  );

  it.effect("reports the session's error when the child's turn ended in one", () =>
    Effect.gen(function* () {
      const { result } = yield* run(enabledPolicy, spawnInput, {
        child: {
          turnState: "error",
          sessionStatus: "error",
          lastError: "provider stream closed",
          assistantText: null,
        },
        // A turn with no assistant row is watched out to `MAX_SETTLE_READS`.
        advance: Duration.seconds(30),
      });

      assert.strictEqual(result._tag, "Success");
      if (result._tag !== "Success" || !result.success.spawned) return;
      assert.strictEqual(result.success.status, "failed");
      assert.strictEqual(result.success.finalMessage, "provider stream closed");
    }),
  );

  it.effect("reports an interrupted child without calling it a failure", () =>
    Effect.gen(function* () {
      const { result } = yield* run(enabledPolicy, spawnInput, {
        child: { turnState: "interrupted", assistantText: "Half an answer." },
      });

      assert.strictEqual(result._tag, "Success");
      if (result._tag !== "Success" || !result.success.spawned) return;
      assert.strictEqual(result.success.status, "interrupted");
      assert.strictEqual(result.success.finalMessage, "Half an answer.");
    }),
  );

  it.effect("stops waiting on a child that never settles and leaves it running", () =>
    Effect.gen(function* () {
      const { result, dispatched } = yield* run(enabledPolicy, spawnInput, {
        child: {
          turnState: "running",
          sessionStatus: "running",
          assistantText: "Still reading the migrations.",
        },
        advance: Duration.minutes(31),
      });

      assert.strictEqual(result._tag, "Success");
      if (result._tag !== "Success" || !result.success.spawned) return;
      assert.strictEqual(result.success.status, "timeout");
      // Partial text, so the parent is not left with nothing to carry on from.
      assert.strictEqual(result.success.finalMessage, "Still reading the migrations.");
      assert.ok(
        result.success.note.includes(result.success.childThreadId),
        "the note names the child so a human can open it",
      );

      // No `task.completed`: the mirror claims no outcome the child never
      // reported, so the row ages out of the fresh-running count instead.
      const kinds = dispatched.flatMap((command) =>
        command.type === "thread.activity.append" ? [command.activity.kind] : [],
      );
      assert.ok(!kinds.includes("task.completed"), "a timed-out child settles nothing");
      // The child was never stopped: a human may still be talking to it.
      assert.ok(
        !dispatched.some(
          (command) =>
            command.type === "thread.session.stop" || command.type === "thread.turn.interrupt",
        ),
      );
    }),
  );

  it.effect("falls back to an agent-type title when the description is blank", () =>
    Effect.gen(function* () {
      const { dispatched } = yield* run(enabledPolicy, { ...spawnInput, description: "   " });

      const create = dispatched[0];
      assert.strictEqual(create?.type, "thread.create");
      if (create?.type !== "thread.create") return;
      assert.strictEqual(create.title, "Subagent: Explore");
    }),
  );
});
