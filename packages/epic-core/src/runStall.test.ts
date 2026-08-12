import { assert, it } from "@effect/vitest";

import { describeRunStall, evaluateRunStall } from "./runStall.ts";

const evaluate = (input: {
  readonly wait: Parameters<typeof evaluateRunStall>[0]["wait"];
  readonly sinceMs: number;
  readonly timeoutMs?: number;
}) =>
  evaluateRunStall({
    wait: input.wait,
    lastProgressAt: 1_000_000,
    now: 1_000_000 + input.sinceMs,
    timeoutMs: input.timeoutMs ?? 900_000,
  });

it("holds a run that progressed inside the window", () => {
  const verdict = evaluate({ wait: { _tag: "scheduler" }, sinceMs: 899_999 });
  assert.equal(verdict._tag, "ok");
});

it("stalls a scheduler that dispatched nothing past the window", () => {
  const verdict = evaluate({ wait: { _tag: "scheduler" }, sinceMs: 900_000 });
  assert.equal(verdict._tag, "stalled");
  if (verdict._tag !== "stalled") return;
  assert.include(verdict.lastError, "infra:stalled:scheduler");
  assert.include(verdict.lastError, "no progress for 900s");
  assert.include(verdict.lastError, "no worker is running");
});

it("names the merge slot holder so the deferral is actionable", () => {
  const verdict = evaluate({
    wait: { _tag: "merge-slot", holder: "epic-run:4f11d14b" },
    sinceMs: 960_000,
  });
  assert.equal(verdict._tag, "stalled");
  if (verdict._tag !== "stalled") return;
  assert.include(verdict.lastError, "infra:stalled:merge-slot");
  assert.include(verdict.lastError, "merge slot held by epic-run:4f11d14b");
  assert.include(verdict.lastError, "bd merge-slot check");
});

it("reports an unreadable merge slot as unreadable, not as free", () => {
  const verdict = evaluate({ wait: { _tag: "merge-slot", holder: null }, sinceMs: 960_000 });
  assert.equal(verdict._tag, "stalled");
  if (verdict._tag !== "stalled") return;
  assert.include(verdict.lastError, "unreadable holder");
});

it("only warns while workers are running, whatever the elapsed time", () => {
  // A single unit of epic work legitimately runs for hours. Failing the run
  // for that would be far worse than the silence this replaces.
  const verdict = evaluate({
    wait: { _tag: "workers", issueIds: ["epic.1", "epic.2"] },
    sinceMs: 8 * 3_600_000,
  });
  assert.equal(verdict._tag, "warn");
  if (verdict._tag !== "warn") return;
  assert.include(verdict.detail, "epic.1, epic.2");
});

it("keeps the failure class under infra: so a stall never charges a child", () => {
  const lastError = describeRunStall({ wait: { _tag: "scheduler" }, stalledForMs: 900_000 });
  assert.isTrue(lastError.startsWith("infra:"));
});

it("treats a clock that moved backwards as no elapsed time", () => {
  const verdict = evaluateRunStall({
    wait: { _tag: "scheduler" },
    lastProgressAt: 2_000_000,
    now: 1_000_000,
    timeoutMs: 1,
  });
  assert.equal(verdict._tag, "ok");
});
