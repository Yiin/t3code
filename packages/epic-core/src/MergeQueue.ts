import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { BacklogShape } from "./ports/Backlog.ts";
import type { GateShape } from "./ports/Gate.ts";
import type {
  FoldShape,
  MergeEventsShape,
  MergeGitShape,
  MergeQueueEntry,
  MergeQueueSnapshot,
  MergeQueueStoreShape,
  MergeSlotShape,
} from "./ports/MergeQueue.ts";
import {
  landingDescription,
  mergeFixDescription,
  mergeFixTitle,
  trialMergeMessage,
  type MergeParkReason,
} from "./policy.ts";

export interface DrainMergeQueueInput {
  readonly runId: string;
  readonly epicId: string;
  readonly holder: string;
  readonly gateCommand: string | null;
  readonly pushEnabled: boolean;
  readonly verified: boolean;
  readonly maxGateOutputBytes: number;
}

export type DrainMergeQueueResult =
  | { readonly _tag: "idle"; readonly queueLength: 0 }
  | { readonly _tag: "deferred"; readonly queueLength: number }
  | { readonly _tag: "drained"; readonly merged: number; readonly parked: number }
  | { readonly _tag: "fatal"; readonly detail: string; readonly queueLength: number };

export interface MergeQueuePorts {
  readonly store: MergeQueueStoreShape;
  readonly git: MergeGitShape;
  readonly slot: MergeSlotShape;
  readonly gate: GateShape;
  readonly backlog: Pick<BacklogShape, "createChild" | "listChildren" | "writeNotes">;
  readonly events: MergeEventsShape;
  readonly fold: FoldShape;
}

const activeEntries = (entries: ReadonlyArray<MergeQueueEntry>): ReadonlyArray<MergeQueueEntry> =>
  entries.filter((entry) => entry.status === "queued" || entry.status === "draining");

const reconcileParkedEntry = Effect.fn("MergeQueue.reconcileParkedEntry")(function* (
  input: DrainMergeQueueInput,
  ports: MergeQueuePorts,
  snapshot: MergeQueueSnapshot,
  entry: MergeQueueEntry,
  reason: MergeParkReason,
) {
  const description = mergeFixDescription({
    childId: entry.childId,
    branch: entry.branch,
    baseBranch: snapshot.baseBranch,
    reason,
    gateCommand: input.gateCommand,
    pushEnabled: input.pushEnabled,
  });
  const title = mergeFixTitle(entry.branch, reason);
  const children = yield* ports.backlog.listChildren(input.epicId);
  const existing = children.find(
    (child) => child.title === title && (child.status === "open" || child.status === "in_progress"),
  );
  const fix =
    existing ??
    (yield* ports.backlog.createChild({
      epicId: input.epicId,
      title,
      description,
      priority: 1,
    }));
  yield* ports.store.finalizePark({
    runId: input.runId,
    sequence: entry.sequence,
    fixIssueId: fix.id,
  });
  // Terminal parity: `skills/cook-epic/run.sh:3053-3055`.
  yield* ports.backlog.writeNotes({
    issueId: input.epicId,
    note: `cook-epic: merge of ${entry.branch} parked (${reason}); merge-fix child ${fix.id} created`,
  });
  yield* ports.events.emit({
    event: "parked",
    child: entry.childId,
    branch: entry.branch,
    reason,
    fix: fix.id,
  });
});

const parkEntry = Effect.fn("MergeQueue.parkEntry")(function* (
  input: DrainMergeQueueInput,
  ports: MergeQueuePorts,
  snapshot: MergeQueueSnapshot,
  entry: MergeQueueEntry,
  reason: MergeParkReason,
) {
  yield* ports.store.beginPark({
    runId: input.runId,
    sequence: entry.sequence,
    reason,
  });
  yield* reconcileParkedEntry(input, ports, snapshot, entry, reason);
});

/** Serialized single-repository landing loop. Terminal parity: `run.sh:3059-3235`. */
export const drainMergeQueue = Effect.fn("MergeQueue.drainMergeQueue")(function* (
  input: DrainMergeQueueInput,
  ports: MergeQueuePorts,
) {
  const snapshot = yield* ports.store.read(input.runId);
  for (const pending of snapshot.entries) {
    if (pending.status === "parked" && pending.reason !== null && pending.fixIssueId === null) {
      yield* reconcileParkedEntry(input, ports, snapshot, pending, pending.reason);
    }
  }
  const beforeDrain = activeEntries(snapshot.entries);
  if (beforeDrain.length === 0) return { _tag: "idle", queueLength: 0 };

  // Terminal parity: `skills/cook-epic/run.sh:3062-3065`.
  const currentHead = yield* ports.git.head(snapshot.repositoryPath);
  if (currentHead !== snapshot.lastAcceptedHead) {
    return {
      _tag: "fatal",
      detail: `base branch ${snapshot.baseBranch} moved externally; cannot trial-merge — operator must reconcile`,
      queueLength: beforeDrain.length,
    };
  }

  // Terminal parity: `skills/cook-epic/run.sh:3078-3084`.
  const lease = yield* ports.slot.tryAcquire(input.holder);
  if (Option.isNone(lease)) return { _tag: "deferred", queueLength: beforeDrain.length };

  return yield* Effect.gen(function* () {
    const queue = yield* ports.store.beginDrain(input.runId);
    let merged = 0;
    let parked = 0;

    for (let index = 0; index < queue.length; index += 1) {
      const entry = queue[index]!;
      // Terminal parity: `skills/cook-epic/run.sh:3090-3105`.
      const commits = yield* ports.git.commitsAhead({
        repositoryPath: snapshot.repositoryPath,
        baseBranch: snapshot.baseBranch,
        branch: entry.branch,
      });
      if (commits === 0) {
        yield* ports.store.drop({ runId: input.runId, sequence: entry.sequence });
        yield* ports.git
          .deleteLocalBranch(snapshot.repositoryPath, entry.branch)
          .pipe(Effect.catch(() => Effect.void));
        continue;
      }

      // Terminal parity: `skills/cook-epic/run.sh:3108-3112`.
      yield* ports.git.resetHard(snapshot.integrationWorktreePath, snapshot.baseBranch);
      yield* ports.git.clean(snapshot.integrationWorktreePath);
      yield* ports.git.setupWorktree(snapshot.integrationWorktreePath);

      // Terminal parity: `skills/cook-epic/run.sh:3121-3140`.
      const trial = yield* ports.git.trialMerge({
        cwd: snapshot.integrationWorktreePath,
        branch: entry.branch,
        message: trialMergeMessage(entry.branch, entry.childId),
      });
      if (!trial.merged) {
        yield* ports.git.abortMerge(snapshot.integrationWorktreePath);
        yield* parkEntry(input, ports, snapshot, entry, "conflict");
        parked += 1;
        continue;
      }

      // Terminal parity: `skills/cook-epic/run.sh:3143-3156`.
      if (input.gateCommand !== null) {
        const gate = yield* ports.gate.run({
          command: input.gateCommand,
          repositories: [
            {
              repositoryPath: snapshot.repositoryPath,
              baseBranch: snapshot.baseBranch,
              worktreeRoot: snapshot.integrationWorktreePath,
              siblings: [],
            },
          ],
          cwd: snapshot.integrationWorktreePath,
          maxOutputBytes: input.maxGateOutputBytes,
        });
        if (!gate.passed) {
          yield* ports.git.resetHard(snapshot.integrationWorktreePath, snapshot.baseBranch);
          yield* parkEntry(input, ports, snapshot, entry, "gate-failed");
          parked += 1;
          continue;
        }
      }

      // Terminal parity: `skills/cook-epic/run.sh:3158-3187`.
      const landed = yield* ports.git.fastForward({
        cwd: snapshot.repositoryPath,
        ref: snapshot.integrationBranch,
      });
      if (!landed.landed) {
        yield* ports.store.restoreTail({ runId: input.runId, fromSequence: entry.sequence });
        return {
          _tag: "fatal",
          detail: `base branch ${snapshot.baseBranch} moved externally; cannot fast-forward — operator must reconcile`,
          queueLength: queue.length - index,
        };
      }
      if (input.pushEnabled) {
        const pushed = yield* ports.git.push({
          cwd: snapshot.repositoryPath,
          remote: "origin",
          refspec: snapshot.baseBranch,
        });
        if (!pushed.pushed) {
          yield* ports.store.restoreTail({ runId: input.runId, fromSequence: entry.sequence });
          return {
            _tag: "fatal",
            detail: `push of ${snapshot.baseBranch} rejected (remote moved?); operator must reconcile`,
            queueLength: queue.length - index,
          };
        }
      }

      // Terminal parity: `skills/cook-epic/run.sh:3203-3231`.
      const head = yield* ports.git.head(snapshot.repositoryPath);
      yield* ports.store.complete({
        runId: input.runId,
        sequence: entry.sequence,
        lastAcceptedHead: head,
      });
      const landing = landingDescription({
        pushEnabled: input.pushEnabled,
        verified: input.verified,
      });
      yield* ports.events.emit({
        event: "merged",
        child: entry.childId,
        branch: entry.branch,
        commit: head.slice(0, 12),
        landing,
        repositories: [{ repo: snapshot.repositoryPath, commits, head }],
      });
      yield* ports.fold.run(entry.childId);
      yield* ports.git
        .deleteLocalBranch(snapshot.repositoryPath, entry.branch)
        .pipe(Effect.catch(() => Effect.void));
      if (input.pushEnabled) {
        yield* ports.git
          .deleteRemoteBranch(snapshot.repositoryPath, "origin", entry.branch)
          .pipe(Effect.catch(() => Effect.void));
      }
      merged += 1;
    }

    return { _tag: "drained", merged, parked };
  }).pipe(Effect.ensuring(ports.slot.release(input.holder).pipe(Effect.ignore)));
});
