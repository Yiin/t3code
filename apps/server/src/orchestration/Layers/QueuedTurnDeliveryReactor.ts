/**
 * QueuedTurnDeliveryReactor - the gate that turns a queued message into a turn.
 *
 * See `../Services/QueuedTurnDeliveryReactor.ts` for what this is for. The
 * shape here mirrors `ProviderCommandReactor.ts`: a drainable worker behind a
 * `streamDomainEvents` subscription, plus one boot sweep that replays what the
 * live stream can no longer show.
 *
 * @module QueuedTurnDeliveryReactor
 */
import {
  CommandId,
  EventId,
  type OrchestrationEvent,
  type OrchestrationMessage,
  type OrchestrationThread,
  type ThreadId,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  QueuedTurnDeliveryReactor,
  type QueuedTurnDeliveryReactorShape,
} from "../Services/QueuedTurnDeliveryReactor.ts";

type MessageSentEvent = Extract<OrchestrationEvent, { type: "thread.message-sent" }>;

/** How often a waiting poller re-reads the thread shell. */
export const QUEUED_DELIVERY_POLL_INTERVAL = Duration.seconds(2);

/**
 * How long one poller waits for a turn to end before giving up.
 *
 * A turn can legitimately run for hours, so this is not "the turn failed" — it
 * is "stop reading this thread every two seconds". The message stays queued and
 * the next boot sweep, or the next queued message on the thread, picks it up.
 */
export const QUEUED_DELIVERY_MAX_WAIT = Duration.minutes(30);

/** Attempts at the whole wait-then-drain cycle before a poller gives up. */
const MAX_DELIVERY_ATTEMPTS = 3;

/** Backoff between two failed drains of the same thread. */
const DELIVERY_RETRY_DELAY = Duration.seconds(5);

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

/**
 * The messages parked on this thread, oldest first.
 *
 * Projection reads already order messages by `(created_at, message_id)`, which
 * is the order the drain must preserve.
 */
export const queuedMessagesOf = (
  thread: OrchestrationThread,
): ReadonlyArray<OrchestrationMessage> =>
  thread.messages.filter((message) => message.deliveryState === "queued");

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;

  const serverCommandId = (tag: string) =>
    crypto.randomUUIDv4.pipe(Effect.map((uuid) => CommandId.make(`server:${tag}:${uuid}`)));
  const serverEventId = () => crypto.randomUUIDv4.pipe(Effect.map(EventId.make));

  /**
   * The threads a poller is already working, and the fibers doing it.
   *
   * `polling` is the dedupe: the live event and the boot sweep can both name
   * the same thread, and a second poller would drain the same rows twice —
   * the first delivery's projection commits a moment after its dispatch is
   * accepted, so the second poller reads the row while it still says queued.
   * It is claimed BEFORE the fork so the claim cannot lose a race to the
   * poller's own release. The fiber map exists only so `drain` can wait.
   */
  const polling = new Set<ThreadId>();
  const pollerFibers = new Map<ThreadId, Fiber.Fiber<void>>();

  const readThreadShell = (threadId: ThreadId) =>
    projectionSnapshotQuery.getThreadShellById(threadId).pipe(
      Effect.map(Option.getOrUndefined),
      Effect.catchCause((cause) =>
        Effect.logWarning("queued turn delivery failed to read thread shell", {
          threadId,
          cause: Cause.pretty(cause),
        }).pipe(Effect.as(undefined)),
      ),
    );

  const readThreadDetail = (threadId: ThreadId) =>
    projectionSnapshotQuery.getThreadDetailById(threadId).pipe(
      Effect.map(Option.getOrUndefined),
      Effect.catchCause((cause) =>
        Effect.logWarning("queued turn delivery failed to read thread detail", {
          threadId,
          cause: Cause.pretty(cause),
        }).pipe(Effect.as(undefined)),
      ),
    );

  const appendTurnStartFailure = (input: {
    readonly threadId: ThreadId;
    readonly detail: string;
  }) =>
    Effect.gen(function* () {
      const commandId = yield* serverCommandId("queued-turn-delivery-failure");
      const eventId = yield* serverEventId();
      const createdAt = yield* nowIso;
      yield* orchestrationEngine.dispatch({
        type: "thread.activity.append",
        commandId,
        threadId: input.threadId,
        activity: {
          id: eventId,
          tone: "error",
          kind: "provider.turn.start.failed",
          summary: "Queued message could not be delivered",
          payload: { detail: input.detail },
          turnId: null,
          createdAt,
        },
        createdAt,
      });
    }).pipe(Effect.ignoreCause({ log: true }));

  /**
   * Re-dispatch one parked message as an ordinary turn start.
   *
   * Same `messageId`, same text, same attachments, same origin, `delivery`
   * omitted. The omission is what clears the queued flag — every projection
   * writes `delivery_state` straight through rather than COALESCE'ing it.
   *
   * `createdAt` is now, not the moment the human typed it. Replaying the old
   * timestamp would keep the message where it sat in the thread, but staleness
   * accounting keys off it: `QUEUED_TURN_START_GRACE_MS` reads a user message
   * older than two minutes with no adopted turn as a failed start, so an old
   * timestamp would make a turn that is genuinely starting look dead.
   *
   * The command id is a fresh uuid rather than something derived from the
   * message. Command receipts are persisted, so a derived id would be deduped
   * by the engine on the boot sweep after a restart and the message would never
   * be delivered at all.
   */
  const redeliver = (input: {
    readonly thread: OrchestrationThread;
    readonly message: OrchestrationMessage;
  }) =>
    Effect.gen(function* () {
      const commandId = yield* serverCommandId("queued-turn-delivery");
      const createdAt = yield* nowIso;
      yield* orchestrationEngine.dispatch({
        type: "thread.turn.start",
        commandId,
        threadId: input.thread.id,
        message: {
          messageId: input.message.id,
          role: "user",
          text: input.message.text,
          attachments: input.message.attachments ?? [],
        },
        ...(input.message.origin !== undefined ? { origin: input.message.origin } : {}),
        runtimeMode: input.thread.runtimeMode,
        interactionMode: input.thread.interactionMode,
        createdAt,
      });
    });

  /**
   * Deliver every parked message on the thread, in order.
   *
   * No busy re-check between two messages: the provider's prompt queue is FIFO
   * (`ClaudeAdapter.ts` `sendTurn`), so back-to-back dispatches keep their
   * order, and re-checking would park the second message behind the turn the
   * first one just started.
   *
   * Stops at the first failure rather than skipping past it, so a message can
   * never overtake the one in front of it. The failed message stays queued.
   */
  const drainQueuedMessages = Effect.fn("drainQueuedMessages")(function* (threadId: ThreadId) {
    const thread = yield* readThreadDetail(threadId);
    if (thread === undefined) {
      return "empty" as const;
    }
    const queued = queuedMessagesOf(thread);
    if (queued.length === 0) {
      return "empty" as const;
    }
    for (const message of queued) {
      const delivered = yield* redeliver({ thread, message }).pipe(
        Effect.as(true),
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) {
            return Effect.failCause(cause);
          }
          return appendTurnStartFailure({
            threadId,
            detail: `Queued message '${message.id}' could not start a turn: ${Cause.pretty(cause)}`,
          }).pipe(Effect.as(false));
        }),
      );
      if (!delivered) {
        return "failed" as const;
      }
    }
    return "delivered" as const;
  });

  /**
   * Wait until the thread has no running turn.
   *
   * `ThreadSettleWatch.awaitTurnEnd` is the wrong tool here even though it looks
   * like the same wait: it holds until a turn has been *observed* active, so a
   * thread that is already idle when the message is queued — the projection can
   * settle between the decider's check and this poller's first read — would
   * never return. The test that matters is the decider's own, so gate and drain
   * agree on the word "busy": a running turn row, nothing else.
   */
  const awaitIdle = Effect.fn("awaitIdle")(function* (threadId: ThreadId) {
    const maxAttempts = Math.ceil(
      Duration.toMillis(QUEUED_DELIVERY_MAX_WAIT) /
        Duration.toMillis(QUEUED_DELIVERY_POLL_INTERVAL),
    );
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const shell = yield* readThreadShell(threadId);
      if (shell === undefined) {
        // Deleted, archived, or unreadable. Nothing left to deliver into.
        return "gone" as const;
      }
      if (shell.latestTurn === null || shell.latestTurn.state !== "running") {
        return "idle" as const;
      }
      yield* Effect.sleep(QUEUED_DELIVERY_POLL_INTERVAL);
    }
    return "timeout" as const;
  });

  const runPoller = Effect.fn("runPoller")(function* (threadId: ThreadId) {
    for (let attempt = 0; attempt < MAX_DELIVERY_ATTEMPTS; attempt += 1) {
      const waited = yield* awaitIdle(threadId);
      if (waited === "gone") {
        return;
      }
      if (waited === "timeout") {
        yield* Effect.logWarning("queued turn delivery gave up waiting for the turn to end", {
          threadId,
        });
        return;
      }
      const outcome = yield* drainQueuedMessages(threadId);
      if (outcome !== "failed") {
        return;
      }
      yield* Effect.sleep(DELIVERY_RETRY_DELAY);
    }
    // Capped on purpose: a thread whose dispatch keeps failing must not spin.
    // The messages stay queued and the next boot sweep tries again.
    yield* Effect.logWarning("queued turn delivery exhausted its retries", { threadId });
  });

  const startPoller = (threadId: ThreadId) =>
    Effect.gen(function* () {
      if (polling.has(threadId)) {
        return;
      }
      polling.add(threadId);
      const fiber = yield* Effect.forkScoped(
        runPoller(threadId).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.void
              : Effect.logWarning("queued turn delivery poller failed", {
                  threadId,
                  cause: Cause.pretty(cause),
                }),
          ),
          Effect.ensuring(
            Effect.sync(() => {
              polling.delete(threadId);
              pollerFibers.delete(threadId);
            }),
          ),
        ),
      );
      pollerFibers.set(threadId, fiber);
    });

  const processQueuedMessage = (event: MessageSentEvent) => startPoller(event.payload.threadId);

  const worker = yield* makeDrainableWorker(processQueuedMessage);

  /**
   * Fork a poller for every thread already holding a queued message.
   *
   * The restart guarantee. `streamDomainEvents` is live-only and nothing else
   * replays a pending delivery, so a message queued before the process died
   * would otherwise never move.
   */
  const sweepQueuedThreads = Effect.gen(function* () {
    const threadIds = yield* projectionSnapshotQuery.listThreadIdsWithQueuedMessages();
    if (threadIds.length === 0) {
      return;
    }
    yield* Effect.logInfo("queued turn delivery sweeping parked messages at boot", {
      threadCount: threadIds.length,
    });
    yield* Effect.forEach(threadIds, startPoller, { discard: true });
  }).pipe(
    // Total on purpose: `start` may not fail. A sweep that cannot read the
    // projection leaves every parked message where it is, which is the same
    // place a crash left it.
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.void
        : Effect.logWarning("queued turn delivery boot sweep failed", {
            cause: Cause.pretty(cause),
          }),
    ),
  );

  const start: QueuedTurnDeliveryReactorShape["start"] = Effect.fn("start")(function* () {
    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        if (event.type !== "thread.message-sent" || event.payload.deliveryState !== "queued") {
          return Effect.void;
        }
        return worker.enqueue(event);
      }),
    );
    yield* sweepQueuedThreads;
  });

  const drain: QueuedTurnDeliveryReactorShape["drain"] = worker.drain.pipe(
    Effect.flatMap(() =>
      Effect.forEach(Array.from(pollerFibers.values()), (fiber) => Fiber.await(fiber), {
        discard: true,
      }),
    ),
    Effect.ignoreCause(),
  );

  return { start, drain } satisfies QueuedTurnDeliveryReactorShape;
});

export const QueuedTurnDeliveryReactorLive = Layer.effect(QueuedTurnDeliveryReactor, make);
