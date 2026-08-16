// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalProcess:off preferSchemaOverJson:off
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
  type ConformanceWorkspace,
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
    .filter((scenario) => scenario.appliesTo.includes("terminal"))
    // Every terminal scenario runs inside one test, because each one spawns a
    // real coordinator and the whole set takes minutes. `T3CODE_CONFORMANCE_SCENARIO`
    // narrows that to one by name, which is the difference between a three-minute
    // debugging loop and a ten-second one.
    .filter(
      (scenario) =>
        process.env.T3CODE_CONFORMANCE_SCENARIO === undefined ||
        scenario.name === process.env.T3CODE_CONFORMANCE_SCENARIO,
    );

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

/**
 * The iteration records the run directory holds, newest write wins.
 *
 * The mailbox is the driver's normal window into a run, but a restart has to
 * look at the journal itself: the cut has to land while a worker is actually
 * running, and only the durable record says so while the process that wrote it
 * is still alive.
 */
const journalIterations = (
  runDirectory: string,
): ReadonlyArray<{
  readonly iterationIndex: number;
  readonly turnStatus: string;
  readonly worktreePath: string | null;
}> => {
  if (!NodeFS.existsSync(runDirectory)) return [];
  return NodeFS.readdirSync(runDirectory)
    .filter((name) => /^iter-\d+\.json$/.test(name))
    .flatMap((name) => {
      try {
        const row = JSON.parse(NodeFS.readFileSync(NodePath.join(runDirectory, name), "utf8")) as {
          readonly iterationIndex?: unknown;
          readonly turnStatus?: unknown;
          readonly worktreePath?: unknown;
        };
        return typeof row.iterationIndex === "number" && typeof row.turnStatus === "string"
          ? [
              {
                iterationIndex: row.iterationIndex,
                turnStatus: row.turnStatus,
                worktreePath: typeof row.worktreePath === "string" ? row.worktreePath : null,
              },
            ]
          : [];
      } catch {
        // A record caught mid-rename. The next poll reads it whole.
        return [];
      }
    })
    .sort((left, right) => left.iterationIndex - right.iterationIndex);
};

/** How many workers the fixture agent has been started for, from its transcript. */
const agentStarts = (workspace: ConformanceWorkspace): number =>
  workspace.readTranscript().filter((item) => {
    if (typeof item !== "object" || item === null) return false;
    return (item as Readonly<Record<string, unknown>>)["tool"] === "agent";
  }).length;

/**
 * Whether the run lock still has a live owner.
 *
 * The lock's recorded pid is a detached supervisor, on purpose: a terminal
 * coordinator's workers outlive the leader that spawned them, so the
 * supervisor is what vouches for the run after the leader is gone. It notices
 * its leader died on its own one-second poll and exits, which is why a restart
 * is never instant — the machine that comes back has to wait for the corpse to
 * be provably a corpse. This waits the same way instead of assuming it.
 */
const lockOwnerAlive = (repositoryPath: string): boolean =>
  [NodePath.join(repositoryPath, ".beads"), NodePath.join(repositoryPath, ".git")].some(
    (directory) => {
      if (!NodeFS.existsSync(directory)) return false;
      return NodeFS.readdirSync(directory)
        .filter((name) => name.startsWith("run-lock.") && name.endsWith(".json"))
        .some((name) => {
          try {
            const holder = JSON.parse(
              NodeFS.readFileSync(NodePath.join(directory, name), "utf8"),
            ) as { readonly pid?: unknown };
            if (typeof holder.pid !== "number") return false;
            process.kill(holder.pid, 0);
            return true;
          } catch (cause) {
            return (cause as NodeJS.ErrnoException).code === "EPERM";
          }
        });
    },
  );

/** Whether a pid, or the whole process group under it, is still alive. */
const processAlive = (pid: number | undefined, group = false): boolean => {
  if (pid === undefined) return false;
  try {
    process.kill(group ? -pid : pid, 0);
    return true;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === "EPERM";
  }
};

const sleepMs = (milliseconds: number): void => {
  const shared = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(shared), 0, 0, milliseconds);
};

/**
 * Whether this host can put a worker in its own systemd scope.
 *
 * Liveness supervision reads the worker's cgroup for the process histogram it
 * confirms a stop against, and `TerminalWorkerEvidence` accepts only a
 * `cook-epic-*.scope` leaf. Without a systemd user manager there is no such
 * cgroup, the machine reports the fingerprint unavailable, and by design it
 * never stops a worker on evidence it could not read. So a supervision
 * scenario does not apply to such a host, and saying so beats a sixty-second
 * timeout that reads like a runner bug.
 */
const hostSupportsWorkerScopes = (): boolean =>
  NodeChildProcess.spawnSync("systemd-run", ["--user", "--scope", "--quiet", "--", "true"], {
    stdio: "ignore",
  }).status === 0;

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
    `${JSON.stringify({
      server: { retryBaseDelayMs: 5, retryMaxDelayMs: 5 },
      /**
       * The supervision cadence, compressed onto a real clock.
       *
       * The core leg counts simulated seconds; this one waits them out, so the
       * numbers are the smallest the schema allows, including the machine's
       * own tick. That confirms a wedged worker on the second tick, about two
       * seconds in — well inside the thirty-second wall-clock cap the
       * scenario also carries, which is the whole point: the stop must come
       * from the evidence, not the cap. Before `supervisionTickSeconds` was
       * configurable that tick was fixed at five seconds, so the verdict and
       * the cap landed close enough on a loaded runner to race (t3code-sx7).
       */
      ...(scenario.supervision === undefined
        ? {}
        : {
            supervision: {
              idleThresholdSeconds: 1,
              inspectMinDelaySeconds: 1,
              inspectRetryDelaySeconds: 1,
              supervisionTickSeconds: 1,
              uncertainStopCeiling: 2,
            },
          }),
    })}\n`,
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
    // A lone ready child still runs in place under the shared core's `auto`
    // default (execution.mode). Pin `parallel` so these scenarios keep
    // exercising the pooled worktree/merge-queue path they were written for,
    // matching the pin `coreDriver.test.ts` already carries for the same
    // reason.
    ...(isParallelScenario(scenario)
      ? { COOKEPIC_WORKERS: String(scenarioWorkers(scenario)), COOKEPIC_MODE: "parallel" }
      : { COOKEPIC_SEQUENTIAL: "1" }),
    COOKEPIC_GATE: "true",
    COOKEPIC_NO_PUSH: "1",
    COOKEPIC_MAX_DISPATCHES: String(maximumIterations(scenario)),
    // The core leg always runs with the default per-child budget of 3.
    COOKEPIC_MAX_ATTEMPTS: String(Math.max(3, maxExpectedAttempts(scenario))),
    // A pool worker has to outlive its siblings' merges; one second only ever
    // bounded a lone sequential worker.
    COOKEPIC_WORKER_TIMEOUT: isParallelScenario(scenario) ? "30" : "1",
    // Pin the settings home: the CLI resolves it from the real homedir
    // regardless of $HOME, so an operator shell would otherwise leak its own
    // role policy into the fixture (see core-delegation.sh's same pin).
    T3CODE_HOME: NodePath.join(root, "home", ".t3"),
  };
  const mailbox = NodePath.join(runDirectory, "mailbox.jsonl");
  /**
   * What a killed process left in the mailbox.
   *
   * `run.sh` truncates the mailbox at every invocation, so the second one
   * starts a fresh file. The transcript is still the union of both process
   * lifetimes, and `parseParallelMailbox` keeps the last state each iteration
   * reached, so concatenating in order gives exactly that.
   */
  let carriedMailbox = "";
  const runLeg = (): NodeChildProcess.SpawnSyncReturns<string> => {
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
    return result;
  };

  /**
   * Cut the run the way a machine cuts it: SIGKILL to the whole process group,
   * mid-turn, with no finalizer.
   *
   * The in-process core leg has to approximate this by interrupting a fiber and
   * suppressing the releases a dead process would never have run. Here nothing
   * is approximated — the coordinator, its workers and their worktree cleanup
   * all die where they stand, and what the second invocation finds on disk is
   * what a real crash leaves.
   */
  const cutFirstLeg = (restart: NonNullable<ConformanceScenario["restart"]>): void => {
    /**
     * Launched through a shell that backgrounds it and exits, so this process
     * is not its parent.
     *
     * Every wait in this driver is a synchronous poll — the leg runs in a
     * process this thread never yields to, so an exit event would only arrive
     * once the polling stopped. A child of this process would then sit as an
     * unreaped zombie and read as alive forever. Orphaning it hands the reaping
     * to init, and `kill(pid, 0)` alone answers the only question here.
     */
    const launch = NodeChildProcess.spawnSync(
      "sh",
      ["-c", 'setsid env "$0" "$1" >"$1/leg-1.log" 2>&1 & echo "$!"', runner, runDirectory],
      { cwd: workspace.cwd, env: environment, encoding: "utf8" },
    );
    const leader = Number.parseInt(launch.stdout.trim(), 10);
    if (!Number.isInteger(leader) || leader < 1) {
      throw new Error(
        `${scenario.name} could not start its first invocation: ${launch.stderr.trim()}`,
      );
    }
    const deadline = Date.now() + 60_000;
    let cut = false;
    while (Date.now() < deadline) {
      const rows = journalIterations(runDirectory);
      // The row alone is not enough: it is written before the turn is spawned,
      // so a cut that only waited for it would kill a worker that never ran and
      // leave the fixture agent's step counter where it started.
      if (
        rows.length >= restart.cutAfterRows &&
        rows.at(-1)?.turnStatus === "running" &&
        agentStarts(workspace) >= restart.cutAfterRows
      ) {
        cut = true;
        break;
      }
      if (!processAlive(leader)) break;
      sleepMs(25);
    }
    const carried = NodeFS.existsSync(mailbox) ? NodeFS.readFileSync(mailbox, "utf8") : "";
    // A killed process can be cut mid-line. Terminating what it wrote keeps the
    // second invocation's first event from being glued onto a partial one.
    carriedMailbox = carried === "" || carried.endsWith("\n") ? carried : `${carried}\n`;
    try {
      process.kill(-leader, "SIGKILL");
    } catch {
      // The process group already exited.
    }
    if (!cut) {
      throw new Error(
        `${scenario.name} never reached ${String(restart.cutAfterRows)} iteration rows with a running worker; rows: ${JSON.stringify(
          journalIterations(runDirectory),
        )}`,
      );
    }
    /**
     * Two things must be provably gone before the second invocation starts: the
     * killed process group, and the run lock's owner. Waiting for both is not
     * politeness — a restart that races either one is testing the race, not the
     * restart.
     */
    const settleBy = Date.now() + 20_000;
    while ((processAlive(leader, true) || lockOwnerAlive(workspace.cwd)) && Date.now() < settleBy) {
      sleepMs(50);
    }
    if (processAlive(leader, true) || lockOwnerAlive(workspace.cwd)) {
      throw new Error(
        `${scenario.name} could not cut its first invocation: the process group or the run lock owner outlived the kill`,
      );
    }
    if (restart.dropWorktree === true) {
      // Gone the way git itself reports it gone. Removing the directory alone
      // leaves the registration behind, and the next `worktree add` then
      // refuses the path outright — a different fault from this one.
      for (const row of journalIterations(runDirectory)) {
        if (row.turnStatus !== "running" || row.worktreePath === null) continue;
        NodeFS.rmSync(row.worktreePath, { recursive: true, force: true });
      }
      NodeChildProcess.spawnSync("git", ["worktree", "prune"], {
        cwd: workspace.cwd,
        stdio: "ignore",
      });
    }
  };

  if (scenario.restart !== undefined) cutFirstLeg(scenario.restart);
  const result = runLeg();
  if (!NodeFS.existsSync(mailbox)) {
    throw new Error(
      `${scenario.name} terminal adapter produced no mailbox (status ${String(result.status)}): ${result.stderr.trim()}`,
    );
  }
  const values = parseCoreMailbox(`${carriedMailbox}${NodeFS.readFileSync(mailbox, "utf8")}`);
  if (values.length === 0) {
    return synthesizePreflightFailure(scenario, `${result.stdout}\n${result.stderr}`);
  }
  if (isParallelScenario(scenario)) {
    const pool = parseParallelMailbox(values);
    // Proof that `COOKEPIC_WORKERS` actually selected the pool loop. A
    // sequential fallback would still produce a matching transcript for the
    // simpler scenarios, and the leg would claim a parallel run it never made.
    if (pool.run.status === "running") {
      // The run never reached a decision: the leg died, or refused to start at
      // all. Both look like an empty transcript downstream, which says nothing.
      throw new Error(
        `${scenario.name} left its run row running (exit ${String(result.status)}): ${`${result.stdout}\n${result.stderr}`.trim().slice(-2_000)}`,
      );
    }
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
        const workerScopes = hostSupportsWorkerScopes();
        for (const scenario of scenarios()) {
          if (scenario.supervision !== undefined && !workerScopes) {
            // Reported, never quietly dropped. This leg is already opt-in, so
            // whoever turned it on gets told which precondition their host
            // fails rather than a green run that proved less than it claims.
            divergences.push(
              `${scenario.name} cannot run on this host: no systemd user manager, so a worker gets no cgroup and liveness has no evidence to confirm a stop against`,
            );
            continue;
          }
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
