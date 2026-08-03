import type {
  BeadsEpicSummary,
  BeadsStatusResult,
  BeadsUnavailableReason,
  EpicRun,
  EpicRunStatus,
} from "@t3tools/contracts";
import { latestEpicRunForIdentity } from "@t3tools/client-runtime/state/epics";

import {
  availableEpicGroups,
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

const NO_RUNS: ReadonlyArray<EpicRun> = Object.freeze([]);

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
  readonly epicCount: number;
  /** Ready children summed over the group, so a collapsed header still says
      how much work is waiting inside it. */
  readonly readyCount: number;
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
    epicCount: ordered.length,
    readyCount: ordered.reduce((total, row) => total + row.work.counts.ready, 0),
  };
}

/**
 * Collapsing may hide rows, never state. A group is expanded until the user says
 * otherwise, and only their own toggle closes it — no status collapses a group
 * on its own, so nothing you were watching disappears while you read it.
 */
export function resolveEpicProjectGroupCollapsed(input: {
  override?: boolean | undefined;
}): boolean {
  return input.override ?? false;
}

export function epicGroupCountLabel(epicCount: number): string {
  return `${epicCount} ${epicCount === 1 ? "epic" : "epics"}`;
}

/**
 * The id a group header's `aria-controls` points at. Group keys hold a NUL byte
 * and a filesystem path, so every character outside the id-safe set is escaped
 * to its code point rather than dropped — dropping would let two workspaces that
 * differ only in punctuation claim the same id and cross-wire their headers.
 */
export function epicGroupListId(groupKey: string): string {
  const escaped = groupKey.replaceAll(
    /[^A-Za-z0-9-]/gu,
    (char) => `_${char.codePointAt(0)?.toString(16) ?? ""}_`,
  );
  return `epics-project-group-${escaped}`;
}

/**
 * Every project that has epics to show, as one group each, IN PROJECT SOURCE
 * ORDER — the same order the sidebar lists projects in (the server reads them
 * `ORDER BY created_at ASC, project_id ASC`).
 *
 * Deliberately NOT sorted by recency. "By project" is the stable view: its
 * headers are press targets, so a recency sort would slide a group out from
 * under the pointer every time a run ticks. Recency lives in the flat "Recent"
 * mode, which is what that mode is for. Rows INSIDE a group are still recency
 * ordered by `epicGroupModel`.
 *
 * A project whose snapshot is missing or empty contributes no group; the warning
 * strip names the missing ones via `epicSourceFailures`.
 */
export function epicGroupModels(input: {
  readonly sources: ReadonlyArray<EpicProjectSource>;
  readonly results: ReadonlyMap<string, EpicSourceResult | undefined>;
  readonly runsByEnvironment: ReadonlyMap<string, ReadonlyArray<EpicRun>>;
}): ReadonlyArray<EpicGroupModel> {
  return availableEpicGroups(
    input.sources.map((project) => ({
      project,
      result: input.results.get(epicSourceKey(project))?.data ?? null,
    })),
  ).map(({ project, snapshot }) =>
    epicGroupModel(
      project,
      epicRowModels(
        project,
        snapshot.epics,
        input.runsByEnvironment.get(project.environmentId) ?? NO_RUNS,
      ),
    ),
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

/** What the page knows about one project source: its snapshot, or why it has none. */
export interface EpicSourceResult {
  readonly data: BeadsStatusResult | null;
  readonly error: string | null;
}

export interface EpicSourceFailure {
  readonly key: string;
  readonly project: EpicProjectSource;
  readonly label: string;
  readonly detail: string | null;
}

const SUBSCRIPTION_FAILURE_LABEL = "Could not be read";

/**
 * Every project the list is missing, ready to be named in the warning strip.
 * Covers both ways a source can go dark: beads answered `unavailable`, or the
 * subscription itself failed. In a flat recency list an unnamed dead source
 * makes its epics vanish from the middle of the list with no trace.
 */
export function epicSourceFailures(
  sources: ReadonlyArray<EpicProjectSource>,
  results: ReadonlyMap<string, EpicSourceResult | undefined>,
): ReadonlyArray<EpicSourceFailure> {
  const unavailable = new Map(
    partialFailureEntries(
      sources,
      new Map([...results].map(([key, result]) => [key, result?.data ?? null])),
    ).map((entry) => [entry.key, entry] as const),
  );
  return sources.flatMap((project) => {
    const key = epicSourceKey(project);
    const entry = unavailable.get(key);
    if (entry !== undefined) {
      return [{ key, project, label: beadsUnavailableLabel(entry.reason), detail: entry.detail }];
    }
    const error = results.get(key)?.error ?? null;
    return error === null
      ? []
      : [{ key, project, label: SUBSCRIPTION_FAILURE_LABEL, detail: error }];
  });
}
