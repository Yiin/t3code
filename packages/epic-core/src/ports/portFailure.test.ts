import { describe, expect, it } from "@effect/vitest";

import { BacklogError } from "./Backlog.ts";
import { GateError } from "./Gate.ts";
import { MergeQueuePortError } from "./MergeQueue.ts";

/**
 * These classes inherited an empty `message`, so every caller that logged or
 * persisted it reported nothing. Three epic runs failed with the line
 * `Epic runner failed to dispatch git.merge-queue:` and no cause while the real
 * failure — a gate that timed out after two hours — sat one level down.
 */
describe("port error messages", () => {
  const cause = new Error("Process 'flock' in '/worktree' timed out after 7200000ms");

  it("renders operation, detail and the cause for a merge queue failure", () => {
    const error = new MergeQueuePortError({
      operation: "drain",
      detail: "Could not drain the merge queue",
      cause,
    });

    expect(error.message).toBe(
      "drain: Could not drain the merge queue: Process 'flock' in '/worktree' timed out after 7200000ms",
    );
  });

  it("renders the gate's own cause so a timeout is never silent", () => {
    const error = new GateError({
      operation: "run",
      detail: "Could not run the gate in /worktree",
      cause,
    });

    expect(error.message).toContain("timed out after 7200000ms");
  });

  it("names the issue when a backlog failure carries one", () => {
    const error = new BacklogError({
      operation: "close",
      issueId: "t3code-pg7.4",
      detail: "bd exited non-zero",
    });

    expect(error.message).toBe("close [t3code-pg7.4]: bd exited non-zero");
  });

  it("omits the cause clause when there is no cause", () => {
    const error = new GateError({ operation: "lock", detail: "lock unavailable" });

    expect(error.message).toBe("lock: lock unavailable");
  });

  it("never renders an empty message", () => {
    for (const error of [
      new MergeQueuePortError({ operation: "drain", detail: "x" }),
      new GateError({ operation: "run", detail: "x" }),
      new BacklogError({ operation: "ready", detail: "x" }),
    ]) {
      expect(error.message.length).toBeGreaterThan(0);
    }
  });
});
