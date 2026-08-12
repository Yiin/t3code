import { ThreadId, type OrchestrationThreadSubagent } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { SubagentGroup } from "../../session-logic";
import {
  buildSubagentRoster,
  countRunningSubagents,
  findRosterEntry,
  formatSubagentRosterSummary,
  orderRosterForDisplay,
  resolveFirstRunningRosterKey,
  resolveSubagentInteraction,
  resolveSubagentSpawnLabel,
  UNADDRESSABLE_SUBAGENT_REASON,
  type SubagentRosterEntry,
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

describe("resolveSubagentInteraction", () => {
  const nowMs = Date.parse("2026-08-06T12:01:00.000Z");

  function entryFor(subagents: OrchestrationThreadSubagent[]) {
    const roster = buildSubagentRoster({
      groups: [group({ toolCallId: "toolu_1" })],
      subagents,
    });
    return roster[0]!;
  }

  it("cannot address a group with no read-model row", () => {
    expect(resolveSubagentInteraction(entryFor([]), nowMs)).toEqual({
      kind: "unaddressable",
      reason: UNADDRESSABLE_SUBAGENT_REASON,
    });
  });

  it("reports a terminal row as settled", () => {
    const entry = entryFor([
      subagent({
        spawnedByItemId: "toolu_1",
        status: "completed",
        completedAt: "2026-08-06T12:00:45.000Z",
      }),
    ]);

    expect(resolveSubagentInteraction(entry, nowMs)).toEqual({
      kind: "settled",
      subagentId: "agent-1",
      reason: "This subagent is no longer running.",
    });
  });

  it("reports a running row outside the freshness window as settled", () => {
    const entry = entryFor([
      subagent({ spawnedByItemId: "toolu_1", updatedAt: "2026-08-06T11:40:00.000Z" }),
    ]);

    expect(resolveSubagentInteraction(entry, nowMs)).toEqual({
      kind: "settled",
      subagentId: "agent-1",
      reason: "This subagent has not reported recent activity.",
    });
  });

  it("reports a fresh running row as parent-mediated", () => {
    const entry = entryFor([subagent({ spawnedByItemId: "toolu_1" })]);

    expect(resolveSubagentInteraction(entry, nowMs)).toEqual({
      kind: "parent-mediated",
      subagentId: "agent-1",
    });
  });

  it("reports a running child thread as thread-backed", () => {
    const entry = entryFor([
      subagent({ spawnedByItemId: "toolu_1", childThreadId: ThreadId.make("thread-child-1") }),
    ]);

    expect(entry.childThreadId).toBe("thread-child-1");
    expect(resolveSubagentInteraction(entry, nowMs)).toEqual({
      kind: "thread-backed",
      subagentId: "agent-1",
      childThreadId: "thread-child-1",
    });
  });

  it("keeps a stale child thread addressable, because the child outlives the mirror", () => {
    const entry = entryFor([
      subagent({
        spawnedByItemId: "toolu_1",
        childThreadId: ThreadId.make("thread-child-1"),
        updatedAt: "2026-08-06T11:40:00.000Z",
      }),
    ]);

    expect(resolveSubagentInteraction(entry, nowMs).kind).toBe("thread-backed");
  });

  it("reports a terminal child thread as settled", () => {
    const entry = entryFor([
      subagent({
        spawnedByItemId: "toolu_1",
        childThreadId: ThreadId.make("thread-child-1"),
        status: "completed",
        completedAt: "2026-08-06T12:00:45.000Z",
      }),
    ]);

    expect(resolveSubagentInteraction(entry, nowMs).kind).toBe("settled");
  });
});

describe("resolveSubagentSpawnLabel", () => {
  it("credits this thread for a thread-backed child, which has no other clue", () => {
    const entry = buildSubagentRoster({
      groups: [],
      subagents: [subagent({ childThreadId: ThreadId.make("thread-child-1") })],
    })[0]!;

    expect(resolveSubagentSpawnLabel(entry)).toBe("spawned by this thread");
  });

  it("credits the Task tool when the client saw the spawning call", () => {
    const entry = buildSubagentRoster({
      groups: [group()],
      subagents: [subagent({ spawnedByItemId: "toolu_1" })],
    })[0]!;

    expect(resolveSubagentSpawnLabel(entry)).toBe("spawned by Task");
  });

  it("credits the provider for a row that only ever arrived as progress", () => {
    const entry = buildSubagentRoster({ groups: [], subagents: [subagent()] })[0]!;

    expect(resolveSubagentSpawnLabel(entry)).toBe("reported by the provider");
  });
});

describe("orderRosterForDisplay", () => {
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

  it("puts running entries before settled ones", () => {
    const ordered = orderRosterForDisplay([
      entry({ key: "done", status: "completed", completedAt: "2026-08-06T12:05:00.000Z" }),
      entry({ key: "live" }),
    ]);

    expect(ordered.map((item) => item.key)).toEqual(["live", "done"]);
  });

  it("orders running entries oldest first", () => {
    const ordered = orderRosterForDisplay([
      entry({ key: "newer", startedAt: "2026-08-06T12:02:00.000Z" }),
      entry({ key: "older", startedAt: "2026-08-06T12:00:00.000Z" }),
      entry({ key: "middle", startedAt: "2026-08-06T12:01:00.000Z" }),
    ]);

    expect(ordered.map((item) => item.key)).toEqual(["older", "middle", "newer"]);
  });

  it("orders settled entries newest first", () => {
    const ordered = orderRosterForDisplay([
      entry({ key: "first", status: "completed", completedAt: "2026-08-06T12:01:00.000Z" }),
      entry({ key: "last", status: "failed", completedAt: "2026-08-06T12:03:00.000Z" }),
      entry({ key: "second", status: "stopped", completedAt: "2026-08-06T12:02:00.000Z" }),
    ]);

    expect(ordered.map((item) => item.key)).toEqual(["last", "second", "first"]);
  });

  it("keeps settled entries without a completedAt in their incoming order, after the dated ones", () => {
    const ordered = orderRosterForDisplay([
      entry({ key: "undated-a", status: "stopped" }),
      entry({ key: "dated", status: "completed", completedAt: "2026-08-06T12:01:00.000Z" }),
      entry({ key: "undated-b", status: "stopped" }),
    ]);

    expect(ordered.map((item) => item.key)).toEqual(["dated", "undated-a", "undated-b"]);
  });
});
