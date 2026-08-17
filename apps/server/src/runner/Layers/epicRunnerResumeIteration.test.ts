/**
 * Adopting an interrupted iteration: what the server dispatch does with each
 * answer the resume command can settle on.
 *
 * The two things worth pinning are the ordering and the error channel. No
 * prompt may reach the agent until continuity is proved, and a foreseeable
 * "cannot resume" must come back as a value the loop can act on, not as a
 * failure that looks like a broken machine.
 */
import {
  MessageId,
  PROVIDER_SESSION_RESUME_SETTLED_ACTIVITY_KIND,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type ProviderSessionResumeOutcome,
} from "@t3tools/contracts";
import type { PoolTimings } from "@t3tools/epic-core/ParallelEpicLoop";
import type { ResumableIteration } from "@t3tools/epic-core/ports/PoolDispatch";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { OrchestrationEngineShape } from "../../orchestration/Services/OrchestrationEngine.ts";
import type { ProjectionSnapshotQueryShape } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { makeServerPoolDispatch } from "./PoolDispatch.ts";

const threadId = ThreadId.make("thread-iteration-7");
/** The turn the dead process left behind. A resumed wait must ignore it. */
const DEAD_TURN_ID = "turn-before-restart";
const LIVE_TURN_ID = "turn-after-resume";

const policy = {
  pollIntervalMs: 1,
  quietPeriodMs: 1,
  subagentGraceTimeoutMs: 10,
  maxGraceContinuations: 1,
} as unknown as PoolTimings;

function harness(outcome: ProviderSessionResumeOutcome) {
  const dispatched: OrchestrationCommand[] = [];
  const activities: Array<{
    readonly kind: string;
    readonly payload: unknown;
  }> = [];

  const engine = {
    dispatch: (command: OrchestrationCommand) => {
      dispatched.push(command);
      if (command.type === "thread.session.resume") {
        // Stand in for the reactor: the answer arrives as a durable activity
        // carrying the commandId of the request it settles.
        activities.push({
          kind: PROVIDER_SESSION_RESUME_SETTLED_ACTIVITY_KIND,
          payload: {
            threadId,
            requestCommandId: command.commandId,
            outcome,
          },
        });
      }
      return Effect.succeed({ sequence: dispatched.length });
    },
  } as unknown as OrchestrationEngineShape;

  const thread = {
    id: threadId,
    activities,
    subagents: [],
    messages: [
      {
        id: MessageId.make("assistant-1"),
        role: "assistant",
        text: "RALPH_DONE",
        streaming: false,
      },
    ],
    latestTurn: { turnId: DEAD_TURN_ID, state: "completed", assistantMessageId: null },
    session: { status: "ready", lastError: null },
  };

  const projectionSnapshotQuery = {
    getThreadDetailSnapshot: () => Effect.succeed(Option.some({ thread })),
    // The shell already shows the turn the resumed prompt started, so a wait
    // pinned to the dead turn still settles.
    getThreadShellById: () =>
      Effect.succeed(
        Option.some({
          latestTurn: { turnId: LIVE_TURN_ID, state: "completed" },
          session: { status: "ready" },
        }),
      ),
  } as unknown as ProjectionSnapshotQueryShape;

  const processRunner = {
    // `git rev-parse` answering with a commit makes the grace loop settle on
    // head-moved, which is the shortest honest path through it.
    run: () =>
      Effect.succeed({
        stdout: "abc123\n",
        stderr: "",
        code: 0,
        timedOut: false,
        stdoutTruncated: false,
        stderrTruncated: false,
      }),
  } as never;

  const dispatch = makeServerPoolDispatch({
    engine,
    projectionSnapshotQuery,
    processRunner,
    projectSetupScriptRunner: {} as never,
    crypto: { randomUUIDv4: Effect.succeed("uuid-1") } as never,
    workerScopeRegistry: {} as never,
    subagentRegistry: {} as never,
    readIterationSubagents: () => Effect.succeed({}),
  });

  const input: ResumableIteration = {
    ref: threadId,
    runId: "run-7" as ResumableIteration["runId"],
    iterationIndex: 7,
    issueId: "t3code-y5l.8",
    prompt: "Carry on where you left off",
    selection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
    runtimeMode: "full-access",
    policy,
    workspace: {
      cwd: "/tmp/wt",
      worktreePath: "/tmp/wt",
      branch: "epic/t3code-y5l.8",
      siblingWorktrees: [],
      siblingRule: null,
    },
    headBefore: null,
    branchBase: null,
    initialWorktreeFingerprint: null,
  };

  return { dispatch, dispatched, input };
}

const turnStarts = (commands: ReadonlyArray<OrchestrationCommand>) =>
  commands.filter((command) => command.type === "thread.turn.start");

describe("epic runner resumeIteration", () => {
  it.effect("sends the prompt only after the session is proved continued", () =>
    Effect.gen(function* () {
      const { dispatch, dispatched, input } = harness({ _tag: "resumed" });

      const outcome = yield* dispatch.resumeIteration(input);

      expect(outcome._tag).toBe("resumed");
      const order = dispatched.map((command) => command.type);
      expect(order).toEqual(["thread.session.resume", "thread.turn.start"]);
      const start = turnStarts(dispatched)[0];
      expect(start).toMatchObject({ origin: "agent", message: { role: "user" } });
      // Never the id the interrupted iteration's own prompt already used.
      expect(start?.type === "thread.turn.start" && start.message.messageId).not.toBe(
        `${threadId}-prompt`,
      );
    }),
  );

  // Live clock: the settle and final-message reads poll on real sleeps.
  it.live("hands back a handle indistinguishable from a fresh iteration's", () =>
    Effect.gen(function* () {
      const { dispatch, input } = harness({ _tag: "resumed" });

      const outcome = yield* dispatch.resumeIteration(input);
      if (outcome._tag !== "resumed") {
        throw new Error(`expected a resumed handle, got ${outcome._tag}`);
      }
      const fresh = yield* dispatch.beginTurn({ ...input, threadId });

      expect(outcome.handle.ref).toBe(threadId);
      expect(outcome.handle.capabilities).toEqual(fresh.capabilities);
      expect(yield* outcome.handle.awaitSettled).toEqual(yield* fresh.awaitSettled);
      expect(yield* outcome.handle.finalMessage).toEqual(yield* fresh.finalMessage);
    }),
  );

  it.effect("returns a capability refusal as a value, not a failure", () =>
    Effect.gen(function* () {
      const { dispatch, dispatched, input } = harness({
        _tag: "capability",
        detail: "Provider instance 'codex' cannot resume a past conversation.",
      });

      const outcome = yield* dispatch.resumeIteration(input);

      expect(outcome).toEqual({
        _tag: "unavailable",
        refusal: {
          _tag: "capability",
          detail: "Provider instance 'codex' cannot resume a past conversation.",
        },
      });
      expect(turnStarts(dispatched)).toHaveLength(0);
    }),
  );

  it.effect("maps a missing durable state to its own refusal arm", () =>
    Effect.gen(function* () {
      const { dispatch, dispatched, input } = harness({
        _tag: "no-durable-state",
        detail: "no persisted resume cursor",
      });

      const outcome = yield* dispatch.resumeIteration(input);

      expect(outcome).toEqual({
        _tag: "unavailable",
        refusal: { _tag: "no-durable-state", detail: "no persisted resume cursor" },
      });
      expect(turnStarts(dispatched)).toHaveLength(0);
    }),
  );

  it.effect("carries the origin through a not-continued refusal", () =>
    Effect.gen(function* () {
      const { dispatch, dispatched, input } = harness({
        _tag: "not-continued",
        origin: "started-fresh",
        detail: "provider started a blank session",
      });

      const outcome = yield* dispatch.resumeIteration(input);

      expect(outcome).toEqual({
        _tag: "unavailable",
        refusal: {
          _tag: "not-continued",
          origin: "started-fresh",
          detail: "provider started a blank session",
        },
      });
      expect(turnStarts(dispatched)).toHaveLength(0);
    }),
  );

  it.effect("returns an infra fault as a refusal, not a failure", () =>
    Effect.gen(function* () {
      const { dispatch, dispatched, input } = harness({
        _tag: "failed",
        detail: "provider service exploded",
      });

      const outcome = yield* dispatch.resumeIteration(input);

      expect(outcome).toEqual({
        _tag: "unavailable",
        refusal: {
          _tag: "failed",
          detail: "provider service exploded",
        },
      });
      expect(turnStarts(dispatched)).toHaveLength(0);
    }),
  );
});
