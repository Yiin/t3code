/**
 * ProjectionThreadSubagentRepository - Projection repository interface for
 * per-thread subagent rows.
 *
 * Owns persistence for the subagent read model folded from `task.*` thread
 * activities, so subagent state survives the capped thread-detail activity
 * reads.
 *
 * @module ProjectionThreadSubagentRepository
 */
import {
  IsoDateTime,
  OrchestrationThreadSubagentStatus,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionThreadSubagent = Schema.Struct({
  subagentId: TrimmedNonEmptyString,
  threadId: ThreadId,
  turnId: Schema.NullOr(TurnId),
  agentType: Schema.optional(TrimmedNonEmptyString),
  description: Schema.optional(TrimmedNonEmptyString),
  status: OrchestrationThreadSubagentStatus,
  lastProgressSummary: Schema.optional(TrimmedNonEmptyString),
  lastToolName: Schema.optional(TrimmedNonEmptyString),
  usage: Schema.optional(Schema.Unknown),
  spawnedByItemId: Schema.optional(TrimmedNonEmptyString),
  childThreadId: Schema.optional(ThreadId),
  startedAt: IsoDateTime,
  updatedAt: IsoDateTime,
  completedAt: Schema.NullOr(IsoDateTime),
});
export type ProjectionThreadSubagent = typeof ProjectionThreadSubagent.Type;

export const ListProjectionThreadSubagentsInput = Schema.Struct({
  threadId: ThreadId,
});
export type ListProjectionThreadSubagentsInput = typeof ListProjectionThreadSubagentsInput.Type;

export const CountRunningProjectionThreadSubagentsInput = Schema.Struct({
  threadId: ThreadId,
});
export type CountRunningProjectionThreadSubagentsInput =
  typeof CountRunningProjectionThreadSubagentsInput.Type;

export const DeleteProjectionThreadSubagentsInput = Schema.Struct({
  threadId: ThreadId,
});
export type DeleteProjectionThreadSubagentsInput = typeof DeleteProjectionThreadSubagentsInput.Type;

export const CloseRunningProjectionThreadSubagentsInput = Schema.Struct({
  threadId: ThreadId,
  status: Schema.Literals(["completed", "failed", "stopped"]),
  completedAt: IsoDateTime,
});
export type CloseRunningProjectionThreadSubagentsInput =
  typeof CloseRunningProjectionThreadSubagentsInput.Type;

/**
 * ProjectionThreadSubagentRepositoryShape - Service API for projected
 * subagent rows.
 */
export interface ProjectionThreadSubagentRepositoryShape {
  /**
   * Insert or replace a projected subagent row.
   *
   * Upserts by `(threadId, subagentId)` and JSON-encodes usage.
   */
  readonly upsert: (
    row: ProjectionThreadSubagent,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  /**
   * List projected subagent rows for a thread, oldest start first.
   */
  readonly listByThreadId: (
    input: ListProjectionThreadSubagentsInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionThreadSubagent>, ProjectionRepositoryError>;

  /**
   * Count a thread's subagent rows whose status is still `running`.
   */
  readonly countRunningByThreadId: (
    input: CountRunningProjectionThreadSubagentsInput,
  ) => Effect.Effect<number, ProjectionRepositoryError>;

  /**
   * Delete projected subagent rows by thread.
   */
  readonly deleteByThreadId: (
    input: DeleteProjectionThreadSubagentsInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  /**
   * Bulk-close a thread's still-`running` rows to a terminal status.
   *
   * Used when the thread's session reaches a terminal status and can no
   * longer complete its subagents; stamps `updatedAt`/`completedAt` with
   * `completedAt`.
   */
  readonly closeRunningByThreadId: (
    input: CloseRunningProjectionThreadSubagentsInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

/**
 * ProjectionThreadSubagentRepository - Service tag for subagent persistence.
 */
export class ProjectionThreadSubagentRepository extends Context.Service<
  ProjectionThreadSubagentRepository,
  ProjectionThreadSubagentRepositoryShape
>()("t3/persistence/Services/ProjectionThreadSubagents/ProjectionThreadSubagentRepository") {}
