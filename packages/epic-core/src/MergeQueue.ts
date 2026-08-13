import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { BacklogShape } from "./ports/Backlog.ts";
import { gateCommandDigest, type GateShape } from "./ports/Gate.ts";
import {
  persistedGateReceipt,
  type GateReceiptJournalShape,
  type GateReceiptPhase,
} from "./ports/GateReceipts.ts";
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
  conflictFailureDetail,
  integrateOperatorBaseMessage,
  integrationFixDescription,
  integrationFixTitle,
  landingDescription,
  mergeFixDescription,
  mergeFixTitle,
  runBaseBranch,
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
  | {
      readonly _tag: "deferred";
      readonly queueLength: number;
      /**
       * Who holds the slot, or `null` when it is unreadable. A deferral is
       * only legitimate while a live holder finishes its merge set, so the
       * holder is what tells a stalled run apart from a patient one — without
       * it, "deferred" says nothing an operator can act on.
       */
      readonly holder: string | null;
    }
  | {
      readonly _tag: "drained";
      readonly merged: number;
      readonly parked: number;
      /**
       * Active entries this drain left untouched because an operator-base
       * integration conflict (t3code-sha) stopped the drain before the
       * per-entry loop ran. Omitted (not `0`) on every drain that skipped
       * nothing, so a plain `{ merged, parked }` equality check on an
       * unaffected drain still holds.
       */
      readonly blocked?: number;
    }
  | { readonly _tag: "fatal"; readonly detail: string; readonly queueLength: number };

export interface MergeQueuePorts {
  readonly store: MergeQueueStoreShape;
  readonly git: MergeGitShape;
  readonly slot: MergeSlotShape;
  readonly gate: GateShape;
  /** Every gate this drain runs lands here before the drain acts on its verdict. */
  readonly gateReceipts: GateReceiptJournalShape;
  readonly repair: MergeRepairShape;
  readonly backlog: Pick<BacklogShape, "createChild" | "listChildren" | "writeNotes">;
  readonly events: MergeEventsShape;
  readonly fold: FoldShape;
}

/**
 * Run one gate and persist its receipt before anyone acts on the verdict.
 *
 * Every gate the drain runs goes through here, including the ones that fail
 * the adapter outright: a gate that timed out after two hours is the single
 * most expensive thing an epic run does, and a run that lands or parks with
 * no record of it cannot explain either its wall time or its verification.
 * The receipt is written first, then the failure is re-raised unchanged.
 */
const runGate = Effect.fn("MergeQueue.runGate")(function* (
  ports: MergeQueuePorts,
  input: {
    readonly runId: string;
    readonly phase: GateReceiptPhase;
    readonly childId: string | null;
    readonly branch: string | null;
    readonly gate: {
      readonly command: string;
      readonly repositories: Parameters<GateShape["run"]>[0]["repositories"];
      readonly cwd: string;
      readonly maxOutputBytes: number;
    };
  },
) {
  const queuedAt = yield* DateTime.now;
  const outcome = yield* Effect.result(ports.gate.run(input.gate));
  if (outcome._tag === "Failure") {
    const finishedAt = yield* DateTime.now;
    yield* ports.gateReceipts.record(
      persistedGateReceipt({
        runId: input.runId,
        phase: input.phase,
        childId: input.childId,
        branch: input.branch,
        receipt: {
          commandDigest: gateCommandDigest(input.gate.command),
          cwd: input.gate.cwd,
          outcome: "error",
          exitCode: null,
          queuedAt: DateTime.formatIso(queuedAt),
          acquiredAt: null,
          finishedAt: DateTime.formatIso(finishedAt),
          lockWaitMs: 0,
          executionMs: Math.max(
            0,
            DateTime.toEpochMillis(finishedAt) - DateTime.toEpochMillis(queuedAt),
          ),
          // The adapter never started the command, so nothing was tested and
          // no head can be claimed as an input.
          inputHeads: [],
          output: outcome.failure.message.slice(0, input.gate.maxOutputBytes),
        },
      }),
    );
    return yield* outcome.failure;
  }
  yield* ports.gateReceipts.record(
    persistedGateReceipt({
      runId: input.runId,
      phase: input.phase,
      childId: input.childId,
      branch: input.branch,
      receipt: {
        ...outcome.success.receipt,
        ...(outcome.success.outputPath === undefined
          ? {}
          : { outputPath: outcome.success.outputPath }),
      },
    }),
  );
  return outcome.success;
});

const activeEntries = (entries: ReadonlyArray<MergeQueueEntry>): ReadonlyArray<MergeQueueEntry> =>
  entries.filter((entry) => entry.status === "queued" || entry.status === "draining");

/**
 * One queue entry, measured once, ready to be trial-merged with others.
 *
 * The measurement happens before any trial merge because a batch has to know
 * its whole membership first. `siblingCommits` is positional: index `i` is
 * `snapshot.siblings[i]`.
 */
interface BatchMember {
  readonly entry: MergeQueueEntry;
  /** Commits this branch carries in the main repository. */
  readonly commits: number;
  readonly siblingCommits: ReadonlyArray<{
    readonly sibling: MergeQueueSiblingSnapshot;
    readonly ahead: number;
  }>;
  /** The repos this branch set touches, for a merge-fix child's description. */
  readonly touched: ReadonlyArray<MergeFixTouchedRepo>;
}

/**
 * One member with its file footprint measured, or `null` when git could not
 * report it.
 *
 * `null` is not "no files": a member whose footprint is unknown batches with
 * nobody, because disjointness is the only thing that makes a shared gate
 * verdict attributable.
 */
interface MeasuredMember {
  readonly member: BatchMember;
  readonly files: ReadonlySet<string> | null;
}

/**
 * One file, qualified by the repository it lives in.
 *
 * A branch set spans repositories, and `src/index.ts` in the main repo has
 * nothing to do with `src/index.ts` in a sibling — comparing the bare relative
 * paths would call two disjoint sets overlapping.
 */
const fileKey = (repositoryPath: string, path: string): string => `${repositoryPath}\u0000${path}`;

/**
 * Every file a branch set changes, across every repository it has commits in,
 * or `null` when any of those reads failed.
 *
 * Fail-soft on purpose: a footprint this drain could not measure is not an
 * empty one, and treating it as empty would batch a branch on evidence that
 * does not exist. An unmeasurable branch just goes through alone, which is
 * exactly what the queue did before batching by footprint.
 */
const measureFiles = Effect.fn("MergeQueue.measureFiles")(function* (
  ports: MergeQueuePorts,
  member: BatchMember,
) {
  const files = new Set<string>();
  for (const repo of member.touched) {
    const changed = yield* ports.git
      .changedFiles({
        repositoryPath: repo.path,
        baseBranch: repo.baseBranch,
        branch: member.entry.branch,
      })
      .pipe(Effect.orElseSucceed(() => null));
    if (changed === null) return null;
    for (const path of changed) files.add(fileKey(repo.path, path));
  }
  return files;
});

/**
 * Split the queue into runs of consecutive entries whose file footprints are
 * pairwise disjoint.
 *
 * Disjointness is what makes a shared gate honest. Members that touch the same
 * file can break each other in ways no single member breaks alone, so a red
 * batch of them costs the isolation pass to learn nothing about any member;
 * members that touch nothing in common are as independent as separate runs, so
 * one gate answers for all of them. Consecutive because queue order is landing
 * order — reordering entries to pack fuller batches would let a later child
 * land before the one it was written against.
 */
const groupByFootprint = (
  measured: ReadonlyArray<MeasuredMember>,
): Array<ReadonlyArray<BatchMember>> => {
  const groups: Array<ReadonlyArray<BatchMember>> = [];
  let current: Array<BatchMember> = [];
  // The union of the current group's footprints. Checking a candidate against
  // the union is the same test as checking it against every member in turn.
  let claimed = new Set<string>();
  const flush = () => {
    if (current.length > 0) groups.push(current);
    current = [];
    claimed = new Set<string>();
  };
  for (const { member, files } of measured) {
    if (files === null) {
      flush();
      groups.push([member]);
      continue;
    }
    if ([...files].some((file) => claimed.has(file))) flush();
    current.push(member);
    for (const file of files) claimed.add(file);
  }
  flush();
  return groups;
};

/**
 * Halve a batch its gate rejected.
 *
 * Halving, not one-by-one retesting: a batch of N with a single bad branch
 * costs `log2(N)` further gates instead of N, and the bad branch is still
 * isolated exactly. The gate is the most expensive thing an epic run does, so
 * the count of gates is the whole point of batching.
 */
const splitBatch = (
  batch: ReadonlyArray<BatchMember>,
): ReadonlyArray<ReadonlyArray<BatchMember>> => {
  const half = Math.ceil(batch.length / 2);
  return [batch.slice(0, half), batch.slice(half)];
};

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
 * Two traps shaped this (t3code-9hv):
 *
 * - A PASSING test name can carry the signal words: "✓ does not emit a second
 *   process-exit error after a decode failure" matches the error regex, so
 *   every candidate in every branch must be free of a pass marker (✓/✔).
 * - Gate packages run concurrently, so the output interleaves and the last
 *   flushed line is frequently a ✓ line from a package that passed. The bare
 *   last line is never a diagnosis; the fallback says so instead.
 *
 * Priority: vitest FAIL/× entries, then the "Test Files N failed" summary,
 * then the error regex. ANSI escapes are stripped first — vitest wraps its
 * markers in color. When the run persisted the full gate output, the log path
 * rides along so the one line never has to carry everything.
 */
const gateDiagnosis = (output: string, logPath?: string): string => {
  const lines = output
    // oxlint-disable-next-line no-control-regex -- The ESC byte is the point: strip vitest's ANSI color before matching.
    .replace(/\u001b\[[0-9;]*m/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const candidates = lines.filter((line) => !line.includes("✓") && !line.includes("✔"));
  const chosen =
    candidates.find((line) => /^(FAIL\s|×)/.test(line)) ??
    candidates.find((line) => /Test Files\s+\d+ failed|Tests\s+\d+ failed/.test(line)) ??
    candidates.find((line) =>
      /(^|\b)(error|cannot find|not found|failed to resolve|missing)\b/i.test(line),
    ) ??
    `no failure line found in gate output (${String(lines.length)} lines)`;
  const withLog = logPath === undefined ? chosen : `${chosen}; full gate log: ${logPath}`;
  return withLog.length > 300 ? `${withLog.slice(0, 300)}…` : withLog;
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

/**
 * Ensure exactly one run-level child exists to resolve a conflict merging the
 * operator's branch into the run's owned base branch (t3code-sha).
 *
 * Deliberately NOT the entry-keyed park machinery (`beginPark`/`finalizePark`,
 * `parkEntry`): the conflict is between the run's own base and the operator's
 * branch, not any one queue entry, so there is no entry sequence to key a park
 * to, and every entry in the queue would hit the identical conflict until this
 * is fixed. Dedup is purely by title against the live backlog — no
 * queue-store mutation — so a crash between creating the child and returning
 * is self-healing: the next call just finds the same open child and does
 * nothing.
 *
 * Bounded the same way `reconcileParkedEntry` bounds a per-branch repair
 * (`MAX_MERGE_FIX_ATTEMPTS`): counts CLOSED children too, not just one still
 * in flight, so a closed-without-resolving cycle cannot manufacture a fresh
 * child forever.
 */
const ensureIntegrationFixChild = Effect.fn("MergeQueue.ensureIntegrationFixChild")(function* (
  input: DrainMergeQueueInput,
  ports: MergeQueuePorts,
  snapshot: MergeQueueSnapshot,
  operatorBranch: string,
  failureDetail: string,
) {
  const title = integrationFixTitle(snapshot.baseBranch, operatorBranch);
  const children = yield* ports.backlog.listChildren(input.epicId);
  const existing = children.find(
    (child) => child.title === title && (child.status === "open" || child.status === "in_progress"),
  );
  const priorAttempts = children.filter((child) => child.title === title).length;
  if (existing !== undefined) return { blocked: false as const, attempts: priorAttempts };
  if (priorAttempts >= MAX_MERGE_FIX_ATTEMPTS) {
    return { blocked: true as const, attempts: priorAttempts };
  }
  const description = integrationFixDescription({
    baseBranch: snapshot.baseBranch,
    operatorBranch,
    gateCommand: input.gateCommand,
    ...(failureDetail.length > 0 ? { failureDetail } : {}),
    ...(priorAttempts > 0 ? { priorAttempts } : {}),
  });
  const fix = yield* ports.backlog.createChild({
    epicId: input.epicId,
    title,
    description,
    priority: 1,
  });
  yield* ports.backlog.writeNotes({
    issueId: input.epicId,
    note:
      `cook-epic: ${snapshot.baseBranch} cannot merge ${operatorBranch} automatically; ` +
      `integration-fix child ${fix.id} created`,
  });
  yield* ports.events.emit({ event: "integration-blocked", operatorBranch, fix: fix.id });
  return { blocked: false as const, attempts: priorAttempts };
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

  // Whether this run owns its base branch (t3code-5m4) rather than sharing
  // the operator's checkout, derived from the branch name alone — no extra
  // persisted field, and correct across every resume for free. Only the main
  // repository can be owned in this slice; siblings keep today's rules.
  const ownedBaseBranch = snapshot.baseBranch === runBaseBranch(input.epicId);
  // The operator branch this run continuously integrates (t3code-sha), or
  // `null` for no integration: flag off, an unowned base branch, or a
  // snapshot that predates the field. `null` here means this whole function
  // makes zero new git calls beyond today's — the flag-off contract (t3code-sha).
  const operatorBaseBranch = ownedBaseBranch ? snapshot.operatorBaseBranch : null;

  // With nothing queued and no integration to attempt, there is nothing this
  // drain can do — exactly today's early return when the flag is off or the
  // run shares the operator's checkout.
  if (beforeDrain.length === 0 && operatorBaseBranch === null) {
    return { _tag: "idle" as const, queueLength: 0 as const };
  }

  // Terminal parity: `skills/cook-epic/run-legacy.sh:2894-2897`. An owned base
  // branch is never checked out at `repositoryPath` — the operator's own
  // branch is — so its head is read by name, not by `HEAD`.
  const currentHead = yield* ports.git.head(
    snapshot.repositoryPath,
    ownedBaseBranch ? snapshot.baseBranch : undefined,
  );
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
  if (Option.isNone(lease)) {
    // Reading the holder must never turn a deferral into a failure: the slot
    // being unreadable is exactly one of the states this reports on.
    const holder = yield* ports.slot.holder.pipe(
      Effect.map(Option.getOrNull),
      Effect.catchCause(() => Effect.succeed(null)),
    );
    return { _tag: "deferred" as const, queueLength: beforeDrain.length, holder };
  }

  return yield* Effect.gen(function* () {
    // Continuous integration of the operator's base branch (t3code-sha): once
    // per drain, before any trial merge and before any queue entry is even
    // marked draining, so a conflict here never strands an entry mid-drain
    // (D2) and every reset that follows — including the gate-failure control
    // gate's — sees a base that already carries the operator's commits (D5),
    // because this advances the base branch's ref directly, not just a
    // worktree copy of it.
    if (operatorBaseBranch !== null) {
      const ahead = yield* ports.git.commitsAhead({
        repositoryPath: snapshot.repositoryPath,
        baseBranch: snapshot.baseBranch,
        branch: operatorBaseBranch,
      });
      if (ahead > 0) {
        yield* ports.git.resetHard(snapshot.integrationWorktreePath, snapshot.baseBranch);
        yield* ports.git.clean(snapshot.integrationWorktreePath);
        yield* ports.git.setupWorktree(snapshot.integrationWorktreePath);
        const trial = yield* ports.git.trialMerge({
          cwd: snapshot.integrationWorktreePath,
          branch: operatorBaseBranch,
          message: integrateOperatorBaseMessage(operatorBaseBranch),
        });
        if (!trial.merged) {
          yield* ports.git.abortMerge(snapshot.integrationWorktreePath);
          // Operator drift is a run-level concern, not a per-entry one: no
          // entry caused this, so no entry is parked and the queue is left
          // exactly as `beginDrain` never ran (D1, D2). Exactly one bounded
          // fix child is created or reused instead (D3).
          const fix = yield* ensureIntegrationFixChild(
            input,
            ports,
            snapshot,
            operatorBaseBranch,
            trial.output,
          );
          if (fix.blocked) {
            return {
              _tag: "fatal" as const,
              detail:
                `integration of ${operatorBaseBranch} into ${snapshot.baseBranch} still conflicts ` +
                `after ${String(fix.attempts)} repair attempts; stopping instead of opening another.`,
              queueLength: beforeDrain.length,
            };
          }
          return {
            _tag: "drained" as const,
            merged: 0,
            parked: 0,
            ...(beforeDrain.length > 0 ? { blocked: beforeDrain.length } : {}),
          };
        }
        // A no-op integration ("Already up to date") never reaches here —
        // `ahead > 0` guarantees the merge actually advances the base — so
        // `trial.merged` at this point always means real progress to land.
        const landed = yield* ports.git.fastForward({
          cwd: snapshot.repositoryPath,
          ref: snapshot.integrationBranch,
          branch: snapshot.baseBranch,
        });
        if (!landed.landed) {
          return {
            _tag: "fatal" as const,
            detail:
              `base branch ${snapshot.baseBranch} moved externally while integrating ` +
              `${operatorBaseBranch}; cannot fast-forward — operator must reconcile` +
              (landed.output.length > 0 ? `: ${landed.output}` : ""),
            queueLength: beforeDrain.length,
          };
        }
        // Push now rather than deferring to the next landing: if every queue
        // entry then drops as empty, or the queue was empty, nothing else
        // would ever push this integration, and the operator's own commits
        // would sit unpushed on a branch they do not check out locally.
        if (input.pushEnabled) {
          const pushed = yield* ports.git.push({
            cwd: snapshot.repositoryPath,
            remote: "origin",
            refspec: snapshot.baseBranch,
          });
          if (!pushed.pushed) {
            return {
              _tag: "fatal" as const,
              detail:
                `push of ${snapshot.baseBranch} rejected after integrating ` +
                `${operatorBaseBranch} (remote moved?); operator must reconcile`,
              queueLength: beforeDrain.length,
            };
          }
        }
        const integratedHead = yield* ports.git.head(snapshot.repositoryPath, snapshot.baseBranch);
        yield* ports.store.advanceIntegration({
          runId: input.runId,
          lastAcceptedHead: integratedHead,
        });
        if (beforeDrain.length === 0) {
          return { _tag: "drained" as const, merged: 0, parked: 0 };
        }
      }
    }

    if (beforeDrain.length === 0) {
      return { _tag: "idle" as const, queueLength: 0 as const };
    }

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

    // Measure every active entry before the first trial merge. A batch has to
    // know its whole membership up front, and an entry carrying no commits is
    // dropped here rather than taking a slot in one
    // (`skills/cook-epic/run-legacy.sh:2922-2932`).
    const pending: Array<BatchMember> = [];
    for (const entry of queue) {
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
      pending.push({
        entry,
        commits,
        siblingCommits,
        touched: [
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
        ],
      });
    }

    /**
     * The batches still to verify, in queue order.
     *
     * Starts as runs of consecutive entries with disjoint file footprints: the
     * whole point is that three compatible children cost one gate, not three,
     * and disjointness is what lets one verdict answer for all three. A red
     * batch is replaced here by its two halves, so the list only ever shrinks
     * toward single entries, and a single entry never splits again.
     *
     * A lone entry is never measured — there is nothing to be disjoint from,
     * so the footprint reads would buy nothing.
     */
    const batches: Array<ReadonlyArray<BatchMember>> =
      pending.length > 1
        ? groupByFootprint(
            yield* Effect.forEach(pending, (member) =>
              measureFiles(ports, member).pipe(Effect.map((files) => ({ member, files }))),
            ),
          )
        : pending.length > 0
          ? [pending]
          : [];
    /**
     * Whether the base already passed this gate, with nothing merged, since
     * the last thing landed.
     *
     * A red batch asks that question once and every half inherits the answer:
     * nothing landed between a batch and its halves, so the base they sit on
     * is the same base, and re-running the control gate per half would spend
     * the run's most expensive operation to re-learn a fact it just proved.
     * Landing clears it — the base moved, so the old answer is about a
     * different tree.
     */
    let baseVerified = false;

    while (batches.length > 0) {
      const group = batches.shift() ?? [];

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

      // Stack the group's trial merges into one integration state. ANY
      // conflict parks that whole branch set and only that set
      // (`skills/cook-epic/run-legacy.sh:2953-2973`); the rest of the batch
      // carries on without it.
      const batch: Array<BatchMember> = [];
      for (const member of group) {
        // Every integration worktree this branch set has commits for, main
        // first.
        const targets = [
          ...(member.commits > 0
            ? [
                {
                  cwd: snapshot.integrationWorktreePath,
                  repositoryPath: snapshot.repositoryPath,
                },
              ]
            : []),
          ...member.siblingCommits
            .filter(({ ahead }) => ahead > 0)
            .map(({ sibling }) => ({
              cwd: sibling.integrationWorktreePath,
              repositoryPath: sibling.repositoryPath,
            })),
        ];
        /**
         * Where each repository stood before this member merged into it.
         *
         * A set spanning several repositories can merge cleanly into the first
         * and conflict in the second, and the batch still holds every earlier
         * member's merge — so resetting to the base branch would throw those
         * away, and `abortMerge` alone leaves the first repository carrying
         * work that is about to be parked. Only recorded for multi-repository
         * sets; for a single repository the abort is the whole rollback.
         */
        const rollback: Array<{ readonly cwd: string; readonly head: string }> = [];
        let conflictDetail: string | undefined;
        for (const target of targets) {
          if (targets.length > 1) {
            rollback.push({ cwd: target.cwd, head: yield* ports.git.head(target.cwd) });
          }
          const trial = yield* ports.git.trialMerge({
            cwd: target.cwd,
            branch: member.entry.branch,
            message: trialMergeMessage(member.entry.branch, member.entry.childId),
          });
          if (!trial.merged) {
            // Read the conflict BEFORE aborting: the abort is what destroys
            // the unmerged index and the conflict markers this describes.
            const conflict = yield* ports.git.conflictDetail({
              cwd: target.cwd,
              maxOutputBytes: input.maxGateOutputBytes,
            });
            conflictDetail = conflictFailureDetail({
              repositoryPath: target.repositoryPath,
              mergeOutput: trial.output,
              files: conflict?.files ?? [],
              diff: conflict?.diff ?? "",
            });
            yield* ports.git.abortMerge(target.cwd);
            break;
          }
        }
        if (conflictDetail === undefined) {
          batch.push(member);
          continue;
        }
        // The conflicting repository is already back where it was; the ones
        // before it are not.
        for (const undo of rollback.slice(0, -1)) {
          yield* ports.git.resetHard(undo.cwd, undo.head);
        }
        const repair = yield* parkEntry(
          input,
          ports,
          snapshot,
          member.entry,
          "conflict",
          member.touched,
          conflictDetail,
        );
        if (!repair.repaired) {
          return {
            _tag: "fatal" as const,
            detail:
              `${member.entry.branch} still conflicts after ${String(repair.attempts)} repair attempts; ` +
              `stopping instead of opening another.`,
            queueLength: activeEntries(snapshot.entries).length,
          };
        }
        parked += 1;
      }
      if (batch.length === 0) continue;

      // One gate for the whole batch, run from the main integration worktree so
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
        const gate = yield* runGate(ports, {
          runId: input.runId,
          phase: "entry",
          // A batch verifies several branches at once, so no single child is
          // under test — naming one would blame it for a failure any member
          // could have caused. The receipt still names every branch.
          childId: batch.length === 1 ? batch[0]!.entry.childId : null,
          branch: batch.map((member) => member.entry.branch).join(" "),
          gate: gateInput,
        });
        if (!gate.passed) {
          yield* ports.git.resetHard(snapshot.integrationWorktreePath, snapshot.baseBranch);
          for (const sibling of snapshot.siblings) {
            yield* ports.git.resetHard(sibling.integrationWorktreePath, sibling.baseBranch);
          }

          // Classify before blaming anything. The worktrees are back at their
          // base branches now, so the same gate here tests the base with
          // nothing merged. If that fails too, no branch in this batch caused
          // it — the toolchain or the environment did. Parking a branch and
          // asking an agent to repair working code only burns iterations: one
          // such loop spent 15 of them on a missing native binding that no
          // branch had touched.
          if (!baseVerified) {
            const control = yield* runGate(ports, {
              runId: input.runId,
              phase: "control",
              // The control gate tests the base with nothing merged, so it
              // belongs to no child. Naming one here would blame it.
              childId: null,
              branch: null,
              gate: gateInput,
            });
            if (!control.passed) {
              const blameless =
                `gate also fails on ${snapshot.baseBranch} with nothing merged, ` +
                `so ${batch.map((member) => member.entry.branch).join(", ")} ` +
                `${batch.length === 1 ? "is" : "are"} not at fault: ` +
                `${gateDiagnosis(control.output, control.outputPath)}`;
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
                branch: batch[0]!.entry.branch,
                worktrees,
                signature,
              });
              const restored = yield* ports.repair.restoreDependencies({ worktrees });
              // Repairing something is not a pass. The base has to clear the
              // same gate on its own merits before the drain trusts it again.
              const recheck = restored.restored
                ? yield* runGate(ports, {
                    runId: input.runId,
                    phase: "recheck",
                    childId: null,
                    branch: null,
                    gate: gateInput,
                  })
                : null;
              const recovered = recheck?.passed === true;
              yield* ports.events.emit({
                event: "remediated",
                branch: batch[0]!.entry.branch,
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
                    `${recheck === null ? restored.detail : gateDiagnosis(recheck.output, recheck.outputPath)}`,
                  queueLength: activeEntries(snapshot.entries).length,
                };
              }
              // The environment is healthy now, but everything this batch's
              // gate said was measured in a broken one. Re-verify the same
              // batch rather than blame it on void evidence — and re-run the
              // control with it, because a repair proves the base was healthy
              // for one moment, not that it stayed that way. The
              // one-repair-per-drain bound makes this retry unrepeatable.
              batches.unshift(batch);
              continue;
            }
            baseVerified = true;
          }

          // The base is healthy, so this batch really does carry the fault.
          // With more than one member in it, which one is still unknown:
          // halve and re-verify instead of blaming every member for what one
          // of them did.
          if (batch.length > 1) {
            const halves = splitBatch(batch);
            yield* ports.events.emit({
              event: "split",
              branches: batch.map((member) => member.entry.branch),
              halves: halves.map((half) => half.length),
              detail: gateDiagnosis(gate.output, gate.outputPath),
            });
            batches.unshift(...halves);
            continue;
          }

          const member = batch[0]!;
          const repair = yield* parkEntry(
            input,
            ports,
            snapshot,
            member.entry,
            "gate-failed",
            member.touched,
            gateDiagnosis(gate.output, gate.outputPath),
          );
          if (!repair.repaired) {
            return {
              _tag: "fatal" as const,
              detail:
                `${member.entry.branch} has failed the gate after ${String(repair.attempts)} repair ` +
                `attempts and is not converging; stopping instead of opening another. ` +
                `Last failure: ${gateDiagnosis(gate.output, gate.outputPath)}`,
              queueLength: activeEntries(snapshot.entries).length,
            };
          }
          parked += 1;
          continue;
        }
      }

      // Land: fast-forward every repo the batch touched, then push each
      // (`skills/cook-epic/run-legacy.sh:2990-3034`). One fast-forward carries
      // the whole batch — the integration branch already holds every member's
      // merge, and it is the exact tree the gate just verified, so nothing
      // unverified can reach a base branch here. An owned base branch lands by
      // ref-only update (t3code-5m4): `repositoryPath` still has the operator's
      // own branch checked out, so a checkout-based merge there would advance
      // the wrong branch.
      /** How many entries stay queued if this landing fails partway. */
      const remaining = batch.length + batches.reduce((total, rest) => total + rest.length, 0);
      const batchCommits = batch.reduce((total, member) => total + member.commits, 0);
      const siblingTotals = snapshot.siblings.map((sibling, index) => ({
        sibling,
        ahead: batch.reduce(
          (total, member) => total + (member.siblingCommits[index]?.ahead ?? 0),
          0,
        ),
      }));
      if (batchCommits > 0) {
        const landed = yield* ports.git.fastForward({
          cwd: snapshot.repositoryPath,
          ref: snapshot.integrationBranch,
          ...(ownedBaseBranch ? { branch: snapshot.baseBranch } : {}),
        });
        if (!landed.landed) {
          yield* ports.store.restoreTail({
            runId: input.runId,
            fromSequence: batch[0]!.entry.sequence,
          });
          // `landed.output` carries the real cause — including the distinct
          // "refusing to fetch into branch ... checked out at ..." git raises
          // when the owned base branch is checked out somewhere (t3code-5m4)
          // — which "moved externally" alone does not describe.
          return {
            _tag: "fatal" as const,
            detail:
              `base branch ${snapshot.baseBranch} moved externally; cannot fast-forward — ` +
              `operator must reconcile${landed.output.length > 0 ? `: ${landed.output}` : ""}`,
            queueLength: remaining,
          };
        }
      }
      for (const { sibling, ahead } of siblingTotals) {
        if (ahead === 0) continue;
        const landed = yield* ports.git.fastForward({
          cwd: sibling.repositoryPath,
          ref: snapshot.integrationBranch,
        });
        if (!landed.landed) {
          yield* ports.store.restoreTail({
            runId: input.runId,
            fromSequence: batch[0]!.entry.sequence,
          });
          return {
            _tag: "fatal" as const,
            detail: `sibling ${sibling.repositoryPath} branch ${sibling.baseBranch} moved externally; cannot fast-forward — operator must reconcile`,
            queueLength: remaining,
          };
        }
      }
      if (input.pushEnabled) {
        if (batchCommits > 0) {
          const pushed = yield* ports.git.push({
            cwd: snapshot.repositoryPath,
            remote: "origin",
            refspec: snapshot.baseBranch,
          });
          if (!pushed.pushed) {
            yield* ports.store.restoreTail({
              runId: input.runId,
              fromSequence: batch[0]!.entry.sequence,
            });
            return {
              _tag: "fatal" as const,
              detail: `push of ${snapshot.baseBranch} rejected (remote moved?); operator must reconcile`,
              queueLength: remaining,
            };
          }
        }
        for (const { sibling, ahead } of siblingTotals) {
          if (ahead === 0) continue;
          const pushed = yield* ports.git.push({
            cwd: sibling.repositoryPath,
            remote: "origin",
            refspec: sibling.baseBranch,
          });
          if (!pushed.pushed) {
            yield* ports.store.restoreTail({
              runId: input.runId,
              fromSequence: batch[0]!.entry.sequence,
            });
            return {
              _tag: "fatal" as const,
              detail: `push of sibling ${sibling.repositoryPath} branch ${sibling.baseBranch} rejected (remote moved?); operator must reconcile`,
              queueLength: remaining,
            };
          }
        }
      }

      // Record the new head for the main repo and every sibling, even siblings
      // without commits (`skills/cook-epic/run-legacy.sh:3035-3048`). Every
      // member of the batch landed at this one head, because that is the tree
      // the gate verified.
      const head = yield* ports.git.head(
        snapshot.repositoryPath,
        ownedBaseBranch ? snapshot.baseBranch : undefined,
      );
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
      const landing = landingDescription({
        pushEnabled: input.pushEnabled,
        verified: input.verified,
      });
      // Settle the members in queue order: the batch landed as one commit
      // range, but each child's completion, event and fold are its own.
      for (const member of batch) {
        yield* ports.store.complete({
          runId: input.runId,
          sequence: member.entry.sequence,
          lastAcceptedHead: head,
          ...(snapshot.siblings.length > 0 ? { siblingHeads } : {}),
        });
        yield* ports.events.emit({
          event: "merged",
          child: member.entry.childId,
          branch: member.entry.branch,
          commit: head.slice(0, 12),
          landing,
          repositories: [
            ...(member.commits > 0
              ? [{ repo: snapshot.repositoryPath, commits: member.commits, head }]
              : []),
            ...member.siblingCommits
              .filter(({ ahead }) => ahead > 0)
              .map(({ sibling, ahead }) => ({
                repo: sibling.repositoryPath,
                commits: ahead,
                head:
                  siblingHeads.find(
                    (recorded) => recorded.repositoryPath === sibling.repositoryPath,
                  )?.lastAcceptedHead ?? "",
              })),
          ],
        });
        yield* ports.fold.run(member.entry.childId);
        yield* ports.git
          .deleteLocalBranch(snapshot.repositoryPath, member.entry.branch)
          .pipe(Effect.catch(() => Effect.void));
        for (const sibling of snapshot.siblings) {
          yield* ports.git
            .deleteLocalBranch(sibling.repositoryPath, member.entry.branch)
            .pipe(Effect.catch(() => Effect.void));
        }
        if (input.pushEnabled) {
          yield* ports.git
            .deleteRemoteBranch(snapshot.repositoryPath, "origin", member.entry.branch)
            .pipe(Effect.catch(() => Effect.void));
        }
        merged += 1;
      }
      // The base moved, so whatever the control gate proved about it was
      // proved about a different tree.
      baseVerified = false;
    }

    return { _tag: "drained" as const, merged, parked };
  }).pipe(Effect.ensuring(ports.slot.release(input.holder).pipe(Effect.ignore)));
});
