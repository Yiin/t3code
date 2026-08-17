import type { EpicRun as TransportEpicRun } from "@t3tools/contracts";
import type { PoolRunEventsShape } from "@t3tools/epic-core/ParallelEpicLoop";
import type {
  EpicRunStore,
  EpicRun,
  EpicRunIteration as EpicRunIterationRow,
} from "../../persistence/Services/EpicRuns.ts";
import type { PubSub } from "effect/PubSub";
import * as Effect from "effect/Effect";
import * as PubSubEffect from "effect/PubSub";
import { storeError } from "./poolPortErrors.ts";

const RECENT_ITERATIONS_LIMIT = 25;

const buildTransportRun = (
  run: EpicRun,
  recentIterations: ReadonlyArray<EpicRunIterationRow>,
): TransportEpicRun => ({
  ...run,
  recentIterations: recentIterations.map((iteration) => ({
    ...iteration,
    workerId: iteration.workerId ?? null,
    branch: iteration.branch ?? null,
    worktreePath: iteration.worktreePath ?? null,
    resumeCount: iteration.resumeCount ?? 0,
    lastResumedAt: iteration.lastResumedAt ?? null,
  })),
  threadRefs: recentIterations.flatMap((iteration) =>
    iteration.issueId === null
      ? []
      : [
          {
            issueId: iteration.issueId,
            threadId: iteration.threadId,
            iterationIndex: iteration.iterationIndex,
          },
        ],
  ),
});

export const makeEpicRunReadModel = (deps: {
  readonly store: EpicRunStore["Service"];
  readonly changes: PubSub<TransportEpicRun>;
}) => {
  const { store, changes } = deps;
  const enrichRun = Effect.fn("EpicRunner.enrichRun")(function* (run: EpicRun) {
    const iterations = yield* store
      .listIterations({ runId: run.runId })
      .pipe(Effect.mapError(storeError("listIterations")));
    return buildTransportRun(run, iterations.slice(-RECENT_ITERATIONS_LIMIT));
  });
  const enrichRuns = Effect.fn("EpicRunner.enrichRuns")(function* (runs: ReadonlyArray<EpicRun>) {
    const iterations = yield* store
      .listRecentIterationsForRuns({
        runIds: runs.map((run) => run.runId),
        limitPerRun: RECENT_ITERATIONS_LIMIT,
      })
      .pipe(Effect.mapError(storeError("listRecentIterationsForRuns")));
    const byRunId = new Map<string, Array<EpicRunIterationRow>>();
    for (const iteration of iterations) {
      const bucket = byRunId.get(iteration.runId);
      if (bucket === undefined) byRunId.set(iteration.runId, [iteration]);
      else bucket.push(iteration);
    }
    return runs.map((run) => buildTransportRun(run, byRunId.get(run.runId) ?? []));
  });
  const publishRunChange = (run: EpicRun) =>
    enrichRun(run).pipe(
      Effect.flatMap((enriched) => PubSubEffect.publish(changes, enriched)),
      Effect.asVoid,
    );
  const events: PoolRunEventsShape = {
    publish: (event) =>
      event.type === "run-state-changed" ? publishRunChange(event.run) : Effect.void,
  };
  return { enrichRun, enrichRuns, publishRunChange, events };
};
