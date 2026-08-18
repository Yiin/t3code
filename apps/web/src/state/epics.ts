import { createEpicsEnvironmentAtoms } from "@t3tools/client-runtime/state/epics";
import { parseEpicRunIterationThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import type { EnvironmentId, EpicRun } from "@t3tools/contracts";

export const epicsEnvironment = createEpicsEnvironmentAtoms(connectionAtomRuntime);

export function isRunActiveForThread(
  runs: ReadonlyArray<EpicRun> | null,
  threadId: string,
): boolean {
  return runs?.some((run) => run.status === "running" && run.currentThreadId === threadId) ?? false;
}

/**
 * The iteration a runner is holding open on a thread.
 *
 * This is the client mirror of the server gate in
 * `apps/server/src/orchestration/epicIterationOwnership.ts`, and it answers the
 * same question from the same fact: an `epic_run_iterations` row for this
 * thread whose turn is still `running`. That row reaches the client on the run
 * subscription already, so nothing extra is read.
 *
 * The mirror can only ever be behind, never ahead: a thread the client has no
 * run for reads as unowned and the command still goes out, and the server
 * refuses it exactly as it does today. So this drives presentation — what to
 * disable and what to say — and never replaces the gate.
 */
export interface RunnerOwnedIteration {
  readonly runId: string;
  readonly epicId: string;
  readonly projectId: string;
  readonly iterationIndex: number;
  /** The child issue the iteration is working, when its row names one. */
  readonly issueId: string | null;
}

export function runnerOwnedIterationForThread(
  runs: ReadonlyArray<EpicRun> | null,
  threadId: string,
): RunnerOwnedIteration | null {
  const parsed = parseEpicRunIterationThreadId(threadId);
  if (parsed === null || runs === null) return null;
  const run = runs.find((candidate) => candidate.runId === parsed.runId);
  if (run === undefined) return null;
  const iteration = run.recentIterations.find(
    (candidate) =>
      candidate.iterationIndex === parsed.iterationIndex && candidate.turnStatus === "running",
  );
  if (iteration === undefined) return null;
  return {
    runId: run.runId,
    epicId: run.epicId,
    projectId: run.projectId,
    iterationIndex: parsed.iterationIndex,
    issueId: iteration.issueId,
  };
}

/** The one wording every surface reuses, so the refusal reads the same everywhere. */
export interface RunnerOwnedIterationNotice {
  readonly title: string;
  readonly description: string;
}

export function describeRunnerOwnedIteration(
  owned: RunnerOwnedIteration,
): RunnerOwnedIterationNotice {
  const work = owned.issueId ?? `iteration ${String(owned.iterationIndex)}`;
  return {
    title: `Epic run ${owned.epicId} owns this thread`,
    description: `A worker is running ${work}. Sending, stopping, reverting, archiving and deleting stay off until the run finishes this iteration. Approvals, answers and subagent controls still work.`,
  };
}

/**
 * The runs already merged for an environment, read without rendering.
 *
 * For action handlers that get a thread ref rather than a subscription. The
 * atom family carries an idle TTL, so a read for an environment nothing is
 * showing releases itself.
 */
export function readEpicRuns(environmentId: EnvironmentId): ReadonlyArray<EpicRun> | null {
  const result = appAtomRegistry.get(epicsEnvironment.allRuns({ environmentId, input: {} }));
  return Option.getOrNull(AsyncResult.value(result));
}

export function countUnreadEpicRuns(
  runsByEnvironment: ReadonlyArray<ReadonlyArray<EpicRun> | null>,
  lastVisitedAt: string | null,
): number {
  const visitedAtMs = lastVisitedAt === null ? Number.NEGATIVE_INFINITY : Date.parse(lastVisitedAt);
  const threshold = Number.isFinite(visitedAtMs) ? visitedAtMs : Number.NEGATIVE_INFINITY;
  return runsByEnvironment.reduce(
    (count, runs) =>
      count +
      (runs?.filter((run) => {
        if (run.status !== "done" && run.status !== "failed") return false;
        const updatedAtMs = Date.parse(run.updatedAt);
        return Number.isFinite(updatedAtMs) && updatedAtMs > threshold;
      }).length ?? 0),
    0,
  );
}
