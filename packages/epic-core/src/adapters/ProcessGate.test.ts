import { describe, expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { TestClock } from "effect/testing";
import { HostProcessCpuCount, HostProcessLoadAverage } from "@t3tools/shared/hostProcess";

import { ProcessRunner, type ProcessRunInput, type ProcessRunOutput } from "../processRunner.ts";
import { gateCommandDigest } from "../ports/Gate.ts";
import { heavyGateLockPath, makeProcessGate } from "./ProcessGate.ts";

/**
 * Pin the host load for every gate test.
 *
 * Without this the gate reads the real machine, so a test run on a busy CI box
 * would sit in the quiet-host wait it is not trying to exercise.
 */
const onHost = <A, E, R>(readings: ReadonlyArray<number>, effect: Effect.Effect<A, E, R>) => {
  let index = 0;
  return effect.pipe(
    Effect.provideService(HostProcessLoadAverage, () => {
      const reading = readings[Math.min(index, readings.length - 1)] ?? 0;
      index += 1;
      return reading;
    }),
    Effect.provideService(HostProcessCpuCount, 16),
  );
};

const onIdleHost = <A, E, R>(effect: Effect.Effect<A, E, R>) => onHost([1], effect);

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
    onIdleHost(
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
        ).toMatchObject({
          passed: false,
          repositoryPaths: ["/repo-a", "/repo-b"],
          output: "failed",
        });

        // mkdir, one head read per repo, the gate itself, then the marker read.
        expect(calls).toHaveLength(5);
        expect(calls[0]).toMatchObject({
          command: "mkdir",
          args: ["-p", "/runtime/t3code"],
          extendEnv: false,
        });
        expect(calls[1]).toMatchObject({
          command: "git",
          args: ["-C", "/worktrees", "rev-parse", "HEAD"],
          extendEnv: false,
        });
        const flock = calls[3];
        expect(flock).toMatchObject({
          command: "flock",
          cwd: "/integration",
          maxOutputBytes: 2048,
          outputMode: "truncate",
          extendEnv: false,
          timeout: Duration.millis(123),
        });
        expect(flock?.args.slice(0, 7)).toEqual([
          "-w",
          "900",
          "-E",
          "75",
          "/runtime/t3code/cook-epic-heavy.lock",
          "bash",
          "-c",
        ]);
        // The acquisition stamp runs inside the lock, ahead of the command,
        // and its own failure never changes the gate's exit code.
        expect(flock?.args[7]).toMatch(/^date \+%s%3N >'[^']+' 2>\/dev\/null\nbun run test$/);
        expect(flock?.env).toEqual({ PATH: "/bin", XDG_RUNTIME_DIR: "/runtime" });
      }),
    ),
  );

  it.effect("bounds aggregate stdout and stderr by bytes", () =>
    onIdleHost(
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
        // The TAIL survives, not the head: a test runner prints its failures
        // last, so keeping the beginning reports passing test names as the
        // evidence for a red gate.
        expect(result.output).toBe("tail");
      }),
    ),
  );

  it.effect("keeps the failure at the end of a long gate output", () =>
    onIdleHost(
      Effect.gen(function* () {
        const processRunner = ProcessRunner.of({
          run: (command) =>
            Effect.succeed({
              ...output(command.command === "mkdir" ? 0 : 1),
              stdout: command.command === "mkdir" ? "" : `${"✓ passing test\n".repeat(50)}`,
              stderr: command.command === "mkdir" ? "" : "FAIL src/thing.test.ts > it broke",
            }),
        });
        const gate = makeProcessGate({ processRunner, uid: 1000, environment: {} });

        const result = yield* gate.run({
          command: "check",
          repositories: [repository("/repo")],
          cwd: "/integration",
          maxOutputBytes: 64,
        });

        expect(result.passed).toBe(false);
        expect(result.output).toContain("FAIL src/thing.test.ts > it broke");
      }),
    ),
  );

  /**
   * Three epic runs stalled for two hours each on an unbounded lock wait and
   * then reported a bare `Epic runner failed to dispatch git.merge-queue:`.
   * Contention has to be its own outcome, distinguishable from a red gate.
   */
  it.effect("reports an unavailable lock distinctly from a failing gate command", () =>
    onIdleHost(
      Effect.gen(function* () {
        const processRunner = ProcessRunner.of({
          run: (command) => Effect.succeed(output(command.command === "mkdir" ? 0 : 75)),
        });
        const gate = makeProcessGate({
          processRunner,
          uid: 1000,
          environment: {},
          lockWaitSeconds: 60,
        });

        const error = yield* gate
          .run({
            command: "check",
            repositories: [repository("/repo")],
            cwd: "/integration",
            maxOutputBytes: 2048,
          })
          .pipe(Effect.flip);

        expect(error.operation).toBe("lock");
        expect(error.detail).toContain("cook-epic-heavy.lock");
        expect(error.detail).toContain("60s");
        // The empty-message defect this pairs with: the rendered message must
        // carry the detail, not an empty string.
        expect(error.message).toContain("cook-epic-heavy.lock");
      }),
    ),
  );

  it.effect("passes the configured lock wait to flock", () =>
    onIdleHost(
      Effect.gen(function* () {
        const calls: ProcessRunInput[] = [];
        const processRunner = ProcessRunner.of({
          run: (command) =>
            Effect.sync(() => {
              calls.push(command);
              return output(0);
            }),
        });
        const gate = makeProcessGate({
          processRunner,
          uid: 1000,
          environment: {},
          lockWaitSeconds: 42,
        });

        yield* gate.run({
          command: "check",
          repositories: [repository("/repo")],
          cwd: "/integration",
          maxOutputBytes: 2048,
        });

        expect(calls.find((call) => call.command === "flock")?.args.slice(0, 4)).toEqual([
          "-w",
          "42",
          "-E",
          "75",
        ]);
      }),
    ),
  );

  /**
   * Run d7580b6c: the same gate at the same commit passed in 421s idle and
   * failed after 23m01s while 17 foreign vitest processes held the host at load
   * 29.92 on 16 cores. The gate has to let that load clear before it starts.
   */
  it.effect("holds the gate command back until the host is quiet", () =>
    onHost(
      [29.92, 29.92, 8],
      Effect.gen(function* () {
        const calls: ProcessRunInput[] = [];
        const processRunner = ProcessRunner.of({
          run: (command) =>
            Effect.sync(() => {
              calls.push(command);
              return output(0);
            }),
        });
        const gate = makeProcessGate({
          processRunner,
          uid: 1000,
          environment: {},
          quietHostPollSeconds: 30,
          quietHostWaitSeconds: 600,
        });

        const fiber = yield* gate
          .run({
            command: "check",
            repositories: [repository("/repo")],
            cwd: "/integration",
            maxOutputBytes: 2048,
          })
          .pipe(Effect.forkChild);

        yield* TestClock.adjust(Duration.seconds(30));
        // The lock directory is prepared and the input heads are read, but
        // nothing heavy has started.
        expect(calls.map((call) => call.command)).toEqual(["mkdir", "git"]);

        yield* TestClock.adjust(Duration.seconds(30));
        const result = yield* Fiber.join(fiber);

        expect(result.passed).toBe(true);
        expect(calls.map((call) => call.command)).toEqual(["mkdir", "git", "flock", "bash"]);
      }),
    ),
  );

  /** A host that never goes quiet still gets its gate; the run is not lost. */
  it.effect("runs the gate anyway when the quiet-host wait expires", () =>
    onHost(
      [29.92],
      Effect.gen(function* () {
        const calls: ProcessRunInput[] = [];
        const processRunner = ProcessRunner.of({
          run: (command) =>
            Effect.sync(() => {
              calls.push(command);
              return output(0);
            }),
        });
        const gate = makeProcessGate({
          processRunner,
          uid: 1000,
          environment: {},
          quietHostPollSeconds: 30,
          quietHostWaitSeconds: 60,
        });

        const fiber = yield* gate
          .run({
            command: "check",
            repositories: [repository("/repo")],
            cwd: "/integration",
            maxOutputBytes: 2048,
          })
          .pipe(Effect.forkChild);

        yield* TestClock.adjust(Duration.seconds(60));
        const result = yield* Fiber.join(fiber);

        expect(result.passed).toBe(true);
        expect(calls.map((call) => call.command)).toEqual(["mkdir", "git", "flock", "bash"]);
      }),
    ),
  );

  /**
   * The receipt is what makes a run's verification provable and its wall time
   * explainable after the fact, so every field has to come from something the
   * adapter measured rather than from the caller's intent.
   */
  it.effect("measures a receipt from the commits it tested and the lock it waited on", () =>
    onIdleHost(
      Effect.gen(function* () {
        const processRunner = ProcessRunner.of({
          run: (command) =>
            Effect.gen(function* () {
              if (command.command === "git") return { ...output(0), stdout: "head-a\n" };
              if (command.command === "flock") {
                // 1.5s waiting for the shared lock, then 3s of real gate.
                yield* TestClock.adjust(Duration.millis(4_500));
                return output(0);
              }
              // The marker read: the inner shell stamped the moment the lock
              // was taken, 1_500ms after the gate was queued.
              if (command.command === "bash") return { ...output(0), stdout: "1500\n" };
              return output(0);
            }),
        });
        const gate = makeProcessGate({ processRunner, uid: 1000, environment: {} });

        const result = yield* gate.run({
          command: "vp check",
          repositories: [repository("/repo")],
          cwd: "/integration",
          maxOutputBytes: 2048,
        });

        expect(result.receipt).toMatchObject({
          // sha256 of the exact command; the command text itself never travels.
          commandDigest: gateCommandDigest("vp check"),
          cwd: "/integration",
          outcome: "passed",
          exitCode: 0,
          inputHeads: [{ repositoryPath: "/repo", head: "head-a" }],
        });
        expect(result.receipt.commandDigest).not.toContain("vp check");
        expect(result.receipt.lockWaitMs).toBe(1_500);
        expect(result.receipt.executionMs).toBe(3_000);
        expect(result.receipt.acquiredAt).not.toBeNull();
        expect(result.receipt.output).toBe(result.output);
      }),
    ),
  );

  it.effect("never reports a pass without exit code zero", () =>
    onIdleHost(
      Effect.gen(function* () {
        const processRunner = ProcessRunner.of({
          run: (command) => Effect.succeed(output(command.command === "flock" ? 1 : 0)),
        });
        const gate = makeProcessGate({ processRunner, uid: 1000, environment: {} });

        const result = yield* gate.run({
          command: "vp check",
          repositories: [repository("/repo")],
          cwd: "/integration",
          maxOutputBytes: 2048,
        });

        expect(result.passed).toBe(false);
        expect(result.receipt.outcome).toBe("failed");
        expect(result.receipt.exitCode).toBe(1);
      }),
    ),
  );

  /**
   * A timed-out gate has no exit code at all. Reporting one — least of all
   * zero — would let the most expensive failure a run can hit read as a pass.
   */
  it.effect("reports a timed-out gate as an error with no exit code", () =>
    onIdleHost(
      Effect.gen(function* () {
        const processRunner = ProcessRunner.of({
          run: (command) =>
            Effect.succeed(
              command.command === "flock"
                ? { ...output(0), code: null, timedOut: true }
                : output(0),
            ),
        });
        const gate = makeProcessGate({ processRunner, uid: 1000, environment: {} });

        const result = yield* gate.run({
          command: "vp check",
          repositories: [repository("/repo")],
          cwd: "/integration",
          maxOutputBytes: 2048,
        });

        expect(result.receipt.outcome).toBe("error");
        expect(result.receipt.exitCode).toBeNull();
      }),
    ),
  );

  /** An unreadable head is null, never a guess: a wrong input proves nothing. */
  it.effect("records a null head when the repository cannot be read", () =>
    onIdleHost(
      Effect.gen(function* () {
        const processRunner = ProcessRunner.of({
          run: (command) => Effect.succeed(output(command.command === "git" ? 128 : 0)),
        });
        const gate = makeProcessGate({ processRunner, uid: 1000, environment: {} });

        const result = yield* gate.run({
          command: "vp check",
          repositories: [repository("/repo")],
          cwd: "/integration",
          maxOutputBytes: 2048,
        });

        expect(result.receipt.inputHeads).toEqual([{ repositoryPath: "/repo", head: null }]);
      }),
    ),
  );
});
