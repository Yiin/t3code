// @effect-diagnostics nodeBuiltinImport:off globalProcess:off preferSchemaOverJson:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { assert, describe, it } from "@effect/vitest";
import { diffTranscripts, type EpicRunTranscriptEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { normalizeCoreMailbox, parseCoreMailbox, parseParallelMailbox } from "./coreMailbox.ts";
import { normalizeParallelTranscript } from "./parallelTranscript.ts";
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
} from "./workspace.ts";

const packageDirectory = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "..",
);
const repositoryDirectory = NodePath.resolve(packageDirectory, "../..");
const scenariosDirectory = NodePath.join(packageDirectory, "scenarios");
const runner = NodePath.join(repositoryDirectory, "skills/cook-epic/run.sh");
const t3Source = NodePath.join(repositoryDirectory, "apps/server/src/bin.ts");

const scenarios = (): ReadonlyArray<ConformanceScenario> =>
  NodeFS.readdirSync(scenariosDirectory)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) =>
      decodeConformanceScenario(
        JSON.parse(NodeFS.readFileSync(NodePath.join(scenariosDirectory, name), "utf8")),
      ),
    )
    .filter((scenario) => scenario.appliesTo.includes("terminal"));

const scrubCookEpic = (environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
  Object.fromEntries(
    Object.entries(environment).filter(
      ([name, value]) => value !== undefined && !name.startsWith("COOKEPIC_"),
    ),
  );

const maxExpectedAttempts = (scenario: ConformanceScenario): number =>
  Math.max(
    1,
    ...scenario.expectedTranscript.flatMap((event) =>
      event.attempts === undefined ? [] : [event.attempts],
    ),
  );

const maximumIterations = (scenario: ConformanceScenario): number =>
  Math.max(
    1,
    scenario.agentScript.length,
    maxExpectedAttempts(scenario),
    ...scenario.expectedTranscript.flatMap((event) =>
      event.iterationIndex === null ? [] : [event.iterationIndex + 1],
    ),
  );

const runGit = (cwd: string, args: ReadonlyArray<string>): void => {
  const result = NodeChildProcess.spawnSync("git", [...args], { cwd, stdio: "ignore" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed in ${cwd}`);
};

const beadComments = (statePath: string | undefined): ReadonlyMap<string, number> => {
  if (statePath === undefined) return new Map();
  const state = JSON.parse(NodeFS.readFileSync(statePath, "utf8")) as {
    readonly children?: ReadonlyArray<Record<string, unknown>>;
  };
  return new Map(
    (state.children ?? []).flatMap((child) =>
      typeof child["id"] === "string" && typeof child["comment_count"] === "number"
        ? [[child["id"], child["comment_count"]] as const]
        : [],
    ),
  );
};

const synthesizePreflightFailure = (
  scenario: ConformanceScenario,
  output: string,
): ReadonlyArray<EpicRunTranscriptEvent> => {
  const common = {
    sequence: 0,
    epicId: scenario.beads.epicId,
    issueId: null,
    iterationIndex: null,
    pushed: false,
    verified: true,
  } as const;
  if (output.includes("run_in_progress")) {
    return [
      {
        _tag: "lock_held",
        ...common,
        ...(scenario.beads.runInProgress ? { reason: "run in progress" } : {}),
      },
    ];
  }
  if (output.includes("epic_not_found")) {
    return [{ _tag: "finished", ...common, status: "failed", reason: "epic not found" }];
  }
  if (output.includes("detached_head") || output.includes("Could not resolve the current branch")) {
    // The terminal CLI rejects a detached HEAD before preflight runs: `t3 epic
    // cook` resolves the base branch first and fails with this message.
    return [{ _tag: "finished", ...common, status: "failed", reason: "detached head" }];
  }
  if (output.includes("dirty_tree")) {
    return [{ _tag: "finished", ...common, status: "failed", reason: "dirty tree" }];
  }
  throw new Error(`unexpected terminal preflight output for ${scenario.name}: ${output.trim()}`);
};

const runTerminalScenario = (
  scenario: ConformanceScenario,
): ReadonlyArray<EpicRunTranscriptEvent> => {
  const workspace = makeConformanceWorkspace(scenario);
  const root = NodePath.dirname(workspace.cwd);
  const runDirectory = NodePath.join(root, "terminal-run");
  NodeFS.mkdirSync(runDirectory);
  // Hermetic t3 resolution: the shim finds this wrapper on the fixture PATH.
  NodeFS.writeFileSync(
    NodePath.join(workspace.binDir, "t3"),
    `#!/usr/bin/env bash\nexec "${process.execPath}" "${t3Source}" "$@"\n`,
    { mode: 0o755 },
  );
  // Compress the retry backoff like the in-process core leg does; the run
  // config file is committed so preflight still sees a clean tree.
  NodeFS.mkdirSync(NodePath.join(workspace.cwd, ".t3code"));
  NodeFS.writeFileSync(
    NodePath.join(workspace.cwd, ".t3code", "epic-run.json"),
    `${JSON.stringify({ server: { retryBaseDelayMs: 5, retryMaxDelayMs: 5 } })}\n`,
  );
  runGit(workspace.cwd, ["add", ".t3code/epic-run.json"]);
  runGit(workspace.cwd, ["commit", "-qm", "run config"]);
  const environment = {
    ...scrubCookEpic(process.env),
    ...workspace.env,
    PATH: `${workspace.binDir}:${process.env.PATH ?? ""}`,
    COOKEPIC_EPIC: scenario.beads.epicId,
    COOKEPIC_HARNESS: "claude",
    // worker-cmd pinpoints the fixture agent for every scenario except the
    // provider fallback chain, which must route through the harness shims.
    ...(scenario.name === "provider-fallback-persists"
      ? {}
      : { COOKEPIC_WORKER_CMD: NodePath.join(workspace.binDir, "agent") }),
    ...(isParallelScenario(scenario)
      ? { COOKEPIC_WORKERS: String(scenarioWorkers(scenario)) }
      : { COOKEPIC_SEQUENTIAL: "1" }),
    COOKEPIC_GATE: "true",
    COOKEPIC_NO_PUSH: "1",
    COOKEPIC_MAX_DISPATCHES: String(maximumIterations(scenario)),
    // The core leg always runs with the default per-child budget of 3.
    COOKEPIC_MAX_ATTEMPTS: String(Math.max(3, maxExpectedAttempts(scenario))),
    // A pool worker has to outlive its siblings' merges; one second only ever
    // bounded a lone sequential worker.
    COOKEPIC_WORKER_TIMEOUT: isParallelScenario(scenario) ? "30" : "1",
  };
  const result = NodeChildProcess.spawnSync("setsid", ["env", runner, runDirectory], {
    cwd: workspace.cwd,
    env: environment,
    encoding: "utf8",
    timeout: 60_000,
    killSignal: "SIGKILL",
  });
  const spawnError = result.error as NodeJS.ErrnoException | undefined;
  if (spawnError?.code === "ETIMEDOUT" && result.pid > 0) {
    try {
      process.kill(-result.pid, "SIGKILL");
    } catch {
      // The process group already exited.
    }
  }
  if (spawnError?.code === "ETIMEDOUT") {
    throw new Error(`${scenario.name} terminal adapter timed out after 60 seconds`);
  }
  if (spawnError !== undefined) {
    throw new Error(`${scenario.name} terminal adapter failed to start`, { cause: spawnError });
  }
  const mailbox = NodePath.join(runDirectory, "mailbox.jsonl");
  if (!NodeFS.existsSync(mailbox)) {
    throw new Error(
      `${scenario.name} terminal adapter produced no mailbox (status ${String(result.status)}): ${result.stderr.trim()}`,
    );
  }
  const values = parseCoreMailbox(NodeFS.readFileSync(mailbox, "utf8"));
  if (values.length === 0) {
    return synthesizePreflightFailure(scenario, `${result.stdout}\n${result.stderr}`);
  }
  if (isParallelScenario(scenario)) {
    const pool = parseParallelMailbox(values);
    // Proof that `COOKEPIC_WORKERS` actually selected the pool loop. A
    // sequential fallback would still produce a matching transcript for the
    // simpler scenarios, and the leg would claim a parallel run it never made.
    if (pool.run.workers !== scenarioWorkers(scenario)) {
      throw new Error(
        `${scenario.name} ran with ${String(pool.run.workers)} workers, not ${String(scenarioWorkers(scenario))}`,
      );
    }
    const landed = landedChildIds(workspace);
    return normalizeParallelTranscript({
      epicId: scenario.beads.epicId,
      iterations: pool.iterations.map((iteration) => ({
        ...iteration,
        committed: iteration.issueId !== null && landed.has(iteration.issueId),
      })),
      run: pool.run,
      comments: beadCommentCounts(workspace),
      releasedClaims: releasedClaimIds(workspace),
    });
  }
  return normalizeCoreMailbox(values, scenario.beads.epicId, {
    comments: beadComments(workspace.env["CONFORMANCE_STATE"]),
    maxIterations: maximumIterations(scenario),
  });
};

const describeDiff = (
  scenario: ConformanceScenario,
  actual: ReadonlyArray<EpicRunTranscriptEvent>,
): string => {
  const diff = diffTranscripts(actual, scenario.expectedTranscript);
  return diff === null
    ? ""
    : `${scenario.name} diverged at index ${String(diff.index)}\nterminal: ${JSON.stringify(diff.left)}\nexpected: ${JSON.stringify(diff.right)}`;
};

describe("terminal adapter conformance", () => {
  it.live.skipIf(!process.env.T3CODE_CONFORMANCE_TERMINAL)(
    "runs every terminal scenario against the shared core through run.sh",
    () =>
      Effect.sync(() => {
        const divergences: string[] = [];
        for (const scenario of scenarios()) {
          try {
            const actual = runTerminalScenario(scenario);
            const message = describeDiff(scenario, actual);
            if (message !== "") divergences.push(message);
          } catch (cause) {
            divergences.push(
              `${scenario.name} driver failure: ${cause instanceof Error ? cause.message : String(cause)}`,
            );
          }
        }
        assert.deepEqual(divergences, [], divergences.join("\n\n"));
      }),
    600_000,
  );
});
