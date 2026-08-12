/** Workspace lifecycle for the parallel epic loop. */
import type { EpicRunId, ProjectId } from "@t3tools/contracts";
import type * as Effect from "effect/Effect";

import type { EpicRunnerError } from "../Errors.ts";

/** The run coordinates a workspace adapter needs; never server configuration. */
export interface PoolRunContext {
  readonly runId: EpicRunId;
  readonly epicId: string;
  readonly projectId: ProjectId;
  readonly cwd: string;
}

/**
 * One sibling worktree of a layout (parallel) or real sibling checkout
 * (sequential): where the iteration may also commit.
 */
export interface SiblingWorktree {
  readonly worktreePath: string;
  readonly sourcePath: string;
  readonly baseBranch: string;
}

export interface IterationWorkspace {
  readonly cwd: string;
  readonly branch: string | null;
  readonly worktreePath: string | null;
  /** Empty when the run has no siblings. */
  readonly siblingWorktrees: ReadonlyArray<SiblingWorktree>;
  /** The sibling prompt rule for this workspace; `null` when no siblings. */
  readonly siblingRule: string | null;
}

/**
 * The merge-queue view the loop needs to decide whether a drain must run
 * before the next dispatch. `null` in sequential mode.
 */
export interface MergeQueueSnapshot {
  readonly entries: ReadonlyArray<{
    readonly status: "queued" | "draining" | "parked";
  }>;
}

export interface WorkspaceShape {
  /**
   * Provision the integration worktree for a parallel run, or return the
   * persisted one. Sequential runs return `null`.
   */
  readonly ensureIntegration: (
    run: PoolRunContext,
  ) => Effect.Effect<MergeQueueSnapshot | null, EpicRunnerError>;
  /** Provision the workspace one iteration runs in. */
  readonly acquire: (
    run: PoolRunContext,
    input: {
      readonly issueId: string;
      readonly issueTitle: string;
      readonly sequential: boolean;
    },
  ) => Effect.Effect<IterationWorkspace, EpicRunnerError>;
  /**
   * Rebuild the workspace record of an iteration that is ALREADY provisioned,
   * without provisioning anything.
   *
   * A restart loses the in-memory {@link IterationWorkspace} but not the
   * worktree on disk, so a resumed iteration needs its record back — the same
   * `siblingWorktrees` and `siblingRule` derivation `acquire` does, with the
   * main path and branch supplied by the caller rather than derived.
   *
   * Read `branch` and `worktreePath` from the caller and never re-derive them
   * from `issueId`: a merge-fix child works a parked branch, so the derived
   * name and the real one disagree.
   *
   * Fails when the worktree is not on disk, or not registered with git. That
   * is a refusal the caller turns into "start this child fresh", not a run
   * failure.
   */
  readonly adopt: (
    run: PoolRunContext,
    input: {
      readonly issueId: string;
      readonly branch: string | null;
      readonly worktreePath: string | null;
      readonly sequential: boolean;
    },
  ) => Effect.Effect<IterationWorkspace, EpicRunnerError>;
  /**
   * Release an iteration workspace. The single-repo path never fails (the
   * adapter logs); a layout cleanup failure propagates and the loop fails the
   * run as `infra:merge-reconciliation`.
   */
  readonly release: (
    run: PoolRunContext,
    workspace: IterationWorkspace,
  ) => Effect.Effect<void, EpicRunnerError>;
  /**
   * Release the integration workspace once the run is terminal. The outcome is
   * the run's terminal status. Never fails; the adapter logs.
   */
  readonly releaseIntegration: (
    run: PoolRunContext,
    outcome: "done" | "cancelled" | "failed",
  ) => Effect.Effect<void>;
}
