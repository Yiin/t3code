import { describe, expect, it } from "vite-plus/test";

import { normalizeCoreMailbox, parseCoreMailbox } from "./coreMailbox.ts";

const running = (iterationIndex: number, issueId = "epic.1") => ({
  type: "iteration-state-changed",
  iteration: {
    issueId,
    iterationIndex,
    turnStatus: "running",
    summary: null,
    why: null,
    failureReason: null,
    headBefore: "a",
    headAfter: null,
  },
});

const completed = (iterationIndex: number, issueId = "epic.1") => ({
  type: "iteration-state-changed",
  iteration: {
    issueId,
    iterationIndex,
    turnStatus: "completed",
    summary: "done",
    why: "needed",
    failureReason: null,
    headBefore: "a",
    headAfter: "b",
  },
});

const failed = (iterationIndex: number, failureReason: string, issueId = "epic.1") => ({
  type: "iteration-state-changed",
  iteration: {
    issueId,
    iterationIndex,
    turnStatus: "failed",
    summary: null,
    why: null,
    failureReason,
    headBefore: "a",
    headAfter: "a",
  },
});

const runState = (
  status: string,
  fields: Record<string, unknown> = {},
  instanceId = "worker-cmd",
) => ({
  type: "run-state-changed",
  run: {
    status,
    lastError: null,
    infraStreak: 0,
    consecutiveFailures: 0,
    modelSelection: { instanceId, model: "fixture" },
    ...fields,
  },
});

describe("parseCoreMailbox", () => {
  it("parses one JSON record per line and skips blank lines", () => {
    expect(parseCoreMailbox('{"a":1}\n\n{"b":2}\n')).toEqual([{ a: 1 }, { b: 2 }]);
  });
});

describe("normalizeCoreMailbox", () => {
  it("maps the happy path to dispatched, done, finished", () => {
    const events = normalizeCoreMailbox(
      [runState("running"), running(0), runState("running"), completed(0), runState("done")],
      "epic",
    );
    expect(events.map((event) => event._tag)).toEqual(["dispatched", "done", "finished"]);
    expect(events[2]).toMatchObject({ status: "done", issueId: null, iterationIndex: null });
  });

  it("charges infrastructure retries and reports the infra budget stop", () => {
    const values = [
      runState("running"),
      ...[0, 1, 2, 3].flatMap((index) => [
        running(index),
        failed(index, "infra:timeout"),
        runState("running", { infraStreak: index + 1 }),
      ]),
      running(4),
      failed(4, "infra:timeout"),
      runState("failed", {
        lastError: "infra: 5 consecutive infrastructure failures; last: timed out",
        infraStreak: 5,
      }),
    ];
    const events = normalizeCoreMailbox(values, "epic", { maxIterations: 5 });
    expect(events.map((event) => [event._tag, event.attempts])).toEqual([
      ["retry", 1],
      ["retry", 2],
      ["retry", 3],
      ["retry", 4],
      ["finished", 5],
    ]);
    expect(events[4]).toMatchObject({ status: "failed", reason: "infra failure budget" });
    expect(events[0]).toMatchObject({ failureReason: "infra:timeout" });
  });

  it("blocks a child whose claim release follows the exhausted attempt", () => {
    const events = normalizeCoreMailbox(
      [
        runState("running"),
        running(0),
        failed(0, "child:blocked"),
        runState("running", { consecutiveFailures: 1 }),
        running(1),
        failed(1, "child:blocked"),
        {
          type: "child-claim-released",
          issueId: "epic.1",
          iterationIndex: 1,
          reason: "retry budget exhausted; child reopened",
        },
        runState("failed", { consecutiveFailures: 2 }),
      ],
      "epic",
      { maxIterations: 2 },
    );
    expect(events.map((event) => event._tag)).toEqual(["retry", "blocked"]);
    expect(events[1]).toMatchObject({
      failureReason: "child:blocked",
      attempts: 2,
      reason: "retry budget exhausted; child reopened",
    });
  });

  it("maps a no-commit close to completed-no-code with bead evidence", () => {
    const events = normalizeCoreMailbox(
      [
        runState("running"),
        running(0),
        {
          type: "iteration-state-changed",
          iteration: {
            issueId: "epic.1",
            iterationIndex: 0,
            turnStatus: "completed",
            summary: "researched",
            why: "findings posted",
            failureReason: null,
            headBefore: "a",
            headAfter: "a",
          },
        },
        runState("done"),
      ],
      "epic",
      { comments: new Map([["epic.1", 1]]), maxIterations: 1 },
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ _tag: "completed-no-code", comments: 1 });
  });

  it("maps the provider fallback chain and the recovered dispatch", () => {
    const events = normalizeCoreMailbox(
      [
        runState("running", {}, "claude"),
        running(0),
        failed(0, "provider-error: rate limit"),
        runState("running", {}, "codex"),
        {
          type: "provider-fallback",
          issueId: "epic.1",
          iterationIndex: 0,
          fromDriver: "claudeAgent",
          toDriver: "codex",
        },
        running(1),
        failed(1, "provider-error: rate limit"),
        runState("running", {}, "kimi"),
        {
          type: "provider-fallback",
          issueId: "epic.1",
          iterationIndex: 1,
          fromDriver: "codex",
          toDriver: "kimi",
        },
        running(2),
        completed(2),
        runState("done", {}, "kimi"),
      ],
      "epic",
      { maxIterations: 3 },
    );
    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({
      _tag: "provider-fallback",
      fromProvider: "claude",
      toProvider: "codex",
    });
    expect(events[1]).toMatchObject({
      _tag: "provider-fallback",
      fromProvider: "codex",
      toProvider: "kimi",
    });
    expect(events[2]).toMatchObject({ _tag: "dispatched", toProvider: "kimi" });
  });

  it("keeps a single timed-out iteration as the raw iteration record", () => {
    const events = normalizeCoreMailbox(
      [
        runState("running"),
        running(0),
        failed(0, "infra:timeout"),
        runState("failed", { lastError: "maximum iterations reached (1); open:epic.1" }),
      ],
      "epic",
      { maxIterations: 1 },
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      _tag: "iteration-state-changed",
      turnStatus: "failed",
      failureReason: "infra:timeout",
    });
  });

  it("ignores subagent liveness records", () => {
    const events = normalizeCoreMailbox(
      [
        runState("running"),
        running(0),
        { type: "subagent-liveness-unavailable", iterationIndex: 0, reason: "no harness session" },
        completed(0),
        runState("done"),
      ],
      "epic",
    );
    expect(events.map((event) => event._tag)).toEqual(["dispatched", "done", "finished"]);
  });
});
