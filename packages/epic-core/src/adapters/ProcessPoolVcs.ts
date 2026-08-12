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

/** How much of one evidence probe reaches the prompt before it is cut. */
const EVIDENCE_LIMIT = 4_000;

/** One probe's output, bounded and never silently empty. */
const section = (output: string | null): string => {
  if (output === null) return "(unavailable)";
  const trimmed = output.trimEnd();
  if (trimmed.length === 0) return "(nothing)";
  return trimmed.length > EVIDENCE_LIMIT
    ? `${trimmed.slice(0, EVIDENCE_LIMIT)}\n… (truncated)`
    : trimmed;
};

export const makeProcessPoolVcs = (
  processRunner: ProcessRunner.ProcessRunner["Service"],
): PoolVcsShape => ({
  /**
   * The repo's `HEAD` (or `ref`, when given), or `null` when it cannot be read
   * (no repo, no commits, git missing). `null` never counts as movement,
   * mirroring terminal ralph's `head_after != none` guard
   * (`run-legacy.sh:155`). Pass `ref` to resolve a branch that is not
   * checked out at `cwd` — a run-owned base branch (t3code-5m4).
   */
  headCommit: (cwd: string, ref?: string) =>
    processRunner
      .run({
        command: "git",
        args: ["rev-parse", "--verify", "-q", ref ?? "HEAD"],
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

  /**
   * `git status --porcelain=v1` plus `git diff --stat`, each bounded, for a
   * resumed worker's prompt. A probe that fails contributes an explicit
   * "unavailable" line; `null` only when neither command produced anything.
   * Gathering evidence must never fail a resume.
   */
  worktreeEvidence: (cwd: string) =>
    Effect.gen(function* () {
      const probe = (args: ReadonlyArray<string>) =>
        processRunner.run({ command: "git", args: [...args], cwd, timeout: GIT_HEAD_TIMEOUT }).pipe(
          Effect.map((output) => (output.code === 0 ? output.stdout : null)),
          Effect.catchCause((cause) =>
            Effect.logDebug("epic.runner.worktree-evidence-failed", { cwd, args, cause }).pipe(
              Effect.as(null),
            ),
          ),
        );
      const status = yield* probe(["status", "--porcelain=v1"]);
      const diff = yield* probe(["diff", "--stat"]);
      if (status === null && diff === null) return null;
      return [
        `$ git status --porcelain=v1\n${section(status)}`,
        `$ git diff --stat\n${section(diff)}`,
      ].join("\n\n");
    }),

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
