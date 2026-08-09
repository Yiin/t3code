/**
 * EpicRunnerLive - Server lifecycle adapter over the shared epic loop.
 *
 * The loop itself — worker pool, iteration classification, failure budgets,
 * provider fallback, merge-queue draining — lives in
 * `@t3tools/epic-core/ParallelEpicLoop`, shared verbatim with the terminal
 * coordinator. This module keeps only what is genuinely server-owned: the
 * public service surface (assembled from `./EpicRunnerLaunch.ts` and
 * `./EpicRunnerLifecycle.ts`), loop supervision (FiberMap, live-loop marks,
 * failure backstops), restart reconciliation, and the `withTransition`
 * semaphore. Everything the loop touches goes through `./EpicRunnerPoolPorts.ts`.
 *
 * @module EpicRunner
 */
import { type EpicRun as TransportEpicRun, EpicRunId } from "@t3tools/contracts";
import {
  EpicRunNotFoundError,
  type EpicRunnerError,
  EpicRunnerStoreError,
  EpicRunStateError,
} from "@t3tools/epic-core/Errors";
import {
  DEFAULT_INFRA_FAILURE_BUDGET,
  DEFAULT_ITERATION_TIMEOUT_MS,
  DEFAULT_MAX_CONSECUTIVE_FAILURES,
  DEFAULT_MAX_GRACE_CONTINUATIONS,
  DEFAULT_MAX_NO_COMMIT_STREAK,
  DEFAULT_RETRY_BASE_DELAY_MS,
  DEFAULT_RETRY_MAX_DELAY_MS,
  DEFAULT_SUBAGENT_GRACE_TIMEOUT_MS,
  mergeSlotHolder,
} from "@t3tools/epic-core/policy";
import * as ProcessRunner from "@t3tools/epic-core/processRunner";
import { EpicRunPreflight } from "@t3tools/epic-core/EpicRunPreflight";
import { EpicRunConfigSource } from "@t3tools/epic-core/EpicRunConfigSource";
import { EpicRunLock, type EpicRunLockLease } from "@t3tools/epic-core/ports/EpicRunLock";
import { prepareWorkerScope } from "@t3tools/epic-core/workerScope";
import { makeProcessMergeSlot } from "@t3tools/epic-core/adapters/ProcessMergeSlot";
import { makeProcessPoolBacklog } from "@t3tools/epic-core/adapters/ProcessPoolBacklog";
import { makeProcessPoolVcs } from "@t3tools/epic-core/adapters/ProcessPoolVcs";
import {
  runParallelEpicLoop,
  type ParallelEpicLoopPorts,
  type PoolSchedulerEvent,
} from "@t3tools/epic-core/ParallelEpicLoop";
import {
  DEFAULT_POOL_POLL_INTERVAL_MS,
  DEFAULT_POOL_QUIET_PERIOD_MS,
  makePoolPolicy,
  type PoolPolicySeed,
} from "@t3tools/epic-core/runPolicy";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FiberMap from "effect/FiberMap";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { EpicRunStore } from "../../persistence/Services/EpicRuns.ts";
import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import { EpicWorkerScopeRegistry } from "../../provider/workerScope.ts";
import { AgentAwarenessRelay } from "../../relay/AgentAwarenessRelay.ts";
import { ServerConfig } from "../../config.ts";
import { ProjectSetupScriptRunner } from "../../project/ProjectSetupScriptRunner.ts";
import { WorktreeProvisioner } from "../../vcs/WorktreeProvisioner.ts";
import { GitVcsDriver } from "../../vcs/GitVcsDriver.ts";
import { EpicRunner, type EpicRunnerShape } from "../Services/EpicRunner.ts";
import { makeEpicRunnerLaunch } from "./EpicRunnerLaunch.ts";
import { makeEpicRunnerLifecycle } from "./EpicRunnerLifecycle.ts";
import {
  makeAbandonRunningIterations,
  makeEpicRunReadModel,
  makeReadOrientation,
  makeServerMergeDrain,
  makeServerPoolDispatch,
  makeServerPoolJournal,
  makeServerPoolWorkspace,
} from "./EpicRunnerPoolPorts.ts";

export { assembleIterationPrompt } from "@t3tools/epic-core/ParallelEpicLoop";

/** A provider degradation influences automatic launches for one hour. */
const DEFAULT_PROVIDER_DEGRADATION_TTL_MS = 60 * 60 * 1000;
/** How long a resume waits for a dying loop to release the run's own lock. */
const LOOP_EXIT_WAIT_MS = 5_000;
/**
 * Server runs have no on-disk run directory; this fixed discriminator keeps
 * server scope identities disjoint from terminal runs of the same checkout.
 */
const SERVER_WORKER_SCOPE_RUN_DIRECTORY = "t3code-server";

const DateTimeNowIso = Effect.map(DateTime.now, DateTime.formatIso);

/**
 * The loop-policy fields are internal default seeds. A persisted non-default
 * run config replaces each matching seed when the loop freezes its policy
 * (`makePoolPolicy` in the core). Provider degradation lifetime remains a
 * layer-wide launch policy.
 */
export interface EpicRunnerLiveOptions {
  readonly iterationTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly quietPeriodMs?: number;
  readonly retryBaseDelayMs?: number;
  readonly retryMaxDelayMs?: number;
  readonly maxConsecutiveFailures?: number;
  readonly maxNoCommitStreak?: number;
  readonly infraFailureBudget?: number;
  readonly subagentGraceTimeoutMs?: number;
  readonly maxGraceContinuations?: number;
  readonly providerDegradationTtlMs?: number;
}

const makeEpicRunner = (options?: EpicRunnerLiveOptions) =>
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const store = yield* EpicRunStore;
    const processRunner = yield* ProcessRunner.ProcessRunner;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const crypto = yield* Crypto.Crypto;
    const preflight = yield* EpicRunPreflight;
    const configSource = yield* EpicRunConfigSource;
    const runLock = yield* EpicRunLock;
    const agentAwarenessRelay = yield* AgentAwarenessRelay;
    const serverConfig = yield* ServerConfig;
    const worktreeProvisioner = yield* WorktreeProvisioner;
    const gitVcsDriver = yield* GitVcsDriver;
    const projectSetupScriptRunner = yield* ProjectSetupScriptRunner;
    const providerRegistry = yield* Effect.serviceOption(ProviderRegistry);
    const workerScopeRegistry = yield* EpicWorkerScopeRegistry;
    const leases = new Map<EpicRunId, EpicRunLockLease>();

    const seedRetryBaseDelayMs = Math.max(
      1,
      options?.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS,
    );
    const policySeed: PoolPolicySeed = Object.freeze({
      iterationTimeoutMs: Math.max(1, options?.iterationTimeoutMs ?? DEFAULT_ITERATION_TIMEOUT_MS),
      pollIntervalMs: Math.max(1, options?.pollIntervalMs ?? DEFAULT_POOL_POLL_INTERVAL_MS),
      quietPeriodMs: Math.max(1, options?.quietPeriodMs ?? DEFAULT_POOL_QUIET_PERIOD_MS),
      retryBaseDelayMs: seedRetryBaseDelayMs,
      retryMaxDelayMs: Math.max(
        seedRetryBaseDelayMs,
        options?.retryMaxDelayMs ?? DEFAULT_RETRY_MAX_DELAY_MS,
      ),
      maxConsecutiveFailures: Math.max(
        1,
        options?.maxConsecutiveFailures ?? DEFAULT_MAX_CONSECUTIVE_FAILURES,
      ),
      maxNoCommitStreak: Math.max(1, options?.maxNoCommitStreak ?? DEFAULT_MAX_NO_COMMIT_STREAK),
      infraFailureBudget: Math.max(1, options?.infraFailureBudget ?? DEFAULT_INFRA_FAILURE_BUDGET),
      subagentGraceTimeoutMs: Math.max(
        1,
        options?.subagentGraceTimeoutMs ?? DEFAULT_SUBAGENT_GRACE_TIMEOUT_MS,
      ),
      maxGraceContinuations: Math.max(
        1,
        options?.maxGraceContinuations ?? DEFAULT_MAX_GRACE_CONTINUATIONS,
      ),
    });

    const changes = yield* Effect.acquireRelease(PubSub.unbounded<TransportEpicRun>(), (pubsub) =>
      PubSub.shutdown(pubsub),
    );
    // Scoped to the layer, so every loop is interrupted on server shutdown and
    // no run keeps dispatching turns into a tearing-down orchestration engine.
    const loops = yield* FiberMap.make<EpicRunId, void, never>();
    /**
     * Runs whose loop will still re-read their status at its next iteration
     * boundary. See `resumeRun`: a paused run keeps a live loop — and its own
     * lock — for the rest of the turn in flight, so a resume landing in that
     * window is handed to the live loop instead of relaunching.
     */
    const liveLoops = new Set<EpicRunId>();
    /** Wake a pool blocked on worker settlement after a live cap change. */
    const workerCapSignals = new Map<EpicRunId, Queue.Queue<PoolSchedulerEvent>>();
    /** Cancellation owns lease release after it abandons every running row. */
    const cancelCleanupOwned = new Set<EpicRunId>();
    /**
     * Serializes every run-status transition — the loop's own boundary writes
     * included — so no writer can act on a status another writer has already
     * replaced. Never held across an agent turn.
     */
    const transitions = yield* Semaphore.make(1);
    const withTransition = transitions.withPermits(1);

    const backlog = makeProcessPoolBacklog(processRunner);
    const readModel = makeEpicRunReadModel({
      store,
      processRunner,
      agentAwarenessRelay,
      changes,
    });
    const { enrichRun, enrichRuns, saveRun } = readModel;
    const workspace = makeServerPoolWorkspace({
      store,
      processRunner,
      fileSystem,
      path,
      serverConfig,
      worktreeProvisioner,
      gitVcsDriver,
      projectionSnapshotQuery,
    });
    const poolPorts: ParallelEpicLoopPorts = {
      journal: makeServerPoolJournal(store),
      events: readModel.events,
      backlog,
      workspace,
      dispatch: makeServerPoolDispatch({
        engine,
        projectionSnapshotQuery,
        processRunner,
        projectSetupScriptRunner,
        crypto,
        workerScopeRegistry,
      }),
      mergeDrain: makeServerMergeDrain({ store, processRunner, fileSystem, path, gitVcsDriver }),
      vcs: makeProcessPoolVcs(processRunner),
      providerInventory: Option.isNone(providerRegistry)
        ? null
        : { getProviders: providerRegistry.value.getProviders },
    };
    const readOrientation = makeReadOrientation({ fileSystem, path });
    const abandonRunningIterations = makeAbandonRunningIterations({
      store,
      engine,
      crypto,
      backlog,
    });

    const storeError = (operation: string) => (cause: unknown) =>
      new EpicRunnerStoreError({ operation, cause });

    const requireRun = (runId: EpicRunId) =>
      store.getRun({ runId }).pipe(
        Effect.mapError(storeError("getRun")),
        Effect.flatMap((run) =>
          Option.isNone(run)
            ? Effect.fail(new EpicRunNotFoundError({ runId }))
            : Effect.succeed(run.value),
        ),
      );

    const releaseLease = (runId: EpicRunId) => {
      const lease = leases.get(runId);
      if (lease === undefined) return Effect.void;
      leases.delete(runId);
      return lease.release.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("epic.runner.lock-release-failed", { runId, cause }),
        ),
        Effect.asVoid,
      );
    };
    const releaseLeaseOnFailure =
      (runId: EpicRunId) =>
      <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
        effect.pipe(
          Effect.onExit((exit) => (Exit.isFailure(exit) ? releaseLease(runId) : Effect.void)),
        );

    yield* Effect.addFinalizer(() =>
      Effect.forEach([...leases.keys()], releaseLease, { discard: true }),
    );

    /** The loop: one call into the shared core, wired to the server ports. */
    const runLoop = (runId: EpicRunId): Effect.Effect<void, EpicRunnerError> =>
      Effect.gen(function* () {
        const initialRun = yield* requireRun(runId);
        // One systemd scope identity per run, mirroring the terminal
        // coordinator. A collision is fatal — a crashed run's workers may
        // still hold the identity; every other degradation logs a warning and
        // spawns unwrapped (see workerScope.ts in epic-core).
        const scopePreparation = yield* prepareWorkerScope({
          repositoryPath: initialRun.cwd,
          runDirectory: SERVER_WORKER_SCOPE_RUN_DIRECTORY,
          epicId: initialRun.epicId,
          runId,
        }).pipe(
          Effect.provideService(ProcessRunner.ProcessRunner, processRunner),
          Effect.mapError(
            (collision) => new EpicRunStateError({ runId, detail: collision.detail }),
          ),
        );
        yield* workerScopeRegistry.setRunPreparation(runId, scopePreparation);
        const policy = makePoolPolicy(policySeed, initialRun);
        const signals = yield* Queue.unbounded<PoolSchedulerEvent>();
        workerCapSignals.set(runId, signals);
        yield* runParallelEpicLoop(
          {
            runId,
            epicId: initialRun.epicId,
            cwd: initialRun.cwd,
            policy,
            withTransition,
            signals,
            readOrientation,
            cleanupOwnedExternally: () => cancelCleanupOwned.has(runId),
          },
          poolPorts,
        ).pipe(Effect.ensuring(workerScopeRegistry.releaseRun(runId)));
      });

    /** Best-effort terminal write for a loop that died on an unexpected error. */
    const markRunFailed = (runId: EpicRunId, detail: string) =>
      requireRun(runId).pipe(
        Effect.flatMap((run) => Effect.map(DateTimeNowIso, (updatedAt) => ({ run, updatedAt }))),
        Effect.flatMap(({ run, updatedAt }) =>
          saveRun({
            ...run,
            status: "failed",
            currentThreadId: null,
            currentTurnStartedAt: null,
            lastError: detail,
            updatedAt,
          }),
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning("epic.runner.mark-failed-failed", { runId, cause }),
        ),
      );

    /**
     * A loop that dies on an unexpected error leaves its run non-terminal, so
     * the core's own finalizer skips integration cleanup. Once the failure is
     * persisted, run it here — the same order the pre-extraction runner used.
     */
    const cleanupIntegrationAfterFailure = (runId: EpicRunId) =>
      store.getRun({ runId }).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.void,
            onSome: (run) =>
              workspace.releaseIntegration(
                {
                  runId,
                  epicId: run.epicId,
                  projectId: run.projectId,
                  cwd: run.cwd,
                },
                "failed",
              ),
          }),
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning("epic.runner.integration-cleanup-failed", { runId, cause }),
        ),
      );

    const supervisedLoop = (runId: EpicRunId): Effect.Effect<void> =>
      runLoop(runId).pipe(
        Effect.catch((error: EpicRunnerError) =>
          Effect.logError("epic.runner.loop-failed", { runId, detail: error.message }).pipe(
            Effect.flatMap(() =>
              abandonRunningIterations(
                runId,
                "abandoned after iteration worker failure",
                "infra:dispatch-failed",
                "worker-failure",
              ).pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning("epic.runner.worker-cleanup-failed", { runId, cause }),
                ),
              ),
            ),
            Effect.flatMap(() => markRunFailed(runId, error.message)),
            Effect.andThen(cleanupIntegrationAfterFailure(runId)),
          ),
        ),
        Effect.catchDefect((defect) =>
          Effect.logError("epic.runner.loop-defect", { runId, defect }).pipe(
            Effect.flatMap(() =>
              abandonRunningIterations(
                runId,
                "abandoned after iteration worker defect",
                "infra:dispatch-failed",
                "worker-defect",
              ).pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning("epic.runner.worker-cleanup-failed", { runId, cause }),
                ),
              ),
            ),
            Effect.flatMap(() => markRunFailed(runId, String(defect))),
            Effect.andThen(cleanupIntegrationAfterFailure(runId)),
          ),
        ),
        // The core loop's own finalizer releases the integration workspace and
        // sweeps stranded claims on every exit it observes; cancellation owns
        // its cleanup. What remains here is the bookkeeping the core never
        // owned: the live mark, the cap signal, and the run lease.
        Effect.ensuring(
          Effect.sync(() => {
            liveLoops.delete(runId);
            workerCapSignals.delete(runId);
            return cancelCleanupOwned.has(runId);
          }).pipe(
            Effect.flatMap((cancelOwnsCleanup) =>
              cancelOwnsCleanup ? Effect.void : releaseLease(runId),
            ),
          ),
        ),
      );

    const forkLoop = (runId: EpicRunId) =>
      Effect.sync(() => liveLoops.add(runId)).pipe(
        Effect.andThen(FiberMap.run(loops, runId, supervisedLoop(runId))),
        Effect.asVoid,
      );

    /** Wait for a loop that has committed to exiting to actually release its lock. */
    const awaitLoopExit = (runId: EpicRunId) =>
      FiberMap.get(loops, runId).pipe(
        Effect.flatMap((fiber) =>
          Option.isSome(fiber) ? Effect.asVoid(Fiber.await(fiber.value)) : Effect.void,
        ),
        Effect.timeout(Duration.millis(LOOP_EXIT_WAIT_MS)),
        Effect.catchCause((cause) =>
          Effect.logWarning("epic.runner.loop-exit-wait-failed", { runId, cause }),
        ),
        Effect.asVoid,
      );

    const launch = makeEpicRunnerLaunch({
      store,
      preflight,
      configSource,
      runLock,
      projectionSnapshotQuery,
      providerRegistry,
      crypto,
      enrichRun,
      saveRun,
      leases,
      forkLoop,
      releaseLeaseOnFailure,
      providerDegradationTtlMs: Math.max(
        0,
        options?.providerDegradationTtlMs ?? DEFAULT_PROVIDER_DEGRADATION_TTL_MS,
      ),
    });

    const lifecycle = makeEpicRunnerLifecycle({
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
      acquireLease: launch.acquireLease,
      persistedConfigSnapshot: launch.persistedConfigSnapshot,
    });

    /**
     * Release every child this run claimed and left in progress, on paths that
     * never reach the loop's own finalizer (a restart that loses its lease).
     * The backlog port re-reads each issue and no-ops unless it is still
     * `in_progress`, so sweeping closed iterations is free of side effects.
     */
    const releaseStrandedChild = (runId: EpicRunId): Effect.Effect<void> =>
      Effect.gen(function* () {
        const run = yield* store.getRun({ runId });
        if (Option.isNone(run)) return;
        const iterations = yield* store.listIterations({ runId });
        const issueIds = [
          ...new Set(
            iterations
              .map((iteration) => iteration.issueId)
              .filter((issueId): issueId is string => issueId !== null),
          ),
        ];
        yield* Effect.forEach(
          issueIds,
          (issueId) => backlog.releaseClaimedChild(run.value.cwd, issueId),
          { concurrency: 1, discard: true },
        );
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("epic.runner.release-stranded-child-lookup-failed", {
            runId,
            cause,
          }),
        ),
      );

    /**
     * Free the merge slot if this run is still recorded as holding it.
     *
     * The drain releases the slot from a finalizer, and a SIGKILL or a systemd
     * stop skips finalizers, so a hard-killed run leaves the slot held under
     * its own holder id. Nothing else can free it: the next boot cannot
     * acquire it, every drain returns deferred, and the loop just sleeps and
     * retries. The run neither fails nor progresses, and from outside it looks
     * healthy — the lock keeps heartbeating and no worker is alive to look
     * wrong.
     *
     * Only this run's own holder id is evidence. A slot held by another run,
     * another epic, or the terminal coordinator is left alone, because
     * deferring to a live holder is what should happen.
     */
    const reclaimLeakedMergeSlot = (run: {
      readonly runId: EpicRunId;
      readonly cwd: string;
    }): Effect.Effect<void> =>
      Effect.gen(function* () {
        const holder = mergeSlotHolder(run.runId);
        const slot = makeProcessMergeSlot({ repositoryPath: run.cwd, processRunner });
        const { reclaimed } = yield* slot.reclaim(holder);
        if (!reclaimed) return;
        yield* Effect.logInfo("epic.runner.merge-slot-reclaimed", {
          runId: run.runId,
          holder,
        });
      }).pipe(
        // A reclaim that cannot run is not worth failing a boot over: the run
        // then behaves exactly as it does today, deferring its drains.
        Effect.catchCause((cause) =>
          Effect.logWarning("epic.runner.merge-slot-reclaim-failed", {
            runId: run.runId,
            cause,
          }),
        ),
      );

    const listRuns: EpicRunnerShape["listRuns"] = (input) =>
      store
        .listRuns(input ?? {})
        .pipe(Effect.mapError(storeError("listRuns")), Effect.flatMap(enrichRuns));

    const getRun: EpicRunnerShape["getRun"] = ({ runId }) =>
      store.getRun({ runId }).pipe(
        Effect.mapError(storeError("getRun")),
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.succeed(Option.none<TransportEpicRun>()),
            onSome: (run) => enrichRun(run).pipe(Effect.map(Option.some)),
          }),
        ),
      );

    const streamRuns = Stream.unwrap(
      Effect.map(PubSub.subscribe(changes), (subscription) =>
        Stream.fromSubscription(subscription),
      ),
    );

    const start: EpicRunnerShape["start"] = () =>
      Effect.gen(function* () {
        const runs = yield* store.listRuns({}).pipe(Effect.mapError(storeError("listRuns")));

        for (const run of runs) {
          if (run.status !== "running") {
            yield* abandonRunningIterations(
              run.runId,
              "abandoned by server restart",
              "server-restart",
              "restart",
            ).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("epic.runner.restart-reconcile-failed", {
                  runId: run.runId,
                  cause,
                }),
              ),
            );
            continue;
          }
          const acquireError = yield* launch
            .acquireLease(
              run.runId,
              { cwd: run.cwd, epicId: run.epicId },
              launch.persistedConfigSnapshot(run),
              // This is a resume: the run's own integration branch and
              // worktree are where it left off, not leftovers to reconcile.
              true,
            )
            .pipe(
              Effect.match({
                onFailure: (error) => error,
                onSuccess: () => null,
              }),
            );
          if (acquireError !== null) {
            const error =
              acquireError._tag === "EpicRunLeaseHeld" ? acquireError.mappedError : acquireError;
            yield* saveRun({
              ...run,
              status: "failed",
              lastError: error.message,
              updatedAt: yield* DateTimeNowIso,
            });
            // This run's loop never gets a chance to fork, so its finalizer
            // never runs either — release its last claimed child here, or a
            // lost lease strands it exactly like the failure path this fixes.
            yield* releaseStrandedChild(run.runId);
            continue;
          }
          yield* Effect.gen(function* () {
            yield* abandonRunningIterations(
              run.runId,
              "abandoned by server restart",
              "server-restart",
              "restart",
            );
            // Before the loop, not inside it: the first drain is what a leaked
            // slot silently blocks.
            yield* reclaimLeakedMergeSlot(run);
            yield* forkLoop(run.runId);
          }).pipe(releaseLeaseOnFailure(run.runId));
        }

        yield* Effect.logInfo("epic.runner.started", {
          resumedRuns: runs.filter((run) => run.status === "running").length,
          iterationTimeoutMs: policySeed.iterationTimeoutMs,
          maxConsecutiveFailures: policySeed.maxConsecutiveFailures,
        });
      }).pipe(
        Effect.catch((error: EpicRunnerError) =>
          Effect.logError("epic.runner.start-failed", { detail: error.message }),
        ),
        Effect.catchDefect((defect) => Effect.logError("epic.runner.start-defect", { defect })),
      );

    return {
      start,
      startRun: launch.startRun,
      launchRun: launch.launchRun,
      pauseRun: lifecycle.pauseRun,
      resumeRun: lifecycle.resumeRun,
      cancelRun: lifecycle.cancelRun,
      setWorkers: lifecycle.setWorkers,
      listRuns,
      getRun,
      streamRuns,
    } satisfies EpicRunnerShape;
  });

export const makeEpicRunnerLive = (options?: EpicRunnerLiveOptions) =>
  Layer.effect(EpicRunner, makeEpicRunner(options));

export const EpicRunnerLive = makeEpicRunnerLive();
