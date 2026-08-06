import { describe, expect, it } from "vite-plus/test";

import type { WorkLogEntry } from "../../session-logic";
import {
  decodeSubagentTranscriptRow,
  summarizeSubagentUsage,
} from "./SubagentInspectorPanel.logic";

function transcriptEntry(payload: unknown): WorkLogEntry {
  return {
    id: "text-1",
    createdAt: "2026-08-06T12:00:00.000Z",
    label: "Subagent text",
    tone: "info",
    sourceActivityKind: "subagent.text",
    sourceActivityPayload: payload,
  };
}

describe("decodeSubagentTranscriptRow", () => {
  it("preserves the truncated marker", () => {
    expect(
      decodeSubagentTranscriptRow(
        transcriptEntry({ parentToolUseId: "task-1", text: "Partial answer", truncated: true }),
      ),
    ).toEqual({ kind: "text", text: "Partial answer", truncated: true });
  });

  it("returns null for malformed payloads so the caller can render a generic row", () => {
    expect(decodeSubagentTranscriptRow(transcriptEntry({ text: "Missing parent id" }))).toBeNull();
  });
});

describe("summarizeSubagentUsage", () => {
  it("sums snake_case input and cache token fields", () => {
    expect(
      summarizeSubagentUsage({
        input_tokens: 1_000,
        cache_read_input_tokens: 2_000,
        cache_creation_input_tokens: 500,
        output_tokens: 250,
      }),
    ).toEqual({ inputTokens: 3_500, outputTokens: 250, totalTokens: 3_750 });
  });

  it("reads camelCase fields", () => {
    expect(
      summarizeSubagentUsage({
        inputTokens: 100,
        cacheReadInputTokens: 200,
        cacheCreationInputTokens: 50,
        outputTokens: 25,
      }),
    ).toEqual({ inputTokens: 350, outputTokens: 25, totalTokens: 375 });
  });

  it("returns nulls for garbage", () => {
    expect(summarizeSubagentUsage("bad data")).toEqual({
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
    });
    expect(summarizeSubagentUsage({ input_tokens: "100", outputTokens: Number.NaN })).toEqual({
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
    });
  });

  it("keeps partial numeric fields", () => {
    expect(summarizeSubagentUsage({ cache_read_input_tokens: 80 })).toEqual({
      inputTokens: 80,
      outputTokens: null,
      totalTokens: 80,
    });
    expect(summarizeSubagentUsage({ outputTokens: 20 })).toEqual({
      inputTokens: null,
      outputTokens: 20,
      totalTokens: 20,
    });
    expect(summarizeSubagentUsage({ input_tokens: "bad", inputTokens: 30 })).toEqual({
      inputTokens: 30,
      outputTokens: null,
      totalTokens: 30,
    });
  });
});
