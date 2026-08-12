import {
  DEFAULT_EPIC_RUN_CONFIG,
  DEFAULT_EPIC_RUN_CONFIG_PROVENANCE,
  EpicRunId,
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
} from "./ParallelEpicLoop.ts";
import { parseMergeFixTitle } from "./policy.ts";
import type { PoolPolicy } from "./runPolicy.ts";
import type { IterationHandle } from "./ports/AgentDispatch.ts";
import type { BacklogIssue } from "./ports/Backlog.ts";
import type { RunEvent } from "./ports/RunEvents.ts";
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
  /** Settle in an errored turn carrying this provider error. */
  readonly providerError?: string;
  /** Fail `beginTurn` with an EpicRunnerDispatchError. */
  readonly dispatchFails?: boolean;
  /** Never settle, so the loop's iteration timeout fires. */
  readonly neverSettles?: boolean;
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
  };
  const iterations: PersistedEpicRunIteration[] = [];
  const events: RunEvent[] = [];
  const ordering: string[] = [];
  const attempts = input.attempts ?? [];
  let dispatchCount = 0;
  const createCalls: Array<Parameters<ParallelEpicLoopPorts["dispatch"]["createIteration"]>[0]> =
    [];
  const beginTurnCalls: Array<Parameters<ParallelEpicLoopPorts["dispatch"]["beginTurn"]>[0]> = [];
  const stopAbandonedCalls: string[] = [];
  const stopForcedCalls: string[] = [];
  const releasedClaims: string[] = [];
  const enqueuedMerges: Array<Parameters<MergeDrainShape["enqueueMerge"]>[0]> = [];
  const parkedBranchReads: string[] = [];
  const providerDegradations: Array<{
    readonly providerInstanceId: string;
    readonly failureReason: string;
  }> = [];
  const providerClears: string[] = [];
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
    countOpenChildren: () => Effect.succeed(child.status === "closed" ? 0 : 1),
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
        if (child.status === "in_progress") {
          child = { ...child, status: "open" };
          return true;
        }
        return false;
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
    acquire: (_runCtx, acquireInput) =>
      Effect.sync((): IterationWorkspace => {
        if (acquireInput.sequential) {
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

  const dispatch: ParallelEpicLoopPorts["dispatch"] = {
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
      const handle: IterationHandle = {
        ref: begin.threadId,
        capabilities: {
          terminalSignal: "projection",
          continuation: "same-thread",
          subagentLiveness: "native",
          finalMessage: "projection",
          providerErrors: "session-and-assistant",
          cost: "none",
        },
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
                    attempt.providerError === undefined
                      ? ("completed" as const)
                      : ("error" as const),
                  timedOut: false,
                  providerError: attempt.providerError ?? null,
                };
              }),
        continueTurn: () => Effect.void,
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
                    : 'RALPH_MSG: {"summary":"did work","why":"needed"}',
                streaming: false,
                waitExhausted: false,
              },
        ),
      };
      return Effect.succeed(handle);
    },
    stopAbandoned: (threadId) =>
      Effect.sync(() => {
        stopAbandonedCalls.push(threadId);
        ordering.push("dispatch:stopAbandoned");
      }),
    stopForced: (threadId) =>
      Effect.sync(() => {
        stopForcedCalls.push(threadId);
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
  };

  const vcs: PoolVcsShape = {
    headCommit: (cwd) =>
      Effect.succeed(
        siblingHeads.has(cwd)
          ? `sib-head-${String(siblingHeads.get(cwd) ?? 0)}`
          : `head-${String(head)}`,
      ),
    worktreeFingerprint: () => Effect.succeed(""),
    commitsAhead: () => Effect.succeed(0),
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
    stopAbandonedCalls,
    stopForcedCalls,
    releasedClaims,
    enqueuedMerges,
    parkedBranchReads,
    providerDegradations,
    providerClears,
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
        countOpenChildren: () =>
          Effect.succeed(
            (fixChildStatus === "open" ? 1 : 0) + (normalChildStatus === "open" ? 1 : 0),
          ),
        issueEvidence: (_cwd, issueId) =>
          Effect.succeed(
            issueId === fixChildId
              ? { status: fixChildStatus, title: fixChildTitle, commentCount: 0 }
              : { status: normalChildStatus, title: normalChildTitle, commentCount: 0 },
          ),
        issueIsResearch: () => Effect.succeed(false),
        epicDescription: () => Effect.succeed("EPIC GOAL"),
        releaseClaimedChild: () => Effect.succeed(false),
      };

      const workspace: WorkspaceShape = {
        ensureIntegration: () => Effect.succeed({ entries: [] }),
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
        createIteration: () => Effect.void,
        prepareIteration: () => Effect.void,
        beginTurn: (begin) =>
          Effect.sync((): IterationHandle => {
            const isFix = begin.workspace.worktreePath === `/wt/${fixChildId}`;
            return {
              ref: begin.threadId,
              capabilities: {
                terminalSignal: "projection",
                continuation: "same-thread",
                subagentLiveness: "native",
                finalMessage: "projection",
                providerErrors: "session-and-assistant",
                cost: "none",
              },
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
      };

      const vcs: PoolVcsShape = {
        headCommit: (cwd) => Effect.succeed(`head-${String(headByCwd.get(cwd) ?? 0)}`),
        worktreeFingerprint: () => Effect.succeed(""),
        commitsAhead: () => Effect.succeed(0),
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
    });
    yield* test.run;

    const run = test.runRecord();
    assert.equal(run.status, "failed");
    assert.include(run.lastError ?? "", "1 consecutive infrastructure failures");
    assert.equal(test.interrupts(), 1);
    assert.deepEqual(test.stopForcedCalls, [
      epicRunIterationThreadId({ runId: RUN_ID, iterationIndex: 0 }),
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
        },
      }),
      workerEvidence: wedgedWorkerEvidence(),
      supervisionClock: instantSupervisionClock(),
    });
    yield* test.run;

    assert.equal(test.iterations[0]?.turnStatus, "failed");
    assert.equal(test.iterations[0]?.failureReason, "infra:worker-liveness-stop");
    assert.include(test.iterations[0]?.summary ?? "", "worker liveness supervision stopped");
    // Interrupt first, then the forced stop, exactly as the timeout path does.
    assert.equal(test.interrupts(), 1);
    assert.deepEqual(test.stopForcedCalls, [
      epicRunIterationThreadId({ runId: RUN_ID, iterationIndex: 0 }),
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
    assert.deepEqual(test.stopForcedCalls, [
      epicRunIterationThreadId({ runId: RUN_ID, iterationIndex: 0 }),
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
