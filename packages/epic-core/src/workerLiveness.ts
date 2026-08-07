/**
 * Per-worker liveness supervision as a pure state machine.
 *
 * Ported from the terminal coordinator (`skills/cook-epic/run.sh`,
 * `liveness_start` at run.sh:1876-1894 and `supervise_workers` at
 * run.sh:1909-1960). The machine never touches /proc, cgroups, git, or a
 * provider process: every platform fact arrives through `WorkerTickEvidence`
 * (gathered by `ports/WorkerEvidence.ts`) and every side effect leaves as a
 * `WorkerLivenessAction` for the driving adapter to perform.
 *
 * The conservatism is the design: sampling can only request an inspection,
 * and only a high-confidence inspector verdict, confirmed twice against
 * unchanged fingerprints and an unchanged progress generation, ever stops a
 * worker (run.sh:1280-1282).
 */

/** Every default cites its run.sh source line. */
export interface WorkerLivenessConfig {
  /** Absolute per-worker wall-clock cap; null means no deadline (run.sh:298). */
  readonly workerTimeoutSeconds: number | null;
  /** Idle seconds before the first inspection (run.sh:299). */
  readonly idleThresholdSeconds: number;
  /** Inspector wall-clock budget before a forced rc 124 (run.sh:300). */
  readonly inspectorTimeoutSeconds: number;
  /** Delay after an uncertain inspection (run.sh:301). */
  readonly inspectRetryDelaySeconds: number;
  /** Minimum delay between inspections (run.sh:302). */
  readonly inspectMinDelaySeconds: number;
  /** Maximum delay between inspections (run.sh:303). */
  readonly inspectMaxDelaySeconds: number;
  /** Stop escalation grace; the stop mechanism is adapter-owned (run.sh:304). */
  readonly stopGraceSeconds: number;
  /** Driver tick cadence (run.sh:305). */
  readonly supervisionTickSeconds: number;
  /** Quiet-tick repository probe interval (run.sh:306). */
  readonly repoProbeIntervalSeconds: number;
  /** Bounded probe timeout; the probe itself is port-owned (run.sh:307). */
  readonly repoProbeTimeoutSeconds: number;
  /** Worker artifact cap; the byte counter never truncates (run.sh:308). */
  readonly workerArtifactBytes: number;
  /** Inspector result byte cap (run.sh:309). */
  readonly inspectorResultBytes: number;
  /** Inspector raw-log byte cap; port-owned (run.sh:310). */
  readonly inspectorLogBytes: number;
  /** Repository evidence byte cap; port-owned (run.sh:311). */
  readonly repoEvidenceBytes: number;
  /** CPU delta that counts as progress (run.sh:312). */
  readonly cpuProgressUsec: number;
  /** IO delta that counts as progress (run.sh:313). */
  readonly ioProgressBytes: number;
  /**
   * false under Codex, which cannot enforce the no-tool contract and so never
   * launches an inspector (run.sh:1593-1596).
   */
  readonly inspectorSupported: boolean;
}

export const DEFAULT_WORKER_LIVENESS_CONFIG = {
  workerTimeoutSeconds: null,
  idleThresholdSeconds: 1800,
  inspectorTimeoutSeconds: 120,
  inspectRetryDelaySeconds: 300,
  inspectMinDelaySeconds: 60,
  inspectMaxDelaySeconds: 7200,
  stopGraceSeconds: 15,
  supervisionTickSeconds: 5,
  repoProbeIntervalSeconds: 60,
  repoProbeTimeoutSeconds: 2,
  workerArtifactBytes: 1048576,
  inspectorResultBytes: 4096,
  inspectorLogBytes: 32768,
  repoEvidenceBytes: 8192,
  cpuProgressUsec: 100000,
  ioProgressBytes: 4096,
  inspectorSupported: true,
} satisfies WorkerLivenessConfig;

/** The literal the bounded repository probe yields on timeout (run.sh:1398). */
export const REPO_PROBE_TIMEOUT_MARKER = "probe-timeout";
/** The fingerprint a worker with no live process reports (run.sh:1471). */
export const PROCESS_FINGERPRINT_UNAVAILABLE = "unavailable";

/** The uncertain reason recorded instead of launching under Codex (run.sh:1594). */
export const CODEX_INSPECTION_DISABLED_REASON =
  "Codex inspection is disabled because Codex cannot enforce the no-tool contract";

/**
 * Per-tick signals. `outputBytes` is the never-truncated cumulative counter
 * maintained by the output capture path — the rolling tail file is compacted,
 * the counter is not (run.sh:1112-1115).
 */
export interface WorkerSignalSample {
  readonly isActive: boolean;
  readonly outputBytes: number;
  readonly cpuUsec: number;
  readonly ioBytes: number;
}

/** The inspector result as captured by the bounded stream (run.sh:1522-1533). */
export interface InspectorResultEvidence {
  readonly text: string;
  readonly byteSize: number;
  /** The overflow marker exists once the result exceeded its cap (run.sh:1135). */
  readonly overflowed: boolean;
}

export type InspectorRunEvidence =
  | { readonly _tag: "none" }
  | { readonly _tag: "running" }
  | {
      readonly _tag: "finished";
      readonly rc: number;
      readonly result: InspectorResultEvidence;
    };

/**
 * Everything the machine may learn in one tick. The probes are lazy: the
 * machine calls each one only when a rule requires it, so a quiet early tick
 * never pays for a repository probe (run.sh:1934).
 */
export interface WorkerTickEvidence {
  /** Wall-clock seconds from the injected clock (run.sh:1283-1292). */
  readonly now: number;
  readonly providerFallbackPending: boolean;
  readonly signals: WorkerSignalSample;
  readonly inspector: InspectorRunEvidence;
  /** Bounded repository probe; contains `probe-timeout` on timeout (run.sh:1395-1406). */
  readonly probeRepository: () => string;
  /** sha256 of the process comm histogram, or `unavailable` (run.sh:1468-1481). */
  readonly processFingerprint: () => string;
}

export type WorkerLivenessEvent =
  | {
      readonly type: "worker-idle";
      readonly worker: string;
      readonly child: string;
      readonly idleSeconds: number;
      readonly elapsedSeconds: number;
    }
  | {
      readonly type: "inspection-started";
      readonly worker: string;
      readonly child: string;
      readonly timeoutSeconds: number;
    }
  | {
      readonly type: "inspection-continue";
      readonly worker: string;
      readonly child: string;
      readonly rationale: string;
      readonly nextCheckSeconds: number;
    }
  | {
      readonly type: "inspection-uncertain";
      readonly worker: string;
      readonly child: string;
      readonly reason: string;
      readonly nextCheckSeconds: number;
    }
  | {
      readonly type: "inspection-stop-pending";
      readonly worker: string;
      readonly child: string;
      readonly rationale: string;
      readonly nextCheckSeconds: number;
    }
  | {
      readonly type: "inspection-stop";
      readonly worker: string;
      readonly child: string;
      readonly rationale: string;
    };

/** Decisions the driving adapter must act on, in emission order. */
export type WorkerLivenessAction =
  /** Worker left its scope; the adapter reaps any in-flight inspector (run.sh:1914-1917). */
  | { readonly _tag: "worker-inactive" }
  | { readonly _tag: "stop-worker"; readonly reason: string }
  /** Inspector exceeded its budget; the adapter kills it and the machine reaps rc 124 (run.sh:1948-1951). */
  | { readonly _tag: "force-stop-inspector" }
  | { readonly _tag: "launch-inspector"; readonly timeoutSeconds: number }
  | { readonly _tag: "emit"; readonly event: WorkerLivenessEvent };

interface InspectorInFlight {
  readonly startedAt: number;
  /** Progress generation captured at launch (run.sh:1612). */
  readonly generation: number;
  readonly processFingerprint: string;
  readonly repoFingerprint: string;
}

interface PendingStop {
  readonly processFingerprint: string;
  readonly repoFingerprint: string;
  readonly generation: number;
}

export interface WorkerLivenessState {
  readonly worker: string;
  readonly child: string;
  readonly startedAt: number;
  readonly lastProgressAt: number;
  readonly lastOutputBytes: number;
  readonly lastCpuUsec: number;
  readonly lastIoBytes: number;
  /** Last observed repository hash; null until the first probe runs. */
  readonly repoHash: string | null;
  readonly nextInspectAt: number;
  readonly nextRepoProbeAt: number;
  /** Increments on every progress tick; makes a two-step stop safe (run.sh:1945). */
  readonly generation: number;
  readonly deadlineAt: number | null;
  readonly inspector: InspectorInFlight | null;
  readonly pendingStop: PendingStop | null;
}

export interface WorkerLivenessTick {
  readonly state: WorkerLivenessState;
  readonly actions: ReadonlyArray<WorkerLivenessAction>;
}

/** `liveness_start` (run.sh:1876-1894). */
export const startWorkerLiveness = (input: {
  readonly worker: string;
  readonly child: string;
  readonly now: number;
  readonly signals: WorkerSignalSample;
  readonly config: WorkerLivenessConfig;
}): WorkerLivenessState => ({
  worker: input.worker,
  child: input.child,
  startedAt: input.now,
  lastProgressAt: input.now,
  lastOutputBytes: input.signals.outputBytes,
  lastCpuUsec: input.signals.cpuUsec,
  lastIoBytes: input.signals.ioBytes,
  repoHash: null,
  nextInspectAt: input.now + input.config.idleThresholdSeconds,
  nextRepoProbeAt: input.now + input.config.repoProbeIntervalSeconds,
  generation: 0,
  deadlineAt:
    input.config.workerTimeoutSeconds === null
      ? null
      : input.now + input.config.workerTimeoutSeconds,
  inspector: null,
  pendingStop: null,
});

/**
 * `bounded_delay` (run.sh:1294-1300): a non-positive-integer request falls
 * back to the idle threshold, then clamps into [min, max].
 */
export const boundedInspectDelay = (
  requestedSeconds: number | null,
  config: WorkerLivenessConfig,
): number => {
  const base =
    requestedSeconds !== null && Number.isInteger(requestedSeconds) && requestedSeconds > 0
      ? requestedSeconds
      : config.idleThresholdSeconds;
  return Math.min(Math.max(base, config.inspectMinDelaySeconds), config.inspectMaxDelaySeconds);
};

export interface InspectorDecision {
  readonly decision: "continue" | "stop" | "uncertain";
  readonly confidence: "high" | "medium" | "low";
  readonly rationale: string;
  readonly nextCheckSeconds: number | null;
}

const INSPECTOR_RESULT_KEYS = new Set([
  "decision",
  "confidence",
  "rationale",
  "next_check_seconds",
]);

/**
 * `valid_inspector_decision` (run.sh:1629-1643). Every rule is required; any
 * violation rejects the result as malformed.
 */
export const parseInspectorDecision = (
  result: InspectorResultEvidence,
  config: WorkerLivenessConfig,
): InspectorDecision | null => {
  if (result.overflowed) return null; // run.sh:1630
  if (result.byteSize > config.inspectorResultBytes) return null; // run.sh:1631
  let value: unknown;
  try {
    value = JSON.parse(result.text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (!keys.every((key) => INSPECTOR_RESULT_KEYS.has(key))) return null; // run.sh:1635
  if (!("decision" in record) || !("confidence" in record) || !("rationale" in record)) {
    return null; // run.sh:1636
  }
  const { decision, confidence, rationale, next_check_seconds: nextCheck } = record;
  if (decision !== "continue" && decision !== "stop" && decision !== "uncertain") return null; // run.sh:1637
  if (confidence !== "high" && confidence !== "medium" && confidence !== "low") return null; // run.sh:1638
  if (typeof rationale !== "string" || !/\S/.test(rationale)) return null; // run.sh:1639
  if ([...rationale].length > 240) return null; // jq length counts codepoints (run.sh:1639)
  if (nextCheck !== undefined) {
    if (typeof nextCheck !== "number" || !Number.isInteger(nextCheck) || nextCheck <= 0) {
      return null; // run.sh:1640
    }
  }
  if (decision === "stop" && nextCheck !== undefined) return null; // run.sh:1641
  return {
    decision,
    confidence,
    rationale,
    nextCheckSeconds: typeof nextCheck === "number" ? nextCheck : null,
  };
};

const uncertainReason = (rc: number, config: WorkerLivenessConfig): string =>
  rc === 124
    ? `inspector timed out after ${config.inspectorTimeoutSeconds}s` // run.sh:1814
    : `inspector failed with rc=${rc}`; // run.sh:1815

/**
 * One supervision tick: `supervise_workers` for a single worker
 * (run.sh:1909-1960), with the inspector reap inlined from `reap_inspector`
 * (run.sh:1801-1874). Rule order is part of the parity contract.
 */
export const tickWorkerLiveness = (
  state: WorkerLivenessState,
  evidence: WorkerTickEvidence,
  config: WorkerLivenessConfig,
): WorkerLivenessTick => {
  const now = evidence.now;
  const actions: Array<WorkerLivenessAction> = [];
  const emit = (event: WorkerLivenessEvent) => {
    actions.push({ _tag: "emit", event });
  };

  // 1. Worker not active: clear inspector state and skip (run.sh:1914-1917).
  if (!evidence.signals.isActive) {
    const hadInspector = state.inspector !== null;
    return {
      state: { ...state, inspector: null, pendingStop: null },
      actions: hadInspector ? [{ _tag: "worker-inactive" }] : [],
    };
  }

  // 2. Absolute deadline (run.sh:1918-1923).
  if (state.deadlineAt !== null && now >= state.deadlineAt) {
    return {
      state,
      actions: [{ _tag: "stop-worker", reason: `timed out after ${config.workerTimeoutSeconds}s` }],
    };
  }

  // 3. Progress from signal deltas (run.sh:1924-1932).
  const outputDelta = evidence.signals.outputBytes - state.lastOutputBytes;
  const cpuDelta = evidence.signals.cpuUsec - state.lastCpuUsec;
  const ioDelta = evidence.signals.ioBytes - state.lastIoBytes;
  let progress =
    outputDelta > 0 || cpuDelta >= config.cpuProgressUsec || ioDelta >= config.ioProgressBytes;

  // 4. Bounded repository probe, only when quiet and due (run.sh:1933-1938).
  let repoHash = state.repoHash;
  let nextRepoProbeAt = state.nextRepoProbeAt;
  if (!progress && now >= nextRepoProbeAt) {
    const hash = evidence.probeRepository();
    if (repoHash !== null && hash !== repoHash) progress = true;
    repoHash = hash;
    nextRepoProbeAt = now + config.repoProbeIntervalSeconds;
  }

  let next: WorkerLivenessState = {
    ...state,
    lastOutputBytes: evidence.signals.outputBytes,
    lastCpuUsec: evidence.signals.cpuUsec,
    lastIoBytes: evidence.signals.ioBytes,
    repoHash,
    nextRepoProbeAt,
  };

  // 5. Progress clears a pending stop and bumps the generation (run.sh:1941-1946).
  if (progress) {
    next = {
      ...next,
      pendingStop: null,
      lastProgressAt: now,
      nextInspectAt: now + config.idleThresholdSeconds,
      generation: next.generation + 1,
    };
  }

  /** `inspection_uncertain` (run.sh:1790-1799). */
  const uncertain = (reason: string): WorkerLivenessState => {
    const delay = boundedInspectDelay(config.inspectRetryDelaySeconds, config);
    emit({
      type: "inspection-uncertain",
      worker: next.worker,
      child: next.child,
      reason,
      nextCheckSeconds: delay,
    });
    return { ...next, pendingStop: null, nextInspectAt: now + delay };
  };

  // 6. Inspector in flight: force rc 124 past its timeout, then reap (run.sh:1947-1954).
  if (next.inspector !== null) {
    const inspector = next.inspector;
    let finished: { readonly rc: number; readonly result: InspectorResultEvidence | null } | null =
      null;
    if (evidence.inspector._tag === "finished") {
      finished = { rc: evidence.inspector.rc, result: evidence.inspector.result };
    } else if (now - inspector.startedAt >= config.inspectorTimeoutSeconds) {
      actions.push({ _tag: "force-stop-inspector" }); // run.sh:1949-1950
      finished = { rc: 124, result: null };
    }
    if (finished === null) return { state: next, actions };

    next = { ...next, inspector: null };
    if (finished.rc !== 0) {
      return { state: uncertain(uncertainReason(finished.rc, config)), actions }; // run.sh:1813-1817
    }
    const parsed =
      finished.result === null ? null : parseInspectorDecision(finished.result, config);
    if (parsed === null) {
      return { state: uncertain("inspector returned malformed output"), actions }; // run.sh:1818-1821
    }

    if (parsed.decision === "stop" && parsed.confidence === "high") {
      // run.sh:1827-1862
      if (next.generation !== inspector.generation) {
        return {
          state: uncertain("worker made progress while inspection was running; stale stop ignored"),
          actions,
        }; // run.sh:1828-1831
      }
      const currentProcessFingerprint = evidence.processFingerprint();
      const currentRepoFingerprint = evidence.probeRepository();
      if (
        inspector.processFingerprint === PROCESS_FINGERPRINT_UNAVAILABLE ||
        inspector.repoFingerprint.includes(REPO_PROBE_TIMEOUT_MARKER) ||
        currentProcessFingerprint !== inspector.processFingerprint ||
        currentRepoFingerprint !== inspector.repoFingerprint
      ) {
        return {
          state: uncertain(
            "worker fingerprint changed during inspection; stop confirmation cleared",
          ),
          actions,
        }; // run.sh:1832-1838
      }
      const pending = next.pendingStop;
      const pendingMatches =
        pending !== null &&
        pending.processFingerprint === inspector.processFingerprint &&
        pending.repoFingerprint === inspector.repoFingerprint &&
        pending.generation === inspector.generation; // run.sh:1839-1844
      if (!pendingMatches) {
        const delay = boundedInspectDelay(config.inspectMinDelaySeconds, config); // run.sh:1849
        emit({
          type: "inspection-stop-pending",
          worker: next.worker,
          child: next.child,
          rationale: parsed.rationale,
          nextCheckSeconds: delay,
        });
        return {
          state: {
            ...next,
            nextInspectAt: now + delay,
            pendingStop: {
              processFingerprint: inspector.processFingerprint,
              repoFingerprint: inspector.repoFingerprint,
              generation: inspector.generation,
            },
          },
          actions,
        }; // run.sh:1845-1855
      }
      emit({
        type: "inspection-stop",
        worker: next.worker,
        child: next.child,
        rationale: parsed.rationale,
      });
      return {
        state: { ...next, pendingStop: null },
        actions: [
          ...actions,
          { _tag: "stop-worker", reason: `inspector requested stop: ${parsed.rationale}` },
        ],
      }; // run.sh:1856-1862
    }

    if (parsed.decision === "continue") {
      // run.sh:1863-1870
      const delay = boundedInspectDelay(parsed.nextCheckSeconds, config);
      emit({
        type: "inspection-continue",
        worker: next.worker,
        child: next.child,
        rationale: parsed.rationale,
        nextCheckSeconds: delay,
      });
      return {
        state: { ...next, pendingStop: null, nextInspectAt: now + delay },
        actions,
      };
    }

    // stop:medium, stop:low and uncertain:* all keep the worker alive (run.sh:1871).
    return {
      state: uncertain(
        `decision=${parsed.decision} confidence=${parsed.confidence}: ${parsed.rationale}`,
      ),
      actions,
    };
  }

  // 7. Launch one inspector when idle past the threshold (run.sh:1955-1958).
  const idle = now - next.lastProgressAt;
  if (
    !evidence.providerFallbackPending &&
    idle >= config.idleThresholdSeconds &&
    now >= next.nextInspectAt
  ) {
    emit({
      type: "worker-idle",
      worker: next.worker,
      child: next.child,
      idleSeconds: idle,
      elapsedSeconds: now - next.startedAt,
    }); // run.sh:1590-1592
    if (!config.inspectorSupported) {
      return { state: uncertain(CODEX_INSPECTION_DISABLED_REASON), actions }; // run.sh:1593-1596
    }
    next = {
      ...next,
      inspector: {
        startedAt: now,
        generation: next.generation,
        processFingerprint: evidence.processFingerprint(),
        repoFingerprint: evidence.probeRepository(),
      },
    }; // run.sh:1597-1598, 1611-1612
    actions.push({ _tag: "launch-inspector", timeoutSeconds: config.inspectorTimeoutSeconds });
    emit({
      type: "inspection-started",
      worker: next.worker,
      child: next.child,
      timeoutSeconds: config.inspectorTimeoutSeconds,
    }); // run.sh:1625-1626
  }

  return { state: next, actions };
};
