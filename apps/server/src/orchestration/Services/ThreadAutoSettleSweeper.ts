/**
 * ThreadAutoSettleSweeper - Idle auto-settle sweeper service interface.
 *
 * Owns a background loop that settles threads which have been idle past the
 * `threadAutoSettleAfterDays` server setting. Auto-settle used to be a
 * client-side display rule, so a thread could read as settled while the server
 * still held its provider session. Here it dispatches a real `thread.settle`
 * command, which means the settle reactor tears the session down and the
 * settled state survives with no client connected.
 *
 * @module ThreadAutoSettleSweeper
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

/**
 * ThreadAutoSettleSweeperShape - Service API for idle auto-settle sweeps.
 */
export interface ThreadAutoSettleSweeperShape {
  /**
   * Start the periodic idle auto-settle sweep.
   *
   * The returned effect must be run in a scope so the sweep fiber is finalized
   * on shutdown.
   */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
}

/**
 * ThreadAutoSettleSweeper - Service tag for the idle auto-settle sweeper.
 */
export class ThreadAutoSettleSweeper extends Context.Service<
  ThreadAutoSettleSweeper,
  ThreadAutoSettleSweeperShape
>()("t3/orchestration/Services/ThreadAutoSettleSweeper") {}
