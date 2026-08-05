import type { OrchestrationThreadSubagent } from "@t3tools/contracts";
import type { ThreadId } from "@t3tools/contracts";

/**
 * How recently a `running` subagent row must have been touched to count as
 * live work. Rows only leave `running` via `task.completed`/`task.updated`
 * activities or a terminal session status (`closeRunningSubagentsForSession`),
 * so a row stranded by a crashed server would otherwise block its consumers
 * forever — the freshness bound is what lets them trust the read model at all.
 *
 * Shared by every consumer of running-subagent state (the settle invariant in
 * `decider.ts`, the auto-settle candidate query, the EpicRunner grace wait,
 * and the session reap policy) so "still working" means one thing.
 *
 * The bound trades against long tool calls: `task.progress` arrives at
 * tool-call cadence, so a subagent inside a single quiet call longer than
 * this window reads as stale and stops being protected.
 */
export const RUNNING_SUBAGENT_FRESHNESS_MS = 15 * 60 * 1_000;

/**
 * The subagents that count as live work right now: `running`, and touched
 * within the freshness window. `updatedAt` is stamped from the server's own
 * clock (activity `createdAt`), so unlike the decider's queued-turn guard no
 * cross-device skew bound is needed; a future timestamp simply reads fresh.
 */
export const countFreshRunningSubagents = (
  subagents: ReadonlyArray<Pick<OrchestrationThreadSubagent, "status" | "updatedAt">>,
  nowMs: number,
): number => {
  let count = 0;
  for (const subagent of subagents) {
    if (subagent.status !== "running") continue;
    const updatedAtMs = Date.parse(subagent.updatedAt);
    if (Number.isNaN(updatedAtMs)) continue;
    if (nowMs - updatedAtMs <= RUNNING_SUBAGENT_FRESHNESS_MS) {
      count += 1;
    }
  }
  return count;
};

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
