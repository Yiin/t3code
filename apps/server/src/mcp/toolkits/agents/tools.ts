/**
 * agents toolkit - the `spawn_agent` tool served over the MCP server that is
 * already injected into every provider session.
 *
 * The tool turns a subagent request into a real T3 child thread with its own
 * provider session, so a human can watch it and talk to it. It blocks until the
 * child's first turn settles, so the parent gets the child's answer as its tool
 * result — the same bargain the built-in Task tool makes. A child that outlives
 * `spawnWaitTimeoutMs` returns a `timeout` status and keeps running.
 *
 * **Worktree decision.** The child runs in the *parent's* worktree, verbatim. A
 * subagent exists to work on what the parent is working on, exactly as an
 * in-process Task does. Giving it its own worktree would need provisioning,
 * setup scripts and a merge, which is the epic runner's job, not a subagent's.
 * The cost is that two agents can write the same files, and that
 * `restoreCheckpoint` on either thread rewrites the shared tree under the other
 * (`apps/server/src/vcs/GitVcsDriver.ts` *capture* is safe — it uses a per-call
 * `GIT_INDEX_FILE` temp index — but *restore* is not). `CheckpointReactor`
 * refuses a revert while another session runs a turn in the same worktree, and
 * `maxConcurrentChildren` caps how many children write at once.
 *
 * **Cost warning.** `ProviderCommandReactor` drains provider intents on a
 * single fiber (`ProviderCommandReactor.ts`, `packages/shared/src/DrainableWorker.ts`),
 * so N children serialize N provider session starts behind every other thread's
 * work. Keep the concurrency cap small.
 *
 * @module agents/tools
 */
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";
import * as Crypto from "effect/Crypto";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ServerSettingsService } from "../../../serverSettings.ts";

/**
 * A spawn failure the model cannot fix by retrying with different arguments.
 *
 * A *refused* spawn is not one of these — a refusal is a successful tool result
 * carrying `spawned: false` and a `detail` that tells the model what to do
 * instead, which is to do that work itself. Every refusal but `disabled` needs
 * an enabled policy, and an enabled policy is exactly when the built-in `Task`
 * and `Workflow` tools are denied on the session, so there is no delegation left
 * to fall back to. See `spawnPolicy.ts`.
 */
export class SpawnAgentError extends Schema.TaggedErrorClass<SpawnAgentError>()("SpawnAgentError", {
  reason: Schema.Literals(["capability-unavailable", "parent-thread-missing", "dispatch-failed"]),
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}

export const SpawnAgentInput = Schema.Struct({
  agent_type: Schema.String.annotate({
    description:
      "The kind of agent to run, e.g. 'Explore' or 'general-purpose'. The server allowlist decides which kinds may become their own thread.",
  }),
  description: Schema.String.annotate({
    description:
      "A short label a human reads in the subagent roster, e.g. 'Audit the settings migrations'. Three to seven words.",
  }),
  prompt: Schema.String.annotate({
    description:
      "The full task for the subagent. It starts with no context beyond this text, so state the goal, the constraints, and what to return.",
  }),
  model: Schema.optional(
    Schema.String.annotate({
      description:
        "Optional model id for the child, resolved against the parent's provider instance. Omit to inherit the parent's model. This is a model id, never a provider instance id.",
    }),
  ),
}).annotate({
  description: "Arguments for spawning a subagent as its own T3 thread.",
});

/**
 * How the parent's wait on the child ended.
 *
 * `timeout` is not an error: the child is still running, and the parent is told
 * so in plain words rather than being handed a transport failure.
 */
export const SpawnAgentStatus = Schema.Literals(["completed", "failed", "interrupted", "timeout"]);
export type SpawnAgentStatus = typeof SpawnAgentStatus.Type;

export const SpawnAgentResult = Schema.Union([
  Schema.Struct({
    spawned: Schema.Literal(true),
    childThreadId: Schema.String,
    agentType: Schema.String,
    description: Schema.String,
    status: SpawnAgentStatus,
    /** The child's last assistant message, or null when it produced none. */
    finalMessage: Schema.NullOr(Schema.String),
    /** Wall time from thread creation to this result, in milliseconds. */
    elapsedMs: Schema.Number,
    /** One line of prose for the model: what happened and what to do next. */
    note: Schema.String,
  }),
  Schema.Struct({
    spawned: Schema.Literal(false),
    reason: Schema.Literals(["disabled", "agent-type-not-allowed", "depth-cap", "concurrency-cap"]),
    detail: Schema.String,
  }),
]);

export const SpawnAgentTool = Tool.make("spawn_agent", {
  description:
    "Spawn a subagent as its own T3 thread with its own provider session, so the human can watch it and message it directly. Waits for the subagent to finish and returns its final message, like your built-in Task tool. If the subagent runs past the server's wait limit the call returns status=timeout with whatever it had said so far; the subagent keeps running, so carry on without its answer. When the server refuses, the call still succeeds with spawned=false and a detail saying what to do instead — do that work yourself. Do not retry with a different agent_type, and do not look for another way to delegate: your built-in delegation tools are turned off whenever this tool can spawn at all.",
  parameters: SpawnAgentInput,
  success: SpawnAgentResult,
  failure: SpawnAgentError,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    OrchestrationEngineService,
    ProjectionSnapshotQuery,
    Crypto.Crypto,
    // The handler reads the spawn policy from settings on every call.
    ServerSettingsService,
  ],
})
  .annotate(Tool.Title, "Spawn a subagent")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

export const AgentsToolkit = Toolkit.make(SpawnAgentTool);
