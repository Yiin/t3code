/**
 * EpicRunStore - Durable state for epic runs and their iterations.
 *
 * An epic run survives a process restart or crash: everything the runner needs
 * to resume lives in SQLite, not in memory. This module owns the persistence
 * contract only; the loop that drives a run (sibling issue .11) is not here.
 *
 * ## Crash-safe write ordering
 *
 * The store is designed for a write-ahead discipline that the runner must
 * honour: `allocateIteration` atomically inserts a complete `running` row
 * BEFORE orchestration begins, and the terminal state is persisted after the
 * turn resolves. A crash in between therefore leaves visible in-flight work.
 *
 * `reopenIteration` is the reopen half of that discipline. The row already
 * exists, so flipping it back to `running` BEFORE the resume dispatch keeps
 * the same write-ahead guarantee an append gives a fresh iteration: a crash
 * during the resume still leaves visible in-flight work.
 *
 * ## Why the iteration readers exist
 *
 * On restart the runner lists every `running` iteration and marks each one
 * `abandoned` via `updateIteration`. The loop logic itself is not this
 * module's concern.
 *
 * @module EpicRunStore
 */
import {
  EpicRun as EpicRunSchema,
  EpicRunId,
  EpicRunStatus as EpicRunStatusSchema,
  type EpicRunStatus as EpicRunStatusType,
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProviderInstanceId,
  ThreadId,
  EpicRunRef,
  type EpicRunRef as EpicRunRefType,
  ListEpicRunsInput as ListEpicRunsInputSchema,
  type ListEpicRunsInput as ListEpicRunsInputType,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { EpicRunStoreError } from "../Errors.ts";

const {
  threadRefs: _threadRefs,
  recentIterations: _recentIterations,
  ...storedEpicRunFields
} = EpicRunSchema.fields;
export const StoredEpicRun = Schema.Struct(storedEpicRunFields);
export type StoredEpicRun = typeof StoredEpicRun.Type;
export const EpicRun = StoredEpicRun;
export type EpicRun = StoredEpicRun;
export const EpicRunStatus = EpicRunStatusSchema;
export type EpicRunStatus = EpicRunStatusType;

export const EpicRunIterationStatus = Schema.Literals([
  "running",
  "completed",
  "failed",
  "abandoned",
]);
export type EpicRunIterationStatus = typeof EpicRunIterationStatus.Type;

/** Milliseconds per iteration phase; see `EpicRunIterationPhaseTimings` in epic-core. */
export const EpicRunIterationPhaseTimings = Schema.Struct({
  prepareMs: NonNegativeInt,
  providerMs: NonNegativeInt,
  settlementMs: NonNegativeInt,
  mergeWaitMs: NonNegativeInt,
  gateMs: NonNegativeInt,
});
export type EpicRunIterationPhaseTimings = typeof EpicRunIterationPhaseTimings.Type;

export const EpicRunIteration = Schema.Struct({
  runId: EpicRunId,
  iterationIndex: NonNegativeInt,
  threadId: ThreadId,
  issueId: Schema.NullOr(Schema.String),
  /** The orchestration thread is the server worker identity for this iteration. */
  workerId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  branch: Schema.optionalKey(Schema.NullOr(Schema.String)),
  worktreePath: Schema.optionalKey(Schema.NullOr(Schema.String)),
  turnStatus: EpicRunIterationStatus,
  summary: Schema.NullOr(Schema.String),
  why: Schema.NullOr(Schema.String),
  /**
   * Machine-readable reason for a `failed`/`abandoned` status, `null`
   * otherwise. Vocabulary lives on the transport schema
   * (`EpicRunIterationReport.failureReason`).
   *
   * Mirrored here because this column is what the runner writes: classified
   * failures carry their failure class ("infra:" or "child:"), the resume
   * family is `EPIC_RUN_FAILURE_RESUME_UNSUPPORTED` / `_BLOCKED` / `_FAILED`
   * from `@t3tools/contracts`, and "cancelled" and "server-restart" stay
   * unprefixed. "server-restart" means only that the row was reconciled at
   * boot; it is never a resume outcome.
   */
  failureReason: Schema.NullOr(Schema.String),
  /**
   * How many times this row was reopened by `reopenIteration`. Absent on rows
   * read through a pre-056 shape; treat absent as `0`. Vocabulary lives on the
   * transport schema (`EpicRunIterationReport.resumeCount`).
   */
  resumeCount: Schema.optionalKey(NonNegativeInt),
  lastResumedAt: Schema.optionalKey(Schema.NullOr(IsoDateTime)),
  /**
   * Which tier's chain produced this dispatch, and what that chain resolved
   * to. Written once with the row and never rewritten: a resume continues the
   * same session on the same account, so the first dispatch's attribution
   * stays true.
   *
   * `tierId` is `null` when no tier answered — no role policy, or a role with
   * no tier — and the other two are `null` only on a row that dispatched
   * nothing. All three are absent on a row read through a pre-057 shape. Tier
   * vocabulary lives in `EpicTierId` in `@t3tools/contracts`; the column is a
   * plain string so an old row still decodes after a rename.
   */
  tierId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  providerInstanceId: Schema.optionalKey(Schema.NullOr(ProviderInstanceId)),
  model: Schema.optionalKey(Schema.NullOr(Schema.String)),
  /**
   * Where this iteration's wall time went, stored as one JSON column.
   *
   * `null` while the row is running, and absent on a row read through a
   * pre-058 shape. Both read the same way: not measured. The vocabulary is
   * `EpicRunIterationPhaseTimings` in `@t3tools/epic-core`; it is mirrored
   * here because this column is what the runner writes.
   */
  phaseTimings: Schema.optionalKey(
    Schema.NullOr(Schema.fromJsonString(EpicRunIterationPhaseTimings)),
  ),
  /** Prompt size of the dispatch this row carried. `null` when unmeasured. */
  promptBytes: Schema.optionalKey(Schema.NullOr(NonNegativeInt)),
  startedAt: IsoDateTime,
  finishedAt: Schema.NullOr(IsoDateTime),
});
export type EpicRunIteration = typeof EpicRunIteration.Type;

export const AllocateEpicRunIterationInput = Schema.Struct({
  runId: EpicRunId,
  issueId: Schema.NullOr(Schema.String),
  branch: Schema.NullOr(Schema.String),
  worktreePath: Schema.NullOr(Schema.String),
  /** Attribution for the dispatch this row is about to carry; see {@link EpicRunIteration}. */
  tierId: Schema.NullOr(Schema.String),
  providerInstanceId: Schema.NullOr(ProviderInstanceId),
  model: Schema.NullOr(Schema.String),
  startedAt: IsoDateTime,
});
export type AllocateEpicRunIterationInput = typeof AllocateEpicRunIterationInput.Type;

export const GetEpicRunInput = EpicRunRef;
export type GetEpicRunInput = EpicRunRefType;

export const ListEpicRunsInput = ListEpicRunsInputSchema;
export type ListEpicRunsInput = ListEpicRunsInputType;

export const ListEpicRunIterationsInput = Schema.Struct({
  runId: EpicRunId,
});
export type ListEpicRunIterationsInput = typeof ListEpicRunIterationsInput.Type;

export const ListRecentEpicRunIterationsInput = Schema.Struct({
  runIds: Schema.Array(EpicRunId),
  limitPerRun: PositiveInt,
});
export type ListRecentEpicRunIterationsInput = typeof ListRecentEpicRunIterationsInput.Type;

export const GetLatestEpicRunIterationInput = Schema.Struct({
  runId: EpicRunId,
});
export type GetLatestEpicRunIterationInput = typeof GetLatestEpicRunIterationInput.Type;

export const UpdateEpicRunIterationInput = Schema.Struct({
  runId: EpicRunId,
  iterationIndex: NonNegativeInt,
  turnStatus: EpicRunIterationStatus,
  summary: Schema.NullOr(Schema.String),
  why: Schema.NullOr(Schema.String),
  failureReason: Schema.NullOr(Schema.String),
  /**
   * `null` leaves the stored value alone. A settle writes them; the abandon
   * and cancel paths have nothing to measure and pass `null` rather than
   * erasing what an earlier lifetime measured.
   */
  phaseTimings: Schema.NullOr(Schema.fromJsonString(EpicRunIterationPhaseTimings)),
  promptBytes: Schema.NullOr(NonNegativeInt),
  finishedAt: Schema.NullOr(IsoDateTime),
});
export type UpdateEpicRunIterationInput = typeof UpdateEpicRunIterationInput.Type;

export const ReopenEpicRunIterationInput = Schema.Struct({
  runId: EpicRunId,
  iterationIndex: NonNegativeInt,
  resumedAt: IsoDateTime,
});
export type ReopenEpicRunIterationInput = typeof ReopenEpicRunIterationInput.Type;

export const EpicRunGateReceiptPhase = Schema.Literals([
  "entry",
  "control",
  "recheck",
  "sequential",
]);
export type EpicRunGateReceiptPhase = typeof EpicRunGateReceiptPhase.Type;

export const EpicRunGateInputHead = Schema.Struct({
  repositoryPath: Schema.String,
  head: Schema.NullOr(Schema.String),
});

/**
 * One gate run, exactly as the adapter measured it.
 *
 * Append-only: nothing updates a receipt, so a restart reads back what every
 * earlier lifetime of the run wrote. `outcome: "passed"` requires
 * `exitCode === 0`, and the table enforces that too.
 */
export const EpicRunGateReceipt = Schema.Struct({
  runId: EpicRunId,
  /** Allocated by the store, ascending per run. Ignored on write. */
  sequence: NonNegativeInt,
  phase: EpicRunGateReceiptPhase,
  childId: Schema.NullOr(Schema.String),
  branch: Schema.NullOr(Schema.String),
  commandDigest: Schema.String,
  cwd: Schema.String,
  outcome: Schema.Literals(["passed", "failed", "error"]),
  /** `null` when the command never produced one — a spawn failure or a timeout. */
  exitCode: Schema.NullOr(Schema.Number),
  queuedAt: Schema.String,
  acquiredAt: Schema.NullOr(Schema.String),
  finishedAt: Schema.String,
  lockWaitMs: NonNegativeInt,
  executionMs: NonNegativeInt,
  /** The commits the command read, stored as one JSON column. */
  inputHeads: Schema.fromJsonString(Schema.Array(EpicRunGateInputHead)),
  /** Bounded by the caller. The unbounded log, if kept, is at `outputPath`. */
  output: Schema.String,
  outputPath: Schema.NullOr(Schema.String),
});
export type EpicRunGateReceipt = typeof EpicRunGateReceipt.Type;

export const RecordEpicRunGateReceiptInput = Schema.Struct(
  (({ sequence: _sequence, ...rest }) => rest)(EpicRunGateReceipt.fields),
);
export type RecordEpicRunGateReceiptInput = typeof RecordEpicRunGateReceiptInput.Type;

export const ListEpicRunGateReceiptsInput = Schema.Struct({ runId: EpicRunId });
export type ListEpicRunGateReceiptsInput = typeof ListEpicRunGateReceiptsInput.Type;

export const EpicProviderDegradation = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  failureReason: Schema.String,
  degradedAt: IsoDateTime,
  /** The provider's own reset time; NULL leaves liveness to the flat TTL. */
  resetsAt: Schema.NullOr(IsoDateTime),
});
export type EpicProviderDegradation = typeof EpicProviderDegradation.Type;

export const GetEpicProviderDegradationInput = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
});
export type GetEpicProviderDegradationInput = typeof GetEpicProviderDegradationInput.Type;

export const ClearExpiredEpicProviderDegradationInput = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  cutoff: IsoDateTime,
  /** For a row with a reset time; a row without one expires by `cutoff`. */
  now: IsoDateTime,
});
export type ClearExpiredEpicProviderDegradationInput =
  typeof ClearExpiredEpicProviderDegradationInput.Type;

export const EpicRunMergeEntryStatus = Schema.Literals(["queued", "draining", "parked"]);
export type EpicRunMergeEntryStatus = typeof EpicRunMergeEntryStatus.Type;

export const EpicRunMergeEntry = Schema.Struct({
  runId: EpicRunId,
  sequence: NonNegativeInt,
  childId: Schema.String,
  branch: Schema.String,
  status: EpicRunMergeEntryStatus,
  reason: Schema.NullOr(Schema.Literals(["conflict", "gate-failed"])),
  fixIssueId: Schema.NullOr(Schema.String),
});
export type EpicRunMergeEntry = typeof EpicRunMergeEntry.Type;

export const EpicRunMergeStateSibling = Schema.Struct({
  repositoryPath: Schema.String,
  baseBranch: Schema.String,
  integrationWorktreePath: Schema.String,
  lastAcceptedHead: Schema.String,
  /**
   * The sibling's HEAD when the run's merge state was initialized; the base
   * for per-repository landing effects. Absent in rows written after
   * migration 049 but before 2026-08-08 — readers fall back to
   * `lastAcceptedHead`.
   */
  initialHead: Schema.optionalKey(Schema.String),
});
export type EpicRunMergeStateSibling = typeof EpicRunMergeStateSibling.Type;

export const EpicRunMergeState = Schema.Struct({
  runId: EpicRunId,
  initialHead: Schema.String,
  lastAcceptedHead: Schema.String,
  parkedCount: NonNegativeInt,
  repositoryPath: Schema.String,
  baseBranch: Schema.String,
  integrationBranch: Schema.String,
  integrationWorktreePath: Schema.String,
  /**
   * The operator's branch at launch (t3code-sha), for a run that owns its
   * base branch; `null` otherwise, including every row written before
   * migration 052 — `ALTER TABLE ... ADD COLUMN` backfills those with SQL
   * `NULL`, so the column is always present and a plain `NullOr` decodes it.
   */
  operatorBaseBranch: Schema.NullOr(Schema.String),
  /** Empty for single-repo runs; old rows decode to `[]` (column default). */
  siblings: Schema.Array(EpicRunMergeStateSibling),
  entries: Schema.Array(EpicRunMergeEntry),
});
export type EpicRunMergeState = typeof EpicRunMergeState.Type;

/**
 * One row per (runId, repositoryPath): the commits the run landed in that
 * repository. `parkedCount` is run-level and repeated on every row.
 */
export const EpicRunLandingEffects = Schema.Struct({
  runId: EpicRunId,
  repositoryPath: Schema.String,
  baseHead: Schema.String,
  head: Schema.String,
  commitCount: NonNegativeInt,
  parkedCount: NonNegativeInt,
});
export type EpicRunLandingEffects = typeof EpicRunLandingEffects.Type;

export const InitializeEpicRunMergeStateInput = Schema.Struct({
  runId: EpicRunId,
  lastAcceptedHead: Schema.String,
  repositoryPath: Schema.String,
  baseBranch: Schema.String,
  integrationBranch: Schema.String,
  integrationWorktreePath: Schema.String,
  /** Absent from callers written before t3code-sha; the row stores `null`. */
  operatorBaseBranch: Schema.optional(Schema.NullOr(Schema.String)),
  siblings: Schema.Array(EpicRunMergeStateSibling),
});
export type InitializeEpicRunMergeStateInput = typeof InitializeEpicRunMergeStateInput.Type;

export const AdvanceEpicRunMergeIntegrationInput = Schema.Struct({
  runId: EpicRunId,
  lastAcceptedHead: Schema.String,
  /**
   * New accepted heads for every sibling; absent for single-repo runs. An
   * in-place auto-mode iteration can commit in the real sibling checkouts,
   * so a resync that only advanced the main head would leave the next drain
   * reading this run's own sibling commits as an external move.
   */
  siblingHeads: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        repositoryPath: Schema.String,
        lastAcceptedHead: Schema.String,
      }),
    ),
  ),
});
export type AdvanceEpicRunMergeIntegrationInput = typeof AdvanceEpicRunMergeIntegrationInput.Type;

export const EnqueueEpicRunMergeInput = Schema.Struct({
  runId: EpicRunId,
  childId: Schema.String,
  branch: Schema.String,
});
export type EnqueueEpicRunMergeInput = typeof EnqueueEpicRunMergeInput.Type;

export const RestoreEpicRunMergeTailInput = Schema.Struct({
  runId: EpicRunId,
  fromSequence: NonNegativeInt,
});
export type RestoreEpicRunMergeTailInput = typeof RestoreEpicRunMergeTailInput.Type;

export const ParkEpicRunMergeInput = Schema.Struct({
  runId: EpicRunId,
  sequence: NonNegativeInt,
  reason: Schema.Literals(["conflict", "gate-failed"]),
});
export type ParkEpicRunMergeInput = typeof ParkEpicRunMergeInput.Type;

export const FinalizeParkedEpicRunMergeInput = Schema.Struct({
  runId: EpicRunId,
  sequence: NonNegativeInt,
  fixIssueId: Schema.String,
});
export type FinalizeParkedEpicRunMergeInput = typeof FinalizeParkedEpicRunMergeInput.Type;

export const CompleteEpicRunMergeInput = Schema.Struct({
  runId: EpicRunId,
  sequence: NonNegativeInt,
  lastAcceptedHead: Schema.String,
  /** New accepted heads for every sibling; absent for single-repo runs. */
  siblingHeads: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        repositoryPath: Schema.String,
        lastAcceptedHead: Schema.String,
      }),
    ),
  ),
});
export type CompleteEpicRunMergeInput = typeof CompleteEpicRunMergeInput.Type;

export const DropEpicRunMergeInput = Schema.Struct({
  runId: EpicRunId,
  sequence: NonNegativeInt,
});
export type DropEpicRunMergeInput = typeof DropEpicRunMergeInput.Type;

export const FindParkedEpicRunMergeInput = Schema.Struct({
  runId: EpicRunId,
  branch: Schema.String,
});
export type FindParkedEpicRunMergeInput = typeof FindParkedEpicRunMergeInput.Type;

export const UpsertEpicRunLandingEffectsInput = EpicRunLandingEffects;
export type UpsertEpicRunLandingEffectsInput = typeof UpsertEpicRunLandingEffectsInput.Type;

/**
 * EpicRunStoreShape - Service API for durable epic run state.
 */
export interface EpicRunStoreShape {
  /**
   * Insert or replace an epic run row, keyed by `runId`.
   */
  readonly upsertRun: (run: EpicRun) => Effect.Effect<void, EpicRunStoreError>;

  /**
   * Read a single epic run by id.
   */
  readonly getRun: (
    input: GetEpicRunInput,
  ) => Effect.Effect<Option.Option<EpicRun>, EpicRunStoreError>;

  /**
   * List epic runs, optionally narrowed to one status, ordered, and bounded.
   *
   * Defaults to ascending creation order because the runner's restart read
   * depends on it: it lists the `running` rows and resumes them in the order
   * they were created. `orderBy: "updatedAt-desc"` is the recency order a UI
   * wants; both orders tie-break on `run_id` so a `limit` cuts the same rows
   * every time.
   */
  readonly listRuns: (
    input: ListEpicRunsInput,
  ) => Effect.Effect<ReadonlyArray<EpicRun>, EpicRunStoreError>;

  /** Legacy explicit-index insert. New dispatches use `allocateIteration`. */
  readonly appendIteration: (iteration: EpicRunIteration) => Effect.Effect<void, EpicRunStoreError>;

  /**
   * Atomically allocate the next unique index and insert its complete running
   * row. The generated thread id also serves as the worker identity.
   */
  readonly allocateIteration: (
    input: AllocateEpicRunIterationInput,
  ) => Effect.Effect<number, EpicRunStoreError>;

  /**
   * Total update of an iteration's mutable columns.
   *
   * `threadId` and `startedAt` are immutable once appended, so they are not
   * accepted here.
   *
   * A key that matches no row is a silent no-op, not an error. The rehydration
   * story above depends on the abandon-flip actually landing, so the runner
   * (.11) must only call this for an index it appended — an off-by-one would
   * leave an iteration `running` forever with nothing reported.
   */
  readonly updateIteration: (
    input: UpdateEpicRunIterationInput,
  ) => Effect.Effect<void, EpicRunStoreError>;

  /**
   * Reopen an existing iteration so its own provider session can continue.
   *
   * One UPDATE keyed on `(runId, iterationIndex)`: the row goes back to
   * `running`, its terminal fields (`summary`, `why`, `failureReason`,
   * `finishedAt`) clear, `resumeCount` bumps by one and `lastResumedAt` gets
   * the stamp. Clearing the terminal fields keeps the row honest, because
   * `failureReason` is documented as `null` on any non-failed status.
   *
   * `startedAt` is deliberately untouched: the iteration really did start
   * then, and the whole point of the reuse is that `threadId`, `issueId`,
   * `branch` and `worktreePath` still describe the same work. A key that
   * matches no row is a silent no-op, exactly like `updateIteration`.
   */
  readonly reopenIteration: (
    input: ReopenEpicRunIterationInput,
  ) => Effect.Effect<void, EpicRunStoreError>;

  /**
   * List a run's iterations in ascending index order.
   */
  readonly listIterations: (
    input: ListEpicRunIterationsInput,
  ) => Effect.Effect<ReadonlyArray<EpicRunIteration>, EpicRunStoreError>;

  /** List the authoritative in-flight set in ascending index order. */
  readonly listRunningIterations: (
    input: ListEpicRunIterationsInput,
  ) => Effect.Effect<ReadonlyArray<EpicRunIteration>, EpicRunStoreError>;

  /**
   * The newest `limitPerRun` iterations of every requested run, in one query.
   *
   * This exists so listing N runs costs one iteration query instead of N. Rows
   * come back ordered by `(runId, iterationIndex)` ascending, so a caller can
   * group them by walking the array once; a run with no iterations is simply
   * absent. An empty `runIds` short-circuits without touching SQL.
   */
  readonly listRecentIterationsForRuns: (
    input: ListRecentEpicRunIterationsInput,
  ) => Effect.Effect<ReadonlyArray<EpicRunIteration>, EpicRunStoreError>;

  /**
   * Read a run's highest-indexed iteration, if any.
   *
   * Kept for read-side callers. Dispatch allocation is atomic and does not use
   * this read.
   */
  readonly getLatestIteration: (
    input: GetLatestEpicRunIterationInput,
  ) => Effect.Effect<Option.Option<EpicRunIteration>, EpicRunStoreError>;

  /**
   * Append one gate receipt, allocating its sequence atomically.
   *
   * Callers write this BEFORE they act on the gate's verdict, so a crash
   * between the gate and the land or park still leaves the evidence.
   */
  readonly recordGateReceipt: (
    input: RecordEpicRunGateReceiptInput,
  ) => Effect.Effect<void, EpicRunStoreError>;

  /** Every receipt for one run, in the order it was recorded. */
  readonly listGateReceipts: (
    input: ListEpicRunGateReceiptsInput,
  ) => Effect.Effect<ReadonlyArray<EpicRunGateReceipt>, EpicRunStoreError>;

  /** Insert or replace the degradation for one provider instance. */
  readonly upsertProviderDegradation: (
    degradation: EpicProviderDegradation,
  ) => Effect.Effect<void, EpicRunStoreError>;

  /** Read the current degradation for one provider instance. */
  readonly getProviderDegradation: (
    input: GetEpicProviderDegradationInput,
  ) => Effect.Effect<Option.Option<EpicProviderDegradation>, EpicRunStoreError>;

  /** Clear one instance after a successful dispatched provider turn. */
  readonly clearProviderDegradation: (
    input: GetEpicProviderDegradationInput,
  ) => Effect.Effect<void, EpicRunStoreError>;

  /** Clear one instance when its degradation timestamp is at or before the cutoff. */
  readonly clearExpiredProviderDegradation: (
    input: ClearExpiredEpicProviderDegradationInput,
  ) => Effect.Effect<void, EpicRunStoreError>;

  /** Create the durable queue coordinates once. Existing state is never silently replaced. */
  readonly initializeMergeState: (
    input: InitializeEpicRunMergeStateInput,
  ) => Effect.Effect<void, EpicRunStoreError>;
  readonly getMergeState: (
    input: GetEpicRunInput,
  ) => Effect.Effect<Option.Option<EpicRunMergeState>, EpicRunStoreError>;
  readonly enqueueMerge: (
    input: EnqueueEpicRunMergeInput,
  ) => Effect.Effect<void, EpicRunStoreError>;
  /** Recover draining rows after restart and atomically mark new queued rows draining. */
  readonly beginMergeDrain: (
    input: GetEpicRunInput,
  ) => Effect.Effect<ReadonlyArray<EpicRunMergeEntry>, EpicRunStoreError>;
  readonly restoreMergeTail: (
    input: RestoreEpicRunMergeTailInput,
  ) => Effect.Effect<void, EpicRunStoreError>;
  /**
   * Advance the accepted HEAD without touching any queue row (t3code-sha): a
   * successful continuous-integration merge, or an integration-fix child
   * committing its resolution directly onto the base branch.
   */
  readonly advanceMergeIntegration: (
    input: AdvanceEpicRunMergeIntegrationInput,
  ) => Effect.Effect<void, EpicRunStoreError>;
  readonly beginParkMerge: (input: ParkEpicRunMergeInput) => Effect.Effect<void, EpicRunStoreError>;
  readonly finalizeParkMerge: (
    input: FinalizeParkedEpicRunMergeInput,
  ) => Effect.Effect<void, EpicRunStoreError>;
  /** Atomically advances accepted HEAD and removes the completed queue row. */
  readonly completeMerge: (
    input: CompleteEpicRunMergeInput,
  ) => Effect.Effect<void, EpicRunStoreError>;
  readonly dropMerge: (input: DropEpicRunMergeInput) => Effect.Effect<void, EpicRunStoreError>;
  readonly findParkedOriginalChild: (
    input: FindParkedEpicRunMergeInput,
  ) => Effect.Effect<Option.Option<string>, EpicRunStoreError>;
  /** Insert or replace the landing-effects row for one repository of a run. */
  readonly upsertLandingEffects: (
    input: UpsertEpicRunLandingEffectsInput,
  ) => Effect.Effect<void, EpicRunStoreError>;
  /** Every repository's landing-effects row for a run, ordered by path. */
  readonly getLandingEffects: (
    input: GetEpicRunInput,
  ) => Effect.Effect<ReadonlyArray<EpicRunLandingEffects>, EpicRunStoreError>;
  /** Remove merge state only after the integration worktree is gone. */
  readonly deleteMergeState: (input: GetEpicRunInput) => Effect.Effect<void, EpicRunStoreError>;
}

/**
 * EpicRunStore - Service tag for durable epic run persistence.
 */
export class EpicRunStore extends Context.Service<EpicRunStore, EpicRunStoreShape>()(
  "t3/persistence/Services/EpicRuns/EpicRunStore",
) {}
