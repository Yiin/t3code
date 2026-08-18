import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export const EPIC_PLAN_MARKER_PREFIX = "T3_EPIC_PLAN:";

const EpicPlanMarkerSchema = Schema.Struct({
  v: Schema.Literal(1),
  epicId: Schema.String.check(
    Schema.makeFilter((value) =>
      value.trim().length === 0 ? "Expected a non-empty epic id." : undefined,
    ),
  ),
});

export type EpicPlanMarker = typeof EpicPlanMarkerSchema.Type;

// The marker is a whole line of agent output, so an unrecognised extra key means
// a different producer wrote it. Reject rather than silently drop the key.
const decodeMarkerJson = Schema.decodeUnknownOption(Schema.fromJsonString(EpicPlanMarkerSchema), {
  onExcessProperty: "error",
});

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
  return Option.getOrNull(decodeMarkerJson(line.slice(EPIC_PLAN_MARKER_PREFIX.length + 1)));
}
