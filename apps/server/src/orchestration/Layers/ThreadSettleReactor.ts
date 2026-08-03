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
  ThreadSettleReactor,
  type ThreadSettleReactorShape,
} from "../Services/ThreadSettleReactor.ts";

type ThreadSettledEvent = Extract<OrchestrationEvent, { type: "thread.settled" }>;

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;

  // Dispatch `thread.session.stop` instead of calling `ProviderService.stopSession`
  // directly. The thread lives on after settling, so its projected session status
  // has to stay truthful; only the command path writes it
  // (decider -> thread.session-stop-requested -> ProviderCommandReactor).
  const processThreadSettled = Effect.fn("processThreadSettled")(function* (
    event: ThreadSettledEvent,
  ) {
    const { threadId } = event.payload;
    const thread = yield* projectionSnapshotQuery.getThreadShellById(threadId);
    if (Option.isNone(thread)) {
      return;
    }

    const session = thread.value.session;
    if (session === null || session.status === "stopped") {
      return;
    }

    yield* orchestrationEngine.dispatch({
      type: "thread.session.stop",
      commandId: CommandId.make(`session-stop-for-settle:${threadId}:${event.sequence}`),
      threadId,
      createdAt: yield* nowIso,
    });
  });

  // ThreadDeletionReactor also swallows each cleanup step with
  // `logCleanupCauseUnlessInterrupted` so one failed step cannot skip the next.
  // This reactor has a single step and no later step to protect, and that helper
  // logs at debug. A settle that silently fails to stop its session is the one
  // failure an operator must see, so every cause reaches the warning below and
  // only interrupts propagate.
  const processThreadSettledSafely = (event: ThreadSettledEvent) =>
    processThreadSettled(event).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("thread settle reactor failed to process event", {
          eventType: event.type,
          threadId: event.payload.threadId,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processThreadSettledSafely);

  const start: ThreadSettleReactorShape["start"] = Effect.fn("start")(function* () {
    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        if (event.type !== "thread.settled") {
          return Effect.void;
        }
        return worker.enqueue(event);
      }),
    );
  });

  return {
    start,
    drain: worker.drain,
  } satisfies ThreadSettleReactorShape;
});

export const ThreadSettleReactorLive = Layer.effect(ThreadSettleReactor, make);
