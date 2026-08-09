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
  MergeRepairShape,
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
  readonly repair: MergeRepairShape;
  readonly backlog: Pick<BacklogShape, "createChild" | "listChildren" | "writeNotes">;
  readonly events: MergeEventsShape;
  readonly fold: FoldShape;
}

const activeEntries = (entries: ReadonlyArray<MergeQueueEntry>): ReadonlyArray<MergeQueueEntry> =>
  entries.filter((entry) => entry.status === "queued" || entry.status === "draining");

/**
 * How many times one branch may be parked and handed to a repair child for the
 * same reason before the run stops and asks for a human.
 *
 * Repair is only worth attempting while it converges. Past this the evidence
 * says the branch is not the problem, and each further attempt costs a full
 * worker iteration plus a full gate to learn nothing new.
 */
const MAX_MERGE_FIX_ATTEMPTS = 3;

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
  failureDetail?: string,
) {
  const touched = parkedTouched ?? (yield* touchedRepos(ports, snapshot, entry.branch));
  const title = mergeFixTitle(entry.branch, reason);
  const children = yield* ports.backlog.listChildren(input.epicId);
  const existing = children.find(
    (child) => child.title === title && (child.status === "open" || child.status === "in_progress"),
  );
  // Count CLOSED repairs too. Dedup alone only catches a repair still in
  // flight; once an agent closes one, the next failure looks brand new and
  // the queue happily opens another. That is how one run reached 15.
  const priorAttempts = children.filter((child) => child.title === title).length;
  if (existing === undefined && priorAttempts >= MAX_MERGE_FIX_ATTEMPTS) {
    return { repaired: false as const, attempts: priorAttempts };
  }
  const description = mergeFixDescription({
    childId: entry.childId,
    branch: entry.branch,
    baseBranch: snapshot.baseBranch,
    reason,
    gateCommand: input.gateCommand,
    pushEnabled: input.pushEnabled,
    ...(touched.length > 0 ? { touchedRepos: touched } : {}),
    ...(failureDetail === undefined ? {} : { failureDetail }),
    ...(priorAttempts > 0 ? { priorAttempts } : {}),
  });
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
  return { repaired: true as const, attempts: priorAttempts };
});

/**
 * Pull the most useful line out of a gate's output for a one-line diagnosis.
 *
 * Prefers the first line that looks like the actual error, because gate output
 * usually ends in a summary ("2 failed") that says nothing about the cause.
 */
const gateDiagnosis = (output: string): string => {
  const lines = output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const signal = lines.find((line) =>
    /(^|\b)(error|cannot find|not found|failed to resolve|missing)\b/i.test(line),
  );
  const chosen = signal ?? lines.at(-1) ?? "no gate output";
  return chosen.length > 300 ? `${chosen.slice(0, 300)}…` : chosen;
};

/**
 * Base-gate failures a dependency install can plausibly repair.
 *
 * Deliberately narrow. A fault outside this set is one no mechanical repair
 * understands, and attempting one costs a full install plus a full gate to
 * learn nothing — those must still fail fast with the diagnosis.
 */
const DEPENDENCY_FAULT =
  /ERR_MODULE_NOT_FOUND|cannot find (?:module|package|native binding)|failed to resolve (?:import|entry)/i;

/**
 * The fault signature a repair would answer, or `null` when nothing in the
 * output looks mechanically repairable.
 *
 * The signature is the diagnosis line itself, so two different faults never
 * look like a repeat of each other.
 */
const dependencyFaultSignature = (output: string): string | null =>
  DEPENDENCY_FAULT.test(output) ? gateDiagnosis(output) : null;

const parkEntry = Effect.fn("MergeQueue.parkEntry")(function* (
  input: DrainMergeQueueInput,
  ports: MergeQueuePorts,
  snapshot: MergeQueueSnapshot,
  entry: MergeQueueEntry,
  reason: MergeParkReason,
  parkedTouched?: ReadonlyArray<MergeFixTouchedRepo>,
  failureDetail?: string,
) {
  yield* ports.store.beginPark({
    runId: input.runId,
    sequence: entry.sequence,
    reason,
  });
  return yield* reconcileParkedEntry(
    input,
    ports,
    snapshot,
    entry,
    reason,
    parkedTouched,
    failureDetail,
  );
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
  if (beforeDrain.length === 0) return { _tag: "idle" as const, queueLength: 0 as const };

  // Terminal parity: `skills/cook-epic/run-legacy.sh:2894-2897`.
  const currentHead = yield* ports.git.head(snapshot.repositoryPath);
  if (currentHead !== snapshot.lastAcceptedHead) {
    return {
      _tag: "fatal" as const,
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
        _tag: "fatal" as const,
        detail: `sibling ${sibling.repositoryPath} branch ${sibling.baseBranch} moved externally; cannot trial-merge — operator must reconcile`,
        queueLength: beforeDrain.length,
      };
    }
  }

  // Terminal parity: `skills/cook-epic/run-legacy.sh:2912-2918`.
  const lease = yield* ports.slot.tryAcquire(input.holder);
  if (Option.isNone(lease)) return { _tag: "deferred" as const, queueLength: beforeDrain.length };

  return yield* Effect.gen(function* () {
    const queue = yield* ports.store.beginDrain(input.runId);
    let merged = 0;
    let parked = 0;
    /**
     * The one repair this drain may spend, once it is spent.
     *
     * One per drain is the whole bound. A repair that does not restore the
     * base ends the run below, so the run can never grind through repair after
     * repair — unbounded self-healing looks alive while making no progress,
     * which is the failure mode this queue already learned the hard way.
     */
    let remediation: { readonly signature: string } | null = null;

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
        const repair = yield* parkEntry(input, ports, snapshot, entry, "conflict", touched);
        if (!repair.repaired) {
          return {
            _tag: "fatal" as const,
            detail:
              `${entry.branch} still conflicts after ${String(repair.attempts)} repair attempts; ` +
              `stopping instead of opening another.`,
            queueLength: activeEntries(snapshot.entries).length,
          };
        }
        parked += 1;
        continue;
      }

      // One gate for the whole set, run from the main integration worktree so
      // relative sibling references resolve against the sibling trial merges
      // (`skills/cook-epic/run-legacy.sh:2975-2988`).
      if (input.gateCommand !== null) {
        const gateInput = {
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
        };
        const gate = yield* ports.gate.run(gateInput);
        if (!gate.passed) {
          yield* ports.git.resetHard(snapshot.integrationWorktreePath, snapshot.baseBranch);
          for (const sibling of snapshot.siblings) {
            yield* ports.git.resetHard(sibling.integrationWorktreePath, sibling.baseBranch);
          }

          // Classify before blaming the branch. The worktrees are back at
          // their base branches now, so the same gate here tests the base
          // with nothing merged. If that fails too, no branch in this set
          // caused it — the toolchain or the environment did. Parking the
          // branch and asking an agent to repair working code only burns
          // iterations: one such loop spent 15 of them on a missing native
          // binding that no branch had touched.
          const control = yield* ports.gate.run(gateInput);
          if (!control.passed) {
            const blameless =
              `gate also fails on ${snapshot.baseBranch} with nothing merged, ` +
              `so ${entry.branch} is not at fault: ${gateDiagnosis(control.output)}`;
            const signature = dependencyFaultSignature(control.output);
            // Say what is broken and stop. Only a fault a dependency install
            // understands is worth a repair; anything else needs a human, and
            // pretending otherwise just spends the run finding that out.
            if (signature === null) {
              return {
                _tag: "fatal" as const,
                detail: blameless,
                queueLength: activeEntries(snapshot.entries).length,
              };
            }
            if (remediation !== null) {
              return {
                _tag: "fatal" as const,
                detail:
                  `${blameless} — the integration worktrees were already repaired once ` +
                  `this drain (${remediation.signature}); not repeating it`,
                queueLength: activeEntries(snapshot.entries).length,
              };
            }

            const worktrees = [
              snapshot.integrationWorktreePath,
              ...snapshot.siblings.map((sibling) => sibling.integrationWorktreePath),
            ];
            remediation = { signature };
            yield* ports.events.emit({
              event: "remediating",
              branch: entry.branch,
              worktrees,
              signature,
            });
            const restored = yield* ports.repair.restoreDependencies({ worktrees });
            // Repairing something is not a pass. The base has to clear the
            // same gate on its own merits before the drain trusts it again.
            const recheck = restored.restored ? yield* ports.gate.run(gateInput) : null;
            const recovered = recheck?.passed === true;
            yield* ports.events.emit({
              event: "remediated",
              branch: entry.branch,
              worktrees,
              signature,
              recovered,
              detail: restored.detail,
            });
            yield* ports.backlog.writeNotes({
              issueId: input.epicId,
              note:
                `cook-epic: ${snapshot.baseBranch} failed its own gate (${signature}); ` +
                `restored integration worktree dependencies — ` +
                `${recovered ? "gate recovered" : "gate still red"}`,
            });
            if (!recovered) {
              return {
                _tag: "fatal" as const,
                detail:
                  `${blameless} — restoring the integration worktree dependencies did not fix it: ` +
                  `${recheck === null ? restored.detail : gateDiagnosis(recheck.output)}`,
                queueLength: activeEntries(snapshot.entries).length,
              };
            }
            // The environment is healthy now, but everything this entry's gate
            // said was measured in a broken one. Re-run the entry rather than
            // park a branch on void evidence. The one-repair-per-drain bound
            // makes this retry unrepeatable.
            index -= 1;
            continue;
          }

          const repair = yield* parkEntry(
            input,
            ports,
            snapshot,
            entry,
            "gate-failed",
            touched,
            gateDiagnosis(gate.output),
          );
          if (!repair.repaired) {
            return {
              _tag: "fatal" as const,
              detail:
                `${entry.branch} has failed the gate after ${String(repair.attempts)} repair ` +
                `attempts and is not converging; stopping instead of opening another. ` +
                `Last failure: ${gateDiagnosis(gate.output)}`,
              queueLength: activeEntries(snapshot.entries).length,
            };
          }
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
            _tag: "fatal" as const,
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
            _tag: "fatal" as const,
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
              _tag: "fatal" as const,
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
              _tag: "fatal" as const,
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

    return { _tag: "drained" as const, merged, parked };
  }).pipe(Effect.ensuring(ports.slot.release(input.holder).pipe(Effect.ignore)));
});
