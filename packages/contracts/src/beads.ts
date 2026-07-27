import * as Schema from "effect/Schema";
import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const BeadsStatusInput = Schema.Struct({
  workspaceRoot: TrimmedNonEmptyString,
});
export type BeadsStatusInput = typeof BeadsStatusInput.Type;

/**
 * `status` and `issueType` stay free-form strings on purpose: they come from the
 * external `bd` CLI, which may add values (`in_progress`, `blocked`, `chore`, ...)
 * without us shipping a matching release. A read model must never fail to decode
 * because the tool it observes learned a new word.
 */
export const BeadsIssueSummary = Schema.Struct({
  id: TrimmedNonEmptyString,
  title: Schema.String,
  status: TrimmedNonEmptyString,
  issueType: TrimmedNonEmptyString,
  priority: NonNegativeInt,
  assignee: Schema.NullOr(TrimmedNonEmptyString),
  parent: Schema.NullOr(TrimmedNonEmptyString),
  blockedBy: Schema.Array(TrimmedNonEmptyString),
  isReady: Schema.Boolean,
});
export type BeadsIssueSummary = typeof BeadsIssueSummary.Type;

export const BeadsChildCounts = Schema.Struct({
  total: NonNegativeInt,
  ready: NonNegativeInt,
  /** Child count per `bd` status value, keyed by the raw status string. */
  byStatus: Schema.Record(Schema.String, NonNegativeInt),
});
export type BeadsChildCounts = typeof BeadsChildCounts.Type;

export const BeadsEpicSummary = Schema.Struct({
  id: TrimmedNonEmptyString,
  title: Schema.String,
  status: TrimmedNonEmptyString,
  childCounts: BeadsChildCounts,
});
export type BeadsEpicSummary = typeof BeadsEpicSummary.Type;

export const BeadsUnavailableReason = Schema.Literals([
  /** The workspace has no `.beads/metadata.json`, so it does not use beads. */
  "no-beads",
  /** The `bd` binary could not be resolved from PATH. */
  "bd-not-found",
  /** `bd` ran but failed or produced output we could not parse. */
  "bd-failed",
]);
export type BeadsUnavailableReason = typeof BeadsUnavailableReason.Type;

export const BeadsStatusResult = Schema.Union([
  Schema.TaggedStruct("available", {
    workspaceRoot: TrimmedNonEmptyString,
    epics: Schema.Array(BeadsEpicSummary),
    issues: Schema.Array(BeadsIssueSummary),
    readyCount: NonNegativeInt,
    lastTouchedId: Schema.NullOr(TrimmedNonEmptyString),
    fetchedAt: Schema.DateTimeUtc,
  }),
  Schema.TaggedStruct("unavailable", {
    workspaceRoot: TrimmedNonEmptyString,
    reason: BeadsUnavailableReason,
    detail: Schema.NullOr(Schema.String),
    fetchedAt: Schema.DateTimeUtc,
  }),
]);
export type BeadsStatusResult = typeof BeadsStatusResult.Type;
