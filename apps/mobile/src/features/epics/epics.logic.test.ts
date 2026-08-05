import type { BeadsEpicSummary, BeadsStatusResult, EpicRun } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  boundedRunLog,
  epicLoadState,
  epicRunUiState,
  epicSourceKey,
  installPrefillIfEmpty,
  issueStatusLabel,
  nextInitialPromptInstall,
  pendingAfterCommandResult,
  latestEpicThreadId,
  selectEpicDetail,
  uniqueEpicProjectSources,
} from "./epics.logic";

const project = (projectId: string, workspaceRoot = "/repo") => ({
  environmentId: "env",
  projectId,
  projectTitle: projectId,
  workspaceRoot,
});
const available = (epicId: string): BeadsStatusResult =>
  ({
    _tag: "available",
    workspaceRoot: "/repo",
    epics: [{ id: epicId } as BeadsEpicSummary],
    issues: [],
    readyCount: 0,
    lastTouchedId: null,
    fetchedAt: new Date(),
  }) as unknown as BeadsStatusResult;

describe("mobile epics logic", () => {
  it("deduplicates project sources by environment and workspace", () => {
    expect(uniqueEpicProjectSources([project("a"), project("b"), project("c", "/other")])).toEqual([
      project("a"),
      project("c", "/other"),
    ]);
    expect(epicSourceKey(project("a"))).toBe(epicSourceKey(project("b")));
  });

  it("names the blockers instead of repeating the bd status", () => {
    // bd leaves a waiting issue as "open", so the id has to carry the meaning.
    expect(issueStatusLabel({ status: "open", blockedBy: ["app-1.9"] })).toBe("blocked by app-1.9");
    expect(issueStatusLabel({ status: "open", blockedBy: ["app-1.9", "app-1.4", "app-1.2"] })).toBe(
      "blocked by app-1.9, app-1.4 +1 more",
    );
    expect(issueStatusLabel({ status: "in_progress", blockedBy: [] })).toBe("in progress");
    // A closed issue reads as done even if a stale edge survived it.
    expect(issueStatusLabel({ status: "closed", blockedBy: ["app-1.9"] })).toBe("done");
  });

  it("groups all-failed and partial-failed source states", () => {
    expect(epicLoadState([{ project: project("a"), result: null, error: "nope" }]).allFailed).toBe(
      true,
    );
    expect(
      epicLoadState([
        { project: project("a"), result: available("one") },
        { project: project("b", "/b"), result: null, error: "nope" },
      ]).partialFailed,
    ).toBe(true);
  });

  it("refuses ambiguous external detail links and honors in-app project identity", () => {
    const sources = [
      { project: project("a"), result: available("same") },
      { project: project("b", "/b"), result: available("same") },
    ];
    expect(selectEpicDetail(sources, "same")).toBeNull();
    expect(selectEpicDetail(sources, "same", "b")?.project.projectId).toBe("b");
  });

  it("preserves a non-empty task draft", () => {
    expect(installPrefillIfEmpty("", "/plan-epic ")).toBe("/plan-epic ");
    expect(installPrefillIfEmpty("keep me", "/plan-epic ")).toBe("keep me");
  });

  it("installs an unkeyed prefill once and does not restore it after the user clears it", () => {
    const installed = nextInitialPromptInstall("", "/plan-epic ", undefined, null);
    expect(installed).toEqual({ prompt: "/plan-epic ", appliedRequest: "/plan-epic " });
    expect(
      nextInitialPromptInstall("", "/plan-epic ", undefined, installed.appliedRequest),
    ).toEqual({ prompt: "", appliedRequest: "/plan-epic " });
  });

  it("maps run states with immediate optimistic transitions", () => {
    expect(epicRunUiState(null, "starting")).toBe("starting");
    expect(epicRunUiState({ status: "done" } as EpicRun, "starting")).toBe("starting");
    expect(epicRunUiState({ status: "paused" } as EpicRun, null)).toBe("paused");
    expect(epicRunUiState({ status: "running" } as EpicRun, "stopping")).toBe("stopping");
    expect(epicRunUiState({ status: "done" } as EpicRun, null)).toBe("terminal");
    expect(pendingAfterCommandResult("starting", "success")).toBe("starting");
    expect(pendingAfterCommandResult("starting", "interrupted")).toBeNull();
    expect(pendingAfterCommandResult("stopping", "failure")).toBeNull();
  });

  it("selects the newest child thread and bounds log output", () => {
    const run = {
      threadRefs: [
        { issueId: "child", threadId: "old", iterationIndex: 0 },
        { issueId: "child", threadId: "new", iterationIndex: 2 },
      ],
    } as unknown as EpicRun;
    expect(latestEpicThreadId(run, "child")).toBe("new");
    expect(boundedRunLog([1, 2, 3, 4], 2)).toEqual([3, 4]);
  });
});
