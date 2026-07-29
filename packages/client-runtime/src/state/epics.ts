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
  epicId: string,
): EpicRun | null {
  return candidates.reduce<EpicRun | null>((latest, candidate) => {
    if (candidate.epicId !== epicId) {
      return latest;
    }
    if (latest === null || candidate.updatedAt > latest.updatedAt) {
      return candidate;
    }
    return latest;
  }, current);
}

export function epicRunChanges(epicId: string) {
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
        );
        const live = subscribe(WS_METHODS.subscribeEpicRuns, {}).pipe(
          Stream.map((event) => [event.run]),
        );
        return Stream.merge(seeds, live).pipe(
          Stream.mapAccum(
            () => null as EpicRun | null,
            (current, runs) => {
              const next = latestEpicRun(current, runs, epicId);
              return next === null || next === current
                ? ([current, []] as const)
                : ([next, [next]] as const);
            },
          ),
        );
      }),
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
      subscribe: (input: { readonly epicId: string }) => epicRunChanges(input.epicId),
    }),
    startRun: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:epics:start-run",
      tag: WS_METHODS.epicRunStart,
    }),
    stopRun: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:epics:stop-run",
      tag: WS_METHODS.epicRunCancel,
    }),
  };
}
