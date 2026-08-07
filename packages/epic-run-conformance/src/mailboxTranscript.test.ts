import { assert, describe, it } from "@effect/vitest";

import { mailboxToTranscript, parseMailboxJsonl } from "./mailboxTranscript.ts";

describe("mailboxToTranscript", () => {
  it("maps the ten original shell events and their pushed/verified envelope", () => {
    const records = parseMailboxJsonl(
      [
        { event: "dispatched", child: "epic.1", branch: "epic/epic.1", ts: "10:00:00" },
        { event: "retry", child: "epic.1", reason: "worker timed out", attempt: 1, max: 3 },
        { event: "blocked", child: "epic.1", reason: "RALPH_BLOCKED", attempts: 2 },
        { event: "done", child: "epic.1", summary: "built" },
        { event: "folded", child: "epic.1" },
        { event: "researched", child: "epic.1", comments: 2 },
        { event: "parked", child: "epic.1", branch: "epic/epic.1", reason: "merge-conflict" },
        {
          event: "merged",
          child: "epic.1",
          repositories: [{ repo: "repo" }, { repo: "api" }],
          pushed: true,
          verified: false,
        },
        { event: "lock_held" },
        { event: "finished", reason: "all children complete", pushed: true, verified: true },
      ]
        .map((item) => JSON.stringify({ pushed: false, verified: false, ...item }, null, 2))
        .join("\n"),
    );

    const transcript = mailboxToTranscript({ epicId: "epic", records });
    assert.deepInclude(transcript[0], {
      _tag: "dispatched",
      issueId: "epic.1",
      iterationIndex: 0,
      branch: "epic/epic.1",
    });
    assert.deepInclude(transcript[1], {
      _tag: "retry",
      failureReason: "infra:timeout",
      attempts: 1,
      maxAttempts: 3,
    });
    assert.deepInclude(transcript[2], {
      _tag: "blocked",
      failureReason: "child:blocked",
      attempts: 2,
    });
    assert.deepInclude(transcript[5], { _tag: "researched", comments: 2 });
    assert.deepInclude(transcript[7], {
      _tag: "merged",
      repositories: ["repo", "api"],
      pushed: true,
      verified: false,
    });
    assert.deepInclude(transcript[8], {
      _tag: "lock_held",
      issueId: null,
      iterationIndex: null,
    });
    assert.deepInclude(transcript[9], { _tag: "finished", status: "done" });
    assert.deepEqual(
      transcript.map(({ pushed, verified }) => ({ pushed, verified })),
      [
        { pushed: false, verified: false },
        { pushed: false, verified: false },
        { pushed: false, verified: false },
        { pushed: false, verified: false },
        { pushed: false, verified: false },
        { pushed: false, verified: false },
        { pushed: false, verified: false },
        { pushed: true, verified: false },
        { pushed: false, verified: false },
        { pushed: true, verified: true },
      ],
    );
  });

  it("maps newer provider and evidence events", () => {
    const transcript = mailboxToTranscript({
      epicId: "epic",
      records: [
        { event: "provider-fallback", child: "epic.1", from: "claude", to: "codex" },
        { event: "rate-limited", child: "epic.1" },
        { event: "completed-no-code", child: "epic.1", comments: 1 },
      ],
    });
    assert.deepInclude(transcript[0], {
      _tag: "provider-fallback",
      fromProvider: "claude",
      toProvider: "codex",
    });
    assert.equal(transcript[1]?.failureReason, "infra:rate-limited");
    assert.equal(transcript[2]?.comments, 1);
    for (const event of transcript) {
      assert.equal(event.pushed, false);
      assert.equal(event.verified, false);
    }
  });

  it("rejects malformed JSON and unknown event names", () => {
    assert.throws(() => parseMailboxJsonl("not-json"), /invalid mailbox record 1/u);
    assert.throws(() => parseMailboxJsonl('{"event":"done"'), /invalid mailbox record 1/u);
    assert.throws(
      () => mailboxToTranscript({ epicId: "epic", records: [{ event: "mystery" }] }),
      /unsupported mailbox event/u,
    );
  });
});
