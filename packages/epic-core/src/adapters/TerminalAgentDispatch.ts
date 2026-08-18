// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off globalTimersInEffect:off preferSchemaOverJson:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type { EpicSubagentMap } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import {
  DispatchError,
  type AgentDispatchShape,
  type AgentSelection,
  type FinalMessageRead,
  type IterationHandle,
  type IterationSettle,
} from "../ports/AgentDispatch.ts";
import {
  wrapWorkerScopeSpawn,
  type SpawnInvocation,
  type WorkerScopePreparation,
} from "../workerScope.ts";
import type { TerminalProviderRoute } from "./TerminalProviderSupport.ts";
import type { TerminalWorkerActivity } from "./TerminalWorkerActivity.ts";

export type TerminalHarness =
  | "worker-cmd"
  | "prime"
  | "kimi"
  | "claude"
  | "ccx"
  | "codex"
  | "opencode";

export interface TerminalAgentDispatchOptions {
  readonly harness: TerminalHarness;
  readonly artifactsDirectory: string;
  readonly binary?: string;
  readonly workerCommand?: string;
  readonly permissionMode?: string;
  readonly useHarnessDefaultModel?: boolean;
  /**
   * Subagent definitions injected into the harness session. Claude-family
   * harnesses receive them as `--agents <json>`; other harnesses ignore them.
   * The runner owns the per-role model tier via each definition's `model`.
   */
  readonly subagents?: EpicSubagentMap | undefined;
  readonly timeoutSeconds?: number | null;
  readonly stopGraceSeconds?: number;
  readonly maxArtifactBytes?: number;
  readonly environment?: NodeJS.ProcessEnv;
  readonly providerRoutes?: ReadonlyArray<TerminalProviderRoute>;
  /**
   * Optional systemd scope governance for the worker spawn. When present and
   * active, the provider subprocess leaves the coordinator's cgroup for a
   * named scope under cook-epic.slice; when absent or inactive, the spawn is
   * unwrapped. See `workerScope.ts`.
   */
  readonly workerScope?: WorkerScopePreparation | undefined;
  /**
   * Where each worker's live process facts are published for liveness
   * supervision (`TerminalWorkerActivity.ts`). Absent means the run supervises
   * nothing, so the dispatch records nothing.
   *
   * Only `startIteration` writes here. `runAuxiliary` spawns a fold or
   * inspector, not a worker, and must never move a worker's counters.
   */
  readonly workerActivity?: TerminalWorkerActivity | undefined;
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

/**
 * The one place this file turns an untyped JSON value into a readable object.
 *
 * Harness stdout is JSONL the provider owns, so every nested field below is
 * narrowed here rather than at each read. Arrays are not objects for this
 * purpose: no field this parser wants is ever carried on one.
 */
const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

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
  if (Array.isArray(value)) {
    for (const child of value) {
      const found = findStructuredError(child);
      if (found !== null) return found;
    }
    return null;
  }
  const item = asRecord(value);
  if (item === null) return null;
  const direct = structuredErrorText(item);
  if (direct !== null) return direct;
  for (const child of Object.values(item)) {
    const found = findStructuredError(child);
    if (found !== null) return found;
  }
  return null;
};

const primeAssistantText = (item: Record<string, unknown>): string | null => {
  if (item["type"] !== "message_end" && item["type"] !== "turn_end") return null;
  const messageRecord = asRecord(item["message"]);
  if (messageRecord === null) return null;
  if (messageRecord["role"] !== "assistant" || !Array.isArray(messageRecord["content"]))
    return null;
  const text = messageRecord["content"]
    .flatMap((block) => {
      const content = asRecord(block);
      if (content === null) return [];
      return content["type"] === "text" && typeof content["text"] === "string"
        ? [content["text"]]
        : [];
    })
    .join("");
  return text === "" ? null : text;
};

const boundedPrimeError = (value: unknown, fallback: string): string =>
  typeof value === "string" && value.trim() !== "" ? value.trim().slice(0, 2_048) : fallback;

const primeAssistantError = (value: unknown): string | null => {
  const message = asRecord(value);
  if (message === null) return null;
  if (message["role"] !== "assistant" || message["stopReason"] !== "error") return null;
  return boundedPrimeError(message["errorMessage"], "Prime assistant stopped with an error");
};

/** Extract only Prime's documented, machine-owned failure records. */
const primeProviderError = (item: Record<string, unknown>): string | null => {
  if (item["type"] === "auto_retry_end" && item["success"] === false) {
    return boundedPrimeError(item["finalError"], "Prime provider retries failed");
  }
  if (item["type"] === "message_end" || item["type"] === "turn_end") {
    return primeAssistantError(item["message"]);
  }
  if (item["type"] === "agent_end" && Array.isArray(item["messages"])) {
    let error: string | null = null;
    for (const message of item["messages"]) error = primeAssistantError(message) ?? error;
    return error;
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
    if (harness !== "prime") providerError = findStructuredError(item) ?? providerError;

    if (harness === "prime") {
      finalText = primeAssistantText(item) ?? finalText;
      providerError = primeProviderError(item) ?? providerError;
    } else if ((harness === "claude" || harness === "ccx") && item["type"] === "result") {
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
      const nested = asRecord(item["item"]);
      if (
        nested !== null &&
        nested["type"] === "agent_message" &&
        typeof nested["text"] === "string"
      ) {
        finalText = nested["text"];
      }
    } else if (harness === "codex" && item["type"] === "thread.started") {
      if (typeof item["thread_id"] === "string") sessionId = item["thread_id"];
    } else if (harness === "opencode" && item["type"] === "text") {
      const text = asRecord(item["part"])?.["text"];
      if (typeof text === "string") openCodeStepText.push(text);
    } else if (harness === "opencode" && item["type"] === "step_finish") {
      if (asRecord(item["part"])?.["reason"] === "stop") {
        finalText = openCodeStepText.join("");
      }
      openCodeStepText = [];
    }
  }
  return { finalText, sessionId, providerError };
};

const capabilities = (harness: TerminalHarness): IterationHandle["capabilities"] => ({
  terminalSignal: "process-exit",
  continuation: harness === "worker-cmd" || harness === "prime" ? "none" : "resume-command",
  subagentLiveness: "unavailable",
  finalMessage:
    harness === "worker-cmd"
      ? "raw-text"
      : harness === "prime"
        ? "assistant-jsonl"
        : harness === "claude" || harness === "ccx"
          ? "result-field"
          : harness === "kimi"
            ? "assistant-jsonl"
            : harness === "codex"
              ? "agent-item-jsonl"
              : "step-text-jsonl",
  providerErrors: harness === "prime" ? "session-only" : "session-and-assistant",
  cost:
    harness === "claude" || harness === "ccx"
      ? "total-cost-usd"
      : harness === "opencode"
        ? "step-cost"
        : "none",
  /**
   * The terminal side cannot adopt an iteration whose coordinator died.
   *
   * The artifact file is written only inside the child close handler
   * (`writeFile(artifactPath, ...)` below), the harness session id lives only
   * in a closure variable that the same handler reads, and children are
   * spawned `detached: true`. A coordinator killed mid-turn therefore leaves
   * no artifact and no recoverable session id.
   *
   * The CLIs themselves do support resume — `claude --resume`, `codex exec
   * resume`, `kimi -r`, `opencode --session` are all built above. Teaching
   * this adapter to persist a cursor early enough to use them is out of scope
   * for the restart-safety epic, so it declares the honest answer instead.
   */
  lifecycle: { resume: "unsupported" },
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

const primeInvocation = (input: {
  readonly options: TerminalAgentDispatchOptions;
  readonly cwd: string;
  readonly prompt: string;
  readonly selection: AgentSelection;
  readonly inspector: boolean;
}): SpawnInvocation => ({
  command: input.options.binary ?? "prime-agent",
  args: [
    "--mode",
    "json",
    "--no-session",
    "--cwd",
    input.cwd,
    ...(input.inspector
      ? [
          "--no-tools",
          "--no-skills",
          "--no-context-files",
          "--no-extensions",
          "--no-prompt-templates",
        ]
      : []),
    ...(input.selection.model.length === 0 || input.options.useHarnessDefaultModel
      ? []
      : ["--model", input.selection.model]),
    "--",
    input.prompt,
  ],
});

/**
 * The `--agents <json>` flag for an injected role map, or nothing.
 *
 * An absent or empty map emits no flag at all, so a harness with no policy
 * keeps its own agents instead of being handed an empty set.
 */
const subagentsArgs = (subagents: EpicSubagentMap | undefined): ReadonlyArray<string> => {
  if (subagents === undefined) return [];
  if (Object.keys(subagents).length === 0) return [];
  return ["--agents", JSON.stringify(subagents)];
};

const claudeInvocation = (input: {
  readonly options: TerminalAgentDispatchOptions;
  readonly prompt: string;
  readonly selection: AgentSelection;
  readonly sessionId: string | null;
  readonly persistSession: boolean;
  readonly inspector: boolean;
  /**
   * Injected role definitions. Only an iteration worker carries them: a fold
   * or inspector auxiliary is one prompt long and spawns nobody.
   */
  readonly subagents?: EpicSubagentMap | undefined;
}): SpawnInvocation => ({
  command: input.options.binary ?? "claude",
  args: [
    "-p",
    ...(input.sessionId === null ? [] : ["--resume", input.sessionId]),
    "--permission-mode",
    input.options.permissionMode ?? "auto",
    "--output-format",
    "json",
    ...subagentsArgs(input.subagents),
    ...(input.selection.model.length === 0 || input.options.useHarnessDefaultModel
      ? []
      : ["--model", input.selection.model]),
    "--exclude-dynamic-system-prompt-sections",
    ...(input.persistSession ? [] : ["--no-session-persistence"]),
    ...(input.inspector ? ["--tools", "", "--disable-slash-commands"] : []),
    "--",
    input.prompt,
  ],
});

const invocation = (input: {
  readonly options: TerminalAgentDispatchOptions;
  readonly prompt: string;
  readonly promptPath: string;
  readonly selection: AgentSelection;
  readonly sessionId: string | null;
  readonly cwd: string;
}): SpawnInvocation => {
  const { options, prompt, promptPath, selection, sessionId, cwd } = input;
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
    case "prime":
      return primeInvocation({ options, cwd, prompt, selection, inspector: false });
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
      return claudeInvocation({
        options,
        prompt,
        selection,
        sessionId,
        persistSession: true,
        inspector: false,
        subagents: options.subagents,
      });
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

/** The dispatch options and harness a selection routes to, after fallback. */
interface RoutedDispatch {
  readonly options: TerminalAgentDispatchOptions;
  readonly harness: TerminalHarness;
}

const routeOptions = (
  options: TerminalAgentDispatchOptions,
  selection: AgentSelection,
): RoutedDispatch => {
  const route = options.providerRoutes?.find(
    (candidate) => candidate.instanceId === selection.instanceId,
  );
  if (route === undefined) return { options, harness: options.harness };
  return {
    harness: route.harness,
    options: {
      // The spread carries `subagents` to the routed options on purpose: a
      // fallback to another Claude account keeps the same role definitions.
      ...options,
      harness: route.harness,
      binary: route.binary,
      useHarnessDefaultModel: route.primary ? (options.useHarnessDefaultModel ?? false) : false,
    },
  };
};

type PrimeRole = "worker" | "fold" | "inspector";

const primeRoleEnvironment = (
  environment: NodeJS.ProcessEnv | undefined,
  role: PrimeRole,
): NodeJS.ProcessEnv => {
  const resolved: NodeJS.ProcessEnv = { ...process.env, ...environment, COOKEPIC_ROLE: role };
  delete resolved.COOKEPIC_FOLD;
  delete resolved.COOKEPIC_INSPECTOR;
  if (role === "fold") resolved.COOKEPIC_FOLD = "1";
  if (role === "inspector") resolved.COOKEPIC_INSPECTOR = "1";
  return resolved;
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

const stopOwnedGroup = async (
  pgid: number,
  expectedStartTicks: string | null,
  stopGraceSeconds: number,
): Promise<void> => {
  if (!ownedGroupExists(pgid, expectedStartTicks)) return;
  killGroup(pgid, "SIGTERM");
  if (await waitForGroupExit(pgid, expectedStartTicks, stopGraceSeconds * 1_000)) return;
  killGroup(pgid, "SIGKILL");
  await waitForGroupExit(pgid, expectedStartTicks, 1_000);
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
  const item = asRecord(value);
  if (item === null) return;
  const agents = asRecord(item["agents_states"]);
  if (agents !== null) {
    for (const [id, state] of Object.entries(agents)) {
      const stateRecord = asRecord(state);
      const status = stateRecord === null ? state : stateRecord["status"];
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
        let streamPrimeFinalText: string | null = null;
        const subagentStates = new Map<string, boolean>();

        const spawn = (prompt: string): void => {
          const call = invocation({
            options: iterationOptions,
            prompt,
            promptPath,
            selection: input.selection,
            sessionId,
            cwd: input.worktreePath ?? input.cwd,
          });
          const scoped =
            options.workerScope === undefined
              ? call
              : wrapWorkerScopeSpawn(
                  options.workerScope,
                  `iteration-${String(input.iterationIndex)}`,
                  call.command,
                  call.args,
                );
          let chunks = "";
          let timedOut = false;
          let parseBuffer = "";
          let streamProviderError: string | null = null;
          let timeoutKillTimer: NodeJS.Timeout | undefined;
          child = NodeChildProcess.spawn(scoped.command, scoped.args, {
            cwd: input.worktreePath ?? input.cwd,
            env:
              iterationHarness === "prime"
                ? primeRoleEnvironment(iterationOptions.environment, "worker")
                : { ...process.env, ...iterationOptions.environment },
            detached: true,
            stdio: ["ignore", "pipe", "pipe"],
          });
          const current = child;
          childStartTicks = current.pid === undefined ? null : processStartTicks(current.pid);
          options.workerActivity?.started(artifactPath, current.pid ?? null);
          const append = (value: Buffer | string) => {
            const next = String(value);
            options.workerActivity?.appended(artifactPath, Buffer.byteLength(next));
            chunks += next;
            parseBuffer += next;
            const lines = parseBuffer.split(/\r?\n/);
            parseBuffer = lines.pop() ?? "";
            if (Buffer.byteLength(parseBuffer) > 64 * 1024) {
              parseBuffer = Buffer.from(parseBuffer)
                .subarray(-(64 * 1024))
                .toString();
            }
            for (const line of lines) {
              const item = record(line);
              if (item === null) continue;
              if (iterationHarness === "prime") {
                streamPrimeFinalText = primeAssistantText(item) ?? streamPrimeFinalText;
                streamProviderError = primeProviderError(item) ?? streamProviderError;
              } else {
                streamProviderError = findStructuredError(item) ?? streamProviderError;
              }
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
              options.workerActivity?.ended(artifactPath);
              const max = options.maxArtifactBytes ?? 1024 * 1024;
              const bounded = Buffer.from(chunks).subarray(-max).toString();
              await NodeFSP.writeFile(artifactPath, bounded);
              parsed = parseTerminalArtifact(iterationHarness, bounded);
              if (streamPrimeFinalText !== null) {
                parsed = { ...parsed, finalText: streamPrimeFinalText };
              }
              if (streamProviderError !== null) {
                parsed = { ...parsed, providerError: streamProviderError };
              }
              sessionId = parsed.sessionId ?? sessionId;
              const unavailableError =
                code === 126 || code === 127 ? `provider command unavailable (exit ${code})` : null;
              const providerError = spawnError ?? parsed.providerError ?? unavailableError;
              resolve({
                turnState:
                  timedOut || signal !== null
                    ? "interrupted"
                    : code === 0 && providerError === null
                      ? "completed"
                      : "error",
                timedOut,
                providerError,
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
                // `spawn` reassigns the child, the settle promise and the
                // artifact, so a continuation sent mid-turn would run a second
                // provider process in the same worktree, settle on the first
                // exit, and leak the first process group past interrupt and
                // release. `sessionId` is set from streamed lines, so it is
                // already non-null mid-turn and cannot stand in for this check.
                const runningPid = child?.pid;
                if (runningPid !== undefined && ownedGroupExists(runningPid, childStartTicks))
                  throw new Error("continuation is unavailable while the turn is running");
                if (iterationHarness === "worker-cmd" || sessionId === null)
                  throw new Error("continuation is unavailable");
                spawn(prompt);
              },
              catch: (cause) =>
                new DispatchError({ operation: "continueTurn", detail: detail(cause), cause }),
            }),
          // No terminal harness absorbs a message into a running turn: a
          // continuation is a second `spawn`, which is exactly what
          // `continueTurn` above refuses while the child is alive. Saying so
          // once here stops the caller asking again.
          nudge: () => Effect.succeed("unsupported" as const),
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

  const runAuxiliary: AgentDispatchShape["runAuxiliary"] = (input) => {
    const routed = routeOptions(options, input.selection);
    if (routed.harness !== "prime" && routed.harness !== "claude" && routed.harness !== "ccx") {
      return Effect.fail(
        new DispatchError({
          operation: "runAuxiliary",
          detail: `${routed.harness} does not support ${input.purpose}`,
        }),
      );
    }
    return Effect.tryPromise({
      try: async () => {
        const role: PrimeRole = input.purpose === "epic-note-fold" ? "fold" : "inspector";
        const call =
          routed.harness === "prime"
            ? primeInvocation({
                options: routed.options,
                cwd: input.cwd,
                prompt: input.prompt,
                selection: input.selection,
                inspector: role === "inspector",
              })
            : claudeInvocation({
                options: routed.options,
                prompt: input.prompt,
                selection: input.selection,
                sessionId: null,
                persistSession: false,
                inspector: role === "inspector",
              });
        const scoped =
          options.workerScope === undefined
            ? call
            : wrapWorkerScopeSpawn(options.workerScope, role, call.command, call.args);
        const max = routed.options.maxArtifactBytes ?? 1024 * 1024;
        let chunks = "";
        let parseBuffer = "";
        let streamFinalText: string | null = null;
        let streamProviderError: string | null = null;
        let timedOut = false;
        let spawnError: string | null = null;
        let timeoutKillTimer: NodeJS.Timeout | undefined;
        const child = NodeChildProcess.spawn(scoped.command, scoped.args, {
          cwd: input.cwd,
          env:
            routed.harness === "prime"
              ? primeRoleEnvironment(routed.options.environment, role)
              : { ...process.env, ...routed.options.environment },
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
        const childStartTicks = child.pid === undefined ? null : processStartTicks(child.pid);
        const append = (value: Buffer | string): void => {
          const next = String(value);
          chunks += next;
          parseBuffer += next;
          const lines = parseBuffer.split(/\r?\n/);
          parseBuffer = lines.pop() ?? "";
          if (Buffer.byteLength(parseBuffer) > 64 * 1024) {
            parseBuffer = Buffer.from(parseBuffer)
              .subarray(-(64 * 1024))
              .toString();
          }
          for (const line of lines) {
            const item = record(line);
            if (item === null) continue;
            if (routed.harness === "prime") {
              streamFinalText = primeAssistantText(item) ?? streamFinalText;
            } else {
              const parsed = parseTerminalArtifact(routed.harness, line);
              streamFinalText = parsed.finalText ?? streamFinalText;
              streamProviderError = parsed.providerError ?? streamProviderError;
            }
          }
          if (Buffer.byteLength(chunks) > max * 2) {
            chunks = Buffer.from(chunks).subarray(-max).toString();
          }
        };
        child.stdout?.on("data", append);
        child.stderr?.on("data", append);
        child.on("error", (error) => {
          spawnError = error.message;
        });
        // The caller's budget wins: an idle inspection is minutes where the
        // iteration timeout these options carry is hours.
        const timeoutSeconds = input.timeoutSeconds ?? routed.options.timeoutSeconds;
        const timer =
          timeoutSeconds == null
            ? undefined
            : setTimeout(() => {
                timedOut = true;
                if (child.pid === undefined) return;
                killGroup(child.pid, "SIGTERM");
                timeoutKillTimer = setTimeout(
                  () => {
                    if (ownedGroupExists(child.pid!, childStartTicks)) {
                      killGroup(child.pid!, "SIGKILL");
                    }
                  },
                  (routed.options.stopGraceSeconds ?? 15) * 1_000,
                );
                timeoutKillTimer.unref();
              }, timeoutSeconds * 1_000);
        timer?.unref();
        return await new Promise<{ output: string; succeeded: boolean }>((resolve) => {
          child.on("close", async (code, signal) => {
            if (timer !== undefined) clearTimeout(timer);
            if (timeoutKillTimer !== undefined) clearTimeout(timeoutKillTimer);
            if (child.pid !== undefined) {
              await stopOwnedGroup(
                child.pid,
                childStartTicks,
                routed.options.stopGraceSeconds ?? 15,
              );
            }
            const bounded = Buffer.from(chunks).subarray(-max).toString();
            const parsed = parseTerminalArtifact(routed.harness, bounded);
            const providerError =
              routed.harness === "prime" ? null : (streamProviderError ?? parsed.providerError);
            resolve({
              output: streamFinalText ?? parsed.finalText ?? "",
              succeeded:
                !timedOut &&
                signal === null &&
                code === 0 &&
                spawnError === null &&
                providerError === null,
            });
          });
        });
      },
      catch: (cause) =>
        new DispatchError({ operation: "runAuxiliary", detail: detail(cause), cause }),
    });
  };

  return {
    capabilities: capabilities(options.harness),
    startIteration,
    runAuxiliary,
  };
};
