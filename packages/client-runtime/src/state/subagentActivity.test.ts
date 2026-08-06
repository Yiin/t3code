import { EventId, TurnId, type OrchestrationThreadActivity } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  isSubagentActivity,
  mergeSubagentActivities,
  selectLiveSubagentTail,
} from "./subagentActivity.ts";

function activity(
  id: string,
  sequence: number | undefined,
  payload: unknown = {},
  createdAt = "2026-08-05T12:00:00.000Z",
): OrchestrationThreadActivity {
  return {
    id: EventId.make(id),
    tone: "tool",
    kind: "command",
    summary: id,
    payload,
    turnId: TurnId.make("turn-1"),
    ...(sequence === undefined ? {} : { sequence }),
    createdAt,
  };
}

const subagent = {
  subagentId: "subagent-1",
  spawnedByItemId: "tool-use-1",
};

describe("subagent activity selection", () => {
  it("matches child tool rows by parentToolUseId", () => {
    expect(
      isSubagentActivity(activity("child-tool", 1, { parentToolUseId: "tool-use-1" }), subagent),
    ).toBe(true);
  });

  it("matches task rows by taskId", () => {
    expect(isSubagentActivity(activity("task", 1, { taskId: "subagent-1" }), subagent)).toBe(true);
  });

  it("excludes unrelated and malformed activities", () => {
    const activities = [
      activity("unrelated", 1, { taskId: "subagent-2" }),
      activity("primitive", 2, "not-a-record"),
      activity("match", 3, { taskId: "subagent-1" }),
    ];

    expect(selectLiveSubagentTail(activities, subagent).map(({ id }) => id)).toEqual(["match"]);
  });

  it("does not match a missing spawnedByItemId", () => {
    expect(
      isSubagentActivity(activity("absent-link", 1, { parentToolUseId: undefined }), {
        subagentId: "subagent-1",
      }),
    ).toBe(false);
  });
});

describe("mergeSubagentActivities", () => {
  it("deduplicates overlap and keeps the copy with the higher sequence", () => {
    const backfill = activity("tool-progress::1", 100, { progress: "old" });
    const live = activity("tool-progress::1", 140, { progress: "new" });

    expect(mergeSubagentActivities([[backfill]], [live])).toEqual([live]);
  });

  it("uses the later createdAt when duplicate sequences tie", () => {
    const backfill = activity(
      "task-progress::1",
      100,
      { progress: "old" },
      "2026-08-05T12:00:00.000Z",
    );
    const live = activity("task-progress::1", 100, { progress: "new" }, "2026-08-05T12:01:00.000Z");

    expect(mergeSubagentActivities([[backfill]], [live])).toEqual([live]);
  });

  it("interleaves older and newer pages in ascending display order", () => {
    const first = activity("first", 10);
    const second = activity("second", 20);
    const third = activity("third", 30);
    const sequenceLess = activity("sequence-less", undefined);

    expect(mergeSubagentActivities([[third], [first, sequenceLess]], [second])).toEqual([
      first,
      second,
      third,
      sequenceLess,
    ]);
  });

  it("handles empty pages and an empty live tail", () => {
    const only = activity("only", 1);

    expect(mergeSubagentActivities([], [])).toEqual([]);
    expect(mergeSubagentActivities([[], [only]], [])).toEqual([only]);
    expect(mergeSubagentActivities([], [only])).toEqual([only]);
  });

  it("is stable when its result is merged again", () => {
    const first = activity("first", 1);
    const second = activity("second", 2);
    const merged = mergeSubagentActivities([[second, first]], [second]);

    expect(mergeSubagentActivities([merged], merged)).toEqual(merged);
  });
});
