import type {
  OrchestrationThreadSubagent,
  OrchestrationThreadSubagentStatus,
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
  group: SubagentGroup | null;
  readModel: OrchestrationThreadSubagent | null;
}

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

export function countRunningSubagents(roster: ReadonlyArray<SubagentRosterEntry>): number {
  return roster.filter((entry) => entry.status === "running").length;
}

/** Roster key of the first running subagent, for the composer banner's View. */
export function resolveFirstRunningRosterKey(
  roster: ReadonlyArray<SubagentRosterEntry>,
): string | null {
  return roster.find((entry) => entry.status === "running")?.key ?? null;
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
