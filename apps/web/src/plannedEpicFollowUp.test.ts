import { describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";

import {
  launchPlannedEpic,
  plannedEpicIdentity,
  plannedEpicLaunchInput,
  plannedEpicRoute,
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
