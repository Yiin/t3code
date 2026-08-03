import type {
  BeadsIssueSummary,
  EpicRun,
  EpicRunIterationReport,
  EpicRunStatus,
  RuntimeMode,
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
  | "paused"
  | "stopping"
  | "stopped"
  | "failed";

/** A run that can no longer move on its own. `EpicRunStatus` has no path back. */
export function isTerminalEpicRunStatus(status: EpicRunStatus): boolean {
  return status === "done" || status === "failed" || status === "cancelled";
}

export function epicRunUiState(
  run: EpicRun | null,
  pending: EpicRunPendingAction | null,
): EpicRunUiState {
  if (pending === "starting" && run === null) return "starting";
  if (pending === "stopping" && run !== null && !isTerminalEpicRunStatus(run.status)) {
    return "stopping";
  }
  if (run === null) return "idle";
  if (run.status === "running") return "running";
  // Paused is its own state: a paused run is not live, and the only control
  // that helps is Resume.
  if (run.status === "paused") return "paused";
  if (run.status === "failed") return "failed";
  return "stopped";
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

export function epicRunIterationCountLabel(count: number): string {
  return `${count} ${count === 1 ? "iteration" : "iterations"}`;
}

const RUNTIME_MODE_LABELS: Record<RuntimeMode, string> = {
  "approval-required": "Supervised",
  "auto-accept-edits": "Auto-accept edits",
  "full-access": "Full access",
};

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
