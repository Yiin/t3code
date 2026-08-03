import * as React from "react";
import { parseEpicRunIterationThreadId } from "@t3tools/contracts";
import type { ContextMenuItem, EpicRunStatus } from "@t3tools/contracts";
import type { SidebarProjectSortOrder, SidebarThreadSortOrder } from "@t3tools/contracts/settings";
import {
  getThreadSortTimestamp,
  sortThreads,
  toSortableTimestamp,
  type ThreadSortInput,
} from "../lib/threadSort";
import type { SidebarThreadSummary, Thread } from "../types";
import { cn } from "../lib/utils";
import { isLatestTurnSettled } from "../session-logic";
import { resolveServerBackedAppStageLabel } from "../branding.logic";

export const THREAD_SELECTION_SAFE_SELECTOR = "[data-thread-item], [data-thread-selection-safe]";
export const THREAD_JUMP_HINT_SHOW_DELAY_MS = 100;
// Visible sidebar rows are prewarmed into the thread-detail cache so opening a
// nearby thread usually reuses an already-hot subscription.
export const SIDEBAR_THREAD_PREWARM_LIMIT = 10;
export type SidebarNewThreadEnvMode = "local" | "worktree";
type SidebarProject = {
  id: string;
  title: string;
  createdAt?: string | undefined;
  updatedAt?: string | undefined;
};

type ScopedSidebarProject = SidebarProject & {
  environmentId: string;
};

type ScopedSidebarThread = ThreadSortInput & {
  environmentId: string;
  projectId: string;
  archivedAt: string | null;
};

export type ThreadTraversalDirection = "previous" | "next";

export async function archiveSelectedThreadEntries<
  TEntry extends { readonly threadKey: string },
  TResult extends { readonly _tag: "Success" | "Failure" },
>(input: {
  entries: readonly TEntry[];
  archive: (entry: TEntry, onArchived: () => void) => Promise<TResult>;
}): Promise<{
  archivedThreadKeys: readonly string[];
  mutationFailure: Extract<TResult, { readonly _tag: "Failure" }> | null;
  followupFailures: readonly Extract<TResult, { readonly _tag: "Failure" }>[];
}> {
  const archivedThreadKeys: string[] = [];
  const followupFailures: Extract<TResult, { readonly _tag: "Failure" }>[] = [];

  for (const entry of input.entries) {
    let didArchive = false;
    const result = await input.archive(entry, () => {
      didArchive = true;
    });
    if (didArchive || result._tag === "Success") {
      archivedThreadKeys.push(entry.threadKey);
    }
    if (result._tag === "Success") continue;
    const failure = result as Extract<TResult, { readonly _tag: "Failure" }>;
    if (didArchive) {
      followupFailures.push(failure);
      continue;
    }
    return { archivedThreadKeys, mutationFailure: failure, followupFailures };
  }

  return { archivedThreadKeys, mutationFailure: null, followupFailures };
}

export function buildMultiSelectThreadContextMenuItems(input: {
  count: number;
  hasRunningThread: boolean;
}): readonly ContextMenuItem<"mark-unread" | "archive" | "delete">[] {
  return [
    { id: "mark-unread", label: `Mark unread (${input.count})` },
    {
      id: "archive",
      label: `Archive (${input.count})`,
      disabled: input.hasRunningThread,
    },
    { id: "delete", label: `Delete (${input.count})`, destructive: true },
  ];
}

export interface ThreadStatusPill {
  label:
    | "Working"
    | "Connecting"
    | "Completed"
    | "Pending Approval"
    | "Awaiting Input"
    | "Run active"
    | "Plan Ready";
  colorClass: string;
  dotClass: string;
  pulse: boolean;
}

const THREAD_STATUS_PRIORITY: Record<ThreadStatusPill["label"], number> = {
  "Pending Approval": 5,
  "Awaiting Input": 4,
  "Run active": 3.5,
  Working: 3,
  Connecting: 3,
  "Plan Ready": 2,
  Completed: 1,
};

type ThreadStatusInput = Pick<
  SidebarThreadSummary,
  | "hasActionableProposedPlan"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "interactionMode"
  | "latestTurn"
  | "session"
> & {
  lastVisitedAt?: string | undefined;
};

export interface ThreadJumpHintVisibilityController {
  sync: (shouldShow: boolean) => void;
  dispose: () => void;
}

export function resolveSidebarStageBadgeLabel(input: {
  primaryServerVersion: string | null | undefined;
  fallbackStageLabel: string;
}): string {
  return resolveServerBackedAppStageLabel(input);
}

export function createThreadJumpHintVisibilityController(input: {
  delayMs: number;
  onVisibilityChange: (visible: boolean) => void;
  setTimeoutFn?: typeof globalThis.setTimeout;
  clearTimeoutFn?: typeof globalThis.clearTimeout;
}): ThreadJumpHintVisibilityController {
  const setTimeoutFn = input.setTimeoutFn ?? globalThis.setTimeout;
  const clearTimeoutFn = input.clearTimeoutFn ?? globalThis.clearTimeout;
  let isVisible = false;
  let timeoutId: NodeJS.Timeout | null = null;

  const clearPendingShow = () => {
    if (timeoutId === null) {
      return;
    }
    clearTimeoutFn(timeoutId);
    timeoutId = null;
  };

  return {
    sync: (shouldShow) => {
      if (!shouldShow) {
        clearPendingShow();
        if (isVisible) {
          isVisible = false;
          input.onVisibilityChange(false);
        }
        return;
      }

      if (isVisible || timeoutId !== null) {
        return;
      }

      timeoutId = setTimeoutFn(() => {
        timeoutId = null;
        isVisible = true;
        input.onVisibilityChange(true);
      }, input.delayMs);
    },
    dispose: () => {
      clearPendingShow();
    },
  };
}

export function useThreadJumpHintVisibility(): {
  showThreadJumpHints: boolean;
  updateThreadJumpHintsVisibility: (shouldShow: boolean) => void;
} {
  const [showThreadJumpHints, setShowThreadJumpHints] = React.useState(false);
  const controllerRef = React.useRef<ThreadJumpHintVisibilityController | null>(null);

  React.useEffect(() => {
    const controller = createThreadJumpHintVisibilityController({
      delayMs: THREAD_JUMP_HINT_SHOW_DELAY_MS,
      onVisibilityChange: (visible) => {
        setShowThreadJumpHints(visible);
      },
      setTimeoutFn: window.setTimeout.bind(window),
      clearTimeoutFn: window.clearTimeout.bind(window),
    });
    controllerRef.current = controller;

    return () => {
      controller.dispose();
      controllerRef.current = null;
    };
  }, []);

  const updateThreadJumpHintsVisibility = React.useCallback((shouldShow: boolean) => {
    controllerRef.current?.sync(shouldShow);
  }, []);

  return {
    showThreadJumpHints,
    updateThreadJumpHintsVisibility,
  };
}

export function hasUnseenCompletion(thread: ThreadStatusInput): boolean {
  if (!thread.latestTurn?.completedAt) return false;
  const completedAt = Date.parse(thread.latestTurn.completedAt);
  if (Number.isNaN(completedAt)) return false;
  if (!thread.lastVisitedAt) return false;

  const lastVisitedAt = Date.parse(thread.lastVisitedAt);
  if (Number.isNaN(lastVisitedAt)) return true;
  return completedAt > lastVisitedAt;
}

export function shouldClearThreadSelectionOnMouseDown(target: HTMLElement | null): boolean {
  if (target === null) return true;
  return !target.closest(THREAD_SELECTION_SAFE_SELECTOR);
}

// A double-click dispatches two `click` events before `dblclick`: the first has
// `detail === 1`, the second `detail === 2`. The second click must not run the
// row's single-click navigation, otherwise double-click-to-rename would also
// navigate. `MouseEvent.detail` is 0 for synthetic/keyboard activations, which
// still count as a normal single activation.
export function isTrailingDoubleClick(detail: number): boolean {
  return detail > 1;
}

export function resolveSidebarNewThreadEnvMode(input: {
  requestedEnvMode?: SidebarNewThreadEnvMode;
  defaultEnvMode: SidebarNewThreadEnvMode;
}): SidebarNewThreadEnvMode {
  return input.requestedEnvMode ?? input.defaultEnvMode;
}

export function resolveSidebarNewThreadSeedContext(input: {
  projectId: string;
  defaultEnvMode: SidebarNewThreadEnvMode;
  activeThread?: {
    projectId: string;
    branch: string | null;
    worktreePath: string | null;
  } | null;
  activeDraftThread?: {
    projectId: string;
    branch: string | null;
    worktreePath: string | null;
    envMode: SidebarNewThreadEnvMode;
    startFromOrigin: boolean;
  } | null;
}): {
  branch?: string | null;
  worktreePath?: string | null;
  envMode: SidebarNewThreadEnvMode;
  startFromOrigin?: boolean;
} {
  if (input.defaultEnvMode === "worktree") {
    return {
      envMode: "worktree",
    };
  }

  if (input.activeDraftThread?.projectId === input.projectId) {
    return {
      branch: input.activeDraftThread.branch,
      worktreePath: input.activeDraftThread.worktreePath,
      envMode: input.activeDraftThread.envMode,
      startFromOrigin: input.activeDraftThread.startFromOrigin,
    };
  }

  if (input.activeThread?.projectId === input.projectId) {
    return {
      branch: input.activeThread.branch,
      worktreePath: input.activeThread.worktreePath,
      envMode: input.activeThread.worktreePath ? "worktree" : "local",
    };
  }

  return {
    envMode: input.defaultEnvMode,
  };
}

export function orderItemsByPreferredIds<TItem, TId>(input: {
  items: readonly TItem[];
  preferredIds: readonly TId[];
  getId: (item: TItem) => TId;
  getPreferenceIds?: (item: TItem) => readonly TId[];
}): TItem[] {
  const { getId, getPreferenceIds, items, preferredIds } = input;
  if (preferredIds.length === 0) {
    return [...items];
  }

  const indexesByPreferenceId = new Map<TId, number[]>();
  for (const [index, item] of items.entries()) {
    const preferenceIds = getPreferenceIds?.(item) ?? [getId(item)];
    for (const preferenceId of new Set(preferenceIds)) {
      const indexes = indexesByPreferenceId.get(preferenceId);
      if (indexes) {
        indexes.push(index);
      } else {
        indexesByPreferenceId.set(preferenceId, [index]);
      }
    }
  }

  const emittedIndexes = new Set<number>();
  const ordered = preferredIds.flatMap((id) => {
    const index = indexesByPreferenceId
      .get(id)
      ?.find((candidate) => !emittedIndexes.has(candidate));
    if (index === undefined) {
      return [];
    }
    emittedIndexes.add(index);
    return [items[index]!];
  });
  const remaining = items.filter((_, index) => !emittedIndexes.has(index));
  return [...ordered, ...remaining];
}

export function getVisibleSidebarThreadIds<TThreadId>(
  renderedProjects: readonly {
    shouldShowThreadPanel?: boolean;
    renderedThreadIds: readonly TThreadId[];
  }[],
): TThreadId[] {
  return renderedProjects.flatMap((renderedProject) =>
    renderedProject.shouldShowThreadPanel === false ? [] : renderedProject.renderedThreadIds,
  );
}

export function getSidebarThreadIdsToPrewarm<TThreadId>(
  visibleThreadIds: readonly TThreadId[],
  limit = SIDEBAR_THREAD_PREWARM_LIMIT,
): TThreadId[] {
  return visibleThreadIds.slice(0, Math.max(0, limit));
}

export function resolveAdjacentThreadId<T>(input: {
  threadIds: readonly T[];
  currentThreadId: T | null;
  direction: ThreadTraversalDirection;
}): T | null {
  const { currentThreadId, direction, threadIds } = input;

  if (threadIds.length === 0) {
    return null;
  }

  if (currentThreadId === null) {
    return direction === "previous" ? (threadIds.at(-1) ?? null) : (threadIds[0] ?? null);
  }

  const currentIndex = threadIds.indexOf(currentThreadId);
  if (currentIndex === -1) {
    return null;
  }

  if (direction === "previous") {
    return currentIndex > 0 ? (threadIds[currentIndex - 1] ?? null) : null;
  }

  return currentIndex < threadIds.length - 1 ? (threadIds[currentIndex + 1] ?? null) : null;
}

export function isContextMenuPointerDown(input: {
  button: number;
  ctrlKey: boolean;
  isMac: boolean;
}): boolean {
  if (input.button === 2) return true;
  return input.isMac && input.button === 0 && input.ctrlKey;
}

export function resolveThreadRowClassName(input: {
  isActive: boolean;
  isSelected: boolean;
}): string {
  const baseClassName =
    "h-6 w-full translate-x-0 cursor-pointer justify-start px-2 text-left select-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring sm:h-7";

  if (input.isSelected && input.isActive) {
    return cn(
      baseClassName,
      "bg-primary/22 text-foreground font-medium hover:bg-primary/26 hover:text-foreground dark:bg-primary/30 dark:hover:bg-primary/36",
    );
  }

  if (input.isSelected) {
    return cn(
      baseClassName,
      "bg-primary/15 text-foreground hover:bg-primary/19 hover:text-foreground dark:bg-primary/22 dark:hover:bg-primary/28",
    );
  }

  if (input.isActive) {
    return cn(
      baseClassName,
      "bg-accent/85 text-foreground font-medium hover:bg-accent hover:text-foreground dark:bg-accent/55 dark:hover:bg-accent/70",
    );
  }

  return cn(baseClassName, "text-muted-foreground hover:bg-accent hover:text-foreground");
}

// ── Sidebar v2 status model ─────────────────────────────────────────
// Five visual states, three colors: color is reserved for "act now"
// (approval), "in motion" (working), and "broken" (failed). Ready is the
// unlabeled resting state — the agent stopped and is waiting on the user,
// whether it finished, asked a question, or proposed a plan.
// Unread completion is tracked separately: it describes whether a ready
// thread needs attention, not what the thread is currently doing.
export type SidebarV2Status = "approval" | "input" | "run-active" | "working" | "failed" | "ready";

type SidebarV2StatusInput = Pick<
  SidebarThreadSummary,
  "hasPendingApprovals" | "hasPendingUserInput" | "session"
>;

export function resolveSidebarV2Status(
  thread: SidebarV2StatusInput,
  runActive = false,
): SidebarV2Status {
  if (thread.hasPendingApprovals) {
    return "approval";
  }
  if (thread.hasPendingUserInput) {
    return "input";
  }
  if (runActive) return "run-active";
  if (thread.session?.status === "running" || thread.session?.status === "starting") {
    return "working";
  }
  if (thread.session?.status === "error") {
    return "failed";
  }
  return "ready";
}

/** NaN-safe Date.parse for sort comparators: a malformed timestamp must not
    poison the whole ordering, so it sinks to the epoch instead. */
export function parseTimestampMs(isoDate: string): number {
  const parsed = Date.parse(isoDate);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** First VALID timestamp wins: `a ?? b` falls through on null, but a present-
    yet-malformed string must also fall through to the next candidate rather
    than sink the row to the epoch. */
export function firstValidTimestampMs(
  ...candidates: ReadonlyArray<string | null | undefined>
): number {
  for (const candidate of candidates) {
    if (candidate == null) continue;
    const parsed = Date.parse(candidate);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return 0;
}

// v2 sort: static creation order, newest thread on top. Activity NEVER
// reorders the list — a row holds its position from open until settled, so
// the screen only moves at lifecycle transitions. Status (including pending
// approval) is carried by each card's edge strip, not by position.
export function sortThreadsForSidebarV2<
  T extends { readonly id: string; readonly createdAt: string },
>(threads: readonly T[]): T[] {
  return [...threads].toSorted(
    (left, right) =>
      parseTimestampMs(right.createdAt) - parseTimestampMs(left.createdAt) ||
      left.id.localeCompare(right.id),
  );
}

/** One iteration row inside a run group, carrying the thread it stands for. */
export type SidebarEpicRunIteration<T> = {
  readonly iterationIndex: number;
  /** The bd issue the iteration cooked; `null` until the run read model loads. */
  readonly issueId: string | null;
  readonly thread: T;
};

export type SidebarEpicRunGroup<T> = {
  readonly kind: "epic-run";
  readonly runId: string;
  /** `null` when the run is not in `runs` yet — grouping never waits on it. */
  readonly epicId: string | null;
  readonly status: EpicRunStatus | null;
  /**
   * The thread row this group renders directly beneath, indented one level;
   * `null` means project level. Already resolved: it is only set when the
   * origin thread is in the list the caller passed, so a deleted, archived or
   * filtered-out launcher detaches the group instead of hiding it.
   */
  readonly nestedUnderThreadId: string | null;
  /** Ascending by iteration index, so 'iteration 1' renders first. */
  readonly iterations: readonly SidebarEpicRunIteration<T>[];
};

export type SidebarThreadNode<T> =
  | { readonly kind: "thread"; readonly thread: T }
  | SidebarEpicRunGroup<T>;

/** Every thread a node stands for: itself, or the run's iterations. */
export function sidebarNodeThreads<T>(node: SidebarThreadNode<T>): readonly T[] {
  return node.kind === "thread"
    ? [node.thread]
    : node.iterations.map((iteration) => iteration.thread);
}

/** The slice of `EpicRun` the sidebar needs; the caller feeds it from the
    existing `allRuns` subscription. */
export type SidebarEpicRunSummary = {
  readonly runId: string;
  readonly epicId: string;
  readonly status: EpicRunStatus;
  /** The thread the run was launched from; `null` for an Epics-page launch. */
  readonly originThreadId: string | null;
  readonly threadRefs: ReadonlyArray<{
    readonly threadId: string;
    readonly issueId: string;
    readonly iterationIndex: number;
  }>;
};

type MutableSidebarEpicRunGroup<T> = {
  kind: "epic-run";
  runId: string;
  epicId: string | null;
  status: EpicRunStatus | null;
  nestedUnderThreadId: string | null;
  iterations: Array<SidebarEpicRunIteration<T>>;
};

/**
 * Folds an epic run's iteration threads into one group node, leaving every
 * other thread untouched and in place. A run of 50 iterations otherwise pushes
 * 50 near-identical rows into the sidebar and buries real threads.
 *
 * Grouping is derived from the thread id alone (see
 * `parseEpicRunIterationThreadId`), so it works before `runs` arrives; the run
 * read model only supplies the labels. The group takes the list slot of its
 * first-listed iteration, which in a recency-ordered list is the newest one, so
 * the surrounding order is preserved whichever way the caller sorted.
 *
 * A run launched from a thread moves out of that slot and renders directly
 * beneath its launcher instead (`nestedUnderThreadId`). The tree is two levels
 * deep and stays there: a run whose launcher is missing from `threads` — an
 * Epics-page launch, a deleted or archived thread, a filtered-out one — or
 * whose launcher is itself an iteration keeps its own project-level slot. A
 * live run must never become invisible because its launcher was tidied away.
 */
export function groupEpicRunIterationThreads<T extends { readonly id: string }>(input: {
  threads: readonly T[];
  runs?: readonly SidebarEpicRunSummary[] | undefined;
}): Array<SidebarThreadNode<T>> {
  const issueIdByThreadId = new Map<string, string>();
  const runsById = new Map<string, SidebarEpicRunSummary>();
  for (const run of input.runs ?? []) {
    runsById.set(run.runId, run);
    for (const ref of run.threadRefs) {
      issueIdByThreadId.set(ref.threadId, ref.issueId);
    }
  }

  const nodes: Array<SidebarThreadNode<T>> = [];
  const groupsByRunId = new Map<string, MutableSidebarEpicRunGroup<T>>();

  for (const thread of input.threads) {
    const parsed = parseEpicRunIterationThreadId(thread.id);
    if (parsed === null) {
      nodes.push({ kind: "thread", thread });
      continue;
    }

    const iteration: SidebarEpicRunIteration<T> = {
      iterationIndex: parsed.iterationIndex,
      issueId: issueIdByThreadId.get(thread.id) ?? null,
      thread,
    };

    const existing = groupsByRunId.get(parsed.runId);
    if (existing !== undefined) {
      existing.iterations.push(iteration);
      continue;
    }

    const run = runsById.get(parsed.runId);
    const group: MutableSidebarEpicRunGroup<T> = {
      kind: "epic-run",
      runId: parsed.runId,
      epicId: run?.epicId ?? null,
      status: run?.status ?? null,
      nestedUnderThreadId: null,
      iterations: [iteration],
    };
    groupsByRunId.set(parsed.runId, group);
    nodes.push(group);
  }

  for (const group of groupsByRunId.values()) {
    group.iterations.sort((left, right) => left.iterationIndex - right.iterationIndex);
  }

  const groupsByOriginThreadId = new Map<string, Array<MutableSidebarEpicRunGroup<T>>>();
  const threadIds = new Set(input.threads.map((thread) => thread.id));
  for (const group of groupsByRunId.values()) {
    const originThreadId = runsById.get(group.runId)?.originThreadId ?? null;
    // No launcher on screen means no row to hang under, so the group keeps its
    // own slot. An iteration as launcher would make a third level, which this
    // tree does not have.
    if (originThreadId === null || !threadIds.has(originThreadId)) continue;
    if (parseEpicRunIterationThreadId(originThreadId) !== null) continue;
    group.nestedUnderThreadId = originThreadId;
    const siblings = groupsByOriginThreadId.get(originThreadId);
    if (siblings === undefined) {
      groupsByOriginThreadId.set(originThreadId, [group]);
      continue;
    }
    siblings.push(group);
  }

  if (groupsByOriginThreadId.size === 0) return nodes;

  // Nested groups leave their own slot and follow their launcher's row. Their
  // relative order is the one the first pass produced, so two runs from the
  // same thread stay sorted the way the caller sorted their iterations.
  const orderedNodes: Array<SidebarThreadNode<T>> = [];
  for (const node of nodes) {
    if (node.kind === "epic-run") {
      if (node.nestedUnderThreadId === null) orderedNodes.push(node);
      continue;
    }
    orderedNodes.push(node);
    for (const group of groupsByOriginThreadId.get(node.thread.id) ?? []) {
      orderedNodes.push(group);
    }
  }

  return orderedNodes;
}

/**
 * A run's status as the sidebar paints it. Deliberately NOT a
 * `ThreadStatusPill`: this describes the whole run, so it must never enter the
 * per-thread status roll-up (`resolveProjectStatusIndicator`) that keys off
 * that union of labels.
 */
export type EpicRunStatusPill = {
  readonly label: string;
  readonly colorClass: string;
  readonly dotClass: string;
  readonly pulse: boolean;
};

/** `null` only while the run read model is still loading. */
export function resolveEpicRunStatusPill(status: EpicRunStatus | null): EpicRunStatusPill | null {
  switch (status) {
    case null:
      return null;
    // Same hues as the thread pills above, so a live run reads the same green
    // on its group row as "Run active" does on the iteration inside it.
    case "running":
      return { label: "Running", colorClass: "text-success", dotClass: "bg-success", pulse: true };
    case "paused":
      return {
        label: "Paused",
        colorClass: "text-amber-600 dark:text-amber-300/90",
        dotClass: "bg-amber-500 dark:bg-amber-300/90",
        pulse: false,
      };
    case "done":
      return {
        label: "Done",
        colorClass: "text-emerald-600 dark:text-emerald-300/90",
        dotClass: "bg-emerald-500 dark:bg-emerald-300/90",
        pulse: false,
      };
    case "failed":
      return {
        label: "Failed",
        colorClass: "text-red-600 dark:text-red-300/90",
        dotClass: "bg-red-500 dark:bg-red-300/90",
        pulse: false,
      };
    case "cancelled":
      return {
        label: "Cancelled",
        colorClass: "text-muted-foreground/80",
        dotClass: "bg-muted-foreground/70",
        pulse: false,
      };
  }
}

/**
 * Open while the run is live, closed once it ends — a finished run is history
 * and should occupy one row. An explicit user toggle for that run always wins,
 * including after the run ends, so a group you opened to read does not snap
 * shut under you when the last iteration lands.
 *
 * `forceExpanded` outranks even that: the group holds the thread the user is
 * currently on, and a row must never hide the chat on screen.
 */
export function resolveEpicRunGroupExpanded(input: {
  status: EpicRunStatus | null;
  override?: boolean | undefined;
  forceExpanded?: boolean | undefined;
}): boolean {
  if (input.forceExpanded === true) return true;
  return input.override ?? input.status === "running";
}

/**
 * The one expansion rule, shared by the group row and by every list derived
 * from the rows on screen (numbered jump shortcuts, prewarm, range select).
 * Reading expansion twice from two hand-rolled copies is how a jump number ends
 * up pointing at a row nobody can see.
 */
export function createEpicRunGroupExpandedResolver<T>(input: {
  expandedByRunId: Readonly<Record<string, boolean>>;
  /** The thread the route is on; its group is always expanded. */
  activeThreadKey: string | null;
  getThreadKey: (thread: T) => string;
}): (group: SidebarEpicRunGroup<T>) => boolean {
  const { activeThreadKey, expandedByRunId, getThreadKey } = input;
  return (group) =>
    resolveEpicRunGroupExpanded({
      status: group.status,
      override: expandedByRunId[group.runId],
      forceExpanded:
        activeThreadKey !== null &&
        group.iterations.some((iteration) => getThreadKey(iteration.thread) === activeThreadKey),
    });
}

/**
 * The thread rows the sidebar paints, in paint order: a thread node is one row,
 * and a run group contributes its iterations only while it is expanded.
 *
 * Numbered jump shortcuts, the prewarm budget and range select all key off this
 * list, so they stay aligned with the screen. A collapsed 50-iteration run must
 * cost one row, not swallow all nine jump numbers and the whole prewarm budget
 * on rows nobody can see.
 */
export function sidebarRenderedThreadIds<T, TId>(input: {
  nodes: readonly SidebarThreadNode<T>[];
  getThreadId: (thread: T) => TId;
  isEpicRunGroupExpanded: (group: SidebarEpicRunGroup<T>) => boolean;
}): TId[] {
  const { getThreadId, isEpicRunGroupExpanded, nodes } = input;
  return nodes.flatMap((node) => {
    if (node.kind === "thread") return [getThreadId(node.thread)];
    if (!isEpicRunGroupExpanded(node)) return [];
    return node.iterations.map((iteration) => getThreadId(iteration.thread));
  });
}

/**
 * Every thread the previous/next-thread shortcuts step through, in the same
 * paint order — including the iterations of a COLLAPSED group.
 *
 * The decision: traversal steps into a collapsed run instead of skipping it. A
 * group row is not a thread, so skipping would leave a finished run's
 * iterations with no keyboard route to them at all. Stepping in is safe because
 * the group holding the active thread force-expands
 * (`createEpicRunGroupExpandedResolver`), so the row the user lands on is on
 * screen by the time they get there.
 *
 * Rows hidden by anything other than collapse — a project's preview limit, a
 * collapsed project — stay out: the caller passes only the nodes it renders.
 */
export function sidebarTraversalThreadIds<T, TId>(input: {
  nodes: readonly SidebarThreadNode<T>[];
  getThreadId: (thread: T) => TId;
}): TId[] {
  return sidebarRenderedThreadIds({ ...input, isEpicRunGroupExpanded: () => true });
}

/**
 * The nodes one project panel renders: iteration threads folded into run
 * groups, the preview limit applied to NODES so a long run costs one row of the
 * budget, and a collapsed project reduced to the node standing for the active
 * row.
 *
 * The panel and the sidebar root both call this. The root needs the same list
 * to number jump shortcuts and pick prewarm targets, and when it re-derived
 * that list by hand the two drifted — the root counted 50 iterations against a
 * preview limit the panel spent on one group row.
 */
export function resolveRenderedSidebarThreadNodes<T extends { readonly id: string }>(input: {
  /** Already sorted and archive-filtered, exactly as the panel lists them. */
  threads: readonly T[];
  runs?: readonly SidebarEpicRunSummary[] | undefined;
  previewCount: number;
  isThreadListExpanded: boolean;
  /** The one row a collapsed project keeps; `null` while the project is open. */
  pinnedThreadId: string | null;
}): {
  nodes: Array<SidebarThreadNode<T>>;
  hasOverflowingThreads: boolean;
} {
  const nodes = groupEpicRunIterationThreads({ threads: input.threads, runs: input.runs });
  const hasOverflowingThreads = nodes.length > input.previewCount;

  if (input.pinnedThreadId !== null) {
    // A collapsed project keeps only the active row. When that row is an
    // iteration, its whole run node stands in for it: a bare iteration row with
    // no group above it would read as an orphan.
    const pinnedThreadId = input.pinnedThreadId;
    const pinnedNode = nodes.find((node) =>
      sidebarNodeThreads(node).some((thread) => thread.id === pinnedThreadId),
    );
    return { nodes: pinnedNode ? [pinnedNode] : [], hasOverflowingThreads };
  }

  return {
    nodes:
      input.isThreadListExpanded || !hasOverflowingThreads
        ? nodes
        : nodes.slice(0, input.previewCount),
    hasOverflowingThreads,
  };
}

/** The run's epic id, or a neutral label until the read model supplies one. */
export function epicRunGroupTitle(input: { epicId: string | null }): string {
  return input.epicId ?? "Epic run";
}

export function epicRunIterationCountLabel(count: number): string {
  return `${count} iteration${count === 1 ? "" : "s"}`;
}

/**
 * `iteration 3 · t3code-ypi.2`. Iteration numbers are 1-based for humans (the
 * runner titles its threads the same way); the issue id is dropped while the
 * run read model has not arrived, rather than rendering a dangling separator.
 */
export function epicRunIterationLabel(input: {
  iterationIndex: number;
  issueId: string | null;
}): string {
  const ordinal = `iteration ${input.iterationIndex + 1}`;
  return input.issueId === null ? ordinal : `${ordinal} · ${input.issueId}`;
}

export function resolveThreadStatusPill(input: {
  thread: ThreadStatusInput;
  runActive?: boolean;
}): ThreadStatusPill | null {
  const { thread, runActive = false } = input;

  if (thread.hasPendingApprovals) {
    return {
      label: "Pending Approval",
      colorClass: "text-amber-600 dark:text-amber-300/90",
      dotClass: "bg-amber-500 dark:bg-amber-300/90",
      pulse: false,
    };
  }

  if (thread.hasPendingUserInput) {
    return {
      label: "Awaiting Input",
      colorClass: "text-indigo-600 dark:text-indigo-300/90",
      dotClass: "bg-indigo-500 dark:bg-indigo-300/90",
      pulse: false,
    };
  }

  if (runActive) {
    return {
      label: "Run active",
      colorClass: "text-success",
      dotClass: "bg-success",
      pulse: true,
    };
  }

  if (thread.session?.status === "running") {
    return {
      label: "Working",
      colorClass: "text-sky-600 dark:text-sky-300/80",
      dotClass: "bg-sky-500 dark:bg-sky-300/80",
      pulse: true,
    };
  }

  if (thread.session?.status === "starting") {
    return {
      label: "Connecting",
      colorClass: "text-sky-600 dark:text-sky-300/80",
      dotClass: "bg-sky-500 dark:bg-sky-300/80",
      pulse: true,
    };
  }

  const hasPlanReadyPrompt =
    !thread.hasPendingUserInput &&
    thread.interactionMode === "plan" &&
    isLatestTurnSettled(thread.latestTurn, thread.session) &&
    thread.hasActionableProposedPlan;
  if (hasPlanReadyPrompt) {
    return {
      label: "Plan Ready",
      colorClass: "text-violet-600 dark:text-violet-300/90",
      dotClass: "bg-violet-500 dark:bg-violet-300/90",
      pulse: false,
    };
  }

  if (hasUnseenCompletion(thread)) {
    return {
      label: "Completed",
      colorClass: "text-emerald-600 dark:text-emerald-300/90",
      dotClass: "bg-emerald-500 dark:bg-emerald-300/90",
      pulse: false,
    };
  }

  return null;
}

export function resolveProjectStatusIndicator(
  statuses: ReadonlyArray<ThreadStatusPill | null>,
): ThreadStatusPill | null {
  let highestPriorityStatus: ThreadStatusPill | null = null;

  for (const status of statuses) {
    if (status === null) continue;
    if (
      highestPriorityStatus === null ||
      THREAD_STATUS_PRIORITY[status.label] > THREAD_STATUS_PRIORITY[highestPriorityStatus.label]
    ) {
      highestPriorityStatus = status;
    }
  }

  return highestPriorityStatus;
}

export function getVisibleThreadsForProject<T extends Pick<Thread, "id">>(input: {
  threads: readonly T[];
  activeThreadId: T["id"] | undefined;
  isThreadListExpanded: boolean;
  previewLimit: number;
}): {
  hasHiddenThreads: boolean;
  visibleThreads: T[];
  hiddenThreads: T[];
} {
  const { activeThreadId, isThreadListExpanded, previewLimit, threads } = input;
  const hasHiddenThreads = threads.length > previewLimit;

  if (!hasHiddenThreads || isThreadListExpanded) {
    return {
      hasHiddenThreads,
      hiddenThreads: [],
      visibleThreads: [...threads],
    };
  }

  const previewThreads = threads.slice(0, previewLimit);
  if (!activeThreadId || previewThreads.some((thread) => thread.id === activeThreadId)) {
    return {
      hasHiddenThreads: true,
      hiddenThreads: threads.slice(previewLimit),
      visibleThreads: previewThreads,
    };
  }

  const activeThread = threads.find((thread) => thread.id === activeThreadId);
  if (!activeThread) {
    return {
      hasHiddenThreads: true,
      hiddenThreads: threads.slice(previewLimit),
      visibleThreads: previewThreads,
    };
  }

  const visibleThreadIds = new Set([...previewThreads, activeThread].map((thread) => thread.id));

  return {
    hasHiddenThreads: true,
    hiddenThreads: threads.filter((thread) => !visibleThreadIds.has(thread.id)),
    visibleThreads: threads.filter((thread) => visibleThreadIds.has(thread.id)),
  };
}

export function getFallbackThreadIdAfterDelete<
  T extends Pick<Thread, "id" | "projectId" | "createdAt" | "updatedAt"> & ThreadSortInput,
>(input: {
  threads: readonly T[];
  deletedThreadId: T["id"];
  sortOrder: SidebarThreadSortOrder;
  deletedThreadIds?: ReadonlySet<T["id"]>;
}): T["id"] | null {
  const { deletedThreadId, deletedThreadIds, sortOrder, threads } = input;
  const deletedThread = threads.find((thread) => thread.id === deletedThreadId);
  if (!deletedThread) {
    return null;
  }

  return (
    sortThreads(
      threads.filter(
        (thread) =>
          thread.projectId === deletedThread.projectId &&
          thread.id !== deletedThreadId &&
          !deletedThreadIds?.has(thread.id),
      ),
      sortOrder,
    )[0]?.id ?? null
  );
}
export function getProjectSortTimestamp(
  project: SidebarProject,
  projectThreads: readonly ThreadSortInput[],
  sortOrder: Exclude<SidebarProjectSortOrder, "manual">,
): number {
  if (projectThreads.length > 0) {
    return projectThreads.reduce(
      (latest, thread) => Math.max(latest, getThreadSortTimestamp(thread, sortOrder)),
      Number.NEGATIVE_INFINITY,
    );
  }

  if (sortOrder === "created_at") {
    return toSortableTimestamp(project.createdAt) ?? Number.NEGATIVE_INFINITY;
  }
  return toSortableTimestamp(project.updatedAt ?? project.createdAt) ?? Number.NEGATIVE_INFINITY;
}

function sortProjectsByActivity<TProject extends SidebarProject>(
  projects: readonly TProject[],
  sortOrder: SidebarProjectSortOrder,
  getProjectThreads: (project: TProject) => readonly ThreadSortInput[],
  compareTies: (left: TProject, right: TProject) => number,
): TProject[] {
  if (sortOrder === "manual") {
    return [...projects];
  }

  return [...projects].toSorted((left, right) => {
    const rightTimestamp = getProjectSortTimestamp(right, getProjectThreads(right), sortOrder);
    const leftTimestamp = getProjectSortTimestamp(left, getProjectThreads(left), sortOrder);
    const byTimestamp =
      rightTimestamp === leftTimestamp ? 0 : rightTimestamp > leftTimestamp ? 1 : -1;
    return byTimestamp || compareTies(left, right);
  });
}

export function sortProjectsForSidebar<
  TProject extends SidebarProject,
  TThread extends Pick<Thread, "projectId" | "createdAt" | "updatedAt"> & ThreadSortInput,
>(
  projects: readonly TProject[],
  threads: readonly TThread[],
  sortOrder: SidebarProjectSortOrder,
): TProject[] {
  const threadsByProjectId = new Map<string, TThread[]>();
  for (const thread of threads) {
    const existing = threadsByProjectId.get(thread.projectId) ?? [];
    existing.push(thread);
    threadsByProjectId.set(thread.projectId, existing);
  }

  return sortProjectsByActivity(
    projects,
    sortOrder,
    (project) => threadsByProjectId.get(project.id) ?? [],
    (left, right) => left.title.localeCompare(right.title) || left.id.localeCompare(right.id),
  );
}

/**
 * Sorts the cross-environment project collection used by landing surfaces.
 * Project ids are only unique within an environment, and archived threads
 * must not make a project appear recently active.
 */
export function sortScopedProjectsForSidebar<
  TProject extends ScopedSidebarProject,
  TThread extends ScopedSidebarThread,
>(
  projects: readonly TProject[],
  threads: readonly TThread[],
  sortOrder: SidebarProjectSortOrder,
): TProject[] {
  const scopedKey = (environmentId: string, projectId: string) =>
    `${environmentId}\u0000${projectId}`;
  const threadsByProject = new Map<string, TThread[]>();
  for (const thread of threads) {
    if (thread.archivedAt !== null) {
      continue;
    }
    const key = scopedKey(thread.environmentId, thread.projectId);
    const existing = threadsByProject.get(key) ?? [];
    existing.push(thread);
    threadsByProject.set(key, existing);
  }

  return sortProjectsByActivity(
    projects,
    sortOrder,
    (project) => threadsByProject.get(scopedKey(project.environmentId, project.id)) ?? [],
    (left, right) =>
      left.title.localeCompare(right.title) ||
      left.environmentId.localeCompare(right.environmentId) ||
      left.id.localeCompare(right.id),
  );
}
