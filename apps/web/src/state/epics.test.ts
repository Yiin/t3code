import { epicRunIterationThreadId, ThreadId, type EpicRun } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  countUnreadEpicRuns,
  describeRunnerOwnedIteration,
  isRunActiveForThread,
  runnerOwnedIterationForThread,
} from "./epics";

const run = (
  overrides: Partial<{
    runId: string;
    status: EpicRun["status"];
    currentThreadId: string | null;
    updatedAt: string;
    recentIterations: EpicRun["recentIterations"];
  }>,
): EpicRun =>
  ({
    runId: "run-1",
    epicId: "epic-1",
    projectId: "project-1",
    cwd: "/repo",
    status: "running",
    currentThreadId: "thread-1",
    threadRefs: [],
    recentIterations: [],
    createdAt: "2026-07-29T10:00:00.000Z",
    updatedAt: "2026-07-29T10:00:00.000Z",
    startedAt: "2026-07-29T10:00:00.000Z",
    endedAt: null,
    ...overrides,
  }) as unknown as EpicRun;

const iteration = (
  overrides: Partial<{
    iterationIndex: number;
    turnStatus: EpicRun["recentIterations"][number]["turnStatus"];
    issueId: string | null;
  }>,
): EpicRun["recentIterations"][number] =>
  ({
    iterationIndex: 0,
    threadId: "thread-x",
    issueId: "epic-1.1",
    turnStatus: "running",
    summary: null,
    why: null,
    startedAt: "2026-07-29T10:00:00.000Z",
    finishedAt: null,
    ...overrides,
  }) as unknown as EpicRun["recentIterations"][number];

describe("epic run sidebar state", () => {
  it("only treats the current thread of a running run as active", () => {
    const threadId = ThreadId.make("thread-1");
    expect(isRunActiveForThread([run({})], threadId)).toBe(true);
    expect(isRunActiveForThread([run({ status: "paused" })], threadId)).toBe(false);
    expect(isRunActiveForThread([run({ currentThreadId: "thread-2" })], threadId)).toBe(false);
  });

  it("counts only done and failed runs updated after the last visit across environments", () => {
    const afterVisit = "2026-07-29T10:01:00.000Z";
    expect(
      countUnreadEpicRuns(
        [
          [
            run({ runId: "done", status: "done", updatedAt: afterVisit }),
            run({ runId: "failed", status: "failed", updatedAt: afterVisit }),
            run({ runId: "running", status: "running", updatedAt: afterVisit }),
          ],
          [
            run({ runId: "cancelled", status: "cancelled", updatedAt: afterVisit }),
            run({ runId: "old", status: "done", updatedAt: "2026-07-29T09:59:00.000Z" }),
            run({ runId: "invalid", status: "failed", updatedAt: "not-a-date" }),
          ],
        ],
        "2026-07-29T10:00:00.000Z",
      ),
    ).toBe(2);
  });

  it("treats all valid terminal runs as unread before the first visit", () => {
    expect(countUnreadEpicRuns([[run({ status: "done" })]], null)).toBe(1);
  });
});

describe("runner-owned iterations", () => {
  const iterationThreadId = epicRunIterationThreadId({ runId: "run-1", iterationIndex: 3 });

  it("reports the run and child behind a still-running iteration row", () => {
    expect(
      runnerOwnedIterationForThread(
        [run({ recentIterations: [iteration({ iterationIndex: 3, issueId: "epic-1.7" })] })],
        iterationThreadId,
      ),
    ).toEqual({
      runId: "run-1",
      epicId: "epic-1",
      projectId: "project-1",
      iterationIndex: 3,
      issueId: "epic-1.7",
    });
  });

  it("releases the thread as soon as its own row leaves running", () => {
    for (const turnStatus of ["completed", "failed", "abandoned"] as const) {
      expect(
        runnerOwnedIterationForThread(
          [run({ recentIterations: [iteration({ iterationIndex: 3, turnStatus })] })],
          iterationThreadId,
        ),
      ).toBeNull();
    }
  });

  it("matches on the iteration the thread names, not on any running sibling", () => {
    expect(
      runnerOwnedIterationForThread(
        [run({ recentIterations: [iteration({ iterationIndex: 4 })] })],
        iterationThreadId,
      ),
    ).toBeNull();
  });

  it("leaves ordinary threads and unknown runs alone", () => {
    const runs = [run({ recentIterations: [iteration({ iterationIndex: 3 })] })];
    expect(runnerOwnedIterationForThread(runs, "thread-1")).toBeNull();
    expect(
      runnerOwnedIterationForThread(
        runs,
        epicRunIterationThreadId({ runId: "run-2", iterationIndex: 3 }),
      ),
    ).toBeNull();
    expect(runnerOwnedIterationForThread(null, iterationThreadId)).toBeNull();
  });

  it("names the child when the row has one, and the iteration when it does not", () => {
    const owned = {
      runId: "run-1",
      epicId: "epic-1",
      projectId: "project-1",
      iterationIndex: 3,
      issueId: "epic-1.7",
    } as const;
    expect(describeRunnerOwnedIteration(owned).title).toBe("Epic run epic-1 owns this thread");
    expect(describeRunnerOwnedIteration(owned).description).toContain("running epic-1.7");
    expect(describeRunnerOwnedIteration({ ...owned, issueId: null }).description).toContain(
      "running iteration 3",
    );
  });
});
