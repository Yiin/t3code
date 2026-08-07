// @effect-diagnostics nodeBuiltinImport:off - CLI integration exercises Node HTTP and filesystem boundaries.
import * as NodeHttp from "node:http";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  EnvironmentOrchestrationHttpApi,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as NetService from "@t3tools/shared/Net";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as CliError from "effect/unstable/cli/CliError";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/unstable/cli";

import { cli, makeCli } from "./fullCli.ts";
import * as ServerConfig from "./config.ts";
import * as ProjectionSnapshotQuery from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import * as OrchestrationEngine from "./orchestration/Services/OrchestrationEngine.ts";
import { OrchestrationLayerLive } from "./orchestration/runtimeLayer.ts";
import { orchestrationHttpApiLayer } from "./orchestration/http.ts";
import { layerConfig as SqlitePersistenceLayerLive } from "./persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "./project/RepositoryIdentityResolver.ts";
import {
  makePersistedServerRuntimeState,
  persistServerRuntimeState,
} from "./serverRuntimeState.ts";
import * as WorkspacePaths from "./workspace/WorkspacePaths.ts";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import { environmentAuthenticatedAuthLayer } from "./auth/http.ts";

const CliRuntimeLayer = Layer.mergeAll(NodeServices.layer, NetService.layer);
class ProjectCliHttpApi extends HttpApi.make("environment").add(EnvironmentOrchestrationHttpApi) {}

const connectCli = makeCli({ cloudEnabled: true });
const noConnectCli = makeCli({ cloudEnabled: false });
const runCli = (args: ReadonlyArray<string>, command = cli) =>
  Command.runWith(command, { version: "0.0.0" })(args);
const runConnectCli = (args: ReadonlyArray<string>) => runCli(args, connectCli);
const runCliWithRuntime = (args: ReadonlyArray<string>) =>
  runCli(args).pipe(Effect.provide(CliRuntimeLayer));

const captureStdout = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const result = yield* effect;
    const output =
      (yield* TestConsole.logLines).findLast((line): line is string => typeof line === "string") ??
      "";
    return { result, output };
  }).pipe(Effect.provide(Layer.mergeAll(CliRuntimeLayer, TestConsole.layer)));

const makeCliTestServerConfig = (baseDir: string) =>
  Effect.gen(function* () {
    const derivedPaths = yield* ServerConfig.deriveServerPaths(baseDir, undefined);
    return {
      logLevel: "Info",
      traceMinLevel: "Info",
      traceTimingEnabled: true,
      traceBatchWindowMs: 200,
      traceMaxBytes: 10 * 1024 * 1024,
      traceMaxFiles: 10,
      otlpTracesUrl: undefined,
      otlpMetricsUrl: undefined,
      otlpExportIntervalMs: 10_000,
      otlpServiceName: "t3-server",
      mode: "web",
      port: 0,
      host: "127.0.0.1",
      cwd: process.cwd(),
      baseDir,
      ...derivedPaths,
      staticDir: undefined,
      devUrl: undefined,
      noBrowser: true,
      startupPresentation: "browser",
      desktopBootstrapToken: undefined,
      autoBootstrapProjectFromCwd: false,
      logWebSocketEvents: false,
      tailscaleServeEnabled: false,
      tailscaleServePort: 443,
    } satisfies ServerConfig.ServerConfig["Service"];
  });

const makeProjectPersistenceLayer = (config: ServerConfig.ServerConfig["Service"]) =>
  Layer.mergeAll(
    OrchestrationLayerLive.pipe(
      Layer.provideMerge(RepositoryIdentityResolver.layer),
      Layer.provideMerge(SqlitePersistenceLayerLive),
    ),
    WorkspacePaths.layer,
  ).pipe(Layer.provideMerge(NodeServices.layer), Layer.provide(ServerConfig.layer(config)));

const readPersistedSnapshot = (baseDir: string) =>
  Effect.gen(function* () {
    const config = yield* makeCliTestServerConfig(baseDir);
    return yield* Effect.gen(function* () {
      const projectionSnapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
      return yield* projectionSnapshotQuery.getSnapshot();
    }).pipe(Effect.provide(makeProjectPersistenceLayer(config)));
  });

const readPersistedShellSnapshot = (baseDir: string) =>
  Effect.gen(function* () {
    const config = yield* makeCliTestServerConfig(baseDir);
    return yield* Effect.gen(function* () {
      const projectionSnapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
      return yield* projectionSnapshotQuery.getShellSnapshot();
    }).pipe(Effect.provide(makeProjectPersistenceLayer(config)));
  });

const withLiveProjectCliServer = <A, E, R>(baseDir: string, run: () => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const config = yield* makeCliTestServerConfig(baseDir);
    const routesLayer = HttpApiBuilder.layer(ProjectCliHttpApi).pipe(
      Layer.provide(orchestrationHttpApiLayer),
      Layer.provide(environmentAuthenticatedAuthLayer),
    );
    const appLayer = HttpRouter.serve(routesLayer, {
      disableListenLog: true,
      disableLogger: true,
    }).pipe(
      Layer.provideMerge(
        EnvironmentAuth.layer.pipe(
          Layer.provideMerge(SqlitePersistenceLayerLive),
          Layer.provide(ServerSecretStore.layer),
        ),
      ),
      Layer.provideMerge(makeProjectPersistenceLayer(config)),
      Layer.provideMerge(
        NodeHttpServer.layer(NodeHttp.createServer, {
          host: "127.0.0.1",
          port: 0,
        }),
      ),
      Layer.provideMerge(NodeServices.layer),
      Layer.provide(ServerConfig.layer(config)),
    );

    return yield* Effect.scoped(
      Effect.gen(function* () {
        const server = yield* HttpServer.HttpServer;
        const address = server.address;
        if (typeof address === "string" || !("port" in address)) {
          assert.fail(`Expected TCP address, got ${address}`);
        }
        yield* persistServerRuntimeState({
          path: config.serverRuntimeStatePath,
          state: yield* makePersistedServerRuntimeState({
            config,
            port: address.port,
          }),
        });
        return yield* run();
      }).pipe(Effect.provide(Layer.mergeAll(appLayer, NodeServices.layer))),
    );
  });

type RawEpicRequest = {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | undefined;
  readonly body: unknown;
};

const withRawEpicCliServer = <A, E, R>(input: {
  readonly baseDir: string;
  readonly snapshot: unknown;
  readonly requests: Array<RawEpicRequest>;
  readonly status: () => "running" | "done" | "failed" | "cancelled";
  readonly run: () => Effect.Effect<A, E, R>;
}) =>
  Effect.acquireUseRelease(
    Effect.promise(
      () =>
        new Promise<{ readonly server: NodeHttp.Server; readonly port: number }>(
          (resolve, reject) => {
            const server = NodeHttp.createServer((request, response) => {
              const chunks: Array<Buffer> = [];
              request.on("data", (chunk: Buffer) => chunks.push(chunk));
              request.on("end", () => {
                const raw = Buffer.concat(chunks).toString("utf8");
                const body = raw.length === 0 ? undefined : JSON.parse(raw);
                input.requests.push({
                  method: request.method ?? "",
                  url: request.url ?? "",
                  authorization: request.headers.authorization,
                  body,
                });
                const currentStatus = input.status();
                const run = {
                  runId: "run-cli-1",
                  epicId: "epic-cli",
                  projectId: "project-placeholder",
                  cwd: "/placeholder",
                  prompt: "go",
                  orientationFile: null,
                  modelSelection: { instanceId: "codex", model: "gpt-5" },
                  runtimeMode: "full-access",
                  originThreadId: null,
                  status: currentStatus,
                  maxIterations: 8,
                  iterationsDispatched: currentStatus === "running" ? 1 : 8,
                  iterationsCompleted: currentStatus === "running" ? 1 : 8,
                  currentThreadId: null,
                  currentTurnStartedAt: null,
                  consecutiveFailures: currentStatus === "failed" ? 1 : 0,
                  noCommitStreak: 0,
                  infraStreak: 0,
                  lastError: currentStatus === "failed" ? "iteration failed" : null,
                  createdAt: "2026-07-29T00:00:00.000Z",
                  updatedAt: "2026-07-29T00:00:01.000Z",
                  threadRefs: [],
                  recentIterations: [],
                };
                const payload =
                  request.url === "/api/orchestration/shell"
                    ? input.snapshot
                    : request.url === "/api/epic-runs" && request.method === "GET"
                      ? []
                      : request.url?.startsWith("/api/epic-runs")
                        ? {
                            ...run,
                            ...(body && typeof body === "object" ? body : {}),
                          }
                        : { code: "not_found" };
                response.statusCode = request.url?.startsWith("/api/") ? 200 : 404;
                response.setHeader("content-type", "application/json");
                response.end(JSON.stringify(payload));
              });
            });
            server.once("error", reject);
            server.listen(0, "127.0.0.1", () => {
              const address = server.address();
              if (!address || typeof address === "string") return reject(new Error("no port"));
              resolve({ server, port: address.port });
            });
          },
        ),
    ),
    ({ port }) =>
      Effect.gen(function* () {
        const config = yield* makeCliTestServerConfig(input.baseDir);
        yield* persistServerRuntimeState({
          path: config.serverRuntimeStatePath,
          state: yield* makePersistedServerRuntimeState({ config, port }),
        });
        return yield* input.run();
      }),
    ({ server }) =>
      Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
  );

it.layer(NodeServices.layer)("bin cli parsing", (it) => {
  it.effect("accepts the built-in lowercase log-level flag values", () =>
    runCliWithRuntime(["--log-level", "debug", "--version"]),
  );

  it.effect("accepts canonical --no-<flag> boolean negation", () =>
    runCliWithRuntime(["--no-log-websocket-events", "--version"]),
  );

  it.effect("rejects invalid log-level casing before launching the server", () =>
    Effect.gen(function* () {
      const error = yield* runCliWithRuntime(["--log-level", "Debug"]).pipe(Effect.flip);

      if (!CliError.isCliError(error)) {
        assert.fail(`Expected CliError, got ${String(error)}`);
      }
      if (error._tag !== "InvalidValue") {
        assert.fail(`Expected InvalidValue, got ${error._tag}`);
      }
      assert.equal(error.option, "log-level");
      assert.equal(error.value, "Debug");
    }),
  );

  it.effect("rejects connect commands when public configuration is missing", () =>
    Effect.gen(function* () {
      const error = yield* runCli(["connect", "status"], noConnectCli).pipe(Effect.flip);

      if (!CliError.isCliError(error)) {
        assert.fail(`Expected CliError, got ${String(error)}`);
      }
      if (error._tag !== "ShowHelp") {
        assert.fail(`Expected ShowHelp, got ${error._tag}`);
      }
      assert.deepEqual(error.commandPath, ["t3", "connect"]);
      assert.include(error.errors[0]?.message ?? "", "missing T3 Connect public configuration");

      const output = (yield* TestConsole.errorLines).join("\n");
      assert.include(output, "ERROR");
      assert.include(output, "missing T3 Connect public configuration");
    }).pipe(Effect.provide(Layer.mergeAll(CliRuntimeLayer, TestConsole.layer))),
  );

  it.effect("exposes service lifecycle commands without T3 Connect configuration", () =>
    Effect.gen(function* () {
      const { output } = yield* captureStdout(runCli(["service", "--help"], noConnectCli));

      assert.include(output, "Manage the T3 Code background service.");
      assert.include(output, "install");
      assert.include(output, "uninstall");
      assert.include(output, "update");
      assert.include(output, "status");
    }),
  );

  it.effect("exposes the complete epic command surface and start flags", () =>
    Effect.gen(function* () {
      const { output: epicHelp } = yield* captureStdout(runCli(["epic", "--help"]));
      for (const command of ["start", "list", "status", "pause", "resume", "cancel", "watch"]) {
        assert.include(epicHelp, command);
      }

      const { output: startHelp } = yield* captureStdout(runCli(["epic", "start", "--help"]));
      for (const flag of [
        "--cwd",
        "--epic",
        "--prompt-file",
        "--prompt",
        "--instance",
        "--model",
        "--max-iterations",
        "--json",
      ]) {
        assert.include(startHelp, flag);
      }
    }),
  );

  it.effect("reports a missing daemon through the parsed epic list command", () =>
    Effect.gen(function* () {
      const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-cli-epic-missing-"));
      const failure = yield* runCliWithRuntime([
        "epic",
        "list",
        "--base-dir",
        baseDir,
        "--json",
      ]).pipe(Effect.flip);
      assert.include(
        failure instanceof Error ? failure.message : String(failure),
        "systemctl --user start t3code.service",
      );
    }),
  );

  it.effect("clears an unreachable daemon runtime record", () =>
    Effect.gen(function* () {
      const baseDir = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3-cli-epic-unreachable-"),
      );
      const config = yield* makeCliTestServerConfig(baseDir);
      yield* persistServerRuntimeState({
        path: config.serverRuntimeStatePath,
        state: {
          version: 1,
          pid: 999_999,
          host: "127.0.0.1",
          port: 1,
          origin: "http://127.0.0.1:1",
          startedAt: "2026-07-29T00:00:00.000Z",
        },
      });
      yield* runCliWithRuntime(["epic", "list", "--base-dir", baseDir]).pipe(Effect.flip);
      assert.isFalse(NodeFS.existsSync(config.serverRuntimeStatePath));
    }),
  );

  it.effect("rejects non-positive epic iteration limits during CLI parsing", () =>
    Effect.gen(function* () {
      const failure = yield* runCliWithRuntime([
        "epic",
        "start",
        "--cwd",
        "/tmp",
        "--epic",
        "epic-1",
        "--prompt",
        "go",
        "--instance",
        "codex",
        "--model",
        "gpt-5",
        "--max-iterations",
        "0",
      ]).pipe(Effect.flip);
      assert.isTrue(CliError.isCliError(failure));
    }),
  );

  it.effect("requires exactly one epic prompt source before daemon discovery", () =>
    Effect.gen(function* () {
      const baseArgs = [
        "epic",
        "start",
        "--cwd",
        "/tmp",
        "--epic",
        "epic-1",
        "--instance",
        "codex",
        "--model",
        "gpt-5",
      ];
      for (const promptArgs of [[], ["--prompt", "go", "--prompt-file", "/tmp/prompt.txt"]]) {
        const failure = yield* runCliWithRuntime([...baseArgs, ...promptArgs]).pipe(Effect.flip);
        assert.include(
          failure instanceof Error ? failure.message : String(failure),
          "Exactly one of --prompt or --prompt-file is required",
        );
      }
    }),
  );

  it.effect("drives epic start, reads, controls, and watch through the live HTTP daemon", () =>
    Effect.gen(function* () {
      const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-cli-epic-live-"));
      const workspaceRoot = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3-cli-epic-workspace-"),
      );
      yield* runCliWithRuntime([
        "project",
        "add",
        workspaceRoot,
        "--title",
        "Epic Project",
        "--base-dir",
        baseDir,
      ]);
      // The epic CLI resolves its project from the shell snapshot, so the raw
      // stub below has to serve that shape — a full read model does not decode
      // as one (its threads carry no `hasPendingApprovals`).
      const snapshot = yield* readPersistedShellSnapshot(baseDir);
      const project = snapshot.projects.find(
        (candidate) => candidate.workspaceRoot === workspaceRoot,
      );
      assert.isDefined(project);
      const requests: Array<RawEpicRequest> = [];
      let status: "running" | "done" | "failed" | "cancelled" = "running";
      let watchPollsUntilDone: number | undefined;

      yield* withRawEpicCliServer({
        baseDir,
        snapshot,
        requests,
        status: () => {
          if (watchPollsUntilDone === undefined) return status;
          watchPollsUntilDone += 1;
          return watchPollsUntilDone >= 2 ? "done" : "running";
        },
        run: () =>
          Effect.gen(function* () {
            const { output: startOutput } = yield* captureStdout(
              runCli([
                "epic",
                "start",
                "--cwd",
                workspaceRoot,
                "--epic",
                "epic-cli",
                "--prompt",
                "cook this",
                "--instance",
                "codex",
                "--model",
                "gpt-5",
                "--max-iterations",
                "8",
                "--base-dir",
                baseDir,
                "--json",
              ]),
            );
            // @effect-diagnostics-next-line preferSchemaOverJson:off - verifies CLI presentation JSON.
            assert.equal(JSON.parse(startOutput).runId, "run-cli-1");
            const startRequest = requests.find(
              (request) => request.method === "POST" && request.url === "/api/epic-runs",
            );
            assert.deepInclude(startRequest?.body as object, {
              epicId: "epic-cli",
              projectId: project!.id,
              cwd: workspaceRoot,
              prompt: "cook this",
              modelSelection: { instanceId: "codex", model: "gpt-5" },
              runtimeMode: "full-access",
              maxIterations: 8,
            });
            assert.match(startRequest?.authorization ?? "", /^Bearer /);

            const promptFile = NodePath.join(workspaceRoot, "epic-prompt.txt");
            NodeFS.writeFileSync(promptFile, "prompt from file");
            yield* runCliWithRuntime([
              "epic",
              "start",
              "--cwd",
              workspaceRoot,
              "--epic",
              "epic-cli",
              "--prompt-file",
              promptFile,
              "--instance",
              "codex",
              "--model",
              "gpt-5",
              "--base-dir",
              baseDir,
            ]);
            const latestStart = requests.findLast(
              (request) => request.method === "POST" && request.url === "/api/epic-runs",
            );
            assert.equal((latestStart?.body as { prompt?: string })?.prompt, "prompt from file");

            const { output: listOutput } = yield* captureStdout(
              runCli(["epic", "list", "--base-dir", baseDir]),
            );
            assert.equal(
              listOutput,
              "runs[0]{runId,status,epicId,iterations,currentThreadId,lastError}:",
            );
            for (const command of ["status", "pause", "resume", "cancel"] as const) {
              const { output } = yield* captureStdout(
                runCli(["epic", command, "run-cli-1", "--base-dir", baseDir, "--json"]),
              );
              // @effect-diagnostics-next-line preferSchemaOverJson:off - verifies CLI presentation JSON.
              assert.equal(JSON.parse(output).runId, "run-cli-1");
            }

            watchPollsUntilDone = 0;
            const { output: watchOutput } = yield* captureStdout(
              runCli(["epic", "watch", "run-cli-1", "--base-dir", baseDir, "--json"]),
            );
            // @effect-diagnostics-next-line preferSchemaOverJson:off - verifies CLI presentation JSON.
            assert.equal(JSON.parse(watchOutput).status, "done");

            watchPollsUntilDone = undefined;
            status = "failed";
            const failed = yield* runCliWithRuntime([
              "epic",
              "watch",
              "run-cli-1",
              "--base-dir",
              baseDir,
            ]).pipe(Effect.flip);
            assert.include(
              failed instanceof Error ? failed.message : String(failed),
              "status failed",
            );

            status = "cancelled";
            const cancelled = yield* runCliWithRuntime([
              "epic",
              "watch",
              "run-cli-1",
              "--base-dir",
              baseDir,
            ]).pipe(Effect.flip);
            assert.include(
              cancelled instanceof Error ? cancelled.message : String(cancelled),
              "status cancelled",
            );
          }),
      });
    }),
  );

  it.effect("reports fresh headless connect state without requiring local configuration", () =>
    Effect.gen(function* () {
      const baseDir = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3-cli-cloud-status-test-"),
      );
      const { output } = yield* captureStdout(
        runConnectCli(["connect", "status", "--base-dir", baseDir, "--json"]),
      );
      // @effect-diagnostics-next-line preferSchemaOverJson:off - CLI JSON output is decoded as a presentation DTO.
      const status = JSON.parse(output) as {
        readonly desired: boolean;
        readonly authenticated: boolean;
        readonly linked: boolean;
        readonly cloudUserId: string | null;
        readonly relayUrl: string | null;
      };

      assert.equal(status.desired, false);
      assert.equal(status.authenticated, false);
      assert.equal(status.linked, false);
      assert.equal(status.cloudUserId, null);
      assert.equal(status.relayUrl, null);
    }),
  );

  it.effect("reports actionable human-readable headless connect state", () =>
    Effect.gen(function* () {
      const baseDir = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3-cli-cloud-status-human-test-"),
      );
      const { output } = yield* captureStdout(
        runConnectCli(["connect", "status", "--base-dir", baseDir]),
      );

      assert.include(output, "T3 Connect\n  Exposure: disabled");
      assert.include(output, "  Authorization: missing");
      assert.include(output, "  Environment link: not provisioned");
      assert.include(output, "Next: Run `t3 connect link` to authorize and enable T3 Connect.");
    }),
  );

  it.effect("accepts the --headless login override without enabling access", () =>
    Effect.gen(function* () {
      const baseDir = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3-cli-cloud-login-test-"),
      );
      const { secretsDir } = yield* ServerConfig.deriveServerPaths(baseDir, undefined);
      NodeFS.mkdirSync(secretsDir, { recursive: true });
      NodeFS.writeFileSync(
        NodePath.join(secretsDir, "cloud-cli-oauth-token.bin"),
        // @effect-diagnostics-next-line preferSchemaOverJson:off - Test fixture matches the persisted CLI token representation.
        JSON.stringify({
          accessToken: "access-token",
          refreshToken: "refresh-token",
          expiresAtEpochMs: Number.MAX_SAFE_INTEGER,
        }),
      );

      const login = yield* captureStdout(
        runConnectCli(["connect", "login", "--base-dir", baseDir, "--headless"]),
      );
      const status = yield* captureStdout(
        runConnectCli(["connect", "status", "--base-dir", baseDir, "--json"]),
      );
      // @effect-diagnostics-next-line preferSchemaOverJson:off - CLI JSON output is decoded as a presentation DTO.
      const decoded = JSON.parse(status.output) as {
        readonly desired: boolean;
        readonly authenticated: boolean;
      };

      assert.equal(login.output, "✓ Signed in");
      assert.isFalse(decoded.desired);
      assert.isTrue(decoded.authenticated);
    }),
  );

  it.effect("disables headless connect without a running server", () =>
    Effect.gen(function* () {
      const baseDir = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3-cli-cloud-unlink-test-"),
      );
      const { output } = yield* captureStdout(
        runConnectCli(["connect", "unlink", "--base-dir", baseDir]),
      );

      assert.equal(output, "T3 Connect is disabled locally.");
    }),
  );

  it.effect("logs out of headless connect and removes the stored CLI authorization", () =>
    Effect.gen(function* () {
      const baseDir = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3-cli-cloud-logout-test-"),
      );
      const { secretsDir } = yield* ServerConfig.deriveServerPaths(baseDir, undefined);
      const tokenPath = NodePath.join(secretsDir, "cloud-cli-oauth-token.bin");
      NodeFS.mkdirSync(secretsDir, { recursive: true });
      NodeFS.writeFileSync(tokenPath, "invalid persisted token");

      const { output } = yield* captureStdout(
        runConnectCli(["connect", "logout", "--base-dir", baseDir]),
      );

      assert.equal(
        output,
        "Signed out of T3 Connect locally.\nThe background service is managed separately with `t3 service`.",
      );
      assert.isFalse(NodeFS.existsSync(tokenPath));
    }),
  );

  it.effect("executes auth pairing subcommands and redacts secrets from list output", () =>
    Effect.gen(function* () {
      const baseDir = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3-cli-auth-pairing-test-"),
      );

      const createdOutput = yield* captureStdout(
        runCli(["auth", "pairing", "create", "--base-dir", baseDir, "--json"]),
      );
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const created = JSON.parse(createdOutput.output) as {
        readonly id: string;
        readonly credential: string;
      };
      const listedOutput = yield* captureStdout(
        runCli(["auth", "pairing", "list", "--base-dir", baseDir, "--json"]),
      );
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const listed = JSON.parse(listedOutput.output) as ReadonlyArray<{
        readonly id: string;
        readonly credential?: string;
      }>;

      assert.equal(typeof created.id, "string");
      assert.equal(typeof created.credential, "string");
      assert.equal(created.credential.length > 0, true);
      assert.equal(listed.length, 1);
      assert.equal(listed[0]?.id, created.id);
      assert.equal("credential" in (listed[0] ?? {}), false);
    }),
  );

  it.effect("executes auth session subcommands and redacts secrets from list output", () =>
    Effect.gen(function* () {
      const baseDir = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3-cli-auth-session-test-"),
      );

      const issuedOutput = yield* captureStdout(
        runCli(["auth", "session", "issue", "--base-dir", baseDir, "--json"]),
      );
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const issued = JSON.parse(issuedOutput.output) as {
        readonly sessionId: string;
        readonly token: string;
        readonly scopes: ReadonlyArray<string>;
      };
      const listedOutput = yield* captureStdout(
        runCli(["auth", "session", "list", "--base-dir", baseDir, "--json"]),
      );
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const listed = JSON.parse(listedOutput.output) as ReadonlyArray<{
        readonly sessionId: string;
        readonly token?: string;
        readonly scopes: ReadonlyArray<string>;
      }>;

      assert.equal(typeof issued.sessionId, "string");
      assert.equal(typeof issued.token, "string");
      assert.deepEqual(issued.scopes, [
        "orchestration:read",
        "orchestration:operate",
        "terminal:operate",
        "review:write",
        "relay:read",
        "access:read",
        "access:write",
        "relay:write",
      ]);
      assert.equal(listed.length, 1);
      assert.equal(listed[0]?.sessionId, issued.sessionId);
      assert.deepEqual(listed[0]?.scopes, [
        "orchestration:read",
        "orchestration:operate",
        "terminal:operate",
        "review:write",
        "relay:read",
        "access:read",
        "access:write",
        "relay:write",
      ]);
      assert.equal("token" in (listed[0] ?? {}), false);
    }),
  );

  it.effect("rejects invalid ttl values before running auth commands", () =>
    Effect.gen(function* () {
      const error = yield* runCliWithRuntime(["auth", "pairing", "create", "--ttl", "soon"]).pipe(
        Effect.flip,
      );

      if (!CliError.isCliError(error)) {
        assert.fail(`Expected CliError, got ${String(error)}`);
      }
      if (error._tag !== "ShowHelp") {
        assert.fail(`Expected ShowHelp, got ${error._tag}`);
      }
      assert.deepEqual(error.commandPath, ["t3", "auth", "pairing", "create"]);
      const ttlError = error.errors[0] as CliError.CliError | undefined;
      if (!ttlError || ttlError._tag !== "InvalidValue") {
        assert.fail(`Expected InvalidValue, got ${String(ttlError?._tag)}`);
      }
      assert.equal(ttlError.option, "ttl");
      assert.equal(ttlError.value, "soon");
      assert.isTrue(ttlError.message.includes("Invalid duration"));
      assert.isTrue(ttlError.message.includes("5m, 1h, 30d, or 15 minutes"));
    }),
  );

  it.effect("adds, renames, and removes projects offline through the orchestration engine", () =>
    Effect.gen(function* () {
      const baseDir = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3-cli-projects-offline-test-"),
      );
      const workspaceRoot = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3-cli-projects-workspace-"),
      );

      yield* runCliWithRuntime([
        "project",
        "add",
        workspaceRoot,
        "--title",
        "Alpha",
        "--base-dir",
        baseDir,
      ]);
      const afterAdd = yield* readPersistedSnapshot(baseDir);
      const addedProject = afterAdd.projects.find(
        (project) => project.workspaceRoot === workspaceRoot && project.deletedAt === null,
      );
      assert.isTrue(addedProject !== undefined);
      assert.equal(addedProject?.title, "Alpha");

      yield* runCliWithRuntime(["project", "rename", workspaceRoot, "Beta", "--base-dir", baseDir]);
      const afterRename = yield* readPersistedSnapshot(baseDir);
      const renamedProject = afterRename.projects.find(
        (project) => project.id === addedProject?.id,
      );
      assert.equal(renamedProject?.title, "Beta");
      assert.equal(renamedProject?.deletedAt, null);

      yield* runCliWithRuntime([
        "project",
        "remove",
        addedProject?.id ?? "",
        "--base-dir",
        baseDir,
      ]);
      const afterRemove = yield* readPersistedSnapshot(baseDir);
      const removedProject = afterRemove.projects.find(
        (project) => project.id === addedProject?.id,
      );
      assert.isTrue((removedProject?.deletedAt ?? null) !== null);
    }),
  );

  it.effect("force removes projects that still contain threads", () =>
    Effect.gen(function* () {
      const baseDir = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3-cli-projects-force-remove-test-"),
      );
      const workspaceRoot = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3-cli-projects-force-remove-workspace-"),
      );

      yield* runCliWithRuntime(["project", "add", workspaceRoot, "--base-dir", baseDir]);
      const afterAdd = yield* readPersistedSnapshot(baseDir);
      const project = afterAdd.projects.find(
        (candidate) => candidate.workspaceRoot === workspaceRoot && candidate.deletedAt === null,
      );
      assert.isTrue(project !== undefined);

      const config = yield* makeCliTestServerConfig(baseDir);
      yield* Effect.gen(function* () {
        const engine = yield* OrchestrationEngine.OrchestrationEngineService;
        yield* engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd-cli-force-remove-thread"),
          threadId: ThreadId.make("thread-cli-force-remove"),
          projectId: project!.id,
          title: "Thread",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: "default",
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt: DateTime.formatIso(yield* DateTime.now),
        });
      }).pipe(Effect.provide(makeProjectPersistenceLayer(config)));

      yield* runCliWithRuntime([
        "project",
        "remove",
        project!.id,
        "--force",
        "--base-dir",
        baseDir,
      ]);
      const afterRemove = yield* readPersistedSnapshot(baseDir);
      assert.isTrue(
        (afterRemove.projects.find((candidate) => candidate.id === project!.id)?.deletedAt ??
          null) !== null,
      );
      assert.isTrue(
        (afterRemove.threads.find((thread) => thread.id === "thread-cli-force-remove")?.deletedAt ??
          null) !== null,
      );
    }),
  );

  it.effect("routes project commands through a running server when runtime state is present", () =>
    Effect.gen(function* () {
      const baseDir = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3-cli-projects-live-test-"),
      );
      const workspaceRoot = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3-cli-projects-live-workspace-"),
      );

      yield* withLiveProjectCliServer(baseDir, () =>
        Effect.gen(function* () {
          yield* runCliWithRuntime([
            "project",
            "add",
            workspaceRoot,
            "--title",
            "Live Project",
            "--base-dir",
            baseDir,
          ]);
          const projectionSnapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
          const readModel = yield* projectionSnapshotQuery.getSnapshot();
          const addedProject = readModel.projects.find(
            (project) => project.workspaceRoot === workspaceRoot && project.deletedAt === null,
          );
          assert.isTrue(addedProject !== undefined);
          assert.equal(addedProject?.title, "Live Project");
        }),
      );
    }),
  );

  it.effect("rejects dev-url on project commands", () =>
    Effect.gen(function* () {
      const workspaceRoot = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3-cli-projects-unknown-option-workspace-"),
      );
      const error = yield* runCliWithRuntime([
        "project",
        "add",
        workspaceRoot,
        "--dev-url",
        "http://127.0.0.1:5173",
      ]).pipe(Effect.flip);

      if (!CliError.isCliError(error)) {
        assert.fail(`Expected CliError, got ${String(error)}`);
      }
      if (error._tag !== "ShowHelp") {
        assert.fail(`Expected ShowHelp, got ${error._tag}`);
      }
      assert.deepEqual(error.commandPath, ["t3", "project", "add"]);
      const optionError = error.errors[0] as CliError.CliError | undefined;
      if (!optionError || optionError._tag !== "UnrecognizedOption") {
        assert.fail(`Expected UnrecognizedOption, got ${String(optionError?._tag)}`);
      }
      assert.equal(optionError.option, "--dev-url");
    }),
  );
});
