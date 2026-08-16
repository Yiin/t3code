import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import * as Effect from "effect/Effect";

import type {
  WorkerEvidenceError,
  WorkerEvidenceShape,
  WorkerRef,
} from "./ports/WorkerEvidence.ts";
import { WorkerLivenessStage } from "./ports/RunEvents.ts";
import type { InspectorLaunchEvidence } from "./inspectorPrompt.ts";
import {
  DEFAULT_WORKER_LIVENESS_CONFIG,
  startWorkerLiveness,
  type InspectorRunEvidence,
  type WorkerLivenessConfig,
  type WorkerLivenessEvent,
  type WorkerSignalSample,
} from "./workerLiveness.ts";
import {
  inspectorSupportedFor,
  makeWorkerLivenessConfig,
  superviseWorker,
  tickWithLazyProbes,
  workerLivenessEventDetail,
  type SupervisionClock,
} from "./workerSupervision.ts";

const REF: WorkerRef = { worker: "thread-1", repositoryPath: "/repo" };

/**
 * Short windows so a scripted run reaches a confirmed stop in a handful of
 * ticks. Every relationship the machine depends on is preserved: the idle
 * threshold is many ticks wide and the re-inspect delay is one tick.
 */
const CONFIG: WorkerLivenessConfig = {
  ...DEFAULT_WORKER_LIVENESS_CONFIG,
  idleThresholdSeconds: 30,
  supervisionTickSeconds: 5,
  inspectMinDelaySeconds: 5,
  inspectRetryDelaySeconds: 10,
  repoProbeIntervalSeconds: 1_000,
};

const SIGNALS: WorkerSignalSample = {
  isActive: true,
  outputBytes: 0,
  cpuUsec: 0,
  ioBytes: 0,
};

const stopDecision = (): InspectorRunEvidence => {
  const text = JSON.stringify({
    decision: "stop",
    confidence: "high",
    rationale: "no process has moved in 30 minutes",
  });
  return { _tag: "finished", rc: 0, result: { text, byteSize: text.length, overflowed: false } };
};

interface Counters {
  repositoryProbes: number;
  fingerprints: number;
  launches: number;
  stops: number;
  samples: number;
  /** Everything the driver handed the evidence port on each launch. */
  launchInputs: Array<{ timeoutSeconds: number; evidence: InspectorLaunchEvidence }>;
}

interface FakeEvidenceInput {
  readonly signalsAt?: (sample: number) => Partial<WorkerSignalSample>;
  readonly inspector?: InspectorRunEvidence;
  readonly repositoryHash?: string;
  readonly failSampleAfter?: number;
}

const fakeEvidence = (
  input: FakeEvidenceInput = {},
): { readonly evidence: WorkerEvidenceShape; readonly counters: Counters } => {
  const counters: Counters = {
    repositoryProbes: 0,
    fingerprints: 0,
    launches: 0,
    stops: 0,
    samples: 0,
    launchInputs: [],
  };
  const evidence: WorkerEvidenceShape = {
    inspectorSupported: true,
    sampleSignals: () =>
      Effect.suspend(() => {
        counters.samples += 1;
        if (input.failSampleAfter !== undefined && counters.samples > input.failSampleAfter) {
          return Effect.fail({
            _tag: "WorkerEvidenceError",
            operation: "sampleSignals",
            detail: "cgroup vanished",
          } as unknown as WorkerEvidenceError);
        }
        return Effect.succeed({ ...SIGNALS, ...input.signalsAt?.(counters.samples) });
      }),
    probeRepository: () =>
      Effect.sync(() => {
        counters.repositoryProbes += 1;
        return input.repositoryHash ?? "abc123 hash=stable";
      }),
    processFingerprint: () =>
      Effect.sync(() => {
        counters.fingerprints += 1;
        return "fingerprint-a";
      }),
    providerFallbackPending: Effect.succeed(false),
    launchInspector: (_ref, launch) =>
      Effect.sync(() => {
        counters.launches += 1;
        counters.launchInputs.push(launch);
      }),
    inspectorStatus: () => Effect.succeed(input.inspector ?? { _tag: "none" }),
    stopInspector: () =>
      Effect.sync(() => {
        counters.stops += 1;
      }),
  };
  return { evidence, counters };
};

/**
 * A clock that advances one tick per sleep and never waits.
 *
 * After `budget` sleeps it interrupts the fiber, which is how a test says
 * "supervision was still running and had not stopped anything".
 */
const fakeClock = (input: { readonly budget: number }): SupervisionClock => {
  let now = 0;
  let sleeps = 0;
  return {
    nowSeconds: Effect.sync(() => now),
    sleepSeconds: (seconds) =>
      Effect.suspend(() => {
        sleeps += 1;
        if (sleeps > input.budget) return Effect.interrupt;
        now += seconds;
        return Effect.void;
      }),
  };
};

const collect = (): {
  readonly events: Array<WorkerLivenessEvent>;
  readonly emit: (event: WorkerLivenessEvent) => Effect.Effect<void>;
} => {
  const events: Array<WorkerLivenessEvent> = [];
  return {
    events,
    emit: (event) =>
      Effect.sync(() => {
        events.push(event);
      }),
  };
};

describe("makeWorkerLivenessConfig", () => {
  it("folds a run's supervision settings into the machine's config", () => {
    const config = makeWorkerLivenessConfig({
      supervision: {
        idleThresholdSeconds: 60,
        inspectorTimeoutSeconds: 90,
        inspectMaxDelaySeconds: 600,
        inspectMinDelaySeconds: 30,
        inspectRetryDelaySeconds: 120,
        supervisionTickSeconds: 15,
        stopGraceSeconds: 20,
        workerTimeoutSeconds: 7_200,
        uncertainStopCeiling: 8,
      },
      inspectorSupported: true,
    });
    expect(config.uncertainStopCeiling).toBe(8);
    expect(config.idleThresholdSeconds).toBe(60);
    expect(config.inspectorTimeoutSeconds).toBe(90);
    expect(config.inspectMaxDelaySeconds).toBe(600);
    expect(config.inspectMinDelaySeconds).toBe(30);
    expect(config.inspectRetryDelaySeconds).toBe(120);
    expect(config.supervisionTickSeconds).toBe(15);
  });

  it("leaves the machine's absolute deadline off, because the loop owns it", () => {
    const config = makeWorkerLivenessConfig({
      supervision: {
        ...DEFAULT_WORKER_LIVENESS_CONFIG,
        stopGraceSeconds: 20,
        workerTimeoutSeconds: 3_600,
      },
      inspectorSupported: true,
    });
    expect(config.workerTimeoutSeconds).toBeNull();
  });

  it("carries the harness's inspector support through", () => {
    expect(inspectorSupportedFor("codex")).toBe(false);
    expect(inspectorSupportedFor("claude")).toBe(true);
    expect(
      makeWorkerLivenessConfig({
        supervision: { ...DEFAULT_WORKER_LIVENESS_CONFIG, stopGraceSeconds: 15 },
        inspectorSupported: inspectorSupportedFor("codex"),
      }).inspectorSupported,
    ).toBe(false);
  });
});

describe("workerLivenessEventDetail", () => {
  it("renders every stage the run event schema accepts", () => {
    const stages: ReadonlyArray<WorkerLivenessEvent["type"]> = WorkerLivenessStage.literals;
    expect([...stages].toSorted()).toEqual(
      [
        "inspection-continue",
        "inspection-started",
        "inspection-stop",
        "inspection-stop-pending",
        "inspection-uncertain",
        "worker-idle",
      ].toSorted(),
    );
    expect(
      workerLivenessEventDetail({
        type: "worker-idle",
        worker: "w",
        child: "c",
        idleSeconds: 1_800,
        elapsedSeconds: 3_600,
      }),
    ).toBe("idle for 1800s of 3600s elapsed");
  });
});

describe("tickWithLazyProbes", () => {
  it.effect("pays for no probe on a quiet early tick", () =>
    Effect.gen(function* () {
      const { evidence, counters } = fakeEvidence();
      const state = startWorkerLiveness({
        worker: REF.worker,
        child: "c1",
        now: 0,
        signals: SIGNALS,
        config: CONFIG,
      });
      yield* tickWithLazyProbes({
        state,
        base: {
          now: 5,
          providerFallbackPending: false,
          signals: SIGNALS,
          inspector: { _tag: "none" },
        },
        config: CONFIG,
        probeRepository: evidence.probeRepository(REF),
        processFingerprint: evidence.processFingerprint(REF),
      });
      expect(counters.repositoryProbes).toBe(0);
      expect(counters.fingerprints).toBe(0);
    }),
  );

  it.effect("resolves a demanded probe exactly once per tick", () =>
    Effect.gen(function* () {
      const { evidence, counters } = fakeEvidence();
      const config: WorkerLivenessConfig = { ...CONFIG, repoProbeIntervalSeconds: 5 };
      const state = startWorkerLiveness({
        worker: REF.worker,
        child: "c1",
        now: 0,
        signals: SIGNALS,
        config,
      });
      const tick = yield* tickWithLazyProbes({
        state,
        base: {
          now: 5,
          providerFallbackPending: false,
          signals: SIGNALS,
          inspector: { _tag: "none" },
        },
        config,
        probeRepository: evidence.probeRepository(REF),
        processFingerprint: evidence.processFingerprint(REF),
      });
      expect(counters.repositoryProbes).toBe(1);
      expect(tick.state.repoHash).toBe("abc123 hash=stable");
    }),
  );
});

describe("superviseWorker", () => {
  it.effect("stops a worker the inspector condemns twice against unchanged fingerprints", () =>
    Effect.gen(function* () {
      const { evidence, counters } = fakeEvidence({ inspector: stopDecision() });
      const { events, emit } = collect();
      const verdict = yield* superviseWorker({
        ref: REF,
        child: "epic.6",
        config: CONFIG,
        evidence,
        emit,
        clock: fakeClock({ budget: 40 }),
      });
      expect(verdict._tag).toBe("stopped");
      expect(verdict.reason).toContain("inspector requested stop");
      expect(verdict.reason).toContain("no process has moved in 30 minutes");
      // Two inspections: the first only arms a pending stop, the second
      // confirms it against the same fingerprints and generation.
      expect(counters.launches).toBe(2);
      expect(events.map((event) => event.type)).toEqual([
        "worker-idle",
        "inspection-started",
        "inspection-stop-pending",
        "worker-idle",
        "inspection-started",
        "inspection-stop",
      ]);
    }),
  );

  it.effect("never stops a worker whose CPU keeps moving", () =>
    Effect.gen(function* () {
      const { evidence, counters } = fakeEvidence({
        inspector: stopDecision(),
        signalsAt: (sample) => ({ cpuUsec: sample * 1_000_000 }),
      });
      const { events, emit } = collect();
      const exit = yield* Effect.exit(
        superviseWorker({
          ref: REF,
          child: "epic.6",
          config: CONFIG,
          evidence,
          emit,
          clock: fakeClock({ budget: 40 }),
        }),
      );
      expect(exit._tag).toBe("Failure");
      expect(counters.launches).toBe(0);
      expect(events).toEqual([]);
    }),
  );

  it.effect("stops a worker whose harness cannot run an inspector at the ceiling", () =>
    Effect.gen(function* () {
      const { evidence, counters } = fakeEvidence({ inspector: stopDecision() });
      const { events, emit } = collect();
      const verdict = yield* superviseWorker({
        ref: REF,
        child: "epic.6",
        config: { ...CONFIG, inspectorSupported: false, uncertainStopCeiling: 3 },
        evidence,
        emit,
        clock: fakeClock({ budget: 40 }),
      });
      // No inspector ever runs, so the evidence itself is the confirmation.
      expect(counters.launches).toBe(0);
      expect(verdict.reason).toContain("no inspector on this harness");
      expect(verdict.reason).toContain("across 3 checks");
      expect(verdict.reason).toContain("fingerprint-a");
      expect(events.filter((event) => event.type === "inspection-uncertain")).toHaveLength(2);
      expect(events.map((event) => event.type).at(-1)).toBe("inspection-stop");
    }),
  );

  it.effect("never stops a worker whose harness has no inspector and no ceiling", () =>
    Effect.gen(function* () {
      const { evidence, counters } = fakeEvidence({ inspector: stopDecision() });
      const { events, emit } = collect();
      const exit = yield* Effect.exit(
        superviseWorker({
          ref: REF,
          child: "epic.6",
          config: { ...CONFIG, inspectorSupported: false, uncertainStopCeiling: null },
          evidence,
          emit,
          clock: fakeClock({ budget: 40 }),
        }),
      );
      expect(exit._tag).toBe("Failure");
      expect(counters.launches).toBe(0);
      expect(events.map((event) => event.type)).toContain("worker-idle");
      expect(events.map((event) => event.type)).toContain("inspection-uncertain");
    }),
  );

  it.effect("skips a tick with unreadable evidence instead of stopping the worker", () =>
    Effect.gen(function* () {
      const { evidence, counters } = fakeEvidence({
        inspector: stopDecision(),
        failSampleAfter: 1,
      });
      const { events, emit } = collect();
      const exit = yield* Effect.exit(
        superviseWorker({
          ref: REF,
          child: "epic.6",
          config: CONFIG,
          evidence,
          emit,
          clock: fakeClock({ budget: 20 }),
        }),
      );
      expect(exit._tag).toBe("Failure");
      expect(counters.launches).toBe(0);
      expect(events).toEqual([]);
    }),
  );

  it.effect("hands the evidence port the machine's own structural snapshot", () =>
    Effect.gen(function* () {
      const { evidence, counters } = fakeEvidence();
      const { emit } = collect();
      yield* Effect.exit(
        superviseWorker({
          ref: REF,
          child: "epic.7",
          config: CONFIG,
          evidence,
          emit,
          clock: fakeClock({ budget: 8 }),
        }),
      );
      const launch = counters.launchInputs[0];
      expect(launch?.timeoutSeconds).toBe(CONFIG.inspectorTimeoutSeconds);
      // The prompt renders from these, so they must be the same values the
      // machine will judge the inspector's answer against.
      expect(launch?.evidence).toEqual({
        worker: REF.worker,
        child: "epic.7",
        elapsedSeconds: 30,
        idleSeconds: 30,
        outputBytes: 0,
        outputBytesDelta: 0,
        cpuUsecDelta: 0,
        ioBytesDelta: 0,
        processFingerprint: "fingerprint-a",
        repoFingerprint: "abc123 hash=stable",
      });
    }),
  );

  it.effect("reaps an inspector when the worker leaves its scope", () =>
    Effect.gen(function* () {
      const { evidence, counters } = fakeEvidence({
        inspector: { _tag: "running" },
        signalsAt: (sample) => (sample > 8 ? { isActive: false } : {}),
      });
      const { emit } = collect();
      yield* Effect.exit(
        superviseWorker({
          ref: REF,
          child: "epic.6",
          config: CONFIG,
          evidence,
          emit,
          clock: fakeClock({ budget: 20 }),
        }),
      );
      expect(counters.launches).toBe(1);
      expect(counters.stops).toBeGreaterThan(0);
    }),
  );
});
