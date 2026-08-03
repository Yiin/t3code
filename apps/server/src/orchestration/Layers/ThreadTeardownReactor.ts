import type { OrchestrationEvent } from "@t3tools/contracts";
import { CommandId } from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  ThreadTeardownReactor,
  type ThreadTeardownReactorShape,
} from "../Services/ThreadTeardownReactor.ts";

/** The domain events that end a thread's life as a live workspace. */
const TEARDOWN_EVENT_TYPES = ["thread.settled", "thread.archived"] as const;

type TeardownEventType = (typeof TEARDOWN_EVENT_TYPES)[number];

type ThreadTeardownEvent = Extract<OrchestrationEvent, { type: TeardownEventType }>;

const isTeardownEvent = (event: OrchestrationEvent): event is ThreadTeardownEvent =>
  event.type === "thread.settled" || event.type === "thread.archived";

// The trigger is part of the command id so an operator reading the event log can
// tell a settle-driven stop from an archive-driven one.
const stopCommandIdPrefix: Record<TeardownEventType, string> = {
  "thread.settled": "session-stop-for-settle",
  "thread.archived": "session-stop-for-archive",
};

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;

  // Dispatch `thread.session.stop` instead of calling `ProviderService.stopSession`
  // directly. The thread lives on after settling or archiving, so its projected
  // session status has to stay truthful; only the command path writes it
  // (decider -> thread.session-stop-requested -> ProviderCommandReactor).
  //
  // The guard reads the session row, not the thread shell: `getThreadShellById`
  // hides archived threads, so it would report "nothing to stop" for every
  // archived thread. The session row has no archive state and is written only by
  // session events, so this read is also indifferent to whether the projection
  // has applied the teardown event yet.
  const processTeardownEvent = Effect.fn("processTeardownEvent")(function* (
    event: ThreadTeardownEvent,
  ) {
    const { threadId } = event.payload;
    const session = yield* projectionSnapshotQuery.getThreadSessionById(threadId);
    if (Option.isNone(session) || session.value.status === "stopped") {
      return;
    }

    yield* orchestrationEngine.dispatch({
      type: "thread.session.stop",
      commandId: CommandId.make(`${stopCommandIdPrefix[event.type]}:${threadId}:${event.sequence}`),
      threadId,
      createdAt: yield* nowIso,
    });
  });

  // ThreadDeletionReactor also swallows each cleanup step with
  // `logCleanupCauseUnlessInterrupted` so one failed step cannot skip the next.
  // This reactor has a single step and no later step to protect, and that helper
  // logs at debug. A teardown that silently fails to stop its session is the one
  // failure an operator must see, so every cause reaches the warning below and
  // only interrupts propagate.
  const processTeardownEventSafely = (event: ThreadTeardownEvent) =>
    processTeardownEvent(event).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("thread teardown reactor failed to process event", {
          eventType: event.type,
          threadId: event.payload.threadId,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processTeardownEventSafely);

  const start: ThreadTeardownReactorShape["start"] = Effect.fn("start")(function* () {
    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        if (!isTeardownEvent(event)) {
          return Effect.void;
        }
        return worker.enqueue(event);
      }),
    );
  });

  return {
    start,
    drain: worker.drain,
  } satisfies ThreadTeardownReactorShape;
});

export const ThreadTeardownReactorLive = Layer.effect(ThreadTeardownReactor, make);
