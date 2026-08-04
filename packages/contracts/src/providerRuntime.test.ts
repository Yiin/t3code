import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { ProviderRuntimeEvent } from "./providerRuntime.ts";

const decodeRuntimeEvent = Schema.decodeUnknownSync(ProviderRuntimeEvent);

describe("ProviderRuntimeEvent", () => {
  it("accepts fork-provided driver kinds as branded slugs", () => {
    const parsed = decodeRuntimeEvent({
      type: "session.started",
      eventId: "event-ollama-session",
      provider: "ollama",
      providerInstanceId: "ollama_local",
      createdAt: "2026-02-28T00:00:00.000Z",
      threadId: "thread-1",
      payload: {
        message: "started",
      },
    });

    expect(parsed.provider).toBe("ollama");
    expect(parsed.providerInstanceId).toBe("ollama_local");
  });

  it("decodes turn.plan.updated for plan rendering", () => {
    const parsed = decodeRuntimeEvent({
      type: "turn.plan.updated",
      eventId: "event-1",
      provider: "claudeAgent",
      sessionId: "runtime-session-1",
      createdAt: "2026-02-28T00:00:00.000Z",
      threadId: "thread-1",
      turnId: "turn-1",
      payload: {
        explanation: "Implement schema updates",
        plan: [
          { step: "Define event union", status: "completed" },
          { step: "Wire adapter mapping", status: "inProgress" },
        ],
      },
    });

    expect(parsed.type).toBe("turn.plan.updated");
    if (parsed.type !== "turn.plan.updated") {
      throw new Error("expected turn.plan.updated");
    }
    expect(parsed.payload.plan).toHaveLength(2);
    expect(parsed.payload.plan[1]?.status).toBe("inProgress");
  });

  it("decodes proposed-plan completion events", () => {
    const parsed = decodeRuntimeEvent({
      type: "turn.proposed.completed",
      eventId: "event-proposed-plan-1",
      provider: "codex",
      createdAt: "2026-02-28T00:00:00.000Z",
      threadId: "thread-1",
      turnId: "turn-1",
      payload: {
        planMarkdown: "# Ship it",
      },
    });

    expect(parsed.type).toBe("turn.proposed.completed");
    if (parsed.type !== "turn.proposed.completed") {
      throw new Error("expected turn.proposed.completed");
    }
    expect(parsed.payload.planMarkdown).toBe("# Ship it");
  });

  it("decodes user-input.requested with structured questions", () => {
    const parsed = decodeRuntimeEvent({
      type: "user-input.requested",
      eventId: "event-2",
      provider: "claudeAgent",
      sessionId: "runtime-session-2",
      createdAt: "2026-02-28T00:00:01.000Z",
      threadId: "thread-2",
      requestId: "request-1",
      payload: {
        questions: [
          {
            id: "sandbox_mode",
            header: "Sandbox",
            question: "Which mode should be used?",
            options: [
              {
                label: "workspace-write",
                description: "Allow edits in workspace only",
              },
              {
                label: "danger-full-access",
                description: "Allow unrestricted access",
              },
            ],
          },
        ],
      },
    });

    expect(parsed.type).toBe("user-input.requested");
    if (parsed.type !== "user-input.requested") {
      throw new Error("expected user-input.requested");
    }
    expect(parsed.payload.questions[0]?.id).toBe("sandbox_mode");
    expect(parsed.payload.questions[0]?.options).toHaveLength(2);
  });

  it("decodes user-input.resolved with answer map", () => {
    const parsed = decodeRuntimeEvent({
      type: "user-input.resolved",
      eventId: "event-3",
      provider: "claudeAgent",
      sessionId: "runtime-session-2",
      createdAt: "2026-02-28T00:00:02.000Z",
      threadId: "thread-2",
      requestId: "request-1",
      payload: {
        answers: {
          sandbox_mode: "workspace-write",
        },
      },
    });

    expect(parsed.type).toBe("user-input.resolved");
    if (parsed.type !== "user-input.resolved") {
      throw new Error("expected user-input.resolved");
    }
    expect(parsed.payload.answers.sandbox_mode).toBe("workspace-write");
  });

  it("rejects legacy message.delta type", () => {
    expect(() =>
      decodeRuntimeEvent({
        type: "message.delta",
        eventId: "event-4",
        provider: "codex",
        sessionId: "runtime-session-3",
        createdAt: "2026-02-28T00:00:03.000Z",
        payload: { delta: "legacy" },
      }),
    ).toThrow();
  });

  it("rejects empty branded canonical ids", () => {
    expect(() =>
      decodeRuntimeEvent({
        type: "runtime.error",
        eventId: "event-5",
        provider: "codex",
        sessionId: "runtime-session-3",
        createdAt: "2026-02-28T00:00:03.000Z",
        threadId: "   ",
        payload: { message: "boom" },
      }),
    ).toThrow();
  });

  it("decodes task.started with subagent linkage fields", () => {
    const parsed = decodeRuntimeEvent({
      type: "task.started",
      eventId: "event-task-started-1",
      provider: "claudeAgent",
      createdAt: "2026-02-28T00:00:05.000Z",
      threadId: "thread-1",
      payload: {
        taskId: "task-1",
        description: "Explore the codebase",
        taskType: "subagent",
        toolUseId: "toolu_spawn_1",
        subagentType: "Explore",
        prompt: "Find all usages of applySubagentActivity",
        skipTranscript: true,
      },
    });

    expect(parsed.type).toBe("task.started");
    if (parsed.type !== "task.started") {
      throw new Error("expected task.started");
    }
    expect(parsed.payload.toolUseId).toBe("toolu_spawn_1");
    expect(parsed.payload.subagentType).toBe("Explore");
    expect(parsed.payload.skipTranscript).toBe(true);
  });

  it("decodes task.started without subagent linkage fields (back-compat)", () => {
    const parsed = decodeRuntimeEvent({
      type: "task.started",
      eventId: "event-task-started-2",
      provider: "claudeAgent",
      createdAt: "2026-02-28T00:00:05.000Z",
      threadId: "thread-1",
      payload: {
        taskId: "task-1",
      },
    });

    expect(parsed.type).toBe("task.started");
    if (parsed.type !== "task.started") {
      throw new Error("expected task.started");
    }
    expect(parsed.payload.toolUseId).toBeUndefined();
  });

  it("decodes task.progress with subagent linkage fields", () => {
    const parsed = decodeRuntimeEvent({
      type: "task.progress",
      eventId: "event-task-progress-1",
      provider: "claudeAgent",
      createdAt: "2026-02-28T00:00:06.000Z",
      threadId: "thread-1",
      payload: {
        taskId: "task-1",
        description: "Reading files",
        toolUseId: "toolu_spawn_1",
        subagentType: "Explore",
      },
    });

    expect(parsed.type).toBe("task.progress");
    if (parsed.type !== "task.progress") {
      throw new Error("expected task.progress");
    }
    expect(parsed.payload.toolUseId).toBe("toolu_spawn_1");
    expect(parsed.payload.subagentType).toBe("Explore");
  });

  it("decodes task.updated with a partial state patch", () => {
    const parsed = decodeRuntimeEvent({
      type: "task.updated",
      eventId: "event-task-updated-1",
      provider: "claudeAgent",
      createdAt: "2026-02-28T00:00:07.000Z",
      threadId: "thread-1",
      payload: {
        taskId: "task-1",
        patch: {
          status: "running",
          isBackgrounded: true,
        },
      },
    });

    expect(parsed.type).toBe("task.updated");
    if (parsed.type !== "task.updated") {
      throw new Error("expected task.updated");
    }
    expect(parsed.payload.patch.status).toBe("running");
    expect(parsed.payload.patch.isBackgrounded).toBe(true);
    expect(parsed.payload.patch.description).toBeUndefined();
  });

  it("rejects task.updated with an unknown patch status", () => {
    expect(() =>
      decodeRuntimeEvent({
        type: "task.updated",
        eventId: "event-task-updated-2",
        provider: "claudeAgent",
        createdAt: "2026-02-28T00:00:07.000Z",
        threadId: "thread-1",
        payload: {
          taskId: "task-1",
          patch: { status: "exploded" },
        },
      }),
    ).toThrow();
  });

  it("decodes task.completed with toolUseId and outputFile", () => {
    const parsed = decodeRuntimeEvent({
      type: "task.completed",
      eventId: "event-task-completed-1",
      provider: "claudeAgent",
      createdAt: "2026-02-28T00:00:08.000Z",
      threadId: "thread-1",
      payload: {
        taskId: "task-1",
        status: "completed",
        summary: "Found 3 usages",
        toolUseId: "toolu_spawn_1",
        outputFile: "/tmp/agent-output.md",
      },
    });

    expect(parsed.type).toBe("task.completed");
    if (parsed.type !== "task.completed") {
      throw new Error("expected task.completed");
    }
    expect(parsed.payload.toolUseId).toBe("toolu_spawn_1");
    expect(parsed.payload.outputFile).toBe("/tmp/agent-output.md");
  });

  it("decodes tool.progress with subagent parent linkage", () => {
    const parsed = decodeRuntimeEvent({
      type: "tool.progress",
      eventId: "event-tool-progress-1",
      provider: "claudeAgent",
      createdAt: "2026-02-28T00:00:09.000Z",
      threadId: "thread-1",
      payload: {
        toolUseId: "toolu_child_1",
        toolName: "Read",
        elapsedSeconds: 1.5,
        parentToolUseId: "toolu_spawn_1",
        taskId: "task-1",
      },
    });

    expect(parsed.type).toBe("tool.progress");
    if (parsed.type !== "tool.progress") {
      throw new Error("expected tool.progress");
    }
    expect(parsed.payload.parentToolUseId).toBe("toolu_spawn_1");
    expect(parsed.payload.taskId).toBe("task-1");
  });

  it("decodes item lifecycle events with subagent attribution", () => {
    const parsed = decodeRuntimeEvent({
      type: "item.started",
      eventId: "event-item-started-1",
      provider: "claudeAgent",
      createdAt: "2026-02-28T00:00:10.000Z",
      threadId: "thread-1",
      itemId: "item-1",
      payload: {
        itemType: "command_execution",
        status: "inProgress",
        parentToolUseId: "toolu_spawn_1",
        subagentType: "Explore",
      },
    });

    expect(parsed.type).toBe("item.started");
    if (parsed.type !== "item.started") {
      throw new Error("expected item.started");
    }
    expect(parsed.payload.parentToolUseId).toBe("toolu_spawn_1");
    expect(parsed.payload.subagentType).toBe("Explore");
  });

  it("decodes normalized thread token usage snapshots", () => {
    const parsed = decodeRuntimeEvent({
      type: "thread.token-usage.updated",
      eventId: "event-token-usage-1",
      provider: "claudeAgent",
      createdAt: "2026-02-28T00:00:04.000Z",
      threadId: "thread-1",
      payload: {
        usage: {
          usedTokens: 31251,
          maxTokens: 200000,
          toolUses: 25,
          durationMs: 43567,
        },
      },
    });

    expect(parsed.type).toBe("thread.token-usage.updated");
    if (parsed.type !== "thread.token-usage.updated") {
      throw new Error("expected thread.token-usage.updated");
    }
    expect(parsed.payload.usage.maxTokens).toBe(200000);
    expect(parsed.payload.usage.usedTokens).toBe(31251);
  });
});
