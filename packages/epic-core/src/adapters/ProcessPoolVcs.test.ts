import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { ProcessRunner, type ProcessRunInput, type ProcessRunOutput } from "../processRunner.ts";
import { makeProcessPoolVcs } from "./ProcessPoolVcs.ts";

const output = (stdout: string, code = 0): ProcessRunOutput => ({
  stdout,
  stderr: "",
  code: code as ProcessRunOutput["code"],
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
});

/** A runner that answers per git subcommand; `null` means the command fails. */
const runner = (answers: Record<string, string | null>, calls: ProcessRunInput[] = []) =>
  ProcessRunner.of({
    run: (command) =>
      Effect.suspend(() => {
        calls.push(command);
        const key = command.args.join(" ");
        const answer = answers[key];
        return answer === undefined || answer === null
          ? Effect.die(new Error(`git ${key} failed`))
          : Effect.succeed(output(answer));
      }),
  });

describe("ProcessPoolVcs.worktreeEvidence", () => {
  it.effect("bounds each probe and marks what it cut", () =>
    Effect.gen(function* () {
      const vcs = makeProcessPoolVcs(
        runner({
          "status --porcelain=v1": " M src/a.ts\n",
          "diff --stat": `${"x".repeat(20_000)}\n`,
        }),
      );

      const evidence = yield* vcs.worktreeEvidence("/wt/child");

      expect(evidence).not.toBeNull();
      expect(evidence).toContain(" M src/a.ts");
      expect(evidence).toContain("… (truncated)");
      // Two 4000-character ceilings plus the framing, never the raw 20000.
      expect((evidence ?? "").length).toBeLessThan(9_000);
    }),
  );

  it.effect("reports a clean tree rather than nothing", () =>
    Effect.gen(function* () {
      const vcs = makeProcessPoolVcs(runner({ "status --porcelain=v1": "", "diff --stat": "" }));

      const evidence = yield* vcs.worktreeEvidence("/wt/child");

      expect(evidence).not.toBeNull();
      expect(evidence).toContain("(nothing)");
      expect(evidence).not.toContain("(unavailable)");
    }),
  );

  it.effect("keeps the probe that worked when the other fails", () =>
    Effect.gen(function* () {
      const vcs = makeProcessPoolVcs(
        runner({ "status --porcelain=v1": " M src/a.ts\n", "diff --stat": null }),
      );

      const evidence = yield* vcs.worktreeEvidence("/wt/child");

      expect(evidence).toContain(" M src/a.ts");
      expect(evidence).toContain("(unavailable)");
    }),
  );

  it.effect("returns null when git tells it nothing at all", () =>
    Effect.gen(function* () {
      const calls: ProcessRunInput[] = [];
      const vcs = makeProcessPoolVcs(runner({}, calls));

      expect(yield* vcs.worktreeEvidence("/wt/child")).toBeNull();
      // Both probes are still attempted, and neither is allowed to fail the resume.
      expect(calls.map((call) => call.args.join(" "))).toEqual([
        "status --porcelain=v1",
        "diff --stat",
      ]);
      expect(calls.every((call) => call.cwd === "/wt/child")).toBe(true);
    }),
  );
});
