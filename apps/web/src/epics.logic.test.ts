import { describe, expect, it } from "vite-plus/test";
import type { BeadsEpicSummary, BeadsIssueSummary, EpicRun } from "@t3tools/contracts";
import {
  epicChildren,
  epicCounts,
  epicPresentationStatus,
  epicResultState,
  epicStatusLabel,
  parseEpicRouteParams,
  selectEpicDetail,
  uniqueEpicProjectSources,
} from "./epics.logic";

const epic: BeadsEpicSummary = {
  id: "app-1",
  title: "Ship epics",
  status: "open",
  childCounts: {
    total: 7,
    ready: 2,
    byStatus: { open: 2, blocked: 1, deferred: 1, closed: 2, done: 1 },
  },
};

describe("epics logic", () => {
  it("counts ready, blocked, and done children without losing unknown statuses", () => {
    expect(epicCounts(epic)).toEqual({ ready: 2, blocked: 2, done: 3 });
    expect(epicStatusLabel("waiting_for_review")).toBe("waiting for review");
  });

  it("gives an active run presentation precedence over the bead status", () => {
    const run = { status: "running" } as EpicRun;
    expect(epicPresentationStatus({ ...epic, status: "blocked" }, run)).toBe("running");
    expect(epicPresentationStatus({ ...epic, status: "mystery" }, null)).toBe("unknown");
  });

  it("joins only direct children by parent", () => {
    const issues = [
      { id: "child", parent: "app-1" },
      { id: "other", parent: "app-2" },
    ] as BeadsIssueSummary[];
    expect(epicChildren("app-1", issues).map((issue) => issue.id)).toEqual(["child"]);
  });

  it("dedupes environment and workspace pairs while preserving preferred order", () => {
    expect(
      uniqueEpicProjectSources([
        { environmentId: "a", workspaceRoot: "/repo", projectId: "preferred", projectTitle: "A" },
        { environmentId: "a", workspaceRoot: "/repo", projectId: "duplicate", projectTitle: "B" },
        { environmentId: "b", workspaceRoot: "/repo", projectId: "remote", projectTitle: "C" },
      ]).map((source) => source.projectId),
    ).toEqual(["preferred", "remote"]);
  });

  it("requires both public detail route parameters", () => {
    expect(parseEpicRouteParams({ environmentId: "env", epicId: "app-1" })).toEqual({
      environmentId: "env",
      epicId: "app-1",
    });
    expect(parseEpicRouteParams({ environmentId: "env" })).toBeNull();
  });

  it("uses the project discriminator before deterministic fallback", () => {
    const available = (workspaceRoot: string) =>
      ({
        _tag: "available",
        workspaceRoot,
        epics: [{ ...epic, id: "same" }],
        issues: [],
      }) as never;
    const sources = [
      {
        project: { environmentId: "env", workspaceRoot: "/b", projectId: "b", projectTitle: "B" },
        result: available("/b"),
      },
      {
        project: { environmentId: "env", workspaceRoot: "/a", projectId: "a", projectTitle: "A" },
        result: available("/a"),
      },
    ];
    expect(selectEpicDetail(sources, "same", "b")?.project.projectId).toBe("b");
    expect(selectEpicDetail(sources, "same")?.project.projectId).toBe("a");
  });

  it("distinguishes successful and unavailable project results", () => {
    expect(
      epicResultState([{ _tag: "available" } as never, { _tag: "unavailable" } as never, null]),
    ).toEqual({ available: 1, unavailable: 1 });
  });
});
