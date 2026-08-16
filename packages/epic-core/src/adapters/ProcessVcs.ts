// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";

import { ProcessRunner, type ProcessRunOutput } from "../processRunner.ts";
import { VcsError, type MergeRepositoryResult, type VcsShape } from "../ports/Vcs.ts";

const combinedOutput = (output: ProcessRunOutput): string =>
  [output.stdout, output.stderr]
    .filter((part) => part.length > 0)
    .join("\n")
    .trim();

export const makeProcessVcs = (input: {
  readonly processRunner: ProcessRunner["Service"];
}): VcsShape => {
  const run = Effect.fn("ProcessVcs.run")(function* (command: {
    readonly operation: string;
    readonly repositoryPath: string;
    readonly args: ReadonlyArray<string>;
  }) {
    return yield* input.processRunner
      .run({
        command: "git",
        args: command.args,
        cwd: command.repositoryPath,
        maxOutputBytes: 1024 * 1024,
        outputMode: "truncate",
        truncatedMarker: "\n[output truncated]",
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new VcsError({
              operation: command.operation,
              repositoryPath: command.repositoryPath,
              detail: "Could not run git",
              cause,
            }),
        ),
      );
  });

  const requireSuccess = Effect.fn("ProcessVcs.requireSuccess")(function* (command: {
    readonly operation: string;
    readonly repositoryPath: string;
    readonly args: ReadonlyArray<string>;
  }) {
    const output = yield* run(command);
    if (output.code !== 0) {
      return yield* new VcsError({
        operation: command.operation,
        repositoryPath: command.repositoryPath,
        detail: combinedOutput(output) || `git exited with code ${String(output.code)}`,
      });
    }
    return output;
  });

  const headCommit: VcsShape["headCommit"] = Effect.fn("ProcessVcs.headCommit")(
    function* (repository) {
      const output = yield* run({
        operation: "headCommit",
        repositoryPath: repository.repositoryPath,
        args: ["rev-parse", "--verify", "-q", "HEAD"],
      });
      if (output.code !== 0) return null;
      const commit = output.stdout.trim();
      return commit.length === 0 ? null : commit;
    },
  );

  const currentBranch: VcsShape["currentBranch"] = Effect.fn("ProcessVcs.currentBranch")(
    function* (repositoryPath) {
      const output = yield* run({
        operation: "currentBranch",
        repositoryPath,
        args: ["symbolic-ref", "--short", "HEAD"],
      });
      if (output.code !== 0) return null;
      const branch = output.stdout.trim();
      return branch.length === 0 ? null : branch;
    },
  );

  const worktreeFingerprint: VcsShape["worktreeFingerprint"] = (repository) =>
    run({
      operation: "worktreeFingerprint",
      repositoryPath: repository.repositoryPath,
      args: ["status", "--porcelain=v1"],
    }).pipe(Effect.map((output) => (output.code === 0 ? output.stdout : null)));

  const createWorktree: VcsShape["createWorktree"] = Effect.fn("ProcessVcs.createWorktree")(
    function* ({ repositoryPath, worktreeRoot, branch, startPoint }) {
      const worktreePath = NodePath.join(worktreeRoot, branch.replaceAll("/", "-"));
      yield* requireSuccess({
        operation: "createWorktree",
        repositoryPath,
        args: ["worktree", "add", "-b", branch, worktreePath, startPoint],
      });
      return { repositoryPath, worktreePath, branch };
    },
  );

  const removeWorktree: VcsShape["removeWorktree"] = ({ repositoryPath, worktreePath }) =>
    requireSuccess({
      operation: "removeWorktree",
      repositoryPath,
      args: ["worktree", "remove", "--force", worktreePath],
    }).pipe(Effect.asVoid);

  const trialMerge: VcsShape["trialMerge"] = Effect.fn("ProcessVcs.trialMerge")(function* ({
    repositories,
  }) {
    const results: MergeRepositoryResult[] = [];
    for (const { repositoryPath, commit } of repositories) {
      const output = yield* run({
        operation: "trialMerge",
        repositoryPath,
        args: ["merge", "--no-ff", commit, "-m", `cook-epic: trial merge ${commit}`],
      });
      if (output.code === 0) {
        results.push({ repositoryPath, passed: true, output: combinedOutput(output) });
        continue;
      }

      const abort = yield* run({
        operation: "trialMerge.abort",
        repositoryPath,
        args: ["merge", "--abort"],
      });
      if (abort.code !== 0) {
        return yield* new VcsError({
          operation: "trialMerge.abort",
          repositoryPath,
          detail:
            combinedOutput(abort) || `git merge --abort exited with code ${String(abort.code)}`,
        });
      }
      results.push({ repositoryPath, passed: false, output: combinedOutput(output) });
      return { passed: false, repositories: results };
    }
    return { passed: true, repositories: results };
  });

  const landFastForward: VcsShape["landFastForward"] = Effect.fn("ProcessVcs.landFastForward")(
    function* ({ repositories }) {
      const landed: Array<{ readonly repositoryPath: string }> = [];
      for (const { repositoryPath, commit } of repositories) {
        yield* requireSuccess({
          operation: "landFastForward",
          repositoryPath,
          args: ["merge", "--ff-only", commit],
        });
        landed.push({ repositoryPath });
      }
      return { repositories: landed };
    },
  );

  const push: VcsShape["push"] = ({ repositoryPath, remote, refspec }) =>
    requireSuccess({
      operation: "push",
      repositoryPath,
      args: ["push", remote, refspec],
    }).pipe(Effect.asVoid);

  const commitsAhead: VcsShape["commitsAhead"] = ({ cwd, base, branch }) =>
    run({
      operation: "commitsAhead",
      repositoryPath: cwd,
      args: ["rev-list", "--count", `${base}..${branch}`],
    }).pipe(
      Effect.map((output) => {
        if (output.code !== 0) return null;
        const count = Number.parseInt(output.stdout.trim(), 10);
        return Number.isSafeInteger(count) && count >= 0 ? count : null;
      }),
      Effect.catchCause(() => Effect.succeed(null)),
    );

  const commitsByCommitter: VcsShape["commitsByCommitter"] = ({ cwd, from, to }) =>
    run({
      operation: "commitsByCommitter",
      repositoryPath: cwd,
      args: ["log", "--format=%cE", `${from}..${to}`],
    }).pipe(
      Effect.map((output) =>
        output.code === 0
          ? output.stdout
              .split("\n")
              .map((line) => line.trim())
              .filter((line) => line.length > 0)
          : null,
      ),
      Effect.catchCause((cause) =>
        Effect.logDebug("epic.runner.committer-log-read-failed", { cwd, from, to, cause }).pipe(
          Effect.as(null),
        ),
      ),
    );

  return {
    headCommit,
    currentBranch,
    commitsAhead,
    commitsByCommitter,
    worktreeFingerprint,
    createWorktree,
    removeWorktree,
    trialMerge,
    landFastForward,
    push,
  };
};

export const make = Effect.fn("ProcessVcs.make")(function* () {
  const processRunner = yield* ProcessRunner;
  return makeProcessVcs({ processRunner });
});
