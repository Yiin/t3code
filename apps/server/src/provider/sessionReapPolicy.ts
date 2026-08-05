import { parseEpicRunIterationThreadId } from "@t3tools/contracts";

import { RUNNING_SUBAGENT_FRESHNESS_MS } from "../orchestration/subagentLiveness.ts";

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

/**
 * Upper bound on the active-turn skip. The skip is what lets a three-hour
 * render survive any idle threshold, but a turn that dies with `activeTurnId`
 * still set would otherwise make its session immortal — and every leaked
 * session pins a subprocess and a git worktree.
 *
 * `binding.lastSeenAt` refreshes on session start, session recovery, sendTurn,
 * and — throttled to once a minute per thread — on streamed runtime activity
 * (message deltas, tool progress, subagent task.progress; see
 * `touchBindingLastSeen` in ProviderServiceLive). So idle age for a session
 * that is producing output stays near zero, and the cap only decides the fate
 * of a turn that is genuinely silent: 24 hours permits a full day of quiet
 * wall-clock work and bounds the leak at a day.
 */
export const DEFAULT_ACTIVE_TURN_SKIP_CAP_MS = 24 * 60 * 60 * 1000;

/**
 * How recently a `running` subagent row must have been touched for the session
 * to count as actively working. Sourced from the shared liveness bound so
 * "still working" means the same thing to the settle decider, the auto-settle
 * sweep and the reaper.
 */
export const DEFAULT_SUBAGENT_FRESHNESS_WINDOW_MS = RUNNING_SUBAGENT_FRESHNESS_MS;

export interface SessionReapThresholds {
  readonly interactiveIdleThresholdMs: number;
  readonly epicRunIterationIdleThresholdMs: number;
  readonly settledIdleThresholdMs: number;
  readonly activeTurnSkipCapMs: number;
  /**
   * Freshness window for the subagent skip, not an idle threshold: it never
   * reaps anything on its own, so `minSessionReapThresholdMs` excludes it.
   */
  readonly subagentFreshnessWindowMs: number;
}

export const DEFAULT_SESSION_REAP_THRESHOLDS: SessionReapThresholds = {
  interactiveIdleThresholdMs: DEFAULT_INTERACTIVE_IDLE_THRESHOLD_MS,
  epicRunIterationIdleThresholdMs: DEFAULT_EPIC_RUN_ITERATION_IDLE_THRESHOLD_MS,
  settledIdleThresholdMs: DEFAULT_SETTLED_IDLE_THRESHOLD_MS,
  activeTurnSkipCapMs: DEFAULT_ACTIVE_TURN_SKIP_CAP_MS,
  subagentFreshnessWindowMs: DEFAULT_SUBAGENT_FRESHNESS_WINDOW_MS,
};

export type SessionReapThreadKind = "interactive" | "epic-run-iteration";

export type SessionReapReason =
  /** Keep: the binding is already torn down. */
  | "session_stopped"
  /** Keep: the session has not been idle long enough for its threshold. */
  | "within_idle_threshold"
  /** Keep: a turn is still attached to the thread and is inside the skip cap. */
  | "active_turn"
  /** Keep: a fresh running subagent is still working the thread, inside the skip cap. */
  | "active_subagent"
  /** Reap: a turn is still attached, but it outlived the skip cap, so it is dead. */
  | "stale_active_turn"
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
  /** `activeSubagentCount` from the thread shell: `running` subagent rows on the thread. */
  readonly activeSubagentCount?: number;
  /**
   * Age of the newest `running` subagent row (now minus its `updatedAt`), or
   * null when there is none or its timestamp is unreadable. The caller computes
   * the age so the policy stays clock-free; a future timestamp (negative age)
   * simply reads fresh, matching `countFreshRunningSubagents`.
   */
  readonly newestRunningSubagentAgeMs?: number | null;
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
 * shell read below this, because every value a decision compares the idle age
 * against is one of these four and so can never be smaller.
 */
export const minSessionReapThresholdMs = (
  thresholds: SessionReapThresholds = DEFAULT_SESSION_REAP_THRESHOLDS,
): number =>
  Math.min(
    thresholds.interactiveIdleThresholdMs,
    thresholds.epicRunIterationIdleThresholdMs,
    thresholds.settledIdleThresholdMs,
    thresholds.activeTurnSkipCapMs,
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

  // Before the idle compare, because the cap can be shorter than the kind's
  // threshold — a 25-hour-old turn on a 36-hour interactive thread is stale.
  if (input.activeTurnId !== null) {
    const capMs = thresholds.activeTurnSkipCapMs;
    return input.idleDurationMs < capMs
      ? { reap: false, reason: "active_turn", threadKind, thresholdMs: capMs }
      : { reap: true, reason: "stale_active_turn", threadKind, thresholdMs: capMs };
  }

  // A fresh running subagent is in-flight work even when the main stream is
  // quiet — exactly the state after an adapter falsely reports turn end while
  // a Task subagent still works. The freshness window keeps a stranded row
  // from blocking forever, and the skip cap bounds the keep like the active
  // turn's; past the cap the ordinary idle rules apply.
  const subagentAgeMs = input.newestRunningSubagentAgeMs ?? null;
  if (
    (input.activeSubagentCount ?? 0) > 0 &&
    subagentAgeMs !== null &&
    subagentAgeMs < thresholds.subagentFreshnessWindowMs &&
    input.idleDurationMs < thresholds.activeTurnSkipCapMs
  ) {
    return {
      reap: false,
      reason: "active_subagent",
      threadKind,
      thresholdMs: thresholds.activeTurnSkipCapMs,
    };
  }

  if (input.idleDurationMs < thresholdMs) {
    return { reap: false, reason: "within_idle_threshold", threadKind, thresholdMs };
  }

  return { reap: true, reason, threadKind, thresholdMs };
};
