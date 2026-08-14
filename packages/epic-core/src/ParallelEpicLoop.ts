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
  EPIC_RUN_FAILURE_RESUME_BLOCKED,
  EPIC_RUN_FAILURE_RESUME_FAILED,
  EPIC_RUN_FAILURE_RESUME_UNSUPPORTED,
  EpicRunId,
  type ModelSelection,
  type ProviderDriverKind,
  type ProviderInstanceId,
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
  childAttemptsFromHistory,
  conflictRadarNudgePrompt,
  decideIterationBoundary,
  describeOpenChildren,
  EPIC_RUN_RESTART_HANDOFF_PROMPT,
  EPIC_RUN_RESTART_RESUME_PROMPT,
  parseIntegrationFixTitle,
  parseMergeFixTitle,
  persistedFailureReason,
  proveEpicCompletion,
  type EpicCompletionCheck,
  type EpicCompletionProof,
} from "./policy.ts";
import {
  classifyIteration,
  iterationFailureClass,
  type EpicIterationOutcome,
} from "./ralphProtocol.ts";
import type {
  AgentSelection,
  DispatchError,
  FinalMessageRead,
  IterationHandle,
  IterationResumeRefusal,
  IterationSettle,
} from "./ports/AgentDispatch.ts";
import type { PoolDispatchShape } from "./ports/PoolDispatch.ts";
import type { ProviderInventoryShape } from "./ports/ProviderInventory.ts";
import type {
  EpicDispatchRole,
  ResolvedRoleSelection,
  RoleSelectionShape,
} from "./ports/RoleSelection.ts";
import { CHILD_CLAIM_RELEASED_REASON, type RunEvent } from "./ports/RunEvents.ts";
import type { ProviderDegradationJournalShape, RunJournalShape } from "./ports/RunJournal.ts";
import type { WorkerEvidenceShape } from "./ports/WorkerEvidence.ts";
import type { IterationWorkspace, PoolRunContext, WorkspaceShape } from "./ports/Workspace.ts";
import type { PoolPolicy } from "./runPolicy.ts";
import { providerDegradationResetsAt, type ProviderUsageReadShape } from "./providerDegradation.ts";
import { resolveEpicProviderFallback } from "./providerFallback.ts";
import { RUN_STALL_WARN_INTERVAL_MS, evaluateRunStall, type RunWait } from "./runStall.ts";
import {
  makeDispatchSupervisionOptions,
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
export interface PoolRunJournalShape extends RunJournalShape, ProviderDegradationJournalShape {
  readonly allocateIteration: (input: {
    readonly runId: EpicRunId;
    readonly issueId: string | null;
    readonly branch: string | null;
    readonly worktreePath: string | null;
    /**
     * Which tier's chain this dispatch came from, and what it resolved to.
     * All three are `null` for a record that dispatches nothing.
     */
    readonly tierId: string | null;
    readonly providerInstanceId: ProviderInstanceId | null;
    readonly model: string | null;
    readonly startedAt: string;
  }) => Effect.Effect<number, import("./ports/RunJournal.ts").RunJournalError>;
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
  /**
   * Every still-open child of the epic, by id. Completion proof needs the ids
   * and not just a count, because a run that refuses to finish has to say
   * which children it is refusing over.
   */
  readonly openChildIds: (
    cwd: string,
    epicId: string,
  ) => Effect.Effect<ReadonlyArray<string>, import("./ports/Backlog.ts").BacklogError>;
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
  /**
   * Take the standing claim on a child the loop is about to resume.
   *
   * A restart cannot assume the claim survived: the run's own finalizer, or a
   * `bd` sweep, may have reopened the child while the process was down. Only
   * an `open` child is claimed; `closed` is the one answer that must stop the
   * resume, because the work is finished and continuing the session would
   * redo it. `unknown` is an unreadable bead and is never treated as closed.
   *
   * Never fails; the adapter logs.
   */
  readonly claimChild: (
    cwd: string,
    issueId: string,
  ) => Effect.Effect<"claimed" | "already-claimed" | "closed" | "unknown">;
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
  | {
      readonly _tag: "deferred";
      /** Who holds the merge slot, or `null` when it is unreadable. */
      readonly holder: string | null;
    }
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
  /**
   * Where this run integrates: the main repository the merge queue merges in,
   * and the branch every worker's branch must merge into.
   *
   * The loop core never learns the base branch name from anywhere else — it
   * dispatches by child id and reads heads by path — so the conflict radar
   * asks the party that already persists it. Never fails: `null` is a
   * sequential run, a run whose merge state is not provisioned yet, and an
   * unreadable store alike, and all three mean "no radar this tick".
   */
  readonly integrationTarget: (run: PoolRunContext) => Effect.Effect<{
    readonly repositoryPath: string;
    readonly baseBranch: string;
  } | null>;
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
  /**
   * A bounded, human-readable snapshot of what is uncommitted at `cwd`, for a
   * resumed worker's prompt. `null` when git could tell us nothing at all.
   *
   * Unlike {@link PoolVcsShape.worktreeFingerprint} this is never compared,
   * only shown, so it is truncated rather than kept verbatim.
   */
  readonly worktreeEvidence: (cwd: string) => Effect.Effect<string | null>;
  readonly commitsAhead: (input: {
    readonly cwd: string;
    readonly base: string;
    readonly branch: string;
  }) => Effect.Effect<number | null>;
  /**
   * The paths a merge of `branch` into `base` would leave conflicted, read
   * without a worktree, an index, or a trial commit (`git merge-tree
   * --write-tree`, git >= 2.38).
   *
   * `[]` means the merge is clean as of this read. `null` is the port's usual
   * "git told us nothing" — an unreadable repo, an unknown ref, a git too old,
   * and also a conflict git refused to name, because a conflict list nobody
   * can act on is not information.
   */
  readonly mergeTreeConflicts: (input: {
    readonly cwd: string;
    readonly base: string;
    readonly branch: string;
  }) => Effect.Effect<ReadonlyArray<string> | null>;
}

/**
 * Observable state changes produced by the pool loop. The server adapter
 * publishes run changes to PubSub and no-ops iteration changes (they reach
 * the UI through the next run publish, exactly as before the rewire).
 */
export interface PoolRunEventsShape {
  readonly publish: (event: RunEvent) => Effect.Effect<void, EpicRunnerError>;
}

/**
 * One iteration a previous process left `running`, as the caller hands it back.
 *
 * The caller sources these from its own durable store — the loop's journal
 * port carries no `branch` or `worktreePath`, and both are needed to find the
 * worktree the dead worker was committing into. See
 * {@link ParallelEpicLoopInput.resumedWorkers}.
 */
export interface ResumedWorker {
  readonly issueId: string;
  readonly iterationIndex: number;
  readonly threadId: ThreadId;
  readonly branch: string | null;
  readonly worktreePath: string | null;
  /** When the FIRST dispatch of this row started, not when the resume did. */
  readonly startedAt: string;
  /** How many times this row was already reopened. `0` on the first resume. */
  readonly resumeCount: number;
}

type ReadyChildSelection =
  | { readonly _tag: "child"; readonly issueId: string }
  /** Continue an interrupted iteration instead of starting a new one. */
  | { readonly _tag: "resume"; readonly worker: ResumedWorker }
  /**
   * Start a NEW iteration for a child the loop already holds the claim and the
   * worktree for — the recovery from a resume that could not be continued.
   *
   * It exists because `bd ready` cannot name this child: a still-claimed child
   * is absent from the frontier, so an unpinned dispatch would pick a
   * different one and walk away from a tree full of half-finished work. The
   * workspace travels on the selection rather than being re-adopted, because
   * the refused resume adopted it moments ago and hands it straight over.
   *
   * Internal to the loop. The scheduler never produces one.
   */
  | {
      readonly _tag: "pinned";
      readonly issueId: string;
      readonly workspace: IterationWorkspace;
    }
  | { readonly _tag: "unrecognised"; readonly candidateIds: ReadonlyArray<string> };

/**
 * Why the loop gave up on continuing an interrupted iteration: the harness's
 * own refusal, plus the two the loop decides for itself.
 */
type ResumeRefusalDecision =
  | IterationResumeRefusal
  | { readonly _tag: "workspace-missing"; readonly detail: string }
  | { readonly _tag: "child-closed"; readonly detail: string };

/** What `abandonResume` decided to do with the child it gave up resuming. */
type ResumeRefusalOutcome =
  /** Claim reopened, worktree dropped; the iteration is over. */
  | { readonly _tag: "released"; readonly result: RunIterationResult }
  /** Claim and worktree kept; run this selection next, in the same fiber. */
  | { readonly _tag: "handoff"; readonly selection: ReadyChildSelection };

/** `resumeIteration`'s three answers, flattened so each narrows on its own. */
type ResumeAttempt =
  | { readonly _tag: "handle"; readonly handle: IterationHandle }
  | { readonly _tag: "refused"; readonly refusal: IterationResumeRefusal }
  | { readonly _tag: "failed"; readonly error: EpicRunnerDispatchError };

/**
 * The persisted failure reason for a row a restart reconciled and nothing more.
 *
 * Exported because the restart path outside the loop writes it too: a row the
 * caller cannot even hand back — one that names no child, or one whose resume
 * budget is spent — ends the same way as one the loop gave up on, and reading
 * two different reasons for one ending would split the transcript in half.
 */
export const RESUME_ABANDONED_REASON = "server-restart";

/**
 * The typed failure reason for a refusal that leaves real work behind, or
 * `null` for one that leaves none.
 *
 * `null` means the ordinary release path: `workspace-missing` has no tree to
 * hand over, and `child-closed` has no work left to do. Everything else names
 * a live worktree holding a dead agent's uncommitted changes, so the row gets
 * a reason from the resume family and the child gets a new thread in that same
 * tree.
 */
const resumeHandoffReason = (refusal: ResumeRefusalDecision): string | null => {
  switch (refusal._tag) {
    case "capability":
      return EPIC_RUN_FAILURE_RESUME_UNSUPPORTED;
    case "no-durable-state":
    case "not-continued":
      return EPIC_RUN_FAILURE_RESUME_BLOCKED;
    case "failed":
      return EPIC_RUN_FAILURE_RESUME_FAILED;
    case "workspace-missing":
    case "child-closed":
      return null;
  }
};

type RunIterationResult =
  | { readonly _tag: "dispatch-skipped"; readonly providerTurnDispatched: false }
  /**
   * A resume the loop refused with nothing left to hand over — a worktree that
   * is gone, or a child that closed. The row is already `abandoned` and the
   * claim is already released, so the boundary writes nothing: no iteration
   * completed, no streak moved, and the next scheduler tick re-selects the
   * child fresh. A refusal that DID leave work behind never reaches here; it
   * runs on as a pinned iteration and is classified like any other.
   */
  | {
      readonly _tag: "resume-abandoned";
      readonly providerTurnDispatched: false;
      readonly issueId: string;
      readonly iterationIndex: number;
    }
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
 * Why the loop is asking whether the run may finish. The backlog-empty case
 * carries no frontier: the prover re-reads it, because the claim being checked
 * is exactly that the frontier is empty.
 */
type CompletionTrigger =
  | { readonly _tag: "backlog-empty" }
  | { readonly _tag: "ready-frontier-empty" }
  | { readonly _tag: "dispatch-cap"; readonly maxIterations: number };

interface ActiveIteration {
  charged: boolean;
  /**
   * The selection this worker was actually dispatched on, which is the key
   * every provider bookkeeping write uses when it settles.
   *
   * It starts as the run-level selection and is overwritten the moment
   * `runIteration` resolves a per-role one (`onSelectionResolved`), so a role
   * dispatched onto another account never degrades the run's account.
   */
  modelSelection: ModelSelection;
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

/**
 * How many times the conflict radar may speak to one iteration.
 *
 * Two, because the second nudge is the last one that can still be acted on: a
 * worker that ignored the first is not going to resolve the third, and a
 * provider that turns extra nudges into follow-ups (Prime) quietly stuffs the
 * turn with them.
 */
const MAX_CONFLICT_RADAR_NUDGES = 2;

/**
 * One running worker the conflict radar watches.
 *
 * Armed when the worker's turn begins and dropped when its iteration ends, so
 * the radar can only ever speak to a turn the loop still owns.
 */
interface ConflictRadarTarget {
  readonly issueId: string;
  readonly iterationIndex: number;
  readonly branch: string;
  readonly handle: IterationHandle;
  /**
   * The worker's own pool record, read live rather than copied: a child whose
   * integration-fix title is only recognised after dispatch flips this flag,
   * and the radar must never speak to the one worker allowed to move the base
   * branch.
   */
  readonly iteration: ActiveIteration;
  /**
   * The `<baseHead>:<branchHead>` this worker was last probed at, or `null`
   * before its first probe. Nothing has changed on either side while it holds,
   * so re-probing it would re-read the same objects and re-send the same
   * nudge.
   */
  lastProbedSignature: string | null;
  nudgesSent: number;
  /** False once this iteration must never be nudged again. */
  eligible: boolean;
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
  /**
   * Iterations a previous process left `running`, adopted before the first
   * scheduler tick.
   *
   * Absent or empty keeps today's behaviour exactly: nothing is adopted and
   * no resume port is touched. Each entry occupies a pool slot from tick zero
   * and is charged already, so a two-worker run that adopts two workers
   * dispatches nothing new until one settles.
   *
   * The caller decides what belongs here. It reads its own store for the
   * run's `running` rows, which is the only place `branch` and `worktreePath`
   * live; the loop never goes looking for interrupted work by itself.
   */
  readonly resumedWorkers?: ReadonlyArray<ResumedWorker> | undefined;
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
   * Absent or `null` means no usage ledger: a degradation then carries no
   * reset time and lives by the TTL alone.
   */
  readonly providerUsage?: ProviderUsageReadShape | null;
  /**
   * `null` keeps every dispatch on the run-level selection, exactly as it was
   * before per-role tiers existed.
   */
  readonly roleSelection: RoleSelectionShape | null;
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
const nowMillis = Effect.map(DateTime.now, DateTime.toEpochMillis);
/** Elapsed since a stamped record time, floored at zero. */
const sinceIso = (fromIso: string, to: number): number => {
  const from = Date.parse(fromIso);
  return Number.isFinite(from) && Number.isFinite(to) ? Math.max(0, to - from) : 0;
};

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
   *
   * The map is per process, so `body` seeds it from this run's own durable
   * iteration rows before the first dispatch: a restart must not hand a child
   * back the attempts a previous process already spent on it.
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

  /**
   * The ONE recovery branch for an interrupted iteration the loop will not
   * continue — an unsupported harness, a harness refusal, a worktree that is
   * gone, a child that closed while the run was down.
   *
   * Every path starts the same way: the operator gets the decision as a
   * durable event, the row goes `abandoned`, and the dead thread is
   * interrupted and stopped so nothing keeps running under a row nobody owns.
   *
   * How it ends depends on what the refusal left behind, and that is the whole
   * of the difference — see {@link resumeHandoffReason}. A refusal with a live
   * worktree hands that tree and the standing claim to a NEW iteration, which
   * is the only way the dead agent's uncommitted work survives. A refusal with
   * nothing to hand over reopens the claim, drops the worktree, and lets the
   * next scheduler tick re-select the child fresh.
   */
  const abandonResume = (abandoned: {
    readonly worker: ResumedWorker;
    readonly refusal: ResumeRefusalDecision;
    /** The adopted worktree, when the refusal happened after it was adopted. */
    readonly workspace: IterationWorkspace | null;
    /** The run this dead worker belongs to, for its stop grace. */
    readonly run: import("./ports/RunJournal.ts").PersistedEpicRun;
  }): Effect.Effect<ResumeRefusalOutcome, EpicRunnerError> =>
    Effect.gen(function* () {
      const { worker, refusal } = abandoned;
      const handoffReason = resumeHandoffReason(refusal);
      const handoff =
        handoffReason === null || abandoned.workspace === null
          ? null
          : { reason: handoffReason, workspace: abandoned.workspace };
      const failureReason = handoff?.reason ?? RESUME_ABANDONED_REASON;
      const summary = `resume refused (${refusal._tag}): ${refusal.detail}`;
      yield* ports.events.publish({
        type: "iteration-resume-decision",
        runId,
        iterationIndex: worker.iterationIndex,
        issueId: worker.issueId,
        decision: refusal._tag,
        origin: refusal._tag === "not-continued" ? refusal.origin : null,
        detail: refusal.detail,
      });
      const finishedAt = yield* nowIso;
      yield* ports.journal
        .updateIteration({
          runId,
          iterationIndex: worker.iterationIndex,
          turnStatus: "abandoned",
          summary,
          why: null,
          failureReason,
          finishedAt,
        })
        .pipe(Effect.mapError(journalError("updateIteration")));
      yield* publishIteration({
        runId,
        iterationIndex: worker.iterationIndex,
        threadId: worker.threadId,
        issueId: worker.issueId,
        turnStatus: "abandoned",
        summary,
        why: null,
        failureReason,
        startedAt: worker.startedAt,
        finishedAt,
      });
      // Nobody will ever hold this session again. The interrupt closes the
      // turn the dead process left projected as running — a stop alone leaves
      // it open forever — and the stop keeps the session from sitting there
      // while the same child is worked by someone else. The stop grace gives
      // that interrupt the time to land before the session goes.
      yield* ports.dispatch.interruptForced(worker.threadId).pipe(Effect.ignore);
      yield* ports.dispatch
        .stopForced(worker.threadId, {
          graceSeconds: makeDispatchSupervisionOptions(abandoned.run.config.supervision)
            .stopGraceSeconds,
        })
        .pipe(Effect.ignore);
      if (handoff !== null) {
        yield* Effect.logWarning("epic.runner.resume-handed-over", {
          runId,
          iterationIndex: worker.iterationIndex,
          issueId: worker.issueId,
          decision: refusal._tag,
          failureReason: handoff.reason,
          worktreePath: handoff.workspace.worktreePath,
          detail: refusal.detail,
        });
        return {
          _tag: "handoff",
          selection: {
            _tag: "pinned",
            issueId: worker.issueId,
            workspace: handoff.workspace,
          },
        } as const;
      }
      yield* ports.backlog.releaseClaimedChild(input.cwd, worker.issueId);
      yield* Effect.logWarning("epic.runner.resume-abandoned", {
        runId,
        iterationIndex: worker.iterationIndex,
        issueId: worker.issueId,
        decision: refusal._tag,
        detail: refusal.detail,
      });
      return {
        _tag: "released",
        result: {
          _tag: "resume-abandoned",
          providerTurnDispatched: false,
          issueId: worker.issueId,
          iterationIndex: worker.iterationIndex,
        },
      } as const;
    });

  const runIteration = (args: {
    readonly runCtx: PoolRunContext;
    readonly run: import("./ports/RunJournal.ts").PersistedEpicRun;
    readonly selection: ReadyChildSelection;
    readonly onDispatched: (threadId: ThreadId) => void;
    /**
     * Fired once this iteration knows which selection it will dispatch on,
     * before the dispatch itself. Never fired when no role resolver is wired,
     * and never fired for a resumed worker, which is pinned to the session it
     * is continuing.
     */
    readonly onSelectionResolved: (selection: AgentSelection) => void;
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
    /**
     * Fired once this iteration's provider turn is running and the loop holds
     * a handle on it. Never fired for a dispatch that failed, so every armed
     * worker has something that can be spoken to.
     *
     * The workspace travels with it because the conflict radar reads the
     * branch, and the branch is a property of the tree this iteration got, not
     * of the child it is cooking — a merge-fix child works a parked branch
     * whose name no child id derives.
     */
    readonly onTurnBegan: (armed: {
      readonly handle: IterationHandle;
      readonly workspace: IterationWorkspace;
      readonly issueId: string;
      readonly iterationIndex: number;
    }) => void;
  }): Effect.Effect<RunIterationResult, EpicRunnerError> => {
    let releaseContext: { readonly workspace: IterationWorkspace } | null = null;
    let releaseError: EpicRunnerError | null = null;
    /**
     * Give up on continuing this iteration, and run whatever comes next in
     * this same fiber so the child never loses its pool slot.
     *
     * A handoff re-enters `runIteration` with the pinned selection. The
     * worktree goes with it, so this invocation drops its release duty first:
     * releasing it here would delete the very tree the new iteration is being
     * given.
     */
    const refuseResume = (
      worker: ResumedWorker,
      refusal: ResumeRefusalDecision,
    ): Effect.Effect<RunIterationResult, EpicRunnerError> =>
      Effect.gen(function* () {
        const decision = yield* abandonResume({
          worker,
          refusal,
          workspace: releaseContext?.workspace ?? null,
          run: args.run,
        });
        if (decision._tag === "released") return decision.result;
        releaseContext = null;
        return yield* runIteration({ ...args, selection: decision.selection });
      });
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
                // Nothing is dispatched on this row: it exists only to record
                // that the frontier was unreadable, so there is no tier and no
                // model to attribute it to.
                tierId: null,
                providerInstanceId: null,
                model: null,
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

      const resumedWorker = selection._tag === "resume" ? selection.worker : null;
      // A pinned iteration is a fresh iteration in every respect but two: the
      // child comes from the refused resume rather than the frontier, and the
      // worktree is already open.
      const pinned = selection._tag === "pinned" ? selection : null;
      const issueId = selection._tag === "resume" ? selection.worker.issueId : selection.issueId;
      const issueEvidenceBefore = yield* ports.backlog.issueEvidence(input.cwd, issueId);
      // Flag this worker to the pool loop before it can possibly touch the
      // base branch (t3code-sha): the workspace acquire just below is what
      // actually checks the base branch out for this child, so the flag is
      // set with room to spare rather than tightly around the acquire call.
      if (parseIntegrationFixTitle(issueEvidenceBefore.title ?? "") !== null) {
        args.onIntegrationFixDetected();
      }

      // One selection per dispatch, resolved from the child's own role. A
      // merge-fix child is an ordinary ready child everywhere else in the
      // loop, so its title is the only thing that names it.
      //
      // `null` means "use whatever the run row says at dispatch time", which
      // is what every call site read before this port existed. A resumed
      // worker stays on the run selection too: its session id belongs to the
      // config directory that created it, so a resume cannot cross accounts.
      const resolvedRole: ResolvedRoleSelection | null =
        ports.roleSelection === null || resumedWorker !== null
          ? null
          : yield* ports.roleSelection.resolve({
              role: (parseMergeFixTitle(issueEvidenceBefore.title ?? "") !== null
                ? "merge-fix-child"
                : "iteration-worker") satisfies EpicDispatchRole,
              runId,
              issueId,
              issueTitle: issueEvidenceBefore.title,
              fallbackSelection: run.modelSelection,
            });
      const dispatchSelection: AgentSelection | null = resolvedRole?.selection ?? null;
      if (dispatchSelection !== null) args.onSelectionResolved(dispatchSelection);

      // A resume rebuilds the record of a worktree that already exists; it
      // never provisions. `acquire` would refuse the leftover worktree, and
      // provisioning a second one would strand the commits in the first.
      //
      // This runs BEFORE every refusal on purpose. Both endings need the
      // record: a handoff passes it to the pinned iteration, and a release
      // needs it to clear the leftover worktree off disk. `resumeIteration` is
      // still never called on a harness that declared `unsupported`.
      let workspace: IterationWorkspace;
      if (pinned !== null) {
        // Already adopted by the resume this iteration replaces, and handed
        // straight over. Re-adopting would only re-prove what was true a
        // moment ago, and `acquire` would refuse the open worktree outright.
        workspace = pinned.workspace;
      } else if (resumedWorker === null) {
        workspace = yield* ports.workspace.acquire(args.runCtx, {
          issueId,
          issueTitle: issueEvidenceBefore.title?.trim() || issueId,
          sequential: run.config.execution.sequential,
        });
      } else {
        const adopted = yield* ports.workspace
          .adopt(args.runCtx, {
            issueId,
            branch: resumedWorker.branch,
            worktreePath: resumedWorker.worktreePath,
            sequential: run.config.execution.sequential,
          })
          .pipe(
            Effect.map((adoptedWorkspace) => ({
              _tag: "adopted" as const,
              workspace: adoptedWorkspace,
            })),
            Effect.catch((error) =>
              Effect.succeed({ _tag: "refused" as const, detail: error.message }),
            ),
          );
        if (adopted._tag === "refused") {
          return yield* refuseResume(resumedWorker, {
            _tag: "workspace-missing",
            detail: adopted.detail,
          });
        }
        workspace = adopted.workspace;
      }
      releaseContext = { workspace };

      if (resumedWorker !== null) {
        // The claim may not have survived the restart: the run's own finalizer
        // reopens every child it stranded. Re-take it FIRST, before any
        // refusal is decided, because every refusal but this one now hands the
        // child to a new iteration in the same worktree — and that iteration
        // must not work a child the backlog still reads as unclaimed.
        //
        // A closed child stops here instead: the work is done, and neither
        // continuing the session nor handing the tree on would do anything but
        // redo it.
        const claim = yield* ports.backlog.claimChild(input.cwd, issueId);
        if (claim === "closed") {
          return yield* refuseResume(resumedWorker, {
            _tag: "child-closed",
            detail: `${issueId} closed while the run was down`,
          });
        }
        // The typed capability, read before anything is asked of the harness.
        // A harness that persists no artifact until the child closes has
        // nothing to adopt, and saying so is the honest answer — starting a
        // blank session that looks resumed is not.
        if (ports.dispatch.capabilities.lifecycle.resume === "unsupported") {
          return yield* refuseResume(resumedWorker, {
            _tag: "capability",
            detail: "this harness cannot adopt an iteration whose handle died",
          });
        }
      }
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
      // Only a restart-recovery iteration is shown its tree: an ordinary
      // iteration starts on a clean one and has nothing to be told about.
      // Both the resumed worker and the stranger taking over from it need it.
      const restartEvidence =
        selection._tag === "child" ? null : yield* ports.vcs.worktreeEvidence(workspace.cwd);
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
          if (resumedWorker !== null) {
            // Reuse the row. `allocateIteration` derives `thread_id` from the
            // index in SQL, so a second row at N+1 carrying thread N's id
            // breaks the `epicRunIterationThreadId` round-trip — and a resume
            // is one iteration across two process lifetimes, not two.
            yield* ports.journal
              .markIterationResumed({
                runId,
                iterationIndex: resumedWorker.iterationIndex,
                resumedAt: startedAt,
              })
              .pipe(Effect.mapError(journalError("markIterationResumed")));
            return {
              iterationIndex: resumedWorker.iterationIndex,
              threadId: resumedWorker.threadId,
            } as const;
          }
          // Attribution is written with the row, from the same expression the
          // dispatch below uses. A later provider fallback moves the run row,
          // not this one: the record keeps the account and model this
          // iteration actually started on, which is what a tier's failure
          // rate has to be counted against.
          const attribution = dispatchSelection ?? current.modelSelection;
          const iterationIndex = yield* ports.journal
            .allocateIteration({
              runId,
              issueId,
              branch: workspace.branch,
              worktreePath: workspace.worktreePath,
              tierId: resolvedRole?.tierId ?? null,
              providerInstanceId: attribution.instanceId,
              model: attribution.model,
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
            selection: dispatchSelection ?? current.modelSelection,
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
      // A resumed row keeps the stamp its first dispatch wrote; only the
      // journal's `lastResumedAt` records when this process picked it up.
      const iterationStartedAt = resumedWorker?.startedAt ?? startedAt;

      yield* publishIteration({
        runId,
        iterationIndex,
        threadId,
        issueId,
        turnStatus: "running",
        summary: null,
        why: null,
        failureReason: null,
        startedAt: iterationStartedAt,
        finishedAt: null,
      });

      // The setup script already ran in this worktree before the restart, for
      // the agent that is being taken over from as much as for a resume.
      if (
        selection._tag === "child" &&
        workspace.branch !== null &&
        workspace.worktreePath !== null
      ) {
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
          // A resume continues the thread that already holds the epic context
          // and the orientation card, so its turn repeats neither. It says the
          // one thing the agent cannot know: the process died under it.
          //
          // A pinned iteration is the opposite case: a brand new thread that
          // knows nothing, so it gets the whole ordinary prompt with the
          // handover — and the same tree snapshot — spliced ahead of it.
          const prompt =
            resumedWorker !== null
              ? EPIC_RUN_RESTART_RESUME_PROMPT({
                  issueId,
                  branch: workspace.branch,
                  worktreePath: workspace.worktreePath,
                  evidence: restartEvidence,
                })
              : assembleIterationPrompt({
                  basePrompt:
                    pinned === null
                      ? current.prompt
                      : `${EPIC_RUN_RESTART_HANDOFF_PROMPT({
                          issueId,
                          branch: workspace.branch,
                          worktreePath: workspace.worktreePath,
                          evidence: restartEvidence,
                        })}\n\n${current.prompt}`,
                  issueId,
                  epicContext,
                  orientationCard,
                  siblingRule: workspace.siblingRule,
                });
          if (resumedWorker !== null) {
            // Continuity is proved before the run row moves, so a refusal
            // leaves no trace of a dispatch that never happened. The wait
            // stays inside the transition for the same reason `beginTurn`
            // does: a durable pause must not be followed by a provider turn.
            const attempt: ResumeAttempt = yield* ports.dispatch
              .resumeIteration({
                ref: resumedWorker.threadId,
                runId,
                iterationIndex,
                issueId,
                prompt,
                selection: current.modelSelection,
                runtimeMode: current.runtimeMode,
                policy,
                workspace,
                headBefore,
                branchBase,
                initialWorktreeFingerprint,
              })
              .pipe(
                Effect.match({
                  onFailure: (error): ResumeAttempt => ({ _tag: "failed", error }),
                  onSuccess: (outcome): ResumeAttempt =>
                    outcome._tag === "resumed"
                      ? { _tag: "handle", handle: outcome.handle }
                      : { _tag: "refused", refusal: outcome.refusal },
                }),
              );
            if (attempt._tag === "refused") {
              return { _tag: "refused", worker: resumedWorker, refusal: attempt.refusal } as const;
            }
            const resumedRun = {
              ...current,
              currentThreadId: threadId,
              currentTurnStartedAt: dispatchedAt,
              // No `iterationsDispatched` charge: this run already paid for
              // this iteration, and charging twice shrinks the frontier.
              updatedAt: dispatchedAt,
            };
            yield* saveRun(resumedRun);
            args.onDispatched(threadId);
            const promptBytes = new TextEncoder().encode(prompt).byteLength;
            return attempt._tag === "handle"
              ? ({
                  _tag: "started",
                  run: resumedRun,
                  handle: attempt.handle,
                  error: null,
                  dispatchedAt,
                  promptBytes,
                } as const)
              : ({
                  _tag: "started",
                  run: resumedRun,
                  handle: null,
                  error: attempt.error,
                  dispatchedAt,
                  promptBytes,
                } as const);
          }
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
              prompt,
              selection: dispatchSelection ?? next.modelSelection,
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
          return {
            _tag: "started",
            run: next,
            ...started,
            dispatchedAt,
            promptBytes: new TextEncoder().encode(prompt).byteLength,
          } as const;
        }),
      );
      if (dispatched === null) {
        yield* ports.dispatch.stopAbandoned(threadId);
        return { _tag: "dispatch-skipped", providerTurnDispatched: false } as const;
      }
      if (dispatched._tag === "refused") {
        return yield* refuseResume(dispatched.worker, dispatched.refusal);
      }
      if (resumedWorker !== null) {
        // Every resume decision is on the record, not just the ones that lost
        // work: "the session was continued" is the only evidence that a
        // restart cost nothing.
        yield* ports.events.publish({
          type: "iteration-resume-decision",
          runId,
          iterationIndex,
          issueId,
          decision: "resumed",
          origin: null,
          detail: `continued at ${resumedWorker.threadId}`,
        });
      }

      if (dispatched.handle !== null) {
        args.onTurnBegan({
          handle: dispatched.handle,
          workspace,
          issueId,
          iterationIndex,
        });
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
      // The provider turn ends here. Everything after it is the runner's own
      // time, and keeping the two apart is the only way to tell a slow agent
      // from a slow runner.
      const settledAtMs = yield* nowMillis;

      const supervisionStop =
        settleResult._tag === "supervision-stopped" ? settleResult.reason : null;
      const timedOut = settleResult._tag === "timeout";
      // Both early ends interrupt the turn before it is classified. A worker
      // the machine confirmed dead is treated like a timed-out one: interrupt
      // first, then the forced stop further down.
      let interruptedBeforeStop = false;
      if ((timedOut || supervisionStop !== null) && dispatched.handle !== null) {
        yield* dispatched.handle.interrupt.pipe(Effect.ignore);
        interruptedBeforeStop = true;
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
      // stops, and the timeout interrupt above always precedes its stop —
      // which is what the run's stop grace is for, so the interrupted turn
      // gets to close before the session dies under it. A failed dispatch has
      // no handle and no interrupt, so it stops with no grace at all.
      if (settleResult._tag === "settled") {
        if (dispatched.handle !== null) {
          yield* dispatched.handle.release.pipe(Effect.ignore);
        }
      } else {
        yield* ports.dispatch
          .stopForced(threadId, {
            graceSeconds: interruptedBeforeStop
              ? makeDispatchSupervisionOptions(dispatched.run.config.supervision).stopGraceSeconds
              : 0,
          })
          .pipe(Effect.ignore);
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

      const mergeStartedAtMs = yield* nowMillis;
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

      const mergeEndedAtMs = yield* nowMillis;

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
          phaseTimings: {
            prepareMs: sinceIso(startedAt, Date.parse(dispatched.dispatchedAt)),
            providerMs: sinceIso(dispatched.dispatchedAt, settledAtMs),
            settlementMs: Math.max(0, mergeStartedAtMs - settledAtMs),
            mergeWaitMs: Math.max(0, mergeEndedAtMs - mergeStartedAtMs),
            // This loop never runs a gate itself. Its gates belong to the
            // merge drain, which serves a batch of branches rather than one
            // iteration; those are in the run's gate receipts.
            gateMs: 0,
          },
          promptBytes: dispatched.promptBytes,
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
        startedAt: iterationStartedAt,
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

  /**
   * The run's only path to a terminal status. It re-reads the epic's open
   * children from Beads and hands that evidence to `proveEpicCompletion`, so
   * `done` is always written against the backlog and never against a worker's
   * claim.
   *
   * Runs outside the transition semaphore: it is a read, and the caller takes
   * the semaphore to write the status the proof allows.
   */
  const proveCompletion = (
    trigger: CompletionTrigger,
    activeWorkers: number,
  ): Effect.Effect<EpicCompletionProof, EpicRunnerError> =>
    Effect.gen(function* () {
      // A live sibling can still close the last child, so there is nothing to
      // prove yet and no reason to spend a `bd` read proving it.
      if (activeWorkers > 0) return { _tag: "unproven" } as const;
      const openChildIds = yield* ports.backlog
        .openChildIds(input.cwd, input.epicId)
        .pipe(Effect.mapError(backlogError));
      // The frontier only separates a wrong `RALPH_DONE` from a stuck epic, so
      // an epic with nothing open never pays for that read. `unrecognised`
      // counts as ready work: the next dispatch pass owns that failure.
      const check: EpicCompletionCheck =
        trigger._tag !== "backlog-empty"
          ? trigger
          : {
              _tag: "backlog-empty",
              readyChildIds:
                openChildIds.length === 0
                  ? []
                  : yield* ports.backlog.readyFrontier(input.cwd, input.epicId).pipe(
                      Effect.mapError(backlogError),
                      Effect.map((frontier) =>
                        frontier._tag === "children"
                          ? frontier.issueIds
                          : frontier._tag === "unrecognised"
                            ? frontier.candidateIds
                            : [],
                      ),
                    ),
            };
      const proof = proveEpicCompletion({ check, activeWorkers, openChildIds });
      if (proof._tag !== "complete") {
        // The record a stuck-epic investigation starts from: which children
        // Beads still shows open, and what the ready re-read said about them.
        yield* Effect.logInfo("epic.runner.completion-unproven", {
          runId,
          check: check._tag,
          proof: proof._tag,
          openChildren: openChildIds.length,
          openChildIds: describeOpenChildren(openChildIds),
          ...(check._tag === "backlog-empty"
            ? { readyChildIds: describeOpenChildren(check.readyChildIds) }
            : {}),
        });
      }
      return proof;
    });

  /** Write the terminal status a proof allows, under the transition lock. */
  const writeProvenTerminalStatus = (
    proof: Extract<EpicCompletionProof, { readonly _tag: "complete" | "incomplete" }>,
  ) =>
    withTransition(
      Effect.gen(function* () {
        const current = yield* requireRun(runId);
        if (current.status !== "running") return;
        yield* saveRun({
          ...current,
          status: proof._tag === "complete" ? ("done" as const) : ("failed" as const),
          lastError: proof.lastError,
          updatedAt: yield* nowIso,
        });
      }),
    );

  const applyIterationBoundary = (args: {
    readonly iterationResult: RunIterationResult;
    readonly providerInstanceId: ModelSelection["instanceId"];
    readonly providerFallbackApplied: boolean;
    /**
     * The proof read for a `RALPH_DONE` settlement, or `null` when this
     * settlement cannot finish the run. A `done` status is written only when
     * the proof allows it.
     */
    readonly completionProof: EpicCompletionProof | null;
  }): Effect.Effect<LoopBoundary, EpicRunnerError> =>
    withTransition(
      Effect.gen(function* () {
        if (args.iterationResult._tag === "dispatch-skipped") {
          return LOOP_STOP;
        }
        // An abandoned resume completed nothing, so it moves no counter: not
        // `iterationsCompleted`, not a streak, not a child attempt. The child
        // is open again and the next tick dispatches it fresh, which is the
        // attempt that will be judged.
        if (args.iterationResult._tag === "resume-abandoned") {
          return {
            _tag: "continue",
            delayMs: 0,
            providerFallbackApplied: args.providerFallbackApplied,
          } satisfies LoopBoundary;
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
        // `decision.nextStatus === "done"` is the worker's `RALPH_DONE` claim,
        // and only `backlog-empty` produces it. Beads decides it: an open child
        // either sends the loop back for another dispatch pass (`unproven`) or
        // fails the run (`incomplete`).
        const refused =
          decision.nextStatus === "done" &&
          args.completionProof !== null &&
          args.completionProof._tag !== "complete"
            ? args.completionProof
            : null;
        const status =
          refused === null ? decision.nextStatus : refused._tag === "incomplete" ? "failed" : null;
        yield* saveRun({
          ...settledRun,
          ...(status === null ? {} : { status }),
          consecutiveFailures: decision.nextConsecutiveFailures,
          noCommitStreak: decision.nextNoCommitStreak,
          infraStreak: decision.nextInfraStreak,
          lastError: refused?._tag === "incomplete" ? refused.lastError : decision.lastError,
          ...(childAttemptBudgetExhausted
            ? {
                status: "failed" as const,
                lastError: outcome.detail ?? outcome.kind,
              }
            : {}),
        });
        const stop = refused === null ? decision.action === "stop" : refused._tag === "incomplete";
        return stop || childAttemptBudgetExhausted
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
          // Guard against applying the same hop twice, not against the run row
          // naming a different instance: a role-resolved worker fails on the
          // account IT was dispatched on, which the run row need never have
          // named. Keying on the target still refuses a stale duplicate,
          // because the first application already moved the run row there.
          if (current.modelSelection.instanceId === pending.to.instanceId) return false;
          const degradedAt = yield* nowIso;
          // Fail-soft by construction: the port never fails, and its absence
          // only costs the record its reset time, never the fallback itself.
          const samples =
            ports.providerUsage == null ? [] : yield* ports.providerUsage.listUsageSamples;
          yield* ports.journal
            .upsertProviderDegradation({
              providerInstanceId: pending.from.instanceId,
              failureReason: pending.failureReason,
              degradedAt,
              resetsAt: providerDegradationResetsAt({
                failureReason: pending.failureReason,
                samples,
                providerInstanceId: pending.from.instanceId,
                now: degradedAt,
              }),
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
    // Restore what earlier processes of THIS run already charged, before any
    // dispatch — including the resumed workers adopted below, whose own
    // settlement adds to the restored count rather than starting from zero.
    const restoredAttempts = childAttemptsFromHistory(
      yield* ports.journal
        .listIterations(runId)
        .pipe(Effect.mapError(storeError("listIterations"))),
    );
    for (const [issueId, spent] of restoredAttempts) childAttempts.set(issueId, spent);
    if (restoredAttempts.size > 0) {
      yield* Effect.logInfo("epic.runner.child-attempts-restored", {
        runId,
        attempts: Object.fromEntries(restoredAttempts),
      });
    }
    const runCtx: PoolRunContext = {
      runId,
      epicId: input.epicId,
      projectId: initialRun.projectId,
      cwd: input.cwd,
    };
    const initialMergeState = yield* ports.workspace.ensureIntegration(runCtx);
    const events = input.signals;
    const active = new Map<string, ActiveIteration>();
    /** The workers the conflict radar may probe, keyed like {@link active}. */
    const radar = new Map<string, ConflictRadarTarget>();
    let drainBeforeDispatch =
      initialMergeState?.entries.some(
        (entry) => entry.status === "queued" || entry.status === "draining",
      ) ?? false;
    // Run-level progress, and the one owner of "running but doing nothing"
    // (`runStall.ts`). A deferred drain used to retry forever, silently: the
    // run lock kept heartbeating, no worker was alive to look wrong, and one
    // such spin ran 8 hours before anyone noticed. Only three things move a
    // run — a provider turn dispatched, an iteration settled, a merge landed —
    // so only those three reset this.
    let lastProgressAt = yield* Clock.currentTimeMillis;
    let lastStallWarnedAt = 0;
    const noteProgress = Effect.gen(function* () {
      lastProgressAt = yield* Clock.currentTimeMillis;
      lastStallWarnedAt = 0;
    });
    /**
     * Judge the current wait, and fail the run when it is provably stuck.
     *
     * Returns `true` when the run was moved to a terminal state and the loop
     * must stop. A wait with live workers can only ever warn: one unit of epic
     * work legitimately takes hours, and the worker timeout and
     * `workerSupervision.ts` own that verdict.
     */
    const checkStall = (wait: RunWait) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const verdict = evaluateRunStall({
          wait,
          lastProgressAt,
          now,
          timeoutMs: policy.runStallTimeoutMs,
        });
        if (verdict._tag === "ok") return false;
        if (now - lastStallWarnedAt >= RUN_STALL_WARN_INTERVAL_MS) {
          lastStallWarnedAt = now;
          yield* Effect.logWarning("epic.runner.no-progress", {
            runId,
            wait: wait._tag,
            stalledForMs: verdict.stalledForMs,
            detail: verdict._tag === "warn" ? verdict.detail : verdict.lastError,
          });
        }
        if (verdict._tag === "warn") return false;
        yield* withTransition(
          Effect.gen(function* () {
            const current = yield* requireRun(runId);
            if (current.status === "running") {
              yield* saveRun({
                ...current,
                status: "failed" as const,
                lastError: verdict.lastError,
                updatedAt: yield* nowIso,
              });
            }
          }),
        );
        return true;
      });
    /**
     * One sweep of the conflict radar: trial-merge every armed worker's branch
     * against the base branch, and tell the worker what it would hit.
     *
     * The whole tick reads objects only (`git merge-tree --write-tree`), so it
     * needs no worktree, no index and no lock, and it can run beside a drain
     * without either seeing the other. The one thing it must not run beside is
     * an integration-fix child, which is the only worker allowed to move the
     * base branch: reading a head that is being rewritten produces a signature
     * that names a state nobody is in.
     *
     * Every port it touches is never-failing by construction, so a tick that
     * learns nothing simply nudges nobody.
     */
    const conflictRadarTick = Effect.gen(function* () {
      const armed = [...radar.values()].filter(
        (worker) => worker.eligible && !worker.iteration.isIntegrationFix,
      );
      if (armed.length === 0) return;
      if ([...active.values()].some((worker) => worker.isIntegrationFix)) return;
      const target = yield* ports.mergeDrain.integrationTarget(runCtx);
      if (target === null) return;
      const baseHead = yield* ports.vcs.headCommit(target.repositoryPath, target.baseBranch);
      if (baseHead === null) return;
      for (const worker of armed) {
        const branchHead = yield* ports.vcs.headCommit(target.repositoryPath, worker.branch);
        if (branchHead === null) continue;
        const signature = `${baseHead}:${branchHead}`;
        if (signature === worker.lastProbedSignature) continue;
        const conflicts = yield* ports.vcs.mergeTreeConflicts({
          cwd: target.repositoryPath,
          base: target.baseBranch,
          branch: worker.branch,
        });
        if (conflicts === null || conflicts.length === 0) {
          // A clean read is as final as a conflicting one: neither side can
          // change without moving a head, and moving a head changes the
          // signature.
          worker.lastProbedSignature = signature;
          continue;
        }
        if (worker.nudgesSent >= MAX_CONFLICT_RADAR_NUDGES) {
          worker.eligible = false;
          continue;
        }
        const outcome = yield* worker.handle.nudge(
          conflictRadarNudgePrompt({ baseBranch: target.baseBranch, conflicts }),
        );
        if (outcome === "skipped") {
          // Not a verdict on this signature — the turn was simply not
          // speakable-to right now — so leave it unrecorded and try again.
          yield* Effect.logDebug("epic.runner.conflict-radar-skipped", {
            runId,
            iterationIndex: worker.iterationIndex,
            issueId: worker.issueId,
            branch: worker.branch,
          });
          continue;
        }
        worker.lastProbedSignature = signature;
        if (outcome === "unsupported") {
          worker.eligible = false;
        } else {
          worker.nudgesSent += 1;
        }
        yield* Effect.logInfo("epic.runner.conflict-radar-nudge", {
          runId,
          iterationIndex: worker.iterationIndex,
          issueId: worker.issueId,
          branch: worker.branch,
          baseBranch: target.baseBranch,
          conflicts: conflicts.length,
          outcome,
        });
      }
    });

    /**
     * The radar's own fiber, forked as a child of this loop so it dies with
     * it. It never fails the run: a probe or a nudge that blew up is one lost
     * early warning, and the merge queue still catches the conflict later.
     */
    const conflictRadar = Effect.gen(function* () {
      while (true) {
        yield* Effect.sleep(Duration.millis(policy.conflictProbeIntervalMs));
        yield* conflictRadarTick.pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("epic.runner.conflict-radar-failed", {
              runId,
              detail: Cause.pretty(cause),
            }),
          ),
        );
      }
    });

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
        const selectedIssueId =
          selection._tag === "child"
            ? selection.issueId
            : selection._tag === "resume"
              ? selection.worker.issueId
              : null;
        const isIntegrationFix =
          run.config.vcs.runOwnedBaseBranch &&
          selectedIssueId !== null &&
          parseIntegrationFixTitle(
            (yield* ports.backlog.issueEvidence(input.cwd, selectedIssueId)).title ?? "",
          ) !== null;
        const activeIteration: ActiveIteration = {
          // A resumed worker is charged from tick zero: its
          // `iterationsDispatched` was paid before the restart, so leaving it
          // uncharged would let the frontier reserve a slot it already holds.
          charged: selection._tag === "resume",
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
          onSelectionResolved: (selection) => {
            activeIteration.modelSelection = selection;
          },
          onIntegrationFixDetected: () => {
            activeIteration.isIntegrationFix = true;
          },
          onTurnBegan: (armed) => {
            // An in-place worker has no branch of its own to trial-merge — it
            // commits where the base branch already is — and an
            // integration-fix child IS the base branch writer.
            if (armed.workspace.branch === null || armed.workspace.worktreePath === null) return;
            if (activeIteration.isIntegrationFix) return;
            radar.set(key, {
              issueId: armed.issueId,
              iterationIndex: armed.iterationIndex,
              branch: armed.workspace.branch,
              handle: armed.handle,
              iteration: activeIteration,
              lastProbedSignature: null,
              nudgesSent: 0,
              // The capability gate, applied before the first read rather than
              // at the nudge: a harness that cannot absorb a mid-turn message
              // is not worth probing for, and this keeps the radar out of
              // every terminal run without it knowing what a harness is.
              eligible: armed.handle.capabilities.continuation === "same-thread",
            });
          },
        }).pipe(
          // The radar may only ever speak to a turn this loop still owns. A
          // nudge sent after settlement opens a stray turn with no timeout, no
          // liveness watch and no owner, inside a worktree the drain is about
          // to trial-merge.
          Effect.ensuring(Effect.sync(() => radar.delete(key))),
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

    // A sequential run has one worker committing on the base branch itself,
    // so there is no second branch for anything to conflict with, and nothing
    // for the radar to read.
    if (!initialRun.config.execution.sequential && policy.conflictProbeIntervalMs > 0) {
      yield* Effect.forkChild(conflictRadar);
    }

    // Adopt what a previous process left running, before the scheduler gets a
    // chance to dispatch anything fresh. Each adopted worker holds its pool
    // slot from here on, so the first tick already sees the right occupancy.
    for (const worker of input.resumedWorkers ?? []) {
      if (active.has(worker.issueId)) continue;
      yield* Effect.logInfo("epic.runner.resume-adopting", {
        runId,
        iterationIndex: worker.iterationIndex,
        issueId: worker.issueId,
        threadId: worker.threadId,
        resumeCount: worker.resumeCount,
      });
      yield* launch(initialRun, { _tag: "resume", worker }, worker.issueId);
    }

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
          // Deferring to a live holder stays correct. Deferring past the stall
          // window does not: an absent or stale slot defers every attempt, and
          // without a bound the loop spins on it for as long as the process
          // lives while still heartbeating its run lock.
          if (yield* checkStall({ _tag: "merge-slot", holder: result.holder })) return;
          yield* Effect.sleep(Duration.millis(policy.pollIntervalMs));
          continue;
        }
        // A drain that took the slot moved the run, whether or not this pass
        // had anything left to land.
        yield* noteProgress;
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
              // Completion honesty (D2, t3code-sha) is deferred: the proof
              // below reads Beads alone, not whether the merge queue still
              // holds entries this run never landed (`lastDrainBlocked`, logged
              // as `epic.runner.merge-drain-blocked` above). A run can report
              // `done` with parked or blocked work still sitting in the queue.
              // Follow-up filed: t3code-xig.
              const proof = yield* proveCompletion({ _tag: "ready-frontier-empty" }, active.size);
              if (proof._tag !== "unproven") {
                yield* writeProvenTerminalStatus(proof);
                return;
              }
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
            const launched = selections.slice(0, slots);
            for (const [key, selection] of launched) {
              yield* launch(run, selection, key);
            }
            if (launched.length > 0) yield* noteProgress;
          }
        } else if (active.size === 0 && run.iterationsDispatched >= policy.maxIterations) {
          // Same deferred gap as above: the cap consults Beads, not the merge
          // queue. A cap that leaves an open child fails rather than reporting
          // work the run never did.
          const proof = yield* proveCompletion(
            { _tag: "dispatch-cap", maxIterations: policy.maxIterations },
            active.size,
          );
          if (proof._tag !== "unproven") {
            yield* writeProvenTerminalStatus(proof);
            return;
          }
        }
      }

      if (active.size === 0) {
        // Nothing is running and this pass dispatched nothing, so the next one
        // reads the same state and does the same thing. Sleeping the poll
        // interval keeps that from becoming a hot spin, and the watchdog gives
        // it an end.
        if (yield* checkStall({ _tag: "scheduler" })) return;
        yield* Effect.sleep(Duration.millis(policy.pollIntervalMs));
        continue;
      }

      // Bounded so a worker that never settles cannot hold the loop here in
      // silence. Workers are never failed from here — the timeout expires,
      // `checkStall` warns, and the loop goes back to waiting.
      const taken = yield* Queue.take(events).pipe(
        Effect.timeoutOption(Duration.millis(policy.runStallTimeoutMs)),
      );
      if (Option.isNone(taken)) {
        yield* checkStall({ _tag: "workers", issueIds: [...active.keys()] });
        continue;
      }
      const event = taken.value;
      if (event._tag === "retune") continue;
      const settlement = event;
      active.delete(settlement.key);
      yield* noteProgress;
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
      // A `RALPH_DONE` settlement is the only one that can finish the run, so
      // it is the only one that pays for the proof reads. `active` no longer
      // holds this worker, so the count is the siblings still running.
      const completionProof =
        settlement.exit.value._tag === "classified" &&
        settlement.exit.value.outcome.kind === "backlog-empty"
          ? yield* proveCompletion({ _tag: "backlog-empty" }, active.size)
          : null;
      const boundary = yield* applyIterationBoundary({
        iterationResult: settlement.exit.value,
        providerInstanceId: settlement.modelSelection.instanceId,
        providerFallbackApplied: fallbackAppliesToBoundary,
        completionProof,
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
