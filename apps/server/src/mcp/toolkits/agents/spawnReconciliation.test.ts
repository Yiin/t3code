import { assert, describe, it } from "@effect/vitest";
import {
  applySubagentActivity,
  countFreshRunningSubagents,
  type OrchestrationCommand,
  type OrchestrationThreadActivity,
  type OrchestrationThreadShell,
  type OrchestrationThreadSubagent,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionRunningThreadBackedSubagent,
} from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../../../provider/Services/ProviderService.ts";
import { clearAllSpawns, deregisterSpawn, registerSpawn } from "./SpawnRegistry.ts";
import {
  ORPHANED_SPAWN_DETACHED_SUMMARY,
  ORPHANED_SPAWN_STOPPED_SUMMARY,
  reconcileOrphanedSpawns,
} from "./spawnReconciliation.ts";

const PARENT_THREAD_ID = ThreadId.make("thread-parent");
const CHILD_THREAD_ID = ThreadId.make("subagent-thread-parent-abc");
const PARENT_TURN_ID = TurnId.make("turn-parent");

const orphanRow = (
  overrides: Partial<ProjectionRunningThreadBackedSubagent> = {},
): ProjectionRunningThreadBackedSubagent => ({
  parentThreadId: PARENT_THREAD_ID,
  subagentId: CHILD_THREAD_ID,
  childThreadId: CHILD_THREAD_ID,
  turnId: PARENT_TURN_ID,
  agentType: "Explore",
  description: "Audit the settings migrations",
  ...overrides,
});

const childShell = (childThreadId: ThreadId): OrchestrationThreadShell => ({
  id: childThreadId,
  projectId: ProjectId.make("project-1"),
  title: "Subagent",
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
  parentThreadId: PARENT_THREAD_ID,
});

interface HarnessOptions {
  readonly orphans?: ReadonlyArray<ProjectionRunningThreadBackedSubagent>;
  /** Child threads the projection still knows about. */
  readonly existingChildIds?: ReadonlySet<ThreadId>;
  /** Child threads whose provider session is live in this process. */
  readonly liveChildIds?: ReadonlySet<ThreadId>;
  /** Make the liveness read fail, to prove an unjudgeable orphan still closes. */
  readonly livenessFails?: boolean;
  /** Make the orphan read fail, to prove the sweep never escapes. */
  readonly listFails?: boolean;
}

/** Run one sweep and hand back every command it dispatched, in order. */
const runSweep = (options: HarnessOptions = {}) =>
  Effect.gen(function* () {
    const dispatched = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
    const existing = options.existingChildIds ?? new Set([CHILD_THREAD_ID]);
    const live = options.liveChildIds ?? new Set<ThreadId>();

    const providerService = {
      startSession: () => Effect.die("unused"),
      sendTurn: () => Effect.die("unused"),
      interruptTurn: () => Effect.die("unused"),
      respondToRequest: () => Effect.die("unused"),
      respondToUserInput: () => Effect.die("unused"),
      stopSession: () => Effect.die("unused"),
      listSessions: () => Effect.succeed([]),
      hasLiveSession: (threadId: ThreadId) =>
        options.livenessFails === true
          ? Effect.die("provider offline")
          : Effect.succeed(live.has(threadId)),
      getCapabilities: () => Effect.die("unused"),
      getInstanceInfo: () => Effect.die("unused"),
      rollbackConversation: () => Effect.die("unused"),
      getContextUsage: () => Effect.die("unused"),
      setSessionModel: () => Effect.die("unused"),
      setPermissionMode: () => Effect.die("unused"),
    } as unknown as ProviderServiceShape;

    yield* reconcileOrphanedSpawns.pipe(
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
        listSubagentTurnContributions: () => Effect.succeed([]),
        getThreadShellById: (threadId) =>
          Effect.succeed(
            existing.has(threadId) ? Option.some(childShell(threadId)) : Option.none(),
          ),
        getThreadSessionById: () => Effect.die("unused"),
        getThreadSubagentLiveness: () => Effect.die("unused"),
        getSubagentActivities: () => Effect.die("unused"),
        listChildThreadIds: () => Effect.succeed([]),
        listRunningThreadBackedSubagents: () =>
          options.listFails === true
            ? Effect.die("projection offline")
            : Effect.succeed(options.orphans ?? [orphanRow()]),
        listThreadIdsWithQueuedMessages: () => Effect.succeed([]),
        getThreadDetailById: () => Effect.die("unused"),
        getThreadDetailSnapshot: () => Effect.die("unused"),
      }),
      Effect.provideService(ProviderService, providerService),
    );

    return yield* Ref.get(dispatched);
  });

const appended = (
  commands: ReadonlyArray<OrchestrationCommand>,
): ReadonlyArray<OrchestrationThreadActivity> =>
  commands.flatMap((command) =>
    command.type === "thread.activity.append" ? [command.activity] : [],
  );

/** The parent's subagent read model, folded exactly as every projection folds it. */
const foldSubagents = (
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  seed: ReadonlyArray<OrchestrationThreadSubagent>,
): ReadonlyArray<OrchestrationThreadSubagent> =>
  activities.reduce<ReadonlyArray<OrchestrationThreadSubagent>>(applySubagentActivity, seed);

/** The stranded row as the projection already holds it: running, thread-backed. */
const strandedSubagent = (): OrchestrationThreadSubagent => ({
  subagentId: CHILD_THREAD_ID,
  turnId: PARENT_TURN_ID,
  agentType: "Explore",
  description: "Audit the settings migrations",
  status: "running",
  childThreadId: CHILD_THREAD_ID,
  startedAt: "2026-08-11T00:00:00.000Z",
  updatedAt: "2026-08-11T00:00:00.000Z",
  completedAt: null,
});

describe("orphaned thread-backed spawn reconciliation", () => {
  it.effect("annotates a live child's row without touching the child", () =>
    Effect.gen(function* () {
      const commands = yield* runSweep({ liveChildIds: new Set([CHILD_THREAD_ID]) });

      assert.deepStrictEqual(
        commands.map((command) => command.type),
        ["thread.activity.append"],
      );
      const activities = appended(commands);
      assert.strictEqual(activities[0]?.kind, "task.progress");
      assert.strictEqual(activities[0]?.summary, ORPHANED_SPAWN_DETACHED_SUMMARY);

      // The row stays running on purpose: the child is still working and the
      // human can still open the drawer and talk to it.
      const folded = foldSubagents(activities, [strandedSubagent()]);
      assert.strictEqual(folded.length, 1);
      assert.strictEqual(folded[0]?.status, "running");
      assert.strictEqual(folded[0]?.lastProgressSummary, ORPHANED_SPAWN_DETACHED_SUMMARY);
    }),
  );

  it.effect("closes a dead child's row so the active count drops to zero", () =>
    Effect.gen(function* () {
      const commands = yield* runSweep();

      assert.deepStrictEqual(
        commands.map((command) => command.type),
        ["thread.activity.append"],
      );
      const activities = appended(commands);
      assert.strictEqual(activities[0]?.kind, "task.completed");
      assert.deepStrictEqual(activities[0]?.payload, {
        taskId: CHILD_THREAD_ID,
        status: "stopped",
        subagentType: "Explore",
        title: "Audit the settings migrations",
        summary: ORPHANED_SPAWN_STOPPED_SUMMARY,
        detail: ORPHANED_SPAWN_STOPPED_SUMMARY,
      });

      const folded = foldSubagents(activities, [strandedSubagent()]);
      assert.strictEqual(folded[0]?.status, "stopped");
      assert.strictEqual(
        countFreshRunningSubagents(folded, Date.parse(activities[0]?.createdAt ?? "")),
        0,
      );
    }),
  );

  it.effect("closes a row whose child thread is gone", () =>
    Effect.gen(function* () {
      const commands = yield* runSweep({
        existingChildIds: new Set<ThreadId>(),
        // A live session for a thread the projection lost still loses: the
        // thread is what the drawer opens.
        liveChildIds: new Set([CHILD_THREAD_ID]),
      });

      assert.strictEqual(appended(commands)[0]?.kind, "task.completed");
    }),
  );

  it.effect("closes a row it cannot judge", () =>
    Effect.gen(function* () {
      const commands = yield* runSweep({ livenessFails: true });

      assert.strictEqual(appended(commands)[0]?.kind, "task.completed");
    }),
  );

  it.effect("dispatches nothing when no orphan rows exist", () =>
    Effect.gen(function* () {
      const commands = yield* runSweep({ orphans: [] });

      assert.deepStrictEqual(commands, []);
    }),
  );

  it.effect("survives a projection that cannot be read", () =>
    Effect.gen(function* () {
      const commands = yield* runSweep({ listFails: true });

      assert.deepStrictEqual(commands, []);
    }),
  );

  it.effect("leaves a row this process is still waiting on alone", () =>
    Effect.gen(function* () {
      clearAllSpawns();
      registerSpawn({
        parentThreadId: PARENT_THREAD_ID,
        childThreadId: CHILD_THREAD_ID,
        startedAtMs: 0,
        target: {
          parentThreadId: PARENT_THREAD_ID,
          parentTurnId: PARENT_TURN_ID,
          childThreadId: CHILD_THREAD_ID,
          agentType: "Explore",
          description: "Audit the settings migrations",
          prompt: "Find every migration that writes to settings.",
        },
        cancel: Effect.void,
        complete: () => Effect.void,
      });

      const commands = yield* runSweep();
      deregisterSpawn(PARENT_THREAD_ID, CHILD_THREAD_ID);

      assert.deepStrictEqual(commands, []);
    }),
  );
});
