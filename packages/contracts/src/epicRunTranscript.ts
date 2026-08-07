import * as Schema from "effect/Schema";

import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const EPIC_RUN_TRANSCRIPT_TAGS = [
  "blocked",
  "completed-no-code",
  "dispatched",
  "done",
  "finished",
  "folded",
  "inspection-continue",
  "inspection-started",
  "inspection-stop",
  "inspection-stop-pending",
  "inspection-uncertain",
  "iteration-state-changed",
  "lock_held",
  "merged",
  "parked",
  "provider-fallback",
  "rate-limited",
  "researched",
  "retry",
  "run-state-changed",
  "subagent-liveness-degraded",
  "subagent-liveness-unavailable",
  "worker-cap",
  "worker-idle",
] as const;

export const EpicRunTranscriptMeta = Schema.Struct({
  timestamp: Schema.optional(Schema.String),
  threadId: Schema.optional(TrimmedNonEmptyString),
  pid: Schema.optional(NonNegativeInt),
  runDir: Schema.optional(TrimmedNonEmptyString),
  costUsd: Schema.optional(Schema.Number),
});
export type EpicRunTranscriptMeta = typeof EpicRunTranscriptMeta.Type;

const TranscriptFields = {
  sequence: NonNegativeInt,
  epicId: TrimmedNonEmptyString,
  issueId: Schema.NullOr(TrimmedNonEmptyString),
  iterationIndex: Schema.NullOr(NonNegativeInt),
  status: Schema.optional(Schema.Literals(["running", "paused", "done", "failed", "cancelled"])),
  turnStatus: Schema.optional(Schema.Literals(["running", "completed", "failed", "abandoned"])),
  reason: Schema.optional(Schema.String),
  failureReason: Schema.optional(Schema.NullOr(Schema.String)),
  summary: Schema.optional(Schema.NullOr(Schema.String)),
  why: Schema.optional(Schema.NullOr(Schema.String)),
  attempts: Schema.optional(NonNegativeInt),
  maxAttempts: Schema.optional(NonNegativeInt),
  comments: Schema.optional(NonNegativeInt),
  pushed: Schema.optional(Schema.Boolean),
  verified: Schema.optional(Schema.Boolean),
  fromProvider: Schema.optional(TrimmedNonEmptyString),
  toProvider: Schema.optional(TrimmedNonEmptyString),
  model: Schema.optional(TrimmedNonEmptyString),
  workerLimit: Schema.optional(NonNegativeInt),
  idleSeconds: Schema.optional(NonNegativeInt),
  elapsedSeconds: Schema.optional(NonNegativeInt),
  timeoutSeconds: Schema.optional(NonNegativeInt),
  nextCheckSeconds: Schema.optional(NonNegativeInt),
  rationale: Schema.optional(Schema.String),
  branch: Schema.optional(TrimmedNonEmptyString),
  repositories: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  meta: Schema.optional(EpicRunTranscriptMeta),
};

export const EpicRunTranscriptEvent = Schema.Union([
  Schema.TaggedStruct("blocked", TranscriptFields),
  Schema.TaggedStruct("completed-no-code", TranscriptFields),
  Schema.TaggedStruct("dispatched", TranscriptFields),
  Schema.TaggedStruct("done", TranscriptFields),
  Schema.TaggedStruct("finished", TranscriptFields),
  Schema.TaggedStruct("folded", TranscriptFields),
  Schema.TaggedStruct("inspection-continue", TranscriptFields),
  Schema.TaggedStruct("inspection-started", TranscriptFields),
  Schema.TaggedStruct("inspection-stop", TranscriptFields),
  Schema.TaggedStruct("inspection-stop-pending", TranscriptFields),
  Schema.TaggedStruct("inspection-uncertain", TranscriptFields),
  Schema.TaggedStruct("iteration-state-changed", TranscriptFields),
  Schema.TaggedStruct("lock_held", TranscriptFields),
  Schema.TaggedStruct("merged", TranscriptFields),
  Schema.TaggedStruct("parked", TranscriptFields),
  Schema.TaggedStruct("provider-fallback", TranscriptFields),
  Schema.TaggedStruct("rate-limited", TranscriptFields),
  Schema.TaggedStruct("researched", TranscriptFields),
  Schema.TaggedStruct("retry", TranscriptFields),
  Schema.TaggedStruct("run-state-changed", TranscriptFields),
  Schema.TaggedStruct("subagent-liveness-degraded", TranscriptFields),
  Schema.TaggedStruct("subagent-liveness-unavailable", TranscriptFields),
  Schema.TaggedStruct("worker-cap", TranscriptFields),
  Schema.TaggedStruct("worker-idle", TranscriptFields),
]);
export type EpicRunTranscriptEvent = typeof EpicRunTranscriptEvent.Type;

export type NormalizedEpicRunTranscriptEvent = Omit<EpicRunTranscriptEvent, "meta">;

export interface EpicRunTranscriptDiff {
  readonly index: number;
  readonly left: NormalizedEpicRunTranscriptEvent | null;
  readonly right: NormalizedEpicRunTranscriptEvent | null;
}

export interface EpicRunTranscriptDivergence extends EpicRunTranscriptDiff {
  readonly kind: "structural" | "content";
}

export const normalizeTranscript = (
  events: ReadonlyArray<EpicRunTranscriptEvent>,
): ReadonlyArray<NormalizedEpicRunTranscriptEvent> =>
  events
    .map(({ meta: _meta, ...event }) => event)
    .sort((left, right) => left.sequence - right.sequence);

const sameValue = (left: unknown, right: unknown): boolean => {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length && left.every((value, index) => sameValue(value, right[index]))
    );
  }
  if (
    typeof left === "object" &&
    left !== null &&
    typeof right === "object" &&
    right !== null &&
    !Array.isArray(left) &&
    !Array.isArray(right)
  ) {
    const leftRecord = left as Readonly<Record<string, unknown>>;
    const rightRecord = right as Readonly<Record<string, unknown>>;
    const leftKeys = Object.keys(leftRecord).sort();
    const rightKeys = Object.keys(rightRecord).sort();
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every(
        (key, index) => key === rightKeys[index] && sameValue(leftRecord[key], rightRecord[key]),
      )
    );
  }
  return false;
};

export const diffTranscripts = (
  left: ReadonlyArray<EpicRunTranscriptEvent>,
  right: ReadonlyArray<EpicRunTranscriptEvent>,
): EpicRunTranscriptDiff | null => {
  const normalizedLeft = normalizeTranscript(left);
  const normalizedRight = normalizeTranscript(right);
  const length = Math.max(normalizedLeft.length, normalizedRight.length);
  for (let index = 0; index < length; index += 1) {
    const leftEvent = normalizedLeft[index] ?? null;
    const rightEvent = normalizedRight[index] ?? null;
    if (!sameValue(leftEvent, rightEvent)) {
      return { index, left: leftEvent, right: rightEvent };
    }
  }
  return null;
};

const withoutContent = (
  event: NormalizedEpicRunTranscriptEvent,
): NormalizedEpicRunTranscriptEvent => {
  const { summary: _summary, why: _why, ...structural } = event;
  return structural as NormalizedEpicRunTranscriptEvent;
};

/** Classify every difference while treating only summary and why as free text. */
export const classifyTranscriptDivergences = (
  left: ReadonlyArray<EpicRunTranscriptEvent>,
  right: ReadonlyArray<EpicRunTranscriptEvent>,
): ReadonlyArray<EpicRunTranscriptDivergence> => {
  const normalizedLeft = normalizeTranscript(left);
  const normalizedRight = normalizeTranscript(right);
  const divergences: EpicRunTranscriptDivergence[] = [];
  const length = Math.max(normalizedLeft.length, normalizedRight.length);
  for (let index = 0; index < length; index += 1) {
    const leftEvent = normalizedLeft[index] ?? null;
    const rightEvent = normalizedRight[index] ?? null;
    if (sameValue(leftEvent, rightEvent)) continue;
    const contentOnly =
      leftEvent !== null &&
      rightEvent !== null &&
      sameValue(withoutContent(leftEvent), withoutContent(rightEvent));
    divergences.push({
      kind: contentOnly ? "content" : "structural",
      index,
      left: leftEvent,
      right: rightEvent,
    });
  }
  return divergences;
};
