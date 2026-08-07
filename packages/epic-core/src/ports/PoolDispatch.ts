/**
 * Two-phase pool dispatch for the parallel epic loop.
 *
 * Phase one (`createIteration`) creates the orchestration thread under the
 * loop's transition semaphore, atomically with the iteration-row allocation.
 * `prepareIteration` then runs the worktree setup script outside the
 * semaphore, and phase two (`beginTurn`) charges the run row and starts the
 * provider turn, again under the semaphore. `stopAbandoned` cleans up a
 * created thread whose turn was never dispatched.
 */
import type { EpicRunId, ProjectId, RuntimeMode, ThreadId } from "@t3tools/contracts";
import type * as Effect from "effect/Effect";

import type { EpicRunnerDispatchError } from "../Errors.ts";
import type { PoolTimings } from "../ParallelEpicLoop.ts";
import type { AgentSelection, IterationHandle } from "./AgentDispatch.ts";
import type { IterationWorkspace } from "./Workspace.ts";

export interface PoolDispatchShape {
  /** Create the iteration's thread. Runs inside the loop's transition. */
  readonly createIteration: (input: {
    readonly runId: EpicRunId;
    readonly iterationIndex: number;
    readonly threadId: ThreadId;
    readonly projectId: ProjectId;
    readonly title: string;
    readonly selection: AgentSelection;
    readonly runtimeMode: RuntimeMode;
    readonly branch: string | null;
    readonly worktreePath: string | null;
    readonly startedAt: string;
    readonly policy: PoolTimings;
  }) => Effect.Effect<void, EpicRunnerDispatchError>;
  /**
   * Run the worktree setup script between the two transition phases. Never
   * fails; the adapter logs and continues.
   */
  readonly prepareIteration: (input: {
    readonly threadId: ThreadId;
    readonly projectId: ProjectId;
    readonly runCwd: string;
    readonly worktreePath: string | null;
    readonly branch: string | null;
  }) => Effect.Effect<void>;
  /**
   * Start the provider turn and return its handle. Runs inside the loop's
   * transition, after the run row is charged.
   *
   * The handle's `awaitSettled` awaits turn end plus any grace continuations
   * and is UNBOUNDED — the loop applies the iteration timeout. `finalMessage`
   * performs the settled final-message read when called. `release` is the
   * advisory drain plus guarded session stop. `interrupt` is the best-effort
   * turn interrupt used before timeout classification.
   */
  readonly beginTurn: (input: {
    readonly threadId: ThreadId;
    readonly prompt: string;
    readonly selection: AgentSelection;
    readonly runtimeMode: RuntimeMode;
    readonly policy: PoolTimings;
    readonly runId: EpicRunId;
    readonly iterationIndex: number;
    readonly workspace: IterationWorkspace;
    readonly headBefore: string | null;
    readonly branchBase: string | null;
    readonly initialWorktreeFingerprint: string | null;
  }) => Effect.Effect<IterationHandle, EpicRunnerDispatchError>;
  /** Best-effort session stop for a created-but-never-dispatched thread. */
  readonly stopAbandoned: (threadId: ThreadId) => Effect.Effect<void>;
  /**
   * Best-effort unguarded session stop for the timeout and dispatch-failed
   * paths. The settled path uses the handle's guarded `release` instead.
   */
  readonly stopForced: (threadId: ThreadId) => Effect.Effect<void>;
}
