import { describe, expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

import { ProcessRunner, type ProcessRunInput, type ProcessRunOutput } from "../processRunner.ts";
import { heavyGateLockPath, makeProcessGate } from "./ProcessGate.ts";

const output = (code: number): ProcessRunOutput => ({
  stdout: code === 0 ? "pass" : "",
  stderr: code === 0 ? "" : "failed",
  code: code as ProcessRunOutput["code"],
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
});

describe("ProcessGate", () => {
  const repository = (repositoryPath: string) => ({
    repositoryPath,
    baseBranch: "mine",
    worktreeRoot: "/worktrees",
    siblings: [],
  });

  it.effect("runs one repo-set gate through the shared lock and strips coordinator variables", () =>
    Effect.gen(function* () {
      const calls: ProcessRunInput[] = [];
      const processRunner = ProcessRunner.of({
        run: (command) =>
          Effect.sync(() => {
            calls.push(command);
            return command.cwd === "/integration" ? output(1) : output(0);
          }),
      });
      const gate = makeProcessGate({
        processRunner,
        uid: 1000,
        environment: {
          PATH: "/bin",
          XDG_RUNTIME_DIR: "/runtime",
          COOKEPIC_EPIC: "epic",
          FLEET_UNIT: "worker.scope",
        },
        timeoutMs: 123,
      });

      expect(heavyGateLockPath({ environment: {}, uid: 1000 })).toBe(
        "/run/user/1000/t3code/cook-epic-heavy.lock",
      );
      expect(
        yield* gate.run({
          command: "bun run test",
          repositories: [repository("/repo-a"), repository("/repo-b")],
          cwd: "/integration",
          maxOutputBytes: 2048,
        }),
      ).toEqual({
        passed: false,
        repositoryPaths: ["/repo-a", "/repo-b"],
        output: "failed",
      });

      expect(calls).toHaveLength(2);
      expect(calls[0]).toMatchObject({
        command: "mkdir",
        args: ["-p", "/runtime/t3code"],
        extendEnv: false,
      });
      expect(calls[1]).toMatchObject({
        command: "flock",
        args: ["/runtime/t3code/cook-epic-heavy.lock", "bash", "-c", "bun run test"],
        cwd: "/integration",
        maxOutputBytes: 2048,
        outputMode: "truncate",
        extendEnv: false,
        timeout: Duration.millis(123),
      });
      expect(calls[1]?.env).toEqual({ PATH: "/bin", XDG_RUNTIME_DIR: "/runtime" });
    }),
  );

  it.effect("bounds aggregate stdout and stderr by bytes", () =>
    Effect.gen(function* () {
      const processRunner = ProcessRunner.of({
        run: (command) =>
          Effect.succeed({
            ...output(0),
            stdout: command.command === "mkdir" ? "" : "ééé",
            stderr: command.command === "mkdir" ? "" : "tail",
          }),
      });
      const gate = makeProcessGate({ processRunner, uid: 1000, environment: {} });

      const result = yield* gate.run({
        command: "check",
        repositories: [repository("/repo")],
        cwd: "/integration",
        maxOutputBytes: 5,
      });

      expect(new TextEncoder().encode(result.output).byteLength).toBeLessThanOrEqual(5);
      expect(result.output).toBe("éé");
    }),
  );
});
