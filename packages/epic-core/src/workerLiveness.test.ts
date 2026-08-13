import { describe, expect, it } from "vite-plus/test";

import {
  CODEX_INSPECTION_DISABLED_REASON,
  DEFAULT_WORKER_LIVENESS_CONFIG,
  PROCESS_FINGERPRINT_UNAVAILABLE,
  REPO_PROBE_TIMEOUT_MARKER,
  boundedInspectDelay,
  parseInspectorDecision,
  startWorkerLiveness,
  tickWorkerLiveness,
  type InspectorRunEvidence,
  type WorkerLivenessAction,
  type WorkerLivenessConfig,
  type WorkerLivenessState,
  type WorkerSignalSample,
  type WorkerTickEvidence,
} from "./workerLiveness.ts";

const CONFIG: WorkerLivenessConfig = { ...DEFAULT_WORKER_LIVENESS_CONFIG };

const signals = (overrides: Partial<WorkerSignalSample> = {}): WorkerSignalSample => ({
  isActive: true,
  outputBytes: 0,
  cpuUsec: 0,
  ioBytes: 0,
  ...overrides,
});

const decisionJson = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    decision: "continue",
    confidence: "high",
    rationale: "still working",
    ...overrides,
  });

const finishedInspector = (rc: number, text = decisionJson()): InspectorRunEvidence => ({
  _tag: "finished",
  rc,
  result: { text, byteSize: text.length, overflowed: false },
});

interface ScriptedEvidence {
  readonly now: number;
  readonly signals?: Partial<WorkerSignalSample>;
  readonly inspector?: InspectorRunEvidence;
  readonly providerFallbackPending?: boolean;
  readonly repoHash?: string;
  readonly processFingerprint?: string;
}

const makeEvidence = (
  scripted: ScriptedEvidence,
  probeCounter?: { calls: number },
): WorkerTickEvidence => ({
  now: scripted.now,
  providerFallbackPending: scripted.providerFallbackPending ?? false,
  signals: signals(scripted.signals),
  inspector: scripted.inspector ?? { _tag: "none" },
  probeRepository: () => {
    if (probeCounter) probeCounter.calls += 1;
    return scripted.repoHash ?? "main hash=1:1";
  },
  processFingerprint: () => scripted.processFingerprint ?? "fp-a",
});

const start = (now = 0, config: WorkerLivenessConfig = CONFIG): WorkerLivenessState =>
  startWorkerLiveness({ worker: "w1", child: "c1", now, signals: signals(), config });

const emitted = (actions: ReadonlyArray<WorkerLivenessAction>, type: string) =>
  actions.filter((action) => action._tag === "emit" && action.event.type === type);

const stopActions = (actions: ReadonlyArray<WorkerLivenessAction>) =>
  actions.filter((action) => action._tag === "stop-worker");

describe("tickWorkerLiveness signal progress", () => {
  it("counts any output byte delta as progress (run-legacy.sh:1764)", () => {
    const { state } = tickWorkerLiveness(
      start(),
      makeEvidence({ now: 10, signals: { outputBytes: 1 } }),
      CONFIG,
    );
    expect(state.lastProgressAt).toBe(10);
    expect(state.generation).toBe(1);
    expect(state.nextInspectAt).toBe(10 + CONFIG.idleThresholdSeconds);
  });

  it("counts CPU at exactly 100000 usec as progress, but not below (run-legacy.sh:146, 1931)", () => {
    const progressed = tickWorkerLiveness(
      start(),
      makeEvidence({ now: 10, signals: { cpuUsec: 100000 } }),
      CONFIG,
    );
    expect(progressed.state.generation).toBe(1);
    const quiet = tickWorkerLiveness(
      start(),
      makeEvidence({ now: 10, signals: { cpuUsec: 99999 } }),
      CONFIG,
    );
    expect(quiet.state.generation).toBe(0);
  });

  it("counts IO at exactly 4096 bytes as progress, but not below (run-legacy.sh:147, 1932)", () => {
    const progressed = tickWorkerLiveness(
      start(),
      makeEvidence({ now: 10, signals: { ioBytes: 4096 } }),
      CONFIG,
    );
    expect(progressed.state.generation).toBe(1);
    const quiet = tickWorkerLiveness(
      start(),
      makeEvidence({ now: 10, signals: { ioBytes: 4095 } }),
      CONFIG,
    );
    expect(quiet.state.generation).toBe(0);
  });
});

describe("tickWorkerLiveness repository probe", () => {
  it("does not probe while quiet before repoProbeInterval elapses (run-legacy.sh:1768)", () => {
    const probe = { calls: 0 };
    const { state } = tickWorkerLiveness(start(), makeEvidence({ now: 59 }, probe), CONFIG);
    expect(probe.calls).toBe(0);
    expect(state.repoHash).toBeNull();
  });

  it("records a baseline hash on the first probe without counting progress (run-legacy.sh:1770)", () => {
    const probe = { calls: 0 };
    const { state } = tickWorkerLiveness(
      start(),
      makeEvidence({ now: 60, repoHash: "main hash=1:1" }, probe),
      CONFIG,
    );
    expect(probe.calls).toBe(1);
    expect(state.repoHash).toBe("main hash=1:1");
    expect(state.generation).toBe(0);
    expect(state.nextRepoProbeAt).toBe(60 + CONFIG.repoProbeIntervalSeconds);
  });

  it("counts a changed repo hash as progress and resets the probe interval (run-legacy.sh:1770-1771)", () => {
    const first = tickWorkerLiveness(
      start(),
      makeEvidence({ now: 60, repoHash: "main hash=1:1" }),
      CONFIG,
    ).state;
    const { state } = tickWorkerLiveness(
      first,
      makeEvidence({ now: 120, repoHash: "main hash=2:2" }),
      CONFIG,
    );
    expect(state.generation).toBe(1);
    expect(state.lastProgressAt).toBe(120);
    expect(state.nextRepoProbeAt).toBe(120 + CONFIG.repoProbeIntervalSeconds);
  });

  it("never probes on a tick where the signals already show progress (run-legacy.sh:1768)", () => {
    const probe = { calls: 0 };
    tickWorkerLiveness(
      start(),
      makeEvidence({ now: 600, signals: { outputBytes: 5 } }, probe),
      CONFIG,
    );
    expect(probe.calls).toBe(0);
  });
});

describe("tickWorkerLiveness absolute deadline", () => {
  const deadlineConfig: WorkerLivenessConfig = { ...CONFIG, workerTimeoutSeconds: 100 };

  it("stops with the timeout reason once the deadline is reached (run-legacy.sh:1752-1757)", () => {
    const { actions } = tickWorkerLiveness(
      start(0, deadlineConfig),
      makeEvidence({ now: 100 }),
      deadlineConfig,
    );
    expect(stopActions(actions)).toEqual([{ _tag: "stop-worker", reason: "timed out after 100s" }]);
  });

  it("does not stop before the deadline", () => {
    const { actions } = tickWorkerLiveness(
      start(0, deadlineConfig),
      makeEvidence({ now: 99 }),
      deadlineConfig,
    );
    expect(stopActions(actions)).toEqual([]);
  });
});

describe("tickWorkerLiveness inspector launch", () => {
  it("launches one inspector once idle passes the threshold (run-legacy.sh:1790-1792)", () => {
    const { state, actions } = tickWorkerLiveness(start(), makeEvidence({ now: 1800 }), CONFIG);
    // The request carries the structural snapshot the prompt renders from, so
    // no adapter has to re-sample and disagree with the machine.
    expect(actions).toContainEqual({
      _tag: "launch-inspector",
      timeoutSeconds: 120,
      evidence: {
        worker: "w1",
        child: "c1",
        elapsedSeconds: 1800,
        idleSeconds: 1800,
        outputBytes: 0,
        outputBytesDelta: 0,
        cpuUsecDelta: 0,
        ioBytesDelta: 0,
        processFingerprint: "fp-a",
        repoFingerprint: "main hash=1:1",
      },
    });
    expect(emitted(actions, "worker-idle")).toEqual([
      {
        _tag: "emit",
        event: {
          type: "worker-idle",
          worker: "w1",
          child: "c1",
          idleSeconds: 1800,
          elapsedSeconds: 1800,
        },
      },
    ]);
    expect(emitted(actions, "inspection-started")).toHaveLength(1);
    expect(state.inspector).toEqual({
      startedAt: 1800,
      generation: 0,
      processFingerprint: "fp-a",
      repoFingerprint: "main hash=1:1",
    });
  });

  it("does not launch while idle is below the threshold", () => {
    const { actions } = tickWorkerLiveness(start(), makeEvidence({ now: 1700 }), CONFIG);
    expect(actions).toEqual([]);
  });

  it("does not launch while a provider fallback is pending (run-legacy.sh:1790)", () => {
    const { actions } = tickWorkerLiveness(
      start(),
      makeEvidence({ now: 1800, providerFallbackPending: true }),
      CONFIG,
    );
    expect(actions).toEqual([]);
  });

  it("records uncertain without launching under Codex (run-legacy.sh:1427-1430)", () => {
    const codexConfig: WorkerLivenessConfig = { ...CONFIG, inspectorSupported: false };
    const { state, actions } = tickWorkerLiveness(
      start(0, codexConfig),
      makeEvidence({ now: 1800 }),
      codexConfig,
    );
    expect(actions.some((action) => action._tag === "launch-inspector")).toBe(false);
    expect(emitted(actions, "worker-idle")).toHaveLength(1);
    expect(emitted(actions, "inspection-uncertain")).toEqual([
      {
        _tag: "emit",
        event: {
          type: "inspection-uncertain",
          worker: "w1",
          child: "c1",
          reason: CODEX_INSPECTION_DISABLED_REASON,
          nextCheckSeconds: 300,
        },
      },
    ]);
    expect(state.inspector).toBeNull();
    expect(state.nextInspectAt).toBe(1800 + 300);
  });
});

describe("tickWorkerLiveness uncertain ceiling without an inspector (t3code-77b)", () => {
  const CEILING = 12;
  const NO_INSPECTOR: WorkerLivenessConfig = {
    ...CONFIG,
    inspectorSupported: false,
    uncertainStopCeiling: CEILING,
  };

  /**
   * Every check lands exactly on `nextInspectAt`, which an uncertain result
   * pushes out by the retry delay. That is the real cadence of a wedged worker
   * on a harness with no inspector.
   */
  const idleChecks = (
    count: number,
    config: WorkerLivenessConfig = NO_INSPECTOR,
    scripted: (check: number) => Partial<ScriptedEvidence> = () => ({}),
  ): { state: WorkerLivenessState; actions: ReadonlyArray<WorkerLivenessAction> } => {
    let state = start(0, config);
    let actions: ReadonlyArray<WorkerLivenessAction> = [];
    let now = config.idleThresholdSeconds;
    for (let check = 1; check <= count; check += 1) {
      const tick = tickWorkerLiveness(state, makeEvidence({ now, ...scripted(check) }), config);
      state = tick.state;
      actions = tick.actions;
      now += config.inspectRetryDelaySeconds;
    }
    return { state, actions };
  };

  it("stops the worker once the evidence repeats up to the ceiling", () => {
    const below = idleChecks(CEILING - 1);
    expect(stopActions(below.actions)).toEqual([]);
    expect(below.state.uncertainStreak?.count).toBe(CEILING - 1);

    const { state, actions } = idleChecks(CEILING);
    const [stop] = stopActions(actions);
    expect(stop?.reason).toContain("no inspector on this harness");
    expect(stop?.reason).toContain("across 12 checks");
    expect(stop?.reason).toContain("process fingerprint fp-a");
    expect(stop?.reason).toContain("repository main hash=1:1");
    expect(stop?.reason).toContain("progress generation 0");
    expect(emitted(actions, "inspection-stop")).toHaveLength(1);
    expect(state.uncertainStreak).toBeNull();
  });

  it("still confirms once before stopping when the ceiling is below two", () => {
    const eager: WorkerLivenessConfig = { ...NO_INSPECTOR, uncertainStopCeiling: 1 };
    expect(stopActions(idleChecks(1, eager).actions)).toEqual([]);
    expect(stopActions(idleChecks(2, eager).actions)).toHaveLength(1);
  });

  it("never stops when the ceiling is disabled", () => {
    const disabled: WorkerLivenessConfig = { ...NO_INSPECTOR, uncertainStopCeiling: null };
    const { state, actions } = idleChecks(40, disabled);
    expect(stopActions(actions)).toEqual([]);
    expect(state.uncertainStreak).toBeNull();
  });

  it("restarts the count when the process fingerprint changes", () => {
    const { state, actions } = idleChecks(CEILING, NO_INSPECTOR, (check) =>
      check === CEILING ? { processFingerprint: "fp-b" } : {},
    );
    expect(stopActions(actions)).toEqual([]);
    expect(state.uncertainStreak).toEqual({
      processFingerprint: "fp-b",
      repoFingerprint: "main hash=1:1",
      generation: 0,
      count: 1,
    });
  });

  it("clears the count on progress, which also bumps the generation", () => {
    const { state, actions } = idleChecks(CEILING, NO_INSPECTOR, (check) =>
      check === CEILING ? { signals: { outputBytes: 1 } } : {},
    );
    expect(stopActions(actions)).toEqual([]);
    expect(state.uncertainStreak).toBeNull();
    expect(state.generation).toBe(1);
  });

  it("clears the count when the worker leaves its scope", () => {
    const { state, actions } = idleChecks(CEILING, NO_INSPECTOR, (check) =>
      check === CEILING ? { signals: { isActive: false } } : {},
    );
    expect(stopActions(actions)).toEqual([]);
    expect(state.uncertainStreak).toBeNull();
  });

  it("does not count a check with no process fingerprint", () => {
    const missing = (check: number): Partial<ScriptedEvidence> =>
      check === 3 ? { processFingerprint: PROCESS_FINGERPRINT_UNAVAILABLE } : {};

    const atCeiling = idleChecks(CEILING, NO_INSPECTOR, missing);
    expect(stopActions(atCeiling.actions)).toEqual([]);
    // The unprovable check neither counted nor broke the chain.
    expect(atCeiling.state.uncertainStreak?.count).toBe(CEILING - 1);
    expect(stopActions(idleChecks(CEILING + 1, NO_INSPECTOR, missing).actions)).toHaveLength(1);
  });

  it("does not count a check whose repository probe timed out", () => {
    // Rule 4 already read the repository on the first check, so only the
    // ceiling's own probe sees the timeout line.
    const quiet: WorkerLivenessConfig = { ...NO_INSPECTOR, repoProbeIntervalSeconds: 100_000 };
    const timedOut = (check: number): Partial<ScriptedEvidence> =>
      check === 3 ? { repoHash: `unknown hash=${REPO_PROBE_TIMEOUT_MARKER}` } : {};

    const atCeiling = idleChecks(CEILING, quiet, timedOut);
    expect(stopActions(atCeiling.actions)).toEqual([]);
    expect(atCeiling.state.uncertainStreak?.count).toBe(CEILING - 1);
    expect(stopActions(idleChecks(CEILING + 1, quiet, timedOut).actions)).toHaveLength(1);
  });
});

describe("tickWorkerLiveness inspector reap", () => {
  const launch = (state: WorkerLivenessState, now = 1800): WorkerLivenessState =>
    tickWorkerLiveness(state, makeEvidence({ now }), CONFIG).state;

  it("forces rc 124 past the inspector timeout, then reaps (run-legacy.sh:1782-1785)", () => {
    const launched = launch(start());
    const early = tickWorkerLiveness(
      launched,
      makeEvidence({ now: 1919, inspector: { _tag: "running" } }),
      CONFIG,
    );
    expect(early.actions).toEqual([]);
    expect(early.state.inspector).not.toBeNull();

    const late = tickWorkerLiveness(
      launched,
      makeEvidence({ now: 1920, inspector: { _tag: "running" } }),
      CONFIG,
    );
    expect(late.actions).toContainEqual({ _tag: "force-stop-inspector" });
    expect(emitted(late.actions, "inspection-uncertain")).toEqual([
      {
        _tag: "emit",
        event: {
          type: "inspection-uncertain",
          worker: "w1",
          child: "c1",
          reason: "inspector timed out after 120s",
          nextCheckSeconds: 300,
        },
      },
    ]);
    expect(late.state.inspector).toBeNull();
  });

  it("treats any nonzero inspector rc as uncertain (run-legacy.sh:1647-1651)", () => {
    const launched = launch(start());
    const { actions } = tickWorkerLiveness(
      launched,
      makeEvidence({ now: 1805, inspector: finishedInspector(1) }),
      CONFIG,
    );
    expect(emitted(actions, "inspection-uncertain")[0]).toMatchObject({
      _tag: "emit",
      event: { reason: "inspector failed with rc=1", nextCheckSeconds: 300 },
    });
  });

  it("rejects malformed output as uncertain (run-legacy.sh:1652-1655)", () => {
    const launched = launch(start());
    const { actions } = tickWorkerLiveness(
      launched,
      makeEvidence({ now: 1805, inspector: finishedInspector(0, "not json") }),
      CONFIG,
    );
    expect(emitted(actions, "inspection-uncertain")[0]).toMatchObject({
      _tag: "emit",
      event: { reason: "inspector returned malformed output" },
    });
  });

  it("schedules the next check from a continue verdict (run-legacy.sh:1697-1704)", () => {
    const launched = launch(start());
    const { state, actions } = tickWorkerLiveness(
      launched,
      makeEvidence({
        now: 1805,
        inspector: finishedInspector(0, decisionJson({ next_check_seconds: 500 })),
      }),
      CONFIG,
    );
    expect(emitted(actions, "inspection-continue")).toEqual([
      {
        _tag: "emit",
        event: {
          type: "inspection-continue",
          worker: "w1",
          child: "c1",
          rationale: "still working",
          nextCheckSeconds: 500,
        },
      },
    ]);
    expect(state.nextInspectAt).toBe(1805 + 500);
    expect(state.pendingStop).toBeNull();
  });
});

describe("tickWorkerLiveness stop gating", () => {
  const stopHigh = (rationale = "no output for hours"): InspectorRunEvidence =>
    finishedInspector(0, decisionJson({ decision: "stop", rationale }));

  const launchAt = (state: WorkerLivenessState, now: number): WorkerLivenessState =>
    tickWorkerLiveness(state, makeEvidence({ now }), CONFIG).state;

  it("never stops on a single stop:high; it records a pending stop (run-legacy.sh:1679-1689)", () => {
    const launched = launchAt(start(), 1800);
    const { state, actions } = tickWorkerLiveness(
      launched,
      makeEvidence({ now: 1805, inspector: stopHigh() }),
      CONFIG,
    );
    expect(stopActions(actions)).toEqual([]);
    expect(emitted(actions, "inspection-stop-pending")).toEqual([
      {
        _tag: "emit",
        event: {
          type: "inspection-stop-pending",
          worker: "w1",
          child: "c1",
          rationale: "no output for hours",
          nextCheckSeconds: 60,
        },
      },
    ]);
    expect(state.pendingStop).toEqual({
      processFingerprint: "fp-a",
      repoFingerprint: "main hash=1:1",
      generation: 0,
    });
    expect(state.nextInspectAt).toBe(1805 + 60);
  });

  it("stops on a second stop:high whose fingerprints and generation match (run-legacy.sh:1673-1696)", () => {
    let state = launchAt(start(), 1800);
    state = tickWorkerLiveness(
      state,
      makeEvidence({ now: 1805, inspector: stopHigh() }),
      CONFIG,
    ).state;
    state = launchAt(state, 1865);
    const { actions } = tickWorkerLiveness(
      state,
      makeEvidence({ now: 1870, inspector: stopHigh() }),
      CONFIG,
    );
    expect(emitted(actions, "inspection-stop")).toHaveLength(1);
    expect(stopActions(actions)).toEqual([
      { _tag: "stop-worker", reason: "inspector requested stop: no output for hours" },
    ]);
  });

  it("clears the pending stop when progress lands between two stop:high verdicts (run-legacy.sh:1775-1780)", () => {
    let state = launchAt(start(), 1800);
    state = tickWorkerLiveness(
      state,
      makeEvidence({ now: 1805, inspector: stopHigh() }),
      CONFIG,
    ).state;
    expect(state.pendingStop).not.toBeNull();
    state = tickWorkerLiveness(
      state,
      makeEvidence({ now: 1810, signals: { outputBytes: 10 } }),
      CONFIG,
    ).state;
    expect(state.pendingStop).toBeNull();
    expect(state.generation).toBe(1);
    state = launchAt(state, 3610);
    const { state: after, actions } = tickWorkerLiveness(
      state,
      makeEvidence({ now: 3615, inspector: stopHigh() }),
      CONFIG,
    );
    expect(stopActions(actions)).toEqual([]);
    expect(after.pendingStop).toMatchObject({ generation: 1 });
  });

  it("ignores a stop:high whose inspection generation went stale (run-legacy.sh:1662-1665)", () => {
    let state = launchAt(start(), 1800);
    state = tickWorkerLiveness(
      state,
      makeEvidence({ now: 1802, signals: { outputBytes: 5 }, inspector: { _tag: "running" } }),
      CONFIG,
    ).state;
    const { state: after, actions } = tickWorkerLiveness(
      state,
      makeEvidence({ now: 1805, inspector: stopHigh() }),
      CONFIG,
    );
    expect(stopActions(actions)).toEqual([]);
    expect(after.pendingStop).toBeNull();
    expect(emitted(actions, "inspection-uncertain")[0]).toMatchObject({
      _tag: "emit",
      event: { reason: "worker made progress while inspection was running; stale stop ignored" },
    });
  });

  it("clears the pending stop when the process fingerprint changes (run-legacy.sh:1666-1672)", () => {
    let state = launchAt(start(), 1800);
    state = tickWorkerLiveness(
      state,
      makeEvidence({ now: 1805, inspector: stopHigh() }),
      CONFIG,
    ).state;
    state = launchAt(state, 1865);
    const { state: after, actions } = tickWorkerLiveness(
      state,
      makeEvidence({ now: 1870, inspector: stopHigh(), processFingerprint: "fp-b" }),
      CONFIG,
    );
    expect(stopActions(actions)).toEqual([]);
    expect(after.pendingStop).toBeNull();
    expect(emitted(actions, "inspection-uncertain")[0]).toMatchObject({
      _tag: "emit",
      event: { reason: "worker fingerprint changed during inspection; stop confirmation cleared" },
    });
  });

  it("never satisfies the stop gate with a probe-timeout repo fingerprint (run-legacy.sh:1668)", () => {
    let state = tickWorkerLiveness(
      start(),
      makeEvidence({ now: 1800, repoHash: "main hash=probe-timeout" }),
      CONFIG,
    ).state;
    expect(state.inspector?.repoFingerprint).toBe("main hash=probe-timeout");
    const { state: after, actions } = tickWorkerLiveness(
      state,
      makeEvidence({ now: 1805, inspector: stopHigh(), repoHash: "main hash=probe-timeout" }),
      CONFIG,
    );
    expect(stopActions(actions)).toEqual([]);
    expect(after.pendingStop).toBeNull();
  });

  it.each(["medium", "low"] as const)(
    "treats stop:%s as uncertain and keeps the worker alive (run-legacy.sh:1705)",
    (confidence) => {
      const launched = launchAt(start(), 1800);
      const { state, actions } = tickWorkerLiveness(
        launched,
        makeEvidence({
          now: 1805,
          inspector: finishedInspector(0, decisionJson({ decision: "stop", confidence })),
        }),
        CONFIG,
      );
      expect(stopActions(actions)).toEqual([]);
      expect(state.pendingStop).toBeNull();
      expect(emitted(actions, "inspection-uncertain")[0]).toMatchObject({
        _tag: "emit",
        event: { reason: `decision=stop confidence=${confidence}: still working` },
      });
    },
  );
});

describe("parseInspectorDecision (run-legacy.sh:1463-1477)", () => {
  const result = (text: string, overrides = {}) => ({
    text,
    byteSize: text.length,
    overflowed: false,
    ...overrides,
  });

  it("accepts a minimal valid decision", () => {
    expect(parseInspectorDecision(result(decisionJson()), CONFIG)).toEqual({
      decision: "continue",
      confidence: "high",
      rationale: "still working",
      nextCheckSeconds: null,
    });
  });

  it("rejects a result with an extra JSON key", () => {
    expect(parseInspectorDecision(result(decisionJson({ extra: true })), CONFIG)).toBeNull();
  });

  it("rejects a result missing a required key", () => {
    expect(
      parseInspectorDecision(
        result(JSON.stringify({ decision: "stop", confidence: "high" })),
        CONFIG,
      ),
    ).toBeNull();
  });

  it("rejects a stop carrying next_check_seconds", () => {
    expect(
      parseInspectorDecision(
        result(decisionJson({ decision: "stop", next_check_seconds: 60 })),
        CONFIG,
      ),
    ).toBeNull();
  });

  it("rejects a rationale over 240 characters and accepts exactly 240", () => {
    const at240 = decisionJson({ rationale: "x".repeat(240) });
    expect(parseInspectorDecision(result(at240), CONFIG)).not.toBeNull();
    const at241 = decisionJson({ rationale: "x".repeat(241) });
    expect(parseInspectorDecision(result(at241), CONFIG)).toBeNull();
  });

  it("rejects a blank rationale", () => {
    expect(parseInspectorDecision(result(decisionJson({ rationale: "   " })), CONFIG)).toBeNull();
  });

  it("rejects an overflowed result no matter how valid the JSON", () => {
    expect(parseInspectorDecision(result(decisionJson(), { overflowed: true }), CONFIG)).toBeNull();
  });

  it("rejects a result beyond inspectorResultBytes", () => {
    const text = decisionJson();
    expect(
      parseInspectorDecision(result(text, { byteSize: CONFIG.inspectorResultBytes + 1 }), CONFIG),
    ).toBeNull();
  });

  it("rejects more than one JSON object", () => {
    expect(
      parseInspectorDecision(result(`${decisionJson()}\n${decisionJson()}`), CONFIG),
    ).toBeNull();
  });

  it("rejects unknown decision and confidence values", () => {
    expect(parseInspectorDecision(result(decisionJson({ decision: "kill" })), CONFIG)).toBeNull();
    expect(
      parseInspectorDecision(result(decisionJson({ confidence: "certain" })), CONFIG),
    ).toBeNull();
  });

  it("rejects non-integer or non-positive next_check_seconds", () => {
    for (const value of [1.5, 0, -5, "60"]) {
      expect(
        parseInspectorDecision(result(decisionJson({ next_check_seconds: value })), CONFIG),
      ).toBeNull();
    }
  });
});

describe("boundedInspectDelay (run-legacy.sh:1128-1134)", () => {
  it("clamps into [inspectMinDelay, inspectMaxDelay]", () => {
    expect(boundedInspectDelay(30, CONFIG)).toBe(60);
    expect(boundedInspectDelay(500, CONFIG)).toBe(500);
    expect(boundedInspectDelay(99999, CONFIG)).toBe(7200);
  });

  it("falls back to idleThreshold for a non-positive-integer input", () => {
    expect(boundedInspectDelay(null, CONFIG)).toBe(1800);
    expect(boundedInspectDelay(0, CONFIG)).toBe(1800);
    expect(boundedInspectDelay(-5, CONFIG)).toBe(1800);
    expect(boundedInspectDelay(1.5, CONFIG)).toBe(1800);
  });
});

describe("tickWorkerLiveness inactive worker", () => {
  it("clears inspector state and skips when the worker is not active (run-legacy.sh:1748-1751)", () => {
    const launched = tickWorkerLiveness(start(), makeEvidence({ now: 1800 }), CONFIG).state;
    expect(launched.inspector).not.toBeNull();
    const { state, actions } = tickWorkerLiveness(
      launched,
      makeEvidence({ now: 1810, signals: { isActive: false } }),
      CONFIG,
    );
    expect(actions).toEqual([{ _tag: "worker-inactive" }]);
    expect(state.inspector).toBeNull();
    expect(state.pendingStop).toBeNull();
  });

  it("emits nothing for an inactive worker with no inspector", () => {
    const { actions } = tickWorkerLiveness(
      start(),
      makeEvidence({ now: 10, signals: { isActive: false } }),
      CONFIG,
    );
    expect(actions).toEqual([]);
  });
});
