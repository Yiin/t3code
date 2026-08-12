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
  type EpicRunConfigProvenance,
  EpicRunId,
  type LaunchEpicRunInput,
  type ModelSelection,
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
import { resolveEpicProviderFallback } from "@t3tools/epic-core/providerFallback";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { EpicRunStore, type EpicRun } from "../../persistence/Services/EpicRuns.ts";
import type { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import type { StartEpicRunInput } from "../Services/EpicRunner.ts";

const ACTIVE_RUN_RETRY_ATTEMPTS = 20;
const ACTIVE_RUN_RETRY_DELAY_MS = 5;

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

  const resolveLaunchModelSelection = (
    defaultSelection: ModelSelection,
  ): Effect.Effect<ModelSelection, EpicRunnerError> =>
    Effect.gen(function* () {
      // Registry absence keeps the configured default. Automatic fallback
      // needs the registry to reuse the normal eligibility checks.
      if (Option.isNone(providerRegistry)) return defaultSelection;
      const providers = yield* providerRegistry.value.getProviders;
      const checkedAt = yield* DateTime.now;
      const cutoff = DateTime.formatIso(
        DateTime.subtractDuration(checkedAt, Duration.millis(providerDegradationTtlMs)),
      );
      let selection = defaultSelection;

      while (true) {
        const degradation = yield* store
          .getProviderDegradation({ providerInstanceId: selection.instanceId })
          .pipe(Effect.mapError(storeError("getProviderDegradation")));
        if (Option.isNone(degradation)) return selection;

        if (degradation.value.degradedAt <= cutoff) {
          // The predicate is repeated by SQL. A newer replacement written
          // after this read is therefore safe from this cleanup.
          yield* store
            .clearExpiredProviderDegradation({
              providerInstanceId: selection.instanceId,
              cutoff,
            })
            .pipe(Effect.mapError(storeError("clearExpiredProviderDegradation")));
          return selection;
        }

        const fallback = resolveEpicProviderFallback({
          providers,
          current: selection,
          failureReason: "provider-error",
          providerFallbackEligible: true,
        });
        if (fallback === null) return selection;
        yield* Effect.logInfo("epic.runner.launch-provider-fallback", {
          fromInstanceId: selection.instanceId,
          toInstanceId: fallback.instanceId,
          reason: degradation.value.failureReason,
        });
        selection = fallback;
      }
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
      const selectedModel =
        configuredModelSelection !== null &&
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
