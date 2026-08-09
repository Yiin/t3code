import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { ProcessRunner } from "../processRunner.ts";
import { MergeQueuePortError, type MergeSlotShape } from "../ports/MergeQueue.ts";

const isMergeQueuePortError = Schema.is(MergeQueuePortError);

/**
 * `bd merge-slot check --json`. `holder` is null while the slot is free.
 *
 * Decoded rather than read loosely: `reclaim` releases a lock on the strength
 * of this one field, so output it cannot understand has to read as "not ours"
 * and leave the slot alone.
 */
const MergeSlotStatus = Schema.Struct({
  available: Schema.Boolean,
  holder: Schema.NullOr(Schema.String),
});

const decodeMergeSlotStatus = Schema.decodeUnknownOption(MergeSlotStatus);

const parseJson = (text: string): Option.Option<unknown> => {
  try {
    return Option.some(JSON.parse(text) as unknown);
  } catch {
    return Option.none();
  }
};

/** Nonblocking bd merge-slot adapter. Terminal parity: `run-legacy.sh:2912-2918,3234`. */
export const makeProcessMergeSlot = (input: {
  readonly repositoryPath: string;
  readonly processRunner: ProcessRunner["Service"];
}): MergeSlotShape => {
  const bd = (operation: string, args: ReadonlyArray<string>) =>
    input.processRunner
      .run({
        command: "bd",
        args: ["merge-slot", ...args],
        cwd: input.repositoryPath,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new MergeQueuePortError({
              operation,
              detail: `Could not run bd merge-slot ${args[0] ?? ""}`.trimEnd(),
              cause,
            }),
        ),
      );

  const release: MergeSlotShape["release"] = (holder) =>
    bd("mergeSlot.release", ["release", "--holder", holder]).pipe(
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
    );

  /** Who holds the slot, or `None` when it is free, missing, or unreadable. */
  const heldBy = bd("mergeSlot.check", ["check", "--json"]).pipe(
    Effect.map((output) =>
      output.code === 0
        ? parseJson(output.stdout).pipe(
            Option.flatMap(decodeMergeSlotStatus),
            Option.flatMap((status) =>
              status.available ? Option.none() : Option.fromNullishOr(status.holder),
            ),
          )
        : Option.none<string>(),
    ),
  );

  return {
    tryAcquire: (holder) =>
      bd("mergeSlot.acquire", ["acquire", "--holder", holder]).pipe(
        Effect.map((output) =>
          output.code === 0 ? Option.some({ holder }) : Option.none<{ readonly holder: string }>(),
        ),
      ),
    release,
    holder: heldBy,
    reclaim: (holder) =>
      heldBy.pipe(
        Effect.flatMap(
          (held): Effect.Effect<{ readonly reclaimed: boolean }, MergeQueuePortError> =>
            Option.isSome(held) && held.value === holder
              ? release(holder).pipe(Effect.as({ reclaimed: true }))
              : Effect.succeed({ reclaimed: false }),
        ),
      ),
  };
};

export const make = Effect.fn("ProcessMergeSlot.make")(function* (input: {
  readonly repositoryPath: string;
}) {
  const processRunner = yield* ProcessRunner;
  return makeProcessMergeSlot({ ...input, processRunner });
});
