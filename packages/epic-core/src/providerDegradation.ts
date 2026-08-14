/**
 * Durable provider health, and the selection walk that reads it.
 *
 * A degradation record outlives the run that wrote it, so a later run of the
 * same epic starts past an account that is still rate limited instead of
 * burning one iteration rediscovering it. Every caller shares
 * {@link resolveDegradationAwareSelection}: the server resolves it against the
 * SQLite store at launch, the terminal cook CLI against a workspace-scoped
 * file. Keeping the walk here keeps the two verdicts identical.
 */
import type {
  ModelSelection,
  ProviderInstanceId,
  ProviderUsageSample,
  ServerProvider,
} from "@t3tools/contracts";
import type * as Effect from "effect/Effect";

import {
  resolveEpicProviderChainFallback,
  resolveEpicProviderFallback,
  type EpicFallbackHop,
} from "./providerFallback.ts";

/** One instance's last provider-attributed failure. */
export interface ProviderDegradationRecord {
  readonly failureReason: string;
  /** ISO-8601, when the failure was recorded. */
  readonly degradedAt: string;
  /**
   * ISO-8601, when the provider said the exhausted window reopens. Optional
   * because a record written by an older build has no value, and `null`
   * because the harness may report no reset time even for a limit failure.
   */
  readonly resetsAt?: string | null | undefined;
}

/**
 * Whether a record still counts, given `cutoff` = now minus the TTL.
 *
 * A record carrying the provider's own reset time lives exactly until that
 * time: a five-hour window stays blocked past the TTL, and a short window
 * reopens before it. Only a record without one falls back to the TTL rule.
 * All sides are ISO-8601 in UTC, so a string compare is a time compare.
 */
export const isLiveProviderDegradation = (
  record: ProviderDegradationRecord,
  cutoff: string,
  now: string,
): boolean => (record.resetsAt != null ? record.resetsAt > now : record.degradedAt > cutoff);

/**
 * Fail-soft read of the recorded usage windows, for stamping a degradation
 * with the provider's own reset time. Never fails: an unreadable ledger must
 * cost the record its reset time, not the run its fallback.
 */
export interface ProviderUsageReadShape {
  readonly listUsageSamples: Effect.Effect<ReadonlyArray<ProviderUsageSample>>;
}

/** Failures that heal on a clock. Auth and unavailable do not. */
const RESET_ELIGIBLE_FAILURES: ReadonlySet<string> = new Set([
  "provider-error:spend-limit",
  "provider-error:rate-limit",
]);

/**
 * The reset time to persist on a degradation record, or `null` for the TTL.
 *
 * Only a limit failure gets one, because only a limit heals on a clock. The
 * window that decides is the failing instance's worst live one — the same
 * rule `maxLiveUtilizationByInstance` applies — and a worst window without a
 * reset time means the TTL, never an invented timestamp.
 */
export const providerDegradationResetsAt = (input: {
  readonly failureReason: string;
  readonly samples: ReadonlyArray<ProviderUsageSample>;
  readonly providerInstanceId: ProviderInstanceId;
  readonly now: string;
}): string | null => {
  if (!RESET_ELIGIBLE_FAILURES.has(input.failureReason)) return null;
  let worst: ProviderUsageSample | null = null;
  for (const sample of input.samples) {
    if (sample.providerInstanceId !== input.providerInstanceId) continue;
    if (sample.resetsAt !== null && sample.resetsAt <= input.now) continue;
    if (worst === null || sample.utilization > worst.utilization) worst = sample;
  }
  return worst?.resetsAt ?? null;
};

/**
 * The hop reason recorded when usage or limit state, not a degradation
 * record, forced the reroute. A degraded instance keeps its own
 * `failureReason`; this only names the block that has no record behind it.
 */
export const USAGE_EXHAUSTED_REASON = "usage-exhausted";

/** One rerouting step, carrying the failure that caused it. */
export interface ProviderDegradationHop {
  readonly from: ModelSelection;
  readonly to: ModelSelection;
  readonly reason: string;
}

export interface DegradationAwareSelection {
  readonly selection: ModelSelection;
  /** Empty when `current` was usable, so a caller can log only real reroutes. */
  readonly hops: ReadonlyArray<ProviderDegradationHop>;
}

/**
 * The selection to dispatch on, given which instances are known degraded.
 *
 * A healthy `current` always wins: the caller already resolved the most
 * specific signal there was. Otherwise the walk prefers the role's own chain
 * and falls back to driver order when the role has no chain. When every
 * candidate is degraded it still returns something, because a run has to
 * start; the deepest hop is the policy's own last resort and the one furthest
 * from the account that just failed.
 *
 * `isExhausted` merges live usage and limit state into the same walk: an
 * exhausted instance is skipped exactly like a degraded one, and an exhausted
 * `current` reroutes even without a degradation record. The last-resort rule
 * above is unchanged, so an exhaustion verdict can move the selection but
 * never turn it into nothing.
 */
export const resolveDegradationAwareSelection = (input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly chain: ReadonlyArray<EpicFallbackHop>;
  readonly current: ModelSelection;
  readonly degradationOf: (instanceId: ProviderInstanceId) => ProviderDegradationRecord | null;
  readonly isExhausted?: (instanceId: ProviderInstanceId) => boolean;
}): DegradationAwareSelection => {
  const isExhausted = input.isExhausted ?? (() => false);
  const degradation = input.degradationOf(input.current.instanceId);
  if (degradation === null && !isExhausted(input.current.instanceId)) {
    return { selection: input.current, hops: [] };
  }
  const currentReason = degradation?.failureReason ?? USAGE_EXHAUSTED_REASON;

  if (input.chain.length === 0) {
    const hops: ProviderDegradationHop[] = [];
    let selection = input.current;
    let reason = currentReason;
    while (true) {
      const next = resolveEpicProviderFallback({
        providers: input.providers,
        current: selection,
        failureReason: "provider-error",
        providerFallbackEligible: true,
      });
      if (next === null) break;
      hops.push({ from: selection, to: next, reason });
      selection = next;
      const nextDegradation = input.degradationOf(selection.instanceId);
      if (nextDegradation === null && !isExhausted(selection.instanceId)) break;
      reason = nextDegradation?.failureReason ?? USAGE_EXHAUSTED_REASON;
    }
    return { selection, hops };
  }

  const blocked = new Set<ProviderInstanceId>([input.current.instanceId]);
  for (const hop of input.chain) {
    if (input.degradationOf(hop.instanceId) !== null || isExhausted(hop.instanceId)) {
      blocked.add(hop.instanceId);
    }
  }

  const healthyHop = resolveEpicProviderChainFallback({
    providers: input.providers,
    chain: input.chain,
    current: input.current,
    failureReason: "provider-error",
    providerFallbackEligible: true,
    isBlocked: (hop) => blocked.has(hop.instanceId),
  });
  if (healthyHop !== null) {
    return {
      selection: healthyHop,
      hops: [{ from: input.current, to: healthyHop, reason: currentReason }],
    };
  }

  // Walking forward repeatedly reuses the walker's own eligibility rules. The
  // visited set bounds the walk, because a chain may name one instance twice
  // and the walker resolves an instance to its first position.
  let lastResort: ModelSelection | null = null;
  let cursor = input.current;
  const visited = new Set<ProviderInstanceId>([input.current.instanceId]);
  while (true) {
    const next = resolveEpicProviderChainFallback({
      providers: input.providers,
      chain: input.chain,
      current: cursor,
      failureReason: "provider-error",
      providerFallbackEligible: true,
    });
    if (next === null || visited.has(next.instanceId)) break;
    visited.add(next.instanceId);
    lastResort = next;
    cursor = next;
  }
  if (lastResort === null) return { selection: input.current, hops: [] };
  return {
    selection: lastResort,
    hops: [{ from: input.current, to: lastResort, reason: currentReason }],
  };
};
