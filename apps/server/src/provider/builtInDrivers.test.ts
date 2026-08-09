import { assert, describe, it } from "@effect/vitest";

import { BUILT_IN_DRIVERS } from "./builtInDrivers.ts";

describe("BUILT_IN_DRIVERS", () => {
  it("registers every built-in driver exactly once", () => {
    const kinds = BUILT_IN_DRIVERS.map((driver) => driver.driverKind);
    assert.deepStrictEqual(kinds, [
      "codex",
      "claudeAgent",
      "cursor",
      "grok",
      "kimi",
      "opencode",
      "primeAgent",
    ]);
    assert.strictEqual(new Set(kinds).size, kinds.length);
  });
});
