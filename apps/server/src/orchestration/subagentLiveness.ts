import { type ThreadId } from "@t3tools/contracts";

export {
  RUNNING_SUBAGENT_FRESHNESS_MS,
  countFreshRunningSubagents,
  isFreshRunningSubagent,
} from "@t3tools/contracts";

/**
 * The stable marker consumers match on to distinguish "settle refused because
 * subagents are still working" from every other settle refusal. The EpicRunner
 * branches on it (wait for the subagents instead of stopping the session), so
 * changing this string is a behavior change, not a wording tweak.
 */
export const RUNNING_SUBAGENT_SETTLE_REFUSAL_MARKER = "running subagents still working";

export const runningSubagentSettleRefusalDetail = (threadId: ThreadId, count: number): string =>
  `thread ${threadId} has ${count} ${RUNNING_SUBAGENT_SETTLE_REFUSAL_MARKER} and cannot be settled`;

/** Whether a settle refusal (its `detail` or full error message) names running subagents. */
export const isRunningSubagentSettleRefusal = (message: string): boolean =>
  message.includes(RUNNING_SUBAGENT_SETTLE_REFUSAL_MARKER);
