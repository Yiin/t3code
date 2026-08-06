import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import type { WorkLogEntry } from "../../session-logic";
import { SubagentInspectorPlaceholder, SubagentTranscriptEntryRow } from "./SubagentInspectorPanel";

const commonProps = {
  markdownCwd: undefined,
  skills: [],
  threadRef: {
    environmentId: EnvironmentId.make("environment-1"),
    threadId: ThreadId.make("thread-1"),
  },
  workspaceRoot: undefined,
  turnSettled: false,
};

function entry(
  kind: string,
  payload: unknown,
  overrides: Partial<WorkLogEntry> = {},
): WorkLogEntry {
  return {
    id: "entry-1",
    createdAt: "2026-08-06T12:00:00.000Z",
    label: "Generic fallback",
    tone: "info",
    sourceActivityKind: kind,
    sourceActivityPayload: payload,
    ...overrides,
  };
}

describe("SubagentTranscriptEntryRow", () => {
  it("renders loading and explicit unavailable-data states", () => {
    const loadingMarkup = renderToStaticMarkup(<SubagentInspectorPlaceholder state="loading" />);
    const unavailableMarkup = renderToStaticMarkup(
      <SubagentInspectorPlaceholder state="unavailable" />,
    );

    expect(loadingMarkup).toContain("Loading subagent details…");
    expect(unavailableMarkup).toContain("No subagent details are available for this run.");
  });

  it("renders thinking collapsed with a truncated marker", () => {
    const markup = renderToStaticMarkup(
      <SubagentTranscriptEntryRow
        {...commonProps}
        workEntry={entry("subagent.thinking", {
          parentToolUseId: "task-1",
          text: "**Inspect** the parser",
          truncated: true,
        })}
      />,
    );

    expect(markup).toContain("<details");
    expect(markup).not.toContain("<details open");
    expect(markup).toContain("Thinking");
    expect(markup).toContain("<strong>Inspect</strong>");
    expect(markup).toContain("… truncated");
  });

  it("falls back to a generic work row for a malformed transcript payload", () => {
    const markup = renderToStaticMarkup(
      <SubagentTranscriptEntryRow
        {...commonProps}
        workEntry={entry("subagent.text", { text: "Missing parent id" })}
      />,
    );

    expect(markup).toContain("Generic fallback");
    expect(markup).not.toContain("Missing parent id");
  });
});
