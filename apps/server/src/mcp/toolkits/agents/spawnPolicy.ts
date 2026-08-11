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
import type { SubagentSpawnSettings } from "@t3tools/contracts";

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
  /**
   * How long the parent's `spawn_agent` call waits for the child before it
   * returns a `timeout` result and carries on.
   *
   * A tenth of the epic runner's `DEFAULT_ITERATION_TIMEOUT_MS`
   * (`packages/epic-core/src/policy.ts:11`): a subagent is not an epic
   * iteration, and the parent is holding an HTTP request open the whole time.
   * If a provider's own MCP tool-call ceiling turns out to be shorter than this,
   * lower it below that ceiling — a transport error loses the child thread id,
   * where our timeout result keeps it.
   */
  readonly spawnWaitTimeoutMs: number;
}

export const DEFAULT_SPAWN_POLICY: SpawnPolicy = {
  enabled: false,
  allowedAgentTypes: [],
  maxDepth: 1,
  maxConcurrentChildren: 3,
  spawnWaitTimeoutMs: 30 * 60_000,
};

/**
 * SETTINGS SEAM: the only place the policy value is produced.
 *
 * Reads the `subagentSpawn` settings block and falls back to
 * `DEFAULT_SPAWN_POLICY` field by field, so a block that sets only `enabled`
 * still gets every cap. No argument means no block, which is the default
 * policy: off. Nothing else in the toolkit may reach for settings.
 *
 * `./spawnPolicySource.ts` is what fetches the block from the settings service;
 * this stays pure so the fallback rules are testable without one.
 */
export const resolveSpawnPolicy = (settings?: SubagentSpawnSettings): SpawnPolicy => ({
  enabled: settings?.enabled ?? DEFAULT_SPAWN_POLICY.enabled,
  allowedAgentTypes: settings?.allowedAgentTypes ?? DEFAULT_SPAWN_POLICY.allowedAgentTypes,
  maxDepth: settings?.maxDepth ?? DEFAULT_SPAWN_POLICY.maxDepth,
  maxConcurrentChildren:
    settings?.maxConcurrentChildren ?? DEFAULT_SPAWN_POLICY.maxConcurrentChildren,
  spawnWaitTimeoutMs: settings?.spawnWaitTimeoutMs ?? DEFAULT_SPAWN_POLICY.spawnWaitTimeoutMs,
});

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
 *
 * What it may say depends on which refusal it is. Reaching `disabled` means the
 * policy is off, and a session with the policy off keeps its built-in delegation
 * tools, so that one refusal can honestly point at them. Every other refusal
 * needs `policy.enabled`, and an enabled policy is exactly when
 * `SUBAGENT_SPAWN_DISALLOWED_TOOLS` takes `Task` and `Workflow` away. Telling
 * the model to fall back to a tool it no longer has produced the measured
 * pathology in t3code-vzb.23: 8 refused retries with a different `agent_type` in
 * one run, or an escape to `Workflow`. So they tell it to do the work itself.
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
        `Agent type "${input.agentType}" is not allowed to run as its own thread. Allowed types: ${policy.allowedAgentTypes.join(", ")}. Spawn one of those if it fits the task, otherwise do this work yourself: your built-in delegation tools are turned off on this session, so there is nothing to fall back to.`,
      );
    }
  }

  if (input.parentDepth >= policy.maxDepth) {
    return refused(
      "depth-cap",
      `Thread ${input.parentThreadId} is already ${String(input.parentDepth)} level(s) deep and the limit is ${String(policy.maxDepth)}. A subagent may not spawn its own thread-backed subagent. Do this work yourself: your built-in delegation tools are turned off on this session, so there is nothing to fall back to.`,
    );
  }

  if (input.liveChildCount >= policy.maxConcurrentChildren) {
    return refused(
      "concurrency-cap",
      `Thread ${input.parentThreadId} already has ${String(input.liveChildCount)} thread-backed subagents running and the limit is ${String(policy.maxConcurrentChildren)}. Wait for one to finish before spawning another, or do this work yourself: your built-in delegation tools are turned off on this session, so there is nothing to fall back to.`,
    );
  }

  return { _tag: "threadBacked" };
};
