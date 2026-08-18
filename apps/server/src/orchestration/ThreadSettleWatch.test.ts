import { assert, describe, it } from "@effect/vitest";
import {
  MessageId,
  ThreadId,
  TurnId,
  type OrchestrationThread,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { ProjectionSnapshotQueryShape } from "./Services/ProjectionSnapshotQuery.ts";
import { unsupportedProjectionSnapshotQuery } from "./testUtils/projectionSnapshotQueryStub.ts";
import { makeThreadSettleWatch } from "./ThreadSettleWatch.ts";

const threadId = ThreadId.make("thread-settle-watch");
const turnOne = TurnId.make("turn-one");
const turnTwo = TurnId.make("turn-two");

const shell = (turnId: TurnId, state: "running" | "completed"): OrchestrationThreadShell =>
  ({
    latestTurn: { turnId, state },
    session: { status: "running", activeTurnId: turnId },
  }) as OrchestrationThreadShell;

describe("ThreadSettleWatch", () => {
  it.live("reports ownership when the first observed turn already completed", () => {
    const observed: TurnId[] = [];
    const projectionSnapshotQuery: ProjectionSnapshotQueryShape = {
      ...unsupportedProjectionSnapshotQuery,
      getThreadShellById: () => Effect.succeed(Option.some(shell(turnOne, "completed"))),
    };
    const watch = makeThreadSettleWatch({ projectionSnapshotQuery });

    return Effect.gen(function* () {
      const settled = yield* watch.awaitTurnEnd(
        threadId,
        { pollIntervalMs: 1, quietPeriodMs: 1 },
        null,
        (turnId) => observed.push(turnId),
      );
      assert.deepStrictEqual(settled, { turnId: turnOne, state: "completed" });
      assert.deepStrictEqual(observed, [turnOne]);
    });
  });

  it.live("settles the first observed turn when a second turn becomes active", () => {
    const reads = [shell(turnOne, "running"), shell(turnTwo, "running")];
    const projectionSnapshotQuery: ProjectionSnapshotQueryShape = {
      ...unsupportedProjectionSnapshotQuery,
      getThreadShellById: () =>
        Effect.succeed(Option.some(reads.shift() ?? shell(turnTwo, "running"))),
    };
    const watch = makeThreadSettleWatch({ projectionSnapshotQuery });

    return Effect.gen(function* () {
      const settled = yield* watch.awaitTurnEnd(threadId, {
        pollIntervalMs: 1,
        quietPeriodMs: 1,
      });
      assert.deepStrictEqual(settled, { turnId: turnOne, state: "completed" });
    });
  });

  it.live("does not hold prompt one open while prompt two is running", () => {
    let reads = 0;
    const projectionSnapshotQuery: ProjectionSnapshotQueryShape = {
      ...unsupportedProjectionSnapshotQuery,
      getThreadShellById: () => {
        reads += 1;
        return Effect.succeed(
          Option.some(reads === 1 ? shell(turnOne, "running") : shell(turnTwo, "running")),
        );
      },
    };
    const watch = makeThreadSettleWatch({ projectionSnapshotQuery });

    return Effect.gen(function* () {
      const settled = yield* watch.awaitTurnEnd(threadId, {
        pollIntervalMs: 1,
        quietPeriodMs: 1,
      });
      assert.strictEqual(settled.turnId, turnOne);
      assert.strictEqual(reads, 2);
    });
  });

  it.live("extends a pinned completed turn wait while a newer turn is running", () => {
    let reads = 0;
    const projectionSnapshotQuery: ProjectionSnapshotQueryShape = {
      ...unsupportedProjectionSnapshotQuery,
      getThreadDetailSnapshot: () => {
        reads += 1;
        const ownedMessage = {
          id: MessageId.make("owned-answer"),
          role: "assistant" as const,
          text: "owned answer",
          turnId: turnOne,
          streaming: false,
        };
        const thread = {
          latestTurn: { turnId: turnTwo, state: "running" },
          session: { status: "running", activeTurnId: turnTwo },
          messages: reads > 25 ? [ownedMessage] : [],
        } as unknown as OrchestrationThread;
        return Effect.succeed(Option.some({ snapshotSequence: reads, thread }));
      },
    };
    const watch = makeThreadSettleWatch({ projectionSnapshotQuery });

    return Effect.gen(function* () {
      const settled = yield* watch.readSettledFinalMessage(
        threadId,
        { pollIntervalMs: 1, quietPeriodMs: 1 },
        turnOne,
        "completed",
      );
      assert.isFalse(settled.messageWaitExhausted);
      assert.isAbove(reads, 25);
    });
  });
});
