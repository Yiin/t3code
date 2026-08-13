import { parseEpicRunIterationThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { useMemo } from "react";

import {
  epicsEnvironment,
  runnerOwnedIterationForThread,
  type RunnerOwnedIteration,
} from "../state/epics";
import { useEnvironmentQuery } from "../state/query";

/**
 * The iteration an epic run is holding open on this thread, or `null`.
 *
 * Subscribes only for threads whose id was built by the runner, so an ordinary
 * chat thread costs nothing: the id shape is the cheap pre-filter the server
 * gate uses too. The `allRuns` subscription is one per environment and is
 * already mounted by the sidebar, so a run's own iteration thread adds no
 * second stream.
 */
export function useRunnerOwnedIteration(ref: ScopedThreadRef | null): RunnerOwnedIteration | null {
  const iterationRef =
    ref !== null && parseEpicRunIterationThreadId(ref.threadId) !== null ? ref : null;
  const runs = useEnvironmentQuery(
    iterationRef === null
      ? null
      : epicsEnvironment.allRuns({ environmentId: iterationRef.environmentId, input: {} }),
  );
  const runsData = runs.data;
  return useMemo(
    () =>
      iterationRef === null ? null : runnerOwnedIterationForThread(runsData, iterationRef.threadId),
    [iterationRef, runsData],
  );
}
