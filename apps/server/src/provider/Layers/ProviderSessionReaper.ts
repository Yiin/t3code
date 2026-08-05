import { CommandId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
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
  /**
   * How long the active-turn skip may hold a session before the turn counts as
   * dead. Deliberately not covered by `inactivityThresholdMs`: the shorthand
   * means "idle threshold", and folding the cap into it would turn every short
   * test threshold into an instant kill for in-flight turns.
   */
  readonly activeTurnSkipCapMs?: number;
  /**
   * How recently a `running` subagent row must have been touched to keep its
   * quiet session alive. Like the skip cap, deliberately not covered by
   * `inactivityThresholdMs`: it is a freshness window, not an idle threshold.
   */
  readonly subagentFreshnessWindowMs?: number;
  readonly sweepIntervalMs?: number;
}

const makeProviderSessionReaper = (options?: ProviderSessionReaperLiveOptions) =>
  Effect.gen(function* () {
    const providerService = yield* ProviderService;
    const directory = yield* ProviderSessionDirectory;
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const orchestrationEngine = yield* OrchestrationEngineService;

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
      activeTurnSkipCapMs: Math.max(
        1,
        options?.activeTurnSkipCapMs ?? DEFAULT_SESSION_REAP_THRESHOLDS.activeTurnSkipCapMs,
      ),
      subagentFreshnessWindowMs: Math.max(
        1,
        options?.subagentFreshnessWindowMs ??
          DEFAULT_SESSION_REAP_THRESHOLDS.subagentFreshnessWindowMs,
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

        // The liveness read only happens when the shell already reports running
        // subagent rows, so the common quiet session costs no extra query.
        let activeSubagentCount = thread?.activeSubagentCount ?? 0;
        let newestRunningSubagentAgeMs: number | null = null;
        if (activeSubagentCount > 0) {
          const liveness = yield* projectionSnapshotQuery.getThreadSubagentLiveness(
            binding.threadId,
          );
          activeSubagentCount = liveness.activeSubagentCount;
          const newestMs =
            liveness.newestRunningUpdatedAt === null
              ? Number.NaN
              : Date.parse(liveness.newestRunningUpdatedAt);
          newestRunningSubagentAgeMs = Number.isNaN(newestMs) ? null : now - newestMs;
        }

        const decision = decideSessionReap({
          threadId: binding.threadId,
          status: binding.status,
          idleDurationMs,
          settledOverride: thread?.settledOverride ?? null,
          activeTurnId: thread?.session?.activeTurnId ?? null,
          activeSubagentCount,
          newestRunningSubagentAgeMs,
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
          if (decision.reason === "active_subagent") {
            yield* Effect.logDebug("provider.session.reaper.skipped-active-subagent", {
              threadId: binding.threadId,
              activeSubagentCount,
              newestRunningSubagentAgeMs,
              idleDurationMs,
            });
          }
          continue;
        }

        if (decision.reason === "stale_active_turn") {
          // The turn pointer outlived the cap, so the turn is dead and nothing
          // upstream cleared it. Worth a warning: the reap is correct, but the
          // stale pointer it papers over is a bug somewhere else.
          yield* Effect.logWarning("provider.session.reaper.stale-active-turn", {
            threadId: binding.threadId,
            activeTurnId: thread?.session?.activeTurnId,
            idleDurationMs,
            activeTurnSkipCapMs: decision.thresholdMs,
          });
        }

        // Stop through the `thread.session.stop` command path (decider ->
        // thread.session-stop-requested -> ProviderCommandReactor), mirroring
        // ThreadTeardownReactor: only that path also writes the projected
        // session to stopped and nulls its active turn pointer. A direct
        // `providerService.stopSession` updates only the binding, so after a
        // reap every projection consumer would keep seeing the last status —
        // for a stale_active_turn reap, a running turn forever. A thread the
        // orchestration read model does not know refuses the command, so the
        // direct call stays as the fallback that still stops the adapter
        // session.
        const stopReapedSession = orchestrationEngine
          .dispatch({
            type: "thread.session.stop",
            commandId: CommandId.make(`session-stop-for-reap:${binding.threadId}:${now}`),
            threadId: binding.threadId,
            createdAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
          })
          .pipe(
            Effect.asVoid,
            Effect.catch((dispatchError) =>
              Effect.logDebug("provider.session.reaper.stop-dispatch-fallback", {
                threadId: binding.threadId,
                provider: binding.provider,
                detail: dispatchError.message,
              }).pipe(Effect.andThen(providerService.stopSession({ threadId: binding.threadId }))),
            ),
          );

        const reaped = yield* stopReapedSession.pipe(
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
