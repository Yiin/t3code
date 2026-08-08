import {
  DEFAULT_MODEL_BY_PROVIDER,
  ProviderDriverKind,
  type ModelSelection,
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
