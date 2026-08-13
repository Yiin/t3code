// @effect-diagnostics globalDate:off
import { EpicRunId, ProjectId, ThreadId, epicRunIterationThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { EpicRunConfigSnapshot, EpicRunPreflightShape } from "./EpicRunPreflight.ts";
import {
  childAttemptsFromHistory,
  decideIterationBoundary,
  persistedFailureReason,
} from "./policy.ts";
import {
  classifyIteration,
  iterationFailureClass,
  type EpicIterationOutcome,
} from "./ralphProtocol.ts";
import type { AgentDispatchShape, AgentSelection, IterationHandle } from "./ports/AgentDispatch.ts";
import type { BacklogIssue, BacklogShape } from "./ports/Backlog.ts";
import type { EpicRunLockShape } from "./ports/EpicRunLock.ts";
import type { GateShape } from "./ports/Gate.ts";
import { persistedGateReceipt, type GateReceiptJournalShape } from "./ports/GateReceipts.ts";
import type { ProviderInventoryShape } from "./ports/ProviderInventory.ts";
import type { RoleSelectionShape } from "./ports/RoleSelection.ts";
import { CHILD_CLAIM_RELEASED_REASON, type RunEventsShape } from "./ports/RunEvents.ts";
import type {
  PersistedEpicRun,
  PersistedEpicRunIteration,
  ProviderDegradationJournalShape,
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
  /**
   * Where a provider-attributed failure is recorded so the NEXT run of this
   * epic starts past the account that failed. `null` keeps a run's fallback to
   * itself, which is how this loop behaved before the record existed.
   */
  readonly providerDegradation?: ProviderDegradationJournalShape | null;
  readonly events: RunEventsShape;
  readonly providerInventory: ProviderInventoryShape;
  /**
   * `null` keeps every dispatch on the run-level selection, exactly as it was
   * before per-role tiers existed.
   */
  readonly roleSelection: RoleSelectionShape | null;
  readonly dispatch: AgentDispatchShape;
  readonly gate: GateShape;
  /** Where this loop's own gate lands before its verdict changes the outcome. */
  readonly gateReceipts: GateReceiptJournalShape;
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
  // Phase timings read the SAME clock the records are stamped from, so an
  // injected clock cannot produce a record whose stamps and durations disagree.
  const nowMs = () => {
    const parsed = Date.parse(now());
    return Number.isFinite(parsed) ? parsed : 0;
  };
  const sinceMs = (from: number) => Math.max(0, nowMs() - from);
  /** Elapsed between a stamped record time and a measured one. */
  const sinceAtMs = (fromIso: string, to: number) => {
    const from = Date.parse(fromIso);
    return Number.isFinite(from) ? Math.max(0, to - from) : 0;
  };
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
  /**
   * Per-child attempt budgets, shared with the parallel loop: a child that
   * absorbs `maxAttemptsPerChild` child-class failures fails the run.
   *
   * The map is per process, so `body` seeds it from this run's own durable
   * iteration rows before the first dispatch: a restart must not hand a child
   * back the attempts a previous process already spent on it.
   */
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

  /**
   * Take ownership of this run id's durable record, and report the rows that
   * are already on disk under it.
   *
   * This runs OUTSIDE the failure handler below, on purpose: a run record this
   * process was not allowed to adopt must not be rewritten with this process's
   * failure.
   */
  const adoptRun = Effect.gen(function* () {
    // Read the durable rows BEFORE the run record exists: this is the only
    // evidence of what earlier processes of this run id already did, and both
    // the resume index and the attempt budgets are seeded from it.
    const priorIterations = yield* ports.journal.listIterations(run.runId);
    const existing = yield* ports.journal.getRun(run.runId);
    if (Option.isNone(existing)) {
      yield* ports.journal.createRun(run);
    } else {
      // A run that already reached `done` is finished. Re-entering it would
      // dispatch fresh work against a closed record, so refuse instead.
      if (existing.value.status === "done") {
        return yield* new SequentialEpicLoopError({
          operation: "resume",
          detail: `Run ${run.runId} already finished`,
        });
      }
      // A run id names one epic's work. Continuing it under another epic would
      // append that epic's children to this run's evidence.
      if (existing.value.epicId !== input.epicId) {
        return yield* new SequentialEpicLoopError({
          operation: "resume",
          detail: `Run ${run.runId} belongs to ${existing.value.epicId}, not ${input.epicId}`,
        });
      }
      // Continue past the highest persisted row, the way
      // `PoolRunJournal.allocateIteration` does. The rows win over the
      // counter: a crash between `appendIteration` and the run save leaves a
      // row this run's counter never saw, and reusing that index would fail
      // the append.
      const nextIterationIndex = priorIterations.reduce(
        (next, iteration) => Math.max(next, iteration.iterationIndex + 1),
        existing.value.iterationsDispatched,
      );
      run = {
        ...run,
        createdAt: existing.value.createdAt,
        // Progress an earlier process already spent. A restart inherits the
        // run's budgets rather than starting them over.
        iterationsDispatched: nextIterationIndex,
        iterationsCompleted: existing.value.iterationsCompleted,
        consecutiveFailures: existing.value.consecutiveFailures,
        noCommitStreak: existing.value.noCommitStreak,
        infraStreak: existing.value.infraStreak,
        lastError: existing.value.lastError,
        status: "running",
        currentThreadId: null,
        currentTurnStartedAt: null,
        updatedAt: now(),
      };
      // No process owns the rows the interrupted one left in flight. This loop
      // has no resume dispatch (see the note in the dispatch block), so they
      // are settled as abandoned rather than continued.
      for (const iteration of priorIterations) {
        if (iteration.turnStatus !== "running") continue;
        const abandoned: PersistedEpicRunIteration = {
          ...iteration,
          turnStatus: "abandoned",
          summary: "abandoned by an earlier process of this run",
          failureReason: "process-restart",
          finishedAt: now(),
        };
        yield* ports.journal.updateIteration(abandoned);
        yield* ports.events.publish({ type: "iteration-state-changed", iteration: abandoned });
      }
      yield* ports.journal.saveRun(run);
      yield* Effect.logInfo("epic.loop.sequential-resumed", {
        runId: run.runId,
        iterationsDispatched: run.iterationsDispatched,
        previousStatus: existing.value.status,
      });
    }
    yield* ports.events.publish({ type: "run-state-changed", run });
    return priorIterations;
  });

  const body = Effect.fn("runSequentialEpicLoop.body")(function* (
    priorIterations: ReadonlyArray<PersistedEpicRunIteration>,
  ) {
    // Restore what earlier processes of THIS run already charged, before any
    // dispatch. An empty journal restores nothing, which is how a first run
    // behaved before this existed.
    const restoredAttempts = childAttemptsFromHistory(priorIterations);
    for (const [issueId, spent] of restoredAttempts) attempts.set(issueId, spent);
    if (restoredAttempts.size > 0) {
      yield* Effect.logInfo("epic.loop.child-attempts-restored", {
        runId: run.runId,
        attempts: Object.fromEntries(restoredAttempts),
      });
    }

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
      // Resolved before the record is written, so the record can name the tier
      // that produced it. This loop has no merge queue, so every dispatch it
      // makes is an iteration worker. Provider fallback keeps writing the run
      // row, and the resolver reads it back as `fallbackSelection` next
      // iteration.
      const resolvedRole =
        ports.roleSelection === null
          ? null
          : yield* ports.roleSelection.resolve({
              role: "iteration-worker",
              runId: input.runId,
              issueId: child.id,
              issueTitle: freshChild.title,
              fallbackSelection: run.modelSelection,
            });
      const dispatchSelection = resolvedRole?.selection ?? run.modelSelection;
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
        tierId: resolvedRole?.tierId ?? null,
        providerInstanceId: dispatchSelection.instanceId,
        model: dispatchSelection.model,
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

      const preparedAtMs = nowMs();
      let providerMs = 0;
      let settlementMs = 0;
      let gateMs = 0;
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
          selection: dispatchSelection,
        }),
      );
      if (started._tag === "Failure") {
        dispatchFailed = true;
        outcome = { kind: "error", detail: errorDetail(started.failure), report: null };
      } else {
        activeHandle = started.success;
        const settled = yield* activeHandle.awaitSettled;
        providerMs = sinceMs(preparedAtMs);
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

      const settlementStartMs = nowMs();
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

      settlementMs = sinceMs(settlementStartMs);

      if (outcome.kind === "done" && committed) {
        if (!config.gate.disabled) {
          const command = config.gate.command;
          if (command === null) {
            outcome = { kind: "error", detail: "gate command is required", report: outcome.report };
            evidenceFailure = "gate-missing";
          } else {
            const gateStartMs = nowMs();
            const gated = yield* ports.gate.run({
              command,
              repositories: [input.repository],
              cwd: input.cwd,
              maxOutputBytes: 1024 * 1024,
            });
            gateMs = sinceMs(gateStartMs);
            // Persisted before the verdict changes the outcome, so a crash
            // between the two still leaves proof of what was verified.
            yield* ports.gateReceipts.record(
              persistedGateReceipt({
                runId: run.runId,
                phase: "sequential",
                childId: child.id,
                branch: null,
                receipt: gated.receipt,
              }),
            );
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
        phaseTimings: {
          prepareMs: sinceAtMs(startedAt, preparedAtMs),
          providerMs,
          settlementMs,
          // No merge queue in this loop: the child commits onto the base
          // branch directly, so there is no merge for an iteration to wait on.
          mergeWaitMs: 0,
          gateMs,
        },
        promptBytes: new TextEncoder().encode(prompt).byteLength,
        finishedAt,
      };
      yield* ports.journal.updateIteration(updated);
      yield* ports.events.publish({ type: "iteration-state-changed", iteration: updated });
      if (claimReleased && childAttemptBudgetExhausted) {
        yield* publishClaimRecovery(child.id, iterationIndex);
      }

      // A turn that reached the provider and finished proves the account
      // works, so retire whatever an earlier run recorded against it.
      if (successful && !dispatchFailed && ports.providerDegradation != null) {
        yield* ports.providerDegradation.clearProviderDegradation({
          providerInstanceId: dispatchSelection.instanceId,
        });
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
        // Keyed on what this iteration was dispatched on, which is the run
        // selection unless a role resolved somewhere else.
        fallbackSelection = resolveEpicProviderFallback({
          providers,
          current: dispatchSelection,
          failureReason: outcome.failureReason,
          providerFallbackEligible: true,
        });
        if (fallbackSelection !== null) {
          const fromProvider = providers.find(
            (provider) => provider.instanceId === dispatchSelection.instanceId,
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
              fromInstanceId: dispatchSelection.instanceId,
              fromDriver: fromProvider.driver,
              fromModel: dispatchSelection.model,
              toInstanceId: fallbackSelection.instanceId,
              toDriver: toProvider.driver,
              toModel: fallbackSelection.model,
            };
          } else {
            fallbackSelection = null;
          }
        }
        if (fallbackSelection !== null && ports.providerDegradation != null) {
          // Recorded against the instance that failed, not the run, so the
          // next run of this epic enters the chain past it.
          yield* ports.providerDegradation.upsertProviderDegradation({
            providerInstanceId: dispatchSelection.instanceId,
            failureReason: outcome.failureReason,
            degradedAt: now(),
          });
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

  return yield* adoptRun.pipe(
    Effect.flatMap((priorIterations) =>
      body(priorIterations).pipe(
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
      ),
    ),
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
