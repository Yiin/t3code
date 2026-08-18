import type {
  BeadsEpicSummary,
  BeadsIssueSummary,
  BeadsStatusResult,
  EnvironmentId,
  EpicRun,
  ProjectId,
} from "@t3tools/contracts";

export interface EpicProjectSource {
  readonly environmentId: EnvironmentId;
  readonly workspaceRoot: string;
  readonly projectId: ProjectId;
  readonly projectTitle: string;
}

export interface EpicCounts {
  readonly ready: number;
  readonly blocked: number;
  readonly done: number;
}

export function epicCounts(epic: BeadsEpicSummary): EpicCounts {
  const done = (epic.childCounts.byStatus.closed ?? 0) + (epic.childCounts.byStatus.done ?? 0);
  return {
    ready: epic.childCounts.ready,
    blocked: Object.entries(epic.childCounts.byStatus).reduce(
      (total, [status, count]) =>
        status === "blocked" || status === "deferred" ? total + count : total,
      0,
    ),
    done,
  };
}

export function epicStatusLabel(status: string): string {
  switch (status) {
    case "open":
      return "Open";
    case "in_progress":
      return "In progress";
    case "closed":
    case "done":
      return "Done";
    case "blocked":
      return "Blocked";
    default:
      return status.replaceAll("_", " ");
  }
}

/** Ids listed before the label falls back to a count, so a row cannot run away. */
const BLOCKER_IDS_SHOWN = 2;

/**
 * What a child row says under its title. Naming the blocker beats the bd status
 * here: bd leaves a waiting issue as "open", so the row would otherwise read
 * "Open" next to the blocked icon and leave the reader to reconcile the two.
 */
export function issueStatusLabel(issue: Pick<BeadsIssueSummary, "status" | "blockedBy">): string {
  if (issue.status === "closed" || issue.status === "done") return "Done";
  if (issue.blockedBy.length === 0) return epicStatusLabel(issue.status);
  const shown = issue.blockedBy.slice(0, BLOCKER_IDS_SHOWN).join(", ");
  const rest = issue.blockedBy.length - BLOCKER_IDS_SHOWN;
  return rest > 0 ? `Blocked by ${shown} +${rest} more` : `Blocked by ${shown}`;
}

export function epicPresentationStatus(
  epic: BeadsEpicSummary,
  run: EpicRun | null,
): "running" | "blocked" | "done" | "open" | "unknown" {
  if (run?.status === "running") return "running";
  if (epic.status === "blocked") return "blocked";
  if (epic.status === "closed" || epic.status === "done") return "done";
  if (epic.status === "open" || epic.status === "in_progress") return "open";
  return "unknown";
}

export function epicChildren(
  epicId: string,
  issues: ReadonlyArray<BeadsIssueSummary>,
): ReadonlyArray<BeadsIssueSummary> {
  return issues.filter((issue) => issue.parent === epicId);
}

export function latestEpicThreadId(run: EpicRun | null, issueId: string): string | null {
  if (run === null) return null;
  return (
    run.threadRefs.reduce<(typeof run.threadRefs)[number] | null>(
      (latest, ref) =>
        ref.issueId === issueId && (latest === null || ref.iterationIndex > latest.iterationIndex)
          ? ref
          : latest,
      null,
    )?.threadId ?? null
  );
}

/**
 * One beads snapshot is fetched per (environment, workspace) pair, so that pair
 * is the key everything about a project source is stored under.
 */
export function epicSourceKey(source: {
  readonly environmentId: string;
  readonly workspaceRoot: string;
}): string {
  return `${source.environmentId}\0${source.workspaceRoot}`;
}

export function uniqueEpicProjectSources(
  projects: ReadonlyArray<EpicProjectSource>,
): ReadonlyArray<EpicProjectSource> {
  const seen = new Set<string>();
  return projects.filter((project) => {
    const key = epicSourceKey(project);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function availableEpicGroups(
  sources: ReadonlyArray<{
    readonly project: EpicProjectSource;
    readonly result: BeadsStatusResult | null;
  }>,
) {
  return sources.flatMap(({ project, result }) =>
    result?._tag === "available" && result.epics.length > 0 ? [{ project, snapshot: result }] : [],
  );
}

export function selectEpicDetail(
  sources: ReadonlyArray<{
    readonly project: EpicProjectSource;
    readonly result: BeadsStatusResult | null;
  }>,
  epicId: string,
  projectId?: string,
) {
  const ordered = [...sources].sort((left, right) => {
    if (left.project.projectId === projectId) return -1;
    if (right.project.projectId === projectId) return 1;
    return left.project.projectId.localeCompare(right.project.projectId);
  });
  for (const source of ordered) {
    const snapshot = source.result?._tag === "available" ? source.result : null;
    if (snapshot === null) continue;
    const epic = snapshot.epics.find((candidate) => candidate.id === epicId);
    if (epic) return { project: source.project, snapshot, epic };
  }
  return null;
}

export interface EpicResultState {
  readonly available: number;
  readonly unavailable: number;
}

export function epicResultState(results: ReadonlyArray<BeadsStatusResult | null>): EpicResultState {
  let available = 0;
  let unavailable = 0;
  for (const result of results) {
    if (result?._tag === "available") available += 1;
    if (result?._tag === "unavailable") unavailable += 1;
  }
  return { available, unavailable };
}

export function parseEpicRouteParams(params: {
  readonly environmentId?: string;
  readonly epicId?: string;
}): { readonly environmentId: string; readonly epicId: string } | null {
  return params.environmentId && params.epicId
    ? { environmentId: params.environmentId, epicId: params.epicId }
    : null;
}
