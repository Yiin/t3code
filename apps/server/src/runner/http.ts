import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
  EnvironmentHttpConflictError,
} from "@t3tools/contracts";
import type { EpicRunnerError } from "@t3tools/epic-core/Errors";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  failEnvironmentNotFound,
  requireEnvironmentScope,
} from "../auth/http.ts";
import { EpicRunner } from "./Services/EpicRunner.ts";

const mapRunnerError = <A, R>(effect: Effect.Effect<A, EpicRunnerError, R>) =>
  effect.pipe(
    Effect.catchTags({
      EpicRunNotFoundError: () => failEnvironmentNotFound("epic_run_not_found"),
      EpicRunStateError: (error) =>
        Effect.fail(new EnvironmentHttpConflictError({ message: error.message })),
      EpicRunPreflightBlockedError: (error) =>
        Effect.fail(new EnvironmentHttpConflictError({ message: error.message })),
      EpicRunLaunchError: (error) =>
        Effect.fail(new EnvironmentHttpConflictError({ message: error.message })),
      EpicRunnerStoreError: (error) => failEnvironmentInternal("internal_error", error),
      EpicRunnerDispatchError: (error) => failEnvironmentInternal("internal_error", error),
    }),
  );

export const epicRunsHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "epicRuns",
  Effect.fnUntraced(function* (handlers) {
    const runner = yield* EpicRunner;
    const read = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      requireEnvironmentScope(AuthOrchestrationReadScope).pipe(Effect.andThen(effect));
    const operate = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      requireEnvironmentScope(AuthOrchestrationOperateScope).pipe(Effect.andThen(effect));

    return handlers
      .handle(
        "launch",
        Effect.fn("environment.epicRuns.launch")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          return yield* operate(mapRunnerError(runner.launchRun(args.payload)));
        }),
      )
      .handle(
        "start",
        Effect.fn("environment.epicRuns.start")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          return yield* operate(mapRunnerError(runner.startRun(args.payload)));
        }),
      )
      .handle(
        "list",
        Effect.fn("environment.epicRuns.list")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          return yield* read(mapRunnerError(runner.listRuns(args.payload)));
        }),
      )
      .handle(
        "get",
        Effect.fn("environment.epicRuns.get")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const run = yield* read(mapRunnerError(runner.getRun(args.params)));
          return Option.isSome(run)
            ? run.value
            : yield* failEnvironmentNotFound("epic_run_not_found");
        }),
      )
      .handle(
        "pause",
        Effect.fn("environment.epicRuns.pause")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          return yield* operate(mapRunnerError(runner.pauseRun(args.params)));
        }),
      )
      .handle(
        "resume",
        Effect.fn("environment.epicRuns.resume")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          return yield* operate(mapRunnerError(runner.resumeRun(args.params)));
        }),
      )
      .handle(
        "cancel",
        Effect.fn("environment.epicRuns.cancel")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          return yield* operate(mapRunnerError(runner.cancelRun(args.params)));
        }),
      );
  }),
);
