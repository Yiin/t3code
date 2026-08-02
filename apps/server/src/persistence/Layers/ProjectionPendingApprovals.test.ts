import { ApprovalRequestId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ProjectionPendingApprovalRepository } from "../Services/ProjectionPendingApprovals.ts";
import { ProjectionPendingApprovalRepositoryLive } from "./ProjectionPendingApprovals.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  ProjectionPendingApprovalRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("ProjectionPendingApprovalRepository", (it) => {
  it.effect("countPendingByThreadId counts only status='pending' rows", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionPendingApprovalRepository;
      const threadId = ThreadId.make("thread-count-pending-approvals");

      yield* repository.upsert({
        requestId: ApprovalRequestId.make("approval-count-pending-1"),
        threadId,
        turnId: null,
        status: "pending",
        decision: null,
        createdAt: "2026-03-02T10:00:00.000Z",
        resolvedAt: null,
      });

      yield* repository.upsert({
        requestId: ApprovalRequestId.make("approval-count-pending-2"),
        threadId,
        turnId: null,
        status: "pending",
        decision: null,
        createdAt: "2026-03-02T10:01:00.000Z",
        resolvedAt: null,
      });

      yield* repository.upsert({
        requestId: ApprovalRequestId.make("approval-count-pending-3"),
        threadId,
        turnId: null,
        status: "resolved",
        decision: "accept",
        createdAt: "2026-03-02T10:02:00.000Z",
        resolvedAt: "2026-03-02T10:03:00.000Z",
      });

      const count = yield* repository.countPendingByThreadId({ threadId });
      assert.equal(count, 2);
    }),
  );

  it.effect("countPendingByThreadId returns 0 for a thread with no pending approvals", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionPendingApprovalRepository;
      const threadId = ThreadId.make("thread-count-pending-approvals-none");

      const count = yield* repository.countPendingByThreadId({ threadId });
      assert.equal(count, 0);
    }),
  );
});
