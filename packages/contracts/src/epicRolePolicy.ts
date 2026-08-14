import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ModelSelection } from "./orchestration.ts";

export const EpicRoleId = Schema.Literals([
  "iteration-worker",
  "idle-inspection",
  "epic-note-fold",
  "merge-fix",
]);
export type EpicRoleId = typeof EpicRoleId.Type;

export const EPIC_ROLE_IDS: ReadonlyArray<EpicRoleId> = [
  "iteration-worker",
  "idle-inspection",
  "epic-note-fold",
  "merge-fix",
];

const EPIC_TIER_ID_MAX_CHARS = 64;
const EPIC_TIER_ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

export const EpicTierId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(EPIC_TIER_ID_MAX_CHARS),
  Schema.isPattern(EPIC_TIER_ID_PATTERN),
).pipe(Schema.brand("EpicTierId"));
export type EpicTierId = typeof EpicTierId.Type;

export const EpicTierHop = Schema.Struct({
  selection: ModelSelection,
  skipAboveUtilization: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
  ),
});
export type EpicTierHop = typeof EpicTierHop.Type;

export const EpicTier = Schema.Struct({
  label: Schema.optionalKey(TrimmedNonEmptyString),
  hops: Schema.Array(EpicTierHop).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
});
export type EpicTier = typeof EpicTier.Type;

const EPIC_IN_SESSION_ROLE_MAX_CHARS = 64;
const EPIC_IN_SESSION_ROLE_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

/**
 * The name a worker spawns the subagent by, e.g. `planner`. It reaches the
 * harness as an agent name, so it takes the same shape as a tier id.
 */
export const EpicInSessionRoleName = TrimmedNonEmptyString.check(
  Schema.isMaxLength(EPIC_IN_SESSION_ROLE_MAX_CHARS),
  Schema.isPattern(EPIC_IN_SESSION_ROLE_PATTERN),
).pipe(Schema.brand("EpicInSessionRoleName"));
export type EpicInSessionRoleName = typeof EpicInSessionRoleName.Type;

/**
 * One subagent the runner injects into a worker session.
 *
 * `tier` names the chain the role's model comes from; only the model crosses
 * into the session, because a subagent always runs inside its parent session's
 * account. A role with no tier, or one naming a missing tier, inherits the
 * session model.
 */
export const EpicInSessionRole = Schema.Struct({
  tier: Schema.optionalKey(EpicTierId),
  description: TrimmedNonEmptyString,
  prompt: TrimmedNonEmptyString,
  tools: Schema.optionalKey(Schema.Array(TrimmedNonEmptyString)),
});
export type EpicInSessionRole = typeof EpicInSessionRole.Type;

/**
 * Verification rules every shipped stage subagent repeats. A subagent opens on
 * an empty context, so each prompt has to carry the rules itself.
 */
const STAGE_VERIFICATION_RULES = [
  "Verification rules:",
  "- Verify only what you touched. Run focused tests by file, e.g. `vp test run <test-files>`, plus lint and typecheck scoped to the changed package.",
  "- Never run a repo-wide suite such as `vp check` or `vp run test`. CI owns the full suite.",
  "- When your task hands you a gate command, run it exactly as written. A focused check in its place is a false pass.",
  "- Never install dependencies inside an epic worktree. Its linked node_modules can damage the source checkout.",
].join("\n");

const stagePrompt = (lines: ReadonlyArray<string>): string =>
  [...lines, "", STAGE_VERIFICATION_RULES].join("\n");

/**
 * The stage subagents a fresh install gets, keyed by the name a worker spawns
 * them with.
 *
 * Every role ships without a tier on purpose. A tier hop names a
 * `ProviderInstanceId` that only exists on the user's machine, so a shipped tier
 * would name an instance nobody has. Tier-less roles take the worker session's
 * own model through the fail-soft path in `resolveEpicSubagents`, which is the
 * behavior we want by default.
 *
 * No role restricts `tools` either. A wrong tool name silently narrows an agent,
 * and the prompts already state what each role may touch.
 */
export const DEFAULT_EPIC_STAGE_SUBAGENTS = {
  planner: {
    description:
      "Plans one issue end to end before any code is written. Use when the task leaves choices open.",
    prompt: stagePrompt([
      "You plan one issue for an implementer who will not reason further. The plan has to be followable as written.",
      "Read the code first. Cite every claim as file:line. Never plan against a guess.",
      "Deliver: the files to touch, the order of the changes, the happy path, every edge case, and every error path.",
      "Name the focused test commands and the gate scope the implementer must run.",
      "You are read-only. Do not edit files.",
    ]),
  },
  implementer: {
    description: "Writes the code for a governing plan. Use once a plan or a clear spec exists.",
    prompt: stagePrompt([
      "You implement the plan you were given, exactly as it is written.",
      "Keep the diff minimal. Match the naming, the idiom, and the comment density of the surrounding code.",
      "When the code contradicts the plan, stop and report the mismatch. Do not improvise a different design.",
      "Do not commit. The caller owns git.",
    ]),
  },
  reviewer: {
    description:
      "Reviews a diff for defects the author would not see. Use after an implementation lands in the working tree.",
    prompt: stagePrompt([
      "You review a diff on the assumption that it is subtly wrong. Your job is to prove it.",
      "Run the omission and parity pass first: find the sibling path this change parallels, check the change landed on both, and cite the sibling at file:line.",
      "Then read for correctness: edge cases, error paths, and state the author did not update.",
      "End with one verdict. APPROVE, or BLOCK with the exact fixes.",
    ]),
  },
  tester: {
    description:
      "Runs QA against a finished change and reports PASS or FAIL. Use after review, before the gate.",
    prompt: stagePrompt([
      "You are QA. You exercise the change and report on it. You edit no files.",
      "For a user-visible frontend change, run the repository's integrated verification. In this repository that is the test-t3-app skill, and this task explicitly requires you to launch a dev server.",
      "Isolate the environment. Use a worktree-local or mktemp base directory, never the shared user data directory. Treat a one-time pairing URL as a secret.",
      "Check the affected flow at a desktop viewport and at a phone viewport. Stop every dev server and watcher before you report.",
      "For a change with no user-visible surface, run the focused tests and probe the behavior directly instead.",
      "Report PASS or FAIL. Give the steps you ran and the evidence you saw. On FAIL give an exact reproduction.",
    ]),
  },
  cleanup: {
    description: "Fixes what QA found, then hands the change back for re-QA. Use on a FAIL report.",
    prompt: stagePrompt([
      "You fix what QA found. Reproduce each finding yourself before you touch anything.",
      "Fix the cause, not the symptom, with the smallest change that works.",
      "Re-run the exact failing test or flow, then hand back to a fresh tester for re-QA.",
      "Stay in scope. Never weaken or skip a test, never bypass a gate, and never commit.",
    ]),
  },
  investigator: {
    description:
      "Answers a deep question about the codebase with cited evidence. Use before planning, when the ground truth is unclear.",
    prompt: stagePrompt([
      "You investigate the codebase and answer the question you were asked.",
      "Read the real code. Cite every finding at file:line. Report what the code does, not what it should do.",
      "Say plainly when the evidence does not settle the question. A confident guess is worse than an open question.",
      "You are read-only. Do not edit files.",
    ]),
  },
} as const;

export const EpicRolePolicy = Schema.Struct({
  tiers: Schema.Record(EpicTierId, EpicTier).pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  /**
   * Maps each configured role to a tier. An absent role, or a role that points
   * to a missing tier, has no policy and keeps the caller's existing selection.
   */
  roles: Schema.Record(EpicRoleId, Schema.optionalKey(EpicTierId)).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  /**
   * Subagents injected into every iteration worker session. These are not
   * runner dispatches: the worker spawns them itself, so the runner only
   * supplies the definition and the tier-resolved model. An empty map injects
   * nothing and leaves the harness's own agents alone.
   *
   * A missing key decodes to {@link DEFAULT_EPIC_STAGE_SUBAGENTS}, so a fresh
   * install gets the six stage subagents with no configuration. The field-level
   * default is the only seam that ships them, which keeps
   * `DEFAULT_EPIC_ROLE_POLICY`, `DEFAULT_SERVER_SETTINGS.epicRolePolicy`, and
   * `parsePersistedEpicRolePolicy`'s fallback identical by construction: all
   * three decode an absent policy through this same struct.
   *
   * Persistence follows from `epicRolePolicy` being an atomic settings key.
   * A patch replaces the whole policy, and `stripDefaultServerSettings`
   * compares it whole, so a pristine policy is stripped from settings.json and
   * an untouched install tracks whatever defaults a later version ships. An
   * edited policy freezes a full snapshot instead, defaults included.
   *
   * Deleting the defaults sticks: the default fills a missing or `undefined`
   * value only, so a persisted `inSessionRoles: {}` stays empty. For the same
   * reason a policy persisted before this field had defaults carries an
   * explicit key and gains nothing until the user resets it in the UI.
   *
   * Injecting definitions keeps a session in in-process Task mode
   * (`subagentSpawn.ts`), and thread-backed spawning ships off, so a fresh
   * install sees no spawn-mode change from these defaults.
   */
  inSessionRoles: Schema.Record(EpicInSessionRoleName, EpicInSessionRole).pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_EPIC_STAGE_SUBAGENTS)),
  ),
});
export type EpicRolePolicy = typeof EpicRolePolicy.Type;

export const DEFAULT_EPIC_ROLE_POLICY: EpicRolePolicy = Schema.decodeSync(EpicRolePolicy)({});
