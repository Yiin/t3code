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

export interface IterationWorkspace {
  readonly cwd: string;
  readonly branch: string | null;
  readonly worktreePath: string | null;
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
  /** Release an iteration workspace. Never fails; the adapter logs. */
  readonly release: (run: PoolRunContext, workspace: IterationWorkspace) => Effect.Effect<void>;
  /**
   * Release the integration workspace once the run is terminal. The outcome is
   * the run's terminal status. Never fails; the adapter logs.
   */
  readonly releaseIntegration: (
    run: PoolRunContext,
    outcome: "done" | "cancelled" | "failed",
  ) => Effect.Effect<void>;
}
