import { assert, describe, it } from "@effect/vitest";
import { resolveEpicRunConfig } from "@t3tools/shared/epicRunConfig";

import { selectTerminalExecution } from "./epicCook.ts";

const snapshot = (environment: Parameters<typeof resolveEpicRunConfig>[0]["environment"]) =>
  resolveEpicRunConfig({ file: null, environment, override: null, harness: null });

describe("selectTerminalExecution", () => {
  it("defaults to the three-worker pool when nothing is configured", () => {
    const resolved = snapshot(null);
    assert.equal(resolved.config.parallel.workers, 3);
    assert.equal(resolved.provenance["parallel.workers"], "default");
    assert.equal(selectTerminalExecution(resolved), "parallel");
  });

  it("selects the pool on the default worker count alone", () => {
    // parallel.workers defaults to 3, and no override is needed to take it.
    const resolved = snapshot({});
    assert.equal(resolved.config.parallel.workers, 3);
    assert.equal(selectTerminalExecution(resolved), "parallel");
  });

  it("selects parallel when the environment sets workers above 1", () => {
    assert.equal(selectTerminalExecution(snapshot({ parallel: { workers: 2 } })), "parallel");
  });

  it("stays sequential when workers is explicitly 1", () => {
    // COOKEPIC_WORKERS=1 is one of the two one-worker escapes.
    assert.equal(selectTerminalExecution(snapshot({ parallel: { workers: 1 } })), "sequential");
  });

  it("lets execution.sequential win over an explicit worker count", () => {
    const resolved = snapshot({
      execution: { sequential: true },
      parallel: { workers: 2 },
    });
    // The policy clamps workers to 1 and records the clamp.
    assert.equal(resolved.config.parallel.workers, 1);
    assert.equal(resolved.provenance["parallel.workers"], "policy");
    assert.equal(selectTerminalExecution(resolved), "sequential");
  });

  it("stays sequential when sequential execution is forced without workers", () => {
    // COOKEPIC_SEQUENTIAL=1 is the other one-worker escape, and it clamps the
    // default worker count to 1.
    const resolved = snapshot({ execution: { sequential: true } });
    assert.equal(resolved.config.parallel.workers, 1);
    assert.equal(selectTerminalExecution(resolved), "sequential");
  });
});
