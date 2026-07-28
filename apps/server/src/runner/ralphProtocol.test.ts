import { describe, expect, it } from "vite-plus/test";

import { classifyIteration, parseRalphReport } from "./ralphProtocol.ts";

const completedWith = (text: string) =>
  ({
    turnState: "completed",
    finalMessage: { text, streaming: false },
    committed: false,
    timedOut: false,
  }) as const;

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
    const outcome = classifyIteration({
      turnState: "completed",
      finalMessage: null,
      committed: false,
      timedOut: false,
    });
    expect(outcome.kind).toBe("protocol-error");
  });

  it("never infers done from a message that was never finalized", () => {
    const outcome = classifyIteration({
      turnState: "completed",
      finalMessage: { text: "RALPH_DONE", streaming: true },
      committed: false,
      timedOut: false,
    });
    expect(outcome.kind).toBe("protocol-error");
  });

  it("treats an interrupted turn as inconclusive even when it printed RALPH_DONE", () => {
    const outcome = classifyIteration({
      turnState: "interrupted",
      finalMessage: { text: "RALPH_DONE", streaming: false },
      committed: false,
      timedOut: false,
    });
    expect(outcome.kind).toBe("error");
  });

  it("reports a timeout before anything else", () => {
    const outcome = classifyIteration({
      turnState: "completed",
      finalMessage: { text: "RALPH_DONE", streaming: false },
      committed: false,
      timedOut: true,
    });
    expect(outcome.kind).toBe("timeout");
  });
});
