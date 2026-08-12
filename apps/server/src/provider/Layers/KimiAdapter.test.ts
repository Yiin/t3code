// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeFSP from "node:fs/promises";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { KimiSettings, ProviderDriverKind, ThreadId } from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import {
  readAcpProviderSessionsCreated,
  readAcpSessionSetupMethods,
  readAcpTurnTargets,
} from "../testUtils/acpSessionLifecycleProbes.ts";
import { describeSessionLifecycleConformance } from "../testUtils/sessionLifecycleConformance.ts";
import { KIMI_ADAPTER_CAPABILITIES, makeKimiAdapter } from "./KimiAdapter.ts";

const decodeKimiSettings = Schema.decodeSync(KimiSettings);

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");
const mockAgentCommand = process.execPath;

async function makeMockKimiWrapper(extraEnv?: Record<string, string>) {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "kimi-acp-mock-"));
  const wrapperPath = NodePath.join(dir, "fake-kimi.sh");
  const envExports = Object.entries(extraEnv ?? {})
    .map(([key, value]) => `export ${key}=${JSON.stringify(value)}`)
    .join("\n");
  const script = `#!/bin/sh
${envExports}
exec ${JSON.stringify(mockAgentCommand)} ${JSON.stringify(mockAgentPath)} "$@"
`;
  await NodeFSP.writeFile(wrapperPath, script, "utf8");
  await NodeFSP.chmod(wrapperPath, 0o755);
  return wrapperPath;
}

function waitForFileContent(
  filePath: string,
  expectedContent: string,
  attempts = 80,
): Effect.Effect<string> {
  const readAttempt = (remainingAttempts: number): Effect.Effect<string> =>
    Effect.gen(function* () {
      if (remainingAttempts <= 0) {
        return yield* Effect.die(new Error(`Timed out waiting for file content at ${filePath}`));
      }
      const raw = yield* Effect.tryPromise(() => NodeFSP.readFile(filePath, "utf8")).pipe(
        Effect.orElseSucceed(() => ""),
      );
      if (raw.includes(expectedContent)) {
        return raw;
      }
      yield* Effect.sleep("25 millis");
      return yield* readAttempt(remainingAttempts - 1);
    });
  return readAttempt(attempts);
}

async function readJsonLines(filePath: string) {
  const raw = await NodeFSP.readFile(filePath, "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const kimiAdapterTestLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-kimi-adapter-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

const makeTestAdapter = (binaryPath: string) =>
  makeKimiAdapter(decodeKimiSettings({ binaryPath })).pipe(Effect.orDie);

const readPromptBlocks = (requestLogPath: string) =>
  Effect.gen(function* () {
    yield* waitForFileContent(requestLogPath, "session/prompt");
    const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
    const promptRequest = requests.find((entry) => entry.method === "session/prompt");
    return (promptRequest?.params as { prompt?: ReadonlyArray<unknown> } | undefined)?.prompt;
  });

it.layer(kimiAdapterTestLayer)("KimiAdapterLive", (it) => {
  it.effect("sends an image inline and links a file when embedded context is unavailable", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("kimi-attachment-prompt-parts");
      const serverConfig = yield* ServerConfig;
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "kimi-acp-attachment-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockKimiWrapper({ T3_ACP_REQUEST_LOG_PATH: requestLogPath }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      const imageBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
      const fileText = "kimi attachment body";
      const filePath = NodePath.join(serverConfig.attachmentsDir, "kimi-file-1.txt");
      yield* Effect.promise(() => NodeFSP.mkdir(serverConfig.attachmentsDir, { recursive: true }));
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          NodePath.join(serverConfig.attachmentsDir, "kimi-image-1.png"),
          imageBytes,
        ),
      );
      yield* Effect.promise(() => NodeFSP.writeFile(filePath, fileText, "utf8"));

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("kimi"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId,
        input: "look at both attachments",
        attachments: [
          {
            type: "image",
            id: "kimi-image-1",
            name: "shot.png",
            mimeType: "image/png",
            sizeBytes: imageBytes.byteLength,
          },
          {
            type: "file",
            id: "kimi-file-1",
            name: "notes.txt",
            mimeType: "text/plain",
            sizeBytes: fileText.length,
          },
        ],
      });

      assert.deepEqual(yield* readPromptBlocks(requestLogPath), [
        { type: "text", text: "look at both attachments" },
        { type: "image", data: Buffer.from(imageBytes).toString("base64"), mimeType: "image/png" },
        {
          type: "resource_link",
          name: "notes.txt",
          uri: NodeURL.pathToFileURL(filePath).href,
          mimeType: "text/plain",
          size: fileText.length,
        },
      ]);

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("embeds a file as a resource when the agent advertises embedded context", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("kimi-attachment-embedded-resource");
      const serverConfig = yield* ServerConfig;
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "kimi-acp-embedded-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockKimiWrapper({
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
          T3_ACP_ADVERTISE_EMBEDDED_CONTEXT: "1",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      const fileText = "kimi embedded body";
      const filePath = NodePath.join(serverConfig.attachmentsDir, "kimi-file-2.txt");
      yield* Effect.promise(() => NodeFSP.mkdir(serverConfig.attachmentsDir, { recursive: true }));
      yield* Effect.promise(() => NodeFSP.writeFile(filePath, fileText, "utf8"));

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("kimi"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId,
        input: "read the note",
        attachments: [
          {
            type: "file",
            id: "kimi-file-2",
            name: "notes.txt",
            mimeType: "text/plain",
            sizeBytes: fileText.length,
          },
        ],
      });

      assert.deepEqual(yield* readPromptBlocks(requestLogPath), [
        { type: "text", text: "read the note" },
        {
          type: "resource",
          resource: {
            uri: NodeURL.pathToFileURL(filePath).href,
            mimeType: "text/plain",
            text: fileText,
          },
        },
      ]);

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("fails the turn when an attachment file is missing", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("kimi-attachment-missing-file");
      const wrapperPath = yield* Effect.promise(() => makeMockKimiWrapper());
      const adapter = yield* makeTestAdapter(wrapperPath);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("kimi"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const error = yield* Effect.flip(
        adapter.sendTurn({
          threadId,
          input: "read the missing note",
          attachments: [
            {
              type: "file",
              id: "kimi-file-missing",
              name: "notes.txt",
              mimeType: "text/plain",
              sizeBytes: 4,
            },
          ],
        }),
      );

      assert.equal(error._tag, "ProviderAdapterRequestError");

      yield* adapter.stopSession(threadId);
    }),
  );

  const makeLoggedAdapter = (extraEnv?: Record<string, string>) =>
    Effect.gen(function* () {
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "kimi-acp-origin-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockKimiWrapper({ T3_ACP_REQUEST_LOG_PATH: requestLogPath, ...extraEnv }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      return { adapter, requestLogPath };
    });

  it.effect("reports sessionOrigin started for a session with no cursor", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("kimi-origin-fresh");
      const { adapter, requestLogPath } = yield* makeLoggedAdapter();

      const session = yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("kimi"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      assert.equal(session.sessionOrigin, "started");
      assert.deepStrictEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: "mock-session-1",
      });
      assert.deepStrictEqual(yield* readAcpSessionSetupMethods(requestLogPath), ["session/new"]);

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("loads the session a cursor names and reports sessionOrigin resumed", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("kimi-origin-resumed");
      const { adapter, requestLogPath } = yield* makeLoggedAdapter();

      const session = yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("kimi"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        resumeCursor: { schemaVersion: 1, sessionId: "mock-session-1" },
      });

      assert.equal(session.sessionOrigin, "resumed");
      assert.deepStrictEqual(yield* readAcpSessionSetupMethods(requestLogPath), ["session/load"]);

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("ignores a wrong-schemaVersion cursor and reports sessionOrigin started", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("kimi-origin-foreign-cursor");
      const { adapter, requestLogPath } = yield* makeLoggedAdapter();

      const session = yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("kimi"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        resumeCursor: { schemaVersion: 99, sessionId: "mock-session-1" },
      });

      assert.equal(session.sessionOrigin, "started");
      assert.deepStrictEqual(yield* readAcpSessionSetupMethods(requestLogPath), ["session/new"]);

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("refuses a resume when the agent does not advertise loadSession", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("kimi-origin-no-load-session");
      const { adapter, requestLogPath } = yield* makeLoggedAdapter({
        T3_ACP_OMIT_LOAD_SESSION_CAPABILITY: "1",
      });

      const error = yield* Effect.flip(
        adapter.startSession({
          threadId,
          provider: ProviderDriverKind.make("kimi"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
          resumeCursor: { schemaVersion: 1, sessionId: "mock-session-1" },
        }),
      );

      assert.equal(error._tag, "ProviderAdapterResumeError");
      // The refusal must not fall back to a fresh session behind the caller's
      // back: a resumed epic worker would lose the turn it was continuing.
      assert.deepStrictEqual(yield* readAcpSessionSetupMethods(requestLogPath), []);
    }),
  );

  describeSessionLifecycleConformance(it, {
    name: "Kimi",
    provider: ProviderDriverKind.make("kimi"),
    capabilities: KIMI_ADAPTER_CAPABILITIES,
    observes: { turnTargets: true },
    runScenario: (body) =>
      Effect.gen(function* () {
        const tempDir = yield* Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "kimi-acp-lifecycle-")),
        );
        const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
        const wrapperPath = yield* Effect.promise(() =>
          makeMockKimiWrapper({ T3_ACP_REQUEST_LOG_PATH: requestLogPath }),
        );
        const adapter = yield* makeTestAdapter(wrapperPath);
        return yield* body({
          adapter,
          // The mock agent always names its session `mock-session-1`, so this
          // is the cursor a real Kimi session would have persisted.
          makeValidCursor: () => ({ schemaVersion: 1, sessionId: "mock-session-1" }),
          makeForeignCursor: () => ({ schemaVersion: 99, sessionId: "mock-session-1" }),
          readProviderSessionsCreated: () => readAcpProviderSessionsCreated(requestLogPath),
          readTurnTargets: () => readAcpTurnTargets(requestLogPath),
          resumedProviderSessionId: "mock-session-1",
          startSessionInput: { cwd: process.cwd() },
          // The mock agent loads any session id it is handed, so it cannot
          // stage a cursor that names a conversation the agent has lost.
        });
      }),
  });
});
