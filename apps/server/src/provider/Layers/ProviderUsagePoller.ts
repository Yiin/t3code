import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";

import { ProviderUsageLedgerStore } from "../../persistence/Services/ProviderUsageLedger.ts";
import { ProviderInstanceRegistry } from "../Services/ProviderInstanceRegistry.ts";

const POLL_INTERVAL = Duration.minutes(5);

const makeProviderUsagePoller = Effect.gen(function* () {
  const instanceRegistry = yield* ProviderInstanceRegistry;
  const usageLedger = yield* ProviderUsageLedgerStore;

  const poll = Effect.fn("ProviderUsagePoller.poll")(function* () {
    const instances = yield* instanceRegistry.listInstances;
    yield* Effect.forEach(
      instances,
      (instance) =>
        Effect.gen(function* () {
          if (instance.usage === undefined) return;
          const readings = yield* instance.usage.readUsage;
          if (readings.length === 0) return;
          const observedAt = DateTime.formatIso(yield* DateTime.now);
          yield* usageLedger.recordSamples({
            samples: readings.map((reading) => ({
              ...reading,
              providerInstanceId: instance.instanceId,
              observedAt,
            })),
          });
        }),
      { concurrency: "unbounded", discard: true },
    );
  });

  const pollAndContinue = poll().pipe(
    Effect.catch((error) =>
      Effect.logWarning("provider usage poll failed; keeping existing samples", { error }),
    ),
  );
  yield* Effect.forkScoped(pollAndContinue.pipe(Effect.repeat(Schedule.spaced(POLL_INTERVAL))));
});

export const ProviderUsagePollerLive = Layer.effectDiscard(makeProviderUsagePoller);
