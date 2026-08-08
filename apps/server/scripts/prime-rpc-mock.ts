// @effect-diagnostics nodeBuiltinImport:off
import * as NodeProcess from "node:process";
import * as NodeTimers from "node:timers";

const scenario = NodeProcess.env.T3_PRIME_RPC_SCENARIO ?? "default";
const argv = NodeProcess.argv.slice(2);
let buffer = "";
let pendingStateCommand: Record<string, unknown> | undefined;

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
    model: { provider: "prime", id: "prime-model" },
    thinkingLevel: "medium",
    isStreaming: false,
    isCompacting: false,
    sessionFile: "/tmp/prime-session.jsonl",
    sessionId: "prime-session",
    messageCount: 2,
    pendingMessageCount: 0,
    mockArgv: argv,
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
      emit({ type: "mock_before_response", text: "line\u2028separator" }, "\r\n");
      if (scenario === "delayed") {
        // @effect-diagnostics-next-line globalTimers:off - Standalone fake CLI scheduling.
        NodeTimers.setTimeout(() => respondWithState(command), 100);
      } else {
        pendingStateCommand = command;
      }
      return;
    }
    case "get_available_models": {
      NodeProcess.stdout.write(
        `${JSON.stringify({
          id: command.id,
          type: "response",
          command: command.type,
          success: true,
          data: { models: [{ provider: "prime", id: "prime-model", name: "Prime Model" }] },
        })}\n${JSON.stringify({ type: "mock_models_sent" })}\n`,
      );
      if (pendingStateCommand !== undefined) {
        respondWithState(pendingStateCommand);
        pendingStateCommand = undefined;
      }
      return;
    }
    case "set_model":
      respond(command, { provider: command.provider, id: command.modelId });
      return;
    case "set_thinking_level":
    case "steer":
    case "follow_up":
    case "abort":
      respond(command);
      return;
    case "prompt": {
      const response = `${JSON.stringify({
        id: command.id,
        type: "response",
        command: command.type,
        success: true,
      })}\n`;
      const middle = Math.floor(response.length / 2);
      NodeProcess.stdout.write(response.slice(0, middle));
      // @effect-diagnostics-next-line globalTimers:off - Standalone fake CLI chunk scheduling.
      NodeTimers.setTimeout(() => NodeProcess.stdout.write(response.slice(middle)), 5);
      return;
    }
    case "get_messages":
      respond(command, { messages: [{ role: "user", content: "hello" }] });
      return;
    case "get_fork_messages":
      respond(command, { messages: [{ entryId: "entry-1", text: "hello" }] });
      return;
    case "fork":
      respond(command, { text: "hello", cancelled: false });
      return;
    case "extension_ui_response":
      emit({ type: "mock_extension_response", response: command });
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
