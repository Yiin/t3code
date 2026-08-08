import type { EpicRunStatus } from "@t3tools/contracts";

import {
  iterationFailureClass,
  type EpicIterationOutcome,
  type EpicIterationOutcomeKind,
  type IterationTurnState,
} from "./ralphProtocol.ts";

/** Generous by default because one unit of epic work can take hours. */
export const DEFAULT_ITERATION_TIMEOUT_MS = 2 * 60 * 60 * 1000;
export const DEFAULT_RETRY_BASE_DELAY_MS = 10_000;
export const DEFAULT_RETRY_MAX_DELAY_MS = 5 * 60 * 1000;
export const DEFAULT_MAX_CONSECUTIVE_FAILURES = 3;
export const DEFAULT_MAX_NO_COMMIT_STREAK = 2;
/**
 * How many consecutive infra failures a run absorbs with backoff before it
 * fails. This is above the child failure budget, but remains finite.
 */
export const DEFAULT_INFRA_FAILURE_BUDGET = 5;
export const DEFAULT_MAX_ITERATIONS = 50;

/** Terminal parity: `skills/cook-epic/run-legacy.sh:3053-3056`. */
export const landingDescription = (input: {
  readonly pushEnabled: boolean;
  readonly verified: boolean;
}):
  | "gated, landed locally"
  | "landed unverified locally"
  | "gated, pushed, landed"
  | "pushed, landed unverified" => {
  if (input.pushEnabled) {
    return input.verified ? "gated, pushed, landed" : "pushed, landed unverified";
  }
  return input.verified ? "gated, landed locally" : "landed unverified locally";
};

/** Terminal parity: `skills/cook-epic/run-legacy.sh:2675-2681`. */
export const childBranch = (childId: string): string => `epic/${childId}`;

/** Terminal parity: `skills/cook-epic/run-legacy.sh:2845-2890`. */
export type MergeParkReason = "conflict" | "gate-failed";

/** Terminal parity: `skills/cook-epic/run-legacy.sh:2882`. */
export const mergeFixTitle = (branch: string, reason: MergeParkReason): string =>
  `Merge fix: land ${branch} (${reason})`;

/** Terminal parity: `skills/cook-epic/run-legacy.sh:2675-2679`. */
const MERGE_FIX_TITLE_PATTERN = /^Merge fix: land ([^ ]+) \((conflict|gate-failed)\)$/;

export const parseMergeFixTitle = (
  title: string,
): { readonly branch: string; readonly reason: MergeParkReason } | null => {
  const match = MERGE_FIX_TITLE_PATTERN.exec(title);
  if (match?.[1] === undefined || match[2] === undefined) return null;
  return { branch: match[1], reason: match[2] as MergeParkReason };
};

/** Terminal parity: `skills/cook-epic/run-legacy.sh:2885`. */
export const parkedBranchKey = (branch: string): string => branch.replaceAll("/", "_");

/** One repository a parked branch set touched. */
export interface MergeFixTouchedRepo {
  readonly kind: "main" | "sibling";
  readonly path: string;
  readonly baseBranch: string;
}

/** Terminal parity: `skills/cook-epic/run-legacy.sh:2863-2881` (single repo) and
 * `skills/cook-epic/run-legacy.sh:2843-2879` (branch set). A non-empty
 * `touchedRepos` produces the multi-repo variant; omitting it keeps the
 * single-repo text byte-identical. */
export const mergeFixDescription = (input: {
  readonly childId: string;
  readonly branch: string;
  readonly baseBranch: string;
  readonly reason: MergeParkReason;
  readonly gateCommand: string | null;
  readonly pushEnabled: boolean;
  readonly touchedRepos?: ReadonlyArray<MergeFixTouchedRepo>;
}): string => {
  const touched = input.touchedRepos ?? [];
  let description: string;
  if (touched.length > 0) {
    const setLines = touched.map((repo) =>
      repo.kind === "main"
        ? `- this repository (\`${repo.path}\`, base \`${repo.baseBranch}\`)`
        : `- sibling \`${repo.path}\` (base \`${repo.baseBranch}\`)`,
    );
    description = `Branch \`${input.branch}\` (child \`${input.childId}\`) failed to land: ${input.reason}. The branch set spans several repositories and lands all-or-nothing; the whole set is parked together:\n\n${setLines.join("\n")}\n\nRepair procedure: you will be on branch \`${input.branch}\` in an isolated layout, with the same branch checked out in each sibling worktree beside your main worktree. In EVERY repository listed above, merge that repository's base branch into \`${input.branch}\` and resolve conflicts`;
  } else {
    description = `Branch \`${input.branch}\` (child \`${input.childId}\`) failed to land on \`${input.baseBranch}\`: ${input.reason}.\n\nRepair procedure: you will be on branch \`${input.branch}\` in an isolated worktree. Merge \`${input.baseBranch}\` into it, resolve conflicts`;
  }
  description +=
    input.reason === "conflict"
      ? ", then run the project quality gates"
      : `. The integration gate is: \`${input.gateCommand ?? ""}\` — run it and fix what it reports`;
  description += input.pushEnabled
    ? ". Push the branch, close this issue, and note the epic."
    : ". Do not push (disabled this run). Close this issue and note the epic.";
  return touched.length > 0
    ? `${description} Do NOT merge into any base branch yourself, and never push sibling repos — the coordinator re-lands the whole set when this issue closes.`
    : `${description} Do NOT merge into ${input.baseBranch} yourself.`;
};

/** Terminal parity: `skills/cook-epic/run-legacy.sh:2958`. */
export const trialMergeMessage = (branch: string, childId: string): string =>
  `cook-epic: merge ${branch} (${childId})`;

/** Terminal parity: integration branch creation near `skills/cook-epic/run-legacy.sh:873-881`. */
export const INTEGRATION_BRANCH_PREFIX = "cook-epic-integration-";
export const integrationBranch = (runId: string): string => `${INTEGRATION_BRANCH_PREFIX}${runId}`;

export const EPIC_RUN_ITERATION_PROMPT = `Complete one well-scoped unit of work for this epic end-to-end. Use bd to select and claim the top-priority ready child, implement it, run the focused quality gates, commit and push, close the child, and update the epic progress note. Stop after one child. This is an unattended one-turn iteration: nothing re-invokes you after your turn ends. Run all work in the foreground. Never end your turn while a background task, workflow, or watchdog is still running; if you started one, wait for it and report its outcome before ending the turn. If no work remains, output RALPH_DONE. End a completed iteration with exactly one line: RALPH_MSG: {"summary":"<what you built, one clause>","why":"<why it was needed, one clause>"}`;

/** The follow-up turn used after an iteration's background agents settle. */
export const EPIC_RUN_CONTINUATION_PROMPT = `Your background tasks finished. Complete the iteration per the original instructions: finish the child end-to-end, then end your turn with the required RALPH_MSG line (or RALPH_DONE if no work remains).`;

export const EPIC_RUN_STALLED_PROGRESS_PROMPT = `Your turn ended early while work was still in progress. Complete the iteration per the original instructions: finish the child end-to-end, then end your turn with the required RALPH_MSG line (or RALPH_DONE if no work remains).`;

/** How long the runner waits for a still-running subagent before grace ends. */
export const DEFAULT_SUBAGENT_GRACE_TIMEOUT_MS = 15 * 60 * 1_000;
export const DEFAULT_MAX_GRACE_CONTINUATIONS = 10;

export const backoffDelayMs = (
  consecutiveFailures: number,
  retryBaseDelayMs: number,
  retryMaxDelayMs: number,
): number => Math.min(retryBaseDelayMs * 2 ** (consecutiveFailures - 1), retryMaxDelayMs);

/** The stable suffix used by the persisted iteration failure vocabulary. */
export const failureReasonForOutcome = (kind: EpicIterationOutcomeKind): string | null => {
  switch (kind) {
    case "done":
    case "backlog-empty":
      return null;
    case "no-commit":
      return "no-commit-child-open";
    case "timeout":
      return "timeout";
    case "error":
      return "turn-error";
    case "protocol-error":
      return "protocol-error";
    case "blocked":
      return "blocked";
  }
};

export interface PersistedFailureReasonInput {
  readonly iterationStatus: "completed" | "failed";
  readonly dispatchFailed: boolean;
  readonly evidenceFailureReason: string | null;
  readonly outcome: EpicIterationOutcome;
}

/** Build the complete persisted failure reason in its required override order. */
export const persistedFailureReason = (input: PersistedFailureReasonInput): string | null => {
  if (input.iterationStatus === "completed") {
    return null;
  }
  const reason = input.dispatchFailed
    ? "dispatch-failed"
    : (input.evidenceFailureReason ??
      input.outcome.failureReason ??
      failureReasonForOutcome(input.outcome.kind));
  const failureClass = iterationFailureClass(input.outcome.kind);
  return failureClass === null || reason === null ? null : `${failureClass}:${reason}`;
};

/**
 * The ready frontier of one epic, partitioned for the parallel loop.
 *
 * `bd ready --parent` owns the scope, but some rows omit the parent value,
 * which decodes to null and is usable. Only an explicit parent naming another
 * issue rejects the row.
 */
export type ReadyFrontierPartition<Issue> =
  | { readonly _tag: "empty" }
  | { readonly _tag: "unrecognised"; readonly candidateIds: ReadonlyArray<string> }
  | { readonly _tag: "children"; readonly issues: ReadonlyArray<Issue> };

export const partitionReadyChildren = <Issue extends { readonly id: string }>(
  epicId: string,
  issues: ReadonlyArray<Issue & { readonly parentId: string | null }>,
): ReadyFrontierPartition<Issue> => {
  if (issues.length === 0) return { _tag: "empty" };
  const direct = issues.filter((issue) => issue.parentId === null || issue.parentId === epicId);
  return direct.length === 0
    ? { _tag: "unrecognised", candidateIds: issues.map((issue) => issue.id) }
    : { _tag: "children", issues: direct };
};

export interface IterationBoundaryLimits {
  readonly maxConsecutiveFailures: number;
  readonly maxNoCommitStreak: number;
  readonly infraFailureBudget: number;
  readonly retryBaseDelayMs: number;
  readonly retryMaxDelayMs: number;
}

export interface IterationBoundaryInput {
  readonly runStatus: EpicRunStatus;
  readonly consecutiveFailures: number;
  readonly noCommitStreak: number;
  readonly infraStreak: number;
  readonly lastError: string | null;
  readonly outcome: EpicIterationOutcome;
  readonly noCommitChildClosed: boolean;
  readonly providerFallbackApplied: boolean;
  /** Backlog selection can finish without dispatching a provider turn. */
  readonly providerTurnDispatched: boolean;
  readonly limits: IterationBoundaryLimits;
}

export interface IterationBoundaryDecision {
  readonly action: "stop" | "continue";
  readonly delayMs: number;
  /** `null` leaves the run's current status unchanged. */
  readonly nextStatus: EpicRunStatus | null;
  readonly nextConsecutiveFailures: number;
  readonly nextNoCommitStreak: number;
  readonly nextInfraStreak: number;
  readonly lastError: string | null;
}

/**
 * Decide one iteration boundary without reading or writing runner state.
 * Branch order is part of the terminal and server parity contract.
 */
export const decideIterationBoundary = (
  input: IterationBoundaryInput,
): IterationBoundaryDecision => {
  const unchanged = {
    delayMs: 0,
    nextStatus: null,
    nextConsecutiveFailures: input.consecutiveFailures,
    nextNoCommitStreak: input.noCommitStreak,
    nextInfraStreak: input.infraStreak,
    lastError: input.lastError,
  } as const;

  if (input.providerFallbackApplied) {
    return {
      ...unchanged,
      action: input.runStatus === "running" ? "continue" : "stop",
      nextInfraStreak: 0,
    };
  }

  if (input.runStatus !== "running") {
    return { ...unchanged, action: "stop" };
  }

  if (input.outcome.kind === "backlog-empty") {
    return {
      ...unchanged,
      action: "stop",
      nextStatus: "done",
      nextConsecutiveFailures: 0,
      ...(input.providerTurnDispatched ? { nextNoCommitStreak: 0, nextInfraStreak: 0 } : undefined),
      lastError: null,
    };
  }

  if (input.outcome.kind === "done") {
    return {
      ...unchanged,
      action: "continue",
      nextConsecutiveFailures: 0,
      nextNoCommitStreak: 0,
      nextInfraStreak: 0,
      lastError: null,
    };
  }

  if (input.noCommitChildClosed) {
    return {
      ...unchanged,
      action: "continue",
      nextConsecutiveFailures: 0,
      nextNoCommitStreak: 0,
      nextInfraStreak: 0,
      lastError: null,
    };
  }

  if (input.outcome.kind === "no-commit") {
    const nextNoCommitStreak = input.noCommitStreak + 1;
    const exhausted = nextNoCommitStreak >= input.limits.maxNoCommitStreak;
    return {
      ...unchanged,
      action: exhausted ? "stop" : "continue",
      nextStatus: exhausted ? "failed" : null,
      nextConsecutiveFailures: 0,
      nextNoCommitStreak,
      lastError: exhausted ? `gutter: ${nextNoCommitStreak} iterations without a commit` : null,
    };
  }

  if (iterationFailureClass(input.outcome.kind) === "infra") {
    const nextInfraStreak = input.infraStreak + 1;
    const exhausted = nextInfraStreak >= input.limits.infraFailureBudget;
    const reason = input.outcome.detail ?? input.outcome.kind;
    return {
      ...unchanged,
      action: exhausted ? "stop" : "continue",
      delayMs: backoffDelayMs(
        nextInfraStreak,
        input.limits.retryBaseDelayMs,
        input.limits.retryMaxDelayMs,
      ),
      nextStatus: exhausted ? "failed" : null,
      nextInfraStreak,
      lastError: exhausted
        ? `infra: ${nextInfraStreak} consecutive infrastructure failures; last: ${reason}`
        : reason,
    };
  }

  const nextConsecutiveFailures = input.consecutiveFailures + 1;
  const exhausted = nextConsecutiveFailures >= input.limits.maxConsecutiveFailures;
  return {
    ...unchanged,
    action: exhausted ? "stop" : "continue",
    delayMs: backoffDelayMs(
      nextConsecutiveFailures,
      input.limits.retryBaseDelayMs,
      input.limits.retryMaxDelayMs,
    ),
    nextStatus: exhausted ? "failed" : null,
    nextConsecutiveFailures,
    lastError: input.outcome.detail ?? input.outcome.kind,
  };
};

export interface GraceDecisionInput {
  readonly headMoved: boolean;
  readonly turnStatus: IterationTurnState;
  readonly freshRunningCount: number;
  /** `null` means one or both worktree fingerprints were unavailable. */
  readonly fingerprintChanged: boolean | null;
  readonly hasRalphToken: boolean;
  readonly finalMessageMissing: boolean;
  readonly finalMessageWaitExhausted: boolean;
  readonly continuationsUsed: number;
  readonly maxGraceContinuations: number;
}

export type GraceDecision =
  | {
      readonly action: "settle";
      readonly reason:
        | "head-moved"
        | "turn-not-completed"
        | "continuation-cap"
        | "fingerprint-not-changed"
        | "ralph-token"
        | "missing-final-output";
    }
  | {
      readonly action: "awaitDrain";
      readonly prompt: typeof EPIC_RUN_CONTINUATION_PROMPT;
      readonly nextContinuationCount: number;
    }
  | {
      readonly action: "continue";
      readonly prompt: typeof EPIC_RUN_STALLED_PROGRESS_PROMPT;
      readonly nextContinuationCount: number;
    };

/** Decide whether a settled turn earns one bounded grace continuation. */
export const decideGraceStep = (input: GraceDecisionInput): GraceDecision => {
  if (input.headMoved) {
    return { action: "settle", reason: "head-moved" };
  }
  if (input.turnStatus !== "completed") {
    return { action: "settle", reason: "turn-not-completed" };
  }

  if (input.freshRunningCount > 0) {
    if (input.continuationsUsed >= input.maxGraceContinuations) {
      return { action: "settle", reason: "continuation-cap" };
    }
    return {
      action: "awaitDrain",
      prompt: EPIC_RUN_CONTINUATION_PROMPT,
      nextContinuationCount: input.continuationsUsed + 1,
    };
  }

  if (input.fingerprintChanged !== true) {
    return { action: "settle", reason: "fingerprint-not-changed" };
  }
  if (input.hasRalphToken) {
    return { action: "settle", reason: "ralph-token" };
  }
  if (input.finalMessageMissing && input.finalMessageWaitExhausted) {
    return { action: "settle", reason: "missing-final-output" };
  }
  if (input.continuationsUsed >= input.maxGraceContinuations) {
    return { action: "settle", reason: "continuation-cap" };
  }

  return {
    action: "continue",
    prompt: EPIC_RUN_STALLED_PROGRESS_PROMPT,
    nextContinuationCount: input.continuationsUsed + 1,
  };
};
