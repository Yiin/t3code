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

export const EpicRolePolicy = Schema.Struct({
  tiers: Schema.Record(EpicTierId, EpicTier).pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  /**
   * Maps each configured role to a tier. An absent role, or a role that points
   * to a missing tier, has no policy and keeps the caller's existing selection.
   */
  roles: Schema.Record(EpicRoleId, Schema.optionalKey(EpicTierId)).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
});
export type EpicRolePolicy = typeof EpicRolePolicy.Type;

export const DEFAULT_EPIC_ROLE_POLICY: EpicRolePolicy = Schema.decodeSync(EpicRolePolicy)({});
