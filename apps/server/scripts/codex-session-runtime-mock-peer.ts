#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";

const requestLogPath = process.env.T3_CODEX_RUNTIME_REQUEST_LOG_PATH;
const providerThreadId = "provider-thread-1";
const startedTurnId = "started-turn-1";
let turnStartCount = 0;

function writeMessage(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function respond(id: number | string, result: unknown): void {
  writeMessage({ id, result });
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
      turnStartCount += 1;
      const responseTurnId = turnStartCount === 1 ? startedTurnId : "phantom-turn-2";
      if (turnStartCount === 1) {
        writeMessage({
          method: "turn/started",
          params: {
            threadId: providerThreadId,
            turn: makeTurn(startedTurnId),
          },
        });
      }
      respond(id, { turn: makeTurn(responseTurnId) });
      return;
    }
    case "turn/interrupt":
      if (requestLogPath) {
        NodeFS.appendFileSync(requestLogPath, `${JSON.stringify(message.params)}\n`, "utf8");
      }
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
