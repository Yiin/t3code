import type { ModelInfo as ClaudeModelInfo } from "@anthropic-ai/claude-agent-sdk";
import { assert, describe, it } from "@effect/vitest";

import { serverProviderModelsFromClaudeModelInfo } from "./ClaudeProvider.ts";
import { makeClaudeModelCatalogKey } from "../Drivers/ClaudeDriver.ts";

const liveClaudeCode21258Rows: ReadonlyArray<ClaudeModelInfo> = [
  {
    value: "default",
    resolvedModel: "claude-opus-5[1m]",
    displayName: "Default (recommended)",
    description: "Opus 5 with 1M context · Best for everyday, complex tasks",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
    supportsAdaptiveThinking: true,
    supportsFastMode: true,
    supportsAutoMode: true,
  },
  {
    value: "opus[1m]",
    resolvedModel: "claude-opus-5[1m]",
    displayName: "Opus (1M context)",
    description: "Opus 5 with 1M context · Best for everyday, complex tasks",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
    supportsAdaptiveThinking: true,
    supportsFastMode: true,
    supportsAutoMode: true,
  },
  {
    value: "claude-fable-5-1[1m]",
    resolvedModel: "claude-fable-5-1",
    displayName: "Fable",
    description: "Fable 5.1 · Most capable for your hardest and longest-running tasks",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
    supportsAdaptiveThinking: true,
    supportsAutoMode: true,
  },
  {
    value: "sonnet",
    resolvedModel: "claude-sonnet-5",
    displayName: "Sonnet",
    description: "Sonnet 5 · Efficient for routine tasks",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
    supportsAdaptiveThinking: true,
    supportsAutoMode: true,
  },
  {
    value: "haiku",
    resolvedModel: "claude-haiku-4-5-20251001",
    displayName: "Haiku",
    description: "Haiku 4.5 · Fastest for quick answers",
  },
];

describe("serverProviderModelsFromClaudeModelInfo", () => {
  it("converts the Claude Code 2.1.258 catalog into canonical models", () => {
    const models = serverProviderModelsFromClaudeModelInfo(liveClaudeCode21258Rows);

    assert.deepEqual(
      models.map((model) => ({
        slug: model.slug,
        name: model.name,
        isDefault: model.isDefault,
      })),
      [
        { slug: "claude-opus-5", name: "Claude Opus 5", isDefault: true },
        { slug: "claude-fable-5-1", name: "Claude Fable 5.1", isDefault: undefined },
        { slug: "claude-sonnet-5", name: "Claude Sonnet 5", isDefault: undefined },
        { slug: "claude-haiku-4-5", name: "Claude Haiku 4.5", isDefault: undefined },
      ],
    );
  });

  it("dedupes aliases and keeps the default marker in either row order", () => {
    const canonical: ClaudeModelInfo = {
      value: "opus",
      resolvedModel: "claude-opus-5[1m]",
      displayName: "Opus",
      description: "Opus 5",
    };
    const defaultAlias: ClaudeModelInfo = {
      ...canonical,
      value: "default",
      displayName: "Default (recommended)",
    };
    const shortAlias: ClaudeModelInfo = {
      value: "opus",
      displayName: "Opus",
      description: "Opus 5",
    };

    for (const rows of [
      [defaultAlias, canonical, shortAlias],
      [canonical, shortAlias, defaultAlias],
    ]) {
      const models = serverProviderModelsFromClaudeModelInfo(rows);
      assert.equal(models.length, 1);
      assert.equal(models[0]?.slug, "claude-opus-5");
      assert.equal(models[0]?.isDefault, true);
    }
  });

  it("derives readable capabilities for future models", () => {
    const [model] = serverProviderModelsFromClaudeModelInfo([
      {
        value: "nova",
        resolvedModel: "claude-nova-6-2[1m]",
        displayName: "Nova",
        description: "A future model",
        supportsEffort: true,
        supportedEffortLevels: ["low", "xhigh", "max"],
        supportsFastMode: true,
      },
    ]);

    assert.equal(model?.slug, "claude-nova-6-2");
    assert.equal(model?.name, "Claude Nova 6.2");
    assert.deepEqual(model?.capabilities?.optionDescriptors, [
      {
        id: "effort",
        label: "Reasoning",
        type: "select",
        options: [
          { id: "low", label: "Low" },
          { id: "xhigh", label: "Extra High" },
          { id: "max", label: "Max" },
        ],
      },
      { id: "fastMode", label: "Fast Mode", type: "boolean" },
    ]);
  });

  it("keeps an empty discovery non-authoritative", () => {
    assert.deepEqual(serverProviderModelsFromClaudeModelInfo([]), []);
  });
});

describe("makeClaudeModelCatalogKey", () => {
  it("keys catalogs by normalized Claude executable path", () => {
    assert.equal(
      makeClaudeModelCatalogKey("C:\\Tools\\Claude.EXE", "win32"),
      makeClaudeModelCatalogKey("c:/tools/claude.exe", "win32"),
    );
    assert.notEqual(
      makeClaudeModelCatalogKey("/opt/claude-a", "linux"),
      makeClaudeModelCatalogKey("/opt/claude-b", "linux"),
    );
  });
});
