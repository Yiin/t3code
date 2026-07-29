import type { BeadsIssueSummary, EpicRun } from "@t3tools/contracts";

export type EpicRunUiState = "idle" | "starting" | "running" | "stopping" | "stopped" | "failed";

export function epicRunUiState(
  run: EpicRun | null,
  pending: "starting" | "stopping" | null,
): EpicRunUiState {
  if (pending === "starting" && run === null) return "starting";
  if (pending === "stopping" && run?.status !== "done" && run?.status !== "failed") {
    return "stopping";
  }
  if (run === null) return "idle";
  if (run.status === "running" || run.status === "paused") return "running";
  if (run.status === "failed") return "failed";
  return "stopped";
}

export function shouldStickToBottom(
  metrics: Pick<HTMLElement, "scrollHeight" | "scrollTop" | "clientHeight">,
  threshold = 48,
): boolean {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <= threshold;
}

export function formatEpicRunElapsed(startedAt: string, now: number): string {
  const seconds = Math.max(0, Math.floor((now - Date.parse(startedAt)) / 1_000));
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainder = seconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
    : `${minutes}:${String(remainder).padStart(2, "0")}`;
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
