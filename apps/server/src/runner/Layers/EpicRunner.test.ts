import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  DEFAULT_EPIC_RUN_CONFIG,
  DEFAULT_EPIC_RUN_CONFIG_PROVENANCE,
  EpicRolePolicy as EpicRolePolicySchema,
  EpicRunConfig as EpicRunConfigSchema,
  EpicRunId,
  EpicRunPreflightError,
  EventId,
  MessageId,
  ProjectId,
  PROVIDER_SESSION_RESUME_SETTLED_ACTIVITY_KIND,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationLatestTurn,
  type OrchestrationSessionStatus,
  type OrchestrationThread,
  type ProjectionThreadTurnStatus,
  type EpicRolePolicy,
  type EpicRunPreflightInput,
  type EpicRunPreflightResult,
  type EpicSubagentMap,
  type ModelSelection,
  type ProviderSessionResumeOutcome,
  type ServerProvider,
} from "@t3tools/contracts";
import {
  EPIC_RUN_CONTINUATION_PROMPT,
  epicRunIterationPrompt,
  EPIC_RUN_STALLED_PROGRESS_PROMPT,
} from "@t3tools/epic-core/policy";
import * as ProcessRunner from "@t3tools/epic-core/processRunner";
import {
  EpicRunPreflight,
  formatEpicRunPreflightBlocker,
} from "@t3tools/epic-core/EpicRunPreflight";
import {
  EpicRunConfigSource,
  type EpicRunConfigFileResult,
} from "@t3tools/epic-core/EpicRunConfigSource";
import {
  EpicRunLock,
  EpicRunLockError,
  EpicRunLockHeldError,
  type EpicRunLockLease,
} from "@t3tools/epic-core/ports/EpicRunLock";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  OrchestrationCommandInvariantError,
  type OrchestrationDispatchError,
} from "../../orchestration/Errors.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { runningSubagentLivenessRefusalDetail } from "../../orchestration/subagentLiveness.ts";
import {
  EpicRunStore,
  type EpicRun,
  type EpicRunIteration,
} from "../../persistence/Services/EpicRuns.ts";
import { AgentAwarenessRelay } from "../../relay/AgentAwarenessRelay.ts";
import { ServerConfig } from "../../config.ts";
import { layerTest as serverSettingsLayerTest } from "../../serverSettings.ts";
import {
  ProjectSetupScriptRunner,
  type ProjectSetupScriptRunnerInput,
} from "../../project/ProjectSetupScriptRunner.ts";
import { WorktreeProvisioner, type ProvisionWorktreeInput } from "../../vcs/WorktreeProvisioner.ts";
import { GitVcsDriver } from "../../vcs/GitVcsDriver.ts";
import { makeProviderRegistryLayer } from "../../provider/testUtils/providerRegistryMock.ts";
import { EpicSubagentRegistry } from "../../provider/epicSubagents.ts";
import { EpicWorkerScopeRegistry } from "../../provider/workerScope.ts";
import {
  makeMemoryStore,
  makeThreadDetail,
} from "../../../integration/EpicRunnerHarness.integration.ts";
import { EpicRunner } from "../Services/EpicRunner.ts";
import { assembleIterationPrompt, makeEpicRunnerLive } from "./EpicRunner.ts";

const projectId = ProjectId.make("project-epic-runner");
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5-codex",
} as const;
const NOW = "2026-01-01T00:00:00.000Z";
/** The leftover worker scope `workerScopeCollision` plants. */
const PLANTED_WORKER_SCOPE_UNIT = "cook-epic-deadbeef-iteration-0.scope";
const defaultConfigSnapshot = {
  config: DEFAULT_EPIC_RUN_CONFIG,
  configProvenance: DEFAULT_EPIC_RUN_CONFIG_PROVENANCE,
} as const;
const stubPreflightResult = (
  overrides?: Partial<EpicRunPreflightResult>,
): EpicRunPreflightResult => ({
  ok: true,
  blockers: [],
  warnings: [],
  resolvedConfig: DEFAULT_EPIC_RUN_CONFIG,
  configProvenance: DEFAULT_EPIC_RUN_CONFIG_PROVENANCE,
  ...overrides,
});
const persistedSequentialConfigSnapshot = {
  config: {
    ...DEFAULT_EPIC_RUN_CONFIG,
    limits: { ...DEFAULT_EPIC_RUN_CONFIG.limits, maxIterations: 7 },
    execution: { sequential: true },
    parallel: { ...DEFAULT_EPIC_RUN_CONFIG.parallel, workers: 1 },
  },
  configProvenance: {
    ...DEFAULT_EPIC_RUN_CONFIG_PROVENANCE,
    "limits.maxIterations": "file" as const,
    "execution.sequential": "file" as const,
    "parallel.workers": "policy" as const,
  },
} as const;
const decodeEpicRunConfig = Schema.decodeUnknownSync(EpicRunConfigSchema);
const loadedConfigFile = (
  override: import("@t3tools/contracts").EpicRunConfigOverride,
): EpicRunConfigFileResult => ({
  _tag: "loaded",
  configPath: "/tmp/epic-runner-repo/.t3code/epic-run.json",
  override,
  config: decodeEpicRunConfig(override),
  presentKeys: [],
  unknownKeys: [],
});

const provider = (instanceId: string, driver: string, model: string): ServerProvider => ({
  instanceId: ProviderInstanceId.make(instanceId),
  driver: ProviderDriverKind.make(driver),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: NOW,
  availability: "available",
  models: [{ slug: model, name: model, isCustom: false, capabilities: null }],
  slashCommands: [],
  skills: [],
});

const CLAUDE_WORK_SELECTION = {
  instanceId: ProviderInstanceId.make("claude-work"),
  model: "claude-sonnet-5",
} as const satisfies ModelSelection;
const CLAUDE_PERSONAL_SELECTION = {
  instanceId: ProviderInstanceId.make("claude-personal"),
  model: "claude-sonnet-5",
} as const satisfies ModelSelection;
const CHAIN_CODEX_SELECTION = {
  instanceId: ProviderInstanceId.make("codex-personal"),
  model: "gpt-5.6-sol",
  options: [{ id: "reasoningEffort", value: "high" }],
} as const satisfies ModelSelection;

const decodeEpicRolePolicy = Schema.decodeUnknownSync(EpicRolePolicySchema);

/** A role policy that points the iteration worker at one ordered hop chain. */
const iterationWorkerPolicy = (hops: ReadonlyArray<ModelSelection>): EpicRolePolicy =>
  decodeEpicRolePolicy({
    tiers: { primary: { hops: hops.map((selection) => ({ selection })) } },
    roles: { "iteration-worker": "primary" },
  });

/**
 * What a scripted iteration does when its turn is dispatched. `head` is what
 * the fake git reports *after* the iteration, so a value differing from the
 * previous one is how a test says "this iteration committed".
 */
interface ScriptedIteration {
  readonly text: string | null;
  readonly head: string;
  /** The porcelain fingerprint git reports after this turn settles. */
  readonly worktreeFingerprint?: string;
  /** Commits visible through base..branch when the worker HEAD read is stale. */
  readonly branchCommitCount?: number;
  readonly turnState?: ProjectionThreadTurnStatus;
  readonly sessionStatus?: OrchestrationSessionStatus;
  /** The projected session's `lastError` once the turn settles. */
  readonly sessionLastError?: string;
  readonly streaming?: boolean;
  /** Leave the turn hanging so the iteration has to be cancelled or time out. */
  readonly stall?: boolean;
  /** Keep the turn active for this long before projecting its result. */
  readonly settleDelayMs?: number;
  /** Hold this turn at the running boundary until the test opens the gate. */
  readonly settleGate?: Deferred.Deferred<void>;
  /** Start an unrelated human turn before the runner classifies this turn. */
  readonly humanFollowupText?: string;
  /** Delay the human follow-up until this many thread-detail reads complete. */
  readonly humanFollowupAfterDetailReads?: number;
  /**
   * Number of `getThreadDetailSnapshot` reads, for this iteration's thread,
   * that report no assistant message before the scripted one appears —
   * models the real race where the turn-end signal projects before the
   * assistant message is finalized (`ProviderRuntimeIngestion.ts:1666`
   * dispatches the session-set first). Requires `text` to be non-null: it delays the message, it
   * doesn't fabricate one.
   */
  readonly messageSettleDelayReads?: number;
  /**
   * Report `latestTurn: null` on the thread detail even though the turn has
   * settled, modelling the window in which the settling transaction has nulled
   * `threads.latest_turn_id` (`ProjectionPipeline.ts:757-771`) and the
   * checkpoint reactor has not yet restored it. The shell still reports the
   * settled turn, because `awaitTurnEnd` reads the shell and must still finish.
   * Classification then has only the session status to go on.
   */
  readonly detailTurnPointerNull?: boolean;
  /** Restore a transiently null latest-turn pointer after these detail reads. */
  readonly restoreTurnPointerAfterDetailReads?: number;
  /**
   * Number of `getThreadDetailSnapshot` reads, for this iteration's thread,
   * that report one FRESH `running` subagent before it flips to `completed` —
   * models the incident where the turn ended while a Task subagent was still
   * working. `Number.POSITIVE_INFINITY` keeps it running forever, for the
   * grace-timeout path. The row's `updatedAt` is stamped from the real clock
   * at read time, because the runner's freshness window is real-clock too.
   */
  readonly subagentDrainReads?: number;
}

interface ScriptedIssueEvidence {
  readonly status?: string;
  readonly title?: string;
  readonly commentCount?: number;
  readonly exitCode?: number;
}

const waitFor = (predicate: () => boolean) =>
  Effect.gen(function* () {
    while (!predicate()) {
      yield* Effect.sleep("5 millis");
    }
  }).pipe(Effect.timeout("4 seconds"));

/** Give already-scheduled fibers room to run, to assert that nothing else happens. */
const settle = Effect.sleep("60 millis");

const makeTempWorkspace = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-epic-prompt-test-" });
});

const encodeEpicDescription = Schema.encodeSync(
  Schema.fromJsonString(Schema.Array(Schema.Struct({ description: Schema.String }))),
);
const encodeUnknownJson = Schema.encodeSync(Schema.UnknownFromJsonString);

const writeWorkspaceFiles = Effect.fn("EpicRunner.test.writeWorkspaceFiles")(function* (
  workspace: string,
  files: Readonly<Record<string, string>>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  for (const [relativePath, contents] of Object.entries(files)) {
    const absolutePath = path.join(workspace, relativePath);
    yield* fileSystem.makeDirectory(path.dirname(absolutePath), { recursive: true });
    yield* fileSystem.writeFileString(absolutePath, contents);
  }
});

const captureLogs = () => {
  const messages: ReadonlyArray<unknown>[] = [];
  const entries: Array<{
    readonly logLevel: string;
    readonly message: ReadonlyArray<unknown>;
  }> = [];
  const logger = Logger.make<unknown, void>(({ message, logLevel }) => {
    const normalizedMessage = Array.isArray(message) ? message : [message];
    messages.push(normalizedMessage);
    entries.push({ logLevel, message: normalizedMessage });
  });
  return {
    entries,
    messages,
    layer: Logger.layer([logger], { mergeWithExisting: false }),
  };
};

let harnessSequence = 0;

function createHarness(input: {
  readonly script: ReadonlyArray<ScriptedIteration>;
  readonly initialHead?: string;
  readonly initialWorktreeFingerprint?: string;
  readonly options?: Parameters<typeof makeEpicRunnerLive>[0];
  readonly seedRuns?: ReadonlyArray<EpicRun>;
  readonly seedIterations?: ReadonlyArray<EpicRunIteration>;
  readonly workspaceRoot?: string;
  readonly preflightResult?: EpicRunPreflightResult;
  readonly preflightResults?: ReadonlyArray<EpicRunPreflightResult>;
  readonly onLockAcquire?: () => void;
  readonly onLockRelease?: () => void;
  readonly beforeLockAcquire?: Effect.Effect<void>;
  readonly lockAcquireError?: EpicRunLockError | EpicRunLockHeldError;
  /** Plant a pre-existing worker scope unit so scope preparation collides. */
  readonly workerScopeCollision?: boolean;
  readonly preflightError?: EpicRunPreflightError;
  readonly configFileResult?: EpicRunConfigFileResult;
  readonly upsertDelayMs?: number;
  /** Hold append open after its running row is visible, for boundary-race tests. */
  readonly appendIterationDelayMs?: number;
  /** Hold worktree setup after thread creation, before the provider turn starts. */
  readonly setupGate?: Deferred.Deferred<void>;
  /** Per-thread setup barrier for out-of-order dispatch tests. */
  readonly beforeSetupCompletes?: (request: ProjectSetupScriptRunnerInput) => Effect.Effect<void>;
  readonly providers?: ReadonlyArray<ServerProvider>;
  readonly projectDefaultModelSelection?: import("@t3tools/contracts").ModelSelection;
  readonly readyOutput?: string;
  /** Complete child listing used to distinguish done from a blocked frontier. */
  readonly openChildren?: ReadonlyArray<{ readonly id: string; readonly status: string }>;
  /** Mutable ready frontier used by worker-pool tests. */
  readonly readyChildren?: ReadonlyArray<string>;
  /** Epic descriptions returned in order by per-iteration `bd show`. */
  readonly epicDescriptions?: ReadonlyArray<string>;
  readonly epicDescriptionExitCode?: number;
  readonly onEpicRunPublish?: (run: import("@t3tools/contracts").EpicRun) => Effect.Effect<void>;
  /**
   * Seeds `bd show <id> --json`'s status for specific issue ids, and lets
   * `releaseClaimedChild`'s `bd update <id> --status open` calls be observed
   * flipping it. Ids not listed here fall through to the generic `bd`
   * response below (which `decodeIssueStatus` cannot parse as a status, so
   * `releaseClaimedChild` treats them as unknown and leaves them alone).
   */
  readonly childStatuses?: Record<string, string>;
  /** Who `bd merge-slot check` reports as holding the slot; absent means free. */
  readonly mergeSlotHolder?: string;
  /** Ordered `bd show` evidence reads for each child, clamped at the final entry. */
  readonly childEvidence?: Record<string, ReadonlyArray<ScriptedIssueEvidence>>;
  /** `bd label list <id>` output for children whose title is not research-prefixed. */
  readonly childLabels?: Record<string, string>;
  /** Command types the stub engine refuses. The command is still recorded. */
  readonly refuseCommandTypes?: ReadonlyArray<OrchestrationCommand["type"]>;
  /** Refuse only EpicRunner status turns sent to a run's origin thread. */
  readonly refuseOriginStatusCommands?: boolean;
  /** Guarded normal-stop refusals that simulate a subagent starting after the advisory read. */
  readonly guardedStopRefusals?: number;
  /** Model a parallel branch HEAD that moves while the base checkout stays put. */
  readonly separateWorkerHead?: boolean;
  /** Inject an allocation defect after this child's worktree is provisioned. */
  readonly failAllocationFor?: string;
  readonly failInitializeMergeState?: boolean;
  /** Fail run enrichment after a run row has already been stored. */
  readonly failListIterations?: boolean;
  readonly workerProvisionPath?: string;
  readonly integrationProvisionPath?: string;
  /** Per-cwd `git rev-list --count` responses; fallback is the scripted branch count. */
  readonly revListCommitCounts?: Readonly<Record<string, number>>;
  /** Per-cwd `git rev-parse` head responses; fallback is the harness head. */
  readonly repositoryHeads?: Readonly<Record<string, string>>;
  /** Paths `git worktree list --porcelain` reports; absent means none. */
  readonly registeredWorktrees?: ReadonlyArray<string>;
  /**
   * What a `thread.session.resume` settles on, per thread. Threads not listed
   * settle `resumed`, which is what a live provider session does after a
   * restart that left its cursor intact.
   */
  readonly resumeOutcomes?: Readonly<Record<string, ProviderSessionResumeOutcome>>;
  /**
   * Threads that exist before any run does, so a launch can read one as its
   * origin. Each is served as a live shell with the given project and model
   * selection, which is what `inheritOriginModelSelection` reads.
   */
  readonly originThreadShells?: Readonly<
    Record<string, { readonly projectId?: ProjectId; readonly modelSelection: ModelSelection }>
  >;
  /** The global epic role policy; absent means no policy, the legacy path. */
  readonly epicRolePolicy?: EpicRolePolicy;
}) {
  const store = makeMemoryStore(input.upsertDelayMs, input.appendIterationDelayMs);
  if (input.failAllocationFor !== undefined) {
    const allocateIteration = store.shape.allocateIteration;
    Object.assign(store.shape, {
      allocateIteration: (request: Parameters<typeof allocateIteration>[0]) =>
        request.branch === `epic/${input.failAllocationFor}`
          ? Effect.die(new Error("injected allocation failure"))
          : allocateIteration(request),
    });
  }
  if (input.failInitializeMergeState === true) {
    Object.assign(store.shape, {
      initializeMergeState: () => Effect.die(new Error("injected merge-state failure")),
    });
  }
  if (input.failListIterations === true) {
    Object.assign(store.shape, {
      listIterations: () => Effect.die(new Error("injected list-iterations failure")),
    });
  }
  const repositoryRoot = input.workspaceRoot ?? "/tmp/epic-runner-repo";
  for (const run of input.seedRuns ?? []) {
    store.runs.set(run.runId, run);
  }
  store.iterations.push(...(input.seedIterations ?? []));
  const childStatuses = new Map(Object.entries(input.childStatuses ?? {}));
  const childEvidenceReads = new Map<string, number>();

  const dispatched: OrchestrationCommand[] = [];
  const details = new Map<string, OrchestrationThread>();
  const activeTurnIds = new Map<string, TurnId>();
  const turnsByMessageId = new Map<string, OrchestrationLatestTurn>();
  const shells = new Map<
    string,
    {
      readonly latestTurn: ProjectionThreadTurnStatus | null;
      readonly session: OrchestrationSessionStatus;
    }
  >();
  for (const originThreadId of Object.keys(input.originThreadShells ?? {})) {
    shells.set(originThreadId, { latestTurn: "completed", session: "ready" });
  }
  let head = input.initialHead ?? "head-0";
  const baseHead = input.initialHead ?? "head-0";
  let worktreeFingerprint = input.initialWorktreeFingerprint ?? "";
  let branchCommitCount = 0;
  let turnsStarted = 0;
  let activeTurns = 0;
  let maxActiveTurns = 0;
  const startedIssueIds: string[] = [];
  const readyChildren = new Set(input.readyChildren ?? []);
  let sequence = 0;
  let shellReads = 0;
  const processRequests: ProcessRunner.ProcessRunInput[] = [];
  let plantedScopeUnitStopped = false;
  const heldLocks = new Set<string>();
  // Remaining `getThreadDetailSnapshot` reads, per thread, that must report no
  // assistant message before the real one is revealed — see
  // `ScriptedIteration.messageSettleDelayReads`.
  const messageSettleDelayReads = new Map<string, number>();
  // Remaining detail reads, per thread, that report a fresh running subagent —
  // see `ScriptedIteration.subagentDrainReads`.
  const subagentDrainReads = new Map<string, number>();
  const delayedHumanFollowups = new Map<
    string,
    { readonly text: string; readonly scriptIndex: number; remainingReads: number }
  >();
  const delayedTurnPointerRestorations = new Map<
    string,
    { readonly detail: OrchestrationThread; remainingReads: number }
  >();
  const stopsWithRunningSubagents: ThreadId[] = [];
  let guardedStopRefusals = input.guardedStopRefusals ?? 0;
  let epicDescriptionReads = 0;
  const configReadRoots: string[] = [];
  const preflightModes: Array<"parallel" | "sequential"> = [];
  const preflightInputs: Array<EpicRunPreflightInput> = [];
  const provisionInputs: ProvisionWorktreeInput[] = [];
  const integrationProvisionInputs: ProvisionWorktreeInput[] = [];
  const releasedWorktrees: string[] = [];
  const setupInputs: ProjectSetupScriptRunnerInput[] = [];
  const iterationLifecycle: string[] = [];
  const subagentBindings: Array<{
    readonly threadId: ThreadId;
    readonly subagents: EpicSubagentMap;
  }> = [];
  const releasedSubagentRuns: EpicRunId[] = [];
  harnessSequence += 1;
  const worktreesDir = `/tmp/t3-epic-runner-worktrees-${harnessSequence}`;
  let landedHead = baseHead;

  const projectHumanFollowup = (args: {
    readonly threadId: ThreadId;
    readonly scriptIndex: number;
    readonly text: string;
    readonly settledDetail: OrchestrationThread;
  }) => {
    const humanTurnId = TurnId.make(`${args.threadId}-human-turn-${args.scriptIndex + 1}`);
    activeTurnIds.set(args.threadId, humanTurnId);
    const humanDetail = makeThreadDetail({
      threadId: args.threadId,
      turnId: humanTurnId,
      turnState: "running",
      text: args.text,
      streaming: true,
      sessionStatus: "running",
    });
    details.set(args.threadId, {
      ...humanDetail,
      messages: [...args.settledDetail.messages, ...humanDetail.messages],
    });
    shells.set(args.threadId, { latestTurn: "running", session: "running" });
  };

  /**
   * Project one scripted iteration's outcome. The thread is seen `running`
   * first and only then settles, exactly as the real projector would do it, so
   * the runner's poll cannot mistake a starting session for a finished turn.
   */
  const simulateTurn = (threadId: ThreadId, messageId: MessageId) =>
    Effect.gen(function* () {
      const scriptIndex = turnsStarted;
      const scripted = input.script[scriptIndex];
      turnsStarted += 1;
      if (scripted === undefined) {
        return;
      }

      const issueId = store.iterations.find(
        (iteration) => iteration.threadId === threadId,
      )?.issueId;
      if (issueId !== null && issueId !== undefined) startedIssueIds.push(issueId);
      activeTurns += 1;
      maxActiveTurns = Math.max(maxActiveTurns, activeTurns);

      const scriptedTurnId = TurnId.make(`${threadId}-turn-${scriptIndex + 1}`);
      turnsByMessageId.set(messageId, {
        turnId: scriptedTurnId,
        state: "running",
        requestedAt: NOW,
        startedAt: NOW,
        completedAt: null,
        assistantMessageId: null,
      });
      activeTurnIds.set(threadId, scriptedTurnId);
      shells.set(threadId, { latestTurn: "running", session: "running" });
      if (scripted.stall === true) {
        return;
      }

      // A beat of "the turn is live" before it settles.
      yield* Effect.sleep(`${scripted.settleDelayMs ?? 2} millis`);
      if (scripted.settleGate !== undefined) yield* Deferred.await(scripted.settleGate);

      head = scripted.head;
      branchCommitCount = scripted.branchCommitCount ?? 0;
      if (scripted.worktreeFingerprint !== undefined) {
        worktreeFingerprint = scripted.worktreeFingerprint;
      }
      const settledDetail = makeThreadDetail({
        threadId,
        // Unique per dispatched turn: a continuation turn on the same thread
        // must project a NEW turn id, exactly as provider adoption would,
        // or `awaitTurnEnd`'s prior-turn mask could never see it end.
        turnId: scriptedTurnId,
        turnState: scripted.turnState ?? "completed",
        text: scripted.text,
        streaming: scripted.streaming ?? false,
        latestTurnPointerNull: scripted.detailTurnPointerNull ?? false,
        sessionStatus: scripted.sessionStatus ?? "ready",
        sessionLastError: scripted.sessionLastError,
      });
      turnsByMessageId.set(messageId, {
        turnId: scriptedTurnId,
        state: scripted.turnState ?? "completed",
        requestedAt: NOW,
        startedAt: NOW,
        completedAt: NOW,
        assistantMessageId: settledDetail.latestTurn?.assistantMessageId ?? null,
      });
      if (
        scripted.humanFollowupText === undefined ||
        scripted.humanFollowupAfterDetailReads !== undefined
      ) {
        details.set(threadId, settledDetail);
        if (scripted.humanFollowupText !== undefined) {
          delayedHumanFollowups.set(threadId, {
            text: scripted.humanFollowupText,
            scriptIndex,
            remainingReads: scripted.humanFollowupAfterDetailReads ?? 0,
          });
        }
      } else {
        projectHumanFollowup({
          threadId,
          scriptIndex,
          text: scripted.humanFollowupText,
          settledDetail,
        });
      }
      if (
        scripted.detailTurnPointerNull === true &&
        scripted.restoreTurnPointerAfterDetailReads !== undefined
      ) {
        delayedTurnPointerRestorations.set(threadId, {
          detail: makeThreadDetail({
            threadId,
            turnId: scriptedTurnId,
            turnState: scripted.turnState ?? "completed",
            text: scripted.text,
            streaming: scripted.streaming ?? false,
            sessionStatus: scripted.sessionStatus ?? "ready",
            sessionLastError: scripted.sessionLastError,
          }),
          remainingReads: scripted.restoreTurnPointerAfterDetailReads,
        });
      }
      if (scripted.messageSettleDelayReads !== undefined) {
        messageSettleDelayReads.set(threadId, scripted.messageSettleDelayReads);
      }
      if (scripted.subagentDrainReads !== undefined) {
        subagentDrainReads.set(threadId, scripted.subagentDrainReads);
      }
      shells.set(
        threadId,
        scripted.humanFollowupText === undefined ||
          scripted.humanFollowupAfterDetailReads !== undefined
          ? {
              latestTurn: scripted.turnState ?? "completed",
              session: scripted.sessionStatus ?? "ready",
            }
          : { latestTurn: "running", session: "running" },
      );
      activeTurns -= 1;
      iterationLifecycle.push("turn-settled");
      if (issueId !== null && issueId !== undefined) readyChildren.delete(issueId);
    });

  const engineLayer = Layer.succeed(OrchestrationEngineService, {
    readEvents: () => Stream.empty,
    latestSequence: Effect.sync(() => sequence),
    streamDomainEvents: Stream.never,
    dispatch: (
      command: OrchestrationCommand,
    ): Effect.Effect<{ sequence: number }, OrchestrationDispatchError> =>
      Effect.gen(function* () {
        dispatched.push(command);
        if (command.type === "thread.create" || command.type === "thread.turn.start") {
          iterationLifecycle.push(command.type);
        }
        if (
          command.type === "thread.session.stop" &&
          command.preserveRunningSubagents === true &&
          guardedStopRefusals > 0
        ) {
          guardedStopRefusals -= 1;
          subagentDrainReads.set(command.threadId, 2);
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: runningSubagentLivenessRefusalDetail(command.threadId, 1, "stopped"),
          });
        }
        if (
          command.type === "thread.session.stop" &&
          (subagentDrainReads.get(command.threadId) ?? 0) > 0
        ) {
          stopsWithRunningSubagents.push(command.threadId);
        }
        // The real reactor answers a resume long after `dispatch` returns, by
        // appending a durable activity to the thread. Mirror that: the runner
        // polls the detail snapshot for it, so it has to be findable there.
        if (command.type === "thread.session.resume") {
          const base =
            details.get(command.threadId) ??
            makeThreadDetail({
              threadId: command.threadId,
              turnId: TurnId.make(`${command.threadId}-turn-interrupted`),
              turnState: "completed",
              text: null,
              streaming: false,
              latestTurnPointerNull: true,
              sessionStatus: "stopped",
            });
          details.set(command.threadId, {
            ...base,
            activities: [
              ...base.activities,
              {
                id: EventId.make(`${command.threadId}-resume-settled-${String(sequence)}`),
                tone: "info" as const,
                kind: PROVIDER_SESSION_RESUME_SETTLED_ACTIVITY_KIND,
                summary: "resume settled",
                payload: {
                  threadId: command.threadId,
                  requestCommandId: command.commandId,
                  outcome: input.resumeOutcomes?.[command.threadId] ?? { _tag: "resumed" as const },
                },
                turnId: null,
                createdAt: NOW,
              },
            ],
          });
        }
        const targetsOriginThread =
          command.type === "thread.turn.start" &&
          [...store.runs.values()].some((run) => run.originThreadId === command.threadId);
        if (input.refuseCommandTypes?.includes(command.type) === true) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: "refused by test harness",
          });
        }
        if (input.refuseOriginStatusCommands === true && targetsOriginThread) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: "refused origin status command by test harness",
          });
        }
        if (command.type === "thread.turn.start" && !targetsOriginThread) {
          // Forked so `dispatch` returns before the turn resolves, the way the
          // real engine behaves.
          yield* Effect.forkDetach(simulateTurn(command.threadId, command.message.messageId));
        }
        sequence += 1;
        return { sequence };
      }),
  });

  const snapshotLayer = Layer.succeed(ProjectionSnapshotQuery, {
    getTurnByPendingMessageId: (_threadId, messageId) =>
      Effect.succeed(Option.fromNullishOr(turnsByMessageId.get(messageId))),
    getCommandReadModel: () => Effect.die("unused"),
    getSnapshot: () => Effect.die("unused"),
    getShellSnapshot: () => Effect.die("unused"),
    getArchivedShellSnapshot: () => Effect.die("unused"),
    getSnapshotSequence: () => Effect.succeed({ snapshotSequence: sequence }),
    getCounts: () => Effect.die("unused"),
    getActiveProjectByWorkspaceRoot: () => Effect.die("unused"),
    getProjectShellById: (id) =>
      Effect.succeed(
        Option.some({
          id,
          title: "Epic project",
          workspaceRoot: input.workspaceRoot ?? "/tmp/epic-runner-repo",
          defaultModelSelection: input.projectDefaultModelSelection ?? modelSelection,
          scripts: [],
          createdAt: NOW,
          updatedAt: NOW,
        }),
      ),
    getFirstActiveThreadIdByProjectId: () => Effect.die("unused"),
    listChildThreadIds: () => Effect.die("unused"),
    listRunningThreadBackedSubagents: () => Effect.die("unused"),
    listThreadIdsWithQueuedMessages: () => Effect.die("unused"),
    getThreadCheckpointContext: () => Effect.die("unused"),
    getFullThreadDiffContext: () => Effect.die("unused"),
    listSubagentTurnContributions: () => Effect.succeed([]),
    getThreadShellById: (threadId) =>
      Effect.sync(() => {
        shellReads += 1;
        const shell = shells.get(threadId);
        if (shell === undefined) {
          return Option.none();
        }
        const origin = input.originThreadShells?.[threadId];
        return Option.some({
          id: threadId,
          projectId: origin?.projectId ?? projectId,
          title: "Epic iteration",
          modelSelection: origin?.modelSelection ?? modelSelection,
          runtimeMode: "full-access" as const,
          interactionMode: "default" as const,
          branch: null,
          worktreePath: null,
          latestTurn:
            shell.latestTurn === null
              ? null
              : {
                  turnId:
                    activeTurnIds.get(threadId) ??
                    details.get(threadId)?.latestTurn?.turnId ??
                    TurnId.make(`${threadId}-turn`),
                  state: shell.latestTurn,
                  requestedAt: NOW,
                  startedAt: NOW,
                  completedAt: shell.latestTurn === "running" ? null : NOW,
                  assistantMessageId: details.get(threadId)?.latestTurn?.assistantMessageId ?? null,
                },
          createdAt: NOW,
          updatedAt: NOW,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          session: {
            threadId,
            status: shell.session,
            providerName: "codex",
            runtimeMode: "full-access" as const,
            activeTurnId: null,
            lastError: null,
            updatedAt: NOW,
          },
          latestUserMessageAt: NOW,
          hasPendingApprovals: false,
          hasPendingUserInput: false,
          hasActionableProposedPlan: false,
          activeSubagentCount: 0,
          parentThreadId: null,
        });
      }),
    getThreadSessionById: (threadId) =>
      Effect.sync(() => {
        const shell = shells.get(threadId);
        if (shell === undefined) {
          return Option.none();
        }
        return Option.some({
          threadId,
          status: shell.session,
          providerName: "codex",
          runtimeMode: "full-access" as const,
          activeTurnId: null,
          lastError: null,
          updatedAt: NOW,
        });
      }),
    getThreadSubagentLiveness: () =>
      Effect.succeed({ activeSubagentCount: 0, newestRunningUpdatedAt: null }),
    getSubagentActivities: () =>
      Effect.succeed({ activities: [], hasMore: false, nextBefore: null }),
    getThreadDetailById: () => Effect.die("unused"),
    getThreadDetailSnapshot: (threadId) =>
      Effect.gen(function* () {
        const detail = details.get(threadId);
        if (detail === undefined) {
          return Option.none();
        }
        let thread = detail;
        const delayedTurnPointerRestoration = delayedTurnPointerRestorations.get(threadId);
        if (delayedTurnPointerRestoration !== undefined) {
          delayedTurnPointerRestoration.remainingReads -= 1;
          if (delayedTurnPointerRestoration.remainingReads <= 0) {
            delayedTurnPointerRestorations.delete(threadId);
            details.set(threadId, delayedTurnPointerRestoration.detail);
          }
        }
        const delayedHumanFollowup = delayedHumanFollowups.get(threadId);
        if (delayedHumanFollowup !== undefined) {
          delayedHumanFollowup.remainingReads -= 1;
          if (delayedHumanFollowup.remainingReads <= 0) {
            delayedHumanFollowups.delete(threadId);
            projectHumanFollowup({
              threadId,
              scriptIndex: delayedHumanFollowup.scriptIndex,
              text: delayedHumanFollowup.text,
              settledDetail: detail,
            });
          }
        }
        const remainingSubagentReads = subagentDrainReads.get(threadId);
        if (remainingSubagentReads !== undefined) {
          const running = remainingSubagentReads > 0;
          if (running && Number.isFinite(remainingSubagentReads)) {
            subagentDrainReads.set(threadId, remainingSubagentReads - 1);
          }
          // Use the same Effect clock as the runner's freshness check.
          const stampedAt = DateTime.formatIso(yield* DateTime.now);
          thread = {
            ...thread,
            subagents: [
              {
                subagentId: `task-${threadId}`,
                turnId: TurnId.make(`${threadId}-turn`),
                status: running ? "running" : "completed",
                startedAt: stampedAt,
                updatedAt: stampedAt,
                completedAt: running ? null : stampedAt,
              },
            ],
          };
        }
        const remainingDelay = messageSettleDelayReads.get(threadId) ?? 0;
        if (remainingDelay > 0) {
          messageSettleDelayReads.set(threadId, remainingDelay - 1);
          // Report the turn as message-less on this read, exactly like the
          // real projector before the assistant row has finalized.
          return Option.some({
            snapshotSequence: sequence,
            thread: {
              ...thread,
              messages: [],
              latestTurn:
                thread.latestTurn === null
                  ? null
                  : { ...thread.latestTurn, assistantMessageId: null },
            },
          });
        }
        return Option.some({ snapshotSequence: sequence, thread });
      }),
  });

  const processRunnerLayer = Layer.succeed(ProcessRunner.ProcessRunner, {
    run: (request: ProcessRunner.ProcessRunInput) =>
      Effect.sync(() => {
        processRequests.push(request);
        const subcommand = request.args[0];
        const issueId = request.args[1];
        if (request.command === "git" && subcommand === "show-ref") {
          const ref = request.args.at(-1) ?? "";
          return {
            stdout: "",
            stderr: "",
            code: (ref.includes("cook-epic-integration-") ? 1 : 0) as never,
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
          };
        }
        // `worktree list` is how a resume proves the worktree it means to
        // adopt is still attached to the run's checkout.
        if (
          request.command === "git" &&
          request.args.includes("worktree") &&
          request.args.includes("list")
        ) {
          return {
            stdout: (input.registeredWorktrees ?? [])
              .map((worktreePath) => `worktree ${worktreePath}\n`)
              .join(""),
            stderr: "",
            code: 0 as never,
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
          };
        }
        if (
          request.command === "git" &&
          subcommand === "rev-parse" &&
          request.args.includes("--git-common-dir")
        ) {
          return {
            stdout: `${repositoryRoot}/.git\n`,
            stderr: "",
            code: 0 as never,
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
          };
        }
        if (
          request.command === "git" &&
          subcommand === "merge" &&
          request.args[1] === "--ff-only" &&
          request.cwd === repositoryRoot
        ) {
          landedHead = head;
        }
        if (request.command === "bd" && subcommand === "list") {
          return {
            stdout: encodeUnknownJson(input.openChildren ?? []),
            stderr: "",
            code: 0 as never,
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
          };
        }
        if (request.command === "bd" && subcommand === "show" && issueId === "epic-1") {
          const description =
            input.epicDescriptions?.[
              Math.min(turnsStarted, (input.epicDescriptions?.length ?? 1) - 1)
            ];
          epicDescriptionReads += 1;
          return {
            stdout: description === undefined ? "[]" : encodeEpicDescription([{ description }]),
            stderr: input.epicDescriptionExitCode === undefined ? "" : "bd unavailable",
            code: (input.epicDescriptionExitCode ?? 0) as never,
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
          };
        }
        if (
          request.command === "bd" &&
          subcommand === "show" &&
          issueId !== undefined &&
          input.childEvidence?.[issueId] !== undefined
        ) {
          const evidence = input.childEvidence[issueId];
          const readIndex = childEvidenceReads.get(issueId) ?? 0;
          childEvidenceReads.set(issueId, readIndex + 1);
          const value = evidence[Math.min(readIndex, evidence.length - 1)];
          return {
            stdout:
              value === undefined
                ? "[]"
                : encodeUnknownJson([
                    {
                      ...(value.status === undefined ? {} : { status: value.status }),
                      ...(value.title === undefined ? {} : { title: value.title }),
                      ...(value.commentCount === undefined
                        ? {}
                        : { comment_count: value.commentCount }),
                    },
                  ]),
            stderr: value?.exitCode === undefined ? "" : "bd unavailable",
            code: (value?.exitCode ?? 0) as never,
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
          };
        }
        if (
          request.command === "bd" &&
          subcommand === "show" &&
          issueId !== undefined &&
          childStatuses.has(issueId)
        ) {
          return {
            stdout: `[{"status":"${childStatuses.get(issueId)}"}]`,
            stderr: "",
            code: 0 as never,
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
          };
        }
        if (request.command === "bd" && subcommand === "label" && request.args[1] === "list") {
          const labelledIssueId = request.args[2];
          return {
            stdout:
              labelledIssueId === undefined ? "" : (input.childLabels?.[labelledIssueId] ?? ""),
            stderr: "",
            code: 0 as never,
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
          };
        }
        if (
          request.command === "bd" &&
          subcommand === "update" &&
          issueId !== undefined &&
          childStatuses.has(issueId) &&
          request.args.includes("--status")
        ) {
          const statusIndex = request.args.indexOf("--status");
          const newStatus = request.args[statusIndex + 1];
          if (newStatus !== undefined) {
            childStatuses.set(issueId, newStatus);
          }
        }
        if (
          request.command === "bd" &&
          subcommand === "merge-slot" &&
          request.args[1] === "check"
        ) {
          const holder = input.mergeSlotHolder ?? null;
          return {
            stdout: encodeUnknownJson({
              available: holder === null,
              holder,
              id: "epic-merge-slot",
            }),
            stderr: "",
            code: 0 as never,
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
          };
        }
        // The run loop prepares one systemd worker scope per run
        // (prepareWorkerScope): the probe succeeds, no pre-existing units
        // collide unless the test plants one, and slice limits are accepted.
        if (request.command === "systemd-run" || request.command === "systemctl") {
          const listsUnits = request.command === "systemctl" && request.args.includes("list-units");
          // A planted unit answers every probe until it is stopped, which is
          // what a real reclaim does to it.
          if (
            request.command === "systemctl" &&
            request.args[1] === "stop" &&
            request.args[2] === PLANTED_WORKER_SCOPE_UNIT
          ) {
            plantedScopeUnitStopped = true;
          }
          return {
            stdout:
              listsUnits && input.workerScopeCollision === true && !plantedScopeUnitStopped
                ? `${PLANTED_WORKER_SCOPE_UNIT} loaded active running\n`
                : "",
            stderr: "",
            code: 0 as never,
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
          };
        }
        return {
          stdout:
            request.command === "bd"
              ? (input.readyOutput ??
                (input.readyChildren === undefined
                  ? undefined
                  : encodeUnknownJson(
                      [...readyChildren].map((id) => ({ id, parent: request.args[2] })),
                    )) ??
                `[{"id":"child-${turnsStarted + 1}","parent":"${request.args[2] ?? "epic-1"}"}]`)
              : request.args[0] === "symbolic-ref"
                ? "mine\n"
                : request.args[0] === "rev-list"
                  ? `${input.revListCommitCounts?.[request.cwd ?? ""] ?? branchCommitCount}\n`
                  : request.args[0] === "status"
                    ? worktreeFingerprint
                    : request.args[0] === "rev-parse" &&
                        store.mergeStates.size > 0 &&
                        request.cwd === repositoryRoot
                      ? `${landedHead}\n`
                      : `${input.repositoryHeads?.[request.cwd ?? ""] ?? head}\n`,
          stderr: "",
          code: 0 as never,
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
        };
      }),
    runStreaming: () => Effect.die("unused"),
  } as never);
  const gitVcsLayer = Layer.effect(
    GitVcsDriver,
    Effect.gen(function* () {
      const runner = yield* ProcessRunner.ProcessRunner;
      return GitVcsDriver.of({
        execute: (request: Parameters<GitVcsDriver["Service"]["execute"]>[0]) =>
          runner
            .run({
              command: "git",
              args: request.args,
              cwd: request.cwd,
              maxOutputBytes: request.maxOutputBytes,
            })
            .pipe(
              Effect.map((result) => ({
                exitCode: result.code,
                stdout: result.stdout,
                stderr: result.stderr,
                stdoutTruncated: result.stdoutTruncated,
                stderrTruncated: result.stderrTruncated,
              })),
            ),
      } as never);
    }),
  ).pipe(Layer.provide(processRunnerLayer));

  const layer = makeEpicRunnerLive({
    pollIntervalMs: 5,
    quietPeriodMs: 5,
    retryBaseDelayMs: 5,
    retryMaxDelayMs: 10,
    iterationTimeoutMs: 500,
    ...input.options,
  }).pipe(
    Layer.provide(
      Layer.succeed(EpicRunPreflight, {
        check: (preflightInput) => {
          const callIndex = preflightModes.length;
          preflightModes.push(preflightInput.mode);
          preflightInputs.push(preflightInput);
          if (input.preflightError !== undefined) return Effect.fail(input.preflightError);
          const configured =
            input.preflightResults?.[Math.min(callIndex, input.preflightResults.length - 1)] ??
            input.preflightResult;
          if (configured !== undefined) return Effect.succeed(configured);
          // The real preflight probes each resume worktree against `git
          // worktree list` and the filesystem. Derive the same warning from
          // the same source the process stub answers `worktree list` from, so
          // a test cannot describe a worktree as present here and absent there.
          const missingResumeWorktrees = (preflightInput.resume?.worktreePaths ?? []).filter(
            (worktreePath) => !(input.registeredWorktrees ?? []).includes(worktreePath),
          );
          return Effect.succeed(
            stubPreflightResult(
              missingResumeWorktrees.length === 0
                ? undefined
                : {
                    warnings: [
                      {
                        _tag: "resume_worktree_missing",
                        paths: [...missingResumeWorktrees].toSorted(),
                      },
                    ],
                  },
            ),
          );
        },
      }),
    ),
    Layer.provide(
      Layer.succeed(EpicRunConfigSource, {
        read: ({ repoRoot }) =>
          Effect.sync(() => {
            configReadRoots.push(repoRoot);
            return input.configFileResult ?? { _tag: "absent" };
          }),
      }),
    ),
    Layer.provide(
      Layer.succeed(EpicRunLock, {
        // @effect-diagnostics-next-line effectSucceedWithVoid:off
        inspect: () => Effect.succeed(undefined),
        acquire: (
          lockInput,
        ): Effect.Effect<EpicRunLockLease, EpicRunLockError | EpicRunLockHeldError> =>
          Effect.gen(function* () {
            yield* input.beforeLockAcquire ?? Effect.void;
            if (input.lockAcquireError !== undefined) {
              return yield* Effect.fail(input.lockAcquireError);
            }
            const path = `/tmp/${lockInput.epicId}`;
            if (heldLocks.has(path)) {
              return yield* Effect.fail(new EpicRunLockHeldError(path, undefined));
            }
            heldLocks.add(path);
            input.onLockAcquire?.();
            return {
              path,
              owner: {
                owner: "t3code",
                host: "test",
                pid: process.pid,
                pgid: process.pid,
                runDir: lockInput.runDir,
                startedAt: NOW,
                heartbeatAt: 0,
              },
              heartbeat: Effect.succeed(true),
              release: Effect.sync(() => {
                heldLocks.delete(path);
                input.onLockRelease?.();
                return true;
              }),
            };
          }),
      }),
    ),
    Layer.provide(engineLayer),
    Layer.provide(snapshotLayer),
    Layer.provide(processRunnerLayer),
    Layer.provide(gitVcsLayer),
    Layer.provide(
      Layer.succeed(WorktreeProvisioner, {
        provision: (request) =>
          Effect.sync(() => {
            if (request.branch?.startsWith("cook-epic-integration-") === true) {
              integrationProvisionInputs.push(request);
            } else {
              provisionInputs.push(request);
            }
            const provisionedPath =
              request.branch?.startsWith("cook-epic-integration-") === true
                ? (input.integrationProvisionPath ?? request.path ?? `${worktreesDir}/default`)
                : (input.workerProvisionPath ?? request.path ?? `${worktreesDir}/default`);
            return {
              path: provisionedPath,
              refName: request.branch ?? request.baseBranch,
            };
          }),
        release: ({ worktreePath }) =>
          Effect.sync(() => {
            releasedWorktrees.push(worktreePath);
          }),
      }),
    ),
    Layer.provide(
      Layer.succeed(ProjectSetupScriptRunner, {
        runForThread: (request) =>
          Effect.sync(() => {
            setupInputs.push(request);
            iterationLifecycle.push("setup");
            return { status: "no-script" } as const;
          }).pipe(
            Effect.tap(
              () =>
                input.beforeSetupCompletes?.(request) ??
                (input.setupGate === undefined ? Effect.void : Deferred.await(input.setupGate)),
            ),
          ),
      }),
    ),
    Layer.provide(Layer.succeed(ServerConfig, { worktreesDir } as ServerConfig["Service"])),
    Layer.provide(makeProviderRegistryLayer(input.providers ?? [])),
    Layer.provide(
      serverSettingsLayerTest(
        input.epicRolePolicy === undefined ? {} : { epicRolePolicy: input.epicRolePolicy },
      ),
    ),
    Layer.provide(Layer.succeed(EpicRunStore, store.shape)),
    Layer.provide(EpicWorkerScopeRegistry.layer),
    // A recording stand-in for the real registry: the binding is the only
    // evidence a worker session would carry the role subagents, because the
    // session itself never starts in this harness.
    Layer.provide(
      Layer.succeed(EpicSubagentRegistry, {
        bindThread: ({ threadId, subagents }) =>
          Effect.sync(() => {
            subagentBindings.push({ threadId, subagents });
          }),
        resolve: () => Effect.succeed(Option.none()),
        releaseRun: (runId) =>
          Effect.sync(() => {
            releasedSubagentRuns.push(runId);
          }),
      }),
    ),
    Layer.provide(
      Layer.succeed(AgentAwarenessRelay, {
        publishThread: () => Effect.void,
        publishEpicRun: input.onEpicRunPublish ?? (() => Effect.void),
        start: () => Effect.void,
      }),
    ),
    Layer.provide(NodeServices.layer),
  );

  /**
   * Run one process lifetime against this harness.
   *
   * Everything the harness records — `store`, `heldLocks`, `dispatched`,
   * `shells`, `details`, `turnsStarted`, `preflightModes`, `processRequests` —
   * lives in this closure, not in the layer, so building `layer` a second time
   * gives a second runner that sees the first runner's persisted state.
   * `makeEpicRunner` scopes every loop to the layer and releases every held
   * lease in a layer finalizer, so closing one `runLifecycle` scope is exactly
   * what process death looks like to the lock and to the loops. Two calls in
   * sequence are a restart.
   *
   * Two things to know before scripting one:
   *
   * - `simulateTurn` is forked with `Effect.forkDetach`, so a turn that is not
   *   stalled keeps mutating `head` and `shells` after phase one's scope
   *   closes. A restart script MUST give the interrupted iteration
   *   `stall: true`, or phase one's turn settles into phase two's world.
   * - `turnsStarted` keeps advancing across phases. Phase two consumes
   *   `script[1]`, not `script[0]`.
   */
  const runLifecycle = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.provide(effect, layer);

  return {
    layer,
    runLifecycle,
    store,
    turnsStarted: () => turnsStarted,
    shellReads: () => shellReads,
    setActiveTurn: (threadId: ThreadId, turnId: TurnId) => {
      activeTurnIds.set(threadId, turnId);
      shells.set(threadId, { latestTurn: "running", session: "running" });
    },
    activeTurns: () => activeTurns,
    maxActiveTurns: () => maxActiveTurns,
    startedIssueIds,
    activeLockCount: () => heldLocks.size,
    stopsWithRunningSubagents: () => stopsWithRunningSubagents,
    processRequests,
    epicDescriptionReads: () => epicDescriptionReads,
    configReadRoots,
    preflightModes,
    preflightInputs,
    provisionInputs,
    integrationProvisionInputs,
    releasedWorktrees,
    setupInputs,
    iterationLifecycle,
    subagentBindings,
    releasedSubagentRuns,
    worktreesDir,
    childStatus: (issueId: string) => childStatuses.get(issueId),
    commands: dispatched,
    commandsOfType: <T extends OrchestrationCommand["type"]>(type: T) =>
      dispatched.filter(
        (command): command is Extract<OrchestrationCommand, { readonly type: T }> =>
          command.type === type,
      ),
  };
}

const startRun = (maxIterations = 10) =>
  Effect.flatMap(EpicRunner, (runner) =>
    runner.startRun({
      epicId: "epic-1",
      projectId,
      cwd: "/tmp/epic-runner-repo",
      prompt: "do one unit of work",
      orientationFile: null,
      modelSelection,
      config: { parallel: { workers: 1 } },
      maxIterations,
    }),
  );

const startRunWithWorkers = (workers: number, maxIterations = 10) =>
  Effect.flatMap(EpicRunner, (runner) =>
    runner.startRun({
      epicId: "epic-1",
      projectId,
      cwd: "/tmp/epic-runner-repo",
      prompt: "do one unit of work",
      orientationFile: null,
      modelSelection,
      config: { parallel: { workers }, limits: { maxIterations } },
    }),
  );

// `it.live`, not `it.effect`: the runner polls the projection and sleeps
// between attempts, so it needs the real clock rather than a virtual one that
// only advances when a test tells it to.
describe("EpicRunner", () => {
  it("assembles fallback context without changing the base prompt", () => {
    assert.strictEqual(
      assembleIterationPrompt({
        basePrompt: "Base prompt",
        issueId: "child-1",
        epicContext: null,
        orientationCard: null,
      }),
      "Base prompt\n\nCook exactly `child-1` this iteration.\n\n## Epic context (resolved at dispatch)\n\n(epic description unavailable)\n\n(no orientation card in this repo)",
    );
  });

  it("splices epic and orientation text verbatim", () => {
    const epicContext = "Goal with `backticks` | pipes\n  and indentation";
    const orientationCard = "# Agent card\n\nKeep | literal text.";
    const prompt = assembleIterationPrompt({
      basePrompt: "Base prompt",
      issueId: "child-1",
      epicContext,
      orientationCard,
    });
    assert.include(prompt, epicContext);
    assert.include(prompt, orientationCard);
  });

  // The runner stops the session as soon as the turn ends — no notification
  // ever re-invokes the agent. Agents that backgrounded work and yielded
  // ("waiting for the workflow to notify me") lost that work when the session
  // was killed, so the prompt must state the contract explicitly.
  it("iteration prompt states the one-shot turn contract and the parsed markers", () => {
    const prompt = epicRunIterationPrompt({ pushEnabled: true });
    // Assert the contract, not the phrasing: the worker has to learn that its
    // turn is the whole iteration and that in-flight work dies with it.
    assert.include(prompt, "Nothing re-invokes you");
    assert.include(prompt, "dies with it");
    // The RALPH protocol markers the runner parses must stay intact.
    assert.include(prompt, "RALPH_DONE");
    assert.include(prompt, 'RALPH_MSG: {"summary":');
  });

  it("iteration prompt follows the run's push policy", () => {
    // The prompt used to hardcode "commit and push", so a no-push run told
    // every worker to do the one thing the run had disabled.
    assert.include(epicRunIterationPrompt({ pushEnabled: true }), "commit and push it");
    const noPush = epicRunIterationPrompt({ pushEnabled: false });
    assert.include(noPush, "pushing is disabled");
    assert.notInclude(noPush, "commit and push it");
  });

  it.live("dispatches fresh epic context and the AGENTS orientation card", () =>
    Effect.gen(function* () {
      const workspace = yield* makeTempWorkspace;
      yield* writeWorkspaceFiles(workspace, { "AGENTS.md": "# Repo orientation\n" });
      const epicContext = "Goal with `backticks` | pipes\n  and indentation";
      const harness = createHarness({
        script: [{ text: "RALPH_DONE", head: "head-0" }],
        workspaceRoot: workspace,
        epicDescriptions: [epicContext],
      });
      yield* Effect.gen(function* () {
        const runner = yield* EpicRunner;
        const run = yield* runner.startRun({
          epicId: "epic-1",
          projectId,
          cwd: workspace,
          prompt: "Base prompt",
          modelSelection,
          maxIterations: 1,
        });
        yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "done");

        const text = harness.commandsOfType("thread.turn.start")[0]!.message.text;
        assert.include(text, "Base prompt\n\nCook exactly `child-1` this iteration.");
        assert.include(text, epicContext);
        assert.include(text, "# Repo orientation\n");
      }).pipe(Effect.provide(harness.layer));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live("prefers docs/agent-orientation.md over AGENTS.md", () =>
    Effect.gen(function* () {
      const workspace = yield* makeTempWorkspace;
      yield* writeWorkspaceFiles(workspace, {
        "docs/agent-orientation.md": "docs card",
        "AGENTS.md": "agents card",
      });
      const harness = createHarness({
        script: [{ text: "RALPH_DONE", head: "head-0" }],
        workspaceRoot: workspace,
        epicDescriptions: ["Epic goal"],
      });
      yield* Effect.gen(function* () {
        const runner = yield* EpicRunner;
        const run = yield* runner.startRun({
          epicId: "epic-1",
          projectId,
          cwd: workspace,
          prompt: "Base prompt",
          modelSelection,
          maxIterations: 1,
        });
        yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "done");

        const text = harness.commandsOfType("thread.turn.start")[0]!.message.text;
        assert.include(text, "docs card");
        assert.notInclude(text, "agents card");
      }).pipe(Effect.provide(harness.layer));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live("uses only the configured orientation override", () =>
    Effect.gen(function* () {
      const workspace = yield* makeTempWorkspace;
      yield* writeWorkspaceFiles(workspace, {
        "custom.md": "custom card",
        "docs/agent-orientation.md": "docs card",
        "AGENTS.md": "agents card",
      });
      const harness = createHarness({
        script: [{ text: "RALPH_DONE", head: "head-0" }],
        workspaceRoot: workspace,
        epicDescriptions: ["Epic goal"],
      });
      yield* Effect.gen(function* () {
        const runner = yield* EpicRunner;
        const run = yield* runner.startRun({
          epicId: "epic-1",
          projectId,
          cwd: workspace,
          prompt: "Base prompt",
          orientationFile: "custom.md",
          modelSelection,
          maxIterations: 1,
        });
        yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "done");

        const text = harness.commandsOfType("thread.turn.start")[0]!.message.text;
        assert.strictEqual(harness.store.runs.get(run.runId)?.orientationFile, "custom.md");
        assert.include(text, "custom card");
        assert.notInclude(text, "docs card");
        assert.notInclude(text, "agents card");
      }).pipe(Effect.provide(harness.layer));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live("uses the orientation fallback when no candidate exists", () =>
    Effect.gen(function* () {
      const workspace = yield* makeTempWorkspace;
      const harness = createHarness({
        script: [{ text: "RALPH_DONE", head: "head-0" }],
        workspaceRoot: workspace,
        epicDescriptions: ["Epic goal"],
      });
      yield* Effect.gen(function* () {
        const runner = yield* EpicRunner;
        const run = yield* runner.startRun({
          epicId: "epic-1",
          projectId,
          cwd: workspace,
          prompt: "Base prompt",
          modelSelection,
          maxIterations: 1,
        });
        yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "done");
        assert.include(
          harness.commandsOfType("thread.turn.start")[0]!.message.text,
          "(no orientation card in this repo)",
        );
      }).pipe(Effect.provide(harness.layer));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live("dispatches with the epic fallback when bd show fails", () => {
    const harness = createHarness({
      script: [{ text: "RALPH_DONE", head: "head-0" }],
      epicDescriptionExitCode: 1,
    });
    return Effect.gen(function* () {
      const run = yield* startRun(1);
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "done");
      assert.include(
        harness.commandsOfType("thread.turn.start")[0]!.message.text,
        "(epic description unavailable)",
      );
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("reads the epic description again for each iteration", () => {
    const harness = createHarness({
      script: [
        {
          text: 'RALPH_MSG: {"summary":"first","why":"needed"}',
          head: "head-1",
        },
        { text: "RALPH_DONE", head: "head-1" },
      ],
      epicDescriptions: ["First epic context", "Second epic context"],
    });
    return Effect.gen(function* () {
      const run = yield* startRun(2);
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "done");
      const prompts = harness
        .commandsOfType("thread.turn.start")
        .map((command) => command.message.text);
      assert.isAtLeast(harness.epicDescriptionReads(), 2);
      assert.include(prompts[0]!, "First epic context");
      assert.notInclude(prompts[0]!, "Second epic context");
      assert.include(prompts[1]!, "Second epic context");
      assert.notInclude(prompts[1]!, "First epic context");
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("rejects orientation paths that can escape the checkout", () => {
    const harness = createHarness({ script: [] });
    return Effect.gen(function* () {
      const runner = yield* EpicRunner;
      for (const orientationFile of ["/tmp/card.md", "docs/../card.md", "C:\\card.md"]) {
        const error = yield* Effect.flip(
          runner.startRun({
            epicId: "epic-1",
            projectId,
            cwd: "/tmp/epic-runner-repo",
            prompt: "Base prompt",
            orientationFile,
            modelSelection,
          }),
        );
        assert.strictEqual(error._tag, "EpicRunLaunchError");
        if (error._tag === "EpicRunLaunchError") {
          assert.strictEqual(error.reason, "orientation_file_invalid");
        }
      }
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("prepares the systemd worker scope once per run", () =>
    Effect.gen(function* () {
      const workspace = yield* makeTempWorkspace;
      yield* writeWorkspaceFiles(workspace, { "AGENTS.md": "# Repo orientation\n" });
      const harness = createHarness({
        script: [{ text: "RALPH_DONE", head: "head-0" }],
        workspaceRoot: workspace,
      });
      yield* Effect.gen(function* () {
        const runner = yield* EpicRunner;
        const run = yield* runner.startRun({
          epicId: "epic-1",
          projectId,
          cwd: workspace,
          prompt: "Base prompt",
          modelSelection,
          maxIterations: 1,
        });
        yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "done");

        const probes = harness.processRequests.filter(
          (request) => request.command === "systemd-run",
        );
        assert.equal(probes.length, 1);
        const setProperties = harness.processRequests.filter(
          (request) => request.command === "systemctl" && request.args.includes("set-property"),
        );
        assert.equal(setProperties.length, 1);
      }).pipe(Effect.provide(harness.layer));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live("fails the run when the worker scope identity collides", () =>
    Effect.gen(function* () {
      const workspace = yield* makeTempWorkspace;
      yield* writeWorkspaceFiles(workspace, { "AGENTS.md": "# Repo orientation\n" });
      const harness = createHarness({
        script: [{ text: "RALPH_DONE", head: "head-0" }],
        workspaceRoot: workspace,
        workerScopeCollision: true,
      });
      yield* Effect.gen(function* () {
        const runner = yield* EpicRunner;
        const run = yield* runner.startRun({
          epicId: "epic-1",
          projectId,
          cwd: workspace,
          prompt: "Base prompt",
          modelSelection,
          maxIterations: 1,
        });
        yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "failed");

        const failed = harness.store.runs.get(run.runId);
        assert.include(failed?.lastError ?? "", "run identity");
        assert.equal(harness.commandsOfType("thread.turn.start").length, 0);
        // A fresh launch never owns a pre-existing scope, so it must not stop
        // one.
        assert.equal(
          harness.processRequests.filter(
            (request) => request.command === "systemctl" && request.args[1] === "stop",
          ).length,
          0,
        );
      }).pipe(Effect.provide(harness.layer));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live("publishes each persisted run transition", () => {
    const publishedStatuses: string[] = [];
    const harness = createHarness({
      script: [],
      readyOutput: "[]",
      onEpicRunPublish: (run) =>
        Effect.sync(() => {
          publishedStatuses.push(run.status);
        }),
    });
    return Effect.gen(function* () {
      const run = yield* startRun();
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "done");
      yield* waitFor(() => publishedStatuses.includes("done"));
      assert.deepStrictEqual(publishedStatuses, ["running", "done"]);
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("keeps running when epic activity publication fails", () => {
    const harness = createHarness({
      script: [],
      readyOutput: "[]",
      onEpicRunPublish: () => Effect.die("relay unavailable"),
    });
    return Effect.gen(function* () {
      const run = yield* startRun();
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "done");
      assert.strictEqual(harness.store.runs.get(run.runId)?.status, "done");
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("chooses the first direct-ready child and ignores an earlier grandchild", () => {
    const harness = createHarness({
      script: [{ text: "RALPH_DONE", head: "head-0" }],
      readyOutput:
        '[{"id":"grandchild","parent":"child-a"},{"id":"direct-a","parent":"epic-1"},{"id":"direct-b","parent":"epic-1"}]',
    });
    return Effect.gen(function* () {
      const run = yield* startRun();
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "done");
      assert.strictEqual(harness.store.iterations[0]?.issueId, "direct-a");
      assert.match(
        harness.commandsOfType("thread.turn.start")[0]!.message.text,
        /Cook exactly `direct-a` this iteration\./,
      );
      const readyRequest = harness.processRequests.find(
        (request) => request.command === "bd" && request.args[0] === "ready",
      )!;
      assert.deepStrictEqual(readyRequest.args, ["ready", "--parent", "epic-1", "--json"]);
      assert.strictEqual(readyRequest.cwd, "/tmp/epic-runner-repo");
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("dispatches the first ready child when bd omits its parent", () => {
    const harness = createHarness({
      script: [{ text: "RALPH_DONE", head: "head-0" }],
      readyOutput: '[{"id":"child-a"}]',
    });
    return Effect.gen(function* () {
      const run = yield* startRun(1);
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "done");
      assert.strictEqual(harness.store.iterations[0]?.issueId, "child-a");
      assert.match(
        harness.commandsOfType("thread.turn.start")[0]!.message.text,
        /Cook exactly `child-a` this iteration\./,
      );
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("dispatches the first ready child when bd reports a null parent", () => {
    const harness = createHarness({
      script: [{ text: "RALPH_DONE", head: "head-0" }],
      readyOutput: '[{"id":"child-a","parent":null}]',
    });
    return Effect.gen(function* () {
      const run = yield* startRun(1);
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "done");
      assert.strictEqual(harness.store.iterations[0]?.issueId, "child-a");
      assert.match(
        harness.commandsOfType("thread.turn.start")[0]!.message.text,
        /Cook exactly `child-a` this iteration\./,
      );
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("preserves ready order while skipping children with a different parent", () => {
    const harness = createHarness({
      script: [{ text: "RALPH_DONE", head: "head-0" }],
      readyOutput:
        '[{"id":"foreign-a","parent":"epic-2"},{"id":"child-a"},{"id":"child-b","parent":"epic-1"}]',
    });
    return Effect.gen(function* () {
      const run = yield* startRun(1);
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "done");
      assert.strictEqual(harness.store.iterations[0]?.issueId, "child-a");
      assert.match(
        harness.commandsOfType("thread.turn.start")[0]!.message.text,
        /Cook exactly `child-a` this iteration\./,
      );
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("dispatches five ready children through a three-worker pool", () => {
    const gates = Array.from({ length: 5 }, () => Deferred.makeUnsafe<void>());
    const harness = createHarness({
      readyChildren: ["child-a", "child-b", "child-c", "child-d", "child-e"],
      script: gates.map((settleGate, index) => ({
        text: 'RALPH_MSG: {"summary":"done","why":"needed"}',
        head: `head-${index + 1}`,
        settleGate,
      })),
    });
    return Effect.gen(function* () {
      const run = yield* startRunWithWorkers(3, 5);
      assert.strictEqual(run.workers, 3);
      yield* waitFor(() => harness.turnsStarted() === 3);
      assert.strictEqual(harness.maxActiveTurns(), 3);
      yield* Deferred.succeed(gates[0]!, undefined);
      yield* Deferred.succeed(gates[1]!, undefined);
      yield* Deferred.succeed(gates[2]!, undefined);
      yield* waitFor(() => harness.turnsStarted() === 5);
      yield* Deferred.succeed(gates[3]!, undefined);
      yield* Deferred.succeed(gates[4]!, undefined);
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "done");

      assert.strictEqual(harness.maxActiveTurns(), 3);
      assert.deepStrictEqual([...harness.startedIssueIds].sort(), [
        "child-a",
        "child-b",
        "child-c",
        "child-d",
        "child-e",
      ]);
      assert.strictEqual(new Set(harness.startedIssueIds).size, 5);
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("uses only the remaining dispatch budget when the worker cap is larger", () => {
    const gates = Array.from({ length: 2 }, () => Deferred.makeUnsafe<void>());
    const harness = createHarness({
      readyChildren: ["child-a", "child-b", "child-c"],
      script: gates.map((settleGate, index) => ({
        text: 'RALPH_MSG: {"summary":"done","why":"needed"}',
        head: `head-${index + 1}`,
        settleGate,
      })),
    });
    return Effect.gen(function* () {
      const runner = yield* EpicRunner;
      const run = yield* runner.startRun({
        epicId: "epic-1",
        projectId,
        cwd: "/tmp/epic-runner-repo",
        prompt: "work",
        orientationFile: null,
        modelSelection,
        config: { parallel: { workers: 3 }, limits: { maxIterations: 2 } },
      });
      yield* waitFor(() => harness.turnsStarted() === 2);
      yield* settle;
      assert.strictEqual(harness.turnsStarted(), 2);
      yield* Deferred.succeed(gates[0]!, undefined);
      yield* Deferred.succeed(gates[1]!, undefined);
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "done");
      assert.strictEqual(harness.maxActiveTurns(), 2);
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("does not dispatch an in-flight child twice", () => {
    const childAGate = Deferred.makeUnsafe<void>();
    const harness = createHarness({
      readyChildren: ["child-a", "child-b", "child-c"],
      script: [
        {
          text: 'RALPH_MSG: {"summary":"a","why":"needed"}',
          head: "head-a",
          settleGate: childAGate,
        },
        { text: 'RALPH_MSG: {"summary":"b","why":"needed"}', head: "head-b" },
        { text: 'RALPH_MSG: {"summary":"c","why":"needed"}', head: "head-c" },
      ],
    });
    return Effect.gen(function* () {
      const run = yield* startRunWithWorkers(2, 3);
      yield* waitFor(() => harness.turnsStarted() === 3);
      assert.deepStrictEqual([...harness.startedIssueIds].sort(), [
        "child-a",
        "child-b",
        "child-c",
      ]);
      assert.strictEqual(
        harness.startedIssueIds.filter((issueId) => issueId === "child-a").length,
        1,
      );
      yield* Deferred.succeed(childAGate, undefined);
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "done");
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("workers one preserves ready-frontier order", () => {
    const harness = createHarness({
      readyChildren: ["child-a", "child-b", "child-c"],
      script: ["a", "b", "c"].map((summary, index) => ({
        text: `RALPH_MSG: {"summary":"${summary}","why":"needed"}`,
        head: `head-${index + 1}`,
      })),
    });
    return Effect.gen(function* () {
      const run = yield* startRunWithWorkers(1, 3);
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "done");
      assert.strictEqual(harness.maxActiveTurns(), 1);
      assert.deepStrictEqual(harness.startedIssueIds, ["child-a", "child-b", "child-c"]);
      assert.deepStrictEqual(
        harness.iterationLifecycle.filter((event) => event !== "setup"),
        [
          "thread.create",
          "thread.turn.start",
          "turn-settled",
          "thread.create",
          "thread.turn.start",
          "turn-settled",
          "thread.create",
          "thread.turn.start",
          "turn-settled",
        ],
      );
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("fails an empty ready frontier when open children remain", () => {
    const harness = createHarness({
      script: [],
      readyOutput: "[]",
      openChildren: [
        { id: "child-a", status: "blocked" },
        { id: "child-b", status: "open" },
      ],
    });
    return Effect.gen(function* () {
      const run = yield* startRunWithWorkers(2, 10);
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "failed");
      const failed = harness.store.runs.get(run.runId);
      assert.match(failed?.lastError ?? "", /^infra:ready-frontier-stuck:/);
      assert.strictEqual(failed?.iterationsDispatched, 0);
      assert.strictEqual(harness.commandsOfType("thread.create").length, 0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("refuses a RALPH_DONE that leaves an open child", () => {
    // The worker says the backlog is empty and Beads says otherwise, so the
    // run dispatches again instead of reporting work nobody did.
    const harness = createHarness({
      script: [
        { text: "RALPH_DONE", head: "head-0" },
        { text: 'RALPH_MSG: {"summary":"did work","why":"needed"}', head: "head-1" },
      ],
      openChildren: [{ id: "child-2", status: "open" }],
    });
    return Effect.gen(function* () {
      const run = yield* startRun(2);
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "failed");
      const failed = harness.store.runs.get(run.runId);
      assert.strictEqual(harness.turnsStarted(), 2);
      assert.include(failed?.lastError ?? "", "limit:max-iterations");
      assert.include(failed?.lastError ?? "", "child-2");
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("fails the dispatch cap when the epic still has an open child", () => {
    const harness = createHarness({
      script: [{ text: 'RALPH_MSG: {"summary":"did work","why":"needed"}', head: "head-1" }],
      openChildren: [{ id: "child-1", status: "open" }],
    });
    return Effect.gen(function* () {
      const run = yield* startRun(1);
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "failed");
      const failed = harness.store.runs.get(run.runId);
      assert.strictEqual(failed?.iterationsDispatched, 1);
      assert.include(failed?.lastError ?? "", "limit:max-iterations");
      assert.include(failed?.lastError ?? "", "child-1");
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("does not complete an empty frontier while a worker is active", () => {
    const gates = [Deferred.makeUnsafe<void>(), Deferred.makeUnsafe<void>()];
    const harness = createHarness({
      readyChildren: ["child-a", "child-b"],
      script: gates.map((settleGate, index) => ({
        text: 'RALPH_MSG: {"summary":"done","why":"needed"}',
        head: `head-${index + 1}`,
        settleGate,
      })),
    });
    return Effect.gen(function* () {
      const run = yield* startRunWithWorkers(2, 10);
      yield* waitFor(() => harness.turnsStarted() === 2);
      yield* Deferred.succeed(gates[0]!, undefined);
      yield* waitFor(() => harness.store.runs.get(run.runId)?.iterationsCompleted === 1);
      assert.strictEqual(harness.store.runs.get(run.runId)?.status, "running");
      yield* Deferred.succeed(gates[1]!, undefined);
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "done");
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("lowers the live worker cap without interrupting active turns", () => {
    const gates = Array.from({ length: 3 }, () => Deferred.makeUnsafe<void>());
    const harness = createHarness({
      readyChildren: ["child-a", "child-b", "child-c", "child-d"],
      script: [
        ...gates.map((settleGate, index) => ({
          text: 'RALPH_MSG: {"summary":"done","why":"needed"}',
          head: `head-${index + 1}`,
          settleGate,
        })),
        {
          text: 'RALPH_MSG: {"summary":"done","why":"needed"}',
          head: "head-4",
        },
      ],
    });
    return Effect.gen(function* () {
      const runner = yield* EpicRunner;
      const run = yield* startRunWithWorkers(3, 4);
      yield* waitFor(() => harness.turnsStarted() === 3);
      const updated = yield* runner.setWorkers({ runId: run.runId, workers: 1 });
      assert.strictEqual(updated.workers, 1);
      assert.strictEqual(updated.config.parallel.workers, 3);
      yield* Deferred.succeed(gates[0]!, undefined);
      yield* settle;
      assert.strictEqual(harness.turnsStarted(), 3);
      yield* Deferred.succeed(gates[1]!, undefined);
      yield* settle;
      assert.strictEqual(harness.turnsStarted(), 3);
      yield* Deferred.succeed(gates[2]!, undefined);
      yield* waitFor(() => harness.turnsStarted() === 4);
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "done");
      assert.strictEqual(harness.commandsOfType("thread.turn.interrupt").length, 0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("raises the live worker cap without waiting for a settlement", () => {
    const gates = Array.from({ length: 3 }, () => Deferred.makeUnsafe<void>());
    const harness = createHarness({
      readyChildren: ["child-a", "child-b", "child-c"],
      script: gates.map((settleGate, index) => ({
        text: 'RALPH_MSG: {"summary":"done","why":"needed"}',
        head: `head-${index + 1}`,
        settleGate,
      })),
    });
    return Effect.gen(function* () {
      const runner = yield* EpicRunner;
      const run = yield* startRunWithWorkers(1, 3);
      yield* waitFor(() => harness.turnsStarted() === 1);
      yield* runner.setWorkers({ runId: run.runId, workers: 3 });
      yield* waitFor(() => harness.turnsStarted() === 3);
      assert.strictEqual(harness.maxActiveTurns(), 3);
      for (const gate of gates) yield* Deferred.succeed(gate, undefined);
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "done");
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("pauses new dispatch and drains every active worker", () => {
    const gates = Array.from({ length: 3 }, () => Deferred.makeUnsafe<void>());
    const harness = createHarness({
      readyChildren: ["child-a", "child-b", "child-c", "child-d"],
      script: gates.map((settleGate, index) => ({
        text: 'RALPH_MSG: {"summary":"done","why":"needed"}',
        head: `head-${index + 1}`,
        settleGate,
      })),
    });
    return Effect.gen(function* () {
      const runner = yield* EpicRunner;
      const run = yield* startRunWithWorkers(3, 10);
      yield* waitFor(() => harness.turnsStarted() === 3);
      yield* runner.pauseRun({ runId: run.runId });
      for (const gate of gates) yield* Deferred.succeed(gate, undefined);
      yield* waitFor(
        () =>
          harness.store.runs.get(run.runId)?.iterationsCompleted === 3 &&
          harness.activeLockCount() === 0,
      );
      assert.strictEqual(harness.store.runs.get(run.runId)?.status, "paused");
      assert.strictEqual(harness.turnsStarted(), 3);
      assert.strictEqual(harness.commandsOfType("thread.turn.interrupt").length, 0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("does not dispatch after pause becomes durable during worker setup", () => {
    const setupGate = Deferred.makeUnsafe<void>();
    const harness = createHarness({
      readyChildren: ["child-a"],
      setupGate,
      script: [{ text: 'RALPH_MSG: {"summary":"done","why":"needed"}', head: "head-1" }],
    });
    return Effect.gen(function* () {
      const runner = yield* EpicRunner;
      const run = yield* startRunWithWorkers(1, 1);
      yield* waitFor(() => harness.commandsOfType("thread.create").length === 1);
      yield* runner.pauseRun({ runId: run.runId });
      yield* Deferred.succeed(setupGate, undefined);
      yield* waitFor(() => harness.activeLockCount() === 0);

      assert.strictEqual(harness.store.runs.get(run.runId)?.status, "paused");
      assert.strictEqual(harness.commandsOfType("thread.turn.start").length, 0);
      assert.strictEqual(harness.store.iterations[0]?.turnStatus, "abandoned");
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("abandons every running row when an iteration worker fails", () => {
    const harness = createHarness({
      readyChildren: ["child-a"],
      childStatuses: { "child-a": "in_progress" },
      refuseCommandTypes: ["thread.create"],
      script: [],
    });
    return Effect.gen(function* () {
      const run = yield* startRunWithWorkers(1, 1);
      yield* waitFor(
        () =>
          harness.store.runs.get(run.runId)?.status === "failed" && harness.activeLockCount() === 0,
      );

      assert.strictEqual(harness.store.iterations[0]?.turnStatus, "abandoned");
      assert.strictEqual(harness.store.iterations[0]?.failureReason, "infra:dispatch-failed");
      assert.isTrue(
        harness.processRequests.some(
          (request) =>
            request.command === "bd" &&
            request.args[0] === "update" &&
            request.args[1] === "child-a" &&
            request.args.includes("open"),
        ),
      );
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("tracks the provider turn that starts last when setup completes out of order", () => {
    const firstSetup = Deferred.makeUnsafe<void>();
    const secondSetup = Deferred.makeUnsafe<void>();
    const turnGates = [Deferred.makeUnsafe<void>(), Deferred.makeUnsafe<void>()];
    const harness = createHarness({
      readyChildren: ["child-a", "child-b"],
      beforeSetupCompletes: (request) =>
        Deferred.await(request.threadId.endsWith("-0") ? firstSetup : secondSetup),
      script: turnGates.map((settleGate, index) => ({
        text: 'RALPH_MSG: {"summary":"done","why":"needed"}',
        head: `head-${index + 1}`,
        settleGate,
      })),
    });
    return Effect.gen(function* () {
      const run = yield* startRunWithWorkers(2, 2);
      const firstThread = ThreadId.make(`epic-run-${run.runId}-0`);
      const secondThread = ThreadId.make(`epic-run-${run.runId}-1`);
      yield* waitFor(() => harness.setupInputs.length === 2);
      assert.deepStrictEqual(
        harness.store.iterations.map((iteration) => iteration.iterationIndex),
        [0, 1],
      );

      yield* Deferred.succeed(secondSetup, undefined);
      yield* waitFor(() => harness.turnsStarted() === 1);
      assert.strictEqual(harness.commandsOfType("thread.turn.start")[0]?.threadId, secondThread);
      assert.strictEqual(harness.store.runs.get(run.runId)?.currentThreadId, secondThread);

      yield* Deferred.succeed(firstSetup, undefined);
      yield* waitFor(() => harness.turnsStarted() === 2);
      assert.deepStrictEqual(
        harness.commandsOfType("thread.turn.start").map((command) => command.threadId),
        [secondThread, firstThread],
      );
      assert.strictEqual(harness.store.runs.get(run.runId)?.currentThreadId, firstThread);

      for (const gate of turnGates) yield* Deferred.succeed(gate, undefined);
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "done");
      assert.strictEqual(harness.store.runs.get(run.runId)?.currentThreadId, firstThread);
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("keeps the latest dispatched thread after out-of-order settlement", () => {
    const gates = [Deferred.makeUnsafe<void>(), Deferred.makeUnsafe<void>()];
    const harness = createHarness({
      readyChildren: ["child-a", "child-b"],
      script: gates.map((settleGate, index) => ({
        text: 'RALPH_MSG: {"summary":"done","why":"needed"}',
        head: `head-${index + 1}`,
        settleGate,
      })),
    });
    return Effect.gen(function* () {
      const run = yield* startRunWithWorkers(2, 2);
      yield* waitFor(() => harness.turnsStarted() === 2);
      yield* Deferred.succeed(gates[1]!, undefined);
      yield* waitFor(() => harness.store.runs.get(run.runId)?.iterationsCompleted === 1);
      assert.strictEqual(
        harness.store.runs.get(run.runId)?.currentThreadId,
        ThreadId.make(`epic-run-${run.runId}-1`),
      );
      yield* Deferred.succeed(gates[0]!, undefined);
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "done");
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("applies simultaneous failure boundaries without lost completions", () => {
    const gates = Array.from({ length: 3 }, () => Deferred.makeUnsafe<void>());
    const harness = createHarness({
      readyChildren: ["child-a", "child-b", "child-c"],
      options: { quietPeriodMs: 1, infraFailureBudget: 3 },
      script: gates.map((settleGate) => ({
        text: null,
        head: "head-0",
        turnState: "error" as const,
        sessionStatus: "error" as const,
        settleGate,
      })),
    });
    return Effect.gen(function* () {
      const run = yield* startRunWithWorkers(3, 3);
      yield* waitFor(() => harness.turnsStarted() === 3);
      for (const gate of gates) yield* Deferred.succeed(gate, undefined);
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "failed");
      const failed = harness.store.runs.get(run.runId)!;
      assert.strictEqual(failed.iterationsCompleted, 3);
      assert.strictEqual(failed.infraStreak, 3);
      assert.strictEqual(
        harness.store.iterations.filter((row) => row.turnStatus === "failed").length,
        3,
      );
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("fails once when bd returns only children with different parents", () => {
    const logs = captureLogs();
    const harness = createHarness({
      script: [],
      readyOutput: '[{"id":"foreign-a","parent":"epic-2"},{"id":"foreign-b","parent":"epic-3"}]',
    });
    return Effect.gen(function* () {
      const runner = yield* EpicRunner;
      const run = yield* startRun();
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "failed");
      yield* waitFor(() => harness.activeLockCount() === 0);

      const persistedRun = harness.store.runs.get(run.runId)!;
      assert.strictEqual(persistedRun.iterationsCompleted, 1);
      assert.strictEqual(persistedRun.currentThreadId, null);
      assert.strictEqual(persistedRun.currentTurnStartedAt, null);
      assert.match(persistedRun.lastError ?? "", /foreign-a, foreign-b/);
      assert.strictEqual(harness.store.iterations.length, 1);
      assert.deepInclude(harness.store.iterations[0]!, {
        issueId: null,
        turnStatus: "failed",
        failureReason: "infra:ready-unrecognised",
      });
      assert.deepStrictEqual(harness.store.iterationWrites, [
        { method: "append", turnStatus: "running" },
        { method: "update", turnStatus: "failed" },
      ]);
      const publicRun = yield* runner.getRun({ runId: run.runId });
      assert.isTrue(Option.isSome(publicRun));
      if (Option.isSome(publicRun)) {
        assert.deepStrictEqual(publicRun.value.threadRefs, []);
      }
      assert.strictEqual(harness.commandsOfType("thread.create").length, 0);
      assert.strictEqual(harness.commandsOfType("thread.session.stop").length, 0);
      assert.strictEqual(
        harness.processRequests.filter(
          (request) => request.command === "bd" && request.args[0] === "ready",
        ).length,
        1,
      );
      assert.strictEqual(
        harness.processRequests.filter(
          (request) => request.command === "bd" && request.args[0] === "update",
        ).length,
        0,
      );
      assert.strictEqual(harness.activeLockCount(), 0);
      assert.isTrue(
        logs.entries.some(
          (entry) =>
            entry.logLevel === "Error" &&
            JSON.stringify(entry.message).includes("epic.runner.ready-unrecognised") &&
            JSON.stringify(entry.message).includes("foreign-a") &&
            JSON.stringify(entry.message).includes("foreign-b"),
        ),
      );
    }).pipe(Effect.provide(Layer.merge(harness.layer, logs.layer)));
  });

  it.live("keeps a concurrent pause when ready selection is unrecognised", () => {
    const harness = createHarness({
      script: [],
      readyOutput: '[{"id":"foreign-a","parent":"epic-2"}]',
      appendIterationDelayMs: 100,
    });
    return Effect.gen(function* () {
      const runner = yield* EpicRunner;
      const run = yield* startRun();
      yield* waitFor(() => harness.store.iterations[0]?.turnStatus === "running");
      yield* runner.pauseRun({ runId: run.runId });
      yield* waitFor(() => harness.store.iterations[0]?.turnStatus === "failed");
      yield* waitFor(() => harness.activeLockCount() === 0);

      const paused = harness.store.runs.get(run.runId)!;
      assert.strictEqual(paused.status, "paused");
      assert.strictEqual(paused.iterationsCompleted, 1);
      assert.strictEqual(paused.currentThreadId, null);
      assert.strictEqual(paused.currentTurnStartedAt, null);
      assert.strictEqual(harness.store.iterations[0]?.failureReason, "infra:ready-unrecognised");
      assert.deepStrictEqual(harness.store.iterationWrites, [
        { method: "append", turnStatus: "running" },
        { method: "update", turnStatus: "failed" },
      ]);
      assert.strictEqual(harness.commandsOfType("thread.create").length, 0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("finishes without dispatch when no direct child is ready", () => {
    const harness = createHarness({ script: [], readyOutput: "[]" });
    return Effect.gen(function* () {
      const run = yield* startRun();
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "done");
      assert.strictEqual(harness.store.iterations.length, 0);
      assert.strictEqual(harness.commandsOfType("thread.create").length, 0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("launches from the persisted project defaults and rejects a cwd mismatch", () => {
    const harness = createHarness({ script: [], readyOutput: "[]" });
    return Effect.gen(function* () {
      const runner = yield* EpicRunner;
      const mismatch = yield* Effect.flip(
        runner.launchRun({ epicId: "epic-1", projectId, cwd: "/tmp/wrong" }),
      );
      assert.strictEqual(mismatch._tag, "EpicRunLaunchError");
      if (mismatch._tag === "EpicRunLaunchError") {
        assert.strictEqual(mismatch.reason, "cwd_mismatch");
      }

      const launched = yield* runner.launchRun({
        epicId: "epic-1",
        projectId,
        cwd: "/tmp/epic-runner-repo",
      });
      assert.deepStrictEqual(launched.modelSelection, modelSelection);
      assert.strictEqual(launched.runtimeMode, "full-access");
      assert.strictEqual(launched.orientationFile, null);
      assert.match(launched.prompt, /RALPH_MSG:/);

      for (let iterationIndex = 0; iterationIndex < 30; iterationIndex += 1) {
        harness.store.iterations.push({
          runId: launched.runId,
          iterationIndex,
          threadId: ThreadId.make(`tail-${iterationIndex}`),
          issueId: `child-${iterationIndex}`,
          turnStatus: "completed",
          summary: `summary-${iterationIndex}`,
          why: `why-${iterationIndex}`,
          failureReason: null,
          startedAt: NOW,
          finishedAt: NOW,
        });
      }
      const listed = (yield* runner.listRuns()).find((run) => run.runId === launched.runId)!;
      assert.deepStrictEqual(
        listed.recentIterations.map((iteration) => iteration.iterationIndex),
        Array.from({ length: 25 }, (_, offset) => offset + 5),
      );
      assert.deepStrictEqual(
        listed.threadRefs.map((reference) => reference.iterationIndex),
        Array.from({ length: 25 }, (_, offset) => offset + 5),
      );
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("persists default config and reads the exact run cwd once", () => {
    const harness = createHarness({ script: [], readyOutput: "[]" });
    return Effect.gen(function* () {
      const runner = yield* EpicRunner;
      const run = yield* runner.startRun({
        epicId: "epic-default",
        projectId,
        cwd: "/tmp/epic-runner-repo",
        prompt: "Cook.",
        modelSelection,
      });
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "done");

      const stored = harness.store.runs.get(run.runId)!;
      assert.deepStrictEqual(stored.config, DEFAULT_EPIC_RUN_CONFIG);
      assert.deepStrictEqual(stored.configProvenance, DEFAULT_EPIC_RUN_CONFIG_PROVENANCE);
      assert.strictEqual(stored.maxIterations, DEFAULT_EPIC_RUN_CONFIG.limits.maxIterations);
      assert.deepStrictEqual(harness.configReadRoots, ["/tmp/epic-runner-repo"]);
      assert.deepStrictEqual(harness.preflightModes, ["parallel"]);
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("folds the legacy iteration cap into the persisted snapshot", () => {
    const harness = createHarness({ script: [], readyOutput: "[]" });
    return Effect.gen(function* () {
      const run = yield* startRun(2);
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "done");

      const stored = harness.store.runs.get(run.runId)!;
      assert.strictEqual(stored.maxIterations, 2);
      assert.strictEqual(stored.config.limits.maxIterations, 2);
      assert.strictEqual(stored.configProvenance["limits.maxIterations"], "override");
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("lets an explicit default-valued file cap beat the legacy cap", () => {
    const harness = createHarness({
      script: [],
      readyOutput: "[]",
      configFileResult: loadedConfigFile({ limits: { maxIterations: 50 } }),
    });
    return Effect.gen(function* () {
      const run = yield* startRun(2);
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "done");

      const stored = harness.store.runs.get(run.runId)!;
      assert.strictEqual(stored.maxIterations, 50);
      assert.strictEqual(stored.config.limits.maxIterations, 50);
      assert.strictEqual(stored.configProvenance["limits.maxIterations"], "file");
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("persists file config and lets configured leaves beat legacy launch values", () => {
    const configuredModel = {
      instanceId: ProviderInstanceId.make("claude-work"),
      model: "claude-sonnet-5",
    } as const;
    const harness = createHarness({
      script: [],
      readyOutput: "[]",
      configFileResult: loadedConfigFile({
        limits: { maxIterations: 7 },
        execution: { sequential: true },
        runtime: { mode: "auto-accept-edits" },
        provider: { modelSelection: configuredModel },
      }),
    });
    return Effect.gen(function* () {
      const runner = yield* EpicRunner;
      const run = yield* runner.startRun({
        epicId: "epic-file",
        projectId,
        cwd: "/tmp/epic-runner-repo",
        prompt: "Cook.",
        modelSelection,
        runtimeMode: "full-access",
        maxIterations: 2,
      });
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "done");

      const stored = harness.store.runs.get(run.runId)!;
      assert.strictEqual(stored.maxIterations, 7);
      assert.strictEqual(stored.config.limits.maxIterations, 7);
      assert.strictEqual(stored.runtimeMode, "auto-accept-edits");
      assert.deepStrictEqual(stored.modelSelection, configuredModel);
      assert.strictEqual(stored.configProvenance["limits.maxIterations"], "file");
      assert.strictEqual(stored.configProvenance["runtime.mode"], "file");
      assert.strictEqual(stored.configProvenance["provider.modelSelection"], "file");
      assert.deepStrictEqual(harness.preflightModes, ["sequential"]);
      assert.deepStrictEqual(harness.configReadRoots, ["/tmp/epic-runner-repo"]);
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("applies API config over file config on overridden leaves only", () => {
    const harness = createHarness({
      script: [],
      readyOutput: "[]",
      configFileResult: loadedConfigFile({
        limits: { maxIterations: 7, maxAttemptsPerChild: 4 },
        execution: { sequential: true },
      }),
    });
    return Effect.gen(function* () {
      const runner = yield* EpicRunner;
      const run = yield* runner.launchRun({
        epicId: "epic-override",
        projectId,
        cwd: "/tmp/epic-runner-repo",
        config: {
          limits: { maxIterations: 3 },
          execution: { sequential: false },
        },
      });
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "done");

      const stored = harness.store.runs.get(run.runId)!;
      assert.strictEqual(stored.maxIterations, 3);
      assert.strictEqual(stored.config.limits.maxIterations, 3);
      assert.strictEqual(stored.config.limits.maxAttemptsPerChild, 4);
      assert.strictEqual(stored.configProvenance["limits.maxIterations"], "override");
      assert.strictEqual(stored.configProvenance["limits.maxAttemptsPerChild"], "file");
      assert.strictEqual(stored.configProvenance["execution.sequential"], "override");
      assert.deepStrictEqual(harness.preflightModes, ["parallel"]);
      // A launch forgives nothing: it owns no leftovers yet.
      assert.isUndefined(harness.preflightInputs[0]?.intent);
      assert.isUndefined(harness.preflightInputs[0]?.resume);
      assert.deepStrictEqual(harness.configReadRoots, ["/tmp/epic-runner-repo"]);
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("enriches a whole listing with one iteration read, ordered and bounded", () => {
    // Terminal so nothing here is resumed; the listing is what is under test.
    const seedRun = (runId: string, createdAt: string, updatedAt: string): EpicRun => ({
      runId: EpicRunId.make(runId),
      epicId: "epic-list",
      projectId,
      cwd: "/tmp/epic-runner-repo",
      prompt: "do one unit of work",
      orientationFile: null,
      modelSelection,
      runtimeMode: "full-access",
      ...defaultConfigSnapshot,
      originThreadId: null,
      status: "done",
      maxIterations: 10,
      workers: 1,
      iterationsDispatched: 2,
      iterationsCompleted: 2,
      currentThreadId: null,
      currentTurnStartedAt: null,
      consecutiveFailures: 0,
      noCommitStreak: 0,
      infraStreak: 0,
      lastError: null,
      createdAt,
      updatedAt,
    });
    const seedRuns = [
      seedRun("run-list-old", "2026-07-27T00:00:01.000Z", "2026-07-27T01:00:00.000Z"),
      seedRun("run-list-new", "2026-07-27T00:00:02.000Z", "2026-07-27T03:00:00.000Z"),
      seedRun("run-list-mid", "2026-07-27T00:00:03.000Z", "2026-07-27T02:00:00.000Z"),
    ];
    const harness = createHarness({
      script: [],
      readyOutput: "[]",
      seedRuns,
      seedIterations: seedRuns.flatMap((run, runOffset) =>
        Array.from({ length: 2 }, (_unused, iterationIndex) => ({
          runId: run.runId,
          iterationIndex,
          threadId: ThreadId.make(`thread-${run.runId}-${iterationIndex}`),
          issueId: `child-${runOffset}-${iterationIndex}`,
          turnStatus: "completed" as const,
          summary: null,
          why: null,
          failureReason: null,
          startedAt: NOW,
          finishedAt: NOW,
        })),
      ),
    });
    return Effect.gen(function* () {
      const runner = yield* EpicRunner;

      const listed = yield* runner.listRuns();
      assert.deepStrictEqual(
        listed.map((run) => run.runId),
        ["run-list-old", "run-list-new", "run-list-mid"],
      );
      // Three runs, one iteration read: the whole point of the batch.
      assert.deepStrictEqual(harness.store.iterationReadCounts, { perRun: 0, batched: 1 });
      assert.deepStrictEqual(
        listed.map((run) => run.recentIterations.length),
        [2, 2, 2],
      );
      assert.deepStrictEqual(
        listed[0]?.threadRefs.map((reference) => reference.threadId),
        ["thread-run-list-old-0", "thread-run-list-old-1"],
      );

      const recent = yield* runner.listRuns({ orderBy: "updatedAt-desc", limit: 2 });
      assert.deepStrictEqual(
        recent.map((run) => run.runId),
        ["run-list-new", "run-list-mid"],
      );
      assert.deepStrictEqual(harness.store.iterationReadCounts, { perRun: 0, batched: 2 });
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("records the launching thread, and null when there is none", () => {
    const harness = createHarness({ script: [], readyOutput: "[]" });
    return Effect.gen(function* () {
      const runner = yield* EpicRunner;

      const fromThread = yield* runner.launchRun({
        epicId: "epic-from-thread",
        projectId,
        cwd: "/tmp/epic-runner-repo",
        originThreadId: ThreadId.make("thread-launcher"),
      });
      assert.strictEqual(fromThread.originThreadId, "thread-launcher");

      // The Epics page launches without a thread; nothing may infer one from
      // the run's own iteration threads, which are children of the run.
      const fromEpicsPage = yield* runner.launchRun({
        epicId: "epic-from-page",
        projectId,
        cwd: "/tmp/epic-runner-repo",
      });
      assert.strictEqual(fromEpicsPage.originThreadId, null);

      assert.strictEqual(
        harness.store.runs.get(fromThread.runId)?.originThreadId,
        "thread-launcher",
      );
      assert.strictEqual(harness.store.runs.get(fromEpicsPage.runId)?.originThreadId, null);
      assert.deepStrictEqual(
        harness
          .commandsOfType("thread.turn.start")
          .filter((command) => command.message.text.startsWith("EpicRunner run "))
          .map((command) => command.threadId),
        ["thread-launcher"],
      );
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("dispatches every iteration on the launching thread's provider", () => {
    const originThreadId = ThreadId.make("thread-prime-launcher");
    const primeSelection: ModelSelection = {
      instanceId: ProviderInstanceId.make("prime-work"),
      model: "prime/sonnet",
      options: [{ id: "reasoningEffort", value: "high" }],
    };
    const harness = createHarness({
      script: [{ text: "RALPH_DONE", head: "head-0" }],
      originThreadShells: { [originThreadId]: { modelSelection: primeSelection } },
    });
    return Effect.gen(function* () {
      const runner = yield* EpicRunner;
      const run = yield* runner.launchRun({
        epicId: "epic-inherit",
        projectId,
        cwd: "/tmp/epic-runner-repo",
        originThreadId,
        inheritOriginModelSelection: true,
      });
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "done");

      // Persisted on the run row, so a restart replays the same provider.
      assert.deepStrictEqual(harness.store.runs.get(run.runId)?.modelSelection, primeSelection);
      // And carried into the iteration thread, not just the run row.
      assert.deepStrictEqual(
        harness.commandsOfType("thread.create").map((command) => command.modelSelection),
        [primeSelection],
      );
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("refuses to inherit from an origin thread in another project", () => {
    const originThreadId = ThreadId.make("thread-other-project");
    const harness = createHarness({
      script: [],
      readyOutput: "[]",
      originThreadShells: {
        [originThreadId]: {
          projectId: ProjectId.make("project-elsewhere"),
          modelSelection,
        },
      },
    });
    return Effect.gen(function* () {
      const runner = yield* EpicRunner;
      const error = yield* Effect.flip(
        runner.launchRun({
          epicId: "epic-cross-project",
          projectId,
          cwd: "/tmp/epic-runner-repo",
          originThreadId,
          inheritOriginModelSelection: true,
        }),
      );
      assert.strictEqual(error._tag, "EpicRunLaunchError");
      if (error._tag === "EpicRunLaunchError") {
        assert.strictEqual(error.reason, "origin_thread_project_mismatch");
      }
      // A refused launch takes no lock and creates no run.
      assert.strictEqual(harness.store.runs.size, 0);
      assert.strictEqual(harness.activeLockCount(), 0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("reports run lifecycle changes to the origin thread", () => {
    const originThreadId = ThreadId.make("thread-epic-origin");
    const completionHarness = createHarness({
      script: [{ text: "RALPH_DONE", head: "head-0" }],
    });
    const failedHarness = createHarness({
      script: [{ text: "no commit", head: "head-0" }],
      childStatuses: { "child-1": "open" },
      options: { maxNoCommitStreak: 1 },
    });
    const cancelledRun: EpicRun = {
      runId: EpicRunId.make("run-origin-cancelled"),
      epicId: "epic-origin-cancelled",
      projectId,
      cwd: "/tmp/epic-runner-repo",
      prompt: "do one unit of work",
      orientationFile: null,
      modelSelection,
      runtimeMode: "full-access",
      ...defaultConfigSnapshot,
      originThreadId,
      status: "paused",
      maxIterations: 10,
      workers: 1,
      iterationsDispatched: 2,
      iterationsCompleted: 1,
      currentThreadId: null,
      currentTurnStartedAt: null,
      consecutiveFailures: 0,
      noCommitStreak: 0,
      infraStreak: 0,
      lastError: null,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const cancellationHarness = createHarness({ script: [], seedRuns: [cancelledRun] });
    const refusedHarness = createHarness({
      script: [{ text: "RALPH_DONE", head: "head-0" }],
      refuseOriginStatusCommands: true,
    });

    const statusTurns = (harness: ReturnType<typeof createHarness>) =>
      harness
        .commandsOfType("thread.turn.start")
        .filter((command) => command.threadId === originThreadId);

    const completionScenario = Effect.gen(function* () {
      const completionRunner = yield* EpicRunner;
      const completed = yield* completionRunner.launchRun({
        epicId: "epic-origin-completed",
        projectId,
        cwd: "/tmp/epic-runner-repo",
        originThreadId,
      });
      yield* waitFor(() => completionHarness.store.runs.get(completed.runId)?.status === "done");
      yield* waitFor(() => statusTurns(completionHarness).length === 3);

      const completedTurns = statusTurns(completionHarness);
      assert.deepStrictEqual(
        completedTurns.map((command) => command.message.text),
        [
          `EpicRunner run ${completed.runId} for epic-origin-completed: started. Iterations 0/50.`,
          `EpicRunner run ${completed.runId} for epic-origin-completed: iteration settled. Iterations 1/50.`,
          `EpicRunner run ${completed.runId} for epic-origin-completed: completed. Iterations 1/50. Landed: child-1.`,
        ],
      );
      assert.isTrue(
        completedTurns.every(
          (command) => command.origin === "agent" && command.delivery === "turn-boundary",
        ),
      );
      assert.isTrue(completedTurns.every((command) => command.modelSelection === undefined));
      assert.strictEqual(
        new Set(completedTurns.map((command) => command.commandId)).size,
        completedTurns.length,
      );
      assert.strictEqual(
        new Set(completedTurns.map((command) => command.message.messageId)).size,
        completedTurns.length,
      );
    }).pipe(Effect.provide(completionHarness.layer));

    const failureScenario = Effect.gen(function* () {
      const failedRunner = yield* EpicRunner;
      const failed = yield* failedRunner.launchRun({
        epicId: "epic-origin-failed",
        projectId,
        cwd: "/tmp/epic-runner-repo",
        originThreadId,
      });
      yield* waitFor(() => failedHarness.store.runs.get(failed.runId)?.status === "failed");
      yield* waitFor(() => statusTurns(failedHarness).length === 3);
      assert.deepStrictEqual(
        statusTurns(failedHarness).map((command) => command.message.text),
        [
          `EpicRunner run ${failed.runId} for epic-origin-failed: started. Iterations 0/50.`,
          `EpicRunner run ${failed.runId} for epic-origin-failed: iteration settled. Iterations 1/50.`,
          `EpicRunner run ${failed.runId} for epic-origin-failed: failed. Iterations 1/50. Error: gutter: 1 iterations without a commit.`,
        ],
      );
    }).pipe(Effect.provide(failedHarness.layer));

    const cancellationScenario = Effect.gen(function* () {
      const cancellationRunner = yield* EpicRunner;
      yield* cancellationRunner.cancelRun({ runId: cancelledRun.runId });
      assert.deepStrictEqual(
        statusTurns(cancellationHarness).map((command) => command.message.text),
        [
          "EpicRunner run run-origin-cancelled for epic-origin-cancelled: cancelled. Iterations 1/10.",
        ],
      );
    }).pipe(Effect.provide(cancellationHarness.layer));

    const refusalScenario = Effect.gen(function* () {
      const refusedRunner = yield* EpicRunner;
      const refused = yield* refusedRunner.launchRun({
        epicId: "epic-origin-refused",
        projectId,
        cwd: "/tmp/epic-runner-repo",
        originThreadId,
      });
      yield* waitFor(() => refusedHarness.store.runs.get(refused.runId)?.status === "done");
      yield* waitFor(() => statusTurns(refusedHarness).length === 3);
      assert.strictEqual(statusTurns(refusedHarness).length, 3);
    }).pipe(Effect.provide(refusedHarness.layer));

    return Effect.gen(function* () {
      yield* completionScenario;
      yield* failureScenario;
      yield* cancellationScenario;
      yield* refusalScenario;
    });
  });

  it.live("posts one terminal message when a terminal run is cancelled again", () => {
    const originThreadId = ThreadId.make("thread-epic-origin-double-terminal");
    const pausedRun: EpicRun = {
      runId: EpicRunId.make("run-origin-double-terminal"),
      epicId: "epic-origin-double-terminal",
      projectId,
      cwd: "/tmp/epic-runner-repo",
      prompt: "do one unit of work",
      orientationFile: null,
      modelSelection,
      runtimeMode: "full-access",
      ...defaultConfigSnapshot,
      originThreadId,
      status: "paused",
      maxIterations: 10,
      workers: 1,
      iterationsDispatched: 2,
      iterationsCompleted: 1,
      currentThreadId: null,
      currentTurnStartedAt: null,
      consecutiveFailures: 0,
      noCommitStreak: 0,
      infraStreak: 0,
      lastError: null,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const harness = createHarness({ script: [], seedRuns: [pausedRun] });
    return Effect.gen(function* () {
      const runner = yield* EpicRunner;
      yield* runner.cancelRun({ runId: pausedRun.runId });
      // The terminal row is durable; a second cancel must be refused before
      // any save, so the transition guard never re-posts.
      const second = yield* Effect.flip(runner.cancelRun({ runId: pausedRun.runId }));
      assert.strictEqual(second._tag, "EpicRunStateError");
      assert.deepStrictEqual(
        harness
          .commandsOfType("thread.turn.start")
          .filter((command) => command.threadId === originThreadId)
          .map((command) => command.message.text),
        [
          "EpicRunner run run-origin-double-terminal for epic-origin-double-terminal: cancelled. Iterations 1/10.",
        ],
      );
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("names the error, landed children, and stranded branches in the terminal message", () => {
    const originThreadId = ThreadId.make("thread-epic-origin-terminal-detail");
    const runId = EpicRunId.make("run-origin-terminal-detail");
    const pausedRun: EpicRun = {
      runId,
      epicId: "epic-origin-detail",
      projectId,
      cwd: "/tmp/epic-runner-repo",
      prompt: "do one unit of work",
      orientationFile: null,
      modelSelection,
      runtimeMode: "full-access",
      ...defaultConfigSnapshot,
      originThreadId,
      status: "paused",
      maxIterations: 10,
      workers: 1,
      iterationsDispatched: 2,
      iterationsCompleted: 2,
      currentThreadId: null,
      currentTurnStartedAt: null,
      consecutiveFailures: 0,
      noCommitStreak: 0,
      infraStreak: 0,
      lastError: "infra:merge-reconciliation: gate timeout",
      createdAt: NOW,
      updatedAt: NOW,
    };
    const harness = createHarness({
      script: [],
      seedRuns: [pausedRun],
      seedIterations: [
        {
          runId,
          iterationIndex: 0,
          threadId: ThreadId.make("thread-detail-0"),
          issueId: "child-1",
          branch: "epic/child-1",
          turnStatus: "completed",
          summary: null,
          why: null,
          failureReason: null,
          startedAt: NOW,
          finishedAt: NOW,
        },
        {
          runId,
          iterationIndex: 1,
          threadId: ThreadId.make("thread-detail-1"),
          issueId: "child-2",
          branch: "epic/child-2",
          turnStatus: "completed",
          summary: null,
          why: null,
          failureReason: null,
          startedAt: NOW,
          finishedAt: NOW,
        },
      ],
    });
    // child-2's branch never drained: it is exactly the work a relaunch will
    // not pick up, so the terminal message must name it.
    harness.store.mergeStates.set(runId, {
      runId,
      initialHead: "head-0",
      lastAcceptedHead: "head-0",
      parkedCount: 0,
      repositoryPath: "/tmp/epic-runner-repo",
      baseBranch: "mine",
      integrationBranch: `cook-epic-integration-${runId}`,
      integrationWorktreePath: `${harness.worktreesDir}/epic-${runId}/integration`,
      operatorBaseBranch: null,
      siblings: [],
      entries: [
        {
          runId,
          sequence: 0,
          childId: "child-2",
          branch: "epic/child-2",
          status: "queued",
          reason: null,
          fixIssueId: null,
        },
      ],
    });
    return Effect.gen(function* () {
      const runner = yield* EpicRunner;
      yield* runner.cancelRun({ runId });
      assert.deepStrictEqual(
        harness
          .commandsOfType("thread.turn.start")
          .filter((command) => command.threadId === originThreadId)
          .map((command) => command.message.text),
        [
          `EpicRunner run ${runId} for epic-origin-detail: cancelled. Iterations 2/10. Error: infra:merge-reconciliation: gate timeout. Landed: child-1. Unmerged branches: epic/child-2.`,
        ],
      );
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("reports a stored status when later run fan-out fails", () => {
    const originThreadId = ThreadId.make("thread-epic-origin-fan-out-failure");
    const harness = createHarness({ script: [], failListIterations: true });

    return Effect.gen(function* () {
      const runner = yield* EpicRunner;
      const exit = yield* Effect.exit(
        runner.launchRun({
          epicId: "epic-origin-fan-out-failure",
          projectId,
          cwd: "/tmp/epic-runner-repo",
          originThreadId,
        }),
      );

      assert.isTrue(Exit.isFailure(exit));
      const stored = [...harness.store.runs.values()][0]!;
      assert.strictEqual(stored.status, "running");
      assert.deepStrictEqual(
        harness
          .commandsOfType("thread.turn.start")
          .filter((command) => command.threadId === originThreadId)
          .map((command) => command.message.text),
        [
          `EpicRunner run ${stored.runId} for epic-origin-fan-out-failure: started. Iterations 0/50.`,
        ],
      );
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("reaches completion without consuming streamRuns, stopping on RALPH_DONE", () => {
    const harness = createHarness({
      script: [
        { text: 'work\nRALPH_MSG: {"summary":"first","why":"needed"}', head: "head-1" },
        { text: "more work", head: "head-2" },
        { text: "backlog is empty\n\nRALPH_DONE", head: "head-2" },
      ],
    });

    return Effect.gen(function* () {
      const run = yield* startRun();
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "done");

      const finished = harness.store.runs.get(run.runId)!;
      assert.strictEqual(finished.status, "done");
      assert.strictEqual(finished.iterationsCompleted, 3);
      assert.strictEqual(finished.consecutiveFailures, 0);
      assert.strictEqual(finished.currentThreadId, ThreadId.make(`epic-run-${run.runId}-2`));

      // Every iteration got its own fresh thread, and the loop stopped at
      // RALPH_DONE rather than running on to maxIterations.
      const created = harness.commandsOfType("thread.create");
      assert.strictEqual(created.length, 3);
      assert.strictEqual(new Set(created.map((command) => command.threadId)).size, 3);
      assert.strictEqual(harness.turnsStarted(), 3);

      assert.deepStrictEqual(
        harness.store.iterations.map((iteration) => iteration.turnStatus),
        ["completed", "completed", "completed"],
      );
      assert.deepStrictEqual(
        harness.store.iterations.map((iteration) => iteration.failureReason),
        [null, null, null],
      );
      assert.strictEqual(harness.store.iterations[0]?.summary, "first");
      assert.strictEqual(harness.store.iterations[0]?.why, "needed");
      assert.deepStrictEqual(
        harness.store.iterations.map((iteration) => iteration.issueId),
        ["child-1", "child-2", "child-3"],
      );
      assert.match(
        harness.commandsOfType("thread.turn.start")[0]!.message.text,
        /Cook exactly `child-1` this iteration\./,
      );
    }).pipe(Effect.provide(harness.layer));
  });

  it.live(
    "classifies an iteration done when the assistant message settles after the turn ends",
    () => {
      // The turn is reported `completed` before the assistant message has
      // projected — the exact race `readSettledFinalMessage` must survive
      // rather than mistaking the absent message for a settled, empty one.
      const harness = createHarness({
        script: [
          {
            text: 'did the work\nRALPH_MSG: {"summary":"settled late","why":"race"}',
            head: "head-1",
            messageSettleDelayReads: 2,
          },
        ],
        options: { iterationTimeoutMs: 60_000 },
      });

      return Effect.gen(function* () {
        const runner = yield* EpicRunner;
        const run = yield* startRun();
        yield* waitFor(() => harness.store.iterations[0]?.turnStatus === "completed");

        assert.strictEqual(harness.store.iterations[0]?.summary, "settled late");
        assert.strictEqual(harness.store.iterations[0]?.why, "race");
        assert.strictEqual(harness.store.runs.get(run.runId)?.consecutiveFailures, 0);

        yield* runner.cancelRun({ runId: run.runId });
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.live("classifies the iteration turn while a newer human turn is running", () => {
    const harness = createHarness({
      script: [
        {
          text: 'iteration answer\nRALPH_MSG: {"summary":"turn one","why":"assigned work"}',
          head: "head-1",
          settleDelayMs: 0,
          humanFollowupText:
            'human answer\nRALPH_MSG: {"summary":"wrong turn","why":"unrelated message"}',
        },
      ],
      options: { iterationTimeoutMs: 60_000 },
    });

    return Effect.gen(function* () {
      const runner = yield* EpicRunner;
      const run = yield* startRun();
      yield* waitFor(() => harness.store.iterations[0]?.turnStatus === "completed");

      assert.strictEqual(harness.store.iterations[0]?.summary, "turn one");
      assert.strictEqual(harness.store.iterations[0]?.why, "assigned work");
      assert.strictEqual(harness.commandsOfType("thread.session.stop").length, 0);
      yield* runner.cancelRun({ runId: run.runId });
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("classifies a genuinely message-less completed turn as a protocol error", () => {
    // "No message ever". The turn completed, the settle wait ran out, and the
    // iteration left no commit behind — nothing to judge it by, so it fails.
    const harness = createHarness({
      script: [{ text: null, head: "head-0", turnState: "completed" }],
      options: { infraFailureBudget: 1 },
    });

    return Effect.gen(function* () {
      const run = yield* startRun();
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "failed");

      const failed = harness.store.runs.get(run.runId)!;
      assert.include(failed.lastError ?? "", "turn completed without an assistant message");
      assert.strictEqual(harness.store.iterations[0]?.turnStatus, "failed");
      assert.strictEqual(harness.store.iterations[0]?.failureReason, "infra:protocol-error");
    }).pipe(Effect.provide(harness.layer));
  });

  it.live(
    "keeps a committed iteration whose message never projected out of the failure count",
    () => {
      // Regression for t3code-9vf. "No message *yet*" and "no message ever" look
      // identical in projections — under the default buffered delivery mode a
      // pending final message has no assistant row at all, not a streaming one —
      // so once the settle wait is exhausted the verdict falls to the other
      // observation: the commit. Without it this iteration reads as a protocol
      // error and three in a row kill the run.
      const harness = createHarness({
        script: [{ text: null, head: "head-1", turnState: "completed" }],
        options: { iterationTimeoutMs: 60_000, maxConsecutiveFailures: 1 },
      });

      return Effect.gen(function* () {
        const runner = yield* EpicRunner;
        const run = yield* startRun();
        yield* waitFor(() => harness.store.iterations[0]?.turnStatus === "completed");

        assert.strictEqual(
          harness.store.iterations[0]?.summary,
          "assistant message never projected; accepted on the iteration's commit",
        );
        assert.strictEqual(harness.store.runs.get(run.runId)?.consecutiveFailures, 0);
        assert.strictEqual(harness.store.runs.get(run.runId)?.lastError, null);
        assert.notStrictEqual(harness.store.runs.get(run.runId)?.status, "failed");

        yield* runner.cancelRun({ runId: run.runId });
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.live(
    "classifies a settled iteration done when the turn pointer has not been restored yet",
    () => {
      // Regression for t3code-pxv. The settling transaction nulls
      // `threads.latest_turn_id`, and only the checkpoint reactor restores it —
      // after git work that can be slow or fail outright. Every read in between
      // sees `latestTurn: null`, which is indistinguishable from "never ran"
      // unless classification falls back to the session status the projector
      // settled the turn from.
      const harness = createHarness({
        script: [
          {
            text: 'did the work\nRALPH_MSG: {"summary":"landed","why":"pointer lagged"}',
            head: "head-1",
            detailTurnPointerNull: true,
          },
        ],
        options: { iterationTimeoutMs: 60_000 },
      });

      return Effect.gen(function* () {
        const runner = yield* EpicRunner;
        const run = yield* startRun();
        yield* waitFor(() => harness.store.iterations[0]?.turnStatus === "completed");

        assert.strictEqual(harness.store.iterations[0]?.summary, "landed");
        assert.strictEqual(harness.store.runs.get(run.runId)?.consecutiveFailures, 0);
        assert.strictEqual(harness.store.runs.get(run.runId)?.lastError, null);

        yield* runner.cancelRun({ runId: run.runId });
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.live("still reports an interrupted turn as an error when the turn pointer is missing", () => {
    // The session-status fallback must not launder every missing pointer into
    // "completed": a session that stopped mid-turn still has to fail.
    const harness = createHarness({
      script: [
        {
          text: 'partial\nRALPH_MSG: {"summary":"nope","why":"nope"}',
          head: "head-1",
          detailTurnPointerNull: true,
          sessionStatus: "stopped",
        },
      ],
      options: { infraFailureBudget: 1 },
    });

    return Effect.gen(function* () {
      const run = yield* startRun();
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "failed");

      assert.include(harness.store.runs.get(run.runId)?.lastError ?? "", "turn was interrupted");
      assert.strictEqual(harness.store.iterations[0]?.turnStatus, "failed");
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("returns the same active run for sequential duplicate starts", () => {
    const harness = createHarness({
      script: [{ text: null, head: "head-0", stall: true }],
      options: { iterationTimeoutMs: 60_000 },
    });

    return Effect.gen(function* () {
      const runner = yield* EpicRunner;
      const first = yield* startRun();
      yield* waitFor(() => harness.turnsStarted() === 1);
      const duplicate = yield* runner.startRun({
        epicId: "epic-1",
        projectId,
        cwd: "/tmp/epic-runner-repo",
        prompt: "different settings must not replace the active run",
        modelSelection: { ...modelSelection, model: "different-model" },
        maxIterations: 99,
      });

      assert.strictEqual(duplicate.runId, first.runId);
      assert.strictEqual(duplicate.prompt, first.prompt);
      assert.strictEqual(harness.store.runs.size, 1);
      assert.strictEqual(harness.commandsOfType("thread.turn.start").length, 1);
      assert.strictEqual(harness.store.iterations.length, 1);
      yield* runner.cancelRun({ runId: first.runId });
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("returns the winning run for concurrent duplicate starts", () => {
    const harness = createHarness({
      script: [{ text: null, head: "head-0", stall: true }],
      options: { iterationTimeoutMs: 60_000 },
      // The loser sees the held lock well before the winning row is visible.
      upsertDelayMs: 25,
    });

    return Effect.gen(function* () {
      const runner = yield* EpicRunner;
      const [first, duplicate] = yield* Effect.all([startRun(), startRun()], {
        concurrency: "unbounded",
      });
      yield* waitFor(() => harness.turnsStarted() === 1);

      assert.strictEqual(duplicate.runId, first.runId);
      assert.strictEqual(harness.store.runs.size, 1);
      assert.strictEqual(harness.commandsOfType("thread.turn.start").length, 1);
      assert.strictEqual(harness.store.iterations.length, 1);
      yield* runner.cancelRun({ runId: first.runId });
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("returns the winning run when preflight observes its held lock", () => {
    const harness = createHarness({
      script: [{ text: null, head: "head-0", stall: true }],
      options: { iterationTimeoutMs: 60_000 },
      upsertDelayMs: 25,
      preflightResults: [
        stubPreflightResult(),
        stubPreflightResult({
          ok: false,
          blockers: [
            {
              _tag: "run_in_progress",
              owner: "t3code",
              runDir: "/tmp/epic-runner-repo",
              host: "test",
              pid: process.pid,
            },
          ],
        }),
      ],
    });

    return Effect.gen(function* () {
      const [first, duplicate] = yield* Effect.all([startRun(), startRun()], {
        concurrency: "unbounded",
      });
      yield* waitFor(() => harness.turnsStarted() === 1);

      assert.strictEqual(duplicate.runId, first.runId);
      assert.strictEqual(harness.store.runs.size, 1);
      assert.strictEqual(harness.activeLockCount(), 1);
      assert.strictEqual(harness.preflightModes.length, 2);
      yield* Effect.flatMap(EpicRunner, (runner) => runner.cancelRun({ runId: first.runId }));
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("preserves a preflight lock blocker when no winning row appears", () => {
    const blocker = {
      _tag: "run_in_progress" as const,
      owner: "terminal",
      runDir: "/tmp/terminal-run",
      host: "test-host",
      pid: 42,
    };
    const harness = createHarness({
      script: [],
      preflightResult: stubPreflightResult({ ok: false, blockers: [blocker] }),
    });

    return Effect.gen(function* () {
      const error = yield* Effect.flip(startRun());
      assert.strictEqual(error._tag, "EpicRunPreflightBlockedError");
      if (error._tag === "EpicRunPreflightBlockedError") {
        assert.deepStrictEqual(error.blockers, [formatEpicRunPreflightBlocker(blocker)]);
      }
      assert.strictEqual(harness.store.runs.size, 0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("preserves generic lock acquisition failures", () => {
    const harness = createHarness({
      script: [],
      lockAcquireError: new EpicRunLockError("test-generic-lock-failure"),
    });

    return Effect.gen(function* () {
      const error = yield* Effect.flip(startRun());
      assert.strictEqual(error._tag, "EpicRunPreflightBlockedError");
      if (error._tag === "EpicRunPreflightBlockedError") {
        assert.deepStrictEqual(error.blockers, [
          "Epic run lock operation failed: test-generic-lock-failure",
        ]);
      }
      assert.strictEqual(harness.store.runs.size, 0);
      assert.strictEqual(harness.turnsStarted(), 0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("preserves holder details when lock acquisition loses a race", () => {
    const harness = createHarness({
      script: [],
      lockAcquireError: new EpicRunLockHeldError("/tmp/epic-1.lock", {
        owner: "terminal",
        host: "worker-host",
        pid: 42,
        runDir: "/tmp/terminal-run",
      }),
    });

    return Effect.gen(function* () {
      const error = yield* Effect.flip(startRun());
      assert.strictEqual(error._tag, "EpicRunPreflightBlockedError");
      if (error._tag === "EpicRunPreflightBlockedError") {
        assert.deepStrictEqual(error.blockers, [
          "Another epic run owns this repository on worker-host (PID 42, /tmp/terminal-run).",
        ]);
      }
      assert.strictEqual(harness.store.runs.size, 0);
      assert.strictEqual(harness.turnsStarted(), 0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("preserves preflight check failures", () => {
    const harness = createHarness({
      script: [],
      preflightError: new EpicRunPreflightError({ message: "preflight exploded" }),
    });

    return Effect.gen(function* () {
      const error = yield* Effect.flip(startRun());
      assert.strictEqual(error._tag, "EpicRunPreflightBlockedError");
      if (error._tag === "EpicRunPreflightBlockedError") {
        assert.deepStrictEqual(error.blockers, ["preflight exploded"]);
      }
      assert.strictEqual(harness.store.runs.size, 0);
      assert.strictEqual(harness.turnsStarted(), 0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("returns an active duplicate launch before validating project defaults", () => {
    const harness = createHarness({
      script: [{ text: null, head: "head-0", stall: true }],
      options: { iterationTimeoutMs: 60_000 },
    });

    return Effect.gen(function* () {
      const runner = yield* EpicRunner;
      const active = yield* startRun();
      yield* waitFor(() => harness.turnsStarted() === 1);

      const duplicate = yield* runner.launchRun({
        epicId: active.epicId,
        projectId: ProjectId.make("project-that-does-not-own-the-cwd"),
        cwd: active.cwd,
      });
      assert.strictEqual(duplicate.runId, active.runId);
      assert.strictEqual(harness.store.runs.size, 1);
      assert.strictEqual(harness.commandsOfType("thread.turn.start").length, 1);
      yield* runner.cancelRun({ runId: active.runId });
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("leaves finished iteration sessions for idle reaping", () => {
    const harness = createHarness({
      script: [
        { text: "work", head: "head-1", subagentDrainReads: 3 },
        { text: "RALPH_DONE", head: "head-1" },
      ],
    });

    return Effect.gen(function* () {
      const run = yield* startRun();
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "done");

      const stops = harness.commandsOfType("thread.session.stop");
      assert.strictEqual(harness.commandsOfType("thread.settle").length, 0);
      assert.strictEqual(stops.length, 0);
      assert.deepStrictEqual(harness.stopsWithRunningSubagents(), []);
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("does not dispatch normal session stops after settlement", () => {
    const harness = createHarness({
      script: [
        { text: "work", head: "head-1" },
        { text: "RALPH_DONE", head: "head-1" },
      ],
      guardedStopRefusals: 1,
    });

    return Effect.gen(function* () {
      const run = yield* startRun();
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "done");

      const stops = harness.commandsOfType("thread.session.stop");
      assert.strictEqual(stops.length, 0);
      assert.deepStrictEqual(harness.stopsWithRunningSubagents(), []);
      assert.strictEqual(harness.commandsOfType("thread.settle").length, 0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("waits out running subagents after a no-commit turn and sends a continuation", () => {
    // The 2026-08-04 incident shape: the agent backgrounded its work and
    // ended the turn with no commit while a Task subagent was still running.
    // Settling here would tear the session down and kill the subagent, so
    // the runner must wait for the drain and grant one continuation turn.
    const harness = createHarness({
      script: [
        {
          text: "Watchdog running. Waiting for the workflow to complete...",
          head: "head-0",
          subagentDrainReads: 3,
        },
        // The continuation, dispatched only after the subagent drained.
        {
          text: 'folded it in\nRALPH_MSG: {"summary":"landed after grace","why":"subagent finished"}',
          head: "head-1",
        },
        // A plain iteration with zero subagents stops normally.
        { text: "RALPH_DONE", head: "head-1" },
      ],
      options: { iterationTimeoutMs: 60_000 },
    });
    const logs = captureLogs();

    return Effect.gen(function* () {
      const run = yield* startRun();
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "done");

      const created = harness.commandsOfType("thread.create");
      assert.strictEqual(created.length, 2);
      const iterationThreadId = created[0]!.threadId;
      const turnStarts = harness
        .commandsOfType("thread.turn.start")
        .filter((command) => command.threadId === iterationThreadId);
      // The original turn plus exactly ONE continuation, never more.
      assert.strictEqual(turnStarts.length, 2);
      const continuation = turnStarts[1]!;
      assert.strictEqual(continuation.message.text, EPIC_RUN_CONTINUATION_PROMPT);
      assert.strictEqual(continuation.message.messageId, `${iterationThreadId}-continue`);
      assert.strictEqual(continuation.origin, "agent");
      assert.strictEqual(continuation.delivery, "turn-boundary");

      assert.strictEqual(
        harness
          .commandsOfType("thread.session.stop")
          .filter((command) => command.threadId === iterationThreadId).length,
        0,
      );

      // The continuation's commit and report classified the iteration.
      assert.strictEqual(harness.store.iterations[0]?.turnStatus, "completed");
      assert.strictEqual(harness.store.iterations[0]?.summary, "landed after grace");
      assert.strictEqual(harness.store.runs.get(run.runId)?.consecutiveFailures, 0);

      // The zero-subagent iteration got one turn and one stop.
      assert.strictEqual(harness.commandsOfType("thread.turn.start").length, 3);
      assert.strictEqual(harness.commandsOfType("thread.settle").length, 0);
      assert.strictEqual(harness.commandsOfType("thread.session.stop").length, 0);
      assert.isUndefined(
        logs.messages.find((message) => message[0] === "epic.runner.subagent-grace-cap"),
      );
    }).pipe(Effect.provide(Layer.merge(harness.layer, logs.layer)));
  });

  it.live("does not send a grace continuation into a newer human turn", () => {
    const harness = createHarness({
      script: [
        {
          text: "I am still implementing the child.",
          head: "head-0",
          worktreeFingerprint: " M apps/server/src/runner/Layers/EpicRunner.ts\n",
          humanFollowupText: "Can you check one more thing?",
          humanFollowupAfterDetailReads: 1,
        },
      ],
      options: { maxNoCommitStreak: 1 },
    });

    return Effect.gen(function* () {
      const run = yield* startRun();
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "failed");

      const iterationThreadId = harness.commandsOfType("thread.create")[0]!.threadId;
      const turnStarts = harness
        .commandsOfType("thread.turn.start")
        .filter((command) => command.threadId === iterationThreadId);
      assert.strictEqual(turnStarts.length, 1);
      assert.strictEqual(harness.store.iterations[0]?.failureReason, "child:no-commit-child-open");
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("continues when a transiently null turn pointer restores", () => {
    const harness = createHarness({
      script: [
        {
          text: "I am still implementing the child.",
          head: "head-0",
          worktreeFingerprint: " M apps/server/src/runner/Layers/EpicRunner.ts\n",
          detailTurnPointerNull: true,
          restoreTurnPointerAfterDetailReads: 1,
        },
        {
          text: 'Finished the child.\nRALPH_MSG: {"summary":"restored pointer","why":"grace continued"}',
          head: "head-1",
          worktreeFingerprint: "",
        },
        { text: "RALPH_DONE", head: "head-1" },
      ],
      options: { maxNoCommitStreak: 1 },
    });

    return Effect.gen(function* () {
      const run = yield* startRun();
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "done");

      const iterationThreadId = harness.commandsOfType("thread.create")[0]!.threadId;
      const turnStarts = harness
        .commandsOfType("thread.turn.start")
        .filter((command) => command.threadId === iterationThreadId);
      assert.strictEqual(turnStarts.length, 2);
      assert.strictEqual(harness.store.iterations[0]?.summary, "restored pointer");
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("continues a protocol-silent no-commit turn when the worktree moved", () => {
    const harness = createHarness({
      script: [
        {
          text: "I am still implementing the child.",
          head: "head-0",
          worktreeFingerprint: " M apps/server/src/runner/Layers/EpicRunner.ts\n",
        },
        {
          text: 'Finished the child.\nRALPH_MSG: {"summary":"landed stalled work","why":"the worktree showed progress"}',
          head: "head-1",
          worktreeFingerprint: "",
        },
        { text: "RALPH_DONE", head: "head-1" },
      ],
      options: { iterationTimeoutMs: 60_000 },
    });

    return Effect.gen(function* () {
      const run = yield* startRun();
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "done");

      const iterationThreadId = harness.commandsOfType("thread.create")[0]!.threadId;
      const turnStarts = harness
        .commandsOfType("thread.turn.start")
        .filter((command) => command.threadId === iterationThreadId);
      assert.strictEqual(turnStarts.length, 2);
      assert.strictEqual(turnStarts[1]!.message.text, EPIC_RUN_STALLED_PROGRESS_PROMPT);
      assert.strictEqual(turnStarts[1]!.message.messageId, `${iterationThreadId}-continue`);
      assert.strictEqual(harness.store.iterations[0]?.turnStatus, "completed");
      assert.strictEqual(harness.store.iterations[0]?.summary, "landed stalled work");
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("does not continue a protocol-silent turn when the worktree did not move", () => {
    const harness = createHarness({
      script: [{ text: "I stopped before making progress.", head: "head-0" }],
      options: { maxNoCommitStreak: 1 },
    });

    return Effect.gen(function* () {
      const run = yield* startRun();
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "failed");

      assert.strictEqual(harness.commandsOfType("thread.turn.start").length, 1);
      assert.strictEqual(harness.store.iterations[0]?.failureReason, "child:no-commit-child-open");
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("does not continue RALPH_DONE with an unchanged dirty worktree", () => {
    const fingerprint = " M apps/server/src/runner/Layers/EpicRunner.ts\n";
    const harness = createHarness({
      initialWorktreeFingerprint: fingerprint,
      script: [{ text: "RALPH_DONE", head: "head-0", worktreeFingerprint: fingerprint }],
    });

    return Effect.gen(function* () {
      const run = yield* startRun();
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "done");

      assert.strictEqual(harness.commandsOfType("thread.turn.start").length, 1);
      assert.strictEqual(harness.store.iterations[0]?.turnStatus, "completed");
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("does not continue a RALPH_MSG no-commit turn when the worktree moved", () => {
    const harness = createHarness({
      script: [
        {
          text: 'RALPH_MSG: {"summary":"reported without commit","why":"the child failed"}',
          head: "head-0",
          worktreeFingerprint: " M apps/server/src/runner/Layers/EpicRunner.ts\n",
        },
      ],
      options: { maxNoCommitStreak: 1 },
    });

    return Effect.gen(function* () {
      const run = yield* startRun();
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "failed");

      assert.strictEqual(harness.commandsOfType("thread.turn.start").length, 1);
      assert.strictEqual(harness.store.iterations[0]?.failureReason, "child:no-commit-child-open");
      assert.strictEqual(harness.store.iterations[0]?.summary, "reported without commit");
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("shares the grace cap across subagent and stalled-progress turns", () => {
    const harness = createHarness({
      script: [
        {
          text: "The subagent is still finishing.",
          head: "head-0",
          worktreeFingerprint: " M first.ts\n",
          subagentDrainReads: 1,
        },
        {
          text: "The resumed turn ended silently after more work.",
          head: "head-0",
          worktreeFingerprint: " M first.ts\n M second.ts\n",
        },
      ],
      options: { maxGraceContinuations: 1, maxNoCommitStreak: 1 },
    });

    return Effect.gen(function* () {
      const run = yield* startRun();
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "failed");

      const iterationThreadId = harness.commandsOfType("thread.create")[0]!.threadId;
      const turnStarts = harness
        .commandsOfType("thread.turn.start")
        .filter((command) => command.threadId === iterationThreadId);
      assert.strictEqual(turnStarts.length, 2);
      assert.strictEqual(turnStarts[1]!.message.text, EPIC_RUN_CONTINUATION_PROMPT);
      assert.strictEqual(harness.store.iterations[0]?.failureReason, "child:no-commit-child-open");
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("caps repeated subagent grace continuations and classifies the final turn", () => {
    const harness = createHarness({
      script: [
        {
          text: "The reviewer is still running.",
          head: "head-0",
          subagentDrainReads: 1,
        },
        {
          text: "The implementer is still running.",
          head: "head-0",
          subagentDrainReads: 1,
        },
        {
          text: 'Reached the continuation cap.\nRALPH_MSG: {"summary":"classified at the cap","why":"turn count stayed bounded"}',
          head: "head-0",
          subagentDrainReads: 1,
        },
        { text: "RALPH_DONE", head: "head-0" },
      ],
      options: { maxGraceContinuations: 2, iterationTimeoutMs: 60_000 },
    });
    const logs = captureLogs();

    return Effect.gen(function* () {
      const run = yield* startRun();
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "done");

      const iterationThreadId = harness.commandsOfType("thread.create")[0]!.threadId;
      const turnStarts = harness
        .commandsOfType("thread.turn.start")
        .filter((command) => command.threadId === iterationThreadId);
      assert.strictEqual(turnStarts.length, 3);

      assert.strictEqual(
        harness
          .commandsOfType("thread.session.stop")
          .filter((command) => command.threadId === iterationThreadId).length,
        0,
      );
      assert.strictEqual(harness.store.iterations[0]?.summary, "classified at the cap");
      assert.strictEqual(harness.store.iterations[0]?.failureReason, "child:no-commit-child-open");

      const capLog = logs.messages.find(
        (message) => message[0] === "epic.runner.subagent-grace-cap",
      );
      assert.deepStrictEqual(capLog?.[1], {
        runId: run.runId,
        iterationIndex: 0,
        threadId: iterationThreadId,
        continuationIndex: 2,
      });
    }).pipe(Effect.provide(Layer.merge(harness.layer, logs.layer)));
  });

  it.live("clamps the subagent grace continuation cap to one", () => {
    const harness = createHarness({
      script: [
        { text: "First subagent batch.", head: "head-0", subagentDrainReads: 1 },
        { text: "Second subagent batch.", head: "head-0", subagentDrainReads: 1 },
        { text: "RALPH_DONE", head: "head-0" },
      ],
      options: { maxGraceContinuations: 0, iterationTimeoutMs: 60_000 },
    });
    const logs = captureLogs();

    return Effect.gen(function* () {
      const run = yield* startRun();
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "done");

      const iterationThreadId = harness.commandsOfType("thread.create")[0]!.threadId;
      assert.strictEqual(
        harness
          .commandsOfType("thread.turn.start")
          .filter((command) => command.threadId === iterationThreadId).length,
        2,
      );
      const capLog = logs.messages.find(
        (message) => message[0] === "epic.runner.subagent-grace-cap",
      );
      assert.strictEqual(
        (capLog?.[1] as { readonly continuationIndex?: number } | undefined)?.continuationIndex,
        1,
      );
    }).pipe(Effect.provide(Layer.merge(harness.layer, logs.layer)));
  });

  it.live("resumes through reviewer and implementer subagents before the parent commits", () => {
    // A cook-it parent can delegate a review, resume to delegate implementation,
    // then need another resume to integrate and commit. Every delegation ends
    // the parent turn while its new subagent is still running.
    const harness = createHarness({
      script: [
        {
          text: "The reviewer is checking the plan.",
          head: "head-0",
          subagentDrainReads: 2,
        },
        {
          text: "The implementer is applying the reviewed plan.",
          head: "head-0",
          subagentDrainReads: 2,
        },
        {
          text: 'Integrated the implementation.\nRALPH_MSG: {"summary":"nested chain landed","why":"review and implementation finished"}',
          head: "head-1",
        },
        { text: "RALPH_DONE", head: "head-1" },
      ],
      options: { iterationTimeoutMs: 60_000 },
    });

    return Effect.gen(function* () {
      const run = yield* startRun();
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "done");

      const iterationThreadId = harness.commandsOfType("thread.create")[0]!.threadId;
      const turnStarts = harness
        .commandsOfType("thread.turn.start")
        .filter((command) => command.threadId === iterationThreadId);
      assert.strictEqual(turnStarts.length, 3);
      assert.deepStrictEqual(
        turnStarts.map((command) => command.message.messageId),
        [
          `${iterationThreadId}-prompt`,
          `${iterationThreadId}-continue`,
          `${iterationThreadId}-continue-2`,
        ],
      );
      assert.deepStrictEqual(
        turnStarts.slice(1).map((command) => command.message.text),
        [EPIC_RUN_CONTINUATION_PROMPT, EPIC_RUN_CONTINUATION_PROMPT],
      );

      assert.strictEqual(
        harness
          .commandsOfType("thread.session.stop")
          .filter((command) => command.threadId === iterationThreadId).length,
        0,
      );
      assert.strictEqual(harness.store.iterations[0]?.turnStatus, "completed");
      assert.strictEqual(harness.store.iterations[0]?.summary, "nested chain landed");
      assert.strictEqual(harness.store.runs.get(run.runId)?.consecutiveFailures, 0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("gives up the subagent grace wait at its bound and classifies as today", () => {
    // A subagent that never drains must not wedge the iteration: the grace
    // wait is bounded, and past the bound the no-commit turn is classified
    // exactly as it would have been without the grace path.
    const harness = createHarness({
      script: [
        {
          text: "still waiting on my background task",
          head: "head-0",
          subagentDrainReads: Number.POSITIVE_INFINITY,
        },
      ],
      options: { subagentGraceTimeoutMs: 40, maxNoCommitStreak: 1 },
    });

    return Effect.gen(function* () {
      const run = yield* startRun();
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "failed");

      // No continuation was ever dispatched.
      assert.strictEqual(harness.commandsOfType("thread.turn.start").length, 1);
      assert.strictEqual(harness.store.iterations[0]?.failureReason, "child:no-commit-child-open");
      assert.strictEqual(harness.commandsOfType("thread.settle").length, 0);
      assert.strictEqual(harness.commandsOfType("thread.session.stop").length, 0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("retries infra failures with backoff and fails only at the infra budget", () => {
    const failing = {
      text: null,
      head: "head-0",
      turnState: "error",
      sessionStatus: "error",
    } as const;
    const harness = createHarness({
      script: [failing, failing, failing, { text: "should never run", head: "head-9" }],
      // Below the failure count so exhaustion is observable; the default
      // budget (5) would have kept retrying past all three.
      configFileResult: loadedConfigFile({ server: { infraFailureBudget: 3 } }),
      options: { maxConsecutiveFailures: 1 },
    });

    return Effect.gen(function* () {
      const run = yield* startRun();
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "failed");

      const failed = harness.store.runs.get(run.runId)!;
      // Errored turns are infra failures: they never consume the
      // maxConsecutiveFailures budget (set to 1 above to prove it), and the
      // run survives until the dedicated infra budget runs out.
      assert.strictEqual(failed.consecutiveFailures, 0);
      assert.include(failed.lastError ?? "", "turn ended in an error state");
      assert.include(failed.lastError ?? "", "3 consecutive infrastructure failures");
      // The fourth scripted iteration must not have been reached.
      assert.strictEqual(harness.turnsStarted(), 3);
      assert.deepStrictEqual(
        harness.store.iterations.map((iteration) => iteration.turnStatus),
        ["failed", "failed", "failed"],
      );
      assert.deepStrictEqual(
        harness.store.iterations.map((iteration) => iteration.failureReason),
        ["infra:turn-error", "infra:turn-error", "infra:turn-error"],
      );
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("keeps each simultaneous run on its own persisted failure policy", () => {
    const blocked = { text: "cannot proceed\nRALPH_BLOCKED", head: "head-0" } as const;
    const harness = createHarness({ script: [blocked, blocked, blocked, blocked] });

    return Effect.gen(function* () {
      const runner = yield* EpicRunner;
      const [oneFailureRun, twoFailureRun] = yield* Effect.all(
        [
          runner.startRun({
            epicId: "epic-one-failure",
            projectId,
            cwd: "/tmp/epic-runner-repo",
            prompt: "do one unit of work",
            orientationFile: null,
            modelSelection,
            config: { server: { maxConsecutiveFailures: 1 } },
          }),
          runner.startRun({
            epicId: "epic-two-failures",
            projectId,
            cwd: "/tmp/epic-runner-repo",
            prompt: "do one unit of work",
            orientationFile: null,
            modelSelection,
            config: { server: { maxConsecutiveFailures: 2 } },
          }),
        ],
        { concurrency: "unbounded" },
      );
      yield* waitFor(
        () =>
          harness.store.runs.get(oneFailureRun.runId)?.status === "failed" &&
          harness.store.runs.get(twoFailureRun.runId)?.status === "failed",
      );

      assert.strictEqual(
        harness.store.iterations.filter((row) => row.runId === oneFailureRun.runId).length,
        1,
      );
      assert.strictEqual(
        harness.store.iterations.filter((row) => row.runId === twoFailureRun.runId).length,
        2,
      );
      assert.strictEqual(harness.store.runs.get(oneFailureRun.runId)?.consecutiveFailures, 1);
      assert.strictEqual(harness.store.runs.get(twoFailureRun.runId)?.consecutiveFailures, 2);
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("keeps the initial persisted policy after the stored config changes", () => {
    const blocked = { text: "cannot proceed\nRALPH_BLOCKED", head: "head-0" } as const;
    const harness = createHarness({
      script: [{ ...blocked, settleDelayMs: 40 }, blocked, blocked],
    });

    return Effect.gen(function* () {
      const runner = yield* EpicRunner;
      const run = yield* runner.startRun({
        epicId: "epic-frozen-policy",
        projectId,
        cwd: "/tmp/epic-runner-repo",
        prompt: "do one unit of work",
        orientationFile: null,
        modelSelection,
        config: { server: { maxConsecutiveFailures: 2 } },
      });
      yield* waitFor(() => harness.turnsStarted() === 1);

      const active = harness.store.runs.get(run.runId)!;
      harness.store.runs.set(run.runId, {
        ...active,
        config: {
          ...active.config,
          server: { ...active.config.server, maxConsecutiveFailures: 1 },
        },
        configProvenance: {
          ...active.configProvenance,
          "server.maxConsecutiveFailures": "override",
        },
      });

      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "failed");
      assert.strictEqual(
        harness.store.iterations.filter((row) => row.runId === run.runId).length,
        2,
      );
      assert.strictEqual(harness.store.runs.get(run.runId)?.consecutiveFailures, 2);
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("keeps consecutive infra failures out of the gutter and retries through them", () => {
    // The 2026-08-04 incident shape: two provider deaths in a row must not
    // read as "2 iterations without a commit". With the default gutter
    // threshold of 2, an infra failure that incremented the no-commit streak
    // would fail this run at the second provider error; instead the run backs
    // off, retries, and still has the full gutter budget for the genuine
    // no-commit that follows.
    const spendLimit = "You've hit your org's monthly spend limit; it resets on the 1st";
    const providerDeath = {
      text: null,
      head: "head-0",
      turnState: "error",
      sessionStatus: "error",
      sessionLastError: spendLimit,
    } as const;
    const harness = createHarness({
      script: [
        providerDeath,
        providerDeath,
        { text: "thinking about it", head: "head-0" },
        { text: "RALPH_DONE", head: "head-0" },
      ],
    });

    return Effect.gen(function* () {
      const run = yield* startRun();
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "done");

      assert.strictEqual(harness.turnsStarted(), 4);
      assert.deepStrictEqual(
        harness.store.iterations.map((iteration) => iteration.failureReason),
        [
          "infra:provider-error:spend-limit",
          "infra:provider-error:spend-limit",
          "child:no-commit-child-open",
          null,
        ],
      );
      // Infra failures never touched the persisted child-failure budget.
      assert.strictEqual(harness.store.runs.get(run.runId)?.consecutiveFailures, 0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("resets the infra streak when an iteration succeeds", () => {
    const failing = {
      text: null,
      head: "head-0",
      turnState: "error",
      sessionStatus: "error",
    } as const;
    const harness = createHarness({
      script: [
        failing,
        { text: 'work\nRALPH_MSG: {"summary":"landed","why":"progress"}', head: "head-1" },
        { ...failing, head: "head-1" },
        { ...failing, head: "head-1" },
        { text: "should never run", head: "head-9" },
      ],
      options: { infraFailureBudget: 2 },
    });

    return Effect.gen(function* () {
      const run = yield* startRun();
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "failed");

      // Without the reset the budget of 2 would have failed the run at the
      // third iteration; the successful commit bought a fresh budget.
      assert.strictEqual(harness.turnsStarted(), 4);
      assert.deepStrictEqual(
        harness.store.iterations.map((iteration) => iteration.turnStatus),
        ["failed", "completed", "failed", "failed"],
      );
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("charges a RALPH_BLOCKED report to the child failure budget, not the infra one", () => {
    const harness = createHarness({
      script: [{ text: "cannot proceed\nRALPH_BLOCKED", head: "head-0" }],
      options: { maxConsecutiveFailures: 1 },
    });

    return Effect.gen(function* () {
      const run = yield* startRun();
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "failed");

      const failed = harness.store.runs.get(run.runId)!;
      assert.strictEqual(failed.consecutiveFailures, 1);
      assert.strictEqual(failed.lastError, "agent reported RALPH_BLOCKED");
      assert.strictEqual(harness.store.iterations[0]?.failureReason, "child:blocked");
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("surfaces the session's provider error into the iteration row and run.lastError", () => {
    // The 2026-08-04 incident: a 429 spend limit killed both runs, but the
    // only recorded reason was "gutter: 2 iterations without a commit". The
    // real error text is in the projected session's lastError and must reach
    // the iteration summary and, when the run fails, epic_runs.last_error.
    const spendLimit = "You've hit your org's monthly spend limit; it resets on the 1st";
    const harness = createHarness({
      script: [
        {
          text: null,
          head: "head-0",
          turnState: "error",
          sessionStatus: "error",
          sessionLastError: spendLimit,
        },
      ],
      options: { infraFailureBudget: 1 },
    });

    return Effect.gen(function* () {
      const run = yield* startRun();
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "failed");

      assert.include(
        harness.store.runs.get(run.runId)!.lastError ?? "",
        `provider error: ${spendLimit}`,
      );
      assert.strictEqual(harness.store.iterations[0]?.turnStatus, "failed");
      assert.strictEqual(harness.store.iterations[0]?.summary, `provider error: ${spendLimit}`);
      assert.strictEqual(
        harness.store.iterations[0]?.failureReason,
        "infra:provider-error:spend-limit",
      );
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("persists a provider fallback and relaunches on Codex", () => {
    const claudeSelection = {
      instanceId: ProviderInstanceId.make("claude-work"),
      model: "claude-sonnet-5",
    } as const;
    const codexSelection = {
      instanceId: ProviderInstanceId.make("codex-personal"),
      model: "gpt-5.6-sol",
      options: [{ id: "reasoningEffort", value: "high" }],
    } as const;
    const harness = createHarness({
      script: [
        {
          text: null,
          head: "head-0",
          turnState: "error",
          sessionStatus: "error",
          sessionLastError: "You've hit your org's monthly spend limit",
        },
        { text: "RALPH_DONE", head: "head-0" },
        { text: "RALPH_DONE", head: "head-0" },
      ],
      options: { infraFailureBudget: 1 },
      projectDefaultModelSelection: claudeSelection,
      providers: [
        provider("claude-work", "claudeAgent", "claude-sonnet-5"),
        provider("codex-personal", "codex", "gpt-5.6-sol"),
      ],
    });

    return Effect.gen(function* () {
      const runner = yield* EpicRunner;
      const run = yield* runner.startRun({
        epicId: "epic-1",
        projectId,
        cwd: "/tmp/epic-runner-repo",
        prompt: "do one unit of work",
        modelSelection: claudeSelection,
        maxIterations: 10,
      });
      yield* waitFor(
        () =>
          harness.store.runs.get(run.runId)?.status === "done" && harness.activeLockCount() === 0,
      );

      assert.deepStrictEqual(harness.store.runs.get(run.runId)?.modelSelection, codexSelection);
      assert.strictEqual(harness.turnsStarted(), 2);
      assert.deepStrictEqual(
        harness.commandsOfType("thread.turn.start").map((command) => command.modelSelection),
        [claudeSelection, codexSelection],
      );
      assert.strictEqual(
        harness.store.iterations[0]?.failureReason,
        "infra:provider-error:spend-limit",
      );

      const relaunched = yield* runner.launchRun({
        epicId: "epic-1",
        projectId,
        cwd: "/tmp/epic-runner-repo",
      });
      yield* waitFor(() => harness.store.runs.get(relaunched.runId)?.status === "done");
      assert.deepStrictEqual(
        harness.commandsOfType("thread.turn.start").map((command) => command.modelSelection),
        [claudeSelection, codexSelection, codexSelection],
      );
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("drains old-provider siblings before dispatching with fallback", () => {
    const claudeSelection = {
      instanceId: ProviderInstanceId.make("claude-work"),
      model: "claude-sonnet-5",
    } as const;
    const codexSelection = {
      instanceId: ProviderInstanceId.make("codex-personal"),
      model: "gpt-5.6-sol",
      options: [{ id: "reasoningEffort", value: "high" }],
    } as const;
    const gates = Array.from({ length: 4 }, () => Deferred.makeUnsafe<void>());
    const harness = createHarness({
      readyChildren: ["child-a", "child-b", "child-c", "child-d"],
      options: { quietPeriodMs: 1, infraFailureBudget: 5 },
      providers: [
        provider("claude-work", "claudeAgent", "claude-sonnet-5"),
        provider("codex-personal", "codex", "gpt-5.6-sol"),
      ],
      script: [
        ...gates.slice(0, 3).map((settleGate) => ({
          text: null,
          head: "head-0",
          turnState: "error" as const,
          sessionStatus: "error" as const,
          sessionLastError: "You've hit your org's monthly spend limit",
          settleGate,
        })),
        {
          text: 'RALPH_MSG: {"summary":"done","why":"needed"}',
          head: "head-4",
          settleGate: gates[3]!,
        },
      ],
    });

    return Effect.gen(function* () {
      const runner = yield* EpicRunner;
      const run = yield* runner.startRun({
        epicId: "epic-1",
        projectId,
        cwd: "/tmp/epic-runner-repo",
        prompt: "work",
        orientationFile: null,
        modelSelection: claudeSelection,
        config: { parallel: { workers: 3 }, limits: { maxIterations: 4 } },
      });
      yield* waitFor(() => harness.turnsStarted() === 3);
      yield* Deferred.succeed(gates[0]!, undefined);
      yield* waitFor(() => harness.store.runs.get(run.runId)?.iterationsCompleted === 1);
      yield* settle;
      assert.strictEqual(harness.turnsStarted(), 3);
      assert.deepStrictEqual(harness.store.runs.get(run.runId)?.modelSelection, claudeSelection);
      yield* Deferred.succeed(gates[1]!, undefined);
      yield* Deferred.succeed(gates[2]!, undefined);
      yield* waitFor(
        () =>
          harness.turnsStarted() === 4 &&
          harness.store.runs.get(run.runId)?.modelSelection.instanceId ===
            codexSelection.instanceId,
      );
      assert.deepStrictEqual(
        harness.commandsOfType("thread.turn.start").map((command) => command.modelSelection),
        [claudeSelection, claudeSelection, claudeSelection, codexSelection],
      );
      assert.deepStrictEqual(harness.store.runs.get(run.runId)?.modelSelection, codexSelection);
      yield* Deferred.succeed(gates[3]!, undefined);
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "done");
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("clears only the successful provider instance degradation", () => {
    const claudeSelection = {
      instanceId: ProviderInstanceId.make("claude-work"),
      model: "claude-sonnet-5",
    } as const;
    const codexInstanceId = ProviderInstanceId.make("codex-personal");
    const harness = createHarness({ script: [{ text: "RALPH_DONE", head: "head-0" }] });
    harness.store.degradations.set(claudeSelection.instanceId, {
      providerInstanceId: claudeSelection.instanceId,
      failureReason: "provider-error:spend-limit",
      degradedAt: NOW,
    });
    harness.store.degradations.set(codexInstanceId, {
      providerInstanceId: codexInstanceId,
      failureReason: "provider-error:auth",
      degradedAt: NOW,
    });

    return Effect.gen(function* () {
      const runner = yield* EpicRunner;
      const run = yield* runner.startRun({
        epicId: "epic-1",
        projectId,
        cwd: "/tmp/epic-runner-repo",
        prompt: "do one unit of work",
        modelSelection: claudeSelection,
        maxIterations: 10,
      });
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "done");
      assert.isFalse(harness.store.degradations.has(claudeSelection.instanceId));
      assert.isTrue(harness.store.degradations.has(codexInstanceId));
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("clears a successful provider degradation after a concurrent pause", () => {
    const claudeSelection = {
      instanceId: ProviderInstanceId.make("claude-work"),
      model: "claude-sonnet-5",
    } as const;
    const harness = createHarness({
      script: [{ text: "RALPH_DONE", head: "head-0" }],
      options: { quietPeriodMs: 150 },
    });
    harness.store.degradations.set(claudeSelection.instanceId, {
      providerInstanceId: claudeSelection.instanceId,
      failureReason: "provider-error:spend-limit",
      degradedAt: NOW,
    });

    return Effect.gen(function* () {
      const runner = yield* EpicRunner;
      const run = yield* runner.startRun({
        epicId: "epic-1",
        projectId,
        cwd: "/tmp/epic-runner-repo",
        prompt: "do one unit of work",
        modelSelection: claudeSelection,
        maxIterations: 10,
      });
      yield* waitFor(() => harness.store.iterations.length === 1);
      yield* runner.pauseRun({ runId: run.runId });
      yield* waitFor(
        () =>
          harness.store.iterations[0]?.turnStatus === "completed" &&
          harness.activeLockCount() === 0,
      );
      assert.strictEqual(harness.store.runs.get(run.runId)?.status, "paused");
      assert.isFalse(harness.store.degradations.has(claudeSelection.instanceId));
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("ignores and conditionally clears an expired degradation", () => {
    const claudeSelection = {
      instanceId: ProviderInstanceId.make("claude-work"),
      model: "claude-sonnet-5",
    } as const;
    const harness = createHarness({
      script: [{ text: "RALPH_DONE", head: "head-0" }],
      options: { providerDegradationTtlMs: 1_000 },
      projectDefaultModelSelection: claudeSelection,
      providers: [
        provider("claude-work", "claudeAgent", "claude-sonnet-5"),
        provider("codex-personal", "codex", "gpt-5.6-sol"),
      ],
    });
    harness.store.degradations.set(claudeSelection.instanceId, {
      providerInstanceId: claudeSelection.instanceId,
      failureReason: "provider-error:spend-limit",
      degradedAt: "2020-01-01T00:00:00.000Z",
    });

    return Effect.gen(function* () {
      const runner = yield* EpicRunner;
      const run = yield* runner.launchRun({
        epicId: "epic-1",
        projectId,
        cwd: "/tmp/epic-runner-repo",
      });
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "done");
      assert.deepStrictEqual(
        harness.commandsOfType("thread.turn.start")[0]?.modelSelection,
        claudeSelection,
      );
      assert.isFalse(harness.store.degradations.has(claudeSelection.instanceId));
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("walks chained Claude and Codex degradations to Kimi", () => {
    const claudeSelection = {
      instanceId: ProviderInstanceId.make("claude-work"),
      model: "claude-sonnet-5",
    } as const;
    const codexInstanceId = ProviderInstanceId.make("codex-personal");
    const kimiSelection = {
      instanceId: ProviderInstanceId.make("kimi-work"),
      model: "kimi-code/k3",
    } as const;
    const harness = createHarness({
      script: [{ text: "RALPH_DONE", head: "head-0" }],
      projectDefaultModelSelection: claudeSelection,
      providers: [
        provider("claude-work", "claudeAgent", "claude-sonnet-5"),
        provider("codex-personal", "codex", "gpt-5.6-sol"),
        provider("kimi-work", "kimi", "kimi-code/k3"),
      ],
    });

    return Effect.gen(function* () {
      const degradedAt = DateTime.formatIso(yield* DateTime.now);
      harness.store.degradations.set(claudeSelection.instanceId, {
        providerInstanceId: claudeSelection.instanceId,
        failureReason: "provider-error:spend-limit",
        degradedAt,
      });
      harness.store.degradations.set(codexInstanceId, {
        providerInstanceId: codexInstanceId,
        failureReason: "provider-error:rate-limit",
        degradedAt,
      });
      const runner = yield* EpicRunner;
      const run = yield* runner.launchRun({
        epicId: "epic-1",
        projectId,
        cwd: "/tmp/epic-runner-repo",
        config: { provider: { modelSelection: claudeSelection } },
      });
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "done");
      assert.deepStrictEqual(
        harness.commandsOfType("thread.turn.start")[0]?.modelSelection,
        kimiSelection,
      );
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("launches on the second Claude account in the iteration-worker chain", () => {
    const harness = createHarness({
      script: [{ text: "RALPH_DONE", head: "head-0" }],
      projectDefaultModelSelection: CLAUDE_WORK_SELECTION,
      providers: [
        provider("claude-work", "claudeAgent", "claude-sonnet-5"),
        provider("claude-personal", "claudeAgent", "claude-sonnet-5"),
        provider("codex-personal", "codex", "gpt-5.6-sol"),
      ],
      epicRolePolicy: iterationWorkerPolicy([
        CLAUDE_WORK_SELECTION,
        CLAUDE_PERSONAL_SELECTION,
        CHAIN_CODEX_SELECTION,
      ]),
    });

    return Effect.gen(function* () {
      const degradedAt = DateTime.formatIso(yield* DateTime.now);
      harness.store.degradations.set(CLAUDE_WORK_SELECTION.instanceId, {
        providerInstanceId: CLAUDE_WORK_SELECTION.instanceId,
        failureReason: "provider-error:spend-limit",
        degradedAt,
      });
      const runner = yield* EpicRunner;
      const run = yield* runner.launchRun({
        epicId: "epic-1",
        projectId,
        cwd: "/tmp/epic-runner-repo",
      });
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "done");
      assert.deepStrictEqual(
        harness.commandsOfType("thread.turn.start")[0]?.modelSelection,
        CLAUDE_PERSONAL_SELECTION,
      );
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("launches on the last chain hop when every hop is degraded", () => {
    const harness = createHarness({
      script: [{ text: "RALPH_DONE", head: "head-0" }],
      projectDefaultModelSelection: CLAUDE_WORK_SELECTION,
      providers: [
        provider("claude-work", "claudeAgent", "claude-sonnet-5"),
        provider("claude-personal", "claudeAgent", "claude-sonnet-5"),
        provider("codex-personal", "codex", "gpt-5.6-sol"),
      ],
      // The chain ends on a second Claude account, which the driver-order
      // walker could never reach: it proves the last hop came from the chain.
      epicRolePolicy: iterationWorkerPolicy([
        CLAUDE_WORK_SELECTION,
        CHAIN_CODEX_SELECTION,
        CLAUDE_PERSONAL_SELECTION,
      ]),
    });

    return Effect.gen(function* () {
      const degradedAt = DateTime.formatIso(yield* DateTime.now);
      for (const instanceId of [
        CLAUDE_WORK_SELECTION.instanceId,
        CLAUDE_PERSONAL_SELECTION.instanceId,
        CHAIN_CODEX_SELECTION.instanceId,
      ]) {
        harness.store.degradations.set(instanceId, {
          providerInstanceId: instanceId,
          failureReason: "provider-error:rate-limit",
          degradedAt,
        });
      }
      const runner = yield* EpicRunner;
      const run = yield* runner.launchRun({
        epicId: "epic-1",
        projectId,
        cwd: "/tmp/epic-runner-repo",
      });
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "done");
      assert.deepStrictEqual(
        harness.commandsOfType("thread.turn.start")[0]?.modelSelection,
        CLAUDE_PERSONAL_SELECTION,
      );
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("terminates the last-resort walk when a chain names one instance twice", () => {
    const harness = createHarness({
      script: [{ text: "RALPH_DONE", head: "head-0" }],
      projectDefaultModelSelection: CLAUDE_WORK_SELECTION,
      providers: [
        provider("claude-work", "claudeAgent", "claude-sonnet-5"),
        provider("claude-personal", "claudeAgent", "claude-sonnet-5"),
      ],
      epicRolePolicy: iterationWorkerPolicy([
        CLAUDE_WORK_SELECTION,
        CLAUDE_PERSONAL_SELECTION,
        CLAUDE_WORK_SELECTION,
      ]),
    });

    return Effect.gen(function* () {
      const degradedAt = DateTime.formatIso(yield* DateTime.now);
      for (const instanceId of [
        CLAUDE_WORK_SELECTION.instanceId,
        CLAUDE_PERSONAL_SELECTION.instanceId,
      ]) {
        harness.store.degradations.set(instanceId, {
          providerInstanceId: instanceId,
          failureReason: "provider-error:rate-limit",
          degradedAt,
        });
      }
      const runner = yield* EpicRunner;
      const run = yield* runner.launchRun({
        epicId: "epic-1",
        projectId,
        cwd: "/tmp/epic-runner-repo",
      });
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "done");
      assert.deepStrictEqual(
        harness.commandsOfType("thread.turn.start")[0]?.modelSelection,
        CLAUDE_PERSONAL_SELECTION,
      );
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("clears an expired degradation on the first chain hop and stays there", () => {
    const harness = createHarness({
      script: [{ text: "RALPH_DONE", head: "head-0" }],
      options: { providerDegradationTtlMs: 1_000 },
      projectDefaultModelSelection: CLAUDE_WORK_SELECTION,
      providers: [
        provider("claude-work", "claudeAgent", "claude-sonnet-5"),
        provider("claude-personal", "claudeAgent", "claude-sonnet-5"),
      ],
      epicRolePolicy: iterationWorkerPolicy([CLAUDE_WORK_SELECTION, CLAUDE_PERSONAL_SELECTION]),
    });
    harness.store.degradations.set(CLAUDE_WORK_SELECTION.instanceId, {
      providerInstanceId: CLAUDE_WORK_SELECTION.instanceId,
      failureReason: "provider-error:spend-limit",
      degradedAt: "2020-01-01T00:00:00.000Z",
    });

    return Effect.gen(function* () {
      const runner = yield* EpicRunner;
      const run = yield* runner.launchRun({
        epicId: "epic-1",
        projectId,
        cwd: "/tmp/epic-runner-repo",
      });
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "done");
      assert.deepStrictEqual(
        harness.commandsOfType("thread.turn.start")[0]?.modelSelection,
        CLAUDE_WORK_SELECTION,
      );
      assert.isFalse(harness.store.degradations.has(CLAUDE_WORK_SELECTION.instanceId));
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("keeps a caller-supplied startRun selection despite a chain and a degradation", () => {
    const harness = createHarness({
      script: [{ text: "RALPH_DONE", head: "head-0" }],
      providers: [
        provider("claude-work", "claudeAgent", "claude-sonnet-5"),
        provider("claude-personal", "claudeAgent", "claude-sonnet-5"),
      ],
      epicRolePolicy: iterationWorkerPolicy([CLAUDE_WORK_SELECTION, CLAUDE_PERSONAL_SELECTION]),
    });

    return Effect.gen(function* () {
      const degradedAt = DateTime.formatIso(yield* DateTime.now);
      harness.store.degradations.set(CLAUDE_WORK_SELECTION.instanceId, {
        providerInstanceId: CLAUDE_WORK_SELECTION.instanceId,
        failureReason: "provider-error:spend-limit",
        degradedAt,
      });
      const runner = yield* EpicRunner;
      const run = yield* runner.startRun({
        epicId: "epic-1",
        projectId,
        cwd: "/tmp/epic-runner-repo",
        prompt: "do one unit of work",
        modelSelection: CLAUDE_WORK_SELECTION,
        maxIterations: 10,
      });
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "done");
      assert.deepStrictEqual(
        harness.commandsOfType("thread.turn.start")[0]?.modelSelection,
        CLAUDE_WORK_SELECTION,
      );
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("carries the policy's in-session subagents into every iteration thread", () => {
    const harness = createHarness({
      script: [{ text: "RALPH_DONE", head: "head-0" }],
      projectDefaultModelSelection: CLAUDE_WORK_SELECTION,
      providers: [
        provider("claude-work", "claudeAgent", "claude-sonnet-5"),
        provider("claude-personal", "claudeAgent", "claude-sonnet-5"),
      ],
      epicRolePolicy: decodeEpicRolePolicy({
        // The planner's tier starts on the second account, so a resolved model
        // proves the tier chain was walked and not the run's own selection.
        tiers: { planning: { hops: [{ selection: CLAUDE_PERSONAL_SELECTION }] } },
        roles: {},
        inSessionRoles: {
          planner: {
            tier: "planning",
            description: "Plans one child.",
            prompt: "You plan.",
          },
        },
      }),
    });

    return Effect.gen(function* () {
      const runner = yield* EpicRunner;
      const run = yield* runner.launchRun({
        epicId: "epic-1",
        projectId,
        cwd: "/tmp/epic-runner-repo",
      });
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "done");

      const threadId = harness.commandsOfType("thread.create")[0]?.threadId;
      assert.isDefined(threadId);
      assert.deepStrictEqual(harness.subagentBindings, [
        {
          threadId,
          subagents: {
            planner: {
              description: "Plans one child.",
              prompt: "You plan.",
              model: CLAUDE_PERSONAL_SELECTION.model,
            },
          },
        },
      ]);
      // The bindings are per run, and the loop owns their release.
      assert.include(harness.releasedSubagentRuns, run.runId);
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("binds no subagents when the policy configures no in-session role", () => {
    const harness = createHarness({
      script: [{ text: "RALPH_DONE", head: "head-0" }],
      projectDefaultModelSelection: CLAUDE_WORK_SELECTION,
      providers: [provider("claude-work", "claudeAgent", "claude-sonnet-5")],
      epicRolePolicy: iterationWorkerPolicy([CLAUDE_WORK_SELECTION]),
    });

    return Effect.gen(function* () {
      const runner = yield* EpicRunner;
      const run = yield* runner.launchRun({
        epicId: "epic-1",
        projectId,
        cwd: "/tmp/epic-runner-repo",
      });
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "done");
      assert.deepStrictEqual(harness.subagentBindings, []);
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("persists a provider fallback at a paused iteration boundary", () => {
    const claudeSelection = {
      instanceId: ProviderInstanceId.make("claude-work"),
      model: "claude-sonnet-5",
    } as const;
    const codexSelection = {
      instanceId: ProviderInstanceId.make("codex-personal"),
      model: "gpt-5.6-sol",
      options: [{ id: "reasoningEffort", value: "high" }],
    } as const;
    const harness = createHarness({
      script: [
        {
          text: null,
          head: "head-0",
          turnState: "error",
          sessionStatus: "error",
          sessionLastError: "You've hit your org's monthly spend limit",
        },
        { text: "should never run", head: "head-1" },
      ],
      options: { infraFailureBudget: 1, quietPeriodMs: 150 },
      providers: [
        provider("claude-work", "claudeAgent", "claude-sonnet-5"),
        provider("codex-personal", "codex", "gpt-5.6-sol"),
      ],
    });

    return Effect.gen(function* () {
      const runner = yield* EpicRunner;
      const run = yield* runner.startRun({
        epicId: "epic-1",
        projectId,
        cwd: "/tmp/epic-runner-repo",
        prompt: "do one unit of work",
        modelSelection: claudeSelection,
        maxIterations: 10,
      });
      yield* waitFor(() => harness.store.iterations.length === 1);
      yield* runner.pauseRun({ runId: run.runId });
      yield* waitFor(() => harness.store.iterations[0]?.turnStatus === "failed");
      yield* settle;

      assert.strictEqual(harness.store.runs.get(run.runId)?.status, "paused");
      assert.deepStrictEqual(harness.store.runs.get(run.runId)?.modelSelection, codexSelection);
      assert.strictEqual(harness.turnsStarted(), 1);
    }).pipe(Effect.provide(harness.layer));
  });

  it.live(
    "fails an iteration whose final message is a provider error and releases its child",
    () => {
      // Failure mode B rendered the spend-limit error as an ordinary assistant
      // message on a cleanly-completed turn. Without the text scan this scored
      // "no-commit" and the true cause never left the provider logs.
      const harness = createHarness({
        script: [
          {
            text: "You've hit your org's monthly spend limit — upgrade to continue.",
            head: "head-0",
          },
          { text: "RALPH_DONE", head: "head-0" },
        ],
        readyOutput: '[{"id":"child-1","parent":"epic-1"}]',
        childStatuses: { "child-1": "in_progress" },
      });

      return Effect.gen(function* () {
        const run = yield* startRun();
        yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "done");
        yield* settle;

        assert.strictEqual(harness.store.iterations[0]?.turnStatus, "failed");
        assert.strictEqual(
          harness.store.iterations[0]?.failureReason,
          "infra:provider-error:spend-limit",
        );
        assert.strictEqual(
          harness.store.iterations[0]?.summary,
          "provider error: You've hit your org's monthly spend limit — upgrade to continue.",
        );

        // The provider error charged the infra budget — neither the gutter
        // nor consecutiveFailures — and the failed iteration's claimed child
        // was reopened before the next iteration selected work, which
        // re-picked it and finished the run.
        assert.strictEqual(harness.store.runs.get(run.runId)?.consecutiveFailures, 0);
        const updates = harness.processRequests.filter(
          (request) => request.command === "bd" && request.args[0] === "update",
        );
        assert.strictEqual(updates.length, 1);
        assert.deepStrictEqual(updates[0]!.args, [
          "update",
          "child-1",
          "--status",
          "open",
          "--assignee",
          "",
        ]);
        const readyIndexes = harness.processRequests.flatMap((request, index) =>
          request.command === "bd" && request.args[0] === "ready" ? [index] : [],
        );
        assert.strictEqual(readyIndexes.length, 2);
        assert.isBelow(harness.processRequests.indexOf(updates[0]!), readyIndexes[1]!);
        assert.strictEqual(harness.store.iterations[1]?.turnStatus, "completed");
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.live("scores an iteration whose turn could not be dispatched with its own reason", () => {
    const harness = createHarness({
      script: [{ text: "never reached", head: "head-0" }],
      refuseCommandTypes: ["thread.turn.start"],
      options: { infraFailureBudget: 1 },
    });

    return Effect.gen(function* () {
      const run = yield* startRun();
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "failed");

      assert.strictEqual(harness.store.iterations[0]?.turnStatus, "failed");
      assert.strictEqual(harness.store.iterations[0]?.failureReason, "infra:dispatch-failed");
      assert.strictEqual(harness.commandsOfType("thread.settle").length, 0);
      assert.strictEqual(harness.commandsOfType("thread.session.stop").length, 1);
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("releases the stranded child left in_progress when a run exhausts its retries", () => {
    const failing = {
      text: null,
      head: "head-0",
      turnState: "error",
      sessionStatus: "error",
    } as const;
    const harness = createHarness({
      script: [failing, failing, failing],
      options: { infraFailureBudget: 3 },
      childStatuses: { "child-3": "in_progress" },
    });

    return Effect.gen(function* () {
      const run = yield* startRun();
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "failed");
      yield* waitFor(() =>
        harness.processRequests.some(
          (request) =>
            request.command === "bd" &&
            request.args[0] === "update" &&
            request.args[1] === "child-3",
        ),
      );

      const updateRequest = harness.processRequests.find(
        (request) => request.command === "bd" && request.args[0] === "update",
      )!;
      assert.deepStrictEqual(updateRequest.args, [
        "update",
        "child-3",
        "--status",
        "open",
        "--assignee",
        "",
      ]);
      assert.strictEqual(harness.childStatus("child-3"), "open");
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("releases stranded children from earlier iterations, not just the latest", () => {
    const failing = {
      text: null,
      head: "head-0",
      turnState: "error",
      sessionStatus: "error",
    } as const;
    const harness = createHarness({
      script: [failing, failing, failing],
      options: { infraFailureBudget: 3 },
      // `child-1` belongs to the FIRST iteration and `child-3` to the last.
      // Before t3code-1bk only the latest iteration was swept, so `child-1`
      // stayed claimed forever and `bd ready` could never resurface it.
      childStatuses: { "child-1": "in_progress", "child-3": "in_progress" },
    });

    return Effect.gen(function* () {
      const run = yield* startRun();
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "failed");
      yield* waitFor(
        () =>
          harness.childStatus("child-1") === "open" && harness.childStatus("child-3") === "open",
      );

      assert.strictEqual(harness.childStatus("child-1"), "open");
      assert.strictEqual(harness.childStatus("child-3"), "open");
      const released = harness.processRequests
        .filter((request) => request.command === "bd" && request.args[0] === "update")
        .map((request) => request.args[1]);
      assert.deepStrictEqual(released, ["child-1", "child-3"]);
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("does not touch a child that was already closed when the run failed", () => {
    const failing = {
      text: null,
      head: "head-0",
      turnState: "error",
      sessionStatus: "error",
    } as const;
    const harness = createHarness({
      script: [failing, failing, failing],
      options: { infraFailureBudget: 3 },
      childStatuses: { "child-3": "closed" },
    });

    return Effect.gen(function* () {
      const run = yield* startRun();
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "failed");
      // Nothing to wait *for* — the assertion is that the release is a no-op —
      // so give the finalizer a beat to run and confirm it stayed quiet.
      yield* settle;

      assert.isFalse(
        harness.processRequests.some(
          (request) => request.command === "bd" && request.args[0] === "update",
        ),
      );
      assert.strictEqual(harness.childStatus("child-3"), "closed");
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("reopens a claimed child mid-run so the retry re-selects the same child", () => {
    const harness = createHarness({
      script: [
        { text: null, head: "head-0", turnState: "error", sessionStatus: "error" },
        { text: "RALPH_DONE", head: "head-0" },
      ],
      // A fixed frontier: every selection returns `child-1`, which is what a
      // real retry sees once the claim is released — `bd ready` hides an
      // `in_progress` child, so re-selection only works if the failed
      // iteration reopened it before the next one asked.
      readyOutput: '[{"id":"child-1","parent":"epic-1"}]',
      childStatuses: { "child-1": "in_progress" },
    });

    return Effect.gen(function* () {
      const run = yield* startRun();
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "done");
      yield* settle;

      // The failed iteration reopened the claim itself; the terminal sweep
      // then found it already open and stayed quiet, so exactly one update.
      const updates = harness.processRequests.filter(
        (request) => request.command === "bd" && request.args[0] === "update",
      );
      assert.strictEqual(updates.length, 1);
      assert.deepStrictEqual(updates[0]!.args, [
        "update",
        "child-1",
        "--status",
        "open",
        "--assignee",
        "",
      ]);
      assert.strictEqual(harness.childStatus("child-1"), "open");

      // The release landed before the next iteration selected its child, and
      // that iteration picked the same child again.
      const readyIndexes = harness.processRequests.flatMap((request, index) =>
        request.command === "bd" && request.args[0] === "ready" ? [index] : [],
      );
      assert.strictEqual(readyIndexes.length, 2);
      assert.isBelow(harness.processRequests.indexOf(updates[0]!), readyIndexes[1]!);
      assert.deepStrictEqual(
        harness.store.iterations.map((iteration) => iteration.issueId),
        ["child-1", "child-1"],
      );
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("leaves a child its agent already closed alone when the iteration fails mid-run", () => {
    const harness = createHarness({
      script: [
        { text: null, head: "head-0", turnState: "error", sessionStatus: "error" },
        { text: "RALPH_DONE", head: "head-0" },
      ],
      readyOutput: '[{"id":"child-1","parent":"epic-1"}]',
      childStatuses: { "child-1": "closed" },
    });

    return Effect.gen(function* () {
      const run = yield* startRun();
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "done");
      yield* settle;

      assert.isFalse(
        harness.processRequests.some(
          (request) => request.command === "bd" && request.args[0] === "update",
        ),
      );
      assert.strictEqual(harness.childStatus("child-1"), "closed");
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("stops a run that keeps producing no commits", () => {
    const harness = createHarness({
      script: [
        { text: "thinking about it", head: "head-0" },
        { text: "still thinking", head: "head-0" },
        { text: "should never run", head: "head-9" },
      ],
    });

    return Effect.gen(function* () {
      const run = yield* startRun();
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "failed");

      assert.strictEqual(
        harness.store.runs.get(run.runId)!.lastError,
        "gutter: 2 iterations without a commit",
      );
      assert.strictEqual(harness.turnsStarted(), 2);
      // The rows themselves are failed too: the children's statuses could not
      // be read here (unknown counts as open), so nothing vouched for either
      // iteration. Before this scoring the incident's dead sessions read as
      // rows of "completed" under a failed run.
      assert.deepStrictEqual(
        harness.store.iterations.map((iteration) => [
          iteration.turnStatus,
          iteration.failureReason,
        ]),
        [
          ["failed", "child:no-commit-child-open"],
          ["failed", "child:no-commit-child-open"],
        ],
      );
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("fails a no-commit iteration whose child is still open, without burning the run", () => {
    const harness = createHarness({
      script: [
        { text: "spun without landing anything", head: "head-0" },
        { text: "RALPH_DONE", head: "head-0" },
      ],
      readyOutput: '[{"id":"child-1","parent":"epic-1"}]',
      childStatuses: { "child-1": "in_progress" },
    });

    return Effect.gen(function* () {
      const run = yield* startRun();
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "done");

      assert.strictEqual(harness.store.iterations[0]?.turnStatus, "failed");
      assert.strictEqual(harness.store.iterations[0]?.failureReason, "child:no-commit-child-open");
      // The human summary stays what classification said.
      assert.strictEqual(harness.store.iterations[0]?.summary, "iteration produced no commit");
      // Run-level policy is untouched: one no-commit charges the gutter
      // streak, not consecutiveFailures, and the run carried on to RALPH_DONE.
      assert.strictEqual(harness.store.runs.get(run.runId)?.consecutiveFailures, 0);
      assert.strictEqual(harness.store.iterations[1]?.turnStatus, "completed");
      assert.strictEqual(harness.store.iterations[1]?.failureReason, null);
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("keeps the no-commit gutter across server start", () => {
    const runId = EpicRunId.make("run-persisted-gutter");
    const staleRun: EpicRun = {
      runId,
      epicId: "epic-1",
      projectId,
      cwd: "/tmp/epic-runner-repo",
      prompt: "do one unit of work",
      orientationFile: null,
      modelSelection,
      runtimeMode: "full-access",
      ...defaultConfigSnapshot,
      originThreadId: null,
      status: "running",
      maxIterations: 10,
      workers: 1,
      iterationsDispatched: 1,
      iterationsCompleted: 1,
      currentThreadId: null,
      currentTurnStartedAt: null,
      consecutiveFailures: 0,
      noCommitStreak: 1,
      infraStreak: 0,
      lastError: null,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const harness = createHarness({
      script: [{ text: "still working", head: "head-0" }],
      seedRuns: [staleRun],
    });

    return Effect.gen(function* () {
      const runner = yield* EpicRunner;
      yield* runner.start();
      yield* waitFor(() => harness.store.runs.get(runId)?.status === "failed");
      const failed = harness.store.runs.get(runId)!;
      assert.strictEqual(failed.noCommitStreak, 2);
      assert.strictEqual(failed.lastError, "gutter: 2 iterations without a commit");
      assert.strictEqual(harness.turnsStarted(), 1);
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("keeps the infrastructure budget across server start", () => {
    const runId = EpicRunId.make("run-persisted-infra");
    const staleRun: EpicRun = {
      runId,
      epicId: "epic-1",
      projectId,
      cwd: "/tmp/epic-runner-repo",
      prompt: "do one unit of work",
      orientationFile: null,
      modelSelection,
      runtimeMode: "full-access",
      ...defaultConfigSnapshot,
      originThreadId: null,
      status: "running",
      maxIterations: 10,
      workers: 1,
      iterationsDispatched: 4,
      iterationsCompleted: 4,
      currentThreadId: null,
      currentTurnStartedAt: null,
      consecutiveFailures: 0,
      noCommitStreak: 0,
      infraStreak: 4,
      lastError: "previous provider error",
      createdAt: NOW,
      updatedAt: NOW,
    };
    const harness = createHarness({
      script: [{ text: null, head: "head-0", turnState: "error", sessionStatus: "error" }],
      seedRuns: [staleRun],
      options: { infraFailureBudget: 5 },
    });

    return Effect.gen(function* () {
      const runner = yield* EpicRunner;
      yield* runner.start();
      yield* waitFor(() => harness.store.runs.get(runId)?.status === "failed");
      const failed = harness.store.runs.get(runId)!;
      assert.strictEqual(failed.infraStreak, 5);
      assert.include(failed.lastError ?? "", "5 consecutive infrastructure failures");
      assert.strictEqual(harness.turnsStarted(), 1);
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("keeps consecutive closed-child no-commit iterations out of the gutter", () => {
    // Research children legitimately produce no commits, but each one must
    // add findings to its bead before its close can vouch for the iteration.
    const harness = createHarness({
      script: [
        {
          text: 'researched one\nRALPH_MSG: {"summary":"wrote first findings","why":"knowledge child"}',
          head: "head-0",
        },
        {
          text: 'researched two\nRALPH_MSG: {"summary":"wrote second findings","why":"knowledge child"}',
          head: "head-0",
        },
        { text: "RALPH_DONE", head: "head-0" },
      ],
      childEvidence: {
        "child-1": [
          { status: "open", title: "Research: first", commentCount: 2 },
          { status: "closed", title: "Research: first", commentCount: 3 },
        ],
        "child-2": [
          { status: "open", title: "Research: second", commentCount: 5 },
          { status: "closed", title: "Research: second", commentCount: 6 },
        ],
      },
    });

    return Effect.gen(function* () {
      const run = yield* startRun();
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "done");
      yield* settle;

      assert.strictEqual(harness.store.runs.get(run.runId)?.status, "done");
      assert.isFalse(harness.store.runs.get(run.runId)?.lastError?.startsWith("gutter:") ?? false);
      assert.deepStrictEqual(
        harness.store.iterations.map((iteration) => [
          iteration.turnStatus,
          iteration.failureReason,
        ]),
        [
          ["completed", null],
          ["completed", null],
          ["completed", null],
        ],
      );
      assert.deepStrictEqual(
        harness.store.iterations.slice(0, 2).map((iteration) => iteration.summary),
        ["wrote first findings", "wrote second findings"],
      );
      // Both closed children are left alone, mid-run and at the terminal sweep.
      assert.isFalse(
        harness.processRequests.some(
          (request) => request.command === "bd" && request.args[0] === "update",
        ),
      );
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("resets the gutter streak after a research child adds findings", () => {
    const harness = createHarness({
      script: [
        { text: "first open child", head: "head-0" },
        { text: "closed research child", head: "head-0" },
        { text: "second open child", head: "head-0" },
        { text: "RALPH_DONE", head: "head-0" },
      ],
      childEvidence: {
        "child-1": [
          { status: "open", title: "Implement first", commentCount: 0 },
          { status: "open", title: "Implement first", commentCount: 0 },
        ],
        "child-2": [
          { status: "open", title: "Research: answer question", commentCount: 4 },
          { status: "closed", title: "Research: answer question", commentCount: 5 },
        ],
        "child-3": [
          { status: "open", title: "Implement second", commentCount: 0 },
          { status: "open", title: "Implement second", commentCount: 0 },
        ],
      },
    });

    return Effect.gen(function* () {
      const run = yield* startRun();
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "done");

      assert.strictEqual(harness.store.runs.get(run.runId)?.lastError, null);
      assert.strictEqual(harness.turnsStarted(), 4);
      assert.deepStrictEqual(
        harness.store.iterations.map((iteration) => iteration.turnStatus),
        ["failed", "completed", "failed", "completed"],
      );
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("accepts a research-labelled child that adds findings without a commit", () => {
    const harness = createHarness({
      script: [
        { text: "labelled research findings", head: "head-0" },
        { text: "RALPH_DONE", head: "head-0" },
      ],
      childEvidence: {
        "child-1": [
          { status: "open", title: "Investigate provider behavior", commentCount: 1 },
          { status: "closed", title: "Investigate provider behavior", commentCount: 2 },
        ],
      },
      childLabels: { "child-1": "- research\n" },
    });

    return Effect.gen(function* () {
      const run = yield* startRun();
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "done");

      assert.strictEqual(harness.store.iterations[0]?.turnStatus, "completed");
      assert.strictEqual(harness.store.iterations[0]?.failureReason, null);
      assert.isTrue(
        harness.processRequests.some(
          (request) =>
            request.command === "bd" &&
            request.args[0] === "label" &&
            request.args[1] === "list" &&
            request.args[2] === "child-1",
        ),
      );
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("rejects a closed research child without new findings", () => {
    const harness = createHarness({
      script: [{ text: "closed without findings", head: "head-0" }],
      childEvidence: {
        "child-1": [
          { status: "open", title: "Research: unanswered", commentCount: 7 },
          { status: "closed", title: "Research: unanswered", commentCount: 7 },
        ],
      },
      options: { maxNoCommitStreak: 1 },
    });

    return Effect.gen(function* () {
      const run = yield* startRun();
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "failed");

      assert.strictEqual(harness.store.iterations[0]?.turnStatus, "failed");
      assert.strictEqual(
        harness.store.iterations[0]?.failureReason,
        "child:closed-without-findings",
      );
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("accepts a non-research child with no commit when its bead gains evidence", () => {
    const harness = createHarness({
      script: [
        { text: "verified existing implementation", head: "head-0" },
        { text: "RALPH_DONE", head: "head-0" },
      ],
      childEvidence: {
        "child-1": [
          { status: "open", title: "Verify existing behavior", commentCount: 0 },
          { status: "closed", title: "Verify existing behavior", commentCount: 1 },
        ],
      },
    });

    return Effect.gen(function* () {
      const run = yield* startRun();
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "done");

      assert.strictEqual(harness.store.iterations[0]?.turnStatus, "completed");
      assert.strictEqual(harness.store.iterations[0]?.failureReason, null);
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("trips the gutter when closed non-research children add no evidence", () => {
    const harness = createHarness({
      script: [
        { text: "closed without proof", head: "head-0" },
        { text: "closed without proof again", head: "head-0" },
      ],
      childEvidence: {
        "child-1": [
          { status: "open", title: "Implement first", commentCount: 0 },
          { status: "closed", title: "Implement first", commentCount: 0 },
        ],
        "child-2": [
          { status: "open", title: "Implement second", commentCount: 3 },
          { status: "closed", title: "Implement second", commentCount: 3 },
        ],
      },
    });

    return Effect.gen(function* () {
      const run = yield* startRun();
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "failed");

      assert.strictEqual(harness.turnsStarted(), 2);
      assert.strictEqual(
        harness.store.runs.get(run.runId)?.lastError,
        "gutter: 2 iterations without a commit",
      );
      assert.deepStrictEqual(
        harness.store.iterations.map((iteration) => iteration.failureReason),
        ["child:no-commit-no-evidence", "child:no-commit-no-evidence"],
      );
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("rejects a no-commit iteration when settlement evidence cannot be read", () => {
    const harness = createHarness({
      script: [{ text: "closed but unreadable", head: "head-0" }],
      childEvidence: {
        "child-1": [
          { status: "open", title: "Verify unreadable close", commentCount: 0 },
          { exitCode: 1 },
        ],
      },
      options: { maxNoCommitStreak: 1 },
    });

    return Effect.gen(function* () {
      const run = yield* startRun();
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "failed");

      assert.strictEqual(harness.store.iterations[0]?.turnStatus, "failed");
      assert.strictEqual(harness.store.iterations[0]?.failureReason, "child:no-commit-child-open");
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("interrupts the turn in flight when a run is cancelled", () => {
    let statusAtLeaseRelease: EpicRun["status"] | undefined;
    let harness!: ReturnType<typeof createHarness>;
    harness = createHarness({
      script: [{ text: null, head: "head-0", stall: true }],
      options: { iterationTimeoutMs: 60_000 },
      onLockRelease: () => {
        statusAtLeaseRelease = [...harness.store.runs.values()][0]?.status;
      },
    });

    return Effect.gen(function* () {
      const runner = yield* EpicRunner;
      const run = yield* startRun();
      yield* waitFor(() => harness.turnsStarted() === 1);
      const shellReadsBeforeOwnership = harness.shellReads();
      yield* waitFor(() => harness.shellReads() > shellReadsBeforeOwnership);

      const current = harness.store.runs.get(run.runId)!;
      harness.store.runs.set(run.runId, {
        ...current,
        iterationsDispatched: 6,
        iterationsCompleted: 2,
        noCommitStreak: 3,
        infraStreak: 4,
      });
      const cancelled = yield* runner.cancelRun({ runId: run.runId });
      assert.strictEqual(cancelled.status, "cancelled");
      assert.strictEqual(cancelled.currentThreadId, null);
      assert.strictEqual(statusAtLeaseRelease, "cancelled");
      assert.strictEqual(cancelled.iterationsDispatched, 6);
      assert.strictEqual(cancelled.iterationsCompleted, 2);
      assert.strictEqual(cancelled.noCommitStreak, 3);
      assert.strictEqual(cancelled.infraStreak, 4);

      const interrupts = harness.commandsOfType("thread.turn.interrupt");
      assert.strictEqual(interrupts.length, 1);
      assert.strictEqual(interrupts[0]?.threadId, harness.store.iterations[0]?.threadId);
      assert.strictEqual(
        interrupts[0]?.turnId,
        TurnId.make(`${harness.store.iterations[0]?.threadId}-turn-1`),
      );
      // A cancelled thread is abandoned mid-turn, not finished, so it keeps the
      // interrupt + session.stop pair. Settling it would claim the iteration
      // ran to completion.
      const stops = harness.commandsOfType("thread.session.stop");
      assert.strictEqual(stops.length, 1);
      assert.strictEqual(stops[0]?.threadId, harness.store.iterations[0]?.threadId);
      assert.strictEqual(stops[0]?.preserveRunningSubagents, undefined);
      assert.isAbove(harness.commands.indexOf(stops[0]!), harness.commands.indexOf(interrupts[0]!));
      assert.strictEqual(harness.commandsOfType("thread.settle").length, 0);
      // The abandoned iteration is closed out rather than left `running` forever.
      assert.strictEqual(harness.store.iterations[0]?.turnStatus, "abandoned");
      assert.strictEqual(harness.store.iterations[0]?.failureReason, "cancelled");

      // The loop is gone: nothing else starts after the cancel.
      yield* settle;
      assert.strictEqual(harness.turnsStarted(), 1);
      assert.strictEqual(harness.store.runs.get(run.runId)!.status, "cancelled");
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("targets the owned turn when a newer human turn is active at cancellation", () => {
    const harness = createHarness({
      script: [{ text: null, head: "head-0", stall: true }],
      options: { iterationTimeoutMs: 60_000 },
    });

    return Effect.gen(function* () {
      const runner = yield* EpicRunner;
      const run = yield* startRun();
      yield* waitFor(() => harness.turnsStarted() === 1);
      const shellReadsBeforeOwnership = harness.shellReads();
      yield* waitFor(() => harness.shellReads() > shellReadsBeforeOwnership);
      const iterationThreadId = harness.store.iterations[0]!.threadId;
      harness.setActiveTurn(iterationThreadId, TurnId.make(`${iterationThreadId}-human-turn`));

      yield* runner.cancelRun({ runId: run.runId });

      const interrupts = harness.commandsOfType("thread.turn.interrupt");
      assert.strictEqual(interrupts.length, 1);
      assert.strictEqual(interrupts[0]?.turnId, TurnId.make(`${iterationThreadId}-turn-1`));
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("cancels and abandons every active worker", () => {
    let allRowsAbandonedAtRelease = false;
    let harness!: ReturnType<typeof createHarness>;
    harness = createHarness({
      readyChildren: ["child-a", "child-b", "child-c"],
      script: [0, 1, 2].map(() => ({ text: null, head: "head-0", stall: true })),
      options: { iterationTimeoutMs: 60_000 },
      childStatuses: {
        "child-a": "in_progress",
        "child-b": "in_progress",
        "child-c": "in_progress",
      },
      onLockRelease: () => {
        allRowsAbandonedAtRelease =
          harness.store.iterations.every((row) => row.turnStatus === "abandoned") &&
          ["child-a", "child-b", "child-c"].every(
            (issueId) => harness.childStatus(issueId) === "open",
          );
      },
    });
    return Effect.gen(function* () {
      const runner = yield* EpicRunner;
      const run = yield* startRunWithWorkers(3, 10);
      yield* waitFor(
        () => harness.store.iterations.filter((row) => row.turnStatus === "running").length === 3,
      );
      const turnsAtCancel = harness.turnsStarted();
      yield* runner.cancelRun({ runId: run.runId });

      assert.strictEqual(harness.commandsOfType("thread.turn.interrupt").length, 3);
      assert.strictEqual(harness.commandsOfType("thread.session.stop").length, 3);
      assert.isTrue(allRowsAbandonedAtRelease);
      assert.deepStrictEqual(
        harness.store.iterations.map((row) => [row.turnStatus, row.failureReason]),
        [
          ["abandoned", "cancelled"],
          ["abandoned", "cancelled"],
          ["abandoned", "cancelled"],
        ],
      );
      assert.deepStrictEqual(
        ["child-a", "child-b", "child-c"].map((issueId) => harness.childStatus(issueId)),
        ["open", "open", "open"],
      );
      yield* settle;
      assert.strictEqual(harness.turnsStarted(), turnsAtCancel);
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("interrupts and fails an iteration that outlives its timeout", () => {
    const harness = createHarness({
      script: [{ text: null, head: "head-0", stall: true }],
      options: { iterationTimeoutMs: 40, infraFailureBudget: 1 },
    });

    return Effect.gen(function* () {
      const run = yield* startRun();
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "failed");

      assert.include(
        harness.store.runs.get(run.runId)!.lastError ?? "",
        "iteration exceeded its timeout",
      );
      const interrupts = harness.commandsOfType("thread.turn.interrupt");
      const stops = harness.commandsOfType("thread.session.stop");
      assert.strictEqual(interrupts.length, 1);
      assert.strictEqual(stops.length, 1);
      assert.isAbove(harness.commands.indexOf(stops[0]!), harness.commands.indexOf(interrupts[0]!));
      assert.strictEqual(stops[0]?.preserveRunningSubagents, undefined);
      assert.strictEqual(harness.commandsOfType("thread.settle").length, 0);
      assert.strictEqual(harness.store.iterations[0]?.turnStatus, "failed");
      assert.strictEqual(harness.store.iterations[0]?.failureReason, "infra:timeout");
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("disables the layer timeout when persisted worker timeout is explicitly null", () => {
    const harness = createHarness({
      script: [{ text: null, head: "head-0", stall: true }],
      options: { iterationTimeoutMs: 40, infraFailureBudget: 1 },
    });

    return Effect.gen(function* () {
      const runner = yield* EpicRunner;
      const run = yield* runner.startRun({
        epicId: "epic-no-timeout",
        projectId,
        cwd: "/tmp/epic-runner-repo",
        prompt: "do one unit of work",
        orientationFile: null,
        modelSelection,
        config: { supervision: { workerTimeoutSeconds: null } },
      });
      yield* waitFor(() => harness.turnsStarted() === 1);
      yield* Effect.sleep("80 millis");

      assert.strictEqual(harness.store.runs.get(run.runId)?.status, "running");
      assert.strictEqual(harness.store.iterations[0]?.turnStatus, "running");

      yield* runner.cancelRun({ runId: run.runId });
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "cancelled");
      assert.strictEqual(harness.store.iterations[0]?.failureReason, "cancelled");
    }).pipe(Effect.provide(harness.layer));
  });

  // The restart recipe itself, proven before anything is built on it: one
  // process starts a run and dies mid-iteration, a second process provides the
  // same harness layer and picks that run up from what the first one persisted.
  // Every other restart test seeds the "after" state by hand; this one earns it.
  it.live("carries a run across two runner lifecycles", () => {
    const harness = createHarness({
      // Phase one's iteration has to stall — a settling turn keeps mutating
      // harness state after phase one's scope closes. See `runLifecycle`.
      script: [
        { text: null, head: "head-0", stall: true },
        { text: "RALPH_DONE", head: "head-1" },
      ],
      // The provider subprocess died with the first process, so its claimed
      // child is still `in_progress` when the second process boots.
      childStatuses: { "child-1": "in_progress" },
    });

    return Effect.gen(function* () {
      const run = yield* harness.runLifecycle(
        Effect.gen(function* () {
          const started = yield* startRun(2);
          yield* waitFor(
            () => harness.turnsStarted() === 1 && harness.store.iterations.length === 1,
          );
          return started;
        }),
      );

      // What process death leaves behind: no lease, no loop, a run still
      // recorded as running, and an iteration row still recorded as running.
      assert.strictEqual(harness.activeLockCount(), 0);
      assert.strictEqual(harness.store.runs.get(run.runId)?.status, "running");
      assert.strictEqual(harness.store.iterations[0]?.turnStatus, "running");
      assert.strictEqual(harness.store.iterations[0]?.issueId, "child-1");

      yield* harness.runLifecycle(
        Effect.gen(function* () {
          const runner = yield* EpicRunner;
          yield* runner.start();
          yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "done");
        }),
      );

      // The second process reconciled the first process's row and dispatched
      // its own iteration, consuming `script[1]`.
      assert.strictEqual(harness.store.iterations[0]?.turnStatus, "abandoned");
      assert.strictEqual(harness.store.iterations[0]?.failureReason, "server-restart");
      assert.strictEqual(harness.childStatus("child-1"), "open");
      assert.strictEqual(harness.store.iterations[1]?.iterationIndex, 1);
      assert.strictEqual(harness.turnsStarted(), 2);
    });
  });

  // A blocked boot preflight used to fail the run and leave its rows dangling
  // at `running` with nothing running behind them. It now parks the run where
  // an operator can resume it and reconciles every in-flight row itself.
  it.live("parks a running run as paused at boot when preflight reports dirty_tree", () => {
    const runId = "run-boot-dirty-tree";
    const staleRun: EpicRun = {
      runId: EpicRunId.make(runId),
      epicId: "epic-1",
      projectId,
      cwd: "/tmp/epic-runner-repo",
      prompt: "do one unit of work",
      orientationFile: null,
      modelSelection,
      runtimeMode: "full-access",
      ...defaultConfigSnapshot,
      originThreadId: null,
      status: "running",
      maxIterations: 2,
      workers: 1,
      iterationsDispatched: 1,
      iterationsCompleted: 0,
      currentThreadId: ThreadId.make(`epic-run-${runId}-0`),
      currentTurnStartedAt: NOW,
      consecutiveFailures: 0,
      noCommitStreak: 0,
      infraStreak: 0,
      lastError: null,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const harness = createHarness({
      script: [],
      seedRuns: [staleRun],
      seedIterations: [
        {
          runId: staleRun.runId,
          iterationIndex: 0,
          threadId: ThreadId.make(`epic-run-${runId}-0`),
          issueId: "child-0",
          worktreePath: `/tmp/worktrees/${runId}-0`,
          turnStatus: "running",
          summary: null,
          why: null,
          failureReason: null,
          startedAt: NOW,
          finishedAt: null,
        },
        {
          runId: staleRun.runId,
          iterationIndex: 1,
          threadId: ThreadId.make(`epic-run-${runId}-1`),
          issueId: "child-1",
          worktreePath: `/tmp/worktrees/${runId}-1`,
          turnStatus: "running",
          summary: null,
          why: null,
          failureReason: null,
          startedAt: NOW,
          finishedAt: null,
        },
      ],
      preflightResult: stubPreflightResult({
        ok: false,
        blockers: [{ _tag: "dirty_tree", paths: ["src/a.ts"] }],
      }),
      childStatuses: { "child-0": "in_progress", "child-1": "in_progress" },
    });

    return Effect.gen(function* () {
      const runner = yield* EpicRunner;
      yield* runner.start();
      yield* waitFor(() => harness.store.runs.get(runId)?.status === "paused");

      const parked = harness.store.runs.get(runId)!;
      // The persisted error is the formatted blocker, not its tag: a run that
      // parks here has to tell a human which paths to clean.
      assert.strictEqual(
        parked.lastError,
        `Epic epic-1 cannot start: ${formatEpicRunPreflightBlocker({
          _tag: "dirty_tree",
          paths: ["src/a.ts"],
        })}`,
      );
      assert.include(parked.lastError ?? "", "src/a.ts");
      // Nothing drives this run's thread any more, so nothing may point at it.
      assert.strictEqual(parked.currentThreadId, null);
      assert.strictEqual(parked.currentTurnStartedAt, null);
      // Both stranded children come back, because the parked run's loop never
      // forks and so its finalizer never releases the claims.
      for (const issueId of ["child-0", "child-1"]) {
        yield* waitFor(() => harness.childStatus(issueId) === "open");
        const releaseRequest = harness.processRequests.find(
          (request) =>
            request.command === "bd" && request.args[0] === "update" && request.args[1] === issueId,
        )!;
        assert.deepStrictEqual(releaseRequest.args, [
          "update",
          issueId,
          "--status",
          "open",
          "--assignee",
          "",
        ]);
      }
      // Every in-flight row is reconciled here, without a lease and without
      // driving a single thread.
      for (const index of [0, 1]) {
        assert.strictEqual(harness.store.iterations[index]?.turnStatus, "abandoned");
        assert.strictEqual(harness.store.iterations[index]?.summary, "abandoned by server restart");
        assert.strictEqual(harness.store.iterations[index]?.failureReason, "server-restart");
        assert.strictEqual(harness.store.iterations[index]?.why, null);
        assert.isNotNull(harness.store.iterations[index]?.finishedAt);
      }
      assert.strictEqual(harness.commandsOfType("thread.turn.interrupt").length, 0);
      assert.strictEqual(harness.commandsOfType("thread.session.stop").length, 0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("hands the boot preflight this run's own runId and in-flight worktrees", () => {
    const runId = "run-boot-resume-intent";
    const staleRun: EpicRun = {
      runId: EpicRunId.make(runId),
      epicId: "epic-1",
      projectId,
      cwd: "/tmp/epic-runner-repo",
      prompt: "do one unit of work",
      orientationFile: null,
      modelSelection,
      runtimeMode: "full-access",
      ...defaultConfigSnapshot,
      originThreadId: null,
      status: "running",
      maxIterations: 1,
      workers: 1,
      iterationsDispatched: 1,
      iterationsCompleted: 1,
      currentThreadId: null,
      currentTurnStartedAt: null,
      consecutiveFailures: 0,
      noCommitStreak: 0,
      infraStreak: 0,
      lastError: null,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const harness = createHarness({
      script: [],
      seedRuns: [staleRun],
      readyOutput: "[]",
      seedIterations: [
        {
          runId: staleRun.runId,
          iterationIndex: 0,
          threadId: ThreadId.make(`epic-run-${runId}-0`),
          issueId: "child-0",
          worktreePath: `/tmp/worktrees/${runId}-0`,
          turnStatus: "running",
          summary: null,
          why: null,
          failureReason: null,
          startedAt: NOW,
          finishedAt: null,
        },
        // A finished row's worktree is already released, so it must not be
        // named as something the resume still owns.
        {
          runId: staleRun.runId,
          iterationIndex: 1,
          threadId: ThreadId.make(`epic-run-${runId}-1`),
          issueId: "child-1",
          worktreePath: `/tmp/worktrees/${runId}-1`,
          turnStatus: "completed",
          summary: "done",
          why: null,
          failureReason: null,
          startedAt: NOW,
          finishedAt: NOW,
        },
      ],
      childStatuses: { "child-0": "in_progress" },
    });

    return Effect.gen(function* () {
      const runner = yield* EpicRunner;
      yield* runner.start();
      yield* waitFor(() => harness.preflightInputs.length > 0);

      const bootInput = harness.preflightInputs[0]!;
      assert.strictEqual(bootInput.intent, "resume");
      assert.deepStrictEqual(bootInput.resume, {
        runId,
        worktreePaths: [`/tmp/worktrees/${runId}-0`],
      });
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("asks a start and an operator resume for no resume forgiveness", () => {
    // `startRun`, `launchRun` and `resumeRun` all run in a workspace an
    // operator owns. Only the boot path may forgive a run's own leftovers.
    const harness = createHarness({
      script: [
        { text: "work", head: "head-1" },
        { text: "RALPH_DONE", head: "head-1" },
      ],
      options: { quietPeriodMs: 150 },
    });

    return Effect.gen(function* () {
      const runner = yield* EpicRunner;
      const run = yield* startRun();
      yield* waitFor(() => harness.store.iterations.length === 1);
      yield* runner.pauseRun({ runId: run.runId });
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "paused");
      yield* waitFor(
        () =>
          harness.store.iterations[0]?.turnStatus === "completed" &&
          harness.activeLockCount() === 0,
      );
      yield* runner.resumeRun({ runId: run.runId });
      yield* waitFor(() => harness.preflightInputs.length === 2);

      for (const preflightInput of harness.preflightInputs) {
        assert.isUndefined(preflightInput.intent);
        assert.isUndefined(preflightInput.resume);
      }
    }).pipe(Effect.provide(harness.layer));
  });

  // The boot preflight asks for whichever mode the run persisted. `mode` says
  // WHOSE tree a dirty path belongs to, and a resume can be either mode, so the
  // resume intent never replaces it.
  for (const [label, configSnapshot, expectedMode] of [
    ["parallel", defaultConfigSnapshot, "parallel"],
    ["sequential", persistedSequentialConfigSnapshot, "sequential"],
  ] as const) {
    it.live(`asks the boot preflight for the ${label} mode a ${label} run persisted`, () => {
      const runId = `run-boot-preflight-${label}`;
      const staleRun: EpicRun = {
        runId: EpicRunId.make(runId),
        epicId: "epic-1",
        projectId,
        cwd: "/tmp/epic-runner-repo",
        prompt: "do one unit of work",
        orientationFile: null,
        modelSelection,
        runtimeMode: "full-access",
        ...configSnapshot,
        originThreadId: null,
        status: "running",
        maxIterations: 1,
        workers: 1,
        iterationsDispatched: 1,
        iterationsCompleted: 1,
        currentThreadId: null,
        currentTurnStartedAt: null,
        consecutiveFailures: 0,
        noCommitStreak: 0,
        infraStreak: 0,
        lastError: null,
        createdAt: NOW,
        updatedAt: NOW,
      };
      const harness = createHarness({ script: [], seedRuns: [staleRun], readyOutput: "[]" });

      return Effect.gen(function* () {
        const runner = yield* EpicRunner;
        yield* runner.start();
        yield* waitFor(() => harness.preflightModes.length > 0);

        assert.strictEqual(harness.preflightModes[0], expectedMode);
      }).pipe(Effect.provide(harness.layer));
    });
  }

  it.live("marks an iteration left running by a restart as abandoned and resumes", () => {
    const runId = "run-restart";
    const staleRun: EpicRun = {
      runId: runId as EpicRun["runId"],
      epicId: "epic-1",
      projectId,
      cwd: "/tmp/epic-runner-repo",
      prompt: "do one unit of work",
      orientationFile: null,
      modelSelection,
      runtimeMode: "full-access",
      ...defaultConfigSnapshot,
      originThreadId: null,
      status: "running",
      maxIterations: 2,
      workers: 1,
      iterationsDispatched: 1,
      iterationsCompleted: 0,
      currentThreadId: ThreadId.make(`epic-run-${runId}-0`),
      currentTurnStartedAt: NOW,
      consecutiveFailures: 0,
      noCommitStreak: 0,
      infraStreak: 0,
      lastError: null,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const harness = createHarness({
      script: [{ text: "RALPH_DONE", head: "head-0" }],
      seedRuns: [staleRun],
      seedIterations: [
        {
          runId: staleRun.runId,
          iterationIndex: 0,
          threadId: ThreadId.make(`epic-run-${runId}-0`),
          issueId: "child-0",
          turnStatus: "running",
          summary: null,
          why: null,
          failureReason: null,
          startedAt: NOW,
          finishedAt: null,
        },
      ],
      // The provider subprocess died with the server, so the child it had
      // claimed is still `in_progress` — reconciling the abandoned iteration
      // must release it, or `bd ready` can never resurface it.
      childStatuses: { "child-0": "in_progress" },
    });

    return Effect.gen(function* () {
      const runner = yield* EpicRunner;
      yield* runner.start();
      yield* waitFor(() => harness.store.runs.get(runId)?.status === "done");

      assert.strictEqual(harness.store.iterations[0]?.turnStatus, "abandoned");
      assert.strictEqual(harness.store.iterations[0]?.summary, "abandoned by server restart");
      assert.strictEqual(harness.store.iterations[0]?.failureReason, "server-restart");
      assert.strictEqual(harness.childStatus("child-0"), "open");
      const releaseRequest = harness.processRequests.find(
        (request) =>
          request.command === "bd" && request.args[0] === "update" && request.args[1] === "child-0",
      )!;
      assert.deepStrictEqual(releaseRequest.args, [
        "update",
        "child-0",
        "--status",
        "open",
        "--assignee",
        "",
      ]);
      const staleThreadId = harness.store.iterations[0]!.threadId;
      const interruptIndex = harness.commands.findIndex(
        (command) => command.type === "thread.turn.interrupt" && command.threadId === staleThreadId,
      );
      const stopIndex = harness.commands.findIndex(
        (command) => command.type === "thread.session.stop" && command.threadId === staleThreadId,
      );
      const nextCreateIndex = harness.commands.findIndex(
        (command) => command.type === "thread.create",
      );
      assert.isAtLeast(interruptIndex, 0);
      assert.isAbove(stopIndex, interruptIndex);
      assert.isAbove(nextCreateIndex, stopIndex);
      assert.strictEqual(harness.commandsOfType("thread.settle").length, 0);
      // The resumed loop picks up at the next index, not the abandoned one.
      assert.strictEqual(harness.store.iterations[1]?.iterationIndex, 1);
      const completed = harness.store.runs.get(runId)!;
      assert.strictEqual(completed.iterationsDispatched, 2);
      assert.strictEqual(completed.iterationsCompleted, 1);
    }).pipe(Effect.provide(harness.layer));
  });

  // Workers run in `cook-epic.slice`, outside the service cgroup, so a
  // `systemctl --user restart t3code.service` leaves their scope units loaded.
  // They carry this run's own identity, so re-adopting the run means stopping
  // them, not treating them as a fatal collision.
  it.live("reclaims its own leftover worker scopes when it re-adopts a run at boot", () => {
    const runId = "run-restart-scope";
    const staleRun: EpicRun = {
      runId: runId as EpicRun["runId"],
      epicId: "epic-1",
      projectId,
      cwd: "/tmp/epic-runner-repo",
      prompt: "do one unit of work",
      orientationFile: null,
      modelSelection,
      runtimeMode: "full-access",
      ...defaultConfigSnapshot,
      originThreadId: null,
      status: "running",
      maxIterations: 2,
      workers: 1,
      iterationsDispatched: 1,
      iterationsCompleted: 0,
      currentThreadId: ThreadId.make(`epic-run-${runId}-0`),
      currentTurnStartedAt: NOW,
      consecutiveFailures: 0,
      noCommitStreak: 0,
      infraStreak: 0,
      lastError: null,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const harness = createHarness({
      script: [{ text: "RALPH_DONE", head: "head-0" }],
      seedRuns: [staleRun],
      workerScopeCollision: true,
    });

    return Effect.gen(function* () {
      const runner = yield* EpicRunner;
      yield* runner.start();
      yield* waitFor(() => harness.store.runs.get(runId)?.status === "done");

      const stops = harness.processRequests.filter(
        (request) => request.command === "systemctl" && request.args[1] === "stop",
      );
      assert.deepStrictEqual(
        stops.map((request) => request.args[2]),
        [PLANTED_WORKER_SCOPE_UNIT],
      );
      assert.strictEqual(harness.store.runs.get(runId)?.lastError, null);
    }).pipe(Effect.provide(harness.layer));
  });

  for (const [label, slotHolder, expectReclaim, otherRunStatus] of [
    ["reclaims a merge slot this run's own hard kill leaked", "cook-epic-run-slot", true, null],
    // The gap that killed run 4f11d14b: it deferred for 602s and failed on a
    // slot held by a run the same OOM had killed ten hours earlier. A dead
    // run's slot blocks every later drain exactly as thoroughly as one's own.
    [
      "reclaims a merge slot left by a run that has since finished",
      "cook-epic-run-dead",
      true,
      "failed",
    ],
    // A holder whose run this server has never heard of proves nothing: the
    // terminal coordinator's slot must survive a server boot.
    ["leaves a merge slot held by an unknown run alone", "cook-epic-someone-else", false, null],
    ["leaves a merge slot with an unrecognised holder alone", "some-other-tool", false, null],
  ] as const) {
    it.live(label, () => {
      // A SIGKILL skips the finalizer that releases the slot, so the slot
      // survives holding this run's own id. Nothing else can free it: every
      // later drain defers, and the run neither fails nor progresses.
      const runId = "run-slot";
      const staleRun: EpicRun = {
        runId: runId as EpicRun["runId"],
        epicId: "epic-1",
        projectId,
        cwd: "/tmp/epic-runner-repo",
        prompt: "do one unit of work",
        orientationFile: null,
        modelSelection,
        runtimeMode: "full-access",
        ...defaultConfigSnapshot,
        originThreadId: null,
        status: "running",
        maxIterations: 1,
        workers: 1,
        iterationsDispatched: 0,
        iterationsCompleted: 0,
        currentThreadId: null,
        currentTurnStartedAt: null,
        consecutiveFailures: 0,
        noCommitStreak: 0,
        infraStreak: 0,
        lastError: null,
        createdAt: NOW,
        updatedAt: NOW,
      };
      const otherRun: EpicRun | null =
        otherRunStatus === null
          ? null
          : {
              ...staleRun,
              runId: slotHolder.replace("cook-epic-", "") as EpicRun["runId"],
              status: otherRunStatus,
              // A different repository and epic, so seeding this row exercises
              // the status lookup without the boot path also resuming it into
              // the run under test.
              epicId: "epic-slot-owner",
              cwd: "/tmp/epic-runner-slot-owner",
            };
      const harness = createHarness({
        script: [{ text: "RALPH_DONE", head: "head-0" }],
        seedRuns: otherRun === null ? [staleRun] : [staleRun, otherRun],
        mergeSlotHolder: slotHolder,
      });

      return Effect.gen(function* () {
        const runner = yield* EpicRunner;
        yield* runner.start();
        yield* waitFor(() => harness.store.runs.get(runId)?.status === "done");

        const slotCalls = harness.processRequests.filter(
          (request) => request.command === "bd" && request.args[0] === "merge-slot",
        );
        const released = slotCalls.filter(
          (request) => request.args[1] === "release" && request.args[3] === slotHolder,
        );
        // This run queues nothing, so it never acquires the slot legitimately.
        // Any release here is the boot reclaim and nothing else.
        assert.isFalse(slotCalls.some((request) => request.args[1] === "acquire"));
        assert.strictEqual(released.length, expectReclaim ? 1 : 0);
      }).pipe(Effect.provide(harness.layer));
    });
  }

  it.live("reconciles every running worker after restart", () => {
    const runId = EpicRunId.make("run-restart-pool");
    const staleRun: EpicRun = {
      runId,
      epicId: "epic-1",
      projectId,
      cwd: "/tmp/epic-runner-repo",
      prompt: "work",
      orientationFile: null,
      modelSelection,
      runtimeMode: "full-access",
      ...defaultConfigSnapshot,
      originThreadId: null,
      status: "running",
      maxIterations: 10,
      workers: 3,
      iterationsDispatched: 3,
      iterationsCompleted: 0,
      currentThreadId: ThreadId.make(`epic-run-${runId}-2`),
      currentTurnStartedAt: NOW,
      consecutiveFailures: 0,
      noCommitStreak: 0,
      infraStreak: 0,
      lastError: null,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const seedIterations: EpicRunIteration[] = [0, 1, 2].map((iterationIndex) => ({
      runId,
      iterationIndex,
      threadId: ThreadId.make(`epic-run-${runId}-${iterationIndex}`),
      issueId: `child-${iterationIndex}`,
      workerId: `epic-run-${runId}-${iterationIndex}`,
      branch: `epic/child-${iterationIndex}`,
      worktreePath: `/tmp/worktrees/child-${iterationIndex}`,
      turnStatus: "running",
      summary: null,
      why: null,
      failureReason: null,
      startedAt: NOW,
      finishedAt: null,
    }));
    const harness = createHarness({
      script: [],
      readyOutput: "[]",
      seedRuns: [staleRun],
      seedIterations,
      childStatuses: {
        "child-0": "in_progress",
        "child-1": "in_progress",
        "child-2": "in_progress",
      },
    });
    return Effect.gen(function* () {
      const runner = yield* EpicRunner;
      yield* runner.start();
      yield* waitFor(() => harness.store.runs.get(runId)?.status === "done");
      assert.strictEqual(harness.commandsOfType("thread.turn.interrupt").length, 3);
      assert.strictEqual(harness.commandsOfType("thread.session.stop").length, 3);
      assert.deepStrictEqual(
        harness.store.iterations.map((row) => [row.turnStatus, row.failureReason]),
        [
          ["abandoned", "server-restart"],
          ["abandoned", "server-restart"],
          ["abandoned", "server-restart"],
        ],
      );
      assert.deepStrictEqual(
        ["child-0", "child-1", "child-2"].map((issueId) => harness.childStatus(issueId)),
        ["open", "open", "open"],
      );
    }).pipe(Effect.provide(harness.layer));
  });

  // ─── Restart resume ──────────────────────────────────────────────────────
  //
  // Workers live in `cook-epic.slice`, so a `systemctl --user restart` kills
  // the server and leaves their threads, sessions and worktrees intact. The
  // boot path picks each one back up instead of throwing its work away.

  const interruptedRun = (input: {
    readonly runId: EpicRunId;
    readonly cwd: string;
    readonly workers: number;
    readonly overrides?: Partial<EpicRun>;
  }): EpicRun => ({
    runId: input.runId,
    epicId: "epic-1",
    projectId,
    cwd: input.cwd,
    prompt: "do one unit of work",
    orientationFile: null,
    modelSelection,
    runtimeMode: "full-access",
    config: {
      ...DEFAULT_EPIC_RUN_CONFIG,
      parallel: { ...DEFAULT_EPIC_RUN_CONFIG.parallel, workers: input.workers },
    },
    configProvenance: DEFAULT_EPIC_RUN_CONFIG_PROVENANCE,
    originThreadId: null,
    status: "running",
    maxIterations: 10,
    workers: input.workers,
    iterationsDispatched: input.workers,
    iterationsCompleted: 0,
    currentThreadId: null,
    currentTurnStartedAt: null,
    consecutiveFailures: 0,
    noCommitStreak: 0,
    infraStreak: 0,
    lastError: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...input.overrides,
  });

  const interruptedRow = (input: {
    readonly runId: EpicRunId;
    readonly iterationIndex: number;
    readonly worktreePath: string | null;
    readonly resumeCount?: number;
  }): EpicRunIteration => ({
    runId: input.runId,
    iterationIndex: input.iterationIndex,
    threadId: ThreadId.make(`epic-run-${input.runId}-${input.iterationIndex}`),
    issueId: `child-${input.iterationIndex}`,
    workerId: `epic-run-${input.runId}-${input.iterationIndex}`,
    branch: `epic/child-${input.iterationIndex}`,
    worktreePath: input.worktreePath,
    turnStatus: "running",
    summary: null,
    why: null,
    failureReason: null,
    ...(input.resumeCount === undefined ? {} : { resumeCount: input.resumeCount }),
    startedAt: NOW,
    finishedAt: null,
  });

  /** `bd update <id> --status open --assignee ""` — the un-claim a resume must not send. */
  const unclaimRequests = (
    harness: ReturnType<typeof createHarness>,
    issueId: string,
  ): ReadonlyArray<ProcessRunner.ProcessRunInput> =>
    harness.processRequests.filter(
      (request) =>
        request.command === "bd" &&
        request.args[0] === "update" &&
        request.args[1] === issueId &&
        request.args.includes("--status") &&
        request.args[request.args.indexOf("--status") + 1] === "open",
    );

  const firstIndexOf = (
    harness: ReturnType<typeof createHarness>,
    type: OrchestrationCommand["type"],
    threadId: ThreadId,
  ) =>
    harness.commands.findIndex(
      (command) => command.type === type && "threadId" in command && command.threadId === threadId,
    );

  it.live("continues every interrupted worker on its own thread after a restart", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* makeTempWorkspace;
      const runId = EpicRunId.make("run-restart-resume");
      const worktreePaths = [0, 1].map((index) => path.join(root, `child-${index}`));
      yield* Effect.forEach(worktreePaths, (worktreePath) =>
        fileSystem.makeDirectory(worktreePath, { recursive: true }),
      );
      const harness = createHarness({
        workspaceRoot: root,
        // Stalled, so both resumed turns are still in flight while this
        // asserts. The end of an iteration stops its own session, and that
        // stop would be indistinguishable from a reconciliation teardown.
        script: [
          { text: null, head: "head-0", stall: true },
          { text: null, head: "head-0", stall: true },
        ],
        readyOutput: "[]",
        registeredWorktrees: worktreePaths,
        seedRuns: [interruptedRun({ runId, cwd: root, workers: 2 })],
        seedIterations: worktreePaths.map((worktreePath, iterationIndex) =>
          interruptedRow({ runId, iterationIndex, worktreePath, resumeCount: 0 }),
        ),
        childStatuses: { "child-0": "in_progress", "child-1": "in_progress" },
      });

      yield* Effect.gen(function* () {
        const runner = yield* EpicRunner;
        yield* runner.start();
        yield* waitFor(() => harness.commandsOfType("thread.turn.start").length === 2);
        yield* settle;

        // The lease was taken as a resume, in the mode the run persisted.
        assert.strictEqual(harness.preflightModes[0], "parallel");
        assert.strictEqual(harness.preflightInputs[0]?.intent, "resume");
        // Nothing fresh was started and nothing in flight was torn down.
        assert.lengthOf(harness.commandsOfType("thread.create"), 0);
        assert.lengthOf(harness.commandsOfType("thread.turn.interrupt"), 0);
        assert.lengthOf(harness.commandsOfType("thread.session.stop"), 0);
        assert.deepStrictEqual(
          harness
            .commandsOfType("thread.session.resume")
            .map((command) => command.threadId)
            .toSorted(),
          [`epic-run-${runId}-0`, `epic-run-${runId}-1`],
        );
        for (const iterationIndex of [0, 1]) {
          const threadId = ThreadId.make(`epic-run-${runId}-${iterationIndex}`);
          const turn = harness
            .commandsOfType("thread.turn.start")
            .find((command) => command.threadId === threadId);
          assert.isTrue(turn?.message.messageId.startsWith(`${threadId}-resume-`));
          // Never the id the interrupted iteration's own prompt already used.
          assert.notStrictEqual(turn?.message.messageId, `${threadId}-prompt`);
          // The claim survived: nothing sent it back to the ready pool.
          assert.lengthOf(unclaimRequests(harness, `child-${iterationIndex}`), 0);
          assert.strictEqual(harness.childStatus(`child-${iterationIndex}`), "in_progress");
        }
        // One iteration across two process lifetimes: the same two rows, at
        // the same indexes, each charged one resume.
        assert.deepStrictEqual(
          harness.store.iterations.map((row) => [
            row.iterationIndex,
            row.turnStatus,
            row.resumeCount,
          ]),
          [
            [0, "running", 1],
            [1, "running", 1],
          ],
        );
        // A resume spends no dispatch budget: the iterations were charged
        // before the restart.
        assert.strictEqual(harness.store.runs.get(runId)?.iterationsDispatched, 2);
      }).pipe(Effect.provide(harness.layer));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live("abandons the row whose worktree is gone and resumes its sibling", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* makeTempWorkspace;
      const runId = EpicRunId.make("run-restart-resume-mixed");
      const livePath = path.join(root, "child-0");
      const goneWorktreePath = path.join(root, "child-1");
      yield* fileSystem.makeDirectory(livePath, { recursive: true });
      const harness = createHarness({
        workspaceRoot: root,
        script: [{ text: null, head: "head-0", stall: true }],
        readyOutput: "[]",
        // Only the survivor is still attached to the checkout.
        registeredWorktrees: [livePath],
        seedRuns: [interruptedRun({ runId, cwd: root, workers: 2 })],
        seedIterations: [
          interruptedRow({ runId, iterationIndex: 0, worktreePath: livePath, resumeCount: 0 }),
          interruptedRow({
            runId,
            iterationIndex: 1,
            worktreePath: goneWorktreePath,
            resumeCount: 0,
          }),
        ],
        childStatuses: { "child-0": "in_progress", "child-1": "in_progress" },
      });

      yield* Effect.gen(function* () {
        const runner = yield* EpicRunner;
        yield* runner.start();
        yield* waitFor(() => harness.commandsOfType("thread.turn.start").length === 1);
        yield* settle;

        const survivor = ThreadId.make(`epic-run-${runId}-0`);
        const orphan = ThreadId.make(`epic-run-${runId}-1`);
        assert.deepStrictEqual(
          harness.commandsOfType("thread.session.resume").map((command) => command.threadId),
          [survivor],
        );
        // The orphan takes exactly the path every restart used to take.
        assert.isAtLeast(firstIndexOf(harness, "thread.turn.interrupt", orphan), 0);
        assert.isAtLeast(firstIndexOf(harness, "thread.session.stop", orphan), 0);
        assert.lengthOf(unclaimRequests(harness, "child-1"), 1);
        assert.strictEqual(harness.childStatus("child-1"), "open");
        // The survivor is untouched by that reconciliation.
        assert.strictEqual(firstIndexOf(harness, "thread.turn.interrupt", survivor), -1);
        assert.strictEqual(firstIndexOf(harness, "thread.session.stop", survivor), -1);
        assert.lengthOf(unclaimRequests(harness, "child-0"), 0);
        assert.deepStrictEqual(
          harness.store.iterations.map((row) => [row.iterationIndex, row.turnStatus]),
          [
            [0, "running"],
            [1, "abandoned"],
          ],
        );
        assert.strictEqual(harness.store.iterations[1]?.failureReason, "server-restart");
      }).pipe(Effect.provide(harness.layer));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live("abandons an interrupted row that has already spent its resume budget", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* makeTempWorkspace;
      const runId = EpicRunId.make("run-restart-resume-budget");
      const worktreePath = path.join(root, "child-0");
      yield* fileSystem.makeDirectory(worktreePath, { recursive: true });
      const harness = createHarness({
        workspaceRoot: root,
        script: [],
        readyOutput: "[]",
        registeredWorktrees: [worktreePath],
        seedRuns: [interruptedRun({ runId, cwd: root, workers: 1 })],
        // A row this process already resumed once. Resuming it again would
        // spend a second full iteration on a thread that keeps dying.
        seedIterations: [
          interruptedRow({ runId, iterationIndex: 0, worktreePath, resumeCount: 1 }),
        ],
        childStatuses: { "child-0": "in_progress" },
      });

      yield* Effect.gen(function* () {
        const runner = yield* EpicRunner;
        yield* runner.start();
        yield* waitFor(() => harness.store.runs.get(runId)?.status === "done");

        assert.lengthOf(harness.commandsOfType("thread.session.resume"), 0);
        assert.strictEqual(harness.store.iterations[0]?.turnStatus, "abandoned");
        assert.strictEqual(harness.store.iterations[0]?.failureReason, "server-restart");
        // Unchanged, because nothing reopened the row.
        assert.strictEqual(harness.store.iterations[0]?.resumeCount, 1);
        assert.strictEqual(harness.childStatus("child-0"), "open");
      }).pipe(Effect.provide(harness.layer));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  // The boot path must not route through `resumeRun`, which zeroes all three
  // budgets. A run in the no-commit gutter would otherwise restart its way out
  // of it, forever.
  it.live("keeps the failure budgets a restarted run had already spent", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* makeTempWorkspace;
      const runId = EpicRunId.make("run-restart-resume-streaks");
      const worktreePath = path.join(root, "child-0");
      yield* fileSystem.makeDirectory(worktreePath, { recursive: true });
      const harness = createHarness({
        workspaceRoot: root,
        // Stalled, so the run is still mid-iteration when the budgets are read.
        script: [{ text: null, head: "head-0", stall: true }],
        readyOutput: "[]",
        registeredWorktrees: [worktreePath],
        seedRuns: [
          interruptedRun({
            runId,
            cwd: root,
            workers: 1,
            overrides: { consecutiveFailures: 2, noCommitStreak: 1, infraStreak: 1 },
          }),
        ],
        seedIterations: [
          interruptedRow({ runId, iterationIndex: 0, worktreePath, resumeCount: 0 }),
        ],
        childStatuses: { "child-0": "in_progress" },
      });

      yield* Effect.gen(function* () {
        const runner = yield* EpicRunner;
        yield* runner.start();
        yield* waitFor(() => harness.commandsOfType("thread.turn.start").length === 1);
        yield* settle;

        const run = harness.store.runs.get(runId)!;
        assert.strictEqual(run.status, "running");
        assert.strictEqual(run.consecutiveFailures, 2);
        assert.strictEqual(run.noCommitStreak, 1);
        assert.strictEqual(run.infraStreak, 1);
      }).pipe(Effect.provide(harness.layer));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  /** What a sequential run persists, read back by the boot path as-is. */
  const sequentialOverrides = {
    config: {
      ...DEFAULT_EPIC_RUN_CONFIG,
      execution: { sequential: true },
      parallel: { ...DEFAULT_EPIC_RUN_CONFIG.parallel, workers: 1 },
    },
    configProvenance: {
      ...DEFAULT_EPIC_RUN_CONFIG_PROVENANCE,
      "execution.sequential": "file" as const,
    },
  } satisfies Partial<EpicRun>;

  it.live("keeps each resumed worker on its own thread, branch and worktree", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* makeTempWorkspace;
      const runId = EpicRunId.make("run-restart-resume-pool");
      const indexes = [0, 1, 2];
      const worktreePaths = indexes.map((index) => path.join(root, `child-${index}`));
      yield* Effect.forEach(worktreePaths, (worktreePath) =>
        fileSystem.makeDirectory(worktreePath, { recursive: true }),
      );
      const harness = createHarness({
        workspaceRoot: root,
        // Stalled, so all three resumed turns are still in flight here.
        script: indexes.map(() => ({ text: null, head: "head-0", stall: true })),
        readyOutput: "[]",
        registeredWorktrees: worktreePaths,
        seedRuns: [interruptedRun({ runId, cwd: root, workers: 3 })],
        seedIterations: worktreePaths.map((worktreePath, iterationIndex) =>
          interruptedRow({ runId, iterationIndex, worktreePath, resumeCount: 0 }),
        ),
        childStatuses: Object.fromEntries(
          indexes.map((index) => [`child-${index}`, "in_progress"]),
        ),
      });

      yield* Effect.gen(function* () {
        const runner = yield* EpicRunner;
        yield* runner.start();
        yield* waitFor(() => harness.commandsOfType("thread.turn.start").length === 3);
        yield* settle;

        assert.lengthOf(harness.commandsOfType("thread.create"), 0);
        assert.deepStrictEqual(
          harness
            .commandsOfType("thread.turn.start")
            .map((command) => command.threadId)
            .toSorted(),
          indexes.map((index) => `epic-run-${runId}-${index}`),
        );
        // Each row is the one the dead worker wrote: same index, same worker
        // identity, same branch, same worktree. A resume rebuilds the record
        // of a worker; it never re-provisions one.
        assert.deepStrictEqual(
          harness.store.iterations.map((row) => [
            row.iterationIndex,
            row.threadId,
            row.workerId,
            row.branch,
            row.worktreePath,
            row.turnStatus,
            row.resumeCount,
          ]),
          indexes.map((index) => [
            index,
            `epic-run-${runId}-${index}`,
            `epic-run-${runId}-${index}`,
            `epic/child-${index}`,
            worktreePaths[index],
            "running",
            1,
          ]),
        );
        assert.strictEqual(harness.store.runs.get(runId)?.iterationsDispatched, 3);
        assert.isEmpty(harness.provisionInputs);
      }).pipe(Effect.provide(harness.layer));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  // Dirt in a sequential run's checkout at boot is the run's own unfinished
  // work, so preflight demotes it to a warning. A warning is something the
  // boot path logs, not something it stops for.
  it.live("resumes a sequential run through the dirty tree its own worker left", () => {
    const logs = captureLogs();
    const runId = EpicRunId.make("run-restart-resume-dirt");
    const dirtyPaths = ["apps/server/src/runner/Layers/EpicRunner.ts"];
    const harness = createHarness({
      // Stalled, so the resumed turn is still in flight while this asserts.
      script: [{ text: null, head: "head-1", stall: true }],
      readyOutput: "[]",
      initialHead: "head-1",
      initialWorktreeFingerprint: " M apps/server/src/runner/Layers/EpicRunner.ts\n",
      preflightResult: stubPreflightResult({
        warnings: [{ _tag: "dirty_tree_accepted", paths: dirtyPaths }],
      }),
      seedRuns: [
        interruptedRun({
          runId,
          cwd: "/tmp/epic-runner-repo",
          workers: 1,
          overrides: sequentialOverrides,
        }),
      ],
      seedIterations: [
        interruptedRow({ runId, iterationIndex: 0, worktreePath: null, resumeCount: 0 }),
      ],
      childStatuses: { "child-0": "in_progress" },
    });

    return Effect.gen(function* () {
      const runner = yield* EpicRunner;
      yield* runner.start();
      yield* waitFor(() => harness.commandsOfType("thread.turn.start").length === 1);
      yield* settle;

      // `mode` still says whose tree the dirt belongs to; `intent` is the
      // second axis, and only the two together forgive this run's own dirt.
      assert.strictEqual(harness.preflightModes[0], "sequential");
      assert.strictEqual(harness.preflightInputs[0]?.intent, "resume");

      const threadId = ThreadId.make(`epic-run-${runId}-0`);
      assert.lengthOf(harness.commandsOfType("thread.create"), 0);
      assert.deepStrictEqual(
        harness.commandsOfType("thread.session.resume").map((command) => command.threadId),
        [threadId],
      );
      assert.strictEqual(firstIndexOf(harness, "thread.turn.interrupt", threadId), -1);
      assert.strictEqual(firstIndexOf(harness, "thread.session.stop", threadId), -1);
      assert.lengthOf(unclaimRequests(harness, "child-0"), 0);
      assert.strictEqual(harness.childStatus("child-0"), "in_progress");

      const run = harness.store.runs.get(runId)!;
      assert.strictEqual(run.status, "running");
      assert.isNull(run.lastError);
      assert.strictEqual(harness.store.iterations[0]?.turnStatus, "running");

      const warned = logs.messages.find(
        (message) => message[0] === "epic.runner.resume-preflight-warnings",
      );
      assert.deepInclude(warned?.[1], {
        warnings: [{ _tag: "dirty_tree_accepted", paths: dirtyPaths }],
      });
    }).pipe(Effect.provide(Layer.merge(harness.layer, logs.layer)));
  });

  // `headBefore` never survives the restart: it is in-memory only and the row
  // carries no head column. The resume re-reads it, so the commit the dead
  // worker already landed belongs to the iteration before the death — not to
  // the resumed turn, which committed nothing.
  it.live("re-reads the commit baseline at resume time", () => {
    const runId = EpicRunId.make("run-restart-resume-baseline");
    const harness = createHarness({
      // The dead worker's commit is already in the checkout, and its edits are
      // still uncommitted in the tree.
      initialHead: "head-1",
      initialWorktreeFingerprint: " M apps/server/src/runner/Layers/EpicRunner.ts\n",
      script: [
        {
          text: 'RALPH_MSG: {"summary":"kept talking","why":"restart"}',
          head: "head-1",
          worktreeFingerprint: " M apps/server/src/runner/Layers/EpicRunner.ts\n",
        },
      ],
      readyOutput: "[]",
      options: { maxNoCommitStreak: 1 },
      seedRuns: [
        interruptedRun({
          runId,
          cwd: "/tmp/epic-runner-repo",
          workers: 1,
          overrides: sequentialOverrides,
        }),
      ],
      seedIterations: [
        interruptedRow({ runId, iterationIndex: 0, worktreePath: null, resumeCount: 0 }),
      ],
      childStatuses: { "child-0": "in_progress" },
    });

    return Effect.gen(function* () {
      const runner = yield* EpicRunner;
      yield* runner.start();
      yield* waitFor(() => harness.store.runs.get(runId)?.status === "failed");

      assert.lengthOf(harness.commandsOfType("thread.create"), 0);
      assert.lengthOf(harness.commandsOfType("thread.session.resume"), 1);
      // Baselined at `head-1`, the head the resume actually read. A baseline
      // reconstructed as the pre-restart `head-0` would have credited the
      // resumed turn with the dead worker's commit.
      assert.strictEqual(harness.store.iterations[0]?.turnStatus, "failed");
      assert.strictEqual(harness.store.iterations[0]?.failureReason, "child:no-commit-child-open");
      assert.strictEqual(harness.store.iterations[0]?.resumeCount, 1);
    }).pipe(Effect.provide(harness.layer));
  });

  // The resume proves continuity before it says anything, so a refused turn is
  // a dispatch failure like any other — and the run's own failure path is what
  // hands the child back.
  it.live("releases the stranded child when the resume dispatch itself fails", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* makeTempWorkspace;
      const runId = EpicRunId.make("run-restart-resume-refused");
      const worktreePath = path.join(root, "child-0");
      yield* fileSystem.makeDirectory(worktreePath, { recursive: true });
      const harness = createHarness({
        workspaceRoot: root,
        script: [],
        readyOutput: "[]",
        registeredWorktrees: [worktreePath],
        refuseCommandTypes: ["thread.turn.start"],
        options: { infraFailureBudget: 1 },
        seedRuns: [interruptedRun({ runId, cwd: root, workers: 1 })],
        seedIterations: [
          interruptedRow({ runId, iterationIndex: 0, worktreePath, resumeCount: 0 }),
        ],
        childStatuses: { "child-0": "in_progress" },
      });

      yield* Effect.gen(function* () {
        const runner = yield* EpicRunner;
        yield* runner.start();
        yield* waitFor(() => harness.store.runs.get(runId)?.status === "failed");
        yield* waitFor(() => unclaimRequests(harness, "child-0").length === 1);

        // Continuity was proved first: the session was picked up, and only the
        // prompt after it was refused.
        assert.lengthOf(harness.commandsOfType("thread.session.resume"), 1);
        assert.strictEqual(harness.store.iterations[0]?.turnStatus, "failed");
        assert.strictEqual(harness.store.iterations[0]?.failureReason, "infra:dispatch-failed");
        assert.deepStrictEqual(unclaimRequests(harness, "child-0")[0]?.args, [
          "update",
          "child-0",
          "--status",
          "open",
          "--assignee",
          "",
        ]);
        assert.strictEqual(harness.childStatus("child-0"), "open");
      }).pipe(Effect.provide(harness.layer));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  // The budget bounds the resume, not the run: the child still gets worked,
  // just from a fresh thread that carries none of the dead one's transcript.
  it.live("dispatches the child fresh once its row has spent the resume budget", () => {
    const runId = EpicRunId.make("run-restart-resume-spent");
    const harness = createHarness({
      script: [{ text: "RALPH_DONE", head: "head-1" }],
      initialHead: "head-1",
      readyChildren: ["child-1"],
      seedRuns: [
        interruptedRun({
          runId,
          cwd: "/tmp/epic-runner-repo",
          workers: 1,
          overrides: sequentialOverrides,
        }),
      ],
      seedIterations: [
        interruptedRow({ runId, iterationIndex: 0, worktreePath: null, resumeCount: 1 }),
      ],
      childStatuses: { "child-0": "in_progress" },
    });

    return Effect.gen(function* () {
      const runner = yield* EpicRunner;
      yield* runner.start();
      yield* waitFor(() => harness.store.runs.get(runId)?.status === "done");

      // The interrupted row took today's abandon path, whole.
      assert.lengthOf(harness.commandsOfType("thread.session.resume"), 0);
      assert.strictEqual(harness.store.iterations[0]?.turnStatus, "abandoned");
      assert.strictEqual(harness.store.iterations[0]?.failureReason, "server-restart");
      assert.deepStrictEqual(unclaimRequests(harness, "child-0")[0]?.args, [
        "update",
        "child-0",
        "--status",
        "open",
        "--assignee",
        "",
      ]);
      // And the loop went on to a NEW row, on a NEW thread it created itself.
      assert.deepStrictEqual(
        harness.commandsOfType("thread.create").map((command) => command.threadId),
        [`epic-run-${runId}-1`],
      );
      assert.strictEqual(harness.store.iterations[1]?.iterationIndex, 1);
      assert.strictEqual(harness.store.iterations[1]?.issueId, "child-1");
    }).pipe(Effect.provide(harness.layer));
  });

  // A refusal the harness reaches BEFORE it prompts leaves the dead agent's
  // uncommitted work sitting in a worktree nobody owns. The child keeps its
  // claim and its tree, and a new thread inherits both.
  it.live("hands a refused resume's worktree to a pinned fresh iteration", () => {
    const runId = EpicRunId.make("run-restart-resume-handoff");
    const harness = createHarness({
      script: [{ text: "RALPH_DONE", head: "head-1" }],
      initialHead: "head-1",
      // Nothing on the frontier: the pinned iteration must find its child
      // without `bd ready`, because a still-claimed child is never listed.
      readyChildren: [],
      resumeOutcomes: {
        [`epic-run-${runId}-0`]: { _tag: "no-durable-state", detail: "no cursor persisted" },
      },
      seedRuns: [
        interruptedRun({
          runId,
          cwd: "/tmp/epic-runner-repo",
          workers: 1,
          overrides: sequentialOverrides,
        }),
      ],
      seedIterations: [
        interruptedRow({ runId, iterationIndex: 0, worktreePath: null, resumeCount: 0 }),
      ],
      childStatuses: { "child-0": "in_progress" },
    });

    return Effect.gen(function* () {
      const runner = yield* EpicRunner;
      yield* runner.start();
      yield* waitFor(() => harness.commandsOfType("thread.create").length === 1);

      // The claim was handed over, not given back, before the new thread ran.
      assert.lengthOf(unclaimRequests(harness, "child-0"), 0);
      assert.strictEqual(harness.childStatus("child-0"), "in_progress");

      yield* waitFor(() => harness.store.runs.get(runId)?.status === "done");

      // Asked once, refused, and never prompted on that thread again.
      assert.lengthOf(harness.commandsOfType("thread.session.resume"), 1);
      assert.strictEqual(harness.store.iterations[0]?.turnStatus, "abandoned");
      assert.strictEqual(harness.store.iterations[0]?.failureReason, "infra:resume-blocked");
      // The dead thread is interrupted as well as stopped: it still projects
      // the turn the previous process left running.
      assert.isAbove(
        firstIndexOf(harness, "thread.turn.interrupt", ThreadId.make(`epic-run-${runId}-0`)),
        -1,
      );

      // Exactly one new iteration, for the SAME child, on its own thread.
      assert.deepStrictEqual(
        harness.commandsOfType("thread.create").map((command) => command.threadId),
        [`epic-run-${runId}-1`],
      );
      assert.strictEqual(harness.store.iterations.length, 2);
      assert.strictEqual(harness.store.iterations[1]?.iterationIndex, 1);
      assert.strictEqual(harness.store.iterations[1]?.issueId, "child-0");

      // It pays for itself: a new provider turn is a charged dispatch.
      assert.strictEqual(harness.store.runs.get(runId)?.iterationsDispatched, 2);
    }).pipe(Effect.provide(harness.layer));
  });

  // The budget is per row. A resumed row that finishes hands the next
  // iteration a full budget, because the crash loop it guards against is one
  // row being picked back up over and over.
  it.live("leaves the next iteration's resume budget unspent", () => {
    const runId = EpicRunId.make("run-restart-resume-reset");
    const harness = createHarness({
      // The resumed turn commits, then the fresh iteration ends the run.
      script: [
        {
          text: 'RALPH_MSG: {"summary":"finished after the restart","why":"resumed"}',
          head: "head-2",
        },
        { text: "RALPH_DONE", head: "head-2" },
      ],
      initialHead: "head-1",
      readyChildren: ["child-1"],
      seedRuns: [
        interruptedRun({
          runId,
          cwd: "/tmp/epic-runner-repo",
          workers: 1,
          overrides: sequentialOverrides,
        }),
      ],
      seedIterations: [
        interruptedRow({ runId, iterationIndex: 0, worktreePath: null, resumeCount: 0 }),
      ],
      childStatuses: { "child-0": "in_progress" },
    });

    return Effect.gen(function* () {
      const runner = yield* EpicRunner;
      yield* runner.start();
      yield* waitFor(() => harness.store.runs.get(runId)?.status === "done");

      assert.lengthOf(harness.commandsOfType("thread.session.resume"), 1);
      assert.deepStrictEqual(
        harness.store.iterations.map((row) => [
          row.iterationIndex,
          row.turnStatus,
          row.resumeCount ?? 0,
        ]),
        [
          [0, "completed", 1],
          [1, "completed", 0],
        ],
      );
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("stops at the dispatch cap after repeated restart abandonment", () => {
    const runId = EpicRunId.make("run-restart-cap");
    const currentThreadId = ThreadId.make(`epic-run-${runId}-1`);
    const staleRun: EpicRun = {
      runId,
      epicId: "epic-1",
      projectId,
      cwd: "/tmp/epic-runner-repo",
      prompt: "do one unit of work",
      orientationFile: null,
      modelSelection,
      runtimeMode: "full-access",
      config: {
        ...DEFAULT_EPIC_RUN_CONFIG,
        limits: { ...DEFAULT_EPIC_RUN_CONFIG.limits, maxIterations: 2 },
      },
      configProvenance: {
        ...DEFAULT_EPIC_RUN_CONFIG_PROVENANCE,
        "limits.maxIterations": "file",
      },
      originThreadId: null,
      status: "running",
      maxIterations: 3,
      workers: 1,
      iterationsDispatched: 2,
      iterationsCompleted: 0,
      currentThreadId,
      currentTurnStartedAt: NOW,
      consecutiveFailures: 0,
      noCommitStreak: 0,
      infraStreak: 0,
      lastError: null,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const seedIterations: EpicRunIteration[] = [0, 1].map((iterationIndex) => ({
      runId,
      iterationIndex,
      threadId: ThreadId.make(`epic-run-${runId}-${iterationIndex}`),
      issueId: `child-${iterationIndex}`,
      turnStatus: iterationIndex === 1 ? "running" : "abandoned",
      summary: iterationIndex === 1 ? null : "abandoned by server restart",
      why: null,
      failureReason: iterationIndex === 1 ? null : "server-restart",
      startedAt: NOW,
      finishedAt: iterationIndex === 1 ? null : NOW,
    }));
    const harness = createHarness({
      script: [],
      seedRuns: [staleRun],
      seedIterations,
      childStatuses: { "child-1": "in_progress" },
    });

    return Effect.gen(function* () {
      const runner = yield* EpicRunner;
      yield* runner.start();
      yield* waitFor(() => harness.store.runs.get(runId)?.status === "done");
      const capped = harness.store.runs.get(runId)!;
      assert.strictEqual(harness.turnsStarted(), 0);
      assert.strictEqual(capped.iterationsDispatched, 2);
      assert.strictEqual(capped.iterationsCompleted, 0);
      assert.strictEqual(capped.lastError, "max iterations (2) reached");
      assert.strictEqual(harness.store.iterations[1]?.turnStatus, "abandoned");
      assert.strictEqual(harness.store.iterations[1]?.failureReason, "server-restart");
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("abandons a synthetic running row on restart without orchestration cleanup", () => {
    const runId = "run-restart-synthetic";
    const staleRun: EpicRun = {
      runId: runId as EpicRun["runId"],
      epicId: "epic-1",
      projectId,
      cwd: "/tmp/epic-runner-repo",
      prompt: "do one unit of work",
      orientationFile: null,
      modelSelection,
      runtimeMode: "full-access",
      ...defaultConfigSnapshot,
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
      createdAt: NOW,
      updatedAt: NOW,
    };
    const harness = createHarness({
      script: [],
      readyOutput: "[]",
      seedRuns: [staleRun],
      seedIterations: [
        {
          runId: staleRun.runId,
          iterationIndex: 0,
          threadId: ThreadId.make(`epic-run-${runId}-0`),
          issueId: null,
          turnStatus: "running",
          summary: null,
          why: null,
          failureReason: null,
          startedAt: NOW,
          finishedAt: null,
        },
      ],
    });

    return Effect.gen(function* () {
      const runner = yield* EpicRunner;
      yield* runner.start();
      yield* waitFor(() => harness.store.runs.get(runId)?.status === "done");
      yield* waitFor(() => harness.activeLockCount() === 0);

      assert.deepInclude(harness.store.iterations[0]!, {
        issueId: null,
        turnStatus: "abandoned",
        summary: "abandoned by server restart",
        failureReason: "server-restart",
      });
      assert.strictEqual(harness.commandsOfType("thread.turn.interrupt").length, 0);
      assert.strictEqual(harness.commandsOfType("thread.session.stop").length, 0);
      assert.strictEqual(
        harness.processRequests.filter(
          (request) => request.command === "bd" && request.args[0] === "update",
        ).length,
        0,
      );
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("reconciles running iteration rows for a paused run on restart", () => {
    const runId = EpicRunId.make("run-restart-paused");
    const pausedRun: EpicRun = {
      runId,
      epicId: "epic-1",
      projectId,
      cwd: "/tmp/epic-runner-repo",
      prompt: "do one unit of work",
      orientationFile: null,
      modelSelection,
      runtimeMode: "full-access",
      ...defaultConfigSnapshot,
      originThreadId: null,
      status: "paused",
      maxIterations: 10,
      workers: 1,
      iterationsDispatched: 1,
      iterationsCompleted: 0,
      currentThreadId: null,
      currentTurnStartedAt: null,
      consecutiveFailures: 0,
      noCommitStreak: 0,
      infraStreak: 0,
      lastError: null,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const harness = createHarness({
      script: [],
      seedRuns: [pausedRun],
      childStatuses: { "child-a": "in_progress" },
      seedIterations: [
        {
          runId,
          iterationIndex: 0,
          threadId: ThreadId.make(`epic-run-${runId}-0`),
          issueId: "child-a",
          turnStatus: "running",
          summary: null,
          why: null,
          failureReason: null,
          startedAt: NOW,
          finishedAt: null,
        },
      ],
    });

    return Effect.gen(function* () {
      const runner = yield* EpicRunner;
      yield* runner.start();

      assert.strictEqual(harness.store.runs.get(runId)?.status, "paused");
      assert.strictEqual(harness.store.iterations[0]?.turnStatus, "abandoned");
      assert.strictEqual(harness.store.iterations[0]?.failureReason, "server-restart");
      assert.isTrue(
        harness.processRequests.some(
          (request) =>
            request.command === "bd" &&
            request.args[0] === "update" &&
            request.args[1] === "child-a" &&
            request.args.includes("open"),
        ),
      );
      assert.strictEqual(harness.activeLockCount(), 0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("releases a stranded child when a restart cannot reacquire the run's lease", () => {
    // This run's loop never gets a chance to fork — the lease acquisition
    // itself fails — so its finalizer never runs. The lease-failure branch in
    // `start` has to release the run's last claimed child on its own.
    const runId = "run-lease-failure";
    const staleRun: EpicRun = {
      runId: runId as EpicRun["runId"],
      epicId: "epic-1",
      projectId,
      cwd: "/tmp/epic-runner-repo",
      prompt: "do one unit of work",
      orientationFile: null,
      modelSelection,
      runtimeMode: "full-access",
      ...defaultConfigSnapshot,
      originThreadId: null,
      status: "running",
      maxIterations: 10,
      workers: 1,
      iterationsDispatched: 1,
      iterationsCompleted: 1,
      currentThreadId: null,
      currentTurnStartedAt: null,
      consecutiveFailures: 0,
      noCommitStreak: 0,
      infraStreak: 0,
      lastError: null,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const harness = createHarness({
      script: [],
      seedRuns: [staleRun],
      seedIterations: [
        {
          runId: staleRun.runId,
          iterationIndex: 0,
          threadId: ThreadId.make(`epic-run-${runId}-0`),
          issueId: "child-0",
          turnStatus: "completed",
          summary: "done",
          why: null,
          failureReason: null,
          startedAt: NOW,
          finishedAt: NOW,
        },
      ],
      childStatuses: { "child-0": "in_progress" },
      lockAcquireError: new EpicRunLockError("lease store unavailable"),
    });

    return Effect.gen(function* () {
      const runner = yield* EpicRunner;
      yield* runner.start();
      yield* waitFor(() => harness.store.runs.get(runId)?.status === "paused");
      yield* waitFor(() => harness.childStatus("child-0") === "open");

      const releaseRequest = harness.processRequests.find(
        (request) =>
          request.command === "bd" && request.args[0] === "update" && request.args[1] === "child-0",
      )!;
      assert.deepStrictEqual(releaseRequest.args, [
        "update",
        "child-0",
        "--status",
        "open",
        "--assignee",
        "",
      ]);
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("lets a paused run finish its iteration and then stops", () => {
    // A slow session stop so the pause lands while the first iteration is in flight,
    // which is the case worth pinning: the turn must not be cut short, and the
    // loop's own write must not resurrect the run as `running`.
    const harness = createHarness({
      script: [
        { text: "work", head: "head-1" },
        { text: "should never run", head: "head-2" },
      ],
      options: { quietPeriodMs: 150 },
    });

    return Effect.gen(function* () {
      const runner = yield* EpicRunner;
      const run = yield* startRun();
      yield* waitFor(() => harness.store.iterations.length === 1);

      const paused = yield* runner.pauseRun({ runId: run.runId });
      assert.strictEqual(paused.status, "paused");

      // The first iteration still completes; the loop exits at the boundary.
      yield* waitFor(() => harness.store.iterations[0]?.turnStatus === "completed");
      yield* settle;
      assert.strictEqual(harness.turnsStarted(), 1);
      assert.strictEqual(harness.store.runs.get(run.runId)!.status, "paused");
      assert.strictEqual(harness.store.runs.get(run.runId)!.iterationsCompleted, 1);
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("resumes a paused run from the next iteration index", () => {
    const harness = createHarness({
      script: [
        { text: "work", head: "head-1" },
        { text: "RALPH_DONE", head: "head-1" },
      ],
      options: { quietPeriodMs: 150 },
    });

    return Effect.gen(function* () {
      const runner = yield* EpicRunner;
      const run = yield* startRun();
      yield* waitFor(() => harness.store.iterations.length === 1);
      yield* runner.pauseRun({ runId: run.runId });
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "paused");
      yield* waitFor(
        () =>
          harness.store.iterations[0]?.turnStatus === "completed" &&
          harness.activeLockCount() === 0,
      );

      yield* runner.resumeRun({ runId: run.runId });
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "done");

      assert.strictEqual(harness.store.iterations.length, 2);
      assert.strictEqual(harness.store.iterations[1]?.iterationIndex, 1);
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("resumes a paused run while its iteration is still in flight", () => {
    // The window the resume used to be refused in. `pauseRun` does not
    // interrupt the turn, so the run keeps its own lock for the rest of that
    // iteration — as long as an agent turn lasts — and a resume that relaunched
    // there ran launch preflight against that lock and failed with
    // `run_in_progress`. The live loop has to be handed the run instead.
    let acquired = 0;
    const harness = createHarness({
      script: [
        { text: "work", head: "head-1" },
        // No new head: `RALPH_DONE` after a commit is a protocol violation.
        { text: "RALPH_DONE", head: "head-1" },
      ],
      // Wide enough that the pause and the resume both land inside the first
      // iteration's completion window.
      options: { quietPeriodMs: 300 },
      onLockAcquire: () => {
        acquired += 1;
      },
    });

    return Effect.gen(function* () {
      const runner = yield* EpicRunner;
      const run = yield* startRun();
      yield* waitFor(() => harness.store.iterations.length === 1);
      yield* runner.pauseRun({ runId: run.runId });
      // Pinned: the iteration this resume has to survive really is still going.
      assert.strictEqual(harness.store.iterations[0]?.turnStatus, "running");

      const resumed = yield* runner.resumeRun({ runId: run.runId });
      assert.strictEqual(resumed.status, "running");

      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "done");
      assert.strictEqual(harness.store.iterations.length, 2);
      assert.strictEqual(harness.store.iterations[1]?.iterationIndex, 1);
      // One lease and one loop for the whole run: the resume was handed to the
      // draining loop, not relaunched under a second lock.
      assert.strictEqual(acquired, 1);
      assert.strictEqual(harness.turnsStarted(), 2);
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("explicit resume resets both persisted streaks", () => {
    const runId = EpicRunId.make("run-resume-streaks");
    const pausedRun: EpicRun = {
      runId,
      epicId: "epic-1",
      projectId,
      cwd: "/tmp/epic-runner-repo",
      prompt: "do one unit of work",
      orientationFile: null,
      modelSelection,
      runtimeMode: "full-access",
      ...defaultConfigSnapshot,
      originThreadId: null,
      status: "paused",
      maxIterations: 1,
      workers: 1,
      iterationsDispatched: 1,
      iterationsCompleted: 0,
      currentThreadId: null,
      currentTurnStartedAt: null,
      consecutiveFailures: 2,
      noCommitStreak: 1,
      infraStreak: 4,
      lastError: "old failure",
      createdAt: NOW,
      updatedAt: NOW,
    };
    const harness = createHarness({ script: [], seedRuns: [pausedRun] });

    return Effect.gen(function* () {
      const runner = yield* EpicRunner;
      const resumed = yield* runner.resumeRun({ runId });
      assert.strictEqual(resumed.consecutiveFailures, 0);
      assert.strictEqual(resumed.noCommitStreak, 0);
      assert.strictEqual(resumed.infraStreak, 0);
      yield* waitFor(() => harness.store.runs.get(runId)?.status === "done");
      assert.strictEqual(harness.turnsStarted(), 0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("resumes from a non-default persisted snapshot without reading config", () => {
    const runId = EpicRunId.make("run-resume-config-snapshot");
    const pausedRun: EpicRun = {
      runId,
      epicId: "epic-1",
      projectId,
      cwd: "/tmp/epic-runner-repo",
      prompt: "do one unit of work",
      orientationFile: null,
      modelSelection,
      runtimeMode: "full-access",
      ...persistedSequentialConfigSnapshot,
      originThreadId: null,
      status: "paused",
      maxIterations: 7,
      workers: 1,
      iterationsDispatched: 0,
      iterationsCompleted: 0,
      currentThreadId: null,
      currentTurnStartedAt: null,
      consecutiveFailures: 0,
      noCommitStreak: 0,
      infraStreak: 0,
      lastError: null,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const harness = createHarness({ script: [], readyOutput: "[]", seedRuns: [pausedRun] });

    return Effect.gen(function* () {
      const runner = yield* EpicRunner;
      yield* runner.resumeRun({ runId });
      yield* waitFor(() => harness.store.runs.get(runId)?.status === "done");
      assert.strictEqual(
        harness.store.runs.get(runId)?.status,
        "done",
        harness.store.runs.get(runId)?.lastError ?? undefined,
      );

      const stored = harness.store.runs.get(runId)!;
      assert.deepStrictEqual(stored.config, persistedSequentialConfigSnapshot.config);
      assert.deepStrictEqual(
        stored.configProvenance,
        persistedSequentialConfigSnapshot.configProvenance,
      );
      assert.deepStrictEqual(harness.configReadRoots, []);
      assert.deepStrictEqual(harness.preflightModes, ["sequential"]);
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("keeps a stopped run paused when resume cannot acquire its lease", () => {
    const runId = EpicRunId.make("run-resume-acquire-failure");
    const pausedRun: EpicRun = {
      runId,
      epicId: "epic-1",
      projectId,
      cwd: "/tmp/epic-runner-repo",
      prompt: "do one unit of work",
      orientationFile: null,
      modelSelection,
      runtimeMode: "full-access",
      ...defaultConfigSnapshot,
      originThreadId: null,
      status: "paused",
      maxIterations: 10,
      workers: 1,
      iterationsDispatched: 4,
      iterationsCompleted: 2,
      currentThreadId: null,
      currentTurnStartedAt: null,
      consecutiveFailures: 2,
      noCommitStreak: 1,
      infraStreak: 3,
      lastError: "old failure",
      createdAt: NOW,
      updatedAt: NOW,
    };
    const harness = createHarness({
      script: [],
      seedRuns: [pausedRun],
      lockAcquireError: new EpicRunLockError("lease store unavailable"),
    });

    return Effect.gen(function* () {
      const runner = yield* EpicRunner;
      const exit = yield* Effect.exit(runner.resumeRun({ runId }));
      assert.isTrue(Exit.isFailure(exit));
      const persisted = harness.store.runs.get(runId)!;
      assert.strictEqual(persisted.status, "paused");
      assert.strictEqual(persisted.consecutiveFailures, 2);
      assert.strictEqual(persisted.noCommitStreak, 1);
      assert.strictEqual(persisted.infraStreak, 3);
      assert.strictEqual(persisted.lastError, "old failure");
      assert.strictEqual(harness.turnsStarted(), 0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("does not overwrite cancellation while a resumed run acquires its lease", () =>
    Effect.gen(function* () {
      const runId = EpicRunId.make("run-resume-cancel-race");
      const pausedRun: EpicRun = {
        runId,
        epicId: "epic-1",
        projectId,
        cwd: "/tmp/epic-runner-repo",
        prompt: "do one unit of work",
        orientationFile: null,
        modelSelection,
        runtimeMode: "full-access",
        ...defaultConfigSnapshot,
        originThreadId: null,
        status: "paused",
        maxIterations: 10,
        workers: 1,
        iterationsDispatched: 4,
        iterationsCompleted: 2,
        currentThreadId: null,
        currentTurnStartedAt: null,
        consecutiveFailures: 2,
        noCommitStreak: 1,
        infraStreak: 3,
        lastError: "old failure",
        createdAt: NOW,
        updatedAt: NOW,
      };
      const acquireGate = yield* Deferred.make<void>();
      const acquireStarted = yield* Deferred.make<void>();
      let acquired = 0;
      let released = 0;
      const harness = createHarness({
        script: [],
        seedRuns: [pausedRun],
        beforeLockAcquire: Deferred.succeed(acquireStarted, undefined).pipe(
          Effect.andThen(Deferred.await(acquireGate)),
        ),
        onLockAcquire: () => {
          acquired += 1;
        },
        onLockRelease: () => {
          released += 1;
        },
      });

      yield* Effect.gen(function* () {
        const runner = yield* EpicRunner;
        const resumeFiber = yield* Effect.forkChild(runner.resumeRun({ runId }), {
          startImmediately: true,
        });
        yield* Deferred.await(acquireStarted);
        assert.strictEqual(harness.store.runs.get(runId)?.status, "paused");

        const cancelled = yield* runner.cancelRun({ runId });
        assert.strictEqual(cancelled.status, "cancelled");
        yield* Deferred.succeed(acquireGate, undefined);

        const resumeResult = yield* Fiber.join(resumeFiber);
        assert.strictEqual(resumeResult.status, "cancelled");
        assert.strictEqual(harness.store.runs.get(runId)?.status, "cancelled");
        assert.strictEqual(harness.turnsStarted(), 0);
        assert.strictEqual(acquired, 1);
        assert.strictEqual(released, 1);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.live("publishes every run-state change on the hot stream", () => {
    const harness = createHarness({ script: [{ text: "RALPH_DONE", head: "head-0" }] });

    return Effect.gen(function* () {
      const runner = yield* EpicRunner;
      const seen: string[] = [];
      yield* Effect.forkScoped(
        Stream.runForEach(runner.streamRuns, (run) =>
          Effect.sync(() => {
            seen.push(run.status);
          }),
        ),
      );
      // Subscribing is asynchronous; nothing can be observed before it lands.
      yield* Effect.sleep("50 millis");

      yield* startRun();
      yield* waitFor(() => seen.includes("done"));

      assert.strictEqual(seen[0], "running");
      assert.strictEqual(seen[seen.length - 1], "done");
      assert.strictEqual(harness.store.iterations.length, 1);
    }).pipe(Effect.scoped, Effect.provide(harness.layer));
  });

  it.live("leaves worktreePath null when the run's cwd is the project root", () => {
    const harness = createHarness({
      script: [{ text: "RALPH_DONE", head: "head-0" }],
      workspaceRoot: "/tmp/epic-runner-repo",
      configFileResult: loadedConfigFile({ execution: { sequential: true } }),
    });

    return Effect.gen(function* () {
      const run = yield* startRun();
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "done");
      assert.strictEqual(harness.commandsOfType("thread.create")[0]?.worktreePath, null);
      assert.strictEqual(harness.commandsOfType("thread.create")[0]?.branch, null);
      assert.deepStrictEqual(harness.provisionInputs, []);
      assert.deepStrictEqual(harness.setupInputs, []);
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("provisions a parallel iteration and dispatches its setup before the turn", () => {
    const harness = createHarness({
      script: [{ text: "RALPH_DONE", head: "head-0" }],
    });

    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const run = yield* startRun();
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "done");

      const expectedPath = `${harness.worktreesDir}/epic-${run.runId}/child-1`;
      const expectedIntegrationPath = `${harness.worktreesDir}/epic-${run.runId}/integration`;
      assert.deepStrictEqual(harness.integrationProvisionInputs, [
        {
          projectCwd: "/tmp/epic-runner-repo",
          branch: `cook-epic-integration-${run.runId}`,
          baseBranch: "mine",
          path: expectedIntegrationPath,
          refuseExisting: true,
        },
      ]);
      assert.deepStrictEqual(harness.provisionInputs, [
        {
          projectCwd: "/tmp/epic-runner-repo",
          branch: "epic/child-1",
          baseBranch: "mine",
          path: expectedPath,
        },
      ]);
      const created = harness.commandsOfType("thread.create")[0]!;
      assert.strictEqual(created.branch, "epic/child-1");
      assert.strictEqual(created.worktreePath, expectedPath);
      assert.deepStrictEqual(harness.iterationLifecycle.slice(0, 3), [
        "thread.create",
        "setup",
        "thread.turn.start",
      ]);
      assert.strictEqual(harness.setupInputs[0]?.worktreePath, expectedPath);
      assert.strictEqual(
        yield* fileSystem.readFileString(`${expectedPath}/.beads/redirect`),
        "../../../epic-runner-repo/.beads",
      );
      assert.strictEqual(harness.store.iterations[0]?.workerId, created.threadId);
      assert.strictEqual(harness.store.iterations[0]?.branch, "epic/child-1");
      assert.strictEqual(harness.store.iterations[0]?.worktreePath, expectedPath);
      const runner = yield* EpicRunner;
      const transported = Option.getOrThrow(yield* runner.getRun({ runId: run.runId }));
      assert.strictEqual(transported.recentIterations[0]?.workerId, created.threadId);
      assert.strictEqual(transported.recentIterations[0]?.branch, "epic/child-1");
      assert.strictEqual(transported.recentIterations[0]?.worktreePath, expectedPath);
      assert.includeMembers(harness.releasedWorktrees, [expectedPath, expectedIntegrationPath]);
    }).pipe(Effect.provide(Layer.merge(harness.layer, NodeServices.layer)));
  });

  it.live("reuses a parked branch for Merge-fix and drains it before completion", () => {
    const runId = EpicRunId.make("run-merge-fix");
    const pausedRun: EpicRun = {
      runId,
      epicId: "epic-1",
      projectId,
      cwd: "/tmp/epic-runner-repo",
      prompt: "do one unit of work",
      orientationFile: null,
      modelSelection,
      runtimeMode: "full-access",
      ...defaultConfigSnapshot,
      originThreadId: null,
      status: "paused",
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
      createdAt: NOW,
      updatedAt: NOW,
    };
    const harness = createHarness({
      seedRuns: [pausedRun],
      readyChildren: ["fix-1"],
      openChildren: [],
      separateWorkerHead: true,
      childEvidence: {
        "fix-1": [
          {
            title: "Merge fix: land epic/original (conflict)",
            status: "closed",
            commentCount: 1,
          },
        ],
      },
      script: [
        {
          text: 'RALPH_MSG: {"summary":"fixed merge","why":"conflict resolved"}',
          head: "repair-head",
          branchCommitCount: 1,
        },
      ],
    });
    harness.store.mergeStates.set(runId, {
      runId,
      initialHead: "head-0",
      lastAcceptedHead: "head-0",
      parkedCount: 1,
      repositoryPath: "/tmp/epic-runner-repo",
      baseBranch: "mine",
      integrationBranch: `cook-epic-integration-${runId}`,
      integrationWorktreePath: `${harness.worktreesDir}/epic-${runId}/integration`,
      operatorBaseBranch: null,
      siblings: [],
      entries: [
        {
          runId,
          sequence: 0,
          childId: "original",
          branch: "epic/original",
          status: "parked",
          reason: "conflict",
          fixIssueId: "fix-1",
        },
      ],
    });

    return Effect.gen(function* () {
      const runner = yield* EpicRunner;
      yield* runner.resumeRun({ runId });
      yield* Effect.sleep("250 millis");
      assert.strictEqual(
        harness.store.runs.get(runId)?.status,
        "done",
        harness.store.runs.get(runId)?.lastError ?? undefined,
      );

      assert.strictEqual(harness.provisionInputs[0]?.branch, "epic/original");
      assert.isTrue(
        harness.processRequests.some(
          (request) =>
            request.command === "git" &&
            request.args.join(" ").includes("cook-epic: merge epic/original (original)"),
        ),
      );
      assert.isTrue(
        harness.processRequests.some(
          (request) => request.command === "git" && request.args[1] === "--ff-only",
        ),
      );
      assert.include(harness.releasedWorktrees, harness.provisionInputs[0]!.path!);
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("lands a successful parallel branch before marking the run done", () => {
    const logs = captureLogs();
    const harness = createHarness({
      readyChildren: ["child-1"],
      openChildren: [],
      separateWorkerHead: true,
      childEvidence: {
        "child-1": [{ title: "Build child", status: "closed", commentCount: 1 }],
      },
      script: [
        {
          text: 'RALPH_MSG: {"summary":"built child","why":"needed"}',
          head: "child-head",
          branchCommitCount: 3,
        },
      ],
    });

    return Effect.gen(function* () {
      const run = yield* startRun();
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "done");
      const fastForward = harness.processRequests.findIndex(
        (request) => request.command === "git" && request.args[1] === "--ff-only",
      );
      assert.isAtLeast(fastForward, 0);
      assert.includeMembers(harness.releasedWorktrees, [
        `${harness.worktreesDir}/epic-${run.runId}/child-1`,
        `${harness.worktreesDir}/epic-${run.runId}/integration`,
      ]);
      const landing = logs.messages.find(
        (message) => message[0] === "epic.runner.repository-landing-effects",
      );
      assert.deepInclude(landing?.[1], {
        commitCount: 3,
        parkedCount: 0,
        baseHead: "head-0",
        head: "child-head",
      });
    }).pipe(Effect.provide(Layer.merge(harness.layer, logs.layer)));
  });

  it.live("records landing effects for every landed repository", () => {
    const runId = EpicRunId.make("run-landing-siblings");
    const logs = captureLogs();
    const pausedRun: EpicRun = {
      runId,
      epicId: "epic-1",
      projectId,
      cwd: "/tmp/epic-runner-repo",
      prompt: "do one unit of work",
      orientationFile: null,
      modelSelection,
      runtimeMode: "full-access",
      ...defaultConfigSnapshot,
      originThreadId: null,
      status: "paused",
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
      createdAt: NOW,
      updatedAt: NOW,
    };
    const harness = createHarness({
      seedRuns: [pausedRun],
      readyChildren: ["fix-1"],
      openChildren: [],
      separateWorkerHead: true,
      childEvidence: {
        "fix-1": [
          {
            title: "Merge fix: land epic/original (conflict)",
            status: "closed",
            commentCount: 1,
          },
        ],
      },
      repositoryHeads: { "/tmp/epic-runner-sibling": "sib-head-1" },
      revListCommitCounts: {
        "/tmp/epic-runner-repo": 1,
        "/tmp/epic-runner-sibling": 2,
        "/tmp/epic-runner-sibling-integration": 2,
      },
      script: [
        {
          text: 'RALPH_MSG: {"summary":"fixed merge","why":"conflict resolved"}',
          head: "repair-head",
          branchCommitCount: 1,
        },
      ],
    });
    harness.store.mergeStates.set(runId, {
      runId,
      initialHead: "head-0",
      lastAcceptedHead: "head-0",
      parkedCount: 1,
      repositoryPath: "/tmp/epic-runner-repo",
      baseBranch: "mine",
      integrationBranch: `cook-epic-integration-${runId}`,
      integrationWorktreePath: `${harness.worktreesDir}/epic-${runId}/integration`,
      operatorBaseBranch: null,
      siblings: [
        {
          repositoryPath: "/tmp/epic-runner-sibling",
          baseBranch: "sib-main",
          integrationWorktreePath: "/tmp/epic-runner-sibling-integration",
          lastAcceptedHead: "sib-head-1",
          initialHead: "sib-head-0",
        },
      ],
      entries: [
        {
          runId,
          sequence: 0,
          childId: "original",
          branch: "epic/original",
          status: "parked",
          reason: "conflict",
          fixIssueId: "fix-1",
        },
      ],
    });

    return Effect.gen(function* () {
      const runner = yield* EpicRunner;
      yield* runner.resumeRun({ runId });
      yield* waitFor(() => harness.store.runs.get(runId)?.status === "done");
      const byRepo = new Map(
        (harness.store.landingEffects.get(runId) ?? []).map((row) => [row.repositoryPath, row]),
      );
      assert.deepInclude(byRepo.get("/tmp/epic-runner-repo"), {
        baseHead: "head-0",
        head: "repair-head",
        commitCount: 1,
        parkedCount: 1,
      });
      assert.deepInclude(byRepo.get("/tmp/epic-runner-sibling"), {
        baseHead: "sib-head-0",
        head: "sib-head-1",
        commitCount: 2,
        parkedCount: 1,
      });
      const landingLogs = logs.messages.filter(
        (message) => message[0] === "epic.runner.repository-landing-effects",
      );
      assert.strictEqual(landingLogs.length, 2);
      const siblingLog = landingLogs.find(
        (message) =>
          (message[1] as { readonly repositoryPath?: string }).repositoryPath ===
          "/tmp/epic-runner-sibling",
      );
      assert.deepInclude(siblingLog?.[1], {
        baseHead: "sib-head-0",
        head: "sib-head-1",
        commitCount: 2,
      });
    }).pipe(Effect.provide(Layer.merge(harness.layer, logs.layer)));
  });

  it.live("releases a worker worktree when post-provision setup fails", () => {
    const harness = createHarness({
      readyChildren: ["child-a"],
      openChildren: [],
      failAllocationFor: "child-a",
      script: [],
    });

    return Effect.gen(function* () {
      const run = yield* startRun();
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "failed");
      assert.include(
        harness.releasedWorktrees,
        `${harness.worktreesDir}/epic-${run.runId}/child-a`,
      );
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("releases a worker worktree when its beads redirect write fails", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* makeTempWorkspace;
      const blocker = path.join(root, "not-a-directory");
      yield* fileSystem.writeFileString(blocker, "block");
      const workerPath = path.join(blocker, "child-a");
      const harness = createHarness({
        readyChildren: ["child-a"],
        openChildren: [],
        workerProvisionPath: workerPath,
        script: [],
      });

      yield* Effect.gen(function* () {
        const run = yield* startRun();
        yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "failed");
        assert.include(harness.releasedWorktrees, workerPath);
      }).pipe(Effect.provide(harness.layer));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live("rolls back an integration worktree when merge-state persistence fails", () => {
    const harness = createHarness({
      readyChildren: ["child-a"],
      openChildren: [],
      failInitializeMergeState: true,
      script: [],
    });

    return Effect.gen(function* () {
      const run = yield* startRun();
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "failed");
      const integrationPath = `${harness.worktreesDir}/epic-${run.runId}/integration`;
      assert.include(harness.releasedWorktrees, integrationPath);
      assert.isFalse(harness.store.mergeStates.has(run.runId));
      assert.isTrue(
        harness.processRequests.some(
          (request) =>
            request.command === "git" &&
            request.args[0] === "branch" &&
            request.args.includes(`cook-epic-integration-${run.runId}`),
        ),
      );
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("lands queued sibling work before reporting a worker error", () => {
    const harness = createHarness({
      readyChildren: ["child-a", "child-b"],
      openChildren: [],
      separateWorkerHead: true,
      failAllocationFor: "child-b",
      childEvidence: {
        "child-a": [{ title: "Build child A", status: "closed", commentCount: 1 }],
      },
      script: [
        {
          text: 'RALPH_MSG: {"summary":"built A","why":"needed"}',
          head: "child-a-head",
          branchCommitCount: 1,
        },
      ],
    });

    return Effect.gen(function* () {
      const run = yield* startRunWithWorkers(2, 2);
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "failed");
      const effects = harness.store.landingEffects.get(run.runId)!;
      assert.strictEqual(effects.length, 1);
      assert.strictEqual(effects[0]?.commitCount, 1);
      assert.strictEqual(effects[0]?.head, "child-a-head");
      assert.isTrue(
        harness.processRequests.some(
          (request) => request.command === "git" && request.args[1] === "--ff-only",
        ),
      );
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("creates the merge slot before trying to acquire it", () => {
    // Regression: nothing else creates `<prefix>-merge-slot`. Without it every
    // acquire fails, the drain defers, and the loop spins on that forever while
    // still heartbeating its run lock — so the run looks healthy and lands
    // nothing. One such spin ran 8 hours before it was noticed.
    const harness = createHarness({
      readyChildren: ["child-a"],
      openChildren: [],
      separateWorkerHead: true,
      childEvidence: {
        "child-a": [{ title: "Build child A", status: "closed", commentCount: 1 }],
      },
      script: [
        {
          text: 'RALPH_MSG: {"summary":"built A","why":"needed"}',
          head: "child-a-head",
          branchCommitCount: 1,
        },
      ],
    });

    return Effect.gen(function* () {
      const run = yield* startRunWithWorkers(2, 1);
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status !== "running");

      const slotCalls = harness.processRequests.filter(
        (request) => request.command === "bd" && request.args[0] === "merge-slot",
      );
      const createdAt = slotCalls.findIndex((request) => request.args[1] === "create");
      const acquiredAt = slotCalls.findIndex((request) => request.args[1] === "acquire");

      assert.isAtLeast(createdAt, 0, "the drain never created the merge slot");
      if (acquiredAt >= 0) {
        assert.isBelow(createdAt, acquiredAt, "the slot was acquired before it was created");
      }
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("restores integration assets after clean and before the trial merge", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* makeTempWorkspace;
      yield* fileSystem.makeDirectory(path.join(root, ".beads"), { recursive: true });
      yield* fileSystem.makeDirectory(path.join(root, "node_modules"), { recursive: true });
      yield* fileSystem.writeFileString(path.join(root, ".env.test"), "RESTORED=1\n");
      const harness = createHarness({
        workspaceRoot: root,
        readyChildren: ["child-1"],
        openChildren: [],
        separateWorkerHead: true,
        childEvidence: {
          "child-1": [{ title: "Build child", status: "closed", commentCount: 1 }],
        },
        script: [
          {
            text: 'RALPH_MSG: {"summary":"built child","why":"needed"}',
            head: "child-head",
            branchCommitCount: 1,
          },
        ],
      });

      yield* Effect.gen(function* () {
        const runner = yield* EpicRunner;
        const run = yield* runner.startRun({
          epicId: "epic-1",
          projectId,
          cwd: root,
          prompt: "do one unit of work",
          orientationFile: null,
          modelSelection,
          config: { parallel: { workers: 1 } },
          maxIterations: 10,
        });
        yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "done");

        const integrationPath = `${harness.worktreesDir}/epic-${run.runId}/integration`;
        assert.strictEqual(
          yield* fileSystem.readFileString(path.join(integrationPath, ".env.test")),
          "RESTORED=1\n",
        );
        assert.isTrue(yield* fileSystem.exists(path.join(integrationPath, "node_modules")));
        assert.isTrue(yield* fileSystem.exists(path.join(integrationPath, ".beads", "redirect")));
        const cleanIndex = harness.processRequests.findIndex(
          (request) => request.command === "git" && request.args[0] === "clean",
        );
        const mergeIndex = harness.processRequests.findIndex(
          (request) => request.command === "git" && request.args[0] === "merge",
        );
        assert.isAtLeast(cleanIndex, 0);
        assert.isAbove(mergeIndex, cleanIndex);
      }).pipe(Effect.provide(harness.layer));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("mirrors workspace dependencies past a dangling symlink in the repo root", () =>
    Effect.gen(function* () {
      // Regression: the scan stat'd every root entry and caught failures for
      // the whole directory, so one dangling symlink — this repo shipped a
      // committed `CLAUDE.md -> "AGENTS.md\n"` — hid every workspace package.
      // Nothing per-package was mirrored and the gate died on a missing
      // dependency that looked nothing like the cause.
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* makeTempWorkspace;
      yield* fileSystem.makeDirectory(path.join(root, ".beads"), { recursive: true });
      yield* fileSystem.makeDirectory(path.join(root, "node_modules"), { recursive: true });
      yield* fileSystem.makeDirectory(path.join(root, "packages", "lib", "node_modules"), {
        recursive: true,
      });
      yield* fileSystem.symlink("does-not-exist.md", path.join(root, "DANGLING.md"));

      // The provisioner is a fake, so stand the integration worktree up in its
      // own scoped temp dir, with the tracked package directory the mirror
      // needs to write into. A shared path would carry state between runs and
      // make this assertion pass on a leftover directory.
      const integrationPath = yield* makeTempWorkspace;
      yield* fileSystem.makeDirectory(path.join(integrationPath, "packages", "lib"), {
        recursive: true,
      });

      const harness = createHarness({
        workspaceRoot: root,
        integrationProvisionPath: integrationPath,
        readyChildren: ["child-1"],
        openChildren: [],
        separateWorkerHead: true,
        childEvidence: {
          "child-1": [{ title: "Build child", status: "closed", commentCount: 1 }],
        },
        script: [
          {
            text: 'RALPH_MSG: {"summary":"built child","why":"needed"}',
            head: "child-head",
            branchCommitCount: 1,
          },
        ],
      });

      yield* Effect.gen(function* () {
        const runner = yield* EpicRunner;
        const run = yield* runner.startRun({
          epicId: "epic-1",
          projectId,
          cwd: root,
          prompt: "do one unit of work",
          orientationFile: null,
          modelSelection,
          config: { parallel: { workers: 1 } },
          maxIterations: 10,
        });
        yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "done");

        // The package beside the broken link still gets its dependencies.
        assert.isTrue(
          yield* fileSystem.exists(path.join(integrationPath, "packages", "lib", "node_modules")),
        );
      }).pipe(Effect.provide(harness.layer));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("freezes a queued branch when the base moved before slot acquisition", () => {
    const runId = EpicRunId.make("run-external-base-move");
    const pausedRun: EpicRun = {
      runId,
      epicId: "epic-1",
      projectId,
      cwd: "/tmp/epic-runner-repo",
      prompt: "do one unit of work",
      orientationFile: null,
      modelSelection,
      runtimeMode: "full-access",
      ...defaultConfigSnapshot,
      originThreadId: null,
      status: "paused",
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
      createdAt: NOW,
      updatedAt: NOW,
    };
    const harness = createHarness({ script: [], seedRuns: [pausedRun], initialHead: "external" });
    harness.store.mergeStates.set(runId, {
      runId,
      initialHead: "base-0",
      lastAcceptedHead: "base-0",
      parkedCount: 0,
      repositoryPath: "/tmp/epic-runner-repo",
      baseBranch: "mine",
      integrationBranch: `cook-epic-integration-${runId}`,
      integrationWorktreePath: `${harness.worktreesDir}/epic-${runId}/integration`,
      operatorBaseBranch: null,
      siblings: [],
      entries: [
        {
          runId,
          sequence: 0,
          childId: "child-1",
          branch: "epic/child-1",
          status: "queued",
          reason: null,
          fixIssueId: null,
        },
      ],
    });

    return Effect.gen(function* () {
      const runner = yield* EpicRunner;
      yield* runner.resumeRun({ runId });
      yield* waitFor(() => harness.store.runs.get(runId)?.status === "failed");
      assert.strictEqual(harness.store.mergeStates.get(runId)?.entries[0]?.status, "queued");
      // The point is that the drain bailed before ACQUIRING the slot. The
      // drain also creates the slot up front, which is idempotent setup and
      // not an acquisition, so match on the subcommand.
      assert.isFalse(
        harness.processRequests.some(
          (request) =>
            request.command === "bd" &&
            request.args[0] === "merge-slot" &&
            request.args[1] === "acquire",
        ),
      );
      assert.include(
        harness.releasedWorktrees,
        `${harness.worktreesDir}/epic-${runId}/integration`,
      );
      assert.isTrue(harness.store.mergeStates.has(runId));
      assert.isTrue(
        harness.processRequests.some(
          (request) =>
            request.command === "git" &&
            request.args[0] === "branch" &&
            request.args.includes(`cook-epic-integration-${runId}`),
        ),
      );
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("resolves a nested beads redirect before writing the worker redirect", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* makeTempWorkspace;
      const canonicalBeads = path.join(root, "canonical-beads");
      const runCwd = path.join(root, "existing-worker");
      yield* fileSystem.makeDirectory(path.join(runCwd, ".beads"), { recursive: true });
      yield* fileSystem.makeDirectory(canonicalBeads, { recursive: true });
      yield* fileSystem.writeFileString(
        path.join(runCwd, ".beads", "redirect"),
        path.relative(runCwd, canonicalBeads),
      );
      const harness = createHarness({
        script: [{ text: "RALPH_DONE", head: "head-0" }],
        workspaceRoot: runCwd,
      });

      yield* Effect.gen(function* () {
        const runner = yield* EpicRunner;
        const run = yield* runner.startRun({
          epicId: "epic-1",
          projectId,
          cwd: runCwd,
          prompt: "Cook.",
          modelSelection,
          maxIterations: 1,
        });
        yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "done");
        const worktreePath = harness.commandsOfType("thread.create")[0]!.worktreePath!;
        const redirect = yield* fileSystem.readFileString(
          path.join(worktreePath, ".beads", "redirect"),
        );
        assert.strictEqual(path.resolve(worktreePath, redirect), canonicalBeads);
      }).pipe(Effect.provide(harness.layer));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live("classifies a branch commit when the worker HEAD read stays stale", () => {
    const harness = createHarness({
      script: [
        {
          text: 'RALPH_MSG: {"summary":"branch commit","why":"worker committed"}',
          head: "head-0",
          branchCommitCount: 1,
        },
        { text: "RALPH_DONE", head: "head-0" },
      ],
    });

    return Effect.gen(function* () {
      const run = yield* startRun();
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "done");
      assert.strictEqual(harness.store.iterations[0]?.turnStatus, "completed");
      assert.strictEqual(harness.store.iterations[0]?.summary, "branch commit");
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("keeps sequential HEAD movement as the commit signal", () => {
    const harness = createHarness({
      script: [
        {
          text: 'RALPH_MSG: {"summary":"sequential commit","why":"HEAD moved"}',
          head: "head-1",
        },
        { text: "RALPH_DONE", head: "head-1" },
      ],
      configFileResult: loadedConfigFile({ execution: { sequential: true } }),
    });

    return Effect.gen(function* () {
      const run = yield* startRun();
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "done");
      assert.strictEqual(harness.store.iterations[0]?.turnStatus, "completed");
      assert.strictEqual(harness.store.iterations[0]?.summary, "sequential commit");
      assert.isFalse(harness.processRequests.some((request) => request.args[0] === "rev-list"));
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("keeps a parallel iteration as no-commit when HEAD and branch stay unchanged", () => {
    const harness = createHarness({
      script: [
        {
          text: 'RALPH_MSG: {"summary":"claimed only","why":"no commit"}',
          head: "head-0",
          branchCommitCount: 0,
        },
      ],
      options: { maxNoCommitStreak: 1 },
    });

    return Effect.gen(function* () {
      const run = yield* startRun();
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "failed");
      assert.strictEqual(harness.store.iterations[0]?.failureReason, "child:no-commit-child-open");
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("keeps the base checkout as commit evidence across a child retry", () => {
    const harness = createHarness({
      readyOutput: '[{"id":"child-1","parent":"epic-1"}]',
      separateWorkerHead: true,
      script: [
        {
          text: "provider failed after committing",
          head: "branch-head-1",
          branchCommitCount: 1,
          turnState: "error",
          sessionStatus: "error",
          sessionLastError: "provider failed",
        },
        {
          text: 'RALPH_MSG: {"summary":"closed on retry","why":"the branch commit survived"}',
          head: "branch-head-1",
          branchCommitCount: 1,
        },
      ],
      options: { iterationTimeoutMs: 60_000 },
    });

    return Effect.gen(function* () {
      const runner = yield* EpicRunner;
      const run = yield* startRun();
      yield* waitFor(() => harness.store.iterations[1]?.turnStatus === "completed");
      assert.strictEqual(harness.store.iterations[0]?.turnStatus, "failed");
      assert.strictEqual(harness.store.iterations[1]?.turnStatus, "completed");
      assert.strictEqual(harness.store.iterations[1]?.summary, "closed on retry");
      if (harness.store.runs.get(run.runId)?.status === "running") {
        yield* runner.cancelRun({ runId: run.runId });
      }
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("runs the iteration in the run's cwd when it differs from the project root", () => {
    // Otherwise the agent would work in the project root while the commit
    // cross-check watched the run's cwd, and every iteration would read as
    // "no commit".
    const harness = createHarness({
      script: [{ text: "RALPH_DONE", head: "head-0" }],
      workspaceRoot: "/tmp/some-other-checkout",
      configFileResult: loadedConfigFile({ execution: { sequential: true } }),
    });

    return Effect.gen(function* () {
      const run = yield* startRun();
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "done");
      assert.strictEqual(
        harness.commandsOfType("thread.create")[0]?.worktreePath,
        "/tmp/epic-runner-repo",
      );
      assert.deepStrictEqual(harness.setupInputs, []);
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("refuses transitions that do not apply to the run's status", () => {
    const harness = createHarness({ script: [{ text: "RALPH_DONE", head: "head-0" }] });

    return Effect.gen(function* () {
      const runner = yield* EpicRunner;
      const run = yield* startRun();
      const exit = yield* Effect.exit(runner.resumeRun({ runId: run.runId }));
      assert.isTrue(Exit.isFailure(exit));
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("refuses to persist or fork a run when preflight is blocked", () => {
    let acquired = 0;
    const harness = createHarness({
      script: [],
      preflightResult: stubPreflightResult({
        ok: false,
        blockers: [
          { _tag: "detached_head" },
          {
            _tag: "config_invalid",
            configPath: "/repo/.t3code/epic-run.json",
            diagnostics: ['Invalid type\n  at ["parallel"]["workers"]'],
          },
        ],
      }),
      onLockAcquire: () => {
        acquired += 1;
      },
    });

    return Effect.gen(function* () {
      const error = yield* Effect.flip(startRun());
      assert.strictEqual(error._tag, "EpicRunPreflightBlockedError");
      if (error._tag === "EpicRunPreflightBlockedError") {
        assert.deepStrictEqual(error.blockers, [
          "The repository has a detached HEAD.",
          '/repo/.t3code/epic-run.json\nInvalid type\n  at ["parallel"]["workers"]',
        ]);
      }
      assert.strictEqual(harness.store.runs.size, 0);
      assert.strictEqual(acquired, 0);
      assert.strictEqual(harness.turnsStarted(), 0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("releases its lock when a run reaches a terminal state", () => {
    let acquired = 0;
    let released = 0;
    const harness = createHarness({
      script: [{ text: "RALPH_DONE", head: "head-0" }],
      onLockAcquire: () => {
        acquired += 1;
      },
      onLockRelease: () => {
        released += 1;
      },
    });

    return Effect.gen(function* () {
      const run = yield* startRun();
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "done");
      yield* waitFor(() => released === 1);
      assert.strictEqual(acquired, 1);
      assert.strictEqual(released, 1);
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("drains active leases when the runner layer scope closes", () => {
    let released = 0;
    const harness = createHarness({
      script: [{ text: "still working", head: "head-1" }],
      onLockRelease: () => {
        released += 1;
      },
    });

    return Effect.gen(function* () {
      yield* startRun().pipe(Effect.provide(harness.layer));
      assert.strictEqual(released, 1);
    });
  });
});
