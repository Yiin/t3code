// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off globalProcess:off preferSchemaOverJson:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  EpicRunId,
  EpicRunConfigOverride,
  EpicRunEngine,
  PositiveInt,
  ProjectId,
  ProviderInstanceId,
  type EpicRunConfig,
} from "@t3tools/contracts";
import * as EpicRunPreflight from "@t3tools/epic-core/EpicRunPreflight";
import * as EpicRunConfigSource from "@t3tools/epic-core/EpicRunConfigSource";
import { EpicRunnerStoreError } from "@t3tools/epic-core/Errors";
import {
  DEFAULT_INFRA_FAILURE_BUDGET,
  DEFAULT_ITERATION_TIMEOUT_MS,
  DEFAULT_MAX_CONSECUTIVE_FAILURES,
  DEFAULT_MAX_GRACE_CONTINUATIONS,
  DEFAULT_MAX_NO_COMMIT_STREAK,
  DEFAULT_RETRY_BASE_DELAY_MS,
  DEFAULT_RETRY_MAX_DELAY_MS,
  DEFAULT_SUBAGENT_GRACE_TIMEOUT_MS,
  epicRunIterationPrompt,
} from "@t3tools/epic-core/policy";
import { DEFAULT_RUN_STALL_TIMEOUT_MS } from "@t3tools/epic-core/runStall";
import {
  runParallelEpicLoop,
  type ParallelEpicLoopPorts,
  type PoolRunEventsShape,
  type PoolSchedulerEvent,
} from "@t3tools/epic-core/ParallelEpicLoop";
import {
  DEFAULT_POOL_POLL_INTERVAL_MS,
  DEFAULT_POOL_QUIET_PERIOD_MS,
  makePoolPolicy,
  type PoolPolicySeed,
} from "@t3tools/epic-core/runPolicy";
import { runSequentialEpicLoop } from "@t3tools/epic-core/SequentialEpicLoop";
import { harnessSupportsInspector } from "@t3tools/epic-core/adapters/AgentInspector";
import { makeFileMergeQueueStore } from "@t3tools/epic-core/adapters/FileMergeQueueStore";
import { makeFileRunEvents } from "@t3tools/epic-core/adapters/FileRunEvents";
import * as FileGateReceipts from "@t3tools/epic-core/adapters/FileGateReceipts";
import * as FileRunJournal from "@t3tools/epic-core/adapters/FileRunJournal";
import * as NodeEpicRunLock from "@t3tools/epic-core/adapters/NodeEpicRunLock";
import { makeProcessBacklog } from "@t3tools/epic-core/adapters/ProcessBacklog";
import { makeProcessGate } from "@t3tools/epic-core/adapters/ProcessGate";
import { makeProcessMergeRepair } from "@t3tools/epic-core/adapters/ProcessMergeRepair";
import { makeProcessPoolBacklog } from "@t3tools/epic-core/adapters/ProcessPoolBacklog";
import { makeProcessPoolVcs } from "@t3tools/epic-core/adapters/ProcessPoolVcs";
import { makeProcessVcs } from "@t3tools/epic-core/adapters/ProcessVcs";
import {
  makeTerminalAgentDispatch,
  type TerminalHarness,
} from "@t3tools/epic-core/adapters/TerminalAgentDispatch";
import { makeTerminalMergeDrain } from "@t3tools/epic-core/adapters/TerminalMergeDrain";
import { makeTerminalPoolDispatch } from "@t3tools/epic-core/adapters/TerminalPoolDispatch";
import { makeTerminalPoolWorkspace } from "@t3tools/epic-core/adapters/TerminalPoolWorkspace";
import { makeTerminalProviderSupport } from "@t3tools/epic-core/adapters/TerminalProviderSupport";
import { makeTerminalWorkerActivity } from "@t3tools/epic-core/adapters/TerminalWorkerActivity";
import { makeTerminalWorkerEvidence } from "@t3tools/epic-core/adapters/TerminalWorkerEvidence";
import * as ProcessRunner from "@t3tools/epic-core/processRunner";
import { EpicRunLock } from "@t3tools/epic-core/ports/EpicRunLock";
import type { PersistedEpicRun } from "@t3tools/epic-core/ports/RunJournal";
import { makeSiblingResolver } from "@t3tools/epic-core/siblings";
import { prepareWorkerScope } from "@t3tools/epic-core/workerScope";
import { makeDispatchSupervisionOptions } from "@t3tools/epic-core/workerSupervision";
import { resolveEpicRunConfig } from "@t3tools/shared/epicRunConfig";
import * as Cause from "effect/Cause";
import * as Console from "effect/Console";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { Command, Flag } from "effect/unstable/cli";

import { resolveCookModelSelection } from "./epicCookSelection.ts";
import { readCookSubagents, resolveCookSettingsPath } from "./epicCookSubagents.ts";

class EpicCookCliError extends Schema.TaggedErrorClass<EpicCookCliError>()("EpicCookCliError", {
  operation: Schema.String,
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return this.detail;
  }
}

const decodeEpicRunConfigOverride = Schema.decodeUnknownEffect(EpicRunConfigOverride);

const optionalString = (name: string, description: string) =>
  Flag.string(name).pipe(Flag.withDescription(description), Flag.optional);

const deprecatedEnvironmentOverride = (
  environment: NodeJS.ProcessEnv,
  harness: TerminalHarness,
): unknown => ({
  ...(environment.T3CODE_EPIC_RUN_ENGINE === undefined && environment.COOKEPIC_ENGINE === undefined
    ? {}
    : {
        engine: environment.T3CODE_EPIC_RUN_ENGINE ?? environment.COOKEPIC_ENGINE,
      }),
  ...(environment.COOKEPIC_GATE === undefined && environment.COOKEPIC_NO_GATE === undefined
    ? {}
    : {
        gate: {
          ...(environment.COOKEPIC_GATE === undefined
            ? {}
            : { command: environment.COOKEPIC_GATE }),
          ...(environment.COOKEPIC_NO_GATE === undefined
            ? {}
            : { disabled: environment.COOKEPIC_NO_GATE === "1" }),
        },
      }),
  ...(environment.COOKEPIC_MAX_DISPATCHES === undefined
    ? {}
    : { limits: { maxIterations: Number(environment.COOKEPIC_MAX_DISPATCHES) } }),
  ...(environment.COOKEPIC_MAX_ATTEMPTS === undefined
    ? {}
    : {
        limits: {
          maxAttemptsPerChild: Number(environment.COOKEPIC_MAX_ATTEMPTS),
          ...(environment.COOKEPIC_MAX_DISPATCHES === undefined
            ? {}
            : { maxIterations: Number(environment.COOKEPIC_MAX_DISPATCHES) }),
        },
      }),
  ...(environment.COOKEPIC_WORKER_TIMEOUT === undefined &&
  environment.COOKEPIC_STOP_GRACE === undefined
    ? {}
    : {
        supervision: {
          ...(environment.COOKEPIC_WORKER_TIMEOUT === undefined
            ? {}
            : { workerTimeoutSeconds: Number(environment.COOKEPIC_WORKER_TIMEOUT) }),
          ...(environment.COOKEPIC_STOP_GRACE === undefined
            ? {}
            : { stopGraceSeconds: Number(environment.COOKEPIC_STOP_GRACE) }),
        },
      }),
  ...(environment.COOKEPIC_MODEL === undefined
    ? {}
    : { provider: { modelSelection: { instanceId: harness, model: environment.COOKEPIC_MODEL } } }),
  ...(environment.COOKEPIC_ORIENTATION_FILE === undefined
    ? {}
    : { orientation: { file: environment.COOKEPIC_ORIENTATION_FILE } }),
  ...(environment.COOKEPIC_NO_PUSH === undefined
    ? {}
    : { vcs: { noPush: environment.COOKEPIC_NO_PUSH === "1" } }),
  ...(environment.COOKEPIC_SIBLINGS === undefined && environment.COOKEPIC_WORKERS === undefined
    ? {}
    : {
        parallel: {
          ...(environment.COOKEPIC_SIBLINGS === undefined
            ? {}
            : {
                siblings: environment.COOKEPIC_SIBLINGS.split(/\s+/).filter(
                  (entry) => entry.length > 0,
                ),
              }),
          ...(environment.COOKEPIC_WORKERS === undefined
            ? {}
            : { workers: Number(environment.COOKEPIC_WORKERS) }),
        },
      }),
  // run.sh only ever passes "1" through; anything else is rejected there.
  ...(environment.COOKEPIC_SEQUENTIAL === undefined
    ? {}
    : { execution: { sequential: environment.COOKEPIC_SEQUENTIAL === "1" } }),
  ...(environment.COOKEPIC_PERMISSION_MODE === undefined
    ? {}
    : {
        runtime: {
          mode:
            environment.COOKEPIC_PERMISSION_MODE === "auto" ||
            environment.COOKEPIC_PERMISSION_MODE === "bypassPermissions"
              ? "full-access"
              : environment.COOKEPIC_PERMISSION_MODE,
        },
      }),
});

const selectHarness = (environment: NodeJS.ProcessEnv): TerminalHarness => {
  if (environment.COOKEPIC_WORKER_CMD) return "worker-cmd";
  const explicit = environment.COOKEPIC_HARNESS;
  if (
    explicit === "prime" ||
    explicit === "kimi" ||
    explicit === "claude" ||
    explicit === "ccx" ||
    explicit === "codex" ||
    explicit === "opencode"
  )
    return explicit;
  if (explicit !== undefined && explicit !== "auto") return "codex";
  if (environment.CLAUDECODE || environment.CLAUDE_CODE_ENTRYPOINT) return "claude";
  if (environment.KIMI_SESSION_ID) return "kimi";
  if (environment.OPENCODE_SESSION_ID) return "opencode";
  return "codex";
};

/**
 * The terminal execution shape, read from the resolved values alone. The pool
 * loop runs whenever execution is not sequential and `parallel.workers` is
 * above 1, so the shared default (`workers: 3`) is the terminal default too.
 * Two escapes select one worker in the base checkout: `execution.sequential`
 * (`COOKEPIC_SEQUENTIAL=1`), which the config policy also clamps to
 * `workers: 1`, and `parallel.workers: 1` (`COOKEPIC_WORKERS=1`).
 */
export const selectTerminalExecution = (snapshot: {
  readonly config: EpicRunConfig;
}): "sequential" | "parallel" =>
  !snapshot.config.execution.sequential && snapshot.config.parallel.workers > 1
    ? "parallel"
    : "sequential";

export const cookCommand = Command.make("cook", {
  epic: Flag.string("epic").pipe(Flag.withDescription("Beads epic id.")),
  cwd: Flag.string("cwd").pipe(Flag.withDescription("Repository root.")),
  runDir: optionalString("run-dir", "Artifact directory."),
  runId: optionalString(
    "run-id",
    "Continue this run id instead of minting a new one. Sequential engine only.",
  ),
  gate: optionalString("gate", "Integration gate command."),
  noGate: Flag.boolean("no-gate").pipe(
    Flag.withDescription("Explicitly disable the integration gate."),
    Flag.withDefault(false),
  ),
  maxIterations: Flag.integer("max-iterations").pipe(
    Flag.withSchema(PositiveInt),
    Flag.withDescription("Maximum provider dispatches."),
    Flag.optional,
  ),
  model: optionalString("model", "Harness model id."),
  engine: Flag.choice("engine", EpicRunEngine.literals).pipe(
    Flag.withDescription("Epic engine rollout selector."),
    Flag.optional,
  ),
  json: Flag.boolean("json").pipe(
    Flag.withDescription("Emit JSON events and final state."),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription("Cook an epic in this foreground process without a T3 Code server."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const gateFlag = Option.getOrUndefined(flags.gate);
      if (gateFlag !== undefined && flags.noGate) {
        return yield* new EpicCookCliError({
          operation: "epicCook.flags",
          detail: "--gate and --no-gate cannot be used together.",
        });
      }
      const cwd = NodePath.resolve(flags.cwd);
      const harness = selectHarness(process.env);
      if (
        process.env.T3CODE_EPIC_RUN_ENGINE !== undefined ||
        process.env.COOKEPIC_ENGINE !== undefined
      ) {
        yield* Effect.logWarning(
          "T3CODE_EPIC_RUN_ENGINE and COOKEPIC_ENGINE are deprecated. Use the epic-run config key engine instead.",
        );
      }
      const environmentOverride = yield* decodeEpicRunConfigOverride(
        deprecatedEnvironmentOverride(process.env, harness),
      ).pipe(
        Effect.mapError(
          (cause) =>
            new EpicCookCliError({
              operation: "epicCook.environment",
              detail: `Invalid deprecated COOKEPIC_* value: ${String(cause)}`,
              cause,
            }),
        ),
      );
      const flagOverride = yield* decodeEpicRunConfigOverride({
        ...(gateFlag === undefined && !flags.noGate
          ? {}
          : {
              gate: {
                ...(gateFlag === undefined ? {} : { command: gateFlag }),
                ...(gateFlag === undefined ? {} : { disabled: false }),
                ...(flags.noGate ? { disabled: true } : {}),
              },
            }),
        ...(Option.isNone(flags.maxIterations)
          ? {}
          : { limits: { maxIterations: flags.maxIterations.value } }),
        ...(Option.isNone(flags.model)
          ? {}
          : { provider: { modelSelection: { instanceId: harness, model: flags.model.value } } }),
        ...(Option.isNone(flags.engine) ? {} : { engine: flags.engine.value }),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new EpicCookCliError({ operation: "epicCook.flags", detail: String(cause), cause }),
        ),
      );

      const dependencies = Layer.mergeAll(
        ProcessRunner.layer,
        NodeEpicRunLock.layer,
        EpicRunConfigSource.layer,
      );
      const localLayer = Layer.merge(
        dependencies,
        EpicRunPreflight.layer.pipe(Layer.provide(dependencies)),
      );
      const result = yield* Effect.gen(function* () {
        const runner = yield* ProcessRunner.ProcessRunner;
        const lock = yield* EpicRunLock;
        const source = yield* EpicRunConfigSource.EpicRunConfigSource;
        const preflight = yield* EpicRunPreflight.EpicRunPreflight;
        const file = yield* source.read({ repoRoot: cwd });
        const resolved = resolveEpicRunConfig({
          file: file._tag === "loaded" ? file.override : null,
          environment: environmentOverride,
          override: flagOverride,
          harness,
        });
        const snapshot = { fileResult: file, ...resolved };
        if (!snapshot.config.gate.disabled && snapshot.config.gate.command === null) {
          return yield* new EpicCookCliError({
            operation: "epicCook.gate",
            detail: "A gate is required. Pass --gate <command> or explicitly pass --no-gate.",
          });
        }
        const modelSelection = snapshot.config.provider.modelSelection ?? {
          instanceId: ProviderInstanceId.make(harness),
          model:
            Option.getOrUndefined(flags.model) ??
            (harness === "prime"
              ? "default"
              : harness === "claude" || harness === "ccx"
                ? "sonnet"
                : harness === "kimi"
                  ? "kimi-code/k3"
                  : harness === "codex"
                    ? "gpt-5.6-sol"
                    : "default"),
        };
        // A given run id continues that run: the default run directory is a
        // pure function of the run id, so `--run-id` alone lands the restart on
        // the same journal the earlier process wrote.
        const runId =
          Option.getOrUndefined(flags.runId) ??
          `${flags.epic}-${Date.now().toString(36)}-${String(process.pid)}`;
        const runDirectory = NodePath.resolve(
          Option.getOrUndefined(flags.runDir) ??
            NodePath.join(cwd, ".git", "t3code", "epic-runs", runId),
        );
        const branchResult = yield* runner.run({
          command: "git",
          args: ["branch", "--show-current"],
          cwd,
        });
        if (branchResult.code !== 0 || branchResult.stdout.trim() === "") {
          return yield* new EpicCookCliError({
            operation: "epicCook.branch",
            detail: "Could not resolve the current branch.",
          });
        }
        // Provider health belongs to the workspace, not to one run: the whole
        // point is that the NEXT cook of this epic reads it. The common git
        // directory is the one path every worktree of this repo shares, and it
        // is never committed.
        const commonDirResult = yield* runner.run({
          command: "git",
          args: ["rev-parse", "--path-format=absolute", "--git-common-dir"],
          cwd,
        });
        if (commonDirResult.code !== 0 || commonDirResult.stdout.trim() === "") {
          return yield* new EpicCookCliError({
            operation: "epicCook.gitCommonDir",
            detail: "Could not resolve the git common directory.",
          });
        }
        const degradationsDirectory = NodePath.join(commonDirResult.stdout.trim(), "t3code");
        // Optional systemd scope governance for worker spawns. A colliding
        // pre-existing scope is fatal (run identity clash); every other
        // degradation warns and spawns unwrapped inside prepareWorkerScope.
        const workerScope = yield* prepareWorkerScope({
          repositoryPath: cwd,
          runDirectory,
          epicId: flags.epic,
          runId,
        }).pipe(
          Effect.mapError(
            (error) =>
              new EpicCookCliError({ operation: "epicCook.workerScope", detail: error.detail }),
          ),
        );
        // Where the dispatch publishes each worker's pid, liveness and
        // cumulative output bytes for liveness supervision to read back.
        const workerActivity = makeTerminalWorkerActivity();
        const terminalProviders = makeTerminalProviderSupport({
          harness,
          selection: modelSelection,
          ...(process.env.COOKEPIC_BIN === undefined ? {} : { binary: process.env.COOKEPIC_BIN }),
          ...(process.env.COOKEPIC_WORKER_CMD === undefined
            ? {}
            : { workerCommand: process.env.COOKEPIC_WORKER_CMD }),
          environment: process.env,
        });
        const settingsPath = resolveCookSettingsPath({
          environment: process.env,
          homeDirectory: NodeOS.homedir(),
        });
        const degradations = yield* FileRunJournal.makeProviderDegradations({
          directory: degradationsDirectory,
        });
        // Start past an account a previous cook of this epic already found
        // degraded, instead of burning one iteration rediscovering it.
        const start = yield* resolveCookModelSelection({
          settingsPath,
          inventory: terminalProviders.inventory,
          readProviderDegradations: degradations.readProviderDegradations,
          selection: modelSelection,
          providerDegradationTtlMs: snapshot.config.server.providerDegradationTtlMs,
        });
        const startSelection = start.selection;
        for (const hop of start.hops) {
          yield* Effect.logInfo("epic.cook.launch-provider-fallback", {
            fromInstanceId: hop.from.instanceId,
            toInstanceId: hop.to.instanceId,
            reason: hop.reason,
          });
        }
        // The injected in-session roles, read from the same settings file the
        // server runner uses. Only the claude/ccx arm emits them, as `--agents`;
        // every other harness ignores the map.
        const subagents = yield* readCookSubagents({
          settingsPath,
          inventory: terminalProviders.inventory,
          sessionSelection: startSelection,
        });
        const agentDispatch = makeTerminalAgentDispatch({
          harness,
          artifactsDirectory: runDirectory,
          subagents,
          ...(process.env.COOKEPIC_BIN === undefined ? {} : { binary: process.env.COOKEPIC_BIN }),
          ...(process.env.COOKEPIC_WORKER_CMD === undefined
            ? {}
            : { workerCommand: process.env.COOKEPIC_WORKER_CMD }),
          ...(process.env.COOKEPIC_PERMISSION_MODE === undefined
            ? {}
            : { permissionMode: process.env.COOKEPIC_PERMISSION_MODE }),
          useHarnessDefaultModel: snapshot.config.provider.modelSelection === null,
          providerRoutes: terminalProviders.routes,
          ...makeDispatchSupervisionOptions(snapshot.config.supervision),
          workerScope,
          workerActivity,
        });
        const fileEvents = makeFileRunEvents({
          runDirectory,
          ...(flags.json ? { stdout: (line) => process.stdout.write(`${line}\n`) } : {}),
        });
        const readOrientation = (targetCwd: string, configured: string | null) =>
          Effect.tryPromise({
            try: async () => {
              const candidates =
                configured === null ? ["docs/agent-orientation.md", "AGENTS.md"] : [configured];
              for (const candidate of candidates) {
                try {
                  return await NodeFSP.readFile(NodePath.join(targetCwd, candidate), "utf8");
                } catch {}
              }
              return "(no orientation card in this repo)";
            },
            catch: (cause) =>
              new EpicCookCliError({
                operation: "epicCook.orientation",
                detail: String(cause),
                cause,
              }),
          });
        let stop = false;
        const shouldStop = () =>
          Effect.tryPromise({
            try: async () =>
              stop ||
              (await NodeFSP.access(NodePath.join(runDirectory, "STOP")).then(
                () => true,
                () => false,
              )),
            catch: (cause) =>
              new EpicCookCliError({
                operation: "epicCook.stop",
                detail: String(cause),
                cause,
              }),
          }).pipe(Effect.orElseSucceed(() => stop));

        /**
         * The parallel terminal cook: the same pool loop the server runner
         * drives, over file-backed terminal ports. The pool loop consumes an
         * existing run row, so this creates it — mirroring the sequential
         * loop's row, with the configured worker cap — and reconciles the
         * printed result from the journal after the loop returns.
         */
        const runParallelCook = Effect.gen(function* () {
          const preflightResult = yield* preflight
            .check({ workspaceRoot: cwd, epicId: flags.epic, mode: "parallel" }, snapshot)
            .pipe(
              Effect.mapError(
                (cause) =>
                  new EpicCookCliError({
                    operation: "preflight",
                    detail: cause instanceof Error ? cause.message : String(cause),
                    cause,
                  }),
              ),
            );
          if (!preflightResult.ok) {
            return yield* new EpicCookCliError({
              operation: "preflight",
              detail: preflightResult.blockers.map((blocker) => blocker._tag).join(", "),
            });
          }
          const lease = yield* lock
            .acquire({
              workspaceRoot: cwd,
              epicId: flags.epic,
              owner: `t3-epic-cook-${String(process.pid)}`,
              runDir: runDirectory,
            })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new EpicCookCliError({
                    operation: "acquire-lock",
                    detail: cause instanceof Error ? cause.message : String(cause),
                    cause,
                  }),
              ),
            );

          const body = Effect.gen(function* () {
            const now = () => new Date().toISOString();
            const journal = yield* FileRunJournal.makePool({
              runDirectory,
              degradationsDirectory,
            });
            const events: PoolRunEventsShape = {
              publish: (event) =>
                fileEvents
                  .publish(event)
                  .pipe(
                    Effect.mapError(
                      (cause) => new EpicRunnerStoreError({ operation: "events.publish", cause }),
                    ),
                  ),
            };
            const run: PersistedEpicRun = {
              runId: EpicRunId.make(runId),
              epicId: flags.epic,
              projectId: ProjectId.make(`local-${flags.epic}`),
              cwd,
              prompt: epicRunIterationPrompt({ pushEnabled: !snapshot.config.vcs.noPush }),
              orientationFile: snapshot.config.orientation.file,
              modelSelection: startSelection,
              runtimeMode: snapshot.config.runtime.mode,
              config: snapshot.config,
              configProvenance: snapshot.provenance,
              originThreadId: null,
              status: "running",
              maxIterations: snapshot.config.limits.maxIterations,
              workers: snapshot.config.parallel.workers,
              iterationsDispatched: 0,
              iterationsCompleted: 0,
              currentThreadId: null,
              currentTurnStartedAt: null,
              consecutiveFailures: 0,
              noCommitStreak: 0,
              infraStreak: 0,
              lastError: null,
              createdAt: now(),
              updatedAt: now(),
            };
            yield* journal.createRun(run);
            yield* events.publish({ type: "run-state-changed", run });

            const mergeQueueStore = yield* makeFileMergeQueueStore({ runDirectory });
            const gateReceipts = yield* FileGateReceipts.make({ runDirectory });
            const workspace = makeTerminalPoolWorkspace({
              processRunner: runner,
              journal,
              mergeQueueStore,
              worktreesRoot: NodePath.join(runDirectory, "worktrees"),
            });
            const ports: ParallelEpicLoopPorts = {
              journal,
              events,
              backlog: makeProcessPoolBacklog(runner),
              workspace,
              dispatch: makeTerminalPoolDispatch({ dispatch: agentDispatch }),
              mergeDrain: makeTerminalMergeDrain({
                processRunner: runner,
                journal,
                mergeQueueStore,
                gate: makeProcessGate({
                  processRunner: runner,
                  environment: process.env,
                  uid: process.getuid?.() ?? 0,
                }),
                gateReceipts,
                repair: makeProcessMergeRepair({
                  processRunner: runner,
                  environment: process.env,
                  uid: process.getuid?.() ?? 0,
                }),
              }),
              vcs: makeProcessPoolVcs(runner),
              providerInventory: terminalProviders.inventory,
              roleSelection: null,
              /**
               * The terminal worker key is the artifact path, so evidence is
               * resolved through `workerActivity` — the same map the dispatch
               * writes the worker's pid and output bytes into — rather than
               * through the server's thread-id scope registry.
               */
              workerEvidence: makeTerminalWorkerEvidence({
                processRunner: runner,
                activity: workerActivity,
                /**
                 * The inspector runs on the same harness and account as the
                 * run, in the coordinator checkout rather than any worktree.
                 * A harness that cannot deny a subagent its tools gets no
                 * inspector, and the machine records an uncertain reason.
                 */
                ...(harnessSupportsInspector(harness)
                  ? {
                      inspector: {
                        runAuxiliary: agentDispatch.runAuxiliary,
                        selection: startSelection,
                        cwd,
                      },
                    }
                  : {}),
              }),
            };
            // The terminal seed mirrors the server layer's defaults
            // (`EpicRunner.ts`); a persisted non-default run config replaces
            // each matching value inside makePoolPolicy.
            const policySeed: PoolPolicySeed = {
              iterationTimeoutMs: DEFAULT_ITERATION_TIMEOUT_MS,
              runStallTimeoutMs: DEFAULT_RUN_STALL_TIMEOUT_MS,
              pollIntervalMs: DEFAULT_POOL_POLL_INTERVAL_MS,
              quietPeriodMs: DEFAULT_POOL_QUIET_PERIOD_MS,
              retryBaseDelayMs: DEFAULT_RETRY_BASE_DELAY_MS,
              retryMaxDelayMs: DEFAULT_RETRY_MAX_DELAY_MS,
              maxConsecutiveFailures: DEFAULT_MAX_CONSECUTIVE_FAILURES,
              maxNoCommitStreak: DEFAULT_MAX_NO_COMMIT_STREAK,
              infraFailureBudget: DEFAULT_INFRA_FAILURE_BUDGET,
              subagentGraceTimeoutMs: DEFAULT_SUBAGENT_GRACE_TIMEOUT_MS,
              maxGraceContinuations: DEFAULT_MAX_GRACE_CONTINUATIONS,
            };
            const policy = makePoolPolicy(policySeed, run);
            const transitions = yield* Semaphore.make(1);
            const withTransition = transitions.withPermits(1);
            const signals = yield* Queue.unbounded<PoolSchedulerEvent>();

            // The pool loop has no shouldStop hook: a stop request becomes a
            // cancelled run row, exactly like a server cancel, and the loop
            // winds down after the in-flight workers settle.
            const watcher = yield* Effect.gen(function* () {
              for (;;) {
                yield* Effect.sleep(Duration.millis(500));
                if (!(yield* shouldStop())) continue;
                yield* withTransition(
                  Effect.gen(function* () {
                    const current = yield* journal.getRun(run.runId);
                    if (Option.isNone(current) || current.value.status !== "running") return;
                    const cancelled: PersistedEpicRun = {
                      ...current.value,
                      status: "cancelled",
                      lastError: "cancelled",
                      updatedAt: now(),
                    };
                    yield* journal.saveRun(cancelled);
                    yield* events.publish({ type: "run-state-changed", run: cancelled });
                  }),
                ).pipe(
                  Effect.catchCause((cause) =>
                    Effect.logWarning("epic.cook.stop-request-failed", { runId, cause }),
                  ),
                );
                return;
              }
            }).pipe(Effect.forkChild);

            const loopBody = Effect.gen(function* () {
              const loopExit = yield* Effect.exit(
                runParallelEpicLoop(
                  {
                    runId: run.runId,
                    epicId: flags.epic,
                    cwd,
                    policy,
                    withTransition,
                    signals,
                    readOrientation: (targetCwd, configuredPath) =>
                      readOrientation(targetCwd, configuredPath).pipe(
                        Effect.orElseSucceed(() => "(no orientation card in this repo)"),
                      ),
                    cleanupOwnedExternally: () => false,
                  },
                  ports,
                ),
              );
              if (Exit.isFailure(loopExit)) {
                // The loop died on an unexpected error: mark the run failed,
                // then clean the integration up here — the core's own
                // finalizer skips it for a non-terminal run.
                const failure = Cause.findErrorOption(loopExit.cause);
                const detail = Option.isSome(failure)
                  ? failure.value.message
                  : Cause.pretty(loopExit.cause);
                const current = yield* journal
                  .getRun(run.runId)
                  .pipe(Effect.orElseSucceed(() => Option.none()));
                if (Option.isSome(current)) {
                  const failed: PersistedEpicRun = {
                    ...current.value,
                    status: "failed",
                    lastError: detail,
                    currentThreadId: null,
                    currentTurnStartedAt: null,
                    updatedAt: now(),
                  };
                  yield* journal.saveRun(failed).pipe(Effect.ignore);
                  yield* events
                    .publish({ type: "run-state-changed", run: failed })
                    .pipe(Effect.ignore);
                }
                yield* workspace.releaseIntegration(
                  {
                    runId: run.runId,
                    epicId: flags.epic,
                    projectId: run.projectId,
                    cwd,
                  },
                  "failed",
                );
                return yield* new EpicCookCliError({
                  operation: "epicCook.parallel",
                  detail,
                });
              }
              const finalRun = yield* journal.getRun(run.runId);
              if (Option.isNone(finalRun)) {
                return yield* new EpicCookCliError({
                  operation: "epicCook.parallel",
                  detail: `Run ${runId} vanished from its journal.`,
                });
              }
              return finalRun.value;
            });
            return yield* loopBody.pipe(Effect.ensuring(Fiber.interrupt(watcher)));
          });
          return yield* body.pipe(Effect.ensuring(lease.release.pipe(Effect.ignore)));
        });

        const requestStop = () => {
          stop = true;
        };
        process.once("SIGINT", requestStop);
        process.once("SIGTERM", requestStop);
        try {
          if (selectTerminalExecution(snapshot) === "parallel") {
            return yield* Effect.uninterruptible(runParallelCook);
          }
          const journal = yield* FileRunJournal.make({ runDirectory });
          const gateReceipts = yield* FileGateReceipts.make({ runDirectory });
          // Sequential siblings are the real checkouts, validated with layout
          // mirroring off.
          const siblingRefs = yield* makeSiblingResolver(runner.run)
            .resolveSiblings({
              cwd,
              siblings: snapshot.config.parallel.siblings,
              pushEnabled: !snapshot.config.vcs.noPush,
              layoutMode: false,
            })
            .pipe(
              Effect.mapError(
                (error) =>
                  new EpicCookCliError({
                    operation: "epicCook.siblings",
                    detail: error.detail,
                    cause: error,
                  }),
              ),
            );
          return yield* Effect.uninterruptible(
            runSequentialEpicLoop(
              {
                runId,
                epicId: flags.epic,
                cwd,
                runDirectory,
                repository: {
                  repositoryPath: cwd,
                  baseBranch: branchResult.stdout.trim(),
                  worktreeRoot: NodePath.join(runDirectory, "worktrees"),
                  siblings: siblingRefs.map((sibling) => ({
                    repositoryPath: sibling.canonicalPath,
                    baseBranch: sibling.baseBranch,
                    worktreeRoot: sibling.canonicalPath,
                  })),
                },
                selection: startSelection,
                configSnapshot: snapshot,
                readOrientation: (configured) => readOrientation(cwd, configured),
                shouldStop,
              },
              {
                preflight,
                lock,
                backlog: makeProcessBacklog({ repositoryPath: cwd, processRunner: runner }),
                journal,
                providerDegradation: degradations,
                providerInventory: terminalProviders.inventory,
                roleSelection: null,
                events: fileEvents,
                dispatch: agentDispatch,
                gate: makeProcessGate({
                  processRunner: runner,
                  environment: process.env,
                  uid: process.getuid?.() ?? 0,
                }),
                gateReceipts,
                vcs: makeProcessVcs({ processRunner: runner }),
              },
            ),
          );
        } finally {
          process.removeListener("SIGINT", requestStop);
          process.removeListener("SIGTERM", requestStop);
        }
      }).pipe(Effect.provide(localLayer));
      yield* Console.log(
        flags.json
          ? JSON.stringify(result)
          : `${result.runId}\t${result.status}\t${result.iterationsCompleted}/${result.maxIterations}`,
      );
      if (result.status !== "done" && result.status !== "cancelled") {
        return yield* new EpicCookCliError({
          operation: "epicCook",
          detail: result.lastError ?? `Run ended ${result.status}.`,
        });
      }
    }),
  ),
);
