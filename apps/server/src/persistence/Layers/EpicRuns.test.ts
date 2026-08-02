import { EpicRunId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { EpicRunStoreLive } from "./EpicRuns.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { EpicRunStore, type EpicRun } from "../Services/EpicRuns.ts";

const modelSelection = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-opus-4-6",
};

const makeRun = (overrides: Partial<EpicRun> = {}): EpicRun => ({
  runId: EpicRunId.make("run-1"),
  epicId: "t3code-vst",
  projectId: ProjectId.make("project-epic"),
  cwd: "/tmp/project-epic",
  prompt: "Cook the epic.",
  modelSelection,
  runtimeMode: "full-access",
  originThreadId: null,
  status: "running",
  maxIterations: 10,
  iterationsCompleted: 0,
  currentThreadId: null,
  currentTurnStartedAt: null,
  consecutiveFailures: 0,
  lastError: null,
  createdAt: "2026-07-27T00:00:00.000Z",
  updatedAt: "2026-07-27T00:00:00.000Z",
  ...overrides,
});

// Provided per test rather than per suite so each case gets its own `:memory:`
// database and can assert over the whole table instead of a slice of it.
const epicRunStoreLayer = EpicRunStoreLive.pipe(Layer.provideMerge(SqlitePersistenceMemory));

describe("EpicRunStore", () => {
  it.effect("round-trips a run and stores the model selection as JSON", () =>
    Effect.gen(function* () {
      const store = yield* EpicRunStore;
      const sql = yield* SqlClient.SqlClient;

      const run = makeRun({
        currentThreadId: ThreadId.make("thread-epic-1"),
        currentTurnStartedAt: "2026-07-27T00:01:00.000Z",
        originThreadId: ThreadId.make("thread-launcher-1"),
      });
      yield* store.upsertRun(run);

      const persisted = yield* store.getRun({ runId: run.runId });
      assert.deepStrictEqual(Option.getOrNull(persisted), run);

      const rows = yield* sql<{ readonly modelSelection: string }>`
        SELECT model_selection_json AS "modelSelection"
        FROM epic_runs
        WHERE run_id = 'run-1'
      `;
      const row = rows[0];
      if (!row) {
        return yield* Effect.die("Expected epic_runs row to exist.");
      }
      assert.strictEqual(
        row.modelSelection,
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        JSON.stringify(modelSelection),
      );
    }).pipe(Effect.provide(epicRunStoreLayer)),
  );

  // A run launched from the Epics page has no launcher thread, and neither do
  // rows written before the column existed.
  it.effect("round-trips a run with no origin thread", () =>
    Effect.gen(function* () {
      const store = yield* EpicRunStore;

      const run = makeRun({ runId: EpicRunId.make("run-no-origin") });
      yield* store.upsertRun(run);

      const persisted = yield* store.getRun({ runId: run.runId });
      assert.strictEqual(Option.getOrNull(persisted)?.originThreadId, null);
    }).pipe(Effect.provide(epicRunStoreLayer)),
  );

  it.effect("upserts a run in place instead of inserting a second row", () =>
    Effect.gen(function* () {
      const store = yield* EpicRunStore;
      const sql = yield* SqlClient.SqlClient;

      const run = makeRun({ runId: EpicRunId.make("run-upsert") });
      yield* store.upsertRun(run);
      yield* store.upsertRun({
        ...run,
        status: "done",
        iterationsCompleted: 4,
        updatedAt: "2026-07-27T01:00:00.000Z",
      });

      const counts = yield* sql<{ readonly total: number }>`
        SELECT COUNT(*) AS "total" FROM epic_runs
      `;
      assert.strictEqual(counts[0]?.total, 1);

      const persisted = yield* store.getRun({ runId: run.runId });
      assert.strictEqual(Option.getOrNull(persisted)?.status, "done");
      assert.strictEqual(Option.getOrNull(persisted)?.iterationsCompleted, 4);
      assert.strictEqual(Option.getOrNull(persisted)?.updatedAt, "2026-07-27T01:00:00.000Z");
    }).pipe(Effect.provide(epicRunStoreLayer)),
  );

  it.effect("filters runs by status and lists all runs in creation order", () =>
    Effect.gen(function* () {
      const store = yield* EpicRunStore;

      yield* store.upsertRun(
        makeRun({
          runId: EpicRunId.make("run-running"),
          status: "running",
          createdAt: "2026-07-27T00:00:01.000Z",
        }),
      );
      yield* store.upsertRun(
        makeRun({
          runId: EpicRunId.make("run-paused"),
          status: "paused",
          createdAt: "2026-07-27T00:00:02.000Z",
        }),
      );
      yield* store.upsertRun(
        makeRun({
          runId: EpicRunId.make("run-done"),
          status: "done",
          createdAt: "2026-07-27T00:00:03.000Z",
        }),
      );

      const running = yield* store.listRuns({ status: "running" });
      assert.deepStrictEqual(
        running.map((run) => run.runId),
        ["run-running"],
      );

      const all = yield* store.listRuns({});
      assert.deepStrictEqual(
        all.map((run) => run.runId),
        ["run-running", "run-paused", "run-done"],
      );
    }).pipe(Effect.provide(epicRunStoreLayer)),
  );

  it.effect("lists iterations by index and reports the latest one", () =>
    Effect.gen(function* () {
      const store = yield* EpicRunStore;
      const runId = EpicRunId.make("run-iterations");

      yield* store.upsertRun(makeRun({ runId }));

      for (const iterationIndex of [1, 0, 2]) {
        yield* store.appendIteration({
          runId,
          iterationIndex,
          threadId: ThreadId.make(`thread-${iterationIndex}`),
          issueId: `issue-${iterationIndex}`,
          turnStatus: "completed",
          summary: `iteration ${iterationIndex}`,
          why: `reason ${iterationIndex}`,
          startedAt: "2026-07-27T00:00:00.000Z",
          finishedAt: "2026-07-27T00:05:00.000Z",
        });
      }

      const iterations = yield* store.listIterations({ runId });
      assert.deepStrictEqual(
        iterations.map((iteration) => iteration.iterationIndex),
        [0, 1, 2],
      );

      const latest = yield* store.getLatestIteration({ runId });
      assert.strictEqual(Option.getOrNull(latest)?.iterationIndex, 2);
      assert.strictEqual(Option.getOrNull(latest)?.threadId, "thread-2");
    }).pipe(Effect.provide(epicRunStoreLayer)),
  );

  it.effect("rehydrates an interrupted run and rejects a duplicate iteration index", () =>
    Effect.gen(function* () {
      const store = yield* EpicRunStore;
      const runId = EpicRunId.make("run-crashed");

      yield* store.upsertRun(
        makeRun({
          runId,
          status: "running",
          currentThreadId: ThreadId.make("thread-crashed-0"),
          currentTurnStartedAt: "2026-07-27T00:00:30.000Z",
        }),
      );
      yield* store.appendIteration({
        runId,
        iterationIndex: 0,
        threadId: ThreadId.make("thread-crashed-0"),
        issueId: "issue-0",
        turnStatus: "running",
        summary: null,
        why: null,
        startedAt: "2026-07-27T00:00:30.000Z",
        finishedAt: null,
      });

      const resumable = yield* store.listRuns({ status: "running" });
      assert.deepStrictEqual(
        resumable.map((run) => run.runId),
        [runId],
      );
      assert.strictEqual(resumable[0]?.currentThreadId, "thread-crashed-0");

      yield* store.updateIteration({
        runId,
        iterationIndex: 0,
        turnStatus: "abandoned",
        summary: null,
        why: null,
        finishedAt: "2026-07-27T00:10:00.000Z",
      });

      const latest = yield* store.getLatestIteration({ runId });
      const nextIndex = Option.match(latest, {
        onNone: () => 0,
        onSome: (iteration) => iteration.iterationIndex + 1,
      });
      assert.strictEqual(nextIndex, 1);

      yield* store.appendIteration({
        runId,
        iterationIndex: nextIndex,
        threadId: ThreadId.make("thread-crashed-1"),
        issueId: "issue-1",
        turnStatus: "running",
        summary: null,
        why: null,
        startedAt: "2026-07-27T00:10:01.000Z",
        finishedAt: null,
      });

      const iterations = yield* store.listIterations({ runId });
      assert.strictEqual(iterations.length, 2);
      assert.strictEqual(iterations[0]?.turnStatus, "abandoned");
      assert.strictEqual(iterations[0]?.finishedAt, "2026-07-27T00:10:00.000Z");
      assert.strictEqual(iterations[1]?.iterationIndex, 1);
      assert.strictEqual(iterations[1]?.turnStatus, "running");
      assert.strictEqual(iterations[1]?.finishedAt, null);

      const duplicateFailure = yield* Effect.flip(
        store.appendIteration({
          runId,
          iterationIndex: 0,
          threadId: ThreadId.make("thread-crashed-0-again"),
          issueId: "issue-0",
          turnStatus: "running",
          summary: null,
          why: null,
          startedAt: "2026-07-27T00:11:00.000Z",
          finishedAt: null,
        }),
      );
      assert.strictEqual(duplicateFailure._tag, "PersistenceSqlError");
    }).pipe(Effect.provide(epicRunStoreLayer)),
  );

  it.effect("fails with a decode error when a stored run no longer decodes", () =>
    Effect.gen(function* () {
      const store = yield* EpicRunStore;
      const sql = yield* SqlClient.SqlClient;
      const runId = EpicRunId.make("run-corrupt");

      yield* store.upsertRun(makeRun({ runId }));
      yield* sql`
        UPDATE epic_runs
        SET model_selection_json = ${"not json"}
        WHERE run_id = ${runId}
      `;

      const getFailure = yield* Effect.flip(store.getRun({ runId }));
      assert.strictEqual(getFailure._tag, "PersistenceDecodeError");
      assert.strictEqual(getFailure.operation, "EpicRunStore.getRun:decodeRow");
      assert.deepStrictEqual(getFailure.correlation, { runId });

      // A `running` row silently dropped from the listing is a run that never
      // resumes and never reports why, so the listing fails instead of skipping.
      const listFailure = yield* Effect.flip(store.listRuns({}));
      assert.strictEqual(listFailure._tag, "PersistenceDecodeError");
      assert.strictEqual(listFailure.operation, "EpicRunStore.listRuns:decodeRows");

      const listByStatusFailure = yield* Effect.flip(store.listRuns({ status: "running" }));
      assert.strictEqual(listByStatusFailure._tag, "PersistenceDecodeError");
      assert.strictEqual(listByStatusFailure.operation, "EpicRunStore.listRuns:decodeRows");
    }).pipe(Effect.provide(epicRunStoreLayer)),
  );
});
