import * as NodeAssert from "node:assert/strict";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { AssistantMessage } from "@opencode-ai/sdk/v2";
import { it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { beforeEach } from "vite-plus/test";

import {
  OpenCodeSettings,
  type ProviderAccountLimit,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { ServerConfig } from "../../config.ts";
import { PersistenceSqlError } from "../../persistence/Errors.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { describeSessionLifecycleConformance } from "../testUtils/sessionLifecycleConformance.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import type { OpenCodeAdapterShape } from "../Services/OpenCodeAdapter.ts";
import {
  OpenCodeRuntime,
  OpenCodeRuntimeError,
  type OpenCodeRuntimeShape,
} from "../opencodeRuntime.ts";
import {
  appendOpenCodeAssistantTextDelta,
  isOpenCodeNotFound,
  isSameOpenCodeDirectory,
  makeOpenCodeAdapter,
  mergeOpenCodeAssistantText,
  type OpenCodeAdapterLiveOptions,
  OPENCODE_ADAPTER_CAPABILITIES,
} from "./OpenCodeAdapter.ts";

// Test-local service tag so the rest of the file can keep using `yield* OpenCodeAdapter`.
class OpenCodeAdapter extends Context.Service<OpenCodeAdapter, OpenCodeAdapterShape>()(
  "t3/provider/Layers/OpenCodeAdapter.test/OpenCodeAdapter",
) {}

const asThreadId = (value: string): ThreadId => ThreadId.make(value);

type MessageEntry = {
  info: {
    id: string;
    role: "user" | "assistant";
  };
  parts: Array<unknown>;
};

const runtimeMock = {
  state: {
    startCalls: [] as string[],
    sessionCreateUrls: [] as string[],
    sessionCreateInputs: [] as Array<Record<string, unknown>>,
    authHeaders: [] as Array<string | null>,
    abortCalls: [] as string[],
    closeCalls: [] as string[],
    revertCalls: [] as Array<{ sessionID: string; messageID?: string }>,
    promptCalls: [] as Array<unknown>,
    promptAsyncError: null as Error | null,
    closeError: null as Error | null,
    messages: [] as MessageEntry[],
    subscribedEvents: [] as unknown[],
    subscribedEventsReady: null as Promise<void> | null,
    sessionGetIds: [] as string[],
    missingSessionIds: new Set<string>(),
    transientErrorSessionIds: new Set<string>(),
    sessionDirectoryById: new Map<string, string>(),
    sessionUpdateCalls: [] as Array<{ sessionID: string; permission: unknown }>,
    forkCalls: [] as Array<{ sessionID: string; directory?: string }>,
  },
  reset() {
    this.state.startCalls.length = 0;
    this.state.sessionCreateUrls.length = 0;
    this.state.sessionCreateInputs.length = 0;
    this.state.authHeaders.length = 0;
    this.state.abortCalls.length = 0;
    this.state.closeCalls.length = 0;
    this.state.revertCalls.length = 0;
    this.state.promptCalls.length = 0;
    this.state.promptAsyncError = null;
    this.state.closeError = null;
    this.state.messages = [];
    this.state.subscribedEvents = [];
    this.state.subscribedEventsReady = null;
    this.state.sessionGetIds.length = 0;
    this.state.missingSessionIds.clear();
    this.state.transientErrorSessionIds.clear();
    this.state.sessionDirectoryById.clear();
    this.state.sessionUpdateCalls.length = 0;
    this.state.forkCalls.length = 0;
  },
};

const OpenCodeRuntimeTestDouble: OpenCodeRuntimeShape = {
  startOpenCodeServerProcess: ({ binaryPath }) =>
    Effect.gen(function* () {
      runtimeMock.state.startCalls.push(binaryPath);
      const url = "http://127.0.0.1:4301";
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          runtimeMock.state.closeCalls.push(url);
          if (runtimeMock.state.closeError) {
            throw runtimeMock.state.closeError;
          }
        }),
      );
      return {
        url,
        exitCode: Effect.never,
      };
    }),
  connectToOpenCodeServer: ({ serverUrl }) =>
    Effect.gen(function* () {
      const url = serverUrl ?? "http://127.0.0.1:4301";
      // Always register a finalizer so the closeCalls/closeError probes fire;
      // production attaches none for external servers.
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          runtimeMock.state.closeCalls.push(url);
          if (runtimeMock.state.closeError) {
            throw runtimeMock.state.closeError;
          }
        }),
      );
      return {
        url,
        exitCode: null,
        external: Boolean(serverUrl),
      };
    }),
  runOpenCodeCommand: () => Effect.succeed({ stdout: "", stderr: "", code: 0 }),
  createOpenCodeSdkClient: ({ baseUrl, serverPassword }) =>
    ({
      session: {
        create: async (input: Record<string, unknown>) => {
          runtimeMock.state.sessionCreateUrls.push(baseUrl);
          runtimeMock.state.sessionCreateInputs.push(input);
          runtimeMock.state.authHeaders.push(
            serverPassword ? `Basic ${btoa(`opencode:${serverPassword}`)}` : null,
          );
          return { data: { id: `${baseUrl}/session` } };
        },
        get: async ({ sessionID }: { sessionID: string }) => {
          runtimeMock.state.sessionGetIds.push(sessionID);
          // The real client is `throwOnError: true`: non-2xx rejects rather
          // than resolving, so missing → 404 throw, transient → 500 throw.
          if (runtimeMock.state.transientErrorSessionIds.has(sessionID)) {
            throw new Error("opencode server error", { cause: { status: 500 } });
          }
          if (runtimeMock.state.missingSessionIds.has(sessionID)) {
            throw new Error(`Session not found: ${sessionID}`, {
              cause: { status: 404, body: { name: "NotFoundError" } },
            });
          }
          const directory = runtimeMock.state.sessionDirectoryById.get(sessionID);
          return { data: { id: sessionID, ...(directory ? { directory } : {}) } };
        },
        update: async ({ sessionID, permission }: { sessionID: string; permission: unknown }) => {
          runtimeMock.state.sessionUpdateCalls.push({ sessionID, permission });
          return { data: { id: sessionID } };
        },
        fork: async ({ sessionID, directory }: { sessionID: string; directory?: string }) => {
          // Fork clones history into a new session bound to the directory.
          const forkedId = `${sessionID}_fork`;
          runtimeMock.state.forkCalls.push({ sessionID, ...(directory ? { directory } : {}) });
          if (directory) {
            runtimeMock.state.sessionDirectoryById.set(forkedId, directory);
          }
          return { data: { id: forkedId, ...(directory ? { directory } : {}) } };
        },
        abort: async ({ sessionID }: { sessionID: string }) => {
          runtimeMock.state.abortCalls.push(sessionID);
        },
        promptAsync: async (input: unknown) => {
          runtimeMock.state.promptCalls.push(input);
          if (runtimeMock.state.promptAsyncError) {
            throw runtimeMock.state.promptAsyncError;
          }
        },
        messages: async () => ({ data: runtimeMock.state.messages }),
        revert: async ({ sessionID, messageID }: { sessionID: string; messageID?: string }) => {
          runtimeMock.state.revertCalls.push({
            sessionID,
            ...(messageID ? { messageID } : {}),
          });
          if (!messageID) {
            runtimeMock.state.messages = [];
            return;
          }

          const targetIndex = runtimeMock.state.messages.findIndex(
            (entry) => entry.info.id === messageID,
          );
          runtimeMock.state.messages =
            targetIndex >= 0
              ? runtimeMock.state.messages.slice(0, targetIndex + 1)
              : runtimeMock.state.messages;
        },
      },
      event: {
        subscribe: async () => ({
          stream: (async function* () {
            if (runtimeMock.state.subscribedEventsReady) {
              await runtimeMock.state.subscribedEventsReady;
            }
            for (const event of runtimeMock.state.subscribedEvents) {
              yield event;
            }
          })(),
        }),
      },
    }) as unknown as ReturnType<OpenCodeRuntimeShape["createOpenCodeSdkClient"]>,
  loadOpenCodeInventory: () =>
    Effect.fail(
      new OpenCodeRuntimeError({
        operation: "loadOpenCodeInventory",
        detail: "OpenCodeRuntimeTestDouble.loadOpenCodeInventory not used in this test",
        cause: null,
      }),
    ),
  loadInventoryFromCli: () =>
    Effect.fail(
      new OpenCodeRuntimeError({
        operation: "loadInventoryFromCli",
        detail: "OpenCodeRuntimeTestDouble.loadInventoryFromCli not used in this test",
        cause: null,
      }),
    ),
};

const providerSessionDirectoryTestLayer = Layer.succeed(ProviderSessionDirectory, {
  upsert: () => Effect.void,
  touchLastSeen: () => Effect.void,
  getProvider: () =>
    Effect.die(new Error("ProviderSessionDirectory.getProvider is not used in test")),
  getBinding: () => Effect.succeed(Option.none()),
  listThreadIds: () => Effect.succeed([]),
  listBindings: () => Effect.succeed([]),
});

// The adapter now receives its settings as a plain argument (the old design
// read from `ServerSettingsService` internally). The test-only
// `ServerSettingsService` below is still kept because other dependencies in
// the layer graph reach for it — but the routing values the assertions
// probe (serverUrl, serverPassword) must be threaded directly through the
// decoded `OpenCodeSettings`.
const openCodeAdapterTestSettings = Schema.decodeSync(OpenCodeSettings)({
  binaryPath: "fake-opencode",
  serverUrl: "http://127.0.0.1:9999",
  serverPassword: "secret-password",
});

const makeOpenCodeAdapterTestLayer = (options: OpenCodeAdapterLiveOptions) =>
  Layer.effect(OpenCodeAdapter, makeOpenCodeAdapter(openCodeAdapterTestSettings, options)).pipe(
    Layer.provideMerge(Layer.succeed(OpenCodeRuntime, OpenCodeRuntimeTestDouble)),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(providerSessionDirectoryTestLayer),
    Layer.provideMerge(NodeServices.layer),
  );

const makeRecordingAdapterTestLayer = (
  instanceId = ProviderInstanceId.make("opencode"),
): {
  readonly layer: ReturnType<typeof makeOpenCodeAdapterTestLayer>;
  readonly recordedLimits: Array<ProviderAccountLimit>;
} => {
  const recordedLimits: Array<ProviderAccountLimit> = [];
  return {
    recordedLimits,
    layer: makeOpenCodeAdapterTestLayer({
      instanceId,
      recordAccountLimit: (limit) =>
        Effect.sync(() => {
          recordedLimits.push(limit);
        }),
    }),
  };
};

const holdSubscribedEvents = (): (() => void) => {
  let release = () => {};
  runtimeMock.state.subscribedEventsReady = new Promise<void>((resolve) => {
    release = resolve;
  });
  return release;
};

const OpenCodeAdapterTestLayer = makeOpenCodeAdapterTestLayer({});

beforeEach(() => {
  runtimeMock.reset();
});

const advanceTestClock = (ms: number) =>
  TestClock.adjust(`${ms} millis`).pipe(Effect.andThen(Effect.yieldNow));

type OpenCodeMessageError = NonNullable<AssistantMessage["error"]>;

const captureMessageUpdatedError = Effect.fn("captureMessageUpdatedError")(function* (input: {
  readonly error: OpenCodeMessageError;
  readonly threadId: ThreadId;
}) {
  runtimeMock.state.subscribedEvents = [
    {
      type: "message.updated",
      properties: {
        sessionID: "http://127.0.0.1:9999/session",
        info: {
          id: "msg-account-limit",
          sessionID: "http://127.0.0.1:9999/session",
          role: "assistant",
          error: input.error,
        },
      },
    },
    {
      type: "session.updated",
      properties: {
        info: {
          id: "http://127.0.0.1:9999/session",
          title: "Account limit sentinel",
        },
      },
    },
  ];
  const adapter = yield* OpenCodeAdapter;
  const firstTargetEventFiber = yield* adapter.streamEvents.pipe(
    Stream.filter(
      (event) =>
        event.threadId === input.threadId &&
        (event.type === "runtime.error" || event.type === "thread.metadata.updated"),
    ),
    Stream.take(1),
    Stream.runCollect,
    Effect.forkChild,
  );
  yield* adapter.startSession({
    provider: ProviderDriverKind.make("opencode"),
    threadId: input.threadId,
    runtimeMode: "full-access",
  });
  return Array.from(yield* Fiber.join(firstTargetEventFiber).pipe(Effect.timeout("1 second")))[0];
});

const captureSessionError = Effect.fn("captureSessionError")(function* (input: {
  readonly error: OpenCodeMessageError;
  readonly instanceId: ProviderInstanceId;
  readonly threadId: ThreadId;
}) {
  const releaseEvents = holdSubscribedEvents();
  runtimeMock.state.subscribedEvents = [
    {
      type: "session.error",
      properties: {
        sessionID: "http://127.0.0.1:9999/session",
        error: input.error,
      },
    },
  ];
  const adapter = yield* OpenCodeAdapter;
  const errorEventsFiber = yield* adapter.streamEvents.pipe(
    Stream.filter(
      (event) =>
        event.threadId === input.threadId &&
        (event.type === "turn.completed" || event.type === "runtime.error"),
    ),
    Stream.take(2),
    Stream.runCollect,
    Effect.forkChild,
  );
  yield* adapter.startSession({
    provider: ProviderDriverKind.make("opencode"),
    threadId: input.threadId,
    runtimeMode: "full-access",
  });
  yield* adapter.sendTurn({
    threadId: input.threadId,
    input: "Continue",
    modelSelection: { instanceId: input.instanceId, model: "openai/gpt-5" },
  });
  releaseEvents();
  return {
    errorEvents: Array.from(yield* Fiber.join(errorEventsFiber).pipe(Effect.timeout("1 second"))),
    sessions: yield* adapter.listSessions(),
  };
});

const assertSessionErrorEvents = (
  events: ReadonlyArray<{ readonly type: string; readonly payload: unknown }>,
  message: string,
  error: OpenCodeMessageError,
): void => {
  NodeAssert.deepEqual(
    events.map((event) => [event.type, event.payload]),
    [
      ["turn.completed", { state: "failed", errorMessage: message }],
      ["runtime.error", { message, class: "provider_error", detail: error }],
    ],
  );
};

it.layer(OpenCodeAdapterTestLayer)("OpenCodeAdapterLive", (it) => {
  it.effect("reuses a configured OpenCode server URL instead of spawning a local server", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;

      const session = yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId: asThreadId("thread-opencode"),
        runtimeMode: "full-access",
      });

      NodeAssert.equal(session.provider, "opencode");
      NodeAssert.equal(session.threadId, "thread-opencode");
      NodeAssert.deepEqual(runtimeMock.state.startCalls, []);
      NodeAssert.deepEqual(runtimeMock.state.sessionCreateUrls, ["http://127.0.0.1:9999"]);
      NodeAssert.deepEqual(runtimeMock.state.authHeaders, [
        `Basic ${btoa("opencode:secret-password")}`,
      ]);
    }),
  );

  it.effect("returns a durable resume cursor for a freshly created session", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-cursor");

      const session = yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });

      // Without a persisted cursor, a session is created and its id is
      // surfaced as a resume cursor so the upper layer can persist it.
      NodeAssert.deepEqual(runtimeMock.state.sessionGetIds, []);
      NodeAssert.deepEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: "http://127.0.0.1:9999/session",
      });
      // Nothing was asked to continue, so this is a plain new session.
      NodeAssert.equal(session.sessionOrigin, "started");

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("resumes the persisted OpenCode session instead of creating a new one", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-resume");

      const session = yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
        resumeCursor: { schemaVersion: 1, sessionId: "ses_persisted" },
      });

      // The adapter validates the persisted id with session.get and re-adopts
      // it — no new session is minted (issue #3604).
      NodeAssert.deepEqual(runtimeMock.state.sessionGetIds, ["ses_persisted"]);
      NodeAssert.deepEqual(runtimeMock.state.sessionCreateUrls, []);
      NodeAssert.deepEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: "ses_persisted",
      });
      NodeAssert.equal(session.sessionOrigin, "resumed");
      // Resume re-asserts the permission ruleset for the current runtimeMode.
      NodeAssert.equal(runtimeMock.state.sessionUpdateCalls.length, 1);
      NodeAssert.equal(runtimeMock.state.sessionUpdateCalls[0]?.sessionID, "ses_persisted");
      NodeAssert.equal(runtimeMock.state.sessionUpdateCalls[0]?.permission != null, true);

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("sends follow-up turns to the resumed session id", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-resume-turn");

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
        resumeCursor: { schemaVersion: 1, sessionId: "ses_persisted" },
      });

      const result = yield* adapter.sendTurn({
        threadId,
        input: "continue where we left off",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "anthropic/sonnet",
        ),
      });

      // The prompt targets the resumed id, and the turn re-surfaces the cursor.
      NodeAssert.deepEqual(
        (runtimeMock.state.promptCalls[0] as { sessionID: string }).sessionID,
        "ses_persisted",
      );
      NodeAssert.deepEqual(result.resumeCursor, {
        schemaVersion: 1,
        sessionId: "ses_persisted",
      });

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("falls back to a fresh session when the persisted session is gone", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-stale");
      runtimeMock.state.missingSessionIds.add("ses_stale");

      const session = yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
        resumeCursor: { schemaVersion: 1, sessionId: "ses_stale" },
      });

      // get probed the stale id, found nothing, then created a new session and
      // emitted a fresh cursor rather than wedging the thread.
      NodeAssert.deepEqual(runtimeMock.state.sessionGetIds, ["ses_stale"]);
      NodeAssert.deepEqual(runtimeMock.state.sessionCreateUrls, ["http://127.0.0.1:9999"]);
      NodeAssert.deepEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: "http://127.0.0.1:9999/session",
      });
      // The fallback stays, but it now says the conversation was lost.
      NodeAssert.equal(session.sessionOrigin, "started-fresh");

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("ignores a malformed or wrong-version resume cursor", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-badcursor");

      const session = yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
        resumeCursor: { schemaVersion: 99, sessionId: "ses_persisted" },
      });

      // A foreign/stale-shaped cursor is treated as "no resume": never probed,
      // a fresh session is created.
      NodeAssert.deepEqual(runtimeMock.state.sessionGetIds, []);
      NodeAssert.deepEqual(runtimeMock.state.sessionCreateUrls, ["http://127.0.0.1:9999"]);
      NodeAssert.deepEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: "http://127.0.0.1:9999/session",
      });

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("surfaces a non-not-found resume probe error instead of silently starting fresh", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-transient");
      // session.get returns a 500 (not a 404) for this id.
      runtimeMock.state.transientErrorSessionIds.add("ses_transient");

      const exit = yield* Effect.exit(
        adapter.startSession({
          provider: ProviderDriverKind.make("opencode"),
          threadId,
          runtimeMode: "full-access",
          resumeCursor: { schemaVersion: 1, sessionId: "ses_transient" },
        }),
      );

      // A transient/transport/auth failure must propagate — NOT be masked as a
      // brand-new empty session (the #3604 class of silent context loss).
      NodeAssert.equal(Exit.isFailure(exit), true);
      NodeAssert.deepEqual(runtimeMock.state.sessionGetIds, ["ses_transient"]);
      NodeAssert.deepEqual(runtimeMock.state.sessionCreateUrls, []);
    }),
  );

  it.effect("re-applies the current runtimeMode permissions when resuming", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-perms");

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        // A different runtimeMode than the original create — resume must not
        // leave the upstream session on stale permissions.
        runtimeMode: "approval-required",
        threadId,
        resumeCursor: { schemaVersion: 1, sessionId: "ses_perms" },
      });

      NodeAssert.deepEqual(runtimeMock.state.sessionGetIds, ["ses_perms"]);
      NodeAssert.deepEqual(runtimeMock.state.sessionCreateUrls, []);
      NodeAssert.equal(runtimeMock.state.sessionUpdateCalls.length, 1);
      NodeAssert.equal(runtimeMock.state.sessionUpdateCalls[0]?.sessionID, "ses_perms");
      NodeAssert.equal(runtimeMock.state.sessionUpdateCalls[0]?.permission != null, true);

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect(
    "forks the resumed session into the requested directory instead of losing context",
    () =>
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const threadId = asThreadId("thread-opencode-cwd");
        // The persisted session still exists but was created in another working dir
        // (e.g. the thread moved from the project root into a git worktree).
        runtimeMock.state.sessionDirectoryById.set("ses_otherdir", "/some/other/worktree");

        const session = yield* adapter.startSession({
          provider: ProviderDriverKind.make("opencode"),
          threadId,
          runtimeMode: "full-access",
          resumeCursor: { schemaVersion: 1, sessionId: "ses_otherdir" },
        });

        // A cwd change must not mint an empty session: the adapter forks the
        // persisted session into the requested cwd, carrying history forward.
        NodeAssert.deepEqual(runtimeMock.state.sessionGetIds, ["ses_otherdir"]);
        NodeAssert.deepEqual(runtimeMock.state.sessionCreateUrls, []);
        NodeAssert.equal(runtimeMock.state.forkCalls.length, 1);
        NodeAssert.equal(runtimeMock.state.forkCalls[0]?.sessionID, "ses_otherdir");
        NodeAssert.equal(typeof runtimeMock.state.forkCalls[0]?.directory, "string");
        // Permission ruleset re-asserted on the fork for the current runtimeMode.
        NodeAssert.equal(runtimeMock.state.sessionUpdateCalls.length, 1);
        NodeAssert.equal(runtimeMock.state.sessionUpdateCalls[0]?.sessionID, "ses_otherdir_fork");
        // Durable cursor now points at the history-complete fork in the new directory.
        NodeAssert.deepEqual(session.resumeCursor, {
          schemaVersion: 1,
          sessionId: "ses_otherdir_fork",
        });
        // History carried over, but under a new id: a fork, not a resume.
        NodeAssert.equal(session.sessionOrigin, "forked");

        yield* adapter.stopSession(threadId);
      }),
  );

  it.effect("reuses the resumed session when the stored directory differs only lexically", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-samedir");
      // Same working tree, different spelling (trailing slash) — must reuse,
      // not fork.
      runtimeMock.state.sessionDirectoryById.set("ses_samedir", `${process.cwd()}/`);

      const session = yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
        resumeCursor: { schemaVersion: 1, sessionId: "ses_samedir" },
      });

      NodeAssert.deepEqual(runtimeMock.state.sessionGetIds, ["ses_samedir"]);
      NodeAssert.deepEqual(runtimeMock.state.sessionCreateUrls, []);
      NodeAssert.deepEqual(runtimeMock.state.forkCalls, []);
      NodeAssert.deepEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: "ses_samedir",
      });
      NodeAssert.equal(session.sessionOrigin, "resumed");

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("fails sendTurn for missing sessions through the typed error channel", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const result = yield* adapter
        .sendTurn({
          threadId: asThreadId("thread-opencode-missing-send"),
          input: "hello",
          attachments: [],
        })
        .pipe(Effect.result);

      NodeAssert.equal(result._tag, "Failure");
      NodeAssert.equal(result.failure._tag, "ProviderAdapterSessionNotFoundError");
      NodeAssert.equal(result.failure.provider, "opencode");
      NodeAssert.equal(result.failure.threadId, "thread-opencode-missing-send");
    }),
  );

  it.effect("fails stopSession for missing sessions through the typed error channel", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const result = yield* adapter
        .stopSession(asThreadId("thread-opencode-missing-stop"))
        .pipe(Effect.result);

      NodeAssert.equal(result._tag, "Failure");
      NodeAssert.equal(result.failure._tag, "ProviderAdapterSessionNotFoundError");
      NodeAssert.equal(result.failure.provider, "opencode");
      NodeAssert.equal(result.failure.threadId, "thread-opencode-missing-stop");
    }),
  );

  it.effect("stops a configured-server session without trying to own server lifecycle", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId: asThreadId("thread-opencode"),
        runtimeMode: "full-access",
      });

      yield* adapter.stopSession(asThreadId("thread-opencode"));

      NodeAssert.deepEqual(runtimeMock.state.startCalls, []);
      NodeAssert.deepEqual(
        runtimeMock.state.abortCalls.includes("http://127.0.0.1:9999/session"),
        true,
      );
    }),
  );

  it.effect("emits one session.exited event when stopping a session", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-stop-event");
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.take(3),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      yield* adapter.stopSession(threadId);

      const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("1 second")));
      NodeAssert.deepEqual(
        events.map((event) => event.type),
        ["session.started", "thread.started", "session.exited"],
      );
    }),
  );

  it.effect("records assistant message limits without adding runtime errors", () => {
    const instanceId = ProviderInstanceId.make("opencode_work");
    const detectedAt = "2026-08-14T10:00:00.000Z";
    const cases: ReadonlyArray<{
      readonly error: OpenCodeMessageError;
      readonly expectedLimit: ProviderAccountLimit | null;
      readonly name: string;
    }> = [
      {
        name: "api-429",
        error: {
          name: "APIError",
          data: {
            message: "OpenCode usage limit reached.",
            statusCode: 429,
            isRetryable: true,
            responseHeaders: { "retry-after": "300" },
          },
        },
        expectedLimit: {
          providerInstanceId: instanceId,
          driver: ProviderDriverKind.make("opencode"),
          kind: "usage-limit",
          detectedAt,
          resetsAt: "2026-08-14T10:05:00.000Z",
          resetsAtEstimated: true,
          source: "opencode.api_error",
          detail: "OpenCode usage limit reached.",
        },
      },
      {
        name: "provider-auth",
        error: {
          name: "ProviderAuthError",
          data: { providerID: "anthropic", message: "OpenCode login expired." },
        },
        expectedLimit: {
          providerInstanceId: instanceId,
          driver: ProviderDriverKind.make("opencode"),
          kind: "auth",
          detectedAt,
          resetsAt: null,
          resetsAtEstimated: false,
          source: "opencode.api_error",
          detail: "OpenCode login expired.",
        },
      },
      {
        name: "message-aborted",
        error: {
          name: "MessageAbortedError",
          data: { message: "OpenCode request was aborted." },
        },
        expectedLimit: null,
      },
    ];

    return Effect.forEach(
      cases,
      (testCase) => {
        runtimeMock.reset();
        const { layer, recordedLimits } = makeRecordingAdapterTestLayer(instanceId);
        return Effect.gen(function* () {
          yield* TestClock.setTime(Date.parse(detectedAt));
          const firstTargetEvent = yield* captureMessageUpdatedError({
            threadId: asThreadId(`thread-message-${testCase.name}`),
            error: testCase.error,
          });

          NodeAssert.deepEqual(
            recordedLimits,
            testCase.expectedLimit ? [testCase.expectedLimit] : [],
          );
          NodeAssert.equal(firstTargetEvent?.type, "thread.metadata.updated");
          if (firstTargetEvent?.type === "thread.metadata.updated") {
            NodeAssert.equal(firstTargetEvent.payload.name, "Account limit sentinel");
          }
        }).pipe(Effect.provide(layer));
      },
      { discard: true },
    );
  });

  it.effect("records session API 429 limits and preserves turn failure text", () => {
    const instanceId = ProviderInstanceId.make("opencode_work");
    const { layer, recordedLimits } = makeRecordingAdapterTestLayer(instanceId);
    const error = {
      name: "APIError",
      data: {
        message: "OpenCode usage limit reached.",
        statusCode: 429,
        isRetryable: true,
        responseHeaders: { "retry-after": "300" },
      },
    } as const;
    return Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-08-14T10:00:00.000Z"));
      const { errorEvents, sessions } = yield* captureSessionError({
        error,
        instanceId,
        threadId: asThreadId("thread-session-api-limit"),
      });
      NodeAssert.deepEqual(recordedLimits, [
        {
          providerInstanceId: instanceId,
          driver: ProviderDriverKind.make("opencode"),
          kind: "usage-limit",
          detectedAt: "2026-08-14T10:00:00.000Z",
          resetsAt: "2026-08-14T10:05:00.000Z",
          resetsAtEstimated: true,
          source: "opencode.api_error",
          detail: "OpenCode usage limit reached.",
        },
      ]);
      assertSessionErrorEvents(errorEvents, "OpenCode usage limit reached.", error);
      NodeAssert.equal(sessions[0]?.lastError, "OpenCode usage limit reached.");
    }).pipe(Effect.provide(layer));
  });

  it.effect("ignores aborted session errors as limits and preserves their text", () => {
    const { layer, recordedLimits } = makeRecordingAdapterTestLayer();
    const error = {
      name: "MessageAbortedError",
      data: { message: "OpenCode request was aborted." },
    } as const;
    return Effect.gen(function* () {
      const { errorEvents, sessions } = yield* captureSessionError({
        error,
        instanceId: ProviderInstanceId.make("opencode"),
        threadId: asThreadId("thread-session-aborted"),
      });
      NodeAssert.deepEqual(recordedLimits, []);
      assertSessionErrorEvents(errorEvents, "OpenCode request was aborted.", error);
      NodeAssert.equal(sessions[0]?.lastError, "OpenCode request was aborted.");
    }).pipe(Effect.provide(layer));
  });

  it.effect("records session auth limits and preserves turn failure text", () => {
    const instanceId = ProviderInstanceId.make("opencode_work");
    const { layer, recordedLimits } = makeRecordingAdapterTestLayer(instanceId);
    const error = {
      name: "ProviderAuthError",
      data: { providerID: "anthropic", message: "OpenCode login expired." },
    } as const;
    return Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-08-14T10:00:00.000Z"));
      const { errorEvents, sessions } = yield* captureSessionError({
        error,
        instanceId,
        threadId: asThreadId("thread-session-auth-limit"),
      });

      NodeAssert.deepEqual(recordedLimits, [
        {
          providerInstanceId: instanceId,
          driver: ProviderDriverKind.make("opencode"),
          kind: "auth",
          detectedAt: "2026-08-14T10:00:00.000Z",
          resetsAt: null,
          resetsAtEstimated: false,
          source: "opencode.api_error",
          detail: "OpenCode login expired.",
        },
      ]);
      assertSessionErrorEvents(errorEvents, "OpenCode login expired.", error);
      NodeAssert.equal(sessions[0]?.lastError, "OpenCode login expired.");
    }).pipe(Effect.provide(layer));
  });

  it.effect("keeps the event pump alive after an account-limit write fails", () => {
    let recordAttempts = 0;
    const error = {
      name: "ProviderAuthError",
      data: { providerID: "anthropic", message: "OpenCode authentication failed." },
    } as const;
    runtimeMock.state.subscribedEvents = [
      {
        type: "session.error",
        properties: {
          sessionID: "http://127.0.0.1:9999/session",
          error,
        },
      },
      {
        type: "session.updated",
        properties: {
          info: {
            id: "http://127.0.0.1:9999/session",
            title: "Pump remained active",
          },
        },
      },
    ];
    const adapterLayer = makeOpenCodeAdapterTestLayer({
      recordAccountLimit: () => {
        recordAttempts += 1;
        return Effect.fail(
          new PersistenceSqlError({
            operation: "provider_account_limits.recordLimit",
            detail: "test write failed",
          }),
        );
      },
    });

    return Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-limit-write-failure");
      const observedFiber = yield* adapter.streamEvents.pipe(
        Stream.filter(
          (event) =>
            event.threadId === threadId &&
            (event.type === "runtime.error" || event.type === "thread.metadata.updated"),
        ),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });

      const observed = Array.from(
        yield* Fiber.join(observedFiber).pipe(Effect.timeout("1 second")),
      );
      NodeAssert.equal(recordAttempts, 1);
      NodeAssert.deepEqual(
        observed.map((event) => event.type),
        ["runtime.error", "thread.metadata.updated"],
      );
      const runtimeError = observed[0];
      NodeAssert.equal(runtimeError?.type, "runtime.error");
      if (runtimeError?.type === "runtime.error") {
        NodeAssert.deepEqual(runtimeError.payload, {
          message: "OpenCode authentication failed.",
          class: "provider_error",
          detail: error,
        });
      }
      const metadata = observed[1];
      NodeAssert.equal(metadata?.type, "thread.metadata.updated");
      if (metadata?.type === "thread.metadata.updated") {
        NodeAssert.equal(metadata.payload.name, "Pump remained active");
      }
    }).pipe(Effect.provide(adapterLayer));
  });

  it.effect("clears session state even when cleanup finalizers throw", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId: asThreadId("thread-stop-all-a"),
        runtimeMode: "full-access",
      });
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId: asThreadId("thread-stop-all-b"),
        runtimeMode: "full-access",
      });

      runtimeMock.state.closeError = new Error("close failed");
      // `stopAll` relies on `stopOpenCodeContext`, which is typed as
      // never-failing. A throwing finalizer surfaces as a defect — `Effect.exit`
      // captures it so the assertions can still run. The key invariant we're
      // validating is "the sessions map and close-call probes reflect cleanup
      // attempts regardless of finalizer outcome".
      yield* Effect.exit(adapter.stopAll());
      const sessions = yield* adapter.listSessions();

      NodeAssert.deepEqual(runtimeMock.state.closeCalls, [
        "http://127.0.0.1:9999",
        "http://127.0.0.1:9999",
      ]);
      NodeAssert.deepEqual(sessions, []);
    }),
  );

  it.effect("completes streamEvents when the adapter scope closes", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make("sequential");
      let scopeClosed = false;

      try {
        const adapterLayer = Layer.effect(
          OpenCodeAdapter,
          makeOpenCodeAdapter(openCodeAdapterTestSettings),
        ).pipe(
          Layer.provideMerge(Layer.succeed(OpenCodeRuntime, OpenCodeRuntimeTestDouble)),
          Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
          Layer.provideMerge(ServerSettingsService.layerTest()),
          Layer.provideMerge(providerSessionDirectoryTestLayer),
          Layer.provideMerge(NodeServices.layer),
        );
        const context = yield* Layer.buildWithScope(adapterLayer, scope);
        const adapter = yield* Effect.service(OpenCodeAdapter).pipe(Effect.provide(context));
        const eventsFiber = yield* adapter.streamEvents.pipe(Stream.runCollect, Effect.forkChild);

        yield* Scope.close(scope, Exit.void);
        scopeClosed = true;

        const exit = yield* Fiber.await(eventsFiber).pipe(Effect.timeout("1 second"));
        NodeAssert.equal(Exit.hasInterrupts(exit), true);
      } finally {
        if (!scopeClosed) {
          yield* Scope.close(scope, Exit.void).pipe(Effect.ignore);
        }
      }
    }),
  );

  it.effect("rolls back session state when sendTurn fails before OpenCode accepts the prompt", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId: asThreadId("thread-send-turn-failure"),
        runtimeMode: "full-access",
      });

      runtimeMock.state.promptAsyncError = new Error("prompt failed");
      const error = yield* adapter
        .sendTurn({
          threadId: asThreadId("thread-send-turn-failure"),
          input: "Fix it",
          modelSelection: {
            instanceId: ProviderInstanceId.make("opencode"),
            model: "openai/gpt-5",
          },
        })
        .pipe(Effect.flip);
      const sessions = yield* adapter.listSessions();

      NodeAssert.equal(error._tag, "ProviderAdapterRequestError");
      if (error._tag !== "ProviderAdapterRequestError") {
        throw new Error("Unexpected error type");
      }
      NodeAssert.equal(error.detail, "prompt failed");
      NodeAssert.equal(
        error.message,
        "Provider adapter request failed (opencode) for session.promptAsync: prompt failed",
      );
      NodeAssert.equal(sessions.length, 1);
      NodeAssert.equal(sessions[0]?.status, "ready");
      NodeAssert.equal(sessions[0]?.activeTurnId, undefined);
      NodeAssert.equal(sessions[0]?.lastError, "prompt failed");
    }),
  );

  it.effect("steers a running turn instead of opening a new one on mid-turn sendTurn", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-steer");
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });

      const turn = yield* adapter.sendTurn({
        threadId,
        input: "run 5 commands",
        modelSelection: {
          instanceId: ProviderInstanceId.make("opencode"),
          model: "openai/gpt-5",
        },
      });

      // Steer: OpenCode queues the prompt into the busy session, so the
      // active turn id is reused instead of opening a new turn.
      const steeredTurn = yield* adapter.sendTurn({
        threadId,
        input: "actually run 15",
        modelSelection: {
          instanceId: ProviderInstanceId.make("opencode"),
          model: "openai/gpt-5",
        },
      });
      NodeAssert.equal(String(steeredTurn.turnId), String(turn.turnId));
      NodeAssert.equal(steeredTurn.steeredIntoActiveTurn, true);

      const sessions = yield* adapter.listSessions();
      const session = sessions.find((entry) => entry.threadId === threadId);
      NodeAssert.equal(session?.status, "running");
      NodeAssert.equal(String(session?.activeTurnId), String(turn.turnId));
      NodeAssert.equal(runtimeMock.state.promptCalls.length, 2);
    }),
  );

  it.effect("keeps the running turn when a steer prompt fails", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-steer-failure");
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });

      const turn = yield* adapter.sendTurn({
        threadId,
        input: "run 5 commands",
        modelSelection: {
          instanceId: ProviderInstanceId.make("opencode"),
          model: "openai/gpt-5",
        },
      });

      runtimeMock.state.promptAsyncError = new Error("steer failed");
      const error = yield* adapter
        .sendTurn({
          threadId,
          input: "actually run 15",
          modelSelection: {
            instanceId: ProviderInstanceId.make("opencode"),
            model: "openai/gpt-5",
          },
        })
        .pipe(Effect.flip);

      // The original turn keeps running — only the steer prompt failed.
      NodeAssert.equal(error._tag, "ProviderAdapterRequestError");
      const sessions = yield* adapter.listSessions();
      const session = sessions.find((entry) => entry.threadId === threadId);
      NodeAssert.equal(session?.status, "running");
      NodeAssert.equal(String(session?.activeTurnId), String(turn.turnId));
    }),
  );

  it.effect("passes agent and variant options for the adapter's bound custom instance id", () => {
    const instanceId = ProviderInstanceId.make("opencode_zen");
    const adapterLayer = Layer.effect(
      OpenCodeAdapter,
      makeOpenCodeAdapter(openCodeAdapterTestSettings, { instanceId }),
    ).pipe(
      Layer.provideMerge(Layer.succeed(OpenCodeRuntime, OpenCodeRuntimeTestDouble)),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(providerSessionDirectoryTestLayer),
      Layer.provideMerge(NodeServices.layer),
    );

    return Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId: asThreadId("thread-custom-instance"),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: asThreadId("thread-custom-instance"),
        input: "Fix it",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode_zen"),
          "anthropic/claude-sonnet-4-5",
          [
            { id: "agent", value: "github-copilot" },
            { id: "variant", value: "high" },
          ],
        ),
      });

      NodeAssert.deepEqual(runtimeMock.state.promptCalls.at(-1), {
        sessionID: "http://127.0.0.1:9999/session",
        model: {
          providerID: "anthropic",
          modelID: "claude-sonnet-4-5",
        },
        agent: "github-copilot",
        variant: "high",
        parts: [{ type: "text", text: "Fix it" }],
      });
    }).pipe(Effect.provide(adapterLayer));
  });

  it.effect("uses the bound custom instance id for fallback sendTurn model selection", () => {
    const instanceId = ProviderInstanceId.make("opencode_zen");
    const adapterLayer = Layer.effect(
      OpenCodeAdapter,
      makeOpenCodeAdapter(openCodeAdapterTestSettings, { instanceId }),
    ).pipe(
      Layer.provideMerge(Layer.succeed(OpenCodeRuntime, OpenCodeRuntimeTestDouble)),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(providerSessionDirectoryTestLayer),
      Layer.provideMerge(NodeServices.layer),
    );

    return Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-custom-instance-fallback-model");
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode_zen"),
          "anthropic/claude-sonnet-4-5",
        ),
      });

      yield* adapter.sendTurn({
        threadId,
        input: "Fix it",
      });

      NodeAssert.deepEqual(runtimeMock.state.promptCalls.at(-1), {
        sessionID: "http://127.0.0.1:9999/session",
        model: {
          providerID: "anthropic",
          modelID: "claude-sonnet-4-5",
        },
        parts: [{ type: "text", text: "Fix it" }],
      });
    }).pipe(Effect.provide(adapterLayer));
  });

  it.effect("rejects sendTurn model selections for another instance id", () => {
    const instanceId = ProviderInstanceId.make("opencode_zen");
    const adapterLayer = Layer.effect(
      OpenCodeAdapter,
      makeOpenCodeAdapter(openCodeAdapterTestSettings, { instanceId }),
    ).pipe(
      Layer.provideMerge(Layer.succeed(OpenCodeRuntime, OpenCodeRuntimeTestDouble)),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(providerSessionDirectoryTestLayer),
      Layer.provideMerge(NodeServices.layer),
    );

    return Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-custom-instance-wrong-selection");
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });

      const error = yield* adapter
        .sendTurn({
          threadId,
          input: "Fix it",
          modelSelection: createModelSelection(
            ProviderInstanceId.make("opencode"),
            "anthropic/claude-sonnet-4-5",
          ),
        })
        .pipe(Effect.flip);

      NodeAssert.equal(error._tag, "ProviderAdapterValidationError");
      if (error._tag !== "ProviderAdapterValidationError") {
        throw new Error("Unexpected error type");
      }
      NodeAssert.equal(
        error.issue,
        "OpenCode model selection is bound to instance 'opencode', expected 'opencode_zen'.",
      );
      NodeAssert.deepEqual(runtimeMock.state.promptCalls, []);
    }).pipe(Effect.provide(adapterLayer));
  });

  it.effect("reverts the full thread when rollback removes every assistant turn", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-rollback-all");
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });

      runtimeMock.state.messages = [
        {
          info: { id: "assistant-1", role: "assistant" },
          parts: [],
        },
        {
          info: { id: "assistant-2", role: "assistant" },
          parts: [],
        },
      ];

      const snapshot = yield* adapter.rollbackThread(threadId, 2);

      NodeAssert.deepEqual(runtimeMock.state.revertCalls, [
        { sessionID: "http://127.0.0.1:9999/session" },
      ]);
      NodeAssert.deepEqual(snapshot.turns, []);
    }),
  );

  it.effect("classifies a confirmed not-found across the shapes the SDK/runtime can produce", () =>
    Effect.sync(() => {
      // The real production shape: runOpenCodeSdk wraps the thrown Error
      // (cause = { body, status }) under OpenCodeRuntimeError.
      const wrappedError = new Error("Session not found: ses_x", {
        cause: { body: { name: "NotFoundError" }, status: 404 },
      });
      NodeAssert.equal(
        isOpenCodeNotFound({
          _tag: "OpenCodeRuntimeError",
          operation: "session.get",
          detail: "Session not found: ses_x",
          cause: wrappedError,
        }),
        true,
      );

      // 404 expressed only via response.status (the bot's flagged shape).
      NodeAssert.equal(isOpenCodeNotFound({ cause: { response: { status: 404 } } }), true);
      // 404 via a bare numeric status / statusCode.
      NodeAssert.equal(isOpenCodeNotFound(new Error("x", { cause: { status: 404 } })), true);
      NodeAssert.equal(isOpenCodeNotFound({ statusCode: 404 }), true);
      // OpenCode NotFoundError body name with no status.
      NodeAssert.equal(isOpenCodeNotFound({ body: { name: "NotFoundError" } }), true);

      // NOT a miss: only structured signals count, never free text. A non-404
      // error whose message/detail merely contains "not found" must propagate,
      // not be misread as a missing session and silently start fresh.
      NodeAssert.equal(
        isOpenCodeNotFound(new Error("upstream provider not found", { cause: { status: 500 } })),
        false,
      );
      NodeAssert.equal(isOpenCodeNotFound({ detail: "status=500 body={...not found...}" }), false);
      // An explicit non-404 status seals its subtree: a 500 whose serialized
      // body echoes a NotFoundError name — or that is itself named
      // *NotFound* — is a real failure, never a miss.
      NodeAssert.equal(isOpenCodeNotFound({ status: 500, body: { name: "NotFoundError" } }), false);
      NodeAssert.equal(isOpenCodeNotFound({ name: "UpstreamNotFoundError", status: 500 }), false);
      // A "NotFound"-flavored name that isn't OpenCode's exact `NotFoundError`
      // is not a confirmed miss even without a sealing status.
      NodeAssert.equal(isOpenCodeNotFound({ name: "UpstreamNotFoundError" }), false);
      NodeAssert.equal(isOpenCodeNotFound({ cause: { name: "ProviderNotFoundError" } }), false);
      NodeAssert.equal(
        isOpenCodeNotFound(
          new Error("x", { cause: { status: 502, body: { name: "NotFoundError" } } }),
        ),
        false,
      );
      // Other transient/auth/network failures must propagate too.
      NodeAssert.equal(isOpenCodeNotFound(new Error("boom", { cause: { status: 500 } })), false);
      NodeAssert.equal(isOpenCodeNotFound({ cause: { response: { status: 401 } } }), false);
      NodeAssert.equal(isOpenCodeNotFound(new Error("network error (no response)")), false);
      NodeAssert.equal(isOpenCodeNotFound(undefined), false);
    }),
  );

  it.effect("treats lexically or physically identical directories as the same", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const sameDirectory = (left: string, right: string) =>
        isSameOpenCodeDirectory(fileSystem, path, left, right);

      // Lexical-only differences (trailing slash, dot segments) short-circuit
      // without touching the filesystem — the paths need not exist.
      NodeAssert.equal(yield* sameDirectory("/repo/project/", "/repo/project"), true);
      NodeAssert.equal(yield* sameDirectory("/repo/nested/../project", "/repo/project"), true);
      // Nonexistent paths degrade to the lexical comparison instead of failing.
      NodeAssert.equal(yield* sameDirectory("/repo/project", "/repo/other"), false);

      // A symlinked cwd (the macOS `/tmp` → `/private/tmp` shape) resolves to
      // the directory it points at, so the two spellings compare equal.
      const base = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-opencode-dir-" });
      const real = path.join(base, "real");
      const link = path.join(base, "link");
      yield* fileSystem.makeDirectory(real);
      yield* fileSystem.symlink(real, link);
      NodeAssert.equal(yield* sameDirectory(link, real), true);
      NodeAssert.equal(yield* sameDirectory(link, path.join(base, "other")), false);
    }).pipe(Effect.scoped),
  );

  it.effect("appends raw assistant text deltas and reconciles part update snapshots", () =>
    Effect.sync(() => {
      const firstUpdate = mergeOpenCodeAssistantText(undefined, "Hello");
      const overlapDelta = appendOpenCodeAssistantTextDelta(firstUpdate.latestText, "lo world");
      const secondUpdate = mergeOpenCodeAssistantText(overlapDelta.nextText, "Hellolo world");

      NodeAssert.deepEqual(
        [firstUpdate.deltaToEmit, overlapDelta.deltaToEmit, secondUpdate.deltaToEmit],
        ["Hello", "lo world", ""],
      );
      NodeAssert.equal(secondUpdate.latestText, "Hellolo world");
    }),
  );

  it.effect("does not strip coincidental prefix overlap from OpenCode part deltas", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-raw-delta");
      const part = {
        id: "part-raw-delta",
        sessionID: "http://127.0.0.1:9999/session",
        messageID: "msg-raw-delta",
        type: "text",
        text: "A B",
        time: { start: 1 },
      };
      runtimeMock.state.subscribedEvents = [
        {
          type: "message.updated",
          properties: {
            sessionID: "http://127.0.0.1:9999/session",
            info: {
              id: "msg-raw-delta",
              role: "assistant",
            },
          },
        },
        {
          type: "message.part.updated",
          properties: {
            sessionID: "http://127.0.0.1:9999/session",
            part,
            time: 1,
          },
        },
        {
          type: "message.part.delta",
          properties: {
            sessionID: "http://127.0.0.1:9999/session",
            messageID: "msg-raw-delta",
            partID: "part-raw-delta",
            field: "text",
            delta: "Bonus",
          },
        },
        {
          type: "message.part.updated",
          properties: {
            sessionID: "http://127.0.0.1:9999/session",
            part: {
              ...part,
              text: "A BBonus",
              time: { start: 1, end: 2 },
            },
            time: 2,
          },
        },
      ];
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.take(5),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });

      const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("1 second")));
      const deltas = events.filter((event) => event.type === "content.delta");
      NodeAssert.deepEqual(
        deltas.map((event) => (event.type === "content.delta" ? event.payload.delta : "")),
        ["A B", "Bonus"],
      );
      NodeAssert.equal(events.at(-1)?.type, "item.completed");
      const completed = events.at(-1);
      if (completed?.type === "item.completed") {
        NodeAssert.equal(completed.payload.detail, "A BBonus");
      }
    }),
  );

  it.effect("emits task.started with description/agent/prompt for a subtask part", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-subtask-started");
      runtimeMock.state.subscribedEvents = [
        {
          type: "message.part.updated",
          properties: {
            sessionID: "http://127.0.0.1:9999/session",
            part: {
              id: "subtask-1",
              sessionID: "http://127.0.0.1:9999/session",
              messageID: "msg-subtask-1",
              type: "subtask",
              prompt: "Survey the repo for entry points",
              description: "Survey subtask",
              agent: "Explore",
            },
            time: 1,
          },
        },
      ];

      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.filter((event) => event.type === "task.started"),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });

      const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("1 second")));
      const started = events[0];
      NodeAssert.equal(started?.type, "task.started");
      if (started?.type === "task.started") {
        NodeAssert.equal(started.payload.taskId, "subtask-1");
        NodeAssert.equal(started.payload.description, "Survey subtask");
        NodeAssert.equal(started.payload.subagentType, "Explore");
        NodeAssert.equal(started.payload.prompt, "Survey the repo for entry points");
      }
    }),
  );

  it.effect(
    "emits task.completed with the subtask's taskId once the corresponding tool part reaches a terminal state",
    () =>
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const threadId = asThreadId("thread-opencode-subtask-completed");
        runtimeMock.state.subscribedEvents = [
          {
            type: "message.part.updated",
            properties: {
              sessionID: "http://127.0.0.1:9999/session",
              part: {
                id: "subtask-2",
                sessionID: "http://127.0.0.1:9999/session",
                messageID: "msg-subtask-2",
                type: "subtask",
                prompt: "Investigate the failing test",
                description: "Investigate subtask",
                agent: "general",
              },
              time: 1,
            },
          },
          {
            type: "message.part.updated",
            properties: {
              sessionID: "http://127.0.0.1:9999/session",
              part: {
                id: "tool-2",
                sessionID: "http://127.0.0.1:9999/session",
                messageID: "msg-subtask-2",
                type: "tool",
                callID: "call-2",
                tool: "task",
                state: {
                  status: "pending",
                  input: {},
                  raw: "",
                },
              },
              time: 2,
            },
          },
          {
            type: "message.part.updated",
            properties: {
              sessionID: "http://127.0.0.1:9999/session",
              part: {
                id: "tool-2",
                sessionID: "http://127.0.0.1:9999/session",
                messageID: "msg-subtask-2",
                type: "tool",
                callID: "call-2",
                tool: "task",
                state: {
                  status: "completed",
                  input: {},
                  output: "Subtask finished successfully.",
                  title: "task",
                  metadata: {},
                  time: { start: 1, end: 2 },
                },
              },
              time: 3,
            },
          },
        ];

        const eventsFiber = yield* adapter.streamEvents.pipe(
          Stream.filter((event) => event.threadId === threadId),
          Stream.filter((event) => event.type === "task.completed"),
          Stream.take(1),
          Stream.runCollect,
          Effect.forkChild,
        );

        yield* adapter.startSession({
          provider: ProviderDriverKind.make("opencode"),
          threadId,
          runtimeMode: "full-access",
        });

        const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("1 second")));
        const completedTask = events[0];
        NodeAssert.equal(completedTask?.type, "task.completed");
        if (completedTask?.type === "task.completed") {
          NodeAssert.equal(completedTask.payload.taskId, "subtask-2");
          NodeAssert.equal(completedTask.payload.status, "completed");
          NodeAssert.equal(completedTask.payload.summary, "Subtask finished successfully.");
        }
      }),
  );

  it.effect("lets OpenCode own session title generation and emits title metadata updates", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-title-sync");
      runtimeMock.state.subscribedEvents = [
        {
          type: "session.updated",
          properties: {
            info: {
              id: "http://127.0.0.1:9999/session",
              title: "Investigate OpenCode title sync",
            },
          },
        },
      ];

      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.take(3),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });

      const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("1 second")));
      NodeAssert.equal(runtimeMock.state.sessionCreateInputs.length, 1);
      NodeAssert.equal("title" in (runtimeMock.state.sessionCreateInputs[0] ?? {}), false);

      const metadataUpdated = events.find((event) => event.type === "thread.metadata.updated");
      NodeAssert.ok(metadataUpdated);
      if (metadataUpdated.type === "thread.metadata.updated") {
        NodeAssert.equal(metadataUpdated.payload.name, "Investigate OpenCode title sync");
      }
    }),
  );

  it.effect("writes provider-native observability records using the session thread id", () =>
    Effect.gen(function* () {
      const nativeEvents: Array<{
        readonly event?: {
          readonly provider?: string;
          readonly threadId?: string;
          readonly providerThreadId?: string;
          readonly type?: string;
        };
      }> = [];
      const nativeThreadIds: Array<string | null> = [];
      runtimeMock.state.subscribedEvents = [
        {
          type: "message.updated",
          properties: {
            info: {
              id: "msg-missing-session",
              role: "assistant",
            },
          },
        },
        {
          type: "message.updated",
          properties: {
            sessionID: "http://127.0.0.1:9999/other-session",
            info: {
              id: "msg-other-session",
              role: "assistant",
            },
          },
        },
        {
          type: "message.updated",
          properties: {
            sessionID: "http://127.0.0.1:9999/session",
            info: {
              id: "msg-native-log",
              role: "assistant",
            },
          },
        },
      ];

      const nativeEventLogger = {
        filePath: "memory://opencode-native-events",
        write: (event: unknown, threadId: ThreadId | null) => {
          nativeEvents.push(event as (typeof nativeEvents)[number]);
          nativeThreadIds.push(threadId ?? null);
          return Effect.void;
        },
        close: () => Effect.void,
      };

      const adapterLayer = Layer.effect(
        OpenCodeAdapter,
        makeOpenCodeAdapter(openCodeAdapterTestSettings, {
          nativeEventLogger,
        }),
      ).pipe(
        Layer.provideMerge(Layer.succeed(OpenCodeRuntime, OpenCodeRuntimeTestDouble)),
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
        Layer.provideMerge(
          ServerSettingsService.layerTest({
            providers: {
              opencode: {
                binaryPath: "fake-opencode",
                serverUrl: "http://127.0.0.1:9999",
                serverPassword: "secret-password",
              },
            },
          }),
        ),
        Layer.provideMerge(providerSessionDirectoryTestLayer),
        Layer.provideMerge(NodeServices.layer),
      );

      const session = yield* Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const started = yield* adapter.startSession({
          provider: ProviderDriverKind.make("opencode"),
          threadId: asThreadId("thread-native-log"),
          runtimeMode: "full-access",
        });
        yield* advanceTestClock(10);
        return started;
      }).pipe(Effect.provide(adapterLayer));

      NodeAssert.equal(session.threadId, "thread-native-log");
      NodeAssert.equal(nativeEvents.length, 1);
      NodeAssert.equal(
        nativeEvents.some((record) => record.event?.provider === "opencode"),
        true,
      );
      NodeAssert.equal(
        nativeEvents.some(
          (record) => record.event?.providerThreadId === "http://127.0.0.1:9999/session",
        ),
        true,
      );
      NodeAssert.equal(
        nativeEvents.some((record) => record.event?.threadId === "thread-native-log"),
        true,
      );
      NodeAssert.equal(
        nativeEvents.some((record) => record.event?.type === "message.updated"),
        true,
      );
      NodeAssert.equal(
        nativeThreadIds.every((threadId) => threadId === "thread-native-log"),
        true,
      );
    }),
  );

  it.effect("keeps the event pump alive when native event logging fails", () =>
    Effect.gen(function* () {
      runtimeMock.state.subscribedEvents = [
        {
          type: "message.updated",
          properties: {
            sessionID: "http://127.0.0.1:9999/session",
            info: {
              id: "msg-native-log-failure",
              role: "assistant",
            },
          },
        },
      ];

      const nativeEventLogger = {
        filePath: "memory://opencode-native-events",
        write: () => Effect.die(new Error("native log write failed")),
        close: () => Effect.void,
      };

      const adapterLayer = Layer.effect(
        OpenCodeAdapter,
        makeOpenCodeAdapter(openCodeAdapterTestSettings, {
          nativeEventLogger,
        }),
      ).pipe(
        Layer.provideMerge(Layer.succeed(OpenCodeRuntime, OpenCodeRuntimeTestDouble)),
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
        Layer.provideMerge(
          ServerSettingsService.layerTest({
            providers: {
              opencode: {
                binaryPath: "fake-opencode",
                serverUrl: "http://127.0.0.1:9999",
                serverPassword: "secret-password",
              },
            },
          }),
        ),
        Layer.provideMerge(providerSessionDirectoryTestLayer),
        Layer.provideMerge(NodeServices.layer),
      );

      // Capture closeCalls *inside* the provided layer scope: the adapter's
      // layer finalizer now tears down any live sessions when the layer
      // closes (which is exactly what we want for leak prevention), so
      // inspecting closeCalls after `Effect.provide` completes would observe
      // the teardown — not the behavior under test. We care that the event
      // pump kept the session alive while logging was failing.
      const { sessions, closeCallsDuringRun } = yield* Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        yield* adapter.startSession({
          provider: ProviderDriverKind.make("opencode"),
          threadId: asThreadId("thread-native-log-failure"),
          runtimeMode: "full-access",
        });
        yield* advanceTestClock(10);
        return {
          sessions: yield* adapter.listSessions(),
          closeCallsDuringRun: [...runtimeMock.state.closeCalls],
        };
      }).pipe(Effect.provide(adapterLayer));

      NodeAssert.equal(sessions.length, 1);
      NodeAssert.equal(sessions[0]?.threadId, "thread-native-log-failure");
      NodeAssert.deepEqual(closeCallsDuringRun, []);
    }),
  );

  describeSessionLifecycleConformance(it, {
    name: "OpenCode",
    provider: ProviderDriverKind.make("opencode"),
    capabilities: OPENCODE_ADAPTER_CAPABILITIES,
    observes: { turnTargets: true, unknownCursor: true },
    runScenario: (body) =>
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        // The fake server answers `session.get` for every id except this one,
        // which stands in for a session the OpenCode server has forgotten.
        runtimeMock.state.missingSessionIds.add("ses_conformance_gone");
        return yield* body({
          adapter,
          makeValidCursor: () => ({ schemaVersion: 1, sessionId: "ses_persisted" }),
          makeForeignCursor: () => ({ schemaVersion: 99, sessionId: "ses_persisted" }),
          readProviderSessionsCreated: () =>
            Effect.sync(() => runtimeMock.state.sessionCreateInputs.length),
          readTurnTargets: () =>
            Effect.sync(() =>
              runtimeMock.state.promptCalls.map(
                (call) => (call as { readonly sessionID: string }).sessionID,
              ),
            ),
          sendTurnInput: {
            modelSelection: createModelSelection(
              ProviderInstanceId.make("opencode"),
              "anthropic/sonnet",
            ),
          },
          resumedProviderSessionId: "ses_persisted",
          unknownCursor: {
            make: () => ({ schemaVersion: 1, sessionId: "ses_conformance_gone" }),
            expect: "fresh-session",
          },
        });
      }),
  });
});
