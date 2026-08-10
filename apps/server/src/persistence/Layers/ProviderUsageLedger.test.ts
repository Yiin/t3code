import {
  ProviderInstanceId,
  type ProviderUsageSample,
  type ProviderUsageWindow,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ProviderUsageLedgerStoreLive } from "./ProviderUsageLedger.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { ProviderUsageLedgerStore } from "../Services/ProviderUsageLedger.ts";

const ledgerLayer = ProviderUsageLedgerStoreLive.pipe(Layer.provideMerge(SqlitePersistenceMemory));

const makeSample = (
  providerInstanceId: string,
  window: ProviderUsageWindow,
  observedAt: string,
  overrides: Partial<ProviderUsageSample> = {},
): ProviderUsageSample => ({
  providerInstanceId: ProviderInstanceId.make(providerInstanceId),
  window,
  utilization: 0.5,
  resetsAt: null,
  source: "claude.sdk.get_usage",
  observedAt,
  ...overrides,
});

describe("ProviderUsageLedgerStore", () => {
  it.effect("round-trips every field and accepts an empty write", () =>
    Effect.gen(function* () {
      const store = yield* ProviderUsageLedgerStore;
      const sample = makeSample("claude-work", "five_hour", "2026-08-10T00:00:00.000Z");

      yield* store.recordSamples({ samples: [] });
      yield* store.recordSamples({ samples: [sample] });

      assert.deepStrictEqual(
        yield* store.listForInstance({ providerInstanceId: sample.providerInstanceId }),
        [sample],
      );
    }).pipe(Effect.provide(ledgerLayer)),
  );

  it.effect("keeps newer samples when writes arrive out of order", () =>
    Effect.gen(function* () {
      const store = yield* ProviderUsageLedgerStore;
      const initial = makeSample("claude-work", "five_hour", "2026-08-10T00:01:00.000Z");
      const older = makeSample("claude-work", "five_hour", "2026-08-10T00:00:00.000Z", {
        utilization: 0.1,
      });
      const newer = makeSample("claude-work", "five_hour", "2026-08-10T00:02:00.000Z", {
        utilization: 0.9,
        resetsAt: "2026-08-10T05:00:00.000Z",
        source: "claude.sdk.rate_limit_event",
      });

      yield* store.recordSamples({ samples: [initial, older] });
      assert.deepStrictEqual(
        yield* store.listForInstance({ providerInstanceId: initial.providerInstanceId }),
        [initial],
      );

      yield* store.recordSamples({ samples: [newer] });
      assert.deepStrictEqual(
        yield* store.listForInstance({ providerInstanceId: initial.providerInstanceId }),
        [newer],
      );
    }).pipe(Effect.provide(ledgerLayer)),
  );

  it.effect("prunes rows observed at or before the cutoff", () =>
    Effect.gen(function* () {
      const store = yield* ProviderUsageLedgerStore;
      const before = makeSample("claude-work", "five_hour", "2026-08-10T00:00:00.000Z");
      const atCutoff = makeSample("claude-work", "seven_day", "2026-08-10T00:01:00.000Z");
      const after = makeSample("claude-work", "seven_day_opus", "2026-08-10T00:02:00.000Z");
      yield* store.recordSamples({ samples: [before, atCutoff, after] });

      yield* store.pruneObservedBefore({ cutoff: "2026-08-10T00:01:00.000Z" });

      assert.deepStrictEqual(yield* store.listAll, [after]);
    }).pipe(Effect.provide(ledgerLayer)),
  );

  it.effect("lists all instances without cross-talk", () =>
    Effect.gen(function* () {
      const store = yield* ProviderUsageLedgerStore;
      const claude = makeSample("claude-work", "five_hour", "2026-08-10T00:00:00.000Z");
      const codex = makeSample("codex-home", "primary", "2026-08-10T00:00:00.000Z", {
        source: "codex.app_server.read",
      });
      yield* store.recordSamples({ samples: [codex, claude] });

      assert.deepStrictEqual(yield* store.listAll, [claude, codex]);
      assert.deepStrictEqual(
        yield* store.listForInstance({ providerInstanceId: codex.providerInstanceId }),
        [codex],
      );
    }).pipe(Effect.provide(ledgerLayer)),
  );
});
