/**
 * EpicRunnerLifecycle - Status transitions of a server epic run.
 *
 * Pause, resume, cancel, and the live worker cap. The loop observes every
 * transition through the persisted run row: pause deliberately never
 * interrupts the turn in flight (an agent halfway through a unit of work
 * would leave the repo and the backlog inconsistent), while cancel interrupts
 * immediately. All transitions serialise through the shared `withTransition`
 * semaphore so no writer acts on a status another writer already replaced.
 *
 * @module EpicRunnerLifecycle
 */
import { CommandId, type EpicRunId, type ThreadId, type TurnId } from "@t3tools/contracts";
import {
  EpicRunNotFoundError,
  EpicRunnerStoreError,
  EpicRunStateError,
} from "@t3tools/epic-core/Errors";
import type { PoolBacklogShape, PoolSchedulerEvent } from "@t3tools/epic-core/ParallelEpicLoop";
import type { EpicRunConfigSnapshot } from "@t3tools/epic-core/EpicRunPreflight";
import { isEpicRunTerminal } from "@t3tools/epic-core/runStatus";
import type { WorkspaceShape } from "@t3tools/epic-core/ports/Workspace";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import type * as Semaphore from "effect/Semaphore";

import type { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { EpicRunStore, type EpicRun } from "../../persistence/Services/EpicRuns.ts";
import type { EpicRunnerShape } from "../Services/EpicRunner.ts";
import type { EpicRunLeaseHeld } from "./EpicRunnerLaunch.ts";

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

export const makeEpicRunnerLifecycle = (deps: {
  readonly store: EpicRunStore["Service"];
  readonly engine: OrchestrationEngineService["Service"];
  readonly crypto: Crypto.Crypto;
  readonly backlog: PoolBacklogShape;
  readonly workspace: WorkspaceShape;
  readonly transitions: Semaphore.Semaphore;
  readonly liveLoops: ReadonlySet<EpicRunId>;
  readonly loops: FiberMap.FiberMap<EpicRunId, void, never>;
  readonly workerCapSignals: Map<EpicRunId, Queue.Queue<PoolSchedulerEvent>>;
  readonly cancelCleanupOwned: Set<EpicRunId>;
  readonly enrichRun: (
    run: EpicRun,
  ) => Effect.Effect<import("@t3tools/contracts").EpicRun, EpicRunnerStoreError>;
  readonly saveRun: (run: EpicRun) => Effect.Effect<void, EpicRunnerStoreError>;
  readonly awaitLoopExit: (runId: EpicRunId) => Effect.Effect<void>;
  readonly forkLoop: (runId: EpicRunId) => Effect.Effect<void>;
  readonly releaseLease: (runId: EpicRunId) => Effect.Effect<void>;
  readonly releaseLeaseOnFailure: (
    runId: EpicRunId,
  ) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  readonly acquireLease: (
    runId: EpicRunId,
    input: { readonly cwd: string; readonly epicId: string },
    configSnapshot: EpicRunConfigSnapshot,
  ) => Effect.Effect<void, import("@t3tools/epic-core/Errors").EpicRunnerError | EpicRunLeaseHeld>;
  readonly persistedConfigSnapshot: (run: EpicRun) => EpicRunConfigSnapshot;
  readonly ownedIterationTurnIds: Map<ThreadId, TurnId>;
}) => {
  const {
    store,
    engine,
    crypto,
    backlog,
    workspace,
    transitions,
    liveLoops,
    loops,
    workerCapSignals,
    cancelCleanupOwned,
    enrichRun,
    saveRun,
    awaitLoopExit,
    forkLoop,
    releaseLease,
    releaseLeaseOnFailure,
    acquireLease,
    persistedConfigSnapshot,
    ownedIterationTurnIds,
  } = deps;

  const storeError = (operation: string) => (cause: unknown) =>
    new EpicRunnerStoreError({ operation, cause });

  const withTransition = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    transitions.withPermits(1)(effect);

  const requireRun = (runId: EpicRunId) =>
    store.getRun({ runId }).pipe(
      Effect.mapError(storeError("getRun")),
      Effect.flatMap((run) =>
        Option.isNone(run)
          ? Effect.fail(new EpicRunNotFoundError({ runId }))
          : Effect.succeed(run.value),
      ),
    );

  const commandId = (tag: string) =>
    crypto.randomUUIDv4.pipe(
      Effect.map((uuid) => CommandId.make(`server:epic-run-${tag}:${uuid}`)),
      Effect.orDie,
    );

  /** Dispatch something cancellation can survive losing (interrupts, session stops). */
  const dispatchBestEffort = (
    label: string,
    command: {
      readonly type: "thread.turn.interrupt" | "thread.session.stop";
      readonly threadId: ThreadId;
      readonly turnId?: TurnId;
      readonly createdAt: string;
    },
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      const fullCommand = {
        ...command,
        commandId: yield* commandId(
          `cancel-${command.type === "thread.turn.interrupt" ? "interrupt" : "session-stop"}`,
        ),
      } as Parameters<typeof engine.dispatch>[0];
      yield* engine.dispatch(fullCommand).pipe(
        Effect.asVoid,
        Effect.catchCause((cause) => Effect.logWarning(label, { cause })),
      );
    });

  const pauseRun: EpicRunnerShape["pauseRun"] = ({ runId }) =>
    Effect.gen(function* () {
      const paused = yield* withTransition(
        Effect.gen(function* () {
          const run = yield* requireRun(runId);
          if (run.status !== "running") {
            return yield* new EpicRunStateError({
              runId,
              detail: `cannot pause a ${run.status} run`,
            });
          }
          const next: EpicRun = { ...run, status: "paused", updatedAt: yield* nowIso };
          // No interrupt: the loop re-reads the run before each iteration and
          // exits at that boundary, so the turn in flight finishes its unit of
          // work rather than leaving the repo and backlog half-done.
          yield* saveRun(next);
          return next;
        }),
      );
      return yield* enrichRun(paused);
    });

  const resumeRun: EpicRunnerShape["resumeRun"] = ({ runId }) =>
    Effect.gen(function* () {
      const handoff = yield* withTransition(
        Effect.gen(function* () {
          const run = yield* requireRun(runId);
          if (run.status !== "paused") {
            return yield* new EpicRunStateError({
              runId,
              detail: `cannot resume a ${run.status} run`,
            });
          }
          const resumed: EpicRun = {
            ...run,
            status: "running",
            consecutiveFailures: 0,
            noCommitStreak: 0,
            infraStreak: 0,
            lastError: null,
            updatedAt: yield* nowIso,
          };
          // A pause takes effect at the next iteration boundary, so the loop
          // can still be draining the iteration that was in flight — holding
          // this run's own lock for as long as an agent turn lasts.
          // Relaunching there would run launch preflight against that lock
          // and refuse the resume as `run_in_progress`. Flip the status
          // instead and let the live loop pick it up when it looks again.
          if (liveLoops.has(runId)) {
            yield* saveRun(resumed);
            return { run: resumed, relaunch: false } as const;
          }
          // A stopped run stays durably paused until its lease is acquired.
          // Failed preflight or acquisition must leave it resumable.
          return { run, relaunch: true } as const;
        }),
      );
      if (!handoff.relaunch) return yield* enrichRun(handoff.run);

      yield* awaitLoopExit(runId);
      yield* acquireLease(
        runId,
        { cwd: handoff.run.cwd, epicId: handoff.run.epicId },
        persistedConfigSnapshot(handoff.run),
      ).pipe(
        Effect.mapError((error) => (error._tag === "EpicRunLeaseHeld" ? error.mappedError : error)),
      );
      const relaunched = yield* withTransition(
        Effect.gen(function* () {
          const fresh = yield* requireRun(runId);
          if (fresh.status !== "paused") {
            return { run: fresh, forked: false } as const;
          }
          const resumed: EpicRun = {
            ...fresh,
            status: "running",
            consecutiveFailures: 0,
            noCommitStreak: 0,
            infraStreak: 0,
            lastError: null,
            updatedAt: yield* nowIso,
          };
          yield* saveRun(resumed);
          yield* forkLoop(runId);
          return { run: resumed, forked: true } as const;
        }),
      ).pipe(releaseLeaseOnFailure(runId));
      if (!relaunched.forked) {
        yield* releaseLease(runId);
      }
      return yield* enrichRun(relaunched.run);
    });

  const cancelRun: EpicRunnerShape["cancelRun"] = ({ runId }) =>
    Effect.gen(function* () {
      const transition = yield* withTransition(
        Effect.gen(function* () {
          const fresh = yield* requireRun(runId);
          if (isEpicRunTerminal(fresh.status)) {
            return yield* new EpicRunStateError({
              runId,
              detail: `run already ${fresh.status}`,
            });
          }
          const cancelledAt = yield* nowIso;
          const cancelled: EpicRun = {
            ...fresh,
            status: "cancelled",
            currentThreadId: null,
            currentTurnStartedAt: null,
            updatedAt: cancelledAt,
          };
          yield* saveRun(cancelled);
          return { cancelled, cancelledAt } as const;
        }),
      );

      const { cancelled, cancelledAt } = transition;
      // Cancellation is durable before loop interruption. The loop either
      // observes the cancelled row at its boundary or is interrupted here,
      // while its lease remains held until the cancelled state is visible.
      cancelCleanupOwned.add(runId);
      // Removing the loop can run handle finalizers. Keep the turn targets
      // before that removal so cancellation cannot lose iteration ownership.
      const ownedTurnIdsAtCancel = new Map(ownedIterationTurnIds);
      yield* Effect.gen(function* () {
        yield* FiberMap.remove(loops, runId);

        const runningIterations = yield* store
          .listRunningIterations({ runId })
          .pipe(Effect.mapError(storeError("listRunningIterations")));
        for (const iteration of runningIterations) {
          const ownedTurnId = ownedTurnIdsAtCancel.get(iteration.threadId);
          yield* dispatchBestEffort("epic.runner.cancel-interrupt-failed", {
            type: "thread.turn.interrupt",
            threadId: iteration.threadId,
            ...(ownedTurnId === undefined ? {} : { turnId: ownedTurnId }),
            createdAt: cancelledAt,
          });
          yield* dispatchBestEffort("epic.runner.cancel-session-stop-failed", {
            type: "thread.session.stop",
            threadId: iteration.threadId,
            createdAt: cancelledAt,
          });
          yield* store
            .updateIteration({
              runId,
              iterationIndex: iteration.iterationIndex,
              turnStatus: "abandoned",
              summary: "cancelled",
              why: null,
              failureReason: "cancelled",
              phaseTimings: null,
              promptBytes: null,
              finishedAt: cancelledAt,
            })
            .pipe(Effect.mapError(storeError("updateIteration")));
          if (iteration.issueId !== null) {
            yield* backlog.releaseClaimedChild(cancelled.cwd, iteration.issueId);
          }
          ownedIterationTurnIds.delete(iteration.threadId);
        }
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => cancelCleanupOwned.delete(runId)).pipe(
            Effect.andThen(
              workspace.releaseIntegration(
                {
                  runId,
                  epicId: cancelled.epicId,
                  projectId: cancelled.projectId,
                  cwd: cancelled.cwd,
                },
                "cancelled",
              ),
            ),
            Effect.andThen(releaseLease(runId)),
          ),
        ),
      );
      return yield* enrichRun(cancelled);
    });

  const setWorkers: EpicRunnerShape["setWorkers"] = ({ runId, workers }) =>
    withTransition(
      Effect.gen(function* () {
        const run = yield* requireRun(runId);
        if (run.status !== "running" && run.status !== "paused") {
          return yield* new EpicRunStateError({
            runId,
            detail: `cannot set workers on a ${run.status} run`,
          });
        }
        const updated: EpicRun = {
          ...run,
          workers,
          updatedAt: yield* nowIso,
        };
        yield* saveRun(updated);
        const signal = workerCapSignals.get(runId);
        if (signal !== undefined) yield* Queue.offer(signal, { _tag: "retune" });
        return yield* enrichRun(updated);
      }),
    );

  return { pauseRun, resumeRun, cancelRun, setWorkers };
};
