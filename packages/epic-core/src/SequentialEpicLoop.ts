// @effect-diagnostics globalDate:off
import { EpicRunId, ProjectId, ThreadId, epicRunIterationThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { EpicRunConfigSnapshot, EpicRunPreflightShape } from "./EpicRunPreflight.ts";
import { decideIterationBoundary, persistedFailureReason } from "./policy.ts";
import {
  classifyIteration,
  iterationFailureClass,
  type EpicIterationOutcome,
} from "./ralphProtocol.ts";
import type { AgentDispatchShape, AgentSelection, IterationHandle } from "./ports/AgentDispatch.ts";
import type { BacklogIssue, BacklogShape } from "./ports/Backlog.ts";
import type { EpicRunLockShape } from "./ports/EpicRunLock.ts";
import type { GateShape } from "./ports/Gate.ts";
import type { ProviderInventoryShape } from "./ports/ProviderInventory.ts";
import { CHILD_CLAIM_RELEASED_REASON, type RunEventsShape } from "./ports/RunEvents.ts";
import type {
  PersistedEpicRun,
  PersistedEpicRunIteration,
  RunJournalShape,
} from "./ports/RunJournal.ts";
import type { RepoRef, VcsShape } from "./ports/Vcs.ts";
import { resolveEpicProviderFallback } from "./providerFallback.ts";
import { siblingRuleSequential } from "./siblings.ts";

export class SequentialEpicLoopError extends Schema.TaggedErrorClass<SequentialEpicLoopError>()(
  "SequentialEpicLoopError",
  { operation: Schema.String, detail: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return `${this.operation}: ${this.detail}`;
  }
}

export interface SequentialEpicLoopInput {
  readonly runId: string;
  readonly epicId: string;
  readonly projectId?: string;
  readonly cwd: string;
  readonly runDirectory: string;
  readonly repository: RepoRef;
  readonly selection: AgentSelection;
  readonly configSnapshot: EpicRunConfigSnapshot;
  readonly promptPreamble?: string;
  readonly readOrientation: (configuredPath: string | null) => Effect.Effect<string, Error>;
  readonly shouldStop: () => Effect.Effect<boolean>;
  readonly now?: () => string;
}

export interface SequentialEpicLoopPorts {
  readonly preflight: EpicRunPreflightShape;
  readonly lock: EpicRunLockShape;
  readonly backlog: BacklogShape;
  readonly journal: RunJournalShape;
  readonly events: RunEventsShape;
  readonly providerInventory: ProviderInventoryShape;
  readonly dispatch: AgentDispatchShape;
  readonly gate: GateShape;
  readonly vcs: VcsShape;
}

const errorDetail = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);
const openStatus = (status: string): boolean => status !== "closed";

const workerPrompt = (input: {
  readonly epic: BacklogIssue;
  readonly child: BacklogIssue;
  readonly orientation: string;
  readonly preamble?: string;
  /** The sequential sibling rule; spliced only when the run has siblings. */
  readonly siblingRule?: string;
}): string => `${input.preamble ?? "Complete the assigned epic child end-to-end."}

Work only child \`${input.child.id}\`: ${input.child.title}
ASSIGNED_CHILD_ID=${input.child.id}

Use bd to claim this child. Implement it. Run focused checks. Commit the result, but do not push. Close the child and append its epic progress note. Stop after this child. Keep all work in the foreground. End a completed iteration with exactly one line:
RALPH_MSG: {"summary":"<what you built, one clause>","why":"<why it was needed, one clause>"}
${input.siblingRule === undefined ? "" : `\n${input.siblingRule}\n`}
## Epic context

${input.epic.description || "(epic description unavailable)"}

## Agent orientation

${input.orientation}
`;

const isResearch = (issue: BacklogIssue): boolean =>
  issue.title.startsWith("Research:") ||
  issue.labels.some((label) => label.toLowerCase() === "research");

/** A sibling checkout viewed as its own single-repo root. */
const siblingRepoRef = (sibling: RepoRef["siblings"][number]): RepoRef => ({
  repositoryPath: sibling.repositoryPath,
  baseBranch: sibling.baseBranch,
  worktreeRoot: sibling.worktreeRoot,
  siblings: [],
});

export const runSequentialEpicLoop = Effect.fn("runSequentialEpicLoop")(function* (
  input: SequentialEpicLoopInput,
  ports: SequentialEpicLoopPorts,
) {
  const now = input.now ?? (() => new Date().toISOString());
  const snapshot = input.configSnapshot;
  const config = snapshot.config;
  const preflight = yield* ports.preflight
    .check({ workspaceRoot: input.cwd, epicId: input.epicId, mode: "sequential" }, snapshot)
    .pipe(
      Effect.mapError(
        (cause) =>
          new SequentialEpicLoopError({
            operation: "preflight",
            detail: errorDetail(cause),
            cause,
          }),
      ),
    );
  if (!preflight.ok) {
    return yield* new SequentialEpicLoopError({
      operation: "preflight",
      detail: preflight.blockers.map((blocker) => blocker._tag).join(", "),
    });
  }

  const lease = yield* ports.lock
    .acquire({
      workspaceRoot: input.cwd,
      epicId: input.epicId,
      owner: `t3-epic-cook-${String(process.pid)}`,
      runDir: input.runDirectory,
    })
    .pipe(
      Effect.mapError(
        (cause) =>
          new SequentialEpicLoopError({
            operation: "acquire-lock",
            detail: errorDetail(cause),
            cause,
          }),
      ),
    );

  let activeHandle: IterationHandle | null = null;
  let run: PersistedEpicRun = {
    runId: EpicRunId.make(input.runId),
    epicId: input.epicId,
    projectId: ProjectId.make(input.projectId ?? `local-${input.epicId}`),
    cwd: input.cwd,
    prompt: input.promptPreamble ?? "",
    orientationFile: config.orientation.file,
    modelSelection: input.selection,
    runtimeMode: config.runtime.mode,
    config,
    configProvenance: snapshot.provenance,
    originThreadId: null,
    status: "running",
    maxIterations: config.limits.maxIterations,
    workers: 1,
    iterationsDispatched: 0,
    iterationsCompleted: 0,
    currentThreadId: null,
    currentTurnStartedAt: null,
    consecutiveFailures: 0,
    noCommitStreak: 0,
    infraStreak: 0,
    lastError: null,
    createdAt: now(),
    updatedAt: now(),
  };
  const attempts = new Map<string, number>();
  const trackedChildren = new Map<string, number>();
  const exhaustedIterations = new Map<string, number>();
  const publishedRecoveryEvents = new Set<string>();

  const siblings = input.repository.siblings;
  const siblingRule =
    siblings.length === 0
      ? undefined
      : siblingRuleSequential({
          siblings: siblings.map((sibling) => ({ canonicalPath: sibling.repositoryPath })),
        });
  /** FIRST_HEAD / FIRST_SIB_HEAD (`skills/cook-epic/run-legacy.sh:2473-2478`):
   * the landing push covers every repo whose HEAD moved since the child's
   * FIRST dispatch, so a retry pushes an earlier attempt's commits too. */
  const firstDispatchHeads = new Map<
    string,
    {
      readonly main: string | null;
      readonly siblings: ReadonlyArray<{
        readonly repositoryPath: string;
        readonly head: string | null;
      }>;
    }
  >();

  const readSiblingHeads = Effect.fn("runSequentialEpicLoop.readSiblingHeads")(function* () {
    const heads: Array<{ readonly repositoryPath: string; readonly head: string | null }> = [];
    for (const sibling of siblings) {
      heads.push({
        repositoryPath: sibling.repositoryPath,
        head: yield* ports.vcs.headCommit(siblingRepoRef(sibling)),
      });
    }
    return heads;
  });

  // The dirty fingerprint spans every repo of the set: a worker leaving any
  // sibling checkout dirty blocks the handoff exactly like main-repo dirt
  // (`skills/cook-epic/run-legacy.sh:2713-2716`). With no siblings configured
  // this is the main-repo fingerprint alone, one call, as before.
  const readFingerprint = Effect.fn("runSequentialEpicLoop.readFingerprint")(function* () {
    const main = yield* ports.vcs.worktreeFingerprint(input.repository);
    if (siblings.length === 0 || main === null) return main;
    const parts = [main];
    for (const sibling of siblings) {
      const part = yield* ports.vcs.worktreeFingerprint(siblingRepoRef(sibling));
      if (part === null) return null;
      parts.push(part);
    }
    return parts.join("\n");
  });

  // A sequential child's effects can land in any repo of the set: a moved
  // sibling HEAD counts as committed (`skills/cook-epic/run-legacy.sh:2718-2721`).
  const siblingHeadsMoved = (
    before: ReadonlyArray<{ readonly repositoryPath: string; readonly head: string | null }>,
    after: ReadonlyArray<{ readonly repositoryPath: string; readonly head: string | null }>,
  ): boolean => before.some((entry, index) => entry.head !== (after[index]?.head ?? null));

  const publishClaimRecovery = Effect.fn("runSequentialEpicLoop.publishClaimRecovery")(function* (
    issueId: string,
    iterationIndex: number,
  ) {
    yield* ports.events.publish({
      type: "child-claim-released",
      runId: run.runId,
      issueId,
      iterationIndex,
      reason: CHILD_CLAIM_RELEASED_REASON,
    });
    publishedRecoveryEvents.add(issueId);
  });

  const saveRun = Effect.fn("runSequentialEpicLoop.saveRun")(function* () {
    run = { ...run, updatedAt: now() };
    yield* ports.journal.saveRun(run);
    yield* ports.events.publish({ type: "run-state-changed", run });
  });

  const body = Effect.gen(function* () {
    yield* ports.journal.createRun(run);
    yield* ports.events.publish({ type: "run-state-changed", run });

    while (run.status === "running") {
      if (yield* input.shouldStop()) {
        run = { ...run, status: "cancelled", lastError: "cancelled" };
        yield* saveRun();
        break;
      }
      if (run.iterationsDispatched >= config.limits.maxIterations) {
        const children = yield* ports.backlog.listChildren(input.epicId);
        const stillOpen = children.filter((issue) => openStatus(issue.status));
        run =
          stillOpen.length === 0
            ? { ...run, status: "done", lastError: null }
            : {
                ...run,
                status: "failed",
                lastError: `maximum iterations reached (${String(config.limits.maxIterations)}); open:${stillOpen.map((issue) => issue.id).join(",")}`,
              };
        yield* saveRun();
        break;
      }

      const ready = yield* ports.backlog.readyChildren(input.epicId, 1);
      const child = ready[0];
      if (child === undefined) {
        const children = yield* ports.backlog.listChildren(input.epicId);
        const stillOpen = children.filter((issue) => openStatus(issue.status));
        run =
          stillOpen.length === 0
            ? { ...run, status: "done", lastError: null }
            : {
                ...run,
                status: "failed",
                lastError: `child:ready-empty-with-open-children:${stillOpen.map((issue) => issue.id).join(",")}`,
              };
        yield* saveRun();
        break;
      }

      const epic = yield* ports.backlog.showIssue(input.epicId);
      const freshChild = yield* ports.backlog.showIssue(child.id);
      const orientation = yield* input.readOrientation(config.orientation.file).pipe(
        Effect.mapError(
          (cause) =>
            new SequentialEpicLoopError({
              operation: "read-orientation",
              detail: errorDetail(cause),
              cause,
            }),
        ),
      );
      const prompt = workerPrompt({
        epic,
        child: freshChild,
        orientation,
        ...(input.promptPreamble === undefined ? {} : { preamble: input.promptPreamble }),
        ...(siblingRule === undefined ? {} : { siblingRule }),
      });
      const beforeHead = yield* ports.vcs.headCommit(input.repository);
      const beforeFingerprint = yield* readFingerprint();
      const beforeSiblingHeads = yield* readSiblingHeads();
      if (!firstDispatchHeads.has(child.id)) {
        firstDispatchHeads.set(child.id, { main: beforeHead, siblings: beforeSiblingHeads });
      }
      const preCommentCount = freshChild.commentCount;
      const iterationIndex = run.iterationsDispatched;
      const threadId = ThreadId.make(
        epicRunIterationThreadId({ runId: input.runId, iterationIndex }),
      );
      const startedAt = now();
      const pending: PersistedEpicRunIteration = {
        runId: run.runId,
        iterationIndex,
        threadId,
        issueId: child.id,
        turnStatus: "running",
        summary: null,
        why: null,
        failureReason: null,
        headBefore: beforeHead,
        headAfter: null,
        startedAt,
        finishedAt: null,
      };
      if (yield* input.shouldStop()) {
        run = { ...run, status: "cancelled", lastError: "cancelled" };
        yield* saveRun();
        break;
      }
      yield* ports.journal.appendIteration(pending);
      trackedChildren.set(child.id, iterationIndex);
      yield* ports.events.publish({ type: "iteration-state-changed", iteration: pending });
      run = {
        ...run,
        iterationsDispatched: iterationIndex + 1,
        currentThreadId: threadId,
        currentTurnStartedAt: startedAt,
      };
      yield* saveRun();

      let dispatchFailed = false;
      let outcome: EpicIterationOutcome;
      // No resume path here, on purpose. This loop dispatches through the
      // older single-step `AgentDispatchShape.startIteration`, which has no
      // durable ref to adopt and no two-phase transition to slot a resume
      // into. Restart recovery for an interrupted iteration lives in
      // `ParallelEpicLoop.ts` (`resumedWorkers`), which is the only loop the
      // server runs; this one is CLI and conformance only.
      const started = yield* Effect.result(
        ports.dispatch.startIteration({
          runId: input.runId,
          iterationIndex,
          cwd: input.cwd,
          worktreePath: null,
          prompt,
          selection: run.modelSelection,
        }),
      );
      if (started._tag === "Failure") {
        dispatchFailed = true;
        outcome = { kind: "error", detail: errorDetail(started.failure), report: null };
      } else {
        activeHandle = started.success;
        const settled = yield* activeHandle.awaitSettled;
        const liveness = yield* activeHandle.runningSubagents;
        if (liveness.mode === "unavailable") {
          yield* ports.events.publish({
            type: "subagent-liveness-unavailable",
            runId: run.runId,
            iterationIndex,
            reason: liveness.reason,
          });
        } else if (liveness.mode === "external") {
          yield* ports.events.publish({
            type: "subagent-liveness-degraded",
            runId: run.runId,
            iterationIndex,
            evidence: liveness.evidence,
          });
        }
        const final = yield* activeHandle.finalMessage;
        const afterHead = yield* ports.vcs.headCommit(input.repository);
        const settledSiblingHeads = yield* readSiblingHeads();
        outcome = classifyIteration({
          turnState: settled.turnState,
          finalMessage:
            final.text === null ? null : { text: final.text, streaming: final.streaming },
          finalMessageWaitExhausted: final.waitExhausted,
          sessionLastError: settled.providerError,
          assistantProviderErrorsTrusted:
            activeHandle.capabilities.providerErrors === "session-and-assistant",
          committed:
            beforeHead !== afterHead || siblingHeadsMoved(beforeSiblingHeads, settledSiblingHeads),
          timedOut: settled.timedOut,
        });
        yield* activeHandle.release;
        activeHandle = null;
      }

      const afterHead = yield* ports.vcs.headCommit(input.repository);
      const afterSiblingHeads = yield* readSiblingHeads();
      const committed =
        beforeHead !== afterHead || siblingHeadsMoved(beforeSiblingHeads, afterSiblingHeads);
      const afterWorkerFingerprint = yield* readFingerprint();
      let postChild = yield* ports.backlog.showIssue(child.id);
      const findingsDelivered =
        postChild.status === "closed" && postChild.commentCount > preCommentCount;
      let evidenceFailure: string | null = null;
      let forceChildRetry = false;
      let fatalFailure = false;
      if (findingsDelivered && !committed) {
        outcome = { kind: "done", detail: null, report: outcome.report };
      } else if (outcome.kind === "done" && postChild.status !== "closed") {
        outcome = {
          kind: "no-commit",
          detail: "child remained open after the committed turn",
          report: outcome.report,
        };
        evidenceFailure = "no-commit-child-open";
      } else if (outcome.kind === "no-commit" && postChild.status === "closed") {
        evidenceFailure = isResearch(freshChild)
          ? "closed-without-findings"
          : "no-commit-no-evidence";
      }

      if (
        isResearch(freshChild) &&
        postChild.status === "closed" &&
        postChild.commentCount <= preCommentCount
      ) {
        outcome = {
          kind: "blocked",
          detail: "research child closed without new findings",
          report: outcome.report,
        };
        evidenceFailure = "closed-without-findings";
        forceChildRetry = true;
      }

      if (
        beforeFingerprint === null ||
        afterWorkerFingerprint === null ||
        afterWorkerFingerprint !== beforeFingerprint
      ) {
        outcome = {
          kind: "blocked",
          detail: "worker left the worktree dirty",
          report: outcome.report,
        };
        evidenceFailure = "dirty-worktree";
        forceChildRetry = true;
      }

      if (outcome.kind === "done" && committed) {
        if (!config.gate.disabled) {
          const command = config.gate.command;
          if (command === null) {
            outcome = { kind: "error", detail: "gate command is required", report: outcome.report };
            evidenceFailure = "gate-missing";
          } else {
            const gated = yield* ports.gate.run({
              command,
              repositories: [input.repository],
              cwd: input.cwd,
              maxOutputBytes: 1024 * 1024,
            });
            if (!gated.passed) {
              outcome = {
                kind: "blocked",
                detail: `gate failed: ${gated.output}`,
                report: outcome.report,
              };
              evidenceFailure = "gate-failed";
              forceChildRetry = true;
            }
          }
        }
        const afterGateFingerprint = yield* readFingerprint();
        if (
          outcome.kind === "done" &&
          (afterGateFingerprint === null || afterGateFingerprint !== beforeFingerprint)
        ) {
          outcome = {
            kind: "blocked",
            detail: "gate left the worktree dirty",
            report: outcome.report,
          };
          evidenceFailure = "dirty-worktree-after-gate";
          forceChildRetry = true;
        }
        if (outcome.kind === "done" && !config.vcs.noPush) {
          const markPushFailed = (detail: string) => {
            outcome = {
              kind: "error",
              detail: `push failed: ${detail}`,
              report: outcome.report,
            };
            evidenceFailure = "push-failed";
            fatalFailure = true;
          };
          if (siblings.length === 0) {
            const pushed = yield* Effect.result(
              ports.vcs.push({
                repositoryPath: input.cwd,
                remote: "origin",
                refspec: `HEAD:${input.repository.baseBranch}`,
              }),
            );
            if (pushed._tag === "Failure") {
              markPushFailed(errorDetail(pushed.failure));
            }
          } else {
            // push_sequential_child_effects: push every repo whose HEAD moved
            // since the child's first dispatch
            // (`skills/cook-epic/run-legacy.sh:2471-2484`).
            const first = firstDispatchHeads.get(child.id) ?? {
              main: beforeHead,
              siblings: beforeSiblingHeads,
            };
            const mainHead = yield* ports.vcs.headCommit(input.repository);
            if (mainHead !== first.main) {
              const pushed = yield* Effect.result(
                ports.vcs.push({
                  repositoryPath: input.cwd,
                  remote: "origin",
                  refspec: `HEAD:${input.repository.baseBranch}`,
                }),
              );
              if (pushed._tag === "Failure") {
                markPushFailed(errorDetail(pushed.failure));
              }
            }
            for (const sibling of siblings) {
              if (fatalFailure) break;
              const firstHead =
                first.siblings.find((entry) => entry.repositoryPath === sibling.repositoryPath)
                  ?.head ?? null;
              const currentHead = yield* ports.vcs.headCommit(siblingRepoRef(sibling));
              if (currentHead === firstHead) continue;
              const branch = yield* Effect.result(ports.vcs.currentBranch(sibling.repositoryPath));
              if (branch._tag === "Failure" || branch.success === null) {
                markPushFailed(
                  branch._tag === "Failure"
                    ? errorDetail(branch.failure)
                    : `sibling ${sibling.repositoryPath} is not on a branch`,
                );
                break;
              }
              const pushed = yield* Effect.result(
                ports.vcs.push({
                  repositoryPath: sibling.repositoryPath,
                  remote: "origin",
                  refspec: `HEAD:${branch.success}`,
                }),
              );
              if (pushed._tag === "Failure") {
                markPushFailed(errorDetail(pushed.failure));
                break;
              }
            }
          }
        }
      }

      const successful = outcome.kind === "done";
      const consumesChildAttempt =
        forceChildRetry || iterationFailureClass(outcome.kind) === "child";
      const attempt = (attempts.get(child.id) ?? 0) + (successful || !consumesChildAttempt ? 0 : 1);
      attempts.set(child.id, attempt);
      const childAttemptBudgetExhausted =
        consumesChildAttempt && attempt >= config.limits.maxAttemptsPerChild;
      if (childAttemptBudgetExhausted) exhaustedIterations.set(child.id, iterationIndex);
      let claimReleased = false;
      if (!successful && !fatalFailure) {
        const recovery = yield* Effect.result(ports.backlog.releaseClaim(child.id));
        if (recovery._tag === "Failure") {
          yield* Effect.logWarning("epic.loop.release-claimed-child-failed", {
            issueId: child.id,
            cause: recovery.failure,
          });
        } else if (recovery.success) {
          claimReleased = true;
          const refreshed = yield* Effect.result(ports.backlog.showIssue(child.id));
          if (refreshed._tag === "Success") postChild = refreshed.success;
        }
      }

      const turnStatus = successful ? ("completed" as const) : ("failed" as const);
      const finishedAt = now();
      const updated: PersistedEpicRunIteration = {
        ...pending,
        turnStatus,
        summary: outcome.report?.summary ?? outcome.detail,
        why: outcome.report?.why ?? null,
        failureReason: persistedFailureReason({
          iterationStatus: turnStatus,
          dispatchFailed,
          evidenceFailureReason: evidenceFailure,
          outcome,
        }),
        headBefore: beforeHead,
        headAfter: afterHead,
        finishedAt,
      };
      yield* ports.journal.updateIteration(updated);
      yield* ports.events.publish({ type: "iteration-state-changed", iteration: updated });
      if (claimReleased && childAttemptBudgetExhausted) {
        yield* publishClaimRecovery(child.id, iterationIndex);
      }

      let providerFallbackEvent: Extract<
        Parameters<RunEventsShape["publish"]>[0],
        { readonly type: "provider-fallback" }
      > | null = null;
      let fallbackSelection: AgentSelection | null = null;
      if (
        outcome.providerFallbackEligible === true &&
        outcome.failureReason?.startsWith("provider-error")
      ) {
        const providers = yield* ports.providerInventory.getProviders;
        fallbackSelection = resolveEpicProviderFallback({
          providers,
          current: run.modelSelection,
          failureReason: outcome.failureReason,
          providerFallbackEligible: true,
        });
        if (fallbackSelection !== null) {
          const fromProvider = providers.find(
            (provider) => provider.instanceId === run.modelSelection.instanceId,
          );
          const toProvider = providers.find(
            (provider) => provider.instanceId === fallbackSelection?.instanceId,
          );
          if (fromProvider !== undefined && toProvider !== undefined) {
            providerFallbackEvent = {
              type: "provider-fallback",
              runId: run.runId,
              issueId: child.id,
              iterationIndex,
              failureReason: outcome.failureReason,
              fromInstanceId: run.modelSelection.instanceId,
              fromDriver: fromProvider.driver,
              fromModel: run.modelSelection.model,
              toInstanceId: fallbackSelection.instanceId,
              toDriver: toProvider.driver,
              toModel: fallbackSelection.model,
            };
          } else {
            fallbackSelection = null;
          }
        }
      }

      const decision = decideIterationBoundary({
        runStatus: run.status,
        consecutiveFailures: run.consecutiveFailures,
        noCommitStreak: run.noCommitStreak,
        infraStreak: run.infraStreak,
        lastError: run.lastError,
        outcome,
        noCommitChildClosed: findingsDelivered && !committed,
        providerFallbackApplied: fallbackSelection !== null,
        providerTurnDispatched: true,
        limits: {
          maxConsecutiveFailures: config.server.maxConsecutiveFailures,
          maxNoCommitStreak: config.server.maxNoCommitStreak,
          infraFailureBudget: config.server.infraFailureBudget,
          retryBaseDelayMs: config.server.retryBaseDelayMs,
          retryMaxDelayMs: config.server.retryMaxDelayMs,
        },
      });
      run = {
        ...run,
        iterationsCompleted: run.iterationsCompleted + 1,
        currentThreadId: null,
        currentTurnStartedAt: null,
        consecutiveFailures: decision.nextConsecutiveFailures,
        noCommitStreak: decision.nextNoCommitStreak,
        infraStreak: decision.nextInfraStreak,
        lastError: decision.lastError,
        ...(fallbackSelection === null ? {} : { modelSelection: fallbackSelection }),
        ...(decision.nextStatus === null ? {} : { status: decision.nextStatus }),
        ...(childAttemptBudgetExhausted
          ? {
              status: "failed" as const,
              lastError: outcome.detail ?? outcome.kind,
            }
          : {}),
        ...(fatalFailure ? { status: "failed" as const, lastError: outcome.detail } : {}),
      };
      yield* saveRun();
      if (providerFallbackEvent !== null) yield* ports.events.publish(providerFallbackEvent);
      if (fatalFailure || childAttemptBudgetExhausted || decision.action === "stop") break;
      if (decision.delayMs > 0) yield* Effect.sleep(decision.delayMs);
    }
    return run;
  });

  return yield* body.pipe(
    Effect.catch((cause) => {
      run = {
        ...run,
        status: "failed",
        lastError: errorDetail(cause),
        currentThreadId: null,
        currentTurnStartedAt: null,
      };
      return ports.journal
        .saveRun(run)
        .pipe(
          Effect.andThen(ports.events.publish({ type: "run-state-changed", run })),
          Effect.ignore,
          Effect.andThen(Effect.fail(cause)),
        );
    }),
    Effect.ensuring(
      Effect.gen(function* () {
        if (activeHandle !== null) {
          yield* activeHandle.interrupt.pipe(Effect.ignore);
          yield* activeHandle.release.pipe(Effect.ignore);
        }
        for (const issueId of trackedChildren.keys()) {
          const released = yield* Effect.result(ports.backlog.releaseClaim(issueId));
          if (released._tag === "Failure") {
            yield* Effect.logWarning("epic.loop.release-claimed-child-failed", {
              issueId,
              cause: released.failure,
            });
            continue;
          }
          if (!released.success || publishedRecoveryEvents.has(issueId)) continue;
          const exhaustedIterationIndex = exhaustedIterations.get(issueId);
          if (exhaustedIterationIndex === undefined) continue;
          yield* publishClaimRecovery(issueId, exhaustedIterationIndex).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("epic.loop.publish-claim-recovery-failed", {
                issueId,
                cause,
              }),
            ),
          );
        }
        yield* lease.release.pipe(Effect.ignore);
      }),
    ),
  );
});
