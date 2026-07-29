export const EPIC_PLAN_MARKER_PREFIX = "T3_EPIC_PLAN:";

export interface EpicPlanMarker {
  readonly v: 1;
  readonly epicId: string;
}

export function formatEpicPlanMarker(epicId: string): string {
  const trimmed = epicId.trim();
  if (trimmed.length === 0) {
    throw new Error("epicId must not be empty");
  }
  return `${EPIC_PLAN_MARKER_PREFIX} ${JSON.stringify({ v: 1, epicId: trimmed })}`;
}

export function parseTerminalEpicPlanMarker(text: string): EpicPlanMarker | null {
  const occurrences = text.split(EPIC_PLAN_MARKER_PREFIX).length - 1;
  if (occurrences !== 1) {
    return null;
  }
  const line = text.trimEnd().split("\n").at(-1);
  if (!line?.startsWith(`${EPIC_PLAN_MARKER_PREFIX} `)) {
    return null;
  }
  const json = line.slice(EPIC_PLAN_MARKER_PREFIX.length + 1);
  try {
    const value: unknown = JSON.parse(json);
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      Object.keys(value).length !== 2 ||
      (value as { v?: unknown }).v !== 1 ||
      typeof (value as { epicId?: unknown }).epicId !== "string" ||
      (value as { epicId: string }).epicId.trim().length === 0
    ) {
      return null;
    }
    return { v: 1, epicId: (value as { epicId: string }).epicId };
  } catch {
    return null;
  }
}
