/** A schema-validated, atomic file journal for terminal epic runs. */
import { ThreadId, epicRunIterationThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import type { PoolRunJournalShape } from "../ParallelEpicLoop.ts";
import {
  PersistedEpicRun,
  PersistedEpicRunIteration,
  RunJournal,
  RunJournalError,
  type ProviderDegradationJournalShape,
  type RunJournalShape,
  type UpdatePersistedEpicRunIteration,
} from "../ports/RunJournal.ts";
import type { ProviderDegradationRecord } from "../providerDegradation.ts";

export interface FileRunJournalOptions {
  /** The exact run directory. Files are written directly below this path. */
  readonly runDirectory: string;
  /**
   * Where `provider-degradations.json` lives. Defaults to the run directory,
   * which scopes provider health to one run. Pool callers point it at the
   * workspace so a later run of the same epic reads what this one recorded.
   */
  readonly degradationsDirectory?: string;
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

/** One provider the pool loop parked, keyed by provider instance id. */
const ProviderDegradations = Schema.Record(
  Schema.String,
  Schema.Struct({
    failureReason: Schema.String,
    degradedAt: Schema.String,
    // Optional so a file written by an older build still decodes.
    resetsAt: Schema.optional(Schema.NullOr(Schema.String)),
  }),
);
const decodeProviderDegradations = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ProviderDegradations),
);
const encodeProviderDegradations = Schema.encodeEffect(Schema.fromJsonString(ProviderDegradations));

/**
 * Crash-safe replace of one file inside `directory`: write a temporary
 * sibling, fsync it, rename over the target, fsync the directory.
 */
const writeAtomically = (
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  directory: string,
  filePath: string,
  contents: string,
) =>
  Effect.gen(function* () {
    yield* fileSystem.makeDirectory(directory, { recursive: true });
    yield* Effect.scoped(
      Effect.gen(function* () {
        const temporaryDirectory = yield* fileSystem.makeTempDirectoryScoped({
          directory,
          prefix: `${path.basename(filePath)}.`,
        });
        const temporaryPath = path.join(temporaryDirectory, "contents.tmp");
        const file = yield* fileSystem.open(temporaryPath, { flag: "wx" });
        const bytes = new TextEncoder().encode(contents);
        if (bytes.byteLength > 0) yield* file.writeAll(bytes);
        yield* file.sync;
        yield* fileSystem.rename(temporaryPath, filePath);
        yield* Effect.scoped(
          Effect.gen(function* () {
            const opened = yield* fileSystem.open(directory, { flag: "r" });
            yield* opened.sync;
          }),
        );
      }),
    );
  });

/**
 * The run a directory holds, whatever its id.
 *
 * `getRun` filters by run id, which is right for every caller that already
 * knows which run it wants. A restart does not: the run id it must continue is
 * the one this directory was written with, and a process that lost its own
 * memory of it has only the directory to go on. So this reads the record and
 * lets the caller decide whether it is the one to pick back up.
 *
 * An absent record is `None`. An unreadable or undecodable one is an error:
 * silently treating a corrupt journal as "no run here" would create a second
 * run over the first one's worktrees.
 */
export const readRunRecord = (options: {
  readonly runDirectory: string;
}): Effect.Effect<
  Option.Option<PersistedEpicRun>,
  RunJournalError,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const runPath = path.join(options.runDirectory, "run.json");
    if (!(yield* fileSystem.exists(runPath))) return Option.none<PersistedEpicRun>();
    return Option.some(yield* decodeRunJson(yield* fileSystem.readFileString(runPath)));
  }).pipe(Effect.mapError(journalError("readRunRecord")));

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

    const writeRunAtomically = Effect.fn("FileRunJournal.writeAtomically")(function* (
      filePath: string,
      contents: string,
    ) {
      yield* writeAtomically(fileSystem, path, options.runDirectory, filePath, contents);
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
        yield* writeRunAtomically(runPath, yield* encodeRunJson(run));
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
        yield* writeRunAtomically(filePath, yield* encodeIterationJson(updated));
      }).pipe(Effect.mapError(journalError("updateIteration")));

    const markIterationResumed: RunJournalShape["markIterationResumed"] = (input) =>
      Effect.gen(function* () {
        const filePath = iterationPath(input.iterationIndex);
        if (!(yield* fileSystem.exists(filePath))) return;
        const current = yield* readIteration(filePath);
        if (current.runId !== input.runId) {
          return yield* new RunJournalError({
            operation: "markIterationResumed",
            detail: `Iteration ${input.iterationIndex} belongs to ${current.runId}, not ${input.runId}`,
          });
        }
        const resumed: PersistedEpicRunIteration = {
          ...current,
          turnStatus: "running",
          summary: null,
          why: null,
          failureReason: null,
          finishedAt: null,
          resumeCount: (current.resumeCount ?? 0) + 1,
          lastResumedAt: input.resumedAt,
        };
        yield* writeRunAtomically(filePath, yield* encodeIterationJson(resumed));
      }).pipe(Effect.mapError(journalError("markIterationResumed")));

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
      markIterationResumed,
      listIterations,
      getLatestIteration,
    });
  });

export const layer = (options: FileRunJournalOptions) => Layer.effect(RunJournal, make(options));

/** Everything a caller can do with the degradation file, reads included. */
export interface FileProviderDegradations extends ProviderDegradationJournalShape {
  readonly readProviderDegradations: Effect.Effect<
    Readonly<Record<string, ProviderDegradationRecord>>,
    RunJournalError
  >;
}

/**
 * Provider health in `<directory>/provider-degradations.json`.
 *
 * Point `directory` at the workspace rather than one run directory to carry a
 * degradation across runs of the same epic, which is what the terminal cook
 * CLI does. An unreadable or malformed file fails loudly: silently treating it
 * as empty would route a run straight back onto the account that just failed.
 */
export const makeProviderDegradations = (options: { readonly directory: string }) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const degradationsPath = path.join(options.directory, "provider-degradations.json");

    const readDegradations = Effect.fn("FileRunJournal.readDegradations")(function* () {
      if (!(yield* fileSystem.exists(degradationsPath))) return {};
      return yield* decodeProviderDegradations(yield* fileSystem.readFileString(degradationsPath));
    });

    const writeDegradations = Effect.fn("FileRunJournal.writeDegradations")(function* (
      degradations: Schema.Schema.Type<typeof ProviderDegradations>,
    ) {
      yield* writeAtomically(
        fileSystem,
        path,
        options.directory,
        degradationsPath,
        yield* encodeProviderDegradations(degradations),
      );
    });

    const upsertProviderDegradation: ProviderDegradationJournalShape["upsertProviderDegradation"] =
      (input) =>
        Effect.gen(function* () {
          const degradations = yield* readDegradations();
          yield* writeDegradations({
            ...degradations,
            [input.providerInstanceId]: {
              failureReason: input.failureReason,
              degradedAt: input.degradedAt,
              resetsAt: input.resetsAt,
            },
          });
        }).pipe(Effect.mapError(journalError("upsertProviderDegradation")));

    const clearProviderDegradation: ProviderDegradationJournalShape["clearProviderDegradation"] = (
      input,
    ) =>
      Effect.gen(function* () {
        const degradations = yield* readDegradations();
        if (!(input.providerInstanceId in degradations)) return;
        const { [input.providerInstanceId]: _dropped, ...remaining } = degradations;
        yield* writeDegradations(remaining);
      }).pipe(Effect.mapError(journalError("clearProviderDegradation")));

    return {
      readProviderDegradations: readDegradations().pipe(
        Effect.mapError(journalError("readProviderDegradations")),
      ),
      upsertProviderDegradation,
      clearProviderDegradation,
    } satisfies FileProviderDegradations;
  });

/**
 * The pool variant of the file journal: the sequential shape plus the atomic
 * iteration allocation and provider-degradation writes
 * `runParallelEpicLoop` needs. Iteration allocation lists, then creates
 * exclusively (a hard link fails on a collision); the loop calls it under its
 * transition semaphore, so the read-then-create gap cannot race in the
 * single-process terminal coordinator. Provider degradations persist to
 * `provider-degradations.json` so a terminal run leaves the same audit trail
 * the server store keeps; `degradationsDirectory` moves that file out of the
 * run directory so later runs of the same epic read it too.
 */
export const makePool = (options: FileRunJournalOptions) =>
  Effect.gen(function* () {
    const base = yield* make(options);
    const degradations = yield* makeProviderDegradations({
      directory: options.degradationsDirectory ?? options.runDirectory,
    });

    const allocateIteration: PoolRunJournalShape["allocateIteration"] = (input) =>
      Effect.gen(function* () {
        const iterations = yield* base.listIterations(input.runId);
        const iterationIndex = iterations.reduce(
          (next, iteration) => Math.max(next, iteration.iterationIndex + 1),
          0,
        );
        // The deterministic thread id is a cross-side contract: the pool loop
        // derives the same id from the returned index.
        yield* base.appendIteration({
          runId: input.runId,
          iterationIndex,
          threadId: ThreadId.make(epicRunIterationThreadId({ runId: input.runId, iterationIndex })),
          issueId: input.issueId,
          turnStatus: "running",
          summary: null,
          why: null,
          failureReason: null,
          // The only durable record of where this dispatch works. A restart
          // reads them straight back off this file to build its resumed
          // workers; the server reads the same two columns from its store.
          branch: input.branch,
          worktreePath: input.worktreePath,
          tierId: input.tierId,
          providerInstanceId: input.providerInstanceId,
          model: input.model,
          startedAt: input.startedAt,
          finishedAt: null,
        });
        return iterationIndex;
      }).pipe(Effect.mapError(journalError("allocateIteration")));

    return {
      createRun: base.createRun,
      saveRun: base.saveRun,
      getRun: base.getRun,
      appendIteration: base.appendIteration,
      updateIteration: base.updateIteration,
      markIterationResumed: base.markIterationResumed,
      listIterations: base.listIterations,
      getLatestIteration: base.getLatestIteration,
      allocateIteration,
      upsertProviderDegradation: degradations.upsertProviderDegradation,
      clearProviderDegradation: degradations.clearProviderDegradation,
    } satisfies PoolRunJournalShape;
  });
