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
 * A provider-error phrase recognised in an assistant message. The category is
 * machine-readable — it becomes the `provider-error:<category>` failure
 * reason — and the excerpt is the human-readable line it was found on.
 */
export interface ProviderErrorMatch {
  readonly category: "spend-limit" | "auth" | "rate-limit" | "unavailable";
  readonly excerpt: string;
}

/**
 * Curated, case-insensitive phrasing of the provider errors the SDKs render as
 * ordinary assistant text (the 2026-08-04 spend-limit incident arrived as a
 * synthetic assistant message, not an error event). Best-effort by design:
 * false negatives are acceptable, so the list stays short and unambiguous
 * rather than trying to match every provider's wording.
 */
const PROVIDER_ERROR_PATTERNS: ReadonlyArray<{
  readonly category: ProviderErrorMatch["category"];
  readonly pattern: RegExp;
}> = [
  { category: "spend-limit", pattern: /monthly spend limit/i },
  { category: "spend-limit", pattern: /usage limit/i },
  { category: "auth", pattern: /invalid api key/i },
  { category: "auth", pattern: /authentication/i },
  { category: "auth", pattern: /credit balance/i },
  { category: "auth", pattern: /unauthorized/i },
  { category: "auth", pattern: /\b401\b/ },
  { category: "rate-limit", pattern: /rate limit/i },
  { category: "rate-limit", pattern: /overloaded/i },
  { category: "unavailable", pattern: /service unavailable/i },
  { category: "unavailable", pattern: /temporarily unavailable/i },
  { category: "unavailable", pattern: /provider (?:is )?unavailable/i },
  {
    category: "unavailable",
    pattern: /provider error.{0,80}(?:service |temporarily )?unavailable/i,
  },
];

const MAX_PROVIDER_ERROR_EXCERPT_LENGTH = 200;

/**
 * Assistant text is safe to use for provider switching only when it has a
 * provider-owned shape. Broad phrase detection remains separate so reporting
 * can still explain likely infrastructure failures without letting task prose
 * change the configured provider.
 */
const PROVIDER_FALLBACK_MESSAGE_PATTERNS: ReadonlyArray<RegExp> = [
  /^You've hit your org's monthly spend limit\b/im,
  /^Claude AI usage limit reached(?:\||$)/im,
  /^Error: invalid API key\b/im,
  /^authentication_error:/im,
  /^(?:provider[- ](?:error|failure)):\s*\S/im,
  /^The provider (?:is )?unavailable\b/im,
];

export const isProviderFallbackMessage = (text: string): boolean =>
  PROVIDER_FALLBACK_MESSAGE_PATTERNS.some((pattern) => pattern.test(text));

/**
 * Scan text for provider-error phrasing (spend limits, auth failures, rate
 * limits) and return the first match, or `null`. The excerpt is the matched
 * line, trimmed and bounded, so it can be surfaced verbatim as a failure
 * reason. Callers gate this on "no RALPH_MSG report parsed": a legitimate
 * report that merely *mentions* limits must never be reclassified.
 */
export const detectProviderError = (text: string): ProviderErrorMatch | null => {
  for (const { category, pattern } of PROVIDER_ERROR_PATTERNS) {
    const match = pattern.exec(text);
    if (match === null) {
      continue;
    }
    const lineStart = text.lastIndexOf("\n", match.index) + 1;
    const lineEndIndex = text.indexOf("\n", match.index);
    const lineEnd = lineEndIndex === -1 ? text.length : lineEndIndex;
    const excerpt = text
      .slice(lineStart, lineEnd)
      .trim()
      .slice(0, MAX_PROVIDER_ERROR_EXCERPT_LENGTH);
    return { category, excerpt };
  }
  return null;
};

/**
 * The `provider-error:*` failure reason for an error string: categorised when
 * the text matches the pattern table, the bare prefix when it does not — a
 * session `lastError` is provider-attributed regardless of its wording.
 */
export const providerErrorFailureReason = (text: string): string => {
  const match = detectProviderError(text);
  return match === null ? "provider-error" : `provider-error:${match.category}`;
};

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
  /**
   * Machine-readable failure reason when classification knows something more
   * specific than the kind's default mapping — today the `provider-error:*`
   * family. Absent otherwise; the runner falls back to its per-kind table.
   */
  readonly failureReason?: string;
  /** Trusted provider evidence permits a one-way provider switch. */
  readonly providerFallbackEligible?: boolean;
  /** Where the provider evidence came from. This value is not persisted. */
  readonly providerErrorSource?: "session-last-error" | "assistant-message";
}

/**
 * Which failure budget an outcome charges — the 2026-08-04 distinction: both
 * incident runs died to "gutter: 2 iterations without a commit" when the true
 * cause was a spend-limit 429 that would have lifted within hours.
 *
 * - `infra` — the failure is attributable to infrastructure, not the agent:
 *   timeouts, dispatch failures, errored or interrupted turns (including every
 *   provider error, which classification folds into kind `error`), and
 *   protocol errors, whose shape — a completed turn with no readable final
 *   message — is a projection or provider defect, not agent behavior.
 * - `child` — the agent genuinely ran and did not deliver: it reported
 *   `RALPH_BLOCKED`, or ended a clean turn with no commit and its child issue
 *   still open.
 * - `null` — not a failure.
 *
 * A pure function of the kind, because classification already resolves the
 * ambiguous shapes: a "no-commit" whose final message was really a provider
 * error, or an errored turn carrying `session.lastError`, both come out as
 * kind `error` (see `classifyIteration`).
 */
export type IterationFailureClass = "infra" | "child";

export const iterationFailureClass = (
  kind: EpicIterationOutcomeKind,
): IterationFailureClass | null => {
  switch (kind) {
    case "done":
    case "backlog-empty":
      return null;
    case "timeout":
    case "error":
    case "protocol-error":
      return "infra";
    case "no-commit":
    case "blocked":
      return "child";
  }
};

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
  /**
   * The projected session's `lastError`, or `null`. Ingestion writes it from
   * the provider's own error text (a failed turn's `errorMessage`, a
   * `runtime.error`'s message) and clears it when the session reads back
   * healthy, so a non-null value on an errored turn is the concrete provider
   * error — "You've hit your org's monthly spend limit…" — that the generic
   * "turn ended in an error state" used to launder away.
   */
  readonly sessionLastError: string | null;
  /** Whether the repo's `HEAD` moved across the iteration. */
  readonly committed: boolean;
  readonly timedOut: boolean;
}

export const classifyIteration = (input: ClassifyIterationInput): EpicIterationOutcome => {
  if (input.timedOut) {
    return { kind: "timeout", detail: "iteration exceeded its timeout", report: null };
  }
  if (input.turnState === "error") {
    // The session's lastError is the real provider error the turn died on;
    // surfacing it is the difference between a run that reads "gutter: 2
    // iterations without a commit" and one that reads "monthly spend limit".
    return input.sessionLastError === null
      ? { kind: "error", detail: "turn ended in an error state", report: null }
      : {
          kind: "error",
          detail: `provider error: ${input.sessionLastError}`,
          report: null,
          failureReason: providerErrorFailureReason(input.sessionLastError),
          providerFallbackEligible: true,
          providerErrorSource: "session-last-error",
        };
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
  // A turn that "completed" without a report may really be a provider error
  // rendered as assistant text — the SDK prints spend-limit and auth failures
  // as a synthetic final message. Scanned only when no RALPH_MSG parsed, so a
  // legitimate report that mentions limits in prose is never reclassified.
  if (report === null) {
    const providerError = detectProviderError(text);
    if (providerError !== null) {
      return {
        kind: "error",
        detail: `provider error: ${providerError.excerpt}`,
        report: null,
        failureReason: `provider-error:${providerError.category}`,
        providerFallbackEligible: isProviderFallbackMessage(text),
        providerErrorSource: "assistant-message",
      };
    }
  }
  return input.committed
    ? { kind: "done", detail: null, report }
    : { kind: "no-commit", detail: "iteration produced no commit", report };
};
