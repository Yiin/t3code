// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { DEFAULT_EPIC_RUN_CONFIG, DEFAULT_EPIC_RUN_CONFIG_PROVENANCE } from "@t3tools/contracts";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Duration from "effect/Duration";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as ProcessRunner from "./processRunner.ts";
import { EpicRunLock } from "./ports/EpicRunLock.ts";
import {
  EpicRunConfigSource,
  layer as EpicRunConfigSourceLive,
  type EpicRunConfigFileResult,
} from "./EpicRunConfigSource.ts";
import { EpicRunPreflight, layer, type EpicRunConfigSnapshot } from "./EpicRunPreflight.ts";
import { runBaseBranch } from "./policy.ts";

const run = (
  status: string,
  holder?: Parameters<EpicRunLock["Service"]["inspect"]>[0],
  bd?: { readonly show?: string; readonly ready?: string; readonly list?: string },
  options?: {
    readonly gitCode?: number;
    readonly gitStderr?: string;
    readonly onGit?: (input: ProcessRunner.ProcessRunInput) => void;
    readonly processOverride?: (
      input: ProcessRunner.ProcessRunInput,
    ) => ProcessRunner.ProcessRunOutput | undefined;
    readonly config?: EpicRunConfigFileResult;
    readonly configSnapshot?: EpicRunConfigSnapshot;
    readonly onConfigRead?: () => void;
    readonly mode?: "auto" | "parallel" | "sequential";
    readonly intent?: "launch" | "resume";
    readonly workspaceExists?: boolean;
    readonly worktreeList?: string;
    readonly branchList?: string;
    /** Answers only the `git branch --no-merged <base> epic/*` scan. */
    readonly unmergedBranchList?: string;
    readonly resume?: { readonly runId: string; readonly worktreePaths?: readonly string[] };
    /** Per-path `exists` answers for the resume probe; `/repo` uses `workspaceExists`. */
    readonly pathExists?: Readonly<Record<string, boolean>>;
    readonly nestedStatus?: Readonly<
      Record<string, { readonly stdout: string; readonly code?: number }>
    >;
  },
) => {
  const testLayer = layer.pipe(
    Layer.provide(
      Layer.succeed(EpicRunConfigSource, {
        read: () =>
          Effect.sync(() => {
            options?.onConfigRead?.();
            return options?.config ?? { _tag: "absent" };
          }),
      }),
    ),
    Layer.provide(
      Layer.succeed(ProcessRunner.ProcessRunner, {
        run: (input) => {
          const override = options?.processOverride?.(input);
          if (override !== undefined) return Effect.succeed(override);
          const { command, args } = input;
          if (command === "git") {
            options?.onGit?.(input);
            if (args[0] === "status" && input.cwd !== "/repo") {
              const nested = options?.nestedStatus?.[input.cwd ?? ""];
              return Effect.succeed({
                stdout: nested?.stdout ?? "",
                stderr: "",
                code: (nested?.code ?? 0) as never,
                timedOut: false,
                stdoutTruncated: false,
                stderrTruncated: false,
              });
            }
            if (args[0] === "worktree") {
              return Effect.succeed({
                stdout: options?.worktreeList ?? "worktree /repo\nbranch refs/heads/main\n",
                stderr: "",
                code: 0 as never,
                timedOut: false,
                stdoutTruncated: false,
                stderrTruncated: false,
              });
            }
            if (args[0] === "branch") {
              // Two different `git branch` calls reach this fake: the
              // integration-leftover scan (`cook-epic-integration-*`) and the
              // stranded-child scan (`--no-merged <base> epic/*`). Answering
              // both with one string cross-contaminates them — an `epic/*`
              // branch list would fire a phantom `integration_leftover`,
              // because that scan does not re-filter by prefix.
              return Effect.succeed({
                stdout: args.includes("--no-merged")
                  ? (options?.unmergedBranchList ?? "")
                  : (options?.branchList ?? ""),
                stderr: "",
                code: 0 as never,
                timedOut: false,
                stdoutTruncated: false,
                stderrTruncated: false,
              });
            }
          }
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
    Layer.provide(
      FileSystem.layerNoop({
        exists: (path) =>
          Effect.succeed(
            path === "/repo"
              ? (options?.workspaceExists ?? true)
              : (options?.pathExists?.[String(path)] ?? true),
          ),
      }),
    ),
  );
  return Effect.flatMap(EpicRunPreflight, (service) =>
    service.check(
      {
        workspaceRoot: "/repo",
        epicId: "epic-1",
        mode: options?.mode ?? "sequential",
        ...(options?.intent === undefined ? {} : { intent: options.intent }),
        ...(options?.resume === undefined
          ? {}
          : {
              resume: {
                runId: options.resume.runId,
                worktreePaths: options.resume.worktreePaths ?? [],
              },
            }),
      },
      options?.configSnapshot,
    ),
  ).pipe(Effect.provide(testLayer));
};

describe("EpicRunPreflight", () => {
  it.effect("uses a supplied launch snapshot without reading config again", () =>
    Effect.gen(function* () {
      let reads = 0;
      const result = yield* run("# branch.head main\n", undefined, undefined, {
        onConfigRead: () => {
          reads += 1;
        },
        configSnapshot: {
          fileResult: { _tag: "absent" },
          config: DEFAULT_EPIC_RUN_CONFIG,
          provenance: DEFAULT_EPIC_RUN_CONFIG_PROVENANCE,
          violations: [],
        },
      });
      expect(result.ok).toBe(true);
      expect(reads).toBe(0);
    }),
  );

  it.effect("blocks a supplied invalid snapshot without reading config again", () =>
    Effect.gen(function* () {
      let reads = 0;
      const result = yield* run("# branch.head main\n", undefined, undefined, {
        onConfigRead: () => {
          reads += 1;
        },
        configSnapshot: {
          fileResult: {
            _tag: "invalid",
            configPath: "/repo/.t3code/epic-run.json",
            diagnostics: ["limits.maxIterations must be positive"],
          },
          config: DEFAULT_EPIC_RUN_CONFIG,
          provenance: DEFAULT_EPIC_RUN_CONFIG_PROVENANCE,
          violations: [],
        },
      });
      expect(result.ok).toBe(false);
      expect(result.blockers).toContainEqual({
        _tag: "config_invalid",
        configPath: "/repo/.t3code/epic-run.json",
        diagnostics: ["limits.maxIterations must be positive"],
      });
      expect(reads).toBe(0);
    }),
  );

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
      // The early lock return still carries the resolved config so the launch
      // form can prefill from a blocked preflight. The check mode is not a
      // launch override, so the resolution matches a launch with no override.
      expect(result.resolvedConfig).toBeDefined();
      expect(result.configProvenance["execution.sequential"]).toBe("default");
    }),
  );

  it.effect("returns ok for a clean branch with ready children", () =>
    Effect.gen(function* () {
      expect(yield* run("# branch.head main\n")).toEqual({
        ok: true,
        blockers: [],
        warnings: [],
        // No file and no launch override: the resolution is the defaults.
        resolvedConfig: DEFAULT_EPIC_RUN_CONFIG,
        configProvenance: DEFAULT_EPIC_RUN_CONFIG_PROVENANCE,
      });
    }),
  );

  it.effect("surfaces a loaded config file's values and file provenance", () =>
    Effect.gen(function* () {
      const result = yield* run("# branch.head main\n", undefined, undefined, {
        config: {
          _tag: "loaded",
          configPath: "/repo/.t3code/epic-run.json",
          override: { gate: { command: "bun run gate" } },
          config: {} as never,
          presentKeys: ["gate.command"],
          unknownKeys: [],
        },
      });
      expect(result.resolvedConfig.gate.command).toBe("bun run gate");
      expect(result.configProvenance["gate.command"]).toBe("file");
      expect(result.configProvenance["vcs.noPush"]).toBe("default");
    }),
  );

  it.effect("blocks an invalid config file", () =>
    Effect.gen(function* () {
      const result = yield* run("# branch.head main\n", undefined, undefined, {
        config: {
          _tag: "invalid",
          configPath: "/repo/.t3code/epic-run.json",
          diagnostics: ['Invalid type\n  at ["parallel"]["workers"]'],
        },
      });
      expect(result.ok).toBe(false);
      expect(result.blockers).toContainEqual({
        _tag: "config_invalid",
        configPath: "/repo/.t3code/epic-run.json",
        diagnostics: ['Invalid type\n  at ["parallel"]["workers"]'],
      });
    }),
  );

  it.effect("blocks an explicitly enabled gate without a command", () =>
    Effect.gen(function* () {
      const result = yield* run("# branch.head main\n", undefined, undefined, {
        config: {
          _tag: "loaded",
          configPath: "/repo/.t3code/epic-run.json",
          override: { gate: { disabled: false } },
          config: {} as never,
          presentKeys: ["gate.disabled"],
          unknownKeys: [],
        },
      });
      expect(result.blockers).toContainEqual({
        _tag: "config_invalid",
        configPath: "/repo/.t3code/epic-run.json",
        diagnostics: ["Gate is enabled, but no gate command is configured."],
      });
    }),
  );

  it.effect("composes the live strict source with preflight for malformed JSON", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* Effect.acquireRelease(
          Effect.promise(() =>
            NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "preflight-config-")),
          ),
          (root) => Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true })),
        );
        yield* Effect.promise(async () => {
          await NodeFSP.mkdir(NodePath.join(directory, ".t3code"));
          await NodeFSP.writeFile(
            NodePath.join(directory, ".t3code", "epic-run.json"),
            '{"parallel":{"workers":2,}}',
          );
        });
        const live = layer.pipe(
          Layer.provide(
            Layer.succeed(ProcessRunner.ProcessRunner, {
              run: ({ command, args }) =>
                Effect.succeed({
                  stdout:
                    command === "git"
                      ? "# branch.head main\n"
                      : args[0] === "show"
                        ? '[{"id":"epic-1"}]'
                        : args[0] === "ready"
                          ? '[{"id":"child-1"}]'
                          : "[]",
                  stderr: "",
                  code: 0 as never,
                  timedOut: false,
                  stdoutTruncated: false,
                  stderrTruncated: false,
                }),
            }),
          ),
          Layer.provide(
            Layer.succeed(EpicRunLock, {
              // @effect-diagnostics-next-line effectSucceedWithVoid:off
              inspect: () => Effect.succeed(undefined),
              acquire: () => Effect.die("unused"),
            }),
          ),
          Layer.provide(EpicRunConfigSourceLive.pipe(Layer.provide(NodeServices.layer))),
          Layer.provide(NodeServices.layer),
        );
        const result = yield* Effect.flatMap(EpicRunPreflight, (service) =>
          service.check({ workspaceRoot: directory, epicId: "epic-1", mode: "sequential" }),
        ).pipe(Effect.provide(live));
        expect(result.ok).toBe(false);
        expect(result.blockers[0]?._tag).toBe("config_invalid");
      }),
    ),
  );

  it.effect("warns about unknown keys and safe policy changes", () =>
    Effect.gen(function* () {
      const result = yield* run("# branch.head main\n", undefined, undefined, {
        config: {
          _tag: "loaded",
          configPath: "/repo/.t3code/epic-run.json",
          override: { execution: { sequential: true }, parallel: { workers: 4 } },
          config: {} as never,
          presentKeys: ["execution.sequential", "parallel.workers"],
          unknownKeys: ["parallel.futureWorkers"],
        },
      });
      expect(result.ok).toBe(true);
      expect(result.warnings).toContainEqual({
        _tag: "config_unknown_keys",
        configPath: "/repo/.t3code/epic-run.json",
        keys: ["parallel.futureWorkers"],
      });
      expect(result.warnings).toContainEqual({
        _tag: "config_violation",
        key: "parallel.workers",
        message: "Sequential execution limits parallel workers to 1.",
      });
    }),
  );

  it.effect("warns when the current adapter cannot prove budget enforcement", () =>
    Effect.gen(function* () {
      const result = yield* run("# branch.head main\n", undefined, undefined, {
        config: {
          _tag: "loaded",
          configPath: "/repo/.t3code/epic-run.json",
          override: { budget: { usd: 10 } },
          config: {} as never,
          presentKeys: ["budget.usd"],
          unknownKeys: [],
        },
      });
      expect(result.warnings).toContainEqual({
        _tag: "config_violation",
        key: "budget.usd",
        message: "The selected harness cannot enforce the budget limit.",
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
            Layer.succeed(EpicRunConfigSource, {
              read: () => Effect.succeed({ _tag: "absent" }),
            }),
          ),
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
          Layer.provide(NodeServices.layer),
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

  describe("parallel mode", () => {
    it.effect("still blocks tracked modifications", () =>
      Effect.gen(function* () {
        const result = yield* run(
          "# branch.head main\n1 M. N... 100644 100644 100644 a a modified.ts\n",
          undefined,
          undefined,
          { mode: "parallel" },
        );
        expect(result.ok).toBe(false);
        expect(result.blockers).toContainEqual({
          _tag: "dirty_tree",
          paths: ["modified.ts"],
        });
      }),
    );

    it.effect("warns instead of blocking on untracked files", () =>
      Effect.gen(function* () {
        const result = yield* run("# branch.head main\n? untracked.ts\n", undefined, undefined, {
          mode: "parallel",
        });
        expect(result.ok).toBe(true);
        expect(result.blockers).toEqual([]);
        expect(result.warnings).toContainEqual({
          _tag: "untracked_files",
          paths: ["untracked.ts"],
        });
      }),
    );

    describe("with vcs.runOwnedBaseBranch (t3code-5m4)", () => {
      const runOwnedConfig = {
        _tag: "loaded" as const,
        configPath: "/repo/.t3code/epic-run.json",
        override: { vcs: { runOwnedBaseBranch: true } },
        config: {} as never,
        presentKeys: ["vcs.runOwnedBaseBranch"],
        unknownKeys: [],
      };

      it.effect("no longer blocks tracked modifications in parallel mode", () =>
        Effect.gen(function* () {
          const result = yield* run(
            "# branch.head main\n1 M. N... 100644 100644 100644 a a modified.ts\n",
            undefined,
            undefined,
            { mode: "parallel", config: runOwnedConfig },
          );
          expect(result.ok).toBe(true);
          expect(result.blockers.some((blocker) => blocker._tag === "dirty_tree")).toBe(false);
        }),
      );

      it.effect("still reports the ignored tracked changes as a warning", () =>
        Effect.gen(function* () {
          // Dropping the blocker must not drop the signal. The run cooks
          // against committed code only, and the operator has to know that.
          const result = yield* run(
            "# branch.head main\n1 M. N... 100644 100644 100644 a a modified.ts\n",
            undefined,
            undefined,
            { mode: "parallel", config: runOwnedConfig },
          );
          expect(result.ok).toBe(true);
          expect(
            result.warnings.find((warning) => warning._tag === "tracked_changes_ignored"),
          ).toEqual({ _tag: "tracked_changes_ignored", paths: ["modified.ts"] });
        }),
      );

      it.effect("blocks when the operator has the run-owned base branch checked out", () =>
        Effect.gen(function* () {
          // Landing updates that ref with `git fetch . <ref>:<branch>`, which
          // git refuses for a branch checked out anywhere. Caught at launch,
          // this is a refusal; missed, it is a mid-run fatal after workers
          // have already finished children.
          const result = yield* run(
            `# branch.head ${runBaseBranch("epic-1")}\n`,
            undefined,
            undefined,
            { mode: "parallel", config: runOwnedConfig },
          );
          expect(result.ok).toBe(false);
          expect(
            result.blockers.find((blocker) => blocker._tag === "run_base_branch_checked_out"),
          ).toEqual({
            _tag: "run_base_branch_checked_out",
            branch: runBaseBranch("epic-1"),
          });
        }),
      );

      it.effect("still blocks tracked modifications in sequential mode", () =>
        Effect.gen(function* () {
          // Sequential workers still commit directly in the main checkout, so
          // the run-owned base branch (which sequential mode never creates)
          // changes nothing here.
          const result = yield* run(
            "# branch.head main\n1 M. N... 100644 100644 100644 a a modified.ts\n",
            undefined,
            undefined,
            { mode: "sequential", config: runOwnedConfig },
          );
          expect(result.ok).toBe(false);
          expect(result.blockers).toContainEqual({
            _tag: "dirty_tree",
            paths: ["modified.ts"],
          });
        }),
      );

      it.effect("leaves untracked-file handling unchanged", () =>
        Effect.gen(function* () {
          const result = yield* run("# branch.head main\n? untracked.ts\n", undefined, undefined, {
            mode: "parallel",
            config: runOwnedConfig,
          });
          expect(result.ok).toBe(true);
          expect(result.blockers).toEqual([]);
          expect(result.warnings).toContainEqual({
            _tag: "untracked_files",
            paths: ["untracked.ts"],
          });
        }),
      );

      it.effect("still blocks a dirty registered nested worktree", () =>
        Effect.gen(function* () {
          // The flag exempts the operator's own tracked edits, not crash
          // residue from a previous parallel run's worker worktrees.
          const result = yield* run(
            "# branch.head main\n? .claude/worktrees/wt-1/\n",
            undefined,
            undefined,
            {
              mode: "parallel",
              config: runOwnedConfig,
              worktreeList:
                "worktree /repo\nbranch refs/heads/main\n\nworktree /repo/.claude/worktrees/wt-1\nbranch refs/heads/child-branch\n",
              nestedStatus: {
                "/repo/.claude/worktrees/wt-1": { stdout: " M scratch.ts\n" },
              },
            },
          );
          expect(result.ok).toBe(false);
          expect(result.blockers).toContainEqual({
            _tag: "dirty_tree",
            paths: [".claude/worktrees/wt-1"],
          });
        }),
      );

      const ownedBranchOutput = (code: number) =>
        Object.freeze({
          stdout: "",
          stderr: "",
          code: code as never,
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
        });

      it.effect("warns when the reused base branch is behind the operator's branch", () =>
        Effect.gen(function* () {
          const result = yield* run("# branch.head main\n", undefined, undefined, {
            mode: "parallel",
            config: runOwnedConfig,
            processOverride: (input) => {
              if (input.command !== "git") return undefined;
              if (input.args[0] === "show-ref") return ownedBranchOutput(0);
              if (input.args[0] === "rev-list") {
                return { ...ownedBranchOutput(0), stdout: "3\n" };
              }
              return undefined;
            },
          });
          expect(result.ok).toBe(true);
          expect(result.warnings).toContainEqual({
            _tag: "run_base_branch_stale",
            epicId: "epic-1",
            branch: "epic/epic-1/base",
            commitsBehind: 3,
          });
        }),
      );

      it.effect("does not warn when the reused base branch is caught up", () =>
        Effect.gen(function* () {
          const result = yield* run("# branch.head main\n", undefined, undefined, {
            mode: "parallel",
            config: runOwnedConfig,
            processOverride: (input) => {
              if (input.command !== "git") return undefined;
              if (input.args[0] === "show-ref") return ownedBranchOutput(0);
              if (input.args[0] === "rev-list") {
                return { ...ownedBranchOutput(0), stdout: "0\n" };
              }
              return undefined;
            },
          });
          expect(result.warnings.some((warning) => warning._tag === "run_base_branch_stale")).toBe(
            false,
          );
        }),
      );

      it.effect("does not warn when the base branch does not exist yet", () =>
        Effect.gen(function* () {
          const result = yield* run("# branch.head main\n", undefined, undefined, {
            mode: "parallel",
            config: runOwnedConfig,
            processOverride: (input) => {
              if (input.command !== "git") return undefined;
              if (input.args[0] === "show-ref") return ownedBranchOutput(1);
              return undefined;
            },
          });
          expect(result.warnings.some((warning) => warning._tag === "run_base_branch_stale")).toBe(
            false,
          );
        }),
      );
    });

    it.effect("ignores a clean registered nested worktree", () =>
      Effect.gen(function* () {
        const result = yield* run(
          "# branch.head main\n? .claude/worktrees/wt-1/\n",
          undefined,
          undefined,
          {
            mode: "parallel",
            worktreeList:
              "worktree /repo\nbranch refs/heads/main\n\nworktree /repo/.claude/worktrees/wt-1\nbranch refs/heads/child-branch\n",
            nestedStatus: { "/repo/.claude/worktrees/wt-1": { stdout: "" } },
          },
        );
        expect(result.ok).toBe(true);
        expect(result.blockers).toEqual([]);
        expect(result.warnings).toEqual([]);
      }),
    );

    it.effect("blocks a dirty registered nested worktree", () =>
      Effect.gen(function* () {
        const result = yield* run(
          "# branch.head main\n? .claude/worktrees/wt-1/\n",
          undefined,
          undefined,
          {
            mode: "parallel",
            worktreeList:
              "worktree /repo\nbranch refs/heads/main\n\nworktree /repo/.claude/worktrees/wt-1\nbranch refs/heads/child-branch\n",
            nestedStatus: {
              "/repo/.claude/worktrees/wt-1": { stdout: " M scratch.ts\n" },
            },
          },
        );
        expect(result.ok).toBe(false);
        expect(result.blockers).toContainEqual({
          _tag: "dirty_tree",
          paths: [".claude/worktrees/wt-1"],
        });
      }),
    );

    it.effect("blocks a leftover integration branch", () =>
      Effect.gen(function* () {
        const result = yield* run("# branch.head main\n", undefined, undefined, {
          mode: "parallel",
          branchList: "cook-epic-integration-run-9\n",
        });
        expect(result.ok).toBe(false);
        expect(result.blockers).toContainEqual({
          _tag: "integration_leftover",
          branch: "cook-epic-integration-run-9",
          worktreePath: null,
        });
      }),
    );

    it.effect("blocks a leftover integration worktree", () =>
      Effect.gen(function* () {
        const result = yield* run("# branch.head main\n", undefined, undefined, {
          mode: "parallel",
          worktreeList:
            "worktree /repo\nbranch refs/heads/main\n\nworktree /worktrees/epic-run-9/integration\nbranch refs/heads/cook-epic-integration-run-9\n",
        });
        expect(result.ok).toBe(false);
        expect(result.blockers).toContainEqual({
          _tag: "integration_leftover",
          branch: null,
          worktreePath: "/worktrees/epic-run-9/integration",
        });
      }),
    );

    it.effect("lets a resuming run past its own integration branch and worktree", () =>
      Effect.gen(function* () {
        // A parallel run owns these for its whole life. Treating them as
        // leftovers refused a crashed run permission to continue itself,
        // quoting its own run id back at the operator.
        const result = yield* run("# branch.head main\n", undefined, undefined, {
          mode: "parallel",
          branchList: "cook-epic-integration-run-9\n",
          worktreeList:
            "worktree /repo\nbranch refs/heads/main\n\nworktree /worktrees/epic-run-9/integration\nbranch refs/heads/cook-epic-integration-run-9\n",
          resume: { runId: "run-9" },
        });
        expect(result.blockers.some((blocker) => blocker._tag === "integration_leftover")).toBe(
          false,
        );
      }),
    );

    it.effect("still blocks another run's integration leftovers while resuming", () =>
      Effect.gen(function* () {
        // Forgiveness is exact: only this run id's own branch is its own.
        const result = yield* run("# branch.head main\n", undefined, undefined, {
          mode: "parallel",
          branchList: "cook-epic-integration-run-other\n",
          resume: { runId: "run-9" },
        });
        expect(result.ok).toBe(false);
        expect(result.blockers).toContainEqual({
          _tag: "integration_leftover",
          branch: "cook-epic-integration-run-other",
          worktreePath: null,
        });
      }),
    );

    it.effect("still blocks detached HEAD", () =>
      Effect.gen(function* () {
        const result = yield* run("# branch.head (detached)\n", undefined, undefined, {
          mode: "parallel",
        });
        expect(result.blockers).toContainEqual({ _tag: "detached_head" });
      }),
    );

    it.effect("reports a held lock instead of the holder's dirtiness", () =>
      Effect.gen(function* () {
        const result = yield* run(
          "# branch.head main\n1 M. N... 100644 100644 100644 a a modified.ts\n? untracked.ts\n",
          { workspaceRoot: "/repo", epicId: "epic-1" },
          undefined,
          { mode: "parallel" },
        );
        expect(result.ok).toBe(false);
        expect(result.blockers).toEqual([
          {
            _tag: "run_in_progress",
            owner: "terminal",
            runDir: "/tmp/run",
            host: "host",
            pid: 42,
          },
        ]);
      }),
    );
  });

  it.effect("sequential mode reports a held lock instead of the holder's dirtiness", () =>
    Effect.gen(function* () {
      const result = yield* run(
        "# branch.head main\n1 M. N... 100644 100644 100644 a a modified.ts\n",
        { workspaceRoot: "/repo", epicId: "epic-1" },
      );
      expect(result.ok).toBe(false);
      expect(result.blockers).toEqual([
        {
          _tag: "run_in_progress",
          owner: "terminal",
          runDir: "/tmp/run",
          host: "host",
          pid: 42,
        },
      ]);
    }),
  );

  describe("stranded child branches (t3code-9gg)", () => {
    interface BdChildRow {
      readonly id: string;
      readonly status: string;
    }
    const closedChild = (id: string): BdChildRow => ({ id, status: "closed" });
    const bdList = (entries: ReadonlyArray<BdChildRow>) => ({ list: JSON.stringify(entries) });

    it.effect("blocks a closed child whose branch never landed", () =>
      Effect.gen(function* () {
        const result = yield* run(
          "# branch.head main\n",
          undefined,
          bdList([closedChild("child-1")]),
          { mode: "parallel", unmergedBranchList: "epic/child-1\n" },
        );
        expect(result.ok).toBe(false);
        expect(result.blockers).toContainEqual({
          _tag: "stranded_child_branches",
          baseBranch: "main",
          branches: [{ childId: "child-1", branch: "epic/child-1" }],
        });
      }),
    );

    it.effect("blocks in sequential mode too", () =>
      Effect.gen(function* () {
        // The check is deliberately outside the parallel-only mode gate: a
        // sequential run commits straight onto the base and never looks at
        // `epic/<childId>`, so it strands a previous parallel run's branches
        // exactly as thoroughly.
        const result = yield* run(
          "# branch.head main\n",
          undefined,
          bdList([closedChild("child-1")]),
          { mode: "sequential", unmergedBranchList: "epic/child-1\n" },
        );
        expect(result.blockers.some((blocker) => blocker._tag === "stranded_child_branches")).toBe(
          true,
        );
      }),
    );

    it.effect("names every stranded child, sorted", () =>
      Effect.gen(function* () {
        const result = yield* run(
          "# branch.head main\n",
          undefined,
          bdList([closedChild("child-2"), closedChild("child-1"), closedChild("child-3")]),
          { unmergedBranchList: "epic/child-3\nepic/child-1\n" },
        );
        expect(result.blockers).toContainEqual({
          _tag: "stranded_child_branches",
          baseBranch: "main",
          branches: [
            { childId: "child-1", branch: "epic/child-1" },
            { childId: "child-3", branch: "epic/child-3" },
          ],
        });
      }),
    );

    it.effect("ignores a closed child whose branch is merged", () =>
      Effect.gen(function* () {
        // Merged-ness is the signal, not existence: child branches are never
        // deleted after landing, so every finished epic leaves them behind.
        const result = yield* run(
          "# branch.head main\n",
          undefined,
          bdList([closedChild("child-1")]),
          { unmergedBranchList: "epic/other-epic-child\n" },
        );
        expect(result.ok).toBe(true);
        expect(result.blockers).toEqual([]);
      }),
    );

    it.effect("ignores an unmerged branch whose child is still open", () =>
      Effect.gen(function* () {
        // An open child is work the run will pick up and land itself.
        const result = yield* run(
          "# branch.head main\n",
          undefined,
          bdList([
            { id: "child-1", status: "open" },
            { id: "child-2", status: "in_progress" },
          ]),
          { unmergedBranchList: "epic/child-1\nepic/child-2\n" },
        );
        expect(result.ok).toBe(true);
      }),
    );

    it.effect("ignores the run-owned base branch, which matches the same pattern", () =>
      Effect.gen(function* () {
        // `epic/*` also matches `epic/<epicId>/base`, and that branch is
        // unmerged into the operator's branch by design. It can never equal a
        // `childBranch(id)`, so the intersection drops it.
        const result = yield* run(
          "# branch.head main\n",
          undefined,
          bdList([closedChild("child-1")]),
          { unmergedBranchList: `${runBaseBranch("epic-1")}\n` },
        );
        expect(result.ok).toBe(true);
      }),
    );

    it.effect("issues no branch scan when the epic has no closed children", () =>
      Effect.gen(function* () {
        // Every run of a young epic takes this path, so it must cost nothing.
        const scans: Array<ReadonlyArray<string>> = [];
        const result = yield* run("# branch.head main\n", undefined, undefined, {
          onGit: (input) => {
            if (input.args.includes("--no-merged")) scans.push(input.args);
          },
        });
        expect(result.ok).toBe(true);
        expect(scans).toEqual([]);
      }),
    );

    it.effect("warns instead of blocking when the run is resuming", () =>
      Effect.gen(function* () {
        // A resume keeps its own run id, so its queue still holds what it
        // enqueued, and a resume fails on any blocker at all. Refusing it would
        // refuse a crashed run permission to continue itself.
        const result = yield* run(
          "# branch.head main\n",
          undefined,
          bdList([closedChild("child-1")]),
          { unmergedBranchList: "epic/child-1\n", resume: { runId: "run-9" } },
        );
        expect(result.ok).toBe(true);
        expect(result.blockers.some((blocker) => blocker._tag === "stranded_child_branches")).toBe(
          false,
        );
        expect(result.warnings).toContainEqual({
          _tag: "stranded_child_branches_accepted",
          baseBranch: "main",
          branches: [{ childId: "child-1", branch: "epic/child-1" }],
        });
      }),
    );

    it.effect("measures against the run-owned base branch when it exists", () =>
      Effect.gen(function* () {
        const scans: Array<ReadonlyArray<string>> = [];
        yield* run("# branch.head main\n", undefined, bdList([closedChild("child-1")]), {
          config: {
            _tag: "loaded",
            configPath: "/repo/.t3code/epic-run.json",
            override: { vcs: { runOwnedBaseBranch: true } },
            config: {} as never,
            presentKeys: ["vcs.runOwnedBaseBranch"],
            unknownKeys: [],
          },
          onGit: (input) => {
            if (input.args.includes("--no-merged")) scans.push(input.args);
          },
        });
        expect(scans).toEqual([
          [
            "branch",
            "--list",
            "--no-merged",
            runBaseBranch("epic-1"),
            "--format=%(refname:short)",
            "epic/*",
          ],
        ]);
      }),
    );

    it.effect("falls back to the checked-out branch when the owned base does not exist", () =>
      Effect.gen(function* () {
        // The run would create it from the current branch, so the current
        // branch is what a not-yet-existing owned base measures as.
        const scans: Array<ReadonlyArray<string>> = [];
        yield* run("# branch.head main\n", undefined, bdList([closedChild("child-1")]), {
          config: {
            _tag: "loaded",
            configPath: "/repo/.t3code/epic-run.json",
            override: { vcs: { runOwnedBaseBranch: true } },
            config: {} as never,
            presentKeys: ["vcs.runOwnedBaseBranch"],
            unknownKeys: [],
          },
          processOverride: (input) =>
            input.args[0] === "show-ref"
              ? {
                  stdout: "",
                  stderr: "",
                  code: 1 as never,
                  timedOut: false,
                  stdoutTruncated: false,
                  stderrTruncated: false,
                }
              : undefined,
          onGit: (input) => {
            if (input.args.includes("--no-merged")) scans.push(input.args);
          },
        });
        expect(scans[0]?.[3]).toBe("main");
      }),
    );

    it.effect("does not cross-contaminate the integration-leftover scan", () =>
      Effect.gen(function* () {
        // Two `git branch` calls now run in parallel mode. The leftover scan
        // does not re-filter by prefix, so an `epic/*` result reaching it would
        // read as a leftover integration branch.
        const result = yield* run(
          "# branch.head main\n",
          undefined,
          bdList([closedChild("child-1")]),
          { mode: "parallel", unmergedBranchList: "epic/child-1\n" },
        );
        expect(result.blockers.some((blocker) => blocker._tag === "integration_leftover")).toBe(
          false,
        );
        expect(result.blockers.some((blocker) => blocker._tag === "stranded_child_branches")).toBe(
          true,
        );
      }),
    );

    it.effect("skips the check on a detached HEAD", () =>
      Effect.gen(function* () {
        // There is no base branch to measure against, and detached HEAD
        // already blocks on its own.
        const scans: Array<ReadonlyArray<string>> = [];
        const result = yield* run(
          "# branch.head (detached)\n",
          undefined,
          bdList([closedChild("child-1")]),
          {
            unmergedBranchList: "epic/child-1\n",
            onGit: (input) => {
              if (input.args.includes("--no-merged")) scans.push(input.args);
            },
          },
        );
        expect(scans).toEqual([]);
        expect(result.blockers).toEqual([{ _tag: "detached_head" }]);
      }),
    );
  });

  describe("siblings", () => {
    const siblingSnapshot = (
      siblings: ReadonlyArray<string>,
      noPush = false,
    ): EpicRunConfigSnapshot => ({
      fileResult: { _tag: "absent" },
      config: {
        ...DEFAULT_EPIC_RUN_CONFIG,
        parallel: { ...DEFAULT_EPIC_RUN_CONFIG.parallel, siblings: [...siblings] },
        vcs: { ...DEFAULT_EPIC_RUN_CONFIG.vcs, noPush },
      },
      provenance: DEFAULT_EPIC_RUN_CONFIG_PROVENANCE,
      violations: [],
    });

    const siblingOutput = (stdout: string, code = 0): ProcessRunner.ProcessRunOutput => ({
      stdout,
      stderr: "",
      code: code as never,
      timedOut: false,
      stdoutTruncated: false,
      stderrTruncated: false,
    });

    const siblingProcesses =
      (overrides: {
        readonly symbolicRefCode?: number;
        readonly diffIndexCode?: number;
        readonly originCode?: number;
        readonly relativePath?: string;
      }) =>
      (input: ProcessRunner.ProcessRunInput): ProcessRunner.ProcessRunOutput | undefined => {
        const { command, args } = input;
        if (command === "realpath") {
          const target = args[0] ?? "";
          if (target.startsWith("--relative-to=")) {
            return siblingOutput(`${overrides.relativePath ?? "../sibling"}\n`);
          }
          return siblingOutput(target === "/repo" ? "/repo\n" : "/sibling\n");
        }
        if (command === "git" && args[0] === "-C") {
          switch (args[2]) {
            case "rev-parse":
              return siblingOutput(".git\n");
            case "symbolic-ref":
              return siblingOutput(
                overrides.symbolicRefCode === undefined ? "main\n" : "",
                overrides.symbolicRefCode ?? 0,
              );
            case "update-index":
              return siblingOutput("");
            case "diff-index":
              return siblingOutput("", overrides.diffIndexCode ?? 0);
            case "remote":
              return siblingOutput("git@example.com:sibling.git\n", overrides.originCode ?? 0);
          }
        }
        return undefined;
      };

    it.effect("accepts a valid sibling without blockers", () =>
      Effect.gen(function* () {
        const result = yield* run("# branch.head main\n", undefined, undefined, {
          configSnapshot: siblingSnapshot(["../sibling"]),
          processOverride: siblingProcesses({}),
        });
        expect(result.ok).toBe(true);
        expect(result.blockers).toEqual([]);
      }),
    );

    it.effect("blocks a sibling that is not on a branch", () =>
      Effect.gen(function* () {
        const result = yield* run("# branch.head main\n", undefined, undefined, {
          configSnapshot: siblingSnapshot(["../sibling"]),
          processOverride: siblingProcesses({ symbolicRefCode: 128 }),
        });
        expect(result.ok).toBe(false);
        expect(result.blockers).toContainEqual({
          _tag: "sibling_invalid",
          path: "/sibling",
          detail:
            "sibling repo '/sibling' is not on a branch; check out a branch there before launching",
        });
      }),
    );

    it.effect("blocks a dirty sibling", () =>
      Effect.gen(function* () {
        const result = yield* run("# branch.head main\n", undefined, undefined, {
          configSnapshot: siblingSnapshot(["../sibling"]),
          processOverride: siblingProcesses({ diffIndexCode: 1 }),
        });
        expect(result.blockers).toContainEqual({
          _tag: "sibling_invalid",
          path: "/sibling",
          detail:
            "sibling repo '/sibling' has uncommitted changes; commit or stash there before launching — workers commit on its branch",
        });
      }),
    );

    it.effect("skips the origin check when pushing is disabled", () =>
      Effect.gen(function* () {
        const result = yield* run("# branch.head main\n", undefined, undefined, {
          configSnapshot: siblingSnapshot(["../sibling"], true),
          processOverride: siblingProcesses({ originCode: 2 }),
        });
        expect(result.blockers).toEqual([]);
      }),
    );

    it.effect("requires an origin remote when pushing is enabled", () =>
      Effect.gen(function* () {
        const result = yield* run("# branch.head main\n", undefined, undefined, {
          configSnapshot: siblingSnapshot(["../sibling"]),
          processOverride: siblingProcesses({ originCode: 2 }),
        });
        expect(result.blockers).toContainEqual({
          _tag: "sibling_invalid",
          path: "/sibling",
          detail:
            "sibling repo '/sibling' has no origin remote; add an origin remote or set vcs.noPush for local-only landing",
        });
      }),
    );

    it.effect("blocks a sibling nested inside the main repo in parallel mode", () =>
      Effect.gen(function* () {
        const result = yield* run("# branch.head main\n", undefined, undefined, {
          mode: "parallel",
          configSnapshot: siblingSnapshot(["packages/sibling"]),
          processOverride: siblingProcesses({ relativePath: "packages/sibling" }),
        });
        expect(result.ok).toBe(false);
        expect(result.blockers).toContainEqual({
          _tag: "sibling_invalid",
          path: "/sibling",
          detail:
            "sibling repo '/sibling' resolves inside the main repository; parallel layouts cannot mirror it — move the sibling outside the project root or run sequentially",
        });
      }),
    );

    it.effect("allows a nested sibling in sequential mode", () =>
      Effect.gen(function* () {
        const result = yield* run("# branch.head main\n", undefined, undefined, {
          configSnapshot: siblingSnapshot(["packages/sibling"]),
          processOverride: siblingProcesses({ relativePath: "packages/sibling" }),
        });
        expect(result.blockers).toEqual([]);
      }),
    );

    it.effect("issues no sibling validation commands when no siblings are configured", () =>
      Effect.gen(function* () {
        const seen: Array<string> = [];
        const result = yield* run("# branch.head main\n", undefined, undefined, {
          processOverride: (input) => {
            seen.push(`${input.command} ${input.args[0] ?? ""}`);
            return undefined;
          },
        });
        expect(result.ok).toBe(true);
        expect(seen.some((entry) => entry.startsWith("realpath"))).toBe(false);
        expect(seen.some((entry) => entry === "git -C")).toBe(false);
      }),
    );
  });

  describe("resume intent", () => {
    const dirtySequential =
      "# branch.head main\n1 M. N... 100644 100644 100644 a a modified.ts\n? untracked.ts\n";

    it.effect("accepts a resumed sequential run's own dirty tree", () =>
      Effect.gen(function* () {
        const result = yield* run(dirtySequential, undefined, undefined, {
          mode: "sequential",
          intent: "resume",
        });
        expect(result.ok).toBe(true);
        expect(result.blockers).toEqual([]);
        expect(result.warnings).toContainEqual({
          _tag: "dirty_tree_accepted",
          paths: ["modified.ts", "untracked.ts"],
        });
      }),
    );

    it.effect("still blocks the same dirty tree on a launch", () =>
      Effect.gen(function* () {
        const result = yield* run(dirtySequential, undefined, undefined, { mode: "sequential" });
        expect(result.ok).toBe(false);
        expect(result.blockers).toEqual([
          { _tag: "dirty_tree", paths: ["modified.ts", "untracked.ts"] },
        ]);
        expect(result.warnings.some((warning) => warning._tag === "dirty_tree_accepted")).toBe(
          false,
        );
      }),
    );

    it.effect("still blocks tracked dirt in a resumed parallel run", () =>
      Effect.gen(function* () {
        // Parallel workers commit in their own worktrees, so base dirt is the
        // operator's, never the resuming run's.
        const result = yield* run(
          "# branch.head main\n1 M. N... 100644 100644 100644 a a modified.ts\n",
          undefined,
          undefined,
          { mode: "parallel", intent: "resume" },
        );
        expect(result.ok).toBe(false);
        expect(result.blockers).toContainEqual({ _tag: "dirty_tree", paths: ["modified.ts"] });
      }),
    );

    it.effect("still blocks detached HEAD on a resume", () =>
      Effect.gen(function* () {
        const result = yield* run("# branch.head (detached)\n", undefined, undefined, {
          intent: "resume",
        });
        expect(result.blockers).toContainEqual({ _tag: "detached_head" });
      }),
    );

    it.effect("still blocks a missing epic on a resume", () =>
      Effect.gen(function* () {
        const result = yield* run(
          "# branch.head main\n",
          undefined,
          { show: "[]" },
          { intent: "resume" },
        );
        expect(result.blockers).toContainEqual({ _tag: "epic_not_found", epicId: "epic-1" });
      }),
    );

    it.effect("still reports a held lock on a resume", () =>
      Effect.gen(function* () {
        const result = yield* run(
          dirtySequential,
          { workspaceRoot: "/repo", epicId: "epic-1" },
          undefined,
          { intent: "resume" },
        );
        expect(result.blockers).toEqual([
          {
            _tag: "run_in_progress",
            owner: "terminal",
            runDir: "/tmp/run",
            host: "host",
            pid: 42,
          },
        ]);
      }),
    );

    it.effect("still warns that nothing is ready on a resume", () =>
      Effect.gen(function* () {
        // The claimed child is in_progress, so an empty ready list is expected.
        const result = yield* run(
          "# branch.head main\n",
          undefined,
          { ready: "[]" },
          { intent: "resume" },
        );
        expect(result.ok).toBe(true);
        expect(result.warnings).toContainEqual({ _tag: "nothing_ready", epicId: "epic-1" });
      }),
    );
  });

  describe("resume worktrees", () => {
    const WORKER = "/repo/workers/child-1";
    const workerWorktreeList = `worktree /repo\nbranch refs/heads/main\n\nworktree ${WORKER}\nbranch refs/heads/epic-child-1\n`;

    it.effect("ignores dirt inside a worktree the resumed run owns", () =>
      Effect.gen(function* () {
        const nestedProbes: Array<string> = [];
        const result = yield* run(
          "# branch.head main\n? workers/child-1/\n",
          undefined,
          undefined,
          {
            mode: "parallel",
            intent: "resume",
            resume: { runId: "run-9", worktreePaths: [WORKER] },
            worktreeList: workerWorktreeList,
            nestedStatus: { [WORKER]: { stdout: " M src/a.ts\n" } },
            onGit: (input) => {
              if (input.args[0] === "status" && input.cwd !== "/repo")
                nestedProbes.push(input.cwd ?? "");
            },
          },
        );
        expect(result.ok).toBe(true);
        expect(result.blockers).toEqual([]);
        // The interrupted agent's own unfinished work: not probed, not dirt,
        // and not left behind as an untracked directory either.
        expect(nestedProbes).toEqual([]);
        expect(result.warnings.some((warning) => warning._tag === "untracked_files")).toBe(false);
      }),
    );

    it.effect("still blocks a dirty nested worktree the resume does not name", () =>
      Effect.gen(function* () {
        const result = yield* run(
          "# branch.head main\n? workers/child-1/\n? workers/stranger/\n",
          undefined,
          undefined,
          {
            mode: "parallel",
            intent: "resume",
            resume: { runId: "run-9", worktreePaths: [WORKER] },
            worktreeList: `${workerWorktreeList}\nworktree /repo/workers/stranger\nbranch refs/heads/epic-stranger\n`,
            nestedStatus: {
              [WORKER]: { stdout: " M src/a.ts\n" },
              "/repo/workers/stranger": { stdout: " M src/b.ts\n" },
            },
          },
        );
        expect(result.ok).toBe(false);
        expect(result.blockers).toContainEqual({
          _tag: "dirty_tree",
          paths: ["workers/stranger"],
        });
      }),
    );

    it.effect("warns when a resumed worktree is no longer registered", () =>
      Effect.gen(function* () {
        const result = yield* run("# branch.head main\n", undefined, undefined, {
          mode: "parallel",
          intent: "resume",
          resume: { runId: "run-9", worktreePaths: [WORKER, "/repo/workers/pruned"] },
          worktreeList: workerWorktreeList,
        });
        expect(result.ok).toBe(true);
        expect(result.warnings).toContainEqual({
          _tag: "resume_worktree_missing",
          paths: ["/repo/workers/pruned"],
        });
      }),
    );

    it.effect("warns when a registered resumed worktree is gone from disk", () =>
      Effect.gen(function* () {
        const result = yield* run("# branch.head main\n", undefined, undefined, {
          mode: "parallel",
          intent: "resume",
          resume: { runId: "run-9", worktreePaths: [WORKER] },
          worktreeList: workerWorktreeList,
          pathExists: { [WORKER]: false },
        });
        expect(result.warnings).toContainEqual({
          _tag: "resume_worktree_missing",
          paths: [WORKER],
        });
      }),
    );

    it.effect("says nothing when every resumed worktree is still there", () =>
      Effect.gen(function* () {
        const result = yield* run("# branch.head main\n", undefined, undefined, {
          mode: "parallel",
          intent: "resume",
          resume: { runId: "run-9", worktreePaths: [WORKER] },
          worktreeList: workerWorktreeList,
        });
        expect(result.warnings.some((warning) => warning._tag === "resume_worktree_missing")).toBe(
          false,
        );
      }),
    );

    it.effect("checks resumed worktrees in sequential mode too", () =>
      Effect.gen(function* () {
        const result = yield* run("# branch.head main\n", undefined, undefined, {
          mode: "sequential",
          intent: "resume",
          resume: { runId: "run-9", worktreePaths: ["/repo/workers/pruned"] },
        });
        expect(result.warnings).toContainEqual({
          _tag: "resume_worktree_missing",
          paths: ["/repo/workers/pruned"],
        });
      }),
    );

    it.effect("issues no worktree command for a sequential launch", () =>
      Effect.gen(function* () {
        const seen: Array<ReadonlyArray<string>> = [];
        yield* run("# branch.head main\n", undefined, undefined, {
          mode: "sequential",
          onGit: (input) => {
            seen.push(input.args);
          },
        });
        expect(seen.some((args) => args[0] === "worktree")).toBe(false);
      }),
    );
  });

  describe("workspace probe", () => {
    it.effect("blocks a missing workspace root without running a command", () =>
      Effect.gen(function* () {
        const seen: Array<string> = [];
        const result = yield* run("# branch.head main\n", undefined, undefined, {
          workspaceExists: false,
          processOverride: (input) => {
            seen.push(input.command);
            return undefined;
          },
        });
        expect(result.ok).toBe(false);
        expect(result.blockers).toEqual([{ _tag: "workspace_missing", workspaceRoot: "/repo" }]);
        expect(result.warnings).toEqual([]);
        expect(seen).toEqual([]);
        expect(result.resolvedConfig).toEqual(DEFAULT_EPIC_RUN_CONFIG);
        expect(result.configProvenance).toEqual(DEFAULT_EPIC_RUN_CONFIG_PROVENANCE);
      }),
    );

    it.effect("blocks a missing workspace root on a resume too", () =>
      Effect.gen(function* () {
        const result = yield* run("# branch.head main\n", undefined, undefined, {
          mode: "parallel",
          intent: "resume",
          workspaceExists: false,
        });
        expect(result.blockers).toEqual([{ _tag: "workspace_missing", workspaceRoot: "/repo" }]);
      }),
    );
  });
});
