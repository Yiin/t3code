import {
  applySubagentActivity,
  CheckpointRef,
  EventId,
  MessageId,
  ProjectId,
  THREAD_DETAIL_ACTIVITY_LIMIT,
  ThreadId,
  TurnId,
  ProviderInstanceId,
  type OrchestrationThreadActivity,
  type OrchestrationThreadSubagent,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Tracer from "effect/Tracer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { ORCHESTRATION_PROJECTOR_NAMES } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";

const asProjectId = (value: string): ProjectId => ProjectId.make(value);
const asTurnId = (value: string): TurnId => TurnId.make(value);
const asMessageId = (value: string): MessageId => MessageId.make(value);
const asEventId = (value: string): EventId => EventId.make(value);
const asCheckpointRef = (value: string): CheckpointRef => CheckpointRef.make(value);

/** Bare project + thread rows for the activity-cap tests, with no activities. */
const seedActivityCapFixture = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`DELETE FROM projection_projects`;
  yield* sql`DELETE FROM projection_threads`;
  yield* sql`DELETE FROM projection_thread_activities`;
  yield* sql`DELETE FROM projection_thread_subagents`;
  yield* sql`DELETE FROM projection_state`;

  yield* sql`
    INSERT INTO projection_projects (
      project_id,
      title,
      workspace_root,
      default_model_selection_json,
      scripts_json,
      created_at,
      updated_at,
      deleted_at
    )
    VALUES (
      'project-1',
      'Project 1',
      '/tmp/project-1',
      '{"provider":"codex","model":"gpt-5-codex"}',
      '[]',
      '2026-04-01T00:00:00.000Z',
      '2026-04-01T00:00:01.000Z',
      NULL
    )
  `;

  yield* sql`
    INSERT INTO projection_threads (
      thread_id,
      project_id,
      title,
      model_selection_json,
      runtime_mode,
      interaction_mode,
      branch,
      worktree_path,
      latest_turn_id,
      latest_user_message_at,
      pending_approval_count,
      pending_user_input_count,
      has_actionable_proposed_plan,
      created_at,
      updated_at,
      deleted_at
    )
    VALUES (
      'thread-1',
      'project-1',
      'Thread 1',
      '{"provider":"codex","model":"gpt-5-codex"}',
      'full-access',
      'default',
      NULL,
      NULL,
      NULL,
      NULL,
      1,
      1,
      0,
      '2026-04-01T00:00:02.000Z',
      '2026-04-01T00:00:03.000Z',
      NULL
    )
  `;
});

/** Inserts `count` ordinary activities at sequences 101..100+count. */
const insertFillerActivities = (count: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    yield* sql`
      INSERT INTO projection_thread_activities (
        activity_id,
        thread_id,
        turn_id,
        tone,
        kind,
        summary,
        payload_json,
        sequence,
        created_at
      )
      WITH RECURSIVE filler(n) AS (
        SELECT 1
        UNION ALL
        SELECT n + 1 FROM filler WHERE n < ${count}
      )
      SELECT
        'activity-filler-' || printf('%04d', n),
        'thread-1',
        NULL,
        'info',
        'runtime.note',
        'filler ' || n,
        '{"source":"filler"}',
        100 + n,
        '2026-04-01T00:01:00.000Z'
      FROM filler
    `;
  });

/**
 * Timestamps for the auto-settle candidate reads. The window is three days
 * wide, so `AUTO_SETTLE_STALE` sits one millisecond outside it and
 * `AUTO_SETTLE_FRESH` well inside it — the same boundary the client rule's
 * truth table uses.
 */
const AUTO_SETTLE_CUTOFF = "2026-04-07T00:00:00.000Z";
const AUTO_SETTLE_FRESH = "2026-04-09T00:00:00.000Z";
const AUTO_SETTLE_STALE = "2026-04-06T23:59:59.999Z";
/**
 * The running-subagent freshness cutoff the sweeps pass in, with a row on each
 * side of it: rows updated at or after the cutoff are live work the settle
 * decider would refuse; older ones are stranded rows that must not block.
 */
const AUTO_SETTLE_SUBAGENT_FRESH_AFTER = "2026-04-08T00:00:00.000Z";
const AUTO_SETTLE_SUBAGENT_FRESH = "2026-04-08T00:00:00.000Z";
const AUTO_SETTLE_SUBAGENT_STALE = "2026-04-07T23:59:59.999Z";

interface AutoSettleThreadFixture {
  readonly threadId: string;
  readonly settledOverride: "settled" | "active" | null;
  /** The latest turn's `requestedAt`, or no turn at all when null. */
  readonly activityAt: string | null;
  readonly sessionStatus: "starting" | "running" | "ready" | null;
  readonly pending: "approval" | "user-input" | null;
  readonly archived?: boolean;
  readonly deleted?: boolean;
  readonly latestUserMessageAt?: string | null;
  readonly branch?: string | null;
  readonly worktreePath?: string | null;
  readonly subagent?: {
    readonly status: "running" | "completed";
    readonly updatedAt: string;
  };
}

/** One project plus a thread (and optional session and latest turn) per fixture. */
const seedAutoSettleFixtures = (fixtures: ReadonlyArray<AutoSettleThreadFixture>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    yield* sql`DELETE FROM projection_projects`;
    yield* sql`DELETE FROM projection_threads`;
    yield* sql`DELETE FROM projection_thread_sessions`;
    yield* sql`DELETE FROM projection_turns`;
    yield* sql`DELETE FROM projection_thread_subagents`;

    yield* sql`
      INSERT INTO projection_projects (
        project_id,
        title,
        workspace_root,
        default_model_selection_json,
        scripts_json,
        created_at,
        updated_at,
        deleted_at
      )
      VALUES (
        'project-auto-settle',
        'Auto Settle',
        '/tmp/project-auto-settle',
        '{"provider":"codex","model":"gpt-5-codex"}',
        '[]',
        '2026-04-01T00:00:00.000Z',
        '2026-04-01T00:00:00.000Z',
        NULL
      )
    `;

    for (const fixture of fixtures) {
      const turnId = fixture.activityAt === null ? null : `turn-${fixture.threadId}`;

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          created_at,
          updated_at,
          archived_at,
          settled_override,
          settled_at,
          deleted_at
        )
        VALUES (
          ${fixture.threadId},
          'project-auto-settle',
          ${`Thread ${fixture.threadId}`},
          '{"provider":"codex","model":"gpt-5-codex"}',
          'full-access',
          'default',
          ${fixture.branch ?? null},
          ${fixture.worktreePath ?? null},
          ${turnId},
          ${fixture.latestUserMessageAt ?? null},
          ${fixture.pending === "approval" ? 1 : 0},
          ${fixture.pending === "user-input" ? 1 : 0},
          0,
          '2026-04-01T00:00:00.000Z',
          '2026-04-01T00:00:00.000Z',
          ${fixture.archived === true ? "2026-04-02T00:00:00.000Z" : null},
          ${fixture.settledOverride},
          ${fixture.settledOverride === "settled" ? "2026-04-02T00:00:00.000Z" : null},
          ${fixture.deleted === true ? "2026-04-02T00:00:00.000Z" : null}
        )
      `;

      if (fixture.sessionStatus !== null) {
        yield* sql`
          INSERT INTO projection_thread_sessions (
            thread_id,
            status,
            provider_name,
            provider_session_id,
            provider_thread_id,
            runtime_mode,
            active_turn_id,
            last_error,
            updated_at
          )
          VALUES (
            ${fixture.threadId},
            ${fixture.sessionStatus},
            'codex',
            NULL,
            NULL,
            'full-access',
            NULL,
            NULL,
            '2026-04-02T00:00:00.000Z'
          )
        `;
      }

      if (turnId !== null) {
        yield* sql`
          INSERT INTO projection_turns (
            thread_id,
            turn_id,
            pending_message_id,
            source_proposed_plan_thread_id,
            source_proposed_plan_id,
            assistant_message_id,
            state,
            requested_at,
            started_at,
            completed_at,
            checkpoint_turn_count,
            checkpoint_ref,
            checkpoint_status,
            checkpoint_files_json
          )
          VALUES (
            ${fixture.threadId},
            ${turnId},
            NULL,
            NULL,
            NULL,
            NULL,
            'completed',
            ${fixture.activityAt},
            NULL,
            NULL,
            NULL,
            NULL,
            NULL,
            '[]'
          )
        `;
      }

      if (fixture.subagent !== undefined) {
        yield* sql`
          INSERT INTO projection_thread_subagents (
            subagent_id,
            thread_id,
            turn_id,
            agent_type,
            description,
            status,
            last_progress_summary,
            last_tool_name,
            usage_json,
            spawned_by_item_id,
            started_at,
            updated_at,
            completed_at
          )
          VALUES (
            ${`subagent-${fixture.threadId}`},
            ${fixture.threadId},
            NULL,
            NULL,
            NULL,
            ${fixture.subagent.status},
            NULL,
            NULL,
            NULL,
            NULL,
            '2026-04-05T00:00:00.000Z',
            ${fixture.subagent.updatedAt},
            ${fixture.subagent.status === "completed" ? fixture.subagent.updatedAt : null}
          )
        `;
      }
    }
  });

/** Sets every projector's applied sequence to `sequence`. */
const setProjectionStateSequence = (sequence: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    yield* sql`DELETE FROM projection_state`;
    for (const projector of Object.values(ORCHESTRATION_PROJECTOR_NAMES)) {
      yield* sql`
        INSERT INTO projection_state (projector, last_applied_sequence, updated_at)
        VALUES (${projector}, ${sequence}, '2026-04-01T00:02:00.000Z')
      `;
    }
  });

/**
 * One projector-shaped write: append an activity and bump every projector's
 * applied sequence in a single transaction, the way the projection pipeline
 * does.
 */
const appendActivityAndBumpSequence = (sequence: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`
          INSERT INTO projection_thread_activities (
            activity_id,
            thread_id,
            turn_id,
            tone,
            kind,
            summary,
            payload_json,
            sequence,
            created_at
          )
          VALUES (
            'activity-interleaved',
            'thread-1',
            NULL,
            'info',
            'runtime.note',
            'interleaved projector write',
            '{"source":"interleaved"}',
            ${sequence},
            '2026-04-01T00:02:01.000Z'
          )
        `;
        yield* sql`UPDATE projection_state SET last_applied_sequence = ${sequence}`;
      }),
    );
  });

/**
 * Runs one read under a collecting tracer and asserts that each named read ran
 * its statement inside the transaction and its row decode after it.
 *
 * The transaction holds the single connection permit for its whole duration, so
 * a decode that drifted back inside would block every writer for its own cost
 * on top of the query's. Spans are the only place that boundary is observable.
 */
const assertRowDecodesLeaveTheTransaction =
  (label: string, operations: ReadonlyArray<string>) =>
  <A, E, R>(read: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const spans: Array<Tracer.Span> = [];
      const collectingTracer = Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options);
          spans.push(span);
          return span;
        },
      });

      // An enclosing span, so "the decode is outside the transaction" is an
      // assertion about a real parent rather than about two undefined ones.
      yield* read.pipe(Effect.withSpan(`test.${label}`), Effect.withTracer(collectingTracer));

      const spanNamed = (name: string) => {
        const matches = spans.filter((span) => span.name === name);
        assert.equal(matches.length, 1, `expected exactly one ${name} span from ${label}`);
        return matches[0]!;
      };
      const parentIdOf = (span: Tracer.Span) => span.parent.pipe(Option.getOrUndefined)?.spanId;

      const readSpan = spanNamed(`test.${label}`);
      const transactionSpan = spanNamed("sql.transaction");
      assert.equal(parentIdOf(transactionSpan), readSpan.spanId, label);

      for (const operation of operations) {
        const querySpan = spanNamed(`${operation}:query`);
        const decodeSpan = spanNamed(`${operation}:decodeRows`);

        assert.equal(parentIdOf(querySpan), transactionSpan.spanId, `${operation}:query`);
        assert.equal(parentIdOf(decodeSpan), readSpan.spanId, `${operation}:decodeRows`);
        assert.equal(
          querySpan.attributes.get("db.rows"),
          decodeSpan.attributes.get("db.rows"),
          `${operation} row counts`,
        );
      }

      // Named rather than counted, so a read added to the transaction later
      // fails here instead of passing unnoticed. `projection_state` is the one
      // read still fused: it holds one row per projector, so its decode cannot
      // grow with the workspace, and its statement must stay inside the
      // transaction to keep the resume cursor consistent with the rows.
      const transactionChildNames = spans
        .filter((span) => parentIdOf(span) === transactionSpan.spanId)
        .map((span) => span.name)
        .toSorted();
      assert.deepStrictEqual(
        transactionChildNames.filter((name) => name !== "sql.execute"),
        operations.map((operation) => `${operation}:query`).toSorted(),
        label,
      );
    });

const projectionSnapshotLayer = it.layer(
  OrchestrationProjectionSnapshotQueryLive.pipe(
    Layer.provideMerge(RepositoryIdentityResolver.layer),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(NodeServices.layer),
  ),
);

projectionSnapshotLayer("ProjectionSnapshotQuery", (it) => {
  it.effect("hydrates read model from projection tables and computes snapshot sequence", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_state`;
      yield* sql`DELETE FROM projection_thread_proposed_plans`;
      yield* sql`DELETE FROM projection_thread_subagents`;
      yield* sql`DELETE FROM projection_turns`;

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-1',
          'Project 1',
          '/tmp/project-1',
          '{"provider":"codex","model":"gpt-5-codex"}',
          '[{"id":"script-1","name":"Build","command":"bun run build","icon":"build","runOnWorktreeCreate":false}]',
          '2026-02-24T00:00:00.000Z',
          '2026-02-24T00:00:01.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'thread-1',
          'project-1',
          'Thread 1',
          '{"provider":"codex","model":"gpt-5-codex"}',
          'full-access',
          'default',
          NULL,
          NULL,
          'turn-1',
          '2026-02-24T00:00:04.000Z',
          1,
          0,
          0,
          '2026-02-24T00:00:02.000Z',
          '2026-02-24T00:00:03.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id,
          thread_id,
          turn_id,
          role,
          text,
          correlation_json,
          is_streaming,
          created_at,
          updated_at
        )
        VALUES (
          'message-1',
          'thread-1',
          'turn-1',
          'assistant',
          'hello from projection',
          '{"threadId":"thread-1","epicId":"t3code-vst","projectId":"project-1","cwd":"/repo/worktree"}',
          0,
          '2026-02-24T00:00:04.000Z',
          '2026-02-24T00:00:05.000Z'
        )
      `;

      yield* sql`
        INSERT INTO projection_thread_proposed_plans (
          plan_id,
          thread_id,
          turn_id,
          plan_markdown,
          implemented_at,
          implementation_thread_id,
          created_at,
          updated_at
        )
        VALUES (
          'plan-1',
          'thread-1',
          'turn-1',
          '# Ship it',
          '2026-02-24T00:00:05.500Z',
          'thread-2',
          '2026-02-24T00:00:05.000Z',
          '2026-02-24T00:00:05.500Z'
        )
      `;

      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id,
          thread_id,
          turn_id,
          tone,
          kind,
          summary,
          payload_json,
          created_at
        )
        VALUES (
          'activity-1',
          'thread-1',
          'turn-1',
          'info',
          'runtime.note',
          'provider started',
          '{"stage":"start"}',
          '2026-02-24T00:00:06.000Z'
        )
      `;

      yield* sql`
        INSERT INTO projection_thread_sessions (
          thread_id,
          status,
          provider_name,
          provider_session_id,
          provider_thread_id,
          runtime_mode,
          active_turn_id,
          last_error,
          updated_at
        )
        VALUES (
          'thread-1',
          'running',
          'codex',
          'provider-session-1',
          'provider-thread-1',
          'approval-required',
          'turn-1',
          NULL,
          '2026-02-24T00:00:07.000Z'
        )
      `;

      yield* sql`
        INSERT INTO projection_thread_subagents (
          subagent_id,
          thread_id,
          turn_id,
          agent_type,
          description,
          status,
          last_progress_summary,
          last_tool_name,
          usage_json,
          spawned_by_item_id,
          started_at,
          updated_at,
          completed_at
        )
        VALUES
          (
            'task-2',
            'thread-1',
            'turn-1',
            NULL,
            NULL,
            'completed',
            'Done',
            NULL,
            '{"totalTokens":42}',
            NULL,
            '2026-02-24T00:00:04.500Z',
            '2026-02-24T00:00:05.500Z',
            '2026-02-24T00:00:05.500Z'
          ),
          (
            'task-1',
            'thread-1',
            'turn-1',
            'Explore',
            'Scan the repo',
            'running',
            'Reading files',
            'Read',
            NULL,
            'toolu-1',
            '2026-02-24T00:00:05.000Z',
            '2026-02-24T00:00:06.000Z',
            NULL
          )
      `;

      yield* sql`
        INSERT INTO projection_turns (
          thread_id,
          turn_id,
          pending_message_id,
          source_proposed_plan_thread_id,
          source_proposed_plan_id,
          assistant_message_id,
          state,
          requested_at,
          started_at,
          completed_at,
          checkpoint_turn_count,
          checkpoint_ref,
          checkpoint_status,
          checkpoint_files_json
        )
        VALUES (
          'thread-1',
          'turn-1',
          NULL,
          'thread-1',
          'plan-1',
          'message-1',
          'completed',
          '2026-02-24T00:00:08.000Z',
          '2026-02-24T00:00:08.000Z',
          '2026-02-24T00:00:08.000Z',
          1,
          'checkpoint-1',
          'ready',
          '[{"path":"README.md","kind":"modified","additions":2,"deletions":1}]'
        )
      `;

      let sequence = 5;
      for (const projector of Object.values(ORCHESTRATION_PROJECTOR_NAMES)) {
        yield* sql`
          INSERT INTO projection_state (
            projector,
            last_applied_sequence,
            updated_at
          )
          VALUES (
            ${projector},
            ${sequence},
            '2026-02-24T00:00:09.000Z'
          )
        `;
        sequence += 1;
      }

      const snapshot = yield* snapshotQuery.getSnapshot();

      assert.equal(snapshot.snapshotSequence, 5);
      assert.equal(snapshot.updatedAt, "2026-02-24T00:00:09.000Z");
      assert.deepEqual(snapshot.projects, [
        {
          id: asProjectId("project-1"),
          title: "Project 1",
          workspaceRoot: "/tmp/project-1",
          repositoryIdentity: null,
          defaultModelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          scripts: [
            {
              id: "script-1",
              name: "Build",
              command: "bun run build",
              icon: "build",
              runOnWorktreeCreate: false,
            },
          ],
          createdAt: "2026-02-24T00:00:00.000Z",
          updatedAt: "2026-02-24T00:00:01.000Z",
          deletedAt: null,
        },
      ]);
      assert.deepEqual(snapshot.threads, [
        {
          id: ThreadId.make("thread-1"),
          projectId: asProjectId("project-1"),
          title: "Thread 1",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: "default",
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          latestTurn: {
            turnId: asTurnId("turn-1"),
            state: "completed",
            requestedAt: "2026-02-24T00:00:08.000Z",
            startedAt: "2026-02-24T00:00:08.000Z",
            completedAt: "2026-02-24T00:00:08.000Z",
            assistantMessageId: asMessageId("message-1"),
            sourceProposedPlan: {
              threadId: ThreadId.make("thread-1"),
              planId: "plan-1",
            },
          },
          createdAt: "2026-02-24T00:00:02.000Z",
          updatedAt: "2026-02-24T00:00:03.000Z",
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          deletedAt: null,
          messages: [
            {
              id: asMessageId("message-1"),
              role: "assistant",
              text: "hello from projection",
              correlation: {
                threadId: ThreadId.make("thread-1"),
                epicId: "t3code-vst",
                projectId: ProjectId.make("project-1"),
                cwd: "/repo/worktree",
              },
              turnId: asTurnId("turn-1"),
              streaming: false,
              createdAt: "2026-02-24T00:00:04.000Z",
              updatedAt: "2026-02-24T00:00:05.000Z",
            },
          ],
          proposedPlans: [
            {
              id: "plan-1",
              turnId: asTurnId("turn-1"),
              planMarkdown: "# Ship it",
              implementedAt: "2026-02-24T00:00:05.500Z",
              implementationThreadId: ThreadId.make("thread-2"),
              createdAt: "2026-02-24T00:00:05.000Z",
              updatedAt: "2026-02-24T00:00:05.500Z",
            },
          ],
          subagents: [
            {
              subagentId: "task-2",
              turnId: asTurnId("turn-1"),
              status: "completed",
              lastProgressSummary: "Done",
              usage: { totalTokens: 42 },
              startedAt: "2026-02-24T00:00:04.500Z",
              updatedAt: "2026-02-24T00:00:05.500Z",
              completedAt: "2026-02-24T00:00:05.500Z",
            },
            {
              subagentId: "task-1",
              turnId: asTurnId("turn-1"),
              agentType: "Explore",
              description: "Scan the repo",
              status: "running",
              lastProgressSummary: "Reading files",
              lastToolName: "Read",
              spawnedByItemId: "toolu-1",
              startedAt: "2026-02-24T00:00:05.000Z",
              updatedAt: "2026-02-24T00:00:06.000Z",
              completedAt: null,
            },
          ],
          activities: [
            {
              id: asEventId("activity-1"),
              tone: "info",
              kind: "runtime.note",
              summary: "provider started",
              payload: { stage: "start" },
              turnId: asTurnId("turn-1"),
              createdAt: "2026-02-24T00:00:06.000Z",
            },
          ],
          checkpoints: [
            {
              turnId: asTurnId("turn-1"),
              checkpointTurnCount: 1,
              checkpointRef: asCheckpointRef("checkpoint-1"),
              status: "ready",
              files: [{ path: "README.md", kind: "modified", additions: 2, deletions: 1 }],
              assistantMessageId: asMessageId("message-1"),
              completedAt: "2026-02-24T00:00:08.000Z",
            },
          ],
          session: {
            threadId: ThreadId.make("thread-1"),
            status: "running",
            providerName: "codex",
            runtimeMode: "approval-required",
            activeTurnId: asTurnId("turn-1"),
            lastError: null,
            updatedAt: "2026-02-24T00:00:07.000Z",
          },
        },
      ]);

      const shellSnapshot = yield* snapshotQuery.getShellSnapshot();
      assert.equal(shellSnapshot.snapshotSequence, 5);
      assert.deepEqual(shellSnapshot.projects, [
        {
          id: asProjectId("project-1"),
          title: "Project 1",
          workspaceRoot: "/tmp/project-1",
          repositoryIdentity: null,
          defaultModelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          scripts: [
            {
              id: "script-1",
              name: "Build",
              command: "bun run build",
              icon: "build",
              runOnWorktreeCreate: false,
            },
          ],
          createdAt: "2026-02-24T00:00:00.000Z",
          updatedAt: "2026-02-24T00:00:01.000Z",
        },
      ]);
      assert.deepEqual(shellSnapshot.threads, [
        {
          id: ThreadId.make("thread-1"),
          projectId: asProjectId("project-1"),
          title: "Thread 1",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: "default",
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          latestTurn: {
            turnId: asTurnId("turn-1"),
            state: "completed",
            requestedAt: "2026-02-24T00:00:08.000Z",
            startedAt: "2026-02-24T00:00:08.000Z",
            completedAt: "2026-02-24T00:00:08.000Z",
            assistantMessageId: asMessageId("message-1"),
            sourceProposedPlan: {
              threadId: ThreadId.make("thread-1"),
              planId: "plan-1",
            },
          },
          createdAt: "2026-02-24T00:00:02.000Z",
          updatedAt: "2026-02-24T00:00:03.000Z",
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          session: {
            threadId: ThreadId.make("thread-1"),
            status: "running",
            providerName: "codex",
            runtimeMode: "approval-required",
            activeTurnId: asTurnId("turn-1"),
            lastError: null,
            updatedAt: "2026-02-24T00:00:07.000Z",
          },
          latestUserMessageAt: "2026-02-24T00:00:04.000Z",
          hasPendingApprovals: true,
          hasPendingUserInput: false,
          hasActionableProposedPlan: false,
          activeSubagentCount: 1,
        },
      ]);

      const threadDetail = yield* snapshotQuery.getThreadDetailById(ThreadId.make("thread-1"));
      assert.equal(threadDetail._tag, "Some");
      if (threadDetail._tag === "Some") {
        assert.deepEqual(threadDetail.value, snapshot.threads[0]);
      }

      // The live shell-row refetch (ws.ts) must agree with the bulk shell
      // snapshot on the running count.
      const threadShell = yield* snapshotQuery.getThreadShellById(ThreadId.make("thread-1"));
      assert.equal(threadShell._tag, "Some");
      if (threadShell._tag === "Some") {
        assert.equal(threadShell.value.activeSubagentCount, 1);
      }
    }),
  );

  // The acceptance contract for thread.subagents: a client that connects
  // mid-run hydrates from the snapshot, a client connected the whole time
  // folded every task.* activity itself, and both must hold the same rows.
  // The SQL projector persists via the same shared fold (covered by the
  // projection pipeline tests), so what this pins down is the snapshot read
  // path: rows come back exactly as folded, and replaying the snapshot's own
  // activities — or fresh live ones — over them cannot make the views drift.
  it.effect("thread detail subagents converge with a live fold over the same activities", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* seedActivityCapFixture;
      yield* setProjectionStateSequence(103);

      const startedActivity: OrchestrationThreadActivity = {
        id: asEventId("activity-task-started"),
        tone: "info",
        kind: "task.started",
        summary: "Subagent started",
        payload: {
          taskId: "task-1",
          detail: "Scan the repo",
          subagentType: "Explore",
          toolUseId: "toolu-1",
        },
        turnId: asTurnId("turn-1"),
        sequence: 101,
        createdAt: "2026-04-01T00:00:10.000Z",
      };
      const progressActivity: OrchestrationThreadActivity = {
        id: asEventId("activity-task-progress"),
        tone: "info",
        kind: "task.progress",
        summary: "Subagent progress",
        payload: {
          taskId: "task-1",
          summary: "Reading files",
          lastToolName: "Read",
        },
        turnId: asTurnId("turn-1"),
        sequence: 102,
        createdAt: "2026-04-01T00:00:11.000Z",
      };
      const snapshotActivities = [startedActivity, progressActivity];

      for (const activity of snapshotActivities) {
        yield* sql`
          INSERT INTO projection_thread_activities (
            activity_id,
            thread_id,
            turn_id,
            tone,
            kind,
            summary,
            payload_json,
            sequence,
            created_at
          )
          VALUES (
            ${activity.id},
            'thread-1',
            ${activity.turnId},
            ${activity.tone},
            ${activity.kind},
            ${activity.summary},
            ${
              // @effect-diagnostics-next-line preferSchemaOverJson:off
              JSON.stringify(activity.payload)
            },
            ${activity.sequence ?? null},
            ${activity.createdAt}
          )
        `;
      }

      // What the SQL projector would have persisted: the same shared fold,
      // one row per subagent.
      const foldedRows = snapshotActivities.reduce<ReadonlyArray<OrchestrationThreadSubagent>>(
        applySubagentActivity,
        [],
      );
      for (const row of foldedRows) {
        yield* sql`
          INSERT INTO projection_thread_subagents (
            subagent_id,
            thread_id,
            turn_id,
            agent_type,
            description,
            status,
            last_progress_summary,
            last_tool_name,
            usage_json,
            spawned_by_item_id,
            started_at,
            updated_at,
            completed_at
          )
          VALUES (
            ${row.subagentId},
            'thread-1',
            ${row.turnId},
            ${row.agentType ?? null},
            ${row.description ?? null},
            ${row.status},
            ${row.lastProgressSummary ?? null},
            ${row.lastToolName ?? null},
            ${
              // @effect-diagnostics-next-line preferSchemaOverJson:off
              row.usage !== undefined ? JSON.stringify(row.usage) : null
            },
            ${row.spawnedByItemId ?? null},
            ${row.startedAt},
            ${row.updatedAt},
            ${row.completedAt}
          )
        `;
      }

      const snapshot = yield* snapshotQuery.getThreadDetailSnapshot(ThreadId.make("thread-1"));
      assert.equal(snapshot._tag, "Some");
      if (snapshot._tag !== "Some") {
        return;
      }

      // Mid-run client: the snapshot carries the folded rows verbatim.
      assert.deepEqual(snapshot.value.thread.subagents, foldedRows);

      // Reconnect replay: re-applying the snapshot's own activities over the
      // snapshot rows is a no-op, so an overlap between snapshot and event
      // resume cannot corrupt the rows.
      const replayed = snapshot.value.thread.activities.reduce(
        applySubagentActivity,
        snapshot.value.thread.subagents,
      );
      assert.deepEqual(replayed, foldedRows);

      // Live tail: folding a fresh task.completed over the snapshot rows
      // lands on the same state as a client that folded every activity from
      // the start.
      const completedActivity: OrchestrationThreadActivity = {
        id: asEventId("activity-task-completed"),
        tone: "info",
        kind: "task.completed",
        summary: "Subagent completed",
        payload: {
          taskId: "task-1",
          status: "completed",
          summary: "Found 3 call sites",
        },
        turnId: asTurnId("turn-1"),
        sequence: 103,
        createdAt: "2026-04-01T00:00:12.000Z",
      };
      const snapshotThenLive = applySubagentActivity(
        snapshot.value.thread.subagents,
        completedActivity,
      );
      const foldedFromStart = [...snapshotActivities, completedActivity].reduce<
        ReadonlyArray<OrchestrationThreadSubagent>
      >(applySubagentActivity, []);
      assert.deepEqual(snapshotThenLive, foldedFromStart);
      assert.equal(snapshotThenLive[0]?.status, "completed");
    }),
  );

  it.effect("keeps archived threads out of the main shell snapshot", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_state`;

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-archive-test',
          'Archive Test',
          '/tmp/archive-test',
          '{"provider":"codex","model":"gpt-5-codex"}',
          '[]',
          '2026-04-06T00:00:00.000Z',
          '2026-04-06T00:00:01.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          created_at,
          updated_at,
          archived_at,
          deleted_at
        )
        VALUES
          (
            'thread-active',
            'project-archive-test',
            'Active Thread',
            '{"provider":"codex","model":"gpt-5-codex"}',
            'full-access',
            'default',
            NULL,
            NULL,
            NULL,
            NULL,
            0,
            0,
            0,
            '2026-04-06T00:00:02.000Z',
            '2026-04-06T00:00:03.000Z',
            NULL,
            NULL
          ),
          (
            'thread-archived',
            'project-archive-test',
            'Archived Thread',
            '{"provider":"codex","model":"gpt-5-codex"}',
            'full-access',
            'default',
            NULL,
            NULL,
            NULL,
            NULL,
            0,
            0,
            0,
            '2026-04-06T00:00:04.000Z',
            '2026-04-06T00:00:05.000Z',
            '2026-04-06T00:00:06.000Z',
            NULL
          )
      `;

      yield* sql`
        INSERT INTO projection_state (projector, last_applied_sequence, updated_at)
        VALUES
          (${ORCHESTRATION_PROJECTOR_NAMES.projects}, 4, '2026-04-06T00:00:07.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threads}, 4, '2026-04-06T00:00:07.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threadMessages}, 4, '2026-04-06T00:00:07.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threadProposedPlans}, 4, '2026-04-06T00:00:07.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threadActivities}, 4, '2026-04-06T00:00:07.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threadSessions}, 4, '2026-04-06T00:00:07.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.checkpoints}, 4, '2026-04-06T00:00:07.000Z')
      `;

      const shellSnapshot = yield* snapshotQuery.getShellSnapshot();
      assert.deepEqual(
        shellSnapshot.threads.map((thread) => thread.id),
        [ThreadId.make("thread-active")],
      );

      const archivedShellSnapshot = yield* snapshotQuery.getArchivedShellSnapshot();
      assert.deepEqual(
        archivedShellSnapshot.threads.map((thread) => thread.id),
        [ThreadId.make("thread-archived")],
      );
      assert.equal(archivedShellSnapshot.threads[0]?.archivedAt, "2026-04-06T00:00:06.000Z");
    }),
  );

  it.effect("reads an archived thread's session even though the shell query hides it", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_thread_sessions`;
      yield* sql`DELETE FROM projection_state`;

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-archived-session',
          'Archived Session',
          '/tmp/archived-session',
          '{"provider":"codex","model":"gpt-5-codex"}',
          '[]',
          '2026-04-06T00:00:00.000Z',
          '2026-04-06T00:00:01.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          created_at,
          updated_at,
          archived_at,
          deleted_at
        )
        VALUES
          (
            'thread-archived-with-session',
            'project-archived-session',
            'Archived With Session',
            '{"provider":"codex","model":"gpt-5-codex"}',
            'full-access',
            'default',
            NULL,
            NULL,
            NULL,
            NULL,
            0,
            0,
            0,
            '2026-04-06T00:00:02.000Z',
            '2026-04-06T00:00:03.000Z',
            '2026-04-06T00:00:04.000Z',
            NULL
          ),
          (
            'thread-active-without-session',
            'project-archived-session',
            'Active Without Session',
            '{"provider":"codex","model":"gpt-5-codex"}',
            'full-access',
            'default',
            NULL,
            NULL,
            NULL,
            NULL,
            0,
            0,
            0,
            '2026-04-06T00:00:05.000Z',
            '2026-04-06T00:00:06.000Z',
            NULL,
            NULL
          )
      `;

      yield* sql`
        INSERT INTO projection_thread_sessions (
          thread_id,
          status,
          provider_name,
          provider_session_id,
          provider_thread_id,
          runtime_mode,
          active_turn_id,
          last_error,
          updated_at
        )
        VALUES (
          'thread-archived-with-session',
          'running',
          'codex',
          NULL,
          NULL,
          'full-access',
          NULL,
          NULL,
          '2026-04-06T00:00:07.000Z'
        )
      `;

      // The shell read filters `archived_at IS NULL`, so archive teardown
      // (ThreadTeardownReactor on `thread.archived`) cannot use it to decide
      // whether a session is still worth stopping.
      const hiddenShell = yield* snapshotQuery.getThreadShellById(
        ThreadId.make("thread-archived-with-session"),
      );
      assert.isTrue(Option.isNone(hiddenShell));

      const archivedSession = yield* snapshotQuery.getThreadSessionById(
        ThreadId.make("thread-archived-with-session"),
      );
      assert.deepEqual(Option.getOrNull(archivedSession), {
        threadId: ThreadId.make("thread-archived-with-session"),
        status: "running",
        providerName: "codex",
        runtimeMode: "full-access",
        activeTurnId: null,
        lastError: null,
        updatedAt: "2026-04-06T00:00:07.000Z",
      });

      const missingSession = yield* snapshotQuery.getThreadSessionById(
        ThreadId.make("thread-active-without-session"),
      );
      assert.isTrue(Option.isNone(missingSession));
    }),
  );

  it.effect("keeps settled threads in the shell snapshot with non-null settlement fields", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_state`;

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-settled-test',
          'Settled Test',
          '/tmp/settled-test',
          '{"provider":"codex","model":"gpt-5-codex"}',
          '[]',
          '2026-04-06T00:00:00.000Z',
          '2026-04-06T00:00:01.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          created_at,
          updated_at,
          archived_at,
          settled_override,
          settled_at,
          deleted_at
        )
        VALUES (
          'thread-settled',
          'project-settled-test',
          'Settled Thread',
          '{"provider":"codex","model":"gpt-5-codex"}',
          'full-access',
          'default',
          NULL,
          NULL,
          NULL,
          NULL,
          0,
          0,
          0,
          '2026-04-06T00:00:02.000Z',
          '2026-04-06T00:00:05.000Z',
          NULL,
          'settled',
          '2026-04-06T00:00:04.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_state (projector, last_applied_sequence, updated_at)
        VALUES
          (${ORCHESTRATION_PROJECTOR_NAMES.projects}, 4, '2026-04-06T00:00:07.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threads}, 4, '2026-04-06T00:00:07.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threadMessages}, 4, '2026-04-06T00:00:07.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threadProposedPlans}, 4, '2026-04-06T00:00:07.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threadActivities}, 4, '2026-04-06T00:00:07.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threadSessions}, 4, '2026-04-06T00:00:07.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.checkpoints}, 4, '2026-04-06T00:00:07.000Z')
      `;

      // Settled ≠ archived: the thread must appear in the LIVE shell
      // snapshot, carrying its settlement fields through the row aliases.
      const shellSnapshot = yield* snapshotQuery.getShellSnapshot();
      assert.deepEqual(
        shellSnapshot.threads.map((thread) => thread.id),
        [ThreadId.make("thread-settled")],
      );
      assert.equal(shellSnapshot.threads[0]?.settledOverride, "settled");
      assert.equal(shellSnapshot.threads[0]?.settledAt, "2026-04-06T00:00:04.000Z");

      // And the full command read model carries them too.
      const readModel = yield* snapshotQuery.getCommandReadModel();
      const thread = readModel.threads.find(
        (candidate) => candidate.id === ThreadId.make("thread-settled"),
      );
      assert.equal(thread?.settledOverride, "settled");
      assert.equal(thread?.settledAt, "2026-04-06T00:00:04.000Z");
    }),
  );

  it.effect(
    "reads targeted project, thread, and count queries without hydrating the full snapshot",
    () =>
      Effect.gen(function* () {
        const snapshotQuery = yield* ProjectionSnapshotQuery;
        const sql = yield* SqlClient.SqlClient;

        yield* sql`DELETE FROM projection_projects`;
        yield* sql`DELETE FROM projection_threads`;
        yield* sql`DELETE FROM projection_turns`;

        yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES
          (
            'project-active',
            'Active Project',
            '/tmp/workspace',
            '{"provider":"codex","model":"gpt-5-codex"}',
            '[]',
            '2026-03-01T00:00:00.000Z',
            '2026-03-01T00:00:01.000Z',
            NULL
          ),
          (
            'project-deleted',
            'Deleted Project',
            '/tmp/deleted',
            NULL,
            '[]',
            '2026-03-01T00:00:02.000Z',
            '2026-03-01T00:00:03.000Z',
            '2026-03-01T00:00:04.000Z'
          )
      `;

        yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          created_at,
          updated_at,
          archived_at,
          deleted_at
        )
        VALUES
          (
            'thread-first',
            'project-active',
            'First Thread',
            '{"provider":"codex","model":"gpt-5-codex"}',
            'full-access',
            'default',
            NULL,
            NULL,
            NULL,
            '2026-03-01T00:00:05.000Z',
            '2026-03-01T00:00:06.000Z',
            NULL,
            NULL
          ),
          (
            'thread-second',
            'project-active',
            'Second Thread',
            '{"provider":"codex","model":"gpt-5-codex"}',
            'full-access',
            'default',
            NULL,
            NULL,
            NULL,
            '2026-03-01T00:00:07.000Z',
            '2026-03-01T00:00:08.000Z',
            NULL,
            NULL
          ),
          (
            'thread-deleted',
            'project-active',
            'Deleted Thread',
            '{"provider":"codex","model":"gpt-5-codex"}',
            'full-access',
            'default',
            NULL,
            NULL,
            NULL,
            '2026-03-01T00:00:09.000Z',
            '2026-03-01T00:00:10.000Z',
            NULL,
            '2026-03-01T00:00:11.000Z'
          )
      `;

        const counts = yield* snapshotQuery.getCounts();
        assert.deepEqual(counts, {
          projectCount: 2,
          threadCount: 3,
        });

        const project = yield* snapshotQuery.getActiveProjectByWorkspaceRoot("/tmp/workspace");
        assert.equal(project._tag, "Some");
        if (project._tag === "Some") {
          assert.equal(project.value.id, asProjectId("project-active"));
        }

        const missingProject = yield* snapshotQuery.getActiveProjectByWorkspaceRoot("/tmp/missing");
        assert.equal(missingProject._tag, "None");

        const firstThreadId = yield* snapshotQuery.getFirstActiveThreadIdByProjectId(
          asProjectId("project-active"),
        );
        assert.equal(firstThreadId._tag, "Some");
        if (firstThreadId._tag === "Some") {
          assert.equal(firstThreadId.value, ThreadId.make("thread-first"));
        }
      }),
  );

  it.effect("reads single-thread checkpoint context without hydrating unrelated threads", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_turns`;

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-context',
          'Context Project',
          '/tmp/context-workspace',
          NULL,
          '[]',
          '2026-03-02T00:00:00.000Z',
          '2026-03-02T00:00:01.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          created_at,
          updated_at,
          archived_at,
          deleted_at
        )
        VALUES (
          'thread-context',
          'project-context',
          'Context Thread',
          '{"provider":"codex","model":"gpt-5-codex"}',
          'full-access',
          'default',
          'feature/perf',
          '/tmp/context-worktree',
          NULL,
          '2026-03-02T00:00:02.000Z',
          '2026-03-02T00:00:03.000Z',
          NULL,
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_turns (
          thread_id,
          turn_id,
          pending_message_id,
          source_proposed_plan_thread_id,
          source_proposed_plan_id,
          assistant_message_id,
          state,
          requested_at,
          started_at,
          completed_at,
          checkpoint_turn_count,
          checkpoint_ref,
          checkpoint_status,
          checkpoint_files_json
        )
        VALUES
          (
            'thread-context',
            'turn-1',
            NULL,
            NULL,
            NULL,
            NULL,
            'completed',
            '2026-03-02T00:00:04.000Z',
            '2026-03-02T00:00:04.000Z',
            '2026-03-02T00:00:04.000Z',
            1,
            'checkpoint-a',
            'ready',
            '[]'
          ),
          (
            'thread-context',
            'turn-2',
            NULL,
            NULL,
            NULL,
            NULL,
            'completed',
            '2026-03-02T00:00:05.000Z',
            '2026-03-02T00:00:05.000Z',
            '2026-03-02T00:00:05.000Z',
            2,
            'checkpoint-b',
            'ready',
            '[]'
          )
      `;

      const context = yield* snapshotQuery.getThreadCheckpointContext(
        ThreadId.make("thread-context"),
      );
      assert.equal(context._tag, "Some");
      if (context._tag === "Some") {
        assert.deepEqual(context.value, {
          threadId: ThreadId.make("thread-context"),
          projectId: asProjectId("project-context"),
          workspaceRoot: "/tmp/context-workspace",
          worktreePath: "/tmp/context-worktree",
          checkpoints: [
            {
              turnId: asTurnId("turn-1"),
              checkpointTurnCount: 1,
              checkpointRef: asCheckpointRef("checkpoint-a"),
              status: "ready",
              files: [],
              assistantMessageId: null,
              completedAt: "2026-03-02T00:00:04.000Z",
            },
            {
              turnId: asTurnId("turn-2"),
              checkpointTurnCount: 2,
              checkpointRef: asCheckpointRef("checkpoint-b"),
              status: "ready",
              files: [],
              assistantMessageId: null,
              completedAt: "2026-03-02T00:00:05.000Z",
            },
          ],
        });
      }
    }),
  );

  it.effect("keeps thread detail activity ordering consistent with shell snapshot ordering", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_thread_activities`;
      yield* sql`DELETE FROM projection_state`;

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-1',
          'Project 1',
          '/tmp/project-1',
          '{"provider":"codex","model":"gpt-5-codex"}',
          '[]',
          '2026-04-01T00:00:00.000Z',
          '2026-04-01T00:00:01.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'thread-1',
          'project-1',
          'Thread 1',
          '{"provider":"codex","model":"gpt-5-codex"}',
          'full-access',
          'default',
          NULL,
          NULL,
          NULL,
          NULL,
          0,
          0,
          0,
          '2026-04-01T00:00:02.000Z',
          '2026-04-01T00:00:03.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id,
          thread_id,
          turn_id,
          tone,
          kind,
          summary,
          payload_json,
          sequence,
          created_at
        )
        VALUES
          (
            'activity-unsequenced',
            'thread-1',
            NULL,
            'info',
            'runtime.note',
            'unsequenced first',
            '{"source":"unsequenced"}',
            NULL,
            '2026-04-01T00:00:06.000Z'
          ),
          (
            'activity-sequence-2',
            'thread-1',
            NULL,
            'info',
            'runtime.note',
            'sequence two',
            '{"source":"sequence-2"}',
            2,
            '2026-04-01T00:00:04.000Z'
          ),
          (
            'activity-sequence-1',
            'thread-1',
            NULL,
            'info',
            'runtime.note',
            'sequence one',
            '{"source":"sequence-1"}',
            1,
            '2026-04-01T00:00:05.000Z'
          )
      `;

      const snapshot = yield* snapshotQuery.getSnapshot();
      const threadDetail = yield* snapshotQuery.getThreadDetailById(ThreadId.make("thread-1"));

      assert.equal(threadDetail._tag, "Some");
      if (threadDetail._tag === "Some") {
        assert.deepEqual(threadDetail.value.activities, snapshot.threads[0]?.activities ?? []);
      }

      assert.deepEqual(snapshot.threads[0]?.activities ?? [], [
        {
          id: asEventId("activity-unsequenced"),
          tone: "info",
          kind: "runtime.note",
          summary: "unsequenced first",
          payload: { source: "unsequenced" },
          turnId: null,
          createdAt: "2026-04-01T00:00:06.000Z",
        },
        {
          id: asEventId("activity-sequence-1"),
          tone: "info",
          kind: "runtime.note",
          summary: "sequence one",
          payload: { source: "sequence-1" },
          turnId: null,
          sequence: 1,
          createdAt: "2026-04-01T00:00:05.000Z",
        },
        {
          id: asEventId("activity-sequence-2"),
          tone: "info",
          kind: "runtime.note",
          summary: "sequence two",
          payload: { source: "sequence-2" },
          turnId: null,
          sequence: 2,
          createdAt: "2026-04-01T00:00:04.000Z",
        },
      ]);
    }),
  );

  it.effect(
    "keeps unresolved approval and user-input requests that fall outside the newest-N activity window",
    () =>
      Effect.gen(function* () {
        const snapshotQuery = yield* ProjectionSnapshotQuery;
        const sql = yield* SqlClient.SqlClient;

        yield* seedActivityCapFixture;

        // Sequences 1-6 are the request rows; the 600 fillers start at 101, so
        // every request row is older than the newest-N window.
        yield* insertFillerActivities(600);
        yield* sql`
          INSERT INTO projection_thread_activities (
            activity_id,
            thread_id,
            turn_id,
            tone,
            kind,
            summary,
            payload_json,
            sequence,
            created_at
          )
          VALUES
            (
              'activity-approval-open',
              'thread-1',
              NULL,
              'approval',
              'approval.requested',
              'Approve rm -rf',
              '{"requestId":"request-open","requestKind":"command","detail":"rm -rf ./build"}',
              1,
              '2026-04-01T00:00:10.000Z'
            ),
            (
              'activity-approval-answered-requested',
              'thread-1',
              NULL,
              'approval',
              'approval.requested',
              'Approve ls',
              '{"requestId":"request-answered","requestKind":"command","detail":"ls"}',
              2,
              '2026-04-01T00:00:11.000Z'
            ),
            (
              'activity-approval-answered-resolved',
              'thread-1',
              NULL,
              'info',
              'approval.resolved',
              'Approved ls',
              '{"requestId":"request-answered","decision":"approved"}',
              3,
              '2026-04-01T00:00:12.000Z'
            ),
            (
              'activity-user-input-open',
              'thread-1',
              NULL,
              'approval',
              'user-input.requested',
              'Pick a branch',
              '{"requestId":"input-open","questions":[{"id":"branch","header":"Branch","question":"Which branch?","options":[{"label":"main","description":"the default branch"}]}]}',
              4,
              '2026-04-01T00:00:13.000Z'
            ),
            (
              'activity-user-input-answered-requested',
              'thread-1',
              NULL,
              'approval',
              'user-input.requested',
              'Pick a remote',
              '{"requestId":"input-answered","questions":[{"id":"remote","header":"Remote","question":"Which remote?","options":[{"label":"origin","description":"the default remote"}]}]}',
              5,
              '2026-04-01T00:00:14.000Z'
            ),
            (
              'activity-user-input-answered-resolved',
              'thread-1',
              NULL,
              'info',
              'user-input.resolved',
              'Answered remote',
              '{"requestId":"input-answered"}',
              6,
              '2026-04-01T00:00:15.000Z'
            )
        `;

        const threadDetail = yield* snapshotQuery.getThreadDetailById(ThreadId.make("thread-1"));
        assert.equal(threadDetail._tag, "Some");
        if (threadDetail._tag !== "Some") {
          return;
        }
        const activities = threadDetail.value.activities;

        // Newest-N fillers plus all six pinned request rows.
        assert.equal(activities.length, THREAD_DETAIL_ACTIVITY_LIMIT + 6);

        const ids = activities.map((activity) => activity.id);
        assert.equal(new Set(ids).size, ids.length);
        assert.deepEqual(
          ids.filter((id) => !id.startsWith("activity-filler-")),
          [
            asEventId("activity-approval-open"),
            asEventId("activity-approval-answered-requested"),
            asEventId("activity-approval-answered-resolved"),
            asEventId("activity-user-input-open"),
            asEventId("activity-user-input-answered-requested"),
            asEventId("activity-user-input-answered-resolved"),
          ],
        );

        // The window itself is still the newest N, and the whole list is still
        // ascending — the client reducer re-sorts by the same key.
        const fillerSequences = activities
          .filter((activity) => activity.id.startsWith("activity-filler-"))
          .map((activity) => activity.sequence ?? -1);
        assert.equal(fillerSequences.length, THREAD_DETAIL_ACTIVITY_LIMIT);
        assert.equal(fillerSequences[0], 201);
        assert.equal(fillerSequences[fillerSequences.length - 1], 700);
        const sequences = activities.map((activity) => activity.sequence ?? -1);
        assert.deepEqual(
          sequences,
          sequences.toSorted((left, right) => left - right),
        );
      }),
  );

  it.effect("reports how many activities the capped read left out", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;

      yield* seedActivityCapFixture;
      yield* insertFillerActivities(600);

      const threadDetail = yield* snapshotQuery.getThreadDetailById(ThreadId.make("thread-1"));
      assert.equal(threadDetail._tag, "Some");
      if (threadDetail._tag !== "Some") {
        return;
      }
      assert.deepEqual(threadDetail.value.activitiesTruncated, {
        omittedCount: 600 - THREAD_DETAIL_ACTIVITY_LIMIT,
      });
    }),
  );

  it.effect("leaves the truncation marker absent when the whole history fits", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;

      yield* seedActivityCapFixture;
      yield* insertFillerActivities(THREAD_DETAIL_ACTIVITY_LIMIT);

      const threadDetail = yield* snapshotQuery.getThreadDetailById(ThreadId.make("thread-1"));
      assert.equal(threadDetail._tag, "Some");
      if (threadDetail._tag !== "Some") {
        return;
      }
      assert.equal(threadDetail.value.activities.length, THREAD_DETAIL_ACTIVITY_LIMIT);
      assert.equal(threadDetail.value.activitiesTruncated, undefined);
    }),
  );

  it.effect("counts pinned request rows as returned, not omitted", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* seedActivityCapFixture;
      yield* insertFillerActivities(600);
      // One request row older than the newest-N window; the cap pins it, so the
      // omitted count must not include it.
      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id,
          thread_id,
          turn_id,
          tone,
          kind,
          summary,
          payload_json,
          sequence,
          created_at
        )
        VALUES (
          'activity-approval-open',
          'thread-1',
          NULL,
          'approval',
          'approval.requested',
          'Approve rm -rf',
          '{"requestId":"request-open","requestKind":"command","detail":"rm -rf ./build"}',
          1,
          '2026-04-01T00:00:10.000Z'
        )
      `;

      const threadDetail = yield* snapshotQuery.getThreadDetailById(ThreadId.make("thread-1"));
      assert.equal(threadDetail._tag, "Some");
      if (threadDetail._tag !== "Some") {
        return;
      }
      assert.equal(threadDetail.value.activities.length, THREAD_DETAIL_ACTIVITY_LIMIT + 1);
      assert.deepEqual(threadDetail.value.activitiesTruncated, {
        omittedCount: 600 - THREAD_DETAIL_ACTIVITY_LIMIT,
      });
    }),
  );

  it.effect("caps a thread with no request activities to the newest N activities", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;

      yield* seedActivityCapFixture;
      yield* insertFillerActivities(600);

      const threadDetail = yield* snapshotQuery.getThreadDetailById(ThreadId.make("thread-1"));
      assert.equal(threadDetail._tag, "Some");
      if (threadDetail._tag !== "Some") {
        return;
      }
      const sequences = threadDetail.value.activities.map((activity) => activity.sequence ?? -1);
      assert.equal(sequences.length, THREAD_DETAIL_ACTIVITY_LIMIT);
      assert.equal(sequences[0], 201);
      assert.equal(sequences[sequences.length - 1], 700);
    }),
  );

  it.effect("tolerates a snapshotSequence behind the returned rows, which only replays", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;

      yield* seedActivityCapFixture;
      yield* insertFillerActivities(3); // sequences 101..103
      yield* setProjectionStateSequence(101);

      const snapshot = yield* snapshotQuery.getThreadDetailSnapshot(ThreadId.make("thread-1"));
      assert.equal(snapshot._tag, "Some");
      if (snapshot._tag !== "Some") {
        return;
      }

      // This is the safe skew and the code makes no attempt to avoid it. The
      // client re-applies events 102 and 103, which it already has, and
      // converges. Only the opposite direction loses events.
      assert.equal(snapshot.value.snapshotSequence, 101);
      assert.deepEqual(
        snapshot.value.thread.activities.map((activity) => activity.sequence),
        [101, 102, 103],
      );
    }),
  );

  // A thread-detail read holds the single connection permit for its whole
  // transaction, decode included, so the trace has to price the query and the
  // decode separately. These spans are what makes that readable without
  // subtracting one span's duration from another's.
  it.effect("times the query and the row decode of each heavy thread-detail read", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* seedActivityCapFixture;
      yield* sql`DELETE FROM projection_thread_messages`;
      yield* sql`DELETE FROM projection_turns`;
      yield* insertFillerActivities(3);
      yield* setProjectionStateSequence(103);

      // Distinct row counts per read, so a span that reported another read's
      // count would fail rather than coincide.
      for (const messageId of ["message-1", "message-2"]) {
        yield* sql`
          INSERT INTO projection_thread_messages (
            message_id,
            thread_id,
            turn_id,
            role,
            text,
            correlation_json,
            is_streaming,
            created_at,
            updated_at
          )
          VALUES (
            ${messageId},
            'thread-1',
            NULL,
            'user',
            'hello',
            NULL,
            0,
            '2026-04-01T00:00:20.000Z',
            '2026-04-01T00:00:20.000Z'
          )
        `;
      }
      yield* sql`
        INSERT INTO projection_turns (
          thread_id,
          turn_id,
          pending_message_id,
          source_proposed_plan_thread_id,
          source_proposed_plan_id,
          assistant_message_id,
          state,
          requested_at,
          started_at,
          completed_at,
          checkpoint_turn_count,
          checkpoint_ref,
          checkpoint_status,
          checkpoint_files_json
        )
        VALUES (
          'thread-1',
          'turn-1',
          NULL,
          NULL,
          NULL,
          NULL,
          'completed',
          '2026-04-01T00:00:30.000Z',
          '2026-04-01T00:00:30.000Z',
          '2026-04-01T00:00:31.000Z',
          1,
          'checkpoint-1',
          'ready',
          '[]'
        )
      `;

      const spans: Array<Tracer.Span> = [];
      const collectingTracer = Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options);
          spans.push(span);
          return span;
        },
      });

      const snapshot = yield* snapshotQuery
        .getThreadDetailSnapshot(ThreadId.make("thread-1"))
        .pipe(Effect.withTracer(collectingTracer));
      assert.equal(snapshot._tag, "Some");

      const spanNamed = (name: string) => {
        const matches = spans.filter((span) => span.name === name);
        assert.equal(matches.length, 1, `expected exactly one ${name} span`);
        return matches[0]!;
      };

      const expectedRowCounts = {
        "ProjectionSnapshotQuery.getThreadDetailById:listMessages": 2,
        "ProjectionSnapshotQuery.getThreadDetailById:listActivities": 3,
        "ProjectionSnapshotQuery.getThreadDetailById:listCheckpoints": 1,
        "ProjectionSnapshotQuery.getThreadDetailById:listSubagents": 0,
      };

      const transactionSpan = spanNamed("sql.transaction");
      const parentIdOf = (span: Tracer.Span) => span.parent.pipe(Option.getOrUndefined)?.spanId;

      for (const [operation, rowCount] of Object.entries(expectedRowCounts)) {
        const querySpan = spanNamed(`${operation}:query`);
        const decodeSpan = spanNamed(`${operation}:decodeRows`);

        assert.equal(querySpan.attributes.get("db.rows"), rowCount);
        assert.equal(decodeSpan.attributes.get("db.rows"), rowCount);

        // Siblings, not nested: the decode span's duration is the decode cost
        // on its own, with nothing to subtract out of it.
        assert.notEqual(parentIdOf(decodeSpan), querySpan.spanId);

        // The statement runs inside the transaction and the decode runs after
        // it. The transaction holds the single connection permit for its whole
        // duration, so a decode that drifted back inside would block every
        // writer for its own cost as well as the query's.
        assert.equal(parentIdOf(querySpan), transactionSpan.spanId);
        assert.equal(parentIdOf(decodeSpan), parentIdOf(transactionSpan));
        assert.notEqual(parentIdOf(decodeSpan), transactionSpan.spanId);
      }

      // Nothing but statements is left in the permit-holding window. Named
      // rather than counted, so a read added to the transaction later shows up
      // here as a failure instead of passing unnoticed.
      const transactionChildNames = spans
        .filter((span) => parentIdOf(span) === transactionSpan.spanId)
        .map((span) => span.name)
        .toSorted();
      assert.deepStrictEqual(
        transactionChildNames.filter((name) => name !== "sql.execute"),
        Object.keys(expectedRowCounts)
          .map((operation) => `${operation}:query`)
          .toSorted(),
      );
    }),
  );

  // Same rule for the bulk snapshots. `getCommandReadModel` matters most: every
  // command dispatch waits on it, so a row decode left inside its transaction
  // would hold the single connection permit against every writer for the decode
  // as well as the queries.
  it.effect("decodes bulk snapshot rows outside the transaction that read them", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;

      yield* seedActivityCapFixture;
      yield* setProjectionStateSequence(101);

      yield* assertRowDecodesLeaveTheTransaction("getCommandReadModel", [
        "ProjectionSnapshotQuery.getCommandReadModel:listProjects",
        "ProjectionSnapshotQuery.getCommandReadModel:listThreads",
        "ProjectionSnapshotQuery.getCommandReadModel:listThreadProposedPlans",
        "ProjectionSnapshotQuery.getCommandReadModel:listThreadSessions",
        "ProjectionSnapshotQuery.getCommandReadModel:listLatestTurns",
      ])(snapshotQuery.getCommandReadModel());

      yield* assertRowDecodesLeaveTheTransaction("getShellSnapshot", [
        "ProjectionSnapshotQuery.getShellSnapshot:listProjects",
        "ProjectionSnapshotQuery.getShellSnapshot:listThreads",
        "ProjectionSnapshotQuery.getShellSnapshot:listThreadSessions",
        "ProjectionSnapshotQuery.getShellSnapshot:listLatestTurns",
      ])(snapshotQuery.getShellSnapshot());

      yield* assertRowDecodesLeaveTheTransaction("getArchivedShellSnapshot", [
        "ProjectionSnapshotQuery.getArchivedShellSnapshot:listProjects",
        "ProjectionSnapshotQuery.getArchivedShellSnapshot:listThreads",
        "ProjectionSnapshotQuery.getArchivedShellSnapshot:listThreadSessions",
        "ProjectionSnapshotQuery.getArchivedShellSnapshot:listLatestTurns",
      ])(snapshotQuery.getArchivedShellSnapshot());
    }),
  );

  it.effect("uses projection_threads.latest_turn_id for targeted thread latest turn queries", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_turns`;

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-1',
          'Project 1',
          '/tmp/project-1',
          '{"provider":"codex","model":"gpt-5-codex"}',
          '[]',
          '2026-04-02T00:00:00.000Z',
          '2026-04-02T00:00:01.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          created_at,
          updated_at,
          archived_at,
          deleted_at
        )
        VALUES (
          'thread-1',
          'project-1',
          'Thread 1',
          '{"provider":"codex","model":"gpt-5-codex"}',
          'full-access',
          'default',
          NULL,
          NULL,
          'turn-running',
          '2026-04-02T00:00:04.000Z',
          0,
          0,
          0,
          '2026-04-02T00:00:02.000Z',
          '2026-04-02T00:00:03.000Z',
          NULL,
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_turns (
          thread_id,
          turn_id,
          pending_message_id,
          source_proposed_plan_thread_id,
          source_proposed_plan_id,
          assistant_message_id,
          state,
          requested_at,
          started_at,
          completed_at,
          checkpoint_turn_count,
          checkpoint_ref,
          checkpoint_status,
          checkpoint_files_json
        )
        VALUES
          (
            'thread-1',
            'turn-completed',
            'message-user-1',
            NULL,
            NULL,
            'message-assistant-1',
            'completed',
            '2026-04-02T00:00:05.000Z',
            '2026-04-02T00:00:06.000Z',
            '2026-04-02T00:00:20.000Z',
            5,
            'checkpoint-5',
            'ready',
            '[]'
          ),
          (
            'thread-1',
            'turn-running',
            'message-user-2',
            NULL,
            NULL,
            NULL,
            'running',
            '2026-04-02T00:00:30.000Z',
            '2026-04-02T00:00:30.000Z',
            NULL,
            NULL,
            NULL,
            NULL,
            '[]'
          )
      `;

      const threadShell = yield* snapshotQuery.getThreadShellById(ThreadId.make("thread-1"));
      assert.equal(threadShell._tag, "Some");
      if (threadShell._tag === "Some") {
        assert.equal(threadShell.value.latestTurn?.turnId, asTurnId("turn-running"));
        assert.equal(threadShell.value.latestTurn?.state, "running");
        assert.equal(threadShell.value.latestTurn?.startedAt, "2026-04-02T00:00:30.000Z");
      }

      const threadDetail = yield* snapshotQuery.getThreadDetailById(ThreadId.make("thread-1"));
      assert.equal(threadDetail._tag, "Some");
      if (threadDetail._tag === "Some") {
        assert.equal(threadDetail.value.latestTurn?.turnId, asTurnId("turn-running"));
        assert.equal(threadDetail.value.latestTurn?.state, "running");
        assert.equal(threadDetail.value.latestTurn?.startedAt, "2026-04-02T00:00:30.000Z");
      }
    }),
  );

  it.effect("uses projection_threads.latest_turn_id for bulk command and shell snapshots", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_turns`;
      yield* sql`DELETE FROM projection_state`;

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-1',
          'Project 1',
          '/tmp/project-1',
          '{"provider":"codex","model":"gpt-5-codex"}',
          '[]',
          '2026-04-03T00:00:00.000Z',
          '2026-04-03T00:00:01.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          created_at,
          updated_at,
          archived_at,
          deleted_at
        )
        VALUES (
          'thread-1',
          'project-1',
          'Thread 1',
          '{"provider":"codex","model":"gpt-5-codex"}',
          'full-access',
          'default',
          NULL,
          NULL,
          'turn-running',
          '2026-04-03T00:00:04.000Z',
          0,
          0,
          0,
          '2026-04-03T00:00:02.000Z',
          '2026-04-03T00:00:03.000Z',
          NULL,
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_turns (
          thread_id,
          turn_id,
          pending_message_id,
          source_proposed_plan_thread_id,
          source_proposed_plan_id,
          assistant_message_id,
          state,
          requested_at,
          started_at,
          completed_at,
          checkpoint_turn_count,
          checkpoint_ref,
          checkpoint_status,
          checkpoint_files_json
        )
        VALUES
          (
            'thread-1',
            'turn-running',
            'message-user-2',
            NULL,
            NULL,
            NULL,
            'running',
            '2026-04-03T00:00:30.000Z',
            '2026-04-03T00:00:30.000Z',
            NULL,
            NULL,
            NULL,
            NULL,
            '[]'
          ),
          (
            'thread-1',
            'turn-completed',
            'message-user-1',
            NULL,
            NULL,
            'message-assistant-1',
            'completed',
            '2026-04-03T00:00:05.000Z',
            '2026-04-03T00:00:06.000Z',
            '2026-04-03T00:00:20.000Z',
            NULL,
            NULL,
            NULL,
            '[]'
          )
      `;

      yield* sql`
        INSERT INTO projection_state (projector, last_applied_sequence, updated_at)
        VALUES
          (${ORCHESTRATION_PROJECTOR_NAMES.projects}, 3, '2026-04-03T00:00:40.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threads}, 3, '2026-04-03T00:00:40.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threadMessages}, 3, '2026-04-03T00:00:40.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threadProposedPlans}, 3, '2026-04-03T00:00:40.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threadActivities}, 3, '2026-04-03T00:00:40.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threadSessions}, 3, '2026-04-03T00:00:40.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.checkpoints}, 3, '2026-04-03T00:00:40.000Z')
      `;

      const commandReadModel = yield* snapshotQuery.getCommandReadModel();
      assert.equal(commandReadModel.threads[0]?.latestTurn?.turnId, asTurnId("turn-running"));
      assert.equal(commandReadModel.threads[0]?.latestTurn?.state, "running");

      const shellSnapshot = yield* snapshotQuery.getShellSnapshot();
      assert.equal(shellSnapshot.threads[0]?.latestTurn?.turnId, asTurnId("turn-running"));
      assert.equal(shellSnapshot.threads[0]?.latestTurn?.state, "running");

      const fullSnapshot = yield* snapshotQuery.getSnapshot();
      assert.equal(fullSnapshot.threads[0]?.latestTurn?.turnId, asTurnId("turn-running"));
      assert.equal(fullSnapshot.threads[0]?.latestTurn?.state, "running");
    }),
  );

  it.effect("keeps deleted project and thread tombstones in the command read model", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_turns`;
      yield* sql`DELETE FROM projection_state`;

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-deleted',
          'Deleted Project',
          '/tmp/deleted-project',
          '{"provider":"codex","model":"gpt-5-codex"}',
          '[]',
          '2026-04-05T00:00:00.000Z',
          '2026-04-05T00:00:01.000Z',
          '2026-04-05T00:00:02.000Z'
        )
      `;

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          created_at,
          updated_at,
          archived_at,
          deleted_at
        )
        VALUES (
          'thread-deleted',
          'project-deleted',
          'Deleted Thread',
          '{"provider":"codex","model":"gpt-5-codex"}',
          'full-access',
          'default',
          NULL,
          NULL,
          'turn-deleted',
          NULL,
          0,
          0,
          0,
          '2026-04-05T00:00:03.000Z',
          '2026-04-05T00:00:04.000Z',
          NULL,
          '2026-04-05T00:00:05.000Z'
        )
      `;

      yield* sql`
        INSERT INTO projection_turns (
          thread_id,
          turn_id,
          pending_message_id,
          source_proposed_plan_thread_id,
          source_proposed_plan_id,
          assistant_message_id,
          state,
          requested_at,
          started_at,
          completed_at,
          checkpoint_turn_count,
          checkpoint_ref,
          checkpoint_status,
          checkpoint_files_json
        )
        VALUES (
          'thread-deleted',
          'turn-deleted',
          'message-deleted-user',
          NULL,
          NULL,
          'message-deleted-assistant',
          'completed',
          '2026-04-05T00:00:04.100Z',
          '2026-04-05T00:00:04.200Z',
          '2026-04-05T00:00:04.300Z',
          NULL,
          NULL,
          NULL,
          '[]'
        )
      `;

      const commandReadModel = yield* snapshotQuery.getCommandReadModel();
      assert.equal(commandReadModel.projects[0]?.id, asProjectId("project-deleted"));
      assert.equal(commandReadModel.projects[0]?.deletedAt, "2026-04-05T00:00:02.000Z");
      assert.equal(commandReadModel.threads[0]?.id, ThreadId.make("thread-deleted"));
      assert.equal(commandReadModel.threads[0]?.deletedAt, "2026-04-05T00:00:05.000Z");
      assert.equal(commandReadModel.threads[0]?.latestTurn?.turnId, asTurnId("turn-deleted"));
      assert.equal(commandReadModel.threads[0]?.latestTurn?.state, "completed");

      const fullSnapshot = yield* snapshotQuery.getSnapshot();
      assert.equal(fullSnapshot.threads[0]?.id, ThreadId.make("thread-deleted"));
      assert.equal(fullSnapshot.threads[0]?.latestTurn?.turnId, asTurnId("turn-deleted"));
      assert.equal(fullSnapshot.threads[0]?.latestTurn?.state, "completed");

      const shellSnapshot = yield* snapshotQuery.getShellSnapshot();
      assert.equal(shellSnapshot.projects.length, 0);
      assert.equal(shellSnapshot.threads.length, 0);
    }),
  );
});

it.effect(
  "ProjectionSnapshotQuery dedupes repository identity resolution by workspace root and skips deleted projects for shell snapshots",
  () => {
    const resolveCalls: string[] = [];
    const layer = OrchestrationProjectionSnapshotQueryLive.pipe(
      Layer.provideMerge(
        Layer.succeed(RepositoryIdentityResolver.RepositoryIdentityResolver, {
          resolve: (cwd: string) =>
            Effect.sync(() => {
              resolveCalls.push(cwd);
              return {
                canonicalKey: `github.com/acme${cwd}`,
                locator: {
                  source: "git-remote" as const,
                  remoteName: "origin",
                  remoteUrl: `https://github.com/acme${cwd}.git`,
                },
                rootPath: cwd,
              };
            }),
        }),
      ),
      Layer.provideMerge(SqlitePersistenceMemory),
    );

    return Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_turns`;
      yield* sql`DELETE FROM projection_state`;

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES
          (
            'project-1',
            'Shared Project 1',
            '/tmp/shared-root',
            '{"provider":"codex","model":"gpt-5-codex"}',
            '[]',
            '2026-04-04T00:00:00.000Z',
            '2026-04-04T00:00:01.000Z',
            NULL
          ),
          (
            'project-2',
            'Shared Project 2',
            '/tmp/shared-root',
            '{"provider":"codex","model":"gpt-5-codex"}',
            '[]',
            '2026-04-04T00:00:02.000Z',
            '2026-04-04T00:00:03.000Z',
            NULL
          ),
          (
            'project-3',
            'Deleted Project',
            '/tmp/deleted-root',
            '{"provider":"codex","model":"gpt-5-codex"}',
            '[]',
            '2026-04-04T00:00:04.000Z',
            '2026-04-04T00:00:05.000Z',
            '2026-04-04T00:00:06.000Z'
          )
      `;

      const shellSnapshot = yield* snapshotQuery.getShellSnapshot();
      assert.deepStrictEqual(resolveCalls.toSorted(), ["/tmp/shared-root"]);
      assert.equal(shellSnapshot.projects.length, 2);
      assert.equal(shellSnapshot.projects[0]?.repositoryIdentity?.rootPath, "/tmp/shared-root");
      assert.equal(shellSnapshot.projects[1]?.repositoryIdentity?.rootPath, "/tmp/shared-root");

      resolveCalls.length = 0;

      const fullSnapshot = yield* snapshotQuery.getSnapshot();
      assert.deepStrictEqual(resolveCalls.toSorted(), ["/tmp/deleted-root", "/tmp/shared-root"]);
      assert.equal(fullSnapshot.projects.length, 3);
      assert.equal(fullSnapshot.projects[2]?.repositoryIdentity?.rootPath, "/tmp/deleted-root");
    }).pipe(Effect.provide(layer));
  },
);

/**
 * The projector write to run the instant the next top-level transaction
 * commits, or `null` when the probe is disarmed.
 *
 * @see makeTransactionBoundaryProbeClient
 */
let pendingProjectorWrite: Effect.Effect<void, SqlError, SqlClient.SqlClient> | null = null;

/** Arms the probe with one projector-shaped write at `sequence`. */
const armProjectorWriteAtNextCommit = (sequence: number) =>
  Effect.sync(() => {
    pendingProjectorWrite = appendActivityAndBumpSequence(sequence);
  });

/**
 * A SqlClient that runs the armed projector write the instant a top-level
 * transaction commits.
 *
 * This makes the transaction boundary directly observable from a test. Any read
 * the production code performs after that commit — that is, any read that left
 * the transaction — sees the write; every read still inside the transaction
 * cannot. Racing a real writer fiber cannot do this: the SqlClient's
 * semaphore(1) only wakes waiters on a scheduled task, so a fiber that releases
 * the permit and immediately re-takes it always wins, and the window never
 * opens. See the sibling test for the probe's own liveness check.
 */
const makeTransactionBoundaryProbeClient = Effect.gen(function* () {
  const realSql = yield* SqlClient.SqlClient;

  const runPendingProjectorWrite = Effect.suspend(() => {
    const pending = pendingProjectorWrite;
    pendingProjectorWrite = null;
    return pending ?? Effect.void;
  }).pipe(Effect.provideService(SqlClient.SqlClient, realSql), Effect.orDie);

  return Object.assign(
    (...args: ReadonlyArray<unknown>) =>
      (realSql as unknown as (...called: ReadonlyArray<unknown>) => unknown)(...args),
    realSql,
    {
      withTransaction: <R, E, A>(self: Effect.Effect<A, E, R>) =>
        realSql.withTransaction(self).pipe(Effect.tap(() => runPendingProjectorWrite)),
    },
  ) as unknown as SqlClient.SqlClient;
});

const transactionBoundaryProbeLayer = it.layer(
  OrchestrationProjectionSnapshotQueryLive.pipe(
    Layer.provideMerge(RepositoryIdentityResolver.layer),
    Layer.provideMerge(
      Layer.effect(SqlClient.SqlClient, makeTransactionBoundaryProbeClient).pipe(
        Layer.provide(SqlitePersistenceMemory),
      ),
    ),
    Layer.provideMerge(NodeServices.layer),
  ),
);

transactionBoundaryProbeLayer("ProjectionSnapshotQuery transaction boundary", (it) => {
  it.effect("the interleaving probe is visible to a read that leaves the transaction", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* seedActivityCapFixture;
      yield* insertFillerActivities(3); // sequences 101..103
      yield* setProjectionStateSequence(103);

      // Liveness check for the probe itself. Commit a transaction that reads
      // nothing, so the probe's write lands, then read projection_state with no
      // transaction open. Without this test the invariant test below could pass
      // because the probe is broken rather than because the code is correct.
      yield* armProjectorWriteAtNextCommit(104);
      yield* sql.withTransaction(Effect.void);

      const sequence = yield* snapshotQuery.getSnapshotSequence();
      assert.equal(sequence.snapshotSequence, 104);
    }),
  );

  it.effect("never returns a snapshotSequence ahead of the thread rows it returns", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;

      yield* seedActivityCapFixture;
      yield* insertFillerActivities(3); // sequences 101..103
      yield* setProjectionStateSequence(103);

      // The probe commits activity 104 and bumps projection_state to 104 at the
      // moment getThreadDetailSnapshot's transaction commits.
      yield* armProjectorWriteAtNextCommit(104);
      const snapshot = yield* snapshotQuery.getThreadDetailSnapshot(ThreadId.make("thread-1"));

      // Harness check, not the invariant: the probe disarms itself when it
      // fires, so a null here proves the call really did commit a transaction
      // with the interleaving write behind it. A rewrite that stops using
      // `withTransaction` altogether would leave this armed and fail loudly
      // rather than pass for the wrong reason.
      assert.equal(pendingProjectorWrite, null);

      assert.equal(snapshot._tag, "Some");
      if (snapshot._tag !== "Some") {
        return;
      }
      const sequences = snapshot.value.thread.activities.map((activity) => activity.sequence);
      assert.deepEqual(sequences, [101, 102, 103]);

      // The invariant. The client drops every live event whose sequence is <=
      // snapshotSequence (ws.ts, and the client-runtime shellReducer/threads
      // gates), so a sequence AHEAD of the returned rows is the unsafe skew:
      // activity 104 would be in neither the snapshot nor the stream, and the
      // thread would stay permanently short until a full re-subscribe. Reading
      // projection_state outside the transaction that read the rows returns 104
      // here and breaks this.
      const highestReturned = Math.max(...sequences.map((sequence) => sequence ?? -1));
      assert.isAtMost(snapshot.value.snapshotSequence, highestReturned);
      assert.equal(snapshot.value.snapshotSequence, 103);

      // The probe's write did commit, so a read one step later really does see
      // 104 — the snapshot above was consistent, not merely early.
      const afterSnapshot = yield* snapshotQuery.getSnapshotSequence();
      assert.equal(afterSnapshot.snapshotSequence, 104);
    }),
  );

  // The server rule that replaces the client's idle auto-settle must agree
  // with it row for row, so this walks the same truth table
  // (packages/client-runtime/src/state/threadSettled.test.ts) minus the PR
  // dimension, which this query deliberately does not decide.
  it.effect("returns only the threads the settled partition lets an idle sweep settle", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;

      const truthTable = (["settled", "active", null] as const).flatMap((settledOverride) =>
        [AUTO_SETTLE_FRESH, AUTO_SETTLE_STALE, null].flatMap((activityAt) =>
          (["starting", "running", "ready", null] as const).flatMap((sessionStatus) =>
            (["approval", "user-input", null] as const).map((pending, pendingIndex) => ({
              settledOverride,
              activityAt,
              sessionStatus,
              pending,
              key: `${settledOverride}-${activityAt}-${sessionStatus}-${pendingIndex}`,
              // A candidate iff nothing blocks: no override in either
              // direction, idle past the cutoff, no live-or-waking session,
              // and no request waiting on the user.
              expected:
                settledOverride === null &&
                activityAt === AUTO_SETTLE_STALE &&
                sessionStatus !== "starting" &&
                sessionStatus !== "running" &&
                pending === null,
            })),
          ),
        ),
      );

      const fixtures = truthTable.map((row, index) => ({
        threadId: `thread-auto-settle-${index}`,
        settledOverride: row.settledOverride,
        activityAt: row.activityAt,
        sessionStatus: row.sessionStatus,
        pending: row.pending,
      }));
      // Archived and deleted threads are gone from the sidebar and from the
      // sweep, whatever their activity says.
      const excludedByTombstone = [
        {
          threadId: "thread-auto-settle-archived",
          settledOverride: null,
          activityAt: AUTO_SETTLE_STALE,
          sessionStatus: null,
          pending: null,
          archived: true,
        },
        {
          threadId: "thread-auto-settle-deleted",
          settledOverride: null,
          activityAt: AUTO_SETTLE_STALE,
          sessionStatus: null,
          pending: null,
          deleted: true,
        },
      ] as const satisfies ReadonlyArray<AutoSettleThreadFixture>;

      yield* seedAutoSettleFixtures([...fixtures, ...excludedByTombstone]);

      const candidates = yield* snapshotQuery.listAutoSettleCandidates({
        idleBefore: AUTO_SETTLE_CUTOFF,
        limit: 1_000,

        runningSubagentFreshAfter: AUTO_SETTLE_SUBAGENT_FRESH_AFTER,
      });

      const expectedThreadIds = truthTable
        .map((row, index) => (row.expected ? `thread-auto-settle-${index}` : null))
        .filter((threadId): threadId is string => threadId !== null)
        .toSorted();
      assert.deepEqual(
        candidates.map((candidate) => candidate.threadId).toSorted(),
        expectedThreadIds,
      );
      // A non-empty expectation, so a query that returns nothing at all cannot
      // pass this by matching an empty list.
      assert.isAtLeast(expectedThreadIds.length, 2);
      assert.deepEqual(
        [...new Set(candidates.map((candidate) => candidate.projectId))],
        [ProjectId.make("project-auto-settle")],
      );
    }),
  );

  // A fresh running subagent is in-flight work the settle decider refuses, so
  // neither sweep pass may read the thread as a candidate — while a stranded
  // running row (stale) or a finished one must not block, or a crashed session
  // would make its thread unsettleable forever.
  it.effect("excludes threads with a fresh running subagent from both sweep passes", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;

      yield* seedAutoSettleFixtures([
        {
          threadId: "thread-subagent-fresh-running",
          settledOverride: null,
          activityAt: AUTO_SETTLE_STALE,
          sessionStatus: "ready",
          pending: null,
          subagent: { status: "running", updatedAt: AUTO_SETTLE_SUBAGENT_FRESH },
        },
        {
          threadId: "thread-subagent-stale-running",
          settledOverride: null,
          activityAt: AUTO_SETTLE_STALE,
          sessionStatus: "ready",
          pending: null,
          subagent: { status: "running", updatedAt: AUTO_SETTLE_SUBAGENT_STALE },
        },
        {
          threadId: "thread-subagent-completed",
          settledOverride: null,
          activityAt: AUTO_SETTLE_STALE,
          sessionStatus: "ready",
          pending: null,
          subagent: { status: "completed", updatedAt: AUTO_SETTLE_SUBAGENT_FRESH },
        },
      ]);

      // The idle pass.
      const idleCandidates = yield* snapshotQuery.listAutoSettleCandidates({
        idleBefore: AUTO_SETTLE_CUTOFF,
        limit: 1_000,
        runningSubagentFreshAfter: AUTO_SETTLE_SUBAGENT_FRESH_AFTER,
      });
      assert.deepEqual(idleCandidates.map((candidate) => candidate.threadId).toSorted(), [
        ThreadId.make("thread-subagent-completed"),
        ThreadId.make("thread-subagent-stale-running"),
      ]);

      // The merged-PR pass reads the same partition minus only the age rule.
      const prCandidates = yield* snapshotQuery.listAutoSettleCandidates({
        idleBefore: null,
        limit: 1_000,
        runningSubagentFreshAfter: AUTO_SETTLE_SUBAGENT_FRESH_AFTER,
      });
      assert.deepEqual(prCandidates.map((candidate) => candidate.threadId).toSorted(), [
        ThreadId.make("thread-subagent-completed"),
        ThreadId.make("thread-subagent-stale-running"),
      ]);
    }),
  );

  // The merged-PR sweep settles on what the VCS status cache already holds, so
  // the same read has to hand it a cwd to peek at and the branch it must still
  // be on — and, with no idle window of its own, every candidate whatever its
  // age.
  it.effect("returns the cwd parts a merged-PR sweep needs, and ignores age when asked", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;

      yield* seedAutoSettleFixtures([
        {
          threadId: "thread-pr-worktree",
          settledOverride: null,
          activityAt: AUTO_SETTLE_FRESH,
          sessionStatus: null,
          pending: null,
          branch: "feature/pr-settle",
          worktreePath: "/tmp/worktree-pr-settle",
        },
        {
          threadId: "thread-pr-shared-root",
          settledOverride: null,
          activityAt: AUTO_SETTLE_STALE,
          sessionStatus: null,
          pending: null,
          branch: "feature/shared-root",
        },
        // Blocked for the merged-PR sweep for the same reason it is blocked for
        // the idle one: an explicit keep-active pin is never auto-settled.
        {
          threadId: "thread-pr-pinned-active",
          settledOverride: "active",
          activityAt: AUTO_SETTLE_FRESH,
          sessionStatus: null,
          pending: null,
          branch: "feature/pinned",
          worktreePath: "/tmp/worktree-pinned",
        },
      ]);

      const everyAge = yield* snapshotQuery.listAutoSettleCandidates({
        idleBefore: null,
        limit: 1_000,

        runningSubagentFreshAfter: AUTO_SETTLE_SUBAGENT_FRESH_AFTER,
      });

      assert.deepEqual(
        everyAge.map((candidate) => [
          candidate.threadId,
          candidate.branch,
          candidate.worktreePath,
          candidate.workspaceRoot,
        ]),
        [
          [
            ThreadId.make("thread-pr-shared-root"),
            "feature/shared-root",
            null,
            "/tmp/project-auto-settle",
          ],
          [
            ThreadId.make("thread-pr-worktree"),
            "feature/pr-settle",
            "/tmp/worktree-pr-settle",
            "/tmp/project-auto-settle",
          ],
        ],
      );

      // The idle cutoff still filters when one is given: null drops the age
      // rule and nothing else.
      const idleOnly = yield* snapshotQuery.listAutoSettleCandidates({
        idleBefore: AUTO_SETTLE_CUTOFF,
        limit: 1_000,

        runningSubagentFreshAfter: AUTO_SETTLE_SUBAGENT_FRESH_AFTER,
      });
      assert.deepEqual(
        idleOnly.map((candidate) => candidate.threadId),
        [ThreadId.make("thread-pr-shared-root")],
      );
    }),
  );

  it.effect("dates a candidate by its newest user message or latest-turn timestamp", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;

      yield* seedAutoSettleFixtures([
        // Turn timestamps are stale but the user message is not: the thread is
        // active, exactly as `threadLastActivityAt` maxes the four candidates.
        {
          threadId: "thread-activity-message-fresh",
          settledOverride: null,
          activityAt: AUTO_SETTLE_STALE,
          sessionStatus: null,
          pending: null,
          latestUserMessageAt: AUTO_SETTLE_FRESH,
        },
        // The mirror image: an old message, an idle turn, so it is a candidate
        // dated by the newer of the two.
        {
          threadId: "thread-activity-both-stale",
          settledOverride: null,
          activityAt: "2026-04-05T00:00:00.000Z",
          sessionStatus: null,
          pending: null,
          latestUserMessageAt: AUTO_SETTLE_STALE,
        },
        // No turn, only a message.
        {
          threadId: "thread-activity-message-only",
          settledOverride: null,
          activityAt: null,
          sessionStatus: null,
          pending: null,
          latestUserMessageAt: "2026-04-04T00:00:00.000Z",
        },
        // No activity at all is never a candidate — the client rule returns
        // false for a null last activity rather than treating epoch zero as
        // infinitely idle.
        {
          threadId: "thread-activity-none",
          settledOverride: null,
          activityAt: null,
          sessionStatus: null,
          pending: null,
        },
      ]);

      const candidates = yield* snapshotQuery.listAutoSettleCandidates({
        idleBefore: AUTO_SETTLE_CUTOFF,
        limit: 1_000,

        runningSubagentFreshAfter: AUTO_SETTLE_SUBAGENT_FRESH_AFTER,
      });

      // Oldest first, so a limited sweep settles the most neglected threads.
      assert.deepEqual(
        candidates.map((candidate) => [candidate.threadId, candidate.lastActivityAt]),
        [
          [ThreadId.make("thread-activity-message-only"), "2026-04-04T00:00:00.000Z"],
          [ThreadId.make("thread-activity-both-stale"), AUTO_SETTLE_STALE],
        ],
      );

      const limited = yield* snapshotQuery.listAutoSettleCandidates({
        idleBefore: AUTO_SETTLE_CUTOFF,
        limit: 1,

        runningSubagentFreshAfter: AUTO_SETTLE_SUBAGENT_FRESH_AFTER,
      });
      assert.deepEqual(
        limited.map((candidate) => candidate.threadId),
        [ThreadId.make("thread-activity-message-only")],
      );
    }),
  );
});
