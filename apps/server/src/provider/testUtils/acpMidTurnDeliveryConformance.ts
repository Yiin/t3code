// @effect-diagnostics nodeBuiltinImport:off
/**
 * acpMidTurnDeliveryConformance - one shared spec for what an ACP adapter owes
 * a message sent while a turn is already running.
 *
 * The ACP trio (kimi, grok, cursor) cannot steer. ACP has no mid-turn channel,
 * and `AcpSessionRuntime` holds a one-permit prompt semaphore, so a second
 * `sendTurn` parks until the running prompt settles and then reaches the agent
 * as a plain new `session/prompt`. The agent never sees the text mid-turn.
 *
 * Each adapter nonetheless reports that second message as a steer: it reuses
 * the running turn id and suppresses the second `turn.started`, so the UI shows
 * one turn that supposedly absorbed both messages. That is a lie about what the
 * agent saw. The honest report is two turns.
 *
 * The spec registers two rows per adapter:
 *
 * - **delivery** (`it.effect`) — the wire fact, true before and after the fix:
 *   the mid-turn message reaches the agent as its own `session/prompt`, and
 *   only after the first prompt settles.
 * - **honest turn boundaries** (`it.effect.fails`) — the contract, pinned red.
 *   It asserts two distinct turn ids and one `turn.started`/`turn.completed`
 *   pair per message. Today every adapter merges, so the row fails; `.fails`
 *   records that expected failure and keeps the suite green.
 *
 * `t3code-6f3.12` makes the merge honest. When it lands, drop `.fails` from the
 * second row (the row goes green) and delete each adapter's own "steers a
 * running turn" test, which pins the behaviour this spec rejects.
 *
 * @module acpMidTurnDeliveryConformance
 */
import * as NodeFSP from "node:fs/promises";

import { assert, type Vitest } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import type {
  ProviderDriverKind,
  ProviderRuntimeEvent,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderSessionStartInput,
  ProviderTurnStartResult,
  ThreadId,
} from "@t3tools/contracts";

/** Every adapter fails with its own tagged union; the rows only need the tag. */
export interface MidTurnDeliveryAdapterError {
  readonly _tag: string;
}

/**
 * The slice of `ProviderAdapterShape` the rows drive. Structural on purpose:
 * the three adapters share no base type, only these four members and the
 * runtime event stream.
 */
export interface MidTurnDeliveryAdapterUnderTest {
  readonly startSession: (
    input: ProviderSessionStartInput,
  ) => Effect.Effect<ProviderSession, MidTurnDeliveryAdapterError>;
  readonly sendTurn: (
    input: ProviderSendTurnInput,
  ) => Effect.Effect<ProviderTurnStartResult, MidTurnDeliveryAdapterError>;
  readonly stopSession: (threadId: ThreadId) => Effect.Effect<void, MidTurnDeliveryAdapterError>;
  readonly streamEvents: Stream.Stream<ProviderRuntimeEvent>;
}

/** What an adapter test hands one row, already wired to its own mock agent. */
export interface MidTurnDeliveryHarness {
  readonly adapter: MidTurnDeliveryAdapterUnderTest;

  /**
   * Every JSON-RPC request the mock agent has received so far, in arrival
   * order. Backed by `T3_ACP_REQUEST_LOG_PATH`, which the mock appends to on
   * receipt — before it sleeps out `T3_ACP_PROMPT_DELAY_MS` — so the log
   * orders arrivals, not replies.
   */
  readonly readAgentRequests: () => Effect.Effect<ReadonlyArray<AgentRequest>>;

  /** Extra start fields the adapter needs, such as `cwd` or `modelSelection`. */
  readonly startSessionInput?: Omit<
    Partial<ProviderSessionStartInput>,
    "threadId" | "provider" | "resumeCursor"
  >;

  /** Extra turn fields the adapter validates before it will accept a prompt. */
  readonly sendTurnInput?: Omit<Partial<ProviderSendTurnInput>, "threadId" | "input">;
}

export interface AgentRequest {
  readonly method?: unknown;
  readonly params?: unknown;
}

/**
 * How long the mock agent should hold a prompt for these rows. Long enough
 * that spotting the first prompt and sending the second still lands well
 * inside the window on a loaded host, short enough that two prompts plus a
 * process spawn stay far under the suite's timeout.
 */
export const MID_TURN_PROMPT_DELAY_MILLIS = 1500;

/**
 * Read the mock agent's `T3_ACP_REQUEST_LOG_PATH` inbox. Missing file and
 * half-written trailing line both mean "nothing more has arrived yet", so the
 * rows can poll it without racing the agent's append.
 */
export const readAgentRequests = (
  requestLogPath: string,
): Effect.Effect<ReadonlyArray<AgentRequest>> =>
  Effect.tryPromise(() => NodeFSP.readFile(requestLogPath, "utf8")).pipe(
    Effect.orElseSucceed(() => ""),
    Effect.map((raw) =>
      raw
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .flatMap((line) => {
          try {
            return [JSON.parse(line) as AgentRequest];
          } catch {
            return [];
          }
        }),
    ),
  );

export interface MidTurnDeliveryConformanceInput<R = never> {
  /** Adapter name, used as the row prefix. */
  readonly name: string;
  readonly provider: ProviderDriverKind;

  /**
   * `T3_ACP_PROMPT_DELAY_MS` the harness set on its mock agent. The rows hold
   * the second message inside that window, so it has to be comfortably longer
   * than the time it takes to spot the first prompt and answer it.
   */
  readonly promptDelayMillis: number;

  /**
   * Build the harness, run one row against it, and tear it down. The adapter
   * test owns everything around the body: the mock wrapper, the request log,
   * the layer, and any temp files.
   */
  readonly runScenario: (
    body: (harness: MidTurnDeliveryHarness) => Effect.Effect<void, MidTurnDeliveryAdapterError>,
  ) => Effect.Effect<void, MidTurnDeliveryAdapterError, R | Scope.Scope>;
}

const FIRST_MESSAGE = "run 5 commands";
const SECOND_MESSAGE = "actually run 15";

/** What one run of the scenario saw, in terms both rows can assert on. */
interface MidTurnObservation {
  readonly firstTurnId: string;
  readonly secondTurnId: string;
  readonly turnStartedIds: ReadonlyArray<string>;
  readonly turnCompletedIds: ReadonlyArray<string>;
  /** `session/prompt` arrivals while the first prompt was still unanswered. */
  readonly promptsSeenWhileFirstInFlight: number;
  /** Prompt texts the agent received, in arrival order. */
  readonly promptTexts: ReadonlyArray<string>;
}

const promptRequests = (requests: ReadonlyArray<AgentRequest>): ReadonlyArray<AgentRequest> =>
  requests.filter((request) => request.method === "session/prompt");

const promptText = (request: AgentRequest): string => {
  const blocks = (request.params as { prompt?: ReadonlyArray<unknown> } | undefined)?.prompt ?? [];
  return blocks
    .map((block) => (block as { text?: unknown }).text)
    .filter((text): text is string => typeof text === "string")
    .join(" ");
};

/**
 * Send two messages, the second while the first prompt is still unanswered,
 * and report what the agent received and what the adapter told the runtime.
 *
 * Runs on the live clock: the mock agent sleeps in real time, so the mid-turn
 * window only exists on the real one.
 */
const observeMidTurnDelivery = (
  harness: MidTurnDeliveryHarness,
  input: MidTurnDeliveryConformanceInput<never>,
  threadId: ThreadId,
): Effect.Effect<MidTurnObservation, MidTurnDeliveryAdapterError> =>
  Effect.gen(function* () {
    const { adapter } = harness;
    const events = yield* Ref.make<ReadonlyArray<ProviderRuntimeEvent>>([]);
    const collector = yield* adapter.streamEvents.pipe(
      Stream.filter((event) => event.threadId === threadId),
      Stream.runForEach((event) => Ref.update(events, (seen) => [...seen, event])),
      Effect.forkChild,
    );

    return yield* Effect.gen(function* () {
      yield* adapter.startSession({
        threadId,
        provider: input.provider,
        runtimeMode: "full-access",
        ...harness.startSessionInput,
      });

      const firstFiber = yield* adapter
        .sendTurn({
          threadId,
          input: FIRST_MESSAGE,
          attachments: [],
          ...harness.sendTurnInput,
        })
        .pipe(Effect.forkChild);

      // Wait for the agent to actually hold the first prompt. Until then a
      // second `sendTurn` would not be mid-turn at all.
      yield* Effect.gen(function* () {
        for (let attempt = 0; attempt < 400; attempt += 1) {
          const requests = yield* harness.readAgentRequests();
          if (promptRequests(requests).length >= 1) {
            return;
          }
          yield* Effect.sleep("10 millis");
        }
        return yield* Effect.die(
          new Error(`${input.name}: the mock agent never received the first session/prompt.`),
        );
      });

      const secondFiber = yield* adapter
        .sendTurn({
          threadId,
          input: SECOND_MESSAGE,
          attachments: [],
          ...harness.sendTurnInput,
        })
        .pipe(Effect.forkChild);

      // Sample the agent's inbox while the first prompt is still unanswered.
      // A quarter of the delay leaves plenty of margin on a loaded host.
      yield* Effect.sleep(`${Math.max(50, Math.floor(input.promptDelayMillis / 4))} millis`);
      const midFlightRequests = yield* harness.readAgentRequests();

      const firstTurn = yield* Fiber.join(firstFiber);
      const secondTurn = yield* Fiber.join(secondFiber);

      // Both prompts have returned; give the adapter a beat to publish the
      // settlement events that follow them.
      yield* Effect.sleep("250 millis");
      const settledRequests = yield* harness.readAgentRequests();
      const runtimeEvents = yield* Ref.get(events);

      yield* adapter.stopSession(threadId);

      return {
        firstTurnId: String(firstTurn.turnId),
        secondTurnId: String(secondTurn.turnId),
        turnStartedIds: runtimeEvents
          .filter((event) => event.type === "turn.started")
          .map((event) => String(event.turnId)),
        turnCompletedIds: runtimeEvents
          .filter((event) => event.type === "turn.completed")
          .map((event) => String(event.turnId)),
        promptsSeenWhileFirstInFlight: promptRequests(midFlightRequests).length,
        promptTexts: promptRequests(settledRequests).map(promptText),
      } satisfies MidTurnObservation;
    }).pipe(Effect.ensuring(Fiber.interrupt(collector)), TestClock.withLive);
  });

/**
 * Add the mid-turn delivery rows to an adapter test.
 *
 * Call it inside the file's own `it.layer(...)` block so the `it` passed in
 * already carries the adapter's environment.
 */
export const describeAcpMidTurnDeliveryConformance = <R>(
  it: Pick<Vitest.MethodsNonLive<R>, "effect">,
  input: MidTurnDeliveryConformanceInput<R>,
): void => {
  const { name } = input;
  const row = (scenario: string) => `${name} mid-turn delivery: ${scenario}`;
  const observe = (harness: MidTurnDeliveryHarness, scenario: string) =>
    observeMidTurnDelivery(
      harness,
      input as MidTurnDeliveryConformanceInput<never>,
      `${name.toLowerCase()}-mid-turn-${scenario}` as ThreadId,
    );

  it.effect(row("the agent receives the second message as its own prompt, after the first"), () =>
    input.runScenario((harness) =>
      Effect.gen(function* () {
        const observed = yield* observe(harness, "delivery");

        assert.equal(
          observed.promptsSeenWhileFirstInFlight,
          1,
          "ACP has no mid-turn channel: the second message must not reach the agent while the first prompt is unanswered",
        );
        assert.deepStrictEqual(
          observed.promptTexts,
          [FIRST_MESSAGE, SECOND_MESSAGE],
          "both messages must reach the agent, in order, as separate session/prompt requests",
        );
      }),
    ),
  );

  // Pinned red: every ACP adapter merges the second message into the running
  // turn today. `t3code-6f3.12` makes this row honest; drop `.fails` then.
  it.effect.fails(
    row("each message gets its own turn [pinned red until t3code-6f3.12]"),
    () =>
      input.runScenario((harness) =>
        Effect.gen(function* () {
          const observed = yield* observe(harness, "turns");

          assert.notEqual(
            observed.secondTurnId,
            observed.firstTurnId,
            "the agent never saw the second message mid-turn, so reusing the running turn id reports a steer that did not happen",
          );
          assert.deepStrictEqual(
            observed.turnStartedIds,
            [observed.firstTurnId, observed.secondTurnId],
            "a message the agent runs as its own turn owes the runtime its own turn.started; suppressing it hides the second turn",
          );
          assert.deepStrictEqual(
            observed.turnCompletedIds,
            [observed.firstTurnId, observed.secondTurnId],
            "each turn must complete on its own prompt; folding both into one turn.completed leaves the first turn open in the UI",
          );
        }),
      ),
    // Two real prompts at the mock's delay, plus process startup.
    60_000,
  );
};
