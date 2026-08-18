import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

export const DEFAULT_HTTP_READY_PROBE_TIMEOUT_MS = 1_000;

/** Structured form of one link in a readiness failure chain. */
export interface ReadinessCauseRecord {
  readonly _tag?: string;
  readonly name?: string;
  readonly message?: string;
  readonly reason?: ReadinessCauseDescription;
  readonly cause?: ReadinessCauseDescription;
}

/** A readiness failure reduced to a value that logs and JSON round-trip cleanly. */
export type ReadinessCauseDescription = ReadinessCauseRecord | string | number | boolean | null;

/**
 * Normalizes an arbitrary readiness probe failure into a plain, structured value
 * suitable for diagnostic logging. Preserves the tagged-error `_tag` (and
 * message/cause) shape for Effect tagged errors while recursing through nested
 * `cause`/`reason` chains.
 */
export function describeReadinessCause(cause: unknown): ReadinessCauseDescription {
  if (cause instanceof Error) {
    const tag = "_tag" in cause && typeof cause._tag === "string" ? cause._tag : undefined;
    const nested = "cause" in cause ? cause.cause : undefined;
    return {
      ...(tag === undefined ? { name: cause.name } : { _tag: tag }),
      message: cause.message,
      ...(nested === undefined ? {} : { cause: describeReadinessCause(nested) }),
    };
  }
  if (typeof cause === "string" || typeof cause === "number" || typeof cause === "boolean") {
    return cause;
  }
  if (cause === null || cause === undefined) {
    return null;
  }
  if (typeof cause !== "object") {
    // bigint, symbol, and function are not JSON-safe, so record their text form.
    return String(cause);
  }

  const tag = "_tag" in cause && typeof cause._tag === "string" ? cause._tag : undefined;
  const message =
    "message" in cause && typeof cause.message === "string" ? cause.message : undefined;
  const reason = "reason" in cause ? cause.reason : undefined;
  const nested = "cause" in cause ? cause.cause : undefined;
  return {
    ...(tag === undefined ? {} : { _tag: tag }),
    ...(message === undefined ? {} : { message }),
    ...(reason === undefined ? {} : { reason: describeReadinessCause(reason) }),
    ...(nested === undefined ? {} : { cause: describeReadinessCause(nested) }),
  };
}

/**
 * Generic HTTP readiness probe shared by the SSH tunnel and the desktop backend
 * manager. Polls `baseUrl + path` until it returns a 2xx response or the overall
 * `timeoutMs` elapses. Each individual probe is bounded by `probeTimeoutMs` so a
 * single hung request cannot stall the retry loop, and the retry cadence is
 * `intervalMs` bounded to roughly `timeoutMs / intervalMs` attempts.
 *
 * The error type is left to the caller via `makeError`, so each consumer keeps
 * its own tagged error. `makeError` is called at every failure site; callers can
 * inspect `cause` (which carries a `kind` discriminator for the probe-timeout and
 * overall-timeout cases) to reproduce phase-specific messages, or ignore it.
 */
export const waitForHttpReady = Effect.fn("shared.httpReadiness.waitForHttpReady")(function* <
  E,
>(input: {
  readonly baseUrl: string;
  readonly path?: string;
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
  readonly probeTimeoutMs?: number;
  readonly makeError: (info: {
    readonly requestUrl: string;
    readonly probeTimeoutMs: number;
    readonly attempt: number;
    readonly cause: unknown;
  }) => E;
}): Effect.fn.Return<void, E, HttpClient.HttpClient> {
  const timeoutMs = input.timeoutMs ?? 30_000;
  const intervalMs = input.intervalMs ?? 100;
  const probeTimeoutMs = input.probeTimeoutMs ?? DEFAULT_HTTP_READY_PROBE_TIMEOUT_MS;
  const retryPolicy = Schedule.spaced(Duration.millis(intervalMs)).pipe(
    Schedule.take(Math.max(0, Math.ceil(timeoutMs / intervalMs))),
  );
  const requestUrl = new URL(input.path ?? "/", input.baseUrl).toString();
  const client = yield* HttpClient.HttpClient;
  const lastProbeFailure = yield* Ref.make<unknown>(null);
  let attempt = 0;

  // Tracks errors this function itself produced via `makeError`, so the
  // pass-through guards below never double-wrap an already-constructed error
  // (mirrors the SSH original's `cause instanceof SshReadinessError` checks).
  const makeError = input.makeError;
  const madeErrors = new WeakSet<object>();
  const fail = (cause: unknown): E => {
    const error = makeError({ requestUrl, probeTimeoutMs, attempt, cause });
    if (typeof error === "object" && error !== null) {
      madeErrors.add(error);
    }
    return error;
  };
  const isMadeError = (value: unknown): value is E =>
    typeof value === "object" && value !== null && madeErrors.has(value);

  yield* Effect.logDebug("httpReadiness.start", {
    baseUrl: input.baseUrl,
    requestUrl,
    timeoutMs,
    intervalMs,
    probeTimeoutMs,
  });

  const readinessClient = client.pipe(
    HttpClient.filterStatusOk,
    HttpClient.transform((effect) =>
      Effect.gen(function* () {
        attempt += 1;
        const responseOption = yield* effect.pipe(
          Effect.timeoutOption(Duration.millis(probeTimeoutMs)),
          Effect.mapError((cause) => fail(cause)),
        );
        return yield* Option.match(responseOption, {
          onSome: Effect.succeed,
          onNone: () =>
            Effect.fail(
              fail({
                kind: "probe-timeout",
                attempt,
                probeTimeoutMs,
              }),
            ),
        });
      }).pipe(
        Effect.mapError((cause) => (isMadeError(cause) ? cause : fail(cause))),
        Effect.tapError((cause) =>
          Ref.set(lastProbeFailure, {
            attempt,
            cause: describeReadinessCause(cause),
          }),
        ),
      ),
    ),
    HttpClient.tap((response) => response.text.pipe(Effect.ignore)),
    HttpClient.retry(retryPolicy),
  );

  const result = yield* readinessClient.execute(HttpClientRequest.get(requestUrl)).pipe(
    Effect.mapError((cause) => (isMadeError(cause) ? cause : fail(cause))),
    Effect.timeoutOption(Duration.millis(timeoutMs)),
  );

  return yield* Option.match(result, {
    onSome: () =>
      Effect.logDebug("httpReadiness.succeeded", {
        baseUrl: input.baseUrl,
        requestUrl,
        attempts: attempt,
      }),
    onNone: () =>
      Effect.gen(function* () {
        const lastFailure = yield* Ref.get(lastProbeFailure);
        yield* Effect.logWarning("httpReadiness.timedOut", {
          baseUrl: input.baseUrl,
          requestUrl,
          timeoutMs,
          intervalMs,
          probeTimeoutMs,
          attempts: attempt,
          lastFailure,
        });
        return yield* Effect.fail(
          fail({
            kind: "overall-timeout",
            baseUrl: input.baseUrl,
            timeoutMs,
            lastFailure,
          }),
        );
      }),
  });
});
