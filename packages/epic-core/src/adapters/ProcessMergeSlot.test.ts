import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { ProcessRunner, type ProcessRunInput, type ProcessRunOutput } from "../processRunner.ts";
import { makeProcessMergeSlot } from "./ProcessMergeSlot.ts";

const OURS = "cook-epic-run-1";

const output = (code: number, stdout = ""): ProcessRunOutput => ({
  stdout,
  stderr: "",
  code: code as ProcessRunOutput["code"],
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
});

const checkOutput = (holder: string | null): ProcessRunOutput =>
  output(0, JSON.stringify({ available: holder === null, holder, id: "t3code-merge-slot" }));

const harness = (check: ProcessRunOutput) => {
  const calls: ProcessRunInput[] = [];
  const slot = makeProcessMergeSlot({
    repositoryPath: "/repo",
    processRunner: ProcessRunner.of({
      run: (command) =>
        Effect.sync(() => {
          calls.push(command);
          return command.args[1] === "check" ? check : output(0);
        }),
    }),
  });
  const released = () => calls.filter((call) => call.args[1] === "release");
  return { slot, calls, released };
};

describe("ProcessMergeSlot", () => {
  it.effect("reclaims a slot still held under this run's own holder id", () =>
    Effect.gen(function* () {
      // The finalizer that releases the slot is skipped by a SIGKILL, so a
      // hard-killed run leaves the slot held by itself. Nobody else can free
      // it, and every later drain defers forever.
      const { slot, released } = harness(checkOutput(OURS));

      expect(yield* slot.reclaim(OURS)).toEqual({ reclaimed: true });
      expect(released()).toHaveLength(1);
      expect(released()[0]?.args).toEqual(["merge-slot", "release", "--holder", OURS]);
    }),
  );

  for (const [label, check] of [
    ["another run holds it", checkOutput("cook-epic-run-2")],
    ["the terminal coordinator holds it", checkOutput("cook-epic-terminal")],
    ["the slot is free", checkOutput(null)],
    ["bd cannot read the slot", output(1)],
    ["the output is not JSON", output(0, "✓ Merge slot available")],
    ["the JSON has an unexpected shape", output(0, JSON.stringify({ state: "held" }))],
  ] as const) {
    it.effect(`leaves the slot alone when ${label}`, () =>
      Effect.gen(function* () {
        // Deferring to a live holder is correct. Only holder identity is
        // evidence, so anything this cannot read means "not ours".
        const { slot, released } = harness(check);

        expect(yield* slot.reclaim(OURS)).toEqual({ reclaimed: false });
        expect(released()).toHaveLength(0);
      }),
    );
  }

  it.effect("acquires and releases through the same holder id", () =>
    Effect.gen(function* () {
      const { slot, calls } = harness(checkOutput(null));

      expect(yield* slot.tryAcquire(OURS)).toEqual(Option.some({ holder: OURS }));
      yield* slot.release(OURS);

      expect(calls.map((call) => call.args)).toEqual([
        ["merge-slot", "acquire", "--holder", OURS],
        ["merge-slot", "release", "--holder", OURS],
      ]);
      expect(calls[0]?.cwd).toBe("/repo");
    }),
  );
});
