import { describe, expect, it } from "@effect/vitest";

import { formatEpicPlanMarker, parseTerminalEpicPlanMarker } from "./epicPlanMarker.ts";

describe("epic plan terminal marker", () => {
  it("formats and parses the versioned marker", () => {
    const marker = formatEpicPlanMarker("t3code-vst");
    expect(marker).toBe('T3_EPIC_PLAN: {"v":1,"epicId":"t3code-vst"}');
    expect(parseTerminalEpicPlanMarker(`Planned.\n${marker}\n`)).toEqual({
      v: 1,
      epicId: "t3code-vst",
    });
  });

  it.each([
    'T3_EPIC_PLAN: {"v":2,"epicId":"x"}',
    'T3_EPIC_PLAN: {"v":1,"epicId":""}',
    'T3_EPIC_PLAN: {"v":1,"epicId":"x","cwd":"/tmp"}',
    'T3_EPIC_PLAN: {"v":1,"epicId":"x"} trailing',
    'T3_EPIC_PLAN: {"v":1,"epicId":"x"}\nmore prose',
    'T3_EPIC_PLAN: {"v":1,"epicId":"x"}\nT3_EPIC_PLAN: {"v":1,"epicId":"y"}',
  ])("rejects malformed, non-terminal, or multiple markers: %s", (text) => {
    expect(parseTerminalEpicPlanMarker(text)).toBeNull();
  });
});
