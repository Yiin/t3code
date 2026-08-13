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
   */
  inSessionRoles: Schema.Record(EpicInSessionRoleName, EpicInSessionRole).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
});
export type EpicRolePolicy = typeof EpicRolePolicy.Type;

export const DEFAULT_EPIC_ROLE_POLICY: EpicRolePolicy = Schema.decodeSync(EpicRolePolicy)({});
