import { assert, describe, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS, type SubagentSpawnSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import type { ServerSettingsService } from "../../../serverSettings.ts";
import { DEFAULT_SPAWN_POLICY } from "./spawnPolicy.ts";
import { readSpawnPolicyFrom } from "./spawnPolicySource.ts";

/**
 * A settings service stub. Only `getSettings` matters here, and leaving it out
 * makes it die, which is the "settings unreadable" case.
 */
const settingsServiceOf = (
  getSettings?: ServerSettingsService["Service"]["getSettings"],
): ServerSettingsService["Service"] => ({
  start: Effect.void,
  ready: Effect.void,
  getSettings: getSettings ?? Effect.die("settings unreadable"),
  updateSettings: () => Effect.die("updateSettings not stubbed"),
  streamChanges: Stream.empty,
});

const settingsWith = (subagentSpawn: SubagentSpawnSettings) => ({
  ...DEFAULT_SERVER_SETTINGS,
  subagentSpawn,
});

describe("readSpawnPolicyFrom", () => {
  it.effect("turns the policy on from the settings block", () =>
    Effect.gen(function* () {
      const service = settingsServiceOf(
        Effect.succeed(settingsWith({ enabled: true, maxConcurrentChildren: 2 })),
      );

      assert.deepStrictEqual(yield* readSpawnPolicyFrom(service), {
        ...DEFAULT_SPAWN_POLICY,
        enabled: true,
        maxConcurrentChildren: 2,
      });
    }),
  );

  it.effect("stays off when the block is empty", () =>
    Effect.gen(function* () {
      const service = settingsServiceOf(Effect.succeed(settingsWith({})));

      assert.deepStrictEqual(yield* readSpawnPolicyFrom(service), DEFAULT_SPAWN_POLICY);
    }),
  );

  it.effect("re-reads every call, so a change lands without a restart", () =>
    Effect.gen(function* () {
      const enabled = yield* Ref.make(false);
      const service = settingsServiceOf(
        Ref.get(enabled).pipe(Effect.map((value) => settingsWith({ enabled: value }))),
      );

      assert.strictEqual((yield* readSpawnPolicyFrom(service)).enabled, false);

      yield* Ref.set(enabled, true);

      assert.strictEqual((yield* readSpawnPolicyFrom(service)).enabled, true);
    }),
  );

  it.effect("fails closed when settings cannot be read", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* readSpawnPolicyFrom(settingsServiceOf()), DEFAULT_SPAWN_POLICY);
    }),
  );
});
