import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  attachmentCapabilityForDriver,
  BUILT_IN_PROVIDER_DRIVER_KINDS,
  PRIME_AGENT_DRIVER_KIND,
  ProviderAttachmentSupport,
  ProviderDriverKind,
  ProviderInstanceConfig,
  ProviderInstanceConfigMap,
  ProviderInstanceId,
  ProviderInstanceRef,
  UNKNOWN_DRIVER_ATTACHMENT_CAPABILITY,
} from "./providerInstance.ts";

describe("built-in provider catalog", () => {
  it("includes Prime without closing the driver slug schema", () => {
    expect(PRIME_AGENT_DRIVER_KIND).toBe("primeAgent");
    expect(BUILT_IN_PROVIDER_DRIVER_KINDS).toContain(PRIME_AGENT_DRIVER_KIND);
    expect(decodeProviderDriverKind("futureDriver")).toBe("futureDriver");
  });
});

const decodeProviderDriverKind = Schema.decodeUnknownSync(ProviderDriverKind);
const decodeProviderInstanceId = Schema.decodeUnknownSync(ProviderInstanceId);
const decodeProviderInstanceRef = Schema.decodeUnknownSync(ProviderInstanceRef);
const decodeProviderInstanceConfig = Schema.decodeUnknownSync(ProviderInstanceConfig);
const decodeProviderInstanceConfigMap = Schema.decodeUnknownSync(ProviderInstanceConfigMap);

describe("provider slug validation (shared by driver + instance ids)", () => {
  const cases = [
    { schemaName: "ProviderInstanceId", decode: decodeProviderInstanceId },
    { schemaName: "ProviderDriverKind", decode: decodeProviderDriverKind },
  ] as const;

  for (const { schemaName, decode } of cases) {
    describe(schemaName, () => {
      it.each(["codex", "codex_personal", "codex-work", "claudeAgent", "x", "abc123", "ollama"])(
        "accepts %s",
        (id) => {
          expect(decode(id)).toBe(id);
        },
      );

      it.each([
        ["empty string", ""],
        ["leading digit", "1codex"],
        ["leading dash", "-codex"],
        ["leading underscore", "_codex"],
        ["whitespace inside", "codex personal"],
        ["dot inside", "codex.personal"],
        ["slash inside", "codex/personal"],
      ])("rejects %s", (_label, value) => {
        expect(() => decode(value)).toThrow();
      });

      it("trims surrounding whitespace before validating", () => {
        expect(decode("  codex_work  ")).toBe("codex_work");
      });

      it("rejects ids longer than 64 characters", () => {
        const tooLong = "a".repeat(65);
        expect(() => decode(tooLong)).toThrow();
        const justRight = "a".repeat(64);
        expect(decode(justRight)).toBe(justRight);
      });
    });
  }
});

describe("ProviderInstanceRef", () => {
  it("decodes a driver ref", () => {
    const ref = decodeProviderInstanceRef({
      instanceId: "codex_work",
      driver: "codex",
    });
    expect(ref.instanceId).toBe("codex_work");
    expect(ref.driver).toBe("codex");
  });

  it("decodes a fork-defined driver ref without complaint", () => {
    const ref = decodeProviderInstanceRef({
      instanceId: "ollama_local",
      driver: "ollama",
    });
    expect(ref.instanceId).toBe("ollama_local");
    expect(ref.driver).toBe("ollama");
  });

  it("rejects refs whose driver field is not a valid slug", () => {
    expect(() =>
      decodeProviderInstanceRef({
        instanceId: "codex",
        driver: "1nope",
      }),
    ).toThrow();
  });
});

describe("ProviderInstanceConfig", () => {
  it("accepts a minimal config envelope for a driver", () => {
    const decoded = decodeProviderInstanceConfig({ driver: "codex" });
    expect(decoded.driver).toBe("codex");
    expect(decoded.displayName).toBeUndefined();
    expect(decoded.enabled).toBeUndefined();
    expect(decoded.config).toBeUndefined();
  });

  it("preserves driver-opaque config payloads verbatim", () => {
    const opaqueConfig = { homePath: "~/.codex_personal", binaryPath: "codex" };
    const decoded = decodeProviderInstanceConfig({
      driver: "codex",
      displayName: "Codex (personal)",
      accentColor: "#dc2626",
      enabled: true,
      config: opaqueConfig,
    });
    expect(decoded.displayName).toBe("Codex (personal)");
    expect(decoded.accentColor).toBe("#dc2626");
    expect(decoded.enabled).toBe(true);
    expect(decoded.config).toEqual(opaqueConfig);
  });

  it("trims provider instance envelope fields", () => {
    const decoded = decodeProviderInstanceConfig({
      driver: "  codex  ",
      displayName: "  Codex Personal  ",
      accentColor: "  #dc2626  ",
      environment: [{ name: "  OPENROUTER_API_KEY  ", value: "  sk-or-test  " }],
    });

    expect(decoded).toMatchObject({
      driver: "codex",
      displayName: "Codex Personal",
      accentColor: "#dc2626",
      environment: [{ name: "OPENROUTER_API_KEY", value: "  sk-or-test  " }],
    });
  });

  it("decodes generic environment variables on the instance envelope", () => {
    const decoded = decodeProviderInstanceConfig({
      driver: "claudeAgent",
      environment: [
        { name: "ANTHROPIC_BASE_URL", value: "https://openrouter.ai/api", sensitive: false },
        { name: "OPENROUTER_API_KEY", value: "sk-or-test", sensitive: true },
        { name: "ANTHROPIC_API_KEY", value: "", sensitive: false },
      ],
    });

    expect(decoded.environment).toEqual([
      { name: "ANTHROPIC_BASE_URL", value: "https://openrouter.ai/api", sensitive: false },
      { name: "OPENROUTER_API_KEY", value: "sk-or-test", sensitive: true },
      { name: "ANTHROPIC_API_KEY", value: "", sensitive: false },
    ]);
  });

  it("rejects invalid environment variable names", () => {
    expect(() =>
      decodeProviderInstanceConfig({
        driver: "codex",
        environment: [{ name: "HAS-DASH", value: "x", sensitive: false }],
      }),
    ).toThrow();
  });

  it("decodes envelopes that name an unknown driver and preserves their config opaquely", () => {
    const opaqueConfig = { someUnknownKnob: 42, model: "llama3" };
    const decoded = decodeProviderInstanceConfig({
      driver: "ollama",
      displayName: "Ollama",
      enabled: true,
      config: opaqueConfig,
    });
    expect(decoded.driver).toBe("ollama");
    expect(decoded.config).toEqual(opaqueConfig);
  });

  it("rejects a blank displayName (must be trimmed non-empty)", () => {
    expect(() => decodeProviderInstanceConfig({ driver: "codex", displayName: "   " })).toThrow();
  });

  it("rejects driver values that do not satisfy the slug pattern", () => {
    expect(() => decodeProviderInstanceConfig({ driver: "" })).toThrow();
    expect(() => decodeProviderInstanceConfig({ driver: "has spaces" })).toThrow();
  });
});

describe("ProviderInstanceConfigMap", () => {
  it("decodes a multi-instance map mixing first-party and fork drivers", () => {
    const decoded = decodeProviderInstanceConfigMap({
      codex_personal: {
        driver: "codex",
        displayName: "Codex (personal)",
        config: { homePath: "~/.codex_personal" },
      },
      codex_work: {
        driver: "codex",
        config: { homePath: "~/.codex_work" },
      },
      claudeAgent: { driver: "claudeAgent" },
      ollama_local: { driver: "ollama", config: { endpoint: "http://localhost:11434" } },
    });
    expect(new Set(Object.keys(decoded))).toEqual(
      new Set(["claudeAgent", "codex_personal", "codex_work", "ollama_local"]),
    );
    expect(decoded[ProviderInstanceId.make("codex_personal")]?.driver).toBe("codex");
    expect(decoded[ProviderInstanceId.make("codex_work")]?.config).toEqual({
      homePath: "~/.codex_work",
    });
    expect(decoded[ProviderInstanceId.make("ollama_local")]?.driver).toBe("ollama");
  });

  it("rejects keys that fail the instance-id pattern", () => {
    expect(() =>
      decodeProviderInstanceConfigMap({
        "1codex": { driver: "codex" },
      }),
    ).toThrow();
  });
});

describe("attachmentCapabilityForDriver", () => {
  const isSupport = Schema.is(ProviderAttachmentSupport);

  it.each([...BUILT_IN_PROVIDER_DRIVER_KINDS])("declares %s explicitly", (driver) => {
    const capability = attachmentCapabilityForDriver(driver);
    expect(capability).not.toBe(UNKNOWN_DRIVER_ATTACHMENT_CAPABILITY);
    expect(isSupport(capability.images)).toBe(true);
    expect(isSupport(capability.files)).toBe(true);
  });

  it.each([...BUILT_IN_PROVIDER_DRIVER_KINDS])("gives %s a valid mime list or null", (driver) => {
    const { imageMimeTypes, fileMimeTypes } = attachmentCapabilityForDriver(driver);
    for (const list of [imageMimeTypes, fileMimeTypes]) {
      if (list === null) continue;
      expect(list.length).toBeGreaterThan(0);
      for (const mimeType of list) {
        expect(mimeType).toMatch(/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i);
      }
    }
  });

  it("falls back to the conservative default for an unknown driver", () => {
    expect(attachmentCapabilityForDriver(ProviderDriverKind.make("futureDriver"))).toBe(
      UNKNOWN_DRIVER_ATTACHMENT_CAPABILITY,
    );
  });

  it("refuses files in the conservative default", () => {
    expect(UNKNOWN_DRIVER_ATTACHMENT_CAPABILITY.files).toBe("unsupported");
    expect(UNKNOWN_DRIVER_ATTACHMENT_CAPABILITY.fileMimeTypes).toBeNull();
  });

  it("limits Claude to the mime types its SDK blocks carry", () => {
    const capability = attachmentCapabilityForDriver(ProviderDriverKind.make("claudeAgent"));
    expect(capability.imageMimeTypes).toEqual([
      "image/gif",
      "image/jpeg",
      "image/png",
      "image/webp",
    ]);
    expect(capability.fileMimeTypes).toEqual(["application/pdf", "text/plain"]);
  });

  it("routes files by path for the drivers whose protocol has no file member", () => {
    for (const driver of ["codex", "cursor", "primeAgent"]) {
      expect(attachmentCapabilityForDriver(ProviderDriverKind.make(driver)).files).toBe(
        "path-reference",
      );
    }
  });
});
