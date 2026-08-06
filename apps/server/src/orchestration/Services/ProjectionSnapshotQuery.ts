/**
 * ProjectionSnapshotQuery - Read-model snapshot query service interface.
 *
 * Exposes the current orchestration projection snapshot for read-only API
 * access.
 *
 * @module ProjectionSnapshotQuery
 */
import type {
  CheckpointRef,
  OrchestrationCheckpointSummary,
  OrchestrationProject,
  OrchestrationProjectShell,
  OrchestrationReadModel,
  OrchestrationGetSubagentActivitiesInput,
  OrchestrationGetSubagentActivitiesResult,
  OrchestrationSession,
  OrchestrationShellSnapshot,
  OrchestrationThread,
  OrchestrationThreadDetailSnapshot,
  OrchestrationThreadShell,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Option from "effect/Option";
import type * as Effect from "effect/Effect";

import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";

export interface ProjectionSnapshotCounts {
  readonly projectCount: number;
  readonly threadCount: number;
}

export interface ProjectionSnapshotSequence {
  readonly snapshotSequence: number;
}

export interface ProjectionThreadCheckpointContext {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly workspaceRoot: string;
  readonly worktreePath: string | null;
  readonly checkpoints: ReadonlyArray<OrchestrationCheckpointSummary>;
}

/**
 * One thread the auto-settle sweeper may settle.
 *
 * Deliberately not an `OrchestrationThreadShell`: every reason to refuse a
 * settle is already applied in SQL, so the sweeper needs the id to dispatch
 * on, the activity timestamp to log, and just enough of the workspace to ask
 * the VCS status cache whether this thread's change request is merged —
 * `worktreePath ?? workspaceRoot` is the cwd, and `branch` is what a thread
 * sharing the workspace root has to still be on before that cwd's PR counts
 * as its own. Returning a shell would mean hydrating a session and a latest
 * turn the caller never reads.
 */
export interface ProjectionAutoSettleCandidate {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly lastActivityAt: string;
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly workspaceRoot: string;
}

/**
 * The running-subagent slice of one thread, for liveness consumers.
 */
export interface ProjectionThreadSubagentLiveness {
  /** Number of subagent rows still in status `running`. */
  readonly activeSubagentCount: number;
  /** `MAX(updated_at)` over the `running` rows, or null when there are none. */
  readonly newestRunningUpdatedAt: string | null;
}

export interface ProjectionFullThreadDiffContext {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly workspaceRoot: string;
  readonly worktreePath: string | null;
  readonly latestCheckpointTurnCount: number;
  readonly toCheckpointRef: CheckpointRef | null;
}

/**
 * ProjectionSnapshotQueryShape - Service API for read-model snapshots.
 */
export interface ProjectionSnapshotQueryShape {
  /**
   * Read the lightweight command snapshot used to bootstrap the in-memory
   * orchestration engine without hydrating message/activity/checkpoint bodies.
   */
  readonly getCommandReadModel: () => Effect.Effect<
    OrchestrationReadModel,
    ProjectionRepositoryError
  >;

  /**
   * Read the latest orchestration projection snapshot.
   *
   * Rehydrates from projection tables and derives snapshot sequence from
   * projector cursor state.
   *
   * TEST-ONLY. This method has no HTTP surface: `/api/orchestration/snapshot`
   * was deleted because the read is unbounded. It loads every message,
   * activity and checkpoint body for every thread in one transaction, so it
   * grows without limit and holds the single write connection for its whole
   * duration. One call measured 133 MB and 4 seconds, which stalls every
   * writer on the server. It is retained only for tests and the integration
   * harness, which assert on the fully hydrated read model.
   *
   * Do not call it from production code. Use `getShellSnapshot` for project
   * and thread lists, `getThreadDetailSnapshot` for one thread's bodies, and
   * `getCommandReadModel` for command-side aggregate state.
   *
   * `t3code/no-production-projection-snapshot` (oxlint-plugin-t3code) fails
   * the lint on any call outside `*.test.ts` and `*.integration.ts`.
   */
  readonly getSnapshot: () => Effect.Effect<OrchestrationReadModel, ProjectionRepositoryError>;

  /**
   * Read the latest orchestration shell snapshot.
   *
   * Returns only projects and thread shell summaries so clients can bootstrap
   * lightweight navigation state without hydrating every thread body.
   */
  readonly getShellSnapshot: () => Effect.Effect<
    OrchestrationShellSnapshot,
    ProjectionRepositoryError
  >;

  /**
   * Read archived thread shell summaries for the archive page.
   *
   * This query is separate from the main shell snapshot so archived threads
   * are never bootstrapped into normal navigation state.
   */
  readonly getArchivedShellSnapshot: () => Effect.Effect<
    OrchestrationShellSnapshot,
    ProjectionRepositoryError
  >;

  /**
   * Read the latest projection snapshot sequence without hydrating read-model
   * entities.
   */
  readonly getSnapshotSequence: () => Effect.Effect<
    ProjectionSnapshotSequence,
    ProjectionRepositoryError
  >;

  /**
   * Read aggregate projection counts without hydrating the full read model.
   */
  readonly getCounts: () => Effect.Effect<ProjectionSnapshotCounts, ProjectionRepositoryError>;

  /**
   * Read the active project for an exact workspace root match.
   */
  readonly getActiveProjectByWorkspaceRoot: (
    workspaceRoot: string,
  ) => Effect.Effect<Option.Option<OrchestrationProject>, ProjectionRepositoryError>;

  /**
   * Read a single active project shell row by id.
   */
  readonly getProjectShellById: (
    projectId: ProjectId,
  ) => Effect.Effect<Option.Option<OrchestrationProjectShell>, ProjectionRepositoryError>;

  /**
   * Read the earliest active thread for a project.
   */
  readonly getFirstActiveThreadIdByProjectId: (
    projectId: ProjectId,
  ) => Effect.Effect<Option.Option<ThreadId>, ProjectionRepositoryError>;

  /**
   * Read the checkpoint context needed to resolve a single thread diff.
   */
  readonly getThreadCheckpointContext: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<ProjectionThreadCheckpointContext>, ProjectionRepositoryError>;

  /**
   * Read only the narrow context needed to compute a full-thread diff from
   * checkpoint 0 to a specific turn count.
   */
  readonly getFullThreadDiffContext: (
    threadId: ThreadId,
    toTurnCount: number,
  ) => Effect.Effect<Option.Option<ProjectionFullThreadDiffContext>, ProjectionRepositoryError>;

  /**
   * Read a single active thread shell row by id.
   */
  readonly getThreadShellById: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<OrchestrationThreadShell>, ProjectionRepositoryError>;

  /**
   * Read a single thread's projected provider session, whatever the thread's
   * archived or settled state.
   *
   * `getThreadShellById` filters archived threads out, so a caller that reacts
   * to `thread.archived` cannot use it to decide whether the thread still has a
   * live session — by the time the event lands the shell is already gone. The
   * session row carries no archive column, so this read answers "is there
   * something to stop?" for active and archived threads alike.
   */
  readonly getThreadSessionById: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<OrchestrationSession>, ProjectionRepositoryError>;

  /**
   * Read one thread's running-subagent liveness in a single indexed read.
   *
   * The session reaper consults this before reaping a quiet session: a fresh
   * `running` row means in-flight work even when the main stream is idle
   * (`sessionReapPolicy.ts`). Callers judge freshness against
   * `RUNNING_SUBAGENT_FRESHNESS_MS` (`subagentLiveness.ts`).
   */
  readonly getThreadSubagentLiveness: (
    threadId: ThreadId,
  ) => Effect.Effect<ProjectionThreadSubagentLiveness, ProjectionRepositoryError>;

  /**
   * Page one subagent transcript newest-first, while returning each page in
   * ascending `(sequence, createdAt, activityId)` order for prepend merging.
   *
   * Rows match the subagent's spawning item through `parentToolUseId`, or the
   * subagent id through `taskId`. A subagent without a spawning item returns
   * only `taskId` rows.
   */
  readonly getSubagentActivities: (
    input: OrchestrationGetSubagentActivitiesInput,
  ) => Effect.Effect<OrchestrationGetSubagentActivitiesResult, ProjectionRepositoryError>;

  /**
   * List the threads an auto-settle sweep may settle.
   *
   * Every blocker the settled partition applies is applied here in SQL, so a
   * returned row is already a settle candidate: not deleted, not archived, no
   * settled override (neither the "settled" the runner or a user already set
   * nor the "active" pin that means keep it), no pending approval or
   * user-input request, no starting/running session, and a last activity
   * timestamp — the newest of the latest user message and the latest turn's
   * requested/started/completed times — that exists. A thread with no activity
   * at all is never a candidate.
   *
   * The decider still adjudicates each settle: this narrows the sweep, it does
   * not replace the command's guards.
   *
   * @param idleBefore - Keep only candidates whose last activity predates this
   *   timestamp, or null for every candidate whatever its age. The merged-PR
   *   sweep passes null: a merged change request finishes a thread no matter
   *   how recently someone typed in it.
   * @param limit - Maximum rows to return, so one sweep of a long-neglected
   *   database cannot dispatch unboundedly many commands.
   * @param runningSubagentFreshAfter - Exclude threads with a `running`
   *   subagent row updated at or after this timestamp: fresh running
   *   subagents are in-flight work the settle decider refuses, so the sweep
   *   must not even read those threads as candidates. Callers derive it as
   *   now minus `RUNNING_SUBAGENT_FRESHNESS_MS` (`subagentLiveness.ts`).
   */
  readonly listAutoSettleCandidates: (input: {
    readonly idleBefore: string | null;
    readonly limit: number;
    readonly runningSubagentFreshAfter: string;
  }) => Effect.Effect<ReadonlyArray<ProjectionAutoSettleCandidate>, ProjectionRepositoryError>;

  /**
   * Read a single active thread detail snapshot by id.
   */
  readonly getThreadDetailById: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<OrchestrationThread>, ProjectionRepositoryError>;

  /**
   * Read a single active thread detail together with the projection snapshot
   * sequence in one consistent transaction, so the returned `snapshotSequence`
   * exactly matches the state reflected in `thread` (no interleaving projector
   * update between the two reads).
   */
  readonly getThreadDetailSnapshot: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<OrchestrationThreadDetailSnapshot>, ProjectionRepositoryError>;
}

/**
 * ProjectionSnapshotQuery - Service tag for projection snapshot queries.
 */
export class ProjectionSnapshotQuery extends Context.Service<
  ProjectionSnapshotQuery,
  ProjectionSnapshotQueryShape
>()("t3/orchestration/Services/ProjectionSnapshotQuery") {}
