import {
  EPIC_RUN_FAILURE_RESUME_BLOCKED,
  EPIC_RUN_FAILURE_RESUME_FAILED,
  EPIC_RUN_FAILURE_RESUME_UNSUPPORTED,
  type BeadsIssueSummary,
  type EpicRun,
  type EpicRunIterationReport,
  type EpicRunStatus,
  type RuntimeMode,
} from "@t3tools/contracts";

import { epicRunsForIdentity } from "./epicsPage.logic";

/**
 * A run action the user asked for that the server has not confirmed yet.
 * `pausing` and `resuming` never change the run's UI state — the run keeps
 * reading Running or Paused until the server says otherwise, and only the
 * button they came from shows the in-flight label.
 */
export type EpicRunPendingAction = "starting" | "stopping" | "pausing" | "resuming";

export type EpicRunUiState =
  | "idle"
  | "starting"
  | "running"
  | "pausing"
  | "paused"
  | "stopping"
  | "stopped"
  | "failed";

/** A run that can no longer move on its own. `EpicRunStatus` has no path back. */
export function isTerminalEpicRunStatus(status: EpicRunStatus): boolean {
  return status === "done" || status === "failed" || status === "cancelled";
}

/**
 * A paused run that is still finishing the iteration it was paused during.
 *
 * The server takes a pause at the next iteration boundary and deliberately does
 * not interrupt the turn (`EpicRunner.pauseRun`), so a run reads `paused` while
 * an agent is still working — minutes of it. Only the label changes: resume is
 * accepted throughout, because the server hands the run back to the loop that
 * is still draining rather than relaunching it.
 */
export function isEpicRunPauseDraining(run: EpicRun): boolean {
  return (
    run.status === "paused" &&
    run.recentIterations.some((iteration) => iteration.turnStatus === "running")
  );
}

export function epicRunUiState(
  run: EpicRun | null,
  pending: EpicRunPendingAction | null,
): EpicRunUiState {
  // A start is in flight either from a never-run epic or from a terminal one —
  // repeating a finished run is a start too, not a state of the old run.
  if (pending === "starting" && (run === null || isTerminalEpicRunStatus(run.status))) {
    return "starting";
  }
  if (pending === "stopping" && run !== null && !isTerminalEpicRunStatus(run.status)) {
    return "stopping";
  }
  if (run === null) return "idle";
  if (run.status === "running") return "running";
  // Paused is its own state: a paused run is not live, and the only control
  // that helps is Resume. While the iteration it was paused during is still
  // draining, say so — otherwise the run looks idle while an agent is working.
  if (run.status === "paused") return isEpicRunPauseDraining(run) ? "pausing" : "paused";
  if (run.status === "failed") return "failed";
  return "stopped";
}

export interface EpicStartControl {
  readonly label: string;
  /** A start the server has not acknowledged yet — the control cannot fire. */
  readonly busy: boolean;
}

/**
 * The start control for the run header, or null when starting is impossible.
 *
 * A terminal run can be repeated: `EpicRunStatus` has no path out of
 * done/failed/cancelled, so a new run is the only way to run the epic again,
 * and without this the epic could be started exactly once from the browser.
 * A live run (running, paused, stopping) offers no start — pause, resume, and
 * stop are the controls that apply there.
 */
export function epicStartControl(
  run: EpicRun | null,
  state: EpicRunUiState,
): EpicStartControl | null {
  if (state === "idle") return { label: "Start run", busy: false };
  if (state === "stopped" || state === "failed") return { label: "Start new run", busy: false };
  // A never-run epic shows the standalone "Starting run…" placeholder instead,
  // so only a repeat needs the control to stay put and go busy.
  if (state === "starting" && run !== null) return { label: "Starting…", busy: true };
  return null;
}

export interface EpicRunHistory {
  /** The run the page puts its controls on, expanded. */
  readonly latest: EpicRun | null;
  /** Everything older, newest first, collapsed. */
  readonly prior: ReadonlyArray<EpicRun>;
}

/**
 * Every run this epic has had, newest first. Ordered by `updatedAt` then
 * `runId` so `latest` is the same run `latestEpicRunForIdentity` picks for the
 * list-page pill — the detail page must not disagree with the row that opened
 * it.
 */
export function epicRunHistory(
  runs: ReadonlyArray<EpicRun>,
  identity: { readonly epicId: string; readonly projectId: string; readonly cwd: string },
): EpicRunHistory {
  const ordered = [...epicRunsForIdentity(runs, identity)].sort((left, right) => {
    if (left.updatedAt !== right.updatedAt) return left.updatedAt < right.updatedAt ? 1 : -1;
    return left.runId < right.runId ? 1 : -1;
  });
  return { latest: ordered[0] ?? null, prior: ordered.slice(1) };
}

/**
 * Has the run the server acknowledged reached the client's history yet? A
 * launch answers with the run it started — or with an already-active run it
 * found instead — so the pending start clears on that exact run appearing,
 * never on "some run exists" (which is already true for a repeat).
 */
export function epicRunHistoryHasRun(history: EpicRunHistory, runId: string): boolean {
  return history.latest?.runId === runId || history.prior.some((run) => run.runId === runId);
}

export function epicRunIterationCountLabel(count: number): string {
  return `${count} ${count === 1 ? "iteration" : "iterations"}`;
}

const RUNTIME_MODE_LABELS = {
  "approval-required": "Supervised",
  "auto-accept-edits": "Auto-accept edits",
  "full-access": "Full access",
} satisfies Record<RuntimeMode, string>;

export function epicRuntimeModeLabel(mode: RuntimeMode): string {
  return RUNTIME_MODE_LABELS[mode];
}

export function shouldStickToBottom(
  metrics: Pick<HTMLElement, "scrollHeight" | "scrollTop" | "clientHeight">,
  threshold = 48,
): boolean {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <= threshold;
}

export function formatEpicRunElapsed(startedAt: string, now: number): string {
  const started = Date.parse(startedAt);
  if (!Number.isFinite(started) || !Number.isFinite(now)) return "0:00";
  const seconds = Math.max(0, Math.floor((now - started) / 1_000));
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainder = seconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
    : `${minutes}:${String(remainder).padStart(2, "0")}`;
}

/**
 * How long one iteration took, or how long the running one has been going.
 * `startedAt`/`finishedAt` already ride the contract and were being dropped.
 */
export function epicRunIterationDuration(
  iteration: Pick<EpicRunIterationReport, "startedAt" | "finishedAt">,
  now: number,
): string {
  const finished = iteration.finishedAt === null ? Number.NaN : Date.parse(iteration.finishedAt);
  return formatEpicRunElapsed(iteration.startedAt, Number.isFinite(finished) ? finished : now);
}

/**
 * That this iteration covers more than one server lifetime, or null when it
 * never stopped. A resume reuses the interrupted row, so without this line the
 * log freezes and then continues with nothing to explain the gap.
 */
export function epicRunIterationResumeLabel(
  iteration: Pick<EpicRunIterationReport, "resumeCount">,
): string | null {
  if (iteration.resumeCount <= 0) return null;
  return iteration.resumeCount === 1
    ? "resumed after restart"
    : `resumed ${iteration.resumeCount} times`;
}

/**
 * Human copy for the resume family of `failureReason`, and null for every
 * other reason. Deliberately narrow: the rest of the vocabulary reads well
 * enough raw, and a full map would just duplicate the schema's doc comment.
 */
const RESUME_FAILURE_LABELS: Record<string, string> = {
  [EPIC_RUN_FAILURE_RESUME_UNSUPPORTED]: "provider cannot resume a session",
  [EPIC_RUN_FAILURE_RESUME_BLOCKED]: "session could not be resumed",
  [EPIC_RUN_FAILURE_RESUME_FAILED]: "resume failed",
  "infra:run-terminal-sweep": "abandoned when the run went terminal",
};

export function epicRunFailureReasonLabel(reason: string): string | null {
  return RESUME_FAILURE_LABELS[reason] ?? null;
}

/**
 * The one sentence a run gets when its newest iteration died of a failed
 * resume. The error box above it carries the provider's own words; this says
 * what the user can do about it.
 */
export function epicRunResumeFailureNotice(run: Pick<EpicRun, "recentIterations">): string | null {
  const newest = run.recentIterations.at(-1);
  if (!newest?.failureReason) return null;
  if (epicRunFailureReasonLabel(newest.failureReason) === null) return null;
  return "The interrupted iteration could not be continued, so the run stopped. Starting a new run begins a fresh iteration.";
}

export function currentEpicRunIssue(
  run: EpicRun,
  issues: ReadonlyArray<BeadsIssueSummary>,
): { readonly issue: BeadsIssueSummary; readonly threadId: string } | null {
  const current =
    run.recentIterations.toReversed().find((iteration) => iteration.turnStatus === "running") ??
    run.recentIterations.at(-1);
  if (!current?.issueId) return null;
  const issue = issues.find((candidate) => candidate.id === current.issueId);
  return issue ? { issue, threadId: current.threadId } : null;
}
