import { PRIME_AGENT_DRIVER_KIND, PrimeSettings, type ServerProvider } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";

import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makePrimeTextGeneration } from "../../textGeneration/PrimeTextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makePrimeAdapter } from "../Layers/PrimeAdapter.ts";
import {
  buildInitialPrimeProviderSnapshot,
  checkPrimeProviderStatus,
} from "../Layers/PrimeProvider.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";

const decodeSettings = Schema.decodeSync(PrimeSettings);
const REFRESH_INTERVAL = Duration.minutes(5);
const MAINTENANCE = makeManualOnlyProviderMaintenanceCapabilities({
  provider: PRIME_AGENT_DRIVER_KIND,
  packageName: null,
});

export type PrimeDriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | ServerConfig
  | ServerSettingsService;

const withIdentity =
  (input: {
    instanceId: ProviderInstance["instanceId"];
    displayName: string | undefined;
    accentColor: string | undefined;
    continuationGroupKey: string;
  }) =>
  (snapshot: ServerProviderDraft): ServerProvider => ({
    ...snapshot,
    instanceId: input.instanceId,
    driver: PRIME_AGENT_DRIVER_KIND,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    continuation: { groupKey: input.continuationGroupKey },
  });

export const PrimeDriver: ProviderDriver<PrimeSettings, PrimeDriverEnv> = {
  driverKind: PRIME_AGENT_DRIVER_KIND,
  metadata: { displayName: "Prime Agent", supportsMultipleInstances: true },
  configSchema: PrimeSettings,
  defaultConfig: () => decodeSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const serverSettings = yield* ServerSettingsService;
      const processEnv = mergeProviderInstanceEnvironment(environment);
      const effectiveConfig = { ...config, enabled } satisfies PrimeSettings;
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: PRIME_AGENT_DRIVER_KIND,
        instanceId,
      });
      const stamp = withIdentity({
        instanceId,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      const adapter = yield* makePrimeAdapter(effectiveConfig, {
        instanceId,
        environment: processEnv,
      });
      const textGeneration = yield* makePrimeTextGeneration(effectiveConfig, processEnv);
      const source = makeProviderSnapshotSettingsSource(effectiveConfig, serverSettings);
      const checkProvider = checkPrimeProviderStatus(effectiveConfig, processEnv).pipe(
        Effect.map(stamp),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<PrimeSettings>>({
        maintenanceCapabilities: MAINTENANCE,
        getSettings: source.getSettings,
        streamSettings: source.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          buildInitialPrimeProviderSnapshot(settings.provider).pipe(Effect.map(stamp)),
        checkProvider,
        refreshInterval: REFRESH_INTERVAL,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: PRIME_AGENT_DRIVER_KIND,
              instanceId,
              detail: `Failed to build Prime Agent snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );
      return {
        instanceId,
        driverKind: PRIME_AGENT_DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        adapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};
