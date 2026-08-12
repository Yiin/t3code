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
import type {
  AgentDispatchCapabilities,
  AgentSelection,
  IterationHandle,
  IterationResume,
} from "./AgentDispatch.ts";
import type { IterationWorkspace } from "./Workspace.ts";

/**
 * An iteration a restart lost the handle to, addressed by its durable ref.
 *
 * Every field `beginTurn` takes, minus `threadId` and plus the three things a
 * resume needs: the `ref` the harness persisted (a server thread id, a
 * terminal artifact path), the `iterationIndex` of the row to reopen, and the
 * `issueId` the iteration was working. The ref replaces `threadId` rather than
 * joining it — one durable pointer, so the two cannot disagree.
 *
 * `headBefore`, `branchBase` and `initialWorktreeFingerprint` are re-baselined
 * at resume time. The pre-restart values are not persisted and reconstructing
 * them would be a guess.
 */
export interface ResumableIteration {
  readonly ref: string;
  readonly runId: EpicRunId;
  readonly iterationIndex: number;
  readonly issueId: string;
  readonly prompt: string;
  readonly selection: AgentSelection;
  readonly runtimeMode: RuntimeMode;
  readonly policy: PoolTimings;
  readonly workspace: IterationWorkspace;
  readonly headBefore: string | null;
  readonly branchBase: string | null;
  readonly initialWorktreeFingerprint: string | null;
}

export interface PoolDispatchShape {
  /**
   * What this dispatch can do, readable with no handle. Restart
   * reconciliation reads `capabilities.lifecycle.resume` before it holds an
   * iteration, so the declaration cannot live on the handle alone.
   */
  readonly capabilities: AgentDispatchCapabilities;
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
  /**
   * Pick an interrupted iteration back up at its durable ref.
   *
   * Replaces `createIteration` + `beginTurn` for work that already has a row
   * and a thread: those two mint a new iteration index and a new ref, which is
   * exactly what a resume must not do.
   *
   * Two rules the implementation must keep.
   *
   * 1. Prove continuity BEFORE sending `prompt`. The harness must confirm the
   *    conversation really continued and refuse otherwise. A prompt sent into
   *    a blank session that looks resumed is unrecoverable: the agent answers
   *    with no memory of the work it was doing.
   * 2. Every foreseeable "cannot resume" is a returned
   *    `{ _tag: "unavailable" }`, NEVER a failure. `EpicRunnerDispatchError`
   *    is reserved for infra faults — a broken store, an unreachable engine.
   *    The caller treats unavailable as "start this child fresh instead" and a
   *    failure as "something is wrong with the machine".
   */
  readonly resumeIteration: (
    input: ResumableIteration,
  ) => Effect.Effect<IterationResume, EpicRunnerDispatchError>;
  /** Best-effort session stop for a created-but-never-dispatched thread. */
  readonly stopAbandoned: (threadId: ThreadId) => Effect.Effect<void>;
  /**
   * Best-effort unguarded session stop for the timeout and dispatch-failed
   * paths. The settled path uses the handle's guarded `release` instead.
   */
  readonly stopForced: (threadId: ThreadId) => Effect.Effect<void>;
}
