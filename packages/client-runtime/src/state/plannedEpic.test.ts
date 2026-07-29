import { describe, expect, it } from "vite-plus/test";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";

import {
  latestFinalizedPlannedEpicAtom,
  resolveLatestFinalizedPlannedEpic,
} from "./plannedEpic.ts";
import type { EnvironmentThread } from "./models.ts";

const thread = {
  environmentId: "env-a",
  id: "thread-a",
  projectId: "project-a",
  messages: [
    {
      id: "message-a",
      role: "assistant",
      text: "done",
      turnId: "turn-a",
      streaming: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      correlation: {
        threadId: "thread-a",
        epicId: "duplicate-id",
        projectId: "project-a",
        cwd: "/workspace/a",
      },
    },
  ],
} as unknown as EnvironmentThread;

describe("resolveLatestFinalizedPlannedEpic", () => {
  it("adds environment scope and preserves exact project/workspace identity", () => {
    expect(resolveLatestFinalizedPlannedEpic(thread)).toEqual({
      environmentId: "env-a",
      threadId: "thread-a",
      epicId: "duplicate-id",
      projectId: "project-a",
      cwd: "/workspace/a",
    });
  });

  it("does not resolve a streaming correlation", () => {
    const streaming = {
      ...thread,
      messages: [{ ...thread.messages[0]!, streaming: true }],
    };
    expect(resolveLatestFinalizedPlannedEpic(streaming)).toBeNull();
  });

  it("selects the latest finalized correlation", () => {
    const latest = {
      ...thread,
      messages: [
        ...thread.messages,
        {
          ...thread.messages[0]!,
          id: "message-b",
          correlation: {
            threadId: "thread-a",
            epicId: "newer",
            projectId: "project-a",
            cwd: "/workspace/newer",
          },
        },
      ],
    };
    expect(resolveLatestFinalizedPlannedEpic(latest as unknown as EnvironmentThread)?.epicId).toBe(
      "newer",
    );
  });

  it("keeps duplicate epic ids distinct by environment, project, and cwd", () => {
    const other = {
      ...thread,
      environmentId: "env-b",
      projectId: "project-b",
      id: "thread-b",
      messages: [
        {
          ...thread.messages[0]!,
          correlation: {
            threadId: "thread-b",
            epicId: "duplicate-id",
            projectId: "project-b",
            cwd: "/workspace/b",
          },
        },
      ],
    } as unknown as EnvironmentThread;
    expect(resolveLatestFinalizedPlannedEpic(other)).toEqual({
      environmentId: "env-b",
      threadId: "thread-b",
      epicId: "duplicate-id",
      projectId: "project-b",
      cwd: "/workspace/b",
    });
  });

  it("rejects missing or mismatched correlation identity", () => {
    expect(resolveLatestFinalizedPlannedEpic({ ...thread, messages: [] })).toBeNull();
    const mismatch = {
      ...thread,
      messages: [
        {
          ...thread.messages[0]!,
          correlation: { ...thread.messages[0]!.correlation!, projectId: "project-other" },
        },
      ],
    };
    expect(resolveLatestFinalizedPlannedEpic(mismatch as unknown as EnvironmentThread)).toBeNull();
  });

  it("exposes the resolver through an atom", () => {
    const registry = AtomRegistry.make();
    const result = registry.get(latestFinalizedPlannedEpicAtom(Atom.make(thread)));
    expect(result?.epicId).toBe("duplicate-id");
    expect(result?.environmentId).toBe("env-a");
  });
});
