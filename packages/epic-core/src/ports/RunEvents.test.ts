import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { RunEvent } from "./RunEvents.ts";

const decodeRunEvent = Schema.decodeUnknownSync(RunEvent);

describe("RunEvent", () => {
  it("represents degraded and unavailable subagent liveness", () => {
    expect(
      decodeRunEvent({
        type: "subagent-liveness-degraded",
        runId: "run-1",
        iterationIndex: 2,
        evidence: "owned process activity",
      }),
    ).toMatchObject({ type: "subagent-liveness-degraded" });

    expect(
      decodeRunEvent({
        type: "subagent-liveness-unavailable",
        runId: "run-1",
        iterationIndex: 2,
        reason: "harness has no liveness signal",
      }),
    ).toMatchObject({ type: "subagent-liveness-unavailable" });
  });

  it("represents a released child claim", () => {
    expect(
      decodeRunEvent({
        type: "child-claim-released",
        runId: "run-1",
        issueId: "epic.1",
        iterationIndex: 2,
        reason: "retry budget exhausted; child reopened",
      }),
    ).toMatchObject({
      type: "child-claim-released",
      issueId: "epic.1",
      reason: "retry budget exhausted; child reopened",
    });
  });

  it("represents a provider fallback with routing evidence", () => {
    expect(
      decodeRunEvent({
        type: "provider-fallback",
        runId: "run-1",
        issueId: "epic.1",
        iterationIndex: 2,
        failureReason: "provider-error:rate-limit",
        fromInstanceId: "claude-work",
        fromDriver: "claudeAgent",
        fromModel: "sonnet",
        toInstanceId: "codex-personal",
        toDriver: "codex",
        toModel: "gpt-5.6-sol",
      }),
    ).toMatchObject({
      type: "provider-fallback",
      fromInstanceId: "claude-work",
      toInstanceId: "codex-personal",
    });
  });
});
