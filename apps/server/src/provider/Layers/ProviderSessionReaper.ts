import { CommandId, type ThreadId } from "@t3tools/contracts";
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
  type SessionReapReason,
  type SessionReapThresholds,
} from "../sessionReapPolicy.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import type { ProviderRuntimeBindingWithMetadata } from "../Services/ProviderSessionDirectory.ts";
import {
  ProviderSessionReaper,
  type ProviderSessionReaperShape,
} from "../Services/ProviderSessionReaper.ts";
import { ProviderService } from "../Services/ProviderService.ts";

const DEFAULT_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const BOOT_RECONCILE_STOP_TIMEOUT = Duration.seconds(15);
const BOOT_RECONCILE_STOP_POLL_INTERVAL = Duration.millis(50);
const BOOT_RECONCILE_STOP_REASON =
  "session interrupted: server restarted while the session was running";

const periodicStopReason = (reason: SessionReapReason): string => {
  switch (reason) {
    case "no_live_session":
      return "session reaped: no live provider process";
    case "stale_active_turn":
      return "session reaped: active turn exceeded its inactivity limit";
    case "interactive_idle_threshold":
      return "session reaped: interactive session exceeded its idle limit";
    case "epic_run_iteration_idle_threshold":
      return "session reaped: epic run iteration exceeded its idle limit";
    case "settled_idle_threshold":
      return "session reaped: settled session exceeded its idle limit";
    case "active_pin_idle_threshold":
      return "session reaped: keep-active session exceeded its idle limit";
    case "session_stopped":
    case "within_idle_threshold":
    case "active_turn":
    case "active_subagent":
      throw new Error(`Cannot create a stop reason for non-reap decision: ${reason}`);
  }
};

export interface ProviderSessionReaperLiveOptions {
  /** Back-compat shorthand: sets every per-kind threshold that is not set on its own. */
  readonly inactivityThresholdMs?: number;
  readonly interactiveIdleThresholdMs?: number;
  readonly epicRunIterationIdleThresholdMs?: number;
  readonly settledIdleThresholdMs?: number;
  /** Grace for ingestion to persist an adapter session's normal exit. */
  readonly deadSessionGraceMs?: number;
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
      deadSessionGraceMs: Math.max(
        1,
        options?.deadSessionGraceMs ?? DEFAULT_SESSION_REAP_THRESHOLDS.deadSessionGraceMs,
      ),
      subagentFreshnessWindowMs: Math.max(
        1,
        options?.subagentFreshnessWindowMs ??
          DEFAULT_SESSION_REAP_THRESHOLDS.subagentFreshnessWindowMs,
      ),
    };
    const shortestThresholdMs = minSessionReapThresholdMs(thresholds);
    const sweepIntervalMs = Math.max(1, options?.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS);

    const readLiveSession = Effect.fn("ProviderSessionReaper.readLiveSession")(function* (
      threadId: ThreadId,
    ) {
      return yield* providerService.hasLiveSession(threadId).pipe(
        Effect.map(Option.some),
        Effect.catch((error) =>
          Effect.logWarning("provider.session.reaper.liveness-check-failed", {
            threadId,
            error,
          }).pipe(Effect.as(Option.none<boolean>())),
        ),
      );
    });

    const bindingIsStillDead = Effect.fn("ProviderSessionReaper.bindingIsStillDead")(function* (
      binding: ProviderRuntimeBindingWithMetadata,
    ) {
      const bindingStillMatches = (current: ProviderRuntimeBindingWithMetadata | undefined) =>
        current !== undefined &&
        current.status !== "stopped" &&
        current.provider === binding.provider &&
        current.providerInstanceId === binding.providerInstanceId &&
        current.adapterKey === binding.adapterKey &&
        current.lastSeenAt === binding.lastSeenAt;

      if (
        !bindingStillMatches(Option.getOrUndefined(yield* directory.getBinding(binding.threadId)))
      ) {
        return false;
      }

      const currentLiveSession = yield* readLiveSession(binding.threadId);
      if (Option.isNone(currentLiveSession) || currentLiveSession.value) {
        return false;
      }

      // The liveness read can yield while a recovery replaces this binding.
      // Re-read its identity before dispatching the stop.
      return bindingStillMatches(
        Option.getOrUndefined(yield* directory.getBinding(binding.threadId)),
      );
    });

    const stopBinding = Effect.fn("ProviderSessionReaper.stopBinding")(function* (input: {
      readonly binding: ProviderRuntimeBindingWithMetadata;
      readonly commandId: string;
      readonly now: number;
      readonly reason: string;
    }) {
      const { binding, commandId, now, reason } = input;
      // Stop through the `thread.session.stop` command path (decider ->
      // thread.session-stop-requested -> ProviderCommandReactor). Only that
      // path also stops the projected session and settles its active turn. A
      // thread absent from the read model refuses the command, so retain the
      // direct adapter stop as the fallback.
      yield* orchestrationEngine
        .dispatch({
          type: "thread.session.stop",
          commandId: CommandId.make(commandId),
          threadId: binding.threadId,
          createdAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
          reason,
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
    });

    const waitForProjectedStop = Effect.fn("ProviderSessionReaper.waitForProjectedStop")(function* (
      threadId: ThreadId,
    ) {
      yield* projectionSnapshotQuery.getThreadSessionById(threadId).pipe(
        Effect.map(
          Option.match({
            onNone: () => false,
            onSome: (session) => session.status !== "stopped",
          }),
        ),
        Effect.repeat({
          while: (isRunning) => isRunning,
          schedule: Schedule.spaced(BOOT_RECONCILE_STOP_POLL_INTERVAL),
        }),
        Effect.timeout(BOOT_RECONCILE_STOP_TIMEOUT),
      );
    });

    const stopBindingIfStillDead = Effect.fn("ProviderSessionReaper.stopBindingIfStillDead")(
      function* (binding: ProviderRuntimeBindingWithMetadata) {
        // A stale projection can already say stopped. In that case the command
        // reactor skips its adapter stop, so settle the unchanged dead binding
        // directly after the projected stop is confirmed.
        if (yield* bindingIsStillDead(binding)) {
          yield* providerService.stopSession({ threadId: binding.threadId });
        }
      },
    );

    const reconcileBootBindings = Effect.fn("ProviderSessionReaper.reconcileBootBindings")(
      function* () {
        const bindings = yield* directory.listBindings();
        const now = yield* Clock.currentTimeMillis;
        let reconciledCount = 0;

        for (const binding of bindings) {
          if (binding.status === "stopped" || !(yield* bindingIsStillDead(binding))) {
            continue;
          }

          const reconciled = yield* stopBinding({
            binding,
            commandId: `session-stop-for-boot-reconcile:${binding.threadId}:${now}`,
            now,
            reason: BOOT_RECONCILE_STOP_REASON,
          }).pipe(
            Effect.andThen(waitForProjectedStop(binding.threadId)),
            Effect.andThen(stopBindingIfStillDead(binding)),
            Effect.tap(() =>
              Effect.logInfo("provider.session.boot-reconciled", {
                threadId: binding.threadId,
                provider: binding.provider,
              }),
            ),
            Effect.as(true),
            Effect.catchCause((cause) =>
              Effect.logWarning("provider.session.reaper.boot-reconcile-stop-failed", {
                threadId: binding.threadId,
                provider: binding.provider,
                cause,
              }).pipe(Effect.as(false)),
            ),
          );

          if (reconciled) {
            reconciledCount += 1;
          }
        }

        return reconciledCount;
      },
    );

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

        const liveSession = yield* readLiveSession(binding.threadId);
        if (Option.isNone(liveSession)) {
          continue;
        }
        const hasLiveAdapterSession = liveSession.value;

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
          hasLiveAdapterSession,
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

        if (decision.reason === "no_live_session") {
          // A session can resume while the sweep reads the thread shell. Check
          // both persisted and in-memory state again before dispatching a stop.
          if (!(yield* bindingIsStillDead(binding))) {
            continue;
          }
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

        const reaped = yield* stopBinding({
          binding,
          commandId: `session-stop-for-reap:${binding.threadId}:${now}`,
          now,
          reason: periodicStopReason(decision.reason),
        }).pipe(
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
        const reconciledCount = yield* reconcileBootBindings().pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("provider.session.reaper.boot-reconcile-failed", { cause }).pipe(
              Effect.as(0),
            ),
          ),
        );
        yield* Effect.logInfo("provider.session.reaper.boot-reconcile-complete", {
          reconciledCount,
        });

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
