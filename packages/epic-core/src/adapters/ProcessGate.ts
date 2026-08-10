// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

import { ProcessRunner } from "../processRunner.ts";
import { GateError, type GateShape } from "../ports/Gate.ts";

const cleanEnvironment = (environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
  Object.fromEntries(
    Object.entries(environment).filter(
      ([name, value]) =>
        value !== undefined && !name.startsWith("COOKEPIC_") && name !== "FLEET_UNIT",
    ),
  );

const boundOutput = (output: string, maxBytes: number): string => {
  const encoder = new TextEncoder();
  const chunks: string[] = [];
  let bytes = 0;
  for (const character of output) {
    const characterBytes = encoder.encode(character).byteLength;
    if (bytes + characterBytes > maxBytes) break;
    chunks.push(character);
    bytes += characterBytes;
  }
  return chunks.join("");
};

export const heavyGateLockPath = (input: {
  readonly environment: NodeJS.ProcessEnv;
  readonly uid: number;
}): string =>
  NodePath.join(
    input.environment.XDG_RUNTIME_DIR ?? `/run/user/${String(input.uid)}`,
    "t3code",
    "cook-epic-heavy.lock",
  );

/**
 * Exit status `flock` reports when `-w` expires without the lock.
 *
 * It must not collide with an exit code the gate command itself can produce.
 * flock's own default is 1, which is exactly what a failing test suite exits
 * with, so contention would be indistinguishable from a red gate.
 */
const LOCK_UNAVAILABLE_EXIT_CODE = 75;

/**
 * How long to wait for the shared heavy-work lock before giving up.
 *
 * Far below the process timeout on purpose. The lock is machine-global, so a
 * run in another repository can hold it; waiting the full process budget turns
 * that into an indistinguishable two-hour stall, which is what happened to
 * three epic runs on 2026-08-09/10.
 */
const DEFAULT_LOCK_WAIT_SECONDS = 15 * 60;

export const makeProcessGate = (input: {
  readonly processRunner: ProcessRunner["Service"];
  readonly environment: NodeJS.ProcessEnv;
  readonly uid: number;
  readonly timeoutMs?: number;
  readonly lockWaitSeconds?: number;
}): GateShape => {
  const run: GateShape["run"] = Effect.fn("ProcessGate.run")(function* ({
    command,
    repositories,
    cwd,
    maxOutputBytes,
  }) {
    const env = cleanEnvironment(input.environment);
    const lockPath = heavyGateLockPath(input);
    const lockDirectory = NodePath.dirname(lockPath);

    const mkdir = yield* input.processRunner
      .run({ command: "mkdir", args: ["-p", lockDirectory], env, extendEnv: false })
      .pipe(
        Effect.mapError(
          (cause) =>
            new GateError({
              operation: "prepareLock",
              detail: `Could not prepare ${lockDirectory}`,
              cause,
            }),
        ),
      );
    if (mkdir.code !== 0) {
      return yield* new GateError({
        operation: "prepareLock",
        detail: mkdir.stderr.trim() || `mkdir exited with code ${String(mkdir.code)}`,
      });
    }

    const lockWaitSeconds = input.lockWaitSeconds ?? DEFAULT_LOCK_WAIT_SECONDS;
    const startedAt = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
    yield* Effect.logInfo("epic.gate.start", { command, cwd, lockPath, lockWaitSeconds });

    const output = yield* input.processRunner
      .run({
        command: "flock",
        args: [
          // Bound the wait and report contention with a code the gate command
          // cannot produce, so "the lock was busy" never masquerades as "the
          // gate failed" — and never silently consumes the process timeout.
          "-w",
          String(lockWaitSeconds),
          "-E",
          String(LOCK_UNAVAILABLE_EXIT_CODE),
          lockPath,
          "bash",
          "-c",
          command,
        ],
        cwd,
        env,
        extendEnv: false,
        maxOutputBytes,
        outputMode: "truncate",
        truncatedMarker: "",
        // The terminal gate itself is unbounded (`run-legacy.sh:806-820`). Server
        // hosting needs a finite process lifetime, so keep the shared lock and
        // environment contract while applying a generous adapter bound.
        timeout: Duration.millis(input.timeoutMs ?? 2 * 60 * 60 * 1_000),
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new GateError({
              operation: "run",
              detail: `Could not run the gate in ${cwd}`,
              cause,
            }),
        ),
      );

    const finishedAt = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
    const durationMs = finishedAt - startedAt;
    yield* Effect.logInfo("epic.gate.finished", {
      cwd,
      exitCode: output.code,
      durationMs,
    });

    if (output.code === LOCK_UNAVAILABLE_EXIT_CODE) {
      return yield* new GateError({
        operation: "lock",
        detail: `Could not take the shared gate lock ${lockPath} within ${String(lockWaitSeconds)}s; another epic run on this host holds it`,
      });
    }

    return {
      passed: output.code === 0,
      repositoryPaths: repositories.map((repository) => repository.repositoryPath),
      output: boundOutput(
        [output.stdout, output.stderr]
          .filter((part) => part.length > 0)
          .join("\n")
          .trim(),
        maxOutputBytes,
      ),
    };
  });

  return { run };
};

export const make = Effect.fn("ProcessGate.make")(function* () {
  const processRunner = yield* ProcessRunner;
  return makeProcessGate({
    processRunner,
    environment: process.env,
    uid: process.getuid?.() ?? 0,
  });
});
