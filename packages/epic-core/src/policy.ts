/** Generous by default because one unit of epic work can take hours. */
export const DEFAULT_ITERATION_TIMEOUT_MS = 2 * 60 * 60 * 1000;
export const DEFAULT_RETRY_BASE_DELAY_MS = 10_000;
export const DEFAULT_RETRY_MAX_DELAY_MS = 5 * 60 * 1000;
export const DEFAULT_MAX_CONSECUTIVE_FAILURES = 3;
export const DEFAULT_MAX_NO_COMMIT_STREAK = 2;
/**
 * How many consecutive infra failures a run absorbs with backoff before it
 * fails. This is above the child failure budget, but remains finite.
 */
export const DEFAULT_INFRA_FAILURE_BUDGET = 5;
export const DEFAULT_MAX_ITERATIONS = 50;

export const EPIC_RUN_ITERATION_PROMPT = `Complete one well-scoped unit of work for this epic end-to-end. Use bd to select and claim the top-priority ready child, implement it, run the focused quality gates, commit and push, close the child, and update the epic progress note. Stop after one child. This is an unattended one-turn iteration: nothing re-invokes you after your turn ends. Run all work in the foreground. Never end your turn while a background task, workflow, or watchdog is still running; if you started one, wait for it and report its outcome before ending the turn. If no work remains, output RALPH_DONE. End a completed iteration with exactly one line: RALPH_MSG: {"summary":"<what you built, one clause>","why":"<why it was needed, one clause>"}`;

/** The follow-up turn used after an iteration's background agents settle. */
export const EPIC_RUN_CONTINUATION_PROMPT = `Your background tasks finished. Complete the iteration per the original instructions: finish the child end-to-end, then end your turn with the required RALPH_MSG line (or RALPH_DONE if no work remains).`;

export const EPIC_RUN_STALLED_PROGRESS_PROMPT = `Your turn ended early while work was still in progress. Complete the iteration per the original instructions: finish the child end-to-end, then end your turn with the required RALPH_MSG line (or RALPH_DONE if no work remains).`;

/** How long the runner waits for a still-running subagent before grace ends. */
export const DEFAULT_SUBAGENT_GRACE_TIMEOUT_MS = 15 * 60 * 1_000;
export const DEFAULT_MAX_GRACE_CONTINUATIONS = 10;
