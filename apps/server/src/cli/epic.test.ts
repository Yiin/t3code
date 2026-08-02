import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { EnvironmentScopeRequiredError, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";
import { FetchHttpClient, HttpClientError } from "effect/unstable/http";

import type * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import type * as ServerConfig from "../config.ts";
import { persistServerRuntimeState } from "../serverRuntimeState.ts";
import {
  discoverLiveServer,
  findEpicProject,
  formatEpicOutput,
  formatEpicRunCompact,
  isEpicRunTerminal,
  shouldClearEpicRuntimeState,
} from "./epic.ts";

const run = {
  runId: "run-1",
  epicId: "t3code-vst",
  projectId: ProjectId.make("project-1"),
  cwd: "/repo",
  prompt: "Cook it",
  modelSelection: { instanceId: "codex", model: "gpt-5" },
  runtimeMode: "full-access",
  status: "running",
  maxIterations: 10,
  iterationsCompleted: 2,
  currentThreadId: ThreadId.make("thread-1"),
  currentTurnStartedAt: "2026-07-29T00:00:00.000Z",
  consecutiveFailures: 0,
  lastError: null,
  createdAt: "2026-07-29T00:00:00.000Z",
  updatedAt: "2026-07-29T00:00:00.000Z",
  threadRefs: [],
  recentIterations: [],
} as const;

it("resolves the project whose normalized workspace root matches", () => {
  // The shell snapshot only ever contains active projects — the server-side
  // query filters `deleted_at IS NULL` — so a deleted project is simply never
  // in `projects` and any cwd that only ever mapped to one resolves to
  // nothing, same as any other unmatched cwd.
  const snapshot = {
    projects: [{ id: ProjectId.make("project-1"), workspaceRoot: "/repo" }],
  } as never;

  assert.strictEqual(findEpicProject(snapshot, "/repo")?.id, "project-1");
  assert.isUndefined(findEpicProject(snapshot, "/repo/child"));
});

it("keeps declared probe failures and timeouts without clearing runtime state", () => {
  const declaredFailure = new EnvironmentScopeRequiredError({
    code: "insufficient_scope",
    requiredScope: "orchestration:read",
    traceId: "trace-1",
  });
  assert.isFalse(shouldClearEpicRuntimeState(declaredFailure));

  // The regression this pins: a slow-but-alive server must never look dead.
  assert.isFalse(shouldClearEpicRuntimeState(new Cause.TimeoutError()));
});

it("clears runtime state only on a genuine transport failure", () => {
  const transportFailure = new HttpClientError.HttpClientError({
    reason: new HttpClientError.TransportError({
      request: {} as never,
      cause: new Error("connect ECONNREFUSED"),
    }),
  });
  assert.isTrue(shouldClearEpicRuntimeState(transportFailure));

  const statusFailure = new HttpClientError.HttpClientError({
    reason: new HttpClientError.StatusCodeError({
      request: {} as never,
      response: { status: 503 } as never,
    }),
  });
  assert.isFalse(shouldClearEpicRuntimeState(statusFailure));
});

it("formats compact output deterministically", () => {
  assert.strictEqual(
    formatEpicRunCompact(run as never),
    "run-1\trunning\tt3code-vst\t2/10\tthread-1\t-",
  );
});

it("formats lists as counted TOON and JSON as pure JSON", () => {
  assert.strictEqual(
    formatEpicOutput([], false),
    "runs[0]{runId,status,epicId,iterations,currentThreadId,lastError}:",
  );
  assert.strictEqual(formatEpicOutput([], true), "[]");
  assert.match(formatEpicOutput([run], false), /^runs\[1\]\{.*\}:\n  run-1\t/);
});

it("treats done, failed, and cancelled as terminal", () => {
  assert.isFalse(isEpicRunTerminal({ status: "running" }));
  assert.isFalse(isEpicRunTerminal({ status: "paused" }));
  assert.isTrue(isEpicRunTerminal({ status: "done" }));
  assert.isTrue(isEpicRunTerminal({ status: "failed" }));
  assert.isTrue(isEpicRunTerminal({ status: "cancelled" }));
});

// discoverLiveServer -----------------------------------------------------
//
// These pin the t3code-dif / t3code-efs fix end to end: the probe now calls
// the cheap shell snapshot with a 10s budget, and only a genuine transport
// failure — never a slow response — clears the persisted runtime state.

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
      prefix: "t3-epic-discover-test-",
    });
    const statePath = path.join(root, "server-runtime.json");
    yield* persistServerRuntimeState({
      path: statePath,
      state: {
        version: 1,
        pid: 123,
        port: 4_971,
        origin,
        startedAt: "2026-08-02T00:00:00.000Z",
      },
    });
    const config = { serverRuntimeStatePath: statePath } as ServerConfig.ServerConfig["Service"];
    return { statePath, config };
  });

it.effect("discovers a live server even when the probe outlasts the old 1s timeout", () =>
  Effect.gen(function* () {
    const { statePath, config } = yield* setUpRuntimeState("http://127.0.0.1:1");
    // A plain deferred Promise, resolved explicitly below — no real delay and
    // no manual Effect runtime, just a response that doesn't arrive right away.
    let resolveResponse!: (response: Response) => void;
    const responsePromise = new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    });
    // Record which endpoint the probe hits. Without this the test passes even
    // if the probe reverts to the full `snapshot` call, because the mocked body
    // decodes under both OrchestrationShellSnapshot and OrchestrationReadModel.
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

    const fiber = yield* discoverLiveServer(fakeAuth, config).pipe(
      Effect.provide(layer),
      Effect.forkScoped,
    );
    yield* Effect.yieldNow;
    // Slower than the old 1s budget, comfortably inside the new 10s one.
    yield* TestClock.adjust(Duration.seconds(3));
    resolveResponse(emptyShellSnapshotResponse());
    const result = yield* Fiber.join(fiber);
    const fileSystem = yield* FileSystem.FileSystem;

    assert.strictEqual(result.origin, "http://127.0.0.1:1");
    assert.isTrue(yield* fileSystem.exists(statePath));
    // The cheap shell endpoint, not the full read model — this is the fix.
    assert.deepStrictEqual(
      requestedUrls.map((url) => new URL(url).pathname),
      ["/api/orchestration/shell"],
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("keeps the persisted runtime state when the probe times out", () =>
  Effect.gen(function* () {
    const { statePath, config } = yield* setUpRuntimeState("http://127.0.0.1:1");
    // Never resolves — the only way discovery can fail here is the timeout.
    const fetchMock = (() => new Promise<Response>(() => {})) as unknown as typeof fetch;
    const layer = Layer.merge(
      FetchHttpClient.layer,
      Layer.succeed(FetchHttpClient.Fetch, fetchMock),
    );

    const fiber = yield* discoverLiveServer(fakeAuth, config).pipe(
      Effect.provide(layer),
      Effect.flip,
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
    const error = yield* Fiber.join(fiber);
    const fileSystem = yield* FileSystem.FileSystem;

    assert.isTrue(Cause.isTimeoutError(error.cause));
    // This is the efs regression: a timeout must never delete the file.
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

    yield* discoverLiveServer(fakeAuth, config).pipe(Effect.provide(layer), Effect.flip);
    const fileSystem = yield* FileSystem.FileSystem;

    assert.isFalse(yield* fileSystem.exists(statePath));
  }).pipe(Effect.provide(NodeServices.layer)),
);
