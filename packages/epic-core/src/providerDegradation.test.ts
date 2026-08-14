import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ModelSelection,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  isLiveProviderDegradation,
  providerDegradationResetsAt,
  resolveDegradationAwareSelection,
} from "./providerDegradation.ts";

const selection = (instanceId: string, model: string): ModelSelection => ({
  instanceId: ProviderInstanceId.make(instanceId),
  model,
});

const provider = (instanceId: string, driver: string, model: string): ServerProvider => ({
  instanceId: ProviderInstanceId.make(instanceId),
  driver: ProviderDriverKind.make(driver),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-08-13T00:00:00.000Z",
  availability: "available",
  models: [{ slug: model, name: model, isCustom: false, capabilities: null }],
  slashCommands: [],
  skills: [],
});

const claudeWork = selection("claude-work", "claude-sonnet-5");
const claudePersonal = selection("claude-personal", "claude-sonnet-5");
const codex = selection("codex-personal", "gpt-5.6-sol");
const providers = [
  provider("claude-work", "claudeAgent", "claude-sonnet-5"),
  provider("claude-personal", "claudeAgent", "claude-sonnet-5"),
  provider("codex-personal", "codex", "gpt-5.6-sol"),
  provider("kimi-work", "kimi", "kimi-code/k3"),
];

const degraded = (...instanceIds: ReadonlyArray<string>) => {
  const blocked = new Set(instanceIds);
  return (instanceId: string) =>
    blocked.has(instanceId)
      ? { failureReason: "provider-error:rate-limit", degradedAt: "x" }
      : null;
};

describe("isLiveProviderDegradation", () => {
  const record = { failureReason: "provider-error:rate-limit", degradedAt: "2026-08-13T10:00:00Z" };
  const now = "2026-08-13T12:00:00Z";

  it("counts a record newer than the cutoff", () => {
    expect(isLiveProviderDegradation(record, "2026-08-13T09:00:00Z", now)).toBe(true);
  });

  it("retires a record at or older than the cutoff", () => {
    expect(isLiveProviderDegradation(record, "2026-08-13T10:00:00Z", now)).toBe(false);
    expect(isLiveProviderDegradation(record, "2026-08-13T11:00:00Z", now)).toBe(false);
  });

  it("keeps a record live by resetsAt even when degradedAt is past the cutoff", () => {
    const fiveHourWindow = { ...record, resetsAt: "2026-08-13T15:00:00Z" };
    expect(isLiveProviderDegradation(fiveHourWindow, "2026-08-13T11:00:00Z", now)).toBe(true);
  });

  it("retires a record by resetsAt even while degradedAt is still inside the TTL", () => {
    const shortWindow = { ...record, resetsAt: "2026-08-13T11:00:00Z" };
    expect(isLiveProviderDegradation(shortWindow, "2026-08-13T09:00:00Z", now)).toBe(false);
    expect(isLiveProviderDegradation({ ...record, resetsAt: now }, "2026-08-13T09:00:00Z", now)) //
      .toBe(false);
  });

  it("keeps exact TTL behaviour for a null resetsAt", () => {
    const noReset = { ...record, resetsAt: null };
    expect(isLiveProviderDegradation(noReset, "2026-08-13T09:00:00Z", now)).toBe(true);
    expect(isLiveProviderDegradation(noReset, "2026-08-13T10:00:00Z", now)).toBe(false);
  });
});

describe("providerDegradationResetsAt", () => {
  const now = "2026-08-13T12:00:00Z";
  const sample = (
    instanceId: string,
    utilization: number,
    resetsAt: string | null,
  ): import("@t3tools/contracts").ProviderUsageSample => ({
    providerInstanceId: ProviderInstanceId.make(instanceId),
    window: "five_hour",
    utilization,
    resetsAt,
    source: "claude.sdk.get_usage",
    observedAt: now,
  });
  const failing = ProviderInstanceId.make("claude-work");

  it("stores the worst live window's reset time for a limit failure", () => {
    expect(
      providerDegradationResetsAt({
        failureReason: "provider-error:rate-limit",
        samples: [
          sample("claude-work", 60, "2026-08-13T13:00:00Z"),
          sample("claude-work", 100, "2026-08-13T17:00:00Z"),
          sample("codex-personal", 100, "2026-08-13T23:00:00Z"),
        ],
        providerInstanceId: failing,
        now,
      }),
    ).toBe("2026-08-13T17:00:00Z");
  });

  it("drops a window whose reset time has passed", () => {
    expect(
      providerDegradationResetsAt({
        failureReason: "provider-error:spend-limit",
        samples: [
          sample("claude-work", 100, "2026-08-13T11:00:00Z"),
          sample("claude-work", 80, "2026-08-13T16:00:00Z"),
        ],
        providerInstanceId: failing,
        now,
      }),
    ).toBe("2026-08-13T16:00:00Z");
  });

  it("never invents a reset time: a worst window without one means null", () => {
    expect(
      providerDegradationResetsAt({
        failureReason: "provider-error:spend-limit",
        samples: [
          sample("claude-work", 100, null),
          sample("claude-work", 50, "2026-08-13T16:00:00Z"),
        ],
        providerInstanceId: failing,
        now,
      }),
    ).toBeNull();
    expect(
      providerDegradationResetsAt({
        failureReason: "provider-error:rate-limit",
        samples: [],
        providerInstanceId: failing,
        now,
      }),
    ).toBeNull();
  });

  it("gives auth and unavailable failures no reset time", () => {
    for (const failureReason of [
      "provider-error:auth",
      "provider-error:unavailable",
      "provider-error",
    ]) {
      expect(
        providerDegradationResetsAt({
          failureReason,
          samples: [sample("claude-work", 100, "2026-08-13T17:00:00Z")],
          providerInstanceId: failing,
          now,
        }),
      ).toBeNull();
    }
  });
});

describe("resolveDegradationAwareSelection", () => {
  const chain = [claudeWork, claudePersonal, codex];

  it("keeps a healthy selection and reports no hop", () => {
    expect(
      resolveDegradationAwareSelection({
        providers,
        chain,
        current: claudeWork,
        degradationOf: degraded("claude-personal"),
      }),
    ).toEqual({ selection: claudeWork, hops: [] });
  });

  it("takes the next chain hop the same driver owns", () => {
    const resolved = resolveDegradationAwareSelection({
      providers,
      chain,
      current: claudeWork,
      degradationOf: degraded("claude-work"),
    });
    expect(resolved.selection).toEqual(claudePersonal);
    expect(resolved.hops).toEqual([
      { from: claudeWork, to: claudePersonal, reason: "provider-error:rate-limit" },
    ]);
  });

  it("takes the deepest hop when every hop is degraded, so a run still starts", () => {
    const resolved = resolveDegradationAwareSelection({
      providers,
      chain,
      current: claudeWork,
      degradationOf: degraded("claude-work", "claude-personal", "codex-personal"),
    });
    expect(resolved.selection).toEqual(codex);
  });

  it("rotates to the same-harness sibling when the role has no chain", () => {
    const resolved = resolveDegradationAwareSelection({
      providers,
      chain: [],
      current: claudeWork,
      degradationOf: degraded("claude-work", "codex-personal"),
    });
    expect(resolved.selection).toEqual(claudePersonal);
    expect(resolved.hops).toEqual([
      { from: claudeWork, to: claudePersonal, reason: "provider-error:rate-limit" },
    ]);
  });

  it("walks driver order when every same-harness sibling is degraded too", () => {
    const resolved = resolveDegradationAwareSelection({
      providers,
      chain: [],
      current: claudeWork,
      degradationOf: degraded("claude-work", "claude-personal", "codex-personal"),
    });
    // Driver order is Claude then Codex then Kimi, and Codex is degraded too.
    expect(resolved.selection).toEqual({
      instanceId: ProviderInstanceId.make("kimi-work"),
      model: "kimi-code/k3",
    });
    expect(resolved.hops.map((hop) => hop.to.instanceId)).toEqual(["kimi-work"]);
  });

  it("stops on the last reachable instance when driver order runs out", () => {
    const resolved = resolveDegradationAwareSelection({
      providers,
      chain: [],
      current: claudeWork,
      degradationOf: degraded("claude-work", "claude-personal", "codex-personal", "kimi-work"),
    });
    expect(resolved.selection.instanceId).toBe("kimi-work");
  });

  it("reroutes an exhausted current without any degradation record", () => {
    const resolved = resolveDegradationAwareSelection({
      providers,
      chain,
      current: claudeWork,
      degradationOf: () => null,
      isExhausted: (instanceId) => instanceId === "claude-work",
    });
    expect(resolved.selection).toEqual(claudePersonal);
    expect(resolved.hops).toEqual([
      { from: claudeWork, to: claudePersonal, reason: "usage-exhausted" },
    ]);
  });

  it("skips an exhausted chain hop the way it skips a degraded one", () => {
    const resolved = resolveDegradationAwareSelection({
      providers,
      chain,
      current: claudeWork,
      degradationOf: degraded("claude-work"),
      isExhausted: (instanceId) => instanceId === "claude-personal",
    });
    expect(resolved.selection).toEqual(codex);
  });

  it("skips a degraded sibling expanded from an earlier chain hop", () => {
    const resolved = resolveDegradationAwareSelection({
      providers,
      chain: [claudeWork, codex],
      current: claudeWork,
      degradationOf: degraded("claude-work", "claude-personal"),
    });

    expect(resolved.selection).toEqual(codex);
  });

  it("keeps the deepest-hop last resort when every hop is exhausted", () => {
    const resolved = resolveDegradationAwareSelection({
      providers,
      chain,
      current: claudeWork,
      degradationOf: () => null,
      isExhausted: () => true,
    });
    expect(resolved.selection).toEqual(codex);
    expect(resolved.hops).toEqual([{ from: claudeWork, to: codex, reason: "usage-exhausted" }]);
  });

  it("rotates to the sibling when only the current instance is exhausted", () => {
    const resolved = resolveDegradationAwareSelection({
      providers,
      chain: [],
      current: claudeWork,
      degradationOf: () => null,
      isExhausted: (instanceId) => instanceId === "claude-work",
    });
    expect(resolved.selection).toEqual(claudePersonal);
    expect(resolved.hops).toEqual([
      { from: claudeWork, to: claudePersonal, reason: "usage-exhausted" },
    ]);
  });

  it("walks driver order past exhausted instances", () => {
    const exhausted = new Set(["claude-work", "claude-personal", "codex-personal"]);
    const resolved = resolveDegradationAwareSelection({
      providers,
      chain: [],
      current: claudeWork,
      degradationOf: () => null,
      isExhausted: (instanceId) => exhausted.has(instanceId),
    });
    expect(resolved.selection.instanceId).toBe("kimi-work");
    expect(resolved.hops.map((hop) => hop.reason)).toEqual(["usage-exhausted"]);
  });
});
