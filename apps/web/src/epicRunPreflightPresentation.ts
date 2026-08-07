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
  }
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
