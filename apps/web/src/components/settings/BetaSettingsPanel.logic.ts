/**
 * Pure state helpers for the beta settings page.
 *
 * `subagentSpawn` is patched as one whole value, like `epicRolePolicy`: the
 * server deep-merges a partial patch, so a partial can never shorten
 * `allowedAgentTypes` back to empty. Every edit here therefore sends the full
 * block.
 *
 * The caps (`allowedAgentTypes`, `maxDepth`, `maxConcurrentChildren`,
 * `spawnWaitTimeoutMs`) stay file-only for now, so the toggle carries whatever
 * the user hand-edited into settings.json instead of dropping it.
 *
 * @module BetaSettingsPanel.logic
 */
import type { SubagentSpawnSettings } from "@t3tools/contracts";

/**
 * The whole `subagentSpawn` block to send when the toggle moves.
 *
 * Turning it off omits `enabled` rather than writing `false`: absent means "use
 * the server default", and the server default is off. With no caps set that
 * leaves `{}`, which the server strips from settings.json entirely.
 */
export function nextSubagentSpawnSettings(
  current: SubagentSpawnSettings,
  enabled: boolean,
): SubagentSpawnSettings {
  const { enabled: _previous, ...caps } = current;
  return enabled ? { ...caps, enabled: true } : caps;
}

/** True when the block turns thread-backed spawning on. Absent means off. */
export function isSubagentSpawnEnabled(current: SubagentSpawnSettings): boolean {
  return current.enabled === true;
}
