/**
 * agents toolkit handlers - turn one `spawn_agent` call into a child thread.
 *
 * Read `./tools.ts` first: it carries the worktree decision and the provider
 * serialization cost that shape everything here.
 *
 * @module agents/handlers
 */
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ThreadId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  makeThreadSettleWatch,
  resolveFinalAssistantMessage,
  threadTurnState,
  type ThreadSettleTimings,
} from "../../../orchestration/ThreadSettleWatch.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { mirrorChildLifecycle, type ChildMirrorTarget } from "./childMirror.ts";
import {
  decideSpawn,
  makeSubagentChildThreadId,
  resolveSpawnPolicy,
  type SpawnPolicy,
} from "./spawnPolicy.ts";
import { AgentsToolkit, SpawnAgentError, type SpawnAgentStatus } from "./tools.ts";

/**
 * How far up the parent chain `parentDepth` is walked before giving up.
 *
 * The depth cap is 1, so a real chain is one or two hops. The bound only exists
 * so a cyclic or corrupt link cannot spin.
 */
const MAX_DEPTH_WALK = 8;

/**
 * How often the wait re-reads the child, and how long a final message must hold
 * still before it counts as settled.
 *
 * The numbers match `DEFAULT_POOL_POLL_INTERVAL_MS` and
 * `DEFAULT_POOL_QUIET_PERIOD_MS` (`packages/epic-core/src/runPolicy.ts:13-14`),
 * declared here rather than imported: the toolkit does not depend on
 * `@t3tools/epic-core`, and a subagent's cadence is free to drift from an epic
 * run's later without breaking anything.
 */
const SPAWN_SETTLE_TIMINGS: ThreadSettleTimings = {
  pollIntervalMs: 2000,
  quietPeriodMs: 1000,
};

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

/** A child that has not settled yet: no turn projected, or a running turn. */
const isLiveChild = (latestTurn: { readonly state: string } | null): boolean =>
  latestTurn === null || latestTurn.state === "running";

interface SpawnAgentInput {
  readonly agent_type: string;
  readonly description: string;
  readonly prompt: string;
  readonly model?: string | undefined;
}

/** The wait bound in words, for the timeout note the model reads. */
const formatWait = (ms: number): string =>
  ms >= 60_000
    ? `${String(Math.round(ms / 60_000))} minutes`
    : `${String(Math.round(ms / 1000))} seconds`;

/** How a settled child's turn state reads as a tool-result status. */
const statusFromTurnState = (
  turnState: ReturnType<typeof threadTurnState>,
): Exclude<SpawnAgentStatus, "timeout"> => {
  switch (turnState) {
    case "error":
      return "failed";
    case "interrupted":
      return "interrupted";
    // `null` means nothing projected a turn state at all, and `running` means
    // the turn row lagged behind the settle signal. Both read as completed,
    // matching the epic runner's own settle in `EpicRunnerPoolPorts.ts`.
    case "completed":
    case "running":
    case null:
      return "completed";
  }
};

/**
 * The handler body, with the policy passed in so a test can supply one without
 * reaching through the settings seam in `spawnPolicy.ts`.
 */
export const spawnAgent = Effect.fn("AgentsToolkit.spawnAgent")(function* (
  policy: SpawnPolicy,
  input: SpawnAgentInput,
) {
  const scope = yield* McpInvocationContext.requireMcpCapability("spawn-agent").pipe(
    Effect.mapError(
      (cause) =>
        new SpawnAgentError({
          reason: "capability-unavailable",
          detail: cause.message,
        }),
    ),
  );
  const engine = yield* OrchestrationEngineService;
  const projection = yield* ProjectionSnapshotQuery;
  const crypto = yield* Crypto.Crypto;

  const readShell = (threadId: ThreadId) =>
    projection.getThreadShellById(threadId).pipe(
      Effect.mapError(
        (cause) =>
          new SpawnAgentError({
            reason: "parent-thread-missing",
            detail: `Could not read thread ${threadId}: ${cause.message}`,
          }),
      ),
    );

  const parentShell = yield* readShell(scope.threadId).pipe(
    Effect.flatMap(
      Option.match({
        // A missing thread is a tool error, not a defect: the credential
        // outlived its thread, and the model can do nothing about it.
        onNone: () =>
          new SpawnAgentError({
            reason: "parent-thread-missing",
            detail: `Thread ${scope.threadId} is no longer active, so it cannot spawn a subagent.`,
          }),
        onSome: Effect.succeed,
      }),
    ),
  );

  // Depth: 0 for a top-level thread, +1 for each thread-backed ancestor.
  let parentDepth = 0;
  let ancestorId = parentShell.parentThreadId;
  while (ancestorId !== null && parentDepth < MAX_DEPTH_WALK) {
    parentDepth += 1;
    const ancestor = yield* readShell(ancestorId);
    ancestorId = Option.isSome(ancestor) ? ancestor.value.parentThreadId : null;
  }

  // Count live children, stopping as soon as the cap is reached: a long-lived
  // parent accumulates finished children and there is no reason to read them
  // all once the answer cannot change.
  const childThreadIds = yield* projection.listChildThreadIds(scope.threadId).pipe(
    Effect.mapError(
      (cause) =>
        new SpawnAgentError({
          reason: "parent-thread-missing",
          detail: `Could not list the subagents of thread ${scope.threadId}: ${cause.message}`,
        }),
    ),
  );
  let liveChildCount = 0;
  for (const childThreadId of childThreadIds) {
    if (liveChildCount >= policy.maxConcurrentChildren) break;
    const childShell = yield* readShell(childThreadId);
    if (Option.isSome(childShell) && isLiveChild(childShell.value.latestTurn)) {
      liveChildCount += 1;
    }
  }

  const decision = decideSpawn({
    agentType: input.agent_type,
    parentThreadId: scope.threadId,
    parentDepth,
    liveChildCount,
    policy,
  });
  if (decision._tag === "refused") {
    // A successful result on purpose. A hard tool error makes the model retry;
    // a clear refusal makes it fall back to its built-in Task tool.
    return { spawned: false as const, reason: decision.reason, detail: decision.detail };
  }

  const uuid = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
  // Reads as `interactive` to `sessionReapPolicy.ts` (only epic-run iteration
  // ids parse out), so an idle finished child holds its provider session for
  // the 36 h interactive backstop. Known cost, not an accident.
  const childThreadId = ThreadId.make(makeSubagentChildThreadId(scope.threadId, uuid));
  const trimmedDescription = input.description.trim();
  const title =
    trimmedDescription.length > 0 ? trimmedDescription : `Subagent: ${input.agent_type}`;
  const trimmedModel = input.model?.trim() ?? "";
  // The model id is resolved against the parent's instance. A cross-instance
  // child would be a different account, so `instanceId` is never overridable.
  const modelSelection =
    trimmedModel.length > 0
      ? { ...parentShell.modelSelection, model: trimmedModel }
      : parentShell.modelSelection;

  const dispatch = (command: Parameters<typeof engine.dispatch>[0]) =>
    engine.dispatch(command).pipe(
      Effect.asVoid,
      Effect.mapError(
        (cause) =>
          new SpawnAgentError({
            reason: "dispatch-failed",
            detail: `Could not ${command.type} for subagent ${childThreadId}: ${cause.message}`,
          }),
      ),
    );

  const startedAtMs = Date.parse(yield* nowIso);
  const createdAt = yield* nowIso;
  yield* dispatch({
    type: "thread.create",
    commandId: CommandId.make(`server:spawn-agent-create:${uuid}`),
    threadId: childThreadId,
    projectId: parentShell.projectId,
    title,
    modelSelection,
    runtimeMode: parentShell.runtimeMode,
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    // The child works in the parent's tree, verbatim. See the module doc in
    // `./tools.ts` for why, and what it costs.
    branch: parentShell.branch,
    worktreePath: parentShell.worktreePath,
    parentThreadId: scope.threadId,
    createdAt,
  });

  yield* dispatch({
    type: "thread.turn.start",
    commandId: CommandId.make(`server:spawn-agent-turn:${uuid}`),
    threadId: childThreadId,
    message: {
      messageId: MessageId.make(`${childThreadId}-prompt`),
      role: "user",
      text: input.prompt,
      attachments: [],
    },
    modelSelection,
    runtimeMode: parentShell.runtimeMode,
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    createdAt: yield* nowIso,
  });

  // The parent's roster row opens only now that the child's turn is really
  // starting: the row is the promise that a subagent exists, and a failed start
  // would leave that promise standing for the 15-minute freshness window with
  // nothing behind it. Every append is best-effort — see `./childMirror.ts`.
  const target: ChildMirrorTarget = {
    parentThreadId: scope.threadId,
    parentTurnId: parentShell.latestTurn?.turnId ?? null,
    childThreadId,
    agentType: input.agent_type,
    description: title,
    prompt: input.prompt,
  };

  const watch = makeThreadSettleWatch({
    projectionSnapshotQuery: projection,
    logPrefix: "subagent.spawn",
  });

  /**
   * Wait for the child's first turn to end and read what it said.
   *
   * The prior turn id is `null` on purpose: this child was created moments ago,
   * so it has no earlier turn whose settled state could be mistaken for this
   * one's end.
   */
  const settle = Effect.gen(function* () {
    yield* watch.awaitTurnEnd(childThreadId, SPAWN_SETTLE_TIMINGS, null);
    const settled = yield* watch.readSettledFinalMessage(childThreadId, SPAWN_SETTLE_TIMINGS);
    const thread = settled.snapshot?.thread;
    const status = statusFromTurnState(threadTurnState(thread));
    const text = resolveFinalAssistantMessage(thread)?.text ?? null;
    // A session that errored usually leaves no assistant message, and an empty
    // result tells the parent nothing. Its `lastError` is the answer instead.
    const finalMessage =
      text ?? (status === "failed" ? (thread?.session?.lastError ?? null) : null);
    return { status, finalMessage };
  });

  const outcome = yield* mirrorChildLifecycle(
    target,
    settle.pipe(
      Effect.timeoutOption(Duration.millis(policy.spawnWaitTimeoutMs)),
      Effect.map(
        Option.match({
          onNone: () => ({ _tag: "timeout" as const }),
          onSome: (result) => ({
            _tag: "settled" as const,
            // The mirror's vocabulary calls an interrupted child "stopped".
            status: result.status === "interrupted" ? ("stopped" as const) : result.status,
            ...(result.finalMessage !== null ? { summary: result.finalMessage } : {}),
          }),
        }),
      ),
    ),
  );

  const elapsedMs = Math.max(0, Date.parse(yield* nowIso) - startedAtMs);

  if (outcome._tag === "timeout") {
    // The child keeps running and the mirror does not: the progress fiber died
    // with the wait's scope, so the parent's subagent row stops being refreshed
    // and ages out of `countFreshRunningSubagents` after
    // `RUNNING_SUBAGENT_FRESHNESS_MS`. That staleness is the failsafe — it is
    // what unblocks `activeSubagentCount` and the epic runner's subagent drain
    // when a child never settles. Stopping the child here would be wrong: the
    // human may still be talking to it in the drawer.
    const partial = yield* watch.readThreadDetail(childThreadId);
    return {
      spawned: true as const,
      childThreadId,
      agentType: input.agent_type,
      description: title,
      status: "timeout" as const,
      finalMessage: resolveFinalAssistantMessage(partial?.thread)?.text ?? null,
      elapsedMs,
      note: `Subagent ${childThreadId} did not finish within ${formatWait(policy.spawnWaitTimeoutMs)}, so this call stopped waiting. The subagent is still running and was not stopped. Open it from the subagent roster to watch it or talk to it. Carry on without its answer.`,
    };
  }

  const status: SpawnAgentStatus = outcome.status === "stopped" ? "interrupted" : outcome.status;
  const finalMessage = outcome.summary ?? null;
  return {
    spawned: true as const,
    childThreadId,
    agentType: input.agent_type,
    description: title,
    status,
    finalMessage,
    elapsedMs,
    note:
      status === "completed"
        ? `Subagent ${childThreadId} finished.`
        : status === "failed"
          ? `Subagent ${childThreadId} failed. Its answer, if any, is in finalMessage.`
          : `Subagent ${childThreadId} was interrupted before it finished.`,
  };
});

export const AgentsToolkitHandlersLive = AgentsToolkit.toLayer({
  spawn_agent: (input) => spawnAgent(resolveSpawnPolicy(), input),
});
