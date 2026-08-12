import type { SubagentSpawnSettings } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { isSubagentSpawnEnabled, nextSubagentSpawnSettings } from "./BetaSettingsPanel.logic";

describe("nextSubagentSpawnSettings", () => {
  it("turns an empty block on", () => {
    expect(nextSubagentSpawnSettings({}, true)).toEqual({ enabled: true });
  });

  it("turns an empty block off back to an empty block", () => {
    expect(nextSubagentSpawnSettings({ enabled: true }, false)).toEqual({});
  });

  it("keeps the file-only caps when it turns the block on", () => {
    const current: SubagentSpawnSettings = {
      allowedAgentTypes: ["Explore"],
      maxDepth: 2,
      maxConcurrentChildren: 2,
      spawnWaitTimeoutMs: 120_000,
    };
    expect(nextSubagentSpawnSettings(current, true)).toEqual({
      allowedAgentTypes: ["Explore"],
      maxDepth: 2,
      maxConcurrentChildren: 2,
      spawnWaitTimeoutMs: 120_000,
      enabled: true,
    });
  });

  it("keeps the file-only caps when it turns the block off", () => {
    const current: SubagentSpawnSettings = {
      enabled: true,
      allowedAgentTypes: ["Explore"],
      maxConcurrentChildren: 2,
    };
    expect(nextSubagentSpawnSettings(current, false)).toEqual({
      allowedAgentTypes: ["Explore"],
      maxConcurrentChildren: 2,
    });
  });

  it("does not mutate the block it was given", () => {
    const current: SubagentSpawnSettings = { enabled: true, allowedAgentTypes: ["Explore"] };
    nextSubagentSpawnSettings(current, false);
    expect(current).toEqual({ enabled: true, allowedAgentTypes: ["Explore"] });
  });
});

describe("isSubagentSpawnEnabled", () => {
  it("reads an absent flag as off", () => {
    expect(isSubagentSpawnEnabled({})).toBe(false);
    expect(isSubagentSpawnEnabled({ allowedAgentTypes: ["Explore"] })).toBe(false);
  });

  it("reads an explicit flag", () => {
    expect(isSubagentSpawnEnabled({ enabled: true })).toBe(true);
    expect(isSubagentSpawnEnabled({ enabled: false })).toBe(false);
  });
});
