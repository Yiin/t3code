import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { SubagentDiffBadge } from "./SubagentDiffBadge";

describe("SubagentDiffBadge", () => {
  it("names the subagent that wrote the file", () => {
    const markup = renderToStaticMarkup(
      <SubagentDiffBadge filePath="src/child.ts" labels={["Reviewer"]} />,
    );

    expect(markup).toContain('data-subagent-diff-badge="src/child.ts"');
    expect(markup).toContain("Reviewer");
    expect(markup).toContain('aria-label="Written by subagent Reviewer, not by this chat"');
  });

  it("names the first subagent and counts the rest", () => {
    const markup = renderToStaticMarkup(
      <SubagentDiffBadge filePath="src/child.ts" labels={["Reviewer", "Tester"]} />,
    );

    expect(markup).toContain("Reviewer +1");
    expect(markup).toContain(
      'aria-label="Written by subagents Reviewer, Tester, not by this chat"',
    );
  });

  it("renders nothing for a file this chat wrote itself", () => {
    expect(renderToStaticMarkup(<SubagentDiffBadge filePath="src/own.ts" labels={[]} />)).toBe("");
  });
});
