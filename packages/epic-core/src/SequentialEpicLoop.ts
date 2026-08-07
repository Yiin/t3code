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
import type { RunEventsShape } from "./ports/RunEvents.ts";
import type {
  PersistedEpicRun,
  PersistedEpicRunIteration,
  RunJournalShape,
} from "./ports/RunJournal.ts";
import type { RepoRef, VcsShape } from "./ports/Vcs.ts";

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
}): string => `${input.preamble ?? "Complete the assigned epic child end-to-end."}

Work only child \`${input.child.id}\`: ${input.child.title}
ASSIGNED_CHILD_ID=${input.child.id}

Use bd to claim this child. Implement it. Run focused checks. Commit the result, but do not push. Close the child and append its epic progress note. Stop after this child. Keep all work in the foreground. End a completed iteration with exactly one line:
RALPH_MSG: {"summary":"<what you built, one clause>","why":"<why it was needed, one clause>"}

## Epic context

${input.epic.description || "(epic description unavailable)"}

## Agent orientation

${input.orientation}
`;

const isResearch = (issue: BacklogIssue): boolean =>
  issue.title.startsWith("Research:") ||
  issue.labels.some((label) => label.toLowerCase() === "research");

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
      });
      const beforeHead = yield* ports.vcs.headCommit(input.repository);
      const beforeFingerprint = yield* ports.vcs.worktreeFingerprint(input.repository);
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
      yield* ports.backlog.claim(child.id, `t3code-${String(process.pid)}`);
      yield* ports.journal.appendIteration(pending);
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
      const started = yield* Effect.result(
        ports.dispatch.startIteration({
          runId: input.runId,
          iterationIndex,
          cwd: input.cwd,
          worktreePath: null,
          prompt,
          selection: input.selection,
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
        outcome = classifyIteration({
          turnState: settled.turnState,
          finalMessage:
            final.text === null ? null : { text: final.text, streaming: final.streaming },
          finalMessageWaitExhausted: final.waitExhausted,
          sessionLastError: settled.providerError,
          committed: beforeHead !== afterHead,
          timedOut: settled.timedOut,
        });
        yield* activeHandle.release;
        activeHandle = null;
      }

      const afterHead = yield* ports.vcs.headCommit(input.repository);
      const committed = beforeHead !== afterHead;
      const afterWorkerFingerprint = yield* ports.vcs.worktreeFingerprint(input.repository);
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
        const afterGateFingerprint = yield* ports.vcs.worktreeFingerprint(input.repository);
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
          const pushed = yield* Effect.result(
            ports.vcs.push({
              repositoryPath: input.cwd,
              remote: "origin",
              refspec: `HEAD:${input.repository.baseBranch}`,
            }),
          );
          if (pushed._tag === "Failure") {
            outcome = {
              kind: "error",
              detail: `push failed: ${errorDetail(pushed.failure)}`,
              report: outcome.report,
            };
            evidenceFailure = "push-failed";
            fatalFailure = true;
          }
        }
      }

      const successful = outcome.kind === "done";
      const consumesChildAttempt =
        forceChildRetry || iterationFailureClass(outcome.kind) === "child";
      const attempt = (attempts.get(child.id) ?? 0) + (successful || !consumesChildAttempt ? 0 : 1);
      attempts.set(child.id, attempt);
      if (!successful && !fatalFailure && consumesChildAttempt) {
        yield* ports.backlog.setStatus(
          child.id,
          attempt >= config.limits.maxAttemptsPerChild ? "blocked" : "open",
        );
        postChild = yield* ports.backlog.showIssue(child.id);
      } else if (!successful && !fatalFailure && !consumesChildAttempt) {
        yield* ports.backlog.setStatus(child.id, "open");
        postChild = yield* ports.backlog.showIssue(child.id);
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

      const decision = decideIterationBoundary({
        runStatus: run.status,
        consecutiveFailures: run.consecutiveFailures,
        noCommitStreak: run.noCommitStreak,
        infraStreak: run.infraStreak,
        lastError: run.lastError,
        outcome,
        noCommitChildClosed: findingsDelivered && !committed,
        providerFallbackApplied: false,
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
        ...(decision.nextStatus === null ? {} : { status: decision.nextStatus }),
        ...(fatalFailure ? { status: "failed" as const, lastError: outcome.detail } : {}),
      };
      yield* saveRun();
      if (fatalFailure || decision.action === "stop") break;
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
        yield* lease.release.pipe(Effect.ignore);
      }),
    ),
  );
});
