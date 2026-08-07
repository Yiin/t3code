// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalProcess:off preferSchemaOverJson:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  DEFAULT_EPIC_RUN_CONFIG,
  DEFAULT_EPIC_RUN_CONFIG_PROVENANCE,
  ProviderInstanceId,
  diffTranscripts,
  type EpicRunConfig,
  type EpicRunTranscriptEvent,
} from "@t3tools/contracts";
import * as EpicRunPreflight from "@t3tools/epic-core/EpicRunPreflight";
import * as EpicRunConfigSource from "@t3tools/epic-core/EpicRunConfigSource";
import {
  runSequentialEpicLoop,
  type SequentialEpicLoopPorts,
} from "@t3tools/epic-core/SequentialEpicLoop";
import * as FileRunJournal from "@t3tools/epic-core/adapters/FileRunJournal";
import * as NodeEpicRunLock from "@t3tools/epic-core/adapters/NodeEpicRunLock";
import { makeProcessBacklog } from "@t3tools/epic-core/adapters/ProcessBacklog";
import { makeProcessGate } from "@t3tools/epic-core/adapters/ProcessGate";
import { makeProcessVcs } from "@t3tools/epic-core/adapters/ProcessVcs";
import { makeTerminalAgentDispatch } from "@t3tools/epic-core/adapters/TerminalAgentDispatch";
import * as ProcessRunner from "@t3tools/epic-core/processRunner";
import { DEFAULT_MAX_NO_COMMIT_STREAK } from "@t3tools/epic-core/policy";
import { EpicRunLock } from "@t3tools/epic-core/ports/EpicRunLock";
import type { RunEvent } from "@t3tools/epic-core/ports/RunEvents";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as Layer from "effect/Layer";

import { decodeConformanceScenario, type ConformanceScenario } from "./scenario.ts";
import { makeConformanceWorkspace, type ConformanceWorkspace } from "./workspace.ts";

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

const compressedConfig = (scenario: ConformanceScenario): EpicRunConfig => ({
  ...DEFAULT_EPIC_RUN_CONFIG,
  gate: { command: "true", disabled: false },
  vcs: { noPush: true },
  execution: { sequential: true },
  limits: {
    ...DEFAULT_EPIC_RUN_CONFIG.limits,
    maxIterations: maximumIterations(scenario),
  },
  supervision: {
    ...DEFAULT_EPIC_RUN_CONFIG.supervision,
    // The persisted schema stores whole seconds. The dispatcher below uses the
    // fixture-only 500 ms deadline requested by the conformance contract.
    workerTimeoutSeconds: 1,
    stopGraceSeconds: 1,
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
    if (iteration.turnStatus === "completed") {
      if (iteration.headBefore === iteration.headAfter) {
        output.push({
          _tag: "completed-no-code",
          ...common,
          comments: issueId === null ? 0 : (comments.get(issueId) ?? 0),
        });
      } else {
        if (dispatched.has(iteration.iterationIndex)) {
          output.push({ _tag: "dispatched", ...common, sequence: output.length });
        }
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
    return yield* Effect.gen(function* () {
      const lock = yield* EpicRunLock;
      const preflight = yield* EpicRunPreflight.EpicRunPreflight;
      const journal = yield* FileRunJournal.make({ runDirectory });
      const ports: SequentialEpicLoopPorts = {
        preflight,
        lock,
        backlog: makeProcessBacklog({ repositoryPath: workspace.cwd, processRunner: runner }),
        journal,
        events: {
          publish: (event) =>
            Effect.sync(() => {
              events.push(event);
            }),
        },
        dispatch: makeTerminalAgentDispatch({
          harness: "worker-cmd",
          artifactsDirectory: runDirectory,
          workerCommand: NodePath.join(workspace.binDir, "agent"),
          timeoutSeconds: 0.5,
          stopGraceSeconds: 1,
          environment: workspace.env,
        }),
        gate: makeProcessGate({
          processRunner: runner,
          environment: { ...process.env, ...workspace.env },
          uid: process.getuid?.() ?? 0,
        }),
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
            selection: {
              instanceId: ProviderInstanceId.make("worker-cmd"),
              model: "fixture",
            },
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
      return { result, events };
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
  return translateCoreEvents({ scenario, workspace, events: executed.events });
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

describe("epic-core conformance", () => {
  it.live(
    "matches every core scenario through real git and bd subprocesses",
    () =>
      Effect.gen(function* () {
        for (const scenario of scenarios()) {
          const startedAt = yield* Clock.currentTimeMillis;
          const actual = yield* runCoreScenario(scenario);
          assert.equal(
            diffTranscripts(actual, scenario.expectedTranscript),
            null,
            describeDiff(scenario, actual),
          );
          assert.isBelow(
            (yield* Clock.currentTimeMillis) - startedAt,
            5_000,
            `${scenario.name} exceeded 5 seconds`,
          );
        }
      }),
    90_000,
  );
});
