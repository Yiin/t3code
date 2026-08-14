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
const OPENCODE_DRIVER = ProviderDriverKind.make("opencode");

const CLAUDE_MODEL = DEFAULT_MODEL_BY_PROVIDER[CLAUDE_DRIVER] ?? "claude-sonnet-5";
const CODEX_MODEL = DEFAULT_MODEL_BY_PROVIDER[CODEX_DRIVER] ?? "gpt-5.6-sol";
const KIMI_MODEL = DEFAULT_MODEL_BY_PROVIDER[KIMI_DRIVER] ?? "kimi-code/k3";
const OPENCODE_MODEL = DEFAULT_MODEL_BY_PROVIDER[OPENCODE_DRIVER] ?? "openai/gpt-5";

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
  { driver: OPENCODE_DRIVER, model: OPENCODE_MODEL },
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
  readonly skipAboveUtilization?: number;
  /** Missing means enabled for callers that build hops without a tier. */
  readonly expandSameDriverAccounts?: boolean;
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
  const tier = policy.tiers[tierId];
  return (
    tier?.hops.map((hop) => ({
      ...hop.selection,
      ...(hop.skipAboveUtilization === undefined
        ? {}
        : { skipAboveUtilization: hop.skipAboveUtilization }),
      expandSameDriverAccounts: tier.expandSameDriverAccounts,
    })) ?? []
  );
};

/**
 * Expand a configured chain into its ordered account boundary.
 *
 * An authored hop always keeps a position, even when its provider snapshot is
 * missing. A present anchor can add same-driver accounts in inventory order,
 * but only when they advertise that hop's exact model. Instance ids keep their
 * first position across the full expansion.
 */
export const expandEpicFallbackCandidates = (input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly chain: ReadonlyArray<EpicFallbackHop>;
}): ReadonlyArray<EpicFallbackHop> => {
  const providerByInstance = new Map(
    input.providers.map((provider) => [provider.instanceId, provider] as const),
  );
  const expanded: EpicFallbackHop[] = [];
  const visited = new Set<ProviderInstanceId>();
  const append = (hop: EpicFallbackHop) => {
    if (visited.has(hop.instanceId)) return;
    visited.add(hop.instanceId);
    expanded.push(hop);
  };

  for (const hop of input.chain) {
    append(hop);
    const anchor = providerByInstance.get(hop.instanceId);
    if (anchor === undefined || hop.expandSameDriverAccounts === false) continue;
    for (const provider of input.providers) {
      if (
        provider.driver === anchor.driver &&
        provider.models.some((candidate) => candidate.slug === hop.model)
      ) {
        append({ ...hop, instanceId: provider.instanceId });
      }
    }
  }

  return expanded;
};

/** Instance ids whose degradation state can affect this chain. */
export const epicFallbackCandidateInstanceIds = (input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly chain: ReadonlyArray<EpicFallbackHop>;
}): ReadonlyArray<ProviderInstanceId> =>
  expandEpicFallbackCandidates(input).map((hop) => hop.instanceId);

/** The first candidate whose provider can run its model right now. */
const firstEligibleHop = (input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly candidates: ReadonlyArray<EpicFallbackHop>;
  readonly startAfter?: ProviderInstanceId;
  readonly skip?: (hop: EpicFallbackHop) => boolean;
  readonly isBlocked?: (hop: EpicFallbackHop) => boolean;
}): ModelSelection | null => {
  const expanded = expandEpicFallbackCandidates({
    providers: input.providers,
    chain: input.candidates,
  });
  const providerByInstance = new Map(
    input.providers.map((provider) => [provider.instanceId, provider] as const),
  );

  const currentIndex =
    input.startAfter === undefined
      ? -1
      : expanded.findIndex((hop) => hop.instanceId === input.startAfter);
  for (const hop of expanded.slice(currentIndex + 1)) {
    const provider = providerByInstance.get(hop.instanceId);
    if (provider === undefined || !isEligible(provider, hop.model)) {
      continue;
    }

    if (input.skip?.(hop) === true) {
      continue;
    }

    if (input.isBlocked?.(hop) === true) {
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

  return firstEligibleHop({
    providers: input.providers,
    candidates: input.chain,
    startAfter: input.current.instanceId,
    skip: (hop) => hop.instanceId === input.current.instanceId,
    ...(input.isBlocked === undefined ? {} : { isBlocked: input.isBlocked }),
  });
};

/**
 * Rotate to the next sibling account of the same driver, or null.
 *
 * The walk starts after the current instance in provider-list order and
 * wraps. A sibling keeps the current selection's model when it advertises
 * the same slug, falls to the driver's stage model otherwise, and is
 * skipped when it advertises neither. Prime is never a target, and an
 * unknown current instance rotates nowhere. The walk never leaves the
 * current driver: interactive threads use it alone, because a different
 * harness cannot continue their conversation.
 */
export const resolveSameDriverSiblingRotation = (input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly current: ModelSelection;
  readonly isBlocked?: (instanceId: ProviderInstanceId) => boolean;
}): ModelSelection | null => {
  const currentIndex = input.providers.findIndex(
    (provider) => provider.instanceId === input.current.instanceId,
  );
  const currentProvider = currentIndex === -1 ? undefined : input.providers[currentIndex];
  if (currentProvider === undefined || currentProvider.driver === PRIME_DRIVER) {
    return null;
  }

  const isBlocked = input.isBlocked ?? (() => false);
  const currentStage = FALLBACK_STAGES.find((stage) => stage.driver === currentProvider.driver);
  const rotated = [
    ...input.providers.slice(currentIndex + 1),
    ...input.providers.slice(0, currentIndex),
  ];
  for (const sibling of rotated) {
    if (sibling.driver !== currentProvider.driver || isBlocked(sibling.instanceId)) {
      continue;
    }
    if (isEligible(sibling, input.current.model)) {
      return {
        instanceId: sibling.instanceId,
        model: input.current.model,
        ...(input.current.options === undefined ? {} : { options: input.current.options }),
      };
    }
    if (currentStage !== undefined && isEligible(sibling, currentStage.model)) {
      return {
        instanceId: sibling.instanceId,
        model: currentStage.model,
        ...(currentStage.options === undefined ? {} : { options: currentStage.options }),
      };
    }
  }

  return null;
};

/**
 * Resolve the next configured provider after a provider-attributed failure.
 * Instance ids are routing keys. Driver order only controls forward fallback.
 *
 * The failing harness's other accounts come first: the walk rotates through
 * the current driver's sibling instances in settings-author order, starting
 * after the failing instance and wrapping, before it advances a stage. A
 * sibling keeps the failing selection's model when it advertises the same
 * slug, falls to the driver's stage model otherwise, and is skipped when it
 * advertises neither. A driver outside the stage table (cursor, grok, forks)
 * — and opencode, the table's tail — rotates siblings and then enters the
 * stage walk at the head. Prime is never a target.
 */
export const resolveEpicProviderFallback = (input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly current: ModelSelection;
  readonly failureReason: string | undefined;
  readonly providerFallbackEligible: boolean;
  readonly isBlocked?: (instanceId: ProviderInstanceId) => boolean;
}): ModelSelection | null => {
  if (!input.providerFallbackEligible || !input.failureReason?.startsWith("provider-error")) {
    return null;
  }

  const currentIndex = input.providers.findIndex(
    (provider) => provider.instanceId === input.current.instanceId,
  );
  const currentProvider = currentIndex === -1 ? undefined : input.providers[currentIndex];
  if (currentProvider === undefined) {
    return null;
  }

  const isBlocked = input.isBlocked ?? (() => false);
  const currentStageIndex = FALLBACK_STAGES.findIndex(
    (stage) => stage.driver === currentProvider.driver,
  );

  const rotatedSibling = resolveSameDriverSiblingRotation({
    providers: input.providers,
    current: input.current,
    isBlocked,
  });
  if (rotatedSibling !== null) {
    return rotatedSibling;
  }

  const stages =
    currentStageIndex === -1 || currentProvider.driver === OPENCODE_DRIVER
      ? FALLBACK_STAGES
      : FALLBACK_STAGES.slice(currentStageIndex + 1);
  for (const stage of stages) {
    if (stage.driver === PRIME_DRIVER) {
      continue;
    }
    const provider = input.providers.find(
      (candidate) =>
        candidate.driver === stage.driver &&
        candidate.instanceId !== input.current.instanceId &&
        isEligible(candidate, stage.model) &&
        !isBlocked(candidate.instanceId),
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
