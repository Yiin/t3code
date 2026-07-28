import * as Schema from "effect/Schema";
import { NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

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

export const EpicRunPreflightMode = Schema.Literals(["parallel", "sequential"]);
export type EpicRunPreflightMode = typeof EpicRunPreflightMode.Type;

export const EpicRunPreflightInput = Schema.Struct({
  workspaceRoot: TrimmedNonEmptyString,
  epicId: TrimmedNonEmptyString,
  mode: EpicRunPreflightMode,
});
export type EpicRunPreflightInput = typeof EpicRunPreflightInput.Type;

export const EpicRunPreflightBlocker = Schema.Union([
  Schema.TaggedStruct("dirty_tree", {
    paths: Schema.Array(TrimmedNonEmptyString),
  }),
  Schema.TaggedStruct("detached_head", {}),
  Schema.TaggedStruct("run_in_progress", {
    owner: TrimmedNonEmptyString,
    runDir: TrimmedNonEmptyString,
    host: TrimmedNonEmptyString,
    pid: PositiveInt,
  }),
  Schema.TaggedStruct("epic_not_found", {
    epicId: TrimmedNonEmptyString,
  }),
]);
export type EpicRunPreflightBlocker = typeof EpicRunPreflightBlocker.Type;

export const EpicRunPreflightWarning = Schema.Union([
  Schema.TaggedStruct("stale_claims", {
    childIds: Schema.Array(TrimmedNonEmptyString),
  }),
  Schema.TaggedStruct("nothing_ready", {
    epicId: TrimmedNonEmptyString,
  }),
]);
export type EpicRunPreflightWarning = typeof EpicRunPreflightWarning.Type;

export const EpicRunPreflightResult = Schema.Struct({
  ok: Schema.Boolean,
  blockers: Schema.Array(EpicRunPreflightBlocker),
  warnings: Schema.Array(EpicRunPreflightWarning),
});
export type EpicRunPreflightResult = typeof EpicRunPreflightResult.Type;

export class EpicRunPreflightError extends Schema.TaggedErrorClass<EpicRunPreflightError>()(
  "EpicRunPreflightError",
  {
    message: TrimmedNonEmptyString,
  },
) {}
