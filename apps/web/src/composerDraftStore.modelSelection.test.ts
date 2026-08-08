import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { describe, expect, it } from "vite-plus/test";

import { deriveEffectiveComposerModelState } from "./composerDraftStore.ts";

const PRIME_DRIVER = ProviderDriverKind.make("primeAgent");
const PRIME_INSTANCE = ProviderInstanceId.make("primeAgent");
const PRIME_WORK_INSTANCE = ProviderInstanceId.make("prime_work");
const CODEX_INSTANCE = ProviderInstanceId.make("codex");

function provider(input: {
  readonly instanceId: string;
  readonly driver: string;
  readonly models: ReadonlyArray<{ readonly slug: string; readonly isDefault?: boolean }>;
}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(input.instanceId),
    driver: ProviderDriverKind.make(input.driver),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: input.models.map((model) => ({
      slug: model.slug,
      name: model.slug,
      isCustom: false,
      ...(model.isDefault ? { isDefault: true } : {}),
      capabilities: null,
    })),
    slashCommands: [],
    skills: [],
  };
}

describe("deriveEffectiveComposerModelState exact-instance isolation", () => {
  it("keeps an empty Prime instance empty when project and thread models are stale", () => {
    const providers = [
      provider({ instanceId: "primeAgent", driver: "primeAgent", models: [] }),
      provider({
        instanceId: "codex",
        driver: "codex",
        models: [{ slug: "gpt-codex", isDefault: true }],
      }),
    ];

    const result = deriveEffectiveComposerModelState({
      draft: null,
      providers,
      selectedProvider: PRIME_DRIVER,
      selectedInstanceId: PRIME_INSTANCE,
      threadModelSelection: { instanceId: CODEX_INSTANCE, model: "gpt-codex" },
      projectModelSelection: { instanceId: CODEX_INSTANCE, model: "gpt-project" },
      settings: DEFAULT_UNIFIED_SETTINGS,
    });

    expect(result.selectedModel).toBe("");
  });

  it("ignores a legacy sibling draft for a selected custom Prime instance", () => {
    const providers = [
      provider({
        instanceId: "primeAgent",
        driver: "primeAgent",
        models: [{ slug: "shared-model", isDefault: true }],
      }),
      provider({
        instanceId: "prime_work",
        driver: "primeAgent",
        models: [{ slug: "prime-work-default", isDefault: true }, { slug: "shared-model" }],
      }),
    ];

    const result = deriveEffectiveComposerModelState({
      draft: {
        activeProvider: PRIME_WORK_INSTANCE,
        modelSelectionByProvider: {
          [PRIME_INSTANCE]: { instanceId: PRIME_INSTANCE, model: "shared-model" },
        },
      },
      providers,
      selectedProvider: PRIME_DRIVER,
      selectedInstanceId: PRIME_WORK_INSTANCE,
      threadModelSelection: null,
      projectModelSelection: null,
      settings: DEFAULT_UNIFIED_SETTINGS,
    });

    expect(result.selectedModel).toBe("prime-work-default");
  });

  it("does not accept a matching slug from a different base-selection instance", () => {
    const providers = [
      provider({
        instanceId: "codex",
        driver: "codex",
        models: [{ slug: "shared-model", isDefault: true }],
      }),
      provider({
        instanceId: "prime_work",
        driver: "primeAgent",
        models: [{ slug: "prime-work-default", isDefault: true }, { slug: "shared-model" }],
      }),
    ];

    const result = deriveEffectiveComposerModelState({
      draft: null,
      providers,
      selectedProvider: PRIME_DRIVER,
      selectedInstanceId: PRIME_WORK_INSTANCE,
      threadModelSelection: { instanceId: CODEX_INSTANCE, model: "shared-model" },
      projectModelSelection: { instanceId: CODEX_INSTANCE, model: "shared-model" },
      settings: DEFAULT_UNIFIED_SETTINGS,
    });

    expect(result.selectedModel).toBe("prime-work-default");
  });

  it("rejects an exact-instance draft key whose payload names another instance", () => {
    const providers = [
      provider({
        instanceId: "prime_work",
        driver: "primeAgent",
        models: [{ slug: "prime-work-default", isDefault: true }, { slug: "shared-model" }],
      }),
    ];

    const result = deriveEffectiveComposerModelState({
      draft: {
        activeProvider: PRIME_WORK_INSTANCE,
        modelSelectionByProvider: {
          [PRIME_WORK_INSTANCE]: {
            instanceId: PRIME_INSTANCE,
            model: "shared-model",
            options: [{ id: "thinking", value: "high" }],
          },
        },
      },
      providers,
      selectedProvider: PRIME_DRIVER,
      selectedInstanceId: PRIME_WORK_INSTANCE,
      threadModelSelection: null,
      projectModelSelection: null,
      settings: DEFAULT_UNIFIED_SETTINGS,
    });

    expect(result.selectedModel).toBe("prime-work-default");
    expect(result.modelOptions).toBeNull();
  });

  it("keeps a valid draft for the exact selected instance", () => {
    const providers = [
      provider({
        instanceId: "primeAgent",
        driver: "primeAgent",
        models: [{ slug: "prime-sibling", isDefault: true }],
      }),
      provider({
        instanceId: "prime_work",
        driver: "primeAgent",
        models: [{ slug: "prime-work-default", isDefault: true }, { slug: "prime-work-selected" }],
      }),
    ];

    const result = deriveEffectiveComposerModelState({
      draft: {
        activeProvider: PRIME_WORK_INSTANCE,
        modelSelectionByProvider: {
          [PRIME_INSTANCE]: { instanceId: PRIME_INSTANCE, model: "prime-sibling" },
          [PRIME_WORK_INSTANCE]: {
            instanceId: PRIME_WORK_INSTANCE,
            model: "prime-work-selected",
          },
        },
      },
      providers,
      selectedProvider: PRIME_DRIVER,
      selectedInstanceId: PRIME_WORK_INSTANCE,
      threadModelSelection: null,
      projectModelSelection: null,
      settings: DEFAULT_UNIFIED_SETTINGS,
    });

    expect(result.selectedModel).toBe("prime-work-selected");
  });
});
