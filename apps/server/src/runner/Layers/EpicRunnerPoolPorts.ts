/**
 * EpicRunnerPoolPorts - Server adapters for the shared parallel epic loop.
 *
 * Every port the core `runParallelEpicLoop` (`@t3tools/epic-core/ParallelEpicLoop`)
 * consumes is bound here to the server's machinery: the orchestration engine
 * command path, the projection snapshot query, the durable run store, the `bd`
 * and `git` subprocess probes, and the worktree provisioner. The loop owns
 * policy; this module owns effects. Behaviour is ported verbatim from the
 * pre-extraction runner so the WS/HTTP surface, the persisted rows, and the
 * dispatch ordering do not change.
 *
 * @module EpicRunnerPoolPorts
 */
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  type EpicRun as TransportEpicRun,
  type ThreadId,
} from "@t3tools/contracts";
import {
  EpicRunnerDispatchError,
  EpicRunnerStoreError,
  EpicRunNotFoundError,
} from "@t3tools/epic-core/Errors";
import type * as ProcessRunner from "@t3tools/epic-core/processRunner";
import { resolveRunBaseBranch } from "@t3tools/epic-core/runBaseBranch";
import type {
  MergeDrainShape,
  PoolBacklogShape,
  PoolRunEventsShape,
  PoolRunJournalShape,
  PoolTimings,
} from "@t3tools/epic-core/ParallelEpicLoop";
import type { PoolDispatchShape } from "@t3tools/epic-core/ports/PoolDispatch";
import {
  DispatchError,
  type FinalMessageRead,
  type IterationHandle,
  type IterationSettle,
} from "@t3tools/epic-core/ports/AgentDispatch";
import {
  RunJournalError,
  type PersistedEpicRun,
  type PersistedEpicRunIteration,
} from "@t3tools/epic-core/ports/RunJournal";
import type { WorkspaceShape } from "@t3tools/epic-core/ports/Workspace";
import { findWorkspaceNodeModules, NODE_MODULES } from "@t3tools/epic-core/workspaceNodeModules";

/**
 * Materialise `node_modules/` and `node_modules/.pnpm/`, then link each store
 * package whole — the least that keeps a worker's install off the shared store.
 */
const ROOT_NODE_MODULES_DEPTH = 2;

/** A package's own node_modules is shallow — scopes and `.bin` at most. */
const PACKAGE_NODE_MODULES_DEPTH = 4;
import {
  decideGraceStep,
  integrationBranch as integrationBranchName,
  mergeSlotHolder,
  parseIntegrationFixTitle,
  parseMergeFixTitle,
  runBaseBranch as runBaseBranchName,
} from "@t3tools/epic-core/policy";
import { hasRalphBlocked, hasRalphDone, parseRalphReport } from "@t3tools/epic-core/ralphProtocol";
import { drainMergeQueue } from "@t3tools/epic-core/MergeQueue";
import { makeProcessBacklog } from "@t3tools/epic-core/adapters/ProcessBacklog";
import { makeProcessGate } from "@t3tools/epic-core/adapters/ProcessGate";
import { makeProcessMergeRepair } from "@t3tools/epic-core/adapters/ProcessMergeRepair";
import { makeProcessMergeSlot } from "@t3tools/epic-core/adapters/ProcessMergeSlot";
import { makeProcessPoolVcs } from "@t3tools/epic-core/adapters/ProcessPoolVcs";
import { MergeQueuePortError } from "@t3tools/epic-core/ports/MergeQueue";
import {
  makeSiblingResolver,
  mirrorPath,
  siblingRuleLayout,
  siblingRuleSequential,
  type SiblingRef,
} from "@t3tools/epic-core/siblings";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as FileSystem from "effect/FileSystem";
import type * as PlatformError from "effect/PlatformError";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";

import type { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import type { EpicWorkerScopeRegistry } from "../../provider/workerScope.ts";
import {
  countFreshRunningSubagents,
  isRunningSubagentLivenessRefusal,
} from "../../orchestration/subagentLiveness.ts";
import {
  makeThreadSettleWatch,
  resolveFinalAssistantMessage,
  threadTurnState,
} from "../../orchestration/ThreadSettleWatch.ts";
import type { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  EpicRunStore,
  type EpicRun,
  type EpicRunIteration as EpicRunIterationRow,
} from "../../persistence/Services/EpicRuns.ts";
import type { AgentAwarenessRelay } from "../../relay/AgentAwarenessRelay.ts";
import type { ServerConfig } from "../../config.ts";
import type { ProjectSetupScriptRunner } from "../../project/ProjectSetupScriptRunner.ts";
import type { WorktreeProvisioner } from "../../vcs/WorktreeProvisioner.ts";
import type { GitVcsDriver } from "../../vcs/GitVcsDriver.ts";
import { makeEpicRunMergeQueueStore } from "../EpicRunMergeQueueStore.ts";
import { makeEpicRunMergeGit } from "../EpicRunMergeGit.ts";

const GIT_HEAD_TIMEOUT_MS = 15_000;
const RECENT_ITERATIONS_LIMIT = 25;

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

const isEpicRunnerDispatchError = Schema.is(EpicRunnerDispatchError);

const storeError = (operation: string) => (cause: unknown) =>
  new EpicRunnerStoreError({ operation, cause });

/** The env files `setup_worktree_assets` copies (never production/staging). */
const WORKTREE_ASSET_ENV_FILES = [
  ".env",
  ".env.local",
  ".env.development",
  ".env.development.local",
  ".env.test",
] as const;

/**
 * `setup_worktree_assets` (`skills/cook-epic/run-legacy.sh:998-1011`): a
 * `node_modules` symlink from the source repo plus copies of the whitelisted
 * env files, each only when absent in the worktree. Sibling worktrees get
 * exactly this — no beads redirect; siblings have no beads database.
 *
 * In a workspace monorepo the root `node_modules` is not enough on its own:
 * each package resolves its imports through its own gitignored `node_modules`,
 * so those get mirrored too. See `@t3tools/epic-core/workspaceNodeModules`.
 */
const setupWorktreeAssets = (
  deps: {
    readonly fileSystem: FileSystem.FileSystem;
    readonly path: Path.Path;
  },
  sourceRepo: string,
  target: string,
): Effect.Effect<void, PlatformError.PlatformError> =>
  Effect.gen(function* () {
    const linkNodeModules = (relative: string) =>
      Effect.gen(function* () {
        const source = deps.path.join(sourceRepo, relative);
        const targetLink = deps.path.join(target, relative);
        // The owning package directory has to exist in this worktree; a branch
        // that never added the package simply has nothing to link into.
        const targetParent = deps.path.dirname(targetLink);
        if (
          (yield* deps.fileSystem.exists(source)) &&
          (yield* deps.fileSystem.exists(targetParent)) &&
          !(yield* deps.fileSystem.exists(targetLink))
        ) {
          yield* deps.fileSystem.symlink(source, targetLink);
        }
      });

    /**
     * Rebuild a package's `node_modules` as a tree of its own, copying every
     * symlink target verbatim.
     *
     * Linking the directory itself would be wrong: pnpm records workspace
     * dependencies as repo-relative links (`@t3tools/contracts -> ../../../contracts`),
     * and through a directory link those resolve against the SOURCE checkout.
     * The worktree would then typecheck the source copy of its own siblings
     * instead of the branch under test. Copied verbatim into a real directory
     * here, the same relative target resolves inside the worktree, while
     * store links (`../../../node_modules/.pnpm/...`) still reach the shared
     * store through the root `node_modules` link.
     */
    const replicateLinkTree = (
      source: string,
      targetDir: string,
      depth: number,
    ): Effect.Effect<void, PlatformError.PlatformError> =>
      Effect.gen(function* () {
        yield* deps.fileSystem.makeDirectory(targetDir, { recursive: true });
        const entries = yield* deps.fileSystem.readDirectory(source);
        for (const entry of entries) {
          const from = deps.path.join(source, entry);
          const to = deps.path.join(targetDir, entry);
          if (yield* deps.fileSystem.exists(to)) continue;
          // readLink doubles as the symlink test; stat would follow the link.
          const linkTarget = yield* deps.fileSystem
            .readLink(from)
            .pipe(Effect.catchCause(() => Effect.succeed(null)));
          if (linkTarget !== null) {
            yield* deps.fileSystem.symlink(linkTarget, to);
            continue;
          }
          const info = yield* deps.fileSystem.stat(from);
          if (info.type === "Directory") {
            // Past the budget, link the directory whole; materialising every
            // level of the pnpm store would be hundreds of thousands of entries.
            if (depth <= 1) {
              yield* deps.fileSystem.symlink(from, to);
              continue;
            }
            yield* replicateLinkTree(from, to, depth - 1);
            continue;
          }
          yield* deps.fileSystem.symlink(from, to);
        }
      });

    // The root node_modules is materialised, not linked. Linking it made a
    // worker share the source's dependency links, so `pnpm install` in a
    // worktree wrote through and repointed the real checkout at a temporary
    // directory; pruning it then broke every other worker and the gate with
    // ERR_MODULE_NOT_FOUND. Two levels deep the worktree owns node_modules/
    // and node_modules/.pnpm/, so an install or prune rewrites its own links.
    {
      const rootSource = deps.path.join(sourceRepo, NODE_MODULES);
      const rootTarget = deps.path.join(target, NODE_MODULES);
      if (
        (yield* deps.fileSystem.exists(rootSource)) &&
        !(yield* deps.fileSystem.exists(rootTarget))
      ) {
        yield* replicateLinkTree(rootSource, rootTarget, ROOT_NODE_MODULES_DEPTH);
      }
    }

    // Best-effort: a directory we cannot read contributes no workspace
    // packages rather than failing the whole worktree. A link we miss here
    // surfaces later as a plain dependency-resolution error, which is a far
    // better failure than refusing to provision the worktree at all.
    const listDirectories = (absolutePath: string) =>
      Effect.gen(function* () {
        const entries = yield* deps.fileSystem.readDirectory(absolutePath);
        const directories: Array<string> = [];
        for (const entry of entries) {
          // Catch per ENTRY, not per directory. `stat` follows symlinks and
          // throws on a dangling one, and a repo-root catch meant a single
          // broken link hid every workspace package beside it: no per-package
          // node_modules was mirrored, and the gate died on a missing
          // dependency that looked nothing like the cause. A name we cannot
          // stat is simply not a directory.
          const info = yield* deps.fileSystem
            .stat(deps.path.join(absolutePath, entry))
            .pipe(Effect.catchCause(() => Effect.succeed(null)));
          if (info !== null && info.type === "Directory") directories.push(entry);
        }
        return directories;
      }).pipe(Effect.catchCause(() => Effect.succeed<ReadonlyArray<string>>([])));

    const workspaceNodeModules = yield* findWorkspaceNodeModules(
      listDirectories,
      sourceRepo,
      (...segments) => deps.path.join(...segments),
    );
    for (const relative of workspaceNodeModules) {
      const source = deps.path.join(sourceRepo, relative);
      const targetDir = deps.path.join(target, relative);
      const targetParent = deps.path.dirname(targetDir);
      if (
        (yield* deps.fileSystem.exists(source)) &&
        (yield* deps.fileSystem.exists(targetParent)) &&
        !(yield* deps.fileSystem.exists(targetDir))
      ) {
        yield* replicateLinkTree(source, targetDir, PACKAGE_NODE_MODULES_DEPTH);
      }
    }

    for (const name of WORKTREE_ASSET_ENV_FILES) {
      const source = deps.path.join(sourceRepo, name);
      const targetFile = deps.path.join(target, name);
      if ((yield* deps.fileSystem.exists(source)) && !(yield* deps.fileSystem.exists(targetFile))) {
        yield* deps.fileSystem.copyFile(source, targetFile);
      }
    }
  });

const journalError = (operation: string) => (cause: unknown) =>
  new RunJournalError({
    operation,
    detail: cause instanceof Error ? cause.message : String(cause),
    ...(cause === undefined ? {} : { cause }),
  });

/**
 * Assemble the public run read model from a row plus its already-capped
 * iterations. Pure, so the single-run and batched list paths cannot drift.
 */
const buildTransportRun = (
  run: EpicRun,
  recentIterations: ReadonlyArray<EpicRunIterationRow>,
): TransportEpicRun => ({
  ...run,
  recentIterations: recentIterations.map((iteration) => ({
    ...iteration,
    workerId: iteration.workerId ?? null,
    branch: iteration.branch ?? null,
    worktreePath: iteration.worktreePath ?? null,
  })),
  threadRefs: recentIterations.flatMap((iteration) =>
    iteration.issueId === null
      ? []
      : [
          {
            issueId: iteration.issueId,
            threadId: iteration.threadId,
            iterationIndex: iteration.iterationIndex,
          },
        ],
  ),
});

/**
 * The run read model and the run-change fan-out the WS subscription consumes.
 *
 * `saveRun` is the lifecycle write path (upsert, then publish); the loop's
 * journal writes through {@link makeServerPoolJournal} and publishes through
 * the `events` port, so both paths land on the same PubSub in the same order.
 */
export const makeEpicRunReadModel = (deps: {
  readonly store: EpicRunStore["Service"];
  readonly processRunner: ProcessRunner.ProcessRunner["Service"];
  readonly agentAwarenessRelay: AgentAwarenessRelay["Service"];
  readonly changes: PubSub.PubSub<TransportEpicRun>;
}) => {
  const { store, processRunner, agentAwarenessRelay, changes } = deps;
  const issueTitleCache = new Map<string, string>();

  const enrichRun = Effect.fn("EpicRunner.enrichRun")(function* (run: EpicRun) {
    const iterations = yield* store
      .listIterations({ runId: run.runId })
      .pipe(Effect.mapError(storeError("listIterations")));
    return buildTransportRun(run, iterations.slice(-RECENT_ITERATIONS_LIMIT));
  });

  /**
   * Enrich a whole listing with ONE iteration query, not one per run.
   *
   * `listRecentIterationsForRuns` already caps each run at
   * `RECENT_ITERATIONS_LIMIT`, so the grouping here does no slicing of its
   * own; a run with no iterations is absent from the batch and gets an empty
   * array.
   */
  const enrichRuns = Effect.fn("EpicRunner.enrichRuns")(function* (runs: ReadonlyArray<EpicRun>) {
    const iterations = yield* store
      .listRecentIterationsForRuns({
        runIds: runs.map((run) => run.runId),
        limitPerRun: RECENT_ITERATIONS_LIMIT,
      })
      .pipe(Effect.mapError(storeError("listRecentIterationsForRuns")));
    const byRunId = new Map<string, Array<EpicRunIterationRow>>();
    for (const iteration of iterations) {
      const bucket = byRunId.get(iteration.runId);
      if (bucket === undefined) byRunId.set(iteration.runId, [iteration]);
      else bucket.push(iteration);
    }
    return runs.map((run) => buildTransportRun(run, byRunId.get(run.runId) ?? []));
  });

  const readIssueTitle = (cwd: string, issueId: string) => {
    const cached = issueTitleCache.get(issueId);
    if (cached) return Effect.succeed(cached);
    return processRunner.run({ command: "bd", args: ["show", issueId, "--json"], cwd }).pipe(
      Effect.flatMap((output) =>
        Effect.try({
          try: () => {
            const decoded = decodeIssueEvidence(output.stdout);
            if (Option.isNone(decoded)) return issueId;
            const value = Array.isArray(decoded.value) ? decoded.value[0] : decoded.value;
            const title = value?.title.trim() ?? "";
            return title.length > 0 ? title : issueId;
          },
          catch: () => issueId,
        }),
      ),
      Effect.orElseSucceed(() => issueId),
      Effect.tap((title) => Effect.sync(() => issueTitleCache.set(issueId, title))),
    );
  };

  const publishRunBestEffort = (run: TransportEpicRun) =>
    Effect.gen(function* () {
      const latestIssueId = run.recentIterations.at(-1)?.issueId ?? null;
      const epicTitle = yield* readIssueTitle(run.cwd, run.epicId);
      const childTitle =
        latestIssueId === null ? undefined : yield* readIssueTitle(run.cwd, latestIssueId);
      yield* agentAwarenessRelay.publishEpicRun({
        ...run,
        epicTitle,
        ...(childTitle ? { childTitle } : {}),
      });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("epic runner activity publish failed", {
          runId: run.runId,
          epicId: run.epicId,
          cause,
        }),
      ),
    );

  /** Enrich and fan out a persisted run row. Never re-writes the store. */
  const publishRunChange = (run: EpicRun) =>
    enrichRun(run).pipe(
      Effect.tap((enriched) => publishRunBestEffort(enriched)),
      Effect.flatMap((enriched) => PubSub.publish(changes, enriched)),
      Effect.asVoid,
    );

  const saveRun = (run: EpicRun) =>
    store.upsertRun(run).pipe(
      Effect.mapError(storeError("upsertRun")),
      Effect.flatMap(() => publishRunChange(run)),
    );

  const events: PoolRunEventsShape = {
    // Iteration changes reach the UI through the next run publish, exactly as
    // they did before the rewire; only run rows fan out to the PubSub.
    publish: (event) =>
      event.type === "run-state-changed" ? publishRunChange(event.run) : Effect.void,
  };

  return { enrichRun, enrichRuns, saveRun, publishRunChange, events };
};

const IssueEvidence = Schema.Struct({
  status: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  comment_count: Schema.Number.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
});
const decodeIssueEvidence = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Union([IssueEvidence, Schema.Array(IssueEvidence)])),
);

/**
 * The durable run store behind the loop's journal port. The crash-safe
 * write-ahead ordering is the store's own contract: `allocateIteration`
 * atomically inserts the running row before orchestration begins, and
 * `updateIteration` lands the terminal state after the turn resolves.
 */
export const makeServerPoolJournal = (store: EpicRunStore["Service"]): PoolRunJournalShape => ({
  createRun: (run) => store.upsertRun(run).pipe(Effect.mapError(journalError("createRun"))),
  saveRun: (run) => store.upsertRun(run).pipe(Effect.mapError(journalError("saveRun"))),
  getRun: (runId) =>
    store.getRun({ runId }).pipe(
      Effect.map((run): Option.Option<PersistedEpicRun> => run),
      Effect.mapError(journalError("getRun")),
    ),
  appendIteration: (iteration) => {
    // The server row carries worker identity instead of head probes.
    const { headBefore: _headBefore, headAfter: _headAfter, ...row } = iteration;
    return store.appendIteration(row).pipe(Effect.mapError(journalError("appendIteration")));
  },
  allocateIteration: (input) =>
    store.allocateIteration(input).pipe(Effect.mapError(journalError("allocateIteration"))),
  updateIteration: (input) => {
    const { headBefore: _headBefore, headAfter: _headAfter, ...row } = input;
    return store.updateIteration(row).pipe(Effect.mapError(journalError("updateIteration")));
  },
  listIterations: (runId) =>
    store.listIterations({ runId }).pipe(
      Effect.map((rows): ReadonlyArray<PersistedEpicRunIteration> => rows),
      Effect.mapError(journalError("listIterations")),
    ),
  getLatestIteration: (runId) =>
    store.getLatestIteration({ runId }).pipe(
      Effect.map((row): Option.Option<PersistedEpicRunIteration> => row),
      Effect.mapError(journalError("getLatestIteration")),
    ),
  upsertProviderDegradation: (input) =>
    store
      .upsertProviderDegradation(input)
      .pipe(Effect.mapError(journalError("upsertProviderDegradation"))),
  clearProviderDegradation: (input) =>
    store
      .clearProviderDegradation(input)
      .pipe(Effect.mapError(journalError("clearProviderDegradation"))),
});

/** Worktree lifecycle for pool iterations and the integration branch. */
export const makeServerPoolWorkspace = (deps: {
  readonly store: EpicRunStore["Service"];
  readonly processRunner: ProcessRunner.ProcessRunner["Service"];
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly serverConfig: ServerConfig["Service"];
  readonly worktreeProvisioner: WorktreeProvisioner["Service"];
  readonly gitVcsDriver: GitVcsDriver["Service"];
  readonly projectionSnapshotQuery: ProjectionSnapshotQuery["Service"];
}): WorkspaceShape => {
  const {
    store,
    processRunner,
    fileSystem,
    path,
    serverConfig,
    worktreeProvisioner,
    gitVcsDriver,
    projectionSnapshotQuery,
  } = deps;

  const readCurrentBranch = (cwd: string): Effect.Effect<string, EpicRunnerDispatchError> =>
    processRunner
      .run({
        command: "git",
        args: ["symbolic-ref", "--short", "HEAD"],
        cwd,
        timeout: Duration.millis(GIT_HEAD_TIMEOUT_MS),
      })
      .pipe(
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
        Effect.mapError((cause) =>
          isEpicRunnerDispatchError(cause)
            ? cause
            : new EpicRunnerDispatchError({
                commandType: "git.current-branch",
                detail: "Could not resolve the epic base branch",
                cause,
              }),
        ),
      );

  const branchExistsAt = (
    cwd: string,
    branch: string,
  ): Effect.Effect<boolean, EpicRunnerDispatchError> =>
    processRunner
      .run({
        command: "git",
        args: ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
        cwd,
        timeout: Duration.millis(GIT_HEAD_TIMEOUT_MS),
      })
      .pipe(
        Effect.map((output) => output.code === 0),
        Effect.mapError(
          (cause) =>
            new EpicRunnerDispatchError({
              commandType: "git.run-base-branch-check",
              detail: `Could not check branch ${branch}`,
              cause,
            }),
        ),
      );

  /**
   * The base branch a parallel run's worktrees start from: the operator's
   * checked-out branch, or the run's own `epic/<epicId>/base`, created
   * idempotently on first use and reused verbatim after (t3code-5m4).
   */
  const resolveBaseBranch = (run: EpicRun) =>
    resolveRunBaseBranch(
      {
        currentBranch: readCurrentBranch,
        branchExists: branchExistsAt,
        createBranch: (cwd, branch, startPoint) =>
          processRunner
            .run({
              command: "git",
              args: ["branch", branch, startPoint],
              cwd,
              timeout: Duration.millis(GIT_HEAD_TIMEOUT_MS),
            })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new EpicRunnerDispatchError({
                    commandType: "git.run-base-branch-create",
                    detail: `Could not create branch ${branch}`,
                    cause,
                  }),
              ),
              Effect.flatMap((output) =>
                output.code === 0
                  ? Effect.void
                  : Effect.fail(
                      new EpicRunnerDispatchError({
                        commandType: "git.run-base-branch-create",
                        detail:
                          output.stderr.trim() || `git exited with code ${String(output.code)}`,
                      }),
                    ),
              ),
            ),
      },
      { cwd: run.cwd, epicId: run.epicId, runOwnedBaseBranch: run.config.vcs.runOwnedBaseBranch },
    );

  const resolveBeadsDirectory = (cwd: string) =>
    Effect.gen(function* () {
      const beadsDirectory = path.join(cwd, ".beads");
      const canonicalBeads = yield* fileSystem
        .realPath(beadsDirectory)
        .pipe(Effect.orElseSucceed(() => beadsDirectory));
      const redirect = yield* fileSystem.readFileString(path.join(canonicalBeads, "redirect")).pipe(
        Effect.map((contents) => contents.trim()),
        Effect.orElseSucceed(() => ""),
      );
      const target =
        redirect.length === 0
          ? canonicalBeads
          : path.isAbsolute(redirect)
            ? redirect
            : path.resolve(cwd, redirect);
      return yield* fileSystem.realPath(target).pipe(Effect.orElseSucceed(() => target));
    });

  const writeBeadsRedirect = (runCwd: string, worktreeCwd: string) =>
    Effect.gen(function* () {
      const targetBeads = yield* resolveBeadsDirectory(runCwd);
      const worktreeBeads = path.join(worktreeCwd, ".beads");
      yield* fileSystem.makeDirectory(worktreeBeads, { recursive: true });
      yield* fileSystem.writeFileString(
        path.join(worktreeBeads, "redirect"),
        path.relative(worktreeCwd, targetBeads),
      );
    });

  const releaseProvisionedWorktree = (input: {
    readonly repositoryPath: string;
    readonly worktreePath: string;
    readonly label: string;
  }) =>
    worktreeProvisioner
      .release({
        repoCwd: input.repositoryPath,
        worktreePath: input.worktreePath,
        force: true,
      })
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning(input.label, {
            repositoryPath: input.repositoryPath,
            worktreePath: input.worktreePath,
            cause,
          }),
        ),
      );

  /** The run-scoped root every worker layout lives under. */
  const layoutRoot = (runId: string) =>
    path.join(serverConfig.worktreesDir, `epic-${runId}`, "layouts");

  /**
   * Sibling repositories resolved once per run
   * (`skills/cook-epic/run-legacy.sh:240-282`). Resolution failures are not
   * cached: a later dispatch retries against the reconciled checkouts.
   */
  const resolvedSiblings = new Map<string, ReadonlyArray<SiblingRef>>();
  const runSiblings = Effect.fn("EpicRunnerPoolPorts.runSiblings")(function* (run: EpicRun) {
    const cached = resolvedSiblings.get(run.runId);
    if (cached !== undefined) return cached;
    const configured = run.config.parallel.siblings;
    if (configured.length === 0) return [] as ReadonlyArray<SiblingRef>;
    const siblings = yield* makeSiblingResolver(processRunner.run)
      .resolveSiblings({
        cwd: run.cwd,
        siblings: configured,
        pushEnabled: !run.config.vcs.noPush,
        layoutMode: !run.config.execution.sequential,
      })
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
    resolvedSiblings.set(run.runId, siblings);
    return siblings;
  });

  /**
   * The integration worktree for a parallel run: the persisted one when it
   * exists, freshly provisioned otherwise. Sequential runs return `null`.
   */
  const ensureIntegrationWorkspace = (run: EpicRun) =>
    Effect.gen(function* () {
      if (run.config.execution.sequential) return null;
      const persisted = yield* store
        .getMergeState({ runId: run.runId })
        .pipe(Effect.mapError(storeError("getMergeState")));
      if (Option.isSome(persisted)) return persisted.value;

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
      // integration for this run.
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
      const vcs = makeProcessPoolVcs(processRunner);
      // A run-owned base branch (t3code-5m4) is never checked out at
      // `run.cwd`, so seeding from `HEAD` there would read the operator's
      // branch instead — reused verbatim by every later resume and fatal on
      // the first drain once the two disagree. Read the resolved base branch
      // itself so this agrees with what MergeQueue lands against.
      const lastAcceptedHead = yield* vcs.headCommit(
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
      const targetPath = path.join(serverConfig.worktreesDir, `epic-${run.runId}`, "integration");
      const branchCheck = yield* processRunner
        .run({
          command: "git",
          args: ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
          cwd: run.cwd,
          timeout: Duration.millis(GIT_HEAD_TIMEOUT_MS),
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new EpicRunnerDispatchError({
                commandType: "git.integration-worktree-check",
                detail: `Could not check integration branch ${branch}`,
                cause,
              }),
          ),
        );
      if (branchCheck.code === 0) {
        return yield* new EpicRunnerDispatchError({
          commandType: "git.integration-worktree",
          detail: `Refusing to reuse existing integration branch ${branch}; reconcile it first`,
        });
      }
      const provisioned = yield* worktreeProvisioner
        .provision({
          projectCwd: run.cwd,
          branch,
          baseBranch,
          path: targetPath,
          refuseExisting: true,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new EpicRunnerDispatchError({
                commandType: "git.integration-worktree-provision",
                detail: `Could not provision ${branch} at ${targetPath}`,
                cause,
              }),
          ),
        );
      const provisionedSiblings: Array<{
        readonly repo: string;
        readonly worktreePath: string;
      }> = [];
      return yield* Effect.gen(function* () {
        yield* writeBeadsRedirect(run.cwd, provisioned.path).pipe(
          Effect.mapError(
            (cause) =>
              new EpicRunnerDispatchError({
                commandType: "beads.integration-redirect-write",
                detail: `Could not write the beads redirect in ${provisioned.path}`,
                cause,
              }),
          ),
        );
        // The merge drain restores these before every set, but do it up front
        // too so the worktree is runnable the moment it exists.
        yield* setupWorktreeAssets({ fileSystem, path }, run.cwd, provisioned.path).pipe(
          Effect.mapError(
            (cause) =>
              new EpicRunnerDispatchError({
                commandType: "worktree.integration-assets",
                detail: `Could not set up assets in ${provisioned.path}`,
                cause,
              }),
          ),
        );
        // One integration worktree per sibling, mirrored beside the main one
        // so set trial-merges and the gate see the same relative structure as
        // workers (`skills/cook-epic/run-legacy.sh:1055-1069`).
        const siblings = yield* runSiblings(run);
        const siblingStates: Array<{
          readonly repositoryPath: string;
          readonly baseBranch: string;
          readonly integrationWorktreePath: string;
          readonly lastAcceptedHead: string;
          readonly initialHead: string;
        }> = [];
        for (const sibling of siblings) {
          const target = mirrorPath(
            path.dirname(targetPath),
            path.basename(targetPath),
            sibling.relativePath,
          );
          const siblingBranchCheck = yield* processRunner
            .run({
              command: "git",
              args: ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
              cwd: sibling.canonicalPath,
              timeout: Duration.millis(GIT_HEAD_TIMEOUT_MS),
            })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new EpicRunnerDispatchError({
                    commandType: "git.sibling-integration-worktree-check",
                    detail: `Could not check integration branch ${branch} in sibling ${sibling.canonicalPath}`,
                    cause,
                  }),
              ),
            );
          if (siblingBranchCheck.code === 0) {
            return yield* new EpicRunnerDispatchError({
              commandType: "git.sibling-integration-worktree",
              detail: `Refusing to reuse existing integration branch ${branch} in sibling ${sibling.canonicalPath}; reconcile it first`,
            });
          }
          const siblingWorktree = yield* worktreeProvisioner
            .provision({
              projectCwd: sibling.canonicalPath,
              branch,
              baseBranch: sibling.baseBranch,
              path: target,
              refuseExisting: true,
            })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new EpicRunnerDispatchError({
                    commandType: "git.sibling-integration-worktree-provision",
                    detail: `Could not provision ${branch} at ${target} for sibling ${sibling.canonicalPath}`,
                    cause,
                  }),
              ),
            );
          provisionedSiblings.push({
            repo: sibling.canonicalPath,
            worktreePath: siblingWorktree.path,
          });
          // Sibling integration worktrees get assets only — siblings have no
          // beads database (`skills/cook-epic/run-legacy.sh:1008-1009`).
          yield* setupWorktreeAssets(
            { fileSystem, path },
            sibling.canonicalPath,
            siblingWorktree.path,
          ).pipe(
            Effect.mapError(
              (cause) =>
                new EpicRunnerDispatchError({
                  commandType: "git.sibling-integration-assets",
                  detail: `Could not set up assets in ${siblingWorktree.path}`,
                  cause,
                }),
            ),
          );
          const siblingHead = yield* vcs.headCommit(sibling.canonicalPath);
          if (siblingHead === null) {
            return yield* new EpicRunnerDispatchError({
              commandType: "git.sibling-integration-worktree",
              detail: `Could not resolve HEAD of sibling ${sibling.canonicalPath} while creating its integration worktree`,
            });
          }
          siblingStates.push({
            repositoryPath: sibling.canonicalPath,
            baseBranch: sibling.baseBranch,
            integrationWorktreePath: siblingWorktree.path,
            lastAcceptedHead: siblingHead,
            initialHead: siblingHead,
          });
        }
        yield* store
          .initializeMergeState({
            runId: run.runId,
            lastAcceptedHead,
            repositoryPath: run.cwd,
            baseBranch,
            integrationBranch: provisioned.refName,
            integrationWorktreePath: provisioned.path,
            operatorBaseBranch,
            siblings: siblingStates,
          })
          .pipe(Effect.mapError(storeError("initializeMergeState")));
        return Option.getOrThrow(
          yield* store
            .getMergeState({ runId: run.runId })
            .pipe(Effect.mapError(storeError("getMergeState"))),
        );
      }).pipe(
        Effect.catchCause((cause) =>
          // Roll back the whole set: sibling worktrees and branches first,
          // then the main integration worktree and its branch.
          Effect.forEach(
            provisionedSiblings.toReversed(),
            (sibling) =>
              releaseProvisionedWorktree({
                repositoryPath: sibling.repo,
                worktreePath: sibling.worktreePath,
                label: "epic.runner.sibling-integration-provision-rollback-failed",
              }).pipe(
                Effect.andThen(
                  makeEpicRunMergeGit({ git: gitVcsDriver, setupWorktree: () => Effect.void })
                    .deleteLocalBranch(sibling.repo, provisioned.refName)
                    .pipe(
                      Effect.catchCause((deleteCause) =>
                        Effect.logWarning(
                          "epic.runner.sibling-integration-branch-rollback-failed",
                          {
                            runId: run.runId,
                            branch: provisioned.refName,
                            cause: deleteCause,
                          },
                        ),
                      ),
                    ),
                ),
              ),
            { discard: true },
          ).pipe(
            Effect.andThen(
              releaseProvisionedWorktree({
                repositoryPath: run.cwd,
                worktreePath: provisioned.path,
                label: "epic.runner.integration-provision-rollback-failed",
              }),
            ),
            Effect.andThen(
              makeEpicRunMergeGit({ git: gitVcsDriver, setupWorktree: () => Effect.void })
                .deleteLocalBranch(run.cwd, provisioned.refName)
                .pipe(
                  Effect.catchCause((deleteCause) =>
                    Effect.logWarning("epic.runner.integration-branch-rollback-failed", {
                      runId: run.runId,
                      branch: provisioned.refName,
                      cause: deleteCause,
                    }),
                  ),
                ),
            ),
            Effect.andThen(Effect.failCause(cause)),
          ),
        ),
      );
    });

  const requireRun = (runId: EpicRun["runId"]) =>
    store.getRun({ runId }).pipe(
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

  return {
    ensureIntegration: (runCtx) =>
      requireRun(runCtx.runId).pipe(
        Effect.map((run) => ({ run })),
        Effect.flatMap(({ run }) =>
          ensureIntegrationWorkspace(run).pipe(
            Effect.map((state) =>
              state === null
                ? null
                : {
                    entries: state.entries.map((entry) => ({ status: entry.status })),
                  },
            ),
          ),
        ),
      ),

    acquire: (runCtx, input) =>
      Effect.gen(function* () {
        if (input.sequential) {
          /**
           * The `worktreePath` an iteration's thread must carry to actually
           * run in the run's `cwd`.
           *
           * A thread's working directory is `worktreePath ?? project.workspaceRoot`
           * (`checkpointing/Utils.ts:22-26`), so leaving it null silently runs the
           * agent in the project root. When that already *is* the run's cwd the field
           * stays null rather than claiming a worktree that does not exist; when the
           * run targets somewhere else (a cook-epic worktree, a sibling checkout) it
           * has to be set, or the agent would commit into one repo while the
           * commit cross-check watched another.
           */
          const run = yield* requireRun(runCtx.runId);
          const worktreePath = yield* projectionSnapshotQuery
            .getProjectShellById(run.projectId)
            .pipe(
              Effect.map((project) =>
                Option.isSome(project) && project.value.workspaceRoot === run.cwd ? null : run.cwd,
              ),
              Effect.catchCause((cause) =>
                Effect.logWarning("epic.runner.project-read-failed", {
                  projectId: run.projectId,
                  cause,
                }).pipe(Effect.as(run.cwd)),
              ),
            );
          // Sequential mode works in the real sibling checkouts — no
          // worktrees, no mirrored paths (`skills/cook-epic/run-legacy.sh:737-739`).
          const siblings = yield* runSiblings(run);
          return {
            cwd: worktreePath ?? run.cwd,
            branch: null,
            worktreePath,
            siblingWorktrees: siblings.map((sibling) => ({
              worktreePath: sibling.canonicalPath,
              sourcePath: sibling.canonicalPath,
              baseBranch: sibling.baseBranch,
            })),
            siblingRule: siblings.length === 0 ? null : siblingRuleSequential({ siblings }),
          };
        }

        const mergeFix = parseMergeFixTitle(input.issueTitle);
        // An integration-fix child (t3code-sha) is dispatched directly onto
        // the run's own base branch — the same reused-branch pattern a
        // per-entry merge-fix child gets — so committing there IS landing
        // the resolution; there is no separate branch for the queue to land.
        const integrationFix = parseIntegrationFixTitle(input.issueTitle);
        const branch =
          mergeFix?.branch ??
          (integrationFix !== null ? runBaseBranchName(runCtx.epicId) : `epic/${input.issueId}`);
        if (mergeFix !== null) {
          const original = yield* store
            .findParkedOriginalChild({ runId: runCtx.runId, branch })
            .pipe(Effect.mapError(storeError("findParkedOriginalChild")));
          if (Option.isNone(original)) {
            return yield* new EpicRunnerDispatchError({
              commandType: "git.merge-fix-worktree",
              detail: `Merge-fix child ${input.issueId} refers to unparked branch ${branch}`,
            });
          }
        }
        const run = yield* requireRun(runCtx.runId);
        const baseBranch = yield* resolveBaseBranch(run);
        const siblings = yield* runSiblings(run);
        if (siblings.length > 0) {
          // Layout mode: the worker sandbox is a run-scoped layout root
          // outside both repos, reproducing the siblings' real relative
          // positions so references like `../sibling` resolve inside it
          // (`skills/cook-epic/run-legacy.sh:1919-1953`).
          const canonicalCwd = yield* fileSystem
            .realPath(run.cwd)
            .pipe(Effect.orElseSucceed(() => run.cwd));
          const repoBasename = path.basename(canonicalCwd);
          const root = layoutRoot(runCtx.runId);
          const layout = path.join(root, input.issueId);
          const layoutExists = yield* fileSystem.exists(layout).pipe(
            Effect.mapError(
              (cause) =>
                new EpicRunnerDispatchError({
                  commandType: "git.layout-provision",
                  detail: `Could not inspect layout ${layout}`,
                  cause,
                }),
            ),
          );
          if (layoutExists) {
            return yield* new EpicRunnerDispatchError({
              commandType: "git.layout-provision",
              detail: `Refusing to provision over existing layout ${layout}; reconcile it first`,
            });
          }
          const created: Array<{ readonly repo: string; readonly worktreePath: string }> = [];
          const mainTarget = path.join(layout, repoBasename);
          return yield* Effect.gen(function* () {
            const main = yield* worktreeProvisioner
              .provision({
                projectCwd: run.cwd,
                branch,
                baseBranch,
                path: mainTarget,
                refuseExisting: true,
              })
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new EpicRunnerDispatchError({
                      commandType: "git.layout-worktree-provision",
                      detail: `Could not provision ${branch} at ${mainTarget}`,
                      cause,
                    }),
                ),
              );
            created.push({ repo: run.cwd, worktreePath: main.path });
            yield* writeBeadsRedirect(run.cwd, main.path).pipe(
              Effect.mapError(
                (cause) =>
                  new EpicRunnerDispatchError({
                    commandType: "beads.redirect-write",
                    detail: `Could not write the beads redirect in ${main.path}`,
                    cause,
                  }),
              ),
            );
            yield* setupWorktreeAssets({ fileSystem, path }, run.cwd, main.path).pipe(
              Effect.mapError(
                (cause) =>
                  new EpicRunnerDispatchError({
                    commandType: "worktree.worker-assets",
                    detail: `Could not set up assets in ${main.path}`,
                    cause,
                  }),
              ),
            );
            const siblingWorktrees: Array<{
              readonly worktreePath: string;
              readonly sourcePath: string;
              readonly baseBranch: string;
            }> = [];
            for (const sibling of siblings) {
              const target = mirrorPath(layout, repoBasename, sibling.relativePath);
              const siblingWorktree = yield* worktreeProvisioner
                .provision({
                  projectCwd: sibling.canonicalPath,
                  branch,
                  baseBranch: sibling.baseBranch,
                  path: target,
                  refuseExisting: true,
                })
                .pipe(
                  Effect.mapError(
                    (cause) =>
                      new EpicRunnerDispatchError({
                        commandType: "git.layout-worktree-provision",
                        detail: `Could not provision ${branch} at ${target} for sibling ${sibling.canonicalPath}`,
                        cause,
                      }),
                  ),
                );
              created.push({ repo: sibling.canonicalPath, worktreePath: siblingWorktree.path });
              // Sibling worktrees get assets only
              // (`skills/cook-epic/run-legacy.sh:1008-1009`).
              yield* setupWorktreeAssets(
                { fileSystem, path },
                sibling.canonicalPath,
                siblingWorktree.path,
              ).pipe(
                Effect.mapError(
                  (cause) =>
                    new EpicRunnerDispatchError({
                      commandType: "git.layout-worktree-assets",
                      detail: `Could not set up assets in ${siblingWorktree.path}`,
                      cause,
                    }),
                ),
              );
              siblingWorktrees.push({
                worktreePath: siblingWorktree.path,
                sourcePath: sibling.canonicalPath,
                baseBranch: sibling.baseBranch,
              });
            }
            return {
              cwd: main.path,
              branch: main.refName,
              worktreePath: main.path,
              siblingWorktrees,
              siblingRule: siblingRuleLayout({
                layoutRoot: root,
                layout,
                repoBasename,
                branch: main.refName,
                siblings,
              }),
            };
          }).pipe(
            // A failed layout provision tears the partial layout down;
            // branches survive for retries.
            Effect.catchCause((cause) =>
              Effect.forEach(
                created.toReversed(),
                (entry) =>
                  releaseProvisionedWorktree({
                    repositoryPath: entry.repo,
                    worktreePath: entry.worktreePath,
                    label: "epic.runner.layout-provision-rollback-failed",
                  }),
                { discard: true },
              ).pipe(
                Effect.andThen(
                  fileSystem.remove(layout, { force: true, recursive: true }).pipe(
                    Effect.catchCause((removeCause) =>
                      Effect.logWarning("epic.runner.layout-dir-rollback-failed", {
                        layout,
                        cause: removeCause,
                      }),
                    ),
                  ),
                ),
                Effect.andThen(Effect.failCause(cause)),
              ),
            ),
          );
        }
        const targetPath = path.join(
          serverConfig.worktreesDir,
          `epic-${runCtx.runId}`,
          input.issueId,
        );
        const provisioned = yield* worktreeProvisioner
          .provision({
            projectCwd: runCtx.cwd,
            branch,
            baseBranch,
            path: targetPath,
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new EpicRunnerDispatchError({
                  commandType: "git.worktree-provision",
                  detail: `Could not provision ${branch} at ${targetPath}`,
                  cause,
                }),
            ),
          );
        return yield* Effect.gen(function* () {
          yield* writeBeadsRedirect(runCtx.cwd, provisioned.path).pipe(
            Effect.mapError(
              (cause) =>
                new EpicRunnerDispatchError({
                  commandType: "beads.redirect-write",
                  detail: `Could not write the beads redirect in ${provisioned.path}`,
                  cause,
                }),
            ),
          );
          // Without this the worker has no dependencies at all, so it cannot
          // typecheck or test the change it is about to commit.
          yield* setupWorktreeAssets({ fileSystem, path }, runCtx.cwd, provisioned.path).pipe(
            Effect.mapError(
              (cause) =>
                new EpicRunnerDispatchError({
                  commandType: "worktree.worker-assets",
                  detail: `Could not set up assets in ${provisioned.path}`,
                  cause,
                }),
            ),
          );
          return {
            cwd: provisioned.path,
            branch: provisioned.refName,
            worktreePath: provisioned.path,
            siblingWorktrees: [],
            siblingRule: null,
          };
        }).pipe(
          Effect.catchCause((cause) =>
            releaseProvisionedWorktree({
              repositoryPath: runCtx.cwd,
              worktreePath: provisioned.path,
              label: "epic.runner.worker-provision-rollback-failed",
            }).pipe(Effect.andThen(Effect.failCause(cause))),
          ),
        );
      }),

    release: (runCtx, workspace) => {
      if (workspace.worktreePath === null) return Effect.void;
      const worktreePath = workspace.worktreePath;
      const root = layoutRoot(runCtx.runId);
      if (!worktreePath.startsWith(`${root}/`)) {
        return worktreeProvisioner.release({ repoCwd: runCtx.cwd, worktreePath, force: true }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("epic.runner.worker-worktree-release-failed", {
              runId: runCtx.runId,
              worktreePath,
              cause,
            }),
          ),
        );
      }
      // A layout is one unit (`skills/cook-epic/run-legacy.sh:2309-2336`):
      // every sibling worktree, then the main worktree, then the layout dir.
      // Branches survive for retries; any failure is fatal to the run.
      const layout = path.dirname(worktreePath);
      return Effect.gen(function* () {
        if (!layout.startsWith(`${root}/`)) {
          return yield* new EpicRunnerDispatchError({
            commandType: "git.layout-release",
            detail: `Refusing to remove ${layout}: not a layout under ${root}`,
          });
        }
        for (const sibling of workspace.siblingWorktrees) {
          const registered = yield* processRunner
            .run({
              command: "git",
              args: ["-C", sibling.sourcePath, "worktree", "list", "--porcelain"],
              cwd: runCtx.cwd,
              timeout: Duration.millis(GIT_HEAD_TIMEOUT_MS),
            })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new EpicRunnerDispatchError({
                    commandType: "git.layout-release",
                    detail: `Could not list worktrees of sibling ${sibling.sourcePath}`,
                    cause,
                  }),
              ),
            );
          if (
            registered.code !== 0 ||
            !registered.stdout.split(/\r?\n/).includes(`worktree ${sibling.worktreePath}`)
          ) {
            continue;
          }
          yield* worktreeProvisioner
            .release({
              repoCwd: sibling.sourcePath,
              worktreePath: sibling.worktreePath,
              force: true,
            })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new EpicRunnerDispatchError({
                    commandType: "git.layout-release",
                    detail: `Could not remove sibling worktree ${sibling.worktreePath}`,
                    cause,
                  }),
              ),
            );
        }
        yield* worktreeProvisioner.release({ repoCwd: runCtx.cwd, worktreePath, force: true }).pipe(
          Effect.mapError(
            (cause) =>
              new EpicRunnerDispatchError({
                commandType: "git.layout-release",
                detail: `Could not remove layout worktree ${worktreePath}`,
                cause,
              }),
          ),
        );
        yield* fileSystem.remove(layout, { force: true, recursive: true }).pipe(
          Effect.mapError(
            (cause) =>
              new EpicRunnerDispatchError({
                commandType: "git.layout-release",
                detail: `Could not remove layout directory ${layout}`,
                cause,
              }),
          ),
        );
      });
    },

    releaseIntegration: (runCtx, outcome) =>
      Effect.gen(function* () {
        const run = yield* store.getRun({ runId: runCtx.runId }).pipe(
          Effect.map(Option.getOrNull),
          Effect.catchCause((cause) =>
            Effect.logWarning("epic.runner.integration-cleanup-run-read-failed", {
              runId: runCtx.runId,
              cause,
            }).pipe(Effect.as(null)),
          ),
        );
        if (run === null || run.config.execution.sequential) return;
        const state = yield* store
          .getMergeState({ runId: runCtx.runId })
          .pipe(Effect.mapError(storeError("getMergeState")));
        if (Option.isNone(state)) return;
        // One landing-effects row and one log event per landed repository:
        // the main repository first, then every sibling (t3code-06s.44).
        const recordLandingEffects = (input: {
          readonly repositoryPath: string;
          readonly baseHead: string;
          readonly head: string;
        }) =>
          Effect.gen(function* () {
            const countOutput = yield* gitVcsDriver
              .execute({
                operation: "EpicRunner.landingEffects.commitCount",
                cwd: input.repositoryPath,
                args: ["rev-list", "--count", `${input.baseHead}..${input.head}`],
              })
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new EpicRunnerDispatchError({
                      commandType: "git.landing-effects",
                      detail: `Could not count landed commits in ${input.repositoryPath}`,
                      cause,
                    }),
                ),
              );
            const commitCount = Number.parseInt(countOutput.stdout.trim(), 10);
            if (!Number.isSafeInteger(commitCount) || commitCount < 0) {
              return yield* new EpicRunnerDispatchError({
                commandType: "git.landing-effects",
                detail: `Git returned an invalid landed commit count: ${countOutput.stdout.trim()}`,
              });
            }
            const landingEffects = {
              runId: runCtx.runId,
              repositoryPath: input.repositoryPath,
              baseHead: input.baseHead,
              head: input.head,
              commitCount,
              parkedCount: state.value.parkedCount,
            } as const;
            yield* store
              .upsertLandingEffects(landingEffects)
              .pipe(Effect.mapError(storeError("upsertLandingEffects")));
            yield* Effect.logInfo("epic.runner.repository-landing-effects", {
              ...landingEffects,
            });
          });
        yield* recordLandingEffects({
          repositoryPath: state.value.repositoryPath,
          baseHead: state.value.initialHead,
          head: state.value.lastAcceptedHead,
        });
        for (const sibling of state.value.siblings) {
          if (sibling.initialHead === undefined) {
            // Merge states initialized before 2026-08-08 have no sibling
            // initial head; fall back to the last accepted one (a count of 0).
            yield* Effect.logWarning("epic.runner.sibling-landing-effects-base-missing", {
              runId: runCtx.runId,
              repositoryPath: sibling.repositoryPath,
            });
          }
          yield* recordLandingEffects({
            repositoryPath: sibling.repositoryPath,
            baseHead: sibling.initialHead ?? sibling.lastAcceptedHead,
            head: sibling.lastAcceptedHead,
          });
        }
        // Sibling integration worktrees and branches go first; the main
        // integration worktree last (`skills/cook-epic/run-legacy.sh:2309-2336`).
        for (const sibling of state.value.siblings) {
          yield* worktreeProvisioner
            .release({
              repoCwd: sibling.repositoryPath,
              worktreePath: sibling.integrationWorktreePath,
              force: true,
            })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new EpicRunnerDispatchError({
                    commandType: "git.sibling-integration-worktree-release",
                    detail: `Could not release ${sibling.integrationWorktreePath}`,
                    cause,
                  }),
              ),
            );
          yield* makeEpicRunMergeGit({ git: gitVcsDriver, setupWorktree: () => Effect.void })
            .deleteLocalBranch(sibling.repositoryPath, state.value.integrationBranch)
            .pipe(
              Effect.mapError(
                (cause) =>
                  new EpicRunnerDispatchError({
                    commandType: "git.sibling-integration-branch-delete",
                    detail: cause.detail,
                    cause,
                  }),
              ),
            );
        }
        yield* worktreeProvisioner
          .release({
            repoCwd: state.value.repositoryPath,
            worktreePath: state.value.integrationWorktreePath,
            force: true,
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new EpicRunnerDispatchError({
                  commandType: "git.integration-worktree-release",
                  detail: `Could not release ${state.value.integrationWorktreePath}`,
                  cause,
                }),
            ),
          );
        yield* makeEpicRunMergeGit({ git: gitVcsDriver, setupWorktree: () => Effect.void })
          .deleteLocalBranch(state.value.repositoryPath, state.value.integrationBranch)
          .pipe(
            Effect.mapError(
              (cause) =>
                new EpicRunnerDispatchError({
                  commandType: "git.integration-branch-delete",
                  detail: cause.detail,
                  cause,
                }),
            ),
          );
        if (outcome !== "failed") {
          yield* store
            .deleteMergeState({ runId: runCtx.runId })
            .pipe(Effect.mapError(storeError("deleteMergeState")));
        }
        // Best-effort: drop the run's worktree dir once nothing is left in it.
        yield* fileSystem
          .remove(path.join(serverConfig.worktreesDir, `epic-${runCtx.runId}`))
          .pipe(Effect.ignore);
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("epic.runner.integration-cleanup-failed", {
            runId: runCtx.runId,
            cause,
          }),
        ),
      ),
  };
};

/** The merge-queue writes and the queued-branch drain the scheduler runs. */
export const makeServerMergeDrain = (deps: {
  readonly store: EpicRunStore["Service"];
  readonly processRunner: ProcessRunner.ProcessRunner["Service"];
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly gitVcsDriver: GitVcsDriver["Service"];
}): MergeDrainShape => {
  const { store, processRunner, fileSystem, path, gitVcsDriver } = deps;
  const mergeQueueStore = makeEpicRunMergeQueueStore(store);
  const mergeGate = makeProcessGate({
    processRunner,
    environment: process.env,
    uid: process.getuid?.() ?? 0,
  });
  const mergeRepair = makeProcessMergeRepair({
    processRunner,
    environment: process.env,
    uid: process.getuid?.() ?? 0,
  });

  const writeBeadsRedirect = (runCwd: string, worktreeCwd: string) =>
    Effect.gen(function* () {
      const beadsDirectory = path.join(runCwd, ".beads");
      const canonicalBeads = yield* fileSystem
        .realPath(beadsDirectory)
        .pipe(Effect.orElseSucceed(() => beadsDirectory));
      const redirect = yield* fileSystem.readFileString(path.join(canonicalBeads, "redirect")).pipe(
        Effect.map((contents) => contents.trim()),
        Effect.orElseSucceed(() => ""),
      );
      const targetBeads =
        redirect.length === 0
          ? canonicalBeads
          : path.isAbsolute(redirect)
            ? redirect
            : path.resolve(runCwd, redirect);
      const resolved = yield* fileSystem
        .realPath(targetBeads)
        .pipe(Effect.orElseSucceed(() => targetBeads));
      const worktreeBeads = path.join(worktreeCwd, ".beads");
      yield* fileSystem.makeDirectory(worktreeBeads, { recursive: true });
      yield* fileSystem.writeFileString(
        path.join(worktreeBeads, "redirect"),
        path.relative(worktreeCwd, resolved),
      );
    });

  const drain: MergeDrainShape["drain"] = Effect.fn("EpicRunner.drainQueuedBranches")(
    function* (runCtx) {
      const run = yield* store.getRun({ runId: runCtx.runId }).pipe(
        Effect.mapError(storeError("getRun")),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new EpicRunnerStoreError({
                  operation: `merge drain run not found: ${runCtx.runId}`,
                }),
              ),
            onSome: Effect.succeed,
          }),
        ),
      );
      if (run.config.execution.sequential) return { _tag: "idle" } as const;
      // The drain's `setup_worktree` mapping: the main integration worktree
      // gets the beads redirect plus assets; a SIBLING integration worktree
      // gets assets only, sourced from its own checkout — siblings have no
      // beads database (`skills/cook-epic/run-legacy.sh:1007-1011,3110-3112`).
      const mergeState = yield* store.getMergeState({ runId: run.runId }).pipe(
        Effect.map(Option.getOrNull),
        Effect.catchCause((cause) =>
          Effect.logWarning("epic.runner.merge-state-read-failed", {
            runId: run.runId,
            cause,
          }).pipe(Effect.as(null)),
        ),
      );
      const siblingAssetSources = new Map(
        (mergeState?.siblings ?? []).map((sibling) => [
          sibling.integrationWorktreePath,
          sibling.repositoryPath,
        ]),
      );
      const restoreIntegrationWorktreeAssets = (cwd: string) =>
        Effect.gen(function* () {
          const siblingSource =
            mergeState !== null && cwd !== mergeState.integrationWorktreePath
              ? siblingAssetSources.get(cwd)
              : undefined;
          if (siblingSource === undefined) {
            yield* writeBeadsRedirect(run.cwd, cwd);
          }
          yield* setupWorktreeAssets({ fileSystem, path }, siblingSource ?? run.cwd, cwd);
        }).pipe(
          Effect.mapError(
            (cause) =>
              new MergeQueuePortError({
                operation: "setupWorktree",
                detail: `Could not restore integration worktree assets in ${cwd}`,
                cause,
              }),
          ),
        );
      const git = makeEpicRunMergeGit({
        git: gitVcsDriver,
        setupWorktree: restoreIntegrationWorktreeAssets,
      });
      // The merge slot is a bd coordination primitive nothing else creates.
      // Without it every acquire fails and the drain defers forever, which
      // reads as a healthy run: the lock keeps heartbeating and no worker is
      // alive to look wrong. Terminal parity: TerminalMergeDrain does the
      // same. Create is idempotent and best-effort — a real contention
      // failure still defers the drain.
      yield* processRunner
        .run({ command: "bd", args: ["merge-slot", "create"], cwd: run.cwd })
        .pipe(Effect.ignore);
      const result = yield* drainMergeQueue(
        {
          runId: run.runId,
          epicId: run.epicId,
          holder: mergeSlotHolder(run.runId),
          gateCommand: run.config.gate.disabled ? null : run.config.gate.command,
          pushEnabled: !run.config.vcs.noPush,
          verified: !run.config.gate.disabled,
          maxGateOutputBytes: 1024 * 1024,
        },
        {
          store: mergeQueueStore,
          git,
          slot: makeProcessMergeSlot({ repositoryPath: run.cwd, processRunner }),
          gate: mergeGate,
          repair: mergeRepair,
          backlog: makeProcessBacklog({ repositoryPath: run.cwd, processRunner }),
          events: {
            emit: (event) =>
              Effect.logInfo(`epic.runner.merge-${event.event}`, {
                runId: run.runId,
                ...event,
              }).pipe(Effect.asVoid),
          },
          fold: {
            run: (childId) =>
              Effect.logDebug("epic.runner.merge-fold-hook", {
                runId: run.runId,
                childId,
              }).pipe(Effect.asVoid),
          },
        },
      ).pipe(
        Effect.mapError(
          (cause) =>
            new EpicRunnerDispatchError({
              commandType: "git.merge-queue",
              detail: cause.message,
              cause,
            }),
        ),
      );
      // The loop consumes a narrow view; the queue-length telemetry stays here.
      if (result._tag === "fatal" && "detail" in result) {
        return { _tag: "fatal", detail: result.detail } as const;
      }
      if (result._tag === "deferred") {
        return { _tag: "deferred", holder: result.holder } as const;
      }
      if (result._tag === "drained") {
        return {
          _tag: "drained",
          ...(result.blocked === undefined ? {} : { blocked: result.blocked }),
        } as const;
      }
      return { _tag: "idle" } as const;
    },
  );

  return {
    drain,
    enqueueMerge: (input) =>
      store.enqueueMerge(input).pipe(Effect.mapError(journalError("enqueueMerge"))),
    findParkedOriginalChild: (input) =>
      store
        .findParkedOriginalChild(input)
        .pipe(Effect.mapError(journalError("findParkedOriginalChild"))),
    recordIntegratedHead: (runCtx) =>
      Effect.gen(function* () {
        const state = Option.getOrThrow(
          yield* store
            .getMergeState({ runId: runCtx.runId })
            .pipe(Effect.mapError(storeError("getMergeState"))),
        );
        const head = yield* makeEpicRunMergeGit({
          git: gitVcsDriver,
          setupWorktree: () => Effect.void,
        })
          .head(state.repositoryPath, state.baseBranch)
          .pipe(
            Effect.mapError(
              (cause) =>
                new EpicRunnerDispatchError({
                  commandType: "git.integration-resync",
                  detail: cause.message,
                  cause,
                }),
            ),
          );
        yield* store
          .advanceMergeIntegration({ runId: runCtx.runId, lastAcceptedHead: head })
          .pipe(Effect.mapError(storeError("advanceMergeIntegration")));
      }),
  };
};

/** Preserve the pre-extraction dispatch error's persisted message shape. */
const dispatchErrorFromRunner = (error: EpicRunnerDispatchError) =>
  // The loop renders DispatchError as `${operation}: ${detail}`; with the
  // runner's message prefix as the operation the persisted summary is
  // character-identical to the pre-extraction `error.message`.
  new DispatchError({
    operation: `Epic runner failed to dispatch ${error.commandType}`,
    detail: error.detail,
    cause: error,
  });

/**
 * The two-phase pool dispatch adapter: orchestration thread creation, worktree
 * setup, provider turn start, settle polling, grace continuations, and the
 * guarded session release. All behaviour is ported from the pre-extraction
 * runner, including the documented rationale for projection polling over
 * `streamDomainEvents`.
 */
export const makeServerPoolDispatch = (deps: {
  readonly engine: OrchestrationEngineService["Service"];
  readonly projectionSnapshotQuery: ProjectionSnapshotQuery["Service"];
  readonly processRunner: ProcessRunner.ProcessRunner["Service"];
  readonly projectSetupScriptRunner: ProjectSetupScriptRunner["Service"];
  readonly crypto: Crypto.Crypto;
  readonly workerScopeRegistry: EpicWorkerScopeRegistry["Service"];
}): PoolDispatchShape => {
  const {
    engine,
    projectionSnapshotQuery,
    processRunner,
    projectSetupScriptRunner,
    crypto,
    workerScopeRegistry,
  } = deps;
  const vcs = makeProcessPoolVcs(processRunner);

  const commandId = (tag: string) =>
    crypto.randomUUIDv4.pipe(
      Effect.map((uuid) => CommandId.make(`server:epic-run-${tag}:${uuid}`)),
      Effect.orDie,
    );

  const dispatchCommand = (command: Parameters<typeof engine.dispatch>[0]) =>
    engine.dispatch(command).pipe(
      Effect.asVoid,
      Effect.mapError(
        (cause) =>
          new EpicRunnerDispatchError({
            commandType: command.type,
            detail: cause.message,
            cause,
          }),
      ),
    );

  /** Dispatch something the loop can survive losing (interrupts, session stops). */
  const dispatchBestEffort = (
    label: string,
    command: Parameters<typeof engine.dispatch>[0],
  ): Effect.Effect<void> =>
    // `catchCause` already recovers every cause, defects included.
    dispatchCommand(command).pipe(
      Effect.catchCause((cause) => Effect.logWarning(label, { cause })),
    );

  const { readThreadDetail, awaitTurnEnd, readSettledFinalMessage } = makeThreadSettleWatch({
    projectionSnapshotQuery,
    logPrefix: "epic.runner",
  });

  /**
   * Wait for the thread to have no FRESH running subagents, bounded by
   * `subagentGraceTimeoutMs`. Polls the detail snapshot rather than the
   * shell's `activeSubagentCount` because staleness matters: that count
   * includes rows stranded at `running`, which the settle decider ignores —
   * waiting on them would burn the whole bound for work that no longer
   * exists. Returns whether the drain completed inside the bound.
   */
  const awaitSubagentDrain = (threadId: ThreadId, timings: PoolTimings) =>
    Effect.gen(function* () {
      while (true) {
        const snapshot = yield* readThreadDetail(threadId);
        const subagents = snapshot?.thread.subagents ?? [];
        const nowMs = Date.parse(yield* nowIso);
        if (countFreshRunningSubagents(subagents, nowMs) === 0) {
          return;
        }
        yield* Effect.sleep(Duration.millis(timings.pollIntervalMs));
      }
    }).pipe(
      Effect.timeoutOption(Duration.millis(timings.subagentGraceTimeoutMs)),
      Effect.map(Option.isSome),
    );

  /**
   * The grace path for an agent that ended its turn while its subagents were
   * still working — the exact incident shape this exists for: the SDK
   * reports a legitimate turn end, the runner would classify no-commit and
   * settle, and the settle would tear down the session and kill the
   * subagents' in-flight work.
   *
   * Runs only after a normally-settled turn with no commit. Fresh running
   * subagents first drain within a bound, then earn a continuation. A turn
   * without fresh subagents also earns one when it omitted the RALPH protocol
   * and changed the worktree since the last continuation decision. Both paths
   * share one continuation budget and message-id sequence. The iteration's
   * outer timeout bounds the complete chain. Commits, failed turns, explicit
   * protocol outcomes, unchanged worktrees, and drain timeouts fall through
   * to classification and guarded session cleanup.
   */
  const graceContinuationForSubagents = (input: {
    readonly runId: string;
    readonly iterationIndex: number;
    readonly threadId: ThreadId;
    readonly selection: Parameters<PoolDispatchShape["beginTurn"]>[0]["selection"];
    readonly runtimeMode: Parameters<PoolDispatchShape["beginTurn"]>[0]["runtimeMode"];
    readonly workspace: Parameters<PoolDispatchShape["beginTurn"]>[0]["workspace"];
    readonly headBefore: string | null;
    readonly branchBase: string | null;
    readonly initialWorktreeFingerprint: string | null;
    readonly timings: PoolTimings;
  }): Effect.Effect<void, DispatchError> =>
    Effect.gen(function* () {
      let continuationIndex = 0;
      let worktreeFingerprintBefore = input.initialWorktreeFingerprint;

      while (true) {
        const headMoved = yield* iterationCommitted({
          workspace: input.workspace,
          headBefore: input.headBefore,
          branchBase: input.branchBase,
        });
        if (headMoved) {
          const decision = decideGraceStep({
            headMoved,
            turnStatus: null,
            freshRunningCount: 0,
            fingerprintChanged: null,
            hasRalphToken: false,
            finalMessageMissing: false,
            finalMessageWaitExhausted: false,
            continuationsUsed: continuationIndex,
            maxGraceContinuations: input.timings.maxGraceContinuations,
          });
          if (decision.action === "settle") return;
        }

        const snapshot = yield* readThreadDetail(input.threadId);
        const thread = snapshot?.thread;
        const turnStatus = threadTurnState(thread);
        if (turnStatus !== "completed") {
          const decision = decideGraceStep({
            headMoved,
            turnStatus,
            freshRunningCount: 0,
            fingerprintChanged: null,
            hasRalphToken: false,
            finalMessageMissing: false,
            finalMessageWaitExhausted: false,
            continuationsUsed: continuationIndex,
            maxGraceContinuations: input.timings.maxGraceContinuations,
          });
          if (decision.action === "settle") return;
        }

        const freshRunning = countFreshRunningSubagents(
          thread?.subagents ?? [],
          Date.parse(yield* nowIso),
        );
        let worktreeFingerprintAfter: string | null = null;
        let fingerprintChanged: boolean | null = null;
        let finalMessageMissing = false;
        let finalMessageWaitExhausted = false;
        let hasRalphToken = false;
        if (freshRunning === 0) {
          worktreeFingerprintAfter = yield* vcs.worktreeFingerprint(input.workspace.cwd);
          fingerprintChanged =
            worktreeFingerprintBefore === null || worktreeFingerprintAfter === null
              ? null
              : worktreeFingerprintAfter !== worktreeFingerprintBefore;
          if (fingerprintChanged !== true) {
            const decision = decideGraceStep({
              headMoved,
              turnStatus,
              freshRunningCount: freshRunning,
              fingerprintChanged,
              hasRalphToken,
              finalMessageMissing,
              finalMessageWaitExhausted,
              continuationsUsed: continuationIndex,
              maxGraceContinuations: input.timings.maxGraceContinuations,
            });
            if (decision.action === "settle") return;
          }
          const finalMessage = yield* readSettledFinalMessage(input.threadId, input.timings);
          const finalAssistantMessage = resolveFinalAssistantMessage(finalMessage.snapshot?.thread);
          const text = finalAssistantMessage?.text ?? null;
          finalMessageMissing = text === null;
          finalMessageWaitExhausted = finalMessage.messageWaitExhausted;
          hasRalphToken =
            text !== null &&
            (hasRalphDone(text) || hasRalphBlocked(text) || parseRalphReport(text) !== null);
        }

        const decision = decideGraceStep({
          headMoved,
          turnStatus,
          freshRunningCount: freshRunning,
          fingerprintChanged,
          hasRalphToken,
          finalMessageMissing,
          finalMessageWaitExhausted,
          continuationsUsed: continuationIndex,
          maxGraceContinuations: input.timings.maxGraceContinuations,
        });
        if (decision.action === "settle") {
          if (decision.reason === "continuation-cap") {
            yield* Effect.logWarning("epic.runner.subagent-grace-cap", {
              runId: input.runId,
              iterationIndex: input.iterationIndex,
              threadId: input.threadId,
              continuationIndex,
            });
          }
          return;
        }

        const priorTurnId = thread?.latestTurn?.turnId ?? null;
        if (decision.action === "awaitDrain") {
          yield* Effect.logInfo("epic.runner.subagent-grace-started", {
            runId: input.runId,
            iterationIndex: input.iterationIndex,
            threadId: input.threadId,
            continuationIndex,
            freshRunning,
          });
          const drained = yield* awaitSubagentDrain(input.threadId, input.timings);
          if (!drained) {
            yield* Effect.logWarning("epic.runner.subagent-grace-timeout", {
              runId: input.runId,
              iterationIndex: input.iterationIndex,
              threadId: input.threadId,
              continuationIndex,
            });
            return;
          }
          worktreeFingerprintBefore = yield* vcs.worktreeFingerprint(input.workspace.cwd);
          yield* Effect.logInfo("epic.runner.subagent-grace-continuation", {
            runId: input.runId,
            iterationIndex: input.iterationIndex,
            threadId: input.threadId,
            continuationIndex: decision.nextContinuationCount,
          });
        } else {
          worktreeFingerprintBefore = worktreeFingerprintAfter;
          yield* Effect.logInfo("epic.runner.progress-continuation", {
            runId: input.runId,
            iterationIndex: input.iterationIndex,
            threadId: input.threadId,
            continuationIndex: decision.nextContinuationCount,
          });
        }

        continuationIndex = decision.nextContinuationCount;
        const createdAt = yield* nowIso;
        yield* dispatchCommand({
          type: "thread.turn.start",
          commandId: yield* commandId("turn-continue"),
          threadId: input.threadId,
          message: {
            // Every continuation needs its own message id. Otherwise a later
            // cycle replaces the earlier continuation in the projection.
            messageId: MessageId.make(
              continuationIndex === 1
                ? `${input.threadId}-continue`
                : `${input.threadId}-continue-${continuationIndex}`,
            ),
            role: "user",
            text: decision.prompt,
            attachments: [],
          },
          // The runner wrote this prompt, not the human. The timeline labels
          // an agent-authored `role: "user"` row so the two never blur.
          origin: "agent",
          modelSelection: input.selection,
          runtimeMode: input.runtimeMode,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          createdAt,
        }).pipe(Effect.mapError(dispatchErrorFromRunner));
        yield* awaitTurnEnd(input.threadId, input.timings, priorTurnId);
      }
    });

  const iterationCommitted = (args: {
    readonly workspace: Parameters<PoolDispatchShape["beginTurn"]>[0]["workspace"];
    readonly headBefore: string | null;
    readonly branchBase: string | null;
  }): Effect.Effect<boolean> =>
    Effect.gen(function* () {
      const headAfter = yield* vcs.headCommit(args.workspace.cwd);
      if (headAfter !== null && headAfter !== args.headBefore) return true;
      if (args.workspace.branch === null || args.branchBase === null) return false;
      const count = yield* vcs.commitsAhead({
        cwd: args.workspace.cwd,
        base: args.branchBase,
        branch: args.workspace.branch,
      });
      return count !== null && count > 0;
    });

  return {
    createIteration: (input) =>
      Effect.gen(function* () {
        // Bind the thread to its worker unit before the thread exists so the
        // provider session — started lazily on the first turn — already
        // resolves the scope. Same worker naming as the terminal dispatch.
        yield* workerScopeRegistry.bindWorker({
          runId: input.runId,
          threadId: input.threadId,
          worker: `iteration-${String(input.iterationIndex)}`,
        });
        yield* dispatchCommand({
          type: "thread.create",
          commandId: yield* commandId("thread-create"),
          threadId: input.threadId,
          projectId: input.projectId,
          title: input.title,
          modelSelection: input.selection,
          runtimeMode: input.runtimeMode,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          branch: input.branch,
          worktreePath: input.worktreePath,
          createdAt: input.startedAt,
        });
      }),

    prepareIteration: (input) =>
      input.branch === null || input.worktreePath === null
        ? Effect.void
        : projectSetupScriptRunner
            .runForThread({
              threadId: input.threadId,
              projectId: input.projectId,
              projectCwd: input.runCwd,
              worktreePath: input.worktreePath,
            })
            .pipe(
              Effect.catch((cause) =>
                Effect.logWarning("epic.runner.worktree-setup-failed", {
                  threadId: input.threadId,
                  worktreePath: input.worktreePath,
                  cause,
                }),
              ),
            ),

    beginTurn: (input) =>
      Effect.gen(function* () {
        yield* dispatchCommand({
          type: "thread.turn.start",
          commandId: yield* commandId("turn-start"),
          threadId: input.threadId,
          message: {
            messageId: MessageId.make(`${input.threadId}-prompt`),
            role: "user",
            text: input.prompt,
            attachments: [],
          },
          origin: "agent",
          modelSelection: input.selection,
          runtimeMode: input.runtimeMode,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          createdAt: yield* nowIso,
        });

        const awaitSettled: Effect.Effect<IterationSettle, DispatchError> = Effect.gen(
          function* () {
            yield* awaitTurnEnd(input.threadId, input.policy);
            yield* graceContinuationForSubagents({
              runId: input.runId,
              iterationIndex: input.iterationIndex,
              threadId: input.threadId,
              selection: input.selection,
              runtimeMode: input.runtimeMode,
              workspace: input.workspace,
              headBefore: input.headBefore,
              branchBase: input.branchBase,
              initialWorktreeFingerprint: input.initialWorktreeFingerprint,
              timings: input.policy,
            });
            const snapshot = yield* readThreadDetail(input.threadId);
            const turnState = threadTurnState(snapshot?.thread);
            return {
              turnState: turnState === "running" || turnState === null ? "completed" : turnState,
              timedOut: false,
              providerError: snapshot?.thread.session?.lastError ?? null,
            } satisfies IterationSettle;
          },
        );

        const handle: IterationHandle = {
          ref: input.threadId,
          capabilities: {
            terminalSignal: "projection",
            continuation: "same-thread",
            subagentLiveness: "native",
            finalMessage: "projection",
            providerErrors: "session-and-assistant",
            cost: "none",
          },
          awaitSettled,
          continueTurn: (prompt) =>
            Effect.gen(function* () {
              const continuationId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
              yield* dispatchCommand({
                type: "thread.turn.start",
                commandId: yield* commandId("turn-continue"),
                threadId: input.threadId,
                message: {
                  messageId: MessageId.make(`${input.threadId}-continue-${continuationId}`),
                  role: "user",
                  text: prompt,
                  attachments: [],
                },
                origin: "agent",
                modelSelection: input.selection,
                runtimeMode: input.runtimeMode,
                interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
                createdAt: yield* nowIso,
              }).pipe(Effect.mapError(dispatchErrorFromRunner));
            }),
          interrupt: Effect.gen(function* () {
            yield* dispatchBestEffort("epic.runner.interrupt-failed", {
              type: "thread.turn.interrupt",
              commandId: yield* commandId("turn-interrupt"),
              threadId: input.threadId,
              createdAt: yield* nowIso,
            });
          }),
          release: Effect.gen(function* () {
            yield* awaitSubagentDrain(input.threadId, input.policy);
            const normalStop = {
              type: "thread.session.stop",
              commandId: yield* commandId("session-stop"),
              threadId: input.threadId,
              createdAt: yield* nowIso,
              preserveRunningSubagents: true,
            } as const;
            yield* dispatchCommand(normalStop).pipe(
              Effect.catch((error) => {
                if (!isRunningSubagentLivenessRefusal(error.message)) {
                  return Effect.logWarning("epic.runner.session-stop-failed", { cause: error });
                }
                return Effect.gen(function* () {
                  yield* awaitSubagentDrain(input.threadId, input.policy);
                  yield* dispatchBestEffort("epic.runner.guarded-session-stop-retry-failed", {
                    ...normalStop,
                    commandId: yield* commandId("session-stop-retry"),
                  });
                });
              }),
            );
          }),
          runningSubagents: Effect.gen(function* () {
            const snapshot = yield* readThreadDetail(input.threadId);
            const nowMs = Date.parse(yield* nowIso);
            return {
              mode: "native" as const,
              running: countFreshRunningSubagents(snapshot?.thread.subagents ?? [], nowMs),
            };
          }),
          finalMessage: readSettledFinalMessage(input.threadId, input.policy).pipe(
            Effect.map((settled): FinalMessageRead => {
              const thread = settled.snapshot?.thread;
              const message = resolveFinalAssistantMessage(thread);
              const turnState = threadTurnState(thread);
              return {
                text: message?.text ?? null,
                streaming: message?.streaming ?? false,
                waitExhausted: settled.messageWaitExhausted,
                turnState: turnState === "running" ? null : turnState,
                sessionLastError: thread?.session?.lastError ?? null,
              };
            }),
          ),
        };
        return handle;
      }),

    stopAbandoned: (threadId) =>
      Effect.gen(function* () {
        yield* dispatchBestEffort("epic.runner.skipped-session-stop-failed", {
          type: "thread.session.stop",
          commandId: yield* commandId("skipped-session-stop"),
          threadId,
          createdAt: yield* nowIso,
        });
      }),

    stopForced: (threadId) =>
      Effect.gen(function* () {
        yield* dispatchBestEffort("epic.runner.session-stop-failed", {
          type: "thread.session.stop",
          commandId: yield* commandId("session-stop"),
          threadId,
          createdAt: yield* nowIso,
        });
      }),
  };
};

/**
 * Flip every iteration still recorded as `running` to `abandoned`, stopping
 * its thread first. Shared by cancellation, restart reconciliation, and the
 * loop-failure backstop.
 */
export const makeAbandonRunningIterations = (deps: {
  readonly store: EpicRunStore["Service"];
  readonly engine: OrchestrationEngineService["Service"];
  readonly crypto: Crypto.Crypto;
  readonly backlog: PoolBacklogShape;
}) => {
  const { store, engine, crypto, backlog } = deps;

  const commandId = (tag: string) =>
    crypto.randomUUIDv4.pipe(
      Effect.map((uuid) => CommandId.make(`server:epic-run-${tag}:${uuid}`)),
      Effect.orDie,
    );

  const dispatchBestEffort = (
    label: string,
    command: Parameters<typeof engine.dispatch>[0],
  ): Effect.Effect<void> =>
    engine.dispatch(command).pipe(
      Effect.asVoid,
      Effect.catchCause((cause) => Effect.logWarning(label, { cause })),
    );

  return Effect.fn("EpicRunner.abandonRunningIterations")(function* (
    runId: EpicRun["runId"],
    summary: string,
    failureReason: string,
    commandPrefix: string,
  ) {
    const run = yield* store.getRun({ runId }).pipe(
      Effect.mapError(storeError("getRun")),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(new EpicRunNotFoundError({ runId })),
          onSome: Effect.succeed,
        }),
      ),
    );
    const iterations = yield* store
      .listRunningIterations({ runId })
      .pipe(Effect.mapError(storeError("listRunningIterations")));
    for (const iteration of iterations) {
      const abandonedAt = yield* nowIso;
      if (iteration.issueId !== null) {
        yield* dispatchBestEffort(`epic.runner.${commandPrefix}-interrupt-failed`, {
          type: "thread.turn.interrupt",
          commandId: yield* commandId(`${commandPrefix}-interrupt`),
          threadId: iteration.threadId,
          createdAt: abandonedAt,
        });
        yield* dispatchBestEffort(`epic.runner.${commandPrefix}-session-stop-failed`, {
          type: "thread.session.stop",
          commandId: yield* commandId(`${commandPrefix}-session-stop`),
          threadId: iteration.threadId,
          createdAt: abandonedAt,
        });
      }
      yield* store
        .updateIteration({
          runId,
          iterationIndex: iteration.iterationIndex,
          turnStatus: "abandoned",
          summary,
          why: null,
          failureReason,
          finishedAt: abandonedAt,
        })
        .pipe(Effect.mapError(storeError("updateIteration")));
      if (iteration.issueId !== null) {
        yield* backlog.releaseClaimedChild(run.cwd, iteration.issueId);
      }
    }
  });
};

/**
 * The orientation card spliced into every iteration prompt. Candidate
 * resolution matches the terminal coordinator (`run-legacy.sh:1845-1858`): the
 * configured file, then `docs/agent-orientation.md`, then `AGENTS.md`.
 */
export const makeReadOrientation = (deps: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
}) => {
  const { fileSystem, path } = deps;
  return (checkoutPath: string, orientationFile: string | null): Effect.Effect<string | null> =>
    Effect.gen(function* () {
      const candidates =
        orientationFile === null ? ["docs/agent-orientation.md", "AGENTS.md"] : [orientationFile];
      for (const candidate of candidates) {
        const contents = yield* fileSystem
          .readFileString(path.join(checkoutPath, candidate))
          .pipe(Effect.option);
        if (Option.isSome(contents)) return contents.value;
      }
      return null;
    });
};
