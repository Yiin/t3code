#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off
//
// Minimal `codex app-server` stand-in for `probeCodexAppServerProvider` tests.
// It answers only the requests the capability probe issues, and varies the
// `account/rateLimits/read` reply by `T3_CODEX_APP_SERVER_SCENARIO`.
import * as NodeFS from "node:fs";

const requestLogPath = process.env.T3_CODEX_APP_SERVER_REQUEST_LOG_PATH;
const scenario = process.env.T3_CODEX_APP_SERVER_SCENARIO ?? "rate-limits-ok";

function writeMessage(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function respond(id: number | string, result: unknown): void {
  writeMessage({ id, result });
}

function respondError(id: number | string, code: number, message: string): void {
  writeMessage({ id, error: { code, message } });
}

function logRequest(message: Record<string, unknown>): void {
  if (!requestLogPath) return;
  // `params` is logged only when present, so a test can tell an omitted
  // payload apart from an empty object.
  const entry =
    "params" in message
      ? { method: message.method, params: message.params }
      : { method: message.method };
  NodeFS.appendFileSync(requestLogPath, `${JSON.stringify(entry)}\n`, "utf8");
}

const rateLimitsResult = {
  rateLimits: {
    // 1787207826 is Unix seconds, seven days after the clock that read it.
    primary: { usedPercent: 12, windowDurationMins: 10080, resetsAt: 1787207826 },
    secondary: null,
    planType: "pro",
  },
};

function handleRequest(message: Record<string, unknown>): void {
  const id = message.id as number | string;
  logRequest(message);

  switch (message.method) {
    case "initialize":
      respond(id, {
        userAgent: "codex/9.9.9-mock (mock)",
        codexHome: process.cwd(),
        platformFamily: "unix",
        platformOs: "linux",
      });
      return;
    case "account/read":
      if (scenario === "account-business-premium") {
        // codex-cli 0.153 answers this way for a ChatGPT Business Premium
        // workspace login: a newer plan type, and `requiresOpenaiAuth` true
        // even though the account is present.
        respond(id, {
          account: {
            type: "chatgpt",
            email: "probe@example.com",
            planType: "self_serve_business_prolite",
          },
          requiresOpenaiAuth: true,
        });
        return;
      }
      respond(id, {
        account: { type: "chatgpt", email: "probe@example.com", planType: "pro" },
        requiresOpenaiAuth: false,
      });
      return;
    case "skills/list":
      respond(id, {
        data: [
          {
            cwd: process.cwd(),
            errors: [],
            skills: [
              {
                name: "mock-skill",
                description: "Mock skill",
                enabled: true,
                path: `${process.cwd()}/mock-skill`,
                scope: "repo",
              },
            ],
          },
        ],
      });
      return;
    case "model/list":
      respond(id, {
        data: [
          {
            defaultReasoningEffort: "medium",
            description: "Mock model",
            displayName: "GPT Mock",
            hidden: false,
            id: "gpt-mock",
            isDefault: true,
            model: "gpt-mock",
            supportedReasoningEfforts: [
              { reasoningEffort: "medium", description: "Balanced reasoning" },
            ],
          },
        ],
        nextCursor: null,
      });
      return;
    case "account/rateLimits/read":
      if (scenario === "rate-limits-method-not-found") {
        respondError(id, -32601, "Method not found: account/rateLimits/read");
        return;
      }
      if (scenario === "rate-limits-hang") {
        return;
      }
      respond(id, rateLimitsResult);
      return;
    default:
      if (message.id !== undefined) {
        respondError(id, -32601, `Unhandled request: ${String(message.method)}`);
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
