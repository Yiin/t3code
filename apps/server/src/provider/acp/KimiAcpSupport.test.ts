import { describe, expect, it } from "vite-plus/test";

import type * as EffectAcpSchema from "effect-acp/schema";

import {
  type AcpToolCallState,
  mergeToolCallState,
  parseSessionUpdateEvent,
} from "./AcpRuntimeModel.ts";
import { makeKimiSubagentTaskTracker, trackKimiSubagentToolCall } from "./KimiAcpSupport.ts";

// Fixtures mirror the live-captured kimi session at
// $stateDir/logs/provider/40a5b1d3-3e16-4c0a-9e33-d786b73110e7.log:272,294.
const SESSION_ID = "session_a1d38d69-e4ee-43b3-9678-19d3f57140cd";
const SUBAGENT_TOOL_CALL_ID = "6:tool_4sJJeYkrj0rTebALnpCuv4XQ";
const SUBAGENT_PROMPT =
  "You are a skeptical reviewer verifying a fix increment. Do NOT modify files.";
const SUBAGENT_DESCRIPTION = "Re-review recovery injection fix";

function textContent(text: string) {
  return [{ type: "content", content: { type: "text", text } }] as const;
}

// The prompt streams in as JSON text on many early updates that carry neither
// kind nor rawInput (captured shape).
const streamingUpdateNotification = {
  sessionId: SESSION_ID,
  update: {
    sessionUpdate: "tool_call_update",
    toolCallId: SUBAGENT_TOOL_CALL_ID,
    status: "in_progress",
    content: textContent(`{"description":"${SUBAGENT_DESCRIPTION}","prompt":"${SUBAGENT_PROMPT}"`),
  },
} satisfies EffectAcpSchema.SessionNotification;

// The spawn signal: kind "other" plus rawInput.subagent_type (log line 272).
const spawnUpdateNotification = {
  sessionId: SESSION_ID,
  update: {
    sessionUpdate: "tool_call_update",
    toolCallId: SUBAGENT_TOOL_CALL_ID,
    status: "in_progress",
    kind: "other",
    title: "Launching explore agent: Re-review recovery injection fix",
    rawInput: {
      description: SUBAGENT_DESCRIPTION,
      prompt: SUBAGENT_PROMPT,
      subagent_type: "explore",
    },
    content: textContent(`{"description":"${SUBAGENT_DESCRIPTION}","prompt":"${SUBAGENT_PROMPT}"`),
  },
} satisfies EffectAcpSchema.SessionNotification;

const COMPLETION_TEXT =
  "agent_id: agent-8\nactual_subagent_type: explore\nstatus: completed\n\n[summary]\n**Verdict: APPROVE-WITH-NITS**\n\n**1. Fail-open mint — correct.**";

// The terminal update (log line 294): status completed, content text starting
// with the agent_id/actual_subagent_type/status header, no kind or rawInput.
const completionUpdateNotification = {
  sessionId: SESSION_ID,
  update: {
    sessionUpdate: "tool_call_update",
    toolCallId: SUBAGENT_TOOL_CALL_ID,
    status: "completed",
    content: textContent(COMPLETION_TEXT),
  },
} satisfies EffectAcpSchema.SessionNotification;

function parseAndMerge(
  previous: AcpToolCallState | undefined,
  notification: EffectAcpSchema.SessionNotification,
): AcpToolCallState {
  const { events } = parseSessionUpdateEvent(notification);
  const event = events[0];
  if (event === undefined || event._tag !== "ToolCallUpdated") {
    throw new Error("Expected a ToolCallUpdated event.");
  }
  return mergeToolCallState(previous, event.toolCall);
}

describe("KimiAcpSupport subagent heuristic", () => {
  it("does not classify regular tool calls as subagents", () => {
    const tracker = makeKimiSubagentTaskTracker();
    const toolCall = parseAndMerge(undefined, {
      sessionId: SESSION_ID,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "6:tool_oJcD0bY8WLyGYcfN0ypokXoT",
        status: "completed",
        kind: "execute",
        rawInput: { command: "git diff HEAD" },
        content: textContent("diff --git a/x b/x"),
      },
    } satisfies EffectAcpSchema.SessionNotification);

    expect(trackKimiSubagentToolCall(tracker, toolCall)).toEqual({
      isSubagentToolCall: false,
    });
  });

  it("emits task started exactly once for the captured spawn shape", () => {
    const tracker = makeKimiSubagentTaskTracker();

    // Early streaming updates carry no rawInput and must not trigger.
    const streaming = parseAndMerge(undefined, streamingUpdateNotification);
    expect(trackKimiSubagentToolCall(tracker, streaming)).toEqual({
      isSubagentToolCall: false,
    });

    const spawned = parseAndMerge(streaming, spawnUpdateNotification);
    const signals = trackKimiSubagentToolCall(tracker, spawned);
    expect(signals.isSubagentToolCall).toBe(true);
    expect(signals.started).toEqual({
      toolCallId: SUBAGENT_TOOL_CALL_ID,
      subagentType: "explore",
      description: SUBAGENT_DESCRIPTION,
      prompt: SUBAGENT_PROMPT,
    });
    expect(signals.completed).toBeUndefined();

    // Later merged updates keep the classification but never re-start.
    const streamedAgain = parseAndMerge(spawned, streamingUpdateNotification);
    const repeat = trackKimiSubagentToolCall(tracker, streamedAgain);
    expect(repeat.isSubagentToolCall).toBe(true);
    expect(repeat.started).toBeUndefined();
    expect(repeat.completed).toBeUndefined();
  });

  it("maps the captured completion header to a completed task signal", () => {
    const tracker = makeKimiSubagentTaskTracker();
    const spawned = parseAndMerge(undefined, spawnUpdateNotification);
    trackKimiSubagentToolCall(tracker, spawned);

    const completedState = parseAndMerge(spawned, completionUpdateNotification);
    const signals = trackKimiSubagentToolCall(tracker, completedState);
    expect(signals.isSubagentToolCall).toBe(true);
    expect(signals.started).toBeUndefined();
    expect(signals.completed).toEqual({
      toolCallId: SUBAGENT_TOOL_CALL_ID,
      status: "completed",
      agentId: "agent-8",
      subagentType: "explore",
      summary: "[summary]\n**Verdict: APPROVE-WITH-NITS**\n\n**1. Fail-open mint — correct.**",
    });

    // A repeated terminal update never re-emits the completion.
    expect(trackKimiSubagentToolCall(tracker, completedState)).toEqual({
      isSubagentToolCall: true,
    });
  });

  it("trusts the completion header status over the ACP tool-call status", () => {
    const tracker = makeKimiSubagentTaskTracker();
    const spawned = parseAndMerge(undefined, spawnUpdateNotification);
    trackKimiSubagentToolCall(tracker, spawned);

    const failedState = parseAndMerge(spawned, {
      sessionId: SESSION_ID,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: SUBAGENT_TOOL_CALL_ID,
        status: "completed",
        content: textContent(
          "agent_id: agent-9\nactual_subagent_type: explore\nstatus: failed\n\nThe agent hit an error.",
        ),
      },
    } satisfies EffectAcpSchema.SessionNotification);

    expect(trackKimiSubagentToolCall(tracker, failedState).completed).toEqual({
      toolCallId: SUBAGENT_TOOL_CALL_ID,
      status: "failed",
      agentId: "agent-9",
      subagentType: "explore",
      summary: "The agent hit an error.",
    });
  });

  it("falls back to the ACP status when the completion header is missing", () => {
    const tracker = makeKimiSubagentTaskTracker();
    const spawned = parseAndMerge(undefined, spawnUpdateNotification);
    trackKimiSubagentToolCall(tracker, spawned);

    const failedState = parseAndMerge(spawned, {
      sessionId: SESSION_ID,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: SUBAGENT_TOOL_CALL_ID,
        status: "failed",
        content: textContent("subagent process crashed"),
      },
    } satisfies EffectAcpSchema.SessionNotification);

    expect(trackKimiSubagentToolCall(tracker, failedState).completed).toEqual({
      toolCallId: SUBAGENT_TOOL_CALL_ID,
      status: "failed",
      summary: "subagent process crashed",
    });
  });

  it("synthesizes a start when only the terminal header is observed", () => {
    const tracker = makeKimiSubagentTaskTracker();
    const completedState = parseAndMerge(undefined, completionUpdateNotification);

    const signals = trackKimiSubagentToolCall(tracker, completedState);
    expect(signals.isSubagentToolCall).toBe(true);
    expect(signals.started).toEqual({
      toolCallId: SUBAGENT_TOOL_CALL_ID,
      subagentType: "explore",
    });
    expect(signals.completed).toMatchObject({
      toolCallId: SUBAGENT_TOOL_CALL_ID,
      status: "completed",
      agentId: "agent-8",
    });
  });
});
