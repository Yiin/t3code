/**
 * Resolve the base branch a parallel run's worktrees start from.
 *
 * With `vcs.runOwnedBaseBranch` off this is exactly today's behaviour: the
 * operator's currently checked-out branch, read fresh every call. With it on,
 * the run owns `epic/<epicId>/base` (t3code-5m4): created once from the
 * operator's branch, then reused verbatim — never reset, never force-updated —
 * by every later call in this process and every later resume, because the
 * check-then-create is idempotent against the branch's mere existence rather
 * than any config or in-memory state.
 *
 * Ownership: `epic/<epicId>/base` belongs to the epic, not to any one run —
 * unlike `cook-epic-integration-<runId>`, which a run deletes at its own end
 * (`EpicRunnerPoolPorts.ts`, `TerminalPoolWorkspace.ts`), this branch
 * deliberately outlives the run that created it, so a later run of the same
 * epic keeps building on the same base instead of losing landed progress.
 * Nothing deletes it. `EpicRunPreflight` warns (never blocks) when a reused
 * branch is behind the operator's checked-out branch, so staleness stays
 * visible without taking the deliberate-reuse behaviour away.
 *
 * @module runBaseBranch
 */
import * as Effect from "effect/Effect";

import { runBaseBranch as runBaseBranchName } from "./policy.ts";

/** The minimal git capability this resolution needs, bound to one cwd by the caller. */
export interface ResolveBaseBranchGit<E> {
  readonly currentBranch: (cwd: string) => Effect.Effect<string, E>;
  readonly branchExists: (cwd: string, branch: string) => Effect.Effect<boolean, E>;
  /** Plain `git branch <branch> <startPoint>` — never a checkout, never a reset. */
  readonly createBranch: (
    cwd: string,
    branch: string,
    startPoint: string,
  ) => Effect.Effect<void, E>;
}

export interface ResolveRunBaseBranchInput {
  readonly cwd: string;
  readonly epicId: string;
  /** `EpicRunConfig.vcs.runOwnedBaseBranch`. Sequential runs must never pass `true` here. */
  readonly runOwnedBaseBranch: boolean;
}

/**
 * The base branch name this call should target.
 *
 * Creation races (two workers dispatching at once, both losing the
 * `branchExists` check) resolve to the branch whichever caller created first:
 * a failed `createBranch` is retried as one more existence check, and only a
 * `createBranch` failure that is NOT explained by the branch now existing
 * propagates.
 */
export const resolveRunBaseBranch = <E>(
  git: ResolveBaseBranchGit<E>,
  input: ResolveRunBaseBranchInput,
): Effect.Effect<string, E> =>
  Effect.gen(function* () {
    if (!input.runOwnedBaseBranch) return yield* git.currentBranch(input.cwd);

    const owned = runBaseBranchName(input.epicId);
    if (yield* git.branchExists(input.cwd, owned)) return owned;

    const startPoint = yield* git.currentBranch(input.cwd);
    yield* git
      .createBranch(input.cwd, owned, startPoint)
      .pipe(
        Effect.catch((error) =>
          git
            .branchExists(input.cwd, owned)
            .pipe(Effect.flatMap((existsNow) => (existsNow ? Effect.void : Effect.fail(error)))),
        ),
      );
    return owned;
  });
