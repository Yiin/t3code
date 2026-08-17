import {
  mapAtomCommandResult,
  runAtomCommand,
  type AtomCommandResult,
  type AtomCommandFailure,
  type AtomCommandSuccess,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  PreviewCloseInput,
  PreviewOpenInput,
  PreviewSessionSnapshot,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { useCallback } from "react";

import { previewEnvironment } from "./environments";
import { useAtomCommand } from "./use-atom-command";

export {
  isAtomCommandInterrupted,
  mapAtomCommandResult,
  squashAtomCommandFailure,
  type AtomCommandFailure,
  type AtomCommandResult,
  type AtomCommandSuccess,
};

export function usePreviewOpenAction() {
  const open = useAtomCommand(previewEnvironment.open, { reportFailure: false });
  return useCallback(
    (threadRef: ScopedThreadRef, input?: Omit<PreviewOpenInput, "threadId">) =>
      open({
        environmentId: threadRef.environmentId,
        input: {
          threadId: threadRef.threadId,
          ...input,
        },
      }),
    [open],
  );
}

export function usePreviewOpenCommand() {
  return useAtomCommand(previewEnvironment.open);
}

export function runPreviewOpenAction(
  registry: Parameters<typeof runAtomCommand>[0],
  threadRef: ScopedThreadRef,
  input?: Omit<PreviewOpenInput, "threadId">,
) {
  return runAtomCommand(
    registry,
    previewEnvironment.open,
    {
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, ...input },
    },
    { reportDefect: false, reportFailure: false },
  );
}

export function usePreviewCloseAction() {
  const close = useAtomCommand(previewEnvironment.close, { reportFailure: false });
  return useCallback(
    (threadRef: ScopedThreadRef, input: Omit<PreviewCloseInput, "threadId">) =>
      close({
        environmentId: threadRef.environmentId,
        input: {
          threadId: threadRef.threadId,
          ...input,
        },
      }),
    [close],
  );
}

export function usePreviewCloseCommand() {
  return useAtomCommand(previewEnvironment.close, { reportFailure: false });
}

export function usePreviewResizeAction() {
  return useAtomCommand(previewEnvironment.resize, "preview viewport resize");
}

export type PreviewSnapshotResult<E> = AtomCommandResult<PreviewSessionSnapshot, E>;
