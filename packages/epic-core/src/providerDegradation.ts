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
import type { ModelSelection, ProviderInstanceId, ServerProvider } from "@t3tools/contracts";

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
}

/**
 * Whether a record still counts, given `cutoff` = now minus the TTL.
 *
 * Both sides are ISO-8601 in UTC, so a string compare is a time compare.
 */
export const isLiveProviderDegradation = (
  record: ProviderDegradationRecord,
  cutoff: string,
): boolean => record.degradedAt > cutoff;

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
 */
export const resolveDegradationAwareSelection = (input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly chain: ReadonlyArray<EpicFallbackHop>;
  readonly current: ModelSelection;
  readonly degradationOf: (instanceId: ProviderInstanceId) => ProviderDegradationRecord | null;
}): DegradationAwareSelection => {
  const degradation = input.degradationOf(input.current.instanceId);
  if (degradation === null) return { selection: input.current, hops: [] };

  if (input.chain.length === 0) {
    const hops: ProviderDegradationHop[] = [];
    let selection = input.current;
    let reason = degradation.failureReason;
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
      if (nextDegradation === null) break;
      reason = nextDegradation.failureReason;
    }
    return { selection, hops };
  }

  const blocked = new Set<ProviderInstanceId>([input.current.instanceId]);
  for (const hop of input.chain) {
    if (input.degradationOf(hop.instanceId) !== null) blocked.add(hop.instanceId);
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
      hops: [{ from: input.current, to: healthyHop, reason: degradation.failureReason }],
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
    hops: [{ from: input.current, to: lastResort, reason: degradation.failureReason }],
  };
};
