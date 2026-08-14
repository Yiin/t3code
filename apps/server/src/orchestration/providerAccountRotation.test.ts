import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ModelSelection,
  type ProviderAccountLimit,
  type ProviderUsageSample,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  accountRotationSummary,
  accountRotationRefusedSummary,
  buildExhaustedAccountBlocklist,
  classifyAccountRotationReason,
  resolveAccountRotationTarget,
} from "./providerAccountRotation.ts";

const NOW = "2026-08-14T12:00:00.000Z";
const TTL_MS = 3_600_000;

const instance = (value: string) => ProviderInstanceId.make(value);

const selection = (instanceId: string, model = "claude-sonnet-5"): ModelSelection => ({
  instanceId: instance(instanceId),
  model,
});

const provider = (
  instanceId: string,
  driver: string,
  model = "claude-sonnet-5",
  overrides: Partial<ServerProvider> = {},
): ServerProvider => ({
  instanceId: instance(instanceId),
  driver: ProviderDriverKind.make(driver),
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

const limit = (
  instanceId: string,
  kind: ProviderAccountLimit["kind"],
  overrides: Partial<ProviderAccountLimit> = {},
): ProviderAccountLimit => ({
  providerInstanceId: instance(instanceId),
  driver: ProviderDriverKind.make("claudeAgent"),
  kind,
  detectedAt: NOW,
  resetsAt: null,
  resetsAtEstimated: false,
  source: "claude.sdk.rate_limit_event",
  detail: null,
  ...overrides,
});

const sample = (
  instanceId: string,
  utilization: number,
  resetsAt: string | null = "2026-08-14T15:00:00.000Z",
): ProviderUsageSample => ({
  providerInstanceId: instance(instanceId),
  window: "five_hour",
  utilization,
  resetsAt,
  source: "claude.sdk.get_usage",
  observedAt: NOW,
});

describe("classifyAccountRotationReason", () => {
  it("classifies spend, usage, and rate limit refusals", () => {
    expect(classifyAccountRotationReason("You've hit your usage limit for today.")).toBe(
      "spend-limit",
    );
    expect(
      classifyAccountRotationReason("Your org has hit its monthly spend limit for Claude."),
    ).toBe("spend-limit");
    expect(classifyAccountRotationReason("Rate limit exceeded. Try again later.")).toBe(
      "rate-limit",
    );
  });

  it("never rotates on auth, outage, or unrelated errors", () => {
    expect(classifyAccountRotationReason("Invalid API key. Please run /login.")).toBeNull();
    expect(classifyAccountRotationReason("The tests failed for an unrelated reason.")).toBeNull();
  });
});

describe("buildExhaustedAccountBlocklist", () => {
  it("blocks live usage-limit and spend-limit rows only", () => {
    const blocked = buildExhaustedAccountBlocklist({
      limits: [
        limit("claude-a", "usage-limit", { resetsAt: "2026-08-14T13:00:00.000Z" }),
        limit("claude-b", "auth"),
        limit("claude-c", "spend-limit"),
      ],
      samples: [],
      now: NOW,
      degradationTtlMs: TTL_MS,
    });
    expect(blocked.has(instance("claude-a"))).toBe(true);
    expect(blocked.has(instance("claude-b"))).toBe(false);
    expect(blocked.has(instance("claude-c"))).toBe(true);
  });

  it("drops a limit row whose reset time has passed", () => {
    const blocked = buildExhaustedAccountBlocklist({
      limits: [limit("claude-a", "usage-limit", { resetsAt: "2026-08-14T11:00:00.000Z" })],
      samples: [],
      now: NOW,
      degradationTtlMs: TTL_MS,
    });
    expect(blocked.size).toBe(0);
  });

  it("blocks a live max utilization at or above 100 and ignores expired windows", () => {
    const blocked = buildExhaustedAccountBlocklist({
      limits: [],
      samples: [
        sample("claude-a", 100),
        sample("claude-b", 40),
        sample("claude-c", 100, "2026-08-14T11:00:00.000Z"),
      ],
      now: NOW,
      degradationTtlMs: TTL_MS,
    });
    expect(blocked.has(instance("claude-a"))).toBe(true);
    expect(blocked.has(instance("claude-b"))).toBe(false);
    expect(blocked.has(instance("claude-c"))).toBe(false);
  });
});

describe("resolveAccountRotationTarget", () => {
  const claudeA = provider("claude-a", "claudeAgent");
  const claudeB = provider("claude-b", "claudeAgent");
  const codex = provider("codex-work", "codex", "gpt-5.6-sol");

  it("rotates to the next same-driver sibling, skipping blocked accounts", () => {
    expect(
      resolveAccountRotationTarget({
        providers: [claudeA, claudeB, codex],
        current: selection("claude-a"),
        failingInstanceId: instance("claude-a"),
        blocked: new Set(),
      }),
    ).toEqual(selection("claude-b"));
    expect(
      resolveAccountRotationTarget({
        providers: [claudeA, claudeB, codex],
        current: selection("claude-a"),
        failingInstanceId: instance("claude-a"),
        blocked: new Set([instance("claude-b")]),
      }),
    ).toBeNull();
  });

  it("never crosses to another harness", () => {
    expect(
      resolveAccountRotationTarget({
        providers: [claudeA, codex],
        current: selection("claude-a"),
        failingInstanceId: instance("claude-a"),
        blocked: new Set(),
      }),
    ).toBeNull();
  });

  it("never lands back on the failing instance", () => {
    expect(
      resolveAccountRotationTarget({
        providers: [claudeA],
        current: selection("claude-a"),
        failingInstanceId: instance("claude-a"),
        blocked: new Set(),
      }),
    ).toBeNull();
  });
});

describe("accountRotationSummary", () => {
  it("names both accounts and the limit", () => {
    expect(
      accountRotationSummary({
        fromLabel: "Work",
        toLabel: "Personal",
        reason: "spend-limit",
        fromModel: "claude-sonnet-5",
        toModel: "claude-sonnet-5",
      }),
    ).toBe("Account 'Work' hit its usage limit. This thread now uses account 'Personal'.");
    expect(
      accountRotationSummary({
        fromLabel: "A",
        toLabel: "B",
        reason: "rate-limit",
        fromModel: "custom-model",
        toModel: "claude-sonnet-5",
      }),
    ).toBe(
      "Account 'A' hit its rate limit. This thread now uses account 'B'. The model also changed from 'custom-model' to 'claude-sonnet-5'.",
    );
  });

  it("explains why an incompatible account did not take over", () => {
    expect(
      accountRotationRefusedSummary({
        fromLabel: "Work",
        toLabel: "Personal",
        reason: "spend-limit",
      }),
    ).toBe(
      "Account 'Work' hit its usage limit. T3 Code kept this account because 'Personal' cannot continue its provider session.",
    );
  });
});
