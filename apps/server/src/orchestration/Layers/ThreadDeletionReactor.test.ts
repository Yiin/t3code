import type {
  OrchestrationEvent,
  ProviderStopSessionInput,
  TerminalCloseInput,
} from "@t3tools/contracts";
import { EventId, TerminalCwdNotFoundError, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { ProviderValidationError } from "../../provider/Errors.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../../provider/Services/ProviderService.ts";
import * as TerminalManager from "../../terminal/Manager.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import { ThreadDeletionReactor } from "../Services/ThreadDeletionReactor.ts";
import {
  logCleanupCauseUnlessInterrupted,
  ThreadDeletionReactorLive,
} from "./ThreadDeletionReactor.ts";

describe("logCleanupCauseUnlessInterrupted", () => {
  const threadId = ThreadId.make("thread-deletion-reactor-test");

  it("swallows ordinary cleanup failures", async () => {
    const exit = await Effect.runPromiseExit(
      logCleanupCauseUnlessInterrupted({
        effect: Effect.fail("cleanup failed"),
        message: "thread deletion cleanup skipped provider session stop",
        threadId,
      }),
    );

    expect(Exit.isSuccess(exit)).toBe(true);
  });

  it("preserves interrupt causes", async () => {
    const exit = await Effect.runPromiseExit(
      logCleanupCauseUnlessInterrupted({
        effect: Effect.interrupt,
        message: "thread deletion cleanup skipped provider session stop",
        threadId,
      }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    }
  });
});

const now = "2026-08-03T00:00:00.000Z";

// The subscription fiber forwards each event into the worker queue on its own
// fiber, so yield a few times before `drain()` to let that hand-off happen.
// Both are scheduler-driven, not clock-driven, so no test here sleeps.
const yieldFibers = Effect.forEach(Array.from({ length: 20 }), () => Effect.yieldNow, {
  discard: true,
});

function deletedEvent(threadId: ThreadId, sequence: number): OrchestrationEvent {
  return {
    sequence,
    eventId: EventId.make(`event-deleted-${sequence}`),
    aggregateKind: "thread",
    aggregateId: threadId,
    occurredAt: now,
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "thread.deleted",
    payload: { threadId, deletedAt: now },
  };
}

function archivedEvent(threadId: ThreadId, sequence: number): OrchestrationEvent {
  return {
    sequence,
    eventId: EventId.make(`event-archived-${sequence}`),
    aggregateKind: "thread",
    aggregateId: threadId,
    occurredAt: now,
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "thread.archived",
    payload: { threadId, archivedAt: now, updatedAt: now },
  };
}

interface Harness {
  /** Cleanup calls the reactor made, in the order it made them. */
  readonly effects: ReadonlyArray<string>;
  /** Publish events, then resolve once the reactor has processed them all. */
  readonly emit: (...events: ReadonlyArray<OrchestrationEvent>) => Effect.Effect<void>;
}

function withHarness(
  options: {
    readonly stopSession?: (
      input: ProviderStopSessionInput,
    ) => Effect.Effect<void, ProviderValidationError>;
    readonly closeTerminals?: (
      input: TerminalCloseInput,
    ) => Effect.Effect<void, TerminalCwdNotFoundError>;
  },
  body: (harness: Harness) => Effect.Effect<void>,
) {
  return Effect.gen(function* () {
    const effects: string[] = [];
    const events = yield* Queue.unbounded<OrchestrationEvent>();

    const engine: OrchestrationEngineShape = {
      readEvents: () => Stream.empty,
      dispatch: () => Effect.die(new Error("dispatch not expected in this test")),
      streamDomainEvents: Stream.fromQueue(events),
      latestSequence: Effect.succeed(0),
    };

    const unsupportedProviderCall = (call: string) => () =>
      Effect.die(new Error(`ProviderService.${call} is not stubbed in this test`));

    const providerService: ProviderServiceShape = {
      stopSession: (input: ProviderStopSessionInput) =>
        Effect.suspend(() => {
          effects.push(`provider.stopSession:${input.threadId}`);
          return options.stopSession?.(input) ?? Effect.void;
        }),
      startSession: unsupportedProviderCall("startSession"),
      sendTurn: unsupportedProviderCall("sendTurn"),
      interruptTurn: unsupportedProviderCall("interruptTurn"),
      respondToRequest: unsupportedProviderCall("respondToRequest"),
      respondToUserInput: unsupportedProviderCall("respondToUserInput"),
      listSessions: unsupportedProviderCall("listSessions"),
      hasLiveSession: unsupportedProviderCall("hasLiveSession"),
      describeSessionResume: unsupportedProviderCall("describeSessionResume"),
      getCapabilities: unsupportedProviderCall("getCapabilities"),
      getInstanceInfo: unsupportedProviderCall("getInstanceInfo"),
      rollbackConversation: unsupportedProviderCall("rollbackConversation"),
      streamEvents: Stream.die(new Error("ProviderService.streamEvents is not stubbed")),
    };

    const unsupportedTerminalCall = (call: string) => () =>
      Effect.die(new Error(`TerminalManager.${call} is not stubbed in this test`));

    const terminalManager: TerminalManager.TerminalManager["Service"] = {
      close: (input: TerminalCloseInput) =>
        Effect.suspend(() => {
          effects.push(`terminal.close:${input.threadId}:${input.deleteHistory === true}`);
          return options.closeTerminals?.(input) ?? Effect.void;
        }),
      open: unsupportedTerminalCall("open"),
      attachStream: unsupportedTerminalCall("attachStream"),
      write: unsupportedTerminalCall("write"),
      resize: unsupportedTerminalCall("resize"),
      clear: unsupportedTerminalCall("clear"),
      restart: unsupportedTerminalCall("restart"),
      subscribe: unsupportedTerminalCall("subscribe"),
      subscribeMetadata: unsupportedTerminalCall("subscribeMetadata"),
    };

    yield* Effect.gen(function* () {
      const reactor = yield* ThreadDeletionReactor;
      yield* reactor.start();

      const emit: Harness["emit"] = (...toEmit) =>
        Effect.gen(function* () {
          for (const event of toEmit) {
            yield* Queue.offer(events, event);
          }
          yield* yieldFibers;
          yield* reactor.drain;
        });

      yield* body({ effects, emit });
    }).pipe(
      Effect.provide(
        ThreadDeletionReactorLive.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(OrchestrationEngineService, engine),
              Layer.succeed(ProviderService, providerService),
              Layer.succeed(TerminalManager.TerminalManager, terminalManager),
            ),
          ),
        ),
      ),
    );
  }).pipe(Effect.scoped);
}

describe("ThreadDeletionReactor", () => {
  it.effect("stops the provider session before closing the thread terminals", () => {
    const threadId = ThreadId.make("thread-delete-live");
    return withHarness({}, ({ effects, emit }) =>
      Effect.gen(function* () {
        yield* emit(deletedEvent(threadId, 11));

        expect(effects).toEqual([
          `provider.stopSession:${threadId}`,
          `terminal.close:${threadId}:true`,
        ]);
      }),
    );
  });

  it.effect("still closes the thread terminals when the session stop fails", () => {
    const threadId = ThreadId.make("thread-delete-stop-fails");
    return withHarness(
      {
        stopSession: () =>
          Effect.fail(
            new ProviderValidationError({
              operation: "stopSession",
              issue: "simulated session stop failure",
            }),
          ),
      },
      ({ effects, emit }) =>
        Effect.gen(function* () {
          yield* emit(deletedEvent(threadId, 12));

          expect(effects).toEqual([
            `provider.stopSession:${threadId}`,
            `terminal.close:${threadId}:true`,
          ]);
        }),
    );
  });

  it.effect("survives a terminal close failure and still handles the next deletion", () => {
    const failingThreadId = ThreadId.make("thread-delete-terminal-fails");
    const nextThreadId = ThreadId.make("thread-delete-after-failure");
    return withHarness(
      {
        closeTerminals: (input) =>
          input.threadId === failingThreadId
            ? Effect.fail(new TerminalCwdNotFoundError({ cwd: "/tmp/gone" }))
            : Effect.void,
      },
      ({ effects, emit }) =>
        Effect.gen(function* () {
          yield* emit(deletedEvent(failingThreadId, 13));
          yield* emit(deletedEvent(nextThreadId, 14));

          expect(effects).toEqual([
            `provider.stopSession:${failingThreadId}`,
            `terminal.close:${failingThreadId}:true`,
            `provider.stopSession:${nextThreadId}`,
            `terminal.close:${nextThreadId}:true`,
          ]);
        }),
    );
  });

  it.effect("ignores events that are not thread.deleted", () => {
    const threadId = ThreadId.make("thread-delete-other-event");
    return withHarness({}, ({ effects, emit }) =>
      Effect.gen(function* () {
        yield* emit(archivedEvent(threadId, 15));
        expect(effects).toEqual([]);

        // The same thread deleting next proves the archived event was skipped
        // on purpose, not lost before the reactor could see it.
        yield* emit(deletedEvent(threadId, 16));
        expect(effects).toEqual([
          `provider.stopSession:${threadId}`,
          `terminal.close:${threadId}:true`,
        ]);
      }),
    );
  });
});
