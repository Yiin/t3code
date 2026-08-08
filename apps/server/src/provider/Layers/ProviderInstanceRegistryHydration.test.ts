import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerSettings,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveProviderInstanceConfigMap } from "./ProviderInstanceRegistryHydration.ts";

const PRIME_AGENT_DRIVER_KIND = ProviderDriverKind.make("primeAgent");
const primeSettings = {
  enabled: true,
  binaryPath: "prime-agent",
  launchArgs: [],
};

const settingsWithPrime = (providerInstances: ServerSettings["providerInstances"] = {}) =>
  ({
    ...DEFAULT_SERVER_SETTINGS,
    providers: {
      ...DEFAULT_SERVER_SETTINGS.providers,
      primeAgent: primeSettings,
    },
    providerInstances,
  }) as unknown as ServerSettings;

describe("deriveProviderInstanceConfigMap", () => {
  it("creates exactly one default Prime entry from the contracts catalog", () => {
    const configMap = deriveProviderInstanceConfigMap(settingsWithPrime());
    const primeEntries = Object.entries(configMap).filter(
      ([, config]) => config.driver === PRIME_AGENT_DRIVER_KIND,
    );

    expect(primeEntries).toHaveLength(1);
    expect(primeEntries[0]).toEqual([
      "primeAgent",
      {
        driver: PRIME_AGENT_DRIVER_KIND,
        config: primeSettings,
      },
    ]);
  });

  it("lets an explicit Prime instance replace the synthesized default", () => {
    const primeId = ProviderInstanceId.make("primeAgent");
    const explicitPrime = {
      driver: PRIME_AGENT_DRIVER_KIND,
      displayName: "Prime Work",
      enabled: false,
      environment: [{ name: "PRIME_TOKEN", value: "secret", sensitive: true }],
      config: { binaryPath: "/opt/bin/prime-agent", futureField: 1 },
    } as const;
    const settings = settingsWithPrime({
      [primeId]: explicitPrime,
    });

    const configMap = deriveProviderInstanceConfigMap(settings);
    expect(configMap[primeId]).toEqual(explicitPrime);
    expect(
      Object.values(configMap).filter((config) => config.driver === PRIME_AGENT_DRIVER_KIND),
    ).toHaveLength(1);
  });
});
