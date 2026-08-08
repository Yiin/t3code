import { describe, expect, it } from "vite-plus/test";

import { EPIC_RUN_CONFIG_FIELDS, ProviderInstanceId } from "@t3tools/contracts";

import { resolveEpicRunConfig } from "./epicRunConfig.ts";

describe("resolveEpicRunConfig", () => {
  it("returns defaults with exhaustive default provenance", () => {
    const result = resolveEpicRunConfig({
      file: null,
      environment: null,
      override: null,
      harness: null,
    });
    expect(result.config.engine).toBe("core");
    expect(result.config.parallel.workers).toBe(3);
    expect(result.violations).toEqual([]);
    expect(Object.keys(result.provenance).toSorted()).toEqual(
      EPIC_RUN_CONFIG_FIELDS.filter((field) => field.scope !== "terminal-only")
        .map((field) => field.key)
        .toSorted(),
    );
    expect(new Set(Object.values(result.provenance))).toEqual(new Set(["default"]));
  });

  it("applies all four layers in order and tracks sparse equal-default values", () => {
    const result = resolveEpicRunConfig({
      file: { parallel: { workers: 2 }, limits: { maxIterations: 40 } },
      environment: { parallel: { workers: 4 }, limits: { maxIterations: 30 } },
      override: { parallel: { workers: 3 }, limits: { maxIterations: 20 } },
      harness: null,
    });
    expect(result.config.parallel.workers).toBe(3);
    expect(result.config.limits.maxIterations).toBe(20);
    expect(result.provenance["parallel.workers"]).toBe("override");
    expect(result.provenance["limits.maxIterations"]).toBe("override");
    expect(result.provenance["limits.maxAttemptsPerChild"]).toBe("default");
  });

  it.each([
    {
      name: "defaults",
      file: null,
      environment: null,
      override: null,
      expected: "core",
      source: "default",
    },
    {
      name: "file",
      file: { engine: "core" as const },
      environment: null,
      override: null,
      expected: "core",
      source: "file",
    },
    {
      name: "environment over file",
      file: { engine: "core" as const },
      environment: { engine: "shadow" as const },
      override: null,
      expected: "shadow",
      source: "environment",
    },
    {
      name: "run input over environment",
      file: { engine: "core" as const },
      environment: { engine: "shadow" as const },
      override: { engine: "core" as const },
      expected: "core",
      source: "override",
    },
    {
      name: "partial layers do not erase engine",
      file: { engine: "core" as const },
      environment: { limits: { maxIterations: 2 } },
      override: { gate: { disabled: true } },
      expected: "core",
      source: "file",
    },
  ])(
    "resolves engine precedence from $name",
    ({ file, environment, override, expected, source }) => {
      const result = resolveEpicRunConfig({ file, environment, override, harness: null });
      expect(result.config.engine).toBe(expected);
      expect(result.provenance.engine).toBe(source);
    },
  );

  it("replaces arrays instead of concatenating them", () => {
    const result = resolveEpicRunConfig({
      file: { parallel: { siblings: ["../a", "../b"] } },
      environment: null,
      override: { parallel: { siblings: ["../a"] } },
      harness: null,
    });
    expect(result.config.parallel.siblings).toEqual(["../a"]);
  });

  it("pins sequential workers with policy provenance", () => {
    const result = resolveEpicRunConfig({
      file: null,
      environment: { parallel: { workers: 4 } },
      override: { execution: { sequential: true } },
      harness: null,
    });
    expect(result.config.parallel.workers).toBe(1);
    expect(result.provenance["parallel.workers"]).toBe("policy");
    expect(result.violations).toContainEqual({
      key: "parallel.workers",
      message: "Sequential execution limits parallel workers to 1.",
    });
  });

  it("allows an absent gate but rejects an explicitly enabled missing gate", () => {
    expect(
      resolveEpicRunConfig({ file: null, environment: null, override: null, harness: null })
        .violations,
    ).toEqual([]);
    expect(
      resolveEpicRunConfig({
        file: { gate: { disabled: false } },
        environment: null,
        override: null,
        harness: null,
      }).violations,
    ).toContainEqual({
      key: "gate.command",
      message: "Gate is enabled, but no gate command is configured.",
    });
    expect(
      resolveEpicRunConfig({
        file: { gate: { command: null } },
        environment: null,
        override: { gate: { disabled: true } },
        harness: null,
      }).violations,
    ).toEqual([]);
  });

  it("reports retry and inspector bounds", () => {
    const result = resolveEpicRunConfig({
      file: {
        server: { retryBaseDelayMs: 200, retryMaxDelayMs: 100 },
        supervision: { inspectMinDelaySeconds: 20, inspectMaxDelaySeconds: 10 },
      },
      environment: null,
      override: null,
      harness: null,
    });
    expect(result.violations.map((violation) => violation.key)).toEqual([
      "server.retryMaxDelayMs",
      "supervision.inspectMaxDelaySeconds",
    ]);
  });

  it("treats an object-valued registered field as one provenance leaf", () => {
    const result = resolveEpicRunConfig({
      file: {
        budget: { usd: 10 },
        provider: {
          modelSelection: {
            instanceId: ProviderInstanceId.make("custom-provider"),
            model: "model-1",
          },
        },
      },
      environment: null,
      override: null,
      harness: null,
    });
    expect(result.provenance["provider.modelSelection"]).toBe("file");
    expect(result.provenance["provider.modelSelection.instanceId"]).toBeUndefined();
    expect(result.provenance["provider.modelSelection.model"]).toBeUndefined();
    expect(result.violations).toContainEqual({
      key: "budget.usd",
      message: "The selected harness cannot enforce the budget limit.",
    });
  });

  it("pins default workers silently and reports unsupported budget enforcement", () => {
    const result = resolveEpicRunConfig({
      file: { budget: { usd: 10 } },
      environment: null,
      override: { execution: { sequential: true } },
      harness: "codex",
    });
    expect(result.config.parallel.workers).toBe(1);
    expect(result.provenance["parallel.workers"]).toBe("policy");
    expect(result.violations).toEqual([
      {
        key: "budget.usd",
        message: "The selected harness cannot enforce the budget limit.",
      },
    ]);

    expect(
      resolveEpicRunConfig({
        file: { budget: { usd: 10 } },
        environment: null,
        override: null,
        harness: "claude",
      }).violations,
    ).toEqual([]);
  });
});
