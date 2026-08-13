import { EventId, ProviderDriverKind, RuntimeRequestId } from "@t3tools/contracts";
import type { LegacyProviderRuntimeEvent } from "../TestProviderAdapter.integration.ts";

const PROVIDER = ProviderDriverKind.make("codex");
const CLAUDE_PROVIDER = ProviderDriverKind.make("claudeAgent");
const SESSION_ID = "fixture-session";
const THREAD_ID = "fixture-thread";
const TURN_ID = "fixture-turn";
const REQUEST_ID = RuntimeRequestId.make("req-1");

function baseEvent(
  eventId: string,
  createdAt: string,
  provider: ProviderDriverKind = PROVIDER,
): Pick<LegacyProviderRuntimeEvent, "eventId" | "provider" | "sessionId" | "createdAt"> {
  return {
    eventId: EventId.make(eventId),
    provider,
    sessionId: SESSION_ID,
    createdAt,
  };
}

export const codexTurnTextFixture = [
  {
    type: "turn.started",
    ...baseEvent("evt-1", "2026-02-23T00:00:00.000Z"),
    threadId: THREAD_ID,
    turnId: TURN_ID,
    payload: {},
  },
  {
    type: "content.delta",
    ...baseEvent("evt-2", "2026-02-23T00:00:00.100Z"),
    threadId: THREAD_ID,
    turnId: TURN_ID,
    payload: {
      streamKind: "assistant_text",
      delta: "I will make a small update.\n",
    },
  },
  {
    type: "content.delta",
    ...baseEvent("evt-3", "2026-02-23T00:00:00.200Z"),
    threadId: THREAD_ID,
    turnId: TURN_ID,
    payload: {
      streamKind: "assistant_text",
      delta: "Done.\n",
    },
  },
  {
    type: "turn.completed",
    ...baseEvent("evt-4", "2026-02-23T00:00:00.300Z"),
    threadId: THREAD_ID,
    turnId: TURN_ID,
    payload: {
      state: "completed",
    },
  },
] satisfies ReadonlyArray<LegacyProviderRuntimeEvent>;

export const codexTurnToolFixture = [
  {
    type: "turn.started",
    ...baseEvent("evt-11", "2026-02-23T00:01:00.000Z"),
    threadId: THREAD_ID,
    turnId: TURN_ID,
    payload: {},
  },
  {
    type: "item.started",
    ...baseEvent("evt-12", "2026-02-23T00:01:00.100Z"),
    threadId: THREAD_ID,
    turnId: TURN_ID,
    payload: {
      itemType: "command_execution",
      title: "Ran command",
      detail: "echo integration",
    },
  },
  {
    type: "item.completed",
    ...baseEvent("evt-13", "2026-02-23T00:01:00.200Z"),
    threadId: THREAD_ID,
    turnId: TURN_ID,
    payload: {
      itemType: "command_execution",
      status: "completed",
      title: "Ran command",
      detail: "echo integration",
    },
  },
  {
    type: "content.delta",
    ...baseEvent("evt-14", "2026-02-23T00:01:00.300Z"),
    threadId: THREAD_ID,
    turnId: TURN_ID,
    payload: {
      streamKind: "assistant_text",
      delta: "Applied the requested edit.\n",
    },
  },
  {
    type: "turn.completed",
    ...baseEvent("evt-15", "2026-02-23T00:01:00.400Z"),
    threadId: THREAD_ID,
    turnId: TURN_ID,
    payload: {
      state: "completed",
    },
  },
] satisfies ReadonlyArray<LegacyProviderRuntimeEvent>;

export const codexTurnApprovalFixture = [
  {
    type: "turn.started",
    ...baseEvent("evt-21", "2026-02-23T00:02:00.000Z"),
    threadId: THREAD_ID,
    turnId: TURN_ID,
    payload: {},
  },
  {
    type: "request.opened",
    ...baseEvent("evt-22", "2026-02-23T00:02:00.100Z"),
    threadId: THREAD_ID,
    turnId: TURN_ID,
    requestId: REQUEST_ID,
    payload: {
      requestType: "command_execution_approval",
      detail: "Please approve command",
    },
  },
  {
    type: "request.resolved",
    ...baseEvent("evt-23", "2026-02-23T00:02:00.200Z"),
    threadId: THREAD_ID,
    turnId: TURN_ID,
    requestId: REQUEST_ID,
    payload: {
      requestType: "command_execution_approval",
      decision: "accept",
    },
  },
  {
    type: "content.delta",
    ...baseEvent("evt-24", "2026-02-23T00:02:00.300Z"),
    threadId: THREAD_ID,
    turnId: TURN_ID,
    payload: {
      streamKind: "assistant_text",
      delta: "Approval received and command executed.\n",
    },
  },
  {
    type: "turn.completed",
    ...baseEvent("evt-25", "2026-02-23T00:02:00.400Z"),
    threadId: THREAD_ID,
    turnId: TURN_ID,
    payload: {
      state: "completed",
    },
  },
] satisfies ReadonlyArray<LegacyProviderRuntimeEvent>;

// A Claude Agent turn that spawns one subagent (Task tool) which completes.
// task.* payloads mirror packages/contracts/src/providerRuntime.ts
// TaskStartedPayload/TaskProgressPayload/TaskCompletedPayload; the fake
// adapter passes task.* events through unchanged.
export const claudeSubagentTurnFixture = [
  {
    type: "turn.started",
    ...baseEvent("evt-31", "2026-02-24T11:00:00.000Z", CLAUDE_PROVIDER),
    threadId: THREAD_ID,
    turnId: TURN_ID,
    payload: {},
  },
  {
    type: "task.started",
    ...baseEvent("evt-32", "2026-02-24T11:00:00.100Z", CLAUDE_PROVIDER),
    threadId: THREAD_ID,
    turnId: TURN_ID,
    payload: {
      taskId: "task-subagent-explore",
      description: "Explore the auth module",
      taskType: "local_agent",
      subagentType: "Explore",
      toolUseId: "toolu-spawn-explore",
    },
  },
  {
    type: "content.delta",
    ...baseEvent("evt-33", "2026-02-24T11:00:00.200Z", CLAUDE_PROVIDER),
    threadId: THREAD_ID,
    turnId: TURN_ID,
    payload: {
      streamKind: "assistant_text",
      delta: "Spawning a subagent to explore the auth module.\n",
    },
  },
  {
    type: "task.progress",
    ...baseEvent("evt-34", "2026-02-24T11:00:00.300Z", CLAUDE_PROVIDER),
    threadId: THREAD_ID,
    turnId: TURN_ID,
    payload: {
      taskId: "task-subagent-explore",
      description: "Explore the auth module",
      summary: "Reading auth entrypoints",
      lastToolName: "Read",
      usage: { inputTokens: 100, outputTokens: 20 },
    },
  },
  {
    type: "task.progress",
    ...baseEvent("evt-35", "2026-02-24T11:00:00.400Z", CLAUDE_PROVIDER),
    threadId: THREAD_ID,
    turnId: TURN_ID,
    payload: {
      taskId: "task-subagent-explore",
      description: "Explore the auth module",
      summary: "Tracing the login flow",
      lastToolName: "Grep",
      usage: { inputTokens: 250, outputTokens: 60 },
    },
  },
  {
    type: "task.completed",
    ...baseEvent("evt-36", "2026-02-24T11:00:00.500Z", CLAUDE_PROVIDER),
    threadId: THREAD_ID,
    turnId: TURN_ID,
    payload: {
      taskId: "task-subagent-explore",
      status: "completed",
      summary: "Explored the auth module and mapped the login flow.",
      toolUseId: "toolu-spawn-explore",
      usage: { inputTokens: 300, outputTokens: 80 },
    },
  },
  {
    type: "content.delta",
    ...baseEvent("evt-37", "2026-02-24T11:00:00.600Z", CLAUDE_PROVIDER),
    threadId: THREAD_ID,
    turnId: TURN_ID,
    payload: {
      streamKind: "assistant_text",
      delta: "The subagent finished exploring.\n",
    },
  },
  {
    type: "turn.completed",
    ...baseEvent("evt-38", "2026-02-24T11:00:00.700Z", CLAUDE_PROVIDER),
    threadId: THREAD_ID,
    turnId: TURN_ID,
    payload: {
      state: "completed",
    },
  },
] satisfies ReadonlyArray<LegacyProviderRuntimeEvent>;

// Same lifecycle, but the subagent settles with status "failed".
export const claudeSubagentFailedTurnFixture = [
  {
    type: "turn.started",
    ...baseEvent("evt-41", "2026-02-24T11:01:00.000Z", CLAUDE_PROVIDER),
    threadId: THREAD_ID,
    turnId: TURN_ID,
    payload: {},
  },
  {
    type: "task.started",
    ...baseEvent("evt-42", "2026-02-24T11:01:00.100Z", CLAUDE_PROVIDER),
    threadId: THREAD_ID,
    turnId: TURN_ID,
    payload: {
      taskId: "task-subagent-migrate",
      description: "Migrate the settings schema",
      taskType: "local_agent",
      subagentType: "general-purpose",
      toolUseId: "toolu-spawn-migrate",
    },
  },
  {
    type: "task.progress",
    ...baseEvent("evt-43", "2026-02-24T11:01:00.200Z", CLAUDE_PROVIDER),
    threadId: THREAD_ID,
    turnId: TURN_ID,
    payload: {
      taskId: "task-subagent-migrate",
      description: "Migrate the settings schema",
      summary: "Rewriting migration 040",
      lastToolName: "Edit",
      usage: { inputTokens: 90, outputTokens: 30 },
    },
  },
  {
    type: "task.completed",
    ...baseEvent("evt-44", "2026-02-24T11:01:00.300Z", CLAUDE_PROVIDER),
    threadId: THREAD_ID,
    turnId: TURN_ID,
    payload: {
      taskId: "task-subagent-migrate",
      status: "failed",
      summary: "Migration script crashed before finishing.",
      toolUseId: "toolu-spawn-migrate",
    },
  },
  {
    type: "content.delta",
    ...baseEvent("evt-45", "2026-02-24T11:01:00.400Z", CLAUDE_PROVIDER),
    threadId: THREAD_ID,
    turnId: TURN_ID,
    payload: {
      streamKind: "assistant_text",
      delta: "The migration subagent failed.\n",
    },
  },
  {
    type: "turn.completed",
    ...baseEvent("evt-46", "2026-02-24T11:01:00.500Z", CLAUDE_PROVIDER),
    threadId: THREAD_ID,
    turnId: TURN_ID,
    payload: {
      state: "completed",
    },
  },
] satisfies ReadonlyArray<LegacyProviderRuntimeEvent>;

// Two subagents with interleaved progress, completing out of spawn order,
// to pin that projections keep concurrent tasks distinct.
export const claudeParallelSubagentsTurnFixture = [
  {
    type: "turn.started",
    ...baseEvent("evt-51", "2026-02-24T11:02:00.000Z", CLAUDE_PROVIDER),
    threadId: THREAD_ID,
    turnId: TURN_ID,
    payload: {},
  },
  {
    type: "task.started",
    ...baseEvent("evt-52", "2026-02-24T11:02:00.100Z", CLAUDE_PROVIDER),
    threadId: THREAD_ID,
    turnId: TURN_ID,
    payload: {
      taskId: "task-parallel-a",
      description: "Audit server routes",
      taskType: "local_agent",
      subagentType: "Explore",
      toolUseId: "toolu-spawn-a",
    },
  },
  {
    type: "task.started",
    ...baseEvent("evt-53", "2026-02-24T11:02:00.150Z", CLAUDE_PROVIDER),
    threadId: THREAD_ID,
    turnId: TURN_ID,
    payload: {
      taskId: "task-parallel-b",
      description: "Audit web components",
      taskType: "local_agent",
      subagentType: "general-purpose",
      toolUseId: "toolu-spawn-b",
    },
  },
  {
    type: "task.progress",
    ...baseEvent("evt-54", "2026-02-24T11:02:00.200Z", CLAUDE_PROVIDER),
    threadId: THREAD_ID,
    turnId: TURN_ID,
    payload: {
      taskId: "task-parallel-a",
      description: "Audit server routes",
      summary: "Listing route files",
      lastToolName: "Read",
    },
  },
  {
    type: "task.progress",
    ...baseEvent("evt-55", "2026-02-24T11:02:00.250Z", CLAUDE_PROVIDER),
    threadId: THREAD_ID,
    turnId: TURN_ID,
    payload: {
      taskId: "task-parallel-b",
      description: "Audit web components",
      summary: "Listing component files",
      lastToolName: "Glob",
    },
  },
  {
    type: "task.progress",
    ...baseEvent("evt-56", "2026-02-24T11:02:00.300Z", CLAUDE_PROVIDER),
    threadId: THREAD_ID,
    turnId: TURN_ID,
    payload: {
      taskId: "task-parallel-a",
      description: "Audit server routes",
      summary: "Cross-checking route handlers",
      lastToolName: "Grep",
    },
  },
  {
    type: "task.completed",
    ...baseEvent("evt-57", "2026-02-24T11:02:00.400Z", CLAUDE_PROVIDER),
    threadId: THREAD_ID,
    turnId: TURN_ID,
    payload: {
      taskId: "task-parallel-b",
      status: "completed",
      summary: "Web components audited.",
      toolUseId: "toolu-spawn-b",
    },
  },
  {
    type: "task.completed",
    ...baseEvent("evt-58", "2026-02-24T11:02:00.500Z", CLAUDE_PROVIDER),
    threadId: THREAD_ID,
    turnId: TURN_ID,
    payload: {
      taskId: "task-parallel-a",
      status: "completed",
      summary: "Server routes audited.",
      toolUseId: "toolu-spawn-a",
    },
  },
  {
    type: "content.delta",
    ...baseEvent("evt-59", "2026-02-24T11:02:00.600Z", CLAUDE_PROVIDER),
    threadId: THREAD_ID,
    turnId: TURN_ID,
    payload: {
      streamKind: "assistant_text",
      delta: "Both subagents finished.\n",
    },
  },
  {
    type: "turn.completed",
    ...baseEvent("evt-60", "2026-02-24T11:02:00.700Z", CLAUDE_PROVIDER),
    threadId: THREAD_ID,
    turnId: TURN_ID,
    payload: {
      state: "completed",
    },
  },
] satisfies ReadonlyArray<LegacyProviderRuntimeEvent>;
