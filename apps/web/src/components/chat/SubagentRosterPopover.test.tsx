import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { SubagentRosterList, SubagentRosterPopover } from "./SubagentRosterPopover";
import type { SubagentRosterEntry } from "./subagentRoster.logic";

function entry(
  overrides: Partial<SubagentRosterEntry> & Pick<SubagentRosterEntry, "key">,
): SubagentRosterEntry {
  return {
    subagentId: null,
    name: "explore",
    description: null,
    status: "running",
    startedAt: "2026-08-06T12:00:00.000Z",
    completedAt: null,
    lastProgressSummary: null,
    lastToolName: null,
    childThreadId: null,
    group: null,
    readModel: null,
    ...overrides,
  };
}

function renderList(roster: ReadonlyArray<SubagentRosterEntry>): string {
  return renderToStaticMarkup(<SubagentRosterList roster={roster} onOpenSubagent={() => {}} />);
}

describe("SubagentRosterPopover", () => {
  it("states the subagent count in the trigger's accessible name", () => {
    const markup = renderToStaticMarkup(
      <SubagentRosterPopover
        roster={[
          entry({ key: "a" }),
          entry({ key: "b" }),
          entry({ key: "c", status: "completed", completedAt: "2026-08-06T12:01:00.000Z" }),
        ]}
        onOpenSubagent={() => {}}
        triggerLabel="View subagents"
      />,
    );

    expect(markup).toContain("View subagents");
    expect(markup).toContain("3 subagents");
    expect(markup).toContain("2 running · 1 done");
  });
});

describe("SubagentRosterList", () => {
  it("shows a running subagent's current tool", () => {
    const markup = renderList([entry({ key: "a", name: "explore", lastToolName: "Grep" })]);

    expect(markup).toContain("Explore");
    expect(markup).toContain("Grep");
    expect(markup).toContain("Explore · Running");
  });

  it("falls back from tool name to progress summary to description", () => {
    expect(renderList([entry({ key: "a", lastProgressSummary: "Reading files" })])).toContain(
      "Reading files",
    );
    expect(renderList([entry({ key: "a", description: "Sweep the parser" })])).toContain(
      "Sweep the parser",
    );
    expect(renderList([entry({ key: "a" })])).toContain("working");
  });

  it("shows a finished subagent as done with its elapsed time", () => {
    const markup = renderList([
      entry({
        key: "a",
        status: "completed",
        startedAt: "2026-08-06T12:00:00.000Z",
        completedAt: "2026-08-06T12:00:42.000Z",
      }),
    ]);

    expect(markup).toContain("Done in 42s");
    expect(markup).toContain("Explore · Done");
  });

  it("lists running subagents before finished ones", () => {
    const markup = renderList([
      entry({
        key: "done",
        name: "critic",
        status: "failed",
        completedAt: "2026-08-06T12:01:00.000Z",
      }),
      entry({ key: "live", name: "explore" }),
    ]);

    expect(markup.indexOf("Explore")).toBeLessThan(markup.indexOf("Critic"));
  });
});
