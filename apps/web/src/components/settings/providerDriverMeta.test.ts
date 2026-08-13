import { describe, expect, it } from "vite-plus/test";
import { BUILT_IN_PROVIDER_DRIVER_KINDS, PRIME_AGENT_DRIVER_KIND } from "@t3tools/contracts";

import { PROVIDER_OPTIONS } from "../../session-logic";
import { PROVIDER_ICON_BY_PROVIDER } from "../chat/providerIconUtils";
import { DRIVER_OPTION_BY_VALUE, getDriverOption } from "./providerDriverMeta";
import { deriveProviderSettingsFields } from "./ProviderSettingsForm";

describe("provider driver presentation", () => {
  it("gives every built-in driver a settings definition, an icon, and a picker option", () => {
    for (const driver of BUILT_IN_PROVIDER_DRIVER_KINDS) {
      expect(DRIVER_OPTION_BY_VALUE[driver], `settings definition for ${driver}`).toBeDefined();
      expect(PROVIDER_ICON_BY_PROVIDER[driver], `icon for ${driver}`).toBeDefined();
      expect(
        PROVIDER_OPTIONS.find((option) => option.value === driver),
        `picker option for ${driver}`,
      ).toBeDefined();
    }
  });

  it("brands Prime Agent as an early-access driver", () => {
    const prime = getDriverOption(PRIME_AGENT_DRIVER_KIND);

    expect(prime).toMatchObject({ label: "Prime Agent", badgeLabel: "Early Access" });
  });

  it("renders the Prime settings form from schema annotations", () => {
    const prime = getDriverOption(PRIME_AGENT_DRIVER_KIND);
    expect(prime).toBeDefined();

    const fields = deriveProviderSettingsFields(prime!);

    expect(fields.map((field) => field.key)).toEqual(["binaryPath", "launchArgs", "sessionRoot"]);
    expect(fields[0]).toMatchObject({
      label: "Binary path",
      description: "Path to the Prime Agent binary used by this instance.",
      placeholder: "prime-agent",
    });
  });
});
