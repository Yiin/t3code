/**
 * PoolDispatch - Server adapters for the shared parallel epic loop.
 *
 * Every port the core `runParallelEpicLoop` (`@t3tools/epic-core/ParallelEpicLoop`)
 * consumes is bound here to the server's machinery: the orchestration engine
 * command path, the projection snapshot query, the durable run store, the `bd`
 * and `git` subprocess probes, and the worktree provisioner. The loop owns
 * policy; this module owns effects. Behaviour is ported verbatim from the
 * pre-extraction runner so the WS/HTTP surface, the persisted rows, and the
 * dispatch ordering do not change.
 *
 * @module PoolDispatch
 */
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EpicRunId,
  MessageId,
  PROVIDER_TURN_STEER_ATTRIBUTED_ACTIVITY_KIND,
  ProviderDriverKind,
  ThreadId,
  decodeProviderTurnSteerAttributedActivityPayload,
  type EpicSubagentMap,
  type TurnId,
} from "@t3tools/contracts";
import { EpicRunnerDispatchError } from "@t3tools/epic-core/Errors";
import type * as ProcessRunner from "@t3tools/epic-core/processRunner";
import type { PoolTimings } from "@t3tools/epic-core/ParallelEpicLoop";
import type { PoolDispatchShape } from "@t3tools/epic-core/ports/PoolDispatch";
import {
  type AgentDispatchCapabilities,
  type AgentSelection,
  DispatchError,
  type FinalMessageRead,
  type IterationHandle,
  type IterationSettle,
} from "@t3tools/epic-core/ports/AgentDispatch";

import { decideGraceStep } from "@t3tools/epic-core/policy";
import { hasRalphBlocked, hasRalphDone, parseRalphReport } from "@t3tools/epic-core/ralphProtocol";
import { makeProcessPoolVcs } from "@t3tools/epic-core/adapters/ProcessPoolVcs";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import type { EpicSubagentRegistry } from "../../provider/epicSubagents.ts";
import type { EpicCommitterRegistry } from "../../provider/epicCommitter.ts";
import type { EpicWorkerScopeRegistry } from "../../provider/workerScope.ts";
import { countFreshRunningSubagents } from "../../orchestration/subagentLiveness.ts";
import {
  makeThreadSettleWatch,
  resolveFinalAssistantMessage,
  resolveTurnAssistantMessage,
  threadTurnState,
  type SettledTurn,
} from "../../orchestration/ThreadSettleWatch.ts";
import type { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { ProjectSetupScriptRunner } from "../../project/ProjectSetupScriptRunner.ts";
import { nowIso } from "./poolPortErrors.ts";

/**
 * How often a forced stop re-reads the turn it is waiting on inside the run's
 * stop grace. Short enough that a turn closing early costs almost nothing, and
 * the whole wait is bounded by the grace regardless.
 */
const FORCED_STOP_POLL_INTERVAL_MS = 250;

/**
 * How many projection reads a nudge waits for its steer attribution.
 *
 * The activity is written when the provider answers the send, so this is
 * provider latency, not projection lag. Ten reads at the run's quiet period is
 * ten seconds by default — long enough that a slow steer still counts as
 * absorbed, short enough that a driver which never steers is written off
 * inside one radar tick.
 */
const NUDGE_ABSORPTION_READS = 10;

/** The one driver whose adapter passes injected subagent definitions through. */
const CLAUDE_SUBAGENT_DRIVER = ProviderDriverKind.make("claudeAgent");

/** Preserve the pre-extraction dispatch error's persisted message shape. */
const dispatchErrorFromRunner = (error: EpicRunnerDispatchError) =>
  new DispatchError({
    operation: `Epic runner failed to dispatch ${error.commandType}`,
    detail: error.detail,
    cause: error,
  });

const serverDispatchCapabilities: AgentDispatchCapabilities = {
  terminalSignal: "projection",
  continuation: "same-thread",
  subagentLiveness: "native",
  finalMessage: "projection",
  providerErrors: "session-and-assistant",
  cost: "none",
  lifecycle: { resume: "adopt-ref" },
};

/**
 * The durable gate-receipt journal behind the merge drain's evidence port.
 *
 * Append-only by construction: the store allocates the sequence and nothing
 * updates a row, so a restart reads back exactly what every earlier lifetime
 * of the run recorded.
 */
/** Worktree lifecycle for pool iterations and the integration branch. */
export const makeServerPoolDispatch = (deps: {
  readonly engine: OrchestrationEngineService["Service"];
  readonly projectionSnapshotQuery: ProjectionSnapshotQuery["Service"];
  readonly processRunner: ProcessRunner.ProcessRunner["Service"];
  readonly projectSetupScriptRunner: ProjectSetupScriptRunner["Service"];
  readonly crypto: Crypto.Crypto;
  readonly workerScopeRegistry: EpicWorkerScopeRegistry["Service"];
  readonly subagentRegistry: EpicSubagentRegistry["Service"];
  /**
   * The run-scoped git committer identity registry (t3code-e6l). Absent
   * skips binding entirely — a worker's commits then carry the operator's
   * identity, so an in-place iteration earns no commit credit from
   * `iterationCommitted`'s identity check and must close with bead
   * evidence. Construction stays fail-soft the same way an absent
   * `readSessionDriverKind` does.
   */
  readonly committerRegistry?: EpicCommitterRegistry["Service"];
  /**
   * The role subagents this run's worker sessions carry, read once per
   * iteration thread so a policy or usage change lands on the next iteration.
   * Takes the session's own selection, because a subagent runs inside that
   * session and cannot use another provider's model. Never fails: an empty
   * map means "inject nothing".
   */
  readonly readIterationSubagents: (
    sessionSelection: AgentSelection,
  ) => Effect.Effect<EpicSubagentMap>;
  /**
   * The driver the session's own account runs, or `null` when the account is
   * unknown. Only used to say so when a bound map cannot reach the harness.
   * Never fails, and an absent reader simply logs nothing.
   */
  readonly readSessionDriverKind?: (
    sessionSelection: AgentSelection,
  ) => Effect.Effect<ProviderDriverKind | null>;
  readonly ownedIterationTurnIds?: Map<ThreadId, TurnId>;
}): PoolDispatchShape => {
  const {
    engine,
    projectionSnapshotQuery,
    processRunner,
    projectSetupScriptRunner,
    crypto,
    workerScopeRegistry,
    subagentRegistry,
    committerRegistry,
    readIterationSubagents,
  } = deps;
  const readSessionDriverKind = deps.readSessionDriverKind ?? (() => Effect.succeed(null));
  const ownedIterationTurnIds = deps.ownedIterationTurnIds ?? new Map<ThreadId, TurnId>();
  const vcs = makeProcessPoolVcs(processRunner);

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

  /**
   * Bind one iteration thread to the role subagents its worker session gets.
   *
   * Bound before the thread exists, for the same reason the worker scope is:
   * the provider session starts lazily on the first turn and resolves the
   * binding then. An empty map binds nothing, so a server with no in-session
   * roles configured leaves the harness's own agents untouched.
   *
   * The binding still happens on every driver, but only the Claude adapter
   * reads `ProviderSessionStartInput.subagents`; every other adapter drops the
   * map without a word. That silence is the whole reason for the log below: a
   * worker on Codex or Kimi runs with the harness's own agents, and the run
   * looks identical from the outside.
   */
  const bindIterationSubagents = (
    runId: EpicRunId,
    threadId: ThreadId,
    sessionSelection: AgentSelection,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      const subagents = yield* readIterationSubagents(sessionSelection);
      if (Object.keys(subagents).length === 0) return;
      const driver = yield* readSessionDriverKind(sessionSelection);
      // An unknown account says nothing either way, so it stays quiet.
      if (driver !== null && driver !== CLAUDE_SUBAGENT_DRIVER) {
        yield* Effect.logInfo("epic.runner.subagents-unsupported-harness", {
          threadId,
          driver,
          instanceId: sessionSelection.instanceId,
          subagents: Object.keys(subagents),
          detail:
            "Injected stage agents reach Claude sessions only; this worker keeps the harness's own agents.",
        });
      }
      yield* subagentRegistry.bindThread({ runId, threadId, subagents });
    });

  /**
   * Bind one iteration thread to the run whose git committer identity its
   * worker's commits should carry (t3code-e6l). Bound before the thread
   * exists, the same way the subagent map is, and unconditionally — unlike
   * subagents, every driver can carry env, so there is no harness this skips.
   */
  const bindIterationCommitter = (runId: EpicRunId, threadId: ThreadId): Effect.Effect<void> =>
    committerRegistry === undefined
      ? Effect.void
      : committerRegistry.bindThread({ runId, threadId });

  // `awaitResumeOutcome` is shared with the boot nudger
  // (`provider/Layers/InterruptedTurnNudger.ts`), which resumes an interactive
  // thread the same way this resumes an iteration thread. It lives on the
  // settle watch because it polls the same `readThreadDetail`.
  const { readThreadDetail, awaitTurnEnd, awaitResumeOutcome, readSettledFinalMessage } =
    makeThreadSettleWatch({
      projectionSnapshotQuery,
      logPrefix: "epic.runner",
    });

  /**
   * Wait for the thread to have no FRESH running subagents, bounded by
   * `subagentGraceTimeoutMs`. Polls the detail snapshot rather than the
   * shell's `activeSubagentCount` because staleness matters: that count
   * includes rows stranded at `running`, which the settle decider ignores —
   * waiting on them would burn the whole bound for work that no longer
   * exists. Returns whether the drain completed inside the bound.
   */
  const awaitSubagentDrain = (threadId: ThreadId, timings: PoolTimings) =>
    Effect.gen(function* () {
      while (true) {
        const snapshot = yield* readThreadDetail(threadId);
        const subagents = snapshot?.thread.subagents ?? [];
        const nowMs = Date.parse(yield* nowIso);
        if (countFreshRunningSubagents(subagents, nowMs) === 0) {
          return;
        }
        yield* Effect.sleep(Duration.millis(timings.pollIntervalMs));
      }
    }).pipe(
      Effect.timeoutOption(Duration.millis(timings.subagentGraceTimeoutMs)),
      Effect.map(Option.isSome),
    );

  /**
   * Let a turn the loop just interrupted close itself before the session stop
   * kills it — the server's half of `supervision.stopGraceSeconds`.
   *
   * A turn interrupt is asynchronous: the command reaches the provider through
   * the reactor and the turn leaves `running` only once the agent unwinds. A
   * `thread.session.stop` dispatched in the same breath ends the process
   * mid-unwind, which is what the terminal harness already avoids by waiting
   * between its TERM and its KILL.
   *
   * Bounded by the grace and by nothing else: the wait ends the moment the
   * turn is no longer running, an unreadable projection reads as "not running"
   * and stops the wait, and a grace of `0` waits for nothing at all.
   */
  const awaitInterruptedTurnClose = (threadId: ThreadId, graceSeconds: number) =>
    graceSeconds <= 0
      ? Effect.void
      : Effect.gen(function* () {
          while (true) {
            const snapshot = yield* readThreadDetail(threadId);
            if (threadTurnState(snapshot?.thread) !== "running") return;
            yield* Effect.sleep(Duration.millis(FORCED_STOP_POLL_INTERVAL_MS));
          }
        }).pipe(
          Effect.timeoutOption(Duration.seconds(graceSeconds)),
          Effect.tap((closed) =>
            Option.isSome(closed)
              ? Effect.void
              : Effect.logWarning("epic.runner.stop-grace-exhausted", {
                  threadId,
                  graceSeconds,
                }),
          ),
          Effect.asVoid,
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
    readonly runId: string;
    readonly iterationIndex: number;
    readonly threadId: ThreadId;
    readonly selection: Parameters<PoolDispatchShape["beginTurn"]>[0]["selection"];
    readonly runtimeMode: Parameters<PoolDispatchShape["beginTurn"]>[0]["runtimeMode"];
    readonly workspace: Parameters<PoolDispatchShape["beginTurn"]>[0]["workspace"];
    readonly headBefore: string | null;
    readonly branchBase: string | null;
    readonly initialWorktreeFingerprint: string | null;
    readonly timings: PoolTimings;
    readonly settledTurn: SettledTurn;
    readonly onObservedTurn: (turnId: TurnId) => void;
  }): Effect.Effect<SettledTurn, DispatchError> =>
    Effect.gen(function* () {
      let continuationIndex = 0;
      let worktreeFingerprintBefore = input.initialWorktreeFingerprint;
      let settledTurn = input.settledTurn;

      while (true) {
        const headMoved = yield* iterationCommitted({
          workspace: input.workspace,
          headBefore: input.headBefore,
          branchBase: input.branchBase,
        });
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
            maxGraceContinuations: input.timings.maxGraceContinuations,
          });
          if (decision.action === "settle") return settledTurn;
        }

        const snapshot = yield* readThreadDetail(input.threadId);
        const thread = snapshot?.thread;
        const turnStatus = settledTurn.state;
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
            maxGraceContinuations: input.timings.maxGraceContinuations,
          });
          if (decision.action === "settle") return settledTurn;
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
          worktreeFingerprintAfter = yield* vcs.worktreeFingerprint(input.workspace.cwd);
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
              maxGraceContinuations: input.timings.maxGraceContinuations,
            });
            if (decision.action === "settle") return settledTurn;
          }
          const finalMessage = yield* readSettledFinalMessage(
            input.threadId,
            input.timings,
            settledTurn.turnId,
            settledTurn.state,
          );
          const finalAssistantMessage =
            settledTurn.turnId === null
              ? resolveFinalAssistantMessage(finalMessage.snapshot?.thread)
              : resolveTurnAssistantMessage(finalMessage.snapshot?.thread, settledTurn.turnId);
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
          maxGraceContinuations: input.timings.maxGraceContinuations,
        });
        if (decision.action === "settle") {
          if (decision.reason === "continuation-cap") {
            yield* Effect.logWarning("epic.runner.subagent-grace-cap", {
              runId: input.runId,
              iterationIndex: input.iterationIndex,
              threadId: input.threadId,
              continuationIndex,
            });
          }
          return settledTurn;
        }

        if (decision.action === "awaitDrain") {
          yield* Effect.logInfo("epic.runner.subagent-grace-started", {
            runId: input.runId,
            iterationIndex: input.iterationIndex,
            threadId: input.threadId,
            continuationIndex,
            freshRunning,
          });
          const drained = yield* awaitSubagentDrain(input.threadId, input.timings);
          if (!drained) {
            yield* Effect.logWarning("epic.runner.subagent-grace-timeout", {
              runId: input.runId,
              iterationIndex: input.iterationIndex,
              threadId: input.threadId,
              continuationIndex,
            });
            return settledTurn;
          }
          worktreeFingerprintBefore = yield* vcs.worktreeFingerprint(input.workspace.cwd);
          yield* Effect.logInfo("epic.runner.subagent-grace-continuation", {
            runId: input.runId,
            iterationIndex: input.iterationIndex,
            threadId: input.threadId,
            continuationIndex: decision.nextContinuationCount,
          });
        } else {
          worktreeFingerprintBefore = worktreeFingerprintAfter;
          yield* Effect.logInfo("epic.runner.progress-continuation", {
            runId: input.runId,
            iterationIndex: input.iterationIndex,
            threadId: input.threadId,
            continuationIndex: decision.nextContinuationCount,
          });
        }

        continuationIndex = decision.nextContinuationCount;
        const createdAt = yield* nowIso;
        // A human turn can start after the grace snapshot while subagents
        // drain. Do not dispatch a continuation into that newer turn.
        const graceSnapshotTurnId = thread?.latestTurn?.turnId ?? null;
        const priorTurnId =
          (yield* readThreadDetail(input.threadId))?.thread.latestTurn?.turnId ?? null;
        if (
          priorTurnId !== null &&
          priorTurnId !== graceSnapshotTurnId &&
          priorTurnId !== settledTurn.turnId
        ) {
          return settledTurn;
        }
        const continuationMessageId = MessageId.make(
          continuationIndex === 1
            ? `${input.threadId}-continue`
            : `${input.threadId}-continue-${continuationIndex}`,
        );
        yield* dispatchCommand({
          type: "thread.turn.start",
          commandId: yield* commandId("turn-continue"),
          threadId: input.threadId,
          message: {
            // Every continuation needs its own message id. Otherwise a later
            // cycle replaces the earlier continuation in the projection.
            messageId: continuationMessageId,
            role: "user",
            text: decision.prompt,
            attachments: [],
          },
          // The runner wrote this prompt, not the human. The timeline labels
          // an agent-authored `role: "user"` row so the two never blur.
          origin: "agent",
          // A human turn can still start between the re-check and dispatch.
          // Park the continuation until that turn ends if this race is lost.
          delivery: "turn-boundary",
          modelSelection: input.selection,
          runtimeMode: input.runtimeMode,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          createdAt,
        }).pipe(Effect.mapError(dispatchErrorFromRunner));
        settledTurn = yield* awaitTurnEnd(
          input.threadId,
          input.timings,
          priorTurnId,
          input.onObservedTurn,
          continuationMessageId,
        );
      }
    });

  const iterationCommitted = (args: {
    readonly workspace: Parameters<PoolDispatchShape["beginTurn"]>[0]["workspace"];
    readonly headBefore: string | null;
    readonly branchBase: string | null;
  }): Effect.Effect<boolean> =>
    Effect.gen(function* () {
      const headAfter = yield* vcs.headCommit(args.workspace.cwd);
      if (headAfter !== null && headAfter !== args.headBefore) return true;
      if (args.workspace.branch === null || args.branchBase === null) return false;
      const count = yield* vcs.commitsAhead({
        cwd: args.workspace.cwd,
        base: args.branchBase,
        branch: args.workspace.branch,
      });
      return count !== null && count > 0;
    });

  /**
   * The handle every dispatched iteration is driven through.
   *
   * Shared by `beginTurn` and `resumeIteration` so a resumed iteration cannot
   * settle, continue, release or read its final message by different rules
   * than a fresh one. The only difference between the two callers is
   * `priorTurnId`: a resume arrives with a turn already recorded on the
   * thread, and the settle wait has to ignore it.
   */
  const makeIterationHandle = (input: {
    readonly threadId: ThreadId;
    readonly runId: string;
    readonly iterationIndex: number;
    readonly selection: Parameters<PoolDispatchShape["beginTurn"]>[0]["selection"];
    readonly runtimeMode: Parameters<PoolDispatchShape["beginTurn"]>[0]["runtimeMode"];
    readonly policy: PoolTimings;
    readonly workspace: Parameters<PoolDispatchShape["beginTurn"]>[0]["workspace"];
    readonly headBefore: string | null;
    readonly branchBase: string | null;
    readonly initialWorktreeFingerprint: string | null;
    readonly priorTurnId: TurnId | null;
    readonly messageId: MessageId;
  }): IterationHandle => {
    let settledTurn: SettledTurn | null = null;
    let ownedTurnId: TurnId | null = null;
    /** False once a delivered nudge proved this provider does not absorb one. */
    let nudgeEligible = true;
    const observeOwnedTurn = (turnId: TurnId) => {
      ownedTurnId = turnId;
      ownedIterationTurnIds.set(input.threadId, turnId);
    };
    const awaitSettled: Effect.Effect<IterationSettle, DispatchError> = Effect.gen(function* () {
      const initialSettledTurn = yield* awaitTurnEnd(
        input.threadId,
        input.policy,
        input.priorTurnId,
        observeOwnedTurn,
        input.messageId,
      );
      settledTurn = yield* graceContinuationForSubagents({
        runId: input.runId,
        iterationIndex: input.iterationIndex,
        threadId: input.threadId,
        selection: input.selection,
        runtimeMode: input.runtimeMode,
        workspace: input.workspace,
        headBefore: input.headBefore,
        branchBase: input.branchBase,
        initialWorktreeFingerprint: input.initialWorktreeFingerprint,
        timings: input.policy,
        settledTurn: initialSettledTurn,
        onObservedTurn: observeOwnedTurn,
      });
      const snapshot = yield* readThreadDetail(input.threadId);
      const projectedState = threadTurnState(snapshot?.thread);
      if (
        snapshot?.thread.latestTurn === null &&
        projectedState !== null &&
        projectedState !== "running"
      ) {
        // The detail pointer can be absent while checkpoint work catches up.
        // In that window the session is the only projected terminal state.
        settledTurn = { ...settledTurn, state: projectedState };
      }
      return {
        turnState: settledTurn.state,
        timedOut: false,
        providerError: snapshot?.thread.session?.lastError ?? null,
      } satisfies IterationSettle;
    });

    const handle: IterationHandle = {
      ref: input.threadId,
      capabilities: serverDispatchCapabilities,
      awaitSettled,
      continueTurn: (prompt) =>
        Effect.gen(function* () {
          const continuationId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
          yield* dispatchCommand({
            type: "thread.turn.start",
            commandId: yield* commandId("turn-continue"),
            threadId: input.threadId,
            message: {
              messageId: MessageId.make(`${input.threadId}-continue-${continuationId}`),
              role: "user",
              text: prompt,
              attachments: [],
            },
            origin: "agent",
            modelSelection: input.selection,
            runtimeMode: input.runtimeMode,
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            createdAt: yield* nowIso,
          }).pipe(Effect.mapError(dispatchErrorFromRunner));
        }),
      nudge: (prompt) =>
        Effect.gen(function* () {
          if (!nudgeEligible) return "unsupported" as const;
          // The message must land in the turn this iteration owns, and that
          // turn must still be running. After settlement the ids no longer
          // match, and a nudge sent then would start a turn of its own — with
          // no timeout, no liveness watch and no owner — in a worktree the
          // merge queue is about to trial-merge.
          const snapshot = yield* readThreadDetail(input.threadId);
          const latestTurn = snapshot?.thread.latestTurn ?? null;
          if (
            ownedTurnId === null ||
            latestTurn === null ||
            latestTurn.turnId !== ownedTurnId ||
            latestTurn.state !== "running"
          ) {
            return "skipped" as const;
          }
          const messageId = MessageId.make(
            `${input.threadId}-nudge-${yield* crypto.randomUUIDv4.pipe(Effect.orDie)}`,
          );
          // Deliberately no `delivery` field: `turn-boundary` would park this
          // until the turn ends, which is the opposite of a nudge and comes
          // back as exactly the stray turn the guard above exists to prevent.
          const dispatched = yield* dispatchCommand({
            type: "thread.turn.start",
            commandId: yield* commandId("turn-nudge"),
            threadId: input.threadId,
            message: { messageId, role: "user", text: prompt, attachments: [] },
            origin: "agent",
            modelSelection: input.selection,
            runtimeMode: input.runtimeMode,
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            createdAt: yield* nowIso,
          }).pipe(
            Effect.as(true),
            Effect.catchCause((cause) =>
              Effect.logWarning("epic.runner.nudge-failed", {
                threadId: input.threadId,
                cause,
              }).pipe(Effect.as(false)),
            ),
          );
          if (!dispatched) return "skipped" as const;
          // No adapter declares steer support before a send, so absorption is
          // the only available evidence: the reactor writes this activity only
          // when the provider reported that it steered the running turn. A
          // driver that opened a second turn instead (Kimi, Grok, Cursor, or a
          // Codex fallback) never writes it, and must never be nudged again.
          const absorbed = yield* Effect.gen(function* () {
            for (let read = 0; read < NUDGE_ABSORPTION_READS; read += 1) {
              yield* Effect.sleep(Duration.millis(input.policy.quietPeriodMs));
              const after = yield* readThreadDetail(input.threadId);
              const attributed = (after?.thread.activities ?? []).some(
                (activity) =>
                  activity.kind === PROVIDER_TURN_STEER_ATTRIBUTED_ACTIVITY_KIND &&
                  Option.match(decodeProviderTurnSteerAttributedActivityPayload(activity.payload), {
                    onNone: () => false,
                    onSome: (payload) => payload.messageId === messageId,
                  }),
              );
              if (attributed) return true;
            }
            return false;
          });
          if (absorbed) return "sent" as const;
          nudgeEligible = false;
          yield* Effect.logWarning("epic.runner.nudge-not-absorbed", {
            threadId: input.threadId,
            messageId,
          });
          return "unsupported" as const;
        }),
      interrupt: Effect.gen(function* () {
        yield* dispatchBestEffort("epic.runner.interrupt-failed", {
          type: "thread.turn.interrupt",
          commandId: yield* commandId("turn-interrupt"),
          threadId: input.threadId,
          ...(ownedTurnId === null ? {} : { turnId: ownedTurnId }),
          createdAt: yield* nowIso,
        });
      }),
      release: Effect.gen(function* () {
        yield* awaitSubagentDrain(input.threadId, input.policy);
        // Do not stop a settled iteration session here. A queued human prompt
        // can become active between any projection check and session.stop.
        // The session reaper owns idle cleanup without racing message delivery.
        ownedIterationTurnIds.delete(input.threadId);
      }),
      runningSubagents: Effect.gen(function* () {
        const snapshot = yield* readThreadDetail(input.threadId);
        const nowMs = Date.parse(yield* nowIso);
        return {
          mode: "native" as const,
          running: countFreshRunningSubagents(snapshot?.thread.subagents ?? [], nowMs),
        };
      }),
      finalMessage: Effect.suspend(() =>
        readSettledFinalMessage(
          input.threadId,
          input.policy,
          settledTurn?.turnId ?? null,
          settledTurn?.state ?? null,
        ).pipe(
          Effect.map((settled): FinalMessageRead => {
            const thread = settled.snapshot?.thread;
            const message =
              settledTurn?.turnId == null
                ? resolveFinalAssistantMessage(thread)
                : resolveTurnAssistantMessage(thread, settledTurn.turnId);
            return {
              text: message?.text ?? null,
              streaming: message?.streaming ?? false,
              waitExhausted: settled.messageWaitExhausted,
              turnState: settledTurn?.state ?? null,
              sessionLastError: thread?.session?.lastError ?? null,
            };
          }),
        ),
      ),
    };
    return handle;
  };

  return {
    capabilities: serverDispatchCapabilities,
    createIteration: (input) =>
      Effect.gen(function* () {
        // Bind the thread to its worker unit before the thread exists so the
        // provider session — started lazily on the first turn — already
        // resolves the scope. Same worker naming as the terminal dispatch.
        yield* workerScopeRegistry.bindWorker({
          runId: input.runId,
          threadId: input.threadId,
          worker: `iteration-${String(input.iterationIndex)}`,
        });
        yield* bindIterationSubagents(input.runId, input.threadId, input.selection);
        yield* bindIterationCommitter(input.runId, input.threadId);
        yield* dispatchCommand({
          type: "thread.create",
          commandId: yield* commandId("thread-create"),
          threadId: input.threadId,
          projectId: input.projectId,
          title: input.title,
          modelSelection: input.selection,
          runtimeMode: input.runtimeMode,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          branch: input.branch,
          worktreePath: input.worktreePath,
          createdAt: input.startedAt,
        });
      }),

    prepareIteration: (input) =>
      input.branch === null || input.worktreePath === null
        ? Effect.void
        : projectSetupScriptRunner
            .runForThread({
              threadId: input.threadId,
              projectId: input.projectId,
              projectCwd: input.runCwd,
              worktreePath: input.worktreePath,
            })
            .pipe(
              Effect.catch((cause) =>
                Effect.logWarning("epic.runner.worktree-setup-failed", {
                  threadId: input.threadId,
                  worktreePath: input.worktreePath,
                  cause,
                }),
              ),
            ),

    beginTurn: (input) =>
      Effect.gen(function* () {
        const messageId = MessageId.make(`${input.threadId}-prompt`);
        yield* dispatchCommand({
          type: "thread.turn.start",
          commandId: yield* commandId("turn-start"),
          threadId: input.threadId,
          message: {
            messageId,
            role: "user",
            text: input.prompt,
            attachments: [],
          },
          origin: "agent",
          modelSelection: input.selection,
          runtimeMode: input.runtimeMode,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          createdAt: yield* nowIso,
        });
        return makeIterationHandle({ ...input, priorTurnId: null, messageId });
      }),

    /**
     * The server's ref IS the iteration's orchestration thread id, which
     * outlives the process, so adopting the work is asking that thread to
     * carry on. A failed dispatch is an infra fault — the command path is
     * broken or the thread was deleted — while every provider-side "no" comes
     * back through the resume outcome as an `unavailable` value.
     */
    resumeIteration: (input) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make(input.ref);
        // The registry is in-memory, so a restart lost this thread's binding.
        // Rebind before the resume: if the session has to start again, it
        // starts with the role subagents rather than without them.
        yield* bindIterationSubagents(input.runId, threadId, input.selection);
        yield* bindIterationCommitter(input.runId, threadId);
        const resumeCommandId = yield* commandId("session-resume");
        yield* dispatchCommand({
          type: "thread.session.resume",
          commandId: resumeCommandId,
          threadId,
          createdAt: yield* nowIso,
        });
        const outcome = yield* awaitResumeOutcome({
          threadId,
          requestCommandId: resumeCommandId,
          pollIntervalMs: input.policy.pollIntervalMs,
        });
        yield* Effect.logInfo("epic.runner.resume-outcome", {
          runId: input.runId,
          iterationIndex: input.iterationIndex,
          issueId: input.issueId,
          threadId,
          outcome: outcome._tag,
        });
        switch (outcome._tag) {
          case "capability":
          case "no-durable-state":
            return {
              _tag: "unavailable",
              refusal: { _tag: outcome._tag, detail: outcome.detail },
            } as const;
          case "not-continued":
            return {
              _tag: "unavailable",
              refusal: {
                _tag: "not-continued",
                origin: outcome.origin,
                detail: outcome.detail,
              },
            } as const;
          case "failed":
            // Not an `EpicRunnerDispatchError`: the reactor answers `failed`
            // when the adapter errored on the resume it had accepted, and the
            // agent still heard nothing. That is a refusal the caller recovers
            // from, not a broken machine.
            return {
              _tag: "unavailable",
              refusal: { _tag: "failed", detail: outcome.detail },
            } as const;
          case "resumed":
            break;
        }

        // Only now, with continuity proved, does the agent hear anything.
        const promptId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
        const messageId = MessageId.make(`${threadId}-resume-${promptId}`);
        // The resume handshake can overlap a human turn. Pin the wait to the
        // turn active immediately before this runner prompt is dispatched.
        const priorTurnId = (yield* readThreadDetail(threadId))?.thread.latestTurn?.turnId ?? null;
        yield* dispatchCommand({
          type: "thread.turn.start",
          commandId: yield* commandId("turn-resume"),
          threadId,
          message: {
            // Never `${threadId}-prompt`: that id already names the message
            // the interrupted iteration sent, and reusing it would replace it.
            messageId,
            role: "user",
            text: input.prompt,
            attachments: [],
          },
          origin: "agent",
          modelSelection: input.selection,
          runtimeMode: input.runtimeMode,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          createdAt: yield* nowIso,
        });
        return {
          _tag: "resumed",
          handle: makeIterationHandle({ ...input, threadId, priorTurnId, messageId }),
        } as const;
      }),

    interruptForced: (threadId) =>
      Effect.gen(function* () {
        const createdAt = yield* nowIso;
        yield* dispatchBestEffort("epic.runner.forced-interrupt-failed", {
          type: "thread.turn.interrupt",
          commandId: yield* commandId("forced-interrupt"),
          threadId,
          // Only this process's own owned turn can be named. A thread
          // interrupted after a restart has none recorded here, and the
          // engine then interrupts whatever turn it finds running.
          ...(ownedIterationTurnIds.has(threadId)
            ? { turnId: ownedIterationTurnIds.get(threadId) }
            : {}),
          createdAt,
        });
      }),

    stopAbandoned: (threadId) =>
      Effect.gen(function* () {
        yield* dispatchBestEffort("epic.runner.skipped-session-stop-failed", {
          type: "thread.session.stop",
          commandId: yield* commandId("skipped-session-stop"),
          threadId,
          createdAt: yield* nowIso,
        });
        ownedIterationTurnIds.delete(threadId);
      }),

    stopForced: (threadId, options) =>
      Effect.gen(function* () {
        yield* awaitInterruptedTurnClose(threadId, options.graceSeconds);
        yield* dispatchBestEffort("epic.runner.session-stop-failed", {
          type: "thread.session.stop",
          commandId: yield* commandId("session-stop"),
          threadId,
          createdAt: yield* nowIso,
        });
        ownedIterationTurnIds.delete(threadId);
      }),
  };
};
