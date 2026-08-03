import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";

import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  DEFAULT_SESSION_REAP_THRESHOLDS,
  decideSessionReap,
  minSessionReapThresholdMs,
  type SessionReapThresholds,
} from "../sessionReapPolicy.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import {
  ProviderSessionReaper,
  type ProviderSessionReaperShape,
} from "../Services/ProviderSessionReaper.ts";
import { ProviderService } from "../Services/ProviderService.ts";

const DEFAULT_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

export interface ProviderSessionReaperLiveOptions {
  /** Back-compat shorthand: sets every per-kind threshold that is not set on its own. */
  readonly inactivityThresholdMs?: number;
  readonly interactiveIdleThresholdMs?: number;
  readonly epicRunIterationIdleThresholdMs?: number;
  readonly settledIdleThresholdMs?: number;
  readonly sweepIntervalMs?: number;
}

const makeProviderSessionReaper = (options?: ProviderSessionReaperLiveOptions) =>
  Effect.gen(function* () {
    const providerService = yield* ProviderService;
    const directory = yield* ProviderSessionDirectory;
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;

    const thresholdMs = (override: number | undefined, fallback: number) =>
      Math.max(1, override ?? options?.inactivityThresholdMs ?? fallback);

    const thresholds: SessionReapThresholds = {
      interactiveIdleThresholdMs: thresholdMs(
        options?.interactiveIdleThresholdMs,
        DEFAULT_SESSION_REAP_THRESHOLDS.interactiveIdleThresholdMs,
      ),
      epicRunIterationIdleThresholdMs: thresholdMs(
        options?.epicRunIterationIdleThresholdMs,
        DEFAULT_SESSION_REAP_THRESHOLDS.epicRunIterationIdleThresholdMs,
      ),
      settledIdleThresholdMs: thresholdMs(
        options?.settledIdleThresholdMs,
        DEFAULT_SESSION_REAP_THRESHOLDS.settledIdleThresholdMs,
      ),
    };
    const shortestThresholdMs = minSessionReapThresholdMs(thresholds);
    const sweepIntervalMs = Math.max(1, options?.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS);

    const sweep = Effect.gen(function* () {
      const bindings = yield* directory.listBindings();
      const now = yield* Clock.currentTimeMillis;
      let reapedCount = 0;

      for (const binding of bindings) {
        if (binding.status === "stopped") {
          continue;
        }

        const lastSeenMs = Date.parse(binding.lastSeenAt);
        if (Number.isNaN(lastSeenMs)) {
          yield* Effect.logWarning("provider.session.reaper.invalid-last-seen", {
            threadId: binding.threadId,
            provider: binding.provider,
            lastSeenAt: binding.lastSeenAt,
          });
          continue;
        }

        const idleDurationMs = now - lastSeenMs;
        // No threshold can fire below the shortest one, so a fresh session
        // never costs a thread shell read.
        if (idleDurationMs < shortestThresholdMs) {
          continue;
        }

        const thread = yield* projectionSnapshotQuery
          .getThreadShellById(binding.threadId)
          .pipe(Effect.map(Option.getOrUndefined));

        const decision = decideSessionReap({
          threadId: binding.threadId,
          status: binding.status,
          idleDurationMs,
          settledOverride: thread?.settledOverride ?? null,
          activeTurnId: thread?.session?.activeTurnId ?? null,
          thresholds,
        });

        if (!decision.reap) {
          if (decision.reason === "active_turn") {
            yield* Effect.logDebug("provider.session.reaper.skipped-active-turn", {
              threadId: binding.threadId,
              activeTurnId: thread?.session?.activeTurnId,
              idleDurationMs,
            });
          }
          continue;
        }

        const reaped = yield* providerService.stopSession({ threadId: binding.threadId }).pipe(
          Effect.tap(() =>
            Effect.logInfo("provider.session.reaped", {
              threadId: binding.threadId,
              provider: binding.provider,
              idleDurationMs,
              threadKind: decision.threadKind,
              thresholdMs: decision.thresholdMs,
              reason: decision.reason,
            }),
          ),
          Effect.as(true),
          Effect.catchCause((cause) =>
            Effect.logWarning("provider.session.reaper.stop-failed", {
              threadId: binding.threadId,
              provider: binding.provider,
              idleDurationMs,
              cause,
            }).pipe(Effect.as(false)),
          ),
        );

        if (reaped) {
          reapedCount += 1;
        }
      }

      if (reapedCount > 0) {
        yield* Effect.logInfo("provider.session.reaper.sweep-complete", {
          reapedCount,
          totalBindings: bindings.length,
        });
      }
    });

    const start: ProviderSessionReaperShape["start"] = () =>
      Effect.gen(function* () {
        yield* Effect.forkScoped(
          sweep.pipe(
            Effect.catch((error: unknown) =>
              Effect.logWarning("provider.session.reaper.sweep-failed", {
                error,
              }),
            ),
            Effect.catchDefect((defect: unknown) =>
              Effect.logWarning("provider.session.reaper.sweep-defect", {
                defect,
              }),
            ),
            Effect.repeat(Schedule.spaced(Duration.millis(sweepIntervalMs))),
          ),
        );

        yield* Effect.logInfo("provider.session.reaper.started", {
          ...thresholds,
          sweepIntervalMs,
        });
      });

    return {
      start,
    } satisfies ProviderSessionReaperShape;
  });

export const makeProviderSessionReaperLive = (options?: ProviderSessionReaperLiveOptions) =>
  Layer.effect(ProviderSessionReaper, makeProviderSessionReaper(options));

export const ProviderSessionReaperLive = makeProviderSessionReaperLive();
