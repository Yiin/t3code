import { EpicRunTranscriptEvent } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const ScenarioFile = Schema.Struct({
  path: Schema.String,
  content: Schema.String,
});

const ScenarioChild = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  status: Schema.Literals(["open", "in_progress", "blocked", "closed"]),
  priority: Schema.Number,
  issueType: Schema.Literals(["task", "bug", "feature"]),
  commentCount: Schema.Number,
  parentId: Schema.optional(Schema.String),
});

const AgentReport = Schema.Union([
  Schema.TaggedStruct("none", {}),
  Schema.TaggedStruct("ralph-done", {}),
  Schema.TaggedStruct("ralph-blocked", {}),
  Schema.TaggedStruct("ralph-msg", {
    summary: Schema.String,
    why: Schema.String,
  }),
  Schema.TaggedStruct("provider-error", {
    message: Schema.String,
  }),
  Schema.TaggedStruct("permission-denial", {
    message: Schema.String,
  }),
]);

const AgentStep = Schema.Struct({
  repoAction: Schema.Literals(["commit", "commit-with-siblings", "no-commit", "dirty-only"]),
  writes: Schema.optional(Schema.Array(ScenarioFile)),
  claimChild: Schema.optional(Schema.Boolean),
  report: AgentReport,
  closeChild: Schema.Boolean,
  beadComment: Schema.optional(Schema.String),
  hangMs: Schema.Number,
  /**
   * Which child this step scripts.
   *
   * A sequential run dispatches one worker at a time, so the fixture agent can
   * read its step off a single counter. Two workers cannot: whichever process
   * wins the state lock takes the next step, so an unkeyed script makes the
   * run's behaviour depend on host scheduling. A parallel scenario keys every
   * step to a child instead, and each child consumes its own steps in order.
   */
  childId: Schema.optional(Schema.String),
  /**
   * Merge the base repository's `HEAD` into this worker's branch before the
   * step's writes, then commit the result.
   *
   * This is the one thing a merge-fix worker does that an ordinary worker never
   * does, and it is not expressible as a write: a parked branch and the base
   * both changed the same lines, so only a merge commit carrying the base can
   * make the next trial merge clean. The merge is expected to conflict; the
   * step's `writes` are the resolution, and the commit below records it.
   *
   * Reads the base repository's `HEAD` rather than a branch name, so it holds
   * for any base branch the run resolved. Every driver runs on
   * `vcs.runOwnedBaseBranch: false`, so that head IS the run's base branch.
   */
  mergeBaseBranch: Schema.optional(Schema.Boolean),
  /**
   * Advance the base repository past this worker's branch, so the branch's
   * trial merge conflicts.
   *
   * Scripted rather than implied by `repo.mergeConflict` alone: an advance that
   * fires on every commit made outside the base repo fires again on the
   * merge-fix child's own commit, so the conflict it creates never converges,
   * and it runs after the shim released `CONFORMANCE_LOCK`, so two workers race
   * the same base. Keyed to a step, both are the scenario author's choice.
   *
   * A parallel run has no use for this: the drain reads a base that moved
   * under it as an external move and stops the run, rather than parking the
   * branch. Two workers writing the same file conflict without it.
   */
  advanceBase: Schema.optional(Schema.Boolean),
});

/**
 * How many workers the run under test dispatches at once.
 *
 * Absent means sequential, which is what every scenario written before the
 * pool loop existed assumes. `parallel` selects the pool loop on all three
 * drivers: the terminal cook's `COOKEPIC_WORKERS`, the server runner's
 * `parallel.workers`, and `runParallelEpicLoop` in the core driver.
 */
const ScenarioExecution = Schema.Union([
  Schema.TaggedStruct("sequential", {}),
  Schema.TaggedStruct("parallel", { workers: Schema.Number }),
]);

/**
 * A crash mid-run, then a second loop invocation over the same journal.
 *
 * Every restart behaviour needs the same two things a single invocation cannot
 * produce: an iteration row a dead process left `running`, and a live loop
 * that is handed that row back. The driver cuts the first invocation once the
 * journal holds `cutAfterRows` rows and the newest one is running, then starts
 * a second invocation over the same run directory.
 */
const ScenarioRestart = Schema.Struct({
  /**
   * How many iteration rows must exist before the first invocation is cut.
   * The cut also waits for the newest row to be `running`, so the count is a
   * position in the run, not a race.
   */
  cutAfterRows: Schema.Number,
  /**
   * Whether the second invocation adopts the leftover row as a
   * `resumedWorker`. `false` strands it, which is what a process that lost
   * its own store leaves behind.
   */
  adopt: Schema.Boolean,
  /**
   * Delete the leftover worktree before the second invocation. `workspace.adopt`
   * then refuses, which is the one refusal with nothing to hand over: the claim
   * is reopened instead of the tree being passed on.
   */
  dropWorktree: Schema.optional(Schema.Boolean),
});
export type ScenarioRestart = typeof ScenarioRestart.Type;

/**
 * Liveness supervision for this scenario, and what its evidence reports.
 *
 * `wedge-first-worker` makes the first dispatched worker read as the
 * 2026-08-09 incident did — no output, no CPU, no repository change, every
 * process asleep — and every later worker read as healthy. Absent means the
 * run carries no evidence port at all, which is how every other pool scenario
 * runs: only the dispatch deadline bounds a worker.
 */
const ScenarioSupervision = Schema.Literals(["wedge-first-worker"]);

export const ConformanceScenario = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  repo: Schema.Struct({
    files: Schema.Array(ScenarioFile),
    detachedHead: Schema.Boolean,
    dirty: Schema.Boolean,
    siblingRepos: Schema.Array(Schema.String),
    mergeConflict: Schema.optional(
      Schema.Struct({
        path: Schema.String,
        baseContent: Schema.String,
        workerContent: Schema.String,
        baseAdvanceContent: Schema.String,
      }),
    ),
  }),
  beads: Schema.Struct({
    epicId: Schema.String,
    epicExists: Schema.Boolean,
    runInProgress: Schema.Boolean,
    lockHeld: Schema.optional(Schema.Boolean),
    readyIncludesForeign: Schema.optional(Schema.Boolean),
    children: Schema.Array(ScenarioChild),
  }),
  agentScript: Schema.Array(AgentStep),
  execution: Schema.optional(ScenarioExecution),
  restart: Schema.optional(ScenarioRestart),
  supervision: Schema.optional(ScenarioSupervision),
  expectedTranscript: Schema.Array(EpicRunTranscriptEvent),
  appliesTo: Schema.Array(Schema.Literals(["core", "terminal", "server"])),
});
export type ConformanceScenario = typeof ConformanceScenario.Type;

/** The worker cap this scenario runs under; `1` for a sequential scenario. */
export const scenarioWorkers = (scenario: ConformanceScenario): number =>
  scenario.execution?._tag === "parallel" ? scenario.execution.workers : 1;

/** True when the scenario drives the pool loop rather than the sequential one. */
export const isParallelScenario = (scenario: ConformanceScenario): boolean =>
  scenarioWorkers(scenario) > 1;

const decodeScenario = Schema.decodeUnknownSync(ConformanceScenario, {
  onExcessProperty: "error",
});

export const decodeConformanceScenario = (input: unknown): ConformanceScenario => {
  const scenario = decodeScenario(input);
  return {
    ...scenario,
    expectedTranscript: scenario.expectedTranscript.map((event) => ({
      pushed: event.pushed ?? false,
      verified: event.verified ?? true,
      ...event,
    })),
  };
};
