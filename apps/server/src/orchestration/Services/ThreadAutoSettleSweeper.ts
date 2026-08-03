/**
 * ThreadAutoSettleSweeper - Auto-settle sweeper service interface.
 *
 * Owns a background loop with two rules. It settles threads which have been
 * idle past the `threadAutoSettleAfterDays` server setting, and it settles
 * threads whose change request the VCS status cache already shows as merged.
 * Both used to be client-side display rules, so a thread could read as settled
 * while the server still held its provider session. Here they dispatch a real
 * `thread.settle` command, which means the settle reactor tears the session
 * down and the settled state survives with no client connected.
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
   * Start the periodic auto-settle sweep.
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
