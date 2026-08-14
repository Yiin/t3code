import {
  DEFAULT_EPIC_RUN_CONFIG,
  DEFAULT_EPIC_RUN_CONFIG_PROVENANCE,
  EpicRunId,
  EpicTierId,
  IsoDateTime,
  NonNegativeInt,
  ProviderInstanceId,
  ProviderDriverKind,
  ThreadId,
  epicRunIterationThreadId,
  type EpicRunConfig,
  type ServerProvider,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

import { make as makeFileRunJournal } from "./adapters/FileRunJournal.ts";
import { runSequentialEpicLoop, type SequentialEpicLoopPorts } from "./SequentialEpicLoop.ts";
import type { RoleSelectionRequest } from "./ports/RoleSelection.ts";
import type { EpicFallbackHop } from "./providerFallback.ts";
import {
  DispatchError,
  type AgentDispatchCapabilities,
  type IterationHandle,
} from "./ports/AgentDispatch.ts";
import { BacklogError, type BacklogIssue, type BacklogShape } from "./ports/Backlog.ts";
import type { RunEvent } from "./ports/RunEvents.ts";
import type { PersistedEpicRun, PersistedEpicRunIteration } from "./ports/RunJournal.ts";
import { VcsError } from "./ports/Vcs.ts";
import { gateCommandDigest } from "./ports/Gate.ts";
import type { PersistedGateReceipt } from "./ports/GateReceipts.ts";

/** What a terminal dispatch declares, mirrored for the loop fakes. */
const terminalLikeCapabilities: AgentDispatchCapabilities = {
  terminalSignal: "process-exit",
  continuation: "none",
  subagentLiveness: "unavailable",
  finalMessage: "result-field",
  providerErrors: "session-and-assistant",
  cost: "none",
  lifecycle: { resume: "unsupported" },
};

type Attempt = {
  readonly infra?: boolean;
  readonly claim?: boolean;
  readonly commit?: boolean;
  /** Move the first sibling checkout's HEAD during settle. */
  readonly siblingCommit?: boolean;
  readonly close?: boolean;
  readonly comment?: boolean;
  readonly dirty?: boolean;
  readonly blocked?: boolean;
  readonly providerError?: string;
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
  parentId: input.parentId ?? "epic",
  description: input.description ?? "",
  labels: input.labels ?? [],
  commentCount: input.commentCount ?? 0,
});

const config = (override: Partial<EpicRunConfig> = {}): EpicRunConfig => ({
  ...DEFAULT_EPIC_RUN_CONFIG,
  ...override,
  limits: { ...DEFAULT_EPIC_RUN_CONFIG.limits, maxIterations: 10, ...override.limits },
  gate: { ...DEFAULT_EPIC_RUN_CONFIG.gate, disabled: true, ...override.gate },
  vcs: { ...DEFAULT_EPIC_RUN_CONFIG.vcs, noPush: true, ...override.vcs },
  server: {
    ...DEFAULT_EPIC_RUN_CONFIG.server,
    retryBaseDelayMs: 0,
    retryMaxDelayMs: 0,
    ...override.server,
  },
});

const fixture = (input: {
  readonly attempts?: ReadonlyArray<Attempt>;
  readonly initialStatus?: string;
  readonly config?: EpicRunConfig;
  readonly gatePasses?: boolean;
  readonly pushFails?: boolean;
  readonly childTitle?: string;
  readonly stopChecks?: ReadonlyArray<boolean>;
  readonly releaseFailures?: number;
  readonly providers?: ReadonlyArray<ServerProvider>;
  readonly selection?: { readonly instanceId: ProviderInstanceId; readonly model: string };
  /**
   * Wire a stub role resolver handing back this selection. Absent means no
   * resolver at all, which is today's run-level behaviour.
   */
  readonly roleSelection?: { readonly instanceId: ProviderInstanceId; readonly model: string };
  /** The tier the stub resolver reports its selection came from. */
  readonly roleTier?: EpicTierId;
  /** Live iteration-worker chain used by dispatch and fallback. */
  readonly roleChain?: ReadonlyArray<EpicFallbackHop>;
  /** Extra account blocks returned with role-chain state. */
  readonly roleBlockedInstances?: ReadonlyArray<ProviderInstanceId>;
  readonly siblings?: ReadonlyArray<{
    readonly repositoryPath: string;
    readonly baseBranch: string;
    readonly worktreeRoot: string;
  }>;
  /**
   * Settled iteration rows an earlier process of this run already wrote, in
   * index order. They are what a restart reads back from the journal.
   */
  readonly priorIterations?: ReadonlyArray<{
    readonly issueId: string | null;
    readonly turnStatus: PersistedEpicRunIteration["turnStatus"];
    readonly failureReason: string | null;
  }>;
  /**
   * Replace the in-memory journal fake. A restart cell points two fixtures at
   * one real {@link FileRunJournal}, which is the only journal that enforces
   * "create once, never rewrite a row".
   */
  readonly journal?: SequentialEpicLoopPorts["journal"];
  /** Which epic this process thinks the run id belongs to. */
  readonly epicId?: string;
}) => {
  const epic = issue({
    id: "epic",
    title: "Epic",
    status: "open",
    parentId: null,
    description: "Goal",
  });
  let child = issue({
    id: "epic.1",
    title: input.childTitle ?? "Child",
    status: input.initialStatus ?? "open",
  });
  let head = 0;
  let fingerprint = "";
  const siblingHeads = new Map<string, number>(
    (input.siblings ?? []).map((sibling) => [sibling.repositoryPath, 0]),
  );
  const pushes: Array<{
    readonly repositoryPath: string;
    readonly remote: string;
    readonly refspec: string;
  }> = [];
  const prompts: string[] = [];
  let dispatches = 0;
  let released = false;
  let claims = 0;
  let releaseAttempts = 0;
  let stopReads = 0;
  let persistedRun: PersistedEpicRun | null = null;
  const iterations: PersistedEpicRunIteration[] = (input.priorIterations ?? []).map(
    (prior, index) => ({
      runId: EpicRunId.make("run"),
      iterationIndex: NonNegativeInt.make(index),
      threadId: ThreadId.make(epicRunIterationThreadId({ runId: "run", iterationIndex: index })),
      issueId: prior.issueId,
      turnStatus: prior.turnStatus,
      summary: null,
      why: null,
      failureReason: prior.failureReason,
      startedAt: IsoDateTime.make("2026-01-01T00:00:00Z"),
      finishedAt: IsoDateTime.make("2026-01-01T00:01:00Z"),
    }),
  );
  const statuses: string[] = [];
  const events: RunEvent[] = [];
  const ordering: string[] = [];
  const selections: Array<{ readonly instanceId: ProviderInstanceId; readonly model: string }> = [];
  const roleRequests: RoleSelectionRequest[] = [];
  const degradations = new Map<string, { failureReason: string; degradedAt: string }>();
  const attempts = input.attempts ?? [];

  const backlog = {
    readyChildren: () => Effect.succeed(child.status === "open" ? [child] : []),
    showIssue: (id: string) => Effect.succeed(id === epic.id ? epic : child),
    listChildren: () => Effect.succeed([child]),
    claim: () =>
      Effect.sync(() => {
        claims += 1;
        child = { ...child, status: "in_progress" };
      }),
    releaseClaim: () => {
      releaseAttempts += 1;
      ordering.push("claim:release-attempt");
      if (releaseAttempts <= (input.releaseFailures ?? 0)) {
        return Effect.fail(
          new BacklogError({
            operation: "releaseClaim",
            issueId: child.id,
            detail: "offline",
          }),
        );
      }
      return Effect.sync(() => {
        if (child.status !== "in_progress") return false;
        child = { ...child, status: "open" };
        statuses.push("open");
        return true;
      });
    },
    setStatus: (_id: string, status: "open" | "in_progress" | "blocked" | "closed") =>
      Effect.sync(() => {
        child = { ...child, status };
        statuses.push(status);
      }),
  } as unknown as BacklogShape;

  const recordedGateReceipts: Array<PersistedGateReceipt> = [];
  const ports: SequentialEpicLoopPorts = {
    preflight: {
      check: () =>
        Effect.succeed({
          ok: true,
          blockers: [],
          warnings: [],
          resolvedConfig: DEFAULT_EPIC_RUN_CONFIG,
          configProvenance: DEFAULT_EPIC_RUN_CONFIG_PROVENANCE,
        }),
    },
    lock: {
      inspect: () => Effect.sync((): undefined => undefined),
      acquire: () =>
        Effect.succeed({
          path: "/lock",
          owner: {
            owner: "test",
            host: "host",
            pid: 1,
            pgid: 1,
            runDir: "/run",
            startedAt: "now",
            heartbeatAt: 1,
          },
          heartbeat: Effect.succeed(true),
          release: Effect.sync(() => {
            ordering.push("lease:released");
            released = true;
            return true;
          }),
        }),
    },
    backlog,
    journal: input.journal ?? {
      createRun: (run) =>
        Effect.sync(() => {
          persistedRun = run;
        }),
      saveRun: (run) =>
        Effect.sync(() => {
          persistedRun = run;
          ordering.push(`run:saved:${run.modelSelection.instanceId}`);
        }),
      getRun: () =>
        Effect.succeed(persistedRun === null ? Option.none() : Option.some(persistedRun)),
      appendIteration: (iteration) =>
        Effect.sync(() => {
          iterations.push(iteration);
          ordering.push("journal:running");
        }),
      updateIteration: (update) =>
        Effect.sync(() => {
          // Last match, not first: a restarted run counts its own dispatches
          // from zero, so its first row repeats an index a prior process
          // already used. This settles the row the loop just appended.
          const index = iterations.findLastIndex(
            (item) => item.iterationIndex === update.iterationIndex,
          );
          if (index >= 0) iterations[index] = { ...iterations[index]!, ...update };
          ordering.push(`journal:${update.turnStatus}`);
        }),
      // The sequential loop never resumes an iteration; the port exists so
      // both journals share one shape.
      markIterationResumed: () => Effect.void,
      listIterations: () => Effect.succeed(iterations),
      getLatestIteration: () => {
        const latest = iterations.at(-1);
        return Effect.succeed(latest === undefined ? Option.none() : Option.some(latest));
      },
    },
    providerDegradation: {
      upsertProviderDegradation: (record) =>
        Effect.sync(() => {
          degradations.set(record.providerInstanceId, {
            failureReason: record.failureReason,
            degradedAt: record.degradedAt,
          });
          ordering.push(`degradation:set:${record.providerInstanceId}`);
        }),
      clearProviderDegradation: (record) =>
        Effect.sync(() => {
          degradations.delete(record.providerInstanceId);
          ordering.push(`degradation:cleared:${record.providerInstanceId}`);
        }),
    },
    events: {
      publish: (event) =>
        Effect.sync(() => {
          events.push(event);
          if (event.type === "iteration-state-changed") {
            ordering.push(`event:${event.iteration.turnStatus}`);
          } else if (event.type === "child-claim-released") {
            ordering.push("event:child-claim-released");
          } else if (event.type === "provider-fallback") {
            ordering.push(`event:provider-fallback:${event.toInstanceId}`);
          }
        }),
    },
    providerInventory: { getProviders: Effect.succeed(input.providers ?? []) },
    roleSelection:
      input.roleSelection === undefined && input.roleChain === undefined
        ? null
        : {
            chain: () =>
              Effect.sync(() => {
                const chain = input.roleChain ?? [];
                const isInstanceBlocked = (instanceId: ProviderInstanceId) =>
                  input.roleBlockedInstances?.includes(instanceId) === true ||
                  degradations.has(instanceId);
                return {
                  chain,
                  isInstanceBlocked,
                  isBlocked: (hop: EpicFallbackHop) => isInstanceBlocked(hop.instanceId),
                };
              }),
            resolve: (request) =>
              Effect.sync(() => {
                roleRequests.push(request);
                const chainHop = input.roleChain?.find((hop) => !degradations.has(hop.instanceId));
                const chainSelection =
                  chainHop === undefined
                    ? undefined
                    : {
                        instanceId: chainHop.instanceId,
                        model: chainHop.model,
                        ...(chainHop.options === undefined ? {} : { options: chainHop.options }),
                      };
                return {
                  selection: input.roleSelection ?? chainSelection ?? request.fallbackSelection,
                  tierId: input.roleTier ?? null,
                };
              }),
          },
    dispatch: {
      capabilities: terminalLikeCapabilities,
      startIteration: ({ selection, prompt }) => {
        selections.push(selection);
        prompts.push(prompt);
        const attempt = attempts[dispatches++] ?? {};
        if (attempt.infra)
          return Effect.fail(new DispatchError({ operation: "start", detail: "offline" }));
        const handle: IterationHandle = {
          ref: `attempt-${String(dispatches)}`,
          capabilities: terminalLikeCapabilities,
          awaitSettled: Effect.sync(() => {
            if (attempt.claim) child = { ...child, status: "in_progress" };
            if (attempt.commit) head += 1;
            if (attempt.siblingCommit) {
              const first = input.siblings?.[0];
              if (first !== undefined) {
                siblingHeads.set(
                  first.repositoryPath,
                  (siblingHeads.get(first.repositoryPath) ?? 0) + 1,
                );
              }
            }
            if (attempt.close) child = { ...child, status: "closed" };
            if (attempt.comment) child = { ...child, commentCount: child.commentCount + 1 };
            if (attempt.dirty) fingerprint = " M dirty";
            return {
              turnState:
                attempt.providerError === undefined ? ("completed" as const) : ("error" as const),
              timedOut: false,
              providerError: attempt.providerError ?? null,
            };
          }),
          continueTurn: () => Effect.void,
          nudge: () => Effect.succeed("unsupported" as const),
          interrupt: Effect.void,
          release: Effect.void,
          runningSubagents: Effect.succeed({ mode: "unavailable", reason: "test" }),
          finalMessage: Effect.succeed({
            text: attempt.blocked ? "RALPH_BLOCKED" : 'RALPH_MSG: {"summary":"done","why":"test"}',
            streaming: false,
            waitExhausted: false,
          }),
        };
        return Effect.succeed(handle);
      },
      runAuxiliary: () => Effect.succeed({ output: "", succeeded: false }),
    },
    gate: {
      run: () =>
        Effect.succeed({
          passed: input.gatePasses ?? true,
          repositoryPaths: ["/repo"],
          output: "gate output",
          receipt: {
            commandDigest: gateCommandDigest("gate"),
            cwd: "/repo",
            outcome: (input.gatePasses ?? true) ? ("passed" as const) : ("failed" as const),
            exitCode: (input.gatePasses ?? true) ? 0 : 1,
            queuedAt: "2026-08-13T00:00:00.000Z",
            acquiredAt: "2026-08-13T00:00:01.000Z",
            finishedAt: "2026-08-13T00:00:03.000Z",
            lockWaitMs: 1_000,
            executionMs: 2_000,
            inputHeads: [{ repositoryPath: "/repo", head: "head-1" }],
            output: "gate output",
          },
        }),
    },
    gateReceipts: {
      record: (receipt) => Effect.sync(() => void recordedGateReceipts.push(receipt)),
      list: (runId) =>
        Effect.succeed(recordedGateReceipts.filter((receipt) => receipt.runId === runId)),
    },
    vcs: {
      headCommit: (repository: { readonly repositoryPath: string }) =>
        Effect.succeed(
          repository.repositoryPath === "/repo"
            ? `head-${String(head)}`
            : `sib-head-${String(siblingHeads.get(repository.repositoryPath) ?? 0)}`,
        ),
      currentBranch: (repositoryPath: string) =>
        Effect.succeed(
          input.siblings?.find((sibling) => sibling.repositoryPath === repositoryPath)
            ?.baseBranch ?? null,
        ),
      worktreeFingerprint: () => Effect.succeed(fingerprint),
      push: (pushInput: {
        readonly repositoryPath: string;
        readonly remote: string;
        readonly refspec: string;
      }) => {
        pushes.push(pushInput);
        return input.pushFails
          ? Effect.fail(
              new VcsError({
                operation: "push",
                repositoryPath: pushInput.repositoryPath,
                detail: "offline",
              }),
            )
          : Effect.void;
      },
    } as unknown as SequentialEpicLoopPorts["vcs"],
  };

  const run = () =>
    runSequentialEpicLoop(
      {
        runId: "run",
        epicId: input.epicId ?? "epic",
        cwd: "/repo",
        runDirectory: "/run",
        repository: {
          repositoryPath: "/repo",
          baseBranch: "mine",
          worktreeRoot: "/worktrees",
          siblings: input.siblings ?? [],
        },
        selection: input.selection ?? {
          instanceId: ProviderInstanceId.make("worker"),
          model: "test",
        },
        configSnapshot: {
          fileResult: { _tag: "absent" },
          config: input.config ?? config(),
          provenance: DEFAULT_EPIC_RUN_CONFIG_PROVENANCE,
          violations: [],
        },
        readOrientation: () => Effect.succeed("orientation"),
        shouldStop: () => Effect.succeed(input.stopChecks?.[stopReads++] ?? false),
        now: () => "2026-01-01T00:00:00Z",
      },
      ports,
    );

  return {
    run,
    child: () => child,
    dispatches: () => dispatches,
    pushes,
    prompts,
    statuses,
    iterations,
    released: () => released,
    claims: () => claims,
    releaseAttempts: () => releaseAttempts,
    events,
    ordering,
    selections,
    roleRequests,
    degradations,
    gateReceipts: recordedGateReceipts,
  };
};

/**
 * The run's own duration says nothing about what to fix. Separating the
 * provider turn from the gate is what makes a 30-hour run explainable, and the
 * receipt is what proves the gate ran at all.
 */
it.live("records its gate receipt and where the iteration's wall time went", () =>
  Effect.gen(function* () {
    const resolved = fixture({
      attempts: [{ commit: true, close: true }],
      config: config({ gate: { command: "gate", disabled: false } }),
    });
    yield* resolved.run();

    assert.deepEqual(
      resolved.gateReceipts.map((receipt) => [receipt.phase, receipt.childId, receipt.outcome]),
      [["sequential", "epic.1", "passed"]],
    );
    assert.deepEqual(resolved.gateReceipts[0]?.inputHeads, [
      { repositoryPath: "/repo", head: "head-1" },
    ]);

    const timings = resolved.iterations.at(-1)?.phaseTimings;
    assert.notEqual(timings, undefined);
    assert.notEqual(timings, null);
    // Every bucket is present and non-negative. The injected clock is frozen,
    // so the durations are zero; what this pins is that the record carries
    // the provider turn apart from the merge and gate work.
    assert.deepEqual(timings, {
      prepareMs: 0,
      providerMs: 0,
      settlementMs: 0,
      // No merge queue in this loop; the child commits onto the base branch.
      mergeWaitMs: 0,
      gateMs: 0,
    });
    assert.equal(typeof resolved.iterations.at(-1)?.promptBytes, "number");
    assert.equal((resolved.iterations.at(-1)?.promptBytes ?? 0) > 0, true);
  }),
);

it.live(
  "dispatches the iteration-worker role selection, and the run's own without a resolver",
  () =>
    Effect.gen(function* () {
      const roleSelection = {
        instanceId: ProviderInstanceId.make("cooker"),
        model: "worker-model",
      };
      const resolved = fixture({
        attempts: [{ commit: true, close: true }],
        roleSelection,
        roleTier: EpicTierId.make("cheap"),
      });
      yield* resolved.run();

      assert.deepEqual(resolved.selections, [roleSelection]);
      // The record names the tier that produced the dispatch, so the outcome
      // can be counted against it later.
      assert.deepEqual(
        resolved.iterations.map((iteration) => [
          iteration.tierId,
          iteration.providerInstanceId,
          iteration.model,
        ]),
        [["cheap", roleSelection.instanceId, roleSelection.model]],
      );
      assert.deepEqual(
        resolved.roleRequests.map((request) => [request.role, request.issueId]),
        [["iteration-worker", "epic.1"]],
      );
      // The run-level selection travels as the fallback the adapter returns
      // when a role has no tier of its own.
      assert.deepEqual(resolved.roleRequests[0]?.fallbackSelection, {
        instanceId: ProviderInstanceId.make("worker"),
        model: "test",
      });

      const unresolved = fixture({ attempts: [{ commit: true, close: true }] });
      yield* unresolved.run();

      assert.deepEqual(unresolved.selections, [
        { instanceId: ProviderInstanceId.make("worker"), model: "test" },
      ]);
      assert.deepEqual(unresolved.roleRequests, []);
      // No resolver means no tier, but the run's own selection still
      // dispatched, so the account and model are recorded either way.
      assert.deepEqual(
        unresolved.iterations.map((iteration) => [
          iteration.tierId,
          iteration.providerInstanceId,
          iteration.model,
        ]),
        [[null, "worker", "test"]],
      );
    }),
);

it.live("persists Prime to Claude to Codex to Kimi fallback across dispatches", () =>
  Effect.gen(function* () {
    const prime = provider("prime", "primeAgent", "prime/custom-model");
    const claude = provider("claude", "claudeAgent", "claude-sonnet-5");
    const codex = provider("codex", "codex", "gpt-5.6-sol");
    const kimi = provider("kimi", "kimi", "kimi-code/k3");
    const test = fixture({
      attempts: [
        { providerError: "rate limit" },
        { providerError: "rate limit" },
        { providerError: "rate limit" },
        { commit: true, close: true },
      ],
      providers: [prime, claude, codex, kimi],
      selection: { instanceId: prime.instanceId, model: "prime/custom-model" },
      config: config({
        limits: {
          ...DEFAULT_EPIC_RUN_CONFIG.limits,
          maxAttemptsPerChild: 1,
          maxIterations: 4,
        },
        server: {
          ...DEFAULT_EPIC_RUN_CONFIG.server,
          infraFailureBudget: 1,
          retryBaseDelayMs: 0,
          retryMaxDelayMs: 0,
        },
      }),
    });

    const result = yield* test.run();
    assert.equal(result.status, "done");
    assert.equal(result.infraStreak, 0);
    assert.deepEqual(test.selections, [
      { instanceId: prime.instanceId, model: "prime/custom-model" },
      { instanceId: claude.instanceId, model: "claude-sonnet-5" },
      {
        instanceId: codex.instanceId,
        model: "gpt-5.6-sol",
        options: [{ id: "reasoningEffort", value: "high" }],
      },
      { instanceId: kimi.instanceId, model: "kimi-code/k3" },
    ]);
    assert.deepEqual(
      test.events.filter((event) => event.type === "provider-fallback"),
      [
        {
          type: "provider-fallback",
          runId: "run",
          issueId: "epic.1",
          iterationIndex: 0,
          failureReason: "provider-error:rate-limit",
          fromInstanceId: "prime",
          fromDriver: "primeAgent",
          fromModel: "prime/custom-model",
          toInstanceId: "claude",
          toDriver: "claudeAgent",
          toModel: "claude-sonnet-5",
        },
        {
          type: "provider-fallback",
          runId: "run",
          issueId: "epic.1",
          iterationIndex: 1,
          failureReason: "provider-error:rate-limit",
          fromInstanceId: "claude",
          fromDriver: "claudeAgent",
          fromModel: "claude-sonnet-5",
          toInstanceId: "codex",
          toDriver: "codex",
          toModel: "gpt-5.6-sol",
        },
        {
          type: "provider-fallback",
          runId: "run",
          issueId: "epic.1",
          iterationIndex: 2,
          failureReason: "provider-error:rate-limit",
          fromInstanceId: "codex",
          fromDriver: "codex",
          fromModel: "gpt-5.6-sol",
          toInstanceId: "kimi",
          toDriver: "kimi",
          toModel: "kimi-code/k3",
        },
      ],
    );
    assert.isBelow(
      test.ordering.indexOf("run:saved:claude"),
      test.ordering.indexOf("event:provider-fallback:claude"),
    );
    assert.isBelow(
      test.ordering.indexOf("run:saved:codex"),
      test.ordering.indexOf("event:provider-fallback:codex"),
    );
    assert.isBelow(
      test.ordering.indexOf("run:saved:kimi"),
      test.ordering.indexOf("event:provider-fallback:kimi"),
    );
  }),
);

it.live("follows the worker role chain across provider errors", () =>
  Effect.gen(function* () {
    const claudeA = provider("claude-a", "claudeAgent", "claude-sonnet-5");
    const claudeB = provider("claude-b", "claudeAgent", "claude-sonnet-5");
    const codex = provider("codex", "codex", "gpt-5.6-sol");
    const test = fixture({
      attempts: [
        { providerError: "rate limit" },
        { providerError: "rate limit" },
        { commit: true, close: true },
      ],
      providers: [claudeA, claudeB, codex],
      selection: { instanceId: claudeA.instanceId, model: "claude-sonnet-5" },
      roleChain: [
        { instanceId: claudeA.instanceId, model: "claude-sonnet-5" },
        { instanceId: claudeB.instanceId, model: "claude-sonnet-5" },
        { instanceId: codex.instanceId, model: "gpt-5.6-sol" },
      ],
      config: config({
        limits: { ...DEFAULT_EPIC_RUN_CONFIG.limits, maxIterations: 3 },
      }),
    });

    const result = yield* test.run();

    assert.equal(result.status, "done");
    assert.deepEqual(
      test.selections.map((item) => item.instanceId),
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

it.live("leaves an exhausted role chain without wrapping to a blocked sibling", () =>
  Effect.gen(function* () {
    const claudeA = provider("claude-a", "claudeAgent", "claude-sonnet-5");
    const claudeB = provider("claude-b", "claudeAgent", "claude-sonnet-5");
    const codex = provider("codex", "codex", "gpt-5.6-sol");
    const test = fixture({
      attempts: [
        { providerError: "rate limit" },
        { providerError: "rate limit" },
        { commit: true, close: true },
      ],
      providers: [claudeA, claudeB, codex],
      selection: { instanceId: claudeA.instanceId, model: "claude-sonnet-5" },
      roleChain: [
        { instanceId: claudeA.instanceId, model: "claude-sonnet-5" },
        { instanceId: claudeB.instanceId, model: "claude-sonnet-5" },
      ],
      config: config({
        limits: { ...DEFAULT_EPIC_RUN_CONFIG.limits, maxIterations: 3 },
      }),
    });

    yield* test.run();

    assert.deepEqual(
      test.selections.map((item) => item.instanceId),
      ["claude-a", "claude-b", "codex"],
    );
  }),
);

it.live("refuses a role-chain hop that already matches the run row", () =>
  Effect.gen(function* () {
    const claudeA = provider("claude-a", "claudeAgent", "claude-sonnet-5");
    const claudeB = provider("claude-b", "claudeAgent", "claude-sonnet-5");
    const test = fixture({
      attempts: [{ providerError: "rate limit" }],
      providers: [claudeA, claudeB],
      selection: { instanceId: claudeB.instanceId, model: "claude-sonnet-5" },
      roleSelection: { instanceId: claudeA.instanceId, model: "claude-sonnet-5" },
      roleChain: [
        { instanceId: claudeA.instanceId, model: "claude-sonnet-5" },
        { instanceId: claudeB.instanceId, model: "claude-sonnet-5" },
      ],
      config: config({
        limits: { ...DEFAULT_EPIC_RUN_CONFIG.limits, maxIterations: 1 },
      }),
    });

    yield* test.run();

    assert.equal(test.events.filter((event) => event.type === "provider-fallback").length, 0);
    assert.equal(test.degradations.size, 0);
  }),
);

it.live("keeps driver-order fallback unchanged when the role chain is empty", () =>
  Effect.gen(function* () {
    const claudeA = provider("claude-a", "claudeAgent", "claude-sonnet-5");
    const claudeB = provider("claude-b", "claudeAgent", "claude-sonnet-5");
    const test = fixture({
      attempts: [{ providerError: "rate limit" }, { commit: true, close: true }],
      providers: [claudeA, claudeB],
      selection: { instanceId: claudeA.instanceId, model: "claude-sonnet-5" },
      roleChain: [],
      roleBlockedInstances: [claudeB.instanceId],
      config: config({
        limits: { ...DEFAULT_EPIC_RUN_CONFIG.limits, maxIterations: 2 },
      }),
    });

    yield* test.run();

    assert.deepEqual(
      test.selections.map((item) => item.instanceId),
      ["claude-a", "claude-b"],
    );
  }),
);

it.live("records each failed account durably and retires the one that then works", () =>
  Effect.gen(function* () {
    const claude = provider("claude", "claudeAgent", "claude-sonnet-5");
    const codex = provider("codex", "codex", "gpt-5.6-sol");
    const test = fixture({
      attempts: [{ providerError: "rate limit" }, { commit: true, close: true }],
      providers: [claude, codex],
      selection: { instanceId: claude.instanceId, model: "claude-sonnet-5" },
      config: config({
        limits: { ...DEFAULT_EPIC_RUN_CONFIG.limits, maxAttemptsPerChild: 2, maxIterations: 2 },
      }),
    });

    yield* test.run();

    // Claude stays recorded so the NEXT run of this epic starts on Codex.
    // Codex proved itself, so nothing an earlier run wrote about it survives.
    assert.deepEqual([...test.degradations.keys()], ["claude"]);
    assert.equal(test.degradations.get("claude")?.failureReason, "provider-error:rate-limit");
    assert.deepEqual(
      test.ordering.filter((entry) => entry.startsWith("degradation:")),
      ["degradation:set:claude", "degradation:cleared:codex"],
    );
  }),
);

it.live("keeps a closed child unchanged after a gate failure", () =>
  Effect.gen(function* () {
    const test = fixture({
      attempts: [{ claim: true, commit: true, close: true }],
      config: config({
        limits: { ...DEFAULT_EPIC_RUN_CONFIG.limits, maxAttemptsPerChild: 1, maxIterations: 2 },
        gate: { command: "gate", disabled: false },
      }),
      gatePasses: false,
    });
    const result = yield* test.run();
    assert.equal(result.status, "failed");
    assert.equal(test.child().status, "closed");
    assert.deepEqual(test.statuses, []);
  }),
);

it.live("reopens a claimed child and emits recovery when its retry budget is exhausted", () =>
  Effect.gen(function* () {
    const test = fixture({
      attempts: [{ claim: true, blocked: true }],
      config: config({
        limits: { ...DEFAULT_EPIC_RUN_CONFIG.limits, maxAttemptsPerChild: 1 },
        server: { ...DEFAULT_EPIC_RUN_CONFIG.server, maxConsecutiveFailures: 1 },
      }),
    });

    const result = yield* test.run();
    assert.equal(result.status, "failed");
    assert.equal(test.child().status, "open");
    assert.deepEqual(test.statuses, ["open"]);
    assert.deepEqual(
      test.events.filter((event) => event.type === "child-claim-released"),
      [
        {
          type: "child-claim-released",
          runId: "run",
          issueId: "epic.1",
          iterationIndex: 0,
          reason: "retry budget exhausted; child reopened",
        },
      ],
    );
    assert.isBelow(
      test.ordering.indexOf("event:failed"),
      test.ordering.indexOf("event:child-claim-released"),
    );
  }),
);

it.live("keeps an unclaimed child open without emitting recovery at exhaustion", () =>
  Effect.gen(function* () {
    const test = fixture({
      attempts: [{ blocked: true }],
      config: config({
        limits: { ...DEFAULT_EPIC_RUN_CONFIG.limits, maxAttemptsPerChild: 1 },
        server: { ...DEFAULT_EPIC_RUN_CONFIG.server, maxConsecutiveFailures: 1 },
      }),
    });

    assert.equal((yield* test.run()).status, "failed");
    assert.equal(test.child().status, "open");
    assert.deepEqual(
      test.events.filter((event) => event.type === "child-claim-released"),
      [],
    );
  }),
);

it.live("charges a restarted run for the child attempts an earlier process spent", () =>
  Effect.gen(function* () {
    const test = fixture({
      priorIterations: [
        { issueId: "epic.1", turnStatus: "failed", failureReason: "child:blocked" },
        { issueId: "epic.1", turnStatus: "failed", failureReason: "child:no-commit-child-open" },
      ],
      attempts: [{ claim: true, blocked: true }],
      config: config({
        // The per-child budget (3) bites before the consecutive-failure budget.
        limits: { ...DEFAULT_EPIC_RUN_CONFIG.limits, maxAttemptsPerChild: 3, maxIterations: 5 },
        server: { ...DEFAULT_EPIC_RUN_CONFIG.server, maxConsecutiveFailures: 5 },
      }),
    });

    // Two spent attempts plus this one exhaust the budget, so the run fails on
    // its first dispatch instead of granting a fresh three.
    const result = yield* test.run();
    assert.equal(result.status, "failed");
    assert.equal(result.lastError, "agent reported RALPH_BLOCKED");
    assert.equal(test.dispatches(), 1);
    assert.equal(test.child().status, "open");
    assert.deepEqual(
      test.events.filter((event) => event.type === "child-claim-released"),
      [
        {
          type: "child-claim-released",
          runId: "run",
          issueId: "epic.1",
          iterationIndex: 0,
          reason: "retry budget exhausted; child reopened",
        },
      ],
    );
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
        // A no-commit turn that closed its child anyway settles `completed`.
        { issueId: "epic.1", turnStatus: "completed", failureReason: null },
        // Another child's spent attempt, and a row that named no child at all.
        { issueId: "epic.2", turnStatus: "failed", failureReason: "child:blocked" },
        { issueId: null, turnStatus: "failed", failureReason: "child:blocked" },
      ],
      attempts: [
        { claim: true, blocked: true },
        { claim: true, blocked: true },
        { claim: true, blocked: true },
      ],
      config: config({
        limits: { ...DEFAULT_EPIC_RUN_CONFIG.limits, maxAttemptsPerChild: 3, maxIterations: 5 },
        server: { ...DEFAULT_EPIC_RUN_CONFIG.server, maxConsecutiveFailures: 5 },
      }),
    });

    assert.equal((yield* test.run()).status, "failed");
    assert.equal(test.dispatches(), 3);
  }),
);

it.live("retries a failed claim release during terminal cleanup", () =>
  Effect.gen(function* () {
    const test = fixture({
      attempts: [{ claim: true, blocked: true }],
      releaseFailures: 1,
      config: config({
        limits: { ...DEFAULT_EPIC_RUN_CONFIG.limits, maxAttemptsPerChild: 1 },
        server: { ...DEFAULT_EPIC_RUN_CONFIG.server, maxConsecutiveFailures: 1 },
      }),
    });

    const result = yield* test.run();
    assert.equal(result.status, "failed");
    assert.equal(result.lastError, "agent reported RALPH_BLOCKED");
    assert.equal(test.child().status, "open");
    assert.equal(test.releaseAttempts(), 2);
    assert.isBelow(
      test.ordering.lastIndexOf("claim:release-attempt"),
      test.ordering.indexOf("lease:released"),
    );
    assert.deepEqual(
      test.events.filter((event) => event.type === "child-claim-released"),
      [
        {
          type: "child-claim-released",
          runId: "run",
          issueId: "epic.1",
          iterationIndex: 0,
          reason: "retry budget exhausted; child reopened",
        },
      ],
    );
  }),
);

it.live("does not charge infrastructure failures to the child attempt budget", () =>
  Effect.gen(function* () {
    const test = fixture({
      attempts: [{ infra: true }, { infra: true }, { commit: true, close: true }],
      config: config({
        limits: { ...DEFAULT_EPIC_RUN_CONFIG.limits, maxAttemptsPerChild: 1, maxIterations: 5 },
        server: {
          ...DEFAULT_EPIC_RUN_CONFIG.server,
          infraFailureBudget: 3,
          retryBaseDelayMs: 1,
          retryMaxDelayMs: 1,
        },
      }),
    });
    const result = yield* test.run();
    assert.equal(result.status, "done");
    assert.equal(test.dispatches(), 3);
    assert.notInclude(test.statuses, "blocked");
  }),
);

it.live("treats ready-empty with an open child as stuck", () =>
  Effect.gen(function* () {
    const test = fixture({ initialStatus: "in_progress" });
    const result = yield* test.run();
    assert.equal(result.status, "failed");
    assert.include(result.lastError ?? "", "ready-empty-with-open-children");
    assert.equal(test.dispatches(), 0);
  }),
);

it.live("leaves claiming to the worker and reports done when it closes the child", () =>
  Effect.gen(function* () {
    const test = fixture({
      attempts: [{ claim: true, commit: true, close: true }],
      config: config({ limits: { ...DEFAULT_EPIC_RUN_CONFIG.limits, maxIterations: 1 } }),
    });
    const result = yield* test.run();
    assert.equal(result.status, "done");
    assert.equal(result.iterationsCompleted, 1);
    assert.equal(test.claims(), 0);
    assert.isTrue(test.released());
  }),
);

it.live("keeps a closed child unchanged when the worker leaves the worktree dirty", () =>
  Effect.gen(function* () {
    const test = fixture({
      attempts: [{ commit: true, close: true, dirty: true }],
      config: config({
        limits: { ...DEFAULT_EPIC_RUN_CONFIG.limits, maxAttemptsPerChild: 1, maxIterations: 2 },
      }),
    });
    const result = yield* test.run();
    assert.equal(result.status, "failed");
    assert.equal(test.child().status, "closed");
  }),
);

it.live("fails safely after push failure without dispatching duplicate work", () =>
  Effect.gen(function* () {
    const test = fixture({
      attempts: [{ commit: true, close: true }],
      config: config({ vcs: { noPush: false, runOwnedBaseBranch: false } }),
      pushFails: true,
    });
    const result = yield* test.run();
    assert.equal(result.status, "failed");
    assert.include(result.lastError ?? "", "push failed");
    assert.equal(test.dispatches(), 1);
    assert.equal(test.child().status, "closed");
  }),
);

it.live("counts a sibling-only commit as committed and pushes the moved sibling", () =>
  Effect.gen(function* () {
    const test = fixture({
      siblings: [{ repositoryPath: "/sib", baseBranch: "sib-main", worktreeRoot: "/wt-sib" }],
      attempts: [{ close: true, siblingCommit: true }],
      config: config({ vcs: { noPush: false, runOwnedBaseBranch: false } }),
    });
    const result = yield* test.run();
    assert.equal(result.status, "done");
    // The unmoved main repo is not pushed; the moved sibling is, on its own branch.
    assert.deepEqual(test.pushes, [
      { repositoryPath: "/sib", remote: "origin", refspec: "HEAD:sib-main" },
    ]);
    assert.include(
      test.prompts[0] ?? "",
      "This child may span sibling repositories: /sib (relative to the project root).",
    );
  }),
);

it.live("fails fatally when a moved sibling push is rejected", () =>
  Effect.gen(function* () {
    const test = fixture({
      siblings: [{ repositoryPath: "/sib", baseBranch: "sib-main", worktreeRoot: "/wt-sib" }],
      attempts: [{ close: true, siblingCommit: true }],
      config: config({ vcs: { noPush: false, runOwnedBaseBranch: false } }),
      pushFails: true,
    });
    const result = yield* test.run();
    assert.equal(result.status, "failed");
    assert.include(result.lastError ?? "", "push failed");
    assert.equal(test.iterations[0]?.failureReason, "infra:push-failed");
  }),
);

it.live("pushes the main repo only when its head moved since first dispatch", () =>
  Effect.gen(function* () {
    const test = fixture({
      siblings: [{ repositoryPath: "/sib", baseBranch: "sib-main", worktreeRoot: "/wt-sib" }],
      attempts: [{ commit: true, close: true }],
      config: config({ vcs: { noPush: false, runOwnedBaseBranch: false } }),
    });
    const result = yield* test.run();
    assert.equal(result.status, "done");
    assert.deepEqual(test.pushes, [
      { repositoryPath: "/repo", remote: "origin", refspec: "HEAD:mine" },
    ]);
  }),
);

it.live("records missing findings without reopening a closed research child", () =>
  Effect.gen(function* () {
    const test = fixture({
      childTitle: "Research: investigate",
      attempts: [{ commit: true, close: true }],
      config: config({
        limits: { ...DEFAULT_EPIC_RUN_CONFIG.limits, maxAttemptsPerChild: 1, maxIterations: 2 },
      }),
    });
    const result = yield* test.run();
    assert.equal(result.status, "failed");
    assert.equal(test.child().status, "closed");
    assert.equal(test.iterations[0]?.failureReason, "child:closed-without-findings");
  }),
);

it.live("accepts committed research only with a new findings comment", () =>
  Effect.gen(function* () {
    const test = fixture({
      childTitle: "Research: investigate",
      attempts: [{ commit: true, close: true, comment: true }],
    });
    assert.equal((yield* test.run()).status, "done");
  }),
);

it.live("accepts non-code work with a closed child and new comment evidence", () =>
  Effect.gen(function* () {
    const test = fixture({ attempts: [{ close: true, comment: true }] });
    assert.equal((yield* test.run()).status, "done");
  }),
);

it.live("does not claim or dispatch when STOP appears before dispatch", () =>
  Effect.gen(function* () {
    const test = fixture({ stopChecks: [false, true] });
    const result = yield* test.run();
    assert.equal(result.status, "cancelled");
    assert.equal(test.claims(), 0);
    assert.equal(test.dispatches(), 0);
  }),
);

it.live("publishes iteration events only after their journal writes", () =>
  Effect.gen(function* () {
    const test = fixture({ attempts: [{ commit: true, close: true }] });
    yield* test.run();
    assert.isBelow(
      test.ordering.indexOf("journal:running"),
      test.ordering.indexOf("event:running"),
    );
    assert.isBelow(
      test.ordering.indexOf("journal:completed"),
      test.ordering.indexOf("event:completed"),
    );
  }),
);

it.live("does not reopen a closed child after a non-done outcome", () =>
  Effect.gen(function* () {
    const test = fixture({
      attempts: [{ claim: true, commit: true, close: true, blocked: true }],
      config: config({
        limits: { ...DEFAULT_EPIC_RUN_CONFIG.limits, maxAttemptsPerChild: 1, maxIterations: 2 },
      }),
    });
    const result = yield* test.run();
    assert.equal(result.status, "failed");
    assert.equal(test.child().status, "closed");
    assert.deepEqual(
      test.events.filter((event) => event.type === "child-claim-released"),
      [],
    );
  }),
);

/**
 * Restarting a run on its own id, against the real file journal.
 *
 * The in-memory fake above accepts a second `createRun` and merges a repeated
 * iteration index; only {@link makeFileRunJournal} enforces "create once, and
 * never rewrite a row". These cells are the acceptance for that.
 */
const withRealJournal = <A, E, R>(
  body: (journal: SequentialEpicLoopPorts["journal"]) => Effect.Effect<A, E, R>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const runDirectory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "epic-sequential-restart-",
      });
      return yield* body(yield* makeFileRunJournal({ runDirectory }));
    }),
  ).pipe(Effect.provide(NodeServices.layer));

/** One failed dispatch ends the first process, so the second one restarts it. */
const restartConfig = config({
  limits: { ...DEFAULT_EPIC_RUN_CONFIG.limits, maxAttemptsPerChild: 3, maxIterations: 5 },
  server: { ...DEFAULT_EPIC_RUN_CONFIG.server, maxConsecutiveFailures: 1 },
});

it.live("appends past the rows an earlier process of the same run id wrote", () =>
  withRealJournal((journal) =>
    Effect.gen(function* () {
      const first = fixture({
        journal,
        attempts: [{ claim: true, blocked: true }],
        config: restartConfig,
      });
      assert.equal((yield* first.run()).status, "failed");
      const afterFirst = yield* journal.listIterations(EpicRunId.make("run"));

      const second = fixture({
        journal,
        attempts: [{ commit: true, close: true }],
        config: restartConfig,
      });
      const resumed = yield* second.run();

      const rows = yield* journal.listIterations(EpicRunId.make("run"));
      assert.deepEqual(
        rows.map((row) => [row.iterationIndex, row.turnStatus]),
        [
          [0, "failed"],
          [1, "completed"],
        ],
      );
      // The prior row is evidence, not scratch space: the restart neither
      // rewrote it nor reused its index.
      assert.deepEqual(rows[0], afterFirst[0]);
      assert.equal(resumed.status, "done");
      // Budgets carry: the restart spends the run's remaining iterations, not
      // a fresh five.
      assert.equal(resumed.iterationsDispatched, 2);
      assert.equal(resumed.iterationsCompleted, 2);
      assert.equal(second.dispatches(), 1);
    }),
  ),
);

it.live("settles the row an interrupted process left running, and dispatches past it", () =>
  withRealJournal((journal) =>
    Effect.gen(function* () {
      const runId = EpicRunId.make("run");
      const first = fixture({
        journal,
        attempts: [{ claim: true, blocked: true }],
        config: restartConfig,
      });
      yield* first.run();
      // What a crash mid-dispatch leaves behind: an appended `running` row the
      // run record's own counter never saw.
      const settled = (yield* journal.listIterations(runId))[0]!;
      yield* journal.appendIteration({
        ...settled,
        iterationIndex: NonNegativeInt.make(1),
        threadId: ThreadId.make(epicRunIterationThreadId({ runId, iterationIndex: 1 })),
        turnStatus: "running",
        failureReason: null,
        finishedAt: null,
      });

      const second = fixture({
        journal,
        attempts: [{ commit: true, close: true }],
        config: restartConfig,
      });
      assert.equal((yield* second.run()).status, "done");

      const rows = yield* journal.listIterations(runId);
      assert.deepEqual(
        rows.map((row) => [row.iterationIndex, row.turnStatus, row.failureReason]),
        [
          [0, "failed", "child:blocked"],
          [1, "abandoned", "process-restart"],
          [2, "completed", null],
        ],
      );
      assert.deepEqual(
        second.events
          .filter((event) => event.type === "iteration-state-changed")
          .map((event) => [event.iteration.iterationIndex, event.iteration.turnStatus]),
        [
          [1, "abandoned"],
          [2, "running"],
          [2, "completed"],
        ],
      );
    }),
  ),
);

it.live("refuses to restart a run id under another epic", () =>
  withRealJournal((journal) =>
    Effect.gen(function* () {
      const first = fixture({
        journal,
        attempts: [{ claim: true, blocked: true }],
        config: restartConfig,
      });
      assert.equal((yield* first.run()).status, "failed");

      const other = fixture({
        journal,
        epicId: "other-epic",
        attempts: [{ commit: true, close: true }],
        config: restartConfig,
      });
      const refused = yield* Effect.result(other.run());

      assert.equal(refused._tag, "Failure");
      assert.equal(other.dispatches(), 0);
      assert.lengthOf(yield* journal.listIterations(EpicRunId.make("run")), 1);
    }),
  ),
);

it.live("refuses to restart a finished run, and leaves its record alone", () =>
  withRealJournal((journal) =>
    Effect.gen(function* () {
      const first = fixture({
        journal,
        attempts: [{ commit: true, close: true }],
        config: restartConfig,
      });
      assert.equal((yield* first.run()).status, "done");

      const second = fixture({
        journal,
        attempts: [{ commit: true, close: true }],
        config: restartConfig,
      });
      const refused = yield* Effect.result(second.run());

      assert.equal(refused._tag, "Failure");
      assert.equal(
        refused._tag === "Failure" && refused.failure._tag === "SequentialEpicLoopError"
          ? refused.failure.operation
          : null,
        "resume",
      );
      assert.equal(second.dispatches(), 0);
      // A run this process was not allowed to adopt keeps its own verdict.
      const record = yield* journal.getRun(EpicRunId.make("run"));
      assert.equal(Option.isSome(record) ? record.value.status : null, "done");
      assert.lengthOf(yield* journal.listIterations(EpicRunId.make("run")), 1);
    }),
  ),
);
