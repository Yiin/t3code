import { parseEpicRunIterationThreadId } from "@t3tools/contracts";

/**
 * Idle backstop for an ordinary interactive thread. Long on purpose: teardown
 * is settle-driven now, so the reaper only has to catch a session nobody ever
 * settles. Long-running work is protected by the active-turn skip, not by this.
 */
export const DEFAULT_INTERACTIVE_IDLE_THRESHOLD_MS = 36 * 60 * 60 * 1000;

/**
 * Idle backstop for an epic-runner iteration thread. Short, because the runner
 * settles each finished iteration itself and an unattended run would otherwise
 * hold one resident subprocess per iteration.
 */
export const DEFAULT_EPIC_RUN_ITERATION_IDLE_THRESHOLD_MS = 30 * 60 * 1000;

/**
 * Idle backstop for a thread that is already settled. Short, so a settle whose
 * teardown failed still gets collected instead of waiting out the interactive
 * backstop.
 */
export const DEFAULT_SETTLED_IDLE_THRESHOLD_MS = 30 * 60 * 1000;

export interface SessionReapThresholds {
  readonly interactiveIdleThresholdMs: number;
  readonly epicRunIterationIdleThresholdMs: number;
  readonly settledIdleThresholdMs: number;
}

export const DEFAULT_SESSION_REAP_THRESHOLDS: SessionReapThresholds = {
  interactiveIdleThresholdMs: DEFAULT_INTERACTIVE_IDLE_THRESHOLD_MS,
  epicRunIterationIdleThresholdMs: DEFAULT_EPIC_RUN_ITERATION_IDLE_THRESHOLD_MS,
  settledIdleThresholdMs: DEFAULT_SETTLED_IDLE_THRESHOLD_MS,
};

export type SessionReapThreadKind = "interactive" | "epic-run-iteration";

export type SessionReapReason =
  /** Keep: the binding is already torn down. */
  | "session_stopped"
  /** Keep: the session has not been idle long enough for its threshold. */
  | "within_idle_threshold"
  /** Keep: a turn is still attached to the thread. */
  | "active_turn"
  /** Reap: idle past the interactive backstop. */
  | "interactive_idle_threshold"
  /** Reap: idle past the epic-runner iteration backstop. */
  | "epic_run_iteration_idle_threshold"
  /** Reap: the thread is settled and its session outlived the settle. */
  | "settled_idle_threshold"
  /** Reap: idle past the backstop that even a keep-active pin gets. */
  | "active_pin_idle_threshold";

export interface SessionReapDecision {
  readonly reap: boolean;
  /** Feeds the `provider.session.reaped` / skip logs. */
  readonly reason: SessionReapReason;
  readonly threadKind: SessionReapThreadKind;
  /** The threshold the idle age was compared against. */
  readonly thresholdMs: number;
}

export interface SessionReapInput {
  readonly threadId: string;
  /** `binding.status` from the provider session directory. */
  readonly status: string | undefined;
  readonly idleDurationMs: number;
  /** `settledOverride` from the thread shell: an explicit settle or keep-active pin. */
  readonly settledOverride: "settled" | "active" | null;
  readonly activeTurnId: string | null;
  readonly thresholds?: SessionReapThresholds;
}

/**
 * Iteration threads are identified by parsing their id — a documented contract
 * with a round-trip test. The `epic_run_iterations` table also carries the
 * thread id, but nothing queries it by that column and it has no index, so a
 * lookup there would be a full scan.
 */
export const sessionReapThreadKind = (threadId: string): SessionReapThreadKind =>
  parseEpicRunIterationThreadId(threadId) === null ? "interactive" : "epic-run-iteration";

/**
 * The smallest idle age that can reap anything. A caller can skip the thread
 * shell read below this, because the chosen threshold is always one of the
 * three and so can never be smaller.
 */
export const minSessionReapThresholdMs = (
  thresholds: SessionReapThresholds = DEFAULT_SESSION_REAP_THRESHOLDS,
): number =>
  Math.min(
    thresholds.interactiveIdleThresholdMs,
    thresholds.epicRunIterationIdleThresholdMs,
    thresholds.settledIdleThresholdMs,
  );

/**
 * Decides whether the reaper should stop one provider session. Pure and
 * synchronous: every input the decision needs is already in hand at the call
 * site, so this stays trivially testable.
 */
export const decideSessionReap = (input: SessionReapInput): SessionReapDecision => {
  const thresholds = input.thresholds ?? DEFAULT_SESSION_REAP_THRESHOLDS;
  const threadKind = sessionReapThreadKind(input.threadId);

  const { reason, thresholdMs } =
    input.settledOverride === "settled"
      ? ({
          reason: "settled_idle_threshold",
          thresholdMs: thresholds.settledIdleThresholdMs,
        } as const)
      : input.settledOverride === "active"
        ? // An explicit keep-active pin buys the long backstop, not an immortal
          // session.
          ({
            reason: "active_pin_idle_threshold",
            thresholdMs: thresholds.interactiveIdleThresholdMs,
          } as const)
        : threadKind === "epic-run-iteration"
          ? ({
              reason: "epic_run_iteration_idle_threshold",
              thresholdMs: thresholds.epicRunIterationIdleThresholdMs,
            } as const)
          : ({
              reason: "interactive_idle_threshold",
              thresholdMs: thresholds.interactiveIdleThresholdMs,
            } as const);

  if (input.status === "stopped") {
    return { reap: false, reason: "session_stopped", threadKind, thresholdMs };
  }

  if (input.idleDurationMs < thresholdMs) {
    return { reap: false, reason: "within_idle_threshold", threadKind, thresholdMs };
  }

  if (input.activeTurnId !== null) {
    return { reap: false, reason: "active_turn", threadKind, thresholdMs };
  }

  return { reap: true, reason, threadKind, thresholdMs };
};
