/**
 * Errors raised by the epic runner.
 *
 * The runner sits between three failure domains — durable run state, command
 * dispatch, and its own state machine — and callers (the WS/HTTP surface in a
 * sibling issue) need to tell them apart to decide between "retry", "the run is
 * gone", and "that transition is not legal". Hence one tagged error per domain
 * rather than a single opaque `EpicRunnerError`.
 *
 * @module EpicRunnerErrors
 */
import { EpicRunId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

/**
 * A durable-store read or write failed.
 */
export class EpicRunnerStoreError extends Schema.TaggedErrorClass<EpicRunnerStoreError>()(
  "EpicRunnerStoreError",
  {
    operation: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Epic runner store operation failed: ${this.operation}`;
  }
}

/**
 * An orchestration command the runner needed could not be dispatched.
 */
export class EpicRunnerDispatchError extends Schema.TaggedErrorClass<EpicRunnerDispatchError>()(
  "EpicRunnerDispatchError",
  {
    commandType: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Epic runner failed to dispatch ${this.commandType}: ${this.detail}`;
  }
}

/**
 * The referenced run does not exist.
 */
export class EpicRunNotFoundError extends Schema.TaggedErrorClass<EpicRunNotFoundError>()(
  "EpicRunNotFoundError",
  {
    runId: EpicRunId,
  },
) {
  override get message(): string {
    return `Epic run not found: ${this.runId}`;
  }
}

/**
 * The requested transition is not legal from the run's current status (e.g.
 * resuming a run that already finished).
 */
export class EpicRunStateError extends Schema.TaggedErrorClass<EpicRunStateError>()(
  "EpicRunStateError",
  {
    runId: EpicRunId,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Epic run ${this.runId} is in an invalid state: ${this.detail}`;
  }
}

export class EpicRunPreflightBlockedError extends Schema.TaggedErrorClass<EpicRunPreflightBlockedError>()(
  "EpicRunPreflightBlockedError",
  {
    epicId: Schema.String,
    blockers: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    return `Epic ${this.epicId} cannot start: ${this.blockers.join(", ")}`;
  }
}

export class EpicRunLaunchError extends Schema.TaggedErrorClass<EpicRunLaunchError>()(
  "EpicRunLaunchError",
  {
    reason: Schema.Literals([
      "project_not_found",
      "cwd_mismatch",
      "model_default_missing",
      "orientation_file_invalid",
      // The `inheritOriginModelSelection` family. A launch that asked to run
      // on the launching thread's provider never falls back to the project
      // default: the caller picked that provider on purpose.
      "origin_thread_required",
      "origin_thread_not_found",
      "origin_thread_project_mismatch",
    ]),
  },
) {
  override get message(): string {
    return `Epic run launch rejected: ${this.reason}`;
  }
}

export type EpicRunnerError =
  | EpicRunnerStoreError
  | EpicRunnerDispatchError
  | EpicRunNotFoundError
  | EpicRunStateError
  | EpicRunPreflightBlockedError
  | EpicRunLaunchError;
