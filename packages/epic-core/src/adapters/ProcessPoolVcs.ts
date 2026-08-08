/**
 * Never-failing git probes for the pool loop, over a {@link ProcessRunner};
 * `null` never counts as progress. Shared by the server runner
 * (`EpicRunnerPoolPorts.ts`) and the terminal `t3 epic cook` entry.
 */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

import type { PoolVcsShape } from "../ParallelEpicLoop.ts";
import type * as ProcessRunner from "../processRunner.ts";

const GIT_HEAD_TIMEOUT = Duration.seconds(15);

export const makeProcessPoolVcs = (
  processRunner: ProcessRunner.ProcessRunner["Service"],
): PoolVcsShape => ({
  /**
   * The repo's `HEAD`, or `null` when it cannot be read (no repo, no commits,
   * git missing). `null` never counts as movement, mirroring terminal ralph's
   * `head_after != none` guard (`run-legacy.sh:155`).
   */
  headCommit: (cwd: string) =>
    processRunner
      .run({
        command: "git",
        args: ["rev-parse", "--verify", "-q", "HEAD"],
        cwd,
        timeout: GIT_HEAD_TIMEOUT,
      })
      .pipe(
        Effect.map((output) => {
          const sha = output.stdout.trim();
          return output.code === 0 && sha.length > 0 ? sha : null;
        }),
        Effect.catchCause((cause) =>
          Effect.logDebug("epic.runner.head-read-failed", { cwd, cause }).pipe(Effect.as(null)),
        ),
      ),

  /**
   * The repo's current porcelain status, verbatim, or `null` when git cannot
   * read it. Empty stdout is a valid clean-worktree fingerprint. `null`
   * never counts as progress.
   */
  worktreeFingerprint: (cwd: string) =>
    processRunner
      .run({
        command: "git",
        args: ["status", "--porcelain=v1"],
        cwd,
        timeout: GIT_HEAD_TIMEOUT,
      })
      .pipe(
        Effect.map((output) => (output.code === 0 ? output.stdout : null)),
        Effect.catchCause((cause) =>
          Effect.logDebug("epic.runner.worktree-read-failed", { cwd, cause }).pipe(Effect.as(null)),
        ),
      ),

  commitsAhead: (input) =>
    processRunner
      .run({
        command: "git",
        args: ["rev-list", "--count", `${input.base}..${input.branch}`],
        cwd: input.cwd,
        timeout: GIT_HEAD_TIMEOUT,
      })
      .pipe(
        Effect.map((output) =>
          output.code === 0 ? Number.parseInt(output.stdout.trim(), 10) : null,
        ),
        Effect.catchCause((cause) =>
          Effect.logDebug("epic.runner.branch-commit-read-failed", {
            cwd: input.cwd,
            branch: input.branch,
            cause,
          }).pipe(Effect.as(null)),
        ),
      ),
});
