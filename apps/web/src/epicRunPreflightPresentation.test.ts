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

  it("names every stranded branch and how to clear one", () => {
    // The operator's next move is per-branch, and there is no override flag,
    // so the text has to carry both the list and the escape hatch.
    expect(
      epicRunPreflightBlockerText({
        _tag: "stranded_child_branches",
        baseBranch: "epic/t3code-2cc/base",
        branches: [
          { childId: "t3code-2cc.2", branch: "epic/t3code-2cc.2" },
          { childId: "t3code-2cc.3", branch: "epic/t3code-2cc.3" },
        ],
      }),
    ).toBe(
      "2 closed children of this epic never landed on epic/t3code-2cc/base: " +
        "t3code-2cc.2 (epic/t3code-2cc.2), t3code-2cc.3 (epic/t3code-2cc.3). " +
        "A run that starts here reads them as done and will not merge them. " +
        "Land each branch, or delete one you know is finished with `git branch -D <branch>`.",
    );
  });

  it("says child, not children, for a single stranded branch", () => {
    expect(
      epicRunPreflightBlockerText({
        _tag: "stranded_child_branches",
        baseBranch: "mine",
        branches: [{ childId: "t3code-2cc.5", branch: "epic/t3code-2cc.5" }],
      }),
    ).toContain("1 closed child of this epic never landed on mine");
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
      epicRunPreflightWarningText({
        _tag: "stranded_child_branches_accepted",
        baseBranch: "mine",
        branches: [{ childId: "t3code-2cc.5", branch: "epic/t3code-2cc.5" }],
      }),
    ]).toEqual([
      "These children have stale claims: epic-1.1",
      "Epic epic-1 has no ready children.",
      "/repo/config.json has unknown keys: future.key",
      "parallel.workers: Pinned to 1.",
      "epic/t3code-5m4/base is 3 commit(s) behind the checked-out branch; a run reusing it starts fresh workers from old code.",
      "The resumed run keeps its own uncommitted changes to: a.ts",
      "These worktrees are gone, so the resumed run starts those children fresh: /wt/child-1",
      "1 closed child of this epic never landed on mine: t3code-2cc.5 (epic/t3code-2cc.5). " +
        "A run that starts here reads them as done and will not merge them. " +
        "Land each branch, or delete one you know is finished with `git branch -D <branch>`.",
    ]);
  });
});
