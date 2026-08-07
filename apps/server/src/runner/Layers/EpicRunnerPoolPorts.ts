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
  type OrchestrationSessionStatus,
  type OrchestrationThread,
  type ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import {
  EpicRunnerDispatchError,
  EpicRunnerStoreError,
  EpicRunNotFoundError,
} from "@t3tools/epic-core/Errors";
import type * as ProcessRunner from "@t3tools/epic-core/processRunner";
import type {
  MergeDrainShape,
  PoolBacklogShape,
  PoolRunEventsShape,
  PoolRunJournalShape,
  PoolTimings,
  PoolVcsShape,
  ReadyFrontierSelection,
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
import { BacklogError } from "@t3tools/epic-core/ports/Backlog";
import type { WorkspaceShape } from "@t3tools/epic-core/ports/Workspace";
import {
  decideGraceStep,
  integrationBranch as integrationBranchName,
  parseMergeFixTitle,
} from "@t3tools/epic-core/policy";
import {
  hasRalphBlocked,
  hasRalphDone,
  parseRalphReport,
  type IterationTurnState,
} from "@t3tools/epic-core/ralphProtocol";
import { drainMergeQueue } from "@t3tools/epic-core/MergeQueue";
import { makeProcessBacklog } from "@t3tools/epic-core/adapters/ProcessBacklog";
import { makeProcessGate } from "@t3tools/epic-core/adapters/ProcessGate";
import { makeProcessMergeSlot } from "@t3tools/epic-core/adapters/ProcessMergeSlot";
import { MergeQueuePortError } from "@t3tools/epic-core/ports/MergeQueue";
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
import {
  countFreshRunningSubagents,
  isRunningSubagentLivenessRefusal,
} from "../../orchestration/subagentLiveness.ts";
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
const MAX_SETTLE_READS = 20;
/**
 * The bound for the one absence worth waiting out: a completed turn whose
 * assistant row has not projected at all. Two minutes at the default quiet
 * period, which is far past any projection lag but nothing against an iteration
 * measured in hours — and it is only ever spent when the alternative is calling
 * a pending message a missing one.
 */
const MAX_ABSENT_MESSAGE_SETTLE_READS = 120;
const RECENT_ITERATIONS_LIMIT = 25;

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

const isEpicRunnerDispatchError = Schema.is(EpicRunnerDispatchError);

const storeError = (operation: string) => (cause: unknown) =>
  new EpicRunnerStoreError({ operation, cause });

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
const decodeEpicDescription = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Union([
      Schema.Struct({ description: Schema.String }),
      Schema.Array(Schema.Struct({ description: Schema.String })),
    ]),
  ),
);
const ReadyChildren = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      id: Schema.String,
      parent: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
    }),
  ),
);
const decodeReadyChildren = Schema.decodeUnknownEffect(ReadyChildren);
const EpicChildren = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      id: Schema.String,
      status: Schema.String,
    }),
  ),
);
const decodeEpicChildren = Schema.decodeUnknownEffect(EpicChildren);

/**
 * The `bd` probes the pool loop reads its backlog through. Evidence reads
 * never fail: an unreadable issue yields conservative nulls, exactly like the
 * pre-extraction runner, and the loop treats unknown as unproven.
 */
export const makeServerPoolBacklog = (
  processRunner: ProcessRunner.ProcessRunner["Service"],
): PoolBacklogShape => {
  const readyFrontier: PoolBacklogShape["readyFrontier"] = (cwd, epicId) =>
    processRunner
      .run({
        command: "bd",
        args: ["ready", "--parent", epicId, "--json"],
        cwd,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new BacklogError({
              operation: "bd.ready",
              detail: "Could not read the epic's ready children",
              cause,
            }),
        ),
        Effect.flatMap((output) => {
          if (output.code !== 0) {
            return Effect.fail(
              new BacklogError({
                operation: "bd.ready",
                detail: output.stderr.trim() || `bd ready exited with code ${output.code}`,
              }),
            );
          }
          return decodeReadyChildren(output.stdout).pipe(
            Effect.mapError(
              (cause) =>
                new BacklogError({
                  operation: "bd.ready",
                  detail: `Invalid bd ready output: ${String(cause)}`,
                  cause,
                }),
            ),
            Effect.flatMap((value): Effect.Effect<ReadyFrontierSelection, BacklogError> => {
              if (value.length === 0)
                return Effect.succeed<ReadyFrontierSelection>({ _tag: "empty" });

              // `bd ready --parent` owns the scope. Some bd rows omit the
              // parent value, which decodes to null and is usable. Reject
              // only an explicit parent that names another issue.
              const direct = value.filter(
                (issue) => issue.parent === null || issue.parent === epicId,
              );
              if (direct.length === 0) {
                return Effect.succeed<ReadyFrontierSelection>({
                  _tag: "unrecognised",
                  candidateIds: value.map((issue) => issue.id),
                });
              }
              const invalid = direct.find((issue) => issue.id.trim().length === 0);
              return invalid !== undefined
                ? Effect.fail(
                    new BacklogError({
                      operation: "bd.ready",
                      detail: "Invalid bd ready output: a usable ready child has no id",
                    }),
                  )
                : Effect.succeed<ReadyFrontierSelection>({
                    _tag: "children",
                    issueIds: direct.map((issue) => issue.id),
                  });
            }),
          );
        }),
      );

  const countOpenChildren: PoolBacklogShape["countOpenChildren"] = (cwd, epicId) =>
    processRunner
      .run({
        command: "bd",
        args: ["list", "--parent", epicId, "--all", "--flat", "--json"],
        cwd,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new BacklogError({
              operation: "bd.list",
              detail: "Could not read the epic's children",
              cause,
            }),
        ),
        Effect.flatMap((output) => {
          if (output.code !== 0) {
            return Effect.fail(
              new BacklogError({
                operation: "bd.list",
                detail: output.stderr.trim() || `bd list exited with code ${output.code}`,
              }),
            );
          }
          return decodeEpicChildren(output.stdout).pipe(
            Effect.mapError(
              (cause) =>
                new BacklogError({
                  operation: "bd.list",
                  detail: `Invalid bd list output: ${String(cause)}`,
                  cause,
                }),
            ),
            Effect.map(
              (children) =>
                children.filter((child) => child.id !== epicId && child.status !== "closed").length,
            ),
          );
        }),
      );

  const emptyIssueEvidence = {
    status: null,
    title: null,
    commentCount: 0,
  } as const;

  /**
   * The child issue evidence available from one `bd show`, with conservative
   * defaults when the command fails or its output cannot be decoded. Never
   * fails the caller: unknown status and comment count cannot prove work.
   */
  const issueEvidence: PoolBacklogShape["issueEvidence"] = (cwd, issueId) =>
    processRunner.run({ command: "bd", args: ["show", issueId, "--json"], cwd }).pipe(
      Effect.map((shown) => {
        if (shown.code !== 0) return emptyIssueEvidence;
        const decoded = decodeIssueEvidence(shown.stdout);
        if (Option.isNone(decoded)) return emptyIssueEvidence;
        const value = Array.isArray(decoded.value) ? decoded.value[0] : decoded.value;
        if (value === undefined) return emptyIssueEvidence;
        return {
          status: value.status ?? null,
          title: value.title ?? null,
          commentCount: value.comment_count,
        };
      }),
      Effect.catchCause((cause) =>
        Effect.logWarning("epic.runner.issue-evidence-read-failed", { cwd, issueId, cause }).pipe(
          Effect.as(emptyIssueEvidence),
        ),
      ),
    );

  /**
   * Whether findings in the bead are this child's deliverable. A title
   * prefix is authoritative; otherwise a failed label read means false.
   */
  const issueIsResearch: PoolBacklogShape["issueIsResearch"] = (cwd, issueId, title) => {
    if (title?.startsWith("Research:") === true) return Effect.succeed(true);
    return processRunner.run({ command: "bd", args: ["label", "list", issueId], cwd }).pipe(
      Effect.map((listed) => listed.code === 0 && /^\s*-\s*research\s*$/imu.test(listed.stdout)),
      Effect.catchCause(() => Effect.succeed(false)),
    );
  };

  const epicDescription: PoolBacklogShape["epicDescription"] = (cwd, epicId) =>
    processRunner.run({ command: "bd", args: ["show", epicId, "--json"], cwd }).pipe(
      Effect.flatMap((shown) => {
        if (shown.code !== 0) {
          return Effect.logWarning("epic.runner.epic-description-read-failed", {
            cwd,
            epicId,
            detail: shown.stderr.trim() || `bd show exited with code ${shown.code}`,
          }).pipe(Effect.as(null));
        }
        const decoded = decodeEpicDescription(shown.stdout);
        const value = Option.isSome(decoded)
          ? Array.isArray(decoded.value)
            ? decoded.value[0]
            : decoded.value
          : undefined;
        if (value === undefined) {
          return Effect.logWarning("epic.runner.epic-description-decode-failed", {
            cwd,
            epicId,
          }).pipe(Effect.as(null));
        }
        return Effect.succeed<string | null>(value.description);
      }),
      Effect.catchCause((cause) =>
        Effect.logWarning("epic.runner.epic-description-read-failed", {
          cwd,
          epicId,
          cause,
        }).pipe(Effect.as(null)),
      ),
    );

  /**
   * Best-effort: un-claim a child issue the loop's own exit just stranded.
   *
   * An iteration's agent claims its child itself and is expected to close it
   * before the turn ends. When the *run* instead exits without that happening
   * the child is left `in_progress` with no worker attached, and `bd ready`
   * filters on status, so a phantom claim silently stalls the epic. The
   * child's *current* status is re-read and only a standing claim is reopened,
   * so the happy path (the agent already closed it) and a legitimate handoff
   * to another run are both untouched. Returns whether a claim was released.
   *
   * Never fails the caller: this runs from terminal paths (finalizers,
   * restart bookkeeping) that have nowhere useful to send an error.
   */
  const releaseClaimedChild: PoolBacklogShape["releaseClaimedChild"] = (cwd, issueId) =>
    issueEvidence(cwd, issueId).pipe(
      Effect.flatMap((evidence) => {
        if (evidence.status !== "in_progress") return Effect.succeed(false);
        return processRunner
          .run({
            command: "bd",
            args: ["update", issueId, "--status", "open", "--assignee", ""],
            cwd,
          })
          .pipe(Effect.as(true));
      }),
      Effect.catchCause((cause) =>
        Effect.logWarning("epic.runner.release-claimed-child-failed", { cwd, issueId, cause }).pipe(
          Effect.as(false),
        ),
      ),
    );

  return {
    readyFrontier,
    countOpenChildren,
    issueEvidence,
    issueIsResearch,
    epicDescription,
    releaseClaimedChild,
  };
};

/** Never-failing git probes; `null` never counts as progress. */
export const makeServerPoolVcs = (
  processRunner: ProcessRunner.ProcessRunner["Service"],
): PoolVcsShape => ({
  /**
   * The repo's `HEAD`, or `null` when it cannot be read (no repo, no commits,
   * git missing). `null` never counts as movement, mirroring terminal ralph's
   * `head_after != none` guard (`run.sh:321`).
   */
  headCommit: (cwd: string) =>
    processRunner
      .run({
        command: "git",
        args: ["rev-parse", "--verify", "-q", "HEAD"],
        cwd,
        timeout: Duration.millis(GIT_HEAD_TIMEOUT_MS),
      })
      .pipe(
        Effect.map((output) => {
          const sha = output.stdout.trim();
          return output.code === 0 && sha.length > 0 ? sha : null;
        }),
        Effect.catchCause((cause) =>
          Effect.logDebug("epic.runner.head-read-failed", { cwd, cause }).pipe(Effect.as(null)),
        ),
      ),

  /**
   * The repo's current porcelain status, verbatim, or `null` when git cannot
   * read it. Empty stdout is a valid clean-worktree fingerprint. `null`
   * never counts as progress.
   */
  worktreeFingerprint: (cwd: string) =>
    processRunner
      .run({
        command: "git",
        args: ["status", "--porcelain=v1"],
        cwd,
        timeout: Duration.millis(GIT_HEAD_TIMEOUT_MS),
      })
      .pipe(
        Effect.map((output) => (output.code === 0 ? output.stdout : null)),
        Effect.catchCause((cause) =>
          Effect.logDebug("epic.runner.worktree-read-failed", { cwd, cause }).pipe(Effect.as(null)),
        ),
      ),

  commitsAhead: (input) =>
    processRunner
      .run({
        command: "git",
        args: ["rev-list", "--count", `${input.base}..${input.branch}`],
        cwd: input.cwd,
        timeout: Duration.millis(GIT_HEAD_TIMEOUT_MS),
      })
      .pipe(
        Effect.map((output) =>
          output.code === 0 ? Number.parseInt(output.stdout.trim(), 10) : null,
        ),
        Effect.catchCause((cause) =>
          Effect.logDebug("epic.runner.branch-commit-read-failed", {
            cwd: input.cwd,
            branch: input.branch,
            cause,
          }).pipe(Effect.as(null)),
        ),
      ),
});

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

      const baseBranch = yield* readCurrentBranch(run.cwd);
      const vcs = makeServerPoolVcs(processRunner);
      const lastAcceptedHead = yield* vcs.headCommit(run.cwd);
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
        yield* store
          .initializeMergeState({
            runId: run.runId,
            lastAcceptedHead,
            repositoryPath: run.cwd,
            baseBranch,
            integrationBranch: provisioned.refName,
            integrationWorktreePath: provisioned.path,
          })
          .pipe(Effect.mapError(storeError("initializeMergeState")));
        return Option.getOrThrow(
          yield* store
            .getMergeState({ runId: run.runId })
            .pipe(Effect.mapError(storeError("getMergeState"))),
        );
      }).pipe(
        Effect.catchCause((cause) =>
          releaseProvisionedWorktree({
            repositoryPath: run.cwd,
            worktreePath: provisioned.path,
            label: "epic.runner.integration-provision-rollback-failed",
          }).pipe(
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
          return {
            cwd: worktreePath ?? run.cwd,
            branch: null,
            worktreePath,
          };
        }

        const mergeFix = parseMergeFixTitle(input.issueTitle);
        const branch = mergeFix?.branch ?? `epic/${input.issueId}`;
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
        const baseBranch = yield* readCurrentBranch(runCtx.cwd);
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
        return yield* writeBeadsRedirect(runCtx.cwd, provisioned.path).pipe(
          Effect.mapError(
            (cause) =>
              new EpicRunnerDispatchError({
                commandType: "beads.redirect-write",
                detail: `Could not write the beads redirect in ${provisioned.path}`,
                cause,
              }),
          ),
          Effect.as({
            cwd: provisioned.path,
            branch: provisioned.refName,
            worktreePath: provisioned.path,
          }),
          Effect.catchCause((cause) =>
            releaseProvisionedWorktree({
              repositoryPath: runCtx.cwd,
              worktreePath: provisioned.path,
              label: "epic.runner.worker-provision-rollback-failed",
            }).pipe(Effect.andThen(Effect.failCause(cause))),
          ),
        );
      }),

    release: (runCtx, workspace) =>
      workspace.worktreePath === null
        ? Effect.void
        : worktreeProvisioner
            .release({ repoCwd: runCtx.cwd, worktreePath: workspace.worktreePath, force: true })
            .pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("epic.runner.worker-worktree-release-failed", {
                  runId: runCtx.runId,
                  worktreePath: workspace.worktreePath,
                  cause,
                }),
              ),
            ),

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
        const countOutput = yield* gitVcsDriver
          .execute({
            operation: "EpicRunner.landingEffects.commitCount",
            cwd: state.value.repositoryPath,
            args: [
              "rev-list",
              "--count",
              `${state.value.initialHead}..${state.value.lastAcceptedHead}`,
            ],
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new EpicRunnerDispatchError({
                  commandType: "git.landing-effects",
                  detail: "Could not count landed commits",
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
          repositoryPath: state.value.repositoryPath,
          baseHead: state.value.initialHead,
          head: state.value.lastAcceptedHead,
          commitCount,
          parkedCount: state.value.parkedCount,
        } as const;
        yield* store
          .upsertLandingEffects(landingEffects)
          .pipe(Effect.mapError(storeError("upsertLandingEffects")));
        yield* Effect.logInfo("epic.runner.repository-landing-effects", {
          ...landingEffects,
        });
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
      const restoreIntegrationWorktreeAssets = (cwd: string) =>
        Effect.gen(function* () {
          // Terminal parity: `skills/cook-epic/run.sh:1173-1185,3110-3112`.
          yield* writeBeadsRedirect(run.cwd, cwd);
          const sourceNodeModules = path.join(run.cwd, "node_modules");
          const targetNodeModules = path.join(cwd, "node_modules");
          if (
            (yield* fileSystem.exists(sourceNodeModules)) &&
            !(yield* fileSystem.exists(targetNodeModules))
          ) {
            yield* fileSystem.symlink(sourceNodeModules, targetNodeModules);
          }
          // Terminal parity: `skills/cook-epic/run.sh:1164-1169`.
          for (const name of [
            ".env",
            ".env.local",
            ".env.development",
            ".env.development.local",
            ".env.test",
          ]) {
            const source = path.join(run.cwd, name);
            const target = path.join(cwd, name);
            if ((yield* fileSystem.exists(source)) && !(yield* fileSystem.exists(target))) {
              yield* fileSystem.copyFile(source, target);
            }
          }
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
      const result = yield* drainMergeQueue(
        {
          runId: run.runId,
          epicId: run.epicId,
          holder: `cook-epic-${run.runId}`,
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
      if (result._tag === "deferred") return { _tag: "deferred" } as const;
      if (result._tag === "drained") return { _tag: "drained" } as const;
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
  };
};

/**
 * The turn state a session status implies, or null while the session is
 * (re)starting or running and turns must stay unsettled.
 *
 * Mirrors `settledTurnStateForSessionStatus`
 * (`orchestration/Layers/ProjectionPipeline.ts:78-94`) exactly, because the
 * projector settles a thread's running turns from this same status in the same
 * transaction that writes it. That shared origin is what makes this a safe
 * stand-in when the turn row cannot be read.
 */
const settledTurnStateFromSessionStatus = (
  status: OrchestrationSessionStatus,
): "completed" | "interrupted" | "error" | null => {
  switch (status) {
    case "idle":
    case "ready":
      return "completed";
    case "error":
      return "error";
    case "interrupted":
    case "stopped":
      return "interrupted";
    case "starting":
    case "running":
      return null;
  }
};

/**
 * Whether a session status settles the turn.
 *
 * Derived from `settledTurnStateFromSessionStatus` so the two cannot drift. It
 * is not simply `status !== "running"`, and the difference matters: a fresh
 * thread's session is `"starting"` before its turn begins, which under that
 * looser test would end the turn before the agent had said a word.
 */
const isTurnEndSessionStatus = (status: OrchestrationSessionStatus): boolean =>
  settledTurnStateFromSessionStatus(status) !== null;

/**
 * The assistant message an iteration's verdict is read from.
 *
 * Prefers the turn's own pointer, but resolves it against the projected rows
 * first: `CheckpointReactor.ts:294-299` synthesizes an `assistant:<turnId>`
 * pointer for turns that produced no message, and that synthetic id names no
 * row. Falling back to the last projected assistant row matches terminal
 * ralph, whose result is the last agent message of the run.
 */
const resolveFinalAssistantMessage = (
  thread: OrchestrationThread | undefined,
): { readonly text: string; readonly streaming: boolean } | null => {
  if (thread === undefined) {
    return null;
  }
  const assistantMessages = thread.messages.filter((message) => message.role === "assistant");
  const pointer = thread.latestTurn?.assistantMessageId ?? null;
  const named =
    pointer === null ? undefined : assistantMessages.find((message) => message.id === pointer);
  const message = named ?? assistantMessages[assistantMessages.length - 1];
  return message === undefined ? null : { text: message.text, streaming: message.streaming };
};

/**
 * The turn state a thread detail implies, turn row first and session status
 * second.
 *
 * `latestTurn` resolves through an inner join on `threads.latest_turn_id`
 * (`ProjectionSnapshotQuery.ts:1122-1130`), and the same transaction that
 * settles the turn nulls that pointer (`ProjectionPipeline.ts:757-771`). The
 * pointer is only restored later, by `thread.turn-diff-completed` after the
 * CheckpointReactor has captured a git checkpoint and diffed it — seconds of
 * work unrelated to the turn, and skipped entirely when that capture fails. So
 * a settled turn routinely reads back as `null` here, which `classifyIteration`
 * cannot distinguish from "never ran".
 *
 * The session row is the reliable stand-in: the projector writes it in the same
 * transaction it settles the turn with, from this exact mapping, so it can never
 * disagree with the turn row that eventually reappears.
 */
const iterationTurnState = (thread: OrchestrationThread | undefined): IterationTurnState => {
  const sessionStatus = thread?.session?.status ?? null;
  return (
    thread?.latestTurn?.state ??
    (sessionStatus === null ? null : settledTurnStateFromSessionStatus(sessionStatus))
  );
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
}): PoolDispatchShape => {
  const { engine, projectionSnapshotQuery, processRunner, projectSetupScriptRunner, crypto } = deps;
  const vcs = makeServerPoolVcs(processRunner);

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

  const readThreadShell = (threadId: ThreadId) =>
    projectionSnapshotQuery.getThreadShellById(threadId).pipe(
      Effect.map(Option.getOrUndefined),
      Effect.catchCause((cause) =>
        Effect.logWarning("epic.runner.shell-read-failed", { threadId, cause }).pipe(
          Effect.as(undefined),
        ),
      ),
    );

  /**
   * Wait until the iteration's turn has ended.
   *
   * Polls the projection rather than subscribing to `streamDomainEvents`.
   * That is a deliberate trade. The event stream is lower-latency, but there
   * is no way to know a subscription is live before dispatching: neither
   * `Stream.toPull`, `Stream.toQueue`, nor `Stream.onStart` opens the
   * underlying `Stream.fromPubSub` (`OrchestrationEngine.ts:326-331`) eagerly,
   * so a fast turn can publish its entire lifecycle into a subscription that
   * does not exist yet — and the iteration then hangs until its multi-hour
   * timeout. Polling has no such window: projections are committed in the
   * same transaction as the append (`OrchestrationEngine.ts:170-180`), so
   * every read is consistent and no signal can be missed. At iteration
   * timescales the added latency is irrelevant, and the read is the cheap
   * shell row, not the full thread.
   *
   * Turn end is the same signal the projector uses — a turn leaving
   * `running` (`ProjectionPipeline.ts:1059-1073`). The session is a fallback
   * for the case where the provider dies before a turn row ever exists, which
   * would otherwise be indistinguishable from "still starting".
   */
  const awaitTurnEnd = (
    threadId: ThreadId,
    timings: PoolTimings,
    priorTurnId: TurnId | null = null,
  ) =>
    Effect.gen(function* () {
      let observedActive = false;
      while (true) {
        const shell = yield* readThreadShell(threadId);
        // A continuation turn is dispatched while the thread's PREVIOUS turn
        // is still the projected latest — turn rows are created at provider
        // adoption, not at turn.start — so until the new turn appears, the
        // prior turn's settled state must not read as this turn's end.
        const latestTurn =
          shell?.latestTurn != null && shell.latestTurn.turnId !== priorTurnId
            ? shell.latestTurn
            : null;
        const turnState = latestTurn?.state ?? null;
        const sessionStatus = shell?.session?.status ?? null;

        if (
          turnState === "running" ||
          sessionStatus === "starting" ||
          sessionStatus === "running"
        ) {
          observedActive = true;
        }
        if (turnState !== null && turnState !== "running") {
          return;
        }
        if (observedActive && sessionStatus !== null && isTurnEndSessionStatus(sessionStatus)) {
          return;
        }

        yield* Effect.sleep(Duration.millis(timings.pollIntervalMs));
      }
    });

  /**
   * The thread detail read every subagent-liveness check shares. `undefined`
   * (missing thread, read failure) reads as "no subagents" for the advisory
   * drain. The guarded stop still checks liveness atomically, so a broken
   * read cannot authorize a destructive stop.
   */
  const readThreadDetail = (threadId: ThreadId) =>
    projectionSnapshotQuery.getThreadDetailSnapshot(threadId).pipe(
      Effect.map(Option.getOrUndefined),
      Effect.catchCause((cause) =>
        Effect.logWarning("epic.runner.snapshot-read-failed", { threadId, cause }).pipe(
          Effect.as(undefined),
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
   * Read the turn's final assistant message once it has stopped changing.
   *
   * The turn-end signal is not the read point: ingestion dispatches
   * `thread.session.set` (`ProviderRuntimeIngestion.ts:1666`) before it
   * finalizes the turn's assistant messages, so reading immediately returns a
   * still-streaming row — empty, on ACP providers whose text exists only as
   * deltas. Waiting for two consecutive identical reads closes that gap.
   *
   * An absent message (`resolveFinalAssistantMessage` returning `null`) is
   * never treated as settled on its own: it means the assistant row hasn't
   * projected yet, not that the turn produced none, so `null === null` across
   * two reads must keep polling rather than return early. A genuinely
   * message-less completed turn is indistinguishable from this in-flight gap
   * until the bound below is exhausted — that is the correct, if slower,
   * outcome, since guessing wrong here silently drops the rest of the epic's
   * backlog (`classifyIteration` treats a spurious `null` as a protocol
   * error, and three of those trip `maxConsecutiveFailures`).
   *
   * Bounded: a provider that never stops rewriting the message — or one
   * whose turn truly ends with no assistant row — would otherwise hold the
   * loop here forever, so after `MAX_SETTLE_READS` the last read is used
   * as-is and classification decides what it means.
   *
   * That base bound is short because a rewriting provider is still working.
   * A *completed* turn with no assistant row at all is a different wait: the
   * only outstanding work is ingestion's own finalize, so the wait extends to
   * `MAX_ABSENT_MESSAGE_SETTLE_READS` for as long as the turn keeps reading
   * back completed. The extension is why the exhausted flag below means
   * something: when even that runs out, the absence has been watched for as
   * long as it is worth watching.
   */
  const readSettledFinalMessage = (threadId: ThreadId, timings: PoolTimings) =>
    Effect.gen(function* () {
      const read = () => readThreadDetail(threadId);

      let previous = yield* read();
      // Raised, in the loop, the first time a completed turn reads back with
      // no assistant row — the one absence worth waiting out.
      let maxReads = MAX_SETTLE_READS;
      let watchedCompletedTurnWithoutMessage = false;
      for (let attempt = 0; attempt < maxReads; attempt += 1) {
        yield* Effect.sleep(Duration.millis(timings.quietPeriodMs));
        const current = yield* read();
        const previousMessage = resolveFinalAssistantMessage(previous?.thread);
        const currentMessage = resolveFinalAssistantMessage(current?.thread);
        if (
          currentMessage !== null &&
          previousMessage?.text === currentMessage.text &&
          previousMessage?.streaming === currentMessage.streaming
        ) {
          return { snapshot: current, messageWaitExhausted: false };
        }
        if (currentMessage === null && iterationTurnState(current?.thread) === "completed") {
          watchedCompletedTurnWithoutMessage = true;
          maxReads = MAX_ABSENT_MESSAGE_SETTLE_READS;
        }
        previous = current;
      }
      const settledMessage = resolveFinalAssistantMessage(previous?.thread);
      yield* Effect.logWarning("epic.runner.final-message-never-settled", {
        threadId,
        messageProjected: settledMessage !== null,
      });
      return {
        snapshot: previous,
        messageWaitExhausted: watchedCompletedTurnWithoutMessage && settledMessage === null,
      };
    });

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
        const turnStatus = iterationTurnState(thread);
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
            const turnState = iterationTurnState(snapshot?.thread);
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
              const turnState = iterationTurnState(thread);
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
 * resolution matches the terminal coordinator (`run.sh:2011-2024`): the
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
