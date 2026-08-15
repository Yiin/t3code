// @effect-diagnostics nodeBuiltinImport:off
/**
 * The file-backed merge-queue store for the terminal parallel cook loop.
 *
 * The server persists the same shape in SQLite (`EpicRunMergeQueueStore.ts`);
 * the terminal coordinator is one process, so `merge-queue.json` in the run
 * directory with in-process serialization and atomic replacement is enough.
 * Crash recovery mirrors the server's: a `draining` entry survives in the
 * file and the next run's `beginDrain` picks it back up.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import {
  MergeQueuePortError,
  type MergeQueueSnapshot,
  type MergeQueueStoreShape,
} from "../ports/MergeQueue.ts";

const MergeQueueState = Schema.Struct({
  runId: Schema.String,
  lastAcceptedHead: Schema.String,
  repositoryPath: Schema.String,
  baseBranch: Schema.String,
  integrationBranch: Schema.String,
  integrationWorktreePath: Schema.String,
  // Absent in files written before t3code-sha; `readState` normalizes a
  // missing key the same way as an explicit `null` — no continuous
  // integration for this run.
  operatorBaseBranch: Schema.optionalKey(Schema.NullOr(Schema.String)),
  siblings: Schema.Array(
    Schema.Struct({
      repositoryPath: Schema.String,
      baseBranch: Schema.String,
      integrationWorktreePath: Schema.String,
      lastAcceptedHead: Schema.String,
    }),
  ),
  entries: Schema.Array(
    Schema.Struct({
      sequence: Schema.Number,
      childId: Schema.String,
      branch: Schema.String,
      status: Schema.Literals(["queued", "draining", "parked"]),
      reason: Schema.NullOr(Schema.Literals(["conflict", "gate-failed"])),
      fixIssueId: Schema.NullOr(Schema.String),
    }),
  ),
});
const decodeState = Schema.decodeUnknownEffect(Schema.fromJsonString(MergeQueueState));
const encodeState = Schema.encodeEffect(Schema.fromJsonString(MergeQueueState));

export interface FileMergeQueueStoreShape extends MergeQueueStoreShape {
  /** Whether a merge state file exists for the run. */
  readonly exists: (runId: string) => Effect.Effect<boolean, MergeQueuePortError>;
  /** Create the initial snapshot. Exclusively: an existing file fails. */
  readonly initialize: (snapshot: MergeQueueSnapshot) => Effect.Effect<void, MergeQueuePortError>;
  /** Remove the merge state file once the run's integration is released. */
  readonly delete: (runId: string) => Effect.Effect<void, MergeQueuePortError>;
}

const detail = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

const isMergeQueuePortError = Schema.is(MergeQueuePortError);

export const makeFileMergeQueueStore = (options: { readonly runDirectory: string }) =>
  Effect.gen(function* () {
    const storePath = NodePath.join(options.runDirectory, "merge-queue.json");
    // The terminal loop is one process; this semaphore is the whole
    // concurrency story (`ports/MergeQueue.ts` documents the semantics).
    const mutex = yield* Semaphore.make(1);

    const portError = (operation: string) => (cause: unknown) =>
      isMergeQueuePortError(cause)
        ? cause
        : new MergeQueuePortError({ operation, detail: detail(cause), cause });

    const readState = Effect.fn("FileMergeQueueStore.readState")(function* (runId: string) {
      const contents = yield* Effect.tryPromise({
        try: () => NodeFSP.readFile(storePath, "utf8"),
        catch: () =>
          new MergeQueuePortError({
            operation: "read",
            detail: `Merge state does not exist for ${runId}`,
          }),
      });
      const state = yield* decodeState(contents).pipe(
        Effect.mapError(
          (cause) =>
            new MergeQueuePortError({
              operation: "read",
              detail: `Invalid merge queue state: ${detail(cause)}`,
              cause,
            }),
        ),
      );
      if (state.runId !== runId) {
        return yield* new MergeQueuePortError({
          operation: "read",
          detail: `Merge state belongs to ${state.runId}, not ${runId}`,
        });
      }
      // Normalize the optional key: a file written before t3code-sha decodes
      // with the key absent, which reads identically to an explicit `null`.
      return {
        ...state,
        operatorBaseBranch: state.operatorBaseBranch ?? null,
      } satisfies MergeQueueSnapshot;
    });

    const writeState = Effect.fn("FileMergeQueueStore.writeState")(function* (
      state: MergeQueueSnapshot,
    ) {
      const encoded = yield* encodeState(state);
      yield* Effect.tryPromise({
        try: async () => {
          await NodeFSP.mkdir(options.runDirectory, { recursive: true });
          const temporary = await NodeFSP.mkdtemp(
            NodePath.join(options.runDirectory, "merge-queue.json."),
          );
          const temporaryPath = NodePath.join(temporary, "contents.tmp");
          const file = await NodeFSP.open(temporaryPath, "w");
          try {
            await file.writeFile(encoded);
            await file.sync();
          } finally {
            await file.close();
          }
          await NodeFSP.rename(temporaryPath, storePath);
          await NodeFSP.rmdir(temporary);
        },
        catch: (cause) =>
          new MergeQueuePortError({
            operation: "write",
            detail: `Could not write ${storePath}: ${detail(cause)}`,
            cause,
          }),
      });
    });

    /** Serialize one read-modify-write against every other store operation. */
    const mutate = <A>(
      operation: string,
      runId: string,
      update: (state: MergeQueueSnapshot) => {
        readonly state: MergeQueueSnapshot;
        readonly result: A;
      },
    ): Effect.Effect<A, MergeQueuePortError> =>
      mutex.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* readState(runId);
          const next = update(current);
          yield* writeState(next.state);
          return next.result;
        }).pipe(Effect.mapError(portError(operation))),
      );

    const exists: FileMergeQueueStoreShape["exists"] = () =>
      Effect.tryPromise({
        try: () =>
          NodeFSP.access(storePath).then(
            () => true,
            () => false,
          ),
        catch: (cause) =>
          new MergeQueuePortError({
            operation: "exists",
            detail: `Could not stat ${storePath}: ${detail(cause)}`,
            cause,
          }),
      });

    const initialize: FileMergeQueueStoreShape["initialize"] = (snapshot) =>
      Effect.gen(function* () {
        const encoded = yield* encodeState(snapshot);
        yield* Effect.tryPromise({
          try: async () => {
            await NodeFSP.mkdir(options.runDirectory, { recursive: true });
            // `wx` fails when the file exists: initialization stays exclusive.
            await NodeFSP.writeFile(storePath, encoded, { flag: "wx" });
          },
          catch: (cause) =>
            new MergeQueuePortError({
              operation: "initialize",
              detail: `Could not create ${storePath}: ${detail(cause)}`,
              cause,
            }),
        });
      }).pipe(Effect.mapError(portError("initialize")));

    const deleteState: FileMergeQueueStoreShape["delete"] = () =>
      Effect.tryPromise({
        try: () => NodeFSP.rm(storePath, { force: true }),
        catch: (cause) =>
          new MergeQueuePortError({
            operation: "delete",
            detail: `Could not remove ${storePath}: ${detail(cause)}`,
            cause,
          }),
      });

    return {
      exists,
      initialize,
      delete: deleteState,
      read: (runId) => readState(runId).pipe(Effect.mapError(portError("read"))),
      beginDrain: (runId) =>
        mutex.withPermits(1)(
          Effect.gen(function* () {
            const current = yield* readState(runId);
            const next: MergeQueueSnapshot = {
              ...current,
              entries: current.entries.map((entry) =>
                entry.status === "queued" ? { ...entry, status: "draining" as const } : entry,
              ),
            };
            yield* writeState(next);
            return next.entries.filter((entry) => entry.status === "draining");
          }).pipe(Effect.mapError(portError("beginDrain"))),
        ),
      enqueue: ({ runId, childId, branch }) =>
        mutate("enqueue", runId, (current) => ({
          state: {
            ...current,
            entries: [
              ...current.entries,
              {
                sequence: current.entries.reduce(
                  (next, entry) => Math.max(next, entry.sequence + 1),
                  0,
                ),
                childId,
                branch,
                status: "queued" as const,
                reason: null,
                fixIssueId: null,
              },
            ],
          },
          result: undefined,
        })),
      restoreTail: ({ runId, fromSequence }) =>
        mutate("restoreTail", runId, (current) => ({
          state: {
            ...current,
            entries: current.entries.map((entry) =>
              entry.status === "draining" && entry.sequence >= fromSequence
                ? { ...entry, status: "queued" as const }
                : entry,
            ),
          },
          result: undefined,
        })),
      advanceIntegration: ({ runId, lastAcceptedHead }) =>
        mutate("advanceIntegration", runId, (current) => ({
          state: { ...current, lastAcceptedHead },
          result: undefined,
        })),
      beginPark: ({ runId, sequence, reason }) =>
        mutate("beginPark", runId, (current) => ({
          state: {
            ...current,
            entries: current.entries.map((entry) =>
              entry.sequence === sequence
                ? { ...entry, status: "parked" as const, reason, fixIssueId: null }
                : entry,
            ),
          },
          result: undefined,
        })),
      finalizePark: ({ runId, sequence, fixIssueId }) =>
        mutate("finalizePark", runId, (current) => ({
          state: {
            ...current,
            entries: current.entries.map((entry) =>
              entry.sequence === sequence ? { ...entry, fixIssueId } : entry,
            ),
          },
          result: undefined,
        })),
      // `complete` and `drop` both delete every entry sharing the landed
      // sequence's branch, not just that one row — parity with the SQL
      // store's `deleteEpicRunMergeRow` (`EpicRuns.ts`), which the completion
      // proof (t3code-xig) depends on. A merge-fix child re-enqueues its
      // branch under a NEW sequence and leaves the ORIGINAL sequence parked
      // with `fixIssueId` set; a sequence-only filter left that original row
      // behind forever once the new one landed, so a raw queue read would
      // see a "parked" entry for a branch that had already landed.
      complete: ({ runId, sequence, lastAcceptedHead, siblingHeads }) =>
        mutate("complete", runId, (current) => {
          const branch = current.entries.find((entry) => entry.sequence === sequence)?.branch;
          return {
            state: {
              ...current,
              lastAcceptedHead,
              siblings: current.siblings.map((sibling) => ({
                ...sibling,
                lastAcceptedHead:
                  siblingHeads?.find((head) => head.repositoryPath === sibling.repositoryPath)
                    ?.lastAcceptedHead ?? sibling.lastAcceptedHead,
              })),
              entries: current.entries.filter((entry) => entry.branch !== branch),
            },
            result: undefined,
          };
        }),
      drop: ({ runId, sequence }) =>
        mutate("drop", runId, (current) => {
          const branch = current.entries.find((entry) => entry.sequence === sequence)?.branch;
          return {
            state: {
              ...current,
              entries: current.entries.filter((entry) => entry.branch !== branch),
            },
            result: undefined,
          };
        }),
      parkedOriginalChild: (runId, branch) =>
        Effect.map(readState(runId), (state) =>
          Option.fromUndefinedOr(
            state.entries.find((entry) => entry.status === "parked" && entry.branch === branch)
              ?.childId,
          ),
        ).pipe(Effect.mapError(portError("parkedOriginalChild"))),
    } satisfies FileMergeQueueStoreShape;
  });
