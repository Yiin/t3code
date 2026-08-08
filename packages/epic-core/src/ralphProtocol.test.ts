import { describe, expect, it } from "vite-plus/test";

import { classifyIteration, detectProviderError, parseRalphReport } from "./ralphProtocol.ts";

const completedWith = (text: string) =>
  ({
    turnState: "completed",
    finalMessage: { text, streaming: false },
    finalMessageWaitExhausted: false,
    sessionLastError: null,
    committed: false,
    timedOut: false,
  }) as const;

/** A completed turn that read back with no assistant row at all. */
const completedWithoutMessage = {
  turnState: "completed",
  finalMessage: null,
  finalMessageWaitExhausted: false,
  sessionLastError: null,
  committed: false,
  timedOut: false,
} as const;

describe("parseRalphReport", () => {
  it("reads summary and why from the report line", () => {
    expect(
      parseRalphReport('done\n\nRALPH_MSG: {"summary":"added the runner","why":"loops needed it"}'),
    ).toEqual({ summary: "added the runner", why: "loops needed it" });
  });

  it("takes the last report line so an earlier quote of the protocol cannot shadow it", () => {
    expect(
      parseRalphReport(
        'I will end with RALPH_MSG: {"summary":"example","why":"example"}\n' +
          'RALPH_MSG: {"summary":"real","why":"real"}',
      ),
    ).toEqual({ summary: "real", why: "real" });
  });

  it("degrades to nulls rather than throwing on malformed JSON", () => {
    expect(parseRalphReport("RALPH_MSG: {not json")).toEqual({ summary: null, why: null });
  });

  it("returns null when there is no report line", () => {
    expect(parseRalphReport("did some work")).toBeNull();
  });

  it("ignores a report that is not at the start of a line", () => {
    expect(parseRalphReport('the agent prints RALPH_MSG: {"summary":"x"} at the end')).toBeNull();
  });

  it("does not leak regex cursor state between calls", () => {
    const text = 'RALPH_MSG: {"summary":"first","why":"w"}';
    expect(parseRalphReport(text)).toEqual({ summary: "first", why: "w" });
    expect(parseRalphReport(text)).toEqual({ summary: "first", why: "w" });
  });
});

describe("classifyIteration", () => {
  it("treats a lone RALPH_DONE line with no commit as an empty backlog", () => {
    expect(classifyIteration(completedWith("no work left\n\nRALPH_DONE")).kind).toBe(
      "backlog-empty",
    );
  });

  it("does not match RALPH_DONE mentioned inline in prose", () => {
    const outcome = classifyIteration(
      completedWith("I would print RALPH_DONE if the backlog were empty."),
    );
    expect(outcome.kind).toBe("no-commit");
  });

  it("flags RALPH_DONE emitted after a commit as a protocol error", () => {
    const outcome = classifyIteration({
      ...completedWith("RALPH_DONE"),
      committed: true,
    });
    expect(outcome.kind).toBe("protocol-error");
    expect(outcome.detail).toBe("RALPH_DONE was emitted after creating a commit");
  });

  it("reports a committed iteration as done and keeps its report", () => {
    const outcome = classifyIteration({
      ...completedWith('shipped it\nRALPH_MSG: {"summary":"shipped","why":"needed"}'),
      committed: true,
    });
    expect(outcome.kind).toBe("done");
    expect(outcome.report).toEqual({ summary: "shipped", why: "needed" });
  });

  it("recognises RALPH_BLOCKED", () => {
    expect(classifyIteration(completedWith("stuck\nRALPH_BLOCKED")).kind).toBe("blocked");
  });

  it("never infers done from a missing assistant message", () => {
    const outcome = classifyIteration(completedWithoutMessage);
    expect(outcome.kind).toBe("protocol-error");
  });

  it("never forgives a missing assistant message on a commit alone", () => {
    // The commit only speaks once the runner has stopped waiting. While the
    // wait is still open the absence means nothing, and a `done` here would let
    // any half-read turn pass.
    const outcome = classifyIteration({ ...completedWithoutMessage, committed: true });
    expect(outcome.kind).toBe("protocol-error");
    expect(outcome.detail).toBe("turn completed without an assistant message");
  });

  it("keeps a message-less turn that committed nothing a protocol error after the wait", () => {
    // "No message ever": the runner watched the settled turn for its whole
    // bound and the iteration left nothing behind. Still inconclusive, still a
    // failure — this is the case the forgiveness below must not swallow.
    const outcome = classifyIteration({
      ...completedWithoutMessage,
      finalMessageWaitExhausted: true,
    });
    expect(outcome.kind).toBe("protocol-error");
    expect(outcome.detail).toBe("turn completed without an assistant message");
  });

  it("accepts a message-less turn that committed once the wait is exhausted", () => {
    // "No message yet, and no way left to tell": the work landed, so the loop
    // carries on rather than counting a projection lag as agent failure.
    const outcome = classifyIteration({
      ...completedWithoutMessage,
      finalMessageWaitExhausted: true,
      committed: true,
    });
    expect(outcome.kind).toBe("done");
    expect(outcome.detail).toBe(
      "assistant message never projected; accepted on the iteration's commit",
    );
    expect(outcome.report).toBeNull();
  });

  it("never infers done from a message that was never finalized", () => {
    const outcome = classifyIteration({
      turnState: "completed",
      finalMessage: { text: "RALPH_DONE", streaming: true },
      finalMessageWaitExhausted: false,
      sessionLastError: null,
      committed: false,
      timedOut: false,
    });
    expect(outcome.kind).toBe("protocol-error");
  });

  it("treats an interrupted turn as inconclusive even when it printed RALPH_DONE", () => {
    const outcome = classifyIteration({
      turnState: "interrupted",
      finalMessage: { text: "RALPH_DONE", streaming: false },
      finalMessageWaitExhausted: false,
      sessionLastError: null,
      committed: false,
      timedOut: false,
    });
    expect(outcome.kind).toBe("error");
  });

  it("does not accept an interrupted turn that committed and lost its message", () => {
    // The forgiveness is scoped to a *completed* turn. An interrupted one is
    // an error whatever it committed.
    const outcome = classifyIteration({
      turnState: "interrupted",
      finalMessage: null,
      finalMessageWaitExhausted: true,
      sessionLastError: null,
      committed: true,
      timedOut: false,
    });
    expect(outcome.kind).toBe("error");
  });

  it("reports a timeout before anything else", () => {
    const outcome = classifyIteration({
      turnState: "completed",
      finalMessage: { text: "RALPH_DONE", streaming: false },
      finalMessageWaitExhausted: false,
      sessionLastError: null,
      committed: false,
      timedOut: true,
    });
    expect(outcome.kind).toBe("timeout");
  });

  it("surfaces the session's lastError as the detail of an errored turn", () => {
    const outcome = classifyIteration({
      turnState: "error",
      finalMessage: null,
      finalMessageWaitExhausted: false,
      sessionLastError: "You've hit your org's monthly spend limit; it resets on the 1st",
      committed: false,
      timedOut: false,
    });
    expect(outcome.kind).toBe("error");
    expect(outcome.detail).toBe(
      "provider error: You've hit your org's monthly spend limit; it resets on the 1st",
    );
    expect(outcome.failureReason).toBe("provider-error:spend-limit");
    expect(outcome.providerFallbackEligible).toBe(true);
    expect(outcome.providerErrorSource).toBe("session-last-error");
  });

  it("marks an uncategorised session lastError provider-error without a category", () => {
    const outcome = classifyIteration({
      turnState: "error",
      finalMessage: null,
      finalMessageWaitExhausted: false,
      sessionLastError: "socket hang up",
      committed: false,
      timedOut: false,
    });
    expect(outcome.detail).toBe("provider error: socket hang up");
    expect(outcome.failureReason).toBe("provider-error");
    expect(outcome.providerFallbackEligible).toBe(true);
    expect(outcome.providerErrorSource).toBe("session-last-error");
  });

  it("keeps the generic detail when an errored turn has no session lastError", () => {
    const outcome = classifyIteration({
      turnState: "error",
      finalMessage: null,
      finalMessageWaitExhausted: false,
      sessionLastError: null,
      committed: false,
      timedOut: false,
    });
    expect(outcome.detail).toBe("turn ended in an error state");
    expect(outcome.failureReason).toBeUndefined();
  });

  it("fails a report-less completed turn whose final message is a provider error", () => {
    const outcome = classifyIteration(
      completedWith("You've hit your org's monthly spend limit — upgrade to continue."),
    );
    expect(outcome.kind).toBe("error");
    expect(outcome.detail).toBe(
      "provider error: You've hit your org's monthly spend limit — upgrade to continue.",
    );
    expect(outcome.failureReason).toBe("provider-error:spend-limit");
    expect(outcome.providerFallbackEligible).toBe(true);
    expect(outcome.providerErrorSource).toBe("assistant-message");
  });

  it.each([
    "The task documents authentication handling.",
    "The application test expects a 401 response.",
    "Implement rate limit handling for the API client.",
    "The status page can show overloaded during maintenance.",
    "The domain fixture contains service unavailable.",
  ])("does not make broad task prose eligible for provider fallback: %s", (text) => {
    const outcome = classifyIteration(completedWith(text));

    expect(outcome.providerFallbackEligible).not.toBe(true);
  });

  it.each([
    "You've hit your org's monthly spend limit; it resets on the 1st",
    "Claude AI usage limit reached|1754355600",
    "Error: invalid API key supplied",
    "authentication_error: credentials expired",
    "provider-error: service unavailable",
  ])("makes a canonical provider message eligible for fallback: %s", (text) => {
    const outcome = classifyIteration(completedWith(text));

    expect(outcome.failureReason).toMatch(/^provider-error/);
    expect(outcome.providerFallbackEligible).toBe(true);
    expect(outcome.providerErrorSource).toBe("assistant-message");
  });

  it("does not trust provider-shaped assistant prose from a structured-only harness", () => {
    const outcome = classifyIteration({
      ...completedWith("provider-error: rate limit exceeded"),
      assistantProviderErrorsTrusted: false,
    });
    expect(outcome.kind).toBe("error");
    expect(outcome.failureReason).toBe("provider-error:rate-limit");
    expect(outcome.providerFallbackEligible).toBe(false);
    expect(outcome.providerErrorSource).toBe("assistant-message");
  });

  it("does not reclassify a RALPH_MSG report that merely mentions limits", () => {
    const outcome = classifyIteration({
      ...completedWith(
        'we discussed rate limits in the design\nRALPH_MSG: {"summary":"designed the rate limit backoff","why":"the API overloaded"}',
      ),
      committed: true,
    });
    expect(outcome.kind).toBe("done");
    expect(outcome.failureReason).toBeUndefined();
  });
});

describe("detectProviderError", () => {
  it("categorises spend, auth, and rate-limit phrasing", () => {
    expect(detectProviderError("You've hit your org's monthly spend limit.")).toEqual({
      category: "spend-limit",
      excerpt: "You've hit your org's monthly spend limit.",
    });
    expect(detectProviderError("Claude AI usage limit reached|1754355600")?.category).toBe(
      "spend-limit",
    );
    expect(detectProviderError("Error: invalid API key")?.category).toBe("auth");
    expect(detectProviderError("authentication_error: credentials expired")?.category).toBe("auth");
    expect(detectProviderError("Your credit balance is too low")?.category).toBe("auth");
    expect(detectProviderError("Request failed: 401 Unauthorized")?.category).toBe("auth");
    expect(detectProviderError("Rate limit exceeded, retry later")?.category).toBe("rate-limit");
    expect(detectProviderError("Overloaded: please try again")?.category).toBe("rate-limit");
  });

  it("returns the matched line, not the whole message", () => {
    const match = detectProviderError(
      "some preamble\nYou've hit your org's monthly spend limit; it resets tomorrow\ntrailing text",
    );
    expect(match?.excerpt).toBe("You've hit your org's monthly spend limit; it resets tomorrow");
  });

  it("bounds the excerpt length", () => {
    const match = detectProviderError(`rate limit ${"x".repeat(500)}`);
    expect(match?.excerpt.length).toBe(200);
  });

  it("does not match a bare number that is not 401, or ordinary prose", () => {
    expect(detectProviderError("closed issue t3code-4012 with a commit")).toBeNull();
    expect(detectProviderError("all tests passed; pushed the fix")).toBeNull();
  });
});
