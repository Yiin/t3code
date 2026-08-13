import type { MergeGitShape } from "@t3tools/epic-core/ports/MergeQueue";
import { MergeQueuePortError } from "@t3tools/epic-core/ports/MergeQueue";
import {
  MERGE_HEAD_ARGS,
  RERERE_COMMIT_ARGS,
  RERERE_MERGE_FLAGS,
  UNMERGED_PATHS_ARGS,
} from "@t3tools/epic-core/rerere";
import * as Effect from "effect/Effect";

import type { ExecuteGitResult, GitVcsDriver } from "../vcs/GitVcsDriver.ts";

const outputDetail = (output: ExecuteGitResult): string =>
  [output.stdout, output.stderr]
    .filter((part) => part.length > 0)
    .join("\n")
    .trim();

/** Server adapter. All mutations use GitVcsDriver's shared common-dir mutex. */
export const makeEpicRunMergeGit = (input: {
  readonly git: GitVcsDriver["Service"];
  readonly setupWorktree: (cwd: string) => Effect.Effect<void, MergeQueuePortError>;
}): MergeGitShape => {
  const run = (operation: string, cwd: string, args: ReadonlyArray<string>) =>
    input.git
      .execute({ operation: `EpicRunner.merge.${operation}`, cwd, args, allowNonZeroExit: true })
      .pipe(
        Effect.mapError(
          (cause) =>
            new MergeQueuePortError({
              operation,
              detail: `Could not run git in ${cwd}`,
              cause,
            }),
        ),
      );

  const requireSuccess = Effect.fn("EpicRunMergeGit.requireSuccess")(function* (
    operation: string,
    cwd: string,
    args: ReadonlyArray<string>,
  ) {
    const output = yield* run(operation, cwd, args);
    if (output.exitCode !== 0) {
      return yield* new MergeQueuePortError({
        operation,
        detail: outputDetail(output) || `git exited with code ${String(output.exitCode)}`,
      });
    }
    return output;
  });

  /**
   * Turn a conflicted merge that rerere fully resolved into a real merge commit.
   * Terminal twin: `ProcessMergeGit.completeRerereMerge`. See
   * `@t3tools/epic-core/rerere` for why `git merge` cannot do this itself.
   */
  const completeRerereMerge = Effect.fn("EpicRunMergeGit.completeRerereMerge")(function* (
    cwd: string,
    merge: ExecuteGitResult,
  ) {
    const failed = { merged: false, output: outputDetail(merge) } as const;
    const mergeHead = yield* run("trialMergeHead", cwd, [...MERGE_HEAD_ARGS]);
    if (mergeHead.exitCode !== 0) return failed;
    const unmerged = yield* run("trialMergeUnmerged", cwd, [...UNMERGED_PATHS_ARGS]);
    if (unmerged.exitCode !== 0 || unmerged.stdout.trim().length > 0) return failed;
    const commit = yield* run("trialMergeRerereCommit", cwd, [...RERERE_COMMIT_ARGS]);
    return commit.exitCode === 0
      ? ({ merged: true, output: outputDetail(commit) } as const)
      : failed;
  });

  return {
    head: (cwd, ref) =>
      requireSuccess("head", cwd, ["rev-parse", ref ?? "HEAD"]).pipe(
        Effect.map((output) => output.stdout.trim()),
      ),
    commitsAhead: ({ repositoryPath, baseBranch, branch }) =>
      Effect.gen(function* () {
        const exists = yield* run("branchExists", repositoryPath, [
          "show-ref",
          "--verify",
          "--quiet",
          `refs/heads/${branch}`,
        ]);
        if (exists.exitCode !== 0) return 0;
        const ahead = yield* run("commitsAhead", repositoryPath, [
          "rev-list",
          "--count",
          `${baseBranch}..${branch}`,
        ]);
        return ahead.exitCode === 0 ? Number.parseInt(ahead.stdout.trim(), 10) || 0 : 0;
      }),
    changedFiles: ({ repositoryPath, baseBranch, branch }) =>
      requireSuccess("changedFiles", repositoryPath, [
        "diff",
        "--name-only",
        `${baseBranch}...${branch}`,
      ]).pipe(
        Effect.map((output) =>
          output.stdout
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line.length > 0),
        ),
      ),
    resetHard: (cwd, ref) =>
      requireSuccess("resetHard", cwd, ["reset", "--hard", ref]).pipe(Effect.asVoid),
    clean: (cwd) => requireSuccess("clean", cwd, ["clean", "-fdx"]).pipe(Effect.asVoid),
    setupWorktree: input.setupWorktree,
    trialMerge: ({ cwd, branch, message }) =>
      Effect.gen(function* () {
        const merge = yield* run("trialMerge", cwd, [
          ...RERERE_MERGE_FLAGS,
          "merge",
          "--no-ff",
          branch,
          "-m",
          message,
        ]);
        if (merge.exitCode === 0) return { merged: true, output: outputDetail(merge) };
        return yield* completeRerereMerge(cwd, merge);
      }),
    conflictDetail: ({ cwd, maxOutputBytes }) =>
      Effect.gen(function* () {
        const files = yield* run("conflictFiles", cwd, ["diff", "--name-only", "--diff-filter=U"]);
        if (files.exitCode !== 0) return null;
        const diff = yield* input.git.execute({
          operation: "EpicRunner.merge.conflictDiff",
          cwd,
          args: ["diff", "--diff-filter=U"],
          allowNonZeroExit: true,
          maxOutputBytes,
          appendTruncationMarker: true,
        });
        return {
          files: files.stdout
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line.length > 0),
          diff: diff.exitCode === 0 ? diff.stdout.trim() : "",
        };
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logDebug("epic.runner.conflict-detail-failed", { cwd, cause }).pipe(
            Effect.as(null),
          ),
        ),
      ),
    landedSubjects: ({ repositoryPath, baseBranch, branch, limit }) =>
      run("landedSubjects", repositoryPath, [
        "log",
        "--format=%s",
        `--max-count=${String(limit)}`,
        `${branch}..${baseBranch}`,
      ]).pipe(
        Effect.map((output) =>
          output.exitCode === 0
            ? output.stdout
                .split("\n")
                .map((line) => line.trim())
                .filter((line) => line.length > 0)
            : null,
        ),
        Effect.catchCause((cause) =>
          Effect.logDebug("epic.runner.landed-subjects-failed", {
            repositoryPath,
            branch,
            cause,
          }).pipe(Effect.as(null)),
        ),
      ),
    abortMerge: (cwd) =>
      requireSuccess("abortMerge", cwd, ["merge", "--abort"]).pipe(Effect.asVoid),
    fastForward: ({ cwd, ref, branch }) =>
      // `branch` takes the ref-only path (t3code-5m4): a local `fetch`
      // fast-forwards `branch` without touching `cwd`'s working tree, and git
      // itself refuses it if `branch` turns out to be checked out anywhere.
      (branch === undefined
        ? run("fastForward", cwd, ["merge", "--ff-only", ref])
        : run("fastForwardRef", cwd, ["fetch", ".", `${ref}:${branch}`])
      ).pipe(
        Effect.map((output) => ({
          landed: output.exitCode === 0,
          output: outputDetail(output),
        })),
      ),
    push: ({ cwd, remote, refspec }) =>
      run("push", cwd, ["push", remote, refspec]).pipe(
        Effect.map((output) => ({
          pushed: output.exitCode === 0,
          output: outputDetail(output),
        })),
      ),
    deleteLocalBranch: (cwd, branch) =>
      requireSuccess("deleteLocalBranch", cwd, ["branch", "-D", branch]).pipe(Effect.asVoid),
    deleteRemoteBranch: (cwd, remote, branch) =>
      requireSuccess("deleteRemoteBranch", cwd, ["push", remote, "--delete", branch]).pipe(
        Effect.asVoid,
      ),
  };
};
