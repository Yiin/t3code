import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ModelSelection,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  isLiveProviderDegradation,
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

  it("counts a record newer than the cutoff", () => {
    expect(isLiveProviderDegradation(record, "2026-08-13T09:00:00Z")).toBe(true);
  });

  it("retires a record at or older than the cutoff", () => {
    expect(isLiveProviderDegradation(record, "2026-08-13T10:00:00Z")).toBe(false);
    expect(isLiveProviderDegradation(record, "2026-08-13T11:00:00Z")).toBe(false);
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

  it("walks driver order when the role has no chain", () => {
    const resolved = resolveDegradationAwareSelection({
      providers,
      chain: [],
      current: claudeWork,
      degradationOf: degraded("claude-work", "codex-personal"),
    });
    // Driver order is Claude then Codex then Kimi, and Codex is degraded too.
    expect(resolved.selection).toEqual({
      instanceId: ProviderInstanceId.make("kimi-work"),
      model: "kimi-code/k3",
    });
    expect(resolved.hops.map((hop) => hop.to.instanceId)).toEqual(["codex-personal", "kimi-work"]);
  });

  it("stops on the last reachable instance when driver order runs out", () => {
    const resolved = resolveDegradationAwareSelection({
      providers,
      chain: [],
      current: claudeWork,
      degradationOf: degraded("claude-work", "codex-personal", "kimi-work"),
    });
    expect(resolved.selection.instanceId).toBe("kimi-work");
  });
});
