/**
 * Turn the epic role policy into the subagent definitions a worker session
 * carries.
 *
 * Planner, implementer and reviewer are not runner dispatches: the worker
 * spawns them itself, inside its own session. The runner therefore controls
 * them by injecting definitions rather than by routing a turn, and only the
 * model crosses over — a subagent always runs in its parent session's account,
 * so a hop's instance id decides *which* model string is live, never where the
 * subagent runs.
 */
import type {
  EpicRolePolicy,
  EpicSubagentDefinition,
  EpicSubagentMap,
  EpicTierId,
  ProviderInstanceId,
  ProviderUsageSample,
  ServerProvider,
} from "@t3tools/contracts";

import { resolveEpicProviderChainEntry, type EpicFallbackHop } from "./providerFallback.ts";

export interface EpicSubagentResolutionInput {
  readonly policy: EpicRolePolicy;
  /** Provider inventory, for the same eligibility rules fallback uses. */
  readonly providers: ReadonlyArray<ServerProvider>;
  /**
   * Highest live utilization percent for one account, or `null` when nothing
   * has been observed. An unknown utilization never skips a hop: the policy's
   * order is the intent, and a missing sample is not evidence against it.
   */
  readonly utilization?: (instanceId: ProviderInstanceId) => number | null;
  /**
   * The account the worker session itself runs on.
   *
   * A subagent cannot leave its parent session, so a hop is only usable when
   * its provider runs the same driver: a Codex model name means nothing to a
   * Claude session. An unknown instance skips the check, because guessing
   * wrong there would strip every model rather than the wrong ones.
   */
  readonly sessionInstanceId?: ProviderInstanceId;
}

/**
 * The worst utilization each account currently reports.
 *
 * A window whose `resetsAt` has passed is dropped: its quota is back and the
 * stored sample only says what the last poll saw. Windows are per-model and
 * per-account, and a hop names both, so the highest live window is the one
 * that decides whether that account can take work.
 */
export const maxLiveUtilizationByInstance = (
  samples: ReadonlyArray<ProviderUsageSample>,
  nowIso: string,
): ReadonlyMap<ProviderInstanceId, number> => {
  const worst = new Map<ProviderInstanceId, number>();
  for (const sample of samples) {
    if (sample.resetsAt !== null && sample.resetsAt <= nowIso) continue;
    const current = worst.get(sample.providerInstanceId);
    if (current === undefined || sample.utilization > current) {
      worst.set(sample.providerInstanceId, sample.utilization);
    }
  }
  return worst;
};

/**
 * Whether one account's observed utilization rules out new work.
 *
 * An unknown (`null`) utilization is never exhausted: a missing sample is not
 * evidence against an account, the same rule
 * {@link EpicSubagentResolutionInput.utilization} states for hop skipping.
 */
export const isAccountExhausted = (input: {
  readonly utilization: number | null;
  readonly threshold?: number;
}): boolean => input.utilization !== null && input.utilization >= (input.threshold ?? 100);

/**
 * The model a role's tier resolves to right now, or `null` when the role names
 * no tier, the tier is gone or empty, or no hop in it can run.
 */
const resolveRoleModel = (
  input: EpicSubagentResolutionInput,
  tierId: EpicTierId | undefined,
): string | null => {
  if (tierId === undefined) return null;
  const tier = input.policy.tiers[tierId];
  if (tier === undefined || tier.hops.length === 0) return null;

  const driverOf = (instanceId: ProviderInstanceId) =>
    input.providers.find((provider) => provider.instanceId === instanceId)?.driver;
  const sessionDriver =
    input.sessionInstanceId === undefined ? undefined : driverOf(input.sessionInstanceId);

  const chain: ReadonlyArray<EpicFallbackHop> = tier.hops.flatMap((hop) => {
    if (sessionDriver !== undefined && driverOf(hop.selection.instanceId) !== sessionDriver) {
      return [];
    }
    if (hop.skipAboveUtilization !== undefined) {
      const observed = input.utilization?.(hop.selection.instanceId) ?? null;
      if (observed !== null && observed > hop.skipAboveUtilization) return [];
    }
    return [hop.selection];
  });

  return resolveEpicProviderChainEntry({ providers: input.providers, chain })?.model ?? null;
};

/**
 * Build the subagent map for one worker session.
 *
 * Fail-soft on every axis: a role whose tier resolves to nothing still ships,
 * without a model, so the subagent inherits the session's. Losing a tier costs
 * a subagent its model, never its existence.
 */
export const resolveEpicSubagents = (input: EpicSubagentResolutionInput): EpicSubagentMap => {
  const subagents: Record<string, EpicSubagentDefinition> = {};

  for (const [name, role] of Object.entries(input.policy.inSessionRoles)) {
    const model = resolveRoleModel(input, role.tier);
    subagents[name] = {
      description: role.description,
      prompt: role.prompt,
      ...(model === null || model === "" ? {} : { model }),
      ...(role.tools === undefined ? {} : { tools: role.tools }),
    };
  }

  return subagents;
};
