import { describe, expect, it } from "@effect/vitest";
import { TurnId } from "@t3tools/contracts";

import { isInterruptTargetCurrent } from "./interruptTarget.ts";

describe("isInterruptTargetCurrent", () => {
  const active = TurnId.make("active-turn");

  it("preserves untargeted interrupts", () => {
    expect(isInterruptTargetCurrent(active, undefined)).toBe(true);
  });

  it("accepts only the active targeted turn", () => {
    expect(isInterruptTargetCurrent(active, active)).toBe(true);
    expect(isInterruptTargetCurrent(active, TurnId.make("stale-turn"))).toBe(false);
    expect(isInterruptTargetCurrent(undefined, TurnId.make("stale-turn"))).toBe(false);
  });
});
