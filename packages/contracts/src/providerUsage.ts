import * as Schema from "effect/Schema";

import { IsoDateTime } from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

export const ProviderUsageWindow = Schema.Literals([
  "five_hour",
  "seven_day",
  "seven_day_opus",
  "seven_day_sonnet",
  "overage",
  "primary",
  "secondary",
]);
export type ProviderUsageWindow = typeof ProviderUsageWindow.Type;

export const ProviderUsageSource = Schema.Literals([
  "claude.sdk.get_usage",
  "claude.sdk.rate_limit_event",
  "codex.app_server.read",
  "codex.app_server.notification",
]);
export type ProviderUsageSource = typeof ProviderUsageSource.Type;

export const ProviderUsageSample = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  window: ProviderUsageWindow,
  utilization: Schema.Number,
  resetsAt: Schema.NullOr(IsoDateTime),
  source: ProviderUsageSource,
  observedAt: IsoDateTime,
});
export type ProviderUsageSample = typeof ProviderUsageSample.Type;

export const ProviderUsageReading = Schema.Struct({
  window: ProviderUsageWindow,
  utilization: Schema.Number,
  resetsAt: Schema.NullOr(IsoDateTime),
  source: ProviderUsageSource,
});
export type ProviderUsageReading = typeof ProviderUsageReading.Type;

/**
 * What kind of block the harness reported. A utilization percentage is not
 * this fact: Claude allows overage past 100 percent and Codex reports
 * rateLimitReachedType independently of usedPercent.
 *
 * - `usage-limit`: rotation to a sibling account is correct.
 * - `auth`: rotation is correct, but the account needs operator action.
 * - `spend-limit` / `credits-depleted`: can be org-wide, so a consumer may
 *   choose not to rotate within one org.
 * - `unavailable`: the harness could not serve the account at all.
 */
export const ProviderLimitKind = Schema.Literals([
  "usage-limit",
  "spend-limit",
  "credits-depleted",
  "auth",
  "unavailable",
]);
export type ProviderLimitKind = typeof ProviderLimitKind.Type;

export const ProviderLimitSource = Schema.Literals([
  "claude.sdk.rate_limit_event",
  "claude.sdk.get_usage",
  "claude.assistant_text",
  "codex.app_server.read",
  "codex.app_server.notification",
  "opencode.api_error",
  "acp.prompt_error",
  "assistant_text",
]);
export type ProviderLimitSource = typeof ProviderLimitSource.Type;

/**
 * The structured this-account-is-blocked fact every harness classifier
 * produces and every consumer (routing, settings UI, epic runner) reads.
 *
 * `resetsAt` null means the harness gave no reset time; the consumer applies
 * its own TTL and never invents a timestamp. `resetsAtEstimated` true means a
 * duration (windowDurationMins, retry-after) was turned into an absolute time.
 */
export const ProviderAccountLimit = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  driver: ProviderDriverKind,
  kind: ProviderLimitKind,
  detectedAt: IsoDateTime,
  resetsAt: Schema.NullOr(IsoDateTime),
  resetsAtEstimated: Schema.Boolean,
  source: ProviderLimitSource,
  detail: Schema.NullOr(Schema.String),
});
export type ProviderAccountLimit = typeof ProviderAccountLimit.Type;

/**
 * `ProviderAccountLimit` without the account identity, mirroring how
 * `ProviderUsageReading` relates to `ProviderUsageSample`. Classifiers return
 * the signal; the recorder stamps `providerInstanceId` and `driver`.
 */
export const ProviderAccountLimitSignal = Schema.Struct({
  kind: ProviderLimitKind,
  detectedAt: IsoDateTime,
  resetsAt: Schema.NullOr(IsoDateTime),
  resetsAtEstimated: Schema.Boolean,
  source: ProviderLimitSource,
  detail: Schema.NullOr(Schema.String),
});
export type ProviderAccountLimitSignal = typeof ProviderAccountLimitSignal.Type;
