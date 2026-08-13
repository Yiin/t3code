/**
 * Durable state for one epic loop.
 *
 * The loop must append a `running` iteration before it dispatches the agent.
 * It updates that record only after the turn ends. A crash between these writes
 * must therefore leave visible work that restart recovery can abandon safely.
 *
 * `markIterationResumed` is the same discipline in reverse: it flips an
 * existing record back to `running` before a resume dispatch, so recovery of
 * the recovery still sees in-flight work.
 */
import {
  EpicRun as ContractEpicRun,
  EpicRunId,
  EpicRunStatus,
  IsoDateTime,
  NonNegativeInt,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const {
  threadRefs: _threadRefs,
  recentIterations: _recentIterations,
  ...persistedEpicRunFields
} = ContractEpicRun.fields;

/** The core-owned durable run record. Derived server read-model fields are excluded. */
export const PersistedEpicRun = Schema.Struct(persistedEpicRunFields);
export type PersistedEpicRun = typeof PersistedEpicRun.Type;

export { EpicRunStatus };

export const PersistedEpicRunIterationStatus = Schema.Literals([
  "running",
  "completed",
  "failed",
  "abandoned",
]);
export type PersistedEpicRunIterationStatus = typeof PersistedEpicRunIterationStatus.Type;

/** The complete durable record for one dispatch attempt. */
export const PersistedEpicRunIteration = Schema.Struct({
  runId: EpicRunId,
  iterationIndex: NonNegativeInt,
  threadId: ThreadId,
  issueId: Schema.NullOr(Schema.String),
  turnStatus: PersistedEpicRunIterationStatus,
  summary: Schema.NullOr(Schema.String),
  why: Schema.NullOr(Schema.String),
  failureReason: Schema.NullOr(Schema.String),
  headBefore: Schema.optional(Schema.NullOr(Schema.String)),
  headAfter: Schema.optional(Schema.NullOr(Schema.String)),
  /**
   * How many times `markIterationResumed` reopened this record. Absent on
   * every record written before the column existed; treat absent as `0`. A
   * resume reuses the record, so `iterationIndex`, `threadId` and `startedAt`
   * keep the values the first dispatch wrote.
   */
  resumeCount: Schema.optionalKey(NonNegativeInt),
  lastResumedAt: Schema.optionalKey(Schema.NullOr(IsoDateTime)),
  startedAt: IsoDateTime,
  finishedAt: Schema.NullOr(IsoDateTime),
});
export type PersistedEpicRunIteration = typeof PersistedEpicRunIteration.Type;

export const UpdatePersistedEpicRunIteration = Schema.Struct({
  runId: EpicRunId,
  iterationIndex: NonNegativeInt,
  turnStatus: PersistedEpicRunIterationStatus,
  summary: Schema.NullOr(Schema.String),
  why: Schema.NullOr(Schema.String),
  failureReason: Schema.NullOr(Schema.String),
  headBefore: Schema.optional(Schema.NullOr(Schema.String)),
  headAfter: Schema.optional(Schema.NullOr(Schema.String)),
  finishedAt: Schema.NullOr(IsoDateTime),
});
export type UpdatePersistedEpicRunIteration = typeof UpdatePersistedEpicRunIteration.Type;

export const MarkPersistedEpicRunIterationResumed = Schema.Struct({
  runId: EpicRunId,
  iterationIndex: NonNegativeInt,
  resumedAt: IsoDateTime,
});
export type MarkPersistedEpicRunIterationResumed = typeof MarkPersistedEpicRunIterationResumed.Type;

export class RunJournalError extends Schema.TaggedErrorClass<RunJournalError>()("RunJournalError", {
  operation: Schema.String,
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `Run journal operation failed: ${this.operation}: ${this.detail}`;
  }
}

export interface RunJournalShape {
  /** Create the initial record. An existing run must not be replaced. */
  readonly createRun: (run: PersistedEpicRun) => Effect.Effect<void, RunJournalError>;
  /** Replace the complete mutable run record. */
  readonly saveRun: (run: PersistedEpicRun) => Effect.Effect<void, RunJournalError>;
  readonly getRun: (
    runId: EpicRunId,
  ) => Effect.Effect<Option.Option<PersistedEpicRun>, RunJournalError>;
  /**
   * Append a unique iteration. Call this with `turnStatus: "running"` before
   * dispatch. Never merge a duplicate `(runId, iterationIndex)`.
   */
  readonly appendIteration: (
    iteration: PersistedEpicRunIteration,
  ) => Effect.Effect<void, RunJournalError>;
  /**
   * Replace only mutable iteration fields. `threadId` and `startedAt` stay
   * fixed. A missing index is a no-op, matching the server persistence port.
   */
  readonly updateIteration: (
    input: UpdatePersistedEpicRunIteration,
  ) => Effect.Effect<void, RunJournalError>;
  /**
   * Reopen an existing iteration so its own agent session can be continued.
   *
   * The record goes back to `running`, its terminal fields clear, the resume
   * counter bumps and the stamp lands. `threadId` and `startedAt` stay fixed,
   * because a resume is the same iteration across two process lifetimes, not
   * a new one. Call this BEFORE the resume dispatch so a crash during the
   * resume still leaves visible in-flight work. A missing index is a no-op,
   * matching `updateIteration`.
   */
  readonly markIterationResumed: (
    input: MarkPersistedEpicRunIterationResumed,
  ) => Effect.Effect<void, RunJournalError>;
  /** Return iterations in ascending index order. */
  readonly listIterations: (
    runId: EpicRunId,
  ) => Effect.Effect<ReadonlyArray<PersistedEpicRunIteration>, RunJournalError>;
  readonly getLatestIteration: (
    runId: EpicRunId,
  ) => Effect.Effect<Option.Option<PersistedEpicRunIteration>, RunJournalError>;
}

/**
 * Durable provider health, shared by every run in one workspace.
 *
 * This is deliberately not part of {@link RunJournalShape}: a degradation
 * outlives the run that recorded it, so a later run of the same epic can start
 * past an account that is still rate limited. Both epic loops write it and
 * both clear it after a provider turn succeeds.
 */
export interface ProviderDegradationJournalShape {
  readonly upsertProviderDegradation: (input: {
    readonly providerInstanceId: ProviderInstanceId;
    readonly failureReason: string;
    readonly degradedAt: string;
  }) => Effect.Effect<void, RunJournalError>;
  readonly clearProviderDegradation: (input: {
    readonly providerInstanceId: ProviderInstanceId;
  }) => Effect.Effect<void, RunJournalError>;
}

export class RunJournal extends Context.Service<RunJournal, RunJournalShape>()(
  "@t3tools/epic-core/ports/RunJournal",
) {}
