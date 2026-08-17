/**
 * The guard around a mid-turn nudge (t3code-2jh.7).
 *
 * The conflict radar is the first thing that ever spoke to a worker while its
 * turn was running. Everything it costs is on the wrong side of this guard: a
 * message that lands after settlement starts a turn with no timeout, no
 * liveness watch and no owner, in a worktree the merge queue is about to
 * trial-merge, and a driver that cannot steer turns every nudge into one of
 * those. So the guard is tested on its own, without the whole runner.
 */
import type {
  OrchestrationCommand,
  OrchestrationThreadDetailSnapshot,
  OrchestrationThreadShell,
} from "@t3tools/contracts";
import { PROVIDER_TURN_STEER_ATTRIBUTED_ACTIVITY_KIND, ThreadId, TurnId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";

import type { OrchestrationEngineShape } from "../../orchestration/Services/OrchestrationEngine.ts";
import type { ProjectionSnapshotQueryShape } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { makeServerPoolDispatch } from "./PoolDispatch.ts";

const threadId = ThreadId.make("thread-iteration-1");
const ownedTurn = TurnId.make("turn-owned");
const otherTurn = TurnId.make("turn-other");

/** A projection the test drives turn by turn. */
function harness(options: { readonly absorbNudges: boolean }) {
  const dispatched: OrchestrationCommand[] = [];
  const state = {
    turnId: ownedTurn,
    turnState: "running" as "running" | "completed",
  };

  const nudgeMessageIds = () =>
    dispatched.flatMap((command) =>
      command.type === "thread.turn.start" && command.message.messageId.includes("-nudge-")
        ? [command.message.messageId]
        : [],
    );

  const latestTurn = () => ({
    turnId: state.turnId,
    state: state.turnState,
    requestedAt: "2026-01-01T00:00:00.000Z",
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: null,
    assistantMessageId: null,
  });

  const shell = () =>
    Option.some({
      id: threadId,
      latestTurn: latestTurn(),
      session: { status: "running" },
    } as unknown as OrchestrationThreadShell);

  const detail = () =>
    Option.some({
      snapshotSequence: 1,
      thread: {
        id: threadId,
        latestTurn: latestTurn(),
        messages: [],
        subagents: [],
        // The reactor writes this only when the provider reported that it
        // steered the running turn, so it is the whole absorption signal.
        activities: options.absorbNudges
          ? nudgeMessageIds().map((messageId, index) => ({
              id: `activity-${String(index)}`,
              tone: "info",
              kind: PROVIDER_TURN_STEER_ATTRIBUTED_ACTIVITY_KIND,
              summary: "steer attributed",
              payload: { messageId },
              turnId: state.turnId,
              createdAt: "2026-01-01T00:00:00.000Z",
            }))
          : [],
        checkpoints: [],
        session: { status: "running" },
      },
    } as unknown as OrchestrationThreadDetailSnapshot);

  const dispatch = makeServerPoolDispatch({
    engine: {
      dispatch: (command: OrchestrationCommand) => {
        dispatched.push(command);
        return Effect.succeed({ sequence: dispatched.length });
      },
    } as unknown as OrchestrationEngineShape,
    projectionSnapshotQuery: {
      getThreadShellById: () => Effect.succeed(shell()),
      getThreadDetailSnapshot: () => Effect.succeed(detail()),
    } as unknown as ProjectionSnapshotQueryShape,
    processRunner: {} as never,
    projectSetupScriptRunner: {} as never,
    crypto: { randomUUIDv4: Effect.succeed("uuid-1") } as never,
    workerScopeRegistry: {} as never,
    subagentRegistry: {} as never,
    readIterationSubagents: () => Effect.succeed({}),
  });

  const beginTurnInput = {
    threadId,
    prompt: "Cook the next child",
    policy: { pollIntervalMs: 1, quietPeriodMs: 1 },
    iterationIndex: 1,
    headBefore: null,
    branchBase: null,
    initialWorktreeFingerprint: null,
  } as unknown as Parameters<typeof dispatch.beginTurn>[0];

  return { dispatched, dispatch, beginTurnInput, state, nudgeMessageIds };
}

/** Run the settle wait long enough for it to adopt the thread's running turn. */
const withOwnedTurn = <A, E>(
  settle: Effect.Effect<unknown, E>,
  body: Effect.Effect<A, never>,
): Effect.Effect<A, never> =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(settle.pipe(Effect.ignore));
    yield* Effect.sleep("50 millis");
    const result = yield* body;
    yield* Fiber.interrupt(fiber);
    return result;
  });

describe("epic runner conflict nudge", () => {
  it.live("sends into the turn the iteration owns and reports it absorbed", () =>
    Effect.gen(function* () {
      const test = harness({ absorbNudges: true });
      const handle = yield* test.dispatch.beginTurn(test.beginTurnInput);

      const outcome = yield* withOwnedTurn(handle.awaitSettled, handle.nudge("resolve it now"));

      assert.equal(outcome, "sent");
      const nudge = test.dispatched.find(
        (command) =>
          command.type === "thread.turn.start" && command.message.messageId.includes("-nudge-"),
      );
      assert.isDefined(nudge);
      assert.equal(
        nudge?.type === "thread.turn.start" ? nudge.message.text : null,
        "resolve it now",
      );
      // Immediate, never `turn-boundary`: parking the message until the turn
      // ends is the opposite of a nudge, and it comes back as the stray turn
      // the guard exists to prevent.
      assert.isUndefined(nudge?.type === "thread.turn.start" ? nudge.delivery : "unset");
      assert.equal(nudge?.type === "thread.turn.start" ? nudge.origin : null, "agent");
    }),
  );

  it.live("skips a nudge when the thread's latest turn is not the iteration's own", () =>
    Effect.gen(function* () {
      const test = harness({ absorbNudges: true });
      const handle = yield* test.dispatch.beginTurn(test.beginTurnInput);

      const outcome = yield* withOwnedTurn(
        handle.awaitSettled,
        Effect.suspend(() => {
          // A human turn, a grace continuation, anything: the thread moved on
          // and this handle no longer owns what is running.
          test.state.turnId = otherTurn;
          return handle.nudge("resolve it now");
        }),
      );

      assert.equal(outcome, "skipped");
      assert.deepEqual(test.nudgeMessageIds(), []);
    }),
  );

  it.live("skips a nudge once the owned turn has stopped running", () =>
    Effect.gen(function* () {
      const test = harness({ absorbNudges: true });
      const handle = yield* test.dispatch.beginTurn(test.beginTurnInput);

      const outcome = yield* withOwnedTurn(
        handle.awaitSettled,
        Effect.suspend(() => {
          test.state.turnState = "completed";
          return handle.nudge("resolve it now");
        }),
      );

      assert.equal(outcome, "skipped");
      assert.deepEqual(test.nudgeMessageIds(), []);
    }),
  );

  it.live("writes the iteration off when the provider does not absorb the message", () =>
    Effect.gen(function* () {
      const test = harness({ absorbNudges: false });
      const handle = yield* test.dispatch.beginTurn(test.beginTurnInput);

      const outcomes = yield* withOwnedTurn(
        handle.awaitSettled,
        Effect.gen(function* () {
          const first = yield* handle.nudge("resolve it now");
          const second = yield* handle.nudge("resolve it now");
          return [first, second];
        }),
      );

      // Kimi, Grok, Cursor and Codex's two fallbacks answer a steer with a
      // whole new turn. One is a stray turn already; a second would be another.
      assert.deepEqual(outcomes, ["unsupported", "unsupported"]);
      assert.lengthOf(test.nudgeMessageIds(), 1);
    }),
  );
});
