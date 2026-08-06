import { Debouncer } from "@tanstack/react-pacer";
import { create } from "zustand";
import { normalizeProjectPathForComparison } from "./lib/projectPaths";

export const PERSISTED_STATE_KEY = "t3code:ui-state:v1";
const LEGACY_PERSISTED_STATE_KEYS = [
  "t3code:renderer-state:v8",
  "t3code:renderer-state:v7",
  "t3code:renderer-state:v6",
  "t3code:renderer-state:v5",
  "t3code:renderer-state:v4",
  "t3code:renderer-state:v3",
  "codething:renderer-state:v4",
  "codething:renderer-state:v3",
  "codething:renderer-state:v2",
  "codething:renderer-state:v1",
] as const;

export interface PersistedUiState {
  projectExpandedById?: Record<string, boolean>;
  projectOrder?: string[];
  threadLastVisitedAtById?: Record<string, string>;
  epicsLastVisitedAt?: string;
  collapsedProjectCwds?: string[];
  expandedProjectCwds?: string[];
  projectOrderCwds?: string[];
  defaultAdvertisedEndpointKey?: string | null;
  threadChangedFilesExpandedById?: Record<string, Record<string, boolean>>;
  threadSubagentExpandedById?: Record<string, Record<string, boolean>>;
  epicRunGroupExpandedByRunId?: Record<string, boolean>;
  epicRunGroupHiddenByRunId?: Record<string, boolean>;
  plannedEpicBannerDismissedByIdentity?: Record<string, boolean>;
  epicsProjectGroupCollapsedByKey?: Record<string, boolean>;
}

export interface UiProjectState {
  projectExpandedById: Record<string, boolean>;
  projectOrder: string[];
}

export interface UiThreadState {
  threadLastVisitedAtById: Record<string, string>;
  threadChangedFilesExpandedById: Record<string, Record<string, boolean>>;
  /**
   * Expanded subagent cards per thread, keyed by routeThreadKey → subagent key
   * (the Task tool_use id, or the timeline entry id when the provider gave
   * none). Cards default collapsed, so only explicit expansions (`true`) land
   * here and re-opening a thread keeps its cards open.
   */
  threadSubagentExpandedById: Record<string, Record<string, boolean>>;
  epicsLastVisitedAt: string | null;
  /**
   * Explicit sidebar expand/collapse per epic run, keyed by run id. Only rows
   * the user actually toggled land here — the rest follow the status default
   * (see `resolveEpicRunGroupExpanded`), so this does not grow with every run.
   */
  epicRunGroupExpandedByRunId: Record<string, boolean>;
  /**
   * Epic runs hidden from the sidebar, keyed by run id. An absent key means
   * the run remains visible, so only explicit hides (`true`) are persisted.
   */
  epicRunGroupHiddenByRunId: Record<string, boolean>;
  /**
   * Planned-epic composer notices the user dismissed, keyed by
   * `plannedEpicIdentity` (`environmentId:projectId:epicId`). Only dismissals
   * land here — an absent key means the notice is still showing. The notice is
   * derived from the thread's `T3_EPIC_PLAN` marker, which never leaves the
   * message history, so this is the only thing that can suppress it once a run
   * has finished.
   */
  plannedEpicBannerDismissedByIdentity: Record<string, boolean>;
  /**
   * Explicit collapse/expand per Epics-page project group, keyed by
   * `epicSourceKey` (`${environmentId}\0${workspaceRoot}`) — the same
   * (environment, workspace) pair one beads snapshot is fetched under. Only
   * groups the user actually toggled land here; an absent key means the
   * computed default (expanded), so this does not grow with every project.
   */
  epicsProjectGroupCollapsedByKey: Record<string, boolean>;
}

export interface UiEndpointState {
  defaultAdvertisedEndpointKey: string | null;
}

export interface UiState extends UiProjectState, UiThreadState, UiEndpointState {}

const initialState: UiState = {
  projectExpandedById: {},
  projectOrder: [],
  threadLastVisitedAtById: {},
  epicsLastVisitedAt: null,
  threadChangedFilesExpandedById: {},
  threadSubagentExpandedById: {},
  epicRunGroupExpandedByRunId: {},
  epicRunGroupHiddenByRunId: {},
  plannedEpicBannerDismissedByIdentity: {},
  epicsProjectGroupCollapsedByKey: {},
  defaultAdvertisedEndpointKey: null,
};

const LEGACY_PROJECT_CWD_PREFERENCE_PREFIX = "legacy-project-cwd:";
const LEGACY_PROJECT_EXPANSION_DEFAULT_KEY = "legacy-project-expansion-default";
let legacyKeysCleanedUp = false;

export function legacyProjectCwdPreferenceKey(cwd: string): string {
  return `${LEGACY_PROJECT_CWD_PREFERENCE_PREFIX}${normalizeProjectPathForComparison(cwd)}`;
}

function sanitizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return [
    ...new Set(
      value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0),
    ),
  ];
}

function sanitizeBooleanRecord(value: unknown): Record<string, boolean> {
  if (!value || typeof value !== "object") {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, boolean] => entry[0].length > 0 && typeof entry[1] === "boolean",
    ),
  );
}

function sanitizeDismissedRecord(value: unknown): Record<string, boolean> {
  return Object.fromEntries(
    Object.entries(sanitizeBooleanRecord(value)).filter(([, dismissed]) => dismissed),
  );
}

function sanitizeTimestampRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] =>
        entry[0].length > 0 &&
        typeof entry[1] === "string" &&
        entry[1].length > 0 &&
        Number.isFinite(Date.parse(entry[1])),
    ),
  );
}

function sanitizeTimestamp(value: unknown): string | null {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
}

export function parsePersistedState(parsed: PersistedUiState): UiState {
  const projectExpandedById =
    parsed.projectExpandedById === undefined
      ? (() => {
          const migrated: Record<string, boolean> = {};
          const collapsedProjectCwds = sanitizeStringArray(parsed.collapsedProjectCwds);
          const expandedProjectCwds = sanitizeStringArray(parsed.expandedProjectCwds);
          for (const cwd of collapsedProjectCwds) {
            migrated[legacyProjectCwdPreferenceKey(cwd)] = false;
          }
          for (const cwd of expandedProjectCwds) {
            migrated[legacyProjectCwdPreferenceKey(cwd)] = true;
          }
          if (!Array.isArray(parsed.collapsedProjectCwds) && expandedProjectCwds.length > 0) {
            migrated[LEGACY_PROJECT_EXPANSION_DEFAULT_KEY] = false;
          }
          return migrated;
        })()
      : sanitizeBooleanRecord(parsed.projectExpandedById);
  const projectOrder =
    parsed.projectOrder === undefined
      ? sanitizeStringArray(parsed.projectOrderCwds).map(legacyProjectCwdPreferenceKey)
      : sanitizeStringArray(parsed.projectOrder);

  return {
    projectExpandedById,
    projectOrder,
    threadLastVisitedAtById: sanitizeTimestampRecord(parsed.threadLastVisitedAtById),
    epicsLastVisitedAt: sanitizeTimestamp(parsed.epicsLastVisitedAt),
    threadChangedFilesExpandedById: sanitizePersistedThreadChangedFilesExpanded(
      parsed.threadChangedFilesExpandedById,
    ),
    threadSubagentExpandedById: sanitizePersistedThreadSubagentExpanded(
      parsed.threadSubagentExpandedById,
    ),
    epicRunGroupExpandedByRunId: sanitizeBooleanRecord(parsed.epicRunGroupExpandedByRunId),
    epicRunGroupHiddenByRunId: sanitizeDismissedRecord(parsed.epicRunGroupHiddenByRunId),
    plannedEpicBannerDismissedByIdentity: sanitizeDismissedRecord(
      parsed.plannedEpicBannerDismissedByIdentity,
    ),
    epicsProjectGroupCollapsedByKey: sanitizeBooleanRecord(parsed.epicsProjectGroupCollapsedByKey),
    defaultAdvertisedEndpointKey:
      typeof parsed.defaultAdvertisedEndpointKey === "string" &&
      parsed.defaultAdvertisedEndpointKey.length > 0
        ? parsed.defaultAdvertisedEndpointKey
        : null,
  };
}

function readPersistedState(): UiState {
  if (typeof window === "undefined") {
    return initialState;
  }
  try {
    const raw = window.localStorage.getItem(PERSISTED_STATE_KEY);
    if (!raw) {
      for (const legacyKey of LEGACY_PERSISTED_STATE_KEYS) {
        const legacyRaw = window.localStorage.getItem(legacyKey);
        if (!legacyRaw) {
          continue;
        }
        return parsePersistedState(JSON.parse(legacyRaw) as PersistedUiState);
      }
      return initialState;
    }
    return parsePersistedState(JSON.parse(raw) as PersistedUiState);
  } catch {
    return initialState;
  }
}

function sanitizePersistedThreadChangedFilesExpanded(
  value: PersistedUiState["threadChangedFilesExpandedById"],
): Record<string, Record<string, boolean>> {
  if (!value || typeof value !== "object") {
    return {};
  }

  const nextState: Record<string, Record<string, boolean>> = {};
  for (const [threadId, turns] of Object.entries(value)) {
    if (!threadId || !turns || typeof turns !== "object") {
      continue;
    }

    const nextTurns: Record<string, boolean> = {};
    for (const [turnId, expanded] of Object.entries(turns)) {
      if (turnId && typeof expanded === "boolean" && expanded === false) {
        nextTurns[turnId] = false;
      }
    }

    if (Object.keys(nextTurns).length > 0) {
      nextState[threadId] = nextTurns;
    }
  }

  return nextState;
}

function sanitizePersistedThreadSubagentExpanded(
  value: PersistedUiState["threadSubagentExpandedById"],
): Record<string, Record<string, boolean>> {
  if (!value || typeof value !== "object") {
    return {};
  }

  const nextState: Record<string, Record<string, boolean>> = {};
  for (const [threadId, subagents] of Object.entries(value)) {
    if (!threadId || !subagents || typeof subagents !== "object") {
      continue;
    }

    const nextSubagents: Record<string, boolean> = {};
    for (const [subagentKey, expanded] of Object.entries(subagents)) {
      if (subagentKey && expanded === true) {
        nextSubagents[subagentKey] = true;
      }
    }

    if (Object.keys(nextSubagents).length > 0) {
      nextState[threadId] = nextSubagents;
    }
  }

  return nextState;
}

export function persistState(state: UiState): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    const projectExpandedById = Object.fromEntries(
      Object.entries(state.projectExpandedById).filter(
        ([key]) => key !== LEGACY_PROJECT_EXPANSION_DEFAULT_KEY,
      ),
    );
    const threadChangedFilesExpandedById = Object.fromEntries(
      Object.entries(state.threadChangedFilesExpandedById).flatMap(([threadId, turns]) => {
        const nextTurns = Object.fromEntries(
          Object.entries(turns).filter(([, expanded]) => expanded === false),
        );
        return Object.keys(nextTurns).length > 0 ? [[threadId, nextTurns]] : [];
      }),
    );
    window.localStorage.setItem(
      PERSISTED_STATE_KEY,
      JSON.stringify({
        projectExpandedById,
        projectOrder: state.projectOrder,
        threadLastVisitedAtById: state.threadLastVisitedAtById,
        ...(state.epicsLastVisitedAt ? { epicsLastVisitedAt: state.epicsLastVisitedAt } : {}),
        defaultAdvertisedEndpointKey: state.defaultAdvertisedEndpointKey,
        threadChangedFilesExpandedById,
        threadSubagentExpandedById: state.threadSubagentExpandedById,
        epicRunGroupExpandedByRunId: state.epicRunGroupExpandedByRunId,
        epicRunGroupHiddenByRunId: sanitizeDismissedRecord(state.epicRunGroupHiddenByRunId),
        plannedEpicBannerDismissedByIdentity: state.plannedEpicBannerDismissedByIdentity,
        epicsProjectGroupCollapsedByKey: state.epicsProjectGroupCollapsedByKey,
      } satisfies PersistedUiState),
    );
    if (!legacyKeysCleanedUp) {
      legacyKeysCleanedUp = true;
      for (const legacyKey of LEGACY_PERSISTED_STATE_KEYS) {
        window.localStorage.removeItem(legacyKey);
      }
    }
  } catch {
    // Ignore quota/storage errors to avoid breaking chat UX.
  }
}

const debouncedPersistState = new Debouncer(persistState, { wait: 500 });

export function markThreadVisited(state: UiState, threadId: string, visitedAt: string): UiState {
  const visitedAtMs = Date.parse(visitedAt);
  if (!Number.isFinite(visitedAtMs)) {
    return state;
  }
  const previousVisitedAt = state.threadLastVisitedAtById[threadId];
  const previousVisitedAtMs = previousVisitedAt ? Date.parse(previousVisitedAt) : NaN;
  if (
    Number.isFinite(previousVisitedAtMs) &&
    Number.isFinite(visitedAtMs) &&
    previousVisitedAtMs >= visitedAtMs
  ) {
    return state;
  }
  return {
    ...state,
    threadLastVisitedAtById: {
      ...state.threadLastVisitedAtById,
      [threadId]: visitedAt,
    },
  };
}

export function markEpicsVisited(state: UiState, visitedAt: string): UiState {
  const visitedAtMs = Date.parse(visitedAt);
  if (!Number.isFinite(visitedAtMs)) return state;
  const previousMs = state.epicsLastVisitedAt ? Date.parse(state.epicsLastVisitedAt) : NaN;
  if (Number.isFinite(previousMs) && previousMs >= visitedAtMs) return state;
  return { ...state, epicsLastVisitedAt: visitedAt };
}

export function markThreadUnread(
  state: UiState,
  threadId: string,
  latestTurnCompletedAt: string | null | undefined,
): UiState {
  if (!latestTurnCompletedAt) {
    return state;
  }
  const latestTurnCompletedAtMs = Date.parse(latestTurnCompletedAt);
  if (Number.isNaN(latestTurnCompletedAtMs)) {
    return state;
  }
  const unreadVisitedAt = new Date(latestTurnCompletedAtMs - 1).toISOString();
  if (state.threadLastVisitedAtById[threadId] === unreadVisitedAt) {
    return state;
  }
  return {
    ...state,
    threadLastVisitedAtById: {
      ...state.threadLastVisitedAtById,
      [threadId]: unreadVisitedAt,
    },
  };
}

export function setThreadChangedFilesExpanded(
  state: UiState,
  threadId: string,
  turnId: string,
  expanded: boolean,
): UiState {
  const currentThreadState = state.threadChangedFilesExpandedById[threadId] ?? {};
  const currentExpanded = currentThreadState[turnId] ?? true;
  if (currentExpanded === expanded) {
    return state;
  }

  if (expanded) {
    if (!(turnId in currentThreadState)) {
      return state;
    }

    const nextThreadState = { ...currentThreadState };
    delete nextThreadState[turnId];
    if (Object.keys(nextThreadState).length === 0) {
      const nextState = { ...state.threadChangedFilesExpandedById };
      delete nextState[threadId];
      return {
        ...state,
        threadChangedFilesExpandedById: nextState,
      };
    }

    return {
      ...state,
      threadChangedFilesExpandedById: {
        ...state.threadChangedFilesExpandedById,
        [threadId]: nextThreadState,
      },
    };
  }

  return {
    ...state,
    threadChangedFilesExpandedById: {
      ...state.threadChangedFilesExpandedById,
      [threadId]: {
        ...currentThreadState,
        [turnId]: false,
      },
    },
  };
}

export function setThreadSubagentExpanded(
  state: UiState,
  threadId: string,
  subagentKey: string,
  expanded: boolean,
): UiState {
  if (threadId.length === 0 || subagentKey.length === 0) {
    return state;
  }
  const currentThreadState = state.threadSubagentExpandedById[threadId] ?? {};
  const currentExpanded = currentThreadState[subagentKey] ?? false;
  if (currentExpanded === expanded) {
    return state;
  }

  // Collapsed is the default — drop the key (and the thread record when empty)
  // instead of storing `false`, so the persisted map only grows with explicit
  // expansions.
  if (!expanded) {
    const nextThreadState = { ...currentThreadState };
    delete nextThreadState[subagentKey];
    if (Object.keys(nextThreadState).length === 0) {
      const nextState = { ...state.threadSubagentExpandedById };
      delete nextState[threadId];
      return {
        ...state,
        threadSubagentExpandedById: nextState,
      };
    }

    return {
      ...state,
      threadSubagentExpandedById: {
        ...state.threadSubagentExpandedById,
        [threadId]: nextThreadState,
      },
    };
  }

  return {
    ...state,
    threadSubagentExpandedById: {
      ...state.threadSubagentExpandedById,
      [threadId]: {
        ...currentThreadState,
        [subagentKey]: true,
      },
    },
  };
}

export function setEpicRunGroupExpanded(state: UiState, runId: string, expanded: boolean): UiState {
  if (runId.length === 0 || state.epicRunGroupExpandedByRunId[runId] === expanded) {
    return state;
  }
  return {
    ...state,
    epicRunGroupExpandedByRunId: {
      ...state.epicRunGroupExpandedByRunId,
      [runId]: expanded,
    },
  };
}

export function setEpicRunGroupHidden(state: UiState, runId: string, hidden: boolean): UiState {
  if (runId.length === 0) {
    return state;
  }
  const hasEntry = Object.hasOwn(state.epicRunGroupHiddenByRunId, runId);
  if ((hidden && state.epicRunGroupHiddenByRunId[runId] === true) || (!hidden && !hasEntry)) {
    return state;
  }
  const epicRunGroupHiddenByRunId = { ...state.epicRunGroupHiddenByRunId };
  if (hidden) {
    epicRunGroupHiddenByRunId[runId] = true;
  } else {
    delete epicRunGroupHiddenByRunId[runId];
  }
  return {
    ...state,
    epicRunGroupHiddenByRunId,
  };
}

export function setPlannedEpicBannerDismissed(
  state: UiState,
  identity: string,
  dismissed: boolean,
): UiState {
  const current = state.plannedEpicBannerDismissedByIdentity[identity] ?? false;
  if (identity.length === 0 || current === dismissed) {
    return state;
  }
  const plannedEpicBannerDismissedByIdentity = { ...state.plannedEpicBannerDismissedByIdentity };
  if (dismissed) {
    plannedEpicBannerDismissedByIdentity[identity] = true;
  } else {
    delete plannedEpicBannerDismissedByIdentity[identity];
  }
  return {
    ...state,
    plannedEpicBannerDismissedByIdentity,
  };
}

export function setEpicsProjectGroupCollapsed(
  state: UiState,
  sourceKey: string,
  collapsed: boolean,
): UiState {
  if (sourceKey.length === 0 || state.epicsProjectGroupCollapsedByKey[sourceKey] === collapsed) {
    return state;
  }
  return {
    ...state,
    epicsProjectGroupCollapsedByKey: {
      ...state.epicsProjectGroupCollapsedByKey,
      [sourceKey]: collapsed,
    },
  };
}

export function setDefaultAdvertisedEndpointKey(state: UiState, key: string | null): UiState {
  const nextKey = key && key.length > 0 ? key : null;
  if (state.defaultAdvertisedEndpointKey === nextKey) {
    return state;
  }
  return {
    ...state,
    defaultAdvertisedEndpointKey: nextKey,
  };
}

export function resolveProjectExpanded(
  projectExpandedById: Readonly<Record<string, boolean>>,
  preferenceKeys: readonly string[],
): boolean {
  for (const key of preferenceKeys) {
    const expanded = projectExpandedById[key];
    if (expanded !== undefined) {
      return expanded;
    }
  }
  return projectExpandedById[LEGACY_PROJECT_EXPANSION_DEFAULT_KEY] ?? true;
}

export function setProjectExpanded(
  state: UiState,
  projectIds: string | readonly string[],
  expanded: boolean,
): UiState {
  const ids = typeof projectIds === "string" ? [projectIds] : projectIds;
  const nextEntries = ids.filter((projectId) => state.projectExpandedById[projectId] !== expanded);
  if (nextEntries.length === 0) {
    return state;
  }
  const projectExpandedById = { ...state.projectExpandedById };
  for (const projectId of nextEntries) {
    projectExpandedById[projectId] = expanded;
  }
  return {
    ...state,
    projectExpandedById,
  };
}

export function reorderProjects(
  state: UiState,
  currentProjectOrder: readonly string[],
  draggedProjectIds: readonly string[],
  targetProjectIds: readonly string[],
): UiState {
  if (draggedProjectIds.length === 0) {
    return state;
  }
  const draggedSet = new Set(draggedProjectIds);
  const targetSet = new Set(targetProjectIds);
  if (draggedProjectIds.every((id) => targetSet.has(id))) {
    return state;
  }

  const originalTargetIndex = currentProjectOrder.findIndex((id) => targetSet.has(id));
  if (originalTargetIndex < 0) {
    return state;
  }

  const projectOrder = [...currentProjectOrder];

  const removed: string[] = [];
  let draggedBeforeTarget = 0;
  for (let i = projectOrder.length - 1; i >= 0; i--) {
    if (draggedSet.has(projectOrder[i]!)) {
      removed.unshift(projectOrder.splice(i, 1)[0]!);
      if (i < originalTargetIndex) {
        draggedBeforeTarget++;
      }
    }
  }
  if (removed.length === 0) {
    return state;
  }

  const insertIndex = originalTargetIndex - Math.max(0, draggedBeforeTarget - 1);
  projectOrder.splice(insertIndex, 0, ...removed);
  return {
    ...state,
    projectOrder,
  };
}

interface UiStateStore extends UiState {
  markEpicsVisited: (visitedAt: string) => void;
  markThreadVisited: (threadId: string, visitedAt: string) => void;
  markThreadUnread: (threadId: string, latestTurnCompletedAt: string | null | undefined) => void;
  setThreadChangedFilesExpanded: (threadId: string, turnId: string, expanded: boolean) => void;
  setThreadSubagentExpanded: (threadId: string, subagentKey: string, expanded: boolean) => void;
  setEpicRunGroupExpanded: (runId: string, expanded: boolean) => void;
  setEpicRunGroupHidden: (runId: string, hidden: boolean) => void;
  setPlannedEpicBannerDismissed: (identity: string, dismissed: boolean) => void;
  setEpicsProjectGroupCollapsed: (sourceKey: string, collapsed: boolean) => void;
  setDefaultAdvertisedEndpointKey: (key: string | null) => void;
  setProjectExpanded: (projectIds: string | readonly string[], expanded: boolean) => void;
  reorderProjects: (
    currentProjectOrder: readonly string[],
    draggedProjectIds: readonly string[],
    targetProjectIds: readonly string[],
  ) => void;
}

export const useUiStateStore = create<UiStateStore>((set) => ({
  ...readPersistedState(),
  markEpicsVisited: (visitedAt) => set((state) => markEpicsVisited(state, visitedAt)),
  markThreadVisited: (threadId, visitedAt) =>
    set((state) => markThreadVisited(state, threadId, visitedAt)),
  markThreadUnread: (threadId, latestTurnCompletedAt) =>
    set((state) => markThreadUnread(state, threadId, latestTurnCompletedAt)),
  setThreadChangedFilesExpanded: (threadId, turnId, expanded) =>
    set((state) => setThreadChangedFilesExpanded(state, threadId, turnId, expanded)),
  setThreadSubagentExpanded: (threadId, subagentKey, expanded) =>
    set((state) => setThreadSubagentExpanded(state, threadId, subagentKey, expanded)),
  setEpicRunGroupExpanded: (runId, expanded) =>
    set((state) => setEpicRunGroupExpanded(state, runId, expanded)),
  setEpicRunGroupHidden: (runId, hidden) =>
    set((state) => setEpicRunGroupHidden(state, runId, hidden)),
  setPlannedEpicBannerDismissed: (identity, dismissed) =>
    set((state) => setPlannedEpicBannerDismissed(state, identity, dismissed)),
  setEpicsProjectGroupCollapsed: (sourceKey, collapsed) =>
    set((state) => setEpicsProjectGroupCollapsed(state, sourceKey, collapsed)),
  setDefaultAdvertisedEndpointKey: (key) =>
    set((state) => setDefaultAdvertisedEndpointKey(state, key)),
  setProjectExpanded: (projectIds, expanded) =>
    set((state) => setProjectExpanded(state, projectIds, expanded)),
  reorderProjects: (currentProjectOrder, draggedProjectIds, targetProjectIds) =>
    set((state) =>
      reorderProjects(state, currentProjectOrder, draggedProjectIds, targetProjectIds),
    ),
}));

useUiStateStore.subscribe((state) => debouncedPersistState.maybeExecute(state));

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("beforeunload", () => {
    debouncedPersistState.flush();
  });
}
