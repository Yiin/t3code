import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { getDefaultServerModel } from "./providerModels.ts";

function provider(driver: string, models: ServerProvider["models"]): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(driver),
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models,
    slashCommands: [],
    skills: [],
  };
}

const model = (slug: string, isCustom = false, isDefault = false) => ({
  slug,
  name: slug,
  isCustom,
  ...(isDefault ? { isDefault: true } : {}),
  capabilities: null,
});

describe("getDefaultServerModel", () => {
  it("uses a custom live model when the provider declares it as default", () => {
    const providers = [
      provider("primeAgent", [model("prime-first"), model("prime-custom", true, true)]),
    ];

    expect(getDefaultServerModel(providers, ProviderDriverKind.make("primeAgent"))).toBe(
      "prime-custom",
    );
  });

  it("does not use the global Codex default for an empty Prime inventory", () => {
    expect(
      getDefaultServerModel([provider("primeAgent", [])], ProviderDriverKind.make("primeAgent")),
    ).toBeUndefined();
  });

  it("keeps static fallbacks scoped to their provider", () => {
    const providers = [provider("primeAgent", []), provider("claudeAgent", [])];

    expect(getDefaultServerModel(providers, ProviderDriverKind.make("claudeAgent"))).toBe(
      "claude-sonnet-5",
    );
  });
});
