/**
 * Every `supervision` field a run config reports must change run behaviour.
 *
 * A launch response returns the whole block with a `configProvenance` entry per
 * field, so an operator reads it as the supervision the run will apply. A field
 * nothing consumes makes an unsupervised run look supervised, which is worse
 * than no field at all (t3code-csa).
 *
 * This test is the guard. `CONSUMERS` is keyed by the contract's own field set,
 * so adding a supervision field without a consumer fails to typecheck, and each
 * entry pushes a sentinel through the real translation the runner uses, so a
 * consumer that quietly stops reading its field fails the run.
 */
import {
  DEFAULT_EPIC_RUN_CONFIG,
  DEFAULT_EPIC_RUN_CONFIG_PROVENANCE,
  EpicRunId,
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { makePoolPolicy, type PoolPolicySeed } from "./runPolicy.ts";
import type { PersistedEpicRun } from "./ports/RunJournal.ts";
import {
  makeDispatchSupervisionOptions,
  makeWorkerLivenessConfig,
  type SupervisionSettings,
} from "./workerSupervision.ts";

type SupervisionField = keyof typeof DEFAULT_EPIC_RUN_CONFIG.supervision;

/** One distinguishable value per field, so no proof can pass on a neighbour's. */
const SENTINEL = {
  idleThresholdSeconds: 111,
  inspectorTimeoutSeconds: 222,
  inspectMaxDelaySeconds: 3_333,
  inspectMinDelaySeconds: 444,
  inspectRetryDelaySeconds: 555,
  stopGraceSeconds: 66,
  workerTimeoutSeconds: 7_777,
  uncertainStopCeiling: 8,
} satisfies SupervisionSettings;

const livenessConfig = makeWorkerLivenessConfig({
  supervision: SENTINEL,
  inspectorSupported: true,
});

const dispatchOptions = makeDispatchSupervisionOptions(SENTINEL);

const POLICY_SEED: PoolPolicySeed = {
  iterationTimeoutMs: 1_000,
  runStallTimeoutMs: 2_000,
  pollIntervalMs: 3_000,
  quietPeriodMs: 4_000,
  retryBaseDelayMs: 5_000,
  retryMaxDelayMs: 6_000,
  maxConsecutiveFailures: 3,
  maxNoCommitStreak: 2,
  infraFailureBudget: 5,
  subagentGraceTimeoutMs: 7_000,
  maxGraceContinuations: 10,
};

/**
 * A persisted run whose supervision block is the sentinel one, launched with
 * every supervision field explicitly configured. `makePoolPolicy` reads a field
 * only when its provenance is not `default`, so a run built from defaults would
 * prove nothing.
 */
const RUN: PersistedEpicRun = {
  runId: EpicRunId.make("run-1"),
  epicId: "epic-1",
  projectId: ProjectId.make("project-1"),
  cwd: "/repo",
  prompt: "BASE PROMPT",
  orientationFile: null,
  modelSelection: { instanceId: ProviderInstanceId.make("worker"), model: "test" },
  runtimeMode: "full-access",
  config: { ...DEFAULT_EPIC_RUN_CONFIG, supervision: SENTINEL },
  configProvenance: Object.fromEntries(
    Object.keys(DEFAULT_EPIC_RUN_CONFIG_PROVENANCE).map((key) => [
      key,
      key.startsWith("supervision.") ? "environment" : "default",
    ]),
  ),
  originThreadId: null,
  status: "running",
  maxIterations: PositiveInt.make(10),
  workers: PositiveInt.make(1),
  iterationsDispatched: NonNegativeInt.make(0),
  iterationsCompleted: NonNegativeInt.make(0),
  currentThreadId: null,
  currentTurnStartedAt: null,
  consecutiveFailures: NonNegativeInt.make(0),
  noCommitStreak: NonNegativeInt.make(0),
  infraStreak: NonNegativeInt.make(0),
  lastError: null,
  createdAt: IsoDateTime.make("2026-01-01T00:00:00Z"),
  updatedAt: IsoDateTime.make("2026-01-01T00:00:00Z"),
};

const poolPolicy = makePoolPolicy(POLICY_SEED, RUN);

interface ConsumerProof {
  /** Where the value lands, named so a failure points at the code to read. */
  readonly consumer: string;
  readonly assert: () => void;
}

const CONSUMERS: Record<SupervisionField, ConsumerProof> = {
  idleThresholdSeconds: {
    consumer: "workerLiveness.ts, via makeWorkerLivenessConfig",
    assert: () => {
      expect(livenessConfig.idleThresholdSeconds).toBe(SENTINEL.idleThresholdSeconds);
    },
  },
  inspectorTimeoutSeconds: {
    consumer: "workerLiveness.ts, via makeWorkerLivenessConfig",
    assert: () => {
      expect(livenessConfig.inspectorTimeoutSeconds).toBe(SENTINEL.inspectorTimeoutSeconds);
    },
  },
  inspectMaxDelaySeconds: {
    consumer: "workerLiveness.ts boundedInspectDelay, via makeWorkerLivenessConfig",
    assert: () => {
      expect(livenessConfig.inspectMaxDelaySeconds).toBe(SENTINEL.inspectMaxDelaySeconds);
    },
  },
  inspectMinDelaySeconds: {
    consumer: "workerLiveness.ts boundedInspectDelay, via makeWorkerLivenessConfig",
    assert: () => {
      expect(livenessConfig.inspectMinDelaySeconds).toBe(SENTINEL.inspectMinDelaySeconds);
    },
  },
  inspectRetryDelaySeconds: {
    consumer: "workerLiveness.ts, via makeWorkerLivenessConfig",
    assert: () => {
      expect(livenessConfig.inspectRetryDelaySeconds).toBe(SENTINEL.inspectRetryDelaySeconds);
    },
  },
  uncertainStopCeiling: {
    consumer: "workerLiveness.ts, via makeWorkerLivenessConfig",
    assert: () => {
      expect(livenessConfig.uncertainStopCeiling).toBe(SENTINEL.uncertainStopCeiling);
    },
  },
  stopGraceSeconds: {
    consumer:
      "TerminalAgentDispatch.ts stop escalation and the loop's forced stop, via makeDispatchSupervisionOptions",
    assert: () => {
      expect(dispatchOptions.stopGraceSeconds).toBe(SENTINEL.stopGraceSeconds);
    },
  },
  workerTimeoutSeconds: {
    consumer: "the loop's iterationTimeoutMs (makePoolPolicy) and the dispatch adapter's deadline",
    assert: () => {
      expect(poolPolicy.iterationTimeoutMs).toBe(SENTINEL.workerTimeoutSeconds * 1_000);
      expect(dispatchOptions.timeoutSeconds).toBe(SENTINEL.workerTimeoutSeconds);
    },
  },
};

describe("supervision config", () => {
  const fields = Object.keys(
    DEFAULT_EPIC_RUN_CONFIG.supervision,
  ) as ReadonlyArray<SupervisionField>;

  it("declares a consumer for every field it reports", () => {
    expect([...fields].sort()).toEqual(Object.keys(CONSUMERS).sort());
  });

  it.each(fields.map((field) => [field, CONSUMERS[field].consumer] as const))(
    "supervision.%s reaches %s",
    (field) => {
      CONSUMERS[field].assert();
    },
  );

  it("keeps a null worker timeout out of the loop's bound", () => {
    const policy = makePoolPolicy(POLICY_SEED, {
      ...RUN,
      config: { ...RUN.config, supervision: { ...SENTINEL, workerTimeoutSeconds: null } },
    });
    expect(policy.iterationTimeoutMs).toBeNull();
    expect(
      makeDispatchSupervisionOptions({ ...SENTINEL, workerTimeoutSeconds: null }).timeoutSeconds,
    ).toBeNull();
  });
});
