/**
 * What a restart's boot nudge does, and — more importantly — what it refuses
 * to do.
 *
 * Two things are load-bearing. Nothing reaches the agent until the provider
 * proves the session continued, because a "carry on where you left off" prompt
 * in front of a blank session is worse than the silence it replaces. And a
 * thread that was not mid-turn is collected only when its live session had
 * background tasks open, because waking any other finished conversation would
 * be indistinguishable, to the user, from the app talking to itself.
 */
import {
  MessageId,
  PROVIDER_SESSION_RESUME_SETTLED_ACTIVITY_KIND,
  ThreadId,
  TurnId,
  epicRunIterationThreadId,
  type OrchestrationCommand,
  type OrchestrationThreadShell,
  type ProviderRuntimeEvent,
  type ProviderSessionResumeOutcome,
  type RuntimeOrphanedTask,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../../orchestration/Services/OrchestrationEngine.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { InterruptedTurnNudger } from "../Services/InterruptedTurnNudger.ts";
import { ProviderService, type ProviderServiceShape } from "../Services/ProviderService.ts";
import {
  InterruptedTurnNudgerLive,
  PROCESS_EXIT_STOP_REASON,
  isNudgeEligibleThread,
  processExitNudgePrompt,
  restartNudgePrompt,
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
  readonly sessionStatus?: "stopped" | "ready" | "running";
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
      status:
        overrides.sessionStatus ?? (overrides.turnState === "running" ? "running" : "stopped"),
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
  /** What every queued-message read after the first returns, when it differs. */
  readonly queuedMessageThreadIdsLater?: ReadonlyArray<ThreadId>;
  /** The shell `nudge` re-reads, when it must differ from the collected one. */
  readonly shellAtNudge?: OrchestrationThreadShell;
  /** Shells returned by successive shell reads; the last one repeats. */
  readonly shellReads?: ReadonlyArray<OrchestrationThreadShell>;
  readonly failDispatch?: (command: OrchestrationCommand) => boolean;
  /** What `ProviderService.streamEvents` replays to the exit watcher. */
  readonly providerEvents?: ReadonlyArray<ProviderRuntimeEvent>;
  /** Open background tasks per thread, as the projection reports them. */
  readonly openTasks?: ReadonlyMap<ThreadId, ReadonlyArray<RuntimeOrphanedTask>>;
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
  let queuedReads = 0;
  let shellReads = 0;

  // SAFETY: a partial query. These five reads are the whole surface the nudge
  // and its settle watch touch.
  const projectionSnapshotQuery = {
    getShellSnapshot: () => Effect.succeed({ threads, projects: [], snapshotSequence: 1 }),
    listOpenBackgroundTasks: (threadIds: ReadonlyArray<ThreadId>) =>
      Effect.succeed(
        new Map(
          [...(options.openTasks ?? new Map())].filter(([threadId]) =>
            threadIds.includes(threadId),
          ),
        ),
      ),
    listThreadIdsWithQueuedMessages: () =>
      Effect.sync(() => {
        queuedReads += 1;
        return queuedReads > 1 && options.queuedMessageThreadIdsLater !== undefined
          ? options.queuedMessageThreadIdsLater
          : (options.queuedMessageThreadIds ?? []);
      }),
    getThreadShellById: (threadId: ThreadId) => {
      const scripted = options.shellReads?.[Math.min(shellReads, options.shellReads.length - 1)];
      shellReads += 1;
      const found =
        scripted ?? options.shellAtNudge ?? threads.find((candidate) => candidate.id === threadId);
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

  // SAFETY: a partial provider service. The exit watcher only subscribes.
  const providerService = {
    streamEvents: Stream.fromIterable(options.providerEvents ?? []),
  } as unknown as ProviderServiceShape;

  const layer = InterruptedTurnNudgerLive.pipe(
    Layer.provide(Layer.succeed(OrchestrationEngineService, engine)),
    Layer.provide(Layer.succeed(ProviderService, providerService)),
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

/** Replay the harness's provider events through the exit watcher. */
const runExitWatcher = (
  layer: Layer.Layer<InterruptedTurnNudger>,
  afterDrain: Effect.Effect<void> = Effect.void,
) =>
  Effect.gen(function* () {
    const nudger = yield* InterruptedTurnNudger;
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* nudger.watchProcessExits();
        yield* drainFibers;
        yield* afterDrain;
        yield* drainFibers;
      }),
    );
  }).pipe(Effect.provide(layer));

const MONITOR: RuntimeOrphanedTask = {
  taskId: "bash_monitor_1",
  taskType: "local_bash",
  description: "tail the deploy log",
};

// SAFETY: a partial event. The watcher reads type, threadId and payload only.
const exitEvent = (
  payload: {
    readonly exitKind?: "graceful" | "error";
    readonly midTurn?: boolean;
    readonly orphanedTasks?: ReadonlyArray<RuntimeOrphanedTask>;
  },
  threadId: ThreadId = MID_TURN_THREAD,
): ProviderRuntimeEvent =>
  ({
    type: "session.exited",
    eventId: "event-exit",
    provider: "claudeAgent",
    threadId,
    createdAt: "2026-09-30T23:10:00.000Z",
    payload: { reason: "Claude Code process exited unexpectedly", ...payload },
  }) as unknown as ProviderRuntimeEvent;

/** A thread whose process died while idle: turn settled, session stopped. */
const idleStoppedShell = (overrides: ShellOverrides = {}) =>
  shell({ turnState: "completed", activeTurnId: null, ...overrides });

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
        message: { role: "user", text: restartNudgePrompt({ midTurn: true, orphanedTasks: [] }) },
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

  it.effect("stands down when another turn came and went since the restart", () =>
    Effect.gen(function* () {
      const { layer, dispatched } = harness({
        // The fan-out is four wide and a resume can hold a slot for the full
        // settle bound, so a whole turn can start and finish while this
        // candidate waits its turn. Stopping that healthy session to tell it
        // it was "cut off" is the worst thing this pass could do.
        shellAtNudge: shell({
          turnId: TurnId.make("turn-a-human-already-finished"),
          turnState: "completed",
        }),
      });

      yield* runBootPass(layer);

      expect(dispatched).toEqual([]);
    }),
  );

  it.effect("still nudges when the interrupted turn itself is all that changed state", () =>
    Effect.gen(function* () {
      // The SIGKILL shape: the reaper settled the very turn that died, so the
      // id still matches and the thread is genuinely waiting.
      const { layer, dispatched } = harness({
        shellAtNudge: shell({ turnState: "interrupted", activeTurnId: null }),
      });

      yield* runBootPass(layer);

      expect(commandTypes(dispatched)).toEqual([
        "thread.session.stop",
        "thread.session.resume",
        "thread.turn.start",
      ]);
    }),
  );

  it.effect("settles a dead turn the projection still shows running", () =>
    Effect.gen(function* () {
      // The SIGTERM shape: the dead session still projects `running`. The
      // restart path must settle it anyway, unlike the exit path.
      const { layer, dispatched } = harness({ threads: [shell({ turnState: "running" })] });

      yield* runBootPass(layer);

      expect(commandTypes(dispatched)).toEqual([
        "thread.session.stop",
        "thread.session.resume",
        "thread.turn.start",
      ]);
    }),
  );

  it.effect("settles but never resumes when a message was parked after collect", () =>
    Effect.gen(function* () {
      // The settle is what releases the delivery poller for the parked
      // message, so it must still happen. The parked message is the next
      // turn, so no resume and no nudge follow.
      const { layer, dispatched } = harness({
        threads: [shell({ turnState: "running" })],
        queuedMessageThreadIdsLater: [MID_TURN_THREAD],
      });

      const candidates = yield* runBootPass(layer);

      expect(candidates).toHaveLength(1);
      expect(commandTypes(dispatched)).toEqual(["thread.session.stop"]);
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

  /** Idle at restart, with a session that was still live when the server died. */
  const idleLiveShell = (overrides: ShellOverrides = {}) =>
    shell({ turnState: "completed", activeTurnId: null, sessionStatus: "ready", ...overrides });

  it.effect("nudges an idle thread whose Monitors the restart killed, naming them", () =>
    Effect.gen(function* () {
      const { layer, dispatched } = harness({
        threads: [idleLiveShell()],
        openTasks: new Map([[MID_TURN_THREAD, [MONITOR]]]),
      });

      const candidates = yield* runBootPass(layer);

      expect(candidates).toEqual([
        {
          threadId: MID_TURN_THREAD,
          latestTurnId: DEAD_TURN,
          idle: true,
          orphanedTasks: [MONITOR],
        },
      ]);
      expect(commandTypes(dispatched)).toEqual([
        "thread.session.stop",
        "thread.session.resume",
        "thread.turn.start",
      ]);
      const start = turnStarts(dispatched)[0];
      const text = start?.type === "thread.turn.start" ? start.message.text : "";
      expect(text).toContain("The T3 Code server restarted while this session was idle.");
      expect(text).toContain("- `bash_monitor_1` (local_bash): tail the deploy log");
      expect(text).toContain("re-arm the ones you still need");
      // Idle at restart: no in-flight tool call to go looking for.
      expect(text).not.toContain("in flight");
    }),
  );

  it.effect("never collects an idle thread with no open background tasks", () =>
    Effect.gen(function* () {
      const { layer, dispatched } = harness({ threads: [idleLiveShell()] });

      expect(yield* runBootPass(layer)).toEqual([]);
      expect(dispatched).toEqual([]);
    }),
  );

  it.effect("never collects an idle thread whose session was already stopped", () =>
    Effect.gen(function* () {
      // The reaper or a user ended this session before the restart.
      const { layer, dispatched } = harness({
        threads: [idleLiveShell({ sessionStatus: "stopped" })],
        openTasks: new Map([[MID_TURN_THREAD, [MONITOR]]]),
      });

      expect(yield* runBootPass(layer)).toEqual([]);
      expect(dispatched).toEqual([]);
    }),
  );

  it.effect("names a mid-turn thread's open tasks next to the cut-off lines", () =>
    Effect.gen(function* () {
      const { layer, dispatched } = harness({
        threads: [shell({ turnState: "running" })],
        openTasks: new Map([[MID_TURN_THREAD, [MONITOR]]]),
      });

      yield* runBootPass(layer);

      const start = turnStarts(dispatched)[0];
      const text = start?.type === "thread.turn.start" ? start.message.text : "";
      expect(text).toContain("your turn was cut off mid-way");
      expect(text).toContain("Any tool call that was in flight never returned");
      expect(text).toContain("- `bash_monitor_1` (local_bash): tail the deploy log");
    }),
  );

  it.effect("never collects an idle epic iteration or subagent child with open tasks", () =>
    Effect.gen(function* () {
      const iteration = ThreadId.make(
        epicRunIterationThreadId({ runId: "run-1", iterationIndex: 0 }),
      );
      const child = ThreadId.make("thread-child");
      const { layer, dispatched } = harness({
        threads: [
          idleLiveShell({ id: iteration }),
          idleLiveShell({ id: child, parentThreadId: ThreadId.make("thread-parent") }),
        ],
        openTasks: new Map([
          [iteration, [MONITOR]],
          [child, [MONITOR]],
        ]),
      });

      expect(yield* runBootPass(layer)).toEqual([]);
      expect(dispatched).toEqual([]);
    }),
  );
});

describe("processExitNudgePrompt", () => {
  it("names every orphaned task by id and tells the agent to re-arm them", () => {
    const prompt = processExitNudgePrompt({
      midTurn: false,
      orphanedTasks: [MONITOR, { taskId: "bash_2" }],
    });
    expect(prompt).toContain("Your Claude Code process exited unexpectedly");
    expect(prompt).toContain("- `bash_monitor_1` (local_bash): tail the deploy log");
    expect(prompt).toContain("- `bash_2`");
    expect(prompt).toContain("re-arm the ones you still need");
    // Idle at exit: no in-flight tool call to go looking for.
    expect(prompt).not.toContain("in flight");
  });

  it("adds the cut-off lines only when a turn was in flight", () => {
    const prompt = processExitNudgePrompt({ midTurn: true, orphanedTasks: [] });
    expect(prompt).toContain("Any tool call that was in flight never returned");
    expect(prompt).not.toContain("died with it");
  });

  it("points both prompts at a transient systemd unit", () => {
    const systemdRun = "systemd-run --user --unit=<name> --setenv=VAR=value <command>";
    expect(processExitNudgePrompt({ midTurn: true, orphanedTasks: [] })).toContain(systemdRun);
    const restartPrompt = restartNudgePrompt({ midTurn: true, orphanedTasks: [] });
    expect(restartPrompt).toContain(systemdRun);
    expect(restartPrompt).toContain("Monitors started before the restart died with it");
    expect(restartNudgePrompt({ midTurn: false, orphanedTasks: [MONITOR] })).toContain(systemdRun);
  });
});

describe("isNudgeEligibleThread", () => {
  const eligible = (thread: OrchestrationThreadShell, queued: Array<ThreadId> = []) =>
    isNudgeEligibleThread(thread, new Set(queued));

  it("accepts an ordinary interactive thread, whatever its turn state", () => {
    expect(eligible(idleStoppedShell())).toBe(true);
  });

  it("rejects the four kinds both triggers must leave alone", () => {
    const iterationThread = ThreadId.make(
      epicRunIterationThreadId({ runId: "run-1", iterationIndex: 2 }),
    );
    expect(eligible(shell({ id: iterationThread }))).toBe(false);
    expect(eligible(shell({ parentThreadId: ThreadId.make("thread-parent") }))).toBe(false);
    expect(eligible(shell({ settledOverride: "settled" }))).toBe(false);
    expect(eligible(shell(), [MID_TURN_THREAD])).toBe(false);
  });
});

describe("InterruptedTurnNudger.watchProcessExits", () => {
  it.effect("resumes an idle thread whose Monitors died and names them in the nudge", () =>
    Effect.gen(function* () {
      const { layer, dispatched } = harness({
        threads: [idleStoppedShell()],
        providerEvents: [
          exitEvent({ exitKind: "error", midTurn: false, orphanedTasks: [MONITOR] }),
        ],
      });

      yield* runExitWatcher(layer);

      expect(commandTypes(dispatched)).toEqual([
        "thread.session.stop",
        "thread.session.resume",
        "thread.turn.start",
      ]);
      expect(dispatched[0]).toMatchObject({ reason: PROCESS_EXIT_STOP_REASON });
      const start = turnStarts(dispatched)[0];
      expect(start).toMatchObject({ origin: "agent", message: { role: "user" } });
      const text = start?.type === "thread.turn.start" ? start.message.text : "";
      expect(text).toContain("bash_monitor_1");
      expect(text).not.toContain("in flight");
    }),
  );

  it.effect("resumes a thread whose process died mid-turn", () =>
    Effect.gen(function* () {
      const { layer, dispatched } = harness({
        threads: [shell({ turnState: "interrupted", activeTurnId: null })],
        providerEvents: [exitEvent({ exitKind: "error", midTurn: true })],
      });

      yield* runExitWatcher(layer);

      const start = turnStarts(dispatched)[0];
      const text = start?.type === "thread.turn.start" ? start.message.text : "";
      expect(text).toContain("Any tool call that was in flight never returned");
    }),
  );

  const ignored: ReadonlyArray<{
    readonly name: string;
    readonly thread: OrchestrationThreadShell;
    readonly event: ProviderRuntimeEvent;
    readonly queued?: ReadonlyArray<ThreadId>;
  }> = [
    {
      name: "a graceful exit",
      thread: idleStoppedShell(),
      event: exitEvent({ exitKind: "graceful", orphanedTasks: [MONITOR] }),
    },
    {
      name: "an idle, task-free exit",
      thread: idleStoppedShell(),
      event: exitEvent({ exitKind: "error", midTurn: false }),
    },
    (() => {
      const id = ThreadId.make(epicRunIterationThreadId({ runId: "run-1", iterationIndex: 0 }));
      return {
        name: "an epic-run iteration",
        thread: idleStoppedShell({ id }),
        event: exitEvent({ exitKind: "error", midTurn: true }, id),
      };
    })(),
    {
      name: "a subagent child",
      thread: idleStoppedShell({ parentThreadId: ThreadId.make("thread-parent") }),
      event: exitEvent({ exitKind: "error", midTurn: true }),
    },
    {
      name: "a settled thread",
      thread: idleStoppedShell({ settledOverride: "settled" }),
      event: exitEvent({ exitKind: "error", midTurn: true }),
    },
    {
      name: "a thread with a parked message",
      thread: idleStoppedShell(),
      event: exitEvent({ exitKind: "error", midTurn: true }),
      queued: [MID_TURN_THREAD],
    },
  ];
  for (const testCase of ignored) {
    it.effect(`ignores ${testCase.name}`, () =>
      Effect.gen(function* () {
        const { layer, dispatched } = harness({
          threads: [testCase.thread],
          providerEvents: [testCase.event],
          queuedMessageThreadIds: testCase.queued ?? [],
        });

        yield* runExitWatcher(layer);

        expect(dispatched).toEqual([]);
      }),
    );
  }

  it.effect("skips a second exit on the same thread within ten minutes", () =>
    Effect.gen(function* () {
      const event = exitEvent({ exitKind: "error", midTurn: true });
      const { layer, dispatched } = harness({
        threads: [idleStoppedShell()],
        providerEvents: [event, event],
      });

      yield* runExitWatcher(layer);

      expect(turnStarts(dispatched)).toHaveLength(1);
      expect(commandTypes(dispatched).filter((type) => type === "thread.session.resume")).toEqual([
        "thread.session.resume",
      ]);
    }),
  );

  it.effect("never settles a session a human started after the exit wait", () =>
    Effect.gen(function* () {
      const stopped = idleStoppedShell();
      const restarted = idleStoppedShell({ sessionStatus: "ready" });
      const { layer, dispatched } = harness({
        threads: [stopped],
        // Exit read, settle wait, nudge read, then the re-check before the
        // settle sees the human's new session.
        shellReads: [stopped, stopped, stopped, restarted],
        providerEvents: [exitEvent({ exitKind: "error", midTurn: true })],
      });

      yield* runExitWatcher(layer);

      expect(dispatched).toEqual([]);
    }),
  );

  it.effect("never resumes while the projection still shows the dead session running", () =>
    Effect.gen(function* () {
      const { layer, dispatched } = harness({
        // Still projected running: resuming now would let the late `stopped`
        // overwrite the resumed session.
        threads: [shell({ turnState: "running" })],
        providerEvents: [exitEvent({ exitKind: "error", midTurn: true })],
      });

      yield* runExitWatcher(layer, TestClock.adjust(Duration.seconds(16)));

      expect(dispatched).toEqual([]);
    }),
  );
});
