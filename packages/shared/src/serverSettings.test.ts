import {
  DEFAULT_EPIC_ROLE_POLICY,
  DEFAULT_EPIC_STAGE_SUBAGENTS,
  DEFAULT_SERVER_SETTINGS,
  EpicInSessionRoleName,
  EpicTierId,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { createModelSelection } from "./model.ts";
import {
  applyServerSettingsPatch,
  extractPersistedServerObservabilitySettings,
  normalizePersistedServerSettingString,
  parsePersistedEpicRolePolicy,
  parsePersistedServerObservabilitySettings,
} from "./serverSettings.ts";

describe("serverSettings helpers", () => {
  it("normalizes optional persisted strings", () => {
    expect(normalizePersistedServerSettingString(undefined)).toBeUndefined();
    expect(normalizePersistedServerSettingString("   ")).toBeUndefined();
    expect(normalizePersistedServerSettingString("  http://localhost:4318/v1/traces  ")).toBe(
      "http://localhost:4318/v1/traces",
    );
  });

  it("extracts persisted observability settings", () => {
    expect(
      extractPersistedServerObservabilitySettings({
        observability: {
          otlpTracesUrl: "  http://localhost:4318/v1/traces  ",
          otlpMetricsUrl: "  http://localhost:4318/v1/metrics  ",
        },
      }),
    ).toEqual({
      otlpTracesUrl: "http://localhost:4318/v1/traces",
      otlpMetricsUrl: "http://localhost:4318/v1/metrics",
    });
  });

  it("parses lenient persisted settings JSON", () => {
    expect(
      parsePersistedServerObservabilitySettings(
        JSON.stringify({
          observability: {
            otlpTracesUrl: "http://localhost:4318/v1/traces",
            otlpMetricsUrl: "http://localhost:4318/v1/metrics",
          },
        }),
      ),
    ).toEqual({
      otlpTracesUrl: "http://localhost:4318/v1/traces",
      otlpMetricsUrl: "http://localhost:4318/v1/metrics",
    });
  });

  it("falls back cleanly when persisted settings are invalid", () => {
    expect(parsePersistedServerObservabilitySettings("{")).toEqual({
      otlpTracesUrl: undefined,
      otlpMetricsUrl: undefined,
    });
  });

  it("replaces text generation selection when provider/model are provided", () => {
    const current = {
      ...DEFAULT_SERVER_SETTINGS,
      textGenerationModelSelection: createModelSelection(
        ProviderInstanceId.make("codex"),
        "gpt-5.4-mini",
        [
          { id: "reasoningEffort", value: "high" },
          { id: "fastMode", value: true },
        ],
      ),
    };

    expect(
      applyServerSettingsPatch(current, {
        textGenerationModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4-mini",
        },
      }).textGenerationModelSelection,
    ).toEqual({
      instanceId: "codex",
      model: "gpt-5.4-mini",
    });
  });

  it("still deep merges text generation selection when only options are provided", () => {
    const current = {
      ...DEFAULT_SERVER_SETTINGS,
      textGenerationModelSelection: createModelSelection(
        ProviderInstanceId.make("codex"),
        "gpt-5.4-mini",
        [
          { id: "reasoningEffort", value: "high" },
          { id: "fastMode", value: true },
        ],
      ),
    };

    expect(
      applyServerSettingsPatch(current, {
        textGenerationModelSelection: {
          options: [{ id: "fastMode", value: false }],
        },
      }).textGenerationModelSelection,
    ).toEqual({
      instanceId: "codex",
      model: "gpt-5.4-mini",
      options: [
        { id: "reasoningEffort", value: "high" },
        { id: "fastMode", value: false },
      ],
    });
  });

  it("replaces text generation selection across providers without leaking stale options", () => {
    const current = {
      ...DEFAULT_SERVER_SETTINGS,
      textGenerationModelSelection: createModelSelection(
        ProviderInstanceId.make("codex"),
        "gpt-5.4-mini",
        [
          { id: "reasoningEffort", value: "high" },
          { id: "fastMode", value: true },
        ],
      ),
    };

    expect(
      applyServerSettingsPatch(current, {
        textGenerationModelSelection: {
          instanceId: ProviderInstanceId.make("opencode"),
          model: "openai/gpt-5",
        },
      }).textGenerationModelSelection,
    ).toEqual({
      instanceId: "opencode",
      model: "openai/gpt-5",
    });
  });

  it("accepts array-based text generation selection patches", () => {
    expect(
      applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
        textGenerationModelSelection: {
          instanceId: ProviderInstanceId.make("opencode"),
          model: "openai/gpt-5",
          options: [
            { id: "variant", value: "prod" },
            { id: "agent", value: "build" },
          ],
        },
      }).textGenerationModelSelection,
    ).toEqual({
      instanceId: "opencode",
      model: "openai/gpt-5",
      options: [
        { id: "variant", value: "prod" },
        { id: "agent", value: "build" },
      ],
    });
  });

  it("replaces providerInstances maps so omitted instance fields are cleared", () => {
    const codexId = ProviderInstanceId.make("codex");
    const current = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [codexId]: {
          driver: ProviderDriverKind.make("codex"),
          displayName: "Codex Work",
          accentColor: "#7c3aed",
          enabled: true,
          config: { homePath: "~/.codex" },
        },
      },
    };

    expect(
      applyServerSettingsPatch(current, {
        providerInstances: {
          [codexId]: {
            driver: ProviderDriverKind.make("codex"),
            displayName: "Codex Work",
            enabled: true,
            config: { homePath: "~/.codex" },
          },
        },
      }).providerInstances[codexId],
    ).toEqual({
      driver: ProviderDriverKind.make("codex"),
      displayName: "Codex Work",
      enabled: true,
      config: { homePath: "~/.codex" },
    });
  });

  it("replaces the subagent spawn block so an omitted allowlist is cleared", () => {
    const current = {
      ...DEFAULT_SERVER_SETTINGS,
      subagentSpawn: {
        enabled: true,
        allowedAgentTypes: ["Explore", "general-purpose"],
        maxConcurrentChildren: 5,
      },
    };

    expect(
      applyServerSettingsPatch(current, {
        subagentSpawn: { enabled: true },
      }).subagentSpawn,
    ).toEqual({ enabled: true });
  });

  it("parses the epic role policy out of a persisted settings file", () => {
    const primary = EpicTierId.make("primary");
    const planner = EpicInSessionRoleName.make("planner");
    const policy = parsePersistedEpicRolePolicy(
      JSON.stringify({
        epicRolePolicy: {
          tiers: {
            primary: { hops: [{ selection: { instanceId: "claude-work", model: "opus" } }] },
          },
          inSessionRoles: {
            planner: { tier: "primary", description: "Plans the change", prompt: "Plan it." },
          },
        },
      }),
    );

    expect(policy.inSessionRoles[planner]?.tier).toBe("primary");
    expect(policy.tiers[primary]?.hops[0]?.selection.model).toBe("opus");
  });

  it("keeps the epic role policy when an unrelated settings key is invalid", () => {
    // The cook CLI reads this file without a settings service, so one bad key
    // elsewhere must not cost it the whole policy.
    const policy = parsePersistedEpicRolePolicy(
      JSON.stringify({
        textGenerationModelSelection: 42,
        epicRolePolicy: {
          inSessionRoles: { reviewer: { description: "Reviews", prompt: "Review it." } },
        },
      }),
    );

    expect(Object.keys(policy.inSessionRoles)).toEqual(["reviewer"]);
  });

  it("falls back to the default epic role policy on missing or invalid input", () => {
    // The fallback is DEFAULT_EPIC_ROLE_POLICY, so a fresh install with no
    // settings file still gets the shipped stage subagents.
    expect(DEFAULT_EPIC_ROLE_POLICY.inSessionRoles).toEqual(DEFAULT_EPIC_STAGE_SUBAGENTS);
    for (const raw of ["{", "{}", JSON.stringify({ epicRolePolicy: { tiers: 7 } })]) {
      expect(parsePersistedEpicRolePolicy(raw)).toEqual(DEFAULT_EPIC_ROLE_POLICY);
    }
  });

  it("keeps a persisted empty in-session role map empty", () => {
    const policy = parsePersistedEpicRolePolicy(
      JSON.stringify({ epicRolePolicy: { inSessionRoles: {} } }),
    );

    expect(policy.inSessionRoles).toEqual({});
  });

  it("replaces epic role policies so omitted tiers and hops are cleared", () => {
    const primaryId = EpicTierId.make("primary");
    const backgroundId = EpicTierId.make("background");
    const claudeId = ProviderInstanceId.make("claudeAgent");
    const current = {
      ...DEFAULT_SERVER_SETTINGS,
      epicRolePolicy: {
        tiers: {
          [primaryId]: {
            expandSameDriverAccounts: true,
            hops: [
              { selection: { instanceId: claudeId, model: "opus" } },
              { selection: { instanceId: claudeId, model: "sonnet" } },
              { selection: { instanceId: claudeId, model: "haiku" } },
            ],
          },
          [backgroundId]: {
            expandSameDriverAccounts: true,
            hops: [{ selection: { instanceId: claudeId, model: "haiku" } }],
          },
        },
        roles: {
          "iteration-worker": primaryId,
          "idle-inspection": backgroundId,
        },
        inSessionRoles: {},
      },
    };

    const result = applyServerSettingsPatch(current, {
      epicRolePolicy: {
        tiers: {
          [primaryId]: {
            expandSameDriverAccounts: true,
            hops: [{ selection: { instanceId: claudeId, model: "opus" } }],
          },
        },
        roles: { "iteration-worker": primaryId },
        inSessionRoles: {},
      },
    }).epicRolePolicy;

    expect(Object.keys(result.tiers)).toEqual(["primary"]);
    expect(result.tiers[primaryId]?.hops).toHaveLength(1);
    expect(result.roles).toEqual({ "iteration-worker": primaryId });
  });
});
