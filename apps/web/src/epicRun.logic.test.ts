import { describe, expect, it } from "@effect/vitest";
import { ThreadId, type BeadsIssueSummary, type EpicRun } from "@t3tools/contracts";

import {
  currentEpicRunIssue,
  epicRunHistory,
  epicRunHistoryHasRun,
  epicRunIterationCountLabel,
  epicRunIterationDuration,
  epicRunUiState,
  epicRuntimeModeLabel,
  epicStartControl,
  formatEpicRunElapsed,
  isTerminalEpicRunStatus,
  shouldStickToBottom,
} from "./epicRun.logic";

const run = (status: EpicRun["status"]) => ({ status }) as EpicRun;
const historyRun = (overrides: {
  readonly runId: string;
  readonly epicId?: string;
  readonly projectId?: string;
  readonly cwd?: string;
  readonly updatedAt?: string;
}): EpicRun =>
  ({
    epicId: "epic-1",
    projectId: "project-1",
    cwd: "/repo",
    status: "done",
    updatedAt: "2026-07-29T00:00:00.000Z",
    ...overrides,
  }) as unknown as EpicRun;
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
    [null, "stopping", "idle"],
    [run("running"), null, "running"],
    [run("paused"), null, "paused"],
    [run("running"), "stopping", "stopping"],
    [run("paused"), "stopping", "stopping"],
    [run("done"), "stopping", "stopped"],
    [run("cancelled"), "stopping", "stopped"],
    [run("cancelled"), null, "stopped"],
    [run("failed"), null, "failed"],
    // Pausing and resuming are in flight on the button, not on the run.
    [run("running"), "pausing", "running"],
    [run("paused"), "resuming", "paused"],
    // Repeating a terminal run is a start, not a state of the old run.
    [run("done"), "starting", "starting"],
    [run("failed"), "starting", "starting"],
    [run("cancelled"), "starting", "starting"],
    // A live run cannot be started over, so a stray pending start is ignored.
    [run("running"), "starting", "running"],
    [run("paused"), "starting", "paused"],
  ] as const)("maps run and pending state to %s", (value, pending, expected) => {
    expect(epicRunUiState(value, pending)).toBe(expected);
  });

  it.each([
    [null, "idle", { label: "Start run", busy: false }],
    // Every terminal run keeps a way to run the epic again.
    [run("done"), "stopped", { label: "Start new run", busy: false }],
    [run("cancelled"), "stopped", { label: "Start new run", busy: false }],
    [run("failed"), "failed", { label: "Start new run", busy: false }],
    // A repeat holds the control in place; a first run uses the placeholder.
    [run("done"), "starting", { label: "Starting…", busy: true }],
    [null, "starting", null],
    // Nothing to start while a run can still move on its own.
    [run("running"), "running", null],
    [run("paused"), "paused", null],
    [run("running"), "stopping", null],
  ] as const)("resolves the start control for %s in state %s", (value, state, expected) => {
    expect(epicStartControl(value, state)).toEqual(expected);
  });

  it.each([
    ["done", true],
    ["failed", true],
    ["cancelled", true],
    ["running", false],
    ["paused", false],
  ] as const)("treats %s as terminal=%s", (status, expected) => {
    expect(isTerminalEpicRunStatus(status)).toBe(expected);
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
    expect(formatEpicRunElapsed("not-a-date", Date.parse("2026-07-29T01:02:03Z"))).toBe("0:00");
  });

  it("times a settled iteration by its own clock and a running one by now", () => {
    expect(
      epicRunIterationDuration(
        { startedAt: "2026-07-29T00:00:00.000Z", finishedAt: "2026-07-29T00:02:30.000Z" },
        Date.parse("2026-07-29T09:00:00.000Z"),
      ),
    ).toBe("2:30");
    expect(
      epicRunIterationDuration(
        { startedAt: "2026-07-29T00:00:00.000Z", finishedAt: null },
        Date.parse("2026-07-29T00:00:45.000Z"),
      ),
    ).toBe("0:45");
  });

  it("labels iteration counts", () => {
    expect(epicRunIterationCountLabel(0)).toBe("0 iterations");
    expect(epicRunIterationCountLabel(1)).toBe("1 iteration");
    expect(epicRunIterationCountLabel(5)).toBe("5 iterations");
  });

  it("labels runtime modes", () => {
    expect(epicRuntimeModeLabel("approval-required")).toBe("Supervised");
    expect(epicRuntimeModeLabel("full-access")).toBe("Full access");
  });
});

describe("epic run history", () => {
  const identity = { epicId: "epic-1", projectId: "project-1", cwd: "/repo" };

  it("puts the newest run first and keeps the rest as history", () => {
    const oldest = historyRun({ runId: "run-a", updatedAt: "2026-07-29T00:00:00.000Z" });
    const middle = historyRun({ runId: "run-b", updatedAt: "2026-07-29T01:00:00.000Z" });
    const newest = historyRun({ runId: "run-c", updatedAt: "2026-07-29T02:00:00.000Z" });

    expect(epicRunHistory([middle, oldest, newest], identity)).toEqual({
      latest: newest,
      prior: [middle, oldest],
    });
  });

  it("breaks an updatedAt tie on runId, matching the list-page pill", () => {
    const lower = historyRun({ runId: "run-a" });
    const higher = historyRun({ runId: "run-b" });

    expect(epicRunHistory([lower, higher], identity).latest).toBe(higher);
  });

  it("ignores runs from another epic, project, or workspace", () => {
    const mine = historyRun({ runId: "run-mine" });
    const others = [
      historyRun({ runId: "run-other-epic", epicId: "epic-2" }),
      historyRun({ runId: "run-other-project", projectId: "project-2" }),
      historyRun({ runId: "run-other-cwd", cwd: "/other-repo" }),
    ];

    expect(epicRunHistory([...others, mine], identity)).toEqual({ latest: mine, prior: [] });
  });

  it("reports no runs at all", () => {
    expect(epicRunHistory([], identity)).toEqual({ latest: null, prior: [] });
  });

  it("finds an acknowledged run anywhere in the history, latest or earlier", () => {
    const older = historyRun({ runId: "run-a", updatedAt: "2026-07-29T00:00:00.000Z" });
    const newest = historyRun({ runId: "run-b", updatedAt: "2026-07-29T02:00:00.000Z" });
    const history = epicRunHistory([older, newest], identity);

    expect(epicRunHistoryHasRun(history, "run-b")).toBe(true);
    // A launch can answer with an already-active earlier run, so a pending
    // start must still resolve on that one.
    expect(epicRunHistoryHasRun(history, "run-a")).toBe(true);
    expect(epicRunHistoryHasRun(history, "run-c")).toBe(false);
    expect(epicRunHistoryHasRun({ latest: null, prior: [] }, "run-a")).toBe(false);
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
