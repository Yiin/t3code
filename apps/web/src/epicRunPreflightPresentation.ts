import type {
  EpicRunPreflightBlocker,
  EpicRunPreflightResult,
  EpicRunPreflightWarning,
} from "@t3tools/contracts";

export function epicRunPreflightBlockerText(blocker: EpicRunPreflightBlocker): string {
  switch (blocker._tag) {
    case "dirty_tree":
      return `The worktree has changes: ${blocker.paths.join(", ")}`;
    case "detached_head":
      return "The repository has a detached HEAD.";
    case "run_in_progress":
      return `Another epic run owns this repository on ${blocker.host} (PID ${String(blocker.pid)}, ${blocker.runDir}).`;
    case "epic_not_found":
      return `Epic ${blocker.epicId} was not found.`;
    case "config_invalid":
      return `${blocker.configPath}\n${blocker.diagnostics.join("\n")}`;
    case "integration_leftover":
      return `A previous parallel run left ${
        blocker.branch !== null ? `integration branch ${blocker.branch}` : "an integration branch"
      }${
        blocker.worktreePath !== null ? ` (worktree ${blocker.worktreePath})` : ""
      } behind; reconcile it before launching.`;
    case "sibling_invalid":
      return blocker.detail;
    case "run_base_branch_checked_out":
      return `${blocker.branch} is checked out here, and the run lands by updating that ref. Switch to another branch before launching.`;
    case "workspace_missing":
      return `The workspace ${blocker.workspaceRoot} does not exist.`;
    case "stranded_child_branches":
      return strandedChildBranchesText(blocker);
  }
}

/** Rendered identically whether it blocks a launch or warns a resume. */
function strandedChildBranchesText(input: {
  readonly baseBranch: string;
  readonly branches: readonly { readonly childId: string; readonly branch: string }[];
}): string {
  const listed = input.branches.map(({ childId, branch }) => `${childId} (${branch})`).join(", ");
  return (
    `${String(input.branches.length)} closed ${input.branches.length === 1 ? "child" : "children"} of this epic ` +
    `never landed on ${input.baseBranch}: ${listed}. A run that starts here reads them as done and ` +
    `will not merge them. Land each branch, or delete one you know is finished with ` +
    `\`git branch -D <branch>\`.`
  );
}

export function epicRunPreflightWarningText(warning: EpicRunPreflightWarning): string {
  switch (warning._tag) {
    case "stale_claims":
      return `These children have stale claims: ${warning.childIds.join(", ")}`;
    case "nothing_ready":
      return `Epic ${warning.epicId} has no ready children.`;
    case "config_unknown_keys":
      return `${warning.configPath} has unknown keys: ${warning.keys.join(", ")}`;
    case "config_violation":
      return `${warning.key}: ${warning.message}`;
    case "untracked_files":
      return `The worktree has untracked files: ${warning.paths.join(", ")}`;
    case "run_base_branch_stale":
      return `${warning.branch} is ${String(warning.commitsBehind)} commit(s) behind the checked-out branch; a run reusing it starts fresh workers from old code.`;
    case "tracked_changes_ignored":
      return `The run excludes your uncommitted changes to: ${warning.paths.join(", ")}`;
    case "dirty_tree_accepted":
      return `The resumed run keeps its own uncommitted changes to: ${warning.paths.join(", ")}`;
    case "resume_worktree_missing":
      return `These worktrees are gone, so the resumed run starts those children fresh: ${warning.paths.join(", ")}`;
    case "stranded_child_branches_accepted":
      return strandedChildBranchesText(warning);
  }
}

export function presentEpicRunPreflight(result: EpicRunPreflightResult): {
  readonly blockers: readonly string[];
  readonly warnings: readonly string[];
} {
  return {
    blockers: result.blockers.map(epicRunPreflightBlockerText),
    warnings: result.warnings.map(epicRunPreflightWarningText),
  };
}
