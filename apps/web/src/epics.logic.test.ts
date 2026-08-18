import { describe, expect, it } from "vite-plus/test";
import {
  EnvironmentId,
  ProjectId,
  type BeadsEpicSummary,
  type BeadsIssueSummary,
  type EpicRun,
} from "@t3tools/contracts";
import {
  epicChildren,
  epicCounts,
  epicPresentationStatus,
  epicResultState,
  epicStatusLabel,
  issueStatusLabel,
  latestEpicThreadId,
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
  createdAt: null,
  updatedAt: null,
  lastActivityAt: null,
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

  it("names the blockers instead of repeating the bd status", () => {
    // bd leaves a waiting issue as "open", so the id has to carry the meaning.
    expect(issueStatusLabel({ status: "open", blockedBy: ["app-1.9"] })).toBe("Blocked by app-1.9");
    expect(issueStatusLabel({ status: "open", blockedBy: ["app-1.9", "app-1.4"] })).toBe(
      "Blocked by app-1.9, app-1.4",
    );
    expect(
      issueStatusLabel({ status: "open", blockedBy: ["app-1.9", "app-1.4", "app-1.2", "app-1.1"] }),
    ).toBe("Blocked by app-1.9, app-1.4 +2 more");
    expect(issueStatusLabel({ status: "open", blockedBy: [] })).toBe("Open");
    expect(issueStatusLabel({ status: "blocked", blockedBy: [] })).toBe("Blocked");
    // A closed issue reads as done even if a stale edge survived it.
    expect(issueStatusLabel({ status: "closed", blockedBy: ["app-1.9"] })).toBe("Done");
  });

  it("links an issue to its newest cooking iteration", () => {
    const run = {
      threadRefs: [
        { issueId: "child", threadId: "older", iterationIndex: 1 },
        { issueId: "other", threadId: "other", iterationIndex: 9 },
        { issueId: "child", threadId: "newer", iterationIndex: 3 },
      ],
    } as unknown as EpicRun;
    expect(latestEpicThreadId(run, "child")).toBe("newer");
    expect(latestEpicThreadId(run, "missing")).toBeNull();
  });

  it("dedupes environment and workspace pairs while preserving preferred order", () => {
    expect(
      uniqueEpicProjectSources([
        {
          environmentId: EnvironmentId.make("a"),
          workspaceRoot: "/repo",
          projectId: ProjectId.make("preferred"),
          projectTitle: "A",
        },
        {
          environmentId: EnvironmentId.make("a"),
          workspaceRoot: "/repo",
          projectId: ProjectId.make("duplicate"),
          projectTitle: "B",
        },
        {
          environmentId: EnvironmentId.make("b"),
          workspaceRoot: "/repo",
          projectId: ProjectId.make("remote"),
          projectTitle: "C",
        },
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
        project: {
          environmentId: EnvironmentId.make("env"),
          workspaceRoot: "/b",
          projectId: ProjectId.make("b"),
          projectTitle: "B",
        },
        result: available("/b"),
      },
      {
        project: {
          environmentId: EnvironmentId.make("env"),
          workspaceRoot: "/a",
          projectId: ProjectId.make("a"),
          projectTitle: "A",
        },
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
