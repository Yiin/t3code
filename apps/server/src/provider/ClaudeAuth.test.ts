import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ClaudeSettings, ProviderInstanceId, type ProviderAuthState } from "@t3tools/contracts";
import * as PtyAdapter from "@t3tools/shared/PtyAdapter";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";

import { makeClaudeAuth } from "./ClaudeAuth.ts";

const instanceId = ProviderInstanceId.make("claude-work");
const decodeSettings = Schema.decodeEffect(ClaudeSettings);
const makeHarness = Effect.fnUntraced(function* (
  status = { loggedIn: true, email: "work@example.com" },
) {
  const fs = yield* FileSystem.FileSystem;
  const homePath = yield* fs.makeTempDirectoryScoped();
  let data: ((value: string) => void) | undefined;
  let exit: ((value: PtyAdapter.PtyExitEvent) => void) | undefined;
  const writes: string[] = [];
  const spawns: PtyAdapter.PtySpawnInput[] = [];
  const commands: Array<ReadonlyArray<string>> = [];
  let kills = 0;
  let changes = 0;
  const spawner = ChildProcessSpawner.make((command) => {
    if (command._tag !== "StandardCommand") return Effect.die("Unexpected command pipeline");
    commands.push(command.args);
    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(123),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.encodeText(Stream.make(JSON.stringify(status))),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      }),
    );
  });
  const controller = yield* makeClaudeAuth({
    instanceId,
    config: yield* decodeSettings({ binaryPath: "claude", homePath }),
    environment: { PATH: "/bin" },
    cwd: homePath,
    onChanged: Effect.sync(() => {
      changes++;
    }),
  }).pipe(
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    Effect.provideService(PtyAdapter.PtyAdapter, {
      spawn: (input) =>
        Effect.sync(() => {
          spawns.push(input);
          return {
            pid: 123,
            write: (value) => {
              writes.push(value);
            },
            resize: () => {},
            kill: () => {
              kills++;
            },
            onData: (callback) => {
              data = callback;
              return () => {
                data = undefined;
              };
            },
            onExit: (callback) => {
              exit = callback;
              return () => {
                exit = undefined;
              };
            },
          };
        }),
    }),
  );
  const wait = (predicate: (state: ProviderAuthState) => boolean, owner = "owner") =>
    controller
      .subscribe(owner)
      .pipe(Stream.filter(predicate), Stream.runHead, Effect.map(Option.getOrThrow));
  const start = Effect.gen(function* () {
    yield* controller.start("owner");
    return yield* wait((state) => state.phase === "waiting");
  });
  return {
    controller,
    wait,
    start,
    writes,
    spawns,
    commands,
    homePath,
    emit: (value: string) => {
      assert.isFunction(data);
      data!(value);
    },
    exit: (exitCode: number) => {
      assert.isFunction(exit);
      exit!({ exitCode, signal: null });
    },
    kills: () => kills,
    changes: () => changes,
  };
});

it.effect("logs into the isolated account and verifies the email before refreshing", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const waiting = yield* h.start;
      assert.deepEqual(h.spawns[0]?.args, ["auth", "login", "--claudeai"]);
      assert.equal(h.spawns[0]?.env.CLAUDE_CONFIG_DIR, h.homePath);
      assert.equal(h.controller.credentialBinding?.key, `claude:home:${h.homePath}`);
      h.emit("Open https://claude.com/cai/oauth/authorize?state=example\r\nPaste code here > ");
      const linked = yield* h.wait((state) => state.authorizationUrl !== null);
      assert.equal(linked.authorizationUrl, "https://claude.com/cai/oauth/authorize?state=example");
      assert.equal(linked.interaction?.type, "credentials");
      yield* h.controller.respond!("owner", {
        instanceId,
        flowId: waiting.flowId!,
        interactionId: "code",
        response: { type: "credentials", values: { code: "one-time-code" } },
      });
      assert.deepEqual(h.writes, ["one-time-code\r"]);
      h.exit(0);
      const finished = yield* h.wait((state) => state.phase === "succeeded");
      assert.isNull(finished.interaction);
      assert.isNull(finished.authorizationUrl);
      assert.deepEqual(h.commands, [["auth", "status", "--json"]]);
      assert.equal(h.changes(), 1);
      assert.equal(h.kills(), 1);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect.each([
  { loggedIn: false, email: "" },
  { loggedIn: true, email: "" },
])("rejects exit zero without a verified account: %j", (status) =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* makeHarness(status);
      yield* h.start;
      h.exit(0);
      const failed = yield* h.wait((state) => state.phase === "failed");
      assert.include(failed.message ?? "", "did not confirm");
      assert.equal(h.changes(), 0);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("hides login output from other clients and cancels the owned process", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const waiting = yield* h.start;
      h.emit("https://claude.com/cai/oauth/authorize?state=private");
      yield* h.wait((state) => state.authorizationUrl !== null);
      const other = yield* h.wait(() => true, "other");
      assert.isNull(other.flowId);
      assert.isNull(other.interaction);
      assert.isNull(other.authorizationUrl);
      const rejected = yield* h.controller.cancel("other", waiting.flowId!).pipe(Effect.flip);
      assert.equal(rejected._tag, "ProviderSetupError");
      yield* h.controller.cancel("owner", waiting.flowId!);
      assert.equal(h.kills(), 1);
      assert.equal(h.changes(), 0);
      const stale = yield* h.controller.respond!("owner", {
        instanceId,
        flowId: waiting.flowId!,
        interactionId: "terminal",
        response: { type: "terminal", data: "late-code\r" },
      }).pipe(Effect.flip);
      assert.equal(stale._tag, "ProviderSetupError");
      assert.deepEqual(h.writes, []);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("signs out through Claude and refreshes after stopping the login process", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* h.start;
      let stopped = false;
      yield* h.controller.logout(
        Effect.sync(() => {
          stopped = true;
        }),
      );
      assert.isTrue(stopped);
      assert.equal(h.kills(), 1);
      assert.deepEqual(h.commands, [["auth", "logout"]]);
      assert.equal(h.changes(), 1);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
