import { describe, expect, it } from "vite-plus/test";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderAccountLimit,
  type ProviderInstanceConfig,
  type ProviderAuthRunState,
  type ProviderUsageSample,
  type ServerSettings,
} from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";

import {
  buildProviderGroupReorderPatch,
  deriveProviderAccountLimitState,
  deriveProviderInstanceId,
  formatResetCountdown,
  isManagedProviderAccountHomeForDisplay,
  moveProviderAccount,
  nextManagedProviderAccountIdentity,
  orderProviderGroupRows,
  readProviderCredentialHome,
  reduceProviderAuthRunState,
  resolveProviderAccountAuthAction,
  slugifyProviderInstanceLabel,
  validateProviderInstanceId,
  withProviderCredentialHome,
} from "./providerAccounts.logic";

const id = (value: string) => ProviderInstanceId.make(value);
const claude = ProviderDriverKind.make("claudeAgent");
const codex = ProviderDriverKind.make("codex");
const kimi = ProviderDriverKind.make("kimi");
const opencode = ProviderDriverKind.make("opencode");

const instance = (overrides?: Partial<ProviderInstanceConfig>): ProviderInstanceConfig =>
  ({ driver: claude, enabled: true, config: {}, ...overrides }) as ProviderInstanceConfig;

const row = (instanceId: string, isUnavailable = false) => ({
  instanceId: id(instanceId),
  isUnavailable,
});

const NOW = Date.parse("2026-08-14T12:00:00.000Z");
const inOneHour = "2026-08-14T13:00:00.000Z";
const anHourAgo = "2026-08-14T11:00:00.000Z";

const usageSample = (overrides: Partial<ProviderUsageSample>): ProviderUsageSample =>
  ({
    providerInstanceId: id("claude_work"),
    window: "five_hour",
    utilization: 50,
    resetsAt: inOneHour,
    source: "claude.sdk.get_usage",
    observedAt: anHourAgo,
    ...overrides,
  }) as ProviderUsageSample;

const accountLimit = (overrides: Partial<ProviderAccountLimit>): ProviderAccountLimit =>
  ({
    providerInstanceId: id("claude_work"),
    driver: claude,
    kind: "usage-limit",
    detectedAt: anHourAgo,
    resetsAt: inOneHour,
    resetsAtEstimated: false,
    source: "claude.sdk.rate_limit_event",
    detail: null,
    ...overrides,
  }) as ProviderAccountLimit;

const authRunState = (overrides: Partial<ProviderAuthRunState>): ProviderAuthRunState => ({
  status: "running",
  startedAt: "2026-08-14T12:00:00.000Z",
  finishedAt: null,
  message: "Waiting for provider authentication.",
  output: "",
  verificationUrl: null,
  userCode: null,
  ...overrides,
});

describe("provider instance identity", () => {
  it("shares the wizard slug, validation, and collision rules", () => {
    expect(slugifyProviderInstanceLabel("  Work / Personal  ")).toBe("work_personal");
    expect(deriveProviderInstanceId(codex, "Work / Personal")).toBe("codex_work_personal");
    expect(validateProviderInstanceId("1bad", new Set())).toContain("start with a letter");
    expect(validateProviderInstanceId("codex_work", new Set(["codex_work"]))).toContain(
      "already exists",
    );
    expect(validateProviderInstanceId("codex_work", new Set())).toBeNull();
  });

  it("allocates a stable next account id around explicit and synthesized rows", () => {
    const occupied = new Set(["codex", "codex_account_2", "codex_account_4"]);
    expect(nextManagedProviderAccountIdentity(codex, occupied)).toEqual({
      instanceId: id("codex_account_3"),
      displayName: "Account 3",
    });
  });
});

describe("provider credential homes", () => {
  it.each([
    [claude, "shadowHomePath"],
    [codex, "shadowHomePath"],
    [kimi, "homePath"],
    [opencode, "dataHomePath"],
  ] as const)("maps %s to %s", (driver, field) => {
    const original = instance({ driver, config: { binaryPath: "provider" } });
    const next = withProviderCredentialHome(original, "/state/accounts/driver/account");
    expect(next?.config).toEqual({
      binaryPath: "provider",
      [field]: "/state/accounts/driver/account",
    });
    expect(next && readProviderCredentialHome(next)).toBe("/state/accounts/driver/account");
  });

  it("shows home deletion only for the exact managed path", () => {
    const input = {
      accountsDir: "/var/lib/t3/accounts",
      driver: codex,
      instanceId: id("codex_account_2"),
    };
    expect(
      isManagedProviderAccountHomeForDisplay({
        ...input,
        homePath: "/var/lib/t3/accounts/codex/codex_account_2",
      }),
    ).toBe(true);
    expect(
      isManagedProviderAccountHomeForDisplay({
        ...input,
        homePath: "/var/lib/t3/accounts/codex/another_account",
      }),
    ).toBe(false);
    expect(
      isManagedProviderAccountHomeForDisplay({
        ...input,
        homePath: "/other/accounts/codex/codex_account_2",
      }),
    ).toBe(false);
    expect(
      isManagedProviderAccountHomeForDisplay({
        ...input,
        accountsDir: undefined,
        homePath: "/var/lib/t3/accounts/codex/codex_account_2",
      }),
    ).toBe(false);
  });

  it("uses the allocated Claude shadow home for deletion", () => {
    expect(
      isManagedProviderAccountHomeForDisplay({
        accountsDir: "/var/lib/t3/accounts",
        driver: claude,
        instanceId: id("claude_account_2"),
        homePath: "/var/lib/t3/accounts/claudeAgent/claude_account_2",
      }),
    ).toBe(true);
  });
});

describe("provider authentication actions", () => {
  it("offers scriptable sign-in and sign-out by live auth status", () => {
    expect(
      resolveProviderAccountAuthAction({ driver: codex, authStatus: "unauthenticated" }),
    ).toEqual({ kind: "sign-in" });
    expect(resolveProviderAccountAuthAction({ driver: codex, authStatus: "unknown" })).toEqual({
      kind: "none",
    });
    expect(
      resolveProviderAccountAuthAction({ driver: codex, authStatus: "authenticated" }),
    ).toEqual({ kind: "sign-out" });
  });

  it("uses exact manual commands for unsupported harnesses", () => {
    expect(
      resolveProviderAccountAuthAction({
        driver: ProviderDriverKind.make("cursor"),
        authStatus: "unauthenticated",
        serverMessage: "Cursor is not authenticated. Run `agent login` and try again.",
      }),
    ).toEqual({ kind: "manual", command: "agent login" });
    expect(
      resolveProviderAccountAuthAction({
        driver: ProviderDriverKind.make("primeAgent"),
        authStatus: "authenticated",
      }),
    ).toEqual({ kind: "none" });
  });
});

describe("reduceProviderAuthRunState", () => {
  it("keeps the start response while streamed state fills in login details", () => {
    const start = authRunState({});
    const streamed = authRunState({
      message: null,
      output: "Open https://example.test/device and enter ABCD-1234",
      verificationUrl: "https://example.test/device",
      userCode: "ABCD-1234",
    });
    expect(reduceProviderAuthRunState(start, streamed)).toEqual({
      ...streamed,
      message: start.message,
    });
  });

  it("does not let a late idle or running snapshot regress active or terminal state", () => {
    const running = authRunState({ output: "ready" });
    expect(reduceProviderAuthRunState(running, authRunState({ status: "idle" }))).toBe(running);
    const succeeded = authRunState({ status: "succeeded", finishedAt: inOneHour });
    expect(reduceProviderAuthRunState(succeeded, running)).toBe(succeeded);
  });
});

describe("orderProviderGroupRows", () => {
  it("orders by explicit key order with synthesized entries last", () => {
    const rows = [row("claudeAgent"), row("claude_work"), row("claude_personal")];
    const ordered = orderProviderGroupRows(rows, ["claude_personal", "claude_work"]);
    expect(ordered.map((r) => String(r.instanceId))).toEqual([
      "claude_personal",
      "claude_work",
      "claudeAgent",
    ]);
  });

  it("keeps an unavailable shadow below every live account", () => {
    const rows = [row("fork_shadow", true), row("fork_live")];
    const ordered = orderProviderGroupRows(rows, ["fork_shadow", "fork_live"]);
    expect(ordered.map((r) => String(r.instanceId))).toEqual(["fork_live", "fork_shadow"]);
  });
});

describe("moveProviderAccount", () => {
  const rows = [row("a"), row("b"), row("c")];

  it("moves one step and returns null at the ends", () => {
    expect(moveProviderAccount(rows, id("b"), "up")?.map((r) => String(r.instanceId))).toEqual([
      "b",
      "a",
      "c",
    ]);
    expect(moveProviderAccount(rows, id("a"), "up")).toBeNull();
    expect(moveProviderAccount(rows, id("c"), "down")).toBeNull();
    expect(moveProviderAccount(rows, id("missing"), "down")).toBeNull();
  });
});

describe("buildProviderGroupReorderPatch", () => {
  const settings = (
    providerInstances: Record<string, ProviderInstanceConfig>,
  ): Pick<ServerSettings, "providers" | "providerInstances"> => ({
    providers: DEFAULT_UNIFIED_SETTINGS.providers,
    providerInstances: providerInstances as ServerSettings["providerInstances"],
  });

  it("rewrites the group's keys in place and keeps other harnesses' positions", () => {
    const codexInstance = instance({ driver: ProviderDriverKind.make("codex") });
    const patch = buildProviderGroupReorderPatch({
      settings: settings({
        claude_work: instance(),
        codex_personal: codexInstance,
        claude_personal: instance(),
      }),
      groupOrder: [
        { instanceId: id("claude_personal"), instance: instance() },
        { instanceId: id("claude_work"), instance: instance() },
      ],
    });
    expect(Object.keys(patch.providerInstances ?? {})).toEqual([
      "claude_personal",
      "codex_personal",
      "claude_work",
    ]);
    expect(patch.providers).toBeUndefined();
  });

  it("materializes a synthesized default at its ordered position and resets its legacy mirror", () => {
    const patch = buildProviderGroupReorderPatch({
      settings: settings({ claude_work: instance() }),
      groupOrder: [
        { instanceId: id("claudeAgent"), instance: instance() },
        { instanceId: id("claude_work"), instance: instance() },
      ],
    });
    // The default slot takes the one explicit position; the demoted custom
    // appends after it, so within-harness key order matches the new order.
    expect(Object.keys(patch.providerInstances ?? {})).toEqual(["claudeAgent", "claude_work"]);
    expect(patch.providers?.claudeAgent).toEqual(DEFAULT_UNIFIED_SETTINGS.providers.claudeAgent);
  });
});

describe("deriveProviderAccountLimitState", () => {
  it("returns null when the driver reports no usage and no block", () => {
    expect(
      deriveProviderAccountLimitState({ usage: undefined, limit: null, nowMs: NOW }),
    ).toBeNull();
    expect(
      deriveProviderAccountLimitState({ usage: undefined, limit: undefined, nowMs: NOW }),
    ).toBeNull();
  });

  it("picks the worst still-live window and drops expired samples", () => {
    const state = deriveProviderAccountLimitState({
      usage: [
        usageSample({ window: "five_hour", utilization: 41.4 }),
        usageSample({ window: "seven_day", utilization: 88.6 }),
        usageSample({ window: "seven_day_opus", utilization: 99, resetsAt: anHourAgo }),
      ],
      limit: null,
      nowMs: NOW,
    });
    expect(state?.utilization).toEqual({
      percent: 89,
      windowLabel: "7d window",
      resetsAt: inOneHour,
    });
    expect(state?.blocked).toBeNull();
  });

  it("keeps a null-reset sample live because the server said so", () => {
    const state = deriveProviderAccountLimitState({
      usage: [usageSample({ utilization: 12, resetsAt: null })],
      limit: null,
      nowMs: NOW,
    });
    expect(state?.utilization?.percent).toBe(12);
  });

  it("reports a live block with its reset time and hides an expired one", () => {
    const live = deriveProviderAccountLimitState({
      usage: undefined,
      limit: accountLimit({}),
      nowMs: NOW,
    });
    expect(live?.blocked).toEqual({ label: "Usage limit reached", resetsAt: inOneHour });

    const expired = deriveProviderAccountLimitState({
      usage: undefined,
      limit: accountLimit({ resetsAt: anHourAgo }),
      nowMs: NOW,
    });
    expect(expired).toBeNull();
  });

  it("shows a block with no reset time and no invented countdown", () => {
    const state = deriveProviderAccountLimitState({
      usage: undefined,
      limit: accountLimit({ kind: "spend-limit", resetsAt: null }),
      nowMs: NOW,
    });
    expect(state?.blocked).toEqual({ label: "Spend limit reached", resetsAt: null });
  });
});

describe("formatResetCountdown", () => {
  it("formats each magnitude and expires in the past", () => {
    const at = (ms: number) => new Date(NOW + ms).toISOString();
    expect(formatResetCountdown(at(30_000), NOW)).toBe("1m");
    expect(formatResetCountdown(at(9 * 60_000), NOW)).toBe("9m");
    expect(formatResetCountdown(at((2 * 60 + 14) * 60_000), NOW)).toBe("2h 14m");
    expect(formatResetCountdown(at((3 * 24 + 4) * 3_600_000), NOW)).toBe("3d 4h");
    expect(formatResetCountdown(at(-1), NOW)).toBeNull();
    expect(formatResetCountdown("not-a-date", NOW)).toBeNull();
  });
});
