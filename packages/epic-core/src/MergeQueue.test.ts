import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { drainMergeQueue, type DrainMergeQueueResult, type MergeQueuePorts } from "./MergeQueue.ts";
import { BacklogError, type BacklogIssue } from "./ports/Backlog.ts";
import {
  landingDescription,
  mergeFixDescription,
  mergeFixTitle,
  parseMergeFixTitle,
} from "./policy.ts";
import type {
  MergeGitShape,
  MergeQueueEntry,
  MergeQueueSnapshot,
  MergeQueueStoreShape,
} from "./ports/MergeQueue.ts";

const baseSnapshot = (entries: ReadonlyArray<MergeQueueEntry>): MergeQueueSnapshot => ({
  runId: "run-1",
  lastAcceptedHead: "base-0",
  repositoryPath: "/repo",
  baseBranch: "mine",
  integrationBranch: "cook-epic-integration-run-1",
  integrationWorktreePath: "/worktrees/integration",
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
    readonly gatePasses?: boolean;
    /** Per-call gate answers: [merge set, control on base, …]. */
    readonly gateSequence?: ReadonlyArray<boolean>;
    readonly gateOutput?: string;
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
  } = {},
) => {
  const siblings = options.siblings ?? [];
  let snapshot: MergeQueueSnapshot = {
    ...baseSnapshot(options.entries ?? [entry(0, "child-1")]),
    siblings,
  };
  const heads: Record<string, string> = { "/repo": options.currentHead ?? "base-0" };
  for (const sibling of siblings) {
    heads[sibling.repositoryPath] =
      options.siblingExternalHeads?.[sibling.repositoryPath] ?? sibling.lastAcceptedHead;
  }
  const calls: string[] = [];
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
  const children: BacklogIssue[] = (options.existingFixStatuses ?? []).map((status, index) => ({
    id: `existing-${index + 1}`,
    title: mergeFixTitle("epic/child-1", "conflict"),
    status,
    priority: 1,
    issueType: "task",
    parentId: "epic-1",
    description: "existing",
    labels: [],
    commentCount: 0,
  }));
  let createFailed = false;
  let gateCall = 0;

  const git: MergeGitShape = {
    head: (cwd) =>
      Effect.sync(() => {
        calls.push(`head:${cwd}`);
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
    resetHard: (cwd, ref) => Effect.sync(() => void calls.push(`reset:${cwd}:${ref}`)),
    clean: (cwd) => Effect.sync(() => void calls.push(`clean:${cwd}`)),
    setupWorktree: (cwd) => Effect.sync(() => void calls.push(`setup:${cwd}`)),
    trialMerge: ({ cwd, branch, message }) =>
      Effect.sync(() => {
        calls.push(
          cwd === "/worktrees/integration"
            ? `merge:${branch}:${message}`
            : `merge:${cwd}:${branch}:${message}`,
        );
        return {
          merged:
            options.conflicts?.includes(branch) !== true &&
            options.conflictCwds?.includes(cwd) !== true,
          output: "trial",
        };
      }),
    abortMerge: (cwd) => Effect.sync(() => void calls.push(`abort:${cwd}`)),
    fastForward: ({ cwd, ref }) =>
      Effect.sync(() => {
        calls.push(cwd === "/repo" ? `ff:${ref}` : `ff:${cwd}:${ref}`);
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
          gateCall += 1;
          return {
            passed: sequenced ?? options.gatePasses ?? true,
            repositoryPaths: ["/repo"],
            output: options.gateOutput ?? "",
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
      // Nothing was blamed and no repair was opened.
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
      expect(yield* drain(harness.ports)).toEqual({ _tag: "deferred", queueLength: 1 });
      expect(harness.calls).toEqual(["head:/repo", "slot-acquire:cook-epic-run-1"]);
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
        expect(description).toContain("never push sibling repos");
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
