import { describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, EpicRunId, ProjectId, ThreadId, type EpicRun } from "@t3tools/contracts";

import {
  latestRunForPlannedEpic,
  launchPlannedEpic,
  plannedEpicIdentity,
  plannedEpicLaunchInput,
  plannedEpicRoute,
  resolvePlannedEpicBanner,
} from "./plannedEpicFollowUp";

const correlation = {
  environmentId: EnvironmentId.make("env-1"),
  threadId: ThreadId.make("thread-1"),
  epicId: "t3code-vst",
  projectId: ProjectId.make("project-1"),
  cwd: "/workspace/t3code",
};

describe("planned epic follow-up", () => {
  it("builds a project-scoped identity, route, and launch input", () => {
    expect(plannedEpicIdentity(correlation)).toBe("env-1:project-1:t3code-vst");
    expect(plannedEpicRoute(correlation)).toEqual({
      to: "/epics/$environmentId/$epicId",
      params: { environmentId: "env-1", epicId: "t3code-vst" },
      search: { project: "project-1" },
    });
    expect(plannedEpicLaunchInput(correlation)).toEqual({
      environmentId: "env-1",
      input: {
        epicId: "t3code-vst",
        projectId: "project-1",
        cwd: "/workspace/t3code",
        originThreadId: "thread-1",
        // Cooking from the planning conversation runs on that conversation's
        // provider, not the project default.
        inheritOriginModelSelection: true,
      },
    });
  });

  it("navigates only after a successful launch and settles pending state", async () => {
    const order: string[] = [];
    const launch = vi.fn(async () => {
      order.push("launch");
      return { _tag: "Success" as const };
    });
    const navigate = vi.fn(() => {
      order.push("navigate");
    });
    const onFailure = vi.fn();

    await launchPlannedEpic({
      correlation,
      launch,
      navigate,
      onFailure,
      onSettled: () => order.push("settled"),
    });

    expect(order).toEqual(["launch", "settled", "navigate"]);
    expect(launch).toHaveBeenCalledWith(plannedEpicLaunchInput(correlation));
    expect(navigate).toHaveBeenCalledWith(plannedEpicRoute(correlation));
    expect(onFailure).not.toHaveBeenCalled();
  });

  it("reports a failed launch without navigating and settles pending state", async () => {
    const error = new Error("nope");
    const navigate = vi.fn();
    const onFailure = vi.fn();
    const onSettled = vi.fn();

    await launchPlannedEpic({
      correlation,
      launch: async () => ({ _tag: "Failure", error }),
      navigate,
      onFailure,
      onSettled,
    });

    expect(onSettled).toHaveBeenCalledOnce();
    expect(onFailure).toHaveBeenCalledWith({ _tag: "Failure", error });
    expect(navigate).not.toHaveBeenCalled();
  });
});

function epicRun(overrides: Partial<EpicRun> = {}): EpicRun {
  return {
    runId: EpicRunId.make("run-1"),
    epicId: correlation.epicId,
    projectId: correlation.projectId,
    cwd: correlation.cwd,
    status: "running",
    updatedAt: "2026-08-20T00:00:00.000Z",
    ...overrides,
  } as unknown as EpicRun;
}

describe("latestRunForPlannedEpic", () => {
  it("matches on epicId and projectId only, ignoring cwd", () => {
    // A dashboard launch stores the workspace root while a worktree-thread
    // correlation carries the worktree path; it is the same run.
    const dashboardRun = epicRun({ cwd: "/workspace/t3code-main" });
    expect(latestRunForPlannedEpic([dashboardRun], correlation)).toBe(dashboardRun);
  });

  it("picks the latest run by updatedAt, then runId", () => {
    const older = epicRun({
      runId: EpicRunId.make("run-1"),
      updatedAt: "2026-08-19T00:00:00.000Z",
    });
    const newer = epicRun({
      runId: EpicRunId.make("run-2"),
      updatedAt: "2026-08-20T00:00:00.000Z",
    });
    const tied = epicRun({ runId: EpicRunId.make("run-3"), updatedAt: "2026-08-20T00:00:00.000Z" });
    const otherEpic = epicRun({
      runId: EpicRunId.make("run-4"),
      epicId: "t3code-zzz",
      updatedAt: "2026-08-21T00:00:00.000Z",
    });
    const otherProject = epicRun({
      runId: EpicRunId.make("run-5"),
      projectId: ProjectId.make("project-2"),
      updatedAt: "2026-08-21T00:00:00.000Z",
    });
    expect(
      latestRunForPlannedEpic([older, tied, newer, otherEpic, otherProject], correlation),
    ).toBe(tied);
  });

  it("returns null when no run matches", () => {
    expect(latestRunForPlannedEpic([], correlation)).toBeNull();
  });
});

describe("resolvePlannedEpicBanner", () => {
  const banner = (input: {
    runs?: ReadonlyArray<EpicRun> | undefined;
    dismissed?: boolean;
    activeEpicRun?: EpicRun | null;
  }) =>
    resolvePlannedEpicBanner({
      plannedEpic: correlation,
      runs: input.runs,
      dismissed: input.dismissed ?? false,
      activeEpicRun: input.activeEpicRun ?? null,
    });

  it("shows the start control before the runs query emits", () => {
    const model = banner({ runs: undefined });
    expect(model).toMatchObject({
      visible: true,
      control: "start",
      title: "Epic t3code-vst planned",
      run: null,
      suppressRunPill: false,
      variant: "success",
    });
  });

  it("falls back to the active run before the runs query emits", () => {
    const live = epicRun({ status: "running" });
    const model = banner({ runs: undefined, activeEpicRun: live });
    expect(model.control).toBe("pause");
    expect(model.run).toBe(live);
    expect(model.suppressRunPill).toBe(true);
  });

  it("ignores the fallback when the active run belongs to another epic", () => {
    const other = epicRun({ epicId: "t3code-zzz", status: "running" });
    expect(banner({ runs: undefined, activeEpicRun: other }).control).toBe("start");
    const otherProject = epicRun({
      projectId: ProjectId.make("project-2"),
      status: "running",
    });
    expect(banner({ runs: undefined, activeEpicRun: otherProject }).control).toBe("start");
  });

  it("does not fall back once the runs query has emitted", () => {
    const live = epicRun({ status: "running" });
    expect(banner({ runs: [], activeEpicRun: live }).control).toBe("start");
  });

  it("shows pause while running", () => {
    const model = banner({ runs: [epicRun({ status: "running" })] });
    expect(model.control).toBe("pause");
    expect(model.title).toBe("Epic t3code-vst is running");
    expect(model.variant).toBe("success");
  });

  it("shows resume while paused", () => {
    const model = banner({ runs: [epicRun({ status: "paused" })] });
    expect(model.control).toBe("resume");
    expect(model.title).toBe("Epic t3code-vst paused");
    expect(model.variant).toBe("warning");
  });

  it("shows view-only when done", () => {
    const model = banner({ runs: [epicRun({ status: "done" })] });
    expect(model.control).toBe("view-only");
    expect(model.title).toBe("Epic t3code-vst completed");
    expect(model.variant).toBe("success");
  });

  it("shows restart when failed", () => {
    const model = banner({ runs: [epicRun({ status: "failed" })] });
    expect(model.control).toBe("restart");
    expect(model.title).toBe("Epic t3code-vst failed");
    expect(model.variant).toBe("error");
  });

  it("shows restart when cancelled", () => {
    const model = banner({ runs: [epicRun({ status: "cancelled" })] });
    expect(model.control).toBe("restart");
    expect(model.title).toBe("Epic t3code-vst stopped");
    expect(model.variant).toBe("warning");
  });

  it("hides the banner when dismissed or when there is no planned epic", () => {
    expect(banner({ runs: [], dismissed: true }).visible).toBe(false);
    expect(
      resolvePlannedEpicBanner({
        plannedEpic: null,
        runs: [epicRun()],
        dismissed: false,
        activeEpicRun: null,
      }),
    ).toMatchObject({ visible: false, control: "start", run: null, suppressRunPill: false });
  });

  it("suppresses the run pill only while the banner covers that live run", () => {
    const run = epicRun({ status: "running" });
    expect(banner({ runs: [run], activeEpicRun: run }).suppressRunPill).toBe(true);

    const paused = epicRun({ status: "paused" });
    expect(banner({ runs: [paused], activeEpicRun: paused }).suppressRunPill).toBe(true);
  });

  it("does not suppress the pill for another run or a dismissed banner", () => {
    const run = epicRun({ status: "running" });
    const other = epicRun({ runId: EpicRunId.make("run-2"), status: "running" });
    expect(banner({ runs: [run], activeEpicRun: other }).suppressRunPill).toBe(false);
    expect(banner({ runs: [run], activeEpicRun: run, dismissed: true }).suppressRunPill).toBe(
      false,
    );
    expect(banner({ runs: [run], activeEpicRun: null }).suppressRunPill).toBe(false);
  });
});
