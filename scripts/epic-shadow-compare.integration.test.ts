// @effect-diagnostics nodeBuiltinImport:off globalProcess:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { expect, it } from "vite-plus/test";

const repositoryRoot = NodePath.resolve(import.meta.dirname, "..");
const script = NodePath.join(repositoryRoot, "scripts", "epic-shadow-compare.ts");

const run = (
  command: string,
  args: ReadonlyArray<string>,
  cwd: string,
  environment: NodeJS.ProcessEnv,
) => {
  const result = NodeChildProcess.spawnSync(command, args, {
    cwd,
    env: environment,
    encoding: "utf8",
    timeout: 120_000,
  });
  if (result.error) throw result.error;
  return result;
};

const requireOk = (result: ReturnType<typeof run>): string => {
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  return result.stdout.trim();
};

it("reads paired transcripts in shadow mode without running adapters", () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "epic-shadow-read-"));
  const event = {
    _tag: "done",
    sequence: 0,
    epicId: "epic",
    issueId: "epic.1",
    iterationIndex: 0,
  };
  NodeFS.writeFileSync(
    NodePath.join(root, "terminal.jsonl"),
    `${JSON.stringify({ ...event, summary: "terminal" })}\n`,
  );
  NodeFS.writeFileSync(
    NodePath.join(root, "core.jsonl"),
    `${JSON.stringify({ ...event, summary: "core" })}\n`,
  );
  const result = run(
    "node",
    [
      script,
      "--epic",
      "epic",
      "--cwd",
      repositoryRoot,
      "--adapters",
      "terminal,core",
      "--mode",
      "shadow",
      "--transcript-dir",
      root,
    ],
    repositoryRoot,
    process.env,
  );
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain("structural divergences: 0");
  expect(result.stdout).toContain("content divergences: 1");
});

it("prints both events and fails for one shadow structural divergence", () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "epic-shadow-diff-"));
  const event = {
    sequence: 0,
    epicId: "epic",
    issueId: "epic.1",
    iterationIndex: 0,
  };
  NodeFS.writeFileSync(
    NodePath.join(root, "terminal.jsonl"),
    `${JSON.stringify({ ...event, _tag: "blocked" })}\n`,
  );
  NodeFS.writeFileSync(
    NodePath.join(root, "core.jsonl"),
    `${JSON.stringify({ ...event, _tag: "retry" })}\n`,
  );
  const result = run(
    "node",
    [
      script,
      "--epic",
      "epic",
      "--cwd",
      repositoryRoot,
      "--adapters",
      "terminal,core",
      "--mode",
      "shadow",
      "--transcript-dir",
      root,
    ],
    repositoryRoot,
    process.env,
  );
  expect(result.status).toBe(1);
  expect(result.stdout).toContain("structural divergences: 1");
  expect(result.stdout).toContain("structural at 0");
  expect(result.stdout).toContain('terminal: {"_tag":"blocked"');
  expect(result.stdout).toContain('core: {"_tag":"retry"');
});

it("rejects shadow transcripts for a different epic", () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "epic-shadow-wrong-"));
  const event = {
    _tag: "done",
    sequence: 0,
    epicId: "wrong",
    issueId: "wrong.1",
    iterationIndex: 0,
  };
  for (const adapter of ["terminal", "core"]) {
    NodeFS.writeFileSync(NodePath.join(root, `${adapter}.jsonl`), `${JSON.stringify(event)}\n`);
  }
  const result = run(
    "node",
    [
      script,
      "--epic",
      "epic",
      "--cwd",
      repositoryRoot,
      "--adapters",
      "terminal,core",
      "--mode",
      "shadow",
      "--transcript-dir",
      root,
    ],
    repositoryRoot,
    process.env,
  );
  expect(result.status).toBe(2);
  expect(result.stderr).toContain("terminal transcript contains epic wrong; expected epic.");
});

it("compares a three-child fixture through terminal and core adapters", () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "epic-shadow-integration-"));
  const repo = NodePath.join(root, "repo");
  const home = NodePath.join(root, "home");
  const worker = NodePath.join(root, "worker.sh");
  NodeFS.mkdirSync(repo, { recursive: true });
  NodeFS.mkdirSync(NodePath.join(home, ".config"), { recursive: true });
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    EPIC_SHADOW_WORKER_CMD: worker,
  };
  for (const key of ["BEADS_DIR", "BEADS_DOLT_SERVER_HOST", "BEADS_DOLT_SERVER_PORT"]) {
    delete environment[key];
  }

  requireOk(run("git", ["init", "-q", "-b", "shadow-fixture"], repo, environment));
  requireOk(run("git", ["config", "user.name", "Shadow Fixture"], repo, environment));
  requireOk(run("git", ["config", "user.email", "shadow@example.com"], repo, environment));
  requireOk(run("git", ["commit", "--allow-empty", "-qm", "baseline"], repo, environment));
  requireOk(
    run(
      "bd",
      ["init", "--non-interactive", "--stealth", "--skip-agents", "--skip-hooks", "-p", "fixture"],
      repo,
      environment,
    ),
  );
  const epic = requireOk(
    run(
      "bd",
      ["create", "Fixture epic", "--type", "epic", "--silent", "-d", "Compare adapters"],
      repo,
      environment,
    ),
  );
  for (let index = 1; index <= 3; index += 1) {
    requireOk(
      run(
        "bd",
        ["create", `Child ${String(index)}`, "--type", "task", "--parent", epic, "--silent"],
        repo,
        environment,
      ),
    );
  }
  NodeFS.writeFileSync(
    worker,
    `#!/usr/bin/env bash
set -euo pipefail
prompt="$1"
child=$(sed -n 's/^ASSIGNED_CHILD_ID=//p' "$prompt" | head -n 1)
if [ -z "$child" ]; then
  child=$(awk '/single assignment is the child issue/{print substr($NF,1,length($NF)-1); exit}' "$prompt")
fi
git commit --allow-empty -qm "cook $child"
bd close "$child" --reason fixture >/dev/null
printf 'RALPH_MSG: {"summary":"cooked %s","why":"fixture"}\n' "$child"
`,
    { mode: 0o755 },
  );

  const result = run(
    "node",
    [script, "--epic", epic, "--cwd", repo, "--adapters", "terminal,core", "--mode", "run"],
    repositoryRoot,
    environment,
  );
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  expect(result.stdout).toContain("structural divergences: 0");
  expect(result.stdout).toContain("final child statuses");
  expect(result.stdout).toContain("commits per child");
  expect(result.stdout).not.toContain('"commits":null');
  expect(requireOk(run("git", ["rev-list", "--count", "HEAD"], repo, environment))).toBe("1");
  const statuses = JSON.parse(
    requireOk(run("bd", ["list", "--parent", epic, "--all", "--json"], repo, environment)),
  ) as ReadonlyArray<{ status: string }>;
  expect(statuses.map(({ status }) => status)).toEqual(["open", "open", "open"]);
}, 120_000);
