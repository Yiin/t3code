/**
 * Host load pressure, and the wait that keeps a heavy gate off a busy machine.
 *
 * Run d7580b6c ran one gate command at one commit twice: 421s and exit 0 in the
 * main checkout, 1381469ms (23m01s) and exit 1 in the integration worktree.
 * Caught in the act, the host carried load average 29.92 on 16 cores, with 17
 * vitest processes belonging to other projects. Timing-sensitive tests fail
 * when starved of CPU, so a gate started on a loaded host reports a red gate
 * that says nothing about the code under test, and takes three times as long
 * to say it (t3code-z7x).
 *
 * The heavy gate lock in `adapters/ProcessGate.ts` only serialises t3code gates
 * against each other. Nothing makes one wait for another project's test run on
 * the same host, so the gate has to look at the host itself.
 *
 * The wait is bounded and never fails: a machine that stays busy gets its gate
 * anyway, with the load recorded, so a later failure can be attributed instead
 * of guessed at.
 */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { HostProcessCpuCount, HostProcessLoadAverage } from "@t3tools/shared/hostProcess";

/**
 * Load per core above which the host counts as contended.
 *
 * One runnable process per core is full use, not contention. The incident sat
 * at 1.87 per core and cost 3.3x. A normal epic run with a few workers of its
 * own sits well below 1.5, so this waits for foreign load rather than for the
 * run's own workers.
 */
export const HOST_CONTENTION_LOAD_PER_CPU = 1.5;

/** Resample this often while waiting. The 1-minute average moves slowly. */
export const DEFAULT_QUIET_HOST_POLL_SECONDS = 30;

/**
 * Give up waiting after this long and run anyway.
 *
 * Waiting out a foreign test suite is worth minutes, never the run. Past this
 * bound the gate is better spent than deferred.
 */
export const DEFAULT_QUIET_HOST_WAIT_SECONDS = 10 * 60;

export interface HostLoad {
  readonly loadAverage1m: number;
  readonly cpuCount: number;
  /** Runnable processes per core. 1 is full use; above 1 is queueing. */
  readonly loadPerCpu: number;
}

export interface QuietHostWait {
  readonly load: HostLoad;
  readonly waitedMs: number;
  /** False when the bound expired with the host still contended. */
  readonly quiet: boolean;
  readonly threshold: number;
}

const round = (value: number): number => Math.round(value * 100) / 100;

export const hostLoadPerCpu = (loadAverage1m: number, cpuCount: number): number =>
  round(loadAverage1m / Math.max(1, cpuCount));

export const sampleHostLoad: Effect.Effect<HostLoad> = Effect.gen(function* () {
  const readLoadAverage = yield* HostProcessLoadAverage;
  const cpuCount = yield* HostProcessCpuCount;
  const loadAverage1m = yield* Effect.sync(readLoadAverage);
  return {
    loadAverage1m: round(loadAverage1m),
    cpuCount,
    loadPerCpu: hostLoadPerCpu(loadAverage1m, cpuCount),
  };
});

export interface AwaitQuietHostOptions {
  readonly thresholdPerCpu?: number | undefined;
  readonly pollSeconds?: number | undefined;
  /** Zero waits not at all, and still reports the load it sampled. */
  readonly maxWaitSeconds?: number | undefined;
}

/**
 * Wait for the host to become quiet, up to a bound, then report what it found.
 *
 * Sampling once and sleeping the whole bound would be simpler and worse: the
 * point is to start the gate the moment the foreign load clears, not to wait
 * out a fixed penalty.
 */
export const awaitQuietHost = Effect.fn("hostContention.awaitQuietHost")(function* (
  options: AwaitQuietHostOptions = {},
) {
  const threshold = options.thresholdPerCpu ?? HOST_CONTENTION_LOAD_PER_CPU;
  // Clamped: a zero poll would spin the loop without sleeping. Use
  // `maxWaitSeconds: 0` to disable the wait.
  const pollMs = Math.max(1_000, (options.pollSeconds ?? DEFAULT_QUIET_HOST_POLL_SECONDS) * 1_000);
  const maxWaitMs = (options.maxWaitSeconds ?? DEFAULT_QUIET_HOST_WAIT_SECONDS) * 1_000;
  const startedAt = yield* Effect.clockWith((clock) => clock.currentTimeMillis);

  let load = yield* sampleHostLoad;
  let waitedMs = 0;
  while (load.loadPerCpu > threshold && waitedMs < maxWaitMs) {
    yield* Effect.logInfo("epic.gate.host-busy", {
      loadAverage1m: load.loadAverage1m,
      cpuCount: load.cpuCount,
      loadPerCpu: load.loadPerCpu,
      threshold,
      waitedMs,
      maxWaitMs,
    });
    yield* Effect.sleep(Duration.millis(Math.min(pollMs, maxWaitMs - waitedMs)));
    const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
    waitedMs = now - startedAt;
    load = yield* sampleHostLoad;
  }

  return {
    load,
    waitedMs,
    quiet: load.loadPerCpu <= threshold,
    threshold,
  } satisfies QuietHostWait;
});
