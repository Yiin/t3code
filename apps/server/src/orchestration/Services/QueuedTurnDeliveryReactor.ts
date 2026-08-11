/**
 * QueuedTurnDeliveryReactor - deliver turn-boundary messages once a turn ends.
 *
 * The decider parks a `thread.turn.start` whose caller asked for
 * `turn-boundary` delivery while the target thread is mid-turn: it writes the
 * message row with `deliveryState: "queued"` and no turn-start request. This
 * reactor is the other half. It watches for those rows, waits for the thread's
 * turn to end, then re-dispatches the same command with `delivery` omitted,
 * which flips the row to delivered and starts the turn through the untouched
 * `ProviderCommandReactor` path.
 *
 * Without it, a queued message sits forever.
 *
 * @module QueuedTurnDeliveryReactor
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

/**
 * QueuedTurnDeliveryReactorShape - Service API for queued-message delivery.
 */
export interface QueuedTurnDeliveryReactorShape {
  /**
   * Start watching for queued messages and sweep the ones already parked.
   *
   * The returned effect must be run in a scope so the watcher and every
   * per-thread poll fiber are finalized on shutdown.
   */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;

  /**
   * Resolves when every observed event has been routed AND every poll fiber
   * running right now has finished.
   *
   * Unlike the other reactors, this waits for the forked work too: the routing
   * step only forks a poller, so a drain that stopped there would prove
   * nothing about delivery. A caller that drains while a poller is asleep
   * waits out that sleep, so tests on a `TestClock` fork the drain and advance
   * the clock.
   */
  readonly drain: Effect.Effect<void>;
}

/**
 * QueuedTurnDeliveryReactor - Service tag for queued-message delivery.
 */
export class QueuedTurnDeliveryReactor extends Context.Service<
  QueuedTurnDeliveryReactor,
  QueuedTurnDeliveryReactorShape
>()("t3/orchestration/Services/QueuedTurnDeliveryReactor") {}
