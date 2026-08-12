/**
 * Run-level stall detection: the single owner of "this run says running and is
 * not moving".
 *
 * Every incident behind this module looked identical to a healthy run. The run
 * lock keeps heartbeating on its own timer, the store still reads `running`,
 * and with no worker alive there is nothing for a human to see as wrong. One
 * deferred merge drain spun that way for 8 hours; one epic sat idle for 9.5
 * hours. Both were only found by someone eventually looking.
 *
 * The rule is deliberately narrow. A stall is the *scheduler* failing to move,
 * never a worker taking a long time: one unit of epic work can legitimately run
 * for hours, and killing a run for that would be far worse than the silence
 * this replaces. So a wait with live workers can only ever warn — the worker
 * timeout and `workerSupervision.ts` own that verdict — while a wait with no
 * worker running and nothing dispatched is terminal.
 */

/** What the loop is waiting on at the moment progress is measured. */
export type RunWait =
  /** A merge drain that cannot take the merge slot, so no branch can land. */
  | { readonly _tag: "merge-slot"; readonly holder: string | null }
  /** Workers are running. Never terminal; the worker layer owns their fate. */
  | { readonly _tag: "workers"; readonly issueIds: ReadonlyArray<string> }
  /** No worker runs and the scheduler dispatched nothing. */
  | { readonly _tag: "scheduler" };

export type RunStallVerdict =
  | { readonly _tag: "ok" }
  /** Past the window, but something is running. Report it; do not act. */
  | { readonly _tag: "warn"; readonly stalledForMs: number; readonly detail: string }
  | { readonly _tag: "stalled"; readonly stalledForMs: number; readonly lastError: string };

/**
 * How long a run may make no progress before it is declared stalled.
 *
 * Long enough that an ordinary merge set or a slow backlog read never trips it,
 * short enough that a stuck run is caught while an operator is still in the
 * same working session rather than the next morning.
 */
export const DEFAULT_RUN_STALL_TIMEOUT_MS = 900_000;

/** How often a run that is past the window, but not terminal, says so. */
export const RUN_STALL_WARN_INTERVAL_MS = 30_000;

/** Failure class prefix. `infra:` keeps this off the child's failure budget. */
export const RUN_STALL_FAILURE_CLASS = "infra:stalled";

const seconds = (ms: number): string => String(Math.round(ms / 1000));

const waitDetail = (wait: RunWait): string => {
  switch (wait._tag) {
    case "merge-slot":
      return wait.holder === null
        ? "merge slot held by an unreadable holder, so no branch can land"
        : `merge slot held by ${wait.holder}, so no branch can land`;
    case "workers":
      return wait.issueIds.length === 0
        ? "workers are running"
        : `workers are running (${wait.issueIds.join(", ")})`;
    case "scheduler":
      return "no worker is running and the scheduler dispatched nothing";
  }
};

const waitRemedy = (wait: RunWait): string => {
  switch (wait._tag) {
    case "merge-slot":
      return "Check `bd merge-slot check`; an absent or stale slot defers every attempt.";
    case "workers":
      return "";
    case "scheduler":
      return "Check the ready frontier and the run's remaining dispatch budget.";
  }
};

/**
 * The diagnosis a stalled run carries, so the state names what it was waiting
 * on rather than only that it stopped.
 */
export const describeRunStall = (input: {
  readonly wait: RunWait;
  readonly stalledForMs: number;
}): string =>
  `${RUN_STALL_FAILURE_CLASS}:${input.wait._tag}: no progress for ${seconds(
    input.stalledForMs,
  )}s; ${waitDetail(input.wait)}. ${waitRemedy(input.wait)}`.trimEnd();

/**
 * Decide what a run that has not progressed since `lastProgressAt` deserves.
 *
 * Progress is a provider turn dispatched, an iteration settled, or a merge
 * landed — the three things that move a run — and nothing else. A retry that
 * dispatches nothing is not progress, which is the whole point.
 */
export const evaluateRunStall = (input: {
  readonly wait: RunWait;
  readonly lastProgressAt: number;
  readonly now: number;
  readonly timeoutMs: number;
}): RunStallVerdict => {
  const stalledForMs = Math.max(0, input.now - input.lastProgressAt);
  if (stalledForMs < input.timeoutMs) return { _tag: "ok" };
  if (input.wait._tag === "workers") {
    return { _tag: "warn", stalledForMs, detail: waitDetail(input.wait) };
  }
  return {
    _tag: "stalled",
    stalledForMs,
    lastError: describeRunStall({ wait: input.wait, stalledForMs }),
  };
};
