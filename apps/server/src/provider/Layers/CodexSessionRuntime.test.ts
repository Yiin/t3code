import * as NodeAssert from "node:assert/strict";
import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { describe } from "vite-plus/test";
import { DEFAULT_MODEL, ThreadId, TurnId } from "@t3tools/contracts";
import * as CodexErrors from "effect-codex-app-server/errors";
import * as CodexRpc from "effect-codex-app-server/rpc";

import {
  buildCodexDeveloperInstructions,
  CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS,
  CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS,
} from "../CodexDeveloperInstructions.ts";
import { codexSessionAppServerArgs } from "./codexLaunchArgs.ts";
import {
  buildTurnStartParams,
  hasConfiguredMcpServer,
  isRecoverableThreadResumeError,
  makeCodexSessionRuntime,
  openCodexThread,
} from "./CodexSessionRuntime.ts";
const isCodexAppServerRequestError = Schema.is(CodexErrors.CodexAppServerRequestError);
const decodeUnknownJson = Schema.decodeUnknownSync(Schema.UnknownFromJsonString);
const decodeLoggedRequest = Schema.decodeUnknownSync(
  Schema.Struct({ method: Schema.String, params: Schema.Unknown }),
);

function quoteShellArgument(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

describe("CodexSessionRuntimeIdentifierGenerationError", () => {
  it("retains identifier purpose and the random source failure", () => {
    const cause = new Error("random source unavailable");
    const error = new CodexErrors.CodexAppServerIdentifierGenerationError({
      purpose: "provider-event",
      cause,
    });

    NodeAssert.equal(error.purpose, "provider-event");
    NodeAssert.strictEqual(error.cause, cause);
    NodeAssert.equal(
      error.message,
      "Failed to generate Codex App Server identifier for provider-event.",
    );
  });
});

function makeThreadOpenResponse(
  threadId: string,
): CodexRpc.ClientRequestResponsesByMethod["thread/start"] {
  return {
    cwd: "/tmp/project",
    model: "gpt-5.3-codex",
    modelProvider: "openai",
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: { type: "danger-full-access" },
    thread: {
      id: threadId,
      createdAt: "2026-04-18T00:00:00.000Z",
      source: { session: "cli" },
      turns: [],
      status: {
        state: "idle",
        activeFlags: [],
      },
    },
  } as unknown as CodexRpc.ClientRequestResponsesByMethod["thread/start"];
}

describe("buildTurnStartParams", () => {
  it("keeps invalid turn values only in the schema cause", () => {
    const secret = "codex-turn-input-secret-sentinel";
    const error = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "full-access",
        attachments: [
          {
            type: "image",
            url: { secret } as unknown as string,
          },
        ],
      }).pipe(Effect.flip),
    );
    const { cause, ...directDiagnostics } = error;

    NodeAssert.equal(error.operation, "decode-request-payload");
    NodeAssert.equal(error.method, "turn/start");
    NodeAssert.ok((error.issueCount ?? 0) > 0);
    NodeAssert.ok(error.issueKinds?.includes("Pointer"));
    NodeAssert.ok((error.maximumPathDepth ?? 0) > 0);
    NodeAssert.ok(Schema.isSchemaError(cause));
    NodeAssert.doesNotMatch(error.message, new RegExp(secret));
    NodeAssert.doesNotMatch(JSON.stringify(directDiagnostics), new RegExp(secret));
  });

  it("includes plan collaboration mode when requested", () => {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "full-access",
        prompt: "Make a plan",
        model: "gpt-5.3-codex",
        effort: "medium",
        interactionMode: "plan",
      }),
    );

    NodeAssert.deepStrictEqual(params, {
      threadId: "provider-thread-1",
      approvalPolicy: "never",
      sandboxPolicy: {
        type: "dangerFullAccess",
      },
      input: [
        {
          type: "text",
          text: "Make a plan",
        },
      ],
      model: "gpt-5.3-codex",
      effort: "medium",
      collaborationMode: {
        mode: "plan",
        settings: {
          model: "gpt-5.3-codex",
          reasoning_effort: "medium",
          developer_instructions: buildCodexDeveloperInstructions("plan", {
            model: "gpt-5.3-codex",
            reasoningEffort: "medium",
          }),
        },
      },
    });
  });

  it("includes default collaboration mode and image attachments", () => {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "auto-accept-edits",
        prompt: "Implement it",
        model: "gpt-5.3-codex",
        interactionMode: "default",
        attachments: [
          {
            type: "image",
            url: "data:image/png;base64,abc",
          },
        ],
      }),
    );

    NodeAssert.deepStrictEqual(params, {
      threadId: "provider-thread-1",
      approvalPolicy: "on-request",
      sandboxPolicy: {
        type: "workspaceWrite",
      },
      input: [
        {
          type: "text",
          text: "Implement it",
        },
        {
          type: "image",
          url: "data:image/png;base64,abc",
        },
      ],
      model: "gpt-5.3-codex",
      collaborationMode: {
        mode: "default",
        settings: {
          model: "gpt-5.3-codex",
          reasoning_effort: "medium",
          developer_instructions: buildCodexDeveloperInstructions("default", {
            model: "gpt-5.3-codex",
            reasoningEffort: "medium",
          }),
        },
      },
    });
  });

  it("reports the same fallback model and effort in settings and instructions", () => {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "full-access",
        prompt: "Go",
        interactionMode: "default",
      }),
    );

    const settings = params.collaborationMode?.settings;
    NodeAssert.equal(settings?.model, DEFAULT_MODEL);
    NodeAssert.equal(settings?.reasoning_effort, "medium");
    NodeAssert.ok(settings?.developer_instructions?.includes(`as ${DEFAULT_MODEL} with medium`));
  });

  it("omits collaboration mode when interaction mode is absent", () => {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "approval-required",
        prompt: "Review",
      }),
    );

    NodeAssert.deepStrictEqual(params, {
      threadId: "provider-thread-1",
      approvalPolicy: "untrusted",
      sandboxPolicy: {
        type: "readOnly",
      },
      input: [
        {
          type: "text",
          text: "Review",
        },
      ],
    });
  });
});

describe("buildCodexDeveloperInstructions", () => {
  it("appends runtime info after the mode instructions", () => {
    const instructions = buildCodexDeveloperInstructions("default", {
      model: "gpt-5.3-codex",
      reasoningEffort: "high",
    });

    NodeAssert.ok(instructions.startsWith(CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS));
    NodeAssert.match(instructions, /T3 Code/);
    NodeAssert.match(instructions, /Codex harness/);
    NodeAssert.match(instructions, /as gpt-5\.3-codex with high reasoning effort/);
  });

  it("includes runtime info alongside plan mode instructions", () => {
    const instructions = buildCodexDeveloperInstructions("plan", {
      model: "gpt-5.3-codex",
      reasoningEffort: "medium",
    });

    NodeAssert.ok(instructions.startsWith(CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS));
    NodeAssert.match(instructions, /as gpt-5\.3-codex with medium reasoning effort/);
  });

  it("varies with the model and effort of each turn", () => {
    const first = buildCodexDeveloperInstructions("default", {
      model: "gpt-5.3-codex",
      reasoningEffort: "medium",
    });
    const second = buildCodexDeveloperInstructions("default", {
      model: "gpt-5.4",
      reasoningEffort: "high",
    });

    NodeAssert.notEqual(first, second);
  });

  it("flattens multiline metadata into single-line runtime info", () => {
    const instructions = buildCodexDeveloperInstructions("default", {
      model: "gpt\n5.3\ncodex",
      reasoningEffort: " high\neffort ",
    });

    NodeAssert.match(instructions, /as gpt 5\.3 codex with high effort reasoning effort/);
    NodeAssert.doesNotMatch(instructions, /<runtime_info>[^<]*\n/);
  });
});

describe("T3 browser developer instructions", () => {
  it("prefers the product-native preview tools in both collaboration modes", () => {
    for (const instructions of [
      CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS,
      CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS,
    ]) {
      NodeAssert.match(instructions, /t3-code/);
      NodeAssert.match(instructions, /preview_status/);
      NodeAssert.match(instructions, /preview_open/);
      NodeAssert.match(instructions, /Do not switch to global browser skills/);
    }
  });
});

describe("hasConfiguredMcpServer", () => {
  it("detects inline Codex MCP configuration arguments", () => {
    NodeAssert.equal(hasConfiguredMcpServer(undefined), false);
    NodeAssert.equal(hasConfiguredMcpServer(["--model", "gpt-5.4"]), false);
    NodeAssert.equal(
      hasConfiguredMcpServer(["-c", 'mcp_servers.t3-code.url="http://127.0.0.1/mcp"']),
      true,
    );
  });
});

describe("codexSessionAppServerArgs", () => {
  it("keeps the app-server subcommand when explicit args are provided", () => {
    NodeAssert.deepStrictEqual(codexSessionAppServerArgs(["-c", "model=gpt-5"], undefined), [
      "app-server",
      "-c",
      "model=gpt-5",
    ]);
  });

  it("keeps launch args when explicit app-server args are provided", () => {
    NodeAssert.deepStrictEqual(
      codexSessionAppServerArgs(
        ["-c", "mcp_servers.t3-code.url=http://127.0.0.1/mcp"],
        "--strict-config --enable foo",
      ),
      [
        "app-server",
        "--strict-config",
        "--enable",
        "foo",
        "-c",
        "mcp_servers.t3-code.url=http://127.0.0.1/mcp",
      ],
    );
  });
});

describe("isRecoverableThreadResumeError", () => {
  it("matches missing thread errors", () => {
    NodeAssert.equal(
      isRecoverableThreadResumeError(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage: "Thread does not exist",
        }),
      ),
      true,
    );
  });

  it("ignores non-recoverable resume errors", () => {
    NodeAssert.equal(
      isRecoverableThreadResumeError(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage: "Permission denied",
        }),
      ),
      false,
    );
  });

  it("ignores unrelated missing-resource errors that do not mention threads", () => {
    NodeAssert.equal(
      isRecoverableThreadResumeError(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage: "Config file not found",
        }),
      ),
      false,
    );
    NodeAssert.equal(
      isRecoverableThreadResumeError(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage: "Model does not exist",
        }),
      ),
      false,
    );
  });
});

describe("openCodexThread", () => {
  it.effect("falls back to thread/start when resume fails recoverably", () =>
    Effect.gen(function* () {
      const calls: Array<{ method: "thread/start" | "thread/resume"; payload: unknown }> = [];
      const started = makeThreadOpenResponse("fresh-thread");
      const client = {
        request: <M extends "thread/start" | "thread/resume">(
          method: M,
          payload: CodexRpc.ClientRequestParamsByMethod[M],
        ) => {
          calls.push({ method, payload });
          if (method === "thread/resume") {
            return Effect.fail(
              new CodexErrors.CodexAppServerRequestError({
                code: -32603,
                errorMessage: "thread not found",
              }),
            );
          }
          return Effect.succeed(started as CodexRpc.ClientRequestResponsesByMethod[M]);
        },
      };

      const opened = yield* openCodexThread({
        client,
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "full-access",
        cwd: "/tmp/project",
        requestedModel: "gpt-5.3-codex",
        serviceTier: undefined,
        resumeThreadId: "stale-thread",
      });

      NodeAssert.equal(opened.thread.id, "fresh-thread");
      NodeAssert.deepStrictEqual(
        calls.map((call) => call.method),
        ["thread/resume", "thread/start"],
      );
    }),
  );

  it.effect("propagates non-recoverable resume failures", () =>
    Effect.gen(function* () {
      const client = {
        request: <M extends "thread/start" | "thread/resume">(
          method: M,
          _payload: CodexRpc.ClientRequestParamsByMethod[M],
        ) => {
          if (method === "thread/resume") {
            return Effect.fail(
              new CodexErrors.CodexAppServerRequestError({
                code: -32603,
                errorMessage: "timed out waiting for server",
              }),
            );
          }
          return Effect.succeed(
            makeThreadOpenResponse("fresh-thread") as CodexRpc.ClientRequestResponsesByMethod[M],
          );
        },
      };

      const error = yield* openCodexThread({
        client,
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "full-access",
        cwd: "/tmp/project",
        requestedModel: "gpt-5.3-codex",
        serviceTier: undefined,
        resumeThreadId: "stale-thread",
      }).pipe(Effect.flip);

      NodeAssert.ok(isCodexAppServerRequestError(error));
      NodeAssert.equal(error.errorMessage, "timed out waiting for server");
    }),
  );
});

it.layer(NodeServices.layer)("CodexSessionRuntime turns", (it) => {
  const makeHarness = Effect.fn("makeCodexSessionRuntimeTestHarness")(function* (
    scenario = "steer-success",
  ) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const tempDir = yield* fileSystem.makeTempDirectoryScoped({
      directory: NodeOS.tmpdir(),
      prefix: "codex-session-runtime-",
    });
    const requestLogPath = path.join(tempDir, "requests.jsonl");
    const wrapperPath = path.join(tempDir, "codex-mock.sh");
    const mockPeerPath = yield* path.fromFileUrl(
      new URL("../../../scripts/codex-session-runtime-mock-peer.ts", import.meta.url),
    );
    yield* fileSystem.writeFileString(
      wrapperPath,
      `#!/bin/sh\nexec ${quoteShellArgument(process.execPath)} ${quoteShellArgument(mockPeerPath)} "$@"\n`,
    );
    yield* fileSystem.chmod(wrapperPath, 0o755);

    const runtime = yield* makeCodexSessionRuntime({
      threadId: ThreadId.make("thread-1"),
      binaryPath: wrapperPath,
      cwd: tempDir,
      runtimeMode: "full-access",
      environment: {
        ...process.env,
        T3_CODEX_RUNTIME_REQUEST_LOG_PATH: requestLogPath,
        T3_CODEX_RUNTIME_SCENARIO: scenario,
      },
    });
    yield* runtime.start();

    return {
      runtime,
      readRequests: fileSystem.readFileString(requestLogPath).pipe(
        Effect.map((content) =>
          content
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => decodeLoggedRequest(decodeUnknownJson(line))),
        ),
      ),
    };
  });

  it.effect("uses the last started turn id after a normal turn start", () =>
    Effect.gen(function* () {
      const { runtime, readRequests } = yield* makeHarness();
      yield* runtime.sendTurn({ input: "start" });
      yield* runtime.interruptTurn();

      const requests = yield* readRequests;
      NodeAssert.deepStrictEqual(requests.at(-1), {
        method: "turn/interrupt",
        params: { threadId: "provider-thread-1", turnId: "started-turn-1" },
      });
      yield* runtime.close;
    }),
  );

  it.effect("keeps nested sub-agent activity on the root turn", () =>
    Effect.gen(function* () {
      const { runtime } = yield* makeHarness("sub-agent-activity");
      const eventsFiber = yield* runtime.events.pipe(
        Stream.filter((event) => event.kind === "notification"),
        Stream.take(6),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* runtime.sendTurn({ input: "start" });
      const events = Array.from(yield* Fiber.join(eventsFiber));

      NodeAssert.deepStrictEqual(
        events.map((event) => [event.method, event.turnId]),
        [
          ["turn/started", TurnId.make("started-turn-1")],
          ["item/started", TurnId.make("started-turn-1")],
          ["item/started", TurnId.make("started-turn-1")],
          ["turn/diff/updated", TurnId.make("started-turn-1")],
          ["turn/diff/updated", TurnId.make("started-turn-1")],
          ["turn/diff/updated", TurnId.make("started-turn-1")],
        ],
      );
      NodeAssert.equal((yield* runtime.getSession).activeTurnId, TurnId.make("started-turn-1"));
      yield* runtime.close;
    }),
  );

  it.effect("does not map non-starting sub-agent activity", () =>
    Effect.gen(function* () {
      const { runtime } = yield* makeHarness("non-starting-sub-agent-activity");
      const eventsFiber = yield* runtime.events.pipe(
        Stream.filter((event) => event.kind === "notification"),
        Stream.take(5),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* runtime.sendTurn({ input: "start" });
      const events = Array.from(yield* Fiber.join(eventsFiber));

      NodeAssert.deepStrictEqual(
        events.map((event) => [event.method, event.turnId]),
        [
          ["turn/started", TurnId.make("started-turn-1")],
          ["item/started", TurnId.make("started-turn-1")],
          ["turn/started", TurnId.make("interacted-turn-1")],
          ["item/started", TurnId.make("started-turn-1")],
          ["turn/started", TurnId.make("interrupted-turn-1")],
        ],
      );
      yield* runtime.close;
    }),
  );

  it.effect("steers into the confirmed active turn", () =>
    Effect.gen(function* () {
      const { runtime, readRequests } = yield* makeHarness();
      const first = yield* runtime.sendTurn({ input: "start" });
      const second = yield* runtime.sendTurn({ input: "mid-turn input" });

      NodeAssert.equal(first.turnId, TurnId.make("started-turn-1"));
      NodeAssert.equal(first.steeredIntoActiveTurn, undefined);
      NodeAssert.equal(second.turnId, TurnId.make("started-turn-1"));
      NodeAssert.equal(second.steeredIntoActiveTurn, true);
      NodeAssert.equal((yield* runtime.getSession).activeTurnId, TurnId.make("started-turn-1"));

      const requests = yield* readRequests;
      NodeAssert.deepStrictEqual(
        requests.map((request) => request.method),
        ["turn/start", "turn/steer"],
      );
      NodeAssert.deepStrictEqual(requests[1], {
        method: "turn/steer",
        params: {
          threadId: "provider-thread-1",
          expectedTurnId: "started-turn-1",
          input: [{ type: "text", text: "mid-turn input" }],
        },
      });
      yield* runtime.close;
    }),
  );

  it.effect("keeps the confirmed id when an older app-server absorbs turn/start", () =>
    Effect.gen(function* () {
      const { runtime, readRequests } = yield* makeHarness("steer-unsupported");
      yield* runtime.sendTurn({ input: "start" });
      const result = yield* runtime.sendTurn({ input: "fallback input" });

      NodeAssert.equal(result.turnId, TurnId.make("started-turn-1"));
      NodeAssert.equal(result.steeredIntoActiveTurn, true);
      NodeAssert.equal((yield* runtime.getSession).activeTurnId, TurnId.make("started-turn-1"));
      NodeAssert.deepStrictEqual(
        (yield* readRequests).map((request) => request.method),
        ["turn/start", "turn/steer", "turn/start"],
      );
      yield* runtime.close;
    }),
  );

  it.effect("never promotes an unsupported fallback response without turn/started", () =>
    Effect.gen(function* () {
      const { runtime, readRequests } = yield* makeHarness("steer-unsupported-completed");
      yield* runtime.sendTurn({ input: "start" });
      const result = yield* runtime.sendTurn({ input: "fallback near completion" });

      NodeAssert.equal(result.turnId, TurnId.make("started-turn-1"));
      NodeAssert.equal(result.steeredIntoActiveTurn, true);
      NodeAssert.equal((yield* runtime.getSession).activeTurnId, undefined);
      NodeAssert.deepStrictEqual(
        (yield* readRequests).map((request) => request.method),
        ["turn/start", "turn/steer", "turn/start"],
      );
      yield* runtime.close;
    }),
  );

  it.effect("starts fresh when the active turn ended before the steer response", () =>
    Effect.gen(function* () {
      const { runtime, readRequests } = yield* makeHarness("steer-no-active");
      yield* runtime.sendTurn({ input: "start" });
      const result = yield* runtime.sendTurn({ input: "fresh input" });

      NodeAssert.equal(result.turnId, TurnId.make("fresh-turn-2"));
      NodeAssert.equal(result.steeredIntoActiveTurn, undefined);
      NodeAssert.equal((yield* runtime.getSession).activeTurnId, TurnId.make("fresh-turn-2"));
      NodeAssert.deepStrictEqual(
        (yield* readRequests).map((request) => request.method),
        ["turn/start", "turn/steer", "turn/start"],
      );
      yield* runtime.close;
    }),
  );

  it.effect("does not start a phantom turn when another active id is reported", () =>
    Effect.gen(function* () {
      const { runtime, readRequests } = yield* makeHarness("steer-different-active");
      yield* runtime.sendTurn({ input: "start" });
      const error = yield* runtime.sendTurn({ input: "do not replay" }).pipe(Effect.flip);

      NodeAssert.ok(isCodexAppServerRequestError(error));
      NodeAssert.match(error.errorMessage, /but found `different-turn`/);
      NodeAssert.deepStrictEqual(
        (yield* readRequests).map((request) => request.method),
        ["turn/start", "turn/steer"],
      );
      yield* runtime.close;
    }),
  );
});
