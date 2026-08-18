import { assert, describe, it } from "@effect/vitest";
import {
  ApprovalRequestId,
  CommandId,
  EpicRunId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  epicRunIterationThreadId,
  MessageId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import {
  epicIterationCommandTarget,
  makeEpicIterationOwnership,
} from "./epicIterationOwnership.ts";
import type { EpicRunIteration, EpicRunStore } from "../persistence/Services/EpicRuns.ts";
import { PersistenceSqlError, type EpicRunStoreError } from "../persistence/Errors.ts";

const now = "2026-01-01T00:00:00.000Z";
const runId = "run-a";
const iterationThreadId = ThreadId.make(epicRunIterationThreadId({ runId, iterationIndex: 1 }));
const interactiveThreadId = ThreadId.make("thread-interactive");

const runningIteration = (iterationIndex: number): EpicRunIteration => ({
  runId: EpicRunId.make(runId),
  iterationIndex,
  threadId: ThreadId.make(epicRunIterationThreadId({ runId, iterationIndex })),
  issueId: null,
  turnStatus: "running",
  summary: null,
  why: null,
  failureReason: null,
  startedAt: now,
  finishedAt: null,
});

const turnStart = (threadId: ThreadId): OrchestrationCommand => ({
  type: "thread.turn.start",
  commandId: CommandId.make("client:turn-start"),
  threadId,
  message: {
    messageId: MessageId.make(`${threadId}-client`),
    role: "user",
    text: "steer",
    attachments: [],
  },
  origin: "human",
  modelSelection: {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5-codex",
  },
  runtimeMode: DEFAULT_RUNTIME_MODE,
  interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
  createdAt: now,
});

const approvalRespond = (threadId: ThreadId): OrchestrationCommand => ({
  type: "thread.approval.respond",
  commandId: CommandId.make("client:approval"),
  threadId,
  requestId: ApprovalRequestId.make("request-1"),
  decision: "accept",
  createdAt: now,
});

/** A store whose iteration read is counted, so "never read" is assertable. */
const storeWith = (
  answer: Effect.Effect<ReadonlyArray<EpicRunIteration>, EpicRunStoreError>,
  reads: { count: number },
): EpicRunStore["Service"] =>
  ({
    listRunningIterations: () =>
      Effect.suspend(() => {
        reads.count += 1;
        return answer;
      }),
  }) as unknown as EpicRunStore["Service"];

describe("epicIterationCommandTarget", () => {
  it("names the iteration a guarded command would hit", () => {
    assert.deepStrictEqual(epicIterationCommandTarget(turnStart(iterationThreadId)), {
      threadId: iterationThreadId,
      runId,
      iterationIndex: 1,
      commandType: "thread.turn.start",
    });
  });

  it("ignores an interactive thread", () => {
    assert.strictEqual(epicIterationCommandTarget(turnStart(interactiveThreadId)), null);
  });

  it("ignores a command that changes no lifecycle", () => {
    assert.strictEqual(epicIterationCommandTarget(approvalRespond(iterationThreadId)), null);
  });
});

describe("EpicIterationOwnership.checkClientCommand", () => {
  it.effect("refuses a turn start while the iteration row is running", () => {
    const reads = { count: 0 };
    const ownership = makeEpicIterationOwnership(
      storeWith(Effect.succeed([runningIteration(1)]), reads),
    );
    return Effect.gen(function* () {
      const rejection = yield* ownership.checkClientCommand(turnStart(iterationThreadId));
      assert.deepStrictEqual(rejection, {
        threadId: iterationThreadId,
        runId,
        iterationIndex: 1,
        commandType: "thread.turn.start",
        evidence: "iteration-running",
      });
      assert.strictEqual(reads.count, 1);
    });
  });

  it.effect("allows a turn start once the iteration row has settled", () => {
    const reads = { count: 0 };
    const ownership = makeEpicIterationOwnership(storeWith(Effect.succeed([]), reads));
    return Effect.gen(function* () {
      const rejection = yield* ownership.checkClientCommand(turnStart(iterationThreadId));
      assert.strictEqual(rejection, null);
    });
  });

  it.effect("matches the iteration index exactly", () => {
    const reads = { count: 0 };
    // Iteration 11 is running; iteration 1 of the same run is not.
    const ownership = makeEpicIterationOwnership(
      storeWith(Effect.succeed([runningIteration(11)]), reads),
    );
    return Effect.gen(function* () {
      const rejection = yield* ownership.checkClientCommand(turnStart(iterationThreadId));
      assert.strictEqual(rejection, null);
    });
  });

  it.effect("leaves interactive steering alone without reading the store", () => {
    const reads = { count: 0 };
    const ownership = makeEpicIterationOwnership(
      storeWith(Effect.succeed([runningIteration(1)]), reads),
    );
    return Effect.gen(function* () {
      const rejection = yield* ownership.checkClientCommand(turnStart(interactiveThreadId));
      assert.strictEqual(rejection, null);
      assert.strictEqual(reads.count, 0);
    });
  });

  it.effect("lets a human answer an approval on a running iteration", () => {
    const reads = { count: 0 };
    const ownership = makeEpicIterationOwnership(
      storeWith(Effect.succeed([runningIteration(1)]), reads),
    );
    return Effect.gen(function* () {
      const rejection = yield* ownership.checkClientCommand(approvalRespond(iterationThreadId));
      assert.strictEqual(rejection, null);
      assert.strictEqual(reads.count, 0);
    });
  });

  it.effect("refuses rather than guesses when the durable read fails", () => {
    const reads = { count: 0 };
    const ownership = makeEpicIterationOwnership(
      storeWith(
        Effect.fail(new PersistenceSqlError({ operation: "listRunningIterations" })),
        reads,
      ),
    );
    return Effect.gen(function* () {
      const rejection = yield* ownership.checkClientCommand(turnStart(iterationThreadId));
      assert.strictEqual(rejection?.evidence, "state-unreadable");
    });
  });

  it.effect("refuses every guarded lifecycle command, not just turn starts", () => {
    const reads = { count: 0 };
    const ownership = makeEpicIterationOwnership(
      storeWith(Effect.succeed([runningIteration(1)]), reads),
    );
    const interrupt: OrchestrationCommand = {
      type: "thread.turn.interrupt",
      commandId: CommandId.make("client:interrupt"),
      threadId: iterationThreadId,
      createdAt: now,
    };
    const sessionStop: OrchestrationCommand = {
      type: "thread.session.stop",
      commandId: CommandId.make("client:session-stop"),
      threadId: iterationThreadId,
      createdAt: now,
    };
    return Effect.gen(function* () {
      const interruptRejection = yield* ownership.checkClientCommand(interrupt);
      const stopRejection = yield* ownership.checkClientCommand(sessionStop);
      assert.strictEqual(interruptRejection?.commandType, "thread.turn.interrupt");
      assert.strictEqual(stopRejection?.commandType, "thread.session.stop");
    });
  });
});
