import { assert, describe, it } from "@effect/vitest";
import { resolveEpicRunConfig } from "@t3tools/shared/epicRunConfig";

import { selectTerminalExecution } from "./epicCook.ts";

const snapshot = (environment: Parameters<typeof resolveEpicRunConfig>[0]["environment"]) =>
  resolveEpicRunConfig({ file: null, environment, override: null, harness: null });

describe("selectTerminalExecution", () => {
  it("defaults to sequential when nothing is configured", () => {
    assert.equal(selectTerminalExecution(snapshot(null)), "sequential");
  });

  it("stays sequential on the default worker count alone", () => {
    // parallel.workers defaults to 3; an untouched config must never select
    // the pool loop.
    const resolved = snapshot({});
    assert.equal(resolved.config.parallel.workers, 3);
    assert.equal(selectTerminalExecution(resolved), "sequential");
  });

  it("selects parallel when the environment sets workers above 1", () => {
    assert.equal(selectTerminalExecution(snapshot({ parallel: { workers: 2 } })), "parallel");
  });

  it("stays sequential when workers is 1 even if explicitly set", () => {
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
    assert.equal(
      selectTerminalExecution(snapshot({ execution: { sequential: true } })),
      "sequential",
    );
  });
});
