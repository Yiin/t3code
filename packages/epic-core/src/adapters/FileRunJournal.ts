/** A schema-validated, atomic file journal for terminal epic runs. */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  PersistedEpicRun,
  PersistedEpicRunIteration,
  RunJournal,
  RunJournalError,
  type RunJournalShape,
  type UpdatePersistedEpicRunIteration,
} from "../ports/RunJournal.ts";

export interface FileRunJournalOptions {
  /** The exact run directory. Files are written directly below this path. */
  readonly runDirectory: string;
}

const iterationFilePattern = /^iter-(\d+)\.json$/;

const errorDetail = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);
const isRunJournalError = Schema.is(RunJournalError);

const journalError =
  (operation: string) =>
  (cause: unknown): RunJournalError =>
    isRunJournalError(cause)
      ? cause
      : new RunJournalError({ operation, detail: errorDetail(cause), cause });

const decodeRunJson = Schema.decodeUnknownEffect(Schema.fromJsonString(PersistedEpicRun));
const encodeRunJson = Schema.encodeEffect(Schema.fromJsonString(PersistedEpicRun));
const decodeIterationJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(PersistedEpicRunIteration),
);
const encodeIterationJson = Schema.encodeEffect(Schema.fromJsonString(PersistedEpicRunIteration));

export const make = (options: FileRunJournalOptions) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const runPath = path.join(options.runDirectory, "run.json");
    const iterationPath = (iterationIndex: number): string =>
      path.join(options.runDirectory, `iter-${iterationIndex}.json`);

    const syncRunDirectory = Effect.fn("FileRunJournal.syncRunDirectory")(function* () {
      yield* Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* fileSystem.open(options.runDirectory, { flag: "r" });
          yield* directory.sync;
        }),
      );
    });

    const writeAtomically = Effect.fn("FileRunJournal.writeAtomically")(function* (
      filePath: string,
      contents: string,
    ) {
      yield* fileSystem.makeDirectory(options.runDirectory, { recursive: true });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const temporaryDirectory = yield* fileSystem.makeTempDirectoryScoped({
            directory: options.runDirectory,
            prefix: `${path.basename(filePath)}.`,
          });
          const temporaryPath = path.join(temporaryDirectory, "contents.tmp");
          const file = yield* fileSystem.open(temporaryPath, { flag: "wx" });
          const bytes = new TextEncoder().encode(contents);
          if (bytes.byteLength > 0) yield* file.writeAll(bytes);
          yield* file.sync;
          yield* fileSystem.rename(temporaryPath, filePath);
          yield* syncRunDirectory();
        }),
      );
    });

    const createAtomically = Effect.fn("FileRunJournal.createAtomically")(function* (
      filePath: string,
      contents: string,
    ) {
      yield* fileSystem.makeDirectory(options.runDirectory, { recursive: true });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const temporaryDirectory = yield* fileSystem.makeTempDirectoryScoped({
            directory: options.runDirectory,
            prefix: `${path.basename(filePath)}.`,
          });
          const temporaryPath = path.join(temporaryDirectory, "contents.tmp");
          const file = yield* fileSystem.open(temporaryPath, { flag: "wx" });
          const bytes = new TextEncoder().encode(contents);
          if (bytes.byteLength > 0) yield* file.writeAll(bytes);
          yield* file.sync;
          // A hard link fails if the target exists, so creation is atomic and exclusive.
          yield* fileSystem.link(temporaryPath, filePath);
          yield* syncRunDirectory();
        }),
      );
    });

    const ensureArtifact = Effect.fn("FileRunJournal.ensureArtifact")(function* (fileName: string) {
      const filePath = path.join(options.runDirectory, fileName);
      if (yield* fileSystem.exists(filePath)) return;
      yield* createAtomically(filePath, "").pipe(
        Effect.catch((cause) =>
          fileSystem
            .exists(filePath)
            .pipe(Effect.flatMap((exists) => (exists ? Effect.void : Effect.fail(cause)))),
        ),
      );
    });

    const ensureArtifacts = Effect.fn("FileRunJournal.ensureArtifacts")(function* () {
      yield* ensureArtifact("loop.log");
      yield* ensureArtifact("mailbox.jsonl");
      yield* ensureArtifact("summary.md");
    });

    const readRun = Effect.fn("FileRunJournal.readRun")(function* () {
      if (!(yield* fileSystem.exists(runPath))) return Option.none<PersistedEpicRun>();
      const contents = yield* fileSystem.readFileString(runPath);
      return Option.some(yield* decodeRunJson(contents));
    });

    const createRun: RunJournalShape["createRun"] = (run) =>
      Effect.gen(function* () {
        if (yield* fileSystem.exists(runPath)) {
          return yield* new RunJournalError({
            operation: "createRun",
            detail: `Run ${run.runId} already exists in ${options.runDirectory}`,
          });
        }
        const contents = yield* encodeRunJson(run);
        yield* createAtomically(runPath, contents);
        yield* ensureArtifacts();
      }).pipe(Effect.mapError(journalError("createRun")));

    const saveRun: RunJournalShape["saveRun"] = (run) =>
      Effect.gen(function* () {
        const current = yield* readRun();
        if (Option.isNone(current)) {
          return yield* new RunJournalError({
            operation: "saveRun",
            detail: `Run ${run.runId} does not exist in ${options.runDirectory}`,
          });
        }
        if (current.value.runId !== run.runId) {
          return yield* new RunJournalError({
            operation: "saveRun",
            detail: `Run directory belongs to ${current.value.runId}, not ${run.runId}`,
          });
        }
        yield* writeAtomically(runPath, yield* encodeRunJson(run));
      }).pipe(Effect.mapError(journalError("saveRun")));

    const getRun: RunJournalShape["getRun"] = (runId) =>
      readRun().pipe(
        Effect.map(Option.filter((run) => run.runId === runId)),
        Effect.mapError(journalError("getRun")),
      );

    const appendIteration: RunJournalShape["appendIteration"] = (iteration) =>
      Effect.gen(function* () {
        const run = yield* readRun();
        if (Option.isNone(run) || run.value.runId !== iteration.runId) {
          return yield* new RunJournalError({
            operation: "appendIteration",
            detail: `Run ${iteration.runId} does not own ${options.runDirectory}`,
          });
        }
        const filePath = iterationPath(iteration.iterationIndex);
        if (yield* fileSystem.exists(filePath)) {
          return yield* new RunJournalError({
            operation: "appendIteration",
            detail: `Iteration ${iteration.iterationIndex} already exists`,
          });
        }
        yield* createAtomically(filePath, yield* encodeIterationJson(iteration));
      }).pipe(Effect.mapError(journalError("appendIteration")));

    const readIteration = Effect.fn("FileRunJournal.readIteration")(function* (filePath: string) {
      return yield* decodeIterationJson(yield* fileSystem.readFileString(filePath));
    });

    const updateIteration: RunJournalShape["updateIteration"] = (
      input: UpdatePersistedEpicRunIteration,
    ) =>
      Effect.gen(function* () {
        const filePath = iterationPath(input.iterationIndex);
        if (!(yield* fileSystem.exists(filePath))) return;
        const current = yield* readIteration(filePath);
        if (current.runId !== input.runId) {
          return yield* new RunJournalError({
            operation: "updateIteration",
            detail: `Iteration ${input.iterationIndex} belongs to ${current.runId}, not ${input.runId}`,
          });
        }
        const updated: PersistedEpicRunIteration = {
          ...current,
          turnStatus: input.turnStatus,
          summary: input.summary,
          why: input.why,
          failureReason: input.failureReason,
          headBefore: input.headBefore,
          headAfter: input.headAfter,
          finishedAt: input.finishedAt,
        };
        yield* writeAtomically(filePath, yield* encodeIterationJson(updated));
      }).pipe(Effect.mapError(journalError("updateIteration")));

    const listIterations: RunJournalShape["listIterations"] = (runId) =>
      Effect.gen(function* () {
        if (!(yield* fileSystem.exists(options.runDirectory))) return [];
        const files = yield* fileSystem.readDirectory(options.runDirectory);
        const indexedFiles = files.flatMap((fileName) => {
          const match = iterationFilePattern.exec(fileName);
          const encodedIndex = match?.[1];
          return encodedIndex === undefined
            ? []
            : [{ fileName, iterationIndex: Number.parseInt(encodedIndex, 10) }];
        });
        indexedFiles.sort((left, right) => left.iterationIndex - right.iterationIndex);

        const iterations: Array<PersistedEpicRunIteration> = [];
        for (const entry of indexedFiles) {
          const iteration = yield* readIteration(path.join(options.runDirectory, entry.fileName));
          if (iteration.runId === runId) iterations.push(iteration);
        }
        return iterations;
      }).pipe(Effect.mapError(journalError("listIterations")));

    const getLatestIteration: RunJournalShape["getLatestIteration"] = (runId) =>
      listIterations(runId).pipe(
        Effect.map((iterations) => Option.fromUndefinedOr(iterations[iterations.length - 1])),
      );

    if (yield* fileSystem.exists(runPath)) yield* ensureArtifacts();

    return RunJournal.of({
      createRun,
      saveRun,
      getRun,
      appendIteration,
      updateIteration,
      listIterations,
      getLatestIteration,
    });
  });

export const layer = (options: FileRunJournalOptions) => Layer.effect(RunJournal, make(options));
