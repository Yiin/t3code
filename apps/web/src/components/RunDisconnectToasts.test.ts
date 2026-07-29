import type { EpicRun, EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { newlyDisconnectedRunKeys } from "./RunDisconnectToasts";

function run(runId: string, status: EpicRun["status"]): EpicRun {
  return { runId, status } as EpicRun;
}

describe("newlyDisconnectedRunKeys", () => {
  const environmentId = "environment-a" as EnvironmentId;

  it("does not notify when initially offline or while connected", () => {
    expect(
      newlyDisconnectedRunKeys({
        environmentId,
        wasConnected: false,
        isConnected: false,
        runs: [run("run-1", "running")],
        notified: new Set(),
      }),
    ).toEqual([]);
  });

  it("notifies each active run only once and scopes ids by environment", () => {
    const notified = new Set(["environment-a:run-1"]);
    expect(
      newlyDisconnectedRunKeys({
        environmentId,
        wasConnected: true,
        isConnected: false,
        runs: [run("run-1", "running"), run("run-2", "running"), run("done", "done")],
        notified,
      }),
    ).toEqual(["environment-a:run-2"]);
    expect(
      newlyDisconnectedRunKeys({
        environmentId: "environment-b" as EnvironmentId,
        wasConnected: true,
        isConnected: false,
        runs: [run("run-1", "running")],
        notified,
      }),
    ).toEqual(["environment-b:run-1"]);
  });
});
