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
  EpicRunId,
  MessageId,
  PROVIDER_SESSION_RESUME_SETTLED_ACTIVITY_KIND,
  PROVIDER_TURN_STEER_ATTRIBUTED_ACTIVITY_KIND,
  ProviderDriverKind,
  ProviderSessionResumeSettledActivityPayload,
  ThreadId,
  decodeProviderTurnSteerAttributedActivityPayload,
  type EpicRun as TransportEpicRun,
  type EpicSubagentMap,
  type ProviderSessionResumeOutcome,
  type TurnId,
} from "@t3tools/contracts";
import {
  EpicRunnerDispatchError,
  EpicRunnerStoreError,
  EpicRunNotFoundError,
} from "@t3tools/epic-core/Errors";
import type * as ProcessRunner from "@t3tools/epic-core/processRunner";
import { resolveRunBaseBranch } from "@t3tools/epic-core/runBaseBranch";
import { RERERE_CONFIG_ARGS } from "@t3tools/epic-core/rerere";
import type {
  MergeDrainShape,
  PoolBacklogShape,
  PoolRunEventsShape,
  PoolRunJournalShape,
  PoolTimings,
} from "@t3tools/epic-core/ParallelEpicLoop";
import type { PoolDispatchShape } from "@t3tools/epic-core/ports/PoolDispatch";
import {
  type AgentDispatchCapabilities,
  type AgentSelection,
  DispatchError,
  type FinalMessageRead,
  type IterationHandle,
  type IterationSettle,
} from "@t3tools/epic-core/ports/AgentDispatch";
import {
  type PersistedEpicRun,
  type PersistedEpicRunIteration,
} from "@t3tools/epic-core/ports/RunJournal";
import type { WorkspaceShape } from "@t3tools/epic-core/ports/Workspace";

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
import { GateError } from "@t3tools/epic-core/ports/Gate";
import type {
  GateReceiptJournalShape,
  PersistedGateReceipt,
} from "@t3tools/epic-core/ports/GateReceipts";
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
import * as PubSub from "effect/PubSub";
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
import {
  EpicRunStore,
  type EpicRun,
  type EpicRunIteration as EpicRunIterationRow,
} from "../../persistence/Services/EpicRuns.ts";
import type { ServerConfig } from "../../config.ts";
import type { ProjectSetupScriptRunner } from "../../project/ProjectSetupScriptRunner.ts";
import type { WorktreeProvisioner } from "../../vcs/WorktreeProvisioner.ts";
import type { GitVcsDriver } from "../../vcs/GitVcsDriver.ts";
import { makeEpicRunMergeQueueStore } from "../EpicRunMergeQueueStore.ts";
import { makeEpicRunMergeGit } from "../EpicRunMergeGit.ts";
import { journalError, nowIso, storeError } from "./poolPortErrors.ts";
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
const RECENT_ITERATIONS_LIMIT = 25;

/** The one driver whose adapter passes injected subagent definitions through. */
const CLAUDE_SUBAGENT_DRIVER = ProviderDriverKind.make("claudeAgent");

const isEpicRunnerDispatchError = Schema.is(EpicRunnerDispatchError);

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
    resumeCount: iteration.resumeCount ?? 0,
    lastResumedAt: iteration.lastResumedAt ?? null,
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
 * Lifecycle writes persist in `EpicRunner.ts`, then call `publishRunChange`.
 * The loop's journal writes through {@link makeServerPoolJournal} and publishes
 * through the `events` port, so both paths land on the same PubSub.
 */
export const makeEpicRunReadModel = (deps: {
  readonly store: EpicRunStore["Service"];
  readonly changes: PubSub.PubSub<TransportEpicRun>;
}) => {
  const { store, changes } = deps;

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

  /** Enrich and fan out a persisted run row. Never re-writes the store. */
  const publishRunChange = (run: EpicRun) =>
    enrichRun(run).pipe(
      Effect.flatMap((enriched) => PubSub.publish(changes, enriched)),
      Effect.asVoid,
    );

  const events: PoolRunEventsShape = {
    // Iteration changes reach the UI through the next run publish, exactly as
    // they did before the rewire; only run rows fan out to the PubSub.
    publish: (event) =>
      event.type === "run-state-changed" ? publishRunChange(event.run) : Effect.void,
  };

  return { enrichRun, enrichRuns, publishRunChange, events };
};

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
    // A fresh row has measured nothing yet. The store spells that `null`; the
    // port spells it "key absent". They mean the same thing, so translate.
    return store
      .appendIteration({
        ...row,
        phaseTimings: row.phaseTimings ?? null,
        promptBytes: row.promptBytes ?? null,
      })
      .pipe(Effect.mapError(journalError("appendIteration")));
  },
  allocateIteration: (input) =>
    store.allocateIteration(input).pipe(Effect.mapError(journalError("allocateIteration"))),
  updateIteration: (input) => {
    const { headBefore: _headBefore, headAfter: _headAfter, ...row } = input;
    // An absent measurement is `null` here, which the store reads as "leave
    // the stored value alone" — an abandon flip must not erase what the
    // settle before it measured.
    return store
      .updateIteration({
        ...row,
        phaseTimings: row.phaseTimings ?? null,
        promptBytes: row.promptBytes ?? null,
      })
      .pipe(Effect.mapError(journalError("updateIteration")));
  },
  markIterationResumed: (input) =>
    store.reopenIteration(input).pipe(Effect.mapError(journalError("markIterationResumed"))),
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

/**
 * The durable gate-receipt journal behind the merge drain's evidence port.
 *
 * Append-only by construction: the store allocates the sequence and nothing
 * updates a row, so a restart reads back exactly what every earlier lifetime
 * of the run recorded.
 */
export const makeServerGateReceipts = (
  store: EpicRunStore["Service"],
): GateReceiptJournalShape => ({
  record: (receipt) =>
    store
      .recordGateReceipt({
        ...receipt,
        runId: EpicRunId.make(receipt.runId),
        inputHeads: receipt.inputHeads,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new GateError({
              operation: "gateReceipts.record",
              detail: cause.message,
              cause,
            }),
        ),
      ),
  list: (runId) =>
    store.listGateReceipts({ runId: EpicRunId.make(runId) }).pipe(
      Effect.map((rows): ReadonlyArray<PersistedGateReceipt> => rows),
      Effect.mapError(
        (cause) => new GateError({ operation: "gateReceipts.list", detail: cause.message, cause }),
      ),
    ),
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

  const writeDrainBeadsRedirect = writeBeadsRedirect({ fileSystem, path });

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
            yield* writeDrainBeadsRedirect(run.cwd, cwd);
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
      // A red gate's bounded output can hide the real failure (t3code-9hv),
      // and the one-line diagnosis is all that used to survive a drain.
      // Persist the full output of every failed gate under the run's git dir
      // — never inside the integration worktree, which MergeQueue resets and
      // cleans after a failed gate — and hand the path to the diagnosis.
      // Best-effort: a write failure must not mask the gate result itself.
      let gateLogSequence = 0;
      const mergeGateWithLog: typeof mergeGate = {
        run: (gateInput) =>
          mergeGate.run(gateInput).pipe(
            Effect.flatMap((result) => {
              if (result.passed) return Effect.succeed(result);
              gateLogSequence += 1;
              const sequence = gateLogSequence;
              return Effect.flatMap(DateTime.now, (now) => {
                const logPath = path.join(
                  run.cwd,
                  ".git",
                  "t3code",
                  "epic-runs",
                  run.runId,
                  `gate-${String(DateTime.toEpochMillis(now))}-${String(sequence)}.log`,
                );
                return fileSystem.makeDirectory(path.dirname(logPath), { recursive: true }).pipe(
                  Effect.andThen(fileSystem.writeFileString(logPath, result.output)),
                  Effect.map(() => ({ ...result, outputPath: logPath })),
                  Effect.catchCause((cause) =>
                    Effect.logWarning("epic.runner.gate-log-persist-failed", {
                      runId: run.runId,
                      cause,
                    }).pipe(Effect.as(result)),
                  ),
                );
              });
            }),
          ),
      };
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
          gate: mergeGateWithLog,
          gateReceipts: makeServerGateReceipts(store),
          repair: mergeRepair,
          backlog: makeProcessBacklog({ repositoryPath: run.cwd, processRunner }),
          // The same journal the loop writes its `RALPH_MSG` clauses into, so
          // a merge-fix child quotes what each author actually reported.
          iterations: makeServerPoolJournal(store),
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
    integrationTarget: (runCtx) =>
      store.getMergeState({ runId: runCtx.runId }).pipe(
        Effect.map((state) =>
          Option.match(state, {
            onNone: () => null,
            onSome: (merge) => ({
              repositoryPath: merge.repositoryPath,
              baseBranch: merge.baseBranch,
              operatorBaseBranch: merge.operatorBaseBranch,
            }),
          }),
        ),
        Effect.catchCause(() => Effect.succeed(null)),
      ),
    unlandedEntries: (runCtx) =>
      store.getMergeState({ runId: runCtx.runId }).pipe(
        Effect.map((state) =>
          Option.match(state, {
            onNone: () => [],
            onSome: (merge) =>
              merge.entries.map((entry) => ({
                childId: entry.childId,
                branch: entry.branch,
                status: entry.status,
              })),
          }),
        ),
        // An unreadable store answers `null`, not `[]` (t3code-e46): the
        // loop's completion proof must not read "unlanded unknown" as
        // "nothing unlanded".
        Effect.catchCause(() => Effect.succeed(null)),
      ),
    recordIntegratedHead: (runCtx) =>
      Effect.gen(function* () {
        const state = Option.getOrThrow(
          yield* store
            .getMergeState({ runId: runCtx.runId })
            .pipe(Effect.mapError(storeError("getMergeState"))),
        );
        const mergeGit = makeEpicRunMergeGit({
          git: gitVcsDriver,
          setupWorktree: () => Effect.void,
        });
        const head = yield* mergeGit.head(state.repositoryPath, state.baseBranch).pipe(
          Effect.mapError(
            (cause) =>
              new EpicRunnerDispatchError({
                commandType: "git.integration-resync",
                detail: cause.message,
                cause,
              }),
          ),
        );
        // Siblings too: an integration-fix or in-place iteration can commit in
        // the real sibling checkouts, and the next drain compares each
        // sibling's live head against the accepted one.
        const siblingHeads = yield* Effect.forEach(
          state.siblings,
          (sibling) =>
            mergeGit.head(sibling.repositoryPath).pipe(
              Effect.map((siblingHead) => ({
                repositoryPath: sibling.repositoryPath,
                lastAcceptedHead: siblingHead,
              })),
            ),
          { concurrency: 1 },
        ).pipe(
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
          .advanceMergeIntegration({
            runId: runCtx.runId,
            lastAcceptedHead: head,
            ...(siblingHeads.length > 0 ? { siblingHeads } : {}),
          })
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
 * What the server dispatch can do, stated once for both the dispatch shape and
 * every handle it hands back.
 *
 * `lifecycle.resume` is `adopt-ref`: an iteration's ref is its orchestration
 * thread id, which outlives the process in the durable store, so a restart can
 * ask the same thread to carry on. Whether a given thread's provider session
 * really continued is a per-iteration answer the resume operation checks; this
 * only says the adapter can try.
 */
const serverDispatchCapabilities: AgentDispatchCapabilities = {
  terminalSignal: "projection",
  continuation: "same-thread",
  subagentLiveness: "native",
  finalMessage: "projection",
  providerErrors: "session-and-assistant",
  cost: "none",
  lifecycle: { resume: "adopt-ref" },
};

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
  readonly subagentRegistry: EpicSubagentRegistry["Service"];
  /**
   * The run-scoped git committer identity registry (t3code-e6l). Absent
   * skips binding entirely — a worker's commits then carry the operator's
   * identity, so an in-place iteration earns no commit credit from
   * `iterationCommitted`'s identity check and must close with bead
   * evidence. Construction stays fail-soft the same way an absent
   * `readSessionDriverKind` does.
   */
  readonly committerRegistry?: EpicCommitterRegistry["Service"];
  /**
   * The role subagents this run's worker sessions carry, read once per
   * iteration thread so a policy or usage change lands on the next iteration.
   * Takes the session's own selection, because a subagent runs inside that
   * session and cannot use another provider's model. Never fails: an empty
   * map means "inject nothing".
   */
  readonly readIterationSubagents: (
    sessionSelection: AgentSelection,
  ) => Effect.Effect<EpicSubagentMap>;
  /**
   * The driver the session's own account runs, or `null` when the account is
   * unknown. Only used to say so when a bound map cannot reach the harness.
   * Never fails, and an absent reader simply logs nothing.
   */
  readonly readSessionDriverKind?: (
    sessionSelection: AgentSelection,
  ) => Effect.Effect<ProviderDriverKind | null>;
  readonly ownedIterationTurnIds?: Map<ThreadId, TurnId>;
}): PoolDispatchShape => {
  const {
    engine,
    projectionSnapshotQuery,
    processRunner,
    projectSetupScriptRunner,
    crypto,
    workerScopeRegistry,
    subagentRegistry,
    committerRegistry,
    readIterationSubagents,
  } = deps;
  const readSessionDriverKind = deps.readSessionDriverKind ?? (() => Effect.succeed(null));
  const ownedIterationTurnIds = deps.ownedIterationTurnIds ?? new Map<ThreadId, TurnId>();
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

  /**
   * Bind one iteration thread to the role subagents its worker session gets.
   *
   * Bound before the thread exists, for the same reason the worker scope is:
   * the provider session starts lazily on the first turn and resolves the
   * binding then. An empty map binds nothing, so a server with no in-session
   * roles configured leaves the harness's own agents untouched.
   *
   * The binding still happens on every driver, but only the Claude adapter
   * reads `ProviderSessionStartInput.subagents`; every other adapter drops the
   * map without a word. That silence is the whole reason for the log below: a
   * worker on Codex or Kimi runs with the harness's own agents, and the run
   * looks identical from the outside.
   */
  const bindIterationSubagents = (
    runId: EpicRunId,
    threadId: ThreadId,
    sessionSelection: AgentSelection,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      const subagents = yield* readIterationSubagents(sessionSelection);
      if (Object.keys(subagents).length === 0) return;
      const driver = yield* readSessionDriverKind(sessionSelection);
      // An unknown account says nothing either way, so it stays quiet.
      if (driver !== null && driver !== CLAUDE_SUBAGENT_DRIVER) {
        yield* Effect.logInfo("epic.runner.subagents-unsupported-harness", {
          threadId,
          driver,
          instanceId: sessionSelection.instanceId,
          subagents: Object.keys(subagents),
          detail:
            "Injected stage agents reach Claude sessions only; this worker keeps the harness's own agents.",
        });
      }
      yield* subagentRegistry.bindThread({ runId, threadId, subagents });
    });

  /**
   * Bind one iteration thread to the run whose git committer identity its
   * worker's commits should carry (t3code-e6l). Bound before the thread
   * exists, the same way the subagent map is, and unconditionally — unlike
   * subagents, every driver can carry env, so there is no harness this skips.
   */
  const bindIterationCommitter = (runId: EpicRunId, threadId: ThreadId): Effect.Effect<void> =>
    committerRegistry === undefined
      ? Effect.void
      : committerRegistry.bindThread({ runId, threadId });

  const { readThreadDetail, awaitTurnEnd, readSettledFinalMessage } = makeThreadSettleWatch({
    projectionSnapshotQuery,
    logPrefix: "epic.runner",
  });

  /**
   * Wait for the `thread.session.resume` this call dispatched to settle.
   *
   * The resume answer travels as a durable activity rather than as the
   * dispatch's own result: the handler runs in the reactor, long after
   * `dispatch` returns. Polling the projection is the same trade
   * `awaitTurnEnd` documents — a subscription cannot be proved live before
   * the dispatch, while a projection read cannot miss a committed answer.
   *
   * Matching on `requestCommandId` is what keeps an earlier resume's outcome
   * from answering this one on a thread that has been resumed before.
   */
  const awaitResumeOutcome = (input: {
    readonly threadId: ThreadId;
    readonly requestCommandId: CommandId;
    readonly policy: PoolTimings;
  }): Effect.Effect<ProviderSessionResumeOutcome> =>
    Effect.gen(function* () {
      while (true) {
        const snapshot = yield* readThreadDetail(input.threadId);
        for (const activity of snapshot?.thread.activities ?? []) {
          if (activity.kind !== PROVIDER_SESSION_RESUME_SETTLED_ACTIVITY_KIND) continue;
          const payload = decodeResumeSettledActivity(activity.payload);
          if (Option.isNone(payload)) continue;
          if (payload.value.requestCommandId !== input.requestCommandId) continue;
          return payload.value.outcome;
        }
        yield* Effect.sleep(Duration.millis(input.policy.pollIntervalMs));
      }
    }).pipe(
      Effect.timeoutOption(Duration.millis(RESUME_SETTLE_TIMEOUT_MS)),
      Effect.map(
        Option.getOrElse(
          (): ProviderSessionResumeOutcome => ({
            _tag: "failed",
            detail: `No resume outcome was recorded for thread '${input.threadId}' within ${String(RESUME_SETTLE_TIMEOUT_MS)}ms.`,
          }),
        ),
      ),
    );

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
   * Let a turn the loop just interrupted close itself before the session stop
   * kills it — the server's half of `supervision.stopGraceSeconds`.
   *
   * A turn interrupt is asynchronous: the command reaches the provider through
   * the reactor and the turn leaves `running` only once the agent unwinds. A
   * `thread.session.stop` dispatched in the same breath ends the process
   * mid-unwind, which is what the terminal harness already avoids by waiting
   * between its TERM and its KILL.
   *
   * Bounded by the grace and by nothing else: the wait ends the moment the
   * turn is no longer running, an unreadable projection reads as "not running"
   * and stops the wait, and a grace of `0` waits for nothing at all.
   */
  const awaitInterruptedTurnClose = (threadId: ThreadId, graceSeconds: number) =>
    graceSeconds <= 0
      ? Effect.void
      : Effect.gen(function* () {
          while (true) {
            const snapshot = yield* readThreadDetail(threadId);
            if (threadTurnState(snapshot?.thread) !== "running") return;
            yield* Effect.sleep(Duration.millis(FORCED_STOP_POLL_INTERVAL_MS));
          }
        }).pipe(
          Effect.timeoutOption(Duration.seconds(graceSeconds)),
          Effect.tap((closed) =>
            Option.isSome(closed)
              ? Effect.void
              : Effect.logWarning("epic.runner.stop-grace-exhausted", {
                  threadId,
                  graceSeconds,
                }),
          ),
          Effect.asVoid,
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
    readonly settledTurn: SettledTurn;
    readonly onObservedTurn: (turnId: TurnId) => void;
  }): Effect.Effect<SettledTurn, DispatchError> =>
    Effect.gen(function* () {
      let continuationIndex = 0;
      let worktreeFingerprintBefore = input.initialWorktreeFingerprint;
      let settledTurn = input.settledTurn;

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
          if (decision.action === "settle") return settledTurn;
        }

        const snapshot = yield* readThreadDetail(input.threadId);
        const thread = snapshot?.thread;
        const turnStatus = settledTurn.state;
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
          if (decision.action === "settle") return settledTurn;
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
            if (decision.action === "settle") return settledTurn;
          }
          const finalMessage = yield* readSettledFinalMessage(
            input.threadId,
            input.timings,
            settledTurn.turnId,
            settledTurn.state,
          );
          const finalAssistantMessage =
            settledTurn.turnId === null
              ? resolveFinalAssistantMessage(finalMessage.snapshot?.thread)
              : resolveTurnAssistantMessage(finalMessage.snapshot?.thread, settledTurn.turnId);
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
          return settledTurn;
        }

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
            return settledTurn;
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
        // A human turn can start after the grace snapshot while subagents
        // drain. Do not dispatch a continuation into that newer turn.
        const graceSnapshotTurnId = thread?.latestTurn?.turnId ?? null;
        const priorTurnId =
          (yield* readThreadDetail(input.threadId))?.thread.latestTurn?.turnId ?? null;
        if (
          priorTurnId !== null &&
          priorTurnId !== graceSnapshotTurnId &&
          priorTurnId !== settledTurn.turnId
        ) {
          return settledTurn;
        }
        const continuationMessageId = MessageId.make(
          continuationIndex === 1
            ? `${input.threadId}-continue`
            : `${input.threadId}-continue-${continuationIndex}`,
        );
        yield* dispatchCommand({
          type: "thread.turn.start",
          commandId: yield* commandId("turn-continue"),
          threadId: input.threadId,
          message: {
            // Every continuation needs its own message id. Otherwise a later
            // cycle replaces the earlier continuation in the projection.
            messageId: continuationMessageId,
            role: "user",
            text: decision.prompt,
            attachments: [],
          },
          // The runner wrote this prompt, not the human. The timeline labels
          // an agent-authored `role: "user"` row so the two never blur.
          origin: "agent",
          // A human turn can still start between the re-check and dispatch.
          // Park the continuation until that turn ends if this race is lost.
          delivery: "turn-boundary",
          modelSelection: input.selection,
          runtimeMode: input.runtimeMode,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          createdAt,
        }).pipe(Effect.mapError(dispatchErrorFromRunner));
        settledTurn = yield* awaitTurnEnd(
          input.threadId,
          input.timings,
          priorTurnId,
          input.onObservedTurn,
          continuationMessageId,
        );
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

  /**
   * The handle every dispatched iteration is driven through.
   *
   * Shared by `beginTurn` and `resumeIteration` so a resumed iteration cannot
   * settle, continue, release or read its final message by different rules
   * than a fresh one. The only difference between the two callers is
   * `priorTurnId`: a resume arrives with a turn already recorded on the
   * thread, and the settle wait has to ignore it.
   */
  const makeIterationHandle = (input: {
    readonly threadId: ThreadId;
    readonly runId: string;
    readonly iterationIndex: number;
    readonly selection: Parameters<PoolDispatchShape["beginTurn"]>[0]["selection"];
    readonly runtimeMode: Parameters<PoolDispatchShape["beginTurn"]>[0]["runtimeMode"];
    readonly policy: PoolTimings;
    readonly workspace: Parameters<PoolDispatchShape["beginTurn"]>[0]["workspace"];
    readonly headBefore: string | null;
    readonly branchBase: string | null;
    readonly initialWorktreeFingerprint: string | null;
    readonly priorTurnId: TurnId | null;
    readonly messageId: MessageId;
  }): IterationHandle => {
    let settledTurn: SettledTurn | null = null;
    let ownedTurnId: TurnId | null = null;
    /** False once a delivered nudge proved this provider does not absorb one. */
    let nudgeEligible = true;
    const observeOwnedTurn = (turnId: TurnId) => {
      ownedTurnId = turnId;
      ownedIterationTurnIds.set(input.threadId, turnId);
    };
    const awaitSettled: Effect.Effect<IterationSettle, DispatchError> = Effect.gen(function* () {
      const initialSettledTurn = yield* awaitTurnEnd(
        input.threadId,
        input.policy,
        input.priorTurnId,
        observeOwnedTurn,
        input.messageId,
      );
      settledTurn = yield* graceContinuationForSubagents({
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
        settledTurn: initialSettledTurn,
        onObservedTurn: observeOwnedTurn,
      });
      const snapshot = yield* readThreadDetail(input.threadId);
      const projectedState = threadTurnState(snapshot?.thread);
      if (
        snapshot?.thread.latestTurn === null &&
        projectedState !== null &&
        projectedState !== "running"
      ) {
        // The detail pointer can be absent while checkpoint work catches up.
        // In that window the session is the only projected terminal state.
        settledTurn = { ...settledTurn, state: projectedState };
      }
      return {
        turnState: settledTurn.state,
        timedOut: false,
        providerError: snapshot?.thread.session?.lastError ?? null,
      } satisfies IterationSettle;
    });

    const handle: IterationHandle = {
      ref: input.threadId,
      capabilities: serverDispatchCapabilities,
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
      nudge: (prompt) =>
        Effect.gen(function* () {
          if (!nudgeEligible) return "unsupported" as const;
          // The message must land in the turn this iteration owns, and that
          // turn must still be running. After settlement the ids no longer
          // match, and a nudge sent then would start a turn of its own — with
          // no timeout, no liveness watch and no owner — in a worktree the
          // merge queue is about to trial-merge.
          const snapshot = yield* readThreadDetail(input.threadId);
          const latestTurn = snapshot?.thread.latestTurn ?? null;
          if (
            ownedTurnId === null ||
            latestTurn === null ||
            latestTurn.turnId !== ownedTurnId ||
            latestTurn.state !== "running"
          ) {
            return "skipped" as const;
          }
          const messageId = MessageId.make(
            `${input.threadId}-nudge-${yield* crypto.randomUUIDv4.pipe(Effect.orDie)}`,
          );
          // Deliberately no `delivery` field: `turn-boundary` would park this
          // until the turn ends, which is the opposite of a nudge and comes
          // back as exactly the stray turn the guard above exists to prevent.
          const dispatched = yield* dispatchCommand({
            type: "thread.turn.start",
            commandId: yield* commandId("turn-nudge"),
            threadId: input.threadId,
            message: { messageId, role: "user", text: prompt, attachments: [] },
            origin: "agent",
            modelSelection: input.selection,
            runtimeMode: input.runtimeMode,
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            createdAt: yield* nowIso,
          }).pipe(
            Effect.as(true),
            Effect.catchCause((cause) =>
              Effect.logWarning("epic.runner.nudge-failed", {
                threadId: input.threadId,
                cause,
              }).pipe(Effect.as(false)),
            ),
          );
          if (!dispatched) return "skipped" as const;
          // No adapter declares steer support before a send, so absorption is
          // the only available evidence: the reactor writes this activity only
          // when the provider reported that it steered the running turn. A
          // driver that opened a second turn instead (Kimi, Grok, Cursor, or a
          // Codex fallback) never writes it, and must never be nudged again.
          const absorbed = yield* Effect.gen(function* () {
            for (let read = 0; read < NUDGE_ABSORPTION_READS; read += 1) {
              yield* Effect.sleep(Duration.millis(input.policy.quietPeriodMs));
              const after = yield* readThreadDetail(input.threadId);
              const attributed = (after?.thread.activities ?? []).some(
                (activity) =>
                  activity.kind === PROVIDER_TURN_STEER_ATTRIBUTED_ACTIVITY_KIND &&
                  Option.match(decodeProviderTurnSteerAttributedActivityPayload(activity.payload), {
                    onNone: () => false,
                    onSome: (payload) => payload.messageId === messageId,
                  }),
              );
              if (attributed) return true;
            }
            return false;
          });
          if (absorbed) return "sent" as const;
          nudgeEligible = false;
          yield* Effect.logWarning("epic.runner.nudge-not-absorbed", {
            threadId: input.threadId,
            messageId,
          });
          return "unsupported" as const;
        }),
      interrupt: Effect.gen(function* () {
        yield* dispatchBestEffort("epic.runner.interrupt-failed", {
          type: "thread.turn.interrupt",
          commandId: yield* commandId("turn-interrupt"),
          threadId: input.threadId,
          ...(ownedTurnId === null ? {} : { turnId: ownedTurnId }),
          createdAt: yield* nowIso,
        });
      }),
      release: Effect.gen(function* () {
        yield* awaitSubagentDrain(input.threadId, input.policy);
        // Do not stop a settled iteration session here. A queued human prompt
        // can become active between any projection check and session.stop.
        // The session reaper owns idle cleanup without racing message delivery.
        ownedIterationTurnIds.delete(input.threadId);
      }),
      runningSubagents: Effect.gen(function* () {
        const snapshot = yield* readThreadDetail(input.threadId);
        const nowMs = Date.parse(yield* nowIso);
        return {
          mode: "native" as const,
          running: countFreshRunningSubagents(snapshot?.thread.subagents ?? [], nowMs),
        };
      }),
      finalMessage: Effect.suspend(() =>
        readSettledFinalMessage(
          input.threadId,
          input.policy,
          settledTurn?.turnId ?? null,
          settledTurn?.state ?? null,
        ).pipe(
          Effect.map((settled): FinalMessageRead => {
            const thread = settled.snapshot?.thread;
            const message =
              settledTurn?.turnId == null
                ? resolveFinalAssistantMessage(thread)
                : resolveTurnAssistantMessage(thread, settledTurn.turnId);
            return {
              text: message?.text ?? null,
              streaming: message?.streaming ?? false,
              waitExhausted: settled.messageWaitExhausted,
              turnState: settledTurn?.state ?? null,
              sessionLastError: thread?.session?.lastError ?? null,
            };
          }),
        ),
      ),
    };
    return handle;
  };

  return {
    capabilities: serverDispatchCapabilities,
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
        yield* bindIterationSubagents(input.runId, input.threadId, input.selection);
        yield* bindIterationCommitter(input.runId, input.threadId);
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
        const messageId = MessageId.make(`${input.threadId}-prompt`);
        yield* dispatchCommand({
          type: "thread.turn.start",
          commandId: yield* commandId("turn-start"),
          threadId: input.threadId,
          message: {
            messageId,
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
        return makeIterationHandle({ ...input, priorTurnId: null, messageId });
      }),

    /**
     * The server's ref IS the iteration's orchestration thread id, which
     * outlives the process, so adopting the work is asking that thread to
     * carry on. A failed dispatch is an infra fault — the command path is
     * broken or the thread was deleted — while every provider-side "no" comes
     * back through the resume outcome as an `unavailable` value.
     */
    resumeIteration: (input) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make(input.ref);
        // The registry is in-memory, so a restart lost this thread's binding.
        // Rebind before the resume: if the session has to start again, it
        // starts with the role subagents rather than without them.
        yield* bindIterationSubagents(input.runId, threadId, input.selection);
        yield* bindIterationCommitter(input.runId, threadId);
        const resumeCommandId = yield* commandId("session-resume");
        yield* dispatchCommand({
          type: "thread.session.resume",
          commandId: resumeCommandId,
          threadId,
          createdAt: yield* nowIso,
        });
        const outcome = yield* awaitResumeOutcome({
          threadId,
          requestCommandId: resumeCommandId,
          policy: input.policy,
        });
        yield* Effect.logInfo("epic.runner.resume-outcome", {
          runId: input.runId,
          iterationIndex: input.iterationIndex,
          issueId: input.issueId,
          threadId,
          outcome: outcome._tag,
        });
        switch (outcome._tag) {
          case "capability":
          case "no-durable-state":
            return {
              _tag: "unavailable",
              refusal: { _tag: outcome._tag, detail: outcome.detail },
            } as const;
          case "not-continued":
            return {
              _tag: "unavailable",
              refusal: {
                _tag: "not-continued",
                origin: outcome.origin,
                detail: outcome.detail,
              },
            } as const;
          case "failed":
            // Not an `EpicRunnerDispatchError`: the reactor answers `failed`
            // when the adapter errored on the resume it had accepted, and the
            // agent still heard nothing. That is a refusal the caller recovers
            // from, not a broken machine.
            return {
              _tag: "unavailable",
              refusal: { _tag: "failed", detail: outcome.detail },
            } as const;
          case "resumed":
            break;
        }

        // Only now, with continuity proved, does the agent hear anything.
        const promptId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
        const messageId = MessageId.make(`${threadId}-resume-${promptId}`);
        // The resume handshake can overlap a human turn. Pin the wait to the
        // turn active immediately before this runner prompt is dispatched.
        const priorTurnId = (yield* readThreadDetail(threadId))?.thread.latestTurn?.turnId ?? null;
        yield* dispatchCommand({
          type: "thread.turn.start",
          commandId: yield* commandId("turn-resume"),
          threadId,
          message: {
            // Never `${threadId}-prompt`: that id already names the message
            // the interrupted iteration sent, and reusing it would replace it.
            messageId,
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
        return {
          _tag: "resumed",
          handle: makeIterationHandle({ ...input, threadId, priorTurnId, messageId }),
        } as const;
      }),

    interruptForced: (threadId) =>
      Effect.gen(function* () {
        const createdAt = yield* nowIso;
        yield* dispatchBestEffort("epic.runner.forced-interrupt-failed", {
          type: "thread.turn.interrupt",
          commandId: yield* commandId("forced-interrupt"),
          threadId,
          // Only this process's own owned turn can be named. A thread
          // interrupted after a restart has none recorded here, and the
          // engine then interrupts whatever turn it finds running.
          ...(ownedIterationTurnIds.has(threadId)
            ? { turnId: ownedIterationTurnIds.get(threadId) }
            : {}),
          createdAt,
        });
      }),

    stopAbandoned: (threadId) =>
      Effect.gen(function* () {
        yield* dispatchBestEffort("epic.runner.skipped-session-stop-failed", {
          type: "thread.session.stop",
          commandId: yield* commandId("skipped-session-stop"),
          threadId,
          createdAt: yield* nowIso,
        });
        ownedIterationTurnIds.delete(threadId);
      }),

    stopForced: (threadId, options) =>
      Effect.gen(function* () {
        yield* awaitInterruptedTurnClose(threadId, options.graceSeconds);
        yield* dispatchBestEffort("epic.runner.session-stop-failed", {
          type: "thread.session.stop",
          commandId: yield* commandId("session-stop"),
          threadId,
          createdAt: yield* nowIso,
        });
        ownedIterationTurnIds.delete(threadId);
      }),
  };
};

/**
 * Flip every iteration still recorded as `running` to `abandoned`, stopping
 * its thread first. Shared by cancellation, restart reconciliation, and the
 * loop-failure backstop.
 *
 * The optional `onlyIterationIndexes` narrows that to a chosen subset. The boot
 * path needs it: it withholds the rows it is about to resume, and abandoning
 * one of those would stop the very session the resume is going to continue.
 */
export const makeAbandonRunningIterations = (deps: {
  readonly store: EpicRunStore["Service"];
  readonly engine: OrchestrationEngineService["Service"];
  readonly crypto: Crypto.Crypto;
  readonly backlog: PoolBacklogShape;
  readonly ownedIterationTurnIds: Map<ThreadId, TurnId>;
}) => {
  const { store, engine, crypto, backlog, ownedIterationTurnIds } = deps;

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
    onlyIterationIndexes?: ReadonlySet<number>,
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
      if (
        onlyIterationIndexes !== undefined &&
        !onlyIterationIndexes.has(iteration.iterationIndex)
      ) {
        continue;
      }
      const abandonedAt = yield* nowIso;
      if (iteration.issueId !== null) {
        yield* dispatchBestEffort(`epic.runner.${commandPrefix}-interrupt-failed`, {
          type: "thread.turn.interrupt",
          commandId: yield* commandId(`${commandPrefix}-interrupt`),
          threadId: iteration.threadId,
          ...(ownedIterationTurnIds.has(iteration.threadId)
            ? { turnId: ownedIterationTurnIds.get(iteration.threadId) }
            : {}),
          createdAt: abandonedAt,
        });
        // No stop grace here, unlike the loop's own forced stop: these rows
        // belong to nobody. A boot pass is interrupting turns whose process
        // already died, and a cancel is a person asking for the run to stop
        // now, so waiting seconds per row would buy neither of them anything.
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
          phaseTimings: null,
          promptBytes: null,
          finishedAt: abandonedAt,
        })
        .pipe(Effect.mapError(storeError("updateIteration")));
      if (iteration.issueId !== null) {
        yield* backlog.releaseClaimedChild(run.cwd, iteration.issueId);
      }
      ownedIterationTurnIds.delete(iteration.threadId);
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
