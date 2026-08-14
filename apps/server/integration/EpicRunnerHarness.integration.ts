import {
  MessageId,
  ProjectId,
  ProviderInstanceId,
  type OrchestrationSessionStatus,
  type OrchestrationThread,
  type ProjectionThreadTurnStatus,
  ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type {
  EpicRun,
  EpicRunGateReceipt,
  EpicRunLandingEffects,
  EpicRunIteration,
  EpicRunMergeState,
  EpicRunStoreShape,
} from "../src/persistence/Services/EpicRuns.ts";

const projectId = ProjectId.make("project-epic-runner");
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5-codex",
} as const;
const NOW = "2026-01-01T00:00:00.000Z";

export const makeThreadDetail = (input: {
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly turnState: ProjectionThreadTurnStatus;
  readonly text: string | null;
  readonly streaming: boolean;
  readonly latestTurnPointerNull?: boolean;
  readonly sessionStatus?: OrchestrationSessionStatus;
  readonly sessionLastError?: string | undefined;
}): OrchestrationThread => {
  const messageId = MessageId.make(`${input.threadId}-assistant`);
  return {
    id: input.threadId,
    projectId,
    title: "Epic iteration",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: input.latestTurnPointerNull
      ? null
      : {
          turnId: input.turnId,
          state: input.turnState,
          requestedAt: NOW,
          startedAt: NOW,
          completedAt: NOW,
          assistantMessageId: input.text === null ? null : messageId,
        },
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    parentThreadId: null,
    messages:
      input.text === null
        ? []
        : [
            {
              id: messageId,
              role: "assistant",
              text: input.text,
              turnId: input.turnId,
              streaming: input.streaming,
              createdAt: NOW,
              updatedAt: NOW,
            },
          ],
    proposedPlans: [],
    subagents: [],
    activities: [],
    checkpoints: [],
    session:
      input.sessionStatus === undefined
        ? null
        : {
            threadId: input.threadId,
            status: input.sessionStatus,
            providerName: "claudeAgent",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: input.sessionLastError ?? null,
            updatedAt: NOW,
          },
  };
};

export const makeMemoryStore = (upsertDelayMs = 0, appendIterationDelayMs = 0) => {
  const runs = new Map<string, EpicRun>();
  const iterations: EpicRunIteration[] = [];
  const degradations = new Map<
    string,
    import("../src/persistence/Services/EpicRuns.ts").EpicProviderDegradation
  >();
  const mergeStates = new Map<string, EpicRunMergeState>();
  const landingEffects = new Map<string, EpicRunLandingEffects[]>();
  const iterationWrites: Array<{
    readonly method: "append" | "update";
    readonly turnStatus: EpicRunIteration["turnStatus"];
  }> = [];
  const iterationReadCounts = { perRun: 0, batched: 0 };
  const gateReceipts: Array<EpicRunGateReceipt> = [];

  const shape: EpicRunStoreShape = {
    upsertRun: (run) => {
      const save = Effect.sync(() => void runs.set(run.runId, run));
      return upsertDelayMs === 0
        ? save
        : Effect.sleep(`${upsertDelayMs} millis`).pipe(Effect.flatMap(() => save));
    },
    getRun: ({ runId }) =>
      Effect.sync(() => {
        const run = runs.get(runId);
        return run === undefined ? Option.none() : Option.some(run);
      }),
    listRuns: ({ status, limit, orderBy }) =>
      Effect.sync(() => {
        const matching = [...runs.values()]
          .filter((run) => status === undefined || run.status === status)
          .sort((left, right) =>
            orderBy === "updatedAt-desc"
              ? right.updatedAt.localeCompare(left.updatedAt) ||
                right.runId.localeCompare(left.runId)
              : left.createdAt.localeCompare(right.createdAt) ||
                left.runId.localeCompare(right.runId),
          );
        return limit === undefined ? matching : matching.slice(0, limit);
      }),
    appendIteration: (iteration) => {
      const append = Effect.sync(() => {
        iterationWrites.push({ method: "append", turnStatus: iteration.turnStatus });
        iterations.push(iteration);
      });
      return appendIterationDelayMs === 0
        ? append
        : append.pipe(Effect.andThen(Effect.sleep(`${appendIterationDelayMs} millis`)));
    },
    allocateIteration: (input) => {
      const append = Effect.sync(() => {
        const iterationIndex = iterations.reduce(
          (next, iteration) =>
            iteration.runId === input.runId ? Math.max(next, iteration.iterationIndex + 1) : next,
          0,
        );
        const threadId = ThreadId.make(`epic-run-${input.runId}-${iterationIndex}`);
        iterationWrites.push({ method: "append", turnStatus: "running" });
        iterations.push({
          ...input,
          iterationIndex,
          threadId,
          workerId: threadId,
          turnStatus: "running",
          summary: null,
          why: null,
          failureReason: null,
          finishedAt: null,
        });
        return iterationIndex;
      });
      return appendIterationDelayMs === 0
        ? append
        : append.pipe(Effect.tap(() => Effect.sleep(`${appendIterationDelayMs} millis`)));
    },
    updateIteration: (input) =>
      Effect.sync(() => {
        iterationWrites.push({ method: "update", turnStatus: input.turnStatus });
        const index = iterations.findIndex(
          (iteration) =>
            iteration.runId === input.runId && iteration.iterationIndex === input.iterationIndex,
        );
        if (index === -1) return;
        iterations[index] = {
          ...iterations[index]!,
          turnStatus: input.turnStatus,
          summary: input.summary,
          why: input.why,
          failureReason: input.failureReason,
          finishedAt: input.finishedAt,
        };
      }),
    reopenIteration: (input) =>
      Effect.sync(() => {
        const index = iterations.findIndex(
          (iteration) =>
            iteration.runId === input.runId && iteration.iterationIndex === input.iterationIndex,
        );
        if (index === -1) return;
        const current = iterations[index]!;
        iterationWrites.push({ method: "update", turnStatus: "running" });
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
      }),
    listIterations: ({ runId }) =>
      Effect.sync(() => {
        iterationReadCounts.perRun += 1;
        return iterations.filter((iteration) => iteration.runId === runId);
      }),
    listRunningIterations: ({ runId }) =>
      Effect.sync(() =>
        iterations.filter(
          (iteration) => iteration.runId === runId && iteration.turnStatus === "running",
        ),
      ),
    listRecentIterationsForRuns: ({ runIds, limitPerRun }) =>
      Effect.sync(() => {
        iterationReadCounts.batched += 1;
        const wanted = new Set<string>(runIds);
        return [...wanted]
          .sort((left, right) => left.localeCompare(right))
          .flatMap((runId) =>
            iterations
              .filter((iteration) => iteration.runId === runId)
              .sort((left, right) => left.iterationIndex - right.iterationIndex)
              .slice(-limitPerRun),
          );
      }),
    getLatestIteration: ({ runId }) =>
      Effect.sync(() => {
        const found = iterations.filter((iteration) => iteration.runId === runId);
        return found.length === 0 ? Option.none() : Option.some(found[found.length - 1]!);
      }),
    recordGateReceipt: (receipt) =>
      Effect.sync(() => {
        gateReceipts.push({ ...receipt, sequence: gateReceipts.length });
      }),
    listGateReceipts: ({ runId }) =>
      Effect.sync(() => gateReceipts.filter((receipt) => receipt.runId === runId)),
    upsertProviderDegradation: (value) =>
      Effect.sync(() => void degradations.set(value.providerInstanceId, value)),
    getProviderDegradation: ({ providerInstanceId }) =>
      Effect.sync(() => {
        const value = degradations.get(providerInstanceId);
        return value === undefined ? Option.none() : Option.some(value);
      }),
    clearProviderDegradation: ({ providerInstanceId }) =>
      Effect.sync(() => void degradations.delete(providerInstanceId)),
    clearExpiredProviderDegradation: ({ providerInstanceId, cutoff, now }) =>
      Effect.sync(() => {
        const value = degradations.get(providerInstanceId);
        if (value === undefined) return;
        // Mirrors the store's SQL: a reset time decides on its own clock,
        // and only a row without one expires by the TTL cutoff.
        const expired =
          value.resetsAt !== null ? value.resetsAt <= now : value.degradedAt <= cutoff;
        if (expired) degradations.delete(providerInstanceId);
      }),
    initializeMergeState: (input) =>
      Effect.sync(() => {
        if (!mergeStates.has(input.runId)) {
          mergeStates.set(input.runId, {
            ...input,
            operatorBaseBranch: input.operatorBaseBranch ?? null,
            initialHead: input.lastAcceptedHead,
            parkedCount: 0,
            entries: [],
          });
        }
      }),
    getMergeState: ({ runId }) => Effect.sync(() => Option.fromNullishOr(mergeStates.get(runId))),
    enqueueMerge: ({ runId, childId, branch }) =>
      Effect.sync(() => {
        const state = mergeStates.get(runId);
        if (state === undefined) return;
        const active = state.entries.find(
          (row) => row.branch === branch && (row.status === "queued" || row.status === "draining"),
        );
        if (active !== undefined) return;
        const nextEntries = [
          ...state.entries,
          {
            runId,
            sequence: Math.max(-1, ...state.entries.map((row) => row.sequence)) + 1,
            childId,
            branch,
            status: "queued" as const,
            reason: null,
            fixIssueId: null,
          },
        ];
        mergeStates.set(runId, { ...state, entries: nextEntries });
      }),
    beginMergeDrain: ({ runId }) =>
      Effect.sync(() => {
        const state = mergeStates.get(runId);
        if (state === undefined) return [];
        const entries = state.entries.map((row) =>
          row.status === "queued" ? { ...row, status: "draining" as const } : row,
        );
        mergeStates.set(runId, { ...state, entries });
        return entries.filter((row) => row.status === "draining");
      }),
    restoreMergeTail: ({ runId, fromSequence }) =>
      Effect.sync(() => {
        const state = mergeStates.get(runId);
        if (state === undefined) return;
        mergeStates.set(runId, {
          ...state,
          entries: state.entries.map((row) =>
            row.sequence >= fromSequence && row.status === "draining"
              ? { ...row, status: "queued" as const }
              : row,
          ),
        });
      }),
    advanceMergeIntegration: ({ runId, lastAcceptedHead }) =>
      Effect.sync(() => {
        const state = mergeStates.get(runId);
        if (state === undefined) return;
        mergeStates.set(runId, { ...state, lastAcceptedHead });
      }),
    beginParkMerge: ({ runId, sequence, reason }) =>
      Effect.sync(() => {
        const state = mergeStates.get(runId);
        if (state === undefined) return;
        mergeStates.set(runId, {
          ...state,
          parkedCount: state.parkedCount + 1,
          entries: state.entries.map((row) =>
            row.sequence === sequence
              ? { ...row, status: "parked" as const, reason, fixIssueId: null }
              : row,
          ),
        });
      }),
    finalizeParkMerge: ({ runId, sequence, fixIssueId }) =>
      Effect.sync(() => {
        const state = mergeStates.get(runId);
        if (state === undefined) return;
        mergeStates.set(runId, {
          ...state,
          entries: state.entries.map((row) =>
            row.sequence === sequence ? { ...row, fixIssueId } : row,
          ),
        });
      }),
    completeMerge: ({ runId, sequence, lastAcceptedHead }) =>
      Effect.sync(() => {
        const state = mergeStates.get(runId);
        if (state === undefined) return;
        const branch = state.entries.find((row) => row.sequence === sequence)?.branch;
        mergeStates.set(runId, {
          ...state,
          lastAcceptedHead,
          entries: state.entries.filter((row) => row.branch !== branch),
        });
      }),
    dropMerge: ({ runId, sequence }) =>
      Effect.sync(() => {
        const state = mergeStates.get(runId);
        if (state === undefined) return;
        mergeStates.set(runId, {
          ...state,
          entries: state.entries.filter((row) => row.sequence !== sequence),
        });
      }),
    findParkedOriginalChild: ({ runId, branch }) =>
      Effect.sync(() =>
        Option.fromNullishOr(
          mergeStates
            .get(runId)
            ?.entries.find((row) => row.branch === branch && row.status === "parked")?.childId,
        ),
      ),
    upsertLandingEffects: (input) =>
      Effect.sync(() => {
        const rows = landingEffects.get(input.runId) ?? [];
        landingEffects.set(input.runId, [
          ...rows.filter((row) => row.repositoryPath !== input.repositoryPath),
          input,
        ]);
      }),
    getLandingEffects: ({ runId }) =>
      Effect.sync(() =>
        // Match the SQL layer's binary ORDER BY repository_path ASC.
        (landingEffects.get(runId) ?? []).toSorted((left, right) =>
          left.repositoryPath < right.repositoryPath
            ? -1
            : left.repositoryPath > right.repositoryPath
              ? 1
              : 0,
        ),
      ),
    deleteMergeState: ({ runId }) => Effect.sync(() => void mergeStates.delete(runId)),
  };

  return {
    shape,
    runs,
    iterations,
    degradations,
    mergeStates,
    landingEffects,
    iterationReadCounts,
    iterationWrites,
  };
};
