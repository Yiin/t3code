import { assert, it } from "@effect/vitest";

import { EnvironmentScopeRequiredError, ProjectId, ThreadId } from "@t3tools/contracts";

import {
  findEpicProject,
  formatEpicOutput,
  formatEpicRunCompact,
  isEpicRunTerminal,
  shouldClearEpicRuntimeState,
} from "./epic.ts";

const run = {
  runId: "run-1",
  epicId: "t3code-vst",
  projectId: ProjectId.make("project-1"),
  cwd: "/repo",
  prompt: "Cook it",
  modelSelection: { instanceId: "codex", model: "gpt-5" },
  runtimeMode: "full-access",
  status: "running",
  maxIterations: 10,
  iterationsCompleted: 2,
  currentThreadId: ThreadId.make("thread-1"),
  currentTurnStartedAt: "2026-07-29T00:00:00.000Z",
  consecutiveFailures: 0,
  lastError: null,
  createdAt: "2026-07-29T00:00:00.000Z",
  updatedAt: "2026-07-29T00:00:00.000Z",
  threadRefs: [],
  recentIterations: [],
} as const;

it("resolves only an active project whose normalized workspace root matches", () => {
  const snapshot = {
    projects: [
      { id: ProjectId.make("deleted"), workspaceRoot: "/repo", deletedAt: "2026-01-01" },
      { id: ProjectId.make("project-1"), workspaceRoot: "/repo", deletedAt: null },
    ],
  } as never;

  assert.strictEqual(findEpicProject(snapshot, "/repo")?.id, "project-1");
  assert.isUndefined(findEpicProject(snapshot, "/repo/child"));
});

it("keeps declared probe failures without clearing runtime state", () => {
  const failure = new EnvironmentScopeRequiredError({
    code: "insufficient_scope",
    requiredScope: "orchestration:read",
    traceId: "trace-1",
  });
  assert.isFalse(shouldClearEpicRuntimeState(failure));
  assert.isTrue(shouldClearEpicRuntimeState(new Error("connection refused")));
});

it("formats compact output deterministically", () => {
  assert.strictEqual(
    formatEpicRunCompact(run as never),
    "run-1\trunning\tt3code-vst\t2/10\tthread-1\t-",
  );
});

it("formats lists as counted TOON and JSON as pure JSON", () => {
  assert.strictEqual(
    formatEpicOutput([], false),
    "runs[0]{runId,status,epicId,iterations,currentThreadId,lastError}:",
  );
  assert.strictEqual(formatEpicOutput([], true), "[]");
  assert.match(formatEpicOutput([run], false), /^runs\[1\]\{.*\}:\n  run-1\t/);
});

it("treats done, failed, and cancelled as terminal", () => {
  assert.isFalse(isEpicRunTerminal({ status: "running" }));
  assert.isFalse(isEpicRunTerminal({ status: "paused" }));
  assert.isTrue(isEpicRunTerminal({ status: "done" }));
  assert.isTrue(isEpicRunTerminal({ status: "failed" }));
  assert.isTrue(isEpicRunTerminal({ status: "cancelled" }));
});
