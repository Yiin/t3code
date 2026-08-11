/**
 * The parallel epic loop shared by the server runner and conformance drivers.
 *
 * This is a semantic port of the server EpicRunner's private loop: worker
 * pool, two-phase dispatch with the pause race guard, settle classification,
 * merge enqueue and drain-before-dispatch, provider fallback, and the boundary
 * policy writes. Every externally visible effect — store writes, process
 * probes, dispatches, publishes — keeps its original order. Adapters supply
 * the machinery through the ports below; the loop never imports server
 * configuration.
 */
import {
  EpicRunId,
  type ModelSelection,
  type ProviderDriverKind,
  ThreadId,
  epicRunIterationThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";

import {
  EpicRunnerDispatchError,
  EpicRunnerStoreError,
  EpicRunNotFoundError,
  type EpicRunnerError,
} from "./Errors.ts";
import {
  decideIterationBoundary,
  parseIntegrationFixTitle,
  parseMergeFixTitle,
  persistedFailureReason,
} from "./policy.ts";
import {
  classifyIteration,
  iterationFailureClass,
  type EpicIterationOutcome,
} from "./ralphProtocol.ts";
import type { DispatchError, FinalMessageRead, IterationSettle } from "./ports/AgentDispatch.ts";
import type { PoolDispatchShape } from "./ports/PoolDispatch.ts";
import type { ProviderInventoryShape } from "./ports/ProviderInventory.ts";
import { CHILD_CLAIM_RELEASED_REASON, type RunEvent } from "./ports/RunEvents.ts";
import type { RunJournalShape } from "./ports/RunJournal.ts";
import type { WorkerEvidenceShape } from "./ports/WorkerEvidence.ts";
import type { IterationWorkspace, PoolRunContext, WorkspaceShape } from "./ports/Workspace.ts";
import type { PoolPolicy } from "./runPolicy.ts";
import { resolveEpicProviderFallback } from "./providerFallback.ts";
import {
  makeWorkerLivenessConfig,
  superviseWorker,
  workerLivenessEventDetail,
  type SupervisionClock,
} from "./workerSupervision.ts";

/** The per-run resolved timing the dispatch adapter needs. */
export type PoolTimings = Pick<
  PoolPolicy,
  "pollIntervalMs" | "quietPeriodMs" | "subagentGraceTimeoutMs" | "maxGraceContinuations"
>;

/** The pool journal adds atomic iteration allocation and provider degradation. */
export interface PoolRunJournalShape extends RunJournalShape {
  readonly allocateIteration: (input: {
    readonly runId: EpicRunId;
    readonly issueId: string | null;
    readonly branch: string | null;
    readonly worktreePath: string | null;
    readonly startedAt: string;
  }) => Effect.Effect<number, import("./ports/RunJournal.ts").RunJournalError>;
  readonly upsertProviderDegradation: (input: {
    readonly providerInstanceId: ModelSelection["instanceId"];
    readonly failureReason: string;
    readonly degradedAt: string;
  }) => Effect.Effect<void, import("./ports/RunJournal.ts").RunJournalError>;
  readonly clearProviderDegradation: (input: {
    readonly providerInstanceId: ModelSelection["instanceId"];
  }) => Effect.Effect<void, import("./ports/RunJournal.ts").RunJournalError>;
}

/** The ready frontier of one epic, as the loop consumes it. */
export type ReadyFrontierSelection =
  | { readonly _tag: "children"; readonly issueIds: ReadonlyArray<string> }
  | { readonly _tag: "empty" }
  | { readonly _tag: "unrecognised"; readonly candidateIds: ReadonlyArray<string> };

export interface IssueEvidenceRead {
  readonly status: string | null;
  readonly title: string | null;
  readonly commentCount: number;
}

/**
 * The backlog reads the pool loop needs. Evidence reads never fail: an
 * unreadable issue yields conservative nulls, exactly like the server's
 * probes, and the loop treats unknown as unproven.
 */
export interface PoolBacklogShape {
  readonly readyFrontier: (
    cwd: string,
    epicId: string,
  ) => Effect.Effect<ReadyFrontierSelection, import("./ports/Backlog.ts").BacklogError>;
  readonly countOpenChildren: (
    cwd: string,
    epicId: string,
  ) => Effect.Effect<number, import("./ports/Backlog.ts").BacklogError>;
  readonly issueEvidence: (cwd: string, issueId: string) => Effect.Effect<IssueEvidenceRead>;
  readonly issueIsResearch: (
    cwd: string,
    issueId: string,
    title: string | null,
  ) => Effect.Effect<boolean>;
  readonly epicDescription: (cwd: string, epicId: string) => Effect.Effect<string | null>;
  /**
   * Reopen a still-claimed child. Never fails; the adapter logs. Returns
   * whether a standing claim was actually released, so the loop can publish
   * the claim-recovery event exactly once per exhausted child.
   */
  readonly releaseClaimedChild: (cwd: string, issueId: string) => Effect.Effect<boolean>;
}

export type MergeDrainResult =
  | { readonly _tag: "idle" }
  | {
      readonly _tag: "drained";
      /**
       * Active queue entries this drain left untouched because an
       * operator-base integration conflict (t3code-sha) stopped it before
       * any entry was even marked draining. Omitted on every unaffected
       * drain.
       */
      readonly blocked?: number;
    }
  | { readonly _tag: "deferred" }
  | { readonly _tag: "fatal"; readonly detail: string };

/** Merge-queue writes and the queued-branch drain the scheduler runs. */
export interface MergeDrainShape {
  readonly drain: (run: PoolRunContext) => Effect.Effect<MergeDrainResult, EpicRunnerError>;
  readonly enqueueMerge: (input: {
    readonly runId: EpicRunId;
    readonly childId: string;
    readonly branch: string;
  }) => Effect.Effect<void, import("./ports/RunJournal.ts").RunJournalError>;
  readonly findParkedOriginalChild: (input: {
    readonly runId: EpicRunId;
    readonly branch: string;
  }) => Effect.Effect<Option.Option<string>, import("./ports/RunJournal.ts").RunJournalError>;
  /**
   * Resync the merge queue's accepted HEAD after a run-level integration-fix
   * child (t3code-sha) commits its resolution directly onto the run's base
   * branch. That commit advances the base branch's ref without landing any
   * queue entry, so nothing else updates the persisted accepted HEAD — skip
   * this and the very next drain reads the base branch as having "moved
   * externally" and fails the run.
   */
  readonly recordIntegratedHead: (run: PoolRunContext) => Effect.Effect<void, EpicRunnerError>;
}

/** Never-failing git probes; `null` never counts as progress. */
export interface PoolVcsShape {
  /**
   * `git rev-parse --verify -q <ref>`. `ref` defaults to `HEAD` — the branch
   * actually checked out at `cwd`. A run-owned base branch (t3code-5m4) is
   * never checked out at `cwd`, so its callers pass the branch name
   * explicitly instead.
   */
  readonly headCommit: (cwd: string, ref?: string) => Effect.Effect<string | null>;
  readonly worktreeFingerprint: (cwd: string) => Effect.Effect<string | null>;
  readonly commitsAhead: (input: {
    readonly cwd: string;
    readonly base: string;
    readonly branch: string;
  }) => Effect.Effect<number | null>;
}

/**
 * Observable state changes produced by the pool loop. The server adapter
 * publishes run changes to PubSub and no-ops iteration changes (they reach
 * the UI through the next run publish, exactly as before the rewire).
 */
export interface PoolRunEventsShape {
  readonly publish: (event: RunEvent) => Effect.Effect<void, EpicRunnerError>;
}

type ReadyChildSelection =
  | { readonly _tag: "child"; readonly issueId: string }
  | { readonly _tag: "unrecognised"; readonly candidateIds: ReadonlyArray<string> };

type RunIterationResult =
  | { readonly _tag: "dispatch-skipped"; readonly providerTurnDispatched: false }
  | {
      readonly _tag: "classified";
      readonly outcome: EpicIterationOutcome;
      readonly noCommitChildClosed: boolean;
      readonly providerTurnDispatched: boolean;
      readonly issueId: string;
      readonly iterationIndex: number;
      /** True when the loop reopened this child's standing claim after failure. */
      readonly claimReleased: boolean;
    }
  | {
      readonly _tag: "ready-unrecognised";
      readonly candidateIds: ReadonlyArray<string>;
      readonly detail: string;
      readonly providerTurnDispatched: false;
    };

/**
 * How an iteration's turn stopped, before its output has been classified. A
 * settled turn carries its observed settle so classification can fall back to
 * it when the final-message read carries no projection state.
 */
type IterationSettleResult =
  | { readonly _tag: "settled"; readonly settle: IterationSettle }
  | { readonly _tag: "timeout" }
  /** The liveness machine confirmed the worker was dead before it settled. */
  | { readonly _tag: "supervision-stopped"; readonly reason: string }
  | { readonly _tag: "dispatch-failed"; readonly detail: string };

/**
 * The persisted failure reason for a supervision stop.
 *
 * Distinct from `timeout` on purpose: a wedged worker stopped after 30 idle
 * minutes and a worker that ran past its wall-clock cap are different faults
 * with different fixes, and reading them as one hid the 2026-08-09 incident
 * for 3h16m.
 */
const WORKER_LIVENESS_STOP_REASON = "worker-liveness-stop";

/**
 * What the loop does when it reaches an iteration boundary.
 *
 * Returned from *inside* the transition lock so the decision and the write it
 * implies cannot be split by a concurrent pause or resume, while the wait a
 * failed iteration owes stays outside the lock.
 */
type LoopBoundary =
  | { readonly _tag: "stop" }
  | {
      readonly _tag: "continue";
      readonly delayMs: number;
      readonly providerFallbackApplied: boolean;
    };

const LOOP_STOP: LoopBoundary = { _tag: "stop" };

/**
 * How long the merge drain may keep deferring before the run gives up.
 *
 * A deferral means the merge slot is held by someone else. That is legitimate
 * while another holder finishes a merge set, so the bound is generous. It is
 * not legitimate indefinitely: an absent or stale slot defers every attempt,
 * and without a bound the loop spins on it for as long as the process lives
 * while still heartbeating its run lock.
 */
const MERGE_DRAIN_DEFERRAL_LIMIT_MS = 600_000;

/** How often a still-deferring drain says so, so the spin is visible early. */
const MERGE_DRAIN_DEFERRAL_LOG_INTERVAL_MS = 30_000;

interface ActiveIteration {
  charged: boolean;
  readonly modelSelection: ModelSelection;
  /**
   * This worker is an integration-fix child (t3code-sha), dispatched directly
   * onto the run's own base branch. Set as soon as the title is known — before
   * the workspace is even acquired, so the window this covers is a superset
   * of the base branch actually being checked out — and left `true` until the
   * settlement event for this key is consumed, which is after this worker's
   * whole iteration Effect (including its `workspace.release` finalizer and
   * its `recordIntegratedHead` resync) has completed.
   *
   * The pool loop refuses to drain while any active worker has this set, so
   * the merge queue's "moved externally" head guard and its fast-forward
   * landing never run concurrently with the one worker allowed to move the
   * base branch out from under them.
   */
  isIntegrationFix: boolean;
}

interface WorkerSettlement {
  readonly _tag: "settlement";
  readonly key: string;
  readonly modelSelection: ModelSelection;
  readonly exit: Exit.Exit<RunIterationResult, EpicRunnerError>;
}

export type PoolSchedulerEvent = WorkerSettlement | { readonly _tag: "retune" };

interface PendingProviderFallback {
  readonly issueId: string;
  readonly iterationIndex: number;
  readonly from: ModelSelection;
  readonly fromDriver: ProviderDriverKind;
  readonly to: ModelSelection;
  readonly toDriver: ProviderDriverKind;
  readonly failureReason: string;
}

export interface ParallelEpicLoopInput {
  readonly runId: EpicRunId;
  readonly epicId: string;
  readonly cwd: string;
  readonly policy: PoolPolicy;
  /** Serializes every run-status write. Never held across an agent turn. */
  readonly withTransition: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  /** Settlement events the loop offers into; the server offers `retune`. */
  readonly signals: Queue.Queue<PoolSchedulerEvent>;
  readonly readOrientation: (
    cwd: string,
    configuredPath: string | null,
  ) => Effect.Effect<string | null>;
  /** When true (cancel owns cleanup), the finalizer skips its own cleanup. */
  readonly cleanupOwnedExternally: () => boolean;
}

export interface ParallelEpicLoopPorts {
  readonly journal: PoolRunJournalShape;
  readonly events: PoolRunEventsShape;
  readonly backlog: PoolBacklogShape;
  readonly workspace: WorkspaceShape;
  readonly dispatch: PoolDispatchShape;
  readonly mergeDrain: MergeDrainShape;
  readonly vcs: PoolVcsShape;
  /** `null` disables provider fallback, mirroring an absent registry. */
  readonly providerInventory: ProviderInventoryShape | null;
  /**
   * `null` disables per-worker liveness supervision, mirroring a host with no
   * sampling target. A run with no evidence port behaves exactly as it did
   * before supervision was wired: only `iterationTimeoutMs` bounds a worker.
   */
  readonly workerEvidence: WorkerEvidenceShape | null;
  /**
   * Overrides the clock the supervision cadence runs on. Absent means the
   * host clock; tests inject a fake so a 30-minute idle window costs no wall
   * time.
   */
  readonly supervisionClock?: SupervisionClock | undefined;
}

export const assembleIterationPrompt = (input: {
  readonly basePrompt: string;
  readonly issueId: string;
  readonly epicContext: string | null;
  readonly orientationCard: string | null;
  /** The per-worker sibling rule, spliced beside the orientation card. */
  readonly siblingRule?: string | null;
}): string =>
  `${input.basePrompt}\n\nCook exactly \`${input.issueId}\` this iteration.\n\n## Epic context (resolved at dispatch)\n\n${input.epicContext ?? "(epic description unavailable)"}\n\n${input.orientationCard ?? "(no orientation card in this repo)"}${input.siblingRule ? `\n\n${input.siblingRule}` : ""}`;

const noCommitEvidenceVerdict = (input: {
  readonly status: string | null;
  readonly isResearch: boolean;
  readonly commentsBefore: number;
  readonly commentsAfter: number;
}): { readonly accepted: boolean; readonly failureReason: string | null } => {
  if (input.status !== "closed") {
    return { accepted: false, failureReason: "no-commit-child-open" };
  }
  if (input.commentsAfter <= input.commentsBefore) {
    return {
      accepted: false,
      failureReason: input.isResearch ? "closed-without-findings" : "no-commit-no-evidence",
    };
  }
  return { accepted: true, failureReason: null };
};

/** The dispatch-failure detail persisted as the iteration's summary. */
const settleErrorDetail = (error: EpicRunnerDispatchError | DispatchError): string =>
  error._tag === "EpicRunnerDispatchError" ? error.message : `${error.operation}: ${error.detail}`;

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

export const runParallelEpicLoop = (
  input: ParallelEpicLoopInput,
  ports: ParallelEpicLoopPorts,
): Effect.Effect<void, EpicRunnerError> => {
  const { policy, withTransition } = input;
  const runId = input.runId;

  const storeError = (operation: string) => (cause: unknown) =>
    new EpicRunnerStoreError({ operation, cause });

  const journalError = (operation: string) => (cause: { readonly operation: string }) =>
    new EpicRunnerStoreError({ operation, cause });

  const backlogError = (cause: {
    readonly operation: string;
    readonly detail: string;
    readonly cause?: unknown;
  }) =>
    new EpicRunnerDispatchError({
      commandType: cause.operation,
      detail: cause.detail,
      ...(cause.cause === undefined ? {} : { cause: cause.cause }),
    });

  const requireRun = (id: EpicRunId) =>
    ports.journal.getRun(id).pipe(
      Effect.mapError(storeError("getRun")),
      Effect.flatMap((run) =>
        Option.isNone(run)
          ? Effect.fail(new EpicRunNotFoundError({ runId: id }))
          : Effect.succeed(run.value),
      ),
    );

  /**
   * Per-child attempt budgets, shared with the sequential loop: a child that
   * absorbs `maxAttemptsPerChild` child-class failures fails the run, and a
   * released claim is announced exactly once. Telemetry never fails the loop.
   */
  const childAttempts = new Map<string, number>();
  const exhaustedIterations = new Map<string, number>();
  const publishedRecoveryEvents = new Set<string>();
  const publishClaimRecovery = (issueId: string, iterationIndex: number): Effect.Effect<void> => {
    publishedRecoveryEvents.add(issueId);
    return ports.events
      .publish({
        type: "child-claim-released",
        runId,
        issueId,
        iterationIndex,
        reason: CHILD_CLAIM_RELEASED_REASON,
      })
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("epic.runner.publish-claim-recovery-failed", {
            runId,
            issueId,
            cause,
          }),
        ),
      );
  };

  const saveRun = (run: import("./ports/RunJournal.ts").PersistedEpicRun) =>
    ports.journal
      .saveRun(run)
      .pipe(
        Effect.mapError(storeError("upsertRun")),
        Effect.andThen(ports.events.publish({ type: "run-state-changed", run })),
        Effect.asVoid,
      );

  const publishIteration = (iteration: import("./ports/RunJournal.ts").PersistedEpicRunIteration) =>
    ports.events.publish({ type: "iteration-state-changed", iteration });

  const iterationCommitted = (args: {
    readonly workspace: IterationWorkspace;
    readonly headBefore: string | null;
    readonly branchBase: string | null;
    readonly siblingHeadsBefore: ReadonlyArray<{
      readonly worktreePath: string;
      readonly head: string | null;
    }>;
  }): Effect.Effect<boolean> =>
    Effect.gen(function* () {
      const headAfter = yield* ports.vcs.headCommit(args.workspace.cwd);
      if (headAfter !== null && headAfter !== args.headBefore) return true;
      // A child's effects can live in any repo of the set: a commit in any
      // sibling worktree counts as committed
      // (`skills/cook-epic/run-legacy.sh:2606-2613`).
      for (const sibling of args.siblingHeadsBefore) {
        const siblingAfter = yield* ports.vcs.headCommit(sibling.worktreePath);
        if (siblingAfter !== null && siblingAfter !== sibling.head) return true;
      }
      if (args.workspace.branch === null || args.branchBase === null) return false;
      const count = yield* ports.vcs.commitsAhead({
        cwd: args.workspace.cwd,
        base: args.branchBase,
        branch: args.workspace.branch,
      });
      return count !== null && count > 0;
    });

  const runIteration = (args: {
    readonly runCtx: PoolRunContext;
    readonly run: import("./ports/RunJournal.ts").PersistedEpicRun;
    readonly selection: ReadyChildSelection;
    readonly onDispatched: (threadId: ThreadId) => void;
    /**
     * Fired once the child's title is known — before the workspace is
     * acquired — when this iteration is an integration-fix child (t3code-sha).
     * Never fired for any other child.
     *
     * `launch` already resolves the same title synchronously before forking
     * this iteration's fiber, so in the ordinary case this only reconfirms a
     * flag already set. It stays as a fallback: if that resolution and this
     * one ever disagree (e.g. a re-fetch reads a different title), a late
     * `true` here still corrects a `false` that slipped through.
     */
    readonly onIntegrationFixDetected: () => void;
  }): Effect.Effect<RunIterationResult, EpicRunnerError> => {
    let releaseContext: { readonly workspace: IterationWorkspace } | null = null;
    let releaseError: EpicRunnerError | null = null;
    return Effect.gen(function* () {
      const run = args.run;
      const selection = args.selection;
      const startedAt = yield* nowIso;

      if (selection._tag === "unrecognised") {
        const iterationIndex = yield* withTransition(
          Effect.gen(function* () {
            const current = yield* requireRun(runId);
            if (current.status !== "running") return null;
            return yield* ports.journal
              .allocateIteration({
                runId,
                issueId: null,
                branch: null,
                worktreePath: null,
                startedAt,
              })
              .pipe(Effect.mapError(journalError("allocateIteration")));
          }),
        );
        if (iterationIndex === null) {
          return { _tag: "dispatch-skipped", providerTurnDispatched: false } as const;
        }
        const detail = `bd ready returned no usable child for ${input.epicId}; candidates: ${selection.candidateIds.join(", ")}`;
        yield* Effect.logError("epic.runner.ready-unrecognised", {
          runId,
          epicId: input.epicId,
          iterationIndex,
          candidateIds: selection.candidateIds,
        });
        yield* publishIteration({
          runId,
          iterationIndex,
          threadId: ThreadId.make(epicRunIterationThreadId({ runId, iterationIndex })),
          issueId: null,
          turnStatus: "running",
          summary: null,
          why: null,
          failureReason: null,
          startedAt,
          finishedAt: null,
        });
        // Allocation writes the synthetic running row before this terminal
        // update. Its null issue id prevents a public thread reference.
        const finishedAt = yield* nowIso;
        yield* ports.journal
          .updateIteration({
            runId,
            iterationIndex,
            turnStatus: "failed",
            summary: detail,
            why: null,
            failureReason: "infra:ready-unrecognised",
            finishedAt,
          })
          .pipe(Effect.mapError(journalError("updateIteration")));
        yield* publishIteration({
          runId,
          iterationIndex,
          threadId: ThreadId.make(epicRunIterationThreadId({ runId, iterationIndex })),
          issueId: null,
          turnStatus: "failed",
          summary: detail,
          why: null,
          failureReason: "infra:ready-unrecognised",
          startedAt,
          finishedAt,
        });
        return {
          _tag: "ready-unrecognised",
          candidateIds: selection.candidateIds,
          detail,
          providerTurnDispatched: false,
        } as const;
      }

      const issueId = selection.issueId;
      const issueEvidenceBefore = yield* ports.backlog.issueEvidence(input.cwd, issueId);
      // Flag this worker to the pool loop before it can possibly touch the
      // base branch (t3code-sha): the workspace acquire just below is what
      // actually checks the base branch out for this child, so the flag is
      // set with room to spare rather than tightly around the acquire call.
      if (parseIntegrationFixTitle(issueEvidenceBefore.title ?? "") !== null) {
        args.onIntegrationFixDetected();
      }
      const workspace = yield* ports.workspace.acquire(args.runCtx, {
        issueId,
        issueTitle: issueEvidenceBefore.title?.trim() || issueId,
        sequential: run.config.execution.sequential,
      });
      releaseContext = { workspace };
      const branchBase = workspace.branch === null ? null : yield* ports.vcs.headCommit(input.cwd);
      const epicContext = yield* ports.backlog.epicDescription(input.cwd, input.epicId);
      const orientationCard = yield* input.readOrientation(input.cwd, run.orientationFile);
      const headBefore = yield* ports.vcs.headCommit(workspace.cwd);
      const siblingHeadsBefore = yield* Effect.forEach(workspace.siblingWorktrees, (sibling) =>
        Effect.map(ports.vcs.headCommit(sibling.worktreePath), (head) => ({
          worktreePath: sibling.worktreePath,
          head,
        })),
      );
      const initialWorktreeFingerprint = yield* ports.vcs.worktreeFingerprint(workspace.cwd);
      const commentsBefore = issueEvidenceBefore.commentCount;
      const isResearchChild = yield* ports.backlog.issueIsResearch(
        input.cwd,
        issueId,
        issueEvidenceBefore.title,
      );

      const allocated = yield* withTransition(
        Effect.gen(function* () {
          const current = yield* requireRun(runId);
          if (current.status !== "running") return null;
          const iterationIndex = yield* ports.journal
            .allocateIteration({
              runId,
              issueId,
              branch: workspace.branch,
              worktreePath: workspace.worktreePath,
              startedAt,
            })
            .pipe(Effect.mapError(journalError("allocateIteration")));
          const threadId = ThreadId.make(epicRunIterationThreadId({ runId, iterationIndex }));
          yield* ports.dispatch.createIteration({
            runId,
            iterationIndex,
            threadId,
            projectId: current.projectId,
            title: `${input.epicId} · iteration ${iterationIndex + 1}`,
            selection: current.modelSelection,
            runtimeMode: current.runtimeMode,
            branch: workspace.branch,
            worktreePath: workspace.worktreePath,
            startedAt,
            policy,
          });
          return { iterationIndex, threadId } as const;
        }),
      );
      if (allocated === null) {
        return { _tag: "dispatch-skipped", providerTurnDispatched: false } as const;
      }
      const { iterationIndex, threadId } = allocated;

      yield* publishIteration({
        runId,
        iterationIndex,
        threadId,
        issueId,
        turnStatus: "running",
        summary: null,
        why: null,
        failureReason: null,
        startedAt,
        finishedAt: null,
      });

      if (workspace.branch !== null && workspace.worktreePath !== null) {
        yield* ports.dispatch.prepareIteration({
          threadId,
          projectId: run.projectId,
          runCwd: input.cwd,
          worktreePath: workspace.worktreePath,
          branch: workspace.branch,
        });
      }

      // Re-check under the same transition lock that charges and starts the
      // provider turn. A durable pause therefore cannot be followed by a new
      // provider dispatch.
      const dispatched = yield* withTransition(
        Effect.gen(function* () {
          const current = yield* requireRun(runId);
          if (current.status !== "running") {
            const abandonedAt = yield* nowIso;
            yield* ports.journal
              .updateIteration({
                runId,
                iterationIndex,
                turnStatus: "abandoned",
                summary: `dispatch skipped after run became ${current.status}`,
                why: null,
                failureReason: "cancelled",
                finishedAt: abandonedAt,
              })
              .pipe(Effect.mapError(journalError("updateIteration")));
            return null;
          }
          const dispatchedAt = yield* nowIso;
          const next = {
            ...current,
            currentThreadId: threadId,
            currentTurnStartedAt: dispatchedAt,
            iterationsDispatched: current.iterationsDispatched + 1,
            updatedAt: dispatchedAt,
          };
          yield* saveRun(next);
          args.onDispatched(threadId);
          const started = yield* ports.dispatch
            .beginTurn({
              threadId,
              prompt: assembleIterationPrompt({
                basePrompt: next.prompt,
                issueId,
                epicContext,
                orientationCard,
                siblingRule: workspace.siblingRule,
              }),
              selection: next.modelSelection,
              runtimeMode: next.runtimeMode,
              policy,
              runId,
              iterationIndex,
              workspace,
              headBefore,
              branchBase,
              initialWorktreeFingerprint,
            })
            .pipe(
              Effect.match({
                onFailure: (error) => ({ handle: null, error }),
                onSuccess: (handle) => ({ handle, error: null }),
              }),
            );
          return { run: next, ...started } as const;
        }),
      );
      if (dispatched === null) {
        yield* ports.dispatch.stopAbandoned(threadId);
        return { _tag: "dispatch-skipped", providerTurnDispatched: false } as const;
      }

      const settleIteration: Effect.Effect<
        IterationSettleResult,
        EpicRunnerDispatchError | DispatchError
      > =
        dispatched.error === null
          ? Effect.map(
              dispatched.handle.awaitSettled,
              (settle): IterationSettleResult => ({ _tag: "settled", settle }),
            )
          : Effect.fail(dispatched.error);
      const boundedIteration: Effect.Effect<
        IterationSettleResult,
        EpicRunnerDispatchError | DispatchError
      > =
        policy.iterationTimeoutMs === null
          ? settleIteration
          : settleIteration.pipe(
              Effect.timeoutOption(Duration.millis(policy.iterationTimeoutMs)),
              Effect.map(
                (result): IterationSettleResult =>
                  Option.isNone(result) ? { _tag: "timeout" } : result.value,
              ),
            );
      /**
       * Per-worker liveness supervision, raced against the worker's own
       * settlement so a wedged worker ends its iteration instead of holding a
       * pool slot until the run dies.
       *
       * `iterationTimeoutMs` only catches a worker that runs too *long*. The
       * 2026-08-09 incident was a worker that stopped running at all: 0.8s of
       * CPU across 12 minutes, every process asleep, held for 3h16m. The
       * liveness machine reads exactly those deltas.
       *
       * Supervision never completes on a healthy worker, so `raceFirst`
       * interrupts it as soon as the turn settles.
       */
      const supervised: Effect.Effect<
        IterationSettleResult,
        EpicRunnerDispatchError | DispatchError
      > =
        ports.workerEvidence === null || dispatched.handle === null
          ? boundedIteration
          : Effect.raceFirst(
              boundedIteration,
              superviseWorker({
                ref: { worker: dispatched.handle.ref, repositoryPath: workspace.cwd },
                child: issueId,
                config: makeWorkerLivenessConfig({
                  supervision: dispatched.run.config.supervision,
                  inspectorSupported: ports.workerEvidence.inspectorSupported,
                }),
                evidence: ports.workerEvidence,
                clock: ports.supervisionClock,
                emit: (event) =>
                  ports.events
                    .publish({
                      type: "worker-liveness",
                      runId,
                      iterationIndex,
                      issueId,
                      stage: event.type,
                      detail: workerLivenessEventDetail(event),
                    })
                    .pipe(Effect.ignore),
              }).pipe(
                Effect.map(
                  (verdict): IterationSettleResult => ({
                    _tag: "supervision-stopped",
                    reason: verdict.reason,
                  }),
                ),
              ),
            );

      const settleResult: IterationSettleResult = yield* supervised.pipe(
        Effect.catch((error) =>
          Effect.succeed<IterationSettleResult>({
            _tag: "dispatch-failed",
            detail: settleErrorDetail(error),
          }),
        ),
      );

      const supervisionStop =
        settleResult._tag === "supervision-stopped" ? settleResult.reason : null;
      const timedOut = settleResult._tag === "timeout";
      // Both early ends interrupt the turn before it is classified. A worker
      // the machine confirmed dead is treated like a timed-out one: interrupt
      // first, then the forced stop further down.
      if ((timedOut || supervisionStop !== null) && dispatched.handle !== null) {
        yield* dispatched.handle.interrupt.pipe(Effect.ignore);
      }

      const outcome: EpicIterationOutcome =
        settleResult._tag === "dispatch-failed"
          ? {
              kind: "error",
              detail: settleResult.detail,
              report: null,
            }
          : supervisionStop !== null
            ? {
                // `timeout` is the right budget: the worker never delivered
                // and the fault is infrastructure, not the agent. The reason
                // below keeps it separable from a wall-clock timeout.
                kind: "timeout",
                detail: `worker liveness supervision stopped this worker: ${supervisionStop}`,
                report: null,
                failureReason: WORKER_LIVENESS_STOP_REASON,
              }
            : yield* Effect.gen(function* () {
                const committed = yield* iterationCommitted({
                  workspace,
                  headBefore,
                  branchBase,
                  siblingHeadsBefore,
                });
                // A timed-out turn was just interrupted and may still be
                // streaming, so there is nothing to wait for.
                const final: FinalMessageRead =
                  timedOut || dispatched.handle === null
                    ? {
                        text: null,
                        streaming: false,
                        waitExhausted: false,
                      }
                    : yield* dispatched.handle.finalMessage.pipe(
                        Effect.orElseSucceed(
                          (): FinalMessageRead => ({
                            text: null,
                            streaming: false,
                            waitExhausted: false,
                          }),
                        ),
                      );
                const settle = settleResult._tag === "settled" ? settleResult.settle : null;
                return classifyIteration({
                  turnState: timedOut ? null : (final.turnState ?? settle?.turnState ?? null),
                  finalMessage:
                    final.text === null ? null : { text: final.text, streaming: final.streaming },
                  finalMessageWaitExhausted: final.waitExhausted,
                  sessionLastError: timedOut
                    ? null
                    : (final.sessionLastError ?? settle?.providerError ?? null),
                  assistantProviderErrorsTrusted:
                    dispatched.handle?.capabilities.providerErrors === "session-and-assistant",
                  committed,
                  timedOut,
                });
              });

      const finishedAt = yield* nowIso;

      // Settlement is user-owned. EpicRunner only releases the provider
      // session after an iteration ends. Normal cleanup uses an atomic
      // subagent guard; timeout and dispatch-failure paths remain forced
      // stops, and the timeout interrupt above always precedes its stop. A
      // failed dispatch has no handle, but its thread may hold a session, so
      // the forced stop runs regardless.
      if (settleResult._tag === "settled") {
        if (dispatched.handle !== null) {
          yield* dispatched.handle.release.pipe(Effect.ignore);
        }
      } else {
        yield* ports.dispatch.stopForced(threadId).pipe(Effect.ignore);
      }

      // A turn that ends cleanly with no commit only counts as completed
      // when the agent both closed its child and added bead evidence after
      // dispatch. Research children use a distinct failure reason because
      // findings are their required deliverable. An unreadable settlement
      // cannot prove either condition and is rejected conservatively.
      const issueEvidenceAfter =
        outcome.kind === "no-commit"
          ? yield* ports.backlog.issueEvidence(input.cwd, issueId)
          : null;
      const evidenceVerdict =
        issueEvidenceAfter === null
          ? null
          : noCommitEvidenceVerdict({
              status: issueEvidenceAfter.status,
              isResearch: isResearchChild,
              commentsBefore,
              commentsAfter: issueEvidenceAfter.commentCount,
            });
      const noCommitChildClosed = evidenceVerdict?.accepted ?? false;

      if (!run.config.execution.sequential && workspace.branch !== null) {
        const integrationFix = parseIntegrationFixTitle(issueEvidenceBefore.title ?? "");
        if (integrationFix !== null) {
          // The child was dispatched directly onto the run's base branch
          // (t3code-sha); committing there already advanced it, whether or
          // not the turn itself ended cleanly. A fix child that commits the
          // resolved merge and then times out or hits a provider error still
          // moved the base — gating this resync on `outcome.kind === "done"`
          // left `lastAcceptedHead` stale in exactly that case, so the next
          // drain read the moved base as an external move and failed the run
          // for something the coordinator's own child did. Resync on the
          // observable fact instead: the head actually moved.
          const headAfter = yield* ports.vcs.headCommit(workspace.cwd);
          if (headAfter !== null && headAfter !== headBefore) {
            yield* ports.mergeDrain.recordIntegratedHead(args.runCtx);
          }
        } else if (outcome.kind === "done") {
          const mergeFix = parseMergeFixTitle(issueEvidenceBefore.title ?? "");
          const originalChild =
            mergeFix === null
              ? issueId
              : Option.getOrThrow(
                  yield* ports.mergeDrain
                    .findParkedOriginalChild({ runId, branch: workspace.branch })
                    .pipe(Effect.mapError(journalError("findParkedOriginalChild"))),
                );
          yield* ports.mergeDrain
            .enqueueMerge({ runId, childId: originalChild, branch: workspace.branch })
            .pipe(Effect.mapError(journalError("enqueueMerge")));
        }
      }

      const iterationStatus =
        outcome.kind === "backlog-empty" || outcome.kind === "done" || noCommitChildClosed
          ? ("completed" as const)
          : ("failed" as const);
      const failureReason = persistedFailureReason({
        iterationStatus,
        dispatchFailed: settleResult._tag === "dispatch-failed",
        evidenceFailureReason: evidenceVerdict?.failureReason ?? null,
        outcome,
      });

      yield* ports.journal
        .updateIteration({
          runId,
          iterationIndex,
          turnStatus: iterationStatus,
          summary: outcome.report?.summary ?? outcome.detail,
          why: outcome.report?.why ?? null,
          failureReason,
          finishedAt,
        })
        .pipe(Effect.mapError(journalError("updateIteration")));
      yield* publishIteration({
        runId,
        iterationIndex,
        threadId,
        issueId,
        turnStatus: iterationStatus,
        summary: outcome.report?.summary ?? outcome.detail,
        why: outcome.report?.why ?? null,
        failureReason,
        startedAt,
        finishedAt,
      });

      // A failed iteration usually strands its claim: reopen it here so a
      // retry can re-select the same child. `done` outcomes are left to the
      // terminal sweep, which owns the done-with-unclosed-child case.
      const claimReleased =
        outcome.kind !== "done" && outcome.kind !== "backlog-empty"
          ? yield* ports.backlog.releaseClaimedChild(input.cwd, issueId)
          : false;

      yield* Effect.logInfo("epic.runner.iteration-finished", {
        runId,
        iterationIndex,
        threadId,
        outcome: outcome.kind,
        detail: outcome.detail,
      });

      return {
        _tag: "classified",
        outcome,
        noCommitChildClosed,
        providerTurnDispatched: true,
        issueId,
        iterationIndex,
        claimReleased,
      } as const;
    }).pipe(
      Effect.ensuring(
        Effect.suspend(() => {
          const context = releaseContext;
          if (context === null) return Effect.void;
          // A layout release failure is fatal to the run: leftover worktrees
          // make every later dispatch unsafe, so reconcile like a drain stop.
          return ports.workspace.release(args.runCtx, context.workspace).pipe(
            Effect.catch((error) =>
              Effect.suspend(() => {
                releaseError = error;
                return withTransition(
                  Effect.gen(function* () {
                    const current = yield* requireRun(runId);
                    if (current.status === "running") {
                      yield* saveRun({
                        ...current,
                        status: "failed" as const,
                        lastError: `infra:merge-reconciliation: ${error.message}`,
                        updatedAt: yield* nowIso,
                      });
                    }
                  }),
                ).pipe(Effect.ignore);
              }),
            ),
          );
        }),
      ),
      // Finalizers cannot carry the typed failure; raise it once the
      // iteration body has settled so the worker error path stops the run.
      Effect.flatMap((result) =>
        releaseError === null ? Effect.succeed(result) : Effect.fail(releaseError),
      ),
    );
  };

  const applyIterationBoundary = (args: {
    readonly iterationResult: RunIterationResult;
    readonly providerInstanceId: ModelSelection["instanceId"];
    readonly providerFallbackApplied: boolean;
  }): Effect.Effect<LoopBoundary, EpicRunnerError> =>
    withTransition(
      Effect.gen(function* () {
        if (args.iterationResult._tag === "dispatch-skipped") {
          return LOOP_STOP;
        }
        // Failure budgets belong to the run. Every completed worker applies
        // its boundary under this semaphore, so simultaneous settlements
        // cannot overwrite one another's counters.
        const currentRun = yield* requireRun(runId);
        const settledRun = {
          ...currentRun,
          iterationsCompleted: currentRun.iterationsCompleted + 1,
          updatedAt: yield* nowIso,
        };

        if (args.iterationResult._tag === "ready-unrecognised") {
          if (currentRun.status !== "running") {
            yield* saveRun(settledRun);
            return LOOP_STOP;
          }
          yield* saveRun({
            ...settledRun,
            status: "failed" as const,
            lastError: args.iterationResult.detail,
          });
          return LOOP_STOP;
        }

        const { outcome, noCommitChildClosed, providerTurnDispatched } = args.iterationResult;

        if (currentRun.status !== "running" && currentRun.status !== "paused") {
          yield* saveRun(settledRun);
          return LOOP_STOP;
        }

        // Per-child attempt budget, charged under the same semaphore as the
        // failure counters so parallel settlements cannot lose an increment.
        const successful =
          outcome.kind === "done" || outcome.kind === "backlog-empty" || noCommitChildClosed;
        const consumesChildAttempt = iterationFailureClass(outcome.kind) === "child";
        const attempt =
          (childAttempts.get(args.iterationResult.issueId) ?? 0) +
          (successful || !consumesChildAttempt ? 0 : 1);
        childAttempts.set(args.iterationResult.issueId, attempt);
        const childAttemptBudgetExhausted =
          !successful && consumesChildAttempt && attempt >= policy.maxAttemptsPerChild;
        if (childAttemptBudgetExhausted) {
          exhaustedIterations.set(
            args.iterationResult.issueId,
            args.iterationResult.iterationIndex,
          );
        }

        const successfulProviderTurn =
          providerTurnDispatched &&
          (outcome.kind === "done" || outcome.kind === "backlog-empty" || noCommitChildClosed);
        if (successfulProviderTurn) {
          yield* ports.journal
            .clearProviderDegradation({ providerInstanceId: args.providerInstanceId })
            .pipe(Effect.mapError(journalError("clearProviderDegradation")));
        }

        const decision = decideIterationBoundary({
          runStatus: currentRun.status,
          consecutiveFailures: currentRun.consecutiveFailures,
          noCommitStreak: currentRun.noCommitStreak,
          infraStreak: currentRun.infraStreak,
          lastError: currentRun.lastError,
          outcome,
          noCommitChildClosed,
          providerFallbackApplied: args.providerFallbackApplied,
          providerTurnDispatched,
          limits: {
            maxConsecutiveFailures: policy.maxConsecutiveFailures,
            maxNoCommitStreak: policy.maxNoCommitStreak,
            infraFailureBudget: policy.infraFailureBudget,
            retryBaseDelayMs: policy.retryBaseDelayMs,
            retryMaxDelayMs: policy.retryMaxDelayMs,
          },
        });
        if (childAttemptBudgetExhausted && args.iterationResult.claimReleased) {
          yield* publishClaimRecovery(
            args.iterationResult.issueId,
            args.iterationResult.iterationIndex,
          );
        }
        yield* saveRun({
          ...settledRun,
          ...(decision.nextStatus === null ? {} : { status: decision.nextStatus }),
          consecutiveFailures: decision.nextConsecutiveFailures,
          noCommitStreak: decision.nextNoCommitStreak,
          infraStreak: decision.nextInfraStreak,
          lastError: decision.lastError,
          ...(childAttemptBudgetExhausted
            ? {
                status: "failed" as const,
                lastError: outcome.detail ?? outcome.kind,
              }
            : {}),
        });
        return decision.action === "stop" || childAttemptBudgetExhausted
          ? LOOP_STOP
          : ({
              _tag: "continue",
              delayMs: decision.delayMs,
              providerFallbackApplied: args.providerFallbackApplied,
            } satisfies LoopBoundary);
      }),
    );

  const resolvePendingProviderFallback = (
    modelSelection: ModelSelection,
    iterationResult: RunIterationResult,
  ): Effect.Effect<PendingProviderFallback | null, EpicRunnerError> =>
    Effect.gen(function* () {
      if (
        iterationResult._tag !== "classified" ||
        iterationResult.outcome.providerFallbackEligible !== true ||
        ports.providerInventory === null
      ) {
        return null;
      }
      const providers = yield* ports.providerInventory.getProviders;
      const fallback = resolveEpicProviderFallback({
        providers,
        current: modelSelection,
        failureReason: iterationResult.outcome.failureReason,
        providerFallbackEligible: true,
      });
      if (fallback === null) return null;
      const fromProvider = providers.find(
        (provider) => provider.instanceId === modelSelection.instanceId,
      );
      const toProvider = providers.find((provider) => provider.instanceId === fallback.instanceId);
      if (fromProvider === undefined || toProvider === undefined) return null;
      return {
        issueId: iterationResult.issueId,
        iterationIndex: iterationResult.iterationIndex,
        from: modelSelection,
        fromDriver: fromProvider.driver,
        to: fallback,
        toDriver: toProvider.driver,
        failureReason:
          iterationResult.outcome.failureReason ??
          iterationResult.outcome.detail ??
          iterationResult.outcome.kind,
      };
    });

  const applyPendingProviderFallback = (pending: PendingProviderFallback) =>
    Effect.gen(function* () {
      const applied = yield* withTransition(
        Effect.gen(function* () {
          const current = yield* requireRun(runId);
          if (current.status !== "running" && current.status !== "paused") return false;
          if (current.modelSelection.instanceId !== pending.from.instanceId) return false;
          const degradedAt = yield* nowIso;
          yield* ports.journal
            .upsertProviderDegradation({
              providerInstanceId: pending.from.instanceId,
              failureReason: pending.failureReason,
              degradedAt,
            })
            .pipe(Effect.mapError(journalError("upsertProviderDegradation")));
          yield* saveRun({
            ...current,
            modelSelection: pending.to,
            updatedAt: degradedAt,
          });
          return true;
        }),
      );
      if (!applied) return;
      yield* ports.events.publish({
        type: "provider-fallback",
        runId,
        issueId: pending.issueId,
        iterationIndex: pending.iterationIndex,
        failureReason: pending.failureReason,
        fromInstanceId: pending.from.instanceId,
        fromDriver: pending.fromDriver,
        fromModel: pending.from.model,
        toInstanceId: pending.to.instanceId,
        toDriver: pending.toDriver,
        toModel: pending.to.model,
      });
      yield* Effect.logInfo("epic.runner.provider-fallback", {
        runId,
        fromInstanceId: pending.from.instanceId,
        fromModel: pending.from.model,
        toInstanceId: pending.to.instanceId,
        toModel: pending.to.model,
      });
    });

  const body = Effect.gen(function* () {
    const initialRun = yield* requireRun(runId);
    const runCtx: PoolRunContext = {
      runId,
      epicId: input.epicId,
      projectId: initialRun.projectId,
      cwd: input.cwd,
    };
    const initialMergeState = yield* ports.workspace.ensureIntegration(runCtx);
    const events = input.signals;
    const active = new Map<string, ActiveIteration>();
    let drainBeforeDispatch =
      initialMergeState?.entries.some(
        (entry) => entry.status === "queued" || entry.status === "draining",
      ) ?? false;
    // A deferred drain used to retry forever, silently. Because the run lock
    // keeps heartbeating and no worker is alive to look wrong, that presents
    // as a healthy run for as long as it lasts — one such spin ran 8 hours
    // before anyone noticed. Track the streak so it is visible, and give up
    // rather than hang.
    let deferredSince: number | null = null;
    let deferredLoggedAt = 0;
    let terminalWorkerError: EpicRunnerError | null = null;
    let pendingFallback: PendingProviderFallback | null = null;
    let syntheticSequence = 0;
    // The most recent drain's `blocked` count (t3code-sha): entries this run
    // left untouched because an operator-base integration conflict stopped
    // the drain before the per-entry loop ran. Completion honesty (D2) is
    // deferred — `done` below is still decided from the open-child count
    // alone, not from this — so logging it here is the only place the value
    // becomes observable at all; see the `done` transitions further down.
    // Follow-up filed: t3code-xig.
    let lastDrainBlocked = 0;

    const launch = (
      run: import("./ports/RunJournal.ts").PersistedEpicRun,
      selection: ReadyChildSelection,
      key: string,
    ) =>
      Effect.gen(function* () {
        // Resolved here, synchronously, before this iteration's fiber is
        // forked (t3code-sha): forking first and setting the flag inside the
        // fiber left a window where a settlement already sitting in the
        // queue could drive the loop back to the drain guard below while
        // this worker's flag still read `false`, because the forked fiber
        // had not yet run far enough to call `onIntegrationFixDetected`. A
        // drain could then start concurrently with a fix child acquiring the
        // base-branch worktree. `issueEvidence` never fails (`Effect<..,
        // never>`), so this adds no new failure path to the loop.
        //
        // Gated on `vcs.runOwnedBaseBranch` first, and deliberately so: only
        // a run that owns its base branch can ever produce an integration-fix
        // child, and this read is an extra backlog call on top of the one
        // `runIteration` already makes for the same issue. With the flag off
        // that call is pure overhead the flag-off contract forbids — it is
        // observable, because `issueEvidence` reads the child's live bead and
        // the loop compares the before/after reads to decide whether a
        // no-commit iteration earned its keep. Short-circuit `&&` skips the
        // `yield*` entirely, so the flag-off path issues exactly the calls it
        // issued before t3code-sha, in the same order.
        const isIntegrationFix =
          run.config.vcs.runOwnedBaseBranch &&
          selection._tag === "child" &&
          parseIntegrationFixTitle(
            (yield* ports.backlog.issueEvidence(input.cwd, selection.issueId)).title ?? "",
          ) !== null;
        const activeIteration: ActiveIteration = {
          charged: false,
          modelSelection: run.modelSelection,
          isIntegrationFix,
        };
        active.set(key, activeIteration);
        yield* runIteration({
          runCtx,
          run,
          selection,
          onDispatched: () => {
            activeIteration.charged = true;
          },
          onIntegrationFixDetected: () => {
            activeIteration.isIntegrationFix = true;
          },
        }).pipe(
          Effect.exit,
          Effect.flatMap((exit) =>
            Queue.offer(events, {
              _tag: "settlement",
              key,
              modelSelection: activeIteration.modelSelection,
              exit,
            }),
          ),
          Effect.forkChild,
        );
      });

    while (true) {
      const run = yield* requireRun(runId);

      // An integration-fix child (t3code-sha) is dispatched directly onto the
      // run's own base branch, and stays flagged active in this map through
      // its whole iteration — settlement, `recordIntegratedHead`, and its
      // `workspace.release` all happen before the loop ever removes it
      // (`launch` above). Draining while one is active races the merge
      // queue's own view of the base branch against the one worker allowed to
      // move it: a still-open trial sees the base moved out from under it
      // ("moved externally"), and a still-checked-out worktree refuses the
      // fast-forward that would land a queue entry. Waiting the fix child out
      // costs nothing — no new dispatch happens either while a drain is
      // pending — and the settlement event that clears this flag is what
      // wakes the loop back up.
      const integrationFixActive = [...active.values()].some((worker) => worker.isIntegrationFix);

      if (drainBeforeDispatch && !integrationFixActive) {
        const result = yield* ports.mergeDrain.drain(runCtx);
        if (result._tag === "fatal") {
          yield* withTransition(
            Effect.gen(function* () {
              const current = yield* requireRun(runId);
              if (current.status === "running") {
                yield* saveRun({
                  ...current,
                  status: "failed" as const,
                  lastError: `infra:merge-reconciliation: ${result.detail}`,
                  updatedAt: yield* nowIso,
                });
              }
            }),
          );
          return;
        }
        if (result._tag === "deferred") {
          const now = yield* Clock.currentTimeMillis;
          deferredSince ??= now;
          const stalledFor = now - deferredSince;
          if (stalledFor >= MERGE_DRAIN_DEFERRAL_LIMIT_MS) {
            yield* withTransition(
              Effect.gen(function* () {
                const current = yield* requireRun(runId);
                if (current.status === "running") {
                  yield* saveRun({
                    ...current,
                    status: "failed" as const,
                    lastError:
                      `infra:merge-slot-unavailable: the merge drain could not acquire the ` +
                      `merge slot for ${String(Math.round(stalledFor / 1000))}s, so no ` +
                      `branch can land. Check \`bd merge-slot check\`; an absent or stale ` +
                      `slot defers every attempt.`,
                    updatedAt: yield* nowIso,
                  });
                }
              }),
            );
            return;
          }
          if (now - deferredLoggedAt >= MERGE_DRAIN_DEFERRAL_LOG_INTERVAL_MS) {
            deferredLoggedAt = now;
            yield* Effect.logWarning("epic.runner.merge-drain-deferred", {
              runId,
              stalledForMs: stalledFor,
            });
          }
          yield* Effect.sleep(Duration.millis(policy.pollIntervalMs));
          continue;
        }
        deferredSince = null;
        deferredLoggedAt = 0;
        drainBeforeDispatch = false;
        lastDrainBlocked = result._tag === "drained" ? (result.blocked ?? 0) : 0;
        if (lastDrainBlocked > 0) {
          yield* Effect.logWarning("epic.runner.merge-drain-blocked", {
            runId,
            blocked: lastDrainBlocked,
          });
        }
      }
      if (active.size === 0 && terminalWorkerError !== null) {
        return yield* terminalWorkerError;
      }
      if (active.size === 0 && pendingFallback !== null) {
        const fallback = pendingFallback;
        pendingFallback = null;
        yield* applyPendingProviderFallback(fallback);
        drainBeforeDispatch = false;
        continue;
      }

      if (run.status !== "running") {
        if (active.size === 0) {
          yield* Effect.logInfo("epic.runner.loop-stopped", { runId, status: run.status });
          return;
        }
      } else if (!drainBeforeDispatch && terminalWorkerError === null && pendingFallback === null) {
        const uncharged = [...active.values()].filter((worker) => !worker.charged).length;
        const remainingDispatches = Math.max(
          0,
          policy.maxIterations - run.iterationsDispatched - uncharged,
        );
        const slots = Math.min(Math.max(0, run.workers - active.size), remainingDispatches);

        if (slots > 0) {
          const frontier = yield* ports.backlog
            .readyFrontier(input.cwd, input.epicId)
            .pipe(Effect.mapError(backlogError));
          if (frontier._tag === "empty") {
            if (active.size === 0) {
              const openChildren = yield* ports.backlog
                .countOpenChildren(input.cwd, input.epicId)
                .pipe(Effect.mapError(backlogError));
              // Completion honesty (D2, t3code-sha) is deferred: `done` below
              // is decided from `openChildren` alone, not from whether the
              // merge queue still holds entries this run never landed
              // (`lastDrainBlocked`, logged as `epic.runner.merge-drain-blocked`
              // above). A run can report `done` with parked or blocked work
              // still sitting in the queue. Follow-up filed: t3code-xig.
              yield* withTransition(
                Effect.gen(function* () {
                  const current = yield* requireRun(runId);
                  if (current.status === "running") {
                    yield* saveRun({
                      ...current,
                      status: openChildren === 0 ? ("done" as const) : ("failed" as const),
                      lastError:
                        openChildren === 0
                          ? null
                          : `infra:ready-frontier-stuck: ${openChildren} open children remain but none are ready`,
                      updatedAt: yield* nowIso,
                    });
                  }
                }),
              );
              return;
            }
          } else {
            const selections: ReadonlyArray<readonly [string, ReadyChildSelection]> =
              frontier._tag === "unrecognised"
                ? [
                    [
                      `synthetic:${syntheticSequence++}`,
                      { _tag: "unrecognised", candidateIds: frontier.candidateIds },
                    ],
                  ]
                : frontier.issueIds
                    .filter((issueId, index, issueIds) => issueIds.indexOf(issueId) === index)
                    .filter((issueId) => !active.has(issueId))
                    .map((issueId) => [issueId, { _tag: "child", issueId }] as const);
            for (const [key, selection] of selections.slice(0, slots)) {
              yield* launch(run, selection, key);
            }
          }
        } else if (active.size === 0 && run.iterationsDispatched >= policy.maxIterations) {
          // Same deferred gap as above: max-iterations also writes `done`
          // without consulting the merge queue.
          yield* withTransition(
            Effect.gen(function* () {
              const current = yield* requireRun(runId);
              if (current.status === "running") {
                yield* saveRun({
                  ...current,
                  status: "done" as const,
                  lastError: `max iterations (${policy.maxIterations}) reached`,
                  updatedAt: yield* nowIso,
                });
              }
            }),
          );
          return;
        }
      }

      if (active.size === 0) continue;

      const event = yield* Queue.take(events);
      if (event._tag === "retune") continue;
      const settlement = event;
      active.delete(settlement.key);
      if (Exit.isFailure(settlement.exit)) {
        const cause = settlement.exit.cause;
        terminalWorkerError ??= Option.getOrElse(
          Cause.findErrorOption(cause),
          () =>
            new EpicRunnerStoreError({
              operation: `iteration worker failed: ${String(cause)}`,
            }),
        );
        drainBeforeDispatch = true;
        continue;
      }

      let fallbackAppliesToBoundary = false;
      if (pendingFallback === null) {
        pendingFallback = yield* resolvePendingProviderFallback(
          settlement.modelSelection,
          settlement.exit.value,
        );
        fallbackAppliesToBoundary = pendingFallback !== null;
      }
      const boundary = yield* applyIterationBoundary({
        iterationResult: settlement.exit.value,
        providerInstanceId: settlement.modelSelection.instanceId,
        providerFallbackApplied: fallbackAppliesToBoundary,
      });
      if (
        !run.config.execution.sequential &&
        settlement.exit.value._tag === "classified" &&
        settlement.exit.value.outcome.kind === "done"
      ) {
        drainBeforeDispatch = true;
      }
      if (
        boundary._tag === "stop" ||
        boundary.providerFallbackApplied ||
        pendingFallback !== null
      ) {
        drainBeforeDispatch = true;
      }
      // Backoff stays outside the transition semaphore. Already-running
      // workers continue while dispatch waits.
      if (boundary._tag === "continue" && boundary.delayMs > 0) {
        yield* Effect.sleep(Duration.millis(boundary.delayMs));
      }
    }
  });

  return body.pipe(
    Effect.ensuring(
      Effect.gen(function* () {
        if (input.cleanupOwnedExternally()) return;
        const finalRun = yield* ports.journal.getRun(runId).pipe(
          Effect.map(Option.getOrNull),
          Effect.catchCause((cause) =>
            Effect.logWarning("epic.runner.final-run-read-failed", { runId, cause }).pipe(
              Effect.as(null),
            ),
          ),
        );
        if (
          finalRun !== null &&
          (finalRun.status === "done" ||
            finalRun.status === "cancelled" ||
            finalRun.status === "failed")
        ) {
          yield* ports.workspace.releaseIntegration(
            {
              runId,
              epicId: input.epicId,
              projectId: finalRun.projectId,
              cwd: input.cwd,
            },
            finalRun.status,
          );
        }
        // Sweep every child this run claimed and left in progress, not just
        // the latest (t3code-1bk). The adapter re-reads each issue and no-ops
        // unless it is still `in_progress`.
        const iterations = yield* ports.journal.listIterations(runId).pipe(
          Effect.map(Option.some),
          Effect.catchCause((cause) =>
            Effect.logWarning("epic.runner.release-stranded-child-lookup-failed", {
              runId,
              cause,
            }).pipe(Effect.as(Option.none())),
          ),
        );
        if (Option.isSome(iterations)) {
          const issueIds = [
            ...new Set(
              iterations.value
                .map((iteration) => iteration.issueId)
                .filter((issueId): issueId is string => issueId !== null),
            ),
          ];
          yield* Effect.forEach(
            issueIds,
            (issueId) =>
              Effect.gen(function* () {
                const released = yield* ports.backlog.releaseClaimedChild(input.cwd, issueId);
                // A claim the boundary already announced is not announced again;
                // one released only here (a crash between boundary and sweep)
                // still gets its recovery event.
                if (!released || publishedRecoveryEvents.has(issueId)) return;
                const exhaustedIterationIndex = exhaustedIterations.get(issueId);
                if (exhaustedIterationIndex === undefined) return;
                yield* publishClaimRecovery(issueId, exhaustedIterationIndex);
              }),
            { concurrency: 1, discard: true },
          );
        }
      }),
    ),
  );
};
