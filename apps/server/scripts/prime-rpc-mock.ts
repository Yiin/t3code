// @effect-diagnostics nodeBuiltinImport:off
import * as NodeProcess from "node:process";
import * as NodeTimers from "node:timers";

const scenario = NodeProcess.env.T3_PRIME_RPC_SCENARIO ?? "default";
const adapterScenario = scenario.startsWith("adapter");
const argv = NodeProcess.argv.slice(2);
let buffer = "";
let pendingStateCommand: Record<string, unknown> | undefined;
let activeModel = { provider: "prime", id: "prime-model" };
let activeThinking = "medium";
let stateRequests = 0;
const receivedMessages: Array<Record<string, unknown>> = [];

if (argv.includes("--version")) {
  if (scenario === "version-timeout") {
    // @effect-diagnostics-next-line globalTimers:off - Standalone fake CLI scheduling.
    NodeTimers.setInterval(() => undefined, 60_000);
  } else if (scenario === "version-nonzero") {
    NodeProcess.stderr.write("Prime Agent unavailable\n");
    NodeProcess.exit(7);
  } else {
    NodeProcess.stdout.write("prime-agent 1.2.3\n");
    NodeProcess.exit(0);
  }
}

function valueAfter(flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

let activeSessionId = valueAfter("--session-id") ?? valueAfter("--session") ?? "prime-session";

if (!argv.includes("--mode") || !argv.includes("rpc")) {
  NodeProcess.stderr.write("missing RPC mode arguments\n");
  NodeProcess.exit(64);
}

function emit(value: unknown, delimiter = "\n"): void {
  NodeProcess.stdout.write(`${JSON.stringify(value)}${delimiter}`);
}

function respond(command: Record<string, unknown>, data?: unknown): void {
  emit({
    id: command.id,
    type: "response",
    command: command.type,
    success: true,
    ...(data === undefined ? {} : { data }),
  });
}

function respondWithState(command: Record<string, unknown>): void {
  respond(command, {
    model: activeModel,
    thinkingLevel: activeThinking,
    isStreaming: false,
    isCompacting: false,
    sessionFile: "/tmp/prime-session.jsonl",
    sessionId: activeSessionId,
    messageCount: 2,
    pendingMessageCount: 0,
    mockArgv: argv,
    ...(scenario === "health-unauthenticated" ? { authenticated: false } : {}),
  });
  emit({ type: "mock_after_response" });
}

function handle(command: Record<string, unknown>): void {
  if (scenario === "malformed") {
    NodeProcess.stdout.write("{not-json}\n");
    return;
  }
  if (scenario === "eof") {
    NodeProcess.exit(0);
  }
  if (scenario === "exit") {
    NodeProcess.stderr.write("token=super-secret-value process failed\n");
    NodeProcess.exit(7);
  }
  if (scenario === "oversized") {
    NodeProcess.stdout.write(`{"type":"event","payload":"${"x".repeat(1024)}"}`);
    return;
  }
  if (scenario === "timeout" && command.type === "get_state") {
    return;
  }

  switch (command.type) {
    case "get_state": {
      stateRequests += 1;
      if (scenario === "adapter-startup-crash" && stateRequests > 1) {
        NodeProcess.exit(9);
      }
      emit({ type: "mock_before_response", text: "line\u2028separator" }, "\r\n");
      if (adapterScenario || scenario.startsWith("health")) {
        respondWithState(command);
      } else if (scenario === "delayed") {
        // @effect-diagnostics-next-line globalTimers:off - Standalone fake CLI scheduling.
        NodeTimers.setTimeout(() => respondWithState(command), 100);
      } else {
        pendingStateCommand = command;
      }
      return;
    }
    case "get_available_models": {
      const models =
        scenario === "health-no-models"
          ? []
          : scenario.startsWith("health")
            ? [
                {
                  provider: "prime",
                  id: "prime-model",
                  name: "Prime Model",
                  reasoning: true,
                  thinkingLevelMap: { high: "High", low: null, unsupported: "Unsupported" },
                  input: ["text", "image"],
                },
                { provider: "prime", id: "prime-model", name: "Duplicate" },
                { provider: "other", id: "basic", name: "Basic", isCustom: true },
              ]
            : [{ provider: "prime", id: "prime-model", name: "Prime Model" }];
      NodeProcess.stdout.write(
        `${JSON.stringify({
          id: command.id,
          type: "response",
          command: command.type,
          success: true,
          data: { models },
        })}\n${JSON.stringify({ type: "mock_models_sent" })}\n`,
      );
      if (pendingStateCommand !== undefined) {
        respondWithState(pendingStateCommand);
        pendingStateCommand = undefined;
      }
      return;
    }
    case "set_model":
      if (adapterScenario) receivedMessages.push(command);
      activeModel = { provider: String(command.provider), id: String(command.modelId) };
      respond(command, activeModel);
      return;
    case "set_thinking_level":
      if (adapterScenario) receivedMessages.push(command);
      activeThinking = String(command.level);
      respond(command);
      return;
    case "steer":
    case "follow_up":
      if (adapterScenario) receivedMessages.push(command);
      respond(command);
      if (adapterScenario) emit({ type: "queue_update", steering: [], followUp: [] });
      return;
    case "abort":
      if (adapterScenario) receivedMessages.push(command);
      respond(command);
      if (adapterScenario) {
        emit({
          type: "message_update",
          message: { id: "assistant-1", role: "assistant" },
          assistantMessageEvent: { type: "error", reason: "aborted" },
        });
        emit({ type: "agent_settled" });
      }
      return;
    case "prompt": {
      if (adapterScenario) receivedMessages.push(command);
      if (adapterScenario || scenario.startsWith("text")) {
        emit({ type: "agent_start" });
        emit({ type: "message_start", message: { id: "assistant-1", role: "assistant" } });
        const message = String(command.message ?? "");
        const generated = message.includes("git commit messages")
          ? { subject: "Add Prime support.", body: "body", branch: "Prime Support" }
          : message.includes("pull request content")
            ? { title: "Add Prime support", body: "## Summary\n\n- Prime\n\n## Testing\n\n- Tests" }
            : message.includes("branch names")
              ? { branch: "Prime Support" }
              : { title: "Prime Support!" };
        emit({
          type: "message_update",
          message: { id: "assistant-1", role: "assistant" },
          assistantMessageEvent: {
            type: scenario === "text-error" ? "error" : "text_delta",
            ...(scenario === "text-error"
              ? { reason: "mock failure" }
              : {
                  delta:
                    scenario === "text-empty"
                      ? ""
                      : scenario === "text-malformed"
                        ? "no json"
                        : JSON.stringify(generated),
                }),
          },
        });
      }
      const response = `${JSON.stringify({
        id: command.id,
        type: "response",
        command: command.type,
        success: true,
      })}\n`;
      const middle = Math.floor(response.length / 2);
      NodeProcess.stdout.write(response.slice(0, middle));
      // @effect-diagnostics-next-line globalTimers:off - Standalone fake CLI chunk scheduling.
      NodeTimers.setTimeout(() => {
        NodeProcess.stdout.write(response.slice(middle));
        if (!adapterScenario && !scenario.startsWith("text")) return;
        if (command.message === "full-turn") {
          // One turn that touches every canonical item family the mapper
          // projects: reasoning text, a tool call, and a subagent task.
          emit({
            type: "message_update",
            message: { id: "assistant-1", role: "assistant" },
            assistantMessageEvent: { type: "thinking_delta", delta: "weighing options" },
          });
          emit({
            type: "tool_execution_start",
            toolCallId: "tool-1",
            toolName: "Read",
            args: { path: "README.md" },
          });
          emit({
            type: "tool_execution_end",
            toolCallId: "tool-1",
            toolName: "Read",
            result: { text: "file body" },
            isError: false,
          });
          emit({
            type: "subagent_start",
            taskId: "task-1",
            description: "survey the repo",
            agentType: "explore",
          });
          emit({ type: "subagent_end", taskId: "task-1", status: "completed", summary: "done" });
        }
        emit({ type: "message_end", message: { id: "assistant-1", role: "assistant" } });
        if (command.message === "permission" || command.message === "permission-crash") {
          emit({
            type: "extension_ui_request",
            id: "permission-1",
            method: "select",
            title: "Allow Python?",
            options: ["Allow once", "Allow for session", "Decline", "Cancel"],
          });
          if (command.message === "permission-crash") {
            // @effect-diagnostics-next-line globalTimers:off - Standalone fake CLI scheduling.
            NodeTimers.setTimeout(() => NodeProcess.exit(9), 5);
          }
        } else if (command.message === "crash") {
          NodeProcess.exit(9);
        } else if (scenario === "text-eof") {
          NodeProcess.exit(0);
        } else if (scenario !== "text-timeout") {
          emit({ type: "agent_end", messages: [], willRetry: false });
          emit({ type: "agent_settled" });
        }
      }, 5);
      return;
    }
    case "get_messages":
      respond(command, {
        messages: adapterScenario
          ? [{ mockArgv: argv }, ...receivedMessages]
          : [{ role: "user", content: "hello" }],
      });
      return;
    case "get_fork_messages":
      respond(command, { messages: [{ entryId: "entry-1", text: "hello" }] });
      return;
    case "fork":
      if (adapterScenario) receivedMessages.push(command);
      if (adapterScenario) activeSessionId = `${activeSessionId}-forked`;
      respond(command, { text: "hello", cancelled: false });
      return;
    case "extension_ui_response":
      if (adapterScenario) receivedMessages.push(command);
      emit({ type: "mock_extension_response", response: command });
      if (adapterScenario) emit({ type: "agent_settled" });
      return;
    default:
      emit({
        id: command.id,
        type: "response",
        command: command.type,
        success: false,
        error: `Unknown command: ${String(command.type)}`,
      });
  }
}

NodeProcess.stdin.setEncoding("utf8");
NodeProcess.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  const records = buffer.split("\n");
  buffer = records.pop() ?? "";
  for (const record of records) {
    const line = record.endsWith("\r") ? record.slice(0, -1) : record;
    const decoded = JSON.parse(line) as unknown;
    if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
      throw new Error("invalid command");
    }
    handle(decoded as Record<string, unknown>);
  }
});
