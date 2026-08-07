import { describe, expect, it } from "vite-plus/test";

import {
  EPIC_RUN_CONTINUATION_PROMPT,
  EPIC_RUN_STALLED_PROGRESS_PROMPT,
  backoffDelayMs,
  decideGraceStep,
  decideIterationBoundary,
  failureReasonForOutcome,
  persistedFailureReason,
  type IterationBoundaryDecision,
  type IterationBoundaryInput,
} from "./policy.ts";
import {
  iterationFailureClass,
  type EpicIterationOutcome,
  type EpicIterationOutcomeKind,
} from "./ralphProtocol.ts";

const outcome = (
  kind: EpicIterationOutcomeKind,
  detail: string | null = kind,
): EpicIterationOutcome => ({ kind, detail, report: null });

const boundaryInput = (
  overrides: Partial<IterationBoundaryInput> = {},
): IterationBoundaryInput => ({
  runStatus: "running",
  consecutiveFailures: 1,
  noCommitStreak: 1,
  infraStreak: 2,
  lastError: "previous error",
  outcome: outcome("blocked"),
  noCommitChildClosed: false,
  providerFallbackApplied: false,
  providerTurnDispatched: true,
  limits: {
    maxConsecutiveFailures: 3,
    maxNoCommitStreak: 3,
    infraFailureBudget: 4,
    retryBaseDelayMs: 10_000,
    retryMaxDelayMs: 300_000,
  },
  ...overrides,
});

describe("decideIterationBoundary", () => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly input: Partial<IterationBoundaryInput>;
    readonly expected: IterationBoundaryDecision;
  }> = [
    {
      name: "provider fallback continues and resets only the infra streak",
      input: {
        providerFallbackApplied: true,
        outcome: {
          ...outcome("error", "provider failed"),
          failureReason: "provider-error:unavailable",
          providerFallbackEligible: true,
        },
      },
      expected: {
        action: "continue",
        delayMs: 0,
        nextStatus: null,
        nextConsecutiveFailures: 1,
        nextNoCommitStreak: 1,
        nextInfraStreak: 0,
        lastError: "previous error",
      },
    },
    {
      name: "a stopped run keeps its persisted policy state",
      input: { runStatus: "paused" },
      expected: {
        action: "stop",
        delayMs: 0,
        nextStatus: null,
        nextConsecutiveFailures: 1,
        nextNoCommitStreak: 1,
        nextInfraStreak: 2,
        lastError: "previous error",
      },
    },
    {
      name: "a dispatched backlog-empty turn completes and clears streaks",
      input: { outcome: outcome("backlog-empty") },
      expected: {
        action: "stop",
        delayMs: 0,
        nextStatus: "done",
        nextConsecutiveFailures: 0,
        nextNoCommitStreak: 0,
        nextInfraStreak: 0,
        lastError: null,
      },
    },
    {
      name: "a done turn continues and clears streaks",
      input: { outcome: outcome("done") },
      expected: {
        action: "continue",
        delayMs: 0,
        nextStatus: null,
        nextConsecutiveFailures: 0,
        nextNoCommitStreak: 0,
        nextInfraStreak: 0,
        lastError: null,
      },
    },
    {
      name: "an accepted no-commit child continues and clears streaks",
      input: { outcome: outcome("no-commit"), noCommitChildClosed: true },
      expected: {
        action: "continue",
        delayMs: 0,
        nextStatus: null,
        nextConsecutiveFailures: 0,
        nextNoCommitStreak: 0,
        nextInfraStreak: 0,
        lastError: null,
      },
    },
    {
      name: "an open no-commit child spends the gutter budget",
      input: { outcome: outcome("no-commit") },
      expected: {
        action: "continue",
        delayMs: 0,
        nextStatus: null,
        nextConsecutiveFailures: 0,
        nextNoCommitStreak: 2,
        nextInfraStreak: 2,
        lastError: null,
      },
    },
    {
      name: "an infra failure spends only the infra budget",
      input: { outcome: outcome("timeout", "turn timed out") },
      expected: {
        action: "continue",
        delayMs: 40_000,
        nextStatus: null,
        nextConsecutiveFailures: 1,
        nextNoCommitStreak: 1,
        nextInfraStreak: 3,
        lastError: "turn timed out",
      },
    },
    {
      name: "a child failure spends only the child failure budget",
      input: { outcome: outcome("blocked", "child blocked") },
      expected: {
        action: "continue",
        delayMs: 20_000,
        nextStatus: null,
        nextConsecutiveFailures: 2,
        nextNoCommitStreak: 1,
        nextInfraStreak: 2,
        lastError: "child blocked",
      },
    },
  ];

  it.each(cases)("$name", ({ input, expected }) => {
    expect(decideIterationBoundary(boundaryInput(input))).toEqual(expected);
  });

  it("preserves the gutter and infra streak when empty selection dispatched no turn", () => {
    expect(
      decideIterationBoundary(
        boundaryInput({
          outcome: outcome("backlog-empty"),
          providerTurnDispatched: false,
        }),
      ),
    ).toEqual({
      action: "stop",
      delayMs: 0,
      nextStatus: "done",
      nextConsecutiveFailures: 0,
      nextNoCommitStreak: 1,
      nextInfraStreak: 2,
      lastError: null,
    });
  });

  const precedenceCases: ReadonlyArray<{
    readonly name: string;
    readonly input: Partial<IterationBoundaryInput>;
    readonly expected: IterationBoundaryDecision;
  }> = [
    {
      name: "fallback precedes stopped status and infra policy",
      input: {
        runStatus: "paused",
        providerFallbackApplied: true,
        outcome: {
          ...outcome("error", "provider failed"),
          failureReason: "provider-error:unavailable",
          providerFallbackEligible: true,
        },
      },
      expected: {
        action: "stop",
        delayMs: 0,
        nextStatus: null,
        nextConsecutiveFailures: 1,
        nextNoCommitStreak: 1,
        nextInfraStreak: 0,
        lastError: "previous error",
      },
    },
    {
      name: "stopped status precedes infra policy",
      input: { runStatus: "paused", outcome: outcome("timeout", "timed out") },
      expected: {
        action: "stop",
        delayMs: 0,
        nextStatus: null,
        nextConsecutiveFailures: 1,
        nextNoCommitStreak: 1,
        nextInfraStreak: 2,
        lastError: "previous error",
      },
    },
    {
      name: "stopped status precedes backlog-empty",
      input: { runStatus: "paused", outcome: outcome("backlog-empty") },
      expected: {
        action: "stop",
        delayMs: 0,
        nextStatus: null,
        nextConsecutiveFailures: 1,
        nextNoCommitStreak: 1,
        nextInfraStreak: 2,
        lastError: "previous error",
      },
    },
    {
      name: "backlog-empty precedes accepted evidence",
      input: { outcome: outcome("backlog-empty"), noCommitChildClosed: true },
      expected: {
        action: "stop",
        delayMs: 0,
        nextStatus: "done",
        nextConsecutiveFailures: 0,
        nextNoCommitStreak: 0,
        nextInfraStreak: 0,
        lastError: null,
      },
    },
    {
      name: "done precedes accepted evidence",
      input: { outcome: outcome("done"), noCommitChildClosed: true },
      expected: {
        action: "continue",
        delayMs: 0,
        nextStatus: null,
        nextConsecutiveFailures: 0,
        nextNoCommitStreak: 0,
        nextInfraStreak: 0,
        lastError: null,
      },
    },
    {
      name: "accepted evidence precedes the no-commit gutter",
      input: {
        outcome: outcome("no-commit"),
        noCommitChildClosed: true,
        limits: { ...boundaryInput().limits, maxNoCommitStreak: 2 },
      },
      expected: {
        action: "continue",
        delayMs: 0,
        nextStatus: null,
        nextConsecutiveFailures: 0,
        nextNoCommitStreak: 0,
        nextInfraStreak: 0,
        lastError: null,
      },
    },
  ];

  it.each(precedenceCases)("$name", ({ input, expected }) => {
    expect(decideIterationBoundary(boundaryInput(input))).toEqual(expected);
  });

  it("stops when the no-commit budget is exhausted", () => {
    expect(
      decideIterationBoundary(
        boundaryInput({
          outcome: outcome("no-commit"),
          limits: { ...boundaryInput().limits, maxNoCommitStreak: 2 },
        }),
      ),
    ).toEqual({
      action: "stop",
      delayMs: 0,
      nextStatus: "failed",
      nextConsecutiveFailures: 0,
      nextNoCommitStreak: 2,
      nextInfraStreak: 2,
      lastError: "gutter: 2 iterations without a commit",
    });
  });

  it("stops only when the infra budget is exhausted", () => {
    expect(
      decideIterationBoundary(
        boundaryInput({
          outcome: outcome("error", "provider failed"),
          limits: { ...boundaryInput().limits, infraFailureBudget: 3 },
        }),
      ),
    ).toEqual({
      action: "stop",
      delayMs: 40_000,
      nextStatus: "failed",
      nextConsecutiveFailures: 1,
      nextNoCommitStreak: 1,
      nextInfraStreak: 3,
      lastError: "infra: 3 consecutive infrastructure failures; last: provider failed",
    });
  });

  it("stops only when the child failure budget is exhausted", () => {
    expect(
      decideIterationBoundary(
        boundaryInput({
          consecutiveFailures: 2,
          outcome: outcome("blocked", "cannot proceed"),
        }),
      ),
    ).toEqual({
      action: "stop",
      delayMs: 40_000,
      nextStatus: "failed",
      nextConsecutiveFailures: 3,
      nextNoCommitStreak: 1,
      nextInfraStreak: 2,
      lastError: "cannot proceed",
    });
  });
});

describe("backoffDelayMs", () => {
  it.each([
    [1, 10_000],
    [2, 20_000],
    [5, 160_000],
    [7, 300_000],
  ])("uses exponential delay for failure %i", (failures, expected) => {
    expect(backoffDelayMs(failures, 10_000, 300_000)).toBe(expected);
  });
});

describe("failure vocabulary", () => {
  it.each([
    ["done", null, null],
    ["backlog-empty", null, null],
    ["no-commit", "no-commit-child-open", "child"],
    ["blocked", "blocked", "child"],
    ["timeout", "timeout", "infra"],
    ["error", "turn-error", "infra"],
    ["protocol-error", "protocol-error", "infra"],
  ] as const)("maps %s without merging the failure-class split", (kind, reason, failureClass) => {
    expect(failureReasonForOutcome(kind)).toBe(reason);
    expect(iterationFailureClass(kind)).toBe(failureClass);
  });

  it.each([
    {
      name: "completed status clears every failure source",
      input: {
        iterationStatus: "completed" as const,
        dispatchFailed: true,
        evidenceFailureReason: "no-commit-no-evidence",
        outcome: {
          ...outcome("error"),
          failureReason: "provider-error:auth",
        },
      },
      expected: null,
    },
    {
      name: "dispatch failure precedes evidence and outcome reasons",
      input: {
        iterationStatus: "failed" as const,
        dispatchFailed: true,
        evidenceFailureReason: "no-commit-no-evidence",
        outcome: {
          ...outcome("error"),
          failureReason: "provider-error:auth",
        },
      },
      expected: "infra:dispatch-failed",
    },
    {
      name: "evidence precedes the classified outcome override",
      input: {
        iterationStatus: "failed" as const,
        dispatchFailed: false,
        evidenceFailureReason: "closed-without-findings",
        outcome: {
          ...outcome("no-commit"),
          failureReason: "provider-error:auth",
        },
      },
      expected: "child:closed-without-findings",
    },
    {
      name: "the classified outcome override precedes the default mapping",
      input: {
        iterationStatus: "failed" as const,
        dispatchFailed: false,
        evidenceFailureReason: null,
        outcome: {
          ...outcome("error"),
          failureReason: "provider-error:auth",
        },
      },
      expected: "infra:provider-error:auth",
    },
    {
      name: "the default mapping supplies the final fallback",
      input: {
        iterationStatus: "failed" as const,
        dispatchFailed: false,
        evidenceFailureReason: null,
        outcome: outcome("blocked"),
      },
      expected: "child:blocked",
    },
  ])("$name", ({ input, expected }) => {
    expect(persistedFailureReason(input)).toBe(expected);
  });
});

const graceInput = (
  overrides: Partial<Parameters<typeof decideGraceStep>[0]> = {},
): Parameters<typeof decideGraceStep>[0] => ({
  headMoved: false,
  turnStatus: "completed" as const,
  freshRunningCount: 0,
  fingerprintChanged: true,
  hasRalphToken: false,
  finalMessageMissing: false,
  finalMessageWaitExhausted: false,
  continuationsUsed: 0,
  maxGraceContinuations: 10,
  ...overrides,
});

describe("decideGraceStep", () => {
  it("settles when HEAD moved", () => {
    expect(decideGraceStep(graceInput({ headMoved: true, freshRunningCount: 2 }))).toEqual({
      action: "settle",
      reason: "head-moved",
    });
  });

  it.each(["running", "error", "interrupted", null] as const)(
    "settles a %s turn before subagent handling",
    (turnStatus) => {
      expect(decideGraceStep(graceInput({ turnStatus, freshRunningCount: 2 }))).toEqual({
        action: "settle",
        reason: "turn-not-completed",
      });
    },
  );

  it("awaits fresh subagents and carries the shared continuation prompt", () => {
    expect(decideGraceStep(graceInput({ freshRunningCount: 2 }))).toEqual({
      action: "awaitDrain",
      prompt: EPIC_RUN_CONTINUATION_PROMPT,
      nextContinuationCount: 1,
    });
  });

  it("continues changed work without a RALPH token with the stalled prompt", () => {
    expect(decideGraceStep(graceInput())).toEqual({
      action: "continue",
      prompt: EPIC_RUN_STALLED_PROGRESS_PROMPT,
      nextContinuationCount: 1,
    });
  });

  it.each([
    ["unchanged fingerprint", { fingerprintChanged: false }, "fingerprint-not-changed"],
    ["unavailable fingerprint", { fingerprintChanged: null }, "fingerprint-not-changed"],
    ["RALPH token", { hasRalphToken: true }, "ralph-token"],
    [
      "exhausted missing output",
      { finalMessageMissing: true, finalMessageWaitExhausted: true },
      "missing-final-output",
    ],
    ["shared continuation cap", { continuationsUsed: 10 }, "continuation-cap"],
  ] as const)("settles for %s", (_name, overrides, reason) => {
    expect(decideGraceStep(graceInput(overrides))).toEqual({ action: "settle", reason });
  });

  it("applies the continuation cap before draining fresh subagents", () => {
    expect(decideGraceStep(graceInput({ freshRunningCount: 1, continuationsUsed: 10 }))).toEqual({
      action: "settle",
      reason: "continuation-cap",
    });
  });

  it("can continue while a missing final message wait is not exhausted", () => {
    expect(
      decideGraceStep(graceInput({ finalMessageMissing: true, finalMessageWaitExhausted: false })),
    ).toMatchObject({ action: "continue" });
  });
});
