import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  archiveSelectedThreadEntries,
  buildMultiSelectThreadContextMenuItems,
  createEpicRunGroupExpandedResolver,
  createThreadJumpHintVisibilityController,
  epicRunGroupRowLabel,
  epicRunGroupTitle,
  epicRunIterationCountLabel,
  epicRunIterationLabel,
  epicRunIterationRowLabel,
  excludeSubagentChildThreads,
  filterHiddenEpicRunIterationThreads,
  getSidebarThreadIdsToPrewarm,
  getVisibleSidebarThreadIds,
  groupEpicRunIterationThreads,
  resolveAdjacentThreadId,
  getFallbackThreadIdAfterDelete,
  getVisibleThreadsForProject,
  getProjectSortTimestamp,
  hasUnseenCompletion,
  isContextMenuPointerDown,
  isTrailingDoubleClick,
  orderItemsByPreferredIds,
  resolveEpicRunGroupExpanded,
  resolveEpicRunStatusPill,
  resolveProjectStatusIndicator,
  resolveRenderedSidebarThreadNodes,
  resolveSidebarNewThreadSeedContext,
  resolveSidebarNewThreadEnvMode,
  resolveSidebarThreadSettleBatch,
  resolveSidebarStageBadgeLabel,
  resolveThreadRowClassName,
  resolveSidebarV2Status,
  resolveThreadStatusPill,
  shouldClearThreadSelectionOnMouseDown,
  specificTitle,
  sidebarEpicRunBeadsSources,
  sidebarEpicRunTitlesByRunId,
  sidebarNodeThreads,
  sidebarRenderedThreadIds,
  sidebarTraversalThreadIds,
  sortThreadsForSidebarV2,
  sortProjectsForSidebar,
  threadStatusPillText,
  sortScopedProjectsForSidebar,
  settleSidebarThreadBatch,
  THREAD_JUMP_HINT_SHOW_DELAY_MS,
} from "./Sidebar.logic";
import {
  EnvironmentId,
  epicRunIterationThreadId,
  OrchestrationLatestTurn,
  parseEpicRunIterationThreadId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import {
  DEFAULT_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  type Project,
  type Thread,
} from "../types";

const localEnvironmentId = EnvironmentId.make("environment-local");

describe("archiveSelectedThreadEntries", () => {
  const entries = [{ threadKey: "one" }, { threadKey: "two" }, { threadKey: "three" }] as const;
  const success = { _tag: "Success" } as const;
  const failure = { _tag: "Failure" } as const;

  it("records every entry after full success", async () => {
    const outcome = await archiveSelectedThreadEntries({
      entries,
      archive: async (_entry, onArchived) => {
        onArchived();
        return success;
      },
    });

    expect(outcome).toEqual({
      archivedThreadKeys: ["one", "two", "three"],
      mutationFailure: null,
      followupFailures: [],
    });
  });

  it("stops at a mutation failure and retains prior successes", async () => {
    const archive = vi.fn(async (entry: (typeof entries)[number], onArchived: () => void) => {
      if (entry.threadKey === "two") return failure;
      onArchived();
      return success;
    });
    const outcome = await archiveSelectedThreadEntries({ entries, archive });

    expect(archive).toHaveBeenCalledTimes(2);
    expect(outcome).toEqual({
      archivedThreadKeys: ["one"],
      mutationFailure: failure,
      followupFailures: [],
    });
  });

  it("continues after a post-archive failure", async () => {
    const archive = vi.fn(async (entry: (typeof entries)[number], onArchived: () => void) => {
      onArchived();
      return entry.threadKey === "two" ? failure : success;
    });
    const outcome = await archiveSelectedThreadEntries({ entries, archive });

    expect(archive).toHaveBeenCalledTimes(3);
    expect(outcome).toEqual({
      archivedThreadKeys: ["one", "two", "three"],
      mutationFailure: null,
      followupFailures: [failure],
    });
  });
});

describe("buildMultiSelectThreadContextMenuItems", () => {
  it("offers bulk archive with the selected count", () => {
    expect(
      buildMultiSelectThreadContextMenuItems({ count: 3, hasRunningThread: false }),
    ).toContainEqual({ id: "archive", label: "Archive (3)", disabled: false });
  });

  it("disables bulk archive when a selected thread is running", () => {
    expect(
      buildMultiSelectThreadContextMenuItems({ count: 2, hasRunningThread: true }),
    ).toContainEqual({ id: "archive", label: "Archive (2)", disabled: true });
  });
});

describe("resolveSidebarStageBadgeLabel", () => {
  it("returns Nightly for nightly primary server versions", () => {
    expect(
      resolveSidebarStageBadgeLabel({
        primaryServerVersion: "0.0.28-nightly.20260616.12",
        fallbackStageLabel: "Alpha",
      }),
    ).toBe("Nightly");
  });

  it("returns the fallback label for stable primary server versions", () => {
    expect(
      resolveSidebarStageBadgeLabel({
        primaryServerVersion: "0.0.27",
        fallbackStageLabel: "Alpha",
      }),
    ).toBe("Alpha");
  });

  it("returns the fallback label when the primary server version is missing", () => {
    expect(
      resolveSidebarStageBadgeLabel({
        primaryServerVersion: null,
        fallbackStageLabel: "Dev",
      }),
    ).toBe("Dev");
  });

  it("returns the fallback label for malformed nightly prerelease versions", () => {
    expect(
      resolveSidebarStageBadgeLabel({
        primaryServerVersion: "0.0.28-nightly.20260616",
        fallbackStageLabel: "Alpha",
      }),
    ).toBe("Alpha");
  });
});

function makeLatestTurn(overrides?: {
  completedAt?: string | null;
  startedAt?: string | null;
}): OrchestrationLatestTurn {
  return {
    turnId: "turn-1" as never,
    state: "completed",
    assistantMessageId: null,
    requestedAt: "2026-03-09T10:00:00.000Z",
    startedAt: overrides?.startedAt ?? "2026-03-09T10:00:00.000Z",
    completedAt: overrides?.completedAt ?? "2026-03-09T10:05:00.000Z",
  };
}

describe("hasUnseenCompletion", () => {
  it("returns true when a thread completed after its last visit", () => {
    expect(
      hasUnseenCompletion({
        hasActionableProposedPlan: false,
        hasPendingApprovals: false,
        hasPendingUserInput: false,
        interactionMode: "default",
        latestTurn: makeLatestTurn(),
        lastVisitedAt: "2026-03-09T10:04:00.000Z",
        session: null,
      }),
    ).toBe(true);
  });

  it("treats a missing client visit marker as read", () => {
    expect(
      hasUnseenCompletion({
        hasActionableProposedPlan: false,
        hasPendingApprovals: false,
        hasPendingUserInput: false,
        interactionMode: "default",
        latestTurn: makeLatestTurn(),
        lastVisitedAt: undefined,
        session: null,
      }),
    ).toBe(false);
  });
});

describe("createThreadJumpHintVisibilityController", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("delays showing jump hints until the configured delay elapses", () => {
    const visibilityChanges: boolean[] = [];
    const controller = createThreadJumpHintVisibilityController({
      delayMs: THREAD_JUMP_HINT_SHOW_DELAY_MS,
      onVisibilityChange: (visible) => {
        visibilityChanges.push(visible);
      },
    });

    controller.sync(true);
    vi.advanceTimersByTime(THREAD_JUMP_HINT_SHOW_DELAY_MS - 1);

    expect(visibilityChanges).toEqual([]);

    vi.advanceTimersByTime(1);

    expect(visibilityChanges).toEqual([true]);
  });

  it("hides immediately when the modifiers are released", () => {
    const visibilityChanges: boolean[] = [];
    const controller = createThreadJumpHintVisibilityController({
      delayMs: THREAD_JUMP_HINT_SHOW_DELAY_MS,
      onVisibilityChange: (visible) => {
        visibilityChanges.push(visible);
      },
    });

    controller.sync(true);
    vi.advanceTimersByTime(THREAD_JUMP_HINT_SHOW_DELAY_MS);
    controller.sync(false);

    expect(visibilityChanges).toEqual([true, false]);
  });

  it("cancels a pending reveal when the modifier is released early", () => {
    const visibilityChanges: boolean[] = [];
    const controller = createThreadJumpHintVisibilityController({
      delayMs: THREAD_JUMP_HINT_SHOW_DELAY_MS,
      onVisibilityChange: (visible) => {
        visibilityChanges.push(visible);
      },
    });

    controller.sync(true);
    vi.advanceTimersByTime(Math.floor(THREAD_JUMP_HINT_SHOW_DELAY_MS / 2));
    controller.sync(false);
    vi.advanceTimersByTime(THREAD_JUMP_HINT_SHOW_DELAY_MS);

    expect(visibilityChanges).toEqual([]);
  });
});

describe("getSidebarThreadIdsToPrewarm", () => {
  it("returns only the first visible thread ids up to the prewarm limit", () => {
    expect(getSidebarThreadIdsToPrewarm(["t1", "t2", "t3"], 2)).toEqual(["t1", "t2"]);
  });

  it("returns all visible thread ids when they fit within the limit", () => {
    expect(getSidebarThreadIdsToPrewarm(["t1", "t2"], 10)).toEqual(["t1", "t2"]);
  });

  it("returns no thread ids when the limit is zero", () => {
    expect(getSidebarThreadIdsToPrewarm(["t1", "t2"], 0)).toEqual([]);
  });
});

describe("shouldClearThreadSelectionOnMouseDown", () => {
  it("preserves selection for thread items", () => {
    const child = {
      closest: (selector: string) =>
        selector.includes("[data-thread-item]") ? ({} as Element) : null,
    } as unknown as HTMLElement;

    expect(shouldClearThreadSelectionOnMouseDown(child)).toBe(false);
  });

  it("preserves selection for thread list toggle controls", () => {
    const selectionSafe = {
      closest: (selector: string) =>
        selector.includes("[data-thread-selection-safe]") ? ({} as Element) : null,
    } as unknown as HTMLElement;

    expect(shouldClearThreadSelectionOnMouseDown(selectionSafe)).toBe(false);
  });

  it("clears selection for unrelated sidebar clicks", () => {
    const unrelated = {
      closest: () => null,
    } as unknown as HTMLElement;

    expect(shouldClearThreadSelectionOnMouseDown(unrelated)).toBe(true);
  });
});

describe("isTrailingDoubleClick", () => {
  it("treats a single click as a normal activation", () => {
    expect(isTrailingDoubleClick(1)).toBe(false);
  });

  it("treats synthetic/keyboard activations (detail 0) as a normal activation", () => {
    expect(isTrailingDoubleClick(0)).toBe(false);
  });

  it("ignores the second click of a double-click so it does not navigate", () => {
    expect(isTrailingDoubleClick(2)).toBe(true);
  });

  it("ignores further clicks of a triple-click", () => {
    expect(isTrailingDoubleClick(3)).toBe(true);
  });
});

describe("resolveSidebarNewThreadEnvMode", () => {
  it("uses the app default when the caller does not request a specific mode", () => {
    expect(
      resolveSidebarNewThreadEnvMode({
        defaultEnvMode: "worktree",
      }),
    ).toBe("worktree");
  });

  it("preserves an explicit requested mode over the app default", () => {
    expect(
      resolveSidebarNewThreadEnvMode({
        requestedEnvMode: "local",
        defaultEnvMode: "worktree",
      }),
    ).toBe("local");
  });
});

describe("resolveSidebarNewThreadSeedContext", () => {
  it("prefers the default worktree mode over active thread context", () => {
    expect(
      resolveSidebarNewThreadSeedContext({
        projectId: "project-1",
        defaultEnvMode: "worktree",
        activeThread: {
          projectId: "project-1",
          branch: "feature/existing",
          worktreePath: "/repo/.t3/worktrees/existing",
        },
        activeDraftThread: {
          projectId: "project-1",
          branch: "feature/draft",
          worktreePath: "/repo/.t3/worktrees/draft",
          envMode: "worktree",
          startFromOrigin: true,
        },
      }),
    ).toEqual({
      envMode: "worktree",
    });
  });

  it("inherits the active server thread context when creating a new thread in the same project", () => {
    expect(
      resolveSidebarNewThreadSeedContext({
        projectId: "project-1",
        defaultEnvMode: "local",
        activeThread: {
          projectId: "project-1",
          branch: "effect-atom",
          worktreePath: null,
        },
        activeDraftThread: null,
      }),
    ).toEqual({
      branch: "effect-atom",
      worktreePath: null,
      envMode: "local",
    });
  });

  it("prefers the active draft thread context when it matches the target project", () => {
    expect(
      resolveSidebarNewThreadSeedContext({
        projectId: "project-1",
        defaultEnvMode: "local",
        activeThread: {
          projectId: "project-1",
          branch: "effect-atom",
          worktreePath: null,
        },
        activeDraftThread: {
          projectId: "project-1",
          branch: "feature/new-draft",
          worktreePath: "/repo/worktree",
          envMode: "worktree",
          startFromOrigin: true,
        },
      }),
    ).toEqual({
      branch: "feature/new-draft",
      worktreePath: "/repo/worktree",
      envMode: "worktree",
      startFromOrigin: true,
    });
  });

  it("falls back to the default env mode when there is no matching active thread context", () => {
    expect(
      resolveSidebarNewThreadSeedContext({
        projectId: "project-2",
        defaultEnvMode: "worktree",
        activeThread: {
          projectId: "project-1",
          branch: "effect-atom",
          worktreePath: null,
        },
        activeDraftThread: null,
      }),
    ).toEqual({
      envMode: "worktree",
    });
  });
});

describe("orderItemsByPreferredIds", () => {
  it("keeps preferred ids first, skips stale ids, and preserves the relative order of remaining items", () => {
    const ordered = orderItemsByPreferredIds({
      items: [
        { id: ProjectId.make("project-1"), name: "One" },
        { id: ProjectId.make("project-2"), name: "Two" },
        { id: ProjectId.make("project-3"), name: "Three" },
      ],
      preferredIds: [
        ProjectId.make("project-3"),
        ProjectId.make("project-missing"),
        ProjectId.make("project-1"),
      ],
      getId: (project) => project.id,
    });

    expect(ordered.map((project) => project.id)).toEqual([
      ProjectId.make("project-3"),
      ProjectId.make("project-1"),
      ProjectId.make("project-2"),
    ]);
  });

  it("does not duplicate items when preferred ids repeat", () => {
    const ordered = orderItemsByPreferredIds({
      items: [
        { id: ProjectId.make("project-1"), name: "One" },
        { id: ProjectId.make("project-2"), name: "Two" },
      ],
      preferredIds: [
        ProjectId.make("project-2"),
        ProjectId.make("project-1"),
        ProjectId.make("project-2"),
      ],
      getId: (project) => project.id,
    });

    expect(ordered.map((project) => project.id)).toEqual([
      ProjectId.make("project-2"),
      ProjectId.make("project-1"),
    ]);
  });

  it("honors projectOrder physical keys via getProjectOrderKey", async () => {
    // Regression guard for #1904 / the regression introduced by #2055:
    // `projectOrder` is populated with physical keys (envId + cwd-derived)
    // by the store and by drag-end handlers. Readers must identify projects
    // with the same key format, or manual sort silently snaps back.
    const { getProjectOrderKey } = await import("../logicalProject");
    const projects = [
      {
        environmentId: EnvironmentId.make("environment-local"),
        id: ProjectId.make("id-alpha"),
        workspaceRoot: "/work/alpha",
      },
      {
        environmentId: EnvironmentId.make("environment-local"),
        id: ProjectId.make("id-beta"),
        workspaceRoot: "/work/beta",
      },
      {
        environmentId: EnvironmentId.make("environment-local"),
        id: ProjectId.make("id-gamma"),
        workspaceRoot: "/work/gamma",
      },
    ];
    const ordered = orderItemsByPreferredIds({
      items: projects,
      preferredIds: [getProjectOrderKey(projects[2]!), getProjectOrderKey(projects[0]!)],
      getId: getProjectOrderKey,
    });

    expect(ordered.map((project) => project.workspaceRoot)).toEqual([
      "/work/gamma",
      "/work/alpha",
      "/work/beta",
    ]);
  });

  it("resolves legacy preference aliases without materializing project state", () => {
    const ordered = orderItemsByPreferredIds({
      items: [
        { id: "physical-a", cwd: "/work/a" },
        { id: "physical-b", cwd: "/work/b" },
        { id: "physical-c", cwd: "/work/c" },
      ],
      preferredIds: ["legacy:/work/c", "legacy:/work/a"],
      getId: (project) => project.id,
      getPreferenceIds: (project) => [project.id, `legacy:${project.cwd}`],
    });

    expect(ordered.map((project) => project.id)).toEqual([
      "physical-c",
      "physical-a",
      "physical-b",
    ]);
  });
});

describe("resolveAdjacentThreadId", () => {
  it("resolves adjacent thread ids in ordered sidebar traversal", () => {
    const threads = [
      ThreadId.make("thread-1"),
      ThreadId.make("thread-2"),
      ThreadId.make("thread-3"),
    ];

    expect(
      resolveAdjacentThreadId({
        threadIds: threads,
        currentThreadId: threads[1] ?? null,
        direction: "previous",
      }),
    ).toBe(threads[0]);
    expect(
      resolveAdjacentThreadId({
        threadIds: threads,
        currentThreadId: threads[1] ?? null,
        direction: "next",
      }),
    ).toBe(threads[2]);
    expect(
      resolveAdjacentThreadId({
        threadIds: threads,
        currentThreadId: null,
        direction: "next",
      }),
    ).toBe(threads[0]);
    expect(
      resolveAdjacentThreadId({
        threadIds: threads,
        currentThreadId: null,
        direction: "previous",
      }),
    ).toBe(threads[2]);
    expect(
      resolveAdjacentThreadId({
        threadIds: threads,
        currentThreadId: threads[0] ?? null,
        direction: "previous",
      }),
    ).toBeNull();
  });
});

describe("getVisibleSidebarThreadIds", () => {
  it("returns only the rendered visible thread order across projects", () => {
    expect(
      getVisibleSidebarThreadIds([
        {
          renderedThreadIds: [
            ThreadId.make("thread-12"),
            ThreadId.make("thread-11"),
            ThreadId.make("thread-10"),
          ],
        },
        {
          renderedThreadIds: [ThreadId.make("thread-8"), ThreadId.make("thread-6")],
        },
      ]),
    ).toEqual([
      ThreadId.make("thread-12"),
      ThreadId.make("thread-11"),
      ThreadId.make("thread-10"),
      ThreadId.make("thread-8"),
      ThreadId.make("thread-6"),
    ]);
  });

  it("skips threads from collapsed projects whose thread panels are not shown", () => {
    expect(
      getVisibleSidebarThreadIds([
        {
          shouldShowThreadPanel: false,
          renderedThreadIds: [ThreadId.make("thread-hidden-2"), ThreadId.make("thread-hidden-1")],
        },
        {
          shouldShowThreadPanel: true,
          renderedThreadIds: [ThreadId.make("thread-12"), ThreadId.make("thread-11")],
        },
      ]),
    ).toEqual([ThreadId.make("thread-12"), ThreadId.make("thread-11")]);
  });
});

describe("isContextMenuPointerDown", () => {
  it("treats secondary-button presses as context menu gestures on all platforms", () => {
    expect(
      isContextMenuPointerDown({
        button: 2,
        ctrlKey: false,
        isMac: false,
      }),
    ).toBe(true);
  });

  it("treats ctrl+primary-click as a context menu gesture on macOS", () => {
    expect(
      isContextMenuPointerDown({
        button: 0,
        ctrlKey: true,
        isMac: true,
      }),
    ).toBe(true);
  });

  it("does not treat ctrl+primary-click as a context menu gesture off macOS", () => {
    expect(
      isContextMenuPointerDown({
        button: 0,
        ctrlKey: true,
        isMac: false,
      }),
    ).toBe(false);
  });
});

describe("resolveSidebarV2Status", () => {
  const session = {
    threadId: ThreadId.make("thread-1"),
    status: "running" as const,
    providerName: "Codex",
    providerInstanceId: ProviderInstanceId.make("codex"),
    runtimeMode: DEFAULT_RUNTIME_MODE,
    activeTurnId: "turn-1" as never,
    lastError: null,
    updatedAt: "2026-03-09T10:00:00.000Z",
  };

  const idle = { hasPendingApprovals: false, hasPendingUserInput: false };

  it("prioritizes approval over a running session", () => {
    expect(resolveSidebarV2Status({ ...idle, hasPendingApprovals: true, session })).toBe(
      "approval",
    );
  });

  it("prioritizes awaiting input over a running session, below approval", () => {
    expect(resolveSidebarV2Status({ ...idle, hasPendingUserInput: true, session })).toBe("input");
    expect(
      resolveSidebarV2Status({
        ...idle,
        hasPendingApprovals: true,
        hasPendingUserInput: true,
        session,
      }),
    ).toBe("approval");
  });

  it("reports working for running and starting sessions", () => {
    expect(resolveSidebarV2Status({ ...idle, session })).toBe("working");
    expect(
      resolveSidebarV2Status({
        ...idle,
        session: { ...session, status: "starting" as const },
      }),
    ).toBe("working");
  });

  it("puts an active epic run below user action and above provider activity", () => {
    expect(resolveSidebarV2Status({ ...idle, session: null }, true)).toBe("run-active");
    expect(resolveSidebarV2Status({ ...idle, hasPendingApprovals: true, session }, true)).toBe(
      "approval",
    );
    expect(resolveSidebarV2Status({ ...idle, hasPendingUserInput: true, session }, true)).toBe(
      "input",
    );
  });

  it("reports failed only while the session status is error", () => {
    expect(
      resolveSidebarV2Status({
        ...idle,
        session: { ...session, status: "error" as const, lastError: "boom" },
      }),
    ).toBe("failed");
    expect(
      resolveSidebarV2Status({
        ...idle,
        session: { ...session, status: "stopped" as const, lastError: "persisted" },
      }),
    ).toBe("ready");
    expect(
      resolveSidebarV2Status({
        ...idle,
        session: { ...session, status: "ready" as const, lastError: "persisted" },
      }),
    ).toBe("ready");
  });

  it("defaults to ready with no session", () => {
    expect(resolveSidebarV2Status({ ...idle, session: null })).toBe("ready");
  });

  it("reports subagents only when the parent is idle with active children", () => {
    expect(resolveSidebarV2Status({ ...idle, session: null, activeSubagentCount: 2 })).toBe(
      "subagents",
    );
    expect(resolveSidebarV2Status({ ...idle, session, activeSubagentCount: 2 })).toBe("working");
    expect(
      resolveSidebarV2Status({
        ...idle,
        session: { ...session, status: "error" as const, lastError: "boom" },
        activeSubagentCount: 2,
      }),
    ).toBe("failed");
    expect(resolveSidebarV2Status({ ...idle, session: null, activeSubagentCount: 0 })).toBe(
      "ready",
    );
  });
});

describe("sortThreadsForSidebarV2", () => {
  const sortable = (input: { id: string; createdAt: string }) => ({
    id: input.id,
    createdAt: input.createdAt,
  });

  it("orders by creation time, newest first, ignoring activity", () => {
    const sorted = sortThreadsForSidebarV2([
      sortable({ id: "oldest", createdAt: "2026-03-09T08:00:00.000Z" }),
      sortable({ id: "newest", createdAt: "2026-03-09T12:00:00.000Z" }),
      sortable({ id: "middle", createdAt: "2026-03-09T10:00:00.000Z" }),
    ]);

    expect(sorted.map((thread) => thread.id)).toEqual(["newest", "middle", "oldest"]);
  });

  it("breaks creation-time ties by id so the order is stable", () => {
    const sorted = sortThreadsForSidebarV2([
      sortable({ id: "b", createdAt: "2026-03-09T10:00:00.000Z" }),
      sortable({ id: "a", createdAt: "2026-03-09T10:00:00.000Z" }),
    ]);

    expect(sorted.map((thread) => thread.id)).toEqual(["a", "b"]);
  });
});

describe("groupEpicRunIterationThreads", () => {
  const thread = (id: string) => ({ id });
  const runId = "0c5a1f4e-9b7d-4a2c-8f31-6d0e2b7a4c19";
  const iterationThread = (index: number) =>
    thread(epicRunIterationThreadId({ runId, iterationIndex: index }));

  const run = {
    runId,
    epicId: "t3code-ypi",
    cwd: "/repo",
    status: "running" as const,
    originThreadId: null,
    threadRefs: [
      {
        threadId: epicRunIterationThreadId({ runId, iterationIndex: 0 }),
        issueId: "t3code-ypi.1",
        iterationIndex: 0,
      },
      {
        threadId: epicRunIterationThreadId({ runId, iterationIndex: 1 }),
        issueId: "t3code-ypi.2",
        iterationIndex: 1,
      },
    ],
  };

  // The whole feature rests on the client parsing an id the server built. If
  // EpicRunner stops using `epicRunIterationThreadId`, this fails instead of
  // the sidebar silently going back to one flat row per iteration.
  it("parses an id built by the server helper", () => {
    expect(
      parseEpicRunIterationThreadId(epicRunIterationThreadId({ runId, iterationIndex: 7 })),
    ).toEqual({ runId, iterationIndex: 7 });
  });

  it("folds a run's iterations into one group, ordered by iteration index", () => {
    const nodes = groupEpicRunIterationThreads({
      threads: [iterationThread(1), iterationThread(0)],
      runs: [run],
    });

    expect(nodes).toHaveLength(1);
    const group = nodes[0];
    expect(group).toMatchObject({
      kind: "epic-run",
      runId,
      epicId: "t3code-ypi",
      status: "running",
    });
    expect(group?.kind === "epic-run" ? group.iterations : []).toEqual([
      {
        iterationIndex: 0,
        issueId: "t3code-ypi.1",
        issueTitle: null,
        thread: iterationThread(0),
      },
      {
        iterationIndex: 1,
        issueId: "t3code-ypi.2",
        issueTitle: null,
        thread: iterationThread(1),
      },
    ]);
  });

  it("leaves non-epic threads untouched and keeps the group in the newest iteration's slot", () => {
    const nodes = groupEpicRunIterationThreads({
      threads: [
        thread("newer-thread"),
        iterationThread(1),
        thread("older-thread"),
        iterationThread(0),
      ],
      runs: [run],
    });

    expect(
      nodes.map((node) => (node.kind === "thread" ? node.thread.id : `group:${node.runId}`)),
    ).toEqual(["newer-thread", `group:${runId}`, "older-thread"]);
  });

  it("groups separate runs separately", () => {
    const otherRunId = "9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d";
    const nodes = groupEpicRunIterationThreads({
      threads: [
        iterationThread(0),
        thread(epicRunIterationThreadId({ runId: otherRunId, iterationIndex: 0 })),
      ],
    });

    expect(nodes.map((node) => (node.kind === "epic-run" ? node.runId : node.thread.id))).toEqual([
      runId,
      otherRunId,
    ]);
  });

  it("groups before the run read model arrives, with labels left null", () => {
    const nodes = groupEpicRunIterationThreads({ threads: [iterationThread(0)] });

    expect(nodes[0]).toMatchObject({
      kind: "epic-run",
      runId,
      epicId: null,
      status: null,
      iterations: [{ iterationIndex: 0, issueId: null }],
    });
  });

  // A restart-resume reopens the interrupted iteration's own row, so the run
  // still reports ONE thread ref for it and the server still opens no second
  // thread. One iteration therefore stays one node, however many times it
  // resumed. If anyone ever swaps the reopen for an appended row, the run
  // gains a ref at index 1 for the same child and this fails, instead of the
  // sidebar quietly listing the same work twice.
  it("shows one iteration node for a run whose only iteration was resumed", () => {
    const resumedRun = {
      ...run,
      threadRefs: [
        {
          threadId: epicRunIterationThreadId({ runId, iterationIndex: 0 }),
          issueId: "t3code-ypi.1",
          iterationIndex: 0,
        },
      ],
    };

    const nodes = groupEpicRunIterationThreads({
      threads: [iterationThread(0)],
      runs: [resumedRun],
    });

    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({
      kind: "epic-run",
      runId,
      iterations: [{ iterationIndex: 0, issueId: "t3code-ypi.1" }],
    });
    expect(sidebarNodeThreads(nodes[0]!)).toHaveLength(1);
  });

  it("ignores thread ids that only look like iteration ids", () => {
    const nodes = groupEpicRunIterationThreads({
      threads: [thread("epic-runner-notes"), thread(`epic-run-${runId}-final`)],
    });

    expect(nodes.every((node) => node.kind === "thread")).toBe(true);
  });

  it("reports the threads a node stands for", () => {
    const nodes = groupEpicRunIterationThreads({
      threads: [thread("plain"), iterationThread(0), iterationThread(1)],
      runs: [run],
    });

    expect(nodes.map((node) => sidebarNodeThreads(node).map((entry) => entry.id))).toEqual([
      ["plain"],
      [iterationThread(0).id, iterationThread(1).id],
    ]);
  });

  const nodeIds = (nodes: ReturnType<typeof groupEpicRunIterationThreads<{ id: string }>>) =>
    nodes.map((node) => (node.kind === "thread" ? node.thread.id : `group:${node.runId}`));

  it("nests a run under the thread that launched it, out of its own slot", () => {
    const nodes = groupEpicRunIterationThreads({
      threads: [iterationThread(1), thread("newer-thread"), thread("launcher"), iterationThread(0)],
      runs: [{ ...run, originThreadId: "launcher" }],
    });

    expect(nodeIds(nodes)).toEqual(["newer-thread", "launcher", `group:${runId}`]);
    expect(nodes.at(-1)).toMatchObject({ kind: "epic-run", nestedUnderThreadId: "launcher" });
  });

  it("keeps an Epics-page launch at project level", () => {
    const nodes = groupEpicRunIterationThreads({
      threads: [iterationThread(0), thread("launcher")],
      runs: [run],
    });

    expect(nodeIds(nodes)).toEqual([`group:${runId}`, "launcher"]);
    expect(nodes[0]).toMatchObject({ kind: "epic-run", nestedUnderThreadId: null });
  });

  // Deleted, archived, filtered out, in another project: whatever took the
  // launcher off the list, the run stays visible at project level.
  it("detaches to project level when the origin thread is not in the list", () => {
    const nodes = groupEpicRunIterationThreads({
      threads: [iterationThread(0), thread("other-thread")],
      runs: [{ ...run, originThreadId: "archived-launcher" }],
    });

    expect(nodeIds(nodes)).toEqual([`group:${runId}`, "other-thread"]);
    expect(nodes[0]).toMatchObject({ kind: "epic-run", nestedUnderThreadId: null });
  });

  // Two levels only: a run launched from inside another run's iteration would
  // otherwise put a group under a group.
  it("refuses to nest under an iteration thread", () => {
    const innerRunId = "9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d";
    const nodes = groupEpicRunIterationThreads({
      threads: [
        iterationThread(0),
        thread(epicRunIterationThreadId({ runId: innerRunId, iterationIndex: 0 })),
      ],
      runs: [
        run,
        {
          ...run,
          runId: innerRunId,
          originThreadId: iterationThread(0).id,
          threadRefs: [],
        },
      ],
    });

    expect(nodeIds(nodes)).toEqual([`group:${runId}`, `group:${innerRunId}`]);
    expect(nodes[1]).toMatchObject({ kind: "epic-run", nestedUnderThreadId: null });
  });

  it("stacks two runs launched from the same thread under it, in list order", () => {
    const secondRunId = "9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d";
    const nodes = groupEpicRunIterationThreads({
      threads: [
        thread(epicRunIterationThreadId({ runId: secondRunId, iterationIndex: 0 })),
        iterationThread(0),
        thread("launcher"),
      ],
      runs: [
        { ...run, originThreadId: "launcher" },
        { ...run, runId: secondRunId, originThreadId: "launcher", threadRefs: [] },
      ],
    });

    expect(nodeIds(nodes)).toEqual(["launcher", `group:${secondRunId}`, `group:${runId}`]);
  });

  // The settled divider is placed once by index in SidebarV2, so a group may
  // only follow its launcher when both sit on the same side of the settled
  // boundary. A cross-boundary nest would strand active rows under the
  // Settled heading.
  const settledPredicate = (settledIds: ReadonlySet<string>) => (entry: { readonly id: string }) =>
    settledIds.has(entry.id);

  it("does not nest an all-settled group under an active launcher", () => {
    const nodes = groupEpicRunIterationThreads({
      threads: [thread("launcher"), iterationThread(0), iterationThread(1)],
      runs: [{ ...run, originThreadId: "launcher" }],
      isThreadSettled: settledPredicate(new Set([iterationThread(0).id, iterationThread(1).id])),
    });

    expect(nodeIds(nodes)).toEqual(["launcher", `group:${runId}`]);
    expect(nodes[1]).toMatchObject({ kind: "epic-run", nestedUnderThreadId: null });
  });

  it("does not nest a group with an unsettled iteration under a settled launcher", () => {
    const nodes = groupEpicRunIterationThreads({
      threads: [iterationThread(0), iterationThread(1), thread("launcher")],
      runs: [{ ...run, originThreadId: "launcher" }],
      isThreadSettled: settledPredicate(new Set([iterationThread(1).id, "launcher"])),
    });

    expect(nodeIds(nodes)).toEqual([`group:${runId}`, "launcher"]);
    expect(nodes[0]).toMatchObject({ kind: "epic-run", nestedUnderThreadId: null });
  });

  it("nests a group with an unsettled iteration under an active launcher", () => {
    const nodes = groupEpicRunIterationThreads({
      threads: [thread("launcher"), iterationThread(0), iterationThread(1)],
      runs: [{ ...run, originThreadId: "launcher" }],
      isThreadSettled: settledPredicate(new Set([iterationThread(1).id])),
    });

    expect(nodeIds(nodes)).toEqual(["launcher", `group:${runId}`]);
    expect(nodes[1]).toMatchObject({ kind: "epic-run", nestedUnderThreadId: "launcher" });
  });

  it("nests an all-settled group under a settled launcher", () => {
    const nodes = groupEpicRunIterationThreads({
      threads: [thread("launcher"), iterationThread(0), iterationThread(1)],
      runs: [{ ...run, originThreadId: "launcher" }],
      isThreadSettled: settledPredicate(
        new Set(["launcher", iterationThread(0).id, iterationThread(1).id]),
      ),
    });

    expect(nodeIds(nodes)).toEqual(["launcher", `group:${runId}`]);
    expect(nodes[1]).toMatchObject({ kind: "epic-run", nestedUnderThreadId: "launcher" });
  });

  // The shape the live sidebar actually shows: several runs a shell script
  // launched with no origin, plus one an in-thread skill launched from a chat
  // that is older than every iteration it produced. Recency puts all four
  // groups above the launcher; only the one with an origin may leave that slot.
  // Reported as "epic runs render beside the thread that launched them" — the
  // origin-less ones do, and must keep doing so.
  it("moves only the origin-bearing run below an older launcher", () => {
    const chainedRunId = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
    const chained = (index: number) =>
      thread(epicRunIterationThreadId({ runId: chainedRunId, iterationIndex: index }));
    const nodes = groupEpicRunIterationThreads({
      threads: [chained(1), chained(0), iterationThread(1), iterationThread(0), thread("launcher")],
      runs: [
        { ...run, runId: chainedRunId, threadRefs: [] },
        { ...run, status: "done" as const, originThreadId: "launcher" },
      ],
      isThreadSettled: settledPredicate(new Set()),
    });

    expect(nodeIds(nodes)).toEqual([`group:${chainedRunId}`, "launcher", `group:${runId}`]);
    expect(nodes[0]).toMatchObject({ kind: "epic-run", nestedUnderThreadId: null });
    expect(nodes[2]).toMatchObject({ kind: "epic-run", nestedUnderThreadId: "launcher" });
  });

  // The v1 sidebar has no settled boundary and calls without the predicate:
  // nesting stays unconditional there.
  it("always nests when no settled predicate is given", () => {
    const nodes = groupEpicRunIterationThreads({
      threads: [thread("launcher"), iterationThread(0), iterationThread(1)],
      runs: [{ ...run, originThreadId: "launcher" }],
    });

    expect(nodeIds(nodes)).toEqual(["launcher", `group:${runId}`]);
    expect(nodes[1]).toMatchObject({ kind: "epic-run", nestedUnderThreadId: "launcher" });
  });
});

describe("resolveSidebarThreadSettleBatch", () => {
  type BatchThread = { readonly id: string; readonly environmentId: string };
  const keyOf = (thread: BatchThread) => `${thread.environmentId}:${thread.id}`;
  const thread = (id: string, environmentId = "env-a"): BatchThread => ({ id, environmentId });
  const run = (runId: string, originThreadId: string) => ({ runId, originThreadId });
  const iteration = (runId: string, iterationIndex: number, environmentId = "env-a") =>
    thread(epicRunIterationThreadId({ runId, iterationIndex }), environmentId);

  it("includes hidden iterations from every linked run and skips settled duplicates", () => {
    const launcher = thread("launcher");
    const first = iteration("run-1", 0);
    const settled = iteration("run-1", 1);
    const secondRunIteration = iteration("run-2", 0);

    const batch = resolveSidebarThreadSettleBatch({
      primary: launcher,
      // The resolver receives live scoped shells before hidden-run filtering.
      threads: [launcher, first, settled, first, secondRunIteration],
      runs: [run("run-1", launcher.id), run("run-2", launcher.id)],
      settledThreadKeys: new Set([keyOf(settled)]),
      getThreadKey: keyOf,
    });

    expect(batch.map(keyOf)).toEqual([keyOf(launcher), keyOf(first), keyOf(secondRunIteration)]);
  });

  it("does not pull a same-id launcher group from another environment", () => {
    const launcher = thread("launcher", "env-a");
    const localIteration = iteration("local-run", 0, "env-a");
    const remoteIteration = iteration("remote-run", 0, "env-b");

    const batch = resolveSidebarThreadSettleBatch({
      primary: launcher,
      threads: [launcher, localIteration, remoteIteration],
      runs: [run("local-run", launcher.id), run("remote-run", launcher.id)],
      settledThreadKeys: new Set(),
      getThreadKey: keyOf,
    });

    expect(batch.map(keyOf)).toEqual([keyOf(launcher), keyOf(localIteration)]);
  });
});

describe("settleSidebarThreadBatch", () => {
  const success = { _tag: "Success" as const };
  const failure = (id: string) => ({ _tag: "Failure" as const, id });
  const keyOf = (entry: { readonly key: string }) => entry.key;

  it("reserves the full owned batch, preserves foreign reservations, and releases its own", async () => {
    const entries = [{ key: "launcher" }, { key: "foreign" }, { key: "child" }];
    const reserved = new Set(["foreign"]);
    const reservationsDuringSettle: string[][] = [];
    const settle = vi.fn(async () => {
      reservationsDuringSettle.push([...reserved].toSorted());
      return success;
    });

    const outcome = await settleSidebarThreadBatch({
      entries,
      getThreadKey: keyOf,
      reservedThreadKeys: reserved,
      settle,
      onFailure: vi.fn(),
    });

    expect(settle).toHaveBeenCalledTimes(2);
    expect(reservationsDuringSettle).toEqual([
      ["child", "foreign", "launcher"],
      ["child", "foreign", "launcher"],
    ]);
    expect(reserved).toEqual(new Set(["foreign"]));
    expect(outcome).toEqual({ primaryResult: success, skipped: false });
  });

  it("continues after failures and returns the primary failure for navigation", async () => {
    const entries = [{ key: "launcher" }, { key: "child-1" }, { key: "child-2" }];
    const reserved = new Set<string>();
    const failures: string[] = [];
    const settle = vi.fn(async (entry: (typeof entries)[number]) =>
      entry.key === "child-1" ? success : failure(entry.key),
    );

    const outcome = await settleSidebarThreadBatch({
      entries,
      getThreadKey: keyOf,
      reservedThreadKeys: reserved,
      settle,
      onFailure: (result) => failures.push(result.id),
    });

    expect(settle).toHaveBeenCalledTimes(3);
    expect(failures).toEqual(["launcher", "child-2"]);
    expect(outcome).toEqual({ primaryResult: failure("launcher"), skipped: false });
    expect(reserved.size).toBe(0);
  });

  it("does not dispatch when another invocation owns the primary", async () => {
    const settle = vi.fn(async () => success);

    const outcome = await settleSidebarThreadBatch({
      entries: [{ key: "launcher" }, { key: "child" }],
      getThreadKey: keyOf,
      reservedThreadKeys: new Set(["launcher"]),
      settle,
      onFailure: vi.fn(),
    });

    expect(settle).not.toHaveBeenCalled();
    expect(outcome).toEqual({ primaryResult: null, skipped: true });
  });
});

describe("excludeSubagentChildThreads", () => {
  it("drops a thread-backed subagent's child thread and keeps its parent", () => {
    const parent = { id: "parent-thread", parentThreadId: null };
    const child = { id: "subagent-child-thread", parentThreadId: "parent-thread" };
    const unrelated = { id: "other-thread", parentThreadId: null };

    expect(excludeSubagentChildThreads([parent, child, unrelated])).toEqual([parent, unrelated]);
  });

  it("keeps an epic run iteration, which carries no parent thread", () => {
    const iteration = {
      id: epicRunIterationThreadId({
        runId: "0c5a1f4e-9b7d-4a2c-8f31-6d0e2b7a4c19",
        iterationIndex: 0,
      }),
      parentThreadId: null,
    };

    expect(excludeSubagentChildThreads([iteration])).toEqual([iteration]);
  });
});

describe("filterHiddenEpicRunIterationThreads", () => {
  const hiddenRunId = "0c5a1f4e-9b7d-4a2c-8f31-6d0e2b7a4c19";
  const visibleRunId = "9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d";
  const iteration = (runId: string, iterationIndex: number) => ({
    id: epicRunIterationThreadId({ runId, iterationIndex }),
  });

  it("removes every iteration of a hidden run before sidebar derivation", () => {
    const ordinary = { id: "ordinary-thread" };
    const visibleIteration = iteration(visibleRunId, 0);

    expect(
      filterHiddenEpicRunIterationThreads({
        threads: [iteration(hiddenRunId, 0), ordinary, visibleIteration, iteration(hiddenRunId, 1)],
        hiddenByRunId: { [hiddenRunId]: true },
      }),
    ).toEqual([ordinary, visibleIteration]);
  });

  it("keeps all threads when no matching run is hidden", () => {
    const threads = [{ id: "ordinary-thread" }, iteration(visibleRunId, 0)];

    expect(
      filterHiddenEpicRunIterationThreads({
        threads,
        hiddenByRunId: { [hiddenRunId]: true, [visibleRunId]: false },
      }),
    ).toEqual(threads);
  });
});

describe("epic run group row rendering decisions", () => {
  it("expands a running run and collapses one that ended", () => {
    expect(resolveEpicRunGroupExpanded({ status: "running" })).toBe(true);
    expect(resolveEpicRunGroupExpanded({ status: "done" })).toBe(false);
    expect(resolveEpicRunGroupExpanded({ status: "failed" })).toBe(false);
    // No run read model yet: nothing says the run is live, so stay collapsed.
    expect(resolveEpicRunGroupExpanded({ status: null })).toBe(false);
  });

  // The user's toggle outlives the run: a group opened to read must not snap
  // shut when the last iteration lands and the status default flips.
  it("lets an explicit toggle override the status default either way", () => {
    expect(resolveEpicRunGroupExpanded({ status: "running", override: false })).toBe(false);
    expect(resolveEpicRunGroupExpanded({ status: "done", override: true })).toBe(true);
  });

  // Collapsing the group you are reading inside would hide the open chat.
  it("forces the group holding the active thread open, toggle or not", () => {
    expect(
      resolveEpicRunGroupExpanded({ status: "done", override: false, forceExpanded: true }),
    ).toBe(true);
  });

  it("labels the run by epic id, falling back before the read model arrives", () => {
    expect(epicRunGroupTitle({ epicId: "t3code-ypi" })).toBe("t3code-ypi");
    expect(epicRunGroupTitle({ epicId: null })).toBe("Epic run");
  });

  it("counts iterations in singular and plural", () => {
    expect(epicRunIterationCountLabel(1)).toBe("1 iteration");
    expect(epicRunIterationCountLabel(50)).toBe("50 iterations");
  });

  // 1-based for humans, matching the runner's own thread titles.
  it("labels an iteration by its 1-based number and issue", () => {
    expect(epicRunIterationLabel({ iterationIndex: 2, issueId: "t3code-ypi.2" })).toBe(
      "iteration 3 · t3code-ypi.2",
    );
    expect(epicRunIterationLabel({ iterationIndex: 0, issueId: null })).toBe("iteration 1");
  });

  it("has a status pill for every run status, and none before the run loads", () => {
    for (const status of ["running", "paused", "done", "failed", "cancelled"] as const) {
      expect(resolveEpicRunStatusPill(status)?.label.length).toBeGreaterThan(0);
    }
    expect(resolveEpicRunStatusPill("running")?.pulse).toBe(true);
    expect(resolveEpicRunStatusPill("done")?.pulse).toBe(false);
    expect(resolveEpicRunStatusPill(null)).toBeNull();
  });
});

// A bare `proga-webapp-0iy` row says only which project is busy. These helpers
// are what turn it into 'Rebuild the epics page' with the key underneath.
describe("epic run rows carry human titles", () => {
  const runId = "0c5a1f4e-9b7d-4a2c-8f31-6d0e2b7a4c19";
  const run = {
    runId,
    epicId: "t3code-ypi",
    cwd: "/repo",
    status: "running" as const,
    originThreadId: null,
    threadRefs: [
      {
        threadId: epicRunIterationThreadId({ runId, iterationIndex: 0 }),
        issueId: "t3code-ypi.1",
        iterationIndex: 0,
      },
    ],
  };
  const snapshot = (
    epics: ReadonlyArray<{ id: string; title: string }>,
    issues: ReadonlyArray<{ id: string; title: string }> = [],
  ) => ({ _tag: "available", epics, issues }) as never;

  it("subscribes once per workspace that has a run, not once per project", () => {
    const sources = sidebarEpicRunBeadsSources(
      new Map([
        ["env-a", [run, { ...run, runId: "run-2" }, { ...run, runId: "run-3", cwd: "/other" }]],
        ["env-b", [{ ...run, runId: "run-4" }]],
        ["env-c", null],
      ]),
    );

    expect(sources).toEqual([
      { environmentId: "env-a", workspaceRoot: "/repo" },
      { environmentId: "env-a", workspaceRoot: "/other" },
      { environmentId: "env-b", workspaceRoot: "/repo" },
    ]);
  });

  // A bd id is only unique inside one workspace, so two checkouts with the same
  // id must not swap titles.
  it("joins each run to the snapshot of the workspace it ran in", () => {
    const titles = sidebarEpicRunTitlesByRunId({
      runsByEnvironment: new Map([["env-a", [run, { ...run, runId: "run-2", cwd: "/other" }]]]),
      snapshots: [
        {
          environmentId: "env-a",
          workspaceRoot: "/repo",
          result: snapshot(
            [{ id: "t3code-ypi", title: "Rebuild the epics page" }],
            [{ id: "t3code-ypi.1", title: "Widen the run projection" }],
          ),
        },
        {
          environmentId: "env-a",
          workspaceRoot: "/other",
          result: snapshot([{ id: "t3code-ypi", title: "A different epic entirely" }]),
        },
      ],
    });

    expect(titles.get(runId)?.epicTitle).toBe("Rebuild the epics page");
    expect(titles.get(runId)?.issueTitleById.get("t3code-ypi.1")).toBe("Widen the run projection");
    expect(titles.get("run-2")?.epicTitle).toBe("A different epic entirely");
  });

  it("has no titles while a snapshot is loading or unavailable", () => {
    const titles = sidebarEpicRunTitlesByRunId({
      runsByEnvironment: new Map([["env-a", [run]]]),
      snapshots: [
        { environmentId: "env-a", workspaceRoot: "/repo", result: null },
        {
          environmentId: "env-a",
          workspaceRoot: "/repo",
          result: { _tag: "unavailable" } as never,
        },
      ],
    });

    expect(titles.size).toBe(0);
  });

  it("puts the titles on the group and its iterations", () => {
    const nodes = groupEpicRunIterationThreads({
      threads: [{ id: epicRunIterationThreadId({ runId, iterationIndex: 0 }) }],
      runs: [run],
      titlesByRunId: new Map([
        [
          runId,
          {
            epicTitle: "Rebuild the epics page",
            issueTitleById: new Map([["t3code-ypi.1", "Widen the run projection"]]),
          },
        ],
      ]),
    });

    expect(nodes[0]).toMatchObject({
      kind: "epic-run",
      epicTitle: "Rebuild the epics page",
      iterations: [{ issueTitle: "Widen the run projection" }],
    });
  });

  it("leaves the titles null when no snapshot was passed", () => {
    const nodes = groupEpicRunIterationThreads({
      threads: [{ id: epicRunIterationThreadId({ runId, iterationIndex: 0 }) }],
      runs: [run],
    });

    expect(nodes[0]).toMatchObject({
      kind: "epic-run",
      epicTitle: null,
      iterations: [{ issueTitle: null }],
    });
  });

  it("leads with the title and drops the key beneath it", () => {
    expect(
      epicRunGroupRowLabel({ epicId: "t3code-ypi", epicTitle: "Rebuild the epics page" }),
    ).toEqual({
      primary: "Rebuild the epics page",
      secondary: "t3code-ypi",
      full: "Rebuild the epics page",
    });
    expect(
      epicRunIterationRowLabel({
        iterationIndex: 0,
        issueId: "t3code-ypi.1",
        issueTitle: "Widen the run projection",
      }),
    ).toEqual({
      primary: "Widen the run projection",
      secondary: "iteration 1 · t3code-ypi.1",
      full: "Widen the run projection",
    });
  });

  // No snapshot yet, or a title that is blank: the key takes the primary line
  // on its own. A blank primary line would read as a broken row.
  it("falls back to the key alone, never to a blank line", () => {
    expect(epicRunGroupRowLabel({ epicId: "t3code-ypi", epicTitle: null })).toEqual({
      primary: "t3code-ypi",
      secondary: null,
      full: "t3code-ypi",
    });
    expect(epicRunGroupRowLabel({ epicId: "t3code-ypi", epicTitle: "   " })).toEqual({
      primary: "t3code-ypi",
      secondary: null,
      full: "t3code-ypi",
    });
    expect(epicRunGroupRowLabel({ epicId: null, epicTitle: null })).toEqual({
      primary: "Epic run",
      secondary: null,
      full: "Epic run",
    });
    expect(
      epicRunIterationRowLabel({ iterationIndex: 2, issueId: "t3code-ypi.3", issueTitle: null }),
    ).toEqual({
      primary: "iteration 3 · t3code-ypi.3",
      secondary: null,
      full: "iteration 3 · t3code-ypi.3",
    });
  });

  // Epic and issue titles here follow an "area - phase: specific thing"
  // shape. The row shows only the specific thing; the full title survives in
  // the tooltip via `full`, and the key/issue-id line still disambiguates
  // two epics whose specific thing collides.
  it("drops the leading qualifier segment from the row but keeps it in the tooltip", () => {
    expect(
      epicRunGroupRowLabel({
        epicId: "proga-webapp-0iy",
        epicTitle: "Invitation editor v2 - post-jl4 fixes: adjust the RSVP banner copy",
      }),
    ).toEqual({
      primary: "adjust the RSVP banner copy",
      secondary: "proga-webapp-0iy",
      full: "Invitation editor v2 - post-jl4 fixes: adjust the RSVP banner copy",
    });
  });

  describe("specificTitle", () => {
    // No ':' at all: nothing to drop, the title renders unchanged.
    it("returns the title unchanged when it has no colon", () => {
      expect(specificTitle("Epic detail page cannot start a second run")).toBe(
        "Epic detail page cannot start a second run",
      );
    });

    // Split on the FIRST ':', not the last — a last-colon split would wrongly
    // leave only "the Y case" instead of the whole intended tail.
    it("splits on the first colon, not the last", () => {
      expect(specificTitle("fixes: fix X: the Y case")).toBe("fix X: the Y case");
    });

    // A blank or whitespace-only tail is not useful on its own, so the full
    // title survives rather than rendering an empty row.
    it("falls back to the full title when the tail is empty or blank", () => {
      expect(specificTitle("Invitation editor v2 - post-jl4 fixes:")).toBe(
        "Invitation editor v2 - post-jl4 fixes:",
      );
      expect(specificTitle("Invitation editor v2 - post-jl4 fixes:   ")).toBe(
        "Invitation editor v2 - post-jl4 fixes:   ",
      );
    });

    // A short tail like "ok" reads as content-free without its prefix, so it
    // is not worth stripping.
    it("falls back to the full title when the tail is too short to stand alone", () => {
      expect(specificTitle("X: ok")).toBe("X: ok");
    });

    // A tail right at the minimum length is still trusted.
    it("keeps a tail that clears the minimum length", () => {
      expect(specificTitle("QA: fix the bug")).toBe("fix the bug");
    });
  });
});

describe("keyboard and prewarm reach into collapsed run groups", () => {
  const runId = "5b8f2c10-3d47-4e9a-9c25-71af6b0d8e43";
  const otherRunId = "9d1c4a72-6e30-4b58-8a17-2f5be9c03d61";
  const iterationThreadId = (index: number, id = runId) =>
    epicRunIterationThreadId({ runId: id, iterationIndex: index });
  const thread = (id: string) => ({ id });
  const endedRun = {
    runId,
    epicId: "t3code-ypi",
    cwd: "/repo",
    status: "done" as const,
    originThreadId: null,
    threadRefs: [0, 1, 2].map((iterationIndex) => ({
      threadId: iterationThreadId(iterationIndex),
      issueId: `t3code-ypi.${iterationIndex + 1}`,
      iterationIndex,
    })),
  };
  const threads = [
    thread("chat-newest"),
    thread(iterationThreadId(0)),
    thread(iterationThreadId(1)),
    thread(iterationThreadId(2)),
    thread("chat-older"),
  ];
  const nodes = groupEpicRunIterationThreads({ threads, runs: [endedRun] });
  const getThreadId = (item: { id: string }) => item.id;
  const collapsed = () => false;

  it("paints one row for a collapsed run and one per iteration when expanded", () => {
    expect(
      sidebarRenderedThreadIds({ nodes, getThreadId, isEpicRunGroupExpanded: collapsed }),
    ).toEqual(["chat-newest", "chat-older"]);
    expect(
      sidebarRenderedThreadIds({ nodes, getThreadId, isEpicRunGroupExpanded: () => true }),
    ).toEqual([
      "chat-newest",
      iterationThreadId(0),
      iterationThreadId(1),
      iterationThreadId(2),
      "chat-older",
    ]);
  });

  // The decision: previous/next steps INTO a folded run. A group row is not a
  // thread, so skipping it would leave a finished run's iterations with no
  // keyboard route at all.
  it("steps arrow traversal through a collapsed run's iterations, in paint order", () => {
    const traversal = sidebarTraversalThreadIds({ nodes, getThreadId });
    expect(traversal).toEqual([
      "chat-newest",
      iterationThreadId(0),
      iterationThreadId(1),
      iterationThreadId(2),
      "chat-older",
    ]);

    expect(
      resolveAdjacentThreadId({
        threadIds: traversal,
        currentThreadId: "chat-newest",
        direction: "next",
      }),
    ).toBe(iterationThreadId(0));
    expect(
      resolveAdjacentThreadId({
        threadIds: traversal,
        currentThreadId: "chat-older",
        direction: "previous",
      }),
    ).toBe(iterationThreadId(2));
  });

  // Search (the command palette) navigates straight to an iteration thread.
  // Force-expand is what makes that match visible instead of landing the user
  // on a row folded inside a collapsed group.
  it("force-expands the group holding the active thread, so a search match is on screen", () => {
    const isEpicRunGroupExpanded = createEpicRunGroupExpandedResolver<{ id: string }>({
      expandedByRunId: {},
      activeThreadKey: iterationThreadId(1),
      getThreadKey: getThreadId,
    });

    expect(sidebarRenderedThreadIds({ nodes, getThreadId, isEpicRunGroupExpanded })).toEqual([
      "chat-newest",
      iterationThreadId(0),
      iterationThreadId(1),
      iterationThreadId(2),
      "chat-older",
    ]);
  });

  it("keeps the status default and the explicit toggle when no group holds the active thread", () => {
    const runningGroup = groupEpicRunIterationThreads({
      threads: [thread(iterationThreadId(0, otherRunId))],
      runs: [{ ...endedRun, runId: otherRunId, status: "running", threadRefs: [] }],
    })[0];
    const isEpicRunGroupExpanded = createEpicRunGroupExpandedResolver<{ id: string }>({
      expandedByRunId: { [runId]: true },
      activeThreadKey: "chat-newest",
      getThreadKey: getThreadId,
    });

    // Running: open by default. Ended but toggled open: stays open.
    expect(runningGroup?.kind === "epic-run" && isEpicRunGroupExpanded(runningGroup)).toBe(true);
    expect(sidebarRenderedThreadIds({ nodes, getThreadId, isEpicRunGroupExpanded }).length).toBe(5);
  });

  // A collapsed 50-iteration run used to eat the whole prewarm budget on rows
  // nobody can see, and all nine jump numbers with it.
  it("spends prewarm and jump numbers on the rows on screen", () => {
    const longRun = {
      ...endedRun,
      threadRefs: [],
    };
    const manyIterations = [
      thread("chat-newest"),
      ...Array.from({ length: 50 }, (_, index) => thread(iterationThreadId(index))),
      thread("chat-older"),
    ];
    const visible = sidebarRenderedThreadIds({
      nodes: groupEpicRunIterationThreads({ threads: manyIterations, runs: [longRun] }),
      getThreadId,
      isEpicRunGroupExpanded: collapsed,
    });

    expect(visible).toEqual(["chat-newest", "chat-older"]);
    expect(getSidebarThreadIdsToPrewarm(visible)).toEqual(["chat-newest", "chat-older"]);
  });
});

describe("resolveRenderedSidebarThreadNodes", () => {
  const runId = "3f6b9d24-8c15-4a70-b3e8-5d297fa10c6b";
  const iterationThreadId = (index: number) =>
    epicRunIterationThreadId({ runId, iterationIndex: index });
  const run = {
    runId,
    epicId: "t3code-ypi",
    cwd: "/repo",
    status: "done" as const,
    originThreadId: null,
    threadRefs: [],
  };
  const threads = [
    { id: "chat-1" },
    { id: iterationThreadId(0) },
    { id: iterationThreadId(1) },
    { id: iterationThreadId(2) },
    { id: "chat-2" },
    { id: "chat-3" },
  ];

  // The whole point of folding before the limit: a long run costs one row of
  // the preview budget, not the entire budget.
  it("spends one preview slot on a run, whatever its iteration count", () => {
    const { hasOverflowingThreads, nodes } = resolveRenderedSidebarThreadNodes({
      threads,
      runs: [run],
      previewCount: 3,
      isThreadListExpanded: false,
      pinnedThreadId: null,
    });

    expect(hasOverflowingThreads).toBe(true);
    expect(nodes.map((node) => (node.kind === "thread" ? node.thread.id : node.runId))).toEqual([
      "chat-1",
      runId,
      "chat-2",
    ]);
  });

  it("drops the limit once the thread list is expanded", () => {
    const { nodes } = resolveRenderedSidebarThreadNodes({
      threads,
      runs: [run],
      previewCount: 3,
      isThreadListExpanded: true,
      pinnedThreadId: null,
    });

    expect(nodes).toHaveLength(4);
  });

  // A collapsed project keeps the active row. When that row is an iteration,
  // the whole run node stands in for it: a bare iteration row with no group
  // above it would read as an orphan.
  it("keeps the run node when a collapsed project pins an iteration", () => {
    const { nodes } = resolveRenderedSidebarThreadNodes({
      threads,
      runs: [run],
      previewCount: 3,
      isThreadListExpanded: false,
      pinnedThreadId: iterationThreadId(1),
    });

    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({ kind: "epic-run", runId });
  });
});

describe("resolveThreadStatusPill", () => {
  const baseThread = {
    hasActionableProposedPlan: false,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    interactionMode: "plan" as const,
    latestTurn: null,
    lastVisitedAt: undefined,
    session: {
      threadId: ThreadId.make("thread-1"),
      status: "running" as const,
      providerName: "Codex",
      providerInstanceId: ProviderInstanceId.make("codex"),
      runtimeMode: DEFAULT_RUNTIME_MODE,
      activeTurnId: "turn-1" as never,
      lastError: null,
      updatedAt: "2026-03-09T10:00:00.000Z",
    },
  };

  it("shows pending approval before all other statuses", () => {
    expect(
      resolveThreadStatusPill({
        thread: {
          ...baseThread,
          hasPendingApprovals: true,
          hasPendingUserInput: true,
        },
      }),
    ).toMatchObject({ label: "Pending Approval", pulse: false });
  });

  it("shows awaiting input when plan mode is blocked on user answers", () => {
    expect(
      resolveThreadStatusPill({
        thread: {
          ...baseThread,
          hasPendingUserInput: true,
        },
      }),
    ).toMatchObject({ label: "Awaiting Input", pulse: false });
  });

  it("falls back to working when the thread is actively running without blockers", () => {
    expect(
      resolveThreadStatusPill({
        thread: baseThread,
      }),
    ).toMatchObject({ label: "Working", pulse: true });
  });

  it("shows a detached active run before provider session activity", () => {
    expect(
      resolveThreadStatusPill({
        runActive: true,
        thread: {
          ...baseThread,
          session: { ...baseThread.session, status: "stopped", activeTurnId: null },
        },
      }),
    ).toMatchObject({ label: "Run active", pulse: true, dotClass: "bg-success" });
  });

  it("keeps pending approval ahead of an active run", () => {
    expect(
      resolveThreadStatusPill({
        runActive: true,
        thread: { ...baseThread, hasPendingApprovals: true },
      }),
    ).toMatchObject({ label: "Pending Approval" });
  });

  it("shows plan ready when a settled plan turn has a proposed plan ready for follow-up", () => {
    expect(
      resolveThreadStatusPill({
        thread: {
          ...baseThread,
          hasActionableProposedPlan: true,
          latestTurn: makeLatestTurn(),
          session: {
            ...baseThread.session,
            status: "ready",
            activeTurnId: null,
          },
        },
      }),
    ).toMatchObject({ label: "Plan Ready", pulse: false });
  });

  it("does not manufacture completed state without a client visit marker", () => {
    expect(
      resolveThreadStatusPill({
        thread: {
          ...baseThread,
          latestTurn: makeLatestTurn(),
          session: {
            ...baseThread.session,
            status: "ready",
            activeTurnId: null,
          },
        },
      }),
    ).toBeNull();
  });

  it("shows completed when there is an unseen completion and no active blocker", () => {
    expect(
      resolveThreadStatusPill({
        thread: {
          ...baseThread,
          interactionMode: "default",
          latestTurn: makeLatestTurn(),
          lastVisitedAt: "2026-03-09T10:04:00.000Z",
          session: {
            ...baseThread.session,
            status: "ready",
            activeTurnId: null,
          },
        },
      }),
    ).toMatchObject({ label: "Completed", pulse: false });
  });

  it("shows a pulsing subagent pill with the count when the parent is idle but children run", () => {
    expect(
      resolveThreadStatusPill({
        thread: {
          ...baseThread,
          activeSubagentCount: 3,
          session: { ...baseThread.session, status: "ready", activeTurnId: null },
        },
      }),
    ).toMatchObject({ label: "Subagents", count: 3, pulse: true });
  });

  it("keeps working ahead of subagents while the parent session runs", () => {
    expect(
      resolveThreadStatusPill({
        thread: { ...baseThread, activeSubagentCount: 2 },
      }),
    ).toMatchObject({ label: "Working" });
  });

  it("prefers subagents over plan-ready and unseen completion", () => {
    expect(
      resolveThreadStatusPill({
        thread: {
          ...baseThread,
          activeSubagentCount: 1,
          hasActionableProposedPlan: true,
          interactionMode: "default",
          latestTurn: makeLatestTurn(),
          lastVisitedAt: "2026-03-09T10:04:00.000Z",
          session: { ...baseThread.session, status: "ready", activeTurnId: null },
        },
      }),
    ).toMatchObject({ label: "Subagents", count: 1 });
  });
});

describe("threadStatusPillText", () => {
  it("appends the count only when present", () => {
    expect(
      threadStatusPillText({
        label: "Subagents",
        count: 4,
        colorClass: "",
        dotClass: "",
        pulse: true,
      }),
    ).toBe("Subagents (4)");
    expect(
      threadStatusPillText({ label: "Working", colorClass: "", dotClass: "", pulse: true }),
    ).toBe("Working");
  });
});

describe("resolveThreadRowClassName", () => {
  it("uses the darker selected palette when a thread is both selected and active", () => {
    const className = resolveThreadRowClassName({ isActive: true, isSelected: true });
    expect(className).toContain("bg-primary/22");
    expect(className).toContain("hover:bg-primary/26");
    expect(className).toContain("dark:bg-primary/30");
    expect(className).not.toContain("bg-accent/85");
  });

  it("uses selected hover colors for selected threads", () => {
    const className = resolveThreadRowClassName({ isActive: false, isSelected: true });
    expect(className).toContain("bg-primary/15");
    expect(className).toContain("hover:bg-primary/19");
    expect(className).toContain("dark:bg-primary/22");
    expect(className).not.toContain("hover:bg-accent");
  });

  it("keeps the accent palette for active-only threads", () => {
    const className = resolveThreadRowClassName({ isActive: true, isSelected: false });
    expect(className).toContain("bg-accent/85");
    expect(className).toContain("hover:bg-accent");
  });
});

describe("resolveProjectStatusIndicator", () => {
  it("returns null when no threads have a notable status", () => {
    expect(resolveProjectStatusIndicator([null, null])).toBeNull();
  });

  it("surfaces the highest-priority actionable state across project threads", () => {
    expect(
      resolveProjectStatusIndicator([
        {
          label: "Completed",
          colorClass: "text-emerald-600",
          dotClass: "bg-emerald-500",
          pulse: false,
        },
        {
          label: "Pending Approval",
          colorClass: "text-amber-600",
          dotClass: "bg-amber-500",
          pulse: false,
        },
        {
          label: "Working",
          colorClass: "text-sky-600",
          dotClass: "bg-sky-500",
          pulse: true,
        },
      ]),
    ).toMatchObject({ label: "Pending Approval", dotClass: "bg-amber-500" });
  });

  it("prefers plan-ready over completed when no stronger action is needed", () => {
    expect(
      resolveProjectStatusIndicator([
        {
          label: "Completed",
          colorClass: "text-emerald-600",
          dotClass: "bg-emerald-500",
          pulse: false,
        },
        {
          label: "Plan Ready",
          colorClass: "text-violet-600",
          dotClass: "bg-violet-500",
          pulse: false,
        },
      ]),
    ).toMatchObject({ label: "Plan Ready", dotClass: "bg-violet-500" });
  });

  it("ranks subagents below working but above plan-ready", () => {
    const subagents = {
      label: "Subagents" as const,
      count: 2,
      colorClass: "text-sky-600",
      dotClass: "bg-sky-500",
      pulse: true,
    };
    expect(
      resolveProjectStatusIndicator([
        subagents,
        { label: "Working", colorClass: "text-sky-600", dotClass: "bg-sky-500", pulse: true },
      ]),
    ).toMatchObject({ label: "Working" });
    expect(
      resolveProjectStatusIndicator([
        {
          label: "Plan Ready",
          colorClass: "text-violet-600",
          dotClass: "bg-violet-500",
          pulse: false,
        },
        subagents,
      ]),
    ).toMatchObject({ label: "Subagents", count: 2 });
  });
});

describe("getVisibleThreadsForProject", () => {
  it("includes the active thread even when it falls below the folded preview", () => {
    const threads = Array.from({ length: 8 }, (_, index) =>
      makeThread({
        id: ThreadId.make(`thread-${index + 1}`),
        title: `Thread ${index + 1}`,
      }),
    );

    const result = getVisibleThreadsForProject({
      threads,
      activeThreadId: ThreadId.make("thread-8"),
      isThreadListExpanded: false,
      previewLimit: 6,
    });

    expect(result.hasHiddenThreads).toBe(true);
    expect(result.visibleThreads.map((thread) => thread.id)).toEqual([
      ThreadId.make("thread-1"),
      ThreadId.make("thread-2"),
      ThreadId.make("thread-3"),
      ThreadId.make("thread-4"),
      ThreadId.make("thread-5"),
      ThreadId.make("thread-6"),
      ThreadId.make("thread-8"),
    ]);
    expect(result.hiddenThreads.map((thread) => thread.id)).toEqual([ThreadId.make("thread-7")]);
  });

  it("returns all threads when the list is expanded", () => {
    const threads = Array.from({ length: 8 }, (_, index) =>
      makeThread({
        id: ThreadId.make(`thread-${index + 1}`),
      }),
    );

    const result = getVisibleThreadsForProject({
      threads,
      activeThreadId: ThreadId.make("thread-8"),
      isThreadListExpanded: true,
      previewLimit: 6,
    });

    expect(result.hasHiddenThreads).toBe(true);
    expect(result.visibleThreads.map((thread) => thread.id)).toEqual(
      threads.map((thread) => thread.id),
    );
    expect(result.hiddenThreads).toEqual([]);
  });
});

function makeProject(overrides: Partial<Project> = {}): Project {
  const { defaultModelSelection, ...rest } = overrides;
  return {
    id: ProjectId.make("project-1"),
    environmentId: localEnvironmentId,
    title: "Project",
    workspaceRoot: "/tmp/project",
    repositoryIdentity: null,
    defaultModelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.4",
      ...defaultModelSelection,
    },
    createdAt: "2026-03-09T10:00:00.000Z",
    updatedAt: "2026-03-09T10:00:00.000Z",
    scripts: [],
    ...rest,
  };
}

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: ThreadId.make("thread-1"),
    environmentId: localEnvironmentId,
    projectId: ProjectId.make("project-1"),
    title: "Thread",
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.4",
      ...overrides?.modelSelection,
    },
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_INTERACTION_MODE,
    session: null,
    messages: [],
    proposedPlans: [],
    subagents: [],
    createdAt: "2026-03-09T10:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    updatedAt: "2026-03-09T10:00:00.000Z",
    latestTurn: null,
    branch: null,
    worktreePath: null,
    checkpoints: [],
    activities: [],
    parentThreadId: null,
    ...overrides,
  };
}

describe("getFallbackThreadIdAfterDelete", () => {
  it("returns the top remaining thread in the deleted thread's project sidebar order", () => {
    const fallbackThreadId = getFallbackThreadIdAfterDelete({
      threads: [
        makeThread({
          id: ThreadId.make("thread-oldest"),
          projectId: ProjectId.make("project-1"),
          createdAt: "2026-03-09T10:00:00.000Z",
          messages: [],
        }),
        makeThread({
          id: ThreadId.make("thread-active"),
          projectId: ProjectId.make("project-1"),
          createdAt: "2026-03-09T10:05:00.000Z",
          messages: [],
        }),
        makeThread({
          id: ThreadId.make("thread-newest"),
          projectId: ProjectId.make("project-1"),
          createdAt: "2026-03-09T10:10:00.000Z",
          messages: [],
        }),
        makeThread({
          id: ThreadId.make("thread-other-project"),
          projectId: ProjectId.make("project-2"),
          createdAt: "2026-03-09T10:20:00.000Z",
          messages: [],
        }),
      ],
      deletedThreadId: ThreadId.make("thread-active"),
      sortOrder: "created_at",
    });

    expect(fallbackThreadId).toBe(ThreadId.make("thread-newest"));
  });

  it("skips other threads being deleted in the same action", () => {
    const fallbackThreadId = getFallbackThreadIdAfterDelete({
      threads: [
        makeThread({
          id: ThreadId.make("thread-active"),
          projectId: ProjectId.make("project-1"),
          createdAt: "2026-03-09T10:05:00.000Z",
          messages: [],
        }),
        makeThread({
          id: ThreadId.make("thread-newest"),
          projectId: ProjectId.make("project-1"),
          createdAt: "2026-03-09T10:10:00.000Z",
          messages: [],
        }),
        makeThread({
          id: ThreadId.make("thread-next"),
          projectId: ProjectId.make("project-1"),
          createdAt: "2026-03-09T10:07:00.000Z",
          messages: [],
        }),
      ],
      deletedThreadId: ThreadId.make("thread-active"),
      deletedThreadIds: new Set([ThreadId.make("thread-active"), ThreadId.make("thread-newest")]),
      sortOrder: "created_at",
    });

    expect(fallbackThreadId).toBe(ThreadId.make("thread-next"));
  });
});
describe("sortProjectsForSidebar", () => {
  it("sorts projects by the most recent user message across their threads", () => {
    const projects = [
      makeProject({ id: ProjectId.make("project-1"), title: "Older project" }),
      makeProject({ id: ProjectId.make("project-2"), title: "Newer project" }),
    ];
    const threads = [
      makeThread({
        projectId: ProjectId.make("project-1"),
        updatedAt: "2026-03-09T10:20:00.000Z",
        messages: [
          {
            id: "message-1" as never,
            role: "user",
            text: "older project user message",
            turnId: null,
            createdAt: "2026-03-09T10:01:00.000Z",
            updatedAt: "2026-03-09T10:01:00.000Z",
            streaming: false,
          },
        ],
      }),
      makeThread({
        id: ThreadId.make("thread-2"),
        projectId: ProjectId.make("project-2"),
        updatedAt: "2026-03-09T10:05:00.000Z",
        messages: [
          {
            id: "message-2" as never,
            role: "user",
            text: "newer project user message",
            turnId: null,
            createdAt: "2026-03-09T10:05:00.000Z",
            updatedAt: "2026-03-09T10:05:00.000Z",
            streaming: false,
          },
        ],
      }),
    ];

    const sorted = sortProjectsForSidebar(projects, threads, "updated_at");

    expect(sorted.map((project) => project.id)).toEqual([
      ProjectId.make("project-2"),
      ProjectId.make("project-1"),
    ]);
  });

  it("falls back to project timestamps when a project has no threads", () => {
    const sorted = sortProjectsForSidebar(
      [
        makeProject({
          id: ProjectId.make("project-1"),
          title: "Older project",
          updatedAt: "2026-03-09T10:01:00.000Z",
        }),
        makeProject({
          id: ProjectId.make("project-2"),
          title: "Newer project",
          updatedAt: "2026-03-09T10:05:00.000Z",
        }),
      ],
      [],
      "updated_at",
    );

    expect(sorted.map((project) => project.id)).toEqual([
      ProjectId.make("project-2"),
      ProjectId.make("project-1"),
    ]);
  });

  it("falls back to name and id ordering when projects have no sortable timestamps", () => {
    const sorted = sortProjectsForSidebar(
      [
        makeProject({
          id: ProjectId.make("project-2"),
          title: "Beta",
          createdAt: "invalid-created-at" as never,
          updatedAt: "invalid-updated-at" as never,
        }),
        makeProject({
          id: ProjectId.make("project-1"),
          title: "Alpha",
          createdAt: "invalid-created-at" as never,
          updatedAt: "invalid-updated-at" as never,
        }),
      ],
      [],
      "updated_at",
    );

    expect(sorted.map((project) => project.id)).toEqual([
      ProjectId.make("project-1"),
      ProjectId.make("project-2"),
    ]);
  });

  it("preserves manual project ordering", () => {
    const projects = [
      makeProject({ id: ProjectId.make("project-2"), title: "Second" }),
      makeProject({ id: ProjectId.make("project-1"), title: "First" }),
    ];

    const sorted = sortProjectsForSidebar(projects, [], "manual");

    expect(sorted.map((project) => project.id)).toEqual([
      ProjectId.make("project-2"),
      ProjectId.make("project-1"),
    ]);
  });

  it("ignores archived threads when sorting projects", () => {
    const sorted = sortProjectsForSidebar(
      [
        makeProject({
          id: ProjectId.make("project-1"),
          title: "Visible project",
          updatedAt: "2026-03-09T10:01:00.000Z",
        }),
        makeProject({
          id: ProjectId.make("project-2"),
          title: "Archived-only project",
          updatedAt: "2026-03-09T10:00:00.000Z",
        }),
      ],
      [
        makeThread({
          id: ThreadId.make("thread-visible"),
          projectId: ProjectId.make("project-1"),
          updatedAt: "2026-03-09T10:02:00.000Z",
          archivedAt: null,
        }),
        makeThread({
          id: ThreadId.make("thread-archived"),
          projectId: ProjectId.make("project-2"),
          updatedAt: "2026-03-09T10:10:00.000Z",
          archivedAt: "2026-03-09T10:11:00.000Z",
        }),
      ].filter((thread) => thread.archivedAt === null),
      "updated_at",
    );

    expect(sorted.map((project) => project.id)).toEqual([
      ProjectId.make("project-1"),
      ProjectId.make("project-2"),
    ]);
  });

  it("returns the project timestamp when no threads are present", () => {
    const timestamp = getProjectSortTimestamp(
      makeProject({ updatedAt: "2026-03-09T10:10:00.000Z" }),
      [],
      "updated_at",
    );

    expect(timestamp).toBe(Date.parse("2026-03-09T10:10:00.000Z"));
  });
});

describe("sortScopedProjectsForSidebar", () => {
  it("keeps identical project ids in different environments separate", () => {
    const remoteEnvironmentId = EnvironmentId.make("environment-remote");
    const sharedProjectId = ProjectId.make("shared-project");
    const projects = [
      makeProject({
        environmentId: localEnvironmentId,
        id: sharedProjectId,
        title: "Local project",
      }),
      makeProject({
        environmentId: remoteEnvironmentId,
        id: sharedProjectId,
        title: "Remote project",
      }),
    ];
    const threads = [
      makeThread({
        environmentId: localEnvironmentId,
        projectId: sharedProjectId,
        updatedAt: "2026-03-09T10:02:00.000Z",
      }),
      makeThread({
        environmentId: remoteEnvironmentId,
        projectId: sharedProjectId,
        updatedAt: "2026-03-09T10:10:00.000Z",
      }),
    ];

    const sorted = sortScopedProjectsForSidebar(projects, threads, "updated_at");

    expect(sorted.map((project) => project.title)).toEqual(["Remote project", "Local project"]);
  });

  it("does not use archived threads as project activity", () => {
    const projects = [
      makeProject({
        id: ProjectId.make("project-visible"),
        title: "Visible project",
        updatedAt: "2026-03-09T10:01:00.000Z",
      }),
      makeProject({
        id: ProjectId.make("project-archived"),
        title: "Archived-only project",
        updatedAt: "2026-03-09T10:00:00.000Z",
      }),
    ];
    const threads = [
      makeThread({
        id: ThreadId.make("thread-visible"),
        projectId: ProjectId.make("project-visible"),
        updatedAt: "2026-03-09T10:02:00.000Z",
      }),
      makeThread({
        id: ThreadId.make("thread-archived"),
        projectId: ProjectId.make("project-archived"),
        updatedAt: "2026-03-09T10:10:00.000Z",
        archivedAt: "2026-03-09T10:11:00.000Z",
      }),
    ];

    const sorted = sortScopedProjectsForSidebar(projects, threads, "updated_at");

    expect(sorted.map((project) => project.title)).toEqual([
      "Visible project",
      "Archived-only project",
    ]);
  });
});
