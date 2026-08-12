import { describe, expect, it } from "vite-plus/test";

import {
  attributeSubagentCheckpointContributions,
  foldSubagentContributions,
} from "./subagentCheckpointContributions.ts";

const child = (input: {
  threadId?: string;
  title?: string;
  completedAt: string;
  paths: ReadonlyArray<string>;
}) => ({
  threadId: input.threadId ?? "thread-child",
  title: input.title ?? "Reviewer",
  completedAt: input.completedAt,
  files: input.paths.map((path) => ({ path })),
});

describe("foldSubagentContributions", () => {
  it("folds one child's checkpoints into one row with sorted, de-duplicated paths", () => {
    const contributions = foldSubagentContributions([
      child({ completedAt: "2026-05-01T00:00:05.000Z", paths: ["src/beta.ts"] }),
      child({ completedAt: "2026-05-01T00:00:06.000Z", paths: ["src/alpha.ts", "src/beta.ts"] }),
    ]);

    expect(contributions).toEqual([
      { threadId: "thread-child", title: "Reviewer", paths: ["src/alpha.ts", "src/beta.ts"] },
    ]);
  });

  it("drops a child that wrote no file", () => {
    expect(
      foldSubagentContributions([child({ completedAt: "2026-05-01T00:00:05.000Z", paths: [] })]),
    ).toEqual([]);
  });
});

describe("attributeSubagentCheckpointContributions", () => {
  it("gives each parent checkpoint the children that completed inside its window", () => {
    const attributed = attributeSubagentCheckpointContributions({
      checkpoints: [
        { completedAt: "2026-05-01T00:00:10.000Z" },
        { completedAt: "2026-05-01T00:00:30.000Z" },
      ],
      rows: [
        child({ completedAt: "2026-05-01T00:00:05.000Z", paths: ["src/early.ts"] }),
        child({ completedAt: "2026-05-01T00:00:20.000Z", paths: ["src/beta.ts"] }),
        child({
          threadId: "thread-other",
          title: "Tester",
          completedAt: "2026-05-01T00:00:25.000Z",
          paths: ["src/alpha.ts"],
        }),
      ],
    });

    expect(attributed).toEqual([
      [{ threadId: "thread-child", title: "Reviewer", paths: ["src/early.ts"] }],
      [
        { threadId: "thread-child", title: "Reviewer", paths: ["src/beta.ts"] },
        { threadId: "thread-other", title: "Tester", paths: ["src/alpha.ts"] },
      ],
    ]);
  });

  it("leaves a child that finished after the last checkpoint unattributed", () => {
    const attributed = attributeSubagentCheckpointContributions({
      checkpoints: [{ completedAt: "2026-05-01T00:00:10.000Z" }],
      rows: [child({ completedAt: "2026-05-01T00:00:11.000Z", paths: ["src/late.ts"] })],
    });

    expect(attributed).toEqual([[]]);
  });

  it("returns one empty row per checkpoint when the thread has no children", () => {
    expect(
      attributeSubagentCheckpointContributions({
        checkpoints: [{ completedAt: "2026-05-01T00:00:10.000Z" }],
        rows: [],
      }),
    ).toEqual([[]]);
    expect(attributeSubagentCheckpointContributions({ checkpoints: [], rows: [] })).toEqual([]);
  });
});
