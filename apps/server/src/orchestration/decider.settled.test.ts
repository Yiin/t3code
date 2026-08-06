import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  THREAD_DETAIL_ACTIVITY_LIMIT,
  ThreadId,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type OrchestrationSession,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";
import {
  RUNNING_SUBAGENT_FRESHNESS_MS,
  isRunningSubagentLivenessRefusal,
} from "./subagentLiveness.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const SETTLED_AT = "2025-12-30T00:00:00.000Z";

function makeReadModel(
  settledOverride: OrchestrationThread["settledOverride"],
  archivedAt: string | null = null,
  session: OrchestrationSession | null = null,
  activities: OrchestrationThread["activities"] = [],
  messages: OrchestrationThread["messages"] = [],
  subagents: OrchestrationThread["subagents"] = [],
): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [
      {
        id: ProjectId.make("project-1"),
        title: "Project",
        workspaceRoot: "/repo",
        repositoryIdentity: null,
        defaultModelSelection: null,
        scripts: [],
        createdAt: NOW,
        updatedAt: NOW,
        deletedAt: null,
      },
    ],
    threads: [
      {
        id: ThreadId.make("thread-1"),
        projectId: ProjectId.make("project-1"),
        title: "Thread",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        latestTurn: null,
        createdAt: NOW,
        updatedAt: NOW,
        archivedAt,
        settledOverride,
        settledAt: settledOverride === "settled" ? SETTLED_AT : null,
        deletedAt: null,
        messages,
        proposedPlans: [],
        subagents,
        activities,
        checkpoints: [],
        session,
      },
    ],
    updatedAt: NOW,
  };
}

function makeSession(status: OrchestrationSession["status"]): OrchestrationSession {
  return {
    threadId: ThreadId.make("thread-1"),
    status,
    providerName: "Codex",
    runtimeMode: "full-access",
    activeTurnId: null,
    lastError: null,
    updatedAt: NOW,
  };
}

it.layer(NodeServices.layer)("settled thread decider", (it) => {
  it.effect("settles active threads and re-emits idempotently for settled ones", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.settle",
          commandId: CommandId.make("cmd-settle"),
          threadId: ThreadId.make("thread-1"),
        },
        readModel: makeReadModel(null),
      });
      const events = Array.isArray(event) ? event : [event];
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe("thread.settled");
      if (events[0]?.type === "thread.settled") {
        expect(events[0].payload.settledAt).toBe(events[0].payload.updatedAt);
      }

      // Already settled: the engine rejects zero-event commands, so idempotency
      // is by re-emission — preserving the original settledAt.
      const reEmit = yield* decideOrchestrationCommand({
        command: {
          type: "thread.settle",
          commandId: CommandId.make("cmd-settle-again"),
          threadId: ThreadId.make("thread-1"),
        },
        readModel: makeReadModel("settled"),
      });
      const reEmitEvents = Array.isArray(reEmit) ? reEmit : [reEmit];
      expect(reEmitEvents).toHaveLength(1);
      expect(reEmitEvents[0]?.type).toBe("thread.settled");
      if (reEmitEvents[0]?.type === "thread.settled") {
        expect(reEmitEvents[0].payload.settledAt).toBe(SETTLED_AT);
        // updatedAt must NOT rewind to the historical settledAt: sorting and
        // relative-time labels key on it.
        expect(reEmitEvents[0].payload.updatedAt).not.toBe(SETTLED_AT);
      }
    }),
  );

  it.effect("enriches a planned epic from authoritative thread and project state", () =>
    Effect.gen(function* () {
      const base = makeReadModel(null);
      const readModel: OrchestrationReadModel = {
        ...base,
        threads: [{ ...base.threads[0]!, worktreePath: "/repo/worktree" }],
      };
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.message.assistant.complete",
          commandId: CommandId.make("cmd-complete-plan"),
          threadId: ThreadId.make("thread-1"),
          messageId: MessageId.make("assistant-plan"),
          plannedEpicId: "t3code-vst",
          createdAt: NOW,
        },
        readModel,
      });
      const events = Array.isArray(event) ? event : [event];
      expect(events[0]?.type).toBe("thread.message-sent");
      if (events[0]?.type === "thread.message-sent") {
        expect(events[0].payload.correlation).toEqual({
          threadId: "thread-1",
          epicId: "t3code-vst",
          projectId: "project-1",
          cwd: "/repo/worktree",
        });
      }
    }),
  );

  it.effect("rejects settling a thread with a live session", () =>
    Effect.gen(function* () {
      for (const status of ["starting", "running"] as const) {
        const error = yield* decideOrchestrationCommand({
          command: {
            type: "thread.settle",
            commandId: CommandId.make(`cmd-settle-live-${status}`),
            threadId: ThreadId.make("thread-1"),
          },
          readModel: makeReadModel(null, null, makeSession(status)),
        }).pipe(Effect.flip);
        expect(error._tag).toBe("OrchestrationCommandInvariantError");
      }
      // Stopped/error sessions are settleable — only live work is protected.
      const settled = yield* decideOrchestrationCommand({
        command: {
          type: "thread.settle",
          commandId: CommandId.make("cmd-settle-stopped"),
          threadId: ThreadId.make("thread-1"),
        },
        readModel: makeReadModel(null, null, makeSession("stopped")),
      });
      const settledEvents = Array.isArray(settled) ? settled : [settled];
      expect(settledEvents[0]?.type).toBe("thread.settled");
    }),
  );

  it.effect(
    "rejects settling a thread with a fresh running subagent, until it completes or goes stale",
    () =>
      Effect.gen(function* () {
        const makeSubagent = (
          status: "running" | "completed",
          updatedAt: string,
        ): OrchestrationThread["subagents"][number] => ({
          subagentId: `subagent-${status}`,
          turnId: null,
          status,
          startedAt: updatedAt,
          updatedAt,
          completedAt: status === "completed" ? updatedAt : null,
        });
        // The decider reads the Effect clock. Keep both fixtures on that same
        // clock so this test remains deterministic under @effect/vitest.
        const now = yield* DateTime.now;
        const freshAt = DateTime.formatIso(now);
        const staleAt = DateTime.formatIso(
          DateTime.subtractDuration(now, Duration.millis(RUNNING_SUBAGENT_FRESHNESS_MS + 60_000)),
        );

        // Fresh running subagent: in-flight work, settle refused — with the
        // stable marker the EpicRunner branches on.
        const error = yield* decideOrchestrationCommand({
          command: {
            type: "thread.settle",
            commandId: CommandId.make("cmd-settle-subagent-fresh"),
            threadId: ThreadId.make("thread-1"),
          },
          readModel: makeReadModel(null, null, null, [], [], [makeSubagent("running", freshAt)]),
        }).pipe(Effect.flip);
        expect(error._tag).toBe("OrchestrationCommandInvariantError");
        expect(isRunningSubagentLivenessRefusal(error.message)).toBe(true);
        expect(error.message).toContain("thread-1");

        // Completed subagent: settleable, however fresh the row is.
        const completed = yield* decideOrchestrationCommand({
          command: {
            type: "thread.settle",
            commandId: CommandId.make("cmd-settle-subagent-completed"),
            threadId: ThreadId.make("thread-1"),
          },
          readModel: makeReadModel(null, null, null, [], [], [makeSubagent("completed", freshAt)]),
        });
        const completedEvents = Array.isArray(completed) ? completed : [completed];
        expect(completedEvents[0]?.type).toBe("thread.settled");

        // Running but stale: a row stranded by a dead session must not wedge
        // settlement forever — the freshness bound clears it.
        const stale = yield* decideOrchestrationCommand({
          command: {
            type: "thread.settle",
            commandId: CommandId.make("cmd-settle-subagent-stale"),
            threadId: ThreadId.make("thread-1"),
          },
          readModel: makeReadModel(null, null, null, [], [], [makeSubagent("running", staleAt)]),
        });
        const staleEvents = Array.isArray(stale) ? stale : [stale];
        expect(staleEvents[0]?.type).toBe("thread.settled");
      }),
  );

  it.effect("guards normal session stops while forced stops remain unguarded", () =>
    Effect.gen(function* () {
      const freshAt = DateTime.formatIso(yield* DateTime.now);
      const subagent: OrchestrationThread["subagents"][number] = {
        subagentId: "subagent-running",
        turnId: null,
        status: "running",
        startedAt: freshAt,
        updatedAt: freshAt,
        completedAt: null,
      };
      const readModel = makeReadModel(null, null, null, [], [], [subagent]);

      const guardedError = yield* decideOrchestrationCommand({
        command: {
          type: "thread.session.stop",
          commandId: CommandId.make("cmd-stop-guarded"),
          threadId: ThreadId.make("thread-1"),
          createdAt: NOW,
          preserveRunningSubagents: true,
        },
        readModel,
      }).pipe(Effect.flip);
      expect(guardedError._tag).toBe("OrchestrationCommandInvariantError");
      expect(isRunningSubagentLivenessRefusal(guardedError.message)).toBe(true);

      const forced = yield* decideOrchestrationCommand({
        command: {
          type: "thread.session.stop",
          commandId: CommandId.make("cmd-stop-forced"),
          threadId: ThreadId.make("thread-1"),
          createdAt: NOW,
        },
        readModel,
      });
      const forcedEvents = Array.isArray(forced) ? forced : [forced];
      expect(forcedEvents[0]?.type).toBe("thread.session-stop-requested");
    }),
  );

  it.effect("copies optional stop reasons into session-stop-requested events", () =>
    Effect.gen(function* () {
      const reasoned = yield* decideOrchestrationCommand({
        command: {
          type: "thread.session.stop",
          commandId: CommandId.make("cmd-stop-reasoned"),
          threadId: ThreadId.make("thread-1"),
          createdAt: NOW,
          reason: "session reaped: no live provider process",
        },
        readModel: makeReadModel(null),
      });
      const reasonedEvents = Array.isArray(reasoned) ? reasoned : [reasoned];
      expect(reasonedEvents[0]?.type).toBe("thread.session-stop-requested");
      if (reasonedEvents[0]?.type === "thread.session-stop-requested") {
        expect(reasonedEvents[0].payload.reason).toBe("session reaped: no live provider process");
      }

      const unreasoned = yield* decideOrchestrationCommand({
        command: {
          type: "thread.session.stop",
          commandId: CommandId.make("cmd-stop-unreasoned"),
          threadId: ThreadId.make("thread-1"),
          createdAt: NOW,
        },
        readModel: makeReadModel(null),
      });
      const unreasonedEvents = Array.isArray(unreasoned) ? unreasoned : [unreasoned];
      expect(unreasonedEvents[0]?.type).toBe("thread.session-stop-requested");
      if (unreasonedEvents[0]?.type === "thread.session-stop-requested") {
        expect(unreasonedEvents[0].payload.reason).toBeUndefined();
        expect(unreasonedEvents[0].payload).not.toHaveProperty("reason");
      }
    }),
  );

  it.effect("rejects settling a thread with an open approval or user-input request", () =>
    Effect.gen(function* () {
      const requestActivity = (kind: string, requestId: string, at: string) =>
        ({
          id: EventId.make(`activity-${requestId}-${kind}`),
          tone: "approval" as const,
          kind,
          summary: kind,
          payload: { requestId },
          turnId: null,
          createdAt: at,
        }) as OrchestrationThread["activities"][number];

      // Open approval request: settle rejected.
      const openError = yield* decideOrchestrationCommand({
        command: {
          type: "thread.settle",
          commandId: CommandId.make("cmd-settle-pending"),
          threadId: ThreadId.make("thread-1"),
        },
        readModel: makeReadModel(null, null, null, [
          requestActivity("approval.requested", "req-1", NOW),
        ]),
      }).pipe(Effect.flip);
      expect(openError._tag).toBe("OrchestrationCommandInvariantError");

      // Same request later resolved: settleable again.
      const settled = yield* decideOrchestrationCommand({
        command: {
          type: "thread.settle",
          commandId: CommandId.make("cmd-settle-resolved"),
          threadId: ThreadId.make("thread-1"),
        },
        readModel: makeReadModel(null, null, null, [
          requestActivity("approval.requested", "req-1", NOW),
          requestActivity("approval.resolved", "req-1", NOW),
        ]),
      });
      const settledEvents = Array.isArray(settled) ? settled : [settled];
      expect(settledEvents[0]?.type).toBe("thread.settled");

      // Open user-input request: also rejected.
      const inputError = yield* decideOrchestrationCommand({
        command: {
          type: "thread.settle",
          commandId: CommandId.make("cmd-settle-pending-input"),
          threadId: ThreadId.make("thread-1"),
        },
        readModel: makeReadModel(null, null, null, [
          requestActivity("user-input.requested", "req-2", NOW),
        ]),
      }).pipe(Effect.flip);
      expect(inputError._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("clears an open request when its respond failure marks it stale", () =>
    Effect.gen(function* () {
      const activity = (
        kind: string,
        requestId: string,
        payload: Record<string, unknown>,
      ): OrchestrationThread["activities"][number] =>
        ({
          id: EventId.make(`activity-${requestId}-${kind}`),
          tone: "approval" as const,
          kind,
          summary: kind,
          payload: { requestId, ...payload },
          turnId: null,
          createdAt: NOW,
        }) as OrchestrationThread["activities"][number];

      // Stale-failure detail clears the request — mirrors the projection's
      // pending accounting, which is what the client's canSettle sees.
      const settled = yield* decideOrchestrationCommand({
        command: {
          type: "thread.settle",
          commandId: CommandId.make("cmd-settle-stale-failed"),
          threadId: ThreadId.make("thread-1"),
        },
        readModel: makeReadModel(null, null, null, [
          activity("approval.requested", "req-1", {}),
          activity("provider.approval.respond.failed", "req-1", {
            detail: "Unknown pending approval request req-1",
          }),
          activity("user-input.requested", "req-2", {}),
          activity("provider.user-input.respond.failed", "req-2", {
            detail: "stale pending user-input request req-2",
          }),
        ]),
      });
      const settledEvents = Array.isArray(settled) ? settled : [settled];
      expect(settledEvents[0]?.type).toBe("thread.settled");

      // A non-stale respond failure (transient provider error) keeps the
      // request open: the user can retry, so it is still blocked-on-you.
      const stillOpen = yield* decideOrchestrationCommand({
        command: {
          type: "thread.settle",
          commandId: CommandId.make("cmd-settle-transient-failed"),
          threadId: ThreadId.make("thread-1"),
        },
        readModel: makeReadModel(null, null, null, [
          activity("approval.requested", "req-3", {}),
          activity("provider.approval.respond.failed", "req-3", {
            detail: "provider connection reset",
          }),
        ]),
      }).pipe(Effect.flip);
      expect(stillOpen._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("keeps rejecting settle when the open request is older than the activity cap", () =>
    Effect.gen(function* () {
      // The command read model keeps only the newest THREAD_DETAIL_ACTIVITY_LIMIT
      // activities per thread. Without pinning the request kinds, an approval
      // buried under a window of chatter falls out and the thread settles while
      // the shell's pending counts still say it is waiting — t3code-l4u.
      const activityEvent = (
        sequence: number,
        activity: Record<string, unknown>,
      ): OrchestrationEvent =>
        ({
          sequence,
          eventId: EventId.make(`event-${sequence}`),
          type: "thread.activity-appended",
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-1"),
          occurredAt: NOW,
          commandId: CommandId.make(`cmd-activity-${sequence}`),
          causationEventId: null,
          correlationId: null,
          metadata: {},
          payload: { threadId: ThreadId.make("thread-1"), activity },
        }) as OrchestrationEvent;

      const threadCreated = {
        sequence: 1,
        eventId: EventId.make("event-1"),
        type: "thread.created",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        occurredAt: NOW,
        commandId: CommandId.make("cmd-create"),
        causationEventId: null,
        correlationId: null,
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-1"),
          projectId: ProjectId.make("project-1"),
          title: "Thread",
          modelSelection: { provider: "codex", model: "gpt-5.4" },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: NOW,
          updatedAt: NOW,
        },
      } as unknown as OrchestrationEvent;

      const events: ReadonlyArray<OrchestrationEvent> = [
        threadCreated,
        activityEvent(2, {
          id: EventId.make("activity-approval"),
          tone: "approval",
          kind: "approval.requested",
          summary: "Run `rm -rf /tmp/x`?",
          payload: { requestId: "req-1" },
          turnId: null,
          sequence: 1,
          createdAt: NOW,
        }),
        ...Array.from({ length: THREAD_DETAIL_ACTIVITY_LIMIT + 100 }, (_, index) =>
          activityEvent(index + 3, {
            id: EventId.make(`activity-filler-${index}`),
            tone: "tool",
            kind: "tool.started",
            summary: `Ran command ${index}`,
            payload: {},
            turnId: null,
            sequence: index + 2,
            createdAt: NOW,
          }),
        ),
      ];

      let projected = createEmptyReadModel(NOW);
      for (const event of events) {
        projected = yield* projectEvent(projected, event);
      }
      // The window, plus the one pinned approval.
      const activities = projected.threads[0]?.activities ?? [];
      expect(activities).toHaveLength(THREAD_DETAIL_ACTIVITY_LIMIT + 1);
      expect(activities[0]?.id).toBe("activity-approval");
      expect(activities[1]?.id).toBe("activity-filler-100");
      expect(activities.at(-1)?.id).toBe(`activity-filler-${THREAD_DETAIL_ACTIVITY_LIMIT + 99}`);

      const blocked = yield* decideOrchestrationCommand({
        command: {
          type: "thread.settle",
          commandId: CommandId.make("cmd-settle-buried-approval"),
          threadId: ThreadId.make("thread-1"),
        },
        readModel: makeReadModel(null, null, null, activities),
      }).pipe(Effect.flip);
      expect(blocked._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("bounds the queued-turn grace window against client clock skew", () =>
    Effect.gen(function* () {
      const userMessage = (createdAt: string): OrchestrationThread["messages"][number] => ({
        id: MessageId.make("message-queued"),
        role: "user",
        text: "Continue",
        turnId: null,
        streaming: false,
        createdAt,
        updatedAt: createdAt,
      });

      // The decider's clock is the Effect test clock, pinned to the epoch:
      // timestamps here are relative to 1970-01-01T00:00:00.000Z.

      // Within the grace window: genuinely queued, settle rejected.
      const queuedError = yield* decideOrchestrationCommand({
        command: {
          type: "thread.settle",
          commandId: CommandId.make("cmd-settle-queued"),
          threadId: ThreadId.make("thread-1"),
        },
        readModel: makeReadModel(null, null, null, [], [userMessage("1969-12-31T23:59:30.000Z")]),
      }).pipe(Effect.flip);
      expect(queuedError._tag).toBe("OrchestrationCommandInvariantError");

      // Message timestamp far in the FUTURE (client clock ahead of server):
      // a negative age must not read as queued forever — past the grace
      // bound in either direction the thread is settleable.
      const skewed = yield* decideOrchestrationCommand({
        command: {
          type: "thread.settle",
          commandId: CommandId.make("cmd-settle-skewed"),
          threadId: ThreadId.make("thread-1"),
        },
        readModel: makeReadModel(null, null, null, [], [userMessage("1970-01-01T01:00:00.000Z")]),
      });
      const skewedEvents = Array.isArray(skewed) ? skewed : [skewed];
      expect(skewedEvents[0]?.type).toBe("thread.settled");
    }),
  );

  it.effect("rejects settling and unsettling archived threads", () =>
    Effect.gen(function* () {
      const settleError = yield* decideOrchestrationCommand({
        command: {
          type: "thread.settle",
          commandId: CommandId.make("cmd-settle-archived"),
          threadId: ThreadId.make("thread-1"),
        },
        readModel: makeReadModel(null, NOW),
      }).pipe(Effect.flip);
      expect(settleError._tag).toBe("OrchestrationCommandInvariantError");

      const unsettleError = yield* decideOrchestrationCommand({
        command: {
          type: "thread.unsettle",
          commandId: CommandId.make("cmd-unsettle-archived"),
          threadId: ThreadId.make("thread-1"),
          reason: "user",
        },
        readModel: makeReadModel("settled", NOW),
      }).pipe(Effect.flip);
      expect(unsettleError._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("maps unsettle reasons to overrides and re-emits idempotently", () =>
    Effect.gen(function* () {
      const userEvent = yield* decideOrchestrationCommand({
        command: {
          type: "thread.unsettle",
          commandId: CommandId.make("cmd-unsettle-user"),
          threadId: ThreadId.make("thread-1"),
          reason: "user",
        },
        readModel: makeReadModel("settled"),
      });
      const userEvents = Array.isArray(userEvent) ? userEvent : [userEvent];
      expect(userEvents).toHaveLength(1);
      expect(userEvents[0]?.type).toBe("thread.unsettled");
      if (userEvents[0]?.type === "thread.unsettled") {
        expect(userEvents[0].payload.reason).toBe("user");
      }

      // Re-dispatching against the already-reached state re-emits rather than
      // producing zero events (the engine rejects empty commands).
      const userAgain = yield* decideOrchestrationCommand({
        command: {
          type: "thread.unsettle",
          commandId: CommandId.make("cmd-unsettle-user-again"),
          threadId: ThreadId.make("thread-1"),
          reason: "user",
        },
        readModel: makeReadModel("active"),
      });
      const userAgainEvents = Array.isArray(userAgain) ? userAgain : [userAgain];
      expect(userAgainEvents).toHaveLength(1);
      expect(userAgainEvents[0]?.type).toBe("thread.unsettled");
    }),
  );

  it.effect("prepends activity unsets for turn starts and live session updates", () =>
    Effect.gen(function* () {
      const turnResult = yield* decideOrchestrationCommand({
        command: {
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-turn-start"),
          threadId: ThreadId.make("thread-1"),
          message: {
            messageId: MessageId.make("message-1"),
            role: "user",
            text: "Continue",
            attachments: [],
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt: NOW,
        },
        readModel: makeReadModel("settled"),
      });
      const turnEvents = Array.isArray(turnResult) ? turnResult : [turnResult];
      expect(turnEvents.map((event) => event.type)).toEqual([
        "thread.unsettled",
        "thread.message-sent",
        "thread.turn-start-requested",
      ]);

      const sessionResult = yield* decideOrchestrationCommand({
        command: {
          type: "thread.session.set",
          commandId: CommandId.make("cmd-session-set"),
          threadId: ThreadId.make("thread-1"),
          session: makeSession("running"),
          createdAt: NOW,
        },
        // An explicit active value is also an override. Real activity clears
        // it back to neutral.
        readModel: makeReadModel("active"),
      });
      const sessionEvents = Array.isArray(sessionResult) ? sessionResult : [sessionResult];
      expect(sessionEvents.map((event) => event.type)).toEqual([
        "thread.unsettled",
        "thread.session-set",
      ]);
    }),
  );

  it.effect("clears a keep-active pin on real activity", () =>
    Effect.gen(function* () {
      const turnResult = yield* decideOrchestrationCommand({
        command: {
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-active-turn-start"),
          threadId: ThreadId.make("thread-1"),
          message: {
            messageId: MessageId.make("message-active"),
            role: "user",
            text: "Continue",
            attachments: [],
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt: NOW,
        },
        readModel: makeReadModel("active"),
      });
      const turnEvents = Array.isArray(turnResult) ? turnResult : [turnResult];
      // The pin exists to suppress AUTO-settle, not to survive real work:
      // activity resets it to neutral, restoring the default lifecycle.
      expect(turnEvents.map((event) => event.type)).toEqual([
        "thread.unsettled",
        "thread.message-sent",
        "thread.turn-start-requested",
      ]);

      const activityResult = yield* decideOrchestrationCommand({
        command: {
          type: "thread.activity.append",
          commandId: CommandId.make("cmd-active-approval"),
          threadId: ThreadId.make("thread-1"),
          activity: {
            id: EventId.make("activity-active"),
            tone: "approval",
            kind: "approval.requested",
            summary: "Command approval requested",
            payload: null,
            turnId: null,
            createdAt: NOW,
          },
          createdAt: NOW,
        },
        readModel: makeReadModel("active"),
      });
      const activityEvents = Array.isArray(activityResult) ? activityResult : [activityResult];
      expect(activityEvents.map((event) => event.type)).toEqual([
        "thread.unsettled",
        "thread.activity-appended",
      ]);
    }),
  );

  it.effect("does not unsettle for session stop/error status writes", () =>
    Effect.gen(function* () {
      for (const status of ["stopped", "error", "ready", "idle"] as const) {
        const result = yield* decideOrchestrationCommand({
          command: {
            type: "thread.session.set",
            commandId: CommandId.make(`cmd-session-${status}`),
            threadId: ThreadId.make("thread-1"),
            session: makeSession(status),
            createdAt: NOW,
          },
          readModel: makeReadModel("settled"),
        });
        const events = Array.isArray(result) ? result : [result];
        expect(events.map((event) => event.type)).toEqual(["thread.session-set"]);
      }
    }),
  );

  it.effect("unsettles for approval and user-input activities but not others", () =>
    Effect.gen(function* () {
      const approvalResult = yield* decideOrchestrationCommand({
        command: {
          type: "thread.activity.append",
          commandId: CommandId.make("cmd-activity-approval"),
          threadId: ThreadId.make("thread-1"),
          activity: {
            id: EventId.make("activity-1"),
            tone: "approval",
            kind: "approval.requested",
            summary: "Command approval requested",
            payload: null,
            turnId: null,
            createdAt: NOW,
          },
          createdAt: NOW,
        },
        readModel: makeReadModel("settled"),
      });
      const approvalEvents = Array.isArray(approvalResult) ? approvalResult : [approvalResult];
      expect(approvalEvents.map((event) => event.type)).toEqual([
        "thread.unsettled",
        "thread.activity-appended",
      ]);

      const routineResult = yield* decideOrchestrationCommand({
        command: {
          type: "thread.activity.append",
          commandId: CommandId.make("cmd-activity-routine"),
          threadId: ThreadId.make("thread-1"),
          activity: {
            id: EventId.make("activity-2"),
            tone: "info",
            kind: "tool.completed",
            summary: "Tool completed",
            payload: null,
            turnId: null,
            createdAt: NOW,
          },
          createdAt: NOW,
        },
        readModel: makeReadModel("settled"),
      });
      const routineEvents = Array.isArray(routineResult) ? routineResult : [routineResult];
      expect(routineEvents.map((event) => event.type)).toEqual(["thread.activity-appended"]);
    }),
  );
});
