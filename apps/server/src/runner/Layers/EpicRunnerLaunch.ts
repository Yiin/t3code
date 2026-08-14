/**
 * EpicRunnerLaunch - How a server epic run comes into existence.
 *
 * Launch owns the resolved repo config (`.t3code/epic-run.json` with per-run
 * API input overriding it), the launch preflight, and the run lease shared
 * with terminal cook-epic. It creates the persisted run row and forks the
 * loop; everything after that belongs to the loop or the lifecycle.
 *
 * @module EpicRunnerLaunch
 */
import {
  DEFAULT_RUNTIME_MODE,
  type EpicRoleId,
  type EpicRolePolicy,
  type EpicRunConfigProvenance,
  EpicRunId,
  type LaunchEpicRunInput,
  type ModelSelection,
  type ProviderAccountLimit,
  type ProviderUsageSample,
} from "@t3tools/contracts";
import {
  EpicRunLaunchError,
  EpicRunPreflightBlockedError,
  type EpicRunnerError,
  EpicRunnerStoreError,
} from "@t3tools/epic-core/Errors";
import { epicRunIterationPrompt } from "@t3tools/epic-core/policy";
import {
  EpicRunPreflight,
  formatEpicRunPreflightBlocker,
  makeEpicRunConfigSnapshot,
  type EpicRunConfigSnapshot,
} from "@t3tools/epic-core/EpicRunPreflight";
import { EpicRunConfigSource } from "@t3tools/epic-core/EpicRunConfigSource";
import {
  EpicRunLock,
  type EpicRunLockHeldError,
  type EpicRunLockLease,
} from "@t3tools/epic-core/ports/EpicRunLock";
import { epicRoleFallbackChain, type EpicFallbackHop } from "@t3tools/epic-core/providerFallback";
import {
  isLiveProviderDegradation,
  resolveDegradationAwareSelection,
  type ProviderDegradationRecord,
} from "@t3tools/epic-core/providerDegradation";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { EpicRunStore, type EpicRun } from "../../persistence/Services/EpicRuns.ts";
import type { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import type { StartEpicRunInput } from "../Services/EpicRunner.ts";
import { providerAccountExhaustion } from "./EpicRunnerRoleSelection.ts";

const ACTIVE_RUN_RETRY_ATTEMPTS = 20;
const ACTIVE_RUN_RETRY_DELAY_MS = 5;

/** The run-level selection is the iteration worker's, so launch resolves that role. */
const ITERATION_WORKER_ROLE: EpicRoleId = "iteration-worker";

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

export const isValidOrientationFile = (value: string): boolean =>
  !/^(?:[A-Za-z]:[\\/]|[\\/])/u.test(value) && !value.split(/[\\/]/u).includes("..");

const hasConfiguredValue = (provenance: EpicRunConfigProvenance, key: string): boolean =>
  provenance[key] !== undefined && provenance[key] !== "default";

/**
 * What a resumed run already owns, handed to `acquireLease` by the boot path.
 *
 * Its presence is the resume discriminator: absent means launch, and every
 * launch caller keeps today's exact behaviour by passing nothing.
 */
export interface EpicRunLeaseResume {
  /** Absolute per-worker worktree paths, read from `epic_run_iterations`. */
  readonly worktreePaths: ReadonlyArray<string>;
}

/**
 * What a granted lease tells its caller about the resume it was asked for.
 *
 * Preflight already probed every path in {@link EpicRunLeaseResume.worktreePaths}
 * against `git worktree list` and the filesystem, so reporting the misses here
 * costs nothing and spares the boot path a second probe. A launch always reads
 * an empty array.
 */
export interface EpicRunLeaseAcquired {
  /**
   * The resume worktrees git no longer lists, or that are gone from disk. The
   * boot path cannot continue the agents that were working in them, so it
   * abandons those rows and lets the loop dispatch their children fresh.
   */
  readonly missingResumeWorktreePaths: ReadonlyArray<string>;
}

export interface EpicRunLeaseHeld {
  readonly _tag: "EpicRunLeaseHeld";
  readonly mappedError: EpicRunPreflightBlockedError;
}

const formatEpicRunLockHeldError = (error: EpicRunLockHeldError): string => {
  const holder = error.holder;
  if (
    holder !== undefined &&
    typeof holder.owner === "string" &&
    typeof holder.host === "string" &&
    typeof holder.pid === "number" &&
    typeof holder.runDir === "string"
  ) {
    return formatEpicRunPreflightBlocker({
      _tag: "run_in_progress",
      owner: holder.owner,
      host: holder.host,
      pid: holder.pid,
      runDir: holder.runDir,
    });
  }
  return error.message;
};

export const makeEpicRunnerLaunch = (deps: {
  readonly store: EpicRunStore["Service"];
  readonly preflight: EpicRunPreflight["Service"];
  readonly configSource: EpicRunConfigSource["Service"];
  readonly runLock: EpicRunLock["Service"];
  readonly projectionSnapshotQuery: ProjectionSnapshotQuery["Service"];
  readonly providerRegistry: Option.Option<ProviderRegistry["Service"]>;
  readonly crypto: Crypto.Crypto;
  readonly enrichRun: (
    run: EpicRun,
  ) => Effect.Effect<import("@t3tools/contracts").EpicRun, EpicRunnerStoreError>;
  /** Upsert the run row and fan the change out to subscribers. */
  readonly saveRun: (run: EpicRun) => Effect.Effect<void, EpicRunnerStoreError>;
  readonly leases: Map<EpicRunId, EpicRunLockLease>;
  readonly forkLoop: (runId: EpicRunId) => Effect.Effect<void>;
  readonly releaseLeaseOnFailure: (
    runId: EpicRunId,
  ) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  readonly providerDegradationTtlMs: number;
  /**
   * The global role policy, read fresh per launch so a settings edit applies
   * to the next run without a restart. It never fails: a missing or broken
   * settings runtime reads as an empty policy, which is the legacy path.
   */
  readonly readEpicRolePolicy: Effect.Effect<EpicRolePolicy>;
  /**
   * Fail-soft reads of live usage and limit state, for skipping an exhausted
   * account at launch. Both never fail and answer `[]` when their store is
   * absent or unreadable, so a broken read keeps today's selection instead of
   * blocking a launch.
   */
  readonly readUsageSamples: Effect.Effect<ReadonlyArray<ProviderUsageSample>>;
  readonly readAccountLimits: Effect.Effect<ReadonlyArray<ProviderAccountLimit>>;
}) => {
  const {
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
    providerDegradationTtlMs,
    readEpicRolePolicy,
    readUsageSamples,
    readAccountLimits,
  } = deps;

  const storeError = (operation: string) => (cause: unknown) =>
    new EpicRunnerStoreError({ operation, cause });

  const findActiveRun = Effect.fn("EpicRunner.findActiveRun")(function* (input: {
    readonly epicId: string;
    readonly cwd: string;
  }) {
    const runs = yield* store.listRuns({}).pipe(Effect.mapError(storeError("listRuns")));
    return runs.find(
      (run) =>
        (run.status === "running" || run.status === "paused") &&
        run.epicId === input.epicId &&
        run.cwd === input.cwd,
    );
  });

  const awaitActiveRun = Effect.fn("EpicRunner.awaitActiveRun")(function* (input: {
    readonly epicId: string;
    readonly cwd: string;
  }) {
    for (let attempt = 0; attempt < ACTIVE_RUN_RETRY_ATTEMPTS; attempt += 1) {
      const active = yield* findActiveRun(input);
      if (active !== undefined) return active;
      if (attempt + 1 < ACTIVE_RUN_RETRY_ATTEMPTS) {
        yield* Effect.sleep(Duration.millis(ACTIVE_RUN_RETRY_DELAY_MS));
      }
    }
    return undefined;
  });

  const acquireLease = Effect.fn("EpicRunner.acquireLease")(function* (
    runId: EpicRunId,
    input: Pick<StartEpicRunInput, "cwd" | "epicId">,
    configSnapshot: EpicRunConfigSnapshot,
    // The artifacts this run already owns, when the caller is picking the run
    // back up rather than launching it. The run id is not repeated here: it is
    // this call's first argument, and two sources for it could disagree.
    resume?: EpicRunLeaseResume,
  ) {
    const result = yield* preflight
      .check(
        {
          workspaceRoot: input.cwd,
          epicId: input.epicId,
          mode: configSnapshot.config.execution.sequential ? "sequential" : "parallel",
          // Resuming this run forgives this run's own integration leftovers and
          // its own in-flight worktrees. A fresh launch passes neither, so
          // nothing is forgiven there.
          ...(resume === undefined
            ? {}
            : {
                intent: "resume" as const,
                resume: { runId, worktreePaths: resume.worktreePaths },
              }),
        },
        configSnapshot,
      )
      .pipe(
        Effect.mapError(
          (error) =>
            new EpicRunPreflightBlockedError({
              epicId: input.epicId,
              blockers: [error.message],
            }),
        ),
      );
    if (resume !== undefined && result.warnings.length > 0) {
      // What the resume adopted, and what it could not find, belongs in the
      // boot log: `dirty_tree_accepted` says the run's own unfinished work was
      // forgiven, `resume_worktree_missing` says a child has to be dispatched
      // fresh instead of continued.
      yield* Effect.logInfo("epic.runner.resume-preflight-warnings", {
        runId,
        epicId: input.epicId,
        warnings: result.warnings,
      });
    }
    if (!result.ok) {
      const mapped = new EpicRunPreflightBlockedError({
        epicId: input.epicId,
        blockers: result.blockers.map(formatEpicRunPreflightBlocker),
      });
      if (result.blockers.some((blocker) => blocker._tag === "run_in_progress")) {
        return yield* Effect.fail({
          _tag: "EpicRunLeaseHeld",
          mappedError: mapped,
        } satisfies EpicRunLeaseHeld);
      }
      return yield* mapped;
    }
    const lease = yield* runLock
      .acquire({
        workspaceRoot: input.cwd,
        epicId: input.epicId,
        owner: "t3code",
        runDir: input.cwd,
      })
      .pipe(
        Effect.mapError((error): EpicRunPreflightBlockedError | EpicRunLeaseHeld => {
          const mapped = new EpicRunPreflightBlockedError({
            epicId: input.epicId,
            blockers: [
              error._tag === "EpicRunLockHeldError"
                ? formatEpicRunLockHeldError(error)
                : error.message,
            ],
          });
          return error._tag === "EpicRunLockHeldError"
            ? { _tag: "EpicRunLeaseHeld", mappedError: mapped }
            : mapped;
        }),
      );
    leases.set(runId, lease);
    return {
      missingResumeWorktreePaths: result.warnings.flatMap((warning) =>
        warning._tag === "resume_worktree_missing" ? [...warning.paths] : [],
      ),
    } satisfies EpicRunLeaseAcquired;
  });

  const readConfigSnapshot = Effect.fn("EpicRunner.readConfigSnapshot")(function* (
    input: Pick<StartEpicRunInput, "cwd" | "config">,
  ) {
    const fileResult = yield* configSource.read({ repoRoot: input.cwd });
    return makeEpicRunConfigSnapshot({
      fileResult,
      override: input.config ?? null,
      harness: null,
    });
  });

  /** The config frozen into the run row at launch, replayed on resume/restart. */
  const persistedConfigSnapshot = (run: EpicRun): EpicRunConfigSnapshot => ({
    fileResult: { _tag: "absent" },
    config: run.config,
    provenance: run.configProvenance,
    violations: [],
  });

  const applyLegacyIterationCap = (
    configSnapshot: EpicRunConfigSnapshot,
    maxIterations: number | undefined,
  ): EpicRunConfigSnapshot =>
    maxIterations === undefined ||
    hasConfiguredValue(configSnapshot.provenance, "limits.maxIterations")
      ? configSnapshot
      : {
          ...configSnapshot,
          config: {
            ...configSnapshot.config,
            limits: {
              ...configSnapshot.config.limits,
              maxIterations: Math.max(1, Math.trunc(maxIterations)),
            },
          },
          provenance: {
            ...configSnapshot.provenance,
            "limits.maxIterations": "override",
          },
        };

  const startNewRun = Effect.fn("EpicRunner.startNewRun")(function* (
    input: StartEpicRunInput,
    configSnapshot: EpicRunConfigSnapshot,
    modelSelectionAlreadyResolved = false,
  ) {
    const orientationFile = input.orientationFile ?? null;
    if (orientationFile !== null && !isValidOrientationFile(orientationFile)) {
      return yield* new EpicRunLaunchError({ reason: "orientation_file_invalid" });
    }

    const runId = EpicRunId.make(yield* crypto.randomUUIDv4.pipe(Effect.orDie));
    const createdAt = yield* nowIso;
    const configuredModelSelection = configSnapshot.config.provider.modelSelection;
    const modelSelection =
      !modelSelectionAlreadyResolved &&
      configuredModelSelection !== null &&
      hasConfiguredValue(configSnapshot.provenance, "provider.modelSelection")
        ? configuredModelSelection
        : input.modelSelection;
    const runtimeMode = hasConfiguredValue(configSnapshot.provenance, "runtime.mode")
      ? configSnapshot.config.runtime.mode
      : (input.runtimeMode ?? DEFAULT_RUNTIME_MODE);
    const maxIterations = hasConfiguredValue(configSnapshot.provenance, "limits.maxIterations")
      ? configSnapshot.config.limits.maxIterations
      : (input.maxIterations ?? configSnapshot.config.limits.maxIterations);
    const run: EpicRun = {
      runId,
      epicId: input.epicId,
      projectId: input.projectId,
      cwd: input.cwd,
      prompt: input.prompt,
      orientationFile,
      modelSelection,
      runtimeMode,
      config: configSnapshot.config,
      configProvenance: configSnapshot.provenance,
      // Only ever what the launcher supplied: the run's own iteration
      // threads are children, so they can never stand in for an origin.
      originThreadId: input.originThreadId ?? null,
      status: "running",
      maxIterations: Math.max(1, Math.trunc(maxIterations)),
      workers: configSnapshot.config.parallel.workers,
      iterationsCompleted: 0,
      iterationsDispatched: 0,
      currentThreadId: null,
      currentTurnStartedAt: null,
      consecutiveFailures: 0,
      noCommitStreak: 0,
      infraStreak: 0,
      lastError: null,
      createdAt,
      updatedAt: createdAt,
    };

    const acquireError = yield* acquireLease(runId, input, configSnapshot).pipe(
      Effect.match({
        onFailure: (error) => error,
        onSuccess: () => null,
      }),
    );
    if (acquireError !== null) {
      if (acquireError._tag === "EpicRunLeaseHeld") {
        const winner = yield* awaitActiveRun(input);
        if (winner !== undefined) {
          return yield* enrichRun(winner);
        }
        return yield* acquireError.mappedError;
      }
      return yield* acquireError;
    }
    yield* saveRun(run).pipe(releaseLeaseOnFailure(runId));
    yield* forkLoop(runId).pipe(releaseLeaseOnFailure(runId));
    yield* Effect.logInfo("epic.runner.run-started", {
      runId,
      epicId: run.epicId,
      cwd: run.cwd,
      maxIterations: run.maxIterations,
    });
    return yield* enrichRun(run);
  });

  /**
   * Start a run on the selection its caller named.
   *
   * `startRun` deliberately skips {@link resolveLaunchModelSelection}: its
   * `modelSelection` is required input a client or the CLI picked on purpose,
   * so rerouting it would silently ignore an explicit choice. `launchRun`
   * resolves a selection itself, from the project default or the repo config,
   * and therefore owns the degradation and tier-chain checks. That is what
   * carries a degradation across separate runs of one epic: the record
   * outlives its run, so the next launch starts past the failed account
   * instead of burning an iteration rediscovering it.
   */
  const startRun = (input: StartEpicRunInput) =>
    Effect.gen(function* () {
      const orientationFile = input.orientationFile ?? null;
      if (orientationFile !== null && !isValidOrientationFile(orientationFile)) {
        return yield* new EpicRunLaunchError({ reason: "orientation_file_invalid" });
      }
      const active = yield* findActiveRun(input);
      if (active !== undefined) {
        return yield* enrichRun(active);
      }
      const configSnapshot = applyLegacyIterationCap(
        yield* readConfigSnapshot(input),
        input.maxIterations,
      );
      return yield* startNewRun(input, configSnapshot);
    });

  /** The hop chain the iteration-worker role points at, or an empty chain. */
  const iterationWorkerChain: Effect.Effect<ReadonlyArray<EpicFallbackHop>> = Effect.map(
    readEpicRolePolicy,
    (policy) => epicRoleFallbackChain(policy, ITERATION_WORKER_ROLE),
  );

  /**
   * The live degradation row for one instance, clearing an expired one first.
   *
   * `null` means "usable": either nothing is recorded, or what was recorded
   * has passed its own reset time or aged past the TTL and has just been
   * deleted.
   */
  const liveProviderDegradation = (input: {
    readonly providerInstanceId: ModelSelection["instanceId"];
    readonly cutoff: string;
    readonly now: string;
  }) =>
    Effect.gen(function* () {
      const degradation = yield* store
        .getProviderDegradation({ providerInstanceId: input.providerInstanceId })
        .pipe(Effect.mapError(storeError("getProviderDegradation")));
      if (Option.isNone(degradation)) return null;
      if (isLiveProviderDegradation(degradation.value, input.cutoff, input.now)) {
        return degradation.value;
      }
      // The predicate is repeated by SQL. A newer replacement written
      // after this read is therefore safe from this cleanup.
      yield* store
        .clearExpiredProviderDegradation({
          providerInstanceId: input.providerInstanceId,
          cutoff: input.cutoff,
          now: input.now,
        })
        .pipe(Effect.mapError(storeError("clearExpiredProviderDegradation")));
      return null;
    });

  const logLaunchFallback = (input: {
    readonly from: ModelSelection;
    readonly to: ModelSelection;
    readonly reason: string;
    readonly chain: ReadonlyArray<EpicFallbackHop>;
  }) =>
    Effect.logInfo("epic.runner.launch-provider-fallback", {
      fromInstanceId: input.from.instanceId,
      toInstanceId: input.to.instanceId,
      reason: input.reason,
      role: ITERATION_WORKER_ROLE,
      // Where the target sits in the role's chain, and how long that chain
      // is. Both are null on the legacy driver-order path, which has no chain.
      chainPosition:
        input.chain.length === 0
          ? null
          : input.chain.findIndex((hop) => hop.instanceId === input.to.instanceId),
      chainLength: input.chain.length === 0 ? null : input.chain.length,
    });

  const resolveLaunchModelSelection = (
    defaultSelection: ModelSelection,
  ): Effect.Effect<ModelSelection, EpicRunnerError> =>
    Effect.gen(function* () {
      // Registry absence keeps the configured default. Automatic fallback
      // needs the registry to reuse the normal eligibility checks.
      if (Option.isNone(providerRegistry)) return defaultSelection;
      const providers = yield* providerRegistry.value.getProviders;
      const checkedAt = yield* DateTime.now;
      const now = DateTime.formatIso(checkedAt);
      const cutoff = DateTime.formatIso(
        DateTime.subtractDuration(checkedAt, Duration.millis(providerDegradationTtlMs)),
      );
      const chain = yield* iterationWorkerChain;

      // Probe every instance the walk could reach, once, so the pure resolver
      // can answer without further reads. Probing also retires an expired row,
      // so a stale degradation never blocks a launch. A chain bounds the
      // candidates to its own hops; without one the walk follows driver order
      // and any configured instance is reachable.
      const candidates = new Set<ModelSelection["instanceId"]>([defaultSelection.instanceId]);
      for (const hop of chain) candidates.add(hop.instanceId);
      if (chain.length === 0) {
        for (const provider of providers) candidates.add(provider.instanceId);
      }
      const degradations = new Map<ModelSelection["instanceId"], ProviderDegradationRecord>();
      for (const providerInstanceId of candidates) {
        const record = yield* liveProviderDegradation({ providerInstanceId, cutoff, now });
        if (record !== null) degradations.set(providerInstanceId, record);
      }

      // Exhaustion joins the walk beside degradations: a live max utilization
      // at or above 100, or a live usage/spend limit row. Auth, unavailable
      // and credits-depleted rows are not exhaustion — the first two need
      // operator action, and credits-depleted can be org-wide, where rotating
      // to a sibling of the same org would burn a hop for nothing.
      const exhaustion = providerAccountExhaustion({
        usageSamples: yield* readUsageSamples,
        accountLimits: yield* readAccountLimits,
        now,
        cutoff,
      });

      const resolved = resolveDegradationAwareSelection({
        providers,
        chain,
        current: defaultSelection,
        degradationOf: (instanceId) => degradations.get(instanceId) ?? null,
        isExhausted: exhaustion.isExhausted,
      });
      for (const hop of resolved.hops) {
        yield* logLaunchFallback({ from: hop.from, to: hop.to, reason: hop.reason, chain });
      }
      return resolved.selection;
    });

  /**
   * The launching thread's own provider instance, model and options.
   *
   * A native cook-epic launch runs from inside a session the user already
   * chose a provider for, so the run has to keep that exact routing rather
   * than the project default: a Prime-launched run stays on Prime, on the
   * same instance id, with the same options. The origin has to be live and in
   * the same project, because a run in another project's repo would dispatch
   * its iterations against the wrong workspace.
   */
  const resolveOriginModelSelection = (
    input: LaunchEpicRunInput,
  ): Effect.Effect<ModelSelection, EpicRunnerError> =>
    Effect.gen(function* () {
      if (input.originThreadId === undefined) {
        return yield* new EpicRunLaunchError({ reason: "origin_thread_required" });
      }
      // Archived and deleted threads are both absent here, and both mean the
      // launcher is gone.
      const shell = yield* projectionSnapshotQuery
        .getThreadShellById(input.originThreadId)
        .pipe(Effect.mapError(storeError("getThreadShellById")));
      if (Option.isNone(shell)) {
        return yield* new EpicRunLaunchError({ reason: "origin_thread_not_found" });
      }
      if (shell.value.projectId !== input.projectId) {
        return yield* new EpicRunLaunchError({ reason: "origin_thread_project_mismatch" });
      }
      return shell.value.modelSelection;
    });

  const launchRun = (input: LaunchEpicRunInput) =>
    Effect.gen(function* () {
      const active = yield* findActiveRun(input);
      if (active !== undefined) {
        return yield* enrichRun(active);
      }
      const project = yield* projectionSnapshotQuery
        .getProjectShellById(input.projectId)
        .pipe(Effect.mapError(storeError("getProjectShellById")));
      if (Option.isNone(project)) {
        return yield* new EpicRunLaunchError({ reason: "project_not_found" });
      }
      if (project.value.workspaceRoot !== input.cwd) {
        return yield* new EpicRunLaunchError({ reason: "cwd_mismatch" });
      }
      const configSnapshot = yield* readConfigSnapshot(input);
      const configuredModelSelection = configSnapshot.config.provider.modelSelection;
      // Per-launch input is the most specific signal there is, so inheriting
      // the origin outranks the repo file, which in turn outranks the
      // persisted project default.
      const selectedModel =
        input.inheritOriginModelSelection === true
          ? yield* resolveOriginModelSelection(input)
          : configuredModelSelection !== null &&
              hasConfiguredValue(configSnapshot.provenance, "provider.modelSelection")
            ? configuredModelSelection
            : project.value.defaultModelSelection;
      if (selectedModel === null) {
        return yield* new EpicRunLaunchError({ reason: "model_default_missing" });
      }
      const modelSelection = yield* resolveLaunchModelSelection(selectedModel);
      return yield* startNewRun(
        {
          ...input,
          prompt: epicRunIterationPrompt({ pushEnabled: !configSnapshot.config.vcs.noPush }),
          orientationFile: null,
          modelSelection,
          runtimeMode: DEFAULT_RUNTIME_MODE,
        },
        configSnapshot,
        true,
      );
    });

  return { startRun, launchRun, acquireLease, persistedConfigSnapshot, findActiveRun };
};
