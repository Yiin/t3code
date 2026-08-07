/** Process ownership and activity checks for terminal workers. */
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export interface OwnedSpawnInput {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
}

export interface OwnedProcess {
  /** An adapter-owned identity that is safe to use for stop and reap operations. */
  readonly ref: string;
}

export interface ActivitySample {
  readonly active: boolean;
  readonly evidence: string;
}

export type WorkerExitCode = number | null;

export class WorkerSupervisorError extends Schema.TaggedErrorClass<WorkerSupervisorError>()(
  "WorkerSupervisorError",
  {
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

/**
 * Owns process identity, activity sampling, stop escalation, and reaping.
 *
 * Systemd scopes and detached process groups implement this port. The core
 * never sends a signal to an unverified process id.
 */
export interface WorkerSupervisorShape {
  readonly spawn: (input: OwnedSpawnInput) => Effect.Effect<OwnedProcess, WorkerSupervisorError>;
  readonly sample: (process: OwnedProcess) => Effect.Effect<ActivitySample, WorkerSupervisorError>;
  readonly isActive: (process: OwnedProcess) => Effect.Effect<boolean, WorkerSupervisorError>;
  readonly stop: (
    process: OwnedProcess,
    graceMs: number,
  ) => Effect.Effect<void, WorkerSupervisorError>;
  readonly reap: (process: OwnedProcess) => Effect.Effect<WorkerExitCode, WorkerSupervisorError>;
}
