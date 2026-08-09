import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { IsoDateTime, NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import {
  DEFAULT_EPIC_RUN_CONFIG,
  DEFAULT_EPIC_RUN_CONFIG_PROVENANCE,
  EpicRunConfig,
  EpicRunConfigProvenance,
} from "./epicRunConfig.ts";

/**
 * A timestamp `bd` reported, or `null` when it reported none we can use. bd
 * emits `created_at`/`updated_at` as non-pointer Go time fields, so they are
 * always present in the JSON but may hold the zero time; the server maps that,
 * and anything unparseable, to `null`. The decoding default keeps a payload
 * from a server that predates these fields decoding instead of throwing.
 */
const BeadsTimestamp = Schema.NullOr(IsoDateTime).pipe(
  Schema.withDecodingDefault(Effect.succeed(null)),
);

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
  createdAt: BeadsTimestamp,
  updatedAt: BeadsTimestamp,
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
  createdAt: BeadsTimestamp,
  updatedAt: BeadsTimestamp,
  /**
   * The newest of this epic's own `updatedAt` and its direct children's, so a
   * client can order by recency without walking the issue list. An epic's own
   * `updatedAt` moves only when the epic ISSUE changes — closing a child moves
   * the CHILD's — so the epic's own value alone reads as stale while the epic is
   * actively progressing.
   */
  lastActivityAt: BeadsTimestamp,
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
  /**
   * The run being resumed, when this check is a resume rather than a launch.
   *
   * A parallel run owns an integration branch and worktree for its whole life,
   * so on resume they are still there. Without this, the run's own leftovers
   * read as "a previous parallel run left these behind" and the run is refused
   * permission to continue itself. Only leftovers carrying this exact run id
   * are forgiven; anything else still blocks.
   */
  resumingRunId: Schema.optional(TrimmedNonEmptyString),
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
  Schema.TaggedStruct("config_invalid", {
    configPath: TrimmedNonEmptyString,
    diagnostics: Schema.Array(TrimmedNonEmptyString),
  }),
  Schema.TaggedStruct("integration_leftover", {
    branch: Schema.NullOr(TrimmedNonEmptyString),
    worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  }),
  Schema.TaggedStruct("sibling_invalid", {
    path: TrimmedNonEmptyString,
    detail: TrimmedNonEmptyString,
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
  Schema.TaggedStruct("config_unknown_keys", {
    configPath: TrimmedNonEmptyString,
    keys: Schema.Array(TrimmedNonEmptyString),
  }),
  Schema.TaggedStruct("config_violation", {
    key: TrimmedNonEmptyString,
    message: TrimmedNonEmptyString,
  }),
  Schema.TaggedStruct("untracked_files", {
    paths: Schema.Array(TrimmedNonEmptyString),
  }),
]);
export type EpicRunPreflightWarning = typeof EpicRunPreflightWarning.Type;

export const EpicRunPreflightResult = Schema.Struct({
  ok: Schema.Boolean,
  blockers: Schema.Array(EpicRunPreflightBlocker),
  warnings: Schema.Array(EpicRunPreflightWarning),
  /**
   * The config the run would launch with, resolved the same way launch
   * resolves it, plus per-key provenance. Decoding defaults keep a payload
   * from a server that predates these fields decoding instead of throwing.
   */
  resolvedConfig: EpicRunConfig.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_EPIC_RUN_CONFIG)),
  ),
  configProvenance: EpicRunConfigProvenance.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_EPIC_RUN_CONFIG_PROVENANCE)),
  ),
});
export type EpicRunPreflightResult = typeof EpicRunPreflightResult.Type;

export class EpicRunPreflightError extends Schema.TaggedErrorClass<EpicRunPreflightError>()(
  "EpicRunPreflightError",
  {
    message: TrimmedNonEmptyString,
  },
) {}
