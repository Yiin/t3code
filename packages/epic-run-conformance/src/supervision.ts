/**
 * The liveness evidence a `supervision` scenario runs against, shared by every
 * driver that can inject one.
 *
 * Only the platform sampling is fixed here. The machine, its cadence, the stop
 * decision and everything the loop does with the verdict are the shipped ones —
 * what a real run wires in its place reads cgroup counters this fixture has no
 * honest way to produce. The terminal leg needs none of this: it owns real
 * processes in real scopes, so it reads the same counters a live cook does.
 */
import type { WorkerEvidenceShape, WorkerRef } from "@t3tools/epic-core/ports/WorkerEvidence";
import type { SupervisionClock } from "@t3tools/epic-core/workerSupervision";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

/**
 * The `wedge-first-worker` evidence: the first worker reads as wedged, every
 * later one as busy.
 *
 * The wedged numbers are the 2026-08-09 incident's — no output, no CPU, no I/O,
 * an unchanged repository and an unchanged process histogram.
 */
export const wedgeFirstWorkerEvidence = (): WorkerEvidenceShape => {
  let wedgedWorker: string | null = null;
  let busyTicks = 0;
  const condemned = JSON.stringify({
    decision: "stop",
    confidence: "high",
    rationale: "every process is asleep and the repository has not changed",
  });
  const isWedged = (ref: WorkerRef): boolean => {
    wedgedWorker ??= ref.worker;
    return wedgedWorker === ref.worker;
  };
  return {
    inspectorSupported: true,
    sampleSignals: (ref) =>
      Effect.sync(() => {
        if (isWedged(ref)) return { isActive: true, outputBytes: 0, cpuUsec: 0, ioBytes: 0 };
        busyTicks += 1;
        // Strictly growing, so the machine never calls a healthy worker idle
        // and its supervision never completes.
        return {
          isActive: true,
          outputBytes: busyTicks * 4_096,
          cpuUsec: busyTicks * 1_000_000,
          ioBytes: busyTicks * 8_192,
        };
      }),
    probeRepository: (ref) =>
      Effect.succeed(isWedged(ref) ? "deadbeef hash=stable" : `hash=${String(busyTicks)}`),
    processFingerprint: (ref) =>
      Effect.succeed(isWedged(ref) ? "fingerprint-a" : `fingerprint-${String(busyTicks)}`),
    providerFallbackPending: Effect.succeed(false),
    launchInspector: () => Effect.void,
    inspectorStatus: () =>
      Effect.succeed({
        _tag: "finished",
        rc: 0,
        result: { text: condemned, byteSize: condemned.length, overflowed: false },
      }),
    stopInspector: () => Effect.void,
  };
};

/**
 * The supervision cadence's clock: counted, not waited out.
 *
 * A real idle window is half an hour; these ticks cost twenty milliseconds
 * each. The real sleep is not the wait — it is the yield. A healthy worker is
 * supervised for its whole turn, and at one millisecond that loop starved the
 * fixture agent it was watching until the run's own deadline killed it.
 */
export const compressedSupervisionClock = (): SupervisionClock => {
  let now = 0;
  return {
    nowSeconds: Effect.sync(() => now),
    sleepSeconds: (seconds) =>
      Effect.sleep(Duration.millis(20)).pipe(
        Effect.andThen(
          Effect.sync(() => {
            now += seconds;
          }),
        ),
      ),
  };
};

/**
 * The supervision settings a scenario runs under on a counted clock, so the
 * machine reaches its verdict in a handful of simulated minutes.
 *
 * The terminal leg cannot use these: it waits its seconds out, so it compresses
 * to the smallest values the config schema allows instead.
 */
export const COMPRESSED_SUPERVISION_SETTINGS = {
  idleThresholdSeconds: 30,
  inspectMinDelaySeconds: 5,
  inspectRetryDelaySeconds: 10,
} as const;
