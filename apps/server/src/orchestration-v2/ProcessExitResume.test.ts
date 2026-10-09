import { assert, it } from "@effect/vitest";
import {
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  ThreadId,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import {
  makeProviderFailure,
  PROVIDER_PROCESS_EXITED_CODE,
} from "@t3tools/provider-core/server/failure";
import * as ConfigProvider from "effect/ConfigProvider";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  MAX_PROCESS_EXIT_RESUMES,
  PROCESS_EXIT_RESUME_WINDOW_MS,
  planProcessExitResume,
  processExitResumeAttempt,
  processExitResumeMessageId,
} from "./ProcessExitResume.ts";
import { resumeAfterProcessExit } from "./RestartContinuation.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

const threadId = ThreadId.make("thread:process-exit");
const sourceRunId = RunId.make("run:process-exit");
const instanceId = ProviderInstanceId.make("claudeAgent");
const startedAt = DateTime.makeUnsafe("2026-10-09T10:00:00.000Z");
const diedAt = DateTime.makeUnsafe("2026-10-09T10:02:00.000Z");

const processExitFailure = makeProviderFailure({
  message: "The Claude Code process exited unexpectedly mid-turn.",
  code: PROVIDER_PROCESS_EXITED_CODE,
  class: "transport_error",
});

function makeRun(overrides: Partial<OrchestrationV2Run> = {}): OrchestrationV2Run {
  return {
    id: sourceRunId,
    threadId,
    ordinal: 3,
    providerInstanceId: instanceId,
    modelSelection: { instanceId, model: "claude-opus-4-7" },
    userMessageId: MessageId.make("message:user"),
    status: "failed",
    startedAt,
    completedAt: diedAt,
    ...overrides,
  } as unknown as OrchestrationV2Run;
}

const rootNode = {
  id: NodeId.make("node:process-exit"),
  providerTurnId: ProviderTurnId.make("provider-turn:process-exit"),
} as unknown as OrchestrationV2ExecutionNode;
const providerThread = {
  id: ProviderThreadId.make("provider-thread:process-exit"),
} as unknown as OrchestrationV2ProviderThread;

const plan = (run: OrchestrationV2Run, failure = processExitFailure) =>
  Effect.gen(function* () {
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    return planProcessExitResume({
      idAllocator,
      run,
      rootNode,
      providerThread,
      failure,
      completedAt: diedAt,
    });
  }).pipe(Effect.provide(IdAllocator.layer));

it("counts automatic resumes only while each resumed run dies inside the window", () => {
  assert.equal(processExitResumeAttempt(makeRun(), diedAt), 1);
  const resumed = makeRun({ userMessageId: processExitResumeMessageId(RunId.make("run:a"), 2) });
  assert.equal(processExitResumeAttempt(resumed, diedAt), 3);
  const longHealthyRun = makeRun({
    userMessageId: processExitResumeMessageId(RunId.make("run:a"), 2),
    startedAt: DateTime.subtract(diedAt, { milliseconds: PROCESS_EXIT_RESUME_WINDOW_MS + 1 }),
  });
  assert.equal(processExitResumeAttempt(longHealthyRun, diedAt), 1);
});

it.effect("schedules a resume with a notice after the backoff", () =>
  Effect.gen(function* () {
    const planned = yield* plan(makeRun());
    assert.isNotNull(planned);
    if (planned === null) return;
    assert.equal(planned.notice.type, "system_notice");
    assert.include(
      planned.notice.type === "system_notice" ? planned.notice.message : "",
      "attempt 1 of 3",
    );
    assert.equal(planned.notice.ordinal, 397);
    assert.lengthOf(planned.effects, 1);
    const effect = planned.effects[0]!;
    assert.deepEqual(effect.request, {
      type: "provider-runtime.resume-after-exit",
      sourceRunId,
      attempt: 1,
    });
    assert.equal(
      DateTime.formatIso(effect.availableAt!),
      DateTime.formatIso(DateTime.add(diedAt, { seconds: 5 })),
    );
  }),
);

it.effect("backs off further on each resume in a row", () =>
  Effect.gen(function* () {
    const planned = yield* plan(
      makeRun({ userMessageId: processExitResumeMessageId(RunId.make("run:a"), 2) }),
    );
    const effect = planned?.effects[0];
    assert.equal(
      effect?.request.type === "provider-runtime.resume-after-exit" ? effect.request.attempt : 0,
      3,
    );
    assert.equal(
      DateTime.formatIso(effect!.availableAt!),
      DateTime.formatIso(DateTime.add(diedAt, { seconds: 45 })),
    );
  }),
);

it.effect("stops resuming once the attempts run out, and says so", () =>
  Effect.gen(function* () {
    const planned = yield* plan(
      makeRun({
        userMessageId: processExitResumeMessageId(RunId.make("run:a"), MAX_PROCESS_EXIT_RESUMES),
      }),
    );
    assert.isNotNull(planned);
    assert.lengthOf(planned!.effects, 0);
    assert.include(
      planned!.notice.type === "system_notice" ? planned!.notice.message : "",
      "Automatic resume stopped after 3 attempts",
    );
  }),
);

it.effect("ignores failures that are not a process exit", () =>
  Effect.gen(function* () {
    assert.isNull(
      yield* plan(makeRun(), makeProviderFailure({ message: "boom", class: "transport_error" })),
    );
  }),
);

type DispatchCommand = Parameters<
  ThreadManagementService.ThreadManagementService["Service"]["dispatch"]
>[0];

function makeProjection(overrides: {
  readonly runs?: ReadonlyArray<OrchestrationV2Run>;
  readonly turnItems?: ReadonlyArray<unknown>;
  readonly messages?: ReadonlyArray<unknown>;
}) {
  return {
    thread: {
      id: threadId,
      projectId: ProjectId.make("project:process-exit"),
      providerInstanceId: instanceId,
      archivedAt: null,
      deletedAt: null,
    },
    runs: overrides.runs ?? [makeRun()],
    messages: overrides.messages ?? [],
    turnItems: overrides.turnItems ?? [],
  } as unknown as OrchestrationV2ThreadProjection;
}

const runResume = (projection: OrchestrationV2ThreadProjection, env: Record<string, string> = {}) =>
  Effect.gen(function* () {
    const commands: Array<DispatchCommand> = [];
    let recovered = 0;
    yield* resumeAfterProcessExit({ threadId, sourceRunId, attempt: 1 }).pipe(
      Effect.provide(
        Layer.merge(
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadRecords: () => Effect.succeed(projection),
            recoverDelegatedTask: () =>
              Effect.sync(() => {
                recovered += 1;
              }),
            dispatch: (command) => {
              commands.push(command);
              return Effect.succeed({} as never);
            },
          }),
          ConfigProvider.layer(ConfigProvider.fromEnv({ env })),
        ),
      ),
    );
    return { commands, recovered };
  });

it.effect("resumes the failed run with a continuation turn", () =>
  Effect.gen(function* () {
    const { commands, recovered } = yield* runResume(makeProjection({}));
    assert.lengthOf(commands, 1);
    const command = commands[0]!;
    assert.equal(command.type, "message.dispatch");
    if (command.type !== "message.dispatch") return;
    assert.equal(command.messageId, processExitResumeMessageId(sourceRunId, 1));
    assert.equal(command.restartContinuationOfRunId, sourceRunId);
    assert.deepEqual(command.modelSelection, makeRun().modelSelection);
    assert.include(command.text, "exited unexpectedly");
    assert.include(command.text, "Continue where you left off.");
    assert.equal(recovered, 1);
  }),
);

it.effect("does nothing once the user moved on", () =>
  Effect.gen(function* () {
    const newerRun = makeRun({
      id: RunId.make("run:newer"),
      ordinal: 4,
      status: "running",
      startedAt: DateTime.add(diedAt, { seconds: 1 }),
      completedAt: null,
    });
    for (const projection of [
      // The user sent a new message.
      makeProjection({ runs: [makeRun(), newerRun] }),
      // The user pressed Stop on the idle thread.
      makeProjection({
        turnItems: [{ type: "run_interrupt_request", runId: sourceRunId }],
      }),
      // The run did not fail.
      makeProjection({ runs: [makeRun({ status: "interrupted" })] }),
      // The resume was already sent.
      makeProjection({ messages: [{ id: processExitResumeMessageId(sourceRunId, 1) }] }),
    ]) {
      const { commands, recovered } = yield* runResume(projection);
      assert.lengthOf(commands, 0);
      assert.equal(recovered, 1);
    }
  }),
);

it.effect("does nothing when T3CODE_RESUME_AFTER_PROCESS_DEATH=0", () =>
  Effect.gen(function* () {
    const { commands } = yield* runResume(makeProjection({}), {
      T3CODE_RESUME_AFTER_PROCESS_DEATH: "0",
    });
    assert.lengthOf(commands, 0);
  }),
);
