// @effect-diagnostics nodeBuiltinImport:off
/**
 * The terminal pool workspace adapter: worktree lifecycle for pool iterations
 * and the integration branch, over the `git` CLI and the node filesystem.
 *
 * A semantic port of the server's `makeServerPoolWorkspace`
 * (`EpicRunnerPoolPorts.ts`) with the same branch and path conventions: the
 * integration worktree at `<worktreesRoot>/integration` on
 * `cook-epic-integration-<runId>`, one worker worktree per iteration at
 * `<worktreesRoot>/<issueId>` on `epic/<issueId>`, and sibling layouts under
 * `<worktreesRoot>/layouts/<issueId>` mirroring each sibling's real relative
 * position. The merge state the drain consults lives in the file-backed
 * merge-queue store beside it.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { EpicRunnerDispatchError, EpicRunnerStoreError } from "../Errors.ts";
import type {
  IterationWorkspace,
  PoolRunContext,
  SiblingWorktree,
  WorkspaceShape,
} from "../ports/Workspace.ts";
import type { PersistedEpicRun, RunJournalShape } from "../ports/RunJournal.ts";
import {
  integrationBranch as integrationBranchName,
  parseIntegrationFixTitle,
  parseMergeFixTitle,
  runBaseBranch as runBaseBranchName,
} from "../policy.ts";
import type * as ProcessRunner from "../processRunner.ts";
import { resolveRunBaseBranch } from "../runBaseBranch.ts";
import {
  makeSiblingResolver,
  mirrorPath,
  siblingRuleLayout,
  siblingRuleSequential,
  type SiblingRef,
} from "../siblings.ts";
import { linkNodeModulesTree } from "./worktreeNodeModules.ts";
import type { FileMergeQueueStoreShape } from "./FileMergeQueueStore.ts";

/** The env files `setup_worktree_assets` copies (never production/staging). */
const WORKTREE_ASSET_ENV_FILES = [
  ".env",
  ".env.local",
  ".env.development",
  ".env.development.local",
  ".env.test",
] as const;

const detail = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

const isEpicRunnerDispatchError = Schema.is(EpicRunnerDispatchError);

const dispatchError = (commandType: string) => (cause: unknown) =>
  isEpicRunnerDispatchError(cause)
    ? cause
    : new EpicRunnerDispatchError({ commandType, detail: detail(cause), cause });

const storeError = (operation: string) => (cause: unknown) =>
  new EpicRunnerStoreError({ operation, cause });

const pathExists = async (target: string): Promise<boolean> =>
  NodeFSP.access(target).then(
    () => true,
    () => false,
  );

export const makeTerminalPoolWorkspace = (deps: {
  readonly processRunner: ProcessRunner.ProcessRunner["Service"];
  readonly journal: RunJournalShape;
  readonly mergeQueueStore: FileMergeQueueStoreShape;
  /** The run-scoped root every worktree and layout lives under. */
  readonly worktreesRoot: string;
}): WorkspaceShape => {
  const { processRunner, journal, mergeQueueStore, worktreesRoot } = deps;

  /** The run-scoped root every worker layout lives under. */
  const layoutRoot = () => NodePath.join(worktreesRoot, "layouts");

  const git = (input: {
    readonly operation: string;
    readonly cwd: string;
    readonly args: ReadonlyArray<string>;
  }) =>
    processRunner
      .run({ command: "git", args: input.args, cwd: input.cwd })
      .pipe(Effect.mapError(dispatchError(input.operation)));

  const gitRequired = (input: {
    readonly operation: string;
    readonly cwd: string;
    readonly args: ReadonlyArray<string>;
  }) =>
    git(input).pipe(
      Effect.flatMap((output) =>
        output.code === 0
          ? Effect.succeed(output.stdout)
          : Effect.fail(
              new EpicRunnerDispatchError({
                commandType: input.operation,
                detail: output.stderr.trim() || `git exited with code ${String(output.code)}`,
              }),
            ),
      ),
    );

  const readCurrentBranch = (cwd: string) =>
    git({ operation: "git.current-branch", cwd, args: ["symbolic-ref", "--short", "HEAD"] }).pipe(
      Effect.flatMap((output) => {
        const branch = output.stdout.trim();
        return output.code === 0 && branch.length > 0
          ? Effect.succeed(branch)
          : Effect.fail(
              new EpicRunnerDispatchError({
                commandType: "git.current-branch",
                detail: output.stderr.trim() || "Could not resolve the epic base branch",
              }),
            );
      }),
    );

  /**
   * The repo's `HEAD` (or `ref`, when given), or `null` when it cannot be
   * read. Pass `ref` to resolve a branch that is not checked out at `cwd` —
   * a run-owned base branch (t3code-5m4).
   */
  const headCommit = (cwd: string, ref?: string) =>
    git({ operation: "git.head", cwd, args: ["rev-parse", "--verify", "-q", ref ?? "HEAD"] }).pipe(
      Effect.map((output) => {
        const sha = output.stdout.trim();
        return output.code === 0 && sha.length > 0 ? sha : null;
      }),
    );

  const branchExists = (cwd: string, branch: string) =>
    git({
      operation: "git.branch-exists",
      cwd,
      args: ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
    }).pipe(Effect.map((output) => output.code === 0));

  /**
   * The base branch a parallel run's worktrees start from: the operator's
   * checked-out branch, or the run's own `epic/<epicId>/base`, created
   * idempotently on first use and reused verbatim after (t3code-5m4).
   */
  const resolveBaseBranch = (run: PersistedEpicRun) =>
    resolveRunBaseBranch(
      {
        currentBranch: readCurrentBranch,
        branchExists,
        createBranch: (cwd, branch, startPoint) =>
          gitRequired({
            operation: "git.run-base-branch-create",
            cwd,
            args: ["branch", branch, startPoint],
          }).pipe(Effect.asVoid),
      },
      { cwd: run.cwd, epicId: run.epicId, runOwnedBaseBranch: run.config.vcs.runOwnedBaseBranch },
    );

  /**
   * The server WorktreeProvisioner's branch rule: an existing branch is
   * checked out (a merge-fix child's parked branch, a retried layout), a new
   * one is created from the base.
   */
  const worktreeAdd = (input: {
    readonly operation: string;
    readonly repoCwd: string;
    readonly branch: string;
    readonly baseBranch: string;
    readonly target: string;
  }) =>
    Effect.gen(function* () {
      const reuse = yield* branchExists(input.repoCwd, input.branch);
      yield* gitRequired({
        operation: input.operation,
        cwd: input.repoCwd,
        args: reuse
          ? ["worktree", "add", input.target, input.branch]
          : ["worktree", "add", "-b", input.branch, input.target, input.baseBranch],
      });
    });

  const worktreeRemove = (input: {
    readonly operation: string;
    readonly repoCwd: string;
    readonly target: string;
  }) =>
    gitRequired({
      operation: input.operation,
      cwd: input.repoCwd,
      args: ["worktree", "remove", "--force", input.target],
    }).pipe(Effect.asVoid);

  const worktreeRemoveBestEffort = (label: string, repoCwd: string, target: string) =>
    worktreeRemove({ operation: label, repoCwd, target }).pipe(
      Effect.catchCause((cause) => Effect.logWarning(label, { repoCwd, target, cause })),
    );

  const deleteBranch = (input: {
    readonly operation: string;
    readonly repoCwd: string;
    readonly branch: string;
  }) =>
    gitRequired({
      operation: input.operation,
      cwd: input.repoCwd,
      args: ["branch", "-D", input.branch],
    }).pipe(Effect.asVoid);

  const deleteBranchBestEffort = (label: string, repoCwd: string, branch: string) =>
    deleteBranch({ operation: label, repoCwd, branch }).pipe(
      Effect.catchCause((cause) => Effect.logWarning(label, { repoCwd, branch, cause })),
    );

  const resolveBeadsDirectory = async (cwd: string): Promise<string> => {
    const beadsDirectory = NodePath.join(cwd, ".beads");
    const canonicalBeads = await NodeFSP.realpath(beadsDirectory).catch(() => beadsDirectory);
    const redirect = await NodeFSP.readFile(NodePath.join(canonicalBeads, "redirect"), "utf8").then(
      (contents) => contents.trim(),
      () => "",
    );
    const target =
      redirect.length === 0
        ? canonicalBeads
        : NodePath.isAbsolute(redirect)
          ? redirect
          : NodePath.resolve(cwd, redirect);
    return NodeFSP.realpath(target).catch(() => target);
  };

  const writeBeadsRedirect = Effect.fn("TerminalPoolWorkspace.writeBeadsRedirect")(function* (
    runCwd: string,
    worktreeCwd: string,
  ) {
    yield* Effect.tryPromise({
      try: async () => {
        const targetBeads = await resolveBeadsDirectory(runCwd);
        const worktreeBeads = NodePath.join(worktreeCwd, ".beads");
        await NodeFSP.mkdir(worktreeBeads, { recursive: true });
        await NodeFSP.writeFile(
          NodePath.join(worktreeBeads, "redirect"),
          NodePath.relative(worktreeCwd, targetBeads),
        );
      },
      catch: (cause) =>
        new EpicRunnerDispatchError({
          commandType: "beads.redirect-write",
          detail: `Could not write the beads redirect in ${worktreeCwd}: ${detail(cause)}`,
          cause,
        }),
    });
  });

  /**
   * `setup_worktree_assets` (`skills/cook-epic/run-legacy.sh:998-1011`): a
   * `node_modules` symlink from the source repo plus copies of the whitelisted
   * env files, each only when absent in the worktree.
   */
  const setupWorktreeAssets = Effect.fn("TerminalPoolWorkspace.setupWorktreeAssets")(function* (
    operation: string,
    sourceRepo: string,
    target: string,
  ) {
    yield* Effect.tryPromise({
      try: async () => {
        await linkNodeModulesTree(sourceRepo, target);
        for (const name of WORKTREE_ASSET_ENV_FILES) {
          const source = NodePath.join(sourceRepo, name);
          const targetFile = NodePath.join(target, name);
          if ((await pathExists(source)) && !(await pathExists(targetFile))) {
            await NodeFSP.copyFile(source, targetFile);
          }
        }
      },
      catch: (cause) =>
        new EpicRunnerDispatchError({
          commandType: operation,
          detail: `Could not set up assets in ${target}: ${detail(cause)}`,
          cause,
        }),
    });
  });

  const requireRun = (runId: PoolRunContext["runId"]) =>
    journal.getRun(runId).pipe(
      Effect.mapError(storeError("getRun")),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new EpicRunnerStoreError({ operation: `workspace run not found: ${runId}` }),
            ),
          onSome: Effect.succeed,
        }),
      ),
    );

  /**
   * Sibling repositories resolved once per run
   * (`skills/cook-epic/run-legacy.sh:240-282`).
   */
  const resolvedSiblings = new Map<string, ReadonlyArray<SiblingRef>>();
  const runSiblings = Effect.fn("TerminalPoolWorkspace.runSiblings")(function* (
    runId: PoolRunContext["runId"],
    cwd: string,
    siblings: ReadonlyArray<string>,
    pushEnabled: boolean,
    layoutMode: boolean,
  ) {
    const cached = resolvedSiblings.get(runId);
    if (cached !== undefined) return cached;
    if (siblings.length === 0) return [] as ReadonlyArray<SiblingRef>;
    const resolved = yield* makeSiblingResolver(processRunner.run)
      .resolveSiblings({ cwd, siblings, pushEnabled, layoutMode })
      .pipe(
        Effect.mapError(
          (error) =>
            new EpicRunnerDispatchError({
              commandType: "git.sibling-resolution",
              detail: error.detail,
              cause: error,
            }),
        ),
      );
    resolvedSiblings.set(runId, resolved);
    return resolved;
  });

  const ensureIntegration: WorkspaceShape["ensureIntegration"] = (runCtx) =>
    Effect.gen(function* () {
      const run = yield* requireRun(runCtx.runId);
      if (run.config.execution.sequential) return null;
      if (yield* mergeQueueStore.exists(run.runId).pipe(Effect.mapError(storeError("exists")))) {
        const persisted = yield* mergeQueueStore
          .read(run.runId)
          .pipe(Effect.mapError(storeError("read")));
        return { entries: persisted.entries.map((entry) => ({ status: entry.status })) };
      }

      const baseBranch = yield* resolveBaseBranch(run);
      // The operator's branch at launch (t3code-sha), captured once and
      // persisted verbatim below — never re-read from the working tree at
      // drain time, so an operator who switches branches mid-run cannot
      // silently change what a later drain integrates.
      //
      // `readCurrentBranch` fails on a detached `HEAD` (`git symbolic-ref`
      // has nothing to report). That is a legitimate state to launch from —
      // a resumed epic whose run base branch already exists, for one — and
      // must not turn into a provisioning failure just because the operator
      // has no branch to integrate from. `null` here means the same thing it
      // means for a snapshot that predates this field: no continuous
      // integration for this run. Mirrors the server twin
      // (`EpicRunnerPoolPorts.ts`).
      const operatorBaseBranch = run.config.vcs.runOwnedBaseBranch
        ? yield* readCurrentBranch(run.cwd).pipe(
            Effect.catch((error) =>
              Effect.logWarning("epic.runner.operator-base-branch-unresolved", {
                runId: run.runId,
                cwd: run.cwd,
                detail: error.detail,
              }).pipe(Effect.as(null)),
            ),
          )
        : null;
      // A run-owned base branch (t3code-5m4) is never checked out at
      // `run.cwd`, so seeding from `HEAD` there would read the operator's
      // branch instead — reused verbatim by every later resume and fatal on
      // the first drain once the two disagree. Read the resolved base branch
      // itself so this agrees with what MergeQueue lands against.
      const lastAcceptedHead = yield* headCommit(
        run.cwd,
        run.config.vcs.runOwnedBaseBranch ? baseBranch : undefined,
      );
      if (lastAcceptedHead === null) {
        return yield* new EpicRunnerDispatchError({
          commandType: "git.integration-worktree",
          detail: `Could not resolve HEAD before creating the integration worktree for ${run.runId}`,
        });
      }
      const branch = integrationBranchName(run.runId);
      const targetPath = NodePath.join(worktreesRoot, "integration");
      if (yield* branchExists(run.cwd, branch)) {
        return yield* new EpicRunnerDispatchError({
          commandType: "git.integration-worktree",
          detail: `Refusing to reuse existing integration branch ${branch}; reconcile it first`,
        });
      }
      if (yield* Effect.promise(() => pathExists(targetPath))) {
        return yield* new EpicRunnerDispatchError({
          commandType: "git.integration-worktree",
          detail: `Refusing to provision over existing integration worktree ${targetPath}; reconcile it first`,
        });
      }
      const siblings = yield* runSiblings(
        run.runId,
        run.cwd,
        run.config.parallel.siblings,
        !run.config.vcs.noPush,
        true,
      );
      const provisioned: Array<{ readonly repo: string; readonly target: string }> = [];
      return yield* Effect.gen(function* () {
        yield* worktreeAdd({
          operation: "git.integration-worktree-provision",
          repoCwd: run.cwd,
          branch,
          baseBranch,
          target: targetPath,
        });
        provisioned.push({ repo: run.cwd, target: targetPath });
        yield* writeBeadsRedirect(run.cwd, targetPath);
        // One integration worktree per sibling, mirrored beside the main one
        // (`skills/cook-epic/run-legacy.sh:1055-1069`).
        const siblingStates: Array<{
          readonly repositoryPath: string;
          readonly baseBranch: string;
          readonly integrationWorktreePath: string;
          readonly lastAcceptedHead: string;
        }> = [];
        for (const sibling of siblings) {
          if (yield* branchExists(sibling.canonicalPath, branch)) {
            return yield* new EpicRunnerDispatchError({
              commandType: "git.sibling-integration-worktree",
              detail: `Refusing to reuse existing integration branch ${branch} in sibling ${sibling.canonicalPath}; reconcile it first`,
            });
          }
          const target = mirrorPath(
            NodePath.dirname(targetPath),
            NodePath.basename(targetPath),
            sibling.relativePath,
          );
          yield* worktreeAdd({
            operation: "git.sibling-integration-worktree-provision",
            repoCwd: sibling.canonicalPath,
            branch,
            baseBranch: sibling.baseBranch,
            target,
          });
          provisioned.push({ repo: sibling.canonicalPath, target });
          // Sibling integration worktrees get assets only — siblings have no
          // beads database (`skills/cook-epic/run-legacy.sh:1008-1009`).
          yield* setupWorktreeAssets(
            "git.sibling-integration-assets",
            sibling.canonicalPath,
            target,
          );
          const siblingHead = yield* headCommit(sibling.canonicalPath);
          if (siblingHead === null) {
            return yield* new EpicRunnerDispatchError({
              commandType: "git.sibling-integration-worktree",
              detail: `Could not resolve HEAD of sibling ${sibling.canonicalPath} while creating its integration worktree`,
            });
          }
          siblingStates.push({
            repositoryPath: sibling.canonicalPath,
            baseBranch: sibling.baseBranch,
            integrationWorktreePath: target,
            lastAcceptedHead: siblingHead,
          });
        }
        yield* mergeQueueStore
          .initialize({
            runId: run.runId,
            lastAcceptedHead,
            repositoryPath: run.cwd,
            baseBranch,
            integrationBranch: branch,
            integrationWorktreePath: targetPath,
            operatorBaseBranch,
            siblings: siblingStates,
            entries: [],
          })
          .pipe(Effect.mapError(storeError("initialize")));
        return { entries: [] } as const;
      }).pipe(
        Effect.catchCause((cause) =>
          // Roll back the whole set: worktrees first, then their branches.
          Effect.forEach(
            provisioned.toReversed(),
            (entry) =>
              worktreeRemoveBestEffort("git.integration-rollback", entry.repo, entry.target),
            { discard: true },
          ).pipe(
            Effect.andThen(
              Effect.forEach(
                provisioned.toReversed(),
                (entry) => deleteBranchBestEffort("git.integration-rollback", entry.repo, branch),
                { discard: true },
              ),
            ),
            Effect.andThen(Effect.failCause(cause)),
          ),
        ),
      );
    });

  const acquire: WorkspaceShape["acquire"] = (runCtx, input) =>
    Effect.gen(function* () {
      const run = yield* requireRun(runCtx.runId);
      if (input.sequential) {
        // Sequential mode works in the real sibling checkouts — no worktrees,
        // no mirrored paths (`skills/cook-epic/run-legacy.sh:737-739`).
        const siblings = yield* runSiblings(
          run.runId,
          run.cwd,
          run.config.parallel.siblings,
          !run.config.vcs.noPush,
          false,
        );
        return {
          cwd: run.cwd,
          branch: null,
          worktreePath: null,
          siblingWorktrees: siblings.map((sibling) => ({
            worktreePath: sibling.canonicalPath,
            sourcePath: sibling.canonicalPath,
            baseBranch: sibling.baseBranch,
          })),
          siblingRule: siblings.length === 0 ? null : siblingRuleSequential({ siblings }),
        } satisfies IterationWorkspace;
      }

      const mergeFix = parseMergeFixTitle(input.issueTitle);
      // An integration-fix child (t3code-sha) is dispatched directly onto
      // the run's own base branch — the same reused-branch pattern a
      // per-entry merge-fix child gets — so committing there IS landing the
      // resolution; there is no separate branch for the queue to land.
      const integrationFix = parseIntegrationFixTitle(input.issueTitle);
      const branch =
        mergeFix?.branch ??
        (integrationFix !== null ? runBaseBranchName(run.epicId) : `epic/${input.issueId}`);
      if (mergeFix !== null) {
        const original = yield* mergeQueueStore
          .parkedOriginalChild(run.runId, branch)
          .pipe(Effect.mapError(storeError("parkedOriginalChild")));
        if (Option.isNone(original)) {
          return yield* new EpicRunnerDispatchError({
            commandType: "git.merge-fix-worktree",
            detail: `Merge-fix child ${input.issueId} refers to unparked branch ${branch}`,
          });
        }
      }
      const baseBranch = yield* resolveBaseBranch(run);
      const siblings = yield* runSiblings(
        run.runId,
        run.cwd,
        run.config.parallel.siblings,
        !run.config.vcs.noPush,
        true,
      );
      if (siblings.length > 0) {
        // Layout mode: the worker sandbox is a run-scoped layout root outside
        // both repos, reproducing the siblings' real relative positions so
        // references like `../sibling` resolve inside it
        // (`skills/cook-epic/run-legacy.sh:1919-1953`).
        const canonicalCwd = yield* Effect.tryPromise({
          try: () => NodeFSP.realpath(run.cwd),
          catch: dispatchError("git.layout-provision"),
        }).pipe(Effect.orElseSucceed(() => run.cwd));
        const repoBasename = NodePath.basename(canonicalCwd);
        const root = layoutRoot();
        const layout = NodePath.join(root, input.issueId);
        if (yield* Effect.promise(() => pathExists(layout))) {
          return yield* new EpicRunnerDispatchError({
            commandType: "git.layout-provision",
            detail: `Refusing to provision over existing layout ${layout}; reconcile it first`,
          });
        }
        const created: Array<{ readonly repo: string; readonly target: string }> = [];
        const mainTarget = NodePath.join(layout, repoBasename);
        return yield* Effect.gen(function* () {
          yield* worktreeAdd({
            operation: "git.layout-worktree-provision",
            repoCwd: run.cwd,
            branch,
            baseBranch,
            target: mainTarget,
          });
          created.push({ repo: run.cwd, target: mainTarget });
          yield* writeBeadsRedirect(run.cwd, mainTarget);
          const siblingWorktrees: Array<SiblingWorktree> = [];
          for (const sibling of siblings) {
            const target = mirrorPath(layout, repoBasename, sibling.relativePath);
            yield* worktreeAdd({
              operation: "git.layout-worktree-provision",
              repoCwd: sibling.canonicalPath,
              branch,
              baseBranch: sibling.baseBranch,
              target,
            });
            created.push({ repo: sibling.canonicalPath, target });
            // Sibling worktrees get assets only
            // (`skills/cook-epic/run-legacy.sh:1008-1009`).
            yield* setupWorktreeAssets("git.layout-worktree-assets", sibling.canonicalPath, target);
            siblingWorktrees.push({
              worktreePath: target,
              sourcePath: sibling.canonicalPath,
              baseBranch: sibling.baseBranch,
            });
          }
          return {
            cwd: mainTarget,
            branch,
            worktreePath: mainTarget,
            siblingWorktrees,
            siblingRule: siblingRuleLayout({
              layoutRoot: root,
              layout,
              repoBasename,
              branch,
              siblings,
            }),
          } satisfies IterationWorkspace;
        }).pipe(
          // A failed layout provision tears the partial layout down; branches
          // survive for retries.
          Effect.catchCause((cause) =>
            Effect.forEach(
              created.toReversed(),
              (entry) => worktreeRemoveBestEffort("git.layout-rollback", entry.repo, entry.target),
              { discard: true },
            ).pipe(
              Effect.andThen(
                Effect.tryPromise({
                  try: () => NodeFSP.rm(layout, { recursive: true, force: true }),
                  catch: dispatchError("git.layout-rollback"),
                }).pipe(
                  Effect.catchCause((removeCause) =>
                    Effect.logWarning("git.layout-rollback", { layout, cause: removeCause }),
                  ),
                ),
              ),
              Effect.andThen(Effect.failCause(cause)),
            ),
          ),
        );
      }

      const targetPath = NodePath.join(worktreesRoot, input.issueId);
      if (yield* Effect.promise(() => pathExists(targetPath))) {
        return yield* new EpicRunnerDispatchError({
          commandType: "git.worktree-provision",
          detail: `Refusing to provision over existing worktree ${targetPath}; reconcile it first`,
        });
      }
      return yield* Effect.gen(function* () {
        yield* worktreeAdd({
          operation: "git.worktree-provision",
          repoCwd: run.cwd,
          branch,
          baseBranch,
          target: targetPath,
        });
        yield* writeBeadsRedirect(run.cwd, targetPath);
        return {
          cwd: targetPath,
          branch,
          worktreePath: targetPath,
          siblingWorktrees: [],
          siblingRule: null,
        } satisfies IterationWorkspace;
      }).pipe(
        Effect.catchCause((cause) =>
          worktreeRemoveBestEffort("git.worker-rollback", run.cwd, targetPath).pipe(
            Effect.andThen(Effect.failCause(cause)),
          ),
        ),
      );
    });

  const release: WorkspaceShape["release"] = (runCtx, workspace) => {
    if (workspace.worktreePath === null) return Effect.void;
    const worktreePath = workspace.worktreePath;
    const root = layoutRoot();
    if (!worktreePath.startsWith(`${root}/`)) {
      // The single-repo path never fails; the adapter logs.
      return worktreeRemoveBestEffort(
        "epic.cook.worker-worktree-release-failed",
        runCtx.cwd,
        worktreePath,
      );
    }
    // A layout is one unit (`skills/cook-epic/run-legacy.sh:2309-2336`): every
    // sibling worktree, then the main worktree, then the layout dir. Branches
    // survive for retries; any failure is fatal to the run.
    const layout = NodePath.dirname(worktreePath);
    return Effect.gen(function* () {
      if (!layout.startsWith(`${root}/`)) {
        return yield* new EpicRunnerDispatchError({
          commandType: "git.layout-release",
          detail: `Refusing to remove ${layout}: not a layout under ${root}`,
        });
      }
      for (const sibling of workspace.siblingWorktrees) {
        const registered = yield* git({
          operation: "git.layout-release",
          cwd: sibling.sourcePath,
          args: ["worktree", "list", "--porcelain"],
        });
        if (
          registered.code !== 0 ||
          !registered.stdout.split(/\r?\n/).includes(`worktree ${sibling.worktreePath}`)
        ) {
          continue;
        }
        yield* worktreeRemove({
          operation: "git.layout-release",
          repoCwd: sibling.sourcePath,
          target: sibling.worktreePath,
        });
      }
      yield* worktreeRemove({
        operation: "git.layout-release",
        repoCwd: runCtx.cwd,
        target: worktreePath,
      });
      yield* Effect.tryPromise({
        try: () => NodeFSP.rm(layout, { recursive: true, force: true }),
        catch: (cause) =>
          new EpicRunnerDispatchError({
            commandType: "git.layout-release",
            detail: `Could not remove layout directory ${layout}: ${detail(cause)}`,
            cause,
          }),
      });
    });
  };

  const releaseIntegration: WorkspaceShape["releaseIntegration"] = (runCtx, outcome) =>
    Effect.gen(function* () {
      const run = yield* journal.getRun(runCtx.runId).pipe(
        Effect.map(Option.getOrNull),
        Effect.catchCause((cause) =>
          Effect.logWarning("epic.cook.integration-cleanup-run-read-failed", {
            runId: runCtx.runId,
            cause,
          }).pipe(Effect.as(null)),
        ),
      );
      if (run === null || run.config.execution.sequential) return;
      if (!(yield* mergeQueueStore.exists(run.runId).pipe(Effect.mapError(storeError("exists"))))) {
        return;
      }
      const state = yield* mergeQueueStore
        .read(run.runId)
        .pipe(Effect.mapError(storeError("read")));
      // Sibling integration worktrees and branches go first; the main
      // integration worktree last (`skills/cook-epic/run-legacy.sh:2309-2336`).
      for (const sibling of state.siblings) {
        yield* worktreeRemove({
          operation: "git.sibling-integration-worktree-release",
          repoCwd: sibling.repositoryPath,
          target: sibling.integrationWorktreePath,
        });
        yield* deleteBranch({
          operation: "git.sibling-integration-branch-delete",
          repoCwd: sibling.repositoryPath,
          branch: state.integrationBranch,
        });
      }
      yield* worktreeRemove({
        operation: "git.integration-worktree-release",
        repoCwd: state.repositoryPath,
        target: state.integrationWorktreePath,
      });
      yield* deleteBranch({
        operation: "git.integration-branch-delete",
        repoCwd: state.repositoryPath,
        branch: state.integrationBranch,
      });
      if (outcome !== "failed") {
        yield* mergeQueueStore.delete(run.runId).pipe(Effect.mapError(storeError("delete")));
      }
      // Best-effort: drop the run's worktree root once nothing is left in it.
      yield* Effect.tryPromise({
        try: () => NodeFSP.rmdir(worktreesRoot),
        catch: storeError("cleanup"),
      }).pipe(Effect.ignore);
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("epic.cook.integration-cleanup-failed", {
          runId: runCtx.runId,
          cause,
        }),
      ),
    );

  return { ensureIntegration, acquire, release, releaseIntegration };
};
