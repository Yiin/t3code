import type { EpicRun } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { EpicRunPill } from "./EpicRunPill";

const run = (overrides: Partial<{ status: EpicRun["status"] }> = {}): EpicRun =>
  ({
    runId: "run-1",
    epicId: "proga-webapp-wxx",
    projectId: "project-1",
    cwd: "/repo",
    status: "running",
    maxIterations: 25,
    iterationsDispatched: 3,
    iterationsCompleted: 3,
    currentThreadId: "thread-1",
    noCommitStreak: 0,
    infraStreak: 0,
    threadRefs: [],
    recentIterations: [],
    createdAt: "2026-07-29T10:00:00.000Z",
    updatedAt: "2026-07-29T10:00:00.000Z",
    ...overrides,
  }) as unknown as EpicRun;

describe("EpicRunPill", () => {
  it("renders the epic id with a pulsing status dot while the run is live", () => {
    const markup = renderToStaticMarkup(<EpicRunPill run={run()} onView={() => {}} />);

    expect(markup).toContain("proga-webapp-wxx");
    expect(markup).toContain("animate-status-pulse");
    expect(markup).toContain('aria-label="View epic run proga-webapp-wxx (Running)"');
  });

  it("drops the pulse for a paused run", () => {
    const markup = renderToStaticMarkup(
      <EpicRunPill run={run({ status: "paused" })} onView={() => {}} />,
    );

    expect(markup).not.toContain("animate-status-pulse");
    expect(markup).toContain("(Paused)");
  });
});
