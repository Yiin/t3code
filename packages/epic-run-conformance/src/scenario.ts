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
});

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
  expectedTranscript: Schema.Array(EpicRunTranscriptEvent),
  appliesTo: Schema.Array(Schema.Literals(["core", "terminal", "server"])),
});
export type ConformanceScenario = typeof ConformanceScenario.Type;

export const decodeConformanceScenario = Schema.decodeUnknownSync(ConformanceScenario, {
  onExcessProperty: "error",
});
