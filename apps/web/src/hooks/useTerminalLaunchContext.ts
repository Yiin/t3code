import { type ThreadId } from "@t3tools/contracts";
import { projectScriptCwd } from "@t3tools/shared/projectScripts";
import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";

export interface TerminalLaunchContext {
  threadId: ThreadId;
  cwd: string;
  worktreePath: string | null;
}

export type PersistentTerminalLaunchContext = Pick<TerminalLaunchContext, "cwd" | "worktreePath">;

export interface TerminalLaunchContextInputs {
  activeThreadId: ThreadId | null;
  activeProjectCwd: string | null;
  activeThreadWorktreePath: string | null;
  terminalOpen: boolean;
}

export function reconcileTerminalLaunchContext(
  current: TerminalLaunchContext | null,
  inputs: TerminalLaunchContextInputs,
): TerminalLaunchContext | null {
  if (!inputs.activeThreadId) return null;
  if (!current) return current;
  if (current.threadId !== inputs.activeThreadId) return null;
  if (!inputs.activeProjectCwd) return current;

  const settledCwd = projectScriptCwd({
    project: { cwd: inputs.activeProjectCwd },
    worktreePath: inputs.activeThreadWorktreePath,
  });
  if (settledCwd === current.cwd && inputs.activeThreadWorktreePath === current.worktreePath) {
    return null;
  }
  if (!inputs.terminalOpen) return null;
  return current;
}

export function useTerminalLaunchContext(input: {
  activeThreadId: ThreadId | null;
  activeThreadKey: string | null;
  activeProjectCwd: string | null;
  activeThreadWorktreePath: string | null;
  terminalOpen: boolean;
  focusComposer: () => void;
}): {
  terminalUiLaunchContext: TerminalLaunchContext | null;
  setTerminalUiLaunchContext: Dispatch<SetStateAction<TerminalLaunchContext | null>>;
  terminalFocusRequestId: number;
  setTerminalFocusRequestId: Dispatch<SetStateAction<number>>;
} {
  const [terminalUiLaunchContext, setTerminalUiLaunchContext] =
    useState<TerminalLaunchContext | null>(null);
  const [terminalFocusRequestId, setTerminalFocusRequestId] = useState(0);
  const terminalUiOpenByThreadRef = useRef<Record<string, boolean>>({});

  useEffect(() => {
    setTerminalUiLaunchContext((current) =>
      reconcileTerminalLaunchContext(current, {
        activeThreadId: input.activeThreadId,
        activeProjectCwd: input.activeProjectCwd,
        activeThreadWorktreePath: input.activeThreadWorktreePath,
        terminalOpen: input.terminalOpen,
      }),
    );
  }, [
    input.activeProjectCwd,
    input.activeThreadId,
    input.activeThreadWorktreePath,
    input.terminalOpen,
  ]);

  useEffect(() => {
    if (!input.activeThreadKey) return;
    const previous = terminalUiOpenByThreadRef.current[input.activeThreadKey] ?? false;
    const current = Boolean(input.terminalOpen);

    if (!previous && current) {
      terminalUiOpenByThreadRef.current[input.activeThreadKey] = current;
      setTerminalFocusRequestId((value) => value + 1);
      return;
    }
    if (previous && !current) {
      terminalUiOpenByThreadRef.current[input.activeThreadKey] = current;
      const frame = window.requestAnimationFrame(() => {
        input.focusComposer();
      });
      return () => window.cancelAnimationFrame(frame);
    }

    terminalUiOpenByThreadRef.current[input.activeThreadKey] = current;
  }, [input.activeThreadKey, input.focusComposer, input.terminalOpen]);

  return {
    terminalUiLaunchContext,
    setTerminalUiLaunchContext,
    terminalFocusRequestId,
    setTerminalFocusRequestId,
  };
}
