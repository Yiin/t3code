/** Version-control effects used by sequential and parallel epic runs. */
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class VcsError extends Schema.TaggedErrorClass<VcsError>()("VcsError", {
  operation: Schema.String,
  repositoryPath: Schema.String,
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export interface CreatedWorktree {
  readonly repositoryPath: string;
  readonly worktreePath: string;
  readonly branch: string;
}

export interface RepoRef {
  readonly repositoryPath: string;
  readonly baseBranch: string;
  readonly worktreeRoot: string;
  readonly siblings: ReadonlyArray<{
    readonly repositoryPath: string;
    readonly baseBranch: string;
    readonly worktreeRoot: string;
  }>;
}

export interface RepoOperation {
  readonly repositoryPath: string;
  readonly commit: string;
}

export interface MergeRepositoryResult {
  readonly repositoryPath: string;
  readonly passed: boolean;
  readonly output: string;
}

export interface TrialMergeResult {
  readonly passed: boolean;
  readonly repositories: ReadonlyArray<MergeRepositoryResult>;
}

export interface LandRepoSetResult {
  readonly repositories: ReadonlyArray<{ readonly repositoryPath: string }>;
}

export interface VcsShape {
  readonly headCommit: (repository: RepoRef) => Effect.Effect<string | null, VcsError>;
  /** `git symbolic-ref --short HEAD`; `null` when detached or unreadable. */
  readonly currentBranch: (repositoryPath: string) => Effect.Effect<string | null, VcsError>;
  /**
   * The committer email (`%cE`) of every commit in `from..to`, for the
   * sequential in-place crediting fix (t3code-6qy, mirroring the pool's
   * t3code-e6l): a sequential worker shares the operator's own checkout, so
   * its head can move from either the worker or an operator commit made in
   * the same window, and only the committer identity tells them apart.
   * `null` is the port's usual "git told us nothing" — an unreadable log, an
   * unknown ref — and the caller falls back to head-move credit rather than
   * treating an infra flake as no credit.
   */
  readonly commitsByCommitter: (input: {
    readonly cwd: string;
    readonly from: string;
    readonly to: string;
  }) => Effect.Effect<ReadonlyArray<string> | null, VcsError>;
  /**
   * Count commits on `branch` not reachable from `base`
   * (`git rev-list --count base..branch`). `null` on any read failure, so a
   * broken ref never counts as progress — same contract as the server's
   * branch commit probe.
   */
  readonly commitsAhead: (input: {
    readonly cwd: string;
    readonly base: string;
    readonly branch: string;
  }) => Effect.Effect<number | null, VcsError>;
  /** Return `git status --porcelain=v1` for the selected repository. */
  readonly worktreeFingerprint: (repository: RepoRef) => Effect.Effect<string | null, VcsError>;
  /** The caller supplies the root. Core code must not read server configuration. */
  readonly createWorktree: (input: {
    readonly repositoryPath: string;
    readonly worktreeRoot: string;
    readonly branch: string;
    readonly startPoint: string;
  }) => Effect.Effect<CreatedWorktree, VcsError>;
  readonly removeWorktree: (input: {
    readonly repositoryPath: string;
    readonly worktreePath: string;
  }) => Effect.Effect<void, VcsError>;
  /** Trial every repository in order and abort the repository that conflicts. */
  readonly trialMerge: (input: {
    readonly repositories: ReadonlyArray<RepoOperation>;
  }) => Effect.Effect<TrialMergeResult, VcsError>;
  /** Land the accepted repo set after the core verifies every base head. */
  readonly landFastForward: (input: {
    readonly repositories: ReadonlyArray<RepoOperation>;
  }) => Effect.Effect<LandRepoSetResult, VcsError>;
  readonly push: (input: {
    readonly repositoryPath: string;
    readonly remote: string;
    readonly refspec: string;
  }) => Effect.Effect<void, VcsError>;
}
