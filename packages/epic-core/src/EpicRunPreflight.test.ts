// @effect-diagnostics nodeBuiltinImport:off
import { describe, expect, it } from "@effect/vitest";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Duration from "effect/Duration";
import * as Layer from "effect/Layer";

import * as ProcessRunner from "./processRunner.ts";
import { EpicRunLock } from "./ports/EpicRunLock.ts";
import { EpicRunPreflight, layer } from "./EpicRunPreflight.ts";

const run = (
  status: string,
  holder?: Parameters<EpicRunLock["Service"]["inspect"]>[0],
  bd?: { readonly show?: string; readonly ready?: string; readonly list?: string },
  options?: {
    readonly gitCode?: number;
    readonly gitStderr?: string;
    readonly onGit?: (input: ProcessRunner.ProcessRunInput) => void;
  },
) => {
  const testLayer = layer.pipe(
    Layer.provide(
      Layer.succeed(ProcessRunner.ProcessRunner, {
        run: (input) => {
          const { command, args } = input;
          if (command === "git") options?.onGit?.(input);
          return Effect.succeed({
            stdout:
              command === "git"
                ? status
                : args[0] === "show"
                  ? (bd?.show ?? '[{"id":"epic-1","issue_type":"epic"}]')
                  : args[0] === "ready"
                    ? (bd?.ready ?? '[{"id":"child-1"}]')
                    : (bd?.list ?? "[]"),
            stderr: command === "git" ? (options?.gitStderr ?? "") : "",
            code: (command === "git" ? (options?.gitCode ?? 0) : 0) as never,
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
          });
        },
      }),
    ),
    Layer.provide(
      Layer.succeed(EpicRunLock, {
        inspect: () =>
          Effect.succeed(
            holder === undefined
              ? undefined
              : {
                  owner: "terminal",
                  runDir: "/tmp/run",
                  host: "host",
                  pid: 42,
                  pgid: 42,
                  startedAt: "2026-01-01T00:00:00.000Z",
                  heartbeatAt: 1,
                },
          ),
        acquire: () => Effect.die("unused"),
      }),
    ),
  );
  return Effect.flatMap(EpicRunPreflight, (service) =>
    service.check({ workspaceRoot: "/repo", epicId: "epic-1", mode: "sequential" }),
  ).pipe(Effect.provide(testLayer));
};

describe("EpicRunPreflight", () => {
  it.effect("blocks staged, untracked, and renamed paths but exempts .beads", () =>
    Effect.gen(function* () {
      const result = yield* run(
        "# branch.head main\n1 M. N... 100644 100644 100644 a a staged.ts\n? untracked.ts\n2 R. N... 100644 100644 100644 a b R100 renamed.ts\told.ts\n? .beads/local.json\n",
      );
      expect(result.blockers).toEqual([
        { _tag: "dirty_tree", paths: ["renamed.ts", "staged.ts", "untracked.ts"] },
      ]);
    }),
  );

  it.effect("blocks detached HEAD", () =>
    Effect.gen(function* () {
      const result = yield* run("# branch.head (detached)\n");
      expect(result.blockers).toContainEqual({ _tag: "detached_head" });
    }),
  );

  it.effect("reports a live lock with observe metadata", () =>
    Effect.gen(function* () {
      const result = yield* run("# branch.head main\n", {
        workspaceRoot: "/repo",
        epicId: "epic-1",
      });
      expect(result.blockers).toContainEqual({
        _tag: "run_in_progress",
        owner: "terminal",
        runDir: "/tmp/run",
        host: "host",
        pid: 42,
      });
    }),
  );

  it.effect("returns ok for a clean branch with ready children", () =>
    Effect.gen(function* () {
      expect(yield* run("# branch.head main\n")).toEqual({
        ok: true,
        blockers: [],
        warnings: [],
      });
    }),
  );

  it.effect("runs the exact bounded git status command", () =>
    Effect.gen(function* () {
      let captured: ProcessRunner.ProcessRunInput | undefined;
      yield* run("# branch.head main\n", undefined, undefined, {
        onGit: (input) => (captured = input),
      });
      expect(captured).toBeDefined();
      expect(captured?.command).toBe("git");
      expect(captured?.args).toEqual([
        "status",
        "--porcelain=2",
        "--branch",
        "--untracked-files=all",
      ]);
      expect(captured?.cwd).toBe("/repo");
      expect(Duration.toMillis(captured?.timeout ?? 0)).toBe(20_000);
    }),
  );

  it.effect("reports a non-zero git status result", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        run("", undefined, undefined, { gitCode: 128, gitStderr: "not a repository\n" }),
      );
      expect(error.message).toBe("git status: not a repository");
    }),
  );

  it.effect("reports unknown epics and nothing-ready backlogs", () =>
    Effect.gen(function* () {
      const unknown = yield* run("# branch.head main\n", undefined, { show: "[]" });
      expect(unknown.blockers).toContainEqual({ _tag: "epic_not_found", epicId: "epic-1" });
      const empty = yield* run("# branch.head main\n", undefined, { ready: "[]" });
      expect(empty.warnings).toContainEqual({ _tag: "nothing_ready", epicId: "epic-1" });
    }),
  );

  it.effect("warns about claims owned by a dead local runner", () =>
    Effect.gen(function* () {
      const result = yield* run("# branch.head main\n", undefined, {
        list: '[{"id":"child-2","status":"in_progress","assignee":"t3code-runner-999999999"}]',
      });
      expect(result.warnings).toContainEqual({ _tag: "stale_claims", childIds: ["child-2"] });
    }),
  );

  it.effect("reads rename destinations through the real ProcessRunner", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* Effect.acquireRelease(
          Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "preflight-git-"))),
          (root) => Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true })),
        );
        const git = (args: ReadonlyArray<string>) =>
          Effect.promise(
            () =>
              new Promise<void>((resolve, reject) => {
                NodeChildProcess.execFile("git", args, { cwd: directory }, (error) =>
                  error ? reject(error) : resolve(),
                );
              }),
          );
        yield* git(["init", "-q"]);
        yield* git(["config", "user.email", "test@example.com"]);
        yield* git(["config", "user.name", "Test"]);
        yield* Effect.promise(() => NodeFSP.writeFile(NodePath.join(directory, "old.ts"), "x\n"));
        yield* git(["add", "."]);
        yield* git(["commit", "-qm", "initial"]);
        yield* git(["mv", "old.ts", "renamed.ts"]);

        const live = layer.pipe(
          Layer.provide(
            Layer.succeed(ProcessRunner.ProcessRunner, {
              run: ({ command, args, cwd }) => {
                if (command !== "git") {
                  return Effect.succeed({
                    stdout:
                      args[0] === "show"
                        ? '[{"id":"epic-1","issue_type":"epic"}]'
                        : args[0] === "ready"
                          ? '[{"id":"child-1"}]'
                          : "[]",
                    stderr: "",
                    code: 0 as never,
                    timedOut: false,
                    stdoutTruncated: false,
                    stderrTruncated: false,
                  });
                }
                return Effect.promise(
                  () =>
                    new Promise<ProcessRunner.ProcessRunOutput>((resolve, reject) => {
                      NodeChildProcess.execFile("git", args, { cwd }, (error, stdout, stderr) =>
                        error
                          ? reject(error)
                          : resolve({
                              stdout,
                              stderr,
                              code: 0 as never,
                              timedOut: false,
                              stdoutTruncated: false,
                              stderrTruncated: false,
                            }),
                      );
                    }),
                );
              },
            }),
          ),
          Layer.provide(
            Layer.succeed(EpicRunLock, {
              // @effect-diagnostics-next-line effectSucceedWithVoid:off
              inspect: () => Effect.succeed(undefined),
              acquire: () => Effect.die("unused"),
            }),
          ),
        );
        const result = yield* Effect.flatMap(EpicRunPreflight, (service) =>
          service.check({ workspaceRoot: directory, epicId: "epic-1", mode: "sequential" }),
        ).pipe(Effect.provide(live));
        expect(result.blockers).toContainEqual({
          _tag: "dirty_tree",
          paths: ["renamed.ts"],
        });
      }),
    ),
  );
});
