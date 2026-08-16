import type { EpicRunStatus } from "@t3tools/contracts";

import {
  iterationFailureClass,
  type EpicIterationOutcome,
  type EpicIterationOutcomeKind,
  type IterationTurnState,
} from "./ralphProtocol.ts";

/** Generous by default because one unit of epic work can take hours. */
export const DEFAULT_ITERATION_TIMEOUT_MS = 2 * 60 * 60 * 1000;
export const DEFAULT_RETRY_BASE_DELAY_MS = 10_000;
export const DEFAULT_RETRY_MAX_DELAY_MS = 5 * 60 * 1000;
export const DEFAULT_MAX_CONSECUTIVE_FAILURES = 3;
export const DEFAULT_MAX_NO_COMMIT_STREAK = 2;
/**
 * How many consecutive infra failures a run absorbs with backoff before it
 * fails. This is above the child failure budget, but remains finite.
 */
export const DEFAULT_INFRA_FAILURE_BUDGET = 5;
export const DEFAULT_MAX_ITERATIONS = 50;

/**
 * How many times one iteration record may be picked back up after a restart.
 *
 * A record that keeps being interrupted is more likely a crash loop than bad
 * luck, and each resume spends the whole iteration budget again on a session
 * whose transcript is already long. One retry, then the child is dispatched
 * fresh — which is what the pre-resume runner always did.
 *
 * Shared by both restart paths so a terminal cook and the server give an
 * interrupted iteration the same number of second chances.
 */
export const MAX_RESUMES_PER_ITERATION = 1;

/** Terminal parity: `skills/cook-epic/run-legacy.sh:3053-3056`. */
export const landingDescription = (input: {
  readonly pushEnabled: boolean;
  readonly verified: boolean;
}):
  | "gated, landed locally"
  | "landed unverified locally"
  | "gated, pushed, landed"
  | "pushed, landed unverified" => {
  if (input.pushEnabled) {
    return input.verified ? "gated, pushed, landed" : "pushed, landed unverified";
  }
  return input.verified ? "gated, landed locally" : "landed unverified locally";
};

/** Terminal parity: `skills/cook-epic/run-legacy.sh:2675-2681`. */
export const childBranch = (childId: string): string => `epic/${childId}`;

/**
 * The run-owned base branch a parallel run targets when `vcs.runOwnedBaseBranch`
 * is on, instead of sharing the operator's checked-out branch (t3code-5m4).
 *
 * Child branches are `epic/<childId>` with no `/base` suffix, and child ids
 * never contain a bare `base` segment, so this can never collide with one.
 *
 * A nested epic is a different story: if `epic/<epicId>` itself exists as a
 * branch — because this epic was cooked as a child of an outer epic — git's
 * directory/file ref rule makes `epic/<epicId>/base` uncreatable (a ref
 * cannot be both a branch and a directory of branches). `runBaseBranch.ts`'s
 * create-then-retry-as-existence-check treats that git error as a hard
 * failure rather than silent corruption, but the error text names a lock
 * conflict, not the conflicting `epic/<epicId>` branch.
 */
export const runBaseBranch = (epicId: string): string => `epic/${epicId}/base`;

/**
 * The run-scoped git committer email stamped into every iteration worker's
 * spawn environment as `GIT_COMMITTER_EMAIL` (t3code-e6l), and the value
 * `ParallelEpicLoop.iterationCommitted` checks an in-place iteration's new
 * commits against. In-place mode shares the operator's checkout, so a plain
 * head-move check cannot tell the run's own worker from an operator commit
 * made in the same window; this identity can.
 *
 * Deterministic from `runId` alone so both the stamping side and the
 * checking side compute it independently, with nothing to persist or wire
 * through the loop core.
 */
export const runCommitterEmail = (runId: string): string => `epic-run+${runId}@t3code.local`;

/** Terminal parity: `skills/cook-epic/run-legacy.sh:2845-2890`. */
export type MergeParkReason = "conflict" | "gate-failed";

/** Terminal parity: `skills/cook-epic/run-legacy.sh:2882`. */
export const mergeFixTitle = (branch: string, reason: MergeParkReason): string =>
  `Merge fix: land ${branch} (${reason})`;

/** Terminal parity: `skills/cook-epic/run-legacy.sh:2675-2679`. */
const MERGE_FIX_TITLE_PATTERN = /^Merge fix: land ([^ ]+) \((conflict|gate-failed)\)$/;

export const parseMergeFixTitle = (
  title: string,
): { readonly branch: string; readonly reason: MergeParkReason } | null => {
  const match = MERGE_FIX_TITLE_PATTERN.exec(title);
  if (match?.[1] === undefined || match[2] === undefined) return null;
  return { branch: match[1], reason: match[2] as MergeParkReason };
};

/** Terminal parity: `skills/cook-epic/run-legacy.sh:2885`. */
export const parkedBranchKey = (branch: string): string => branch.replaceAll("/", "_");

/** One repository a parked branch set touched. */
export interface MergeFixTouchedRepo {
  readonly kind: "main" | "sibling";
  readonly path: string;
  readonly baseBranch: string;
}

/**
 * What one child's worker reported when its iteration finished — the two
 * clauses of its `RALPH_MSG` line, as the run journal stored them.
 *
 * `null` on either field means the run never recorded it. A report with both
 * `null` says nothing and is dropped by the caller rather than rendered as an
 * empty section.
 */
export interface MergeFixChildReport {
  readonly summary: string | null;
  readonly why: string | null;
}

/** One sibling child that landed on the base branch ahead of a parked one. */
export interface MergeFixLandedChild extends MergeFixChildReport {
  readonly childId: string;
  readonly branch: string;
}

/** The report's non-empty lines, in the order a description renders them. */
const reportLines = (report: MergeFixChildReport): ReadonlyArray<string> => [
  ...(report.summary === null || report.summary.length === 0 ? [] : [report.summary]),
  ...(report.why === null || report.why.length === 0 ? [] : [`Why: ${report.why}`]),
];

/** Terminal parity: `skills/cook-epic/run-legacy.sh:2863-2881` (single repo) and
 * `skills/cook-epic/run-legacy.sh:2843-2879` (branch set). A non-empty
 * `touchedRepos` produces the multi-repo variant; omitting it keeps the
 * single-repo text byte-identical. */
export const mergeFixDescription = (input: {
  readonly childId: string;
  readonly branch: string;
  readonly baseBranch: string;
  readonly reason: MergeParkReason;
  readonly gateCommand: string | null;
  readonly pushEnabled: boolean;
  readonly touchedRepos?: ReadonlyArray<MergeFixTouchedRepo>;
  /** What the gate actually reported, so the repair does not start blind. */
  readonly failureDetail?: string;
  /**
   * What the parked child's own worker reported. Omitted when the run journal
   * has nothing for it, which keeps the description byte-identical to the one
   * a repair got before this existed.
   */
  readonly originalContext?: MergeFixChildReport;
  /** The children that landed on the base branch ahead of this one, newest first. */
  readonly landedContext?: ReadonlyArray<MergeFixLandedChild>;
  /** How many times this branch has already been parked for this reason. */
  readonly priorAttempts?: number;
}): string => {
  const touched = input.touchedRepos ?? [];
  let description: string;
  if (touched.length > 0) {
    const setLines = touched.map((repo) =>
      repo.kind === "main"
        ? `- this repository (\`${repo.path}\`, base \`${repo.baseBranch}\`)`
        : `- sibling \`${repo.path}\` (base \`${repo.baseBranch}\`)`,
    );
    description = `Branch \`${input.branch}\` (child \`${input.childId}\`) failed to land: ${input.reason}. The branch set spans several repositories and lands all-or-nothing; the whole set is parked together:\n\n${setLines.join("\n")}\n\nRepair procedure: you will be on branch \`${input.branch}\` in an isolated layout, with the same branch checked out in each sibling worktree beside your main worktree. In EVERY repository listed above, merge that repository's base branch into \`${input.branch}\` and resolve conflicts`;
  } else {
    description = `Branch \`${input.branch}\` (child \`${input.childId}\`) failed to land on \`${input.baseBranch}\`: ${input.reason}.\n\nRepair procedure: you will be on branch \`${input.branch}\` in an isolated worktree. Merge \`${input.baseBranch}\` into it, resolve conflicts`;
  }
  description +=
    input.reason === "conflict"
      ? ", then run the project quality gates"
      : `. The integration gate is: \`${input.gateCommand ?? ""}\` — run it and fix what it reports`;
  description += input.pushEnabled
    ? ". Push the branch, close this issue, and note the epic."
    : ". Do not push (disabled this run). Close this issue and note the epic.";
  // Stated as ownership rather than prohibition: the coordinator owns landing,
  // and a branch merged into base by hand corrupts the merge queue's view of
  // what it has accepted.
  description +=
    touched.length > 0
      ? " The coordinator lands the whole set when this issue closes, so leave the base branches and the sibling remotes to it."
      : ` The coordinator lands this branch when the issue closes, so leave \`${input.baseBranch}\` to it.`;
  if (input.reason === "conflict") {
    // Two reasons the repair agent needs to know: hunks it never resolved may
    // already be resolved when it opens the file, and its own resolution is
    // worth getting right because the drain will replay it verbatim.
    description +=
      " git rerere is on, so a conflict this run already resolved once comes back resolved, and" +
      " the resolution you commit here is replayed on every later merge of the same hunks.";
  }
  if (input.failureDetail !== undefined && input.failureDetail.length > 0) {
    const heading =
      input.reason === "conflict" ? "What the conflict looked like" : "What the gate reported";
    // Indented per line, not just at the front: a gate diagnosis is one line,
    // but conflict detail is a block, and only indenting its first line would
    // drop the rest out of the code block and reflow the hunks as prose.
    const body = input.failureDetail
      .split("\n")
      .map((line) => (line.length > 0 ? `    ${line}` : ""))
      .join("\n");
    description += `\n\n${heading}:\n\n${body}`;
  }
  // Intent, not diff. A repair agent resolving someone else's conflict has to
  // guess which side meant what, and the two sides are exactly the parked
  // child and the children that landed while it waited — so both say, in their
  // own author's words, what they were for.
  const original = input.originalContext === undefined ? [] : reportLines(input.originalContext);
  if (original.length > 0) {
    description += `\n\nWhat the original author built:\n\n${original
      .map((line) => `    ${line}`)
      .join("\n")}`;
  }
  const landed = (input.landedContext ?? []).filter((child) => reportLines(child).length > 0);
  if (landed.length > 0) {
    const entries = landed.map((child) => {
      const [first, ...rest] = reportLines(child);
      return [
        `    - \`${child.branch}\` (\`${child.childId}\`): ${first ?? ""}`,
        ...rest.map((line) => `      ${line}`),
      ].join("\n");
    });
    description += `\n\nWhat landed on \`${input.baseBranch}\` since, newest first:\n\n${entries.join("\n")}`;
  }
  if (input.priorAttempts !== undefined && input.priorAttempts > 0) {
    // Repeating a repair that already failed is the failure mode this text
    // exists to prevent: the branch may be innocent.
    description +=
      `\n\nThis branch has already been repaired ${String(input.priorAttempts)} time(s) for the ` +
      `same reason and still fails. Before changing it again, confirm the failure is actually ` +
      `caused by this branch — reproduce the gate on \`${input.baseBranch}\` with nothing merged. ` +
      `If it fails there too, do not "fix" this branch: report that on the epic and close this issue.`;
  }
  return description;
};

/**
 * The conflict evidence a merge-fix child needs, composed from what the trial
 * merge printed and what it left behind in the worktree.
 *
 * A conflict park used to reach its fix child carrying nothing at all, so the
 * repair agent re-derived the conflict from scratch. `files` and `diff` are
 * empty when the port could not read the worktree; the merge output alone is
 * still worth sending.
 */
export const conflictFailureDetail = (input: {
  readonly repositoryPath: string;
  readonly mergeOutput: string;
  readonly files: ReadonlyArray<string>;
  readonly diff: string;
}): string => {
  const sections = [`Conflict in \`${input.repositoryPath}\`:`];
  const output = input.mergeOutput.trim();
  if (output.length > 0) sections.push(output);
  if (input.files.length > 0) {
    sections.push(`Conflicted files:\n${input.files.map((file) => `- ${file}`).join("\n")}`);
  }
  const diff = input.diff.trim();
  if (diff.length > 0) sections.push(`Conflict hunks:\n${diff}`);
  return sections.join("\n\n");
};

/** How many conflicting paths a radar nudge names before it stops listing. */
export const CONFLICT_RADAR_PROMPT_FILE_LIMIT = 20;

/**
 * What the conflict radar says to a worker whose branch has started to
 * conflict with the base branch while it is still working.
 *
 * The radar reads with `git merge-tree`, so this is the conflict the merge
 * queue would hit later, named before the author has forgotten why they wrote
 * the code. It asks for a resolution, not a rebase: the queue trial-merges the
 * branch, and a rebase mid-turn would rewrite commits the run already recorded.
 */
export const conflictRadarNudgePrompt = (input: {
  readonly baseBranch: string;
  readonly conflicts: ReadonlyArray<string>;
}): string => {
  const listed = input.conflicts.slice(0, CONFLICT_RADAR_PROMPT_FILE_LIMIT);
  const omitted = input.conflicts.length - listed.length;
  const files = [
    ...listed.map((file) => `- ${file}`),
    ...(omitted > 0 ? [`- (${String(omitted)} more)`] : []),
  ].join("\n");
  return `Epic runner: your branch now conflicts with \`${input.baseBranch}\` in these files:\n\n${files}\n\nA sibling child landed work that overlaps yours. Merge \`${input.baseBranch}\` into your branch now and resolve those conflicts while you still hold the context — keep both intents, do not discard the landed side. Re-run your focused checks after the resolution, commit it, then carry on with the child you were cooking. Do not merge your branch into \`${input.baseBranch}\`; the coordinator lands it.`;
};

/** Terminal parity: `skills/cook-epic/run-legacy.sh:2958`. */
export const trialMergeMessage = (branch: string, childId: string): string =>
  `cook-epic: merge ${branch} (${childId})`;

const TRIAL_MERGE_MESSAGE_PATTERN = /^cook-epic: merge (\S+) \(([^)]+)\)$/;

/**
 * Recover which child a landed merge commit carried, from its subject alone.
 *
 * Every landing writes a {@link trialMergeMessage}, so the base branch's own
 * history is the record of what landed and in what order. Nothing else stores
 * that per branch, and a parked branch needs it to say which siblings it is
 * now being merged against.
 */
export const parseTrialMergeMessage = (
  subject: string,
): { readonly branch: string; readonly childId: string } | null => {
  const match = TRIAL_MERGE_MESSAGE_PATTERN.exec(subject);
  if (match?.[1] === undefined || match[2] === undefined) return null;
  return { branch: match[1], childId: match[2] };
};

/**
 * The trial-merge commit message for continuously integrating the operator's
 * branch into a run's owned base branch (t3code-sha).
 */
export const integrateOperatorBaseMessage = (operatorBranch: string): string =>
  `cook-epic: integrate ${operatorBranch}`;

/**
 * Title for the one run-level child that repairs a conflict merging the
 * operator's branch into the run's owned base branch (t3code-sha).
 *
 * Deliberately NOT `mergeFixTitle`'s shape ("Merge fix: land X (reason)"):
 * `ParallelEpicLoop` treats any title matching `MERGE_FIX_TITLE_PATTERN` as a
 * per-branch park repair and looks up its original parked entry by branch
 * (`findParkedOriginalChild`) — this child parks no queue entry and has no
 * original branch, so reusing that shape would misroute it. `baseBranch`
 * appears in the title so a human scanning the backlog sees at a glance which
 * run base is stuck; the dispatcher itself re-resolves the run's own base
 * branch rather than parsing it back out.
 */
export const integrationFixTitle = (baseBranch: string, operatorBranch: string): string =>
  `Merge fix: integrate ${operatorBranch} into ${baseBranch}`;

const INTEGRATION_FIX_TITLE_PATTERN = /^Merge fix: integrate (\S+) into (\S+)$/;

/** Recognise an `integrationFixTitle`, so dispatch can route it distinctly from `parseMergeFixTitle`. */
export const parseIntegrationFixTitle = (
  title: string,
): { readonly operatorBranch: string; readonly baseBranch: string } | null => {
  const match = INTEGRATION_FIX_TITLE_PATTERN.exec(title);
  if (match?.[1] === undefined || match[2] === undefined) return null;
  return { operatorBranch: match[1], baseBranch: match[2] };
};

/**
 * Body for the run-level integration-conflict repair child (t3code-sha).
 *
 * Names the run's own base branch as the thing to fix — not the entry-park
 * `mergeFixDescription`'s `baseBranch`, which for this conflict never
 * contains the operator's commits and gives the child nothing to resolve.
 * The child is dispatched on that exact base branch, already checked out
 * (`EpicRunnerPoolPorts.ts`/`TerminalPoolWorkspace.ts` route
 * `parseIntegrationFixTitle` to it directly, the same reused-branch dispatch
 * a per-entry merge-fix child gets), so resolving the conflict and
 * committing is the whole fix — there is no separate branch to land.
 */
export const integrationFixDescription = (input: {
  readonly baseBranch: string;
  readonly operatorBranch: string;
  readonly gateCommand: string | null;
  /** What the conflicting merge reported, so the repair does not start blind. */
  readonly failureDetail?: string;
  /** How many times this exact conflict has already been repaired. */
  readonly priorAttempts?: number;
}): string => {
  let description =
    `This run continuously integrates the operator's branch \`${input.operatorBranch}\` into its own ` +
    `base branch \`${input.baseBranch}\` before every landing, and that merge just conflicted.\n\n` +
    `Repair procedure: you are already on \`${input.baseBranch}\`, checked out directly (not a copy) ` +
    `— merge \`${input.operatorBranch}\` into it and resolve the conflicts right here.\n\n` +
    `Two rules while you do:\n` +
    `- Re-run the gate after resolving${
      input.gateCommand === null ? "" : ` (\`${input.gateCommand}\`)`
    }; a merge that "resolves" without a green gate is not resolved.\n` +
    `- Never resolve by deleting a test or dropping one side wholesale; the losing side's intent has ` +
    `to survive the merge.\n\n`;
  description +=
    "Commit the resolved merge here once the gate is green, close this issue, and note the epic. " +
    `Committing here already advances \`${input.baseBranch}\` — there is no separate branch for the ` +
    "coordinator to land, so do not push it yourself; the next landing carries it forward.";
  if (input.failureDetail !== undefined && input.failureDetail.length > 0) {
    description += `\n\nWhat the merge reported:\n\n    ${input.failureDetail}`;
  }
  if (input.priorAttempts !== undefined && input.priorAttempts > 0) {
    description +=
      `\n\nThis conflict has already been repaired ${String(input.priorAttempts)} time(s) and still ` +
      `recurs. Before changing anything, confirm the conflict is real and not a symptom of something ` +
      `else; if it is not resolvable here, report that on the epic and close this issue.`;
  }
  return description;
};

/** Terminal parity: integration branch creation near `skills/cook-epic/run-legacy.sh:873-881`. */
export const INTEGRATION_BRANCH_PREFIX = "cook-epic-integration-";
export const integrationBranch = (runId: string): string => `${INTEGRATION_BRANCH_PREFIX}${runId}`;

/**
 * The merge-slot holder id for one run, on every surface.
 *
 * Shared because two different things now depend on it being the same string:
 * the drain acquires under it, and the boot reclaim releases a leaked slot
 * only when the recorded holder matches it exactly. Drift between the two
 * would mean either never reclaiming, or reclaiming another run's slot.
 */
const MERGE_SLOT_HOLDER_PREFIX = "cook-epic-";

export const mergeSlotHolder = (runId: string): string => `${MERGE_SLOT_HOLDER_PREFIX}${runId}`;

/**
 * The run id inside a merge-slot holder, or `null` for a holder this does not
 * recognise.
 *
 * A holder that names a run is evidence: the boot path can ask whether that
 * run is still going and free a slot whose owner is provably finished. A
 * holder it cannot parse — the terminal coordinator's, another tool's — has to
 * be left alone, because nothing about it can be proven.
 */
/**
 * Whether a boot may free the merge slot it found held.
 *
 * Two things count as proof, and nothing else does. The holder is this run's
 * own id, so a hard kill skipped the finalizer that would have released it.
 * Or the holder names a different run that has already finished — run 4f11d14b
 * deferred for 602s and failed on a slot held by a run the same crash had
 * killed ten hours earlier, and a dead run's slot blocks every later drain
 * just as thoroughly as one's own.
 *
 * `ownerStatus` is `null` when this server has no row for the owning run. That
 * is not evidence of anything: the terminal coordinator's slot must survive a
 * server boot untouched.
 */
export const shouldReclaimMergeSlot = (input: {
  readonly holder: string;
  readonly thisRunId: string;
  readonly ownerStatus: EpicRunStatus | null;
}): boolean => {
  const ownerRunId = parseMergeSlotHolder(input.holder);
  if (ownerRunId === null) return false;
  if (ownerRunId === input.thisRunId) return true;
  return input.ownerStatus !== null && input.ownerStatus !== "running";
};

export const parseMergeSlotHolder = (holder: string): string | null => {
  const runId = holder.startsWith(MERGE_SLOT_HOLDER_PREFIX)
    ? holder.slice(MERGE_SLOT_HOLDER_PREFIX.length)
    : "";
  return runId.length > 0 ? runId : null;
};

/**
 * The base prompt for one epic iteration.
 *
 * Kept to what a worker cannot work out for itself: that its turn is the whole
 * iteration, what the coordinator counts as done, and the two lines the
 * coordinator parses. How to implement, what to check, and house style come
 * from the repository and the orientation card, which are injected at dispatch
 * — restating them here would just be a second, staler copy.
 */
export const epicRunIterationPrompt = (input: { readonly pushEnabled: boolean }): string => {
  const land = input.pushEnabled
    ? "commit and push it"
    : "commit it locally — pushing is disabled for this run";
  return `Cook one child of this epic end-to-end: claim it in bd, implement it, satisfy yourself that it works, ${land}, close the child, and record the outcome on the epic. Stop after one child.

Your turn is the whole iteration. Nothing re-invokes you once it ends, and anything still in flight when you stop — a background job, a subagent, a watchdog — dies with it, so finish the work inside the turn.

End the turn with exactly one line:

RALPH_MSG: {"summary":"<what you built, one clause>","why":"<why it was needed, one clause>"}

or, if the epic has no work left:

RALPH_DONE`;
};

/** The follow-up turn used after an iteration's background agents settle. */
export const EPIC_RUN_CONTINUATION_PROMPT = `Your background tasks finished. Finish the child and end the turn with the RALPH_MSG line, or RALPH_DONE if no work remains.`;

export const EPIC_RUN_STALLED_PROGRESS_PROMPT = `Your turn ended while the work was unfinished. Complete the child and end the turn with the RALPH_MSG line, or RALPH_DONE if no work remains.`;

/**
 * The turn handed to a worker whose iteration is being continued after the
 * server process died under it.
 *
 * It deliberately repeats neither the epic context nor the orientation card:
 * this is a continuation of the SAME conversation, which still holds both in
 * its first message. What the agent cannot know by itself is that time passed
 * and its last command was cut off mid-flight, so that is all this says.
 */
export const EPIC_RUN_RESTART_RESUME_PROMPT = (input: {
  readonly issueId: string;
  readonly branch: string | null;
  readonly worktreePath: string | null;
  /** Bounded `git status` / `git diff --stat` output, or `null` when unreadable. */
  readonly evidence: string | null;
}): string => {
  const where =
    input.worktreePath === null
      ? "You are in the run's main checkout"
      : `Your worktree is \`${input.worktreePath}\``;
  const branch =
    input.branch === null
      ? "you are on the run's base branch"
      : `your branch is \`${input.branch}\``;
  const evidence =
    input.evidence === null
      ? "The git probes for this worktree failed, so there is no snapshot below. Do not read that as a clean tree."
      : `Where you left off, read at restart:\n\n${input.evidence}`;
  return `The t3code server restarted while you were working. This is the same session, the same thread and the same worktree, so the conversation above is your own and the uncommitted changes here are your own work.

You still own \`${input.issueId}\`. ${where}, and ${branch}.

Your previous turn was cut off mid-command. Nothing you started is proven to have finished: not a build, not a test run, not a commit, not a push, not a \`bd\` write. Assume none of it landed until you check. Re-run whatever did not complete.

${evidence}

Run \`git status\` and \`git diff\` yourself before you change anything, so you are working from the tree as it is now.

Then finish the child end-to-end per the instructions you were given, and end the turn with the RALPH_MSG line, or RALPH_DONE if no work remains.`;
};

/**
 * The preamble for the iteration that takes over a worktree whose own session
 * could NOT be resumed.
 *
 * The difference from {@link EPIC_RUN_RESTART_RESUME_PROMPT} is whose work the
 * tree holds. A resumed worker reads its own conversation above the prompt, so
 * it is told "this is you". This agent has an empty thread and inherits a
 * stranger's half-finished tree, so it is told to review the changes and
 * decide what to keep. The caller splices this ahead of the ordinary
 * iteration instructions, because the new thread has no history at all.
 */
export const EPIC_RUN_RESTART_HANDOFF_PROMPT = (input: {
  readonly issueId: string;
  readonly branch: string | null;
  readonly worktreePath: string | null;
  /** Bounded `git status` / `git diff --stat` output, or `null` when unreadable. */
  readonly evidence: string | null;
}): string => {
  const where =
    input.worktreePath === null
      ? "You are in the run's main checkout"
      : `Your worktree is \`${input.worktreePath}\``;
  const branch =
    input.branch === null
      ? "you are on the run's base branch"
      : `your branch is \`${input.branch}\``;
  const evidence =
    input.evidence === null
      ? "The git probes for this worktree failed, so there is no snapshot below. Do not read that as a clean tree."
      : `What that agent left behind, read at handover:\n\n${input.evidence}`;
  return `The t3code server restarted while another agent was working on \`${input.issueId}\`, and its session could not be continued. You are a new agent taking that work over. The conversation above is not that agent's; you cannot see what it was doing, only what it left on disk.

You now own \`${input.issueId}\`. ${where}, and ${branch}. The uncommitted changes here are that agent's work, not yours.

Nothing it started is proven to have finished: not a build, not a test run, not a commit, not a push, not a \`bd\` write. Assume none of it landed until you check.

${evidence}

Run \`git status\` and \`git diff\` yourself first. Review those changes, decide what to keep and what to throw away, then finish the child end-to-end from there.`;
};

/** How long the runner waits for a still-running subagent before grace ends. */
export const DEFAULT_SUBAGENT_GRACE_TIMEOUT_MS = 15 * 60 * 1_000;
export const DEFAULT_MAX_GRACE_CONTINUATIONS = 10;

export const backoffDelayMs = (
  consecutiveFailures: number,
  retryBaseDelayMs: number,
  retryMaxDelayMs: number,
): number => Math.min(retryBaseDelayMs * 2 ** (consecutiveFailures - 1), retryMaxDelayMs);

/** The stable suffix used by the persisted iteration failure vocabulary. */
export const failureReasonForOutcome = (kind: EpicIterationOutcomeKind): string | null => {
  switch (kind) {
    case "done":
    case "backlog-empty":
      return null;
    case "no-commit":
      return "no-commit-child-open";
    case "timeout":
      return "timeout";
    case "error":
      return "turn-error";
    case "protocol-error":
      return "protocol-error";
    case "blocked":
      return "blocked";
  }
};

export interface PersistedFailureReasonInput {
  readonly iterationStatus: "completed" | "failed";
  readonly dispatchFailed: boolean;
  readonly evidenceFailureReason: string | null;
  readonly outcome: EpicIterationOutcome;
}

/**
 * Build the complete persisted failure reason in its required override order.
 *
 * The resume family (`EPIC_RUN_FAILURE_RESUME_UNSUPPORTED` / `_BLOCKED` /
 * `_FAILED`) never comes through here. The restart path assigns those directly
 * to the row it could not continue, because no turn ever ran and so there is
 * no `EpicIterationOutcome` to classify. Do not invent an
 * `EpicIterationOutcomeKind` for them.
 */
export const persistedFailureReason = (input: PersistedFailureReasonInput): string | null => {
  if (input.iterationStatus === "completed") {
    return null;
  }
  const reason = input.dispatchFailed
    ? "dispatch-failed"
    : (input.evidenceFailureReason ??
      input.outcome.failureReason ??
      failureReasonForOutcome(input.outcome.kind));
  const failureClass = iterationFailureClass(input.outcome.kind);
  return failureClass === null || reason === null ? null : `${failureClass}:${reason}`;
};

/** The prefix {@link persistedFailureReason} writes for the `child` class. */
export const CHILD_FAILURE_REASON_PREFIX = "child:";

/** The persisted iteration fields that decide whether a row charged a child. */
export interface ChildAttemptHistoryEntry {
  readonly issueId: string | null;
  readonly turnStatus: "running" | "completed" | "failed" | "abandoned";
  readonly failureReason: string | null;
}

/**
 * Rebuild the per-child attempt budgets a previous process had spent.
 *
 * The budget is in-memory in both loops, so before this a restart handed every
 * child a fresh `maxAttemptsPerChild`: a child that had already burned its
 * budget got the whole of it again, and a wedged child could loop for as long
 * as the run kept restarting.
 *
 * A row charges its child exactly when the live boundary would have charged
 * it, and the durable row already says so: `persistedFailureReason` writes the
 * failure class as the reason's prefix, so a terminal `failed` row prefixed
 * `child:` is one spent attempt and nothing else is. That excludes, by
 * construction, every category the budget must not absorb — an `infra:` row,
 * a `running` row a restart or a cancellation abandoned, an `abandoned` row,
 * and a `completed` row whose no-commit turn closed its child anyway.
 */
export const childAttemptsFromHistory = (
  iterations: ReadonlyArray<ChildAttemptHistoryEntry>,
): ReadonlyMap<string, number> => {
  const attempts = new Map<string, number>();
  for (const iteration of iterations) {
    if (iteration.issueId === null || iteration.turnStatus !== "failed") continue;
    if (iteration.failureReason?.startsWith(CHILD_FAILURE_REASON_PREFIX) !== true) continue;
    attempts.set(iteration.issueId, (attempts.get(iteration.issueId) ?? 0) + 1);
  }
  return attempts;
};

/**
 * The ready frontier of one epic, partitioned for the parallel loop.
 *
 * `bd ready --parent` owns the scope, but some rows omit the parent value,
 * which decodes to null and is usable. Only an explicit parent naming another
 * issue rejects the row.
 */
export type ReadyFrontierPartition<Issue> =
  | { readonly _tag: "empty" }
  | { readonly _tag: "unrecognised"; readonly candidateIds: ReadonlyArray<string> }
  | { readonly _tag: "children"; readonly issues: ReadonlyArray<Issue> };

export const partitionReadyChildren = <Issue extends { readonly id: string }>(
  epicId: string,
  issues: ReadonlyArray<Issue & { readonly parentId: string | null }>,
): ReadyFrontierPartition<Issue> => {
  if (issues.length === 0) return { _tag: "empty" };
  const direct = issues.filter((issue) => issue.parentId === null || issue.parentId === epicId);
  return direct.length === 0
    ? { _tag: "unrecognised", candidateIds: issues.map((issue) => issue.id) }
    : { _tag: "children", issues: direct };
};

export interface IterationBoundaryLimits {
  readonly maxConsecutiveFailures: number;
  readonly maxNoCommitStreak: number;
  readonly infraFailureBudget: number;
  readonly retryBaseDelayMs: number;
  readonly retryMaxDelayMs: number;
}

export interface IterationBoundaryInput {
  readonly runStatus: EpicRunStatus;
  readonly consecutiveFailures: number;
  readonly noCommitStreak: number;
  readonly infraStreak: number;
  readonly lastError: string | null;
  readonly outcome: EpicIterationOutcome;
  readonly noCommitChildClosed: boolean;
  readonly providerFallbackApplied: boolean;
  /** Backlog selection can finish without dispatching a provider turn. */
  readonly providerTurnDispatched: boolean;
  readonly limits: IterationBoundaryLimits;
}

export interface IterationBoundaryDecision {
  readonly action: "stop" | "continue";
  readonly delayMs: number;
  /** `null` leaves the run's current status unchanged. */
  readonly nextStatus: EpicRunStatus | null;
  readonly nextConsecutiveFailures: number;
  readonly nextNoCommitStreak: number;
  readonly nextInfraStreak: number;
  readonly lastError: string | null;
}

/**
 * Decide one iteration boundary without reading or writing runner state.
 * Branch order is part of the terminal and server parity contract.
 */
export const decideIterationBoundary = (
  input: IterationBoundaryInput,
): IterationBoundaryDecision => {
  const unchanged = {
    delayMs: 0,
    nextStatus: null,
    nextConsecutiveFailures: input.consecutiveFailures,
    nextNoCommitStreak: input.noCommitStreak,
    nextInfraStreak: input.infraStreak,
    lastError: input.lastError,
  } as const;

  if (input.providerFallbackApplied) {
    return {
      ...unchanged,
      action: input.runStatus === "running" ? "continue" : "stop",
      nextInfraStreak: 0,
    };
  }

  if (input.runStatus !== "running") {
    return { ...unchanged, action: "stop" };
  }

  if (input.outcome.kind === "backlog-empty") {
    return {
      ...unchanged,
      action: "stop",
      nextStatus: "done",
      nextConsecutiveFailures: 0,
      ...(input.providerTurnDispatched ? { nextNoCommitStreak: 0, nextInfraStreak: 0 } : undefined),
      lastError: null,
    };
  }

  if (input.outcome.kind === "done") {
    return {
      ...unchanged,
      action: "continue",
      nextConsecutiveFailures: 0,
      nextNoCommitStreak: 0,
      nextInfraStreak: 0,
      lastError: null,
    };
  }

  if (input.noCommitChildClosed) {
    return {
      ...unchanged,
      action: "continue",
      nextConsecutiveFailures: 0,
      nextNoCommitStreak: 0,
      nextInfraStreak: 0,
      lastError: null,
    };
  }

  if (input.outcome.kind === "no-commit") {
    const nextNoCommitStreak = input.noCommitStreak + 1;
    const exhausted = nextNoCommitStreak >= input.limits.maxNoCommitStreak;
    return {
      ...unchanged,
      action: exhausted ? "stop" : "continue",
      nextStatus: exhausted ? "failed" : null,
      nextConsecutiveFailures: 0,
      nextNoCommitStreak,
      lastError: exhausted ? `gutter: ${nextNoCommitStreak} iterations without a commit` : null,
    };
  }

  if (iterationFailureClass(input.outcome.kind) === "infra") {
    const nextInfraStreak = input.infraStreak + 1;
    const exhausted = nextInfraStreak >= input.limits.infraFailureBudget;
    const reason = input.outcome.detail ?? input.outcome.kind;
    return {
      ...unchanged,
      action: exhausted ? "stop" : "continue",
      delayMs: backoffDelayMs(
        nextInfraStreak,
        input.limits.retryBaseDelayMs,
        input.limits.retryMaxDelayMs,
      ),
      nextStatus: exhausted ? "failed" : null,
      nextInfraStreak,
      lastError: exhausted
        ? `infra: ${nextInfraStreak} consecutive infrastructure failures; last: ${reason}`
        : reason,
    };
  }

  const nextConsecutiveFailures = input.consecutiveFailures + 1;
  const exhausted = nextConsecutiveFailures >= input.limits.maxConsecutiveFailures;
  return {
    ...unchanged,
    action: exhausted ? "stop" : "continue",
    delayMs: backoffDelayMs(
      nextConsecutiveFailures,
      input.limits.retryBaseDelayMs,
      input.limits.retryMaxDelayMs,
    ),
    nextStatus: exhausted ? "failed" : null,
    nextConsecutiveFailures,
    lastError: input.outcome.detail ?? input.outcome.kind,
  };
};

/** How many open child ids a completion failure names before it summarises. */
export const MAX_OPEN_CHILD_EVIDENCE = 5;

/** Bound the open-child list so one stuck epic cannot write an unbounded row. */
export const describeOpenChildren = (openChildIds: ReadonlyArray<string>): string => {
  const named = openChildIds.slice(0, MAX_OPEN_CHILD_EVIDENCE);
  const remaining = openChildIds.length - named.length;
  return remaining > 0 ? `${named.join(", ")}, +${remaining} more` : named.join(", ");
};

/**
 * A merge-queue entry that has not landed on the base branch, as the
 * completion proof (t3code-xig) reads it back from persisted queue state:
 * `queued` and `draining` are still on their way through the drain, and
 * `parked` sits behind a merge-fix child. A landed entry is deleted by the
 * store's `complete`, so it never appears here.
 */
export interface UnlandedMergeEntry {
  readonly childId: string;
  readonly branch: string;
  readonly status: "queued" | "draining" | "parked";
}

/** How many unlanded merge entries a completion failure names before it summarises. */
export const MAX_UNLANDED_MERGE_EVIDENCE = 5;

/** Bound the unlanded-entry list the same way {@link describeOpenChildren} bounds children. */
export const describeUnlandedMergeEntries = (
  entries: ReadonlyArray<UnlandedMergeEntry>,
): string => {
  const named = entries.slice(0, MAX_UNLANDED_MERGE_EVIDENCE);
  const remaining = entries.length - named.length;
  const rendered = named
    .map((entry) => `${entry.childId} (${entry.branch}, ${entry.status})`)
    .join(", ");
  return remaining > 0 ? `${rendered}, +${remaining} more` : rendered;
};

/**
 * The question the pool loop is asking when it is about to write a terminal
 * status. Each case carries exactly the evidence its answer needs.
 */
export type EpicCompletionCheck =
  /** A worker reported `RALPH_DONE`; `readyChildIds` is the re-read frontier. */
  | { readonly _tag: "backlog-empty"; readonly readyChildIds: ReadonlyArray<string> }
  /** The frontier came back empty with no worker left to change it. */
  | { readonly _tag: "ready-frontier-empty" }
  /** The run spent its dispatch budget. */
  | { readonly _tag: "dispatch-cap"; readonly maxIterations: number };

export interface EpicCompletionProofInput {
  readonly check: EpicCompletionCheck;
  /** Workers still running. Any one of them can still close a child. */
  readonly activeWorkers: number;
  /** Every still-open child of the epic, re-read for this decision. */
  readonly openChildIds: ReadonlyArray<string>;
  /**
   * Merge-queue entries not yet landed, re-read for this decision the same
   * way `openChildIds` is. Beads and the merge queue are two different
   * ledgers: closing a child and landing its branch are two different
   * writes, and a merge-fix child can close its own issue — with Beads
   * showing nothing open — while the branch it was meant to land stays
   * parked or queued. Always empty for a sequential run, which never
   * enqueues. `null` when the merge-queue store itself could not be read:
   * unreadable is not the same as empty, so it must not fail-open into
   * `complete` (t3code-e46) — see `proveEpicCompletion`.
   */
  readonly unlandedMergeEntries: ReadonlyArray<UnlandedMergeEntry> | null;
}

export type EpicCompletionProof =
  /** No open child remains: the run may finish. */
  | { readonly _tag: "complete"; readonly lastError: string | null }
  /** Open children remain and nothing can still close them. */
  | { readonly _tag: "incomplete"; readonly lastError: string }
  /** Not proven either way: keep running. */
  | { readonly _tag: "unproven" };

/**
 * Prove a run may write `done`, from Beads and the merge queue together.
 *
 * Every terminal write of the pool loop comes through here, so no path can
 * report `done` over an open child: not a worker's `RALPH_DONE`, not an empty
 * frontier, not the dispatch cap. A worker's claim is never the proof — the
 * re-read open-child list is. Beads alone is not enough either (t3code-xig):
 * a merge-fix child can close with Beads clean while the branch it was meant
 * to land still sits parked or queued, so `unlandedMergeEntries` gets the
 * same veto over `complete` that `openChildIds` does.
 */
export const proveEpicCompletion = (input: EpicCompletionProofInput): EpicCompletionProof => {
  // A live sibling can still close the last child, so nothing is decided while
  // one runs. The scheduler asks again once the pool empties.
  if (input.activeWorkers > 0) return { _tag: "unproven" };

  if (input.openChildIds.length === 0) {
    // An unreadable merge-queue store answers neither "landed" nor
    // "unlanded" — treat it as not yet provable and let the next tick
    // retry, the same way a live worker keeps the answer open.
    if (input.unlandedMergeEntries === null) return { _tag: "unproven" };
    if (input.unlandedMergeEntries.length > 0) {
      const count = input.unlandedMergeEntries.length;
      return {
        _tag: "incomplete",
        lastError: `infra:merge-queue-unlanded: ${count} merge-queue ${count === 1 ? "entry has" : "entries have"} not landed: ${describeUnlandedMergeEntries(input.unlandedMergeEntries)}`,
      };
    }
    return {
      _tag: "complete",
      lastError:
        input.check._tag === "dispatch-cap"
          ? `max iterations (${input.check.maxIterations}) reached`
          : null,
    };
  }

  const open = input.openChildIds.length;
  const evidence = describeOpenChildren(input.openChildIds);
  if (input.check._tag === "dispatch-cap") {
    return {
      _tag: "incomplete",
      lastError: `limit:max-iterations: dispatch cap (${input.check.maxIterations}) reached with ${open} open children: ${evidence}`,
    };
  }
  // `RALPH_DONE` over a ready child is a wrong claim, not a stuck epic: the
  // next dispatch pass picks that child up.
  if (input.check._tag === "backlog-empty" && input.check.readyChildIds.length > 0) {
    return { _tag: "unproven" };
  }
  return {
    _tag: "incomplete",
    lastError: `infra:ready-frontier-stuck: ${open} open children remain but none are ready: ${evidence}`,
  };
};

export interface GraceDecisionInput {
  readonly headMoved: boolean;
  readonly turnStatus: IterationTurnState;
  readonly freshRunningCount: number;
  /** `null` means one or both worktree fingerprints were unavailable. */
  readonly fingerprintChanged: boolean | null;
  readonly hasRalphToken: boolean;
  readonly finalMessageMissing: boolean;
  readonly finalMessageWaitExhausted: boolean;
  readonly continuationsUsed: number;
  readonly maxGraceContinuations: number;
}

export type GraceDecision =
  | {
      readonly action: "settle";
      readonly reason:
        | "head-moved"
        | "turn-not-completed"
        | "continuation-cap"
        | "fingerprint-not-changed"
        | "ralph-token"
        | "missing-final-output";
    }
  | {
      readonly action: "awaitDrain";
      readonly prompt: typeof EPIC_RUN_CONTINUATION_PROMPT;
      readonly nextContinuationCount: number;
    }
  | {
      readonly action: "continue";
      readonly prompt: typeof EPIC_RUN_STALLED_PROGRESS_PROMPT;
      readonly nextContinuationCount: number;
    };

/** Decide whether a settled turn earns one bounded grace continuation. */
export const decideGraceStep = (input: GraceDecisionInput): GraceDecision => {
  if (input.headMoved) {
    return { action: "settle", reason: "head-moved" };
  }
  if (input.turnStatus !== "completed") {
    return { action: "settle", reason: "turn-not-completed" };
  }

  if (input.freshRunningCount > 0) {
    if (input.continuationsUsed >= input.maxGraceContinuations) {
      return { action: "settle", reason: "continuation-cap" };
    }
    return {
      action: "awaitDrain",
      prompt: EPIC_RUN_CONTINUATION_PROMPT,
      nextContinuationCount: input.continuationsUsed + 1,
    };
  }

  if (input.fingerprintChanged !== true) {
    return { action: "settle", reason: "fingerprint-not-changed" };
  }
  if (input.hasRalphToken) {
    return { action: "settle", reason: "ralph-token" };
  }
  if (input.finalMessageMissing && input.finalMessageWaitExhausted) {
    return { action: "settle", reason: "missing-final-output" };
  }
  if (input.continuationsUsed >= input.maxGraceContinuations) {
    return { action: "settle", reason: "continuation-cap" };
  }

  return {
    action: "continue",
    prompt: EPIC_RUN_STALLED_PROGRESS_PROMPT,
    nextContinuationCount: input.continuationsUsed + 1,
  };
};
