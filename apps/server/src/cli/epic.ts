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
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as References from "effect/References";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag, GlobalFlag } from "effect/unstable/cli";
import { FetchHttpClient, HttpClientError } from "effect/unstable/http";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";
import { isEpicRunTerminal as isTerminalRunStatus } from "@t3tools/epic-core/runStatus";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import {
  clearPersistedServerRuntimeState,
  readPersistedServerRuntimeState,
} from "../serverRuntimeState.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { projectLocationFlags, resolveCliAuthConfig } from "./config.ts";
import { cookCommand } from "./epicCook.ts";
import { policyCommand } from "./epicPolicy.ts";

const EPIC_CLI_PROBE_TIMEOUT = Duration.seconds(10);
export const EPIC_CLI_WATCH_INTERVAL = Duration.seconds(1);
const EPIC_CLI_SESSION_TTL = Duration.minutes(5);
/** Re-issue this far ahead of expiry so a slow call can't outlive its token. */
const EPIC_CLI_SESSION_REFRESH_MARGIN = Duration.minutes(1);
/**
 * How many polls in a row may fail before `epic watch` gives up.
 *
 * A watch is long-lived and deliberately runs while the server is at its
 * busiest, so a single failed poll says nothing about the run. Failing on it
 * used to end the watch of a perfectly healthy epic.
 */
export const EPIC_CLI_WATCH_MAX_CONSECUTIVE_FAILURES = 10;
/** Cap on how far the retry sleep grows, in multiples of the poll interval. */
const EPIC_CLI_WATCH_MAX_BACKOFF_STEPS = 5;
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
  isTerminalRunStatus(run.status);

export const formatEpicRunCompact = (run: EpicRun): string =>
  [
    run.runId,
    run.status,
    run.epicId,
    `${run.iterationsCompleted}/${run.maxIterations}`,
    run.currentThreadId ?? "-",
    run.lastError ?? "-",
  ].join("\t");

export const formatEpicOutput = (value: EpicRun | ReadonlyArray<EpicRun>, json: boolean): string =>
  json
    ? encodeJsonOutput(value)
    : "runId" in value
      ? formatEpicRunCompact(value)
      : [
          `runs[${value.length}]{runId,status,epicId,iterations,currentThreadId,lastError}:`,
          ...value.map((run) => `  ${formatEpicRunCompact(run)}`),
        ].join("\n");

/**
 * One bearer session, shared by every call a single `t3 epic` invocation makes.
 *
 * Issuing a session INSERTs a row into `auth_sessions`, so it is a database
 * write. Doing that per call meant a read-only command like `epic status` took
 * the SQLite write lock twice — once to discover the server, once for the
 * request — and `epic watch` took it every second for the life of the run. On a
 * busy server that lost the lock often enough to kill the watch (t3code-8h3).
 * The lease issues once and only re-issues when the token is close to expiry.
 */
export interface EpicSessionLease {
  readonly token: Effect.Effect<string, EnvironmentAuth.ServerAuthInternalError>;
}

export const makeEpicSessionLease = Effect.fnUntraced(function* (
  auth: EnvironmentAuth.EnvironmentAuth["Service"],
) {
  const cache = yield* Ref.make(Option.none<EnvironmentAuth.IssuedBearerSession>());
  const revoke = (session: EnvironmentAuth.IssuedBearerSession) =>
    auth.revokeSession(session.sessionId).pipe(Effect.ignore({ log: true }));

  yield* Effect.addFinalizer(() =>
    Ref.getAndSet(cache, Option.none()).pipe(
      Effect.flatMap((current) => (Option.isSome(current) ? revoke(current.value) : Effect.void)),
    ),
  );

  const token: EpicSessionLease["token"] = Effect.gen(function* () {
    const now = yield* DateTime.now;
    const cached = yield* Ref.get(cache);
    const usableUntil =
      DateTime.toEpochMillis(now) + Duration.toMillis(EPIC_CLI_SESSION_REFRESH_MARGIN);
    if (Option.isSome(cached) && DateTime.toEpochMillis(cached.value.expiresAt) > usableUntil) {
      return cached.value.token;
    }

    const issued = yield* auth.issueSession({
      scopes: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
      label: "t3 epic cli",
      ttl: EPIC_CLI_SESSION_TTL,
    });
    const previous = yield* Ref.getAndSet(cache, Option.some(issued));
    if (Option.isSome(previous)) yield* revoke(previous.value);
    return issued.token;
  });

  return { token } satisfies EpicSessionLease;
});

export const discoverLiveServer = Effect.fn("discoverEpicLiveServer")(function* (
  lease: EpicSessionLease,
  config: ServerConfig.ServerConfig["Service"],
) {
  const state = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath);
  if (Option.isNone(state)) return yield* noLiveServerError();

  const probe = Effect.gen(function* () {
    const token = yield* lease.token;
    const client = yield* makeClient(state.value.origin);
    return yield* client.orchestration.shellSnapshot({
      headers: bearerHeaders(token),
    });
  }).pipe(Effect.timeout(EPIC_CLI_PROBE_TIMEOUT));
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
    readonly client: Effect.Success<ReturnType<typeof makeClient>>;
    readonly lease: EpicSessionLease;
    readonly snapshot: OrchestrationShellSnapshot;
  }) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | WorkspacePaths.WorkspacePaths>,
) =>
  Effect.gen(function* () {
    const logLevel = yield* GlobalFlag.LogLevel;
    const config = yield* resolveCliAuthConfig(flags, logLevel);
    const minimumLogLevel = flags.json ? "Error" : config.logLevel;
    return yield* Effect.gen(function* () {
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const lease = yield* makeEpicSessionLease(auth);
      const live = yield* discoverLiveServer(lease, config);
      const client = yield* makeClient(live.origin);
      return yield* run({ client, lease, snapshot: live.snapshot });
    }).pipe(
      Effect.scoped,
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
      const promptSource =
        promptText !== undefined && promptFile === undefined
          ? ({ kind: "text", text: promptText } as const)
          : promptFile !== undefined && promptText === undefined
            ? ({ kind: "file", path: promptFile } as const)
            : null;
      if (promptSource === null) {
        return yield* new EpicCliError({
          operation: "resolvePrompt",
          detail: "Exactly one of --prompt or --prompt-file is required.",
        });
      }
      return yield* runEpicCommand(
        flags,
        Effect.fn("epicCliStart")(function* ({ client, lease, snapshot }) {
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
            promptSource.kind === "text"
              ? promptSource.text
              : yield* fs.readFileString(path.resolve(promptSource.path));
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
              headers: bearerHeaders(yield* lease.token),
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
      Effect.fn("epicCliList")(function* ({ client, lease }) {
        const runs = yield* mapLiveError(
          client.epicRuns.list({
            headers: bearerHeaders(yield* lease.token),
            payload: {},
          }),
        );
        yield* Console.log(formatEpicOutput(runs, flags.json));
      }),
    ),
  ),
);

/**
 * Poll an epic run until it reaches a terminal status.
 *
 * The loop tolerates failed polls once it has seen the run at least one time.
 * The first poll stays strict, so a bad run id or a dead server still fails
 * straight away instead of retrying for a minute.
 */
export const watchEpicRun = Effect.fnUntraced(function* <E>(options: {
  readonly poll: Effect.Effect<EpicRun, E>;
  readonly emit: (line: string) => Effect.Effect<void>;
  readonly json: boolean;
  readonly interval?: Duration.Duration | undefined;
}) {
  const interval = options.interval ?? EPIC_CLI_WATCH_INTERVAL;
  let previous = "";
  let consecutiveFailures = 0;
  let seenRun = false;

  while (true) {
    const polled = yield* Effect.result(options.poll);

    if (polled._tag === "Failure") {
      consecutiveFailures += 1;
      if (!seenRun || consecutiveFailures > EPIC_CLI_WATCH_MAX_CONSECUTIVE_FAILURES) {
        return yield* Effect.fail(polled.failure);
      }
      yield* Effect.logWarning("Epic run poll failed; retrying.").pipe(
        Effect.annotateLogs({ consecutiveFailures, failure: polled.failure }),
      );
      yield* Effect.sleep(
        Duration.times(interval, Math.min(consecutiveFailures, EPIC_CLI_WATCH_MAX_BACKOFF_STEPS)),
      );
      continue;
    }

    seenRun = true;
    consecutiveFailures = 0;
    const run = polled.success;
    const output = formatEpicOutput(run, options.json);
    if (!options.json && output !== previous) yield* options.emit(output);
    if (isEpicRunTerminal(run)) {
      if (options.json) yield* options.emit(output);
      if (run.status !== "done") {
        return yield* new EpicCliError({
          operation: "watch",
          detail: `Epic run ${run.runId} ended with status ${run.status}.`,
        });
      }
      return;
    }
    previous = output;
    yield* Effect.sleep(interval);
  }
});

const statusCommand = Command.make("status", {
  ...projectLocationFlags,
  runId: runIdArgument,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Show an epic run."),
  Command.withHandler((flags) =>
    runEpicCommand(
      flags,
      Effect.fn("epicClistatus")(function* ({ client, lease }) {
        const run = yield* mapLiveError(
          client.epicRuns.get({
            headers: bearerHeaders(yield* lease.token),
            params: { runId: EpicRunId.make(flags.runId) },
          }),
        );
        yield* Console.log(formatEpicOutput(run, flags.json));
      }),
    ),
  ),
);

const watchCommand = Command.make("watch", {
  ...projectLocationFlags,
  runId: runIdArgument,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Watch an epic run until it finishes."),
  Command.withHandler((flags) =>
    runEpicCommand(
      flags,
      Effect.fn("epicCliwatch")(function* ({ client, lease }) {
        yield* watchEpicRun({
          poll: Effect.gen(function* () {
            const token = yield* lease.token;
            return yield* mapLiveError(
              client.epicRuns.get({
                headers: bearerHeaders(token),
                params: { runId: EpicRunId.make(flags.runId) },
              }),
            );
          }),
          emit: Console.log,
          json: flags.json,
        });
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
        Effect.fn(`epicCli${name}`)(function* ({ client, lease }) {
          const run = yield* mapLiveError(
            client.epicRuns[name]({
              headers: bearerHeaders(yield* lease.token),
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
    cookCommand,
    startCommand,
    listCommand,
    statusCommand,
    mutationCommand("pause"),
    mutationCommand("resume"),
    mutationCommand("cancel"),
    watchCommand,
    policyCommand,
  ]),
);
