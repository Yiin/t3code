import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RECORD_BYTES = 1024 * 1024;
const DEFAULT_MAX_STDERR_BYTES = 16 * 1024;
const DEFAULT_EVENT_BUFFER = 1024;
const FORCE_KILL_AFTER = "1 second" as const;
const REDACTED = "[REDACTED]";
const decodeUnknownJsonString = Schema.decodeUnknownEffect(Schema.UnknownFromJsonString);
const encodeUnknownJsonString = Schema.encodeUnknownEffect(Schema.UnknownFromJsonString);

const SECRET_ASSIGNMENT =
  /\b(api[-_]?key|authorization|bearer|password|secret|token)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|\S+)/gi;
const BEARER_TOKEN = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi;

export type PrimeRpcThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface PrimeRpcImage {
  readonly type: "image";
  readonly data: string;
  readonly mimeType: string;
}

export interface PrimeRpcModel {
  readonly provider: string;
  readonly id: string;
  readonly [key: string]: unknown;
}

export interface PrimeRpcState {
  readonly model: PrimeRpcModel | null;
  readonly thinkingLevel: string;
  readonly isStreaming: boolean;
  readonly isCompacting: boolean;
  readonly sessionFile: string | null;
  readonly sessionId: string;
  readonly messageCount: number;
  readonly pendingMessageCount: number;
  readonly [key: string]: unknown;
}

export interface PrimeRpcForkMessage {
  readonly entryId: string;
  readonly text: string;
}

export interface PrimeRpcForkResult {
  readonly text: string;
  readonly cancelled: boolean;
}

export interface PrimeRpcEvent {
  readonly type: string;
  readonly [key: string]: unknown;
}

export interface PrimeRpcDiagnostics {
  readonly stderr: string;
  readonly stderrBytes: number;
  readonly stderrTruncated: boolean;
}

export interface PrimeRpcPromptInput {
  readonly message: string;
  readonly images?: ReadonlyArray<PrimeRpcImage>;
  readonly streamingBehavior?: "steer" | "followUp";
}

export interface PrimeRpcMessageInput {
  readonly message: string;
  readonly images?: ReadonlyArray<PrimeRpcImage>;
}

export interface PrimeRpcExtensionUiResponse {
  readonly id: string;
  readonly value?: string;
  readonly confirmed?: boolean;
  readonly cancelled?: boolean;
}

export interface PrimeRpcTransportOptions {
  readonly binaryPath?: string;
  readonly binaryArgs?: ReadonlyArray<string>;
  readonly launchArgs?: ReadonlyArray<string>;
  readonly cwd: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly requestTimeoutMs?: number;
  readonly maxRecordBytes?: number;
  readonly maxStderrBytes?: number;
  readonly eventBuffer?: number;
}

export interface PrimeRpcTransportShape {
  readonly getState: () => Effect.Effect<PrimeRpcState, PrimeRpcTransportError>;
  readonly getAvailableModels: () => Effect.Effect<
    ReadonlyArray<PrimeRpcModel>,
    PrimeRpcTransportError
  >;
  readonly setModel: (input: {
    readonly provider: string;
    readonly modelId: string;
  }) => Effect.Effect<PrimeRpcModel, PrimeRpcTransportError>;
  readonly setThinkingLevel: (
    level: PrimeRpcThinkingLevel,
  ) => Effect.Effect<void, PrimeRpcTransportError>;
  readonly prompt: (input: PrimeRpcPromptInput) => Effect.Effect<void, PrimeRpcTransportError>;
  readonly steer: (input: PrimeRpcMessageInput) => Effect.Effect<void, PrimeRpcTransportError>;
  readonly followUp: (input: PrimeRpcMessageInput) => Effect.Effect<void, PrimeRpcTransportError>;
  readonly abort: Effect.Effect<void, PrimeRpcTransportError>;
  readonly getMessages: () => Effect.Effect<ReadonlyArray<unknown>, PrimeRpcTransportError>;
  readonly getForkMessages: () => Effect.Effect<
    ReadonlyArray<PrimeRpcForkMessage>,
    PrimeRpcTransportError
  >;
  readonly fork: (entryId: string) => Effect.Effect<PrimeRpcForkResult, PrimeRpcTransportError>;
  readonly respondToExtensionUi: (
    response: PrimeRpcExtensionUiResponse,
  ) => Effect.Effect<void, PrimeRpcTransportError>;
  readonly events: Stream.Stream<PrimeRpcEvent>;
  readonly diagnostics: Effect.Effect<PrimeRpcDiagnostics>;
  readonly close: Effect.Effect<void>;
}

export class PrimeRpcSpawnError extends Schema.TaggedErrorClass<PrimeRpcSpawnError>()(
  "PrimeRpcSpawnError",
  { binaryPath: Schema.String },
) {
  override get message(): string {
    return `Failed to start Prime RPC process: ${this.binaryPath}`;
  }
}

export class PrimeRpcProtocolError extends Schema.TaggedErrorClass<PrimeRpcProtocolError>()(
  "PrimeRpcProtocolError",
  { detail: Schema.String },
) {
  override get message(): string {
    return `Prime RPC protocol error: ${this.detail}`;
  }
}

export class PrimeRpcProcessError extends Schema.TaggedErrorClass<PrimeRpcProcessError>()(
  "PrimeRpcProcessError",
  {
    reason: Schema.Literals(["eof", "exit", "read", "write"]),
    exitCode: Schema.NullOr(Schema.Number),
    stderr: Schema.String,
    stderrBytes: Schema.Number,
    stderrTruncated: Schema.Boolean,
  },
) {
  override get message(): string {
    const code = this.exitCode === null ? "unknown" : String(this.exitCode);
    return `Prime RPC process ${this.reason} (exit code: ${code})`;
  }
}

export class PrimeRpcRequestError extends Schema.TaggedErrorClass<PrimeRpcRequestError>()(
  "PrimeRpcRequestError",
  { command: Schema.String, detail: Schema.String },
) {
  override get message(): string {
    return `Prime RPC command '${this.command}' failed: ${this.detail}`;
  }
}

export class PrimeRpcRequestTimeoutError extends Schema.TaggedErrorClass<PrimeRpcRequestTimeoutError>()(
  "PrimeRpcRequestTimeoutError",
  { command: Schema.String, timeoutMs: Schema.Number },
) {
  override get message(): string {
    return `Prime RPC command '${this.command}' timed out after ${this.timeoutMs}ms`;
  }
}

export class PrimeRpcClosedError extends Schema.TaggedErrorClass<PrimeRpcClosedError>()(
  "PrimeRpcClosedError",
  {},
) {
  override get message(): string {
    return "Prime RPC transport is closed";
  }
}

export type PrimeRpcTransportError =
  | PrimeRpcSpawnError
  | PrimeRpcProtocolError
  | PrimeRpcProcessError
  | PrimeRpcRequestError
  | PrimeRpcRequestTimeoutError
  | PrimeRpcClosedError;

interface PrimeRpcResponse {
  readonly id: string;
  readonly command: string;
  readonly success: boolean;
  readonly data?: unknown;
  readonly error?: unknown;
}

interface PendingRequest {
  readonly command: string;
  readonly response: Deferred.Deferred<PrimeRpcResponse, PrimeRpcTransportError>;
}

interface TransportState {
  readonly terminal: PrimeRpcTransportError | undefined;
  readonly pending: ReadonlyMap<string, PendingRequest>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPrimeRpcEvent(value: unknown): value is PrimeRpcEvent {
  return isRecord(value) && typeof value.type === "string";
}

function sanitizeDiagnostic(value: string, maxBytes: number): string {
  const redacted = value
    .replace(BEARER_TOKEN, `Bearer ${REDACTED}`)
    .replace(SECRET_ASSIGNMENT, (_match, key: string) => `${key}=${REDACTED}`);
  const bytes = Buffer.from(redacted);
  return bytes.length <= maxBytes ? redacted : bytes.subarray(bytes.length - maxBytes).toString();
}

function safeResponseError(value: unknown): string {
  return sanitizeDiagnostic(typeof value === "string" ? value : "Command rejected", 2048);
}

function protocolError(detail: string): PrimeRpcProtocolError {
  return new PrimeRpcProtocolError({ detail });
}

const isPrimeRpcProtocolError = Schema.is(PrimeRpcProtocolError);

function decodeResponse(record: Record<string, unknown>): PrimeRpcResponse | PrimeRpcProtocolError {
  if (typeof record.id !== "string" || record.id.length === 0) {
    return protocolError("response is missing a string id");
  }
  if (typeof record.command !== "string" || record.command.length === 0) {
    return protocolError("response is missing a command");
  }
  if (typeof record.success !== "boolean") {
    return protocolError("response is missing a success flag");
  }
  return {
    id: record.id,
    command: record.command,
    success: record.success,
    ...(Object.hasOwn(record, "data") ? { data: record.data } : {}),
    ...(Object.hasOwn(record, "error") ? { error: record.error } : {}),
  };
}

const requireObject = (
  data: unknown,
  command: string,
): Effect.Effect<Record<string, unknown>, PrimeRpcProtocolError> =>
  isRecord(data)
    ? Effect.succeed(data)
    : Effect.fail(protocolError(`'${command}' returned invalid data`));

const decodeModel = (
  data: unknown,
  command: string,
): Effect.Effect<PrimeRpcModel, PrimeRpcProtocolError> =>
  requireObject(data, command).pipe(
    Effect.flatMap((model) =>
      typeof model.provider === "string" && typeof model.id === "string"
        ? Effect.succeed(model as PrimeRpcModel)
        : Effect.fail(protocolError(`'${command}' returned an invalid model`)),
    ),
  );

const decodeState = (data: unknown): Effect.Effect<PrimeRpcState, PrimeRpcProtocolError> =>
  requireObject(data, "get_state").pipe(
    Effect.flatMap((state) => {
      if (
        !(state.model === null || isRecord(state.model)) ||
        typeof state.thinkingLevel !== "string" ||
        typeof state.isStreaming !== "boolean" ||
        typeof state.isCompacting !== "boolean" ||
        !(state.sessionFile === null || typeof state.sessionFile === "string") ||
        typeof state.sessionId !== "string" ||
        typeof state.messageCount !== "number" ||
        typeof state.pendingMessageCount !== "number"
      ) {
        return Effect.fail(protocolError("'get_state' returned invalid data"));
      }
      const decodedState = state as unknown as PrimeRpcState;
      return state.model === null
        ? Effect.succeed(decodedState)
        : decodeModel(state.model, "get_state").pipe(Effect.as(decodedState));
    }),
  );

export const makePrimeRpcTransport = Effect.fn("PrimeRpcTransport.make")(function* (
  options: PrimeRpcTransportOptions,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const runtimeScope = yield* Scope.Scope;
  const binaryPath = options.binaryPath ?? "prime-agent";
  const args = [...(options.binaryArgs ?? []), "--mode", "rpc", ...(options.launchArgs ?? [])];
  const environment = options.environment;
  const spawnCommand = yield* resolveSpawnCommand(
    binaryPath,
    args,
    environment === undefined ? { extendEnv: true } : { env: environment },
  );
  const child = yield* spawner
    .spawn(
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        cwd: options.cwd,
        ...(environment === undefined ? { extendEnv: true } : { env: environment }),
        shell: spawnCommand.shell,
        forceKillAfter: FORCE_KILL_AFTER,
        stdin: { stream: "pipe", endOnDone: false },
      }),
    )
    .pipe(
      Effect.provideService(Scope.Scope, runtimeScope),
      Effect.mapError(() => new PrimeRpcSpawnError({ binaryPath })),
    );

  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const maxRecordBytes = options.maxRecordBytes ?? DEFAULT_MAX_RECORD_BYTES;
  const maxStderrBytes = options.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES;
  const events = yield* Queue.bounded<PrimeRpcEvent>(options.eventBuffer ?? DEFAULT_EVENT_BUFFER);
  const stateRef = yield* Ref.make<TransportState>({ terminal: undefined, pending: new Map() });
  const requestSequence = yield* Ref.make(0);
  const stdoutBuffer = yield* Ref.make("");
  const stderrRef = yield* Ref.make<PrimeRpcDiagnostics>({
    stderr: "",
    stderrBytes: 0,
    stderrTruncated: false,
  });
  const writeSemaphore = yield* Semaphore.make(1);

  const diagnostics = Ref.get(stderrRef);

  const failPending = (error: PrimeRpcTransportError): Effect.Effect<void> =>
    Effect.gen(function* () {
      const pending = yield* Ref.modify(stateRef, (state) => {
        if (state.terminal !== undefined) {
          return [Array<PendingRequest>(), state] as const;
        }
        return [
          Array.from(state.pending.values()),
          { terminal: error, pending: new Map<string, PendingRequest>() },
        ] as const;
      });
      yield* Effect.forEach(
        pending,
        (request) => Deferred.fail(request.response, error).pipe(Effect.ignore),
        { discard: true },
      );
      yield* Queue.shutdown(events);
    });

  const terminate = (error: PrimeRpcTransportError, kill: boolean): Effect.Effect<void> =>
    failPending(error).pipe(
      Effect.andThen(
        kill
          ? child
              .kill({ killSignal: "SIGTERM", forceKillAfter: FORCE_KILL_AFTER })
              .pipe(Effect.ignore)
          : Effect.void,
      ),
    );

  const removePending = (id: string): Effect.Effect<void> =>
    Ref.update(stateRef, (state) => {
      if (!state.pending.has(id)) {
        return state;
      }
      const pending = new Map(state.pending);
      pending.delete(id);
      return { ...state, pending };
    });

  const handleResponse = (response: PrimeRpcResponse): Effect.Effect<void> =>
    Effect.gen(function* () {
      const pending = yield* Ref.modify(stateRef, (state) => {
        const found = state.pending.get(response.id);
        if (found === undefined) {
          return [undefined, state] as const;
        }
        const next = new Map(state.pending);
        next.delete(response.id);
        return [found, { ...state, pending: next }] as const;
      });
      if (pending === undefined) {
        return;
      }
      if (response.command !== pending.command) {
        const error = protocolError(
          `response '${response.id}' expected '${pending.command}' but received '${response.command}'`,
        );
        yield* Deferred.fail(pending.response, error).pipe(Effect.ignore);
        yield* terminate(error, true);
        return;
      }
      if (!response.success) {
        yield* Deferred.fail(
          pending.response,
          new PrimeRpcRequestError({
            command: pending.command,
            detail: safeResponseError(response.error),
          }),
        ).pipe(Effect.ignore);
        return;
      }
      yield* Deferred.succeed(pending.response, response).pipe(Effect.ignore);
    });

  const handleRecord = Effect.fn("PrimeRpcTransport.handleRecord")(function* (
    line: string,
  ): Effect.fn.Return<void, PrimeRpcProtocolError> {
    if (line.length === 0) {
      return yield* protocolError("received an empty JSONL record");
    }
    if (Buffer.byteLength(line) > maxRecordBytes) {
      return yield* protocolError(`record exceeded ${maxRecordBytes} bytes`);
    }
    const decoded = yield* decodeUnknownJsonString(line).pipe(
      Effect.mapError(() => protocolError("received malformed JSON")),
    );
    if (!isPrimeRpcEvent(decoded)) {
      return yield* protocolError("record must be a JSON object with a type");
    }
    if (decoded.type !== "response") {
      yield* Queue.offer(events, decoded);
      return;
    }
    const response = decodeResponse(decoded);
    if (isPrimeRpcProtocolError(response)) {
      return yield* response;
    }
    yield* handleResponse(response);
  });

  const handleStdoutChunk = Effect.fn("PrimeRpcTransport.handleStdoutChunk")(function* (
    chunk: string,
  ): Effect.fn.Return<void, PrimeRpcProtocolError> {
    const lines = yield* Ref.modify(stdoutBuffer, (buffer) => {
      const combined = `${buffer}${chunk}`;
      const records = combined.split("\n");
      const remainder = records.pop() ?? "";
      return [records.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line)), remainder];
    });
    const remainder = yield* Ref.get(stdoutBuffer);
    if (Buffer.byteLength(remainder) > maxRecordBytes) {
      return yield* protocolError(`record exceeded ${maxRecordBytes} bytes`);
    }
    yield* Effect.forEach(lines, handleRecord, { discard: true });
  });

  const stdoutFiber = yield* child.stdout.pipe(
    Stream.decodeText(),
    Stream.runForEach(handleStdoutChunk),
    Effect.andThen(
      Ref.get(stdoutBuffer).pipe(
        Effect.flatMap((remainder) =>
          remainder.length === 0
            ? Effect.void
            : Effect.fail(protocolError("stdout ended with an incomplete JSONL record")),
        ),
      ),
    ),
    Effect.catch((error) =>
      isPrimeRpcProtocolError(error)
        ? terminate(error, true)
        : diagnostics.pipe(
            Effect.flatMap((captured) =>
              terminate(
                new PrimeRpcProcessError({
                  reason: "read",
                  exitCode: null,
                  ...captured,
                }),
                true,
              ),
            ),
          ),
    ),
    Effect.forkIn(runtimeScope),
  );

  const stderrFiber = yield* child.stderr.pipe(
    Stream.decodeText(),
    Stream.runForEach((chunk) =>
      Ref.update(stderrRef, (current) => {
        const nextBytes = current.stderrBytes + Buffer.byteLength(chunk);
        const combined = `${current.stderr}${chunk}`;
        const stderr = sanitizeDiagnostic(combined, maxStderrBytes);
        return {
          stderr,
          stderrBytes: nextBytes,
          stderrTruncated: current.stderrTruncated || Buffer.byteLength(combined) > maxStderrBytes,
        };
      }),
    ),
    Effect.ignore,
    Effect.forkIn(runtimeScope),
  );

  yield* child.exitCode.pipe(
    Effect.flatMap((exitCode) =>
      diagnostics.pipe(
        Effect.map(
          (captured) =>
            new PrimeRpcProcessError({
              reason: Number(exitCode) === 0 ? "eof" : "exit",
              exitCode: Number(exitCode),
              ...captured,
            }),
        ),
      ),
    ),
    Effect.catch(() =>
      diagnostics.pipe(
        Effect.map(
          (captured) =>
            new PrimeRpcProcessError({
              reason: "read",
              exitCode: null,
              ...captured,
            }),
        ),
      ),
    ),
    Effect.flatMap((error) => terminate(error, false)),
    Effect.forkIn(runtimeScope),
  );

  const writeJson = (
    record: Record<string, unknown>,
  ): Effect.Effect<void, PrimeRpcTransportError> =>
    writeSemaphore.withPermits(1)(
      Effect.gen(function* () {
        const terminal = (yield* Ref.get(stateRef)).terminal;
        if (terminal !== undefined) {
          return yield* terminal;
        }
        const payload = `${yield* encodeUnknownJsonString(record).pipe(
          Effect.mapError(() => protocolError("failed to encode command")),
        )}\n`;
        const writeError = yield* Stream.run(
          Stream.encodeText(Stream.make(payload)),
          child.stdin,
        ).pipe(
          Effect.as<PrimeRpcProcessError | undefined>(undefined),
          Effect.catch(() =>
            diagnostics.pipe(
              Effect.map(
                (captured) =>
                  new PrimeRpcProcessError({
                    reason: "write",
                    exitCode: null,
                    ...captured,
                  }),
              ),
            ),
          ),
        );
        if (writeError !== undefined) {
          yield* terminate(writeError, true);
          return yield* writeError;
        }
      }),
    );

  const request = (
    command: Record<string, unknown> & { readonly type: string },
  ): Effect.Effect<unknown, PrimeRpcTransportError> =>
    Effect.gen(function* () {
      const id = yield* Ref.modify(requestSequence, (current) => [
        `t3-prime-${current + 1}`,
        current + 1,
      ]);
      const response = yield* Deferred.make<PrimeRpcResponse, PrimeRpcTransportError>();
      const terminal = yield* Ref.modify(stateRef, (state) => {
        if (state.terminal !== undefined) {
          return [state.terminal, state] as const;
        }
        const pending = new Map(state.pending);
        pending.set(id, { command: command.type, response });
        return [undefined, { ...state, pending }] as const;
      });
      if (terminal !== undefined) {
        return yield* terminal;
      }
      return yield* Effect.gen(function* () {
        yield* writeJson({ ...command, id });
        const result = yield* Deferred.await(response).pipe(Effect.timeoutOption(requestTimeoutMs));
        if (Option.isNone(result)) {
          return yield* new PrimeRpcRequestTimeoutError({
            command: command.type,
            timeoutMs: requestTimeoutMs,
          });
        }
        return result.value.data;
      }).pipe(Effect.ensuring(removePending(id)));
    });

  const getState = () => request({ type: "get_state" }).pipe(Effect.flatMap(decodeState));
  const getAvailableModels = () =>
    request({ type: "get_available_models" }).pipe(
      Effect.flatMap((data) =>
        requireObject(data, "get_available_models").pipe(
          Effect.flatMap((record) => {
            if (!Array.isArray(record.models)) {
              return Effect.fail(protocolError("'get_available_models' returned invalid data"));
            }
            return Effect.forEach(record.models, (model) =>
              decodeModel(model, "get_available_models"),
            );
          }),
        ),
      ),
    );
  const setModel = (input: { readonly provider: string; readonly modelId: string }) =>
    request({ type: "set_model", ...input }).pipe(
      Effect.flatMap((data) => decodeModel(data, "set_model")),
    );
  const setThinkingLevel = (level: PrimeRpcThinkingLevel) =>
    request({ type: "set_thinking_level", level }).pipe(Effect.asVoid);
  const prompt = (input: PrimeRpcPromptInput) =>
    request({ type: "prompt", ...input }).pipe(Effect.asVoid);
  const steer = (input: PrimeRpcMessageInput) =>
    request({ type: "steer", ...input }).pipe(Effect.asVoid);
  const followUp = (input: PrimeRpcMessageInput) =>
    request({ type: "follow_up", ...input }).pipe(Effect.asVoid);
  const abort = request({ type: "abort" }).pipe(Effect.asVoid);
  const getMessages = () =>
    request({ type: "get_messages" }).pipe(
      Effect.flatMap((data) =>
        requireObject(data, "get_messages").pipe(
          Effect.flatMap((record) => {
            if (!Array.isArray(record.messages)) {
              return Effect.fail(protocolError("'get_messages' returned invalid data"));
            }
            return Effect.succeed(record.messages);
          }),
        ),
      ),
    );
  const getForkMessages = () =>
    request({ type: "get_fork_messages" }).pipe(
      Effect.flatMap((data) =>
        requireObject(data, "get_fork_messages").pipe(
          Effect.flatMap((record) => {
            if (!Array.isArray(record.messages)) {
              return Effect.fail(protocolError("'get_fork_messages' returned invalid data"));
            }
            return Effect.forEach(record.messages, (message) => {
              if (
                !isRecord(message) ||
                typeof message.entryId !== "string" ||
                typeof message.text !== "string"
              ) {
                return Effect.fail(
                  protocolError("'get_fork_messages' returned an invalid message"),
                );
              }
              return Effect.succeed({ entryId: message.entryId, text: message.text });
            });
          }),
        ),
      ),
    );
  const fork = (entryId: string) =>
    request({ type: "fork", entryId }).pipe(
      Effect.flatMap((data) =>
        requireObject(data, "fork").pipe(
          Effect.flatMap((record) => {
            if (typeof record.text !== "string" || typeof record.cancelled !== "boolean") {
              return Effect.fail(protocolError("'fork' returned invalid data"));
            }
            return Effect.succeed({ text: record.text, cancelled: record.cancelled });
          }),
        ),
      ),
    );
  const respondToExtensionUi = (response: PrimeRpcExtensionUiResponse) =>
    writeJson({ type: "extension_ui_response", ...response });

  const close: Effect.Effect<void> = Effect.gen(function* () {
    yield* terminate(new PrimeRpcClosedError(), true);
    yield* Fiber.interrupt(stdoutFiber).pipe(Effect.ignore);
    yield* Fiber.interrupt(stderrFiber).pipe(Effect.ignore);
  });
  yield* Scope.addFinalizer(runtimeScope, close);

  return {
    getState,
    getAvailableModels,
    setModel,
    setThinkingLevel,
    prompt,
    steer,
    followUp,
    abort,
    getMessages,
    getForkMessages,
    fork,
    respondToExtensionUi,
    events: Stream.fromQueue(events),
    diagnostics,
    close,
  } satisfies PrimeRpcTransportShape;
});
