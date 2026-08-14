/**
 * The `t3 epic cook` CLI's start selection, degradation aware.
 *
 * The server resolves this in `EpicRunnerLaunch.resolveLaunchModelSelection`
 * against the SQLite store. A terminal cook has neither the store nor the
 * server config, so it reads the same two inputs from disk: the epic role
 * policy from `settings.json`, and provider health from the workspace-scoped
 * `provider-degradations.json` a previous cook wrote. The walk itself is
 * shared, so both sides reach the same verdict.
 *
 * Fail-soft throughout. An unreadable policy or degradation file keeps the
 * configured selection, because refusing to start a run is worse than starting
 * it on an account that may still be rate limited.
 *
 * Deliberately narrower than the server (t3code-4hh.10): the server also
 * blocks exhausted accounts from live usage windows and limit rows, but those
 * live in SQLite and a terminal cook has no database. This twin stays on
 * degradations alone.
 */
import type { EpicRoleId, ModelSelection, ProviderInstanceId } from "@t3tools/contracts";
import type { ProviderInventoryShape } from "@t3tools/epic-core/ports/ProviderInventory";
import {
  epicDispatchRoleId,
  type EpicDispatchRole,
  type ResolvedRoleFallbackChain,
  type ResolvedRoleSelection,
  type RoleSelectionShape,
} from "@t3tools/epic-core/ports/RoleSelection";
import type { RunJournalError } from "@t3tools/epic-core/ports/RunJournal";
import {
  isLiveProviderDegradation,
  resolveDegradationAwareSelection,
  type DegradationAwareSelection,
  type ProviderDegradationRecord,
} from "@t3tools/epic-core/providerDegradation";
import {
  epicRoleFallbackChain,
  resolveEpicProviderChainEntry,
} from "@t3tools/epic-core/providerFallback";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { readEpicRolePolicy, widenInventoryWithPolicyModels } from "./epicCookSubagents.ts";

/** The run-level selection is the iteration worker's, so cook resolves that role. */
const ITERATION_WORKER_ROLE: EpicRoleId = "iteration-worker";

export const makeTerminalRoleSelection = (input: {
  readonly settingsPath: string;
  readonly inventory: ProviderInventoryShape;
  readonly readProviderDegradations: Effect.Effect<
    Readonly<Record<string, ProviderDegradationRecord>>,
    RunJournalError
  >;
  readonly providerDegradationTtlMs: number;
}): Effect.Effect<RoleSelectionShape, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const emptyChain = (): ResolvedRoleFallbackChain => ({
      chain: [],
      isBlocked: () => false,
      isInstanceBlocked: () => false,
    });
    const readRoleState = (role: EpicDispatchRole) =>
      Effect.gen(function* () {
        const checkedAt = yield* DateTime.now;
        const now = DateTime.formatIso(checkedAt);
        const cutoff = DateTime.formatIso(
          DateTime.subtractDuration(checkedAt, Duration.millis(input.providerDegradationTtlMs)),
        );
        const policy = yield* readEpicRolePolicy(input.settingsPath).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
        );
        const providers = widenInventoryWithPolicyModels(
          yield* input.inventory.getProviders,
          policy,
        );
        const recorded = yield* input.readProviderDegradations;
        const roleId = epicDispatchRoleId(role);
        const tierId = policy.roles[roleId];
        const chain = epicRoleFallbackChain(policy, roleId);
        const isInstanceBlocked = (instanceId: ProviderInstanceId) => {
          const degradation = recorded[instanceId];
          return degradation !== undefined && isLiveProviderDegradation(degradation, cutoff, now);
        };
        const isBlocked = (hop: (typeof chain)[number]) => isInstanceBlocked(hop.instanceId);
        return { providers, tierId, chain, isBlocked, isInstanceBlocked };
      });
    return {
      chain: (role) =>
        readRoleState(role).pipe(
          Effect.map(({ chain, isBlocked, isInstanceBlocked }) => ({
            chain,
            isBlocked,
            isInstanceBlocked,
          })),
          Effect.catchCause(() => Effect.succeed(emptyChain())),
        ),
      resolve: (request) => {
        const fallback = (): ResolvedRoleSelection => ({
          selection: request.fallbackSelection,
          tierId: null,
        });
        return readRoleState(request.role).pipe(
          Effect.map(({ providers, tierId, chain, isBlocked }) => {
            if (tierId === undefined) return fallback();
            if (chain.length === 0) return fallback();
            const selection = resolveEpicProviderChainEntry({
              providers,
              chain,
              isBlocked,
            });
            return selection === null ? fallback() : { selection, tierId };
          }),
          Effect.catchCause(() => Effect.succeed(fallback())),
        );
      },
    } satisfies RoleSelectionShape;
  });

export const resolveCookModelSelection = (input: {
  readonly settingsPath: string;
  readonly inventory: ProviderInventoryShape;
  /** The workspace-scoped degradation file, read fresh for this cook. */
  readonly readProviderDegradations: Effect.Effect<
    Readonly<Record<string, ProviderDegradationRecord>>,
    RunJournalError
  >;
  readonly selection: ModelSelection;
  readonly providerDegradationTtlMs: number;
}): Effect.Effect<DegradationAwareSelection, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const recorded = yield* input.readProviderDegradations;
    const checkedAt = yield* DateTime.now;
    const now = DateTime.formatIso(checkedAt);
    const cutoff = DateTime.formatIso(
      DateTime.subtractDuration(checkedAt, Duration.millis(input.providerDegradationTtlMs)),
    );
    const live = new Map<string, ProviderDegradationRecord>(
      Object.entries(recorded).filter(([, record]) =>
        isLiveProviderDegradation(record, cutoff, now),
      ),
    );
    // No live record means nothing to route around, and `getProviders` shells
    // out once per candidate binary, so skip the probe entirely.
    if (live.size === 0) return { selection: input.selection, hops: [] };

    const policy = yield* readEpicRolePolicy(input.settingsPath);
    const providers = yield* input.inventory.getProviders;
    return resolveDegradationAwareSelection({
      providers,
      chain: epicRoleFallbackChain(policy, ITERATION_WORKER_ROLE),
      current: input.selection,
      degradationOf: (instanceId) => live.get(instanceId) ?? null,
    });
  }).pipe(
    Effect.orElseSucceed(
      (): DegradationAwareSelection => ({ selection: input.selection, hops: [] }),
    ),
  );
