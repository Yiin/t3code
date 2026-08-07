import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { ProcessRunner, type ProcessRunInput, type ProcessRunOutput } from "../processRunner.ts";
import { makeProcessVcs } from "./ProcessVcs.ts";

const output = (stdout = "", code = 0): ProcessRunOutput => ({
  stdout,
  stderr: code === 0 ? "" : "conflict",
  code: code as ProcessRunOutput["code"],
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
});

describe("ProcessVcs", () => {
  it.effect("uses the git command contract for repository operations", () =>
    Effect.gen(function* () {
      const calls: ProcessRunInput[] = [];
      let mergeAttempts = 0;
      const processRunner = ProcessRunner.of({
        run: (command) =>
          Effect.sync(() => {
            calls.push(command);
            if (command.args[0] === "rev-parse") return output("abc123\n");
            if (command.args[0] === "status") return output(" M file.ts\n");
            if (command.args[0] === "merge" && command.args[1] === "--ff-only") return output();
            if (command.args[0] === "merge" && command.args[1] !== "--abort") {
              mergeAttempts += 1;
              return output("", mergeAttempts === 1 ? 0 : 1);
            }
            return output();
          }),
      });
      const vcs = makeProcessVcs({ processRunner });
      const repository = {
        repositoryPath: "/repo",
        baseBranch: "mine",
        worktreeRoot: "/worktrees",
        siblings: [],
      } as const;

      expect(yield* vcs.headCommit(repository)).toBe("abc123");
      expect(yield* vcs.worktreeFingerprint(repository)).toBe(" M file.ts\n");
      expect(
        yield* vcs.createWorktree({
          repositoryPath: "/repo",
          worktreeRoot: "/worktrees",
          branch: "epic/child",
          startPoint: "mine",
        }),
      ).toEqual({
        repositoryPath: "/repo",
        worktreePath: "/worktrees/epic-child",
        branch: "epic/child",
      });
      yield* vcs.removeWorktree({ repositoryPath: "/repo", worktreePath: "/worktrees/wt" });
      expect(
        yield* vcs.trialMerge({
          repositories: [
            { repositoryPath: "/trial", commit: "epic/child" },
            { repositoryPath: "/sibling-trial", commit: "bad" },
          ],
        }),
      ).toEqual({
        passed: false,
        repositories: [
          { repositoryPath: "/trial", passed: true, output: "" },
          { repositoryPath: "/sibling-trial", passed: false, output: "conflict" },
        ],
      });
      expect(
        yield* vcs.landFastForward({
          repositories: [
            { repositoryPath: "/repo", commit: "trial-head" },
            { repositoryPath: "/sibling", commit: "sibling-trial-head" },
          ],
        }),
      ).toEqual({
        repositories: [{ repositoryPath: "/repo" }, { repositoryPath: "/sibling" }],
      });
      yield* vcs.push({ repositoryPath: "/repo", remote: "origin", refspec: "mine" });

      expect(calls.map(({ args, cwd }) => ({ args, cwd }))).toEqual([
        { args: ["rev-parse", "--verify", "-q", "HEAD"], cwd: "/repo" },
        { args: ["status", "--porcelain=v1"], cwd: "/repo" },
        {
          args: ["worktree", "add", "-b", "epic/child", "/worktrees/epic-child", "mine"],
          cwd: "/repo",
        },
        { args: ["worktree", "remove", "--force", "/worktrees/wt"], cwd: "/repo" },
        {
          args: ["merge", "--no-ff", "epic/child", "-m", "cook-epic: trial merge epic/child"],
          cwd: "/trial",
        },
        {
          args: ["merge", "--no-ff", "bad", "-m", "cook-epic: trial merge bad"],
          cwd: "/sibling-trial",
        },
        { args: ["merge", "--abort"], cwd: "/sibling-trial" },
        { args: ["merge", "--ff-only", "trial-head"], cwd: "/repo" },
        { args: ["merge", "--ff-only", "sibling-trial-head"], cwd: "/sibling" },
        { args: ["push", "origin", "mine"], cwd: "/repo" },
      ]);
    }),
  );

  it.effect("fails when a conflicted merge cannot be aborted", () =>
    Effect.gen(function* () {
      const processRunner = ProcessRunner.of({ run: () => Effect.succeed(output("", 1)) });
      const vcs = makeProcessVcs({ processRunner });

      const error = yield* vcs
        .trialMerge({ repositories: [{ repositoryPath: "/trial", commit: "bad" }] })
        .pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "VcsError",
        operation: "trialMerge.abort",
        repositoryPath: "/trial",
      });
    }),
  );
});
