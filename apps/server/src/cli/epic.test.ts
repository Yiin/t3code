import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { EnvironmentScopeRequiredError, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
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
  EPIC_CLI_WATCH_MAX_CONSECUTIVE_FAILURES,
  EpicCliError,
  discoverLiveServer,
  findEpicProject,
  formatEpicOutput,
  formatEpicRunCompact,
  isEpicRunTerminal,
  makeEpicSessionLease,
  shouldClearEpicRuntimeState,
  watchEpicRun,
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
  // The shell snapshot only ever contains active projects — getShellSnapshot
  // drops deleted rows while assembling the response — so a deleted project is
  // simply never in `projects`, and any cwd that only ever mapped to one
  // resolves to nothing, same as any other unmatched cwd.
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

const makeFakeAuth = (options?: { readonly ttl?: Duration.Duration }) => {
  const issued: Array<string> = [];
  const revoked: Array<string> = [];
  const auth = {
    issueSession: () =>
      Effect.map(DateTime.now, (now) => {
        const sessionId = `session-${issued.length + 1}`;
        issued.push(sessionId);
        return {
          sessionId,
          token: `token-${issued.length}`,
          expiresAt: DateTime.addDuration(now, options?.ttl ?? Duration.minutes(5)),
        };
      }),
    revokeSession: (sessionId: string) =>
      Effect.sync(() => {
        revoked.push(sessionId);
        return true;
      }),
  } as unknown as EnvironmentAuth.EnvironmentAuth["Service"];
  return { auth, issued, revoked };
};

const fakeAuth = makeFakeAuth().auth;

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

    const fiber = yield* discoverLiveServer(yield* makeEpicSessionLease(fakeAuth), config).pipe(
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

    const fiber = yield* discoverLiveServer(yield* makeEpicSessionLease(fakeAuth), config).pipe(
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

    yield* discoverLiveServer(yield* makeEpicSessionLease(fakeAuth), config).pipe(
      Effect.provide(layer),
      Effect.flip,
    );
    const fileSystem = yield* FileSystem.FileSystem;

    assert.isFalse(yield* fileSystem.exists(statePath));
  }).pipe(Effect.provide(NodeServices.layer)),
);

// Session lease ----------------------------------------------------------
//
// These pin the t3code-8h3 fix. Issuing a session INSERTs an `auth_sessions`
// row, so it is a SQLite write. Read-only commands used to take that write
// lock once per HTTP call — and `epic watch` once per second — which a busy
// server lost often enough to fail with 'database is locked'.

it.effect("issues one session for a whole command instead of one per call", () =>
  Effect.gen(function* () {
    const { auth, issued, revoked } = makeFakeAuth();
    const lease = yield* makeEpicSessionLease(auth);

    const tokens = yield* Effect.forEach([1, 2, 3, 4, 5], () => lease.token);

    // One issue, five uses: four writes that used to happen no longer do.
    assert.deepStrictEqual(issued, ["session-1"]);
    assert.deepStrictEqual(tokens, ["token-1", "token-1", "token-1", "token-1", "token-1"]);
    assert.deepStrictEqual(revoked, []);
  }),
);

it.effect("re-issues and revokes only once the cached token nears expiry", () =>
  Effect.gen(function* () {
    const { auth, issued, revoked } = makeFakeAuth({ ttl: Duration.minutes(5) });
    const lease = yield* makeEpicSessionLease(auth);

    assert.strictEqual(yield* lease.token, "token-1");
    // Still comfortably inside the 1-minute refresh margin.
    yield* TestClock.adjust(Duration.minutes(3));
    assert.strictEqual(yield* lease.token, "token-1");
    assert.deepStrictEqual(issued, ["session-1"]);

    // Now inside the margin, so the lease rotates and cleans up the old row.
    yield* TestClock.adjust(Duration.minutes(1.5));
    assert.strictEqual(yield* lease.token, "token-2");
    assert.deepStrictEqual(issued, ["session-1", "session-2"]);
    assert.deepStrictEqual(revoked, ["session-1"]);
  }),
);

it.effect("shares the discovery session with the command that follows it", () =>
  Effect.gen(function* () {
    const { config } = yield* setUpRuntimeState("http://127.0.0.1:1");
    const { auth, issued } = makeFakeAuth();
    const fetchMock = (() =>
      Promise.resolve(emptyShellSnapshotResponse())) as unknown as typeof fetch;
    const layer = Layer.merge(
      FetchHttpClient.layer,
      Layer.succeed(FetchHttpClient.Fetch, fetchMock),
    );
    const lease = yield* makeEpicSessionLease(auth);

    yield* discoverLiveServer(lease, config).pipe(Effect.provide(layer));
    // The command request that follows discovery reuses the same credential.
    yield* lease.token;

    assert.deepStrictEqual(issued, ["session-1"]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

// watchEpicRun -----------------------------------------------------------

const runWithStatus = (status: string) => ({ ...run, status }) as never;

it.effect("keeps watching after a poll fails and finishes when the run is done", () =>
  Effect.gen(function* () {
    let attempt = 0;
    const failure = new EpicCliError({ operation: "callLiveServer", detail: "locked" });
    // Poll 1 sees the run, polls 2 and 3 lose the SQLite write lock, poll 4
    // sees it finish. Before this fix, poll 2 ended the watch.
    const poll = Effect.suspend(() => {
      attempt += 1;
      if (attempt === 2 || attempt === 3) return Effect.fail(failure);
      return Effect.succeed(attempt >= 4 ? runWithStatus("done") : runWithStatus("running"));
    });
    const lines: Array<string> = [];

    yield* watchEpicRun({
      poll,
      emit: (line) => Effect.sync(() => void lines.push(line)),
      json: false,
      interval: Duration.zero,
    });

    assert.strictEqual(attempt, 4);
    assert.strictEqual(lines.length, 2);
    assert.match(lines[1] ?? "", /\tdone\t/);
  }),
);

it.effect("fails immediately when the very first poll fails", () =>
  Effect.gen(function* () {
    let attempt = 0;
    const poll = Effect.suspend(() => {
      attempt += 1;
      return Effect.fail(new EpicCliError({ operation: "callLiveServer", detail: "no such run" }));
    });

    const error = yield* watchEpicRun({
      poll,
      emit: () => Effect.void,
      json: false,
      interval: Duration.zero,
    }).pipe(Effect.flip);

    assert.strictEqual(attempt, 1);
    assert.strictEqual(error.detail, "no such run");
  }),
);

it.effect("gives up after too many consecutive failures", () =>
  Effect.gen(function* () {
    let attempt = 0;
    const poll = Effect.suspend(() => {
      attempt += 1;
      if (attempt === 1) return Effect.succeed(runWithStatus("running"));
      return Effect.fail(new EpicCliError({ operation: "callLiveServer", detail: "locked" }));
    });

    const error = yield* watchEpicRun({
      poll,
      emit: () => Effect.void,
      json: false,
      interval: Duration.zero,
    }).pipe(Effect.flip);

    assert.strictEqual(attempt, EPIC_CLI_WATCH_MAX_CONSECUTIVE_FAILURES + 2);
    assert.strictEqual(error.detail, "locked");
  }),
);
