// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";

import type { MergeQueueSnapshot } from "../ports/MergeQueue.ts";
import { makeFileMergeQueueStore, type FileMergeQueueStoreShape } from "./FileMergeQueueStore.ts";

const snapshot: MergeQueueSnapshot = {
  runId: "run-1",
  lastAcceptedHead: "base-head",
  repositoryPath: "/repo",
  baseBranch: "mine",
  integrationBranch: "cook-epic-integration-run-1",
  integrationWorktreePath: "/run/worktrees/integration",
  operatorBaseBranch: null,
  siblings: [
    {
      repositoryPath: "/sibling",
      baseBranch: "main",
      integrationWorktreePath: "/run/worktrees/sibling-integration",
      lastAcceptedHead: "sibling-head",
    },
  ],
  entries: [],
};

const withStore = <A, E>(
  use: (store: FileMergeQueueStoreShape, runDirectory: string) => Effect.Effect<A, E>,
) =>
  Effect.acquireUseRelease(
    Effect.tryPromise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "merge-queue-test-"))),
    (runDirectory) =>
      Effect.gen(function* () {
        const store = yield* makeFileMergeQueueStore({ runDirectory });
        return yield* use(store, runDirectory);
      }),
    (runDirectory) =>
      Effect.promise(() => NodeFSP.rm(runDirectory, { recursive: true, force: true })),
  );

describe("FileMergeQueueStore", () => {
  it.effect("initializes exclusively and reports existence", () =>
    withStore((store) =>
      Effect.gen(function* () {
        assert.isFalse(yield* store.exists("run-1"));
        yield* store.initialize(snapshot);
        assert.isTrue(yield* store.exists("run-1"));
        const second = yield* Effect.exit(store.initialize(snapshot));
        assert.isTrue(Exit.isFailure(second));
      }),
    ),
  );

  it.effect("rejects reads for a different run", () =>
    withStore((store) =>
      Effect.gen(function* () {
        yield* store.initialize(snapshot);
        const wrong = yield* Effect.exit(store.read("run-2"));
        assert.isTrue(Exit.isFailure(wrong));
        const missing = yield* Effect.exit(
          store.delete("run-1").pipe(Effect.andThen(store.read("run-1"))),
        );
        assert.isTrue(Exit.isFailure(missing));
        assert.isFalse(yield* store.exists("run-1"));
      }),
    ),
  );

  it.effect("runs the queue lifecycle: enqueue, drain, park, complete", () =>
    withStore((store) =>
      Effect.gen(function* () {
        yield* store.initialize(snapshot);
        yield* store.enqueue({ runId: "run-1", childId: "epic.1", branch: "epic/epic.1" });
        yield* store.enqueue({ runId: "run-1", childId: "epic.2", branch: "epic/epic.2" });

        const draining = yield* store.beginDrain("run-1");
        assert.deepEqual(
          draining.map((entry) => [entry.sequence, entry.childId, entry.status] as const),
          [
            [0, "epic.1", "draining"],
            [1, "epic.2", "draining"],
          ] as const,
        );

        // A conflicting entry parks; the branch resolves to its original child
        // immediately, and the merge-fix child is recorded later.
        yield* store.beginPark({ runId: "run-1", sequence: 1, reason: "conflict" });
        assert.deepEqual(
          yield* store.parkedOriginalChild("run-1", "epic/epic.2"),
          Option.some("epic.2"),
        );
        assert.isTrue(Option.isNone(yield* store.parkedOriginalChild("run-1", "epic/epic.9")));
        yield* store.finalizePark({ runId: "run-1", sequence: 1, fixIssueId: "epic.3" });

        // A drained entry completes and advances every accepted head.
        yield* store.complete({
          runId: "run-1",
          sequence: 0,
          lastAcceptedHead: "new-head",
          siblingHeads: [{ repositoryPath: "/sibling", lastAcceptedHead: "new-sibling-head" }],
        });
        const state = yield* store.read("run-1");
        assert.equal(state.lastAcceptedHead, "new-head");
        assert.equal(state.siblings[0]?.lastAcceptedHead, "new-sibling-head");
        assert.deepEqual(
          state.entries.map((entry) => [entry.sequence, entry.status, entry.fixIssueId] as const),
          [[1, "parked", "epic.3"]] as const,
        );

        yield* store.drop({ runId: "run-1", sequence: 1 });
        assert.equal((yield* store.read("run-1")).entries.length, 0);
      }),
    ),
  );

  it.effect("requeues a stranded draining tail with restoreTail", () =>
    withStore((store) =>
      Effect.gen(function* () {
        yield* store.initialize(snapshot);
        yield* store.enqueue({ runId: "run-1", childId: "epic.1", branch: "epic/epic.1" });
        yield* store.enqueue({ runId: "run-1", childId: "epic.2", branch: "epic/epic.2" });
        yield* store.beginDrain("run-1");

        yield* store.restoreTail({ runId: "run-1", fromSequence: 1 });
        const state = yield* store.read("run-1");
        assert.deepEqual(
          state.entries.map((entry) => entry.status),
          ["draining", "queued"],
        );
      }),
    ),
  );

  it.effect("decodes a pre-t3code-sha file with no operator base branch key as null", () =>
    withStore((store, runDirectory) =>
      Effect.gen(function* () {
        // A file written before t3code-sha never had this key at all — not
        // an explicit `null`, an absent one.
        const { operatorBaseBranch: _omit, ...legacy } = snapshot;
        yield* Effect.tryPromise(() =>
          NodeFSP.writeFile(
            NodePath.join(runDirectory, "merge-queue.json"),
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify(legacy),
          ),
        );
        const state = yield* store.read("run-1");
        assert.isNull(state.operatorBaseBranch);
      }),
    ),
  );

  it.effect("advances the accepted head without touching any entry", () =>
    withStore((store) =>
      Effect.gen(function* () {
        yield* store.initialize(snapshot);
        yield* store.enqueue({ runId: "run-1", childId: "epic.1", branch: "epic/epic.1" });

        yield* store.advanceIntegration({ runId: "run-1", lastAcceptedHead: "integrated-head" });

        const state = yield* store.read("run-1");
        assert.equal(state.lastAcceptedHead, "integrated-head");
        assert.equal(state.entries.length, 1);
        assert.equal(state.entries[0]?.status, "queued");
      }),
    ),
  );

  it.effect("survives a crash mid-drain: the next store picks the entry back up", () =>
    Effect.acquireUseRelease(
      Effect.tryPromise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "merge-queue-test-"))),
      (runDirectory) =>
        Effect.gen(function* () {
          const first = yield* makeFileMergeQueueStore({ runDirectory });
          yield* first.initialize(snapshot);
          yield* first.enqueue({ runId: "run-1", childId: "epic.1", branch: "epic/epic.1" });
          yield* first.beginDrain("run-1");

          // A fresh store over the same directory is the next process after a
          // crash: the stranded draining entry is drained again, not lost.
          const second = yield* makeFileMergeQueueStore({ runDirectory });
          const redrained = yield* second.beginDrain("run-1");
          assert.deepEqual(
            redrained.map((entry) => [entry.childId, entry.status] as const),
            [["epic.1", "draining"]] as const,
          );
        }),
      (runDirectory) =>
        Effect.promise(() => NodeFSP.rm(runDirectory, { recursive: true, force: true })),
    ),
  );
});
