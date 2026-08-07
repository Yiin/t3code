// @effect-diagnostics nodeBuiltinImport:off globalProcess:off preferSchemaOverJson:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { assert, describe, it } from "@effect/vitest";
import { diffTranscripts, type EpicRunTranscriptEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { mailboxToTranscript, parseMailboxJsonl } from "./mailboxTranscript.ts";
import { decodeConformanceScenario, type ConformanceScenario } from "./scenario.ts";
import { makeConformanceWorkspace } from "./workspace.ts";

const packageDirectory = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "..",
);
const repositoryDirectory = NodePath.resolve(packageDirectory, "../..");
const scenariosDirectory = NodePath.join(packageDirectory, "scenarios");
const runner = NodePath.join(repositoryDirectory, "skills/cook-epic/run.sh");
const parallelScenarios = new Set([
  "parallel-worktrees",
  "park-merge-conflict",
  "permission-denial-fast-park",
  "serialized-trial-merge",
  "sibling-repo-layout",
]);

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

const runTerminalScenario = (
  scenario: ConformanceScenario,
): ReadonlyArray<EpicRunTranscriptEvent> => {
  const workspace = makeConformanceWorkspace(scenario);
  const root = NodePath.dirname(workspace.cwd);
  const runDirectory = NodePath.join(root, "terminal-run");
  NodeFS.mkdirSync(runDirectory);
  const siblingPaths = scenario.repo.siblingRepos.map((path) =>
    NodePath.relative(workspace.cwd, NodePath.resolve(root, path)),
  );
  const environment = {
    ...scrubCookEpic(process.env),
    ...workspace.env,
    PATH: `${workspace.binDir}:${process.env.PATH ?? ""}`,
    COOKEPIC_CORE: "0",
    COOKEPIC_EPIC: scenario.beads.epicId,
    COOKEPIC_HARNESS: "claude",
    COOKEPIC_WORKER_CMD: NodePath.join(workspace.binDir, "agent"),
    COOKEPIC_SEQUENTIAL: parallelScenarios.has(scenario.name) ? "0" : "1",
    COOKEPIC_WORKERS: "2",
    COOKEPIC_GATE: "true",
    COOKEPIC_NO_PUSH: "1",
    COOKEPIC_SPAWN_DELAY: "0",
    COOKEPIC_MAX_DISPATCHES: String(
      Math.max(scenario.agentScript.length, maxExpectedAttempts(scenario)),
    ),
    COOKEPIC_MAX_ATTEMPTS: String(maxExpectedAttempts(scenario)),
    COOKEPIC_WORKER_TIMEOUT: "1",
    COOKEPIC_SUPERVISION_TICK: "1",
    COOKEPIC_REPO_PROBE_INTERVAL: "1",
    ...(siblingPaths.length === 0 ? {} : { COOKEPIC_SIBLINGS: siblingPaths.join(" ") }),
  };
  const result = NodeChildProcess.spawnSync("setsid", ["env", runner, runDirectory], {
    cwd: workspace.cwd,
    env: environment,
    encoding: "utf8",
    timeout: 8_000,
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
    throw new Error(`${scenario.name} terminal adapter timed out after 8 seconds`);
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
  return mailboxToTranscript({
    epicId: scenario.beads.epicId,
    records: parseMailboxJsonl(NodeFS.readFileSync(mailbox, "utf8")),
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
    "runs every terminal scenario against the canonical shell adapter",
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
    120_000,
  );
});
