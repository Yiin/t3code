import { describe, expect, it } from "vite-plus/test";
import {
  EnvironmentId,
  ProjectId,
  type BeadsStatusResult,
  type EpicRun,
  type EpicRunStatus,
} from "@t3tools/contracts";

import type { EpicProjectSource } from "./epics.logic";
import {
  beadsUnavailableLabel,
  epicActivityComparator,
  epicGroupCountLabel,
  epicGroupModel,
  epicGroupModels,
  epicRowActivityAt,
  epicRowKey,
  epicRowModel,
  epicRowModels,
  epicSourceFailures,
  partialFailureEntries,
  resolveEpicProjectGroupCollapsed,
  sortEpicRowsByActivity,
  worstRunStatus,
  type EpicPageSummary,
} from "./epicsPage.logic";

const source: EpicProjectSource = {
  environmentId: EnvironmentId.make("env"),
  workspaceRoot: "/repo",
  projectId: ProjectId.make("project"),
  projectTitle: "T3 Code",
};

function epic(overrides: Partial<EpicPageSummary> = {}): EpicPageSummary {
  return {
    id: "t3code-j8s",
    title: "Rethink the Epics page",
    status: "open",
    childCounts: { total: 3, ready: 1, byStatus: { open: 2, closed: 1 } },
    createdAt: null,
    updatedAt: null,
    lastActivityAt: null,
    ...overrides,
  };
}

type RunOverrides = Partial<Omit<EpicRun, "runId" | "projectId">> & {
  readonly runId?: string;
  readonly projectId?: string;
};

function run(overrides: RunOverrides = {}): EpicRun {
  return {
    runId: "run-1",
    epicId: "t3code-j8s",
    projectId: source.projectId,
    cwd: source.workspaceRoot,
    status: "done" as EpicRunStatus,
    updatedAt: "2026-08-03T00:00:00.000Z",
    threadRefs: [],
    ...overrides,
  } as unknown as EpicRun;
}

const available = (epics: ReadonlyArray<EpicPageSummary>): BeadsStatusResult =>
  ({ _tag: "available", epics }) as never;

describe("epics page rows", () => {
  it("keeps the work and machinery channels apart on the poison case", () => {
    // Every child landed, yet the run recorded Failed. Both facts must show.
    const row = epicRowModel(
      source,
      epic({
        status: "closed",
        childCounts: { total: 9, ready: 0, byStatus: { closed: 9 } },
      }),
      [run({ status: "failed", updatedAt: "2026-08-03T10:00:00.000Z" })],
    );

    expect(row.work.counts).toEqual({ ready: 0, blocked: 0, done: 9 });
    expect(row.work.statusLabel).toBe("Done");
    expect(row.work.tone).toBe("done");
    expect(row.machinery.pill?.label).toBe("Failed");
    expect(row.machinery.runStatus).toBe("failed");
    expect(row.machinery.runCount).toBe(1);
  });

  it("never lets a running run repaint the work channel", () => {
    const row = epicRowModel(source, epic({ status: "blocked" }), [run({ status: "running" })]);
    expect(row.work.tone).toBe("blocked");
    expect(row.machinery.pill?.label).toBe("Running");
  });

  it("says so when an epic has never been run", () => {
    const row = epicRowModel(source, epic(), []);
    expect(row.machinery.emptyLabel).toBe("No runs");
    expect(row.machinery.pill).toBeNull();
    expect(row.machinery.updatedAt).toBeNull();
    expect(row.machinery.runCount).toBe(0);
  });

  it("counts and picks the latest run for this epic only", () => {
    const row = epicRowModel(source, epic(), [
      run({ runId: "old", updatedAt: "2026-08-01T00:00:00.000Z" }),
      run({ runId: "new", status: "running", updatedAt: "2026-08-02T00:00:00.000Z" }),
      run({ runId: "other-epic", epicId: "t3code-zzz", status: "failed" }),
      run({ runId: "other-project", projectId: "elsewhere", status: "failed" }),
    ]);
    expect(row.machinery.latestRunId).toBe("new");
    expect(row.machinery.runCount).toBe(2);
    expect(row.machinery.runStatus).toBe("running");
  });

  it("keys rows by environment, workspace, and epic id so cloned repos do not collide", () => {
    const clone: EpicProjectSource = {
      environmentId: EnvironmentId.make("env"),
      workspaceRoot: "/clone",
      projectId: ProjectId.make("clone"),
      projectTitle: "Clone",
    };
    const rows = [epicRowModel(source, epic(), []), epicRowModel(clone, epic(), [])];
    expect(rows[0]?.key).not.toBe(rows[1]?.key);
    expect(new Set(rows.map((entry) => entry.key)).size).toBe(2);
    expect(epicRowKey(rows[0]!.identity)).toBe("env\0/repo\0t3code-j8s");
  });
});

describe("epic recency ordering", () => {
  const rowFor = (
    id: string,
    title: string,
    runs: ReadonlyArray<EpicRun>,
    lastActivityAt: string | null = null,
  ) => epicRowModel(source, epic({ id, title, lastActivityAt }), runs);

  it("sorts run-bearing epics newest first", () => {
    const older = rowFor("a", "Alpha", [
      run({ epicId: "a", runId: "a", updatedAt: "2026-08-01T00:00:00.000Z" }),
    ]);
    const newer = rowFor("b", "Bravo", [
      run({ epicId: "b", runId: "b", updatedAt: "2026-08-02T00:00:00.000Z" }),
    ]);
    expect(sortEpicRowsByActivity([older, newer]).map((row) => row.work.epicId)).toEqual([
      "b",
      "a",
    ]);
  });

  it("sinks never-run epics below every run-bearing epic, alphabetically", () => {
    const ran = rowFor("z", "Zulu", [
      run({ epicId: "z", runId: "z", updatedAt: "2020-01-01T00:00:00.000Z" }),
    ]);
    const neverRunB = rowFor("b", "Bravo", []);
    const neverRunA = rowFor("a", "Alpha", []);
    expect(
      sortEpicRowsByActivity([neverRunB, neverRunA, ran]).map((row) => row.work.epicId),
    ).toEqual(["z", "a", "b"]);
  });

  it("keeps never-run epics below even when beads recency says they are newer", () => {
    const ran = rowFor(
      "z",
      "Zulu",
      [run({ epicId: "z", runId: "z", updatedAt: "2020-01-01T00:00:00.000Z" })],
      "2020-01-01T00:00:00.000Z",
    );
    const neverRun = rowFor("a", "Alpha", [], "2026-08-03T00:00:00.000Z");
    expect(sortEpicRowsByActivity([neverRun, ran]).map((row) => row.work.epicId)).toEqual([
      "z",
      "a",
    ]);
  });

  it("prefers the later of the run clock and the beads clock, and works without either", () => {
    const withBeads = rowFor(
      "a",
      "Alpha",
      [run({ epicId: "a", runId: "a", updatedAt: "2026-08-01T00:00:00.000Z" })],
      "2026-08-05T00:00:00.000Z",
    );
    const withoutBeads = rowFor("b", "Bravo", [
      run({ epicId: "b", runId: "b", updatedAt: "2026-08-04T00:00:00.000Z" }),
    ]);
    expect(epicRowActivityAt(withBeads)).toBe("2026-08-05T00:00:00.000Z");
    expect(epicRowActivityAt(withoutBeads)).toBe("2026-08-04T00:00:00.000Z");
    expect(sortEpicRowsByActivity([withoutBeads, withBeads]).map((row) => row.work.epicId)).toEqual(
      ["a", "b"],
    );
  });

  it("breaks equal timestamps alphabetically instead of leaving order to chance", () => {
    const first = rowFor("b", "Bravo", [
      run({ epicId: "b", runId: "b", updatedAt: "2026-08-01T00:00:00.000Z" }),
    ]);
    const second = rowFor("a", "Alpha", [
      run({ epicId: "a", runId: "a", updatedAt: "2026-08-01T00:00:00.000Z" }),
    ]);
    expect(epicActivityComparator(first, second)).toBeGreaterThan(0);
    expect(sortEpicRowsByActivity([first, second]).map((row) => row.work.epicId)).toEqual([
      "a",
      "b",
    ]);
  });
});

describe("run severity roll-up", () => {
  it("ranks running above failed", () => {
    expect(worstRunStatus([{ status: "failed" }, { status: "running" }])).toBe("running");
    expect(worstRunStatus([{ status: "running" }, { status: "failed" }])).toBe("running");
  });

  it("walks the whole ladder and ignores epics with no run", () => {
    expect(worstRunStatus([{ status: "done" }, { status: "cancelled" }])).toBe("cancelled");
    expect(worstRunStatus([{ status: "cancelled" }, { status: "paused" }])).toBe("paused");
    expect(worstRunStatus([{ status: "paused" }, { status: "failed" }])).toBe("failed");
    expect(worstRunStatus([null, { status: "done" }, null])).toBe("done");
    expect(worstRunStatus([null, null])).toBeNull();
    expect(worstRunStatus([])).toBeNull();
  });
});

describe("epic groups", () => {
  it("rolls a project group up to its loudest actionable run", () => {
    const rows = epicRowModels(
      source,
      [epic({ id: "a", title: "Alpha" }), epic({ id: "b", title: "Bravo" })],
      [
        run({ epicId: "a", runId: "a", status: "failed", updatedAt: "2026-08-01T00:00:00.000Z" }),
        run({ epicId: "b", runId: "b", status: "running", updatedAt: "2026-08-02T00:00:00.000Z" }),
      ],
    );
    const group = epicGroupModel(source, rows);
    expect(group.runStatus).toBe("running");
    expect(group.pill?.label).toBe("Running");
    expect(group.runningCount).toBe(1);
    expect(group.activityAt).toBe("2026-08-02T00:00:00.000Z");
    expect(group.rows.map((row) => row.work.epicId)).toEqual(["b", "a"]);
    expect(group.key).toBe("env\0/repo");
  });

  it("keeps groups in project source order, however recently they ran", () => {
    // By project is the STABLE view: its headers are press targets, so the more
    // active project must not jump above the one listed before it.
    const quiet = source;
    const busy: EpicProjectSource = {
      environmentId: EnvironmentId.make("env"),
      workspaceRoot: "/busy",
      projectId: ProjectId.make("busy"),
      projectTitle: "Busy",
    };
    const groups = epicGroupModels({
      sources: [quiet, busy],
      results: new Map([
        ["env\0/repo", { data: available([epic({ id: "a" })]), error: null }],
        ["env\0/busy", { data: available([epic({ id: "b" })]), error: null }],
      ]),
      runsByEnvironment: new Map([
        [
          "env",
          [
            run({ epicId: "a", runId: "a", updatedAt: "2026-08-01T00:00:00.000Z" }),
            run({
              epicId: "b",
              runId: "b",
              cwd: "/busy",
              projectId: "busy",
              updatedAt: "2026-08-09T00:00:00.000Z",
            }),
          ],
        ],
      ]),
    });
    expect(groups.map((group) => group.project.projectId)).toEqual(["project", "busy"]);
    expect(groups.map((group) => group.activityAt)).toEqual([
      "2026-08-01T00:00:00.000Z",
      "2026-08-09T00:00:00.000Z",
    ]);
  });

  it("skips a source with no snapshot and one whose snapshot has no epics", () => {
    const empty: EpicProjectSource = {
      environmentId: EnvironmentId.make("env"),
      workspaceRoot: "/empty",
      projectId: ProjectId.make("empty"),
      projectTitle: "Empty",
    };
    const loading: EpicProjectSource = {
      environmentId: EnvironmentId.make("env"),
      workspaceRoot: "/loading",
      projectId: ProjectId.make("loading"),
      projectTitle: "Loading",
    };
    const groups = epicGroupModels({
      sources: [empty, loading, source],
      results: new Map([
        ["env\0/empty", { data: available([]), error: null }],
        ["env\0/loading", { data: null, error: null }],
        ["env\0/repo", { data: available([epic({ id: "a" })]), error: null }],
      ]),
      runsByEnvironment: new Map(),
    });
    expect(groups.map((group) => group.project.projectId)).toEqual(["project"]);
    expect(groups[0]?.rows.map((row) => row.machinery.runCount)).toEqual([0]);
  });

  it("sums the ready work a collapsed header has to speak for", () => {
    const group = epicGroupModel(
      source,
      epicRowModels(
        source,
        [
          epic({ id: "a", childCounts: { total: 4, ready: 3, byStatus: { open: 4 } } }),
          epic({ id: "b", childCounts: { total: 2, ready: 2, byStatus: { open: 2 } } }),
          epic({ id: "c", childCounts: { total: 1, ready: 0, byStatus: { closed: 1 } } }),
        ],
        [],
      ),
    );
    expect(group.epicCount).toBe(3);
    expect(group.readyCount).toBe(5);
    expect(epicGroupModel(source, []).readyCount).toBe(0);
    expect(epicGroupCountLabel(3)).toBe("3 epics");
    expect(epicGroupCountLabel(1)).toBe("1 epic");
    expect(epicGroupCountLabel(0)).toBe("0 epics");
  });

  it("expands a group until the user collapses it, and lets no status override that", () => {
    expect(resolveEpicProjectGroupCollapsed({})).toBe(false);
    expect(resolveEpicProjectGroupCollapsed({ override: undefined })).toBe(false);
    expect(resolveEpicProjectGroupCollapsed({ override: true })).toBe(true);
    expect(resolveEpicProjectGroupCollapsed({ override: false })).toBe(false);
  });
});

describe("partial beads failures", () => {
  const unavailable = (workspaceRoot: string, reason: string): BeadsStatusResult =>
    ({ _tag: "unavailable", workspaceRoot, reason, detail: "bd exited 1" }) as never;

  it("names the project and carries the reason for every failed source", () => {
    const other: EpicProjectSource = {
      environmentId: EnvironmentId.make("env"),
      workspaceRoot: "/other",
      projectId: ProjectId.make("other"),
      projectTitle: "Other",
    };
    const missing: EpicProjectSource = {
      environmentId: EnvironmentId.make("env"),
      workspaceRoot: "/missing",
      projectId: ProjectId.make("missing"),
      projectTitle: "Missing",
    };
    const entries = partialFailureEntries(
      [source, other, missing],
      new Map([
        ["env\0/repo", { _tag: "available" } as never],
        ["env\0/other", unavailable("/other", "bd-failed")],
      ]),
    );
    expect(entries).toEqual([
      {
        key: "env\0/other",
        project: other,
        reason: "bd-failed",
        detail: "bd exited 1",
      },
    ]);
    expect(beadsUnavailableLabel("bd-not-found")).toBe("bd not found");
  });

  it("names both an unavailable snapshot and a failed subscription", () => {
    const broken: EpicProjectSource = {
      environmentId: EnvironmentId.make("env"),
      workspaceRoot: "/broken",
      projectId: ProjectId.make("broken"),
      projectTitle: "Broken",
    };
    const dropped: EpicProjectSource = {
      environmentId: EnvironmentId.make("env"),
      workspaceRoot: "/dropped",
      projectId: ProjectId.make("dropped"),
      projectTitle: "Dropped",
    };
    const failures = epicSourceFailures(
      [source, broken, dropped],
      new Map([
        ["env\0/repo", { data: { _tag: "available" } as never, error: null }],
        ["env\0/broken", { data: unavailable("/broken", "no-beads"), error: null }],
        ["env\0/dropped", { data: null, error: "The environment request failed." }],
      ]),
    );
    expect(failures).toEqual([
      {
        key: "env\0/broken",
        project: broken,
        label: "No beads database",
        detail: "bd exited 1",
      },
      {
        key: "env\0/dropped",
        project: dropped,
        label: "Could not be read",
        detail: "The environment request failed.",
      },
    ]);
  });

  it("says nothing about sources that are merely still loading", () => {
    expect(epicSourceFailures([source], new Map())).toEqual([]);
    expect(
      epicSourceFailures([source], new Map([["env\0/repo", { data: null, error: null }]])),
    ).toEqual([]);
  });

  it("prefers the beads reason over a stale subscription error on the same source", () => {
    const failures = epicSourceFailures(
      [source],
      new Map([["env\0/repo", { data: unavailable("/repo", "bd-not-found"), error: "boom" }]]),
    );
    expect(failures).toEqual([
      { key: "env\0/repo", project: source, label: "bd not found", detail: "bd exited 1" },
    ]);
  });
});
