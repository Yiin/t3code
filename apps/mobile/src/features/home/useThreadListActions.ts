import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { canSettle } from "@t3tools/client-runtime/state/thread-settled";
import {
  planThreadWorktreeCleanup,
  type ThreadWorktreeCleanupPlan,
} from "@t3tools/client-runtime/state/worktree-cleanup";
import * as Cause from "effect/Cause";
import * as Haptics from "expo-haptics";
import { useCallback, useRef } from "react";
import { Alert } from "react-native";

import { showConfirmDialog } from "../../components/ConfirmDialogHost";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { refreshArchivedThreadsForEnvironment } from "../archive/useArchivedThreadSnapshots";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentProjects } from "../../state/projects";
import { environmentServerConfigsAtom } from "../../state/server";
import { environmentThreadShells, threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { vcsEnvironment } from "../../state/vcs";

/** Version skew: never send settle/unsettle to a server that predates them
    (capability defaults false on decode for older servers). */
function environmentSupportsSettlement(environmentId: EnvironmentThreadShell["environmentId"]) {
  return (
    appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)?.environment.capabilities
      .threadSettlement === true
  );
}

/**
 * Deleting a thread does not remove its worktree — the server only deletes the
 * thread. Work out whether this thread is the last one pointing at its
 * worktree, so the delete flow can offer to remove the directory too.
 * Archived threads are not in the live shell stream, so they plan to null and
 * keep the old behaviour of leaving the worktree alone.
 */
function readThreadWorktreeCleanupPlan(
  thread: EnvironmentThreadShell,
): ThreadWorktreeCleanupPlan | null {
  const threads = appAtomRegistry
    .get(environmentThreadShells.threadShellsAtom)
    .filter((candidate) => candidate.environmentId === thread.environmentId);
  const project = appAtomRegistry.get(
    environmentProjects.projectAtom({
      environmentId: thread.environmentId,
      projectId: thread.projectId,
    }),
  );
  return planThreadWorktreeCleanup({
    threads,
    threadId: thread.id,
    workspaceRoot: project?.workspaceRoot ?? null,
  });
}

type ThreadListAction = "archive" | "unarchive" | "delete" | "settle" | "unsettle";

const ACTION_VERBS: Record<ThreadListAction, string> = {
  archive: "archived",
  unarchive: "unarchived",
  delete: "deleted",
  settle: "settled",
  unsettle: "un-settled",
};

function actionFailureMessage(action: ThreadListAction, cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return `The thread could not be ${ACTION_VERBS[action]}.`;
}

function selectionHaptic(): void {
  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
}

function actionFailureTitle(action: ThreadListAction): string {
  if (action === "archive") return "Could not archive thread";
  if (action === "unarchive") return "Could not unarchive thread";
  if (action === "settle") return "Could not settle thread";
  if (action === "unsettle") return "Could not un-settle thread";
  return "Could not delete thread";
}

type ThreadActionOptions = {
  /** Delete only: remove this worktree after the thread is gone. */
  readonly worktreeCleanup?: ThreadWorktreeCleanupPlan | null;
};

/** Resolves to true iff the action was dispatched and succeeded. */
function useThreadActionExecutor(
  onCompleted?: (action: ThreadListAction, thread: EnvironmentThreadShell) => void,
) {
  const archiveMutation = useAtomCommand(threadEnvironment.archive, { reportFailure: false });
  const unarchiveMutation = useAtomCommand(threadEnvironment.unarchive, { reportFailure: false });
  const deleteMutation = useAtomCommand(threadEnvironment.delete, { reportFailure: false });
  const settleMutation = useAtomCommand(threadEnvironment.settle, { reportFailure: false });
  const unsettleMutation = useAtomCommand(threadEnvironment.unsettle, { reportFailure: false });
  const removeWorktree = useAtomCommand(vcsEnvironment.removeWorktree, { reportFailure: false });
  const refreshVcsStatus = useAtomCommand(vcsEnvironment.refreshStatus, { reportFailure: false });
  const inFlightThreadKeys = useRef(new Set<string>());

  const cleanUpWorktree = useCallback(
    async (thread: EnvironmentThreadShell, plan: ThreadWorktreeCleanupPlan) => {
      // The thread is already gone, so a failure here is reported and not
      // treated as a failed delete.
      const removeResult = await removeWorktree({
        environmentId: thread.environmentId,
        input: { cwd: plan.workspaceRoot, path: plan.worktreePath, force: true },
      });
      const refreshResult =
        removeResult._tag === "Success"
          ? await refreshVcsStatus({
              environmentId: thread.environmentId,
              input: { cwd: plan.workspaceRoot },
            })
          : null;
      const failure =
        removeResult._tag === "Failure"
          ? removeResult
          : refreshResult?._tag === "Failure"
            ? refreshResult
            : null;
      if (failure === null) {
        return;
      }
      const error = Cause.squash(failure.cause);
      const message =
        error instanceof Error && error.message.trim().length > 0
          ? error.message
          : "Unknown error removing worktree.";
      Alert.alert(
        "Thread deleted, but worktree removal failed",
        `Could not remove ${plan.displayPath}. ${message}`,
      );
    },
    [refreshVcsStatus, removeWorktree],
  );

  const executeAction = useCallback(
    async (
      action: ThreadListAction,
      thread: EnvironmentThreadShell,
      options: ThreadActionOptions = {},
    ) => {
      const key = scopedThreadKey(thread.environmentId, thread.id);
      if (inFlightThreadKeys.current.has(key)) {
        return false;
      }

      inFlightThreadKeys.current.add(key);
      selectionHaptic();
      try {
        if (
          (action === "settle" || action === "unsettle") &&
          !environmentSupportsSettlement(thread.environmentId)
        ) {
          Alert.alert(
            actionFailureTitle(action),
            "This environment's server does not support settling yet. Update the server to use Settle.",
          );
          return false;
        }
        // Settle may only target what effectiveSettled could classify as
        // settled: not starting/running sessions, not threads waiting on
        // approvals or user input. Anything else would hide live work.
        if (action === "settle" && !canSettle(thread, { now: new Date().toISOString() })) {
          Alert.alert(
            actionFailureTitle(action),
            "This thread still needs attention. Resolve or interrupt it first, then try again.",
          );
          return false;
        }
        // Archive keeps its original, narrower guard: never interrupt a
        // thread mid-turn.
        if (
          action === "archive" &&
          thread.session?.status === "running" &&
          thread.session.activeTurnId != null
        ) {
          Alert.alert(
            actionFailureTitle(action),
            "This thread is working. Interrupt it first, then try again.",
          );
          return false;
        }
        const result =
          action === "unsettle"
            ? // reason "user" pins the thread active: auto-settle stays
              // suppressed until real activity clears the pin server-side.
              await unsettleMutation({
                environmentId: thread.environmentId,
                input: { threadId: thread.id, reason: "user" },
              })
            : await (
                action === "settle"
                  ? settleMutation
                  : action === "archive"
                    ? archiveMutation
                    : action === "unarchive"
                      ? unarchiveMutation
                      : deleteMutation
              )({
                environmentId: thread.environmentId,
                input: { threadId: thread.id },
              });
        if (result._tag === "Failure") {
          Alert.alert(actionFailureTitle(action), actionFailureMessage(action, result.cause));
          return false;
        }
        // Settled threads stay in the live shell stream; only the archive
        // lifecycle still feeds the archived-snapshot surface.
        if (action === "archive" || action === "unarchive" || action === "delete") {
          refreshArchivedThreadsForEnvironment(thread.environmentId);
        }
        if (action === "delete" && options.worktreeCleanup) {
          await cleanUpWorktree(thread, options.worktreeCleanup);
        }
        onCompleted?.(action, thread);
        return true;
      } finally {
        inFlightThreadKeys.current.delete(key);
      }
    },
    [
      archiveMutation,
      cleanUpWorktree,
      deleteMutation,
      onCompleted,
      settleMutation,
      unarchiveMutation,
      unsettleMutation,
    ],
  );

  return executeAction;
}

type DestructivePrompt = {
  readonly title: string;
  readonly message: string;
  readonly confirmText: string;
  readonly cancelText: string;
  readonly onConfirm: () => void;
  readonly onCancel?: () => void;
};

/** Native iOS alert where we have one, the themed Android dialog otherwise. */
function promptDestructiveChoice(prompt: DestructivePrompt): void {
  if (process.env.EXPO_OS === "ios") {
    Alert.alert(prompt.title, prompt.message, [
      { text: prompt.cancelText, style: "cancel", onPress: prompt.onCancel },
      { text: prompt.confirmText, style: "destructive", onPress: prompt.onConfirm },
    ]);
    return;
  }
  showConfirmDialog({
    title: prompt.title,
    message: prompt.message,
    cancelText: prompt.cancelText,
    confirmText: prompt.confirmText,
    destructive: true,
    onConfirm: prompt.onConfirm,
    onCancel: prompt.onCancel,
  });
}

function useConfirmDeleteThread(
  executeAction: (
    action: ThreadListAction,
    thread: EnvironmentThreadShell,
    options?: ThreadActionOptions,
  ) => Promise<boolean>,
) {
  return useCallback(
    (thread: EnvironmentThreadShell) => {
      const plan = readThreadWorktreeCleanupPlan(thread);
      const runDelete = (worktreeCleanup: ThreadWorktreeCleanupPlan | null) => {
        void executeAction("delete", thread, { worktreeCleanup });
      };
      // Two prompts, same order as the web client: confirm the delete, then
      // ask about the worktree the delete would orphan. Both answers to the
      // second prompt still delete the thread.
      const askAboutWorktree = () => {
        if (plan === null) {
          runDelete(null);
          return;
        }
        promptDestructiveChoice({
          title: "Delete the worktree too?",
          message: `This is the only thread linked to ${plan.displayPath}. Deleting it removes that worktree directory and anything uncommitted in it.`,
          confirmText: "Delete worktree",
          cancelText: "Keep worktree",
          onConfirm: () => {
            runDelete(plan);
          },
          onCancel: () => {
            runDelete(null);
          },
        });
      };
      promptDestructiveChoice({
        title: "Delete thread?",
        message: `“${thread.title}” will be permanently deleted, including its terminal history.`,
        confirmText: "Delete",
        cancelText: "Cancel",
        onConfirm: askAboutWorktree,
      });
    },
    [executeAction],
  );
}

export function useThreadListActions(): {
  readonly archiveThread: (thread: EnvironmentThreadShell) => void;
  readonly confirmDeleteThread: (thread: EnvironmentThreadShell) => void;
  readonly settleThread: (thread: EnvironmentThreadShell) => Promise<boolean>;
  readonly unsettleThread: (thread: EnvironmentThreadShell) => Promise<boolean>;
} {
  const executeAction = useThreadActionExecutor();

  const archiveThread = useCallback(
    (thread: EnvironmentThreadShell) => {
      void executeAction("archive", thread);
    },
    [executeAction],
  );
  const settleThread = useCallback(
    async (thread: EnvironmentThreadShell) => (await executeAction("settle", thread)) === true,
    [executeAction],
  );
  const unsettleThread = useCallback(
    async (thread: EnvironmentThreadShell) => (await executeAction("unsettle", thread)) === true,
    [executeAction],
  );

  const confirmDeleteThread = useConfirmDeleteThread(executeAction);

  return { archiveThread, confirmDeleteThread, settleThread, unsettleThread };
}

export function useArchivedThreadListActions(
  onCompleted: (thread: EnvironmentThreadShell) => void,
): {
  readonly unarchiveThread: (thread: EnvironmentThreadShell) => void;
  readonly confirmDeleteThread: (thread: EnvironmentThreadShell) => void;
} {
  const handleCompleted = useCallback(
    (_action: ThreadListAction, thread: EnvironmentThreadShell) => {
      onCompleted(thread);
    },
    [onCompleted],
  );
  const executeAction = useThreadActionExecutor(handleCompleted);
  const unarchiveThread = useCallback(
    (thread: EnvironmentThreadShell) => {
      void executeAction("unarchive", thread);
    },
    [executeAction],
  );
  const confirmDeleteThread = useConfirmDeleteThread(executeAction);

  return { unarchiveThread, confirmDeleteThread };
}
