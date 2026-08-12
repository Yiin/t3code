// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTimersPromises from "node:timers/promises";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ApprovalRequestId,
  PrimeSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { attachmentRelativePath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import type { PrimeAdapterShape } from "../Services/PrimeAdapter.ts";
import { makePrimeAdapter, type PrimeResumeCursor } from "./PrimeAdapter.ts";

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/prime-rpc-mock.ts");
const decodeSettings = Schema.decodeSync(PrimeSettings);
const primeLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-prime-adapter-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

function ids(...values: ReadonlyArray<string>) {
  const pending = [...values];
  return () => Effect.succeed(pending.shift() ?? `generated-${values.length}`);
}

const makeWrapper = Effect.fn("PrimeAdapterTest.makeWrapper")(function* () {
  const dir = yield* Effect.promise(() =>
    NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "prime-adapter-cli-")),
  );
  const path = NodePath.join(dir, "prime-agent");
  yield* Effect.promise(() =>
    NodeFSP.writeFile(
      path,
      `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(mockAgentPath)} "$@"\n`,
      "utf8",
    ),
  );
  yield* Effect.promise(() => NodeFSP.chmod(path, 0o755));
  return path;
});

const makeAdapter = (
  binaryPath: string,
  sessionId: () => Effect.Effect<string>,
  instanceId?: ProviderInstanceId,
) =>
  makePrimeAdapter(decodeSettings({ binaryPath }), {
    environment: { ...process.env, T3_PRIME_RPC_SCENARIO: "adapter" },
    sessionId,
    ...(instanceId ? { instanceId } : {}),
  });

const waitFor = Effect.fn("PrimeAdapterTest.waitFor")(function* (
  condition: () => Effect.Effect<boolean>,
) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (yield* condition()) return;
    yield* Effect.promise(() => NodeTimersPromises.setTimeout(20));
  }
  return yield* Effect.die(new Error("Timed out waiting for fake Prime RPC state."));
});

const waitForSnapshot = (
  adapter: { readThread: PrimeAdapterShape["readThread"] },
  threadId: ThreadId,
) =>
  waitFor(() =>
    adapter.readThread(threadId).pipe(
      Effect.map((snapshot) => (snapshot.turns.at(-1)?.items.length ?? 0) > 0),
      Effect.orElseSucceed(() => false),
    ),
  );

const argvFromSnapshot = (snapshot: {
  turns: ReadonlyArray<{ items: ReadonlyArray<unknown> }>;
}) => {
  const first = snapshot.turns.at(-1)?.items[0];
  return first && typeof first === "object" && "mockArgv" in first
    ? (first.mockArgv as ReadonlyArray<string>)
    : [];
};

const isCommand = (
  value: unknown,
  type: string,
): value is Record<string, unknown> & { readonly type: string } =>
  typeof value === "object" && value !== null && "type" in value && value.type === type;

const promptCommands = (snapshot: { turns: ReadonlyArray<{ items: ReadonlyArray<unknown> }> }) =>
  (snapshot.turns.at(-1)?.items ?? []).filter((item) =>
    isCommand(item, "prompt"),
  ) as ReadonlyArray<{
    readonly message?: string;
    readonly images?: ReadonlyArray<{ type: "image"; data: string; mimeType: string }>;
  }>;

it.layer(primeLayer)("PrimeAdapter", (it) => {
  it.effect("starts, resumes the owner, and forks for a different T3 thread", () =>
    Effect.gen(function* () {
      const binaryPath = yield* makeWrapper();
      const adapter = yield* makeAdapter(
        binaryPath,
        ids(
          "prime-new",
          "generation-1",
          "turn-1",
          "unused-resume",
          "generation-2",
          "turn-2",
          "prime-fork",
          "generation-3",
          "turn-3",
        ),
      );
      const owner = ThreadId.make("prime-owner");
      const other = ThreadId.make("prime-other");
      const first = yield* adapter.startSession({
        threadId: owner,
        provider: ProviderDriverKind.make("primeAgent"),
        providerInstanceId: ProviderInstanceId.make("primeAgent"),
        runtimeMode: "approval-required",
        cwd: process.cwd(),
        modelSelection: {
          instanceId: ProviderInstanceId.make("primeAgent"),
          model: "prime/prime-model",
          options: [{ id: "thinking", value: "high" }],
        },
      });
      assert.deepStrictEqual(first.resumeCursor, {
        schemaVersion: 1,
        sessionId: "prime-new",
        ownerThreadId: owner,
      });
      const serverConfig = yield* ServerConfig;
      const sessionRoot = NodePath.join(serverConfig.stateDir, "prime", "primeAgent");
      assert.equal((yield* Effect.promise(() => NodeFSP.stat(sessionRoot))).mode & 0o777, 0o700);

      yield* adapter.sendTurn({ threadId: owner, input: "first" });
      yield* waitForSnapshot(adapter, owner);
      const firstArgv = argvFromSnapshot(yield* adapter.readThread(owner));
      assert.includeMembers(
        [...firstArgv],
        [
          "--mode",
          "rpc",
          "--session-id",
          "prime-new",
          "--provider",
          "prime",
          "--model",
          "prime-model",
          "--thinking",
          "high",
        ],
      );

      const resumed = yield* adapter.startSession({
        threadId: owner,
        runtimeMode: "approval-required",
        resumeCursor: first.resumeCursor,
      });
      assert.equal((resumed.resumeCursor as PrimeResumeCursor).sessionId, "prime-new");
      yield* adapter.sendTurn({ threadId: owner, input: "resume" });
      yield* waitForSnapshot(adapter, owner);
      assert.includeMembers(
        [...argvFromSnapshot(yield* adapter.readThread(owner))],
        ["--session", "prime-new"],
      );

      const forked = yield* adapter.startSession({
        threadId: other,
        runtimeMode: "full-access",
        resumeCursor: first.resumeCursor,
      });
      assert.deepStrictEqual(forked.resumeCursor, {
        schemaVersion: 1,
        sessionId: "prime-fork",
        ownerThreadId: other,
      });
      yield* adapter.sendTurn({ threadId: other, input: "fork" });
      yield* waitForSnapshot(adapter, other);
      assert.includeMembers(
        [...argvFromSnapshot(yield* adapter.readThread(other))],
        ["--fork", "prime-new", "--session-id", "prime-fork"],
      );
    }),
  );

  it.effect("maps prompt, image, model, permission, interrupt, read, and rollback behavior", () =>
    Effect.gen(function* () {
      const binaryPath = yield* makeWrapper();
      const instanceId = ProviderInstanceId.make("prime-custom");
      const adapter = yield* makeAdapter(
        binaryPath,
        ids("prime-actions", "generation-actions"),
        instanceId,
      );
      const isolatedAdapter = yield* makeAdapter(
        binaryPath,
        ids("prime-isolated", "generation-isolated"),
        ProviderInstanceId.make("prime-isolated"),
      );
      const threadId = ThreadId.make("prime-actions");
      const events: ProviderRuntimeEvent[] = [];
      const isolatedEvents: ProviderRuntimeEvent[] = [];
      const requestOpened = yield* Deferred.make<ApprovalRequestId>();
      const eventFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => events.push(event)).pipe(
          Effect.andThen(
            event.type === "request.opened" && event.requestId !== undefined
              ? Deferred.succeed(requestOpened, ApprovalRequestId.make(event.requestId)).pipe(
                  Effect.ignore,
                )
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);
      const isolatedEventFiber = yield* Stream.runForEach(isolatedAdapter.streamEvents, (event) =>
        Effect.sync(() => isolatedEvents.push(event)),
      ).pipe(Effect.forkChild);
      yield* adapter.startSession({
        threadId,
        providerInstanceId: instanceId,
        runtimeMode: "approval-required",
      });

      const config = yield* ServerConfig;
      const attachment = {
        type: "image" as const,
        id: "prime-actions-12345678-1234-1234-1234-123456789abc",
        name: "pixel.png",
        mimeType: "image/png",
        sizeBytes: 3,
      };
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          NodePath.join(config.attachmentsDir, attachmentRelativePath(attachment)),
          Buffer.from([1, 2, 3]),
        ),
      );
      yield* adapter.sendTurn({
        threadId,
        input: "image",
        attachments: [attachment],
        modelSelection: {
          instanceId,
          model: "prime/switched",
          options: [{ id: "thinking", value: "xhigh" }],
        },
      });
      yield* waitForSnapshot(adapter, threadId);
      yield* waitFor(() =>
        adapter.listSessions().pipe(Effect.map((sessions) => sessions[0]?.status === "ready")),
      );
      assert.equal((yield* adapter.listSessions())[0]?.model, "prime/switched");
      const configuredItems = (yield* adapter.readThread(threadId)).turns.at(-1)?.items ?? [];
      assert.isTrue(
        configuredItems.some(
          (item) =>
            isCommand(item, "set_model") &&
            item.provider === "prime" &&
            item.modelId === "switched",
        ),
      );
      assert.isTrue(
        configuredItems.some(
          (item) => isCommand(item, "set_thinking_level") && item.level === "xhigh",
        ),
      );
      const imagePrompt = configuredItems.find(
        (item) => typeof item === "object" && item !== null && "images" in item,
      ) as
        | { images?: ReadonlyArray<{ type: "image"; data: string; mimeType: string }> }
        | undefined;
      assert.deepStrictEqual(imagePrompt?.images, [
        { type: "image", data: "AQID", mimeType: "image/png" },
      ]);

      yield* adapter.sendTurn({ threadId, input: "permission" });
      const requestId = yield* Deferred.await(requestOpened);
      yield* adapter.respondToRequest(threadId, requestId, "acceptForSession");
      yield* waitFor(() =>
        Effect.sync(() => events.some((event) => event.type === "request.resolved")),
      );
      yield* waitFor(() =>
        adapter.listSessions().pipe(Effect.map((sessions) => sessions[0]?.status === "ready")),
      );
      assert.isTrue(events.some((event) => event.type === "content.delta"));
      assert.isTrue(events.some((event) => event.type === "request.resolved"));
      assert.isTrue(events.every((event) => event.providerInstanceId === instanceId));
      assert.deepStrictEqual(isolatedEvents, []);
      let commands = (yield* adapter.readThread(threadId)).turns.at(-1)?.items ?? [];
      assert.isTrue(
        commands.some(
          (command) =>
            isCommand(command, "extension_ui_response") &&
            command.id === "permission-1" &&
            command.value === "Allow for session",
        ),
      );

      const openedBeforeInterrupt = events.filter(
        (event) => event.type === "request.opened",
      ).length;
      yield* adapter.sendTurn({ threadId, input: "permission" });
      yield* waitFor(() =>
        Effect.sync(
          () =>
            events.filter((event) => event.type === "request.opened").length >
            openedBeforeInterrupt,
        ),
      );
      yield* adapter.sendTurn({ threadId, input: "steer this" });
      yield* adapter.sendTurn({ threadId, input: "follow this" });
      commands = (yield* adapter.readThread(threadId)).turns.at(-1)?.items ?? [];
      assert.isTrue(commands.some((command) => isCommand(command, "steer")));
      assert.isTrue(commands.some((command) => isCommand(command, "follow_up")));
      yield* adapter.interruptTurn(threadId);
      yield* waitFor(() =>
        adapter.listSessions().pipe(Effect.map((sessions) => sessions[0]?.status === "ready")),
      );
      assert.isTrue(
        events.some(
          (event) => event.type === "request.resolved" && event.payload.decision === "cancel",
        ),
      );

      const snapshot = yield* adapter.readThread(threadId);
      assert.isAtLeast(snapshot.turns.length, 2);
      const rolledBack = yield* adapter.rollbackThread(threadId, 1);
      assert.equal(rolledBack.turns.length, snapshot.turns.length - 1);
      assert.equal(
        (rolledBack.resumeCursor as PrimeResumeCursor).sessionId,
        "prime-actions-forked",
      );
      const rollbackCommands = (yield* adapter.readThread(threadId)).turns.at(-1)?.items ?? [];
      assert.isTrue(
        rollbackCommands.some(
          (command) => isCommand(command, "fork") && command.entryId === "entry-1",
        ),
      );
      const wrongTurn = yield* adapter
        .interruptTurn(threadId, TurnId.make("not-active"))
        .pipe(Effect.flip);
      assert.equal(wrongTurn._tag, "ProviderAdapterValidationError");
      const invalidReplacement = yield* adapter
        .startSession({
          threadId,
          runtimeMode: "full-access",
          modelSelection: {
            instanceId: ProviderInstanceId.make("wrong-instance"),
            model: "prime/wrong",
            options: [],
          },
        })
        .pipe(Effect.flip);
      assert.equal(invalidReplacement._tag, "ProviderAdapterValidationError");
      assert.isTrue(yield* adapter.hasSession(threadId));
      yield* adapter.stopSession(threadId);
      assert.isFalse(yield* adapter.hasSession(threadId));
      yield* Fiber.interrupt(eventFiber);
      yield* Fiber.interrupt(isolatedEventFiber);
    }),
  );

  it.effect("sends an image as image input and a file as a prompt path reference", () =>
    Effect.gen(function* () {
      const binaryPath = yield* makeWrapper();
      const instanceId = ProviderInstanceId.make("prime-attachments");
      const adapter = yield* makeAdapter(
        binaryPath,
        ids("prime-attachments", "generation-attachments"),
        instanceId,
      );
      const threadId = ThreadId.make("prime-attachments");
      yield* adapter.startSession({
        threadId,
        providerInstanceId: instanceId,
        runtimeMode: "full-access",
      });

      const config = yield* ServerConfig;
      const image = {
        type: "image" as const,
        id: "prime-attachments-11111111-1111-1111-1111-111111111111",
        name: "pixel.png",
        mimeType: "image/png",
        sizeBytes: 3,
      };
      const file = {
        type: "file" as const,
        id: "prime-attachments-22222222-2222-2222-2222-222222222222",
        name: "notes.txt",
        mimeType: "text/plain",
        sizeBytes: 5,
      };
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          NodePath.join(config.attachmentsDir, attachmentRelativePath(image)),
          Buffer.from([1, 2, 3]),
        ),
      );
      const filePath = NodePath.join(config.attachmentsDir, attachmentRelativePath(file));
      yield* Effect.promise(() => NodeFSP.writeFile(filePath, "hello", "utf8"));

      yield* adapter.sendTurn({ threadId, input: "look", attachments: [image, file] });
      yield* waitForSnapshot(adapter, threadId);
      const mixed = promptCommands(yield* adapter.readThread(threadId)).at(-1);
      assert.deepStrictEqual(mixed?.images, [
        { type: "image", data: "AQID", mimeType: "image/png" },
      ]);
      assert.include(mixed?.message ?? "", "look");
      assert.include(mixed?.message ?? "", filePath);
      assert.include(mixed?.message ?? "", "notes.txt");
      // The file must never travel as image bytes.
      assert.isTrue((mixed?.images ?? []).every((image) => image.mimeType.startsWith("image/")));

      yield* waitFor(() =>
        adapter.listSessions().pipe(Effect.map((sessions) => sessions[0]?.status === "ready")),
      );
      yield* adapter.sendTurn({ threadId, attachments: [file] });
      yield* waitFor(() =>
        adapter.readThread(threadId).pipe(
          Effect.map((snapshot) => promptCommands(snapshot).length >= 2),
          Effect.orElseSucceed(() => false),
        ),
      );
      const fileOnly = promptCommands(yield* adapter.readThread(threadId)).at(-1);
      assert.include(fileOnly?.message ?? "", filePath);
      assert.isUndefined(fileOnly?.images);

      const emptyTurn = yield* adapter.sendTurn({ threadId }).pipe(Effect.flip);
      assert.equal(emptyTurn._tag, "ProviderAdapterValidationError");
    }),
  );

  it.effect("rejects invalid cursors, reserved flags, and unsupported runtime modes", () =>
    Effect.gen(function* () {
      const binaryPath = yield* makeWrapper();
      const adapter = yield* makeAdapter(binaryPath, ids("unused"));
      const invalidCursor = yield* adapter
        .startSession({
          threadId: ThreadId.make("invalid-cursor"),
          runtimeMode: "full-access",
          resumeCursor: { schemaVersion: 99, sessionId: "x", ownerThreadId: "y" },
        })
        .pipe(Effect.flip);
      assert.equal(invalidCursor._tag, "ProviderAdapterValidationError");
      const unsupportedMode = yield* adapter
        .startSession({
          threadId: ThreadId.make("unsupported-mode"),
          runtimeMode: "auto-accept-edits",
        })
        .pipe(Effect.flip);
      assert.equal(unsupportedMode._tag, "ProviderAdapterValidationError");

      const unsafe = yield* makePrimeAdapter(
        decodeSettings({ binaryPath, launchArgs: ["--session-id", "stolen"] }),
        { sessionId: ids("unused-unsafe") },
      );
      const reserved = yield* unsafe
        .startSession({ threadId: ThreadId.make("reserved"), runtimeMode: "full-access" })
        .pipe(Effect.flip);
      assert.equal(reserved._tag, "ProviderAdapterValidationError");

      const startupCrashAdapter = yield* makePrimeAdapter(decodeSettings({ binaryPath }), {
        environment: { ...process.env, T3_PRIME_RPC_SCENARIO: "adapter-startup-crash" },
        sessionId: ids("prime-startup-crash", "generation-startup-crash"),
      });
      const startupThreadId = ThreadId.make("startup-crash");
      const startupCrash = yield* startupCrashAdapter
        .startSession({ threadId: startupThreadId, runtimeMode: "full-access" })
        .pipe(Effect.flip);
      assert.equal(startupCrash._tag, "ProviderAdapterProcessError");
      assert.isFalse(yield* startupCrashAdapter.hasSession(startupThreadId));
    }),
  );

  it.effect("maps each permission decision to Prime's extension response", () =>
    Effect.gen(function* () {
      const binaryPath = yield* makeWrapper();
      const adapter = yield* makeAdapter(
        binaryPath,
        ids(
          "prime-accept",
          "generation-accept",
          "turn-accept",
          "prime-decline",
          "generation-decline",
          "turn-decline",
          "prime-cancel",
          "generation-cancel",
          "turn-cancel",
        ),
      );
      const events: ProviderRuntimeEvent[] = [];
      const eventFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => events.push(event)),
      ).pipe(Effect.forkChild);
      const cases = [
        { decision: "accept" as const, expected: { value: "Allow once" } },
        { decision: "decline" as const, expected: { value: "Decline" } },
        { decision: "cancel" as const, expected: { cancelled: true } },
      ];

      for (const permissionCase of cases) {
        const threadId = ThreadId.make(`prime-${permissionCase.decision}`);
        yield* adapter.startSession({ threadId, runtimeMode: "approval-required" });
        yield* adapter.sendTurn({ threadId, input: "permission" });
        yield* waitFor(() =>
          Effect.sync(() =>
            events.some((event) => event.type === "request.opened" && event.threadId === threadId),
          ),
        );
        yield* adapter.respondToRequest(
          threadId,
          ApprovalRequestId.make("permission-1"),
          permissionCase.decision,
        );
        yield* waitFor(() =>
          adapter
            .listSessions()
            .pipe(
              Effect.map(
                (sessions) =>
                  sessions.find((session) => session.threadId === threadId)?.status === "ready",
              ),
            ),
        );
        const commands = (yield* adapter.readThread(threadId)).turns.at(-1)?.items ?? [];
        assert.isTrue(
          commands.some(
            (command) =>
              isCommand(command, "extension_ui_response") &&
              command.id === "permission-1" &&
              Object.entries(permissionCase.expected).every(
                ([key, value]) => command[key] === value,
              ),
          ),
        );
      }

      yield* Fiber.interrupt(eventFiber);
    }),
  );

  it.effect("reports crashes and closes all sessions with its scope", () =>
    Effect.gen(function* () {
      const binaryPath = yield* makeWrapper();
      const scope = yield* Scope.make();
      const adapter = yield* makeAdapter(binaryPath, ids("prime-crash", "generation-crash")).pipe(
        Effect.provideService(Scope.Scope, scope),
      );
      const threadId = ThreadId.make("prime-crash");
      const events: ProviderRuntimeEvent[] = [];
      const eventFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => events.push(event)),
      ).pipe(Effect.forkChild);
      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
      yield* adapter.sendTurn({ threadId, input: "permission-crash" });
      yield* waitFor(() =>
        Effect.sync(() => events.some((event) => event.type === "request.opened")),
      );
      for (let attempt = 0; attempt < 100 && (yield* adapter.hasSession(threadId)); attempt += 1) {
        yield* Effect.promise(() => NodeTimersPromises.setTimeout(20));
      }
      assert.isFalse(yield* adapter.hasSession(threadId));
      assert.isTrue(
        events.some(
          (event) => event.type === "session.state.changed" && event.payload.state === "error",
        ),
      );
      assert.isTrue(
        events.some(
          (event) => event.type === "request.resolved" && event.payload.decision === "decline",
        ),
      );
      assert.isTrue(
        events.some((event) => event.type === "turn.completed" && event.payload.state === "failed"),
      );

      const liveThread = ThreadId.make("prime-scope");
      yield* adapter.startSession({ threadId: liveThread, runtimeMode: "full-access" });
      const secondLiveThread = ThreadId.make("prime-stop-all");
      yield* adapter.startSession({ threadId: secondLiveThread, runtimeMode: "full-access" });
      yield* adapter.stopAll();
      assert.isFalse(yield* adapter.hasSession(liveThread));
      assert.isFalse(yield* adapter.hasSession(secondLiveThread));

      yield* adapter.startSession({ threadId: liveThread, runtimeMode: "full-access" });
      yield* Scope.close(scope, Exit.void);
      assert.isFalse(yield* adapter.hasSession(liveThread));
      yield* Fiber.interrupt(eventFiber);
    }),
  );
});
