import * as Schema from "effect/Schema";

import { IsoDateTime } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

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
