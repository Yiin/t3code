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
  ThreadId,
  epicRunIterationThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
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
import { decideIterationBoundary, parseMergeFixTitle, persistedFailureReason } from "./policy.ts";
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
import type { IterationWorkspace, PoolRunContext, WorkspaceShape } from "./ports/Workspace.ts";
import type { PoolPolicy } from "./runPolicy.ts";
import { resolveEpicProviderFallback } from "./providerFallback.ts";

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
  | { readonly _tag: "drained" }
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
}

/** Never-failing git probes; `null` never counts as progress. */
export interface PoolVcsShape {
  readonly headCommit: (cwd: string) => Effect.Effect<string | null>;
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
  | { readonly _tag: "dispatch-failed"; readonly detail: string };

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

interface ActiveIteration {
  charged: boolean;
  readonly modelSelection: ModelSelection;
}

interface WorkerSettlement {
  readonly _tag: "settlement";
  readonly key: string;
  readonly modelSelection: ModelSelection;
  readonly exit: Exit.Exit<RunIterationResult, EpicRunnerError>;
}

export type PoolSchedulerEvent = WorkerSettlement | { readonly _tag: "retune" };

interface PendingProviderFallback {
  readonly from: ModelSelection;
  readonly to: ModelSelection;
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
}

export const assembleIterationPrompt = (input: {
  readonly basePrompt: string;
  readonly issueId: string;
  readonly epicContext: string | null;
  readonly orientationCard: string | null;
}): string =>
  `${input.basePrompt}\n\nCook exactly \`${input.issueId}\` this iteration.\n\n## Epic context (resolved at dispatch)\n\n${input.epicContext ?? "(epic description unavailable)"}\n\n${input.orientationCard ?? "(no orientation card in this repo)"}`;

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
  }): Effect.Effect<boolean> =>
    Effect.gen(function* () {
      const headAfter = yield* ports.vcs.headCommit(args.workspace.cwd);
      if (headAfter !== null && headAfter !== args.headBefore) return true;
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
  }): Effect.Effect<RunIterationResult, EpicRunnerError> => {
    let releaseContext: { readonly workspace: IterationWorkspace } | null = null;
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
      const settleResult: IterationSettleResult = yield* boundedIteration.pipe(
        Effect.catch((error) =>
          Effect.succeed<IterationSettleResult>({
            _tag: "dispatch-failed",
            detail: settleErrorDetail(error),
          }),
        ),
      );

      const timedOut = settleResult._tag === "timeout";
      if (timedOut && dispatched.handle !== null) {
        yield* dispatched.handle.interrupt.pipe(Effect.ignore);
      }

      const outcome: EpicIterationOutcome =
        settleResult._tag === "dispatch-failed"
          ? {
              kind: "error",
              detail: settleResult.detail,
              report: null,
            }
          : yield* Effect.gen(function* () {
              const committed = yield* iterationCommitted({
                workspace,
                headBefore,
                branchBase,
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

      if (
        !run.config.execution.sequential &&
        outcome.kind === "done" &&
        workspace.branch !== null
      ) {
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
          return ports.workspace.release(args.runCtx, context.workspace);
        }),
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
      return fallback === null
        ? null
        : {
            from: modelSelection,
            to: fallback,
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
    let terminalWorkerError: EpicRunnerError | null = null;
    let pendingFallback: PendingProviderFallback | null = null;
    let syntheticSequence = 0;

    const launch = (
      run: import("./ports/RunJournal.ts").PersistedEpicRun,
      selection: ReadyChildSelection,
      key: string,
    ) =>
      Effect.gen(function* () {
        const activeIteration: ActiveIteration = {
          charged: false,
          modelSelection: run.modelSelection,
        };
        active.set(key, activeIteration);
        yield* runIteration({
          runCtx,
          run,
          selection,
          onDispatched: () => {
            activeIteration.charged = true;
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

      if (drainBeforeDispatch) {
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
          yield* Effect.sleep(Duration.millis(policy.pollIntervalMs));
          continue;
        }
        drainBeforeDispatch = false;
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
