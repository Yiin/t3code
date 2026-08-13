import { describe, expect, it } from "@effect/vitest";
import { NonNegativeInt, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { RunJournalError, type PersistedEpicRunIteration } from "./ports/RunJournal.ts";

import { drainMergeQueue, type DrainMergeQueueResult, type MergeQueuePorts } from "./MergeQueue.ts";
import { GateError, gateCommandDigest, type GateReceipt } from "./ports/Gate.ts";
import type { PersistedGateReceipt } from "./ports/GateReceipts.ts";
import { BacklogError, type BacklogIssue } from "./ports/Backlog.ts";
import {
  integrationFixTitle,
  landingDescription,
  mergeFixDescription,
  mergeFixTitle,
  parseMergeFixTitle,
  runBaseBranch,
} from "./policy.ts";
import { MergeQueuePortError } from "./ports/MergeQueue.ts";
import type {
  MergeGitShape,
  MergeQueueEntry,
  MergeQueueSnapshot,
  MergeQueueStoreShape,
} from "./ports/MergeQueue.ts";

/** A receipt shaped like the one `ProcessGate` measures, with fixed stamps. */
const fakeReceipt = (input: {
  readonly passed: boolean;
  readonly output: string;
  readonly outputPath?: string;
}): GateReceipt => ({
  commandDigest: gateCommandDigest("gate"),
  cwd: "/worktrees/integration",
  outcome: input.passed ? "passed" : "failed",
  exitCode: input.passed ? 0 : 1,
  queuedAt: "2026-08-13T00:00:00.000Z",
  acquiredAt: "2026-08-13T00:00:01.000Z",
  finishedAt: "2026-08-13T00:00:04.000Z",
  lockWaitMs: 1_000,
  executionMs: 3_000,
  inputHeads: [{ repositoryPath: "/repo", head: "head-1" }],
  output: input.output,
  ...(input.outputPath === undefined ? {} : { outputPath: input.outputPath }),
});

const baseSnapshot = (entries: ReadonlyArray<MergeQueueEntry>): MergeQueueSnapshot => ({
  runId: "run-1",
  lastAcceptedHead: "base-0",
  repositoryPath: "/repo",
  baseBranch: "mine",
  integrationBranch: "cook-epic-integration-run-1",
  integrationWorktreePath: "/worktrees/integration",
  operatorBaseBranch: null,
  siblings: [],
  entries,
});

const entry = (sequence: number, childId: string, branch = `epic/${childId}`): MergeQueueEntry => ({
  sequence,
  childId,
  branch,
  status: "queued",
  reason: null,
  fixIssueId: null,
});

const makeHarness = (
  options: {
    readonly entries?: ReadonlyArray<MergeQueueEntry>;
    readonly currentHead?: string;
    readonly slotHeld?: boolean;
    readonly conflicts?: ReadonlyArray<string>;
    readonly conflictCwds?: ReadonlyArray<string>;
    /** Branches that conflict in every sibling worktree but merge in the main one. */
    readonly siblingConflicts?: ReadonlyArray<string>;
    readonly gatePasses?: boolean;
    /**
     * Branches that make the gate red whenever one of them is in the trial
     * merge — the batch equivalent of `gatePasses: false`, and the only way to
     * model a batch that is red because of one member.
     */
    readonly gateRedBranches?: ReadonlyArray<string>;
    /** Per-call gate answers: [merge set, control on base, …]. */
    readonly gateSequence?: ReadonlyArray<boolean>;
    /**
     * The files each branch changes, keyed by branch and reported in every
     * repository the set touches. Defaults to one file named after the branch,
     * so unrelated branches are disjoint unless a test says otherwise.
     */
    readonly files?: Readonly<Record<string, ReadonlyArray<string>>>;
    /** Branches whose file footprint git refuses to report. */
    readonly changedFilesFails?: ReadonlyArray<string>;
    readonly gateOutput?: string;
    /** Per-call gate output, for a control that differs from the merge set. */
    readonly gateOutputSequence?: ReadonlyArray<string>;
    /** Where the gate adapter persisted the full output (t3code-9hv). */
    readonly gateOutputPath?: string;
    /** Whether the dependency repair reports success; defaults to true. */
    readonly repairRestores?: boolean;
    readonly fastForwardFails?: ReadonlyArray<string>;
    readonly fastForwardFailCwds?: ReadonlyArray<string>;
    readonly pushFails?: ReadonlyArray<string>;
    readonly empty?: ReadonlyArray<string>;
    readonly siblings?: ReadonlyArray<{
      readonly repositoryPath: string;
      readonly baseBranch: string;
      readonly integrationWorktreePath: string;
      readonly lastAcceptedHead: string;
    }>;
    /** Ahead count per sibling repository path; defaults to 1. */
    readonly siblingAhead?: Readonly<Record<string, number>>;
    /** Move a sibling checkout's head before the drain (external movement). */
    readonly siblingExternalHeads?: Readonly<Record<string, string>>;
    readonly createFailure?: "before" | "after";
    readonly existingFixStatuses?: ReadonlyArray<string>;
    /** Overrides the main repository's base branch (default `"mine"`). */
    readonly baseBranch?: string;
    /** The operator's branch this run continuously integrates (t3code-sha); defaults to `null`. */
    readonly operatorBaseBranch?: string | null;
    /** Existing integration-fix children (t3code-sha), reusing `existingFixStatuses`' shape. */
    readonly existingIntegrationFixStatuses?: ReadonlyArray<string>;
    /** Make the conflict-detail read fail the way an unreadable worktree does. */
    readonly conflictDetailUnreadable?: boolean;
    /**
     * What each child's worker reported, keyed by child id. A child absent
     * here has no completed iteration at all, which is how a run that never
     * recorded a summary looks (t3code-2jh.5).
     */
    readonly reports?: Readonly<
      Record<string, { readonly summary: string | null; readonly why: string | null }>
    >;
    /** Merge-commit subjects `git log <branch>..<baseBranch>` reports, newest first. */
    readonly landedSubjects?: ReadonlyArray<string>;
    /** Make the landed-subject read fail the way an unreadable repository does. */
    readonly landedSubjectsUnreadable?: boolean;
    /** Make the iteration lookup fail the way an unreachable journal does. */
    readonly iterationsUnreadable?: boolean;
  } = {},
) => {
  const siblings = options.siblings ?? [];
  let snapshot: MergeQueueSnapshot = {
    ...baseSnapshot(options.entries ?? [entry(0, "child-1")]),
    ...(options.baseBranch === undefined ? {} : { baseBranch: options.baseBranch }),
    operatorBaseBranch: options.operatorBaseBranch ?? null,
    siblings,
  };
  const heads: Record<string, string> = { "/repo": options.currentHead ?? "base-0" };
  for (const sibling of siblings) {
    heads[sibling.repositoryPath] =
      options.siblingExternalHeads?.[sibling.repositoryPath] ?? sibling.lastAcceptedHead;
  }
  const calls: string[] = [];
  const gateReceipts: Array<PersistedGateReceipt> = [];
  const events: unknown[] = [];
  const notes: string[] = [];
  const fixes: string[] = [];
  const completions: Array<Parameters<MergeQueueStoreShape["complete"]>[0]> = [];
  const gateRepositories: Array<{
    readonly repositoryPath: string;
    readonly baseBranch: string;
    readonly worktreeRoot: string;
    readonly siblings: ReadonlyArray<{
      readonly repositoryPath: string;
      readonly baseBranch: string;
      readonly worktreeRoot: string;
    }>;
  }> = [];
  const children: BacklogIssue[] = [
    ...(options.existingFixStatuses ?? []).map(
      (status, index): BacklogIssue => ({
        id: `existing-${index + 1}`,
        title: mergeFixTitle("epic/child-1", "conflict"),
        status,
        priority: 1,
        issueType: "task",
        parentId: "epic-1",
        description: "existing",
        labels: [],
        commentCount: 0,
      }),
    ),
    ...(options.existingIntegrationFixStatuses ?? []).map(
      (status, index): BacklogIssue => ({
        id: `existing-integration-${index + 1}`,
        title: integrationFixTitle(snapshot.baseBranch, options.operatorBaseBranch ?? ""),
        status,
        priority: 1,
        issueType: "task",
        parentId: "epic-1",
        description: "existing",
        labels: [],
        commentCount: 0,
      }),
    ),
  ];
  let createFailed = false;
  let gateCall = 0;
  /**
   * The branches currently trial-merged into the main integration worktree.
   *
   * A batch gate's verdict depends on what is merged, not on how many gates
   * ran before it, so a positional `gateSequence` cannot express it.
   */
  let mergedInWorktree: ReadonlyArray<string> = [];

  const git: MergeGitShape = {
    head: (cwd, ref) =>
      Effect.sync(() => {
        calls.push(ref === undefined ? `head:${cwd}` : `head:${cwd}:${ref}`);
        return heads[cwd] ?? "base-0";
      }),
    commitsAhead: ({ repositoryPath, branch }) =>
      Effect.sync(() => {
        calls.push(
          repositoryPath === "/repo" ? `ahead:${branch}` : `ahead:${repositoryPath}:${branch}`,
        );
        if (repositoryPath !== "/repo") {
          return options.siblingAhead?.[repositoryPath] ?? 1;
        }
        return options.empty?.includes(branch) === true ? 0 : 1;
      }),
    changedFiles: ({ repositoryPath, branch }) =>
      Effect.gen(function* () {
        calls.push(
          repositoryPath === "/repo" ? `changed:${branch}` : `changed:${repositoryPath}:${branch}`,
        );
        if (options.changedFilesFails?.includes(branch) === true) {
          return yield* new MergeQueuePortError({
            operation: "changedFiles",
            detail: "git diff failed",
          });
        }
        return options.files?.[branch] ?? [`${branch}.ts`];
      }),
    resetHard: (cwd, ref) =>
      Effect.sync(() => {
        calls.push(`reset:${cwd}:${ref}`);
        // Only a reset back to the base branch empties the worktree; a reset
        // to a recorded commit rolls back exactly one member's merge.
        if (cwd === "/worktrees/integration") {
          mergedInWorktree = ref === snapshot.baseBranch ? [] : mergedInWorktree.slice(0, -1);
          heads[cwd] = ref;
        }
      }),
    clean: (cwd) => Effect.sync(() => void calls.push(`clean:${cwd}`)),
    setupWorktree: (cwd) => Effect.sync(() => void calls.push(`setup:${cwd}`)),
    trialMerge: ({ cwd, branch, message }) =>
      Effect.sync(() => {
        calls.push(
          cwd === "/worktrees/integration"
            ? `merge:${branch}:${message}`
            : `merge:${cwd}:${branch}:${message}`,
        );
        const merged =
          options.conflicts?.includes(branch) !== true &&
          options.conflictCwds?.includes(cwd) !== true &&
          !(
            cwd !== "/worktrees/integration" && options.siblingConflicts?.includes(branch) === true
          );
        if (merged && cwd === "/worktrees/integration") {
          mergedInWorktree = [...mergedInWorktree, branch];
          heads[cwd] = `merged-${String(mergedInWorktree.length)}`;
        }
        return { merged, output: "trial" };
      }),
    conflictDetail: ({ cwd }) =>
      Effect.sync(() => {
        calls.push(`conflict-detail:${cwd}`);
        if (options.conflictDetailUnreadable === true) return null;
        return {
          files: [`${cwd === "/worktrees/integration" ? "main" : "sibling"}-conflict.ts`],
          diff: `<<<<<<< HEAD in ${cwd}`,
        };
      }),
    landedSubjects: ({ repositoryPath, branch, limit }) =>
      Effect.sync(() => {
        calls.push(`landed:${branch}:${String(limit)}`);
        if (options.landedSubjectsUnreadable === true || repositoryPath !== "/repo") return null;
        return options.landedSubjects ?? [];
      }),
    abortMerge: (cwd) => Effect.sync(() => void calls.push(`abort:${cwd}`)),
    fastForward: ({ cwd, ref, branch }) =>
      Effect.sync(() => {
        const label = cwd === "/repo" ? `ff:${ref}` : `ff:${cwd}:${ref}`;
        calls.push(branch === undefined ? label : `${label}:owned:${branch}`);
        if (
          options.fastForwardFails?.includes(ref) === true ||
          options.fastForwardFailCwds?.includes(cwd) === true
        ) {
          return { landed: false, output: "non-fast-forward" };
        }
        heads[cwd] = `landed-${String(calls.filter((call) => call.startsWith("ff:")).length)}`;
        return { landed: true, output: "" };
      }),
    push: ({ cwd, refspec }) =>
      Effect.sync(() => {
        calls.push(cwd === "/repo" ? `push:${refspec}` : `push:${cwd}:${refspec}`);
        return {
          pushed:
            options.pushFails?.includes(refspec) !== true &&
            options.pushFails?.includes(`${cwd}:${refspec}`) !== true,
          output: "",
        };
      }),
    deleteLocalBranch: (cwd, branch) =>
      Effect.sync(
        () =>
          void calls.push(
            cwd === "/repo" ? `delete-local:${branch}` : `delete-local:${cwd}:${branch}`,
          ),
      ),
    deleteRemoteBranch: (_cwd, _remote, branch) =>
      Effect.sync(() => void calls.push(`delete-remote:${branch}`)),
  };

  const ports: MergeQueuePorts = {
    git,
    slot: {
      tryAcquire: (holder) =>
        Effect.sync(() => {
          calls.push(`slot-acquire:${holder}`);
          return options.slotHeld === true ? Option.none() : Option.some({ holder });
        }),
      release: (holder) => Effect.sync(() => void calls.push(`slot-release:${holder}`)),
      reclaim: (holder) =>
        Effect.sync(() => {
          calls.push(`slot-reclaim:${holder}`);
          return { reclaimed: false };
        }),
      holder: Effect.sync(() => {
        calls.push("slot-holder");
        return options.slotHeld === true ? Option.some("cook-epic-run-0") : Option.none();
      }),
    },
    store: {
      read: () => Effect.succeed(snapshot),
      beginDrain: () =>
        Effect.sync(() => {
          calls.push("begin-drain");
          const active = snapshot.entries
            .filter((item) => item.status === "queued" || item.status === "draining")
            .map((item) => ({ ...item, status: "draining" as const }));
          snapshot = { ...snapshot, entries: active };
          return active;
        }),
      enqueue: ({ childId, branch }) =>
        Effect.sync(() => {
          const sequence = Math.max(-1, ...snapshot.entries.map((item) => item.sequence)) + 1;
          snapshot = {
            ...snapshot,
            entries: [...snapshot.entries, entry(sequence, childId, branch)],
          };
        }),
      restoreTail: ({ fromSequence }) =>
        Effect.sync(() => {
          calls.push(`restore:${fromSequence}`);
          snapshot = {
            ...snapshot,
            entries: snapshot.entries.map((item) =>
              item.sequence >= fromSequence && item.status === "draining"
                ? { ...item, status: "queued" as const }
                : item,
            ),
          };
        }),
      advanceIntegration: ({ lastAcceptedHead }) =>
        Effect.sync(() => {
          calls.push(`advance-integration:${lastAcceptedHead}`);
          snapshot = { ...snapshot, lastAcceptedHead };
        }),
      beginPark: ({ sequence, reason }) =>
        Effect.sync(() => {
          snapshot = {
            ...snapshot,
            entries: snapshot.entries.map((item) =>
              item.sequence === sequence
                ? { ...item, status: "parked" as const, reason, fixIssueId: null }
                : item,
            ),
          };
        }),
      finalizePark: ({ sequence, fixIssueId }) =>
        Effect.sync(() => {
          snapshot = {
            ...snapshot,
            entries: snapshot.entries.map((item) =>
              item.sequence === sequence ? { ...item, fixIssueId } : item,
            ),
          };
        }),
      complete: (input) =>
        Effect.sync(() => {
          completions.push(input);
          snapshot = {
            ...snapshot,
            lastAcceptedHead: input.lastAcceptedHead,
            entries: snapshot.entries.filter((item) => item.sequence !== input.sequence),
          };
        }),
      drop: ({ sequence }) =>
        Effect.sync(() => {
          calls.push(`drop:${sequence}`);
          snapshot = {
            ...snapshot,
            entries: snapshot.entries.filter((item) => item.sequence !== sequence),
          };
        }),
      parkedOriginalChild: (_runId, branch) =>
        Effect.succeed(
          Option.fromNullishOr(
            snapshot.entries.find((item) => item.branch === branch && item.status === "parked")
              ?.childId,
          ),
        ),
    },
    gate: {
      run: (gateInput) =>
        Effect.sync(() => {
          calls.push("gate");
          gateRepositories.push(...gateInput.repositories);
          // A red gate is followed by a control run on the base with nothing
          // merged, so tests need to answer the two calls differently:
          // [set, control]. Without a sequence every call answers the same.
          const sequenced = options.gateSequence?.[gateCall];
          const sequencedOutput = options.gateOutputSequence?.[gateCall];
          gateCall += 1;
          const redMember = options.gateRedBranches?.some((branch) =>
            mergedInWorktree.includes(branch),
          );
          const passed = redMember === true ? false : (sequenced ?? options.gatePasses ?? true);
          const output = sequencedOutput ?? options.gateOutput ?? "";
          return {
            passed,
            repositoryPaths: ["/repo"],
            output,
            ...(options.gateOutputPath === undefined ? {} : { outputPath: options.gateOutputPath }),
            receipt: fakeReceipt({
              passed,
              output,
              ...(options.gateOutputPath === undefined
                ? {}
                : { outputPath: options.gateOutputPath }),
            }),
          };
        }),
    },
    gateReceipts: {
      record: (receipt) => Effect.sync(() => void gateReceipts.push(receipt)),
      list: (runId) => Effect.succeed(gateReceipts.filter((receipt) => receipt.runId === runId)),
    },
    repair: {
      restoreDependencies: ({ worktrees }) =>
        Effect.sync(() => {
          calls.push(`repair:${worktrees.join(",")}`);
          const restored = options.repairRestores ?? true;
          return {
            restored,
            detail: restored ? "install completed" : "install failed: lockfile is out of date",
          };
        }),
    },
    backlog: {
      listChildren: () => Effect.succeed(children),
      createChild: ({ title, description }) =>
        Effect.gen(function* () {
          if (options.createFailure === "before" && !createFailed) {
            createFailed = true;
            return yield* new BacklogError({
              operation: "createChild",
              detail: "injected failure before create",
            });
          }
          fixes.push(`${title}\n${description}`);
          const created = {
            id: `fix-${fixes.length}`,
            title,
            status: "open",
            priority: 1,
            issueType: "task",
            parentId: "epic-1",
            description,
            labels: [],
            commentCount: 0,
          };
          children.push(created);
          if (options.createFailure === "after" && !createFailed) {
            createFailed = true;
            return yield* new BacklogError({
              operation: "createChild",
              detail: "injected crash after create",
            });
          }
          return created;
        }),
      writeNotes: ({ note }) => Effect.sync(() => void notes.push(note)),
    },
    iterations: {
      listIterations: (runId) =>
        Effect.gen(function* () {
          calls.push(`iterations:${runId}`);
          if (options.iterationsUnreadable === true) {
            return yield* new RunJournalError({
              operation: "listIterations",
              detail: "journal unreachable",
            });
          }
          return Object.entries(options.reports ?? {}).map(
            ([childId, report], index): PersistedEpicRunIteration => ({
              runId,
              iterationIndex: NonNegativeInt.make(index),
              threadId: ThreadId.make(`thread-${childId}`),
              issueId: childId,
              turnStatus: "completed",
              summary: report.summary,
              why: report.why,
              failureReason: null,
              startedAt: "2026-08-13T00:00:00.000Z",
              finishedAt: "2026-08-13T00:10:00.000Z",
            }),
          );
        }),
    },
    events: { emit: (event) => Effect.sync(() => void events.push(event)) },
    fold: { run: (childId) => Effect.sync(() => void calls.push(`fold:${childId}`)) },
  };

  return {
    ports,
    calls,
    events,
    fixes,
    notes,
    completions,
    gateRepositories,
    gateReceipts,
    heads: () => heads,
    snapshot: () => snapshot,
  };
};

const drain = (
  ports: MergeQueuePorts,
  overrides: Partial<Parameters<typeof drainMergeQueue>[0]> = {},
) =>
  drainMergeQueue(
    {
      runId: "run-1",
      epicId: "epic-1",
      holder: "cook-epic-run-1",
      gateCommand: "vp check",
      pushEnabled: true,
      verified: true,
      maxGateOutputBytes: 1024,
      ...overrides,
    },
    ports,
  );

describe("MergeQueue", () => {
  it.effect("lands a clean branch and fast-forwards before push", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      expect(yield* drain(harness.ports)).toEqual({ _tag: "drained", merged: 1, parked: 0 });
      expect(harness.calls).toEqual([
        "head:/repo",
        "slot-acquire:cook-epic-run-1",
        "begin-drain",
        "ahead:epic/child-1",
        "reset:/worktrees/integration:mine",
        "clean:/worktrees/integration",
        "setup:/worktrees/integration",
        "merge:epic/child-1:cook-epic: merge epic/child-1 (child-1)",
        "gate",
        "ff:cook-epic-integration-run-1",
        "push:mine",
        "head:/repo",
        "fold:child-1",
        "delete-local:epic/child-1",
        "delete-remote:epic/child-1",
        "slot-release:cook-epic-run-1",
      ]);
      expect(harness.events).toEqual([
        {
          event: "merged",
          child: "child-1",
          branch: "epic/child-1",
          commit: "landed-1",
          landing: "gated, pushed, landed",
          repositories: [{ repo: "/repo", commits: 1, head: "landed-1" }],
        },
      ]);
    }),
  );

  it.effect("parks a conflict without touching the base", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ conflicts: ["epic/child-1"] });
      expect(yield* drain(harness.ports)).toEqual({ _tag: "drained", merged: 0, parked: 1 });
      expect(harness.calls).toContain("abort:/worktrees/integration");
      expect(harness.calls.some((call) => call.startsWith("ff:"))).toBe(false);
      expect(harness.fixes[0]).toContain("Merge fix: land epic/child-1 (conflict)");
      expect(harness.snapshot().entries[0]).toMatchObject({
        status: "parked",
        reason: "conflict",
        fixIssueId: "fix-1",
      });
    }),
  );

  /**
   * The abort destroys the unmerged index, so a park that reads the conflict
   * afterwards reads nothing. The order here is the whole point of the test.
   */
  it.effect("hands the conflict's repo, output and files to the merge-fix child", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ conflicts: ["epic/child-1"] });
      yield* drain(harness.ports);
      expect(harness.calls.indexOf("conflict-detail:/worktrees/integration")).toBeLessThan(
        harness.calls.indexOf("abort:/worktrees/integration"),
      );
      const description = harness.fixes[0] ?? "";
      expect(description).toContain("What the conflict looked like:");
      expect(description).toContain("    Conflict in `/repo`:");
      expect(description).toContain("    trial");
      expect(description).toContain("    - main-conflict.ts");
      expect(description).toContain("    <<<<<<< HEAD in /worktrees/integration");
    }),
  );

  it.effect("still names the conflicting repo when the worktree cannot be read", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        conflicts: ["epic/child-1"],
        conflictDetailUnreadable: true,
      });
      yield* drain(harness.ports);
      const description = harness.fixes[0] ?? "";
      expect(description).toContain("    Conflict in `/repo`:");
      expect(description).toContain("    trial");
      expect(description).not.toContain("Conflicted files:");
    }),
  );

  /**
   * A repair agent resolving someone else's conflict has to guess which side
   * meant what. Both sides already said so in their own `RALPH_MSG` line, so
   * the description quotes them instead (t3code-2jh.5).
   */
  describe("author context (t3code-2jh.5)", () => {
    it.effect("quotes the parked child's own report and every landed sibling's", () =>
      Effect.gen(function* () {
        const harness = makeHarness({
          conflicts: ["epic/child-1"],
          reports: {
            "child-1": { summary: "added a conflict probe", why: "conflicts were found late" },
            "child-2": { summary: "batched disjoint branches", why: "one gate per group" },
          },
          landedSubjects: [
            "cook-epic: merge epic/child-2 (child-2)",
            "chore: an operator commit nobody parsed",
          ],
        });
        yield* drain(harness.ports);
        const description = harness.fixes[0] ?? "";
        expect(description).toContain("    added a conflict probe");
        expect(description).toContain("    Why: conflicts were found late");
        expect(description).toContain(
          "    - `epic/child-2` (`child-2`): batched disjoint branches",
        );
        // A subject that names no child contributes nothing.
        expect(description).not.toContain("an operator commit");
        expect(harness.calls).toContain("landed:epic/child-1:10");
      }),
    );

    it.effect("skips a landed child the run journal never recorded", () =>
      Effect.gen(function* () {
        const harness = makeHarness({
          conflicts: ["epic/child-1"],
          reports: { "child-1": { summary: "added a conflict probe", why: null } },
          landedSubjects: ["cook-epic: merge epic/child-2 (child-2)"],
        });
        yield* drain(harness.ports);
        const description = harness.fixes[0] ?? "";
        expect(description).toContain("What the original author built:");
        expect(description).not.toContain("What landed on");
      }),
    );

    // Enrichment must never cost a park. Each lookup fails on its own here,
    // and the description degrades to exactly the one it had before.
    it.effect("parks normally when the iteration lookup fails", () =>
      Effect.gen(function* () {
        const harness = makeHarness({
          conflicts: ["epic/child-1"],
          iterationsUnreadable: true,
        });
        expect(yield* drain(harness.ports)).toEqual({ _tag: "drained", merged: 0, parked: 1 });
        const description = harness.fixes[0] ?? "";
        expect(description).toContain("What the conflict looked like:");
        expect(description).not.toContain("What the original author built:");
        expect(harness.snapshot().entries[0]).toMatchObject({ fixIssueId: "fix-1" });
      }),
    );

    it.effect("keeps the author section when only the landed-subject read fails", () =>
      Effect.gen(function* () {
        const harness = makeHarness({
          conflicts: ["epic/child-1"],
          reports: { "child-1": { summary: "added a conflict probe", why: null } },
          landedSubjectsUnreadable: true,
        });
        expect(yield* drain(harness.ports)).toEqual({ _tag: "drained", merged: 0, parked: 1 });
        const description = harness.fixes[0] ?? "";
        expect(description).toContain("    added a conflict probe");
        expect(description).not.toContain("What landed on");
      }),
    );

    // Reusing an open fix child writes no description, so it must not spend
    // the two reads either.
    it.effect("reads nothing when an open merge-fix child already exists", () =>
      Effect.gen(function* () {
        const harness = makeHarness({
          conflicts: ["epic/child-1"],
          existingFixStatuses: ["open"],
          reports: { "child-1": { summary: "added a conflict probe", why: null } },
        });
        yield* drain(harness.ports);
        expect(harness.fixes).toEqual([]);
        expect(harness.calls.some((call) => call.startsWith("landed:"))).toBe(false);
        expect(harness.calls.some((call) => call.startsWith("iterations:"))).toBe(false);
      }),
    );
  });

  /**
   * A run that lands or parks with no record of the gate it ran cannot
   * explain its own wall time or prove its verification. The receipt has to
   * land before the drain acts on the verdict, for every gate it runs.
   */
  it.effect("records a receipt for the entry gate, the control gate and the recheck", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        gatePasses: false,
        gateOutput: "Cannot find module 'vite-plus/binding'\n2 failed",
      });

      yield* drain(harness.ports);

      expect(harness.gateReceipts.map((entry) => entry.phase)).toEqual([
        "entry",
        "control",
        "recheck",
      ]);
      // Only the branch's own gate names a child; the control and the recheck
      // test the base with nothing merged, so naming one would blame it.
      expect(harness.gateReceipts.map((entry) => entry.childId)).toEqual(["child-1", null, null]);
      expect(harness.gateReceipts.every((entry) => entry.runId === "run-1")).toBe(true);
      expect(harness.gateReceipts[0]).toMatchObject({
        outcome: "failed",
        exitCode: 1,
        lockWaitMs: 1_000,
        executionMs: 3_000,
        inputHeads: [{ repositoryPath: "/repo", head: "head-1" }],
      });
      expect(harness.gateReceipts[0]?.output).toContain("vite-plus/binding");
    }),
  );

  it.effect("records a receipt for a gate the adapter never ran", () =>
    Effect.gen(function* () {
      const gateReceipts: Array<PersistedGateReceipt> = [];
      const harness = makeHarness({});
      const ports: MergeQueuePorts = {
        ...harness.ports,
        gate: {
          run: () =>
            Effect.fail(
              new GateError({
                operation: "lock",
                detail: "Could not take the shared gate lock within 900s",
              }),
            ),
        },
        gateReceipts: {
          record: (receipt) => Effect.sync(() => void gateReceipts.push(receipt)),
          list: () => Effect.succeed(gateReceipts),
        },
      };

      const error = yield* drain(ports).pipe(Effect.flip);

      // The failure is re-raised unchanged, but the two hours it may have
      // cost are on the record either way.
      expect(error.operation).toBe("lock");
      expect(gateReceipts).toHaveLength(1);
      expect(gateReceipts[0]).toMatchObject({
        phase: "entry",
        outcome: "error",
        exitCode: null,
        // Nothing ran, so nothing was tested: no head may be claimed.
        inputHeads: [],
      });
      expect(gateReceipts[0]?.output).toContain("Could not take the shared gate lock");
    }),
  );

  it.effect("blames the environment, not the branch, when the base fails the same gate", () =>
    Effect.gen(function* () {
      // Regression: a broken toolchain fails every gate. Attributing that to
      // the branch parked innocent work and opened repair child after repair
      // child — 15 of them in one run — while the real fault was a missing
      // native binding no branch had touched.
      const harness = makeHarness({
        gatePasses: false,
        gateOutput: "Cannot find module 'vite-plus/binding'\n2 failed",
      });

      const result: DrainMergeQueueResult = yield* drain(harness.ports);

      expect(result._tag).toBe("fatal");
      expect(result._tag === "fatal" ? result.detail : "").toContain("nothing merged");
      expect(result._tag === "fatal" ? result.detail : "").toContain("vite-plus/binding");
      // Nothing was blamed and no repair child was opened. A missing binding
      // is mechanically repairable, so the drain does try the install first —
      // and still refuses to blame the branch when it does not help.
      expect(harness.fixes).toHaveLength(0);
      expect(harness.calls).toContain("repair:/worktrees/integration");
    }),
  );

  it.effect("stops fast, without a repair, on an environment fault no install can fix", () =>
    Effect.gen(function* () {
      // The bound that matters is the one on guessing. A fault an install does
      // not understand costs a full install plus a full gate to learn nothing.
      const harness = makeHarness({
        gatePasses: false,
        gateOutput: "Error: expected 3 to equal 4\n2 failed",
      });

      const result: DrainMergeQueueResult = yield* drain(harness.ports);

      expect(result._tag).toBe("fatal");
      expect(result._tag === "fatal" ? result.detail : "").toContain("nothing merged");
      expect(harness.calls.some((call) => call.startsWith("repair:"))).toBe(false);
      expect(harness.calls.filter((call) => call === "gate")).toHaveLength(2);
      expect(harness.fixes).toHaveLength(0);
    }),
  );

  it.effect("never names a passing test line as the gate failure cause", () =>
    Effect.gen(function* () {
      // Regression (t3code-9hv): two epic runs for t3code-vzb reported this
      // exact line as the failure cause. It is a PASSING test in
      // packages/effect-acp/src/protocol.test.ts whose name merely contains
      // the word "error" — the old signal branch matched on that word.
      const harness = makeHarness({
        gatePasses: false,
        gateOutput:
          "✓ does not emit a second process-exit error after a decode failure 1029ms\n2 failed",
      });

      const result: DrainMergeQueueResult = yield* drain(harness.ports);

      expect(result._tag).toBe("fatal");
      const detail = result._tag === "fatal" ? result.detail : "";
      expect(detail).not.toContain("✓");
      expect(detail).toContain("no failure line found in gate output");
      expect(harness.calls.some((call) => call.startsWith("repair:"))).toBe(false);
      expect(harness.fixes).toHaveLength(0);
    }),
  );

  it.effect("diagnoses the vitest failure entry, not the interleaved passing tail", () =>
    Effect.gen(function* () {
      // Gate packages run with --concurrency-limit 2, so the output
      // interleaves and the last flushed line is often a ✓ line from a
      // package that passed. The diagnosis must come from the FAIL entries
      // or the "Test Files N failed" summary, never the bare last line.
      const harness = makeHarness({
        gatePasses: false,
        gateOutput: [
          "✓ packages/y/src/c.test.ts > passes 12ms",
          " FAIL  packages/x/src/a.test.ts > b",
          " Test Files  1 failed | 1 passed (2)",
          "✓ packages/y/src/c.test.ts > also passes 8ms",
        ].join("\n"),
      });

      const result: DrainMergeQueueResult = yield* drain(harness.ports);

      expect(result._tag).toBe("fatal");
      const detail = result._tag === "fatal" ? result.detail : "";
      expect(detail).toContain("FAIL  packages/x/src/a.test.ts > b");
      expect(detail).not.toContain("✓");
    }),
  );

  it.effect("points at the persisted full gate log in the diagnosis", () =>
    Effect.gen(function* () {
      // The bounded output can lose the failure entirely (t3code-9hv); the
      // adapter keeps the full log and the diagnosis must carry its path.
      // ANSI color around the pass marker must not hide it either — vitest
      // wraps ✓ in green.
      const harness = makeHarness({
        gatePasses: false,
        gateOutput: "\x1b[32m✓\x1b[39m passes 5ms\n2 failed",
        gateOutputPath: "/repo/.git/t3code/epic-runs/run-1/gate-1.log",
      });

      const result: DrainMergeQueueResult = yield* drain(harness.ports);

      expect(result._tag).toBe("fatal");
      const detail = result._tag === "fatal" ? result.detail : "";
      expect(detail).not.toContain("✓");
      expect(detail).toContain("full gate log: /repo/.git/t3code/epic-runs/run-1/gate-1.log");
    }),
  );

  it.effect("recovers from a broken integration worktree and re-gates the branch on merit", () =>
    Effect.gen(function* () {
      // Run 14064278 died here: the integration worktree had no dependencies
      // for one workspace package, every gate failed, and the runner could
      // only report that the environment was broken.
      const harness = makeHarness({
        siblings: [
          {
            repositoryPath: "/sib",
            baseBranch: "sib-main",
            integrationWorktreePath: "/worktrees/integ-sib",
            lastAcceptedHead: "sib-0",
          },
        ],
        // [set, control, control after the repair, set again].
        gateSequence: [false, false, true, true],
        gateOutputSequence: [
          "2 failed",
          "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'effect' imported from /worktrees/integration/oxlint-plugin-t3code/rules/x.ts",
          "",
          "",
        ],
      });

      expect(yield* drain(harness.ports)).toEqual({ _tag: "drained", merged: 1, parked: 0 });
      // Every integration worktree is repaired, and only those.
      expect(harness.calls.filter((call) => call.startsWith("repair:"))).toEqual([
        "repair:/worktrees/integration,/worktrees/integ-sib",
      ]);
      // The branch landed on a gate run after the repair, never on the red one
      // measured in the broken worktree.
      expect(harness.calls.filter((call) => call === "gate")).toHaveLength(4);
      expect(harness.fixes).toHaveLength(0);
      expect(harness.events.slice(0, 2)).toEqual([
        {
          event: "remediating",
          branch: "epic/child-1",
          worktrees: ["/worktrees/integration", "/worktrees/integ-sib"],
          signature:
            "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'effect' imported from /worktrees/integration/oxlint-plugin-t3code/rules/x.ts",
        },
        {
          event: "remediated",
          branch: "epic/child-1",
          worktrees: ["/worktrees/integration", "/worktrees/integ-sib"],
          signature:
            "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'effect' imported from /worktrees/integration/oxlint-plugin-t3code/rules/x.ts",
          recovered: true,
          detail: "install completed",
        },
      ]);
      expect(harness.notes[0]).toContain("gate recovered");
    }),
  );

  for (const repairRestores of [true, false]) {
    it.effect(
      `fails with a diagnosis naming the fault and the attempted repair (install ${
        repairRestores ? "ran" : "failed"
      })`,
      () =>
        Effect.gen(function* () {
          const harness = makeHarness({
            gateSequence: [false, false, false],
            gateOutputSequence: [
              "2 failed",
              "Cannot find native binding for rolldown",
              "Cannot find native binding for rolldown",
            ],
            repairRestores,
          });

          const result: DrainMergeQueueResult = yield* drain(harness.ports);

          expect(result._tag).toBe("fatal");
          const detail = result._tag === "fatal" ? result.detail : "";
          // Both halves of the story: what failed, and that a repair was tried.
          expect(detail).toContain("Cannot find native binding for rolldown");
          expect(detail).toContain(
            "restoring the integration worktree dependencies did not fix it",
          );
          if (!repairRestores) expect(detail).toContain("lockfile is out of date");
          // A failed install is never worth a gate.
          expect(harness.calls.filter((call) => call === "gate")).toHaveLength(
            repairRestores ? 3 : 2,
          );
          expect(harness.events.at(-1)).toMatchObject({ event: "remediated", recovered: false });
          expect(harness.notes[0]).toContain("gate still red");
          expect(harness.fixes).toHaveLength(0);
        }),
    );
  }

  it.effect("repairs at most once per drain, even when the same fault returns", () =>
    Effect.gen(function* () {
      // Unbounded self-healing is the failure mode this queue exists to
      // prevent: a repair loop keeps the run looking alive while it makes no
      // progress at all.
      const harness = makeHarness({
        // [set, control, control after repair, set again, control again].
        gateSequence: [false, false, true, false, false],
        gateOutputSequence: [
          "2 failed",
          "ERR_MODULE_NOT_FOUND: Cannot find package 'effect'",
          "",
          "2 failed",
          "ERR_MODULE_NOT_FOUND: Cannot find package 'effect'",
        ],
      });

      const result: DrainMergeQueueResult = yield* drain(harness.ports);

      expect(result._tag).toBe("fatal");
      expect(result._tag === "fatal" ? result.detail : "").toContain("not repeating it");
      expect(harness.calls.filter((call) => call.startsWith("repair:"))).toHaveLength(1);
      expect(harness.fixes).toHaveLength(0);
    }),
  );

  it.effect("stops opening repair children once repair stops converging", () =>
    Effect.gen(function* () {
      // Closed repairs count too: dedup alone only sees one still in flight,
      // so a closed-then-failed cycle looked new every time.
      const harness = makeHarness({
        gateSequence: [false, true],
        existingFixStatuses: ["closed", "closed", "closed"],
        entries: [entry(0, "child-1", "epic/child-1")],
        conflicts: ["epic/child-1"],
      });

      const result: DrainMergeQueueResult = yield* drain(harness.ports);

      expect(result._tag).toBe("fatal");
      expect(result._tag === "fatal" ? result.detail : "").toContain("repair attempts");
      expect(harness.fixes).toHaveLength(0);
    }),
  );

  it.effect("parks a red gate as gate-failed", () =>
    Effect.gen(function* () {
      // Set fails, control on the base passes: the branch really is at fault.
      const harness = makeHarness({ gateSequence: [false, true] });
      expect(yield* drain(harness.ports)).toEqual({ _tag: "drained", merged: 0, parked: 1 });
      expect(harness.calls.filter((call) => call.startsWith("reset:"))).toHaveLength(2);
      expect(harness.calls.some((call) => call.startsWith("ff:"))).toBe(false);
      expect(harness.snapshot().entries[0]).toMatchObject({
        status: "parked",
        reason: "gate-failed",
      });
    }),
  );

  for (const createFailure of ["before", "after"] as const) {
    it.effect(`reconciles a parked intent after a ${createFailure}-create failure`, () =>
      Effect.gen(function* () {
        const harness = makeHarness({
          conflicts: ["epic/child-1"],
          createFailure,
        });
        yield* Effect.flip(drain(harness.ports));
        expect(harness.snapshot().entries[0]).toMatchObject({
          status: "parked",
          reason: "conflict",
          fixIssueId: null,
        });

        expect(yield* drain(harness.ports)).toEqual({ _tag: "idle", queueLength: 0 });
        expect(harness.snapshot().entries[0]).toMatchObject({
          status: "parked",
          reason: "conflict",
          fixIssueId: "fix-1",
        });
        expect(harness.fixes).toHaveLength(1);
        expect(harness.notes).toHaveLength(1);
        expect(harness.events).toHaveLength(1);
      }),
    );
  }

  for (const activeStatus of ["open", "in_progress"] as const) {
    it.effect(`reuses only an exact-title ${activeStatus} merge-fix child`, () =>
      Effect.gen(function* () {
        const harness = makeHarness({
          entries: [
            {
              ...entry(0, "child-1"),
              status: "parked",
              reason: "conflict",
            },
          ],
          existingFixStatuses: ["closed", "blocked", activeStatus],
        });

        expect(yield* drain(harness.ports)).toEqual({ _tag: "idle", queueLength: 0 });
        expect(harness.snapshot().entries[0]?.fixIssueId).toBe("existing-3");
        expect(harness.fixes).toHaveLength(0);
      }),
    );
  }

  it.effect("creates a new merge-fix when exact-title matches are closed or blocked", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        entries: [
          {
            ...entry(0, "child-1"),
            status: "parked",
            reason: "conflict",
          },
        ],
        existingFixStatuses: ["closed", "blocked"],
      });

      expect(yield* drain(harness.ports)).toEqual({ _tag: "idle", queueLength: 0 });
      expect(harness.snapshot().entries[0]?.fixIssueId).toBe("fix-1");
      expect(harness.fixes).toHaveLength(1);
    }),
  );

  it.effect("freezes before slot acquisition when the base moved", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ currentHead: "external" });
      expect(yield* drain(harness.ports)).toMatchObject({ _tag: "fatal", queueLength: 1 });
      expect(harness.calls).toEqual(["head:/repo"]);
      expect(harness.snapshot().entries[0]?.status).toBe("queued");
    }),
  );

  it.effect("defers without draining when the merge slot is held", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ slotHeld: true });
      // The holder rides along with the deferral: a run that defers past its
      // stall window has to name who it deferred to.
      expect(yield* drain(harness.ports)).toEqual({
        _tag: "deferred",
        queueLength: 1,
        holder: "cook-epic-run-0",
      });
      expect(harness.calls).toEqual(["head:/repo", "slot-acquire:cook-epic-run-1", "slot-holder"]);
      expect(harness.snapshot().entries[0]?.status).toBe("queued");
    }),
  );

  it.effect("restores exactly the non-fast-forward tail and releases the slot", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        entries: [entry(0, "first"), entry(1, "second"), entry(2, "third")],
        fastForwardFails: ["cook-epic-integration-run-1"],
      });
      expect(yield* drain(harness.ports)).toMatchObject({ _tag: "fatal", queueLength: 3 });
      expect(harness.calls).toContain("restore:0");
      expect(harness.calls.at(-1)).toBe("slot-release:cook-epic-run-1");
      expect(harness.snapshot().entries.map((item) => item.status)).toEqual([
        "queued",
        "queued",
        "queued",
      ]);
    }),
  );

  it.effect("restores a rejected push tail and releases the slot", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ pushFails: ["mine"] });
      expect(yield* drain(harness.ports)).toMatchObject({ _tag: "fatal", queueLength: 1 });
      expect(harness.calls).toContain("restore:0");
      expect(harness.calls.at(-1)).toBe("slot-release:cook-epic-run-1");
    }),
  );

  it.effect("drops an empty branch and deletes it", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ empty: ["epic/child-1"] });
      expect(yield* drain(harness.ports)).toEqual({ _tag: "drained", merged: 0, parked: 0 });
      expect(harness.calls).toContain("drop:0");
      expect(harness.calls).toContain("delete-local:epic/child-1");
      expect(harness.calls.at(-1)).toBe("slot-release:cook-epic-run-1");
    }),
  );

  describe("multi-repo branch sets", () => {
    const siblingSet = (
      overrides: Partial<{
        readonly repositoryPath: string;
        readonly baseBranch: string;
        readonly integrationWorktreePath: string;
        readonly lastAcceptedHead: string;
      }> = {},
    ) => ({
      repositoryPath: "/sib",
      baseBranch: "sib-main",
      integrationWorktreePath: "/worktrees/integ-sib",
      lastAcceptedHead: "sib-0",
      ...overrides,
    });

    it.effect("stops fatally before the slot when a sibling moved externally", () =>
      Effect.gen(function* () {
        const harness = makeHarness({
          siblings: [siblingSet()],
          siblingExternalHeads: { "/sib": "sib-external" },
        });
        const result: DrainMergeQueueResult = yield* drain(harness.ports);
        expect(result).toMatchObject({
          _tag: "fatal",
          detail:
            "sibling /sib branch sib-main moved externally; cannot trial-merge — operator must reconcile",
        });
        expect(harness.calls).toEqual(["head:/repo", "head:/sib"]);
        expect(harness.snapshot().entries[0]?.status).toBe("queued");
      }),
    );

    it.effect("parks the whole set when a sibling conflicts, bases untouched", () =>
      Effect.gen(function* () {
        const harness = makeHarness({
          siblings: [siblingSet()],
          conflictCwds: ["/worktrees/integ-sib"],
        });
        expect(yield* drain(harness.ports)).toEqual({ _tag: "drained", merged: 0, parked: 1 });
        expect(harness.calls).toContain("abort:/worktrees/integ-sib");
        expect(harness.calls.some((call) => call.startsWith("ff:"))).toBe(false);
        expect(harness.calls.some((call) => call.startsWith("push:"))).toBe(false);
        expect(harness.heads()).toMatchObject({ "/repo": "base-0", "/sib": "sib-0" });
        expect(harness.snapshot().entries[0]).toMatchObject({
          status: "parked",
          reason: "conflict",
        });
        const description = harness.fixes[0] ?? "";
        expect(description).toContain("lands all-or-nothing");
        expect(description).toContain("- this repository (`/repo`, base `mine`)");
        expect(description).toContain("- sibling `/sib` (base `sib-main`)");
        expect(description).toContain("leave the base branches and the sibling remotes to it");
        // The sibling repository conflicted, so the detail names it — not the
        // main repository the set merged into cleanly first.
        expect(description).toContain("    Conflict in `/sib`:");
        expect(description).toContain("    - sibling-conflict.ts");
      }),
    );

    it.effect("restores the tail fatally when a sibling cannot fast-forward", () =>
      Effect.gen(function* () {
        const harness = makeHarness({
          entries: [entry(0, "first"), entry(1, "second")],
          siblings: [siblingSet()],
          fastForwardFailCwds: ["/sib"],
        });
        const result: DrainMergeQueueResult = yield* drain(harness.ports);
        expect(result).toMatchObject({
          _tag: "fatal",
          detail:
            "sibling /sib branch sib-main moved externally; cannot fast-forward — operator must reconcile",
        });
        expect(harness.calls).toContain("ff:cook-epic-integration-run-1");
        expect(harness.calls).toContain("ff:/sib:cook-epic-integration-run-1");
        expect(harness.calls).toContain("restore:0");
        expect(harness.calls.at(-1)).toBe("slot-release:cook-epic-run-1");
        expect(harness.snapshot().entries.map((item) => item.status)).toEqual(["queued", "queued"]);
      }),
    );

    it.effect("lands every repo with commits and records heads for the whole set", () =>
      Effect.gen(function* () {
        const harness = makeHarness({
          siblings: [
            siblingSet(),
            siblingSet({
              repositoryPath: "/sib2",
              integrationWorktreePath: "/worktrees/integ-sib2",
              lastAcceptedHead: "sib2-0",
            }),
          ],
          siblingAhead: { "/sib2": 0 },
        });
        expect(yield* drain(harness.ports)).toEqual({ _tag: "drained", merged: 1, parked: 0 });
        // /sib2 has no commits: its integration worktree is reset with the
        // set, but it gets no trial merge, landing, or push.
        expect(harness.calls).toContain("reset:/worktrees/integ-sib2:sib-main");
        expect(harness.calls.some((call) => call.startsWith("merge:/worktrees/integ-sib2:"))).toBe(
          false,
        );
        expect(harness.calls.some((call) => call.startsWith("ff:/sib2"))).toBe(false);
        expect(harness.calls).toContain("push:mine");
        expect(harness.calls).toContain("push:/sib:sib-main");
        expect(harness.calls.some((call) => call.startsWith("push:/sib2"))).toBe(false);
        // The merged event lists only repos with commits.
        expect(harness.events).toEqual([
          {
            event: "merged",
            child: "child-1",
            branch: "epic/child-1",
            commit: "landed-1",
            landing: "gated, pushed, landed",
            repositories: [
              { repo: "/repo", commits: 1, head: "landed-1" },
              { repo: "/sib", commits: 1, head: "landed-2" },
            ],
          },
        ]);
        // ...but completion records heads for EVERY sibling.
        expect(harness.completions).toEqual([
          {
            runId: "run-1",
            sequence: 0,
            lastAcceptedHead: "landed-1",
            siblingHeads: [
              { repositoryPath: "/sib", lastAcceptedHead: "landed-2" },
              { repositoryPath: "/sib2", lastAcceptedHead: "sib2-0" },
            ],
          },
        ]);
        expect(harness.calls).toContain("delete-local:epic/child-1");
        expect(harness.calls).toContain("delete-local:/sib:epic/child-1");
        expect(harness.calls).toContain("delete-local:/sib2:epic/child-1");
      }),
    );

    it.effect("drops an empty set and deletes the branch in every repo", () =>
      Effect.gen(function* () {
        const harness = makeHarness({
          empty: ["epic/child-1"],
          siblings: [siblingSet()],
          siblingAhead: { "/sib": 0 },
        });
        expect(yield* drain(harness.ports)).toEqual({ _tag: "drained", merged: 0, parked: 0 });
        expect(harness.calls).toContain("drop:0");
        expect(harness.calls).toContain("delete-local:epic/child-1");
        expect(harness.calls).toContain("delete-local:/sib:epic/child-1");
        expect(harness.calls.some((call) => call.startsWith("reset:"))).toBe(false);
        expect(harness.calls.some((call) => call.startsWith("merge:"))).toBe(false);
      }),
    );

    it.effect("fills the gate repositories with the sibling worktrees", () =>
      Effect.gen(function* () {
        const harness = makeHarness({ siblings: [siblingSet()] });
        yield* drain(harness.ports);
        expect(harness.gateRepositories[0]).toEqual({
          repositoryPath: "/repo",
          baseBranch: "mine",
          worktreeRoot: "/worktrees/integration",
          siblings: [
            {
              repositoryPath: "/sib",
              baseBranch: "sib-main",
              worktreeRoot: "/worktrees/integ-sib",
            },
          ],
        });
      }),
    );
  });

  describe("owned base branch (t3code-5m4)", () => {
    const ownedBranch = runBaseBranch("epic-1");

    it.effect("lands by ref-only update and reads the branch by name, not HEAD", () =>
      Effect.gen(function* () {
        const harness = makeHarness({ baseBranch: ownedBranch, currentHead: "base-0" });
        expect(yield* drain(harness.ports)).toEqual({ _tag: "drained", merged: 1, parked: 0 });
        expect(harness.calls).toEqual([
          `head:/repo:${ownedBranch}`,
          "slot-acquire:cook-epic-run-1",
          "begin-drain",
          "ahead:epic/child-1",
          `reset:/worktrees/integration:${ownedBranch}`,
          "clean:/worktrees/integration",
          "setup:/worktrees/integration",
          "merge:epic/child-1:cook-epic: merge epic/child-1 (child-1)",
          "gate",
          `ff:cook-epic-integration-run-1:owned:${ownedBranch}`,
          `push:${ownedBranch}`,
          `head:/repo:${ownedBranch}`,
          "fold:child-1",
          "delete-local:epic/child-1",
          "delete-remote:epic/child-1",
          "slot-release:cook-epic-run-1",
        ]);
      }),
    );

    it.effect("uses the legacy checkout-based land when the base branch is not owned", () =>
      Effect.gen(function* () {
        // Same drive, ordinary `baseBranch` ("mine"): every head read and the
        // fast-forward stay on the unqualified, checkout-based form.
        const harness = makeHarness();
        yield* drain(harness.ports);
        expect(harness.calls).toContain("head:/repo");
        expect(harness.calls).toContain("ff:cook-epic-integration-run-1");
        expect(harness.calls.some((call) => call.includes(":owned:"))).toBe(false);
      }),
    );

    it.effect("still freezes before the slot when the owned branch moved externally", () =>
      Effect.gen(function* () {
        const harness = makeHarness({ baseBranch: ownedBranch, currentHead: "external" });
        expect(yield* drain(harness.ports)).toMatchObject({ _tag: "fatal", queueLength: 1 });
        expect(harness.calls).toEqual([`head:/repo:${ownedBranch}`]);
        expect(harness.snapshot().entries[0]?.status).toBe("queued");
      }),
    );

    it.effect("restores the tail fatally when the ref-only update cannot fast-forward", () =>
      Effect.gen(function* () {
        const harness = makeHarness({
          baseBranch: ownedBranch,
          entries: [entry(0, "first"), entry(1, "second")],
          fastForwardFails: ["cook-epic-integration-run-1"],
        });
        expect(yield* drain(harness.ports)).toMatchObject({ _tag: "fatal", queueLength: 2 });
        expect(harness.calls).toContain("restore:0");
        expect(harness.snapshot().entries.map((item) => item.status)).toEqual(["queued", "queued"]);
      }),
    );

    it.effect("leaves sibling landing on the legacy checkout-based path", () =>
      Effect.gen(function* () {
        // Siblings are out of scope for owned base branches in this slice: only
        // the main repository's landing changes.
        const harness = makeHarness({
          baseBranch: ownedBranch,
          siblings: [
            {
              repositoryPath: "/sib",
              baseBranch: "sib-main",
              integrationWorktreePath: "/worktrees/integ-sib",
              lastAcceptedHead: "sib-0",
            },
          ],
        });
        yield* drain(harness.ports);
        expect(harness.calls).toContain("head:/sib");
        expect(harness.calls).toContain("ff:/sib:cook-epic-integration-run-1");
        expect(harness.calls.some((call) => call.startsWith("head:/sib:"))).toBe(false);
      }),
    );
  });

  describe("continuous base-branch integration (t3code-sha)", () => {
    const ownedBranch = runBaseBranch("epic-1");
    const operatorBranch = "operator/mine";

    it.effect(
      "integrates the operator's branch once, before any trial merge, and updates the base ref",
      () =>
        Effect.gen(function* () {
          const harness = makeHarness({
            baseBranch: ownedBranch,
            operatorBaseBranch: operatorBranch,
          });

          const result = yield* drain(harness.ports);

          expect(result).toEqual({ _tag: "drained", merged: 1, parked: 0 });
          const calls = harness.calls;
          const aheadIndex = calls.indexOf(`ahead:${operatorBranch}`);
          const resetIndex = calls.indexOf(`reset:/worktrees/integration:${ownedBranch}`);
          const mergeIndex = calls.findIndex(
            (call) => call === `merge:${operatorBranch}:cook-epic: integrate ${operatorBranch}`,
          );
          const ffIndex = calls.indexOf(`ff:cook-epic-integration-run-1:owned:${ownedBranch}`);
          const advanceIndex = calls.indexOf("advance-integration:landed-1");
          const beginDrainIndex = calls.indexOf("begin-drain");
          const entryMergeIndex = calls.findIndex((call) => call.startsWith("merge:epic/child-1:"));

          expect(aheadIndex).toBeGreaterThanOrEqual(0);
          expect(resetIndex).toBeGreaterThan(aheadIndex);
          expect(mergeIndex).toBeGreaterThan(resetIndex);
          expect(ffIndex).toBeGreaterThan(mergeIndex);
          expect(advanceIndex).toBeGreaterThan(ffIndex);
          // Once per drain, before the per-entry loop even starts.
          expect(beginDrainIndex).toBeGreaterThan(advanceIndex);
          expect(entryMergeIndex).toBeGreaterThan(beginDrainIndex);
        }),
    );

    it.effect(
      "treats a no-op integration (already up to date) as success, with no merge attempt",
      () =>
        Effect.gen(function* () {
          const harness = makeHarness({
            baseBranch: ownedBranch,
            operatorBaseBranch: operatorBranch,
            empty: [operatorBranch],
          });

          const result = yield* drain(harness.ports);

          expect(result).toEqual({ _tag: "drained", merged: 1, parked: 0 });
          expect(harness.calls).toContain(`ahead:${operatorBranch}`);
          expect(
            harness.calls.some(
              (call) => call.includes(operatorBranch) && call.startsWith("merge:"),
            ),
          ).toBe(false);
          expect(harness.calls.some((call) => call.startsWith("advance-integration:"))).toBe(false);
        }),
    );

    it.effect(
      "runs the gate on the post-integration tree in every path, including the control gate and repair recheck",
      () =>
        Effect.gen(function* () {
          const harness = makeHarness({
            baseBranch: ownedBranch,
            operatorBaseBranch: operatorBranch,
            gatePasses: false,
            gateOutput: "Cannot find module 'vite-plus/binding'\n2 failed",
          });

          const result = yield* drain(harness.ports);

          expect(result._tag).toBe("fatal");
          const advanceIndex = harness.calls.indexOf("advance-integration:landed-1");
          expect(advanceIndex).toBeGreaterThanOrEqual(0);
          const gateIndices = harness.calls
            .map((call, index) => (call === "gate" ? index : -1))
            .filter((index) => index >= 0);
          const repairIndex = harness.calls.indexOf("repair:/worktrees/integration");
          expect(gateIndices.length).toBeGreaterThan(0);
          for (const gateIndex of gateIndices) {
            expect(gateIndex).toBeGreaterThan(advanceIndex);
          }
          expect(repairIndex).toBeGreaterThan(advanceIndex);
          // Every reset targets the base branch by name, never a sha —
          // integration lives in the ref itself (t3code-sha), so a reset to
          // `lastAcceptedHead` or any other recorded sha would drop it again
          // and put the gate back on a pre-integration tree.
          const resetCalls = harness.calls.filter((call) => call.startsWith("reset:"));
          expect(resetCalls.length).toBeGreaterThan(0);
          for (const call of resetCalls) {
            expect(call.endsWith(`:${ownedBranch}`)).toBe(true);
          }
          expect(resetCalls.some((call) => call.endsWith(":base-0"))).toBe(false);
        }),
    );

    it.effect(
      "an integration conflict creates exactly one fix child, touches no entry, gates nothing, and lands nothing",
      () =>
        Effect.gen(function* () {
          const harness = makeHarness({
            baseBranch: ownedBranch,
            operatorBaseBranch: operatorBranch,
            conflicts: [operatorBranch],
          });

          const result = yield* drain(harness.ports);

          expect(result).toEqual({ _tag: "drained", merged: 0, parked: 0, blocked: 1 });
          expect(harness.calls).toContain(`abort:/worktrees/integration`);
          // Not touched: no drain begun, no entry ever left `draining`.
          expect(harness.calls).not.toContain("begin-drain");
          expect(harness.snapshot().entries.every((entry) => entry.status === "queued")).toBe(true);
          expect(harness.calls).not.toContain("gate");
          expect(harness.calls.some((call) => call.startsWith("ff:"))).toBe(false);
          expect(harness.fixes).toHaveLength(1);
          expect(harness.fixes[0]).toContain(
            `Merge fix: integrate ${operatorBranch} into ${ownedBranch}`,
          );
          expect(harness.fixes[0]).toContain(ownedBranch);
          expect(harness.fixes[0]).toContain(operatorBranch);
          expect(harness.events).toEqual([
            { event: "integration-blocked", operatorBranch, fix: "fix-1" },
          ]);
        }),
    );

    it.effect("reuses the open fix child instead of opening a second one", () =>
      Effect.gen(function* () {
        const harness = makeHarness({
          baseBranch: ownedBranch,
          operatorBaseBranch: operatorBranch,
          conflicts: [operatorBranch],
          existingIntegrationFixStatuses: ["open"],
        });

        const result = yield* drain(harness.ports);

        expect(result).toEqual({ _tag: "drained", merged: 0, parked: 0, blocked: 1 });
        expect(harness.fixes).toHaveLength(0);
        expect(harness.events).toEqual([]);
      }),
    );

    it.effect("stops the run once integration conflicts have exhausted the repair budget", () =>
      Effect.gen(function* () {
        const harness = makeHarness({
          baseBranch: ownedBranch,
          operatorBaseBranch: operatorBranch,
          conflicts: [operatorBranch],
          // MAX_MERGE_FIX_ATTEMPTS in MergeQueue.ts is 3; every one closed
          // without resolving still counts against the bound.
          existingIntegrationFixStatuses: ["closed", "closed", "closed"],
        });

        const result = yield* drain(harness.ports);

        expect(result._tag).toBe("fatal");
        expect(result._tag === "fatal" ? result.detail : "").toContain("still conflicts");
        expect(result._tag === "fatal" ? result.detail : "").toContain("3 repair attempts");
        expect(harness.fixes).toHaveLength(0);
        expect(harness.calls).not.toContain("begin-drain");
      }),
    );

    it.effect("makes zero new git calls when the flag is off (unowned base branch)", () =>
      Effect.gen(function* () {
        // `operatorBaseBranch` set but the base branch is not run-owned: the
        // field is ignored, matching every call the flag-off harness makes.
        const flagOff = makeHarness();
        const withOperatorSet = makeHarness({ operatorBaseBranch: operatorBranch });

        yield* drain(flagOff.ports);
        yield* drain(withOperatorSet.ports);

        expect(withOperatorSet.calls).toEqual(flagOff.calls);
      }),
    );

    it.effect(
      "makes zero new git calls when the flag is off (owned base, operatorBaseBranch null)",
      () =>
        Effect.gen(function* () {
          // An old snapshot predating this field decodes `operatorBaseBranch`
          // to `null` (t3code-sha) — indistinguishable from a harness that
          // never sets it. Both must drive the drain identically, so a future
          // change that special-cases "explicitly null" cannot silently break
          // resumed runs from before this feature existed.
          const fieldAbsent = makeHarness({ baseBranch: ownedBranch });
          const fieldNull = makeHarness({ baseBranch: ownedBranch, operatorBaseBranch: null });

          yield* drain(fieldAbsent.ports);
          yield* drain(fieldNull.ports);

          expect(fieldNull.calls).toEqual(fieldAbsent.calls);
        }),
    );

    it.effect(
      "an empty queue still defers on the merge slot when continuous integration is on",
      () =>
        Effect.gen(function* () {
          // Deliberate: continuous integration (t3code-sha) needs the slot too
          // — a run with nothing queued yet whose operator keeps landing
          // commits still has integrating to do — so an empty queue must not
          // skip the slot check the way it does with the flag off.
          const harness = makeHarness({
            baseBranch: ownedBranch,
            operatorBaseBranch: operatorBranch,
            entries: [],
            slotHeld: true,
          });

          const result = yield* drain(harness.ports);

          expect(result).toEqual({
            _tag: "deferred",
            queueLength: 0,
            holder: "cook-epic-run-0",
          });
          expect(harness.calls).toEqual([
            `head:/repo:${ownedBranch}`,
            "slot-acquire:cook-epic-run-1",
            "slot-holder",
          ]);
        }),
    );
  });

  describe("compatible batches (t3code-22o.8)", () => {
    const three = [entry(0, "first"), entry(1, "second"), entry(2, "third")];

    it.effect("verifies three compatible entries with one gate and lands them in order", () =>
      Effect.gen(function* () {
        // The gate is the most expensive thing a run does. Three children that
        // merge cleanly together are one integration state, so they are worth
        // exactly one gate — the measured 30h40m run spent one per child.
        const harness = makeHarness({ entries: three });

        expect(yield* drain(harness.ports)).toEqual({ _tag: "drained", merged: 3, parked: 0 });

        expect(harness.calls.filter((call) => call === "gate")).toHaveLength(1);
        // One trial merge each, stacked into one integration state, then one
        // fast-forward and one push carry all three.
        expect(harness.calls.filter((call) => call.startsWith("merge:"))).toHaveLength(3);
        expect(harness.calls.filter((call) => call.startsWith("reset:"))).toHaveLength(1);
        expect(harness.calls.filter((call) => call.startsWith("ff:"))).toHaveLength(1);
        expect(harness.calls.filter((call) => call.startsWith("push:"))).toHaveLength(1);
        // Every child still settles on its own, in queue order.
        expect(harness.completions.map((completion) => completion.sequence)).toEqual([0, 1, 2]);
        expect(harness.events.map((event) => (event as { readonly child: string }).child)).toEqual([
          "first",
          "second",
          "third",
        ]);
        expect(harness.calls.filter((call) => call.startsWith("fold:"))).toEqual([
          "fold:first",
          "fold:second",
          "fold:third",
        ]);
      }),
    );

    it.effect("names every branch the batch gate verified, and no single child", () =>
      Effect.gen(function* () {
        const harness = makeHarness({ entries: three });

        yield* drain(harness.ports);

        expect(harness.gateReceipts).toHaveLength(1);
        expect(harness.gateReceipts[0]).toMatchObject({
          phase: "entry",
          // A batch failure could come from any member, so naming one child
          // here would blame it.
          childId: null,
          branch: "epic/first epic/second epic/third",
        });
      }),
    );

    it.effect("isolates a red member by halving, and lands the rest", () =>
      Effect.gen(function* () {
        // Bounded fallback: the batch halves instead of re-testing every green
        // member on its own, and nothing lands on evidence from the red run.
        const harness = makeHarness({ entries: three, gateRedBranches: ["epic/third"] });

        expect(yield* drain(harness.ports)).toEqual({ _tag: "drained", merged: 2, parked: 1 });

        // batch of 3 (red), control, half of 2 (green), the single red entry,
        // control again on the base it moved to.
        expect(harness.calls.filter((call) => call === "gate")).toHaveLength(5);
        expect(harness.events.at(0)).toEqual({
          event: "split",
          branches: ["epic/first", "epic/second", "epic/third"],
          halves: [2, 1],
          detail: "no failure line found in gate output (0 lines)",
        });
        expect(harness.completions.map((completion) => completion.sequence)).toEqual([0, 1]);
        expect(harness.snapshot().entries).toEqual([
          expect.objectContaining({
            sequence: 2,
            status: "parked",
            reason: "gate-failed",
            fixIssueId: "fix-1",
          }),
        ]);
        // Only the isolated entry was ever blamed by a receipt.
        expect(
          harness.gateReceipts.filter((receipt) => receipt.childId !== null).map((r) => r.childId),
        ).toEqual(["third"]);
      }),
    );

    it.effect("never lands a head the batch gate rejected", () =>
      Effect.gen(function* () {
        // Every member of a red batch is red until proven otherwise: the base
        // must not move at all before the isolation pass says which is which.
        const harness = makeHarness({
          entries: three,
          gateRedBranches: ["epic/first", "epic/second", "epic/third"],
        });

        expect(yield* drain(harness.ports)).toEqual({ _tag: "drained", merged: 0, parked: 3 });

        expect(harness.calls.some((call) => call.startsWith("ff:"))).toBe(false);
        expect(harness.calls.some((call) => call.startsWith("push:"))).toBe(false);
        expect(harness.heads()).toMatchObject({ "/repo": "base-0" });
        // 3 red, control, 2 red, 1 red (parked), 1 red (parked), 1 red
        // (parked): halving costs at most one gate per member plus the split
        // gates, and never more than a per-entry pass would have.
        expect(harness.calls.filter((call) => call === "gate").length).toBeLessThanOrEqual(8);
      }),
    );

    it.effect("parks one conflicting branch and lands the rest of the batch", () =>
      Effect.gen(function* () {
        const harness = makeHarness({ entries: three, conflicts: ["epic/second"] });

        expect(yield* drain(harness.ports)).toEqual({ _tag: "drained", merged: 2, parked: 1 });

        expect(harness.calls.filter((call) => call === "gate")).toHaveLength(1);
        expect(harness.calls).toContain("abort:/worktrees/integration");
        expect(harness.completions.map((completion) => completion.sequence)).toEqual([0, 2]);
        expect(harness.snapshot().entries).toEqual([
          expect.objectContaining({ sequence: 1, status: "parked", reason: "conflict" }),
        ]);
      }),
    );

    it.effect("rolls a parked member out of the batch without losing the members before it", () =>
      Effect.gen(function* () {
        // A set that merges into the main repository and then conflicts in a
        // sibling has to come back out of the batch. Resetting to the base
        // branch would take every earlier member with it, and aborting the
        // sibling merge alone would leave the main worktree carrying work
        // that is about to be parked — and the gate would then verify it.
        const harness = makeHarness({
          entries: [entry(0, "first"), entry(1, "second")],
          siblings: [
            {
              repositoryPath: "/sib",
              baseBranch: "sib-main",
              integrationWorktreePath: "/worktrees/integ-sib",
              lastAcceptedHead: "sib-0",
            },
          ],
          siblingConflicts: ["epic/second"],
        });

        expect(yield* drain(harness.ports)).toEqual({ _tag: "drained", merged: 1, parked: 1 });

        expect(harness.calls).toContain("abort:/worktrees/integ-sib");
        // Back to where the first member left it, not back to the base branch.
        expect(harness.calls).toContain("reset:/worktrees/integration:merged-1");
        expect(harness.calls.filter((call) => call === "gate")).toHaveLength(1);
        expect(harness.completions.map((completion) => completion.sequence)).toEqual([0]);
        expect(harness.snapshot().entries).toEqual([
          expect.objectContaining({ sequence: 1, status: "parked", reason: "conflict" }),
        ]);
      }),
    );

    it.effect("is idempotent when a restart re-drains entries left draining", () =>
      Effect.gen(function* () {
        // A crash between the fast-forward and the completion leaves an entry
        // `draining` on a base that already carries its commits. The re-drain
        // must drop it, not land it twice.
        const harness = makeHarness({
          entries: [
            { ...entry(0, "first"), status: "draining" },
            { ...entry(1, "second"), status: "draining" },
          ],
          empty: ["epic/first"],
        });

        expect(yield* drain(harness.ports)).toEqual({ _tag: "drained", merged: 1, parked: 0 });

        expect(harness.calls).toContain("drop:0");
        expect(harness.calls.some((call) => call.startsWith("merge:epic/first"))).toBe(false);
        expect(harness.completions.map((completion) => completion.sequence)).toEqual([1]);
        expect(harness.calls.filter((call) => call === "gate")).toHaveLength(1);
      }),
    );

    it.effect("restores the whole batch when the landing fast-forward is rejected", () =>
      Effect.gen(function* () {
        const harness = makeHarness({
          entries: three,
          fastForwardFails: ["cook-epic-integration-run-1"],
        });

        expect(yield* drain(harness.ports)).toMatchObject({ _tag: "fatal", queueLength: 3 });

        expect(harness.calls).toContain("restore:0");
        expect(harness.snapshot().entries.map((item) => item.status)).toEqual([
          "queued",
          "queued",
          "queued",
        ]);
      }),
    );

    it.effect("asks the base the blameless question once per batch, not once per member", () =>
      Effect.gen(function* () {
        // The control gate answers "is the base itself broken?". Nothing lands
        // between a batch and its halves, so the halves sit on the same base
        // and the answer cannot have changed. Re-asking it costs a full gate.
        const harness = makeHarness({ entries: three, gateRedBranches: ["epic/second"] });

        yield* drain(harness.ports);

        // One control before the split; the second only after the first half
        // landed and moved the base.
        expect(harness.gateReceipts.filter((receipt) => receipt.phase === "control")).toHaveLength(
          2,
        );
      }),
    );
  });

  describe("disjoint file footprints (t3code-2jh.8)", () => {
    const three = [entry(0, "first"), entry(1, "second"), entry(2, "third")];

    it.effect("batches two entries that change different files into one gate", () =>
      Effect.gen(function* () {
        const harness = makeHarness({
          entries: [entry(0, "first"), entry(1, "second")],
          files: { "epic/first": ["src/a.ts"], "epic/second": ["src/b.ts"] },
        });

        expect(yield* drain(harness.ports)).toEqual({ _tag: "drained", merged: 2, parked: 0 });

        expect(harness.calls.filter((call) => call === "gate")).toHaveLength(1);
        expect(harness.calls.filter((call) => call.startsWith("ff:"))).toHaveLength(1);
        // Both footprints are measured before the first trial merge: a batch
        // has to know its whole membership before it merges anything.
        expect(harness.calls.slice(0, 6)).toEqual([
          "head:/repo",
          "slot-acquire:cook-epic-run-1",
          "begin-drain",
          "ahead:epic/first",
          "ahead:epic/second",
          "changed:epic/first",
        ]);
      }),
    );

    it.effect("gives two entries that change the same file a gate each", () =>
      Effect.gen(function* () {
        // Two branches touching one file can break each other in ways neither
        // breaks alone, so one verdict cannot answer for both: batching them
        // only buys the isolation pass that follows a red batch.
        const harness = makeHarness({
          entries: [entry(0, "first"), entry(1, "second")],
          files: { "epic/first": ["src/a.ts"], "epic/second": ["src/a.ts", "src/b.ts"] },
        });

        expect(yield* drain(harness.ports)).toEqual({ _tag: "drained", merged: 2, parked: 0 });

        expect(harness.calls.filter((call) => call === "gate")).toHaveLength(2);
        // Each merge set lands on its own, so each gets its own reset, trial
        // merge, fast-forward and push.
        expect(harness.calls.filter((call) => call.startsWith("reset:"))).toHaveLength(2);
        expect(harness.calls.filter((call) => call.startsWith("ff:"))).toHaveLength(2);
        expect(harness.calls.filter((call) => call.startsWith("push:"))).toHaveLength(2);
        // Per-entry bookkeeping is unchanged: one completion, one merged
        // event and one fold each, in queue order.
        expect(harness.completions.map((completion) => completion.sequence)).toEqual([0, 1]);
        expect(harness.events.map((event) => (event as { readonly child: string }).child)).toEqual([
          "first",
          "second",
        ]);
        expect(harness.calls.filter((call) => call.startsWith("fold:"))).toEqual([
          "fold:first",
          "fold:second",
        ]);
        // Each gate names only the branches it verified.
        expect(harness.gateReceipts.map((receipt) => receipt.branch)).toEqual([
          "epic/first",
          "epic/second",
        ]);
      }),
    );

    it.effect("keeps a disjoint neighbour batched around an overlapping pair", () =>
      Effect.gen(function* () {
        // Grouping is by consecutive runs, never by reordering: queue order is
        // landing order, so `third` may batch with `second` but never jump
        // ahead of it to join `first`.
        const harness = makeHarness({
          entries: three,
          files: {
            "epic/first": ["src/a.ts"],
            "epic/second": ["src/a.ts"],
            "epic/third": ["src/c.ts"],
          },
        });

        expect(yield* drain(harness.ports)).toEqual({ _tag: "drained", merged: 3, parked: 0 });

        expect(harness.calls.filter((call) => call === "gate")).toHaveLength(2);
        expect(harness.gateReceipts.map((receipt) => receipt.branch)).toEqual([
          "epic/first",
          "epic/second epic/third",
        ]);
        expect(harness.completions.map((completion) => completion.sequence)).toEqual([0, 1, 2]);
      }),
    );

    it.effect("puts a branch with an unreadable footprint through on its own", () =>
      Effect.gen(function* () {
        // A footprint git could not report is not an empty one. Batching on
        // evidence that does not exist is how a shared verdict stops meaning
        // anything, so an unmeasurable branch just goes alone.
        const harness = makeHarness({
          entries: [entry(0, "first"), entry(1, "second")],
          changedFilesFails: ["epic/first"],
        });

        expect(yield* drain(harness.ports)).toEqual({ _tag: "drained", merged: 2, parked: 0 });

        expect(harness.calls.filter((call) => call === "gate")).toHaveLength(2);
        expect(harness.completions.map((completion) => completion.sequence)).toEqual([0, 1]);
      }),
    );

    it.effect("measures a footprint in every repository the branch set touches", () =>
      Effect.gen(function* () {
        // The same relative path in two repositories is two different files,
        // so a footprint that forgot which repository it came from would call
        // disjoint sets overlapping.
        const harness = makeHarness({
          entries: [entry(0, "first"), entry(1, "second")],
          siblings: [
            {
              repositoryPath: "/sib",
              baseBranch: "sib-main",
              integrationWorktreePath: "/worktrees/integ-sib",
              lastAcceptedHead: "sib-0",
            },
          ],
          files: { "epic/first": ["src/a.ts"], "epic/second": ["src/b.ts"] },
        });

        expect(yield* drain(harness.ports)).toEqual({ _tag: "drained", merged: 2, parked: 0 });

        expect(harness.calls.filter((call) => call.startsWith("changed:"))).toEqual([
          "changed:epic/first",
          "changed:/sib:epic/first",
          "changed:epic/second",
          "changed:/sib:epic/second",
        ]);
        expect(harness.calls.filter((call) => call === "gate")).toHaveLength(1);
      }),
    );

    it.effect("splits a set that overlaps only inside a sibling repository", () =>
      Effect.gen(function* () {
        const harness = makeHarness({
          entries: [entry(0, "first"), entry(1, "second")],
          siblings: [
            {
              repositoryPath: "/sib",
              baseBranch: "sib-main",
              integrationWorktreePath: "/worktrees/integ-sib",
              lastAcceptedHead: "sib-0",
            },
          ],
          // Reported in both repositories, so the overlap is in the sibling
          // too — and one shared file anywhere is enough to split the set.
          files: { "epic/first": ["src/a.ts"], "epic/second": ["src/a.ts"] },
        });

        expect(yield* drain(harness.ports)).toEqual({ _tag: "drained", merged: 2, parked: 0 });

        expect(harness.calls.filter((call) => call === "gate")).toHaveLength(2);
      }),
    );

    it.effect("never reads a footprint when only one entry is queued", () =>
      Effect.gen(function* () {
        // Nothing to be disjoint from, so the reads would buy nothing.
        const harness = makeHarness();

        yield* drain(harness.ports);

        expect(harness.calls.some((call) => call.startsWith("changed:"))).toBe(false);
      }),
    );

    it.effect("still halves a disjoint batch its gate rejected", () =>
      Effect.gen(function* () {
        // Disjoint footprints make a shared gate honest, not infallible: a
        // member can still be red on its own, and the isolation pass is
        // unchanged.
        const harness = makeHarness({
          entries: three,
          gateRedBranches: ["epic/third"],
          files: {
            "epic/first": ["src/a.ts"],
            "epic/second": ["src/b.ts"],
            "epic/third": ["src/c.ts"],
          },
        });

        expect(yield* drain(harness.ports)).toEqual({ _tag: "drained", merged: 2, parked: 1 });

        expect(harness.events.at(0)).toMatchObject({
          event: "split",
          branches: ["epic/first", "epic/second", "epic/third"],
          halves: [2, 1],
        });
      }),
    );
  });
});

describe("merge policy", () => {
  for (const reason of ["conflict", "gate-failed"] as const) {
    for (const pushEnabled of [false, true]) {
      it(`snapshots ${reason} with pushEnabled=${String(pushEnabled)}`, () => {
        expect(
          mergeFixDescription({
            childId: "child-1",
            branch: "epic/child-1",
            baseBranch: "mine",
            reason,
            gateCommand: "vp check",
            pushEnabled,
          }),
        ).toMatchSnapshot();
      });
    }
  }

  it("round-trips merge-fix branches containing slashes", () => {
    const title = mergeFixTitle("epic/team/child-1", "gate-failed");
    expect(parseMergeFixTitle(title)).toEqual({
      branch: "epic/team/child-1",
      reason: "gate-failed",
    });
  });

  it("keeps the four landing strings closed", () => {
    expect([
      landingDescription({ pushEnabled: false, verified: true }),
      landingDescription({ pushEnabled: false, verified: false }),
      landingDescription({ pushEnabled: true, verified: true }),
      landingDescription({ pushEnabled: true, verified: false }),
    ]).toEqual([
      "gated, landed locally",
      "landed unverified locally",
      "gated, pushed, landed",
      "pushed, landed unverified",
    ]);
  });
});
