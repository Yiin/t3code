// @effect-diagnostics nodeBuiltinImport:off globalDate:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { ConformanceScenario } from "./scenario.ts";
import { agentShim, bdShim, gitShim } from "./shims.ts";

export interface ConformanceWorkspace {
  readonly cwd: string;
  readonly binDir: string;
  readonly env: Readonly<Record<string, string>>;
  readonly readTranscript: () => ReadonlyArray<unknown>;
}

const runGit = (git: string, cwd: string, args: ReadonlyArray<string>): void => {
  NodeChildProcess.execFileSync(git, args, {
    cwd,
    stdio: "ignore",
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
      GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
    },
  });
};

const executable = (path: string, content: string): void => {
  NodeFS.writeFileSync(path, content, { mode: 0o755 });
};

const realGitPath = (): string => {
  const result = NodeChildProcess.spawnSync("which", ["git"], { encoding: "utf8" });
  const path = result.stdout.trim();
  if (result.status !== 0 || path === "") throw new Error("git is required to build a fixture");
  return path;
};

export const materializeConformanceWorkspace = (
  scenario: ConformanceScenario,
  root: string,
): ConformanceWorkspace => {
  root = NodePath.resolve(root);
  const cwd = NodePath.join(root, "repo");
  const binDir = NodePath.join(root, "bin");
  const stateDir = NodePath.join(root, "state");
  const statePath = NodePath.join(stateDir, "state.json");
  const journalPath = NodePath.join(root, "journal.jsonl");
  NodeFS.mkdirSync(cwd, { recursive: true });
  NodeFS.mkdirSync(binDir, { recursive: true });
  NodeFS.mkdirSync(stateDir, { recursive: true });
  NodeFS.mkdirSync(NodePath.join(cwd, ".beads"));

  for (const file of scenario.repo.files) {
    const target = NodePath.resolve(cwd, file.path);
    if (!target.startsWith(`${cwd}${NodePath.sep}`))
      throw new Error(`fixture path escapes repo: ${file.path}`);
    NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
    NodeFS.writeFileSync(target, file.content);
  }
  if (scenario.repo.mergeConflict !== undefined) {
    const conflictPath = NodePath.resolve(cwd, scenario.repo.mergeConflict.path);
    if (!conflictPath.startsWith(`${cwd}${NodePath.sep}`)) {
      throw new Error(`merge conflict path escapes repo: ${scenario.repo.mergeConflict.path}`);
    }
    NodeFS.mkdirSync(NodePath.dirname(conflictPath), { recursive: true });
    NodeFS.writeFileSync(conflictPath, scenario.repo.mergeConflict.baseContent);
  }
  if (scenario.repo.files.length === 0)
    NodeFS.writeFileSync(NodePath.join(cwd, "README.md"), "fixture\n");

  const git = realGitPath();
  runGit(git, cwd, ["init", "-q", "-b", "main"]);
  runGit(git, cwd, ["config", "user.name", "Conformance Fixture"]);
  runGit(git, cwd, ["config", "user.email", "fixture@example.com"]);
  runGit(git, cwd, ["add", "."]);
  runGit(git, cwd, ["commit", "-qm", "baseline"]);
  runGit(git, cwd, ["read-tree", "HEAD"]);
  if (scenario.repo.detachedHead) runGit(git, cwd, ["checkout", "-q", "--detach"]);
  if (scenario.repo.dirty) NodeFS.writeFileSync(NodePath.join(cwd, "dirty.txt"), "dirty\n");
  const siblingPaths = new Set<string>();
  for (const sibling of scenario.repo.siblingRepos) {
    const siblingPath = NodePath.resolve(root, sibling);
    const overlapsFixture = [cwd, binDir, stateDir].some(
      (reserved) =>
        siblingPath === reserved ||
        siblingPath.startsWith(`${reserved}${NodePath.sep}`) ||
        reserved.startsWith(`${siblingPath}${NodePath.sep}`),
    );
    const overlapsSibling = [...siblingPaths].some(
      (existing) =>
        siblingPath.startsWith(`${existing}${NodePath.sep}`) ||
        existing.startsWith(`${siblingPath}${NodePath.sep}`),
    );
    if (
      !siblingPath.startsWith(`${root}${NodePath.sep}`) ||
      overlapsFixture ||
      overlapsSibling ||
      siblingPaths.has(siblingPath)
    ) {
      throw new Error(`sibling path escapes or overlaps the fixture: ${sibling}`);
    }
    siblingPaths.add(siblingPath);
    NodeFS.mkdirSync(siblingPath, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(siblingPath, "README.md"), `${sibling}\n`);
    runGit(git, siblingPath, ["init", "-q", "-b", "main"]);
    runGit(git, siblingPath, ["config", "user.name", "Conformance Fixture"]);
    runGit(git, siblingPath, ["config", "user.email", "fixture@example.com"]);
    runGit(git, siblingPath, ["add", "."]);
    runGit(git, siblingPath, ["commit", "-qm", "baseline"]);
    runGit(git, siblingPath, ["read-tree", "HEAD"]);
  }

  const children = scenario.beads.children.map((child) => ({
    id: child.id,
    title: child.title,
    status: child.status,
    priority: child.priority,
    issue_type: child.issueType,
    parent: child.parentId ?? scenario.beads.epicId,
    comment_count: child.commentCount,
    comments: Array.from(
      { length: child.commentCount },
      (_, index) => `comment ${String(index + 1)}`,
    ),
    labels: [],
    dependencies: [],
    description: "",
    notes: "",
  }));
  NodeFS.writeFileSync(
    statePath,
    `${JSON.stringify(
      {
        epic: {
          id: scenario.beads.epicId,
          title: "Fixture epic",
          status: scenario.beads.runInProgress ? "in_progress" : "open",
          issue_type: "epic",
          exists: scenario.beads.epicExists,
          comment_count: 0,
          comments: [],
          labels: [],
          dependencies: [],
          description: "Fixture epic",
          notes: "",
        },
        children,
        readyIncludesForeign: scenario.beads.readyIncludesForeign ?? false,
        agentScript: scenario.agentScript,
        siblingRepos: scenario.repo.siblingRepos,
        mergeConflict: scenario.repo.mergeConflict,
        agentInvocation: 0,
        nextId: 1,
      },
      null,
      2,
    )}\n`,
  );
  if (scenario.beads.lockHeld === true) {
    NodeFS.writeFileSync(
      NodePath.join(cwd, ".beads", `run-lock.${scenario.beads.epicId}.json`),
      `${JSON.stringify({
        owner: "fixture-owner",
        host: "fixture-remote-host",
        pid: 1,
        pgid: 1,
        runDir: "/fixture/run",
        startedAt: "2000-01-01T00:00:00Z",
        heartbeatAt: 0,
      })}\n`,
    );
  }
  NodeFS.writeFileSync(journalPath, "");
  executable(NodePath.join(binDir, "bd"), bdShim);
  executable(NodePath.join(binDir, "git"), gitShim);
  executable(NodePath.join(binDir, "agent"), agentShim);
  for (const harness of ["claude", "ccx", "kimi", "codex", "opencode"]) {
    executable(
      NodePath.join(binDir, harness),
      `#!/usr/bin/env bash\nset -euo pipefail\nCONFORMANCE_HARNESS=${harness} exec "$(dirname "$0")/agent" "$@"\n`,
    );
  }

  const env = {
    PATH: `${binDir}:${process.env.PATH ?? ""}`,
    // The gate serializes heavy work on a lock under XDG_RUNTIME_DIR
    // (`ProcessGate.heavyGateLockPath`). Inheriting the real one makes this
    // fixture take the machine's production gate lock, and a real gate holds
    // that lock while it runs the test suite — so a conformance scenario that
    // reaches its own gate waits for the gate that is running it. That is a
    // deadlock, not a slow test, and it ends at the gate's two-hour timeout.
    XDG_RUNTIME_DIR: root,
    CONFORMANCE_ROOT: root,
    CONFORMANCE_STATE: statePath,
    CONFORMANCE_JOURNAL: journalPath,
    CONFORMANCE_LOCK: NodePath.join(stateDir, "operation.lock"),
    CONFORMANCE_REAL_GIT: git,
    CONFORMANCE_BASE_CWD: cwd,
    CONFORMANCE_CHILD_ID: children[0]?.id ?? "",
  };
  return {
    cwd,
    binDir,
    env,
    readTranscript: () =>
      NodeFS.readFileSync(journalPath, "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line) as unknown),
  };
};

export const makeConformanceWorkspace = (scenario: ConformanceScenario): ConformanceWorkspace =>
  materializeConformanceWorkspace(
    scenario,
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "epic-run-conformance-")),
  );
