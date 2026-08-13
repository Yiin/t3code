// @effect-diagnostics nodeBuiltinImport:off
/**
 * The `t3 epic cook` CLI's source for injected role subagents.
 *
 * The server runner reads the epic role policy through `ServerSettingsService`
 * and the provider inventory through `ProviderRegistry` (`EpicRunner.ts`). The
 * cook CLI has neither: it is a standalone binary whose import graph must stay
 * clear of the server config and the database (`epicCook.integration.test.ts`
 * asserts that). So it reads the same settings file directly, and resolves the
 * same roles against the terminal provider inventory it already builds.
 *
 * Every step is fail-soft. A missing file, an unreadable one, or a policy with
 * no in-session roles yields an empty map, and an empty map emits no `--agents`
 * flag at all — the harness then keeps its own agents, exactly as before.
 */
import * as NodePath from "node:path";

import {
  DEFAULT_EPIC_ROLE_POLICY,
  type EpicRolePolicy,
  type EpicSubagentMap,
  type ModelSelection,
} from "@t3tools/contracts";
import { resolveEpicSubagents } from "@t3tools/epic-core/epicSubagents";
import type { ProviderInventoryShape } from "@t3tools/epic-core/ports/ProviderInventory";
import { parsePersistedEpicRolePolicy } from "@t3tools/shared/serverSettings";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

/**
 * Where the server keeps `settings.json`.
 *
 * This mirrors `deriveServerPaths` in `apps/server/src/config.ts`, which the
 * CLI may not import. Keep the two in step: same base directory variable, same
 * `dev` versus `userdata` split, same file name.
 */
export const resolveCookSettingsPath = (input: {
  readonly environment: NodeJS.ProcessEnv;
  readonly homeDirectory: string;
}): string => {
  const configured = input.environment.T3CODE_HOME?.trim();
  const explicitBaseDir = configured === undefined || configured === "" ? undefined : configured;
  const baseDir =
    explicitBaseDir === undefined
      ? NodePath.join(input.homeDirectory, ".t3")
      : NodePath.resolve(
          explicitBaseDir === "~"
            ? input.homeDirectory
            : explicitBaseDir.startsWith("~/")
              ? NodePath.join(input.homeDirectory, explicitBaseDir.slice(2))
              : explicitBaseDir,
        );
  const devUrl = input.environment.VITE_DEV_SERVER_URL;
  const stateDir = NodePath.join(
    baseDir,
    devUrl !== undefined && devUrl !== "" && explicitBaseDir === undefined ? "dev" : "userdata",
  );
  return NodePath.join(stateDir, "settings.json");
};

/** The persisted epic role policy, or the empty one when nothing is readable. */
export const readEpicRolePolicy = (
  settingsPath: string,
): Effect.Effect<EpicRolePolicy, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const raw = yield* fileSystem.readFileString(settingsPath);
    return parsePersistedEpicRolePolicy(raw);
  }).pipe(Effect.orElseSucceed(() => DEFAULT_EPIC_ROLE_POLICY));

/**
 * The subagents a terminal worker session carries, resolved once per cook: the
 * CLI builds one dispatch for the whole run, so there is no later seam to
 * refresh at.
 *
 * Utilization is deliberately absent. The usage ledger lives in the database,
 * which this binary must not open, and the terminal inventory holds one
 * instance per driver — so a sample could only drop the single eligible hop,
 * never rotate to another account. An unknown sample never skips a hop, so
 * leaving it out keeps the policy's own order.
 */
export const readCookSubagents = (input: {
  readonly settingsPath: string;
  readonly inventory: ProviderInventoryShape;
  readonly sessionSelection: ModelSelection;
}): Effect.Effect<EpicSubagentMap, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const policy = yield* readEpicRolePolicy(input.settingsPath);
    // No role, no probe: `getProviders` shells out once per candidate binary.
    if (Object.keys(policy.inSessionRoles).length === 0) return {};
    const providers = yield* input.inventory.getProviders;
    return resolveEpicSubagents({
      policy,
      providers,
      sessionInstanceId: input.sessionSelection.instanceId,
    });
  }).pipe(Effect.orElseSucceed((): EpicSubagentMap => ({})));
