import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationLatestTurn,
  type OrchestrationReadModel,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-08-11T00:00:00.000Z";
const THREAD_ID = ThreadId.make("thread-1");

const runningTurn: OrchestrationLatestTurn = {
  turnId: TurnId.make("turn-1"),
  state: "running",
  requestedAt: NOW,
  startedAt: NOW,
  completedAt: null,
  assistantMessageId: null,
};

const completedTurn: OrchestrationLatestTurn = {
  ...runningTurn,
  state: "completed",
  completedAt: NOW,
};

function makeReadModel(input: {
  readonly latestTurn: OrchestrationLatestTurn | null;
  readonly settledOverride?: OrchestrationThread["settledOverride"];
}): OrchestrationReadModel {
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
        id: THREAD_ID,
        projectId: ProjectId.make("project-1"),
        title: "Thread",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        latestTurn: input.latestTurn,
        createdAt: NOW,
        updatedAt: NOW,
        archivedAt: null,
        settledOverride: input.settledOverride ?? null,
        settledAt: null,
        deletedAt: null,
        messages: [],
        proposedPlans: [],
        subagents: [],
        activities: [],
        checkpoints: [],
        session: null,
        parentThreadId: null,
      },
    ],
    updatedAt: NOW,
  };
}

function turnStartCommand(input: {
  readonly commandId: string;
  readonly delivery?: "immediate" | "turn-boundary";
  readonly origin?: "human" | "agent";
}): Extract<OrchestrationCommand, { type: "thread.turn.start" }> {
  return {
    type: "thread.turn.start",
    commandId: CommandId.make(input.commandId),
    threadId: THREAD_ID,
    message: {
      messageId: MessageId.make("message-1"),
      role: "user",
      text: "keep going",
      attachments: [],
    },
    ...(input.delivery !== undefined ? { delivery: input.delivery } : {}),
    ...(input.origin !== undefined ? { origin: input.origin } : {}),
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt: NOW,
  };
}

it.layer(NodeServices.layer)("turn-boundary delivery decider", (it) => {
  it.effect("parks a turn-boundary message while the thread's turn runs", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: turnStartCommand({
          commandId: "cmd-park",
          delivery: "turn-boundary",
          origin: "human",
        }),
        readModel: makeReadModel({ latestTurn: runningTurn }),
      });
      const events = Array.isArray(decided) ? decided : [decided];

      // Only the message row. No turn starts, and nothing interrupts the
      // running turn.
      expect(events.map((event) => event.type)).toEqual(["thread.message-sent"]);
      const [messageEvent] = events;
      if (messageEvent?.type !== "thread.message-sent") {
        throw new Error("expected a message-sent event");
      }
      expect(messageEvent.payload.deliveryState).toBe("queued");
      expect(messageEvent.payload.origin).toBe("human");
    }),
  );

  it.effect("keeps the queued message as activity on an explicitly settled thread", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: turnStartCommand({ commandId: "cmd-park-settled", delivery: "turn-boundary" }),
        readModel: makeReadModel({ latestTurn: runningTurn, settledOverride: "settled" }),
      });
      const events = Array.isArray(decided) ? decided : [decided];

      expect(events.map((event) => event.type)).toEqual([
        "thread.unsettled",
        "thread.message-sent",
      ]);
    }),
  );

  it.effect("starts the turn when turn-boundary delivery finds the thread idle", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: turnStartCommand({
          commandId: "cmd-idle",
          delivery: "turn-boundary",
          origin: "agent",
        }),
        readModel: makeReadModel({ latestTurn: completedTurn }),
      });
      const events = Array.isArray(decided) ? decided : [decided];

      expect(events.map((event) => event.type)).toEqual([
        "thread.message-sent",
        "thread.turn-start-requested",
      ]);
      const [messageEvent] = events;
      if (messageEvent?.type !== "thread.message-sent") {
        throw new Error("expected a message-sent event");
      }
      expect(messageEvent.payload.deliveryState).toBeUndefined();
      expect(messageEvent.payload.origin).toBe("agent");
    }),
  );

  it.effect("never parks an immediate message, even mid-turn", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: turnStartCommand({ commandId: "cmd-immediate", delivery: "immediate" }),
        readModel: makeReadModel({ latestTurn: runningTurn }),
      });
      const events = Array.isArray(decided) ? decided : [decided];

      expect(events.map((event) => event.type)).toEqual([
        "thread.message-sent",
        "thread.turn-start-requested",
      ]);
    }),
  );

  it.effect("treats a command with no delivery intent as immediate", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: turnStartCommand({ commandId: "cmd-default" }),
        readModel: makeReadModel({ latestTurn: runningTurn }),
      });
      const events = Array.isArray(decided) ? decided : [decided];

      expect(events.map((event) => event.type)).toEqual([
        "thread.message-sent",
        "thread.turn-start-requested",
      ]);
      const [messageEvent] = events;
      if (messageEvent?.type !== "thread.message-sent") {
        throw new Error("expected a message-sent event");
      }
      // Absent on the command means a person typed it.
      expect(messageEvent.payload.origin).toBe("human");
      expect(messageEvent.payload.deliveryState).toBeUndefined();
    }),
  );
});
