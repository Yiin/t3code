/**
 * agents toolkit - the `spawn_agent` tool served over the MCP server that is
 * already injected into every provider session.
 *
 * The tool turns a subagent request into a real T3 child thread with its own
 * provider session, so a human can watch it and talk to it. It returns as soon
 * as the child's turn has started; blocking on the child's result is a separate
 * concern.
 *
 * **Worktree decision.** The child runs in the *parent's* worktree, verbatim. A
 * subagent exists to work on what the parent is working on, exactly as an
 * in-process Task does. Giving it its own worktree would need provisioning,
 * setup scripts and a merge, which is the epic runner's job, not a subagent's.
 * The cost is that two agents can write the same files, and that
 * `restoreCheckpoint` on either thread rewrites the shared tree under the other
 * (`apps/server/src/vcs/GitVcsDriver.ts` *capture* is safe — it uses a per-call
 * `GIT_INDEX_FILE` temp index — but *restore* is not).
 * `maxConcurrentChildren` is the only brake in v1.
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

/**
 * A spawn failure the model cannot fix by retrying with different arguments.
 *
 * A *refused* spawn is not one of these — a refusal is a successful tool result
 * carrying `spawned: false`, so the model falls back to its built-in Task tool
 * instead of retrying the call.
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

export const SpawnAgentResult = Schema.Union([
  Schema.Struct({
    spawned: Schema.Literal(true),
    childThreadId: Schema.String,
    agentType: Schema.String,
    description: Schema.String,
  }),
  Schema.Struct({
    spawned: Schema.Literal(false),
    reason: Schema.Literals(["disabled", "agent-type-not-allowed", "depth-cap", "concurrency-cap"]),
    detail: Schema.String,
  }),
]);

export const SpawnAgentTool = Tool.make("spawn_agent", {
  description:
    "Spawn a subagent as its own T3 thread with its own provider session, so the human can watch it and message it directly. Returns as soon as the child's first turn has started; it does not wait for the result. When the server refuses, the call still succeeds with spawned=false and a reason — fall back to your built-in Task tool rather than retrying.",
  parameters: SpawnAgentInput,
  success: SpawnAgentResult,
  failure: SpawnAgentError,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    OrchestrationEngineService,
    ProjectionSnapshotQuery,
    Crypto.Crypto,
  ],
})
  .annotate(Tool.Title, "Spawn a subagent")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

export const AgentsToolkit = Toolkit.make(SpawnAgentTool);
