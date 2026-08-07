// @effect-diagnostics nodeBuiltinImport:off globalDate:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { PersistedEpicRun } from "../ports/RunJournal.ts";
import { makeFileRunEvents } from "./FileRunEvents.ts";

const run = Schema.decodeUnknownSync(PersistedEpicRun)({
  runId: "run-1",
  epicId: "epic-1",
  projectId: "project-1",
  cwd: "/repo",
  prompt: "",
  orientationFile: null,
  modelSelection: { instanceId: "worker", model: "test" },
  runtimeMode: "full-access",
  originThreadId: null,
  status: "running",
  maxIterations: 2,
  iterationsDispatched: 1,
  iterationsCompleted: 0,
  currentThreadId: null,
  currentTurnStartedAt: null,
  consecutiveFailures: 0,
  noCommitStreak: 0,
  infraStreak: 0,
  lastError: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
});

it.effect("retains iteration summaries when the final run event arrives", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const directory = yield* Effect.acquireRelease(
        Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "file-run-events-"))),
        (path) => Effect.sync(() => NodeFS.rmSync(path, { recursive: true, force: true })),
      );
      const events = makeFileRunEvents({ runDirectory: directory });
      yield* events.publish({ type: "run-state-changed", run });
      yield* events.publish({
        type: "iteration-state-changed",
        iteration: {
          runId: run.runId,
          iterationIndex: 0,
          threadId: ThreadId.make("thread-1"),
          issueId: "child-1",
          turnStatus: "completed",
          summary: "built it",
          why: "needed",
          failureReason: null,
          startedAt: run.createdAt,
          finishedAt: run.updatedAt,
        },
      });
      yield* events.publish({
        type: "run-state-changed",
        run: { ...run, status: "done", iterationsCompleted: 1 },
      });
      const summary = NodeFS.readFileSync(NodePath.join(directory, "summary.md"), "utf8");
      assert.include(summary, "Status: done");
      assert.include(summary, "child-1: completed — built it");
    }),
  ),
);
