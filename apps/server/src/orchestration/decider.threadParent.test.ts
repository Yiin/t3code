import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-08-11T00:00:00.000Z";
const PROJECT_A = ProjectId.make("project-a");
const PROJECT_B = ProjectId.make("project-b");
const PARENT_THREAD_ID = ThreadId.make("thread-parent");
const CHILD_THREAD_ID = ThreadId.make("thread-child");

function project(id: ProjectId) {
  return {
    id,
    title: `Project ${id}`,
    workspaceRoot: `/repo/${id}`,
    repositoryIdentity: null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
  };
}

function readModel(parentProjectId: ProjectId): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [project(PROJECT_A), project(PROJECT_B)],
    threads: [
      {
        id: PARENT_THREAD_ID,
        projectId: parentProjectId,
        title: "Parent",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        latestTurn: null,
        createdAt: NOW,
        updatedAt: NOW,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        deletedAt: null,
        parentThreadId: null,
        messages: [],
        proposedPlans: [],
        subagents: [],
        activities: [],
        checkpoints: [],
        session: null,
      },
    ],
    updatedAt: NOW,
  };
}

const createCommand = (parentThreadId?: ThreadId) => ({
  type: "thread.create" as const,
  commandId: CommandId.make("cmd-thread-create"),
  threadId: CHILD_THREAD_ID,
  projectId: PROJECT_A,
  title: "Child",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
  branch: null,
  worktreePath: null,
  ...(parentThreadId === undefined ? {} : { parentThreadId }),
  createdAt: NOW,
});

it.layer(NodeServices.layer)("thread.create parent link", (it) => {
  it.effect("carries the parent thread id into thread.created", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: createCommand(PARENT_THREAD_ID),
        readModel: readModel(PROJECT_A),
      });
      const event = Array.isArray(result) ? result[0] : result;

      expect(event?.type).toBe("thread.created");
      if (event?.type === "thread.created") {
        expect(event.payload.parentThreadId).toBe(PARENT_THREAD_ID);
      }
    }),
  );

  it.effect("defaults an unparented thread to a null parent", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: createCommand(),
        readModel: readModel(PROJECT_A),
      });
      const event = Array.isArray(result) ? result[0] : result;

      expect(event?.type).toBe("thread.created");
      if (event?.type === "thread.created") {
        expect(event.payload.parentThreadId).toBeNull();
      }
    }),
  );

  it.effect("rejects a parent thread that does not exist", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: createCommand(ThreadId.make("thread-missing")),
        readModel: readModel(PROJECT_A),
      }).pipe(Effect.flip);

      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("rejects a parent thread in another project", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: createCommand(PARENT_THREAD_ID),
        readModel: readModel(PROJECT_B),
      }).pipe(Effect.flip);

      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );
});
