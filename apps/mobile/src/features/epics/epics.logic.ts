import type {
  BeadsEpicSummary,
  BeadsIssueSummary,
  BeadsStatusResult,
  EpicRun,
} from "@t3tools/contracts";

export interface EpicProjectSource {
  readonly environmentId: string;
  readonly workspaceRoot: string;
  readonly projectId: string;
  readonly projectTitle: string;
}

export interface EpicSourceResult {
  readonly project: EpicProjectSource;
  readonly result: BeadsStatusResult | null;
  readonly error?: string | null;
  readonly pending?: boolean;
  readonly refresh?: () => void;
}

export function epicSourceKey(source: Pick<EpicProjectSource, "environmentId" | "workspaceRoot">) {
  return `${source.environmentId}\0${source.workspaceRoot}`;
}

export function uniqueEpicProjectSources(
  projects: ReadonlyArray<EpicProjectSource>,
): ReadonlyArray<EpicProjectSource> {
  const seen = new Set<string>();
  return projects.filter((project) => {
    const key = `${project.environmentId}\0${project.workspaceRoot}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function epicLoadState(sources: ReadonlyArray<EpicSourceResult>) {
  const pending = sources.filter((source) => source.pending).length;
  const failed = sources.filter(
    (source) => source.error !== null && source.error !== undefined,
  ).length;
  const unavailable = sources.filter((source) => source.result?._tag === "unavailable").length;
  const available = sources.filter((source) => source.result?._tag === "available").length;
  return {
    pending,
    failed: failed + unavailable,
    available,
    allFailed: sources.length > 0 && pending === 0 && failed + unavailable === sources.length,
    partialFailed: available > 0 && failed + unavailable > 0,
  };
}

export function epicChildren(
  epicId: string,
  issues: ReadonlyArray<BeadsIssueSummary>,
): ReadonlyArray<BeadsIssueSummary> {
  return issues.filter((issue) => issue.parent === epicId);
}

export function epicProgress(epic: BeadsEpicSummary): {
  readonly done: number;
  readonly total: number;
} {
  const done = (epic.childCounts.byStatus.closed ?? 0) + (epic.childCounts.byStatus.done ?? 0);
  return { done, total: epic.childCounts.total };
}

export function isActiveRun(run: EpicRun | null | undefined): boolean {
  return run?.status === "running" || run?.status === "paused";
}

export function selectEpicDetail(
  sources: ReadonlyArray<EpicSourceResult>,
  epicId: string,
  projectId?: string,
) {
  const matches = sources.flatMap((source) => {
    if (source.result?._tag !== "available") return [];
    const epic = source.result.epics.find((candidate) => candidate.id === epicId);
    return epic ? [{ ...source, epic }] : [];
  });
  if (projectId) return matches.find((match) => match.project.projectId === projectId) ?? null;
  return matches.length === 1 ? matches[0] : null;
}

export function latestEpicThreadId(run: EpicRun | null, issueId: string): string | null {
  if (!run) return null;
  return (
    run.threadRefs.reduce<(typeof run.threadRefs)[number] | null>(
      (latest, ref) =>
        ref.issueId === issueId && (!latest || ref.iterationIndex > latest.iterationIndex)
          ? ref
          : latest,
      null,
    )?.threadId ?? null
  );
}

export type EpicRunUiState =
  | "idle"
  | "starting"
  | "running"
  | "paused"
  | "stopping"
  | "terminal"
  | "failed";

export function epicRunUiState(
  run: EpicRun | null,
  pending: "starting" | "stopping" | null,
): EpicRunUiState {
  if (pending === "starting") return "starting";
  if (pending === "stopping" && run && !["done", "failed", "cancelled"].includes(run.status)) {
    return "stopping";
  }
  if (!run) return "idle";
  if (run.status === "running") return "running";
  if (run.status === "paused") return "paused";
  if (run.status === "failed") return "failed";
  return "terminal";
}

export function boundedRunLog<T>(items: ReadonlyArray<T>, limit = 40): ReadonlyArray<T> {
  return items.slice(Math.max(0, items.length - limit));
}

export function installPrefillIfEmpty(current: string, prefill: string): string {
  return current.length === 0 ? prefill : current;
}

export function nextInitialPromptInstall(
  current: string,
  prefill: string | undefined,
  requestId: string | undefined,
  appliedRequest: string | null,
): { readonly prompt: string; readonly appliedRequest: string | null } {
  if (!prefill) return { prompt: current, appliedRequest };
  const identity = requestId ?? prefill;
  if (appliedRequest === identity) return { prompt: current, appliedRequest };
  return {
    prompt: installPrefillIfEmpty(current, prefill),
    appliedRequest: identity,
  };
}

export function pendingAfterCommandResult(
  pending: "starting" | "stopping",
  result: "success" | "interrupted" | "failure",
): "starting" | "stopping" | null {
  return result === "success" ? pending : null;
}
