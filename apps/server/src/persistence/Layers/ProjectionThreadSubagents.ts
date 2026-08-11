import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { ThreadId, TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";

import { toPersistenceDecodeError, toPersistenceSqlError } from "../Errors.ts";

import {
  CloseRunningProjectionThreadSubagentsInput,
  CountRunningProjectionThreadSubagentsInput,
  DeleteProjectionThreadSubagentsInput,
  ListProjectionThreadSubagentsInput,
  ProjectionThreadSubagent,
  ProjectionThreadSubagentRepository,
  type ProjectionThreadSubagentRepositoryShape,
} from "../Services/ProjectionThreadSubagents.ts";

const ProjectionThreadSubagentDbRowSchema = ProjectionThreadSubagent.mapFields(
  Struct.assign({
    agentType: Schema.NullOr(TrimmedNonEmptyString),
    description: Schema.NullOr(TrimmedNonEmptyString),
    lastProgressSummary: Schema.NullOr(TrimmedNonEmptyString),
    lastToolName: Schema.NullOr(TrimmedNonEmptyString),
    usage: Schema.NullOr(Schema.fromJsonString(Schema.Unknown)),
    spawnedByItemId: Schema.NullOr(TrimmedNonEmptyString),
    childThreadId: Schema.NullOr(ThreadId),
  }),
);

const RunningSubagentCountRowSchema = Schema.Struct({
  runningCount: Schema.Number,
});

function toPersistenceSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown) =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

const makeProjectionThreadSubagentRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionThreadSubagentRow = SqlSchema.void({
    Request: ProjectionThreadSubagent,
    execute: (row) =>
      sql`
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
              child_thread_id,
              started_at,
              updated_at,
              completed_at
            )
            VALUES (
              ${row.subagentId},
              ${row.threadId},
              ${row.turnId},
              ${row.agentType ?? null},
              ${row.description ?? null},
              ${row.status},
              ${row.lastProgressSummary ?? null},
              ${row.lastToolName ?? null},
              ${row.usage !== undefined ? JSON.stringify(row.usage) : null},
              ${row.spawnedByItemId ?? null},
              ${row.childThreadId ?? null},
              ${row.startedAt},
              ${row.updatedAt},
              ${row.completedAt}
            )
            ON CONFLICT (thread_id, subagent_id)
            DO UPDATE SET
              turn_id = excluded.turn_id,
              agent_type = excluded.agent_type,
              description = excluded.description,
              status = excluded.status,
              last_progress_summary = excluded.last_progress_summary,
              last_tool_name = excluded.last_tool_name,
              usage_json = excluded.usage_json,
              spawned_by_item_id = excluded.spawned_by_item_id,
              child_thread_id = excluded.child_thread_id,
              started_at = excluded.started_at,
              updated_at = excluded.updated_at,
              completed_at = excluded.completed_at
          `,
  });

  const listProjectionThreadSubagentRows = SqlSchema.findAll({
    Request: ListProjectionThreadSubagentsInput,
    Result: ProjectionThreadSubagentDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          subagent_id AS "subagentId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          agent_type AS "agentType",
          description,
          status,
          last_progress_summary AS "lastProgressSummary",
          last_tool_name AS "lastToolName",
          usage_json AS "usage",
          spawned_by_item_id AS "spawnedByItemId",
          child_thread_id AS "childThreadId",
          started_at AS "startedAt",
          updated_at AS "updatedAt",
          completed_at AS "completedAt"
        FROM projection_thread_subagents
        WHERE thread_id = ${threadId}
        ORDER BY
          started_at ASC,
          subagent_id ASC
      `,
  });

  const countRunningProjectionThreadSubagentRows = SqlSchema.findOne({
    Request: CountRunningProjectionThreadSubagentsInput,
    Result: RunningSubagentCountRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT COUNT(*) AS "runningCount"
        FROM projection_thread_subagents
        WHERE thread_id = ${threadId}
          AND status = 'running'
      `,
  });

  const deleteProjectionThreadSubagentRows = SqlSchema.void({
    Request: DeleteProjectionThreadSubagentsInput,
    execute: ({ threadId }) =>
      sql`
        DELETE FROM projection_thread_subagents
        WHERE thread_id = ${threadId}
      `,
  });

  const closeRunningProjectionThreadSubagentRows = SqlSchema.void({
    Request: CloseRunningProjectionThreadSubagentsInput,
    execute: ({ threadId, status, completedAt }) =>
      sql`
        UPDATE projection_thread_subagents
        SET
          status = ${status},
          updated_at = ${completedAt},
          completed_at = ${completedAt}
        WHERE thread_id = ${threadId}
          AND status = 'running'
      `,
  });

  const upsert: ProjectionThreadSubagentRepositoryShape["upsert"] = (row) =>
    upsertProjectionThreadSubagentRow(row).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionThreadSubagentRepository.upsert:query",
          "ProjectionThreadSubagentRepository.upsert:encodeRequest",
        ),
      ),
    );

  const listByThreadId: ProjectionThreadSubagentRepositoryShape["listByThreadId"] = (input) =>
    listProjectionThreadSubagentRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionThreadSubagentRepository.listByThreadId:query",
          "ProjectionThreadSubagentRepository.listByThreadId:decodeRows",
        ),
      ),
      Effect.map((rows) =>
        rows.map((row) => ({
          subagentId: row.subagentId,
          threadId: row.threadId,
          turnId: row.turnId,
          ...(row.agentType !== null ? { agentType: row.agentType } : {}),
          ...(row.description !== null ? { description: row.description } : {}),
          status: row.status,
          ...(row.lastProgressSummary !== null
            ? { lastProgressSummary: row.lastProgressSummary }
            : {}),
          ...(row.lastToolName !== null ? { lastToolName: row.lastToolName } : {}),
          ...(row.usage !== null ? { usage: row.usage } : {}),
          ...(row.spawnedByItemId !== null ? { spawnedByItemId: row.spawnedByItemId } : {}),
          ...(row.childThreadId !== null ? { childThreadId: row.childThreadId } : {}),
          startedAt: row.startedAt,
          updatedAt: row.updatedAt,
          completedAt: row.completedAt,
        })),
      ),
    );

  const countRunningByThreadId: ProjectionThreadSubagentRepositoryShape["countRunningByThreadId"] =
    (input) =>
      countRunningProjectionThreadSubagentRows(input).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionThreadSubagentRepository.countRunningByThreadId:query",
            "ProjectionThreadSubagentRepository.countRunningByThreadId:decodeRow",
          ),
        ),
        Effect.map((row) => row.runningCount),
      );

  const deleteByThreadId: ProjectionThreadSubagentRepositoryShape["deleteByThreadId"] = (input) =>
    deleteProjectionThreadSubagentRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadSubagentRepository.deleteByThreadId:query"),
      ),
    );

  const closeRunningByThreadId: ProjectionThreadSubagentRepositoryShape["closeRunningByThreadId"] =
    (input) =>
      closeRunningProjectionThreadSubagentRows(input).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionThreadSubagentRepository.closeRunningByThreadId:query",
            "ProjectionThreadSubagentRepository.closeRunningByThreadId:encodeRequest",
          ),
        ),
      );

  return {
    upsert,
    listByThreadId,
    countRunningByThreadId,
    deleteByThreadId,
    closeRunningByThreadId,
  } satisfies ProjectionThreadSubagentRepositoryShape;
});

export const ProjectionThreadSubagentRepositoryLive = Layer.effect(
  ProjectionThreadSubagentRepository,
  makeProjectionThreadSubagentRepository,
);
