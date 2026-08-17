import { CommandId, type ThreadId, type TurnId } from "@t3tools/contracts";
import { EpicRunNotFoundError } from "@t3tools/epic-core/Errors";
import type { PoolBacklogShape } from "@t3tools/epic-core/ParallelEpicLoop";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import type { EpicRunStore, EpicRun } from "../../persistence/Services/EpicRuns.ts";
import { nowIso, storeError } from "./poolPortErrors.ts";

export const makeAbandonRunningIterations = (deps: {
  readonly store: EpicRunStore["Service"];
  readonly engine: OrchestrationEngineService["Service"];
  readonly crypto: Crypto.Crypto;
  readonly backlog: PoolBacklogShape;
  readonly ownedIterationTurnIds: Map<ThreadId, TurnId>;
}) => {
  const { store, engine, crypto, backlog, ownedIterationTurnIds } = deps;
  const commandId = (tag: string) =>
    crypto.randomUUIDv4.pipe(
      Effect.map((uuid) => CommandId.make(`server:epic-run-${tag}:${uuid}`)),
      Effect.orDie,
    );
  const dispatchBestEffort = (
    label: string,
    command: Parameters<typeof engine.dispatch>[0],
  ): Effect.Effect<void> =>
    engine.dispatch(command).pipe(
      Effect.asVoid,
      Effect.catchCause((cause) => Effect.logWarning(label, { cause })),
    );
  return Effect.fn("EpicRunner.abandonRunningIterations")(function* (
    runId: EpicRun["runId"],
    summary: string,
    failureReason: string,
    commandPrefix: string,
    onlyIterationIndexes?: ReadonlySet<number>,
  ) {
    const run = yield* store.getRun({ runId }).pipe(
      Effect.mapError(storeError("getRun")),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(new EpicRunNotFoundError({ runId })),
          onSome: Effect.succeed,
        }),
      ),
    );
    const iterations = yield* store
      .listRunningIterations({ runId })
      .pipe(Effect.mapError(storeError("listRunningIterations")));
    for (const iteration of iterations) {
      if (onlyIterationIndexes !== undefined && !onlyIterationIndexes.has(iteration.iterationIndex))
        continue;
      const abandonedAt = yield* nowIso;
      if (iteration.issueId !== null) {
        yield* dispatchBestEffort(`epic.runner.${commandPrefix}-interrupt-failed`, {
          type: "thread.turn.interrupt",
          commandId: yield* commandId(`${commandPrefix}-interrupt`),
          threadId: iteration.threadId,
          ...(ownedIterationTurnIds.has(iteration.threadId)
            ? { turnId: ownedIterationTurnIds.get(iteration.threadId) }
            : {}),
          createdAt: abandonedAt,
        });
        yield* dispatchBestEffort(`epic.runner.${commandPrefix}-session-stop-failed`, {
          type: "thread.session.stop",
          commandId: yield* commandId(`${commandPrefix}-session-stop`),
          threadId: iteration.threadId,
          createdAt: abandonedAt,
        });
      }
      yield* store
        .updateIteration({
          runId,
          iterationIndex: iteration.iterationIndex,
          turnStatus: "abandoned",
          summary,
          why: null,
          failureReason,
          phaseTimings: null,
          promptBytes: null,
          finishedAt: abandonedAt,
        })
        .pipe(Effect.mapError(storeError("updateIteration")));
      if (iteration.issueId !== null)
        yield* backlog.releaseClaimedChild(run.cwd, iteration.issueId);
      ownedIterationTurnIds.delete(iteration.threadId);
    }
  });
};
