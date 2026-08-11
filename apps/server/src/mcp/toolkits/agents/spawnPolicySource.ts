/**
 * spawnPolicySource - fetches the live `SpawnPolicy` from server settings.
 *
 * `./spawnPolicy.ts` stays pure, so the impure half lives here: read the
 * `subagentSpawn` block, hand it to `resolveSpawnPolicy`, and fall back to the
 * default policy when settings cannot be read. Both readers are used per call,
 * never cached, so turning the setting on takes effect on the next spawn
 * without a server restart.
 *
 * @module agents/spawnPolicySource
 */
import * as Effect from "effect/Effect";

import { ServerSettingsService } from "../../../serverSettings.ts";
import { resolveSpawnPolicy, type SpawnPolicy } from "./spawnPolicy.ts";

/**
 * Read the policy from an already-resolved settings service.
 *
 * Failing closed is the safe direction: an unreadable settings file leaves
 * thread-backed spawning off, which is also what it ships as.
 */
export const readSpawnPolicyFrom = (
  serverSettings: ServerSettingsService["Service"],
): Effect.Effect<SpawnPolicy> =>
  serverSettings.getSettings.pipe(
    Effect.map((settings) => resolveSpawnPolicy(settings.subagentSpawn)),
    Effect.catchCause((cause) =>
      Effect.logWarning("subagentSpawn.policy.read-failed", cause).pipe(
        Effect.as(resolveSpawnPolicy()),
      ),
    ),
  );

/** Same read, for callers that hold the service in their context. */
export const readSpawnPolicy: Effect.Effect<SpawnPolicy, never, ServerSettingsService> = Effect.gen(
  function* () {
    const serverSettings = yield* ServerSettingsService;
    return yield* readSpawnPolicyFrom(serverSettings);
  },
);
