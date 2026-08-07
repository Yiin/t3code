/**
 * Durable state for one epic loop.
 *
 * The loop must append a `running` iteration before it dispatches the agent.
 * It updates that record only after the turn ends. A crash between these writes
 * must therefore leave visible work that restart recovery can abandon safely.
 */
import {
  EpicRun as ContractEpicRun,
  EpicRunId,
  EpicRunStatus,
  IsoDateTime,
  NonNegativeInt,
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
  /** Return iterations in ascending index order. */
  readonly listIterations: (
    runId: EpicRunId,
  ) => Effect.Effect<ReadonlyArray<PersistedEpicRunIteration>, RunJournalError>;
  readonly getLatestIteration: (
    runId: EpicRunId,
  ) => Effect.Effect<Option.Option<PersistedEpicRunIteration>, RunJournalError>;
}

export class RunJournal extends Context.Service<RunJournal, RunJournalShape>()(
  "@t3tools/epic-core/ports/RunJournal",
) {}
