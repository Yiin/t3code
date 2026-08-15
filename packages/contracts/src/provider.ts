import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import {
  ApprovalRequestId,
  EnvironmentId,
  EventId,
  IsoDateTime,
  ProjectId,
  ProviderItemId,
  ThreadId,
  TurnId,
} from "./baseSchemas.ts";
import { EpicSubagentMap } from "./epicSubagent.ts";
import {
  ChatAttachment,
  ModelSelection,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  ProviderApprovalDecision,
  ProviderApprovalPolicy,
  ProviderInteractionMode,
  ProviderRequestKind,
  ProviderSandboxMode,
  ProviderUserInputAnswers,
  RuntimeMode,
} from "./orchestration.ts";
import { ProviderInstanceId, ProviderDriverKind } from "./providerInstance.ts";

const ProviderSessionStatus = Schema.Literals([
  "connecting",
  "ready",
  "running",
  "error",
  "closed",
]);

/**
 * What the adapter says actually happened when a session opened.
 *
 * - `started`: no resume cursor was supplied, so the session is new by request.
 * - `resumed`: a cursor was supplied and the provider continued that
 *   conversation.
 * - `started-fresh`: a cursor was supplied but the provider minted an empty
 *   session. The prior conversation is gone — a data-loss event.
 * - `forked`: a cursor was supplied and the provider branched it into a new
 *   conversation that carries the old history.
 *
 * An absent origin means the adapter reported nothing. Treat that as unknown
 * and fail safe. Never infer `resumed` from the presence of a cursor: several
 * providers degrade a resume into a blank session and return a session that
 * looks identical.
 */
export const ProviderSessionOrigin = Schema.Literals([
  "started",
  "resumed",
  "started-fresh",
  "forked",
]);
export type ProviderSessionOrigin = typeof ProviderSessionOrigin.Type;

export const ProviderSession = Schema.Struct({
  provider: ProviderDriverKind,
  // Optional during the driver/instance migration. Once every producer
  // populates it (post-slice-4), routing flips to instance-id-only and the
  // legacy `provider` field is removed.
  providerInstanceId: Schema.optional(ProviderInstanceId),
  status: ProviderSessionStatus,
  runtimeMode: RuntimeMode,
  cwd: Schema.optional(TrimmedNonEmptyString),
  model: Schema.optional(TrimmedNonEmptyString),
  threadId: ThreadId,
  resumeCursor: Schema.optional(Schema.Unknown),
  // Optional so rows and test doubles written before adapters reported an
  // origin still decode. Absent is "unknown", never "resumed".
  sessionOrigin: Schema.optional(ProviderSessionOrigin),
  activeTurnId: Schema.optional(TurnId),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  lastError: Schema.optional(TrimmedNonEmptyString),
});
export type ProviderSession = typeof ProviderSession.Type;

/**
 * Server environment injected into agent spawns as `T3_*` env vars. Present
 * only when the session runs inside a t3code server; absent means "not inside
 * t3code / no injection".
 */
export const T3SessionEnvironment = Schema.Struct({
  serverUrl: TrimmedNonEmptyString,
  environmentId: EnvironmentId,
  projectId: ProjectId,
  workspaceRoot: TrimmedNonEmptyString,
  // The agent's own thread. A skill needs it to attribute work it starts back
  // to the thread it runs in — for example an epic run's `originThreadId`.
  threadId: ThreadId,
  token: TrimmedNonEmptyString,
});
export type T3SessionEnvironment = typeof T3SessionEnvironment.Type;

/**
 * A run-scoped git committer identity (t3code-e6l) stamped into an epic
 * worker's spawn environment as `GIT_COMMITTER_NAME` / `GIT_COMMITTER_EMAIL`.
 * Committer only, never author — the SDK/CLI's own author env, when it sets
 * any, is untouched, so authorship in a normal parallel commit stays the
 * user's own configured identity. This is what lets an in-place iteration
 * (a shared checkout, `ParallelEpicLoop`'s `iterationCommitted`) tell its own
 * worker's commit from an operator commit made during the same window.
 */
export const GitCommitterIdentity = Schema.Struct({
  name: TrimmedNonEmptyString,
  email: TrimmedNonEmptyString,
});
export type GitCommitterIdentity = typeof GitCommitterIdentity.Type;

/**
 * Systemd worker-scope binding for a session that runs as an epic-run worker.
 * The server attaches it at session start; adapters wrap the provider CLI
 * spawn in the named scope unit so worker load leaves the coordinator's
 * cgroup (see `packages/epic-core/src/workerScope.ts`).
 */
export const ProviderWorkerScopeBinding = Schema.Struct({
  scopeId: TrimmedNonEmptyString,
  worker: TrimmedNonEmptyString,
});
export type ProviderWorkerScopeBinding = typeof ProviderWorkerScopeBinding.Type;

/**
 * How much of a past conversation a thread can still get back.
 *
 * - `live`: the adapter still holds the session, so nothing has to be resumed.
 * - `cursor`: no live session, but a persisted cursor looks usable.
 * - `no`: nothing to resume from.
 */
export const ProviderSessionResumability = Schema.Literals(["live", "cursor", "no"]);
export type ProviderSessionResumability = typeof ProviderSessionResumability.Type;

/**
 * Why the verdict came out the way it did. One arm per check, so a caller can
 * tell "this provider cannot resume" from "nothing was persisted".
 */
export const ProviderSessionResumeReason = Schema.Literals([
  "live-session",
  "persisted-cursor",
  "no-binding",
  "no-cursor",
  "instance-not-configured",
  "instance-disabled",
  "resume-unsupported",
  "continuation-identity-changed",
]);
export type ProviderSessionResumeReason = typeof ProviderSessionResumeReason.Type;

/**
 * A read-only answer to "can this thread's session be picked up again?".
 *
 * Advisory and racy: the session it describes can die between the ask and the
 * act, so a caller must still handle a failed start.
 */
export const ProviderSessionResumeVerdict = Schema.Struct({
  threadId: ThreadId,
  resumable: ProviderSessionResumability,
  reason: ProviderSessionResumeReason,
  providerInstanceId: Schema.optional(ProviderInstanceId),
  provider: Schema.optional(ProviderDriverKind),
  /**
   * The cwd persisted with the binding, verbatim. The caller owns any
   * comparison against it: for a parallel epic run it is a per-iteration
   * worktree path, not the repo root.
   */
  cwd: Schema.optional(TrimmedNonEmptyString),
  lastSeenAt: Schema.optional(IsoDateTime),
});
export type ProviderSessionResumeVerdict = typeof ProviderSessionResumeVerdict.Type;

export const ProviderSessionStartInput = Schema.Struct({
  threadId: ThreadId,
  provider: Schema.optional(ProviderDriverKind),
  // See ProviderSession for the migration story.
  providerInstanceId: Schema.optional(ProviderInstanceId),
  cwd: Schema.optional(TrimmedNonEmptyString),
  modelSelection: Schema.optional(ModelSelection),
  resumeCursor: Schema.optional(Schema.Unknown),
  approvalPolicy: Schema.optional(ProviderApprovalPolicy),
  sandboxMode: Schema.optional(ProviderSandboxMode),
  runtimeMode: RuntimeMode,
  // Orchestration-supplied project context. ProviderService combines these with
  // the per-thread MCP session to build `t3Environment`; both are required for
  // injection to happen.
  projectId: Schema.optional(ProjectId),
  workspaceRoot: Schema.optional(TrimmedNonEmptyString),
  t3Environment: Schema.optional(T3SessionEnvironment),
  // Set by the epic runner for an iteration worker's session; carried
  // independently of `t3Environment` (optional per session, MCP-derived)
  // because the committer stamp must reach every driver's spawn env
  // unconditionally (t3code-e6l).
  gitCommitterIdentity: Schema.optional(GitCommitterIdentity),
  // Set by the server when the session belongs to an epic run with an active
  // worker scope; adapters route the provider CLI spawn through the scope.
  workerScope: Schema.optional(ProviderWorkerScopeBinding),
  // Per-role subagent definitions injected by the epic runner. `ProviderService`
  // resolves them from a thread-keyed registry at session start; they never
  // travel over the wire. Only Claude-family adapters can consume them.
  subagents: Schema.optional(EpicSubagentMap),
});
export type ProviderSessionStartInput = typeof ProviderSessionStartInput.Type;

export const ProviderSendTurnInput = Schema.Struct({
  threadId: ThreadId,
  input: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_INPUT_CHARS)),
  ),
  attachments: Schema.optional(
    Schema.Array(ChatAttachment).check(Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_ATTACHMENTS)),
  ),
  modelSelection: Schema.optional(ModelSelection),
  interactionMode: Schema.optional(ProviderInteractionMode),
});
export type ProviderSendTurnInput = typeof ProviderSendTurnInput.Type;

export const ProviderTurnStartResult = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  steeredIntoActiveTurn: Schema.optional(Schema.Boolean),
  resumeCursor: Schema.optional(Schema.Unknown),
});
export type ProviderTurnStartResult = typeof ProviderTurnStartResult.Type;

export const ProviderInterruptTurnInput = Schema.Struct({
  threadId: ThreadId,
  turnId: Schema.optional(TurnId),
});
export type ProviderInterruptTurnInput = typeof ProviderInterruptTurnInput.Type;

export const ProviderStopSessionInput = Schema.Struct({
  threadId: ThreadId,
});
export type ProviderStopSessionInput = typeof ProviderStopSessionInput.Type;

export const ProviderRespondToRequestInput = Schema.Struct({
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  decision: ProviderApprovalDecision,
});
export type ProviderRespondToRequestInput = typeof ProviderRespondToRequestInput.Type;

export const ProviderRespondToUserInputInput = Schema.Struct({
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  answers: ProviderUserInputAnswers,
});
export type ProviderRespondToUserInputInput = typeof ProviderRespondToUserInputInput.Type;

const ProviderEventKind = Schema.Literals(["session", "notification", "request", "error"]);

export const ProviderEvent = Schema.Struct({
  id: EventId,
  kind: ProviderEventKind,
  provider: ProviderDriverKind,
  // See ProviderSession for the migration story.
  providerInstanceId: Schema.optional(ProviderInstanceId),
  threadId: ThreadId,
  createdAt: IsoDateTime,
  method: TrimmedNonEmptyString,
  message: Schema.optional(TrimmedNonEmptyString),
  turnId: Schema.optional(TurnId),
  itemId: Schema.optional(ProviderItemId),
  requestId: Schema.optional(ApprovalRequestId),
  requestKind: Schema.optional(ProviderRequestKind),
  textDelta: Schema.optional(Schema.String),
  payload: Schema.optional(Schema.Unknown),
});
export type ProviderEvent = typeof ProviderEvent.Type;
