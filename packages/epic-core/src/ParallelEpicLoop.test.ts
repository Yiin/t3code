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
          ? ({ _tag: "deferred" } as const)
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

it.effect("fails the run when the merge drain cannot acquire the slot", () =>
  Effect.gen(function* () {
    // Regression: a deferred drain used to retry forever with no log and no
    // bound, while the run lock kept heartbeating. The run reported "running"
    // and landed nothing for 8 hours.
    const test = fixture({ sequential: false, drainDefersForever: true });
    const fiber = yield* test.run.pipe(Effect.forkChild);
    yield* TestClock.adjust(Duration.minutes(11));
    yield* Fiber.join(fiber);

    const run = test.runRecord();
    assert.equal(run.status, "failed");
    assert.include(run.lastError ?? "", "infra:merge-slot-unavailable");
    assert.equal(test.dispatchCount(), 0);
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
