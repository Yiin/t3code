import { type ThreadId } from "@t3tools/contracts";

export {
  RUNNING_SUBAGENT_FRESHNESS_MS,
  countFreshRunningSubagents,
  isFreshRunningSubagent,
} from "@t3tools/contracts";

/**
 * The stable marker consumers match on to distinguish a lifecycle refusal
 * caused by running subagents. Changing this string is a behavior change.
 */
export const RUNNING_SUBAGENT_LIVENESS_REFUSAL_MARKER = "running subagents still working";

export const runningSubagentLivenessRefusalDetail = (
  threadId: ThreadId,
  count: number,
  action: "settled" | "stopped",
): string =>
  `thread ${threadId} has ${count} ${RUNNING_SUBAGENT_LIVENESS_REFUSAL_MARKER} and cannot be ${action}`;

/** Whether a lifecycle refusal names fresh running subagents. */
export const isRunningSubagentLivenessRefusal = (message: string): boolean =>
  message.includes(RUNNING_SUBAGENT_LIVENESS_REFUSAL_MARKER);
