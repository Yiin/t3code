// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect } from "vite-plus/test";

import {
  makePrimeRpcTransport,
  PrimeRpcClosedError,
  PrimeRpcProcessError,
  PrimeRpcProtocolError,
  PrimeRpcRequestTimeoutError,
  type PrimeRpcTransportOptions,
} from "./PrimeRpcTransport.ts";

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/prime-rpc-mock.ts");
const isPrimeRpcClosedError = Schema.is(PrimeRpcClosedError);
const isPrimeRpcProcessError = Schema.is(PrimeRpcProcessError);
const isPrimeRpcProtocolError = Schema.is(PrimeRpcProtocolError);
const isPrimeRpcRequestTimeoutError = Schema.is(PrimeRpcRequestTimeoutError);

function makeTransport(scenario = "default", overrides: Partial<PrimeRpcTransportOptions> = {}) {
  return makePrimeRpcTransport({
    binaryPath: "node",
    binaryArgs: [mockAgentPath],
    launchArgs: ["--name", "literal value; no shell expansion"],
    cwd: process.cwd(),
    environment: {
      ...process.env,
      T3_PRIME_RPC_SCENARIO: scenario,
    },
    requestTimeoutMs: 2_000,
    ...overrides,
  });
}

describe("PrimeRpcTransport", () => {
  it.effect("correlates concurrent responses and publishes interleaved events", () =>
    Effect.gen(function* () {
      const transport = yield* makeTransport();
      const [state, models] = yield* Effect.all(
        [transport.getState(), transport.getAvailableModels()],
        { concurrency: "unbounded" },
      );
      const events = Array.from(yield* Stream.runCollect(Stream.take(transport.events, 3)));

      expect(state.sessionId).toBe("prime-session");
      expect(state.mockArgv).toEqual([
        "--mode",
        "rpc",
        "--name",
        "literal value; no shell expansion",
      ]);
      expect(models).toEqual([{ provider: "prime", id: "prime-model", name: "Prime Model" }]);
      expect(events.map((event) => event.type)).toEqual([
        "mock_before_response",
        "mock_models_sent",
        "mock_after_response",
      ]);
      expect(events[0]?.text).toBe("line\u2028separator");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("exposes every adapter operation and accepts partial response chunks", () =>
    Effect.gen(function* () {
      const transport = yield* makeTransport();

      expect(yield* transport.setModel({ provider: "prime", modelId: "next-model" })).toEqual({
        provider: "prime",
        id: "next-model",
      });
      yield* transport.setThinkingLevel("high");
      yield* transport.prompt({ message: "hello" });
      yield* transport.steer({ message: "change course" });
      yield* transport.followUp({ message: "then continue" });
      yield* transport.abort;
      expect(yield* transport.getMessages()).toEqual([{ role: "user", content: "hello" }]);
      expect(yield* transport.getForkMessages()).toEqual([{ entryId: "entry-1", text: "hello" }]);
      expect(yield* transport.fork("entry-1")).toEqual({ text: "hello", cancelled: false });

      yield* transport.respondToExtensionUi({ id: "ui-1", confirmed: true });
      const extensionEvent = yield* Stream.runHead(
        transport.events.pipe(Stream.filter((event) => event.type === "mock_extension_response")),
      );
      expect(extensionEvent._tag).toBe("Some");
      if (extensionEvent._tag === "Some") {
        expect(extensionEvent.value.response).toMatchObject({
          type: "extension_ui_response",
          id: "ui-1",
          confirmed: true,
        });
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("fails malformed records and oversized incomplete records", () =>
    Effect.gen(function* () {
      const malformed = yield* makeTransport("malformed");
      const malformedError = yield* malformed.getState().pipe(Effect.flip);
      expect(malformedError._tag).toBe("PrimeRpcProtocolError");
      if (isPrimeRpcProtocolError(malformedError)) {
        expect(malformedError.message).toContain("malformed JSON");
      }

      const oversized = yield* makeTransport("oversized", { maxRecordBytes: 64 });
      const oversizedError = yield* oversized.getState().pipe(Effect.flip);
      expect(oversizedError._tag).toBe("PrimeRpcProtocolError");
      if (isPrimeRpcProtocolError(oversizedError)) {
        expect(oversizedError.message).toContain("exceeded 64 bytes");
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("distinguishes clean EOF from a nonzero process exit", () =>
    Effect.gen(function* () {
      const eof = yield* makeTransport("eof");
      const eofError = yield* eof.getState().pipe(Effect.flip);
      expect(eofError).toMatchObject({
        _tag: "PrimeRpcProcessError",
        reason: "eof",
        exitCode: 0,
      });

      const exited = yield* makeTransport("exit", { maxStderrBytes: 26 });
      const exitError = yield* exited.getState().pipe(Effect.flip);
      expect(exitError._tag).toBe("PrimeRpcProcessError");
      expect(exitError).toMatchObject({ reason: "exit", exitCode: 7 });
      if (isPrimeRpcProcessError(exitError)) {
        expect(exitError.stderr).toContain("[REDACTED]");
        expect(exitError.stderr).not.toContain("super-secret-value");
        expect(exitError.stderrTruncated).toBe(true);
        expect(Buffer.byteLength(exitError.stderr)).toBeLessThanOrEqual(26);
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("times out a request without poisoning later requests", () =>
    Effect.gen(function* () {
      const transport = yield* makeTransport("timeout", { requestTimeoutMs: 50 });
      const request = yield* transport
        .getState()
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* TestClock.adjust("50 millis");
      const timeout = yield* Fiber.join(request).pipe(Effect.flip);
      expect(isPrimeRpcRequestTimeoutError(timeout)).toBe(true);
      expect(yield* transport.getAvailableModels()).toHaveLength(1);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("removes interrupted requests and ignores their late responses", () =>
    Effect.gen(function* () {
      const transport = yield* makeTransport("delayed");
      const request = yield* transport
        .getState()
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(request);

      expect(yield* transport.getAvailableModels()).toHaveLength(1);
      expect(yield* transport.getMessages()).toHaveLength(1);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("fails pending and future requests when closed", () =>
    Effect.gen(function* () {
      const transport = yield* makeTransport("timeout");
      const request = yield* transport
        .getState()
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Effect.yieldNow;
      yield* transport.close;

      const pendingExit = yield* Fiber.await(request);
      expect(Exit.isFailure(pendingExit)).toBe(true);
      if (Exit.isFailure(pendingExit)) {
        expect(isPrimeRpcClosedError(Cause.squash(pendingExit.cause))).toBe(true);
      }
      expect(isPrimeRpcClosedError(yield* transport.getMessages().pipe(Effect.flip))).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("closes with its owning scope", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const transport = yield* makeTransport().pipe(Effect.provideService(Scope.Scope, scope));

      yield* Scope.close(scope, Exit.void);

      expect(isPrimeRpcClosedError(yield* transport.getState().pipe(Effect.flip))).toBe(true);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
