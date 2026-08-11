/**
 * spawnPolicy - decides which subagent requests become real child threads.
 *
 * Locked decision: only long-running subagents get their own thread. Cheap
 * in-process ones stay inside the provider's built-in Task tool. This module is
 * the single pure home for that call, so the dispatch code in `handlers.ts`
 * never re-decides it.
 *
 * There is no duration threshold in v1. The tool must decide *before* the agent
 * runs, so duration is not observable at decision time. The agent-type allowlist
 * is the whole mechanism.
 *
 * Pure functions only: no Effect services, no I/O, no clock.
 *
 * @module spawnPolicy
 */

/**
 * Prefix every thread-backed child thread id carries.
 *
 * The id is the only marker a provider session has for "I am a subagent", so
 * mint and parse live here together and round-trip in one test. `handlers.ts`
 * mints it; `apps/server/src/provider/subagentSpawn.ts` reads it back.
 */
export const SUBAGENT_CHILD_THREAD_ID_PREFIX = "subagent-";

/** Mint the id of a thread-backed child of `parentThreadId`. */
export const makeSubagentChildThreadId = (parentThreadId: string, uuid: string): string =>
  `${SUBAGENT_CHILD_THREAD_ID_PREFIX}${parentThreadId}-${uuid}`;

/** True when this thread is itself a thread-backed subagent. */
export const isSubagentChildThreadId = (threadId: string): boolean =>
  threadId.startsWith(SUBAGENT_CHILD_THREAD_ID_PREFIX);

/** Why a spawn request was refused. Each maps to one prose `detail`. */
export type SpawnRefusalReason =
  | "disabled"
  | "agent-type-not-allowed"
  | "depth-cap"
  | "concurrency-cap";

export type SpawnDecision =
  | { readonly _tag: "threadBacked" }
  | { readonly _tag: "refused"; readonly reason: SpawnRefusalReason; readonly detail: string };

export interface SpawnPolicy {
  /** Thread-backed spawning is opt-in until compliance is measured. */
  readonly enabled: boolean;
  /**
   * Agent types that may become child threads, matched case-insensitively after
   * trimming. Empty together with `enabled: true` means "any agent type".
   */
  readonly allowedAgentTypes: ReadonlyArray<string>;
  /** A child may not spawn a grandchild. */
  readonly maxDepth: number;
  /** How many thread-backed children of one parent may run at once. */
  readonly maxConcurrentChildren: number;
}

export const DEFAULT_SPAWN_POLICY: SpawnPolicy = {
  enabled: false,
  allowedAgentTypes: [],
  maxDepth: 1,
  maxConcurrentChildren: 3,
};

/**
 * SETTINGS SEAM: the only place the policy value is produced.
 *
 * When the contracts area lands a `subagentSpawn` settings block (mirroring the
 * `epicRolePolicy` precedent in `packages/contracts/src/epicRolePolicy.ts` and
 * `packages/contracts/src/settings.ts`), read it here and fall back to
 * `DEFAULT_SPAWN_POLICY` for the fields it omits. Nothing else in the toolkit
 * may reach for settings.
 */
export const resolveSpawnPolicy = (): SpawnPolicy => DEFAULT_SPAWN_POLICY;

export interface SpawnPolicyInput {
  /** The agent type exactly as the model asked for it. */
  readonly agentType: string;
  readonly parentThreadId: string;
  /** 0 for a top-level thread. How it is computed is the caller's job. */
  readonly parentDepth: number;
  /** Thread-backed children of this parent that are currently running. */
  readonly liveChildCount: number;
  readonly policy: SpawnPolicy;
}

const normalizeAgentType = (agentType: string): string => agentType.trim().toLowerCase();

const refused = (reason: SpawnRefusalReason, detail: string): SpawnDecision => ({
  _tag: "refused",
  reason,
  detail,
});

/**
 * Decide whether one spawn request becomes a child thread.
 *
 * Every refusal `detail` is prose handed straight back to the model, so it must
 * say what to do instead rather than just what went wrong.
 */
export const decideSpawn = (input: SpawnPolicyInput): SpawnDecision => {
  const { policy } = input;

  if (!policy.enabled) {
    return refused(
      "disabled",
      "Thread-backed subagents are turned off on this server. Use your built-in Task tool instead.",
    );
  }

  if (policy.allowedAgentTypes.length > 0) {
    const requested = normalizeAgentType(input.agentType);
    const allowed = policy.allowedAgentTypes.some(
      (candidate) => normalizeAgentType(candidate) === requested,
    );
    if (!allowed) {
      return refused(
        "agent-type-not-allowed",
        `Agent type "${input.agentType}" is not allowed to run as its own thread. Allowed types: ${policy.allowedAgentTypes.join(", ")}. Use your built-in Task tool for this agent type.`,
      );
    }
  }

  if (input.parentDepth >= policy.maxDepth) {
    return refused(
      "depth-cap",
      `Thread ${input.parentThreadId} is already ${String(input.parentDepth)} level(s) deep and the limit is ${String(policy.maxDepth)}. A subagent may not spawn its own thread-backed subagent. Use your built-in Task tool instead.`,
    );
  }

  if (input.liveChildCount >= policy.maxConcurrentChildren) {
    return refused(
      "concurrency-cap",
      `Thread ${input.parentThreadId} already has ${String(input.liveChildCount)} thread-backed subagents running and the limit is ${String(policy.maxConcurrentChildren)}. Wait for one to finish before spawning another, or use your built-in Task tool.`,
    );
  }

  return { _tag: "threadBacked" };
};
