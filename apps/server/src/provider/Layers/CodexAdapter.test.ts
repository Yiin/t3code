// @effect-diagnostics nodeBuiltinImport:off
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  ApprovalRequestId,
  type ChatAttachment,
  CodexSettings,
  EnvironmentId,
  EventId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderItemId,
  type ProviderAccountLimit,
  type ProviderApprovalDecision,
  type ProviderEvent,
  type ProviderSession,
  type ProviderUsageSample,
  type ProviderTurnStartResult,
  type ProviderUserInputAnswers,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, vi } from "@effect/vitest";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as CodexErrors from "effect-codex-app-server/errors";
import * as EffectCodexSchema from "effect-codex-app-server/schema";

import { attachmentRelativePath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ProviderAdapterValidationError } from "../Errors.ts";
import type { CodexAdapterShape } from "../Services/CodexAdapter.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import {
  CODEX_SUBAGENT_TURN_COMPLETED_METHOD,
  CODEX_SUBAGENT_TURN_STARTED_METHOD,
  type CodexSessionRuntimeOptions,
  type CodexSessionRuntimeSendTurnInput,
  type CodexSessionRuntimeShape,
  type CodexThreadSnapshot,
} from "./CodexSessionRuntime.ts";
import { describeSessionLifecycleConformance } from "../testUtils/sessionLifecycleConformance.ts";
import { CODEX_ADAPTER_CAPABILITIES, makeCodexAdapter } from "./CodexAdapter.ts";
const decodeCodexSettings = Schema.decodeSync(CodexSettings);
const decodeCodexUserInput = Schema.decodeUnknownEffect(
  EffectCodexSchema.V2TurnStartParams__UserInput,
);

// Test-local service tag so the rest of the file can keep using `yield* CodexAdapter`.
class CodexAdapter extends Context.Service<CodexAdapter, CodexAdapterShape>()(
  "t3/provider/Layers/CodexAdapter.test/CodexAdapter",
) {}

const asThreadId = (value: string): ThreadId => ThreadId.make(value);
const asTurnId = (value: string): TurnId => TurnId.make(value);
const asEventId = (value: string): EventId => EventId.make(value);
const asItemId = (value: string): ProviderItemId => ProviderItemId.make(value);

class FakeCodexRuntime implements CodexSessionRuntimeShape {
  private readonly eventQueue = Effect.runSync(Queue.unbounded<ProviderEvent>());
  private readonly now = "2026-01-01T00:00:00.000Z";

  public readonly startImpl = vi.fn(() =>
    Promise.resolve({
      provider: ProviderDriverKind.make("codex"),
      status: "ready" as const,
      runtimeMode: this.options.runtimeMode,
      threadId: this.options.threadId,
      cwd: this.options.cwd,
      ...(this.options.model ? { model: this.options.model } : {}),
      createdAt: this.now,
      updatedAt: this.now,
    } satisfies ProviderSession),
  );

  public readonly sendTurnImpl = vi.fn(
    (_input: CodexSessionRuntimeSendTurnInput): Promise<ProviderTurnStartResult> =>
      Promise.resolve({
        threadId: this.options.threadId,
        turnId: asTurnId("turn-1"),
      }),
  );

  public readonly interruptTurnImpl = vi.fn(
    (_turnId?: TurnId): Promise<void> => Promise.resolve(undefined),
  );

  public readonly readThreadImpl = vi.fn(
    (): Promise<CodexThreadSnapshot> =>
      Promise.resolve({
        threadId: "provider-thread-1",
        turns: [],
      }),
  );

  public readonly rollbackThreadImpl = vi.fn(
    (_numTurns: number): Promise<CodexThreadSnapshot> =>
      Promise.resolve({
        threadId: "provider-thread-1",
        turns: [],
      }),
  );

  public readonly respondToRequestImpl = vi.fn(
    (_requestId: ApprovalRequestId, _decision: ProviderApprovalDecision): Promise<void> =>
      Promise.resolve(undefined),
  );

  public readonly respondToUserInputImpl = vi.fn(
    (_requestId: ApprovalRequestId, _answers: ProviderUserInputAnswers): Promise<void> =>
      Promise.resolve(undefined),
  );

  public readonly closeImpl = vi.fn(() => Promise.resolve(undefined));

  readonly options: CodexSessionRuntimeOptions;

  constructor(options: CodexSessionRuntimeOptions) {
    this.options = options;
  }

  start() {
    return Effect.promise(() => this.startImpl());
  }

  getSession = Effect.promise(() => this.startImpl());

  sendTurn(input: CodexSessionRuntimeSendTurnInput) {
    return Effect.promise(() => this.sendTurnImpl(input));
  }

  interruptTurn(turnId?: TurnId) {
    return Effect.promise(() => this.interruptTurnImpl(turnId));
  }

  readThread = Effect.promise(() => this.readThreadImpl());

  rollbackThread(numTurns: number) {
    return Effect.promise(() => this.rollbackThreadImpl(numTurns));
  }

  respondToRequest(requestId: ApprovalRequestId, decision: ProviderApprovalDecision) {
    return Effect.promise(() => this.respondToRequestImpl(requestId, decision));
  }

  respondToUserInput(requestId: ApprovalRequestId, answers: ProviderUserInputAnswers) {
    return Effect.promise(() => this.respondToUserInputImpl(requestId, answers));
  }

  get events() {
    return Stream.fromQueue(this.eventQueue);
  }

  close = Effect.promise(() => this.closeImpl());

  emit(event: ProviderEvent) {
    return Queue.offer(this.eventQueue, event).pipe(Effect.asVoid);
  }
}

function makeRuntimeFactory() {
  const runtimes: Array<FakeCodexRuntime> = [];
  const factory = vi.fn((options: CodexSessionRuntimeOptions) => {
    const runtime = new FakeCodexRuntime(options);
    runtimes.push(runtime);
    return Effect.succeed(runtime);
  });

  return {
    factory,
    get lastRuntime(): FakeCodexRuntime | undefined {
      return runtimes.at(-1);
    },
  };
}

function makeScopedRuntimeFactory(options?: { readonly failConstruction?: boolean }) {
  const runtimes: Array<FakeCodexRuntime> = [];
  const releasedThreadIds: Array<ThreadId> = [];

  const factory = vi.fn((runtimeOptions: CodexSessionRuntimeOptions) =>
    Effect.gen(function* () {
      yield* Scope.Scope;
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          releasedThreadIds.push(runtimeOptions.threadId);
        }),
      );

      if (options?.failConstruction) {
        return yield* new CodexErrors.CodexAppServerSpawnError({
          command: `${runtimeOptions.binaryPath} app-server`,
          cause: new Error("runtime construction failed"),
        });
      }

      const runtime = new FakeCodexRuntime(runtimeOptions);
      runtimes.push(runtime);
      return runtime;
    }),
  );

  return {
    factory,
    releasedThreadIds,
    get lastRuntime(): FakeCodexRuntime | undefined {
      return runtimes.at(-1);
    },
  };
}

const providerSessionDirectoryTestLayer = Layer.succeed(ProviderSessionDirectory, {
  upsert: () => Effect.void,
  touchLastSeen: () => Effect.void,
  getProvider: () =>
    Effect.die(new Error("ProviderSessionDirectory.getProvider is not used in test")),
  getBinding: () => Effect.succeed(Option.none()),
  listThreadIds: () => Effect.succeed([]),
  listBindings: () => Effect.succeed([]),
});

const validationRuntimeFactory = makeRuntimeFactory();
const validationLayer = it.layer(
  Layer.effect(
    CodexAdapter,
    Effect.gen(function* () {
      const codexConfig = decodeCodexSettings({});
      return yield* makeCodexAdapter(codexConfig, {
        makeRuntime: validationRuntimeFactory.factory,
      });
    }),
  ).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(providerSessionDirectoryTestLayer),
    Layer.provideMerge(NodeServices.layer),
  ),
);

validationLayer("CodexAdapterLive validation", (it) => {
  it.effect("returns validation error for non-codex provider on startSession", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const result = yield* adapter
        .startSession({
          provider: ProviderDriverKind.make("claudeAgent"),
          threadId: asThreadId("thread-1"),
          runtimeMode: "full-access",
        })
        .pipe(Effect.result);

      NodeAssert.equal(result._tag, "Failure");
      NodeAssert.deepStrictEqual(
        result.failure,
        new ProviderAdapterValidationError({
          provider: ProviderDriverKind.make("codex"),
          operation: "startSession",
          issue: "Expected provider 'codex' but received 'claudeAgent'.",
        }),
      );
      NodeAssert.equal(validationRuntimeFactory.factory.mock.calls.length, 0);
    }),
  );
  it.effect("maps codex model options before starting a session", () =>
    Effect.gen(function* () {
      validationRuntimeFactory.factory.mockClear();
      const adapter = yield* CodexAdapter;

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.3-codex", [
          { id: "serviceTier", value: "priority" },
        ]),
        runtimeMode: "full-access",
      });

      NodeAssert.deepStrictEqual(validationRuntimeFactory.factory.mock.calls[0]?.[0], {
        binaryPath: "codex",
        cwd: process.cwd(),
        launchArgs: "",
        model: "gpt-5.3-codex",
        providerInstanceId: ProviderInstanceId.make("codex"),
        serviceTier: "priority",
        threadId: asThreadId("thread-1"),
        runtimeMode: "full-access",
      });
    }),
  );
});

const t3EnvironmentRuntimeFactory = makeRuntimeFactory();
const t3EnvironmentLayer = it.layer(
  Layer.effect(
    CodexAdapter,
    Effect.gen(function* () {
      const codexConfig = decodeCodexSettings({});
      return yield* makeCodexAdapter(codexConfig, {
        environment: { CUSTOM_FLAG: "custom" },
        makeRuntime: t3EnvironmentRuntimeFactory.factory,
      });
    }),
  ).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(providerSessionDirectoryTestLayer),
    Layer.provideMerge(NodeServices.layer),
  ),
);

const testT3Environment = {
  serverUrl: "http://127.0.0.1:3773",
  environmentId: EnvironmentId.make("env-1"),
  projectId: ProjectId.make("project-1"),
  workspaceRoot: "/tmp/workspace",
  threadId: asThreadId("thread-t3-env-origin"),
  token: "t3-token-1",
} as const;

t3EnvironmentLayer("CodexAdapterLive t3Environment injection", (it) => {
  it.effect("merges T3_* vars and the MCP bearer token into the spawn environment", () => {
    const threadId = asThreadId("thread-t3-env-mcp");
    return Effect.gen(function* () {
      McpProviderSession.setMcpProviderSession({
        environmentId: EnvironmentId.make("env-1"),
        threadId,
        providerSessionId: "mcp-session-1",
        providerInstanceId: ProviderInstanceId.make("codex"),
        endpoint: "http://127.0.0.1:3773/mcp",
        authorizationHeader: "Bearer mcp-token",
      });
      const adapter = yield* CodexAdapter;
      yield* adapter.startSession({
        threadId,
        runtimeMode: "full-access",
        t3Environment: testT3Environment,
      });

      const options = t3EnvironmentRuntimeFactory.lastRuntime?.options;
      NodeAssert.equal(options?.environment?.CUSTOM_FLAG, "custom");
      NodeAssert.equal(options?.environment?.T3_MCP_BEARER_TOKEN, "mcp-token");
      NodeAssert.equal(options?.environment?.T3_SERVER_URL, "http://127.0.0.1:3773");
      NodeAssert.equal(options?.environment?.T3_ENVIRONMENT_ID, "env-1");
      NodeAssert.equal(options?.environment?.T3_PROJECT_ID, "project-1");
      NodeAssert.equal(options?.environment?.T3_WORKSPACE_ROOT, "/tmp/workspace");
      NodeAssert.equal(options?.environment?.T3_THREAD_ID, "thread-t3-env-origin");
      NodeAssert.equal(options?.environment?.T3_SERVER_TOKEN, "t3-token-1");
      NodeAssert.deepEqual(options?.appServerArgs, [
        "-c",
        "mcp_servers.t3-code.url=http://127.0.0.1:3773/mcp",
        "-c",
        'mcp_servers.t3-code.bearer_token_env_var="T3_MCP_BEARER_TOKEN"',
      ]);
    }).pipe(
      Effect.ensuring(Effect.sync(() => McpProviderSession.clearMcpProviderSession(threadId))),
    );
  });

  it.effect("merges T3_* vars over options.environment when no MCP session exists", () =>
    Effect.gen(function* () {
      const threadId = asThreadId("thread-t3-env-no-mcp");
      McpProviderSession.clearMcpProviderSession(threadId);
      const adapter = yield* CodexAdapter;
      yield* adapter.startSession({
        threadId,
        runtimeMode: "full-access",
        t3Environment: testT3Environment,
      });

      const options = t3EnvironmentRuntimeFactory.lastRuntime?.options;
      NodeAssert.deepEqual(options?.environment, {
        CUSTOM_FLAG: "custom",
        T3_SERVER_URL: "http://127.0.0.1:3773",
        T3_ENVIRONMENT_ID: "env-1",
        T3_PROJECT_ID: "project-1",
        T3_WORKSPACE_ROOT: "/tmp/workspace",
        T3_THREAD_ID: "thread-t3-env-origin",
        T3_SERVER_TOKEN: "t3-token-1",
      });
      NodeAssert.equal(options?.appServerArgs, undefined);
    }),
  );

  it.effect("keeps the spawn environment untouched when t3Environment is absent", () =>
    Effect.gen(function* () {
      const threadId = asThreadId("thread-t3-env-absent");
      McpProviderSession.clearMcpProviderSession(threadId);
      const adapter = yield* CodexAdapter;
      yield* adapter.startSession({
        threadId,
        runtimeMode: "full-access",
      });

      const options = t3EnvironmentRuntimeFactory.lastRuntime?.options;
      NodeAssert.deepEqual(options?.environment, { CUSTOM_FLAG: "custom" });
      NodeAssert.equal(options?.appServerArgs, undefined);
    }),
  );
});

const sessionRuntimeFactory = makeRuntimeFactory();
const sessionErrorLayer = it.layer(
  Layer.effect(
    CodexAdapter,
    Effect.gen(function* () {
      const codexConfig = decodeCodexSettings({});
      return yield* makeCodexAdapter(codexConfig, {
        makeRuntime: sessionRuntimeFactory.factory,
      });
    }),
  ).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(providerSessionDirectoryTestLayer),
    Layer.provideMerge(NodeServices.layer),
  ),
);

sessionErrorLayer("CodexAdapterLive session errors", (it) => {
  it.effect("maps missing adapter sessions to ProviderAdapterSessionNotFoundError", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const result = yield* adapter
        .sendTurn({
          threadId: asThreadId("sess-missing"),
          input: "hello",
          attachments: [],
        })
        .pipe(Effect.result);

      NodeAssert.equal(result._tag, "Failure");
      NodeAssert.equal(result.failure._tag, "ProviderAdapterSessionNotFoundError");
      NodeAssert.equal(result.failure.provider, "codex");
      NodeAssert.equal(result.failure.threadId, "sess-missing");
    }),
  );

  it.effect("maps codex model options before sending a turn", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("sess-missing"),
        runtimeMode: "full-access",
      });
      const runtime = sessionRuntimeFactory.lastRuntime;
      NodeAssert.ok(runtime);
      runtime.sendTurnImpl.mockClear();

      yield* Effect.ignore(
        adapter.sendTurn({
          threadId: asThreadId("sess-missing"),
          input: "hello",
          modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.3-codex", [
            { id: "reasoningEffort", value: "high" },
            { id: "serviceTier", value: "priority" },
          ]),
          attachments: [],
        }),
      );

      NodeAssert.deepStrictEqual(runtime.sendTurnImpl.mock.calls[0]?.[0], {
        input: "hello",
        model: "gpt-5.3-codex",
        effort: "high",
        serviceTier: "priority",
      });
    }),
  );

  it.effect("surfaces the runtime steering result", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const threadId = asThreadId("sess-steered-result");
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("codex"),
        threadId,
        runtimeMode: "full-access",
      });
      const runtime = sessionRuntimeFactory.lastRuntime;
      NodeAssert.ok(runtime);
      runtime.sendTurnImpl.mockResolvedValueOnce({
        threadId,
        turnId: asTurnId("active-turn"),
        steeredIntoActiveTurn: true,
      });

      const result = yield* adapter.sendTurn({
        threadId,
        input: "steer",
        attachments: [],
      });

      NodeAssert.deepStrictEqual(result, {
        threadId,
        turnId: asTurnId("active-turn"),
        steeredIntoActiveTurn: true,
      });
    }),
  );

  it.effect("passes configured launch args into the session runtime", () => {
    const runtimeFactory = makeRuntimeFactory();
    const layer = Layer.effect(
      CodexAdapter,
      Effect.gen(function* () {
        const codexConfig = decodeCodexSettings({ launchArgs: "--strict-config --enable foo" });
        return yield* makeCodexAdapter(codexConfig, {
          makeRuntime: runtimeFactory.factory,
        });
      }),
    ).pipe(
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(providerSessionDirectoryTestLayer),
      Layer.provideMerge(NodeServices.layer),
    );

    return Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("sess-launch-args"),
        runtimeMode: "full-access",
      });

      const runtime = runtimeFactory.lastRuntime;
      NodeAssert.ok(runtime);
      NodeAssert.equal(runtime.options.launchArgs, "--strict-config --enable foo");
    }).pipe(Effect.provide(layer));
  });

  it.effect("uses T3CODE_CODEX_LAUNCH_ARGS for the session runtime", () => {
    const runtimeFactory = makeRuntimeFactory();
    const layer = Layer.effect(
      CodexAdapter,
      Effect.gen(function* () {
        const codexConfig = decodeCodexSettings({ launchArgs: "--enable settings-feature" });
        return yield* makeCodexAdapter(codexConfig, {
          environment: { T3CODE_CODEX_LAUNCH_ARGS: " --strict-config --enable env-feature " },
          makeRuntime: runtimeFactory.factory,
        });
      }),
    ).pipe(
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(providerSessionDirectoryTestLayer),
      Layer.provideMerge(NodeServices.layer),
    );

    return Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("sess-launch-args-env"),
        runtimeMode: "full-access",
      });

      const runtime = runtimeFactory.lastRuntime;
      NodeAssert.ok(runtime);
      NodeAssert.equal(runtime.options.launchArgs, "--strict-config --enable env-feature");
    }).pipe(Effect.provide(layer));
  });

  it.effect("maps codex model options for the adapter's bound custom instance id", () => {
    const customInstanceId = ProviderInstanceId.make("codex_personal");
    const customRuntimeFactory = makeRuntimeFactory();
    const customLayer = Layer.effect(
      CodexAdapter,
      Effect.gen(function* () {
        const codexConfig = decodeCodexSettings({});
        return yield* makeCodexAdapter(codexConfig, {
          instanceId: customInstanceId,
          makeRuntime: customRuntimeFactory.factory,
        });
      }),
    ).pipe(
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(providerSessionDirectoryTestLayer),
      Layer.provideMerge(NodeServices.layer),
    );

    return Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("sess-custom-instance"),
        runtimeMode: "full-access",
      });
      const runtime = customRuntimeFactory.lastRuntime;
      NodeAssert.ok(runtime);
      runtime.sendTurnImpl.mockClear();

      yield* Effect.ignore(
        adapter.sendTurn({
          threadId: asThreadId("sess-custom-instance"),
          input: "hello",
          modelSelection: createModelSelection(
            ProviderInstanceId.make("codex_personal"),
            "gpt-5.3-codex",
            [
              { id: "reasoningEffort", value: "high" },
              { id: "serviceTier", value: "flex" },
            ],
          ),
          attachments: [],
        }),
      );

      NodeAssert.deepStrictEqual(runtime.sendTurnImpl.mock.calls[0]?.[0], {
        input: "hello",
        model: "gpt-5.3-codex",
        effort: "high",
        serviceTier: "flex",
      });
    }).pipe(Effect.provide(customLayer));
  });
});

const lifecycleRuntimeFactory = makeRuntimeFactory();
const lifecycleLayer = it.layer(
  Layer.effect(
    CodexAdapter,
    Effect.gen(function* () {
      const codexConfig = decodeCodexSettings({});
      return yield* makeCodexAdapter(codexConfig, {
        makeRuntime: lifecycleRuntimeFactory.factory,
      });
    }),
  ).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(providerSessionDirectoryTestLayer),
    Layer.provideMerge(NodeServices.layer),
  ),
);

function startLifecycleRuntime() {
  return Effect.gen(function* () {
    const adapter = yield* CodexAdapter;
    yield* adapter.startSession({
      provider: ProviderDriverKind.make("codex"),
      threadId: asThreadId("thread-1"),
      runtimeMode: "full-access",
    });
    const runtime = lifecycleRuntimeFactory.lastRuntime;
    NodeAssert.ok(runtime);
    return { adapter, runtime };
  });
}

lifecycleLayer("CodexAdapterLive lifecycle", (it) => {
  it.effect("maps completed agent message items to canonical item.completed events", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      const event: ProviderEvent = {
        id: asEventId("evt-msg-complete"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "item/completed",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        itemId: asItemId("msg_1"),
        payload: {
          completedAtMs: 1_778_000_000_000,
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "agentMessage",
            id: "msg_1",
            text: "done",
          },
        },
      };

      yield* runtime.emit(event);
      const firstEvent = yield* Fiber.join(firstEventFiber);

      NodeAssert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      NodeAssert.equal(firstEvent.value.type, "item.completed");
      if (firstEvent.value.type !== "item.completed") {
        return;
      }
      NodeAssert.equal(firstEvent.value.itemId, "msg_1");
      NodeAssert.equal(firstEvent.value.turnId, "turn-1");
      NodeAssert.equal(firstEvent.value.payload.itemType, "assistant_message");
    }),
  );

  it.effect("labels MCP lifecycle entries with server and tool names", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      yield* runtime.emit({
        id: asEventId("evt-mcp-complete"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "item/completed",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        itemId: asItemId("mcp_1"),
        payload: {
          completedAtMs: 1_778_000_000_000,
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "mcpToolCall",
            id: "mcp_1",
            server: "t3-code",
            tool: "preview_status",
            arguments: {},
            durationMs: 12,
            error: null,
            result: { content: [{ type: "text", text: "attached" }] },
            status: "completed",
          },
        },
      });
      const firstEvent = yield* Fiber.join(firstEventFiber);

      NodeAssert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some" || firstEvent.value.type !== "item.completed") {
        return;
      }
      NodeAssert.equal(firstEvent.value.payload.itemType, "mcp_tool_call");
      NodeAssert.equal(firstEvent.value.payload.title, "t3-code · preview_status");
      NodeAssert.deepStrictEqual(firstEvent.value.payload.data, {
        completedAtMs: 1_778_000_000_000,
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "mcpToolCall",
          id: "mcp_1",
          server: "t3-code",
          tool: "preview_status",
          arguments: {},
          durationMs: 12,
          error: null,
          result: { content: [{ type: "text", text: "attached" }] },
          status: "completed",
        },
      });
    }),
  );

  it.effect("maps completed plan items to canonical proposed-plan completion events", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      const event: ProviderEvent = {
        id: asEventId("evt-plan-complete"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "item/completed",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        itemId: asItemId("plan_1"),
        payload: {
          completedAtMs: 1_778_000_000_000,
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "plan",
            id: "plan_1",
            text: "## Final plan\n\n- one\n- two",
          },
        },
      };

      yield* runtime.emit(event);
      const firstEvent = yield* Fiber.join(firstEventFiber);

      NodeAssert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      NodeAssert.equal(firstEvent.value.type, "turn.proposed.completed");
      if (firstEvent.value.type !== "turn.proposed.completed") {
        return;
      }
      NodeAssert.equal(firstEvent.value.turnId, "turn-1");
      NodeAssert.equal(firstEvent.value.payload.planMarkdown, "## Final plan\n\n- one\n- two");
    }),
  );

  it.effect("maps plan deltas to canonical proposed-plan delta events", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      yield* runtime.emit({
        id: asEventId("evt-plan-delta"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "item/plan/delta",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        itemId: asItemId("plan_1"),
        payload: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "plan_1",
          delta: "## Final plan",
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      NodeAssert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      NodeAssert.equal(firstEvent.value.type, "turn.proposed.delta");
      if (firstEvent.value.type !== "turn.proposed.delta") {
        return;
      }
      NodeAssert.equal(firstEvent.value.turnId, "turn-1");
      NodeAssert.equal(firstEvent.value.payload.delta, "## Final plan");
    }),
  );

  it.effect("maps session/closed lifecycle events to canonical session.exited runtime events", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      const event: ProviderEvent = {
        id: asEventId("evt-session-closed"),
        kind: "session",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "session/closed",
        message: "Session stopped",
      };

      yield* runtime.emit(event);
      const firstEvent = yield* Fiber.join(firstEventFiber);

      NodeAssert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      NodeAssert.equal(firstEvent.value.type, "session.exited");
      if (firstEvent.value.type !== "session.exited") {
        return;
      }
      NodeAssert.equal(firstEvent.value.threadId, "thread-1");
      NodeAssert.equal(firstEvent.value.payload.reason, "Session stopped");
    }),
  );

  it.effect("maps retryable Codex error notifications to runtime.warning", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      yield* runtime.emit({
        id: asEventId("evt-retryable-error"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "error",
        turnId: asTurnId("turn-1"),
        payload: {
          threadId: "thread-1",
          turnId: "turn-1",
          error: {
            message: "Reconnecting... 2/5",
          },
          willRetry: true,
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      NodeAssert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      NodeAssert.equal(firstEvent.value.type, "runtime.warning");
      if (firstEvent.value.type !== "runtime.warning") {
        return;
      }
      NodeAssert.equal(firstEvent.value.turnId, "turn-1");
      NodeAssert.equal(firstEvent.value.payload.message, "Reconnecting... 2/5");
    }),
  );

  it.effect("maps process stderr notifications to runtime.warning", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      yield* runtime.emit({
        id: asEventId("evt-process-stderr"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "process/stderr",
        turnId: asTurnId("turn-1"),
        message: "The filename or extension is too long. (os error 206)",
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      NodeAssert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      NodeAssert.equal(firstEvent.value.type, "runtime.warning");
      if (firstEvent.value.type !== "runtime.warning") {
        return;
      }
      NodeAssert.equal(firstEvent.value.turnId, "turn-1");
      NodeAssert.equal(
        firstEvent.value.payload.message,
        "The filename or extension is too long. (os error 206)",
      );
    }),
  );

  it.effect("maps realtime started notifications with upstream realtime session ids", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      yield* runtime.emit({
        id: asEventId("evt-realtime-started"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "thread/realtime/started",
        payload: {
          threadId: "thread-1",
          realtimeSessionId: "realtime-session-1",
          version: "v2",
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      NodeAssert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      NodeAssert.equal(firstEvent.value.type, "thread.realtime.started");
      if (firstEvent.value.type !== "thread.realtime.started") {
        return;
      }
      NodeAssert.equal(firstEvent.value.threadId, "thread-1");
      NodeAssert.equal(firstEvent.value.payload.realtimeSessionId, "realtime-session-1");
    }),
  );

  it.effect("maps fatal websocket stderr notifications to runtime.error", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      yield* runtime.emit({
        id: asEventId("evt-process-stderr-websocket"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "process/stderr",
        turnId: asTurnId("turn-1"),
        message:
          "2026-03-31T18:14:06.833399Z ERROR codex_api::endpoint::responses_websocket: failed to connect to websocket: HTTP error: 503 Service Unavailable, url: wss://chatgpt.com/backend-api/codex/responses",
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      NodeAssert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      NodeAssert.equal(firstEvent.value.type, "runtime.error");
      if (firstEvent.value.type !== "runtime.error") {
        return;
      }
      NodeAssert.equal(firstEvent.value.turnId, "turn-1");
      NodeAssert.equal(firstEvent.value.payload.class, "provider_error");
      NodeAssert.equal(
        firstEvent.value.payload.message,
        "2026-03-31T18:14:06.833399Z ERROR codex_api::endpoint::responses_websocket: failed to connect to websocket: HTTP error: 503 Service Unavailable, url: wss://chatgpt.com/backend-api/codex/responses",
      );
    }),
  );

  it.effect("preserves request type when mapping serverRequest/resolved", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      const event: ProviderEvent = {
        id: asEventId("evt-request-resolved"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "serverRequest/resolved",
        requestKind: "command",
        requestId: ApprovalRequestId.make("req-1"),
        payload: {
          threadId: "thread-1",
          requestId: "req-1",
        },
      };

      yield* runtime.emit(event);
      const firstEvent = yield* Fiber.join(firstEventFiber);

      NodeAssert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      NodeAssert.equal(firstEvent.value.type, "request.resolved");
      if (firstEvent.value.type !== "request.resolved") {
        return;
      }
      NodeAssert.equal(firstEvent.value.payload.requestType, "command_execution_approval");
    }),
  );

  it.effect("preserves file-read request type when mapping serverRequest/resolved", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      const event: ProviderEvent = {
        id: asEventId("evt-file-read-request-resolved"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "serverRequest/resolved",
        requestKind: "file-read",
        requestId: ApprovalRequestId.make("req-file-read-1"),
        payload: {
          threadId: "thread-1",
          requestId: "req-file-read-1",
        },
      };

      yield* runtime.emit(event);
      const firstEvent = yield* Fiber.join(firstEventFiber);

      NodeAssert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      NodeAssert.equal(firstEvent.value.type, "request.resolved");
      if (firstEvent.value.type !== "request.resolved") {
        return;
      }
      NodeAssert.equal(firstEvent.value.payload.requestType, "file_read_approval");
    }),
  );

  it.effect("preserves explicit empty multi-select user-input answers", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      const event: ProviderEvent = {
        id: asEventId("evt-user-input-empty"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "item/tool/requestUserInput/answered",
        payload: {
          answers: {
            scope: {
              answers: [],
            },
          },
        },
      };

      yield* runtime.emit(event);
      const firstEvent = yield* Fiber.join(firstEventFiber);

      NodeAssert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      NodeAssert.equal(firstEvent.value.type, "user-input.resolved");
      if (firstEvent.value.type !== "user-input.resolved") {
        return;
      }
      NodeAssert.deepEqual(firstEvent.value.payload.answers, {
        scope: [],
      });
    }),
  );

  it.effect("maps windowsSandbox/setupCompleted to session state and warning on failure", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 2)).pipe(
        Effect.forkChild,
      );

      const event: ProviderEvent = {
        id: asEventId("evt-windows-sandbox-failed"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "windowsSandbox/setupCompleted",
        message: "Sandbox setup failed",
        payload: {
          mode: "unelevated",
          success: false,
          error: "unsupported environment",
        },
      };

      yield* runtime.emit(event);
      const events = Array.from(yield* Fiber.join(eventsFiber));

      NodeAssert.equal(events.length, 2);

      const firstEvent = events[0];
      const secondEvent = events[1];

      NodeAssert.equal(firstEvent?.type, "session.state.changed");
      if (firstEvent?.type === "session.state.changed") {
        NodeAssert.equal(firstEvent.payload.state, "error");
        NodeAssert.equal(firstEvent.payload.reason, "Sandbox setup failed");
      }

      NodeAssert.equal(secondEvent?.type, "runtime.warning");
      if (secondEvent?.type === "runtime.warning") {
        NodeAssert.equal(secondEvent.payload.message, "Sandbox setup failed");
      }
    }),
  );

  it.effect(
    "maps requestUserInput requests and answered notifications to canonical user-input events",
    () =>
      Effect.gen(function* () {
        const { adapter, runtime } = yield* startLifecycleRuntime();
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 2)).pipe(
          Effect.forkChild,
        );

        yield* runtime.emit({
          id: asEventId("evt-user-input-requested"),
          kind: "request",
          provider: ProviderDriverKind.make("codex"),
          threadId: asThreadId("thread-1"),
          createdAt: "2026-01-01T00:00:00.000Z",
          method: "item/tool/requestUserInput",
          requestId: ApprovalRequestId.make("req-user-input-1"),
          payload: {
            itemId: "item-user-input-1",
            threadId: "thread-1",
            turnId: "turn-1",
            questions: [
              {
                id: "sandbox_mode",
                header: "Sandbox",
                question: "Which mode should be used?",
                options: [
                  {
                    label: "workspace-write",
                    description: "Allow workspace writes only",
                  },
                ],
              },
            ],
          },
        } satisfies ProviderEvent);
        yield* runtime.emit({
          id: asEventId("evt-user-input-resolved"),
          kind: "notification",
          provider: ProviderDriverKind.make("codex"),
          threadId: asThreadId("thread-1"),
          createdAt: "2026-01-01T00:00:00.000Z",
          method: "item/tool/requestUserInput/answered",
          requestId: ApprovalRequestId.make("req-user-input-1"),
          payload: {
            answers: {
              sandbox_mode: {
                answers: ["workspace-write"],
              },
            },
          },
        } satisfies ProviderEvent);

        const events = Array.from(yield* Fiber.join(eventsFiber));
        NodeAssert.equal(events[0]?.type, "user-input.requested");
        if (events[0]?.type === "user-input.requested") {
          NodeAssert.equal(events[0].requestId, "req-user-input-1");
          NodeAssert.equal(events[0].payload.questions[0]?.id, "sandbox_mode");
          NodeAssert.equal(events[0].payload.questions[0]?.multiSelect, false);
        }

        NodeAssert.equal(events[1]?.type, "user-input.resolved");
        if (events[1]?.type === "user-input.resolved") {
          NodeAssert.equal(events[1].requestId, "req-user-input-1");
          NodeAssert.deepEqual(events[1].payload.answers, {
            sandbox_mode: "workspace-write",
          });
        }
      }),
  );

  it.effect("unwraps Codex token usage payloads for context window events", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      yield* runtime.emit({
        id: asEventId("evt-codex-thread-token-usage-updated"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "thread/tokenUsage/updated",
        payload: {
          threadId: "thread-1",
          turnId: "turn-1",
          tokenUsage: {
            total: {
              inputTokens: 11_833,
              cachedInputTokens: 3456,
              outputTokens: 6,
              reasoningOutputTokens: 0,
              totalTokens: 11_839,
            },
            last: {
              inputTokens: 120,
              cachedInputTokens: 0,
              outputTokens: 6,
              reasoningOutputTokens: 0,
              totalTokens: 126,
            },
            modelContextWindow: 258_400,
          },
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);
      NodeAssert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      NodeAssert.equal(firstEvent.value.type, "thread.token-usage.updated");
      if (firstEvent.value.type !== "thread.token-usage.updated") {
        return;
      }

      NodeAssert.deepEqual(firstEvent.value.payload.usage, {
        usedTokens: 126,
        totalProcessedTokens: 11_839,
        maxTokens: 258_400,
        inputTokens: 120,
        cachedInputTokens: 0,
        outputTokens: 6,
        reasoningOutputTokens: 0,
        lastUsedTokens: 126,
        lastInputTokens: 120,
        lastCachedInputTokens: 0,
        lastOutputTokens: 6,
        lastReasoningOutputTokens: 0,
        compactsAutomatically: true,
      });
    }),
  );

  it.effect(
    "extracts a collabAgentToolCall spawnAgent lifecycle into task.started/progress/completed events",
    () =>
      Effect.gen(function* () {
        const { adapter, runtime } = yield* startLifecycleRuntime();
        // 4 item.* rows (one per item/started + item/completed pair below)
        // plus 3 task.* rows (started, progress, completed).
        const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 7).pipe(
          Stream.runCollect,
          Effect.forkChild,
        );

        // 1. spawnAgent item starts: the tool call is issued and the child
        // thread is pendingInit — this is the birth of the subagent task.
        yield* runtime.emit({
          id: asEventId("evt-collab-spawn-started"),
          kind: "notification",
          provider: ProviderDriverKind.make("codex"),
          createdAt: "2026-01-01T00:00:00.000Z",
          method: "item/started",
          threadId: asThreadId("thread-1"),
          turnId: asTurnId("turn-1"),
          itemId: asItemId("collab_1"),
          payload: {
            startedAtMs: 1_777_999_999_000,
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              type: "collabAgentToolCall",
              id: "collab_1",
              tool: "spawnAgent",
              status: "inProgress",
              senderThreadId: "thread-1",
              receiverThreadIds: ["child-thread-1"],
              model: "gpt-5.3-codex",
              prompt: "Investigate the flaky test suite and report back with findings.",
              agentsStates: {
                "child-thread-1": { status: "pendingInit" },
              },
            },
          },
        } satisfies ProviderEvent);

        // 2. spawnAgent item completes: the spawn call itself is done, but
        // the child thread is now merely "running" — not a terminal state.
        yield* runtime.emit({
          id: asEventId("evt-collab-spawn-completed"),
          kind: "notification",
          provider: ProviderDriverKind.make("codex"),
          createdAt: "2026-01-01T00:00:01.000Z",
          method: "item/completed",
          threadId: asThreadId("thread-1"),
          turnId: asTurnId("turn-1"),
          itemId: asItemId("collab_1"),
          payload: {
            completedAtMs: 1_778_000_000_000,
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              type: "collabAgentToolCall",
              id: "collab_1",
              tool: "spawnAgent",
              status: "completed",
              senderThreadId: "thread-1",
              receiverThreadIds: ["child-thread-1"],
              model: "gpt-5.3-codex",
              prompt: "Investigate the flaky test suite and report back with findings.",
              agentsStates: {
                "child-thread-1": { status: "running" },
              },
            },
          },
        } satisfies ProviderEvent);

        // 3. a later "wait" item starts on the same child thread — no task
        // event, since a wait call starting carries no new agent status.
        yield* runtime.emit({
          id: asEventId("evt-collab-wait-started"),
          kind: "notification",
          provider: ProviderDriverKind.make("codex"),
          createdAt: "2026-01-01T00:00:02.000Z",
          method: "item/started",
          threadId: asThreadId("thread-1"),
          turnId: asTurnId("turn-1"),
          itemId: asItemId("collab_2"),
          payload: {
            startedAtMs: 1_778_000_001_500,
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              type: "collabAgentToolCall",
              id: "collab_2",
              tool: "wait",
              status: "inProgress",
              senderThreadId: "thread-1",
              receiverThreadIds: ["child-thread-1"],
              agentsStates: {
                "child-thread-1": { status: "running" },
              },
            },
          },
        } satisfies ProviderEvent);

        // 4. the "wait" item completes and reports the child thread as
        // terminal — this is what finishes the subagent task.
        yield* runtime.emit({
          id: asEventId("evt-collab-wait-completed"),
          kind: "notification",
          provider: ProviderDriverKind.make("codex"),
          createdAt: "2026-01-01T00:00:03.000Z",
          method: "item/completed",
          threadId: asThreadId("thread-1"),
          turnId: asTurnId("turn-1"),
          itemId: asItemId("collab_2"),
          payload: {
            completedAtMs: 1_778_000_003_000,
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              type: "collabAgentToolCall",
              id: "collab_2",
              tool: "wait",
              status: "completed",
              senderThreadId: "thread-1",
              receiverThreadIds: ["child-thread-1"],
              agentsStates: {
                "child-thread-1": {
                  status: "completed",
                  message: "Test suite is stable now.",
                },
              },
            },
          },
        } satisfies ProviderEvent);

        const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));

        // The generic item.* rows are still emitted unchanged, and now carry
        // a real title instead of `undefined`.
        const itemEvents = runtimeEvents.filter(
          (event) => event.type === "item.started" || event.type === "item.completed",
        );
        NodeAssert.equal(itemEvents.length, 4);
        for (const itemEvent of itemEvents) {
          if (itemEvent.type === "item.started" || itemEvent.type === "item.completed") {
            NodeAssert.equal(itemEvent.payload.itemType, "collab_agent_tool_call");
            NodeAssert.equal(itemEvent.payload.title, "Subagent task");
          }
        }
        const spawnItemEvent = itemEvents[0];
        NodeAssert.ok(
          spawnItemEvent?.type === "item.started" || spawnItemEvent?.type === "item.completed",
        );
        if (spawnItemEvent?.type === "item.started" || spawnItemEvent?.type === "item.completed") {
          NodeAssert.deepEqual(spawnItemEvent.payload.data, {
            toolCallId: "collab_1",
            toolName: "Task",
            collabTool: "spawnAgent",
            receiverThreadIds: ["child-thread-1"],
            agentsStates: {
              "child-thread-1": { status: "pendingInit" },
            },
            input: {
              prompt: "Investigate the flaky test suite and report back with findings.",
              description: "Investigate the flaky test suite and report back with findings.",
              subagent_type: "gpt-5.3-codex",
            },
          });
          NodeAssert.equal(
            (spawnItemEvent.raw?.payload as { item?: { type?: string } } | undefined)?.item?.type,
            "collabAgentToolCall",
          );
        }
        const waitItemEvent = itemEvents[2];
        if (waitItemEvent?.type === "item.started" || waitItemEvent?.type === "item.completed") {
          NodeAssert.equal(
            (waitItemEvent.payload.data as { collabTool?: string }).collabTool,
            "wait",
          );
          NodeAssert.equal((waitItemEvent.payload.data as { toolName?: string }).toolName, "wait");
        }

        const started = runtimeEvents.find((event) => event.type === "task.started");
        NodeAssert.equal(started?.type, "task.started");
        if (started?.type === "task.started") {
          NodeAssert.equal(started.payload.taskId, "child-thread-1");
          NodeAssert.equal(started.payload.toolUseId, "collab_1");
          NodeAssert.equal(started.payload.subagentType, "gpt-5.3-codex");
          NodeAssert.equal(
            started.payload.description,
            "Investigate the flaky test suite and report back with findings.",
          );
          NodeAssert.equal(
            started.payload.prompt,
            "Investigate the flaky test suite and report back with findings.",
          );
        }

        const progress = runtimeEvents.find((event) => event.type === "task.progress");
        NodeAssert.equal(progress?.type, "task.progress");
        if (progress?.type === "task.progress") {
          NodeAssert.equal(progress.payload.taskId, "child-thread-1");
          NodeAssert.equal(progress.payload.toolUseId, "collab_1");
          NodeAssert.equal(progress.payload.subagentType, "gpt-5.3-codex");
          NodeAssert.ok(progress.payload.description.length > 0);
        }

        const completed = runtimeEvents.find((event) => event.type === "task.completed");
        NodeAssert.equal(completed?.type, "task.completed");
        if (completed?.type === "task.completed") {
          NodeAssert.equal(completed.payload.taskId, "child-thread-1");
          NodeAssert.equal(completed.payload.status, "completed");
          NodeAssert.equal(completed.payload.toolUseId, "collab_2");
          NodeAssert.equal(completed.payload.summary, "Test suite is stable now.");
        }

        // Exactly one task.started/progress/completed each — the "wait"
        // item/started (step 3) must not have produced a spurious event.
        NodeAssert.equal(runtimeEvents.filter((event) => event.type.startsWith("task.")).length, 3);
      }),
  );

  it.effect("maps errored and shutdown agent states to failed/stopped task.completed", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      // 1 item.completed row plus 2 task.completed rows (one per receiver).
      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 3).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* runtime.emit({
        id: asEventId("evt-collab-closeagent-errored"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "item/completed",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        itemId: asItemId("collab_err"),
        payload: {
          completedAtMs: 1_778_000_000_000,
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "collabAgentToolCall",
            id: "collab_err",
            tool: "wait",
            status: "completed",
            senderThreadId: "thread-1",
            receiverThreadIds: ["child-thread-err", "child-thread-shutdown"],
            agentsStates: {
              "child-thread-err": { status: "errored", message: "Agent crashed." },
              "child-thread-shutdown": { status: "shutdown" },
            },
          },
        },
      } satisfies ProviderEvent);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));

      const completedEvents = runtimeEvents.filter((event) => event.type === "task.completed");
      NodeAssert.equal(completedEvents.length, 2);

      const errored = completedEvents.find(
        (event) => event.type === "task.completed" && event.payload.taskId === "child-thread-err",
      );
      NodeAssert.equal(errored?.type, "task.completed");
      if (errored?.type === "task.completed") {
        NodeAssert.equal(errored.payload.status, "failed");
        NodeAssert.equal(errored.payload.summary, "Agent crashed.");
      }

      const shutdown = completedEvents.find(
        (event) =>
          event.type === "task.completed" && event.payload.taskId === "child-thread-shutdown",
      );
      NodeAssert.equal(shutdown?.type, "task.completed");
      if (shutdown?.type === "task.completed") {
        NodeAssert.equal(shutdown.payload.status, "stopped");
      }
    }),
  );

  it.effect("preserves a failed spawn status without a receiver thread", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const runtimeEventFiber = yield* Stream.take(adapter.streamEvents, 1).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* runtime.emit({
        id: asEventId("evt-collab-spawn-failed"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "item/completed",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        itemId: asItemId("collab-failed"),
        payload: {
          completedAtMs: 1_778_000_000_000,
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "collabAgentToolCall",
            id: "collab-failed",
            tool: "spawnAgent",
            status: "failed",
            senderThreadId: "thread-1",
            receiverThreadIds: [],
            prompt: "Try to start an unavailable agent",
            agentsStates: {},
          },
        },
      } satisfies ProviderEvent);

      const [event] = Array.from(yield* Fiber.join(runtimeEventFiber));
      NodeAssert.equal(event?.type, "item.completed");
      if (event?.type === "item.completed") {
        NodeAssert.equal(event.payload.status, "failed");
      }
    }),
  );

  it.effect(
    "extracts a subAgentActivity spawn plus the child's own turn end into task events",
    () =>
      Effect.gen(function* () {
        const { adapter, runtime } = yield* startLifecycleRuntime();
        // 1 item.started row, 1 task.started row, then 1 task.progress and
        // 1 task.completed from the child thread's renamed turn lifecycle.
        const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 4).pipe(
          Stream.runCollect,
          Effect.forkChild,
        );

        yield* runtime.emit({
          id: asEventId("evt-subagent-activity-started"),
          kind: "notification",
          provider: ProviderDriverKind.make("codex"),
          createdAt: "2026-01-01T00:00:00.000Z",
          method: "item/started",
          threadId: asThreadId("thread-1"),
          turnId: asTurnId("turn-1"),
          itemId: asItemId("child-activity-1"),
          payload: {
            startedAtMs: 1_777_999_999_000,
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              type: "subAgentActivity",
              id: "child-activity-1",
              kind: "started",
              agentPath: "root/reviewer",
              agentThreadId: "child-thread-1",
            },
          },
        } satisfies ProviderEvent);

        yield* runtime.emit({
          id: asEventId("evt-subagent-turn-started"),
          kind: "notification",
          provider: ProviderDriverKind.make("codex"),
          createdAt: "2026-01-01T00:00:01.000Z",
          method: CODEX_SUBAGENT_TURN_STARTED_METHOD,
          threadId: asThreadId("thread-1"),
          turnId: asTurnId("turn-1"),
          payload: {
            threadId: "child-thread-1",
            turn: { id: "child-turn-1", items: [], status: "inProgress" },
          },
        } satisfies ProviderEvent);

        yield* runtime.emit({
          id: asEventId("evt-subagent-turn-completed"),
          kind: "notification",
          provider: ProviderDriverKind.make("codex"),
          createdAt: "2026-01-01T00:00:02.000Z",
          method: CODEX_SUBAGENT_TURN_COMPLETED_METHOD,
          threadId: asThreadId("thread-1"),
          turnId: asTurnId("turn-1"),
          payload: {
            threadId: "child-thread-1",
            turn: { id: "child-turn-1", items: [], status: "completed" },
          },
        } satisfies ProviderEvent);

        const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
        NodeAssert.deepStrictEqual(
          runtimeEvents.map((event) => event.type),
          ["item.started", "task.started", "task.progress", "task.completed"],
        );

        const item = runtimeEvents[0];
        NodeAssert.equal(item?.type, "item.started");
        if (item?.type === "item.started") {
          NodeAssert.equal(item.payload.itemType, "collab_agent_tool_call");
          NodeAssert.equal(item.payload.title, "Subagent task");
          NodeAssert.deepEqual(item.payload.data, {
            toolCallId: "child-activity-1",
            toolName: "Task",
            collabTool: "spawnAgent",
            subAgentActivityKind: "started",
            agentPath: "root/reviewer",
            receiverThreadIds: ["child-thread-1"],
            agentsStates: {},
            input: {
              description: "root/reviewer",
              subagent_type: "reviewer",
            },
          });
        }

        const started = runtimeEvents[1];
        NodeAssert.equal(started?.type, "task.started");
        if (started?.type === "task.started") {
          NodeAssert.equal(started.payload.taskId, "child-thread-1");
          NodeAssert.equal(started.payload.toolUseId, "child-activity-1");
          NodeAssert.equal(started.payload.subagentType, "reviewer");
          NodeAssert.equal(started.payload.description, "root/reviewer");
        }

        // The renamed child turn lifecycle never becomes parent turn
        // lifecycle: it only moves the subagent's task row.
        const progress = runtimeEvents[2];
        NodeAssert.equal(progress?.type, "task.progress");
        if (progress?.type === "task.progress") {
          NodeAssert.equal(progress.payload.taskId, "child-thread-1");
          NodeAssert.equal(progress.turnId, asTurnId("turn-1"));
        }

        const completed = runtimeEvents[3];
        NodeAssert.equal(completed?.type, "task.completed");
        if (completed?.type === "task.completed") {
          NodeAssert.equal(completed.payload.taskId, "child-thread-1");
          NodeAssert.equal(completed.payload.status, "completed");
        }
      }),
  );

  it.effect("completes a subagent task as failed when the child's turn fails", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 1).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* runtime.emit({
        id: asEventId("evt-subagent-turn-failed"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:02.000Z",
        method: CODEX_SUBAGENT_TURN_COMPLETED_METHOD,
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        payload: {
          threadId: "child-thread-2",
          turn: {
            id: "child-turn-2",
            items: [],
            status: "failed",
            error: { message: "child ran out of context" },
          },
        },
      } satisfies ProviderEvent);

      const [event] = Array.from(yield* Fiber.join(runtimeEventsFiber));
      NodeAssert.equal(event?.type, "task.completed");
      if (event?.type === "task.completed") {
        NodeAssert.equal(event.payload.taskId, "child-thread-2");
        NodeAssert.equal(event.payload.status, "failed");
        NodeAssert.equal(event.payload.summary, "child ran out of context");
      }
    }),
  );

  it.effect("maps an interrupted subAgentActivity to a stopped task", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 2).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* runtime.emit({
        id: asEventId("evt-subagent-activity-interrupted"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "item/started",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        itemId: asItemId("child-activity-2"),
        payload: {
          startedAtMs: 1_777_999_999_000,
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "subAgentActivity",
            id: "child-activity-2",
            kind: "interrupted",
            agentPath: "root/reviewer",
            agentThreadId: "child-thread-3",
          },
        },
      } satisfies ProviderEvent);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      NodeAssert.deepStrictEqual(
        runtimeEvents.map((event) => event.type),
        ["item.started", "task.completed"],
      );
      const completed = runtimeEvents[1];
      if (completed?.type === "task.completed") {
        NodeAssert.equal(completed.payload.taskId, "child-thread-3");
        NodeAssert.equal(completed.payload.status, "stopped");
      }
      const item = runtimeEvents[0];
      if (item?.type === "item.started") {
        // A non-spawn operation must not open a second subagent group.
        NodeAssert.equal(
          (item.payload.data as { collabTool?: string } | undefined)?.collabTool,
          "closeAgent",
        );
      }
    }),
  );

  it.effect("keeps root subAgentActivity events flat for every lifecycle kind", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 3).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      for (const [index, kind] of (["started", "interacted", "interrupted"] as const).entries()) {
        yield* runtime.emit({
          id: asEventId(`evt-root-${kind}`),
          kind: "notification",
          provider: ProviderDriverKind.make("codex"),
          providerThreadId: "provider-root",
          createdAt: `2026-01-01T00:00:0${index}.000Z`,
          method: "item/started",
          threadId: asThreadId("thread-1"),
          turnId: asTurnId("turn-1"),
          itemId: asItemId(`root-${kind}`),
          payload: {
            startedAtMs: 1_777_999_999_000 + index,
            threadId: "provider-root",
            turnId: "turn-1",
            item: {
              type: "subAgentActivity",
              id: `root-${kind}`,
              kind,
              agentPath: "/root",
              agentThreadId: "provider-root",
            },
          },
        } satisfies ProviderEvent);
      }

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      NodeAssert.deepStrictEqual(
        runtimeEvents.map((event) => event.type),
        ["item.started", "item.started", "item.started"],
      );
      for (const event of runtimeEvents) {
        if (event.type === "item.started") {
          NodeAssert.equal(
            (event.payload.data as { agentPath?: string } | undefined)?.agentPath,
            "/root",
          );
        }
      }
    }),
  );

  it.effect("filters the provider root from mixed legacy collab receivers", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 2).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* runtime.emit({
        id: asEventId("evt-mixed-root-child"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        providerThreadId: "provider-root",
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "item/started",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        itemId: asItemId("mixed-root-child"),
        payload: {
          startedAtMs: 1_777_999_999_000,
          threadId: "provider-root",
          turnId: "turn-1",
          item: {
            type: "collabAgentToolCall",
            id: "mixed-root-child",
            tool: "spawnAgent",
            status: "inProgress",
            senderThreadId: "provider-root",
            receiverThreadIds: ["provider-root", "nested-child"],
            agentsStates: {
              "provider-root": { status: "running" },
              "nested-child": { status: "pendingInit" },
            },
          },
        },
      } satisfies ProviderEvent);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const item = runtimeEvents[0];
      NodeAssert.equal(item?.type, "item.started");
      if (item?.type === "item.started") {
        NodeAssert.deepStrictEqual(
          (item.payload.data as { receiverThreadIds?: string[] }).receiverThreadIds,
          ["nested-child"],
        );
      }
      const task = runtimeEvents[1];
      NodeAssert.equal(task?.type, "task.started");
      if (task?.type === "task.started") {
        NodeAssert.equal(task.payload.taskId, "nested-child");
      }
    }),
  );

  it.effect("keeps a root-only legacy sendInput completion flat", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const runtimeEventFiber = yield* Stream.take(adapter.streamEvents, 2).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* runtime.emit({
        id: asEventId("evt-root-only-send-input"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        providerThreadId: "provider-root",
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "item/completed",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        itemId: asItemId("root-only-send-input"),
        payload: {
          completedAtMs: 1_777_999_999_000,
          threadId: "provider-root",
          turnId: "turn-1",
          item: {
            type: "collabAgentToolCall",
            id: "root-only-send-input",
            tool: "sendInput",
            status: "completed",
            senderThreadId: "child-thread",
            receiverThreadIds: ["provider-root"],
            agentsStates: {
              "provider-root": { status: "running" },
            },
          },
        },
      } satisfies ProviderEvent);

      yield* runtime.emit({
        id: asEventId("evt-root-only-send-input-sentinel"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        providerThreadId: "provider-root",
        createdAt: "2026-01-01T00:00:01.000Z",
        method: "turn/diff/updated",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        payload: {
          threadId: "provider-root",
          turnId: "turn-1",
          diff: "sentinel diff",
        },
      } satisfies ProviderEvent);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventFiber));
      NodeAssert.deepStrictEqual(
        runtimeEvents.map((event) => event.type),
        ["item.completed", "turn.diff.updated"],
      );
      const item = runtimeEvents[0];
      if (item?.type === "item.completed") {
        NodeAssert.deepStrictEqual(
          (item.payload.data as { receiverThreadIds?: string[] }).receiverThreadIds,
          [],
        );
      }
    }),
  );
});

const scopedLifecycleRuntimeFactory = makeScopedRuntimeFactory();
const scopedLifecycleLayer = it.layer(
  Layer.effect(
    CodexAdapter,
    Effect.gen(function* () {
      const codexConfig = decodeCodexSettings({});
      return yield* makeCodexAdapter(codexConfig, {
        makeRuntime: scopedLifecycleRuntimeFactory.factory,
      });
    }),
  ).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(providerSessionDirectoryTestLayer),
    Layer.provideMerge(NodeServices.layer),
  ),
);

scopedLifecycleLayer("CodexAdapterLive scoped lifecycle", (it) => {
  it.effect("closes the externally owned session scope on stopSession", () =>
    Effect.gen(function* () {
      scopedLifecycleRuntimeFactory.releasedThreadIds.length = 0;
      const adapter = yield* CodexAdapter;

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-stop"),
        runtimeMode: "full-access",
      });

      const runtime = scopedLifecycleRuntimeFactory.lastRuntime;
      NodeAssert.ok(runtime);

      yield* adapter.stopSession(asThreadId("thread-stop"));

      NodeAssert.equal(runtime.closeImpl.mock.calls.length, 1);
      NodeAssert.deepStrictEqual(scopedLifecycleRuntimeFactory.releasedThreadIds, [
        asThreadId("thread-stop"),
      ]);
      NodeAssert.equal(yield* adapter.hasSession(asThreadId("thread-stop")), false);
    }),
  );
});

const scopedFailureRuntimeFactory = makeScopedRuntimeFactory({ failConstruction: true });
const scopedFailureLayer = it.layer(
  Layer.effect(
    CodexAdapter,
    Effect.gen(function* () {
      const codexConfig = decodeCodexSettings({});
      return yield* makeCodexAdapter(codexConfig, {
        makeRuntime: scopedFailureRuntimeFactory.factory,
      });
    }),
  ).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(providerSessionDirectoryTestLayer),
    Layer.provideMerge(NodeServices.layer),
  ),
);

scopedFailureLayer("CodexAdapterLive scoped startup failure", (it) => {
  it.effect("closes the externally owned session scope when startSession fails", () =>
    Effect.gen(function* () {
      scopedFailureRuntimeFactory.releasedThreadIds.length = 0;
      const adapter = yield* CodexAdapter;

      const result = yield* adapter
        .startSession({
          provider: ProviderDriverKind.make("codex"),
          threadId: asThreadId("thread-fail"),
          runtimeMode: "full-access",
        })
        .pipe(Effect.result);

      NodeAssert.equal(result._tag, "Failure");
      NodeAssert.equal(result.failure._tag, "ProviderAdapterProcessError");
      NodeAssert.deepStrictEqual(scopedFailureRuntimeFactory.releasedThreadIds, [
        asThreadId("thread-fail"),
      ]);
      NodeAssert.equal(yield* adapter.hasSession(asThreadId("thread-fail")), false);
    }),
  );
});

it.effect("flushes managed native logs when the adapter layer shuts down", () =>
  Effect.gen(function* () {
    const tempDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3-codex-adapter-native-log-"),
    );
    const basePath = NodePath.join(tempDir, "provider-native.ndjson");
    const runtimeFactory = makeRuntimeFactory();
    const scope = yield* Scope.make("sequential");
    let scopeClosed = false;

    try {
      const layer = Layer.effect(
        CodexAdapter,
        Effect.gen(function* () {
          const codexConfig = decodeCodexSettings({});
          return yield* makeCodexAdapter(codexConfig, {
            makeRuntime: runtimeFactory.factory,
            nativeEventLogPath: basePath,
          });
        }),
      ).pipe(
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
        Layer.provideMerge(ServerSettingsService.layerTest()),
        Layer.provideMerge(providerSessionDirectoryTestLayer),
        Layer.provideMerge(NodeServices.layer),
      );
      const context = yield* Layer.buildWithScope(layer, scope);
      const adapter = yield* Effect.service(CodexAdapter).pipe(Effect.provide(context));

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-logger"),
        runtimeMode: "full-access",
      });

      const runtime = runtimeFactory.lastRuntime;
      NodeAssert.ok(runtime);

      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);
      yield* runtime.emit({
        id: asEventId("evt-native-log"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-logger"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "process/stderr",
        message: "native flush test",
      } satisfies ProviderEvent);
      yield* Fiber.join(firstEventFiber);

      yield* Scope.close(scope, Exit.void);
      scopeClosed = true;

      const threadLogPath = NodePath.join(tempDir, "thread-logger.log");
      NodeAssert.equal(NodeFS.existsSync(threadLogPath), true);
      const contents = NodeFS.readFileSync(threadLogPath, "utf8");
      NodeAssert.match(contents, /NTIVE: .*"message":"native flush test"/);
    } finally {
      if (!scopeClosed) {
        yield* Scope.close(scope, Exit.void);
      }
      NodeFS.rmSync(tempDir, { recursive: true, force: true });
    }
  }),
);

const attachmentRuntimeFactory = makeRuntimeFactory();
const attachmentLayer = it.layer(
  Layer.effect(
    CodexAdapter,
    Effect.gen(function* () {
      const codexConfig = decodeCodexSettings({});
      return yield* makeCodexAdapter(codexConfig, {
        makeRuntime: attachmentRuntimeFactory.factory,
      });
    }),
  ).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "codex-attachments-" })),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(providerSessionDirectoryTestLayer),
    Layer.provideMerge(NodeServices.layer),
  ),
);

attachmentLayer("CodexAdapterLive attachments", (it) => {
  const writeAttachment = (
    attachmentsDir: string,
    attachment: ChatAttachment,
    bytes: Uint8Array,
  ) => {
    const path = NodePath.join(attachmentsDir, attachmentRelativePath(attachment));
    NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
    NodeFS.writeFileSync(path, bytes);
    return path;
  };

  it.effect("sends an image as a data url and a file as its path", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const { attachmentsDir } = yield* ServerConfig;
      const threadId = asThreadId("sess-attachments");
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("codex"),
        threadId,
        runtimeMode: "full-access",
      });
      const runtime = attachmentRuntimeFactory.lastRuntime;
      NodeAssert.ok(runtime);
      runtime.sendTurnImpl.mockClear();

      const image: ChatAttachment = {
        type: "image",
        id: "sess-attachments-12345678-1234-1234-1234-1234567890a1",
        name: "diagram.png",
        mimeType: "image/png",
        sizeBytes: 4,
      };
      const notes: ChatAttachment = {
        type: "file",
        id: "sess-attachments-12345678-1234-1234-1234-1234567890a2",
        name: "notes.txt",
        mimeType: "text/plain",
        sizeBytes: 5,
      };
      writeAttachment(attachmentsDir, image, Uint8Array.from([1, 2, 3, 4]));
      const notesPath = writeAttachment(attachmentsDir, notes, new TextEncoder().encode("hello"));

      yield* adapter.sendTurn({
        threadId,
        input: "look at these",
        attachments: [image, notes],
      });

      const sent = runtime.sendTurnImpl.mock.calls[0]?.[0];
      NodeAssert.deepStrictEqual(sent?.attachments, [
        { type: "image", url: "data:image/png;base64,AQIDBA==" },
        {
          type: "text",
          text: `The user attached this file. Read it from disk:\n- notes.txt (text/plain): ${notesPath}`,
        },
      ]);
      yield* Effect.forEach(sent?.attachments ?? [], (attachment) =>
        decodeCodexUserInput(attachment),
      );
    }),
  );

  it.effect("fails a turn whose file attachment is missing from the store", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const threadId = asThreadId("sess-attachments-missing");
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("codex"),
        threadId,
        runtimeMode: "full-access",
      });

      const result = yield* adapter
        .sendTurn({
          threadId,
          input: "look at this",
          attachments: [
            {
              type: "file",
              id: "sess-attachments-missing-12345678-1234-1234-1234-1234567890b1",
              name: "gone.txt",
              mimeType: "text/plain",
              sizeBytes: 5,
            },
          ],
        })
        .pipe(Effect.result);

      NodeAssert.equal(result._tag, "Failure");
      NodeAssert.equal(
        result._tag === "Failure" ? result.failure._tag : undefined,
        "ProviderAdapterRequestError",
      );
    }),
  );
});

// `CodexAdapter` gates the opaque cursor with `isCodexResumeCursorSchema` before
// it reaches the runtime, so a cursor the adapter reads arrives as
// `options.resumeCursor` and one it rejects does not. The runtime turns the
// first into `thread/resume` and the second into `thread/start`, which is why
// "runtimes built without a cursor" is this adapter's provider-session count.
function makeLifecycleRuntimeFactory() {
  const startedAt = "2026-01-01T00:00:00.000Z";
  let created = 0;

  const factory = vi.fn((options: CodexSessionRuntimeOptions) => {
    const runtime = new FakeCodexRuntime(options);
    const resumedThreadId = options.resumeCursor?.threadId;
    if (resumedThreadId === undefined) {
      created += 1;
    }
    const providerThreadId = resumedThreadId ?? `codex-thread-${created}`;
    runtime.startImpl.mockImplementation(() =>
      Promise.resolve({
        provider: ProviderDriverKind.make("codex"),
        status: "ready" as const,
        runtimeMode: options.runtimeMode,
        threadId: options.threadId,
        cwd: options.cwd,
        resumeCursor: { threadId: providerThreadId },
        createdAt: startedAt,
        updatedAt: startedAt,
      } satisfies ProviderSession),
    );
    return Effect.succeed(runtime);
  });

  return { factory, readProviderSessionsCreated: () => created };
}

const lifecycleConformanceRuntimeFactory = makeLifecycleRuntimeFactory();
const lifecycleConformanceLayer = it.layer(
  Layer.effect(
    CodexAdapter,
    Effect.gen(function* () {
      const codexConfig = decodeCodexSettings({});
      return yield* makeCodexAdapter(codexConfig, {
        makeRuntime: lifecycleConformanceRuntimeFactory.factory,
      });
    }),
  ).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(providerSessionDirectoryTestLayer),
    Layer.provideMerge(NodeServices.layer),
  ),
);

lifecycleConformanceLayer("CodexAdapterLive session lifecycle", (it) => {
  describeSessionLifecycleConformance(it, {
    name: "Codex",
    provider: ProviderDriverKind.make("codex"),
    capabilities: CODEX_ADAPTER_CAPABILITIES,
    runScenario: (body) =>
      Effect.gen(function* () {
        const adapter = yield* CodexAdapter;
        return yield* body({
          adapter,
          makeValidCursor: () => ({ threadId: "codex-thread-persisted" }),
          makeForeignCursor: () => ({ schemaVersion: 99, sessionId: "ses_persisted" }),
          readProviderSessionsCreated: () =>
            Effect.sync(lifecycleConformanceRuntimeFactory.readProviderSessionsCreated),
          // The fake runtime never rejects a thread id, so it cannot stage a
          // cursor naming a conversation Codex has lost.
        });
      }),
  });
});

const rateLimitTelemetryRuntimeFactory = makeRuntimeFactory();
const recordedRateLimitSamples: Array<ProviderUsageSample> = [];
const recordedRateLimitLimits: Array<ProviderAccountLimit> = [];
const rateLimitTelemetryInstanceId = ProviderInstanceId.make("codex_work");
const rateLimitTelemetryLayer = it.layer(
  Layer.effect(
    CodexAdapter,
    Effect.gen(function* () {
      const codexConfig = decodeCodexSettings({});
      return yield* makeCodexAdapter(codexConfig, {
        instanceId: rateLimitTelemetryInstanceId,
        makeRuntime: rateLimitTelemetryRuntimeFactory.factory,
        recordUsageSamples: ({ samples }) =>
          Effect.sync(() => {
            recordedRateLimitSamples.push(...samples);
          }),
        recordAccountLimit: (limit) =>
          Effect.sync(() => {
            recordedRateLimitLimits.push(limit);
          }),
      });
    }),
  ).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(providerSessionDirectoryTestLayer),
    Layer.provideMerge(NodeServices.layer),
  ),
);

rateLimitTelemetryLayer("CodexAdapterLive rate-limit telemetry", (it) => {
  const emitRateLimitsUpdated = (input: {
    readonly uuid: string;
    readonly rateLimits: EffectCodexSchema.V2AccountRateLimitsUpdatedNotification["rateLimits"];
  }) =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        runtimeMode: "full-access",
      });
      const runtime = rateLimitTelemetryRuntimeFactory.lastRuntime;
      NodeAssert.ok(runtime);
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);
      yield* runtime.emit({
        id: asEventId(input.uuid),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-08-14T10:00:00.000Z",
        method: "account/rateLimits/updated",
        threadId: asThreadId("thread-1"),
        payload: { rateLimits: input.rateLimits },
      });
      // The runtime event surfaces only after the same handler ran the
      // telemetry writes, so awaiting it orders the assertions safely.
      const firstEvent = yield* Fiber.join(firstEventFiber);
      NodeAssert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag === "Some") {
        NodeAssert.equal(firstEvent.value.type, "account.rate-limits.updated");
      }
    });

  it.effect("writes usage samples and a limit row for a reached notification", () =>
    Effect.gen(function* () {
      recordedRateLimitSamples.length = 0;
      recordedRateLimitLimits.length = 0;

      yield* emitRateLimitsUpdated({
        uuid: "evt-rate-limits-reached",
        rateLimits: {
          primary: { usedPercent: 40, resetsAt: 1787000000 },
          secondary: { usedPercent: 100, resetsAt: 1787207826 },
          rateLimitReachedType: "rate_limit_reached",
        },
      });

      NodeAssert.deepEqual(recordedRateLimitSamples, [
        {
          providerInstanceId: rateLimitTelemetryInstanceId,
          window: "primary",
          utilization: 40,
          resetsAt: "2026-08-17T20:53:20.000Z",
          source: "codex.app_server.notification",
          observedAt: "2026-08-14T10:00:00.000Z",
        },
        {
          providerInstanceId: rateLimitTelemetryInstanceId,
          window: "secondary",
          utilization: 100,
          resetsAt: "2026-08-20T06:37:06.000Z",
          source: "codex.app_server.notification",
          observedAt: "2026-08-14T10:00:00.000Z",
        },
      ]);
      NodeAssert.deepEqual(recordedRateLimitLimits, [
        {
          providerInstanceId: rateLimitTelemetryInstanceId,
          driver: ProviderDriverKind.make("codex"),
          kind: "usage-limit",
          detectedAt: "2026-08-14T10:00:00.000Z",
          resetsAt: "2026-08-20T06:37:06.000Z",
          resetsAtEstimated: false,
          source: "codex.app_server.notification",
          detail: "rateLimitReachedType=rate_limit_reached",
        },
      ]);
    }),
  );

  it.effect("writes only the carried window for a sparse healthy notification", () =>
    Effect.gen(function* () {
      recordedRateLimitSamples.length = 0;
      recordedRateLimitLimits.length = 0;

      yield* emitRateLimitsUpdated({
        uuid: "evt-rate-limits-sparse",
        rateLimits: {
          primary: { usedPercent: 7 },
        },
      });

      NodeAssert.deepEqual(recordedRateLimitSamples, [
        {
          providerInstanceId: rateLimitTelemetryInstanceId,
          window: "primary",
          utilization: 7,
          resetsAt: null,
          source: "codex.app_server.notification",
          observedAt: "2026-08-14T10:00:00.000Z",
        },
      ]);
      NodeAssert.deepEqual(recordedRateLimitLimits, []);
    }),
  );
});
