import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  type EpicRun as TransportEpicRun,
  type EpicRunConfigProvenance,
  EpicRunId,
  epicRunIterationThreadId,
  type LaunchEpicRunInput,
  MessageId,
  type ModelSelection,
  ThreadId,
  type TurnId,
  type OrchestrationSessionStatus,
  type OrchestrationThread,
} from "@t3tools/contracts";
import {
  EpicRunLaunchError,
  EpicRunNotFoundError,
  EpicRunPreflightBlockedError,
  EpicRunnerDispatchError,
  type EpicRunnerError,
  EpicRunnerStoreError,
  EpicRunStateError,
} from "@t3tools/epic-core/Errors";
import {
  DEFAULT_INFRA_FAILURE_BUDGET,
  DEFAULT_ITERATION_TIMEOUT_MS,
  DEFAULT_MAX_CONSECUTIVE_FAILURES,
  DEFAULT_MAX_GRACE_CONTINUATIONS,
  DEFAULT_MAX_NO_COMMIT_STREAK,
  DEFAULT_RETRY_BASE_DELAY_MS,
  DEFAULT_RETRY_MAX_DELAY_MS,
  DEFAULT_SUBAGENT_GRACE_TIMEOUT_MS,
  EPIC_RUN_ITERATION_PROMPT,
  decideGraceStep,
  decideIterationBoundary,
  persistedFailureReason,
} from "@t3tools/epic-core/policy";
import * as ProcessRunner from "@t3tools/epic-core/processRunner";
import {
  EpicRunPreflight,
  formatEpicRunPreflightBlocker,
  makeEpicRunConfigSnapshot,
  type EpicRunConfigSnapshot,
} from "@t3tools/epic-core/EpicRunPreflight";
import { EpicRunConfigSource } from "@t3tools/epic-core/EpicRunConfigSource";
import {
  EpicRunLock,
  type EpicRunLockHeldError,
  type EpicRunLockLease,
} from "@t3tools/epic-core/ports/EpicRunLock";
import { resolveEpicProviderFallback } from "@t3tools/epic-core/providerFallback";
import {
  classifyIteration,
  hasRalphBlocked,
  hasRalphDone,
  parseRalphReport,
  type EpicIterationOutcome,
  type IterationTurnState,
} from "@t3tools/epic-core/ralphProtocol";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FiberMap from "effect/FiberMap";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import {
  countFreshRunningSubagents,
  isRunningSubagentLivenessRefusal,
} from "../../orchestration/subagentLiveness.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  EpicRunStore,
  type EpicRun,
  type EpicRunIteration as EpicRunIterationRow,
} from "../../persistence/Services/EpicRuns.ts";
import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import { AgentAwarenessRelay } from "../../relay/AgentAwarenessRelay.ts";
import {
  EpicRunner,
  type EpicRunnerShape,
  type StartEpicRunInput,
} from "../Services/EpicRunner.ts";

const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_QUIET_PERIOD_MS = 1_000;
/** A provider degradation influences automatic launches for one hour. */
const DEFAULT_PROVIDER_DEGRADATION_TTL_MS = 60 * 60 * 1000;
const RECENT_ITERATIONS_LIMIT = 25;
export const assembleIterationPrompt = (input: {
  readonly basePrompt: string;
  readonly issueId: string;
  readonly epicContext: string | null;
  readonly orientationCard: string | null;
}): string =>
  `${input.basePrompt}\n\nCook exactly \`${input.issueId}\` this iteration.\n\n## Epic context (resolved at dispatch)\n\n${input.epicContext ?? "(epic description unavailable)"}\n\n${input.orientationCard ?? "(no orientation card in this repo)"}`;
const GIT_HEAD_TIMEOUT_MS = 15_000;
const MAX_SETTLE_READS = 20;
/**
 * The bound for the one absence worth waiting out: a completed turn whose
 * assistant row has not projected at all. Two minutes at the default quiet
 * period, which is far past any projection lag but nothing against an iteration
 * measured in hours — and it is only ever spent when the alternative is calling
 * a pending message a missing one.
 */
const MAX_ABSENT_MESSAGE_SETTLE_READS = 120;
const ACTIVE_RUN_RETRY_ATTEMPTS = 20;
const ACTIVE_RUN_RETRY_DELAY_MS = 5;

/**
 * Assemble the public run read model from a row plus its already-capped
 * iterations. Pure, so the single-run and batched list paths cannot drift.
 */
const buildTransportRun = (
  run: EpicRun,
  recentIterations: ReadonlyArray<EpicRunIterationRow>,
): TransportEpicRun => ({
  ...run,
  recentIterations,
  threadRefs: recentIterations.flatMap((iteration) =>
    iteration.issueId === null
      ? []
      : [
          {
            issueId: iteration.issueId,
            threadId: iteration.threadId,
            iterationIndex: iteration.iterationIndex,
          },
        ],
  ),
});

const noCommitEvidenceVerdict = (input: {
  readonly status: string | null;
  readonly isResearch: boolean;
  readonly commentsBefore: number;
  readonly commentsAfter: number;
}): { readonly accepted: boolean; readonly failureReason: string | null } => {
  if (input.status !== "closed") {
    return { accepted: false, failureReason: "no-commit-child-open" };
  }
  if (input.commentsAfter <= input.commentsBefore) {
    return {
      accepted: false,
      failureReason: input.isResearch ? "closed-without-findings" : "no-commit-no-evidence",
    };
  }
  return { accepted: true, failureReason: null };
};

const ReadyChildren = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      id: Schema.String,
      parent: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
    }),
  ),
);
const decodeReadyChildren = Schema.decodeUnknownEffect(ReadyChildren);
type ReadyChildSelection =
  | { readonly _tag: "child"; readonly issueId: string }
  | { readonly _tag: "empty" }
  | { readonly _tag: "unrecognised"; readonly candidateIds: ReadonlyArray<string> };
type RunIterationResult =
  | {
      readonly _tag: "classified";
      readonly outcome: EpicIterationOutcome;
      readonly noCommitChildClosed: boolean;
      readonly providerTurnDispatched: boolean;
    }
  | {
      readonly _tag: "ready-unrecognised";
      readonly candidateIds: ReadonlyArray<string>;
      readonly detail: string;
      readonly providerTurnDispatched: false;
    };
const IssueEvidence = Schema.Struct({
  status: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  comment_count: Schema.Number.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
});
const decodeIssueEvidence = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Union([IssueEvidence, Schema.Array(IssueEvidence)])),
);
const decodeEpicDescription = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Union([
      Schema.Struct({ description: Schema.String }),
      Schema.Array(Schema.Struct({ description: Schema.String })),
    ]),
  ),
);

const isValidOrientationFile = (value: string): boolean =>
  !/^(?:[A-Za-z]:[\\/]|[\\/])/u.test(value) && !value.split(/[\\/]/u).includes("..");

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

/**
 * The turn state a session status implies, or null while the session is
 * (re)starting or running and turns must stay unsettled.
 *
 * Mirrors `settledTurnStateForSessionStatus`
 * (`orchestration/Layers/ProjectionPipeline.ts:78-94`) exactly, because the
 * projector settles a thread's running turns from this same status in the same
 * transaction that writes it. That shared origin is what makes this a safe
 * stand-in when the turn row cannot be read (see `classifyFromProjection`).
 */
const settledTurnStateFromSessionStatus = (
  status: OrchestrationSessionStatus,
): "completed" | "interrupted" | "error" | null => {
  switch (status) {
    case "idle":
    case "ready":
      return "completed";
    case "error":
      return "error";
    case "interrupted":
    case "stopped":
      return "interrupted";
    case "starting":
    case "running":
      return null;
  }
};

/**
 * Whether a session status settles the turn.
 *
 * Derived from `settledTurnStateFromSessionStatus` so the two cannot drift. It
 * is not simply `status !== "running"`, and the difference matters: a fresh
 * thread's session is `"starting"` before its turn begins, which under that
 * looser test would end the turn before the agent had said a word.
 */
const isTurnEndSessionStatus = (status: OrchestrationSessionStatus): boolean =>
  settledTurnStateFromSessionStatus(status) !== null;

/**
 * The assistant message an iteration's verdict is read from.
 *
 * Prefers the turn's own pointer, but resolves it against the projected rows
 * first: `CheckpointReactor.ts:294-299` synthesizes an `assistant:<turnId>`
 * pointer for turns that produced no message, and that synthetic id names no
 * row. Falling back to the last projected assistant row matches terminal
 * ralph, whose result is the last agent message of the run.
 */
const resolveFinalAssistantMessage = (
  thread: OrchestrationThread | undefined,
): { readonly text: string; readonly streaming: boolean } | null => {
  if (thread === undefined) {
    return null;
  }
  const assistantMessages = thread.messages.filter((message) => message.role === "assistant");
  const pointer = thread.latestTurn?.assistantMessageId ?? null;
  const named =
    pointer === null ? undefined : assistantMessages.find((message) => message.id === pointer);
  const message = named ?? assistantMessages[assistantMessages.length - 1];
  return message === undefined ? null : { text: message.text, streaming: message.streaming };
};

/**
 * The turn state a thread detail implies, turn row first and session status
 * second.
 *
 * `latestTurn` resolves through an inner join on `threads.latest_turn_id`
 * (`ProjectionSnapshotQuery.ts:1122-1130`), and the same transaction that
 * settles the turn nulls that pointer (`ProjectionPipeline.ts:757-771`). The
 * pointer is only restored later, by `thread.turn-diff-completed` after the
 * CheckpointReactor has captured a git checkpoint and diffed it — seconds of
 * work unrelated to the turn, and skipped entirely when that capture fails. So
 * a settled turn routinely reads back as `null` here, which `classifyIteration`
 * cannot distinguish from "never ran".
 *
 * The session row is the reliable stand-in: the projector writes it in the same
 * transaction it settles the turn with, from this exact mapping, so it can never
 * disagree with the turn row that eventually reappears.
 */
const iterationTurnState = (thread: OrchestrationThread | undefined): IterationTurnState => {
  const sessionStatus = thread?.session?.status ?? null;
  return (
    thread?.latestTurn?.state ??
    (sessionStatus === null ? null : settledTurnStateFromSessionStatus(sessionStatus))
  );
};

/** How an iteration's turn stopped, before its output has been classified. */
type IterationSettleResult =
  | { readonly _tag: "settled" }
  | { readonly _tag: "timeout" }
  | { readonly _tag: "dispatch-failed"; readonly detail: string };

interface EpicRunLeaseHeld {
  readonly _tag: "EpicRunLeaseHeld";
  readonly mappedError: EpicRunPreflightBlockedError;
}

const formatEpicRunLockHeldError = (error: EpicRunLockHeldError): string => {
  const holder = error.holder;
  if (
    holder !== undefined &&
    typeof holder.owner === "string" &&
    typeof holder.host === "string" &&
    typeof holder.pid === "number" &&
    typeof holder.runDir === "string"
  ) {
    return formatEpicRunPreflightBlocker({
      _tag: "run_in_progress",
      owner: holder.owner,
      host: holder.host,
      pid: holder.pid,
      runDir: holder.runDir,
    });
  }
  return error.message;
};

/**
 * What the loop does when it reaches an iteration boundary.
 *
 * Returned from *inside* the transition lock so the decision and the write it
 * implies cannot be split by a concurrent pause or resume, while the wait a
 * failed iteration owes stays outside the lock.
 */
type LoopBoundary =
  | { readonly _tag: "stop" }
  | { readonly _tag: "continue"; readonly delayMs: number };

const LOOP_STOP: LoopBoundary = { _tag: "stop" };

/** How long a resume waits for a dying loop to release the run's own lock. */
const LOOP_EXIT_WAIT_MS = 5_000;

/**
 * The loop-policy fields are internal default seeds. A persisted non-default
 * run config replaces each matching seed when the loop freezes its policy.
 * Provider degradation lifetime remains a layer-wide launch policy.
 */
export interface EpicRunnerLiveOptions {
  readonly iterationTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly quietPeriodMs?: number;
  readonly retryBaseDelayMs?: number;
  readonly retryMaxDelayMs?: number;
  readonly maxConsecutiveFailures?: number;
  readonly maxNoCommitStreak?: number;
  readonly infraFailureBudget?: number;
  readonly subagentGraceTimeoutMs?: number;
  readonly maxGraceContinuations?: number;
  readonly providerDegradationTtlMs?: number;
}

interface EpicRunnerPolicySeed {
  readonly iterationTimeoutMs: number;
  readonly pollIntervalMs: number;
  readonly quietPeriodMs: number;
  readonly retryBaseDelayMs: number;
  readonly retryMaxDelayMs: number;
  readonly maxConsecutiveFailures: number;
  readonly maxNoCommitStreak: number;
  readonly infraFailureBudget: number;
  readonly subagentGraceTimeoutMs: number;
  readonly maxGraceContinuations: number;
}

interface EpicRunnerPolicy extends Omit<EpicRunnerPolicySeed, "iterationTimeoutMs"> {
  /** `null` means the persisted run explicitly disabled the worker timeout. */
  readonly iterationTimeoutMs: number | null;
  readonly maxIterations: number;
}

const hasConfiguredValue = (provenance: EpicRunConfigProvenance, key: string): boolean =>
  provenance[key] !== undefined && provenance[key] !== "default";

/** Freeze all loop policy from the persisted row that starts this loop. */
const makeEpicRunnerPolicy = (seed: EpicRunnerPolicySeed, run: EpicRun): EpicRunnerPolicy => {
  const configured = <Value>(key: string, value: Value, fallback: Value): Value =>
    hasConfiguredValue(run.configProvenance, key) ? value : fallback;
  const retryBaseDelayMs = configured(
    "server.retryBaseDelayMs",
    run.config.server.retryBaseDelayMs,
    seed.retryBaseDelayMs,
  );
  const retryMaxDelayMs = Math.max(
    retryBaseDelayMs,
    configured("server.retryMaxDelayMs", run.config.server.retryMaxDelayMs, seed.retryMaxDelayMs),
  );
  const configuredWorkerTimeout = hasConfiguredValue(
    run.configProvenance,
    "supervision.workerTimeoutSeconds",
  )
    ? run.config.supervision.workerTimeoutSeconds
    : undefined;

  return Object.freeze({
    iterationTimeoutMs:
      configuredWorkerTimeout === undefined
        ? seed.iterationTimeoutMs
        : configuredWorkerTimeout === null
          ? null
          : configuredWorkerTimeout * 1_000,
    pollIntervalMs: configured(
      "server.pollIntervalMs",
      run.config.server.pollIntervalMs,
      seed.pollIntervalMs,
    ),
    quietPeriodMs: configured(
      "server.quietPeriodMs",
      run.config.server.quietPeriodMs,
      seed.quietPeriodMs,
    ),
    retryBaseDelayMs,
    retryMaxDelayMs,
    maxConsecutiveFailures: configured(
      "server.maxConsecutiveFailures",
      run.config.server.maxConsecutiveFailures,
      seed.maxConsecutiveFailures,
    ),
    maxNoCommitStreak: configured(
      "server.maxNoCommitStreak",
      run.config.server.maxNoCommitStreak,
      seed.maxNoCommitStreak,
    ),
    infraFailureBudget: configured(
      "server.infraFailureBudget",
      run.config.server.infraFailureBudget,
      seed.infraFailureBudget,
    ),
    subagentGraceTimeoutMs: configured(
      "server.subagentGraceTimeoutMs",
      run.config.server.subagentGraceTimeoutMs,
      seed.subagentGraceTimeoutMs,
    ),
    maxGraceContinuations: configured(
      "server.maxGraceContinuations",
      run.config.server.maxGraceContinuations,
      seed.maxGraceContinuations,
    ),
    maxIterations: configured(
      "limits.maxIterations",
      run.config.limits.maxIterations,
      run.maxIterations,
    ),
  });
};

const makeEpicRunner = (options?: EpicRunnerLiveOptions) =>
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const store = yield* EpicRunStore;
    const processRunner = yield* ProcessRunner.ProcessRunner;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const crypto = yield* Crypto.Crypto;
    const preflight = yield* EpicRunPreflight;
    const configSource = yield* EpicRunConfigSource;
    const runLock = yield* EpicRunLock;
    const agentAwarenessRelay = yield* AgentAwarenessRelay;
    const providerRegistry = yield* Effect.serviceOption(ProviderRegistry);
    const leases = new Map<EpicRunId, EpicRunLockLease>();
    const issueTitleCache = new Map<string, string>();

    const seedRetryBaseDelayMs = Math.max(
      1,
      options?.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS,
    );
    const policySeed: EpicRunnerPolicySeed = Object.freeze({
      iterationTimeoutMs: Math.max(1, options?.iterationTimeoutMs ?? DEFAULT_ITERATION_TIMEOUT_MS),
      pollIntervalMs: Math.max(1, options?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS),
      quietPeriodMs: Math.max(1, options?.quietPeriodMs ?? DEFAULT_QUIET_PERIOD_MS),
      retryBaseDelayMs: seedRetryBaseDelayMs,
      retryMaxDelayMs: Math.max(
        seedRetryBaseDelayMs,
        options?.retryMaxDelayMs ?? DEFAULT_RETRY_MAX_DELAY_MS,
      ),
      maxConsecutiveFailures: Math.max(
        1,
        options?.maxConsecutiveFailures ?? DEFAULT_MAX_CONSECUTIVE_FAILURES,
      ),
      maxNoCommitStreak: Math.max(1, options?.maxNoCommitStreak ?? DEFAULT_MAX_NO_COMMIT_STREAK),
      infraFailureBudget: Math.max(1, options?.infraFailureBudget ?? DEFAULT_INFRA_FAILURE_BUDGET),
      subagentGraceTimeoutMs: Math.max(
        1,
        options?.subagentGraceTimeoutMs ?? DEFAULT_SUBAGENT_GRACE_TIMEOUT_MS,
      ),
      maxGraceContinuations: Math.max(
        1,
        options?.maxGraceContinuations ?? DEFAULT_MAX_GRACE_CONTINUATIONS,
      ),
    });
    const providerDegradationTtlMs = Math.max(
      0,
      options?.providerDegradationTtlMs ?? DEFAULT_PROVIDER_DEGRADATION_TTL_MS,
    );

    const changes = yield* Effect.acquireRelease(PubSub.unbounded<TransportEpicRun>(), (pubsub) =>
      PubSub.shutdown(pubsub),
    );
    // Scoped to the layer, so every loop is interrupted on server shutdown and
    // no run keeps dispatching turns into a tearing-down orchestration engine.
    const loops = yield* FiberMap.make<EpicRunId, void, never>();
    /**
     * Runs whose loop will still re-read their status at its next iteration
     * boundary.
     *
     * `pauseRun` does not interrupt the turn in flight, so a paused run keeps a
     * live loop — and its own lock — for the rest of that iteration. A resume
     * landing in that window is handed to the live loop instead of relaunching,
     * so it must be able to tell "still draining" from "already gone". The mark
     * is dropped inside the same critical section that commits the loop to
     * exiting, so it can never claim a loop that will not look again.
     */
    const liveLoops = new Set<EpicRunId>();
    /**
     * Serializes every run-status transition — the loop's own boundary writes
     * included — so no writer can act on a status another writer has already
     * replaced. Never held across an agent turn.
     */
    const transitions = yield* Semaphore.make(1);
    const withTransition = transitions.withPermits(1);

    const storeError = (operation: string) => (cause: unknown) =>
      new EpicRunnerStoreError({ operation, cause });

    const commandId = (tag: string) =>
      crypto.randomUUIDv4.pipe(
        Effect.map((uuid) => CommandId.make(`server:epic-run-${tag}:${uuid}`)),
        Effect.orDie,
      );

    const dispatchCommand = (command: Parameters<typeof engine.dispatch>[0]) =>
      engine.dispatch(command).pipe(
        Effect.asVoid,
        Effect.mapError(
          (cause) =>
            new EpicRunnerDispatchError({
              commandType: command.type,
              detail: cause.message,
              cause,
            }),
        ),
      );

    /** Dispatch something the loop can survive losing (interrupts, session stops). */
    const dispatchBestEffort = (
      label: string,
      command: Parameters<typeof engine.dispatch>[0],
    ): Effect.Effect<void> =>
      // `catchCause` already recovers every cause, defects included.
      dispatchCommand(command).pipe(
        Effect.catchCause((cause) => Effect.logWarning(label, { cause })),
      );

    const enrichRun = Effect.fn("EpicRunner.enrichRun")(function* (run: EpicRun) {
      const iterations = yield* store
        .listIterations({ runId: run.runId })
        .pipe(Effect.mapError(storeError("listIterations")));
      return buildTransportRun(run, iterations.slice(-RECENT_ITERATIONS_LIMIT));
    });

    /**
     * Enrich a whole listing with ONE iteration query, not one per run.
     *
     * `listRecentIterationsForRuns` already caps each run at
     * `RECENT_ITERATIONS_LIMIT`, so the grouping here does no slicing of its
     * own; a run with no iterations is absent from the batch and gets an empty
     * array.
     */
    const enrichRuns = Effect.fn("EpicRunner.enrichRuns")(function* (runs: ReadonlyArray<EpicRun>) {
      const iterations = yield* store
        .listRecentIterationsForRuns({
          runIds: runs.map((run) => run.runId),
          limitPerRun: RECENT_ITERATIONS_LIMIT,
        })
        .pipe(Effect.mapError(storeError("listRecentIterationsForRuns")));
      const byRunId = new Map<EpicRunId, Array<EpicRunIterationRow>>();
      for (const iteration of iterations) {
        const bucket = byRunId.get(iteration.runId);
        if (bucket === undefined) byRunId.set(iteration.runId, [iteration]);
        else bucket.push(iteration);
      }
      return runs.map((run) => buildTransportRun(run, byRunId.get(run.runId) ?? []));
    });

    const findActiveRun = Effect.fn("EpicRunner.findActiveRun")(function* (input: {
      readonly epicId: string;
      readonly cwd: string;
    }) {
      const runs = yield* store.listRuns({}).pipe(Effect.mapError(storeError("listRuns")));
      return runs.find(
        (run) =>
          (run.status === "running" || run.status === "paused") &&
          run.epicId === input.epicId &&
          run.cwd === input.cwd,
      );
    });

    const awaitActiveRun = Effect.fn("EpicRunner.awaitActiveRun")(function* (input: {
      readonly epicId: string;
      readonly cwd: string;
    }) {
      for (let attempt = 0; attempt < ACTIVE_RUN_RETRY_ATTEMPTS; attempt += 1) {
        const active = yield* findActiveRun(input);
        if (active !== undefined) return active;
        if (attempt + 1 < ACTIVE_RUN_RETRY_ATTEMPTS) {
          yield* Effect.sleep(Duration.millis(ACTIVE_RUN_RETRY_DELAY_MS));
        }
      }
      return undefined;
    });

    const readIssueTitle = (cwd: string, issueId: string) => {
      const cached = issueTitleCache.get(issueId);
      if (cached) return Effect.succeed(cached);
      return processRunner.run({ command: "bd", args: ["show", issueId, "--json"], cwd }).pipe(
        Effect.flatMap((output) =>
          Effect.try({
            try: () => {
              const decoded = decodeIssueEvidence(output.stdout);
              if (Option.isNone(decoded)) return issueId;
              const value = Array.isArray(decoded.value) ? decoded.value[0] : decoded.value;
              const title = value?.title.trim() ?? "";
              return title.length > 0 ? title : issueId;
            },
            catch: () => issueId,
          }),
        ),
        Effect.orElseSucceed(() => issueId),
        Effect.tap((title) => Effect.sync(() => issueTitleCache.set(issueId, title))),
      );
    };

    const publishRunBestEffort = (run: TransportEpicRun) =>
      Effect.gen(function* () {
        const latestIssueId = run.recentIterations.at(-1)?.issueId ?? null;
        const epicTitle = yield* readIssueTitle(run.cwd, run.epicId);
        const childTitle =
          latestIssueId === null ? undefined : yield* readIssueTitle(run.cwd, latestIssueId);
        yield* agentAwarenessRelay.publishEpicRun({
          ...run,
          epicTitle,
          ...(childTitle ? { childTitle } : {}),
        });
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("epic runner activity publish failed", {
            runId: run.runId,
            epicId: run.epicId,
            cause,
          }),
        ),
      );

    const saveRun = (run: EpicRun) =>
      store.upsertRun(run).pipe(
        Effect.mapError(storeError("upsertRun")),
        Effect.flatMap(() => enrichRun(run)),
        Effect.tap((enriched) => publishRunBestEffort(enriched)),
        Effect.flatMap((enriched) => PubSub.publish(changes, enriched)),
        Effect.asVoid,
      );

    const requireRun = (runId: EpicRunId) =>
      store.getRun({ runId }).pipe(
        Effect.mapError(storeError("getRun")),
        Effect.flatMap((run) =>
          Option.isNone(run)
            ? Effect.fail(new EpicRunNotFoundError({ runId }))
            : Effect.succeed(run.value),
        ),
      );

    /**
     * The repo's `HEAD`, or `null` when it cannot be read (no repo, no commits,
     * git missing). `null` never counts as movement, mirroring terminal ralph's
     * `head_after != none` guard (`run.sh:321`).
     */
    const readHeadCommit = (cwd: string): Effect.Effect<string | null> =>
      processRunner
        .run({
          command: "git",
          args: ["rev-parse", "--verify", "-q", "HEAD"],
          cwd,
          timeout: Duration.millis(GIT_HEAD_TIMEOUT_MS),
        })
        .pipe(
          Effect.map((output) => {
            const sha = output.stdout.trim();
            return output.code === 0 && sha.length > 0 ? sha : null;
          }),
          Effect.catchCause((cause) =>
            Effect.logDebug("epic.runner.head-read-failed", { cwd, cause }).pipe(Effect.as(null)),
          ),
        );

    /**
     * The repo's current porcelain status, verbatim, or `null` when git cannot
     * read it. Empty stdout is a valid clean-worktree fingerprint. `null`
     * never counts as progress.
     */
    const readWorktreeFingerprint = (cwd: string): Effect.Effect<string | null> =>
      processRunner
        .run({
          command: "git",
          args: ["status", "--porcelain=v1"],
          cwd,
          timeout: Duration.millis(GIT_HEAD_TIMEOUT_MS),
        })
        .pipe(
          Effect.map((output) => (output.code === 0 ? output.stdout : null)),
          Effect.catchCause((cause) =>
            Effect.logDebug("epic.runner.worktree-read-failed", { cwd, cause }).pipe(
              Effect.as(null),
            ),
          ),
        );

    const selectReadyChild = (run: EpicRun): Effect.Effect<ReadyChildSelection, EpicRunnerError> =>
      processRunner
        .run({
          command: "bd",
          args: ["ready", "--parent", run.epicId, "--json"],
          cwd: run.cwd,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new EpicRunnerDispatchError({
                commandType: "bd.ready",
                detail: "Could not read the epic's ready children",
                cause,
              }),
          ),
          Effect.flatMap((output) => {
            if (output.code !== 0) {
              return Effect.fail(
                new EpicRunnerDispatchError({
                  commandType: "bd.ready",
                  detail: output.stderr.trim() || `bd ready exited with code ${output.code}`,
                }),
              );
            }
            return decodeReadyChildren(output.stdout).pipe(
              Effect.mapError(
                (cause) =>
                  new EpicRunnerDispatchError({
                    commandType: "bd.ready",
                    detail: `Invalid bd ready output: ${String(cause)}`,
                    cause,
                  }),
              ),
              Effect.flatMap((value) => {
                if (value.length === 0)
                  return Effect.succeed<ReadyChildSelection>({ _tag: "empty" });

                // `bd ready --parent` owns the scope. Some bd rows omit the
                // parent value, which decodes to null and is usable. Reject
                // only an explicit parent that names another issue.
                const direct = value.find(
                  (issue) => issue.parent === null || issue.parent === run.epicId,
                );
                if (direct === undefined) {
                  return Effect.succeed<ReadyChildSelection>({
                    _tag: "unrecognised",
                    candidateIds: value.map((issue) => issue.id),
                  });
                }
                return direct.id.trim().length === 0
                  ? Effect.fail(
                      new EpicRunnerDispatchError({
                        commandType: "bd.ready",
                        detail: "Invalid bd ready output: first usable ready child has no id",
                      }),
                    )
                  : Effect.succeed<ReadyChildSelection>({ _tag: "child", issueId: direct.id });
              }),
            );
          }),
        );

    /**
     * Best-effort: un-claim a child issue the loop's own exit just stranded.
     *
     * An iteration's agent claims its child itself (`bd update <id> --claim`,
     * per `EPIC_RUN_ITERATION_PROMPT`) and is expected to close it before the
     * turn ends. When the *run* instead exits without that happening —
     * exhausted retries, a no-commit gutter, an error, a cancel, a lost lease
     * on restart — the child is left `in_progress` with no worker attached.
     * `bd ready` filters on status, not assignee, so a phantom `in_progress`
     * claim silently stalls the epic until someone notices and clears it by
     * hand. This is the general fix: check the child's *current* status and
     * only reopen it if the claim is still standing, so the happy path (the
     * agent already closed it) and a legitimate handoff to another run are
     * both untouched.
     *
     * Never fails the caller: this runs from terminal paths (finalizers,
     * restart bookkeeping) that have nowhere useful to send an error.
     */
    const emptyIssueEvidence = {
      status: null,
      title: null,
      commentCount: 0,
    } as const;

    /**
     * The child issue evidence available from one `bd show`, with conservative
     * defaults when the command fails or its output cannot be decoded. Never
     * fails the caller: unknown status and comment count cannot prove work.
     */
    const readIssueEvidence = (
      cwd: string,
      issueId: string,
    ): Effect.Effect<{
      readonly status: string | null;
      readonly title: string | null;
      readonly commentCount: number;
    }> =>
      processRunner.run({ command: "bd", args: ["show", issueId, "--json"], cwd }).pipe(
        Effect.map((shown) => {
          if (shown.code !== 0) return emptyIssueEvidence;
          const decoded = decodeIssueEvidence(shown.stdout);
          if (Option.isNone(decoded)) return emptyIssueEvidence;
          const value = Array.isArray(decoded.value) ? decoded.value[0] : decoded.value;
          if (value === undefined) return emptyIssueEvidence;
          return {
            status: value.status ?? null,
            title: value.title ?? null,
            commentCount: value.comment_count,
          };
        }),
        Effect.catchCause((cause) =>
          Effect.logWarning("epic.runner.issue-evidence-read-failed", { cwd, issueId, cause }).pipe(
            Effect.as(emptyIssueEvidence),
          ),
        ),
      );

    /**
     * Whether findings in the bead are this child's deliverable. A title
     * prefix is authoritative; otherwise a failed label read means false.
     */
    const readIssueIsResearch = (
      cwd: string,
      issueId: string,
      title: string | null,
    ): Effect.Effect<boolean> => {
      if (title?.startsWith("Research:") === true) return Effect.succeed(true);
      return processRunner.run({ command: "bd", args: ["label", "list", issueId], cwd }).pipe(
        Effect.map((listed) => listed.code === 0 && /^\s*-\s*research\s*$/imu.test(listed.stdout)),
        Effect.catchCause(() => Effect.succeed(false)),
      );
    };

    /**
     * The child issue's current `bd` status, or `null` when it cannot be read.
     * Callers must treat `null` conservatively; it is "unknown", not "open".
     */
    const readIssueStatus = (cwd: string, issueId: string): Effect.Effect<string | null> =>
      readIssueEvidence(cwd, issueId).pipe(Effect.map((evidence) => evidence.status));

    const readEpicDescription = (cwd: string, epicId: string): Effect.Effect<string | null> =>
      processRunner.run({ command: "bd", args: ["show", epicId, "--json"], cwd }).pipe(
        Effect.flatMap((shown) => {
          if (shown.code !== 0) {
            return Effect.logWarning("epic.runner.epic-description-read-failed", {
              cwd,
              epicId,
              detail: shown.stderr.trim() || `bd show exited with code ${shown.code}`,
            }).pipe(Effect.as(null));
          }
          const decoded = decodeEpicDescription(shown.stdout);
          const value = Option.isSome(decoded)
            ? Array.isArray(decoded.value)
              ? decoded.value[0]
              : decoded.value
            : undefined;
          if (value === undefined) {
            return Effect.logWarning("epic.runner.epic-description-decode-failed", {
              cwd,
              epicId,
            }).pipe(Effect.as(null));
          }
          return Effect.succeed<string | null>(value.description);
        }),
        Effect.catchCause((cause) =>
          Effect.logWarning("epic.runner.epic-description-read-failed", {
            cwd,
            epicId,
            cause,
          }).pipe(Effect.as(null)),
        ),
      );

    const readOrientationCard = (
      checkoutPath: string,
      orientationFile: string | null,
    ): Effect.Effect<string | null> =>
      Effect.gen(function* () {
        const candidates =
          orientationFile === null ? ["docs/agent-orientation.md", "AGENTS.md"] : [orientationFile];
        for (const candidate of candidates) {
          const contents = yield* fileSystem
            .readFileString(path.join(checkoutPath, candidate))
            .pipe(Effect.option);
          if (Option.isSome(contents)) return contents.value;
        }
        return null;
      });

    const releaseClaimedChild = (cwd: string, issueId: string): Effect.Effect<void> =>
      readIssueStatus(cwd, issueId).pipe(
        Effect.flatMap((status) => {
          if (status !== "in_progress") return Effect.void;
          return processRunner
            .run({
              command: "bd",
              args: ["update", issueId, "--status", "open", "--assignee", ""],
              cwd,
            })
            .pipe(Effect.asVoid);
        }),
        Effect.catchCause((cause) =>
          Effect.logWarning("epic.runner.release-claimed-child-failed", { cwd, issueId, cause }),
        ),
      );

    /**
     * Release every child this run claimed and left in progress, via
     * {@link releaseClaimedChild}. The lone finalizer this runner needs — every
     * terminal exit funnels through one loop, and one restart bookkeeping path
     * that never reaches the loop at all — rather than a release call
     * scattered across each of the outcomes that can strand a claim.
     *
     * Every iteration is swept, not just the latest: an earlier iteration can
     * commit and classify as done while the in-thread agent leaves its own
     * child `in_progress`, and nothing else would ever reopen that one
     * (t3code-1bk). `releaseClaimedChild` re-reads each issue and no-ops unless
     * it is still `in_progress`, so sweeping already-closed iterations is free
     * of side effects. Ids are de-duplicated because a retried iteration can
     * claim the same child twice.
     */
    const releaseStrandedChild = (runId: EpicRunId): Effect.Effect<void> =>
      Effect.gen(function* () {
        const run = yield* store.getRun({ runId });
        if (Option.isNone(run)) return;
        const iterations = yield* store.listIterations({ runId });
        const issueIds = [
          ...new Set(
            iterations
              .map((iteration) => iteration.issueId)
              .filter((issueId): issueId is string => issueId !== null),
          ),
        ];
        yield* Effect.forEach(issueIds, (issueId) => releaseClaimedChild(run.value.cwd, issueId), {
          concurrency: 1,
          discard: true,
        });
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("epic.runner.release-stranded-child-lookup-failed", {
            runId,
            cause,
          }),
        ),
      );

    const releaseLease = (runId: EpicRunId) => {
      const lease = leases.get(runId);
      if (lease === undefined) return Effect.void;
      leases.delete(runId);
      return lease.release.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("epic.runner.lock-release-failed", { runId, cause }),
        ),
        Effect.asVoid,
      );
    };
    const releaseLeaseOnFailure =
      (runId: EpicRunId) =>
      <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
        effect.pipe(
          Effect.onExit((exit) => (Exit.isFailure(exit) ? releaseLease(runId) : Effect.void)),
        );

    yield* Effect.addFinalizer(() =>
      Effect.forEach([...leases.keys()], releaseLease, { discard: true }),
    );

    const acquireLease = Effect.fn("EpicRunner.acquireLease")(function* (
      runId: EpicRunId,
      input: Pick<StartEpicRunInput, "cwd" | "epicId">,
      configSnapshot: EpicRunConfigSnapshot,
    ) {
      const result = yield* preflight
        .check(
          {
            workspaceRoot: input.cwd,
            epicId: input.epicId,
            mode: configSnapshot.config.execution.sequential ? "sequential" : "parallel",
          },
          configSnapshot,
        )
        .pipe(
          Effect.mapError(
            (error) =>
              new EpicRunPreflightBlockedError({
                epicId: input.epicId,
                blockers: [error.message],
              }),
          ),
        );
      if (!result.ok) {
        const mapped = new EpicRunPreflightBlockedError({
          epicId: input.epicId,
          blockers: result.blockers.map(formatEpicRunPreflightBlocker),
        });
        if (result.blockers.some((blocker) => blocker._tag === "run_in_progress")) {
          return yield* Effect.fail({
            _tag: "EpicRunLeaseHeld",
            mappedError: mapped,
          } satisfies EpicRunLeaseHeld);
        }
        return yield* mapped;
      }
      const lease = yield* runLock
        .acquire({
          workspaceRoot: input.cwd,
          epicId: input.epicId,
          owner: "t3code",
          runDir: input.cwd,
        })
        .pipe(
          Effect.mapError((error): EpicRunPreflightBlockedError | EpicRunLeaseHeld => {
            const mapped = new EpicRunPreflightBlockedError({
              epicId: input.epicId,
              blockers: [
                error._tag === "EpicRunLockHeldError"
                  ? formatEpicRunLockHeldError(error)
                  : error.message,
              ],
            });
            return error._tag === "EpicRunLockHeldError"
              ? { _tag: "EpicRunLeaseHeld", mappedError: mapped }
              : mapped;
          }),
        );
      leases.set(runId, lease);
    });

    /**
     * The `worktreePath` an iteration's thread must carry to actually run in
     * the run's `cwd`.
     *
     * A thread's working directory is `worktreePath ?? project.workspaceRoot`
     * (`checkpointing/Utils.ts:22-26`), so leaving it null silently runs the
     * agent in the project root. When that already *is* the run's cwd the field
     * stays null rather than claiming a worktree that does not exist; when the
     * run targets somewhere else (a cook-epic worktree, a sibling checkout) it
     * has to be set, or the agent would commit into one repo while the
     * commit cross-check watched another.
     */
    const resolveIterationWorktreePath = (run: EpicRun) =>
      projectionSnapshotQuery.getProjectShellById(run.projectId).pipe(
        Effect.map((project) =>
          Option.isSome(project) && project.value.workspaceRoot === run.cwd ? null : run.cwd,
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning("epic.runner.project-read-failed", {
            projectId: run.projectId,
            cause,
          }).pipe(Effect.as(run.cwd)),
        ),
      );

    const readThreadShell = (threadId: ThreadId) =>
      projectionSnapshotQuery.getThreadShellById(threadId).pipe(
        Effect.map(Option.getOrUndefined),
        Effect.catchCause((cause) =>
          Effect.logWarning("epic.runner.shell-read-failed", { threadId, cause }).pipe(
            Effect.as(undefined),
          ),
        ),
      );

    /**
     * Wait until the iteration's turn has ended.
     *
     * Polls the projection rather than subscribing to `streamDomainEvents`.
     * That is a deliberate trade. The event stream is lower-latency, but there
     * is no way to know a subscription is live before dispatching: neither
     * `Stream.toPull`, `Stream.toQueue`, nor `Stream.onStart` opens the
     * underlying `Stream.fromPubSub` (`OrchestrationEngine.ts:326-331`) eagerly,
     * so a fast turn can publish its entire lifecycle into a subscription that
     * does not exist yet — and the iteration then hangs until its multi-hour
     * timeout. Polling has no such window: projections are committed in the
     * same transaction as the append (`OrchestrationEngine.ts:170-180`), so
     * every read is consistent and no signal can be missed. At iteration
     * timescales the added latency is irrelevant, and the read is the cheap
     * shell row, not the full thread.
     *
     * Turn end is the same signal the projector uses — a turn leaving
     * `running` (`ProjectionPipeline.ts:1059-1073`). The session is a fallback
     * for the case where the provider dies before a turn row ever exists, which
     * would otherwise be indistinguishable from "still starting".
     */
    const awaitTurnEnd = (
      threadId: ThreadId,
      policy: EpicRunnerPolicy,
      priorTurnId: TurnId | null = null,
    ) =>
      Effect.gen(function* () {
        let observedActive = false;
        while (true) {
          const shell = yield* readThreadShell(threadId);
          // A continuation turn is dispatched while the thread's PREVIOUS turn
          // is still the projected latest — turn rows are created at provider
          // adoption, not at turn.start — so until the new turn appears, the
          // prior turn's settled state must not read as this turn's end.
          const latestTurn =
            shell?.latestTurn != null && shell.latestTurn.turnId !== priorTurnId
              ? shell.latestTurn
              : null;
          const turnState = latestTurn?.state ?? null;
          const sessionStatus = shell?.session?.status ?? null;

          if (
            turnState === "running" ||
            sessionStatus === "starting" ||
            sessionStatus === "running"
          ) {
            observedActive = true;
          }
          if (turnState !== null && turnState !== "running") {
            return;
          }
          if (observedActive && sessionStatus !== null && isTurnEndSessionStatus(sessionStatus)) {
            return;
          }

          yield* Effect.sleep(Duration.millis(policy.pollIntervalMs));
        }
      });

    /**
     * The thread detail read every subagent-liveness check shares. `undefined`
     * (missing thread, read failure) reads as "no subagents" for the advisory
     * drain. The guarded stop still checks liveness atomically, so a broken
     * read cannot authorize a destructive stop.
     */
    const readThreadDetail = (threadId: ThreadId) =>
      projectionSnapshotQuery.getThreadDetailSnapshot(threadId).pipe(
        Effect.map(Option.getOrUndefined),
        Effect.catchCause((cause) =>
          Effect.logWarning("epic.runner.snapshot-read-failed", { threadId, cause }).pipe(
            Effect.as(undefined),
          ),
        ),
      );

    /**
     * Wait for the thread to have no FRESH running subagents, bounded by
     * `subagentGraceTimeoutMs`. Polls the detail snapshot rather than the
     * shell's `activeSubagentCount` because staleness matters: that count
     * includes rows stranded at `running`, which the settle decider ignores —
     * waiting on them would burn the whole bound for work that no longer
     * exists. Returns whether the drain completed inside the bound.
     */
    const awaitSubagentDrain = (threadId: ThreadId, policy: EpicRunnerPolicy) =>
      Effect.gen(function* () {
        while (true) {
          const snapshot = yield* readThreadDetail(threadId);
          const subagents = snapshot?.thread.subagents ?? [];
          const nowMs = Date.parse(yield* nowIso);
          if (countFreshRunningSubagents(subagents, nowMs) === 0) {
            return;
          }
          yield* Effect.sleep(Duration.millis(policy.pollIntervalMs));
        }
      }).pipe(
        Effect.timeoutOption(Duration.millis(policy.subagentGraceTimeoutMs)),
        Effect.map(Option.isSome),
      );

    /**
     * The grace path for an agent that ended its turn while its subagents were
     * still working — the exact incident shape this exists for: the SDK
     * reports a legitimate turn end, the runner would classify no-commit and
     * settle, and the settle would tear down the session and kill the
     * subagents' in-flight work.
     *
     * Runs only after a normally-settled turn with no commit. Fresh running
     * subagents first drain within a bound, then earn a continuation. A turn
     * without fresh subagents also earns one when it omitted the RALPH protocol
     * and changed the worktree since the last continuation decision. Both paths
     * share one continuation budget and message-id sequence. The iteration's
     * outer timeout bounds the complete chain. Commits, failed turns, explicit
     * protocol outcomes, unchanged worktrees, and drain timeouts fall through
     * to classification and guarded session cleanup.
     */
    const graceContinuationForSubagents = (input: {
      readonly run: EpicRun;
      readonly iterationIndex: number;
      readonly threadId: ThreadId;
      readonly headBefore: string | null;
      readonly initialWorktreeFingerprint: string | null;
      readonly policy: EpicRunnerPolicy;
    }): Effect.Effect<IterationSettleResult> =>
      Effect.gen(function* () {
        const settled: IterationSettleResult = { _tag: "settled" };
        let continuationIndex = 0;
        let worktreeFingerprintBefore = input.initialWorktreeFingerprint;

        while (true) {
          const headAfter = yield* readHeadCommit(input.run.cwd);
          const headMoved = headAfter !== null && headAfter !== input.headBefore;
          if (headMoved) {
            const decision = decideGraceStep({
              headMoved,
              turnStatus: null,
              freshRunningCount: 0,
              fingerprintChanged: null,
              hasRalphToken: false,
              finalMessageMissing: false,
              finalMessageWaitExhausted: false,
              continuationsUsed: continuationIndex,
              maxGraceContinuations: input.policy.maxGraceContinuations,
            });
            if (decision.action === "settle") return settled;
          }

          const snapshot = yield* readThreadDetail(input.threadId);
          const thread = snapshot?.thread;
          const turnStatus = iterationTurnState(thread);
          if (turnStatus !== "completed") {
            const decision = decideGraceStep({
              headMoved,
              turnStatus,
              freshRunningCount: 0,
              fingerprintChanged: null,
              hasRalphToken: false,
              finalMessageMissing: false,
              finalMessageWaitExhausted: false,
              continuationsUsed: continuationIndex,
              maxGraceContinuations: input.policy.maxGraceContinuations,
            });
            if (decision.action === "settle") return settled;
          }

          const freshRunning = countFreshRunningSubagents(
            thread?.subagents ?? [],
            Date.parse(yield* nowIso),
          );
          let worktreeFingerprintAfter: string | null = null;
          let fingerprintChanged: boolean | null = null;
          let finalMessageMissing = false;
          let finalMessageWaitExhausted = false;
          let hasRalphToken = false;
          if (freshRunning === 0) {
            worktreeFingerprintAfter = yield* readWorktreeFingerprint(input.run.cwd);
            fingerprintChanged =
              worktreeFingerprintBefore === null || worktreeFingerprintAfter === null
                ? null
                : worktreeFingerprintAfter !== worktreeFingerprintBefore;
            if (fingerprintChanged !== true) {
              const decision = decideGraceStep({
                headMoved,
                turnStatus,
                freshRunningCount: freshRunning,
                fingerprintChanged,
                hasRalphToken,
                finalMessageMissing,
                finalMessageWaitExhausted,
                continuationsUsed: continuationIndex,
                maxGraceContinuations: input.policy.maxGraceContinuations,
              });
              if (decision.action === "settle") return settled;
            }
            const finalMessage = yield* readSettledFinalMessage(input.threadId, input.policy);
            const finalAssistantMessage = resolveFinalAssistantMessage(
              finalMessage.snapshot?.thread,
            );
            const text = finalAssistantMessage?.text ?? null;
            finalMessageMissing = text === null;
            finalMessageWaitExhausted = finalMessage.messageWaitExhausted;
            hasRalphToken =
              text !== null &&
              (hasRalphDone(text) || hasRalphBlocked(text) || parseRalphReport(text) !== null);
          }

          const decision = decideGraceStep({
            headMoved,
            turnStatus,
            freshRunningCount: freshRunning,
            fingerprintChanged,
            hasRalphToken,
            finalMessageMissing,
            finalMessageWaitExhausted,
            continuationsUsed: continuationIndex,
            maxGraceContinuations: input.policy.maxGraceContinuations,
          });
          if (decision.action === "settle") {
            if (decision.reason === "continuation-cap") {
              yield* Effect.logWarning("epic.runner.subagent-grace-cap", {
                runId: input.run.runId,
                iterationIndex: input.iterationIndex,
                threadId: input.threadId,
                continuationIndex,
              });
            }
            return settled;
          }

          const priorTurnId = thread?.latestTurn?.turnId ?? null;
          if (decision.action === "awaitDrain") {
            yield* Effect.logInfo("epic.runner.subagent-grace-started", {
              runId: input.run.runId,
              iterationIndex: input.iterationIndex,
              threadId: input.threadId,
              continuationIndex,
              freshRunning,
            });
            const drained = yield* awaitSubagentDrain(input.threadId, input.policy);
            if (!drained) {
              yield* Effect.logWarning("epic.runner.subagent-grace-timeout", {
                runId: input.run.runId,
                iterationIndex: input.iterationIndex,
                threadId: input.threadId,
                continuationIndex,
              });
              return settled;
            }
            worktreeFingerprintBefore = yield* readWorktreeFingerprint(input.run.cwd);
            yield* Effect.logInfo("epic.runner.subagent-grace-continuation", {
              runId: input.run.runId,
              iterationIndex: input.iterationIndex,
              threadId: input.threadId,
              continuationIndex: decision.nextContinuationCount,
            });
          } else {
            worktreeFingerprintBefore = worktreeFingerprintAfter;
            yield* Effect.logInfo("epic.runner.progress-continuation", {
              runId: input.run.runId,
              iterationIndex: input.iterationIndex,
              threadId: input.threadId,
              continuationIndex: decision.nextContinuationCount,
            });
          }

          continuationIndex = decision.nextContinuationCount;
          const createdAt = yield* nowIso;
          yield* dispatchCommand({
            type: "thread.turn.start",
            commandId: yield* commandId("turn-continue"),
            threadId: input.threadId,
            message: {
              // Every continuation needs its own message id. Otherwise a later
              // cycle replaces the earlier continuation in the projection.
              messageId: MessageId.make(
                continuationIndex === 1
                  ? `${input.threadId}-continue`
                  : `${input.threadId}-continue-${continuationIndex}`,
              ),
              role: "user",
              text: decision.prompt,
              attachments: [],
            },
            modelSelection: input.run.modelSelection,
            runtimeMode: input.run.runtimeMode,
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            createdAt,
          });
          yield* awaitTurnEnd(input.threadId, input.policy, priorTurnId);
        }
      }).pipe(
        Effect.catch((error: EpicRunnerError) =>
          Effect.succeed<IterationSettleResult>({
            _tag: "dispatch-failed",
            detail: error.message,
          }),
        ),
      );

    /**
     * Read the turn's final assistant message once it has stopped changing.
     *
     * The turn-end signal is not the read point: ingestion dispatches
     * `thread.session.set` (`ProviderRuntimeIngestion.ts:1666`) before it
     * finalizes the turn's assistant messages, so reading immediately returns a
     * still-streaming row — empty, on ACP providers whose text exists only as
     * deltas. Waiting for two consecutive identical reads closes that gap.
     *
     * An absent message (`resolveFinalAssistantMessage` returning `null`) is
     * never treated as settled on its own: it means the assistant row hasn't
     * projected yet, not that the turn produced none, so `null === null` across
     * two reads must keep polling rather than return early. A genuinely
     * message-less completed turn is indistinguishable from this in-flight gap
     * until the bound below is exhausted — that is the correct, if slower,
     * outcome, since guessing wrong here silently drops the rest of the epic's
     * backlog (`classifyIteration` treats a spurious `null` as a protocol
     * error, and three of those trip `maxConsecutiveFailures`).
     *
     * Bounded: a provider that never stops rewriting the message — or one
     * whose turn truly ends with no assistant row — would otherwise hold the
     * loop here forever, so after `MAX_SETTLE_READS` the last read is used
     * as-is and classification decides what it means.
     *
     * That base bound is short because a rewriting provider is still working.
     * A *completed* turn with no assistant row at all is a different wait: the
     * only outstanding work is ingestion's own finalize, so the wait extends to
     * `MAX_ABSENT_MESSAGE_SETTLE_READS` for as long as the turn keeps reading
     * back completed. The extension is why the exhausted flag below means
     * something: when even that runs out, the absence has been watched for as
     * long as it is worth watching.
     */
    const readSettledFinalMessage = (threadId: ThreadId, policy: EpicRunnerPolicy) =>
      Effect.gen(function* () {
        const read = projectionSnapshotQuery.getThreadDetailSnapshot(threadId).pipe(
          Effect.map(Option.getOrUndefined),
          Effect.catchCause((cause) =>
            Effect.logWarning("epic.runner.snapshot-read-failed", { threadId, cause }).pipe(
              Effect.as(undefined),
            ),
          ),
        );

        let previous = yield* read;
        // Raised, in the loop, the first time a completed turn reads back with
        // no assistant row — the one absence worth waiting out.
        let maxReads = MAX_SETTLE_READS;
        let watchedCompletedTurnWithoutMessage = false;
        for (let attempt = 0; attempt < maxReads; attempt += 1) {
          yield* Effect.sleep(Duration.millis(policy.quietPeriodMs));
          const current = yield* read;
          const previousMessage = resolveFinalAssistantMessage(previous?.thread);
          const currentMessage = resolveFinalAssistantMessage(current?.thread);
          if (
            currentMessage !== null &&
            previousMessage?.text === currentMessage.text &&
            previousMessage?.streaming === currentMessage.streaming
          ) {
            return { snapshot: current, messageWaitExhausted: false };
          }
          if (currentMessage === null && iterationTurnState(current?.thread) === "completed") {
            watchedCompletedTurnWithoutMessage = true;
            maxReads = MAX_ABSENT_MESSAGE_SETTLE_READS;
          }
          previous = current;
        }
        const settledMessage = resolveFinalAssistantMessage(previous?.thread);
        yield* Effect.logWarning("epic.runner.final-message-never-settled", {
          threadId,
          messageProjected: settledMessage !== null,
        });
        return {
          snapshot: previous,
          messageWaitExhausted: watchedCompletedTurnWithoutMessage && settledMessage === null,
        };
      });

    const classifyFromProjection = (input: {
      readonly threadId: ThreadId;
      readonly cwd: string;
      readonly headBefore: string | null;
      readonly timedOut: boolean;
      readonly policy: EpicRunnerPolicy;
    }) =>
      Effect.gen(function* () {
        const headAfter = yield* readHeadCommit(input.cwd);
        const committed = headAfter !== null && headAfter !== input.headBefore;
        // A timed-out turn was just interrupted and may still be streaming, so
        // there is nothing to wait for — and `classifyIteration` ignores the
        // message for a timeout anyway.
        const settled = input.timedOut
          ? { snapshot: undefined, messageWaitExhausted: false }
          : yield* readSettledFinalMessage(input.threadId, input.policy);
        const thread = settled.snapshot?.thread;

        return classifyIteration({
          // Falls back to the session status when the turn pointer is missing —
          // see `iterationTurnState`.
          turnState: iterationTurnState(thread),
          finalMessage: resolveFinalAssistantMessage(thread),
          finalMessageWaitExhausted: settled.messageWaitExhausted,
          sessionLastError: thread?.session?.lastError ?? null,
          committed,
          timedOut: input.timedOut,
        });
      });

    const runIteration = (input: {
      readonly run: EpicRun;
      readonly iterationIndex: number;
      readonly policy: EpicRunnerPolicy;
    }): Effect.Effect<RunIterationResult, EpicRunnerError> =>
      Effect.gen(function* () {
        const run = input.run;
        const selection = yield* selectReadyChild(run);
        if (selection._tag === "empty") {
          return {
            _tag: "classified" as const,
            outcome: { kind: "backlog-empty", detail: null, report: null },
            noCommitChildClosed: false,
            providerTurnDispatched: false,
          };
        }
        // Deterministic, and unique because iteration indices are never reused:
        // a crash cannot leave two threads competing for one iteration row. The
        // shape is a contract — the sidebar parses it back to fold a run's
        // iterations into one row — so it is built by the shared helper.
        const threadId = ThreadId.make(
          epicRunIterationThreadId({ runId: run.runId, iterationIndex: input.iterationIndex }),
        );
        const startedAt = yield* nowIso;

        if (selection._tag === "unrecognised") {
          const detail = `bd ready returned no usable child for ${run.epicId}; candidates: ${selection.candidateIds.join(", ")}`;
          yield* Effect.logError("epic.runner.ready-unrecognised", {
            runId: run.runId,
            epicId: run.epicId,
            iterationIndex: input.iterationIndex,
            candidateIds: selection.candidateIds,
          });
          // Keep the same append-then-update discipline as an ordinary turn.
          // This synthetic row records the failed selection, but issueId null
          // prevents it from becoming a public thread reference.
          yield* store
            .appendIteration({
              runId: run.runId,
              iterationIndex: input.iterationIndex,
              threadId,
              issueId: null,
              turnStatus: "running",
              summary: null,
              why: null,
              failureReason: null,
              startedAt,
              finishedAt: null,
            })
            .pipe(Effect.mapError(storeError("appendIteration")));
          yield* store
            .updateIteration({
              runId: run.runId,
              iterationIndex: input.iterationIndex,
              turnStatus: "failed",
              summary: detail,
              why: null,
              failureReason: "infra:ready-unrecognised",
              finishedAt: yield* nowIso,
            })
            .pipe(Effect.mapError(storeError("updateIteration")));
          return {
            _tag: "ready-unrecognised" as const,
            candidateIds: selection.candidateIds,
            detail,
            providerTurnDispatched: false,
          };
        }

        const issueId = selection.issueId;
        const worktreePath = yield* resolveIterationWorktreePath(run);
        const checkoutPath = worktreePath ?? run.cwd;
        const epicContext = yield* readEpicDescription(run.cwd, run.epicId);
        const orientationCard = yield* readOrientationCard(checkoutPath, run.orientationFile);
        const headBefore = yield* readHeadCommit(run.cwd);
        const initialWorktreeFingerprint = yield* readWorktreeFingerprint(run.cwd);
        const issueEvidenceBefore = yield* readIssueEvidence(run.cwd, issueId);
        const commentsBefore = issueEvidenceBefore.commentCount;
        const isResearchChild = yield* readIssueIsResearch(
          run.cwd,
          issueId,
          issueEvidenceBefore.title,
        );

        // Write-ahead, per the store's crash-safe ordering contract: the
        // iteration row — carrying its threadId — exists before the turn is
        // dispatched, so a crash in between leaves a visible `running`
        // iteration rather than a turn nobody knows about.
        yield* store
          .appendIteration({
            runId: run.runId,
            iterationIndex: input.iterationIndex,
            threadId,
            issueId,
            turnStatus: "running",
            summary: null,
            why: null,
            failureReason: null,
            startedAt,
            finishedAt: null,
          })
          .pipe(Effect.mapError(storeError("appendIteration")));

        // Charge a dispatch from a fresh row inside the transition lock. This
        // preserves a concurrent status change and prevents restart/cancel
        // reconciliation from charging the same provider turn again.
        const dispatchedRun = yield* withTransition(
          Effect.gen(function* () {
            const current = yield* requireRun(run.runId);
            const next = {
              ...current,
              currentThreadId: threadId,
              currentTurnStartedAt: startedAt,
              iterationsDispatched: current.iterationsDispatched + 1,
              updatedAt: startedAt,
            };
            yield* saveRun(next);
            return next;
          }),
        );

        const dispatchTurn = Effect.gen(function* () {
          // `OrchestrationEngine.dispatch` ignores a turn command's `bootstrap`
          // block — that path lives only in the websocket handler (`ws.ts:844`)
          // — so the runner creates the thread itself.
          yield* dispatchCommand({
            type: "thread.create",
            commandId: yield* commandId("thread-create"),
            threadId,
            projectId: dispatchedRun.projectId,
            title: `${run.epicId} · iteration ${input.iterationIndex + 1}`,
            modelSelection: dispatchedRun.modelSelection,
            runtimeMode: dispatchedRun.runtimeMode,
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            branch: null,
            worktreePath,
            createdAt: startedAt,
          });
          yield* dispatchCommand({
            type: "thread.turn.start",
            commandId: yield* commandId("turn-start"),
            threadId,
            message: {
              messageId: MessageId.make(`${threadId}-prompt`),
              role: "user",
              text: assembleIterationPrompt({
                basePrompt: dispatchedRun.prompt,
                issueId,
                epicContext,
                orientationCard,
              }),
              attachments: [],
            },
            modelSelection: dispatchedRun.modelSelection,
            runtimeMode: dispatchedRun.runtimeMode,
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            createdAt: startedAt,
          });
        });

        const settleIteration = dispatchTurn.pipe(
          Effect.flatMap(() => awaitTurnEnd(threadId, input.policy)),
          // A normally-settled turn may still have subagents working because
          // the agent ended its turn early. Drain and resume as many times as
          // the nested workflow needs. One timeout covers the original turn
          // and every continuation, so each cycle cannot reset the bound.
          Effect.flatMap(() =>
            graceContinuationForSubagents({
              run,
              iterationIndex: input.iterationIndex,
              threadId,
              headBefore,
              initialWorktreeFingerprint,
              policy: input.policy,
            }),
          ),
        );
        const boundedIteration =
          input.policy.iterationTimeoutMs === null
            ? settleIteration
            : settleIteration.pipe(
                Effect.timeoutOption(Duration.millis(input.policy.iterationTimeoutMs)),
                Effect.map(
                  (result): IterationSettleResult =>
                    Option.isNone(result) ? { _tag: "timeout" } : result.value,
                ),
              );
        const settleResult: IterationSettleResult = yield* boundedIteration.pipe(
          Effect.catch((error: EpicRunnerError) =>
            Effect.succeed<IterationSettleResult>({
              _tag: "dispatch-failed",
              detail: error.message,
            }),
          ),
        );

        if (settleResult._tag === "timeout") {
          yield* dispatchBestEffort("epic.runner.interrupt-failed", {
            type: "thread.turn.interrupt",
            commandId: yield* commandId("turn-interrupt"),
            threadId,
            createdAt: yield* nowIso,
          });
        }

        const outcome: EpicIterationOutcome =
          settleResult._tag === "dispatch-failed"
            ? { kind: "error", detail: settleResult.detail, report: null }
            : yield* classifyFromProjection({
                threadId,
                cwd: run.cwd,
                headBefore,
                timedOut: settleResult._tag === "timeout",
                policy: input.policy,
              });

        const finishedAt = yield* nowIso;

        // Settlement is user-owned. EpicRunner only releases the provider
        // session after an iteration ends. Normal cleanup uses an atomic
        // subagent guard. The advisory drain reduces refusals, but cannot
        // authorize the stop. A subagent can start after any read.
        // Timeout and dispatch-failure paths remain forced stops; the timeout
        // interrupt above always precedes its stop.
        if (settleResult._tag === "settled") {
          yield* awaitSubagentDrain(threadId, input.policy);
        }
        const normalStop = {
          type: "thread.session.stop",
          commandId: yield* commandId("session-stop"),
          threadId,
          createdAt: finishedAt,
          preserveRunningSubagents: true,
        } as const;
        if (settleResult._tag !== "settled") {
          yield* dispatchBestEffort("epic.runner.session-stop-failed", {
            type: "thread.session.stop",
            commandId: normalStop.commandId,
            threadId,
            createdAt: finishedAt,
          });
        } else {
          yield* dispatchCommand(normalStop).pipe(
            Effect.catch((error) => {
              if (!isRunningSubagentLivenessRefusal(error.message)) {
                return Effect.logWarning("epic.runner.session-stop-failed", { cause: error });
              }
              return Effect.gen(function* () {
                yield* awaitSubagentDrain(threadId, input.policy);
                yield* dispatchBestEffort("epic.runner.guarded-session-stop-retry-failed", {
                  ...normalStop,
                  commandId: yield* commandId("session-stop-retry"),
                });
              });
            }),
          );
        }

        // A turn that ends cleanly with no commit only counts as completed
        // when the agent both closed its child and added bead evidence after
        // dispatch. Research children use a distinct failure reason because
        // findings are their required deliverable. An unreadable settlement
        // cannot prove either condition and is rejected conservatively.
        const issueEvidenceAfter =
          outcome.kind === "no-commit" ? yield* readIssueEvidence(run.cwd, issueId) : null;
        const evidenceVerdict =
          issueEvidenceAfter === null
            ? null
            : noCommitEvidenceVerdict({
                status: issueEvidenceAfter.status,
                isResearch: isResearchChild,
                commentsBefore,
                commentsAfter: issueEvidenceAfter.commentCount,
              });
        const noCommitChildClosed = evidenceVerdict?.accepted ?? false;

        const iterationStatus =
          outcome.kind === "backlog-empty" || outcome.kind === "done" || noCommitChildClosed
            ? "completed"
            : "failed";
        const failureReason = persistedFailureReason({
          iterationStatus,
          dispatchFailed: settleResult._tag === "dispatch-failed",
          evidenceFailureReason: evidenceVerdict?.failureReason ?? null,
          outcome,
        });

        yield* store
          .updateIteration({
            runId: run.runId,
            iterationIndex: input.iterationIndex,
            turnStatus: iterationStatus,
            summary: outcome.report?.summary ?? outcome.detail,
            why: outcome.report?.why ?? null,
            failureReason,
            finishedAt,
          })
          .pipe(Effect.mapError(storeError("updateIteration")));

        // A failed iteration usually strands its claim: the agent ran
        // `bd update <id> --claim` and never closed the child, and `bd ready`
        // filters on status, so the next iteration would silently skip this
        // child — or read an empty frontier — while the run keeps looping.
        // Reopen it here so a retry can re-select the same child.
        // `releaseClaimedChild` re-reads the issue and no-ops when the agent
        // closed it. `done` outcomes are left to the terminal sweep
        // (`releaseStrandedChild`), which owns the done-with-unclosed-child
        // case (t3code-1bk); a classified `backlog-empty` ends the run, so the
        // same sweep covers it.
        if (outcome.kind !== "done" && outcome.kind !== "backlog-empty") {
          yield* releaseClaimedChild(run.cwd, issueId);
        }

        yield* Effect.logInfo("epic.runner.iteration-finished", {
          runId: run.runId,
          iterationIndex: input.iterationIndex,
          threadId,
          outcome: outcome.kind,
          detail: outcome.detail,
        });

        return {
          _tag: "classified",
          outcome,
          noCommitChildClosed,
          providerTurnDispatched: true,
        };
      });

    const runLoop = (runId: EpicRunId): Effect.Effect<void, EpicRunnerError> =>
      Effect.gen(function* () {
        const initialRun = yield* requireRun(runId);
        const policy = makeEpicRunnerPolicy(policySeed, initialRun);
        while (true) {
          const run = yield* withTransition(
            Effect.gen(function* () {
              const current = yield* requireRun(runId);
              if (current.status !== "running") {
                liveLoops.delete(runId);
                yield* Effect.logInfo("epic.runner.loop-stopped", {
                  runId,
                  status: current.status,
                });
                return null;
              }
              if (current.iterationsDispatched >= policy.maxIterations) {
                liveLoops.delete(runId);
                yield* saveRun({
                  ...current,
                  status: "done",
                  currentThreadId: null,
                  currentTurnStartedAt: null,
                  lastError: `max iterations (${policy.maxIterations}) reached`,
                  updatedAt: yield* nowIso,
                });
                return null;
              }
              return current;
            }),
          );
          if (run === null) return;

          const latest = yield* store
            .getLatestIteration({ runId })
            .pipe(Effect.mapError(storeError("getLatestIteration")));
          const iterationIndex = Option.isSome(latest) ? latest.value.iterationIndex + 1 : 0;

          const iterationResult = yield* runIteration({ run, iterationIndex, policy });

          const boundary = yield* withTransition(
            Effect.gen(function* () {
              // Re-read rather than writing back the snapshot taken before the
              // iteration: `pauseRun`/`cancelRun`/`resumeRun` may have changed the
              // status while the turn was in flight, and building the
              // post-iteration row from the stale copy would silently resurrect
              // the run as `running` — or bury a resume that arrived while this
              // iteration was draining.
              const currentRun = yield* requireRun(runId);
              let settledRun = {
                ...currentRun,
                currentThreadId: null,
                currentTurnStartedAt: null,
                iterationsCompleted: currentRun.iterationsCompleted + 1,
                updatedAt: yield* nowIso,
              };

              if (iterationResult._tag === "ready-unrecognised") {
                liveLoops.delete(runId);
                if (currentRun.status !== "running") {
                  // A concurrent pause or cancel owns the run state even
                  // though the selection anomaly is already persisted.
                  yield* saveRun(settledRun);
                  yield* Effect.logInfo("epic.runner.loop-stopped", {
                    runId,
                    status: currentRun.status,
                  });
                  return LOOP_STOP;
                }
                yield* saveRun({
                  ...settledRun,
                  status: "failed",
                  lastError: iterationResult.detail,
                });
                return LOOP_STOP;
              }

              const { outcome, noCommitChildClosed, providerTurnDispatched } = iterationResult;

              const successfulProviderTurn =
                providerTurnDispatched &&
                (outcome.kind === "done" ||
                  outcome.kind === "backlog-empty" ||
                  noCommitChildClosed);
              if (successfulProviderTurn) {
                yield* store
                  .clearProviderDegradation({
                    providerInstanceId: currentRun.modelSelection.instanceId,
                  })
                  .pipe(Effect.mapError(storeError("clearProviderDegradation")));
              }

              let providerFallbackApplied = false;
              let providerFallbackLog: Record<string, unknown> | null = null;
              if (Option.isSome(providerRegistry)) {
                const providers = yield* providerRegistry.value.getProviders;
                const fallback = resolveEpicProviderFallback({
                  providers,
                  current: currentRun.modelSelection,
                  failureReason: outcome.failureReason,
                  providerFallbackEligible: outcome.providerFallbackEligible === true,
                });
                if (fallback !== null) {
                  const degradedAt = yield* nowIso;
                  yield* store
                    .upsertProviderDegradation({
                      providerInstanceId: currentRun.modelSelection.instanceId,
                      failureReason: outcome.failureReason ?? outcome.detail ?? outcome.kind,
                      degradedAt,
                    })
                    .pipe(Effect.mapError(storeError("upsertProviderDegradation")));
                  providerFallbackApplied = true;
                  settledRun = { ...settledRun, modelSelection: fallback };
                  providerFallbackLog = {
                    runId,
                    fromInstanceId: currentRun.modelSelection.instanceId,
                    fromModel: currentRun.modelSelection.model,
                    toInstanceId: fallback.instanceId,
                    toModel: fallback.model,
                    status: currentRun.status,
                  };
                }
              }

              const decision = decideIterationBoundary({
                runStatus: currentRun.status,
                consecutiveFailures: currentRun.consecutiveFailures,
                noCommitStreak: currentRun.noCommitStreak,
                infraStreak: currentRun.infraStreak,
                lastError: currentRun.lastError,
                outcome,
                noCommitChildClosed,
                providerFallbackApplied,
                providerTurnDispatched,
                limits: {
                  maxConsecutiveFailures: policy.maxConsecutiveFailures,
                  maxNoCommitStreak: policy.maxNoCommitStreak,
                  infraFailureBudget: policy.infraFailureBudget,
                  retryBaseDelayMs: policy.retryBaseDelayMs,
                  retryMaxDelayMs: policy.retryMaxDelayMs,
                },
              });
              yield* saveRun({
                ...settledRun,
                ...(decision.nextStatus === null ? {} : { status: decision.nextStatus }),
                consecutiveFailures: decision.nextConsecutiveFailures,
                noCommitStreak: decision.nextNoCommitStreak,
                infraStreak: decision.nextInfraStreak,
                lastError: decision.lastError,
              });
              if (providerFallbackLog !== null) {
                yield* Effect.logInfo("epic.runner.provider-fallback", providerFallbackLog);
              }

              if (decision.action === "stop") {
                liveLoops.delete(runId);
              }
              if (currentRun.status !== "running" && !providerFallbackApplied) {
                yield* Effect.logInfo("epic.runner.loop-stopped", {
                  runId,
                  status: currentRun.status,
                });
              }
              return decision.action === "stop"
                ? LOOP_STOP
                : ({ _tag: "continue", delayMs: decision.delayMs } satisfies LoopBoundary);
            }),
          );
          if (boundary._tag === "stop") return;
          // Outside the lock on purpose: a backoff is a wait, and pause, resume
          // and cancel must not queue behind it.
          if (boundary.delayMs > 0) yield* Effect.sleep(Duration.millis(boundary.delayMs));
        }
      });

    /** Best-effort terminal write for a loop that died on an unexpected error. */
    const markRunFailed = (runId: EpicRunId, detail: string) =>
      requireRun(runId).pipe(
        Effect.flatMap((run) =>
          nowIso.pipe(
            Effect.flatMap((updatedAt) =>
              saveRun({
                ...run,
                status: "failed",
                currentThreadId: null,
                currentTurnStartedAt: null,
                lastError: detail,
                updatedAt,
              }),
            ),
          ),
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning("epic.runner.mark-failed-failed", { runId, cause }),
        ),
      );

    const supervisedLoop = (runId: EpicRunId): Effect.Effect<void> =>
      runLoop(runId).pipe(
        Effect.catch((error: EpicRunnerError) =>
          Effect.logError("epic.runner.loop-failed", { runId, detail: error.message }).pipe(
            Effect.flatMap(() => markRunFailed(runId, error.message)),
          ),
        ),
        Effect.catchDefect((defect) =>
          Effect.logError("epic.runner.loop-defect", { runId, defect }).pipe(
            Effect.flatMap(() => markRunFailed(runId, String(defect))),
          ),
        ),
        // Fires on every terminal exit — normal completion, exhausted
        // failures, the no-commit gutter, an unhandled error/defect, and
        // interruption (cancel) — so this single finalizer is enough to
        // un-strand whatever child the run last claimed, without a release
        // call scattered across each of those outcomes.
        //
        // Dropping the live mark here is only a backstop: a loop that reaches
        // its own boundary drops it inside the critical section, before this
        // runs. Interruption and defects never get there.
        Effect.ensuring(
          Effect.sync(() => liveLoops.delete(runId)).pipe(
            Effect.andThen(releaseLease(runId)),
            Effect.andThen(releaseStrandedChild(runId)),
          ),
        ),
      );

    const forkLoop = (runId: EpicRunId) =>
      Effect.sync(() => liveLoops.add(runId)).pipe(
        Effect.andThen(FiberMap.run(loops, runId, supervisedLoop(runId))),
        Effect.asVoid,
      );

    /**
     * Wait for a loop that has committed to exiting to actually be gone.
     *
     * The lock is released in the loop's finalizer, after its last boundary
     * write, so a resume that relaunches the instant that write lands would
     * acquire against the run's *own* held lock and fail with
     * `run_in_progress`. Bounded, because a finalizer wedged on `bd` must not
     * hold the resume open — the acquire that follows reports the held lock
     * honestly instead.
     */
    const awaitLoopExit = (runId: EpicRunId) =>
      FiberMap.get(loops, runId).pipe(
        Effect.flatMap((fiber) =>
          Option.isSome(fiber) ? Effect.asVoid(Fiber.await(fiber.value)) : Effect.void,
        ),
        Effect.timeout(Duration.millis(LOOP_EXIT_WAIT_MS)),
        Effect.catchCause((cause) =>
          Effect.logWarning("epic.runner.loop-exit-wait-failed", { runId, cause }),
        ),
        Effect.asVoid,
      );

    const readConfigSnapshot = Effect.fn("EpicRunner.readConfigSnapshot")(function* (
      input: Pick<StartEpicRunInput, "cwd" | "config">,
    ) {
      const fileResult = yield* configSource.read({ repoRoot: input.cwd });
      return makeEpicRunConfigSnapshot({
        fileResult,
        override: input.config ?? null,
        harness: null,
      });
    });

    const persistedConfigSnapshot = (run: EpicRun): EpicRunConfigSnapshot => ({
      fileResult: { _tag: "absent" },
      config: run.config,
      provenance: run.configProvenance,
      violations: [],
    });

    const applyLegacyIterationCap = (
      configSnapshot: EpicRunConfigSnapshot,
      maxIterations: number | undefined,
    ): EpicRunConfigSnapshot =>
      maxIterations === undefined ||
      hasConfiguredValue(configSnapshot.provenance, "limits.maxIterations")
        ? configSnapshot
        : {
            ...configSnapshot,
            config: {
              ...configSnapshot.config,
              limits: {
                ...configSnapshot.config.limits,
                maxIterations: Math.max(1, Math.trunc(maxIterations)),
              },
            },
            provenance: {
              ...configSnapshot.provenance,
              "limits.maxIterations": "override",
            },
          };

    const startNewRun = Effect.fn("EpicRunner.startNewRun")(function* (
      input: StartEpicRunInput,
      configSnapshot: EpicRunConfigSnapshot,
      modelSelectionAlreadyResolved = false,
    ) {
      const orientationFile = input.orientationFile ?? null;
      if (orientationFile !== null && !isValidOrientationFile(orientationFile)) {
        return yield* new EpicRunLaunchError({ reason: "orientation_file_invalid" });
      }

      const runId = EpicRunId.make(yield* crypto.randomUUIDv4.pipe(Effect.orDie));
      const createdAt = yield* nowIso;
      const configuredModelSelection = configSnapshot.config.provider.modelSelection;
      const modelSelection =
        !modelSelectionAlreadyResolved &&
        configuredModelSelection !== null &&
        hasConfiguredValue(configSnapshot.provenance, "provider.modelSelection")
          ? configuredModelSelection
          : input.modelSelection;
      const runtimeMode = hasConfiguredValue(configSnapshot.provenance, "runtime.mode")
        ? configSnapshot.config.runtime.mode
        : (input.runtimeMode ?? DEFAULT_RUNTIME_MODE);
      const maxIterations = hasConfiguredValue(configSnapshot.provenance, "limits.maxIterations")
        ? configSnapshot.config.limits.maxIterations
        : (input.maxIterations ?? configSnapshot.config.limits.maxIterations);
      const run: EpicRun = {
        runId,
        epicId: input.epicId,
        projectId: input.projectId,
        cwd: input.cwd,
        prompt: input.prompt,
        orientationFile,
        modelSelection,
        runtimeMode,
        config: configSnapshot.config,
        configProvenance: configSnapshot.provenance,
        // Only ever what the launcher supplied: the run's own iteration
        // threads are children, so they can never stand in for an origin.
        originThreadId: input.originThreadId ?? null,
        status: "running",
        maxIterations: Math.max(1, Math.trunc(maxIterations)),
        iterationsCompleted: 0,
        iterationsDispatched: 0,
        currentThreadId: null,
        currentTurnStartedAt: null,
        consecutiveFailures: 0,
        noCommitStreak: 0,
        infraStreak: 0,
        lastError: null,
        createdAt,
        updatedAt: createdAt,
      };

      const acquireError = yield* acquireLease(runId, input, configSnapshot).pipe(
        Effect.match({
          onFailure: (error) => error,
          onSuccess: () => null,
        }),
      );
      if (acquireError !== null) {
        if (acquireError._tag === "EpicRunLeaseHeld") {
          const winner = yield* awaitActiveRun(input);
          if (winner !== undefined) {
            return yield* enrichRun(winner);
          }
          return yield* acquireError.mappedError;
        }
        return yield* acquireError;
      }
      yield* saveRun(run).pipe(releaseLeaseOnFailure(runId));
      yield* forkLoop(runId).pipe(releaseLeaseOnFailure(runId));
      yield* Effect.logInfo("epic.runner.run-started", {
        runId,
        epicId: run.epicId,
        cwd: run.cwd,
        maxIterations: run.maxIterations,
      });
      return yield* enrichRun(run);
    });

    const startRun: EpicRunnerShape["startRun"] = (input: StartEpicRunInput) =>
      Effect.gen(function* () {
        const orientationFile = input.orientationFile ?? null;
        if (orientationFile !== null && !isValidOrientationFile(orientationFile)) {
          return yield* new EpicRunLaunchError({ reason: "orientation_file_invalid" });
        }
        const active = yield* findActiveRun(input);
        if (active !== undefined) {
          return yield* enrichRun(active);
        }
        const configSnapshot = applyLegacyIterationCap(
          yield* readConfigSnapshot(input),
          input.maxIterations,
        );
        return yield* startNewRun(input, configSnapshot);
      });

    const resolveLaunchModelSelection = (
      defaultSelection: ModelSelection,
    ): Effect.Effect<ModelSelection, EpicRunnerError> =>
      Effect.gen(function* () {
        // Registry absence keeps the configured default. Automatic fallback
        // needs the registry to reuse the normal eligibility checks.
        if (Option.isNone(providerRegistry)) return defaultSelection;
        const providers = yield* providerRegistry.value.getProviders;
        const checkedAt = yield* DateTime.now;
        const cutoff = DateTime.formatIso(
          DateTime.subtractDuration(checkedAt, Duration.millis(providerDegradationTtlMs)),
        );
        let selection = defaultSelection;

        while (true) {
          const degradation = yield* store
            .getProviderDegradation({ providerInstanceId: selection.instanceId })
            .pipe(Effect.mapError(storeError("getProviderDegradation")));
          if (Option.isNone(degradation)) return selection;

          if (degradation.value.degradedAt <= cutoff) {
            // The predicate is repeated by SQL. A newer replacement written
            // after this read is therefore safe from this cleanup.
            yield* store
              .clearExpiredProviderDegradation({
                providerInstanceId: selection.instanceId,
                cutoff,
              })
              .pipe(Effect.mapError(storeError("clearExpiredProviderDegradation")));
            return selection;
          }

          const fallback = resolveEpicProviderFallback({
            providers,
            current: selection,
            failureReason: "provider-error",
            providerFallbackEligible: true,
          });
          if (fallback === null) return selection;
          yield* Effect.logInfo("epic.runner.launch-provider-fallback", {
            fromInstanceId: selection.instanceId,
            toInstanceId: fallback.instanceId,
            reason: degradation.value.failureReason,
          });
          selection = fallback;
        }
      });

    const launchRun: EpicRunnerShape["launchRun"] = (input: LaunchEpicRunInput) =>
      Effect.gen(function* () {
        const active = yield* findActiveRun(input);
        if (active !== undefined) {
          return yield* enrichRun(active);
        }
        const project = yield* projectionSnapshotQuery
          .getProjectShellById(input.projectId)
          .pipe(Effect.mapError(storeError("getProjectShellById")));
        if (Option.isNone(project)) {
          return yield* new EpicRunLaunchError({ reason: "project_not_found" });
        }
        if (project.value.workspaceRoot !== input.cwd) {
          return yield* new EpicRunLaunchError({ reason: "cwd_mismatch" });
        }
        const configSnapshot = yield* readConfigSnapshot(input);
        const configuredModelSelection = configSnapshot.config.provider.modelSelection;
        const selectedModel =
          configuredModelSelection !== null &&
          hasConfiguredValue(configSnapshot.provenance, "provider.modelSelection")
            ? configuredModelSelection
            : project.value.defaultModelSelection;
        if (selectedModel === null) {
          return yield* new EpicRunLaunchError({ reason: "model_default_missing" });
        }
        const modelSelection = yield* resolveLaunchModelSelection(selectedModel);
        return yield* startNewRun(
          {
            ...input,
            prompt: EPIC_RUN_ITERATION_PROMPT,
            orientationFile: null,
            modelSelection,
            runtimeMode: DEFAULT_RUNTIME_MODE,
          },
          configSnapshot,
          true,
        );
      });

    const pauseRun: EpicRunnerShape["pauseRun"] = ({ runId }) =>
      Effect.gen(function* () {
        const paused = yield* withTransition(
          Effect.gen(function* () {
            const run = yield* requireRun(runId);
            if (run.status !== "running") {
              return yield* new EpicRunStateError({
                runId,
                detail: `cannot pause a ${run.status} run`,
              });
            }
            const next: EpicRun = { ...run, status: "paused", updatedAt: yield* nowIso };
            // No interrupt: the loop re-reads the run before each iteration and
            // exits at that boundary, so the turn in flight finishes its unit of
            // work rather than leaving the repo and backlog half-done.
            yield* saveRun(next);
            return next;
          }),
        );
        return yield* enrichRun(paused);
      });

    const resumeRun: EpicRunnerShape["resumeRun"] = ({ runId }) =>
      Effect.gen(function* () {
        const handoff = yield* withTransition(
          Effect.gen(function* () {
            const run = yield* requireRun(runId);
            if (run.status !== "paused") {
              return yield* new EpicRunStateError({
                runId,
                detail: `cannot resume a ${run.status} run`,
              });
            }
            const resumed: EpicRun = {
              ...run,
              status: "running",
              consecutiveFailures: 0,
              noCommitStreak: 0,
              infraStreak: 0,
              lastError: null,
              updatedAt: yield* nowIso,
            };
            // A pause takes effect at the next iteration boundary, so the loop
            // can still be draining the iteration that was in flight — holding
            // this run's own lock for as long as an agent turn lasts.
            // Relaunching there would run launch preflight against that lock
            // and refuse the resume as `run_in_progress`. Flip the status
            // instead and let the live loop pick it up when it looks again.
            if (liveLoops.has(runId)) {
              yield* saveRun(resumed);
              return { run: resumed, relaunch: false } as const;
            }
            // A stopped run stays durably paused until its lease is acquired.
            // Failed preflight or acquisition must leave it resumable.
            return { run, relaunch: true } as const;
          }),
        );
        if (!handoff.relaunch) return yield* enrichRun(handoff.run);

        yield* awaitLoopExit(runId);
        yield* acquireLease(
          runId,
          { cwd: handoff.run.cwd, epicId: handoff.run.epicId },
          persistedConfigSnapshot(handoff.run),
        ).pipe(
          Effect.mapError((error) =>
            error._tag === "EpicRunLeaseHeld" ? error.mappedError : error,
          ),
        );
        const relaunched = yield* withTransition(
          Effect.gen(function* () {
            const fresh = yield* requireRun(runId);
            if (fresh.status !== "paused") {
              return { run: fresh, forked: false } as const;
            }
            const resumed: EpicRun = {
              ...fresh,
              status: "running",
              consecutiveFailures: 0,
              noCommitStreak: 0,
              infraStreak: 0,
              lastError: null,
              updatedAt: yield* nowIso,
            };
            yield* saveRun(resumed);
            yield* forkLoop(runId);
            return { run: resumed, forked: true } as const;
          }),
        ).pipe(releaseLeaseOnFailure(runId));
        if (!relaunched.forked) {
          yield* releaseLease(runId);
        }
        return yield* enrichRun(relaunched.run);
      });

    const cancelRun: EpicRunnerShape["cancelRun"] = ({ runId }) =>
      Effect.gen(function* () {
        const transition = yield* withTransition(
          Effect.gen(function* () {
            const fresh = yield* requireRun(runId);
            if (
              fresh.status === "done" ||
              fresh.status === "failed" ||
              fresh.status === "cancelled"
            ) {
              return yield* new EpicRunStateError({
                runId,
                detail: `run already ${fresh.status}`,
              });
            }
            const cancelledAt = yield* nowIso;
            const cancelled: EpicRun = {
              ...fresh,
              status: "cancelled",
              currentThreadId: null,
              currentTurnStartedAt: null,
              updatedAt: cancelledAt,
            };
            yield* saveRun(cancelled);
            return { cancelled, cancelledAt, threadId: fresh.currentThreadId } as const;
          }),
        );

        const { cancelled, cancelledAt, threadId } = transition;
        // Cancellation is durable before loop interruption. The loop either
        // observes the cancelled row at its boundary or is interrupted here,
        // while its lease remains held until the cancelled state is visible.
        yield* FiberMap.remove(loops, runId);

        if (threadId !== null) {
          yield* dispatchBestEffort("epic.runner.cancel-interrupt-failed", {
            type: "thread.turn.interrupt",
            commandId: yield* commandId("cancel-interrupt"),
            threadId,
            createdAt: cancelledAt,
          });
          yield* dispatchBestEffort("epic.runner.cancel-session-stop-failed", {
            type: "thread.session.stop",
            commandId: yield* commandId("cancel-session-stop"),
            threadId,
            createdAt: cancelledAt,
          });
        }

        // The interrupted loop never got to close its iteration row out.
        const latest = yield* store
          .getLatestIteration({ runId })
          .pipe(Effect.mapError(storeError("getLatestIteration")));
        if (Option.isSome(latest) && latest.value.turnStatus === "running") {
          yield* store
            .updateIteration({
              runId,
              iterationIndex: latest.value.iterationIndex,
              turnStatus: "abandoned",
              summary: "cancelled",
              why: null,
              failureReason: "cancelled",
              finishedAt: cancelledAt,
            })
            .pipe(Effect.mapError(storeError("updateIteration")));
        }

        yield* releaseLease(runId);
        return yield* enrichRun(cancelled);
      });

    const listRuns: EpicRunnerShape["listRuns"] = (input) =>
      store
        .listRuns(input ?? {})
        .pipe(Effect.mapError(storeError("listRuns")), Effect.flatMap(enrichRuns));

    const getRun: EpicRunnerShape["getRun"] = ({ runId }) =>
      store.getRun({ runId }).pipe(
        Effect.mapError(storeError("getRun")),
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.succeed(Option.none<TransportEpicRun>()),
            onSome: (run) => enrichRun(run).pipe(Effect.map(Option.some)),
          }),
        ),
      );

    const streamRuns = Stream.unwrap(
      Effect.map(PubSub.subscribe(changes), (subscription) =>
        Stream.fromSubscription(subscription),
      ),
    );

    const start: EpicRunnerShape["start"] = () =>
      Effect.gen(function* () {
        const running = yield* store
          .listRuns({ status: "running" })
          .pipe(Effect.mapError(storeError("listRuns")));

        for (const run of running) {
          const acquireError = yield* acquireLease(
            run.runId,
            { cwd: run.cwd, epicId: run.epicId },
            persistedConfigSnapshot(run),
          ).pipe(
            Effect.match({
              onFailure: (error) => error,
              onSuccess: () => null,
            }),
          );
          if (acquireError !== null) {
            const error =
              acquireError._tag === "EpicRunLeaseHeld" ? acquireError.mappedError : acquireError;
            yield* saveRun({
              ...run,
              status: "failed",
              lastError: error.message,
              updatedAt: yield* nowIso,
            });
            // This run's loop never gets a chance to fork, so its finalizer
            // never runs either — release its last claimed child here, or a
            // lost lease strands it exactly like the failure path this fixes.
            yield* releaseStrandedChild(run.runId);
            continue;
          }
          yield* Effect.gen(function* () {
            // An iteration still recorded as `running` at boot is by definition
            // abandoned. A child-backed row had a provider subprocess that the
            // restart killed. A null-issue synthetic selection row had no turn,
            // but can occupy the append-before-update crash window. The status
            // is the sole in-flight marker, so both rows must be reconciled.
            const latest = yield* store
              .getLatestIteration({ runId: run.runId })
              .pipe(Effect.mapError(storeError("getLatestIteration")));
            if (Option.isSome(latest) && latest.value.turnStatus === "running") {
              const abandonedAt = yield* nowIso;
              if (latest.value.issueId !== null) {
                yield* dispatchBestEffort("epic.runner.restart-interrupt-failed", {
                  type: "thread.turn.interrupt",
                  commandId: yield* commandId("restart-interrupt"),
                  threadId: latest.value.threadId,
                  createdAt: abandonedAt,
                });
                yield* dispatchBestEffort("epic.runner.restart-session-stop-failed", {
                  type: "thread.session.stop",
                  commandId: yield* commandId("restart-session-stop"),
                  threadId: latest.value.threadId,
                  createdAt: abandonedAt,
                });
              }
              yield* store
                .updateIteration({
                  runId: run.runId,
                  iterationIndex: latest.value.iterationIndex,
                  turnStatus: "abandoned",
                  summary: "abandoned by server restart",
                  why: null,
                  failureReason: "server-restart",
                  finishedAt: abandonedAt,
                })
                .pipe(Effect.mapError(storeError("updateIteration")));
              // The abandoned iteration's child is claimed with nothing left
              // to finish it; release it so `bd ready` can resurface it once
              // the resumed loop below reaches its next selectReadyChild.
              if (latest.value.issueId !== null) {
                yield* releaseClaimedChild(run.cwd, latest.value.issueId);
              }
            }
            yield* forkLoop(run.runId);
          }).pipe(releaseLeaseOnFailure(run.runId));
        }

        yield* Effect.logInfo("epic.runner.started", {
          resumedRuns: running.length,
          iterationTimeoutMs: policySeed.iterationTimeoutMs,
          maxConsecutiveFailures: policySeed.maxConsecutiveFailures,
        });
      }).pipe(
        Effect.catch((error: EpicRunnerError) =>
          Effect.logError("epic.runner.start-failed", { detail: error.message }),
        ),
        Effect.catchDefect((defect) => Effect.logError("epic.runner.start-defect", { defect })),
      );

    return {
      start,
      startRun,
      launchRun,
      pauseRun,
      resumeRun,
      cancelRun,
      listRuns,
      getRun,
      streamRuns,
    } satisfies EpicRunnerShape;
  });

export const makeEpicRunnerLive = (options?: EpicRunnerLiveOptions) =>
  Layer.effect(EpicRunner, makeEpicRunner(options));

export const EpicRunnerLive = makeEpicRunnerLive();
