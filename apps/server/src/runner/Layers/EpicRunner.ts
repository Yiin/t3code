import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  type EpicRun as TransportEpicRun,
  EpicRunId,
  type LaunchEpicRunInput,
  MessageId,
  ThreadId,
  type OrchestrationSessionStatus,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { EpicRunPreflight } from "../../beads/EpicRunPreflight.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  EpicRunStore,
  type EpicRun,
  type EpicRunIterationStatus,
} from "../../persistence/Services/EpicRuns.ts";
import * as ProcessRunner from "../../processRunner.ts";
import { AgentAwarenessRelay } from "../../relay/AgentAwarenessRelay.ts";
import {
  EpicRunNotFoundError,
  EpicRunLaunchError,
  EpicRunPreflightBlockedError,
  EpicRunStateError,
  EpicRunnerDispatchError,
  EpicRunnerStoreError,
  type EpicRunnerError,
} from "../Errors.ts";
import { EpicRunLock, type EpicRunLockLease } from "../Services/EpicRunLock.ts";
import { classifyIteration, type EpicIterationOutcome } from "../ralphProtocol.ts";
import {
  EpicRunner,
  type EpicRunnerShape,
  type StartEpicRunInput,
} from "../Services/EpicRunner.ts";

/** Generous by default — a single unit of epic work can legitimately take hours. */
const DEFAULT_ITERATION_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_QUIET_PERIOD_MS = 1_000;
const DEFAULT_RETRY_BASE_DELAY_MS = 10_000;
const DEFAULT_RETRY_MAX_DELAY_MS = 5 * 60 * 1000;
const DEFAULT_MAX_CONSECUTIVE_FAILURES = 3;
const DEFAULT_MAX_NO_COMMIT_STREAK = 2;
const DEFAULT_MAX_ITERATIONS = 50;
const RECENT_ITERATIONS_LIMIT = 25;
export const EPIC_RUN_ITERATION_PROMPT = `Complete one well-scoped unit of work for this epic end-to-end. Use bd to select and claim the top-priority ready child, implement it, run the focused quality gates, commit and push, close the child, and update the epic progress note. Stop after one child. If no work remains, output RALPH_DONE. End a completed iteration with exactly one line: RALPH_MSG: {"summary":"<what you built, one clause>","why":"<why it was needed, one clause>"}`;
const GIT_HEAD_TIMEOUT_MS = 15_000;
const MAX_SETTLE_READS = 20;
const ACTIVE_RUN_RETRY_ATTEMPTS = 20;
const ACTIVE_RUN_RETRY_DELAY_MS = 5;
const ReadyChildren = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      id: Schema.String,
      parent: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  ),
);
const decodeReadyChildren = Schema.decodeUnknownEffect(ReadyChildren);
const decodeIssueTitle = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Union([
      Schema.Struct({ title: Schema.String }),
      Schema.Array(Schema.Struct({ title: Schema.String })),
    ]),
  ),
);
const decodeIssueStatus = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Union([
      Schema.Struct({ status: Schema.String }),
      Schema.Array(Schema.Struct({ status: Schema.String })),
    ]),
  ),
);

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

/**
 * Whether a session status settles the turn.
 *
 * Mirrors `settledTurnStateForSessionStatus`
 * (`orchestration/Layers/ProjectionPipeline.ts:78-94`) exactly. It is not
 * simply `status !== "running"`, and the difference matters: a fresh thread's
 * session is `"starting"` before its turn begins, which under that looser test
 * would end the turn before the agent had said a word.
 */
const isTurnEndSessionStatus = (status: OrchestrationSessionStatus): boolean => {
  switch (status) {
    case "idle":
    case "ready":
    case "error":
    case "interrupted":
    case "stopped":
      return true;
    case "starting":
    case "running":
      return false;
  }
};

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

/** How an iteration's turn stopped, before its output has been classified. */
type IterationSettleResult =
  | { readonly _tag: "settled" }
  | { readonly _tag: "timeout" }
  | { readonly _tag: "dispatch-failed"; readonly detail: string };

interface EpicRunLeaseHeld {
  readonly _tag: "EpicRunLeaseHeld";
  readonly mappedError: EpicRunPreflightBlockedError;
}

export interface EpicRunnerLiveOptions {
  readonly iterationTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly quietPeriodMs?: number;
  readonly retryBaseDelayMs?: number;
  readonly retryMaxDelayMs?: number;
  readonly maxConsecutiveFailures?: number;
  readonly maxNoCommitStreak?: number;
  readonly defaultMaxIterations?: number;
}

const makeEpicRunner = (options?: EpicRunnerLiveOptions) =>
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const store = yield* EpicRunStore;
    const processRunner = yield* ProcessRunner.ProcessRunner;
    const crypto = yield* Crypto.Crypto;
    const preflight = yield* EpicRunPreflight;
    const runLock = yield* EpicRunLock;
    const agentAwarenessRelay = yield* AgentAwarenessRelay;
    const leases = new Map<EpicRunId, EpicRunLockLease>();
    const issueTitleCache = new Map<string, string>();

    const iterationTimeoutMs = Math.max(
      1,
      options?.iterationTimeoutMs ?? DEFAULT_ITERATION_TIMEOUT_MS,
    );
    const pollIntervalMs = Math.max(1, options?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
    const quietPeriodMs = Math.max(1, options?.quietPeriodMs ?? DEFAULT_QUIET_PERIOD_MS);
    const retryBaseDelayMs = Math.max(1, options?.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS);
    const retryMaxDelayMs = Math.max(
      retryBaseDelayMs,
      options?.retryMaxDelayMs ?? DEFAULT_RETRY_MAX_DELAY_MS,
    );
    const maxConsecutiveFailures = Math.max(
      1,
      options?.maxConsecutiveFailures ?? DEFAULT_MAX_CONSECUTIVE_FAILURES,
    );
    const maxNoCommitStreak = Math.max(
      1,
      options?.maxNoCommitStreak ?? DEFAULT_MAX_NO_COMMIT_STREAK,
    );
    const defaultMaxIterations = Math.max(
      1,
      options?.defaultMaxIterations ?? DEFAULT_MAX_ITERATIONS,
    );

    const changes = yield* Effect.acquireRelease(PubSub.unbounded<TransportEpicRun>(), (pubsub) =>
      PubSub.shutdown(pubsub),
    );
    // Scoped to the layer, so every loop is interrupted on server shutdown and
    // no run keeps dispatching turns into a tearing-down orchestration engine.
    const loops = yield* FiberMap.make<EpicRunId, void, never>();

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
      const recentIterations = iterations.slice(-RECENT_ITERATIONS_LIMIT);
      return {
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
      } satisfies TransportEpicRun;
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
              const decoded = decodeIssueTitle(output.stdout);
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

    const selectReadyChild = (run: EpicRun): Effect.Effect<string | null, EpicRunnerError> =>
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
                const direct = value.find((issue) => issue.parent === run.epicId);
                return direct === undefined
                  ? Effect.succeed(null)
                  : direct.id.trim().length === 0
                    ? Effect.fail(
                        new EpicRunnerDispatchError({
                          commandType: "bd.ready",
                          detail: "Invalid bd ready output: first ready child has no id",
                        }),
                      )
                    : Effect.succeed(direct.id);
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
    const releaseClaimedChild = (cwd: string, issueId: string): Effect.Effect<void> =>
      processRunner.run({ command: "bd", args: ["show", issueId, "--json"], cwd }).pipe(
        Effect.flatMap((shown) => {
          if (shown.code !== 0) return Effect.void;
          const decoded = decodeIssueStatus(shown.stdout);
          if (Option.isNone(decoded)) return Effect.void;
          const value = Array.isArray(decoded.value) ? decoded.value[0] : decoded.value;
          if (value?.status !== "in_progress") return Effect.void;
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
    ) {
      const result = yield* preflight
        .check({
          workspaceRoot: input.cwd,
          epicId: input.epicId,
          mode: "sequential",
        })
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
        return yield* new EpicRunPreflightBlockedError({
          epicId: input.epicId,
          blockers: result.blockers.map((blocker) => blocker._tag),
        });
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
              blockers: [error._tag === "EpicRunLockHeldError" ? "run_in_progress" : error.message],
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
    const awaitTurnEnd = (threadId: ThreadId) =>
      Effect.gen(function* () {
        let observedActive = false;
        while (true) {
          const shell = yield* readThreadShell(threadId);
          const turnState = shell?.latestTurn?.state ?? null;
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

          yield* Effect.sleep(Duration.millis(pollIntervalMs));
        }
      });

    /**
     * Read the turn's final assistant message once it has stopped changing.
     *
     * The turn-end signal is not the read point: ingestion dispatches
     * `thread.session-set` at `ProviderRuntimeIngestion.ts:1435` but only
     * finalizes assistant messages at `:1637`, so reading immediately returns a
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
     */
    const readSettledFinalMessage = (threadId: ThreadId) =>
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
        for (let attempt = 0; attempt < MAX_SETTLE_READS; attempt += 1) {
          yield* Effect.sleep(Duration.millis(quietPeriodMs));
          const current = yield* read;
          const previousMessage = resolveFinalAssistantMessage(previous?.thread);
          const currentMessage = resolveFinalAssistantMessage(current?.thread);
          if (
            currentMessage !== null &&
            previousMessage?.text === currentMessage.text &&
            previousMessage?.streaming === currentMessage.streaming
          ) {
            return current;
          }
          previous = current;
        }
        yield* Effect.logWarning("epic.runner.final-message-never-settled", { threadId });
        return previous;
      });

    const classifyFromProjection = (input: {
      readonly threadId: ThreadId;
      readonly cwd: string;
      readonly headBefore: string | null;
      readonly timedOut: boolean;
    }) =>
      Effect.gen(function* () {
        const headAfter = yield* readHeadCommit(input.cwd);
        const committed = headAfter !== null && headAfter !== input.headBefore;
        // A timed-out turn was just interrupted and may still be streaming, so
        // there is nothing to wait for — and `classifyIteration` ignores the
        // message for a timeout anyway.
        const snapshot = input.timedOut
          ? undefined
          : yield* readSettledFinalMessage(input.threadId);

        return classifyIteration({
          turnState: snapshot?.thread.latestTurn?.state ?? null,
          finalMessage: resolveFinalAssistantMessage(snapshot?.thread),
          committed,
          timedOut: input.timedOut,
        });
      });

    const runIteration = (input: {
      readonly run: EpicRun;
      readonly iterationIndex: number;
    }): Effect.Effect<EpicIterationOutcome, EpicRunnerError> =>
      Effect.gen(function* () {
        const run = input.run;
        const issueId = yield* selectReadyChild(run);
        if (issueId === null) {
          return { kind: "backlog-empty", detail: null, report: null };
        }
        // Deterministic, and unique because iteration indices are never reused:
        // a crash cannot leave two threads competing for one iteration row.
        const threadId = ThreadId.make(`epic-run-${run.runId}-${input.iterationIndex}`);
        const startedAt = yield* nowIso;
        const headBefore = yield* readHeadCommit(run.cwd);

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
            startedAt,
            finishedAt: null,
          })
          .pipe(Effect.mapError(storeError("appendIteration")));

        yield* saveRun({
          ...run,
          currentThreadId: threadId,
          currentTurnStartedAt: startedAt,
          updatedAt: startedAt,
        });

        const worktreePath = yield* resolveIterationWorktreePath(run);

        const dispatchTurn = Effect.gen(function* () {
          // `OrchestrationEngine.dispatch` ignores a turn command's `bootstrap`
          // block — that path lives only in the websocket handler (`ws.ts:844`)
          // — so the runner creates the thread itself.
          yield* dispatchCommand({
            type: "thread.create",
            commandId: yield* commandId("thread-create"),
            threadId,
            projectId: run.projectId,
            title: `${run.epicId} · iteration ${input.iterationIndex + 1}`,
            modelSelection: run.modelSelection,
            runtimeMode: run.runtimeMode,
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
              text: `${run.prompt}\n\nCook exactly \`${issueId}\` this iteration.`,
              attachments: [],
            },
            modelSelection: run.modelSelection,
            runtimeMode: run.runtimeMode,
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            createdAt: startedAt,
          });
        });

        const settleResult: IterationSettleResult = yield* dispatchTurn.pipe(
          Effect.flatMap(() => awaitTurnEnd(threadId)),
          Effect.timeoutOption(Duration.millis(iterationTimeoutMs)),
          Effect.map(
            (result): IterationSettleResult =>
              Option.isNone(result) ? { _tag: "timeout" } : { _tag: "settled" },
          ),
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
              });

        const finishedAt = yield* nowIso;

        // Stop the session now instead of leaving it to the 30-minute reaper
        // (`provider/Layers/ProviderSessionReaper.ts:16`): an unattended run
        // would otherwise accumulate one idle provider subprocess per iteration.
        yield* dispatchBestEffort("epic.runner.session-stop-failed", {
          type: "thread.session.stop",
          commandId: yield* commandId("session-stop"),
          threadId,
          createdAt: finishedAt,
        });

        const iterationStatus: EpicRunIterationStatus =
          outcome.kind === "backlog-empty" ||
          outcome.kind === "done" ||
          outcome.kind === "no-commit"
            ? "completed"
            : "failed";

        yield* store
          .updateIteration({
            runId: run.runId,
            iterationIndex: input.iterationIndex,
            turnStatus: iterationStatus,
            summary: outcome.report?.summary ?? outcome.detail,
            why: outcome.report?.why ?? null,
            finishedAt,
          })
          .pipe(Effect.mapError(storeError("updateIteration")));

        yield* Effect.logInfo("epic.runner.iteration-finished", {
          runId: run.runId,
          iterationIndex: input.iterationIndex,
          threadId,
          outcome: outcome.kind,
          detail: outcome.detail,
        });

        return outcome;
      });

    const backoffDelayMs = (consecutiveFailures: number) =>
      Math.min(retryBaseDelayMs * 2 ** (consecutiveFailures - 1), retryMaxDelayMs);

    const runLoop = (runId: EpicRunId): Effect.Effect<void, EpicRunnerError> =>
      Effect.gen(function* () {
        // In-memory on purpose: the gutter rule guards against a loop spinning
        // *now*, and a resumed run deserves a clean slate.
        let noCommitStreak = 0;

        while (true) {
          const run = yield* requireRun(runId);
          if (run.status !== "running") {
            yield* Effect.logInfo("epic.runner.loop-stopped", { runId, status: run.status });
            return;
          }
          if (run.iterationsCompleted >= run.maxIterations) {
            yield* saveRun({
              ...run,
              status: "done",
              currentThreadId: null,
              currentTurnStartedAt: null,
              lastError: `max iterations (${run.maxIterations}) reached`,
              updatedAt: yield* nowIso,
            });
            return;
          }

          const latest = yield* store
            .getLatestIteration({ runId })
            .pipe(Effect.mapError(storeError("getLatestIteration")));
          const iterationIndex = Option.isSome(latest) ? latest.value.iterationIndex + 1 : 0;

          const outcome = yield* runIteration({ run, iterationIndex });

          // Re-read rather than writing back the snapshot taken before the
          // iteration: `pauseRun`/`cancelRun` may have changed the status while
          // the turn was in flight, and building the post-iteration row from
          // the stale copy would silently resurrect the run as `running`.
          const currentRun = yield* requireRun(runId);
          const settledRun = {
            ...currentRun,
            currentThreadId: null,
            currentTurnStartedAt: null,
            iterationsCompleted: currentRun.iterationsCompleted + 1,
            updatedAt: yield* nowIso,
          };

          if (currentRun.status !== "running") {
            // Someone stopped the run mid-iteration. Record that the iteration
            // happened, honour their status, and leave.
            yield* saveRun(settledRun);
            yield* Effect.logInfo("epic.runner.loop-stopped", {
              runId,
              status: currentRun.status,
            });
            return;
          }

          if (outcome.kind === "backlog-empty") {
            yield* saveRun({
              ...settledRun,
              status: "done",
              consecutiveFailures: 0,
              lastError: null,
            });
            return;
          }

          if (outcome.kind === "done") {
            noCommitStreak = 0;
            yield* saveRun({ ...settledRun, consecutiveFailures: 0, lastError: null });
            continue;
          }

          if (outcome.kind === "no-commit") {
            noCommitStreak += 1;
            const gutter = noCommitStreak >= maxNoCommitStreak;
            yield* saveRun({
              ...settledRun,
              ...(gutter
                ? {
                    status: "failed" as const,
                    lastError: `gutter: ${noCommitStreak} iterations without a commit`,
                  }
                : { lastError: null }),
              consecutiveFailures: 0,
            });
            if (gutter) {
              return;
            }
            continue;
          }

          const consecutiveFailures = currentRun.consecutiveFailures + 1;
          const exhausted = consecutiveFailures >= maxConsecutiveFailures;
          yield* saveRun({
            ...settledRun,
            ...(exhausted ? { status: "failed" as const } : {}),
            consecutiveFailures,
            lastError: outcome.detail ?? outcome.kind,
          });
          if (exhausted) {
            return;
          }
          yield* Effect.sleep(Duration.millis(backoffDelayMs(consecutiveFailures)));
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
        Effect.ensuring(Effect.andThen(releaseLease(runId), releaseStrandedChild(runId))),
      );

    const forkLoop = (runId: EpicRunId) =>
      FiberMap.run(loops, runId, supervisedLoop(runId)).pipe(Effect.asVoid);

    const startRun: EpicRunnerShape["startRun"] = (input: StartEpicRunInput) =>
      Effect.gen(function* () {
        const active = yield* findActiveRun(input);
        if (active !== undefined) {
          return yield* enrichRun(active);
        }

        const runId = EpicRunId.make(yield* crypto.randomUUIDv4.pipe(Effect.orDie));
        const createdAt = yield* nowIso;
        const run: EpicRun = {
          runId,
          epicId: input.epicId,
          projectId: input.projectId,
          cwd: input.cwd,
          prompt: input.prompt,
          modelSelection: input.modelSelection,
          runtimeMode: input.runtimeMode ?? DEFAULT_RUNTIME_MODE,
          // Only ever what the launcher supplied: the run's own iteration
          // threads are children, so they can never stand in for an origin.
          originThreadId: input.originThreadId ?? null,
          status: "running",
          maxIterations: Math.max(1, Math.trunc(input.maxIterations ?? defaultMaxIterations)),
          iterationsCompleted: 0,
          currentThreadId: null,
          currentTurnStartedAt: null,
          consecutiveFailures: 0,
          lastError: null,
          createdAt,
          updatedAt: createdAt,
        };

        const acquireError = yield* acquireLease(runId, input).pipe(
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
        if (project.value.defaultModelSelection === null) {
          return yield* new EpicRunLaunchError({ reason: "model_default_missing" });
        }
        return yield* startRun({
          ...input,
          prompt: EPIC_RUN_ITERATION_PROMPT,
          modelSelection: project.value.defaultModelSelection,
          runtimeMode: DEFAULT_RUNTIME_MODE,
          maxIterations: defaultMaxIterations,
        });
      });

    const pauseRun: EpicRunnerShape["pauseRun"] = ({ runId }) =>
      Effect.gen(function* () {
        const run = yield* requireRun(runId);
        if (run.status !== "running") {
          return yield* new EpicRunStateError({
            runId,
            detail: `cannot pause a ${run.status} run`,
          });
        }
        const paused: EpicRun = { ...run, status: "paused", updatedAt: yield* nowIso };
        // No interrupt: the loop re-reads the run before each iteration and
        // exits at that boundary, so the turn in flight finishes its unit of
        // work rather than leaving the repo and backlog half-done.
        yield* saveRun(paused);
        return yield* enrichRun(paused);
      });

    const resumeRun: EpicRunnerShape["resumeRun"] = ({ runId }) =>
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
          lastError: null,
          updatedAt: yield* nowIso,
        };
        yield* acquireLease(runId, { cwd: run.cwd, epicId: run.epicId }).pipe(
          Effect.mapError((error) =>
            error._tag === "EpicRunLeaseHeld" ? error.mappedError : error,
          ),
        );
        yield* saveRun(resumed).pipe(releaseLeaseOnFailure(runId));
        yield* forkLoop(runId).pipe(releaseLeaseOnFailure(runId));
        return yield* enrichRun(resumed);
      });

    const cancelRun: EpicRunnerShape["cancelRun"] = ({ runId }) =>
      Effect.gen(function* () {
        const run = yield* requireRun(runId);
        if (run.status === "done" || run.status === "failed" || run.status === "cancelled") {
          return yield* new EpicRunStateError({ runId, detail: `run already ${run.status}` });
        }

        // Interrupt the loop before touching the turn, so it cannot start
        // another iteration while this one is being torn down.
        yield* FiberMap.remove(loops, runId);

        const cancelledAt = yield* nowIso;
        const threadId = run.currentThreadId;
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
              finishedAt: cancelledAt,
            })
            .pipe(Effect.mapError(storeError("updateIteration")));
        }

        const cancelled: EpicRun = {
          ...run,
          status: "cancelled",
          currentThreadId: null,
          currentTurnStartedAt: null,
          updatedAt: cancelledAt,
        };
        yield* saveRun(cancelled);
        yield* releaseLease(runId);
        return yield* enrichRun(cancelled);
      });

    const listRuns: EpicRunnerShape["listRuns"] = (input) =>
      store.listRuns(input?.status === undefined ? {} : { status: input.status }).pipe(
        Effect.mapError(storeError("listRuns")),
        Effect.flatMap((runs) => Effect.forEach(runs, enrichRun)),
      );

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
          const acquireError = yield* acquireLease(run.runId, {
            cwd: run.cwd,
            epicId: run.epicId,
          }).pipe(
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
            // abandoned: the restart killed its provider subprocess and nothing
            // re-attaches. `epic_run_iterations.turn_status` is the sole
            // in-flight marker, so no projection join is needed to know that.
            const latest = yield* store
              .getLatestIteration({ runId: run.runId })
              .pipe(Effect.mapError(storeError("getLatestIteration")));
            if (Option.isSome(latest) && latest.value.turnStatus === "running") {
              const abandonedAt = yield* nowIso;
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
              yield* store
                .updateIteration({
                  runId: run.runId,
                  iterationIndex: latest.value.iterationIndex,
                  turnStatus: "abandoned",
                  summary: "abandoned by server restart",
                  why: null,
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
          iterationTimeoutMs,
          maxConsecutiveFailures,
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
