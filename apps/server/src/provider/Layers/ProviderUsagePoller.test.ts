import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderUsageSample,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { PersistenceSqlError } from "../../persistence/Errors.ts";
import {
  ProviderAccountLimitsStore,
  type ProviderAccountLimitsStoreShape,
} from "../../persistence/Services/ProviderAccountLimits.ts";
import {
  ProviderUsageLedgerStore,
  type ProviderUsageLedgerStoreShape,
} from "../../persistence/Services/ProviderUsageLedger.ts";
import type { ProviderInstance } from "../ProviderDriver.ts";
import { ProviderInstanceRegistry } from "../Services/ProviderInstanceRegistry.ts";
import { ProviderUsagePollerLive } from "./ProviderUsagePoller.ts";

const INSTANCE_ID = ProviderInstanceId.make("claude-work");
const DRIVER_KIND = ProviderDriverKind.make("claudeAgent");

const makeInstance = (
  readUsage: NonNullable<ProviderInstance["usage"]>["readUsage"],
): ProviderInstance => ({
  instanceId: INSTANCE_ID,
  driverKind: DRIVER_KIND,
  continuationIdentity: {
    driverKind: DRIVER_KIND,
    continuationKey: "claudeAgent:instance:claude-work",
  },
  displayName: "Claude Work",
  enabled: true,
  snapshot: {} as ProviderInstance["snapshot"],
  adapter: {} as ProviderInstance["adapter"],
  textGeneration: {} as ProviderInstance["textGeneration"],
  usage: { readUsage },
});

const makeRegistryLayer = (instances: ReadonlyArray<ProviderInstance>) =>
  Layer.succeed(ProviderInstanceRegistry, {
    getInstance: (requestedId) =>
      Effect.succeed(instances.find((instance) => instance.instanceId === requestedId)),
    listInstances: Effect.succeed(instances),
    listUnavailable: Effect.succeed([]),
    streamChanges: Stream.empty,
    subscribeChanges: Effect.die("unused by provider usage poller"),
  });

const makeLedgerLayer = (overrides: Partial<ProviderUsageLedgerStoreShape>) =>
  Layer.succeed(ProviderUsageLedgerStore, {
    recordSamples: () => Effect.void,
    listForInstance: () => Effect.succeed([]),
    listAll: Effect.succeed([]),
    pruneObservedBefore: () => Effect.void,
    ...overrides,
  });

const makeLimitsLayer = (clearExpired: ProviderAccountLimitsStoreShape["clearExpired"]) =>
  Layer.succeed(ProviderAccountLimitsStore, {
    recordLimit: () => Effect.void,
    listAll: Effect.succeed([]),
    listForInstance: () => Effect.succeed([]),
    clearForInstance: () => Effect.void,
    clearExpired,
  });

it.effect("polls provider readers and prunes once without a limits store", () =>
  Effect.gen(function* () {
    const recorded = yield* Deferred.make<ReadonlyArray<ProviderUsageSample>>();
    const pruned = yield* Deferred.make<{ readonly cutoff: string }>();
    const pruneCalls: Array<{ readonly cutoff: string }> = [];
    const instance = makeInstance(
      Effect.succeed([
        {
          window: "five_hour" as const,
          utilization: 0.7,
          resetsAt: null,
          source: "claude.sdk.get_usage" as const,
        },
      ]),
    );
    const ledgerLayer = makeLedgerLayer({
      recordSamples: ({ samples }) => Deferred.succeed(recorded, samples).pipe(Effect.asVoid),
      pruneObservedBefore: (input) =>
        Effect.sync(() => pruneCalls.push(input)).pipe(
          Effect.andThen(Deferred.succeed(pruned, input)),
          Effect.asVoid,
        ),
    });

    yield* TestClock.setTime(Date.parse("2026-08-10T12:00:00.000Z"));
    yield* Layer.build(
      ProviderUsagePollerLive.pipe(
        Layer.provide(Layer.mergeAll(makeRegistryLayer([instance]), ledgerLayer)),
      ),
    );

    assert.deepStrictEqual(yield* Deferred.await(recorded), [
      {
        providerInstanceId: INSTANCE_ID,
        window: "five_hour",
        utilization: 0.7,
        resetsAt: null,
        source: "claude.sdk.get_usage",
        observedAt: "2026-08-10T12:00:00.000Z",
      },
    ]);
    assert.deepStrictEqual(yield* Deferred.await(pruned), {
      cutoff: "2026-08-03T12:00:00.000Z",
    });
    assert.strictEqual(pruneCalls.length, 1);
  }).pipe(Effect.scoped),
);

it.effect("cleans stored usage and limits when a reader returns no samples", () =>
  Effect.gen(function* () {
    let readerCalls = 0;
    const pruneCalls: Array<{ readonly cutoff: string }> = [];
    const cleared = yield* Deferred.make<{ readonly now: string }>();
    const instance = makeInstance(
      Effect.sync(() => {
        readerCalls += 1;
        return [];
      }),
    );
    const ledgerLayer = makeLedgerLayer({
      pruneObservedBefore: (input) =>
        Effect.sync(() => {
          pruneCalls.push(input);
        }),
    });
    const limitsLayer = makeLimitsLayer((input) =>
      Deferred.succeed(cleared, input).pipe(Effect.asVoid),
    );

    yield* TestClock.setTime(Date.parse("2026-08-10T12:00:00.000Z"));
    yield* Layer.build(
      ProviderUsagePollerLive.pipe(
        Layer.provide(Layer.mergeAll(makeRegistryLayer([instance]), ledgerLayer, limitsLayer)),
      ),
    );

    assert.deepStrictEqual(yield* Deferred.await(cleared), {
      now: "2026-08-10T12:00:00.000Z",
    });
    assert.strictEqual(readerCalls, 1);
    assert.deepStrictEqual(pruneCalls, [{ cutoff: "2026-08-03T12:00:00.000Z" }]);
  }).pipe(Effect.scoped),
);

it.effect("logs a cleanup failure and polls again on the next tick", () => {
  const messages: Array<unknown> = [];
  const logger = Logger.make<unknown, void>(({ message }) => {
    messages.push(message);
  });

  return Effect.gen(function* () {
    let readerCalls = 0;
    let pruneCalls = 0;
    const firstPrune = yield* Deferred.make<void>();
    const secondPrune = yield* Deferred.make<void>();
    const instance = makeInstance(
      Effect.sync(() => {
        readerCalls += 1;
        return [];
      }),
    );
    const ledgerLayer = makeLedgerLayer({
      pruneObservedBefore: () =>
        Effect.suspend(() => {
          pruneCalls += 1;
          if (pruneCalls === 1) {
            return Deferred.succeed(firstPrune, undefined).pipe(
              Effect.andThen(
                Effect.fail(new PersistenceSqlError({ operation: "test.pruneObservedBefore" })),
              ),
            );
          }
          return Deferred.succeed(secondPrune, undefined).pipe(Effect.asVoid);
        }),
    });

    yield* Layer.build(
      ProviderUsagePollerLive.pipe(
        Layer.provide(Layer.mergeAll(makeRegistryLayer([instance]), ledgerLayer)),
      ),
    );
    yield* Deferred.await(firstPrune);
    yield* Effect.yieldNow;
    yield* Effect.yieldNow;

    yield* TestClock.adjust(Duration.minutes(5));
    yield* Effect.yieldNow;
    yield* Deferred.await(secondPrune);

    assert.strictEqual(readerCalls, 2);
    assert.strictEqual(pruneCalls, 2);
    assert.ok(
      messages.some(
        (message) =>
          Array.isArray(message) &&
          message[0] === "provider usage polling or cleanup failed; keeping existing data",
      ),
    );
  }).pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })), Effect.scoped);
});
