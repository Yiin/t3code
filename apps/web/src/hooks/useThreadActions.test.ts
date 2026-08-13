import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { ThreadArchiveBlockedError, ThreadRunnerOwnedError } from "./useThreadActions";

describe("ThreadArchiveBlockedError", () => {
  it("keeps the blocked thread context with the fixed message", () => {
    const error = new ThreadArchiveBlockedError({
      environmentId: EnvironmentId.make("environment-1"),
      threadId: ThreadId.make("thread-1"),
    });

    expect(error).toMatchObject({
      environmentId: "environment-1",
      threadId: "thread-1",
    });
    expect(error.message).toBe("Cannot archive a running thread.");
  });
});

describe("ThreadRunnerOwnedError", () => {
  it("reports the run's own explanation rather than a fixed message", () => {
    const error = new ThreadRunnerOwnedError({
      environmentId: EnvironmentId.make("environment-1"),
      threadId: ThreadId.make("epic-run-run-1-3"),
      detail: "A worker is running epic-1.7.",
    });

    expect(error.message).toBe("A worker is running epic-1.7.");
  });
});
