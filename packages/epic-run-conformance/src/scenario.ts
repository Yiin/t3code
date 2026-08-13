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
