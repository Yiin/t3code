import { ProviderInstanceId, ProviderRuntimeEvent, ThreadId, TurnId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  initialPrimeEventMapperState,
  mapPrimeRpcEvent,
  settlePrimePermissionRequests,
  type PrimeEventMapperState,
} from "./PrimeEventMapper.ts";
import { PrimeRpcMappableEvent } from "./PrimeRpcEvents.ts";

const decodePrime = Schema.decodeUnknownSync(PrimeRpcMappableEvent);
const decodeRuntime = Schema.decodeUnknownSync(ProviderRuntimeEvent);
const context = (sequence: number) => ({
  threadId: ThreadId.make("thread-1"),
  turnId: TurnId.make("turn-1"),
  providerInstanceId: ProviderInstanceId.make("prime-work"),
  createdAt: "2026-08-09T00:00:00.000Z",
  sequence,
});

function mapSequence(fixtures: ReadonlyArray<unknown>) {
  let state: PrimeEventMapperState = initialPrimeEventMapperState();
  return fixtures.flatMap((fixture, sequence) => {
    const result = mapPrimeRpcEvent(state, decodePrime(fixture), context(sequence));
    state = result.state;
    return result.events.map((event) => decodeRuntime(event));
  });
}

describe("PrimeEventMapper", () => {
  it("maps message boundaries and only emits streamed text and thinking deltas", () => {
    const events = mapSequence([
      { type: "agent_start" },
      { type: "message_start", message: { id: "message-1", role: "assistant" } },
      {
        type: "message_update",
        message: { id: "message-1", role: "assistant", content: [{ type: "text", text: "Hi" }] },
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hi" },
      },
      {
        type: "message_update",
        message: { id: "message-1", role: "assistant" },
        assistantMessageEvent: { type: "thinking_delta", contentIndex: 1, delta: "Think" },
      },
      {
        type: "message_update",
        message: { id: "message-1", role: "assistant" },
        assistantMessageEvent: { type: "text_end", contentIndex: 0 },
      },
      { type: "message_end", message: { id: "message-1", role: "assistant" } },
      { type: "message_end", message: { id: "message-1", role: "assistant" } },
      { type: "agent_settled" },
    ]);

    expect(events.map((event) => event.type)).toEqual([
      "turn.started",
      "item.started",
      "content.delta",
      "content.delta",
      "item.completed",
      "turn.completed",
    ]);
    expect(
      events.filter((event) => event.type === "content.delta").map((event) => event.payload),
    ).toEqual([
      { streamKind: "assistant_text", delta: "Hi", contentIndex: 0 },
      { streamKind: "reasoning_text", delta: "Think", contentIndex: 1 },
    ]);
    expect(new Set(events.map((event) => event.eventId)).size).toBe(events.length);
    expect(events.every((event) => event.raw?.source === "prime.rpc")).toBe(true);
  });

  it("maps tool, compaction, retry, subagent, permission, and extension events", () => {
    const events = mapSequence([
      {
        type: "tool_execution_start",
        toolCallId: "tool-1",
        toolName: "ipython",
        args: { code: "1+1" },
      },
      {
        type: "tool_execution_update",
        toolCallId: "tool-1",
        toolName: "ipython",
        args: {},
        partialResult: { content: [] },
      },
      {
        type: "tool_execution_end",
        toolCallId: "tool-1",
        toolName: "ipython",
        result: { content: [{ type: "text", text: "2" }] },
        isError: false,
      },
      { type: "compaction_start", reason: "threshold" },
      {
        type: "compaction_end",
        reason: "threshold",
        result: { summary: "short" },
        aborted: false,
        willRetry: false,
      },
      { type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 20, errorMessage: "busy" },
      { type: "auto_retry_end", success: true, attempt: 1 },
      { type: "bash_execution_update", delta: "more output" },
      { type: "queue_update", steering: ["change"], followUp: [] },
      {
        type: "summarization_retry_scheduled",
        attempt: 1,
        maxAttempts: 3,
        delayMs: 20,
        errorMessage: "busy",
      },
      {
        type: "summarization_retry_attempt_start",
        source: "compaction",
        reason: "threshold",
      },
      { type: "summarization_retry_finished" },
      { type: "subagent_start", taskId: "task-1", description: "Inspect" },
      { type: "subagent_update", taskId: "task-1", description: "Reading" },
      { type: "subagent_end", taskId: "task-1", status: "completed", summary: "Done" },
      {
        type: "extension_ui_request",
        id: "request-1",
        method: "select",
        title: "Allow?",
        options: ["Allow once", "Decline"],
      },
      { type: "extension_ui_response", id: "request-1", value: "Allow once" },
      {
        type: "extension_error",
        extensionPath: "/extension.mjs",
        event: "tool_call",
        error: "hook failed",
      },
    ]);

    expect(events.map((event) => event.type)).toEqual([
      "item.started",
      "item.updated",
      "item.completed",
      "item.started",
      "item.completed",
      "thread.state.changed",
      "runtime.warning",
      "content.delta",
      "thread.state.changed",
      "runtime.warning",
      "item.updated",
      "runtime.warning",
      "task.started",
      "task.progress",
      "task.completed",
      "request.opened",
      "request.resolved",
      "runtime.error",
    ]);
    expect(events.find((event) => event.type === "request.opened")?.requestId).toBe("request-1");
    const compactionEvents = events.filter(
      (event) => "itemType" in event.payload && event.payload.itemType === "context_compaction",
    );
    expect(compactionEvents[0]?.itemId).toBe(compactionEvents[1]?.itemId);
  });

  it("does not regress a terminal turn after cancellation or failure", () => {
    const events = mapSequence([
      { type: "agent_start" },
      {
        type: "message_update",
        message: { role: "assistant" },
        assistantMessageEvent: {
          type: "error",
          reason: "aborted",
          error: { role: "assistant", errorMessage: "stopped" },
        },
      },
      { type: "agent_settled" },
      { type: "agent_start" },
    ]);
    expect(events.map((event) => event.type)).toEqual(["turn.started", "turn.aborted"]);
  });

  it("settles every pending permission request when the run stops or an extension fails", () => {
    const stopped = mapSequence([
      {
        type: "extension_ui_request",
        id: "request-1",
        method: "select",
        title: "Allow?",
        options: ["Allow once", "Decline"],
      },
      {
        type: "message_update",
        message: { role: "assistant" },
        assistantMessageEvent: {
          type: "error",
          reason: "aborted",
          error: { role: "assistant", errorMessage: "interrupted" },
        },
      },
      { type: "agent_settled" },
    ]);
    expect(stopped.map((event) => event.type)).toEqual([
      "request.opened",
      "request.resolved",
      "turn.aborted",
    ]);
    expect(stopped[1]?.payload).toMatchObject({ decision: "cancel" });

    const crashed = mapSequence([
      {
        type: "extension_ui_request",
        id: "request-2",
        method: "select",
        title: "Allow?",
        options: ["Allow once", "Decline"],
      },
      {
        type: "extension_error",
        extensionPath: "/extension.mjs",
        event: "tool_call",
        error: "crashed",
      },
    ]);
    expect(crashed.map((event) => event.type)).toEqual([
      "request.opened",
      "request.resolved",
      "runtime.error",
    ]);
    expect(crashed[1]?.payload).toMatchObject({ decision: "decline" });
  });

  it.each(["interrupt", "stop", "crash"] as const)(
    "exposes adapter settlement for a pending request on %s",
    (reason) => {
      const opened = mapPrimeRpcEvent(
        initialPrimeEventMapperState(),
        decodePrime({
          type: "extension_ui_request",
          id: "request-1",
          method: "select",
          title: "Allow?",
          options: ["Allow once", "Decline"],
        }),
        context(0),
      );
      const settled = settlePrimePermissionRequests(opened.state, context(1), reason);
      expect(settled.events).toHaveLength(1);
      const event = settled.events[0];
      expect(event).toBeDefined();
      if (!event) throw new Error("missing settlement event");
      expect(decodeRuntime(event).payload).toMatchObject({
        decision: reason === "crash" ? "decline" : "cancel",
      });
      expect(settled.state.pendingRequestIds.size).toBe(0);

      const lateResponse = mapPrimeRpcEvent(
        settled.state,
        decodePrime({
          type: "extension_ui_response",
          id: "request-1",
          value: "Allow once",
        }),
        context(2),
      );
      expect(lateResponse.events).toEqual([]);
    },
  );

  it("waits for settlement and clears a transient error after a successful retry", () => {
    const events = mapSequence([
      { type: "agent_start" },
      {
        type: "message_update",
        message: { role: "assistant" },
        assistantMessageEvent: {
          type: "error",
          reason: "error",
          error: { role: "assistant", errorMessage: "overloaded" },
        },
      },
      {
        type: "auto_retry_start",
        attempt: 1,
        maxAttempts: 3,
        delayMs: 20,
        errorMessage: "overloaded",
      },
      { type: "auto_retry_end", success: true, attempt: 1 },
      { type: "agent_settled" },
    ]);
    expect(events.map((event) => event.type)).toEqual([
      "turn.started",
      "runtime.warning",
      "turn.completed",
    ]);
    expect(events.at(-1)?.payload).toMatchObject({ state: "completed" });
  });

  it("uses one stable fallback item id for consecutive id-less bash chunks", () => {
    const events = mapSequence([
      { type: "bash_execution_update", delta: "first" },
      { type: "bash_execution_update", delta: "second" },
    ]);
    expect(events).toHaveLength(2);
    expect(events[0]?.itemId).toBe("prime-bash:turn-1:direct");
    expect(events[1]?.itemId).toBe(events[0]?.itemId);
  });
});
