import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  diffTranscripts,
  classifyTranscriptDivergences,
  EPIC_RUN_TRANSCRIPT_TAGS,
  EpicRunTranscriptEvent,
  normalizeTranscript,
  type EpicRunTranscriptEvent as TranscriptEvent,
} from "./epicRunTranscript.ts";

const decode = Schema.decodeUnknownSync(EpicRunTranscriptEvent);
const encode = Schema.encodeSync(EpicRunTranscriptEvent);
const event = (sequence: number, tag: TranscriptEvent["_tag"] = "done"): TranscriptEvent => ({
  _tag: tag,
  sequence,
  epicId: "epic-1",
  issueId: "epic-1.1",
  iterationIndex: sequence,
});

describe("classifyTranscriptDivergences", () => {
  it("classifies summary and why changes as content", () => {
    const left = { ...event(0), summary: "left", why: "first" };
    const right = { ...event(0), summary: "right", why: "second" };
    assert.deepEqual(classifyTranscriptDivergences([left], [right]), [
      { kind: "content", index: 0, left, right },
    ]);
  });

  it("classifies event, order, and length changes as structural", () => {
    const divergences = classifyTranscriptDivergences(
      [event(0, "dispatched"), event(1, "done")],
      [event(0, "retry")],
    );
    assert.deepEqual(divergences, [
      {
        kind: "structural",
        index: 0,
        left: event(0, "dispatched"),
        right: event(0, "retry"),
      },
      { kind: "structural", index: 1, left: event(1, "done"), right: null },
    ]);
  });

  it("reports exactly one injected policy difference with both events", () => {
    const left = [event(0, "dispatched"), event(1, "retry"), event(2, "blocked")];
    const right = [event(0, "dispatched"), event(1, "retry"), event(2, "retry")];
    assert.deepEqual(classifyTranscriptDivergences(left, right), [
      {
        kind: "structural",
        index: 2,
        left: event(2, "blocked"),
        right: event(2, "retry"),
      },
    ]);
  });
});

describe("EpicRunTranscriptEvent", () => {
  for (const [sequence, tag] of EPIC_RUN_TRANSCRIPT_TAGS.entries()) {
    it(`round-trips ${tag}`, () => {
      const value = decode(event(sequence, tag));
      assert.deepEqual(decode(encode(value)), value);
    });
  }

  it("sorts by sequence, preserves duplicate order, and strips metadata", () => {
    const events: TranscriptEvent[] = [
      { ...event(2), meta: { pid: 20, threadId: "thread-2" } },
      { ...event(1, "retry"), reason: "first" },
      { ...event(1, "blocked"), reason: "second" },
    ];
    assert.deepEqual(normalizeTranscript(events), [
      { ...event(1, "retry"), reason: "first" },
      { ...event(1, "blocked"), reason: "second" },
      event(2),
    ]);
    assert.isDefined(events[0]?.meta);
  });

  it("drops nondeterministic top-level fields during decoding", () => {
    const decoded = decode({
      ...event(0),
      threadId: "thread",
      timestamp: "now",
      pid: 123,
      runDir: "/tmp/run",
      costUsd: 1,
    }) as Readonly<Record<string, unknown>>;
    for (const key of ["threadId", "timestamp", "pid", "runDir", "costUsd"]) {
      assert.notProperty(decoded, key);
    }
  });
});

describe("diffTranscripts", () => {
  it("returns null for identical normalized streams", () => {
    assert.isNull(
      diffTranscripts(
        [{ ...event(1), meta: { pid: 1 } }, event(0, "dispatched")],
        [event(0, "dispatched"), { ...event(1), meta: { pid: 2 } }],
      ),
    );
  });

  it("ignores object property insertion order", () => {
    const left = { ...event(0), reason: "same" };
    const right = { reason: "same", ...event(0) };
    assert.isNull(diffTranscripts([left], [right]));
  });

  it("finds a substitution", () => {
    assert.deepEqual(diffTranscripts([event(0)], [event(0, "blocked")]), {
      index: 0,
      left: event(0),
      right: event(0, "blocked"),
    });
  });

  it("finds an insertion", () => {
    assert.deepEqual(diffTranscripts([event(0), event(2)], [event(0), event(1), event(2)]), {
      index: 1,
      left: event(2),
      right: event(1),
    });
  });

  it("finds a deletion", () => {
    assert.deepEqual(diffTranscripts([event(0), event(1)], [event(0)]), {
      index: 1,
      left: event(1),
      right: null,
    });
  });
});
