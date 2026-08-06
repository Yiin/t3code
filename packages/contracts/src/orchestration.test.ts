import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  ModelSelection,
  OrchestrationCommand,
  OrchestrationEvent,
  OrchestrationGetFullThreadDiffInput,
  OrchestrationGetSubagentActivitiesInput,
  OrchestrationGetTurnDiffInput,
  OrchestrationLatestTurn,
  OrchestrationThreadActivity,
  applySubagentActivity,
  closeRunningSubagentsForSession,
  ProjectCreatedPayload,
  ProjectMetaUpdatedPayload,
  OrchestrationProposedPlan,
  OrchestrationSession,
  OrchestrationThread,
  OrchestrationThreadShell,
  ProjectCreateCommand,
  SUBAGENT_TEXT_ACTIVITY_KIND,
  SUBAGENT_THINKING_ACTIVITY_KIND,
  PROVIDER_SUBAGENT_STEER_FAILED_ACTIVITY_KIND,
  SUBAGENT_STEER_DELIVERED_ACTIVITY_KIND,
  SUBAGENT_STEER_REQUESTED_ACTIVITY_KIND,
  SubagentSteerDeliveredActivityPayload,
  SubagentSteerFailedActivityPayload,
  SubagentSteerRequestedActivityPayload,
  decodeSubagentTranscriptActivityPayload,
  ThreadMetaUpdatedPayload,
  ThreadTurnStartCommand,
  ThreadCreatedPayload,
  ThreadTurnDiff,
  ThreadTurnStartRequestedPayload,
} from "./orchestration.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

const decodeTurnDiffInput = Schema.decodeUnknownEffect(OrchestrationGetTurnDiffInput);
const decodeFullThreadDiffInput = Schema.decodeUnknownEffect(OrchestrationGetFullThreadDiffInput);
const decodeSubagentActivitiesInput = Schema.decodeUnknownEffect(
  OrchestrationGetSubagentActivitiesInput,
);
const decodeThreadTurnDiff = Schema.decodeUnknownEffect(ThreadTurnDiff);
const decodeProjectCreateCommand = Schema.decodeUnknownEffect(ProjectCreateCommand);
const decodeProjectCreatedPayload = Schema.decodeUnknownEffect(ProjectCreatedPayload);
const decodeProjectMetaUpdatedPayload = Schema.decodeUnknownEffect(ProjectMetaUpdatedPayload);
const decodeThreadTurnStartCommand = Schema.decodeUnknownEffect(ThreadTurnStartCommand);
const decodeThreadTurnStartRequestedPayload = Schema.decodeUnknownEffect(
  ThreadTurnStartRequestedPayload,
);
const decodeOrchestrationLatestTurn = Schema.decodeUnknownEffect(OrchestrationLatestTurn);
const decodeOrchestrationProposedPlan = Schema.decodeUnknownEffect(OrchestrationProposedPlan);
const decodeOrchestrationSession = Schema.decodeUnknownEffect(OrchestrationSession);
const decodeOrchestrationThread = Schema.decodeUnknownEffect(OrchestrationThread);
const decodeOrchestrationThreadShell = Schema.decodeUnknownEffect(OrchestrationThreadShell);
const encodeThreadCreatedPayload = Schema.encodeEffect(ThreadCreatedPayload);
const decodeSubagentSteerRequested = Schema.decodeUnknownEffect(
  SubagentSteerRequestedActivityPayload,
);
const decodeSubagentSteerDelivered = Schema.decodeUnknownEffect(
  SubagentSteerDeliveredActivityPayload,
);
const decodeSubagentSteerFailed = Schema.decodeUnknownEffect(SubagentSteerFailedActivityPayload);
const encodeSubagentSteerRequested = Schema.encodeEffect(SubagentSteerRequestedActivityPayload);
const encodeSubagentSteerDelivered = Schema.encodeEffect(SubagentSteerDeliveredActivityPayload);
const encodeSubagentSteerFailed = Schema.encodeEffect(SubagentSteerFailedActivityPayload);

function getOptionValue(
  options: ReadonlyArray<{ id: string; value: unknown }> | undefined,
  id: string,
): unknown {
  return options?.find((option) => option.id === id)?.value;
}
const decodeThreadCreatedPayload = Schema.decodeUnknownEffect(ThreadCreatedPayload);
const decodeOrchestrationCommand = Schema.decodeUnknownEffect(OrchestrationCommand);
const decodeOrchestrationEvent = Schema.decodeUnknownEffect(OrchestrationEvent);
const decodeThreadMetaUpdatedPayload = Schema.decodeUnknownEffect(ThreadMetaUpdatedPayload);

it.effect("parses turn diff input when fromTurnCount <= toTurnCount", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeTurnDiffInput({
      threadId: "thread-1",
      fromTurnCount: 1,
      toTurnCount: 2,
    });
    assert.strictEqual(parsed.fromTurnCount, 1);
    assert.strictEqual(parsed.toTurnCount, 2);
  }),
);

it.effect("parses turn diff input with whitespace ignoring enabled", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeTurnDiffInput({
      threadId: "thread-1",
      fromTurnCount: 1,
      toTurnCount: 2,
      ignoreWhitespace: true,
    });
    assert.strictEqual(parsed.ignoreWhitespace, true);
  }),
);

it.effect("parses full thread diff input with whitespace ignoring enabled", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeFullThreadDiffInput({
      threadId: "thread-1",
      toTurnCount: 2,
      ignoreWhitespace: true,
    });
    assert.strictEqual(parsed.ignoreWhitespace, true);
  }),
);

it.effect("parses a bounded subagent activity cursor", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeSubagentActivitiesInput({
      threadId: "thread-1",
      subagentId: "task-1",
      limit: 200,
      before: {
        sequence: null,
        createdAt: "2026-08-05T00:00:00.000Z",
        activityId: "activity-1",
      },
    });
    assert.strictEqual(parsed.limit, 200);
    assert.strictEqual(parsed.before?.sequence, null);
  }),
);

it.effect("rejects a subagent activity page above the limit", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      decodeSubagentActivitiesInput({
        threadId: "thread-1",
        subagentId: "task-1",
        limit: 201,
      }),
    );
    assert.strictEqual(result._tag, "Failure");
  }),
);

it.effect("rejects turn diff input when fromTurnCount > toTurnCount", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      decodeTurnDiffInput({
        threadId: "thread-1",
        fromTurnCount: 3,
        toTurnCount: 2,
      }),
    );
    assert.strictEqual(result._tag, "Failure");
  }),
);

it.effect("rejects thread turn diff when fromTurnCount > toTurnCount", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      decodeThreadTurnDiff({
        threadId: "thread-1",
        fromTurnCount: 3,
        toTurnCount: 2,
        diff: "patch",
      }),
    );
    assert.strictEqual(result._tag, "Failure");
  }),
);

it.effect("trims branded ids and command string fields at decode boundaries", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeProjectCreateCommand({
      type: "project.create",
      commandId: " cmd-1 ",
      projectId: " project-1 ",
      title: " Project Title ",
      workspaceRoot: " /tmp/workspace ",
      defaultModelSelection: {
        provider: "codex",
        model: " gpt-5.2 ",
      },
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.commandId, "cmd-1");
    assert.strictEqual(parsed.projectId, "project-1");
    assert.strictEqual(parsed.title, "Project Title");
    assert.strictEqual(parsed.workspaceRoot, "/tmp/workspace");
    assert.strictEqual(parsed.createWorkspaceRootIfMissing, undefined);
    assert.deepStrictEqual(parsed.defaultModelSelection, {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.2",
    });
  }),
);

it.effect("decodes project.create with createWorkspaceRootIfMissing enabled", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeProjectCreateCommand({
      type: "project.create",
      commandId: "cmd-1",
      projectId: "project-1",
      title: "Project Title",
      workspaceRoot: "/tmp/workspace",
      createWorkspaceRootIfMissing: true,
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    assert.strictEqual(parsed.createWorkspaceRootIfMissing, true);
  }),
);

it.effect("decodes historical project.created payloads with a default provider", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeProjectCreatedPayload({
      projectId: "project-1",
      title: "Project Title",
      workspaceRoot: "/tmp/workspace",
      defaultModelSelection: {
        provider: "codex",
        model: "gpt-5.4",
      },
      scripts: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.defaultModelSelection?.instanceId, "codex");
  }),
);

it.effect("decodes project.meta-updated payloads with explicit default provider", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeProjectMetaUpdatedPayload({
      projectId: "project-1",
      defaultModelSelection: {
        provider: "claudeAgent",
        model: "claude-opus-4-6",
      },
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.defaultModelSelection?.instanceId, "claudeAgent");
  }),
);

it.effect("rejects command fields that become empty after trim", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      decodeProjectCreateCommand({
        type: "project.create",
        commandId: "cmd-1",
        projectId: "project-1",
        title: "  ",
        workspaceRoot: "/tmp/workspace",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    assert.strictEqual(result._tag, "Failure");
  }),
);

it.effect("decodes thread.turn.start defaults for provider and runtime mode", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadTurnStartCommand({
      type: "thread.turn.start",
      commandId: "cmd-turn-1",
      threadId: "thread-1",
      message: {
        messageId: "msg-1",
        role: "user",
        text: "hello",
        attachments: [],
      },
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.modelSelection, undefined);
    assert.strictEqual(parsed.runtimeMode, DEFAULT_RUNTIME_MODE);
    assert.strictEqual(parsed.interactionMode, DEFAULT_PROVIDER_INTERACTION_MODE);
  }),
);

it.effect("preserves explicit provider and runtime mode in thread.turn.start", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadTurnStartCommand({
      type: "thread.turn.start",
      commandId: "cmd-turn-2",
      threadId: "thread-1",
      message: {
        messageId: "msg-2",
        role: "user",
        text: "hello",
        attachments: [],
      },
      modelSelection: {
        provider: "codex",
        model: "gpt-5.4",
      },
      runtimeMode: "full-access",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.modelSelection?.instanceId, "codex");
    assert.strictEqual(parsed.runtimeMode, "full-access");
    assert.strictEqual(parsed.interactionMode, DEFAULT_PROVIDER_INTERACTION_MODE);
  }),
);

it.effect("accepts bootstrap metadata in thread.turn.start", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadTurnStartCommand({
      type: "thread.turn.start",
      commandId: "cmd-turn-bootstrap",
      threadId: "thread-1",
      message: {
        messageId: "msg-bootstrap",
        role: "user",
        text: "hello",
        attachments: [],
      },
      bootstrap: {
        createThread: {
          projectId: "project-1",
          title: "Bootstrap thread",
          modelSelection: {
            provider: "codex",
            model: "gpt-5.4",
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        prepareWorktree: {
          projectCwd: "/tmp/workspace",
          baseBranch: "main",
          branch: "t3code/example",
          startFromOrigin: true,
        },
        runSetupScript: true,
      },
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.bootstrap?.createThread?.projectId, "project-1");
    assert.strictEqual(parsed.bootstrap?.prepareWorktree?.baseBranch, "main");
    assert.strictEqual(parsed.bootstrap?.prepareWorktree?.startFromOrigin, true);
    assert.strictEqual(parsed.bootstrap?.runSetupScript, true);
  }),
);

it.effect("decodes thread.created runtime mode for historical events", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadCreatedPayload({
      threadId: "thread-1",
      projectId: "project-1",
      title: "Thread title",
      modelSelection: {
        provider: "codex",
        model: "gpt-5.4",
      },
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    assert.strictEqual(parsed.runtimeMode, DEFAULT_RUNTIME_MODE);
    assert.strictEqual(parsed.modelSelection.instanceId, "codex");
  }),
);

it.effect("decodes thread.meta-updated payloads with explicit provider", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadMetaUpdatedPayload({
      threadId: "thread-1",
      modelSelection: {
        provider: "claudeAgent",
        model: "claude-opus-4-6",
      },
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.modelSelection?.instanceId, "claudeAgent");
  }),
);

it.effect("decodes thread archive and unarchive commands", () =>
  Effect.gen(function* () {
    const archive = yield* decodeOrchestrationCommand({
      type: "thread.archive",
      commandId: "cmd-archive-1",
      threadId: "thread-1",
    });
    const unarchive = yield* decodeOrchestrationCommand({
      type: "thread.unarchive",
      commandId: "cmd-unarchive-1",
      threadId: "thread-1",
    });

    assert.strictEqual(archive.type, "thread.archive");
    assert.strictEqual(unarchive.type, "thread.unarchive");
  }),
);

it.effect("decodes thread settle and unsettle commands", () =>
  Effect.gen(function* () {
    const settle = yield* decodeOrchestrationCommand({
      type: "thread.settle",
      commandId: "cmd-settle-1",
      threadId: "thread-1",
    });
    const unsettle = yield* decodeOrchestrationCommand({
      type: "thread.unsettle",
      commandId: "cmd-unsettle-1",
      threadId: "thread-1",
      reason: "user",
    });

    assert.strictEqual(settle.type, "thread.settle");
    assert.strictEqual(unsettle.type, "thread.unsettle");

    // "activity" is server-owned: it exists on the event, never on the
    // command, so a client cannot forge the neutral reset.
    const forged = yield* decodeOrchestrationCommand({
      type: "thread.unsettle",
      commandId: "cmd-unsettle-2",
      threadId: "thread-1",
      reason: "activity",
    }).pipe(Effect.flip);
    assert.ok(forged);
  }),
);

it.effect("defaults settled fields when decoding historical thread data", () =>
  Effect.gen(function* () {
    const common = {
      id: "thread-1",
      projectId: "project-1",
      title: "Historical thread",
      modelSelection: { provider: "codex", model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      latestTurn: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      archivedAt: null,
      session: null,
    };
    const thread = yield* decodeOrchestrationThread({
      ...common,
      deletedAt: null,
      messages: [],
      proposedPlans: [],
      activities: [],
      checkpoints: [],
    });
    const shell = yield* decodeOrchestrationThreadShell({
      ...common,
      latestUserMessageAt: null,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      hasActionableProposedPlan: false,
    });

    assert.strictEqual(thread.settledOverride, null);
    assert.strictEqual(thread.settledAt, null);
    assert.strictEqual(shell.settledOverride, null);
    assert.strictEqual(shell.settledAt, null);
  }),
);

it.effect("leaves the activity truncation marker absent for snapshots without one", () =>
  Effect.gen(function* () {
    const common = {
      id: "thread-1",
      projectId: "project-1",
      title: "Cached thread",
      modelSelection: { provider: "codex", model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      latestTurn: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      archivedAt: null,
      session: null,
      deletedAt: null,
      messages: [],
      proposedPlans: [],
      activities: [],
      checkpoints: [],
    };

    // An old server or a cached snapshot written before the marker existed.
    const withoutMarker = yield* decodeOrchestrationThread(common);
    assert.strictEqual(withoutMarker.activitiesTruncated, undefined);

    const withMarker = yield* decodeOrchestrationThread({
      ...common,
      activitiesTruncated: { omittedCount: 42 },
    });
    assert.deepStrictEqual(withMarker.activitiesTruncated, { omittedCount: 42 });
  }),
);

it.effect("defaults subagent fields when decoding historical thread data", () =>
  Effect.gen(function* () {
    const common = {
      id: "thread-1",
      projectId: "project-1",
      title: "Historical thread",
      modelSelection: { provider: "codex", model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      latestTurn: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      archivedAt: null,
      session: null,
    };

    // Snapshots written before subagents existed carry neither field.
    const thread = yield* decodeOrchestrationThread({
      ...common,
      deletedAt: null,
      messages: [],
      proposedPlans: [],
      activities: [],
      checkpoints: [],
    });
    const shell = yield* decodeOrchestrationThreadShell({
      ...common,
      latestUserMessageAt: null,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      hasActionableProposedPlan: false,
    });

    assert.deepStrictEqual(thread.subagents, []);
    assert.strictEqual(shell.activeSubagentCount, 0);
  }),
);

const decodeThreadActivity = Schema.decodeUnknownSync(OrchestrationThreadActivity);

function subagentActivity(input: {
  id: string;
  kind: string;
  payload: unknown;
  createdAt: string;
}): OrchestrationThreadActivity {
  return decodeThreadActivity({
    id: input.id,
    tone: "info",
    kind: input.kind,
    summary: "subagent activity",
    payload: input.payload,
    turnId: "turn-1",
    createdAt: input.createdAt,
  });
}

const subagentStarted = subagentActivity({
  id: "evt-task-started",
  kind: "task.started",
  payload: {
    taskId: "a027ffbeca4f867d2",
    taskType: "local_agent",
    detail: "List repo files",
    subagentType: "Explore",
    toolUseId: "toolu_01TAkofjCxTj5rN3WCrNKgf8",
  },
  createdAt: "2026-01-01T00:00:00.000Z",
});
const subagentProgress = subagentActivity({
  id: "evt-task-progress",
  kind: "task.progress",
  payload: {
    taskId: "a027ffbeca4f867d2",
    title: "Running List files recursively",
    detail: "Running List files recursively",
    lastToolName: "Bash",
    usage: { total_tokens: 17215 },
  },
  createdAt: "2026-01-01T00:00:05.000Z",
});
const subagentCompleted = subagentActivity({
  id: "evt-task-completed",
  kind: "task.completed",
  payload: {
    taskId: "a027ffbeca4f867d2",
    status: "completed",
    summary: "Repo surveyed",
    usage: { total_tokens: 17486 },
  },
  createdAt: "2026-01-01T00:00:09.000Z",
});

it("decodes subagent transcript activity payloads", () => {
  const minimal = decodeSubagentTranscriptActivityPayload({
    parentToolUseId: "toolu_01TAkofjCxTj5rN3WCrNKgf8",
    text: "Inspecting the repository",
  });
  assert.ok(Option.isSome(minimal));
  assert.strictEqual(minimal.value.parentToolUseId, "toolu_01TAkofjCxTj5rN3WCrNKgf8");
  assert.strictEqual(minimal.value.text, "Inspecting the repository");
  assert.strictEqual(minimal.value.subagentType, undefined);
  assert.strictEqual(minimal.value.truncated, undefined);

  const full = decodeSubagentTranscriptActivityPayload({
    parentToolUseId: "toolu_01TAkofjCxTj5rN3WCrNKgf8",
    text: "Inspecting the repository",
    subagentType: "Explore",
    truncated: true,
  });
  assert.ok(Option.isSome(full));
  assert.strictEqual(full.value.subagentType, "Explore");
  assert.strictEqual(full.value.truncated, true);

  assert.ok(
    Option.isNone(
      decodeSubagentTranscriptActivityPayload({
        parentToolUseId: "toolu_01TAkofjCxTj5rN3WCrNKgf8",
      }),
    ),
  );
});

it("keeps the subagent read model unchanged for transcript activities", () => {
  const subagents = applySubagentActivity([], subagentStarted);
  const textActivity = subagentActivity({
    id: "evt-subagent-text",
    kind: SUBAGENT_TEXT_ACTIVITY_KIND,
    payload: {
      parentToolUseId: "toolu_01TAkofjCxTj5rN3WCrNKgf8",
      text: "Inspecting the repository",
    },
    createdAt: "2026-01-01T00:00:06.000Z",
  });
  const thinkingActivity = subagentActivity({
    id: "evt-subagent-thinking",
    kind: SUBAGENT_THINKING_ACTIVITY_KIND,
    payload: {
      parentToolUseId: "toolu_01TAkofjCxTj5rN3WCrNKgf8",
      text: "Finding the relevant contract",
    },
    createdAt: "2026-01-01T00:00:07.000Z",
  });

  assert.strictEqual(applySubagentActivity(subagents, textActivity), subagents);
  assert.strictEqual(applySubagentActivity(subagents, thinkingActivity), subagents);
});

it.effect("round-trips subagent steer activity payloads", () =>
  Effect.gen(function* () {
    const requested = {
      subagentId: "subagent-1",
      text: "Check the parser",
      steerId: "steer-1",
    };
    const delivered = { subagentId: "subagent-1", steerId: "steer-1" };
    const failed = {
      subagentId: "subagent-1",
      steerId: "steer-1",
      detail: "Session ended",
    };

    const decodedRequested = yield* decodeSubagentSteerRequested(requested);
    const decodedDelivered = yield* decodeSubagentSteerDelivered(delivered);
    const decodedFailed = yield* decodeSubagentSteerFailed(failed);

    assert.deepStrictEqual(yield* encodeSubagentSteerRequested(decodedRequested), requested);
    assert.deepStrictEqual(yield* encodeSubagentSteerDelivered(decodedDelivered), delivered);
    assert.deepStrictEqual(yield* encodeSubagentSteerFailed(decodedFailed), failed);
  }),
);

it("keeps the subagent read model reference for steer activities", () => {
  const rows = applySubagentActivity([], subagentStarted);
  const activities = [
    subagentActivity({
      id: "evt-steer-requested",
      kind: SUBAGENT_STEER_REQUESTED_ACTIVITY_KIND,
      payload: { subagentId: "subagent-1", text: "Check the parser", steerId: "steer-1" },
      createdAt: "2026-01-01T00:00:06.000Z",
    }),
    subagentActivity({
      id: "evt-steer-delivered",
      kind: SUBAGENT_STEER_DELIVERED_ACTIVITY_KIND,
      payload: { subagentId: "subagent-1", steerId: "steer-1" },
      createdAt: "2026-01-01T00:00:07.000Z",
    }),
    subagentActivity({
      id: "evt-steer-failed",
      kind: PROVIDER_SUBAGENT_STEER_FAILED_ACTIVITY_KIND,
      payload: { subagentId: "subagent-1", steerId: "steer-1", detail: "Session ended" },
      createdAt: "2026-01-01T00:00:08.000Z",
    }),
  ];

  for (const activity of activities) {
    assert.strictEqual(applySubagentActivity(rows, activity), rows);
  }
});

it("folds a started->progress->completed sequence into one subagent row", () => {
  const afterStarted = applySubagentActivity([], subagentStarted);
  assert.strictEqual(afterStarted.length, 1);
  const started = afterStarted[0];
  assert.ok(started);
  assert.strictEqual(started.subagentId, "a027ffbeca4f867d2");
  assert.strictEqual(started.status, "running");
  assert.strictEqual(started.turnId, "turn-1");
  assert.strictEqual(started.agentType, "Explore");
  assert.strictEqual(started.description, "List repo files");
  assert.strictEqual(started.spawnedByItemId, "toolu_01TAkofjCxTj5rN3WCrNKgf8");
  assert.strictEqual(started.startedAt, "2026-01-01T00:00:00.000Z");
  assert.strictEqual(started.completedAt, null);

  const afterProgress = applySubagentActivity(afterStarted, subagentProgress);
  assert.strictEqual(afterProgress.length, 1);
  const progressed = afterProgress[0];
  assert.ok(progressed);
  assert.strictEqual(progressed.status, "running");
  assert.strictEqual(progressed.lastProgressSummary, "Running List files recursively");
  assert.strictEqual(progressed.lastToolName, "Bash");
  assert.deepStrictEqual(progressed.usage, { total_tokens: 17215 });
  assert.strictEqual(progressed.updatedAt, "2026-01-01T00:00:05.000Z");
  assert.strictEqual(progressed.completedAt, null);

  const afterCompleted = applySubagentActivity(afterProgress, subagentCompleted);
  assert.strictEqual(afterCompleted.length, 1);
  const completed = afterCompleted[0];
  assert.ok(completed);
  assert.strictEqual(completed.status, "completed");
  assert.strictEqual(completed.lastProgressSummary, "Repo surveyed");
  assert.deepStrictEqual(completed.usage, { total_tokens: 17486 });
  assert.strictEqual(completed.startedAt, "2026-01-01T00:00:00.000Z");
  assert.strictEqual(completed.updatedAt, "2026-01-01T00:00:09.000Z");
  assert.strictEqual(completed.completedAt, "2026-01-01T00:00:09.000Z");
});

it("applies subagent activities idempotently for reconnect replay", () => {
  const afterStarted = applySubagentActivity([], subagentStarted);
  assert.deepStrictEqual(applySubagentActivity(afterStarted, subagentStarted), afterStarted);

  const afterProgress = applySubagentActivity(afterStarted, subagentProgress);
  assert.deepStrictEqual(applySubagentActivity(afterProgress, subagentProgress), afterProgress);

  const afterCompleted = applySubagentActivity(afterProgress, subagentCompleted);
  assert.deepStrictEqual(applySubagentActivity(afterCompleted, subagentCompleted), afterCompleted);

  // A full replay over settled state must not revive or downgrade the row.
  const replayed = [subagentStarted, subagentProgress, subagentCompleted].reduce(
    applySubagentActivity,
    afterCompleted,
  );
  assert.deepStrictEqual(replayed, afterCompleted);
});

it("ignores non-task activity kinds and undecodable task payloads", () => {
  const rows = applySubagentActivity([], subagentStarted);

  const toolActivity = subagentActivity({
    id: "evt-tool",
    kind: "tool.progress",
    payload: { toolName: "Bash" },
    createdAt: "2026-01-01T00:00:06.000Z",
  });
  assert.strictEqual(applySubagentActivity(rows, toolActivity), rows);

  const malformed = subagentActivity({
    id: "evt-task-malformed",
    kind: "task.completed",
    payload: { status: "completed" },
    createdAt: "2026-01-01T00:00:07.000Z",
  });
  assert.strictEqual(applySubagentActivity(rows, malformed), rows);
});

it("creates a running row for progress on an unseen task", () => {
  // Reconnect replay can start mid-stream: progress may be the first signal.
  const rows = applySubagentActivity([], subagentProgress);
  assert.strictEqual(rows.length, 1);
  const row = rows[0];
  assert.ok(row);
  assert.strictEqual(row.subagentId, "a027ffbeca4f867d2");
  assert.strictEqual(row.status, "running");
  assert.strictEqual(row.startedAt, "2026-01-01T00:00:05.000Z");
});

it("closes running subagent rows when the session reaches a terminal status", () => {
  const running = applySubagentActivity([], subagentStarted);

  const failed = closeRunningSubagentsForSession(running, {
    status: "error",
    updatedAt: "2026-01-01T00:01:00.000Z",
  });
  assert.strictEqual(failed.length, 1);
  assert.strictEqual(failed[0]?.status, "failed");
  assert.strictEqual(failed[0]?.updatedAt, "2026-01-01T00:01:00.000Z");
  assert.strictEqual(failed[0]?.completedAt, "2026-01-01T00:01:00.000Z");

  const stopped = closeRunningSubagentsForSession(running, {
    status: "stopped",
    updatedAt: "2026-01-01T00:01:00.000Z",
  });
  assert.strictEqual(stopped[0]?.status, "stopped");
  assert.strictEqual(stopped[0]?.completedAt, "2026-01-01T00:01:00.000Z");
});

it("leaves subagent rows untouched for non-terminal session statuses and settled rows", () => {
  const running = applySubagentActivity([], subagentStarted);

  // The incident class has the main stream falsely idle while a subagent
  // still works: idle/ready/running must never close a running row.
  for (const status of ["idle", "starting", "running", "ready", "interrupted"] as const) {
    assert.strictEqual(
      closeRunningSubagentsForSession(running, {
        status,
        updatedAt: "2026-01-01T00:01:00.000Z",
      }),
      running,
    );
  }

  // A settled row keeps its own completion status and timestamps.
  const settled = applySubagentActivity(running, subagentCompleted);
  assert.strictEqual(
    closeRunningSubagentsForSession(settled, {
      status: "error",
      updatedAt: "2026-01-01T00:01:00.000Z",
    }),
    settled,
  );
});

it.effect("decodes thread archived and unarchived events", () =>
  Effect.gen(function* () {
    const archived = yield* decodeOrchestrationEvent({
      sequence: 1,
      eventId: "event-archive-1",
      aggregateKind: "thread",
      aggregateId: "thread-1",
      type: "thread.archived",
      occurredAt: "2026-01-01T00:00:00.000Z",
      commandId: "cmd-archive-1",
      causationEventId: null,
      correlationId: "cmd-archive-1",
      metadata: {},
      payload: {
        threadId: "thread-1",
        archivedAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    });
    const unarchived = yield* decodeOrchestrationEvent({
      sequence: 2,
      eventId: "event-unarchive-1",
      aggregateKind: "thread",
      aggregateId: "thread-1",
      type: "thread.unarchived",
      occurredAt: "2026-01-02T00:00:00.000Z",
      commandId: "cmd-unarchive-1",
      causationEventId: null,
      correlationId: "cmd-unarchive-1",
      metadata: {},
      payload: {
        threadId: "thread-1",
        updatedAt: "2026-01-02T00:00:00.000Z",
      },
    });

    if (archived.type !== "thread.archived") {
      assert.fail(`Expected thread.archived event, received ${archived.type}.`);
    }
    assert.strictEqual(archived.payload.archivedAt, "2026-01-01T00:00:00.000Z");
    assert.strictEqual(unarchived.type, "thread.unarchived");
  }),
);

it.effect("decodes thread settled and unsettled events", () =>
  Effect.gen(function* () {
    const settled = yield* decodeOrchestrationEvent({
      sequence: 1,
      eventId: "event-settle-1",
      aggregateKind: "thread",
      aggregateId: "thread-1",
      type: "thread.settled",
      occurredAt: "2026-01-01T00:00:00.000Z",
      commandId: "cmd-settle-1",
      causationEventId: null,
      correlationId: "cmd-settle-1",
      metadata: {},
      payload: {
        threadId: "thread-1",
        settledAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    });
    const unsettled = yield* decodeOrchestrationEvent({
      sequence: 2,
      eventId: "event-unsettle-1",
      aggregateKind: "thread",
      aggregateId: "thread-1",
      type: "thread.unsettled",
      occurredAt: "2026-01-02T00:00:00.000Z",
      commandId: "cmd-unsettle-1",
      causationEventId: null,
      correlationId: "cmd-unsettle-1",
      metadata: {},
      payload: {
        threadId: "thread-1",
        reason: "user",
        updatedAt: "2026-01-02T00:00:00.000Z",
      },
    });

    assert.strictEqual(settled.type, "thread.settled");
    assert.strictEqual(unsettled.type, "thread.unsettled");
  }),
);

it.effect("accepts provider-scoped model options in thread.turn.start", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadTurnStartCommand({
      type: "thread.turn.start",
      commandId: "cmd-turn-options",
      threadId: "thread-1",
      message: {
        messageId: "msg-options",
        role: "user",
        text: "hello",
        attachments: [],
      },
      modelSelection: {
        provider: "codex",
        model: "gpt-5.3-codex",
        options: [
          { id: "reasoningEffort", value: "high" },
          { id: "fastMode", value: true },
        ],
      },
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.modelSelection?.instanceId, "codex");
    assert.strictEqual(getOptionValue(parsed.modelSelection?.options, "reasoningEffort"), "high");
    assert.strictEqual(getOptionValue(parsed.modelSelection?.options, "fastMode"), true);
  }),
);

it.effect("normalizes legacy object-shaped modelSelection.options on decode", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadCreatedPayload({
      threadId: "thread-1",
      projectId: "project-1",
      title: "Legacy options thread",
      modelSelection: {
        provider: "claudeAgent",
        model: "claude-opus-4-6",
        options: {
          effort: "max",
          fastMode: true,
          // Falsy/garbage entries are dropped, matching migration 026.
          emptyStr: "   ",
          nullish: null,
          nested: { foo: 1 },
        },
      },
      branch: null,
      worktreePath: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    assert.strictEqual(parsed.modelSelection.instanceId, ProviderInstanceId.make("claudeAgent"));
    assert.deepStrictEqual(parsed.modelSelection.options, [
      { id: "effort", value: "max" },
      { id: "fastMode", value: true },
    ]);
  }),
);

it.effect("normalizes legacy object-shaped defaultModelSelection.options on decode", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeProjectCreatedPayload({
      projectId: "project-1",
      title: "Legacy default project",
      workspaceRoot: "/tmp/legacy",
      defaultModelSelection: {
        provider: "codex",
        model: "gpt-5.4",
        options: { reasoningEffort: "low" },
      },
      scripts: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    assert.deepStrictEqual(parsed.defaultModelSelection?.options, [
      { id: "reasoningEffort", value: "low" },
    ]);
  }),
);

it.effect(
  "normalizes legacy object-shaped options on decode and re-encodes as canonical array",
  () =>
    Effect.gen(function* () {
      const decoded = yield* decodeThreadCreatedPayload({
        threadId: "thread-1",
        projectId: "project-1",
        title: "Round trip thread",
        modelSelection: {
          provider: "codex",
          model: "gpt-5.4",
          options: { fastMode: true },
        },
        branch: null,
        worktreePath: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      });

      const encoded = yield* encodeThreadCreatedPayload(decoded);
      assert.deepStrictEqual(encoded.modelSelection.options, [{ id: "fastMode", value: true }]);
    }),
);

it.effect("accepts a title seed in thread.turn.start", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadTurnStartCommand({
      type: "thread.turn.start",
      commandId: "cmd-turn-title-seed",
      threadId: "thread-1",
      message: {
        messageId: "msg-title-seed",
        role: "user",
        text: "hello",
        attachments: [],
      },
      titleSeed: "Investigate reconnect failures",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.titleSeed, "Investigate reconnect failures");
  }),
);

it.effect("accepts a source proposed plan reference in thread.turn.start", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadTurnStartCommand({
      type: "thread.turn.start",
      commandId: "cmd-turn-source-plan",
      threadId: "thread-2",
      message: {
        messageId: "msg-source-plan",
        role: "user",
        text: "implement this",
        attachments: [],
      },
      sourceProposedPlan: {
        threadId: "thread-1",
        planId: "plan-1",
      },
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    assert.deepStrictEqual(parsed.sourceProposedPlan, {
      threadId: "thread-1",
      planId: "plan-1",
    });
  }),
);

it.effect(
  "decodes thread.turn-start-requested defaults for provider, runtime mode, and interaction mode",
  () =>
    Effect.gen(function* () {
      const parsed = yield* decodeThreadTurnStartRequestedPayload({
        threadId: "thread-1",
        messageId: "msg-1",
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      assert.strictEqual(parsed.modelSelection, undefined);
      assert.strictEqual(parsed.runtimeMode, DEFAULT_RUNTIME_MODE);
      assert.strictEqual(parsed.interactionMode, DEFAULT_PROVIDER_INTERACTION_MODE);
      assert.strictEqual(parsed.sourceProposedPlan, undefined);
    }),
);

it.effect("decodes thread.turn-start-requested source proposed plan metadata when present", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadTurnStartRequestedPayload({
      threadId: "thread-2",
      messageId: "msg-2",
      sourceProposedPlan: {
        threadId: "thread-1",
        planId: "plan-1",
      },
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    assert.deepStrictEqual(parsed.sourceProposedPlan, {
      threadId: "thread-1",
      planId: "plan-1",
    });
  }),
);

it.effect("decodes thread.turn-start-requested title seed when present", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadTurnStartRequestedPayload({
      threadId: "thread-2",
      messageId: "msg-2",
      titleSeed: "Investigate reconnect failures",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.titleSeed, "Investigate reconnect failures");
  }),
);

it.effect("decodes latest turn source proposed plan metadata when present", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeOrchestrationLatestTurn({
      turnId: "turn-2",
      state: "running",
      requestedAt: "2026-01-01T00:00:00.000Z",
      startedAt: "2026-01-01T00:00:01.000Z",
      completedAt: null,
      assistantMessageId: null,
      sourceProposedPlan: {
        threadId: "thread-1",
        planId: "plan-1",
      },
    });
    assert.deepStrictEqual(parsed.sourceProposedPlan, {
      threadId: "thread-1",
      planId: "plan-1",
    });
  }),
);

it.effect("decodes orchestration session runtime mode defaults", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeOrchestrationSession({
      threadId: "thread-1",
      status: "idle",
      providerName: null,
      providerSessionId: null,
      providerThreadId: null,
      activeTurnId: null,
      lastError: null,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.runtimeMode, DEFAULT_RUNTIME_MODE);
  }),
);

it.effect("defaults proposed plan implementation metadata for historical rows", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeOrchestrationProposedPlan({
      id: "plan-1",
      turnId: "turn-1",
      planMarkdown: "# Plan",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.implementedAt, null);
    assert.strictEqual(parsed.implementationThreadId, null);
  }),
);

it.effect("preserves proposed plan implementation metadata when present", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeOrchestrationProposedPlan({
      id: "plan-2",
      turnId: "turn-2",
      planMarkdown: "# Plan",
      implementedAt: "2026-01-02T00:00:00.000Z",
      implementationThreadId: "thread-2",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    });
    assert.strictEqual(parsed.implementedAt, "2026-01-02T00:00:00.000Z");
    assert.strictEqual(parsed.implementationThreadId, "thread-2");
  }),
);

// ── ModelSelection: instance-keyed wire shape + legacy decoder ────────
//
// `ModelSelection` is routing-keyed on `instanceId` — never a driver kind.
// Persisted and in-flight payloads from pre-instance builds carry a
// `provider` field whose value was a driver kind; those payloads are migrated
// at the wire boundary by
// promoting `provider` to the default instance id for that driver
// (built-in drivers use the driver kind slug as their default instance id, so
// the migration is a 1:1 rename).
//
// These tests pin the rollback/fork tolerance invariant: legacy payloads
// decode cleanly for fork-provided drivers, and the decoded form uses
// `instanceId` uniformly regardless of origin.

const decodeModelSelection = Schema.decodeUnknownEffect(ModelSelection);
const encodeModelSelection = Schema.encodeUnknownEffect(ModelSelection);

it.effect("ModelSelection migrates legacy `provider` field to `instanceId`", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeModelSelection({
      provider: "codex",
      model: "gpt-5-codex",
      options: [{ id: "reasoningEffort", value: "high" }],
    });
    assert.strictEqual(parsed.instanceId, ProviderInstanceId.make("codex"));
    assert.strictEqual(parsed.model, "gpt-5-codex");
    assert.deepStrictEqual(parsed.options, [{ id: "reasoningEffort", value: "high" }]);
  }),
);

it.effect("ModelSelection accepts an explicit instanceId routing key", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeModelSelection({
      instanceId: "codex_personal",
      model: "gpt-5-codex",
    });
    assert.strictEqual(parsed.instanceId, ProviderInstanceId.make("codex_personal"));
  }),
);

it.effect("ModelSelection prefers explicit instanceId over legacy provider", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeModelSelection({
      provider: "codex",
      instanceId: "codex_personal",
      model: "gpt-5-codex",
    });
    assert.strictEqual(parsed.instanceId, ProviderInstanceId.make("codex_personal"));
  }),
);

it.effect(
  "ModelSelection decodes unknown driver kinds via legacy provider (rollback / fork invariant)",
  () =>
    Effect.gen(function* () {
      const parsed = yield* decodeModelSelection({
        provider: "ollama",
        model: "llama3:70b",
        options: [{ id: "temperature", value: "0.4" }],
      });
      assert.strictEqual(parsed.instanceId, ProviderInstanceId.make("ollama"));
      assert.strictEqual(parsed.model, "llama3:70b");
    }),
);

it.effect("ModelSelection encodes to the canonical instanceId wire form", () =>
  Effect.gen(function* () {
    const decoded = yield* decodeModelSelection({
      provider: "ollama",
      model: "llama3:70b",
      options: [{ id: "temperature", value: "0.4" }],
    });
    const encoded = yield* encodeModelSelection(decoded);
    assert.deepStrictEqual(encoded, {
      instanceId: "ollama",
      model: "llama3:70b",
      options: [{ id: "temperature", value: "0.4" }],
    });
  }),
);

it.effect("ModelSelection rejects malformed instance ids", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      decodeModelSelection({
        instanceId: "1invalid", // must start with a letter
        model: "x",
      }),
    );
    assert.strictEqual(result._tag, "Failure");
  }),
);
