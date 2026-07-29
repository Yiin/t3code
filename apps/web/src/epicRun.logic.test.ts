import { describe, expect, it } from "@effect/vitest";
import { ThreadId, type BeadsIssueSummary, type EpicRun } from "@t3tools/contracts";

import {
  currentEpicRunIssue,
  epicRunUiState,
  formatEpicRunElapsed,
  shouldStickToBottom,
} from "./epicRun.logic";

const run = (status: EpicRun["status"]) => ({ status }) as EpicRun;
const iteration = (
  overrides: Partial<EpicRun["recentIterations"][number]>,
): EpicRun["recentIterations"][number] =>
  ({
    iterationIndex: 0,
    threadId: ThreadId.make("thread-1"),
    issueId: null,
    turnStatus: "completed",
    summary: null,
    why: null,
    startedAt: "2026-07-29T00:00:00.000Z",
    finishedAt: "2026-07-29T00:01:00.000Z",
    ...overrides,
  }) as EpicRun["recentIterations"][number];

describe("epic run presentation", () => {
  it.each([
    [null, null, "idle"],
    [null, "starting", "starting"],
    [run("running"), null, "running"],
    [run("paused"), null, "running"],
    [run("running"), "stopping", "stopping"],
    [run("done"), "stopping", "stopped"],
    [run("cancelled"), null, "stopped"],
    [run("failed"), null, "failed"],
  ] as const)("maps run and pending state to %s", (value, pending, expected) => {
    expect(epicRunUiState(value, pending)).toBe(expected);
  });

  it("auto-follows only while the viewport is near the bottom", () => {
    expect(shouldStickToBottom({ scrollHeight: 1_000, scrollTop: 560, clientHeight: 400 })).toBe(
      true,
    );
    expect(shouldStickToBottom({ scrollHeight: 1_000, scrollTop: 300, clientHeight: 400 })).toBe(
      false,
    );
  });

  it("formats elapsed durations", () => {
    expect(
      formatEpicRunElapsed("2026-07-29T00:00:00.000Z", Date.parse("2026-07-29T01:02:03Z")),
    ).toBe("1:02:03");
  });

  it("selects a running issue over a newer settled iteration", () => {
    const issue = { id: "issue-running", title: "Running child" } as BeadsIssueSummary;
    const value = {
      ...run("running"),
      recentIterations: [
        iteration({
          threadId: ThreadId.make("thread-running"),
          issueId: issue.id,
          turnStatus: "running",
          finishedAt: null,
        }),
        iteration({
          iterationIndex: 1,
          threadId: ThreadId.make("thread-latest"),
          issueId: "issue-latest",
          turnStatus: "completed",
        }),
      ],
    };

    expect(currentEpicRunIssue(value, [issue])).toEqual({
      issue,
      threadId: "thread-running",
    });
  });

  it("safely ignores iterations without a resolvable issue", () => {
    const withoutId = {
      ...run("running"),
      recentIterations: [iteration({ issueId: null })],
    };
    const unknownId = {
      ...run("running"),
      recentIterations: [iteration({ threadId: ThreadId.make("thread-2"), issueId: "missing" })],
    };

    expect(currentEpicRunIssue(withoutId, [])).toBeNull();
    expect(currentEpicRunIssue(unknownId, [])).toBeNull();
  });
});
