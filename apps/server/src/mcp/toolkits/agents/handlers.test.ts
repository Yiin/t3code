import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  type OrchestrationCommand,
  type OrchestrationThreadShell,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { spawnAgent } from "./handlers.ts";
import { DEFAULT_SPAWN_POLICY, type SpawnPolicy } from "./spawnPolicy.ts";

const PARENT_THREAD_ID = ThreadId.make("thread-parent");

const shell = (overrides: Partial<OrchestrationThreadShell> = {}): OrchestrationThreadShell => ({
  id: PARENT_THREAD_ID,
  projectId: ProjectId.make("project-1"),
  title: "Parent thread",
  modelSelection: { instanceId: ProviderInstanceId.make("claude"), model: "claude-opus-5" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: "mine",
  worktreePath: "/tmp/parent-worktree",
  latestTurn: null,
  createdAt: "2026-08-11T00:00:00.000Z",
  updatedAt: "2026-08-11T00:00:00.000Z",
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  session: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
  activeSubagentCount: 0,
  parentThreadId: null,
  ...overrides,
});

const invocation: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: PARENT_THREAD_ID,
  providerSessionId: "provider-session-1",
  providerInstanceId: ProviderInstanceId.make("claude"),
  capabilities: new Set(["preview", "spawn-agent"]),
  issuedAt: 1,
  expiresAt: 2,
};

const enabledPolicy: SpawnPolicy = { ...DEFAULT_SPAWN_POLICY, enabled: true };

interface Fixture {
  readonly shells?: ReadonlyMap<string, OrchestrationThreadShell>;
  readonly childThreadIds?: ReadonlyArray<ThreadId>;
  readonly capabilities?: ReadonlySet<McpInvocationContext.McpCapability>;
}

const run = (
  policy: SpawnPolicy,
  input: {
    readonly agent_type: string;
    readonly description: string;
    readonly prompt: string;
    readonly model?: string;
  },
  fixture: Fixture = {},
) =>
  Effect.gen(function* () {
    const dispatched = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
    const shells = fixture.shells ?? new Map([[PARENT_THREAD_ID, shell()]]);

    const result = yield* spawnAgent(policy, input).pipe(
      Effect.provideService(OrchestrationEngineService, {
        readEvents: () => Stream.empty,
        dispatch: (command) =>
          Ref.update(dispatched, (commands) => [...commands, command]).pipe(
            Effect.as({ sequence: 1 }),
          ),
        streamDomainEvents: Stream.empty,
        latestSequence: Effect.succeed(0),
      }),
      Effect.provideService(ProjectionSnapshotQuery, {
        getCommandReadModel: () => Effect.die("unused"),
        getSnapshot: () => Effect.die("unused"),
        getShellSnapshot: () => Effect.die("unused"),
        getArchivedShellSnapshot: () => Effect.die("unused"),
        getSnapshotSequence: () => Effect.die("unused"),
        getCounts: () => Effect.die("unused"),
        getActiveProjectByWorkspaceRoot: () => Effect.die("unused"),
        getProjectShellById: () => Effect.die("unused"),
        getFirstActiveThreadIdByProjectId: () => Effect.die("unused"),
        getThreadCheckpointContext: () => Effect.die("unused"),
        getFullThreadDiffContext: () => Effect.die("unused"),
        getThreadShellById: (threadId) => {
          const found = shells.get(threadId);
          return Effect.succeed(found === undefined ? Option.none() : Option.some(found));
        },
        getThreadSessionById: () => Effect.die("unused"),
        getThreadSubagentLiveness: () => Effect.die("unused"),
        getSubagentActivities: () => Effect.die("unused"),
        listChildThreadIds: () => Effect.succeed(fixture.childThreadIds ?? []),
        getThreadDetailById: () => Effect.die("unused"),
        getThreadDetailSnapshot: () => Effect.die("unused"),
      }),
      Effect.provideService(McpInvocationContext.McpInvocationContext, {
        ...invocation,
        ...(fixture.capabilities ? { capabilities: fixture.capabilities } : {}),
      }),
      Effect.result,
    );

    return { result, dispatched: yield* Ref.get(dispatched) };
  }).pipe(Effect.provide(NodeServices.layer));

const spawnInput = {
  agent_type: "Explore",
  description: "Audit the settings migrations",
  prompt: "Find every migration that writes to settings.",
};

describe("spawn_agent handler", () => {
  it.effect("creates the child thread in the parent's worktree and starts its turn", () =>
    Effect.gen(function* () {
      const { result, dispatched } = yield* run(enabledPolicy, spawnInput);

      assert.strictEqual(result._tag, "Success");
      if (result._tag !== "Success") return;
      assert.strictEqual(result.success.spawned, true);
      if (!result.success.spawned) return;
      assert.match(result.success.childThreadId, /^subagent-thread-parent-/);
      assert.strictEqual(result.success.agentType, "Explore");
      assert.strictEqual(result.success.description, "Audit the settings migrations");

      // The two trailing appends mirror the child onto the parent's subagent
      // read model; `childMirror.test.ts` owns their contents.
      assert.deepStrictEqual(
        dispatched.map((command) => command.type),
        ["thread.create", "thread.turn.start", "thread.activity.append", "thread.activity.append"],
      );
      const started = dispatched[2];
      assert.strictEqual(started?.type, "thread.activity.append");
      if (started?.type !== "thread.activity.append") return;
      assert.strictEqual(started.threadId, PARENT_THREAD_ID);
      assert.strictEqual(started.activity.kind, "task.started");
      assert.deepStrictEqual(started.activity.payload, {
        taskId: result.success.childThreadId,
        subagentType: "Explore",
        detail: "Audit the settings migrations",
        prompt: spawnInput.prompt,
      });

      const create = dispatched[0];
      assert.strictEqual(create?.type, "thread.create");
      if (create?.type !== "thread.create") return;
      assert.strictEqual(create.threadId, result.success.childThreadId);
      assert.strictEqual(create.parentThreadId, PARENT_THREAD_ID);
      assert.strictEqual(create.projectId, "project-1");
      assert.strictEqual(create.title, "Audit the settings migrations");
      assert.strictEqual(create.branch, "mine");
      assert.strictEqual(create.worktreePath, "/tmp/parent-worktree");
      assert.strictEqual(create.runtimeMode, "full-access");
      assert.deepStrictEqual(create.modelSelection, {
        instanceId: ProviderInstanceId.make("claude"),
        model: "claude-opus-5",
      });

      const turn = dispatched[1];
      assert.strictEqual(turn?.type, "thread.turn.start");
      if (turn?.type !== "thread.turn.start") return;
      assert.strictEqual(turn.threadId, result.success.childThreadId);
      assert.strictEqual(turn.message.messageId, `${result.success.childThreadId}-prompt`);
      assert.strictEqual(turn.message.text, spawnInput.prompt);
    }),
  );

  it.effect("overrides the model but never the parent's provider instance", () =>
    Effect.gen(function* () {
      const { dispatched } = yield* run(enabledPolicy, {
        ...spawnInput,
        model: "  claude-sonnet-5  ",
      });

      const create = dispatched[0];
      assert.strictEqual(create?.type, "thread.create");
      if (create?.type !== "thread.create") return;
      assert.deepStrictEqual(create.modelSelection, {
        instanceId: ProviderInstanceId.make("claude"),
        model: "claude-sonnet-5",
      });
    }),
  );

  it.effect("refuses without dispatching when the policy is disabled", () =>
    Effect.gen(function* () {
      const { result, dispatched } = yield* run(DEFAULT_SPAWN_POLICY, spawnInput);

      assert.strictEqual(result._tag, "Success");
      if (result._tag !== "Success") return;
      assert.strictEqual(result.success.spawned, false);
      if (result.success.spawned) return;
      assert.strictEqual(result.success.reason, "disabled");
      assert.deepStrictEqual(dispatched, []);
    }),
  );

  it.effect("refuses a grandchild because the parent is itself thread-backed", () =>
    Effect.gen(function* () {
      const grandparentId = ThreadId.make("thread-grandparent");
      const { result } = yield* run(enabledPolicy, spawnInput, {
        shells: new Map([
          [PARENT_THREAD_ID, shell({ parentThreadId: grandparentId })],
          [grandparentId, shell({ id: grandparentId })],
        ]),
      });

      assert.strictEqual(result._tag, "Success");
      if (result._tag !== "Success" || result.success.spawned) return;
      assert.strictEqual(result.success.reason, "depth-cap");
    }),
  );

  it.effect("counts only unsettled children against the concurrency cap", () =>
    Effect.gen(function* () {
      const live = ["child-a", "child-b", "child-c"].map((id) => ThreadId.make(id));
      const done = ThreadId.make("child-done");
      const childShells = new Map<string, OrchestrationThreadShell>([
        [PARENT_THREAD_ID, shell()],
        [
          done,
          shell({
            id: done,
            latestTurn: {
              turnId: TurnId.make("turn-done"),
              state: "completed",
              requestedAt: "2026-08-11T00:00:00.000Z",
              startedAt: "2026-08-11T00:00:00.000Z",
              completedAt: "2026-08-11T00:00:01.000Z",
              assistantMessageId: null,
            },
          }),
        ],
      ]);
      for (const childId of live) {
        childShells.set(
          childId,
          shell({
            id: childId,
            latestTurn: {
              turnId: TurnId.make(`turn-${childId}`),
              state: "running",
              requestedAt: "2026-08-11T00:00:00.000Z",
              startedAt: "2026-08-11T00:00:00.000Z",
              completedAt: null,
              assistantMessageId: null,
            },
          }),
        );
      }

      const settledOnly = yield* run(enabledPolicy, spawnInput, {
        shells: childShells,
        childThreadIds: [done],
      });
      assert.strictEqual(
        settledOnly.result._tag === "Success" ? settledOnly.result.success.spawned : null,
        true,
      );

      const atCap = yield* run(enabledPolicy, spawnInput, {
        shells: childShells,
        childThreadIds: [done, ...live],
      });
      assert.strictEqual(atCap.result._tag, "Success");
      if (atCap.result._tag !== "Success" || atCap.result.success.spawned) return;
      assert.strictEqual(atCap.result.success.reason, "concurrency-cap");
      assert.deepStrictEqual(atCap.dispatched, []);
    }),
  );

  it.effect("fails cleanly when the credential predates the spawn-agent capability", () =>
    Effect.gen(function* () {
      const { result, dispatched } = yield* run(enabledPolicy, spawnInput, {
        capabilities: new Set(["preview"]),
      });

      assert.strictEqual(result._tag, "Failure");
      if (result._tag !== "Failure") return;
      assert.strictEqual(result.failure.reason, "capability-unavailable");
      assert.deepStrictEqual(dispatched, []);
    }),
  );

  it.effect("fails when the calling thread is no longer active", () =>
    Effect.gen(function* () {
      const { result, dispatched } = yield* run(enabledPolicy, spawnInput, {
        shells: new Map(),
      });

      assert.strictEqual(result._tag, "Failure");
      if (result._tag !== "Failure") return;
      assert.strictEqual(result.failure.reason, "parent-thread-missing");
      assert.deepStrictEqual(dispatched, []);
    }),
  );

  it.effect("falls back to an agent-type title when the description is blank", () =>
    Effect.gen(function* () {
      const { dispatched } = yield* run(enabledPolicy, { ...spawnInput, description: "   " });

      const create = dispatched[0];
      assert.strictEqual(create?.type, "thread.create");
      if (create?.type !== "thread.create") return;
      assert.strictEqual(create.title, "Subagent: Explore");
    }),
  );
});
