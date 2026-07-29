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

export const EpicRunStatus = Schema.Literals(["running", "paused", "done", "failed", "cancelled"]);
export type EpicRunStatus = typeof EpicRunStatus.Type;

export const EpicRunInput = Schema.Struct({
  epicId: TrimmedNonEmptyString,
  projectId: ProjectId,
  cwd: TrimmedNonEmptyString,
  prompt: Schema.String,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode.pipe(Schema.withDecodingDefault(Effect.succeed("full-access"))),
  maxIterations: Schema.optional(PositiveInt),
});
export type EpicRunInput = typeof EpicRunInput.Type;
export type StartEpicRunInput = Omit<EpicRunInput, "runtimeMode"> & {
  readonly runtimeMode?: EpicRunInput["runtimeMode"] | undefined;
};

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
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  status: EpicRunStatus,
  maxIterations: PositiveInt,
  iterationsCompleted: NonNegativeInt,
  currentThreadId: Schema.NullOr(ThreadId),
  currentTurnStartedAt: Schema.NullOr(IsoDateTime),
  consecutiveFailures: NonNegativeInt,
  lastError: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  threadRefs: Schema.Array(EpicRunThreadRef).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
});
export type EpicRun = typeof EpicRun.Type;

export const EpicRunRef = Schema.Struct({
  runId: EpicRunId,
});
export type EpicRunRef = typeof EpicRunRef.Type;

export const ListEpicRunsInput = Schema.Struct({
  status: Schema.optional(EpicRunStatus),
});
export type ListEpicRunsInput = typeof ListEpicRunsInput.Type;

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

export const EpicRunTransportError = Schema.Union([
  EpicRunnerStoreError,
  EpicRunnerDispatchError,
  EpicRunNotFoundError,
  EpicRunStateError,
  EpicRunPreflightBlockedError,
]);
export type EpicRunTransportError = typeof EpicRunTransportError.Type;
