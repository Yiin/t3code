import type { SDKRateLimitInfo } from "@anthropic-ai/claude-agent-sdk";
import type { ApiError, ProviderAuthError } from "@opencode-ai/sdk/v2";
import type { ProviderAccountLimitSignal, ProviderLimitKind } from "@t3tools/contracts";
import { detectProviderError } from "@t3tools/epic-core/ralphProtocol";
import type { V2GetAccountRateLimitsResponse__RateLimitReachedType } from "effect-codex-app-server/schema";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

/**
 * Per-harness classifiers turning structured harness signals into
 * `ProviderAccountLimitSignal`. Pure functions, no I/O: every classifier takes
 * an explicit `detectedAt` ISO string, so callers own the clock and tests own
 * time. `null` means "not a limit"; a returned signal never invents a reset
 * time the harness did not give (`resetsAtEstimated` marks the one exception:
 * a duration or retry-after turned into an absolute time).
 */

const MAX_LIMIT_DETAIL_LENGTH = 200;

const boundDetail = (value: string | null | undefined): string | null => {
  if (value === null || value === undefined) {
    return null;
  }
  const trimmed = value.trim().slice(0, MAX_LIMIT_DETAIL_LENGTH);
  return trimmed.length === 0 ? null : trimmed;
};

/**
 * Codex `resetsAt` is Unix **seconds**. The generated schema only says `int64`
 * (`schema.gen.ts:4197`), so the unit was read off a live ChatGPT Pro account
 * on 2026-08-13: `resetsAt: 1787207826` against a `1786603026` second-precision
 * clock, exactly the `windowDurationMins: 10080` (seven day) window ahead.
 * Claude's `SDKRateLimitInfo.resetsAt` epoch has the same ambiguity. The
 * converter stays defensive for both — below 1e11 is seconds, the rest is
 * milliseconds — and yields `null` for anything that is not a usable date.
 * Shared by `ClaudeProvider.ts` and `CodexProvider.ts`, which held identical
 * copies before this module existed.
 */
export function normalizeEpochResetsAt(value: string | number | null | undefined): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  const milliseconds = value < 1e11 ? value * 1_000 : value;
  return Option.match(DateTime.make(milliseconds), {
    onNone: () => null,
    onSome: DateTime.formatIso,
  });
}

const addMillisecondsToIso = (iso: string, milliseconds: number): string | null =>
  Option.match(DateTime.make(iso), {
    onNone: () => null,
    onSome: (base) =>
      Option.match(DateTime.make(DateTime.toEpochMillis(base) + milliseconds), {
        onNone: () => null,
        onSome: DateTime.formatIso,
      }),
  });

/**
 * A rejected `SDKRateLimitInfo` is the Claude harness saying "this account may
 * not send". `allowed` and `allowed_warning` are usage telemetry, not a block,
 * so they classify to `null` (the usage ledger already records them via
 * `mapClaudeRateLimitInfo`).
 */
export function classifyClaudeRateLimitInfo(
  info: SDKRateLimitInfo,
  detectedAt: string,
): ProviderAccountLimitSignal | null {
  if (info.status !== "rejected") {
    return null;
  }
  const detailParts: Array<string> = [];
  if (info.rateLimitType !== undefined) {
    detailParts.push(`rateLimitType=${info.rateLimitType}`);
  }
  if (info.overageDisabledReason !== undefined) {
    detailParts.push(`overageDisabledReason=${info.overageDisabledReason}`);
  }
  return {
    kind: info.overageDisabledReason === "out_of_credits" ? "credits-depleted" : "usage-limit",
    detectedAt,
    resetsAt: normalizeEpochResetsAt(info.resetsAt),
    resetsAtEstimated: false,
    source: "claude.sdk.rate_limit_event",
    detail: boundDetail(detailParts.join(" ")),
  };
}

/**
 * Structural view of the Codex rate-limit snapshot. The app-server read
 * response (`V2GetAccountRateLimitsResponse["rateLimits"]`) and the
 * `account/rateLimits/updated` notification carry the same fields under
 * distinct generated types, and both satisfy this shape.
 */
export interface CodexRateLimitWindow {
  readonly resetsAt?: number | null;
  readonly usedPercent: number;
  readonly windowDurationMins?: number | null;
}

export interface CodexRateLimitSnapshot {
  readonly primary?: CodexRateLimitWindow | null;
  readonly secondary?: CodexRateLimitWindow | null;
  readonly rateLimitReachedType?: V2GetAccountRateLimitsResponse__RateLimitReachedType | null;
  readonly spendControlReached?: boolean | null;
}

export type CodexLimitSource = "codex.app_server.read" | "codex.app_server.notification";

const CODEX_REACHED_KIND: Record<
  V2GetAccountRateLimitsResponse__RateLimitReachedType,
  ProviderLimitKind
> = {
  rate_limit_reached: "usage-limit",
  workspace_owner_usage_limit_reached: "usage-limit",
  workspace_member_usage_limit_reached: "usage-limit",
  workspace_owner_credits_depleted: "credits-depleted",
  workspace_member_credits_depleted: "credits-depleted",
};

const moreUsedCodexWindow = (
  snapshot: CodexRateLimitSnapshot,
): CodexRateLimitWindow | undefined => {
  const windows = [snapshot.primary, snapshot.secondary].filter(
    (window): window is CodexRateLimitWindow =>
      window != null &&
      typeof window.usedPercent === "number" &&
      Number.isFinite(window.usedPercent),
  );
  if (windows.length === 0) {
    return undefined;
  }
  return windows.reduce((worst, window) =>
    window.usedPercent > worst.usedPercent ? window : worst,
  );
};

/**
 * `rateLimitReachedType` wins over `spendControlReached` when both are set: the
 * reached type names the blocked meter, while the spend flag only says a spend
 * control exists somewhere above it. The reset comes from the more-used of the
 * primary/secondary windows — the meter closest to (or past) its cap.
 */
export function classifyCodexRateLimits(
  snapshot: CodexRateLimitSnapshot,
  detectedAt: string,
  source: CodexLimitSource,
): ProviderAccountLimitSignal | null {
  const reached = snapshot.rateLimitReachedType ?? null;
  const kind: ProviderLimitKind | null =
    reached !== null
      ? CODEX_REACHED_KIND[reached]
      : snapshot.spendControlReached === true
        ? "spend-limit"
        : null;
  if (kind === null) {
    return null;
  }

  const window = moreUsedCodexWindow(snapshot);
  const exactResetsAt = normalizeEpochResetsAt(window?.resetsAt);
  let resetsAt: string | null = exactResetsAt;
  let resetsAtEstimated = false;
  if (exactResetsAt === null) {
    const durationMins = window?.windowDurationMins;
    if (typeof durationMins === "number" && Number.isFinite(durationMins) && durationMins > 0) {
      resetsAt = addMillisecondsToIso(detectedAt, durationMins * 60_000);
      resetsAtEstimated = resetsAt !== null;
    }
  }

  return {
    kind,
    detectedAt,
    resetsAt,
    resetsAtEstimated,
    source,
    detail: boundDetail(
      reached !== null ? `rateLimitReachedType=${reached}` : "spendControlReached=true",
    ),
  };
}

const RATE_LIMIT_RESET_HEADER_PATTERN = /ratelimit[-_]?reset/i;

/**
 * A header-derived reset is always an estimate: retry-after and the
 * `*ratelimit*reset*` family describe the HTTP endpoint's throttle, not the
 * account's usage window. Values are delta seconds unless large enough to be
 * an epoch (>= 1e9 seconds is 2001-09-09), or an HTTP-date.
 */
const resetsAtFromHeaders = (
  headers: { readonly [key: string]: string } | undefined,
  detectedAt: string,
): string | null => {
  if (headers === undefined) {
    return null;
  }
  let resetValue: string | undefined;
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === "retry-after") {
      resetValue = value;
      break;
    }
    if (resetValue === undefined && RATE_LIMIT_RESET_HEADER_PATTERN.test(name)) {
      resetValue = value;
    }
  }
  if (resetValue === undefined) {
    return null;
  }
  const numeric = Number(resetValue.trim());
  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric >= 1e9
      ? normalizeEpochResetsAt(numeric)
      : addMillisecondsToIso(detectedAt, numeric * 1_000);
  }
  const parsed = Date.parse(resetValue);
  return Number.isFinite(parsed) ? normalizeEpochResetsAt(parsed) : null;
};

/**
 * OpenCode surfaces provider failures as message-info errors. Only a 429
 * `APIError` (usage limit) and a `ProviderAuthError` classify; every other
 * status is a request failure, not an account-level block.
 */
export function classifyOpenCodeMessageError(
  error: ApiError | ProviderAuthError,
  detectedAt: string,
): ProviderAccountLimitSignal | null {
  if (error.name === "ProviderAuthError") {
    return {
      kind: "auth",
      detectedAt,
      resetsAt: null,
      resetsAtEstimated: false,
      source: "opencode.api_error",
      detail: boundDetail(error.data.message),
    };
  }
  if (error.data.statusCode !== 429) {
    return null;
  }
  const resetsAt = resetsAtFromHeaders(error.data.responseHeaders, detectedAt);
  return {
    kind: "usage-limit",
    detectedAt,
    resetsAt,
    resetsAtEstimated: resetsAt !== null,
    source: "opencode.api_error",
    detail: boundDetail(error.data.message),
  };
}

const TEXT_CATEGORY_KIND: Record<
  NonNullable<ReturnType<typeof detectProviderError>>["category"],
  ProviderLimitKind
> = {
  "spend-limit": "spend-limit",
  "rate-limit": "usage-limit",
  auth: "auth",
  unavailable: "unavailable",
};

/**
 * Text fallback for harnesses (and paths) with no structured signal. Delegates
 * to `detectProviderError` — the curated pattern list in
 * `ralphProtocol.ts` stays the only one; this module adds no regexes. Text
 * never carries a reset time.
 */
export function classifyProviderErrorText(
  text: string,
  detectedAt: string,
): ProviderAccountLimitSignal | null {
  const match = detectProviderError(text);
  if (match === null) {
    return null;
  }
  return {
    kind: TEXT_CATEGORY_KIND[match.category],
    detectedAt,
    resetsAt: null,
    resetsAtEstimated: false,
    source: "assistant_text",
    detail: boundDetail(match.excerpt),
  };
}
