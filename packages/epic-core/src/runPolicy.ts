/**
 * Per-run loop policy for the parallel epic loop.
 *
 * The seed holds the layer-wide defaults. A persisted non-default run config
 * replaces each matching seed value when the loop freezes its policy, so a run
 * keeps the timing and budget it was launched with across restarts.
 */
import { hasEpicRunConfigValue } from "@t3tools/contracts";

import type { PersistedEpicRun } from "./ports/RunJournal.ts";

/** Loop-scheduler polling defaults shared by the server runner and the terminal cook. */
export const DEFAULT_POOL_POLL_INTERVAL_MS = 2_000;
export const DEFAULT_POOL_QUIET_PERIOD_MS = 1_000;
/**
 * How often the conflict radar trial-merges every active worker's branch
 * against the base branch (`ParallelEpicLoop.ts`).
 *
 * Three minutes because the probe is only worth what the worker can still do
 * with it: a conflict found in the first minutes of an hour-long iteration is
 * repaired by its own author, and one found at the merge queue is repaired by
 * a stranger. It costs one `git merge-tree` per worker per tick, which reads
 * objects only.
 */
export const DEFAULT_CONFLICT_PROBE_INTERVAL_MS = 3 * 60 * 1_000;

export interface PoolPolicySeed {
  readonly iterationTimeoutMs: number;
  /**
   * How long the run may make no progress before it is declared stalled
   * (`runStall.ts`). Layer-wide, not per-run: it bounds the scheduler, and a
   * scheduler that cannot move is never a property of the epic being run.
   */
  readonly runStallTimeoutMs: number;
  readonly pollIntervalMs: number;
  readonly quietPeriodMs: number;
  /**
   * The conflict radar's cadence. Layer-wide like `runStallTimeoutMs`, not
   * per-run: it bounds a background read, not the epic. `0` disables the radar
   * entirely, which is what a host with no merge queue wants.
   */
  readonly conflictProbeIntervalMs: number;
  readonly retryBaseDelayMs: number;
  readonly retryMaxDelayMs: number;
  readonly maxConsecutiveFailures: number;
  readonly maxNoCommitStreak: number;
  readonly infraFailureBudget: number;
  readonly subagentGraceTimeoutMs: number;
  readonly maxGraceContinuations: number;
}

export interface PoolPolicy extends Omit<PoolPolicySeed, "iterationTimeoutMs"> {
  /** `null` means the persisted run explicitly disabled the worker timeout. */
  readonly iterationTimeoutMs: number | null;
  readonly maxIterations: number;
  /** Per-child attempt budget, shared with the sequential loop. */
  readonly maxAttemptsPerChild: number;
}

/** Freeze all loop policy from the persisted row that starts this loop. */
export const makePoolPolicy = (seed: PoolPolicySeed, run: PersistedEpicRun): PoolPolicy => {
  const configured = <Value>(key: string, value: Value, fallback: Value): Value =>
    hasEpicRunConfigValue(run.configProvenance, key) ? value : fallback;
  const retryBaseDelayMs = configured(
    "server.retryBaseDelayMs",
    run.config.server.retryBaseDelayMs,
    seed.retryBaseDelayMs,
  );
  const retryMaxDelayMs = Math.max(
    retryBaseDelayMs,
    configured("server.retryMaxDelayMs", run.config.server.retryMaxDelayMs, seed.retryMaxDelayMs),
  );
  const configuredWorkerTimeout = hasEpicRunConfigValue(
    run.configProvenance,
    "supervision.workerTimeoutSeconds",
  )
    ? run.config.supervision.workerTimeoutSeconds
    : undefined;

  return Object.freeze({
    iterationTimeoutMs:
      configuredWorkerTimeout === undefined
        ? seed.iterationTimeoutMs
        : configuredWorkerTimeout === null
          ? null
          : configuredWorkerTimeout * 1_000,
    runStallTimeoutMs: seed.runStallTimeoutMs,
    pollIntervalMs: configured(
      "server.pollIntervalMs",
      run.config.server.pollIntervalMs,
      seed.pollIntervalMs,
    ),
    quietPeriodMs: configured(
      "server.quietPeriodMs",
      run.config.server.quietPeriodMs,
      seed.quietPeriodMs,
    ),
    conflictProbeIntervalMs: seed.conflictProbeIntervalMs,
    retryBaseDelayMs,
    retryMaxDelayMs,
    maxConsecutiveFailures: configured(
      "server.maxConsecutiveFailures",
      run.config.server.maxConsecutiveFailures,
      seed.maxConsecutiveFailures,
    ),
    maxNoCommitStreak: configured(
      "server.maxNoCommitStreak",
      run.config.server.maxNoCommitStreak,
      seed.maxNoCommitStreak,
    ),
    infraFailureBudget: configured(
      "server.infraFailureBudget",
      run.config.server.infraFailureBudget,
      seed.infraFailureBudget,
    ),
    subagentGraceTimeoutMs: configured(
      "server.subagentGraceTimeoutMs",
      run.config.server.subagentGraceTimeoutMs,
      seed.subagentGraceTimeoutMs,
    ),
    maxGraceContinuations: configured(
      "server.maxGraceContinuations",
      run.config.server.maxGraceContinuations,
      seed.maxGraceContinuations,
    ),
    maxIterations: configured(
      "limits.maxIterations",
      run.config.limits.maxIterations,
      run.maxIterations,
    ),
    maxAttemptsPerChild: configured(
      "limits.maxAttemptsPerChild",
      run.config.limits.maxAttemptsPerChild,
      run.config.limits.maxAttemptsPerChild,
    ),
  });
};
