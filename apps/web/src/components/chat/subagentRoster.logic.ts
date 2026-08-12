import {
  isFreshRunningSubagent,
  type OrchestrationThreadSubagent,
  type OrchestrationThreadSubagentStatus,
  type ThreadId,
} from "@t3tools/contracts";

import type { SubagentGroup } from "../../session-logic";

/**
 * One subagent of a thread, merged from the two client-side sources.
 *
 * `deriveSubagentGroups` only sees a subagent while its spawning
 * `collab_agent_tool_call` row is still inside the capped activity window, and
 * it downgrades a lingering group to `stopped` once the turn settles. The
 * `thread.subagents` read model has neither limit. Merging them here gives the
 * banner, the switcher strip and the drawer one list they cannot disagree on.
 */
export interface SubagentRosterEntry {
  /** Stable address for `rightPanelStore.openSubagent`. */
  key: string;
  subagentId: string | null;
  name: string;
  description: string | null;
  status: OrchestrationThreadSubagentStatus;
  startedAt: string;
  completedAt: string | null;
  lastProgressSummary: string | null;
  lastToolName: string | null;
  /** The child thread a thread-backed subagent runs as; null for in-process ones. */
  childThreadId: ThreadId | null;
  group: SubagentGroup | null;
  readModel: OrchestrationThreadSubagent | null;
}

/** Status dot colour, shared by the inspector switcher and the roster popover. */
export const SUBAGENT_STATUS_DOT_CLASS: Record<OrchestrationThreadSubagentStatus, string> = {
  running: "bg-sky-500 dark:bg-sky-300/80 animate-status-pulse motion-reduce:animate-none",
  completed: "bg-emerald-500 dark:bg-emerald-300/90",
  failed: "bg-destructive",
  stopped: "bg-muted-foreground/40",
};

/** Human status word, shared by every subagent surface. */
export const SUBAGENT_STATUS_LABEL: Record<OrchestrationThreadSubagentStatus, string> = {
  running: "Running",
  completed: "Done",
  failed: "Failed",
  stopped: "Stopped",
};

function entryFor(
  group: SubagentGroup | null,
  readModel: OrchestrationThreadSubagent | null,
): SubagentRosterEntry {
  const key = group
    ? (group.toolCallId ?? group.entryId)
    : (readModel?.spawnedByItemId ?? readModel?.subagentId ?? "");
  return {
    key,
    subagentId: readModel?.subagentId ?? null,
    name: readModel?.agentType ?? group?.name ?? "Subagent",
    description: readModel?.description ?? group?.description ?? null,
    // The read-model status wins whenever a row exists: a settled turn turns a
    // lingering group `stopped` while the subagent is genuinely still running.
    status: readModel?.status ?? group?.status ?? "stopped",
    startedAt: readModel?.startedAt ?? group?.startedAt ?? "",
    completedAt: readModel?.completedAt ?? group?.completedAt ?? null,
    lastProgressSummary: readModel?.lastProgressSummary ?? null,
    lastToolName: readModel?.lastToolName ?? null,
    childThreadId: readModel?.childThreadId ?? null,
    group,
    readModel,
  };
}

/**
 * Merge derived groups and read-model rows into one ordered roster.
 *
 * The join is `group.toolCallId === subagent.spawnedByItemId` — the same one
 * `toSubagentGroup` uses. Unmatched groups and unmatched rows both survive; no
 * `subagentId` and no key appears twice.
 */
export function buildSubagentRoster(input: {
  groups: ReadonlyArray<SubagentGroup>;
  subagents: ReadonlyArray<OrchestrationThreadSubagent>;
}): SubagentRosterEntry[] {
  const bySpawnedByItemId = new Map<string, OrchestrationThreadSubagent>();
  for (const subagent of input.subagents) {
    const spawnedByItemId = subagent.spawnedByItemId;
    if (spawnedByItemId !== undefined && !bySpawnedByItemId.has(spawnedByItemId)) {
      bySpawnedByItemId.set(spawnedByItemId, subagent);
    }
  }

  const claimedSubagentIds = new Set<string>();
  const entries: SubagentRosterEntry[] = [];
  const keys = new Set<string>();
  const push = (entry: SubagentRosterEntry) => {
    if (entry.key === "" || keys.has(entry.key)) return;
    keys.add(entry.key);
    entries.push(entry);
  };

  for (const group of input.groups) {
    const matched = group.toolCallId === null ? undefined : bySpawnedByItemId.get(group.toolCallId);
    const readModel = matched && !claimedSubagentIds.has(matched.subagentId) ? matched : null;
    if (readModel) claimedSubagentIds.add(readModel.subagentId);
    push(entryFor(group, readModel));
  }

  for (const subagent of input.subagents) {
    if (claimedSubagentIds.has(subagent.subagentId)) continue;
    claimedSubagentIds.add(subagent.subagentId);
    push(entryFor(null, subagent));
  }

  // Mirrors the server's `ORDER BY started_at ASC, subagent_id ASC`.
  return entries.toSorted(
    (left, right) =>
      left.startedAt.localeCompare(right.startedAt) || left.key.localeCompare(right.key),
  );
}

/**
 * Look an entry up by any address an older build may have persisted.
 *
 * `rightPanelStore` keeps an opaque key across reloads and its persist
 * migration only rejects an empty string, so accept the roster key, the
 * subagent id, and the spawning work-log entry id.
 */
export function findRosterEntry(
  roster: ReadonlyArray<SubagentRosterEntry>,
  key: string,
): SubagentRosterEntry | undefined {
  return (
    roster.find((entry) => entry.key === key) ??
    roster.find((entry) => entry.subagentId === key) ??
    roster.find((entry) => entry.group?.entryId === key)
  );
}

/**
 * Reading order for the roster popover: what is still working first.
 *
 * Running entries come oldest-first, because the one that has been going
 * longest is the one a human wonders about. Settled entries follow
 * newest-first, so the last thing to finish sits right under them. Both sorts
 * are stable, so an entry with no `completedAt` keeps its incoming position.
 */
export function orderRosterForDisplay(
  roster: ReadonlyArray<SubagentRosterEntry>,
): SubagentRosterEntry[] {
  const running = roster
    .filter((entry) => entry.status === "running")
    .toSorted((left, right) => left.startedAt.localeCompare(right.startedAt));
  const settled = roster
    .filter((entry) => entry.status !== "running")
    .toSorted((left, right) => (right.completedAt ?? "").localeCompare(left.completedAt ?? ""));
  return [...running, ...settled];
}

export function countRunningSubagents(roster: ReadonlyArray<SubagentRosterEntry>): number {
  return roster.filter((entry) => entry.status === "running").length;
}

/** Roster key of the first running subagent, for the composer banner's View. */
export function resolveFirstRunningRosterKey(
  roster: ReadonlyArray<SubagentRosterEntry>,
): string | null {
  return roster.find((entry) => entry.status === "running")?.key ?? null;
}

/** Why the drawer cannot message or stop a subagent it does have a row for. */
export function subagentInteractionDisabledReason(
  subagent: Pick<OrchestrationThreadSubagent, "status" | "updatedAt">,
  nowMs: number,
): string | null {
  if (subagent.status !== "running") return "This subagent is no longer running.";
  if (!isFreshRunningSubagent(subagent, nowMs)) {
    return "This subagent has not reported recent activity.";
  }
  return null;
}

/** Why a subagent with no read-model row can never be addressed. */
export const UNADDRESSABLE_SUBAGENT_REASON =
  "This provider does not report a subagent id, so T3 Code cannot message or stop this subagent.";

/**
 * What the drawer can do with one subagent.
 *
 * `parent-mediated` is the in-process arm: a steer is handed to the parent
 * session, which passes it on at its next turn boundary. `thread-backed` is the
 * child-thread arm: the message starts a turn on the child directly. This is
 * the one branch point, so the drawer stays a single component.
 */
export type SubagentInteraction =
  | { kind: "thread-backed"; subagentId: string; childThreadId: ThreadId }
  | { kind: "parent-mediated"; subagentId: string }
  | { kind: "settled"; subagentId: string; reason: string }
  | { kind: "unaddressable"; reason: string };

export function resolveSubagentInteraction(
  entry: SubagentRosterEntry,
  nowMs: number,
): SubagentInteraction {
  const readModel = entry.readModel;
  // A group-only entry carries no subagent id, so no command can name it.
  if (readModel === null) {
    return { kind: "unaddressable", reason: UNADDRESSABLE_SUBAGENT_REASON };
  }
  // A thread-backed child skips the freshness check on purpose: the parent's
  // mirror stops when `spawn_agent` times out, but the child keeps running and
  // its own thread reports the live turn state the composer needs.
  if (readModel.childThreadId !== undefined && readModel.status === "running") {
    return {
      kind: "thread-backed",
      subagentId: readModel.subagentId,
      childThreadId: readModel.childThreadId,
    };
  }
  const reason = subagentInteractionDisabledReason(readModel, nowMs);
  if (reason !== null) {
    return { kind: "settled", subagentId: readModel.subagentId, reason };
  }
  return { kind: "parent-mediated", subagentId: readModel.subagentId };
}

export function formatSubagentRosterSummary(
  roster: ReadonlyArray<Pick<SubagentRosterEntry, "status">>,
): string {
  const counts = { running: 0, completed: 0, failed: 0 };
  for (const entry of roster) {
    if (entry.status === "running") counts.running += 1;
    if (entry.status === "completed") counts.completed += 1;
    if (entry.status === "failed") counts.failed += 1;
  }

  return [
    counts.running > 0 ? `${counts.running} running` : null,
    counts.completed > 0 ? `${counts.completed} done` : null,
    counts.failed > 0 ? `${counts.failed} failed` : null,
  ]
    .filter((segment): segment is string => segment !== null)
    .join(" · ");
}
