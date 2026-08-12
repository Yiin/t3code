import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import {
  DEFAULT_EPIC_RUN_CONFIG,
  DEFAULT_EPIC_RUN_CONFIG_PROVENANCE,
  EpicRunPreflightError,
  type EpicRunConfig,
  type EpicRunConfigOverride,
  type EpicRunConfigProvenance,
  type EpicRunPreflightBlocker,
  type EpicRunPreflightInput,
  type EpicRunPreflightIntent,
  type EpicRunPreflightMode,
  type EpicRunPreflightResult,
  type EpicRunPreflightWarning,
} from "@t3tools/contracts";
import { resolveEpicRunConfig, type EpicRunConfigViolation } from "@t3tools/shared/epicRunConfig";

import { EpicRunConfigSource, type EpicRunConfigFileResult } from "./EpicRunConfigSource.ts";
import { INTEGRATION_BRANCH_PREFIX, integrationBranch, runBaseBranch } from "./policy.ts";
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
    case "run_base_branch_checked_out":
      return boundedBlockerText(
        `${blocker.branch} is checked out here, and the run lands by updating that ref. Switch to another branch before launching.`,
      );
    case "workspace_missing":
      return boundedBlockerText(`The workspace ${blocker.workspaceRoot} does not exist.`);
  }
}

/**
 * How the checkout rules read for one (mode, intent) pair.
 *
 * Every intent-dependent decision belongs here rather than inline, so a later
 * intent — `fork` — has one obvious place to answer for itself.
 */
interface EpicRunPreflightPolicy {
  /**
   * How dirt in the checkout the run commits into is reported.
   *
   * A resumed sequential run's own uncommitted work sits in the base checkout,
   * so blocking on it would refuse the run permission to continue itself; it is
   * recorded as a warning instead. Parallel workers only ever commit in their
   * own worktrees and the base checkout is only fast-forwarded, so base dirt is
   * never a resumed parallel run's own work and the launch rule stands.
   */
  readonly baseTreeDirt: "blocker" | "accepted";
}

function blockerPolicy(input: {
  readonly mode: EpicRunPreflightMode;
  readonly intent: EpicRunPreflightIntent;
}): EpicRunPreflightPolicy {
  return {
    baseTreeDirt: input.mode === "sequential" && input.intent === "resume" ? "accepted" : "blocker",
  };
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
    const fileSystem = yield* FileSystem.FileSystem;

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
        const policy = blockerPolicy({ mode: input.mode, intent: input.intent ?? "launch" });

        // Probed before any subprocess: git, bd and the lock all take the
        // workspace root as their cwd, and a cwd that is not there fails each
        // of them with its own untyped spawn error. One probe turns that into
        // a blocker naming the path.
        const workspaceExists = yield* fileSystem.exists(input.workspaceRoot).pipe(Effect.exit);
        if (Exit.isFailure(workspaceExists) || !workspaceExists.value) {
          return {
            ok: false,
            blockers: [{ _tag: "workspace_missing", workspaceRoot: input.workspaceRoot }],
            warnings,
            resolvedConfig: suppliedConfigSnapshot?.config ?? DEFAULT_EPIC_RUN_CONFIG,
            configProvenance:
              suppliedConfigSnapshot?.provenance ?? DEFAULT_EPIC_RUN_CONFIG_PROVENANCE,
          };
        }

        // Resolved before the rest of the check, including the git status parse:
        // the parallel dirty-tree rule reads `vcs.runOwnedBaseBranch` off it
        // (t3code-5m4), and the lock branch and the final return both need it
        // too. The check mode is not a launch override — resolve with `null`
        // so the returned config and provenance match what a launch with no
        // override would use.
        const configSnapshot =
          suppliedConfigSnapshot ??
          makeEpicRunConfigSnapshot({
            fileResult: yield* configSource.read({ repoRoot: input.workspaceRoot }),
            override: null,
            harness: null,
          });

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
          // form prefills from these fields regardless of the blockers.
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
            resolvedConfig: configSnapshot.config,
            configProvenance: configSnapshot.provenance,
          };
        }

        const status = yield* runGit(input.workspaceRoot, [
          "status",
          "--porcelain=2",
          "--branch",
          "--untracked-files=all",
        ]);
        let detached = true;
        let currentBranchName: string | null = null;
        const trackedDirtyPaths = new Set<string>();
        const untrackedPaths = new Set<string>();
        for (const line of status.stdout.split(/\r?\n/)) {
          if (line.startsWith("# branch.head ")) {
            const head = line.slice("# branch.head ".length).trim();
            detached = head.startsWith("(");
            currentBranchName = detached ? null : head;
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
            if (policy.baseTreeDirt === "blocker") {
              blockers.push({ _tag: "dirty_tree", paths: dirtyPaths });
            } else {
              warnings.push({ _tag: "dirty_tree_accepted", paths: dirtyPaths });
            }
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
          // With a run-owned base branch (t3code-5m4) the operator's own
          // tracked modifications no longer block: nothing in the run ever
          // fast-forwards the operator's checkout. A dirty registered nested
          // worktree still blocks regardless — that is crash residue from a
          // previous run, not the operator's own edits.
          const dirtyPaths = [
            ...(configSnapshot.config.vcs.runOwnedBaseBranch ? [] : trackedDirtyPaths),
            ...dirtyWorktrees,
          ].toSorted();
          if (dirtyPaths.length > 0) {
            if (policy.baseTreeDirt === "blocker") {
              blockers.push({ _tag: "dirty_tree", paths: dirtyPaths });
            } else {
              warnings.push({ _tag: "dirty_tree_accepted", paths: dirtyPaths });
            }
          }
          // Dropping the blocker must not drop the signal: the run cooks
          // against committed code, so the operator should know their
          // uncommitted work is not in it.
          if (configSnapshot.config.vcs.runOwnedBaseBranch && trackedDirtyPaths.size > 0) {
            warnings.push({
              _tag: "tracked_changes_ignored",
              paths: [...trackedDirtyPaths].toSorted(),
            });
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
          // A resuming run still owns its own integration branch and worktree;
          // they are not leftovers to reconcile, they are where it left off.
          // Treating them as leftovers refused a crashed run permission to
          // continue itself, naming its own run id back at the operator.
          const ownIntegrationBranch =
            input.resumingRunId === undefined ? null : integrationBranch(input.resumingRunId);
          const isOwn = (value: string): boolean =>
            ownIntegrationBranch !== null && value === ownIntegrationBranch;
          const leftoverBranch =
            branchList.stdout
              .split(/\r?\n/)
              .map((line) => line.trim())
              .find((line) => line.length > 0 && !isOwn(line)) ?? null;
          const leftoverWorktree =
            worktrees.find(
              (worktree) =>
                worktree.branch?.startsWith(`refs/heads/${INTEGRATION_BRANCH_PREFIX}`) === true &&
                !isOwn(worktree.branch.slice("refs/heads/".length)),
            )?.path ?? null;
          if (leftoverBranch !== null || leftoverWorktree !== null) {
            blockers.push({
              _tag: "integration_leftover",
              branch: leftoverBranch,
              worktreePath: leftoverWorktree,
            });
          }

          // The run-owned base branch (t3code-5m4) is deliberately reused
          // across separate runs of the same epic, so it has no end-of-run
          // deletion — but that means it can silently seed fresh workers from
          // code weeks stale if nobody ever lands into it again. Warn rather
          // than block: reuse is the intended behaviour, staleness is just
          // worth the operator's attention.
          if (configSnapshot.config.vcs.runOwnedBaseBranch && currentBranchName !== null) {
            const ownedBranch = runBaseBranch(input.epicId);
            // Landing updates this ref with `git fetch . <ref>:<branch>`, and
            // git refuses to fetch into a branch checked out anywhere. Catch it
            // here: otherwise the run starts, workers finish whole children,
            // and every drain fails afterwards. This slice never merges the
            // run branch back, so the operator has a real reason to check it
            // out by hand, which makes the case reachable rather than exotic.
            if (currentBranchName === ownedBranch) {
              blockers.push({ _tag: "run_base_branch_checked_out", branch: ownedBranch });
            }
            const ownedBranchCheck = yield* processRunner
              .run({
                command: "git",
                args: ["show-ref", "--verify", "--quiet", `refs/heads/${ownedBranch}`],
                cwd: input.workspaceRoot,
                timeout: COMMAND_TIMEOUT,
              })
              .pipe(
                Effect.mapError(
                  (error) =>
                    new EpicRunPreflightError({ message: `git show-ref: ${error.message}` }),
                ),
              );
            if (ownedBranchCheck.code === 0) {
              const behindCount = yield* runGit(input.workspaceRoot, [
                "rev-list",
                "--count",
                `${ownedBranch}..${currentBranchName}`,
              ]);
              const commitsBehind = Number.parseInt(behindCount.stdout.trim(), 10);
              if (Number.isFinite(commitsBehind) && commitsBehind > 0) {
                warnings.push({
                  _tag: "run_base_branch_stale",
                  epicId: input.epicId,
                  branch: ownedBranch,
                  commitsBehind,
                });
              }
            }
          }
        }

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
