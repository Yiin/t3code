import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderAccountLimit,
  type ProviderLimitKind,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ProviderAccountLimitsStoreLive } from "./ProviderAccountLimits.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { ProviderAccountLimitsStore } from "../Services/ProviderAccountLimits.ts";

const limitsLayer = ProviderAccountLimitsStoreLive.pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
);

const makeLimit = (
  providerInstanceId: string,
  kind: ProviderLimitKind,
  detectedAt: string,
  overrides: Partial<ProviderAccountLimit> = {},
): ProviderAccountLimit => ({
  providerInstanceId: ProviderInstanceId.make(providerInstanceId),
  driver: ProviderDriverKind.make("claudeAgent"),
  kind,
  detectedAt,
  resetsAt: null,
  resetsAtEstimated: false,
  source: "claude.sdk.rate_limit_event",
  detail: null,
  ...overrides,
});

describe("ProviderAccountLimitsStore", () => {
  it.effect("records a limit and lists it back", () =>
    Effect.gen(function* () {
      const store = yield* ProviderAccountLimitsStore;
      const limit = makeLimit("claude-work", "usage-limit", "2026-08-14T00:00:00.000Z", {
        resetsAt: "2026-08-14T05:00:00.000Z",
        resetsAtEstimated: true,
        detail: "5-hour window reached",
      });

      yield* store.recordLimit(limit);

      assert.deepStrictEqual(yield* store.listAll, [limit]);
      assert.deepStrictEqual(
        yield* store.listForInstance({ providerInstanceId: limit.providerInstanceId }),
        [limit],
      );
    }).pipe(Effect.provide(limitsLayer)),
  );

  it.effect("keeps the newer detection when writes arrive out of order", () =>
    Effect.gen(function* () {
      const store = yield* ProviderAccountLimitsStore;
      const initial = makeLimit("claude-work", "usage-limit", "2026-08-14T00:01:00.000Z");
      const older = makeLimit("claude-work", "usage-limit", "2026-08-14T00:00:00.000Z", {
        detail: "stale",
      });
      const newer = makeLimit("claude-work", "usage-limit", "2026-08-14T00:02:00.000Z", {
        resetsAt: "2026-08-14T05:00:00.000Z",
        source: "claude.sdk.get_usage",
      });

      yield* store.recordLimit(initial);
      yield* store.recordLimit(older);
      assert.deepStrictEqual(yield* store.listAll, [initial]);

      yield* store.recordLimit(newer);
      assert.deepStrictEqual(yield* store.listAll, [newer]);
    }).pipe(Effect.provide(limitsLayer)),
  );

  it.effect("clears every kind for one instance only", () =>
    Effect.gen(function* () {
      const store = yield* ProviderAccountLimitsStore;
      const usage = makeLimit("claude-work", "usage-limit", "2026-08-14T00:00:00.000Z");
      const auth = makeLimit("claude-work", "auth", "2026-08-14T00:00:00.000Z");
      const sibling = makeLimit("claude-personal", "usage-limit", "2026-08-14T00:00:00.000Z");
      yield* store.recordLimit(usage);
      yield* store.recordLimit(auth);
      yield* store.recordLimit(sibling);

      yield* store.clearForInstance({ providerInstanceId: usage.providerInstanceId });

      assert.deepStrictEqual(yield* store.listAll, [sibling]);
    }).pipe(Effect.provide(limitsLayer)),
  );

  it.effect("clears a passed reset time and keeps a null one", () =>
    Effect.gen(function* () {
      const store = yield* ProviderAccountLimitsStore;
      const passed = makeLimit("claude-work", "usage-limit", "2026-08-14T00:00:00.000Z", {
        resetsAt: "2026-08-14T05:00:00.000Z",
      });
      const noReset = makeLimit("claude-work", "auth", "2026-08-14T00:00:00.000Z");
      yield* store.recordLimit(passed);
      yield* store.recordLimit(noReset);

      yield* store.clearExpired({ now: "2026-08-14T05:00:00.000Z" });

      assert.deepStrictEqual(yield* store.listAll, [noReset]);
    }).pipe(Effect.provide(limitsLayer)),
  );
});
