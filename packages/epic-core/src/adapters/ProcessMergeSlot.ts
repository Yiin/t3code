import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { ProcessRunner } from "../processRunner.ts";
import { MergeQueuePortError, type MergeSlotShape } from "../ports/MergeQueue.ts";

const isMergeQueuePortError = Schema.is(MergeQueuePortError);

/** Nonblocking bd merge-slot adapter. Terminal parity: `run.sh:3078-3084,3234`. */
export const makeProcessMergeSlot = (input: {
  readonly repositoryPath: string;
  readonly processRunner: ProcessRunner["Service"];
}): MergeSlotShape => ({
  tryAcquire: (holder) =>
    input.processRunner
      .run({
        command: "bd",
        args: ["merge-slot", "acquire", "--holder", holder],
        cwd: input.repositoryPath,
      })
      .pipe(
        Effect.map((output) =>
          output.code === 0 ? Option.some({ holder }) : Option.none<{ readonly holder: string }>(),
        ),
        Effect.mapError(
          (cause) =>
            new MergeQueuePortError({
              operation: "mergeSlot.acquire",
              detail: "Could not run bd merge-slot acquire",
              cause,
            }),
        ),
      ),
  release: (holder) =>
    input.processRunner
      .run({
        command: "bd",
        args: ["merge-slot", "release", "--holder", holder],
        cwd: input.repositoryPath,
      })
      .pipe(
        Effect.flatMap((output) =>
          output.code === 0
            ? Effect.void
            : Effect.fail(
                new MergeQueuePortError({
                  operation: "mergeSlot.release",
                  detail: output.stderr.trim() || `bd exited with code ${String(output.code)}`,
                }),
              ),
        ),
        Effect.mapError((cause) =>
          isMergeQueuePortError(cause)
            ? cause
            : new MergeQueuePortError({
                operation: "mergeSlot.release",
                detail: "Could not run bd merge-slot release",
                cause,
              }),
        ),
      ),
});

export const make = Effect.fn("ProcessMergeSlot.make")(function* (input: {
  readonly repositoryPath: string;
}) {
  const processRunner = yield* ProcessRunner;
  return makeProcessMergeSlot({ ...input, processRunner });
});
