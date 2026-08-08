import { describe, expect, it } from "vite-plus/test";

import { ProviderInstanceId, type ServerConfig } from "@t3tools/contracts";

import { buildModelOptions } from "./modelOptions";

describe("mobile model options", () => {
  it("uses shared Prime metadata and a neutral unknown-driver label", () => {
    const config = {
      providers: [
        {
          instanceId: "primeAgent",
          driver: "primeAgent",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          models: [
            { slug: "prime-model", name: "Prime Model", isCustom: false, capabilities: null },
          ],
        },
        {
          instanceId: "future_local",
          driver: "futureDriver",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          models: [
            { slug: "future-model", name: "Future Model", isCustom: false, capabilities: null },
          ],
        },
      ],
    } as unknown as ServerConfig;

    const options = buildModelOptions(config, null);
    expect(options.find((option) => option.providerDriver === "primeAgent")?.providerLabel).toBe(
      "Prime Agent",
    );
    expect(options.find((option) => option.providerDriver === "futureDriver")?.providerLabel).toBe(
      "future_local",
    );
  });

  it("normalizes a legacy fallback selection against current capabilities", () => {
    const config = {
      providers: [
        {
          instanceId: "codex",
          driver: "codex",
          displayName: "Codex",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          models: [
            {
              slug: "gpt-test",
              name: "GPT Test",
              isCustom: false,
              capabilities: {
                optionDescriptors: [
                  {
                    id: "serviceTier",
                    label: "Service Tier",
                    type: "select",
                    options: [
                      { id: "default", label: "Standard", isDefault: true },
                      { id: "priority", label: "Fast" },
                    ],
                    currentValue: "default",
                  },
                ],
              },
            },
          ],
        },
      ],
    } as unknown as ServerConfig;

    const [option] = buildModelOptions(config, {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-test",
      options: [{ id: "fastMode", value: true }],
    });

    expect(option?.capabilities?.optionDescriptors?.[0]?.id).toBe("serviceTier");
    expect(option?.selection.options).toEqual([{ id: "serviceTier", value: "default" }]);
  });
});
