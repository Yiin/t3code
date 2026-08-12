import {
  DEFAULT_EPIC_RUN_CONFIG,
  DEFAULT_EPIC_RUN_CONFIG_PROVENANCE,
  EpicRunConfig as EpicRunConfigSchema,
  EpicRunConfigProvenance as EpicRunConfigProvenanceSchema,
  EpicRunId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { EpicRunStoreLive } from "./EpicRuns.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { EpicRunStore, type EpicRun } from "../Services/EpicRuns.ts";

const modelSelection = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-opus-4-6",
};
const encodeConfigJson = Schema.encodeEffect(Schema.fromJsonString(EpicRunConfigSchema));
const encodeConfigProvenanceJson = Schema.encodeEffect(
  Schema.fromJsonString(EpicRunConfigProvenanceSchema),
);

const makeRun = (overrides: Partial<EpicRun> = {}): EpicRun => ({
  runId: EpicRunId.make("run-1"),
  epicId: "t3code-vst",
  projectId: ProjectId.make("project-epic"),
  cwd: "/tmp/project-epic",
  prompt: "Cook the epic.",
  orientationFile: null,
  modelSelection,
  runtimeMode: "full-access",
  config: DEFAULT_EPIC_RUN_CONFIG,
  configProvenance: DEFAULT_EPIC_RUN_CONFIG_PROVENANCE,
  originThreadId: null,
  status: "running",
  maxIterations: 10,
  workers: 1,
  iterationsDispatched: 0,
  iterationsCompleted: 0,
  currentThreadId: null,
  currentTurnStartedAt: null,
  consecutiveFailures: 0,
  noCommitStreak: 0,
  infraStreak: 0,
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
        orientationFile: "docs/agent-orientation.md",
        iterationsDispatched: 7,
        workers: 3,
        noCommitStreak: 2,
        infraStreak: 3,
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

  it.effect("round-trips non-default config and provenance as JSON", () =>
    Effect.gen(function* () {
      const store = yield* EpicRunStore;
      const sql = yield* SqlClient.SqlClient;
      const run = makeRun({
        runId: EpicRunId.make("run-config"),
        config: {
          ...DEFAULT_EPIC_RUN_CONFIG,
          limits: { ...DEFAULT_EPIC_RUN_CONFIG.limits, maxIterations: 7 },
          execution: { sequential: true },
        },
        configProvenance: {
          ...DEFAULT_EPIC_RUN_CONFIG_PROVENANCE,
          "limits.maxIterations": "file",
          "execution.sequential": "override",
          "parallel.workers": "policy",
        },
      });
      yield* store.upsertRun(run);

      assert.deepStrictEqual(Option.getOrThrow(yield* store.getRun({ runId: run.runId })), run);
      const rows = yield* sql<{
        readonly config: string;
        readonly provenance: string;
      }>`
        SELECT config_json AS config, config_provenance_json AS provenance
        FROM epic_runs WHERE run_id = ${run.runId}
      `;
      const encodedConfig = yield* encodeConfigJson(run.config);
      const encodedProvenance = yield* encodeConfigProvenanceJson(run.configProvenance);
      assert.strictEqual(rows[0]!.config, encodedConfig);
      assert.strictEqual(rows[0]!.provenance, encodedProvenance);
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

  it.effect("replaces degradation rows and clears them safely", () =>
    Effect.gen(function* () {
      const store = yield* EpicRunStore;
      const providerInstanceId = ProviderInstanceId.make("claude-work");
      yield* store.upsertProviderDegradation({
        providerInstanceId,
        failureReason: "provider-error:spend-limit",
        degradedAt: "2026-07-27T00:00:00.000Z",
      });
      yield* store.upsertProviderDegradation({
        providerInstanceId,
        failureReason: "provider-error:rate-limit",
        degradedAt: "2026-07-27T02:00:00.000Z",
      });

      const replaced = yield* store.getProviderDegradation({ providerInstanceId });
      assert.deepStrictEqual(Option.getOrNull(replaced), {
        providerInstanceId,
        failureReason: "provider-error:rate-limit",
        degradedAt: "2026-07-27T02:00:00.000Z",
      });

      // Cleanup based on an older observation must preserve the replacement.
      yield* store.clearExpiredProviderDegradation({
        providerInstanceId,
        cutoff: "2026-07-27T01:00:00.000Z",
      });
      assert.isTrue(Option.isSome(yield* store.getProviderDegradation({ providerInstanceId })));

      // Exact cutoff is expired.
      yield* store.clearExpiredProviderDegradation({
        providerInstanceId,
        cutoff: "2026-07-27T02:00:00.000Z",
      });
      assert.isTrue(Option.isNone(yield* store.getProviderDegradation({ providerInstanceId })));

      yield* store.upsertProviderDegradation({
        providerInstanceId,
        failureReason: "provider-error:auth",
        degradedAt: "2026-07-27T03:00:00.000Z",
      });
      yield* store.clearProviderDegradation({ providerInstanceId });
      assert.isTrue(Option.isNone(yield* store.getProviderDegradation({ providerInstanceId })));
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
        iterationsDispatched: 8,
        iterationsCompleted: 4,
        noCommitStreak: 4,
        infraStreak: 5,
        updatedAt: "2026-07-27T01:00:00.000Z",
      });

      const counts = yield* sql<{ readonly total: number }>`
        SELECT COUNT(*) AS "total" FROM epic_runs
      `;
      assert.strictEqual(counts[0]?.total, 1);

      const persisted = yield* store.getRun({ runId: run.runId });
      assert.strictEqual(Option.getOrNull(persisted)?.status, "done");
      assert.strictEqual(Option.getOrNull(persisted)?.iterationsCompleted, 4);
      assert.strictEqual(Option.getOrNull(persisted)?.iterationsDispatched, 8);
      assert.strictEqual(Option.getOrNull(persisted)?.noCommitStreak, 4);
      assert.strictEqual(Option.getOrNull(persisted)?.infraStreak, 5);
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

      // The restart read path is the reason `createdAt-asc` is the default;
      // naming it explicitly must not change anything.
      const explicitDefault = yield* store.listRuns({ orderBy: "createdAt-asc" });
      assert.deepStrictEqual(
        explicitDefault.map((run) => run.runId),
        ["run-running", "run-paused", "run-done"],
      );
    }).pipe(Effect.provide(epicRunStoreLayer)),
  );

  it.effect("orders by recency and bounds the listing on request", () =>
    Effect.gen(function* () {
      const store = yield* EpicRunStore;

      // `run-old` was created LAST but touched FIRST, so creation order and
      // recency order disagree — otherwise the assertion proves nothing.
      yield* store.upsertRun(
        makeRun({
          runId: EpicRunId.make("run-newest"),
          createdAt: "2026-07-27T00:00:01.000Z",
          updatedAt: "2026-07-27T03:00:00.000Z",
        }),
      );
      yield* store.upsertRun(
        makeRun({
          runId: EpicRunId.make("run-middle"),
          status: "done",
          createdAt: "2026-07-27T00:00:02.000Z",
          updatedAt: "2026-07-27T02:00:00.000Z",
        }),
      );
      yield* store.upsertRun(
        makeRun({
          runId: EpicRunId.make("run-old"),
          createdAt: "2026-07-27T00:00:03.000Z",
          updatedAt: "2026-07-27T01:00:00.000Z",
        }),
      );

      const recent = yield* store.listRuns({ orderBy: "updatedAt-desc" });
      assert.deepStrictEqual(
        recent.map((run) => run.runId),
        ["run-newest", "run-middle", "run-old"],
      );

      const bounded = yield* store.listRuns({ orderBy: "updatedAt-desc", limit: 2 });
      assert.deepStrictEqual(
        bounded.map((run) => run.runId),
        ["run-newest", "run-middle"],
      );

      // A limit composes with the status filter rather than being applied first.
      const boundedRunning = yield* store.listRuns({
        status: "running",
        orderBy: "updatedAt-desc",
        limit: 1,
      });
      assert.deepStrictEqual(
        boundedRunning.map((run) => run.runId),
        ["run-newest"],
      );

      const boundedCreation = yield* store.listRuns({ limit: 1 });
      assert.deepStrictEqual(
        boundedCreation.map((run) => run.runId),
        ["run-newest"],
      );
    }).pipe(Effect.provide(epicRunStoreLayer)),
  );

  // Runs written in the same second are the normal case for a launch loop, so
  // the tie-break has to be total or a `limit` would cut a different row each
  // time the same page is read.
  it.effect("tie-breaks equal timestamps on run id in the ordering's direction", () =>
    Effect.gen(function* () {
      const store = yield* EpicRunStore;

      for (const runId of ["run-b", "run-c", "run-a"]) {
        yield* store.upsertRun(
          makeRun({
            runId: EpicRunId.make(runId),
            createdAt: "2026-07-27T00:00:00.000Z",
            updatedAt: "2026-07-27T00:00:00.000Z",
          }),
        );
      }

      const byCreation = yield* store.listRuns({ orderBy: "createdAt-asc" });
      assert.deepStrictEqual(
        byCreation.map((run) => run.runId),
        ["run-a", "run-b", "run-c"],
      );

      const byRecency = yield* store.listRuns({ orderBy: "updatedAt-desc" });
      assert.deepStrictEqual(
        byRecency.map((run) => run.runId),
        ["run-c", "run-b", "run-a"],
      );

      const boundedByRecency = yield* store.listRuns({ orderBy: "updatedAt-desc", limit: 2 });
      assert.deepStrictEqual(
        boundedByRecency.map((run) => run.runId),
        ["run-c", "run-b"],
      );
    }).pipe(Effect.provide(epicRunStoreLayer)),
  );

  it.effect("reads the newest iterations of many runs in one query", () =>
    Effect.gen(function* () {
      const store = yield* EpicRunStore;

      const runIds = [
        EpicRunId.make("run-batch-a"),
        EpicRunId.make("run-batch-b"),
        EpicRunId.make("run-batch-empty"),
      ];
      for (const runId of runIds) {
        yield* store.upsertRun(makeRun({ runId }));
      }
      yield* store.upsertRun(makeRun({ runId: EpicRunId.make("run-batch-excluded") }));

      const appendIterations = (runId: string, count: number) =>
        Effect.forEach(
          Array.from({ length: count }, (_unused, index) => index),
          (iterationIndex) =>
            store.appendIteration({
              runId: EpicRunId.make(runId),
              iterationIndex,
              threadId: ThreadId.make(`thread-${runId}-${iterationIndex}`),
              issueId: `issue-${iterationIndex}`,
              turnStatus: "completed",
              summary: null,
              why: null,
              failureReason: null,
              startedAt: "2026-07-27T00:00:00.000Z",
              finishedAt: "2026-07-27T00:05:00.000Z",
            }),
          { discard: true },
        );

      yield* appendIterations("run-batch-a", 4);
      yield* appendIterations("run-batch-b", 1);
      yield* appendIterations("run-batch-excluded", 2);

      const batched = yield* store.listRecentIterationsForRuns({
        runIds,
        limitPerRun: 2,
      });
      // Capped per run, newest kept, and returned ascending so a caller can
      // group by walking once. The run with no iterations is simply absent, and
      // a run outside the batch never appears.
      assert.deepStrictEqual(
        batched.map((iteration) => `${iteration.runId}#${iteration.iterationIndex}`),
        ["run-batch-a#2", "run-batch-a#3", "run-batch-b#0"],
      );

      const empty = yield* store.listRecentIterationsForRuns({ runIds: [], limitPerRun: 2 });
      assert.deepStrictEqual(empty, []);
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
          workerId: `worker-${iterationIndex}`,
          branch: `epic/issue-${iterationIndex}`,
          worktreePath: `/tmp/worktrees/issue-${iterationIndex}`,
          turnStatus: "completed",
          summary: `iteration ${iterationIndex}`,
          why: `reason ${iterationIndex}`,
          failureReason: null,
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
      assert.strictEqual(Option.getOrNull(latest)?.workerId, "worker-2");
      assert.strictEqual(Option.getOrNull(latest)?.branch, "epic/issue-2");
      assert.strictEqual(Option.getOrNull(latest)?.worktreePath, "/tmp/worktrees/issue-2");
    }).pipe(Effect.provide(epicRunStoreLayer)),
  );

  // A restart-resume continues the same provider session on the same thread,
  // so it must reuse this row. If anyone ever swaps the reopen for an appended
  // row, the identity assertions below fail instead of the thread id silently
  // drifting away from the iteration index.
  it.effect("reopens an iteration in place, counting the resume", () =>
    Effect.gen(function* () {
      const store = yield* EpicRunStore;
      const runId = EpicRunId.make("run-resume");
      yield* store.upsertRun(makeRun({ runId }));

      const iterationIndex = yield* store.allocateIteration({
        runId,
        issueId: "issue-resume",
        branch: "epic/issue-resume",
        worktreePath: "/tmp/worktrees/issue-resume",
        startedAt: "2026-08-12T00:00:00.000Z",
      });
      yield* store.updateIteration({
        runId,
        iterationIndex,
        turnStatus: "abandoned",
        summary: "abandoned by the restart",
        why: "the process died",
        failureReason: "server-restart",
        finishedAt: "2026-08-12T00:10:00.000Z",
      });

      yield* store.reopenIteration({
        runId,
        iterationIndex,
        resumedAt: "2026-08-12T00:11:00.000Z",
      });

      const afterFirst = yield* store.listIterations({ runId });
      assert.strictEqual(afterFirst.length, 1);
      assert.deepStrictEqual(afterFirst[0], {
        runId,
        iterationIndex: 0,
        threadId: `epic-run-${runId}-0`,
        issueId: "issue-resume",
        workerId: `epic-run-${runId}-0`,
        branch: "epic/issue-resume",
        worktreePath: "/tmp/worktrees/issue-resume",
        turnStatus: "running",
        summary: null,
        why: null,
        failureReason: null,
        resumeCount: 1,
        lastResumedAt: "2026-08-12T00:11:00.000Z",
        startedAt: "2026-08-12T00:00:00.000Z",
        finishedAt: null,
      });

      // A second resume keeps counting, and a terminal update leaves both
      // resume columns exactly where the reopen put them.
      yield* store.reopenIteration({
        runId,
        iterationIndex,
        resumedAt: "2026-08-12T00:20:00.000Z",
      });
      yield* store.updateIteration({
        runId,
        iterationIndex,
        turnStatus: "completed",
        summary: "finished after the restart",
        why: null,
        failureReason: null,
        finishedAt: "2026-08-12T00:30:00.000Z",
      });

      const settled = (yield* store.listIterations({ runId }))[0];
      assert.strictEqual(settled?.resumeCount, 2);
      assert.strictEqual(settled?.lastResumedAt, "2026-08-12T00:20:00.000Z");
      assert.strictEqual(settled?.turnStatus, "completed");
      assert.strictEqual(settled?.startedAt, "2026-08-12T00:00:00.000Z");

      // A key that matches no row is a silent no-op, exactly like updateIteration.
      yield* store.reopenIteration({
        runId,
        iterationIndex: 7,
        resumedAt: "2026-08-12T00:40:00.000Z",
      });
      assert.strictEqual((yield* store.listIterations({ runId })).length, 1);
    }).pipe(Effect.provide(epicRunStoreLayer)),
  );

  it.effect("atomically allocates distinct indices and lists running rows", () =>
    Effect.gen(function* () {
      const store = yield* EpicRunStore;
      const runId = EpicRunId.make("run-allocate");
      yield* store.upsertRun(makeRun({ runId }));

      const allocated = yield* Effect.forEach(
        Array.from({ length: 10 }, (_unused, index) => index),
        (index) =>
          store.allocateIteration({
            runId,
            issueId: `issue-${index}`,
            branch: `epic/issue-${index}`,
            worktreePath: `/tmp/worktrees/issue-${index}`,
            startedAt: "2026-07-27T00:00:00.000Z",
          }),
        { concurrency: "unbounded" },
      );

      assert.deepStrictEqual(
        [...allocated].sort((left, right) => left - right),
        [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
      );
      const running = yield* store.listRunningIterations({ runId });
      assert.strictEqual(running.length, 10);
      assert.deepStrictEqual(
        running.map((row) => row.threadId),
        Array.from({ length: 10 }, (_unused, index) => `epic-run-${runId}-${index}`),
      );

      yield* store.updateIteration({
        runId,
        iterationIndex: 4,
        turnStatus: "completed",
        summary: "done",
        why: null,
        failureReason: null,
        finishedAt: "2026-07-27T00:01:00.000Z",
      });
      assert.deepStrictEqual(
        (yield* store.listRunningIterations({ runId })).map((row) => row.iterationIndex),
        [0, 1, 2, 3, 5, 6, 7, 8, 9],
      );
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
        failureReason: null,
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
        failureReason: "server-restart",
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
        failureReason: null,
        startedAt: "2026-07-27T00:10:01.000Z",
        finishedAt: null,
      });

      const iterations = yield* store.listIterations({ runId });
      assert.strictEqual(iterations.length, 2);
      assert.strictEqual(iterations[0]?.turnStatus, "abandoned");
      assert.strictEqual(iterations[0]?.failureReason, "server-restart");
      assert.strictEqual(iterations[0]?.finishedAt, "2026-07-27T00:10:00.000Z");
      assert.strictEqual(iterations[1]?.iterationIndex, 1);
      assert.strictEqual(iterations[1]?.turnStatus, "running");
      assert.strictEqual(iterations[1]?.failureReason, null);
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
          failureReason: null,
          startedAt: "2026-07-27T00:11:00.000Z",
          finishedAt: null,
        }),
      );
      assert.strictEqual(duplicateFailure._tag, "PersistenceSqlError");
    }).pipe(Effect.provide(epicRunStoreLayer)),
  );

  it.effect("replays ordered draining and parked merge work after a restart boundary", () =>
    Effect.gen(function* () {
      const store = yield* EpicRunStore;
      const runId = EpicRunId.make("run-merge-restart");
      yield* store.upsertRun(makeRun({ runId }));
      yield* store.initializeMergeState({
        runId,
        lastAcceptedHead: "base-0",
        repositoryPath: "/repo",
        baseBranch: "mine",
        integrationBranch: "cook-epic-integration-run-merge-restart",
        integrationWorktreePath: "/worktrees/integration",
        siblings: [],
      });
      yield* store.enqueueMerge({ runId, childId: "child-a", branch: "epic/child-a" });
      yield* store.enqueueMerge({ runId, childId: "child-b", branch: "epic/child-b" });

      const firstDrain = yield* store.beginMergeDrain({ runId });
      assert.deepStrictEqual(
        firstDrain.map((row) => [row.sequence, row.childId, row.status]),
        [
          [0, "child-a", "draining"],
          [1, "child-b", "draining"],
        ],
      );
      yield* store.beginParkMerge({
        runId,
        sequence: 0,
        reason: "conflict",
      });
      assert.strictEqual(
        Option.getOrThrow(yield* store.getMergeState({ runId })).entries[0]?.fixIssueId,
        null,
      );
      yield* store.finalizeParkMerge({ runId, sequence: 0, fixIssueId: "fix-a" });

      // A new runner calls beginDrain again. Existing draining work must replay.
      const replay = yield* store.beginMergeDrain({ runId });
      assert.deepStrictEqual(
        replay.map((row) => [row.sequence, row.childId, row.status]),
        [[1, "child-b", "draining"]],
      );
      assert.strictEqual(
        Option.getOrNull(yield* store.findParkedOriginalChild({ runId, branch: "epic/child-a" })),
        "child-a",
      );

      yield* store.completeMerge({ runId, sequence: 1, lastAcceptedHead: "base-1" });
      const persisted = Option.getOrThrow(yield* store.getMergeState({ runId }));
      assert.strictEqual(persisted.lastAcceptedHead, "base-1");
      assert.deepStrictEqual(
        persisted.entries.map((row) => [row.childId, row.status]),
        [["child-a", "parked"]],
      );

      // A repaired branch joins at the newest sequence. It must not jump ahead
      // of work that arrived while it was parked. A duplicate active enqueue is ignored.
      yield* store.enqueueMerge({ runId, childId: "child-c", branch: "epic/child-c" });
      yield* store.enqueueMerge({ runId, childId: "fix-a", branch: "epic/child-a" });
      yield* store.enqueueMerge({ runId, childId: "fix-a", branch: "epic/child-a" });
      const repaired = yield* store.beginMergeDrain({ runId });
      assert.deepStrictEqual(
        repaired.map((row) => [row.sequence, row.childId, row.status]),
        [
          [1, "child-c", "draining"],
          [2, "fix-a", "draining"],
        ],
      );
      yield* store.completeMerge({ runId, sequence: 1, lastAcceptedHead: "base-2" });
      yield* store.completeMerge({ runId, sequence: 2, lastAcceptedHead: "base-3" });
      assert.deepStrictEqual(Option.getOrThrow(yield* store.getMergeState({ runId })).entries, []);
      yield* store.upsertLandingEffects({
        runId,
        repositoryPath: "/repo",
        baseHead: "base-0",
        head: "base-3",
        commitCount: 5,
        parkedCount: 1,
      });
      yield* store.upsertLandingEffects({
        runId,
        repositoryPath: "/sib",
        baseHead: "sib-0",
        head: "sib-2",
        commitCount: 2,
        parkedCount: 1,
      });
      // A repeat upsert replaces only its own repository's row.
      yield* store.upsertLandingEffects({
        runId,
        repositoryPath: "/repo",
        baseHead: "base-0",
        head: "base-4",
        commitCount: 6,
        parkedCount: 1,
      });
      yield* store.deleteMergeState({ runId });
      assert.deepStrictEqual(yield* store.getLandingEffects({ runId }), [
        {
          runId,
          repositoryPath: "/repo",
          baseHead: "base-0",
          head: "base-4",
          commitCount: 6,
          parkedCount: 1,
        },
        {
          runId,
          repositoryPath: "/sib",
          baseHead: "sib-0",
          head: "sib-2",
          commitCount: 2,
          parkedCount: 1,
        },
      ]);
    }).pipe(Effect.provide(epicRunStoreLayer)),
  );

  it.effect("persists sibling merge state and advances sibling heads on complete", () =>
    Effect.gen(function* () {
      const store = yield* EpicRunStore;
      const runId = EpicRunId.make("run-merge-siblings");
      yield* store.upsertRun(makeRun({ runId }));
      yield* store.initializeMergeState({
        runId,
        lastAcceptedHead: "base-0",
        repositoryPath: "/repo",
        baseBranch: "mine",
        integrationBranch: "cook-epic-integration-run-merge-siblings",
        integrationWorktreePath: "/worktrees/integration",
        siblings: [
          {
            repositoryPath: "/sib",
            baseBranch: "main",
            integrationWorktreePath: "/worktrees/sib",
            lastAcceptedHead: "sib-0",
            initialHead: "sib-0",
          },
          {
            repositoryPath: "/sib2",
            baseBranch: "main",
            integrationWorktreePath: "/worktrees/sib2",
            lastAcceptedHead: "sib2-0",
          },
        ],
      });
      yield* store.enqueueMerge({ runId, childId: "child-a", branch: "epic/child-a" });
      yield* store.beginMergeDrain({ runId });
      yield* store.completeMerge({
        runId,
        sequence: 0,
        lastAcceptedHead: "base-1",
        siblingHeads: [
          { repositoryPath: "/sib", lastAcceptedHead: "sib-1" },
          { repositoryPath: "/sib2", lastAcceptedHead: "sib2-0" },
        ],
      });

      const persisted = Option.getOrThrow(yield* store.getMergeState({ runId }));
      assert.strictEqual(persisted.lastAcceptedHead, "base-1");
      assert.deepStrictEqual(
        persisted.siblings.map((sibling) => [sibling.repositoryPath, sibling.lastAcceptedHead]),
        [
          ["/sib", "sib-1"],
          ["/sib2", "sib2-0"],
        ],
      );
      // The landing-effects base survives head advancement.
      assert.strictEqual(persisted.siblings[0]?.initialHead, "sib-0");
    }).pipe(Effect.provide(epicRunStoreLayer)),
  );

  it.effect("round-trips operatorBaseBranch (t3code-sha), and defaults to null when omitted", () =>
    Effect.gen(function* () {
      const store = yield* EpicRunStore;
      yield* store.upsertRun(makeRun({ runId: EpicRunId.make("run-operator-branch") }));
      yield* store.initializeMergeState({
        runId: EpicRunId.make("run-operator-branch"),
        lastAcceptedHead: "base-0",
        repositoryPath: "/repo",
        baseBranch: "epic/t3code-sha/base",
        integrationBranch: "cook-epic-integration-run-operator-branch",
        integrationWorktreePath: "/worktrees/integration",
        siblings: [],
        operatorBaseBranch: "mine",
      });
      const persisted = Option.getOrThrow(
        yield* store.getMergeState({ runId: EpicRunId.make("run-operator-branch") }),
      );
      assert.strictEqual(persisted.operatorBaseBranch, "mine");

      yield* store.upsertRun(makeRun({ runId: EpicRunId.make("run-no-operator-branch") }));
      yield* store.initializeMergeState({
        runId: EpicRunId.make("run-no-operator-branch"),
        lastAcceptedHead: "base-0",
        repositoryPath: "/repo",
        baseBranch: "mine",
        integrationBranch: "cook-epic-integration-run-no-operator-branch",
        integrationWorktreePath: "/worktrees/integration",
        siblings: [],
      });
      const persistedWithoutOperator = Option.getOrThrow(
        yield* store.getMergeState({ runId: EpicRunId.make("run-no-operator-branch") }),
      );
      assert.strictEqual(persistedWithoutOperator.operatorBaseBranch, null);
    }).pipe(Effect.provide(epicRunStoreLayer)),
  );

  it.effect("decodes sibling merge state written before initialHead existed", () =>
    Effect.gen(function* () {
      const store = yield* EpicRunStore;
      const sql = yield* SqlClient.SqlClient;
      const runId = EpicRunId.make("run-merge-siblings-legacy");
      yield* store.upsertRun(makeRun({ runId }));
      yield* sql`
        INSERT INTO epic_run_merge_state (
          run_id, initial_head, last_accepted_head, repository_path, base_branch,
          integration_branch, integration_worktree_path, siblings
        ) VALUES (
          ${runId}, 'base-0', 'base-0', '/repo', 'mine',
          'cook-epic-integration-run-merge-siblings-legacy', '/worktrees/integration',
          ${'[{"repositoryPath":"/sib","baseBranch":"main","integrationWorktreePath":"/worktrees/sib","lastAcceptedHead":"sib-1"}]'}
        )
      `;

      const persisted = Option.getOrThrow(yield* store.getMergeState({ runId }));
      assert.strictEqual(persisted.siblings[0]?.lastAcceptedHead, "sib-1");
      assert.strictEqual(persisted.siblings[0]?.initialHead, undefined);
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
