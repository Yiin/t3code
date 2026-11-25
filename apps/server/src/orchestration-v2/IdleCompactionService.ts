import {
  CommandId,
  IDLE_COMPACTION_TEXT,
  MessageId,
  resolveIdleCompaction,
  resolveIdleCompactionThreshold,
  resolveProjectProviderInstanceEnabled,
  type ProviderInstanceId,
  type RunId,
  type ServerProvider,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Stream from "effect/Stream";

import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import { idleCompactionWindow } from "./IdleCompaction.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

function providerAdvertisesCompact(provider: ServerProvider | undefined): boolean {
  if (provider === undefined) return false;
  return (
    provider.slashCommands.some((command) => command.name === "compact") ||
    (provider.workspaceSnapshots?.some((workspace) =>
      workspace.slashCommands.some((command) => command.name === "compact"),
    ) ??
      false)
  );
}

/**
 * Beta: waits until an idle Claude or Antigravity run is due and dispatches
 * `/compact`. Timers live in memory, so a server restart skips waiting ones.
 */
export const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const settings = yield* ServerSettings.ServerSettingsService;
  const providers = yield* ProviderRegistry.ProviderRegistry;

  const instanceDriverOf = (
    current: Parameters<typeof resolveIdleCompaction>[0],
    instanceId: ProviderInstanceId,
  ) =>
    Object.hasOwn(current.providerInstances, instanceId)
      ? current.providerInstances[instanceId]?.driver
      : instanceId === "claudeAgent" || instanceId === "antigravity"
        ? instanceId
        : undefined;

  const supportsIdleCompaction = (
    current: Parameters<typeof resolveIdleCompaction>[0],
    instanceId: ProviderInstanceId,
  ) => {
    const driver = instanceDriverOf(current, instanceId);
    if (driver === "claudeAgent") return Effect.succeed(true);
    if (driver !== "antigravity") return Effect.succeed(false);
    return providers.getProviders.pipe(
      Effect.map((list) =>
        providerAdvertisesCompact(list.find((entry) => entry.instanceId === instanceId)),
      ),
    );
  };

  const compactWhenDue = Effect.fn("IdleCompactionService.compactWhenDue")(
    function* (threadId: ThreadId, completedRunId: RunId) {
      let runId = completedRunId;
      // Loops after the wait or a retarget: the thread may have moved on.
      while (true) {
        const current = yield* settings.getSettings;
        const thread = yield* projections.getThread(threadId);
        if (
          !(yield* supportsIdleCompaction(current, thread.providerInstanceId)) ||
          resolveIdleCompaction(current, thread.providerInstanceId) !== "beforeCacheExpires" ||
          !resolveProjectProviderInstanceEnabled(
            current,
            thread.projectId,
            thread.providerInstanceId,
          )
        )
          return;
        const activeProviderThreadIds =
          thread.activeProviderThreadId === null ? [] : [thread.activeProviderThreadId];
        const records = yield* projections.getThreadRecords(
          threadId,
          [
            "runs",
            "messages",
            "providerThreads",
            "providerTurns",
            "runtimeRequests",
            "turnItems",
            "contextTransfers",
          ],
          {
            messageRunIds: [runId],
            turnItemStatuses: ["pending", "running", "waiting"],
            // The latest run, active runs that hold background work, and rolled-back runs whose
            // items it ignores.
            runStatuses: ["preparing", "starting", "running", "rolled_back"],
            includeLatestRun: true,
            // Without an active provider thread there is no session to compact.
            providerThreadIds: activeProviderThreadIds,
            providerTurnThreadIds: activeProviderThreadIds,
            latestProviderTurnUsageOnly: true,
            runtimeRequestStatuses: ["pending"],
            contextTransferStatuses: ["pending"],
          },
        );
        if (
          !(yield* supportsIdleCompaction(current, records.thread.providerInstanceId)) ||
          resolveIdleCompaction(current, records.thread.providerInstanceId) !==
            "beforeCacheExpires" ||
          !resolveProjectProviderInstanceEnabled(
            current,
            records.thread.projectId,
            records.thread.providerInstanceId,
          )
        )
          return;
        const latestRun = records.runs
          .filter((run) => run.status !== "cancelled" || run.startedAt !== null)
          .reduce<(typeof records.runs)[number] | undefined>(
            (latest, run) => (latest === undefined || run.ordinal > latest.ordinal ? run : latest),
            undefined,
          );
        // A late update for an earlier run replaced the latest run's timer, so take it over.
        if (latestRun?.status === "completed" && latestRun.id !== runId) {
          runId = latestRun.id;
          continue;
        }
        const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
        const window = idleCompactionWindow(records, nowMs, {
          minTokens: resolveIdleCompactionThreshold(current, records.thread.providerInstanceId),
        });
        if (window?.runId !== runId) return;
        if (nowMs < window.startMs) {
          yield* Effect.sleep(Duration.millis(window.startMs - nowMs));
          continue;
        }
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          // One compaction per completed run, even across duplicate events.
          commandId: CommandId.make(`server:idle-compact:${threadId}:${runId}`),
          messageId: MessageId.make(`idle-compact:${threadId}:${runId}`),
          threadId,
          text: IDLE_COMPACTION_TEXT,
          attachments: [],
          createdBy: "agent",
          creationSource: "server",
          idleCompaction: "beforeCacheExpires",
          dispatchMode: { type: "start_immediately" },
        });
        return;
      }
    },
    (effect, threadId) =>
      effect.pipe(
        Effect.catch((cause) => Effect.logWarning("idle compaction skipped", { threadId, cause })),
      ),
  );

  const start = Effect.fn("IdleCompactionService.start")(function* () {
    // Keyed by thread: a newer completed run replaces the waiting timer.
    const timers = yield* FiberMap.make<ThreadId>();
    yield* forkParked(
      Stream.runForEach(orchestrator.streamDomainEvents, (event) =>
        event.type === "run.updated" && event.payload.status === "completed"
          ? FiberMap.run(timers, event.threadId, compactWhenDue(event.threadId, event.payload.id))
          : Effect.void,
      ),
    );
  });
  return { start };
});
