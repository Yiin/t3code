import { describe, expect, it } from "vite-plus/test";

import {
  EventId,
  MessageId,
  type OrchestrationMessage,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";

import { buildChildThreadTranscript } from "./childThreadTranscript.logic";

function message(
  id: string,
  createdAt: string,
  overrides: Partial<OrchestrationMessage> = {},
): OrchestrationMessage {
  return {
    id: MessageId.make(id),
    role: "user",
    text: id,
    turnId: null,
    streaming: false,
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}

function toolActivity(id: string, createdAt: string, sequence: number) {
  return {
    id: EventId.make(id),
    createdAt,
    kind: "tool.completed",
    payload: { toolName: "Bash", detail: "ls" },
    sequence,
    summary: id,
    tone: "tool",
    turnId: null,
  } satisfies OrchestrationThreadActivity;
}

describe("buildChildThreadTranscript", () => {
  it("interleaves the child's messages and work by time", () => {
    const transcript = buildChildThreadTranscript({
      messages: [
        message("prompt", "2026-08-12T10:00:00.000Z", { origin: "agent" }),
        message("answer", "2026-08-12T10:00:30.000Z", { role: "assistant" }),
      ],
      activities: [toolActivity("ran-ls", "2026-08-12T10:00:10.000Z", 1)],
    });

    expect(transcript.rows.map((row) => row.kind)).toEqual(["message", "work", "message"]);
    expect(transcript.toolCount).toBe(1);
    const first = transcript.rows[0];
    expect(first?.kind === "message" ? first.message.origin : null).toBe("agent");
  });

  it("keeps a subagent with no work at all as an empty transcript", () => {
    expect(buildChildThreadTranscript({ messages: [], activities: [] })).toEqual({
      rows: [],
      toolCount: 0,
    });
  });

  it("counts only tool-like work rows", () => {
    const transcript = buildChildThreadTranscript({
      messages: [],
      activities: [
        toolActivity("ran-ls", "2026-08-12T10:00:10.000Z", 1),
        {
          id: EventId.make("note"),
          createdAt: "2026-08-12T10:00:20.000Z",
          kind: "session.updated",
          payload: {},
          sequence: 2,
          summary: "Session ready",
          tone: "info",
          turnId: null,
        },
      ],
    });

    expect(transcript.rows).toHaveLength(2);
    expect(transcript.toolCount).toBe(1);
  });
});
