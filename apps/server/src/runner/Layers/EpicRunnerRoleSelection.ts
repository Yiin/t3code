import type {
  EpicRolePolicy,
  ProviderAccountLimit,
  ProviderInstanceId,
  ProviderUsageSample,
} from "@t3tools/contracts";
import type { ProviderInventoryShape } from "@t3tools/epic-core/ports/ProviderInventory";
import {
  epicDispatchRoleId,
  type ResolvedRoleSelection,
  type RoleSelectionShape,
} from "@t3tools/epic-core/ports/RoleSelection";
import {
  epicRoleFallbackChain,
  resolveEpicProviderChainEntry,
} from "@t3tools/epic-core/providerFallback";
import {
  isLiveProviderDegradation,
  type ProviderDegradationRecord,
} from "@t3tools/epic-core/providerDegradation";
import { isAccountExhausted, maxLiveUtilizationByInstance } from "@t3tools/epic-core/epicSubagents";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { EpicRunStoreError } from "../../persistence/Errors.ts";

export interface ProviderAccountExhaustion {
  readonly utilizationOf: (instanceId: ProviderInstanceId) => number | null;
  readonly isExhausted: (instanceId: ProviderInstanceId) => boolean;
}

/** Build one immutable account-state view for a selection decision. */
export const providerAccountExhaustion = (input: {
  readonly usageSamples: ReadonlyArray<ProviderUsageSample>;
  readonly accountLimits: ReadonlyArray<ProviderAccountLimit>;
  readonly now: string;
  readonly cutoff: string;
}): ProviderAccountExhaustion => {
  const utilization = maxLiveUtilizationByInstance(input.usageSamples, input.now);
  const limitBlocked = new Set<ProviderInstanceId>();
  for (const limit of input.accountLimits) {
    if (limit.kind !== "usage-limit" && limit.kind !== "spend-limit") continue;
    if (
      isLiveProviderDegradation(
        {
          failureReason: limit.kind,
          degradedAt: limit.detectedAt,
          resetsAt: limit.resetsAt,
        },
        input.cutoff,
        input.now,
      )
    ) {
      limitBlocked.add(limit.providerInstanceId);
    }
  }
  return {
    utilizationOf: (instanceId) => utilization.get(instanceId) ?? null,
    isExhausted: (instanceId) =>
      isAccountExhausted({ utilization: utilization.get(instanceId) ?? null }) ||
      limitBlocked.has(instanceId),
  };
};

export const makeEpicRunnerRoleSelection = (input: {
  readonly readEpicRolePolicy: Effect.Effect<EpicRolePolicy, EpicRunStoreError>;
  readonly inventory: ProviderInventoryShape;
  readonly readProviderDegradation: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<Option.Option<ProviderDegradationRecord>, EpicRunStoreError>;
  readonly readUsageSamples: Effect.Effect<ReadonlyArray<ProviderUsageSample>, EpicRunStoreError>;
  readonly readAccountLimits: Effect.Effect<ReadonlyArray<ProviderAccountLimit>, EpicRunStoreError>;
  readonly providerDegradationTtlMs: number;
}): RoleSelectionShape => ({
  resolve: (request) => {
    const fallback = (): ResolvedRoleSelection => ({
      selection: request.fallbackSelection,
      tierId: null,
    });
    return Effect.gen(function* () {
      const checkedAt = yield* DateTime.now;
      const now = DateTime.formatIso(checkedAt);
      const cutoff = DateTime.formatIso(
        DateTime.subtractDuration(checkedAt, Duration.millis(input.providerDegradationTtlMs)),
      );
      const policy = yield* input.readEpicRolePolicy;
      const providers = yield* input.inventory.getProviders;
      const usageSamples = yield* input.readUsageSamples;
      const accountLimits = yield* input.readAccountLimits;
      const roleId = epicDispatchRoleId(request.role);
      const tierId = policy.roles[roleId];
      if (tierId === undefined) return fallback();
      const chain = epicRoleFallbackChain(policy, roleId);
      if (chain.length === 0) return fallback();

      const degradations = new Map<ProviderInstanceId, ProviderDegradationRecord>();
      for (const instanceId of new Set(chain.map((hop) => hop.instanceId))) {
        const raw = yield* input.readProviderDegradation(instanceId);
        // Launch owns expired-row cleanup. Dispatch selection stays read-only,
        // but applies the same liveness predicate, so both paths make the same
        // routing decision even when an expired row remains stored.
        if (Option.isSome(raw) && isLiveProviderDegradation(raw.value, cutoff, now)) {
          degradations.set(instanceId, raw.value);
        }
      }
      const exhaustion = providerAccountExhaustion({
        usageSamples,
        accountLimits,
        now,
        cutoff,
      });
      const selection = resolveEpicProviderChainEntry({
        providers,
        chain,
        isBlocked: (hop) =>
          degradations.has(hop.instanceId) ||
          exhaustion.isExhausted(hop.instanceId) ||
          (hop.skipAboveUtilization !== undefined &&
            exhaustion.utilizationOf(hop.instanceId) !== null &&
            exhaustion.utilizationOf(hop.instanceId)! > hop.skipAboveUtilization),
      });
      return selection === null ? fallback() : { selection, tierId };
    }).pipe(Effect.catchCause(() => Effect.succeed(fallback())));
  },
});
