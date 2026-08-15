/**
 * ProviderServiceLive - Cross-provider orchestration layer.
 *
 * Routes validated transport/API calls to provider adapters through
 * `ProviderAdapterRegistry` and `ProviderSessionDirectory`, and exposes a
 * unified provider event stream for subscribers.
 *
 * It does not implement provider protocol details (adapter concern).
 *
 * @module ProviderServiceLive
 */
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EventId,
  ModelSelection,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TurnId,
  ProviderInterruptTurnInput,
  ProviderRespondToRequestInput,
  ProviderRespondToUserInputInput,
  ProviderSendTurnInput,
  ProviderSessionStartInput,
  ProviderStopSessionInput,
  type AuthSessionId,
  type EpicSubagentMap,
  type GitCommitterIdentity,
  type ProviderInstanceId,
  type ProviderDriverKind,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderSessionResumeVerdict,
  type T3SessionEnvironment,
} from "@t3tools/contracts";
import {
  maxLiveUtilizationByInstance,
  resolveEpicSubagents,
} from "@t3tools/epic-core/epicSubagents";
import { causeErrorTag } from "@t3tools/shared/observability";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import * as Stream from "effect/Stream";

import {
  increment,
  providerMetricAttributes,
  providerRuntimeEventsTotal,
  providerSessionsTotal,
  providerTurnDuration,
  providerTurnsTotal,
  providerTurnMetricAttributes,
  withMetrics,
} from "../../observability/Metrics.ts";
import { type ProviderAdapterError, ProviderValidationError } from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import type { ProviderContinuationIdentity } from "../ProviderDriver.ts";
import * as ProviderAdapterRegistry from "../Services/ProviderAdapterRegistry.ts";
import * as ProviderService from "../Services/ProviderService.ts";
import * as ProviderSessionDirectory from "../Services/ProviderSessionDirectory.ts";
import { type EventNdjsonLogger } from "./EventNdjsonLogger.ts";
import * as ProviderEventLoggers from "./ProviderEventLoggers.ts";
import { EpicSubagentRegistry } from "../epicSubagents.ts";
import { EpicCommitterRegistry } from "../epicCommitter.ts";
import { EpicWorkerScopeRegistry } from "../workerScope.ts";
import * as AnalyticsService from "../../telemetry/AnalyticsService.ts";
import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import * as McpSessionRegistry from "../../mcp/McpSessionRegistry.ts";
import {
  isSubagentChildThreadId,
  resolveSpawnPolicy,
} from "../../mcp/toolkits/agents/spawnPolicy.ts";
import { ProviderUsageLedgerStore } from "../../persistence/Services/ProviderUsageLedger.ts";
import { ProviderRegistry } from "../Services/ProviderRegistry.ts";
import * as ServerSettings from "../../serverSettings.ts";
const isModelSelection = Schema.is(ModelSelection);

/**
 * Hook for tests that want to override the canonical event logger pulled
 * from `ProviderEventLoggers`. Production wiring leaves this undefined and
 * reads the logger off the tag.
 */
export interface ProviderServiceLiveOptions {
  readonly canonicalEventLogger?: EventNdjsonLogger;
  /**
   * Detects an open turn whose provider stream stopped producing events.
   * Defaults: 30m idle, 30s sweep, 30s control-call timeout, and 60s grace.
   * Provider-specific thresholds override the 30m fallback.
   */
  readonly idleWatchdog?: ProviderIdleWatchdogOptions;
}

export interface ProviderIdleWatchdogOptions {
  readonly enabled?: boolean;
  readonly defaultIdleThresholdMs?: number;
  readonly idleThresholdMsByProvider?: Readonly<Record<string, number | undefined>>;
  readonly sweepIntervalMs?: number;
  readonly controlCallTimeoutMs?: number;
  readonly completionGraceMs?: number;
}

type ProviderServiceMethod<Name extends keyof ProviderService.ProviderService["Service"]> =
  ProviderService.ProviderService["Service"][Name];

/**
 * Minimum spacing between `binding.lastSeenAt` refreshes per thread. Runtime
 * event streams are chatty (per-token content deltas); one write a minute is
 * plenty for the reaper's idle-age resolution, whose thresholds are minutes
 * to hours.
 */
export const BINDING_LAST_SEEN_REFRESH_INTERVAL_MS = 60_000;
// Adapter research in t3code-8qw.9 found no guaranteed heartbeat. A 10-minute
// default can stop valid long tools, so all providers use 30 minutes until an
// adapter proves a shorter safe threshold through periodic progress events.
export const PROVIDER_IDLE_WATCHDOG_DEFAULT_THRESHOLD_MS = 30 * 60_000;
export const PROVIDER_IDLE_WATCHDOG_SWEEP_INTERVAL_MS = 30_000;
export const PROVIDER_IDLE_WATCHDOG_CONTROL_TIMEOUT_MS = 30_000;
export const PROVIDER_IDLE_WATCHDOG_COMPLETION_GRACE_MS = 60_000;

interface OpenTurnWatchdogState {
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly provider: ProviderDriverKind;
  readonly providerInstanceId: ProviderInstanceId;
  readonly adapter: ProviderAdapterShape<ProviderAdapterError>;
  lastEventAtMs: number;
  readonly openRequestIds: Set<string>;
  anonymousOpenRequests: number;
  sessionState: string | undefined;
  recoveryStarted: boolean;
}

const formatIdleDuration = (durationMs: number): string =>
  durationMs % 60_000 === 0 ? `${durationMs / 60_000}m` : `${durationMs}ms`;

const ProviderRollbackConversationInput = Schema.Struct({
  threadId: ThreadId,
  numTurns: NonNegativeInt,
});

function toValidationError(
  operation: string,
  issue: string,
  cause?: unknown,
): ProviderValidationError {
  return new ProviderValidationError({
    operation,
    issue,
    ...(cause !== undefined ? { cause } : {}),
  });
}

const decodeInputOrValidationError = <S extends Schema.Top>(input: {
  readonly operation: string;
  readonly schema: S;
  readonly payload: unknown;
}) => {
  const decodeProviderRequestInput = Schema.decodeUnknownEffect(input.schema);
  return decodeProviderRequestInput(input.payload).pipe(
    Effect.mapError(
      (schemaError) =>
        new ProviderValidationError({
          operation: input.operation,
          issue: SchemaIssue.makeFormatterDefault()(schemaError.issue),
          cause: schemaError,
        }),
    ),
  );
};

function toRuntimeStatus(session: ProviderSession): "starting" | "running" | "stopped" | "error" {
  switch (session.status) {
    case "connecting":
      return "starting";
    case "error":
      return "error";
    case "closed":
      return "stopped";
    case "ready":
    case "running":
    default:
      return "running";
  }
}

function toRuntimePayloadFromSession(
  session: ProviderSession,
  extra?: {
    readonly modelSelection?: unknown;
    readonly lastRuntimeEvent?: string;
    readonly lastRuntimeEventAt?: string;
    readonly t3EnvironmentContext?: T3EnvironmentContext;
    readonly continuationIdentity?: PersistedContinuationIdentity;
  },
): Record<string, unknown> {
  return {
    cwd: session.cwd ?? null,
    model: session.model ?? null,
    activeTurnId: session.activeTurnId ?? null,
    lastError: session.lastError ?? null,
    // Written as null when the adapter reported nothing. The directory merges
    // runtime payloads, so omitting the key would leave the previous session's
    // origin in place and make an unknown session read as a resumed one.
    sessionOrigin: session.sessionOrigin ?? null,
    ...(extra?.modelSelection !== undefined ? { modelSelection: extra.modelSelection } : {}),
    ...(extra?.lastRuntimeEvent !== undefined ? { lastRuntimeEvent: extra.lastRuntimeEvent } : {}),
    ...(extra?.lastRuntimeEventAt !== undefined
      ? { lastRuntimeEventAt: extra.lastRuntimeEventAt }
      : {}),
    ...(extra?.t3EnvironmentContext !== undefined
      ? { t3EnvironmentContext: extra.t3EnvironmentContext }
      : {}),
    ...(extra?.continuationIdentity !== undefined
      ? { continuationIdentity: extra.continuationIdentity }
      : {}),
  };
}

/** Recorded when an adapter reports no origin at all. */
const UNKNOWN_SESSION_ORIGIN = "unknown";

/** What the adapter said the session start did, or `unknown` if it said nothing. */
function sessionOriginLabel(session: ProviderSession): string {
  return session.sessionOrigin ?? UNKNOWN_SESSION_ORIGIN;
}

/**
 * A caller supplied a resume cursor and the provider answered with an empty
 * session. The previous turns are gone and nothing downstream can get them
 * back, so the loss has to be readable in the server log.
 */
function warnOnDiscardedConversation(input: {
  readonly operation: string;
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly session: ProviderSession;
  readonly requestedResume: boolean;
}): Effect.Effect<void> {
  if (!input.requestedResume || input.session.sessionOrigin !== "started-fresh") {
    return Effect.void;
  }
  return Effect.logWarning("provider.session.started-fresh", {
    operation: input.operation,
    threadId: input.threadId,
    provider: input.session.provider,
    providerInstanceId: input.providerInstanceId,
    detail:
      "A resume cursor was supplied but the provider started an empty session. The earlier conversation is lost.",
  });
}

interface T3EnvironmentContext {
  readonly projectId: ProjectId;
  readonly workspaceRoot: string;
}

function readPersistedT3EnvironmentContext(
  runtimePayload: ProviderSessionDirectory.ProviderRuntimeBinding["runtimePayload"],
): T3EnvironmentContext | undefined {
  if (!runtimePayload || typeof runtimePayload !== "object" || Array.isArray(runtimePayload)) {
    return undefined;
  }
  const raw =
    "t3EnvironmentContext" in runtimePayload ? runtimePayload.t3EnvironmentContext : undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const projectId = "projectId" in raw ? raw.projectId : undefined;
  const workspaceRoot = "workspaceRoot" in raw ? raw.workspaceRoot : undefined;
  if (typeof projectId !== "string" || projectId.trim().length === 0) {
    return undefined;
  }
  if (typeof workspaceRoot !== "string" || workspaceRoot.trim().length === 0) {
    return undefined;
  }
  return {
    projectId: ProjectId.make(projectId),
    workspaceRoot,
  };
}

/**
 * Which provider continuation domain a persisted resume cursor belongs to.
 *
 * `driverKind` is a plain string here on purpose: it is read back off disk and
 * a row written by an older build can carry anything.
 */
interface PersistedContinuationIdentity {
  readonly driverKind: string;
  readonly continuationKey: string;
}

/**
 * Read the continuation identity a past write left on the binding.
 *
 * Returns `undefined` for a legacy row that predates the field and for any
 * malformed payload. `undefined` means UNKNOWN, never "mismatch": a consumer
 * must not block a resume on it, because every binding written before this
 * field existed reads that way.
 */
function readPersistedContinuationIdentity(
  runtimePayload: ProviderSessionDirectory.ProviderRuntimeBinding["runtimePayload"],
): PersistedContinuationIdentity | undefined {
  if (!runtimePayload || typeof runtimePayload !== "object" || Array.isArray(runtimePayload)) {
    return undefined;
  }
  const raw =
    "continuationIdentity" in runtimePayload ? runtimePayload.continuationIdentity : undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const driverKind = "driverKind" in raw ? raw.driverKind : undefined;
  const continuationKey = "continuationKey" in raw ? raw.continuationKey : undefined;
  if (typeof driverKind !== "string" || driverKind.trim().length === 0) {
    return undefined;
  }
  if (typeof continuationKey !== "string" || continuationKey.trim().length === 0) {
    return undefined;
  }
  return { driverKind, continuationKey };
}

function readPersistedModelSelection(
  runtimePayload: ProviderSessionDirectory.ProviderRuntimeBinding["runtimePayload"],
): ModelSelection | undefined {
  if (!runtimePayload || typeof runtimePayload !== "object" || Array.isArray(runtimePayload)) {
    return undefined;
  }
  const raw = "modelSelection" in runtimePayload ? runtimePayload.modelSelection : undefined;
  return isModelSelection(raw) ? raw : undefined;
}

function readPersistedCwd(
  runtimePayload: ProviderSessionDirectory.ProviderRuntimeBinding["runtimePayload"],
): string | undefined {
  if (!runtimePayload || typeof runtimePayload !== "object" || Array.isArray(runtimePayload)) {
    return undefined;
  }
  const rawCwd = "cwd" in runtimePayload ? runtimePayload.cwd : undefined;
  if (typeof rawCwd !== "string") return undefined;
  const trimmed = rawCwd.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

const dieOnMissingBindingInstanceId = (
  operation: string,
  payload: {
    readonly providerInstanceId?: ProviderInstanceId | undefined;
    readonly provider?: ProviderDriverKind | undefined;
  },
): ProviderInstanceId => {
  if (payload.providerInstanceId !== undefined) {
    return payload.providerInstanceId;
  }
  throw new Error(
    payload.provider
      ? `${operation}: provider instance id is required for provider '${payload.provider}'.`
      : `${operation}: provider instance id is required.`,
  );
};

const correlateRuntimeEventWithInstance = (
  source: {
    readonly instanceId: ProviderInstanceId;
    readonly provider: ProviderDriverKind;
  },
  event: ProviderRuntimeEvent,
): ProviderRuntimeEvent => {
  if (event.provider !== source.provider) {
    throw new Error(
      `ProviderService.streamEvents: provider instance '${source.instanceId}' is backed by driver '${source.provider}' but emitted driver '${event.provider}'.`,
    );
  }
  if (event.providerInstanceId !== undefined && event.providerInstanceId !== source.instanceId) {
    throw new Error(
      `ProviderService.streamEvents: provider instance '${source.instanceId}' emitted event for instance '${event.providerInstanceId}'.`,
    );
  }
  return { ...event, providerInstanceId: source.instanceId };
};

const makeProviderService = Effect.fn("makeProviderService")(function* (
  options?: ProviderServiceLiveOptions,
) {
  const analytics = yield* Effect.service(AnalyticsService.AnalyticsService);
  const eventLoggers = yield* ProviderEventLoggers.ProviderEventLoggers;
  // Options-provided logger wins (test overrides); otherwise we take whatever
  // the `ProviderEventLoggers` tag exposes — `undefined` means "no canonical
  // log writer is attached", which downstream code already handles as a
  // no-op.
  const canonicalEventLogger = options?.canonicalEventLogger ?? eventLoggers.canonical;

  const registry = yield* ProviderAdapterRegistry.ProviderAdapterRegistry;
  const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
  const fileSystem = yield* FileSystem.FileSystem;
  const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
  const workerScopeRegistry = yield* EpicWorkerScopeRegistry;
  const subagentRegistry = yield* EpicSubagentRegistry;
  const committerRegistry = yield* EpicCommitterRegistry;
  // Optional on purpose: several test layers build the provider service without
  // settings, a provider snapshot registry, or a usage ledger, and none of the
  // three is worth a hard requirement when losing one only costs a session its
  // injected subagents.
  const serverSettings = yield* Effect.serviceOption(ServerSettings.ServerSettingsService);
  const providerRegistry = yield* Effect.serviceOption(ProviderRegistry);
  const providerUsageLedger = yield* Effect.serviceOption(ProviderUsageLedgerStore);
  const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

  /**
   * The subagent definitions one session starts with.
   *
   * An epic worker gets its map from `EpicSubagentRegistry`. Every other
   * session falls back to the same epic role policy, so a thread a user types
   * `/plan-epic` or `/cook-it` in carries the stage agents a worker carries.
   * Every failure is fail-soft: an unreadable setting costs a session its
   * injected agents, never its start.
   *
   * Two sessions are left out of the fallback, and only the fallback — a
   * runner binding always wins, because a worker needs its stage agents
   * whatever else is configured:
   *
   * 1. A `spawn_agent` child thread. `resolveSubagentSpawnMode`
   *    (`../subagentSpawn.ts`) answers "in-process" for any session that ships
   *    definitions BEFORE it reaches the child-thread check, so injecting here
   *    would hand a child back the built-in delegation tool and defeat the
   *    depth cap.
   * 2. A session whose user turned thread-backed spawning on. Definitions force
   *    in-process mode by design (t3code-pg7.13), so injecting into every
   *    session would silently switch that opt-in back off.
   */
  const resolveSessionSubagents = (input: {
    readonly threadId: ThreadId;
    readonly sessionInstanceId: ProviderInstanceId | undefined;
  }): Effect.Effect<Option.Option<EpicSubagentMap>> =>
    Effect.gen(function* () {
      const bound = yield* subagentRegistry.resolve(input.threadId);
      if (Option.isSome(bound)) return bound;
      if (isSubagentChildThreadId(input.threadId)) return Option.none();
      if (Option.isNone(serverSettings)) return Option.none();
      const settings = yield* serverSettings.value.getSettings;
      if (resolveSpawnPolicy(settings.subagentSpawn).enabled) return Option.none();
      const policy = settings.epicRolePolicy;
      if (Object.keys(policy.inSessionRoles).length === 0) return Option.none();
      const providers = Option.isNone(providerRegistry)
        ? []
        : yield* providerRegistry.value.getProviders;
      const samples = Option.isNone(providerUsageLedger)
        ? []
        : yield* providerUsageLedger.value.listAll;
      const utilization = maxLiveUtilizationByInstance(samples, yield* nowIso);
      const subagents = resolveEpicSubagents({
        policy,
        providers,
        ...(input.sessionInstanceId === undefined
          ? {}
          : { sessionInstanceId: input.sessionInstanceId }),
        utilization: (instanceId) => utilization.get(instanceId) ?? null,
      });
      return Object.keys(subagents).length === 0 ? Option.none() : Option.some(subagents);
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("provider.session.subagent-resolution-failed", {
          threadId: input.threadId,
          cause,
        }).pipe(Effect.as(Option.none<EpicSubagentMap>())),
      ),
    );

  /**
   * The run-scoped git committer identity an epic worker's session stamps
   * into its spawn env (t3code-e6l). `None` off an epic worker — no run ever
   * bound this thread — and an unreadable registry falls back the same way:
   * this must never block a session start.
   */
  const resolveSessionCommitterIdentity = (
    threadId: ThreadId,
  ): Effect.Effect<Option.Option<GitCommitterIdentity>> =>
    committerRegistry.resolve(threadId).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("provider.session.committer-resolution-failed", {
          threadId,
          cause,
        }).pipe(Effect.as(Option.none<GitCommitterIdentity>())),
      ),
    );

  // Auth sessions minted for `t3Environment` injection, keyed by thread so the
  // token is revoked when the thread's MCP session is cleared.
  const t3EnvironmentAuthSessions = new Map<ThreadId, AuthSessionId>();
  const prepareMcpSession = (
    threadId: ThreadId,
    providerInstanceId: ProviderInstanceId,
    providerDriver: ProviderDriverKind,
  ) =>
    McpSessionRegistry.issueActiveMcpCredential({
      threadId,
      providerInstanceId,
      providerDriver,
    }).pipe(
      Effect.tap((credential) =>
        credential
          ? Effect.sync(() => McpProviderSession.setMcpProviderSession(credential.config))
          : Effect.void,
      ),
    );
  const revokeT3EnvironmentAuthSession = (threadId: ThreadId) =>
    Effect.suspend((): Effect.Effect<void> => {
      const sessionId = t3EnvironmentAuthSessions.get(threadId);
      if (sessionId === undefined) {
        return Effect.void;
      }
      t3EnvironmentAuthSessions.delete(threadId);
      return environmentAuth.revokeSession(sessionId).pipe(
        Effect.tap((revoked) =>
          revoked
            ? Effect.void
            : Effect.logDebug("provider.session.t3-env-token-already-gone", { threadId }),
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning("provider.session.t3-env-token-revoke-failed", { threadId, cause }),
        ),
        Effect.asVoid,
      );
    });
  const clearMcpSession = (threadId: ThreadId) =>
    McpSessionRegistry.revokeActiveMcpThread(threadId).pipe(
      Effect.tap(() => Effect.sync(() => McpProviderSession.clearMcpProviderSession(threadId))),
      Effect.tap(() => revokeT3EnvironmentAuthSession(threadId)),
    );

  /**
   * Builds the `T3_*` injection payload for a session start. Requires both a
   * live MCP session for the thread (the agent only spawns inside t3code when
   * one exists) and project context from the orchestration layer; otherwise
   * returns `undefined` and no token is minted.
   */
  const resolveT3SessionEnvironment = (input: {
    readonly threadId: ThreadId;
    readonly projectId?: ProjectId | undefined;
    readonly workspaceRoot?: string | undefined;
  }): Effect.Effect<T3SessionEnvironment | undefined> =>
    Effect.gen(function* () {
      if (input.projectId === undefined || input.workspaceRoot === undefined) {
        return undefined;
      }
      const mcpSession = McpProviderSession.readMcpProviderSession(input.threadId);
      if (mcpSession === undefined) {
        return undefined;
      }
      // A re-start of the same thread mints a fresh token; drop the old one so
      // tokens do not accumulate.
      yield* revokeT3EnvironmentAuthSession(input.threadId);
      // Fail open: an auth-store error must not kill the session start. The
      // agent still works; it just gets no t3code API access.
      const issued = yield* environmentAuth
        .issueSession({
          scopes: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
          label: `agent-thread-${input.threadId}`,
        })
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning("provider.session.t3-env-token-mint-failed", {
              threadId: input.threadId,
              error,
            }).pipe(Effect.as(undefined)),
          ),
        );
      if (issued === undefined) {
        return undefined;
      }
      t3EnvironmentAuthSessions.set(input.threadId, issued.sessionId);
      return {
        serverUrl: mcpSession.endpoint.replace(/\/mcp$/, ""),
        environmentId: mcpSession.environmentId,
        projectId: input.projectId,
        workspaceRoot: input.workspaceRoot,
        threadId: input.threadId,
        token: issued.token,
      } satisfies T3SessionEnvironment;
    });

  // Threads touched recently enough that another lastSeenAt write would be
  // redundant. Entries are dropped on stopSession/stopAll; a stale survivor
  // only suppresses touches for one interval, so precision is not required.
  const bindingLastSeenTouchedAtMs = new Map<ThreadId, number>();
  const openTurnWatchdogs = new Map<ThreadId, OpenTurnWatchdogState>();
  const syntheticSettledTurns = new Map<ThreadId, TurnId>();
  const idleWatchdogOptions = options?.idleWatchdog;
  const idleWatchdogEnabled = idleWatchdogOptions?.enabled ?? true;
  const idleWatchdogDefaultThresholdMs =
    idleWatchdogOptions?.defaultIdleThresholdMs ?? PROVIDER_IDLE_WATCHDOG_DEFAULT_THRESHOLD_MS;
  const idleWatchdogSweepIntervalMs =
    idleWatchdogOptions?.sweepIntervalMs ?? PROVIDER_IDLE_WATCHDOG_SWEEP_INTERVAL_MS;
  const idleWatchdogControlTimeoutMs =
    idleWatchdogOptions?.controlCallTimeoutMs ?? PROVIDER_IDLE_WATCHDOG_CONTROL_TIMEOUT_MS;
  const idleWatchdogCompletionGraceMs =
    idleWatchdogOptions?.completionGraceMs ?? PROVIDER_IDLE_WATCHDOG_COMPLETION_GRACE_MS;

  // Keeps `binding.lastSeenAt` tracking observed runtime output — message
  // deltas, tool progress, subagent task.progress — so the reaper's idle age
  // means "time since the session last produced anything", not "time since
  // the turn was submitted". Throttled per thread; never fails the event path.
  const touchBindingLastSeen = (threadId: ThreadId): Effect.Effect<void> =>
    Clock.currentTimeMillis.pipe(
      Effect.flatMap((nowMs) => {
        const touchedAtMs = bindingLastSeenTouchedAtMs.get(threadId);
        if (
          touchedAtMs !== undefined &&
          nowMs - touchedAtMs < BINDING_LAST_SEEN_REFRESH_INTERVAL_MS
        ) {
          return Effect.void;
        }
        bindingLastSeenTouchedAtMs.set(threadId, nowMs);
        return directory.touchLastSeen(threadId).pipe(
          Effect.catch((error) =>
            Effect.logWarning("provider.session.last-seen-touch-failed", {
              threadId,
              error,
            }),
          ),
        );
      }),
    );

  const publishRuntimeEvent = (event: ProviderRuntimeEvent): Effect.Effect<void> =>
    Effect.succeed(event).pipe(
      Effect.tap((canonicalEvent) =>
        canonicalEventLogger
          ? canonicalEventLogger.write(canonicalEvent, canonicalEvent.threadId)
          : Effect.void,
      ),
      Effect.flatMap((canonicalEvent) => PubSub.publish(runtimeEventPubSub, canonicalEvent)),
      Effect.asVoid,
    );

  const publishObservedRuntimeEvent = (event: ProviderRuntimeEvent): Effect.Effect<void> =>
    increment(providerRuntimeEventsTotal, {
      provider: event.provider,
      eventType: event.type,
    }).pipe(
      Effect.andThen(publishRuntimeEvent(event)),
      Effect.andThen(touchBindingLastSeen(event.threadId)),
    );

  const requireBindingInstanceId = (
    operation: string,
    payload: {
      readonly providerInstanceId?: ProviderInstanceId | undefined;
      readonly provider?: ProviderDriverKind | undefined;
    },
  ): Effect.Effect<ProviderInstanceId, ProviderValidationError> =>
    payload.providerInstanceId !== undefined
      ? Effect.succeed(payload.providerInstanceId)
      : Effect.fail(
          toValidationError(
            operation,
            payload.provider
              ? `Provider instance id is required for provider '${payload.provider}'.`
              : "Provider instance id is required.",
          ),
        );

  const upsertSessionBinding = (
    session: ProviderSession,
    threadId: ThreadId,
    extra?: {
      readonly modelSelection?: unknown;
      readonly lastRuntimeEvent?: string;
      readonly lastRuntimeEventAt?: string;
      readonly t3EnvironmentContext?: T3EnvironmentContext;
      readonly continuationIdentity?: PersistedContinuationIdentity;
    },
  ) =>
    Effect.gen(function* () {
      const providerInstanceId = yield* requireBindingInstanceId(
        "ProviderService.upsertSessionBinding",
        session,
      );
      yield* directory.upsert({
        threadId,
        provider: session.provider,
        providerInstanceId,
        runtimeMode: session.runtimeMode,
        status: toRuntimeStatus(session),
        ...(session.resumeCursor !== undefined ? { resumeCursor: session.resumeCursor } : {}),
        runtimePayload: toRuntimePayloadFromSession(session, extra),
      });
    });

  const processRuntimeEvent = (
    source: {
      readonly instanceId: ProviderInstanceId;
      readonly provider: ProviderDriverKind;
      readonly adapter: ProviderAdapterShape<ProviderAdapterError>;
    },
    event: ProviderRuntimeEvent,
  ): Effect.Effect<void> =>
    Effect.sync(() => correlateRuntimeEventWithInstance(source, event)).pipe(
      Effect.flatMap((canonicalEvent) =>
        Clock.currentTimeMillis.pipe(
          Effect.map((nowMs) => {
            const threadId = canonicalEvent.threadId;
            const tracked = openTurnWatchdogs.get(threadId);
            const syntheticTurnId = syntheticSettledTurns.get(threadId);

            if (
              canonicalEvent.type === "turn.completed" &&
              canonicalEvent.turnId !== undefined &&
              syntheticTurnId === canonicalEvent.turnId
            ) {
              return false;
            }

            if (canonicalEvent.type === "session.started") {
              openTurnWatchdogs.delete(threadId);
              syntheticSettledTurns.delete(threadId);
              return true;
            }

            if (canonicalEvent.type === "session.exited") {
              if (tracked === undefined || tracked.adapter === source.adapter) {
                openTurnWatchdogs.delete(threadId);
              }
              return true;
            }

            if (canonicalEvent.type === "turn.started") {
              if (canonicalEvent.turnId === undefined) {
                return true;
              }
              if (tracked !== undefined && tracked.adapter !== source.adapter) {
                return true;
              }
              syntheticSettledTurns.delete(threadId);
              openTurnWatchdogs.set(threadId, {
                threadId,
                turnId: canonicalEvent.turnId,
                provider: canonicalEvent.provider,
                providerInstanceId: source.instanceId,
                adapter: source.adapter,
                lastEventAtMs: nowMs,
                openRequestIds: new Set(),
                anonymousOpenRequests: 0,
                sessionState: undefined,
                recoveryStarted: false,
              });
              return true;
            }

            if (tracked === undefined || tracked.adapter !== source.adapter) {
              return true;
            }
            if (canonicalEvent.turnId !== undefined && canonicalEvent.turnId !== tracked.turnId) {
              return true;
            }

            tracked.lastEventAtMs = nowMs;
            if (canonicalEvent.type === "turn.completed") {
              if (canonicalEvent.turnId === tracked.turnId) {
                openTurnWatchdogs.delete(threadId);
              }
              return true;
            }
            if (canonicalEvent.type === "request.opened") {
              if (canonicalEvent.requestId === undefined) {
                tracked.anonymousOpenRequests += 1;
              } else {
                tracked.openRequestIds.add(String(canonicalEvent.requestId));
              }
            } else if (canonicalEvent.type === "user-input.requested") {
              if (canonicalEvent.requestId === undefined) {
                tracked.anonymousOpenRequests += 1;
              } else {
                tracked.openRequestIds.add(String(canonicalEvent.requestId));
              }
            } else if (
              canonicalEvent.type === "request.resolved" ||
              canonicalEvent.type === "user-input.resolved"
            ) {
              if (canonicalEvent.requestId === undefined) {
                tracked.anonymousOpenRequests = Math.max(0, tracked.anonymousOpenRequests - 1);
              } else {
                tracked.openRequestIds.delete(String(canonicalEvent.requestId));
              }
            } else if (canonicalEvent.type === "session.state.changed") {
              tracked.sessionState = canonicalEvent.payload.state;
            }
            return true;
          }),
          Effect.flatMap((shouldPublish) =>
            shouldPublish ? publishObservedRuntimeEvent(canonicalEvent) : Effect.void,
          ),
        ),
      ),
    );

  const recoverIdleTurn = Effect.fn("ProviderService.recoverIdleTurn")(function* (
    tracked: OpenTurnWatchdogState,
    idleDurationMs: number,
  ) {
    const idleDuration = formatIdleDuration(idleDurationMs);
    const message = `provider stream idle for ${idleDuration} during an open turn`;
    const eventIdPrefix = `provider-idle-watchdog:${String(tracked.threadId)}:${String(tracked.turnId)}`;
    const runtimeErrorEvent: ProviderRuntimeEvent = {
      type: "runtime.error",
      eventId: EventId.make(`${eventIdPrefix}:error`),
      provider: tracked.provider,
      providerInstanceId: tracked.providerInstanceId,
      threadId: tracked.threadId,
      turnId: tracked.turnId,
      createdAt: yield* nowIso,
      payload: {
        message: `${message}: thread ${String(tracked.threadId)}, turn ${String(tracked.turnId)}, provider ${String(tracked.provider)}`,
        detail: {
          idleDurationMs,
          provider: tracked.provider,
          providerInstanceId: tracked.providerInstanceId,
          threadId: tracked.threadId,
          turnId: tracked.turnId,
        },
      },
    };
    yield* publishObservedRuntimeEvent(runtimeErrorEvent).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("provider.idle-watchdog.error-publish-failed", {
          threadId: tracked.threadId,
          turnId: tracked.turnId,
          cause,
        }),
      ),
    );
    yield* tracked.adapter.interruptTurn(tracked.threadId, tracked.turnId).pipe(
      Effect.timeout(`${idleWatchdogControlTimeoutMs} millis`),
      Effect.catchCause((cause) =>
        Effect.logWarning("provider.idle-watchdog.interrupt-failed", {
          threadId: tracked.threadId,
          turnId: tracked.turnId,
          cause,
        }),
      ),
    );
    yield* Effect.sleep(`${idleWatchdogCompletionGraceMs} millis`);

    if (openTurnWatchdogs.get(tracked.threadId) !== tracked) {
      return;
    }

    syntheticSettledTurns.set(tracked.threadId, tracked.turnId);
    yield* tracked.adapter.stopSession(tracked.threadId).pipe(
      Effect.timeout(`${idleWatchdogControlTimeoutMs} millis`),
      Effect.catchCause((cause) =>
        Effect.logWarning("provider.idle-watchdog.stop-failed", {
          threadId: tracked.threadId,
          turnId: tracked.turnId,
          cause,
        }),
      ),
    );
    yield* clearMcpSession(tracked.threadId).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("provider.idle-watchdog.mcp-cleanup-failed", {
          threadId: tracked.threadId,
          turnId: tracked.turnId,
          cause,
        }),
      ),
    );

    if (syntheticSettledTurns.get(tracked.threadId) !== tracked.turnId) {
      return;
    }

    if (openTurnWatchdogs.get(tracked.threadId) === tracked) {
      openTurnWatchdogs.delete(tracked.threadId);
    }
    bindingLastSeenTouchedAtMs.delete(tracked.threadId);
    const completedEvent: ProviderRuntimeEvent = {
      type: "turn.completed",
      eventId: EventId.make(`${eventIdPrefix}:completed`),
      provider: tracked.provider,
      providerInstanceId: tracked.providerInstanceId,
      threadId: tracked.threadId,
      turnId: tracked.turnId,
      createdAt: yield* nowIso,
      payload: {
        state: "failed",
        errorMessage: message,
      },
    };
    yield* publishObservedRuntimeEvent(completedEvent);
  });

  const sweepIdleTurns = Effect.fn("ProviderService.sweepIdleTurns")(function* () {
    const nowMs = yield* Clock.currentTimeMillis;
    for (const tracked of openTurnWatchdogs.values()) {
      const idleThresholdMs =
        idleWatchdogOptions?.idleThresholdMsByProvider?.[String(tracked.provider)] ??
        idleWatchdogDefaultThresholdMs;
      const idleDurationMs = nowMs - tracked.lastEventAtMs;
      if (
        tracked.recoveryStarted ||
        idleDurationMs < idleThresholdMs ||
        tracked.openRequestIds.size > 0 ||
        tracked.anonymousOpenRequests > 0 ||
        tracked.sessionState === "waiting"
      ) {
        continue;
      }
      tracked.recoveryStarted = true;
      yield* recoverIdleTurn(tracked, idleDurationMs).pipe(Effect.forkScoped);
    }
  });

  // `subscribedAdapters` is our source-of-truth for "which instance adapters
  // are currently wired into the runtime event bus". It both tracks the set
  // of live subscriptions (so `reconcileInstanceSubscriptions` can diff and
  // fork only the *new* or *rebuilt* ones) and serves as the dynamic adapter
  // list consumed by `stopStaleSessionsForThread`, `listSessions`, and
  // `runStopAll` — replacing the pre-Slice-D startup snapshot so hot-added
  // instances become visible to those call sites as soon as settings edits
  // land.
  const subscribedAdapters = yield* Ref.make(
    new Map<ProviderInstanceId, ProviderAdapterShape<ProviderAdapterError>>(),
  );

  const getAdapterEntries = Ref.get(subscribedAdapters).pipe(
    Effect.map((map) => Array.from(map.entries())),
  );

  // Rebuild the map of id → adapter from the registry and fork a new event
  // subscription for every instance that is either brand new or whose adapter
  // identity changed (indicating the underlying `ProviderInstance` was torn
  // down and rebuilt by `ProviderInstanceRegistry.reconcile`). Orphaned
  // fibers for removed/replaced instances exit on their own because their
  // adapter's `streamEvents` source terminates when the old scope closes.
  const reconcileInstanceSubscriptions = Effect.gen(function* () {
    const previous = yield* Ref.get(subscribedAdapters);
    const currentIds = yield* registry.listInstances();
    const next = new Map<ProviderInstanceId, ProviderAdapterShape<ProviderAdapterError>>();
    for (const id of currentIds) {
      const adapterOption = yield* registry
        .getByInstance(id)
        .pipe(Effect.tapError(Effect.logWarning), Effect.option);
      if (Option.isNone(adapterOption)) continue;
      const adapter = adapterOption.value;
      next.set(id, adapter);
      if (previous.get(id) !== adapter) {
        yield* Stream.runForEach(adapter.streamEvents, (event) =>
          processRuntimeEvent(
            {
              instanceId: id,
              provider: adapter.provider,
              adapter,
            },
            event,
          ),
        ).pipe(Effect.forkScoped);
      }
    }
    yield* Ref.set(subscribedAdapters, next);
  });

  const instanceChanges = yield* registry.subscribeChanges;
  yield* reconcileInstanceSubscriptions;
  yield* Stream.runForEach(
    Stream.fromSubscription(instanceChanges),
    () => reconcileInstanceSubscriptions,
  ).pipe(Effect.forkScoped);
  if (idleWatchdogEnabled) {
    yield* Effect.forever(
      Effect.sleep(`${idleWatchdogSweepIntervalMs} millis`).pipe(Effect.andThen(sweepIdleTurns)),
    ).pipe(Effect.forkScoped);
  }

  const pathExists = (path: string): Effect.Effect<boolean> =>
    fileSystem.exists(path).pipe(Effect.orElseSucceed(() => false));

  /**
   * Resolves the working directory for a session restart that reuses a
   * persisted cwd.
   *
   * A thread outlives the directory it ran in: an epic worker gets a throwaway
   * worktree that the runner deletes once the child lands. Restarting into that
   * deleted path makes the provider spawn fail with a bare ENOENT, which the
   * adapter reports as an opaque "runtime stream failed". Check the path first
   * and fall back to the workspace root so the thread stays usable.
   */
  const resolvePersistedCwd = Effect.fn("ProviderService.resolvePersistedCwd")(function* (input: {
    readonly operation: string;
    readonly threadId: ThreadId;
    readonly provider: ProviderDriverKind;
    readonly providerInstanceId: ProviderInstanceId;
    readonly persistedCwd: string | undefined;
    readonly fallbackCwd: string | undefined;
  }) {
    const { persistedCwd, fallbackCwd } = input;
    if (persistedCwd === undefined || (yield* pathExists(persistedCwd))) {
      return persistedCwd;
    }
    if (
      fallbackCwd === undefined ||
      fallbackCwd === persistedCwd ||
      !(yield* pathExists(fallbackCwd))
    ) {
      return yield* toValidationError(
        input.operation,
        `Cannot restart thread '${String(input.threadId)}': its working directory '${persistedCwd}' no longer exists and no workspace root is available to fall back to.`,
      );
    }
    const message = `Working directory '${persistedCwd}' no longer exists; continuing in '${fallbackCwd}'.`;
    const createdAt = yield* nowIso;
    yield* publishRuntimeEvent({
      type: "runtime.warning",
      // Timestamped: one thread can fall back on every restart, and a repeated
      // event id would let a consumer dedupe the later warnings away.
      eventId: EventId.make(`provider-cwd-fallback:${String(input.threadId)}:${createdAt}`),
      provider: input.provider,
      providerInstanceId: input.providerInstanceId,
      threadId: input.threadId,
      createdAt,
      payload: {
        message,
        detail: { missingCwd: persistedCwd, fallbackCwd },
      },
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("provider.session.cwd-fallback-publish-failed", {
          threadId: input.threadId,
          cause,
        }),
      ),
    );
    yield* Effect.logWarning("provider.session.cwd-fallback", {
      threadId: input.threadId,
      missingCwd: persistedCwd,
      fallbackCwd,
    });
    return fallbackCwd;
  });

  const recoverSessionForThread = Effect.fn("recoverSessionForThread")(function* (input: {
    readonly binding: ProviderSessionDirectory.ProviderRuntimeBinding;
    readonly operation: string;
  }) {
    const bindingInstanceId = yield* requireBindingInstanceId(input.operation, input.binding);
    yield* Effect.annotateCurrentSpan({
      "provider.operation": "recover-session",
      "provider.kind": input.binding.provider,
      "provider.instance_id": bindingInstanceId,
      "provider.thread_id": input.binding.threadId,
    });
    return yield* Effect.gen(function* () {
      const adapter = yield* registry.getByInstance(bindingInstanceId);
      const hasResumeCursor =
        input.binding.resumeCursor !== null && input.binding.resumeCursor !== undefined;
      const hasActiveSession = yield* adapter.hasSession(input.binding.threadId);
      if (hasActiveSession) {
        const activeSessions = yield* adapter.listSessions();
        const existing = activeSessions.find(
          (session) => session.threadId === input.binding.threadId,
        );
        if (existing) {
          yield* upsertSessionBinding(
            { ...existing, providerInstanceId: bindingInstanceId },
            input.binding.threadId,
          );
          yield* analytics.record("provider.session.recovered", {
            provider: existing.provider,
            // What the session actually is, not what the caller wanted. The
            // path that produced it is a separate field.
            strategy: sessionOriginLabel(existing),
            recovery: "adopt-existing",
            hasResumeCursor: existing.resumeCursor !== undefined,
          });
          return { adapter, session: existing } as const;
        }
      }

      // Adopting a session the adapter still holds is not a resume, so it stays
      // available to every provider. Everything past this point restarts the
      // conversation from a persisted cursor, which an adapter has to declare
      // it can honour. Answer "this provider cannot resume" before "no state is
      // persisted", so a caller that sees the cursor complaint knows the cursor
      // is the only thing missing.
      if (adapter.capabilities.sessionLifecycle.resume === "unsupported") {
        return yield* toValidationError(
          input.operation,
          `Cannot recover thread '${input.binding.threadId}' because provider '${input.binding.provider}' does not support resuming a session.`,
        );
      }

      if (!hasResumeCursor) {
        return yield* toValidationError(
          input.operation,
          `Cannot recover thread '${input.binding.threadId}' because no provider resume state is persisted.`,
        );
      }

      const persistedModelSelection = readPersistedModelSelection(input.binding.runtimePayload);
      const persistedT3EnvironmentContext = readPersistedT3EnvironmentContext(
        input.binding.runtimePayload,
      );
      const persistedCwd = yield* resolvePersistedCwd({
        operation: input.operation,
        threadId: input.binding.threadId,
        provider: input.binding.provider,
        providerInstanceId: bindingInstanceId,
        persistedCwd: readPersistedCwd(input.binding.runtimePayload),
        fallbackCwd: persistedT3EnvironmentContext?.workspaceRoot,
      });

      yield* prepareMcpSession(input.binding.threadId, bindingInstanceId, input.binding.provider);
      const t3Environment = yield* resolveT3SessionEnvironment({
        threadId: input.binding.threadId,
        projectId: persistedT3EnvironmentContext?.projectId,
        workspaceRoot: persistedT3EnvironmentContext?.workspaceRoot,
      });
      const workerScope = yield* workerScopeRegistry.resolve(input.binding.threadId);
      const subagents = yield* resolveSessionSubagents({
        threadId: input.binding.threadId,
        sessionInstanceId: persistedModelSelection?.instanceId ?? bindingInstanceId,
      });
      const gitCommitterIdentity = yield* resolveSessionCommitterIdentity(input.binding.threadId);
      const resumed = yield* adapter
        .startSession({
          threadId: input.binding.threadId,
          provider: input.binding.provider,
          providerInstanceId: bindingInstanceId,
          ...(persistedCwd ? { cwd: persistedCwd } : {}),
          ...(persistedModelSelection ? { modelSelection: persistedModelSelection } : {}),
          ...(hasResumeCursor ? { resumeCursor: input.binding.resumeCursor } : {}),
          ...(t3Environment !== undefined ? { t3Environment } : {}),
          ...(Option.isSome(workerScope) ? { workerScope: workerScope.value } : {}),
          ...(Option.isSome(subagents) ? { subagents: subagents.value } : {}),
          ...(Option.isSome(gitCommitterIdentity)
            ? { gitCommitterIdentity: gitCommitterIdentity.value }
            : {}),
          runtimeMode: input.binding.runtimeMode ?? "full-access",
        })
        .pipe(Effect.onError(() => clearMcpSession(input.binding.threadId)));
      if (resumed.provider !== adapter.provider) {
        yield* clearMcpSession(input.binding.threadId);
        return yield* toValidationError(
          input.operation,
          `Adapter/provider mismatch while recovering thread '${input.binding.threadId}'. Expected '${adapter.provider}', received '${resumed.provider}'.`,
        );
      }

      yield* Effect.annotateCurrentSpan({
        "provider.session_origin": sessionOriginLabel(resumed),
      });
      yield* warnOnDiscardedConversation({
        operation: input.operation,
        threadId: input.binding.threadId,
        providerInstanceId: bindingInstanceId,
        session: resumed,
        requestedResume: hasResumeCursor,
      });
      yield* upsertSessionBinding(
        { ...resumed, providerInstanceId: bindingInstanceId },
        input.binding.threadId,
      );
      yield* analytics.record("provider.session.recovered", {
        provider: resumed.provider,
        strategy: sessionOriginLabel(resumed),
        recovery: "resume-thread",
        hasResumeCursor: resumed.resumeCursor !== undefined,
      });
      return { adapter, session: resumed } as const;
    }).pipe(
      withMetrics({
        counter: providerSessionsTotal,
        attributes: providerMetricAttributes(input.binding.provider, {
          operation: "recover",
        }),
      }),
    );
  });

  const resolveRoutableSession = Effect.fn("resolveRoutableSession")(function* (input: {
    readonly threadId: ThreadId;
    readonly operation: string;
    readonly allowRecovery: boolean;
  }) {
    const bindingOption = yield* directory.getBinding(input.threadId);
    const binding = Option.getOrUndefined(bindingOption);
    if (!binding) {
      return yield* toValidationError(
        input.operation,
        `Cannot route thread '${input.threadId}' because no persisted provider binding exists.`,
      );
    }
    const instanceId = yield* requireBindingInstanceId(input.operation, binding);
    const adapter = yield* registry.getByInstance(instanceId);

    const hasRequestedSession = yield* adapter.hasSession(input.threadId);
    if (hasRequestedSession) {
      return {
        adapter,
        instanceId,
        threadId: input.threadId,
        isActive: true,
      } as const;
    }

    if (!input.allowRecovery) {
      return {
        adapter,
        instanceId,
        threadId: input.threadId,
        isActive: false,
      } as const;
    }

    const recovered = yield* recoverSessionForThread({
      binding,
      operation: input.operation,
    });
    return {
      adapter: recovered.adapter,
      instanceId,
      threadId: input.threadId,
      isActive: true,
    } as const;
  });

  const stopStaleSessionsForThread = Effect.fn("stopStaleSessionsForThread")(function* (input: {
    readonly threadId: ThreadId;
    readonly currentInstanceId: ProviderInstanceId;
  }) {
    const currentAdapters = yield* getAdapterEntries;
    yield* Effect.forEach(
      currentAdapters,
      ([instanceId, adapter]) =>
        instanceId === input.currentInstanceId
          ? Effect.void
          : Effect.gen(function* () {
              const hasSession = yield* adapter.hasSession(input.threadId);
              if (!hasSession) {
                return;
              }

              yield* adapter.stopSession(input.threadId).pipe(
                Effect.tap(() =>
                  analytics.record("provider.session.stopped", {
                    provider: adapter.provider,
                  }),
                ),
                Effect.catchCause((cause) =>
                  Effect.logWarning("provider.session.stop-stale-failed", {
                    threadId: input.threadId,
                    provider: adapter.provider,
                    cause,
                  }),
                ),
              );
            }),
      { discard: true },
    );
  });

  const startSession: ProviderServiceMethod<"startSession"> = Effect.fn("startSession")(
    function* (threadId, rawInput) {
      const parsed = yield* decodeInputOrValidationError({
        operation: "ProviderService.startSession",
        schema: ProviderSessionStartInput,
        payload: rawInput,
      });

      const resolvedInstanceId = yield* requireBindingInstanceId(
        "ProviderService.startSession",
        parsed,
      );
      let metricProvider = parsed.provider ?? String(resolvedInstanceId);
      yield* Effect.annotateCurrentSpan({
        "provider.operation": "start-session",
        "provider.instance_id": resolvedInstanceId,
        "provider.thread_id": threadId,
        "provider.runtime_mode": parsed.runtimeMode,
      });
      return yield* Effect.gen(function* () {
        const instanceInfo = yield* registry.getInstanceInfo(resolvedInstanceId);
        const resolvedProvider = instanceInfo.driverKind;
        metricProvider = resolvedProvider;
        if (parsed.provider !== undefined && parsed.provider !== resolvedProvider) {
          return yield* toValidationError(
            "ProviderService.startSession",
            `Provider instance '${resolvedInstanceId}' belongs to driver '${resolvedProvider}', not '${parsed.provider}'.`,
          );
        }
        const input = {
          ...parsed,
          threadId,
          provider: resolvedProvider,
        };
        if (!instanceInfo.enabled) {
          return yield* toValidationError(
            "ProviderService.startSession",
            `Provider instance '${resolvedInstanceId}' is disabled in T3 Code settings.`,
          );
        }
        const persistedBinding = Option.getOrUndefined(yield* directory.getBinding(threadId));
        // A binding continues this conversation when it belongs to the same
        // instance, or to a sibling instance in the same continuation group.
        // Drivers that key continuation on a shared home (Codex,
        // CodexHomeLayout.ts) make their accounts resumable across an account
        // rotation this way. A persisted identity is required for the
        // cross-instance arm: an unknown identity means unknown, and an
        // unknown cursor handed to a stranger loses the conversation
        // silently.
        const persistedIdentity =
          persistedBinding === undefined
            ? undefined
            : readPersistedContinuationIdentity(persistedBinding.runtimePayload);
        const bindingContinuesConversation =
          persistedBinding !== undefined &&
          (persistedIdentity === undefined
            ? persistedBinding.providerInstanceId === resolvedInstanceId
            : persistedIdentity.driverKind === instanceInfo.continuationIdentity.driverKind &&
              persistedIdentity.continuationKey ===
                instanceInfo.continuationIdentity.continuationKey);
        const effectiveResumeCursor =
          input.resumeCursor ??
          (persistedBinding !== undefined && bindingContinuesConversation
            ? persistedBinding.resumeCursor
            : undefined);
        const persistedCwdCandidate =
          persistedBinding !== undefined && bindingContinuesConversation
            ? readPersistedCwd(persistedBinding.runtimePayload)
            : undefined;
        const effectiveCwd =
          input.cwd ??
          (yield* resolvePersistedCwd({
            operation: "ProviderService.startSession",
            threadId,
            provider: resolvedProvider,
            providerInstanceId: resolvedInstanceId,
            persistedCwd: persistedCwdCandidate,
            fallbackCwd:
              parsed.workspaceRoot ??
              (persistedBinding
                ? readPersistedT3EnvironmentContext(persistedBinding.runtimePayload)?.workspaceRoot
                : undefined),
          }));
        yield* Effect.annotateCurrentSpan({
          "provider.kind": resolvedProvider,
          "provider.resume_cursor.source":
            input.resumeCursor !== undefined
              ? "request"
              : effectiveResumeCursor !== undefined && bindingContinuesConversation
                ? "persisted"
                : "none",
          "provider.resume_cursor.present": effectiveResumeCursor !== undefined,
          "provider.cwd.source":
            input.cwd !== undefined
              ? "request"
              : effectiveCwd !== undefined && bindingContinuesConversation
                ? "persisted"
                : "none",
          "provider.cwd.effective": effectiveCwd ?? "",
        });
        const adapter = yield* registry.getByInstance(resolvedInstanceId);
        yield* prepareMcpSession(threadId, resolvedInstanceId, resolvedProvider);
        const t3Environment = yield* resolveT3SessionEnvironment({
          threadId,
          projectId: parsed.projectId,
          workspaceRoot: parsed.workspaceRoot,
        });
        const workerScope = yield* workerScopeRegistry.resolve(threadId);
        const subagents = yield* resolveSessionSubagents({
          threadId,
          sessionInstanceId: input.modelSelection?.instanceId ?? resolvedInstanceId,
        });
        const gitCommitterIdentity = yield* resolveSessionCommitterIdentity(threadId);
        const session = yield* adapter
          .startSession({
            ...input,
            providerInstanceId: resolvedInstanceId,
            ...(effectiveCwd !== undefined ? { cwd: effectiveCwd } : {}),
            ...(effectiveResumeCursor !== undefined ? { resumeCursor: effectiveResumeCursor } : {}),
            ...(t3Environment !== undefined ? { t3Environment } : {}),
            ...(Option.isSome(workerScope) ? { workerScope: workerScope.value } : {}),
            ...(Option.isSome(subagents) ? { subagents: subagents.value } : {}),
            ...(Option.isSome(gitCommitterIdentity)
              ? { gitCommitterIdentity: gitCommitterIdentity.value }
              : {}),
          })
          .pipe(Effect.onError(() => clearMcpSession(threadId)));

        if (session.provider !== adapter.provider) {
          yield* clearMcpSession(threadId);
          return yield* toValidationError(
            "ProviderService.startSession",
            `Adapter/provider mismatch: requested '${adapter.provider}', received '${session.provider}'.`,
          );
        }
        const sessionWithInstance = {
          ...session,
          providerInstanceId: resolvedInstanceId,
        };
        yield* Effect.annotateCurrentSpan({
          "provider.session_origin": sessionOriginLabel(session),
        });
        yield* warnOnDiscardedConversation({
          operation: "ProviderService.startSession",
          threadId,
          providerInstanceId: resolvedInstanceId,
          session,
          requestedResume: effectiveResumeCursor !== undefined,
        });

        yield* stopStaleSessionsForThread({
          threadId,
          currentInstanceId: resolvedInstanceId,
        });
        yield* upsertSessionBinding(sessionWithInstance, threadId, {
          modelSelection: input.modelSelection,
          // Record which continuation domain the cursor we are about to persist
          // belongs to. If the instance is reconfigured later, a reader can tell
          // the cursor is dead instead of handing it to a stranger.
          continuationIdentity: instanceInfo.continuationIdentity,
          // Persist the project context so a post-restart recovery can rebuild
          // the T3_* injection for this thread.
          ...(parsed.projectId !== undefined && parsed.workspaceRoot !== undefined
            ? {
                t3EnvironmentContext: {
                  projectId: parsed.projectId,
                  workspaceRoot: parsed.workspaceRoot,
                },
              }
            : {}),
        });
        yield* analytics.record("provider.session.started", {
          provider: sessionWithInstance.provider,
          runtimeMode: input.runtimeMode,
          hasResumeCursor: sessionWithInstance.resumeCursor !== undefined,
          hasCwd: typeof effectiveCwd === "string" && effectiveCwd.trim().length > 0,
          hasModel:
            typeof input.modelSelection?.model === "string" &&
            input.modelSelection.model.trim().length > 0,
        });

        return sessionWithInstance;
      }).pipe(
        withMetrics({
          counter: providerSessionsTotal,
          attributes: () =>
            providerMetricAttributes(metricProvider, {
              operation: "start",
            }),
        }),
      );
    },
  );

  const sendTurn: ProviderServiceMethod<"sendTurn"> = Effect.fn("sendTurn")(function* (rawInput) {
    const parsed = yield* decodeInputOrValidationError({
      operation: "ProviderService.sendTurn",
      schema: ProviderSendTurnInput,
      payload: rawInput,
    });

    const input = {
      ...parsed,
      attachments: parsed.attachments ?? [],
    };
    if (!input.input && input.attachments.length === 0) {
      return yield* toValidationError(
        "ProviderService.sendTurn",
        "Either input text or at least one attachment is required",
      );
    }
    yield* Effect.annotateCurrentSpan({
      "provider.operation": "send-turn",
      "provider.thread_id": input.threadId,
      "provider.interaction_mode": input.interactionMode,
      "provider.attachment_count": input.attachments.length,
    });
    let metricProvider = "unknown";
    let metricModel = input.modelSelection?.model;
    return yield* Effect.gen(function* () {
      const routed = yield* resolveRoutableSession({
        threadId: input.threadId,
        operation: "ProviderService.sendTurn",
        allowRecovery: true,
      });
      metricProvider = routed.adapter.provider;
      metricModel = input.modelSelection?.model;
      yield* Effect.annotateCurrentSpan({
        "provider.kind": routed.adapter.provider,
        ...(input.modelSelection?.model ? { "provider.model": input.modelSelection.model } : {}),
      });
      const turn = yield* routed.adapter.sendTurn(input);
      // A turn refreshes the resume cursor, so it has to refresh the identity
      // stamped on it too. Never fail a started turn over this: an instance the
      // registry just routed through can only go missing in a race, and the
      // merged payload then keeps whatever the last write left.
      const turnContinuationIdentity = yield* registry.getInstanceInfo(routed.instanceId).pipe(
        Effect.map((info): ProviderContinuationIdentity | undefined => info.continuationIdentity),
        Effect.orElseSucceed(() => undefined),
      );
      yield* directory.upsert({
        threadId: input.threadId,
        provider: routed.adapter.provider,
        providerInstanceId: routed.instanceId,
        status: "running",
        ...(turn.resumeCursor !== undefined ? { resumeCursor: turn.resumeCursor } : {}),
        runtimePayload: {
          ...(input.modelSelection !== undefined ? { modelSelection: input.modelSelection } : {}),
          ...(turnContinuationIdentity !== undefined
            ? { continuationIdentity: turnContinuationIdentity }
            : {}),
          activeTurnId: turn.turnId,
          lastRuntimeEvent: "provider.sendTurn",
          lastRuntimeEventAt: yield* nowIso,
        },
      });
      yield* analytics.record("provider.turn.sent", {
        provider: routed.adapter.provider,
        model: input.modelSelection?.model,
        interactionMode: input.interactionMode,
        attachmentCount: input.attachments.length,
        hasInput: typeof input.input === "string" && input.input.trim().length > 0,
      });
      return turn;
    }).pipe(
      withMetrics({
        counter: providerTurnsTotal,
        timer: providerTurnDuration,
        attributes: () =>
          providerTurnMetricAttributes({
            provider: metricProvider,
            model: metricModel,
            extra: {
              operation: "send",
            },
          }),
      }),
    );
  });

  const interruptTurn: ProviderServiceMethod<"interruptTurn"> = Effect.fn("interruptTurn")(
    function* (rawInput) {
      const input = yield* decodeInputOrValidationError({
        operation: "ProviderService.interruptTurn",
        schema: ProviderInterruptTurnInput,
        payload: rawInput,
      });
      let metricProvider = "unknown";
      return yield* Effect.gen(function* () {
        const routed = yield* resolveRoutableSession({
          threadId: input.threadId,
          operation: "ProviderService.interruptTurn",
          allowRecovery: true,
        });
        metricProvider = routed.adapter.provider;
        yield* Effect.annotateCurrentSpan({
          "provider.operation": "interrupt-turn",
          "provider.kind": routed.adapter.provider,
          "provider.thread_id": input.threadId,
          "provider.turn_id": input.turnId,
        });
        yield* routed.adapter.interruptTurn(routed.threadId, input.turnId);
        yield* analytics.record("provider.turn.interrupted", {
          provider: routed.adapter.provider,
        });
      }).pipe(
        withMetrics({
          counter: providerTurnsTotal,
          outcomeAttributes: () =>
            providerMetricAttributes(metricProvider, {
              operation: "interrupt",
            }),
        }),
      );
    },
  );

  const respondToRequest: ProviderServiceMethod<"respondToRequest"> = Effect.fn("respondToRequest")(
    function* (rawInput) {
      const input = yield* decodeInputOrValidationError({
        operation: "ProviderService.respondToRequest",
        schema: ProviderRespondToRequestInput,
        payload: rawInput,
      });
      let metricProvider = "unknown";
      return yield* Effect.gen(function* () {
        const routed = yield* resolveRoutableSession({
          threadId: input.threadId,
          operation: "ProviderService.respondToRequest",
          allowRecovery: true,
        });
        metricProvider = routed.adapter.provider;
        yield* Effect.annotateCurrentSpan({
          "provider.operation": "respond-to-request",
          "provider.kind": routed.adapter.provider,
          "provider.thread_id": input.threadId,
          "provider.request_id": input.requestId,
        });
        yield* routed.adapter.respondToRequest(routed.threadId, input.requestId, input.decision);
        yield* analytics.record("provider.request.responded", {
          provider: routed.adapter.provider,
          decision: input.decision,
        });
      }).pipe(
        withMetrics({
          counter: providerTurnsTotal,
          outcomeAttributes: () =>
            providerMetricAttributes(metricProvider, {
              operation: "approval-response",
            }),
        }),
      );
    },
  );

  const respondToUserInput: ProviderServiceMethod<"respondToUserInput"> = Effect.fn(
    "respondToUserInput",
  )(function* (rawInput) {
    const input = yield* decodeInputOrValidationError({
      operation: "ProviderService.respondToUserInput",
      schema: ProviderRespondToUserInputInput,
      payload: rawInput,
    });
    let metricProvider = "unknown";
    return yield* Effect.gen(function* () {
      const routed = yield* resolveRoutableSession({
        threadId: input.threadId,
        operation: "ProviderService.respondToUserInput",
        allowRecovery: true,
      });
      metricProvider = routed.adapter.provider;
      yield* Effect.annotateCurrentSpan({
        "provider.operation": "respond-to-user-input",
        "provider.kind": routed.adapter.provider,
        "provider.thread_id": input.threadId,
        "provider.request_id": input.requestId,
      });
      yield* routed.adapter.respondToUserInput(routed.threadId, input.requestId, input.answers);
    }).pipe(
      withMetrics({
        counter: providerTurnsTotal,
        outcomeAttributes: () =>
          providerMetricAttributes(metricProvider, {
            operation: "user-input-response",
          }),
      }),
    );
  });

  const stopSession: ProviderServiceMethod<"stopSession"> = Effect.fn("stopSession")(
    function* (rawInput) {
      const input = yield* decodeInputOrValidationError({
        operation: "ProviderService.stopSession",
        schema: ProviderStopSessionInput,
        payload: rawInput,
      });
      let metricProvider = "unknown";
      return yield* Effect.gen(function* () {
        const routed = yield* resolveRoutableSession({
          threadId: input.threadId,
          operation: "ProviderService.stopSession",
          allowRecovery: false,
        });
        metricProvider = routed.adapter.provider;
        yield* Effect.annotateCurrentSpan({
          "provider.operation": "stop-session",
          "provider.kind": routed.adapter.provider,
          "provider.thread_id": input.threadId,
        });
        if (routed.isActive) {
          yield* routed.adapter.stopSession(routed.threadId);
        }
        yield* clearMcpSession(input.threadId);
        bindingLastSeenTouchedAtMs.delete(input.threadId);
        openTurnWatchdogs.delete(input.threadId);
        syntheticSettledTurns.delete(input.threadId);
        yield* directory.upsert({
          threadId: input.threadId,
          provider: routed.adapter.provider,
          providerInstanceId: routed.instanceId,
          status: "stopped",
          runtimePayload: {
            activeTurnId: null,
          },
        });
        yield* analytics.record("provider.session.stopped", {
          provider: routed.adapter.provider,
        });
      }).pipe(
        withMetrics({
          counter: providerSessionsTotal,
          outcomeAttributes: () =>
            providerMetricAttributes(metricProvider, {
              operation: "stop",
            }),
        }),
      );
    },
  );

  const listSessions: ProviderServiceMethod<"listSessions"> = Effect.fn("listSessions")(
    function* () {
      const currentAdapters = yield* getAdapterEntries;
      const sessionsByProvider = yield* Effect.forEach(currentAdapters, ([instanceId, adapter]) =>
        adapter.listSessions().pipe(
          Effect.map((sessions) =>
            sessions.map((session) => ({
              ...session,
              providerInstanceId: instanceId,
            })),
          ),
        ),
      );
      const activeSessions = sessionsByProvider.flatMap((sessions) => sessions);
      const persistedBindings = yield* directory.listThreadIds().pipe(
        Effect.flatMap((threadIds) =>
          Effect.forEach(
            threadIds,
            (threadId) =>
              directory
                .getBinding(threadId)
                .pipe(
                  Effect.orElseSucceed(() =>
                    Option.none<ProviderSessionDirectory.ProviderRuntimeBinding>(),
                  ),
                ),
            { concurrency: "unbounded" },
          ),
        ),
        Effect.orElseSucceed(
          () => [] as Array<Option.Option<ProviderSessionDirectory.ProviderRuntimeBinding>>,
        ),
      );
      const bindingsByThreadId = new Map<
        ThreadId,
        ProviderSessionDirectory.ProviderRuntimeBinding
      >();
      for (const bindingOption of persistedBindings) {
        const binding = Option.getOrUndefined(bindingOption);
        if (binding) {
          bindingsByThreadId.set(binding.threadId, binding);
        }
      }

      const sessions: ProviderSession[] = [];
      for (const session of activeSessions) {
        const binding = bindingsByThreadId.get(session.threadId);
        if (!binding) {
          sessions.push(session);
          continue;
        }

        const overrides: {
          resumeCursor?: ProviderSession["resumeCursor"];
          runtimeMode?: ProviderSession["runtimeMode"];
          providerInstanceId?: ProviderSession["providerInstanceId"];
        } = {};
        overrides.providerInstanceId = dieOnMissingBindingInstanceId(
          "ProviderService.listSessions",
          binding,
        );
        if (binding.provider !== session.provider) {
          return yield* Effect.die(
            new Error(
              `ProviderService.listSessions: thread '${session.threadId}' is active on provider '${session.provider}' but persisted binding names provider '${binding.provider}'.`,
            ),
          );
        }
        if (overrides.providerInstanceId !== session.providerInstanceId) {
          return yield* Effect.die(
            new Error(
              `ProviderService.listSessions: thread '${session.threadId}' is active on provider instance '${session.providerInstanceId}' but persisted binding names '${overrides.providerInstanceId}'.`,
            ),
          );
        }
        if (session.resumeCursor === undefined && binding.resumeCursor !== undefined) {
          overrides.resumeCursor = binding.resumeCursor;
        }
        if (binding.runtimeMode !== undefined) {
          overrides.runtimeMode = binding.runtimeMode;
        }
        sessions.push(Object.assign({}, session, overrides));
      }
      return sessions;
    },
  );

  const hasLiveSession: ProviderServiceMethod<"hasLiveSession"> = Effect.fn("hasLiveSession")(
    function* (threadId) {
      const routed = yield* resolveRoutableSession({
        threadId,
        operation: "ProviderService.hasLiveSession",
        allowRecovery: false,
      });
      return routed.isActive;
    },
  );

  /**
   * Read-only resume verdict. Touches nothing: no adapter start, no MCP
   * session, no directory write. The checks run in the order that makes the
   * most specific cause win, so "this provider cannot resume" is never
   * reported as "no cursor is persisted".
   *
   * Advisory and racy — see the shape's TSDoc.
   */
  const describeSessionResume: ProviderServiceMethod<"describeSessionResume"> = Effect.fn(
    "describeSessionResume",
  )(function* (threadId) {
    const annotate = (verdict: ProviderSessionResumeVerdict) =>
      Effect.annotateCurrentSpan({
        "provider.operation": "describe-session-resume",
        "provider.thread_id": threadId,
        "provider.resume.resumable": verdict.resumable,
        "provider.resume.reason": verdict.reason,
      }).pipe(Effect.as(verdict));

    const binding = Option.getOrUndefined(yield* directory.getBinding(threadId));
    if (!binding) {
      return yield* annotate({ threadId, resumable: "no", reason: "no-binding" });
    }

    const base = {
      threadId,
      provider: binding.provider,
      ...(binding.providerInstanceId !== undefined
        ? { providerInstanceId: binding.providerInstanceId }
        : {}),
    } as const;

    // A binding with no instance id cannot be routed at all, which is the same
    // dead end as an instance that is no longer configured.
    if (binding.providerInstanceId === undefined) {
      return yield* annotate({ ...base, resumable: "no", reason: "instance-not-configured" });
    }
    const instanceId = binding.providerInstanceId;

    const adapterOption = yield* registry.getByInstance(instanceId).pipe(Effect.option);
    if (Option.isNone(adapterOption)) {
      return yield* annotate({ ...base, resumable: "no", reason: "instance-not-configured" });
    }
    const adapter = adapterOption.value;

    const instanceInfoOption = yield* registry.getInstanceInfo(instanceId).pipe(Effect.option);
    if (Option.isNone(instanceInfoOption)) {
      return yield* annotate({ ...base, resumable: "no", reason: "instance-not-configured" });
    }
    const instanceInfo = instanceInfoOption.value;
    if (!instanceInfo.enabled) {
      return yield* annotate({ ...base, resumable: "no", reason: "instance-disabled" });
    }

    const persistedCwd = readPersistedCwd(binding.runtimePayload);
    const withPersistedState = {
      ...base,
      ...(persistedCwd !== undefined ? { cwd: persistedCwd } : {}),
      lastSeenAt: binding.lastSeenAt,
    } as const;

    if (yield* adapter.hasSession(threadId)) {
      return yield* annotate({
        ...withPersistedState,
        resumable: "live",
        reason: "live-session",
      });
    }

    if (adapter.capabilities.sessionLifecycle.resume === "unsupported") {
      return yield* annotate({ ...base, resumable: "no", reason: "resume-unsupported" });
    }

    if (binding.resumeCursor === null || binding.resumeCursor === undefined) {
      return yield* annotate({ ...base, resumable: "no", reason: "no-cursor" });
    }

    // An absent persisted identity is unknown, not a mismatch: every binding
    // written before the field existed reads that way. Only a recorded key that
    // disagrees with the instance's current one kills the cursor.
    const persistedIdentity = readPersistedContinuationIdentity(binding.runtimePayload);
    if (
      persistedIdentity !== undefined &&
      (persistedIdentity.driverKind !== instanceInfo.continuationIdentity.driverKind ||
        persistedIdentity.continuationKey !== instanceInfo.continuationIdentity.continuationKey)
    ) {
      return yield* annotate({
        ...base,
        resumable: "no",
        reason: "continuation-identity-changed",
      });
    }

    return yield* annotate({
      ...withPersistedState,
      resumable: "cursor",
      reason: "persisted-cursor",
    });
  });

  const getCapabilities: ProviderServiceMethod<"getCapabilities"> = (instanceId) =>
    registry.getByInstance(instanceId).pipe(Effect.map((adapter) => adapter.capabilities));

  const getInstanceInfo: ProviderServiceMethod<"getInstanceInfo"> = (instanceId) =>
    registry.getInstanceInfo(instanceId);

  const rollbackConversation: ProviderServiceMethod<"rollbackConversation"> = Effect.fn(
    "rollbackConversation",
  )(function* (rawInput) {
    const input = yield* decodeInputOrValidationError({
      operation: "ProviderService.rollbackConversation",
      schema: ProviderRollbackConversationInput,
      payload: rawInput,
    });
    if (input.numTurns === 0) {
      return;
    }
    let metricProvider = "unknown";
    return yield* Effect.gen(function* () {
      const routed = yield* resolveRoutableSession({
        threadId: input.threadId,
        operation: "ProviderService.rollbackConversation",
        allowRecovery: true,
      });
      metricProvider = routed.adapter.provider;
      yield* Effect.annotateCurrentSpan({
        "provider.operation": "rollback-conversation",
        "provider.kind": routed.adapter.provider,
        "provider.thread_id": input.threadId,
        "provider.rollback_turns": input.numTurns,
      });
      const snapshot = yield* routed.adapter.rollbackThread(routed.threadId, input.numTurns);
      if (snapshot.resumeCursor !== undefined) {
        yield* directory.upsert({
          threadId: input.threadId,
          provider: routed.adapter.provider,
          providerInstanceId: routed.instanceId,
          resumeCursor: snapshot.resumeCursor,
        });
      }
      yield* analytics.record("provider.conversation.rolled_back", {
        provider: routed.adapter.provider,
        turns: input.numTurns,
      });
    }).pipe(
      withMetrics({
        counter: providerTurnsTotal,
        outcomeAttributes: () =>
          providerMetricAttributes(metricProvider, {
            operation: "rollback",
          }),
      }),
    );
  });

  const runStopAll = Effect.fn("runStopAll")(function* () {
    const threadIds = yield* directory.listThreadIds();
    const currentAdapters = yield* getAdapterEntries;
    const activeSessions = yield* Effect.forEach(currentAdapters, ([instanceId, adapter]) =>
      adapter.listSessions().pipe(
        Effect.map((sessions) =>
          sessions.map((session) => ({
            ...session,
            providerInstanceId: instanceId,
          })),
        ),
      ),
    ).pipe(Effect.map((sessionsByAdapter) => sessionsByAdapter.flatMap((sessions) => sessions)));
    yield* Effect.forEach(activeSessions, (session) =>
      Effect.flatMap(nowIso, (lastRuntimeEventAt) =>
        upsertSessionBinding(session, session.threadId, {
          lastRuntimeEvent: "provider.stopAll",
          lastRuntimeEventAt,
        }),
      ),
    ).pipe(Effect.asVoid);
    yield* Effect.forEach(currentAdapters, ([, adapter]) => adapter.stopAll()).pipe(Effect.asVoid);
    yield* McpSessionRegistry.revokeAllActiveMcpCredentials();
    McpProviderSession.clearAllMcpProviderSessions();
    bindingLastSeenTouchedAtMs.clear();
    openTurnWatchdogs.clear();
    syntheticSettledTurns.clear();
    const bindings = yield* directory.listBindings().pipe(Effect.orElseSucceed(() => []));
    yield* Effect.forEach(bindings, (binding) =>
      Effect.gen(function* () {
        const providerInstanceId = dieOnMissingBindingInstanceId(
          "ProviderService.stopAll",
          binding,
        );
        return yield* directory.upsert({
          threadId: binding.threadId,
          provider: binding.provider,
          providerInstanceId,
          status: "stopped",
          runtimePayload: {
            activeTurnId: null,
            lastRuntimeEvent: "provider.stopAll",
            lastRuntimeEventAt: yield* nowIso,
          },
        });
      }),
    ).pipe(Effect.asVoid);
    yield* analytics.record("provider.sessions.stopped_all", {
      sessionCount: threadIds.length,
    });
    yield* analytics.flush;
  });

  yield* Effect.addFinalizer(() =>
    runStopAll().pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("failed to stop provider service", {
          errorTag: causeErrorTag(cause),
        }),
      ),
    ),
  );

  return {
    startSession,
    sendTurn,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    hasLiveSession,
    describeSessionResume,
    getCapabilities,
    getInstanceInfo,
    rollbackConversation,
    // Each access creates a fresh PubSub subscription so that multiple
    // consumers (ProviderRuntimeIngestion, CheckpointReactor, etc.) each
    // independently receive all runtime events.
    get streamEvents(): ProviderServiceMethod<"streamEvents"> {
      return Stream.fromPubSub(runtimeEventPubSub);
    },
  } satisfies ProviderService.ProviderService["Service"];
});

export const ProviderServiceLive = Layer.effect(
  ProviderService.ProviderService,
  makeProviderService(),
);

export function makeProviderServiceLive(options?: ProviderServiceLiveOptions) {
  return Layer.effect(ProviderService.ProviderService, makeProviderService(options));
}
