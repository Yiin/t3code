/**
 * The production driver for the pure liveness machine in `workerLiveness.ts`.
 *
 * The machine decides and this module does everything else: it turns the
 * `ports/WorkerEvidence.ts` port into one `WorkerTickEvidence` per tick, runs
 * `tickWorkerLiveness` on the configured cadence, and performs the emitted
 * `WorkerLivenessAction`s. A confirmed stop is reported to the caller rather
 * than executed here, because the caller owns the worker's lifecycle: in
 * `ParallelEpicLoop` the stop is the existing interrupt-then-forced-stop path
 * an iteration timeout already takes.
 *
 * Nothing in here may change a verdict. The machine's conservatism — only a
 * high-confidence inspector verdict, confirmed twice against unchanged
 * fingerprints, ever stops a worker — is the design, so every failure mode
 * here degrades to "skip this tick", never to "stop the worker".
 */
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

import type {
  WorkerEvidenceError,
  WorkerEvidenceShape,
  WorkerRef,
} from "./ports/WorkerEvidence.ts";
import {
  DEFAULT_WORKER_LIVENESS_CONFIG,
  startWorkerLiveness,
  tickWorkerLiveness,
  type WorkerLivenessConfig,
  type WorkerLivenessEvent,
  type WorkerLivenessState,
  type WorkerLivenessTick,
  type WorkerSignalSample,
  type WorkerTickEvidence,
} from "./workerLiveness.ts";

/**
 * The supervision half of a run's resolved config.
 *
 * Declared structurally so `packages/contracts`' `SupervisionConfig` satisfies
 * it without `epic-core` importing the schema for one read.
 */
export interface SupervisionSettings {
  readonly idleThresholdSeconds: number;
  readonly inspectorTimeoutSeconds: number;
  readonly inspectMaxDelaySeconds: number;
  readonly inspectMinDelaySeconds: number;
  readonly inspectRetryDelaySeconds: number;
  readonly stopGraceSeconds: number;
  readonly workerTimeoutSeconds: number | null;
}

/** Harnesses that cannot enforce the inspector's no-tool contract. */
const INSPECTOR_UNSUPPORTED_DRIVERS = new Set<string>(["codex"]);

/**
 * Whether this run's harness may launch an idle inspector.
 *
 * Codex cannot deny tools to a subagent, so the machine records an uncertain
 * reason instead of launching (`workerLiveness.ts:52-56, 538-540`). Wiring
 * alone therefore does not stop a wedged Codex worker; that ceiling is
 * `t3code-77b`.
 */
export const inspectorSupportedFor = (driver: string): boolean =>
  !INSPECTOR_UNSUPPORTED_DRIVERS.has(driver);

/** Fold a run's supervision settings into the machine's config. */
export const makeWorkerLivenessConfig = (input: {
  readonly supervision: SupervisionSettings;
  readonly inspectorSupported: boolean;
}): WorkerLivenessConfig => ({
  ...DEFAULT_WORKER_LIVENESS_CONFIG,
  idleThresholdSeconds: input.supervision.idleThresholdSeconds,
  inspectorTimeoutSeconds: input.supervision.inspectorTimeoutSeconds,
  inspectMaxDelaySeconds: input.supervision.inspectMaxDelaySeconds,
  inspectMinDelaySeconds: input.supervision.inspectMinDelaySeconds,
  inspectRetryDelaySeconds: input.supervision.inspectRetryDelaySeconds,
  stopGraceSeconds: input.supervision.stopGraceSeconds,
  /**
   * Left off deliberately. `makePoolPolicy` already turns the same
   * `supervision.workerTimeoutSeconds` into the loop's `iterationTimeoutMs`,
   * so arming the machine's absolute deadline too would race the loop's own
   * timeout and report the same wall-clock cap twice.
   */
  workerTimeoutSeconds: null,
  inspectorSupported: input.inspectorSupported,
});

/**
 * The clock the tick cadence runs on.
 *
 * A seam, not a wrapper: tests drive supervision through many simulated hours
 * without waiting for them.
 */
export interface SupervisionClock {
  /** Wall clock in whole seconds; the machine's `now`. */
  readonly nowSeconds: Effect.Effect<number>;
  readonly sleepSeconds: (seconds: number) => Effect.Effect<void>;
}

export const systemSupervisionClock: SupervisionClock = {
  nowSeconds: Effect.map(Clock.currentTimeMillis, (millis) => Math.floor(millis / 1_000)),
  sleepSeconds: (seconds) => Effect.sleep(Duration.seconds(seconds)),
};

/** Render one machine event as a single log-and-mailbox line. */
export const workerLivenessEventDetail = (event: WorkerLivenessEvent): string => {
  switch (event.type) {
    case "worker-idle":
      return `idle for ${String(event.idleSeconds)}s of ${String(event.elapsedSeconds)}s elapsed`;
    case "inspection-started":
      return `inspecting with a ${String(event.timeoutSeconds)}s budget`;
    case "inspection-continue":
      return `continue: ${event.rationale} (next check in ${String(event.nextCheckSeconds)}s)`;
    case "inspection-uncertain":
      return `uncertain: ${event.reason} (next check in ${String(event.nextCheckSeconds)}s)`;
    case "inspection-stop-pending":
      return `stop pending confirmation: ${event.rationale} (next check in ${String(event.nextCheckSeconds)}s)`;
    case "inspection-stop":
      return `stop confirmed: ${event.rationale}`;
  }
};

/**
 * What a probe reads back while the driver is still discovering which probes
 * this tick needs. It can never reach a verdict: the pass that read it is
 * discarded and replayed once the real value is in hand.
 */
const PROBE_UNRESOLVED = "\u0000unresolved-probe";

/**
 * Two lazy probes, so two replays always suffice and a third pass is a bug.
 *
 * `WorkerTickEvidence` exposes `probeRepository` and `processFingerprint` as
 * synchronous thunks *and* the machine calls them only when a rule needs one,
 * so a quiet early tick pays for neither. Effect-based evidence cannot answer
 * synchronously, so the driver runs the pure tick with recording thunks,
 * resolves whatever the tick asked for, and re-runs it. `tickWorkerLiveness`
 * is pure, so replaying it is free of side effects, and memoizing within a
 * tick also matches the machine's assumption that two reads of the repository
 * probe inside one tick see one probe.
 */
const MAX_TICK_PASSES = 3;

/** The parts of a tick's evidence that do not need a probe. */
export type WorkerTickEvidenceBase = Omit<
  WorkerTickEvidence,
  "probeRepository" | "processFingerprint"
>;

export const tickWithLazyProbes = Effect.fn("tickWithLazyProbes")(function* (input: {
  readonly state: WorkerLivenessState;
  readonly base: WorkerTickEvidenceBase;
  readonly config: WorkerLivenessConfig;
  readonly probeRepository: Effect.Effect<string, WorkerEvidenceError>;
  readonly processFingerprint: Effect.Effect<string, WorkerEvidenceError>;
}): Effect.fn.Return<WorkerLivenessTick, WorkerEvidenceError> {
  let repository: string | null = null;
  let fingerprint: string | null = null;
  for (let pass = 0; pass < MAX_TICK_PASSES; pass += 1) {
    let repositoryDemanded = false;
    let fingerprintDemanded = false;
    const evidence: WorkerTickEvidence = {
      ...input.base,
      probeRepository: () => {
        if (repository !== null) return repository;
        repositoryDemanded = true;
        return PROBE_UNRESOLVED;
      },
      processFingerprint: () => {
        if (fingerprint !== null) return fingerprint;
        fingerprintDemanded = true;
        return PROBE_UNRESOLVED;
      },
    };
    const tick = tickWorkerLiveness(input.state, evidence, input.config);
    if (!repositoryDemanded && !fingerprintDemanded) return tick;
    if (repositoryDemanded) repository = yield* input.probeRepository;
    if (fingerprintDemanded) fingerprint = yield* input.processFingerprint;
  }
  // Unreachable while there are two probes. Skipping the tick is the safe
  // reading of "the driver did not converge": no state moves, nothing stops.
  yield* Effect.logError("epic.supervision.tick-did-not-converge", {
    worker: input.state.worker,
    passes: MAX_TICK_PASSES,
  });
  return { state: input.state, actions: [] };
});

/** Supervision only ever completes by confirming a stop. */
export interface WorkerSupervisionVerdict {
  readonly _tag: "stopped";
  readonly reason: string;
}

export interface WorkerSupervisionInput {
  /** Everything the evidence port needs to identify and reach this worker. */
  readonly ref: WorkerRef;
  /** The issue this worker is cooking, for the emitted events. */
  readonly child: string;
  readonly config: WorkerLivenessConfig;
  readonly evidence: WorkerEvidenceShape;
  /** Surfaces a machine event the way the loop's other run events surface. */
  readonly emit: (event: WorkerLivenessEvent) => Effect.Effect<void>;
  readonly clock?: SupervisionClock | undefined;
}

const BASELINE_SIGNALS: WorkerSignalSample = {
  isActive: true,
  outputBytes: 0,
  cpuUsec: 0,
  ioBytes: 0,
};

/**
 * Supervise one worker until the machine confirms it is dead.
 *
 * The returned effect never fails and, on a healthy worker, never completes —
 * the caller races it against the worker's own settlement and interrupts the
 * loser. Unreadable evidence skips the tick rather than failing supervision,
 * so a transient sampling error cannot take the run down and cannot stop a
 * worker either.
 */
export const superviseWorker = Effect.fn("superviseWorker")(function* (
  input: WorkerSupervisionInput,
): Effect.fn.Return<WorkerSupervisionVerdict> {
  const clock = input.clock ?? systemSupervisionClock;
  const evidence = input.evidence;
  const ref = input.ref;

  const skip = (operation: string) => (error: WorkerEvidenceError) =>
    Effect.logWarning("epic.supervision.evidence-unavailable", {
      worker: ref.worker,
      child: input.child,
      operation,
      detail: error.detail,
    });

  const firstSignals = yield* evidence
    .sampleSignals(ref)
    .pipe(Effect.catch((error) => Effect.as(skip("sampleSignals")(error), null)));
  const startedAt = yield* clock.nowSeconds;
  let state = startWorkerLiveness({
    worker: ref.worker,
    child: input.child,
    now: startedAt,
    signals: firstSignals ?? BASELINE_SIGNALS,
    config: input.config,
  });

  for (;;) {
    yield* clock.sleepSeconds(input.config.supervisionTickSeconds);

    const base: WorkerTickEvidenceBase | null = yield* Effect.gen(function* () {
      const now = yield* clock.nowSeconds;
      const signals = yield* evidence.sampleSignals(ref);
      const providerFallbackPending = yield* evidence.providerFallbackPending;
      const inspector = yield* evidence.inspectorStatus(ref);
      return { now, signals, providerFallbackPending, inspector };
    }).pipe(Effect.catch((error) => Effect.as(skip("sample")(error), null)));
    if (base === null) continue;

    const tick: WorkerLivenessTick | null = yield* tickWithLazyProbes({
      state,
      base,
      config: input.config,
      probeRepository: evidence.probeRepository(ref),
      processFingerprint: evidence.processFingerprint(ref),
    }).pipe(Effect.catch((error) => Effect.as(skip("probe")(error), null)));
    if (tick === null) continue;

    state = tick.state;

    for (const action of tick.actions) {
      switch (action._tag) {
        case "emit":
          yield* input.emit(action.event);
          break;
        case "launch-inspector":
          yield* evidence
            .launchInspector(ref, {
              timeoutSeconds: action.timeoutSeconds,
              evidence: action.evidence,
            })
            .pipe(Effect.catch(skip("launchInspector")));
          break;
        case "force-stop-inspector":
        case "worker-inactive":
          yield* evidence.stopInspector(ref).pipe(Effect.catch(skip("stopInspector")));
          break;
        case "stop-worker":
          yield* Effect.logWarning("epic.supervision.stop-worker", {
            worker: ref.worker,
            child: input.child,
            reason: action.reason,
          });
          return { _tag: "stopped", reason: action.reason };
      }
    }
  }
});
