import type { OrchestrationThreadActivity } from "@t3tools/contracts";

export interface SubagentActivityLink {
  readonly subagentId: string;
  readonly spawnedByItemId?: string;
}

/**
 * Activity payloads are `Schema.Unknown` on the wire, and the two link fields
 * this match needs are written across many activity kinds, so no single
 * contract schema covers them. `in` reads the fields without claiming a shape
 * the payload may not have.
 */
export function isSubagentActivity(
  activity: OrchestrationThreadActivity,
  subagent: SubagentActivityLink,
): boolean {
  const payload = activity.payload;
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return false;

  const parentToolUseId = "parentToolUseId" in payload ? payload.parentToolUseId : undefined;
  const taskId = "taskId" in payload ? payload.taskId : undefined;
  return (
    (subagent.spawnedByItemId !== undefined && parentToolUseId === subagent.spawnedByItemId) ||
    taskId === subagent.subagentId
  );
}

export function selectLiveSubagentTail(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  subagent: SubagentActivityLink,
): ReadonlyArray<OrchestrationThreadActivity> {
  return activities.filter((activity) => isSubagentActivity(activity, subagent));
}

function compareActivityOrder(
  left: OrchestrationThreadActivity,
  right: OrchestrationThreadActivity,
): number {
  return (
    (left.sequence ?? Number.MAX_SAFE_INTEGER) - (right.sequence ?? Number.MAX_SAFE_INTEGER) ||
    left.createdAt.localeCompare(right.createdAt) ||
    left.id.localeCompare(right.id)
  );
}

function shouldReplaceActivity(
  current: OrchestrationThreadActivity,
  candidate: OrchestrationThreadActivity,
): boolean {
  const currentSequence = current.sequence ?? -1;
  const candidateSequence = candidate.sequence ?? -1;
  return (
    candidateSequence > currentSequence ||
    (candidateSequence === currentSequence && candidate.createdAt > current.createdAt)
  );
}

/**
 * Merge paginated history with the capped live tail using replay-safe activity ids.
 *
 * The server pages sequence-less activities as oldest, but display order puts them
 * last. Only rows from before migration 008 lack a sequence, so ancient pages can
 * interleave oddly. Dedupe remains correct and the result matches display order.
 */
export function mergeSubagentActivities(
  pages: ReadonlyArray<ReadonlyArray<OrchestrationThreadActivity>>,
  liveTail: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyArray<OrchestrationThreadActivity> {
  const byId = new Map<string, OrchestrationThreadActivity>();

  for (const activity of [...pages.flat(), ...liveTail]) {
    const current = byId.get(activity.id);
    if (current === undefined || shouldReplaceActivity(current, activity)) {
      byId.set(activity.id, activity);
    }
  }

  return [...byId.values()].sort(compareActivityOrder);
}
