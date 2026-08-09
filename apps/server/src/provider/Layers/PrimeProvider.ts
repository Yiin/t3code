import {
  PRIME_AGENT_DRIVER_KIND,
  type ModelCapabilities,
  type PrimeSettings,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  buildSelectOptionDescriptor,
  buildServerProvider,
  extractAuthBoolean,
  isCommandMissingCause,
  parseGenericCliVersion,
  spawnAndCollect,
  type CommandResult,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import { findReservedPrimeLaunchArg } from "../prime/PrimeLaunchArgs.ts";
import {
  makePrimeRpcTransport,
  type PrimeRpcTransportError,
  type PrimeRpcTransportOptions,
  type PrimeRpcTransportShape,
} from "../prime/PrimeRpcTransport.ts";

const PRESENTATION = {
  displayName: "Prime Agent",
  badgeLabel: "Early Access",
  showInteractionModeToggle: true,
} as const;
const VERSION_TIMEOUT_MS = 4_000;
const RPC_TIMEOUT_MS = 15_000;
const PrimeModelMetadata = Schema.Struct({
  provider: Schema.String,
  id: Schema.String,
  name: Schema.optional(Schema.String),
  reasoning: Schema.optional(Schema.Boolean),
  thinkingLevelMap: Schema.optional(Schema.Record(Schema.String, Schema.NullOr(Schema.String))),
  input: Schema.optional(Schema.Array(Schema.String)),
  isCustom: Schema.optional(Schema.Boolean),
});
type PrimeModelMetadata = typeof PrimeModelMetadata.Type;
const decodePrimeModelMetadata = Schema.decodeUnknownEffect(PrimeModelMetadata);

export interface PrimeProviderOptions {
  readonly cwd?: string;
  readonly versionTimeoutMs?: number;
  readonly rpcTimeoutMs?: number;
  readonly versionProbe?: Effect.Effect<CommandResult, never>;
  readonly makeTransport?: (
    options: PrimeRpcTransportOptions,
  ) => Effect.Effect<
    PrimeRpcTransportShape,
    PrimeRpcTransportError,
    ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
  >;
}

function capabilitiesFromModel(model: PrimeModelMetadata): ModelCapabilities {
  const thinkingOptions = Object.entries(model.thinkingLevelMap ?? {})
    .filter(([value]) => isPrimeThinkingLevel(value))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([value, label]) => ({ value, label: label?.trim() || formatThinkingLevel(value) }));
  return createModelCapabilities({
    supportsImages: model.input?.some((input) => input.trim().toLowerCase() === "image") ?? false,
    optionDescriptors:
      model.reasoning === true && thinkingOptions.length > 0
        ? [
            buildSelectOptionDescriptor({
              id: "thinking",
              label: "Thinking",
              options: thinkingOptions,
            }),
          ]
        : [],
  });
}

function isPrimeThinkingLevel(value: string): boolean {
  return ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value);
}

function formatThinkingLevel(value: string): string {
  return value === "xhigh" ? "Extra High" : `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

function mapModels(
  models: ReadonlyArray<PrimeModelMetadata>,
  activeSlug: string | undefined,
): ReadonlyArray<ServerProviderModel> {
  const seen = new Set<string>();
  return [...models]
    .sort((left, right) =>
      `${left.provider}/${left.id}`.localeCompare(`${right.provider}/${right.id}`),
    )
    .flatMap((model) => {
      const provider = model.provider.trim();
      const id = model.id.trim();
      if (!provider || !id) return [];
      const slug = `${provider}/${id}`;
      if (seen.has(slug)) return [];
      seen.add(slug);
      return [
        {
          slug,
          name: model.name?.trim() || id,
          isCustom: model.isCustom ?? false,
          ...(slug === activeSlug ? { isDefault: true } : {}),
          capabilities: capabilitiesFromModel(model),
        } satisfies ServerProviderModel,
      ];
    });
}

export function buildInitialPrimeProviderSnapshot(
  settings: PrimeSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.map(DateTime.now, (now) =>
    buildServerProvider({
      driver: PRIME_AGENT_DRIVER_KIND,
      presentation: PRESENTATION,
      enabled: settings.enabled,
      checkedAt: DateTime.formatIso(now),
      models: [],
      probe: {
        installed: settings.enabled,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: settings.enabled
          ? "Checking Prime Agent availability..."
          : "Prime Agent is disabled in T3 Code settings.",
      },
    }),
  );
}

export const checkPrimeProviderStatus = Effect.fn("checkPrimeProviderStatus")(function* (
  settings: PrimeSettings,
  environment: NodeJS.ProcessEnv = process.env,
  options: PrimeProviderOptions = {},
) {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const snapshot = (
    probe: Parameters<typeof buildServerProvider>[0]["probe"],
    models: ReadonlyArray<ServerProviderModel> = [],
  ) =>
    buildServerProvider({
      driver: PRIME_AGENT_DRIVER_KIND,
      presentation: PRESENTATION,
      enabled: settings.enabled,
      checkedAt,
      models,
      probe,
    });
  if (!settings.enabled) {
    return snapshot({
      installed: false,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: "Prime Agent is disabled in T3 Code settings.",
    });
  }
  const reserved = findReservedPrimeLaunchArg(settings.launchArgs);
  if (reserved) {
    return snapshot({
      installed: true,
      version: null,
      status: "error",
      auth: { status: "unknown" },
      message: `Prime launch argument '${reserved}' is controlled by T3 Code.`,
    });
  }
  const command = settings.binaryPath || "prime-agent";
  const versionProbe =
    options.versionProbe ??
    Effect.gen(function* () {
      const spawn = yield* resolveSpawnCommand(command, ["--version"], { env: environment });
      return yield* spawnAndCollect(
        command,
        ChildProcess.make(spawn.command, spawn.args, { env: environment, shell: spawn.shell }),
      );
    });
  const versionResult = yield* versionProbe.pipe(
    Effect.timeoutOption(options.versionTimeoutMs ?? VERSION_TIMEOUT_MS),
    Effect.result,
  );
  if (Result.isFailure(versionResult)) {
    return snapshot({
      installed: !isCommandMissingCause(versionResult.failure),
      version: null,
      status: "error",
      auth: { status: "unknown" },
      message: isCommandMissingCause(versionResult.failure)
        ? "Prime Agent CLI is not installed or not on PATH."
        : "Failed to execute the Prime Agent version check.",
    });
  }
  if (Option.isNone(versionResult.success)) {
    return snapshot({
      installed: true,
      version: null,
      status: "error",
      auth: { status: "unknown" },
      message: "Prime Agent timed out while checking its version.",
    });
  }
  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    return snapshot({
      installed: true,
      version,
      status: "error",
      auth: { status: "unknown" },
      message: "Prime Agent is installed but its version check failed.",
    });
  }

  const rpcResult = yield* Effect.scoped(
    Effect.gen(function* () {
      const transportFactory: NonNullable<PrimeProviderOptions["makeTransport"]> =
        options.makeTransport ?? makePrimeRpcTransport;
      const transport = yield* transportFactory({
        binaryPath: command,
        cwd: options.cwd ?? process.cwd(),
        environment,
        launchArgs: [...settings.launchArgs, "--no-session"],
      });
      const [state, rawModels] = yield* Effect.all([
        transport.getState(),
        transport.getAvailableModels(),
      ]);
      const models = yield* Effect.forEach(rawModels, (model) => decodePrimeModelMetadata(model));
      return { state, models };
    }).pipe(Effect.timeoutOption(options.rpcTimeoutMs ?? RPC_TIMEOUT_MS)),
  ).pipe(Effect.result);
  if (Result.isFailure(rpcResult)) {
    return snapshot({
      installed: true,
      version,
      status: "error",
      auth: { status: "unknown" },
      message: "Prime Agent RPC returned invalid data.",
    });
  }
  if (Option.isNone(rpcResult.success)) {
    return snapshot({
      installed: true,
      version,
      status: "error",
      auth: { status: "unknown" },
      message: "Prime Agent RPC health check timed out.",
    });
  }
  const { state, models: metadata } = rpcResult.success.value;
  const activeSlug = state.model ? `${state.model.provider}/${state.model.id}` : undefined;
  const models = mapModels(metadata, activeSlug);
  const authenticated = extractAuthBoolean(state);
  if (authenticated === false) {
    return snapshot(
      {
        installed: true,
        version,
        status: "warning",
        auth: { status: "unauthenticated" },
        message: "Prime Agent is not authenticated.",
      },
      models,
    );
  }
  if (models.length === 0) {
    return snapshot({
      installed: true,
      version,
      status: "warning",
      auth: { status: authenticated === true ? "authenticated" : "unknown" },
      message: "Prime Agent returned no available models.",
    });
  }
  return snapshot(
    {
      installed: true,
      version,
      status: "ready",
      auth: { status: authenticated === true ? "authenticated" : "unknown" },
    },
    models,
  );
});
