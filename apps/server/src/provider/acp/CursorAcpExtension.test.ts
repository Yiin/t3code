import { describe, expect, it } from "vite-plus/test";

import {
  CursorListAvailableModelsResponse,
  extractAskQuestions,
  extractPlanMarkdown,
  extractTodosAsPlan,
  parseCursorTaskNotification,
} from "./CursorAcpExtension.ts";

describe("CursorAcpExtension", () => {
  it("extracts ask-question prompts from the real Cursor ACP payload shape", () => {
    const questions = extractAskQuestions({
      toolCallId: "ask-1",
      title: "Need input",
      questions: [
        {
          id: "language",
          prompt: "Which language should I use?",
          options: [
            { id: "ts", label: "TypeScript" },
            { id: "rs", label: "Rust" },
          ],
          allowMultiple: false,
        },
      ],
    });

    expect(questions).toEqual([
      {
        id: "language",
        header: "Question",
        question: "Which language should I use?",
        multiSelect: false,
        options: [
          { label: "TypeScript", description: "TypeScript" },
          { label: "Rust", description: "Rust" },
        ],
      },
    ]);
  });

  it("defaults ask-question multi-select to false when Cursor omits allowMultiple", () => {
    const questions = extractAskQuestions({
      toolCallId: "ask-2",
      questions: [
        {
          id: "mode",
          prompt: "Which mode should I use?",
          options: [
            { id: "agent", label: "Agent" },
            { id: "plan", label: "Plan" },
          ],
        },
      ],
    });

    expect(questions).toEqual([
      {
        id: "mode",
        header: "Question",
        question: "Which mode should I use?",
        multiSelect: false,
        options: [
          { label: "Agent", description: "Agent" },
          { label: "Plan", description: "Plan" },
        ],
      },
    ]);
  });

  it("extracts plan markdown from the real Cursor create-plan payload shape", () => {
    const planMarkdown = extractPlanMarkdown({
      toolCallId: "plan-1",
      name: "Refactor parser",
      overview: "Tighten ACP parsing",
      plan: "# Plan\n\n1. Add schemas\n2. Remove casts",
      todos: [
        { id: "t1", content: "Add schemas", status: "in_progress" },
        { id: "t2", content: "Remove casts", status: "pending" },
      ],
      isProject: false,
    });

    expect(planMarkdown).toBe("# Plan\n\n1. Add schemas\n2. Remove casts");
  });

  it("projects todo updates into a plan shape and drops invalid entries", () => {
    expect(
      extractTodosAsPlan({
        toolCallId: "todos-1",
        todos: [
          { id: "1", content: "Inspect state", status: "completed" },
          { id: "2", content: "  Apply fix  ", status: "in_progress" },
          { id: "3", title: "Fallback title", status: "pending" },
          { id: "4", content: "Unknown status", status: "weird_status" },
          { id: "5", content: "   " },
        ],
        merge: true,
      }),
    ).toEqual({
      plan: [
        { step: "Inspect state", status: "completed" },
        { step: "Apply fix", status: "inProgress" },
        { step: "Fallback title", status: "pending" },
        { step: "Unknown status", status: "pending" },
      ],
    });
  });

  it("decodes Cursor list_available_models responses with per-model config options", () => {
    const decoded = CursorListAvailableModelsResponse.make({
      models: [
        {
          value: "gpt-5.4",
          name: "GPT-5.4",
          configOptions: [
            {
              id: "reasoning",
              name: "Reasoning",
              category: "thought_level",
              type: "select",
              currentValue: "medium",
              options: [
                { value: "low", name: "Low" },
                { value: "medium", name: "Medium" },
              ],
            },
          ],
        },
      ],
    });

    expect(decoded.models[0]?.configOptions?.[0]?.id).toBe("reasoning");
  });

  it("parses a documented cursor/task start notification as non-terminal", () => {
    expect(
      parseCursorTaskNotification({
        toolCallId: "task-tool-1",
        description: "Explore the auth flow",
        prompt: "Read the auth module and report entry points.",
        subagentType: "explore",
        model: "gpt-5.4",
      }),
    ).toEqual({
      toolCallId: "task-tool-1",
      subagentType: "explore",
      description: "Explore the auth flow",
      prompt: "Read the auth module and report entry points.",
      model: "gpt-5.4",
      terminal: false,
      status: "completed",
    });
  });

  it("treats durationMs as the completion signal for cursor/task", () => {
    const signal = parseCursorTaskNotification({
      toolCallId: "task-tool-1",
      description: "Explore the auth flow",
      subagentType: "explore",
      agentId: "agent-1",
      durationMs: 42_000,
    });

    expect(signal).toMatchObject({
      toolCallId: "task-tool-1",
      agentId: "agent-1",
      durationMs: 42_000,
      terminal: true,
      status: "completed",
    });
  });

  it("maps custom subagent types and status-like fields on cursor/task", () => {
    expect(
      parseCursorTaskNotification({
        toolCallId: "task-tool-2",
        subagentType: { custom: "docs-writer" },
        status: "failed",
      }),
    ).toMatchObject({
      toolCallId: "task-tool-2",
      subagentType: "docs-writer",
      terminal: true,
      status: "failed",
    });

    expect(
      parseCursorTaskNotification({
        toolCallId: "task-tool-3",
        status: "cancelled",
      }),
    ).toMatchObject({ terminal: true, status: "stopped" });
  });

  it("returns undefined for malformed cursor/task payloads instead of throwing", () => {
    expect(parseCursorTaskNotification(null)).toBeUndefined();
    expect(parseCursorTaskNotification(undefined)).toBeUndefined();
    expect(parseCursorTaskNotification("cursor/task")).toBeUndefined();
    expect(parseCursorTaskNotification(42)).toBeUndefined();
    expect(parseCursorTaskNotification([])).toBeUndefined();
    expect(parseCursorTaskNotification({})).toBeUndefined();
    expect(parseCursorTaskNotification({ toolCallId: "" })).toBeUndefined();
    expect(parseCursorTaskNotification({ toolCallId: "   " })).toBeUndefined();
    expect(parseCursorTaskNotification({ toolCallId: 7 })).toBeUndefined();
  });

  it("ignores wrong-typed optional cursor/task fields while still parsing", () => {
    expect(
      parseCursorTaskNotification({
        toolCallId: "task-tool-4",
        subagentType: 42,
        durationMs: "fast",
        description: ["not", "a", "string"],
        unexpectedField: { nested: true },
      }),
    ).toEqual({
      toolCallId: "task-tool-4",
      terminal: false,
      status: "completed",
    });
  });
});
