import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export interface EpicRunLockOwner {
  readonly owner: string;
  readonly host: string;
  readonly bootId?: string;
  readonly pid: number;
  readonly pgid: number;
  readonly startTicks?: string;
  readonly runDir: string;
  readonly startedAt: string;
  readonly heartbeatAt: number;
}

export interface AcquireEpicRunLockInput {
  readonly workspaceRoot: string;
  readonly epicId: string;
  readonly owner: string;
  readonly runDir: string;
  readonly pid?: number;
  readonly pgid?: number;
}

export interface EpicRunLockLease {
  readonly path: string;
  readonly owner: EpicRunLockOwner;
  readonly heartbeat: Effect.Effect<boolean, EpicRunLockError>;
  readonly release: Effect.Effect<boolean, EpicRunLockError>;
}

export class EpicRunLockError extends Error {
  readonly _tag = "EpicRunLockError";
  readonly operation: string;
  override readonly cause: unknown;

  constructor(operation: string, cause?: unknown) {
    super(`Epic run lock operation failed: ${operation}`, { cause });
    this.operation = operation;
    this.cause = cause;
  }
}

export class EpicRunLockHeldError extends Error {
  readonly _tag = "EpicRunLockHeldError";
  readonly path: string;
  readonly holder: Partial<EpicRunLockOwner> | undefined;

  constructor(path: string, holder: Partial<EpicRunLockOwner> | undefined) {
    super(`Epic run lock is already held: ${path}`);
    this.path = path;
    this.holder = holder;
  }
}

export interface EpicRunLockShape {
  readonly inspect: (input: {
    readonly workspaceRoot: string;
    readonly epicId: string;
  }) => Effect.Effect<EpicRunLockOwner | undefined, EpicRunLockError>;
  readonly acquire: (
    input: AcquireEpicRunLockInput,
  ) => Effect.Effect<EpicRunLockLease, EpicRunLockError | EpicRunLockHeldError>;
}

export class EpicRunLock extends Context.Service<EpicRunLock, EpicRunLockShape>()(
  "t3/runner/Services/EpicRunLock",
) {}
