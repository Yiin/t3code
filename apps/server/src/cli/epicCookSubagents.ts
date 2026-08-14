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
 * Every step is fail-soft, but a missing file is no longer the empty case. An
 * unreadable settings file falls back to the shipped default policy, which
 * carries the six stage subagents, so a fresh install cooks with them. Only a
 * policy that persists no in-session role, or an inventory that fails or throws,
 * yields an empty map — and an empty map emits no `--agents` flag at all, so the
 * harness keeps its own agents.
 */
import * as NodePath from "node:path";

import {
  DEFAULT_EPIC_ROLE_POLICY,
  type EpicRolePolicy,
  type EpicSubagentMap,
  type ModelSelection,
  type ServerProvider,
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

/**
 * The persisted epic role policy, or the default one when nothing is readable.
 * The default ships the stage subagents, so a fresh install with no settings
 * file still cooks with them.
 */
export const readEpicRolePolicy = (
  settingsPath: string,
): Effect.Effect<EpicRolePolicy, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const raw = yield* fileSystem.readFileString(settingsPath);
    return parsePersistedEpicRolePolicy(raw);
  }).pipe(Effect.orElseSucceed(() => DEFAULT_EPIC_ROLE_POLICY));

/**
 * Teach the terminal inventory the models the policy already names.
 *
 * The terminal inventory is not a probe result. `makeTerminalProviderSupport`
 * builds one route per harness and gives each a single model slug — the
 * session's own for the primary route, the driver default for the fallbacks.
 * That single-model shape is deliberate: forward provider fallback reads the
 * same snapshots and must hop by driver, not by menu. But subagent resolution
 * reuses the same eligibility rule, which requires the hop's model to be listed,
 * so on the CLI every hop whose model differs from the session's own is dropped
 * and every stage agent ships model-less. A cook on `claude` at
 * `claude-fable-5` loses a `claude-opus-5` hop the same binary serves.
 *
 * So widen a copy, here at the CLI read seam and nowhere else: a hop's model
 * joins the models of the provider its own `instanceId` names. Matching on the
 * instance id is what keeps this honest — an id is the routing identity, so a
 * hop can only ever teach the one account it names, never a provider on another
 * driver. Everything else about eligibility still holds: an uninstalled,
 * disabled or unauthenticated provider stays ineligible, and a hop naming an
 * account this run does not have is still dropped.
 */
export const widenInventoryWithPolicyModels = (
  providers: ReadonlyArray<ServerProvider>,
  policy: EpicRolePolicy,
): ReadonlyArray<ServerProvider> => {
  const hops = Object.values(policy.tiers).flatMap((tier) => tier.hops);
  if (hops.length === 0) return providers;

  return providers.map((provider) => {
    const known = new Set(provider.models.map((model) => model.slug));
    const added = hops.flatMap((hop) => {
      const { instanceId, model } = hop.selection;
      if (instanceId !== provider.instanceId || model === "" || known.has(model)) return [];
      known.add(model);
      return [{ slug: model, name: model, isCustom: false, capabilities: null }];
    });
    if (added.length === 0) return provider;
    return { ...provider, models: [...provider.models, ...added] };
  });
};

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
      providers: widenInventoryWithPolicyModels(providers, policy),
      sessionInstanceId: input.sessionSelection.instanceId,
    });
  }).pipe(
    // The port declares an inventory that cannot fail, and the real one is a
    // `spawnSync` per candidate binary wrapped in `Effect.sync` — so a probe
    // that dies arrives as a defect, not a failure. Catch both: no stage agent
    // is worth crashing a cook over.
    Effect.catchDefect(() => Effect.succeed<EpicSubagentMap>({})),
    Effect.orElseSucceed((): EpicSubagentMap => ({})),
  );
