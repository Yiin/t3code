import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
  EnvironmentHttpCommonError,
  EpicRunId,
  type EpicRun,
  type EpicRunInput,
  type OrchestrationShellSnapshot,
  PositiveInt,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Console from "effect/Console";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag, GlobalFlag } from "effect/unstable/cli";
import { FetchHttpClient, HttpClientError } from "effect/unstable/http";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import {
  clearPersistedServerRuntimeState,
  readPersistedServerRuntimeState,
} from "../serverRuntimeState.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { projectLocationFlags, resolveCliAuthConfig } from "./config.ts";

const EPIC_CLI_PROBE_TIMEOUT = Duration.seconds(10);
const EPIC_CLI_WATCH_INTERVAL = Duration.seconds(1);
const isEnvironmentHttpCommonError = Schema.is(EnvironmentHttpCommonError);
const encodeJsonOutput = Schema.encodeSync(Schema.UnknownFromJsonString);

export class EpicCliError extends Schema.TaggedErrorClass<EpicCliError>()("EpicCliError", {
  operation: Schema.String,
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return this.detail;
  }
}

const noLiveServerError = () =>
  new EpicCliError({
    operation: "discoverLiveServer",
    detail:
      "No running T3 Code server was found. Start it with `systemctl --user start t3code.service`.",
  });

const makeClient = (origin: string) =>
  HttpApiClient.make(EnvironmentHttpApi, {
    baseUrl: origin,
  });

const bearerHeaders = (token: string) => ({ authorization: `Bearer ${token}` });

export const shouldClearEpicRuntimeState = (cause: unknown): boolean => {
  // A slow-but-alive server times out; that is not evidence the server is gone,
  // so never delete the persisted runtime state for it.
  if (Cause.isTimeoutError(cause)) return false;
  // Only a genuine transport failure (e.g. connection refused, DNS failure) —
  // an `HttpClientError` with no response, because the request never reached a
  // server — means the origin is actually dead. Declared errors and HTTP
  // responses with an undeclared status both mean *something* answered, so
  // they don't count either.
  return HttpClientError.isHttpClientError(cause) && cause.response === undefined;
};

export const epicCliHttpError = (cause: unknown): EpicCliError => {
  if (isEnvironmentHttpCommonError(cause)) {
    return new EpicCliError({
      operation: "callLiveServer",
      detail: `Server request failed (${cause.code}, trace ${cause.traceId}).`,
      cause,
    });
  }
  if (HttpClientError.isHttpClientError(cause) && cause.response !== undefined) {
    return new EpicCliError({
      operation: "callLiveServer",
      detail: `Server request failed with undeclared status ${cause.response.status}.`,
      cause,
    });
  }
  return new EpicCliError({
    operation: "callLiveServer",
    detail: "Failed to call the running server.",
    cause,
  });
};

const mapLiveError = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, EpicCliError, R> =>
  effect.pipe(Effect.mapError(epicCliHttpError));

export const findEpicProject = (snapshot: OrchestrationShellSnapshot, normalizedCwd: string) =>
  // The shell snapshot only ever contains active projects — getShellSnapshot
  // drops deleted rows while assembling the response (the project row query
  // itself has no deleted_at clause) — so there is no `deletedAt` to check.
  snapshot.projects.find((project) => project.workspaceRoot === normalizedCwd);

export const isEpicRunTerminal = (run: Pick<EpicRun, "status">): boolean =>
  run.status === "done" || run.status === "failed" || run.status === "cancelled";

export const formatEpicRunCompact = (run: EpicRun): string =>
  [
    run.runId,
    run.status,
    run.epicId,
    `${run.iterationsCompleted}/${run.maxIterations}`,
    run.currentThreadId ?? "-",
    run.lastError ?? "-",
  ].join("\t");

export const formatEpicOutput = (value: unknown, json: boolean): string =>
  json
    ? encodeJsonOutput(value)
    : Array.isArray(value)
      ? [
          `runs[${value.length}]{runId,status,epicId,iterations,currentThreadId,lastError}:`,
          ...value.map((run) => `  ${formatEpicRunCompact(run)}`),
        ].join("\n")
      : formatEpicRunCompact(value as EpicRun);

const withEpicSession = <A, E, R>(
  auth: EnvironmentAuth.EnvironmentAuth["Service"],
  use: (token: string) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    auth.issueSession({
      scopes: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
      label: "t3 epic cli",
      ttl: Duration.minutes(5),
    }),
    (session) => use(session.token),
    (session) => auth.revokeSession(session.sessionId).pipe(Effect.ignore({ log: true })),
  );

export const discoverLiveServer = Effect.fn("discoverEpicLiveServer")(function* (
  auth: EnvironmentAuth.EnvironmentAuth["Service"],
  config: ServerConfig.ServerConfig["Service"],
) {
  const state = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath);
  if (Option.isNone(state)) return yield* noLiveServerError();

  const probe = withEpicSession(auth, (token) =>
    Effect.gen(function* () {
      const client = yield* makeClient(state.value.origin);
      return yield* client.orchestration.shellSnapshot({
        headers: bearerHeaders(token),
      });
    }).pipe(Effect.timeout(EPIC_CLI_PROBE_TIMEOUT)),
  );
  const result = yield* Effect.result(probe);
  if (result._tag === "Success") {
    return { origin: state.value.origin, snapshot: result.success };
  }
  if (shouldClearEpicRuntimeState(result.failure)) {
    yield* clearPersistedServerRuntimeState(config.serverRuntimeStatePath);
  }
  return yield* new EpicCliError({
    operation: "probeLiveServer",
    detail: noLiveServerError().detail,
    cause: result.failure,
  });
});

const runEpicCommand = <A, E>(
  flags: { readonly baseDir: Option.Option<string>; readonly json?: boolean },
  run: (input: {
    readonly auth: EnvironmentAuth.EnvironmentAuth["Service"];
    readonly client: Effect.Success<ReturnType<typeof makeClient>>;
    readonly token: string;
    readonly snapshot: OrchestrationShellSnapshot;
  }) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | WorkspacePaths.WorkspacePaths>,
) =>
  Effect.gen(function* () {
    const logLevel = yield* GlobalFlag.LogLevel;
    const config = yield* resolveCliAuthConfig(flags, logLevel);
    const minimumLogLevel = flags.json ? "Error" : config.logLevel;
    return yield* Effect.gen(function* () {
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const live = yield* discoverLiveServer(auth, config);
      return yield* withEpicSession(auth, (token) =>
        Effect.gen(function* () {
          const client = yield* makeClient(live.origin);
          return yield* run({ auth, client, token, snapshot: live.snapshot });
        }),
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          EnvironmentAuth.runtimeLayer,
          FetchHttpClient.layer,
          WorkspacePaths.layer,
        ).pipe(
          Layer.provide(ServerConfig.layer(config)),
          Layer.provide(Layer.succeed(References.MinimumLogLevel, minimumLogLevel)),
        ),
      ),
    );
  });

const jsonFlag = Flag.boolean("json").pipe(
  Flag.withDescription("Emit stable JSON output."),
  Flag.withDefault(false),
);
const runIdArgument = Argument.string("runId").pipe(Argument.withDescription("Epic run id."));

const startCommand = Command.make("start", {
  ...projectLocationFlags,
  cwd: Flag.string("cwd").pipe(Flag.withDescription("Active project workspace root.")),
  epic: Flag.string("epic").pipe(Flag.withDescription("Beads epic id.")),
  promptFile: Flag.string("prompt-file").pipe(
    Flag.withDescription("Read the prompt from a file."),
    Flag.optional,
  ),
  prompt: Flag.string("prompt").pipe(Flag.withDescription("Prompt text."), Flag.optional),
  instance: Flag.string("instance").pipe(Flag.withDescription("Provider instance id.")),
  model: Flag.string("model").pipe(Flag.withDescription("Model id.")),
  maxIterations: Flag.integer("max-iterations").pipe(
    Flag.withSchema(PositiveInt),
    Flag.withDescription("Maximum iterations."),
    Flag.optional,
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Start an epic run on the running server."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const promptText = Option.getOrUndefined(flags.prompt);
      const promptFile = Option.getOrUndefined(flags.promptFile);
      if ((promptText === undefined) === (promptFile === undefined)) {
        return yield* new EpicCliError({
          operation: "resolvePrompt",
          detail: "Exactly one of --prompt or --prompt-file is required.",
        });
      }
      return yield* runEpicCommand(
        flags,
        Effect.fn("epicCliStart")(function* ({ client, token, snapshot }) {
          const path = yield* Path.Path;
          const fs = yield* FileSystem.FileSystem;
          const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
          const cwd = yield* workspacePaths.normalizeWorkspaceRoot(flags.cwd);
          const project = findEpicProject(snapshot, cwd);
          if (!project) {
            return yield* new EpicCliError({
              operation: "resolveProject",
              detail: `No active project matches '${cwd}'.`,
            });
          }
          const prompt =
            promptText ?? (yield* fs.readFileString(path.resolve(promptFile as string)));
          const payload: EpicRunInput = {
            epicId: flags.epic,
            projectId: project.id,
            cwd,
            prompt,
            modelSelection: {
              instanceId: ProviderInstanceId.make(flags.instance),
              model: flags.model,
            },
            runtimeMode: "full-access",
            ...(Option.isSome(flags.maxIterations)
              ? { maxIterations: flags.maxIterations.value }
              : {}),
          };
          const run = yield* mapLiveError(
            client.epicRuns.start({
              headers: bearerHeaders(token),
              payload,
            }),
          );
          yield* Console.log(flags.json ? formatEpicOutput(run, true) : run.runId);
        }),
      );
    }),
  ),
);

const listCommand = Command.make("list", {
  ...projectLocationFlags,
  json: jsonFlag,
}).pipe(
  Command.withDescription("List epic runs."),
  Command.withHandler((flags) =>
    runEpicCommand(
      flags,
      Effect.fn("epicCliList")(function* ({ client, token }) {
        const runs = yield* mapLiveError(
          client.epicRuns.list({
            headers: bearerHeaders(token),
            payload: {},
          }),
        );
        yield* Console.log(formatEpicOutput(runs, flags.json));
      }),
    ),
  ),
);

const readCommand = (name: "status" | "watch", watch: boolean) =>
  Command.make(name, {
    ...projectLocationFlags,
    runId: runIdArgument,
    json: jsonFlag,
  }).pipe(
    Command.withDescription(watch ? "Watch an epic run until it finishes." : "Show an epic run."),
    Command.withHandler((flags) =>
      runEpicCommand(
        flags,
        Effect.fn(`epicCli${name}`)(function* ({ auth, client, token }) {
          let previous = "";
          while (true) {
            const run = yield* mapLiveError(
              watch
                ? withEpicSession(auth, (pollToken) =>
                    client.epicRuns.get({
                      headers: bearerHeaders(pollToken),
                      params: { runId: EpicRunId.make(flags.runId) },
                    }),
                  )
                : client.epicRuns.get({
                    headers: bearerHeaders(token),
                    params: { runId: EpicRunId.make(flags.runId) },
                  }),
            );
            const output = formatEpicOutput(run, flags.json);
            if (!watch || (!flags.json && output !== previous)) yield* Console.log(output);
            if (!watch || isEpicRunTerminal(run)) {
              if (watch && flags.json) yield* Console.log(output);
              if (watch && run.status !== "done") {
                return yield* new EpicCliError({
                  operation: "watch",
                  detail: `Epic run ${run.runId} ended with status ${run.status}.`,
                });
              }
              return;
            }
            previous = output;
            yield* Effect.sleep(EPIC_CLI_WATCH_INTERVAL);
          }
        }),
      ),
    ),
  );

const mutationCommand = (name: "pause" | "resume" | "cancel") =>
  Command.make(name, {
    ...projectLocationFlags,
    runId: runIdArgument,
    json: jsonFlag,
  }).pipe(
    Command.withDescription(`${name[0]!.toUpperCase()}${name.slice(1)} an epic run.`),
    Command.withHandler((flags) =>
      runEpicCommand(
        flags,
        Effect.fn(`epicCli${name}`)(function* ({ client, token }) {
          const run = yield* mapLiveError(
            client.epicRuns[name]({
              headers: bearerHeaders(token),
              params: { runId: EpicRunId.make(flags.runId) },
            }),
          );
          yield* Console.log(formatEpicOutput(run, flags.json));
        }),
      ),
    ),
  );

export const epicCommand = Command.make("epic").pipe(
  Command.withDescription("Manage daemon-hosted epic runs."),
  Command.withSubcommands([
    startCommand,
    listCommand,
    readCommand("status", false),
    mutationCommand("pause"),
    mutationCommand("resume"),
    mutationCommand("cancel"),
    readCommand("watch", true),
  ]),
);
