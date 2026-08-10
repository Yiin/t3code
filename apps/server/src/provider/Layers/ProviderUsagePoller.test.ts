import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderUsageSample,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { ProviderUsageLedgerStore } from "../../persistence/Services/ProviderUsageLedger.ts";
import type { ProviderInstance } from "../ProviderDriver.ts";
import { ProviderInstanceRegistry } from "../Services/ProviderInstanceRegistry.ts";
import { ProviderUsagePollerLive } from "./ProviderUsagePoller.ts";

it.effect("polls provider readers and stamps their samples", () =>
  Effect.gen(function* () {
    const recorded = yield* Deferred.make<ReadonlyArray<ProviderUsageSample>>();
    const instanceId = ProviderInstanceId.make("claude-work");
    const instance = {
      instanceId,
      driverKind: ProviderDriverKind.make("claudeAgent"),
      continuationIdentity: {
        driverKind: ProviderDriverKind.make("claudeAgent"),
        continuationKey: "claudeAgent:instance:claude-work",
      },
      displayName: "Claude Work",
      enabled: true,
      snapshot: {} as ProviderInstance["snapshot"],
      adapter: {} as ProviderInstance["adapter"],
      textGeneration: {} as ProviderInstance["textGeneration"],
      usage: {
        readUsage: Effect.succeed([
          {
            window: "five_hour" as const,
            utilization: 0.7,
            resetsAt: null,
            source: "claude.sdk.get_usage" as const,
          },
        ]),
      },
    } satisfies ProviderInstance;

    const registryLayer = Layer.succeed(ProviderInstanceRegistry, {
      getInstance: (requestedId) =>
        Effect.succeed(requestedId === instanceId ? instance : undefined),
      listInstances: Effect.succeed([instance]),
      listUnavailable: Effect.succeed([]),
      streamChanges: Stream.empty,
      subscribeChanges: Effect.die("unused by provider usage poller"),
    });
    const ledgerLayer = Layer.succeed(ProviderUsageLedgerStore, {
      recordSamples: ({ samples }) => Deferred.succeed(recorded, samples).pipe(Effect.asVoid),
      listForInstance: () => Effect.succeed([]),
      listAll: Effect.succeed([]),
      pruneObservedBefore: () => Effect.void,
    });

    yield* TestClock.setTime(Date.parse("2026-08-10T12:00:00.000Z"));
    yield* Layer.build(
      ProviderUsagePollerLive.pipe(Layer.provide(Layer.mergeAll(registryLayer, ledgerLayer))),
    );

    assert.deepStrictEqual(yield* Deferred.await(recorded), [
      {
        providerInstanceId: instanceId,
        window: "five_hour",
        utilization: 0.7,
        resetsAt: null,
        source: "claude.sdk.get_usage",
        observedAt: "2026-08-10T12:00:00.000Z",
      },
    ]);
  }).pipe(Effect.scoped),
);
