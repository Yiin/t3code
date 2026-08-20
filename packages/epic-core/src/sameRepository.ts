// @effect-diagnostics nodeBuiltinImport:off globalErrorInEffectFailure:off
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as NodeFSP from "node:fs/promises";

import { ProcessRunner } from "./processRunner.ts";

const GIT_TIMEOUT = Duration.seconds(5);

/** Return true only when both paths resolve to the same Git common directory. */
export const sameRepository = Effect.fn("sameRepository")(function* (
  firstCwd: string,
  secondCwd: string,
) {
  const runner = yield* ProcessRunner;

  const resolveCommonDirectory = (cwd: string) =>
    runner
      .run({
        command: "git",
        args: ["rev-parse", "--path-format=absolute", "--git-common-dir"],
        cwd,
        timeout: GIT_TIMEOUT,
      })
      .pipe(
        Effect.flatMap((result) => {
          const commonDirectory = result.stdout.trim();
          return result.code === 0 && commonDirectory !== ""
            ? Effect.tryPromise(() => NodeFSP.realpath(commonDirectory))
            : Effect.fail(new Error("Git common directory was not resolved."));
        }),
      );

  return yield* Effect.all([
    resolveCommonDirectory(firstCwd),
    resolveCommonDirectory(secondCwd),
  ]).pipe(
    Effect.map(([first, second]) => first === second),
    Effect.orElseSucceed(() => false),
  );
});
