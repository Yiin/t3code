import {
  EventId,
  ProviderDriverKind,
  RuntimeRequestId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  makeAcpAssistantItemEvent,
  makeAcpContentDeltaEvent,
  makeAcpPlanUpdatedEvent,
  makeAcpRequestOpenedEvent,
  makeAcpRequestResolvedEvent,
  makeAcpTaskCompletedEvent,
  makeAcpTaskStartedEvent,
  makeAcpToolCallEvent,
} from "./AcpCoreRuntimeEvents.ts";

describe("AcpCoreRuntimeEvents", () => {
  it("maps ACP permission requests to canonical runtime events", () => {
    const stamp = { eventId: EventId.make("event-1"), createdAt: "2026-03-27T00:00:00.000Z" };
    const turnId = TurnId.make("turn-1");
    const permissionRequest = {
      kind: "execute" as const,
      detail: "cat package.json",
      toolCall: {
        toolCallId: "tool-1",
        kind: "execute",
        status: "pending" as const,
        command: "cat package.json",
        detail: "cat package.json",
        data: { toolCallId: "tool-1", kind: "execute" },
      },
    };

    expect(
      makeAcpRequestOpenedEvent({
        stamp,
        provider: ProviderDriverKind.make("cursor"),
        threadId: ThreadId.make("thread-1"),
        turnId,
        requestId: RuntimeRequestId.make("request-1"),
        permissionRequest,
        detail: "cat package.json",
        args: { command: ["cat", "package.json"] },
        source: "acp.jsonrpc",
        method: "session/request_permission",
        rawPayload: { sessionId: "session-1" },
      }),
    ).toMatchObject({
      type: "request.opened",
      payload: {
        requestType: "exec_command_approval",
        detail: "cat package.json",
      },
    });

    expect(
      makeAcpRequestResolvedEvent({
        stamp,
        provider: ProviderDriverKind.make("cursor"),
        threadId: ThreadId.make("thread-1"),
        turnId,
        requestId: RuntimeRequestId.make("request-1"),
        permissionRequest,
        decision: "accept",
      }),
    ).toMatchObject({
      type: "request.resolved",
      payload: {
        requestType: "exec_command_approval",
        decision: "accept",
      },
    });
  });

  it("maps ACP core plan, tool-call, and content updates", () => {
    const stamp = { eventId: EventId.make("event-1"), createdAt: "2026-03-27T00:00:00.000Z" };
    const turnId = TurnId.make("turn-1");

    expect(
      makeAcpPlanUpdatedEvent({
        stamp,
        provider: ProviderDriverKind.make("cursor"),
        threadId: ThreadId.make("thread-1"),
        turnId,
        payload: {
          plan: [{ step: "Inspect state", status: "inProgress" }],
        },
        source: "acp.cursor.extension",
        method: "cursor/update_todos",
        rawPayload: { todos: [] },
      }),
    ).toMatchObject({
      type: "turn.plan.updated",
      raw: {
        method: "cursor/update_todos",
      },
    });

    expect(
      makeAcpToolCallEvent({
        stamp,
        provider: ProviderDriverKind.make("cursor"),
        threadId: ThreadId.make("thread-1"),
        turnId,
        toolCall: {
          toolCallId: "tool-1",
          kind: "execute",
          status: "completed",
          title: "Terminal",
          detail: "bun run test",
          data: { command: "bun run test" },
        },
        rawPayload: { sessionId: "session-1" },
      }),
    ).toMatchObject({
      type: "item.completed",
      payload: {
        itemType: "command_execution",
        status: "completed",
      },
    });

    expect(
      makeAcpContentDeltaEvent({
        stamp,
        provider: ProviderDriverKind.make("cursor"),
        threadId: ThreadId.make("thread-1"),
        turnId,
        itemId: "assistant:session-1:segment:0",
        text: "hello",
        rawPayload: { sessionId: "session-1" },
      }),
    ).toMatchObject({
      type: "content.delta",
      itemId: "assistant:session-1:segment:0",
      payload: {
        delta: "hello",
      },
    });

    expect(
      makeAcpAssistantItemEvent({
        stamp,
        provider: ProviderDriverKind.make("cursor"),
        threadId: ThreadId.make("thread-1"),
        turnId,
        itemId: "assistant:session-1:segment:0",
        lifecycle: "item.started",
      }),
    ).toMatchObject({
      type: "item.started",
      itemId: "assistant:session-1:segment:0",
      payload: {
        itemType: "assistant_message",
        status: "inProgress",
      },
    });
  });

  it("honors the item type override for classified tool calls", () => {
    const stamp = { eventId: EventId.make("event-1"), createdAt: "2026-03-27T00:00:00.000Z" };

    expect(
      makeAcpToolCallEvent({
        stamp,
        provider: ProviderDriverKind.make("kimi"),
        threadId: ThreadId.make("thread-1"),
        turnId: TurnId.make("turn-1"),
        toolCall: {
          toolCallId: "tool-1",
          kind: "other",
          status: "inProgress",
          title: "Launching explore agent: Review the fix",
          data: { toolCallId: "tool-1" },
        },
        itemType: "collab_agent_tool_call",
        rawPayload: { sessionId: "session-1" },
      }),
    ).toMatchObject({
      type: "item.updated",
      payload: {
        itemType: "collab_agent_tool_call",
        status: "inProgress",
      },
    });
  });

  it("maps ACP subagent task lifecycle events", () => {
    const stamp = { eventId: EventId.make("event-1"), createdAt: "2026-03-27T00:00:00.000Z" };
    const turnId = TurnId.make("turn-1");

    expect(
      makeAcpTaskStartedEvent({
        stamp,
        provider: ProviderDriverKind.make("kimi"),
        threadId: ThreadId.make("thread-1"),
        turnId,
        taskId: "tool-1",
        toolUseId: "tool-1",
        subagentType: "explore",
        description: "Review the fix",
        prompt: "You are a skeptical reviewer.",
        source: "acp.jsonrpc",
        method: "session/update",
        rawPayload: { sessionId: "session-1" },
      }),
    ).toEqual({
      type: "task.started",
      eventId: "event-1",
      createdAt: "2026-03-27T00:00:00.000Z",
      provider: "kimi",
      threadId: "thread-1",
      turnId,
      payload: {
        taskId: "tool-1",
        toolUseId: "tool-1",
        subagentType: "explore",
        description: "Review the fix",
        prompt: "You are a skeptical reviewer.",
      },
      raw: {
        source: "acp.jsonrpc",
        method: "session/update",
        payload: { sessionId: "session-1" },
      },
    });

    expect(
      makeAcpTaskCompletedEvent({
        stamp,
        provider: ProviderDriverKind.make("cursor"),
        threadId: ThreadId.make("thread-1"),
        turnId,
        taskId: "tool-1",
        toolUseId: "tool-1",
        status: "failed",
        summary: "The subagent hit an error.",
        source: "acp.cursor.extension",
        method: "cursor/task",
        rawPayload: { toolCallId: "tool-1" },
      }),
    ).toEqual({
      type: "task.completed",
      eventId: "event-1",
      createdAt: "2026-03-27T00:00:00.000Z",
      provider: "cursor",
      threadId: "thread-1",
      turnId,
      payload: {
        taskId: "tool-1",
        status: "failed",
        toolUseId: "tool-1",
        summary: "The subagent hit an error.",
      },
      raw: {
        source: "acp.cursor.extension",
        method: "cursor/task",
        payload: { toolCallId: "tool-1" },
      },
    });
  });

  it("drops empty optional task fields instead of emitting blanks", () => {
    const stamp = { eventId: EventId.make("event-1"), createdAt: "2026-03-27T00:00:00.000Z" };

    const started = makeAcpTaskStartedEvent({
      stamp,
      provider: ProviderDriverKind.make("kimi"),
      threadId: ThreadId.make("thread-1"),
      turnId: undefined,
      taskId: "tool-1",
      subagentType: "  ",
      description: "",
      source: "acp.jsonrpc",
      method: "session/update",
      rawPayload: {},
    });
    expect(started.payload).toEqual({ taskId: "tool-1" });

    const completed = makeAcpTaskCompletedEvent({
      stamp,
      provider: ProviderDriverKind.make("kimi"),
      threadId: ThreadId.make("thread-1"),
      turnId: undefined,
      taskId: "tool-1",
      status: "completed",
      summary: "   ",
      source: "acp.jsonrpc",
      method: "session/update",
      rawPayload: {},
    });
    expect(completed.payload).toEqual({ taskId: "tool-1", status: "completed" });
  });
});
