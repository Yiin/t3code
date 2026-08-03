import type { ThreadId } from "@t3tools/contracts";

/** The only thread fields worktree cleanup needs. */
export interface WorktreeLinkedThread {
  readonly id: ThreadId;
  readonly worktreePath: string | null;
}

/** What a client needs to remove a deleted thread's worktree. */
export interface ThreadWorktreeCleanupPlan {
  /** Absolute worktree path, passed to vcs.removeWorktree as `path`. */
  readonly worktreePath: string;
  /** Repository root, passed to vcs.removeWorktree / vcs.refreshStatus as `cwd`. */
  readonly workspaceRoot: string;
  /** Short form of `worktreePath`, for prompts and error messages. */
  readonly displayPath: string;
}

function normalizeWorktreePath(path: string | null): string | null {
  const trimmed = path?.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed;
}

export function getOrphanedWorktreePathForThread(
  threads: ReadonlyArray<WorktreeLinkedThread>,
  threadId: ThreadId,
): string | null {
  const targetThread = threads.find((thread) => thread.id === threadId);
  if (!targetThread) {
    return null;
  }

  const targetWorktreePath = normalizeWorktreePath(targetThread.worktreePath);
  if (!targetWorktreePath) {
    return null;
  }

  const isShared = threads.some((thread) => {
    if (thread.id === threadId) {
      return false;
    }
    return normalizeWorktreePath(thread.worktreePath) === targetWorktreePath;
  });

  return isShared ? null : targetWorktreePath;
}

export function formatWorktreePathForDisplay(worktreePath: string): string {
  const trimmed = worktreePath.trim();
  if (!trimmed) {
    return worktreePath;
  }

  const normalized = trimmed.replace(/\\/g, "/").replace(/\/+$/, "");
  const parts = normalized.split("/");
  const lastPart = parts[parts.length - 1]?.trim() ?? "";
  return lastPart.length > 0 ? lastPart : trimmed;
}

/**
 * Decides whether deleting `threadId` leaves a worktree behind that nothing
 * else points at. Returns null when there is nothing to clean up: the thread
 * has no worktree, another thread shares it, or the project (and so the
 * repository root the removal has to run from) is unknown.
 *
 * `threads` must be every known thread in the same environment — a thread
 * missing from the list looks like a thread that does not share the worktree.
 */
export function planThreadWorktreeCleanup(input: {
  readonly threads: ReadonlyArray<WorktreeLinkedThread>;
  readonly threadId: ThreadId;
  readonly workspaceRoot: string | null;
}): ThreadWorktreeCleanupPlan | null {
  const worktreePath = getOrphanedWorktreePathForThread(input.threads, input.threadId);
  if (worktreePath === null || input.workspaceRoot === null) {
    return null;
  }
  return {
    worktreePath,
    workspaceRoot: input.workspaceRoot,
    displayPath: formatWorktreePathForDisplay(worktreePath),
  };
}
