import {
  EventId,
  MessageId,
  NonNegativeInt,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationLatestTurn,
  type OrchestrationMessage,
  type OrchestrationThread,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../Services/ProjectionSnapshotQuery.ts";
import { QueuedTurnDeliveryReactor } from "../Services/QueuedTurnDeliveryReactor.ts";
import {
  QUEUED_DELIVERY_POLL_INTERVAL,
  QueuedTurnDeliveryReactorLive,
} from "./QueuedTurnDeliveryReactor.ts";

const NOW = "2026-08-11T00:00:00.000Z";
const THREAD_ID = ThreadId.make("thread-1");
const OTHER_THREAD_ID = ThreadId.make("thread-2");

/**
 * One test clock for the test fiber and every poller the reactor forks.
 *
 * Providing it any deeper would hand a forked poller its own clock, and
 * `TestClock.adjust` here would never move its sleeps.
 */
const withTestClock = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(TestClock.layer()));

/**
 * The subscription fiber hands each event to the worker on its own fiber, so
 * yield a few times before draining. Scheduler-driven, not clock-driven.
 */
const yieldFibers = Effect.forEach(Array.from({ length: 20 }), () => Effect.yieldNow, {
  discard: true,
});

const runningTurn: OrchestrationLatestTurn = {
  turnId: TurnId.make("turn-1"),
  state: "running",
  requestedAt: NOW,
  startedAt: NOW,
  completedAt: null,
  assistantMessageId: null,
};

function makeShell(latestTurn: OrchestrationLatestTurn | null): OrchestrationThreadShell {
  return {
    id: THREAD_ID,
    projectId: ProjectId.make("project-1"),
    title: "Thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    activeSubagentCount: NonNegativeInt.make(0),
    parentThreadId: null,
  };
}

function makeQueuedMessage(input: {
  readonly id: string;
  readonly text: string;
  readonly createdAt: string;
  readonly origin?: "human" | "agent";
  readonly queued?: boolean;
}): OrchestrationMessage {
  return {
    id: MessageId.make(input.id),
    role: "user",
    text: input.text,
    attachments: [],
    ...(input.origin !== undefined ? { origin: input.origin } : {}),
    ...(input.queued === false ? {} : { deliveryState: "queued" as const }),
    turnId: null,
    streaming: false,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  };
}

function makeThread(messages: ReadonlyArray<OrchestrationMessage>): OrchestrationThread {
  return {
    id: THREAD_ID,
    projectId: ProjectId.make("project-1"),
    title: "Thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    parentThreadId: null,
    messages,
    proposedPlans: [],
    subagents: [],
    activities: [],
    checkpoints: [],
    session: null,
  };
}

function queuedMessageEvent(threadId: ThreadId, messageId: string): OrchestrationEvent {
  return {
    sequence: 1,
    eventId: EventId.make(`event-${messageId}`),
    aggregateKind: "thread",
    aggregateId: threadId,
    occurredAt: NOW,
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "thread.message-sent",
    payload: {
      threadId,
      messageId: MessageId.make(messageId),
      role: "user",
      text: "keep going",
      attachments: [],
      origin: "human",
      deliveryState: "queued",
      turnId: null,
      streaming: false,
      createdAt: NOW,
      updatedAt: NOW,
    },
  };
}

function deliveredMessageEvent(threadId: ThreadId, messageId: string): OrchestrationEvent {
  const event = queuedMessageEvent(threadId, messageId);
  if (event.type !== "thread.message-sent") {
    throw new Error("expected a message-sent event");
  }
  const { deliveryState: _queued, ...payload } = event.payload;
  return { ...event, payload };
}

interface HarnessState {
  /** The thread shell every poll reads. Mutate it to end the turn. */
  shell: OrchestrationThreadShell | undefined;
  /** The thread detail the drain reads. Mutate it to change the queue. */
  thread: OrchestrationThread | undefined;
  /** What the boot sweep finds. */
  queuedThreadIds: ReadonlyArray<ThreadId>;
}

interface Harness {
  readonly state: HarnessState;
  readonly dispatched: ReadonlyArray<OrchestrationCommand>;
  /** Publish events and let the reactor route them, without waiting on pollers. */
  readonly emit: (...events: ReadonlyArray<OrchestrationEvent>) => Effect.Effect<void>;
  /** Wait for routing AND every running poller. */
  readonly settle: Effect.Effect<void>;
}

function withHarness(
  options: {
    readonly state: HarnessState;
    readonly dispatch?: (
      command: OrchestrationCommand,
    ) => Effect.Effect<{ readonly sequence: number }>;
  },
  body: (harness: Harness) => Effect.Effect<void>,
) {
  return Effect.gen(function* () {
    const dispatched: OrchestrationCommand[] = [];
    const events = yield* Queue.unbounded<OrchestrationEvent>();
    const { state } = options;

    // What the real projection does on a redelivery: the upsert writes
    // `delivery_state` straight through, so a turn start with no delivery
    // intent clears the queued flag on that message row.
    const clearQueuedFlag = (command: OrchestrationCommand) => {
      if (command.type !== "thread.turn.start" || state.thread === undefined) {
        return;
      }
      state.thread = {
        ...state.thread,
        messages: state.thread.messages.map((message) => {
          if (message.id !== command.message.messageId) {
            return message;
          }
          const { deliveryState: _delivered, ...rest } = message;
          return rest;
        }),
      };
    };

    const engine = {
      readEvents: () => Stream.empty,
      dispatch: (command: OrchestrationCommand) => {
        dispatched.push(command);
        if (options.dispatch !== undefined) {
          return options.dispatch(command);
        }
        return Effect.gen(function* () {
          // A real dispatch commits its projection inside a transaction, so
          // the queued flag clears a moment AFTER the command is accepted.
          // Anything reading the thread in that moment still sees the row as
          // queued, which is exactly what a second poller would do.
          yield* Effect.yieldNow;
          clearQueuedFlag(command);
          return { sequence: dispatched.length };
        });
      },
      streamDomainEvents: Stream.fromQueue(events),
      latestSequence: Effect.succeed(0),
    } as unknown as OrchestrationEngineShape;

    const snapshotQuery = {
      getThreadShellById: () => Effect.succeed(Option.fromUndefinedOr(state.shell)),
      getThreadDetailById: () => Effect.succeed(Option.fromUndefinedOr(state.thread)),
      listRunningThreadBackedSubagents: () => Effect.succeed([]),
      listThreadIdsWithQueuedMessages: () => Effect.succeed(state.queuedThreadIds),
    } as unknown as ProjectionSnapshotQueryShape;

    yield* Effect.gen(function* () {
      const reactor = yield* QueuedTurnDeliveryReactor;
      yield* reactor.start();

      const emit: Harness["emit"] = (...toEmit) =>
        Effect.gen(function* () {
          for (const event of toEmit) {
            yield* Queue.offer(events, event);
          }
          yield* yieldFibers;
        });

      yield* body({ state, dispatched, emit, settle: reactor.drain });
    }).pipe(
      Effect.provide(
        QueuedTurnDeliveryReactorLive.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(OrchestrationEngineService, engine),
              Layer.succeed(ProjectionSnapshotQuery, snapshotQuery),
            ),
          ),
        ),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer), withTestClock);
}

const turnStarts = (commands: ReadonlyArray<OrchestrationCommand>) =>
  commands.filter((command) => command.type === "thread.turn.start");

describe("QueuedTurnDeliveryReactor", () => {
  it.effect("delivers a queued message as soon as the thread is idle", () => {
    const state: HarnessState = {
      shell: makeShell(null),
      thread: makeThread([
        makeQueuedMessage({ id: "message-1", text: "keep going", createdAt: NOW }),
      ]),
      queuedThreadIds: [],
    };
    return withHarness({ state }, ({ dispatched, emit, settle }) =>
      Effect.gen(function* () {
        yield* emit(queuedMessageEvent(THREAD_ID, "message-1"));
        yield* settle;

        const starts = turnStarts(dispatched);
        expect(starts).toHaveLength(1);
        const [start] = starts;
        if (start?.type !== "thread.turn.start") {
          throw new Error("expected a turn start");
        }
        // Same message id, no delivery intent: the omission is what clears the
        // queued flag through the upsert.
        expect(start.message.messageId).toBe("message-1");
        expect(start.message.text).toBe("keep going");
        expect(start.delivery).toBeUndefined();
        expect(start.threadId).toBe(THREAD_ID);
      }),
    );
  });

  it.effect("waits out a running turn, then delivers every queued message in order", () => {
    const state: HarnessState = {
      shell: makeShell(runningTurn),
      thread: makeThread([
        makeQueuedMessage({
          id: "message-1",
          text: "first",
          createdAt: "2026-08-11T00:00:01.000Z",
          origin: "agent",
        }),
        makeQueuedMessage({
          id: "message-2",
          text: "second",
          createdAt: "2026-08-11T00:00:02.000Z",
        }),
      ]),
      queuedThreadIds: [],
    };
    return withHarness({ state }, ({ dispatched, emit, settle }) =>
      Effect.gen(function* () {
        yield* emit(queuedMessageEvent(THREAD_ID, "message-1"));
        // The poller has read a running turn and is asleep.
        expect(turnStarts(dispatched)).toHaveLength(0);

        state.shell = makeShell(null);
        const settling = yield* Effect.forkChild(settle, { startImmediately: true });
        yield* TestClock.adjust(QUEUED_DELIVERY_POLL_INTERVAL);
        yield* Fiber.await(settling);

        const starts = turnStarts(dispatched);
        expect(
          starts.map((start) => (start.type === "thread.turn.start" ? start.message.text : null)),
        ).toEqual(["first", "second"]);
        const [first] = starts;
        if (first?.type !== "thread.turn.start") {
          throw new Error("expected a turn start");
        }
        // The author of the queued message survives the redelivery.
        expect(first.origin).toBe("agent");
      }),
    );
  });

  it.effect("ignores a message that is not queued", () => {
    const state: HarnessState = {
      shell: makeShell(null),
      thread: makeThread([]),
      queuedThreadIds: [],
    };
    return withHarness({ state }, ({ dispatched, emit, settle }) =>
      Effect.gen(function* () {
        yield* emit(deliveredMessageEvent(THREAD_ID, "message-1"));
        yield* settle;

        expect(dispatched).toEqual([]);
      }),
    );
  });

  it.effect("runs one poller per thread, however many messages it queues", () => {
    const state: HarnessState = {
      shell: makeShell(runningTurn),
      thread: makeThread([
        makeQueuedMessage({ id: "message-1", text: "first", createdAt: NOW }),
        makeQueuedMessage({ id: "message-2", text: "second", createdAt: NOW }),
      ]),
      queuedThreadIds: [THREAD_ID],
    };
    return withHarness({ state }, ({ dispatched, emit, settle }) =>
      Effect.gen(function* () {
        // Boot sweep plus two live events, all naming the same thread. Two
        // pollers would wake on the same tick and drain the same rows twice,
        // before either delivery could clear a flag.
        yield* emit(
          queuedMessageEvent(THREAD_ID, "message-1"),
          queuedMessageEvent(THREAD_ID, "message-2"),
        );
        state.shell = makeShell(null);
        const settling = yield* Effect.forkChild(settle, { startImmediately: true });
        yield* TestClock.adjust(QUEUED_DELIVERY_POLL_INTERVAL);
        yield* Fiber.await(settling);

        expect(
          turnStarts(dispatched).map((command) =>
            command.type === "thread.turn.start" ? command.message.messageId : null,
          ),
        ).toEqual(["message-1", "message-2"]);
      }),
    );
  });

  it.effect("sweeps threads that were already holding queued messages at boot", () => {
    const state: HarnessState = {
      shell: makeShell(null),
      thread: makeThread([
        makeQueuedMessage({ id: "message-boot", text: "left over", createdAt: NOW }),
      ]),
      queuedThreadIds: [THREAD_ID],
    };
    return withHarness({ state }, ({ dispatched, settle }) =>
      Effect.gen(function* () {
        // No event at all: only the boot sweep can find this one.
        yield* settle;

        const starts = turnStarts(dispatched);
        expect(starts).toHaveLength(1);
        const [start] = starts;
        if (start?.type !== "thread.turn.start") {
          throw new Error("expected a turn start");
        }
        expect(start.message.messageId).toBe("message-boot");
      }),
    );
  });

  it.effect("reports a failed delivery and leaves the message queued", () => {
    const state: HarnessState = {
      shell: makeShell(null),
      thread: makeThread([
        makeQueuedMessage({ id: "message-1", text: "first", createdAt: NOW }),
        makeQueuedMessage({ id: "message-2", text: "second", createdAt: NOW }),
      ]),
      queuedThreadIds: [],
    };
    return withHarness(
      {
        state,
        dispatch: (command) =>
          command.type === "thread.turn.start"
            ? Effect.die(new Error("dispatch exploded"))
            : Effect.succeed({ sequence: 1 }),
      },
      ({ dispatched, emit, settle }) =>
        Effect.gen(function* () {
          yield* emit(queuedMessageEvent(THREAD_ID, "message-1"));
          const settling = yield* Effect.forkChild(settle, { startImmediately: true });
          // Three attempts, each one backing off before the next.
          yield* TestClock.adjust(Duration.minutes(1));
          yield* Fiber.await(settling);

          const failures = dispatched.filter(
            (command) =>
              command.type === "thread.activity.append" &&
              command.activity.kind === "provider.turn.start.failed",
          );
          expect(failures.length).toBeGreaterThan(0);
          // The drain stops at the first failure, so the second message never
          // overtakes the first.
          const attempted = turnStarts(dispatched).map((command) =>
            command.type === "thread.turn.start" ? command.message.messageId : null,
          );
          expect(new Set(attempted)).toEqual(new Set(["message-1"]));
        }),
    );
  });

  it.effect("stops polling a thread the projection can no longer see", () => {
    const state: HarnessState = {
      shell: undefined,
      thread: undefined,
      queuedThreadIds: [],
    };
    return withHarness({ state }, ({ dispatched, emit, settle }) =>
      Effect.gen(function* () {
        yield* emit(queuedMessageEvent(OTHER_THREAD_ID, "message-1"));
        yield* settle;

        expect(dispatched).toEqual([]);
      }),
    );
  });
});
