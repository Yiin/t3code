import { EventId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ProjectionThreadActivityRepository } from "../Services/ProjectionThreadActivities.ts";
import { ProjectionThreadActivityRepositoryLive } from "./ProjectionThreadActivities.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  ProjectionThreadActivityRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("ProjectionThreadActivityRepository", (it) => {
  it.effect(
    "listUserInputByThreadId only returns the user-input kinds and excludes other kinds",
    () =>
      Effect.gen(function* () {
        const repository = yield* ProjectionThreadActivityRepository;
        const threadId = ThreadId.make("thread-list-user-input-activities");

        yield* repository.upsert({
          activityId: EventId.make("activity-user-input-requested"),
          threadId,
          turnId: null,
          tone: "info",
          kind: "user-input.requested",
          summary: "User input requested",
          payload: { requestId: "user-input-request-1" },
          createdAt: "2026-03-03T10:00:00.000Z",
        });

        yield* repository.upsert({
          activityId: EventId.make("activity-tool-updated"),
          threadId,
          turnId: null,
          tone: "tool",
          kind: "tool.updated",
          summary: "Tool updated",
          payload: {},
          createdAt: "2026-03-03T10:00:01.000Z",
        });

        yield* repository.upsert({
          activityId: EventId.make("activity-approval-requested"),
          threadId,
          turnId: null,
          tone: "approval",
          kind: "approval.requested",
          summary: "Approval requested",
          payload: { requestId: "approval-request-1" },
          createdAt: "2026-03-03T10:00:02.000Z",
        });

        yield* repository.upsert({
          activityId: EventId.make("activity-user-input-resolved"),
          threadId,
          turnId: null,
          tone: "info",
          kind: "user-input.resolved",
          summary: "User input resolved",
          payload: { requestId: "user-input-request-1" },
          createdAt: "2026-03-03T10:00:03.000Z",
        });

        yield* repository.upsert({
          activityId: EventId.make("activity-user-input-respond-failed"),
          threadId,
          turnId: null,
          tone: "error",
          kind: "provider.user-input.respond.failed",
          summary: "Provider user input response failed",
          payload: { requestId: "user-input-request-2", detail: "provider timeout" },
          createdAt: "2026-03-03T10:00:04.000Z",
        });

        const rows = yield* repository.listUserInputByThreadId({ threadId });
        assert.deepEqual(
          rows.map((row) => row.kind),
          ["user-input.requested", "user-input.resolved", "provider.user-input.respond.failed"],
        );

        const allRows = yield* repository.listByThreadId({ threadId });
        assert.equal(allRows.length, 5);
      }),
  );

  it.effect("listUserInputByThreadId returns an empty array for an unknown thread", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadActivityRepository;
      const threadId = ThreadId.make("thread-list-user-input-activities-unknown");

      const rows = yield* repository.listUserInputByThreadId({ threadId });
      assert.deepEqual(rows, []);
    }),
  );
});
