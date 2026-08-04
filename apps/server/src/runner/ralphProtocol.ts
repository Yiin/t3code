/**
 * ralphProtocol - The agent-facing completion contract for unattended epic runs.
 *
 * An iteration of an epic run is one fresh orchestration turn whose agent was
 * told to do a single unit of work and then report. It reports in-band, through
 * the text of its final assistant message:
 *
 * - `RALPH_DONE` on a line of its own — the backlog is empty, stop the loop.
 * - `RALPH_BLOCKED` on a line of its own — it could not proceed.
 * - `RALPH_MSG: {"summary":"…","why":"…"}` — a one-line report of the work.
 *
 * This module is the *whole* of that contract, kept pure and free of Effect so
 * the classification rules can be tested against literal strings. The one thing
 * it deliberately does not do is decide what the loop does next — that policy
 * (retry, back off, stop) lives in the runner layer.
 *
 * ## Why the git cross-check is part of classification
 *
 * `RALPH_DONE` is agent-asserted; a commit is observed. The two disagree in a
 * way that matters: an agent that commits work and *then* claims the backlog is
 * empty has violated the protocol, and treating that as "done" silently drops
 * the rest of the backlog. Terminal ralph makes exactly this cross-check
 * (`run.sh:333-343`) and this module mirrors it, so an epic run behaves the same
 * whether it is driven from a terminal or from inside t3code.
 *
 * @module ralphProtocol
 */

/**
 * Whole-line, case-sensitive match — the exact shape of terminal ralph's
 * `grep -Eqx '[[:space:]]*RALPH_DONE[[:space:]]*'` (`run.sh:338`). An inline
 * mention of the token in prose therefore does not trigger it.
 */
const RALPH_DONE_PATTERN = /^[ \t]*RALPH_DONE[ \t]*$/m;
const RALPH_BLOCKED_PATTERN = /^[ \t]*RALPH_BLOCKED[ \t]*$/m;
const RALPH_MSG_PATTERN = /^RALPH_MSG:[ \t]*(.*)$/gm;

/**
 * The agent's own one-line report of what it did. Both fields are best-effort:
 * a malformed or partial payload yields nulls rather than failing the
 * iteration, because the report is telemetry, not control flow.
 */
export interface RalphReport {
  readonly summary: string | null;
  readonly why: string | null;
}

export const hasRalphDone = (text: string): boolean => RALPH_DONE_PATTERN.test(text);

export const hasRalphBlocked = (text: string): boolean => RALPH_BLOCKED_PATTERN.test(text);

/**
 * Extract the last `RALPH_MSG:` line's JSON payload, mirroring terminal ralph's
 * `grep -oE 'RALPH_MSG:.*' | tail -1` (`run.sh:329`). Last wins so a nested
 * quote of the protocol earlier in the message cannot shadow the real report.
 */
export const parseRalphReport = (text: string): RalphReport | null => {
  // `RALPH_MSG_PATTERN` is a global regex, so reset the shared cursor first —
  // `exec` state persists across calls on a module-level literal.
  RALPH_MSG_PATTERN.lastIndex = 0;
  let lastCapture: string | null = null;
  let match = RALPH_MSG_PATTERN.exec(text);
  while (match !== null) {
    lastCapture = match[1] ?? null;
    match = RALPH_MSG_PATTERN.exec(text);
  }
  if (lastCapture === null) {
    return null;
  }

  const trimmed = lastCapture.trim();
  if (trimmed.length === 0) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { summary: null, why: null };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { summary: null, why: null };
  }

  const record = parsed as Record<string, unknown>;
  return {
    summary: typeof record.summary === "string" ? record.summary : null,
    why: typeof record.why === "string" ? record.why : null,
  };
};

/**
 * How an iteration ended, in terminal ralph's vocabulary (`run.sh:333-343`).
 *
 * - `backlog-empty` — the agent reported `RALPH_DONE` and created no commit.
 *   The only outcome that completes a run.
 * - `done` — the agent committed work; the loop continues.
 * - `no-commit` — the turn ended cleanly but nothing was committed. Benign
 *   once, a stuck loop when repeated.
 * - `blocked` — the agent reported `RALPH_BLOCKED`.
 * - `protocol-error` — the agent broke the contract, or the turn produced no
 *   readable final message and left nothing behind to judge it by. Never
 *   inferred as done from the message alone.
 * - `timeout` / `error` — the turn did not finish, or finished badly.
 */
export type EpicIterationOutcomeKind =
  | "backlog-empty"
  | "done"
  | "no-commit"
  | "blocked"
  | "protocol-error"
  | "timeout"
  | "error";

export interface EpicIterationOutcome {
  readonly kind: EpicIterationOutcomeKind;
  /** Human-readable reason, present whenever the outcome is not routine. */
  readonly detail: string | null;
  readonly report: RalphReport | null;
}

/**
 * The projected state of the iteration's turn, as read back from projections.
 * `null` means no turn row was projected at all.
 */
export type IterationTurnState = "running" | "completed" | "interrupted" | "error" | null;

export interface ClassifyIterationInput {
  readonly turnState: IterationTurnState;
  /**
   * The turn's final assistant message, or `null` when the turn produced none.
   *
   * A turn whose only output was reasoning or tool calls legitimately has no
   * assistant row, and an interrupted turn leaves its row `streaming: true`
   * with text never flushed. Both are inconclusive, never done.
   */
  readonly finalMessage: { readonly text: string; readonly streaming: boolean } | null;
  /**
   * Whether a null `finalMessage` is a *finished* observation rather than an
   * in-flight one: the runner watched a settled turn for the whole of its
   * bounded wait and no assistant row ever projected.
   *
   * Ingestion finalizes a turn's assistant messages *after* it reports the turn
   * ended (`ProviderRuntimeIngestion.ts:1666`), and in the default buffered
   * delivery mode the text lives only in memory until then — so a pending final
   * message has no projected row at all, not a streaming one. "No row" is
   * therefore what both "no message yet" and "no message ever" look like, and
   * only the runner, which did the waiting, can say which it saw. Read this as
   * "the wait is over", not as "a message is coming".
   */
  readonly finalMessageWaitExhausted: boolean;
  /** Whether the repo's `HEAD` moved across the iteration. */
  readonly committed: boolean;
  readonly timedOut: boolean;
}

export const classifyIteration = (input: ClassifyIterationInput): EpicIterationOutcome => {
  if (input.timedOut) {
    return { kind: "timeout", detail: "iteration exceeded its timeout", report: null };
  }
  if (input.turnState === "error") {
    return { kind: "error", detail: "turn ended in an error state", report: null };
  }
  if (input.turnState === "interrupted") {
    return { kind: "error", detail: "turn was interrupted", report: null };
  }
  if (input.turnState !== "completed") {
    return {
      kind: "protocol-error",
      detail: "turn did not reach a terminal state",
      report: null,
    };
  }
  if (input.finalMessage === null) {
    // More waiting cannot separate a lost message from an absent one, so the
    // verdict falls to the other observation of the iteration: its commit.
    // Work that landed says the iteration ran and the loop should carry on —
    // the missing report costs telemetry, not correctness. This cannot launder
    // a `RALPH_DONE` into a `done`: `RALPH_DONE` with a commit is a protocol
    // error below, and the final backlog-empty iteration has no commit, so it
    // still has to produce a readable message to end the run.
    if (input.finalMessageWaitExhausted && input.committed) {
      return {
        kind: "done",
        detail: "assistant message never projected; accepted on the iteration's commit",
        report: null,
      };
    }
    return {
      kind: "protocol-error",
      detail: "turn completed without an assistant message",
      report: null,
    };
  }
  if (input.finalMessage.streaming) {
    return {
      kind: "protocol-error",
      detail: "final assistant message was never finalized",
      report: null,
    };
  }

  const text = input.finalMessage.text;
  const report = parseRalphReport(text);

  if (hasRalphDone(text)) {
    return input.committed
      ? {
          kind: "protocol-error",
          detail: "RALPH_DONE was emitted after creating a commit",
          report,
        }
      : { kind: "backlog-empty", detail: null, report };
  }
  if (hasRalphBlocked(text)) {
    return { kind: "blocked", detail: "agent reported RALPH_BLOCKED", report };
  }
  return input.committed
    ? { kind: "done", detail: null, report }
    : { kind: "no-commit", detail: "iteration produced no commit", report };
};
