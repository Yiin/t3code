// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export function isGitRepository(cwd: string): boolean {
  return NodeFS.existsSync(NodePath.join(cwd, ".git"));
}

/**
 * Resolve `cwd` through symlinks so two paths that name the same worktree
 * compare equal. Falls back to the input when the path cannot be resolved,
 * which keeps this a read that never fails.
 */
export function resolveWorktreePath(cwd: string): string {
  try {
    return NodeFS.realpathSync(cwd);
  } catch {
    return cwd;
  }
}
