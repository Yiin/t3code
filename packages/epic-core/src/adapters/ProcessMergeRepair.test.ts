import { describe, expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

import { ProcessRunner, type ProcessRunInput, type ProcessRunOutput } from "../processRunner.ts";
import { makeProcessMergeRepair } from "./ProcessMergeRepair.ts";

const output = (code: number, stderr = ""): ProcessRunOutput => ({
  stdout: "",
  stderr,
  code: code as ProcessRunOutput["code"],
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
});

const harness = (run: (command: ProcessRunInput) => ProcessRunOutput) => {
  const calls: ProcessRunInput[] = [];
  const repair = makeProcessMergeRepair({
    processRunner: ProcessRunner.of({
      run: (command) =>
        Effect.sync(() => {
          calls.push(command);
          return run(command);
        }),
    }),
    uid: 1000,
    environment: {
      PATH: "/bin",
      XDG_RUNTIME_DIR: "/runtime",
      COOKEPIC_EPIC: "epic",
      FLEET_UNIT: "worker.scope",
    },
    timeoutMs: 456,
  });
  return { repair, calls };
};

describe("ProcessMergeRepair", () => {
  it.effect("installs in every integration worktree under the shared heavy lock", () =>
    Effect.gen(function* () {
      const { repair, calls } = harness(() => output(0));

      expect(
        yield* repair.restoreDependencies({ worktrees: ["/integration", "/integ-sib"] }),
      ).toMatchObject({ restored: true });

      expect(calls).toHaveLength(2);
      expect(calls[0]).toMatchObject({
        command: "flock",
        args: [
          "/runtime/t3code/cook-epic-heavy.lock",
          "bash",
          "-c",
          "vp install --frozen-lockfile --ignore-scripts",
        ],
        cwd: "/integration",
        extendEnv: false,
        timeout: Duration.millis(456),
      });
      expect(calls[1]).toMatchObject({ cwd: "/integ-sib" });
      // Coordinator variables never reach a child process.
      expect(calls[0]?.env).toEqual({ PATH: "/bin", XDG_RUNTIME_DIR: "/runtime" });
    }),
  );

  it.effect("reports which worktree failed and why", () =>
    Effect.gen(function* () {
      const { repair } = harness((command) =>
        command.cwd === "/integ-sib"
          ? output(1, "ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with frozen-lockfile")
          : output(0),
      );

      const result = yield* repair.restoreDependencies({
        worktrees: ["/integration", "/integ-sib"],
      });

      expect(result.restored).toBe(false);
      expect(result.detail).toContain("/integ-sib");
      expect(result.detail).toContain("ERR_PNPM_OUTDATED_LOCKFILE");
    }),
  );
});
