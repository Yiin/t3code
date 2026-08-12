/**
 * Optional integration check against a real `grok agent stdio` install.
 * Enable with:
 * T3_GROK_ACP_PROBE=1 vp test run apps/server/src/provider/acp/GrokAcpCliProbe.test.ts
 *
 * The probe assumes either `XAI_API_KEY` is set in the environment or
 * the user has previously run `grok login`. Without credentials the
 * agent's `authenticate` request will fail and the test will surface
 * the error.
 * The overlap check measures the raw CLI beneath XAiAcpExtension. That
 * production wrapper serializes prompts before they reach the CLI.
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
import type * as EffectAcpSchema from "effect-acp/schema";
import { describe, expect } from "vite-plus/test";

import { makeGrokAcpRuntime } from "./GrokAcpSupport.ts";

type RpcId = string | number;

const decodeUnknownJsonString = Schema.decodeUnknownOption(Schema.UnknownFromJsonString);
const isAcpRequestError = Schema.is(EffectAcpErrors.AcpRequestError);

const prompt = (
  sessionId: string,
  text: string,
  promptId: string,
): EffectAcpSchema.PromptRequest => ({
  sessionId,
  prompt: [{ type: "text", text }],
  _meta: { promptId, requestId: promptId },
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

const formatExit = <A>(exit: Exit.Exit<A, EffectAcpErrors.AcpError>): unknown => {
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

const makeProbeRuntime = Effect.gen(function* () {
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* makeGrokAcpRuntime({
    grokSettings: { binaryPath: "grok" },
    environment: process.env,
    childProcessSpawner,
    cwd: process.cwd(),
    clientInfo: { name: "t3-grok-probe", version: "0.0.0" },
  });
});

describe.runIf(process.env.T3_GROK_ACP_PROBE === "1")("Grok ACP CLI probe", () => {
  it.live(
    "measures raw overlapping session prompts",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-grok-acp-probe-" });
        const handle = yield* spawner.spawn(
          ChildProcess.make("grok", ["agent", "stdio"], {
            cwd,
            env: { ...process.env, GROK_OAUTH2_REFERRER: "t3code" },
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
        const xAiCompletionByPromptId = new Map<string, number>();

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
            if (
              event.direction === "incoming" &&
              envelope?.method === "_x.ai/session/prompt_complete"
            ) {
              const params = envelope.params;
              if (params && typeof params === "object" && "promptId" in params) {
                const promptId = params.promptId;
                if (typeof promptId === "string") {
                  xAiCompletionByPromptId.set(promptId, receivedAt);
                }
              }
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
              envelope?.method === "session/update" ||
              envelope?.method === "_x.ai/session/prompt_complete"
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
            },
            clientInfo: { name: "t3-grok-overlap-probe", version: "0.0.0" },
          });
          yield* logJson("initialize response", initialized);

          const advertisedAuthMethodIds = (initialized.authMethods ?? []).map(
            (method) => method.id,
          );
          const preferredAuthMethodId = process.env.XAI_API_KEY?.trim()
            ? "xai.api_key"
            : "cached_token";
          const authMethodId = advertisedAuthMethodIds.includes(preferredAuthMethodId)
            ? preferredAuthMethodId
            : advertisedAuthMethodIds[0];
          if (!authMethodId) {
            yield* logJson("authentication outcome", { _tag: "NoAdvertisedAuthMethod" });
            yield* logJson("overlap verdict", {
              verdict: "unavailable",
              reason: "no-advertised-auth-method",
            });
            return;
          }
          yield* logJson("selected auth method", authMethodId);
          const authentication = yield* acp.agent
            .authenticate({ methodId: authMethodId })
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
                "t3-grok-overlap-1",
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
              prompt(
                session.sessionId,
                "This prompt overlaps the active turn. Reply SECOND_SEEN.",
                "t3-grok-overlap-2",
              ),
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
          const firstEndedAtAfterThreeSeconds =
            xAiCompletionByPromptId.get("t3-grok-overlap-1") ?? firstPromptSettledAt;
          yield* logJson("overlap sample after 3 seconds", {
            elapsedMs: overlapCheckedAt - secondSentAt,
            firstPromptActive: firstEndedAtAfterThreeSeconds === undefined,
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
            xAiCompletedAt: xAiCompletionByPromptId.get("t3-grok-overlap-1"),
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
            xAiCompletedAt: xAiCompletionByPromptId.get("t3-grok-overlap-2"),
            markerSeenAt: secondMarkerSeenAt,
            outcome: Option.match(secondOutcome, {
              onNone: () => ({ _tag: "PendingAfterFirstSettlement" }),
              onSome: (exit) =>
                (secondPromptRequestId === undefined
                  ? undefined
                  : responseById.get(secondPromptRequestId)) ?? formatExit(exit),
            }),
          });

          const firstSettledBoundaryAt =
            xAiCompletionByPromptId.get("t3-grok-overlap-1") ?? firstPromptSettledAt;
          const firstSteerBoundaryAt = firstMarkerSeenAt ?? firstSettledBoundaryAt;
          const secondEndedAt =
            secondMarkerSeenAt ??
            xAiCompletionByPromptId.get("t3-grok-overlap-2") ??
            secondPromptSettledAt;
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
            firstSettledBoundaryAt !== undefined &&
            secondPromptQueuedAt < firstSettledBoundaryAt;
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
                    secondEndedAt !== undefined &&
                    secondEndedAt >= firstSettledBoundaryAt
                  ? "queues"
                  : "inconclusive";
          yield* logJson("overlap verdict", {
            verdict,
            firstSteerBoundaryAt,
            firstSettledBoundaryAt,
            secondPromptQueuedAt,
            overlapProven,
            secondEndedAt,
            secondResponse,
            note: "Raw CLI result; XAiAcpExtension serialization is excluded.",
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

  it.effect("initialize and authenticate against real grok agent stdio", () =>
    Effect.gen(function* () {
      const runtime = yield* makeProbeRuntime;
      const started = yield* runtime.start();
      expect(started.initializeResult).toBeDefined();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("session/new advertises typed SessionModelState with at least one model", () =>
    Effect.gen(function* () {
      const runtime = yield* makeProbeRuntime;
      const started = yield* runtime.start();
      const result = started.sessionSetupResult;

      expect(typeof started.sessionId).toBe("string");

      // Modern grok-shell advertises models through the typed
      // `SessionModelState` field, not via a `configOptions` entry.
      // If this assertion fails the upstream surface has regressed.
      const models = result.models;
      expect(models).toBeDefined();
      expect(typeof models?.currentModelId).toBe("string");
      expect(models?.availableModels.length ?? 0).toBeGreaterThan(0);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("session/set_model accepts a no-op switch to the current model", () =>
    Effect.gen(function* () {
      const runtime = yield* makeProbeRuntime;
      const started = yield* runtime.start();
      const currentModelId = started.sessionSetupResult.models?.currentModelId?.trim();
      expect(currentModelId).toBeDefined();
      if (!currentModelId) return;

      // No-op switch — selecting the model the session already runs on must
      // succeed against every Grok build that implements `session/set_model`.
      yield* runtime.setSessionModel(currentModelId);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
