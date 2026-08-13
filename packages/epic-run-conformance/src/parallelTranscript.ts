/**
 * The normalized transcript of a pool run, shared by all three drivers.
 *
 * A sequential run settles one worker at a time, so the order it publishes
 * events in is itself part of the contract. A pool run has no such order: two
 * workers settle whenever their agents finish, so the same run produces a
 * different event order on every host. Diffing raw order would test the
 * scheduler's luck rather than its behaviour.
 *
 * So a parallel scenario asserts on per-child outcomes instead. Every driver
 * reduces its own record — the core journal, the server store, the terminal
 * mailbox — to the settled iteration rows below, and this module orders them
 * by child and renumbers them. Two drivers that agree here agree about what
 * the run did, whatever order they did it in.
 */
import type { EpicRunTranscriptEvent } from "@t3tools/contracts";

/** One settled dispatch attempt, as every driver can report it. */
export interface ParallelIterationRecord {
  readonly iterationIndex: number;
  readonly issueId: string | null;
  readonly turnStatus: "running" | "completed" | "failed" | "abandoned";
  readonly failureReason: string | null;
  /** Whether the attempt left a commit behind, however the driver proved it. */
  readonly committed: boolean;
}

/** The run's terminal row. */
export interface ParallelRunRecord {
  readonly status: string;
  readonly lastError: string | null;
}

export interface ParallelTranscriptInput {
  readonly epicId: string;
  readonly iterations: ReadonlyArray<ParallelIterationRecord>;
  readonly run: ParallelRunRecord;
  /** Bead comment counts after the run, for no-commit evidence. */
  readonly comments: ReadonlyMap<string, number>;
  /** Children whose standing claim the run handed back. */
  readonly releasedClaims: ReadonlySet<string>;
}

/**
 * Why the run stopped, in the same words the sequential transcripts use.
 *
 * The two pool-only verdicts are the dispatch cap and the stuck frontier: both
 * are completion proofs the sequential loop never has to make, because it can
 * only ever have one worker in flight.
 */
const failureReason = (lastError: string | null): string => {
  if (lastError === null) return "child failure budget";
  if (lastError.startsWith("limit:max-iterations:")) return "dispatch cap with open children";
  if (lastError.startsWith("infra:ready-frontier-stuck:")) return "ready frontier stuck";
  if (lastError.startsWith("infra:")) return "infra failure budget";
  if (lastError.startsWith("gutter:")) return "no-commit gutter";
  return "child failure budget";
};

/** Child order first, dispatch order within a child. Unclaimed rows come last. */
const settledOrder = (left: ParallelIterationRecord, right: ParallelIterationRecord): number => {
  const leftIssue = left.issueId ?? "￿";
  const rightIssue = right.issueId ?? "￿";
  if (leftIssue !== rightIssue) return leftIssue < rightIssue ? -1 : 1;
  return left.iterationIndex - right.iterationIndex;
};

export const normalizeParallelTranscript = (
  input: ParallelTranscriptInput,
): ReadonlyArray<EpicRunTranscriptEvent> => {
  const output: EpicRunTranscriptEvent[] = [];
  const settled = input.iterations
    .filter((iteration) => iteration.turnStatus !== "running")
    .toSorted(settledOrder);
  const childAttempts = new Map<string, number>();
  /** The attempt a released claim is attributed to: the child's last failure. */
  const lastFailure = new Map<string, number>();
  for (const iteration of settled) {
    if (iteration.issueId === null || iteration.turnStatus === "completed") continue;
    lastFailure.set(
      iteration.issueId,
      Math.max(lastFailure.get(iteration.issueId) ?? -1, iteration.iterationIndex),
    );
  }

  for (const [position, iteration] of settled.entries()) {
    const issueId = iteration.issueId;
    const common = {
      sequence: output.length,
      epicId: input.epicId,
      issueId,
      /**
       * The row's rank in this transcript, not the slot it was dispatched in.
       *
       * Which slot a child gets is scheduling luck: the same two-worker run
       * gives child A index 0 on one driver and index 1 on the next, purely
       * from which thread the runner allocated first. Ranking by child keeps
       * the number meaningful — a child's second attempt still follows its
       * first — without asserting on a race.
       */
      iterationIndex: position,
      pushed: false,
      verified: true,
    } as const;
    if (iteration.turnStatus === "completed") {
      if (iteration.committed) {
        output.push({ _tag: "dispatched", ...common });
        output.push({ _tag: "done", ...common, sequence: output.length });
      } else {
        output.push({
          _tag: "completed-no-code",
          ...common,
          comments: issueId === null ? 0 : (input.comments.get(issueId) ?? 0),
        });
      }
      continue;
    }
    const failure = iteration.failureReason ?? "infra:turn-error";
    const attempts =
      issueId === null
        ? 1
        : (childAttempts.set(issueId, (childAttempts.get(issueId) ?? 0) + 1),
          childAttempts.get(issueId)!);
    if (
      issueId !== null &&
      input.releasedClaims.has(issueId) &&
      lastFailure.get(issueId) === iteration.iterationIndex
    ) {
      output.push({
        _tag: "blocked",
        ...common,
        failureReason: failure,
        attempts,
        reason: "retry budget exhausted; child reopened",
      });
      continue;
    }
    output.push({ _tag: "retry", ...common, failureReason: failure, attempts });
  }

  const terminal = {
    sequence: output.length,
    epicId: input.epicId,
    issueId: null,
    iterationIndex: null,
    pushed: false,
    verified: true,
  } as const;
  if (input.run.status === "done") {
    output.push({ _tag: "finished", ...terminal, status: "done" });
  } else if (input.run.status === "failed") {
    output.push({
      _tag: "finished",
      ...terminal,
      status: "failed",
      reason: failureReason(input.run.lastError),
    });
  } else if (input.run.status === "cancelled") {
    output.push({ _tag: "finished", ...terminal, status: "cancelled" });
  }
  return output;
};
