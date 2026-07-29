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
 * honour: `appendIteration` (carrying its `threadId` and `turnStatus: "running"`)
 * happens BEFORE the runner dispatches `thread.turn.start`, and the terminal
 * state is persisted after the turn resolves. A crash in between therefore
 * leaves a visible `running` iteration rather than a turn nobody knows about.
 *
 * ## Why the iteration readers exist
 *
 * On restart the runner finds a `running` iteration, marks it `abandoned` via
 * `updateIteration`, and then needs `getLatestIteration + 1` for the next
 * index — hence both `listIterations` and `getLatestIteration`. The loop logic
 * itself is not this module's concern.
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
  ThreadId,
  EpicRunRef,
  type EpicRunRef as EpicRunRefType,
  ListEpicRunsInput as ListEpicRunsInputSchema,
  type ListEpicRunsInput as ListEpicRunsInputType,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
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

export const EpicRunIteration = Schema.Struct({
  runId: EpicRunId,
  iterationIndex: NonNegativeInt,
  threadId: ThreadId,
  issueId: Schema.NullOr(Schema.String),
  turnStatus: EpicRunIterationStatus,
  summary: Schema.NullOr(Schema.String),
  why: Schema.NullOr(Schema.String),
  startedAt: IsoDateTime,
  finishedAt: Schema.NullOr(IsoDateTime),
});
export type EpicRunIteration = typeof EpicRunIteration.Type;

export const GetEpicRunInput = EpicRunRef;
export type GetEpicRunInput = EpicRunRefType;

export const ListEpicRunsInput = ListEpicRunsInputSchema;
export type ListEpicRunsInput = ListEpicRunsInputType;

export const ListEpicRunIterationsInput = Schema.Struct({
  runId: EpicRunId,
});
export type ListEpicRunIterationsInput = typeof ListEpicRunIterationsInput.Type;

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
  finishedAt: Schema.NullOr(IsoDateTime),
});
export type UpdateEpicRunIterationInput = typeof UpdateEpicRunIterationInput.Type;

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
   * List epic runs, optionally narrowed to one status.
   *
   * Returned in deterministic creation order. On restart the runner lists the
   * `running` rows to decide what to resume.
   */
  readonly listRuns: (
    input: ListEpicRunsInput,
  ) => Effect.Effect<ReadonlyArray<EpicRun>, EpicRunStoreError>;

  /**
   * Append one iteration row.
   *
   * Must be called with `turnStatus: "running"` before the turn is dispatched.
   * A duplicate `(runId, iterationIndex)` is rejected rather than merged.
   */
  readonly appendIteration: (iteration: EpicRunIteration) => Effect.Effect<void, EpicRunStoreError>;

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
   * List a run's iterations in ascending index order.
   */
  readonly listIterations: (
    input: ListEpicRunIterationsInput,
  ) => Effect.Effect<ReadonlyArray<EpicRunIteration>, EpicRunStoreError>;

  /**
   * Read a run's highest-indexed iteration, if any.
   *
   * The runner uses this to compute the next iteration index after closing out
   * an abandoned one.
   */
  readonly getLatestIteration: (
    input: GetLatestEpicRunIterationInput,
  ) => Effect.Effect<Option.Option<EpicRunIteration>, EpicRunStoreError>;
}

/**
 * EpicRunStore - Service tag for durable epic run persistence.
 */
export class EpicRunStore extends Context.Service<EpicRunStore, EpicRunStoreShape>()(
  "t3/persistence/Services/EpicRuns/EpicRunStore",
) {}
