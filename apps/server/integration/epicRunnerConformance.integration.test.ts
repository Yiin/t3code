// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalProcess:off
/**
 * Server conformance driver: every scenario whose `appliesTo` includes
 * "server" runs through the real EpicRunner service — the shared core loop
 * wired to the server adapters — against the same fixture workspace the core
 * and terminal drivers use. The fake orchestration engine executes each turn
 * as the fixture's agent subprocess and projects its outcome the way the real
 * projector would, so the transcript the run produces can be diffed against
 * the scenario's expected one.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  EpicRunId,
  EventId,
  ProjectId,
  ThreadId,
  ProviderDriverKind,
  ProviderInstanceId,
  TurnId,
  diffTranscripts,
  type EpicRunConfigOverride,
  type EpicRunTranscriptEvent,
  type OrchestrationCommand,
  type OrchestrationSessionStatus,
  type OrchestrationThread,
  type ProjectionThreadTurnStatus,
  type ServerProvider,
} from "@t3tools/contracts";
import {
  COMPRESSED_SUPERVISION_SETTINGS,
  beadCommentCounts,
  compressedSupervisionClock,
  decodeConformanceScenario,
  isParallelScenario,
  landedChildIds,
  makeConformanceWorkspace,
  normalizeParallelTranscript,
  releasedClaimIds,
  scenarioWorkers,
  wedgeFirstWorkerEvidence,
  type ConformanceScenario,
  type ConformanceWorkspace,
} from "@t3tools/epic-run-conformance";
import { layer as epicRunConfigSourceLayer } from "@t3tools/epic-core/EpicRunConfigSource";
import { layer as epicRunPreflightLayer } from "@t3tools/epic-core/EpicRunPreflight";
import * as NodeEpicRunLock from "@t3tools/epic-core/adapters/NodeEpicRunLock";
import { DEFAULT_MAX_NO_COMMIT_STREAK, epicRunIterationPrompt } from "@t3tools/epic-core/policy";
import * as ProcessRunner from "@t3tools/epic-core/processRunner";
import {
  PROVIDER_SESSION_RESUME_SETTLED_ACTIVITY_KIND,
  type OrchestrationThreadActivity,
  type ProviderSessionResumeSettledActivityPayload,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { OrchestrationEngineService } from "../src/orchestration/Services/OrchestrationEngine.ts";
import type { OrchestrationDispatchError } from "../src/orchestration/Errors.ts";
import { ProjectionSnapshotQuery } from "../src/orchestration/Services/ProjectionSnapshotQuery.ts";
import { EpicRunStore, type EpicRun } from "../src/persistence/Services/EpicRuns.ts";
import { ServerConfig } from "../src/config.ts";
import { ProjectSetupScriptRunner } from "../src/project/ProjectSetupScriptRunner.ts";
import { WorktreeProvisioner } from "../src/vcs/WorktreeProvisioner.ts";
import { GitVcsDriver } from "../src/vcs/GitVcsDriver.ts";
import { ProviderRegistry } from "../src/provider/Services/ProviderRegistry.ts";
import { makeProviderRegistryMock } from "../src/provider/testUtils/providerRegistryMock.ts";
import { EpicSubagentRegistry } from "../src/provider/epicSubagents.ts";
import { EpicCommitterRegistry } from "../src/provider/epicCommitter.ts";
import { EpicWorkerScopeRegistry } from "../src/provider/workerScope.ts";
import { EpicRunner } from "../src/runner/Services/EpicRunner.ts";
import { makeEpicRunnerLive } from "../src/runner/Layers/EpicRunner.ts";
import { makeMemoryStore, makeThreadDetail } from "./EpicRunnerHarness.integration.ts";

const scenariosDirectory = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../../../packages/epic-run-conformance/scenarios",
);

const scenarios = (): ReadonlyArray<ConformanceScenario> =>
  NodeFS.readdirSync(scenariosDirectory)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) =>
      decodeConformanceScenario(
        JSON.parse(NodeFS.readFileSync(NodePath.join(scenariosDirectory, name), "utf8")),
      ),
    )
    .filter((scenario) => scenario.appliesTo.includes("server"));

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

const accountRotationProviders = [
  provider("claude-a", "claudeAgent", "sonnet"),
  provider("claude-b", "claudeAgent", "sonnet"),
  provider("codex", "codex", "gpt-5.6-sol"),
] as const;

const providersForScenario = (scenario: ConformanceScenario): ReadonlyArray<ServerProvider> =>
  scenario.name === "account-rotation-exhausts-harness"
    ? accountRotationProviders
    : conformanceProviders;

const initialSelectionForScenario = (scenario: ConformanceScenario) =>
  scenario.name === "account-rotation-exhausts-harness"
    ? { instanceId: ProviderInstanceId.make("claude-a"), model: "sonnet" }
    : scenario.name === "provider-fallback-persists"
      ? { instanceId: ProviderInstanceId.make("claude"), model: "sonnet" }
      : { instanceId: ProviderInstanceId.make("worker-cmd"), model: "fixture" };

const transcriptProvider = (driver: string): string =>
  driver === "claudeAgent" ? "claude" : driver;

const projectId = ProjectId.make("project-epic-runner-conformance");

const configOverride = (scenario: ConformanceScenario): EpicRunConfigOverride => ({
  execution: { sequential: !isParallelScenario(scenario) },
  parallel: { workers: scenarioWorkers(scenario) },
  limits: { maxIterations: maximumIterations(scenario) },
  // A pool worker has to survive its siblings' merges; one second is the
  // sequential leg's budget for a lone worker, not two racing ones.
  supervision: {
    workerTimeoutSeconds: isParallelScenario(scenario) ? 30 : 1,
    stopGraceSeconds: 1,
    // Compressed inspection cadence for the supervision scenarios; the clock
    // below is counted, so these are never waited out.
    ...(scenario.supervision === undefined ? {} : COMPRESSED_SUPERVISION_SETTINGS),
  },
  server: {
    maxNoCommitStreak: DEFAULT_MAX_NO_COMMIT_STREAK,
    pollIntervalMs: 5,
    quietPeriodMs: 5,
    retryBaseDelayMs: 5,
    retryMaxDelayMs: 5,
  },
  vcs: { noPush: true },
  gate: { command: "true", disabled: false },
});

const readHead = (workspace: ConformanceWorkspace): string | null => {
  const git = workspace.env["CONFORMANCE_REAL_GIT"] ?? "git";
  const result = NodeChildProcess.spawnSync(git, ["rev-parse", "--verify", "-q", "HEAD"], {
    cwd: workspace.cwd,
    encoding: "utf8",
  });
  const sha = result.stdout.trim();
  return result.status === 0 && sha.length > 0 ? sha : null;
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

interface AgentResult {
  readonly code: number | null;
  readonly killed: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

/** The provider error text the fixture agent reported, when it failed like one. */
const providerErrorMessage = (stdout: string): string | null => {
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(trimmed) as {
        readonly error?: { readonly message?: unknown };
        readonly result?: unknown;
        readonly is_error?: unknown;
      };
      if (typeof parsed.error?.message === "string") return parsed.error.message;
      if (parsed.is_error === true && typeof parsed.result === "string") return parsed.result;
    } catch {
      // not a JSON line
    }
  }
  return null;
};

const translateStartFailure = (input: {
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
  } as const;
  const detail = input.failure instanceof Error ? input.failure.message : String(input.failure);
  if (detail.includes("Another epic run owns")) {
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
  if (detail.includes("was not found")) {
    return [{ _tag: "finished", ...common, status: "failed", reason: "epic not found" }];
  }
  if (detail.includes("detached HEAD")) {
    return [{ _tag: "finished", ...common, status: "failed", reason: "detached head" }];
  }
  if (detail.includes("worktree has changes")) {
    return [{ _tag: "finished", ...common, status: "failed", reason: "dirty tree" }];
  }
  throw new Error(`unexpected server failure for ${input.scenario.name}: ${detail}`);
};

const translateServerRun = (input: {
  readonly scenario: ConformanceScenario;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly workspace: ConformanceWorkspace;
  readonly history: ReadonlyArray<{ readonly run: EpicRun; readonly head: string | null }>;
  readonly iterations: ReadonlyArray<{
    readonly iterationIndex: number;
    readonly issueId: string | null;
    readonly turnStatus: string;
    readonly failureReason: string | null;
  }>;
}): ReadonlyArray<EpicRunTranscriptEvent> => {
  const output: EpicRunTranscriptEvent[] = [];
  const settled = input.iterations.filter((iteration) => iteration.turnStatus !== "running");
  const finalRun = input.history.at(-1)?.run;

  // Per-iteration commit evidence: HEAD at the charge write versus HEAD at the
  // boundary write of the same iteration.
  const headAtDispatch = new Map<number, string | null>();
  const headAtBoundary = new Map<number, string | null>();
  const selectionAtDispatch = new Map<number, EpicRun["modelSelection"]>();
  for (const entry of input.history) {
    const { run, head } = entry;
    if (run.iterationsDispatched > 0 && !headAtDispatch.has(run.iterationsDispatched - 1)) {
      headAtDispatch.set(run.iterationsDispatched - 1, head);
      selectionAtDispatch.set(run.iterationsDispatched - 1, run.modelSelection);
    }
    if (run.iterationsCompleted > 0 && !headAtBoundary.has(run.iterationsCompleted - 1)) {
      headAtBoundary.set(run.iterationsCompleted - 1, head);
    }
  }

  // Provider fallbacks: every persisted model-selection change, attributed to
  // the iteration whose boundary preceded it.
  const providerFallbacks = new Map<
    number,
    { readonly from: ProviderInstanceId; readonly to: ProviderInstanceId }
  >();
  for (let index = 1; index < input.history.length; index += 1) {
    const previous = input.history[index - 1]!.run.modelSelection;
    const current = input.history[index]!.run.modelSelection;
    if (previous.instanceId !== current.instanceId || previous.model !== current.model) {
      providerFallbacks.set(input.history[index]!.run.iterationsDispatched - 1, {
        from: previous.instanceId,
        to: current.instanceId,
      });
    }
  }

  const releasedClaims = releasedClaimIds(input.workspace);
  const comments = new Map(
    stateChildren(input.workspace).flatMap((child) => {
      const id = typeof child["id"] === "string" ? child["id"] : undefined;
      const count = typeof child["comment_count"] === "number" ? child["comment_count"] : 0;
      return id === undefined ? [] : [[id, count] as const];
    }),
  );
  const childAttempts = new Map<string, number>();
  let infraAttempts = 0;
  let recoveredExhaustion = false;

  for (const [index, iteration] of settled.entries()) {
    const issueId = iteration.issueId;
    const common = {
      sequence: output.length,
      epicId: input.scenario.beads.epicId,
      issueId,
      iterationIndex: iteration.iterationIndex,
      pushed: false,
      verified: true,
    } as const;
    const fallback = providerFallbacks.get(iteration.iterationIndex);
    if (fallback !== undefined) {
      const fromProvider = input.providers.find(
        (provider) => provider.instanceId === fallback.from,
      );
      const toProvider = input.providers.find((provider) => provider.instanceId === fallback.to);
      output.push({
        _tag: "provider-fallback",
        ...common,
        ...(fromProvider === undefined
          ? {}
          : { fromProvider: transcriptProvider(fromProvider.driver) }),
        fromProviderInstanceId: fallback.from,
        ...(toProvider === undefined ? {} : { toProvider: transcriptProvider(toProvider.driver) }),
        toProviderInstanceId: fallback.to,
      });
      continue;
    }
    if (iteration.turnStatus === "completed") {
      const committed =
        headAtDispatch.get(iteration.iterationIndex) !==
        headAtBoundary.get(iteration.iterationIndex);
      if (!committed) {
        output.push({
          _tag: "completed-no-code",
          ...common,
          comments: issueId === null ? 0 : (comments.get(issueId) ?? 0),
        });
      } else {
        const selection = selectionAtDispatch.get(iteration.iterationIndex);
        const selectedProvider = input.providers.find(
          (provider) => provider.instanceId === selection?.instanceId,
        );
        output.push({
          _tag: "dispatched",
          ...common,
          sequence: output.length,
          ...(selectedProvider !== undefined
            ? { toProvider: transcriptProvider(selectedProvider.driver) }
            : {}),
        });
        if (providerFallbacks.size > 0) continue;
        output.push({ _tag: "done", ...common, sequence: output.length });
      }
      continue;
    }

    const failure = iteration.failureReason ?? "infra:turn-error";
    if (failure === "infra:ready-unrecognised") {
      output.push({
        _tag: "iteration-state-changed",
        ...common,
        turnStatus: "failed",
        failureReason: failure,
      });
      continue;
    }
    const isInfra = failure.startsWith("infra:");
    const attempts = isInfra
      ? ++infraAttempts
      : issueId === null
        ? 1
        : (childAttempts.set(issueId, (childAttempts.get(issueId) ?? 0) + 1),
          childAttempts.get(issueId)!);
    const last = index === settled.length - 1;
    if (!last || finalRun?.status === "running") {
      output.push({ _tag: "retry", ...common, failureReason: failure, attempts });
      continue;
    }
    if (issueId !== null && releasedClaims.has(issueId)) {
      recoveredExhaustion = true;
      output.push({
        _tag: "blocked",
        ...common,
        failureReason: failure,
        attempts,
        reason: "retry budget exhausted; child reopened",
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

  if (finalRun?.status === "failed" && finalRun.lastError?.includes("no usable child")) {
    output.push({
      _tag: "run-state-changed",
      sequence: output.length,
      epicId: input.scenario.beads.epicId,
      issueId: null,
      iterationIndex: null,
      status: "failed",
      reason: "ready children were unrecognised",
      pushed: false,
      verified: true,
    });
  } else if (finalRun?.status === "done" && output.some((event) => event._tag === "done")) {
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
    finalRun.consecutiveFailures >= 3
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

const runServerScenario = Effect.fn("runServerScenario")(function* (scenario: ConformanceScenario) {
  const workspace = makeConformanceWorkspace(scenario);
  const scenarioProviders = providersForScenario(scenario);
  const baseProviderRegistry = makeProviderRegistryMock(scenarioProviders);
  let accountRotationInventoryReads = 0;
  const providerRegistry =
    scenario.name === "account-rotation-exhausts-harness"
      ? {
          ...baseProviderRegistry,
          getProviders: Effect.sync(() => {
            accountRotationInventoryReads += 1;
            return accountRotationInventoryReads === 1
              ? scenarioProviders
              : scenarioProviders.map((provider) =>
                  provider.instanceId === ProviderInstanceId.make("claude-a")
                    ? { ...provider, availability: "unavailable" as const }
                    : provider,
                );
          }),
        }
      : baseProviderRegistry;
  const baseRunner = yield* ProcessRunner.ProcessRunner;
  const runner = ProcessRunner.ProcessRunner.of({
    run: (input: ProcessRunner.ProcessRunInput) =>
      baseRunner.run({
        ...input,
        command:
          input.command === "git"
            ? (workspace.env["CONFORMANCE_REAL_GIT"] ?? input.command)
            : input.command,
        env: { ...process.env, ...workspace.env, ...input.env },
        extendEnv: false,
      }),
    runStreaming: () => Effect.die("unused"),
  } as never);

  const store = makeMemoryStore();
  const history: Array<{ readonly run: EpicRun; readonly head: string | null }> = [];
  const baseUpsertRun = store.shape.upsertRun;
  Object.assign(store.shape, {
    upsertRun: (run: EpicRun) => {
      history.push({ run, head: readHead(workspace) });
      return baseUpsertRun(run);
    },
  });

  const shells = new Map<
    string,
    {
      readonly latestTurn: ProjectionThreadTurnStatus | null;
      readonly session: OrchestrationSessionStatus;
    }
  >();
  const details = new Map<string, OrchestrationThread>();
  const agentProcesses = new Map<string, NodeChildProcess.ChildProcess>();
  /**
   * Where each iteration thread runs and which child it owns.
   *
   * A sequential run has one answer for both — the run's own checkout and the
   * only ready child. A pool run does not: the runner creates each thread with
   * its own worktree, and the child it must cook is named in its prompt. The
   * fake engine reads both off the commands it is handed, so the fixture agent
   * commits in the branch the merge queue will look for.
   */
  const threadWorktrees = new Map<string, string>();
  const threadChildren = new Map<string, string>();
  /**
   * Durable per-thread activities, which is where a resume outcome lands.
   *
   * The projection is the server's durable memory of a thread, so these survive
   * the restart below exactly as the real projection does. Only the runner
   * layer is rebuilt; what a thread already recorded is still there.
   */
  const threadActivities = new Map<string, Array<OrchestrationThreadActivity>>();
  const worktreesDir = NodePath.join(NodePath.dirname(workspace.cwd), "worktrees");
  let sequence = 0;

  const runAgent = (threadId: string) =>
    new Promise<AgentResult>((resolvePromise) => {
      const childId = threadChildren.get(threadId);
      const child = NodeChildProcess.spawn(NodePath.join(workspace.binDir, "agent"), [], {
        cwd: threadWorktrees.get(threadId) ?? workspace.cwd,
        env: {
          ...process.env,
          ...workspace.env,
          ...(childId === undefined ? {} : { COOKEPIC_CHILD: childId }),
        },
      });
      agentProcesses.set(threadId, child);
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
      child.on("close", (code, signal) => {
        agentProcesses.delete(threadId);
        resolvePromise({ code, killed: signal !== null, stdout, stderr });
      });
      child.on("error", () => {
        agentProcesses.delete(threadId);
        resolvePromise({ code: 1, killed: false, stdout, stderr });
      });
    });

  const simulateTurn = (threadId: ThreadId) =>
    Effect.gen(function* () {
      shells.set(threadId, { latestTurn: "running", session: "running" });
      const result = yield* Effect.promise(() => runAgent(threadId));
      if (result.killed) {
        shells.set(threadId, { latestTurn: "interrupted", session: "interrupted" });
        return;
      }
      if (result.code !== 0) {
        const message =
          providerErrorMessage(result.stdout) ??
          (result.stderr.trim().length > 0 ? result.stderr.trim() : "agent failed");
        details.set(
          threadId,
          makeThreadDetail({
            threadId,
            turnId: TurnId.make(`${threadId}-turn`),
            turnState: "error",
            text: null,
            streaming: false,
            sessionStatus: "error",
            sessionLastError: message,
          }),
        );
        shells.set(threadId, { latestTurn: "error", session: "error" });
        return;
      }
      const text = result.stdout.trim();
      details.set(
        threadId,
        makeThreadDetail({
          threadId,
          turnId: TurnId.make(`${threadId}-turn`),
          turnState: "completed",
          text: text === "" ? null : text,
          streaming: false,
          sessionStatus: "ready",
        }),
      );
      shells.set(threadId, { latestTurn: "completed", session: "ready" });
    });

  const dispatched: OrchestrationCommand[] = [];
  const engineLayer = Layer.succeed(OrchestrationEngineService, {
    readEvents: () => Stream.empty,
    latestSequence: Effect.sync(() => sequence),
    streamDomainEvents: Stream.never,
    dispatch: (
      command: OrchestrationCommand,
    ): Effect.Effect<{ sequence: number }, OrchestrationDispatchError> =>
      Effect.gen(function* () {
        dispatched.push(command);
        if (command.type === "thread.create" && command.worktreePath !== null) {
          threadWorktrees.set(command.threadId, command.worktreePath);
        }
        if (command.type === "thread.turn.start") {
          const named = /Cook exactly `([^`]+)`/.exec(command.message.text);
          if (named?.[1] !== undefined) threadChildren.set(command.threadId, named[1]);
        }
        if (command.type === "thread.turn.start") {
          // Forked so `dispatch` returns before the turn resolves, the way the
          // real engine behaves.
          yield* Effect.forkDetach(simulateTurn(command.threadId));
        }
        if (
          (command.type === "thread.turn.interrupt" || command.type === "thread.session.stop") &&
          agentProcesses.has(command.threadId)
        ) {
          agentProcesses.get(command.threadId)?.kill("SIGKILL");
        }
        if (command.type === "thread.session.resume") {
          /**
           * The fixture provider is a shell script. It holds no session, so
           * there is nothing for a resume to continue and nothing it could
           * honestly claim to have continued — which is exactly what
           * `capability` states. The real reactor records the same answer as a
           * durable activity carrying the request's command id, and that
           * activity is how the runner learns it.
           */
          const settled: ProviderSessionResumeSettledActivityPayload = {
            threadId: command.threadId,
            requestCommandId: command.commandId,
            outcome: {
              _tag: "capability",
              detail: "the conformance fixture provider holds no session to resume",
            },
          };
          const activities = threadActivities.get(command.threadId) ?? [];
          activities.push({
            id: EventId.make(`${command.threadId}-resume-${String(activities.length)}`),
            tone: "info",
            kind: PROVIDER_SESSION_RESUME_SETTLED_ACTIVITY_KIND,
            summary: "provider session resume settled",
            payload: settled,
            turnId: null,
            createdAt: "2026-01-01T00:00:00.000Z",
          });
          threadActivities.set(command.threadId, activities);
        }
        sequence += 1;
        return { sequence };
      }),
  });

  const snapshotLayer = Layer.succeed(ProjectionSnapshotQuery, {
    getCommandReadModel: () => Effect.die("unused"),
    getSnapshot: () => Effect.die("unused"),
    getShellSnapshot: () => Effect.die("unused"),
    getArchivedShellSnapshot: () => Effect.die("unused"),
    getSnapshotSequence: () => Effect.succeed({ snapshotSequence: sequence }),
    getCounts: () => Effect.die("unused"),
    getActiveProjectByWorkspaceRoot: () => Effect.die("unused"),
    getProjectShellById: (id) =>
      Effect.succeed(
        Option.some({
          id,
          title: "Conformance project",
          workspaceRoot: workspace.cwd,
          defaultModelSelection: {
            instanceId: ProviderInstanceId.make("worker-cmd"),
            model: "fixture",
          },
          scripts: [],
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        }),
      ),
    getFirstActiveThreadIdByProjectId: () => Effect.die("unused"),
    listChildThreadIds: () => Effect.die("unused"),
    listRunningThreadBackedSubagents: () => Effect.die("unused"),
    listThreadIdsWithQueuedMessages: () => Effect.die("unused"),
    getThreadCheckpointContext: () => Effect.die("unused"),
    getFullThreadDiffContext: () => Effect.die("unused"),
    listSubagentTurnContributions: () => Effect.succeed([]),
    getThreadShellById: (threadId) =>
      Effect.sync(() => {
        const shell = shells.get(threadId);
        if (shell === undefined) return Option.none();
        return Option.some({
          id: threadId,
          projectId,
          title: "Epic iteration",
          modelSelection: {
            instanceId: ProviderInstanceId.make("worker-cmd"),
            model: "fixture",
          },
          runtimeMode: "full-access" as const,
          interactionMode: "default" as const,
          branch: null,
          worktreePath: threadWorktrees.get(threadId) ?? null,
          latestTurn:
            shell.latestTurn === null
              ? null
              : {
                  turnId: TurnId.make(`${threadId}-turn`),
                  state: shell.latestTurn,
                  requestedAt: "2026-01-01T00:00:00.000Z",
                  startedAt: "2026-01-01T00:00:00.000Z",
                  completedAt: shell.latestTurn === "running" ? null : "2026-01-01T00:00:00.000Z",
                  assistantMessageId: null,
                },
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          session: {
            threadId,
            status: shell.session,
            providerName: "codex",
            runtimeMode: "full-access" as const,
            activeTurnId: null,
            lastError: null,
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
          latestUserMessageAt: "2026-01-01T00:00:00.000Z",
          hasPendingApprovals: false,
          hasPendingUserInput: false,
          hasActionableProposedPlan: false,
          activeSubagentCount: 0,
          parentThreadId: null,
        });
      }),
    getThreadSessionById: () => Effect.die("unused"),
    getThreadSubagentLiveness: () =>
      Effect.succeed({ activeSubagentCount: 0, newestRunningUpdatedAt: null }),
    getSubagentActivities: () =>
      Effect.succeed({ activities: [], hasMore: false, nextBefore: null }),
    getThreadDetailById: () => Effect.die("unused"),
    getThreadDetailSnapshot: (threadId) =>
      Effect.sync(() => {
        const detail = details.get(threadId);
        const activities = threadActivities.get(threadId) ?? [];
        // A thread whose turn was cut has no detail yet, but it can still carry
        // the activity a resume settled on — and that answer is the only thing
        // the runner is waiting for.
        if (detail === undefined && activities.length === 0) return Option.none();
        const thread =
          detail ??
          makeThreadDetail({
            threadId: ThreadId.make(threadId),
            turnId: TurnId.make(`${threadId}-turn`),
            turnState: "interrupted",
            text: null,
            streaming: false,
            sessionStatus: "interrupted",
          });
        return Option.some({
          snapshotSequence: sequence,
          thread: { ...thread, activities },
        });
      }),
  });

  const gitVcsLayer = Layer.effect(
    GitVcsDriver,
    Effect.gen(function* () {
      const processRunnerService = yield* ProcessRunner.ProcessRunner;
      return GitVcsDriver.of({
        execute: (request: Parameters<GitVcsDriver["Service"]["execute"]>[0]) =>
          processRunnerService
            .run({
              command: "git",
              args: request.args,
              cwd: request.cwd,
              maxOutputBytes: request.maxOutputBytes,
            })
            .pipe(
              Effect.map((result) => ({
                exitCode: result.code,
                stdout: result.stdout,
                stderr: result.stderr,
                stdoutTruncated: result.stdoutTruncated,
                stderrTruncated: result.stderrTruncated,
              })),
            ),
      } as never);
    }),
  );

  const infraLayer = Layer.mergeAll(
    Layer.succeed(ProcessRunner.ProcessRunner, runner),
    NodeEpicRunLock.layer,
    epicRunConfigSourceLayer,
  );
  const preflightLayer = epicRunPreflightLayer.pipe(Layer.provide(infraLayer));

  const runnerLayer = makeEpicRunnerLive({
    pollIntervalMs: 5,
    quietPeriodMs: 5,
    retryBaseDelayMs: 5,
    retryMaxDelayMs: 5,
    /**
     * A scenario without `supervision` keeps the shipped evidence port, the way
     * a host with no worker scope runs: only the dispatch deadline bounds a
     * worker. One with it gets the shipped machine over fixture sampling, on a
     * counted clock.
     */
    ...(scenario.supervision === undefined
      ? {}
      : {
          workerEvidence: wedgeFirstWorkerEvidence(),
          supervisionClock: compressedSupervisionClock(),
        }),
  }).pipe(
    Layer.provide(preflightLayer),
    Layer.provide(infraLayer),
    Layer.provide(EpicWorkerScopeRegistry.layer),
    Layer.provide(EpicSubagentRegistry.layer),
    Layer.provide(EpicCommitterRegistry.layer),
    Layer.provide(engineLayer),
    Layer.provide(snapshotLayer),
    Layer.provide(gitVcsLayer.pipe(Layer.provide(infraLayer))),
    Layer.provide(
      Layer.succeed(WorktreeProvisioner, {
        /**
         * Real git worktrees, not recorded intentions.
         *
         * A pool scenario is only evidence if the worker's commit exists on a
         * branch the merge queue can actually merge. A stub that returned a
         * path would test the runner's bookkeeping and nothing else.
         */
        provision: (request) =>
          Effect.sync(() => {
            const git = workspace.env["CONFORMANCE_REAL_GIT"] ?? "git";
            const branch = request.branch ?? request.baseBranch;
            const target = request.path ?? NodePath.join(worktreesDir, branch);
            const existing = NodeChildProcess.spawnSync(
              git,
              ["rev-parse", "--verify", "-q", branch],
              { cwd: request.projectCwd, encoding: "utf8" },
            );
            const args =
              existing.status === 0
                ? ["worktree", "add", target, branch]
                : ["worktree", "add", "-b", branch, target, request.baseBranch];
            const added = NodeChildProcess.spawnSync(git, args, {
              cwd: request.projectCwd,
              encoding: "utf8",
            });
            if (added.status !== 0) {
              throw new Error(`git ${args.join(" ")} failed: ${added.stderr}`);
            }
            return { path: target, refName: branch };
          }),
        release: ({ repoCwd, worktreePath }) =>
          Effect.sync(() => {
            /**
             * A killed process runs no finalizer, and this release is one.
             *
             * The rule is stated over durable state, not over a window in time:
             * the cut's own finalizers land whenever the runtime gets to them,
             * which is after the layer scope has already closed. A worktree an
             * iteration still owns as `running` is one whose process was killed
             * holding it, and a killed process leaves it on disk. That is the
             * whole difference the restart scenarios turn on.
             *
             * It is deliberately not "suppress everything the first leg does":
             * an attempt that settled before the cut released its own worktree,
             * its record is terminal by then, and leaving that tree behind makes
             * the child's next `acquire` refuse a branch it should never have
             * found (t3code-22o.18).
             */
            if (
              store.iterations.some(
                (iteration) =>
                  iteration.turnStatus === "running" && iteration.worktreePath === worktreePath,
              )
            ) {
              return;
            }
            const git = workspace.env["CONFORMANCE_REAL_GIT"] ?? "git";
            NodeChildProcess.spawnSync(git, ["worktree", "remove", "--force", worktreePath], {
              cwd: repoCwd,
            });
          }),
      }),
    ),
    Layer.provide(
      Layer.succeed(ProjectSetupScriptRunner, {
        runForThread: () => Effect.succeed({ status: "no-script" } as const),
      }),
    ),
    Layer.provide(Layer.succeed(ServerConfig, { worktreesDir } as ServerConfig["Service"])),
    Layer.provide(Layer.succeed(ProviderRegistry, providerRegistry)),
    Layer.provide(Layer.succeed(EpicRunStore, store.shape)),
    Layer.provide(NodeServices.layer),
  );

  const initialSelection = initialSelectionForScenario(scenario);

  const awaitTerminalRun = (runId: EpicRunId) =>
    Effect.gen(function* () {
      while (true) {
        const run = store.runs.get(runId);
        if (
          run !== undefined &&
          (run.status === "done" || run.status === "failed" || run.status === "cancelled")
        ) {
          return;
        }
        yield* Effect.sleep("10 millis");
      }
    }).pipe(Effect.timeout("60 seconds"));

  /**
   * Wait for the run to reach the position the cut is defined at.
   *
   * The row alone is not enough: it is written inside the dispatch transition,
   * before the turn is started, so a cut that only waited for a running row
   * would kill a worker that never ran — and the fixture agent's step counter
   * would still be where it started, handing the restart's fresh iteration the
   * same wedged step again.
   */
  const awaitRestartCut = (runId: EpicRunId, cutAfterRows: number) =>
    Effect.gen(function* () {
      while (true) {
        const rows = store.iterations.filter((iteration) => iteration.runId === runId);
        if (
          rows.length >= cutAfterRows &&
          rows.at(-1)?.turnStatus === "running" &&
          dispatched.filter((command) => command.type === "thread.turn.start").length >=
            cutAfterRows
        ) {
          return;
        }
        yield* Effect.sleep("10 millis");
      }
    }).pipe(Effect.timeout("30 seconds"));

  const startRun = Effect.gen(function* () {
    const service = yield* EpicRunner;
    return yield* Effect.result(
      service.startRun({
        epicId: scenario.beads.epicId,
        projectId,
        cwd: workspace.cwd,
        prompt: epicRunIterationPrompt({ pushEnabled: true }),
        orientationFile: null,
        modelSelection: initialSelection,
        config: configOverride(scenario),
      }),
    );
  });

  const restart = scenario.restart;
  const executed =
    restart === undefined
      ? yield* Effect.gen(function* () {
          const startExit = yield* startRun;
          if (startExit._tag === "Failure") return { startFailure: startExit.failure };
          yield* awaitTerminalRun(startExit.success.runId);
          return { startFailure: null };
        }).pipe(Effect.scoped, Effect.provide(runnerLayer))
      : yield* Effect.gen(function* () {
          /**
           * The cut is the layer scope closing, which is what a server stop is:
           * every loop is interrupted, every lease released, and the in-memory
           * registries go with it. What survives is what really survives — the
           * store, the orchestration projection, and the worktrees on disk.
           */
          const first = yield* Effect.gen(function* () {
            const startExit = yield* startRun;
            if (startExit._tag === "Failure") {
              return { startFailure: startExit.failure, runId: null };
            }
            yield* awaitRestartCut(startExit.success.runId, restart.cutAfterRows);
            return { startFailure: null, runId: startExit.success.runId };
          }).pipe(Effect.scoped, Effect.provide(runnerLayer));
          if (first.startFailure !== null || first.runId === null) {
            return { startFailure: first.startFailure };
          }
          if (restart.dropWorktree === true) {
            // Gone the way git itself reports it gone. Removing the directory
            // alone leaves the registration behind, and the next `worktree add`
            // then refuses the path outright — a different fault entirely.
            const git = workspace.env["CONFORMANCE_REAL_GIT"] ?? "git";
            for (const iteration of store.iterations) {
              if (iteration.turnStatus !== "running") continue;
              const worktreePath = iteration.worktreePath ?? null;
              if (worktreePath === null) continue;
              NodeFS.rmSync(worktreePath, { recursive: true, force: true });
            }
            NodeChildProcess.spawnSync(git, ["worktree", "prune"], {
              cwd: workspace.cwd,
              stdio: "ignore",
            });
          }
          // The server comes back: a fresh runner layer over the same store,
          // reconciling what the dead one left running.
          yield* Effect.gen(function* () {
            const service = yield* EpicRunner;
            yield* service.start();
            yield* awaitTerminalRun(first.runId);
          }).pipe(Effect.scoped, Effect.provide(runnerLayer));
          return { startFailure: null };
        });

  for (const child of agentProcesses.values()) child.kill("SIGKILL");

  if (executed.startFailure !== null) {
    const failure = executed.startFailure;
    return translateStartFailure({
      scenario,
      workspace,
      failure: failure instanceof Error ? failure : String(failure),
    });
  }
  if (isParallelScenario(scenario)) {
    const landed = landedChildIds(workspace);
    const finalRun = history.at(-1)?.run;
    // Proof the launch really selected the pool loop: a run that silently fell
    // back to one worker would still match the simpler transcripts.
    if (finalRun !== undefined && finalRun.workers !== scenarioWorkers(scenario)) {
      throw new Error(
        `${scenario.name} ran with ${String(finalRun.workers)} workers, not ${String(scenarioWorkers(scenario))}`,
      );
    }
    return normalizeParallelTranscript({
      epicId: scenario.beads.epicId,
      iterations: store.iterations.map((iteration) => ({
        iterationIndex: iteration.iterationIndex,
        issueId: iteration.issueId,
        turnStatus: iteration.turnStatus as "running" | "completed" | "failed" | "abandoned",
        failureReason: iteration.failureReason,
        committed: iteration.issueId !== null && landed.has(iteration.issueId),
      })),
      run: {
        status: finalRun?.status ?? "failed",
        lastError: finalRun?.lastError ?? null,
      },
      comments: beadCommentCounts(workspace),
      releasedClaims: releasedClaimIds(workspace),
    });
  }
  const dispatchHarnesses = dispatched.flatMap((command) => {
    if (command.type !== "thread.create") return [];
    const selectedProvider = scenarioProviders.find(
      (provider) => provider.instanceId === command.modelSelection.instanceId,
    );
    return selectedProvider === undefined ? [] : [transcriptProvider(selectedProvider.driver)];
  });
  if (scenario.name === "provider-fallback-persists") {
    assert.deepEqual(dispatchHarnesses, ["claude", "codex", "kimi"]);
  }
  if (scenario.name === "account-rotation-exhausts-harness") {
    assert.deepEqual(dispatchHarnesses, ["claude", "claude", "codex"]);
  }
  return translateServerRun({
    scenario,
    providers: scenarioProviders,
    workspace,
    history,
    iterations: store.iterations,
  });
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

describe("epic-core conformance through the server adapter", () => {
  it.live(
    "matches every server scenario through the EpicRunner service",
    () =>
      Effect.gen(function* () {
        for (const scenario of scenarios()) {
          const startedAt = yield* Clock.currentTimeMillis;
          const actual = yield* runServerScenario(scenario).pipe(
            Effect.provide(
              Layer.merge(
                NodeServices.layer,
                ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer)),
              ),
            ),
          );
          assert.equal(
            diffTranscripts(actual, scenario.expectedTranscript),
            null,
            describeDiff(scenario, actual),
          );
          assert.isBelow(
            (yield* Clock.currentTimeMillis) - startedAt,
            30_000,
            `${scenario.name} exceeded 30 seconds`,
          );
        }
      }),
    300_000,
  );
});
