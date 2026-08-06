import type { SubagentInspectorGroup } from "../../lib/threadActivity";
import { formatDuration, formatElapsed } from "@t3tools/shared/orchestrationTiming";

export function sortGroupsForInspector(
  groups: ReadonlyArray<SubagentInspectorGroup>,
): SubagentInspectorGroup[] {
  return [...groups].sort((left, right) => {
    const runningOrder = Number(right.status === "running") - Number(left.status === "running");
    if (runningOrder !== 0) return runningOrder;
    return Date.parse(right.startedAt) - Date.parse(left.startedAt);
  });
}

export function statusLabel(group: SubagentInspectorGroup, now: number): string {
  switch (group.status) {
    case "running": {
      const startedAt = Date.parse(group.startedAt);
      const elapsed = Number.isFinite(startedAt) ? Math.max(0, now - startedAt) : 0;
      return `Running · ${formatDuration(elapsed)}`;
    }
    case "completed": {
      const duration = formatElapsed(group.startedAt, group.completedAt ?? undefined);
      return duration ? `Completed in ${duration}` : "Completed";
    }
    case "failed":
      return "Failed";
    case "stopped":
      return "Stopped";
  }
}

export function toolCountLabel(toolCount: number): string | null {
  if (toolCount === 0) return null;
  return toolCount === 1 ? "1 tool" : `${toolCount} tools`;
}
