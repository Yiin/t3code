import {
  DEFAULT_EPIC_RUN_CONFIG,
  DEFAULT_EPIC_RUN_CONFIG_PROVENANCE,
  DEFAULT_MODEL_BY_PROVIDER,
  EpicRunId,
  EpicTierId,
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  epicRunIterationThreadId,
  type EpicRunConfig,
  type ModelSelection,
  type ServerProvider,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import * as Queue from "effect/Queue";

import { EpicRunnerDispatchError, EpicRunnerStoreError } from "./Errors.ts";
import {
  runParallelEpicLoop,
  type MergeDrainShape,
  type ParallelEpicLoopPorts,
  type PoolBacklogShape,
  type PoolRunJournalShape,
  type PoolSchedulerEvent,
  type PoolVcsShape,
  type ReadyFrontierSelection,
  type ResumedWorker,
} from "./ParallelEpicLoop.ts";
import { parseMergeFixTitle, type UnlandedMergeEntry } from "./policy.ts";
import type { PoolPolicy } from "./runPolicy.ts";
import type {
  AgentDispatchCapabilities,
  IterationHandle,
  IterationNudgeOutcome,
  IterationResume,
  IterationResumeMode,
  IterationResumeRefusal,
} from "./ports/AgentDispatch.ts";
import type { BacklogIssue } from "./ports/Backlog.ts";
import type { RunEvent } from "./ports/RunEvents.ts";
import type { EpicDispatchRole, RoleSelectionRequest } from "./ports/RoleSelection.ts";
import type { EpicFallbackHop } from "./providerFallback.ts";
import type { WorkerEvidenceShape } from "./ports/WorkerEvidence.ts";
import type { SupervisionClock } from "./workerSupervision.ts";
import type { PersistedEpicRun, PersistedEpicRunIteration } from "./ports/RunJournal.ts";
import type { IterationWorkspace, WorkspaceShape } from "./ports/Workspace.ts";

const RUN_ID = EpicRunId.make("run");
const EPIC_ID = "epic";

type Attempt = {
  /** Move the workspace head during settle. */
  readonly commit?: boolean;
  /** Move every sibling worktree head during settle. */
  readonly siblingCommit?: boolean;
  /** Close the child during settle. */
  readonly close?: boolean;
  /** Append bead evidence during settle. */
  readonly comment?: boolean;
  /** Claim the child during settle without closing it. */
  readonly claim?: boolean;
  /** Settle with a RALPH_BLOCKED final message. */
  readonly blocked?: boolean;
  /** Settle with a RALPH_DONE final message, claiming the backlog is empty. */
  readonly backlogEmpty?: boolean;
  /** Settle in an errored turn carrying this provider error. */
  readonly providerError?: string;
  /** Fail `beginTurn` with an EpicRunnerDispatchError. */
  readonly dispatchFails?: boolean;
  /** Never settle, so the loop's iteration timeout fires. */
  readonly neverSettles?: boolean;
};

/** What the server pool dispatch declares, mirrored for the loop fakes. */
const serverLikeCapabilities: AgentDispatchCapabilities = {
  terminalSignal: "projection",
  continuation: "same-thread",
  subagentLiveness: "native",
  finalMessage: "projection",
  providerErrors: "session-and-assistant",
  cost: "none",
  lifecycle: { resume: "adopt-ref" },
};

const provider = (instanceId: string, driver: string, model: string): ServerProvider => ({
  instanceId: ProviderInstanceId.make(instanceId),
  driver: ProviderDriverKind.make(driver),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-01-01T00:00:00Z",
  availability: "available",
  models: [{ slug: model, name: model, isCustom: false, capabilities: null }],
  slashCommands: [],
  skills: [],
});

const issue = (
  input: Partial<BacklogIssue> & Pick<BacklogIssue, "id" | "title">,
): BacklogIssue => ({
  id: input.id,
  title: input.title,
  status: input.status ?? "open",
  priority: input.priority ?? 1,
  issueType: input.issueType ?? "task",
  parentId: input.parentId ?? EPIC_ID,
  description: input.description ?? "",
  labels: input.labels ?? [],
  commentCount: input.commentCount ?? 0,
});

const config = (override: Partial<EpicRunConfig> = {}): EpicRunConfig => ({
  ...DEFAULT_EPIC_RUN_CONFIG,
  ...override,
  limits: { ...DEFAULT_EPIC_RUN_CONFIG.limits, maxIterations: 10, ...override.limits },
  server: {
    ...DEFAULT_EPIC_RUN_CONFIG.server,
    retryBaseDelayMs: 0,
    retryMaxDelayMs: 0,
    ...override.server,
  },
});

const policy = (override: Partial<PoolPolicy> = {}): PoolPolicy => ({
  iterationTimeoutMs: null,
  runStallTimeoutMs: 600_000,
  pollIntervalMs: 1,
  quietPeriodMs: 1,
  // Off unless a test arms it, so every other test issues exactly the port
  // calls it issued before the conflict radar existed.
  conflictProbeIntervalMs: 0,
  retryBaseDelayMs: 0,
  retryMaxDelayMs: 0,
  maxConsecutiveFailures: 3,
  maxNoCommitStreak: 2,
  infraFailureBudget: 5,
  subagentGraceTimeoutMs: 1,
  maxGraceContinuations: 0,
  maxIterations: 10,
  maxAttemptsPerChild: 3,
  ...override,
});

const fixture = (input: {
  readonly attempts?: ReadonlyArray<Attempt>;
  readonly childId?: string;
  readonly childTitle?: string;
  readonly initialChildStatus?: string;
  readonly sequential?: boolean;
  readonly runConfig?: EpicRunConfig;
  readonly policy?: PoolPolicy;
  readonly providers?: ReadonlyArray<ServerProvider>;
  readonly selection?: ModelSelection;
  /** Flip the persisted run to paused inside `prepareIteration`. */
  readonly pauseDuringPrepare?: boolean;
  /** Override the ready-frontier read. */
  readonly frontier?: () => ReadyFrontierSelection;
  /** Sibling worktrees the acquire fake hands out. */
  readonly siblingWorktrees?: ReadonlyArray<{
    readonly worktreePath: string;
    readonly sourcePath: string;
    readonly baseBranch: string;
  }>;
  /** The sibling rule the acquire fake hands out. */
  readonly siblingRule?: string;
  /** Fail workspace release with an EpicRunnerStoreError. */
  readonly releaseFails?: boolean;
  /** Make every merge drain defer, as an absent or stale merge slot does. */
  readonly drainDefersForever?: boolean;
  /** Who a deferred drain reports as holding the merge slot. */
  readonly drainHolder?: string;
  /** Supply the liveness evidence port; absent means supervision is off. */
  readonly workerEvidence?: WorkerEvidenceShape;
  /** Drive the supervision cadence off a fake clock. */
  readonly supervisionClock?: SupervisionClock;
  /** Iterations a previous process left running, adopted at loop start. */
  readonly resumedWorkers?: ReadonlyArray<ResumedWorker>;
  /**
   * Settled iteration rows an earlier process of this run already wrote. They
   * take the lowest indices, ahead of any resumed worker.
   */
  readonly priorIterations?: ReadonlyArray<{
    readonly issueId: string | null;
    readonly turnStatus: PersistedEpicRunIteration["turnStatus"];
    readonly failureReason: string | null;
  }>;
  /** What the harness declares it can do about a dead handle. */
  readonly resumeCapability?: IterationResumeMode;
  /** What `resumeIteration` answers, one entry per call, in order. */
  readonly resumeRefusals?: ReadonlyArray<IterationResumeRefusal | null>;
  /** What `claimChild` answers for a resumed child. */
  readonly claimChildResult?: "claimed" | "already-claimed" | "closed" | "unknown";
  /** Fail `workspace.adopt`, as a worktree that is gone does. */
  readonly adoptFails?: boolean;
  /** What the git probes report about a resumed worker's leftover tree. */
  readonly worktreeEvidence?: string | null;
  /** Seed the persisted run's counters, e.g. the failure streaks. */
  readonly runSeed?: Partial<PersistedEpicRun>;
  /**
   * Wire a stub role resolver handing back one selection per role. Absent
   * means no resolver at all, which is today's run-level behaviour.
   */
  readonly roleSelections?: Partial<Record<EpicDispatchRole, ModelSelection>>;
  /** The tier each role's selection came from, for attribution assertions. */
  readonly roleTiers?: Partial<Record<EpicDispatchRole, EpicTierId>>;
  /** Live fallback chains returned for each dispatch role. */
  readonly roleChains?: Partial<Record<EpicDispatchRole, ReadonlyArray<EpicFallbackHop>>>;
  /** Extra account blocks returned with role-chain state. */
  readonly roleBlockedInstances?: ReadonlyArray<ProviderInstanceId>;
  /** Where the run integrates, as the conflict radar reads it. */
  readonly integrationTarget?: {
    readonly repositoryPath: string;
    readonly baseBranch: string;
  } | null;
  /** The head of each named ref, re-read on every radar probe. */
  readonly refHeads?: () => Readonly<Record<string, string | null>>;
  /** What the conflict probe reports; `null` is git telling us nothing. */
  readonly conflicts?: () => ReadonlyArray<string> | null;
  /** Kill the conflict probe with a defect. */
  readonly probeDies?: boolean;
  /** Kill the nudge with a defect. */
  readonly nudgeDies?: boolean;
  /** What each nudge answers, in order; absent entries answer `sent`. */
  readonly nudgeOutcomes?: ReadonlyArray<IterationNudgeOutcome>;
  /** Called with the running nudge count, so a test can move a head between probes. */
  readonly onNudge?: (count: number) => void;
  /** Hand out a workspace with no branch of its own, as an in-place worker has. */
  readonly inPlaceWorkspace?: boolean;
  /** What `mergeDrain.unlandedEntries` answers; absent means an empty queue. */
  readonly unlandedMergeEntries?: ReadonlyArray<UnlandedMergeEntry>;
}) => {
  const sequential = input.sequential ?? true;
  const siblingWorktrees = input.siblingWorktrees ?? [];
  let child = issue({
    id: input.childId ?? "epic.1",
    title: input.childTitle ?? "Child",
    status: input.initialChildStatus ?? "open",
  });
  let head = 0;
  const siblingHeads = new Map<string, number>(
    siblingWorktrees.map((sibling) => [sibling.worktreePath, 0]),
  );
  let nextIterationIndex = 0;
  let persistedRun: PersistedEpicRun = {
    runId: RUN_ID,
    epicId: EPIC_ID,
    projectId: ProjectId.make("project"),
    cwd: "/repo",
    prompt: "BASE PROMPT",
    orientationFile: null,
    modelSelection: input.selection ?? {
      instanceId: ProviderInstanceId.make("worker"),
      model: "test",
    },
    runtimeMode: "full-access",
    config: input.runConfig ?? config(),
    configProvenance: DEFAULT_EPIC_RUN_CONFIG_PROVENANCE,
    originThreadId: null,
    status: "running",
    maxIterations: 10,
    workers: 1,
    iterationsDispatched: 0,
    iterationsCompleted: 0,
    currentThreadId: null,
    currentTurnStartedAt: null,
    consecutiveFailures: 0,
    noCommitStreak: 0,
    infraStreak: 0,
    lastError: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...input.runSeed,
  };
  const resumedWorkers = input.resumedWorkers ?? [];
  const priorIterations = input.priorIterations ?? [];
  const iterations: PersistedEpicRunIteration[] = [
    ...priorIterations.map((prior, index) => ({
      runId: RUN_ID,
      iterationIndex: NonNegativeInt.make(index),
      threadId: ThreadId.make(epicRunIterationThreadId({ runId: RUN_ID, iterationIndex: index })),
      issueId: prior.issueId,
      turnStatus: prior.turnStatus,
      summary: null,
      why: null,
      failureReason: prior.failureReason,
      startedAt: IsoDateTime.make("2026-01-01T00:00:00Z"),
      finishedAt: IsoDateTime.make("2026-01-01T00:01:00Z"),
    })),
    ...resumedWorkers.map((worker) => ({
      runId: RUN_ID,
      iterationIndex: worker.iterationIndex,
      threadId: worker.threadId,
      issueId: worker.issueId,
      turnStatus: "running" as const,
      summary: null,
      why: null,
      failureReason: null,
      resumeCount: worker.resumeCount,
      providerInstanceId: worker.selection.instanceId,
      model: worker.selection.model,
      startedAt: worker.startedAt,
      finishedAt: null,
    })),
  ];
  nextIterationIndex = resumedWorkers.reduce(
    (next, worker) => Math.max(next, worker.iterationIndex + 1),
    priorIterations.length,
  );
  const events: RunEvent[] = [];
  const ordering: string[] = [];
  const attempts = input.attempts ?? [];
  let dispatchCount = 0;
  const createCalls: Array<Parameters<ParallelEpicLoopPorts["dispatch"]["createIteration"]>[0]> =
    [];
  const beginTurnCalls: Array<Parameters<ParallelEpicLoopPorts["dispatch"]["beginTurn"]>[0]> = [];
  const resumeCalls: Array<Parameters<ParallelEpicLoopPorts["dispatch"]["resumeIteration"]>[0]> =
    [];
  const acquireCalls: string[] = [];
  const evidenceCwds: string[] = [];
  const adoptCalls: Array<Parameters<WorkspaceShape["adopt"]>[1]> = [];
  const claimChildCalls: string[] = [];
  const stopAbandonedCalls: string[] = [];
  const stopForcedCalls: Array<{ readonly threadId: string; readonly graceSeconds: number }> = [];
  const interruptForcedCalls: string[] = [];
  const releasedClaims: string[] = [];
  const enqueuedMerges: Array<Parameters<MergeDrainShape["enqueueMerge"]>[0]> = [];
  const parkedBranchReads: string[] = [];
  const conflictProbes: Array<{ readonly base: string; readonly branch: string }> = [];
  const nudges: Array<{ readonly ref: string; readonly prompt: string }> = [];
  const providerDegradations: Array<{
    readonly providerInstanceId: string;
    readonly failureReason: string;
  }> = [];
  const providerClears: string[] = [];
  const roleRequests: RoleSelectionRequest[] = [];
  let interrupts = 0;
  let releases = 0;
  let workspaceReleases = 0;
  let drainCalls = 0;
  let integrationReleased: "done" | "cancelled" | "failed" | null = null;

  const journal: PoolRunJournalShape = {
    createRun: (run) =>
      Effect.sync(() => {
        persistedRun = run;
      }),
    saveRun: (run) =>
      Effect.sync(() => {
        persistedRun = run;
        ordering.push(`run:saved:${run.status}:${run.modelSelection.instanceId}`);
      }),
    getRun: () => Effect.succeed(Option.some(persistedRun)),
    appendIteration: (iteration) =>
      Effect.sync(() => {
        iterations.push(iteration);
      }),
    updateIteration: (update) =>
      Effect.sync(() => {
        const index = iterations.findIndex((item) => item.iterationIndex === update.iterationIndex);
        if (index >= 0) iterations[index] = { ...iterations[index]!, ...update };
        ordering.push(`journal:${update.turnStatus}`);
      }),
    markIterationResumed: (input) =>
      Effect.sync(() => {
        const index = iterations.findIndex((item) => item.iterationIndex === input.iterationIndex);
        if (index >= 0) {
          const current = iterations[index]!;
          iterations[index] = {
            ...current,
            turnStatus: "running",
            summary: null,
            why: null,
            failureReason: null,
            finishedAt: null,
            resumeCount: (current.resumeCount ?? 0) + 1,
            lastResumedAt: input.resumedAt,
          };
        }
        ordering.push("journal:resumed");
      }),
    listIterations: () => Effect.succeed(iterations),
    getLatestIteration: () => {
      const latest = iterations.at(-1);
      return Effect.succeed(latest === undefined ? Option.none() : Option.some(latest));
    },
    allocateIteration: (allocation) =>
      Effect.sync(() => {
        const iterationIndex = nextIterationIndex++;
        iterations.push({
          runId: allocation.runId,
          iterationIndex,
          threadId: ThreadId.make(
            epicRunIterationThreadId({ runId: allocation.runId, iterationIndex }),
          ),
          issueId: allocation.issueId,
          turnStatus: "running",
          summary: null,
          why: null,
          failureReason: null,
          tierId: allocation.tierId,
          providerInstanceId: allocation.providerInstanceId,
          model: allocation.model,
          startedAt: allocation.startedAt,
          finishedAt: null,
        });
        ordering.push("journal:running");
        return iterationIndex;
      }),
    upsertProviderDegradation: (degradation) =>
      Effect.sync(() => {
        providerDegradations.push({
          providerInstanceId: degradation.providerInstanceId,
          failureReason: degradation.failureReason,
        });
        ordering.push(`journal:degrade:${degradation.providerInstanceId}`);
      }),
    clearProviderDegradation: (clear) =>
      Effect.sync(() => {
        providerClears.push(clear.providerInstanceId);
      }),
  };

  const backlog: PoolBacklogShape = {
    readyFrontier: () =>
      Effect.sync(
        (): ReadyFrontierSelection =>
          input.frontier !== undefined
            ? input.frontier()
            : child.status === "open"
              ? { _tag: "children", issueIds: [child.id] }
              : { _tag: "empty" },
      ),
    openChildIds: () => Effect.succeed(child.status === "closed" ? [] : [child.id]),
    issueEvidence: () =>
      Effect.succeed({
        status: child.status,
        title: child.title,
        commentCount: child.commentCount,
      }),
    issueIsResearch: () => Effect.succeed(false),
    epicDescription: () => Effect.succeed("EPIC GOAL"),
    releaseClaimedChild: (_cwd, issueId) =>
      Effect.sync(() => {
        releasedClaims.push(issueId);
        ordering.push("backlog:release");
        if (child.status === "in_progress") {
          child = { ...child, status: "open" };
          return true;
        }
        return false;
      }),
    claimChild: (_cwd, issueId) =>
      Effect.sync(() => {
        claimChildCalls.push(issueId);
        const result = input.claimChildResult ?? "claimed";
        if (result === "claimed") child = { ...child, status: "in_progress" };
        if (result === "closed") child = { ...child, status: "closed" };
        return result;
      }),
  };

  const workspace: WorkspaceShape = {
    ensureIntegration: () =>
      Effect.succeed(
        sequential
          ? null
          : // A queued entry makes the loop drain before it dispatches, which
            // is the path an unavailable merge slot defers on.
            { entries: input.drainDefersForever ? [{ status: "queued" as const }] : [] },
      ),
    adopt: (_runCtx, adoptInput) =>
      Effect.suspend(() => {
        adoptCalls.push(adoptInput);
        if (input.adoptFails === true) {
          return Effect.fail(
            new EpicRunnerDispatchError({
              commandType: "git.worktree-adopt",
              detail: `Worktree ${adoptInput.worktreePath ?? "-"} is gone`,
            }),
          );
        }
        return Effect.succeed<IterationWorkspace>({
          cwd: adoptInput.worktreePath ?? "/repo",
          branch: adoptInput.branch,
          worktreePath: adoptInput.worktreePath,
          siblingWorktrees,
          siblingRule: input.siblingRule ?? null,
        });
      }),
    acquire: (_runCtx, acquireInput) =>
      Effect.sync((): IterationWorkspace => {
        acquireCalls.push(acquireInput.issueId);
        if (acquireInput.sequential) {
          return {
            cwd: "/repo",
            branch: null,
            worktreePath: null,
            siblingWorktrees,
            siblingRule: input.siblingRule ?? null,
          };
        }
        if (input.inPlaceWorkspace === true) {
          return {
            cwd: "/repo",
            branch: null,
            worktreePath: null,
            siblingWorktrees,
            siblingRule: input.siblingRule ?? null,
          };
        }
        const mergeFix = parseMergeFixTitle(acquireInput.issueTitle);
        const branch = mergeFix?.branch ?? `epic/${acquireInput.issueId}`;
        return {
          cwd: `/wt/${acquireInput.issueId}`,
          branch,
          worktreePath: `/wt/${acquireInput.issueId}`,
          siblingWorktrees,
          siblingRule: input.siblingRule ?? null,
        };
      }),
    release: () => {
      workspaceReleases += 1;
      return input.releaseFails === true
        ? Effect.fail(new EpicRunnerStoreError({ operation: "workspace.release" }))
        : Effect.void;
    },
    releaseIntegration: (_run, outcome) =>
      Effect.sync(() => {
        integrationReleased = outcome;
      }),
  };

  const capabilities: AgentDispatchCapabilities =
    input.resumeCapability === undefined
      ? serverLikeCapabilities
      : { ...serverLikeCapabilities, lifecycle: { resume: input.resumeCapability } };

  const makeHandle = (ref: string, attempt: Attempt): IterationHandle => ({
    ref,
    capabilities,
    awaitSettled:
      attempt.neverSettles === true
        ? Effect.never
        : Effect.sync(() => {
            if (attempt.commit === true) head += 1;
            if (attempt.siblingCommit === true) {
              for (const path of siblingHeads.keys()) {
                siblingHeads.set(path, (siblingHeads.get(path) ?? 0) + 1);
              }
            }
            if (attempt.claim === true) child = { ...child, status: "in_progress" };
            if (attempt.close === true) child = { ...child, status: "closed" };
            if (attempt.comment === true) {
              child = { ...child, commentCount: child.commentCount + 1 };
            }
            return {
              turnState:
                attempt.providerError === undefined ? ("completed" as const) : ("error" as const),
              timedOut: false,
              providerError: attempt.providerError ?? null,
            };
          }),
    continueTurn: () => Effect.void,
    nudge: (prompt) =>
      Effect.sync(() => {
        if (input.nudgeDies === true) throw new Error("nudge blew up");
        nudges.push({ ref, prompt });
        input.onNudge?.(nudges.length);
        return input.nudgeOutcomes?.[nudges.length - 1] ?? "sent";
      }),
    interrupt: Effect.sync(() => {
      interrupts += 1;
      ordering.push("handle:interrupt");
    }),
    release: Effect.sync(() => {
      releases += 1;
      ordering.push("handle:release");
    }),
    runningSubagents: Effect.succeed({ mode: "native", running: 0 }),
    finalMessage: Effect.succeed(
      attempt.providerError !== undefined
        ? { text: null, streaming: false, waitExhausted: true }
        : {
            text:
              attempt.blocked === true
                ? "RALPH_BLOCKED"
                : attempt.backlogEmpty === true
                  ? "RALPH_DONE"
                  : 'RALPH_MSG: {"summary":"did work","why":"needed"}',
            streaming: false,
            waitExhausted: false,
          },
    ),
  });

  let resumeCount = 0;
  const dispatch: ParallelEpicLoopPorts["dispatch"] = {
    capabilities,
    resumeIteration: (resume) =>
      Effect.sync((): IterationResume => {
        resumeCalls.push(resume);
        ordering.push("dispatch:resumeIteration");
        const refusal = (input.resumeRefusals ?? [])[resumeCount++] ?? null;
        return refusal === null
          ? { _tag: "resumed", handle: makeHandle(resume.ref, attempts[dispatchCount++] ?? {}) }
          : { _tag: "unavailable", refusal };
      }),
    createIteration: (create) =>
      Effect.sync(() => {
        createCalls.push(create);
        ordering.push("dispatch:create");
      }),
    prepareIteration: () =>
      Effect.sync(() => {
        ordering.push("dispatch:prepare");
        if (input.pauseDuringPrepare === true) {
          persistedRun = { ...persistedRun, status: "paused" };
        }
      }),
    beginTurn: (begin) => {
      beginTurnCalls.push(begin);
      ordering.push("dispatch:beginTurn");
      const attempt = attempts[dispatchCount++] ?? {};
      if (attempt.dispatchFails === true) {
        return Effect.fail(
          new EpicRunnerDispatchError({
            commandType: "thread.turn.start",
            detail: "offline",
          }),
        );
      }
      return Effect.succeed(makeHandle(begin.threadId, attempt));
    },
    stopAbandoned: (threadId) =>
      Effect.sync(() => {
        stopAbandonedCalls.push(threadId);
        ordering.push("dispatch:stopAbandoned");
      }),
    interruptForced: (threadId) =>
      Effect.sync(() => {
        interruptForcedCalls.push(threadId);
        ordering.push("dispatch:interruptForced");
      }),
    stopForced: (threadId, options) =>
      Effect.sync(() => {
        stopForcedCalls.push({ threadId, graceSeconds: options.graceSeconds });
        ordering.push("dispatch:stopForced");
      }),
  };

  const mergeDrain: MergeDrainShape = {
    drain: () =>
      Effect.sync(() => {
        drainCalls += 1;
        ordering.push("merge:drain");
        return input.drainDefersForever
          ? ({ _tag: "deferred", holder: input.drainHolder ?? null } as const)
          : ({ _tag: "drained" } as const);
      }),
    enqueueMerge: (merge) =>
      Effect.sync(() => {
        enqueuedMerges.push(merge);
        ordering.push("merge:enqueue");
      }),
    findParkedOriginalChild: (query) =>
      Effect.sync(() => {
        parkedBranchReads.push(query.branch);
        return Option.some("orig.child");
      }),
    recordIntegratedHead: () =>
      Effect.sync(() => {
        ordering.push("merge:recordIntegratedHead");
      }),
    integrationTarget: () =>
      Effect.succeed(
        input.integrationTarget === undefined
          ? { repositoryPath: "/repo", baseBranch: "epic/base" }
          : input.integrationTarget,
      ),
    unlandedEntries: () => Effect.succeed(input.unlandedMergeEntries ?? []),
  };

  const vcs: PoolVcsShape = {
    headCommit: (cwd, ref) =>
      Effect.suspend(() => {
        // Only the radar names a ref; every other reader asks for the head of
        // the tree it is standing in.
        if (ref !== undefined) {
          return Effect.succeed(input.refHeads?.()[ref] ?? `head-of-${ref}`);
        }
        return Effect.succeed(
          siblingHeads.has(cwd)
            ? `sib-head-${String(siblingHeads.get(cwd) ?? 0)}`
            : `head-${String(head)}`,
        );
      }),
    worktreeFingerprint: () => Effect.succeed(""),
    worktreeEvidence: (cwd) =>
      Effect.sync(() => {
        evidenceCwds.push(cwd);
        return input.worktreeEvidence ?? null;
      }),
    commitsAhead: () => Effect.succeed(0),
    mergeTreeConflicts: (probe) =>
      Effect.suspend(() => {
        conflictProbes.push({ base: probe.base, branch: probe.branch });
        if (input.probeDies === true) return Effect.die(new Error("merge-tree blew up"));
        return Effect.succeed(input.conflicts?.() ?? []);
      }),
  };

  const ports: ParallelEpicLoopPorts = {
    journal,
    events: {
      publish: (event) =>
        Effect.sync(() => {
          events.push(event);
          if (event.type === "iteration-state-changed") {
            ordering.push(`event:iteration:${event.iteration.turnStatus}`);
          }
        }),
    },
    backlog,
    workspace,
    dispatch,
    mergeDrain,
    vcs,
    providerInventory:
      input.providers === undefined ? null : { getProviders: Effect.succeed(input.providers) },
    roleSelection:
      input.roleSelections === undefined && input.roleChains === undefined
        ? null
        : {
            chain: (role) =>
              Effect.sync(() => {
                const chain = input.roleChains?.[role] ?? [];
                const isInstanceBlocked = (instanceId: ProviderInstanceId) =>
                  input.roleBlockedInstances?.includes(instanceId) === true ||
                  providerDegradations.some((record) => record.providerInstanceId === instanceId);
                return {
                  chain,
                  isInstanceBlocked,
                  isBlocked: (hop: EpicFallbackHop) => isInstanceBlocked(hop.instanceId),
                };
              }),
            resolve: (request) =>
              Effect.sync(() => {
                roleRequests.push(request);
                const chainHop = input.roleChains?.[request.role]?.find(
                  (hop) =>
                    !providerDegradations.some(
                      (record) => record.providerInstanceId === hop.instanceId,
                    ),
                );
                const chainSelection =
                  chainHop === undefined
                    ? undefined
                    : {
                        instanceId: chainHop.instanceId,
                        model: chainHop.model,
                        ...(chainHop.options === undefined ? {} : { options: chainHop.options }),
                      };
                return {
                  selection:
                    input.roleSelections?.[request.role] ??
                    chainSelection ??
                    request.fallbackSelection,
                  tierId: input.roleTiers?.[request.role] ?? null,
                };
              }),
          },
    workerEvidence: input.workerEvidence ?? null,
    supervisionClock: input.supervisionClock,
  };

  const run = Effect.gen(function* () {
    const signals = yield* Queue.unbounded<PoolSchedulerEvent>();
    yield* runParallelEpicLoop(
      {
        runId: RUN_ID,
        epicId: EPIC_ID,
        cwd: "/repo",
        policy: input.policy ?? policy(),
        withTransition: (effect) => effect,
        signals,
        readOrientation: () => Effect.succeed("ORIENTATION CARD"),
        cleanupOwnedExternally: () => false,
        resumedWorkers,
      },
      ports,
    );
  });

  return {
    run,
    runRecord: () => persistedRun,
    child: () => child,
    iterations,
    events,
    ordering,
    createCalls,
    beginTurnCalls,
    resumeCalls,
    acquireCalls,
    evidenceCwds,
    adoptCalls,
    claimChildCalls,
    stopAbandonedCalls,
    stopForcedCalls,
    interruptForcedCalls,
    releasedClaims,
    enqueuedMerges,
    parkedBranchReads,
    conflictProbes,
    nudges,
    providerDegradations,
    providerClears,
    roleRequests,
    interrupts: () => interrupts,
    releases: () => releases,
    workspaceReleases: () => workspaceReleases,
    drainCalls: () => drainCalls,
    integrationReleased: () => integrationReleased,
    dispatchCount: () => dispatchCount,
  };
};

it.live("dispatches one child through settle classification to a done run", () =>
  Effect.gen(function* () {
    const test = fixture({ attempts: [{ commit: true, close: true, comment: true }] });
    yield* test.run;

    const run = test.runRecord();
    assert.equal(run.status, "done");
    assert.isNull(run.lastError);
    assert.equal(run.iterationsDispatched, 1);
    assert.equal(run.iterationsCompleted, 1);

    // The deterministic thread id is a cross-side contract.
    const threadId = epicRunIterationThreadId({ runId: RUN_ID, iterationIndex: 0 });
    assert.equal(test.createCalls[0]?.threadId, threadId);
    assert.equal(test.iterations[0]?.threadId, threadId);
    assert.equal(test.iterations[0]?.turnStatus, "completed");
    assert.isNull(test.iterations[0]?.failureReason);
    assert.equal(test.iterations[0]?.summary, "did work");

    // The prompt carries the epic context and the orientation card.
    const prompt = test.beginTurnCalls[0]?.prompt ?? "";
    assert.include(prompt, "Cook exactly `epic.1` this iteration.");
    assert.include(prompt, "EPIC GOAL");
    assert.include(prompt, "ORIENTATION CARD");

    // The running row is journaled before the provider turn starts.
    assert.isBelow(
      test.ordering.indexOf("journal:running"),
      test.ordering.indexOf("dispatch:beginTurn"),
    );
    assert.isBelow(
      test.ordering.indexOf("journal:completed"),
      test.ordering.indexOf("event:iteration:completed"),
    );
    assert.equal(test.releases(), 1);
    assert.equal(test.workspaceReleases(), 1);
    assert.equal(test.integrationReleased(), "done");
  }),
);

it.live("splices the workspace sibling rule beside the orientation card", () =>
  Effect.gen(function* () {
    const test = fixture({
      siblingRule: "SIBLING RULE TEXT",
      attempts: [{ commit: true, close: true }],
    });
    yield* test.run;

    const prompt = test.beginTurnCalls[0]?.prompt ?? "";
    assert.include(prompt, "ORIENTATION CARD\n\nSIBLING RULE TEXT");
    assert.equal(test.runRecord().status, "done");
  }),
);

it.live("counts a commit in any sibling worktree as committed", () =>
  Effect.gen(function* () {
    const test = fixture({
      sequential: false,
      siblingWorktrees: [{ worktreePath: "/wt-sib", sourcePath: "/sib", baseBranch: "sib-main" }],
      attempts: [{ close: true, siblingCommit: true }],
    });
    yield* test.run;

    assert.equal(test.runRecord().status, "done");
    assert.equal(test.iterations[0]?.turnStatus, "completed");
    assert.deepEqual(
      test.enqueuedMerges.map((merge) => merge.branch),
      ["epic/epic.1"],
    );
  }),
);

it.live("fails the run as infra:merge-reconciliation when workspace release fails", () =>
  Effect.gen(function* () {
    const test = fixture({
      releaseFails: true,
      attempts: [{ commit: true, close: true }],
    });
    const error = yield* Effect.flip(test.run);

    assert.instanceOf(error, EpicRunnerStoreError);
    const run = test.runRecord();
    assert.equal(run.status, "failed");
    assert.include(run.lastError ?? "", "infra:merge-reconciliation");
    assert.equal(test.workspaceReleases(), 1);
  }),
);

it.effect("stalls the run, naming the holder, when the merge drain cannot take the slot", () =>
  Effect.gen(function* () {
    // Regression: a deferred drain used to retry forever with no log and no
    // bound, while the run lock kept heartbeating. The run reported "running"
    // and landed nothing for 8 hours.
    const test = fixture({
      sequential: false,
      drainDefersForever: true,
      drainHolder: "epic-run:4f11d14b",
    });
    const fiber = yield* test.run.pipe(Effect.forkChild);
    yield* TestClock.adjust(Duration.minutes(11));
    yield* Fiber.join(fiber);

    const run = test.runRecord();
    assert.equal(run.status, "failed");
    assert.include(run.lastError ?? "", "infra:stalled:merge-slot");
    // The holder is the whole point: without it a deferral says nothing an
    // operator can act on.
    assert.include(run.lastError ?? "", "merge slot held by epic-run:4f11d14b");
    assert.equal(test.dispatchCount(), 0);
  }),
);

it.effect("keeps deferring to a live holder inside the stall window", () =>
  Effect.gen(function* () {
    // Deferring is correct while another holder finishes its merge set. Only a
    // deferral that outlasts the window is a stall.
    const test = fixture({
      sequential: false,
      drainDefersForever: true,
      policy: policy({ runStallTimeoutMs: 600_000 }),
    });
    const fiber = yield* test.run.pipe(Effect.forkChild);
    yield* TestClock.adjust(Duration.minutes(5));

    assert.equal(test.runRecord().status, "running");
    assert.isAbove(test.drainCalls(), 1);

    yield* TestClock.adjust(Duration.minutes(6));
    yield* Fiber.join(fiber);
    assert.equal(test.runRecord().status, "failed");
  }),
);

it.effect("stalls a scheduler that keeps reading an empty ready list", () =>
  Effect.gen(function* () {
    // A frontier that reports children and then hands back none dispatches
    // nothing, forever, while the run still reads healthy.
    const test = fixture({
      frontier: () => ({ _tag: "children", issueIds: [] }),
      policy: policy({ runStallTimeoutMs: 600_000 }),
    });
    const fiber = yield* test.run.pipe(Effect.forkChild);
    yield* TestClock.adjust(Duration.minutes(11));
    yield* Fiber.join(fiber);

    const run = test.runRecord();
    assert.equal(run.status, "failed");
    assert.include(run.lastError ?? "", "infra:stalled:scheduler");
    assert.equal(test.dispatchCount(), 0);
  }),
);

it.effect("never stalls a run on a worker that is still running", () =>
  Effect.gen(function* () {
    // One unit of epic work legitimately takes hours. The worker timeout and
    // worker supervision own that verdict; the run-level watchdog must not.
    const test = fixture({
      attempts: [{ neverSettles: true }],
      policy: policy({ runStallTimeoutMs: 60_000 }),
    });
    const fiber = yield* test.run.pipe(Effect.forkChild);
    yield* TestClock.adjust(Duration.minutes(30));

    assert.equal(test.runRecord().status, "running");
    assert.equal(test.dispatchCount(), 1);
    yield* Fiber.interrupt(fiber);
  }),
);

it.live("treats an empty frontier with no open children as done", () =>
  Effect.gen(function* () {
    const test = fixture({ initialChildStatus: "closed" });
    yield* test.run;

    assert.equal(test.runRecord().status, "done");
    assert.isNull(test.runRecord().lastError);
    assert.equal(test.dispatchCount(), 0);
  }),
);

it.live("treats an empty frontier with open children as stuck, never done", () =>
  Effect.gen(function* () {
    const test = fixture({ initialChildStatus: "in_progress" });
    yield* test.run;

    assert.equal(test.runRecord().status, "failed");
    assert.include(test.runRecord().lastError ?? "", "infra:ready-frontier-stuck");
    assert.equal(test.dispatchCount(), 0);
  }),
);

it.live("logs the open-child evidence when an empty frontier cannot finish the run", () =>
  Effect.gen(function* () {
    // t3code-8vn: a backlog-empty decision once landed with no record of what
    // Beads said. The decision point now names the children that block `done`.
    const messages: Array<unknown> = [];
    const logger = Logger.make<unknown, void>(({ message }) => {
      messages.push(message);
    });
    const test = fixture({ initialChildStatus: "in_progress" });
    yield* test.run.pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));

    assert.equal(test.runRecord().status, "failed");
    const decision = messages
      .filter(Array.isArray)
      .find((message) => message[0] === "epic.runner.completion-unproven");
    assert.exists(decision);
    assert.deepEqual(decision?.[1], {
      runId: RUN_ID,
      check: "ready-frontier-empty",
      proof: "incomplete",
      openChildren: 1,
      openChildIds: "epic.1",
      unlandedMergeEntries: 0,
    });
  }),
);

it.live("dispatches the child again when RALPH_DONE leaves it open and ready", () =>
  Effect.gen(function* () {
    // The agent's word is not the proof. The child is still ready, so the run
    // goes back to work instead of reporting a backlog it never emptied.
    const test = fixture({
      attempts: [{ backlogEmpty: true }, { commit: true, close: true, comment: true }],
    });
    yield* test.run;

    assert.equal(test.dispatchCount(), 2);
    assert.equal(test.runRecord().status, "done");
    assert.isNull(test.runRecord().lastError);
  }),
);

it.live("fails a RALPH_DONE that leaves an open child nothing can pick up", () =>
  Effect.gen(function* () {
    let frontierReads = 0;
    const test = fixture({
      attempts: [{ backlogEmpty: true, claim: true }],
      frontier: () =>
        frontierReads++ === 0 ? { _tag: "children", issueIds: ["epic.1"] } : { _tag: "empty" },
    });
    yield* test.run;

    assert.equal(test.dispatchCount(), 1);
    assert.equal(test.runRecord().status, "failed");
    assert.include(test.runRecord().lastError ?? "", "infra:ready-frontier-stuck");
    assert.include(test.runRecord().lastError ?? "", "epic.1");
  }),
);

it.live("fails a run whose merge queue still holds a parked entry after every child closes", () =>
  Effect.gen(function* () {
    // The residual window t3code-xig closes: a merge-fix child can close
    // with accepted no-commit evidence and never re-enqueue the branch it
    // was meant to land, leaving the original entry parked with
    // `fixIssueId` set. Beads shows nothing open; the queue does not.
    const test = fixture({
      attempts: [{ commit: true, close: true, comment: true }],
      unlandedMergeEntries: [{ childId: "epic.1", branch: "epic/epic.1", status: "parked" }],
    });
    yield* test.run;

    assert.equal(test.runRecord().status, "failed");
    const error = test.runRecord().lastError ?? "";
    assert.include(error, "infra:merge-queue-unlanded");
    assert.include(error, "epic.1");
    assert.include(error, "epic/epic.1");
    assert.include(error, "parked");
  }),
);

it.live("fails a RALPH_DONE whose merge queue still holds a queued entry", () =>
  Effect.gen(function* () {
    // The other residual window t3code-xig closes: an integration-fix child
    // can close without committing a resolution, leaving the entry the drain
    // never got to still `queued` behind the operator-base conflict it
    // stopped for.
    const test = fixture({
      attempts: [{ backlogEmpty: true, close: true }],
      unlandedMergeEntries: [{ childId: "epic.2", branch: "epic/epic.2", status: "queued" }],
    });
    yield* test.run;

    assert.equal(test.runRecord().status, "failed");
    const error = test.runRecord().lastError ?? "";
    assert.include(error, "infra:merge-queue-unlanded");
    assert.include(error, "epic.2");
    assert.include(error, "queued");
  }),
);

it.effect("never completes on RALPH_DONE while a sibling worker is still running", () =>
  Effect.gen(function* () {
    let frontierReads = 0;
    const test = fixture({
      sequential: false,
      runSeed: { workers: 2 },
      frontier: () =>
        frontierReads++ === 0
          ? { _tag: "children", issueIds: ["epic.1", "epic.2"] }
          : { _tag: "empty" },
      attempts: [{ backlogEmpty: true }, { neverSettles: true }],
      policy: policy({ runStallTimeoutMs: 60_000 }),
    });
    const fiber = yield* test.run.pipe(Effect.forkChild);
    yield* TestClock.adjust(Duration.minutes(30));

    assert.equal(test.dispatchCount(), 2);
    assert.equal(test.runRecord().status, "running");
    yield* Fiber.interrupt(fiber);
  }),
);

it.live("fails the dispatch cap when it leaves an open child", () =>
  Effect.gen(function* () {
    const test = fixture({
      attempts: [{ commit: true, comment: true }],
      policy: policy({ maxIterations: 1 }),
    });
    yield* test.run;

    assert.equal(test.dispatchCount(), 1);
    assert.equal(test.runRecord().status, "failed");
    assert.include(test.runRecord().lastError ?? "", "limit:max-iterations");
    assert.include(test.runRecord().lastError ?? "", "epic.1");
  }),
);

it.live("completes the dispatch cap when no open child remains", () =>
  Effect.gen(function* () {
    const test = fixture({
      attempts: [{ commit: true, close: true, comment: true }],
      policy: policy({ maxIterations: 1 }),
    });
    yield* test.run;

    assert.equal(test.dispatchCount(), 1);
    assert.equal(test.runRecord().status, "done");
    assert.equal(test.runRecord().lastError, "max iterations (1) reached");
  }),
);

it.live("fails the run on an unrecognised ready frontier without dispatching", () =>
  Effect.gen(function* () {
    const test = fixture({
      frontier: () => ({ _tag: "unrecognised", candidateIds: ["stray.1", "stray.2"] }),
    });
    yield* test.run;

    const run = test.runRecord();
    assert.equal(run.status, "failed");
    assert.include(run.lastError ?? "", "bd ready returned no usable child");
    assert.include(run.lastError ?? "", "stray.1, stray.2");
    assert.equal(test.beginTurnCalls.length, 0);
    assert.equal(test.iterations.length, 1);
    assert.equal(test.iterations[0]?.turnStatus, "failed");
    assert.equal(test.iterations[0]?.failureReason, "infra:ready-unrecognised");
    assert.isNull(test.iterations[0]?.issueId);
  }),
);

it.live("never dispatches the provider turn when a pause lands between the two phases", () =>
  Effect.gen(function* () {
    const test = fixture({
      sequential: false,
      attempts: [{}],
      pauseDuringPrepare: true,
    });
    yield* test.run;

    // The phase-two re-check saw the pause: no turn start, the created thread
    // is stopped, and the allocated row is abandoned.
    assert.equal(test.beginTurnCalls.length, 0);
    assert.deepEqual(test.stopAbandonedCalls, [
      epicRunIterationThreadId({ runId: RUN_ID, iterationIndex: 0 }),
    ]);
    assert.equal(test.iterations[0]?.turnStatus, "abandoned");
    assert.equal(test.iterations[0]?.failureReason, "cancelled");
    // The loop stopped without overwriting the paused status.
    assert.equal(test.runRecord().status, "paused");
    assert.equal(test.workspaceReleases(), 1);
  }),
);

it.live("drains a Prime worker before one forward fallback", () =>
  Effect.gen(function* () {
    const prime = provider("prime", "primeAgent", "prime/custom-model");
    const claude = provider("claude", "claudeAgent", "claude-sonnet-5");
    const test = fixture({
      attempts: [{ providerError: "rate limit" }, { commit: true, close: true }],
      sequential: false,
      providers: [prime, claude],
      selection: { instanceId: prime.instanceId, model: "prime/custom-model" },
      policy: policy({ maxAttemptsPerChild: 1 }),
    });
    yield* test.run;

    assert.equal(test.runRecord().status, "done");
    assert.deepEqual(test.providerDegradations, [
      { providerInstanceId: "prime", failureReason: "provider-error:rate-limit" },
    ]);
    // The degradation record lands before the run row switches providers.
    assert.isBelow(
      test.ordering.indexOf("journal:degrade:prime"),
      test.ordering.indexOf("run:saved:running:claude"),
    );
    assert.isBelow(
      test.ordering.indexOf("handle:release"),
      test.ordering.indexOf("run:saved:running:claude"),
    );
    assert.equal(test.beginTurnCalls.length, 2);
    assert.deepEqual(
      test.beginTurnCalls.map((call) => call.selection),
      [
        { instanceId: prime.instanceId, model: "prime/custom-model" },
        { instanceId: claude.instanceId, model: "claude-sonnet-5" },
      ],
    );
    assert.equal(test.events.filter((event) => event.type === "provider-fallback").length, 1);
    // The recovered turn clears its own provider's degradation.
    assert.deepEqual(test.providerClears, ["claude"]);
    assert.equal(test.runRecord().modelSelection.instanceId, "claude");
    assert.equal(test.iterations[0]?.failureReason, "infra:provider-error:rate-limit");
  }),
);

const MERGE_FIX_SELECTION: ModelSelection = {
  instanceId: ProviderInstanceId.make("fixer"),
  model: "merge-fix-model",
};
const WORKER_SELECTION: ModelSelection = {
  instanceId: ProviderInstanceId.make("cooker"),
  model: "worker-model",
};

it.live("dispatches a merge-fix child on the merge-fix role selection", () =>
  Effect.gen(function* () {
    const test = fixture({
      sequential: false,
      childTitle: "Merge fix: land epic/xyz (conflict)",
      attempts: [{ commit: true, close: true }],
      roleSelections: {
        "merge-fix-child": MERGE_FIX_SELECTION,
        "iteration-worker": WORKER_SELECTION,
      },
    });
    yield* test.run;

    assert.equal(test.runRecord().status, "done");
    assert.deepEqual(
      test.roleRequests.map((request) => [request.role, request.issueId, request.issueTitle]),
      [["merge-fix-child", "epic.1", "Merge fix: land epic/xyz (conflict)"]],
    );
    // Both halves of the two-phase dispatch see the same resolved selection.
    assert.deepEqual(
      test.createCalls.map((call) => call.selection),
      [MERGE_FIX_SELECTION],
    );
    assert.deepEqual(
      test.beginTurnCalls.map((call) => call.selection),
      [MERGE_FIX_SELECTION],
    );
  }),
);

it.live("dispatches an ordinary child on the iteration-worker role selection", () =>
  Effect.gen(function* () {
    const test = fixture({
      sequential: false,
      attempts: [{ commit: true, close: true }],
      roleSelections: {
        "merge-fix-child": MERGE_FIX_SELECTION,
        "iteration-worker": WORKER_SELECTION,
      },
    });
    yield* test.run;

    assert.equal(test.runRecord().status, "done");
    assert.deepEqual(
      test.roleRequests.map((request) => request.role),
      ["iteration-worker"],
    );
    // The run-level selection travels as the fallback the adapter returns
    // when a role has no tier of its own.
    assert.deepEqual(test.roleRequests[0]?.fallbackSelection, {
      instanceId: ProviderInstanceId.make("worker"),
      model: "test",
    });
    assert.deepEqual(
      test.createCalls.map((call) => call.selection),
      [WORKER_SELECTION],
    );
    assert.deepEqual(
      test.beginTurnCalls.map((call) => call.selection),
      [WORKER_SELECTION],
    );
  }),
);

it.live("keeps every dispatch on the run selection when no role resolver is wired", () =>
  Effect.gen(function* () {
    const test = fixture({
      sequential: false,
      childTitle: "Merge fix: land epic/xyz (conflict)",
      attempts: [{ commit: true, close: true }],
    });
    yield* test.run;

    assert.equal(test.runRecord().status, "done");
    assert.deepEqual(test.roleRequests, []);
    const runSelection = { instanceId: ProviderInstanceId.make("worker"), model: "test" };
    assert.deepEqual(
      test.createCalls.map((call) => call.selection),
      [runSelection],
    );
    assert.deepEqual(
      test.beginTurnCalls.map((call) => call.selection),
      [runSelection],
    );
  }),
);

// Attribution has to survive both endings. A tier counted only on the
// iterations it finished would flatter itself, which is the whole point of
// recording it.
it.live("records the dispatching tier on a failed and a completed iteration", () =>
  Effect.gen(function* () {
    const test = fixture({
      sequential: false,
      attempts: [{}, { commit: true, close: true }],
      roleSelections: { "iteration-worker": WORKER_SELECTION },
      roleTiers: { "iteration-worker": EpicTierId.make("cheap") },
    });
    yield* test.run;

    assert.equal(test.runRecord().status, "done");
    assert.deepEqual(
      test.iterations.map((iteration) => [
        iteration.turnStatus,
        iteration.tierId,
        iteration.providerInstanceId,
        iteration.model,
      ]),
      [
        ["failed", "cheap", WORKER_SELECTION.instanceId, WORKER_SELECTION.model],
        ["completed", "cheap", WORKER_SELECTION.instanceId, WORKER_SELECTION.model],
      ],
    );
  }),
);

// Without a resolver there is no tier, but the run's own selection is still
// what dispatched — so the account and model are recorded either way.
it.live("records the run selection with no tier when no role resolver is wired", () =>
  Effect.gen(function* () {
    const test = fixture({ sequential: false, attempts: [{ commit: true, close: true }] });
    yield* test.run;

    assert.equal(test.runRecord().status, "done");
    assert.deepEqual(
      test.iterations.map((iteration) => [
        iteration.tierId,
        iteration.providerInstanceId,
        iteration.model,
      ]),
      [[null, "worker", "test"]],
    );
  }),
);

it.live("degrades the account the role resolved to, not the run's own", () =>
  Effect.gen(function* () {
    const prime = provider("prime", "primeAgent", "prime/custom-model");
    const claude = provider("claude", "claudeAgent", "claude-sonnet-5");
    const codexModel = DEFAULT_MODEL_BY_PROVIDER[ProviderDriverKind.make("codex")] ?? "";
    const codex = provider("codex", "codex", codexModel);
    const test = fixture({
      sequential: false,
      attempts: [{ providerError: "rate limit" }, { commit: true, close: true }],
      providers: [prime, claude, codex],
      selection: { instanceId: prime.instanceId, model: "prime/custom-model" },
      roleSelections: {
        "iteration-worker": { instanceId: claude.instanceId, model: "claude-sonnet-5" },
      },
      policy: policy({ maxAttemptsPerChild: 1 }),
    });
    yield* test.run;

    assert.equal(test.runRecord().status, "done");
    // The failing turn ran on `claude`, so `claude` is what degraded — the
    // run row still named `prime`, which never dispatched anything.
    assert.deepEqual(test.providerDegradations, [
      { providerInstanceId: "claude", failureReason: "provider-error:rate-limit" },
    ]);
    // Forward fallback walks on from the account that actually failed.
    assert.equal(test.runRecord().modelSelection.instanceId, "codex");
    assert.deepEqual(test.providerClears, ["claude"]);
  }),
);

it.live("follows the worker role chain across provider errors before driver fallback", () =>
  Effect.gen(function* () {
    const claudeA = provider("claude-a", "claudeAgent", "claude-sonnet-5");
    const claudeB = provider("claude-b", "claudeAgent", "claude-sonnet-5");
    const codex = provider("codex", "codex", "gpt-5.6-sol");
    const chain = [
      { instanceId: claudeA.instanceId, model: "claude-sonnet-5" },
      { instanceId: claudeB.instanceId, model: "claude-sonnet-5" },
      { instanceId: codex.instanceId, model: "gpt-5.6-sol" },
    ];
    const test = fixture({
      sequential: false,
      attempts: [
        { providerError: "rate limit" },
        { providerError: "rate limit" },
        { commit: true, close: true },
      ],
      providers: [claudeA, claudeB, codex],
      selection: { instanceId: claudeA.instanceId, model: "claude-sonnet-5" },
      roleChains: { "iteration-worker": chain },
    });

    yield* test.run;

    assert.deepEqual(
      test.beginTurnCalls.map((call) => call.selection.instanceId),
      ["claude-a", "claude-b", "codex"],
    );
    assert.deepEqual(
      test.events
        .filter((event) => event.type === "provider-fallback")
        .map((event) => [event.fromInstanceId, event.toInstanceId]),
      [
        ["claude-a", "claude-b"],
        ["claude-b", "codex"],
      ],
    );
  }),
);

it.live("keeps the merge-fix role through settlement and fallback", () =>
  Effect.gen(function* () {
    const fixerA = provider("fixer-a", "claudeAgent", "claude-sonnet-5");
    const fixerB = provider("fixer-b", "claudeAgent", "claude-sonnet-5");
    const test = fixture({
      sequential: false,
      childTitle: "Merge fix: land epic/xyz (conflict)",
      attempts: [{ providerError: "rate limit" }, { commit: true, close: true }],
      providers: [fixerA, fixerB],
      selection: { instanceId: fixerA.instanceId, model: "claude-sonnet-5" },
      roleChains: {
        "merge-fix-child": [
          { instanceId: fixerA.instanceId, model: "claude-sonnet-5" },
          { instanceId: fixerB.instanceId, model: "claude-sonnet-5" },
        ],
      },
    });

    yield* test.run;

    assert.deepEqual(
      test.roleRequests.map((request) => request.role),
      ["merge-fix-child", "merge-fix-child"],
    );
    assert.deepEqual(
      test.events
        .filter((event) => event.type === "provider-fallback")
        .map((event) => event.toInstanceId),
      ["fixer-b"],
    );
  }),
);

it.live("keeps driver-order fallback unchanged when the role chain is empty", () =>
  Effect.gen(function* () {
    const claudeA = provider("claude-a", "claudeAgent", "claude-sonnet-5");
    const claudeB = provider("claude-b", "claudeAgent", "claude-sonnet-5");
    const test = fixture({
      sequential: false,
      attempts: [{ providerError: "rate limit" }, { commit: true, close: true }],
      providers: [claudeA, claudeB],
      selection: { instanceId: claudeA.instanceId, model: "claude-sonnet-5" },
      roleChains: { "iteration-worker": [] },
      roleBlockedInstances: [claudeB.instanceId],
    });

    yield* test.run;

    assert.deepEqual(
      test.beginTurnCalls.map((call) => call.selection.instanceId),
      ["claude-a", "claude-b"],
    );
  }),
);

it.live("leaves an exhausted role chain without returning to a blocked sibling", () =>
  Effect.gen(function* () {
    const claudeA = provider("claude-a", "claudeAgent", "claude-sonnet-5");
    const claudeB = provider("claude-b", "claudeAgent", "claude-sonnet-5");
    const codex = provider("codex", "codex", "gpt-5.6-sol");
    const test = fixture({
      sequential: false,
      attempts: [
        { providerError: "rate limit" },
        { providerError: "rate limit" },
        { commit: true, close: true },
      ],
      providers: [claudeA, claudeB, codex],
      selection: { instanceId: claudeA.instanceId, model: "claude-sonnet-5" },
      roleChains: {
        "iteration-worker": [
          { instanceId: claudeA.instanceId, model: "claude-sonnet-5" },
          { instanceId: claudeB.instanceId, model: "claude-sonnet-5" },
        ],
      },
    });

    yield* test.run;

    assert.deepEqual(
      test.beginTurnCalls.map((call) => call.selection.instanceId),
      ["claude-a", "claude-b", "codex"],
    );
  }),
);

it.live("refuses a role-chain hop that already matches the run row", () =>
  Effect.gen(function* () {
    const claudeA = provider("claude-a", "claudeAgent", "claude-sonnet-5");
    const claudeB = provider("claude-b", "claudeAgent", "claude-sonnet-5");
    const test = fixture({
      sequential: false,
      attempts: [{ providerError: "rate limit" }],
      providers: [claudeA, claudeB],
      selection: { instanceId: claudeB.instanceId, model: "claude-sonnet-5" },
      roleSelections: {
        "iteration-worker": { instanceId: claudeA.instanceId, model: "claude-sonnet-5" },
      },
      roleChains: {
        "iteration-worker": [
          { instanceId: claudeA.instanceId, model: "claude-sonnet-5" },
          { instanceId: claudeB.instanceId, model: "claude-sonnet-5" },
        ],
      },
      policy: policy({ maxIterations: 1 }),
    });

    yield* test.run;

    assert.equal(test.runRecord().modelSelection.instanceId, "claude-b");
    assert.equal(test.events.filter((event) => event.type === "provider-fallback").length, 0);
    assert.deepEqual(test.providerDegradations, []);
  }),
);

it.live("enqueues the parked original child when a merge-fix child lands", () =>
  Effect.gen(function* () {
    const test = fixture({
      sequential: false,
      childTitle: "Merge fix: land epic/xyz (conflict)",
      attempts: [{ commit: true, close: true }],
    });
    yield* test.run;

    assert.equal(test.runRecord().status, "done");
    assert.deepEqual(test.parkedBranchReads, ["epic/xyz"]);
    assert.deepEqual(
      test.enqueuedMerges.map((merge) => [merge.childId, merge.branch]),
      [["orig.child", "epic/xyz"]],
    );
    // The drain runs before the next dispatch decision.
    assert.isBelow(test.ordering.indexOf("merge:enqueue"), test.ordering.indexOf("merge:drain"));
    assert.equal(test.drainCalls(), 1);
  }),
);

it.live(
  "resyncs the accepted head instead of enqueuing when an integration-fix child lands (t3code-sha)",
  () =>
    Effect.gen(function* () {
      const test = fixture({
        sequential: false,
        childTitle: "Merge fix: integrate team/mine into epic/epic-1/base",
        attempts: [{ commit: true, close: true }],
      });
      yield* test.run;

      assert.equal(test.runRecord().status, "done");
      // Committing directly on the run base branch already landed the
      // resolution: nothing goes through the entry queue, and no parked
      // entry is looked up either.
      assert.deepEqual(test.enqueuedMerges, []);
      assert.deepEqual(test.parkedBranchReads, []);
      assert.isTrue(test.ordering.includes("merge:recordIntegratedHead"));
      assert.isBelow(
        test.ordering.indexOf("merge:recordIntegratedHead"),
        test.ordering.indexOf("merge:drain"),
      );
    }),
);

it.live(
  "resyncs the accepted head even when an integration-fix child commits then errors out (t3code-sha)",
  () =>
    Effect.gen(function* () {
      // The fix child commits the resolved merge onto the run base branch and
      // then hits a provider error — the turn never ends `done`. Gating the
      // resync on `outcome.kind === "done"` left `lastAcceptedHead` stale in
      // exactly this case, so the next drain read the moved base as an
      // external move and failed the run for the coordinator's own commit.
      const test = fixture({
        sequential: false,
        childTitle: "Merge fix: integrate team/mine into epic/epic-1/base",
        attempts: [{ commit: true, providerError: "boom" }],
        policy: policy({ infraFailureBudget: 1 }),
      });
      yield* test.run;

      assert.equal(test.runRecord().status, "failed");
      assert.equal(test.iterations[0]?.turnStatus, "failed");
      assert.deepEqual(test.enqueuedMerges, []);
      assert.deepEqual(test.parkedBranchReads, []);
      assert.isTrue(test.ordering.includes("merge:recordIntegratedHead"));
    }),
);

it.live(
  "does not drain while an integration-fix child still holds the run base branch (t3code-sha)",
  () =>
    Effect.gen(function* () {
      // A dedicated two-worker harness: reusing `fixture()` cannot express
      // two children settling at different times, which is exactly the race
      // this guards. `fixChildBaseOwned` mirrors what the real base branch's
      // checkout state would be — set the moment the fix child's workspace is
      // acquired, cleared only once its workspace is released, spanning
      // everything from "might have committed" through "store not yet
      // resynced" — and the fake drain treats a call while it is `true` the
      // way the real merge queue would: `fatal`.
      const fixChildId = "fix.1";
      const fixChildTitle = "Merge fix: integrate team/mine into epic/epic-1/base";
      const fixBranch = "epic/epic-1/base";
      const normalChildId = "normal.1";
      const normalChildTitle = "Normal child";

      let fixChildStatus: "open" | "closed" = "open";
      let normalChildStatus: "open" | "closed" = "open";
      let fixChildBaseOwned = false;
      let sawDrainWhileOwned = false;
      let drainCalls = 0;
      let recordIntegratedHeadCalls = 0;
      const headByCwd = new Map<string, number>();
      const bumpHead = (cwd: string): void => {
        headByCwd.set(cwd, (headByCwd.get(cwd) ?? 0) + 1);
      };

      const fixGate = yield* Deferred.make<void>();
      const normalSettled = yield* Deferred.make<void>();

      let persistedRun: PersistedEpicRun = {
        runId: RUN_ID,
        epicId: EPIC_ID,
        projectId: ProjectId.make("project"),
        cwd: "/repo",
        prompt: "BASE PROMPT",
        orientationFile: null,
        modelSelection: { instanceId: ProviderInstanceId.make("worker"), model: "test" },
        runtimeMode: "full-access",
        config: config(),
        configProvenance: DEFAULT_EPIC_RUN_CONFIG_PROVENANCE,
        originThreadId: null,
        status: "running",
        maxIterations: 10,
        workers: 2,
        iterationsDispatched: 0,
        iterationsCompleted: 0,
        currentThreadId: null,
        currentTurnStartedAt: null,
        consecutiveFailures: 0,
        noCommitStreak: 0,
        infraStreak: 0,
        lastError: null,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      };
      const iterations: PersistedEpicRunIteration[] = [];
      let nextIterationIndex = 0;

      const journal: PoolRunJournalShape = {
        createRun: (run) => Effect.sync(() => void (persistedRun = run)),
        saveRun: (run) => Effect.sync(() => void (persistedRun = run)),
        getRun: () => Effect.succeed(Option.some(persistedRun)),
        appendIteration: (iteration) => Effect.sync(() => void iterations.push(iteration)),
        updateIteration: (update) =>
          Effect.sync(() => {
            const index = iterations.findIndex(
              (item) => item.iterationIndex === update.iterationIndex,
            );
            if (index >= 0) iterations[index] = { ...iterations[index]!, ...update };
          }),
        markIterationResumed: () => Effect.void,
        listIterations: () => Effect.succeed(iterations),
        getLatestIteration: () => Effect.succeed(Option.none()),
        allocateIteration: (allocation) =>
          Effect.sync(() => {
            const iterationIndex = nextIterationIndex++;
            iterations.push({
              runId: allocation.runId,
              iterationIndex,
              threadId: ThreadId.make(
                epicRunIterationThreadId({ runId: allocation.runId, iterationIndex }),
              ),
              issueId: allocation.issueId,
              turnStatus: "running",
              summary: null,
              why: null,
              failureReason: null,
              startedAt: allocation.startedAt,
              finishedAt: null,
            });
            return iterationIndex;
          }),
        upsertProviderDegradation: () => Effect.void,
        clearProviderDegradation: () => Effect.void,
      };

      const backlog: PoolBacklogShape = {
        readyFrontier: () =>
          Effect.succeed(
            (() => {
              const issueIds = [
                ...(fixChildStatus === "open" ? [fixChildId] : []),
                ...(normalChildStatus === "open" ? [normalChildId] : []),
              ];
              return issueIds.length === 0
                ? ({ _tag: "empty" } as const)
                : ({ _tag: "children", issueIds } as const);
            })(),
          ),
        openChildIds: () =>
          Effect.succeed([
            ...(fixChildStatus === "open" ? [fixChildId] : []),
            ...(normalChildStatus === "open" ? [normalChildId] : []),
          ]),
        issueEvidence: (_cwd, issueId) =>
          Effect.succeed(
            issueId === fixChildId
              ? { status: fixChildStatus, title: fixChildTitle, commentCount: 0 }
              : { status: normalChildStatus, title: normalChildTitle, commentCount: 0 },
          ),
        issueIsResearch: () => Effect.succeed(false),
        epicDescription: () => Effect.succeed("EPIC GOAL"),
        releaseClaimedChild: () => Effect.succeed(false),
        claimChild: () => Effect.succeed("claimed"),
      };

      const workspace: WorkspaceShape = {
        ensureIntegration: () => Effect.succeed({ entries: [] }),
        adopt: () => Effect.die(new Error("adopt is not exercised by this test")),
        acquire: (_run, acquireInput) =>
          Effect.sync((): IterationWorkspace => {
            const isFix = acquireInput.issueId === fixChildId;
            if (isFix) fixChildBaseOwned = true;
            return {
              cwd: isFix ? "/repo" : `/wt/${acquireInput.issueId}`,
              branch: isFix ? fixBranch : `epic/${acquireInput.issueId}`,
              worktreePath: `/wt/${acquireInput.issueId}`,
              siblingWorktrees: [],
              siblingRule: null,
            };
          }),
        release: (_run, ws) =>
          Effect.sync(() => {
            if (ws.branch === fixBranch) fixChildBaseOwned = false;
          }),
        releaseIntegration: () => Effect.void,
      };

      const dispatch: ParallelEpicLoopPorts["dispatch"] = {
        capabilities: serverLikeCapabilities,
        resumeIteration: () =>
          Effect.die(new Error("resumeIteration is not exercised by this test")),
        createIteration: () => Effect.void,
        prepareIteration: () => Effect.void,
        beginTurn: (begin) =>
          Effect.sync((): IterationHandle => {
            const isFix = begin.workspace.worktreePath === `/wt/${fixChildId}`;
            return {
              ref: begin.threadId,
              capabilities: serverLikeCapabilities,
              awaitSettled: isFix
                ? Deferred.await(fixGate).pipe(
                    Effect.map(() => {
                      fixChildStatus = "closed";
                      bumpHead(begin.workspace.cwd);
                      return {
                        turnState: "completed" as const,
                        timedOut: false,
                        providerError: null,
                      };
                    }),
                  )
                : Effect.sync(() => {
                    normalChildStatus = "closed";
                    bumpHead(begin.workspace.cwd);
                    return {
                      turnState: "completed" as const,
                      timedOut: false,
                      providerError: null,
                    };
                  }).pipe(Effect.tap(() => Deferred.succeed(normalSettled, undefined))),
              continueTurn: () => Effect.void,
              nudge: () => Effect.succeed("skipped" as const),
              interrupt: Effect.void,
              release: Effect.void,
              runningSubagents: Effect.succeed({ mode: "native", running: 0 }),
              finalMessage: Effect.succeed({
                text: 'RALPH_MSG: {"summary":"did work","why":"needed"}',
                streaming: false,
                waitExhausted: false,
              }),
            };
          }),
        stopAbandoned: () => Effect.void,
        interruptForced: () => Effect.void,
        stopForced: () => Effect.void,
      };

      const mergeDrain: MergeDrainShape = {
        drain: () =>
          Effect.sync(() => {
            drainCalls += 1;
            if (fixChildBaseOwned) {
              sawDrainWhileOwned = true;
              return {
                _tag: "fatal",
                detail: "base branch moved externally; cannot trial-merge",
              } as const;
            }
            return { _tag: "drained" } as const;
          }),
        enqueueMerge: () => Effect.void,
        findParkedOriginalChild: () => Effect.succeed(Option.some("orig.child")),
        recordIntegratedHead: () => Effect.sync(() => void (recordIntegratedHeadCalls += 1)),
        integrationTarget: () => Effect.succeed(null),
        unlandedEntries: () => Effect.succeed([]),
      };

      const vcs: PoolVcsShape = {
        headCommit: (cwd) => Effect.succeed(`head-${String(headByCwd.get(cwd) ?? 0)}`),
        worktreeFingerprint: () => Effect.succeed(""),
        worktreeEvidence: () => Effect.succeed(null),
        commitsAhead: () => Effect.succeed(0),
        mergeTreeConflicts: () => Effect.succeed([]),
      };

      const ports: ParallelEpicLoopPorts = {
        journal,
        events: { publish: () => Effect.void },
        backlog,
        workspace,
        dispatch,
        mergeDrain,
        vcs,
        providerInventory: null,
        roleSelection: null,
        workerEvidence: null,
      };

      const signals = yield* Queue.unbounded<PoolSchedulerEvent>();
      const fiber = yield* Effect.forkChild(
        runParallelEpicLoop(
          {
            runId: RUN_ID,
            epicId: EPIC_ID,
            cwd: "/repo",
            policy: policy(),
            withTransition: (effect) => effect,
            signals,
            readOrientation: () => Effect.succeed(null),
            cleanupOwnedExternally: () => false,
          },
          ports,
        ),
      );

      // Let the normal child settle while the fix child still holds the base
      // branch, then give the loop time to react — this is exactly the
      // window the unguarded loop drained in.
      yield* Deferred.await(normalSettled);
      yield* Effect.sleep(Duration.millis(50));
      assert.isFalse(sawDrainWhileOwned);
      assert.isTrue(fixChildBaseOwned);

      yield* Deferred.succeed(fixGate, undefined);
      yield* Fiber.join(fiber);

      assert.equal(persistedRun.status, "done");
      assert.isFalse(sawDrainWhileOwned);
      assert.isAbove(drainCalls, 0);
      assert.isAbove(recordIntegratedHeadCalls, 0);
    }),
);

it.live("interrupts a timed-out turn and classifies it as an infra timeout", () =>
  Effect.gen(function* () {
    const test = fixture({
      attempts: [{ neverSettles: true }],
      policy: policy({ iterationTimeoutMs: 20, infraFailureBudget: 1 }),
      runConfig: config({
        supervision: { ...DEFAULT_EPIC_RUN_CONFIG.supervision, stopGraceSeconds: 9 },
      }),
    });
    yield* test.run;

    const run = test.runRecord();
    assert.equal(run.status, "failed");
    assert.include(run.lastError ?? "", "1 consecutive infrastructure failures");
    assert.equal(test.interrupts(), 1);
    // The stop carries the run's grace, because it follows an interrupt the
    // turn has not answered yet.
    assert.deepEqual(test.stopForcedCalls, [
      {
        threadId: epicRunIterationThreadId({ runId: RUN_ID, iterationIndex: 0 }),
        graceSeconds: 9,
      },
    ]);
    // The interrupt precedes the forced stop.
    assert.isBelow(
      test.ordering.indexOf("handle:interrupt"),
      test.ordering.indexOf("dispatch:stopForced"),
    );
    assert.equal(test.iterations[0]?.turnStatus, "failed");
    assert.equal(test.iterations[0]?.failureReason, "infra:timeout");
  }),
);

/**
 * A worker that is alive, inside its iteration timeout, and doing nothing.
 *
 * This is the 2026-08-09 shape: `awaitSettled` never returns, `HEAD` never
 * moves, and no wall-clock cap is armed. Before supervision was wired the
 * iteration held its pool slot until the run died — 3h16m in the incident.
 */
const wedgedWorkerEvidence = (): WorkerEvidenceShape => {
  const condemned = JSON.stringify({
    decision: "stop",
    confidence: "high",
    rationale: "every process is asleep and the repository has not changed",
  });
  return {
    inspectorSupported: true,
    sampleSignals: () => Effect.succeed({ isActive: true, outputBytes: 0, cpuUsec: 0, ioBytes: 0 }),
    probeRepository: () => Effect.succeed("deadbeef hash=stable"),
    processFingerprint: () => Effect.succeed("fingerprint-a"),
    providerFallbackPending: Effect.succeed(false),
    launchInspector: () => Effect.void,
    inspectorStatus: () =>
      Effect.succeed({
        _tag: "finished",
        rc: 0,
        result: { text: condemned, byteSize: condemned.length, overflowed: false },
      }),
    stopInspector: () => Effect.void,
  };
};

const instantSupervisionClock = (): SupervisionClock => {
  let now = 0;
  return {
    nowSeconds: Effect.sync(() => now),
    sleepSeconds: (seconds) =>
      Effect.sync(() => {
        now += seconds;
      }),
  };
};

it.live("stops a wedged worker that would otherwise never settle", () =>
  Effect.gen(function* () {
    const test = fixture({
      attempts: [{ neverSettles: true }],
      // No wall-clock cap: only liveness supervision can end this iteration.
      policy: policy({ iterationTimeoutMs: null, infraFailureBudget: 1 }),
      runConfig: config({
        supervision: {
          ...DEFAULT_EPIC_RUN_CONFIG.supervision,
          idleThresholdSeconds: 30,
          inspectMinDelaySeconds: 5,
          inspectRetryDelaySeconds: 10,
          stopGraceSeconds: 4,
        },
      }),
      workerEvidence: wedgedWorkerEvidence(),
      supervisionClock: instantSupervisionClock(),
    });
    yield* test.run;

    assert.equal(test.iterations[0]?.turnStatus, "failed");
    assert.equal(test.iterations[0]?.failureReason, "infra:worker-liveness-stop");
    assert.include(test.iterations[0]?.summary ?? "", "worker liveness supervision stopped");
    // Interrupt first, then the forced stop, exactly as the timeout path does
    // — grace included.
    assert.equal(test.interrupts(), 1);
    assert.deepEqual(test.stopForcedCalls, [
      {
        threadId: epicRunIterationThreadId({ runId: RUN_ID, iterationIndex: 0 }),
        graceSeconds: 4,
      },
    ]);
    assert.isBelow(
      test.ordering.indexOf("handle:interrupt"),
      test.ordering.indexOf("dispatch:stopForced"),
    );
    // Every stage the machine passed through is on the run's event stream.
    const stages = test.events
      .filter((event) => event.type === "worker-liveness")
      .map((event) => event.stage);
    assert.deepEqual(stages, [
      "worker-idle",
      "inspection-started",
      "inspection-stop-pending",
      "worker-idle",
      "inspection-started",
      "inspection-stop",
    ]);
  }),
);

it.live("leaves a healthy worker alone when supervision is wired", () =>
  Effect.gen(function* () {
    const test = fixture({
      attempts: [{ commit: true, close: true, comment: true }],
      workerEvidence: wedgedWorkerEvidence(),
      supervisionClock: instantSupervisionClock(),
    });
    yield* test.run;

    assert.equal(test.iterations[0]?.turnStatus, "completed");
    assert.deepEqual(
      test.events.filter((event) => event.type === "worker-liveness"),
      [],
    );
  }),
);

it.live("counts a clean no-commit turn against the no-commit streak", () =>
  Effect.gen(function* () {
    const test = fixture({
      attempts: [{}],
      policy: policy({ maxNoCommitStreak: 2 }),
    });
    yield* test.run;

    const run = test.runRecord();
    assert.equal(run.status, "failed");
    assert.equal(run.lastError, "gutter: 2 iterations without a commit");
    assert.equal(run.noCommitStreak, 2);
    assert.equal(test.dispatchCount(), 2);
    assert.equal(test.iterations[0]?.failureReason, "child:no-commit-child-open");
    assert.equal(test.iterations[1]?.failureReason, "child:no-commit-child-open");
    // Each failed iteration reopens its stranded claim.
    assert.deepEqual(test.releasedClaims, ["epic.1", "epic.1", "epic.1"]);
  }),
);

it.live("classifies a failed dispatch and force-stops its session", () =>
  Effect.gen(function* () {
    const test = fixture({
      attempts: [{ dispatchFails: true }],
      policy: policy({ infraFailureBudget: 1 }),
    });
    yield* test.run;

    const run = test.runRecord();
    assert.equal(run.status, "failed");
    assert.equal(test.iterations[0]?.failureReason, "infra:dispatch-failed");
    // No interrupt preceded this stop — there is no turn to let close — so it
    // waits for nothing.
    assert.deepEqual(test.stopForcedCalls, [
      {
        threadId: epicRunIterationThreadId({ runId: RUN_ID, iterationIndex: 0 }),
        graceSeconds: 0,
      },
    ]);
    assert.equal(test.releases(), 0);
  }),
);

it.live("exhausts a claimed child's attempt budget and announces the released claim", () =>
  Effect.gen(function* () {
    const test = fixture({
      attempts: [
        { blocked: true, claim: true },
        { blocked: true, claim: true },
        { blocked: true, claim: true },
      ],
      // The per-child budget (3) bites before the consecutive-failure budget.
      policy: policy({ maxConsecutiveFailures: 5, maxAttemptsPerChild: 3 }),
    });
    yield* test.run;

    const run = test.runRecord();
    assert.equal(run.status, "failed");
    assert.equal(run.lastError, "agent reported RALPH_BLOCKED");
    assert.equal(test.dispatchCount(), 3);
    assert.deepEqual(
      test.iterations.map((iteration) => iteration.failureReason),
      ["child:blocked", "child:blocked", "child:blocked"],
    );
    const recoveries = test.events.filter((event) => event.type === "child-claim-released");
    assert.equal(recoveries.length, 1);
    assert.deepEqual(recoveries[0], {
      type: "child-claim-released",
      runId: RUN_ID,
      issueId: "epic.1",
      iterationIndex: 2,
      reason: "retry budget exhausted; child reopened",
    });
  }),
);

it.live("charges no per-child attempt when the claim was never standing", () =>
  Effect.gen(function* () {
    const test = fixture({
      attempts: [{ blocked: true }, { blocked: true }, { blocked: true }],
      policy: policy({ maxConsecutiveFailures: 5, maxAttemptsPerChild: 3 }),
    });
    yield* test.run;

    // The budget still fails the run, but nothing was claimed, so no recovery
    // event is published.
    assert.equal(test.runRecord().status, "failed");
    assert.equal(test.dispatchCount(), 3);
    assert.equal(test.events.filter((event) => event.type === "child-claim-released").length, 0);
  }),
);

it.live("charges a restarted run for the child attempts an earlier process spent", () =>
  Effect.gen(function* () {
    const test = fixture({
      priorIterations: [
        { issueId: "epic.1", turnStatus: "failed", failureReason: "child:blocked" },
        { issueId: "epic.1", turnStatus: "failed", failureReason: "child:no-commit-child-open" },
      ],
      attempts: [{ blocked: true, claim: true }],
      policy: policy({ maxConsecutiveFailures: 5, maxAttemptsPerChild: 3 }),
    });
    yield* test.run;

    // Two spent attempts plus this one exhaust the budget, so the run fails on
    // its first dispatch instead of granting a fresh three.
    const run = test.runRecord();
    assert.equal(run.status, "failed");
    assert.equal(run.lastError, "agent reported RALPH_BLOCKED");
    assert.equal(test.dispatchCount(), 1);
    assert.equal(test.iterations[2]?.failureReason, "child:blocked");
    const recoveries = test.events.filter((event) => event.type === "child-claim-released");
    assert.equal(recoveries.length, 1);
    assert.equal(recoveries[0]?.iterationIndex, 2);
  }),
);

it.live("charges nothing for restart-abandoned, infrastructure, or other children's rows", () =>
  Effect.gen(function* () {
    const test = fixture({
      priorIterations: [
        // Abandoned by a restart or a cancellation: the turn never delivered a
        // verdict on the child.
        { issueId: "epic.1", turnStatus: "abandoned", failureReason: "infra:resume-unsupported" },
        { issueId: "epic.1", turnStatus: "failed", failureReason: "infra:dispatch-failed" },
        { issueId: "epic.1", turnStatus: "failed", failureReason: "infra:timeout" },
        // A no-commit turn that closed its child anyway settles `completed`.
        { issueId: "epic.1", turnStatus: "completed", failureReason: null },
        // Another child's spent attempt, and a row that named no child at all.
        { issueId: "epic.2", turnStatus: "failed", failureReason: "child:blocked" },
        { issueId: null, turnStatus: "failed", failureReason: "child:blocked" },
      ],
      attempts: [
        { blocked: true, claim: true },
        { blocked: true, claim: true },
        { blocked: true, claim: true },
      ],
      policy: policy({ maxConsecutiveFailures: 5, maxAttemptsPerChild: 3 }),
    });
    yield* test.run;

    assert.equal(test.runRecord().status, "failed");
    assert.equal(test.dispatchCount(), 3);
  }),
);

/**
 * Restart recovery: an iteration a previous process left `running` is either
 * continued on its own thread, or abandoned through ONE fallback that hands
 * the child back to the ordinary dispatch tick.
 */

const resumedWorker = (override: Partial<ResumedWorker> = {}): ResumedWorker => ({
  issueId: "epic.1",
  iterationIndex: 3,
  threadId: ThreadId.make(epicRunIterationThreadId({ runId: RUN_ID, iterationIndex: 3 })),
  branch: "epic/epic.1",
  worktreePath: "/wt/epic.1",
  selection: { instanceId: ProviderInstanceId.make("worker"), model: "test" },
  startedAt: "2026-01-01T00:00:00Z",
  resumeCount: 0,
  ...override,
});

const resumeDecisions = (events: ReadonlyArray<RunEvent>) =>
  events.filter((event) => event.type === "iteration-resume-decision");

it.live("continues an interrupted iteration on its own row, thread and worktree", () =>
  Effect.gen(function* () {
    const worker = resumedWorker({
      selection: { instanceId: ProviderInstanceId.make("rotated-worker"), model: "rotated-test" },
    });
    const test = fixture({
      sequential: false,
      resumedWorkers: [worker],
      attempts: [{ commit: true, close: true, comment: true }],
    });
    yield* test.run;

    // The already-provisioned worktree is adopted, never re-acquired.
    assert.deepEqual(test.adoptCalls, [
      {
        issueId: "epic.1",
        branch: "epic/epic.1",
        worktreePath: "/wt/epic.1",
        sequential: false,
      },
    ]);
    assert.deepEqual(test.acquireCalls, []);

    // One resume, on the row and thread the dead process left behind, and no
    // new thread for it.
    assert.equal(test.resumeCalls.length, 1);
    assert.equal(test.resumeCalls[0]?.ref, worker.threadId);
    assert.equal(test.resumeCalls[0]?.iterationIndex, 3);
    assert.equal(test.resumeCalls[0]?.issueId, "epic.1");
    assert.deepEqual(test.resumeCalls[0]?.selection, worker.selection);
    assert.deepEqual(test.createCalls, []);
    assert.deepEqual(test.beginTurnCalls, []);
    assert.notInclude(test.resumeCalls[0]?.prompt ?? "", "Cook exactly `epic.1` this iteration.");

    // The row is reused, not appended to.
    assert.equal(test.iterations.length, 1);
    assert.equal(test.iterations[0]?.iterationIndex, 3);
    assert.equal(test.iterations[0]?.threadId, worker.threadId);
    assert.equal(test.iterations[0]?.turnStatus, "completed");
    assert.equal(test.iterations[0]?.startedAt, "2026-01-01T00:00:00Z");
    assert.isAbove(test.ordering.indexOf("dispatch:resumeIteration"), -1);
    assert.isBelow(
      test.ordering.indexOf("journal:resumed"),
      test.ordering.indexOf("dispatch:resumeIteration"),
    );

    // The run pays for the iteration once, at its first dispatch.
    const run = test.runRecord();
    assert.equal(run.iterationsDispatched, 0);
    assert.equal(run.iterationsCompleted, 1);
    assert.equal(run.status, "done");

    const decisions = resumeDecisions(test.events);
    assert.equal(decisions.length, 1);
    assert.deepInclude(decisions[0], { decision: "resumed", iterationIndex: 3, origin: null });
  }),
);

it.live("tells a resumed worker its turn was cut off, with its own worktree evidence", () =>
  Effect.gen(function* () {
    const test = fixture({
      sequential: false,
      resumedWorkers: [resumedWorker()],
      worktreeEvidence: "$ git status --porcelain=v1\n M src/half-done.ts",
      attempts: [{ commit: true, close: true, comment: true }],
    });
    yield* test.run;

    // Evidence is read from the adopted worktree, not the run checkout.
    assert.deepEqual(test.evidenceCwds, ["/wt/epic.1"]);

    const prompt = test.resumeCalls[0]?.prompt ?? "";
    assert.include(prompt, "The t3code server restarted while you were working.");
    assert.include(prompt, "`epic.1`");
    assert.include(prompt, "`epic/epic.1`");
    assert.include(prompt, "`/wt/epic.1`");
    assert.include(prompt, " M src/half-done.ts");
    assert.include(prompt, "RALPH_MSG");
    // The thread already holds both; repeating them would bury the one new fact.
    assert.notInclude(prompt, "EPIC GOAL");
    assert.notInclude(prompt, "ORIENTATION CARD");
  }),
);

it.live("does not imply a clean tree when the evidence probes fail", () =>
  Effect.gen(function* () {
    const test = fixture({
      sequential: false,
      resumedWorkers: [resumedWorker()],
      worktreeEvidence: null,
      attempts: [{ commit: true, close: true, comment: true }],
    });
    yield* test.run;

    assert.include(test.resumeCalls[0]?.prompt ?? "", "Do not read that as a clean tree.");
  }),
);

it.live("never gathers worktree evidence for a fresh iteration", () =>
  Effect.gen(function* () {
    const test = fixture({ attempts: [{ commit: true, close: true, comment: true }] });
    yield* test.run;

    assert.deepEqual(test.evidenceCwds, []);
  }),
);

it.live("never asks a harness that declares resume unsupported", () =>
  Effect.gen(function* () {
    const worker = resumedWorker();
    const test = fixture({
      sequential: false,
      resumedWorkers: [worker],
      resumeCapability: "unsupported",
      claimChildResult: "already-claimed",
      attempts: [{ commit: true, close: true, comment: true }],
      runConfig: config({
        supervision: { ...DEFAULT_EPIC_RUN_CONFIG.supervision, stopGraceSeconds: 6 },
      }),
    });
    yield* test.run;

    assert.deepEqual(test.resumeCalls, []);
    // The claim is re-taken before the capability is even read: every refusal
    // but a closed child hands this child straight on to a new iteration.
    assert.deepEqual(test.claimChildCalls, ["epic.1"]);

    // The interrupted row is abandoned, and its dead thread is interrupted
    // before its session is stopped.
    assert.equal(test.iterations[0]?.iterationIndex, 3);
    assert.equal(test.iterations[0]?.turnStatus, "abandoned");
    assert.equal(test.iterations[0]?.failureReason, "infra:resume-unsupported");
    assert.deepEqual(test.interruptForcedCalls, [worker.threadId]);
    assert.deepEqual(test.stopForcedCalls, [{ threadId: worker.threadId, graceSeconds: 6 }]);

    // The child and its worktree are handed over, never given back: the only
    // release is the terminal sweep, long after the handover dispatched.
    assert.deepEqual(test.acquireCalls, []);
    assert.isBelow(
      test.ordering.indexOf("dispatch:beginTurn"),
      test.ordering.indexOf("backlog:release"),
    );

    const decisions = resumeDecisions(test.events);
    assert.equal(decisions.length, 1);
    assert.deepInclude(decisions[0], { decision: "capability", origin: null, iterationIndex: 3 });

    // One new iteration, on a new thread, in that same worktree.
    assert.equal(test.beginTurnCalls.length, 1);
    assert.equal(test.beginTurnCalls[0]?.workspace.worktreePath, "/wt/epic.1");
    assert.equal(test.beginTurnCalls[0]?.workspace.branch, "epic/epic.1");
    assert.equal(test.iterations[1]?.iterationIndex, 4);
    assert.equal(test.iterations[1]?.turnStatus, "completed");
    assert.equal(test.runRecord().status, "done");
  }),
);

it.live("takes the same fallback when the harness refuses to continue the session", () =>
  Effect.gen(function* () {
    const test = fixture({
      sequential: false,
      resumedWorkers: [resumedWorker()],
      claimChildResult: "already-claimed",
      resumeRefusals: [
        {
          _tag: "not-continued",
          origin: "started-fresh",
          detail: "the session started blank",
        },
      ],
      attempts: [{ commit: true, close: true, comment: true }],
    });
    yield* test.run;

    assert.equal(test.resumeCalls.length, 1);
    assert.equal(test.iterations[0]?.turnStatus, "abandoned");
    assert.equal(test.iterations[0]?.failureReason, "infra:resume-blocked");
    assert.isBelow(
      test.ordering.indexOf("dispatch:beginTurn"),
      test.ordering.indexOf("backlog:release"),
    );

    const decisions = resumeDecisions(test.events);
    assert.equal(decisions.length, 1);
    assert.deepInclude(decisions[0], { decision: "not-continued", origin: "started-fresh" });

    // Identical recovery to the unsupported case: one pinned handover.
    assert.deepEqual(test.acquireCalls, []);
    assert.equal(test.iterations[1]?.iterationIndex, 4);
    assert.equal(test.iterations[1]?.turnStatus, "completed");
    assert.equal(test.runRecord().status, "done");
  }),
);

it.live("hands the worktree on when the adapter errors on a resume it accepted", () =>
  Effect.gen(function* () {
    const test = fixture({
      sequential: false,
      resumedWorkers: [resumedWorker()],
      claimChildResult: "already-claimed",
      resumeRefusals: [{ _tag: "failed", detail: "the adapter lost the session mid-load" }],
      attempts: [{ commit: true, close: true, comment: true }],
    });
    yield* test.run;

    // The old thread was asked exactly once and never prompted again.
    assert.equal(test.resumeCalls.length, 1);
    assert.equal(test.iterations[0]?.failureReason, "infra:resume-failed");
    assert.deepInclude(resumeDecisions(test.events)[0], { decision: "failed" });
    assert.deepEqual(test.acquireCalls, []);
    assert.equal(test.beginTurnCalls.length, 1);
    assert.equal(test.runRecord().status, "done");
  }),
);

it.live("tells the taking-over agent whose changes it inherited", () =>
  Effect.gen(function* () {
    const test = fixture({
      sequential: false,
      resumedWorkers: [resumedWorker()],
      claimChildResult: "already-claimed",
      resumeCapability: "unsupported",
      worktreeEvidence: "$ git status --porcelain=v1\n M src/half-done.ts",
      attempts: [{ commit: true, close: true, comment: true }],
    });
    yield* test.run;

    // Evidence is read from the inherited worktree, not the run checkout.
    assert.deepEqual(test.evidenceCwds, ["/wt/epic.1"]);

    const prompt = test.beginTurnCalls[0]?.prompt ?? "";
    assert.include(prompt, "its session could not be continued");
    assert.include(prompt, "`epic.1`");
    assert.include(prompt, "`epic/epic.1`");
    assert.include(prompt, "`/wt/epic.1`");
    assert.include(prompt, " M src/half-done.ts");
    // Unlike a resume, this thread has no history, so it gets the whole thing.
    assert.include(prompt, "Cook exactly `epic.1` this iteration.");
    assert.include(prompt, "## Epic context (resolved at dispatch)");
  }),
);

it.live("charges the pinned handover exactly one dispatch", () =>
  Effect.gen(function* () {
    const test = fixture({
      sequential: false,
      resumedWorkers: [resumedWorker()],
      claimChildResult: "already-claimed",
      resumeCapability: "unsupported",
      attempts: [{ commit: true, close: true, comment: true }],
    });
    yield* test.run;

    // The interrupted row was paid for before the restart; the handover is a
    // genuinely new provider turn, so it pays once and no more.
    const run = test.runRecord();
    assert.equal(run.iterationsDispatched, 1);
    assert.equal(run.iterationsCompleted, 1);
    assert.equal(test.iterations.length, 2);
  }),
);

it.live("falls back the same way when the interrupted worktree is gone", () =>
  Effect.gen(function* () {
    const test = fixture({
      sequential: false,
      resumedWorkers: [resumedWorker()],
      adoptFails: true,
      attempts: [{ commit: true, close: true, comment: true }],
    });
    yield* test.run;

    assert.deepEqual(test.resumeCalls, []);
    assert.equal(test.iterations[0]?.turnStatus, "abandoned");
    assert.deepInclude(resumeDecisions(test.events)[0], { decision: "workspace-missing" });
    assert.deepEqual(test.acquireCalls, ["epic.1"]);
    assert.equal(test.runRecord().status, "done");
  }),
);

it.live("never resumes a child that closed while the run was down", () =>
  Effect.gen(function* () {
    const test = fixture({
      sequential: false,
      resumedWorkers: [resumedWorker()],
      claimChildResult: "closed",
    });
    yield* test.run;

    assert.deepEqual(test.claimChildCalls, ["epic.1"]);
    assert.deepEqual(test.resumeCalls, []);
    assert.deepEqual(test.beginTurnCalls, []);
    assert.equal(test.iterations[0]?.turnStatus, "abandoned");
    assert.equal(test.iterations[0]?.failureReason, "server-restart");
    assert.deepInclude(resumeDecisions(test.events)[0], { decision: "child-closed" });
    assert.equal(test.runRecord().status, "done");
  }),
);

it.live("decides two interrupted rows of one run independently", () =>
  Effect.gen(function* () {
    const first = resumedWorker({ iterationIndex: 3 });
    const second = resumedWorker({
      issueId: "epic.2",
      iterationIndex: 4,
      threadId: ThreadId.make(epicRunIterationThreadId({ runId: RUN_ID, iterationIndex: 4 })),
      branch: "epic/epic.2",
      worktreePath: "/wt/epic.2",
    });
    const test = fixture({
      sequential: false,
      runSeed: { workers: 2 },
      resumedWorkers: [first, second],
      claimChildResult: "already-claimed",
      // First adopts, second is refused. The order matches the launch order.
      resumeRefusals: [null, { _tag: "no-durable-state", detail: "no cursor persisted" }],
      attempts: [{ commit: true, close: true, comment: true }],
    });
    yield* test.run;

    assert.equal(test.resumeCalls.length, 2);
    const rows = new Map(test.iterations.map((row) => [row.iterationIndex, row]));
    assert.equal(rows.get(3)?.turnStatus, "completed");
    assert.equal(rows.get(4)?.turnStatus, "abandoned");
    assert.equal(rows.get(4)?.failureReason, "infra:resume-blocked");

    const decisions = resumeDecisions(test.events);
    assert.equal(decisions.length, 2);
    assert.deepEqual(
      decisions.map((event) => [event.iterationIndex, event.decision]),
      [
        [3, "resumed"],
        [4, "no-durable-state"],
      ],
    );
  }),
);

it.effect("lets two resumed workers fill a two-worker pool from tick zero", () =>
  Effect.gen(function* () {
    const test = fixture({
      sequential: false,
      runSeed: { workers: 2 },
      resumedWorkers: [
        resumedWorker({ iterationIndex: 3 }),
        resumedWorker({
          issueId: "epic.2",
          iterationIndex: 4,
          threadId: ThreadId.make(epicRunIterationThreadId({ runId: RUN_ID, iterationIndex: 4 })),
          worktreePath: "/wt/epic.2",
        }),
      ],
      claimChildResult: "already-claimed",
      attempts: [{ neverSettles: true }, { neverSettles: true }],
      policy: policy({ runStallTimeoutMs: 60_000 }),
    });
    const fiber = yield* test.run.pipe(Effect.forkChild);
    yield* TestClock.adjust(Duration.minutes(30));

    // Both slots are held by workers this run already charged for, so nothing
    // fresh is dispatched and `iterationsDispatched` never moves.
    assert.equal(test.resumeCalls.length, 2);
    assert.deepEqual(test.beginTurnCalls, []);
    assert.deepEqual(test.acquireCalls, []);
    assert.equal(test.runRecord().iterationsDispatched, 0);
    assert.equal(test.runRecord().status, "running");
    yield* Fiber.interrupt(fiber);
  }),
);

it.effect("carries a run's failure streaks into a resumed iteration", () =>
  Effect.gen(function* () {
    // `resumeRun` zeroes these three counters. A restart must not, or a gutted
    // run would restart its way out of the gutter.
    const test = fixture({
      sequential: false,
      resumedWorkers: [resumedWorker()],
      claimChildResult: "already-claimed",
      runSeed: { consecutiveFailures: 2, noCommitStreak: 1, infraStreak: 1 },
      attempts: [{ neverSettles: true }],
      policy: policy({ runStallTimeoutMs: 60_000 }),
    });
    const fiber = yield* test.run.pipe(Effect.forkChild);
    yield* TestClock.adjust(Duration.minutes(30));

    const run = test.runRecord();
    assert.equal(test.resumeCalls.length, 1);
    assert.equal(run.consecutiveFailures, 2);
    assert.equal(run.noCommitStreak, 1);
    assert.equal(run.infraStreak, 1);
    assert.equal(run.status, "running");
    yield* Fiber.interrupt(fiber);
  }),
);

/**
 * The conflict radar (t3code-2jh.7).
 *
 * Every case holds one worker open with `neverSettles` and lets the iteration
 * timeout end it, which is the only way to keep a worker armed while the radar
 * ticks. The radar's cadence is 1ms here, so each of these runs sweeps many
 * times — what the assertions pin is how OFTEN it acts, not how often it ticks.
 */
const radarPolicy = (override: Partial<PoolPolicy> = {}): PoolPolicy =>
  policy({
    conflictProbeIntervalMs: 1,
    iterationTimeoutMs: 80,
    infraFailureBudget: 1,
    ...override,
  });

it.live("nudges an active worker with the files its branch would conflict on", () =>
  Effect.gen(function* () {
    const test = fixture({
      sequential: false,
      attempts: [{ neverSettles: true }],
      policy: radarPolicy(),
      refHeads: () => ({ "epic/base": "base-1", "epic/epic.1": "branch-1" }),
      conflicts: () => ["src/a.ts", "src/b.ts"],
    });
    yield* test.run;

    // The probe trial-merges the worker's branch into the run's base branch,
    // in the main repository — never in the worker's own worktree.
    assert.deepEqual(test.conflictProbes[0], { base: "epic/base", branch: "epic/epic.1" });
    assert.lengthOf(test.nudges, 1);
    const prompt = test.nudges[0]?.prompt ?? "";
    assert.include(prompt, "src/a.ts");
    assert.include(prompt, "src/b.ts");
    assert.include(prompt, "epic/base");
    // The nudge goes to the worker's own handle, not to a fresh thread.
    assert.equal(
      test.nudges[0]?.ref,
      epicRunIterationThreadId({ runId: RUN_ID, iterationIndex: 0 }),
    );
  }),
);

it.live("nudges nobody when the probe reads clean, and none when it reads nothing", () =>
  Effect.gen(function* () {
    const clean = fixture({
      sequential: false,
      attempts: [{ neverSettles: true }],
      policy: radarPolicy(),
      conflicts: () => [],
    });
    yield* clean.run;
    assert.isAbove(clean.conflictProbes.length, 0);
    assert.deepEqual(clean.nudges, []);

    // `null` is git telling us nothing — an unreadable repo, an unknown ref, a
    // conflict it refused to name. None of them is evidence of a conflict.
    const unreadable = fixture({
      sequential: false,
      attempts: [{ neverSettles: true }],
      policy: radarPolicy(),
      conflicts: () => null,
    });
    yield* unreadable.run;
    assert.isAbove(unreadable.conflictProbes.length, 0);
    assert.deepEqual(unreadable.nudges, []);
  }),
);

it.live("probes a signature once, and probes again once a head moves", () =>
  Effect.gen(function* () {
    const stationary = fixture({
      sequential: false,
      attempts: [{ neverSettles: true }],
      policy: radarPolicy(),
      refHeads: () => ({ "epic/base": "base-1", "epic/epic.1": "branch-1" }),
      conflicts: () => ["src/a.ts"],
    });
    yield* stationary.run;
    // Many ticks, one probe: neither side moved, so re-reading them would
    // re-send the same nudge for the same conflict.
    assert.lengthOf(stationary.conflictProbes, 1);
    assert.lengthOf(stationary.nudges, 1);

    let branchHead = "branch-1";
    const moved = fixture({
      sequential: false,
      attempts: [{ neverSettles: true }],
      policy: radarPolicy(),
      refHeads: () => ({ "epic/base": "base-1", "epic/epic.1": branchHead }),
      conflicts: () => ["src/a.ts"],
      // The worker committed after the first nudge, so its branch is a
      // different thing to trial-merge now.
      onNudge: (count) => {
        if (count === 1) branchHead = "branch-2";
      },
    });
    yield* moved.run;
    assert.lengthOf(moved.conflictProbes, 2);
    assert.lengthOf(moved.nudges, 2);
  }),
);

it.live("never probes an in-place worker or an integration-fix child", () =>
  Effect.gen(function* () {
    // An in-place worker commits where the base branch already is, so it has
    // no branch of its own to trial-merge.
    const inPlace = fixture({
      sequential: false,
      inPlaceWorkspace: true,
      attempts: [{ neverSettles: true }],
      policy: radarPolicy(),
      conflicts: () => ["src/a.ts"],
    });
    yield* inPlace.run;
    assert.deepEqual(inPlace.conflictProbes, []);
    assert.deepEqual(inPlace.nudges, []);

    // An integration-fix child (t3code-sha) IS the base branch writer. Reading
    // a head it is rewriting produces a signature naming a state nobody is in.
    const integrationFix = fixture({
      sequential: false,
      childTitle: "Merge fix: integrate team/mine into epic/epic-1/base",
      attempts: [{ neverSettles: true }],
      policy: radarPolicy(),
      conflicts: () => ["src/a.ts"],
    });
    yield* integrationFix.run;
    assert.deepEqual(integrationFix.conflictProbes, []);
    assert.deepEqual(integrationFix.nudges, []);
  }),
);

it.live("survives a probe or a nudge that blows up", () =>
  Effect.gen(function* () {
    const brokenProbe = fixture({
      sequential: false,
      attempts: [{ neverSettles: true }],
      policy: radarPolicy(),
      probeDies: true,
    });
    yield* brokenProbe.run;
    // The iteration ends on its own timeout, exactly as it does with no radar
    // at all: a lost early warning is not a run failure.
    assert.equal(brokenProbe.iterations[0]?.failureReason, "infra:timeout");
    assert.equal(brokenProbe.runRecord().status, "failed");
    assert.deepEqual(brokenProbe.nudges, []);

    const brokenNudge = fixture({
      sequential: false,
      attempts: [{ neverSettles: true }],
      policy: radarPolicy(),
      conflicts: () => ["src/a.ts"],
      nudgeDies: true,
    });
    yield* brokenNudge.run;
    assert.equal(brokenNudge.iterations[0]?.failureReason, "infra:timeout");
    assert.equal(brokenNudge.runRecord().status, "failed");
  }),
);

it.live("never probes in sequential mode", () =>
  Effect.gen(function* () {
    const test = fixture({
      attempts: [{ commit: true, close: true, comment: true }],
      policy: radarPolicy({ iterationTimeoutMs: null, infraFailureBudget: 5 }),
      conflicts: () => ["src/a.ts"],
    });
    yield* test.run;

    // One worker on the base branch itself: there is no second branch for
    // anything to conflict with.
    assert.equal(test.runRecord().status, "done");
    assert.deepEqual(test.conflictProbes, []);
    assert.deepEqual(test.nudges, []);
  }),
);

it.live("stops nudging an iteration whose provider did not absorb the message", () =>
  Effect.gen(function* () {
    let branchHead = "branch-1";
    const test = fixture({
      sequential: false,
      attempts: [{ neverSettles: true }],
      policy: radarPolicy(),
      refHeads: () => ({ "epic/base": "base-1", "epic/epic.1": branchHead }),
      conflicts: () => ["src/a.ts"],
      nudgeOutcomes: ["unsupported"],
      // Even a moved head must not reopen the conversation: the first message
      // opened a turn of its own instead of steering the running one.
      onNudge: (count) => {
        if (count === 1) branchHead = "branch-2";
      },
    });
    yield* test.run;

    assert.lengthOf(test.nudges, 1);
    assert.lengthOf(test.conflictProbes, 1);
  }),
);
