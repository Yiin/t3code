import { type BeadsStatusInput, type EpicRun, WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { isRpcClientTransportFailure, requestInSession, subscribe } from "../rpc/client.ts";
import { createEnvironmentRpcCommand, createEnvironmentSubscriptionAtomFamily } from "./runtime.ts";

export function latestEpicRun(
  current: EpicRun | null,
  candidates: ReadonlyArray<EpicRun>,
  identity: { readonly epicId: string; readonly projectId: string; readonly cwd: string },
): EpicRun | null {
  const currentForIdentity =
    current?.epicId === identity.epicId &&
    current.projectId === identity.projectId &&
    current.cwd === identity.cwd
      ? current
      : null;
  return candidates.reduce<EpicRun | null>((latest, candidate) => {
    if (
      candidate.epicId !== identity.epicId ||
      candidate.projectId !== identity.projectId ||
      candidate.cwd !== identity.cwd
    ) {
      return latest;
    }
    if (
      latest === null ||
      candidate.updatedAt > latest.updatedAt ||
      (candidate.updatedAt === latest.updatedAt && candidate.runId > latest.runId)
    ) {
      return candidate;
    }
    return latest;
  }, currentForIdentity);
}

function compareCanonicalRuns(left: EpicRun, right: EpicRun): number {
  return left.runId.localeCompare(right.runId);
}

export function mergeEpicRuns(
  current: ReadonlyArray<EpicRun>,
  candidates: ReadonlyArray<EpicRun>,
): ReadonlyArray<EpicRun> {
  const byId = new Map(current.map((run) => [run.runId, run]));
  let changed = false;
  for (const candidate of candidates) {
    const existing = byId.get(candidate.runId);
    if (existing === undefined || candidate.updatedAt > existing.updatedAt) {
      byId.set(candidate.runId, candidate);
      changed = true;
    }
  }
  return changed ? [...byId.values()].sort(compareCanonicalRuns) : current;
}

/** Where a run in the collection came from: the seed fetch or the live stream. */
type RunSource = "seed" | "live";

type RunBatch = {
  readonly source: RunSource;
  readonly runs: ReadonlyArray<EpicRun>;
};

/** The merged run collection plus the source that last wrote each run. */
interface RunCollection {
  readonly runs: ReadonlyArray<EpicRun>;
  readonly provenance: ReadonlyMap<string, RunSource>;
}

/** `RunCollection` plus whether the stream has emitted its first value. */
interface RunCollectionAccumulator extends RunCollection {
  readonly initialized: boolean;
}

/** The latest run for one identity, plus the first-emission flag. */
interface LatestRunAccumulator {
  readonly initialized: boolean;
  readonly run: EpicRun | null;
}

function mergeEpicRunBatch(
  current: ReadonlyArray<EpicRun>,
  provenance: ReadonlyMap<string, RunSource>,
  batch: RunBatch,
): RunCollection {
  const byId = new Map(current.map((run) => [run.runId, run]));
  const nextProvenance = new Map(provenance);
  let changed = false;
  for (const candidate of batch.runs) {
    const existing = byId.get(candidate.runId);
    const existingSource = nextProvenance.get(candidate.runId);
    const shouldReplace =
      existing === undefined ||
      candidate.updatedAt > existing.updatedAt ||
      (candidate.updatedAt === existing.updatedAt &&
        batch.source === "live" &&
        existingSource !== "live");
    if (shouldReplace) {
      byId.set(candidate.runId, candidate);
      nextProvenance.set(candidate.runId, batch.source);
      changed = true;
    }
  }
  return {
    runs: changed ? [...byId.values()].sort(compareCanonicalRuns) : current,
    provenance: changed ? nextProvenance : provenance,
  };
}

export function latestEpicRunForIdentity(
  runs: ReadonlyArray<EpicRun>,
  identity: {
    readonly epicId: string;
    readonly projectId: string;
    readonly cwd: string;
  },
): EpicRun | null {
  return latestEpicRun(null, runs, identity);
}

export function activeEpicRunForThread(
  runs: ReadonlyArray<EpicRun>,
  threadId: string,
): EpicRun | null {
  return runs.reduce<EpicRun | null>((latest, candidate) => {
    if (candidate.status !== "running" && candidate.status !== "paused") {
      return latest;
    }
    const referencesThread =
      candidate.currentThreadId === threadId ||
      candidate.originThreadId === threadId ||
      candidate.threadRefs.some((reference) => reference.threadId === threadId);
    if (!referencesThread) {
      return latest;
    }
    if (
      latest === null ||
      candidate.updatedAt > latest.updatedAt ||
      (candidate.updatedAt === latest.updatedAt && candidate.runId > latest.runId)
    ) {
      return candidate;
    }
    return latest;
  }, null);
}

export function epicRunCollectionChanges() {
  return Stream.unwrap(
    EnvironmentSupervisor.pipe(
      Effect.map((supervisor) => {
        const seeds = SubscriptionRef.changes(supervisor.session).pipe(
          Stream.filterMap(
            Option.match({
              onNone: () => Result.failVoid,
              onSome: Result.succeed,
            }),
          ),
          Stream.mapEffect((session) =>
            requestInSession(session, WS_METHODS.epicRunList, {}).pipe(
              Effect.catchIf(isRpcClientTransportFailure, () =>
                Effect.succeed<ReadonlyArray<EpicRun>>([]),
              ),
            ),
          ),
          Stream.map((runs): RunBatch => ({ source: "seed", runs })),
        );
        const live = subscribe(WS_METHODS.subscribeEpicRuns, {}).pipe(
          Stream.map((event): RunBatch => ({ source: "live", runs: [event.run] })),
        );
        return Stream.merge(seeds, live).pipe(
          Stream.mapAccum(
            (): RunCollectionAccumulator => ({
              initialized: false,
              runs: [],
              provenance: new Map(),
            }),
            (state, batch) => {
              const next = mergeEpicRunBatch(state.runs, state.provenance, batch);
              const nextState = { initialized: true, ...next };
              return state.initialized && next.runs === state.runs
                ? ([state, []] as const)
                : ([nextState, [next.runs]] as const);
            },
          ),
        );
      }),
    ),
  );
}

export function epicRunChanges(identity: {
  readonly epicId: string;
  readonly projectId: string;
  readonly cwd: string;
}) {
  return epicRunCollectionChanges().pipe(
    Stream.mapAccum(
      (): LatestRunAccumulator => ({ initialized: false, run: null }),
      (state, runs) => {
        const next = latestEpicRunForIdentity(runs, identity);
        const nextState = { initialized: true, run: next };
        return state.initialized && next === state.run
          ? ([state, []] as const)
          : ([nextState, [next]] as const);
      },
    ),
  );
}

export function activeEpicRunForThreadChanges(threadId: string) {
  return epicRunCollectionChanges().pipe(
    Stream.mapAccum(
      (): LatestRunAccumulator => ({ initialized: false, run: null }),
      (state, runs) => {
        const next = activeEpicRunForThread(runs, threadId);
        const nextState = { initialized: true, run: next };
        return state.initialized && next === state.run
          ? ([state, []] as const)
          : ([nextState, [next]] as const);
      },
    ),
  );
}

export function createEpicsEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    list: createEnvironmentSubscriptionAtomFamily(runtime, {
      label: "environment-data:epics:list",
      subscribe: (input: BeadsStatusInput) => subscribe(WS_METHODS.subscribeBeadsStatus, input),
    }),
    run: createEnvironmentSubscriptionAtomFamily(runtime, {
      label: "environment-data:epics:run",
      subscribe: (input: {
        readonly epicId: string;
        readonly projectId: string;
        readonly cwd: string;
      }) => epicRunChanges(input),
    }),
    latestRun: createEnvironmentSubscriptionAtomFamily(runtime, {
      label: "environment-data:epics:latest-run",
      subscribe: (input: {
        readonly epicId: string;
        readonly projectId: string;
        readonly cwd: string;
      }) => epicRunChanges(input),
    }),
    allRuns: createEnvironmentSubscriptionAtomFamily(runtime, {
      label: "environment-data:epics:all-runs",
      subscribe: (_input: Record<string, never>) => epicRunCollectionChanges(),
    }),
    activeRunForThread: createEnvironmentSubscriptionAtomFamily(runtime, {
      label: "environment-data:epics:active-run-for-thread",
      subscribe: (input: { readonly threadId: string }) =>
        activeEpicRunForThreadChanges(input.threadId),
    }),
    startRun: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:epics:start-run",
      tag: WS_METHODS.epicRunStart,
    }),
    preflightRun: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:epics:preflight-run",
      tag: WS_METHODS.epicRunPreflight,
    }),
    launchRun: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:epics:launch-run",
      tag: WS_METHODS.epicRunLaunch,
    }),
    pauseRun: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:epics:pause-run",
      tag: WS_METHODS.epicRunPause,
    }),
    resumeRun: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:epics:resume-run",
      tag: WS_METHODS.epicRunResume,
    }),
    stopRun: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:epics:stop-run",
      tag: WS_METHODS.epicRunCancel,
    }),
  };
}
