import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import type { WorkLogEntry } from "../../session-logic";
import {
  SubagentInspectorPanel,
  SubagentInspectorPlaceholder,
  SubagentTranscriptEntryRow,
} from "./SubagentInspectorPanel";
import { SUBAGENT_DRAWER_PLACEHOLDER } from "./SubagentDrawerComposer";
import { IN_PROCESS_SUBAGENT_NOTICE, PARENT_MEDIATED_NOTICE } from "./SubagentInspectorFooter";
import {
  buildSubagentRoster,
  UNADDRESSABLE_SUBAGENT_REASON,
  type SubagentRosterEntry,
} from "./subagentRoster.logic";

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

const panelNowMs = Date.parse("2026-08-06T12:00:00.000Z");

function renderPanel(input: {
  roster: ReadonlyArray<SubagentRosterEntry>;
  activeSubagentKey: string;
}) {
  return renderToStaticMarkup(
    <SubagentInspectorPanel
      activeSubagentKey={input.activeSubagentKey}
      activities={[]}
      markdownCwd={undefined}
      nowMs={panelNowMs}
      onInterrupt={async () => undefined}
      onSelectSubagent={() => {}}
      onSendToSubagentThread={async () => null}
      onSteer={async () => null}
      onStop={async () => null}
      roster={input.roster}
      skills={[]}
      threadRef={commonProps.threadRef}
      workspaceRoot={undefined}
    />,
  );
}

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

describe("SubagentInspectorPanel", () => {
  it("renders a read-model-only subagent instead of the unavailable message", () => {
    const roster = buildSubagentRoster({
      groups: [],
      subagents: [
        {
          subagentId: "agent-1",
          turnId: null,
          agentType: "explore",
          description: "Sweep the parser",
          status: "running",
          lastProgressSummary: "Reading files",
          startedAt: "2026-08-06T11:55:00.000Z",
          updatedAt: "2026-08-06T11:59:00.000Z",
          completedAt: null,
        },
      ],
    });

    const markup = renderToStaticMarkup(
      <SubagentInspectorPanel
        activeSubagentKey="agent-1"
        activities={[]}
        markdownCwd={undefined}
        onInterrupt={async () => undefined}
        onSelectSubagent={() => {}}
        onSendToSubagentThread={async () => null}
        onSteer={async () => null}
        onStop={async () => null}
        roster={roster}
        skills={[]}
        threadRef={commonProps.threadRef}
        workspaceRoot={undefined}
      />,
    );

    expect(markup).not.toContain("This subagent is no longer available.");
    expect(markup).toContain("Explore");
    expect(markup).toContain("Running");
    expect(markup).not.toContain("Spawn prompt");
    expect(markup).toContain("reported by the provider");
  });

  it("states why a group-only subagent cannot be addressed, and offers no composer", () => {
    const markup = renderPanel({
      roster: buildSubagentRoster({
        groups: [
          {
            entryId: "work-spawn-1",
            toolCallId: "toolu_1",
            name: "explore",
            description: "Find the source",
            status: "running",
            startedAt: "2026-08-06T11:55:00.000Z",
            completedAt: null,
            children: [],
            resultText: null,
            prompt: null,
          },
        ],
        subagents: [],
      }),
      activeSubagentKey: "toolu_1",
    });

    expect(markup).toContain(UNADDRESSABLE_SUBAGENT_REASON);
    expect(markup).not.toContain('data-slot="textarea"');
    expect(markup).not.toContain(PARENT_MEDIATED_NOTICE);
    expect(markup).toContain("spawned by Task");
  });

  it("offers a composer and names the parent hop for a fresh running subagent", () => {
    const markup = renderPanel({
      roster: buildSubagentRoster({
        groups: [],
        subagents: [
          {
            subagentId: "agent-1",
            turnId: null,
            spawnedByItemId: "toolu_1",
            agentType: "explore",
            status: "running",
            startedAt: "2026-08-06T11:55:00.000Z",
            updatedAt: "2026-08-06T11:59:00.000Z",
            completedAt: null,
          },
        ],
      }),
      activeSubagentKey: "toolu_1",
    });

    expect(markup).toContain('data-slot="textarea"');
    expect(markup).toContain(PARENT_MEDIATED_NOTICE);
    expect(markup).toContain(IN_PROCESS_SUBAGENT_NOTICE);
    expect(markup).toContain("spawned by Task");
  });

  it("gives a thread-backed child its own composer and drops the parent hop", () => {
    const markup = renderPanel({
      roster: buildSubagentRoster({
        groups: [],
        subagents: [
          {
            subagentId: "thread-child-1",
            turnId: null,
            spawnedByItemId: "toolu_1",
            childThreadId: ThreadId.make("thread-child-1"),
            agentType: "explore",
            status: "running",
            startedAt: "2026-08-06T11:55:00.000Z",
            updatedAt: "2026-08-06T11:59:00.000Z",
            completedAt: null,
          },
        ],
      }),
      activeSubagentKey: "toolu_1",
    });

    expect(markup).toContain('data-subagent-footer-mode="child-thread"');
    expect(markup).toContain(SUBAGENT_DRAWER_PLACEHOLDER);
    // The child has an inbox of its own, so neither parent sentence applies.
    expect(markup).not.toContain(PARENT_MEDIATED_NOTICE);
    expect(markup).not.toContain(IN_PROCESS_SUBAGENT_NOTICE);
    // The Stop button stays reachable in every mode.
    expect(markup).toContain("Stop");
  });

  it("hides the composer for a settled subagent instead of disabling it", () => {
    const markup = renderPanel({
      roster: buildSubagentRoster({
        groups: [],
        subagents: [
          {
            subagentId: "agent-1",
            turnId: null,
            spawnedByItemId: "toolu_1",
            agentType: "explore",
            status: "completed",
            startedAt: "2026-08-06T11:55:00.000Z",
            updatedAt: "2026-08-06T11:59:00.000Z",
            completedAt: "2026-08-06T11:59:00.000Z",
          },
        ],
      }),
      activeSubagentKey: "toolu_1",
    });

    expect(markup).toContain('data-subagent-footer-mode="read-only"');
    expect(markup).toContain("This subagent is no longer running.");
    expect(markup).not.toContain('data-slot="textarea"');
    expect(markup).not.toContain(SUBAGENT_DRAWER_PLACEHOLDER);
  });
});
