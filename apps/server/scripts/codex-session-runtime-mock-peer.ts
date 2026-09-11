#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";

const requestLogPath = process.env.T3_CODEX_RUNTIME_REQUEST_LOG_PATH;
const scenario = process.env.T3_CODEX_RUNTIME_SCENARIO ?? "steer-success";
const providerThreadId = "provider-thread-1";
const resumedThreadId = "resumed-thread-1";
const forkedThreadId = "forked-thread-1";
const startedTurnId = "started-turn-1";
let turnStartCount = 0;

function makeThreadOpenResult(threadId: string) {
  return {
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
      id: threadId,
      modelProvider: "openai",
      preview: "",
      projectId: null,
      sessionId: "session-1",
      source: "cli",
      turns: [],
      status: { type: "idle" },
      updatedAt: 1,
    },
  };
}

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

function emitSubAgentActivityScenario(): void {
  writeMessage({
    method: "item/started",
    params: {
      item: {
        agentPath: "root/child",
        agentThreadId: "child-thread-1",
        id: "child-activity-1",
        kind: "started",
        type: "subAgentActivity",
      },
      startedAtMs: 1,
      threadId: providerThreadId,
      turnId: startedTurnId,
    },
  });
  writeMessage({
    method: "turn/started",
    params: {
      threadId: "child-thread-1",
      turn: makeTurn("child-turn-1"),
    },
  });
  writeMessage({
    method: "item/started",
    params: {
      item: {
        agentPath: "root/child/nested",
        agentThreadId: "nested-thread-1",
        id: "nested-activity-1",
        kind: "started",
        type: "subAgentActivity",
      },
      startedAtMs: 2,
      threadId: "child-thread-1",
      turnId: "child-turn-1",
    },
  });
  writeMessage({
    method: "turn/started",
    params: {
      threadId: "nested-thread-1",
      turn: makeTurn("nested-turn-1"),
    },
  });
  writeMessage({
    method: "turn/diff/updated",
    params: {
      diff: "nested diff",
      threadId: "nested-thread-1",
      turnId: "nested-turn-1",
    },
  });
  writeMessage({
    method: "turn/diff/updated",
    params: {
      diff: "child diff",
      threadId: "child-thread-1",
      turnId: "child-turn-1",
    },
  });
  writeMessage({
    method: "turn/diff/updated",
    params: {
      diff: "root diff",
      threadId: providerThreadId,
      turnId: startedTurnId,
    },
  });
  writeMessage({
    method: "turn/completed",
    params: {
      threadId: "child-thread-1",
      turn: { ...makeTurn("child-turn-1"), status: "completed" },
    },
  });
  writeMessage({
    method: "turn/completed",
    params: {
      threadId: "nested-thread-1",
      turn: { ...makeTurn("nested-turn-1"), status: "completed" },
    },
  });
}

function emitNonStartingSubAgentActivityScenario(): void {
  for (const [index, kind] of ["interacted", "interrupted"].entries()) {
    const agentThreadId = `${kind}-thread-1`;
    writeMessage({
      method: "item/started",
      params: {
        item: {
          agentPath: `root/${kind}`,
          agentThreadId,
          id: `${kind}-activity-1`,
          kind,
          type: "subAgentActivity",
        },
        startedAtMs: index + 1,
        threadId: providerThreadId,
        turnId: startedTurnId,
      },
    });
    writeMessage({
      method: "turn/started",
      params: {
        threadId: agentThreadId,
        turn: makeTurn(`${kind}-turn-1`),
      },
    });
  }
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
    // `thread/start` and `thread/resume` stay out of the request log: several
    // tests assert the whole logged method list and expect it to start at the
    // first turn.
    case "thread/start":
      respond(id, makeThreadOpenResult(providerThreadId));
      return;
    case "thread/resume":
      if (scenario === "resume-missing-thread") {
        respondError(id, -32603, "no such thread");
        return;
      }
      if (scenario === "resume-transport-failure") {
        respondError(id, -32603, "timed out waiting for server");
        return;
      }
      if (scenario === "resume-active-writer") {
        respondError(id, -32603, `thread ${resumedThreadId} already has an active writer`);
        return;
      }
      respond(id, makeThreadOpenResult(resumedThreadId));
      return;
    case "thread/fork":
      respond(id, makeThreadOpenResult(forkedThreadId));
      return;
    case "thread/unsubscribe":
      logRequest(method, message.params);
      respond(id, { status: "unsubscribed" });
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
      if (turnStartCount === 1 && scenario === "sub-agent-activity") {
        emitSubAgentActivityScenario();
      }
      if (turnStartCount === 1 && scenario === "non-starting-sub-agent-activity") {
        emitNonStartingSubAgentActivityScenario();
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
