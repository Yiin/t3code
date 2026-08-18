/**
 * Optional integration check against a real `cursor-agent acp` install.
 * Enable with:
 * T3_CURSOR_ACP_PROBE=1 vp test run apps/server/src/provider/acp/CursorAcpCliProbe.test.ts
 *
 * The overlap probe uses the raw ACP client. It intentionally bypasses
 * AcpSessionRuntime's prompt semaphore to measure Cursor's wire behavior.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Console from "effect/Console";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as EffectAcpClient from "effect-acp/client";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpProtocol from "effect-acp/protocol";
import { describe, expect } from "vite-plus/test";
import type * as EffectAcpSchema from "effect-acp/schema";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

type RpcId = string | number;

const decodeUnknownJsonString = Schema.decodeUnknownOption(Schema.UnknownFromJsonString);
const isAcpRequestError = Schema.is(EffectAcpErrors.AcpRequestError);

const prompt = (sessionId: string, text: string): EffectAcpSchema.PromptRequest => ({
  sessionId,
  prompt: [{ type: "text", text }],
});

const rpcEnvelope = (raw: string): Record<string, unknown> | undefined => {
  const decoded = Option.getOrUndefined(decodeUnknownJsonString(raw));
  return decoded && typeof decoded === "object"
    ? Object.fromEntries(Object.entries(decoded))
    : undefined;
};

const rpcIdFromEnvelope = (envelope: Record<string, unknown> | undefined): RpcId | undefined => {
  const id = envelope?.id;
  return typeof id === "string" || typeof id === "number" ? id : undefined;
};

const formatExit = <A>(exit: Exit.Exit<A, EffectAcpErrors.AcpError>) => {
  if (Exit.isSuccess(exit)) return { _tag: "Success", value: exit.value };

  const failure = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
  if (failure && isAcpRequestError(failure)) {
    return {
      _tag: "AcpRequestError",
      code: failure.code,
      message: failure.errorMessage,
      data: failure.data,
    };
  }
  return { _tag: "Failure", cause: Cause.pretty(exit.cause) };
};

const logJson = (label: string, value: unknown) =>
  Console.log(`${label}:`, JSON.stringify(value, null, 2));

const selectPermission = (
  request: EffectAcpSchema.RequestPermissionRequest,
): EffectAcpSchema.RequestPermissionResponse => {
  const selected =
    request.options.find((option) => option.kind === "allow_always") ??
    request.options.find((option) => option.kind === "allow_once");
  return selected
    ? { outcome: { outcome: "selected", optionId: selected.optionId } }
    : { outcome: { outcome: "cancelled" } };
};

describe.runIf(process.env.T3_CURSOR_ACP_PROBE === "1")("Cursor ACP CLI probe", () => {
  it.live(
    "measures raw overlapping session prompts",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-cursor-acp-probe-" });
        const handle = yield* spawner.spawn(
          ChildProcess.make("cursor-agent", ["acp"], {
            cwd,
            shell: false,
          }),
        );
        const firstPromptSent = yield* Deferred.make<void>();
        const secondPromptSent = yield* Deferred.make<void>();
        const responseById = new Map<RpcId, unknown>();
        let promptRequestCount = 0;
        let queuedPromptCount = 0;
        let firstPromptRequestId: RpcId | undefined;
        let secondPromptRequestId: RpcId | undefined;
        let secondPromptQueuedAt: number | undefined;
        let firstPromptSettledAt: number | undefined;
        let secondPromptSettledAt: number | undefined;
        let firstMarkerSeenAt: number | undefined;
        let secondMarkerSeenAt: number | undefined;

        const logger = (event: EffectAcpProtocol.AcpProtocolLogEvent) =>
          Effect.gen(function* () {
            if (event.stage !== "raw") return;
            const raw = typeof event.payload === "string" ? event.payload : "";
            const envelope = rpcEnvelope(raw);
            const id = rpcIdFromEnvelope(envelope);
            const receivedAt = yield* Clock.currentTimeMillis;
            const isResponse =
              envelope?.method === undefined &&
              (Object.hasOwn(envelope ?? {}, "result") || Object.hasOwn(envelope ?? {}, "error"));

            if (event.direction === "incoming" && id !== undefined && isResponse) {
              responseById.set(id, envelope);
            }
            if (event.direction === "incoming") {
              if (raw.includes("FIRST_DONE")) firstMarkerSeenAt ??= receivedAt;
              if (raw.includes("SECOND_SEEN")) secondMarkerSeenAt ??= receivedAt;
            }
            if (event.direction === "outgoing" && envelope?.method === "session/prompt") {
              promptRequestCount += 1;
              if (promptRequestCount === 1) {
                firstPromptRequestId = id;
              } else if (promptRequestCount === 2) {
                secondPromptRequestId = id;
              }
            }
            if (
              event.direction === "outgoing" ||
              id !== undefined ||
              envelope?.method === "session/update"
            ) {
              yield* Console.log(`ACP ${event.direction} raw:`, raw.trim());
            }
          });

        const onOutgoingQueued = (event: EffectAcpProtocol.AcpOutgoingQueuedEvent) =>
          event.method !== "session/prompt"
            ? Effect.void
            : Effect.gen(function* () {
                queuedPromptCount += 1;
                if (queuedPromptCount === 1) {
                  yield* Deferred.succeed(firstPromptSent, undefined);
                } else if (queuedPromptCount === 2) {
                  secondPromptQueuedAt = yield* Clock.currentTimeMillis;
                  yield* Deferred.succeed(secondPromptSent, undefined);
                }
              });

        const acpLayer = EffectAcpClient.layerChildProcess(handle, {
          logIncoming: true,
          logOutgoing: true,
          logger,
          onOutgoingQueued,
        });
        let cleanup = Effect.void;

        yield* Effect.gen(function* () {
          const acp = yield* EffectAcpClient.AcpClient;
          yield* acp.handleRequestPermission((request) =>
            Effect.succeed(selectPermission(request)),
          );

          const initialized = yield* acp.agent.initialize({
            protocolVersion: 1,
            clientCapabilities: {
              fs: { readTextFile: false, writeTextFile: false },
              terminal: false,
              _meta: { parameterizedModelPicker: true },
            },
            clientInfo: { name: "t3-cursor-overlap-probe", version: "0.0.0" },
          });
          yield* logJson("initialize response", initialized);

          const authentication = yield* acp.agent
            .authenticate({ methodId: "cursor_login" })
            .pipe(Effect.exit, Effect.timeoutOption("10 seconds"));
          yield* logJson(
            "authentication outcome",
            Option.match(authentication, {
              onNone: () => ({ _tag: "PendingAfter10Seconds" }),
              onSome: formatExit,
            }),
          );
          if (Option.isNone(authentication)) {
            yield* logJson("overlap verdict", {
              verdict: "unavailable",
              reason: "authentication-pending-after-10-seconds",
            });
            return;
          }
          if (Exit.isFailure(authentication.value)) {
            yield* logJson("overlap verdict", {
              verdict: "unavailable",
              reason: "authentication-failed",
              outcome: formatExit(authentication.value),
            });
            return;
          }
          const session = yield* acp.agent.createSession({ cwd, mcpServers: [] });
          cleanup = acp.agent.cancel({ sessionId: session.sessionId }).pipe(Effect.ignore);
          yield* logJson("session/new response", session);
          expect(typeof session.sessionId).toBe("string");

          const firstPromptFiber = yield* acp.agent
            .prompt(
              prompt(
                session.sessionId,
                "Use the shell to run: sleep 10. Reply FIRST_DONE only after it finishes.",
              ),
            )
            .pipe(
              Effect.exit,
              Effect.tap(() =>
                Clock.currentTimeMillis.pipe(
                  Effect.tap((settledAt) =>
                    Effect.sync(() => {
                      firstPromptSettledAt = settledAt;
                    }),
                  ),
                ),
              ),
              Effect.forkScoped,
            );
          const firstSent = yield* Deferred.await(firstPromptSent).pipe(
            Effect.timeoutOption("5 seconds"),
          );
          if (Option.isNone(firstSent)) {
            yield* logJson("overlap verdict", { verdict: "unavailable", reason: "first-unsent" });
            return;
          }

          const secondSentAt = yield* Clock.currentTimeMillis;
          const secondPromptFiber = yield* acp.agent
            .prompt(
              prompt(session.sessionId, "This prompt overlaps the active turn. Reply SECOND_SEEN."),
            )
            .pipe(
              Effect.exit,
              Effect.tap(() =>
                Clock.currentTimeMillis.pipe(
                  Effect.tap((settledAt) =>
                    Effect.sync(() => {
                      secondPromptSettledAt = settledAt;
                    }),
                  ),
                ),
              ),
              Effect.forkScoped,
            );
          const secondSent = yield* Deferred.await(secondPromptSent).pipe(
            Effect.timeoutOption("5 seconds"),
          );
          if (Option.isNone(secondSent)) {
            yield* logJson("overlap verdict", { verdict: "unavailable", reason: "second-unsent" });
            return;
          }
          yield* logJson("session/prompt request IDs", {
            first: firstPromptRequestId,
            second: secondPromptRequestId,
          });

          const secondAfterThreeSeconds = yield* Fiber.join(secondPromptFiber).pipe(
            Effect.timeoutOption("3 seconds"),
          );
          const overlapCheckedAt = yield* Clock.currentTimeMillis;
          yield* logJson("overlap sample after 3 seconds", {
            elapsedMs: overlapCheckedAt - secondSentAt,
            firstPromptActive: firstPromptSettledAt === undefined,
            outcome: Option.match(secondAfterThreeSeconds, {
              onNone: () => ({ _tag: "PendingAfter3Seconds" }),
              onSome: (exit) =>
                (secondPromptRequestId === undefined
                  ? undefined
                  : responseById.get(secondPromptRequestId)) ?? formatExit(exit),
            }),
          });

          const firstOutcome = yield* Fiber.join(firstPromptFiber).pipe(
            Effect.timeoutOption("60 seconds"),
          );
          const firstObservedAt = yield* Clock.currentTimeMillis;
          yield* logJson("first prompt settlement", {
            elapsedSinceSecondMs: firstObservedAt - secondSentAt,
            responseSettledAt: firstPromptSettledAt,
            markerSeenAt: firstMarkerSeenAt,
            outcome: Option.match(firstOutcome, {
              onNone: () => ({ _tag: "PendingAfter60Seconds" }),
              onSome: (exit) =>
                (firstPromptRequestId === undefined
                  ? undefined
                  : responseById.get(firstPromptRequestId)) ?? formatExit(exit),
            }),
          });

          if (Option.isNone(firstOutcome)) {
            yield* acp.agent.cancel({ sessionId: session.sessionId }).pipe(Effect.ignore);
          }

          const secondOutcome = Option.isSome(secondAfterThreeSeconds)
            ? secondAfterThreeSeconds
            : yield* Fiber.join(secondPromptFiber).pipe(Effect.timeoutOption("30 seconds"));
          const secondObservedAt = yield* Clock.currentTimeMillis;
          yield* logJson("second prompt final settlement", {
            elapsedSinceSecondMs: secondObservedAt - secondSentAt,
            responseSettledAt: secondPromptSettledAt,
            markerSeenAt: secondMarkerSeenAt,
            outcome: Option.match(secondOutcome, {
              onNone: () => ({ _tag: "PendingAfterFirstSettlement" }),
              onSome: (exit) =>
                (secondPromptRequestId === undefined
                  ? undefined
                  : responseById.get(secondPromptRequestId)) ?? formatExit(exit),
            }),
          });

          const firstSteerBoundaryAt = firstMarkerSeenAt ?? firstPromptSettledAt;
          const secondEndedAt = secondMarkerSeenAt ?? secondPromptSettledAt;
          const secondResponse =
            secondPromptRequestId === undefined
              ? undefined
              : responseById.get(secondPromptRequestId);
          const rejected =
            secondResponse !== undefined &&
            typeof secondResponse === "object" &&
            secondResponse !== null &&
            "error" in secondResponse;
          const overlapProven =
            secondPromptQueuedAt !== undefined &&
            firstPromptSettledAt !== undefined &&
            secondPromptQueuedAt < firstPromptSettledAt;
          const steerOverlapProven =
            secondPromptQueuedAt !== undefined &&
            firstSteerBoundaryAt !== undefined &&
            secondPromptQueuedAt < firstSteerBoundaryAt;
          const verdict =
            rejected && overlapProven
              ? "rejects"
              : secondMarkerSeenAt !== undefined &&
                  steerOverlapProven &&
                  secondMarkerSeenAt < firstSteerBoundaryAt
                ? "steers"
                : overlapProven &&
                    firstPromptSettledAt !== undefined &&
                    secondEndedAt !== undefined &&
                    secondEndedAt >= firstPromptSettledAt
                  ? "queues"
                  : "inconclusive";
          yield* logJson("overlap verdict", {
            verdict,
            firstSteerBoundaryAt,
            firstSettledBoundaryAt: firstPromptSettledAt,
            secondPromptQueuedAt,
            overlapProven,
            secondEndedAt,
            secondResponse,
          });

          if (Option.isNone(secondOutcome)) {
            yield* acp.agent.cancel({ sessionId: session.sessionId }).pipe(Effect.ignore);
            yield* Fiber.interrupt(secondPromptFiber);
          }
          if (Option.isNone(firstOutcome)) yield* Fiber.interrupt(firstPromptFiber);
        }).pipe(Effect.ensuring(Effect.suspend(() => cleanup)), Effect.provide(acpLayer));
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    120_000,
  );

  it.effect("initialize and authenticate against real cursor-agent acp", () =>
    Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime.AcpSessionRuntime;
      const started = yield* runtime.start();
      expect(started.initializeResult).toBeDefined();
    }).pipe(
      Effect.provide(
        AcpSessionRuntime.layer({
          spawn: {
            command: "cursor-agent",
            args: ["acp"],
            cwd: process.cwd(),
          },
          cwd: process.cwd(),
          clientCapabilities: {
            _meta: {
              parameterizedModelPicker: true,
            },
          },
          clientInfo: { name: "t3-probe", version: "0.0.0" },
          authMethodId: "cursor_login",
        }),
      ),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    ),
  );

  it.effect("session/new returns configOptions with a model selector", () =>
    Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime.AcpSessionRuntime;
      const started = yield* runtime.start();
      const result = started.sessionSetupResult;
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      yield* Console.log("session/new result:", JSON.stringify(result, null, 2));

      expect(typeof started.sessionId).toBe("string");

      const configOptions = result.configOptions;
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      yield* Console.log("session/new configOptions:", JSON.stringify(configOptions, null, 2));

      if (Array.isArray(configOptions)) {
        const modelConfig = configOptions.find((opt) => opt.category === "model");
        const parameterizedOptions = configOptions.filter(
          (opt) =>
            opt.category === "thought_level" ||
            opt.category === "model_option" ||
            opt.category === "model_config",
        );
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        yield* Console.log("Model config option:", JSON.stringify(modelConfig, null, 2));
        yield* Console.log(
          "Parameterized model config options:",
          // @effect-diagnostics-next-line preferSchemaOverJson:off
          JSON.stringify(parameterizedOptions, null, 2),
        );
        expect(modelConfig).toBeDefined();
        expect(typeof modelConfig?.id).toBe("string");
      }
    }).pipe(
      Effect.provide(
        AcpSessionRuntime.layer({
          authMethodId: "cursor_login",
          spawn: {
            command: "cursor-agent",
            args: ["acp"],
            cwd: process.cwd(),
          },
          cwd: process.cwd(),
          clientCapabilities: {
            _meta: {
              parameterizedModelPicker: true,
            },
          },
          clientInfo: { name: "t3-probe", version: "0.0.0" },
        }),
      ),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    ),
  );

  it.effect("session/set_config_option switches the model in-session", () =>
    Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime.AcpSessionRuntime;
      const started = yield* runtime.start();
      const newResult = started.sessionSetupResult;

      const configOptions = newResult.configOptions;
      let modelConfigId = "model";
      if (Array.isArray(configOptions)) {
        const modelConfig = configOptions.find((opt) => opt.category === "model");
        if (typeof modelConfig?.id === "string") {
          modelConfigId = modelConfig.id;
        }
      }

      const setResult: EffectAcpSchema.SetSessionConfigOptionResponse =
        yield* runtime.setConfigOption(modelConfigId, "gpt-5.4");
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      yield* Console.log("session/set_config_option result:", JSON.stringify(setResult, null, 2));

      if (Array.isArray(setResult.configOptions)) {
        const modelConfig = setResult.configOptions.find((opt) => opt.category === "model");
        const parameterizedOptions = setResult.configOptions.filter(
          (opt) =>
            opt.category === "thought_level" ||
            opt.category === "model_option" ||
            opt.category === "model_config",
        );
        if (modelConfig?.type === "select") {
          expect(modelConfig.currentValue).toBe("gpt-5.4");
        }
        expect(parameterizedOptions.length).toBeGreaterThan(0);
      }
    }).pipe(
      Effect.provide(
        AcpSessionRuntime.layer({
          authMethodId: "cursor_login",
          spawn: {
            command: "cursor-agent",
            args: ["acp"],
            cwd: process.cwd(),
          },
          cwd: process.cwd(),
          clientCapabilities: {
            _meta: {
              parameterizedModelPicker: true,
            },
          },
          clientInfo: { name: "t3-probe", version: "0.0.0" },
        }),
      ),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    ),
  );
});
