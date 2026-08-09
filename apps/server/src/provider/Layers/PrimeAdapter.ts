// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import {
  EventId,
  type PrimeSettings,
  PRIME_AGENT_DRIVER_KIND,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  type ProviderSession,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import { ChildProcessSpawner } from "effect/unstable/process";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { toT3EnvironmentEnv } from "../t3Environment.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import type { PrimeAdapterShape } from "../Services/PrimeAdapter.ts";
import {
  initialPrimeEventMapperState,
  mapPrimeRpcEvent,
  settlePrimePermissionRequests,
  type PrimeEventMapperState,
} from "../prime/PrimeEventMapper.ts";
import { resolvePrimePermissionExtensionPath } from "../prime/PrimeExtension.ts";
import { PrimeRpcMappableEvent } from "../prime/PrimeRpcEvents.ts";
import { findReservedPrimeLaunchArg } from "../prime/PrimeLaunchArgs.ts";
import {
  makePrimeRpcTransport,
  type PrimeRpcImage,
  type PrimeRpcThinkingLevel,
  type PrimeRpcTransportError,
  type PrimeRpcTransportOptions,
  type PrimeRpcTransportShape,
} from "../prime/PrimeRpcTransport.ts";

const PROVIDER = PRIME_AGENT_DRIVER_KIND;
const CURSOR_VERSION = 1;

export interface PrimeResumeCursor {
  readonly schemaVersion: 1;
  readonly sessionId: string;
  readonly ownerThreadId: string;
}

export interface PrimeAdapterLiveOptions {
  readonly instanceId?: ProviderInstanceId;
  readonly environment?: NodeJS.ProcessEnv;
  readonly makeTransport?: (
    options: PrimeRpcTransportOptions,
  ) => Effect.Effect<
    PrimeRpcTransportShape,
    PrimeRpcTransportError,
    ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
  >;
  readonly sessionId?: () => Effect.Effect<string>;
  readonly permissionExtensionPath?: string;
}

interface TurnRecord {
  readonly id: TurnId;
  items: ReadonlyArray<unknown>;
}

interface PrimeSessionContext {
  readonly threadId: ThreadId;
  readonly generation: string;
  readonly scope: Scope.Closeable;
  readonly transport: PrimeRpcTransportShape;
  eventFiber?: Fiber.Fiber<void, never>;
  session: ProviderSession;
  cursor: PrimeResumeCursor;
  activeTurnId?: TurnId;
  mapperState: PrimeEventMapperState;
  eventSequence: number;
  steeredCurrentTurn: boolean;
  turns: Array<TurnRecord>;
  exited: boolean;
  started: boolean;
  stopped: boolean;
}

const decodePrimeEvent = Schema.decodeUnknownEffect(PrimeRpcMappableEvent);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function decodePrimeResumeCursor(value: unknown): PrimeResumeCursor | undefined {
  if (!isRecord(value)) return undefined;
  if (value.schemaVersion !== CURSOR_VERSION) return undefined;
  if (typeof value.sessionId !== "string" || value.sessionId.trim().length === 0) return undefined;
  if (typeof value.ownerThreadId !== "string" || value.ownerThreadId.trim().length === 0) {
    return undefined;
  }
  return {
    schemaVersion: CURSOR_VERSION,
    sessionId: value.sessionId,
    ownerThreadId: value.ownerThreadId,
  };
}

function splitPrimeModel(model: string): { provider?: string; modelId: string } {
  const slash = model.indexOf("/");
  return slash > 0
    ? { provider: model.slice(0, slash), modelId: model.slice(slash + 1) }
    : { modelId: model };
}

function isThinkingLevel(value: string | undefined): value is PrimeRpcThinkingLevel {
  return ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value ?? "");
}

function mapTransportError(threadId: ThreadId, method: string, cause: PrimeRpcTransportError) {
  return new ProviderAdapterRequestError({
    provider: PROVIDER,
    method,
    detail: cause.message,
    cause,
  });
}

export const makePrimeAdapter = Effect.fn("makePrimeAdapter")(function* (
  config: PrimeSettings,
  options?: PrimeAdapterLiveOptions,
) {
  const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("primeAgent");
  const fileSystem = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const crypto = yield* Crypto.Crypto;
  const serverConfig = yield* ServerConfig;
  const runtimeEvents = yield* PubSub.unbounded<ProviderRuntimeEvent>();
  const sessions = new Map<ThreadId, PrimeSessionContext>();
  const threadLocks = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
  const lifecycleGate = yield* Semaphore.make(1);

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const nextSessionId = (): Effect.Effect<string, ProviderAdapterError> =>
    options?.sessionId
      ? options.sessionId()
      : crypto.randomUUIDv4.pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "crypto/randomUUIDv4",
                detail: "Failed to generate a Prime runtime identifier.",
                cause,
              }),
          ),
        );

  const getThreadLock = (threadId: ThreadId) =>
    SynchronizedRef.modifyEffect(threadLocks, (locks) => {
      const found = locks.get(threadId);
      if (found) return Effect.succeed([found, locks] as const);
      return Semaphore.make(1).pipe(
        Effect.map((created) => {
          const next = new Map(locks);
          next.set(threadId, created);
          return [created, next] as const;
        }),
      );
    });
  const withThreadLock = <A, E, R>(threadId: ThreadId, effect: Effect.Effect<A, E, R>) =>
    Effect.flatMap(getThreadLock(threadId), (lock) => lock.withPermit(effect));

  const emit = (event: ProviderRuntimeEvent) =>
    PubSub.publish(runtimeEvents, event).pipe(Effect.asVoid);
  const makeLifecycleEvent = Effect.fn("PrimeAdapter.makeLifecycleEvent")(function* (
    ctx: PrimeSessionContext,
    event: Omit<
      ProviderRuntimeEvent,
      "eventId" | "provider" | "providerInstanceId" | "threadId" | "createdAt"
    >,
  ) {
    return {
      ...event,
      eventId: EventId.make(`prime:${ctx.generation}:lifecycle:${ctx.eventSequence++}`),
      provider: PROVIDER,
      providerInstanceId: boundInstanceId,
      threadId: ctx.threadId,
      createdAt: yield* nowIso,
    } as ProviderRuntimeEvent;
  });

  const requireSession = (threadId: ThreadId) => {
    const ctx = sessions.get(threadId);
    return ctx && !ctx.stopped
      ? Effect.succeed(ctx)
      : Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }));
  };

  const updateCursorFromState = Effect.fn("PrimeAdapter.updateCursorFromState")(function* (
    ctx: PrimeSessionContext,
  ) {
    const state = yield* ctx.transport
      .getState()
      .pipe(Effect.mapError((cause) => mapTransportError(ctx.threadId, "get_state", cause)));
    ctx.cursor = {
      schemaVersion: CURSOR_VERSION,
      sessionId: state.sessionId,
      ownerThreadId: ctx.threadId,
    };
    ctx.session = {
      ...ctx.session,
      resumeCursor: ctx.cursor,
      ...(state.model ? { model: `${state.model.provider}/${state.model.id}` } : {}),
      updatedAt: yield* nowIso,
    };
    return state;
  });

  const respondToPending = Effect.fn("PrimeAdapter.respondToPending")(function* (
    ctx: PrimeSessionContext,
    reason: "interrupt" | "stop" | "crash",
  ) {
    const pending = [...ctx.mapperState.pendingRequestIds];
    yield* Effect.forEach(
      pending,
      (id) =>
        ctx.transport
          .respondToExtensionUi({
            id,
            cancelled: reason !== "crash",
            ...(reason === "crash" ? { value: "Decline" } : {}),
          })
          .pipe(Effect.ignore),
      { discard: true },
    );
    if (!ctx.activeTurnId) return;
    const settled = settlePrimePermissionRequests(
      ctx.mapperState,
      {
        threadId: ctx.threadId,
        turnId: ctx.activeTurnId,
        providerInstanceId: boundInstanceId,
        createdAt: yield* nowIso,
        sequence: ctx.eventSequence++,
      },
      reason,
    );
    ctx.mapperState = settled.state;
    yield* Effect.forEach(settled.events, emit, { discard: true });
  });

  const handleUnexpectedExit = (ctx: PrimeSessionContext) =>
    Effect.suspend(() =>
      ctx.stopped || !ctx.started
        ? Effect.void
        : withThreadLock(
            ctx.threadId,
            Effect.gen(function* () {
              if (ctx.stopped || sessions.get(ctx.threadId)?.generation !== ctx.generation) return;
              yield* respondToPending(ctx, "crash");
              if (sessions.get(ctx.threadId)?.generation !== ctx.generation) return;
              ctx.stopped = true;
              sessions.delete(ctx.threadId);
              const updatedAt = yield* nowIso;
              ctx.session = {
                ...ctx.session,
                status: "error",
                updatedAt,
                lastError: "Prime Agent process exited unexpectedly.",
              };
              if (ctx.activeTurnId) {
                yield* emit(
                  yield* makeLifecycleEvent(ctx, {
                    type: "turn.completed",
                    turnId: ctx.activeTurnId,
                    payload: {
                      state: "failed",
                      errorMessage: ctx.session.lastError,
                    },
                  }),
                );
                delete ctx.activeTurnId;
              }
              yield* emit(
                yield* makeLifecycleEvent(ctx, {
                  type: "runtime.error",
                  turnId: ctx.activeTurnId,
                  payload: {
                    message: ctx.session.lastError ?? "Prime Agent process exited.",
                    class: "provider_error",
                  },
                }),
              );
              yield* emit(
                yield* makeLifecycleEvent(ctx, {
                  type: "session.state.changed",
                  payload: { state: "error", reason: ctx.session.lastError },
                }),
              );
              yield* Scope.close(ctx.scope, Exit.void).pipe(Effect.ignore, Effect.forkDetach);
            }),
          ),
    );

  const startEventLoop = Effect.fn("PrimeAdapter.startEventLoop")(function* (
    ctx: PrimeSessionContext,
  ) {
    const run = Stream.runForEach(ctx.transport.events, (raw) =>
      withThreadLock(
        ctx.threadId,
        Effect.gen(function* () {
          if (ctx.stopped || sessions.get(ctx.threadId)?.generation !== ctx.generation) return;
          const event = yield* decodePrimeEvent(raw).pipe(Effect.option);
          if (event._tag === "None" || !ctx.activeTurnId) return;
          const mapped = mapPrimeRpcEvent(ctx.mapperState, event.value, {
            threadId: ctx.threadId,
            turnId: ctx.activeTurnId,
            providerInstanceId: boundInstanceId,
            createdAt: yield* nowIso,
            sequence: ctx.eventSequence++,
            rawEvent: raw,
          });
          ctx.mapperState = mapped.state;
          yield* Effect.forEach(mapped.events, emit, { discard: true });
          if (event.value.type === "agent_settled" && mapped.state.terminalTurn) {
            const settledTurn = ctx.activeTurnId;
            const messages = yield* ctx.transport
              .getMessages()
              .pipe(Effect.orElseSucceed(() => []));
            const turn = ctx.turns.find((candidate) => candidate.id === settledTurn);
            if (turn) turn.items = messages;
            yield* updateCursorFromState(ctx).pipe(Effect.ignore);
            delete ctx.activeTurnId;
            const { activeTurnId: _activeTurnId, ...ready } = ctx.session;
            ctx.session = { ...ready, status: "ready", updatedAt: yield* nowIso };
          }
        }),
      ),
    ).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          ctx.exited = true;
        }).pipe(Effect.andThen(handleUnexpectedExit(ctx))),
      ),
    );
    return yield* run.pipe(Effect.forkIn(ctx.scope));
  });

  const stopContext = Effect.fn("PrimeAdapter.stopContext")(function* (ctx: PrimeSessionContext) {
    if (ctx.stopped) return;
    ctx.stopped = true;
    if (sessions.get(ctx.threadId)?.generation === ctx.generation) sessions.delete(ctx.threadId);
    yield* respondToPending(ctx, "stop");
    const event = yield* makeLifecycleEvent(ctx, {
      type: "session.state.changed",
      payload: { state: "stopped", reason: "Prime Agent session stopped" },
    });
    if (ctx.activeTurnId) {
      yield* emit(
        yield* makeLifecycleEvent(ctx, {
          type: "turn.aborted",
          turnId: ctx.activeTurnId,
          payload: { reason: "Prime Agent session stopped" },
        }),
      );
    }
    yield* ctx.transport.close.pipe(Effect.ignore);
    if (ctx.eventFiber) yield* Fiber.interrupt(ctx.eventFiber).pipe(Effect.ignore);
    yield* Scope.close(ctx.scope, Exit.void).pipe(Effect.ignore);
    yield* emit(event);
  });

  const startSession: PrimeAdapterShape["startSession"] = (input) =>
    lifecycleGate.withPermit(
      withThreadLock(
        input.threadId,
        Effect.scoped(
          Effect.gen(function* () {
            if (input.provider !== undefined && input.provider !== PROVIDER) {
              return yield* new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: "startSession",
                issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
              });
            }
            if (
              input.providerInstanceId !== undefined &&
              input.providerInstanceId !== boundInstanceId
            ) {
              return yield* new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: "startSession",
                issue: `Expected provider instance '${boundInstanceId}'.`,
              });
            }
            if (input.runtimeMode === "auto-accept-edits") {
              return yield* new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: "startSession",
                issue: "Prime Agent does not support auto-accept-edits mode.",
              });
            }
            const reserved = findReservedPrimeLaunchArg(config.launchArgs);
            if (reserved) {
              return yield* new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: "startSession",
                issue: `Prime launch argument '${reserved}' is controlled by T3 Code.`,
              });
            }
            const requestedCursor = input.resumeCursor;
            const cursor = decodePrimeResumeCursor(requestedCursor);
            if (requestedCursor !== undefined && cursor === undefined) {
              return yield* new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: "startSession",
                issue: "Prime resume cursor is invalid or unsupported.",
              });
            }
            const selection =
              input.modelSelection?.instanceId === boundInstanceId
                ? input.modelSelection
                : undefined;
            if (input.modelSelection && !selection) {
              return yield* new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: "startSession",
                issue: `Model selection belongs to '${input.modelSelection.instanceId}', not '${boundInstanceId}'.`,
              });
            }
            const selectedModel = selection?.model ? splitPrimeModel(selection.model) : undefined;
            const thinking = getModelSelectionStringOptionValue(selection, "thinking");
            if (thinking !== undefined && !isThinkingLevel(thinking)) {
              return yield* new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: "startSession",
                issue: `Unsupported Prime thinking level '${thinking}'.`,
              });
            }
            const existing = sessions.get(input.threadId);
            if (existing) yield* stopContext(existing);

            const generatedId = yield* nextSessionId();
            const sameOwner = cursor?.ownerThreadId === input.threadId;
            const expectedSessionId = sameOwner && cursor ? cursor.sessionId : generatedId;
            const sessionRoot =
              config.sessionRoot ?? NodePath.join(serverConfig.stateDir, "prime", boundInstanceId);
            yield* fileSystem.makeDirectory(sessionRoot, { recursive: true }).pipe(
              Effect.andThen(fileSystem.chmod(sessionRoot, 0o700)),
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterProcessError({
                    provider: PROVIDER,
                    threadId: input.threadId,
                    detail: `Failed to prepare the private Prime session directory: ${cause.message}`,
                    cause,
                  }),
              ),
            );
            const extensionPath =
              options?.permissionExtensionPath ?? resolvePrimePermissionExtensionPath();
            const launchArgs = [
              ...config.launchArgs,
              "--session-dir",
              sessionRoot,
              "--no-extensions",
              "--extension",
              extensionPath,
              ...(cursor
                ? sameOwner
                  ? ["--session", cursor.sessionId]
                  : ["--fork", cursor.sessionId, "--session-id", generatedId]
                : ["--session-id", generatedId]),
              ...(selectedModel?.provider ? ["--provider", selectedModel.provider] : []),
              ...(selectedModel ? ["--model", selectedModel.modelId] : []),
              ...(thinking ? ["--thinking", thinking] : []),
            ];
            const environment = {
              ...process.env,
              ...options?.environment,
              ...(input.t3Environment ? toT3EnvironmentEnv(input.t3Environment) : {}),
              T3_PRIME_RUNTIME_MODE: input.runtimeMode,
            };
            const sessionScope = yield* Scope.make("sequential");
            let transferred = false;
            yield* Effect.addFinalizer(() =>
              transferred ? Effect.void : Scope.close(sessionScope, Exit.void),
            );
            const transport = yield* (options?.makeTransport ?? makePrimeRpcTransport)({
              binaryPath: config.binaryPath,
              cwd: input.cwd ?? process.cwd(),
              environment,
              launchArgs,
            }).pipe(
              Effect.provideService(Scope.Scope, sessionScope),
              Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterProcessError({
                    provider: PROVIDER,
                    threadId: input.threadId,
                    detail: cause.message,
                    cause,
                  }),
              ),
            );
            const state = yield* transport.getState().pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterProcessError({
                    provider: PROVIDER,
                    threadId: input.threadId,
                    detail: cause.message,
                    cause,
                  }),
              ),
              Effect.onError(() => transport.close),
            );
            if (state.sessionId !== expectedSessionId) {
              yield* transport.close;
              return yield* new ProviderAdapterProcessError({
                provider: PROVIDER,
                threadId: input.threadId,
                detail: `Prime opened session '${state.sessionId}', expected '${expectedSessionId}'.`,
              });
            }
            const createdAt = yield* nowIso;
            const nextCursor: PrimeResumeCursor = {
              schemaVersion: CURSOR_VERSION,
              sessionId: state.sessionId,
              ownerThreadId: input.threadId,
            };
            const ctx: PrimeSessionContext = {
              threadId: input.threadId,
              generation: yield* nextSessionId(),
              scope: sessionScope,
              transport,
              session: {
                provider: PROVIDER,
                providerInstanceId: boundInstanceId,
                status: "ready",
                runtimeMode: input.runtimeMode,
                cwd: input.cwd ?? process.cwd(),
                ...(state.model ? { model: `${state.model.provider}/${state.model.id}` } : {}),
                threadId: input.threadId,
                resumeCursor: nextCursor,
                createdAt,
                updatedAt: createdAt,
              },
              cursor: nextCursor,
              mapperState: initialPrimeEventMapperState(),
              eventSequence: 0,
              steeredCurrentTurn: false,
              turns: [],
              exited: false,
              started: false,
              stopped: false,
            };
            sessions.set(input.threadId, ctx);
            ctx.eventFiber = yield* startEventLoop(ctx);
            yield* transport.getState().pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterProcessError({
                    provider: PROVIDER,
                    threadId: input.threadId,
                    detail: `Prime Agent exited before the session became ready: ${cause.message}`,
                    cause,
                  }),
              ),
              Effect.tapError(() =>
                Effect.sync(() => {
                  ctx.stopped = true;
                  if (sessions.get(input.threadId)?.generation === ctx.generation) {
                    sessions.delete(input.threadId);
                  }
                }),
              ),
              Effect.onError(() => transport.close),
            );
            yield* Effect.yieldNow;
            if (
              ctx.exited ||
              ctx.stopped ||
              sessions.get(input.threadId)?.generation !== ctx.generation
            ) {
              ctx.stopped = true;
              if (sessions.get(input.threadId)?.generation === ctx.generation) {
                sessions.delete(input.threadId);
              }
              return yield* new ProviderAdapterProcessError({
                provider: PROVIDER,
                threadId: input.threadId,
                detail: "Prime Agent process exited during session startup.",
              });
            }
            ctx.started = true;
            transferred = true;
            yield* emit(
              yield* makeLifecycleEvent(ctx, {
                type: "session.started",
                payload: { resume: ctx.cursor },
              }),
            );
            yield* emit(
              yield* makeLifecycleEvent(ctx, {
                type: "session.state.changed",
                payload: { state: "ready", reason: "Prime Agent RPC session ready" },
              }),
            );
            yield* emit(
              yield* makeLifecycleEvent(ctx, {
                type: "thread.started",
                payload: { providerThreadId: state.sessionId },
              }),
            );
            return { ...ctx.session };
          }),
        ),
      ),
    );

  const resolveImages = Effect.fn("PrimeAdapter.resolveImages")(function* (
    input: ProviderSendTurnInput,
  ) {
    return yield* Effect.forEach(input.attachments ?? [], (attachment) =>
      Effect.gen(function* () {
        const path = resolveAttachmentPath({
          attachmentsDir: serverConfig.attachmentsDir,
          attachment,
        });
        if (!path) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "prompt",
            detail: `Invalid attachment id '${attachment.id}'.`,
          });
        }
        const bytes = yield* fileSystem.readFile(path).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "prompt",
                detail: cause.message,
                cause,
              }),
          ),
        );
        return {
          type: "image",
          data: Buffer.from(bytes).toString("base64"),
          mimeType: attachment.mimeType,
        } satisfies PrimeRpcImage;
      }),
    );
  });

  const applySelection = Effect.fn("PrimeAdapter.applySelection")(function* (
    ctx: PrimeSessionContext,
    input: ProviderSendTurnInput,
  ) {
    if (!input.modelSelection) return;
    if (input.modelSelection.instanceId !== boundInstanceId) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "sendTurn",
        issue: `Model selection belongs to '${input.modelSelection.instanceId}', not '${boundInstanceId}'.`,
      });
    }
    const requested = splitPrimeModel(input.modelSelection.model);
    if (!requested.provider) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "sendTurn",
        issue: "Prime model switches require a provider/model id.",
      });
    }
    const thinking = getModelSelectionStringOptionValue(input.modelSelection, "thinking");
    if (thinking !== undefined) {
      if (!isThinkingLevel(thinking)) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: `Unsupported Prime thinking level '${thinking}'.`,
        });
      }
    }
    yield* ctx.transport
      .setModel({ provider: requested.provider, modelId: requested.modelId })
      .pipe(Effect.mapError((cause) => mapTransportError(ctx.threadId, "set_model", cause)));
    if (thinking !== undefined) {
      yield* ctx.transport
        .setThinkingLevel(thinking)
        .pipe(
          Effect.mapError((cause) => mapTransportError(ctx.threadId, "set_thinking_level", cause)),
        );
    }
    ctx.session = { ...ctx.session, model: input.modelSelection.model, updatedAt: yield* nowIso };
  });

  const sendTurn: PrimeAdapterShape["sendTurn"] = (input) =>
    withThreadLock(
      input.threadId,
      Effect.gen(function* () {
        const ctx = yield* requireSession(input.threadId);
        yield* applySelection(ctx, input);
        const message = input.input?.trim() ?? "";
        const images = yield* resolveImages(input);
        if (!message && images.length === 0) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "Turn requires non-empty text or attachments.",
          });
        }
        const steering = ctx.activeTurnId !== undefined;
        const turnId = ctx.activeTurnId ?? TurnId.make(yield* nextSessionId());
        if (!steering) {
          ctx.activeTurnId = turnId;
          ctx.mapperState = initialPrimeEventMapperState();
          ctx.steeredCurrentTurn = false;
          ctx.turns.push({ id: turnId, items: [] });
        }
        ctx.session = {
          ...ctx.session,
          status: "running",
          activeTurnId: turnId,
          updatedAt: yield* nowIso,
        };
        const deliverAsFollowUp = steering && ctx.steeredCurrentTurn;
        const command = steering
          ? deliverAsFollowUp
            ? ctx.transport.followUp({ message, ...(images.length ? { images } : {}) })
            : ctx.transport.steer({ message, ...(images.length ? { images } : {}) })
          : ctx.transport.prompt({ message, ...(images.length ? { images } : {}) });
        yield* command.pipe(
          Effect.mapError((cause) =>
            mapTransportError(input.threadId, steering ? "steer" : "prompt", cause),
          ),
          Effect.tapError((cause) =>
            Effect.gen(function* () {
              if (!steering && ctx.activeTurnId === turnId) {
                delete ctx.activeTurnId;
                const { activeTurnId: _activeTurnId, ...ready } = ctx.session;
                ctx.session = { ...ready, status: "ready", updatedAt: yield* nowIso };
                yield* emit(
                  yield* makeLifecycleEvent(ctx, {
                    type: "turn.completed",
                    turnId,
                    payload: { state: "failed", errorMessage: cause.message },
                  }),
                );
              }
            }),
          ),
        );
        if (steering && !deliverAsFollowUp) ctx.steeredCurrentTurn = true;
        return {
          threadId: input.threadId,
          turnId,
          ...(steering ? { steeredIntoActiveTurn: true } : {}),
          resumeCursor: ctx.cursor,
        };
      }),
    );

  const interruptTurn: PrimeAdapterShape["interruptTurn"] = (threadId, turnId) =>
    withThreadLock(
      threadId,
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        if (turnId && ctx.activeTurnId !== turnId) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "interruptTurn",
            issue: `Turn '${turnId}' is not active.`,
          });
        }
        yield* respondToPending(ctx, "interrupt");
        yield* ctx.transport.abort.pipe(
          Effect.mapError((cause) => mapTransportError(threadId, "abort", cause)),
        );
      }),
    );

  const respondToRequest: PrimeAdapterShape["respondToRequest"] = (threadId, requestId, decision) =>
    withThreadLock(
      threadId,
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        if (!ctx.mapperState.pendingRequestIds.has(requestId)) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "extension_ui_response",
            detail: `Unknown pending approval request: ${requestId}`,
          });
        }
        const response =
          decision === "cancel"
            ? { id: requestId, cancelled: true }
            : {
                id: requestId,
                value:
                  decision === "accept"
                    ? "Allow once"
                    : decision === "acceptForSession"
                      ? "Allow for session"
                      : "Decline",
              };
        yield* ctx.transport
          .respondToExtensionUi(response)
          .pipe(
            Effect.mapError((cause) => mapTransportError(threadId, "extension_ui_response", cause)),
          );
        if (ctx.activeTurnId) {
          const mapped = mapPrimeRpcEvent(
            ctx.mapperState,
            { type: "extension_ui_response", ...response },
            {
              threadId,
              turnId: ctx.activeTurnId,
              providerInstanceId: boundInstanceId,
              createdAt: yield* nowIso,
              sequence: ctx.eventSequence++,
            },
          );
          ctx.mapperState = mapped.state;
          yield* Effect.forEach(mapped.events, emit, { discard: true });
        }
      }),
    );

  const respondToUserInput: PrimeAdapterShape["respondToUserInput"] = (threadId) =>
    Effect.fail(
      new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "respondToUserInput",
        detail: `Prime Agent does not expose structured user input for thread '${threadId}'.`,
      }),
    );

  const readThread: PrimeAdapterShape["readThread"] = (threadId) =>
    Effect.gen(function* () {
      const ctx = yield* requireSession(threadId);
      const messages = yield* ctx.transport
        .getMessages()
        .pipe(Effect.mapError((cause) => mapTransportError(threadId, "get_messages", cause)));
      const turns = ctx.turns.map((turn, index) => ({
        id: turn.id,
        items: index === ctx.turns.length - 1 ? messages : turn.items,
      }));
      return { threadId, turns, resumeCursor: ctx.cursor };
    });

  const rollbackThread: PrimeAdapterShape["rollbackThread"] = (threadId, numTurns) =>
    withThreadLock(
      threadId,
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        if (!Number.isInteger(numTurns) || numTurns < 1) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: "numTurns must be an integer >= 1.",
          });
        }
        if (ctx.activeTurnId) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: "Cannot roll back while a Prime turn is active.",
          });
        }
        const messages = yield* ctx.transport
          .getForkMessages()
          .pipe(
            Effect.mapError((cause) => mapTransportError(threadId, "get_fork_messages", cause)),
          );
        const targetIndex = messages.length - numTurns;
        const target = messages[targetIndex];
        if (!target) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: `Cannot roll back ${numTurns} turn(s).`,
          });
        }
        const result = yield* ctx.transport
          .fork(target.entryId)
          .pipe(Effect.mapError((cause) => mapTransportError(threadId, "fork", cause)));
        if (result.cancelled) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "fork",
            detail: "Prime rollback was cancelled.",
          });
        }
        ctx.turns.splice(Math.max(0, ctx.turns.length - numTurns));
        yield* updateCursorFromState(ctx);
        return { threadId, turns: ctx.turns, resumeCursor: ctx.cursor };
      }),
    );

  const stopSession: PrimeAdapterShape["stopSession"] = (threadId) =>
    withThreadLock(
      threadId,
      Effect.gen(function* () {
        const ctx = sessions.get(threadId);
        if (!ctx) return;
        yield* stopContext(ctx);
      }),
    );
  const listSessions: PrimeAdapterShape["listSessions"] = () =>
    Effect.sync(() =>
      [...sessions.values()].filter((ctx) => !ctx.stopped).map((ctx) => ({ ...ctx.session })),
    );
  const hasSession: PrimeAdapterShape["hasSession"] = (threadId) =>
    Effect.sync(() => sessions.get(threadId)?.stopped === false);
  const stopAll: PrimeAdapterShape["stopAll"] = () =>
    lifecycleGate.withPermit(
      Effect.forEach(
        [...sessions.keys()],
        (threadId) =>
          withThreadLock(
            threadId,
            Effect.suspend(() => {
              const ctx = sessions.get(threadId);
              return ctx ? stopContext(ctx) : Effect.void;
            }),
          ),
        { discard: true },
      ),
    );

  yield* Effect.addFinalizer(() =>
    stopAll().pipe(
      Effect.catch((cause) => Effect.logError("Failed to stop Prime Agent sessions.", { cause })),
      Effect.andThen(PubSub.shutdown(runtimeEvents)),
    ),
  );

  return {
    provider: PROVIDER,
    capabilities: { sessionModelSwitch: "in-session" },
    startSession,
    sendTurn,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    hasSession,
    readThread,
    rollbackThread,
    stopAll,
    streamEvents: Stream.fromPubSub(runtimeEvents),
  } satisfies PrimeAdapterShape;
});
