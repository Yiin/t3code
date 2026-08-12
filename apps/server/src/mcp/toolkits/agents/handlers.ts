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
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  makeThreadSettleWatch,
  resolveFinalAssistantMessage,
  resolveTurnAssistantMessage,
  type ThreadSettleTimings,
  type ThreadTurnState,
} from "../../../orchestration/ThreadSettleWatch.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { mirrorChildLifecycle, type ChildMirrorTarget } from "./childMirror.ts";
import {
  deregisterSpawn,
  listSpawnsOfParent,
  makeCancelChild,
  registerSpawn,
  spawnParentDepth,
  type SpawnWaiterOutcome,
} from "./SpawnRegistry.ts";
import {
  decideSpawn,
  makeSubagentChildThreadId,
  resolveSpawnWaitTimeoutMs,
  type SpawnPolicy,
} from "./spawnPolicy.ts";
import { readSpawnPolicy } from "./spawnPolicySource.ts";
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
const statusFromTurnState = (turnState: ThreadTurnState): Exclude<SpawnAgentStatus, "timeout"> => {
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

  // The client started its own tool-call clock before this handler ran, so the
  // wait's budget is measured from as early as this code can see.
  const handlerStartedAtMs = Date.parse(yield* nowIso);

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
  //
  // Two sources, deeper wins. The projection is the durable link and the
  // registry is the live one; a spawn registered in this process but not yet
  // projected must not read as top-level and slip past the depth cap.
  let projectedDepth = 0;
  let ancestorId = parentShell.parentThreadId;
  while (ancestorId !== null && projectedDepth < MAX_DEPTH_WALK) {
    projectedDepth += 1;
    const ancestor = yield* readShell(ancestorId);
    ancestorId = Option.isSome(ancestor) ? ancestor.value.parentThreadId : null;
  }
  const parentDepth = Math.max(projectedDepth, spawnParentDepth(scope.threadId));

  // Count live children from both sides, deduplicated by child thread id.
  //
  // The registry knows the spawns this process is waiting on right now; the
  // projection knows every child whose turn is still running, including one this
  // parent already timed out on and can no longer see. Neither alone bounds the
  // cap honestly, so a child counts if either says it is alive. The read stops
  // as soon as the cap is reached: a long-lived parent accumulates finished
  // children and there is no reason to read them all once the answer cannot
  // change.
  const liveChildIds = new Set<string>(
    listSpawnsOfParent(scope.threadId).map((registration) => registration.childThreadId),
  );
  const childThreadIds = yield* projection.listChildThreadIds(scope.threadId).pipe(
    Effect.mapError(
      (cause) =>
        new SpawnAgentError({
          reason: "parent-thread-missing",
          detail: `Could not list the subagents of thread ${scope.threadId}: ${cause.message}`,
        }),
    ),
  );
  for (const childThreadId of childThreadIds) {
    if (liveChildIds.size >= policy.maxConcurrentChildren) break;
    if (liveChildIds.has(childThreadId)) continue;
    const childShell = yield* readShell(childThreadId);
    if (Option.isSome(childShell) && isLiveChild(childShell.value.latestTurn)) {
      liveChildIds.add(childThreadId);
    }
  }

  const decision = decideSpawn({
    agentType: input.agent_type,
    parentThreadId: scope.threadId,
    parentDepth,
    liveChildCount: liveChildIds.size,
    policy,
  });
  if (decision._tag === "refused") {
    // A successful result on purpose. A hard tool error makes the model retry
    // the call; a clear refusal carries a `detail` telling it to do the work
    // itself, which is the only path left once `Task` and `Workflow` are denied.
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
   *
   * Everything after the wait is pinned to the turn the wait settled. The child
   * is idle for the length of this read, and a human can talk to it from the
   * drawer — that message starts a NEW turn, whose streaming reply would
   * otherwise be read as the newest assistant row and reported to the parent as
   * the answer it asked for. Reading the turn's own row instead, and taking the
   * status from the wait's own verdict rather than from whatever turn is latest
   * by then, closes the window on both halves of the result.
   */
  const settle = Effect.gen(function* () {
    const settledTurn = yield* watch.awaitTurnEnd(childThreadId, SPAWN_SETTLE_TIMINGS, null);
    const settled = yield* watch.readSettledFinalMessage(
      childThreadId,
      SPAWN_SETTLE_TIMINGS,
      settledTurn.turnId,
    );
    const thread = settled.snapshot?.thread;
    const status = statusFromTurnState(settledTurn.state);
    const text =
      (settledTurn.turnId === null
        ? resolveFinalAssistantMessage(thread)
        : resolveTurnAssistantMessage(thread, settledTurn.turnId)
      )?.text ?? null;
    // A session that errored usually leaves no assistant message, and an empty
    // result tells the parent nothing. Its `lastError` is the answer instead.
    const finalMessage =
      text ?? (status === "failed" ? (thread?.session?.lastError ?? null) : null);
    return { status, finalMessage };
  });

  /**
   * The second way this wait can end: someone cancelled one side of the pair.
   *
   * `SpawnRegistry` completes this deferred when the parent is interrupted or
   * the child is stopped from the drawer. Without it the parent would keep
   * polling a dead child until its 30-minute bound.
   */
  const completion = yield* Deferred.make<SpawnWaiterOutcome>();
  registerSpawn({
    parentThreadId: scope.threadId,
    childThreadId,
    startedAtMs,
    target,
    // Bound to this call's engine so the registry entry needs no context of its
    // own: whoever cancels runs the dispatches, but this decides what they are.
    cancel: makeCancelChild(childThreadId).pipe(
      Effect.provideService(OrchestrationEngineService, engine),
    ),
    complete: (outcome) => Deferred.succeed(completion, outcome).pipe(Effect.ignore),
  });

  // The mirror's vocabulary collapses "interrupted" and "stopped" into one row,
  // and the note the model reads needs them apart. The wait writes the finer
  // word here on its way through.
  const ended: { status: SpawnWaiterOutcome["status"] | "completed" | "failed" } = {
    status: "completed",
  };

  // Bounded by whichever runs out first: the configured wait, or what is left of
  // the calling client's own MCP tool-call ceiling. Overrunning that ceiling
  // replaces every result below with a transport error, and the child thread id
  // goes with it.
  const spawnWaitTimeoutMs = resolveSpawnWaitTimeoutMs({
    policy,
    driver: scope.providerDriver,
    elapsedMs: Math.max(0, Date.parse(yield* nowIso) - handlerStartedAtMs),
  });

  const wait = Effect.raceFirst(settle, Deferred.await(completion)).pipe(
    Effect.timeoutOption(Duration.millis(spawnWaitTimeoutMs)),
    Effect.map(
      Option.match({
        onNone: () => ({ _tag: "timeout" as const }),
        onSome: (result) => {
          ended.status = result.status;
          return {
            _tag: "settled" as const,
            status:
              result.status === "interrupted" || result.status === "stopped"
                ? ("stopped" as const)
                : result.status,
            ...(result.finalMessage !== null ? { summary: result.finalMessage } : {}),
          };
        },
      }),
    ),
  );

  const outcome = yield* mirrorChildLifecycle(target, wait).pipe(
    // Rule 3: the parent's MCP request went away. Detach — deregister, let the
    // progress fiber die with the scope, and leave the child running. Whether
    // an abort even reaches this handler is unverified, and killing a child on
    // an unproven signal is the worse failure.
    Effect.onInterrupt(() =>
      Effect.logInfo("subagent.spawn.detached", {
        parentThreadId: scope.threadId,
        childThreadId,
      }),
    ),
    // Every exit path drops the registration: settled, timeout, detach, and the
    // cancellation paths that already dropped it themselves.
    Effect.ensuring(Effect.sync(() => deregisterSpawn(scope.threadId, childThreadId))),
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
      note: `Subagent ${childThreadId} did not finish within ${formatWait(spawnWaitTimeoutMs)}, so this call stopped waiting. The subagent is still running and was not stopped. Open it from the subagent roster to watch it or talk to it. Carry on without its answer.`,
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
          : ended.status === "stopped"
            ? `Subagent ${childThreadId} was stopped from its own thread before it finished. Its answer, if any, is in finalMessage. Do not spawn it again unless you are asked to.`
            : `Subagent ${childThreadId} was interrupted before it finished.`,
  };
});

export const AgentsToolkitHandlersLive = AgentsToolkit.toLayer({
  // Read per call, not per layer: a settings change must reach the next spawn
  // without a server restart.
  spawn_agent: (input) => Effect.flatMap(readSpawnPolicy, (policy) => spawnAgent(policy, input)),
});
