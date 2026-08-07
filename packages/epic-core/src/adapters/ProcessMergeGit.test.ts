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
