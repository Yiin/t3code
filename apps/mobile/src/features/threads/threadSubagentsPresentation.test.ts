import { describe, expect, it } from "vite-plus/test";

import type { SubagentInspectorGroup } from "../../lib/threadActivity";
import { sortGroupsForInspector, statusLabel, toolCountLabel } from "./threadSubagentsPresentation";

function group(overrides: Partial<SubagentInspectorGroup> = {}): SubagentInspectorGroup {
  return {
    entryId: "entry-1",
    toolCallId: "call-1",
    name: "worker",
    description: null,
    status: "completed",
    startedAt: "2026-08-06T12:00:00.000Z",
    completedAt: "2026-08-06T12:01:12.000Z",
    children: [],
    lastProgressSummary: null,
    lastToolName: null,
    prompt: null,
    resultText: null,
    ...overrides,
  };
}

describe("sortGroupsForInspector", () => {
  it("places running groups first and sorts each status group newest first", () => {
    const olderComplete = group({ entryId: "older-complete", startedAt: "2026-08-06T10:00:00Z" });
    const newerComplete = group({ entryId: "newer-complete", startedAt: "2026-08-06T11:00:00Z" });
    const olderRunning = group({
      entryId: "older-running",
      status: "running",
      startedAt: "2026-08-06T09:00:00Z",
    });
    const newerRunning = group({
      entryId: "newer-running",
      status: "running",
      startedAt: "2026-08-06T12:00:00Z",
    });

    expect(
      sortGroupsForInspector([olderComplete, olderRunning, newerComplete, newerRunning]).map(
        (item) => item.entryId,
      ),
    ).toEqual(["newer-running", "older-running", "newer-complete", "older-complete"]);
  });

  it("does not mutate its input", () => {
    const input = [
      group({ entryId: "older", startedAt: "2026-08-06T10:00:00Z" }),
      group({ entryId: "newer", startedAt: "2026-08-06T11:00:00Z" }),
    ];

    sortGroupsForInspector(input);

    expect(input.map((item) => item.entryId)).toEqual(["older", "newer"]);
  });
});

describe("statusLabel", () => {
  it("uses a fixed current time for a running group", () => {
    expect(
      statusLabel(
        group({ status: "running", startedAt: "2026-08-06T12:00:00.000Z" }),
        Date.parse("2026-08-06T12:02:05.000Z"),
      ),
    ).toBe("Running · 2m 5s");
  });

  it("shows the completed duration when both timestamps are valid", () => {
    expect(statusLabel(group(), Date.parse("2026-08-06T13:00:00.000Z"))).toBe(
      "Completed in 1m 12s",
    );
  });

  it.each([
    ["failed", "Failed"],
    ["stopped", "Stopped"],
  ] as const)("shows %s groups as %s", (status, expected) => {
    expect(statusLabel(group({ status }), Date.now())).toBe(expected);
  });
});

describe("toolCountLabel", () => {
  it.each([
    [0, null],
    [1, "1 tool"],
    [3, "3 tools"],
  ] as const)("formats %s tools", (count, expected) => {
    expect(toolCountLabel(count)).toBe(expected);
  });
});
