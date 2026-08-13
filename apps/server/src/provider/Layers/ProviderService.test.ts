// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { UNKNOWN_DRIVER_ATTACHMENT_CAPABILITY } from "@t3tools/contracts";
import type {
  ProviderApprovalDecision,
  ProviderRuntimeEvent,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderSessionOrigin,
  ProviderTurnStartResult,
} from "@t3tools/contracts";
import {
  ApprovalRequestId,
  AuthSessionId,
  EnvironmentId,
  EpicRunId,
  EventId,
  epicRunIterationThreadId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionStartInput,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { it, assert, vi } from "@effect/vitest";

import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Metric from "effect/Metric";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { HttpServer } from "effect/unstable/http";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderUnsupportedError,
  ProviderValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import type {
  ProviderAdapterShape,
  ProviderSessionResumeMode,
} from "../Services/ProviderAdapter.ts";
import { decideSessionReap } from "../sessionReapPolicy.ts";
import * as ProviderAdapterRegistry from "../Services/ProviderAdapterRegistry.ts";
import * as ProviderService from "../Services/ProviderService.ts";
import * as ProviderSessionDirectory from "../Services/ProviderSessionDirectory.ts";
import { makeProviderServiceLive } from "./ProviderService.ts";
import * as ProviderEventLoggers from "./ProviderEventLoggers.ts";
import { ProviderSessionDirectoryLive } from "./ProviderSessionDirectory.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ProviderSessionRuntime from "../../persistence/ProviderSessionRuntime.ts";
import {
  makeSqlitePersistenceLive,
  SqlitePersistenceMemory,
} from "../../persistence/Layers/Sqlite.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as AnalyticsService from "../../telemetry/AnalyticsService.ts";
import { EpicSubagentRegistry } from "../epicSubagents.ts";
import { EpicWorkerScopeRegistry } from "../workerScope.ts";
import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import { makeUnconfiguredEnvironmentAuth } from "../../auth/environmentAuthTestStub.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import * as McpSessionRegistry from "../../mcp/McpSessionRegistry.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import { makeAdapterRegistryMock } from "../testUtils/providerAdapterRegistryMock.ts";

const defaultServerSettingsLayer = ServerSettings.ServerSettingsService.layerTest();

// Default EnvironmentAuth double for suites that never exercise T3_*
// injection: no `projectId`/`workspaceRoot` on the start input means
// ProviderService never calls into it. It dies loudly if that changes.
const environmentAuthTestLayer = Layer.succeed(
  EnvironmentAuth.EnvironmentAuth,
  makeUnconfiguredEnvironmentAuth(),
);

// Suites here use synthetic cwd paths (`/tmp/project`) that never exist on
// disk. Default to "every path resolves" so only the tests that care about a
// vanished working directory opt into a stricter file system.
const presentFileSystemLayer = FileSystem.layerNoop({
  exists: () => Effect.succeed(true),
});

const makeProviderServiceLiveForTest = (
  options?: Parameters<typeof makeProviderServiceLive>[0],
  fileSystemLayer: Layer.Layer<FileSystem.FileSystem> = presentFileSystemLayer,
) =>
  makeProviderServiceLive(options).pipe(
    Layer.provide(environmentAuthTestLayer),
    Layer.provide(fileSystemLayer),
    Layer.provideMerge(EpicWorkerScopeRegistry.layer),
    Layer.provideMerge(EpicSubagentRegistry.layer),
  );

const asRequestId = (value: string): ApprovalRequestId => ApprovalRequestId.make(value);
const asEventId = (value: string): EventId => EventId.make(value);
const asThreadId = (value: string): ThreadId => ThreadId.make(value);
const asTurnId = (value: string): TurnId => TurnId.make(value);
const codexInstanceId = ProviderInstanceId.make("codex");
const claudeAgentInstanceId = ProviderInstanceId.make("claudeAgent");
const CODEX_DRIVER = ProviderDriverKind.make("codex");
const CLAUDE_AGENT_DRIVER = ProviderDriverKind.make("claudeAgent");
const CURSOR_DRIVER = ProviderDriverKind.make("cursor");

type LegacyProviderRuntimeEvent = {
  readonly type: string;
  readonly eventId: EventId;
  readonly provider: ProviderDriverKind;
  readonly createdAt: string;
  readonly threadId: ThreadId;
  readonly turnId?: string | undefined;
  readonly itemId?: string | undefined;
  readonly requestId?: string | undefined;
  readonly payload?: unknown | undefined;
  readonly [key: string]: unknown;
};

function makeFakeCodexAdapter(
  provider: ProviderDriverKind = CODEX_DRIVER,
  capabilityOverrides?: { readonly sessionResume?: ProviderSessionResumeMode },
  sessionOverrides?: {
    /**
     * What the fake reports when a start carries a resume cursor. Left unset
     * it reports nothing at all, which is the state every adapter is in until
     * the follow-up children teach them to answer.
     */
    readonly resumeOrigin?: ProviderSessionOrigin;
  },
) {
  const sessions = new Map<ThreadId, ProviderSession>();
  const runtimeEventPubSub = Effect.runSync(PubSub.unbounded<ProviderRuntimeEvent>());

  const startSession = vi.fn(
    (input: ProviderSessionStartInput): Effect.Effect<ProviderSession, ProviderAdapterError> =>
      Effect.sync(() => {
        const now = "2026-01-01T00:00:00.000Z";
        const session: ProviderSession = {
          provider,
          ...(input.providerInstanceId !== undefined
            ? { providerInstanceId: input.providerInstanceId }
            : {}),
          status: "ready",
          runtimeMode: input.runtimeMode,
          threadId: input.threadId,
          resumeCursor: input.resumeCursor ?? {
            opaque: `resume-${String(input.threadId)}`,
          },
          ...(input.resumeCursor !== undefined && sessionOverrides?.resumeOrigin !== undefined
            ? { sessionOrigin: sessionOverrides.resumeOrigin }
            : {}),
          cwd: input.cwd ?? process.cwd(),
          createdAt: now,
          updatedAt: now,
        };
        sessions.set(session.threadId, session);
        return session;
      }),
  );

  const sendTurn = vi.fn(
    (
      input: ProviderSendTurnInput,
    ): Effect.Effect<ProviderTurnStartResult, ProviderAdapterError> => {
      if (!sessions.has(input.threadId)) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({
            provider,
            threadId: input.threadId,
          }),
        );
      }

      return Effect.succeed({
        threadId: input.threadId,
        turnId: TurnId.make(`turn-${String(input.threadId)}`),
      });
    },
  );

  const interruptTurn = vi.fn(
    (_threadId: ThreadId, _turnId?: TurnId): Effect.Effect<void, ProviderAdapterError> =>
      Effect.void,
  );

  const respondToRequest = vi.fn(
    (
      _threadId: ThreadId,
      _requestId: string,
      _decision: ProviderApprovalDecision,
    ): Effect.Effect<void, ProviderAdapterError> => Effect.void,
  );

  const respondToUserInput = vi.fn(
    (
      _threadId: ThreadId,
      _requestId: string,
      _answers: Record<string, unknown>,
    ): Effect.Effect<void, ProviderAdapterError> => Effect.void,
  );

  const stopSession = vi.fn(
    (threadId: ThreadId): Effect.Effect<void, ProviderAdapterError> =>
      Effect.sync(() => {
        sessions.delete(threadId);
      }),
  );

  const listSessions = vi.fn(
    (): Effect.Effect<ReadonlyArray<ProviderSession>> =>
      Effect.sync(() => Array.from(sessions.values())),
  );

  const hasSession = vi.fn(
    (threadId: ThreadId): Effect.Effect<boolean> => Effect.succeed(sessions.has(threadId)),
  );

  const readThread = vi.fn(
    (
      threadId: ThreadId,
    ): Effect.Effect<
      {
        threadId: ThreadId;
        turns: ReadonlyArray<{ id: TurnId; items: readonly [] }>;
      },
      ProviderAdapterError
    > =>
      Effect.succeed({
        threadId,
        turns: [{ id: asTurnId("turn-1"), items: [] }],
      }),
  );

  const rollbackThread = vi.fn(
    (
      threadId: ThreadId,
      _numTurns: number,
    ): Effect.Effect<{ threadId: ThreadId; turns: readonly [] }, ProviderAdapterError> =>
      Effect.succeed({ threadId, turns: [] }),
  );

  const stopAll = vi.fn(
    (): Effect.Effect<void, ProviderAdapterError> =>
      Effect.sync(() => {
        sessions.clear();
      }),
  );

  const adapter: ProviderAdapterShape<ProviderAdapterError> = {
    provider,
    capabilities: {
      sessionModelSwitch: "in-session",
      sessionLifecycle: { resume: capabilityOverrides?.sessionResume ?? "cursor" },
      attachments: UNKNOWN_DRIVER_ATTACHMENT_CAPABILITY,
    },
    startSession,
    sendTurn,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    hasSession,
    readThread,
    rollbackThread,
    stopAll,
    get streamEvents() {
      return Stream.fromPubSub(runtimeEventPubSub);
    },
  };

  const emit = (event: LegacyProviderRuntimeEvent): void => {
    Effect.runSync(PubSub.publish(runtimeEventPubSub, event as unknown as ProviderRuntimeEvent));
  };

  const updateSession = (
    threadId: ThreadId,
    update: (session: ProviderSession) => ProviderSession,
  ): void => {
    const existing = sessions.get(threadId);
    if (!existing) {
      return;
    }
    sessions.set(threadId, update(existing));
  };

  return {
    adapter,
    emit,
    updateSession,
    startSession,
    sendTurn,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    hasSession,
    readThread,
    rollbackThread,
    stopAll,
  };
}

const advanceTestClock = (ms: number) =>
  TestClock.adjust(`${ms} millis`).pipe(Effect.andThen(Effect.yieldNow));

const hasMetricSnapshot = (
  snapshots: ReadonlyArray<Metric.Metric.Snapshot>,
  id: string,
  attributes: Readonly<Record<string, string>>,
) =>
  snapshots.some(
    (snapshot) =>
      snapshot.id === id &&
      Object.entries(attributes).every(([key, value]) => snapshot.attributes?.[key] === value),
  );

function makeProviderServiceLayer(options?: Parameters<typeof makeProviderServiceLive>[0]) {
  const codex = makeFakeCodexAdapter();
  const claude = makeFakeCodexAdapter(CLAUDE_AGENT_DRIVER);
  const cursor = makeFakeCodexAdapter(CURSOR_DRIVER);
  const registry = makeAdapterRegistryMock({
    [ProviderDriverKind.make("codex")]: codex.adapter,
    [ProviderDriverKind.make("claudeAgent")]: claude.adapter,
    [ProviderDriverKind.make("cursor")]: cursor.adapter,
  });

  const providerAdapterLayer = Layer.succeed(
    ProviderAdapterRegistry.ProviderAdapterRegistry,
    registry,
  );
  const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
    Layer.provide(SqlitePersistenceMemory),
  );
  const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));

  const layer = it.layer(
    Layer.mergeAll(
      makeProviderServiceLiveForTest(options).pipe(
        Layer.provide(providerAdapterLayer),
        Layer.provide(directoryLayer),
        Layer.provide(defaultServerSettingsLayer),
        Layer.provideMerge(AnalyticsService.layerTest),
        Layer.provide(
          Layer.succeed(
            ProviderEventLoggers.ProviderEventLoggers,
            ProviderEventLoggers.NoOpProviderEventLoggers,
          ),
        ),
      ),
      directoryLayer,

      runtimeRepositoryLayer,
      NodeServices.layer,
    ),
  );

  return {
    codex,
    claude,
    cursor,
    layer,
  };
}

it.effect("ProviderServiceLive catches stopAll failures during shutdown", () =>
  Effect.gen(function* () {
    const codex = makeFakeCodexAdapter();
    codex.stopAll.mockImplementation(() =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: String(CODEX_DRIVER),
          method: "stopAll",
          detail: "simulated stopAll failure",
        }),
      ),
    );
    const registry = makeAdapterRegistryMock({
      [CODEX_DRIVER]: codex.adapter,
    });
    const providerAdapterLayer = Layer.succeed(
      ProviderAdapterRegistry.ProviderAdapterRegistry,
      registry,
    );
    const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
      Layer.provide(SqlitePersistenceMemory),
    );
    const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));
    const providerLayer = Layer.mergeAll(
      makeProviderServiceLiveForTest().pipe(
        Layer.provide(providerAdapterLayer),
        Layer.provide(directoryLayer),
        Layer.provide(defaultServerSettingsLayer),
        Layer.provideMerge(AnalyticsService.layerTest),
        Layer.provide(
          Layer.succeed(
            ProviderEventLoggers.ProviderEventLoggers,
            ProviderEventLoggers.NoOpProviderEventLoggers,
          ),
        ),
      ),
      directoryLayer,
      runtimeRepositoryLayer,
      NodeServices.layer,
    );
    const scope = yield* Scope.make();
    const runtimeServices = yield* Layer.build(providerLayer).pipe(Scope.provide(scope));

    yield* ProviderService.ProviderService.pipe(Effect.provide(runtimeServices));
    const closeExit = yield* Scope.close(scope, Exit.void).pipe(Effect.exit);

    assert.equal(Exit.isSuccess(closeExit), true);
    assert.equal(codex.stopAll.mock.calls.length, 1);
  }),
);

// Teardown regression net (t3code-f90.8): server shutdown is one of the
// triggers that must keep working. The finalizer runs `runStopAll`, and the
// three things it owns are the adapter stop, every binding landing on
// `"stopped"`, and the MCP credentials going away.
const mcpShutdownHttpServer = HttpServer.HttpServer.of({
  address: { _tag: "TcpAddress", hostname: "127.0.0.1", port: 43_123 },
  serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
});

const mcpShutdownEnvironment = ServerEnvironment.ServerEnvironment.of({
  getEnvironmentId: Effect.succeed(EnvironmentId.make("env-shutdown")),
  getDescriptor: Effect.die("unused"),
});

it.effect("ProviderServiceLive stops every session and revokes MCP access on shutdown", () =>
  Effect.gen(function* () {
    const codex = makeFakeCodexAdapter();
    const claude = makeFakeCodexAdapter(CLAUDE_AGENT_DRIVER);
    const providerAdapterLayer = Layer.succeed(
      ProviderAdapterRegistry.ProviderAdapterRegistry,
      makeAdapterRegistryMock({
        [CODEX_DRIVER]: codex.adapter,
        [CLAUDE_AGENT_DRIVER]: claude.adapter,
      }),
    );
    const persistenceLayer = SqlitePersistenceMemory;
    const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
      Layer.provide(persistenceLayer),
    );
    const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));

    // The directory and the MCP registry live in the outer scope so they can be
    // read after the provider service's own scope — and therefore its
    // finalizer — has closed.
    const outerScope = yield* Scope.make();
    const outerServices = yield* Layer.build(
      Layer.mergeAll(
        directoryLayer,
        McpSessionRegistry.layer.pipe(
          Layer.provide(Layer.succeed(HttpServer.HttpServer, mcpShutdownHttpServer)),
          Layer.provide(Layer.succeed(ServerEnvironment.ServerEnvironment, mcpShutdownEnvironment)),
          Layer.provide(NodeServices.layer),
        ),
        NodeServices.layer,
      ),
    ).pipe(Scope.provide(outerScope));

    const directory = Context.get(outerServices, ProviderSessionDirectory.ProviderSessionDirectory);
    const mcpRegistry = Context.get(outerServices, McpSessionRegistry.McpSessionRegistry);

    const codexThreadId = asThreadId("thread-shutdown-codex");
    const claudeThreadId = asThreadId("thread-shutdown-claude");

    const providerScope = yield* Scope.make();
    const providerServices = yield* Layer.build(
      makeProviderServiceLiveForTest().pipe(
        Layer.provide(providerAdapterLayer),
        Layer.provide(Layer.succeedContext(outerServices)),
        Layer.provide(defaultServerSettingsLayer),
        Layer.provideMerge(AnalyticsService.layerTest),
        Layer.provide(
          Layer.succeed(
            ProviderEventLoggers.ProviderEventLoggers,
            ProviderEventLoggers.NoOpProviderEventLoggers,
          ),
        ),
      ),
    ).pipe(Scope.provide(providerScope));

    yield* Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      yield* provider.startSession(codexThreadId, {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId: codexThreadId,
        cwd: "/tmp/project-shutdown-codex",
        runtimeMode: "full-access",
      });
      yield* provider.startSession(claudeThreadId, {
        provider: CLAUDE_AGENT_DRIVER,
        providerInstanceId: claudeAgentInstanceId,
        threadId: claudeThreadId,
        cwd: "/tmp/project-shutdown-claude",
        runtimeMode: "full-access",
      });
    }).pipe(Effect.provide(providerServices));

    const runningBindings = yield* directory.listBindings();
    assert.deepEqual(
      runningBindings.map((binding) => binding.status),
      ["running", "running"],
    );

    // Starting a session issues the thread's MCP credential, so read the token
    // the service itself minted rather than planting one.
    const mcpConfig = McpProviderSession.readMcpProviderSession(codexThreadId);
    assert.equal(mcpConfig !== undefined, true);
    const mcpToken = (mcpConfig?.authorizationHeader ?? "").replace(/^Bearer\s+/, "");
    assert.equal(
      yield* Effect.map(mcpRegistry.resolve(mcpToken), (scope) => scope !== undefined),
      true,
    );

    const closeExit = yield* Scope.close(providerScope, Exit.void).pipe(Effect.exit);
    assert.equal(Exit.isSuccess(closeExit), true);

    assert.equal(codex.stopAll.mock.calls.length, 1);
    assert.equal(claude.stopAll.mock.calls.length, 1);

    const stoppedBindings = yield* directory.listBindings();
    assert.equal(stoppedBindings.length, 2);
    assert.deepEqual(
      stoppedBindings.map((binding) => binding.status),
      ["stopped", "stopped"],
    );
    assert.equal(yield* mcpRegistry.resolve(mcpToken), undefined);
    assert.equal(McpProviderSession.readMcpProviderSession(codexThreadId), undefined);

    yield* Scope.close(outerScope, Exit.void);
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        McpProviderSession.clearAllMcpProviderSessions();
      }),
    ),
  ),
);

function makeEnvironmentAuthDouble() {
  const issued: Array<{
    readonly scopes: ReadonlyArray<string> | undefined;
    readonly label: string | undefined;
  }> = [];
  const revoked: Array<AuthSessionId> = [];
  let counter = 0;
  const service = EnvironmentAuth.EnvironmentAuth.of({
    issueSession: (
      input?: Parameters<EnvironmentAuth.EnvironmentAuth["Service"]["issueSession"]>[0],
    ) =>
      Effect.sync((): EnvironmentAuth.IssuedBearerSession => {
        counter += 1;
        issued.push({ scopes: input?.scopes, label: input?.label });
        return {
          sessionId: AuthSessionId.make(`t3-auth-session-${counter}`),
          token: `t3-token-${counter}`,
          method: "bearer-access-token",
          scopes: input?.scopes ?? [],
          subject: "t3-test",
          client: { deviceType: "bot" },
          expiresAt: DateTime.makeUnsafe(0),
        };
      }),
    revokeSession: (sessionId: AuthSessionId) =>
      Effect.sync(() => {
        revoked.push(sessionId);
        return true;
      }),
  } as unknown as EnvironmentAuth.EnvironmentAuth["Service"]);
  return {
    layer: Layer.succeed(EnvironmentAuth.EnvironmentAuth, service),
    issued,
    revoked,
  };
}

function makeT3EnvironmentTestLayers(auth: ReturnType<typeof makeEnvironmentAuthDouble>) {
  const codex = makeFakeCodexAdapter();
  const registry = makeAdapterRegistryMock({
    [CODEX_DRIVER]: codex.adapter,
  });
  const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
    Layer.provide(SqlitePersistenceMemory),
  );
  const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));
  const providerLayer = makeProviderServiceLive().pipe(
    Layer.provide(Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, registry)),
    Layer.provide(directoryLayer),
    Layer.provide(defaultServerSettingsLayer),
    Layer.provide(presentFileSystemLayer),
    Layer.provide(auth.layer),
    Layer.provide(AnalyticsService.layerTest),
    Layer.provide(EpicWorkerScopeRegistry.layer),
    Layer.provide(EpicSubagentRegistry.layer),
    Layer.provide(
      Layer.succeed(
        ProviderEventLoggers.ProviderEventLoggers,
        ProviderEventLoggers.NoOpProviderEventLoggers,
      ),
    ),
  );
  return { codex, providerLayer };
}

const setTestMcpProviderSession = (threadId: ThreadId) => {
  McpProviderSession.setMcpProviderSession({
    environmentId: EnvironmentId.make("env-1"),
    threadId,
    providerSessionId: "mcp-session-1",
    providerInstanceId: codexInstanceId,
    endpoint: "http://127.0.0.1:3773/mcp",
    authorizationHeader: "Bearer mcp-token",
  });
};

it.effect(
  "ProviderServiceLive injects t3Environment when MCP session and project context exist",
  () => {
    const threadId = asThreadId("thread-t3-env");
    return Effect.gen(function* () {
      const auth = makeEnvironmentAuthDouble();
      const { codex, providerLayer } = makeT3EnvironmentTestLayers(auth);
      setTestMcpProviderSession(threadId);

      yield* Effect.gen(function* () {
        const provider = yield* ProviderService.ProviderService;
        yield* provider.startSession(threadId, {
          threadId,
          providerInstanceId: codexInstanceId,
          runtimeMode: "full-access",
          projectId: ProjectId.make("project-1"),
          workspaceRoot: "/tmp/workspace",
        });
      }).pipe(Effect.provide(Layer.merge(providerLayer, NodeServices.layer)));

      const startInput = codex.startSession.mock.calls.at(-1)?.[0];
      assert.deepEqual(startInput?.t3Environment, {
        serverUrl: "http://127.0.0.1:3773",
        environmentId: EnvironmentId.make("env-1"),
        projectId: ProjectId.make("project-1"),
        workspaceRoot: "/tmp/workspace",
        threadId,
        token: "t3-token-1",
      });
      assert.deepEqual(auth.issued, [
        {
          scopes: ["orchestration:read", "orchestration:operate"],
          label: `agent-thread-${threadId}`,
        },
      ]);
    }).pipe(
      Effect.ensuring(Effect.sync(() => McpProviderSession.clearMcpProviderSession(threadId))),
    );
  },
);

it.effect("ProviderServiceLive omits t3Environment when no MCP session exists", () =>
  Effect.gen(function* () {
    const threadId = asThreadId("thread-t3-env-no-mcp");
    const auth = makeEnvironmentAuthDouble();
    const { codex, providerLayer } = makeT3EnvironmentTestLayers(auth);

    yield* Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      yield* provider.startSession(threadId, {
        threadId,
        providerInstanceId: codexInstanceId,
        runtimeMode: "full-access",
        projectId: ProjectId.make("project-1"),
        workspaceRoot: "/tmp/workspace",
      });
    }).pipe(Effect.provide(Layer.merge(providerLayer, NodeServices.layer)));

    const startInput = codex.startSession.mock.calls.at(-1)?.[0];
    assert.equal(startInput?.t3Environment, undefined);
    assert.equal(auth.issued.length, 0);
  }),
);

it.effect("ProviderServiceLive omits t3Environment when project context is absent", () => {
  const threadId = asThreadId("thread-t3-env-no-project");
  return Effect.gen(function* () {
    const auth = makeEnvironmentAuthDouble();
    const { codex, providerLayer } = makeT3EnvironmentTestLayers(auth);
    setTestMcpProviderSession(threadId);

    yield* Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      yield* provider.startSession(threadId, {
        threadId,
        providerInstanceId: codexInstanceId,
        runtimeMode: "full-access",
      });
    }).pipe(Effect.provide(Layer.merge(providerLayer, NodeServices.layer)));

    const startInput = codex.startSession.mock.calls.at(-1)?.[0];
    assert.equal(startInput?.t3Environment, undefined);
    assert.equal(auth.issued.length, 0);
  }).pipe(Effect.ensuring(Effect.sync(() => McpProviderSession.clearMcpProviderSession(threadId))));
});

it.effect("ProviderServiceLive revokes the t3Environment token when the session stops", () => {
  const threadId = asThreadId("thread-t3-env-stop");
  return Effect.gen(function* () {
    const auth = makeEnvironmentAuthDouble();
    const { providerLayer } = makeT3EnvironmentTestLayers(auth);
    setTestMcpProviderSession(threadId);

    yield* Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      yield* provider.startSession(threadId, {
        threadId,
        providerInstanceId: codexInstanceId,
        runtimeMode: "full-access",
        projectId: ProjectId.make("project-1"),
        workspaceRoot: "/tmp/workspace",
      });
      yield* provider.stopSession({ threadId });
    }).pipe(Effect.provide(Layer.merge(providerLayer, NodeServices.layer)));

    assert.deepEqual(auth.revoked, [AuthSessionId.make("t3-auth-session-1")]);
  }).pipe(Effect.ensuring(Effect.sync(() => McpProviderSession.clearMcpProviderSession(threadId))));
});

it.effect("ProviderServiceLive revokes the t3Environment token when session start fails", () => {
  const threadId = asThreadId("thread-t3-env-start-fails");
  return Effect.gen(function* () {
    const auth = makeEnvironmentAuthDouble();
    const { codex, providerLayer } = makeT3EnvironmentTestLayers(auth);
    setTestMcpProviderSession(threadId);
    codex.startSession.mockImplementationOnce(() =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: String(CODEX_DRIVER),
          method: "startSession",
          detail: "simulated start failure",
        }),
      ),
    );

    const failure = yield* Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      return yield* provider.startSession(threadId, {
        threadId,
        providerInstanceId: codexInstanceId,
        runtimeMode: "full-access",
        projectId: ProjectId.make("project-1"),
        workspaceRoot: "/tmp/workspace",
      });
    }).pipe(Effect.flip, Effect.provide(Layer.merge(providerLayer, NodeServices.layer)));

    assert.equal(failure._tag, "ProviderAdapterRequestError");
    assert.deepEqual(auth.revoked, [AuthSessionId.make("t3-auth-session-1")]);
  }).pipe(Effect.ensuring(Effect.sync(() => McpProviderSession.clearMcpProviderSession(threadId))));
});

it.effect("ProviderServiceLive rejects new sessions for disabled providers", () =>
  Effect.gen(function* () {
    const codex = makeFakeCodexAdapter();
    const claude = makeFakeCodexAdapter(CLAUDE_AGENT_DRIVER);
    const registryBase = makeAdapterRegistryMock({
      [CODEX_DRIVER]: codex.adapter,
      [CLAUDE_AGENT_DRIVER]: claude.adapter,
    });
    const registry: ProviderAdapterRegistry.ProviderAdapterRegistry["Service"] = {
      ...registryBase,
      getInstanceInfo: (instanceId) =>
        instanceId === claudeAgentInstanceId
          ? Effect.succeed({
              instanceId,
              driverKind: CLAUDE_AGENT_DRIVER,
              displayName: undefined,
              enabled: false,
              continuationIdentity: {
                driverKind: CLAUDE_AGENT_DRIVER,
                continuationKey: "claudeAgent:instance:claudeAgent",
              },
            })
          : registryBase.getInstanceInfo(instanceId),
    };
    const providerAdapterLayer = Layer.succeed(
      ProviderAdapterRegistry.ProviderAdapterRegistry,
      registry,
    );
    const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
      Layer.provide(SqlitePersistenceMemory),
    );
    const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));
    const providerLayer = makeProviderServiceLiveForTest().pipe(
      Layer.provide(providerAdapterLayer),
      Layer.provide(directoryLayer),
      Layer.provide(defaultServerSettingsLayer),
      Layer.provide(AnalyticsService.layerTest),
      Layer.provide(
        Layer.succeed(
          ProviderEventLoggers.ProviderEventLoggers,
          ProviderEventLoggers.NoOpProviderEventLoggers,
        ),
      ),
    );

    const failure = yield* Effect.flip(
      Effect.gen(function* () {
        const provider = yield* ProviderService.ProviderService;
        return yield* provider.startSession(asThreadId("thread-disabled"), {
          provider: ProviderDriverKind.make("claudeAgent"),
          providerInstanceId: claudeAgentInstanceId,
          threadId: asThreadId("thread-disabled"),
          runtimeMode: "full-access",
        });
      }).pipe(Effect.provide(providerLayer)),
    );

    assert.instanceOf(failure, ProviderValidationError);
    assert.include(failure.issue, "Provider instance 'claudeAgent' is disabled");
    assert.equal(claude.startSession.mock.calls.length, 0);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "ProviderServiceLive allows enabled custom instances when legacy driver is disabled",
  () =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("codex_personal");
      const driverKind = CODEX_DRIVER;
      const codex = makeFakeCodexAdapter();
      const unsupported = () =>
        new ProviderUnsupportedError({
          provider: driverKind,
        });
      const registry: ProviderAdapterRegistry.ProviderAdapterRegistry["Service"] = {
        getByInstance: (requestedInstanceId) =>
          requestedInstanceId === instanceId
            ? Effect.succeed(codex.adapter)
            : Effect.fail(unsupported()),
        getInstanceInfo: (requestedInstanceId) =>
          requestedInstanceId === instanceId
            ? Effect.succeed({
                instanceId,
                driverKind,
                displayName: "Codex Personal",
                enabled: true,
                continuationIdentity: {
                  driverKind,
                  continuationKey: "codex:/Users/example/.codex",
                },
              })
            : Effect.fail(unsupported()),
        listInstances: () => Effect.succeed([instanceId]),
        listProviders: () => Effect.succeed([driverKind] as const),
        streamChanges: Stream.empty,
        subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), (pubsub) =>
          PubSub.subscribe(pubsub),
        ),
      };
      const providerAdapterLayer = Layer.succeed(
        ProviderAdapterRegistry.ProviderAdapterRegistry,
        registry,
      );
      const serverSettingsLayer = ServerSettings.ServerSettingsService.layerTest({
        providers: {
          codex: {
            enabled: false,
          },
        },
      });
      const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
        Layer.provide(SqlitePersistenceMemory),
      );
      const directoryLayer = ProviderSessionDirectoryLive.pipe(
        Layer.provide(runtimeRepositoryLayer),
      );
      const providerLayer = makeProviderServiceLiveForTest().pipe(
        Layer.provide(providerAdapterLayer),
        Layer.provide(directoryLayer),
        Layer.provide(serverSettingsLayer),
        Layer.provide(AnalyticsService.layerTest),
        Layer.provide(
          Layer.succeed(
            ProviderEventLoggers.ProviderEventLoggers,
            ProviderEventLoggers.NoOpProviderEventLoggers,
          ),
        ),
      );

      const session = yield* Effect.gen(function* () {
        const provider = yield* ProviderService.ProviderService;
        return yield* provider.startSession(asThreadId("thread-enabled-custom"), {
          provider: driverKind,
          providerInstanceId: instanceId,
          threadId: asThreadId("thread-enabled-custom"),
          runtimeMode: "full-access",
        });
      }).pipe(Effect.provide(providerLayer));

      assert.equal(session.providerInstanceId, instanceId);
      assert.equal(codex.startSession.mock.calls.length, 1);
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("ProviderServiceLive rejects new sessions for disabled custom instances", () =>
  Effect.gen(function* () {
    const instanceId = ProviderInstanceId.make("codex_personal");
    const driverKind = ProviderDriverKind.make("codex");
    const codex = makeFakeCodexAdapter();
    const unsupported = () =>
      new ProviderUnsupportedError({
        provider: ProviderDriverKind.make("codex"),
      });
    const registry: ProviderAdapterRegistry.ProviderAdapterRegistry["Service"] = {
      getByInstance: (requestedInstanceId) =>
        requestedInstanceId === instanceId
          ? Effect.succeed(codex.adapter)
          : Effect.fail(unsupported()),
      getInstanceInfo: (requestedInstanceId) =>
        requestedInstanceId === instanceId
          ? Effect.succeed({
              instanceId,
              driverKind,
              displayName: "Codex Personal",
              enabled: false,
              continuationIdentity: {
                driverKind,
                continuationKey: "codex:/Users/example/.codex",
              },
            })
          : Effect.fail(unsupported()),
      listInstances: () => Effect.succeed([instanceId]),
      listProviders: () => Effect.succeed([CODEX_DRIVER] as const),
      streamChanges: Stream.empty,
      subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), (pubsub) =>
        PubSub.subscribe(pubsub),
      ),
    };
    const providerAdapterLayer = Layer.succeed(
      ProviderAdapterRegistry.ProviderAdapterRegistry,
      registry,
    );
    const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
      Layer.provide(SqlitePersistenceMemory),
    );
    const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));
    const providerLayer = makeProviderServiceLiveForTest().pipe(
      Layer.provide(providerAdapterLayer),
      Layer.provide(directoryLayer),
      Layer.provide(defaultServerSettingsLayer),
      Layer.provide(AnalyticsService.layerTest),
      Layer.provide(
        Layer.succeed(
          ProviderEventLoggers.ProviderEventLoggers,
          ProviderEventLoggers.NoOpProviderEventLoggers,
        ),
      ),
    );

    const failure = yield* Effect.flip(
      Effect.gen(function* () {
        const provider = yield* ProviderService.ProviderService;
        return yield* provider.startSession(asThreadId("thread-disabled-instance"), {
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: instanceId,
          threadId: asThreadId("thread-disabled-instance"),
          runtimeMode: "full-access",
        });
      }).pipe(Effect.provide(providerLayer)),
    );

    assert.instanceOf(failure, ProviderValidationError);
    assert.include(failure.issue, "Provider instance 'codex_personal' is disabled");
    assert.equal(codex.startSession.mock.calls.length, 0);
  }).pipe(Effect.provide(NodeServices.layer)),
);

/**
 * Builds a single-adapter provider stack whose adapter declares `resume` as the
 * given mode, so a test can pin what callers read and what recovery does.
 */
function makeResumeCapabilityStack(resume: ProviderSessionResumeMode) {
  const codex = makeFakeCodexAdapter(CODEX_DRIVER, { sessionResume: resume });
  const registry = makeAdapterRegistryMock({ [CODEX_DRIVER]: codex.adapter });
  const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
    Layer.provide(SqlitePersistenceMemory),
  );
  const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));
  const providerLayer = makeProviderServiceLiveForTest().pipe(
    Layer.provide(Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, registry)),
    Layer.provide(directoryLayer),
    Layer.provide(defaultServerSettingsLayer),
    Layer.provide(AnalyticsService.layerTest),
    Layer.provide(
      Layer.succeed(
        ProviderEventLoggers.ProviderEventLoggers,
        ProviderEventLoggers.NoOpProviderEventLoggers,
      ),
    ),
  );
  return { codex, providerLayer };
}

it.effect("getCapabilities surfaces the adapter's declared session resume mode", () =>
  Effect.gen(function* () {
    const resumable = makeResumeCapabilityStack("cursor");
    const resumableCapabilities = yield* Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      return yield* provider.getCapabilities(codexInstanceId);
    }).pipe(Effect.provide(resumable.providerLayer));
    assert.equal(resumableCapabilities.sessionLifecycle.resume, "cursor");

    const unresumable = makeResumeCapabilityStack("unsupported");
    const unresumableCapabilities = yield* Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      return yield* provider.getCapabilities(codexInstanceId);
    }).pipe(Effect.provide(unresumable.providerLayer));
    assert.equal(unresumableCapabilities.sessionLifecycle.resume, "unsupported");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("refuses to recover a thread whose adapter cannot resume a session", () =>
  Effect.gen(function* () {
    const stack = makeResumeCapabilityStack("unsupported");
    const threadId = asThreadId("thread-resume-unsupported");

    const failure = yield* Effect.flip(
      Effect.gen(function* () {
        const provider = yield* ProviderService.ProviderService;
        // The session starts and persists a cursor, so the refusal below can
        // only come from the capability and not from a missing cursor.
        yield* provider.startSession(threadId, {
          provider: CODEX_DRIVER,
          providerInstanceId: codexInstanceId,
          threadId,
          cwd: "/tmp/project-resume-unsupported",
          runtimeMode: "full-access",
        });
        yield* stack.codex.stopAll();
        stack.codex.startSession.mockClear();

        return yield* provider.sendTurn({
          threadId,
          input: "resume",
          attachments: [],
        });
      }).pipe(Effect.provide(stack.providerLayer)),
    );

    assert.instanceOf(failure, ProviderValidationError);
    assert.include(failure.issue, "does not support resuming a session");
    assert.equal(stack.codex.startSession.mock.calls.length, 0);
    assert.equal(stack.codex.sendTurn.mock.calls.length, 0);
  }).pipe(Effect.provide(NodeServices.layer)),
);

interface RecordedAnalyticsEvent {
  readonly event: string;
  readonly properties: Readonly<Record<string, unknown>>;
}

/**
 * Builds a single-adapter stack whose adapter reports the given origin for any
 * start that carries a resume cursor, and captures every analytics event so a
 * test can read what the recovery claimed happened.
 */
function makeSessionOriginStack(resumeOrigin?: ProviderSessionOrigin) {
  const codex = makeFakeCodexAdapter(
    CODEX_DRIVER,
    undefined,
    resumeOrigin === undefined ? undefined : { resumeOrigin },
  );
  const registry = makeAdapterRegistryMock({ [CODEX_DRIVER]: codex.adapter });
  const analyticsEvents: Array<RecordedAnalyticsEvent> = [];
  const analyticsLayer = Layer.succeed(
    AnalyticsService.AnalyticsService,
    AnalyticsService.AnalyticsService.of({
      record: (event, properties) =>
        Effect.sync(() => {
          analyticsEvents.push({ event, properties: properties ?? {} });
        }),
      flush: Effect.void,
    }),
  );
  const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
    Layer.provide(SqlitePersistenceMemory),
  );
  const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));
  const providerLayer = Layer.mergeAll(
    makeProviderServiceLiveForTest().pipe(
      Layer.provide(Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, registry)),
      Layer.provide(directoryLayer),
      Layer.provide(defaultServerSettingsLayer),
      Layer.provide(analyticsLayer),
      Layer.provide(
        Layer.succeed(
          ProviderEventLoggers.ProviderEventLoggers,
          ProviderEventLoggers.NoOpProviderEventLoggers,
        ),
      ),
    ),
    directoryLayer,
  );
  return { codex, providerLayer, analyticsEvents };
}

/**
 * Starts a session, makes the adapter forget it, then sends a turn. That is
 * the recovery path: `sendTurn` has to restart the session from the persisted
 * cursor before it can route anything.
 */
const recoverThroughSendTurn = (
  threadId: ThreadId,
  stack: ReturnType<typeof makeSessionOriginStack>,
) =>
  Effect.gen(function* () {
    const provider = yield* ProviderService.ProviderService;
    const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
    yield* provider.startSession(threadId, {
      provider: CODEX_DRIVER,
      providerInstanceId: codexInstanceId,
      threadId,
      cwd: "/tmp/project-session-origin",
      runtimeMode: "full-access",
    });
    yield* stack.codex.stopAll();
    stack.codex.startSession.mockClear();

    yield* provider.sendTurn({ threadId, input: "continue", attachments: [] });

    assert.equal(stack.codex.startSession.mock.calls.length, 1);
    return yield* directory.getBinding(threadId);
  });

const recoveredAnalyticsEvent = (events: ReadonlyArray<RecordedAnalyticsEvent>) =>
  events.findLast((entry) => entry.event === "provider.session.recovered");

it.effect("warns and records the degraded origin when a resume starts an empty session", () => {
  const stack = makeSessionOriginStack("started-fresh");
  const logged: Array<unknown> = [];
  const logger = Logger.make<unknown, void>(({ message }) => {
    if (Array.isArray(message)) {
      logged.push(...message);
    } else {
      logged.push(message);
    }
  });
  const threadId = asThreadId("thread-origin-started-fresh");

  return Effect.gen(function* () {
    const binding = yield* recoverThroughSendTurn(threadId, stack).pipe(
      Effect.provide(stack.providerLayer),
    );

    assert.include(logged, "provider.session.started-fresh");
    const detail = logged.find(
      (entry): entry is Record<string, unknown> =>
        typeof entry === "object" && entry !== null && "threadId" in entry,
    );
    assert.exists(detail);
    assert.equal(detail.threadId, threadId);

    const recovered = recoveredAnalyticsEvent(stack.analyticsEvents);
    assert.exists(recovered);
    assert.equal(recovered.properties.strategy, "started-fresh");
    assert.equal(recovered.properties.recovery, "resume-thread");

    assert.equal(Option.isSome(binding), true);
    if (Option.isSome(binding)) {
      assert.equal(binding.value.sessionOrigin, "started-fresh");
    }
  }).pipe(
    Effect.provide(
      Layer.mergeAll(Logger.layer([logger], { mergeWithExisting: false }), NodeServices.layer),
    ),
  );
});

it.effect("records an unreported origin as unknown and never as resumed", () => {
  const stack = makeSessionOriginStack();
  const logged: Array<unknown> = [];
  const logger = Logger.make<unknown, void>(({ message }) => {
    if (Array.isArray(message)) {
      logged.push(...message);
    } else {
      logged.push(message);
    }
  });
  const threadId = asThreadId("thread-origin-unreported");

  return Effect.gen(function* () {
    const binding = yield* recoverThroughSendTurn(threadId, stack).pipe(
      Effect.provide(stack.providerLayer),
    );

    const recovered = recoveredAnalyticsEvent(stack.analyticsEvents);
    assert.exists(recovered);
    assert.equal(recovered.properties.strategy, "unknown");
    // A cursor was supplied and honoured as far as the caller can tell, but
    // the adapter said nothing. Silence is not proof of a continued session.
    assert.equal(recovered.properties.hasResumeCursor, true);
    assert.notInclude(logged, "provider.session.started-fresh");

    assert.equal(Option.isSome(binding), true);
    if (Option.isSome(binding)) {
      assert.equal(binding.value.sessionOrigin, undefined);
      const payload = binding.value.runtimePayload as Record<string, unknown>;
      assert.equal(payload.sessionOrigin, null);
    }
  }).pipe(
    Effect.provide(
      Layer.mergeAll(Logger.layer([logger], { mergeWithExisting: false }), NodeServices.layer),
    ),
  );
});

it.effect("round-trips a reported origin through runtimePayload onto the binding", () => {
  const stack = makeSessionOriginStack("resumed");
  const threadId = asThreadId("thread-origin-resumed");

  return Effect.gen(function* () {
    const binding = yield* recoverThroughSendTurn(threadId, stack).pipe(
      Effect.provide(stack.providerLayer),
    );

    assert.equal(Option.isSome(binding), true);
    if (Option.isSome(binding)) {
      const payload = binding.value.runtimePayload as Record<string, unknown>;
      assert.equal(payload.sessionOrigin, "resumed");
      assert.equal(binding.value.sessionOrigin, "resumed");
    }

    const recovered = recoveredAnalyticsEvent(stack.analyticsEvents);
    assert.exists(recovered);
    assert.equal(recovered.properties.strategy, "resumed");
  }).pipe(Effect.provide(NodeServices.layer));
});

const routing = makeProviderServiceLayer();

it.effect("ProviderServiceLive writes canonical events to the emitting thread segment", () =>
  Effect.gen(function* () {
    const codex = makeFakeCodexAdapter();
    const canonicalEvents: ProviderRuntimeEvent[] = [];
    const canonicalThreadIds: Array<string | null> = [];
    const registry = makeAdapterRegistryMock({
      [ProviderDriverKind.make("codex")]: codex.adapter,
    });
    const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
      Layer.provide(SqlitePersistenceMemory),
    );
    const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));
    const providerLayer = makeProviderServiceLiveForTest({
      canonicalEventLogger: {
        filePath: "memory://provider-canonical-events",
        write: (event, threadId) => {
          canonicalEvents.push(event as ProviderRuntimeEvent);
          canonicalThreadIds.push(threadId ?? null);
          return Effect.void;
        },
        close: () => Effect.void,
      },
    }).pipe(
      Layer.provide(Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, registry)),
      Layer.provide(directoryLayer),
      Layer.provide(defaultServerSettingsLayer),
      Layer.provide(AnalyticsService.layerTest),
      Layer.provide(
        Layer.succeed(
          ProviderEventLoggers.ProviderEventLoggers,
          ProviderEventLoggers.NoOpProviderEventLoggers,
        ),
      ),
    );

    yield* Effect.gen(function* () {
      yield* ProviderService.ProviderService;
      yield* advanceTestClock(10);
      codex.emit({
        eventId: asEventId("evt-canonical-thread-segment"),
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-canonical-thread-segment"),
        createdAt: "2026-01-01T00:00:00.000Z",
        type: "turn.completed",
        payload: {
          state: "completed",
        },
      });
      yield* advanceTestClock(20);
    }).pipe(Effect.provide(providerLayer));

    assert.equal(canonicalEvents.length, 1);
    assert.equal(canonicalEvents[0]?.threadId, "thread-canonical-thread-segment");
    assert.deepEqual(canonicalThreadIds, ["thread-canonical-thread-segment"]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("ProviderServiceLive keeps persisted resumable sessions on startup", () =>
  Effect.gen(function* () {
    const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-provider-service-"));
    const dbPath = NodePath.join(tempDir, "orchestration.sqlite");

    const codex = makeFakeCodexAdapter();
    const registry = makeAdapterRegistryMock({
      [ProviderDriverKind.make("codex")]: codex.adapter,
    });

    const persistenceLayer = makeSqlitePersistenceLive(dbPath);
    const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
      Layer.provide(persistenceLayer),
    );
    const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));

    yield* Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
      yield* directory.upsert({
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: ThreadId.make("thread-stale"),
      });
    }).pipe(Effect.provide(directoryLayer));

    const providerLayer = makeProviderServiceLiveForTest().pipe(
      Layer.provide(Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, registry)),
      Layer.provide(directoryLayer),
      Layer.provide(defaultServerSettingsLayer),
      Layer.provide(AnalyticsService.layerTest),
      Layer.provide(
        Layer.succeed(
          ProviderEventLoggers.ProviderEventLoggers,
          ProviderEventLoggers.NoOpProviderEventLoggers,
        ),
      ),
    );

    yield* ProviderService.ProviderService.pipe(Effect.provide(providerLayer));

    const persistedProvider = yield* Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
      return yield* directory.getProvider(asThreadId("thread-stale"));
    }).pipe(Effect.provide(directoryLayer));
    assert.equal(persistedProvider, "codex");

    const runtime = yield* Effect.gen(function* () {
      const repository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
      return yield* repository.getByThreadId({
        threadId: asThreadId("thread-stale"),
      });
    }).pipe(Effect.provide(runtimeRepositoryLayer));
    assert.equal(Option.isSome(runtime), true);

    const legacyTableRows = yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return yield* sql<{ readonly name: string }>`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table' AND name = 'provider_sessions'
      `;
    }).pipe(Effect.provide(persistenceLayer));
    assert.equal(legacyTableRows.length, 0);

    NodeFS.rmSync(tempDir, { recursive: true, force: true });
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "ProviderServiceLive restores rollback routing after restart using persisted thread mapping",
  () =>
    Effect.gen(function* () {
      const tempDir = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3-provider-service-restart-"),
      );
      const dbPath = NodePath.join(tempDir, "orchestration.sqlite");
      const persistenceLayer = makeSqlitePersistenceLive(dbPath);
      const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
        Layer.provide(persistenceLayer),
      );

      const firstCodex = makeFakeCodexAdapter();
      const firstRegistry = makeAdapterRegistryMock({
        [ProviderDriverKind.make("codex")]: firstCodex.adapter,
      });

      const firstDirectoryLayer = ProviderSessionDirectoryLive.pipe(
        Layer.provide(runtimeRepositoryLayer),
      );
      const firstProviderLayer = makeProviderServiceLiveForTest().pipe(
        Layer.provide(
          Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, firstRegistry),
        ),
        Layer.provide(firstDirectoryLayer),
        Layer.provide(defaultServerSettingsLayer),
        Layer.provide(AnalyticsService.layerTest),
        Layer.provide(
          Layer.succeed(
            ProviderEventLoggers.ProviderEventLoggers,
            ProviderEventLoggers.NoOpProviderEventLoggers,
          ),
        ),
      );
      const updatedResumeCursor = {
        threadId: asThreadId("thread-1"),
        resume: "resume-session-1",
        resumeSessionAt: "assistant-message-1",
        turnCount: 1,
      };

      const startedSession = yield* Effect.gen(function* () {
        const provider = yield* ProviderService.ProviderService;
        const threadId = asThreadId("thread-1");
        const session = yield* provider.startSession(threadId, {
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: codexInstanceId,
          cwd: "/tmp/project",
          runtimeMode: "full-access",
          threadId,
        });
        firstCodex.updateSession(threadId, (existing) => ({
          ...existing,
          status: "ready",
          resumeCursor: updatedResumeCursor,
          updatedAt: "2026-01-01T00:00:01.000Z",
        }));
        return session;
      }).pipe(Effect.provide(firstProviderLayer));

      const persistedAfterStopAll = yield* Effect.gen(function* () {
        const repository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
        return yield* repository.getByThreadId({
          threadId: startedSession.threadId,
        });
      }).pipe(Effect.provide(runtimeRepositoryLayer));
      assert.equal(Option.isSome(persistedAfterStopAll), true);
      if (Option.isSome(persistedAfterStopAll)) {
        assert.equal(persistedAfterStopAll.value.status, "stopped");
        assert.deepEqual(persistedAfterStopAll.value.resumeCursor, updatedResumeCursor);
      }

      const secondCodex = makeFakeCodexAdapter();
      const secondRegistry = makeAdapterRegistryMock({
        [ProviderDriverKind.make("codex")]: secondCodex.adapter,
      });
      const secondDirectoryLayer = ProviderSessionDirectoryLive.pipe(
        Layer.provide(runtimeRepositoryLayer),
      );
      const secondProviderLayer = makeProviderServiceLiveForTest().pipe(
        Layer.provide(
          Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, secondRegistry),
        ),
        Layer.provide(secondDirectoryLayer),
        Layer.provide(defaultServerSettingsLayer),
        Layer.provide(AnalyticsService.layerTest),
        Layer.provide(
          Layer.succeed(
            ProviderEventLoggers.ProviderEventLoggers,
            ProviderEventLoggers.NoOpProviderEventLoggers,
          ),
        ),
      );

      secondCodex.startSession.mockClear();
      secondCodex.rollbackThread.mockClear();

      yield* Effect.gen(function* () {
        const provider = yield* ProviderService.ProviderService;
        yield* provider.rollbackConversation({
          threadId: startedSession.threadId,
          numTurns: 1,
        });
      }).pipe(Effect.provide(secondProviderLayer));

      assert.equal(secondCodex.startSession.mock.calls.length, 1);
      const resumedStartInput = secondCodex.startSession.mock.calls[0]?.[0];
      assert.equal(typeof resumedStartInput === "object" && resumedStartInput !== null, true);
      if (resumedStartInput && typeof resumedStartInput === "object") {
        const startPayload = resumedStartInput as {
          provider?: string;
          cwd?: string;
          resumeCursor?: unknown;
          threadId?: string;
        };
        assert.equal(startPayload.provider, "codex");
        assert.equal(startPayload.cwd, "/tmp/project");
        assert.deepEqual(startPayload.resumeCursor, updatedResumeCursor);
        assert.equal(startPayload.threadId, startedSession.threadId);
      }
      assert.equal(secondCodex.rollbackThread.mock.calls.length, 1);
      const rollbackCall = secondCodex.rollbackThread.mock.calls[0];
      assert.equal(typeof rollbackCall?.[0], "string");
      assert.equal(rollbackCall?.[1], 1);

      NodeFS.rmSync(tempDir, { recursive: true, force: true });
    }).pipe(Effect.provide(NodeServices.layer)),
);

routing.layer("ProviderServiceLive routing", (it) => {
  it.effect("routes provider operations and rollback conversation", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;

      const session = yield* provider.startSession(asThreadId("thread-1"), {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: asThreadId("thread-1"),
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });
      assert.equal(session.provider, "codex");

      const sessions = yield* provider.listSessions();
      assert.equal(sessions.length, 1);

      yield* provider.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });
      assert.equal(routing.codex.sendTurn.mock.calls.length, 1);

      yield* provider.interruptTurn({ threadId: session.threadId });
      assert.deepEqual(routing.codex.interruptTurn.mock.calls, [[session.threadId, undefined]]);

      yield* provider.respondToRequest({
        threadId: session.threadId,
        requestId: asRequestId("req-1"),
        decision: "accept",
      });
      assert.deepEqual(routing.codex.respondToRequest.mock.calls, [
        [session.threadId, asRequestId("req-1"), "accept"],
      ]);

      yield* provider.respondToUserInput({
        threadId: session.threadId,
        requestId: asRequestId("req-user-input-1"),
        answers: {
          sandbox_mode: "workspace-write",
        },
      });
      assert.deepEqual(routing.codex.respondToUserInput.mock.calls, [
        [
          session.threadId,
          asRequestId("req-user-input-1"),
          {
            sandbox_mode: "workspace-write",
          },
        ],
      ]);

      yield* provider.rollbackConversation({
        threadId: session.threadId,
        numTurns: 0,
      });

      yield* provider.stopSession({ threadId: session.threadId });
      routing.codex.startSession.mockClear();
      routing.codex.sendTurn.mockClear();

      yield* provider.sendTurn({
        threadId: session.threadId,
        input: "after-stop",
        attachments: [],
      });

      assert.equal(routing.codex.startSession.mock.calls.length, 1);
      const resumedStartInput = routing.codex.startSession.mock.calls[0]?.[0];
      assert.equal(typeof resumedStartInput === "object" && resumedStartInput !== null, true);
      if (resumedStartInput && typeof resumedStartInput === "object") {
        const startPayload = resumedStartInput as {
          provider?: string;
          cwd?: string;
          resumeCursor?: unknown;
          threadId?: string;
        };
        assert.equal(startPayload.provider, "codex");
        assert.equal(startPayload.cwd, "/tmp/project");
        assert.deepEqual(startPayload.resumeCursor, session.resumeCursor);
        assert.equal(startPayload.threadId, session.threadId);
      }
      assert.equal(routing.codex.sendTurn.mock.calls.length, 1);
    }),
  );

  it.effect("recovers stale persisted sessions for rollback by resuming thread identity", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;

      const initial = yield* provider.startSession(asThreadId("thread-1"), {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: asThreadId("thread-1"),
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });
      yield* routing.codex.stopSession(initial.threadId);
      routing.codex.startSession.mockClear();
      routing.codex.rollbackThread.mockClear();

      yield* provider.rollbackConversation({
        threadId: initial.threadId,
        numTurns: 1,
      });

      assert.equal(routing.codex.startSession.mock.calls.length, 1);
      const resumedStartInput = routing.codex.startSession.mock.calls[0]?.[0];
      assert.equal(typeof resumedStartInput === "object" && resumedStartInput !== null, true);
      if (resumedStartInput && typeof resumedStartInput === "object") {
        const startPayload = resumedStartInput as {
          provider?: string;
          cwd?: string;
          resumeCursor?: unknown;
          threadId?: string;
        };
        assert.equal(startPayload.provider, "codex");
        assert.equal(startPayload.cwd, "/tmp/project");
        assert.deepEqual(startPayload.resumeCursor, initial.resumeCursor);
        assert.equal(startPayload.threadId, initial.threadId);
      }
      assert.equal(routing.codex.rollbackThread.mock.calls.length, 1);
      const rollbackCall = routing.codex.rollbackThread.mock.calls[0];
      assert.equal(rollbackCall?.[1], 1);
    }),
  );

  it.effect("persists a resume cursor returned by rollback without changing binding state", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
      const runtimeRepository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
      const threadId = asThreadId("thread-rollback-cursor");
      const initialResumeCursor = { opaque: "resume-before-rollback" };
      const updatedResumeCursor = { opaque: "resume-after-rollback" };
      const modelSelection = createModelSelection(codexInstanceId, "gpt-5.4", [
        { id: "reasoningEffort", value: "high" },
      ]);
      const runtimePayload = {
        cwd: "/tmp/project-rollback-cursor",
        model: "gpt-5.4",
        activeTurnId: "turn-before-rollback",
        lastError: "provider exited",
        modelSelection,
        t3EnvironmentContext: {
          projectId: ProjectId.make("project-rollback-cursor"),
          workspaceRoot: "/tmp/project-rollback-cursor",
        },
      };

      yield* provider.startSession(threadId, {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        cwd: "/tmp/project-rollback-cursor",
        modelSelection,
        resumeCursor: initialResumeCursor,
        runtimeMode: "approval-required",
      });
      yield* directory.upsert({
        threadId,
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        adapterKey: "codex-rollback-adapter",
        runtimeMode: "approval-required",
        status: "error",
        resumeCursor: initialResumeCursor,
        runtimePayload,
      });
      routing.codex.rollbackThread.mockImplementationOnce(() =>
        Effect.succeed({ threadId, turns: [], resumeCursor: updatedResumeCursor }),
      );

      yield* provider.rollbackConversation({ threadId, numTurns: 1 });

      const persisted = yield* runtimeRepository.getByThreadId({ threadId });
      assert.equal(Option.isSome(persisted), true);
      if (Option.isSome(persisted)) {
        assert.equal(persisted.value.providerName, CODEX_DRIVER);
        assert.equal(persisted.value.providerInstanceId, codexInstanceId);
        assert.equal(persisted.value.adapterKey, "codex-rollback-adapter");
        assert.equal(persisted.value.runtimeMode, "approval-required");
        assert.equal(persisted.value.status, "error");
        assert.deepEqual(persisted.value.resumeCursor, updatedResumeCursor);
        // The `startSession` above wrote `sessionOrigin: null` — the fake
        // adapter reports no origin — and the continuation identity, and the
        // payload merge keeps both.
        assert.deepEqual(persisted.value.runtimePayload, {
          ...runtimePayload,
          sessionOrigin: null,
          continuationIdentity: {
            driverKind: CODEX_DRIVER,
            continuationKey: `${CODEX_DRIVER}:instance:${codexInstanceId}`,
          },
        });
      }
    }),
  );

  it.effect("preserves the resume cursor and binding when rollback omits a cursor", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
      const runtimeRepository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
      const threadId = asThreadId("thread-rollback-without-cursor");
      const initialResumeCursor = { opaque: "resume-before-rollback" };
      const runtimePayload = {
        cwd: "/tmp/project-rollback-without-cursor",
        model: "gpt-5.4-mini",
        activeTurnId: null,
        lastError: null,
        modelSelection: createModelSelection(codexInstanceId, "gpt-5.4-mini", []),
        t3EnvironmentContext: {
          projectId: ProjectId.make("project-rollback-without-cursor"),
          workspaceRoot: "/tmp/project-rollback-without-cursor",
        },
      };

      yield* provider.startSession(threadId, {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        cwd: "/tmp/project-rollback-without-cursor",
        resumeCursor: initialResumeCursor,
        runtimeMode: "auto-accept-edits",
      });
      yield* directory.upsert({
        threadId,
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        adapterKey: "codex-rollback-omission-adapter",
        runtimeMode: "auto-accept-edits",
        status: "stopped",
        resumeCursor: initialResumeCursor,
        runtimePayload,
      });

      yield* provider.rollbackConversation({ threadId, numTurns: 1 });

      const persisted = yield* runtimeRepository.getByThreadId({ threadId });
      assert.equal(Option.isSome(persisted), true);
      if (Option.isSome(persisted)) {
        assert.equal(persisted.value.providerName, CODEX_DRIVER);
        assert.equal(persisted.value.providerInstanceId, codexInstanceId);
        assert.equal(persisted.value.adapterKey, "codex-rollback-omission-adapter");
        assert.equal(persisted.value.runtimeMode, "auto-accept-edits");
        assert.equal(persisted.value.status, "stopped");
        assert.deepEqual(persisted.value.resumeCursor, initialResumeCursor);
        // Same as above: the start persisted a null origin and the continuation
        // identity before this upsert.
        assert.deepEqual(persisted.value.runtimePayload, {
          ...runtimePayload,
          sessionOrigin: null,
          continuationIdentity: {
            driverKind: CODEX_DRIVER,
            continuationKey: `${CODEX_DRIVER}:instance:${codexInstanceId}`,
          },
        });
      }
    }),
  );

  it.effect("checks adapter session liveness without recovery", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const initial = yield* provider.startSession(asThreadId("thread-liveness"), {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: asThreadId("thread-liveness"),
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });

      assert.equal(yield* provider.hasLiveSession(initial.threadId), true);

      yield* routing.codex.stopSession(initial.threadId);
      routing.codex.startSession.mockClear();

      assert.equal(yield* provider.hasLiveSession(initial.threadId), false);
      assert.equal(routing.codex.startSession.mock.calls.length, 0);
    }),
  );

  it.effect("preserves the persisted binding when stopping a session", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const runtimeRepository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;

      const initial = yield* provider.startSession(asThreadId("thread-reap-preserve"), {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: asThreadId("thread-reap-preserve"),
        cwd: "/tmp/project-reap-preserve",
        runtimeMode: "full-access",
      });

      yield* provider.stopSession({ threadId: initial.threadId });

      const persistedAfterStop = yield* runtimeRepository.getByThreadId({
        threadId: initial.threadId,
      });
      assert.equal(Option.isSome(persistedAfterStop), true);
      if (Option.isSome(persistedAfterStop)) {
        assert.equal(persistedAfterStop.value.status, "stopped");
        assert.deepEqual(persistedAfterStop.value.resumeCursor, initial.resumeCursor);
      }

      routing.codex.startSession.mockClear();
      routing.codex.sendTurn.mockClear();

      yield* provider.sendTurn({
        threadId: initial.threadId,
        input: "resume after reap",
        attachments: [],
      });

      assert.equal(routing.codex.startSession.mock.calls.length, 1);
      const resumedStartInput = routing.codex.startSession.mock.calls[0]?.[0];
      assert.equal(typeof resumedStartInput === "object" && resumedStartInput !== null, true);
      if (resumedStartInput && typeof resumedStartInput === "object") {
        const startPayload = resumedStartInput as {
          provider?: string;
          cwd?: string;
          resumeCursor?: unknown;
          threadId?: string;
        };
        assert.equal(startPayload.provider, "codex");
        assert.equal(startPayload.cwd, "/tmp/project-reap-preserve");
        assert.deepEqual(startPayload.resumeCursor, initial.resumeCursor);
        assert.equal(startPayload.threadId, initial.threadId);
      }
      assert.equal(routing.codex.sendTurn.mock.calls.length, 1);
    }),
  );

  // A restart leaves a binding in exactly this shape: written by a process
  // that is gone, then stopped by the reaper's boot pass, which preserves the
  // resume cursor. Nothing in this process ever started that session, so the
  // next turn has to recover it rather than open a blank one — that recovery
  // is what lets an interrupted epic iteration continue its own agent session.
  //
  // The neighbouring recovery tests all call `startSession` first, so the
  // adapter still knows the thread. This one never does; the persisted binding
  // is the only evidence the session ever existed.
  //
  // The strategy is asserted through the adapter, not through analytics:
  // `provider.session.recovered` is PostHog-only and no-op in these tests, but
  // `adopt-existing` calls no `startSession` at all, so one `startSession` call
  // carrying the persisted cursor can only be the resume path.
  it.effect("resumes a binding that boot reconciliation stopped", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
      const threadId = asThreadId("thread-boot-reconciled");
      const resumeCursor = { opaque: "resume-after-boot" };

      yield* directory.upsert({
        threadId,
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        adapterKey: "codex-boot-reconciled-adapter",
        runtimeMode: "full-access",
        status: "stopped",
        resumeCursor,
        runtimePayload: {
          cwd: "/tmp/project-boot-reconciled",
          model: "gpt-5.4",
          activeTurnId: null,
          // `BOOT_RECONCILE_STOP_REASON` in `ProviderSessionReaper.ts`.
          lastError: "session interrupted: server restarted while the session was running",
          t3EnvironmentContext: {
            projectId: ProjectId.make("project-boot-reconciled"),
            workspaceRoot: "/tmp/project-boot-reconciled",
          },
        },
      });

      routing.codex.startSession.mockClear();
      routing.codex.sendTurn.mockClear();

      yield* provider.sendTurn({
        threadId,
        input: "first turn after the restart",
        attachments: [],
      });

      assert.equal(routing.codex.startSession.mock.calls.length, 1);
      const resumedStartInput = routing.codex.startSession.mock.calls[0]?.[0];
      assert.equal(typeof resumedStartInput === "object" && resumedStartInput !== null, true);
      if (resumedStartInput && typeof resumedStartInput === "object") {
        const startPayload = resumedStartInput as {
          provider?: string;
          cwd?: string;
          resumeCursor?: unknown;
          threadId?: string;
        };
        // The same conversation: original cursor, original thread, original cwd.
        assert.equal(startPayload.provider, "codex");
        assert.equal(startPayload.threadId, threadId);
        assert.deepEqual(startPayload.resumeCursor, resumeCursor);
        assert.equal(startPayload.cwd, "/tmp/project-boot-reconciled");
      }
      assert.equal(routing.codex.sendTurn.mock.calls.length, 1);
    }),
  );

  it.effect("routes explicit claudeAgent provider session starts to the claude adapter", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;

      const session = yield* provider.startSession(asThreadId("thread-claude"), {
        provider: ProviderDriverKind.make("claudeAgent"),
        providerInstanceId: claudeAgentInstanceId,
        threadId: asThreadId("thread-claude"),
        cwd: "/tmp/project-claude",
        runtimeMode: "full-access",
      });

      assert.equal(session.provider, "claudeAgent");
      assert.equal(routing.claude.startSession.mock.calls.length, 1);
      const startInput = routing.claude.startSession.mock.calls[0]?.[0];
      assert.equal(typeof startInput === "object" && startInput !== null, true);
      if (startInput && typeof startInput === "object") {
        const startPayload = startInput as {
          provider?: string;
          providerInstanceId?: ProviderInstanceId;
          cwd?: string;
        };
        assert.equal(startPayload.provider, "claudeAgent");
        assert.equal(startPayload.providerInstanceId, claudeAgentInstanceId);
        assert.equal(startPayload.cwd, "/tmp/project-claude");
      }
    }),
  );

  it.effect("dies when an active session conflicts with its persisted binding", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
      const threadId = asThreadId("thread-binding-mismatch");

      yield* provider.startSession(threadId, {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId,
        cwd: "/tmp/project-binding-mismatch",
        runtimeMode: "full-access",
      });
      yield* directory.upsert({
        threadId,
        provider: ProviderDriverKind.make("claudeAgent"),
        providerInstanceId: claudeAgentInstanceId,
        runtimeMode: "full-access",
      });

      const exit = yield* Effect.exit(provider.listSessions());
      assert.equal(Exit.hasDies(exit), true);
      yield* directory.upsert({
        threadId,
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        runtimeMode: "full-access",
      });
    }),
  );

  it.effect("stops stale sessions in other providers after a successful replacement start", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
      const threadId = asThreadId("thread-provider-replacement");

      const codexSession = yield* provider.startSession(threadId, {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId,
        cwd: "/tmp/project-provider-replacement",
        runtimeMode: "full-access",
      });

      routing.codex.stopSession.mockClear();
      routing.claude.stopSession.mockClear();

      const claudeSession = yield* provider.startSession(threadId, {
        provider: ProviderDriverKind.make("claudeAgent"),
        providerInstanceId: claudeAgentInstanceId,
        threadId,
        cwd: "/tmp/project-provider-replacement",
        runtimeMode: "full-access",
      });

      assert.equal(codexSession.provider, "codex");
      assert.equal(claudeSession.provider, "claudeAgent");
      assert.deepEqual(routing.codex.stopSession.mock.calls, [[threadId]]);
      assert.equal(routing.claude.stopSession.mock.calls.length, 0);

      const sessions = yield* provider.listSessions();
      assert.deepEqual(
        sessions
          .filter((session) => session.threadId === threadId)
          .map((session) => session.provider),
        ["claudeAgent"],
      );

      // Divergence pinned by t3code-f90.8: the stale stop goes straight to the
      // adapter, so it never writes a `"stopped"` binding the way
      // `ProviderService.stopSession` does. The thread's single binding is
      // rebound to the replacement instead. This asserts today's behaviour, not
      // a preference — a future change that routes the stale stop through
      // `stopSession` will land a `"stopped"` row and break this.
      const bindings = yield* directory.listBindings();
      const threadBindings = bindings.filter((binding) => binding.threadId === threadId);
      assert.deepEqual(
        threadBindings.map((binding) => `${binding.provider}:${binding.status}`),
        ["claudeAgent:running"],
      );
    }),
  );

  it.effect("recovers stale sessions for sendTurn using persisted cwd", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;

      const initial = yield* provider.startSession(asThreadId("thread-1"), {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: asThreadId("thread-1"),
        cwd: "/tmp/project-send-turn",
        runtimeMode: "full-access",
      });

      yield* routing.codex.stopAll();
      routing.codex.startSession.mockClear();
      routing.codex.sendTurn.mockClear();

      yield* provider.sendTurn({
        threadId: initial.threadId,
        input: "resume",
        attachments: [],
      });

      assert.equal(routing.codex.startSession.mock.calls.length, 1);
      const resumedStartInput = routing.codex.startSession.mock.calls[0]?.[0];
      assert.equal(typeof resumedStartInput === "object" && resumedStartInput !== null, true);
      if (resumedStartInput && typeof resumedStartInput === "object") {
        const startPayload = resumedStartInput as {
          provider?: string;
          cwd?: string;
          resumeCursor?: unknown;
          threadId?: string;
        };
        assert.equal(startPayload.provider, "codex");
        assert.equal(startPayload.cwd, "/tmp/project-send-turn");
        assert.deepEqual(startPayload.resumeCursor, initial.resumeCursor);
        assert.equal(startPayload.threadId, initial.threadId);
      }
      assert.equal(routing.codex.sendTurn.mock.calls.length, 1);
    }),
  );

  it.effect("recovers stale claudeAgent sessions for sendTurn using persisted cwd", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;

      const initial = yield* provider.startSession(asThreadId("thread-claude-send-turn"), {
        provider: ProviderDriverKind.make("claudeAgent"),
        providerInstanceId: claudeAgentInstanceId,
        threadId: asThreadId("thread-claude-send-turn"),
        cwd: "/tmp/project-claude-send-turn",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-opus-4-6",
          [{ id: "effort", value: "max" }],
        ),
        runtimeMode: "full-access",
      });

      yield* routing.claude.stopAll();
      routing.claude.startSession.mockClear();
      routing.claude.sendTurn.mockClear();

      yield* provider.sendTurn({
        threadId: initial.threadId,
        input: "resume with claude",
        attachments: [],
      });

      assert.equal(routing.claude.startSession.mock.calls.length, 1);
      const resumedStartInput = routing.claude.startSession.mock.calls[0]?.[0];
      assert.equal(typeof resumedStartInput === "object" && resumedStartInput !== null, true);
      if (resumedStartInput && typeof resumedStartInput === "object") {
        const startPayload = resumedStartInput as {
          provider?: string;
          cwd?: string;
          modelSelection?: unknown;
          resumeCursor?: unknown;
          threadId?: string;
        };
        assert.equal(startPayload.provider, "claudeAgent");
        assert.equal(startPayload.cwd, "/tmp/project-claude-send-turn");
        assert.deepEqual(
          startPayload.modelSelection,
          createModelSelection(ProviderInstanceId.make("claudeAgent"), "claude-opus-4-6", [
            { id: "effort", value: "max" },
          ]),
        );
        assert.deepEqual(startPayload.resumeCursor, initial.resumeCursor);
        assert.equal(startPayload.threadId, initial.threadId);
      }
      assert.equal(routing.claude.sendTurn.mock.calls.length, 1);
    }),
  );

  it.effect("lists no sessions after adapter runtime clears", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;

      yield* provider.startSession(asThreadId("thread-1"), {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: asThreadId("thread-1"),
        runtimeMode: "full-access",
      });
      yield* provider.startSession(asThreadId("thread-2"), {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: asThreadId("thread-2"),
        runtimeMode: "full-access",
      });

      yield* routing.codex.stopAll();
      yield* routing.claude.stopAll();

      const remaining = yield* provider.listSessions();
      assert.equal(remaining.length, 0);
    }),
  );

  it.effect("persists runtime status transitions in provider_session_runtime", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const runtimeRepository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;

      const threadId = asThreadId("thread-runtime-status");
      const session = yield* provider.startSession(threadId, {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId,
        runtimeMode: "full-access",
      });
      yield* provider.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      const runningRuntime = yield* runtimeRepository.getByThreadId({
        threadId: session.threadId,
      });
      assert.equal(Option.isSome(runningRuntime), true);
      if (Option.isSome(runningRuntime)) {
        assert.equal(runningRuntime.value.status, "running");
        assert.deepEqual(runningRuntime.value.resumeCursor, session.resumeCursor);
        const payload = runningRuntime.value.runtimePayload;
        assert.equal(payload !== null && typeof payload === "object", true);
        if (payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
          const runtimePayload = payload as {
            cwd: string;
            model: string | null;
            activeTurnId: string | null;
            lastError: string | null;
            lastRuntimeEvent: string | null;
          };
          assert.equal(runtimePayload.cwd, session.cwd);
          assert.equal(runtimePayload.model, null);
          assert.equal(runtimePayload.activeTurnId, `turn-${String(session.threadId)}`);
          assert.equal(runtimePayload.lastError, null);
          assert.equal(runtimePayload.lastRuntimeEvent, "provider.sendTurn");
        }
      }
    }),
  );

  it.effect("reuses persisted resume cursor when startSession is called after a restart", () =>
    Effect.gen(function* () {
      const tempDir = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3-provider-service-start-"),
      );
      const dbPath = NodePath.join(tempDir, "orchestration.sqlite");
      const persistenceLayer = makeSqlitePersistenceLive(dbPath);
      const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
        Layer.provide(persistenceLayer),
      );

      const firstClaude = makeFakeCodexAdapter(CLAUDE_AGENT_DRIVER);
      const firstRegistry = makeAdapterRegistryMock({
        [ProviderDriverKind.make("claudeAgent")]: firstClaude.adapter,
      });
      const firstDirectoryLayer = ProviderSessionDirectoryLive.pipe(
        Layer.provide(runtimeRepositoryLayer),
      );
      const firstProviderLayer = makeProviderServiceLiveForTest().pipe(
        Layer.provide(
          Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, firstRegistry),
        ),
        Layer.provide(firstDirectoryLayer),
        Layer.provide(defaultServerSettingsLayer),
        Layer.provide(AnalyticsService.layerTest),
        Layer.provide(
          Layer.succeed(
            ProviderEventLoggers.ProviderEventLoggers,
            ProviderEventLoggers.NoOpProviderEventLoggers,
          ),
        ),
      );

      const initial = yield* Effect.gen(function* () {
        const provider = yield* ProviderService.ProviderService;
        return yield* provider.startSession(asThreadId("thread-claude-start"), {
          provider: ProviderDriverKind.make("claudeAgent"),
          providerInstanceId: claudeAgentInstanceId,
          threadId: asThreadId("thread-claude-start"),
          cwd: "/tmp/project-claude-start",
          runtimeMode: "full-access",
        });
      }).pipe(Effect.provide(firstProviderLayer));

      yield* Effect.gen(function* () {
        const provider = yield* ProviderService.ProviderService;
        yield* provider.listSessions();
      }).pipe(Effect.provide(firstProviderLayer));

      const secondClaude = makeFakeCodexAdapter(CLAUDE_AGENT_DRIVER);
      const secondRegistry = makeAdapterRegistryMock({
        [ProviderDriverKind.make("claudeAgent")]: secondClaude.adapter,
      });
      const secondDirectoryLayer = ProviderSessionDirectoryLive.pipe(
        Layer.provide(runtimeRepositoryLayer),
      );
      const secondProviderLayer = makeProviderServiceLiveForTest().pipe(
        Layer.provide(
          Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, secondRegistry),
        ),
        Layer.provide(secondDirectoryLayer),
        Layer.provide(defaultServerSettingsLayer),
        Layer.provide(AnalyticsService.layerTest),
        Layer.provide(
          Layer.succeed(
            ProviderEventLoggers.ProviderEventLoggers,
            ProviderEventLoggers.NoOpProviderEventLoggers,
          ),
        ),
      );

      secondClaude.startSession.mockClear();

      yield* Effect.gen(function* () {
        const provider = yield* ProviderService.ProviderService;
        yield* provider.startSession(initial.threadId, {
          provider: ProviderDriverKind.make("claudeAgent"),
          providerInstanceId: claudeAgentInstanceId,
          threadId: initial.threadId,
          cwd: "/tmp/project-claude-start",
          runtimeMode: "full-access",
        });
      }).pipe(Effect.provide(secondProviderLayer));

      assert.equal(secondClaude.startSession.mock.calls.length, 1);
      const resumedStartInput = secondClaude.startSession.mock.calls[0]?.[0];
      assert.equal(typeof resumedStartInput === "object" && resumedStartInput !== null, true);
      if (resumedStartInput && typeof resumedStartInput === "object") {
        const startPayload = resumedStartInput as {
          provider?: string;
          cwd?: string;
          resumeCursor?: unknown;
          threadId?: string;
        };
        assert.equal(startPayload.provider, "claudeAgent");
        assert.equal(startPayload.cwd, "/tmp/project-claude-start");
        assert.deepEqual(startPayload.resumeCursor, initial.resumeCursor);
        assert.equal(startPayload.threadId, initial.threadId);
      }

      NodeFS.rmSync(tempDir, { recursive: true, force: true });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "reuses persisted cwd when startSession resumes a claude session without cwd input",
    () =>
      Effect.gen(function* () {
        const tempDir = NodeFS.mkdtempSync(
          NodePath.join(NodeOS.tmpdir(), "t3-provider-service-cwd-"),
        );
        const dbPath = NodePath.join(tempDir, "orchestration.sqlite");
        const persistenceLayer = makeSqlitePersistenceLive(dbPath);
        const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
          Layer.provide(persistenceLayer),
        );

        const firstClaude = makeFakeCodexAdapter(CLAUDE_AGENT_DRIVER);
        const firstRegistry = makeAdapterRegistryMock({
          [ProviderDriverKind.make("claudeAgent")]: firstClaude.adapter,
        });
        const firstDirectoryLayer = ProviderSessionDirectoryLive.pipe(
          Layer.provide(runtimeRepositoryLayer),
        );
        const firstProviderLayer = makeProviderServiceLiveForTest().pipe(
          Layer.provide(
            Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, firstRegistry),
          ),
          Layer.provide(firstDirectoryLayer),
          Layer.provide(defaultServerSettingsLayer),
          Layer.provide(AnalyticsService.layerTest),
          Layer.provide(
            Layer.succeed(
              ProviderEventLoggers.ProviderEventLoggers,
              ProviderEventLoggers.NoOpProviderEventLoggers,
            ),
          ),
        );

        const initial = yield* Effect.gen(function* () {
          const provider = yield* ProviderService.ProviderService;
          return yield* provider.startSession(asThreadId("thread-claude-cwd"), {
            provider: ProviderDriverKind.make("claudeAgent"),
            providerInstanceId: claudeAgentInstanceId,
            threadId: asThreadId("thread-claude-cwd"),
            cwd: "/tmp/project-claude-cwd",
            runtimeMode: "full-access",
          });
        }).pipe(Effect.provide(firstProviderLayer));

        const secondClaude = makeFakeCodexAdapter(CLAUDE_AGENT_DRIVER);
        const secondRegistry = makeAdapterRegistryMock({
          [ProviderDriverKind.make("claudeAgent")]: secondClaude.adapter,
        });
        const secondDirectoryLayer = ProviderSessionDirectoryLive.pipe(
          Layer.provide(runtimeRepositoryLayer),
        );
        const secondProviderLayer = makeProviderServiceLiveForTest().pipe(
          Layer.provide(
            Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, secondRegistry),
          ),
          Layer.provide(secondDirectoryLayer),
          Layer.provide(defaultServerSettingsLayer),
          Layer.provide(AnalyticsService.layerTest),
          Layer.provide(
            Layer.succeed(
              ProviderEventLoggers.ProviderEventLoggers,
              ProviderEventLoggers.NoOpProviderEventLoggers,
            ),
          ),
        );

        secondClaude.startSession.mockClear();

        yield* Effect.gen(function* () {
          const provider = yield* ProviderService.ProviderService;
          yield* provider.startSession(initial.threadId, {
            provider: ProviderDriverKind.make("claudeAgent"),
            providerInstanceId: claudeAgentInstanceId,
            threadId: initial.threadId,
            runtimeMode: "full-access",
          });
        }).pipe(Effect.provide(secondProviderLayer));

        assert.equal(secondClaude.startSession.mock.calls.length, 1);
        const resumedStartInput = secondClaude.startSession.mock.calls[0]?.[0];
        assert.equal(typeof resumedStartInput === "object" && resumedStartInput !== null, true);
        if (resumedStartInput && typeof resumedStartInput === "object") {
          const startPayload = resumedStartInput as {
            provider?: string;
            cwd?: string;
            resumeCursor?: unknown;
            threadId?: string;
          };
          assert.equal(startPayload.provider, "claudeAgent");
          assert.equal(startPayload.cwd, "/tmp/project-claude-cwd");
          assert.deepEqual(startPayload.resumeCursor, initial.resumeCursor);
          assert.equal(startPayload.threadId, initial.threadId);
        }

        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});

const workerScopeAttachment = makeProviderServiceLayer();
workerScopeAttachment.layer("ProviderServiceLive epic worker scope attachment", (it) => {
  it.effect("attaches the resolved worker scope to the adapter start input", () =>
    Effect.gen(function* () {
      const scopeRegistry = yield* EpicWorkerScopeRegistry;
      const provider = yield* ProviderService.ProviderService;
      const runId = EpicRunId.make("run-scope-attach");
      const threadId = asThreadId("thread-scope-attach");
      yield* scopeRegistry.setRunPreparation(runId, { scopeId: "scope-abc", active: true });
      yield* scopeRegistry.bindWorker({ runId, threadId, worker: "iteration-0" });

      yield* provider.startSession(threadId, {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId,
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });

      const startInput = workerScopeAttachment.codex.startSession.mock.calls.at(-1)?.[0];
      assert.deepEqual(startInput?.workerScope, { scopeId: "scope-abc", worker: "iteration-0" });
    }),
  );

  it.effect("omits the worker scope when the run's preparation is inactive", () =>
    Effect.gen(function* () {
      const scopeRegistry = yield* EpicWorkerScopeRegistry;
      const provider = yield* ProviderService.ProviderService;
      const runId = EpicRunId.make("run-scope-inactive");
      const threadId = asThreadId("thread-scope-inactive");
      yield* scopeRegistry.setRunPreparation(runId, { scopeId: "scope-inactive", active: false });
      yield* scopeRegistry.bindWorker({ runId, threadId, worker: "iteration-0" });

      yield* provider.startSession(threadId, {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId,
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });

      const startInput = workerScopeAttachment.codex.startSession.mock.calls.at(-1)?.[0];
      assert.equal(startInput?.workerScope, undefined);
    }),
  );

  it.effect("omits the worker scope for a thread with no binding", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const threadId = asThreadId("thread-scope-unbound");

      yield* provider.startSession(threadId, {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId,
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });

      const startInput = workerScopeAttachment.codex.startSession.mock.calls.at(-1)?.[0];
      assert.equal(startInput?.workerScope, undefined);
    }),
  );
});

const subagentAttachment = makeProviderServiceLayer();
subagentAttachment.layer("ProviderServiceLive epic subagent attachment", (it) => {
  const reviewer = {
    reviewer: { description: "Reviews code", prompt: "You are a reviewer", model: "fable" },
  };

  it.effect("attaches the resolved subagent definitions to the adapter start input", () =>
    Effect.gen(function* () {
      const subagentRegistry = yield* EpicSubagentRegistry;
      const provider = yield* ProviderService.ProviderService;
      const runId = EpicRunId.make("run-subagent-attach");
      const threadId = asThreadId("thread-subagent-attach");
      yield* subagentRegistry.bindThread({ runId, threadId, subagents: reviewer });

      yield* provider.startSession(threadId, {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId,
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });

      const startInput = subagentAttachment.codex.startSession.mock.calls.at(-1)?.[0];
      assert.deepEqual(startInput?.subagents, reviewer);
    }),
  );

  it.effect("omits the subagents for a thread with no binding", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const threadId = asThreadId("thread-subagent-unbound");

      yield* provider.startSession(threadId, {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId,
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });

      const startInput = subagentAttachment.codex.startSession.mock.calls.at(-1)?.[0];
      assert.equal(startInput?.subagents, undefined);
    }),
  );
});

const fanout = makeProviderServiceLayer();
fanout.layer("ProviderServiceLive fanout", (it) => {
  it.effect("fans out adapter turn completion events", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const session = yield* provider.startSession(asThreadId("thread-1"), {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: asThreadId("thread-1"),
        runtimeMode: "full-access",
      });

      const eventsRef = yield* Ref.make<Array<ProviderRuntimeEvent>>([]);
      const consumer = yield* Stream.runForEach(provider.streamEvents, (event) =>
        Ref.update(eventsRef, (current) => [...current, event]),
      ).pipe(Effect.forkChild);
      yield* advanceTestClock(50);

      const completedEvent: LegacyProviderRuntimeEvent = {
        type: "turn.completed",
        eventId: asEventId("evt-1"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        threadId: session.threadId,
        turnId: asTurnId("turn-1"),
        status: "completed",
      };

      fanout.codex.emit(completedEvent);
      yield* advanceTestClock(50);

      const events = yield* Ref.get(eventsRef);
      yield* Fiber.interrupt(consumer);

      assert.equal(
        events.some((entry) => entry.type === "turn.completed"),
        true,
      );
      assert.equal(
        events.some(
          (entry) =>
            entry.type === "turn.completed" && entry.providerInstanceId === codexInstanceId,
        ),
        true,
      );
    }),
  );

  it.effect("fans out canonical runtime events in emission order", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const session = yield* provider.startSession(asThreadId("thread-seq"), {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: asThreadId("thread-seq"),
        runtimeMode: "full-access",
      });

      const receivedRef = yield* Ref.make<Array<ProviderRuntimeEvent>>([]);
      const consumer = yield* Stream.take(provider.streamEvents, 3).pipe(
        Stream.runForEach((event) => Ref.update(receivedRef, (current) => [...current, event])),
        Effect.forkChild,
      );
      yield* advanceTestClock(50);

      fanout.codex.emit({
        type: "tool.started",
        eventId: asEventId("evt-seq-1"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        threadId: session.threadId,
        turnId: asTurnId("turn-1"),
        toolKind: "command",
        title: "Ran command",
      });
      fanout.codex.emit({
        type: "tool.completed",
        eventId: asEventId("evt-seq-2"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        threadId: session.threadId,
        turnId: asTurnId("turn-1"),
        toolKind: "command",
        title: "Ran command",
      });
      fanout.codex.emit({
        type: "turn.completed",
        eventId: asEventId("evt-seq-3"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        threadId: session.threadId,
        turnId: asTurnId("turn-1"),
        status: "completed",
      });

      yield* Fiber.join(consumer);
      const received = yield* Ref.get(receivedRef);
      assert.deepEqual(
        received.map((event) => event.eventId),
        [asEventId("evt-seq-1"), asEventId("evt-seq-2"), asEventId("evt-seq-3")],
      );
    }),
  );

  it.effect("keeps subscriber delivery ordered and isolates failing subscribers", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const session = yield* provider.startSession(asThreadId("thread-1"), {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: asThreadId("thread-1"),
        runtimeMode: "full-access",
      });

      const receivedByHealthy: string[] = [];
      const expectedEventIds = new Set<string>(["evt-ordered-1", "evt-ordered-2", "evt-ordered-3"]);
      const healthyFiber = yield* Stream.take(provider.streamEvents, 3).pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            receivedByHealthy.push(event.eventId);
          }),
        ),
        Effect.forkChild,
      );
      const failingFiber = yield* Stream.take(provider.streamEvents, 1).pipe(
        Stream.runForEach(() => Effect.fail("listener crash")),
        Effect.forkChild,
      );
      yield* advanceTestClock(50);

      const events: ReadonlyArray<LegacyProviderRuntimeEvent> = [
        {
          type: "tool.completed",
          eventId: asEventId("evt-ordered-1"),
          provider: ProviderDriverKind.make("codex"),
          createdAt: "2026-01-01T00:00:00.000Z",
          threadId: session.threadId,
          turnId: asTurnId("turn-1"),
          toolKind: "command",
          title: "Ran command",
          detail: "echo one",
        },
        {
          type: "message.delta",
          eventId: asEventId("evt-ordered-2"),
          provider: ProviderDriverKind.make("codex"),
          createdAt: "2026-01-01T00:00:00.000Z",
          threadId: session.threadId,
          turnId: asTurnId("turn-1"),
          delta: "hello",
        },
        {
          type: "turn.completed",
          eventId: asEventId("evt-ordered-3"),
          provider: ProviderDriverKind.make("codex"),
          createdAt: "2026-01-01T00:00:00.000Z",
          threadId: session.threadId,
          turnId: asTurnId("turn-1"),
          status: "completed",
        },
      ];

      for (const event of events) {
        fanout.codex.emit(event);
      }
      const failingResult = yield* Effect.result(Fiber.join(failingFiber));
      assert.equal(failingResult._tag, "Failure");
      yield* Fiber.join(healthyFiber);

      assert.deepEqual(
        receivedByHealthy.filter((eventId) => expectedEventIds.has(eventId)).slice(0, 3),
        ["evt-ordered-1", "evt-ordered-2", "evt-ordered-3"],
      );
    }),
  );

  it.effect("records provider metrics with the routed provider label", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;

      const session = yield* provider.startSession(asThreadId("thread-metrics"), {
        provider: ProviderDriverKind.make("claudeAgent"),
        providerInstanceId: claudeAgentInstanceId,
        threadId: asThreadId("thread-metrics"),
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });

      yield* provider.interruptTurn({ threadId: session.threadId });
      yield* provider.respondToRequest({
        threadId: session.threadId,
        requestId: asRequestId("req-metrics-1"),
        decision: "accept",
      });
      yield* provider.respondToUserInput({
        threadId: session.threadId,
        requestId: asRequestId("req-metrics-2"),
        answers: {
          sandbox_mode: "workspace-write",
        },
      });
      yield* provider.rollbackConversation({
        threadId: session.threadId,
        numTurns: 1,
      });
      yield* provider.stopSession({ threadId: session.threadId });

      const snapshots = yield* Metric.snapshot;

      assert.equal(
        hasMetricSnapshot(snapshots, "t3_provider_turns_total", {
          provider: ProviderDriverKind.make("claudeAgent"),
          operation: "interrupt",
          outcome: "success",
        }),
        true,
      );
      assert.equal(
        hasMetricSnapshot(snapshots, "t3_provider_turns_total", {
          provider: ProviderDriverKind.make("claudeAgent"),
          operation: "approval-response",
          outcome: "success",
        }),
        true,
      );
      assert.equal(
        hasMetricSnapshot(snapshots, "t3_provider_turns_total", {
          provider: ProviderDriverKind.make("claudeAgent"),
          operation: "user-input-response",
          outcome: "success",
        }),
        true,
      );
      assert.equal(
        hasMetricSnapshot(snapshots, "t3_provider_turns_total", {
          provider: ProviderDriverKind.make("claudeAgent"),
          operation: "rollback",
          outcome: "success",
        }),
        true,
      );
      assert.equal(
        hasMetricSnapshot(snapshots, "t3_provider_sessions_total", {
          provider: ProviderDriverKind.make("claudeAgent"),
          operation: "stop",
          outcome: "success",
        }),
        true,
      );
    }),
  );

  it.effect(
    "records sendTurn metrics with the resolved provider when modelSelection is omitted",
    () =>
      Effect.gen(function* () {
        const provider = yield* ProviderService.ProviderService;

        const session = yield* provider.startSession(asThreadId("thread-send-metrics"), {
          provider: ProviderDriverKind.make("claudeAgent"),
          providerInstanceId: claudeAgentInstanceId,
          threadId: asThreadId("thread-send-metrics"),
          cwd: "/tmp/project-send-metrics",
          runtimeMode: "full-access",
        });

        yield* provider.sendTurn({
          threadId: session.threadId,
          input: "hello",
          attachments: [],
        });

        const snapshots = yield* Metric.snapshot;

        assert.equal(
          hasMetricSnapshot(snapshots, "t3_provider_turns_total", {
            provider: ProviderDriverKind.make("claudeAgent"),
            operation: "send",
            outcome: "success",
          }),
          true,
        );
        assert.equal(
          hasMetricSnapshot(snapshots, "t3_provider_turn_duration", {
            provider: ProviderDriverKind.make("claudeAgent"),
            operation: "send",
          }),
          true,
        );
      }),
  );
});

const idleWatchdog = makeProviderServiceLayer({
  idleWatchdog: {
    defaultIdleThresholdMs: 1_000,
    idleThresholdMsByProvider: { codex: 100 },
    sweepIntervalMs: 10,
    controlCallTimeoutMs: 20,
    completionGraceMs: 50,
  },
});
idleWatchdog.layer("ProviderServiceLive idle watchdog", (it) => {
  const emitTurnStarted = (threadId: ThreadId, turnId: TurnId, eventId: string): void => {
    idleWatchdog.codex.emit({
      type: "turn.started",
      eventId: asEventId(eventId),
      provider: CODEX_DRIVER,
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId,
      turnId,
      payload: {},
    });
  };

  const emitTurnCompleted = (threadId: ThreadId, turnId: TurnId, eventId: string): void => {
    idleWatchdog.codex.emit({
      type: "turn.completed",
      eventId: asEventId(eventId),
      provider: CODEX_DRIVER,
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId,
      turnId,
      payload: { state: "completed" },
    });
  };

  const startEventCollector = Effect.fn("startIdleWatchdogEventCollector")(function* () {
    const events = yield* Ref.make<Array<ProviderRuntimeEvent>>([]);
    const fiber = yield* Stream.runForEach(
      (yield* ProviderService.ProviderService).streamEvents,
      (event) => Ref.update(events, (current) => [...current, event]),
    ).pipe(Effect.forkChild);
    yield* advanceTestClock(1);
    return { events, fiber } as const;
  });

  it.effect("interrupts and fails a silent open turn, then drops its late completion", () =>
    Effect.gen(function* () {
      const threadId = asThreadId("thread-idle-watchdog-silent");
      const turnId = asTurnId("turn-idle-watchdog-silent");
      const collector = yield* startEventCollector();
      idleWatchdog.codex.interruptTurn.mockClear();
      idleWatchdog.codex.stopSession.mockClear();

      emitTurnStarted(threadId, turnId, "evt-idle-started");
      yield* advanceTestClock(110);
      assert.equal(idleWatchdog.codex.interruptTurn.mock.calls.length, 1);

      yield* advanceTestClock(60);
      const beforeLateCompletion = yield* Ref.get(collector.events);
      const runtimeError = beforeLateCompletion.find((event) => event.type === "runtime.error");
      const failedCompletion = beforeLateCompletion.find(
        (event) => event.type === "turn.completed" && event.payload.state === "failed",
      );
      assert.equal(idleWatchdog.codex.stopSession.mock.calls.length, 1);
      assert.equal(runtimeError?.type, "runtime.error");
      assert.include(runtimeError?.payload.message ?? "", String(threadId));
      assert.include(runtimeError?.payload.message ?? "", String(turnId));
      assert.include(runtimeError?.payload.message ?? "", String(CODEX_DRIVER));
      assert.equal(failedCompletion?.type, "turn.completed");
      if (failedCompletion?.type === "turn.completed") {
        assert.include(failedCompletion.payload.errorMessage ?? "", "provider stream idle for");
      }

      emitTurnCompleted(threadId, turnId, "evt-idle-late-completion");
      yield* advanceTestClock(1);
      const afterLateCompletion = yield* Ref.get(collector.events);
      assert.equal(
        afterLateCompletion.filter(
          (event) => event.type === "turn.completed" && event.turnId === turnId,
        ).length,
        1,
      );
      yield* Fiber.interrupt(collector.fiber);
    }),
  );

  it.effect("does not trip while an approval request is open", () =>
    Effect.gen(function* () {
      const threadId = asThreadId("thread-idle-watchdog-request");
      const turnId = asTurnId("turn-idle-watchdog-request");
      idleWatchdog.codex.interruptTurn.mockClear();
      emitTurnStarted(threadId, turnId, "evt-request-started");
      idleWatchdog.codex.emit({
        type: "request.opened",
        eventId: asEventId("evt-request-opened"),
        provider: CODEX_DRIVER,
        createdAt: "2026-01-01T00:00:00.000Z",
        threadId,
        turnId,
        requestId: asRequestId("request-idle-watchdog"),
        payload: { requestType: "command_approval" },
      });

      yield* advanceTestClock(300);
      assert.equal(idleWatchdog.codex.interruptTurn.mock.calls.length, 0);
      emitTurnCompleted(threadId, turnId, "evt-request-completed");
      yield* advanceTestClock(1);
    }),
  );

  it.effect("uses every progress event as turn liveness", () =>
    Effect.gen(function* () {
      const threadId = asThreadId("thread-idle-watchdog-progress");
      const turnId = asTurnId("turn-idle-watchdog-progress");
      idleWatchdog.codex.interruptTurn.mockClear();
      emitTurnStarted(threadId, turnId, "evt-progress-started");

      for (let index = 0; index < 5; index++) {
        yield* advanceTestClock(60);
        idleWatchdog.codex.emit({
          type: "tool.progress",
          eventId: asEventId(`evt-progress-${index}`),
          provider: CODEX_DRIVER,
          createdAt: "2026-01-01T00:00:00.000Z",
          threadId,
          turnId,
          payload: { elapsedSeconds: index + 1 },
        });
        yield* Effect.yieldNow;
      }

      assert.equal(idleWatchdog.codex.interruptTurn.mock.calls.length, 0);
      emitTurnCompleted(threadId, turnId, "evt-progress-completed");
      yield* advanceTestClock(1);
    }),
  );

  it.effect("stops recovery when the provider completes during the grace window", () =>
    Effect.gen(function* () {
      const threadId = asThreadId("thread-idle-watchdog-grace");
      const turnId = asTurnId("turn-idle-watchdog-grace");
      idleWatchdog.codex.interruptTurn.mockClear();
      idleWatchdog.codex.stopSession.mockClear();
      emitTurnStarted(threadId, turnId, "evt-grace-started");

      yield* advanceTestClock(110);
      assert.equal(idleWatchdog.codex.interruptTurn.mock.calls.length, 1);
      emitTurnCompleted(threadId, turnId, "evt-grace-completed");
      yield* advanceTestClock(60);

      assert.equal(idleWatchdog.codex.stopSession.mock.calls.length, 0);
    }),
  );

  it.effect("does not let an old completion clear a newer turn", () =>
    Effect.gen(function* () {
      const threadId = asThreadId("thread-idle-watchdog-old-completion");
      const oldTurnId = asTurnId("turn-idle-watchdog-old");
      const newTurnId = asTurnId("turn-idle-watchdog-new");
      idleWatchdog.codex.interruptTurn.mockClear();
      emitTurnStarted(threadId, oldTurnId, "evt-old-turn-started");
      emitTurnStarted(threadId, newTurnId, "evt-new-turn-started");
      emitTurnCompleted(threadId, oldTurnId, "evt-old-turn-completed");

      yield* advanceTestClock(110);
      assert.equal(idleWatchdog.codex.interruptTurn.mock.calls.length, 1);
      assert.equal(idleWatchdog.codex.interruptTurn.mock.calls[0]?.[1], newTurnId);
      emitTurnCompleted(threadId, newTurnId, "evt-new-turn-completed");
      yield* advanceTestClock(60);
    }),
  );

  it.effect("publishes the failed completion when both control calls fail", () =>
    Effect.gen(function* () {
      const threadId = asThreadId("thread-idle-watchdog-control-failure");
      const turnId = asTurnId("turn-idle-watchdog-control-failure");
      const collector = yield* startEventCollector();
      idleWatchdog.codex.interruptTurn.mockImplementationOnce(() =>
        Effect.fail(
          new ProviderAdapterRequestError({
            provider: String(CODEX_DRIVER),
            method: "interruptTurn",
            detail: "simulated interrupt failure",
          }),
        ),
      );
      idleWatchdog.codex.stopSession.mockImplementationOnce(() =>
        Effect.fail(
          new ProviderAdapterRequestError({
            provider: String(CODEX_DRIVER),
            method: "stopSession",
            detail: "simulated stop failure",
          }),
        ),
      );
      emitTurnStarted(threadId, turnId, "evt-control-failure-started");

      yield* advanceTestClock(170);
      const events = yield* Ref.get(collector.events);
      assert.equal(
        events.some(
          (event) =>
            event.type === "turn.completed" &&
            event.turnId === turnId &&
            event.payload.state === "failed",
        ),
        true,
      );
      yield* Fiber.interrupt(collector.fiber);
    }),
  );

  it.effect("publishes the failed completion when stop emits session.exited", () =>
    Effect.gen(function* () {
      const threadId = asThreadId("thread-idle-watchdog-stop-exit");
      const turnId = asTurnId("turn-idle-watchdog-stop-exit");
      const collector = yield* startEventCollector();
      idleWatchdog.codex.stopSession.mockImplementationOnce(() =>
        Effect.sync(() =>
          idleWatchdog.codex.emit({
            type: "session.exited",
            eventId: asEventId("evt-stop-session-exited"),
            provider: CODEX_DRIVER,
            createdAt: "2026-01-01T00:00:00.000Z",
            threadId,
            payload: { reason: "watchdog stop" },
          }),
        ).pipe(Effect.andThen(Effect.yieldNow)),
      );
      emitTurnStarted(threadId, turnId, "evt-stop-exit-started");

      yield* advanceTestClock(170);
      emitTurnCompleted(threadId, turnId, "evt-stop-exit-late-completion");
      yield* advanceTestClock(1);
      const events = yield* Ref.get(collector.events);
      assert.equal(
        events.filter((event) => event.type === "turn.completed" && event.turnId === turnId).length,
        1,
      );
      assert.equal(
        events.some(
          (event) =>
            event.type === "turn.completed" &&
            event.turnId === turnId &&
            event.payload.state === "failed",
        ),
        true,
      );
      yield* Fiber.interrupt(collector.fiber);
    }),
  );

  it.effect("time-bounds control calls that never complete", () =>
    Effect.gen(function* () {
      const threadId = asThreadId("thread-idle-watchdog-control-timeout");
      const turnId = asTurnId("turn-idle-watchdog-control-timeout");
      const collector = yield* startEventCollector();
      idleWatchdog.codex.interruptTurn.mockImplementationOnce(() => Effect.never);
      idleWatchdog.codex.stopSession.mockImplementationOnce(() => Effect.never);
      emitTurnStarted(threadId, turnId, "evt-control-timeout-started");

      yield* advanceTestClock(110);
      yield* advanceTestClock(25);
      yield* advanceTestClock(60);
      yield* advanceTestClock(25);
      const events = yield* Ref.get(collector.events);
      assert.equal(
        events.some(
          (event) =>
            event.type === "turn.completed" &&
            event.turnId === turnId &&
            event.payload.state === "failed",
        ),
        true,
      );
      yield* Fiber.interrupt(collector.fiber);
    }),
  );

  it.effect("does not trip while waiting or while an anonymous request is open", () =>
    Effect.gen(function* () {
      const threadId = asThreadId("thread-idle-watchdog-waiting");
      const turnId = asTurnId("turn-idle-watchdog-waiting");
      idleWatchdog.codex.interruptTurn.mockClear();
      emitTurnStarted(threadId, turnId, "evt-waiting-started");
      idleWatchdog.codex.emit({
        type: "session.state.changed",
        eventId: asEventId("evt-session-waiting"),
        provider: CODEX_DRIVER,
        createdAt: "2026-01-01T00:00:00.000Z",
        threadId,
        payload: { state: "waiting" },
      });
      yield* advanceTestClock(200);
      assert.equal(idleWatchdog.codex.interruptTurn.mock.calls.length, 0);

      idleWatchdog.codex.emit({
        type: "session.state.changed",
        eventId: asEventId("evt-session-running"),
        provider: CODEX_DRIVER,
        createdAt: "2026-01-01T00:00:00.000Z",
        threadId,
        payload: { state: "running" },
      });
      idleWatchdog.codex.emit({
        type: "user-input.requested",
        eventId: asEventId("evt-anonymous-request"),
        provider: CODEX_DRIVER,
        createdAt: "2026-01-01T00:00:00.000Z",
        threadId,
        turnId,
        payload: { questions: [] },
      });
      yield* advanceTestClock(200);
      assert.equal(idleWatchdog.codex.interruptTurn.mock.calls.length, 0);

      idleWatchdog.codex.emit({
        type: "user-input.resolved",
        eventId: asEventId("evt-anonymous-resolved"),
        provider: CODEX_DRIVER,
        createdAt: "2026-01-01T00:00:00.000Z",
        threadId,
        turnId,
        payload: { answers: {} },
      });
      emitTurnCompleted(threadId, turnId, "evt-waiting-completed");
      yield* advanceTestClock(1);
    }),
  );
});

const validation = makeProviderServiceLayer();
validation.layer("ProviderServiceLive validation", (it) => {
  it.effect("rejects session starts without an explicit provider instance id", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;

      validation.codex.startSession.mockClear();
      const failure = yield* Effect.flip(
        provider.startSession(asThreadId("thread-missing-instance-id"), {
          provider: ProviderDriverKind.make("codex"),
          threadId: asThreadId("thread-missing-instance-id"),
          runtimeMode: "full-access",
        }),
      );

      assert.instanceOf(failure, ProviderValidationError);
      assert.include(failure.issue, "Provider instance id is required for provider 'codex'.");
      assert.equal(validation.codex.startSession.mock.calls.length, 0);
    }),
  );

  it.effect("rejects mismatched provider kind and provider instance id", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;

      validation.codex.startSession.mockClear();
      validation.claude.startSession.mockClear();
      const failure = yield* Effect.flip(
        provider.startSession(asThreadId("thread-instance-mismatch"), {
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: claudeAgentInstanceId,
          threadId: asThreadId("thread-instance-mismatch"),
          runtimeMode: "full-access",
        }),
      );

      assert.instanceOf(failure, ProviderValidationError);
      assert.include(
        failure.issue,
        "Provider instance 'claudeAgent' belongs to driver 'claudeAgent', not 'codex'.",
      );
      assert.equal(validation.codex.startSession.mock.calls.length, 0);
      assert.equal(validation.claude.startSession.mock.calls.length, 0);
    }),
  );

  it.effect("returns ProviderValidationError for invalid input payloads", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;

      const failure = yield* Effect.result(
        provider.startSession(asThreadId("thread-validation"), {
          threadId: asThreadId("thread-validation"),
          provider: "invalid-provider",
          runtimeMode: "full-access",
        } as never),
      );

      assert.equal(failure._tag, "Failure");
      if (failure._tag !== "Failure") {
        return;
      }
      assert.equal(failure.failure._tag, "ProviderValidationError");
      if (failure.failure._tag !== "ProviderValidationError") {
        return;
      }
      assert.equal(failure.failure.operation, "ProviderService.startSession");
      assert.equal(failure.failure.issue.includes("invalid-provider"), true);
    }),
  );

  it.effect("accepts startSession when adapter has not emitted provider thread id yet", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const runtimeRepository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;

      validation.codex.startSession.mockImplementationOnce((input: ProviderSessionStartInput) =>
        Effect.sync(() => {
          const now = "2026-01-01T00:00:00.000Z";
          return {
            provider: ProviderDriverKind.make("codex"),
            status: "ready",
            threadId: input.threadId,
            runtimeMode: input.runtimeMode,
            cwd: input.cwd ?? process.cwd(),
            createdAt: now,
            updatedAt: now,
          } satisfies ProviderSession;
        }),
      );

      const session = yield* provider.startSession(asThreadId("thread-missing"), {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: asThreadId("thread-missing"),
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });

      assert.equal(session.threadId, asThreadId("thread-missing"));

      const runtime = yield* runtimeRepository.getByThreadId({
        threadId: session.threadId,
      });
      assert.equal(Option.isSome(runtime), true);
      if (Option.isSome(runtime)) {
        assert.equal(runtime.value.threadId, session.threadId);
      }
    }),
  );
});

const lastSeenRefresh = makeProviderServiceLayer();
lastSeenRefresh.layer("ProviderServiceLive lastSeenAt refresh", (it) => {
  const readRuntimeRow = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const runtimeRepository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
      const runtime = yield* runtimeRepository.getByThreadId({ threadId });
      assert.equal(Option.isSome(runtime), true);
      return Option.getOrThrow(runtime);
    });

  const startCodexSession = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      yield* provider.startSession(threadId, {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId,
        runtimeMode: "full-access",
      });
    });

  const emitTaskProgress = (threadId: ThreadId, eventId: string): void => {
    lastSeenRefresh.codex.emit({
      type: "task.progress",
      eventId: asEventId(eventId),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId,
      turnId: asTurnId("turn-1"),
    });
  };

  it.effect("refreshes binding.lastSeenAt from runtime events, one write per throttle window", () =>
    Effect.gen(function* () {
      const threadId = asThreadId("thread-last-seen-throttle");
      yield* startCodexSession(threadId);
      const atStart = (yield* readRuntimeRow(threadId)).lastSeenAt;

      yield* advanceTestClock(5 * 60_000);
      emitTaskProgress(threadId, "evt-touch-1");
      yield* advanceTestClock(10);
      const afterFirst = (yield* readRuntimeRow(threadId)).lastSeenAt;
      assert.notEqual(afterFirst, atStart);

      // A second event 1s after the first stays inside the throttle window:
      // the pair produces exactly one write.
      yield* advanceTestClock(1_000);
      emitTaskProgress(threadId, "evt-touch-2");
      yield* advanceTestClock(10);
      assert.equal((yield* readRuntimeRow(threadId)).lastSeenAt, afterFirst);

      // Past the window the next event writes again.
      yield* advanceTestClock(60_000);
      emitTaskProgress(threadId, "evt-touch-3");
      yield* advanceTestClock(10);
      const afterThird = (yield* readRuntimeRow(threadId)).lastSeenAt;
      assert.isAbove(Date.parse(afterThird), Date.parse(afterFirst));
    }),
  );

  it.effect(
    "task.progress from an in-flight subagent keeps an epic-run iteration inside its idle threshold",
    () =>
      Effect.gen(function* () {
        const threadId = asThreadId(
          epicRunIterationThreadId({ runId: "run-last-seen", iterationIndex: 1 }),
        );
        yield* startCodexSession(threadId);
        const startedAtMs = yield* Clock.currentTimeMillis;

        // 70 virtual minutes of a quiet main stream whose only life is a
        // subagent posting task.progress every 10 minutes — well past the
        // 30-minute epic-run iteration idle backstop.
        for (let i = 0; i < 7; i++) {
          yield* advanceTestClock(10 * 60_000);
          emitTaskProgress(threadId, `evt-subagent-${i}`);
          yield* advanceTestClock(10);
        }

        const runtime = yield* readRuntimeRow(threadId);
        const nowMs = yield* Clock.currentTimeMillis;
        const decision = decideSessionReap({
          threadId,
          status: runtime.status,
          hasLiveAdapterSession: true,
          idleDurationMs: nowMs - Date.parse(runtime.lastSeenAt),
          settledOverride: null,
          activeTurnId: null,
        });
        assert.deepEqual(
          { reap: decision.reap, reason: decision.reason },
          { reap: false, reason: "within_idle_threshold" },
        );

        // Regression contrast: idle age measured from the last directory
        // upsert (session start) would have reaped this session.
        const staleDecision = decideSessionReap({
          threadId,
          status: runtime.status,
          hasLiveAdapterSession: true,
          idleDurationMs: nowMs - startedAtMs,
          settledOverride: null,
          activeTurnId: null,
        });
        assert.equal(staleDecision.reap, true);
      }),
  );

  it.effect("does not write lastSeenAt for threads with no runtime events", () =>
    Effect.gen(function* () {
      const threadId = asThreadId("thread-last-seen-quiet");
      yield* startCodexSession(threadId);
      const atStart = (yield* readRuntimeRow(threadId)).lastSeenAt;

      yield* advanceTestClock(15 * 60_000);
      assert.equal((yield* readRuntimeRow(threadId)).lastSeenAt, atStart);
    }),
  );
});

// A thread outlives the directory it ran in: an epic worker gets a throwaway
// worktree that the runner deletes once the child lands. Restarting the thread
// used to spawn straight into the deleted path, and the provider reported a
// bare ENOENT as an opaque "runtime stream failed".
const VANISHED_CWD = "/tmp/epic-worker-worktree";
const WORKSPACE_ROOT = "/tmp/workspace-root";

function makeVanishedCwdFixture(presentPaths: ReadonlyArray<string>) {
  const codex = makeFakeCodexAdapter();
  const registry = makeAdapterRegistryMock({ [CODEX_DRIVER]: codex.adapter });
  const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
    Layer.provide(SqlitePersistenceMemory),
  );
  const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));
  const canonicalEvents: ProviderRuntimeEvent[] = [];
  const layer = makeProviderServiceLiveForTest(
    {
      canonicalEventLogger: {
        filePath: "memory://vanished-cwd",
        write: (event) => {
          canonicalEvents.push(event as ProviderRuntimeEvent);
          return Effect.void;
        },
        close: () => Effect.void,
      },
    },
    FileSystem.layerNoop({
      exists: (path: string) => Effect.succeed(presentPaths.includes(path)),
    }),
  ).pipe(
    Layer.provide(Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, registry)),
    Layer.provide(directoryLayer),
    Layer.provide(defaultServerSettingsLayer),
    Layer.provide(AnalyticsService.layerTest),
    Layer.provide(
      Layer.succeed(
        ProviderEventLoggers.ProviderEventLoggers,
        ProviderEventLoggers.NoOpProviderEventLoggers,
      ),
    ),
  );
  return { codex, layer, canonicalEvents };
}

const startAndStopVanishedCwdSession = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const provider = yield* ProviderService.ProviderService;
    yield* provider.startSession(threadId, {
      provider: CODEX_DRIVER,
      providerInstanceId: codexInstanceId,
      threadId,
      cwd: VANISHED_CWD,
      projectId: ProjectId.make("project-1"),
      workspaceRoot: WORKSPACE_ROOT,
      runtimeMode: "full-access",
    });
    yield* provider.stopSession({ threadId });
    return provider;
  });

const resumedCwd = (codex: ReturnType<typeof makeFakeCodexAdapter>): string | undefined => {
  const startInput = codex.startSession.mock.calls.at(-1)?.[0];
  return startInput && typeof startInput === "object"
    ? (startInput as { cwd?: string }).cwd
    : undefined;
};

it.effect("restarts a thread in the workspace root when its persisted cwd is gone", () =>
  Effect.gen(function* () {
    const threadId = asThreadId("thread-vanished-cwd");
    const fixture = makeVanishedCwdFixture([WORKSPACE_ROOT]);

    yield* Effect.gen(function* () {
      const provider = yield* startAndStopVanishedCwdSession(threadId);
      fixture.codex.startSession.mockClear();
      yield* provider.sendTurn({ threadId, input: "after-worktree-removal", attachments: [] });
    }).pipe(Effect.provide(fixture.layer));

    assert.equal(fixture.codex.startSession.mock.calls.length, 1);
    assert.equal(resumedCwd(fixture.codex), WORKSPACE_ROOT);

    const warning = fixture.canonicalEvents.find((event) => event.type === "runtime.warning");
    assert.equal(warning !== undefined, true);
    assert.equal(
      typeof warning?.payload === "object" &&
        warning.payload !== null &&
        String((warning.payload as { message?: unknown }).message).includes(VANISHED_CWD),
      true,
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("keeps the persisted cwd when the directory still exists", () =>
  Effect.gen(function* () {
    const threadId = asThreadId("thread-live-cwd");
    const fixture = makeVanishedCwdFixture([VANISHED_CWD, WORKSPACE_ROOT]);

    yield* Effect.gen(function* () {
      const provider = yield* startAndStopVanishedCwdSession(threadId);
      fixture.codex.startSession.mockClear();
      yield* provider.sendTurn({ threadId, input: "still-there", attachments: [] });
    }).pipe(Effect.provide(fixture.layer));

    assert.equal(resumedCwd(fixture.codex), VANISHED_CWD);
    assert.equal(
      fixture.canonicalEvents.some((event) => event.type === "runtime.warning"),
      false,
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("fails with the missing path when no fallback directory exists", () =>
  Effect.gen(function* () {
    const threadId = asThreadId("thread-no-fallback");
    const fixture = makeVanishedCwdFixture([]);

    const error = yield* Effect.gen(function* () {
      const provider = yield* startAndStopVanishedCwdSession(threadId);
      fixture.codex.startSession.mockClear();
      return yield* provider.sendTurn({ threadId, input: "nowhere-to-go", attachments: [] });
    }).pipe(Effect.provide(fixture.layer), Effect.flip);

    assert.equal(fixture.codex.startSession.mock.calls.length, 0);
    assert.equal(error._tag, "ProviderValidationError");
    assert.equal(
      String((error as { readonly message?: string }).message).includes(VANISHED_CWD),
      true,
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

/**
 * Single-adapter stack for the continuation-identity and resume-verdict
 * suites. The registry overrides let a test say "this instance was
 * reconfigured" or "this instance is switched off" without rebuilding the
 * fixture by hand.
 */
function makeContinuationIdentityStack(options?: {
  readonly sessionResume?: ProviderSessionResumeMode;
  readonly enabled?: boolean;
  readonly continuationKey?: string;
}) {
  const codex = makeFakeCodexAdapter(
    CODEX_DRIVER,
    options?.sessionResume !== undefined ? { sessionResume: options.sessionResume } : undefined,
  );
  const registry = makeAdapterRegistryMock(
    { [CODEX_DRIVER]: codex.adapter },
    {
      [CODEX_DRIVER]: {
        ...(options?.enabled !== undefined ? { enabled: options.enabled } : {}),
        ...(options?.continuationKey !== undefined
          ? { continuationKey: options.continuationKey }
          : {}),
      },
    },
  );
  const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
    Layer.provide(SqlitePersistenceMemory),
  );
  const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));
  const providerLayer = Layer.mergeAll(
    makeProviderServiceLiveForTest().pipe(
      Layer.provide(Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, registry)),
      Layer.provide(directoryLayer),
      Layer.provide(defaultServerSettingsLayer),
      Layer.provide(AnalyticsService.layerTest),
      Layer.provide(
        Layer.succeed(
          ProviderEventLoggers.ProviderEventLoggers,
          ProviderEventLoggers.NoOpProviderEventLoggers,
        ),
      ),
    ),
    directoryLayer,
    runtimeRepositoryLayer,
  );
  return { codex, providerLayer };
}

/** The default key `makeAdapterRegistryMock` reports for the codex instance. */
const CODEX_CONTINUATION_KEY = `${CODEX_DRIVER}:instance:${codexInstanceId}`;

const readContinuationIdentity = (runtimePayload: unknown): unknown =>
  typeof runtimePayload === "object" && runtimePayload !== null
    ? (runtimePayload as Record<string, unknown>).continuationIdentity
    : undefined;

const persistedRuntimePayload = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
    const binding = yield* directory.getBinding(threadId);
    assert.equal(Option.isSome(binding), true);
    return Option.isSome(binding) ? binding.value.runtimePayload : undefined;
  });

/** Writes a binding straight to the directory, bypassing every session path. */
const seedBinding = (input: {
  readonly threadId: ThreadId;
  readonly providerInstanceId?: ProviderInstanceId;
  readonly resumeCursor?: unknown | null;
  readonly runtimePayload?: Record<string, unknown>;
}) =>
  Effect.gen(function* () {
    const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
    yield* directory.upsert({
      threadId: input.threadId,
      provider: CODEX_DRIVER,
      providerInstanceId: input.providerInstanceId ?? codexInstanceId,
      runtimeMode: "full-access",
      status: "stopped",
      resumeCursor: input.resumeCursor ?? null,
      runtimePayload: input.runtimePayload ?? {},
    });
  });

it.effect("persists the instance continuation identity when a session starts", () =>
  Effect.gen(function* () {
    const stack = makeContinuationIdentityStack();
    const threadId = asThreadId("thread-continuation-start");

    const runtimePayload = yield* Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      yield* provider.startSession(threadId, {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        cwd: "/tmp/project-continuation",
        runtimeMode: "full-access",
      });
      const info = yield* provider.getInstanceInfo(codexInstanceId);
      assert.equal(info.continuationIdentity.continuationKey, CODEX_CONTINUATION_KEY);
      return yield* persistedRuntimePayload(threadId);
    }).pipe(Effect.provide(stack.providerLayer));

    assert.deepEqual(readContinuationIdentity(runtimePayload), {
      driverKind: CODEX_DRIVER,
      continuationKey: CODEX_CONTINUATION_KEY,
    });
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("refreshes the continuation identity on every turn", () =>
  Effect.gen(function* () {
    const stack = makeContinuationIdentityStack();
    const threadId = asThreadId("thread-continuation-turn");

    const runtimePayload = yield* Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      yield* provider.startSession(threadId, {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        cwd: "/tmp/project-continuation",
        runtimeMode: "full-access",
      });
      // Rot the persisted identity behind the service's back, so the assertion
      // below can only pass if `sendTurn` wrote it again.
      yield* seedBinding({
        threadId,
        resumeCursor: { opaque: "stale" },
        runtimePayload: {
          continuationIdentity: { driverKind: CODEX_DRIVER, continuationKey: "codex:home:/gone" },
        },
      });
      yield* provider.sendTurn({ threadId, input: "keep going", attachments: [] });
      return yield* persistedRuntimePayload(threadId);
    }).pipe(Effect.provide(stack.providerLayer));

    assert.deepEqual(readContinuationIdentity(runtimePayload), {
      driverKind: CODEX_DRIVER,
      continuationKey: CODEX_CONTINUATION_KEY,
    });
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("keeps the continuation identity across a session stop", () =>
  Effect.gen(function* () {
    const stack = makeContinuationIdentityStack();
    const threadId = asThreadId("thread-continuation-stop");

    const runtimePayload = yield* Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      yield* provider.startSession(threadId, {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        cwd: "/tmp/project-continuation",
        runtimeMode: "full-access",
      });
      yield* provider.stopSession({ threadId });
      return yield* persistedRuntimePayload(threadId);
    }).pipe(Effect.provide(stack.providerLayer));

    assert.deepEqual(readContinuationIdentity(runtimePayload), {
      driverKind: CODEX_DRIVER,
      continuationKey: CODEX_CONTINUATION_KEY,
    });
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("reads a legacy binding that carries no continuation identity", () =>
  Effect.gen(function* () {
    const stack = makeContinuationIdentityStack();
    const threadId = asThreadId("thread-continuation-legacy");

    const verdict = yield* Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      yield* seedBinding({
        threadId,
        resumeCursor: { opaque: "legacy" },
        runtimePayload: { cwd: "/tmp/project-legacy" },
      });
      const payload = yield* persistedRuntimePayload(threadId);
      assert.equal(readContinuationIdentity(payload), undefined);
      return yield* provider.describeSessionResume(threadId);
    }).pipe(Effect.provide(stack.providerLayer));

    // Absent means unknown, never mismatch: every row written before the field
    // existed reads this way.
    assert.equal(verdict.resumable, "cursor");
    assert.equal(verdict.reason, "persisted-cursor");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("ignores a malformed persisted continuation identity", () =>
  Effect.gen(function* () {
    const stack = makeContinuationIdentityStack();
    const threadId = asThreadId("thread-continuation-malformed");

    const verdict = yield* Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      yield* seedBinding({
        threadId,
        resumeCursor: { opaque: "malformed" },
        runtimePayload: { continuationIdentity: { driverKind: "", continuationKey: 7 } },
      });
      return yield* provider.describeSessionResume(threadId);
    }).pipe(Effect.provide(stack.providerLayer));

    assert.equal(verdict.resumable, "cursor");
    assert.equal(verdict.reason, "persisted-cursor");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("describeSessionResume reports no binding", () =>
  Effect.gen(function* () {
    const stack = makeContinuationIdentityStack();
    const threadId = asThreadId("thread-verdict-no-binding");

    const verdict = yield* Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      return yield* provider.describeSessionResume(threadId);
    }).pipe(Effect.provide(stack.providerLayer));

    assert.equal(verdict.threadId, threadId);
    assert.equal(verdict.resumable, "no");
    assert.equal(verdict.reason, "no-binding");
    assert.equal(verdict.providerInstanceId, undefined);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("describeSessionResume reports an unconfigured instance", () =>
  Effect.gen(function* () {
    const stack = makeContinuationIdentityStack();
    const threadId = asThreadId("thread-verdict-unconfigured");

    const verdict = yield* Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      yield* seedBinding({
        threadId,
        providerInstanceId: ProviderInstanceId.make("codex_retired"),
        resumeCursor: { opaque: "orphan" },
      });
      return yield* provider.describeSessionResume(threadId);
    }).pipe(Effect.provide(stack.providerLayer));

    assert.equal(verdict.resumable, "no");
    assert.equal(verdict.reason, "instance-not-configured");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("describeSessionResume reports a disabled instance", () =>
  Effect.gen(function* () {
    const stack = makeContinuationIdentityStack({ enabled: false });
    const threadId = asThreadId("thread-verdict-disabled");

    const verdict = yield* Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      yield* seedBinding({ threadId, resumeCursor: { opaque: "disabled" } });
      return yield* provider.describeSessionResume(threadId);
    }).pipe(Effect.provide(stack.providerLayer));

    assert.equal(verdict.resumable, "no");
    assert.equal(verdict.reason, "instance-disabled");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("describeSessionResume reports a live adapter session", () =>
  Effect.gen(function* () {
    const stack = makeContinuationIdentityStack();
    const threadId = asThreadId("thread-verdict-live");

    const verdict = yield* Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      yield* provider.startSession(threadId, {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        cwd: "/tmp/project-verdict-live",
        runtimeMode: "full-access",
      });
      return yield* provider.describeSessionResume(threadId);
    }).pipe(Effect.provide(stack.providerLayer));

    assert.equal(verdict.resumable, "live");
    assert.equal(verdict.reason, "live-session");
    assert.equal(verdict.provider, CODEX_DRIVER);
    assert.equal(verdict.providerInstanceId, codexInstanceId);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("describeSessionResume reports an adapter that cannot resume", () =>
  Effect.gen(function* () {
    const stack = makeContinuationIdentityStack({ sessionResume: "unsupported" });
    const threadId = asThreadId("thread-verdict-unsupported");

    const verdict = yield* Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      yield* seedBinding({ threadId, resumeCursor: { opaque: "unusable" } });
      return yield* provider.describeSessionResume(threadId);
    }).pipe(Effect.provide(stack.providerLayer));

    // The cursor is right there, so this can only come from the capability.
    assert.equal(verdict.resumable, "no");
    assert.equal(verdict.reason, "resume-unsupported");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("describeSessionResume reports a binding with no cursor", () =>
  Effect.gen(function* () {
    const stack = makeContinuationIdentityStack();
    const threadId = asThreadId("thread-verdict-no-cursor");

    const verdict = yield* Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      yield* seedBinding({ threadId, resumeCursor: null });
      return yield* provider.describeSessionResume(threadId);
    }).pipe(Effect.provide(stack.providerLayer));

    assert.equal(verdict.resumable, "no");
    assert.equal(verdict.reason, "no-cursor");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("describeSessionResume refuses a cursor from another continuation domain", () =>
  Effect.gen(function* () {
    const stack = makeContinuationIdentityStack({ continuationKey: "codex:home:/new-home" });
    const threadId = asThreadId("thread-verdict-identity-changed");

    const verdict = yield* Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      yield* seedBinding({
        threadId,
        resumeCursor: { opaque: "from-the-old-home" },
        runtimePayload: {
          continuationIdentity: {
            driverKind: CODEX_DRIVER,
            continuationKey: "codex:home:/old-home",
          },
        },
      });
      return yield* provider.describeSessionResume(threadId);
    }).pipe(Effect.provide(stack.providerLayer));

    assert.equal(verdict.resumable, "no");
    assert.equal(verdict.reason, "continuation-identity-changed");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("describeSessionResume accepts a persisted cursor and starts nothing", () =>
  Effect.gen(function* () {
    const stack = makeContinuationIdentityStack();
    const threadId = asThreadId("thread-verdict-cursor");

    const verdict = yield* Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      yield* provider.startSession(threadId, {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        cwd: "/tmp/project-verdict-cursor",
        runtimeMode: "full-access",
      });
      // Kill the in-memory session the way a server restart does, leaving the
      // persisted binding behind.
      yield* stack.codex.stopAll();
      stack.codex.startSession.mockClear();
      return yield* provider.describeSessionResume(threadId);
    }).pipe(Effect.provide(stack.providerLayer));

    assert.equal(verdict.resumable, "cursor");
    assert.equal(verdict.reason, "persisted-cursor");
    assert.equal(verdict.cwd, "/tmp/project-verdict-cursor");
    assert.equal(typeof verdict.lastSeenAt, "string");
    // Read-only: asking must never wake a provider up.
    assert.equal(stack.codex.startSession.mock.calls.length, 0);
    assert.equal(stack.codex.sendTurn.mock.calls.length, 0);
  }).pipe(Effect.provide(NodeServices.layer)),
);
