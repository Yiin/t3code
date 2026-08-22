import {
  EventId,
  MessageId,
  ThreadId,
  TurnId,
  type OrchestrationThreadActivity,
  type OrchestrationThreadSubagent,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildSubagentRoster } from "./components/chat/subagentRoster.logic";
import {
  deriveActiveWorkStartedAt,
  deriveActivePlanState,
  derivePendingApprovals,
  derivePendingUserInputs,
  deriveSubagentGroups,
  deriveTimelineEntries,
  deriveWorkLogEntries,
  extractSubagentResultText,
  findLatestProposedPlan,
  findSidebarProposedPlan,
  hasActionableProposedPlan,
  isLatestTurnSettled,
  selectSubagentSteerStates,
  workEntryIndicatesToolFailure,
  workEntryIndicatesToolNeutralStatus,
  workEntryIndicatesToolSuccess,
} from "./session-logic";

let nextActivityId = 0;

function makeActivity(overrides: {
  id?: string;
  createdAt?: string;
  kind?: string;
  summary?: string;
  tone?: OrchestrationThreadActivity["tone"];
  payload?: Record<string, unknown>;
  turnId?: string;
  sequence?: number;
}): OrchestrationThreadActivity {
  const payload = overrides.payload ?? {};
  return {
    id: EventId.make(overrides.id ?? `activity-${nextActivityId++}`),
    createdAt: overrides.createdAt ?? "2026-02-23T00:00:00.000Z",
    kind: overrides.kind ?? "tool.started",
    summary: overrides.summary ?? "Tool call",
    tone: overrides.tone ?? "tool",
    payload,
    turnId: overrides.turnId ? TurnId.make(overrides.turnId) : null,
    ...(overrides.sequence !== undefined ? { sequence: overrides.sequence } : {}),
  };
}

describe("selectSubagentSteerStates", () => {
  it("folds distinct steers and stop states even when terminal events arrive first", () => {
    const activities = [
      makeActivity({
        createdAt: "2026-08-06T00:00:04.000Z",
        kind: "subagent.steer.delivered",
        payload: { subagentId: "agent-1", steerId: "steer-1" },
      }),
      makeActivity({
        createdAt: "2026-08-06T00:00:01.000Z",
        kind: "subagent.steer.requested",
        payload: { subagentId: "agent-1", steerId: "steer-1", text: "Check the parser" },
      }),
      makeActivity({
        createdAt: "2026-08-06T00:00:02.000Z",
        kind: "subagent.steer.requested",
        payload: { subagentId: "agent-1", steerId: "steer-2", text: "Run its test" },
      }),
      makeActivity({
        createdAt: "2026-08-06T00:00:05.000Z",
        kind: "provider.subagent.steer.failed",
        payload: {
          subagentId: "agent-1",
          steerId: "steer-2",
          detail: "Parent session closed",
        },
      }),
      makeActivity({
        createdAt: "2026-08-06T00:00:08.000Z",
        kind: "subagent.stop.escalated",
        payload: { subagentId: "agent-1", stopId: "stop-1" },
      }),
      makeActivity({
        createdAt: "2026-08-06T00:00:06.000Z",
        kind: "subagent.stop.requested",
        payload: { subagentId: "agent-1", stopId: "stop-1" },
      }),
      makeActivity({
        kind: "subagent.steer.requested",
        payload: { subagentId: "agent-2", steerId: "other", text: "Ignore me" },
      }),
      makeActivity({
        kind: "subagent.steer.requested",
        payload: { subagentId: "agent-1", steerId: "invalid" },
      }),
    ];

    expect(selectSubagentSteerStates(activities, "agent-1")).toEqual({
      steers: [
        {
          steerId: "steer-1",
          text: "Check the parser",
          createdAt: "2026-08-06T00:00:01.000Z",
          status: "delivered",
          detail: null,
        },
        {
          steerId: "steer-2",
          text: "Run its test",
          createdAt: "2026-08-06T00:00:02.000Z",
          status: "failed",
          detail: "Parent session closed",
        },
      ],
      stops: [
        {
          stopId: "stop-1",
          createdAt: "2026-08-06T00:00:06.000Z",
          status: "escalated",
          detail: null,
        },
      ],
    });
  });

  it("folds stop failures", () => {
    const activities = [
      makeActivity({
        createdAt: "2026-08-06T00:00:01.000Z",
        kind: "subagent.stop.requested",
        payload: { subagentId: "agent-1", stopId: "stop-2" },
      }),
      makeActivity({
        createdAt: "2026-08-06T00:00:02.000Z",
        kind: "provider.subagent.stop.failed",
        payload: { subagentId: "agent-1", stopId: "stop-2", detail: "Stop failed" },
      }),
    ];

    expect(selectSubagentSteerStates(activities, "agent-1").stops).toEqual([
      {
        stopId: "stop-2",
        createdAt: "2026-08-06T00:00:01.000Z",
        status: "failed",
        detail: "Stop failed",
      },
    ]);
  });
});

describe("derivePendingApprovals", () => {
  it("tracks open approvals and removes resolved ones", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "approval-open",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "approval.requested",
        summary: "Command approval requested",
        tone: "approval",
        payload: {
          requestId: "req-1",
          requestKind: "command",
          detail: "bun run lint",
        },
      }),
      makeActivity({
        id: "approval-close",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "approval.resolved",
        summary: "Approval resolved",
        tone: "info",
        payload: { requestId: "req-2" },
      }),
      makeActivity({
        id: "approval-closed-request",
        createdAt: "2026-02-23T00:00:01.500Z",
        kind: "approval.requested",
        summary: "File-change approval requested",
        tone: "approval",
        payload: { requestId: "req-2", requestKind: "file-change" },
      }),
    ];

    expect(derivePendingApprovals(activities)).toEqual([
      {
        requestId: "req-1",
        requestKind: "command",
        createdAt: "2026-02-23T00:00:01.000Z",
        detail: "bun run lint",
      },
    ]);
  });

  it("maps canonical requestType payloads into pending approvals", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "approval-open-request-type",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "approval.requested",
        summary: "Command approval requested",
        tone: "approval",
        payload: {
          requestId: "req-request-type",
          requestType: "command_execution_approval",
          detail: "pwd",
        },
      }),
    ];

    expect(derivePendingApprovals(activities)).toEqual([
      {
        requestId: "req-request-type",
        requestKind: "command",
        createdAt: "2026-02-23T00:00:01.000Z",
        detail: "pwd",
      },
    ]);
  });

  it("clears stale pending approvals when provider reports unknown pending request", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "approval-open-stale",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "approval.requested",
        summary: "Command approval requested",
        tone: "approval",
        payload: {
          requestId: "req-stale-1",
          requestKind: "command",
        },
      }),
      makeActivity({
        id: "approval-failed-stale",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "provider.approval.respond.failed",
        summary: "Provider approval response failed",
        tone: "error",
        payload: {
          requestId: "req-stale-1",
          detail: "Unknown pending permission request: req-stale-1",
        },
      }),
    ];

    expect(derivePendingApprovals(activities)).toEqual([]);
  });

  it("clears stale pending approvals when the backend marks them stale after restart", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "approval-open-stale-restart",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "approval.requested",
        summary: "Command approval requested",
        tone: "approval",
        payload: {
          requestId: "req-stale-restart-1",
          requestKind: "command",
        },
      }),
      makeActivity({
        id: "approval-failed-stale-restart",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "provider.approval.respond.failed",
        summary: "Provider approval response failed",
        tone: "error",
        payload: {
          requestId: "req-stale-restart-1",
          detail:
            "Stale pending approval request: req-stale-restart-1. Provider callback state does not survive app restarts or recovered sessions. Restart the turn to continue.",
        },
      }),
    ];

    expect(derivePendingApprovals(activities)).toEqual([]);
  });

  // The server caps thread-detail activity reads to a newest-N window but pins
  // every request/response row on top of it, because the sidebar badge comes
  // from a separate SQL projection. Lose the request row here and the sidebar
  // says "waiting for approval" while the chat has no prompt to answer. See
  // apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts
  // listThreadActivityRowsByThread.
  it("finds an open approval that the server pinned outside the newest-N window", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "approval-open-pinned",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "approval.requested",
        summary: "Command approval requested",
        tone: "approval",
        sequence: 1,
        payload: {
          requestId: "req-pinned",
          requestKind: "command",
          detail: "rm -rf ./build",
        },
      }),
      // The window itself: everything between the request and now was dropped,
      // so the newest rows carry far higher sequences.
      ...Array.from({ length: 500 }, (_unused, index) =>
        makeActivity({
          id: `activity-window-${index}`,
          createdAt: "2026-02-23T01:00:00.000Z",
          kind: "tool.completed",
          sequence: 201 + index,
        }),
      ),
    ];

    expect(derivePendingApprovals(activities)).toEqual([
      {
        requestId: "req-pinned",
        requestKind: "command",
        createdAt: "2026-02-23T00:00:01.000Z",
        detail: "rm -rf ./build",
      },
    ]);
  });
});

describe("derivePendingUserInputs", () => {
  it("tracks open structured prompts and removes resolved ones", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "user-input-open",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "user-input.requested",
        summary: "User input requested",
        tone: "info",
        payload: {
          requestId: "req-user-input-1",
          questions: [
            {
              id: "sandbox_mode",
              header: "Sandbox",
              question: "Which mode should be used?",
              options: [
                {
                  label: "workspace-write",
                  description: "Allow workspace writes only",
                },
              ],
              multiSelect: true,
            },
          ],
        },
      }),
      makeActivity({
        id: "user-input-resolved",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "user-input.resolved",
        summary: "User input submitted",
        tone: "info",
        payload: {
          requestId: "req-user-input-2",
          answers: {
            sandbox_mode: "workspace-write",
          },
        },
      }),
      makeActivity({
        id: "user-input-open-2",
        createdAt: "2026-02-23T00:00:01.500Z",
        kind: "user-input.requested",
        summary: "User input requested",
        tone: "info",
        payload: {
          requestId: "req-user-input-2",
          questions: [
            {
              id: "approval",
              header: "Approval",
              question: "Continue?",
              options: [
                {
                  label: "yes",
                  description: "Continue execution",
                },
              ],
              multiSelect: false,
            },
          ],
        },
      }),
    ];

    expect(derivePendingUserInputs(activities)).toEqual([
      {
        requestId: "req-user-input-1",
        createdAt: "2026-02-23T00:00:01.000Z",
        questions: [
          {
            id: "sandbox_mode",
            header: "Sandbox",
            question: "Which mode should be used?",
            options: [
              {
                label: "workspace-write",
                description: "Allow workspace writes only",
              },
            ],
            multiSelect: true,
          },
        ],
      },
    ]);
  });

  it("clears stale pending user-input prompts when the provider reports an orphaned request", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "user-input-open-stale",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "user-input.requested",
        summary: "User input requested",
        tone: "info",
        payload: {
          requestId: "req-user-input-stale-1",
          questions: [
            {
              id: "sandbox_mode",
              header: "Sandbox",
              question: "Which mode should be used?",
              options: [
                {
                  label: "workspace-write",
                  description: "Allow workspace writes only",
                },
              ],
              multiSelect: false,
            },
          ],
        },
      }),
      makeActivity({
        id: "user-input-failed-stale",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "provider.user-input.respond.failed",
        summary: "Provider user input response failed",
        tone: "error",
        payload: {
          requestId: "req-user-input-stale-1",
          detail:
            "Provider adapter request failed (codex) for item/tool/requestUserInput: Unknown pending Codex user input request: req-user-input-stale-1",
        },
      }),
    ];

    expect(derivePendingUserInputs(activities)).toEqual([]);
  });
});

describe("deriveActivePlanState", () => {
  it("returns the latest plan update for the active turn", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "plan-old",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "turn.plan.updated",
        summary: "Plan updated",
        tone: "info",
        turnId: "turn-1",
        payload: {
          explanation: "Initial plan",
          plan: [{ step: "Inspect code", status: "pending" }],
        },
      }),
      makeActivity({
        id: "plan-latest",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "turn.plan.updated",
        summary: "Plan updated",
        tone: "info",
        turnId: "turn-1",
        payload: {
          explanation: "Refined plan",
          plan: [{ step: "Implement Codex user input", status: "inProgress" }],
        },
      }),
    ];

    expect(deriveActivePlanState(activities, TurnId.make("turn-1"))).toEqual({
      createdAt: "2026-02-23T00:00:02.000Z",
      turnId: "turn-1",
      explanation: "Refined plan",
      steps: [{ step: "Implement Codex user input", status: "inProgress" }],
    });
  });

  it("falls back to the most recent plan from a previous turn", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "plan-from-turn-1",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "turn.plan.updated",
        summary: "Plan updated",
        tone: "info",
        turnId: "turn-1",
        payload: {
          plan: [{ step: "Write tests", status: "completed" }],
        },
      }),
    ];

    // Current turn is turn-2, which has no plan activity — should fall back to turn-1's plan
    const result = deriveActivePlanState(activities, TurnId.make("turn-2"));
    expect(result).toEqual({
      createdAt: "2026-02-23T00:00:01.000Z",
      turnId: "turn-1",
      steps: [{ step: "Write tests", status: "completed" }],
    });
  });
});

describe("findLatestProposedPlan", () => {
  it("prefers the latest proposed plan for the active turn", () => {
    expect(
      findLatestProposedPlan(
        [
          {
            id: "plan:thread-1:turn:turn-1",
            turnId: TurnId.make("turn-1"),
            planMarkdown: "# Older",
            implementedAt: null,
            implementationThreadId: null,
            createdAt: "2026-02-23T00:00:01.000Z",
            updatedAt: "2026-02-23T00:00:01.000Z",
          },
          {
            id: "plan:thread-1:turn:turn-1",
            turnId: TurnId.make("turn-1"),
            planMarkdown: "# Latest",
            implementedAt: null,
            implementationThreadId: null,
            createdAt: "2026-02-23T00:00:01.000Z",
            updatedAt: "2026-02-23T00:00:02.000Z",
          },
          {
            id: "plan:thread-1:turn:turn-2",
            turnId: TurnId.make("turn-2"),
            planMarkdown: "# Different turn",
            implementedAt: null,
            implementationThreadId: null,
            createdAt: "2026-02-23T00:00:03.000Z",
            updatedAt: "2026-02-23T00:00:03.000Z",
          },
        ],
        TurnId.make("turn-1"),
      ),
    ).toEqual({
      id: "plan:thread-1:turn:turn-1",
      turnId: "turn-1",
      planMarkdown: "# Latest",
      implementedAt: null,
      implementationThreadId: null,
      createdAt: "2026-02-23T00:00:01.000Z",
      updatedAt: "2026-02-23T00:00:02.000Z",
    });
  });

  it("falls back to the most recently updated proposed plan", () => {
    const latestPlan = findLatestProposedPlan(
      [
        {
          id: "plan:thread-1:turn:turn-1",
          turnId: TurnId.make("turn-1"),
          planMarkdown: "# First",
          implementedAt: null,
          implementationThreadId: null,
          createdAt: "2026-02-23T00:00:01.000Z",
          updatedAt: "2026-02-23T00:00:01.000Z",
        },
        {
          id: "plan:thread-1:turn:turn-2",
          turnId: TurnId.make("turn-2"),
          planMarkdown: "# Latest",
          implementedAt: null,
          implementationThreadId: null,
          createdAt: "2026-02-23T00:00:02.000Z",
          updatedAt: "2026-02-23T00:00:03.000Z",
        },
      ],
      null,
    );

    expect(latestPlan?.planMarkdown).toBe("# Latest");
  });
});

describe("hasActionableProposedPlan", () => {
  it("returns true for an unimplemented proposed plan", () => {
    expect(
      hasActionableProposedPlan({
        id: "plan-1",
        turnId: TurnId.make("turn-1"),
        planMarkdown: "# Plan",
        implementedAt: null,
        implementationThreadId: null,
        createdAt: "2026-02-23T00:00:00.000Z",
        updatedAt: "2026-02-23T00:00:01.000Z",
      }),
    ).toBe(true);
  });

  it("returns false for a proposed plan already implemented elsewhere", () => {
    expect(
      hasActionableProposedPlan({
        id: "plan-1",
        turnId: TurnId.make("turn-1"),
        planMarkdown: "# Plan",
        implementedAt: "2026-02-23T00:00:02.000Z",
        implementationThreadId: ThreadId.make("thread-implement"),
        createdAt: "2026-02-23T00:00:00.000Z",
        updatedAt: "2026-02-23T00:00:02.000Z",
      }),
    ).toBe(false);
  });
});

describe("findSidebarProposedPlan", () => {
  it("prefers the running turn source proposed plan when available on the same thread", () => {
    expect(
      findSidebarProposedPlan({
        threads: [
          {
            id: ThreadId.make("thread-1"),
            proposedPlans: [
              {
                id: "plan-1",
                turnId: TurnId.make("turn-plan"),
                planMarkdown: "# Source plan",
                implementedAt: "2026-02-23T00:00:03.000Z",
                implementationThreadId: ThreadId.make("thread-2"),
                createdAt: "2026-02-23T00:00:01.000Z",
                updatedAt: "2026-02-23T00:00:02.000Z",
              },
            ],
          },
          {
            id: ThreadId.make("thread-2"),
            proposedPlans: [
              {
                id: "plan-2",
                turnId: TurnId.make("turn-other"),
                planMarkdown: "# Latest elsewhere",
                implementedAt: null,
                implementationThreadId: null,
                createdAt: "2026-02-23T00:00:04.000Z",
                updatedAt: "2026-02-23T00:00:05.000Z",
              },
            ],
          },
        ],
        latestTurn: {
          turnId: TurnId.make("turn-implementation"),
          sourceProposedPlan: {
            threadId: ThreadId.make("thread-1"),
            planId: "plan-1",
          },
        },
        latestTurnSettled: false,
        threadId: ThreadId.make("thread-1"),
      }),
    ).toEqual({
      id: "plan-1",
      turnId: "turn-plan",
      planMarkdown: "# Source plan",
      implementedAt: "2026-02-23T00:00:03.000Z",
      implementationThreadId: "thread-2",
      createdAt: "2026-02-23T00:00:01.000Z",
      updatedAt: "2026-02-23T00:00:02.000Z",
    });
  });

  it("falls back to the latest proposed plan once the turn is settled", () => {
    expect(
      findSidebarProposedPlan({
        threads: [
          {
            id: ThreadId.make("thread-1"),
            proposedPlans: [
              {
                id: "plan-1",
                turnId: TurnId.make("turn-plan"),
                planMarkdown: "# Older",
                implementedAt: null,
                implementationThreadId: null,
                createdAt: "2026-02-23T00:00:01.000Z",
                updatedAt: "2026-02-23T00:00:02.000Z",
              },
              {
                id: "plan-2",
                turnId: TurnId.make("turn-latest"),
                planMarkdown: "# Latest",
                implementedAt: null,
                implementationThreadId: null,
                createdAt: "2026-02-23T00:00:03.000Z",
                updatedAt: "2026-02-23T00:00:04.000Z",
              },
            ],
          },
        ],
        latestTurn: {
          turnId: TurnId.make("turn-implementation"),
          sourceProposedPlan: {
            threadId: ThreadId.make("thread-1"),
            planId: "plan-1",
          },
        },
        latestTurnSettled: true,
        threadId: ThreadId.make("thread-1"),
      })?.planMarkdown,
    ).toBe("# Latest");
  });
});

describe("workEntryIndicatesToolFailure", () => {
  const base = {
    id: "w1",
    createdAt: "2026-01-01T00:00:00.000Z",
    label: "Read",
  };

  it("is true for error tone", () => {
    expect(
      workEntryIndicatesToolFailure({
        ...base,
        tone: "error",
        detail: "nothing special",
      }),
    ).toBe(true);
  });

  it("is true when lifecycle says failed even if detail is empty", () => {
    expect(
      workEntryIndicatesToolFailure({
        ...base,
        tone: "tool",
        toolLifecycleStatus: "failed",
      }),
    ).toBe(true);
  });

  it("detects file-not-found style tool output with completed lifecycle", () => {
    expect(
      workEntryIndicatesToolFailure({
        ...base,
        tone: "tool",
        toolLifecycleStatus: "completed",
        detail: "File not found: C:\\foo\\nonexistent.ts",
      }),
    ).toBe(true);
  });

  it("detects glob no files and PowerShell command errors", () => {
    expect(
      workEntryIndicatesToolFailure({
        ...base,
        label: "Glob",
        tone: "tool",
        detail: "No files found",
      }),
    ).toBe(true);
    expect(
      workEntryIndicatesToolFailure({
        ...base,
        label: "Bash",
        tone: "tool",
        detail:
          "The term 'this_is_not_a_command' is not recognized as the name of a cmdlet, function, script file, or operable program.",
      }),
    ).toBe(true);
  });

  it("is false for successful completed tools", () => {
    expect(
      workEntryIndicatesToolFailure({
        ...base,
        tone: "tool",
        toolLifecycleStatus: "completed",
        detail: "Found 3 matching files",
      }),
    ).toBe(false);
  });

  it("treats successful tool rows as success candidates", () => {
    expect(
      workEntryIndicatesToolSuccess({
        ...base,
        tone: "tool",
        toolLifecycleStatus: "completed",
        detail: "ok",
      }),
    ).toBe(true);
    expect(
      workEntryIndicatesToolSuccess({
        ...base,
        tone: "tool",
        toolLifecycleStatus: "inProgress",
        detail: "…",
      }),
    ).toBe(false);
    expect(workEntryIndicatesToolSuccess({ ...base, tone: "thinking", detail: "…" })).toBe(false);
    expect(
      workEntryIndicatesToolNeutralStatus({
        ...base,
        tone: "tool",
        toolLifecycleStatus: "inProgress",
        detail: "…",
      }),
    ).toBe(true);
    expect(
      workEntryIndicatesToolNeutralStatus({
        ...base,
        tone: "tool",
        toolLifecycleStatus: "completed",
        detail: "ok",
      }),
    ).toBe(false);
  });

  it("does not run heuristics on non-tool info rows", () => {
    expect(
      workEntryIndicatesToolFailure({
        ...base,
        label: "Context compacted",
        tone: "info",
        detail: "File not found in conversation",
      }),
    ).toBe(false);
  });
});

describe("deriveWorkLogEntries", () => {
  it("omits tool started entries and keeps completed entries", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "tool-complete",
        createdAt: "2026-02-23T00:00:03.000Z",
        summary: "Tool call complete",
        kind: "tool.completed",
      }),
      makeActivity({
        id: "tool-start",
        createdAt: "2026-02-23T00:00:02.000Z",
        summary: "Tool call",
        kind: "tool.started",
      }),
    ];

    const entries = deriveWorkLogEntries(activities);
    expect(entries.map((entry) => entry.id)).toEqual(["tool-complete"]);
  });

  it("omits task.started but shows task.progress and task.completed", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "task-start",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "task.started",
        summary: "default task started",
        tone: "info",
      }),
      makeActivity({
        id: "task-progress",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "task.progress",
        summary: "Updating files",
        tone: "info",
      }),
      makeActivity({
        id: "task-complete",
        createdAt: "2026-02-23T00:00:03.000Z",
        kind: "task.completed",
        summary: "Task completed",
        tone: "info",
      }),
    ];

    const entries = deriveWorkLogEntries(activities);
    expect(entries.map((entry) => entry.id)).toEqual(["task-progress", "task-complete"]);
  });

  it("uses payload summary as label for task entries when available", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "task-progress-with-summary",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "task.progress",
        summary: "Reasoning update",
        tone: "info",
        payload: { summary: "Searching for API endpoints" },
      }),
    ];

    const entries = deriveWorkLogEntries(activities);
    expect(entries[0]?.label).toBe("Searching for API endpoints");
  });

  it("uses payload detail as label for task.completed and preserves error tone", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "task-completed-failed",
        createdAt: "2026-02-23T00:00:03.000Z",
        kind: "task.completed",
        summary: "Task failed",
        tone: "error",
        payload: { detail: "Failed to deploy changes" },
      }),
    ];

    const entries = deriveWorkLogEntries(activities);
    expect(entries[0]?.label).toBe("Failed to deploy changes");
    expect(entries[0]?.tone).toBe("error");
  });

  it("keeps tool entries from every turn and tags each with its turn id", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "turn-1-tool",
        turnId: "turn-1",
        summary: "Tool call complete",
        kind: "tool.completed",
      }),
      makeActivity({
        id: "turn-2-tool",
        turnId: "turn-2",
        summary: "Tool call complete",
        kind: "tool.completed",
      }),
    ];

    const entries = deriveWorkLogEntries(activities);
    expect(entries.map((entry) => entry.id)).toEqual(["turn-1-tool", "turn-2-tool"]);
    expect(entries.map((entry) => entry.turnId)).toEqual([
      TurnId.make("turn-1"),
      TurnId.make("turn-2"),
    ]);
  });

  it("omits checkpoint captured info entries", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "checkpoint",
        createdAt: "2026-02-23T00:00:01.000Z",
        summary: "Checkpoint captured",
        tone: "info",
      }),
      makeActivity({
        id: "tool-complete",
        createdAt: "2026-02-23T00:00:02.000Z",
        summary: "Ran command",
        tone: "tool",
        kind: "tool.completed",
      }),
    ];

    const entries = deriveWorkLogEntries(activities);
    expect(entries.map((entry) => entry.id)).toEqual(["tool-complete"]);
  });

  it("omits ExitPlanMode lifecycle entries once the plan card is shown", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "exit-plan-updated",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.updated",
        summary: "Tool call",
        payload: {
          detail: 'ExitPlanMode: {"allowedPrompts":[{"tool":"Bash","prompt":"run tests"}]}',
        },
      }),
      makeActivity({
        id: "exit-plan-completed",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.completed",
        summary: "Tool call",
        payload: {
          detail: "ExitPlanMode: {}",
        },
      }),
      makeActivity({
        id: "real-work-log",
        createdAt: "2026-02-23T00:00:03.000Z",
        kind: "tool.completed",
        summary: "Ran command",
        payload: {
          itemType: "command_execution",
          detail: "Bash: bun test",
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities);
    expect(entries.map((entry) => entry.id)).toEqual(["real-work-log"]);
  });

  it("orders work log by activity sequence when present", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "second",
        createdAt: "2026-02-23T00:00:03.000Z",
        sequence: 2,
        summary: "Tool call complete",
        kind: "tool.completed",
      }),
      makeActivity({
        id: "first",
        createdAt: "2026-02-23T00:00:04.000Z",
        sequence: 1,
        summary: "Tool call complete",
        kind: "tool.completed",
      }),
    ];

    const entries = deriveWorkLogEntries(activities);
    expect(entries.map((entry) => entry.id)).toEqual(["first", "second"]);
  });

  it("extracts command text for command tool activities", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "command-tool",
        kind: "tool.completed",
        summary: "Ran command",
        payload: {
          itemType: "command_execution",
          data: {
            item: {
              command: ["bun", "run", "lint"],
            },
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities);
    expect(entry?.command).toBe("bun run lint");
  });

  it("extracts failed tool lifecycle status from item payloads", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "tool-failed",
        kind: "tool.updated",
        summary: "Glob",
        tone: "tool",
        payload: {
          itemType: "mcp_tool_call",
          status: "failed",
          detail: "No files found",
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities);
    expect(entry?.toolLifecycleStatus).toBe("failed");
  });

  it("defaults tool.completed entries to completed lifecycle status", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "tool-done",
        kind: "tool.completed",
        summary: "Glob",
        tone: "tool",
        payload: {
          itemType: "mcp_tool_call",
          detail: "Found 3 files",
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities);
    expect(entry?.toolLifecycleStatus).toBe("completed");
  });

  it("preserves MCP server, tool, arguments, and results for expanded display", () => {
    const item = {
      type: "mcpToolCall",
      server: "t3-code",
      tool: "preview_status",
      arguments: {},
      status: "completed",
      result: { content: [{ type: "text", text: "attached" }] },
    };
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "mcp-tool-done",
        kind: "tool.completed",
        summary: "t3-code · preview_status",
        payload: {
          itemType: "mcp_tool_call",
          title: "t3-code · preview_status",
          data: { item },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities);
    expect(entry?.toolTitle).toBe("t3-code · preview_status");
    expect(entry?.toolData).toEqual(item);
  });

  it("keeps MCP payloads while collapsing lifecycle updates", () => {
    const item = {
      type: "mcpToolCall",
      server: "t3-code",
      tool: "preview_snapshot",
      arguments: { interactiveOnly: true },
      status: "completed",
    };
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "mcp-tool-progress",
        kind: "tool.updated",
        summary: "t3-code · preview_snapshot",
        payload: {
          itemType: "mcp_tool_call",
          toolCallId: "call-1",
          data: { item },
        },
      }),
      makeActivity({
        id: "mcp-tool-complete",
        kind: "tool.completed",
        summary: "t3-code · preview_snapshot",
        payload: {
          itemType: "mcp_tool_call",
          toolCallId: "call-1",
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities);
    expect(entry?.toolData).toEqual(item);
  });

  it("unwraps PowerShell command wrappers for displayed command text", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "command-tool-windows-wrapper",
        kind: "tool.completed",
        summary: "Ran command",
        payload: {
          itemType: "command_execution",
          data: {
            item: {
              command: "\"C:\\Program Files\\PowerShell\\7\\pwsh.exe\" -Command 'bun run lint'",
            },
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities);
    expect(entry?.command).toBe("bun run lint");
    expect(entry?.rawCommand).toBe(
      "\"C:\\Program Files\\PowerShell\\7\\pwsh.exe\" -Command 'bun run lint'",
    );
  });

  it("unwraps PowerShell command wrappers from argv-style command payloads", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "command-tool-windows-wrapper-argv",
        kind: "tool.completed",
        summary: "Ran command",
        payload: {
          itemType: "command_execution",
          data: {
            item: {
              command: ["C:\\Program Files\\PowerShell\\7\\pwsh.exe", "-Command", "rg -n foo ."],
            },
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities);
    expect(entry?.command).toBe("rg -n foo .");
    expect(entry?.rawCommand).toBe(
      '"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command "rg -n foo ."',
    );
  });

  it("extracts command text from command detail when structured command metadata is missing", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "command-tool-windows-detail-fallback",
        kind: "tool.completed",
        summary: "Ran command",
        payload: {
          itemType: "command_execution",
          detail:
            '"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -NoLogo -NoProfile -Command \'rg -n -F "new Date()" .\' <exited with exit code 0>',
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities);
    expect(entry?.command).toBe('rg -n -F "new Date()" .');
    expect(entry?.rawCommand).toBe(
      `"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -NoLogo -NoProfile -Command 'rg -n -F "new Date()" .'`,
    );
  });

  it("does not unwrap shell commands when no wrapper flag is present", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "command-tool-shell-script",
        kind: "tool.completed",
        summary: "Ran command",
        payload: {
          itemType: "command_execution",
          data: {
            item: {
              command: "bash script.sh",
            },
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities);
    expect(entry?.command).toBe("bash script.sh");
    expect(entry?.rawCommand).toBeUndefined();
  });

  it("keeps compact Codex tool metadata used for icons and labels", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "tool-with-metadata",
        kind: "tool.completed",
        summary: "bash",
        payload: {
          itemType: "command_execution",
          title: "bash",
          status: "completed",
          detail: '{ "dev": "vite dev --port 3000" } <exited with exit code 0>',
          data: {
            item: {
              command: ["bun", "run", "dev"],
              result: {
                content: '{ "dev": "vite dev --port 3000" } <exited with exit code 0>',
                exitCode: 0,
              },
            },
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities);
    expect(entry).toMatchObject({
      command: "bun run dev",
      detail: '{ "dev": "vite dev --port 3000" }',
      itemType: "command_execution",
      toolTitle: "bash",
    });
  });

  it("extracts changed file paths for file-change tool activities", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "file-tool",
        kind: "tool.completed",
        summary: "File change",
        payload: {
          itemType: "file_change",
          data: {
            item: {
              changes: [
                { path: "apps/web/src/components/ChatView.tsx" },
                { filename: "apps/web/src/session-logic.ts" },
              ],
            },
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities);
    expect(entry?.changedFiles).toEqual([
      "apps/web/src/components/ChatView.tsx",
      "apps/web/src/session-logic.ts",
    ]);
  });

  it("drops duplicated tool detail when it only repeats the title", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "read-file-generic",
        kind: "tool.completed",
        summary: "Read File",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Read File",
          detail: "Read File",
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities);
    expect(entry?.toolTitle).toBe("Read File");
    expect(entry?.detail).toBeUndefined();
  });

  it("uses grep raw output summaries instead of repeating the generic tool label", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "grep-update",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.updated",
        summary: "grep",
        payload: {
          itemType: "web_search",
          title: "grep",
          detail: "grep",
          data: {
            toolCallId: "tool-grep-1",
            kind: "search",
            rawInput: {},
          },
        },
      }),
      makeActivity({
        id: "grep-complete",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.completed",
        summary: "grep",
        payload: {
          itemType: "web_search",
          title: "grep",
          detail: "grep",
          data: {
            toolCallId: "tool-grep-1",
            kind: "search",
            rawOutput: {
              totalFiles: 19,
              truncated: false,
            },
          },
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: "grep-complete",
      toolTitle: "grep",
      detail: "19 files",
      itemType: "web_search",
    });
  });

  it("uses completed read-file output previews and still collapses the same tool call", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "read-update",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.updated",
        summary: "Read File",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Read File",
          detail: "Read File",
          data: {
            toolCallId: "tool-read-1",
            kind: "read",
            rawInput: {},
          },
        },
      }),
      makeActivity({
        id: "read-complete",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.completed",
        summary: "Read File",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Read File",
          detail: "Read File",
          data: {
            toolCallId: "tool-read-1",
            kind: "read",
            rawOutput: {
              content:
                'import * as Effect from "effect/Effect"\nimport * as Layer from "effect/Layer"\n',
            },
          },
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: "read-complete",
      toolTitle: "Read File",
      detail: 'import * as Effect from "effect/Effect"',
      itemType: "dynamic_tool_call",
    });
  });

  it("does not use command stdout as the detail when Cursor omits the command input", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "cursor-command-complete",
        createdAt: "2026-04-16T22:40:42.221Z",
        kind: "tool.completed",
        summary: "Ran command",
        payload: {
          itemType: "command_execution",
          title: "Ran command",
          data: {
            toolCallId: "toolu_vrtx_01WypXgRM8PPygBtrVAZwzy5",
            kind: "execute",
            rawInput: {},
            rawOutput: {
              exitCode: 0,
              stdout: "total 960\napps\npackages\n",
              stderr: "",
            },
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities);
    expect(entry).toMatchObject({
      id: "cursor-command-complete",
      label: "Ran command",
      itemType: "command_execution",
      toolTitle: "Ran command",
    });
    expect(entry?.detail).toBeUndefined();
    expect(entry?.command).toBeUndefined();
  });

  it("collapses legacy completed tool rows that are missing tool metadata", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "legacy-read-update",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.updated",
        summary: "Read File",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Read File",
          detail: "Read File",
          data: {
            toolCallId: "tool-read-legacy",
            kind: "read",
            rawInput: {},
          },
        },
      }),
      makeActivity({
        id: "legacy-read-complete",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.completed",
        summary: "Read File",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Read File",
          detail: "Read File",
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: "legacy-read-complete",
      toolTitle: "Read File",
      itemType: "dynamic_tool_call",
    });
    expect(entries[0]?.detail).toBeUndefined();
  });

  it("collapses repeated lifecycle updates for the same tool call into one entry", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "tool-update-1",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.updated",
        summary: "Tool call",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
        },
      }),
      makeActivity({
        id: "tool-update-2",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.updated",
        summary: "Tool call",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
          data: {
            item: {
              command: ["sed", "-n", "1,40p", "/tmp/app.ts"],
            },
          },
        },
      }),
      makeActivity({
        id: "tool-complete",
        createdAt: "2026-02-23T00:00:03.000Z",
        kind: "tool.completed",
        summary: "Tool call completed",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: "tool-complete",
      createdAt: "2026-02-23T00:00:03.000Z",
      label: "Tool call completed",
      detail: 'Read: {"file_path":"/tmp/app.ts"}',
      command: "sed -n 1,40p /tmp/app.ts",
      itemType: "dynamic_tool_call",
      toolTitle: "Tool call",
    });
  });

  it("keeps separate tool entries when an identical call starts after the prior one completed", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "tool-1-update",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.updated",
        summary: "Tool call",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
        },
      }),
      makeActivity({
        id: "tool-1-complete",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.completed",
        summary: "Tool call completed",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
        },
      }),
      makeActivity({
        id: "tool-2-update",
        createdAt: "2026-02-23T00:00:03.000Z",
        kind: "tool.updated",
        summary: "Tool call",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
        },
      }),
      makeActivity({
        id: "tool-2-complete",
        createdAt: "2026-02-23T00:00:04.000Z",
        kind: "tool.completed",
        summary: "Tool call completed",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities);

    expect(entries.map((entry) => entry.id)).toEqual(["tool-1-complete", "tool-2-complete"]);
  });

  it("collapses same-timestamp lifecycle rows even when completed sorts before updated by id", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "z-update-earlier",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.updated",
        summary: "Tool call",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
        },
      }),
      makeActivity({
        id: "a-complete-same-timestamp",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.completed",
        summary: "Tool call",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
        },
      }),
      makeActivity({
        id: "z-update-same-timestamp",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.updated",
        summary: "Tool call",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.id).toBe("a-complete-same-timestamp");
  });
});

describe("deriveWorkLogEntries tool output extraction", () => {
  it("extracts Claude's string tool_result content as output", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "claude-string-result",
        kind: "tool.completed",
        summary: "Ran command",
        payload: {
          detail: "Ran command",
          data: {
            toolName: "Bash",
            input: { command: "ls" },
            result: {
              tool_use_id: "toolu_1",
              type: "tool_result",
              content: "file1\nfile2",
              is_error: false,
            },
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities);
    expect(entry?.output).toBe("file1\nfile2");
  });

  it("preserves the first line's leading indent in string tool_result content", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "claude-read-result",
        kind: "tool.completed",
        summary: "Read",
        payload: {
          detail: "apps/web/src/qa.ts",
          data: {
            toolName: "Read",
            result: {
              tool_use_id: "toolu_read",
              type: "tool_result",
              content: "     1→a\n     2→b\n",
              is_error: false,
            },
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities);
    expect(entry?.output).toBe("     1→a\n     2→b");
  });

  it("keeps output from an errored tool_result", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "claude-error-result",
        kind: "tool.completed",
        summary: "Ran command",
        payload: {
          detail: "Ran command",
          data: {
            toolName: "Bash",
            input: { command: "false" },
            result: {
              tool_use_id: "toolu_err",
              type: "tool_result",
              content: "boom: exit 1",
              is_error: true,
            },
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities);
    expect(entry?.output).toBe("boom: exit 1");
  });

  it("carries output from a tool.updated row into the coalesced completed entry", () => {
    const collapseBase = {
      summary: "Command run",
      payload: {
        itemType: "command_execution",
        detail: "Bash: sleep 1",
        data: { toolCallId: "call-merge-1" },
      },
    };
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        ...collapseBase,
        id: "merge-updated",
        kind: "tool.updated",
        payload: {
          ...collapseBase.payload,
          data: {
            ...collapseBase.payload.data,
            rawOutput: { stdout: "done after 1s" },
          },
        },
      }),
      makeActivity({
        ...collapseBase,
        id: "merge-completed",
        kind: "tool.completed",
      }),
    ];

    const entries = deriveWorkLogEntries(activities);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.output).toBe("done after 1s");
  });

  it("flattens Claude's block-array tool_result content as output", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "claude-block-result",
        kind: "tool.completed",
        summary: "Ran command",
        payload: {
          detail: "Ran command",
          data: {
            toolName: "Bash",
            input: { command: "ls" },
            result: {
              tool_use_id: "toolu_2",
              type: "tool_result",
              content: [{ type: "text", text: "file1\nfile2" }],
              is_error: false,
            },
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities);
    expect(entry?.output).toBe("file1\nfile2");
  });

  it("extracts Codex's item.aggregatedOutput as output", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "codex-aggregated-output",
        kind: "tool.completed",
        summary: "Ran command",
        payload: {
          detail: "Ran command",
          data: {
            item: {
              command: "bun test",
              aggregatedOutput: "1 passed",
              exitCode: 0,
            },
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities);
    expect(entry?.output).toBe("1 passed");
  });

  it("extracts ACP's rawOutput.stdout as output", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "acp-raw-output",
        kind: "tool.completed",
        summary: "Ran command",
        payload: {
          detail: "Ran command",
          data: {
            toolCallId: "call-1",
            kind: "execute",
            command: "ls",
            rawInput: { command: "ls" },
            rawOutput: { stdout: "file1\nfile2" },
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities);
    expect(entry?.output).toBe("file1\nfile2");
  });

  it("leaves output undefined when only detail (OpenCode style) is set", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "opencode-detail-only",
        kind: "tool.completed",
        summary: "Ran command",
        payload: {
          detail: "file1\nfile2",
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities);
    expect(entry?.output).toBeUndefined();
  });

  it("clamps aggregatedOutput past 10000 chars", () => {
    const longOutput = "a".repeat(10005);
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "codex-long-output",
        kind: "tool.completed",
        summary: "Ran command",
        payload: {
          detail: "Ran command",
          data: {
            item: {
              command: "bun test",
              aggregatedOutput: longOutput,
              exitCode: 0,
            },
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities);
    expect(entry?.output).toBe(`${"a".repeat(10000)}…`);
  });
});

describe("deriveTimelineEntries", () => {
  it("includes proposed plans alongside messages and work entries in chronological order", () => {
    const entries = deriveTimelineEntries(
      [
        {
          id: MessageId.make("message-1"),
          role: "assistant",
          text: "hello",
          createdAt: "2026-02-23T00:00:01.000Z",
          turnId: null,
          updatedAt: "2026-02-23T00:00:01.000Z",
          streaming: false,
        },
      ],
      [
        {
          id: "plan:thread-1:turn:turn-1",
          turnId: TurnId.make("turn-1"),
          planMarkdown: "# Ship it",
          implementedAt: null,
          implementationThreadId: null,
          createdAt: "2026-02-23T00:00:02.000Z",
          updatedAt: "2026-02-23T00:00:02.000Z",
        },
      ],
      [
        {
          id: "work-1",
          createdAt: "2026-02-23T00:00:03.000Z",
          label: "Ran tests",
          tone: "tool",
        },
      ],
    );

    expect(entries.map((entry) => entry.kind)).toEqual(["message", "proposed-plan", "work"]);
    expect(entries[1]).toMatchObject({
      kind: "proposed-plan",
      proposedPlan: {
        planMarkdown: "# Ship it",
        implementedAt: null,
        implementationThreadId: null,
      },
    });
  });
});

describe("deriveWorkLogEntries context window handling", () => {
  it("excludes context window updates from the work log", () => {
    const entries = deriveWorkLogEntries([
      makeActivity({
        id: "context-1",
        turnId: "turn-1",
        kind: "context-window.updated",
        summary: "Context window updated",
        tone: "info",
      }),
      makeActivity({
        id: "tool-1",
        turnId: "turn-1",
        kind: "tool.completed",
        summary: "Ran command",
        tone: "tool",
      }),
    ]);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.label).toBe("Ran command");
  });

  it("keeps context compaction activities as normal work log entries", () => {
    const entries = deriveWorkLogEntries([
      makeActivity({
        id: "compaction-1",
        turnId: "turn-1",
        kind: "context-compaction",
        summary: "Context compacted",
        tone: "info",
      }),
    ]);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.label).toBe("Context compacted");
  });
});

describe("isLatestTurnSettled", () => {
  const latestTurn = {
    turnId: TurnId.make("turn-1"),
    startedAt: "2026-02-27T21:10:00.000Z",
    completedAt: "2026-02-27T21:10:06.000Z",
  } as const;

  it("returns false while the same turn is still active in a running session", () => {
    expect(
      isLatestTurnSettled(latestTurn, {
        status: "running",
        activeTurnId: TurnId.make("turn-1"),
      }),
    ).toBe(false);
  });

  it("returns false while any turn is running to avoid stale latest-turn banners", () => {
    expect(
      isLatestTurnSettled(latestTurn, {
        status: "running",
        activeTurnId: TurnId.make("turn-2"),
      }),
    ).toBe(false);
  });

  it("returns true once the session is no longer running that turn", () => {
    expect(
      isLatestTurnSettled(latestTurn, {
        status: "ready",
        activeTurnId: null,
      }),
    ).toBe(true);
  });

  it("returns false when turn timestamps are incomplete", () => {
    expect(
      isLatestTurnSettled(
        {
          turnId: TurnId.make("turn-1"),
          startedAt: null,
          completedAt: "2026-02-27T21:10:06.000Z",
        },
        null,
      ),
    ).toBe(false);
  });
});

describe("deriveActiveWorkStartedAt", () => {
  const latestTurn = {
    turnId: TurnId.make("turn-1"),
    startedAt: "2026-02-27T21:10:00.000Z",
    completedAt: "2026-02-27T21:10:06.000Z",
  } as const;

  it("prefers the in-flight turn start when the latest turn is not settled", () => {
    expect(
      deriveActiveWorkStartedAt(
        latestTurn,
        {
          status: "running",
          activeTurnId: TurnId.make("turn-1"),
        },
        "2026-02-27T21:11:00.000Z",
      ),
    ).toBe("2026-02-27T21:10:00.000Z");
  });

  it("uses the new send start while the session is running a different turn", () => {
    expect(
      deriveActiveWorkStartedAt(
        latestTurn,
        {
          status: "running",
          activeTurnId: TurnId.make("turn-2"),
        },
        "2026-02-27T21:11:00.000Z",
      ),
    ).toBe("2026-02-27T21:11:00.000Z");
  });

  it("falls back to sendStartedAt once the latest turn is settled", () => {
    expect(
      deriveActiveWorkStartedAt(
        latestTurn,
        {
          status: "ready",
          activeTurnId: null,
        },
        "2026-02-27T21:11:00.000Z",
      ),
    ).toBe("2026-02-27T21:11:00.000Z");
  });

  it("uses sendStartedAt for a fresh send after the prior turn completed", () => {
    expect(
      deriveActiveWorkStartedAt(
        {
          turnId: TurnId.make("turn-1"),
          startedAt: "2026-02-27T21:10:00.000Z",
          completedAt: "2026-02-27T21:10:06.000Z",
        },
        null,
        "2026-02-27T21:11:00.000Z",
      ),
    ).toBe("2026-02-27T21:11:00.000Z");
  });
});

const SUBAGENT_TASK_INPUT = {
  subagent_type: "Explore",
  description: "Explore the repo",
  prompt: "Find every usage of deriveWorkLogEntries",
};

/** Claude-shaped spawn: coalesced item.updated row + eventId-keyed item.completed row. */
function makeClaudeSubagentSpawnActivities(overrides?: {
  result?: unknown;
  updatedStatus?: string;
}): OrchestrationThreadActivity[] {
  const result = overrides?.result ?? {
    type: "tool_result",
    tool_use_id: "toolu_task",
    content: [{ type: "text", text: "Found 3 usages" }],
  };
  const data = { toolName: "Task", input: SUBAGENT_TASK_INPUT, result };
  return [
    makeActivity({
      id: "tool-updated:thread-1:toolu_task",
      createdAt: "2026-02-23T00:00:05.000Z",
      kind: "tool.updated",
      summary: "Subagent task",
      sequence: 5,
      payload: {
        itemType: "collab_agent_tool_call",
        status: overrides?.updatedStatus ?? "inProgress",
        title: "Subagent task",
        data,
      },
    }),
    makeActivity({
      id: "task-complete-event",
      createdAt: "2026-02-23T00:00:06.000Z",
      kind: "tool.completed",
      summary: "Subagent task",
      sequence: 6,
      payload: {
        itemType: "collab_agent_tool_call",
        title: "Subagent task",
        data,
      },
    }),
  ];
}

describe("deriveSubagentGroups", () => {
  it("groups a Claude-shaped spawn with children attributed via parentToolUseId", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "child-complete",
        createdAt: "2026-02-23T00:00:03.000Z",
        kind: "tool.completed",
        summary: "Terminal",
        sequence: 3,
        payload: {
          itemType: "command_execution",
          title: "Terminal",
          detail: "ls",
          parentToolUseId: "toolu_task",
          data: {},
        },
      }),
      ...makeClaudeSubagentSpawnActivities(),
    ];

    const entries = deriveWorkLogEntries(activities);
    const groups = deriveSubagentGroups(entries, { turnSettled: true });

    expect(groups).toHaveLength(1);
    const group = groups[0];
    expect(group?.toolCallId).toBe("toolu_task");
    expect(group?.name).toBe("Explore");
    expect(group?.description).toBe("Explore the repo");
    expect(group?.status).toBe("completed");
    expect(group?.resultText).toBe("Found 3 usages");
    expect(group?.children.map((child) => child.id)).toEqual(["child-complete"]);
    expect(group?.completedAt).toBeNull();
    expect(group?.prompt).toBe("Find every usage of deriveWorkLogEntries");
  });

  it("normalizes Codex spawns into one non-empty group per child and ignores later collab tools", () => {
    const codexCollabActivity = (
      id: string,
      sequence: number,
      toolCallId: string,
      collabTool: "spawnAgent" | "wait" | "sendInput" | "resumeAgent" | "closeAgent",
      prompt?: string,
      receiverThreadIds: string[] = [],
    ) =>
      makeActivity({
        id,
        createdAt: `2026-02-23T00:00:${String(sequence).padStart(2, "0")}.000Z`,
        kind: "tool.completed",
        summary: "Subagent task",
        sequence,
        payload: {
          itemType: "collab_agent_tool_call",
          status: "completed",
          title: "Subagent task",
          data: {
            toolCallId,
            toolName: collabTool === "spawnAgent" ? "Task" : collabTool,
            collabTool,
            receiverThreadIds,
            input: {
              subagent_type: "gpt-5.3-codex",
              ...(prompt ? { prompt, description: prompt } : {}),
            },
          },
        },
      });
    const activities: OrchestrationThreadActivity[] = [
      codexCollabActivity("spawn-1", 1, "collab-spawn-1", "spawnAgent", "Review parser.ts", [
        "child-thread-1",
      ]),
      makeActivity({
        id: "progress-1",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "task.progress",
        sequence: 2,
        summary: "Reading parser.ts",
        payload: { taskId: "child-thread-1", summary: "Reading parser.ts" },
      }),
      codexCollabActivity("wait-1", 3, "collab-wait-1", "wait"),
      codexCollabActivity("send-1", 4, "collab-send-1", "sendInput"),
      codexCollabActivity("resume-1", 5, "collab-resume-1", "resumeAgent"),
      codexCollabActivity("close-1", 6, "collab-close-1", "closeAgent"),
      makeActivity({
        id: "complete-1",
        createdAt: "2026-02-23T00:00:07.000Z",
        kind: "task.completed",
        sequence: 7,
        summary: "Parser review complete",
        payload: {
          taskId: "child-thread-1",
          status: "completed",
          summary: "Parser review complete",
        },
      }),
      codexCollabActivity("spawn-2", 8, "collab-spawn-2", "spawnAgent", "Review lexer.ts", [
        "child-thread-2",
      ]),
    ];
    const subagents: OrchestrationThreadSubagent[] = [
      {
        subagentId: "child-thread-1",
        turnId: null,
        agentType: "gpt-5.3-codex",
        description: "Review parser.ts",
        status: "completed",
        lastProgressSummary: "Parser review complete",
        spawnedByItemId: "collab-spawn-1",
        startedAt: "2026-02-23T00:00:01.000Z",
        updatedAt: "2026-02-23T00:00:07.000Z",
        completedAt: "2026-02-23T00:00:07.000Z",
      },
      {
        subagentId: "child-thread-2",
        turnId: null,
        agentType: "gpt-5.3-codex",
        description: "Review lexer.ts",
        status: "running",
        spawnedByItemId: "collab-spawn-2",
        startedAt: "2026-02-23T00:00:08.000Z",
        updatedAt: "2026-02-23T00:00:08.000Z",
        completedAt: null,
      },
    ];

    const groups = deriveSubagentGroups(deriveWorkLogEntries(activities), {
      turnSettled: false,
      subagents,
    });

    expect(groups).toHaveLength(2);
    expect(groups.map((group) => group.toolCallId)).toEqual(["collab-spawn-1", "collab-spawn-2"]);
    expect(groups[0]).toMatchObject({
      name: "gpt-5.3-codex",
      description: "Review parser.ts",
      prompt: "Review parser.ts",
      resultText: "Parser review complete",
      status: "completed",
    });
    expect(groups[0]?.children.map((child) => child.id)).toEqual(["progress-1", "complete-1"]);
    expect(groups[1]).toMatchObject({
      name: "gpt-5.3-codex",
      prompt: "Review lexer.ts",
      status: "running",
    });

    const groupsWithoutReadModel = deriveSubagentGroups(deriveWorkLogEntries(activities), {
      turnSettled: true,
    });
    expect(groupsWithoutReadModel[0]?.children.map((child) => child.id)).toEqual([
      "progress-1",
      "complete-1",
    ]);
    expect(groupsWithoutReadModel[0]?.status).toBe("completed");
  });

  it("keeps a failed Codex spawn failed when no child row exists", () => {
    const [group] = deriveSubagentGroups(
      deriveWorkLogEntries([
        makeActivity({
          id: "failed-codex-spawn",
          kind: "tool.completed",
          payload: {
            itemType: "collab_agent_tool_call",
            status: "failed",
            data: {
              toolCallId: "collab-failed",
              collabTool: "spawnAgent",
              receiverThreadIds: [],
              input: { subagent_type: "spawnAgent" },
            },
          },
        }),
      ]),
      { turnSettled: true },
    );

    expect(group?.status).toBe("failed");
  });

  it("reads legacy nested Codex spawn data", () => {
    const groups = deriveSubagentGroups(
      deriveWorkLogEntries([
        makeActivity({
          id: "legacy-codex-spawn",
          kind: "tool.completed",
          payload: {
            itemType: "collab_agent_tool_call",
            data: {
              item: {
                id: "collab-legacy-1",
                type: "collabAgentToolCall",
                tool: "spawnAgent",
                model: "gpt-5.2-codex",
                prompt: "Inspect the legacy path",
                agentsStates: {
                  "child-legacy": { status: "completed", message: "Legacy path is safe." },
                },
              },
            },
          },
        }),
      ]),
      { turnSettled: true },
    );

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      toolCallId: "collab-legacy-1",
      name: "gpt-5.2-codex",
      prompt: "Inspect the legacy path",
      resultText: "Legacy path is safe.",
    });
  });

  it("keeps prose, thinking, and tool rows interleaved by sequence", () => {
    const activities: OrchestrationThreadActivity[] = [
      ...makeClaudeSubagentSpawnActivities(),
      makeActivity({
        id: "subagent-text",
        kind: "subagent.text",
        sequence: 1,
        payload: { parentToolUseId: "toolu_task", text: "I found the parser." },
      }),
      makeActivity({
        id: "child-tool",
        kind: "tool.completed",
        sequence: 2,
        payload: {
          itemType: "command_execution",
          parentToolUseId: "toolu_task",
          title: "Terminal",
          detail: "rg parser",
        },
      }),
      makeActivity({
        id: "subagent-thinking",
        kind: "subagent.thinking",
        sequence: 3,
        payload: { parentToolUseId: "toolu_task", text: "Checking edge cases." },
      }),
    ];

    const [group] = deriveSubagentGroups(deriveWorkLogEntries(activities), {
      turnSettled: true,
    });

    expect(group?.children.map((child) => child.id)).toEqual([
      "subagent-text",
      "child-tool",
      "subagent-thinking",
    ]);
    expect(group?.children.map((child) => child.sourceActivityKind)).toEqual([
      "subagent.text",
      "tool.completed",
      "subagent.thinking",
    ]);
  });

  it("still produces a group with empty children when linkage fields are absent", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "legacy-subagent-event",
        createdAt: "2026-02-23T00:00:05.000Z",
        kind: "tool.updated",
        summary: "Subagent task",
        sequence: 5,
        payload: {
          itemType: "collab_agent_tool_call",
          status: "inProgress",
          title: "Subagent task",
          data: { toolName: "Task", input: SUBAGENT_TASK_INPUT },
        },
      }),
      makeActivity({
        id: "unrelated-tool",
        createdAt: "2026-02-23T00:00:06.000Z",
        kind: "tool.completed",
        summary: "Terminal",
        sequence: 6,
        payload: { itemType: "command_execution", detail: "ls", data: {} },
      }),
    ];

    const entries = deriveWorkLogEntries(activities);
    const groups = deriveSubagentGroups(entries, { turnSettled: false });

    expect(groups).toHaveLength(1);
    expect(groups[0]?.toolCallId).toBeNull();
    expect(groups[0]?.children).toEqual([]);
    expect(groups[0]?.name).toBe("Explore");
    expect(groups[0]?.status).toBe("running");
    expect(groups[0]?.prompt).toBe("Find every usage of deriveWorkLogEntries");
  });

  it("marks the group failed when the tool result is an error", () => {
    const activities = makeClaudeSubagentSpawnActivities({
      updatedStatus: "failed",
      result: {
        type: "tool_result",
        tool_use_id: "toolu_task",
        is_error: true,
        content: "Agent crashed",
      },
    });

    const entries = deriveWorkLogEntries(activities);
    const groups = deriveSubagentGroups(entries, { turnSettled: true });

    expect(groups).toHaveLength(1);
    expect(groups[0]?.status).toBe("failed");
    expect(groups[0]?.resultText).toBe("Agent crashed");
  });

  it("marks a still-running group stopped once the turn settles", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "tool-updated:thread-1:toolu_task",
        createdAt: "2026-02-23T00:00:05.000Z",
        kind: "tool.updated",
        summary: "Subagent task",
        sequence: 5,
        payload: {
          itemType: "collab_agent_tool_call",
          status: "inProgress",
          title: "Subagent task",
          data: { toolName: "Task", input: SUBAGENT_TASK_INPUT },
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities);
    expect(deriveSubagentGroups(entries, { turnSettled: false })[0]?.status).toBe("running");
    expect(deriveSubagentGroups(entries, { turnSettled: true })[0]?.status).toBe("stopped");
  });

  it("prefers the thread.subagents read model for identity, status, and timestamps", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "tool-updated:thread-1:toolu_task",
        createdAt: "2026-02-23T00:00:05.000Z",
        kind: "tool.updated",
        summary: "Subagent task",
        sequence: 5,
        payload: {
          itemType: "collab_agent_tool_call",
          status: "inProgress",
          title: "Subagent task",
          data: { toolName: "Task", input: SUBAGENT_TASK_INPUT },
        },
      }),
    ];
    const readModelRow: OrchestrationThreadSubagent = {
      subagentId: "task-1",
      turnId: null,
      agentType: "code-reviewer",
      description: "Review the diff",
      status: "completed",
      spawnedByItemId: "toolu_task",
      startedAt: "2026-02-23T00:00:04.000Z",
      updatedAt: "2026-02-23T00:00:09.000Z",
      completedAt: "2026-02-23T00:00:09.000Z",
    };

    const entries = deriveWorkLogEntries(activities);
    const groups = deriveSubagentGroups(entries, {
      turnSettled: false,
      subagents: [readModelRow],
    });

    expect(groups).toHaveLength(1);
    expect(groups[0]?.name).toBe("code-reviewer");
    expect(groups[0]?.description).toBe("Review the diff");
    expect(groups[0]?.status).toBe("completed");
    expect(groups[0]?.startedAt).toBe("2026-02-23T00:00:04.000Z");
    expect(groups[0]?.completedAt).toBe("2026-02-23T00:00:09.000Z");

    const stillRunning = deriveSubagentGroups(entries, {
      turnSettled: true,
      subagents: [{ ...readModelRow, status: "running", completedAt: null }],
    });
    expect(stillRunning[0]?.status).toBe("stopped");
  });

  it("groups a Codex subAgentActivity spawn and joins it to its task row", () => {
    // codex-cli 0.147 reports a spawn as `subAgentActivity`; the adapter
    // normalizes it onto the collab shape, keyed by the child thread id.
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "tool-updated:thread-1:child-activity-1",
        createdAt: "2026-02-23T00:00:05.000Z",
        kind: "tool.updated",
        summary: "Subagent task",
        sequence: 5,
        payload: {
          itemType: "collab_agent_tool_call",
          status: "inProgress",
          title: "Subagent task",
          data: {
            toolCallId: "child-activity-1",
            toolName: "Task",
            collabTool: "spawnAgent",
            subAgentActivityKind: "started",
            agentPath: "root/reviewer",
            receiverThreadIds: ["child-thread-1"],
            agentsStates: {},
            input: { description: "root/reviewer", subagent_type: "reviewer" },
          },
        },
      }),
      makeActivity({
        id: "interrupted-activity",
        createdAt: "2026-02-23T00:00:06.000Z",
        kind: "tool.updated",
        summary: "Subagent task",
        sequence: 6,
        payload: {
          itemType: "collab_agent_tool_call",
          status: "inProgress",
          title: "Subagent task",
          data: {
            toolCallId: "child-activity-2",
            toolName: "Task",
            collabTool: "closeAgent",
            subAgentActivityKind: "interrupted",
            agentPath: "root/reviewer",
            receiverThreadIds: ["child-thread-1"],
            agentsStates: {},
            input: { description: "root/reviewer", subagent_type: "reviewer" },
          },
        },
      }),
    ];
    const readModelRow: OrchestrationThreadSubagent = {
      subagentId: "child-thread-1",
      turnId: null,
      agentType: "reviewer",
      description: "root/reviewer",
      status: "completed",
      spawnedByItemId: "child-activity-1",
      startedAt: "2026-02-23T00:00:05.000Z",
      updatedAt: "2026-02-23T00:00:08.000Z",
      completedAt: "2026-02-23T00:00:08.000Z",
    };

    const entries = deriveWorkLogEntries(activities);
    const groups = deriveSubagentGroups(entries, {
      turnSettled: false,
      subagents: [readModelRow],
    });

    // Only the spawn opens a group; `closeAgent` is a later operation on it.
    expect(groups).toHaveLength(1);
    expect(groups[0]?.toolCallId).toBe("child-activity-1");
    expect(groups[0]?.name).toBe("reviewer");
    expect(groups[0]?.status).toBe("completed");
    expect(groups[0]?.completedAt).toBe("2026-02-23T00:00:08.000Z");
  });

  it("keeps a root subAgentActivity flat instead of opening a group", () => {
    const activity = makeActivity({
      id: "root-interaction",
      createdAt: "2026-02-23T00:00:05.000Z",
      kind: "tool.updated",
      summary: "Subagent task",
      sequence: 5,
      payload: {
        itemType: "collab_agent_tool_call",
        status: "inProgress",
        data: {
          toolCallId: "root-interaction",
          toolName: "Task",
          collabTool: "sendInput",
          agentPath: "/root",
          receiverThreadIds: ["provider-root"],
          agentsStates: {},
          input: { description: "/root", subagent_type: "root" },
        },
      },
    });
    const entries = deriveWorkLogEntries([activity]);

    expect(entries).toHaveLength(1);
    expect(deriveSubagentGroups(entries, { turnSettled: false })).toEqual([]);
  });

  it("opens no group for the T3 MCP spawn tool, leaving only its mirrored row", () => {
    // `mcp__t3-code__spawn_agent` trips classifyToolItemType's "agent" test, so
    // it arrives as a collab row. Its mirrored read-model row can carry no
    // `spawnedByItemId`, so a group here would list the subagent twice.
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "tool-updated:thread-1:toolu_mcp_spawn",
        createdAt: "2026-02-23T00:00:05.000Z",
        kind: "tool.updated",
        summary: "Spawn a subagent",
        sequence: 5,
        payload: {
          itemType: "collab_agent_tool_call",
          status: "inProgress",
          title: "Spawn a subagent",
          data: {
            toolName: "mcp__t3-code__spawn_agent",
            input: { agent_type: "code-reviewer", prompt: "Review the diff" },
          },
        },
      }),
    ];
    const readModelRow: OrchestrationThreadSubagent = {
      subagentId: "child-thread-1",
      turnId: null,
      agentType: "code-reviewer",
      description: "Review the diff",
      status: "running",
      childThreadId: ThreadId.make("child-thread-1"),
      startedAt: "2026-02-23T00:00:05.000Z",
      updatedAt: "2026-02-23T00:00:06.000Z",
      completedAt: null,
    };

    const entries = deriveWorkLogEntries(activities);
    // The call keeps its place in the work log; it just opens no group.
    expect(entries.map((entry) => entry.itemType)).toEqual(["collab_agent_tool_call"]);

    const groups = deriveSubagentGroups(entries, {
      turnSettled: false,
      subagents: [readModelRow],
    });
    expect(groups).toEqual([]);

    const roster = buildSubagentRoster({ groups, subagents: [readModelRow] });
    expect(roster).toHaveLength(1);
    expect(roster[0]?.group).toBeNull();
    expect(roster[0]?.subagentId).toBe("child-thread-1");
    expect(roster[0]?.childThreadId).toBe("child-thread-1");
    expect(roster[0]?.status).toBe("running");
  });

  it("still groups a provider tool that merely ends in spawn_agent", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "tool-updated:thread-1:toolu_other",
        createdAt: "2026-02-23T00:00:05.000Z",
        kind: "tool.updated",
        summary: "Subagent task",
        sequence: 5,
        payload: {
          itemType: "collab_agent_tool_call",
          status: "inProgress",
          title: "Subagent task",
          data: {
            toolName: "mcp__other-server__spawn_agent",
            input: SUBAGENT_TASK_INPUT,
          },
        },
      }),
    ];

    const groups = deriveSubagentGroups(deriveWorkLogEntries(activities), { turnSettled: false });
    expect(groups).toHaveLength(1);
    expect(groups[0]?.toolCallId).toBe("toolu_other");
  });

  /**
   * opencode-shaped spawn: a coalesced tool.updated row and an eventId-keyed
   * tool.completed row that share no toolCallId but carry the same
   * `data.state.metadata.sessionId` (verified against state.sqlite for
   * t3code-dpq). The bare tool.started row never reaches the work log.
   */
  function makeOpenCodeSubagentSpawnActivities(overrides: {
    callId: string;
    sessionId: string;
    title: string;
    includeSessionId?: boolean;
    /** Distinct summary/detail for the updated row, to dodge the adjacency collapse. */
    updatedLabel?: string;
    /** Activity id override for the updated row; defaults to the coalesced shape. */
    updatedId?: string;
    /** Timestamp/sequence overrides for the updated row (sequential spawns). */
    updatedCreatedAt?: string;
    updatedSequence?: number;
  }): OrchestrationThreadActivity[] {
    const state = (status: string) => ({
      title: overrides.title,
      status,
      input: { description: overrides.title, prompt: `Do: ${overrides.title}` },
      ...(overrides.includeSessionId === false
        ? {}
        : { metadata: { sessionId: overrides.sessionId } }),
    });
    const updatedLabel = overrides.updatedLabel ?? overrides.title;
    return [
      makeActivity({
        id: overrides.updatedId ?? `tool-updated:thread-1:${overrides.callId}`,
        createdAt: overrides.updatedCreatedAt ?? "2026-02-23T00:00:05.000Z",
        kind: "tool.updated",
        summary: updatedLabel,
        sequence: overrides.updatedSequence ?? 5,
        payload: {
          itemType: "collab_agent_tool_call",
          status: "inProgress",
          detail: updatedLabel,
          data: { tool: "task", state: state("running") },
        },
      }),
      makeActivity({
        id: `completed-${overrides.callId}`,
        createdAt: "2026-02-23T00:03:00.000Z",
        kind: "tool.completed",
        summary: overrides.title,
        sequence: 6,
        payload: {
          itemType: "collab_agent_tool_call",
          detail: `<task id="${overrides.sessionId}" state="completed">`,
          data: { tool: "task", state: state("completed") },
        },
      }),
    ];
  }

  it("joins an opencode spawn's id-less updated/completed rows into one group via sessionId", () => {
    const groups = deriveSubagentGroups(
      deriveWorkLogEntries(
        makeOpenCodeSubagentSpawnActivities({
          callId: "call_1",
          sessionId: "ses_1",
          title: "Investigate prod host state",
        }),
      ),
      { turnSettled: false, activeTurnStartedAt: "2026-02-23T00:00:00.000Z" },
    );

    expect(groups).toHaveLength(1);
    expect(groups[0]?.toolCallId).toBe("call_1");
    expect(groups[0]?.status).toBe("completed");
    expect(groups[0]?.description).toBe("Investigate prod host state");
  });

  it("joins an id-less pair on title when the match is unambiguous", () => {
    const activities = makeOpenCodeSubagentSpawnActivities({
      callId: "call_1",
      sessionId: "ses_1",
      title: "Unique title",
      includeSessionId: false,
      // Strip the coalesced activity id so no toolCallId is recoverable either.
      updatedId: "updated-no-id",
    });

    const groups = deriveSubagentGroups(deriveWorkLogEntries(activities), {
      turnSettled: false,
    });

    expect(groups).toHaveLength(1);
    expect(groups[0]?.status).toBe("completed");
  });

  it("keeps two parallel same-title id-less spawns separate", () => {
    const first = makeOpenCodeSubagentSpawnActivities({
      callId: "call_1",
      sessionId: "ses_1",
      title: "Audit test relevance",
      includeSessionId: false,
      updatedId: "updated-no-id-1",
      // Distinct summaries/details keep the adjacency collapse from merging the
      // pair at the work-log level; the shared data.state.title is what the
      // pairing fallback would have to join on, and it must refuse.
      updatedLabel: "Audit test relevance (server)",
    });
    const second = makeOpenCodeSubagentSpawnActivities({
      callId: "call_2",
      sessionId: "ses_2",
      title: "Audit test relevance",
      includeSessionId: false,
      updatedId: "updated-no-id-2",
      updatedLabel: "Audit test relevance (web)",
    });
    const activities = [first[0]!, second[0]!, first[1]!, second[1]!];

    const groups = deriveSubagentGroups(deriveWorkLogEntries(activities), {
      turnSettled: false,
    });

    // Both completions were ambiguous (two open same-title groups), so nothing
    // merged: two running + two completed, never one wrongly-merged group.
    expect(groups).toHaveLength(4);
    expect(groups.filter((group) => group.status === "completed")).toHaveLength(2);
  });

  it("does not merge a fresh same-title spawn into the previous run's settled group", () => {
    const first = makeOpenCodeSubagentSpawnActivities({
      callId: "call_1",
      sessionId: "ses_1",
      title: "Audit test relevance",
      includeSessionId: false,
      updatedId: "updated-no-id-1",
      updatedLabel: "Audit test relevance (first)",
    });
    // Sequential re-run of the same-titled task: only the open half exists so
    // far. It must render as its own running group, not vanish into the
    // previous run's completed group.
    const rerun = makeOpenCodeSubagentSpawnActivities({
      callId: "call_2",
      sessionId: "ses_2",
      title: "Audit test relevance",
      includeSessionId: false,
      updatedId: "updated-no-id-2",
      updatedLabel: "Audit test relevance (rerun)",
      updatedCreatedAt: "2026-02-23T00:05:00.000Z",
      updatedSequence: 7,
    })[0]!;

    const groups = deriveSubagentGroups(deriveWorkLogEntries([...first, rerun]), {
      turnSettled: false,
    });

    expect(groups).toHaveLength(2);
    expect(groups[0]?.status).toBe("completed");
    expect(groups[1]?.status).toBe("running");
  });

  it("stops a stale group that predates the live turn, even before the turn settles", () => {
    const activities = makeOpenCodeSubagentSpawnActivities({
      callId: "call_1",
      sessionId: "ses_1",
      title: "Investigate prod host state",
    });
    const lingering = activities[0]!;

    const entries = deriveWorkLogEntries([lingering]);
    // No activeTurnStartedAt: today's behavior, turnSettled is the only rule.
    expect(deriveSubagentGroups(entries, { turnSettled: false })[0]?.status).toBe("running");
    // The entry predates the live turn: a previous run abandoned it.
    expect(
      deriveSubagentGroups(entries, {
        turnSettled: false,
        activeTurnStartedAt: "2026-02-23T01:00:00.000Z",
      })[0]?.status,
    ).toBe("stopped");
    // Born inside the live turn: genuinely running.
    expect(
      deriveSubagentGroups(entries, {
        turnSettled: false,
        activeTurnStartedAt: "2026-02-22T23:00:00.000Z",
      })[0]?.status,
    ).toBe("running");
  });

  it("keeps a running read-model row authoritative over the stale-entry rule", () => {
    const activities = makeOpenCodeSubagentSpawnActivities({
      callId: "call_1",
      sessionId: "ses_1",
      title: "Investigate prod host state",
    });
    const readModelRow: OrchestrationThreadSubagent = {
      subagentId: "task-1",
      turnId: null,
      agentType: "Explore",
      description: "Investigate prod host state",
      status: "running",
      spawnedByItemId: "call_1",
      startedAt: "2026-02-23T00:00:05.000Z",
      updatedAt: "2026-02-23T00:00:06.000Z",
      completedAt: null,
    };

    const groups = deriveSubagentGroups(deriveWorkLogEntries([activities[0]!]), {
      turnSettled: false,
      subagents: [readModelRow],
      activeTurnStartedAt: "2026-02-23T01:00:00.000Z",
    });

    // The read model has its own freshness handling; the stale-entry rule must
    // not downgrade it.
    expect(groups[0]?.status).toBe("running");
  });
});

describe("extractSubagentResultText", () => {
  it("returns trimmed bare strings", () => {
    expect(extractSubagentResultText("  done  ")).toBe("done");
    expect(extractSubagentResultText("   ")).toBeNull();
  });

  it("reads text blocks and joins arrays of blocks", () => {
    expect(extractSubagentResultText({ type: "text", text: "hello" })).toBe("hello");
    expect(
      extractSubagentResultText([
        { type: "text", text: "first" },
        { type: "text", text: "second" },
      ]),
    ).toBe("first\nsecond");
  });

  it("unwraps tool_result-shaped records via their content", () => {
    expect(
      extractSubagentResultText({
        type: "tool_result",
        tool_use_id: "toolu_task",
        content: [{ type: "text", text: "nested" }],
      }),
    ).toBe("nested");
  });

  it("returns null for shapes it does not understand", () => {
    expect(extractSubagentResultText(undefined)).toBeNull();
    expect(extractSubagentResultText({ status: "ok" })).toBeNull();
    expect(extractSubagentResultText([])).toBeNull();
  });
});
