import { ThreadId, type EpicRun } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { countUnreadEpicRuns, isRunActiveForThread } from "./epics";

const run = (
  overrides: Partial<{
    runId: string;
    status: EpicRun["status"];
    currentThreadId: string | null;
    updatedAt: string;
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
