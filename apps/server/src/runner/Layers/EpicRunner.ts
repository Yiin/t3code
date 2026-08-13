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
import {
  CommandId,
  DEFAULT_EPIC_ROLE_POLICY,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EPIC_RUN_FAILURE_RESUME_BLOCKED,
  EPIC_RUN_FAILURE_RESUME_FAILED,
  EPIC_RUN_FAILURE_RESUME_UNSUPPORTED,
  type EpicRolePolicy,
  type EpicRun as TransportEpicRun,
  EpicRunId,
  MessageId,
  type ThreadId,
  type TurnId,
} from "@t3tools/contracts";
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
  parseMergeSlotHolder,
  shouldReclaimMergeSlot,
} from "@t3tools/epic-core/policy";
import { DEFAULT_RUN_STALL_TIMEOUT_MS } from "@t3tools/epic-core/runStall";
import { isEpicRunTerminal } from "@t3tools/epic-core/runStatus";
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
  type ResumedWorker,
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
import {
  EpicRunStore,
  type EpicRun,
  type EpicRunIteration,
} from "../../persistence/Services/EpicRuns.ts";
import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import { EpicWorkerScopeRegistry } from "../../provider/workerScope.ts";
import { AgentAwarenessRelay } from "../../relay/AgentAwarenessRelay.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ProjectSetupScriptRunner } from "../../project/ProjectSetupScriptRunner.ts";
import { WorktreeProvisioner } from "../../vcs/WorktreeProvisioner.ts";
import { GitVcsDriver } from "../../vcs/GitVcsDriver.ts";
import { EpicRunner, type EpicRunnerShape } from "../Services/EpicRunner.ts";
import { makeEpicRunnerLaunch } from "./EpicRunnerLaunch.ts";
import { makeEpicRunnerLifecycle } from "./EpicRunnerLifecycle.ts";
import { makeServerWorkerEvidence } from "./EpicRunnerWorkerEvidence.ts";
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
 * How many times one iteration row may be picked back up after a restart.
 *
 * A row that keeps being interrupted is more likely a crash loop than bad
 * luck, and each resume spends the whole iteration budget again on a thread
 * whose transcript is already long. One retry, then the child is dispatched
 * fresh — which is exactly what the pre-resume runner always did.
 */
const MAX_RESUMES_PER_ITERATION = 1;
/**
 * Persisted failure reasons that mean "a restart ended this row". Counted per
 * child when a row predates the `resume_count` column and cannot say for
 * itself how often it was already resumed.
 */
const RESTART_FAILURE_REASONS: ReadonlySet<string> = new Set([
  "server-restart",
  "server-restart-unresumable",
  EPIC_RUN_FAILURE_RESUME_UNSUPPORTED,
  EPIC_RUN_FAILURE_RESUME_BLOCKED,
  EPIC_RUN_FAILURE_RESUME_FAILED,
]);
/**
 * Server runs have no on-disk run directory; this fixed discriminator keeps
 * server scope identities disjoint from terminal runs of the same checkout.
 */
const SERVER_WORKER_SCOPE_RUN_DIRECTORY = "t3code-server";

const DateTimeNowIso = Effect.map(DateTime.now, DateTime.formatIso);

/** Per-fork loop options. Only the boot re-adoption path sets any of them. */
interface EpicRunLoopOptions {
  /**
   * The boot path is re-adopting a run whose workers outlived the server, so
   * its own leftover systemd scopes are orphans to stop, not a fatal identity
   * collision. A fresh launch never sets this.
   */
  readonly reclaimOwnScopes?: boolean;
  /**
   * Iterations a previous process left `running` that this loop should
   * continue instead of dispatching fresh. Only the boot path fills this; the
   * loop adopts each one before its first scheduler tick.
   */
  readonly resumedWorkers?: ReadonlyArray<ResumedWorker>;
}

/**
 * The loop-policy fields are internal default seeds. A persisted non-default
 * run config replaces each matching seed when the loop freezes its policy
 * (`makePoolPolicy` in the core). Provider degradation lifetime remains a
 * layer-wide launch policy.
 */
export interface EpicRunnerLiveOptions {
  readonly iterationTimeoutMs?: number;
  readonly runStallTimeoutMs?: number;
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
    const serverSettings = yield* Effect.serviceOption(ServerSettingsService);
    const workerScopeRegistry = yield* EpicWorkerScopeRegistry;

    /**
     * The epic role policy, or an empty one. A server without a settings
     * runtime, or a settings read that fails, keeps the pre-tier behaviour
     * rather than blocking a launch on a policy lookup.
     */
    const readEpicRolePolicy: Effect.Effect<EpicRolePolicy> = Option.isNone(serverSettings)
      ? Effect.succeed(DEFAULT_EPIC_ROLE_POLICY)
      : serverSettings.value.getSettings.pipe(
          Effect.map((settings) => settings.epicRolePolicy),
          Effect.catchCause((cause) =>
            Effect.logWarning("epic.runner.role-policy-read-failed", { cause }).pipe(
              Effect.as(DEFAULT_EPIC_ROLE_POLICY),
            ),
          ),
        );
    const leases = new Map<EpicRunId, EpicRunLockLease>();

    const seedRetryBaseDelayMs = Math.max(
      1,
      options?.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS,
    );
    const policySeed: PoolPolicySeed = Object.freeze({
      iterationTimeoutMs: Math.max(1, options?.iterationTimeoutMs ?? DEFAULT_ITERATION_TIMEOUT_MS),
      runStallTimeoutMs: Math.max(1, options?.runStallTimeoutMs ?? DEFAULT_RUN_STALL_TIMEOUT_MS),
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
    const ownedIterationTurnIds = new Map<ThreadId, TurnId>();
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
    const { enrichRun, enrichRuns } = readModel;

    type PriorRun = Option.Option<EpicRun> | null;

    const readPriorRun = (runId: EpicRunId): Effect.Effect<PriorRun> =>
      store.getRun({ runId }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("epic.runner.origin-status-prior-read-failed", {
            runId,
            cause,
          }).pipe(Effect.as(null)),
        ),
      );

    /**
     * Best-effort detail for a terminal origin-thread post: which children
     * landed, and which `epic/*` branches the run left unmerged. Both reads
     * come from the store — the merge queue holds exactly the entries the
     * drain never completed, so a completed iteration whose branch is absent
     * from the queue landed. Any failure degrades to no detail; the post must
     * still go out.
     */
    const readTerminalDetail = (
      run: EpicRun,
    ): Effect.Effect<{
      readonly landed: ReadonlyArray<string>;
      readonly strandedBranches: ReadonlyArray<string>;
    } | null> =>
      Effect.gen(function* () {
        const iterations = yield* store.listIterations({ runId: run.runId });
        const mergeState = yield* store.getMergeState({ runId: run.runId });
        const strandedBranches = Option.match(mergeState, {
          onNone: () => [] as Array<string>,
          onSome: (state) => state.entries.map((entry) => entry.branch),
        });
        const stranded = new Set(strandedBranches);
        const landed = [
          ...new Set(
            iterations
              .filter(
                (iteration) =>
                  iteration.turnStatus === "completed" &&
                  iteration.branch !== null &&
                  iteration.branch !== undefined &&
                  !stranded.has(iteration.branch),
              )
              .map((iteration) => iteration.issueId ?? iteration.branch!),
          ),
        ];
        return { landed, strandedBranches };
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("epic.runner.origin-status-detail-failed", {
            runId: run.runId,
            cause,
          }).pipe(Effect.as(null)),
        ),
      );

    const reportOriginThreadTransitions = (
      previous: PriorRun,
      run: EpicRun,
    ): Effect.Effect<void> => {
      if (previous === null || run.originThreadId === null) return Effect.void;
      const originThreadId = run.originThreadId;

      const transitions: Array<string> = [];
      if (Option.isNone(previous) && run.status === "running") transitions.push("started");
      if (Option.isSome(previous) && run.iterationsCompleted > previous.value.iterationsCompleted) {
        transitions.push("iteration settled");
      }
      const terminalTransition =
        isEpicRunTerminal(run.status) &&
        (Option.isNone(previous) || previous.value.status !== run.status);
      if (terminalTransition) {
        transitions.push(run.status === "done" ? "completed" : run.status);
      }
      if (transitions.length === 0) return Effect.void;

      return Effect.gen(function* () {
        const terminalDetail = terminalTransition ? yield* readTerminalDetail(run) : null;
        for (const transition of transitions) {
          yield* Effect.gen(function* () {
            const commandUuid = yield* crypto.randomUUIDv4;
            const messageUuid = yield* crypto.randomUUIDv4;
            const createdAt = yield* DateTimeNowIso;
            let text = `EpicRunner run ${run.runId} for ${run.epicId}: ${transition}. Iterations ${run.iterationsCompleted}/${run.maxIterations}.`;
            if (
              transition === "completed" ||
              transition === "failed" ||
              transition === "cancelled"
            ) {
              if (run.lastError !== null) text += ` Error: ${run.lastError}.`;
              if (terminalDetail !== null && terminalDetail.landed.length > 0) {
                text += ` Landed: ${terminalDetail.landed.join(", ")}.`;
              }
              if (terminalDetail !== null && terminalDetail.strandedBranches.length > 0) {
                text += ` Unmerged branches: ${terminalDetail.strandedBranches.join(", ")}.`;
              }
            }
            yield* engine.dispatch({
              type: "thread.turn.start",
              commandId: CommandId.make(`server:epic-run-status:${commandUuid}`),
              threadId: originThreadId,
              message: {
                messageId: MessageId.make(`epic-run-status:${run.runId}:${messageUuid}`),
                role: "user",
                text,
                attachments: [],
              },
              origin: "agent",
              delivery: "turn-boundary",
              runtimeMode: run.runtimeMode,
              interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
              createdAt,
            });
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("epic.runner.origin-status-dispatch-failed", {
                runId: run.runId,
                epicId: run.epicId,
                transition,
                cause,
              }),
            ),
          );
        }
      });
    };

    const saveRun = (run: EpicRun) =>
      readPriorRun(run.runId).pipe(
        Effect.flatMap((previous) =>
          store.upsertRun(run).pipe(
            Effect.mapError(storeError("upsertRun")),
            Effect.tap(() => reportOriginThreadTransitions(previous, run)),
            Effect.flatMap(() => readModel.publishRunChange(run)),
          ),
        ),
      );
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
    const baseJournal = makeServerPoolJournal(store);
    const poolPorts: ParallelEpicLoopPorts = {
      journal: {
        ...baseJournal,
        saveRun: (run) =>
          readPriorRun(run.runId).pipe(
            Effect.flatMap((previous) =>
              baseJournal
                .saveRun(run)
                .pipe(Effect.tap(() => reportOriginThreadTransitions(previous, run))),
            ),
          ),
      },
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
        ownedIterationTurnIds,
      }),
      mergeDrain: makeServerMergeDrain({ store, processRunner, fileSystem, path, gitVcsDriver }),
      vcs: makeProcessPoolVcs(processRunner),
      providerInventory: Option.isNone(providerRegistry)
        ? null
        : { getProviders: providerRegistry.value.getProviders },
      // The tier-walking adapter lands separately (t3code-pg7): until then
      // every dispatch stays on the run-level selection.
      roleSelection: null,
      workerEvidence: makeServerWorkerEvidence({ workerScopeRegistry, processRunner }),
    };
    const readOrientation = makeReadOrientation({ fileSystem, path });
    const abandonRunningIterations = makeAbandonRunningIterations({
      store,
      engine,
      crypto,
      backlog,
      ownedIterationTurnIds,
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
    const runLoop = (
      runId: EpicRunId,
      options?: EpicRunLoopOptions,
    ): Effect.Effect<void, EpicRunnerError> =>
      Effect.gen(function* () {
        const initialRun = yield* requireRun(runId);
        // One systemd scope identity per run, mirroring the terminal
        // coordinator. A collision is fatal — a crashed run's workers may
        // still hold the identity; every other degradation logs a warning and
        // spawns unwrapped (see workerScope.ts in epic-core). The exception is
        // a run re-adopting itself at boot: the leftover scopes are its own
        // orphans, so it stops them and carries on.
        const scopePreparation = yield* prepareWorkerScope(
          {
            repositoryPath: initialRun.cwd,
            runDirectory: SERVER_WORKER_SCOPE_RUN_DIRECTORY,
            epicId: initialRun.epicId,
            runId,
          },
          { reclaimOwnScopes: options?.reclaimOwnScopes === true },
        ).pipe(
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
            resumedWorkers: options?.resumedWorkers,
          },
          poolPorts,
        ).pipe(Effect.ensuring(workerScopeRegistry.releaseRun(runId)));
      });

    /**
     * Best-effort terminal write for a loop that died on an unexpected error.
     * Under the same transition semaphore as every other status write: a
     * cancel racing this save must not read a stale prior row and double-post
     * the origin-thread terminal message.
     */
    const markRunFailed = (runId: EpicRunId, detail: string) =>
      withTransition(
        Effect.gen(function* () {
          const run = yield* requireRun(runId);
          const updatedAt = yield* DateTimeNowIso;
          yield* saveRun({
            ...run,
            status: "failed",
            currentThreadId: null,
            currentTurnStartedAt: null,
            lastError: detail,
            updatedAt,
          });
        }),
      ).pipe(
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

    const supervisedLoop = (runId: EpicRunId, options?: EpicRunLoopOptions): Effect.Effect<void> =>
      runLoop(runId, options).pipe(
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

    const forkLoop = (runId: EpicRunId, options?: EpicRunLoopOptions) =>
      Effect.sync(() => liveLoops.add(runId)).pipe(
        Effect.andThen(FiberMap.run(loops, runId, supervisedLoop(runId, options))),
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
      readEpicRolePolicy,
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
      ownedIterationTurnIds,
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
     * A slot left by a DIFFERENT run counts too, once that run has finished.
     * Reclaiming only this run's own id was not enough: run 4f11d14b deferred
     * for 602s and failed on a slot held by 94c6b175, which the same OOM had
     * killed ten hours earlier. A dead run's slot blocks every later drain
     * just as thoroughly as one's own.
     *
     * The evidence is the same in both cases — the holder names a run, and
     * that run is provably not going. A holder this cannot parse, or one whose
     * run is still running or unknown, is left alone: deferring to a live
     * holder is what should happen.
     */
    const reclaimLeakedMergeSlot = (run: {
      readonly runId: EpicRunId;
      readonly cwd: string;
    }): Effect.Effect<void> =>
      Effect.gen(function* () {
        const slot = makeProcessMergeSlot({ repositoryPath: run.cwd, processRunner });
        const held = yield* slot.holder;
        if (Option.isNone(held)) return;
        const holder = held.value;
        const ownerRunId = parseMergeSlotHolder(holder);
        if (ownerRunId === null) return;
        const owner =
          ownerRunId === run.runId
            ? Option.none()
            : yield* store.getRun({ runId: EpicRunId.make(ownerRunId) });
        if (
          !shouldReclaimMergeSlot({
            holder,
            thisRunId: run.runId,
            ownerStatus: Option.isSome(owner) ? owner.value.status : null,
          })
        ) {
          return;
        }
        yield* slot.release(holder);
        yield* Effect.logInfo("epic.runner.merge-slot-reclaimed", {
          runId: run.runId,
          holder,
          ownedByThisRun: ownerRunId === run.runId,
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

    /**
     * Split a restarted run's in-flight rows into the work this process can
     * continue and the work it has to abandon.
     *
     * Everything decided here is something only the boot path knows: whether a
     * row names a child at all, whether its worktree survived (preflight
     * already probed that, so this reads its answer rather than shelling out
     * again), and how much of the row's resume budget is left. Everything
     * else — an unsupported harness, a harness that refuses, a child that
     * closed while the server was down — is the loop's own resume branch to
     * decide, and it abandons those rows itself.
     */
    const classifyInterruptedIterations = (input: {
      readonly runId: EpicRunId;
      readonly inFlight: ReadonlyArray<EpicRunIteration>;
      readonly missingWorktreePaths: ReadonlySet<string>;
      readonly sequential: boolean;
    }) =>
      Effect.gen(function* () {
        const { runId, inFlight, missingWorktreePaths, sequential } = input;
        // A row written before migration 056 cannot say how often it was
        // resumed, so count the restarts its child already survived. A read
        // that fails leaves the budget unknown, and an unknown budget is spent.
        const spentByChild = inFlight.some((iteration) => iteration.resumeCount === undefined)
          ? yield* store.listIterations({ runId }).pipe(
              Effect.map((rows) => {
                const counts = new Map<string, number>();
                for (const row of rows) {
                  if (row.issueId === null || row.failureReason === null) continue;
                  if (!RESTART_FAILURE_REASONS.has(row.failureReason)) continue;
                  counts.set(row.issueId, (counts.get(row.issueId) ?? 0) + 1);
                }
                return counts;
              }),
              Effect.catchCause((cause) =>
                Effect.logWarning("epic.runner.resume-budget-read-failed", { runId, cause }).pipe(
                  Effect.as(null),
                ),
              ),
            )
          : new Map<string, number>();

        const resumedWorkers: Array<ResumedWorker> = [];
        const abandonedIterationIndexes = new Set<number>();
        const refusals: Array<{ readonly iterationIndex: number; readonly reason: string }> = [];
        const refuse = (iteration: EpicRunIteration, reason: string) => {
          abandonedIterationIndexes.add(iteration.iterationIndex);
          refusals.push({ iterationIndex: iteration.iterationIndex, reason });
        };

        for (const iteration of inFlight) {
          const issueId = iteration.issueId;
          // A synthetic row (an unrecognised `bd ready`) names no child, so
          // there is no work to pick back up.
          if (issueId === null) {
            refuse(iteration, "no-child");
            continue;
          }
          const worktreePath = iteration.worktreePath ?? null;
          // A parallel worker commits in its own worktree. Without one there
          // is nothing to adopt, and provisioning a fresh one would strand
          // whatever the dead worker had already committed.
          if (worktreePath === null && !sequential) {
            refuse(iteration, "no-worktree");
            continue;
          }
          if (worktreePath !== null && missingWorktreePaths.has(worktreePath)) {
            refuse(iteration, "worktree-missing");
            continue;
          }
          const spent =
            iteration.resumeCount ??
            (spentByChild === null ? null : (spentByChild.get(issueId) ?? 0));
          if (spent === null || spent >= MAX_RESUMES_PER_ITERATION) {
            refuse(iteration, "resume-budget-spent");
            continue;
          }
          resumedWorkers.push({
            issueId,
            iterationIndex: iteration.iterationIndex,
            threadId: iteration.threadId,
            branch: iteration.branch ?? null,
            worktreePath,
            startedAt: iteration.startedAt,
            resumeCount: spent,
          });
        }
        return { resumedWorkers, abandonedIterationIndexes, refusals } as const;
      });

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
          // The rows still marked `running` are this run's interrupted work.
          // Their worktrees are the ones preflight has to forgive, so read them
          // before the check rather than after it.
          const inFlight = yield* store
            .listRunningIterations({ runId: run.runId })
            .pipe(Effect.mapError(storeError("listRunningIterations")));
          const resumeWorktreePaths = [
            ...new Set(
              inFlight
                .map((iteration) => iteration.worktreePath ?? null)
                .filter((path): path is string => path !== null),
            ),
          ];
          const configSnapshot = launch.persistedConfigSnapshot(run);
          const acquired = yield* launch
            .acquireLease(
              run.runId,
              { cwd: run.cwd, epicId: run.epicId },
              configSnapshot,
              // This is a resume: the run's own integration branch and
              // worktrees are where it left off, not leftovers to reconcile.
              { worktreePaths: resumeWorktreePaths },
            )
            .pipe(
              Effect.match({
                onFailure: (error) => ({ _tag: "blocked" as const, error }),
                onSuccess: (lease) => ({ _tag: "leased" as const, lease }),
              }),
            );
          if (acquired._tag === "blocked") {
            const acquireError = acquired.error;
            const error =
              acquireError._tag === "EpicRunLeaseHeld" ? acquireError.mappedError : acquireError;
            // `paused`, not `failed`: the blocker is almost always something an
            // operator can clear, and `resumeRun` only accepts `paused`, so
            // `failed` here would be a dead end. The thread pointers go with
            // it, or the awareness relay and the web sidebar keep pointing at a
            // thread nothing is driving.
            yield* saveRun({
              ...run,
              status: "paused",
              lastError: error.message,
              currentThreadId: null,
              currentTurnStartedAt: null,
              updatedAt: yield* DateTimeNowIso,
            });
            // Reconcile the in-flight rows durably, but drive no thread: without
            // a lease this runner has no right to interrupt or stop them, and
            // the session reaper already stopped their sessions at startup.
            // That is why this cannot reuse `abandonRunningIterations`.
            for (const iteration of inFlight) {
              yield* store
                .updateIteration({
                  runId: run.runId,
                  iterationIndex: iteration.iterationIndex,
                  turnStatus: "abandoned",
                  summary: "abandoned by server restart",
                  why: null,
                  failureReason: "server-restart",
                  finishedAt: yield* DateTimeNowIso,
                })
                .pipe(Effect.mapError(storeError("updateIteration")));
            }
            // This run's loop never gets a chance to fork, so its finalizer
            // never runs either — release its last claimed child here, or a
            // lost lease strands it exactly like the failure path this fixes.
            yield* releaseStrandedChild(run.runId);
            continue;
          }
          yield* Effect.gen(function* () {
            const { resumedWorkers, abandonedIterationIndexes, refusals } =
              yield* classifyInterruptedIterations({
                runId: run.runId,
                inFlight,
                missingWorktreePaths: new Set(acquired.lease.missingResumeWorktreePaths),
                sequential: configSnapshot.config.execution.sequential,
              });
            yield* Effect.logInfo("epic.runner.restart-resume", {
              runId: run.runId,
              epicId: run.epicId,
              resumed: resumedWorkers.length,
              abandoned: abandonedIterationIndexes.size,
              workers: resumedWorkers.map((worker) => ({
                iterationIndex: worker.iterationIndex,
                threadId: worker.threadId,
                issueId: worker.issueId,
                resumeCount: worker.resumeCount,
              })),
              refusals,
            });
            // Only the rows nothing will continue. Abandoning a resumable row
            // would stop the very session the resume is about to pick up, and
            // un-claim the child out from under it.
            yield* abandonRunningIterations(
              run.runId,
              "abandoned by server restart",
              "server-restart",
              "restart",
              abandonedIterationIndexes,
            );
            // Before the loop, not inside it: the first drain is what a leaked
            // slot silently blocks.
            yield* reclaimLeakedMergeSlot(run);
            // Boot only: this run's workers live in `cook-epic.slice`, outside
            // the service cgroup, so a `systemctl --user restart` leaves their
            // scope units loaded. They hold this run's own identity, and a
            // fresh probe would call that a fatal collision.
            yield* forkLoop(run.runId, { reclaimOwnScopes: true, resumedWorkers });
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
