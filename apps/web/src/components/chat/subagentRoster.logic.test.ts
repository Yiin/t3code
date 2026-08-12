import type { OrchestrationThreadSubagent } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { SubagentGroup } from "../../session-logic";
import {
  buildSubagentRoster,
  countRunningSubagents,
  findRosterEntry,
  formatSubagentRosterSummary,
  resolveFirstRunningRosterKey,
} from "./subagentRoster.logic";

function group(overrides: Partial<SubagentGroup> = {}): SubagentGroup {
  return {
    entryId: "work-spawn-1",
    toolCallId: "toolu_1",
    name: "explore",
    description: "Find the source",
    status: "running",
    startedAt: "2026-08-06T12:00:00.000Z",
    completedAt: null,
    children: [],
    resultText: null,
    prompt: null,
    ...overrides,
  };
}

function subagent(
  overrides: Partial<OrchestrationThreadSubagent> = {},
): OrchestrationThreadSubagent {
  return {
    subagentId: "agent-1",
    turnId: null,
    status: "running",
    startedAt: "2026-08-06T12:00:00.000Z",
    updatedAt: "2026-08-06T12:00:30.000Z",
    completedAt: null,
    ...overrides,
  };
}

describe("buildSubagentRoster", () => {
  it("joins a group to its read-model row on spawnedByItemId", () => {
    const roster = buildSubagentRoster({
      groups: [group()],
      subagents: [
        subagent({
          spawnedByItemId: "toolu_1",
          agentType: "Explore",
          description: "Sweep the parser",
          lastProgressSummary: "Reading files",
          lastToolName: "Grep",
        }),
      ],
    });

    expect(roster).toHaveLength(1);
    expect(roster[0]).toMatchObject({
      key: "toolu_1",
      subagentId: "agent-1",
      name: "Explore",
      description: "Sweep the parser",
      status: "running",
      lastProgressSummary: "Reading files",
      lastToolName: "Grep",
    });
    expect(roster[0]?.group?.entryId).toBe("work-spawn-1");
    expect(roster[0]?.readModel?.subagentId).toBe("agent-1");
  });

  it("keys a read-model-only entry by spawnedByItemId", () => {
    const roster = buildSubagentRoster({
      groups: [],
      subagents: [subagent({ spawnedByItemId: "toolu_9" })],
    });

    expect(roster).toHaveLength(1);
    expect(roster[0]?.key).toBe("toolu_9");
    expect(roster[0]?.group).toBeNull();
  });

  it("keys a read-model-only entry with no spawnedByItemId by subagentId", () => {
    const roster = buildSubagentRoster({ groups: [], subagents: [subagent()] });

    expect(roster[0]?.key).toBe("agent-1");
  });

  it("keeps a group with no read-model row and falls back to its fields", () => {
    const roster = buildSubagentRoster({
      groups: [
        group({ toolCallId: null, status: "completed", completedAt: "2026-08-06T12:05:00.000Z" }),
      ],
      subagents: [],
    });

    expect(roster[0]).toMatchObject({
      key: "work-spawn-1",
      subagentId: null,
      name: "explore",
      description: "Find the source",
      status: "completed",
      startedAt: "2026-08-06T12:00:00.000Z",
      completedAt: "2026-08-06T12:05:00.000Z",
    });
    expect(roster[0]?.readModel).toBeNull();
  });

  it("lets a running read-model row beat a settled-turn group marked stopped", () => {
    const roster = buildSubagentRoster({
      groups: [group({ status: "stopped" })],
      subagents: [subagent({ spawnedByItemId: "toolu_1", status: "running" })],
    });

    expect(roster[0]?.status).toBe("running");
  });

  it("orders by startedAt then key and never repeats a subagentId or a key", () => {
    const roster = buildSubagentRoster({
      groups: [
        group({ entryId: "work-b", toolCallId: "toolu_b", startedAt: "2026-08-06T12:02:00.000Z" }),
        group({ entryId: "work-a", toolCallId: "toolu_a", startedAt: "2026-08-06T12:01:00.000Z" }),
        // A duplicate tool call id must not claim the same row twice.
        group({ entryId: "work-a2", toolCallId: "toolu_a", startedAt: "2026-08-06T12:01:00.000Z" }),
      ],
      subagents: [
        subagent({ subagentId: "agent-a", spawnedByItemId: "toolu_a" }),
        subagent({ subagentId: "agent-c", startedAt: "2026-08-06T12:00:00.000Z" }),
      ],
    });

    expect(roster.map((entry) => entry.key)).toEqual(["agent-c", "toolu_a", "toolu_b"]);
    expect(roster.map((entry) => entry.subagentId)).toEqual(["agent-c", "agent-a", null]);
    expect(new Set(roster.map((entry) => entry.key)).size).toBe(roster.length);
  });
});

describe("findRosterEntry", () => {
  const roster = buildSubagentRoster({
    groups: [group()],
    subagents: [subagent({ spawnedByItemId: "toolu_1" })],
  });

  it("matches the roster key, the subagent id, and the spawning entry id", () => {
    expect(findRosterEntry(roster, "toolu_1")?.key).toBe("toolu_1");
    expect(findRosterEntry(roster, "agent-1")?.key).toBe("toolu_1");
    expect(findRosterEntry(roster, "work-spawn-1")?.key).toBe("toolu_1");
  });

  it("returns undefined for an unknown key", () => {
    expect(findRosterEntry(roster, "gone")).toBeUndefined();
  });
});

describe("formatSubagentRosterSummary", () => {
  it("omits zero buckets", () => {
    expect(
      formatSubagentRosterSummary([
        { status: "running" },
        { status: "running" },
        { status: "failed" },
        { status: "stopped" },
      ]),
    ).toBe("2 running · 1 failed");
  });

  it("counts done separately", () => {
    expect(
      formatSubagentRosterSummary([
        { status: "running" },
        { status: "completed" },
        { status: "failed" },
      ]),
    ).toBe("1 running · 1 done · 1 failed");
  });
});

describe("a running roster always has a View target", () => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly groups: SubagentGroup[];
    readonly subagents: OrchestrationThreadSubagent[];
  }> = [
    {
      name: "read-model running row with no group",
      groups: [],
      subagents: [subagent({ spawnedByItemId: "toolu_gone" })],
    },
    {
      name: "read-model running row whose group says stopped",
      groups: [group({ status: "stopped" })],
      subagents: [subagent({ spawnedByItemId: "toolu_1" })],
    },
    {
      name: "read-model running row with neither a group nor a spawnedByItemId",
      groups: [],
      subagents: [subagent()],
    },
    {
      name: "group running with no read-model row",
      groups: [group()],
      subagents: [],
    },
    { name: "empty inputs", groups: [], subagents: [] },
  ];

  for (const testCase of cases) {
    it(`holds for ${testCase.name}`, () => {
      const roster = buildSubagentRoster({
        groups: testCase.groups,
        subagents: testCase.subagents,
      });
      if (countRunningSubagents(roster) > 0) {
        expect(resolveFirstRunningRosterKey(roster)).not.toBeNull();
      } else {
        expect(resolveFirstRunningRosterKey(roster)).toBeNull();
      }
    });
  }

  it("picks the first running entry in roster order", () => {
    const roster = buildSubagentRoster({
      groups: [
        group({ entryId: "work-1", toolCallId: "toolu_1", status: "completed" }),
        group({
          entryId: "work-2",
          toolCallId: "toolu_2",
          startedAt: "2026-08-06T12:01:00.000Z",
        }),
        group({
          entryId: "work-3",
          toolCallId: "toolu_3",
          startedAt: "2026-08-06T12:02:00.000Z",
        }),
      ],
      subagents: [],
    });

    expect(countRunningSubagents(roster)).toBe(2);
    expect(resolveFirstRunningRosterKey(roster)).toBe("toolu_2");
  });
});
