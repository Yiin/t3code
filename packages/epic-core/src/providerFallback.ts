import {
  DEFAULT_MODEL_BY_PROVIDER,
  ProviderDriverKind,
  type EpicRoleId,
  type EpicRolePolicy,
  type ModelSelection,
  type ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";

const PRIME_DRIVER = ProviderDriverKind.make("primeAgent");
const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");
const CODEX_DRIVER = ProviderDriverKind.make("codex");
const KIMI_DRIVER = ProviderDriverKind.make("kimi");

const CLAUDE_MODEL = DEFAULT_MODEL_BY_PROVIDER[CLAUDE_DRIVER] ?? "claude-sonnet-5";
const CODEX_MODEL = DEFAULT_MODEL_BY_PROVIDER[CODEX_DRIVER] ?? "gpt-5.6-sol";
const KIMI_MODEL = DEFAULT_MODEL_BY_PROVIDER[KIMI_DRIVER] ?? "kimi-code/k3";

const FALLBACK_STAGES: ReadonlyArray<{
  readonly driver: ProviderDriverKind;
  readonly model: string;
  readonly options?: ModelSelection["options"];
}> = [
  // Prime is source-only. Its placeholder model is never selected as a target.
  { driver: PRIME_DRIVER, model: "" },
  { driver: CLAUDE_DRIVER, model: CLAUDE_MODEL },
  {
    driver: CODEX_DRIVER,
    model: CODEX_MODEL,
    options: [{ id: "reasoningEffort", value: "high" }],
  },
  { driver: KIMI_DRIVER, model: KIMI_MODEL },
];

const isEligible = (provider: ServerProvider, model: string): boolean =>
  provider.enabled &&
  provider.installed &&
  provider.availability !== "unavailable" &&
  provider.status === "ready" &&
  provider.auth.status !== "unauthenticated" &&
  provider.models.some((candidate) => candidate.slug === model);

export interface EpicFallbackHop {
  readonly instanceId: ProviderInstanceId;
  readonly model: string;
  readonly options?: ModelSelection["options"];
}

/**
 * The hop chain a runner role points at, or an empty chain.
 *
 * A role with no tier, or one naming a tier that no longer exists, has no
 * policy at all: the caller then keeps driver-order fallback, so an
 * unconfigured server behaves exactly as it did before tiers existed.
 */
export const epicRoleFallbackChain = (
  policy: EpicRolePolicy,
  roleId: EpicRoleId,
): ReadonlyArray<EpicFallbackHop> => {
  const tierId = policy.roles[roleId];
  if (tierId === undefined) return [];
  return policy.tiers[tierId]?.hops.map((hop) => hop.selection) ?? [];
};

/** The first candidate whose provider can run its model right now. */
const firstEligibleHop = (input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly candidates: ReadonlyArray<EpicFallbackHop>;
  readonly skip?: (hop: EpicFallbackHop) => boolean;
  readonly isBlocked?: (hop: EpicFallbackHop) => boolean;
}): ModelSelection | null => {
  for (const hop of input.candidates) {
    if (input.skip?.(hop) === true) {
      continue;
    }

    const provider = input.providers.find((candidate) => candidate.instanceId === hop.instanceId);
    if (
      provider === undefined ||
      !isEligible(provider, hop.model) ||
      input.isBlocked?.(hop) === true
    ) {
      continue;
    }

    return {
      instanceId: hop.instanceId,
      model: hop.model,
      ...(hop.options === undefined ? {} : { options: hop.options }),
    };
  }

  return null;
};

/**
 * Enter a chain: the first hop that can run, walking from the head.
 *
 * Fallback enters a chain after a failure and therefore starts past the hop
 * that failed. A caller with no failure behind it — one picking a role's model
 * for a fresh dispatch — wants the head of the same chain instead, under the
 * same eligibility rules.
 */
export const resolveEpicProviderChainEntry = (input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly chain: ReadonlyArray<EpicFallbackHop>;
  readonly isBlocked?: (hop: EpicFallbackHop) => boolean;
}): ModelSelection | null =>
  firstEligibleHop({
    providers: input.providers,
    candidates: input.chain,
    ...(input.isBlocked === undefined ? {} : { isBlocked: input.isBlocked }),
  });

export const resolveEpicProviderChainFallback = (input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly chain: ReadonlyArray<EpicFallbackHop>;
  readonly current: ModelSelection;
  readonly failureReason: string | undefined;
  readonly providerFallbackEligible: boolean;
  readonly isBlocked?: (hop: EpicFallbackHop) => boolean;
}): ModelSelection | null => {
  if (!input.providerFallbackEligible || !input.failureReason?.startsWith("provider-error")) {
    return null;
  }

  const currentIndex = input.chain.findIndex((hop) => hop.instanceId === input.current.instanceId);
  const candidates = currentIndex === -1 ? input.chain : input.chain.slice(currentIndex + 1);

  return firstEligibleHop({
    providers: input.providers,
    candidates,
    skip: (hop) => hop.instanceId === input.current.instanceId,
    ...(input.isBlocked === undefined ? {} : { isBlocked: input.isBlocked }),
  });
};

/**
 * Resolve the next configured provider after a provider-attributed failure.
 * Instance ids are routing keys. Driver order only controls forward fallback.
 */
export const resolveEpicProviderFallback = (input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly current: ModelSelection;
  readonly failureReason: string | undefined;
  readonly providerFallbackEligible: boolean;
}): ModelSelection | null => {
  if (!input.providerFallbackEligible || !input.failureReason?.startsWith("provider-error")) {
    return null;
  }

  const currentProvider = input.providers.find(
    (provider) => provider.instanceId === input.current.instanceId,
  );
  if (currentProvider === undefined) {
    return null;
  }

  const currentStage = FALLBACK_STAGES.findIndex(
    (stage) => stage.driver === currentProvider.driver,
  );
  if (currentStage === -1) {
    return null;
  }

  for (const stage of FALLBACK_STAGES.slice(currentStage + 1)) {
    const provider = input.providers.find(
      (candidate) => candidate.driver === stage.driver && isEligible(candidate, stage.model),
    );
    if (provider !== undefined) {
      return {
        instanceId: provider.instanceId,
        model: stage.model,
        ...(stage.options === undefined ? {} : { options: stage.options }),
      };
    }
  }

  return null;
};
