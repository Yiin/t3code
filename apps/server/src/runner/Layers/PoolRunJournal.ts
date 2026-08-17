import type { PoolRunJournalShape } from "@t3tools/epic-core/ParallelEpicLoop";
import type {
  PersistedEpicRun,
  PersistedEpicRunIteration,
} from "@t3tools/epic-core/ports/RunJournal";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { EpicRunStore } from "../../persistence/Services/EpicRuns.ts";
import { journalError } from "./poolPortErrors.ts";

export const makeServerPoolJournal = (store: EpicRunStore["Service"]): PoolRunJournalShape => ({
  createRun: (run) => store.upsertRun(run).pipe(Effect.mapError(journalError("createRun"))),
  saveRun: (run) => store.upsertRun(run).pipe(Effect.mapError(journalError("saveRun"))),
  getRun: (runId) =>
    store.getRun({ runId }).pipe(
      Effect.map((run): Option.Option<PersistedEpicRun> => run),
      Effect.mapError(journalError("getRun")),
    ),
  appendIteration: (iteration) => {
    const { headBefore: _headBefore, headAfter: _headAfter, ...row } = iteration;
    return store
      .appendIteration({
        ...row,
        phaseTimings: row.phaseTimings ?? null,
        promptBytes: row.promptBytes ?? null,
      })
      .pipe(Effect.mapError(journalError("appendIteration")));
  },
  allocateIteration: (input) =>
    store.allocateIteration(input).pipe(Effect.mapError(journalError("allocateIteration"))),
  updateIteration: (input) => {
    const { headBefore: _headBefore, headAfter: _headAfter, ...row } = input;
    return store
      .updateIteration({
        ...row,
        phaseTimings: row.phaseTimings ?? null,
        promptBytes: row.promptBytes ?? null,
      })
      .pipe(Effect.mapError(journalError("updateIteration")));
  },
  markIterationResumed: (input) =>
    store.reopenIteration(input).pipe(Effect.mapError(journalError("markIterationResumed"))),
  listIterations: (runId) =>
    store.listIterations({ runId }).pipe(
      Effect.map((rows): ReadonlyArray<PersistedEpicRunIteration> => rows),
      Effect.mapError(journalError("listIterations")),
    ),
  getLatestIteration: (runId) =>
    store.getLatestIteration({ runId }).pipe(
      Effect.map((row): Option.Option<PersistedEpicRunIteration> => row),
      Effect.mapError(journalError("getLatestIteration")),
    ),
  upsertProviderDegradation: (input) =>
    store
      .upsertProviderDegradation(input)
      .pipe(Effect.mapError(journalError("upsertProviderDegradation"))),
  clearProviderDegradation: (input) =>
    store
      .clearProviderDegradation(input)
      .pipe(Effect.mapError(journalError("clearProviderDegradation"))),
});
