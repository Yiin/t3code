/**
 * Optional wire probe against a real `kimi acp` install.
 * Enable with:
 * T3_KIMI_ACP_PROBE=1 vp test run apps/server/src/provider/acp/KimiAcpCliProbe.test.ts
 *
 * The probe uses the raw ACP client. It intentionally bypasses
 * AcpSessionRuntime's prompt semaphore to measure Kimi's wire behavior.
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

const prompt = (sessionId: string, text: string): EffectAcpSchema.PromptRequest => ({
  sessionId,
  prompt: [{ type: "text", text }],
});
const isAcpRequestError = Schema.is(EffectAcpErrors.AcpRequestError);
const decodeUnknownJsonString = Schema.decodeUnknownOption(Schema.UnknownFromJsonString);

interface WireError {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

const wireErrorFromRaw = (raw: string): WireError | undefined => {
  const decoded = Option.getOrUndefined(decodeUnknownJsonString(raw));
  if (!decoded || typeof decoded !== "object" || !("error" in decoded)) return undefined;
  const error = decoded.error;
  if (!error || typeof error !== "object") return undefined;
  if (!("code" in error) || typeof error.code !== "number") return undefined;
  if (!("message" in error) || typeof error.message !== "string") return undefined;
  return {
    code: error.code,
    message: error.message,
    ...(error && "data" in error ? { data: error.data } : {}),
  };
};

const capabilityPaths = (value: unknown): ReadonlyArray<string> => {
  const paths: Array<string> = [];

  const visit = (current: unknown, path: string): void => {
    if (!current || typeof current !== "object") return;
    for (const [key, child] of Object.entries(current)) {
      const childPath = path ? `${path}.${key}` : key;
      if (/steer|queue/i.test(key)) paths.push(childPath);
      visit(child, childPath);
    }
  };

  visit(value, "");
  return paths;
};

const formatExit = <A>(exit: Exit.Exit<A, EffectAcpErrors.AcpError>) => {
  if (Exit.isSuccess(exit)) {
    return { _tag: "Success", value: exit.value };
  }

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

describe.runIf(process.env.T3_KIMI_ACP_PROBE === "1")("Kimi ACP CLI wire probe", () => {
  it.live(
    "measures overlapping prompts and cancel settlement",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-kimi-acp-probe-" });
        const handle = yield* spawner.spawn(
          ChildProcess.make("kimi", ["acp"], {
            cwd,
            shell: false,
          }),
        );
        const firstPromptSent = yield* Deferred.make<void>();
        let promptRequestCount = 0;
        let latestWireError: WireError | undefined;

        const logger = (event: EffectAcpProtocol.AcpProtocolLogEvent) =>
          Effect.gen(function* () {
            if (event.stage === "raw") {
              const raw = typeof event.payload === "string" ? event.payload : "";
              latestWireError = wireErrorFromRaw(raw) ?? latestWireError;
              const isResponse = event.direction === "incoming" && raw.includes('"id":');
              if (event.direction === "outgoing" || isResponse) {
                yield* Console.log(`ACP ${event.direction} raw:`, raw.trim());
              }
              if (event.direction === "outgoing" && raw.includes('"method":"session/prompt"')) {
                promptRequestCount += 1;
                if (promptRequestCount === 1) yield* Deferred.succeed(firstPromptSent, undefined);
              }
              return;
            }
          });

        const acpLayer = EffectAcpClient.layerChildProcess(handle, {
          logIncoming: true,
          logOutgoing: true,
          logger,
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
            clientInfo: { name: "t3-kimi-probe", version: "0.0.0" },
          });
          yield* logJson("initialize response", initialized);
          yield* logJson("steer/queue capability paths", capabilityPaths(initialized));

          yield* acp.agent.authenticate({ methodId: "login" });
          const session = yield* acp.agent.createSession({ cwd, mcpServers: [] });
          cleanup = acp.agent.cancel({ sessionId: session.sessionId }).pipe(Effect.ignore);
          yield* logJson("session/new response", session);
          expect(typeof session.sessionId).toBe("string");

          const firstPromptFiber = yield* acp.agent
            .prompt(prompt(session.sessionId, "use the shell to run: sleep 30"))
            .pipe(Effect.exit, Effect.forkScoped);

          yield* Deferred.await(firstPromptSent);
          latestWireError = undefined;
          const overlapFiber = yield* acp.agent
            .prompt(prompt(session.sessionId, "This prompt overlaps the active turn."))
            .pipe(Effect.exit, Effect.forkScoped);
          const overlap = yield* Fiber.join(overlapFiber).pipe(Effect.timeoutOption("3 seconds"));
          yield* logJson(
            "overlapping session/prompt outcome",
            Option.match(overlap, {
              onNone: () => ({ _tag: "PendingAfter3Seconds" }),
              onSome: (exit) => latestWireError ?? formatExit(exit),
            }),
          );

          const cancelSentAt = yield* Clock.currentTimeMillis;
          const cancelExit = yield* acp.agent
            .cancel({ sessionId: session.sessionId })
            .pipe(Effect.exit);
          yield* logJson("session/cancel outcome", formatExit(cancelExit));

          if (Option.isNone(overlap)) {
            yield* Fiber.interrupt(overlapFiber);
            const firstSettlement = yield* Fiber.join(firstPromptFiber).pipe(
              Effect.timeoutOption("10 seconds"),
            );
            const firstSettledAt = yield* Clock.currentTimeMillis;
            yield* logJson("cancel settle latency ms", firstSettledAt - cancelSentAt);
            yield* logJson(
              "cancelled prompt outcome",
              Option.match(firstSettlement, {
                onNone: () => ({ _tag: "PendingAfter10Seconds" }),
                onSome: formatExit,
              }),
            );
            return;
          }

          latestWireError = undefined;
          const immediateRepromptFiber = yield* acp.agent
            .prompt(prompt(session.sessionId, "Reply with exactly OK."))
            .pipe(Effect.exit, Effect.forkScoped);

          const firstSettlement = yield* Fiber.join(firstPromptFiber).pipe(
            Effect.timeoutOption("10 seconds"),
          );
          const firstSettledAt = yield* Clock.currentTimeMillis;
          yield* logJson("cancel settle latency ms", firstSettledAt - cancelSentAt);
          yield* logJson(
            "cancelled prompt outcome",
            Option.match(firstSettlement, {
              onNone: () => ({ _tag: "PendingAfter10Seconds" }),
              onSome: formatExit,
            }),
          );

          if (Option.isNone(firstSettlement)) {
            yield* acp.agent.cancel({ sessionId: session.sessionId }).pipe(Effect.ignore);
            yield* Fiber.interrupt(firstPromptFiber);
            yield* Fiber.interrupt(immediateRepromptFiber);
            yield* logJson("re-prompt probes", { _tag: "SkippedAfterCancelSettleTimeout" });
            return;
          }

          const immediateReprompt = yield* Fiber.join(immediateRepromptFiber).pipe(
            Effect.timeoutOption("30 seconds"),
          );
          yield* logJson(
            "same-tick post-cancel re-prompt outcome",
            Option.match(immediateReprompt, {
              onNone: () => ({ _tag: "PendingAfter30Seconds" }),
              onSome: (exit) => latestWireError ?? formatExit(exit),
            }),
          );

          if (Option.isNone(immediateReprompt)) {
            yield* acp.agent.cancel({ sessionId: session.sessionId }).pipe(Effect.ignore);
            yield* Fiber.interrupt(immediateRepromptFiber);
          }

          const postSettleReprompt = yield* acp.agent
            .prompt(prompt(session.sessionId, "Reply with exactly OK."))
            .pipe(Effect.exit, Effect.timeoutOption("30 seconds"));
          yield* logJson(
            "post-settle re-prompt outcome",
            Option.match(postSettleReprompt, {
              onNone: () => ({ _tag: "PendingAfter30Seconds" }),
              onSome: formatExit,
            }),
          );
        }).pipe(Effect.ensuring(Effect.suspend(() => cleanup)), Effect.provide(acpLayer));
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    120_000,
  );
});
