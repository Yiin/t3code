/**
 * Shared message rendering for port errors.
 *
 * A tagged error class with no `message` getter inherits an empty string, and
 * every caller that logs or persists `.message` then reports nothing. That is
 * not hypothetical: three epic runs failed with the line
 * `Epic runner failed to dispatch git.merge-queue:` and no cause, because the
 * merge, gate and backlog port errors all lacked one.
 *
 * The cause clause matters as much as the rest. Without it the same failures
 * would have read `run: Could not run the gate in <cwd>` — better, but still
 * silent about the two-hour timeout that actually stopped the run.
 *
 * @module portFailure
 */

/** Render `operation: detail` plus the cause's own message when it has one. */
export const describePortFailure = (
  operation: string,
  detail: string,
  cause: unknown,
  subject?: string | undefined,
): string => {
  const where = subject === undefined || subject.length === 0 ? "" : ` [${subject}]`;
  const because = cause instanceof Error && cause.message.length > 0 ? `: ${cause.message}` : "";
  return `${operation}${where}: ${detail}${because}`;
};
