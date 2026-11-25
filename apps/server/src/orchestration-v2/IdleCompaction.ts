import { isListedThreadLineage, type OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import { COMPACTION_SUGGESTION_MIN_TOKENS } from "@t3tools/shared/claudeCompaction";
import { derivePendingBackgroundWork } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import * as DateTime from "effect/DateTime";

// Claude Code's idleCompaction defaults to 200K and won't go below 100K. Below
// that a cold re-read is cheap, so compacting mostly loses context for little
// saving.
const MIN_CONTEXT_TOKENS = COMPACTION_SUGGESTION_MIN_TOKENS;
// Start this long before the cache expires: enough for the session to resume
// and send the compaction while the cache is still warm.
const LEAD_MS = 2 * 60_000;
// Antigravity ACP does not report an explicit prompt-cache TTL and Gemini's
// implicit cache cools quickly, so compact shortly after a turn settles
// (between jobs) while the cache is still hot.
export const ANTIGRAVITY_IDLE_COMPACTION_DELAY_MS = 30_000;
const ANTIGRAVITY_IDLE_COMPACTION_MAX_AGE_MS = 10 * 60_000;

export type IdleCompactionRecords = Pick<
  OrchestrationV2ThreadProjection,
  | "thread"
  | "runs"
  | "messages"
  | "providerThreads"
  | "providerTurns"
  | "runtimeRequests"
  | "turnItems"
  | "contextTransfers"
>;

/**
 * When an idle Claude or Antigravity thread should compact, or null when it
 * should not. Claude waits until shortly before its reported prompt cache
 * expires (1h on subscriptions, 5m on API keys); Antigravity compacts after a
 * short debounce between jobs while Gemini's implicit cache is still warm.
 */
export function idleCompactionWindow(
  {
    thread,
    runs,
    messages,
    providerThreads,
    providerTurns,
    runtimeRequests,
    turnItems,
    contextTransfers,
  }: IdleCompactionRecords,
  nowMs: number,
  options?: { readonly minTokens?: number },
): {
  readonly runId: (typeof runs)[number]["id"];
  readonly startMs: number;
  readonly endMs: number;
} | null {
  if (thread.deletedAt !== null || thread.archivedAt !== null) return null;
  if (thread.settledAt !== null || thread.settledOverride === "settled") return null;
  if (thread.snoozedUntil != null && DateTime.toEpochMillis(thread.snoozedUntil) > nowMs)
    return null;
  if (!isListedThreadLineage(thread.lineage)) return null;
  // A removed or steered queued message leaves a cancelled run that never started.
  const latestRun = runs
    .filter((run) => run.status !== "cancelled" || run.startedAt !== null)
    .reduce<(typeof runs)[number] | null>(
      (latest, run) => (latest === null || run.ordinal > latest.ordinal ? run : latest),
      null,
    );
  if (latestRun?.status !== "completed" || latestRun.completedAt === null) return null;
  const message = messages.find((candidate) => candidate.id === latestRun.userMessageId);
  // Never compact a compaction, so one idle spell compacts at most once.
  if (message === undefined || message.text.trim().toLowerCase() === "/compact") return null;
  if (
    runtimeRequests.some((request) => request.status === "pending") ||
    // A pending merge-back belongs to the user's next message.
    contextTransfers.some(
      (transfer) =>
        transfer.type === "merge_back" &&
        transfer.targetThreadId === thread.id &&
        transfer.status === "pending",
    ) ||
    // Background work reports into the next turn; compaction would swallow it. A delegated
    // child's result arrives later as its own message, so it does not count.
    derivePendingBackgroundWork({
      latestRun,
      runs,
      providerThreads,
      turnItems: turnItems.filter(
        (item) => item.type !== "subagent" || item.origin !== "app_owned",
      ),
      activeProviderThreadId: thread.activeProviderThreadId,
    }).length > 0
  )
    return null;
  const providerThread = providerThreads.find(
    (candidate) => candidate.id === thread.activeProviderThreadId,
  );
  const minTokens = options?.minTokens ?? MIN_CONTEXT_TOKENS;
  // The thread's current selection receives the /compact, so it must still be this session.
  if (
    (providerThread?.driver !== "claudeAgent" && providerThread?.driver !== "antigravity") ||
    providerThread.id !== latestRun.providerThreadId ||
    providerThread.providerInstanceId !== thread.providerInstanceId ||
    latestRun.providerInstanceId !== thread.providerInstanceId
  )
    return null;
  const usages = providerTurns
    .filter((turn) => turn.providerThreadId === providerThread.id && turn.tokenUsage !== undefined)
    .map((turn) => turn.tokenUsage!)
    .toSorted((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  if (providerThread.driver === "antigravity") {
    const usedTokens = providerThread.contextUsage?.usedTokens ?? usages[0]?.usedTokens ?? 0;
    if (usedTokens < minTokens) return null;
    const completedAtMs = DateTime.toEpochMillis(latestRun.completedAt);
    const startMs = completedAtMs + ANTIGRAVITY_IDLE_COMPACTION_DELAY_MS;
    const endMs = completedAtMs + ANTIGRAVITY_IDLE_COMPACTION_MAX_AGE_MS;
    if (nowMs >= endMs) return null;
    return { runId: latestRun.id, startMs, endMs };
  }
  if ((usages[0]?.usedTokens ?? 0) < minTokens) return null;
  // A request served fully from cache creates no cache entry and reports no
  // TTL, but it still refreshes the cache. Treat it as unknown and skip.
  const expiresAt = usages[0]?.promptCacheExpiresAt;
  const endMs = expiresAt === undefined ? Number.NaN : Date.parse(expiresAt);
  if (!Number.isFinite(endMs) || nowMs >= endMs) return null;
  return { runId: latestRun.id, startMs: endMs - LEAD_MS, endMs };
}
