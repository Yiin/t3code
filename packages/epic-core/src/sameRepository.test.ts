// @effect-diagnostics nodeBuiltinImport:off globalErrorInEffectCatch:off globalErrorInEffectFailure:off anyUnknownInErrorContext:off missingEffectError:off missingEffectContext:off
import { describe, expect, it } from "@effect/vitest";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as ProcessRunner from "./processRunner.ts";
import { sameRepository } from "./sameRepository.ts";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);

const runGit = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.tryPromise({
    try: () => execFile("git", args, { cwd }),
    catch: (cause) => new Error(String(cause)),
  }).pipe(Effect.asVoid, Effect.orDie);

const fixture = Effect.acquireRelease(
  Effect.tryPromise({
    try: () => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-same-repo-")),
    catch: (cause) => new Error(String(cause)),
  }).pipe(Effect.orDie),
  (directory) =>
    Effect.tryPromise({
      try: () => NodeFSP.rm(directory, { recursive: true, force: true }),
      catch: (cause) => new Error(String(cause)),
    }).pipe(Effect.asVoid, Effect.orDie),
);

const gitFixture = Effect.gen(function* () {
  const directory = yield* fixture;
  yield* runGit(directory, ["init", "-q"]);
  yield* runGit(directory, ["config", "user.email", "test@example.com"]);
  yield* runGit(directory, ["config", "user.name", "Test"]);
  yield* Effect.tryPromise({
    try: () => NodeFSP.writeFile(NodePath.join(directory, "file"), "content"),
    catch: (cause) => new Error(String(cause)),
  }).pipe(Effect.orDie);
  yield* runGit(directory, ["add", "file"]);
  yield* runGit(directory, ["commit", "-qm", "initial"]);
  const worktree = NodePath.join(
    NodePath.dirname(directory),
    `${NodePath.basename(directory)}-worktree`,
  );
  yield* runGit(directory, ["worktree", "add", "-q", "-b", "worktree", worktree]);
  return { directory, worktree };
});

const layer = Layer.succeed(
  ProcessRunner.ProcessRunner,
  ProcessRunner.ProcessRunner.of({
    run: (input) =>
      Effect.tryPromise(async () => {
        const result = await execFile(input.command, [...input.args], { cwd: input.cwd });
        return {
          stdout: result.stdout,
          stderr: result.stderr,
          code: ChildProcessSpawner.ExitCode(0),
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
        } satisfies ProcessRunner.ProcessRunOutput;
      }),
  }),
);

describe("sameRepository", () => {
  it.effect("matches a checkout and its linked worktree", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { directory, worktree } = yield* gitFixture;
        expect(yield* sameRepository(directory, worktree)).toBe(true);
      }).pipe(Effect.provide(layer)),
    ),
  );

  it.effect("rejects unrelated repositories", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const first = yield* gitFixture;
        const second = yield* gitFixture;
        expect(yield* sameRepository(first.directory, second.directory)).toBe(false);
      }).pipe(Effect.provide(layer)),
    ),
  );

  it.effect("fails closed for a non-git directory", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { directory } = yield* gitFixture;
        const nonGit = yield* fixture;
        expect(yield* sameRepository(directory, nonGit)).toBe(false);
      }).pipe(Effect.provide(layer)),
    ),
  );

  it.effect("canonicalizes symlinked path spellings", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { directory } = yield* gitFixture;
        const parent = yield* fixture;
        const link = NodePath.join(parent, "linked");
        yield* Effect.tryPromise({
          try: () => NodeFSP.symlink(directory, link, "dir"),
          catch: (cause) => new Error(String(cause)),
        }).pipe(Effect.orDie);
        expect(yield* sameRepository(directory, link)).toBe(true);
      }).pipe(Effect.provide(layer)),
    ),
  );
});
