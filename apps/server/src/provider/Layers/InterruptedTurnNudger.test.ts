/**
 * What a restart's boot nudge does, and — more importantly — what it refuses
 * to do.
 *
 * Two things are load-bearing. Nothing reaches the agent until the provider
 * proves the session continued, because a "carry on where you left off" prompt
 * in front of a blank session is worse than the silence it replaces. And a
 * thread that was not mid-turn is never collected at all, because waking a
 * finished conversation would be indistinguishable, to the user, from the app
 * talking to itself.
 */
import {
  MessageId,
  PROVIDER_SESSION_RESUME_SETTLED_ACTIVITY_KIND,
  ThreadId,
  TurnId,
  epicRunIterationThreadId,
  type OrchestrationCommand,
  type OrchestrationThreadShell,
  type ProviderSessionResumeOutcome,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../../orchestration/Services/OrchestrationEngine.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { InterruptedTurnNudger } from "../Services/InterruptedTurnNudger.ts";
import {
  InterruptedTurnNudgerLive,
  RESTART_NUDGE_PROMPT,
  selectInterruptedThreads,
} from "./InterruptedTurnNudger.ts";

/**
 * Counting bytes rather than random ones: reproducible, and still distinct on
 * every call. Module-scoped on purpose — the "own message row" test runs two
 * boots and needs their uuids to differ the way two real boots' would.
 */
let cryptoSeed = 0;

const MID_TURN_THREAD = ThreadId.make("thread-mid-turn");
const DEAD_TURN = TurnId.make("turn-killed-by-restart");

interface ShellOverrides {
  readonly id?: ThreadId;
  readonly turnState?: "running" | "completed" | "interrupted";
  readonly turnId?: TurnId;
  readonly activeTurnId?: TurnId | null;
  readonly parentThreadId?: ThreadId | null;
  readonly settledOverride?: "settled" | "active" | null;
}

// SAFETY: a partial shell. Only the fields the nudge reads are set; the rest
// would be dead weight in an assertion about which turn was running.
const shell = (overrides: ShellOverrides = {}): OrchestrationThreadShell =>
  ({
    id: overrides.id ?? MID_TURN_THREAD,
    parentThreadId: overrides.parentThreadId ?? null,
    settledOverride: overrides.settledOverride ?? null,
    runtimeMode: "full-access",
    interactionMode: "default",
    latestTurn: {
      turnId: overrides.turnId ?? DEAD_TURN,
      state: overrides.turnState ?? "running",
      assistantMessageId: null,
    },
    session: {
      status: overrides.turnState === "running" ? "running" : "stopped",
      activeTurnId:
        overrides.activeTurnId === undefined
          ? overrides.turnState === "running" || overrides.turnState === undefined
            ? (overrides.turnId ?? DEAD_TURN)
            : null
          : overrides.activeTurnId,
    },
  }) as unknown as OrchestrationThreadShell;

interface HarnessOptions {
  readonly outcome?: ProviderSessionResumeOutcome;
  readonly threads?: ReadonlyArray<OrchestrationThreadShell>;
  readonly queuedMessageThreadIds?: ReadonlyArray<ThreadId>;
  /** The shell `nudge` re-reads, when it must differ from the collected one. */
  readonly shellAtNudge?: OrchestrationThreadShell;
  readonly failDispatch?: (command: OrchestrationCommand) => boolean;
}

/**
 * Stands in for the whole command path: it records every dispatch and, for a
 * resume, writes back the durable activity the reactor would have written.
 * Mirrors `epicRunnerResumeIteration.test.ts`, which pins the sibling handshake.
 */
function harness(options: HarnessOptions = {}) {
  const outcome = options.outcome ?? ({ _tag: "resumed" } as const);
  const dispatched: OrchestrationCommand[] = [];
  const activitiesByThread = new Map<string, Array<{ kind: string; payload: unknown }>>();

  // SAFETY: a partial engine. `dispatch` is the only method the nudge calls,
  // and every other one would be an unreachable stub.
  const engine = {
    dispatch: (command: OrchestrationCommand) => {
      if (options.failDispatch?.(command) === true) {
        return Effect.die(new Error(`dispatch refused: ${command.type}`));
      }
      dispatched.push(command);
      if (command.type === "thread.session.resume") {
        const activities = activitiesByThread.get(command.threadId) ?? [];
        activities.push({
          kind: PROVIDER_SESSION_RESUME_SETTLED_ACTIVITY_KIND,
          payload: {
            threadId: command.threadId,
            requestCommandId: command.commandId,
            outcome,
          },
        });
        activitiesByThread.set(command.threadId, activities);
      }
      return Effect.succeed({ sequence: dispatched.length });
    },
  } as unknown as OrchestrationEngineShape;

  const threads = options.threads ?? [shell()];

  // SAFETY: a partial query. These four reads are the whole surface the nudge
  // and its settle watch touch.
  const projectionSnapshotQuery = {
    getShellSnapshot: () => Effect.succeed({ threads, projects: [], snapshotSequence: 1 }),
    listThreadIdsWithQueuedMessages: () => Effect.succeed(options.queuedMessageThreadIds ?? []),
    getThreadShellById: (threadId: ThreadId) => {
      const found = options.shellAtNudge ?? threads.find((candidate) => candidate.id === threadId);
      return Effect.succeed(found === undefined ? Option.none() : Option.some(found));
    },
    getThreadDetailSnapshot: (threadId: ThreadId) =>
      Effect.succeed(
        Option.some({ thread: { activities: activitiesByThread.get(threadId) ?? [] } }),
      ),
  } as unknown as ProjectionSnapshotQueryShape;

  const cryptoLayer = Layer.succeed(
    Crypto.Crypto,
    Crypto.make({
      randomBytes: (size) => {
        cryptoSeed += 1;
        return new Uint8Array(size).fill(cryptoSeed % 256);
      },
      digest: (_algorithm, data) => Effect.succeed(data),
    }),
  );

  const layer = InterruptedTurnNudgerLive.pipe(
    Layer.provide(Layer.succeed(OrchestrationEngineService, engine)),
    Layer.provide(Layer.succeed(ProjectionSnapshotQuery, projectionSnapshotQuery)),
    Layer.provide(cryptoLayer),
  );

  return { layer, dispatched };
}

/**
 * Let the forked fan-out run to completion.
 *
 * Every stub answers synchronously, so the whole pass costs a bounded number of
 * fiber steps. It has to drain BEFORE the scope closes: `forkScoped` finalizes
 * by interrupting its fiber, not by awaiting it, so closing first would assert
 * against a nudge that was killed mid-handshake.
 */
const drainFibers = Effect.forEach(Array.from({ length: 100 }), () => Effect.yieldNow, {
  discard: true,
});

/** Run the whole boot pass the way `startBootReactors` does. */
const runBootPass = (layer: Layer.Layer<InterruptedTurnNudger>) =>
  Effect.gen(function* () {
    const nudger = yield* InterruptedTurnNudger;
    const candidates = yield* nudger.collect();
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* nudger.nudge(candidates);
        yield* drainFibers;
      }),
    );
    return candidates;
  }).pipe(Effect.provide(layer));

const commandTypes = (commands: ReadonlyArray<OrchestrationCommand>) =>
  commands.map((command) => command.type);

const turnStarts = (commands: ReadonlyArray<OrchestrationCommand>) =>
  commands.filter((command) => command.type === "thread.turn.start");

describe("selectInterruptedThreads", () => {
  const select = (threads: ReadonlyArray<OrchestrationThreadShell>, queued: Array<ThreadId> = []) =>
    selectInterruptedThreads({ threads, queuedMessageThreadIds: new Set(queued) });

  it("collects a thread whose turn was still running", () => {
    expect(select([shell()])).toEqual([{ threadId: MID_TURN_THREAD, latestTurnId: DEAD_TURN }]);
  });

  it("leaves a cleanly stopped thread alone", () => {
    expect(select([shell({ turnState: "completed", activeTurnId: null })])).toEqual([]);
  });

  it("leaves a thread a human interrupted alone", () => {
    expect(select([shell({ turnState: "interrupted", activeTurnId: null })])).toEqual([]);
  });

  it("collects a thread whose session still points at an active turn", () => {
    // The graceful-SIGTERM shape: the turn row settled but the session row did
    // not, so the pointer is the only signal left.
    expect(select([shell({ turnState: "completed", activeTurnId: DEAD_TURN })])).toEqual([
      { threadId: MID_TURN_THREAD, latestTurnId: DEAD_TURN },
    ]);
  });

  it("never collects an epic-run iteration thread", () => {
    const iterationThread = ThreadId.make(
      epicRunIterationThreadId({ runId: "run-1", iterationIndex: 2 }),
    );
    expect(select([shell({ id: iterationThread })])).toEqual([]);
  });

  it("never collects a thread-backed subagent child", () => {
    expect(select([shell({ parentThreadId: ThreadId.make("thread-parent") })])).toEqual([]);
  });

  it("never collects a thread the user explicitly settled", () => {
    expect(select([shell({ settledOverride: "settled" })])).toEqual([]);
  });

  it("still collects a thread pinned active", () => {
    // `active` is a keep-alive pin, not a "leave me alone" — the opposite
    // signal from `settled`.
    expect(select([shell({ settledOverride: "active" })])).toEqual([
      { threadId: MID_TURN_THREAD, latestTurnId: DEAD_TURN },
    ]);
  });

  it("never collects a thread whose parked message is about to be delivered", () => {
    expect(select([shell()], [MID_TURN_THREAD])).toEqual([]);
  });
});

describe("InterruptedTurnNudger", () => {
  it.effect("nudges a thread the restart cut off, but only after a proved resume", () =>
    Effect.gen(function* () {
      const { layer, dispatched } = harness();

      yield* runBootPass(layer);

      expect(commandTypes(dispatched)).toEqual([
        // Settles the dead turn as interrupted, so the resume cannot settle it
        // as completed.
        "thread.session.stop",
        "thread.session.resume",
        "thread.turn.start",
      ]);
      const start = turnStarts(dispatched)[0];
      expect(start).toMatchObject({
        origin: "agent",
        message: { role: "user", text: RESTART_NUDGE_PROMPT },
      });
      // The thread's own selection stays in charge of the resumed turn.
      expect(start?.type === "thread.turn.start" && "modelSelection" in start).toBe(false);
    }),
  );

  it.effect("never nudges a thread that was not mid-turn", () =>
    Effect.gen(function* () {
      const { layer, dispatched } = harness({
        threads: [shell({ turnState: "completed", activeTurnId: null })],
      });

      const candidates = yield* runBootPass(layer);

      expect(candidates).toEqual([]);
      expect(dispatched).toEqual([]);
    }),
  );

  for (const outcome of [
    { _tag: "not-continued", origin: "started-fresh", detail: "provider started a blank session" },
    { _tag: "no-durable-state", detail: "no persisted resume cursor" },
    { _tag: "capability", detail: "this provider cannot resume" },
    { _tag: "failed", detail: "the adapter threw" },
  ] as const satisfies ReadonlyArray<ProviderSessionResumeOutcome>) {
    it.effect(`leaves the thread stopped when the resume answers '${outcome._tag}'`, () =>
      Effect.gen(function* () {
        const { layer, dispatched } = harness({ outcome });

        yield* runBootPass(layer);

        expect(commandTypes(dispatched)).toEqual(["thread.session.stop", "thread.session.resume"]);
        expect(turnStarts(dispatched)).toHaveLength(0);
      }),
    );
  }

  it.effect("stands down when another turn is already running on the thread", () =>
    Effect.gen(function* () {
      const { layer, dispatched } = harness({
        // A human typed while the boot pass worked through an earlier thread.
        shellAtNudge: shell({ turnId: TurnId.make("turn-typed-by-a-human") }),
      });

      yield* runBootPass(layer);

      expect(dispatched).toEqual([]);
    }),
  );

  it.effect("gives each restart its own message row", () =>
    Effect.gen(function* () {
      const first = harness();
      const second = harness();

      yield* runBootPass(first.layer);
      yield* runBootPass(second.layer);

      const messageIds = [...turnStarts(first.dispatched), ...turnStarts(second.dispatched)].map(
        (command) => (command.type === "thread.turn.start" ? command.message.messageId : null),
      );
      expect(messageIds).toHaveLength(2);
      expect(new Set(messageIds).size).toBe(2);
      // Never the id a previous nudge already used: an upsert by messageId
      // would rewrite that row instead of adding this one.
      expect(messageIds).not.toContain(MessageId.make(`${MID_TURN_THREAD}-restart-nudge`));
    }),
  );

  it.effect("keeps nudging the rest when one thread's resume dispatch breaks", () =>
    Effect.gen(function* () {
      const healthy = ThreadId.make("thread-healthy");
      const { layer, dispatched } = harness({
        threads: [shell(), shell({ id: healthy })],
        failDispatch: (command) =>
          command.type === "thread.session.resume" && command.threadId === MID_TURN_THREAD,
      });

      yield* runBootPass(layer);

      const started = turnStarts(dispatched);
      expect(started).toHaveLength(1);
      expect(started[0]?.threadId).toBe(healthy);
    }),
  );
});
