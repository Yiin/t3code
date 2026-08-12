// @effect-diagnostics nodeBuiltinImport:off
/**
 * acpSessionLifecycleProbes - request-log probes for the ACP adapter tests.
 *
 * Cursor, Grok and Kimi all drive `scripts/acp-mock-agent.ts` over a real
 * stdio pipe, so the only place their fake runtime records what it was asked
 * is the NDJSON request log the mock appends. These probes turn that log into
 * the two numbers `describeSessionLifecycleConformance` wants, so the three
 * adapter tests do not each hand-roll it.
 *
 * `AcpSessionRuntime` sends `session/new` for a fresh session and
 * `session/load` for a resume, with no fallback between them, so counting
 * `session/new` is exactly "provider-native sessions created".
 *
 * @module acpSessionLifecycleProbes
 */
import * as NodeFSP from "node:fs/promises";

import * as Effect from "effect/Effect";

const readRequests = (
  requestLogPath: string,
): Effect.Effect<ReadonlyArray<Record<string, unknown>>> =>
  Effect.tryPromise(() => NodeFSP.readFile(requestLogPath, "utf8")).pipe(
    // The mock only creates the log once it receives its first request.
    Effect.orElseSucceed(() => ""),
    Effect.map((raw) =>
      raw
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
    ),
  );

/**
 * How many `session/new` requests the mock agent has received.
 */
export const readAcpProviderSessionsCreated = (requestLogPath: string): Effect.Effect<number> =>
  readRequests(requestLogPath).pipe(
    Effect.map((requests) => requests.filter((entry) => entry.method === "session/new").length),
  );

/**
 * The session-setup requests the mock agent has received, oldest first. Tells
 * a resume that continued a conversation (`session/load`) apart from one that
 * quietly started a new one (`session/new`).
 */
export const readAcpSessionSetupMethods = (
  requestLogPath: string,
): Effect.Effect<ReadonlyArray<string>> =>
  readRequests(requestLogPath).pipe(
    Effect.map((requests) =>
      requests
        .map((entry) => entry.method)
        .filter(
          (method): method is string => method === "session/new" || method === "session/load",
        ),
    ),
  );

/**
 * The provider-native session ids that received a `session/prompt`, oldest
 * first. Waits for the first prompt to land, because `sendTurn` resolves once
 * the turn is accepted rather than once the mock has logged it.
 */
export const readAcpTurnTargets = (
  requestLogPath: string,
  attempts = 80,
): Effect.Effect<ReadonlyArray<string>> => {
  const attempt = (remaining: number): Effect.Effect<ReadonlyArray<string>> =>
    Effect.gen(function* () {
      const requests = yield* readRequests(requestLogPath);
      const targets = requests
        .filter((entry) => entry.method === "session/prompt")
        .map((entry) => (entry.params as { readonly sessionId?: string } | undefined)?.sessionId)
        .filter((sessionId): sessionId is string => typeof sessionId === "string");
      if (targets.length > 0 || remaining <= 0) {
        return targets;
      }
      yield* Effect.sleep("25 millis");
      return yield* attempt(remaining - 1);
    });
  return attempt(attempts);
};
