import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { EnvironmentInternalError } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";
import { FetchHttpClient, HttpClientError } from "effect/unstable/http";

import * as NetService from "@t3tools/shared/Net";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/unstable/cli";

import type * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import { persistServerRuntimeState } from "../serverRuntimeState.ts";

import {
  ProjectLiveServerDeclaredResponseError,
  ProjectLiveServerRequestError,
  projectCommand,
  projectCommandErrorFromLiveServerRequest,
  shouldClearProjectRuntimeState,
  tryResolveLiveProjectExecutionMode,
} from "./project.ts";

it("maps declared server failures into structural project command errors", () => {
  const cause = new EnvironmentInternalError({
    code: "internal_error",
    reason: "orchestration_snapshot_failed",
    traceId: "trace-123",
  });

  const error = projectCommandErrorFromLiveServerRequest(cause);

  assert.instanceOf(error, ProjectLiveServerDeclaredResponseError);
  assert.strictEqual(error.operation, "callLiveServer");
  assert.strictEqual(error.code, "internal_error");
  assert.strictEqual(error.traceId, "trace-123");
  assert.strictEqual(error.message, "Server request failed (internal_error, trace trace-123).");
  assert.strictEqual(error.cause, cause);
});

it("preserves unexpected server failures without deriving the message from them", () => {
  const cause = new Error("credential abc123 was rejected");

  const error = projectCommandErrorFromLiveServerRequest(cause);

  assert.instanceOf(error, ProjectLiveServerRequestError);
  assert.strictEqual(error.operation, "callLiveServer");
  assert.strictEqual(error.message, "Failed to call the running server.");
  assert.strictEqual(error.cause, cause);
});

it("keeps declared server failures without clearing runtime state", () => {
  const failure = new ProjectLiveServerDeclaredResponseError({
    operation: "callLiveServer",
    code: "internal_error",
    traceId: "trace-1",
    cause: new EnvironmentInternalError({
      code: "internal_error",
      reason: "orchestration_snapshot_failed",
      traceId: "trace-1",
    }),
  });
  assert.isFalse(shouldClearProjectRuntimeState(failure));
});

it("keeps a probe timeout without clearing runtime state", () => {
  // The regression this pins: a slow-but-alive server must never look dead.
  const failure = new ProjectLiveServerRequestError({
    operation: "callLiveServer",
    cause: new Cause.TimeoutError(),
  });
  assert.isFalse(shouldClearProjectRuntimeState(failure));
});

it("clears runtime state only on a genuine transport failure", () => {
  const failure = new ProjectLiveServerRequestError({
    operation: "callLiveServer",
    cause: new HttpClientError.HttpClientError({
      reason: new HttpClientError.TransportError({
        request: {} as never,
        cause: new Error("connect ECONNREFUSED"),
      }),
    }),
  });
  assert.isTrue(shouldClearProjectRuntimeState(failure));
});

// tryResolveLiveProjectExecutionMode -------------------------------------
//
// These pin the t3code-a2g fix end to end: the probe now calls the cheap
// shell snapshot with a 10s budget, and only a genuine transport failure —
// never a slow response — clears the persisted runtime state.

const fakeAuth = {
  issueSession: () => Effect.succeed({ sessionId: "session-1", token: "test-token" }),
  revokeSession: () => Effect.succeed(true),
} as unknown as EnvironmentAuth.EnvironmentAuth["Service"];

const emptyShellSnapshotResponse = () =>
  new Response(
    JSON.stringify({
      snapshotSequence: 0,
      projects: [],
      threads: [],
      updatedAt: "2026-08-02T00:00:00.000Z",
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

const setUpRuntimeState = (origin: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-project-live-mode-test-",
    });
    const statePath = path.join(root, "server-runtime.json");
    yield* persistServerRuntimeState({
      path: statePath,
      state: {
        version: 1,
        pid: 123,
        port: 4_972,
        origin,
        startedAt: "2026-08-02T00:00:00.000Z",
      },
    });
    const config = { serverRuntimeStatePath: statePath } as ServerConfig.ServerConfig["Service"];
    return { statePath, config };
  });

it.effect("reports no live mode and keeps the persisted runtime state when the probe hangs", () =>
  Effect.gen(function* () {
    const { statePath, config } = yield* setUpRuntimeState("http://127.0.0.1:1");
    // Never resolves — the only way this can settle here is the timeout.
    const fetchMock = (() => new Promise<Response>(() => {})) as unknown as typeof fetch;
    const layer = Layer.merge(
      FetchHttpClient.layer,
      Layer.succeed(FetchHttpClient.Fetch, fetchMock),
    );

    const fiber = yield* tryResolveLiveProjectExecutionMode(fakeAuth, config).pipe(
      Effect.provide(layer),
      Effect.forkScoped,
    );
    // NodeServices.layer builds several real Node-backed services before this
    // fiber's effect reaches the HTTP call, so it can take more than one
    // scheduler tick to get there. Advance virtual time in small steps,
    // yielding between each, until the fiber actually settles.
    for (let attempt = 0; attempt < 100 && fiber.pollUnsafe() === undefined; attempt++) {
      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.millis(200));
    }
    const result = yield* Fiber.join(fiber);
    const fileSystem = yield* FileSystem.FileSystem;

    // The mutant this test kills: deleting the
    // `if (shouldClearProjectRuntimeState(...))` guard at project.ts:390 and
    // restoring an unconditional clear. That mutant still returns
    // Option.none here, so the file-existence assertion — not the Option
    // check alone — is what catches it.
    assert.isTrue(Option.isNone(result));
    assert.isTrue(yield* fileSystem.exists(statePath));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("clears the persisted runtime state on a genuine connection failure", () =>
  Effect.gen(function* () {
    const { statePath, config } = yield* setUpRuntimeState("http://127.0.0.1:1");
    const fetchMock = (() =>
      Promise.reject(new TypeError("fetch failed"))) as unknown as typeof fetch;
    const layer = Layer.merge(
      FetchHttpClient.layer,
      Layer.succeed(FetchHttpClient.Fetch, fetchMock),
    );

    const result = yield* tryResolveLiveProjectExecutionMode(fakeAuth, config).pipe(
      Effect.provide(layer),
    );
    const fileSystem = yield* FileSystem.FileSystem;

    assert.isTrue(Option.isNone(result));
    assert.isFalse(yield* fileSystem.exists(statePath));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "engages live mode via the cheap shell probe even when it outlasts the old 1s timeout",
  () =>
    Effect.gen(function* () {
      const { statePath, config } = yield* setUpRuntimeState("http://127.0.0.1:1");
      // A plain deferred Promise, resolved explicitly below — no real delay and
      // no manual Effect runtime, just a response that doesn't arrive right away.
      let resolveResponse!: (response: Response) => void;
      const responsePromise = new Promise<Response>((resolve) => {
        resolveResponse = resolve;
      });
      // Record which endpoint the probe hits. Without this the test passes even
      // if the probe reverts to the full `snapshot` call, because the mocked
      // body decodes under both OrchestrationShellSnapshot and
      // OrchestrationReadModel.
      const requestedUrls: string[] = [];
      const fetchMock = ((input: unknown) => {
        requestedUrls.push(
          typeof input === "string" ? input : String((input as { url?: unknown })?.url ?? input),
        );
        return responsePromise;
      }) as unknown as typeof fetch;
      const layer = Layer.merge(
        FetchHttpClient.layer,
        Layer.succeed(FetchHttpClient.Fetch, fetchMock),
      );

      const fiber = yield* tryResolveLiveProjectExecutionMode(fakeAuth, config).pipe(
        Effect.provide(layer),
        Effect.forkScoped,
      );
      yield* Effect.yieldNow;
      // Slower than the old 1s budget, comfortably inside the new 10s one.
      yield* TestClock.adjust(Duration.seconds(3));
      resolveResponse(emptyShellSnapshotResponse());
      const result = yield* Fiber.join(fiber);
      const fileSystem = yield* FileSystem.FileSystem;

      assert.isTrue(Option.isSome(result));
      assert.strictEqual(Option.getOrThrow(result).origin, "http://127.0.0.1:1");
      assert.isTrue(yield* fileSystem.exists(statePath));
      // The cheap shell endpoint, not the full read model — this is the fix.
      assert.deepStrictEqual(
        requestedUrls.map((url) => new URL(url).pathname),
        ["/api/orchestration/shell"],
      );
    }).pipe(Effect.provide(NodeServices.layer)),
);

// The mutation path, not just the probe (t3code-zac.3) ---------------------
//
// `project add` used to load the whole orchestration read model just to check
// whether a project already claimed the workspace root — 4s and 133MB against
// a real state.sqlite. It reads the shell snapshot now. As with the probe test
// above, the assertion has to be on the request URL: the stub body decodes
// under both OrchestrationShellSnapshot and OrchestrationReadModel, so a
// body-shape assertion would pass even if the full snapshot came back.

const requestPathname = (input: unknown): string => {
  const raw =
    typeof input === "string" ? input : String((input as { url?: unknown })?.url ?? input);
  return new URL(raw).pathname;
};

// The wire shape of `OrchestrationProjectShell`, spelled out so the stub body
// stays free of `unknown` (which the `preferSchemaOverJson` diagnostic rejects).
type StubProjectShell = {
  readonly id: string;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly defaultModelSelection: null;
  readonly scripts: ReadonlyArray<never>;
  readonly createdAt: string;
  readonly updatedAt: string;
};

const runProjectCliWithStubbedServer = (input: {
  readonly args: ReadonlyArray<string>;
  readonly requestedPathnames: Array<string>;
  readonly projects: ReadonlyArray<StubProjectShell>;
}) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-project-live-mutation-test-",
    });
    const derivedPaths = yield* ServerConfig.deriveServerPaths(baseDir, undefined, {
      baseDirIsExplicit: true,
    });
    yield* ServerConfig.ensureServerDirectories(derivedPaths);
    yield* persistServerRuntimeState({
      path: derivedPaths.serverRuntimeStatePath,
      state: {
        version: 1,
        pid: 123,
        port: 4_972,
        origin: "http://127.0.0.1:4972",
        startedAt: "2026-08-02T00:00:00.000Z",
      },
    });

    // @effect-diagnostics-next-line preferSchemaOverJson:off - Stub wire body for a fake server.
    const shellSnapshotBody = JSON.stringify({
      snapshotSequence: 0,
      projects: input.projects,
      threads: [],
      updatedAt: "2026-08-02T00:00:00.000Z",
    });
    const fetchMock = ((request: unknown) => {
      const pathname = requestPathname(request);
      input.requestedPathnames.push(pathname);
      const body =
        pathname === "/api/orchestration/dispatch"
          ? JSON.stringify({ sequence: 1 })
          : shellSnapshotBody;
      return Promise.resolve(
        new Response(body, { status: 200, headers: { "content-type": "application/json" } }),
      );
    }) as unknown as typeof fetch;

    return yield* Command.runWith(projectCommand, { version: "0.0.0" })([
      ...input.args,
      "--base-dir",
      baseDir,
    ]).pipe(Effect.provideService(FetchHttpClient.Fetch, fetchMock));
  }).pipe(
    Effect.scoped,
    Effect.provide(Layer.mergeAll(NodeServices.layer, NetService.layer, TestConsole.layer)),
  );

it.effect("adds a project in live mode without ever loading the full read model", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const workspaceRoot = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-project-live-mutation-workspace-",
    });
    const requestedPathnames: Array<string> = [];

    yield* runProjectCliWithStubbedServer({
      args: ["add", workspaceRoot, "--title", "Live Project"],
      requestedPathnames,
      projects: [],
    });

    assert.isFalse(requestedPathnames.includes("/api/orchestration/snapshot"));
    assert.deepStrictEqual(requestedPathnames, [
      // The liveness probe, then the snapshot the mutation resolves against.
      "/api/orchestration/shell",
      "/api/orchestration/shell",
      "/api/orchestration/dispatch",
    ]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("renames a project in live mode without ever loading the full read model", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const workspaceRoot = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-project-live-rename-workspace-",
    });
    const requestedPathnames: Array<string> = [];

    // Rename resolves the target through `findActiveProjectTarget`, which now
    // reads `OrchestrationProjectShell` rows — a shape with no `deletedAt`.
    yield* runProjectCliWithStubbedServer({
      args: ["rename", workspaceRoot, "Renamed Project"],
      requestedPathnames,
      projects: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          title: "Live Project",
          workspaceRoot,
          defaultModelSelection: null,
          scripts: [],
          createdAt: "2026-08-02T00:00:00.000Z",
          updatedAt: "2026-08-02T00:00:00.000Z",
        },
      ],
    });

    assert.isFalse(requestedPathnames.includes("/api/orchestration/snapshot"));
    assert.deepStrictEqual(requestedPathnames, [
      "/api/orchestration/shell",
      "/api/orchestration/shell",
      "/api/orchestration/dispatch",
    ]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
