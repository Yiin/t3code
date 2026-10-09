import { assert, describe, it } from "@effect/vitest";
import {
  NodeId,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2TurnItem,
  ProviderDriverKind,
  RunAttemptId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import type { ProviderAdapterV2Event } from "@t3tools/provider-core/server/ProviderAdapter";
import * as ConfigProvider from "effect/ConfigProvider";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as Scheduler from "../scheduling/Scheduler.ts";
import { OrchestratorDispatchError } from "./Orchestrator.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as TurnSilenceWatchdog from "./TurnSilenceWatchdog.ts";

const threadId = ThreadId.make("thread:turn-silence");
const runId = RunId.make("run:turn-silence");
const attemptId = RunAttemptId.make("run-attempt:turn-silence");
const driver = ProviderDriverKind.make("codex");
const epoch = DateTime.makeUnsafe(0);

const commandItem = (status: OrchestrationV2TurnItem["status"]): ProviderAdapterV2Event => ({
  type: "turn_item.updated",
  driver,
  turnItem: {
    type: "command_execution",
    id: TurnItemId.make("turn-item:turn-silence:bash"),
    threadId,
    runId,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status,
    title: null,
    startedAt: epoch,
    completedAt: null,
    updatedAt: epoch,
    input: "vp test run",
  },
});

const runtimeRequest = (status: "pending" | "resolved"): ProviderAdapterV2Event => ({
  type: "runtime_request.updated",
  driver,
  runtimeRequest: {
    id: RuntimeRequestId.make("runtime-request:turn-silence"),
    nodeId: NodeId.make("node:turn-silence"),
    providerTurnId: null,
    nativeRequestRef: null,
    kind: "user_input",
    status,
    responseCapability: { type: "message" },
    createdAt: epoch,
    resolvedAt: null,
  },
});

const harness = (input: {
  readonly env?: Record<string, string>;
  readonly failDispatches?: number;
}) => {
  const dispatched: Array<OrchestrationV2ServerCommand> = [];
  let failuresLeft = input.failDispatches ?? 0;
  const threads = Layer.mock(ThreadManagementService.ThreadManagementService)({
    dispatch: (command) => {
      dispatched.push(command);
      if (failuresLeft > 0) {
        failuresLeft -= 1;
        return Effect.fail(
          new OrchestratorDispatchError({
            commandId: command.commandId,
            commandType: command.type,
            cause: "simulated dispatch failure",
          }),
        );
      }
      return Effect.succeed({ sequence: 1, storedEvents: [] });
    },
  });
  const layer = TurnSilenceWatchdog.layer.pipe(
    Layer.provideMerge(TurnSilenceWatchdog.layerTurnActivity),
    Layer.provide(Scheduler.layer),
    Layer.provide(threads),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: input.env ?? {} }))),
  );
  return { dispatched, layer };
};

// Scheduler ticks fork the sweep; let it run before asserting.
const advance = (duration: Parameters<typeof TestClock.adjust>[0]) =>
  TestClock.adjust(duration).pipe(Effect.andThen(Effect.repeat(Effect.yieldNow, { times: 20 })));

const beginTurn = Effect.gen(function* () {
  const activity = yield* TurnSilenceWatchdog.TurnActivity;
  yield* activity.begin({ threadId, runId, attemptId });
  return activity;
});

describe("TurnSilenceWatchdog", () => {
  it.effect("interrupts a silent turn once, with the reason in the command", () => {
    const { dispatched, layer } = harness({});
    return Effect.gen(function* () {
      yield* beginTurn;
      yield* advance("29 minutes");
      assert.lengthOf(dispatched, 0);

      yield* advance("1 minute");
      assert.lengthOf(dispatched, 1);
      const command = dispatched[0];
      assert.equal(command?.type, "run.interrupt");
      if (command?.type === "run.interrupt") {
        assert.equal(command.threadId, threadId);
        assert.equal(command.runId, runId);
        assert.equal(command.reason, "Turn stopped: no provider activity for 30 minutes");
        assert.isUndefined(command.holdQueue);
      }

      yield* advance("2 hours");
      assert.lengthOf(dispatched, 1);
    }).pipe(Effect.provide(layer.pipe(Layer.provideMerge(TestClock.layer()))));
  });

  it.effect("counts every provider event as activity", () => {
    const { dispatched, layer } = harness({});
    return Effect.gen(function* () {
      const activity = yield* beginTurn;
      for (let index = 0; index < 4; index++) {
        yield* advance("20 minutes");
        yield* activity.observe(attemptId, commandItem("completed"));
      }
      assert.lengthOf(dispatched, 0);
    }).pipe(Effect.provide(layer.pipe(Layer.provideMerge(TestClock.layer()))));
  });

  it.effect("gives an open tool call the longer limit", () => {
    const { dispatched, layer } = harness({});
    return Effect.gen(function* () {
      const activity = yield* beginTurn;
      yield* activity.observe(attemptId, commandItem("running"));
      yield* advance("119 minutes");
      assert.lengthOf(dispatched, 0);

      yield* advance("1 minute");
      assert.lengthOf(dispatched, 1);
      const command = dispatched[0];
      assert.equal(
        command?.type === "run.interrupt" ? command.reason : undefined,
        "Turn stopped: no provider activity for 2 hours while a tool call was open",
      );
    }).pipe(Effect.provide(layer.pipe(Layer.provideMerge(TestClock.layer()))));
  });

  it.effect("never stops a turn that waits on the user", () => {
    const { dispatched, layer } = harness({});
    return Effect.gen(function* () {
      const activity = yield* beginTurn;
      yield* activity.observe(attemptId, runtimeRequest("pending"));
      yield* advance("5 hours");
      assert.lengthOf(dispatched, 0);

      // The answer restarts the clock.
      yield* activity.observe(attemptId, runtimeRequest("resolved"));
      yield* advance("29 minutes");
      assert.lengthOf(dispatched, 0);
      yield* advance("1 minute");
      assert.lengthOf(dispatched, 1);
    }).pipe(Effect.provide(layer.pipe(Layer.provideMerge(TestClock.layer()))));
  });

  it.effect("stops watching a turn that ended or was replaced by a newer attempt", () => {
    const { dispatched, layer } = harness({});
    return Effect.gen(function* () {
      const activity = yield* beginTurn;
      yield* activity.end(attemptId);
      yield* advance("1 hour");
      assert.lengthOf(dispatched, 0);

      const newerAttemptId = RunAttemptId.make("run-attempt:turn-silence:newer");
      yield* activity.begin({ threadId, runId, attemptId });
      yield* advance("20 minutes");
      yield* activity.begin({ threadId, runId, attemptId: newerAttemptId });
      yield* advance("20 minutes");
      assert.lengthOf(dispatched, 0);
      yield* advance("10 minutes");
      assert.lengthOf(dispatched, 1);
    }).pipe(Effect.provide(layer.pipe(Layer.provideMerge(TestClock.layer()))));
  });

  it.effect("retries a failed interrupt after another silent window", () => {
    const { dispatched, layer } = harness({ failDispatches: 1 });
    return Effect.gen(function* () {
      yield* beginTurn;
      yield* advance("30 minutes");
      assert.lengthOf(dispatched, 1);
      yield* advance("29 minutes");
      assert.lengthOf(dispatched, 1);
      yield* advance("1 minute");
      assert.lengthOf(dispatched, 2);
      assert.notEqual(dispatched[0]?.commandId, dispatched[1]?.commandId);
    }).pipe(Effect.provide(layer.pipe(Layer.provideMerge(TestClock.layer()))));
  });

  it.effect("reads its limits from the environment", () => {
    const { dispatched, layer } = harness({
      env: { T3CODE_TURN_SILENCE_TIMEOUT_MS: "60000" },
    });
    return Effect.gen(function* () {
      yield* beginTurn;
      yield* advance("1 minute");
      assert.lengthOf(dispatched, 1);
      const command = dispatched[0];
      assert.equal(
        command?.type === "run.interrupt" ? command.reason : undefined,
        "Turn stopped: no provider activity for 1 minute",
      );
    }).pipe(Effect.provide(layer.pipe(Layer.provideMerge(TestClock.layer()))));
  });

  it.effect("is off when the silence timeout is 0", () => {
    const { dispatched, layer } = harness({ env: { T3CODE_TURN_SILENCE_TIMEOUT_MS: "0" } });
    return Effect.gen(function* () {
      yield* beginTurn;
      yield* advance("10 hours");
      assert.lengthOf(dispatched, 0);
    }).pipe(Effect.provide(layer.pipe(Layer.provideMerge(TestClock.layer()))));
  });
});
