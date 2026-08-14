import {
  EpicInSessionRoleName,
  EpicTierId,
  ProviderDriverKind,
  ProviderInstanceId,
  type EpicRolePolicy,
  type ProviderUsageSample,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  isAccountExhausted,
  maxLiveUtilizationByInstance,
  resolveEpicSubagents,
} from "./epicSubagents.ts";

const NOW = "2026-08-13T12:00:00.000Z";

const provider = (
  instanceId: string,
  model: string,
  overrides: Partial<ServerProvider> = {},
): ServerProvider => ({
  instanceId: ProviderInstanceId.make(instanceId),
  driver: ProviderDriverKind.make("claudeAgent"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: NOW,
  availability: "available",
  models: [{ slug: model, name: model, isCustom: false, capabilities: null }],
  slashCommands: [],
  skills: [],
  ...overrides,
});

const claudeWork = provider("claude-work", "claude-opus-5");
const claudePersonal = provider("claude-personal", "claude-sonnet-5");
const claudeTeam = provider("claude-team", "claude-opus-5");

const HIGH = EpicTierId.make("high");
const PLANNER = EpicInSessionRoleName.make("planner");

const policy = (overrides: Partial<EpicRolePolicy> = {}): EpicRolePolicy => ({
  tiers: {
    [HIGH]: {
      expandSameDriverAccounts: true,
      hops: [
        { selection: { instanceId: claudeWork.instanceId, model: "claude-opus-5" } },
        { selection: { instanceId: claudePersonal.instanceId, model: "claude-sonnet-5" } },
      ],
    },
  },
  roles: {},
  inSessionRoles: {
    [PLANNER]: {
      tier: HIGH,
      description: "Plans the child.",
      prompt: "You plan.",
    },
  },
  ...overrides,
});

const sample = (
  instanceId: string,
  utilization: number,
  resetsAt: string | null,
): ProviderUsageSample => ({
  providerInstanceId: ProviderInstanceId.make(instanceId),
  window: "five_hour",
  utilization,
  resetsAt,
  source: "claude.sdk.get_usage",
  observedAt: NOW,
});

describe("resolveEpicSubagents", () => {
  it("takes the model of the first hop that can run", () => {
    expect(
      resolveEpicSubagents({ policy: policy(), providers: [claudeWork, claudePersonal] }),
    ).toEqual({
      planner: {
        description: "Plans the child.",
        prompt: "You plan.",
        model: "claude-opus-5",
      },
    });
  });

  it("walks past a hop whose account is over its threshold", () => {
    const withThreshold = policy();
    const tier = withThreshold.tiers[HIGH]!;
    const resolved = resolveEpicSubagents({
      policy: {
        ...withThreshold,
        tiers: {
          [HIGH]: {
            expandSameDriverAccounts: true,
            hops: [{ ...tier.hops[0]!, skipAboveUtilization: 80 }, tier.hops[1]!],
          },
        },
      },
      providers: [claudeWork, claudePersonal],
      utilization: (instanceId) => (instanceId === claudeWork.instanceId ? 95 : 10),
    });

    expect(resolved.planner?.model).toBe("claude-sonnet-5");
  });

  it("keeps a hop whose utilization is unknown", () => {
    const withThreshold = policy();
    const tier = withThreshold.tiers[HIGH]!;
    const resolved = resolveEpicSubagents({
      policy: {
        ...withThreshold,
        tiers: {
          [HIGH]: {
            expandSameDriverAccounts: true,
            hops: [{ ...tier.hops[0]!, skipAboveUtilization: 80 }, tier.hops[1]!],
          },
        },
      },
      providers: [claudeWork, claudePersonal],
      utilization: () => null,
    });

    expect(resolved.planner?.model).toBe("claude-opus-5");
  });

  it("skips a hop whose provider cannot serve the hop's model", () => {
    expect(
      resolveEpicSubagents({ policy: policy(), providers: [claudePersonal] }).planner?.model,
    ).toBe("claude-sonnet-5");
  });

  it("measures each expanded sibling against its own utilization", () => {
    const expanded = policy({
      tiers: {
        [HIGH]: {
          expandSameDriverAccounts: true,
          hops: [
            {
              selection: { instanceId: claudeWork.instanceId, model: "claude-opus-5" },
              skipAboveUtilization: 80,
            },
          ],
        },
      },
    });

    expect(
      resolveEpicSubagents({
        policy: expanded,
        providers: [claudeWork, claudeTeam],
        utilization: (instanceId) => (instanceId === claudeWork.instanceId ? 95 : 10),
      }).planner?.model,
    ).toBe("claude-opus-5");
    expect(
      resolveEpicSubagents({
        policy: expanded,
        providers: [claudeWork, claudeTeam],
        utilization: () => 95,
      }).planner?.model,
    ).toBeUndefined();
  });

  it("ships the definition without a model when no hop can run", () => {
    expect(resolveEpicSubagents({ policy: policy(), providers: [] })).toEqual({
      planner: { description: "Plans the child.", prompt: "You plan." },
    });
  });

  it("ships the definition without a model when the role names no tier", () => {
    const untiered = policy({
      inSessionRoles: {
        [PLANNER]: { description: "Plans the child.", prompt: "You plan." },
      },
    });

    expect(resolveEpicSubagents({ policy: untiered, providers: [claudeWork] }).planner).toEqual({
      description: "Plans the child.",
      prompt: "You plan.",
    });
  });

  it("ships the definition without a model when the tier is gone", () => {
    expect(
      resolveEpicSubagents({ policy: policy({ tiers: {} }), providers: [claudeWork] }).planner,
    ).toEqual({ description: "Plans the child.", prompt: "You plan." });
  });

  it("carries the role's tool allowlist through", () => {
    const withTools = policy({
      inSessionRoles: {
        [PLANNER]: {
          tier: HIGH,
          description: "Plans the child.",
          prompt: "You plan.",
          tools: ["Read", "Grep"],
        },
      },
    });

    expect(
      resolveEpicSubagents({ policy: withTools, providers: [claudeWork] }).planner?.tools,
    ).toEqual(["Read", "Grep"]);
  });

  it("ignores a hop on another provider driver, because a subagent cannot leave its session", () => {
    const codex = provider("codex-personal", "gpt-5.6-sol", {
      driver: ProviderDriverKind.make("codex"),
    });
    const codexFirst = policy({
      tiers: {
        [HIGH]: {
          expandSameDriverAccounts: true,
          hops: [
            { selection: { instanceId: codex.instanceId, model: "gpt-5.6-sol" } },
            { selection: { instanceId: claudePersonal.instanceId, model: "claude-sonnet-5" } },
          ],
        },
      },
    });

    expect(
      resolveEpicSubagents({
        policy: codexFirst,
        providers: [codex, claudePersonal],
        sessionInstanceId: claudePersonal.instanceId,
      }).planner?.model,
    ).toBe("claude-sonnet-5");
  });

  it("keeps every hop when the session's own account is unknown", () => {
    expect(
      resolveEpicSubagents({
        policy: policy(),
        providers: [claudeWork, claudePersonal],
        sessionInstanceId: ProviderInstanceId.make("gone"),
      }).planner?.model,
    ).toBe("claude-opus-5");
  });

  it("is empty when no in-session role is configured", () => {
    expect(
      resolveEpicSubagents({ policy: policy({ inSessionRoles: {} }), providers: [claudeWork] }),
    ).toEqual({});
  });
});

describe("maxLiveUtilizationByInstance", () => {
  it("keeps the worst live window per account", () => {
    const worst = maxLiveUtilizationByInstance(
      [
        sample("claude-work", 40, "2026-08-13T18:00:00.000Z"),
        sample("claude-work", 88, "2026-08-20T00:00:00.000Z"),
        sample("claude-personal", 12, null),
      ],
      NOW,
    );

    expect(worst.get(ProviderInstanceId.make("claude-work"))).toBe(88);
    expect(worst.get(ProviderInstanceId.make("claude-personal"))).toBe(12);
  });

  it("drops a window that has already reset", () => {
    const worst = maxLiveUtilizationByInstance(
      [
        sample("claude-work", 99, "2026-08-13T11:00:00.000Z"),
        sample("claude-work", 20, "2026-08-13T18:00:00.000Z"),
      ],
      NOW,
    );

    expect(worst.get(ProviderInstanceId.make("claude-work"))).toBe(20);
  });
});

describe("isAccountExhausted", () => {
  it("exhausts at the default threshold of 100", () => {
    expect(isAccountExhausted({ utilization: 100 })).toBe(true);
    expect(isAccountExhausted({ utilization: 130 })).toBe(true);
    expect(isAccountExhausted({ utilization: 99.9 })).toBe(false);
  });

  it("never exhausts an unknown utilization", () => {
    expect(isAccountExhausted({ utilization: null })).toBe(false);
    expect(isAccountExhausted({ utilization: null, threshold: 0 })).toBe(false);
  });

  it("honors a caller threshold", () => {
    expect(isAccountExhausted({ utilization: 80, threshold: 80 })).toBe(true);
    expect(isAccountExhausted({ utilization: 79, threshold: 80 })).toBe(false);
  });
});
