import { createEpicsEnvironmentAtoms } from "@t3tools/client-runtime/state/epics";

import { connectionAtomRuntime } from "../connection/runtime";
import type { EpicRun } from "@t3tools/contracts";

export const epicsEnvironment = createEpicsEnvironmentAtoms(connectionAtomRuntime);

export function isRunActiveForThread(
  runs: ReadonlyArray<EpicRun> | null,
  threadId: string,
): boolean {
  return runs?.some((run) => run.status === "running" && run.currentThreadId === threadId) ?? false;
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
