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
  };
  const result = run("node", cookArgs(fixture), fixture.repo, environment);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const state = JSON.parse(
    NodeFS.readFileSync(NodePath.join(fixture.runDirectory, "run.json"), "utf8"),
  );
  assert.equal(state.config.supervision.stopGraceSeconds, 7);
  assert.equal(state.config.engine, "core");
  assert.deepEqual(state.config.provider.modelSelection, {
    instanceId: "worker-cmd",
    model: "adapter-model",
  });
  assert.equal(state.config.runtime.mode, "full-access");
  assert.equal(state.configProvenance["supervision.stopGraceSeconds"], "environment");
  assert.equal(state.configProvenance.engine, "environment");
  assert.equal(state.configProvenance["provider.modelSelection"], "environment");
  assert.equal(state.configProvenance["runtime.mode"], "environment");
  assert.equal(
    `${result.stdout}\n${result.stderr}`.match(/deprecated\. Use the epic-run config key engine/g)
      ?.length,
    1,
  );
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
