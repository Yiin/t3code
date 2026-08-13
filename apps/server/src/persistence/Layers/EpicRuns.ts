import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import {
  DEFAULT_EPIC_RUN_CONFIG_PROVENANCE,
  EpicRunConfig as EpicRunConfigSchema,
  EpicRunConfigProvenance as EpicRunConfigProvenanceSchema,
  EpicRunId,
  ModelSelection,
  NonNegativeInt,
} from "@t3tools/contracts";
import {
  PersistenceDecodeError,
  PersistenceSqlError,
  type EpicRunStoreError,
  type PersistenceErrorCorrelation,
} from "../Errors.ts";
import {
  AdvanceEpicRunMergeIntegrationInput,
  AllocateEpicRunIterationInput,
  EpicRun,
  EpicRunIteration,
  EpicProviderDegradation,
  ClearExpiredEpicProviderDegradationInput,
  CompleteEpicRunMergeInput,
  DropEpicRunMergeInput,
  EnqueueEpicRunMergeInput,
  EpicRunGateReceipt,
  EpicRunStore,
  EpicRunLandingEffects,
  EpicRunMergeEntry,
  FinalizeParkedEpicRunMergeInput,
  FindParkedEpicRunMergeInput,
  GetEpicProviderDegradationInput,
  GetEpicRunInput,
  GetLatestEpicRunIterationInput,
  InitializeEpicRunMergeStateInput,
  EpicRunMergeStateSibling,
  ListEpicRunGateReceiptsInput,
  ListEpicRunIterationsInput,
  ListEpicRunsInput,
  ListRecentEpicRunIterationsInput,
  ParkEpicRunMergeInput,
  RecordEpicRunGateReceiptInput,
  ReopenEpicRunIterationInput,
  RestoreEpicRunMergeTailInput,
  UpdateEpicRunIterationInput,
  UpsertEpicRunLandingEffectsInput,
  type EpicRunStoreShape,
} from "../Services/EpicRuns.ts";

const EpicRunDbRow = EpicRun.mapFields(
  Struct.assign({
    modelSelection: Schema.fromJsonString(ModelSelection),
    config: Schema.fromJsonString(EpicRunConfigSchema),
    configProvenance: Schema.fromJsonString(EpicRunConfigProvenanceSchema),
  }),
);
type EpicRunDbRow = typeof EpicRunDbRow.Type;

const DEFAULT_CONFIG_PROVENANCE_JSON = JSON.stringify(DEFAULT_EPIC_RUN_CONFIG_PROVENANCE);

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

const isIterationAllocationConflict = (cause: unknown): boolean => {
  let current = cause;
  for (let depth = 0; depth < 6; depth += 1) {
    if (typeof current !== "object" || current === null) return false;
    const value = current as {
      readonly message?: unknown;
      cause?: unknown;
    };
    if (
      typeof value.message === "string" &&
      value.message.includes(
        "UNIQUE constraint failed: epic_run_iterations.run_id, epic_run_iterations.iteration_index",
      )
    ) {
      return true;
    }
    current = value.cause;
  }
  return false;
};

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
          orientation_file,
          model_selection_json,
          runtime_mode,
          config_json,
          config_provenance_json,
          origin_thread_id,
          status,
          max_iterations,
          workers,
          iterations_completed,
          iterations_dispatched,
          current_thread_id,
          current_turn_started_at,
          consecutive_failures,
          no_commit_streak,
          infra_streak,
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
          ${row.orientationFile},
          ${JSON.stringify(row.modelSelection)},
          ${row.runtimeMode},
          ${JSON.stringify(row.config)},
          ${JSON.stringify(row.configProvenance)},
          ${row.originThreadId},
          ${row.status},
          ${row.maxIterations},
          ${row.workers},
          ${row.iterationsCompleted},
          ${row.iterationsDispatched},
          ${row.currentThreadId},
          ${row.currentTurnStartedAt},
          ${row.consecutiveFailures},
          ${row.noCommitStreak},
          ${row.infraStreak},
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
          orientation_file = excluded.orientation_file,
          model_selection_json = excluded.model_selection_json,
          runtime_mode = excluded.runtime_mode,
          config_json = excluded.config_json,
          config_provenance_json = excluded.config_provenance_json,
          origin_thread_id = excluded.origin_thread_id,
          status = excluded.status,
          max_iterations = excluded.max_iterations,
          workers = excluded.workers,
          iterations_completed = excluded.iterations_completed,
          iterations_dispatched = excluded.iterations_dispatched,
          current_thread_id = excluded.current_thread_id,
          current_turn_started_at = excluded.current_turn_started_at,
          consecutive_failures = excluded.consecutive_failures,
          no_commit_streak = excluded.no_commit_streak,
          infra_streak = excluded.infra_streak,
          last_error = excluded.last_error,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at
      `,
  });

  const epicRunColumns = sql.literal(`
    run_id AS "runId",
    epic_id AS "epicId",
    project_id AS "projectId",
    cwd,
    prompt,
    orientation_file AS "orientationFile",
    model_selection_json AS "modelSelection",
    runtime_mode AS "runtimeMode",
    COALESCE(config_json, '{}') AS "config",
    COALESCE(config_provenance_json, '${DEFAULT_CONFIG_PROVENANCE_JSON}') AS "configProvenance",
    origin_thread_id AS "originThreadId",
    status,
    max_iterations AS "maxIterations",
    workers,
    iterations_completed AS "iterationsCompleted",
    iterations_dispatched AS "iterationsDispatched",
    current_thread_id AS "currentThreadId",
    current_turn_started_at AS "currentTurnStartedAt",
    consecutive_failures AS "consecutiveFailures",
    no_commit_streak AS "noCommitStreak",
    infra_streak AS "infraStreak",
    last_error AS "lastError",
    created_at AS "createdAt",
    updated_at AS "updatedAt"
  `);

  const getEpicRunRow = SqlSchema.findOneOption({
    Request: GetEpicRunInput,
    Result: EpicRunDbRow,
    execute: ({ runId }) =>
      sql`
        SELECT ${epicRunColumns}
        FROM epic_runs
        WHERE run_id = ${runId}
      `,
  });

  // Ordering and the limit are structure, not values, so they are literal
  // fragments chosen from a closed set rather than bound parameters. `status`
  // and `limit` stay bound.
  const epicRunOrderClause = (orderBy: ListEpicRunsInput["orderBy"]) =>
    orderBy === "updatedAt-desc"
      ? sql.literal(`ORDER BY updated_at DESC, run_id DESC`)
      : sql.literal(`ORDER BY created_at ASC, run_id ASC`);

  const listEpicRunRows = SqlSchema.findAll({
    Request: ListEpicRunsInput,
    Result: EpicRunDbRow,
    execute: ({ status, limit, orderBy }) =>
      sql`
        SELECT ${epicRunColumns}
        FROM epic_runs
        ${status === undefined ? sql.literal("") : sql`WHERE status = ${status}`}
        ${epicRunOrderClause(orderBy)}
        ${limit === undefined ? sql.literal("") : sql`LIMIT ${limit}`}
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
          worker_id,
          branch,
          worktree_path,
          turn_status,
          summary,
          why,
          failure_reason,
          resume_count,
          last_resumed_at,
          tier_id,
          provider_instance_id,
          model,
          phase_timings,
          prompt_bytes,
          started_at,
          finished_at
        )
        VALUES (
          ${row.runId},
          ${row.iterationIndex},
          ${row.threadId},
          ${row.issueId},
          ${row.workerId ?? null},
          ${row.branch ?? null},
          ${row.worktreePath ?? null},
          ${row.turnStatus},
          ${row.summary},
          ${row.why},
          ${row.failureReason},
          ${row.resumeCount ?? 0},
          ${row.lastResumedAt ?? null},
          ${row.tierId ?? null},
          ${row.providerInstanceId ?? null},
          ${row.model ?? null},
          ${row.phaseTimings ?? null},
          ${row.promptBytes ?? null},
          ${row.startedAt},
          ${row.finishedAt}
        )
      `,
  });

  const AllocatedIteration = Schema.Struct({ iterationIndex: NonNegativeInt });
  const allocateEpicRunIterationRow = SqlSchema.findOne({
    Request: AllocateEpicRunIterationInput,
    Result: AllocatedIteration,
    execute: (row) =>
      sql`
        INSERT INTO epic_run_iterations (
          run_id, iteration_index, thread_id, issue_id, worker_id, branch,
          worktree_path, turn_status, summary, why, failure_reason,
          resume_count, last_resumed_at, tier_id, provider_instance_id, model,
          started_at, finished_at
        )
        SELECT
          ${row.runId},
          COALESCE(MAX(iteration_index) + 1, 0),
          'epic-run-' || ${row.runId} || '-' || COALESCE(MAX(iteration_index) + 1, 0),
          ${row.issueId},
          'epic-run-' || ${row.runId} || '-' || COALESCE(MAX(iteration_index) + 1, 0),
          ${row.branch},
          ${row.worktreePath},
          'running',
          NULL,
          NULL,
          NULL,
          0,
          NULL,
          ${row.tierId},
          ${row.providerInstanceId},
          ${row.model},
          ${row.startedAt},
          NULL
        FROM epic_run_iterations
        WHERE run_id = ${row.runId}
        RETURNING iteration_index AS "iterationIndex"
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
          failure_reason = ${input.failureReason},
          phase_timings = COALESCE(${input.phaseTimings}, phase_timings),
          prompt_bytes = COALESCE(${input.promptBytes}, prompt_bytes),
          finished_at = ${input.finishedAt}
        WHERE run_id = ${input.runId}
          AND iteration_index = ${input.iterationIndex}
      `,
  });

  /**
   * The reopen half of the write-ahead discipline: one UPDATE puts the row
   * back to `running`, clears the terminal fields a previous settle wrote, and
   * counts the resume. `started_at` stays put — the iteration really did start
   * then.
   */
  const reopenEpicRunIterationRow = SqlSchema.void({
    Request: ReopenEpicRunIterationInput,
    execute: (input) =>
      sql`
        UPDATE epic_run_iterations
        SET
          turn_status = 'running',
          summary = NULL,
          why = NULL,
          failure_reason = NULL,
          finished_at = NULL,
          resume_count = resume_count + 1,
          last_resumed_at = ${input.resumedAt}
        WHERE run_id = ${input.runId}
          AND iteration_index = ${input.iterationIndex}
      `,
  });

  const iterationColumns = sql.literal(`
    run_id AS "runId",
    iteration_index AS "iterationIndex",
    thread_id AS "threadId",
    issue_id AS "issueId",
    worker_id AS "workerId",
    branch,
    worktree_path AS "worktreePath",
    turn_status AS "turnStatus",
    summary,
    why,
    failure_reason AS "failureReason",
    resume_count AS "resumeCount",
    last_resumed_at AS "lastResumedAt",
    tier_id AS "tierId",
    provider_instance_id AS "providerInstanceId",
    model,
    phase_timings AS "phaseTimings",
    prompt_bytes AS "promptBytes",
    started_at AS "startedAt",
    finished_at AS "finishedAt"
  `);

  const listEpicRunIterationRows = SqlSchema.findAll({
    Request: ListEpicRunIterationsInput,
    Result: EpicRunIteration,
    execute: ({ runId }) =>
      sql`
        SELECT ${iterationColumns}
        FROM epic_run_iterations
        WHERE run_id = ${runId}
        ORDER BY iteration_index ASC
      `,
  });

  const listRunningEpicRunIterationRows = SqlSchema.findAll({
    Request: ListEpicRunIterationsInput,
    Result: EpicRunIteration,
    execute: ({ runId }) =>
      sql`
        SELECT ${iterationColumns}
        FROM epic_run_iterations
        WHERE run_id = ${runId} AND turn_status = 'running'
        ORDER BY iteration_index ASC
      `,
  });

  /**
   * One query for many runs, capped per run by a window function so a run with
   * a thousand iterations cannot dominate the result set.
   *
   * `run_id IN (...)` binds one parameter per id, so the caller must keep the
   * batch under SQLite's variable limit — `listRuns` bounds it via `limit`.
   */
  const listRecentEpicRunIterationRows = SqlSchema.findAll({
    Request: ListRecentEpicRunIterationsInput,
    Result: EpicRunIteration,
    execute: ({ runIds, limitPerRun }) =>
      sql`
        SELECT ${iterationColumns}
        FROM (
          SELECT
            *,
            ROW_NUMBER() OVER (
              PARTITION BY run_id
              ORDER BY iteration_index DESC
            ) AS recency_rank
          FROM epic_run_iterations
          WHERE ${sql.in("run_id", runIds)}
        )
        WHERE recency_rank <= ${limitPerRun}
        ORDER BY run_id ASC, iteration_index ASC
      `,
  });

  const getLatestEpicRunIterationRow = SqlSchema.findOneOption({
    Request: GetLatestEpicRunIterationInput,
    Result: EpicRunIteration,
    execute: ({ runId }) =>
      sql`
        SELECT ${iterationColumns}
        FROM epic_run_iterations
        WHERE run_id = ${runId}
        ORDER BY iteration_index DESC
        LIMIT 1
      `,
  });

  const gateReceiptColumns = sql.literal(`
    run_id AS "runId",
    sequence,
    phase,
    child_id AS "childId",
    branch,
    command_digest AS "commandDigest",
    cwd,
    outcome,
    exit_code AS "exitCode",
    queued_at AS "queuedAt",
    acquired_at AS "acquiredAt",
    finished_at AS "finishedAt",
    lock_wait_ms AS "lockWaitMs",
    execution_ms AS "executionMs",
    input_heads AS "inputHeads",
    output,
    output_path AS "outputPath"
  `);

  /**
   * Append-only, with the sequence allocated in the same statement so two
   * concurrent gates cannot claim one slot. Nothing ever updates a receipt.
   */
  const recordEpicRunGateReceiptRow = SqlSchema.void({
    Request: RecordEpicRunGateReceiptInput,
    execute: (row) => sql`
      INSERT INTO epic_run_gate_receipts (
        run_id, sequence, phase, child_id, branch, command_digest, cwd,
        outcome, exit_code, queued_at, acquired_at, finished_at,
        lock_wait_ms, execution_ms, input_heads, output, output_path
      )
      SELECT
        ${row.runId},
        COALESCE(MAX(sequence) + 1, 0),
        ${row.phase},
        ${row.childId},
        ${row.branch},
        ${row.commandDigest},
        ${row.cwd},
        ${row.outcome},
        ${row.exitCode},
        ${row.queuedAt},
        ${row.acquiredAt},
        ${row.finishedAt},
        ${row.lockWaitMs},
        ${row.executionMs},
        ${row.inputHeads},
        ${row.output},
        ${row.outputPath}
      FROM epic_run_gate_receipts
      WHERE run_id = ${row.runId}
    `,
  });

  const listEpicRunGateReceiptRows = SqlSchema.findAll({
    Request: ListEpicRunGateReceiptsInput,
    Result: EpicRunGateReceipt,
    execute: ({ runId }) => sql`
      SELECT ${gateReceiptColumns}
      FROM epic_run_gate_receipts
      WHERE run_id = ${runId}
      ORDER BY sequence ASC
    `,
  });

  const upsertProviderDegradationRow = SqlSchema.void({
    Request: EpicProviderDegradation,
    execute: (row) => sql`
      INSERT INTO epic_provider_degradations (provider_instance_id, failure_reason, degraded_at)
      VALUES (${row.providerInstanceId}, ${row.failureReason}, ${row.degradedAt})
      ON CONFLICT (provider_instance_id) DO UPDATE SET
        failure_reason = excluded.failure_reason,
        degraded_at = excluded.degraded_at
    `,
  });

  const providerDegradationColumns = sql.literal(`
    provider_instance_id AS "providerInstanceId",
    failure_reason AS "failureReason",
    degraded_at AS "degradedAt"
  `);

  const getProviderDegradationRow = SqlSchema.findOneOption({
    Request: GetEpicProviderDegradationInput,
    Result: EpicProviderDegradation,
    execute: ({ providerInstanceId }) => sql`
      SELECT ${providerDegradationColumns}
      FROM epic_provider_degradations
      WHERE provider_instance_id = ${providerInstanceId}
    `,
  });

  const clearProviderDegradationRow = SqlSchema.void({
    Request: GetEpicProviderDegradationInput,
    execute: ({ providerInstanceId }) => sql`
      DELETE FROM epic_provider_degradations WHERE provider_instance_id = ${providerInstanceId}
    `,
  });

  const clearExpiredProviderDegradationRow = SqlSchema.void({
    Request: ClearExpiredEpicProviderDegradationInput,
    execute: ({ providerInstanceId, cutoff }) => sql`
      DELETE FROM epic_provider_degradations
      WHERE provider_instance_id = ${providerInstanceId} AND degraded_at <= ${cutoff}
    `,
  });

  const EpicRunMergeStateRow = Schema.Struct({
    ...InitializeEpicRunMergeStateInput.fields,
    // The column stores JSON; the input schema carries the decoded array.
    siblings: Schema.fromJsonString(Schema.Array(EpicRunMergeStateSibling)),
    initialHead: Schema.String,
    parkedCount: NonNegativeInt,
    // The column always exists post-migration 052 and is always read back —
    // never absent the way the input schema's caller-optional field is.
    operatorBaseBranch: Schema.NullOr(Schema.String),
  });

  const initializeEpicRunMergeStateRow = SqlSchema.void({
    Request: InitializeEpicRunMergeStateInput,
    execute: (row) => sql`
      INSERT INTO epic_run_merge_state (
        run_id, initial_head, last_accepted_head, repository_path, base_branch,
        integration_branch, integration_worktree_path, operator_base_branch, siblings
      ) VALUES (
        ${row.runId}, ${row.lastAcceptedHead}, ${row.lastAcceptedHead}, ${row.repositoryPath}, ${row.baseBranch},
        ${row.integrationBranch}, ${row.integrationWorktreePath}, ${row.operatorBaseBranch ?? null},
        ${JSON.stringify(row.siblings)}
      )
      ON CONFLICT (run_id) DO NOTHING
    `,
  });

  const advanceEpicRunMergeIntegration = SqlSchema.void({
    Request: AdvanceEpicRunMergeIntegrationInput,
    execute: ({ runId, lastAcceptedHead }) => sql`
      UPDATE epic_run_merge_state
      SET last_accepted_head = ${lastAcceptedHead}
      WHERE run_id = ${runId}
    `,
  });

  const mergeStateColumns = sql.literal(`
    run_id AS "runId",
    initial_head AS "initialHead",
    last_accepted_head AS "lastAcceptedHead",
    parked_count AS "parkedCount",
    repository_path AS "repositoryPath",
    base_branch AS "baseBranch",
    integration_branch AS "integrationBranch",
    integration_worktree_path AS "integrationWorktreePath",
    operator_base_branch AS "operatorBaseBranch",
    siblings
  `);
  const getEpicRunMergeStateRow = SqlSchema.findOneOption({
    Request: GetEpicRunInput,
    Result: EpicRunMergeStateRow,
    execute: ({ runId }) => sql`
      SELECT ${mergeStateColumns}
      FROM epic_run_merge_state
      WHERE run_id = ${runId}
    `,
  });
  const upsertEpicRunLandingEffectsRow = SqlSchema.void({
    Request: UpsertEpicRunLandingEffectsInput,
    execute: (row) => sql`
      INSERT INTO epic_run_landing_effects (
        run_id, repository_path, base_head, head, commit_count, parked_count
      ) VALUES (
        ${row.runId}, ${row.repositoryPath}, ${row.baseHead}, ${row.head},
        ${row.commitCount}, ${row.parkedCount}
      )
      ON CONFLICT (run_id, repository_path) DO UPDATE SET
        base_head = excluded.base_head,
        head = excluded.head,
        commit_count = excluded.commit_count,
        parked_count = excluded.parked_count
    `,
  });
  const getEpicRunLandingEffectsRows = SqlSchema.findAll({
    Request: GetEpicRunInput,
    Result: EpicRunLandingEffects,
    execute: ({ runId }) => sql`
      SELECT
        run_id AS "runId",
        repository_path AS "repositoryPath",
        base_head AS "baseHead",
        head,
        commit_count AS "commitCount",
        parked_count AS "parkedCount"
      FROM epic_run_landing_effects
      WHERE run_id = ${runId}
      ORDER BY repository_path ASC
    `,
  });

  const mergeEntryColumns = sql.literal(`
    run_id AS "runId",
    sequence,
    child_id AS "childId",
    branch,
    status,
    reason,
    fix_issue_id AS "fixIssueId"
  `);
  const listEpicRunMergeEntries = SqlSchema.findAll({
    Request: GetEpicRunInput,
    Result: EpicRunMergeEntry,
    execute: ({ runId }) => sql`
      SELECT ${mergeEntryColumns}
      FROM epic_run_merge_entries
      WHERE run_id = ${runId}
      ORDER BY sequence ASC
    `,
  });
  const listActiveEpicRunMergeEntries = SqlSchema.findAll({
    Request: GetEpicRunInput,
    Result: EpicRunMergeEntry,
    execute: ({ runId }) => sql`
      SELECT ${mergeEntryColumns}
      FROM epic_run_merge_entries
      WHERE run_id = ${runId} AND status IN ('queued', 'draining')
      ORDER BY sequence ASC
    `,
  });

  const insertEpicRunMergeRowUnlessActive = SqlSchema.void({
    Request: EnqueueEpicRunMergeInput,
    execute: (row) => sql`
      INSERT INTO epic_run_merge_entries (
        run_id, sequence, child_id, branch, status, reason, fix_issue_id
      )
      SELECT
        ${row.runId}, COALESCE(MAX(sequence) + 1, 0), ${row.childId}, ${row.branch},
        'queued', NULL, NULL
      FROM epic_run_merge_entries
      WHERE run_id = ${row.runId}
      HAVING NOT EXISTS (
        SELECT 1 FROM epic_run_merge_entries
        WHERE run_id = ${row.runId} AND branch = ${row.branch}
          AND status IN ('queued', 'draining')
      )
    `,
  });
  const markEpicRunMergeDraining = SqlSchema.void({
    Request: GetEpicRunInput,
    execute: ({ runId }) => sql`
      UPDATE epic_run_merge_entries SET status = 'draining'
      WHERE run_id = ${runId} AND status = 'queued'
    `,
  });
  const restoreEpicRunMergeTail = SqlSchema.void({
    Request: RestoreEpicRunMergeTailInput,
    execute: ({ runId, fromSequence }) => sql`
      UPDATE epic_run_merge_entries SET status = 'queued'
      WHERE run_id = ${runId} AND sequence >= ${fromSequence} AND status = 'draining'
    `,
  });
  const beginParkEpicRunMergeRow = SqlSchema.void({
    Request: ParkEpicRunMergeInput,
    execute: ({ runId, sequence, reason }) => sql`
      UPDATE epic_run_merge_entries
      SET status = 'parked', reason = ${reason}, fix_issue_id = NULL
      WHERE run_id = ${runId} AND sequence = ${sequence}
    `,
  });
  const incrementEpicRunParkedCount = SqlSchema.void({
    Request: ParkEpicRunMergeInput,
    execute: ({ runId }) => sql`
      UPDATE epic_run_merge_state SET parked_count = parked_count + 1 WHERE run_id = ${runId}
    `,
  });
  const finalizeParkedEpicRunMergeRow = SqlSchema.void({
    Request: FinalizeParkedEpicRunMergeInput,
    execute: ({ runId, sequence, fixIssueId }) => sql`
      UPDATE epic_run_merge_entries
      SET fix_issue_id = ${fixIssueId}
      WHERE run_id = ${runId} AND sequence = ${sequence} AND status = 'parked'
    `,
  });
  const advanceEpicRunMergeHead = SqlSchema.void({
    Request: CompleteEpicRunMergeInput,
    execute: ({ runId, lastAcceptedHead }) => sql`
      UPDATE epic_run_merge_state
      SET last_accepted_head = ${lastAcceptedHead}
      WHERE run_id = ${runId}
    `,
  });
  const advanceEpicRunMergeSiblingHeads = SqlSchema.void({
    Request: Schema.Struct({ runId: EpicRunId, siblings: Schema.String }),
    execute: ({ runId, siblings }) => sql`
      UPDATE epic_run_merge_state
      SET siblings = ${siblings}
      WHERE run_id = ${runId}
    `,
  });
  const deleteEpicRunMergeRow = SqlSchema.void({
    Request: DropEpicRunMergeInput,
    execute: ({ runId, sequence }) => sql`
      DELETE FROM epic_run_merge_entries
      WHERE run_id = ${runId}
        AND branch = (
          SELECT branch FROM epic_run_merge_entries AS target
          WHERE target.run_id = ${runId} AND target.sequence = ${sequence}
        )
    `,
  });
  const ParkedChild = Schema.Struct({ childId: Schema.String });
  const findParkedEpicRunMergeRow = SqlSchema.findOneOption({
    Request: FindParkedEpicRunMergeInput,
    Result: ParkedChild,
    execute: ({ runId, branch }) => sql`
      SELECT child_id AS "childId"
      FROM epic_run_merge_entries
      WHERE run_id = ${runId} AND branch = ${branch} AND status = 'parked'
      ORDER BY sequence DESC LIMIT 1
    `,
  });
  const deleteEpicRunMergeEntries = SqlSchema.void({
    Request: GetEpicRunInput,
    execute: ({ runId }) => sql`DELETE FROM epic_run_merge_entries WHERE run_id = ${runId}`,
  });
  const deleteEpicRunMergeState = SqlSchema.void({
    Request: GetEpicRunInput,
    execute: ({ runId }) => sql`DELETE FROM epic_run_merge_state WHERE run_id = ${runId}`,
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
    listEpicRunRows(input).pipe(
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

  const allocateIteration: EpicRunStoreShape["allocateIteration"] = (input) =>
    allocateEpicRunIterationRow(input).pipe(
      Effect.retry({ times: 3, while: isIterationAllocationConflict }),
      Effect.map((row) => row.iterationIndex),
      Effect.mapError(
        toEpicRunStoreError(
          "EpicRunStore.allocateIteration:query",
          "EpicRunStore.allocateIteration:decodeRow",
          { runId: input.runId },
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

  const reopenIteration: EpicRunStoreShape["reopenIteration"] = (input) =>
    reopenEpicRunIterationRow(input).pipe(
      Effect.mapError(
        toEpicRunStoreError(
          "EpicRunStore.reopenIteration:query",
          "EpicRunStore.reopenIteration:encodeRequest",
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

  const listRunningIterations: EpicRunStoreShape["listRunningIterations"] = (input) =>
    listRunningEpicRunIterationRows(input).pipe(
      Effect.mapError(
        toEpicRunStoreError(
          "EpicRunStore.listRunningIterations:query",
          "EpicRunStore.listRunningIterations:decodeRows",
          { runId: input.runId },
        ),
      ),
    );

  const listRecentIterationsForRuns: EpicRunStoreShape["listRecentIterationsForRuns"] = (input) =>
    input.runIds.length === 0
      ? Effect.succeed([])
      : listRecentEpicRunIterationRows(input).pipe(
          Effect.mapError(
            toEpicRunStoreError(
              "EpicRunStore.listRecentIterationsForRuns:query",
              "EpicRunStore.listRecentIterationsForRuns:decodeRows",
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

  const recordGateReceipt: EpicRunStoreShape["recordGateReceipt"] = (input) =>
    recordEpicRunGateReceiptRow(input).pipe(
      Effect.mapError(
        toEpicRunStoreError(
          "EpicRunStore.recordGateReceipt:query",
          "EpicRunStore.recordGateReceipt:encodeRequest",
          { runId: input.runId },
        ),
      ),
    );

  const listGateReceipts: EpicRunStoreShape["listGateReceipts"] = (input) =>
    listEpicRunGateReceiptRows(input).pipe(
      Effect.mapError(
        toEpicRunStoreError(
          "EpicRunStore.listGateReceipts:query",
          "EpicRunStore.listGateReceipts:decodeRows",
          { runId: input.runId },
        ),
      ),
    );

  const upsertProviderDegradation: EpicRunStoreShape["upsertProviderDegradation"] = (input) =>
    upsertProviderDegradationRow(input).pipe(
      Effect.mapError(
        toEpicRunStoreError(
          "EpicRunStore.upsertProviderDegradation:query",
          "EpicRunStore.upsertProviderDegradation:encodeRequest",
        ),
      ),
    );

  const getProviderDegradation: EpicRunStoreShape["getProviderDegradation"] = (input) =>
    getProviderDegradationRow(input).pipe(
      Effect.mapError(
        toEpicRunStoreError(
          "EpicRunStore.getProviderDegradation:query",
          "EpicRunStore.getProviderDegradation:decodeRow",
        ),
      ),
    );

  const clearProviderDegradation: EpicRunStoreShape["clearProviderDegradation"] = (input) =>
    clearProviderDegradationRow(input).pipe(
      Effect.mapError(
        toEpicRunStoreError(
          "EpicRunStore.clearProviderDegradation:query",
          "EpicRunStore.clearProviderDegradation:encodeRequest",
        ),
      ),
    );

  const clearExpiredProviderDegradation: EpicRunStoreShape["clearExpiredProviderDegradation"] = (
    input,
  ) =>
    clearExpiredProviderDegradationRow(input).pipe(
      Effect.mapError(
        toEpicRunStoreError(
          "EpicRunStore.clearExpiredProviderDegradation:query",
          "EpicRunStore.clearExpiredProviderDegradation:encodeRequest",
        ),
      ),
    );

  const initializeMergeState: EpicRunStoreShape["initializeMergeState"] = (input) =>
    initializeEpicRunMergeStateRow(input).pipe(
      Effect.mapError(
        toEpicRunStoreError(
          "EpicRunStore.initializeMergeState:query",
          "EpicRunStore.initializeMergeState:encodeRequest",
          { runId: input.runId },
        ),
      ),
    );

  const getMergeState: EpicRunStoreShape["getMergeState"] = (input) =>
    getEpicRunMergeStateRow(input).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.succeed(Option.none()),
          onSome: (state) =>
            listEpicRunMergeEntries(input).pipe(
              Effect.map((entries) => Option.some({ ...state, entries })),
            ),
        }),
      ),
      Effect.mapError(
        toEpicRunStoreError(
          "EpicRunStore.getMergeState:query",
          "EpicRunStore.getMergeState:decodeRow",
          {
            runId: input.runId,
          },
        ),
      ),
    );

  const enqueueMerge: EpicRunStoreShape["enqueueMerge"] = (input) =>
    insertEpicRunMergeRowUnlessActive(input).pipe(
      Effect.mapError(
        toEpicRunStoreError(
          "EpicRunStore.enqueueMerge:query",
          "EpicRunStore.enqueueMerge:encodeRequest",
          {
            runId: input.runId,
          },
        ),
      ),
    );

  const beginMergeDrain: EpicRunStoreShape["beginMergeDrain"] = (input) =>
    sql
      .withTransaction(
        markEpicRunMergeDraining(input).pipe(Effect.andThen(listActiveEpicRunMergeEntries(input))),
      )
      .pipe(
        Effect.mapError(
          toEpicRunStoreError(
            "EpicRunStore.beginMergeDrain:query",
            "EpicRunStore.beginMergeDrain:decodeRows",
            {
              runId: input.runId,
            },
          ),
        ),
      );

  const restoreMergeTail: EpicRunStoreShape["restoreMergeTail"] = (input) =>
    restoreEpicRunMergeTail(input).pipe(
      Effect.mapError(
        toEpicRunStoreError(
          "EpicRunStore.restoreMergeTail:query",
          "EpicRunStore.restoreMergeTail:encodeRequest",
          {
            runId: input.runId,
          },
        ),
      ),
    );

  const advanceMergeIntegration: EpicRunStoreShape["advanceMergeIntegration"] = (input) =>
    advanceEpicRunMergeIntegration(input).pipe(
      Effect.mapError(
        toEpicRunStoreError(
          "EpicRunStore.advanceMergeIntegration:query",
          "EpicRunStore.advanceMergeIntegration:encodeRequest",
          {
            runId: input.runId,
          },
        ),
      ),
    );

  const beginParkMerge: EpicRunStoreShape["beginParkMerge"] = (input) =>
    sql
      .withTransaction(
        beginParkEpicRunMergeRow(input).pipe(Effect.andThen(incrementEpicRunParkedCount(input))),
      )
      .pipe(
        Effect.mapError(
          toEpicRunStoreError(
            "EpicRunStore.beginParkMerge:query",
            "EpicRunStore.beginParkMerge:encodeRequest",
            {
              runId: input.runId,
            },
          ),
        ),
      );

  const finalizeParkMerge: EpicRunStoreShape["finalizeParkMerge"] = (input) =>
    finalizeParkedEpicRunMergeRow(input).pipe(
      Effect.mapError(
        toEpicRunStoreError(
          "EpicRunStore.finalizeParkMerge:query",
          "EpicRunStore.finalizeParkMerge:encodeRequest",
          { runId: input.runId },
        ),
      ),
    );

  const completeMerge: EpicRunStoreShape["completeMerge"] = (input) =>
    sql
      .withTransaction(
        advanceEpicRunMergeHead(input).pipe(
          Effect.andThen(deleteEpicRunMergeRow(input)),
          Effect.andThen(
            Effect.suspend(() => {
              const siblingHeads = input.siblingHeads;
              if (siblingHeads === undefined) return Effect.void;
              return getEpicRunMergeStateRow({ runId: input.runId }).pipe(
                Effect.flatMap(
                  Option.match({
                    onNone: () => Effect.void,
                    onSome: (state) =>
                      advanceEpicRunMergeSiblingHeads({
                        runId: input.runId,
                        siblings: JSON.stringify(
                          state.siblings.map((sibling) => {
                            const moved = siblingHeads.find(
                              (head) => head.repositoryPath === sibling.repositoryPath,
                            );
                            return moved === undefined
                              ? sibling
                              : { ...sibling, lastAcceptedHead: moved.lastAcceptedHead };
                          }),
                        ),
                      }),
                  }),
                ),
              );
            }),
          ),
        ),
      )
      .pipe(
        Effect.mapError(
          toEpicRunStoreError(
            "EpicRunStore.completeMerge:query",
            "EpicRunStore.completeMerge:encodeRequest",
            {
              runId: input.runId,
            },
          ),
        ),
      );

  const dropMerge: EpicRunStoreShape["dropMerge"] = (input) =>
    deleteEpicRunMergeRow(input).pipe(
      Effect.mapError(
        toEpicRunStoreError(
          "EpicRunStore.dropMerge:query",
          "EpicRunStore.dropMerge:encodeRequest",
          {
            runId: input.runId,
          },
        ),
      ),
    );

  const findParkedOriginalChild: EpicRunStoreShape["findParkedOriginalChild"] = (input) =>
    findParkedEpicRunMergeRow(input).pipe(
      Effect.map(Option.map((row) => row.childId)),
      Effect.mapError(
        toEpicRunStoreError(
          "EpicRunStore.findParkedOriginalChild:query",
          "EpicRunStore.findParkedOriginalChild:decodeRow",
          { runId: input.runId },
        ),
      ),
    );

  const upsertLandingEffects: EpicRunStoreShape["upsertLandingEffects"] = (input) =>
    upsertEpicRunLandingEffectsRow(input).pipe(
      Effect.mapError(
        toEpicRunStoreError(
          "EpicRunStore.upsertLandingEffects:query",
          "EpicRunStore.upsertLandingEffects:encodeRequest",
          { runId: input.runId },
        ),
      ),
    );

  const getLandingEffects: EpicRunStoreShape["getLandingEffects"] = (input) =>
    getEpicRunLandingEffectsRows(input).pipe(
      Effect.mapError(
        toEpicRunStoreError(
          "EpicRunStore.getLandingEffects:query",
          "EpicRunStore.getLandingEffects:decodeRow",
          { runId: input.runId },
        ),
      ),
    );

  const deleteMergeState: EpicRunStoreShape["deleteMergeState"] = (input) =>
    sql
      .withTransaction(
        deleteEpicRunMergeEntries(input).pipe(Effect.andThen(deleteEpicRunMergeState(input))),
      )
      .pipe(
        Effect.mapError(
          toEpicRunStoreError(
            "EpicRunStore.deleteMergeState:query",
            "EpicRunStore.deleteMergeState:encodeRequest",
            {
              runId: input.runId,
            },
          ),
        ),
      );

  return {
    upsertRun,
    getRun,
    listRuns,
    appendIteration,
    allocateIteration,
    updateIteration,
    reopenIteration,
    listIterations,
    listRunningIterations,
    listRecentIterationsForRuns,
    getLatestIteration,
    recordGateReceipt,
    listGateReceipts,
    upsertProviderDegradation,
    getProviderDegradation,
    clearProviderDegradation,
    clearExpiredProviderDegradation,
    initializeMergeState,
    getMergeState,
    enqueueMerge,
    beginMergeDrain,
    restoreMergeTail,
    advanceMergeIntegration,
    beginParkMerge,
    finalizeParkMerge,
    completeMerge,
    dropMerge,
    findParkedOriginalChild,
    upsertLandingEffects,
    getLandingEffects,
    deleteMergeState,
  } satisfies EpicRunStoreShape;
});

export const EpicRunStoreLive = Layer.effect(EpicRunStore, makeEpicRunStore);
