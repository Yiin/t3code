// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalProcess:off preferSchemaOverJson:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  DEFAULT_EPIC_RUN_CONFIG,
  DEFAULT_EPIC_RUN_CONFIG_PROVENANCE,
  EpicRunId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  diffTranscripts,
  type EpicRunConfig,
  type EpicRunTranscriptEvent,
  type ServerProvider,
} from "@t3tools/contracts";
import * as EpicRunPreflight from "@t3tools/epic-core/EpicRunPreflight";
import * as EpicRunConfigSource from "@t3tools/epic-core/EpicRunConfigSource";
import {
  runParallelEpicLoop,
  type ParallelEpicLoopPorts,
  type PoolSchedulerEvent,
  type ResumedWorker,
} from "@t3tools/epic-core/ParallelEpicLoop";
import {
  runSequentialEpicLoop,
  type SequentialEpicLoopPorts,
} from "@t3tools/epic-core/SequentialEpicLoop";
import { make as makeFileGateReceipts } from "@t3tools/epic-core/adapters/FileGateReceipts";
import { makeFileMergeQueueStore } from "@t3tools/epic-core/adapters/FileMergeQueueStore";
import * as FileRunJournal from "@t3tools/epic-core/adapters/FileRunJournal";
import * as NodeEpicRunLock from "@t3tools/epic-core/adapters/NodeEpicRunLock";
import { makeProcessBacklog } from "@t3tools/epic-core/adapters/ProcessBacklog";
import { makeProcessGate } from "@t3tools/epic-core/adapters/ProcessGate";
import { makeProcessMergeRepair } from "@t3tools/epic-core/adapters/ProcessMergeRepair";
import { makeProcessPoolBacklog } from "@t3tools/epic-core/adapters/ProcessPoolBacklog";
import { makeProcessPoolVcs } from "@t3tools/epic-core/adapters/ProcessPoolVcs";
import { makeProcessVcs } from "@t3tools/epic-core/adapters/ProcessVcs";
import { makeTerminalAgentDispatch } from "@t3tools/epic-core/adapters/TerminalAgentDispatch";
import { makeTerminalMergeDrain } from "@t3tools/epic-core/adapters/TerminalMergeDrain";
import { makeTerminalPoolDispatch } from "@t3tools/epic-core/adapters/TerminalPoolDispatch";
import { makeTerminalPoolWorkspace } from "@t3tools/epic-core/adapters/TerminalPoolWorkspace";
import { makeTerminalProviderSupport } from "@t3tools/epic-core/adapters/TerminalProviderSupport";
import * as ProcessRunner from "@t3tools/epic-core/processRunner";
import { DEFAULT_MAX_NO_COMMIT_STREAK, epicRunIterationPrompt } from "@t3tools/epic-core/policy";
import { makePoolPolicy, type PoolPolicySeed } from "@t3tools/epic-core/runPolicy";
import { DEFAULT_RUN_STALL_TIMEOUT_MS } from "@t3tools/epic-core/runStall";
import { EpicRunLock } from "@t3tools/epic-core/ports/EpicRunLock";
import type { RunEvent } from "@t3tools/epic-core/ports/RunEvents";
import type { PersistedEpicRun } from "@t3tools/epic-core/ports/RunJournal";
import type { WorkerEvidenceShape, WorkerRef } from "@t3tools/epic-core/ports/WorkerEvidence";
import type { IterationWorkspace, WorkspaceShape } from "@t3tools/epic-core/ports/Workspace";
import type { SupervisionClock } from "@t3tools/epic-core/workerSupervision";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Semaphore from "effect/Semaphore";

import { normalizeParallelTranscript, type ParallelIterationRecord } from "./parallelTranscript.ts";
import {
  decodeConformanceScenario,
  isParallelScenario,
  scenarioWorkers,
  type ConformanceScenario,
} from "./scenario.ts";
import {
  beadCommentCounts,
  landedChildIds,
  makeConformanceWorkspace,
  releasedClaimIds,
  type ConformanceWorkspace,
} from "./workspace.ts";

const packageDirectory = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "..",
);
const scenariosDirectory = NodePath.join(packageDirectory, "scenarios");

const scenarios = (): ReadonlyArray<ConformanceScenario> =>
  NodeFS.readdirSync(scenariosDirectory)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) =>
      decodeConformanceScenario(
        JSON.parse(NodeFS.readFileSync(NodePath.join(scenariosDirectory, name), "utf8")),
      ),
    )
    .filter((scenario) => scenario.appliesTo.includes("core"));

const maximumIterations = (scenario: ConformanceScenario): number => {
  const attempts = scenario.expectedTranscript.flatMap((event) =>
    event.attempts === undefined ? [] : [event.attempts],
  );
  const iterationIndexes = scenario.expectedTranscript.flatMap((event) =>
    event.iterationIndex === null ? [] : [event.iterationIndex + 1],
  );
  return Math.max(1, scenario.agentScript.length, ...attempts, ...iterationIndexes);
};

const provider = (instanceId: string, driver: string, model: string): ServerProvider => ({
  instanceId: ProviderInstanceId.make(instanceId),
  driver: ProviderDriverKind.make(driver),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-01-01T00:00:00Z",
  availability: "available",
  models: [{ slug: model, name: model, isCustom: false, capabilities: null }],
  slashCommands: [],
  skills: [],
});

const conformanceProviders = [
  provider("claude", "claudeAgent", "sonnet"),
  provider("codex", "codex", "gpt-5.6-sol"),
  provider("kimi", "kimi", "kimi-code/k3"),
] as const;

const transcriptProvider = (driver: string): string =>
  driver === "claudeAgent" ? "claude" : driver;

/**
 * The only scenarios that assert on `infra:timeout`, and so the only ones
 * that need a worker deadline short enough to trip. Every other scenario
 * inheriting a 500 ms budget just races host load: the fixture worker gets
 * killed mid-write and leaves a dirty tree, which surfaces as a bogus
 * `child:dirty-worktree` divergence when the suite runs under contention.
 */
const TIMEOUT_SCENARIOS = new Set(["infra-failure-budget", "iteration-timeout"]);

const workerDeadlineSeconds = (scenario: ConformanceScenario): number =>
  TIMEOUT_SCENARIOS.has(scenario.name) ? 0.5 : 15;

const FIXTURE_TIME = "2026-01-01T00:00:00.000Z";

/**
 * Every value the pool leg sets counts as configured.
 *
 * `makePoolPolicy` only honours a run-config value whose provenance is not
 * `default`, so a fixture that left this alone would silently run on the
 * shipped two-second poll and thirty-minute worker deadline.
 */
const poolProvenance = Object.fromEntries(
  Object.keys(DEFAULT_EPIC_RUN_CONFIG_PROVENANCE).map((key) => [key, "file" as const]),
);

const compressedConfig = (scenario: ConformanceScenario): EpicRunConfig => ({
  ...DEFAULT_EPIC_RUN_CONFIG,
  gate: { command: "true", disabled: false },
  vcs: { noPush: true, runOwnedBaseBranch: false },
  execution: { sequential: !isParallelScenario(scenario) },
  parallel: { ...DEFAULT_EPIC_RUN_CONFIG.parallel, workers: scenarioWorkers(scenario) },
  limits: {
    ...DEFAULT_EPIC_RUN_CONFIG.limits,
    maxIterations: maximumIterations(scenario),
  },
  supervision: {
    ...DEFAULT_EPIC_RUN_CONFIG.supervision,
    // The persisted schema stores whole seconds. The dispatcher below uses
    // the sub-second deadline for the scenarios that assert on it.
    workerTimeoutSeconds: Math.max(1, Math.ceil(workerDeadlineSeconds(scenario))),
    stopGraceSeconds: 1,
    // Compressed inspection cadence for the supervision scenarios, so the
    // machine reaches its verdict in a handful of simulated minutes. The
    // clock below is fake, so these are counted, not waited out.
    ...(scenario.supervision === undefined
      ? {}
      : { idleThresholdSeconds: 30, inspectMinDelaySeconds: 5, inspectRetryDelaySeconds: 10 }),
  },
  server: {
    ...DEFAULT_EPIC_RUN_CONFIG.server,
    maxNoCommitStreak: DEFAULT_MAX_NO_COMMIT_STREAK,
    pollIntervalMs: 5,
    quietPeriodMs: 5,
    retryBaseDelayMs: 5,
    retryMaxDelayMs: 5,
  },
});

/**
 * The scenario's liveness evidence: the first worker reads as wedged, every
 * later one as busy.
 *
 * Only the platform sampling is faked. The machine, its cadence, the stop
 * decision and everything the loop does with the verdict are the shipped ones
 * — `makeTerminalWorkerEvidence` is what a real cook wires here, and it reads
 * cgroup counters this fixture has no honest way to produce. The wedged
 * numbers are the 2026-08-09 incident's: no output, no CPU, no I/O, an
 * unchanged repository and an unchanged process histogram.
 */
const wedgeFirstWorkerEvidence = (): WorkerEvidenceShape => {
  let wedgedWorker: string | null = null;
  let busyTicks = 0;
  const condemned = JSON.stringify({
    decision: "stop",
    confidence: "high",
    rationale: "every process is asleep and the repository has not changed",
  });
  const isWedged = (ref: WorkerRef): boolean => {
    wedgedWorker ??= ref.worker;
    return wedgedWorker === ref.worker;
  };
  return {
    inspectorSupported: true,
    sampleSignals: (ref) =>
      Effect.sync(() => {
        if (isWedged(ref)) return { isActive: true, outputBytes: 0, cpuUsec: 0, ioBytes: 0 };
        busyTicks += 1;
        // Strictly growing, so the machine never calls a healthy worker idle
        // and its supervision never completes.
        return {
          isActive: true,
          outputBytes: busyTicks * 4_096,
          cpuUsec: busyTicks * 1_000_000,
          ioBytes: busyTicks * 8_192,
        };
      }),
    probeRepository: (ref) =>
      Effect.succeed(isWedged(ref) ? "deadbeef hash=stable" : `hash=${String(busyTicks)}`),
    processFingerprint: (ref) =>
      Effect.succeed(isWedged(ref) ? "fingerprint-a" : `fingerprint-${String(busyTicks)}`),
    providerFallbackPending: Effect.succeed(false),
    launchInspector: () => Effect.void,
    inspectorStatus: () =>
      Effect.succeed({
        _tag: "finished",
        rc: 0,
        result: { text: condemned, byteSize: condemned.length, overflowed: false },
      }),
    stopInspector: () => Effect.void,
  };
};

/**
 * The supervision cadence's clock: counted, not waited out.
 *
 * A real idle window is half an hour; these ticks cost twenty milliseconds
 * each. The real sleep is not the wait — it is the yield. A healthy worker is
 * supervised for its whole turn, and at one millisecond that loop starved the
 * fixture agent it was watching until the run's own deadline killed it.
 */
const compressedSupervisionClock = (): SupervisionClock => {
  let now = 0;
  return {
    nowSeconds: Effect.sync(() => now),
    sleepSeconds: (seconds) =>
      Effect.sleep(Duration.millis(20)).pipe(
        Effect.andThen(
          Effect.sync(() => {
            now += seconds;
          }),
        ),
      ),
  };
};

const stateChildren = (workspace: ConformanceWorkspace): ReadonlyArray<Record<string, unknown>> => {
  const statePath = workspace.env["CONFORMANCE_STATE"];
  if (statePath === undefined) return [];
  const state = JSON.parse(NodeFS.readFileSync(statePath, "utf8")) as {
    readonly children?: ReadonlyArray<Record<string, unknown>>;
  };
  return state.children ?? [];
};

const stateEpicStatus = (workspace: ConformanceWorkspace): string | undefined => {
  const statePath = workspace.env["CONFORMANCE_STATE"];
  if (statePath === undefined) return undefined;
  const state = JSON.parse(NodeFS.readFileSync(statePath, "utf8")) as {
    readonly epic?: Readonly<Record<string, unknown>>;
  };
  return typeof state.epic?.["status"] === "string" ? state.epic["status"] : undefined;
};

const translateCoreEvents = (input: {
  readonly scenario: ConformanceScenario;
  readonly workspace: ConformanceWorkspace;
  readonly events: ReadonlyArray<RunEvent>;
  readonly dispatchSelections: ReadonlyMap<number, ProviderInstanceId>;
}): ReadonlyArray<EpicRunTranscriptEvent> => {
  const output: EpicRunTranscriptEvent[] = [];
  const settled = input.events.filter(
    (event): event is Extract<RunEvent, { readonly type: "iteration-state-changed" }> =>
      event.type === "iteration-state-changed" && event.iteration.turnStatus !== "running",
  );
  const dispatched = new Set(
    input.events.flatMap((event) =>
      event.type === "iteration-state-changed" && event.iteration.turnStatus === "running"
        ? [event.iteration.iterationIndex]
        : [],
    ),
  );
  const finalRun = input.events.findLast(
    (event): event is Extract<RunEvent, { readonly type: "run-state-changed" }> =>
      event.type === "run-state-changed",
  )?.run;
  const releasedClaims = new Map(
    input.events.flatMap((event) =>
      event.type === "child-claim-released"
        ? [[`${String(event.iterationIndex)}\0${event.issueId}`, event] as const]
        : [],
    ),
  );
  const providerFallbacks = new Map(
    input.events.flatMap((event) =>
      event.type === "provider-fallback" ? [[event.iterationIndex, event] as const] : [],
    ),
  );
  const childAttempts = new Map<string, number>();
  let infraAttempts = 0;
  let recoveredExhaustion = false;
  const comments = new Map(
    stateChildren(input.workspace).flatMap((child) => {
      const id = typeof child["id"] === "string" ? child["id"] : undefined;
      const count = typeof child["comment_count"] === "number" ? child["comment_count"] : 0;
      return id === undefined ? [] : [[id, count] as const];
    }),
  );

  for (const [index, event] of settled.entries()) {
    const iteration = event.iteration;
    const issueId = iteration.issueId;
    const common = {
      sequence: output.length,
      epicId: input.scenario.beads.epicId,
      issueId,
      iterationIndex: iteration.iterationIndex,
      pushed: false,
      verified: true,
    };
    const providerFallback = providerFallbacks.get(iteration.iterationIndex);
    if (providerFallback !== undefined) {
      output.push({
        _tag: "provider-fallback",
        ...common,
        fromProvider: transcriptProvider(providerFallback.fromDriver),
        toProvider: transcriptProvider(providerFallback.toDriver),
      });
      continue;
    }
    if (iteration.turnStatus === "completed") {
      if (iteration.headBefore === iteration.headAfter) {
        output.push({
          _tag: "completed-no-code",
          ...common,
          comments: issueId === null ? 0 : (comments.get(issueId) ?? 0),
        });
      } else {
        if (dispatched.has(iteration.iterationIndex)) {
          const selection = input.dispatchSelections.get(iteration.iterationIndex);
          const selectedProvider = conformanceProviders.find(
            (provider) => provider.instanceId === selection,
          );
          output.push({
            _tag: "dispatched",
            ...common,
            sequence: output.length,
            ...(selectedProvider === undefined
              ? {}
              : { toProvider: transcriptProvider(selectedProvider.driver) }),
          });
        }
        if (providerFallbacks.size > 0) continue;
        output.push({ _tag: "done", ...common, sequence: output.length });
      }
      continue;
    }

    const failure = iteration.failureReason ?? "infra:turn-error";
    const isInfra = failure.startsWith("infra:");
    const attempts = isInfra
      ? ++infraAttempts
      : issueId === null
        ? 1
        : (childAttempts.set(issueId, (childAttempts.get(issueId) ?? 0) + 1),
          childAttempts.get(issueId)!);
    const last = index === settled.length - 1;
    const recovery =
      issueId === null
        ? undefined
        : releasedClaims.get(`${String(iteration.iterationIndex)}\0${issueId}`);
    if (!last || finalRun?.status === "running") {
      output.push({ _tag: "retry", ...common, failureReason: failure, attempts });
      continue;
    }
    if (recovery !== undefined) {
      recoveredExhaustion = true;
      output.push({
        _tag: "blocked",
        ...common,
        failureReason: failure,
        attempts,
        reason: recovery.reason,
      });
    } else if (finalRun?.lastError?.startsWith("gutter:")) {
      output.push({ _tag: "blocked", ...common, reason: "no-commit gutter", attempts });
    } else if (finalRun?.lastError?.startsWith("infra:")) {
      // The exhausted infrastructure attempt is represented by the terminal
      // run decision below, not by a second event for the same decision.
    } else if (
      settled.length === 1 &&
      maximumIterations(input.scenario) === 1 &&
      failure === "infra:timeout"
    ) {
      output.push({
        _tag: "iteration-state-changed",
        ...common,
        turnStatus: "failed",
        failureReason: failure,
      });
    } else {
      output.push(
        settled.length === 1 && maximumIterations(input.scenario) === 1
          ? { _tag: "retry", ...common, failureReason: failure }
          : { _tag: "blocked", ...common, failureReason: failure, attempts },
      );
    }
  }

  if (finalRun?.status === "done" && output.some((event) => event._tag === "done")) {
    output.push({
      _tag: "finished",
      sequence: output.length,
      epicId: input.scenario.beads.epicId,
      issueId: null,
      iterationIndex: null,
      status: "done",
      pushed: false,
      verified: true,
    });
  } else if (finalRun?.status === "failed" && finalRun.lastError?.startsWith("infra:")) {
    output.push({
      _tag: "finished",
      sequence: output.length,
      epicId: input.scenario.beads.epicId,
      issueId: null,
      iterationIndex: null,
      status: "failed",
      reason: "infra failure budget",
      attempts: finalRun.infraStreak,
      pushed: false,
      verified: true,
    });
  } else if (
    !recoveredExhaustion &&
    finalRun?.status === "failed" &&
    finalRun.consecutiveFailures >= DEFAULT_EPIC_RUN_CONFIG.server.maxConsecutiveFailures
  ) {
    output.push({
      _tag: "finished",
      sequence: output.length,
      epicId: input.scenario.beads.epicId,
      issueId: null,
      iterationIndex: null,
      status: "failed",
      reason: "child failure budget",
      pushed: false,
      verified: true,
    });
  }
  return output;
};

const translatePreflightFailure = (input: {
  readonly scenario: ConformanceScenario;
  readonly workspace: ConformanceWorkspace;
  readonly failure: unknown;
}): ReadonlyArray<EpicRunTranscriptEvent> => {
  const common = {
    sequence: 0,
    epicId: input.scenario.beads.epicId,
    issueId: null,
    iterationIndex: null,
    pushed: false,
    verified: true,
  };
  const detail = input.failure instanceof Error ? input.failure.message : String(input.failure);
  if (detail.includes("run_in_progress")) {
    return [
      {
        _tag: "lock_held",
        ...common,
        ...(stateEpicStatus(input.workspace) === "in_progress"
          ? { reason: "run in progress" }
          : {}),
      },
    ];
  }
  if (detail.includes("epic_not_found"))
    return [{ _tag: "finished", ...common, status: "failed", reason: "epic not found" }];
  if (detail.includes("detached_head"))
    return [{ _tag: "finished", ...common, status: "failed", reason: "detached head" }];
  if (detail.includes("dirty_tree"))
    return [{ _tag: "finished", ...common, status: "failed", reason: "dirty tree" }];
  throw new Error(`unexpected core failure for ${input.scenario.name}: ${detail}`);
};

const runCoreScenario = Effect.fn("runCoreScenario")(function* (scenario: ConformanceScenario) {
  const workspace = makeConformanceWorkspace(scenario);
  const runDirectory = NodePath.join(NodePath.dirname(workspace.cwd), "run");
  const executed = yield* Effect.gen(function* () {
    const baseRunner = yield* ProcessRunner.ProcessRunner;
    const runner = ProcessRunner.ProcessRunner.of({
      run: (input) =>
        baseRunner.run({
          ...input,
          command:
            input.command === "git"
              ? (workspace.env["CONFORMANCE_REAL_GIT"] ?? input.command)
              : input.command,
          env: { ...process.env, ...workspace.env, ...input.env },
          extendEnv: false,
        }),
    });
    const runnerLayer = Layer.succeed(ProcessRunner.ProcessRunner, runner);
    const dependencies = Layer.mergeAll(
      runnerLayer,
      NodeEpicRunLock.layer,
      EpicRunConfigSource.layer,
    );
    const localLayer = Layer.merge(
      dependencies,
      EpicRunPreflight.layer.pipe(Layer.provide(dependencies)),
    );
    const events: RunEvent[] = [];
    const dispatchSelections = new Map<number, ProviderInstanceId>();
    return yield* Effect.gen(function* () {
      const lock = yield* EpicRunLock;
      const preflight = yield* EpicRunPreflight.EpicRunPreflight;
      const journal = yield* FileRunJournal.make({ runDirectory });
      const providerScenario = scenario.name === "provider-fallback-persists";
      const initialSelection = providerScenario
        ? { instanceId: ProviderInstanceId.make("claude"), model: "sonnet" }
        : { instanceId: ProviderInstanceId.make("worker-cmd"), model: "fixture" };
      const harness = providerScenario ? ("claude" as const) : ("worker-cmd" as const);
      const providerSupport = makeTerminalProviderSupport({
        harness,
        selection: initialSelection,
        workerCommand: NodePath.join(workspace.binDir, "agent"),
        environment: workspace.env,
      });
      const terminalDispatch = makeTerminalAgentDispatch({
        harness,
        artifactsDirectory: runDirectory,
        workerCommand: NodePath.join(workspace.binDir, "agent"),
        providerRoutes: providerSupport.routes,
        timeoutSeconds: workerDeadlineSeconds(scenario),
        stopGraceSeconds: 1,
        environment: workspace.env,
      });
      const ports: SequentialEpicLoopPorts = {
        preflight,
        lock,
        backlog: makeProcessBacklog({ repositoryPath: workspace.cwd, processRunner: runner }),
        journal,
        providerInventory: providerSupport.inventory,
        roleSelection: null,
        events: {
          publish: (event) =>
            Effect.sync(() => {
              events.push(event);
            }),
        },
        dispatch: {
          ...terminalDispatch,
          startIteration: (input) => {
            dispatchSelections.set(input.iterationIndex, input.selection.instanceId);
            return terminalDispatch.startIteration(input);
          },
        },
        gate: makeProcessGate({
          processRunner: runner,
          environment: { ...process.env, ...workspace.env },
          uid: process.getuid?.() ?? 0,
          // The conformance gate is a fixture command, not real verification.
          // A parallel test run pushes the host over the contention threshold,
          // and this scenario must not sit in the quiet-host wait for it.
          quietHostWaitSeconds: 0,
        }),
        gateReceipts: yield* makeFileGateReceipts({ runDirectory }),
        vcs: makeProcessVcs({ processRunner: runner }),
      };
      const result = yield* Effect.result(
        runSequentialEpicLoop(
          {
            runId: `conformance-${scenario.name}`,
            epicId: scenario.beads.epicId,
            cwd: workspace.cwd,
            runDirectory,
            repository: {
              repositoryPath: workspace.cwd,
              baseBranch: "main",
              worktreeRoot: NodePath.join(runDirectory, "worktrees"),
              siblings: [],
            },
            selection: initialSelection,
            configSnapshot: {
              fileResult: { _tag: "absent" },
              config: compressedConfig(scenario),
              provenance: DEFAULT_EPIC_RUN_CONFIG_PROVENANCE,
              violations: [],
            },
            readOrientation: () => Effect.succeed("fixture orientation"),
            shouldStop: () => Effect.succeed(false),
            now: () => "2026-01-01T00:00:00.000Z",
          },
          ports,
        ),
      );
      const harnesses = workspace.readTranscript().flatMap((item) => {
        if (typeof item !== "object" || item === null) return [];
        const record = item as Readonly<Record<string, unknown>>;
        return record["tool"] === "agent" && typeof record["harness"] === "string"
          ? [record["harness"]]
          : [];
      });
      return { result, events, dispatchSelections, harnesses };
    }).pipe(Effect.provide(localLayer));
  }).pipe(
    Effect.provide(
      Layer.merge(NodeServices.layer, ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer))),
    ),
  );
  if (executed.result._tag === "Failure") {
    return translatePreflightFailure({
      scenario,
      workspace,
      failure: executed.result.failure,
    });
  }
  if (scenario.name === "provider-fallback-persists") {
    assert.deepEqual(executed.harnesses, ["claude", "codex", "kimi"]);
  }
  return translateCoreEvents({
    scenario,
    workspace,
    events: executed.events,
    dispatchSelections: executed.dispatchSelections,
  });
});

/**
 * The pool leg of the core driver: the same fixture workspace, run through
 * `runParallelEpicLoop` over the terminal pool adapters — the exact wiring
 * `t3 epic cook` uses for `COOKEPIC_WORKERS > 1`.
 *
 * The sequential leg above hands preflight to the loop. The pool loop has no
 * preflight hook (it consumes a run row that already exists), so this runs the
 * parallel-mode check itself, exactly as the terminal cook does.
 */
const runCoreParallelScenario = Effect.fn("runCoreParallelScenario")(function* (
  scenario: ConformanceScenario,
) {
  const workspace = makeConformanceWorkspace(scenario);
  const runDirectory = NodePath.join(NodePath.dirname(workspace.cwd), "run");
  NodeFS.mkdirSync(runDirectory, { recursive: true });
  return yield* Effect.gen(function* () {
    const baseRunner = yield* ProcessRunner.ProcessRunner;
    const runner = ProcessRunner.ProcessRunner.of({
      run: (input) =>
        baseRunner.run({
          ...input,
          command:
            input.command === "git"
              ? (workspace.env["CONFORMANCE_REAL_GIT"] ?? input.command)
              : input.command,
          env: { ...process.env, ...workspace.env, ...input.env },
          extendEnv: false,
        }),
    });
    const dependencies = Layer.mergeAll(
      Layer.succeed(ProcessRunner.ProcessRunner, runner),
      NodeEpicRunLock.layer,
      EpicRunConfigSource.layer,
    );
    const localLayer = Layer.merge(
      dependencies,
      EpicRunPreflight.layer.pipe(Layer.provide(dependencies)),
    );
    const runId = `conformance-${scenario.name}`;
    const config = compressedConfig(scenario);
    const configSnapshot = {
      fileResult: { _tag: "absent" as const },
      config,
      provenance: poolProvenance,
      violations: [],
    };

    return yield* Effect.gen(function* () {
      const preflight = yield* EpicRunPreflight.EpicRunPreflight;
      const lock = yield* EpicRunLock;
      const checked = yield* Effect.result(
        preflight.check(
          { workspaceRoot: workspace.cwd, epicId: scenario.beads.epicId, mode: "parallel" },
          configSnapshot,
        ),
      );
      if (checked._tag === "Failure") {
        return translatePreflightFailure({ scenario, workspace, failure: checked.failure });
      }
      if (!checked.success.ok) {
        return translatePreflightFailure({
          scenario,
          workspace,
          failure: new Error(checked.success.blockers.map((blocker) => blocker._tag).join(", ")),
        });
      }
      const lease = yield* Effect.result(
        lock.acquire({
          workspaceRoot: workspace.cwd,
          epicId: scenario.beads.epicId,
          owner: `conformance-${String(process.pid)}`,
          runDir: runDirectory,
        }),
      );
      if (lease._tag === "Failure") {
        return translatePreflightFailure({ scenario, workspace, failure: lease.failure });
      }

      const journal = yield* FileRunJournal.makePool({ runDirectory });
      const mergeQueueStore = yield* makeFileMergeQueueStore({ runDirectory });
      const gateReceipts = yield* makeFileGateReceipts({ runDirectory });
      const selection = {
        instanceId: ProviderInstanceId.make("worker-cmd"),
        model: "fixture",
      };
      const providerSupport = makeTerminalProviderSupport({
        harness: "worker-cmd",
        selection,
        workerCommand: NodePath.join(workspace.binDir, "agent"),
        environment: workspace.env,
      });
      const agentDispatch = makeTerminalAgentDispatch({
        harness: "worker-cmd",
        artifactsDirectory: runDirectory,
        workerCommand: NodePath.join(workspace.binDir, "agent"),
        providerRoutes: providerSupport.routes,
        timeoutSeconds: workerDeadlineSeconds(scenario),
        stopGraceSeconds: 1,
        environment: workspace.env,
      });
      const gate = makeProcessGate({
        processRunner: runner,
        environment: { ...process.env, ...workspace.env },
        uid: process.getuid?.() ?? 0,
        // See the sequential leg: the fixture gate is a fixture command, and a
        // loaded host must not park an innocent branch for it.
        quietHostWaitSeconds: 0,
      });
      const acquiredWorkspaces = new Map<string, IterationWorkspace>();
      /**
       * True while the invocation under way is the one that gets killed.
       *
       * A killed process runs no finalizers, and the per-iteration workspace
       * release is one: interrupting the fiber tore down the very worktree the
       * restart is supposed to find, so every restart scenario reached the
       * refusal with nothing to hand over. `cleanupOwnedExternally` does not
       * cover this — it only skips the loop's own end-of-run sweep.
       */
      let crashing = false;
      const basePoolWorkspace = makeTerminalPoolWorkspace({
        processRunner: runner,
        journal,
        mergeQueueStore,
        worktreesRoot: NodePath.join(runDirectory, "worktrees"),
      });
      /**
       * The pool workspace, plus a record of what each child was given.
       *
       * A restart has to hand `branch` and `worktreePath` back to the loop, and
       * the loop's journal port carries neither. The server reads them from its
       * own store; this leg records them as the workspace hands them out, which
       * is the same fact from the same side of the port.
       */
      const poolWorkspace: WorkspaceShape = {
        ...basePoolWorkspace,
        acquire: (poolRun, acquireInput) =>
          basePoolWorkspace.acquire(poolRun, acquireInput).pipe(
            Effect.tap((acquired) =>
              Effect.sync(() => {
                acquiredWorkspaces.set(acquireInput.issueId, acquired);
              }),
            ),
          ),
        release: (poolRun, released) =>
          crashing ? Effect.void : basePoolWorkspace.release(poolRun, released),
      };
      const run: PersistedEpicRun = {
        runId: EpicRunId.make(runId),
        epicId: scenario.beads.epicId,
        projectId: ProjectId.make(`local-${scenario.beads.epicId}`),
        cwd: workspace.cwd,
        prompt: epicRunIterationPrompt({ pushEnabled: false }),
        orientationFile: null,
        modelSelection: selection,
        runtimeMode: config.runtime.mode,
        config,
        configProvenance: poolProvenance,
        originThreadId: null,
        status: "running",
        maxIterations: config.limits.maxIterations,
        workers: scenarioWorkers(scenario),
        iterationsDispatched: 0,
        iterationsCompleted: 0,
        currentThreadId: null,
        currentTurnStartedAt: null,
        consecutiveFailures: 0,
        noCommitStreak: 0,
        infraStreak: 0,
        lastError: null,
        createdAt: FIXTURE_TIME,
        updatedAt: FIXTURE_TIME,
      };
      yield* journal.createRun(run);
      const ports: ParallelEpicLoopPorts = {
        journal,
        events: {
          publish: () => Effect.void,
        },
        backlog: makeProcessPoolBacklog(runner),
        workspace: poolWorkspace,
        dispatch: makeTerminalPoolDispatch({ dispatch: agentDispatch }),
        mergeDrain: makeTerminalMergeDrain({
          processRunner: runner,
          journal,
          mergeQueueStore,
          gate,
          gateReceipts,
          repair: makeProcessMergeRepair({
            processRunner: runner,
            environment: { ...process.env, ...workspace.env },
            uid: process.getuid?.() ?? 0,
          }),
        }),
        vcs: makeProcessPoolVcs(runner),
        providerInventory: providerSupport.inventory,
        roleSelection: null,
        /**
         * A scenario without `supervision` carries no evidence port at all,
         * the way a host with no sampling target does: only the dispatch
         * deadline bounds its workers. One with it gets the shipped machine
         * over fixture sampling, on a counted clock.
         */
        workerEvidence: scenario.supervision === undefined ? null : wedgeFirstWorkerEvidence(),
        ...(scenario.supervision === undefined
          ? {}
          : { supervisionClock: compressedSupervisionClock() }),
      };
      const policySeed: PoolPolicySeed = {
        iterationTimeoutMs: workerDeadlineSeconds(scenario) * 1_000,
        runStallTimeoutMs: DEFAULT_RUN_STALL_TIMEOUT_MS,
        pollIntervalMs: 5,
        quietPeriodMs: 5,
        retryBaseDelayMs: 5,
        retryMaxDelayMs: 5,
        maxConsecutiveFailures: config.server.maxConsecutiveFailures,
        maxNoCommitStreak: DEFAULT_MAX_NO_COMMIT_STREAK,
        infraFailureBudget: config.server.infraFailureBudget,
        subagentGraceTimeoutMs: config.server.subagentGraceTimeoutMs,
        maxGraceContinuations: config.server.maxGraceContinuations,
      };
      const transitions = yield* Semaphore.make(1);
      const signals = yield* Queue.unbounded<PoolSchedulerEvent>();
      const invokeLoop = (options: {
        readonly resumedWorkers: ReadonlyArray<ResumedWorker>;
        /** A crash runs no finalizer, so the first invocation of a restart owns none. */
        readonly crashes: boolean;
      }) =>
        runParallelEpicLoop(
          {
            runId: run.runId,
            epicId: scenario.beads.epicId,
            cwd: workspace.cwd,
            policy: makePoolPolicy(policySeed, run),
            withTransition: transitions.withPermits(1),
            signals,
            readOrientation: () => Effect.succeed("fixture orientation"),
            cleanupOwnedExternally: () => options.crashes,
            resumedWorkers: options.resumedWorkers,
          },
          ports,
        );

      if (scenario.restart === undefined) {
        yield* invokeLoop({ resumedWorkers: [], crashes: false });
      } else {
        const restart = scenario.restart;
        /**
         * Cut the first invocation the way a killed process is cut: mid-turn,
         * with no finalizer. Interrupting the fiber is the closest an
         * in-process leg gets, and `cleanupOwnedExternally` keeps it honest by
         * skipping the sweep a real crash never runs.
         */
        crashing = true;
        const first = yield* invokeLoop({ resumedWorkers: [], crashes: true }).pipe(
          Effect.forkChild,
        );
        const agentStarts = (): number =>
          workspace.readTranscript().filter((item) => {
            if (typeof item !== "object" || item === null) return false;
            return (item as Readonly<Record<string, unknown>>)["tool"] === "agent";
          }).length;
        /**
         * The row alone is not enough. `allocateIteration` writes it inside the
         * transition, before `beginTurn` spawns anything, so a cut that only
         * waited for a running row killed a turn that had not started — and the
         * fixture agent's step counter never moved, which handed the restart's
         * fresh iteration the same wedged step again.
         */
        const reached = yield* Effect.gen(function* () {
          while (true) {
            const rows = yield* journal.listIterations(run.runId);
            if (
              rows.length >= restart.cutAfterRows &&
              rows.at(-1)?.turnStatus === "running" &&
              agentStarts() >= restart.cutAfterRows
            ) {
              return;
            }
            yield* Effect.sleep(Duration.millis(10));
          }
        }).pipe(Effect.timeoutOption(Duration.seconds(30)));
        if (Option.isNone(reached)) {
          const rows = yield* journal.listIterations(run.runId);
          throw new Error(
            `${scenario.name} never reached ${String(restart.cutAfterRows)} iteration rows with a running worker; rows: ${JSON.stringify(
              rows.map((row) => [
                row.iterationIndex,
                row.issueId,
                row.turnStatus,
                row.failureReason,
              ]),
            )}`,
          );
        }
        yield* Fiber.interrupt(first);
        crashing = false;

        const leftover = (yield* journal.listIterations(run.runId)).filter(
          (row) => row.turnStatus === "running" && row.issueId !== null,
        );
        if (restart.dropWorktree === true) {
          // Gone the way git itself reports it gone. Deleting the directory
          // alone leaves the registration behind, and the next `worktree add`
          // then refuses the path outright — a different fault from the one
          // this scenario is about.
          for (const row of leftover) {
            const path = acquiredWorkspaces.get(row.issueId ?? "")?.worktreePath;
            if (path !== undefined && path !== null) {
              NodeFS.rmSync(path, { recursive: true, force: true });
            }
          }
          yield* runner
            .run({ command: "git", args: ["worktree", "prune"], cwd: workspace.cwd })
            .pipe(Effect.ignore);
        }
        yield* invokeLoop({
          resumedWorkers: restart.adopt
            ? leftover.map((row) => {
                const issueId = row.issueId ?? "";
                const acquired = acquiredWorkspaces.get(issueId);
                return {
                  issueId,
                  iterationIndex: row.iterationIndex,
                  threadId: row.threadId,
                  branch: acquired?.branch ?? null,
                  worktreePath: acquired?.worktreePath ?? null,
                  startedAt: row.startedAt,
                  resumeCount: row.resumeCount ?? 0,
                };
              })
            : [],
          crashes: false,
        });
      }
      const finalRun = yield* journal.getRun(run.runId);
      const rows = yield* journal.listIterations(run.runId);
      /**
       * The drain is serialized, and the receipts are the only place that
       * shows it: two branches that landed together were verified by ONE gate
       * over both, not by two gates racing the same base.
       *
       * A batch receipt names every branch it merged, space separated, and
       * blames nobody — a null `childId`, because one child of several cannot
       * be held responsible for a red batch.
       */
      if (scenario.name === "parallel-happy-path") {
        const entries = (yield* gateReceipts.list(runId)).filter(
          (receipt) => receipt.phase === "entry",
        );
        const acquiredBranches = [...acquiredWorkspaces.values()]
          .flatMap((acquired) => (acquired.branch === null ? [] : [acquired.branch]))
          .toSorted();
        assert.equal(
          entries.length,
          1,
          `expected one batched entry gate, got ${JSON.stringify(entries.map((entry) => entry.branch))}`,
        );
        assert.equal(entries[0]?.childId, null, "a batch gate blames no single child");
        assert.deepEqual((entries[0]?.branch ?? "").split(" ").toSorted(), acquiredBranches);
        assert.equal(entries[0]?.outcome, "passed");
      }
      yield* lease.success.release.pipe(Effect.ignore);
      const landed = landedChildIds(workspace);
      const iterations: ReadonlyArray<ParallelIterationRecord> = rows.map((row) => ({
        iterationIndex: row.iterationIndex,
        issueId: row.issueId,
        turnStatus: row.turnStatus,
        failureReason: row.failureReason,
        committed: row.issueId !== null && landed.has(row.issueId),
      }));
      return normalizeParallelTranscript({
        epicId: scenario.beads.epicId,
        iterations,
        run: Option.isSome(finalRun)
          ? { status: finalRun.value.status, lastError: finalRun.value.lastError }
          : { status: "failed", lastError: "run vanished from its journal" },
        comments: beadCommentCounts(workspace),
        releasedClaims: releasedClaimIds(workspace),
      });
    }).pipe(Effect.provide(localLayer));
  }).pipe(
    Effect.provide(
      Layer.merge(NodeServices.layer, ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer))),
    ),
  );
});

const describeDiff = (
  scenario: ConformanceScenario,
  actual: ReadonlyArray<EpicRunTranscriptEvent>,
): string => {
  const diff = diffTranscripts(actual, scenario.expectedTranscript);
  return diff === null
    ? ""
    : `${scenario.name} diverged at index ${String(diff.index)}\nactual: ${JSON.stringify(diff.left)}\nexpected: ${JSON.stringify(diff.right)}`;
};

/**
 * A runaway guard, not a performance benchmark.
 *
 * Every scenario drives real git and bd subprocesses, so its wall clock
 * measures host load as much as it measures the code — the whole set runs in
 * ~13s alone and takes more than 90s beside the rest of the suite. One budget
 * for all 14 made that load the thing under test: the gate went red for a
 * timing artifact, which parks an innocent branch and costs a merge cycle
 * (t3code-27p). Per scenario, generously bounded, is the honest shape. Backoff
 * is configured down to 5ms here, so nothing legitimate approaches this.
 */
const SCENARIO_TIMEOUT_MS = 120_000;

describe("epic-core conformance", () => {
  for (const scenario of scenarios()) {
    it.live(
      `matches ${scenario.name} through real git and bd subprocesses`,
      () =>
        Effect.gen(function* () {
          const actual = isParallelScenario(scenario)
            ? yield* runCoreParallelScenario(scenario)
            : yield* runCoreScenario(scenario);
          assert.equal(
            diffTranscripts(actual, scenario.expectedTranscript),
            null,
            describeDiff(scenario, actual),
          );
        }),
      SCENARIO_TIMEOUT_MS,
    );
  }
});
