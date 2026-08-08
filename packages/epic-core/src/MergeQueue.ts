import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { BacklogShape } from "./ports/Backlog.ts";
import type { GateShape } from "./ports/Gate.ts";
import type {
  FoldShape,
  MergeEventsShape,
  MergeGitShape,
  MergeQueueEntry,
  MergeQueueSiblingSnapshot,
  MergeQueueSnapshot,
  MergeQueueStoreShape,
  MergeSlotShape,
} from "./ports/MergeQueue.ts";
import {
  landingDescription,
  mergeFixDescription,
  mergeFixTitle,
  trialMergeMessage,
  type MergeFixTouchedRepo,
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

/**
 * The repos carrying commits on a branch set, main first
 * (`skills/cook-epic/run-legacy.sh:2845-2852`). Empty when the run has no
 * siblings, which keeps the single-repo park text.
 */
const touchedRepos = Effect.fn("MergeQueue.touchedRepos")(function* (
  ports: MergeQueuePorts,
  snapshot: MergeQueueSnapshot,
  branch: string,
) {
  if (snapshot.siblings.length === 0) return [] as ReadonlyArray<MergeFixTouchedRepo>;
  const touched: Array<MergeFixTouchedRepo> = [];
  const mainAhead = yield* ports.git.commitsAhead({
    repositoryPath: snapshot.repositoryPath,
    baseBranch: snapshot.baseBranch,
    branch,
  });
  if (mainAhead > 0) {
    touched.push({ kind: "main", path: snapshot.repositoryPath, baseBranch: snapshot.baseBranch });
  }
  for (const sibling of snapshot.siblings) {
    const ahead = yield* ports.git.commitsAhead({
      repositoryPath: sibling.repositoryPath,
      baseBranch: sibling.baseBranch,
      branch,
    });
    if (ahead > 0) {
      touched.push({
        kind: "sibling",
        path: sibling.repositoryPath,
        baseBranch: sibling.baseBranch,
      });
    }
  }
  return touched;
});

const reconcileParkedEntry = Effect.fn("MergeQueue.reconcileParkedEntry")(function* (
  input: DrainMergeQueueInput,
  ports: MergeQueuePorts,
  snapshot: MergeQueueSnapshot,
  entry: MergeQueueEntry,
  reason: MergeParkReason,
  parkedTouched?: ReadonlyArray<MergeFixTouchedRepo>,
) {
  const touched = parkedTouched ?? (yield* touchedRepos(ports, snapshot, entry.branch));
  const description = mergeFixDescription({
    childId: entry.childId,
    branch: entry.branch,
    baseBranch: snapshot.baseBranch,
    reason,
    gateCommand: input.gateCommand,
    pushEnabled: input.pushEnabled,
    ...(touched.length > 0 ? { touchedRepos: touched } : {}),
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
  // Terminal parity: `skills/cook-epic/run-legacy.sh:2887-2889`.
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
  parkedTouched?: ReadonlyArray<MergeFixTouchedRepo>,
) {
  yield* ports.store.beginPark({
    runId: input.runId,
    sequence: entry.sequence,
    reason,
  });
  yield* reconcileParkedEntry(input, ports, snapshot, entry, reason, parkedTouched);
});

/** Serialized single-repository landing loop. Terminal parity: `run-legacy.sh:2893-3069`. */
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

  // Terminal parity: `skills/cook-epic/run-legacy.sh:2894-2897`.
  const currentHead = yield* ports.git.head(snapshot.repositoryPath);
  if (currentHead !== snapshot.lastAcceptedHead) {
    return {
      _tag: "fatal",
      detail: `base branch ${snapshot.baseBranch} moved externally; cannot trial-merge — operator must reconcile`,
      queueLength: beforeDrain.length,
    };
  }

  // A sibling that moved since its last accepted head stops the whole drain
  // the same way (`skills/cook-epic/run-legacy.sh:2898-2905`).
  for (const sibling of snapshot.siblings) {
    const siblingHead = yield* ports.git.head(sibling.repositoryPath);
    if (siblingHead !== sibling.lastAcceptedHead) {
      return {
        _tag: "fatal",
        detail: `sibling ${sibling.repositoryPath} branch ${sibling.baseBranch} moved externally; cannot trial-merge — operator must reconcile`,
        queueLength: beforeDrain.length,
      };
    }
  }

  // Terminal parity: `skills/cook-epic/run-legacy.sh:2912-2918`.
  const lease = yield* ports.slot.tryAcquire(input.holder);
  if (Option.isNone(lease)) return { _tag: "deferred", queueLength: beforeDrain.length };

  return yield* Effect.gen(function* () {
    const queue = yield* ports.store.beginDrain(input.runId);
    let merged = 0;
    let parked = 0;

    for (let index = 0; index < queue.length; index += 1) {
      const entry = queue[index]!;
      // Which repos does this branch set touch? Landing is all-or-nothing
      // across the set (`skills/cook-epic/run-legacy.sh:2922-2932`).
      const commits = yield* ports.git.commitsAhead({
        repositoryPath: snapshot.repositoryPath,
        baseBranch: snapshot.baseBranch,
        branch: entry.branch,
      });
      const siblingCommits: Array<{
        readonly sibling: MergeQueueSiblingSnapshot;
        readonly ahead: number;
      }> = [];
      for (const sibling of snapshot.siblings) {
        const ahead = yield* ports.git.commitsAhead({
          repositoryPath: sibling.repositoryPath,
          baseBranch: sibling.baseBranch,
          branch: entry.branch,
        });
        siblingCommits.push({ sibling, ahead });
      }
      const totalAhead = siblingCommits.reduce((total, { ahead }) => total + ahead, commits);
      const touched: ReadonlyArray<MergeFixTouchedRepo> = [
        ...(commits > 0
          ? [
              {
                kind: "main" as const,
                path: snapshot.repositoryPath,
                baseBranch: snapshot.baseBranch,
              },
            ]
          : []),
        ...siblingCommits
          .filter(({ ahead }) => ahead > 0)
          .map(
            ({ sibling }): MergeFixTouchedRepo => ({
              kind: "sibling",
              path: sibling.repositoryPath,
              baseBranch: sibling.baseBranch,
            }),
          ),
      ];
      if (totalAhead === 0) {
        yield* ports.store.drop({ runId: input.runId, sequence: entry.sequence });
        // `delete_branch_everywhere` (`skills/cook-epic/run-legacy.sh:1031-1037`).
        yield* ports.git
          .deleteLocalBranch(snapshot.repositoryPath, entry.branch)
          .pipe(Effect.catch(() => Effect.void));
        for (const sibling of snapshot.siblings) {
          yield* ports.git
            .deleteLocalBranch(sibling.repositoryPath, entry.branch)
            .pipe(Effect.catch(() => Effect.void));
        }
        continue;
      }

      // The coordinator owns these integration worktrees: reset tracked state
      // and remove artifacts before each trial merge
      // (`skills/cook-epic/run-legacy.sh:2940-2951`).
      yield* ports.git.resetHard(snapshot.integrationWorktreePath, snapshot.baseBranch);
      yield* ports.git.clean(snapshot.integrationWorktreePath);
      yield* ports.git.setupWorktree(snapshot.integrationWorktreePath);
      for (const sibling of snapshot.siblings) {
        yield* ports.git.resetHard(sibling.integrationWorktreePath, sibling.baseBranch);
        yield* ports.git.clean(sibling.integrationWorktreePath);
        yield* ports.git.setupWorktree(sibling.integrationWorktreePath);
      }

      // Trial-merge every repo in the set; ANY conflict parks the whole set
      // (`skills/cook-epic/run-legacy.sh:2953-2973`).
      let conflicted = false;
      if (commits > 0) {
        const trial = yield* ports.git.trialMerge({
          cwd: snapshot.integrationWorktreePath,
          branch: entry.branch,
          message: trialMergeMessage(entry.branch, entry.childId),
        });
        if (!trial.merged) {
          yield* ports.git.abortMerge(snapshot.integrationWorktreePath);
          conflicted = true;
        }
      }
      if (!conflicted) {
        for (const { sibling, ahead } of siblingCommits) {
          if (ahead === 0) continue;
          const trial = yield* ports.git.trialMerge({
            cwd: sibling.integrationWorktreePath,
            branch: entry.branch,
            message: trialMergeMessage(entry.branch, entry.childId),
          });
          if (!trial.merged) {
            yield* ports.git.abortMerge(sibling.integrationWorktreePath);
            conflicted = true;
            break;
          }
        }
      }
      if (conflicted) {
        yield* parkEntry(input, ports, snapshot, entry, "conflict", touched);
        parked += 1;
        continue;
      }

      // One gate for the whole set, run from the main integration worktree so
      // relative sibling references resolve against the sibling trial merges
      // (`skills/cook-epic/run-legacy.sh:2975-2988`).
      if (input.gateCommand !== null) {
        const gate = yield* ports.gate.run({
          command: input.gateCommand,
          repositories: [
            {
              repositoryPath: snapshot.repositoryPath,
              baseBranch: snapshot.baseBranch,
              worktreeRoot: snapshot.integrationWorktreePath,
              siblings: snapshot.siblings.map((sibling) => ({
                repositoryPath: sibling.repositoryPath,
                baseBranch: sibling.baseBranch,
                worktreeRoot: sibling.integrationWorktreePath,
              })),
            },
          ],
          cwd: snapshot.integrationWorktreePath,
          maxOutputBytes: input.maxGateOutputBytes,
        });
        if (!gate.passed) {
          yield* ports.git.resetHard(snapshot.integrationWorktreePath, snapshot.baseBranch);
          for (const sibling of snapshot.siblings) {
            yield* ports.git.resetHard(sibling.integrationWorktreePath, sibling.baseBranch);
          }
          yield* parkEntry(input, ports, snapshot, entry, "gate-failed", touched);
          parked += 1;
          continue;
        }
      }

      // Land: fast-forward every repo in the set, then push each
      // (`skills/cook-epic/run-legacy.sh:2990-3034`).
      if (commits > 0) {
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
      }
      for (const { sibling, ahead } of siblingCommits) {
        if (ahead === 0) continue;
        const landed = yield* ports.git.fastForward({
          cwd: sibling.repositoryPath,
          ref: snapshot.integrationBranch,
        });
        if (!landed.landed) {
          yield* ports.store.restoreTail({ runId: input.runId, fromSequence: entry.sequence });
          return {
            _tag: "fatal",
            detail: `sibling ${sibling.repositoryPath} branch ${sibling.baseBranch} moved externally; cannot fast-forward — operator must reconcile`,
            queueLength: queue.length - index,
          };
        }
      }
      if (input.pushEnabled) {
        if (commits > 0) {
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
        for (const { sibling, ahead } of siblingCommits) {
          if (ahead === 0) continue;
          const pushed = yield* ports.git.push({
            cwd: sibling.repositoryPath,
            remote: "origin",
            refspec: sibling.baseBranch,
          });
          if (!pushed.pushed) {
            yield* ports.store.restoreTail({ runId: input.runId, fromSequence: entry.sequence });
            return {
              _tag: "fatal",
              detail: `push of sibling ${sibling.repositoryPath} branch ${sibling.baseBranch} rejected (remote moved?); operator must reconcile`,
              queueLength: queue.length - index,
            };
          }
        }
      }

      // Record the new head for the main repo and every sibling, even siblings
      // without commits (`skills/cook-epic/run-legacy.sh:3035-3048`).
      const head = yield* ports.git.head(snapshot.repositoryPath);
      const siblingHeads: Array<{
        readonly repositoryPath: string;
        readonly lastAcceptedHead: string;
      }> = [];
      for (const sibling of snapshot.siblings) {
        siblingHeads.push({
          repositoryPath: sibling.repositoryPath,
          lastAcceptedHead: yield* ports.git.head(sibling.repositoryPath),
        });
      }
      yield* ports.store.complete({
        runId: input.runId,
        sequence: entry.sequence,
        lastAcceptedHead: head,
        ...(snapshot.siblings.length > 0 ? { siblingHeads } : {}),
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
        repositories: [
          ...(commits > 0 ? [{ repo: snapshot.repositoryPath, commits, head }] : []),
          ...siblingCommits
            .filter(({ ahead }) => ahead > 0)
            .map(({ sibling, ahead }) => ({
              repo: sibling.repositoryPath,
              commits: ahead,
              head:
                siblingHeads.find((recorded) => recorded.repositoryPath === sibling.repositoryPath)
                  ?.lastAcceptedHead ?? "",
            })),
        ],
      });
      yield* ports.fold.run(entry.childId);
      yield* ports.git
        .deleteLocalBranch(snapshot.repositoryPath, entry.branch)
        .pipe(Effect.catch(() => Effect.void));
      for (const sibling of snapshot.siblings) {
        yield* ports.git
          .deleteLocalBranch(sibling.repositoryPath, entry.branch)
          .pipe(Effect.catch(() => Effect.void));
      }
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
