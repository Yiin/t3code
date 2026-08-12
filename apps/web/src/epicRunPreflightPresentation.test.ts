import { describe, expect, it } from "vite-plus/test";

import {
  epicRunPreflightBlockerText,
  epicRunPreflightWarningText,
} from "./epicRunPreflightPresentation";

describe("epic run preflight presentation", () => {
  it("presents every blocker", () => {
    expect([
      epicRunPreflightBlockerText({ _tag: "dirty_tree", paths: ["a.ts"] }),
      epicRunPreflightBlockerText({ _tag: "detached_head" }),
      epicRunPreflightBlockerText({
        _tag: "run_in_progress",
        owner: "server",
        runDir: "/tmp/run",
        host: "host",
        pid: 42,
      }),
      epicRunPreflightBlockerText({ _tag: "epic_not_found", epicId: "epic-1" }),
      epicRunPreflightBlockerText({ _tag: "workspace_missing", workspaceRoot: "/gone" }),
    ]).toEqual([
      "The worktree has changes: a.ts",
      "The repository has a detached HEAD.",
      "Another epic run owns this repository on host (PID 42, /tmp/run).",
      "Epic epic-1 was not found.",
      "The workspace /gone does not exist.",
    ]);
  });

  it("shows config paths and redacted diagnostics verbatim", () => {
    expect(
      epicRunPreflightBlockerText({
        _tag: "config_invalid",
        configPath: "/repo/.t3code/epic-run.json",
        diagnostics: ['Invalid type\n  at ["parallel"]["workers"]'],
      }),
    ).toBe('/repo/.t3code/epic-run.json\nInvalid type\n  at ["parallel"]["workers"]');
  });

  it("presents every warning", () => {
    expect([
      epicRunPreflightWarningText({ _tag: "stale_claims", childIds: ["epic-1.1"] }),
      epicRunPreflightWarningText({ _tag: "nothing_ready", epicId: "epic-1" }),
      epicRunPreflightWarningText({
        _tag: "config_unknown_keys",
        configPath: "/repo/config.json",
        keys: ["future.key"],
      }),
      epicRunPreflightWarningText({
        _tag: "config_violation",
        key: "parallel.workers",
        message: "Pinned to 1.",
      }),
      epicRunPreflightWarningText({
        _tag: "run_base_branch_stale",
        epicId: "t3code-5m4",
        branch: "epic/t3code-5m4/base",
        commitsBehind: 3,
      }),
      epicRunPreflightWarningText({ _tag: "dirty_tree_accepted", paths: ["a.ts"] }),
      epicRunPreflightWarningText({ _tag: "resume_worktree_missing", paths: ["/wt/child-1"] }),
    ]).toEqual([
      "These children have stale claims: epic-1.1",
      "Epic epic-1 has no ready children.",
      "/repo/config.json has unknown keys: future.key",
      "parallel.workers: Pinned to 1.",
      "epic/t3code-5m4/base is 3 commit(s) behind the checked-out branch; a run reusing it starts fresh workers from old code.",
      "The resumed run keeps its own uncommitted changes to: a.ts",
      "These worktrees are gone, so the resumed run starts those children fresh: /wt/child-1",
    ]);
  });
});
