/**
 * subagentSpawnSettings - the settings block that turns thread-backed
 * subagent spawning on.
 *
 * Every field is optional on purpose. An absent field means "use the server's
 * default", and the server owns those defaults in `DEFAULT_SPAWN_POLICY`
 * (`apps/server/src/mcp/toolkits/agents/spawnPolicy.ts`). Repeating them here
 * would give the same number two homes that can drift apart.
 *
 * The block is stored and patched as one whole value, like `epicRolePolicy`: a
 * deep-merged partial patch can never shorten `allowedAgentTypes` back to
 * empty.
 *
 * @module subagentSpawnSettings
 */
import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/** Matches `MAX_DEPTH_WALK` in the agents toolkit: past it the walk gives up. */
const MAX_SUBAGENT_SPAWN_DEPTH = 8;
const MAX_CONCURRENT_SUBAGENT_CHILDREN = 16;
const MIN_SPAWN_WAIT_TIMEOUT_MS = 60_000;
const MAX_SPAWN_WAIT_TIMEOUT_MS = 4 * 60 * 60_000;

export const SubagentSpawnSettings = Schema.Struct({
  /**
   * Ships off. Turning it on also takes the provider's built-in delegation
   * tools away for that session, so a fan-out runs one child at a time.
   */
  enabled: Schema.optionalKey(Schema.Boolean),
  /**
   * Agent types allowed to become child threads, matched case-insensitively.
   * Empty means every type is allowed.
   */
  allowedAgentTypes: Schema.optionalKey(Schema.Array(TrimmedNonEmptyString)),
  /** How deep the chain of thread-backed children may go. 1 means no grandchildren. */
  maxDepth: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: MAX_SUBAGENT_SPAWN_DEPTH })),
  ),
  /** How many thread-backed children of one parent may run at once. */
  maxConcurrentChildren: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_CONCURRENT_SUBAGENT_CHILDREN })),
  ),
  /** How long `spawn_agent` waits for a child before it returns a timeout result. */
  spawnWaitTimeoutMs: Schema.optionalKey(
    Schema.Int.check(
      Schema.isBetween({
        minimum: MIN_SPAWN_WAIT_TIMEOUT_MS,
        maximum: MAX_SPAWN_WAIT_TIMEOUT_MS,
      }),
    ),
  ),
});
export type SubagentSpawnSettings = typeof SubagentSpawnSettings.Type;

/** An empty block: every field falls back to the server default. */
export const DEFAULT_SUBAGENT_SPAWN_SETTINGS: SubagentSpawnSettings = Schema.decodeSync(
  SubagentSpawnSettings,
)({});
