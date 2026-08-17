/** Test helper for constructing a `ProviderInstanceRegistryShape` fixture. */
import {
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import type { ProviderInstance } from "../ProviderDriver.ts";
import type { ProviderInstanceRegistryShape } from "../Services/ProviderInstanceRegistry.ts";

export type KindAdapterMap = Partial<
  Record<ProviderDriverKind, ProviderAdapterShape<ProviderAdapterError>>
>;

export interface AdapterRegistryInstanceOverrides {
  readonly enabled?: boolean;
  readonly continuationKey?: string;
  readonly legacyContinuationKeys?: ReadonlyArray<string>;
}

export const makeMockProviderInstance = (
  instanceId: ProviderInstanceId,
  adapter: ProviderAdapterShape<ProviderAdapterError>,
  overrides: AdapterRegistryInstanceOverrides = {},
): ProviderInstance => {
  const driverKind = ProviderDriverKind.make(adapter.provider);
  return {
    instanceId,
    driverKind,
    displayName: undefined,
    enabled: overrides.enabled ?? true,
    continuationIdentity: {
      driverKind,
      continuationKey: overrides.continuationKey ?? `${adapter.provider}:instance:${instanceId}`,
      ...(overrides.legacyContinuationKeys !== undefined
        ? { legacyContinuationKeys: overrides.legacyContinuationKeys }
        : {}),
    },
    snapshot: undefined as never,
    adapter,
    textGeneration: undefined as never,
  };
};

export const makeAdapterRegistryMock = (
  adapters: KindAdapterMap,
  instanceOverrides?: Partial<Record<ProviderDriverKind, AdapterRegistryInstanceOverrides>>,
): ProviderInstanceRegistryShape => {
  const byInstanceId = new Map<ProviderInstanceId, ProviderInstance>();
  for (const [kind, adapter] of Object.entries(adapters)) {
    if (!adapter) continue;
    const driverKind = ProviderDriverKind.make(kind);
    const instanceId = defaultInstanceIdForDriver(driverKind);
    const overrides = instanceOverrides?.[driverKind];
    byInstanceId.set(instanceId, makeMockProviderInstance(instanceId, adapter, overrides));
  }

  return {
    getInstance: (instanceId) => Effect.succeed(byInstanceId.get(instanceId)),
    listInstances: Effect.succeed(Array.from(byInstanceId.values())),
    listUnavailable: Effect.succeed([]),
    streamChanges: Stream.empty,
    subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), (pubsub) =>
      PubSub.subscribe(pubsub),
    ),
  };
};
