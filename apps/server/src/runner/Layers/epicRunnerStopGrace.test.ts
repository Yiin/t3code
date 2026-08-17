/**
 * A forced stop that follows an interrupt owes the turn its stop grace.
 *
 * `supervision.stopGraceSeconds` used to reach only the terminal harness, so a
 * server-launched run killed the session in the same breath as the interrupt
 * and an interrupted turn could die before it closed (t3code-22o.15). The loop
 * now states the grace per call, and this is the server side honouring it.
 */
import type { OrchestrationCommand, ThreadId as ThreadIdType } from "@t3tools/contracts";
import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { OrchestrationEngineShape } from "../../orchestration/Services/OrchestrationEngine.ts";
import type { ProjectionSnapshotQueryShape } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { makeServerPoolDispatch } from "./PoolDispatch.ts";

const threadId = ThreadId.make("thread-iteration-1");

/** Read `states` one entry per snapshot read, repeating the last one forever. */
function harness(states: ReadonlyArray<"running" | "completed">) {
  const dispatched: OrchestrationCommand[] = [];
  const reads: ThreadIdType[] = [];

  const dispatch = makeServerPoolDispatch({
    engine: {
      dispatch: (command: OrchestrationCommand) => {
        dispatched.push(command);
        return Effect.succeed({ sequence: dispatched.length });
      },
    } as unknown as OrchestrationEngineShape,
    projectionSnapshotQuery: {
      getThreadDetailSnapshot: (id: ThreadIdType) =>
        Effect.sync(() => {
          reads.push(id);
          const state = states[Math.min(reads.length - 1, states.length - 1)] ?? "completed";
          return Option.some({
            thread: { latestTurn: { state }, session: { status: "idle" } },
          });
        }),
    } as unknown as ProjectionSnapshotQueryShape,
    processRunner: {} as never,
    projectSetupScriptRunner: {} as never,
    crypto: { randomUUIDv4: Effect.succeed("uuid-1") } as never,
    workerScopeRegistry: {} as never,
    subagentRegistry: {} as never,
    readIterationSubagents: () => Effect.succeed({}),
  });

  return { dispatched, reads, dispatch };
}

const sessionStops = (commands: ReadonlyArray<OrchestrationCommand>) =>
  commands.filter((command) => command.type === "thread.session.stop");

describe("epic runner forced stop grace", () => {
  it.live("waits for an interrupted turn to close before stopping the session", () =>
    Effect.gen(function* () {
      // Running for the first two reads, closed on the third.
      const { dispatched, reads, dispatch } = harness(["running", "running", "completed"]);

      yield* dispatch.stopForced(threadId, { graceSeconds: 5 });

      expect(reads.length).toBe(3);
      expect(sessionStops(dispatched)).toHaveLength(1);
    }),
  );

  it.live("stops at once when the turn has already closed", () =>
    Effect.gen(function* () {
      const { dispatched, reads, dispatch } = harness(["completed"]);

      const startedAt = yield* Clock.currentTimeMillis;
      yield* dispatch.stopForced(threadId, { graceSeconds: 30 });

      // The grace is a bound, never a delay: a closed turn costs one read.
      expect((yield* Clock.currentTimeMillis) - startedAt).toBeLessThan(1_000);
      expect(reads.length).toBe(1);
      expect(sessionStops(dispatched)).toHaveLength(1);
    }),
  );

  it.live("stops a turn that never closes once the grace runs out", () =>
    Effect.gen(function* () {
      const { dispatched, reads, dispatch } = harness(["running"]);

      const startedAt = yield* Clock.currentTimeMillis;
      yield* dispatch.stopForced(threadId, { graceSeconds: 0.75 });

      const elapsed = (yield* Clock.currentTimeMillis) - startedAt;
      expect(elapsed).toBeGreaterThanOrEqual(700);
      expect(reads.length).toBeGreaterThan(1);
      // The grace bounds the wait; it never cancels the stop.
      expect(sessionStops(dispatched)).toHaveLength(1);
    }),
  );

  it.live("reads nothing when the caller interrupted nothing", () =>
    Effect.gen(function* () {
      const { dispatched, reads, dispatch } = harness(["running"]);

      yield* dispatch.stopForced(threadId, { graceSeconds: 0 });

      expect(reads).toEqual([]);
      expect(sessionStops(dispatched)).toHaveLength(1);
    }),
  );
});
