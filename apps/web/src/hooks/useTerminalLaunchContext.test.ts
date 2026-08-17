import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  reconcileTerminalLaunchContext,
  type TerminalLaunchContext,
} from "./useTerminalLaunchContext";

const threadId = ThreadId.make("thread-1");
const otherThreadId = ThreadId.make("thread-2");
const current: TerminalLaunchContext = {
  threadId,
  cwd: "/workspace/project",
  worktreePath: null,
};

function inputs(overrides: Partial<Parameters<typeof reconcileTerminalLaunchContext>[1]> = {}) {
  return {
    activeThreadId: threadId,
    activeProjectCwd: "/workspace/project",
    activeThreadWorktreePath: null,
    terminalOpen: true,
    ...overrides,
  };
}

describe("reconcileTerminalLaunchContext", () => {
  it("clears the context when there is no active thread", () => {
    expect(reconcileTerminalLaunchContext(current, inputs({ activeThreadId: null }))).toBeNull();
  });

  it("clears a context from another thread", () => {
    expect(
      reconcileTerminalLaunchContext(current, inputs({ activeThreadId: otherThreadId })),
    ).toBeNull();
  });

  it("clears the context when the project cwd settles", () => {
    expect(reconcileTerminalLaunchContext(current, inputs({ terminalOpen: true }))).toBeNull();
  });

  it("clears the context when the terminal drawer closes", () => {
    const pending = { ...current, cwd: "/workspace/other" };
    expect(reconcileTerminalLaunchContext(pending, inputs({ terminalOpen: false }))).toBeNull();
  });

  it("keeps a pending context while its cwd is unsettled and open", () => {
    const pending = { ...current, cwd: "/workspace/other" };
    expect(reconcileTerminalLaunchContext(pending, inputs())).toEqual(pending);
  });
});
