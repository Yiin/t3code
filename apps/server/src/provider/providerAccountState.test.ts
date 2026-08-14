import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderAccountLimit,
  type ProviderUsageSample,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { stampProviderAccountState } from "./providerAccountState.ts";

const NOW = "2026-04-10T12:00:00.000Z";

const instanceId = ProviderInstanceId.make("claude_personal");

const provider = {
  instanceId,
  driver: ProviderDriverKind.make("claudeAgent"),
  status: "ready",
  enabled: true,
  installed: true,
  auth: { status: "authenticated" },
  checkedAt: "2026-04-10T11:00:00.000Z",
  version: "1.0.0",
  models: [],
  slashCommands: [],
  skills: [],
} as const satisfies ServerProvider;

const sample = (overrides: Partial<ProviderUsageSample>): ProviderUsageSample => ({
  providerInstanceId: instanceId,
  window: "five_hour",
  utilization: 40,
  resetsAt: "2026-04-10T15:00:00.000Z",
  source: "claude.sdk.get_usage",
  observedAt: "2026-04-10T11:55:00.000Z",
  ...overrides,
});

const limit = (overrides: Partial<ProviderAccountLimit>): ProviderAccountLimit => ({
  providerInstanceId: instanceId,
  driver: ProviderDriverKind.make("claudeAgent"),
  kind: "usage-limit",
  detectedAt: "2026-04-10T11:30:00.000Z",
  resetsAt: "2026-04-10T15:00:00.000Z",
  resetsAtEstimated: false,
  source: "claude.sdk.rate_limit_event",
  detail: null,
  ...overrides,
});

describe("stampProviderAccountState", () => {
  it("carries every live window and drops one whose reset has passed", () => {
    const live = sample({ window: "five_hour", utilization: 40 });
    const liveWeekly = sample({
      window: "seven_day",
      utilization: 12,
      resetsAt: "2026-04-15T00:00:00.000Z",
    });
    const expired = sample({
      window: "seven_day_opus",
      utilization: 99,
      resetsAt: "2026-04-10T11:59:00.000Z",
    });

    const stamped = stampProviderAccountState({
      provider,
      samples: [live, liveWeekly, expired],
      limits: [],
      nowIso: NOW,
    });

    expect(stamped.usage).toEqual([live, liveWeekly]);
  });

  it("keeps a window whose harness gave no reset time", () => {
    const unknownReset = sample({ resetsAt: null });

    const stamped = stampProviderAccountState({
      provider,
      samples: [unknownReset],
      limits: undefined,
      nowIso: NOW,
    });

    expect(stamped.usage).toEqual([unknownReset]);
  });

  it("omits usage entirely when the account has no live windows", () => {
    const stamped = stampProviderAccountState({
      provider,
      samples: [sample({ resetsAt: "2026-04-10T11:00:00.000Z" })],
      limits: [],
      nowIso: NOW,
    });

    expect("usage" in stamped).toBe(false);
  });

  it("omits usage entirely for a driver that records no samples", () => {
    const stamped = stampProviderAccountState({
      provider,
      samples: [],
      limits: [],
      nowIso: NOW,
    });

    expect("usage" in stamped).toBe(false);
  });

  it("carries limit null when the store answered with no rows", () => {
    const stamped = stampProviderAccountState({
      provider,
      samples: [],
      limits: [],
      nowIso: NOW,
    });

    expect(stamped.limit).toBeNull();
  });

  it("picks the newest live limit and treats an expired one as gone", () => {
    const older = limit({ kind: "usage-limit", detectedAt: "2026-04-10T10:00:00.000Z" });
    const newest = limit({ kind: "auth", detectedAt: "2026-04-10T11:45:00.000Z", resetsAt: null });
    const expired = limit({
      kind: "spend-limit",
      detectedAt: "2026-04-10T11:50:00.000Z",
      resetsAt: "2026-04-10T11:59:00.000Z",
    });

    const stamped = stampProviderAccountState({
      provider,
      samples: undefined,
      limits: [older, newest, expired],
      nowIso: NOW,
    });

    expect(stamped.limit).toEqual(newest);
  });

  it("omits both fields when the stores are unavailable", () => {
    const stamped = stampProviderAccountState({
      provider,
      samples: undefined,
      limits: undefined,
      nowIso: NOW,
    });

    expect("usage" in stamped).toBe(false);
    expect("limit" in stamped).toBe(false);
  });

  it("replaces stale usage and limit state instead of accreting it", () => {
    const stale = {
      ...provider,
      usage: [sample({ utilization: 90 })],
      limit: limit({}),
    } satisfies ServerProvider;

    const stamped = stampProviderAccountState({
      provider: stale,
      samples: [],
      limits: [],
      nowIso: NOW,
    });

    expect("usage" in stamped).toBe(false);
    expect(stamped.limit).toBeNull();
  });

  it("ignores rows recorded for a different account", () => {
    const foreign = sample({
      providerInstanceId: ProviderInstanceId.make("claude_work"),
    });

    const stamped = stampProviderAccountState({
      provider,
      samples: [foreign],
      limits: [limit({ providerInstanceId: ProviderInstanceId.make("claude_work") })],
      nowIso: NOW,
    });

    expect("usage" in stamped).toBe(false);
    expect(stamped.limit).toBeNull();
  });
});
