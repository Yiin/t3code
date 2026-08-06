#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";

const requestLogPath = process.env.T3_CODEX_RUNTIME_REQUEST_LOG_PATH;
const scenario = process.env.T3_CODEX_RUNTIME_SCENARIO ?? "steer-success";
const providerThreadId = "provider-thread-1";
const startedTurnId = "started-turn-1";
let turnStartCount = 0;

function writeMessage(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function respond(id: number | string, result: unknown): void {
  writeMessage({ id, result });
}

function respondError(id: number | string, code: number, message: string): void {
  writeMessage({ id, error: { code, message } });
}

function logRequest(method: string, params: unknown): void {
  if (requestLogPath) {
    NodeFS.appendFileSync(requestLogPath, `${JSON.stringify({ method, params })}\n`, "utf8");
  }
}

function makeTurn(id: string) {
  return {
    id,
    items: [],
    status: "inProgress",
  };
}

function handleRequest(message: Record<string, unknown>): void {
  const id = message.id as number | string;
  const method = message.method;

  switch (method) {
    case "initialize":
      respond(id, {
        userAgent: "t3-codex-session-runtime-mock",
        codexHome: process.cwd(),
        platformFamily: "unix",
        platformOs: "linux",
      });
      return;
    case "thread/start":
      respond(id, {
        cwd: process.cwd(),
        model: "gpt-5.3-codex",
        modelProvider: "openai",
        approvalPolicy: "never",
        approvalsReviewer: "user",
        sandbox: { type: "dangerFullAccess" },
        thread: {
          cliVersion: "0.0.0-test",
          createdAt: 1,
          cwd: process.cwd(),
          ephemeral: false,
          id: providerThreadId,
          modelProvider: "openai",
          preview: "",
          sessionId: "session-1",
          source: "cli",
          turns: [],
          status: { type: "idle" },
          updatedAt: 1,
        },
      });
      return;
    case "turn/start": {
      logRequest(method, message.params);
      turnStartCount += 1;
      const responseTurnId =
        turnStartCount === 1
          ? startedTurnId
          : scenario.startsWith("steer-unsupported")
            ? "phantom-turn-2"
            : "fresh-turn-2";
      if (turnStartCount === 1 || !scenario.startsWith("steer-unsupported")) {
        writeMessage({
          method: "turn/started",
          params: {
            threadId: providerThreadId,
            turn: makeTurn(responseTurnId),
          },
        });
      }
      if (turnStartCount === 2 && scenario === "steer-unsupported-completed") {
        writeMessage({
          method: "turn/completed",
          params: {
            threadId: providerThreadId,
            turn: { ...makeTurn(startedTurnId), status: "completed" },
          },
        });
      }
      respond(id, { turn: makeTurn(responseTurnId) });
      return;
    }
    case "turn/steer":
      logRequest(method, message.params);
      if (scenario.startsWith("steer-unsupported")) {
        respondError(
          id,
          -32600,
          "Invalid request: unknown variant `turn/steer`, expected one of `initialize`, `thread/start`",
        );
        return;
      }
      if (scenario === "steer-no-active") {
        respondError(id, -32600, `no active turn found for thread ${providerThreadId}`);
        return;
      }
      if (scenario === "steer-different-active") {
        respondError(
          id,
          -32600,
          `expected active turn id \`${startedTurnId}\` but found \`different-turn\``,
        );
        return;
      }
      respond(id, { turnId: startedTurnId });
      return;
    case "turn/interrupt":
      logRequest(method, message.params);
      respond(id, {});
      return;
    default:
      if (message.id !== undefined) {
        writeMessage({ id, error: { code: -32601, message: `Unhandled request: ${method}` } });
      }
  }
}

let remainder = "";

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  remainder += chunk;
  const lines = remainder.split("\n");
  remainder = lines.pop() ?? "";

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const message = JSON.parse(trimmed) as Record<string, unknown>;
    if ("method" in message) handleRequest(message);
  }
});

process.stdin.on("end", () => process.exit(0));
