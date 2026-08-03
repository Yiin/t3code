/**
 * ThreadSettleReactor - Thread settle teardown reactor service interface.
 *
 * Owns a background worker that reacts to `thread.settled` domain events and
 * ends the thread's provider session. Settling is the deliberate "I am done
 * with this thread" signal, so it is what tears the session down; the idle
 * reaper is only a backstop.
 *
 * @module ThreadSettleReactor
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

/**
 * ThreadSettleReactorShape - Service API for settle-driven session teardown.
 */
export interface ThreadSettleReactorShape {
  /**
   * Start reacting to thread.settled orchestration domain events.
   *
   * The returned effect must be run in a scope so all worker fibers can be
   * finalized on shutdown.
   */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;

  /**
   * Resolves when the internal processing queue is empty and idle.
   * Intended for test use to replace timing-sensitive sleeps.
   */
  readonly drain: Effect.Effect<void>;
}

/**
 * ThreadSettleReactor - Service tag for settle-driven session teardown.
 */
export class ThreadSettleReactor extends Context.Service<
  ThreadSettleReactor,
  ThreadSettleReactorShape
>()("t3/orchestration/Services/ThreadSettleReactor") {}
