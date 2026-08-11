import { ProjectId, ThreadId, ProviderInstanceId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { ProjectionProjectRepositoryLive } from "./ProjectionProjects.ts";
import { ProjectionThreadRepositoryLive } from "./ProjectionThreads.ts";
import { ProjectionThreadSubagentRepositoryLive } from "./ProjectionThreadSubagents.ts";
import { ProjectionProjectRepository } from "../Services/ProjectionProjects.ts";
import { ProjectionThreadRepository } from "../Services/ProjectionThreads.ts";
import { ProjectionThreadSubagentRepository } from "../Services/ProjectionThreadSubagents.ts";

const projectionRepositoriesLayer = it.layer(
  Layer.mergeAll(
    ProjectionProjectRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
    ProjectionThreadRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
    ProjectionThreadSubagentRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
    SqlitePersistenceMemory,
  ),
);

projectionRepositoriesLayer("Projection repositories", (it) => {
  it.effect("stores SQL NULL for missing project model options", () =>
    Effect.gen(function* () {
      const projects = yield* ProjectionProjectRepository;
      const sql = yield* SqlClient.SqlClient;

      yield* projects.upsert({
        projectId: ProjectId.make("project-null-options"),
        title: "Null options project",
        workspaceRoot: "/tmp/project-null-options",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        },
        scripts: [],
        createdAt: "2026-03-24T00:00:00.000Z",
        updatedAt: "2026-03-24T00:00:00.000Z",
        deletedAt: null,
      });

      const rows = yield* sql<{
        readonly defaultModelSelection: string | null;
      }>`
        SELECT default_model_selection_json AS "defaultModelSelection"
        FROM projection_projects
        WHERE project_id = 'project-null-options'
      `;
      const row = rows[0];
      if (!row) {
        return yield* Effect.die("Expected projection_projects row to exist.");
      }

      assert.strictEqual(
        row.defaultModelSelection,
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        JSON.stringify({
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        }),
      );

      const persisted = yield* projects.getById({
        projectId: ProjectId.make("project-null-options"),
      });
      assert.deepStrictEqual(Option.getOrNull(persisted)?.defaultModelSelection, {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.4",
      });
    }),
  );

  it.effect("stores JSON for thread model options", () =>
    Effect.gen(function* () {
      const threads = yield* ProjectionThreadRepository;
      const sql = yield* SqlClient.SqlClient;

      yield* threads.upsert({
        threadId: ThreadId.make("thread-null-options"),
        projectId: ProjectId.make("project-null-options"),
        title: "Null options thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-opus-4-6",
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        latestTurnId: null,
        createdAt: "2026-03-24T00:00:00.000Z",
        updatedAt: "2026-03-24T00:00:00.000Z",
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        latestUserMessageAt: null,
        pendingApprovalCount: 0,
        pendingUserInputCount: 0,
        hasActionableProposedPlan: 0,
        deletedAt: null,
        parentThreadId: null,
      });

      const rows = yield* sql<{
        readonly modelSelection: string | null;
      }>`
        SELECT model_selection_json AS "modelSelection"
        FROM projection_threads
        WHERE thread_id = 'thread-null-options'
      `;
      const row = rows[0];
      if (!row) {
        return yield* Effect.die("Expected projection_threads row to exist.");
      }

      assert.strictEqual(
        row.modelSelection,
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        JSON.stringify({
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-opus-4-6",
        }),
      );

      const persisted = yield* threads.getById({
        threadId: ThreadId.make("thread-null-options"),
      });
      assert.deepStrictEqual(Option.getOrNull(persisted)?.modelSelection, {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-opus-4-6",
      });
    }),
  );

  it.effect("round-trips non-null settlement values through the thread row", () =>
    Effect.gen(function* () {
      const threads = yield* ProjectionThreadRepository;

      yield* threads.upsert({
        threadId: ThreadId.make("thread-settled"),
        projectId: ProjectId.make("project-1"),
        title: "Settled thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        latestTurnId: null,
        createdAt: "2026-03-24T00:00:00.000Z",
        updatedAt: "2026-03-25T00:00:00.000Z",
        archivedAt: null,
        settledOverride: "settled",
        settledAt: "2026-03-25T00:00:00.000Z",
        latestUserMessageAt: null,
        pendingApprovalCount: 0,
        pendingUserInputCount: 0,
        hasActionableProposedPlan: 0,
        deletedAt: null,
        parentThreadId: null,
      });

      const persisted = yield* threads.getById({
        threadId: ThreadId.make("thread-settled"),
      });
      const row = Option.getOrNull(persisted);
      if (!row) {
        return yield* Effect.die("Expected settled projection_threads row to exist.");
      }
      assert.strictEqual(row.settledOverride, "settled");
      assert.strictEqual(row.settledAt, "2026-03-25T00:00:00.000Z");

      // Un-settle to the keep-active pin and confirm the flip persists.
      yield* threads.upsert({
        ...row,
        settledOverride: "active",
        settledAt: null,
      });
      const repersisted = yield* threads.getById({
        threadId: ThreadId.make("thread-settled"),
      });
      const updated = Option.getOrNull(repersisted);
      assert.strictEqual(updated?.settledOverride, "active");
      assert.strictEqual(updated?.settledAt, null);
    }),
  );

  it.effect("round-trips the parent/child thread link through both repositories", () =>
    Effect.gen(function* () {
      const threads = yield* ProjectionThreadRepository;
      const subagents = yield* ProjectionThreadSubagentRepository;
      const parentThreadId = ThreadId.make("thread-parent");
      const childThreadId = ThreadId.make("thread-child");

      yield* threads.upsert({
        threadId: childThreadId,
        projectId: ProjectId.make("project-1"),
        title: "Child thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        latestTurnId: null,
        createdAt: "2026-08-11T00:00:00.000Z",
        updatedAt: "2026-08-11T00:00:00.000Z",
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        latestUserMessageAt: null,
        pendingApprovalCount: 0,
        pendingUserInputCount: 0,
        hasActionableProposedPlan: 0,
        deletedAt: null,
        parentThreadId,
      });
      yield* subagents.upsert({
        subagentId: "subagent-1",
        threadId: parentThreadId,
        turnId: null,
        status: "running",
        childThreadId,
        startedAt: "2026-08-11T00:00:00.000Z",
        updatedAt: "2026-08-11T00:00:00.000Z",
        completedAt: null,
      });

      const persistedThread = yield* threads.getById({ threadId: childThreadId });
      assert.strictEqual(Option.getOrNull(persistedThread)?.parentThreadId, parentThreadId);

      const persistedSubagents = yield* subagents.listByThreadId({ threadId: parentThreadId });
      assert.strictEqual(persistedSubagents[0]?.childThreadId, childThreadId);

      // An in-process subagent owns no child thread; the key stays absent.
      yield* subagents.upsert({
        subagentId: "subagent-2",
        threadId: parentThreadId,
        turnId: null,
        status: "running",
        startedAt: "2026-08-11T00:00:01.000Z",
        updatedAt: "2026-08-11T00:00:01.000Z",
        completedAt: null,
      });
      const withInProcess = yield* subagents.listByThreadId({ threadId: parentThreadId });
      assert.strictEqual(
        withInProcess.find((row) => row.subagentId === "subagent-2")?.childThreadId,
        undefined,
      );
    }),
  );

  it.effect("promotes only the children of the named parent", () =>
    Effect.gen(function* () {
      const threads = yield* ProjectionThreadRepository;
      const doomedParentId = ThreadId.make("thread-doomed-parent");
      const otherParentId = ThreadId.make("thread-other-parent");

      const seedThread = (threadId: ThreadId, parentThreadId: ThreadId | null) =>
        threads.upsert({
          threadId,
          projectId: ProjectId.make("project-1"),
          title: `Thread ${threadId}`,
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.4",
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          latestTurnId: null,
          createdAt: "2026-08-11T00:00:00.000Z",
          updatedAt: "2026-08-11T00:00:00.000Z",
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          latestUserMessageAt: null,
          pendingApprovalCount: 0,
          pendingUserInputCount: 0,
          hasActionableProposedPlan: 0,
          deletedAt: null,
          parentThreadId,
        });

      yield* seedThread(ThreadId.make("thread-doomed-child-a"), doomedParentId);
      yield* seedThread(ThreadId.make("thread-doomed-child-b"), doomedParentId);
      yield* seedThread(ThreadId.make("thread-kept-child"), otherParentId);

      yield* threads.promoteChildrenOfParent({ parentThreadId: doomedParentId });

      for (const threadId of ["thread-doomed-child-a", "thread-doomed-child-b"] as const) {
        const promoted = yield* threads.getById({ threadId: ThreadId.make(threadId) });
        assert.strictEqual(Option.getOrNull(promoted)?.parentThreadId, null, threadId);
      }
      const kept = yield* threads.getById({ threadId: ThreadId.make("thread-kept-child") });
      assert.strictEqual(Option.getOrNull(kept)?.parentThreadId, otherParentId);
    }),
  );
});
