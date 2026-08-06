import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  RUNNING_SUBAGENT_FRESHNESS_MS,
  SUBAGENT_STEER_REQUESTED_ACTIVITY_KIND,
  SUBAGENT_STOP_REQUESTED_ACTIVITY_KIND,
  ThreadId,
  TurnId,
  type OrchestrationReadModel,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const THREAD_ID = ThreadId.make("thread-1");
const SUBAGENT_ID = "subagent-1";
const TURN_ID = TurnId.make("turn-1");

function makeReadModel(input?: {
  readonly archivedAt?: string | null;
  readonly subagentStatus?: OrchestrationThread["subagents"][number]["status"];
  readonly subagentUpdatedAt?: string;
  readonly includeSubagent?: boolean;
}): OrchestrationReadModel {
  const now = input?.subagentUpdatedAt ?? "2026-01-01T00:00:00.000Z";
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
        createdAt: now,
        updatedAt: now,
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
        latestTurn: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: input?.archivedAt ?? null,
        settledOverride: null,
        settledAt: null,
        deletedAt: null,
        messages: [],
        proposedPlans: [],
        subagents:
          input?.includeSubagent === false
            ? []
            : [
                {
                  subagentId: SUBAGENT_ID,
                  turnId: TURN_ID,
                  status: input?.subagentStatus ?? "running",
                  startedAt: now,
                  updatedAt: now,
                  completedAt: input?.subagentStatus === "completed" ? now : null,
                },
              ],
        activities: [],
        checkpoints: [],
        session: null,
      },
    ],
    updatedAt: now,
  };
}

const steerCommand = (createdAt: string) => ({
  type: "thread.subagent.steer" as const,
  commandId: CommandId.make("steer-1"),
  threadId: THREAD_ID,
  subagentId: SUBAGENT_ID,
  text: "Check the parser",
  createdAt,
});

const stopCommand = (createdAt: string) => ({
  type: "thread.subagent.stop" as const,
  commandId: CommandId.make("stop-1"),
  threadId: THREAD_ID,
  subagentId: SUBAGENT_ID,
  createdAt,
});

it.layer(NodeServices.layer)("subagent steer decider", (it) => {
  it.effect("emits only the requested activity for a fresh running subagent", () =>
    Effect.gen(function* () {
      const now = DateTime.formatIso(yield* DateTime.now);
      const result = yield* decideOrchestrationCommand({
        command: steerCommand("2001-01-01T00:00:00.000Z"),
        readModel: makeReadModel({ subagentUpdatedAt: now }),
      });
      const events = Array.isArray(result) ? result : [result];

      expect(events).toHaveLength(1);
      expect(events.some((event) => event.type === "thread.message-sent")).toBe(false);
      expect(events[0]?.type).toBe("thread.activity-appended");
      if (events[0]?.type === "thread.activity-appended") {
        expect(events[0].payload.activity.kind).toBe(SUBAGENT_STEER_REQUESTED_ACTIVITY_KIND);
        expect(events[0].payload.activity.payload).toEqual({
          subagentId: SUBAGENT_ID,
          text: "Check the parser",
          steerId: CommandId.make("steer-1"),
        });
        expect(events[0].payload.activity.turnId).toBe(TURN_ID);
      }
    }),
  );

  it.effect("rejects a missing subagent", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: steerCommand(DateTime.formatIso(yield* DateTime.now)),
        readModel: makeReadModel({ includeSubagent: false }),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("rejects a completed subagent", () =>
    Effect.gen(function* () {
      const now = DateTime.formatIso(yield* DateTime.now);
      const error = yield* decideOrchestrationCommand({
        command: steerCommand(now),
        readModel: makeReadModel({ subagentStatus: "completed", subagentUpdatedAt: now }),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("uses the server clock, not command createdAt, to reject a stale subagent", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const staleAt = DateTime.formatIso(
        DateTime.subtractDuration(now, Duration.millis(RUNNING_SUBAGENT_FRESHNESS_MS + 1)),
      );
      const error = yield* decideOrchestrationCommand({
        command: steerCommand(staleAt),
        readModel: makeReadModel({ subagentUpdatedAt: staleAt }),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("rejects an archived thread", () =>
    Effect.gen(function* () {
      const now = DateTime.formatIso(yield* DateTime.now);
      const error = yield* decideOrchestrationCommand({
        command: steerCommand(now),
        readModel: makeReadModel({ archivedAt: now, subagentUpdatedAt: now }),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );
});

it.layer(NodeServices.layer)("subagent stop decider", (it) => {
  it.effect("emits the requested activity for a fresh running subagent", () =>
    Effect.gen(function* () {
      const now = DateTime.formatIso(yield* DateTime.now);
      const result = yield* decideOrchestrationCommand({
        command: stopCommand("2001-01-01T00:00:00.000Z"),
        readModel: makeReadModel({ subagentUpdatedAt: now }),
      });
      const events = Array.isArray(result) ? result : [result];

      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe("thread.activity-appended");
      if (events[0]?.type === "thread.activity-appended") {
        expect(events[0].payload.activity.kind).toBe(SUBAGENT_STOP_REQUESTED_ACTIVITY_KIND);
        expect(events[0].payload.activity.payload).toEqual({
          subagentId: SUBAGENT_ID,
          stopId: CommandId.make("stop-1"),
        });
        expect(events[0].payload.activity.turnId).toBe(TURN_ID);
      }
    }),
  );

  it.effect("rejects a missing subagent", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: stopCommand(DateTime.formatIso(yield* DateTime.now)),
        readModel: makeReadModel({ includeSubagent: false }),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("rejects a completed subagent", () =>
    Effect.gen(function* () {
      const now = DateTime.formatIso(yield* DateTime.now);
      const error = yield* decideOrchestrationCommand({
        command: stopCommand(now),
        readModel: makeReadModel({ subagentStatus: "completed", subagentUpdatedAt: now }),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("uses the server clock to reject a stale subagent", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const staleAt = DateTime.formatIso(
        DateTime.subtractDuration(now, Duration.millis(RUNNING_SUBAGENT_FRESHNESS_MS + 1)),
      );
      const error = yield* decideOrchestrationCommand({
        command: stopCommand("2099-01-01T00:00:00.000Z"),
        readModel: makeReadModel({ subagentUpdatedAt: staleAt }),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("rejects an archived thread", () =>
    Effect.gen(function* () {
      const now = DateTime.formatIso(yield* DateTime.now);
      const error = yield* decideOrchestrationCommand({
        command: stopCommand(now),
        readModel: makeReadModel({ archivedAt: now, subagentUpdatedAt: now }),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );
});
