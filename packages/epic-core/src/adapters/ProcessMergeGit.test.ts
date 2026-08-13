import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import { ProcessRunner, type ProcessRunInput, type ProcessRunOutput } from "../processRunner.ts";
import { makeProcessMergeGit } from "./ProcessMergeGit.ts";

const output = (stdout = "", code = 0): ProcessRunOutput => ({
  stdout,
  stderr: "",
  code: code as ProcessRunOutput["code"],
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
});

it.effect("serializes mutations from sibling worktrees by Git common directory", () =>
  Effect.gen(function* () {
    const firstStarted = yield* Deferred.make<void>();
    const releaseFirst = yield* Deferred.make<void>();
    let active = 0;
    let maximumActive = 0;
    let mutations = 0;
    const processRunner = ProcessRunner.of({
      run: (request: ProcessRunInput) =>
        request.args[0] === "rev-parse"
          ? Effect.succeed(output("/repo/.git\n"))
          : Effect.gen(function* () {
              active += 1;
              maximumActive = Math.max(maximumActive, active);
              mutations += 1;
              if (mutations === 1) {
                yield* Deferred.succeed(firstStarted, undefined);
                yield* Deferred.await(releaseFirst);
              }
              active -= 1;
              return output();
            }),
    });
    const git = makeProcessMergeGit({ processRunner });

    const first = yield* git.resetHard("/repo/worktree-a", "mine").pipe(Effect.forkChild);
    yield* Deferred.await(firstStarted);
    const second = yield* git.resetHard("/repo/worktree-b", "mine").pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    expect(mutations).toBe(1);
    yield* Deferred.succeed(releaseFirst, undefined);
    yield* Fiber.join(first);
    yield* Fiber.join(second);

    expect(maximumActive).toBe(1);
    expect(mutations).toBe(2);
  }),
);

it.effect("reads HEAD by default and a named ref when one is supplied", () =>
  Effect.gen(function* () {
    const seen: Array<ReadonlyArray<string>> = [];
    const processRunner = ProcessRunner.of({
      run: (request: ProcessRunInput) => {
        seen.push(request.args);
        return Effect.succeed(output("deadbeef\n"));
      },
    });
    const git = makeProcessMergeGit({ processRunner });

    expect(yield* git.head("/repo")).toBe("deadbeef");
    expect(yield* git.head("/repo", "epic/e1/base")).toBe("deadbeef");
    expect(seen).toEqual([
      ["rev-parse", "HEAD"],
      ["rev-parse", "epic/e1/base"],
    ]);
  }),
);

it.effect("fast-forwards by checkout-based merge without a branch, ref-only fetch with one", () =>
  Effect.gen(function* () {
    const seen: Array<ReadonlyArray<string>> = [];
    const processRunner = ProcessRunner.of({
      run: (request: ProcessRunInput) => {
        if (request.args[0] === "rev-parse") return Effect.succeed(output("/repo/.git\n"));
        seen.push(request.args);
        return Effect.succeed(output());
      },
    });
    const git = makeProcessMergeGit({ processRunner });

    expect(
      (yield* git.fastForward({ cwd: "/repo", ref: "cook-epic-integration-run-1" })).landed,
    ).toBe(true);
    expect(
      (yield* git.fastForward({
        cwd: "/repo",
        ref: "cook-epic-integration-run-1",
        branch: "epic/e1/base",
      })).landed,
    ).toBe(true);
    expect(seen).toEqual([
      ["merge", "--ff-only", "cook-epic-integration-run-1"],
      ["fetch", ".", "cook-epic-integration-run-1:epic/e1/base"],
    ]);
  }),
);

it.effect("carries rerere flags on the trial merge and reports a clean merge unchanged", () =>
  Effect.gen(function* () {
    const seen: Array<ReadonlyArray<string>> = [];
    const processRunner = ProcessRunner.of({
      run: (request: ProcessRunInput) => {
        if (request.args[0] === "rev-parse") return Effect.succeed(output("/repo/.git\n"));
        seen.push(request.args);
        return Effect.succeed(output("Merge made by the 'ort' strategy.\n"));
      },
    });
    const git = makeProcessMergeGit({ processRunner });

    const result = yield* git.trialMerge({
      cwd: "/repo/integration",
      branch: "epic/child-1",
      message: "merge child-1",
    });

    expect(result.merged).toBe(true);
    expect(seen).toEqual([
      [
        "-c",
        "rerere.enabled=true",
        "-c",
        "rerere.autoUpdate=true",
        "merge",
        "--no-ff",
        "epic/child-1",
        "-m",
        "merge child-1",
      ],
    ]);
  }),
);

it.effect("commits a conflicted merge that rerere resolved down to zero unmerged paths", () =>
  Effect.gen(function* () {
    const seen: Array<ReadonlyArray<string>> = [];
    const processRunner = ProcessRunner.of({
      run: (request: ProcessRunInput) => {
        if (request.args[0] === "rev-parse" && request.args[1] === "--path-format=absolute")
          return Effect.succeed(output("/repo/.git\n"));
        seen.push(request.args);
        if (request.args[1] === "rerere.enabled=true")
          return Effect.succeed(output("Automatic merge failed; fix conflicts\n", 1));
        if (request.args[0] === "rev-parse") return Effect.succeed(output("deadbeef\n"));
        if (request.args[0] === "diff") return Effect.succeed(output("\n"));
        return Effect.succeed(output("[integration abc1234] merge child-1\n"));
      },
    });
    const git = makeProcessMergeGit({ processRunner });

    const result = yield* git.trialMerge({
      cwd: "/repo/integration",
      branch: "epic/child-1",
      message: "merge child-1",
    });

    expect(result.merged).toBe(true);
    expect(seen.slice(1)).toEqual([
      ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"],
      ["diff", "--name-only", "--diff-filter=U"],
      ["commit", "--no-verify", "--no-edit", "--cleanup=strip"],
    ]);
  }),
);

for (const leftover of ["src/app.ts\n", ""] as const) {
  it.effect(
    leftover.length > 0
      ? "leaves a merge with unmerged paths parked"
      : "leaves a failed merge with no MERGE_HEAD parked",
    () =>
      Effect.gen(function* () {
        const seen: Array<ReadonlyArray<string>> = [];
        const processRunner = ProcessRunner.of({
          run: (request: ProcessRunInput) => {
            if (request.args[0] === "rev-parse" && request.args[1] === "--path-format=absolute")
              return Effect.succeed(output("/repo/.git\n"));
            seen.push(request.args);
            if (request.args[1] === "rerere.enabled=true")
              return Effect.succeed(output("CONFLICT (content): Merge conflict in src/app.ts", 1));
            if (request.args[0] === "rev-parse")
              return Effect.succeed(leftover.length > 0 ? output("deadbeef\n") : output("", 1));
            return Effect.succeed(output(leftover));
          },
        });
        const git = makeProcessMergeGit({ processRunner });

        const result = yield* git.trialMerge({
          cwd: "/repo/integration",
          branch: "epic/child-1",
          message: "merge child-1",
        });

        expect(result).toEqual({
          merged: false,
          output: "CONFLICT (content): Merge conflict in src/app.ts",
        });
        expect(seen.some((args) => args[0] === "commit")).toBe(false);
      }),
  );
}

for (const failure of ["show-ref", "rev-list"] as const) {
  it.effect(`treats a ${failure} failure as a missing branch`, () =>
    Effect.gen(function* () {
      const processRunner = ProcessRunner.of({
        run: (request: ProcessRunInput) =>
          Effect.succeed(
            request.args[0] === failure
              ? output("", 1)
              : request.args[0] === "show-ref"
                ? output()
                : output("3\n"),
          ),
      });
      const git = makeProcessMergeGit({ processRunner });

      expect(
        yield* git.commitsAhead({
          repositoryPath: "/repo",
          baseBranch: "mine",
          branch: "epic/missing",
        }),
      ).toBe(0);
    }),
  );
}
