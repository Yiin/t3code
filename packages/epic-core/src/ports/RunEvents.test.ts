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
});
