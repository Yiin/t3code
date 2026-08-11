import { assert, describe, it } from "@effect/vitest";
import {
  applySubagentActivity,
  countFreshRunningSubagents,
  EventId,
  type OrchestrationCommand,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
  type OrchestrationThreadSubagent,
  ProjectId,
  ProviderInstanceId,
  RUNNING_SUBAGENT_FRESHNESS_MS,
  SUBAGENT_CHILD_THREAD_LINKED_ACTIVITY_KIND,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { OrchestrationListenerCallbackError } from "../../../orchestration/Errors.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  appendChildSpawned,
  CHILD_MIRROR_POLL_INTERVAL,
  type ChildMirrorOutcome,
  type ChildMirrorTarget,
  mirrorChildLifecycle,
} from "./childMirror.ts";

const PARENT_THREAD_ID = ThreadId.make("thread-parent");
const CHILD_THREAD_ID = ThreadId.make("subagent-thread-parent-abc");
const PARENT_TURN_ID = TurnId.make("turn-parent");

const target: ChildMirrorTarget = {
  parentThreadId: PARENT_THREAD_ID,
  parentTurnId: PARENT_TURN_ID,
  childThreadId: CHILD_THREAD_ID,
  agentType: "Explore",
  description: "Audit the settings migrations",
  prompt: "Find every migration that writes to settings.",
};

const childActivity = (
  id: string,
  overrides: Partial<Omit<OrchestrationThreadActivity, "id">> = {},
): OrchestrationThreadActivity => ({
  id: EventId.make(id),
  tone: "info",
  kind: "agent.text",
  summary: "Working",
  payload: {},
  turnId: null,
  createdAt: "2026-08-11T00:00:00.000Z",
  ...overrides,
});

const childThread = (
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): OrchestrationThread => ({
  id: CHILD_THREAD_ID,
  projectId: ProjectId.make("project-1"),
  title: "Audit the settings migrations",
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
  deletedAt: null,
  parentThreadId: PARENT_THREAD_ID,
  messages: [],
  proposedPlans: [],
  subagents: [],
  activities,
  checkpoints: [],
  session: null,
});

interface Harness {
  readonly dispatched: Ref.Ref<ReadonlyArray<OrchestrationCommand>>;
  readonly child: Ref.Ref<Option.Option<OrchestrationThread>>;
}

const makeHarness = Effect.gen(function* () {
  const dispatched = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
  const child = yield* Ref.make<Option.Option<OrchestrationThread>>(Option.none());
  return { dispatched, child } satisfies Harness;
});

/** Every append the mirror made, in dispatch order. */
const appended = (
  commands: ReadonlyArray<OrchestrationCommand>,
): ReadonlyArray<OrchestrationThreadActivity> =>
  commands.flatMap((command) =>
    command.type === "thread.activity.append" ? [command.activity] : [],
  );

/** The parent's subagent read model, folded exactly as every projection folds it. */
const foldSubagents = (
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyArray<OrchestrationThreadSubagent> =>
  activities.reduce<ReadonlyArray<OrchestrationThreadSubagent>>(applySubagentActivity, []);

const provide =
  (harness: Harness, options: { readonly dispatchFails?: boolean } = {}) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(OrchestrationEngineService, {
        readEvents: () => Stream.empty,
        dispatch: (command) =>
          options.dispatchFails === true
            ? Effect.fail(
                new OrchestrationListenerCallbackError({
                  listener: "read-model",
                  detail: "projection offline",
                }),
              )
            : Ref.update(harness.dispatched, (commands) => [...commands, command]).pipe(
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
        getThreadShellById: () => Effect.die("unused"),
        getThreadSessionById: () => Effect.die("unused"),
        getThreadSubagentLiveness: () => Effect.die("unused"),
        getSubagentActivities: () => Effect.die("unused"),
        listChildThreadIds: () => Effect.succeed([]),
        getThreadDetailById: () => Ref.get(harness.child),
        getThreadDetailSnapshot: () => Effect.die("unused"),
      }),
    );

/**
 * One test clock shared by the test fiber and the mirror it forks.
 *
 * Providing it any deeper would give the forked mirror its own clock, and
 * `TestClock.adjust` here would never move the mirror's sleeps.
 */
const withTestClock = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(TestClock.layer()));

/** A wait that lasts `duration` on the test clock, then reports `outcome`. */
const waitFor = (duration: Duration.Duration, outcome: ChildMirrorOutcome) =>
  Effect.sleep(duration).pipe(Effect.as(outcome));

/**
 * Just past `count` poll ticks.
 *
 * The extra millisecond breaks the boundary race: a wait ending on the tick
 * itself closes the scope in the same instant the mirror wakes, and which one
 * wins is scheduler order, not behavior worth asserting.
 */
const ticks = (count: number): Duration.Duration =>
  Duration.millis(Duration.toMillis(CHILD_MIRROR_POLL_INTERVAL) * count + 1);

describe("thread-backed child mirror", () => {
  it.effect("opens exactly one parent row and marks it thread-backed", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* appendChildSpawned(target).pipe(provide(harness));
      const activities = appended(yield* Ref.get(harness.dispatched));

      assert.deepStrictEqual(
        activities.map((activity) => activity.kind),
        ["task.started", SUBAGENT_CHILD_THREAD_LINKED_ACTIVITY_KIND],
      );

      const started = activities[0];
      assert.deepStrictEqual(started?.payload, {
        taskId: CHILD_THREAD_ID,
        subagentType: "Explore",
        detail: "Audit the settings migrations",
        prompt: "Find every migration that writes to settings.",
      });
      assert.strictEqual(started?.turnId, PARENT_TURN_ID);
      assert.deepStrictEqual(activities[1]?.payload, {
        subagentId: CHILD_THREAD_ID,
        childThreadId: CHILD_THREAD_ID,
      });

      const subagents = foldSubagents(activities);
      assert.strictEqual(subagents.length, 1);
      assert.strictEqual(subagents[0]?.subagentId, CHILD_THREAD_ID);
      assert.strictEqual(subagents[0]?.childThreadId, CHILD_THREAD_ID);
      assert.strictEqual(subagents[0]?.agentType, "Explore");
      assert.strictEqual(subagents[0]?.description, "Audit the settings migrations");
      assert.strictEqual(subagents[0]?.status, "running");
    }).pipe(withTestClock),
  );

  it.effect("carries the row from running to completed with the child's final message", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const fiber = yield* mirrorChildLifecycle(
        target,
        waitFor(ticks(1), {
          _tag: "settled",
          status: "completed",
          summary: "Three migrations write settings.",
        }),
      ).pipe(provide(harness), Effect.forkChild({ startImmediately: true }));

      yield* TestClock.adjust(ticks(1));
      const outcome = yield* Fiber.join(fiber);
      assert.strictEqual(outcome._tag, "settled");

      const activities = appended(yield* Ref.get(harness.dispatched));
      const completed = activities.filter((activity) => activity.kind === "task.completed");
      assert.strictEqual(completed.length, 1);

      const subagents = foldSubagents(activities);
      assert.strictEqual(subagents.length, 1);
      assert.strictEqual(subagents[0]?.status, "completed");
      assert.strictEqual(subagents[0]?.lastProgressSummary, "Three migrations write settings.");
      assert.notStrictEqual(subagents[0]?.completedAt, null);
    }).pipe(withTestClock),
  );

  it.effect("coalesces every progress tick onto one row and keeps refreshing it", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* Ref.set(
        harness.child,
        Option.some(
          childThread([
            childActivity("child-tool", { kind: "tool.completed", summary: "Grep" }),
            childActivity("child-text", { summary: "Reading the migrations" }),
          ]),
        ),
      );

      const fiber = yield* mirrorChildLifecycle(
        target,
        waitFor(ticks(3), { _tag: "timeout" }),
      ).pipe(provide(harness), Effect.forkChild({ startImmediately: true }));

      yield* TestClock.adjust(ticks(3));
      yield* Fiber.join(fiber);

      const activities = appended(yield* Ref.get(harness.dispatched));
      const progress = activities.filter((activity) => activity.kind === "task.progress");
      assert.strictEqual(progress.length, 3);
      assert.strictEqual(
        new Set(progress.map((activity) => activity.id)).size,
        1,
        "every tick reuses one coalescing activity id",
      );
      assert.deepStrictEqual(progress[0]?.payload, {
        taskId: CHILD_THREAD_ID,
        subagentType: "Explore",
        title: "Reading the migrations",
        lastToolName: "Grep",
      });

      const subagents = foldSubagents(activities);
      assert.strictEqual(subagents.length, 1);
      assert.strictEqual(subagents[0]?.lastProgressSummary, "Reading the migrations");
      assert.strictEqual(subagents[0]?.lastToolName, "Grep");
      // The row's freshness tracks the newest tick, not the spawn.
      assert.strictEqual(subagents[0]?.updatedAt, progress[2]?.createdAt);
      assert.notStrictEqual(progress[0]?.createdAt, progress[2]?.createdAt);
    }).pipe(withTestClock),
  );

  it.effect("still refreshes the row while the child reports nothing", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const fiber = yield* mirrorChildLifecycle(
        target,
        waitFor(ticks(1), { _tag: "timeout" }),
      ).pipe(provide(harness), Effect.forkChild({ startImmediately: true }));

      yield* TestClock.adjust(ticks(1));
      yield* Fiber.join(fiber);

      const activities = appended(yield* Ref.get(harness.dispatched));
      const progress = activities.filter((activity) => activity.kind === "task.progress");
      assert.strictEqual(progress.length, 1);
      assert.deepStrictEqual(progress[0]?.payload, {
        taskId: CHILD_THREAD_ID,
        subagentType: "Explore",
      });
      assert.strictEqual(foldSubagents(activities)[0]?.updatedAt, progress[0]?.createdAt);
    }).pipe(withTestClock),
  );

  it.effect("claims no outcome on timeout and lets the row go stale", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const fiber = yield* mirrorChildLifecycle(
        target,
        waitFor(ticks(2), { _tag: "timeout" }),
      ).pipe(provide(harness), Effect.forkChild({ startImmediately: true }));

      yield* TestClock.adjust(ticks(2));
      const outcome = yield* Fiber.join(fiber);
      assert.strictEqual(outcome._tag, "timeout");

      const activities = appended(yield* Ref.get(harness.dispatched));
      assert.strictEqual(
        activities.filter((activity) => activity.kind === "task.completed").length,
        0,
      );

      // The mirror fiber died with the wait: nothing more is appended.
      const countAfterTimeout = activities.length;
      yield* TestClock.adjust(ticks(5));
      assert.strictEqual((yield* Ref.get(harness.dispatched)).length, countAfterTimeout);

      const subagents = foldSubagents(activities);
      assert.strictEqual(subagents.length, 1);
      assert.strictEqual(subagents[0]?.status, "running");

      const updatedAtMs = Date.parse(subagents[0]?.updatedAt ?? "");
      assert.strictEqual(countFreshRunningSubagents(subagents, updatedAtMs), 1);
      yield* TestClock.adjust(Duration.millis(RUNNING_SUBAGENT_FRESHNESS_MS + 1));
      const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
      assert.isAbove(nowMs - updatedAtMs, RUNNING_SUBAGENT_FRESHNESS_MS);
      assert.strictEqual(countFreshRunningSubagents(subagents, nowMs), 0);
    }).pipe(withTestClock),
  );

  it.effect("survives a dispatch failure on every append", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const result = yield* mirrorChildLifecycle(
        target,
        waitFor(ticks(1), { _tag: "settled", status: "completed" }),
      ).pipe(
        provide(harness, { dispatchFails: true }),
        Effect.forkChild({ startImmediately: true }),
      );

      yield* TestClock.adjust(ticks(1));
      const outcome = yield* Fiber.join(result);

      assert.strictEqual(outcome._tag, "settled");
      assert.deepStrictEqual(yield* Ref.get(harness.dispatched), []);
    }).pipe(withTestClock),
  );
});
