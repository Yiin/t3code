import type { SDKRateLimitInfo } from "@anthropic-ai/claude-agent-sdk";
import type { ApiError, MessageAbortedError, ProviderAuthError } from "@opencode-ai/sdk/v2";
import { assert, describe, it } from "@effect/vitest";
import type * as CodexSchema from "effect-codex-app-server/schema";

import {
  classifyClaudeRateLimitInfo,
  classifyCodexRateLimits,
  classifyOpenCodeMessageError,
  classifyProviderErrorText,
  normalizeEpochResetsAt,
  type CodexRateLimitSnapshot,
} from "./providerLimitSignal.ts";

const DETECTED_AT = "2026-08-14T10:00:00.000Z";
const RESET_EPOCH_SECONDS = 1_787_207_826;
const RESET_ISO = "2026-08-20T06:37:06.000Z";

describe("normalizeEpochResetsAt", () => {
  it("passes ISO strings through and converts both epoch units", () => {
    assert.strictEqual(normalizeEpochResetsAt(RESET_ISO), RESET_ISO);
    assert.strictEqual(normalizeEpochResetsAt(RESET_EPOCH_SECONDS), RESET_ISO);
    assert.strictEqual(normalizeEpochResetsAt(RESET_EPOCH_SECONDS * 1_000), RESET_ISO);
  });

  it("yields null for absent or unusable values", () => {
    assert.isNull(normalizeEpochResetsAt(null));
    assert.isNull(normalizeEpochResetsAt(undefined));
    assert.isNull(normalizeEpochResetsAt(0));
    assert.isNull(normalizeEpochResetsAt(Number.NaN));
  });
});

describe("classifyClaudeRateLimitInfo", () => {
  const rejected = (overrides: Partial<SDKRateLimitInfo> = {}): SDKRateLimitInfo => ({
    status: "rejected",
    ...overrides,
  });

  it("returns null for status allowed", () => {
    assert.isNull(classifyClaudeRateLimitInfo({ status: "allowed", utilization: 42 }, DETECTED_AT));
  });

  it("returns null for status allowed_warning", () => {
    assert.isNull(
      classifyClaudeRateLimitInfo({ status: "allowed_warning", utilization: 91 }, DETECTED_AT),
    );
  });

  it("classifies rejected with a harness reset as usage-limit with an exact resetsAt", () => {
    assert.deepStrictEqual(
      classifyClaudeRateLimitInfo(
        rejected({ resetsAt: RESET_EPOCH_SECONDS, rateLimitType: "five_hour" }),
        DETECTED_AT,
      ),
      {
        kind: "usage-limit",
        detectedAt: DETECTED_AT,
        resetsAt: RESET_ISO,
        resetsAtEstimated: false,
        source: "claude.sdk.rate_limit_event",
        detail: "rateLimitType=five_hour",
      },
    );
  });

  it("normalizes a millisecond epoch reset to the same instant", () => {
    const signal = classifyClaudeRateLimitInfo(
      rejected({ resetsAt: RESET_EPOCH_SECONDS * 1_000 }),
      DETECTED_AT,
    );
    assert.strictEqual(signal?.resetsAt, RESET_ISO);
    assert.strictEqual(signal?.resetsAtEstimated, false);
  });

  it("classifies rejected without reset information as resetsAt null, never estimated", () => {
    assert.deepStrictEqual(classifyClaudeRateLimitInfo(rejected(), DETECTED_AT), {
      kind: "usage-limit",
      detectedAt: DETECTED_AT,
      resetsAt: null,
      resetsAtEstimated: false,
      source: "claude.sdk.rate_limit_event",
      detail: null,
    });
  });

  it("classifies rejected with overageDisabledReason out_of_credits as credits-depleted", () => {
    const signal = classifyClaudeRateLimitInfo(
      rejected({ overageDisabledReason: "out_of_credits" }),
      DETECTED_AT,
    );
    assert.strictEqual(signal?.kind, "credits-depleted");
    assert.strictEqual(signal?.detail, "overageDisabledReason=out_of_credits");
  });

  it("keeps other overageDisabledReason values as usage-limit", () => {
    const signal = classifyClaudeRateLimitInfo(
      rejected({ overageDisabledReason: "org_level_disabled" }),
      DETECTED_AT,
    );
    assert.strictEqual(signal?.kind, "usage-limit");
  });
});

describe("classifyCodexRateLimits", () => {
  const snapshot = (overrides: CodexRateLimitSnapshot): CodexRateLimitSnapshot => overrides;

  it("returns null when nothing is reached", () => {
    assert.isNull(
      classifyCodexRateLimits(
        snapshot({ primary: { usedPercent: 40, resetsAt: RESET_EPOCH_SECONDS } }),
        DETECTED_AT,
        "codex.app_server.read",
      ),
    );
    assert.isNull(
      classifyCodexRateLimits(
        snapshot({ spendControlReached: false }),
        DETECTED_AT,
        "codex.app_server.read",
      ),
    );
  });

  it("maps every rateLimitReachedType onto its kind", () => {
    const cases = [
      ["rate_limit_reached", "usage-limit"],
      ["workspace_owner_usage_limit_reached", "usage-limit"],
      ["workspace_member_usage_limit_reached", "usage-limit"],
      ["workspace_owner_credits_depleted", "credits-depleted"],
      ["workspace_member_credits_depleted", "credits-depleted"],
    ] as const;
    for (const [reached, kind] of cases) {
      const signal = classifyCodexRateLimits(
        snapshot({ rateLimitReachedType: reached }),
        DETECTED_AT,
        "codex.app_server.read",
      );
      assert.strictEqual(signal?.kind, kind, reached);
      assert.strictEqual(signal?.detail, `rateLimitReachedType=${reached}`);
    }
  });

  it("classifies spendControlReached true as spend-limit", () => {
    const signal = classifyCodexRateLimits(
      snapshot({ spendControlReached: true }),
      DETECTED_AT,
      "codex.app_server.notification",
    );
    assert.strictEqual(signal?.kind, "spend-limit");
    assert.strictEqual(signal?.source, "codex.app_server.notification");
    assert.strictEqual(signal?.detail, "spendControlReached=true");
  });

  it("takes the exact reset from the more-used window", () => {
    const signal = classifyCodexRateLimits(
      snapshot({
        rateLimitReachedType: "rate_limit_reached",
        primary: { usedPercent: 50, resetsAt: RESET_EPOCH_SECONDS + 600 },
        secondary: { usedPercent: 100, resetsAt: RESET_EPOCH_SECONDS },
      }),
      DETECTED_AT,
      "codex.app_server.read",
    );
    assert.strictEqual(signal?.resetsAt, RESET_ISO);
    assert.strictEqual(signal?.resetsAtEstimated, false);
  });

  it("estimates the reset from windowDurationMins when the window has no resetsAt", () => {
    const signal = classifyCodexRateLimits(
      snapshot({
        rateLimitReachedType: "workspace_owner_usage_limit_reached",
        primary: { usedPercent: 100, resetsAt: null, windowDurationMins: 300 },
      }),
      DETECTED_AT,
      "codex.app_server.read",
    );
    assert.strictEqual(signal?.resetsAt, "2026-08-14T15:00:00.000Z");
    assert.strictEqual(signal?.resetsAtEstimated, true);
  });

  it("reports no reset when the snapshot carries no window information", () => {
    const signal = classifyCodexRateLimits(
      snapshot({ rateLimitReachedType: "workspace_member_credits_depleted" }),
      DETECTED_AT,
      "codex.app_server.read",
    );
    assert.strictEqual(signal?.resetsAt, null);
    assert.strictEqual(signal?.resetsAtEstimated, false);
  });

  it("accepts both generated codex snapshot shapes", () => {
    const read: CodexSchema.V2GetAccountRateLimitsResponse["rateLimits"] = {
      rateLimitReachedType: "rate_limit_reached",
      primary: { usedPercent: 100, resetsAt: RESET_EPOCH_SECONDS },
    };
    const notification: CodexSchema.V2AccountRateLimitsUpdatedNotification__RateLimitSnapshot = {
      spendControlReached: true,
    };
    assert.strictEqual(
      classifyCodexRateLimits(read, DETECTED_AT, "codex.app_server.read")?.kind,
      "usage-limit",
    );
    assert.strictEqual(
      classifyCodexRateLimits(notification, DETECTED_AT, "codex.app_server.notification")?.kind,
      "spend-limit",
    );
  });

  it("prefers rateLimitReachedType over spendControlReached", () => {
    const signal = classifyCodexRateLimits(
      snapshot({ rateLimitReachedType: "rate_limit_reached", spendControlReached: true }),
      DETECTED_AT,
      "codex.app_server.read",
    );
    assert.strictEqual(signal?.kind, "usage-limit");
  });
});

describe("classifyOpenCodeMessageError", () => {
  const apiError = (data: Partial<ApiError["data"]>): ApiError => ({
    name: "APIError",
    data: { message: "provider request failed", isRetryable: true, ...data },
  });

  it("classifies a 429 with retry-after seconds as an estimated reset", () => {
    const signal = classifyOpenCodeMessageError(
      apiError({ statusCode: 429, responseHeaders: { "Retry-After": "120" } }),
      DETECTED_AT,
    );
    assert.deepStrictEqual(signal, {
      kind: "usage-limit",
      detectedAt: DETECTED_AT,
      resetsAt: "2026-08-14T10:02:00.000Z",
      resetsAtEstimated: true,
      source: "opencode.api_error",
      detail: "provider request failed",
    });
  });

  it("classifies a 429 with an http-date retry-after", () => {
    const signal = classifyOpenCodeMessageError(
      apiError({
        statusCode: 429,
        responseHeaders: { "retry-after": "Fri, 14 Aug 2026 11:00:00 GMT" },
      }),
      DETECTED_AT,
    );
    assert.strictEqual(signal?.resetsAt, "2026-08-14T11:00:00.000Z");
    assert.strictEqual(signal?.resetsAtEstimated, true);
  });

  it("classifies a 429 with a ratelimit reset header as delta seconds", () => {
    const signal = classifyOpenCodeMessageError(
      apiError({ statusCode: 429, responseHeaders: { "x-ratelimit-reset": "60" } }),
      DETECTED_AT,
    );
    assert.strictEqual(signal?.resetsAt, "2026-08-14T10:01:00.000Z");
    assert.strictEqual(signal?.resetsAtEstimated, true);
  });

  it("classifies a 429 with no headers as resetsAt null", () => {
    const signal = classifyOpenCodeMessageError(apiError({ statusCode: 429 }), DETECTED_AT);
    assert.deepStrictEqual(signal, {
      kind: "usage-limit",
      detectedAt: DETECTED_AT,
      resetsAt: null,
      resetsAtEstimated: false,
      source: "opencode.api_error",
      detail: "provider request failed",
    });
  });

  it("classifies ProviderAuthError as auth", () => {
    const error: ProviderAuthError = {
      name: "ProviderAuthError",
      data: { providerID: "anthropic", message: "token expired" },
    };
    assert.deepStrictEqual(classifyOpenCodeMessageError(error, DETECTED_AT), {
      kind: "auth",
      detectedAt: DETECTED_AT,
      resetsAt: null,
      resetsAtEstimated: false,
      source: "opencode.api_error",
      detail: "token expired",
    });
  });

  it("returns null for a 500 ApiError and for a missing status code", () => {
    assert.isNull(classifyOpenCodeMessageError(apiError({ statusCode: 500 }), DETECTED_AT));
    assert.isNull(classifyOpenCodeMessageError(apiError({}), DETECTED_AT));
  });

  it("returns null for a MessageAbortedError", () => {
    const error: MessageAbortedError = {
      name: "MessageAbortedError",
      data: { message: "request aborted" },
    };
    assert.isNull(classifyOpenCodeMessageError(error, DETECTED_AT));
  });
});

describe("classifyProviderErrorText", () => {
  it("maps every detectProviderError category onto a limit kind", () => {
    const cases = [
      ["You've hit your org's monthly spend limit.", "spend-limit"],
      ["API Error: 429 rate limit exceeded", "usage-limit"],
      ["Error: invalid API key. Please run /login.", "auth"],
      ["The provider is temporarily unavailable.", "unavailable"],
    ] as const;
    for (const [text, kind] of cases) {
      const signal = classifyProviderErrorText(text, DETECTED_AT);
      assert.strictEqual(signal?.kind, kind, text);
      assert.strictEqual(signal?.resetsAt, null);
      assert.strictEqual(signal?.resetsAtEstimated, false);
      assert.strictEqual(signal?.source, "assistant_text");
    }
  });

  it("carries the matched line as the detail excerpt", () => {
    const signal = classifyProviderErrorText(
      "some tool output\nClaude AI usage limit reached|1787207826\nmore text",
      DETECTED_AT,
    );
    assert.strictEqual(signal?.kind, "spend-limit");
    assert.strictEqual(signal?.detail, "Claude AI usage limit reached|1787207826");
  });

  it("returns null for ordinary prose", () => {
    assert.isNull(classifyProviderErrorText("The tests pass and the work is done.", DETECTED_AT));
  });
});
