import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { ModelSelection } from "@t3tools/contracts";
import {
  PersistenceDecodeError,
  PersistenceSqlError,
  type EpicRunStoreError,
  type PersistenceErrorCorrelation,
} from "../Errors.ts";
import {
  EpicRun,
  EpicRunIteration,
  EpicRunStatus,
  EpicRunStore,
  GetEpicRunInput,
  GetLatestEpicRunIterationInput,
  ListEpicRunIterationsInput,
  UpdateEpicRunIterationInput,
  type EpicRunStoreShape,
} from "../Services/EpicRuns.ts";

const EpicRunDbRow = EpicRun.mapFields(
  Struct.assign({ modelSelection: Schema.fromJsonString(ModelSelection) }),
);
type EpicRunDbRow = typeof EpicRunDbRow.Type;

const ListEpicRunsByStatusRequest = Schema.Struct({
  status: EpicRunStatus,
});

/**
 * Discriminate a schema failure from a SQL failure so both members of
 * `EpicRunStoreError` stay reachable: `SqlSchema` surfaces request-encode and
 * row-decode problems as `Schema.SchemaError`, everything else is the driver.
 */
function toEpicRunStoreError(
  sqlOperation: string,
  decodeOperation: string,
  correlation?: PersistenceErrorCorrelation,
) {
  return (cause: unknown): EpicRunStoreError =>
    Schema.isSchemaError(cause)
      ? PersistenceDecodeError.fromSchemaError(decodeOperation, cause, correlation)
      : new PersistenceSqlError({
          operation: sqlOperation,
          ...(correlation === undefined ? {} : { correlation }),
          cause,
        });
}

const makeEpicRunStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertEpicRunRow = SqlSchema.void({
    Request: EpicRun,
    execute: (row) =>
      sql`
        INSERT INTO epic_runs (
          run_id,
          epic_id,
          project_id,
          cwd,
          prompt,
          model_selection_json,
          runtime_mode,
          status,
          max_iterations,
          iterations_completed,
          current_thread_id,
          current_turn_started_at,
          consecutive_failures,
          last_error,
          created_at,
          updated_at
        )
        VALUES (
          ${row.runId},
          ${row.epicId},
          ${row.projectId},
          ${row.cwd},
          ${row.prompt},
          ${JSON.stringify(row.modelSelection)},
          ${row.runtimeMode},
          ${row.status},
          ${row.maxIterations},
          ${row.iterationsCompleted},
          ${row.currentThreadId},
          ${row.currentTurnStartedAt},
          ${row.consecutiveFailures},
          ${row.lastError},
          ${row.createdAt},
          ${row.updatedAt}
        )
        ON CONFLICT (run_id)
        DO UPDATE SET
          epic_id = excluded.epic_id,
          project_id = excluded.project_id,
          cwd = excluded.cwd,
          prompt = excluded.prompt,
          model_selection_json = excluded.model_selection_json,
          runtime_mode = excluded.runtime_mode,
          status = excluded.status,
          max_iterations = excluded.max_iterations,
          iterations_completed = excluded.iterations_completed,
          current_thread_id = excluded.current_thread_id,
          current_turn_started_at = excluded.current_turn_started_at,
          consecutive_failures = excluded.consecutive_failures,
          last_error = excluded.last_error,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at
      `,
  });

  const getEpicRunRow = SqlSchema.findOneOption({
    Request: GetEpicRunInput,
    Result: EpicRunDbRow,
    execute: ({ runId }) =>
      sql`
        SELECT
          run_id AS "runId",
          epic_id AS "epicId",
          project_id AS "projectId",
          cwd,
          prompt,
          model_selection_json AS "modelSelection",
          runtime_mode AS "runtimeMode",
          status,
          max_iterations AS "maxIterations",
          iterations_completed AS "iterationsCompleted",
          current_thread_id AS "currentThreadId",
          current_turn_started_at AS "currentTurnStartedAt",
          consecutive_failures AS "consecutiveFailures",
          last_error AS "lastError",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM epic_runs
        WHERE run_id = ${runId}
      `,
  });

  const listEpicRunRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: EpicRunDbRow,
    execute: () =>
      sql`
        SELECT
          run_id AS "runId",
          epic_id AS "epicId",
          project_id AS "projectId",
          cwd,
          prompt,
          model_selection_json AS "modelSelection",
          runtime_mode AS "runtimeMode",
          status,
          max_iterations AS "maxIterations",
          iterations_completed AS "iterationsCompleted",
          current_thread_id AS "currentThreadId",
          current_turn_started_at AS "currentTurnStartedAt",
          consecutive_failures AS "consecutiveFailures",
          last_error AS "lastError",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM epic_runs
        ORDER BY created_at ASC, run_id ASC
      `,
  });

  const listEpicRunRowsByStatus = SqlSchema.findAll({
    Request: ListEpicRunsByStatusRequest,
    Result: EpicRunDbRow,
    execute: ({ status }) =>
      sql`
        SELECT
          run_id AS "runId",
          epic_id AS "epicId",
          project_id AS "projectId",
          cwd,
          prompt,
          model_selection_json AS "modelSelection",
          runtime_mode AS "runtimeMode",
          status,
          max_iterations AS "maxIterations",
          iterations_completed AS "iterationsCompleted",
          current_thread_id AS "currentThreadId",
          current_turn_started_at AS "currentTurnStartedAt",
          consecutive_failures AS "consecutiveFailures",
          last_error AS "lastError",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM epic_runs
        WHERE status = ${status}
        ORDER BY created_at ASC, run_id ASC
      `,
  });

  const insertEpicRunIterationRow = SqlSchema.void({
    Request: EpicRunIteration,
    execute: (row) =>
      sql`
        INSERT INTO epic_run_iterations (
          run_id,
          iteration_index,
          thread_id,
          issue_id,
          turn_status,
          summary,
          why,
          started_at,
          finished_at
        )
        VALUES (
          ${row.runId},
          ${row.iterationIndex},
          ${row.threadId},
          ${row.issueId},
          ${row.turnStatus},
          ${row.summary},
          ${row.why},
          ${row.startedAt},
          ${row.finishedAt}
        )
      `,
  });

  const updateEpicRunIterationRow = SqlSchema.void({
    Request: UpdateEpicRunIterationInput,
    execute: (input) =>
      sql`
        UPDATE epic_run_iterations
        SET
          turn_status = ${input.turnStatus},
          summary = ${input.summary},
          why = ${input.why},
          finished_at = ${input.finishedAt}
        WHERE run_id = ${input.runId}
          AND iteration_index = ${input.iterationIndex}
      `,
  });

  const listEpicRunIterationRows = SqlSchema.findAll({
    Request: ListEpicRunIterationsInput,
    Result: EpicRunIteration,
    execute: ({ runId }) =>
      sql`
        SELECT
          run_id AS "runId",
          iteration_index AS "iterationIndex",
          thread_id AS "threadId",
          issue_id AS "issueId",
          turn_status AS "turnStatus",
          summary,
          why,
          started_at AS "startedAt",
          finished_at AS "finishedAt"
        FROM epic_run_iterations
        WHERE run_id = ${runId}
        ORDER BY iteration_index ASC
      `,
  });

  const getLatestEpicRunIterationRow = SqlSchema.findOneOption({
    Request: GetLatestEpicRunIterationInput,
    Result: EpicRunIteration,
    execute: ({ runId }) =>
      sql`
        SELECT
          run_id AS "runId",
          iteration_index AS "iterationIndex",
          thread_id AS "threadId",
          issue_id AS "issueId",
          turn_status AS "turnStatus",
          summary,
          why,
          started_at AS "startedAt",
          finished_at AS "finishedAt"
        FROM epic_run_iterations
        WHERE run_id = ${runId}
        ORDER BY iteration_index DESC
        LIMIT 1
      `,
  });

  const upsertRun: EpicRunStoreShape["upsertRun"] = (run) =>
    upsertEpicRunRow(run).pipe(
      Effect.mapError(
        toEpicRunStoreError(
          "EpicRunStore.upsertRun:query",
          "EpicRunStore.upsertRun:encodeRequest",
          { runId: run.runId },
        ),
      ),
    );

  const getRun: EpicRunStoreShape["getRun"] = (input) =>
    getEpicRunRow(input).pipe(
      Effect.mapError(
        toEpicRunStoreError("EpicRunStore.getRun:query", "EpicRunStore.getRun:decodeRow", {
          runId: input.runId,
        }),
      ),
    );

  // A row that fails to decode must fail the whole listing rather than be
  // dropped: a silently skipped `running` row is a run that never resumes and
  // never reports why.
  const listRuns: EpicRunStoreShape["listRuns"] = (input) =>
    (input.status === undefined
      ? listEpicRunRows(undefined)
      : listEpicRunRowsByStatus({ status: input.status })
    ).pipe(
      Effect.mapError(
        toEpicRunStoreError("EpicRunStore.listRuns:query", "EpicRunStore.listRuns:decodeRows"),
      ),
    );

  const appendIteration: EpicRunStoreShape["appendIteration"] = (iteration) =>
    insertEpicRunIterationRow(iteration).pipe(
      Effect.mapError(
        toEpicRunStoreError(
          "EpicRunStore.appendIteration:query",
          "EpicRunStore.appendIteration:encodeRequest",
          { runId: iteration.runId },
        ),
      ),
    );

  const updateIteration: EpicRunStoreShape["updateIteration"] = (input) =>
    updateEpicRunIterationRow(input).pipe(
      Effect.mapError(
        toEpicRunStoreError(
          "EpicRunStore.updateIteration:query",
          "EpicRunStore.updateIteration:encodeRequest",
          { runId: input.runId },
        ),
      ),
    );

  const listIterations: EpicRunStoreShape["listIterations"] = (input) =>
    listEpicRunIterationRows(input).pipe(
      Effect.mapError(
        toEpicRunStoreError(
          "EpicRunStore.listIterations:query",
          "EpicRunStore.listIterations:decodeRows",
          { runId: input.runId },
        ),
      ),
    );

  const getLatestIteration: EpicRunStoreShape["getLatestIteration"] = (input) =>
    getLatestEpicRunIterationRow(input).pipe(
      Effect.mapError(
        toEpicRunStoreError(
          "EpicRunStore.getLatestIteration:query",
          "EpicRunStore.getLatestIteration:decodeRow",
          { runId: input.runId },
        ),
      ),
    );

  return {
    upsertRun,
    getRun,
    listRuns,
    appendIteration,
    updateIteration,
    listIterations,
    getLatestIteration,
  } satisfies EpicRunStoreShape;
});

export const EpicRunStoreLive = Layer.effect(EpicRunStore, makeEpicRunStore);
