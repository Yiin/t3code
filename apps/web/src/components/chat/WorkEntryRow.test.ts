import { describe, expect, it } from "vite-plus/test";

import type { WorkLogEntry } from "../../session-logic";
import { buildToolCallExpandedBody } from "./WorkEntryRow";

function workEntry(overrides: Partial<WorkLogEntry>): WorkLogEntry {
  return {
    id: "work-entry-1",
    createdAt: "2026-08-18T00:00:00.000Z",
    label: "Bash",
    tone: "tool",
    ...overrides,
  };
}

const countOccurrences = (haystack: string, needle: string): number =>
  haystack.split(needle).length - 1;

describe("buildToolCallExpandedBody", () => {
  it("prints the command once when the detail repeats it", () => {
    const body = buildToolCallExpandedBody(
      workEntry({
        command: "Bash: echo hello-qa",
        detail: "Bash: echo hello-qa",
        output: "hello-qa-output-line",
      }),
      undefined,
    );

    expect(body).toBe("Bash: echo hello-qa\n\nhello-qa-output-line");
    expect(countOccurrences(body ?? "", "Bash: echo hello-qa")).toBe(1);
  });

  it("prints a detail-only entry once", () => {
    const body = buildToolCallExpandedBody(
      workEntry({ detail: "only-detail-text", output: "only-detail-text" }),
      undefined,
    );

    expect(body).toBe("only-detail-text");
  });

  it("drops a detail that is the truncated first line of the output", () => {
    const firstLine = `alpha line one ${"a".repeat(90)}`;
    const detail = `${firstLine.slice(0, 83).trimEnd()}…`;
    const output = `${firstLine}\nbeta line two\ngamma line three`;

    const body = buildToolCallExpandedBody(workEntry({ detail, output }), undefined);

    expect(body).toBe(output);
  });

  it("drops a detail that is the untruncated first line of the output", () => {
    const body = buildToolCallExpandedBody(
      workEntry({
        detail: "alpha line one",
        output: "alpha line one\nbeta line two\ngamma line three",
      }),
      undefined,
    );

    expect(body).toBe("alpha line one\nbeta line two\ngamma line three");
  });

  it("keeps a distinct command, detail, and output in order", () => {
    const body = buildToolCallExpandedBody(
      workEntry({
        command: "pnpm test",
        detail: "Ran 3 tests",
        output: "test one passed\ntest two passed",
      }),
      undefined,
    );

    expect(body).toBe("pnpm test\n\nRan 3 tests\n\ntest one passed\ntest two passed");
  });

  it("keeps a distinct command and output", () => {
    const body = buildToolCallExpandedBody(
      workEntry({ command: "echo hello-qa", output: "hello-qa" }),
      undefined,
    );

    expect(body).toBe("echo hello-qa\n\nhello-qa");
  });

  it("keeps output that only starts with the command text", () => {
    const body = buildToolCallExpandedBody(
      workEntry({
        command: "ls",
        output: "ls: cannot access 'missing': No such file or directory",
      }),
      undefined,
    );

    expect(body).toBe("ls\n\nls: cannot access 'missing': No such file or directory");
  });
});
