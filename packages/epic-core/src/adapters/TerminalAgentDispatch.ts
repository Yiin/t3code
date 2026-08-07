// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off globalTimersInEffect:off preferSchemaOverJson:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";

import {
  DispatchError,
  type AgentDispatchShape,
  type AgentSelection,
  type FinalMessageRead,
  type IterationHandle,
  type IterationSettle,
} from "../ports/AgentDispatch.ts";
import type { TerminalProviderRoute } from "./TerminalProviderSupport.ts";

export type TerminalHarness = "worker-cmd" | "kimi" | "claude" | "ccx" | "codex" | "opencode";

export interface TerminalAgentDispatchOptions {
  readonly harness: TerminalHarness;
  readonly artifactsDirectory: string;
  readonly binary?: string;
  readonly workerCommand?: string;
  readonly permissionMode?: string;
  readonly useHarnessDefaultModel?: boolean;
  readonly timeoutSeconds?: number | null;
  readonly stopGraceSeconds?: number;
  readonly maxArtifactBytes?: number;
  readonly environment?: NodeJS.ProcessEnv;
  readonly providerRoutes?: ReadonlyArray<TerminalProviderRoute>;
}

interface ParsedArtifact {
  readonly finalText: string | null;
  readonly sessionId: string | null;
  readonly providerError: string | null;
}

const detail = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

const record = (line: string): Record<string, unknown> | null => {
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

const stringsIn = (value: unknown, output: string[] = []): string[] => {
  if (output.length >= 16) return output;
  if (typeof value === "string") output.push(value);
  else if (Array.isArray(value)) value.forEach((item) => stringsIn(item, output));
  else if (typeof value === "object" && value !== null) {
    Object.values(value).forEach((item) => stringsIn(item, output));
  }
  return output;
};

const structuredErrorText = (item: Record<string, unknown>): string | null => {
  const type = typeof item["type"] === "string" ? item["type"] : "";
  const subtype = typeof item["subtype"] === "string" ? item["subtype"] : "";
  const isError =
    item["is_error"] === true ||
    /^(?:error|failure|failed)$/.test(type) ||
    /^(?:error|failure|failed)(?:[_-]|$)/.test(subtype) ||
    (item["error"] !== undefined && item["error"] !== null && item["error"] !== false);
  if (!isError) return null;
  const source = item["error"] ?? item["result"] ?? item;
  const text = stringsIn(source).join(" ").trim();
  return text === "" ? "structured harness error" : text.slice(0, 2_048);
};

const findStructuredError = (value: unknown): string | null => {
  if (typeof value !== "object" || value === null) return null;
  if (!Array.isArray(value)) {
    const found = structuredErrorText(value as Record<string, unknown>);
    if (found !== null) return found;
  }
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    const found = findStructuredError(child);
    if (found !== null) return found;
  }
  return null;
};

/** Extract only the harness's final assistant channel. */
export const parseTerminalArtifact = (harness: TerminalHarness, text: string): ParsedArtifact => {
  if (harness === "worker-cmd")
    return { finalText: text.trim() || null, sessionId: null, providerError: null };
  let finalText: string | null = null;
  let sessionId: string | null = null;
  let providerError: string | null = null;
  let openCodeStepText: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const item = record(line);
    if (item === null) continue;
    if (typeof item["session_id"] === "string") sessionId = item["session_id"];
    if (typeof item["sessionID"] === "string") sessionId = item["sessionID"];
    providerError = findStructuredError(item) ?? providerError;

    if ((harness === "claude" || harness === "ccx") && item["type"] === "result") {
      if (typeof item["session_id"] === "string") sessionId = item["session_id"];
      if (typeof item["result"] === "string") finalText = item["result"];
      if (item["is_error"] === true && typeof item["result"] === "string") {
        providerError = item["result"];
      }
    } else if (harness === "kimi" && item["role"] === "assistant") {
      if (item["tool_calls"] === undefined && typeof item["content"] === "string") {
        finalText = item["content"];
      }
    } else if (harness === "codex" && item["type"] === "item.completed") {
      const nested = item["item"];
      if (typeof nested === "object" && nested !== null) {
        const value = nested as Record<string, unknown>;
        if (value["type"] === "agent_message" && typeof value["text"] === "string") {
          finalText = value["text"];
        }
      }
    } else if (harness === "codex" && item["type"] === "thread.started") {
      if (typeof item["thread_id"] === "string") sessionId = item["thread_id"];
    } else if (harness === "opencode" && item["type"] === "text") {
      const part = item["part"];
      if (
        typeof part === "object" &&
        part !== null &&
        typeof (part as Record<string, unknown>)["text"] === "string"
      ) {
        openCodeStepText.push((part as Record<string, unknown>)["text"] as string);
      }
    } else if (harness === "opencode" && item["type"] === "step_finish") {
      const part = item["part"];
      if (
        typeof part === "object" &&
        part !== null &&
        (part as Record<string, unknown>)["reason"] === "stop"
      ) {
        finalText = openCodeStepText.join("");
      }
      openCodeStepText = [];
    }
  }
  return { finalText, sessionId, providerError };
};

const capabilities = (harness: TerminalHarness): IterationHandle["capabilities"] => ({
  terminalSignal: "process-exit",
  continuation: harness === "worker-cmd" ? "none" : "resume-command",
  subagentLiveness: "unavailable",
  finalMessage:
    harness === "worker-cmd"
      ? "raw-text"
      : harness === "claude" || harness === "ccx"
        ? "result-field"
        : harness === "kimi"
          ? "assistant-jsonl"
          : harness === "codex"
            ? "agent-item-jsonl"
            : "step-text-jsonl",
  cost:
    harness === "claude" || harness === "ccx"
      ? "total-cost-usd"
      : harness === "opencode"
        ? "step-cost"
        : "none",
});

const codexPermissionArgs = (permissionMode: string | undefined): ReadonlyArray<string> =>
  permissionMode === "bypassPermissions"
    ? ["--dangerously-bypass-approvals-and-sandbox"]
    : [
        "-a",
        "never",
        "-s",
        permissionMode === undefined || permissionMode === "auto"
          ? "danger-full-access"
          : permissionMode,
      ];

const codexReasoningArgs = (selection: AgentSelection): ReadonlyArray<string> => {
  const effort = selection.options?.find((option) => option.id === "reasoningEffort")?.value;
  return typeof effort === "string"
    ? ["-c", `model_reasoning_effort=${JSON.stringify(effort)}`]
    : [];
};

const invocation = (input: {
  readonly options: TerminalAgentDispatchOptions;
  readonly prompt: string;
  readonly promptPath: string;
  readonly selection: AgentSelection;
  readonly sessionId: string | null;
}): { readonly command: string; readonly args: ReadonlyArray<string> } => {
  const { options, prompt, promptPath, selection, sessionId } = input;
  const model = selection.model;
  switch (options.harness) {
    case "worker-cmd":
      return {
        command: "bash",
        args: [
          "-c",
          'exec "$1" "$2"',
          "worker-cmd",
          options.workerCommand ?? options.binary ?? "",
          promptPath,
        ],
      };
    case "kimi":
      return {
        command: options.binary ?? "kimi",
        args: [
          ...(sessionId === null ? [] : ["-r", sessionId]),
          "-p",
          prompt,
          "--output-format",
          "stream-json",
          ...(model.length === 0 || options.useHarnessDefaultModel ? [] : ["-m", model]),
        ],
      };
    case "claude":
    case "ccx":
      return {
        command: options.binary ?? "claude",
        args: [
          "-p",
          ...(sessionId === null ? [] : ["--resume", sessionId]),
          "--permission-mode",
          options.permissionMode ?? "auto",
          "--output-format",
          "json",
          "--model",
          model || "sonnet",
          "--exclude-dynamic-system-prompt-sections",
          "--",
          prompt,
        ],
      };
    case "codex":
      return {
        command: options.binary ?? "codex",
        args:
          sessionId === null
            ? [
                ...codexPermissionArgs(options.permissionMode),
                ...(model && !options.useHarnessDefaultModel ? ["-m", model] : []),
                ...codexReasoningArgs(selection),
                "exec",
                "--json",
                prompt,
              ]
            : [
                "exec",
                "resume",
                "--json",
                "--dangerously-bypass-approvals-and-sandbox",
                sessionId,
                prompt,
              ],
      };
    case "opencode":
      return {
        command: options.binary ?? "opencode",
        args: [
          "run",
          "--format",
          "json",
          "--auto",
          ...(sessionId === null ? [] : ["--session", sessionId]),
          ...(model && !options.useHarnessDefaultModel ? ["-m", model] : []),
          "--",
          prompt,
        ],
      };
  }
};

const routeOptions = (
  options: TerminalAgentDispatchOptions,
  selection: AgentSelection,
): { readonly options: TerminalAgentDispatchOptions; readonly harness: TerminalHarness } => {
  const route = options.providerRoutes?.find(
    (candidate) => candidate.instanceId === selection.instanceId,
  );
  if (route === undefined) return { options, harness: options.harness };
  return {
    harness: route.harness,
    options: {
      ...options,
      harness: route.harness,
      binary: route.binary,
      useHarnessDefaultModel: route.primary ? (options.useHarnessDefaultModel ?? false) : false,
    },
  };
};

const killGroup = (pid: number, signal: NodeJS.Signals): void => {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {}
  }
};

const groupExists = (pgid: number): boolean => {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
};

const processStartTicks = (pid: number): string | null => {
  try {
    const stat = NodeFS.readFileSync(`/proc/${String(pid)}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(") ") + 2).split(" ")[19] ?? null;
  } catch {
    return null;
  }
};

const ownedGroupExists = (pgid: number, expectedStartTicks: string | null): boolean => {
  if (!groupExists(pgid)) return false;
  const currentStartTicks = processStartTicks(pgid);
  return !(
    currentStartTicks !== null &&
    expectedStartTicks !== null &&
    currentStartTicks !== expectedStartTicks
  );
};

const waitForGroupExit = async (
  pgid: number,
  expectedStartTicks: string | null,
  timeoutMs: number,
): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (ownedGroupExists(pgid, expectedStartTicks) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !ownedGroupExists(pgid, expectedStartTicks);
};

const updateSubagentBookkeeping = (
  value: unknown,
  states: Map<string, boolean>,
  fallbackKey = "root",
): void => {
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      updateSubagentBookkeeping(item, states, `${fallbackKey}.${String(index)}`),
    );
    return;
  }
  if (typeof value !== "object" || value === null) return;
  const item = value as Record<string, unknown>;
  const agents = item["agents_states"];
  if (typeof agents === "object" && agents !== null && !Array.isArray(agents)) {
    for (const [id, state] of Object.entries(agents)) {
      const status =
        typeof state === "object" && state !== null
          ? (state as Record<string, unknown>)["status"]
          : state;
      states.set(id, status === "running" || status === "in_progress");
    }
  }
  const status = item["status"];
  const id =
    typeof item["sessionId"] === "string"
      ? item["sessionId"]
      : typeof item["thread_id"] === "string"
        ? item["thread_id"]
        : typeof item["id"] === "string"
          ? item["id"]
          : null;
  const looksLikeChild =
    item["parentSessionId"] !== undefined ||
    item["type"] === "collab_tool_call" ||
    item["tool"] === "task";
  if (looksLikeChild && typeof status === "string") {
    states.set(id ?? fallbackKey, status === "running" || status === "in_progress");
  }
  for (const [key, child] of Object.entries(item)) {
    updateSubagentBookkeeping(child, states, `${fallbackKey}.${key}`);
  }
};

export const makeTerminalAgentDispatch = (
  options: TerminalAgentDispatchOptions,
): AgentDispatchShape => {
  const startIteration: AgentDispatchShape["startIteration"] = (input) =>
    Effect.tryPromise({
      try: async () => {
        const routed = routeOptions(options, input.selection);
        const iterationOptions = routed.options;
        const iterationHarness = routed.harness;
        await NodeFSP.mkdir(options.artifactsDirectory, { recursive: true });
        const prefix = `${input.runId}-${String(input.iterationIndex)}`;
        const artifactPath = NodePath.join(options.artifactsDirectory, `${prefix}.jsonl`);
        const promptPath = NodePath.join(options.artifactsDirectory, `${prefix}.prompt.md`);
        await NodeFSP.writeFile(promptPath, input.prompt, { mode: 0o600 });
        let child: NodeChildProcess.ChildProcess | null = null;
        let settled: Promise<IterationSettle> | null = null;
        let parsed: ParsedArtifact = { finalText: null, sessionId: null, providerError: null };
        let sessionId: string | null = null;
        let released = false;
        let childStartTicks: string | null = null;
        const subagentStates = new Map<string, boolean>();

        const spawn = (prompt: string): void => {
          const call = invocation({
            options: iterationOptions,
            prompt,
            promptPath,
            selection: input.selection,
            sessionId,
          });
          let chunks = "";
          let timedOut = false;
          let parseBuffer = "";
          let streamProviderError: string | null = null;
          let timeoutKillTimer: NodeJS.Timeout | undefined;
          child = NodeChildProcess.spawn(call.command, call.args, {
            cwd: input.worktreePath ?? input.cwd,
            env: { ...process.env, ...options.environment },
            detached: true,
            stdio: ["ignore", "pipe", "pipe"],
          });
          const current = child;
          childStartTicks = current.pid === undefined ? null : processStartTicks(current.pid);
          const append = (value: Buffer | string) => {
            const next = String(value);
            chunks += next;
            parseBuffer += next;
            if (Buffer.byteLength(parseBuffer) > 64 * 1024) {
              parseBuffer = Buffer.from(parseBuffer)
                .subarray(-(64 * 1024))
                .toString();
            }
            const lines = parseBuffer.split(/\r?\n/);
            parseBuffer = lines.pop() ?? "";
            for (const line of lines) {
              const item = record(line);
              if (item === null) continue;
              streamProviderError = findStructuredError(item) ?? streamProviderError;
              updateSubagentBookkeeping(item, subagentStates);
              if (typeof item["session_id"] === "string") sessionId = item["session_id"];
              if (typeof item["sessionID"] === "string") sessionId = item["sessionID"];
              if (item["type"] === "thread.started" && typeof item["thread_id"] === "string")
                sessionId = item["thread_id"];
            }
            const max = options.maxArtifactBytes ?? 1024 * 1024;
            if (Buffer.byteLength(chunks) > max * 2)
              chunks = Buffer.from(chunks).subarray(-max).toString();
          };
          current.stdout?.on("data", append);
          current.stderr?.on("data", append);
          const timer =
            options.timeoutSeconds == null
              ? undefined
              : setTimeout(() => {
                  timedOut = true;
                  if (current.pid !== undefined) {
                    killGroup(current.pid, "SIGTERM");
                    timeoutKillTimer = setTimeout(
                      () => {
                        if (ownedGroupExists(current.pid!, childStartTicks)) {
                          killGroup(current.pid!, "SIGKILL");
                        }
                      },
                      (options.stopGraceSeconds ?? 15) * 1_000,
                    );
                    timeoutKillTimer.unref();
                  }
                }, options.timeoutSeconds * 1_000);
          timer?.unref();
          settled = new Promise<IterationSettle>((resolve) => {
            let spawnError: string | null = null;
            current.on("error", (error) => {
              spawnError = error.message;
            });
            current.on("close", async (code, signal) => {
              if (timer !== undefined) clearTimeout(timer);
              if (timeoutKillTimer !== undefined) clearTimeout(timeoutKillTimer);
              const max = options.maxArtifactBytes ?? 1024 * 1024;
              const bounded = Buffer.from(chunks).subarray(-max).toString();
              await NodeFSP.writeFile(artifactPath, bounded);
              parsed = parseTerminalArtifact(iterationHarness, bounded);
              if (streamProviderError !== null) {
                parsed = { ...parsed, providerError: streamProviderError };
              }
              sessionId = parsed.sessionId ?? sessionId;
              resolve({
                turnState:
                  timedOut || signal !== null ? "interrupted" : code === 0 ? "completed" : "error",
                timedOut,
                providerError: spawnError ?? parsed.providerError,
              });
            });
          });
        };
        spawn(input.prompt);

        const handle: IterationHandle = {
          ref: artifactPath,
          capabilities: capabilities(iterationHarness),
          awaitSettled: Effect.tryPromise({
            try: async () => await settled!,
            catch: (cause) =>
              new DispatchError({ operation: "awaitSettled", detail: detail(cause), cause }),
          }),
          continueTurn: (prompt) =>
            Effect.tryPromise({
              try: async () => {
                if (iterationHarness === "worker-cmd" || sessionId === null)
                  throw new Error("continuation is unavailable");
                spawn(prompt);
              },
              catch: (cause) =>
                new DispatchError({ operation: "continueTurn", detail: detail(cause), cause }),
            }),
          interrupt: Effect.tryPromise({
            try: async () => {
              const pgid = child?.pid;
              const expectedStartTicks = childStartTicks;
              if (pgid === undefined || !ownedGroupExists(pgid, expectedStartTicks)) return;
              killGroup(pgid, "SIGTERM");
              if (
                await waitForGroupExit(
                  pgid,
                  expectedStartTicks,
                  (options.stopGraceSeconds ?? 15) * 1_000,
                )
              )
                return;
              killGroup(pgid, "SIGKILL");
              if (!(await waitForGroupExit(pgid, expectedStartTicks, 1_000))) {
                throw new Error(`process group ${String(pgid)} survived interrupt`);
              }
            },
            catch: (cause) =>
              new DispatchError({ operation: "interrupt", detail: detail(cause), cause }),
          }),
          release: Effect.tryPromise({
            try: async () => {
              if (released) return;
              const target = child;
              const expectedStartTicks = childStartTicks;
              if (target?.pid !== undefined && ownedGroupExists(target.pid, expectedStartTicks)) {
                killGroup(target.pid, "SIGTERM");
                const exited = await waitForGroupExit(
                  target.pid,
                  expectedStartTicks,
                  (options.stopGraceSeconds ?? 15) * 1_000,
                );
                if (!exited) {
                  killGroup(target.pid, "SIGKILL");
                  if (!(await waitForGroupExit(target.pid, expectedStartTicks, 1_000))) {
                    throw new Error(`process group ${String(target.pid)} survived release`);
                  }
                }
              }
              await settled;
              if (target?.pid !== undefined && ownedGroupExists(target.pid, expectedStartTicks)) {
                throw new Error(`process group ${String(target.pid)} still exists after release`);
              }
              released = true;
            },
            catch: (cause) =>
              new DispatchError({ operation: "release", detail: detail(cause), cause }),
          }),
          runningSubagents: Effect.sync(() =>
            iterationHarness === "codex" || iterationHarness === "opencode"
              ? {
                  mode: "event-bookkeeping" as const,
                  running: [...subagentStates.values()].filter(Boolean).length,
                }
              : {
                  mode: "unavailable" as const,
                  reason: `${iterationHarness} does not expose reliable terminal subagent state`,
                },
          ),
          finalMessage: Effect.sync(
            (): FinalMessageRead => ({
              text: parsed.finalText,
              streaming: false,
              waitExhausted: parsed.finalText === null,
            }),
          ),
        };
        return handle;
      },
      catch: (cause) =>
        new DispatchError({ operation: "startIteration", detail: detail(cause), cause }),
    });

  return {
    startIteration,
    runAuxiliary: () => Effect.succeed({ output: "", succeeded: false }),
  };
};
