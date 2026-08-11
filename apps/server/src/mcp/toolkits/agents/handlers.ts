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
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { appendChildSpawned } from "./childMirror.ts";
import {
  decideSpawn,
  makeSubagentChildThreadId,
  resolveSpawnPolicy,
  type SpawnPolicy,
} from "./spawnPolicy.ts";
import { AgentsToolkit, SpawnAgentError } from "./tools.ts";

/**
 * How far up the parent chain `parentDepth` is walked before giving up.
 *
 * The depth cap is 1, so a real chain is one or two hops. The bound only exists
 * so a cyclic or corrupt link cannot spin.
 */
const MAX_DEPTH_WALK = 8;

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

  // Only after the child's turn is really starting: the parent's roster row is
  // the promise that a subagent exists, and a failed start would leave that
  // promise standing for the 15-minute freshness window with nothing behind it.
  // Best-effort from here on — see `./childMirror.ts`.
  yield* appendChildSpawned({
    parentThreadId: scope.threadId,
    parentTurnId: parentShell.latestTurn?.turnId ?? null,
    childThreadId,
    agentType: input.agent_type,
    description: title,
    prompt: input.prompt,
  });

  return {
    spawned: true as const,
    childThreadId,
    agentType: input.agent_type,
    description: title,
  };
});

export const AgentsToolkitHandlersLive = AgentsToolkit.toLayer({
  spawn_agent: (input) => spawnAgent(resolveSpawnPolicy(), input),
});
