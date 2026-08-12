import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildSubagentDiffAttribution,
  formatSubagentDiffBadge,
  readSubagentDiffLabels,
  resolveSubagentLabel,
} from "./subagentDiffAttribution";

const REVIEWER = ThreadId.make("subagent:thread-parent-reviewer");
const TESTER = ThreadId.make("subagent:thread-parent-tester");

describe("buildSubagentDiffAttribution", () => {
  it("indexes every path a subagent wrote", () => {
    const attribution = buildSubagentDiffAttribution([
      { threadId: REVIEWER, title: "Reviewer", paths: ["src/index.ts", "docs/notes.md"] },
    ]);

    expect(readSubagentDiffLabels(attribution, "src/index.ts")).toEqual(["Reviewer"]);
    expect(readSubagentDiffLabels(attribution, "docs/notes.md")).toEqual(["Reviewer"]);
    expect(readSubagentDiffLabels(attribution, "src/other.ts")).toEqual([]);
  });

  it("lists every subagent that wrote the same path, once each", () => {
    const attribution = buildSubagentDiffAttribution([
      { threadId: REVIEWER, title: "Reviewer", paths: ["src/index.ts", "src/index.ts"] },
      { threadId: TESTER, title: "Tester", paths: ["src/index.ts"] },
    ]);

    expect(readSubagentDiffLabels(attribution, "src/index.ts")).toEqual(["Reviewer", "Tester"]);
  });

  it("matches a path the patch reports with a ./ prefix or backslashes", () => {
    const attribution = buildSubagentDiffAttribution([
      { threadId: REVIEWER, title: "Reviewer", paths: ["src/index.ts"] },
    ]);

    expect(readSubagentDiffLabels(attribution, "./src/index.ts")).toEqual(["Reviewer"]);
    expect(readSubagentDiffLabels(attribution, "src\\index.ts")).toEqual(["Reviewer"]);
  });

  it("returns an empty index for a turn with no subagents", () => {
    expect(readSubagentDiffLabels(buildSubagentDiffAttribution([]), "src/index.ts")).toEqual([]);
    expect(readSubagentDiffLabels(buildSubagentDiffAttribution(undefined), "a.ts")).toEqual([]);
  });
});

describe("resolveSubagentLabel", () => {
  it("falls back to the thread id when the title is blank", () => {
    expect(resolveSubagentLabel({ threadId: REVIEWER, title: "   ", paths: [] })).toBe(REVIEWER);
  });
});

describe("formatSubagentDiffBadge", () => {
  it("names one subagent and counts the rest", () => {
    expect(formatSubagentDiffBadge([])).toBeNull();
    expect(formatSubagentDiffBadge(["Reviewer"])).toBe("Reviewer");
    expect(formatSubagentDiffBadge(["Reviewer", "Tester"])).toBe("Reviewer +1");
  });
});
