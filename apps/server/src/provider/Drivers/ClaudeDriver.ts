/**
 * ClaudeDriver — `ProviderDriver` for the Claude Agent SDK runtime.
 *
 * Mirrors `CodexDriver`: a plain value whose `create()` returns one
 * `ProviderInstance` bundling `snapshot` / `adapter` / `textGeneration`
 * closures captured over the per-instance `ClaudeSettings`.
 *
 * Unlike Codex, the Claude snapshot probe may invoke a secondary probe
 * (`probeClaudeCapabilities`) to read Anthropic account + slash-command
 * metadata. That probe is per-instance and keyed by binary + resolved HOME so
 * two concurrent Claude instances don't cross-contaminate account metadata.
 *
 * @module provider/Drivers/ClaudeDriver
 */
import { ClaudeSettings, ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
import * as Cache from "effect/Cache";
import * as Duration from "effect/Duration";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";

import { readSpawnPolicyFrom } from "../../mcp/toolkits/agents/spawnPolicySource.ts";
import { makeClaudeTextGeneration } from "../../textGeneration/ClaudeTextGeneration.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ProviderAccountLimitsStore } from "../../persistence/Services/ProviderAccountLimits.ts";
import { ProviderUsageLedgerStore } from "../../persistence/Services/ProviderUsageLedger.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeClaudeAdapter } from "../Layers/ClaudeAdapter.ts";
import {
  checkClaudeProviderStatus,
  makePendingClaudeProvider,
  probeClaudeCapabilities,
} from "../Layers/ClaudeProvider.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  makePackageManagedProviderMaintenanceResolver,
  normalizeCommandPath,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "../providerMaintenance.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";
import {
  makeClaudeCapabilitiesCacheKey,
  makeClaudeLegacyContinuationKeys,
  materializeClaudeShadowHome,
  resolveClaudeHomeLayout,
} from "./ClaudeHome.ts";
const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);

const DRIVER_KIND = ProviderDriverKind.make("claudeAgent");
const SNAPSHOT_REFRESH_INTERVAL = Duration.minutes(5);
const CAPABILITIES_PROBE_TTL = Duration.minutes(5);

export const makeClaudeModelCatalogKey = (
  binaryPath: string,
  platform: NodeJS.Platform,
): string => {
  const trimmed = binaryPath.trim();
  const normalized = platform === "win32" ? trimmed.replaceAll("\\", "/").toLowerCase() : trimmed;
  return `${DRIVER_KIND}:executable:${normalized}`;
};

export const resolveClaudeModelCatalogKey = Effect.fn("resolveClaudeModelCatalogKey")(function* (
  binaryPath: string,
  environment: NodeJS.ProcessEnv,
) {
  const platform = yield* HostProcessPlatform;
  const resolveExecutable = yield* SpawnExecutableResolution;
  const resolvedPath = yield* Effect.try({
    try: () => resolveExecutable(binaryPath, platform, environment),
    catch: () => "resolution-failed" as const,
  }).pipe(Effect.orElseSucceed(() => undefined));
  return makeClaudeModelCatalogKey(resolvedPath ?? binaryPath, platform);
});

function isClaudeNativeCommandPath(commandPath: string): boolean {
  const normalized = normalizeCommandPath(commandPath);
  return (
    normalized.endsWith("/.local/bin/claude") ||
    normalized.endsWith("/.local/bin/claude.exe") ||
    normalized.includes("/.local/share/claude/")
  );
}

export const ClaudeProviderMaintenanceResolver = makePackageManagedProviderMaintenanceResolver({
  provider: DRIVER_KIND,
  miseToolName: "claude",
  npmPackageName: "@anthropic-ai/claude-code",
  homebrewFormula: "claude-code",
  nativeUpdate: {
    executable: "claude",
    args: ["update"],
    lockKey: "claude-native",
    isCommandPath: isClaudeNativeCommandPath,
  },
});

export type ClaudeDriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Path.Path
  | ProviderAccountLimitsStore
  | ProviderEventLoggers
  | ProviderUsageLedgerStore
  | ServerConfig
  | ServerSettingsService;

const withInstanceIdentity =
  (input: {
    readonly instanceId: ProviderInstance["instanceId"];
    readonly displayName: string | undefined;
    readonly accentColor: string | undefined;
    readonly continuationGroupKey: string;
  }) =>
  (snapshot: ServerProviderDraft): ServerProvider => ({
    ...snapshot,
    instanceId: input.instanceId,
    driver: DRIVER_KIND,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    continuation: { groupKey: input.continuationGroupKey },
  });

export const ClaudeDriver: ProviderDriver<ClaudeSettings, ClaudeDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Claude",
    supportsMultipleInstances: true,
  },
  configSchema: ClaudeSettings,
  defaultConfig: (): ClaudeSettings => decodeClaudeSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const path = yield* Path.Path;
      const { cwd } = yield* ServerConfig;
      const httpClient = yield* HttpClient.HttpClient;
      const serverSettings = yield* ServerSettingsService;
      const eventLoggers = yield* ProviderEventLoggers;
      const usageLedger = yield* ProviderUsageLedgerStore;
      const accountLimits = yield* ProviderAccountLimitsStore;
      const processEnv = mergeProviderInstanceEnvironment(environment);
      const fallbackContinuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const layout = yield* resolveClaudeHomeLayout(config).pipe(
        Effect.provideService(Path.Path, path),
      );
      yield* materializeClaudeShadowHome(layout).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to materialize Claude shadow home: ${String(cause)}`,
              cause,
            }),
        ),
      );
      const effectiveConfig = {
        ...config,
        enabled,
        homePath: layout.mode === "authOverlay" ? layout.effectiveHomePath! : config.homePath,
      } satisfies ClaudeSettings;
      const modelCatalogKey = yield* resolveClaudeModelCatalogKey(
        effectiveConfig.binaryPath,
        processEnv,
      );
      const maintenanceCapabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(
        ClaudeProviderMaintenanceResolver,
        {
          binaryPath: effectiveConfig.binaryPath,
          env: processEnv,
        },
      );
      const continuationGroupKey = layout.continuationKey;
      // Legacy keys derive from the ORIGINAL config: its homePath is the
      // shared home, which is the continuation key's basis. `effectiveConfig`
      // holds the shadow home in overlay mode and would name the wrong shared
      // key, so every legacy key would survive the equals-shared filter.
      const legacyContinuationKeys = yield* makeClaudeLegacyContinuationKeys({
        config,
        accountsDir: (yield* ServerConfig).accountsDir,
      });
      const stampIdentity = withInstanceIdentity({
        instanceId,
        displayName,
        accentColor,
        continuationGroupKey,
      });

      const adapterOptions = {
        instanceId,
        environment: processEnv,
        // The adapter reads this once per session, so a `subagentSpawn`
        // settings change reaches the next session without a restart.
        subagentSpawnPolicy: readSpawnPolicyFrom(serverSettings),
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
        recordUsageSamples: usageLedger.recordSamples,
        recordAccountLimit: accountLimits.recordLimit,
      };
      const adapter = yield* makeClaudeAdapter(effectiveConfig, adapterOptions);
      const textGeneration = yield* makeClaudeTextGeneration(effectiveConfig, processEnv);

      // Per-instance capabilities cache: keyed on binary + resolved HOME so
      // account-specific probes never share auth metadata across instances.
      const capabilitiesProbeCache = yield* Cache.make({
        capacity: 1,
        timeToLive: CAPABILITIES_PROBE_TTL,
        lookup: () =>
          probeClaudeCapabilities(effectiveConfig, processEnv, cwd).pipe(
            Effect.provideService(Path.Path, path),
          ),
      });
      const capabilitiesCacheKey = yield* makeClaudeCapabilitiesCacheKey(effectiveConfig, cwd);

      const checkProvider = checkClaudeProviderStatus(
        effectiveConfig,
        () => Cache.get(capabilitiesProbeCache, capabilitiesCacheKey),
        processEnv,
      ).pipe(
        Effect.map(stampIdentity),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(Path.Path, path),
      );

      const snapshotSettings = makeProviderSnapshotSettingsSource(effectiveConfig, serverSettings);
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<ClaudeSettings>>({
        maintenanceCapabilities,
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          makePendingClaudeProvider(settings.provider).pipe(Effect.map(stampIdentity)),
        checkProvider,
        enrichSnapshot: ({ settings, snapshot, publishSnapshot }) =>
          enrichProviderSnapshotWithVersionAdvisory(snapshot, maintenanceCapabilities, {
            enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
          }).pipe(
            Effect.provideService(HttpClient.HttpClient, httpClient),
            Effect.flatMap((enrichedSnapshot) => publishSnapshot(enrichedSnapshot)),
          ),
        refreshInterval: SNAPSHOT_REFRESH_INTERVAL,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build Claude snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        modelCatalogKey,
        continuationIdentity: {
          ...fallbackContinuationIdentity,
          continuationKey: continuationGroupKey,
          ...(legacyContinuationKeys.length > 0 ? { legacyContinuationKeys } : {}),
        },
        displayName,
        accentColor,
        enabled,
        snapshot,
        adapter,
        textGeneration,
        usage: {
          readUsage: Cache.get(capabilitiesProbeCache, capabilitiesCacheKey).pipe(
            Effect.map((capabilities) => capabilities?.usage ?? []),
          ),
        },
      } satisfies ProviderInstance;
    }),
};
