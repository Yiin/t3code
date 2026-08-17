import type {
  EnvironmentId,
  PreviewCloseInput,
  PreviewSessionSnapshot,
  ScopedThreadRef,
  TerminalCloseInput,
  TerminalOpenInput,
} from "@t3tools/contracts";
import { useCallback, useEffect } from "react";

import { nextTerminalId } from "@t3tools/shared/terminalLabels";
import { MAX_TERMINALS_PER_GROUP } from "../types";
import type { AtomCommandResult } from "../state/command-results";
import {
  selectActiveRightPanelSurface,
  type RightPanelSurface,
  useRightPanelStore,
} from "../rightPanelStore";
import { isPreviewSupportedInRuntime, setActivePreviewTab } from "../previewStateStore";
import { closePreviewSession } from "../components/preview/closePreviewSession";
import { subscribePreviewAction } from "../components/preview/previewActionBus";
import { projectScriptRuntimeEnv } from "@t3tools/shared/projectScripts";
import { stackedThreadToast, toastManager } from "../components/ui/toast";

interface RightPanelState {
  readonly isOpen: boolean;
  readonly surfaces: readonly RightPanelSurface[];
}

interface RightPanelActionsOptions {
  readonly activeThreadRef: ScopedThreadRef | null;
  readonly activeThreadId: string | null;
  readonly activeProject: { workspaceRoot: string } | null;
  readonly activeThreadWorktreePath: string | null;
  readonly activeKnownTerminalIds: readonly string[];
  readonly panelTerminalIds: ReadonlySet<string>;
  readonly activeRightPanelSurface: RightPanelSurface | null;
  readonly activePreviewSessions: Record<string, PreviewSessionSnapshot>;
  readonly activePreviewTabId: string | null;
  readonly activeEnvironmentBootstrapComplete: boolean;
  readonly rightPanelState: RightPanelState;
  readonly previewPanelOpen: boolean;
  readonly rightPanelOpen: boolean;
  readonly planSidebarOpen: boolean;
  readonly canMaximizeRightPanel: boolean;
  readonly routeThreadKey: string;
  readonly gitCwd: string | null;
  readonly diffOpen: boolean;
  readonly planSidebarDismissedForTurnRef: { current: string | null };
  readonly createBrowserSurface: () => void;
  readonly closePlanSidebar: () => void;
  readonly dismissPlanSidebarForCurrentTurn: () => void;
  readonly onDiffPanelOpen: (() => void) | undefined;
  readonly setMaximizedRightPanelThreadKey: (
    updater: (current: string | null) => string | null,
  ) => void;
  readonly setTerminalFocusRequestId: (updater: (value: number) => number) => void;
  readonly openTerminal: (input: {
    environmentId: EnvironmentId;
    input: TerminalOpenInput;
  }) => unknown;
  readonly closeTerminalMutation: (input: {
    environmentId: EnvironmentId;
    input: TerminalCloseInput;
  }) => unknown;
  readonly closePreview: (input: {
    environmentId: EnvironmentId;
    input: PreviewCloseInput;
  }) => Promise<AtomCommandResult<void, unknown>>;
  readonly storeCloseTerminal: (ref: ScopedThreadRef, terminalId: string) => void;
}

export function useRightPanelActions(options: RightPanelActionsOptions) {
  const {
    activeThreadRef,
    activeThreadId,
    activeProject,
    activeThreadWorktreePath,
    activeKnownTerminalIds,
    panelTerminalIds,
    activeRightPanelSurface,
    activePreviewSessions,
    activePreviewTabId,
    activeEnvironmentBootstrapComplete,
    rightPanelState,
    previewPanelOpen,
    rightPanelOpen,
    planSidebarOpen,
    canMaximizeRightPanel,
    routeThreadKey,
    gitCwd,
    diffOpen,
    planSidebarDismissedForTurnRef,
    createBrowserSurface,
    closePlanSidebar,
    dismissPlanSidebarForCurrentTurn,
    onDiffPanelOpen,
    setMaximizedRightPanelThreadKey,
    setTerminalFocusRequestId,
    openTerminal,
    closeTerminalMutation,
    closePreview,
    storeCloseTerminal,
  } = options;

  const togglePreviewPanel = useCallback(() => {
    if (!activeThreadRef || !isPreviewSupportedInRuntime()) return;
    if (previewPanelOpen) {
      useRightPanelStore.getState().close(activeThreadRef);
      return;
    }
    if (activePreviewTabId) {
      useRightPanelStore.getState().openBrowser(activeThreadRef, activePreviewTabId);
    } else {
      createBrowserSurface();
    }
  }, [activePreviewTabId, activeThreadRef, createBrowserSurface, previewPanelOpen]);
  const closePreviewPanel = useCallback(() => {
    if (!activeThreadRef) return;
    setMaximizedRightPanelThreadKey(() => null);
    useRightPanelStore.getState().close(activeThreadRef);
  }, [activeThreadRef, setMaximizedRightPanelThreadKey]);

  const addTerminalSurface = useCallback(() => {
    if (!activeThreadRef || !activeThreadId || !activeProject) return;
    const terminalId = nextTerminalId([...activeKnownTerminalIds, ...panelTerminalIds]);
    const cwd = gitCwd ?? activeProject.workspaceRoot;
    useRightPanelStore.getState().openTerminal(activeThreadRef, terminalId);
    setTerminalFocusRequestId((value) => value + 1);
    void openTerminal({
      environmentId: activeThreadRef.environmentId,
      input: {
        threadId: activeThreadId,
        terminalId,
        cwd,
        ...(activeThreadWorktreePath != null ? { worktreePath: activeThreadWorktreePath } : {}),
        env: projectScriptRuntimeEnv({
          project: { cwd: activeProject.workspaceRoot },
          worktreePath: activeThreadWorktreePath,
        }),
      },
    });
  }, [
    activeKnownTerminalIds,
    activeProject,
    activeThreadId,
    activeThreadRef,
    activeThreadWorktreePath,
    gitCwd,
    openTerminal,
    panelTerminalIds,
    setTerminalFocusRequestId,
  ]);

  const splitPanelTerminal = useCallback(
    (direction: "horizontal" | "vertical" = "horizontal") => {
      if (
        !activeThreadRef ||
        !activeThreadId ||
        !activeProject ||
        activeRightPanelSurface?.kind !== "terminal" ||
        activeRightPanelSurface.terminalIds.length >= MAX_TERMINALS_PER_GROUP
      ) {
        return;
      }
      const terminalId = nextTerminalId([...activeKnownTerminalIds, ...panelTerminalIds]);
      const cwd = gitCwd ?? activeProject.workspaceRoot;
      useRightPanelStore
        .getState()
        .splitTerminal(activeThreadRef, activeRightPanelSurface.id, terminalId, direction);
      setTerminalFocusRequestId((value) => value + 1);
      void openTerminal({
        environmentId: activeThreadRef.environmentId,
        input: {
          threadId: activeThreadId,
          terminalId,
          cwd,
          ...(activeThreadWorktreePath != null ? { worktreePath: activeThreadWorktreePath } : {}),
          env: projectScriptRuntimeEnv({
            project: { cwd: activeProject.workspaceRoot },
            worktreePath: activeThreadWorktreePath,
          }),
        },
      });
    },
    [
      activeKnownTerminalIds,
      activeProject,
      activeRightPanelSurface,
      activeThreadId,
      activeThreadRef,
      activeThreadWorktreePath,
      gitCwd,
      openTerminal,
      panelTerminalIds,
      setTerminalFocusRequestId,
    ],
  );

  const splitPanelTerminalVertical = useCallback(
    () => splitPanelTerminal("vertical"),
    [splitPanelTerminal],
  );
  const activatePanelTerminal = useCallback(
    (terminalId: string) => {
      if (!activeThreadRef || activeRightPanelSurface?.kind !== "terminal") return;
      useRightPanelStore
        .getState()
        .activateTerminal(activeThreadRef, activeRightPanelSurface.id, terminalId);
      setTerminalFocusRequestId((value) => value + 1);
    },
    [activeRightPanelSurface, activeThreadRef, setTerminalFocusRequestId],
  );
  const closePanelTerminal = useCallback(
    (terminalId: string) => {
      if (!activeThreadRef || activeRightPanelSurface?.kind !== "terminal") return;
      void closeTerminalMutation({
        environmentId: activeThreadRef.environmentId,
        input: { threadId: activeThreadRef.threadId, terminalId, deleteHistory: true },
      });
      storeCloseTerminal(activeThreadRef, terminalId);
      useRightPanelStore
        .getState()
        .closeTerminal(activeThreadRef, activeRightPanelSurface.id, terminalId);
      setTerminalFocusRequestId((value) => value + 1);
    },
    [
      activeRightPanelSurface,
      activeThreadRef,
      closeTerminalMutation,
      setTerminalFocusRequestId,
      storeCloseTerminal,
    ],
  );

  const activateRightPanelSurface = useCallback(
    (surface: RightPanelSurface) => {
      if (!activeThreadRef) return;
      if (surface.kind === "plan") {
        planSidebarDismissedForTurnRef.current = null;
      } else if (planSidebarOpen) {
        dismissPlanSidebarForCurrentTurn();
      }
      useRightPanelStore.getState().activateSurface(activeThreadRef, surface.id);
      if (surface.kind === "preview" && surface.resourceId) {
        setActivePreviewTab(activeThreadRef, surface.resourceId);
      }
      if (surface.kind === "terminal") setTerminalFocusRequestId((value) => value + 1);
      if (surface.kind === "diff" && !diffOpen) onDiffPanelOpen?.();
    },
    [
      activeThreadRef,
      diffOpen,
      dismissPlanSidebarForCurrentTurn,
      onDiffPanelOpen,
      planSidebarDismissedForTurnRef,
      planSidebarOpen,
      setTerminalFocusRequestId,
    ],
  );
  const toggleRightPanel = useCallback(() => {
    if (!activeThreadRef) return;
    if (rightPanelOpen) {
      if (planSidebarOpen) closePlanSidebar();
      else closePreviewPanel();
      return;
    }
    useRightPanelStore.getState().toggleVisibility(activeThreadRef);
  }, [activeThreadRef, closePlanSidebar, closePreviewPanel, planSidebarOpen, rightPanelOpen]);
  const toggleRightPanelMaximized = useCallback(() => {
    if (!canMaximizeRightPanel) return;
    setMaximizedRightPanelThreadKey((threadKey) =>
      threadKey === routeThreadKey ? null : routeThreadKey,
    );
  }, [canMaximizeRightPanel, routeThreadKey, setMaximizedRightPanelThreadKey]);

  const cleanupRightPanelSurfaces = useCallback(
    (surfaces: readonly RightPanelSurface[]) => {
      if (!activeThreadRef) return;
      if (surfaces.some((surface) => surface.kind === "plan")) dismissPlanSidebarForCurrentTurn();
      for (const surface of surfaces) {
        if (surface.kind === "preview" && surface.resourceId) {
          void closePreviewSession({
            closePreview,
            snapshot: activePreviewSessions[surface.resourceId] ?? null,
            tabId: surface.resourceId,
            threadRef: activeThreadRef,
          });
        }
        if (surface.kind === "terminal") {
          for (const terminalId of surface.terminalIds) {
            storeCloseTerminal(activeThreadRef, terminalId);
            void closeTerminalMutation({
              environmentId: activeThreadRef.environmentId,
              input: { threadId: activeThreadRef.threadId, terminalId, deleteHistory: true },
            });
          }
        }
      }
    },
    [
      activePreviewSessions,
      activeThreadRef,
      closePreview,
      closeTerminalMutation,
      dismissPlanSidebarForCurrentTurn,
      storeCloseTerminal,
    ],
  );
  const syncActivePreviewSurface = useCallback(() => {
    if (!activeThreadRef) return;
    const nextActiveSurface = selectActiveRightPanelSurface(
      useRightPanelStore.getState().byThreadKey,
      activeThreadRef,
    );
    if (nextActiveSurface?.kind === "preview" && nextActiveSurface.resourceId) {
      setActivePreviewTab(activeThreadRef, nextActiveSurface.resourceId);
    }
  }, [activeThreadRef]);
  const closeRightPanelSurface = useCallback(
    (surface: RightPanelSurface) => {
      if (!activeThreadRef) return;
      cleanupRightPanelSurfaces([surface]);
      useRightPanelStore.getState().closeSurface(activeThreadRef, surface.id);
      syncActivePreviewSurface();
    },
    [activeThreadRef, cleanupRightPanelSurfaces, syncActivePreviewSurface],
  );
  const closeOtherRightPanelSurfaces = useCallback(
    (surface: RightPanelSurface) => {
      if (!activeThreadRef) return;
      const surfaces = rightPanelState.surfaces.filter((entry) => entry.id !== surface.id);
      cleanupRightPanelSurfaces(surfaces);
      useRightPanelStore.getState().closeOtherSurfaces(activeThreadRef, surface.id);
      syncActivePreviewSurface();
    },
    [
      activeThreadRef,
      cleanupRightPanelSurfaces,
      rightPanelState.surfaces,
      syncActivePreviewSurface,
    ],
  );
  const closeRightPanelSurfacesToRight = useCallback(
    (surface: RightPanelSurface) => {
      if (!activeThreadRef) return;
      const surfaceIndex = rightPanelState.surfaces.findIndex((entry) => entry.id === surface.id);
      if (surfaceIndex < 0) return;
      cleanupRightPanelSurfaces(rightPanelState.surfaces.slice(surfaceIndex + 1));
      useRightPanelStore.getState().closeSurfacesToRight(activeThreadRef, surface.id);
      syncActivePreviewSurface();
    },
    [
      activeThreadRef,
      cleanupRightPanelSurfaces,
      rightPanelState.surfaces,
      syncActivePreviewSurface,
    ],
  );
  const closeAllRightPanelSurfaces = useCallback(() => {
    if (!activeThreadRef) return;
    cleanupRightPanelSurfaces(rightPanelState.surfaces);
    useRightPanelStore.getState().closeAllSurfaces(activeThreadRef);
  }, [activeThreadRef, cleanupRightPanelSurfaces, rightPanelState.surfaces]);
  const copyRightPanelFilePath = useCallback((relativePath: string) => {
    if (typeof window === "undefined" || !navigator.clipboard?.writeText) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to copy path",
          description: "Clipboard API unavailable.",
        }),
      );
      return;
    }
    void navigator.clipboard.writeText(relativePath).then(
      () => toastManager.add({ type: "success", title: "Path copied", description: relativePath }),
      (error) =>
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to copy path",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        ),
    );
  }, []);

  useEffect(() => {
    if (!activeThreadRef) return;
    useRightPanelStore
      .getState()
      .reconcileBrowserSurfaces(activeThreadRef, Object.keys(activePreviewSessions));
  }, [activePreviewSessions, activeThreadRef]);
  useEffect(() => {
    if (!activeThreadRef || !activeEnvironmentBootstrapComplete) return;
    useRightPanelStore.getState().reconcileFileSurfaces(activeThreadRef, activeProject !== null);
  }, [activeEnvironmentBootstrapComplete, activeProject, activeThreadRef]);
  useEffect(
    () =>
      subscribePreviewAction((action) => {
        if (action === "toggle-panel") togglePreviewPanel();
      }),
    [togglePreviewPanel],
  );

  return {
    addTerminalSurface,
    activatePanelTerminal,
    activateRightPanelSurface,
    closeAllRightPanelSurfaces,
    closeOtherRightPanelSurfaces,
    closePanelTerminal,
    closeRightPanelSurface,
    closeRightPanelSurfacesToRight,
    copyRightPanelFilePath,
    closePreviewPanel,
    splitPanelTerminal,
    splitPanelTerminalVertical,
    togglePreviewPanel,
    toggleRightPanel,
    toggleRightPanelMaximized,
  };
}
