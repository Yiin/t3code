import {
  MessageId,
  ProjectId,
  ProviderInstanceId,
  type OrchestrationSessionStatus,
  type OrchestrationThread,
  type ProjectionThreadTurnStatus,
  type ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type {
  EpicRun,
  EpicRunIteration,
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
  const iterationWrites: Array<{
    readonly method: "append" | "update";
    readonly turnStatus: EpicRunIteration["turnStatus"];
  }> = [];
  const iterationReadCounts = { perRun: 0, batched: 0 };

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
    listIterations: ({ runId }) =>
      Effect.sync(() => {
        iterationReadCounts.perRun += 1;
        return iterations.filter((iteration) => iteration.runId === runId);
      }),
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
    upsertProviderDegradation: (value) =>
      Effect.sync(() => void degradations.set(value.providerInstanceId, value)),
    getProviderDegradation: ({ providerInstanceId }) =>
      Effect.sync(() => {
        const value = degradations.get(providerInstanceId);
        return value === undefined ? Option.none() : Option.some(value);
      }),
    clearProviderDegradation: ({ providerInstanceId }) =>
      Effect.sync(() => void degradations.delete(providerInstanceId)),
    clearExpiredProviderDegradation: ({ providerInstanceId, cutoff }) =>
      Effect.sync(() => {
        const value = degradations.get(providerInstanceId);
        if (value !== undefined && value.degradedAt <= cutoff)
          degradations.delete(providerInstanceId);
      }),
  };

  return { shape, runs, iterations, degradations, iterationReadCounts, iterationWrites };
};
