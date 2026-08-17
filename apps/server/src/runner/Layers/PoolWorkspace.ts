/**
 * PoolWorkspace - Server adapters for the shared parallel epic loop.
 *
 * Every port the core `runParallelEpicLoop` (`@t3tools/epic-core/ParallelEpicLoop`)
 * consumes is bound here to the server's machinery: the orchestration engine
 * command path, the projection snapshot query, the durable run store, the `bd`
 * and `git` subprocess probes, and the worktree provisioner. The loop owns
 * policy; this module owns effects. Behaviour is ported verbatim from the
 * pre-extraction runner so the WS/HTTP surface, the persisted rows, and the
 * dispatch ordering do not change.
 *
 * @module PoolWorkspace
 */
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EpicRunId,
  MessageId,
  PROVIDER_SESSION_RESUME_SETTLED_ACTIVITY_KIND,
  PROVIDER_TURN_STEER_ATTRIBUTED_ACTIVITY_KIND,
  ProviderDriverKind,
  ProviderSessionResumeSettledActivityPayload,
  ThreadId,
  decodeProviderTurnSteerAttributedActivityPayload,
  type EpicSubagentMap,
  type ProviderSessionResumeOutcome,
  type TurnId,
} from "@t3tools/contracts";
import { EpicRunnerDispatchError, EpicRunnerStoreError } from "@t3tools/epic-core/Errors";
import type * as ProcessRunner from "@t3tools/epic-core/processRunner";
import { resolveRunBaseBranch } from "@t3tools/epic-core/runBaseBranch";
import { RERERE_CONFIG_ARGS } from "@t3tools/epic-core/rerere";
import type { PoolTimings } from "@t3tools/epic-core/ParallelEpicLoop";
import type { PoolDispatchShape } from "@t3tools/epic-core/ports/PoolDispatch";
import {
  type AgentDispatchCapabilities,
  type AgentSelection,
  DispatchError,
  type FinalMessageRead,
  type IterationHandle,
  type IterationSettle,
} from "@t3tools/epic-core/ports/AgentDispatch";
import type { WorkspaceShape } from "@t3tools/epic-core/ports/Workspace";

import {
  decideGraceStep,
  integrationBranch as integrationBranchName,
  parseIntegrationFixTitle,
  parseMergeFixTitle,
  runBaseBranch as runBaseBranchName,
} from "@t3tools/epic-core/policy";
import { hasRalphBlocked, hasRalphDone, parseRalphReport } from "@t3tools/epic-core/ralphProtocol";
import { makeProcessPoolVcs } from "@t3tools/epic-core/adapters/ProcessPoolVcs";
import {
  makeSiblingResolver,
  mirrorPath,
  siblingRuleLayout,
  siblingRuleSequential,
  type SiblingRef,
} from "@t3tools/epic-core/siblings";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

import type { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import type { EpicSubagentRegistry } from "../../provider/epicSubagents.ts";
import type { EpicCommitterRegistry } from "../../provider/epicCommitter.ts";
import type { EpicWorkerScopeRegistry } from "../../provider/workerScope.ts";
import { countFreshRunningSubagents } from "../../orchestration/subagentLiveness.ts";
import {
  makeThreadSettleWatch,
  resolveFinalAssistantMessage,
  resolveTurnAssistantMessage,
  threadTurnState,
  type SettledTurn,
} from "../../orchestration/ThreadSettleWatch.ts";
import type { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { EpicRunStore, type EpicRun } from "../../persistence/Services/EpicRuns.ts";
import type { ServerConfig } from "../../config.ts";
import type { ProjectSetupScriptRunner } from "../../project/ProjectSetupScriptRunner.ts";
import type { WorktreeProvisioner } from "../../vcs/WorktreeProvisioner.ts";
import type { GitVcsDriver } from "../../vcs/GitVcsDriver.ts";
import { makeEpicRunMergeGit } from "../EpicRunMergeGit.ts";
import { nowIso, storeError } from "./poolPortErrors.ts";
import { setupWorktreeAssets, writeBeadsRedirect } from "./poolWorktreeAssets.ts";

const GIT_HEAD_TIMEOUT_MS = 15_000;

/**
 * How long to wait for a resume request to settle before calling it an infra
 * fault. The handler answers in one provider session start, so anything past
 * this is the reactor not running, not a slow provider.
 */
const RESUME_SETTLE_TIMEOUT_MS = 120_000;

/**
 * How often a forced stop re-reads the turn it is waiting on inside the run's
 * stop grace. Short enough that a turn closing early costs almost nothing, and
 * the whole wait is bounded by the grace regardless.
 */
const FORCED_STOP_POLL_INTERVAL_MS = 250;

const decodeResumeSettledActivity = Schema.decodeUnknownOption(
  ProviderSessionResumeSettledActivityPayload,
);
/**
 * How many projection reads a nudge waits for its steer attribution.
 *
 * The activity is written when the provider answers the send, so this is
 * provider latency, not projection lag. Ten reads at the run's quiet period is
 * ten seconds by default — long enough that a slow steer still counts as
 * absorbed, short enough that a driver which never steers is written off
 * inside one radar tick.
 */
const NUDGE_ABSORPTION_READS = 10;

/** The one driver whose adapter passes injected subagent definitions through. */
const CLAUDE_SUBAGENT_DRIVER = ProviderDriverKind.make("claudeAgent");

const isEpicRunnerDispatchError = Schema.is(EpicRunnerDispatchError);

/**
 * The durable gate-receipt journal behind the merge drain's evidence port.
 *
 * Append-only by construction: the store allocates the sequence and nothing
 * updates a row, so a restart reads back exactly what every earlier lifetime
 * of the run recorded.
 */
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

  /**
   * Turn on git rerere for one repository a parallel run is about to touch.
   *
   * Idempotent, and never fails the provisioning it runs inside: rerere only
   * makes repeated conflicts cheaper, so a repository whose config git declines
   * to write still runs — the trial merge carries the same settings as `-c`
   * flags anyway (`@t3tools/epic-core/rerere`). Terminal twin:
   * `TerminalPoolWorkspace.enableRerere`.
   */
  const enableRerere = (repositoryPath: string) =>
    Effect.forEach(
      RERERE_CONFIG_ARGS,
      (args) =>
        processRunner
          .run({
            command: "git",
            args,
            cwd: repositoryPath,
            timeout: Duration.millis(GIT_HEAD_TIMEOUT_MS),
          })
          .pipe(
            Effect.flatMap((output) =>
              output.code === 0
                ? Effect.void
                : Effect.logWarning("epic.runner.rerere-config-failed", {
                    repositoryPath,
                    detail: output.stderr.trim(),
                  }),
            ),
            Effect.catchCause((cause) =>
              Effect.logWarning("epic.runner.rerere-config-failed", { repositoryPath, cause }),
            ),
          ),
      { discard: true },
    );

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

  const writeRunBeadsRedirect = writeBeadsRedirect({ fileSystem, path });

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
  const runSiblings = Effect.fn("PoolWorkspace.runSiblings")(function* (run: EpicRun) {
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
        // The cache lives in the repository's common git directory, so one
        // write here covers the integration worktree and every worker worktree
        // this run cuts from the same repository. When the run shares the
        // operator's checkout, `run.cwd` IS the operator's repository and the
        // config lands there.
        yield* enableRerere(run.cwd);
        yield* writeRunBeadsRedirect(run.cwd, provisioned.path).pipe(
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
          // A sibling is its own repository with its own rr-cache.
          yield* enableRerere(sibling.canonicalPath);
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
            yield* writeRunBeadsRedirect(run.cwd, main.path).pipe(
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
          yield* writeRunBeadsRedirect(runCtx.cwd, provisioned.path).pipe(
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

    /**
     * Rebuild the workspace record of an iteration that is already
     * provisioned. Same sibling derivation as `acquire`; the main path and
     * branch come from the caller, because a merge-fix child works a parked
     * branch whose name `epic/<issueId>` would not reproduce.
     *
     * A worktree missing from disk or from `git worktree list` is a refusal,
     * not a run failure: the caller starts that child fresh instead.
     */
    adopt: (runCtx, input) =>
      Effect.gen(function* () {
        const run = yield* requireRun(runCtx.runId);
        if (input.sequential) {
          const siblings = yield* runSiblings(run);
          return {
            cwd: input.worktreePath ?? run.cwd,
            branch: null,
            worktreePath: input.worktreePath,
            siblingWorktrees: siblings.map((sibling) => ({
              worktreePath: sibling.canonicalPath,
              sourcePath: sibling.canonicalPath,
              baseBranch: sibling.baseBranch,
            })),
            siblingRule: siblings.length === 0 ? null : siblingRuleSequential({ siblings }),
          };
        }
        const worktreePath = input.worktreePath;
        if (worktreePath === null) {
          return yield* new EpicRunnerDispatchError({
            commandType: "git.worktree-adopt",
            detail: `Parallel iteration for ${input.issueId} recorded no worktree to adopt`,
          });
        }
        const onDisk = yield* fileSystem.exists(worktreePath).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("epic.runner.worktree-adopt-probe-failed", {
              runId: runCtx.runId,
              worktreePath,
              cause,
            }).pipe(Effect.as(false)),
          ),
        );
        if (!onDisk) {
          return yield* new EpicRunnerDispatchError({
            commandType: "git.worktree-adopt",
            detail: `Worktree ${worktreePath} is gone`,
          });
        }
        const registered = yield* processRunner
          .run({
            command: "git",
            args: ["-C", run.cwd, "worktree", "list", "--porcelain"],
            cwd: run.cwd,
            timeout: Duration.millis(GIT_HEAD_TIMEOUT_MS),
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new EpicRunnerDispatchError({
                  commandType: "git.worktree-adopt",
                  detail: `Could not list the worktrees of ${run.cwd}`,
                  cause,
                }),
            ),
          );
        if (
          registered.code !== 0 ||
          !registered.stdout.split(/\r?\n/).includes(`worktree ${worktreePath}`)
        ) {
          return yield* new EpicRunnerDispatchError({
            commandType: "git.worktree-adopt",
            detail: `Worktree ${worktreePath} is not registered with ${run.cwd}`,
          });
        }
        const siblings = yield* runSiblings(run);
        if (siblings.length === 0) {
          return {
            cwd: worktreePath,
            branch: input.branch,
            worktreePath,
            siblingWorktrees: [],
            siblingRule: null,
          };
        }
        // A layout mirrors the siblings' real relative positions around the
        // main worktree, so both the layout root and the repo basename are
        // readable off the path `acquire` built.
        const layout = path.dirname(worktreePath);
        const repoBasename = path.basename(worktreePath);
        return {
          cwd: worktreePath,
          branch: input.branch,
          worktreePath,
          siblingWorktrees: siblings.map((sibling) => ({
            worktreePath: mirrorPath(layout, repoBasename, sibling.relativePath),
            sourcePath: sibling.canonicalPath,
            baseBranch: sibling.baseBranch,
          })),
          siblingRule:
            input.branch === null
              ? null
              : siblingRuleLayout({
                  layoutRoot: layoutRoot(runCtx.runId),
                  layout,
                  repoBasename,
                  branch: input.branch,
                  siblings,
                }),
        };
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
