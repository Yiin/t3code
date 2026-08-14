import type {
  EpicRolePolicy,
  ProviderAccountLimit,
  ProviderInstanceId,
  ProviderUsageSample,
} from "@t3tools/contracts";
import type { ProviderInventoryShape } from "@t3tools/epic-core/ports/ProviderInventory";
import {
  epicDispatchRoleId,
  type EpicDispatchRole,
  type ResolvedRoleFallbackChain,
  type ResolvedRoleSelection,
  type RoleSelectionShape,
} from "@t3tools/epic-core/ports/RoleSelection";
import {
  epicFallbackCandidateInstanceIds,
  epicRoleFallbackChain,
  expandEpicFallbackCandidates,
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
}): RoleSelectionShape => {
  const emptyChain = (): ResolvedRoleFallbackChain => ({
    chain: [],
    isBlocked: () => false,
    isInstanceBlocked: () => false,
  });
  const readRoleState = (role: EpicDispatchRole, degradationScope: "chain" | "all") =>
    Effect.gen(function* () {
      const checkedAt = yield* DateTime.now;
      const now = DateTime.formatIso(checkedAt);
      const cutoff = DateTime.formatIso(
        DateTime.subtractDuration(checkedAt, Duration.millis(input.providerDegradationTtlMs)),
      );
      const policy = yield* input.readEpicRolePolicy;
      const providers = yield* input.inventory.getProviders;
      const usageSamples = yield* input.readUsageSamples;
      const accountLimits = yield* input.readAccountLimits;
      const roleId = epicDispatchRoleId(role);
      const tierId = policy.roles[roleId];
      const chain = epicRoleFallbackChain(policy, roleId);

      const degradations = new Map<ProviderInstanceId, ProviderDegradationRecord>();
      const degradationInstanceIds =
        degradationScope === "all"
          ? providers.map((provider) => provider.instanceId)
          : epicFallbackCandidateInstanceIds({ providers, chain });
      for (const instanceId of degradationInstanceIds) {
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
      const isBaseBlocked = (instanceId: ProviderInstanceId) =>
        degradations.has(instanceId) || exhaustion.isExhausted(instanceId);
      const isBlocked = (hop: (typeof chain)[number]) =>
        isBaseBlocked(hop.instanceId) ||
        (hop.skipAboveUtilization !== undefined &&
          exhaustion.utilizationOf(hop.instanceId) !== null &&
          exhaustion.utilizationOf(hop.instanceId)! > hop.skipAboveUtilization);
      const blockedChainInstances = new Set(
        expandEpicFallbackCandidates({ providers, chain })
          .filter(isBlocked)
          .map((hop) => hop.instanceId),
      );
      const isInstanceBlocked = (instanceId: ProviderInstanceId) =>
        isBaseBlocked(instanceId) || blockedChainInstances.has(instanceId);
      return { providers, tierId, chain, isBlocked, isInstanceBlocked };
    });

  return {
    chain: (role) =>
      readRoleState(role, "all").pipe(
        Effect.map(({ chain, isBlocked, isInstanceBlocked }) => ({
          chain,
          isBlocked,
          isInstanceBlocked,
        })),
        Effect.catchCause(() => Effect.succeed(emptyChain())),
      ),
    resolve: (request) => {
      const fallback = (): ResolvedRoleSelection => ({
        selection: request.fallbackSelection,
        tierId: null,
      });
      return readRoleState(request.role, "chain").pipe(
        Effect.map(({ providers, tierId, chain, isBlocked }) => {
          if (tierId === undefined) return fallback();
          if (chain.length === 0) return fallback();
          const selection = resolveEpicProviderChainEntry({
            providers,
            chain,
            isBlocked,
          });
          return selection === null ? fallback() : { selection, tierId };
        }),
        Effect.catchCause(() => Effect.succeed(fallback())),
      );
    },
  };
};
