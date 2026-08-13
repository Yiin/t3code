import { describe, expect, it } from "vite-plus/test";

import {
  EPIC_RUN_CONTINUATION_PROMPT,
  EPIC_RUN_RESTART_RESUME_PROMPT,
  EPIC_RUN_STALLED_PROGRESS_PROMPT,
  backoffDelayMs,
  childAttemptsFromHistory,
  childBranch,
  conflictFailureDetail,
  decideGraceStep,
  decideIterationBoundary,
  failureReasonForOutcome,
  integrateOperatorBaseMessage,
  integrationFixDescription,
  integrationFixTitle,
  mergeFixDescription,
  mergeFixTitle,
  parseIntegrationFixTitle,
  parseMergeFixTitle,
  persistedFailureReason,
  proveEpicCompletion,
  MAX_OPEN_CHILD_EVIDENCE,
  type IterationBoundaryDecision,
  type IterationBoundaryInput,
  mergeSlotHolder,
  parseMergeSlotHolder,
  runBaseBranch,
  shouldReclaimMergeSlot,
} from "./policy.ts";
import {
  iterationFailureClass,
  type EpicIterationOutcome,
  type EpicIterationOutcomeKind,
} from "./ralphProtocol.ts";

const outcome = (
  kind: EpicIterationOutcomeKind,
  detail: string | null = kind,
): EpicIterationOutcome => ({ kind, detail, report: null });

const boundaryInput = (
  overrides: Partial<IterationBoundaryInput> = {},
): IterationBoundaryInput => ({
  runStatus: "running",
  consecutiveFailures: 1,
  noCommitStreak: 1,
  infraStreak: 2,
  lastError: "previous error",
  outcome: outcome("blocked"),
  noCommitChildClosed: false,
  providerFallbackApplied: false,
  providerTurnDispatched: true,
  limits: {
    maxConsecutiveFailures: 3,
    maxNoCommitStreak: 3,
    infraFailureBudget: 4,
    retryBaseDelayMs: 10_000,
    retryMaxDelayMs: 300_000,
  },
  ...overrides,
});

describe("decideIterationBoundary", () => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly input: Partial<IterationBoundaryInput>;
    readonly expected: IterationBoundaryDecision;
  }> = [
    {
      name: "provider fallback continues and resets only the infra streak",
      input: {
        providerFallbackApplied: true,
        outcome: {
          ...outcome("error", "provider failed"),
          failureReason: "provider-error:unavailable",
          providerFallbackEligible: true,
        },
      },
      expected: {
        action: "continue",
        delayMs: 0,
        nextStatus: null,
        nextConsecutiveFailures: 1,
        nextNoCommitStreak: 1,
        nextInfraStreak: 0,
        lastError: "previous error",
      },
    },
    {
      name: "a stopped run keeps its persisted policy state",
      input: { runStatus: "paused" },
      expected: {
        action: "stop",
        delayMs: 0,
        nextStatus: null,
        nextConsecutiveFailures: 1,
        nextNoCommitStreak: 1,
        nextInfraStreak: 2,
        lastError: "previous error",
      },
    },
    {
      name: "a dispatched backlog-empty turn completes and clears streaks",
      input: { outcome: outcome("backlog-empty") },
      expected: {
        action: "stop",
        delayMs: 0,
        nextStatus: "done",
        nextConsecutiveFailures: 0,
        nextNoCommitStreak: 0,
        nextInfraStreak: 0,
        lastError: null,
      },
    },
    {
      name: "a done turn continues and clears streaks",
      input: { outcome: outcome("done") },
      expected: {
        action: "continue",
        delayMs: 0,
        nextStatus: null,
        nextConsecutiveFailures: 0,
        nextNoCommitStreak: 0,
        nextInfraStreak: 0,
        lastError: null,
      },
    },
    {
      name: "an accepted no-commit child continues and clears streaks",
      input: { outcome: outcome("no-commit"), noCommitChildClosed: true },
      expected: {
        action: "continue",
        delayMs: 0,
        nextStatus: null,
        nextConsecutiveFailures: 0,
        nextNoCommitStreak: 0,
        nextInfraStreak: 0,
        lastError: null,
      },
    },
    {
      name: "an open no-commit child spends the gutter budget",
      input: { outcome: outcome("no-commit") },
      expected: {
        action: "continue",
        delayMs: 0,
        nextStatus: null,
        nextConsecutiveFailures: 0,
        nextNoCommitStreak: 2,
        nextInfraStreak: 2,
        lastError: null,
      },
    },
    {
      name: "an infra failure spends only the infra budget",
      input: { outcome: outcome("timeout", "turn timed out") },
      expected: {
        action: "continue",
        delayMs: 40_000,
        nextStatus: null,
        nextConsecutiveFailures: 1,
        nextNoCommitStreak: 1,
        nextInfraStreak: 3,
        lastError: "turn timed out",
      },
    },
    {
      name: "a child failure spends only the child failure budget",
      input: { outcome: outcome("blocked", "child blocked") },
      expected: {
        action: "continue",
        delayMs: 20_000,
        nextStatus: null,
        nextConsecutiveFailures: 2,
        nextNoCommitStreak: 1,
        nextInfraStreak: 2,
        lastError: "child blocked",
      },
    },
  ];

  it.each(cases)("$name", ({ input, expected }) => {
    expect(decideIterationBoundary(boundaryInput(input))).toEqual(expected);
  });

  it("preserves the gutter and infra streak when empty selection dispatched no turn", () => {
    expect(
      decideIterationBoundary(
        boundaryInput({
          outcome: outcome("backlog-empty"),
          providerTurnDispatched: false,
        }),
      ),
    ).toEqual({
      action: "stop",
      delayMs: 0,
      nextStatus: "done",
      nextConsecutiveFailures: 0,
      nextNoCommitStreak: 1,
      nextInfraStreak: 2,
      lastError: null,
    });
  });

  const precedenceCases: ReadonlyArray<{
    readonly name: string;
    readonly input: Partial<IterationBoundaryInput>;
    readonly expected: IterationBoundaryDecision;
  }> = [
    {
      name: "fallback precedes stopped status and infra policy",
      input: {
        runStatus: "paused",
        providerFallbackApplied: true,
        outcome: {
          ...outcome("error", "provider failed"),
          failureReason: "provider-error:unavailable",
          providerFallbackEligible: true,
        },
      },
      expected: {
        action: "stop",
        delayMs: 0,
        nextStatus: null,
        nextConsecutiveFailures: 1,
        nextNoCommitStreak: 1,
        nextInfraStreak: 0,
        lastError: "previous error",
      },
    },
    {
      name: "stopped status precedes infra policy",
      input: { runStatus: "paused", outcome: outcome("timeout", "timed out") },
      expected: {
        action: "stop",
        delayMs: 0,
        nextStatus: null,
        nextConsecutiveFailures: 1,
        nextNoCommitStreak: 1,
        nextInfraStreak: 2,
        lastError: "previous error",
      },
    },
    {
      name: "stopped status precedes backlog-empty",
      input: { runStatus: "paused", outcome: outcome("backlog-empty") },
      expected: {
        action: "stop",
        delayMs: 0,
        nextStatus: null,
        nextConsecutiveFailures: 1,
        nextNoCommitStreak: 1,
        nextInfraStreak: 2,
        lastError: "previous error",
      },
    },
    {
      name: "backlog-empty precedes accepted evidence",
      input: { outcome: outcome("backlog-empty"), noCommitChildClosed: true },
      expected: {
        action: "stop",
        delayMs: 0,
        nextStatus: "done",
        nextConsecutiveFailures: 0,
        nextNoCommitStreak: 0,
        nextInfraStreak: 0,
        lastError: null,
      },
    },
    {
      name: "done precedes accepted evidence",
      input: { outcome: outcome("done"), noCommitChildClosed: true },
      expected: {
        action: "continue",
        delayMs: 0,
        nextStatus: null,
        nextConsecutiveFailures: 0,
        nextNoCommitStreak: 0,
        nextInfraStreak: 0,
        lastError: null,
      },
    },
    {
      name: "accepted evidence precedes the no-commit gutter",
      input: {
        outcome: outcome("no-commit"),
        noCommitChildClosed: true,
        limits: { ...boundaryInput().limits, maxNoCommitStreak: 2 },
      },
      expected: {
        action: "continue",
        delayMs: 0,
        nextStatus: null,
        nextConsecutiveFailures: 0,
        nextNoCommitStreak: 0,
        nextInfraStreak: 0,
        lastError: null,
      },
    },
  ];

  it.each(precedenceCases)("$name", ({ input, expected }) => {
    expect(decideIterationBoundary(boundaryInput(input))).toEqual(expected);
  });

  it("stops when the no-commit budget is exhausted", () => {
    expect(
      decideIterationBoundary(
        boundaryInput({
          outcome: outcome("no-commit"),
          limits: { ...boundaryInput().limits, maxNoCommitStreak: 2 },
        }),
      ),
    ).toEqual({
      action: "stop",
      delayMs: 0,
      nextStatus: "failed",
      nextConsecutiveFailures: 0,
      nextNoCommitStreak: 2,
      nextInfraStreak: 2,
      lastError: "gutter: 2 iterations without a commit",
    });
  });

  it("stops only when the infra budget is exhausted", () => {
    expect(
      decideIterationBoundary(
        boundaryInput({
          outcome: outcome("error", "provider failed"),
          limits: { ...boundaryInput().limits, infraFailureBudget: 3 },
        }),
      ),
    ).toEqual({
      action: "stop",
      delayMs: 40_000,
      nextStatus: "failed",
      nextConsecutiveFailures: 1,
      nextNoCommitStreak: 1,
      nextInfraStreak: 3,
      lastError: "infra: 3 consecutive infrastructure failures; last: provider failed",
    });
  });

  it("stops only when the child failure budget is exhausted", () => {
    expect(
      decideIterationBoundary(
        boundaryInput({
          consecutiveFailures: 2,
          outcome: outcome("blocked", "cannot proceed"),
        }),
      ),
    ).toEqual({
      action: "stop",
      delayMs: 40_000,
      nextStatus: "failed",
      nextConsecutiveFailures: 3,
      nextNoCommitStreak: 1,
      nextInfraStreak: 2,
      lastError: "cannot proceed",
    });
  });
});

describe("backoffDelayMs", () => {
  it.each([
    [1, 10_000],
    [2, 20_000],
    [5, 160_000],
    [7, 300_000],
  ])("uses exponential delay for failure %i", (failures, expected) => {
    expect(backoffDelayMs(failures, 10_000, 300_000)).toBe(expected);
  });
});

describe("failure vocabulary", () => {
  it.each([
    ["done", null, null],
    ["backlog-empty", null, null],
    ["no-commit", "no-commit-child-open", "child"],
    ["blocked", "blocked", "child"],
    ["timeout", "timeout", "infra"],
    ["error", "turn-error", "infra"],
    ["protocol-error", "protocol-error", "infra"],
  ] as const)("maps %s without merging the failure-class split", (kind, reason, failureClass) => {
    expect(failureReasonForOutcome(kind)).toBe(reason);
    expect(iterationFailureClass(kind)).toBe(failureClass);
  });

  it.each([
    {
      name: "completed status clears every failure source",
      input: {
        iterationStatus: "completed" as const,
        dispatchFailed: true,
        evidenceFailureReason: "no-commit-no-evidence",
        outcome: {
          ...outcome("error"),
          failureReason: "provider-error:auth",
        },
      },
      expected: null,
    },
    {
      name: "dispatch failure precedes evidence and outcome reasons",
      input: {
        iterationStatus: "failed" as const,
        dispatchFailed: true,
        evidenceFailureReason: "no-commit-no-evidence",
        outcome: {
          ...outcome("error"),
          failureReason: "provider-error:auth",
        },
      },
      expected: "infra:dispatch-failed",
    },
    {
      name: "evidence precedes the classified outcome override",
      input: {
        iterationStatus: "failed" as const,
        dispatchFailed: false,
        evidenceFailureReason: "closed-without-findings",
        outcome: {
          ...outcome("no-commit"),
          failureReason: "provider-error:auth",
        },
      },
      expected: "child:closed-without-findings",
    },
    {
      name: "the classified outcome override precedes the default mapping",
      input: {
        iterationStatus: "failed" as const,
        dispatchFailed: false,
        evidenceFailureReason: null,
        outcome: {
          ...outcome("error"),
          failureReason: "provider-error:auth",
        },
      },
      expected: "infra:provider-error:auth",
    },
    {
      name: "the default mapping supplies the final fallback",
      input: {
        iterationStatus: "failed" as const,
        dispatchFailed: false,
        evidenceFailureReason: null,
        outcome: outcome("blocked"),
      },
      expected: "child:blocked",
    },
  ])("$name", ({ input, expected }) => {
    expect(persistedFailureReason(input)).toBe(expected);
  });
});

describe("childAttemptsFromHistory", () => {
  it("counts one spent attempt per terminal child failure, per child", () => {
    expect(
      Object.fromEntries(
        childAttemptsFromHistory([
          { issueId: "epic.1", turnStatus: "failed", failureReason: "child:blocked" },
          { issueId: "epic.1", turnStatus: "failed", failureReason: "child:no-commit-child-open" },
          { issueId: "epic.2", turnStatus: "failed", failureReason: "child:no-commit-no-evidence" },
        ]),
      ),
    ).toEqual({ "epic.1": 2, "epic.2": 1 });
  });

  it.each([
    {
      name: "an infrastructure failure",
      row: {
        issueId: "epic.1",
        turnStatus: "failed" as const,
        failureReason: "infra:dispatch-failed",
      },
    },
    {
      name: "a restart-abandoned row",
      row: {
        issueId: "epic.1",
        turnStatus: "abandoned" as const,
        failureReason: "infra:resume-unsupported",
      },
    },
    {
      name: "a row a cancellation left running",
      row: { issueId: "epic.1", turnStatus: "running" as const, failureReason: null },
    },
    {
      name: "a no-commit turn that closed its child",
      row: { issueId: "epic.1", turnStatus: "completed" as const, failureReason: null },
    },
    {
      name: "a failure with no reason at all",
      row: { issueId: "epic.1", turnStatus: "failed" as const, failureReason: null },
    },
    {
      name: "a row naming no child",
      row: { issueId: null, turnStatus: "failed" as const, failureReason: "child:blocked" },
    },
  ])("charges nothing for $name", ({ row }) => {
    expect(childAttemptsFromHistory([row]).size).toBe(0);
  });
});

const graceInput = (
  overrides: Partial<Parameters<typeof decideGraceStep>[0]> = {},
): Parameters<typeof decideGraceStep>[0] => ({
  headMoved: false,
  turnStatus: "completed" as const,
  freshRunningCount: 0,
  fingerprintChanged: true,
  hasRalphToken: false,
  finalMessageMissing: false,
  finalMessageWaitExhausted: false,
  continuationsUsed: 0,
  maxGraceContinuations: 10,
  ...overrides,
});

describe("decideGraceStep", () => {
  it("settles when HEAD moved", () => {
    expect(decideGraceStep(graceInput({ headMoved: true, freshRunningCount: 2 }))).toEqual({
      action: "settle",
      reason: "head-moved",
    });
  });

  it.each(["running", "error", "interrupted", null] as const)(
    "settles a %s turn before subagent handling",
    (turnStatus) => {
      expect(decideGraceStep(graceInput({ turnStatus, freshRunningCount: 2 }))).toEqual({
        action: "settle",
        reason: "turn-not-completed",
      });
    },
  );

  it("awaits fresh subagents and carries the shared continuation prompt", () => {
    expect(decideGraceStep(graceInput({ freshRunningCount: 2 }))).toEqual({
      action: "awaitDrain",
      prompt: EPIC_RUN_CONTINUATION_PROMPT,
      nextContinuationCount: 1,
    });
  });

  it("continues changed work without a RALPH token with the stalled prompt", () => {
    expect(decideGraceStep(graceInput())).toEqual({
      action: "continue",
      prompt: EPIC_RUN_STALLED_PROGRESS_PROMPT,
      nextContinuationCount: 1,
    });
  });

  it.each([
    ["unchanged fingerprint", { fingerprintChanged: false }, "fingerprint-not-changed"],
    ["unavailable fingerprint", { fingerprintChanged: null }, "fingerprint-not-changed"],
    ["RALPH token", { hasRalphToken: true }, "ralph-token"],
    [
      "exhausted missing output",
      { finalMessageMissing: true, finalMessageWaitExhausted: true },
      "missing-final-output",
    ],
    ["shared continuation cap", { continuationsUsed: 10 }, "continuation-cap"],
  ] as const)("settles for %s", (_name, overrides, reason) => {
    expect(decideGraceStep(graceInput(overrides))).toEqual({ action: "settle", reason });
  });

  it("applies the continuation cap before draining fresh subagents", () => {
    expect(decideGraceStep(graceInput({ freshRunningCount: 1, continuationsUsed: 10 }))).toEqual({
      action: "settle",
      reason: "continuation-cap",
    });
  });

  it("can continue while a missing final message wait is not exhausted", () => {
    expect(
      decideGraceStep(graceInput({ finalMessageMissing: true, finalMessageWaitExhausted: false })),
    ).toMatchObject({ action: "continue" });
  });
});

describe("mergeFixDescription branch-set variant", () => {
  const touchedRepos = [
    { kind: "main" as const, path: "/repo", baseBranch: "mine" },
    { kind: "sibling" as const, path: "/work/proga-api", baseBranch: "main" },
  ];

  // Terminal parity: `skills/cook-epic/run-legacy.sh:2855-2876`.
  it("lists every touched repo and lands all-or-nothing", () => {
    const description = mergeFixDescription({
      childId: "child-1",
      branch: "epic/child-1",
      baseBranch: "mine",
      reason: "conflict",
      gateCommand: "vp check",
      pushEnabled: true,
      touchedRepos,
    });
    expect(description).toBe(
      "Branch `epic/child-1` (child `child-1`) failed to land: conflict. The branch set spans several repositories and lands all-or-nothing; the whole set is parked together:\n" +
        "\n" +
        "- this repository (`/repo`, base `mine`)\n" +
        "- sibling `/work/proga-api` (base `main`)\n" +
        "\n" +
        "Repair procedure: you will be on branch `epic/child-1` in an isolated layout, with the same branch checked out in each sibling worktree beside your main worktree. In EVERY repository listed above, merge that repository's base branch into `epic/child-1` and resolve conflicts, then run the project quality gates. Push the branch, close this issue, and note the epic. The coordinator lands the whole set when this issue closes, so leave the base branches and the sibling remotes to it.",
    );
  });

  it("names the gate command for gate-failed sets", () => {
    const description = mergeFixDescription({
      childId: "child-1",
      branch: "epic/child-1",
      baseBranch: "mine",
      reason: "gate-failed",
      gateCommand: "vp check",
      pushEnabled: false,
      touchedRepos,
    });
    expect(description).toContain(
      "The integration gate is: `vp check` — run it and fix what it reports",
    );
    expect(description).toContain("Do not push (disabled this run).");
    expect(description).toContain("leave the base branches and the sibling remotes to it");
  });

  it("omits the main-repo bullet when only siblings have commits", () => {
    const description = mergeFixDescription({
      childId: "child-1",
      branch: "epic/child-1",
      baseBranch: "mine",
      reason: "conflict",
      gateCommand: null,
      pushEnabled: true,
      touchedRepos: [touchedRepos[1]!],
    });
    expect(description).not.toContain("this repository");
    expect(description).toContain("- sibling `/work/proga-api` (base `main`)");
  });
});

describe("conflictFailureDetail", () => {
  it("names the repository, the merge output, the files and the hunks", () => {
    expect(
      conflictFailureDetail({
        repositoryPath: "/repo",
        mergeOutput: "CONFLICT (content): Merge conflict in foo.ts\n",
        files: ["foo.ts", "bar.ts"],
        diff: "@@ -1 +1 @@\n<<<<<<< HEAD",
      }),
    ).toBe(
      "Conflict in `/repo`:\n" +
        "\n" +
        "CONFLICT (content): Merge conflict in foo.ts\n" +
        "\n" +
        "Conflicted files:\n" +
        "- foo.ts\n" +
        "- bar.ts\n" +
        "\n" +
        "Conflict hunks:\n" +
        "@@ -1 +1 @@\n" +
        "<<<<<<< HEAD",
    );
  });

  // An unreadable worktree must not cost the repair the one thing git did say.
  it("keeps the repository line when nothing else could be read", () => {
    expect(
      conflictFailureDetail({
        repositoryPath: "/sib",
        mergeOutput: "Automatic merge failed",
        files: [],
        diff: "",
      }),
    ).toBe("Conflict in `/sib`:\n\nAutomatic merge failed");
  });
});

describe("mergeFixDescription failure detail", () => {
  const base = {
    childId: "child-1",
    branch: "epic/child-1",
    baseBranch: "mine",
    gateCommand: "vp check",
    pushEnabled: true,
  };

  it("indents every line of a multi-line conflict detail", () => {
    const description = mergeFixDescription({
      ...base,
      reason: "conflict",
      failureDetail: "Conflict in `/repo`:\n\nConflicted files:\n- foo.ts",
    });
    expect(description).toContain(
      "\n\nWhat the conflict looked like:\n" +
        "\n" +
        "    Conflict in `/repo`:\n" +
        "\n" +
        "    Conflicted files:\n" +
        "    - foo.ts",
    );
  });

  // A gate diagnosis is one line, and its rendering predates this change.
  it("keeps the one-line gate rendering byte-identical", () => {
    const description = mergeFixDescription({
      ...base,
      reason: "gate-failed",
      failureDetail: "FAIL src/foo.test.ts",
    });
    expect(description.endsWith("\n\nWhat the gate reported:\n\n    FAIL src/foo.test.ts")).toBe(
      true,
    );
  });
});

describe("shouldReclaimMergeSlot", () => {
  const holderOf = (runId: string) => mergeSlotHolder(runId);

  it("frees a slot this run's own hard kill leaked", () => {
    // The finalizer that releases the slot is skipped by a SIGKILL.
    expect(
      shouldReclaimMergeSlot({
        holder: holderOf("run-1"),
        thisRunId: "run-1",
        ownerStatus: null,
      }),
    ).toBe(true);
  });

  for (const status of ["failed", "done", "cancelled", "paused"] as const) {
    it(`frees a slot left by another run that is ${status}`, () => {
      // Run 4f11d14b failed after deferring 602s on a slot held by a run the
      // same crash had killed ten hours earlier.
      expect(
        shouldReclaimMergeSlot({
          holder: holderOf("run-dead"),
          thisRunId: "run-1",
          ownerStatus: status,
        }),
      ).toBe(true);
    });
  }

  it("leaves a slot held by a run that is still going", () => {
    // The safety half: deferring to a live holder is the correct behaviour.
    expect(
      shouldReclaimMergeSlot({
        holder: holderOf("run-live"),
        thisRunId: "run-1",
        ownerStatus: "running",
      }),
    ).toBe(false);
  });

  it("leaves a slot whose owning run this server has never heard of", () => {
    // The terminal coordinator's slot must survive a server boot.
    expect(
      shouldReclaimMergeSlot({
        holder: holderOf("run-elsewhere"),
        thisRunId: "run-1",
        ownerStatus: null,
      }),
    ).toBe(false);
  });

  for (const holder of ["some-other-tool", "cook-epic-", ""]) {
    it(`leaves an unrecognised holder ${JSON.stringify(holder)} alone`, () => {
      expect(shouldReclaimMergeSlot({ holder, thisRunId: "run-1", ownerStatus: "failed" })).toBe(
        false,
      );
    });
  }

  it("round-trips a run id through the holder id", () => {
    expect(parseMergeSlotHolder(mergeSlotHolder("run-1"))).toBe("run-1");
  });
});

describe("runBaseBranch", () => {
  it("never collides with a child branch", () => {
    // Child branches are `epic/<childId>`; child ids contain dots
    // (`t3code-5m4.1`), never a bare `base` segment, so the two namespaces
    // cannot collide.
    expect(runBaseBranch("t3code-5m4")).toBe("epic/t3code-5m4/base");
    expect(runBaseBranch("t3code-5m4")).not.toBe(childBranch("t3code-5m4"));
  });
});

describe("integrationFixTitle (t3code-sha)", () => {
  it("round-trips the operator and base branch through the title", () => {
    const title = integrationFixTitle("epic/t3code-sha/base", "team/mine");
    expect(parseIntegrationFixTitle(title)).toEqual({
      operatorBranch: "team/mine",
      baseBranch: "epic/t3code-sha/base",
    });
  });

  it("is never mistaken for a per-branch merge-fix title", () => {
    // `ParallelEpicLoop` routes any `parseMergeFixTitle` match through
    // `findParkedOriginalChild`, which has no row for a run-level conflict.
    const title = integrationFixTitle("epic/t3code-sha/base", "team/mine");
    expect(parseMergeFixTitle(title)).toBeNull();
  });

  it("a merge-fix title is never mistaken for an integration-fix title", () => {
    const title = mergeFixTitle("epic/child-1", "conflict");
    expect(parseIntegrationFixTitle(title)).toBeNull();
  });
});

describe("integrateOperatorBaseMessage", () => {
  it("names the operator branch it integrates", () => {
    expect(integrateOperatorBaseMessage("team/mine")).toBe("cook-epic: integrate team/mine");
  });
});

describe("integrationFixDescription (t3code-sha)", () => {
  it("names the run's own base branch as the thing to fix, not a per-entry branch", () => {
    const description = integrationFixDescription({
      baseBranch: "epic/t3code-sha/base",
      operatorBranch: "team/mine",
      gateCommand: "vp check",
    });
    expect(description).toContain("base branch `epic/t3code-sha/base`");
    expect(description).toContain(
      "you are already on `epic/t3code-sha/base`, checked out directly",
    );
    expect(description).toContain("merge `team/mine` into it");
    expect(description).toContain("vp check");
    expect(description).not.toContain("undefined");
  });

  it("includes the failure detail and prior-attempts warning when given", () => {
    const description = integrationFixDescription({
      baseBranch: "epic/t3code-sha/base",
      operatorBranch: "team/mine",
      gateCommand: null,
      failureDetail: "CONFLICT (content): Merge conflict in foo.ts",
      priorAttempts: 2,
    });
    expect(description).toContain("What the merge reported");
    expect(description).toContain("CONFLICT (content): Merge conflict in foo.ts");
    expect(description).toContain("already been repaired 2 time(s)");
  });
});

describe("EPIC_RUN_RESTART_RESUME_PROMPT", () => {
  const prompt = (evidence: string | null = "$ git status --porcelain=v1\n M src/a.ts") =>
    EPIC_RUN_RESTART_RESUME_PROMPT({
      issueId: "t3code-y5l.18",
      branch: "epic/t3code-y5l.18",
      worktreePath: "/wt/t3code-y5l.18",
      evidence,
    });

  it("names the child, the branch and the worktree, and says the turn was cut off", () => {
    const text = prompt();
    expect(text).toContain("`t3code-y5l.18`");
    expect(text).toContain("`epic/t3code-y5l.18`");
    expect(text).toContain("`/wt/t3code-y5l.18`");
    expect(text).toContain("The t3code server restarted while you were working.");
    expect(text).toContain("cut off mid-command");
    expect(text).toContain(" M src/a.ts");
    expect(text).toContain("RALPH_MSG");
    expect(text).toContain("RALPH_DONE");
    expect(text).not.toContain("undefined");
  });

  it("carries neither the epic context nor the orientation card", () => {
    // The resume continues a thread that already holds both, so repeating them
    // would bury the one fact this turn exists to deliver.
    const text = prompt();
    expect(text).not.toContain("Epic context");
    expect(text).not.toContain("Cook exactly");
    expect(text).not.toContain("Agent orientation");
  });

  it("says the tree is unreadable rather than implying it is clean", () => {
    const text = prompt(null);
    expect(text).toContain("Do not read that as a clean tree.");
    expect(text).not.toContain("Where you left off");
  });

  it("describes the main checkout when the run gave the worker no worktree", () => {
    const text = EPIC_RUN_RESTART_RESUME_PROMPT({
      issueId: "t3code-y5l.18",
      branch: null,
      worktreePath: null,
      evidence: null,
    });
    expect(text).toContain("main checkout");
    expect(text).toContain("base branch");
    expect(text).not.toContain("null");
  });
});

describe("proveEpicCompletion", () => {
  const openChildIds = ["epic.1", "epic.2"];

  it("refuses to decide while a worker can still close a child", () => {
    expect(
      proveEpicCompletion({
        check: { _tag: "ready-frontier-empty" },
        activeWorkers: 1,
        openChildIds,
      }),
    ).toEqual({ _tag: "unproven" });
  });

  it("completes every check once no open child remains", () => {
    expect(
      proveEpicCompletion({
        check: { _tag: "backlog-empty", readyChildIds: [] },
        activeWorkers: 0,
        openChildIds: [],
      }),
    ).toEqual({ _tag: "complete", lastError: null });
    expect(
      proveEpicCompletion({
        check: { _tag: "ready-frontier-empty" },
        activeWorkers: 0,
        openChildIds: [],
      }),
    ).toEqual({ _tag: "complete", lastError: null });
    expect(
      proveEpicCompletion({
        check: { _tag: "dispatch-cap", maxIterations: 4 },
        activeWorkers: 0,
        openChildIds: [],
      }),
    ).toEqual({ _tag: "complete", lastError: "max iterations (4) reached" });
  });

  it("sends a RALPH_DONE over a ready child back to the dispatcher", () => {
    expect(
      proveEpicCompletion({
        check: { _tag: "backlog-empty", readyChildIds: ["epic.2"] },
        activeWorkers: 0,
        openChildIds,
      }),
    ).toEqual({ _tag: "unproven" });
  });

  it("fails a RALPH_DONE whose open children are all unready", () => {
    const proof = proveEpicCompletion({
      check: { _tag: "backlog-empty", readyChildIds: [] },
      activeWorkers: 0,
      openChildIds,
    });
    expect(proof._tag).toBe("incomplete");
    expect(proof._tag === "incomplete" && proof.lastError).toBe(
      "infra:ready-frontier-stuck: 2 open children remain but none are ready: epic.1, epic.2",
    );
  });

  it("fails the dispatch cap with a stable reason naming the open children", () => {
    const proof = proveEpicCompletion({
      check: { _tag: "dispatch-cap", maxIterations: 4 },
      activeWorkers: 0,
      openChildIds,
    });
    expect(proof._tag).toBe("incomplete");
    expect(proof._tag === "incomplete" && proof.lastError).toBe(
      "limit:max-iterations: dispatch cap (4) reached with 2 open children: epic.1, epic.2",
    );
  });

  it("bounds the child evidence a single row can carry", () => {
    const many = Array.from({ length: MAX_OPEN_CHILD_EVIDENCE + 3 }, (_, index) => `epic.${index}`);
    const proof = proveEpicCompletion({
      check: { _tag: "dispatch-cap", maxIterations: 9 },
      activeWorkers: 0,
      openChildIds: many,
    });
    expect(proof._tag === "incomplete" && proof.lastError).toContain(
      `${many.slice(0, MAX_OPEN_CHILD_EVIDENCE).join(", ")}, +3 more`,
    );
    expect(proof._tag === "incomplete" && proof.lastError).not.toContain(
      many[MAX_OPEN_CHILD_EVIDENCE],
    );
  });
});
