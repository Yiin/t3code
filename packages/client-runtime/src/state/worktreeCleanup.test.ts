import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  formatWorktreePathForDisplay,
  getOrphanedWorktreePathForThread,
  planThreadWorktreeCleanup,
  type WorktreeLinkedThread,
} from "./worktreeCleanup.ts";

function makeThread(id: string, worktreePath: string | null = null): WorktreeLinkedThread {
  return { id: ThreadId.make(id), worktreePath };
}

describe("getOrphanedWorktreePathForThread", () => {
  it("returns null when the target thread does not exist", () => {
    const result = getOrphanedWorktreePathForThread([], ThreadId.make("missing-thread"));
    expect(result).toBeNull();
  });

  it("returns null when the target thread has no worktree", () => {
    const result = getOrphanedWorktreePathForThread(
      [makeThread("thread-1")],
      ThreadId.make("thread-1"),
    );
    expect(result).toBeNull();
  });

  it("returns the path when no other thread links to that worktree", () => {
    const threads = [makeThread("thread-1", "/tmp/repo/worktrees/feature-a")];
    const result = getOrphanedWorktreePathForThread(threads, ThreadId.make("thread-1"));
    expect(result).toBe("/tmp/repo/worktrees/feature-a");
  });

  it("returns null when another thread links to the same worktree", () => {
    const threads = [
      makeThread("thread-1", "/tmp/repo/worktrees/feature-a"),
      makeThread("thread-2", "/tmp/repo/worktrees/feature-a"),
    ];
    const result = getOrphanedWorktreePathForThread(threads, ThreadId.make("thread-1"));
    expect(result).toBeNull();
  });

  it("ignores threads linked to different worktrees", () => {
    const threads = [
      makeThread("thread-1", "/tmp/repo/worktrees/feature-a"),
      makeThread("thread-2", "/tmp/repo/worktrees/feature-b"),
    ];
    const result = getOrphanedWorktreePathForThread(threads, ThreadId.make("thread-1"));
    expect(result).toBe("/tmp/repo/worktrees/feature-a");
  });
});

describe("formatWorktreePathForDisplay", () => {
  it("shows only the last path segment for unix-like paths", () => {
    const result = formatWorktreePathForDisplay(
      "/Users/julius/.t3/worktrees/t3code-mvp/t3code-4e609bb8",
    );
    expect(result).toBe("t3code-4e609bb8");
  });

  it("normalizes windows separators before selecting the final segment", () => {
    const result = formatWorktreePathForDisplay(
      "C:\\Users\\julius\\.t3\\worktrees\\t3code-mvp\\t3code-4e609bb8",
    );
    expect(result).toBe("t3code-4e609bb8");
  });

  it("uses the final segment even when outside ~/.t3/worktrees", () => {
    const result = formatWorktreePathForDisplay("/tmp/custom-worktrees/my-worktree");
    expect(result).toBe("my-worktree");
  });

  it("ignores trailing slashes", () => {
    const result = formatWorktreePathForDisplay("/tmp/custom-worktrees/my-worktree/");
    expect(result).toBe("my-worktree");
  });
});

describe("planThreadWorktreeCleanup", () => {
  it("plans a removal for an orphaned worktree", () => {
    const plan = planThreadWorktreeCleanup({
      threads: [makeThread("thread-1", "/tmp/repo/worktrees/feature-a")],
      threadId: ThreadId.make("thread-1"),
      workspaceRoot: "/tmp/repo",
    });
    expect(plan).toEqual({
      worktreePath: "/tmp/repo/worktrees/feature-a",
      workspaceRoot: "/tmp/repo",
      displayPath: "feature-a",
    });
  });

  it("returns null when the worktree is shared with another thread", () => {
    const plan = planThreadWorktreeCleanup({
      threads: [
        makeThread("thread-1", "/tmp/repo/worktrees/feature-a"),
        makeThread("thread-2", "/tmp/repo/worktrees/feature-a"),
      ],
      threadId: ThreadId.make("thread-1"),
      workspaceRoot: "/tmp/repo",
    });
    expect(plan).toBeNull();
  });

  it("returns null when the project is unknown, because removal has no cwd", () => {
    const plan = planThreadWorktreeCleanup({
      threads: [makeThread("thread-1", "/tmp/repo/worktrees/feature-a")],
      threadId: ThreadId.make("thread-1"),
      workspaceRoot: null,
    });
    expect(plan).toBeNull();
  });

  it("returns null when the thread has no worktree", () => {
    const plan = planThreadWorktreeCleanup({
      threads: [makeThread("thread-1")],
      threadId: ThreadId.make("thread-1"),
      workspaceRoot: "/tmp/repo",
    });
    expect(plan).toBeNull();
  });
});
