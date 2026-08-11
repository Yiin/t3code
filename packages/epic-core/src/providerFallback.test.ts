import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ModelSelection,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  resolveEpicProviderChainFallback,
  resolveEpicProviderFallback,
} from "./providerFallback.ts";
import { classifyIteration } from "./ralphProtocol.ts";

const selection = (instanceId: string, model = "primary"): ModelSelection => ({
  instanceId: ProviderInstanceId.make(instanceId),
  model,
});

const provider = (
  instanceId: string,
  driver: string,
  model: string,
  overrides: Partial<ServerProvider> = {},
): ServerProvider => ({
  instanceId: ProviderInstanceId.make(instanceId),
  driver: ProviderDriverKind.make(driver),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-08-05T00:00:00.000Z",
  availability: "available",
  models: [{ slug: model, name: model, isCustom: false, capabilities: null }],
  slashCommands: [],
  skills: [],
  ...overrides,
});

const claude = provider("claude-work", "claudeAgent", "claude-sonnet-5");
const codex = provider("codex-personal", "codex", "gpt-5.6-sol");
const kimi = provider("kimi-team", "kimi", "kimi-code/k3");
const prime = provider("prime-work", "primeAgent", "prime/custom-model");

describe("resolveEpicProviderChainFallback", () => {
  const claudeA = provider("claude-a", "claudeAgent", "claude-sonnet-5");
  const claudeB = provider("claude-b", "claudeAgent", "claude-sonnet-5");
  const claudeC = provider("claude-c", "claudeAgent", "claude-sonnet-5");
  const claudeChain = [
    selection("claude-a", "claude-sonnet-5"),
    selection("claude-b", "claude-sonnet-5"),
    selection("claude-c", "claude-sonnet-5"),
  ];

  const resolve = (
    overrides: Partial<Parameters<typeof resolveEpicProviderChainFallback>[0]> = {},
  ) =>
    resolveEpicProviderChainFallback({
      providers: [claudeA, claudeB, claudeC],
      chain: claudeChain,
      current: selection("claude-a", "claude-sonnet-5"),
      failureReason: "provider-error:rate-limit",
      providerFallbackEligible: true,
      ...overrides,
    });

  it("advances between instances of the same provider driver", () => {
    expect(resolve()).toEqual(selection("claude-b", "claude-sonnet-5"));
  });

  it("skips a blocked intermediate instance", () => {
    expect(resolve({ isBlocked: (hop) => hop.instanceId === claudeB.instanceId })).toEqual(
      selection("claude-c", "claude-sonnet-5"),
    );
  });

  it("skips an ineligible intermediate instance", () => {
    const ineligibleClaudeB = { ...claudeB, installed: false };

    expect(resolve({ providers: [claudeA, ineligibleClaudeB, claudeC] })).toEqual(
      selection("claude-c", "claude-sonnet-5"),
    );
  });

  it("skips a disabled intermediate instance whose status remains ready", () => {
    const disabledClaudeB = { ...claudeB, enabled: false };

    expect(resolve({ providers: [claudeA, disabledClaudeB, claudeC] })).toEqual(
      selection("claude-c", "claude-sonnet-5"),
    );
  });

  it("returns null when the current instance is the last hop", () => {
    expect(resolve({ current: selection("claude-c", "claude-sonnet-5") })).toBeNull();
  });

  it("starts at the first eligible hop when the current instance is absent", () => {
    expect(resolve({ current: selection("claude-outside", "claude-sonnet-5") })).toEqual(
      selection("claude-a", "claude-sonnet-5"),
    );
  });

  it("never returns a duplicate of the current instance later in the chain", () => {
    expect(
      resolve({
        chain: [
          selection("claude-a", "claude-sonnet-5"),
          selection("claude-a", "claude-sonnet-5"),
          selection("claude-c", "claude-sonnet-5"),
        ],
      }),
    ).toEqual(selection("claude-c", "claude-sonnet-5"));
  });

  it("preserves options from the selected hop", () => {
    const options: NonNullable<ModelSelection["options"]> = [
      { id: "reasoningEffort", value: "high" },
    ];
    const result = resolve({
      providers: [claudeA, codex],
      chain: [
        selection("claude-a", "claude-sonnet-5"),
        { instanceId: codex.instanceId, model: "gpt-5.6-sol", options },
      ],
    });

    expect(result).toEqual({
      instanceId: codex.instanceId,
      model: "gpt-5.6-sol",
      options,
    });
    expect(result?.options).toBe(options);
  });

  it.each([
    { failureReason: "infra:timeout", providerFallbackEligible: true },
    { failureReason: "provider-error:rate-limit", providerFallbackEligible: false },
  ])("rejects ineligible fallback evidence: $failureReason", (evidence) => {
    expect(resolve(evidence)).toBeNull();
  });

  it("skips a hop without a provider snapshot", () => {
    expect(resolve({ providers: [claudeA, claudeC] })).toEqual(
      selection("claude-c", "claude-sonnet-5"),
    );
  });
});

describe("resolveEpicProviderFallback", () => {
  it("moves Prime to Claude without inheriting Prime's model", () => {
    expect(
      resolveEpicProviderFallback({
        providers: [prime, claude, codex, kimi],
        current: selection("prime-work", "prime/custom-model"),
        failureReason: "provider-error:rate-limit",
        providerFallbackEligible: true,
      }),
    ).toEqual(selection("claude-work", "claude-sonnet-5"));
  });

  it("skips unavailable stages while moving forward from Prime", () => {
    const missingClaude = provider("claude-missing", "claudeAgent", "claude-sonnet-5", {
      installed: false,
    });
    const unavailableCodex = provider("codex-unavailable", "codex", "gpt-5.6-sol", {
      availability: "unavailable",
    });
    expect(
      resolveEpicProviderFallback({
        providers: [prime, missingClaude, unavailableCodex, kimi],
        current: selection("prime-work", "prime/custom-model"),
        failureReason: "provider-error:auth",
        providerFallbackEligible: true,
      }),
    ).toEqual(selection("kimi-team", "kimi-code/k3"));
  });

  it("resolves a custom current instance and returns exact Codex settings", () => {
    expect(
      resolveEpicProviderFallback({
        providers: [claude, codex, kimi],
        current: selection("claude-work"),
        failureReason: "provider-error:rate-limit",
        providerFallbackEligible: true,
      }),
    ).toEqual({
      instanceId: ProviderInstanceId.make("codex-personal"),
      model: "gpt-5.6-sol",
      options: [{ id: "reasoningEffort", value: "high" }],
    });
  });

  it("skips ineligible intermediate instances", () => {
    const disabledCodex = provider("codex-disabled", "codex", "gpt-5.6-sol", {
      enabled: false,
      status: "disabled",
    });
    const wrongModelCodex = provider("codex-old", "codex", "gpt-5.4");
    const missingCodex = provider("codex-missing", "codex", "gpt-5.6-sol", {
      installed: false,
    });
    const unavailableCodex = provider("codex-unavailable", "codex", "gpt-5.6-sol", {
      availability: "unavailable",
    });
    const warningCodex = provider("codex-warning", "codex", "gpt-5.6-sol", {
      status: "warning",
    });
    const loggedOutCodex = provider("codex-logged-out", "codex", "gpt-5.6-sol", {
      auth: { status: "unauthenticated" },
    });
    expect(
      resolveEpicProviderFallback({
        providers: [
          claude,
          disabledCodex,
          missingCodex,
          unavailableCodex,
          warningCodex,
          loggedOutCodex,
          wrongModelCodex,
          kimi,
        ],
        current: selection("claude-work"),
        failureReason: "provider-error:auth",
        providerFallbackEligible: true,
      }),
    ).toEqual(selection("kimi-team", "kimi-code/k3"));
  });

  it("moves from Codex to Kimi", () => {
    expect(
      resolveEpicProviderFallback({
        providers: [claude, codex, kimi],
        current: selection("codex-personal"),
        failureReason: "provider-error:spend-limit",
        providerFallbackEligible: true,
      }),
    ).toEqual(selection("kimi-team", "kimi-code/k3"));
  });

  it("falls back when a completed provider message reports unavailability", () => {
    const outcome = classifyIteration({
      turnState: "completed",
      finalMessage: { text: "The provider is unavailable (503)", streaming: false },
      finalMessageWaitExhausted: false,
      sessionLastError: null,
      committed: false,
      timedOut: false,
    });
    expect(outcome.failureReason).toBe("provider-error:unavailable");
    expect(outcome.providerFallbackEligible).toBe(true);
    expect(
      resolveEpicProviderFallback({
        providers: [claude, codex, kimi],
        current: selection("claude-work"),
        failureReason: outcome.failureReason,
        providerFallbackEligible: outcome.providerFallbackEligible === true,
      }),
    ).toEqual({
      instanceId: ProviderInstanceId.make("codex-personal"),
      model: "gpt-5.6-sol",
      options: [{ id: "reasoningEffort", value: "high" }],
    });
  });

  it.each([
    "The application returned 503 while testing its retry page.",
    "The domain text says Service unavailable (503).",
    "The task documents authentication handling.",
    "The application returned 401 during its test.",
    "Add rate limit handling to the client.",
    "The application shows overloaded during maintenance.",
  ])("does not fall back for unrelated application text: %s", (text) => {
    const outcome = classifyIteration({
      turnState: "completed",
      finalMessage: { text, streaming: false },
      finalMessageWaitExhausted: false,
      sessionLastError: null,
      committed: false,
      timedOut: false,
    });

    expect(outcome.providerFallbackEligible).not.toBe(true);
    expect(
      resolveEpicProviderFallback({
        providers: [claude, codex, kimi],
        current: selection("claude-work"),
        failureReason: outcome.failureReason,
        providerFallbackEligible: outcome.providerFallbackEligible === true,
      }),
    ).toBeNull();
  });

  it("falls back for a provider error from session.lastError", () => {
    const outcome = classifyIteration({
      turnState: "error",
      finalMessage: null,
      finalMessageWaitExhausted: false,
      sessionLastError: "authentication failed",
      committed: false,
      timedOut: false,
    });

    expect(outcome.providerErrorSource).toBe("session-last-error");
    expect(outcome.providerFallbackEligible).toBe(true);
    expect(
      resolveEpicProviderFallback({
        providers: [claude, codex, kimi],
        current: selection("claude-work"),
        failureReason: outcome.failureReason,
        providerFallbackEligible: outcome.providerFallbackEligible === true,
      }),
    ).toEqual({
      instanceId: ProviderInstanceId.make("codex-personal"),
      model: "gpt-5.6-sol",
      options: [{ id: "reasoningEffort", value: "high" }],
    });
  });

  it.each(["infra:dispatch-failed", "infra:timeout", "infra:protocol-error", "child:blocked"])(
    "does not fall back for %s",
    (failureReason) => {
      expect(
        resolveEpicProviderFallback({
          providers: [claude, codex, kimi],
          current: selection("claude-work"),
          failureReason,
          providerFallbackEligible: true,
        }),
      ).toBeNull();
    },
  );

  it("never transitions backward from Kimi", () => {
    expect(
      resolveEpicProviderFallback({
        providers: [claude, codex, kimi],
        current: selection("kimi-team"),
        failureReason: "provider-error:rate-limit",
        providerFallbackEligible: true,
      }),
    ).toBeNull();
  });

  it("never transitions backward from an existing Claude primary into Prime", () => {
    expect(
      resolveEpicProviderFallback({
        providers: [prime, claude, codex, kimi],
        current: selection("claude-work", "claude-sonnet-5"),
        failureReason: "provider-error:rate-limit",
        providerFallbackEligible: true,
      }),
    ).toEqual({
      instanceId: ProviderInstanceId.make("codex-personal"),
      model: "gpt-5.6-sol",
      options: [{ id: "reasoningEffort", value: "high" }],
    });
  });

  it("requires trusted provider evidence even for a provider-error reason", () => {
    expect(
      resolveEpicProviderFallback({
        providers: [claude, codex, kimi],
        current: selection("claude-work"),
        failureReason: "provider-error:auth",
        providerFallbackEligible: false,
      }),
    ).toBeNull();
  });
});
