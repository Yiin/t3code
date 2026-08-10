import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

import { ProcessRunner, type ProcessRunOutput } from "../processRunner.ts";
import { MergeQueuePortError, type MergeGitShape } from "../ports/MergeQueue.ts";

const outputDetail = (output: ProcessRunOutput): string =>
  [output.stdout, output.stderr]
    .filter((part) => part.length > 0)
    .join("\n")
    .trim();

/** Process adapter for the single-repository landing operations in `run-legacy.sh:2893-3069`. */
export const makeProcessMergeGit = (input: {
  readonly processRunner: ProcessRunner["Service"];
  readonly setupWorktree?: (cwd: string) => Effect.Effect<void, MergeQueuePortError>;
}): MergeGitShape => {
  const mutexes = new Map<string, Semaphore.Semaphore>();
  const mutexFor = (repositoryPath: string): Semaphore.Semaphore => {
    const found = mutexes.get(repositoryPath);
    if (found !== undefined) return found;
    const created = Semaphore.makeUnsafe(1);
    mutexes.set(repositoryPath, created);
    return created;
  };

  const run = Effect.fn("ProcessMergeGit.run")(function* (command: {
    readonly operation: string;
    readonly cwd: string;
    readonly args: ReadonlyArray<string>;
  }) {
    return yield* input.processRunner
      .run({
        command: "git",
        args: command.args,
        cwd: command.cwd,
        maxOutputBytes: 1024 * 1024,
        outputMode: "truncate",
        truncatedMarker: "\n[output truncated]",
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new MergeQueuePortError({
              operation: command.operation,
              detail: `Could not run git in ${command.cwd}`,
              cause,
            }),
        ),
      );
  });

  const mutationKey = (cwd: string) =>
    run({
      operation: "gitCommonDirectory",
      cwd,
      args: ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    }).pipe(
      Effect.flatMap((output) =>
        output.code === 0 && output.stdout.trim().length > 0
          ? Effect.succeed(output.stdout.trim())
          : Effect.fail(
              new MergeQueuePortError({
                operation: "gitCommonDirectory",
                detail: outputDetail(output) || "Could not resolve the Git common directory",
              }),
            ),
      ),
    );

  const mutate = <A>(
    cwd: string,
    effect: Effect.Effect<A, MergeQueuePortError>,
  ): Effect.Effect<A, MergeQueuePortError> =>
    mutationKey(cwd).pipe(
      Effect.flatMap((commonDirectory) => mutexFor(commonDirectory).withPermits(1)(effect)),
    );

  const requireSuccess = Effect.fn("ProcessMergeGit.requireSuccess")(function* (command: {
    readonly operation: string;
    readonly cwd: string;
    readonly args: ReadonlyArray<string>;
  }) {
    const output = yield* run(command);
    if (output.code !== 0) {
      return yield* new MergeQueuePortError({
        operation: command.operation,
        detail: outputDetail(output) || `git exited with code ${String(output.code)}`,
      });
    }
    return output;
  });

  return {
    head: (cwd, ref) =>
      requireSuccess({ operation: "head", cwd, args: ["rev-parse", ref ?? "HEAD"] }).pipe(
        Effect.map((output) => output.stdout.trim()),
      ),
    commitsAhead: ({ repositoryPath, baseBranch, branch }) =>
      // Terminal parity: `skills/cook-epic/run-legacy.sh:2926-2934`.
      Effect.gen(function* () {
        const exists = yield* run({
          operation: "branchExists",
          cwd: repositoryPath,
          args: ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
        });
        if (exists.code !== 0) return 0;
        const ahead = yield* run({
          operation: "commitsAhead",
          cwd: repositoryPath,
          args: ["rev-list", "--count", `${baseBranch}..${branch}`],
        });
        return ahead.code === 0 ? Number.parseInt(ahead.stdout.trim(), 10) || 0 : 0;
      }),
    resetHard: (cwd, ref) =>
      // Terminal parity: `skills/cook-epic/run-legacy.sh:2942-2946`.
      mutate(
        cwd,
        requireSuccess({ operation: "resetHard", cwd, args: ["reset", "--hard", ref] }).pipe(
          Effect.asVoid,
        ),
      ),
    clean: (cwd) =>
      // Terminal parity: `skills/cook-epic/run-legacy.sh:2945`.
      mutate(
        cwd,
        requireSuccess({ operation: "clean", cwd, args: ["clean", "-fdx"] }).pipe(Effect.asVoid),
      ),
    setupWorktree: input.setupWorktree ?? (() => Effect.void),
    trialMerge: ({ cwd, branch, message }) =>
      // Exact message parity: `skills/cook-epic/run-legacy.sh:2958`.
      mutate(
        cwd,
        run({ operation: "trialMerge", cwd, args: ["merge", "--no-ff", branch, "-m", message] }),
      ).pipe(Effect.map((output) => ({ merged: output.code === 0, output: outputDetail(output) }))),
    abortMerge: (cwd) =>
      mutate(
        cwd,
        requireSuccess({ operation: "abortMerge", cwd, args: ["merge", "--abort"] }).pipe(
          Effect.asVoid,
        ),
      ),
    fastForward: ({ cwd, ref, branch }) =>
      // Terminal parity: `skills/cook-epic/run-legacy.sh:2992-3000`. `branch`
      // takes the ref-only path (t3code-5m4): a local `fetch` fast-forwards
      // `branch` without touching `cwd`'s working tree, and git itself refuses
      // it if `branch` turns out to be checked out anywhere.
      mutate(
        cwd,
        branch === undefined
          ? run({ operation: "fastForward", cwd, args: ["merge", "--ff-only", ref] })
          : run({ operation: "fastForwardRef", cwd, args: ["fetch", ".", `${ref}:${branch}`] }),
      ).pipe(Effect.map((output) => ({ landed: output.code === 0, output: outputDetail(output) }))),
    push: ({ cwd, remote, refspec }) =>
      // Terminal parity: `skills/cook-epic/run-legacy.sh:3014-3021`.
      mutate(cwd, run({ operation: "push", cwd, args: ["push", remote, refspec] })).pipe(
        Effect.map((output) => ({ pushed: output.code === 0, output: outputDetail(output) })),
      ),
    deleteLocalBranch: (cwd, branch) =>
      // Terminal parity: `skills/cook-epic/run-legacy.sh:3064`.
      mutate(
        cwd,
        requireSuccess({
          operation: "deleteLocalBranch",
          cwd,
          args: ["branch", "-D", branch],
        }).pipe(Effect.asVoid),
      ),
    deleteRemoteBranch: (cwd, remote, branch) =>
      // Terminal parity: `skills/cook-epic/run-legacy.sh:3065`.
      mutate(
        cwd,
        requireSuccess({
          operation: "deleteRemoteBranch",
          cwd,
          args: ["push", remote, "--delete", branch],
        }).pipe(Effect.asVoid),
      ),
  };
};

export const make = Effect.fn("ProcessMergeGit.make")(function* () {
  const processRunner = yield* ProcessRunner;
  return makeProcessMergeGit({ processRunner });
});
