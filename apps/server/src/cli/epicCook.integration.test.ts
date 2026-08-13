// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalProcess:off preferSchemaOverJson:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";

const repositoryRoot = NodePath.resolve(import.meta.dirname, "../../../..");
const bin = NodePath.join(repositoryRoot, "apps/server/src/bin.ts");

const run = (
  command: string,
  args: ReadonlyArray<string>,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
) => {
  const result = NodeChildProcess.spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: environment ?? process.env,
    timeout: 60_000,
  });
  if (result.error) throw result.error;
  return result;
};

const requireOk = (result: ReturnType<typeof run>) => {
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
};

const makeFixture = (childCount: number, workerDelaySeconds = 0) => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-epic-cook-"));
  const repo = NodePath.join(root, "repo");
  const runDirectory = NodePath.join(root, "run");
  const worker = NodePath.join(root, "worker.sh");
  const fakeHome = NodePath.join(root, "home");
  NodeFS.mkdirSync(repo, { recursive: true });
  NodeFS.mkdirSync(fakeHome, { recursive: true });
  const bdEnvironment: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: fakeHome,
    XDG_CONFIG_HOME: NodePath.join(root, "config"),
  };
  delete bdEnvironment.BEADS_DIR;
  delete bdEnvironment.BEADS_DOLT_SERVER_HOST;
  requireOk(run("git", ["init", "-b", "mine"], repo));
  requireOk(run("git", ["config", "user.email", "test@example.com"], repo));
  requireOk(run("git", ["config", "user.name", "Test"], repo));
  NodeFS.writeFileSync(NodePath.join(repo, "work.txt"), "start\n");
  requireOk(run("git", ["add", "work.txt"], repo));
  requireOk(run("git", ["commit", "-m", "initial"], repo));
  requireOk(
    run(
      "bd",
      ["init", "--non-interactive", "--stealth", "--skip-agents", "--skip-hooks", "-p", "fixture"],
      repo,
      bdEnvironment,
    ),
  );
  const epic = requireOk(
    run(
      "bd",
      ["create", "Epic", "--type", "epic", "--silent", "-d", "Goal: test local cooking"],
      repo,
      bdEnvironment,
    ),
  );
  for (let index = 0; index < childCount; index += 1) {
    requireOk(
      run(
        "bd",
        ["create", `Child ${String(index + 1)}`, "--type", "task", "--parent", epic, "--silent"],
        repo,
        bdEnvironment,
      ),
    );
  }
  NodeFS.writeFileSync(
    worker,
    `#!/usr/bin/env bash
set -euo pipefail
prompt="$1"
child="$(sed -n 's/^ASSIGNED_CHILD_ID=//p' "$prompt")"
sleep ${String(workerDelaySeconds)}
printf '%s\\n' "$child" >> work.txt
git add work.txt
git commit -m "cook $child" >/dev/null
bd close "$child" --reason "worker completed" >/dev/null
printf 'RALPH_MSG: {"summary":"completed %s","why":"integration test"}\\n' "$child"
`,
  );
  NodeFS.chmodSync(worker, 0o755);

  const environment: NodeJS.ProcessEnv = {
    ...bdEnvironment,
    COOKEPIC_HARNESS: "worker-cmd",
    COOKEPIC_WORKER_CMD: worker,
    COOKEPIC_NO_PUSH: "1",
    // The pool loop is the default shape now, and this worker reads the
    // sequential loop's prompt. Tests of the pool drop this escape.
    COOKEPIC_SEQUENTIAL: "1",
  };
  return { root, repo, runDirectory, fakeHome, epic, environment, bdEnvironment };
};

const cookArgs = (fixture: ReturnType<typeof makeFixture>, runDirectory = fixture.runDirectory) => [
  bin,
  "epic",
  "cook",
  "--epic",
  fixture.epic,
  "--cwd",
  fixture.repo,
  "--run-dir",
  runDirectory,
  "--no-gate",
];

const waitFor = (predicate: () => boolean, timeoutMs = 15_000): void => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for local epic runner state");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
};

const waitChild = (
  child: NodeChildProcess.ChildProcess,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> =>
  new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });

it("cooks two children locally and releases the shared lock", () => {
  const fixture = makeFixture(2);
  const { repo, runDirectory, fakeHome, epic, environment, bdEnvironment } = fixture;
  const cooked = run("node", cookArgs(fixture), repo, environment);
  assert.equal(cooked.status, 0, `${cooked.stdout}\n${cooked.stderr}`);
  assert.match(cooked.stdout, /\tdone\t2\/50/);
  for (const artifact of [
    "run.json",
    "iter-0.json",
    "iter-1.json",
    "loop.log",
    "mailbox.jsonl",
    "summary.md",
  ]) {
    assert.isTrue(NodeFS.existsSync(NodePath.join(runDirectory, artifact)), artifact);
  }
  assert.isFalse(NodeFS.existsSync(NodePath.join(repo, ".beads", `run-lock.${epic}.json`)));
  assert.isFalse(NodeFS.existsSync(NodePath.join(fakeHome, ".t3", "userdata", "state.sqlite")));
  assert.equal(
    requireOk(
      run("bd", ["list", "--parent", epic, "--status", "closed", "--json"], repo, bdEnvironment),
    ).includes("Child 1"),
    true,
  );
});

it("continues a run on its own run id instead of repeating its first iteration", () => {
  const fixture = makeFixture(2);
  const restartArgs = [...cookArgs(fixture), "--run-id", "restart-me"];
  // One iteration for two children: the run stops with a child still open.
  const first = run(
    "node",
    [...restartArgs, "--max-iterations", "1"],
    fixture.repo,
    fixture.environment,
  );
  assert.notEqual(first.status, 0);
  assert.isTrue(NodeFS.existsSync(NodePath.join(fixture.runDirectory, "iter-0.json")));
  const firstIteration = NodeFS.readFileSync(
    NodePath.join(fixture.runDirectory, "iter-0.json"),
    "utf8",
  );

  const second = run(
    "node",
    [...restartArgs, "--max-iterations", "2"],
    fixture.repo,
    fixture.environment,
  );
  assert.equal(second.status, 0, `${second.stdout}\n${second.stderr}`);
  // The second process spent the run's remaining iteration on the second
  // child, and left the first process's row exactly as it found it.
  assert.match(second.stdout, /restart-me\tdone\t2\/2/);
  assert.equal(
    NodeFS.readFileSync(NodePath.join(fixture.runDirectory, "iter-0.json"), "utf8"),
    firstIteration,
  );
  assert.isTrue(NodeFS.existsSync(NodePath.join(fixture.runDirectory, "iter-1.json")));
  assert.isFalse(NodeFS.existsSync(NodePath.join(fixture.runDirectory, "iter-2.json")));
  assert.equal(requireOk(run("git", ["rev-list", "--count", "HEAD"], fixture.repo)), "3");
});

it("drains a worker after STOP and releases the lock", async () => {
  const fixture = makeFixture(1, 1);
  const child = NodeChildProcess.spawn("node", cookArgs(fixture), {
    cwd: fixture.repo,
    env: fixture.environment,
    stdio: "ignore",
  });
  waitFor(
    () =>
      NodeFS.existsSync(fixture.runDirectory) &&
      NodeFS.readdirSync(fixture.runDirectory).some((name) => name.endsWith(".prompt.md")),
  );
  NodeFS.writeFileSync(NodePath.join(fixture.runDirectory, "STOP"), "");
  const exit = await waitChild(child);
  assert.equal(exit.code, 0);
  assert.isNull(exit.signal);
  assert.equal(
    JSON.parse(NodeFS.readFileSync(NodePath.join(fixture.runDirectory, "run.json"), "utf8")).status,
    "cancelled",
  );
  assert.isFalse(
    NodeFS.existsSync(NodePath.join(fixture.repo, ".beads", `run-lock.${fixture.epic}.json`)),
  );
  assert.equal(requireOk(run("git", ["rev-list", "--count", "HEAD"], fixture.repo)), "2");
});

it("reports contention while another local cook owns the epic", async () => {
  const fixture = makeFixture(1, 4);
  const first = NodeChildProcess.spawn("node", cookArgs(fixture), {
    cwd: fixture.repo,
    env: fixture.environment,
    stdio: "ignore",
  });
  const lockPath = NodePath.join(fixture.repo, ".beads", `run-lock.${fixture.epic}.json`);
  waitFor(() => NodeFS.existsSync(lockPath));
  const secondRun = NodePath.join(fixture.root, "second-run");
  const second = run("node", cookArgs(fixture, secondRun), fixture.repo, fixture.environment);
  assert.notEqual(second.status, 0);
  assert.include(`${second.stdout}\n${second.stderr}`, "run_in_progress");
  NodeFS.writeFileSync(NodePath.join(fixture.runDirectory, "STOP"), "");
  await waitChild(first);
  assert.isFalse(NodeFS.existsSync(lockPath));
});

it("drains a worker after SIGTERM and releases the lock", async () => {
  const fixture = makeFixture(1, 1);
  const child = NodeChildProcess.spawn("node", cookArgs(fixture), {
    cwd: fixture.repo,
    env: fixture.environment,
    stdio: "ignore",
  });
  waitFor(
    () =>
      NodeFS.existsSync(fixture.runDirectory) &&
      NodeFS.readdirSync(fixture.runDirectory).some((name) => name.endsWith(".prompt.md")),
  );
  child.kill("SIGTERM");
  const exit = await waitChild(child);
  assert.equal(exit.code, 130);
  assert.isNull(exit.signal);
  const lockPath = NodePath.join(fixture.repo, ".beads", `run-lock.${fixture.epic}.json`);
  assert.isFalse(NodeFS.existsSync(lockPath));
  const runState = JSON.parse(
    NodeFS.readFileSync(NodePath.join(fixture.runDirectory, "run.json"), "utf8"),
  );
  assert.equal(runState.status, "cancelled");
  assert.equal(requireOk(run("git", ["rev-list", "--count", "HEAD"], fixture.repo)), "2");
});

it("drains a worker after SIGINT and releases the lock", async () => {
  const fixture = makeFixture(1, 1);
  const child = NodeChildProcess.spawn("node", cookArgs(fixture), {
    cwd: fixture.repo,
    env: fixture.environment,
    stdio: "ignore",
  });
  waitFor(
    () =>
      NodeFS.existsSync(fixture.runDirectory) &&
      NodeFS.readdirSync(fixture.runDirectory).some((name) => name.endsWith(".prompt.md")),
  );
  child.kill("SIGINT");
  const exit = await waitChild(child);
  assert.equal(exit.code, 130);
  assert.isNull(exit.signal);
  assert.isFalse(
    NodeFS.existsSync(NodePath.join(fixture.repo, ".beads", `run-lock.${fixture.epic}.json`)),
  );
  assert.equal(
    JSON.parse(NodeFS.readFileSync(NodePath.join(fixture.runDirectory, "run.json"), "utf8")).status,
    "cancelled",
  );
});

it("cooks two children through the parallel pool loop with no override", () => {
  const fixture = makeFixture(2);
  const { repo, runDirectory, epic, environment, bdEnvironment } = fixture;
  // The pool prompt carries the child as "Cook exactly `<id>` this
  // iteration." instead of the sequential loop's ASSIGNED_CHILD_ID marker.
  const poolWorker = NodePath.join(fixture.root, "pool-worker.sh");
  NodeFS.writeFileSync(
    poolWorker,
    `#!/usr/bin/env bash
set -euo pipefail
prompt="$1"
child="$(awk '/^Cook exactly / { gsub(/\`/, ""); print $3 }' "$prompt")"
[ -n "$child" ] || { echo 'no child in prompt' >&2; exit 1; }
# One file per child: parallel workers must not conflict with each other.
printf '%s\\n' "$child" >> "$child.txt"
git add "$child.txt"
git commit -m "cook $child" >/dev/null
bd close "$child" --reason "worker completed" >/dev/null
printf 'RALPH_MSG: {"summary":"completed %s","why":"integration test"}\\n' "$child"
`,
  );
  NodeFS.chmodSync(poolWorker, 0o755);
  // No worker count and no execution shape: the shared default alone must
  // select the three-worker pool.
  const poolEnvironment: NodeJS.ProcessEnv = { ...environment, COOKEPIC_WORKER_CMD: poolWorker };
  delete poolEnvironment.COOKEPIC_SEQUENTIAL;
  const result = run("node", cookArgs(fixture), repo, poolEnvironment);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /\tdone\t2\/50/);
  const state = JSON.parse(NodeFS.readFileSync(NodePath.join(runDirectory, "run.json"), "utf8"));
  assert.equal(state.status, "done");
  assert.equal(state.config.parallel.workers, 3);
  assert.equal(state.configProvenance["parallel.workers"], "default");
  // Both child commits landed on the base branch through the merge queue.
  const children = JSON.parse(
    requireOk(
      run("bd", ["list", "--parent", epic, "--all", "--flat", "--json"], repo, bdEnvironment),
    ),
  ) as ReadonlyArray<{ readonly id: string }>;
  assert.equal(children.length, 2);
  for (const child of children) {
    assert.isTrue(
      NodeFS.existsSync(NodePath.join(repo, `${child.id}.txt`)),
      `${child.id} did not land on the base branch`,
    );
  }
  // The integration worktree, its branch, and the merge state are released.
  assert.isFalse(NodeFS.existsSync(NodePath.join(runDirectory, "merge-queue.json")));
  assert.isFalse(NodeFS.existsSync(NodePath.join(runDirectory, "worktrees")));
  assert.equal(requireOk(run("git", ["branch", "--list", "cook-epic-integration-*"], repo)), "");
  assert.isFalse(NodeFS.existsSync(NodePath.join(repo, ".beads", `run-lock.${epic}.json`)));
  for (const child of ["Child 1", "Child 2"]) {
    assert.isTrue(
      requireOk(
        run("bd", ["list", "--parent", epic, "--status", "closed", "--json"], repo, bdEnvironment),
      ).includes(child),
      child,
    );
  }
});

it("lets --gate override a lower disabled gate", () => {
  const fixture = makeFixture(1);
  NodeFS.mkdirSync(NodePath.join(fixture.repo, ".t3code"), { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(fixture.repo, ".t3code", "epic-run.json"),
    JSON.stringify({ gate: { disabled: true } }),
  );
  requireOk(run("git", ["add", ".t3code/epic-run.json"], fixture.repo));
  requireOk(run("git", ["commit", "-m", "config"], fixture.repo));
  const marker = NodePath.join(fixture.root, "gate-ran");
  const result = run(
    "node",
    [
      bin,
      "epic",
      "cook",
      "--epic",
      fixture.epic,
      "--cwd",
      fixture.repo,
      "--run-dir",
      fixture.runDirectory,
      "--gate",
      `touch ${marker}`,
    ],
    fixture.repo,
    fixture.environment,
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.isTrue(NodeFS.existsSync(marker));
});

it("maps supported terminal settings into the shared config", () => {
  const fixture = makeFixture(1);
  const environment = {
    ...fixture.environment,
    COOKEPIC_ENGINE: "shadow",
    T3CODE_EPIC_RUN_ENGINE: "core",
    COOKEPIC_MODEL: "adapter-model",
    COOKEPIC_PERMISSION_MODE: "bypassPermissions",
    COOKEPIC_STOP_GRACE: "7",
    COOKEPIC_SEQUENTIAL: "1",
  };
  const result = run("node", cookArgs(fixture), fixture.repo, environment);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const state = JSON.parse(
    NodeFS.readFileSync(NodePath.join(fixture.runDirectory, "run.json"), "utf8"),
  );
  assert.equal(state.config.supervision.stopGraceSeconds, 7);
  assert.equal(state.config.execution.sequential, true);
  assert.equal(state.config.engine, "core");
  assert.deepEqual(state.config.provider.modelSelection, {
    instanceId: "worker-cmd",
    model: "adapter-model",
  });
  assert.equal(state.config.runtime.mode, "full-access");
  assert.equal(state.configProvenance["supervision.stopGraceSeconds"], "environment");
  assert.equal(state.configProvenance["execution.sequential"], "environment");
  assert.equal(state.configProvenance.engine, "environment");
  assert.equal(state.configProvenance["provider.modelSelection"], "environment");
  assert.equal(state.configProvenance["runtime.mode"], "environment");
  assert.equal(
    `${result.stdout}\n${result.stderr}`.match(/deprecated\. Use the epic-run config key engine/g)
      ?.length,
    1,
  );
});

/**
 * The policy has no CLI surface: it is read from the same `settings.json` the
 * server writes, under the home directory this fixture fakes.
 */
const writeEpicRolePolicy = (fixture: ReturnType<typeof makeFixture>, policy: unknown): void => {
  const settingsDirectory = NodePath.join(fixture.fakeHome, ".t3", "userdata");
  NodeFS.mkdirSync(settingsDirectory, { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(settingsDirectory, "settings.json"),
    JSON.stringify({ epicRolePolicy: policy }),
  );
};

/** A stand-in `claude` that records its argv and reports an epic with no work. */
const writeFakeClaude = (fixture: ReturnType<typeof makeFixture>): { readonly capture: string } => {
  const capture = NodePath.join(fixture.root, "claude-args");
  const binaryPath = NodePath.join(fixture.root, "claude.sh");
  NodeFS.writeFileSync(
    binaryPath,
    `#!/usr/bin/env bash
printf '%s\\n' "$@" > "${capture}"
printf '%s\\n' '{"type":"result","result":"RALPH_DONE","session_id":"s"}'
`,
  );
  NodeFS.chmodSync(binaryPath, 0o755);
  return { capture };
};

const claudeEnvironment = (fixture: ReturnType<typeof makeFixture>): NodeJS.ProcessEnv => {
  const environment: NodeJS.ProcessEnv = {
    ...fixture.environment,
    COOKEPIC_HARNESS: "claude",
    COOKEPIC_BIN: NodePath.join(fixture.root, "claude.sh"),
    // Pin the settings home: a developer shell that exports T3CODE_HOME would
    // otherwise point the cook at the real policy.
    T3CODE_HOME: NodePath.join(fixture.fakeHome, ".t3"),
  };
  // The fixture cooks with a worker command by default, and that wins the
  // harness selection.
  delete environment.COOKEPIC_WORKER_CMD;
  delete environment.VITE_DEV_SERVER_URL;
  return environment;
};

it("hands a claude worker the in-session roles from the persisted policy", () => {
  const fixture = makeFixture(1);
  writeEpicRolePolicy(fixture, {
    tiers: {
      high: {
        hops: [
          // The first hop names an account no terminal cook has, so the chain
          // must walk on to the harness instance.
          { selection: { instanceId: "claude-work", model: "claude-opus-5" } },
          { selection: { instanceId: "claude", model: "sonnet" } },
        ],
      },
    },
    inSessionRoles: {
      planner: { tier: "high", description: "Plans the child.", prompt: "You plan." },
    },
  });
  const { capture } = writeFakeClaude(fixture);
  run("node", cookArgs(fixture), fixture.repo, claudeEnvironment(fixture));
  const args = NodeFS.readFileSync(capture, "utf8").trim().split("\n");
  const agentsIndex = args.indexOf("--agents");
  assert.isAtLeast(agentsIndex, 0, args.join(" "));
  assert.deepEqual(JSON.parse(args[agentsIndex + 1]!), {
    planner: { description: "Plans the child.", prompt: "You plan.", model: "sonnet" },
  });
});

it("emits no --agents when no policy is persisted", () => {
  const fixture = makeFixture(1);
  const { capture } = writeFakeClaude(fixture);
  run("node", cookArgs(fixture), fixture.repo, claudeEnvironment(fixture));
  const args = NodeFS.readFileSync(capture, "utf8").trim().split("\n");
  assert.notInclude(args, "--agents");
});

it("lets the typed engine flag override the deprecated environment shim", () => {
  const fixture = makeFixture(1);
  const result = run("node", [...cookArgs(fixture), "--engine", "shadow"], fixture.repo, {
    ...fixture.environment,
    T3CODE_EPIC_RUN_ENGINE: "core",
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const state = JSON.parse(
    NodeFS.readFileSync(NodePath.join(fixture.runDirectory, "run.json"), "utf8"),
  );
  assert.equal(state.config.engine, "shadow");
  assert.equal(state.configProvenance.engine, "override");
});

it("shows local cook help from TypeScript source", () => {
  const result = run("node", [bin, "epic", "cook", "--help"], repositoryRoot);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--run-dir/);
  assert.match(result.stdout, /--engine/);
  assert.notInclude(result.stdout, "No running T3 Code server");
  const localSource = NodeFS.readFileSync(
    NodePath.join(repositoryRoot, "apps/server/src/cli/epicCook.ts"),
    "utf8",
  );
  for (const forbidden of [
    "ServerConfig",
    "EnvironmentAuth",
    "discoverLiveServer",
    "runEpicCommand",
    "state.sqlite",
  ]) {
    assert.notInclude(localSource, forbidden);
  }
});

it("keeps the local cook transitive import graph server-free", () => {
  const roots: Record<string, string> = {
    "@t3tools/epic-core": NodePath.join(repositoryRoot, "packages/epic-core"),
    "@t3tools/shared": NodePath.join(repositoryRoot, "packages/shared"),
    "@t3tools/contracts": NodePath.join(repositoryRoot, "packages/contracts"),
  };
  const seen = new Set<string>();
  const visit = (file: string): void => {
    if (seen.has(file) || !NodeFS.existsSync(file)) return;
    seen.add(file);
    const source = NodeFS.readFileSync(file, "utf8");
    const imports = [...source.matchAll(/(?:from\s+|import\s*\(\s*)["']([^"']+)["']/g)]
      .map((match) => match[1]!)
      .filter((specifier) => specifier.startsWith(".") || specifier.startsWith("@t3tools/"));
    for (const specifier of imports) {
      if (specifier.startsWith(".")) {
        visit(NodePath.resolve(NodePath.dirname(file), specifier));
        continue;
      }
      const prefix = Object.keys(roots).find(
        (candidate) => specifier === candidate || specifier.startsWith(`${candidate}/`),
      );
      if (prefix === undefined) continue;
      const packageRoot = roots[prefix]!;
      const packageJson = JSON.parse(
        NodeFS.readFileSync(NodePath.join(packageRoot, "package.json"), "utf8"),
      );
      const subpath = specifier === prefix ? "." : `.${specifier.slice(prefix.length)}`;
      const exported = packageJson.exports?.[subpath];
      const target =
        typeof exported === "string" ? exported : (exported?.import ?? exported?.types);
      if (typeof target === "string") visit(NodePath.resolve(packageRoot, target));
    }
  };
  const binPath = NodePath.join(repositoryRoot, "apps/server/src/bin.ts");
  const binSource = NodeFS.readFileSync(binPath, "utf8");
  assert.notMatch(binSource, /^import\s/m);
  seen.add(binPath);
  visit(NodePath.join(repositoryRoot, "apps/server/src/cli/epicCookRunner.ts"));
  const graph = [...seen].join("\n");
  for (const forbidden of [
    "apps/server/src/config.ts",
    "apps/server/src/persistence/",
    "serverRuntimeState.ts",
    "Projection",
    "state.sqlite",
  ]) {
    assert.notInclude(graph, forbidden);
  }
  assert.isAbove(seen.size, 10);
});
