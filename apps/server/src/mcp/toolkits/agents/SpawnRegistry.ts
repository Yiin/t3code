/**
 * SpawnRegistry - bind a thread-backed child's life to the parent turn waiting
 * on it, in both directions.
 *
 * `spawn_agent` blocks on a child that lives in another thread with another
 * provider session. Nothing else connects the two, so without this module each
 * side can strand the other: interrupting the parent leaves its children running
 * with no one to read them, and stopping a child from the drawer leaves the
 * parent polling until its 30-minute bound.
 *
 * The connection is process state, not persisted state, exactly like
 * `McpProviderSession`'s module-level map: it holds live `Effect`s belonging to
 * a running tool call, and a fiber does not survive a restart. Orphans left by a
 * restart are `t3code-vzb.19`'s job, not this module's.
 *
 * Three rules, and one deliberate non-rule:
 *
 * 1. The parent is interrupted or its session is stopped -> every registered
 *    child is interrupted and stopped, the parent's wait ends as `interrupted`,
 *    and the roster row closes as `stopped`.
 * 2. A child is stopped or interrupted from the drawer -> that one parent wait
 *    ends promptly, carrying whatever the child had said.
 * 3. The parent's MCP request is aborted -> **detach**. Deregister, stop
 *    mirroring, and leave the child running. Whether an abort even reaches the
 *    handler is unverified, and killing a child on an unproven signal is the
 *    worse failure.
 *
 * A child that dies on its own needs nothing here: the settle wait in
 * `handlers.ts` already sees it through the session-status path.
 *
 * Every cleanup dispatch is best-effort. A failed interrupt must not stop the
 * next child from being stopped, and must never escape into the tool call.
 *
 * @module agents/SpawnRegistry
 */
import { CommandId, type OrchestrationEvent, type ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { resolveFinalAssistantMessage } from "../../../orchestration/ThreadSettleWatch.ts";
import { appendChildSettled, type ChildMirrorTarget } from "./childMirror.ts";

/**
 * How far up the parent chain `spawnParentDepth` walks before giving up.
 *
 * The depth cap is 1, so a real chain is one or two hops. The bound only exists
 * so a corrupt link cannot spin.
 */
const MAX_DEPTH_WALK = 8;

/** How a parent's wait was ended from the outside. */
export interface SpawnWaiterOutcome {
  /**
   * `interrupted` when the parent went away, `stopped` when the child did. Both
   * read as `interrupted` in the tool result; the two words only differ in what
   * the note tells the model.
   */
  readonly status: "interrupted" | "stopped";
  /** Whatever the child had said by then, if anything. */
  readonly finalMessage: string | null;
}

/** One live `spawn_agent` call, from the outside. */
export interface SpawnRegistration {
  readonly parentThreadId: ThreadId;
  readonly childThreadId: ThreadId;
  /** Epoch milliseconds, for logs and for the reconciliation child later. */
  readonly startedAtMs: number;
  /** The parent's roster row for this child, so cleanup can close it. */
  readonly target: ChildMirrorTarget;
  /** Stop the child's session. Best-effort, never fails. */
  readonly cancel: Effect.Effect<void>;
  /** End the parent's wait with this outcome. Best-effort, never fails. */
  readonly complete: (outcome: SpawnWaiterOutcome) => Effect.Effect<void>;
}

const spawnsByParent = new Map<ThreadId, Map<ThreadId, SpawnRegistration>>();
/** The reverse index, so a child event and a depth walk are both O(1). */
const parentByChild = new Map<ThreadId, ThreadId>();

/** Record a spawn the moment its child's turn has been asked to start. */
export const registerSpawn = (registration: SpawnRegistration): void => {
  const existing = spawnsByParent.get(registration.parentThreadId);
  const children = existing ?? new Map<ThreadId, SpawnRegistration>();
  children.set(registration.childThreadId, registration);
  if (existing === undefined) spawnsByParent.set(registration.parentThreadId, children);
  parentByChild.set(registration.childThreadId, registration.parentThreadId);
};

/** Forget a spawn. Idempotent: every exit path calls it, including cleanup. */
export const deregisterSpawn = (parentThreadId: ThreadId, childThreadId: ThreadId): void => {
  const children = spawnsByParent.get(parentThreadId);
  if (children !== undefined) {
    children.delete(childThreadId);
    if (children.size === 0) spawnsByParent.delete(parentThreadId);
  }
  if (parentByChild.get(childThreadId) === parentThreadId) parentByChild.delete(childThreadId);
};

/** The registrations of one parent, snapshotted so cleanup can mutate the map. */
export const listSpawnsOfParent = (parentThreadId: ThreadId): ReadonlyArray<SpawnRegistration> => [
  ...(spawnsByParent.get(parentThreadId)?.values() ?? []),
];

export const findSpawnByChild = (childThreadId: ThreadId): SpawnRegistration | undefined => {
  const parentThreadId = parentByChild.get(childThreadId);
  return parentThreadId === undefined
    ? undefined
    : spawnsByParent.get(parentThreadId)?.get(childThreadId);
};

/**
 * How many thread-backed children this parent is waiting on right now.
 *
 * This, not the projection, is what `decideSpawn` caps. The cap bounds the waits
 * a parent holds open, so it must fall on every way a wait can end — including a
 * timeout, where the child keeps running but the parent has explicitly carried
 * on without it, and a detach, where nothing is watching the child any more.
 * Counting a child the parent already stopped waiting for would spend its whole
 * budget on work it can no longer see.
 */
export const liveChildCount = (parentThreadId: ThreadId): number =>
  spawnsByParent.get(parentThreadId)?.size ?? 0;

/** 0 for a top-level thread, +1 for each thread-backed ancestor still live. */
export const spawnParentDepth = (threadId: ThreadId): number => {
  let depth = 0;
  let current = parentByChild.get(threadId);
  while (current !== undefined && depth < MAX_DEPTH_WALK) {
    depth += 1;
    current = parentByChild.get(current);
  }
  return depth;
};

/** Drop every registration. For tests, and for a full process teardown. */
export const clearAllSpawns = (): void => {
  spawnsByParent.clear();
  parentByChild.clear();
};

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

/**
 * Run one cleanup step, logging any failure rather than skipping the next.
 *
 * The failure channel is erased on purpose: a registration's `cancel` and
 * `complete` are held by whoever cancels, and a cleanup path that can fail is a
 * cleanup path that can strand the other half of the pair. Interruption still
 * propagates, so a cancelling fiber stays killable.
 */
const bestEffort = <E, R>(
  step: Effect.Effect<void, E, R>,
  context: Record<string, unknown>,
): Effect.Effect<void, never, R> =>
  step.pipe(
    Effect.asVoid,
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : Effect.logWarning("subagent.spawn.cleanup-failed", {
            ...context,
            cause: Cause.pretty(cause),
          }),
    ),
  );

/**
 * Stop every child of an interrupted or stopped parent.
 *
 * The registration is dropped *before* its child is stopped. The stop dispatch
 * emits the very events this module reacts to, and an entry that is already gone
 * makes the child-side rule a no-op instead of a second pass over the same
 * child.
 */
export const cancelSpawnsOfParent = Effect.fn("SpawnRegistry.cancelSpawnsOfParent")(function* (
  parentThreadId: ThreadId,
  reason: string,
) {
  const registrations = listSpawnsOfParent(parentThreadId);
  if (registrations.length === 0) return;
  yield* Effect.logInfo("subagent.spawn.parent-cancelled", {
    parentThreadId,
    reason,
    childCount: registrations.length,
  });
  for (const registration of registrations) {
    deregisterSpawn(parentThreadId, registration.childThreadId);
    yield* bestEffort(registration.cancel, {
      parentThreadId,
      childThreadId: registration.childThreadId,
      step: "cancel",
    });
    // The roster row is closed here rather than left to the parent's own mirror:
    // the parent's fiber may be dying with the same interrupt, and the row must
    // not stay open claiming a subagent that is gone. Both paths reuse one
    // activity id and one command id, so whichever lands first wins and the
    // other is deduplicated away.
    yield* appendChildSettled(registration.target, { _tag: "settled", status: "stopped" });
    yield* bestEffort(registration.complete({ status: "interrupted", finalMessage: null }), {
      parentThreadId,
      childThreadId: registration.childThreadId,
      step: "complete",
    });
  }
});

/**
 * End the parent's wait when its child was stopped from the drawer.
 *
 * The child's session is already being stopped by the command that brought us
 * here, so this only reads what it managed to say and hands that back.
 */
export const completeSpawnForStoppedChild = Effect.fn("SpawnRegistry.completeSpawnForStoppedChild")(
  function* (childThreadId: ThreadId, reason: string) {
    const registration = findSpawnByChild(childThreadId);
    if (registration === undefined) return;
    deregisterSpawn(registration.parentThreadId, childThreadId);
    const projection = yield* ProjectionSnapshotQuery;
    const child = yield* projection.getThreadDetailById(childThreadId).pipe(
      Effect.map(Option.getOrUndefined),
      Effect.catchCause((cause) =>
        Effect.logWarning("subagent.spawn.child-read-failed", {
          childThreadId,
          cause: Cause.pretty(cause),
        }).pipe(Effect.as(undefined)),
      ),
    );
    const finalMessage = resolveFinalAssistantMessage(child)?.text ?? null;
    yield* Effect.logInfo("subagent.spawn.child-stopped", {
      parentThreadId: registration.parentThreadId,
      childThreadId,
      reason,
    });
    yield* bestEffort(registration.complete({ status: "stopped", finalMessage }), {
      parentThreadId: registration.parentThreadId,
      childThreadId,
      step: "complete",
    });
  },
);

/** The commands one parent-side cancellation dispatches against a child. */
export const cancelChildCommands = (childThreadId: ThreadId, createdAt: string) =>
  [
    {
      type: "thread.turn.interrupt" as const,
      commandId: CommandId.make(`server:spawn-cancel-interrupt:${childThreadId}`),
      threadId: childThreadId,
      createdAt,
    },
    {
      // No `preserveRunningSubagents`: a forced stop is right here. The guard at
      // `decider.ts` exists so normal EpicRunner cleanup cannot cut a live
      // subagent tree, and this path is the cancellation it is guarding for.
      type: "thread.session.stop" as const,
      commandId: CommandId.make(`server:spawn-cancel-stop:${childThreadId}`),
      threadId: childThreadId,
      createdAt,
      reason: "parent turn cancelled",
    },
  ] as const;

/**
 * Build the `cancel` effect for one registration.
 *
 * Kept here rather than in `handlers.ts` so the two dispatches and their command
 * ids live beside the rule that fires them.
 */
export const makeCancelChild = (
  childThreadId: ThreadId,
): Effect.Effect<void, never, OrchestrationEngineService> =>
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    const createdAt = yield* nowIso;
    for (const command of cancelChildCommands(childThreadId, createdAt)) {
      yield* bestEffort(engine.dispatch(command).pipe(Effect.asVoid), {
        childThreadId,
        commandType: command.type,
      });
    }
  });

/** The two events that mean "this thread was cancelled", either side of the pair. */
type SpawnCancellationEvent = Extract<
  OrchestrationEvent,
  { readonly type: "thread.turn-interrupt-requested" | "thread.session-stop-requested" }
>;

const isCancellationEvent = (event: OrchestrationEvent): event is SpawnCancellationEvent =>
  event.type === "thread.turn-interrupt-requested" ||
  event.type === "thread.session-stop-requested";

/**
 * React to one cancellation event, on both sides of the parent/child pair.
 *
 * A thread can in principle be both, so both branches run. The parent branch
 * runs first: it deregisters its children, which is what keeps the child branch
 * from firing a second time for a child this parent just stopped.
 */
export const applyCancellationEvent = Effect.fn("SpawnRegistry.applyCancellationEvent")(function* (
  threadId: ThreadId,
  eventType: string,
) {
  yield* cancelSpawnsOfParent(threadId, eventType);
  yield* completeSpawnForStoppedChild(threadId, eventType);
});

/**
 * Watch the domain event stream for cancellations on either side.
 *
 * Its own forked subscription on purpose. `ProviderCommandReactor` drains
 * globally on one fiber, so folding these cases into it would queue a parent's
 * cancellation behind whatever provider work is in flight — which is exactly the
 * work being cancelled.
 */
export const watchSpawnCancellations = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  yield* Effect.forkScoped(
    Stream.runForEach(engine.streamDomainEvents, (event) =>
      isCancellationEvent(event)
        ? applyCancellationEvent(event.payload.threadId, event.type).pipe(
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.failCause(cause)
                : Effect.logWarning("subagent.spawn.cancellation-watch-failed", {
                    eventType: event.type,
                    cause: Cause.pretty(cause),
                  }),
            ),
          )
        : Effect.void,
    ),
  );
});

export const SpawnCancellationWatchLive = Layer.effectDiscard(watchSpawnCancellations);
