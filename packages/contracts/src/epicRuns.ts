import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  EpicRunId,
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ModelSelection, RuntimeMode } from "./orchestration.ts";
import {
  DEFAULT_EPIC_RUN_CONFIG_PROVENANCE,
  EpicRunConfig,
  EpicRunConfigOverride,
  EpicRunConfigProvenance,
} from "./epicRunConfig.ts";

export const EpicRunStatus = Schema.Literals(["running", "paused", "done", "failed", "cancelled"]);
export type EpicRunStatus = typeof EpicRunStatus.Type;

export const EpicRunInput = Schema.Struct({
  epicId: TrimmedNonEmptyString,
  projectId: ProjectId,
  cwd: TrimmedNonEmptyString,
  prompt: Schema.String,
  orientationFile: Schema.optional(Schema.NullOr(Schema.String)),
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode.pipe(Schema.withDecodingDefault(Effect.succeed("full-access"))),
  config: Schema.optional(EpicRunConfigOverride),
  /** Legacy alias. An explicitly configured `limits.maxIterations` value wins. */
  maxIterations: Schema.optional(PositiveInt),
  originThreadId: Schema.optional(ThreadId),
});
export type EpicRunInput = typeof EpicRunInput.Type;
export type StartEpicRunInput = Omit<EpicRunInput, "runtimeMode"> & {
  readonly runtimeMode?: EpicRunInput["runtimeMode"] | undefined;
};

export const LaunchEpicRunInput = Schema.Struct({
  epicId: TrimmedNonEmptyString,
  projectId: ProjectId,
  cwd: TrimmedNonEmptyString,
  config: Schema.optional(EpicRunConfigOverride),
  originThreadId: Schema.optional(ThreadId),
  /**
   * Run every iteration on the launching thread's own provider instance,
   * model and options, instead of the persisted project default.
   *
   * Absent means off, so an Epics-page launch and any older client keep
   * today's behaviour. When it is on, `originThreadId` must name a live
   * thread in `projectId`; anything else fails the launch with a typed
   * `EpicRunLaunchError` rather than quietly running on another provider.
   */
  inheritOriginModelSelection: Schema.optional(Schema.Boolean),
});
export type LaunchEpicRunInput = typeof LaunchEpicRunInput.Type;

/**
 * The resume family of `EpicRunIterationReport.failureReason`, in the `infra:`
 * failure class because a failed resume is infrastructure, never agent
 * behaviour. Runner, epic-core and the clients all import these rather than
 * retyping the strings.
 */

/** The provider adapter declares no resume capability at all. */
export const EPIC_RUN_FAILURE_RESUME_UNSUPPORTED = "infra:resume-unsupported";
/** The adapter can resume in principle, but this attempt was refused. */
export const EPIC_RUN_FAILURE_RESUME_BLOCKED = "infra:resume-blocked";
/** The resume was accepted and then errored. */
export const EPIC_RUN_FAILURE_RESUME_FAILED = "infra:resume-failed";

export const EpicRunIterationReport = Schema.Struct({
  iterationIndex: NonNegativeInt,
  threadId: ThreadId,
  issueId: Schema.NullOr(TrimmedNonEmptyString),
  workerId: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  branch: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  worktreePath: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  turnStatus: Schema.Literals(["running", "completed", "failed", "abandoned"]),
  summary: Schema.NullOr(Schema.String),
  why: Schema.NullOr(Schema.String),
  /**
   * Why a `failed` or `abandoned` iteration was scored that way; `null` on
   * every other status, and on rows written before the column existed. A
   * closed vocabulary, so policy and UI can switch on it without parsing the
   * human `summary`. Classified failures are prefixed with their failure
   * class: "infra:" for failures attributable to infrastructure ("turn-error",
   * "timeout", "dispatch-failed", "protocol-error", "ready-unrecognised", and
   * the provider-error family) and "child:" for failures the agent itself
   * produced ("no-commit-child-open", "no-commit-no-evidence",
   * "closed-without-findings", and "blocked"). Provider-attributed failures
   * read "infra:provider-error" when only the session's error text is known,
   * or "infra:provider-error:spend-limit" / ":auth" / ":rate-limit" when the
   * text matched the runner's curated pattern table. The resume family —
   * "infra:resume-unsupported", "infra:resume-blocked" and
   * "infra:resume-failed" — says an interrupted iteration could not be
   * continued after a server restart. "cancelled" and "server-restart" never
   * had a classified outcome and stay unprefixed; "server-restart" means only
   * that the row was reconciled at boot, never a resume outcome. Rows written
   * before the class prefix existed carry the bare reasons.
   */
  failureReason: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  /**
   * How many times this iteration's own provider session was continued after
   * an interruption; `0` on a row that never resumed, and on rows written
   * before the column existed.
   *
   * A resume deliberately reuses the interrupted row rather than appending a
   * new one, so `iterationIndex`, `threadId`, `startedAt`, `issueId`, `branch`
   * and `worktreePath` all keep the values the first dispatch wrote. A
   * non-zero count is the only signal that the row covers more than one
   * process lifetime.
   */
  resumeCount: NonNegativeInt.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  /** When the most recent resume was stamped; `null` while `resumeCount` is 0. */
  lastResumedAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  startedAt: IsoDateTime,
  finishedAt: Schema.NullOr(IsoDateTime),
});
export type EpicRunIterationReport = typeof EpicRunIterationReport.Type;

/** The public run read model, including iteration-derived thread references. */
export const EpicRunThreadRef = Schema.Struct({
  issueId: TrimmedNonEmptyString,
  threadId: ThreadId,
  iterationIndex: NonNegativeInt,
});
export type EpicRunThreadRef = typeof EpicRunThreadRef.Type;

export const EpicRun = Schema.Struct({
  runId: EpicRunId,
  epicId: TrimmedNonEmptyString,
  projectId: ProjectId,
  cwd: TrimmedNonEmptyString,
  prompt: Schema.String,
  orientationFile: Schema.NullOr(Schema.String),
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  config: EpicRunConfig.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  configProvenance: EpicRunConfigProvenance.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_EPIC_RUN_CONFIG_PROVENANCE)),
  ),
  /**
   * The thread whose agent launched this run, when a skill launched it from
   * inside one; `null` for a launch from the Epics page. Never inferred from
   * the run's own iteration threads — those are children, not the launcher.
   */
  originThreadId: Schema.NullOr(ThreadId),
  status: EpicRunStatus,
  /** The maximum number of provider dispatch attempts this run can start. */
  maxIterations: PositiveInt,
  /** The durable maximum number of iterations that may run concurrently. */
  workers: PositiveInt.pipe(Schema.withDecodingDefault(Effect.succeed(1))),
  /**
   * Provider attempts charged before orchestration dispatch. This includes
   * dispatch failures and turns later marked abandoned or cancelled.
   */
  iterationsDispatched: NonNegativeInt,
  /**
   * Iterations that reached a normal runner boundary. This can differ from
   * `iterationsDispatched` when a started turn is abandoned or cancelled.
   */
  iterationsCompleted: NonNegativeInt,
  /** The most recently dispatched iteration thread, not the in-flight marker. */
  currentThreadId: Schema.NullOr(ThreadId),
  currentTurnStartedAt: Schema.NullOr(IsoDateTime),
  consecutiveFailures: NonNegativeInt,
  noCommitStreak: NonNegativeInt,
  infraStreak: NonNegativeInt,
  lastError: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  threadRefs: Schema.Array(EpicRunThreadRef).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  recentIterations: Schema.Array(EpicRunIterationReport).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
});
export type EpicRun = typeof EpicRun.Type;

/**
 * Iteration thread ids are structural, not opaque: the sidebar folds a run's
 * iterations into one row by parsing them, with no extra server round trip.
 * Build and parse both live here so the two sides cannot drift — a change to
 * the shape breaks the round-trip test instead of silently ungrouping the
 * sidebar.
 */
const EPIC_RUN_THREAD_ID_PREFIX = "epic-run-";
const EPIC_RUN_THREAD_ID_PATTERN = new RegExp(`^${EPIC_RUN_THREAD_ID_PREFIX}(.+)-(\\d+)$`);

export const epicRunIterationThreadId = (input: {
  readonly runId: string;
  readonly iterationIndex: number;
}): string => `${EPIC_RUN_THREAD_ID_PREFIX}${input.runId}-${input.iterationIndex}`;

export type EpicRunIterationThreadRef = {
  readonly runId: string;
  readonly iterationIndex: number;
};

/** `null` for any thread id the runner did not build — plain threads included. */
export const parseEpicRunIterationThreadId = (
  threadId: string,
): EpicRunIterationThreadRef | null => {
  const match = EPIC_RUN_THREAD_ID_PATTERN.exec(threadId);
  if (match === null) return null;
  const [, runId, iterationIndex] = match;
  if (runId === undefined || runId.length === 0 || iterationIndex === undefined) return null;
  return { runId, iterationIndex: Number.parseInt(iterationIndex, 10) };
};

export const EpicRunRef = Schema.Struct({
  runId: EpicRunId,
});
export type EpicRunRef = typeof EpicRunRef.Type;

export const SetEpicRunWorkersInput = Schema.Struct({
  runId: EpicRunId,
  workers: PositiveInt,
});
export type SetEpicRunWorkersInput = typeof SetEpicRunWorkersInput.Type;

/**
 * How a run listing is ordered.
 *
 * `createdAt-asc` is the default because the runner's restart read depends on
 * it: it lists `running` rows and resumes them in the order they were created.
 * `updatedAt-desc` is what a recency-first UI wants, and is the only order a
 * `limit` is meaningful with.
 */
export const EpicRunListOrder = Schema.Literals(["createdAt-asc", "updatedAt-desc"]);
export type EpicRunListOrder = typeof EpicRunListOrder.Type;

export const ListEpicRunsInput = Schema.Struct({
  status: Schema.optional(EpicRunStatus),
  /** Omitted means every matching run, which is what every caller did before. */
  limit: Schema.optional(PositiveInt),
  orderBy: Schema.optional(EpicRunListOrder),
});
export type ListEpicRunsInput = typeof ListEpicRunsInput.Type;

/**
 * `ListEpicRunsInput` for a no-body HTTP endpoint, where every field arrives as
 * a query string. Same decoded shape — only `limit` needs the string codec.
 */
export const ListEpicRunsQuery = Schema.Struct({
  status: Schema.optional(EpicRunStatus),
  limit: Schema.optional(
    Schema.FiniteFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
  ),
  orderBy: Schema.optional(EpicRunListOrder),
});
export type ListEpicRunsQuery = typeof ListEpicRunsQuery.Type;

export const EpicRunEvent = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("run-state-changed"),
  run: EpicRun,
});
export type EpicRunEvent = typeof EpicRunEvent.Type;

export class EpicRunnerStoreError extends Schema.TaggedErrorClass<EpicRunnerStoreError>()(
  "EpicRunnerStoreError",
  { operation: Schema.String },
) {}

export class EpicRunnerDispatchError extends Schema.TaggedErrorClass<EpicRunnerDispatchError>()(
  "EpicRunnerDispatchError",
  {
    commandType: Schema.String,
    detail: Schema.String,
  },
) {}

export class EpicRunNotFoundError extends Schema.TaggedErrorClass<EpicRunNotFoundError>()(
  "EpicRunNotFoundError",
  { runId: EpicRunId },
) {}

export class EpicRunStateError extends Schema.TaggedErrorClass<EpicRunStateError>()(
  "EpicRunStateError",
  {
    runId: EpicRunId,
    detail: Schema.String,
  },
) {}

export class EpicRunPreflightBlockedError extends Schema.TaggedErrorClass<EpicRunPreflightBlockedError>()(
  "EpicRunPreflightBlockedError",
  {
    epicId: Schema.String,
    blockers: Schema.Array(Schema.String),
  },
) {}

export class EpicRunLaunchError extends Schema.TaggedErrorClass<EpicRunLaunchError>()(
  "EpicRunLaunchError",
  {
    // Kept in step with `EpicRunLaunchError` in @t3tools/epic-core/Errors.
    reason: Schema.Literals([
      "project_not_found",
      "cwd_mismatch",
      "model_default_missing",
      "orientation_file_invalid",
      "origin_thread_required",
      "origin_thread_not_found",
      "origin_thread_project_mismatch",
    ]),
  },
) {}

export const EpicRunTransportError = Schema.Union([
  EpicRunnerStoreError,
  EpicRunnerDispatchError,
  EpicRunNotFoundError,
  EpicRunStateError,
  EpicRunPreflightBlockedError,
  EpicRunLaunchError,
]);
export type EpicRunTransportError = typeof EpicRunTransportError.Type;
