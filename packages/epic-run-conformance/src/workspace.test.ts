// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { assert, describe, it } from "@effect/vitest";
import { parseTerminalArtifact } from "@t3tools/epic-core/adapters/TerminalAgentDispatch";

import { decodeConformanceScenario, type ConformanceScenario } from "./scenario.ts";
import { materializeConformanceWorkspace, type ConformanceWorkspace } from "./workspace.ts";

const packageDirectory = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "..",
);
const scenariosDirectory = NodePath.join(packageDirectory, "scenarios");
const scenarioFiles = (): string[] =>
  NodeFS.readdirSync(scenariosDirectory)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => NodePath.join(scenariosDirectory, name));
const loadScenario = (path: string): ConformanceScenario =>
  decodeConformanceScenario(JSON.parse(NodeFS.readFileSync(path, "utf8")));
const requiredScenarioNames = [
  "happy-path",
  "no-commit-gutter",
  "no-commit-child-closed",
  "child-failure-budget",
  "infra-failure-budget",
  "ralph-blocked-child-budget",
  "provider-fallback-persists",
  "stranded-child-reopened",
  "preflight-detached-head",
  "preflight-dirty-tree",
  "preflight-run-in-progress",
  "preflight-epic-not-found",
  "lock-held",
  "iteration-timeout",
  "parallel-worktrees",
  "serialized-trial-merge",
  "park-merge-conflict",
  "sibling-repo-layout",
  "permission-denial-fast-park",
  "ready-unrecognised",
] as const;

const run = (
  workspace: ConformanceWorkspace,
  command: string,
  args: ReadonlyArray<string>,
  extraEnv: Readonly<Record<string, string>> = {},
) =>
  NodeChildProcess.spawnSync(NodePath.join(workspace.binDir, command), args, {
    cwd: workspace.cwd,
    encoding: "utf8",
    env: { ...process.env, ...workspace.env, ...extraEnv },
    timeout: 2_000,
  });

const treeDigest = (root: string): string => {
  const records: string[] = [];
  const visit = (directory: string): void => {
    for (const name of NodeFS.readdirSync(directory).sort()) {
      const absolute = NodePath.join(directory, name);
      const relative = NodePath.relative(root, absolute);
      const stat = NodeFS.lstatSync(absolute);
      if (stat.isDirectory()) {
        records.push(`d ${relative}`);
        visit(absolute);
      } else if (stat.isSymbolicLink()) {
        records.push(`l ${relative} ${NodeFS.readlinkSync(absolute)}`);
      } else {
        const digest = NodeCrypto.createHash("sha256")
          .update(NodeFS.readFileSync(absolute))
          .digest("hex");
        records.push(`f ${relative} ${String(stat.mode & 0o777)} ${digest}`);
      }
    }
  };
  visit(root);
  return NodeCrypto.createHash("sha256").update(records.join("\n")).digest("hex");
};

describe("conformance scenarios", () => {
  it("strictly decodes every scenario and covers at least one adapter", () => {
    const scenarios = scenarioFiles().map(loadScenario);
    assert.isAtLeast(scenarios.length, 16);
    assert.equal(new Set(scenarios.map((scenario) => scenario.name)).size, scenarios.length);
    assert.includeMembers(
      scenarios.map((scenario) => scenario.name),
      [...requiredScenarioNames],
    );
    for (const scenario of scenarios) assert.isAbove(scenario.appliesTo.length, 0, scenario.name);
  });

  it("rejects unknown scenario keys", () => {
    const scenario = JSON.parse(NodeFS.readFileSync(scenarioFiles()[0]!, "utf8"));
    assert.throws(() => decodeConformanceScenario({ ...scenario, unexpected: true }));
  });

  it("maps each terminal event and server iteration field exactly once", () => {
    const repository = NodePath.resolve(packageDirectory, "../..");
    const runner = NodeFS.readFileSync(
      NodePath.join(repository, "skills/cook-epic/run.sh"),
      "utf8",
    );
    const docs = NodeFS.readFileSync(
      NodePath.join(repository, "docs/epic-runs-transcript.md"),
      "utf8",
    );
    const terminalEvents = [...runner.matchAll(/event:"([^"]+)"/gu)].map((match) => match[1]!);
    for (const event of new Set(terminalEvents)) {
      const rows = docs.match(new RegExp("^\\|\\s+`" + event + "`\\s+\\|", "gmu")) ?? [];
      assert.equal(rows.length, 1, `terminal event ${event}`);
    }

    const contracts = NodeFS.readFileSync(
      NodePath.join(repository, "packages/contracts/src/epicRuns.ts"),
      "utf8",
    );
    const reportBody = contracts
      .split("export const EpicRunIterationReport = Schema.Struct({")[1]
      ?.split("});")[0];
    assert.isDefined(reportBody);
    const fields = [...(reportBody ?? "").matchAll(/^  ([A-Za-z][A-Za-z0-9]*):/gmu)].map(
      (match) => match[1]!,
    );
    for (const field of fields) {
      const rows = docs.match(new RegExp("^\\|\\s+`" + field + "`\\s+\\|", "gmu")) ?? [];
      assert.equal(rows.length, 1, `server field ${field}`);
    }
  });
});

describe("conformance workspace", () => {
  it("builds byte-identical trees through the TypeScript and shell entries", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "conformance-parity-"));
    const scenarioPath = NodePath.join(scenariosDirectory, "happy-path.json");
    const scenario = loadScenario(scenarioPath);
    const tsRoot = NodePath.join(root, "typescript");
    const shellRoot = NodePath.join(root, "shell");
    materializeConformanceWorkspace(scenario, tsRoot);
    const result = NodeChildProcess.spawnSync(
      NodePath.join(packageDirectory, "bin", "make-workspace.sh"),
      [scenarioPath, shellRoot],
      { encoding: "utf8", cwd: packageDirectory },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(treeDigest(tsRoot), treeDigest(shellRoot));
    assert.deepEqual(NodeFS.readdirSync(NodePath.join(tsRoot, "repo", ".beads")), []);
  });

  it("rejects sibling paths outside the fixture", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "conformance-path-"));
    const scenario = loadScenario(NodePath.join(scenariosDirectory, "happy-path.json"));
    assert.throws(() =>
      materializeConformanceWorkspace(
        decodeConformanceScenario({
          ...scenario,
          repo: { ...scenario.repo, siblingRepos: ["../outside"] },
        }),
        NodePath.join(root, "fixture"),
      ),
    );
    assert.throws(() =>
      materializeConformanceWorkspace(
        decodeConformanceScenario({
          ...scenario,
          repo: { ...scenario.repo, siblingRepos: ["api", "api/nested"] },
        }),
        NodePath.join(root, "nested-fixture"),
      ),
    );
  });

  it("implements strict bd behavior and journals bd plus git argv", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "conformance-bd-"));
    const workspace = materializeConformanceWorkspace(
      loadScenario(NodePath.join(scenariosDirectory, "happy-path.json")),
      root,
    );
    const home = NodePath.join(root, "home");
    NodeFS.mkdirSync(home);
    const invoke = (args: ReadonlyArray<string>) => run(workspace, "bd", args, { HOME: home });
    assert.equal(invoke(["show", "epic", "--json"]).status, 0);
    assert.equal(invoke(["ready", "--parent", "epic", "--json"]).status, 0);
    assert.equal(invoke(["list", "--parent", "epic", "--all", "--flat", "--json"]).status, 0);
    assert.equal(invoke(["update", "epic.1", "--claim"]).status, 0);
    assert.equal(invoke(["update", "epic.1", "--status", "open", "--assignee", ""]).status, 0);
    assert.equal(invoke(["note", "epic.1", "note"]).status, 0);
    assert.equal(invoke(["comment", "epic.1", "comment"]).status, 0);
    assert.equal(invoke(["dep", "add", "epic.1", "epic"]).status, 0);
    assert.equal(invoke(["close", "epic.1", "--reason", "done"]).status, 0);
    assert.equal(
      invoke([
        "create",
        "New child",
        "--type",
        "task",
        "--parent",
        "epic",
        "-p",
        "1",
        "-d",
        "test",
        "--json",
      ]).status,
      0,
    );
    assert.equal(invoke(["label", "add", "epic.1", "test"]).status, 0);
    assert.equal(invoke(["swarm", "create", "epic"]).status, 0);
    assert.equal(invoke(["merge-slot", "create"]).status, 0);
    assert.equal(invoke(["merge-slot", "acquire", "--holder", "worker", "--json"]).status, 0);
    assert.equal(invoke(["update", "epic.1", "--claim", "--status", "closed"]).status, 2);
    assert.equal(invoke(["label", "unknown", "epic.1"]).status, 2);
    assert.equal(invoke(["unknown"]).status, 2);
    assert.equal(run(workspace, "git", ["status", "--short"]).status, 0);
    const child = JSON.parse(invoke(["show", "epic.1", "--json"]).stdout)[0] as {
      status: string;
      assignee?: string;
      labels: ReadonlyArray<string>;
      dependencies: ReadonlyArray<string>;
    };
    assert.equal(child.status, "closed");
    assert.equal(child.assignee, "");
    assert.deepEqual(child.labels, ["test"]);
    assert.deepEqual(child.dependencies, ["epic"]);
    const created = JSON.parse(invoke(["show", "created-1", "--json"]).stdout)[0] as {
      issue_type: string;
      priority: number;
      description: string;
      parent: string;
    };
    assert.equal(created.issue_type, "task");
    assert.equal(created.priority, 1);
    assert.equal(created.description, "test");
    assert.equal(created.parent, "epic");
    assert.isFalse(NodeFS.existsSync(NodePath.join(home, ".config", "bd")));
    const transcript = workspace.readTranscript() as ReadonlyArray<{
      tool?: string;
      argv?: ReadonlyArray<string>;
    }>;
    assert.includeMembers(
      transcript.map((record) => record.tool),
      ["bd", "git"],
    );
    assert.deepEqual(
      transcript.filter((record) => record.tool === "bd").map((record) => record.argv),
      [
        ["show", "epic", "--json"],
        ["ready", "--parent", "epic", "--json"],
        ["list", "--parent", "epic", "--all", "--flat", "--json"],
        ["update", "epic.1", "--claim"],
        ["update", "epic.1", "--status", "open", "--assignee", ""],
        ["note", "epic.1", "note"],
        ["comment", "epic.1", "comment"],
        ["dep", "add", "epic.1", "epic"],
        ["close", "epic.1", "--reason", "done"],
        [
          "create",
          "New child",
          "--type",
          "task",
          "--parent",
          "epic",
          "-p",
          "1",
          "-d",
          "test",
          "--json",
        ],
        ["label", "add", "epic.1", "test"],
        ["swarm", "create", "epic"],
        ["merge-slot", "create"],
        ["merge-slot", "acquire", "--holder", "worker", "--json"],
        ["update", "epic.1", "--claim", "--status", "closed"],
        ["label", "unknown", "epic.1"],
        ["unknown"],
        ["show", "epic.1", "--json"],
        ["show", "created-1", "--json"],
      ],
    );
    assert.deepEqual(
      transcript.filter((record) => record.tool === "git").map((record) => record.argv),
      [["status", "--short"]],
    );
  });

  it("serializes concurrent state and journal writes", async () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "conformance-lock-"));
    const base = loadScenario(NodePath.join(scenariosDirectory, "happy-path.json"));
    const workspace = materializeConformanceWorkspace(
      decodeConformanceScenario({
        ...base,
        agentScript: [
          {
            repoAction: "no-commit",
            report: { _tag: "none" },
            closeChild: false,
            hangMs: 0,
          },
        ],
      }),
      root,
    );
    const spawn = (command: string, args: ReadonlyArray<string>): Promise<void> =>
      new Promise((resolve, reject) => {
        const child = NodeChildProcess.spawn(NodePath.join(workspace.binDir, command), args, {
          cwd: workspace.cwd,
          env: { ...process.env, ...workspace.env },
          stdio: ["ignore", "ignore", "pipe"],
        });
        let stderr = "";
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk: string) => {
          stderr += chunk;
        });
        child.on("error", reject);
        child.on("close", (code) =>
          code === 0
            ? resolve()
            : reject(new Error(`${command} exited ${String(code)}: ${stderr.trim()}`)),
        );
      });
    await Promise.all([
      ...Array.from({ length: 12 }, (_, index) =>
        spawn("bd", ["comment", "epic.1", `comment ${String(index)}`]),
      ),
      ...Array.from({ length: 8 }, () => spawn("git", ["rev-parse", "HEAD"])),
      ...Array.from({ length: 12 }, () => spawn("agent", ["prompt"])),
    ]);
    const shown = run(workspace, "bd", ["show", "epic.1", "--json"]);
    const child = JSON.parse(shown.stdout)[0] as { comment_count: number };
    assert.equal(child.comment_count, 12);
    const transcript = workspace.readTranscript() as ReadonlyArray<{
      tool?: string;
      invocation?: number;
    }>;
    assert.equal(transcript.length, 33);
    assert.deepEqual(
      transcript
        .filter((record) => record.tool === "agent")
        .map((record) => record.invocation)
        .sort((left, right) => (left ?? 0) - (right ?? 0)),
      Array.from({ length: 12 }, (_, index) => index),
    );
  });

  it("honors every agent action and emits provider-specific final messages", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "conformance-agent-"));
    const base = loadScenario(NodePath.join(scenariosDirectory, "happy-path.json"));
    const scenario = decodeConformanceScenario({
      ...base,
      agentScript: [
        { repoAction: "commit", report: { _tag: "none" }, closeChild: false, hangMs: 0 },
        {
          repoAction: "no-commit",
          report: { _tag: "ralph-blocked" },
          closeChild: false,
          hangMs: 0,
        },
        { repoAction: "dirty-only", report: { _tag: "none" }, closeChild: false, hangMs: 0 },
        {
          repoAction: "no-commit",
          report: { _tag: "ralph-done" },
          closeChild: true,
          beadComment: "findings",
          hangMs: 0,
        },
        {
          repoAction: "no-commit",
          report: { _tag: "ralph-msg", summary: "built", why: "needed" },
          closeChild: false,
          hangMs: 0,
        },
        {
          repoAction: "no-commit",
          report: { _tag: "permission-denial", message: "permission denied" },
          closeChild: false,
          hangMs: 0,
        },
        {
          repoAction: "no-commit",
          report: { _tag: "provider-error", message: "rate limit" },
          closeChild: false,
          hangMs: 0,
        },
        { repoAction: "no-commit", report: { _tag: "ralph-done" }, closeChild: false, hangMs: 20 },
        { repoAction: "no-commit", report: { _tag: "ralph-done" }, closeChild: false, hangMs: 0 },
        {
          repoAction: "no-commit",
          report: { _tag: "ralph-msg", summary: "built", why: "needed" },
          closeChild: false,
          hangMs: 0,
        },
      ],
    });
    const workspace = materializeConformanceWorkspace(scenario, root);
    assert.equal(run(workspace, "agent", ["prompt"]).status, 0);
    const blocked = run(workspace, "agent", ["prompt"]);
    assert.equal(blocked.status, 0);
    assert.include(blocked.stdout, "RALPH_BLOCKED");
    assert.equal(run(workspace, "agent", ["prompt"]).status, 0);
    const claude = run(workspace, "claude", ["-p", "prompt"]);
    assert.include(claude.stdout, '"type":"result"');
    assert.deepEqual(parseTerminalArtifact("claude", claude.stdout), {
      finalText: "RALPH_DONE",
      sessionId: "fixture-session",
      providerError: null,
    });
    const kimi = run(workspace, "kimi", ["-p", "prompt"]);
    assert.include(kimi.stdout, '"role":"assistant"');
    assert.deepEqual(parseTerminalArtifact("kimi", kimi.stdout), {
      finalText: 'RALPH_MSG: {"summary":"built","why":"needed"}',
      sessionId: "fixture-session",
      providerError: null,
    });
    const denied = run(workspace, "claude", ["-p", "prompt"]);
    assert.equal(denied.status, 1);
    assert.include(denied.stdout, '"permission_denials"');
    assert.include(
      parseTerminalArtifact("claude", denied.stdout).providerError ?? "",
      "permission denied",
    );
    const codex = run(workspace, "codex", ["exec", "--json", "prompt"]);
    assert.equal(codex.status, 1);
    assert.include(codex.stdout, "rate limit");
    assert.include(parseTerminalArtifact("codex", codex.stdout).providerError ?? "", "rate limit");
    const opencode = run(workspace, "opencode", ["run", "prompt"]);
    assert.include(opencode.stdout, '"type":"step_finish"');
    assert.equal(parseTerminalArtifact("opencode", opencode.stdout).finalText, "RALPH_DONE");
    const codexFinal = run(workspace, "codex", ["exec", "--json", "prompt"]);
    assert.include(codexFinal.stdout, '"type":"item.completed"');
    assert.deepEqual(parseTerminalArtifact("codex", codexFinal.stdout), {
      finalText: "RALPH_DONE",
      sessionId: "fixture-session",
      providerError: null,
    });
    const ccx = run(workspace, "ccx", ["-p", "prompt"]);
    assert.include(ccx.stdout, '"type":"result"');
    assert.equal(
      parseTerminalArtifact("ccx", ccx.stdout).finalText,
      'RALPH_MSG: {"summary":"built","why":"needed"}',
    );
    assert.isTrue(NodeFS.existsSync(NodePath.join(workspace.cwd, "agent-0.txt")));
    assert.isTrue(NodeFS.existsSync(NodePath.join(workspace.cwd, "agent-2.txt")));
    assert.isTrue(NodeFS.existsSync(NodePath.join(workspace.binDir, "ccx")));
    const shown = run(workspace, "bd", ["show", "epic.1", "--json"]);
    const child = JSON.parse(shown.stdout)[0] as { status: string; comment_count: number };
    assert.equal(child.status, "closed");
    assert.equal(child.comment_count, 1);
    const log = run(workspace, "git", ["log", "-1", "--format=%s"]);
    assert.equal(log.stdout.trim(), "fixture agent commit 0");
    const transcript = workspace.readTranscript() as ReadonlyArray<{
      tool?: string;
      argv?: ReadonlyArray<string>;
    }>;
    assert.isTrue(
      transcript.some(
        (record) =>
          record.tool === "git" &&
          JSON.stringify(record.argv) ===
            JSON.stringify(["commit", "-qm", "fixture agent commit 0"]),
      ),
    );
  });

  it("commits scripted changes in the main and sibling repositories", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "conformance-sibling-"));
    const workspace = materializeConformanceWorkspace(
      loadScenario(NodePath.join(scenariosDirectory, "sibling-repo-layout.json")),
      root,
    );
    const layout = NodePath.join(root, "worker");
    const mainWorktree = NodePath.join(layout, "repo");
    const siblingWorktree = NodePath.join(layout, "api");
    assert.equal(
      run(workspace, "git", ["worktree", "add", "-b", "epic/main", mainWorktree]).status,
      0,
    );
    assert.equal(
      run(workspace, "git", [
        "-C",
        NodePath.join(root, "api"),
        "worktree",
        "add",
        "-b",
        "epic/api",
        siblingWorktree,
      ]).status,
      0,
    );
    const agent = NodeChildProcess.spawnSync(NodePath.join(workspace.binDir, "agent"), ["prompt"], {
      cwd: mainWorktree,
      encoding: "utf8",
      env: { ...process.env, ...workspace.env },
    });
    assert.equal(agent.status, 0, agent.stderr);
    assert.equal(
      run(workspace, "git", ["-C", mainWorktree, "log", "-1", "--format=%s"]).stdout.trim(),
      "fixture agent commit 0",
    );
    assert.equal(
      run(workspace, "git", ["-C", siblingWorktree, "log", "-1", "--format=%s"]).stdout.trim(),
      "fixture sibling commit 0",
    );
  });

  it("advances the base branch to create a real trial-merge conflict", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "conformance-conflict-"));
    const workspace = materializeConformanceWorkspace(
      loadScenario(NodePath.join(scenariosDirectory, "park-merge-conflict.json")),
      root,
    );
    const worker = NodePath.join(root, "worker");
    assert.equal(run(workspace, "git", ["worktree", "add", "-b", "epic/epic.1", worker]).status, 0);
    const agent = NodeChildProcess.spawnSync(NodePath.join(workspace.binDir, "agent"), ["prompt"], {
      cwd: worker,
      encoding: "utf8",
      env: { ...process.env, ...workspace.env },
    });
    assert.equal(agent.status, 0, agent.stderr);
    const merge = run(workspace, "git", ["merge", "--no-commit", "epic/epic.1"]);
    assert.notEqual(merge.status, 0);
    assert.include(
      NodeFS.readFileSync(NodePath.join(workspace.cwd, "conflict.txt"), "utf8"),
      "<<<<<<<",
    );
    assert.equal(run(workspace, "git", ["merge", "--abort"]).status, 0);
  });
});
