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
 */
import type { EpicRoleId, ModelSelection } from "@t3tools/contracts";
import type { ProviderInventoryShape } from "@t3tools/epic-core/ports/ProviderInventory";
import type { RunJournalError } from "@t3tools/epic-core/ports/RunJournal";
import {
  isLiveProviderDegradation,
  resolveDegradationAwareSelection,
  type DegradationAwareSelection,
  type ProviderDegradationRecord,
} from "@t3tools/epic-core/providerDegradation";
import { epicRoleFallbackChain } from "@t3tools/epic-core/providerFallback";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";

import { readEpicRolePolicy } from "./epicCookSubagents.ts";

/** The run-level selection is the iteration worker's, so cook resolves that role. */
const ITERATION_WORKER_ROLE: EpicRoleId = "iteration-worker";

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
    const cutoff = DateTime.formatIso(
      DateTime.subtractDuration(
        yield* DateTime.now,
        Duration.millis(input.providerDegradationTtlMs),
      ),
    );
    const live = new Map<string, ProviderDegradationRecord>(
      Object.entries(recorded).filter(([, record]) => isLiveProviderDegradation(record, cutoff)),
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
