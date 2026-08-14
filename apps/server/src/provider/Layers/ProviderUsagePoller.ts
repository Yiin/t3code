import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";

import { ProviderAccountLimitsStore } from "../../persistence/Services/ProviderAccountLimits.ts";
import { ProviderUsageLedgerStore } from "../../persistence/Services/ProviderUsageLedger.ts";
import { ProviderInstanceRegistry } from "../Services/ProviderInstanceRegistry.ts";

const POLL_INTERVAL = Duration.minutes(5);
// seven_day is the longest named usage window, so older observations cannot describe a live limit.
const USAGE_RETENTION = Duration.days(7);

const makeProviderUsagePoller = Effect.gen(function* () {
  const instanceRegistry = yield* ProviderInstanceRegistry;
  const usageLedger = yield* ProviderUsageLedgerStore;
  const limitsStore = yield* Effect.serviceOption(ProviderAccountLimitsStore);

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

    const now = yield* DateTime.now;
    const nowIso = DateTime.formatIso(now);
    yield* usageLedger.pruneObservedBefore({
      cutoff: DateTime.formatIso(DateTime.subtractDuration(now, USAGE_RETENTION)),
    });
    if (Option.isSome(limitsStore)) {
      yield* limitsStore.value.clearExpired({ now: nowIso });
    }
  });

  const pollAndContinue = poll().pipe(
    Effect.catch((error) =>
      Effect.logWarning("provider usage polling or cleanup failed; keeping existing data", {
        error,
      }),
    ),
  );
  yield* Effect.forkScoped(pollAndContinue.pipe(Effect.repeat(Schedule.spaced(POLL_INTERVAL))));
});

export const ProviderUsagePollerLive = Layer.effectDiscard(makeProviderUsagePoller);
