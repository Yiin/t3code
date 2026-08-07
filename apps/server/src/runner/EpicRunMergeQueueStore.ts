import { EpicRunId } from "@t3tools/contracts";
import type { MergeQueueStoreShape } from "@t3tools/epic-core/ports/MergeQueue";
import { MergeQueuePortError } from "@t3tools/epic-core/ports/MergeQueue";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { EpicRunStoreShape } from "../persistence/Services/EpicRuns.ts";

const mapStoreError = (operation: string) => (cause: unknown) =>
  new MergeQueuePortError({
    operation,
    detail: `Epic run merge persistence failed: ${operation}`,
    cause,
  });

export const makeEpicRunMergeQueueStore = (store: EpicRunStoreShape): MergeQueueStoreShape => ({
  read: (runId) =>
    store.getMergeState({ runId: EpicRunId.make(runId) }).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new MergeQueuePortError({
                operation: "read",
                detail: `Merge state does not exist for ${runId}`,
              }),
            ),
          onSome: Effect.succeed,
        }),
      ),
      Effect.mapError(mapStoreError("read")),
    ),
  beginDrain: (runId) =>
    store
      .beginMergeDrain({ runId: EpicRunId.make(runId) })
      .pipe(Effect.mapError(mapStoreError("beginDrain"))),
  enqueue: ({ runId, ...input }) =>
    store
      .enqueueMerge({ runId: EpicRunId.make(runId), ...input })
      .pipe(Effect.mapError(mapStoreError("enqueue"))),
  restoreTail: ({ runId, ...input }) =>
    store
      .restoreMergeTail({ runId: EpicRunId.make(runId), ...input })
      .pipe(Effect.mapError(mapStoreError("restoreTail"))),
  beginPark: ({ runId, ...input }) =>
    store
      .beginParkMerge({ runId: EpicRunId.make(runId), ...input })
      .pipe(Effect.mapError(mapStoreError("beginPark"))),
  finalizePark: ({ runId, ...input }) =>
    store
      .finalizeParkMerge({ runId: EpicRunId.make(runId), ...input })
      .pipe(Effect.mapError(mapStoreError("finalizePark"))),
  complete: ({ runId, ...input }) =>
    store
      .completeMerge({ runId: EpicRunId.make(runId), ...input })
      .pipe(Effect.mapError(mapStoreError("complete"))),
  drop: ({ runId, ...input }) =>
    store
      .dropMerge({ runId: EpicRunId.make(runId), ...input })
      .pipe(Effect.mapError(mapStoreError("drop"))),
  parkedOriginalChild: (runId, branch) =>
    store
      .findParkedOriginalChild({ runId: EpicRunId.make(runId), branch })
      .pipe(Effect.mapError(mapStoreError("parkedOriginalChild"))),
});
