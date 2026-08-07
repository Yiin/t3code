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

export const makeProcessGate = (input: {
  readonly processRunner: ProcessRunner["Service"];
  readonly environment: NodeJS.ProcessEnv;
  readonly uid: number;
  readonly timeoutMs?: number;
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

    const output = yield* input.processRunner
      .run({
        command: "flock",
        args: [lockPath, "bash", "-c", command],
        cwd,
        env,
        extendEnv: false,
        maxOutputBytes,
        outputMode: "truncate",
        truncatedMarker: "",
        // The terminal gate itself is unbounded (`run.sh:972-986`). Server
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
