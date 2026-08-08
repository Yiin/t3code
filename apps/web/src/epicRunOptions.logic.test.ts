import { describe, expect, it } from "@effect/vitest";
import { DEFAULT_EPIC_RUN_CONFIG } from "@t3tools/contracts";

import {
  buildEpicRunConfigOverride,
  EPIC_RUN_PROVENANCE_CHIP_LABELS,
  epicRunEffectiveValue,
  epicRunProvenanceChipLabel,
  formatEpicRunOptionValue,
} from "./epicRunOptions.logic";

describe("epicRunProvenanceChipLabel", () => {
  it("labels every provenance source", () => {
    expect(EPIC_RUN_PROVENANCE_CHIP_LABELS).toEqual({
      default: "default",
      file: "from .t3code/epic-run.json",
      environment: "from environment",
      override: "set for this run",
      policy: "from policy",
    });
  });

  it("falls back to the default label for a missing provenance entry", () => {
    expect(epicRunProvenanceChipLabel(undefined)).toBe("default");
    expect(epicRunProvenanceChipLabel("file")).toBe("from .t3code/epic-run.json");
  });
});

describe("epicRunEffectiveValue", () => {
  it("reads top-level and nested dotted keys", () => {
    expect(epicRunEffectiveValue(DEFAULT_EPIC_RUN_CONFIG, "engine")).toBe("core");
    expect(epicRunEffectiveValue(DEFAULT_EPIC_RUN_CONFIG, "gate.disabled")).toBe(false);
    expect(epicRunEffectiveValue(DEFAULT_EPIC_RUN_CONFIG, "parallel.workers")).toBe(3);
  });

  it("returns undefined for keys outside the resolved config", () => {
    // Terminal-only registry keys are not part of EpicRunConfig.
    expect(epicRunEffectiveValue(DEFAULT_EPIC_RUN_CONFIG, "terminal.binary")).toBeUndefined();
    expect(epicRunEffectiveValue(DEFAULT_EPIC_RUN_CONFIG, "nope")).toBeUndefined();
  });
});

describe("buildEpicRunConfigOverride", () => {
  it("returns undefined when nothing was touched", () => {
    expect(buildEpicRunConfigOverride(new Map())).toBeUndefined();
  });

  it("contains only the touched field", () => {
    const override = buildEpicRunConfigOverride(new Map([["vcs.noPush", true]]));
    expect(override).toEqual({ vcs: { noPush: true } });
  });

  it("nests dotted keys and keeps sibling sections separate", () => {
    const override = buildEpicRunConfigOverride(
      new Map<string, unknown>([
        ["gate.command", "bun run gate"],
        ["gate.disabled", false],
        ["parallel.workers", 2],
        ["engine", "shadow"],
      ]),
    );
    expect(override).toEqual({
      engine: "shadow",
      gate: { command: "bun run gate", disabled: false },
      parallel: { workers: 2 },
    });
  });

  it("passes null and array values through untouched", () => {
    const override = buildEpicRunConfigOverride(
      new Map<string, unknown>([
        ["budget.usd", null],
        ["parallel.siblings", ["../a", "../b"]],
      ]),
    );
    expect(override).toEqual({
      budget: { usd: null },
      parallel: { siblings: ["../a", "../b"] },
    });
  });
});

describe("formatEpicRunOptionValue", () => {
  it.each([
    [null, "—"],
    [undefined, "—"],
    [true, "on"],
    [false, "off"],
    [[], "—"],
    [["../a", "../b"], "../a, ../b"],
    [3, "3"],
    ["core", "core"],
    [{ model: "gpt-5" }, '{"model":"gpt-5"}'],
  ])("formats %s as %s", (value, expected) => {
    expect(formatEpicRunOptionValue(value)).toBe(expected);
  });
});
