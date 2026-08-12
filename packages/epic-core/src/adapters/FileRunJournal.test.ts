import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { PersistedEpicRun, PersistedEpicRunIteration } from "../ports/RunJournal.ts";
import { make } from "./FileRunJournal.ts";

const run = Schema.decodeUnknownSync(PersistedEpicRun)({
  runId: "run-journal-test",
  epicId: "epic-1",
  projectId: "project-1",
  cwd: "/repo",
  prompt: "Cook one child.",
  orientationFile: null,
  modelSelection: { instanceId: "codex", model: "gpt-5" },
  runtimeMode: "full-access",
  originThreadId: null,
  status: "running",
  maxIterations: 10,
  iterationsDispatched: 1,
  iterationsCompleted: 0,
  currentThreadId: null,
  currentTurnStartedAt: null,
  consecutiveFailures: 0,
  noCommitStreak: 0,
  infraStreak: 0,
  lastError: null,
  createdAt: "2026-08-07T10:00:00.000Z",
  updatedAt: "2026-08-07T10:00:00.000Z",
});

const runningIteration = Schema.decodeUnknownSync(PersistedEpicRunIteration)({
  runId: run.runId,
  iterationIndex: 0,
  threadId: "epic-run-run-journal-test-0",
  issueId: "epic-1.1",
  turnStatus: "running",
  summary: null,
  why: null,
  failureReason: null,
  startedAt: "2026-08-07T10:01:00.000Z",
  finishedAt: null,
});

describe("FileRunJournal", () => {
  it.effect("round-trips the run and its iterations", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const runDirectory = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "epic-file-journal-test-",
        });
        const journal = yield* make({ runDirectory });

        yield* journal.createRun(run);
        yield* journal.appendIteration(runningIteration);
        yield* journal.updateIteration({
          runId: run.runId,
          iterationIndex: 0,
          turnStatus: "completed",
          summary: "Built the shared journal.",
          why: "Both adapters need durable state.",
          failureReason: null,
          finishedAt: "2026-08-07T10:02:00.000Z",
        });
        const savedRun: PersistedEpicRun = {
          ...run,
          iterationsCompleted: 1,
          status: "done",
          updatedAt: "2026-08-07T10:02:00.000Z",
        };
        yield* journal.saveRun(savedRun);

        const reloaded = yield* journal.getRun(run.runId);
        assert.deepEqual(Option.getOrThrow(reloaded), savedRun);

        const iterations = yield* journal.listIterations(run.runId);
        assert.deepEqual(iterations, [
          {
            ...runningIteration,
            turnStatus: "completed",
            summary: "Built the shared journal.",
            why: "Both adapters need durable state.",
            finishedAt: "2026-08-07T10:02:00.000Z",
          },
        ]);
        assert.deepEqual(
          Option.getOrThrow(yield* journal.getLatestIteration(run.runId)),
          iterations[0],
        );

        for (const fileName of ["loop.log", "mailbox.jsonl", "summary.md"]) {
          assert.isTrue(yield* fileSystem.exists(path.join(runDirectory, fileName)));
          assert.equal(yield* fileSystem.readFileString(path.join(runDirectory, fileName)), "");
        }
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps a running iteration visible after a simulated crash", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const runDirectory = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "epic-file-journal-crash-test-",
        });

        const firstProcess = yield* make({ runDirectory });
        yield* firstProcess.createRun(run);
        yield* firstProcess.appendIteration(runningIteration);

        // A new adapter instance models restart without an iteration update.
        const restartedProcess = yield* make({ runDirectory });
        const latest = yield* restartedProcess.getLatestIteration(run.runId);

        assert.isTrue(Option.isSome(latest));
        assert.equal(Option.getOrThrow(latest).turnStatus, "running");
        assert.deepEqual(yield* restartedProcess.listIterations(run.runId), [runningIteration]);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reopens an iteration in place and counts the resume", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const runDirectory = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "epic-file-journal-resume-test-",
        });
        const journal = yield* make({ runDirectory });

        yield* journal.createRun(run);
        yield* journal.appendIteration(runningIteration);
        yield* journal.updateIteration({
          runId: run.runId,
          iterationIndex: 0,
          turnStatus: "abandoned",
          summary: "abandoned by the restart",
          why: "the process died",
          failureReason: "server-restart",
          finishedAt: "2026-08-07T10:02:00.000Z",
        });

        yield* journal.markIterationResumed({
          runId: run.runId,
          iterationIndex: 0,
          resumedAt: "2026-08-07T10:03:00.000Z",
        });

        // The same record, continued: index, thread and start time all hold.
        assert.deepEqual(yield* journal.listIterations(run.runId), [
          { ...runningIteration, resumeCount: 1, lastResumedAt: "2026-08-07T10:03:00.000Z" },
        ]);

        // A settle after the resume leaves both resume fields alone.
        yield* journal.updateIteration({
          runId: run.runId,
          iterationIndex: 0,
          turnStatus: "completed",
          summary: "finished after the restart",
          why: null,
          failureReason: null,
          finishedAt: "2026-08-07T10:04:00.000Z",
        });
        const settled = Option.getOrThrow(yield* journal.getLatestIteration(run.runId));
        assert.equal(settled.resumeCount, 1);
        assert.equal(settled.lastResumedAt, "2026-08-07T10:03:00.000Z");

        // A missing index is a no-op, matching updateIteration.
        yield* journal.markIterationResumed({
          runId: run.runId,
          iterationIndex: 7,
          resumedAt: "2026-08-07T10:05:00.000Z",
        });
        assert.equal((yield* journal.listIterations(run.runId)).length, 1);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("creates a run exclusively when writers race", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const runDirectory = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "epic-file-journal-race-test-",
        });
        const path = yield* Path.Path;
        for (const fileName of ["loop.log", "mailbox.jsonl", "summary.md"]) {
          yield* fileSystem.writeFileString(path.join(runDirectory, fileName), "existing output");
        }
        const first = yield* make({ runDirectory });
        const second = yield* make({ runDirectory });

        const exits = yield* Effect.all(
          [Effect.exit(first.createRun(run)), Effect.exit(second.createRun(run))],
          { concurrency: "unbounded" },
        );

        assert.equal(exits.filter(Exit.isSuccess).length, 1);
        assert.equal(exits.filter(Exit.isFailure).length, 1);
        assert.isTrue(Option.isSome(yield* first.getRun(run.runId)));
        for (const fileName of ["loop.log", "mailbox.jsonl", "summary.md"]) {
          assert.equal(
            yield* fileSystem.readFileString(path.join(runDirectory, fileName)),
            "existing output",
          );
        }
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("appends each iteration index exclusively", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const runDirectory = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "epic-file-journal-iteration-race-test-",
        });
        const journal = yield* make({ runDirectory });
        yield* journal.createRun(run);

        const exits = yield* Effect.all(
          [
            Effect.exit(journal.appendIteration(runningIteration)),
            Effect.exit(journal.appendIteration(runningIteration)),
          ],
          { concurrency: "unbounded" },
        );

        assert.equal(exits.filter(Exit.isSuccess).length, 1);
        assert.equal(exits.filter(Exit.isFailure).length, 1);
        assert.deepEqual(yield* journal.listIterations(run.runId), [runningIteration]);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});
