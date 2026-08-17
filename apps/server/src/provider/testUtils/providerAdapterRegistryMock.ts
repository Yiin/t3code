/**
 * Test helpers for constructing a `ProviderAdapterRegistryShape` mock from a
 * kind-keyed adapter map.
 *
 * Tests historically assembled a `registry` object with only `getByProvider`
 * + instance lookup populated. Slice D grew the shape with `getByInstance`
 * and `listInstances`; this helper fills both in from a single kind-keyed
 * input so individual fixtures can stay concise.
 *
 * @module provider/testUtils/providerAdapterRegistryMock
 */
import {
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import { ProviderUnsupportedError, type ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import type { ProviderAdapterRegistryShape } from "../Services/ProviderAdapterRegistry.ts";

export type KindAdapterMap = Partial<
  Record<ProviderDriverKind, ProviderAdapterShape<ProviderAdapterError>>
>;

/**
 * Per-instance routing details a fixture wants to differ from the defaults.
 * Keyed by driver kind, the same key the adapter map uses.
 */
export interface AdapterRegistryInstanceOverrides {
  readonly enabled?: boolean;
  readonly continuationKey?: string;
  readonly legacyContinuationKeys?: ReadonlyArray<string>;
}

/**
 * Build a `ProviderAdapterRegistryShape` from a kind-keyed adapter map.
 * Every adapter present in the map is addressable via both the legacy
 * `getByProvider(kind)` path and the new `getByInstance(id)` path (where
 * `id = defaultInstanceIdForDriver(kind)`).
 */
export const makeAdapterRegistryMock = (
  adapters: KindAdapterMap,
  instanceOverrides?: Partial<Record<ProviderDriverKind, AdapterRegistryInstanceOverrides>>,
): ProviderAdapterRegistryShape => {
  const byInstanceId = new Map<ProviderInstanceId, ProviderAdapterShape<ProviderAdapterError>>();
  for (const [kind, adapter] of Object.entries(adapters)) {
    if (!adapter) continue;
    const driverKind = ProviderDriverKind.make(kind);
    byInstanceId.set(defaultInstanceIdForDriver(driverKind), adapter);
  }

  const getByInstance: ProviderAdapterRegistryShape["getByInstance"] = (instanceId) => {
    const adapter = byInstanceId.get(instanceId);
    return adapter
      ? Effect.succeed(adapter)
      : Effect.fail(
          new ProviderUnsupportedError({
            provider: ProviderDriverKind.make(instanceId),
          }),
        );
  };

  return {
    getByInstance,
    getInstanceInfo: (instanceId) => {
      const adapter = byInstanceId.get(instanceId);
      if (!adapter) {
        return Effect.fail(
          new ProviderUnsupportedError({
            provider: ProviderDriverKind.make(instanceId),
          }),
        );
      }
      const driverKind = ProviderDriverKind.make(adapter.provider);
      const overrides = instanceOverrides?.[driverKind];
      return Effect.succeed({
        instanceId,
        driverKind,
        displayName: undefined,
        enabled: overrides?.enabled ?? true,
        continuationIdentity: {
          driverKind,
          continuationKey:
            overrides?.continuationKey ?? `${adapter.provider}:instance:${instanceId}`,
          ...(overrides?.legacyContinuationKeys !== undefined &&
          overrides.legacyContinuationKeys.length > 0
            ? { legacyContinuationKeys: overrides.legacyContinuationKeys }
            : {}),
        },
      });
    },
    listInstances: () => Effect.succeed(Array.from(byInstanceId.keys())),
    // Static test fixtures don't reload; an empty stream is enough to
    // satisfy the shape. Tests exercising hot-reload build their own
    // stream via the real `ProviderInstanceRegistry`.
    streamChanges: Stream.empty,
    subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), (pubsub) =>
      PubSub.subscribe(pubsub),
    ),
  };
};
