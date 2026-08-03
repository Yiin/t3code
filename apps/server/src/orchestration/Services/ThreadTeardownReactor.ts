/**
 * ThreadTeardownReactor - Thread teardown reactor service interface.
 *
 * Owns a background worker that reacts to the domain events which end a thread's
 * life as a live workspace — `thread.settled` and `thread.archived` — and stops
 * the thread's provider session. Settling is the deliberate "I am done with this
 * thread" signal and archiving files it away; either way nobody types in it
 * again, so either one tears the session down. The idle reaper is only a
 * backstop.
 *
 * @module ThreadTeardownReactor
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

/**
 * ThreadTeardownReactorShape - Service API for event-driven session teardown.
 */
export interface ThreadTeardownReactorShape {
  /**
   * Start reacting to thread teardown orchestration domain events.
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
 * ThreadTeardownReactor - Service tag for event-driven session teardown.
 */
export class ThreadTeardownReactor extends Context.Service<
  ThreadTeardownReactor,
  ThreadTeardownReactorShape
>()("t3/orchestration/Services/ThreadTeardownReactor") {}
