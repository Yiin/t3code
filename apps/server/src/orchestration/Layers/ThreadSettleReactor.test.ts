import type {
  OrchestrationCommand,
  OrchestrationEvent,
  OrchestrationThreadShell,
  ProjectId,
} from "@t3tools/contracts";
import { EventId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../Services/ProjectionSnapshotQuery.ts";
import { ThreadSettleReactor } from "../Services/ThreadSettleReactor.ts";
import { ThreadSettleReactorLive } from "./ThreadSettleReactor.ts";

const now = "2026-08-03T00:00:00.000Z";
const projectId = "project-settle" as ProjectId;

// The subscription fiber forwards each event into the worker queue on its own
// fiber, so yield a few times before `drain()` to let that hand-off happen.
// Both are scheduler-driven, not clock-driven, so no test here sleeps.
const yieldFibers = Effect.forEach(Array.from({ length: 20 }), () => Effect.yieldNow, {
  discard: true,
});

function makeThreadShell(
  threadId: ThreadId,
  session: OrchestrationThreadShell["session"],
): OrchestrationThreadShell {
  return {
    id: threadId,
    projectId,
    title: "Settle me",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: "settled",
    settledAt: now,
    session,
    latestUserMessageAt: now,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  } satisfies OrchestrationThreadShell;
}

function makeSession(
  threadId: ThreadId,
  status: NonNullable<OrchestrationThreadShell["session"]>["status"],
): NonNullable<OrchestrationThreadShell["session"]> {
  return {
    threadId,
    status,
    providerName: "Codex",
    runtimeMode: "full-access",
    activeTurnId: null,
    lastError: null,
    updatedAt: now,
  };
}

function settledEvent(threadId: ThreadId, sequence: number): OrchestrationEvent {
  return {
    sequence,
    eventId: EventId.make(`event-settled-${sequence}`),
    aggregateKind: "thread",
    aggregateId: threadId,
    occurredAt: now,
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "thread.settled",
    payload: { threadId, settledAt: now, updatedAt: now },
  };
}

function archivedEvent(threadId: ThreadId, sequence: number): OrchestrationEvent {
  return {
    sequence,
    eventId: EventId.make(`event-archived-${sequence}`),
    aggregateKind: "thread",
    aggregateId: threadId,
    occurredAt: now,
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "thread.archived",
    payload: { threadId, archivedAt: now, updatedAt: now },
  };
}

function commandThreadId(command: OrchestrationCommand): ThreadId | null {
  return "threadId" in command ? command.threadId : null;
}

interface Harness {
  /** Commands the reactor dispatched, in order. */
  readonly dispatched: ReadonlyArray<OrchestrationCommand>;
  /** Publish events, then resolve once the reactor has processed them all. */
  readonly emit: (...events: ReadonlyArray<OrchestrationEvent>) => Effect.Effect<void>;
}

function withHarness(
  options: {
    readonly threads: ReadonlyArray<OrchestrationThreadShell>;
    readonly dispatch?: (
      command: OrchestrationCommand,
    ) => Effect.Effect<{ readonly sequence: number }>;
  },
  body: (harness: Harness) => Effect.Effect<void>,
) {
  return Effect.gen(function* () {
    const dispatched: OrchestrationCommand[] = [];
    const events = yield* Queue.unbounded<OrchestrationEvent>();
    const threadsById = new Map(options.threads.map((thread) => [thread.id, thread]));

    const engine = {
      readEvents: () => Stream.empty,
      dispatch: (command: OrchestrationCommand) => {
        dispatched.push(command);
        return options.dispatch === undefined
          ? Effect.succeed({ sequence: dispatched.length })
          : options.dispatch(command);
      },
      streamDomainEvents: Stream.fromQueue(events),
      latestSequence: Effect.succeed(0),
    } as unknown as OrchestrationEngineShape;

    const snapshotQuery = {
      getThreadShellById: (threadId: ThreadId) =>
        Effect.succeed(Option.fromUndefinedOr(threadsById.get(threadId))),
    } as unknown as ProjectionSnapshotQueryShape;

    yield* Effect.gen(function* () {
      const reactor = yield* ThreadSettleReactor;
      yield* reactor.start();

      const emit: Harness["emit"] = (...toEmit) =>
        Effect.gen(function* () {
          for (const event of toEmit) {
            yield* Queue.offer(events, event);
          }
          yield* yieldFibers;
          yield* reactor.drain;
        });

      yield* body({ dispatched, emit });
    }).pipe(
      Effect.provide(
        ThreadSettleReactorLive.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(OrchestrationEngineService, engine),
              Layer.succeed(ProjectionSnapshotQuery, snapshotQuery),
            ),
          ),
        ),
      ),
    );
  }).pipe(Effect.scoped);
}

describe("ThreadSettleReactor", () => {
  it.effect("stops the session of a settled thread exactly once", () => {
    const threadId = ThreadId.make("thread-settle-live");
    return withHarness(
      { threads: [makeThreadShell(threadId, makeSession(threadId, "running"))] },
      ({ dispatched, emit }) =>
        Effect.gen(function* () {
          yield* emit(settledEvent(threadId, 7));

          expect(dispatched).toHaveLength(1);
          expect(dispatched[0]).toMatchObject({
            type: "thread.session.stop",
            threadId,
            commandId: `session-stop-for-settle:${threadId}:7`,
          });
        }),
    );
  });

  it.effect("dispatches nothing when the settled thread has no session", () => {
    const threadId = ThreadId.make("thread-settle-no-session");
    const liveThreadId = ThreadId.make("thread-settle-no-session-follower");
    return withHarness(
      {
        threads: [
          makeThreadShell(threadId, null),
          makeThreadShell(liveThreadId, makeSession(liveThreadId, "ready")),
        ],
      },
      ({ dispatched, emit }) =>
        Effect.gen(function* () {
          // The follower settles right after, so its dispatch proves the
          // session-less event was skipped on purpose, not merely unprocessed.
          yield* emit(settledEvent(threadId, 1), settledEvent(liveThreadId, 2));

          expect(dispatched.map(commandThreadId)).toEqual([liveThreadId]);
        }),
    );
  });

  it.effect("dispatches nothing when the session is already stopped", () => {
    const threadId = ThreadId.make("thread-settle-stopped");
    const liveThreadId = ThreadId.make("thread-settle-stopped-follower");
    return withHarness(
      {
        threads: [
          makeThreadShell(threadId, makeSession(threadId, "stopped")),
          makeThreadShell(liveThreadId, makeSession(liveThreadId, "running")),
        ],
      },
      ({ dispatched, emit }) =>
        Effect.gen(function* () {
          yield* emit(settledEvent(threadId, 3), settledEvent(liveThreadId, 4));

          expect(dispatched.map(commandThreadId)).toEqual([liveThreadId]);
        }),
    );
  });

  it.effect("survives a dispatch failure and still handles the next event", () => {
    const failingThreadId = ThreadId.make("thread-settle-dispatch-fails");
    const nextThreadId = ThreadId.make("thread-settle-after-failure");
    return withHarness(
      {
        threads: [
          makeThreadShell(failingThreadId, makeSession(failingThreadId, "running")),
          makeThreadShell(nextThreadId, makeSession(nextThreadId, "running")),
        ],
        dispatch: (command) =>
          commandThreadId(command) === failingThreadId
            ? Effect.die(new Error("dispatch exploded"))
            : Effect.succeed({ sequence: 1 }),
      },
      ({ dispatched, emit }) =>
        Effect.gen(function* () {
          yield* emit(settledEvent(failingThreadId, 5));
          yield* emit(settledEvent(nextThreadId, 6));

          expect(dispatched.map(commandThreadId)).toEqual([failingThreadId, nextThreadId]);
        }),
    );
  });

  it.effect("ignores events that are not thread.settled", () => {
    const threadId = ThreadId.make("thread-settle-other-event");
    return withHarness(
      { threads: [makeThreadShell(threadId, makeSession(threadId, "running"))] },
      ({ dispatched, emit }) =>
        Effect.gen(function* () {
          yield* emit(archivedEvent(threadId, 7));
          expect(dispatched).toEqual([]);

          // The same thread settling next proves the archived event was skipped
          // on purpose, not lost before the reactor could see it.
          yield* emit(settledEvent(threadId, 8));
          expect(dispatched.map(commandThreadId)).toEqual([threadId]);
        }),
    );
  });
});
