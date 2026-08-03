import type {
  BeadsEpicSummary,
  BeadsStatusResult,
  BeadsUnavailableReason,
  EpicRun,
  EpicRunStatus,
} from "@t3tools/contracts";
import { latestEpicRunForIdentity } from "@t3tools/client-runtime/state/epics";

import {
  epicCounts,
  epicPresentationStatus,
  epicSourceKey,
  epicStatusLabel,
  type EpicCounts,
  type EpicProjectSource,
} from "./epics.logic";
import { resolveEpicRunStatusPill, type EpicRunStatusPill } from "./components/Sidebar.logic";

/**
 * The epic as the page reads it. The beads snapshot carries the recency signal
 * itself (`lastActivityAt`, already rolled up over the epic's children), so this
 * is the contract type unchanged — the alias only keeps the page's vocabulary.
 */
export type EpicPageSummary = BeadsEpicSummary;

/**
 * Epic ids are unique only inside one beads DB, so two projects cloned from the
 * same repo share them. Every row identity carries the workspace it came from.
 */
export interface EpicRowIdentity {
  readonly environmentId: string;
  readonly workspaceRoot: string;
  readonly epicId: string;
}

export function epicRowKey(identity: EpicRowIdentity): string {
  return `${epicSourceKey(identity)}\0${identity.epicId}`;
}

/**
 * What the epic itself says: title, id, child counts, bead status. Never reads
 * a run — a failed run must not repaint an epic whose children all landed.
 */
export interface EpicWorkChannel {
  readonly title: string;
  readonly epicId: string;
  readonly counts: EpicCounts;
  readonly statusLabel: string;
  /** Never `"running"`: the work channel does not know runs exist. */
  readonly tone: ReturnType<typeof epicPresentationStatus>;
  readonly lastActivityAt: string | null;
}

/**
 * What the machinery says: the latest run's pill, when it last moved, and how
 * many runs this epic has. Never reads the bead status.
 */
export interface EpicMachineryChannel {
  readonly runStatus: EpicRunStatus | null;
  readonly pill: EpicRunStatusPill | null;
  readonly updatedAt: string | null;
  readonly runCount: number;
  readonly latestRunId: string | null;
  /** `"No runs"` when the epic has never been run, otherwise `null`. */
  readonly emptyLabel: string | null;
}

export interface EpicRowModel {
  readonly key: string;
  readonly identity: EpicRowIdentity;
  readonly project: EpicProjectSource;
  readonly work: EpicWorkChannel;
  readonly machinery: EpicMachineryChannel;
}

const NO_RUNS_LABEL = "No runs";

export function epicRunsForIdentity(
  runs: ReadonlyArray<EpicRun>,
  identity: { readonly epicId: string; readonly projectId: string; readonly cwd: string },
): ReadonlyArray<EpicRun> {
  return runs.filter(
    (run) =>
      run.epicId === identity.epicId &&
      run.projectId === identity.projectId &&
      run.cwd === identity.cwd,
  );
}

/**
 * The two-channel row. `runs` may be the whole run collection — the single
 * `allRuns` subscription — and is narrowed to this epic here.
 */
export function epicRowModel(
  project: EpicProjectSource,
  epic: EpicPageSummary,
  runs: ReadonlyArray<EpicRun>,
): EpicRowModel {
  const runIdentity = {
    epicId: epic.id,
    projectId: project.projectId,
    cwd: project.workspaceRoot,
  };
  const ownRuns = epicRunsForIdentity(runs, runIdentity);
  const latestRun = latestEpicRunForIdentity(ownRuns, runIdentity);
  const identity: EpicRowIdentity = {
    environmentId: project.environmentId,
    workspaceRoot: project.workspaceRoot,
    epicId: epic.id,
  };
  return {
    key: epicRowKey(identity),
    identity,
    project,
    work: {
      title: epic.title,
      epicId: epic.id,
      counts: epicCounts(epic),
      statusLabel: epicStatusLabel(epic.status),
      tone: epicPresentationStatus(epic, null),
      lastActivityAt: epic.lastActivityAt,
    },
    machinery: {
      runStatus: latestRun?.status ?? null,
      pill: resolveEpicRunStatusPill(latestRun?.status ?? null),
      updatedAt: latestRun?.updatedAt ?? null,
      runCount: ownRuns.length,
      latestRunId: latestRun?.runId ?? null,
      emptyLabel: latestRun === null ? NO_RUNS_LABEL : null,
    },
  };
}

export function epicRowModels(
  project: EpicProjectSource,
  epics: ReadonlyArray<EpicPageSummary>,
  runs: ReadonlyArray<EpicRun>,
): ReadonlyArray<EpicRowModel> {
  return epics.map((epic) => epicRowModel(project, epic, runs));
}

function timestampMs(value: string | null): number {
  if (value === null) return Number.NEGATIVE_INFINITY;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

/**
 * How recent a row is: the later of the run's own clock and the beads clock.
 * An epic moves when a child closes, which never touches the run, so taking the
 * max keeps an actively-progressing epic from looking stale.
 */
export function epicRowActivityAt(row: EpicRowModel): string | null {
  const run = row.machinery.updatedAt;
  const beads = row.work.lastActivityAt;
  if (run === null) return beads;
  if (beads === null) return run;
  return timestampMs(beads) > timestampMs(run) ? beads : run;
}

/** Newest first. A missing or unparseable timestamp always sorts last. */
function compareRecencyDesc(left: string | null, right: string | null): number {
  const leftMs = timestampMs(left);
  const rightMs = timestampMs(right);
  if (leftMs === rightMs) return 0;
  return leftMs > rightMs ? -1 : 1;
}

function compareAlphabetically(left: EpicRowModel, right: EpicRowModel): number {
  return (
    left.work.title.localeCompare(right.work.title) ||
    left.work.epicId.localeCompare(right.work.epicId) ||
    left.key.localeCompare(right.key)
  );
}

/**
 * Recency first, and run-bearing epics always above never-run ones. The tier is
 * decided by run presence, not by a timestamp: once beads recency ships every
 * epic carries one, and a plain timestamp sort would shuffle never-run epics in
 * among the ones you are actually watching.
 */
export function epicActivityComparator(left: EpicRowModel, right: EpicRowModel): number {
  const leftHasRun = left.machinery.runCount > 0;
  const rightHasRun = right.machinery.runCount > 0;
  if (leftHasRun !== rightHasRun) return leftHasRun ? -1 : 1;
  if (leftHasRun) {
    const byRecency = compareRecencyDesc(epicRowActivityAt(left), epicRowActivityAt(right));
    if (byRecency !== 0) return byRecency;
  }
  return compareAlphabetically(left, right);
}

export function sortEpicRowsByActivity(
  rows: ReadonlyArray<EpicRowModel>,
): ReadonlyArray<EpicRowModel> {
  return [...rows].sort(epicActivityComparator);
}

/**
 * Severity ladder for rolling many runs into one group pill. Running outranks
 * failed deliberately: a live run is the thing you can still act on, and a past
 * failure must not shout over it.
 */
const RUN_STATUS_SEVERITY: Record<EpicRunStatus, number> = {
  running: 5,
  failed: 4,
  paused: 3,
  cancelled: 2,
  done: 1,
};

export function worstRunStatus(
  runs: ReadonlyArray<{ readonly status: EpicRunStatus } | null | undefined>,
): EpicRunStatus | null {
  return runs.reduce<EpicRunStatus | null>((worst, run) => {
    if (run == null) return worst;
    if (worst === null) return run.status;
    return RUN_STATUS_SEVERITY[run.status] > RUN_STATUS_SEVERITY[worst] ? run.status : worst;
  }, null);
}

export interface EpicGroupModel {
  readonly key: string;
  readonly project: EpicProjectSource;
  readonly rows: ReadonlyArray<EpicRowModel>;
  readonly runStatus: EpicRunStatus | null;
  readonly pill: EpicRunStatusPill | null;
  readonly activityAt: string | null;
  readonly runningCount: number;
}

export function epicGroupModel(
  project: EpicProjectSource,
  rows: ReadonlyArray<EpicRowModel>,
): EpicGroupModel {
  const ordered = sortEpicRowsByActivity(rows);
  const runStatus = worstRunStatus(
    ordered.map((row) =>
      row.machinery.runStatus === null ? null : { status: row.machinery.runStatus },
    ),
  );
  const activityAt = ordered.reduce<string | null>((latest, row) => {
    const candidate = epicRowActivityAt(row);
    if (candidate === null) return latest;
    return latest === null || timestampMs(candidate) > timestampMs(latest) ? candidate : latest;
  }, null);
  return {
    key: epicSourceKey(project),
    project,
    rows: ordered,
    runStatus,
    pill: resolveEpicRunStatusPill(runStatus),
    activityAt,
    runningCount: ordered.filter((row) => row.machinery.runStatus === "running").length,
  };
}

export function epicGroupComparator(left: EpicGroupModel, right: EpicGroupModel): number {
  const byRecency = compareRecencyDesc(left.activityAt, right.activityAt);
  if (byRecency !== 0) return byRecency;
  return (
    left.project.projectTitle.localeCompare(right.project.projectTitle) ||
    left.key.localeCompare(right.key)
  );
}

export interface EpicPartialFailureEntry {
  readonly key: string;
  readonly project: EpicProjectSource;
  readonly reason: BeadsUnavailableReason;
  readonly detail: string | null;
}

/**
 * The projects whose beads snapshot did not load, in the order they were asked
 * for. Carries the reason so the banner can say why instead of "some projects".
 */
export function partialFailureEntries(
  sources: ReadonlyArray<EpicProjectSource>,
  results: ReadonlyMap<string, BeadsStatusResult | null | undefined>,
): ReadonlyArray<EpicPartialFailureEntry> {
  return sources.flatMap((project) => {
    const result = results.get(epicSourceKey(project));
    return result?._tag === "unavailable"
      ? [{ key: epicSourceKey(project), project, reason: result.reason, detail: result.detail }]
      : [];
  });
}

export function beadsUnavailableLabel(reason: BeadsUnavailableReason): string {
  switch (reason) {
    case "no-beads":
      return "No beads database";
    case "bd-not-found":
      return "bd not found";
    case "bd-failed":
      return "bd failed";
  }
}
