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

/**
 * Whether this check clears a run that is about to start or one that is picking
 * itself back up.
 *
 * This is a second axis, not a third mode. `mode` says WHERE work happens — the
 * base checkout or per-worker worktrees — and a resume can be either, so a
 * resumed run still needs the mode to know whose tree a dirty path belongs to.
 */
export const EpicRunPreflightIntent = Schema.Literals(["launch", "resume"]);
export type EpicRunPreflightIntent = typeof EpicRunPreflightIntent.Type;

export const EpicRunPreflightInput = Schema.Struct({
  workspaceRoot: TrimmedNonEmptyString,
  epicId: TrimmedNonEmptyString,
  mode: EpicRunPreflightMode,
  /** Absent means `launch`, so every existing caller decodes unchanged. */
  intent: Schema.optional(EpicRunPreflightIntent),
  /**
   * The artifacts the resumed run already owns, when this check is a resume.
   *
   * `intent` stays the discriminator — this struct only carries facts, so a
   * resume that owns nothing yet still says `intent: "resume"` and omits it.
   *
   * A parallel run owns an integration branch and worktree for its whole life,
   * and one worktree per in-flight child, so on resume they are all still
   * there. Without this, the run's own artifacts read as "a previous parallel
   * run left these behind" and the run is refused permission to continue
   * itself. Only artifacts named here are forgiven; anything else still blocks.
   *
   * `worktreePaths` are absolute per-worker worktree paths, which the caller
   * reads from `epic_run_iterations.worktree_path`. Preflight neither creates
   * nor repairs them; it reports the ones that vanished.
   */
  resume: Schema.optional(
    Schema.Struct({
      runId: TrimmedNonEmptyString,
      worktreePaths: Schema.Array(TrimmedNonEmptyString),
    }),
  ),
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
  /**
   * The operator has the run-owned base branch itself checked out.
   *
   * Landing updates that ref with `git fetch . <ref>:<branch>`, and git refuses
   * to fetch into a branch that is checked out anywhere. Without this blocker
   * the run starts, workers complete whole children, and every drain then fails
   * — the mid-run fatal that strands finished work on branches.
   */
  Schema.TaggedStruct("run_base_branch_checked_out", {
    branch: TrimmedNonEmptyString,
  }),
  /**
   * The workspace root is not there at all.
   *
   * Without this, the first git call fails on a missing cwd and the run reports
   * a one-string `git status: spawn ... ENOENT`, which reads as a git problem
   * rather than a path the operator can fix.
   */
  Schema.TaggedStruct("workspace_missing", {
    workspaceRoot: TrimmedNonEmptyString,
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
  Schema.TaggedStruct("run_base_branch_stale", {
    epicId: TrimmedNonEmptyString,
    branch: TrimmedNonEmptyString,
    commitsBehind: PositiveInt,
  }),
  /**
   * Tracked modifications that no longer block, because the run owns its base
   * branch. Reported so the operator still sees that the run excludes their
   * uncommitted work — silently dropping the signal is how a run quietly cooks
   * against code the operator thought it had.
   */
  Schema.TaggedStruct("tracked_changes_ignored", {
    paths: Schema.Array(TrimmedNonEmptyString),
  }),
  /**
   * Dirt that no longer blocks, because the run is resuming into the checkout
   * it was already working in. The paths are the run's own unfinished work, so
   * refusing them would refuse the run permission to continue itself.
   */
  Schema.TaggedStruct("dirty_tree_accepted", {
    paths: Schema.Array(TrimmedNonEmptyString),
  }),
  /**
   * Worktrees the resumed run still expects, which git no longer lists or the
   * disk no longer holds. The work they held is gone, so the run must dispatch
   * those children fresh instead of resuming them in place.
   */
  Schema.TaggedStruct("resume_worktree_missing", {
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
