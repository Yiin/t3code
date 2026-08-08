import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  EpicRunPreflightError,
  type EpicRunConfig,
  type EpicRunConfigOverride,
  type EpicRunConfigProvenance,
  type EpicRunPreflightBlocker,
  type EpicRunPreflightInput,
  type EpicRunPreflightResult,
  type EpicRunPreflightWarning,
} from "@t3tools/contracts";
import { resolveEpicRunConfig, type EpicRunConfigViolation } from "@t3tools/shared/epicRunConfig";

import { EpicRunConfigSource, type EpicRunConfigFileResult } from "./EpicRunConfigSource.ts";
import { INTEGRATION_BRANCH_PREFIX } from "./policy.ts";
import { EpicRunLock } from "./ports/EpicRunLock.ts";
import { ProcessRunner } from "./processRunner.ts";
import { makeSiblingResolver } from "./siblings.ts";

const COMMAND_TIMEOUT = Duration.seconds(20);
const MAX_BLOCKER_TEXT_LENGTH = 2_048;

function boundedBlockerText(value: string): string {
  return value.length <= MAX_BLOCKER_TEXT_LENGTH
    ? value
    : `${value.slice(0, MAX_BLOCKER_TEXT_LENGTH - 3)}...`;
}

export function formatEpicRunPreflightBlocker(blocker: EpicRunPreflightBlocker): string {
  switch (blocker._tag) {
    case "dirty_tree":
      return boundedBlockerText(`The worktree has changes: ${blocker.paths.join(", ")}`);
    case "detached_head":
      return "The repository has a detached HEAD.";
    case "run_in_progress":
      return boundedBlockerText(
        `Another epic run owns this repository on ${blocker.host} (PID ${String(blocker.pid)}, ${blocker.runDir}).`,
      );
    case "epic_not_found":
      return boundedBlockerText(`Epic ${blocker.epicId} was not found.`);
    case "config_invalid":
      return boundedBlockerText(`${blocker.configPath}\n${blocker.diagnostics.join("\n")}`);
    case "integration_leftover":
      return boundedBlockerText(
        `A previous parallel run left ${
          blocker.branch !== null ? `integration branch ${blocker.branch}` : "an integration branch"
        }${
          blocker.worktreePath !== null ? ` (worktree ${blocker.worktreePath})` : ""
        } behind; reconcile it before launching.`,
      );
    case "sibling_invalid":
      return boundedBlockerText(blocker.detail);
  }
}

export interface EpicRunPreflightShape {
  readonly check: (
    input: EpicRunPreflightInput,
    configSnapshot?: EpicRunConfigSnapshot,
  ) => Effect.Effect<EpicRunPreflightResult, EpicRunPreflightError>;
}

/** The immutable config view shared by launch and preflight. */
export interface EpicRunConfigSnapshot {
  readonly fileResult: EpicRunConfigFileResult;
  readonly config: EpicRunConfig;
  readonly provenance: EpicRunConfigProvenance;
  readonly violations: readonly EpicRunConfigViolation[];
}

export const makeEpicRunConfigSnapshot = (input: {
  readonly fileResult: EpicRunConfigFileResult;
  readonly override: EpicRunConfigOverride | null;
  readonly harness: string | null;
}): EpicRunConfigSnapshot => ({
  fileResult: input.fileResult,
  ...resolveEpicRunConfig({
    file: input.fileResult._tag === "loaded" ? input.fileResult.override : null,
    environment: null,
    override: input.override,
    harness: input.harness,
  }),
});

export class EpicRunPreflight extends Context.Service<EpicRunPreflight, EpicRunPreflightShape>()(
  "@t3tools/epic-core/EpicRunPreflight",
) {}

function parseArray(stdout: string): ReadonlyArray<Record<string, unknown>> | null {
  try {
    const value: unknown = JSON.parse(stdout);
    return Array.isArray(value)
      ? value.filter(
          (entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null,
        )
      : null;
  } catch {
    return null;
  }
}

function porcelainPath(line: string): string | null {
  if (line.startsWith("? ") || line.startsWith("! ")) return line.slice(2);
  const firstTab = line.indexOf("\t");
  if (firstTab >= 0) return line.slice(0, firstTab).split(" ").at(-1) ?? null;
  const fields = line.split(" ");
  return fields.at(-1) ?? null;
}

function isBeadsPath(path: string): boolean {
  return path === ".beads" || path.startsWith(".beads/");
}

interface WorktreeEntry {
  readonly path: string;
  readonly branch: string | null;
}

function parseWorktreeList(stdout: string): ReadonlyArray<WorktreeEntry> {
  const entries: Array<{ path: string; branch: string | null }> = [];
  let current: { path: string; branch: string | null } | null = null;
  for (const line of stdout.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      current = { path: line.slice("worktree ".length), branch: null };
      entries.push(current);
    } else if (line.startsWith("branch ") && current !== null) {
      current.branch = line.slice("branch ".length);
    }
  }
  return entries;
}

/** A nested worktree shows in the parent's status as its collapsed directory entry. */
function isWorktreeStatusPath(path: string, relativeWorktree: string): boolean {
  return (
    path === relativeWorktree ||
    path === `${relativeWorktree}/` ||
    path.startsWith(`${relativeWorktree}/`)
  );
}

function deadLocalClaimIds(entries: ReadonlyArray<Record<string, unknown>>): ReadonlyArray<string> {
  const ids: Array<string> = [];
  for (const entry of entries) {
    if (entry["status"] !== "in_progress" || typeof entry["id"] !== "string") continue;
    const actor =
      typeof entry["assignee"] === "string"
        ? entry["assignee"]
        : typeof entry["claim_actor"] === "string"
          ? entry["claim_actor"]
          : "";
    const match = /^t3code-(?:runner-)?(\d+)$/.exec(actor);
    if (match === null) continue;
    const pid = Number(match[1]);
    try {
      process.kill(pid, 0);
    } catch {
      ids.push(entry["id"]);
    }
  }
  return ids;
}

export const layer = Layer.effect(
  EpicRunPreflight,
  Effect.gen(function* () {
    const processRunner = yield* ProcessRunner;
    const lock = yield* EpicRunLock;
    const configSource = yield* EpicRunConfigSource;

    const runBd = Effect.fn("EpicRunPreflight.runBd")(function* (
      cwd: string,
      args: ReadonlyArray<string>,
    ) {
      const result = yield* processRunner
        .run({ command: "bd", args, cwd, timeout: COMMAND_TIMEOUT })
        .pipe(
          Effect.mapError(
            (error) =>
              new EpicRunPreflightError({
                message: `bd ${args[0] ?? ""}: ${error.message}`,
              }),
          ),
        );
      return result;
    });

    const runGit = Effect.fn("EpicRunPreflight.runGit")(function* (
      cwd: string,
      args: ReadonlyArray<string>,
    ) {
      const result = yield* processRunner
        .run({ command: "git", args, cwd, timeout: COMMAND_TIMEOUT })
        .pipe(
          Effect.mapError(
            (error) =>
              new EpicRunPreflightError({ message: `git ${args[0] ?? ""}: ${error.message}` }),
          ),
        );
      if (result.code !== 0) {
        return yield* new EpicRunPreflightError({
          message: `git ${args[0] ?? ""}: ${result.stderr.trim() || `git exited ${String(result.code)}`}`,
        });
      }
      return result;
    });

    const check: EpicRunPreflightShape["check"] = Effect.fn("EpicRunPreflight.check")(
      function* (input, suppliedConfigSnapshot) {
        const blockers: Array<EpicRunPreflightResult["blockers"][number]> = [];
        const warnings: Array<EpicRunPreflightWarning> = [];

        // The run lock is observed BEFORE the ordinary preflight, mirroring
        // run-legacy.sh:510-519: a live sequential holder legitimately has a dirty
        // checkout, so a contender must report the held lock rather than fail
        // on the holder's dirtiness.
        const held = yield* lock
          .inspect({
            workspaceRoot: input.workspaceRoot,
            epicId: input.epicId,
          })
          .pipe(Effect.mapError((error) => new EpicRunPreflightError({ message: error.message })));
        if (
          held !== undefined &&
          typeof held.owner === "string" &&
          typeof held.runDir === "string" &&
          typeof held.host === "string" &&
          typeof held.pid === "number"
        ) {
          // The result stays total even on the early lock return: the launch
          // form prefills from these fields regardless of the blockers. The
          // check mode is not a launch override — resolve with `null` so the
          // returned config matches what a launch with no override would use.
          const lockSnapshot =
            suppliedConfigSnapshot ??
            makeEpicRunConfigSnapshot({
              fileResult: yield* configSource.read({ repoRoot: input.workspaceRoot }),
              override: null,
              harness: null,
            });
          return {
            ok: false,
            blockers: [
              {
                _tag: "run_in_progress",
                owner: held.owner,
                runDir: held.runDir,
                host: held.host,
                pid: held.pid,
              },
            ],
            warnings,
            resolvedConfig: lockSnapshot.config,
            configProvenance: lockSnapshot.provenance,
          };
        }

        const status = yield* runGit(input.workspaceRoot, [
          "status",
          "--porcelain=2",
          "--branch",
          "--untracked-files=all",
        ]);
        let detached = true;
        const trackedDirtyPaths = new Set<string>();
        const untrackedPaths = new Set<string>();
        for (const line of status.stdout.split(/\r?\n/)) {
          if (line.startsWith("# branch.head ")) {
            detached = line.slice("# branch.head ".length).trim().startsWith("(");
          } else if (line.length > 0 && !line.startsWith("#")) {
            const path = porcelainPath(line);
            if (path === null || isBeadsPath(path)) continue;
            if (line.startsWith("? ") || line.startsWith("! ")) {
              untrackedPaths.add(path);
            } else {
              trackedDirtyPaths.add(path);
            }
          }
        }
        if (detached) blockers.push({ _tag: "detached_head" });

        if (input.mode === "sequential") {
          // Sequential workers commit directly on the base branch in the main
          // checkout: any dirt — tracked or untracked — is fatal.
          const dirtyPaths = [...trackedDirtyPaths, ...untrackedPaths].toSorted();
          if (dirtyPaths.length > 0) {
            blockers.push({ _tag: "dirty_tree", paths: dirtyPaths });
          }
        } else {
          // Parallel workers commit in their own worktrees and the main
          // checkout is only ever fast-forwarded (run-legacy.sh:528-531): tracked
          // modifications still block, untracked files only warn, and a clean
          // registered nested worktree must not make the checkout look dirty
          // (run-legacy.sh registered_nested_worktree_dirty /
          // sequential_untracked_paths).
          const worktreeList = yield* runGit(input.workspaceRoot, [
            "worktree",
            "list",
            "--porcelain",
          ]);
          const worktrees = parseWorktreeList(worktreeList.stdout);
          const dirtyWorktrees: Array<string> = [];
          for (const worktree of worktrees) {
            if (!worktree.path.startsWith(`${input.workspaceRoot}/`)) continue;
            const relative = worktree.path.slice(input.workspaceRoot.length + 1);
            const reported = [...untrackedPaths].filter((path) =>
              isWorktreeStatusPath(path, relative),
            );
            if (reported.length === 0) continue;
            const nestedStatus = yield* processRunner
              .run({
                command: "git",
                args: ["status", "--porcelain", "--untracked-files=all", "--", ":(exclude).beads"],
                cwd: worktree.path,
                timeout: COMMAND_TIMEOUT,
              })
              .pipe(
                Effect.mapError(
                  (error) => new EpicRunPreflightError({ message: `git status: ${error.message}` }),
                ),
              );
            for (const path of reported) untrackedPaths.delete(path);
            // A dirty or unreadable registered nested worktree counts as dirt.
            if (nestedStatus.code !== 0 || nestedStatus.stdout.trim() !== "") {
              dirtyWorktrees.push(relative);
            }
          }
          const dirtyPaths = [...trackedDirtyPaths, ...dirtyWorktrees].toSorted();
          if (dirtyPaths.length > 0) {
            blockers.push({ _tag: "dirty_tree", paths: dirtyPaths });
          }
          if (untrackedPaths.size > 0) {
            warnings.push({ _tag: "untracked_files", paths: [...untrackedPaths].toSorted() });
          }

          // A leftover integration branch or worktree from a crashed parallel
          // run must be reconciled, not silently reused (run-legacy.sh:873-881).
          const branchList = yield* runGit(input.workspaceRoot, [
            "branch",
            "--list",
            "--format=%(refname:short)",
            `${INTEGRATION_BRANCH_PREFIX}*`,
          ]);
          const leftoverBranch =
            branchList.stdout
              .split(/\r?\n/)
              .map((line) => line.trim())
              .find((line) => line.length > 0) ?? null;
          const leftoverWorktree =
            worktrees.find((worktree) =>
              worktree.branch?.startsWith(`refs/heads/${INTEGRATION_BRANCH_PREFIX}`),
            )?.path ?? null;
          if (leftoverBranch !== null || leftoverWorktree !== null) {
            blockers.push({
              _tag: "integration_leftover",
              branch: leftoverBranch,
              worktreePath: leftoverWorktree,
            });
          }
        }

        // The check mode is not a launch override: resolve with `null` so the
        // returned config and provenance match what a launch with no override
        // would use. The mode still drives the dirtiness rules above directly.
        const configSnapshot =
          suppliedConfigSnapshot ??
          makeEpicRunConfigSnapshot({
            fileResult: yield* configSource.read({ repoRoot: input.workspaceRoot }),
            override: null,
            harness: null,
          });
        const configFile = configSnapshot.fileResult;
        if (configFile._tag === "invalid") {
          blockers.push({
            _tag: "config_invalid",
            configPath: configFile.configPath,
            diagnostics: configFile.diagnostics,
          });
        } else {
          if (configFile._tag === "loaded" && configFile.unknownKeys.length > 0) {
            warnings.push({
              _tag: "config_unknown_keys",
              configPath: configFile.configPath,
              keys: configFile.unknownKeys,
            });
          }
          for (const violation of configSnapshot.violations) {
            if (violation.key === "gate.command") {
              blockers.push({
                _tag: "config_invalid",
                configPath:
                  configFile._tag === "loaded"
                    ? configFile.configPath
                    : `${input.workspaceRoot}/.t3code/epic-run.json`,
                diagnostics: [violation.message],
              });
            } else {
              warnings.push({ _tag: "config_violation", ...violation });
            }
          }
        }

        // Sibling repositories are validated only when configured; the
        // single-repo path issues no extra git invocations
        // (skills/cook-epic/run-legacy.sh:240-282).
        const siblingEntries = configSnapshot.config.parallel.siblings;
        if (siblingEntries.length > 0) {
          const resolved = yield* Effect.result(
            makeSiblingResolver(processRunner.run).resolveSiblings({
              cwd: input.workspaceRoot,
              siblings: siblingEntries,
              pushEnabled: !configSnapshot.config.vcs.noPush,
              layoutMode: input.mode === "parallel",
            }),
          );
          if (resolved._tag === "Failure") {
            blockers.push({
              _tag: "sibling_invalid",
              path: resolved.failure.path,
              detail: resolved.failure.detail,
            });
          }
        }

        const shown = yield* runBd(input.workspaceRoot, ["show", input.epicId, "--json"]);
        if (shown.code !== 0 || parseArray(shown.stdout)?.length !== 1) {
          blockers.push({ _tag: "epic_not_found", epicId: input.epicId });
        } else {
          const ready = yield* runBd(input.workspaceRoot, [
            "ready",
            "--parent",
            input.epicId,
            "--json",
          ]);
          const readyEntries = ready.code === 0 ? parseArray(ready.stdout) : null;
          if (readyEntries === null) {
            return yield* new EpicRunPreflightError({
              message: `bd ready: ${ready.stderr.trim() || "bd returned invalid JSON"}`,
            });
          }
          if (readyEntries.length === 0) {
            warnings.push({ _tag: "nothing_ready", epicId: input.epicId });
          }

          const children = yield* runBd(input.workspaceRoot, [
            "list",
            "--parent",
            input.epicId,
            "--json",
          ]);
          const childEntries = children.code === 0 ? parseArray(children.stdout) : null;
          if (childEntries === null) {
            return yield* new EpicRunPreflightError({
              message: `bd list: ${children.stderr.trim() || "bd returned invalid JSON"}`,
            });
          }
          const childIds = deadLocalClaimIds(childEntries);
          if (childIds.length > 0) warnings.push({ _tag: "stale_claims", childIds });
        }

        return {
          ok: blockers.length === 0,
          blockers,
          warnings,
          resolvedConfig: configSnapshot.config,
          configProvenance: configSnapshot.provenance,
        };
      },
    );

    return EpicRunPreflight.of({ check });
  }),
);
