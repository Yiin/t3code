import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  DEFAULT_EPIC_ROLE_POLICY,
  DEFAULT_EPIC_STAGE_SUBAGENTS,
  EpicTierId,
} from "./epicRolePolicy.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import {
  ClientSettingsSchema,
  ClientSettingsPatch,
  DEFAULT_SERVER_SETTINGS,
  ServerSettings,
  ServerSettingsPatch,
} from "./settings.ts";

const decodeClientSettings = Schema.decodeUnknownSync(ClientSettingsSchema);
const decodeClientSettingsPatch = Schema.decodeUnknownSync(ClientSettingsPatch);
const decodeServerSettings = Schema.decodeUnknownSync(ServerSettings);
const decodeServerSettingsPatch = Schema.decodeUnknownSync(ServerSettingsPatch);
const encodeServerSettings = Schema.encodeSync(ServerSettings);
const encodeServerSettingsPatch = Schema.encodeSync(ServerSettingsPatch);

describe("ClientSettings word wrap", () => {
  it("defaults word wrap on", () => {
    expect(decodeClientSettings({}).wordWrap).toBe(true);
  });

  it("ignores obsolete wrapping preferences", () => {
    const decoded = decodeClientSettings({
      chatWordWrap: false,
      diffWordWrap: false,
    });

    expect(decoded.wordWrap).toBe(true);
    expect(decoded).not.toHaveProperty("chatWordWrap");
    expect(decoded).not.toHaveProperty("diffWordWrap");
  });
});

describe("ClientSettings sidebar v2", () => {
  it("defaults the beta off", () => {
    expect(decodeClientSettings({}).sidebarV2Enabled).toBe(false);
  });

  it("drops the retired per-device auto-settle key without disturbing the rest", () => {
    // Stored blobs on disk can still carry the old key. Decoding one must not
    // reset every other setting to its default.
    const decoded = decodeClientSettings({
      sidebarAutoSettleAfterDays: 7,
      sidebarV2Enabled: true,
      wordWrap: false,
    });

    expect(decoded).not.toHaveProperty("sidebarAutoSettleAfterDays");
    expect(decoded.sidebarV2Enabled).toBe(true);
    expect(decoded.wordWrap).toBe(false);
    // Even a value the old schema would have rejected must decode cleanly now.
    expect(() => decodeClientSettings({ sidebarAutoSettleAfterDays: 0 })).not.toThrow();
    expect(() => decodeClientSettingsPatch({ sidebarAutoSettleAfterDays: 0 })).not.toThrow();
  });
});

describe("ClientSettings epics grouping mode", () => {
  it("defaults to the recency-first list", () => {
    expect(decodeClientSettings({}).epicsGroupingMode).toBe("recency");
  });

  it("keeps the default when a stored blob predates the key", () => {
    const decoded = decodeClientSettings({ wordWrap: false, sidebarV2Enabled: true });
    expect(decoded.epicsGroupingMode).toBe("recency");
    expect(decoded.wordWrap).toBe(false);
  });

  it("accepts both modes as a value and as a patch", () => {
    expect(decodeClientSettings({ epicsGroupingMode: "project" }).epicsGroupingMode).toBe(
      "project",
    );
    expect(decodeClientSettingsPatch({ epicsGroupingMode: "recency" }).epicsGroupingMode).toBe(
      "recency",
    );
    expect(decodeClientSettingsPatch({}).epicsGroupingMode).toBeUndefined();
  });

  it("rejects an unknown mode", () => {
    expect(() => decodeClientSettings({ epicsGroupingMode: "alphabetical" })).toThrow();
    expect(() => decodeClientSettingsPatch({ epicsGroupingMode: "alphabetical" })).toThrow();
  });
});

describe("ServerSettings.providerInstances (slice-2 invariant)", () => {
  it("defaults to an empty record so legacy configs without the key still decode", () => {
    expect(DEFAULT_SERVER_SETTINGS.providerInstances).toEqual({});
  });

  it("decodes a fully empty config (legacy on-disk shape) without complaint", () => {
    const decoded = decodeServerSettings({});
    expect(decoded.providerInstances).toEqual({});
    // Legacy `providers` struct is still hydrated with its per-driver defaults
    // so existing call sites keep working through the migration.
    expect(decoded.providers.codex.enabled).toBe(true);
  });

  it("decodes a multi-instance map mixing first-party and fork drivers", () => {
    const decoded = decodeServerSettings({
      providerInstances: {
        codex_personal: {
          driver: "codex",
          displayName: "Codex (personal)",
          config: { homePath: "~/.codex_personal" },
        },
        codex_work: {
          driver: "codex",
          config: { homePath: "~/.codex_work" },
        },
        ollama_local: {
          driver: "ollama",
          displayName: "Ollama (local)",
          config: { endpoint: "http://localhost:11434" },
        },
      },
    });
    const personalId = ProviderInstanceId.make("codex_personal");
    const workId = ProviderInstanceId.make("codex_work");
    const ollamaId = ProviderInstanceId.make("ollama_local");

    expect(decoded.providerInstances[personalId]?.driver).toBe("codex");
    expect(decoded.providerInstances[workId]?.config).toEqual({ homePath: "~/.codex_work" });
    // Critical: a config naming a driver this build does not know about
    // (`ollama` is not in `ProviderDriverKind`) must round-trip without loss.
    // The runtime handles "driver not installed" — the schema must not.
    expect(decoded.providerInstances[ollamaId]?.driver).toBe("ollama");
    expect(decoded.providerInstances[ollamaId]?.config).toEqual({
      endpoint: "http://localhost:11434",
    });
  });

  it("rejects instance keys that violate the slug pattern", () => {
    expect(() =>
      decodeServerSettings({
        providerInstances: { "1bad": { driver: "codex" } },
      }),
    ).toThrow();
  });
});

describe("ServerSettings Kimi home path", () => {
  it("decodes persisted Kimi settings that predate homePath", () => {
    const decoded = decodeServerSettings({ providers: { kimi: { binaryPath: "kimi" } } });

    expect(decoded.providers.kimi.homePath).toBe("");
  });

  it("accepts and normalizes homePath in a Kimi settings patch", () => {
    const decoded = decodeServerSettingsPatch({
      providers: { kimi: { homePath: "  ~/.kimi-code-work  " } },
    });

    expect(decoded.providers?.kimi?.homePath).toBe("~/.kimi-code-work");
  });
});

describe("ServerSettings.epicRolePolicy", () => {
  it("defaults to empty tiers, empty role assignments, and the shipped stage subagents", () => {
    const expected = {
      tiers: {},
      roles: {},
      inSessionRoles: DEFAULT_EPIC_STAGE_SUBAGENTS,
    };
    expect(DEFAULT_SERVER_SETTINGS.epicRolePolicy).toEqual(expected);
    expect(decodeServerSettings({}).epicRolePolicy).toEqual(expected);
    expect(DEFAULT_SERVER_SETTINGS.epicRolePolicy).toEqual(DEFAULT_EPIC_ROLE_POLICY);
  });

  it("round-trips in-session subagent definitions", () => {
    const decoded = decodeServerSettings({
      epicRolePolicy: {
        tiers: { primary: { hops: [] } },
        inSessionRoles: {
          planner: {
            tier: "primary",
            description: "Plans one child.",
            prompt: "You plan.",
            tools: ["Read", "Grep"],
          },
          reviewer: { description: "Reviews the change.", prompt: "You review." },
        },
      },
    });
    const roundTripped = decodeServerSettings(encodeServerSettings(decoded));

    expect(roundTripped.epicRolePolicy.inSessionRoles).toEqual({
      planner: {
        tier: "primary",
        description: "Plans one child.",
        prompt: "You plan.",
        tools: ["Read", "Grep"],
      },
      reviewer: { description: "Reviews the change.", prompt: "You review." },
    });
  });

  it("rejects an in-session subagent with a bad name or empty prompt", () => {
    expect(() =>
      decodeServerSettings({
        epicRolePolicy: {
          inSessionRoles: { "1bad": { description: "x", prompt: "y" } },
        },
      }),
    ).toThrow();
    expect(() =>
      decodeServerSettings({
        epicRolePolicy: { inSessionRoles: { planner: { description: "x", prompt: "  " } } },
      }),
    ).toThrow();
  });

  it("preserves ordered tier hops through decode, encode, and decode", () => {
    const decoded = decodeServerSettings({
      epicRolePolicy: {
        tiers: {
          primary: {
            label: "Primary",
            hops: [
              { selection: { instanceId: "claude_work", model: "opus" } },
              {
                selection: { instanceId: "claude_personal", model: "sonnet" },
                skipAboveUtilization: 80,
              },
              { selection: { instanceId: "codex", model: "gpt-5.6" } },
            ],
          },
          background: {
            hops: [{ selection: { instanceId: "claude_personal", model: "haiku" } }],
          },
        },
        roles: {
          "iteration-worker": "primary",
          "idle-inspection": "background",
        },
      },
    });
    const roundTripped = decodeServerSettings(encodeServerSettings(decoded));
    const primaryId = EpicTierId.make("primary");

    expect(roundTripped.epicRolePolicy.tiers[primaryId]?.hops).toHaveLength(3);
    expect(
      roundTripped.epicRolePolicy.tiers[primaryId]?.hops.map((hop) => hop.selection.model),
    ).toEqual(["opus", "sonnet", "gpt-5.6"]);
    expect(roundTripped.epicRolePolicy.roles).toEqual({
      "iteration-worker": "primary",
      "idle-inspection": "background",
    });
  });

  it("migrates a legacy provider key through ModelSelection", () => {
    const decoded = decodeServerSettings({
      epicRolePolicy: {
        tiers: {
          primary: {
            hops: [{ selection: { provider: "claudeAgent", model: "sonnet" } }],
          },
        },
      },
    });

    expect(
      decoded.epicRolePolicy.tiers[EpicTierId.make("primary")]?.hops[0]?.selection.instanceId,
    ).toBe("claudeAgent");
  });

  it("rejects invalid tier ids and utilization ceilings", () => {
    expect(() =>
      decodeServerSettings({
        epicRolePolicy: { tiers: { "1bad": { hops: [] } } },
      }),
    ).toThrow();
    expect(() =>
      decodeServerSettings({
        epicRolePolicy: {
          tiers: {
            primary: {
              hops: [
                {
                  selection: { instanceId: "claudeAgent", model: "sonnet" },
                  skipAboveUtilization: 101,
                },
              ],
            },
          },
        },
      }),
    ).toThrow();
  });

  // A patch carries the whole policy or nothing, so a patch that names the
  // policy but omits inSessionRoles decodes through the same field default and
  // comes back with the shipped stage subagents.
  it("decodes patches with and without the whole policy value", () => {
    expect(decodeServerSettingsPatch({})).not.toHaveProperty("epicRolePolicy");
    expect(
      decodeServerSettingsPatch({
        epicRolePolicy: {
          tiers: { primary: { hops: [] } },
          roles: { "merge-fix": "primary" },
        },
      }).epicRolePolicy,
    ).toEqual({
      tiers: { primary: { hops: [] } },
      roles: { "merge-fix": "primary" },
      inSessionRoles: DEFAULT_EPIC_STAGE_SUBAGENTS,
    });
  });
});

describe("ServerSettings Prime Agent defaults", () => {
  it("hydrates empty and legacy settings with Prime defaults", () => {
    for (const input of [{}, { providers: {} }]) {
      const prime = decodeServerSettings(input).providers.primeAgent;
      expect(prime).toEqual({
        enabled: true,
        binaryPath: "prime-agent",
        launchArgs: [],
      });
      expect(prime).not.toHaveProperty("sessionRoot");
      expect(prime).not.toHaveProperty("customModels");
    }
  });

  it("round-trips every Prime field through full settings", () => {
    const decoded = decodeServerSettings({
      providers: {
        primeAgent: {
          enabled: false,
          binaryPath: "  /opt/bin/prime-agent  ",
          launchArgs: ["  --profile  ", "work"],
          sessionRoot: "  /var/lib/prime/sessions  ",
        },
      },
    });

    expect(decoded.providers.primeAgent).toEqual({
      enabled: false,
      binaryPath: "/opt/bin/prime-agent",
      launchArgs: ["--profile", "work"],
      sessionRoot: "/var/lib/prime/sessions",
    });
    expect(encodeServerSettings(decoded).providers?.primeAgent).toEqual(
      decoded.providers.primeAgent,
    );
  });

  it("round-trips every Prime patch field", () => {
    const decoded = decodeServerSettingsPatch({
      providers: {
        primeAgent: {
          enabled: false,
          binaryPath: "  /opt/bin/prime-agent  ",
          launchArgs: ["  --profile  ", "work"],
          sessionRoot: "  /var/lib/prime/sessions  ",
        },
      },
    });

    expect(decoded.providers?.primeAgent).toEqual({
      enabled: false,
      binaryPath: "/opt/bin/prime-agent",
      launchArgs: ["--profile", "work"],
      sessionRoot: "/var/lib/prime/sessions",
    });
    expect(encodeServerSettingsPatch(decoded).providers?.primeAgent).toEqual(
      decoded.providers?.primeAgent,
    );
  });

  it("keeps environment on the instance envelope and preserves unknown config", () => {
    const primeId = ProviderInstanceId.make("primeAgent");
    const decoded = decodeServerSettings({
      providerInstances: {
        primeAgent: {
          driver: "primeAgent",
          environment: [{ name: "PRIME_TOKEN", value: "secret", sensitive: true }],
          config: { futurePrimeField: { enabled: true } },
        },
      },
    });

    expect(decoded.providerInstances[primeId]?.environment).toEqual([
      { name: "PRIME_TOKEN", value: "secret", sensitive: true },
    ]);
    expect(decoded.providerInstances[primeId]?.config).toEqual({
      futurePrimeField: { enabled: true },
    });
  });
});

describe("ServerSettings worktree defaults", () => {
  it("defaults start-from-origin on for legacy configs", () => {
    expect(decodeServerSettings({}).newWorktreesStartFromOrigin).toBe(true);
  });

  it("accepts start-from-origin updates", () => {
    expect(
      decodeServerSettingsPatch({ newWorktreesStartFromOrigin: false }).newWorktreesStartFromOrigin,
    ).toBe(false);
  });
});

describe("ServerSettings retired auto-settle window", () => {
  it.each([3, null, 0, 91, "invalid"])(
    "ignores legacy full-setting value %j while preserving other settings",
    (legacyValue) => {
      const decoded = decodeServerSettings({
        threadAutoSettleAfterDays: legacyValue,
        enableAssistantStreaming: true,
      });

      expect(decoded).not.toHaveProperty("threadAutoSettleAfterDays");
      expect(decoded.enableAssistantStreaming).toBe(true);
    },
  );

  it.each([3, null, 0, 91, "invalid"])(
    "ignores legacy patch value %j while preserving other settings",
    (legacyValue) => {
      const decoded = decodeServerSettingsPatch({
        threadAutoSettleAfterDays: legacyValue,
        enableAssistantStreaming: true,
      });

      expect(decoded).not.toHaveProperty("threadAutoSettleAfterDays");
      expect(decoded.enableAssistantStreaming).toBe(true);
    },
  );
});

describe("ServerSettings skills root", () => {
  it("defaults to a resolved path and accepts patches", () => {
    const settings = decodeServerSettings({});
    expect(settings.skillsRoot).not.toContain("~");
    if (settings.skillsRoot.length > 0) {
      expect(settings.skillsRoot.startsWith("/")).toBe(true);
    }
    expect(decodeServerSettingsPatch({ skillsRoot: "/tmp/custom-skills" }).skillsRoot).toBe(
      "/tmp/custom-skills",
    );
  });
});

describe("ServerSettingsPatch.providerInstances", () => {
  it("treats providerInstances as an optional whole-map replacement", () => {
    const patch = decodeServerSettingsPatch({});
    expect(patch.providerInstances).toBeUndefined();

    const replacement = decodeServerSettingsPatch({
      providerInstances: {
        codex_personal: { driver: "codex", config: { homePath: "~/.codex" } },
      },
    });
    expect(replacement.providerInstances).toBeDefined();
    expect(replacement.providerInstances?.[ProviderInstanceId.make("codex_personal")]?.driver).toBe(
      "codex",
    );
  });

  it("preserves a fork-defined driver entry through patch decoding", () => {
    const patch = decodeServerSettingsPatch({
      providerInstances: {
        ollama_local: {
          driver: "ollama",
          config: { endpoint: "http://localhost:11434" },
        },
      },
    });
    const ollamaId = ProviderInstanceId.make("ollama_local");
    expect(patch.providerInstances?.[ollamaId]?.driver).toBe("ollama");
  });
});

describe("ServerSettingsPatch string normalization", () => {
  it("trims string settings while decoding patches", () => {
    const patch = decodeServerSettingsPatch({
      addProjectBaseDirectory: "  ~/Development  ",
      textGenerationModelSelection: { model: "  gpt-5.4-mini  " },
      observability: {
        otlpTracesUrl: "  http://localhost:4318/v1/traces  ",
      },
      providers: {
        codex: {
          binaryPath: "  /opt/homebrew/bin/codex  ",
          homePath: "  ~/.codex  ",
          launchArgs: "  --strict-config --enable foo  ",
        },
      },
      providerInstances: {
        codex_personal: {
          driver: "  codex  ",
          displayName: "  Codex Personal  ",
          config: { homePath: "  ~/.codex-personal  " },
        },
      },
    });

    expect(patch.addProjectBaseDirectory).toBe("~/Development");
    expect(patch.textGenerationModelSelection?.model).toBe("gpt-5.4-mini");
    expect(patch.observability?.otlpTracesUrl).toBe("http://localhost:4318/v1/traces");
    expect(patch.providers?.codex?.binaryPath).toBe("/opt/homebrew/bin/codex");
    expect(patch.providers?.codex?.homePath).toBe("~/.codex");
    expect(patch.providers?.codex?.launchArgs).toBe("--strict-config --enable foo");
    expect(patch.providerInstances?.[ProviderInstanceId.make("codex_personal")]?.driver).toBe(
      "codex",
    );
    expect(patch.providerInstances?.[ProviderInstanceId.make("codex_personal")]?.displayName).toBe(
      "Codex Personal",
    );
    expect(patch.providerInstances?.[ProviderInstanceId.make("codex_personal")]?.config).toEqual({
      homePath: "  ~/.codex-personal  ",
    });
  });

  it("trims encoded server settings values before validation", () => {
    const defaultSettings = decodeServerSettings({});
    const encoded = encodeServerSettings({
      ...defaultSettings,
      addProjectBaseDirectory: "  ~/Development  ",
      providers: {
        ...defaultSettings.providers,
        codex: {
          ...defaultSettings.providers.codex,
          binaryPath: "  /opt/homebrew/bin/codex  ",
          launchArgs: "  --strict-config  ",
        },
      },
    });

    expect(encoded.addProjectBaseDirectory).toBe("~/Development");
    expect(encoded.providers?.codex?.binaryPath).toBe("/opt/homebrew/bin/codex");
    expect(encoded.providers?.codex?.launchArgs).toBe("--strict-config");
  });
});
