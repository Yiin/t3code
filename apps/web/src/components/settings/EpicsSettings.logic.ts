import {
  DEFAULT_EPIC_ROLE_POLICY,
  EPIC_ROLE_IDS,
  EpicInSessionRoleName,
  EpicTierId,
  type EpicInSessionRole,
  type EpicRoleId,
  type EpicRolePolicy,
  type EpicTier,
  type ModelSelection,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import * as Equal from "effect/Equal";
import * as Schema from "effect/Schema";

import type { ProviderInstanceEntry } from "../../providerInstances";

const EPIC_ROLE_DETAILS = {
  "iteration-worker": {
    label: "Iteration worker",
    description: "Builds one ready child during each epic iteration.",
  },
  "idle-inspection": {
    label: "Idle inspector",
    description: "Checks the epic while no child is ready to start.",
  },
  "epic-note-fold": {
    label: "Epic note fold",
    description: "Folds progress notes into the epic context.",
  },
  "merge-fix": {
    label: "Merge-fix child",
    description: "Repairs a child after its branch fails the merge gate.",
  },
} satisfies Record<EpicRoleId, { label: string; description: string }>;

const isEpicTierId = Schema.is(EpicTierId);
const isInSessionRoleName = Schema.is(EpicInSessionRoleName);

export interface EpicRoleRow {
  readonly roleId: EpicRoleId;
  readonly label: string;
  readonly description: string;
  readonly tierId: EpicTierId | null;
  readonly hopCount: number;
  readonly unresolvedHops: ReadonlyArray<number>;
}

export function buildEpicRoleRows(input: {
  policy: EpicRolePolicy;
  entries: ReadonlyArray<ProviderInstanceEntry>;
}): ReadonlyArray<EpicRoleRow> {
  const configuredInstanceIds = new Set(input.entries.map((entry) => entry.instanceId));

  return EPIC_ROLE_IDS.map((roleId) => {
    const configuredTierId = input.policy.roles[roleId];
    const tier = configuredTierId ? input.policy.tiers[configuredTierId] : undefined;
    const tierId = tier && configuredTierId ? configuredTierId : null;
    return {
      roleId,
      ...EPIC_ROLE_DETAILS[roleId],
      tierId,
      hopCount: tier?.hops.length ?? 0,
      unresolvedHops:
        tier?.hops.flatMap((hop, index) =>
          configuredInstanceIds.has(hop.selection.instanceId) ? [] : [index],
        ) ?? [],
    };
  });
}

function parseTierId(input: string): { tierId: EpicTierId } | { error: string } {
  const tierId = input.trim();
  if (!isEpicTierId(tierId)) {
    return {
      error: "Use 1 to 64 letters, numbers, underscores, or hyphens. Start with a letter.",
    };
  }
  return { tierId };
}

function copyPolicy(policy: EpicRolePolicy): EpicRolePolicy {
  return {
    tiers: { ...policy.tiers },
    roles: { ...policy.roles },
    inSessionRoles: { ...policy.inSessionRoles },
  };
}

function updateTier(
  policy: EpicRolePolicy,
  tierId: EpicTierId,
  update: (tier: EpicTier) => EpicTier,
): EpicRolePolicy {
  const tier = policy.tiers[tierId];
  if (!tier) return copyPolicy(policy);
  return {
    ...copyPolicy(policy),
    tiers: { ...policy.tiers, [tierId]: update(tier) },
  };
}

export function createTier(
  policy: EpicRolePolicy,
  input: string,
): { policy: EpicRolePolicy } | { error: string } {
  const parsed = parseTierId(input);
  if ("error" in parsed) return parsed;
  if (policy.tiers[parsed.tierId]) {
    return { error: "A tier with this ID already exists." };
  }
  return {
    policy: {
      ...copyPolicy(policy),
      tiers: {
        ...policy.tiers,
        [parsed.tierId]: { expandSameDriverAccounts: true, hops: [] },
      },
    },
  };
}

export function renameTier(
  policy: EpicRolePolicy,
  tierId: EpicTierId,
  input: string,
): { policy: EpicRolePolicy } | { error: string } {
  const parsed = parseTierId(input);
  if ("error" in parsed) return parsed;
  const tier = policy.tiers[tierId];
  if (!tier) return { error: "This tier no longer exists." };
  if (parsed.tierId !== tierId && policy.tiers[parsed.tierId]) {
    return { error: "A tier with this ID already exists." };
  }
  if (parsed.tierId === tierId) {
    return { policy: copyPolicy(policy) };
  }

  const tiers = { ...policy.tiers };
  delete tiers[tierId];
  tiers[parsed.tierId] = tier;
  const roles = { ...policy.roles };
  for (const roleId of EPIC_ROLE_IDS) {
    if (roles[roleId] === tierId) roles[roleId] = parsed.tierId;
  }
  return {
    policy: { tiers, roles, inSessionRoles: repointInSessionRoles(policy, tierId, parsed.tierId) },
  };
}

/** Move every in-session role off `tierId`, onto `nextTierId` or onto nothing. */
function repointInSessionRoles(
  policy: EpicRolePolicy,
  tierId: EpicTierId,
  nextTierId: EpicTierId | null,
): EpicRolePolicy["inSessionRoles"] {
  const inSessionRoles: Record<string, EpicInSessionRole> = {};
  for (const [name, role] of Object.entries(policy.inSessionRoles)) {
    if (role.tier !== tierId) {
      inSessionRoles[name] = role;
      continue;
    }
    if (nextTierId === null) {
      const { tier: _removed, ...untiered } = role;
      inSessionRoles[name] = untiered;
      continue;
    }
    inSessionRoles[name] = { ...role, tier: nextTierId };
  }
  return inSessionRoles;
}

export function deleteTier(policy: EpicRolePolicy, tierId: EpicTierId): EpicRolePolicy {
  const tiers = { ...policy.tiers };
  delete tiers[tierId];
  const roles = { ...policy.roles };
  for (const roleId of EPIC_ROLE_IDS) {
    if (roles[roleId] === tierId) delete roles[roleId];
  }
  return { tiers, roles, inSessionRoles: repointInSessionRoles(policy, tierId, null) };
}

export function assignRoleTier(
  policy: EpicRolePolicy,
  roleId: EpicRoleId,
  tierId: EpicTierId | null,
): EpicRolePolicy {
  const roles = { ...policy.roles };
  if (tierId === null) delete roles[roleId];
  else roles[roleId] = tierId;
  return { ...copyPolicy(policy), roles };
}

export function addTierHop(
  policy: EpicRolePolicy,
  tierId: EpicTierId,
  hop: EpicTier["hops"][number],
): EpicRolePolicy {
  return updateTier(policy, tierId, (tier) => ({ ...tier, hops: [...tier.hops, hop] }));
}

export function removeTierHop(
  policy: EpicRolePolicy,
  tierId: EpicTierId,
  index: number,
): EpicRolePolicy {
  return updateTier(policy, tierId, (tier) => ({
    ...tier,
    hops: tier.hops.filter((_, candidateIndex) => candidateIndex !== index),
  }));
}

export function moveTierHop(
  policy: EpicRolePolicy,
  tierId: EpicTierId,
  index: number,
  direction: "up" | "down",
): EpicRolePolicy {
  return updateTier(policy, tierId, (tier) => {
    const nextIndex = index + (direction === "up" ? -1 : 1);
    const hops = [...tier.hops];
    if (index < 0 || index >= hops.length || nextIndex < 0 || nextIndex >= hops.length) {
      return { ...tier, hops };
    }
    [hops[index], hops[nextIndex]] = [hops[nextIndex]!, hops[index]!];
    return { ...tier, hops };
  });
}

export function setTierHopSelection(
  policy: EpicRolePolicy,
  tierId: EpicTierId,
  index: number,
  selection: ModelSelection,
): EpicRolePolicy {
  return updateTier(policy, tierId, (tier) => ({
    ...tier,
    hops: tier.hops.map((hop, candidateIndex) =>
      candidateIndex === index ? { ...hop, selection } : hop,
    ),
  }));
}

export function setTierHopSkipAboveUtilization(
  policy: EpicRolePolicy,
  tierId: EpicTierId,
  index: number,
  skipAboveUtilization: number | undefined,
): EpicRolePolicy {
  const validThreshold =
    skipAboveUtilization === undefined ||
    (Number.isInteger(skipAboveUtilization) &&
      skipAboveUtilization >= 0 &&
      skipAboveUtilization <= 100);
  return updateTier(policy, tierId, (tier) => ({
    ...tier,
    hops: tier.hops.map((hop, candidateIndex) => {
      if (candidateIndex !== index || !validThreshold) return hop;
      if (skipAboveUtilization === undefined) {
        const { skipAboveUtilization: _removed, ...nextHop } = hop;
        return nextHop;
      }
      return { ...hop, skipAboveUtilization };
    }),
  }));
}

export interface EpicInSessionRoleRow {
  readonly name: EpicInSessionRoleName;
  readonly role: EpicInSessionRole;
  readonly tierId: EpicTierId | null;
  readonly hopCount: number;
  /** The tier the role names no longer exists, so it inherits the session model. */
  readonly tierMissing: boolean;
}

export function buildInSessionRoleRows(
  policy: EpicRolePolicy,
): ReadonlyArray<EpicInSessionRoleRow> {
  return Object.entries(policy.inSessionRoles).map(([name, role]) => {
    const tier = role.tier ? policy.tiers[role.tier] : undefined;
    return {
      name: name as EpicInSessionRoleName,
      role,
      tierId: tier && role.tier ? role.tier : null,
      hopCount: tier?.hops.length ?? 0,
      tierMissing: role.tier !== undefined && tier === undefined,
    };
  });
}

function parseInSessionRoleName(
  input: string,
): { name: EpicInSessionRoleName } | { error: string } {
  const name = input.trim();
  if (!isInSessionRoleName(name)) {
    return {
      error: "Use 1 to 64 letters, numbers, underscores, or hyphens. Start with a letter.",
    };
  }
  return { name };
}

export function createInSessionRole(
  policy: EpicRolePolicy,
  input: string,
): { policy: EpicRolePolicy } | { error: string } {
  const parsed = parseInSessionRoleName(input);
  if ("error" in parsed) return parsed;
  if (policy.inSessionRoles[parsed.name]) {
    return { error: "A subagent with this name already exists." };
  }
  return {
    policy: {
      ...copyPolicy(policy),
      inSessionRoles: {
        ...policy.inSessionRoles,
        // Placeholders, because the schema rejects empty text: an operator
        // sees them in the editor and replaces them.
        [parsed.name]: {
          description: `The ${parsed.name} subagent.`,
          prompt: `You are the ${parsed.name}.`,
        },
      },
    },
  };
}

export function deleteInSessionRole(
  policy: EpicRolePolicy,
  name: EpicInSessionRoleName,
): EpicRolePolicy {
  const inSessionRoles = { ...policy.inSessionRoles };
  delete inSessionRoles[name];
  return { ...copyPolicy(policy), inSessionRoles };
}

function updateInSessionRole(
  policy: EpicRolePolicy,
  name: EpicInSessionRoleName,
  update: (role: EpicInSessionRole) => EpicInSessionRole,
): EpicRolePolicy {
  const role = policy.inSessionRoles[name];
  if (!role) return copyPolicy(policy);
  return {
    ...copyPolicy(policy),
    inSessionRoles: { ...policy.inSessionRoles, [name]: update(role) },
  };
}

export function setInSessionRoleTier(
  policy: EpicRolePolicy,
  name: EpicInSessionRoleName,
  tierId: EpicTierId | null,
): EpicRolePolicy {
  return updateInSessionRole(policy, name, (role) => {
    if (tierId === null) {
      const { tier: _removed, ...untiered } = role;
      return untiered;
    }
    return { ...role, tier: tierId };
  });
}

/**
 * Set one of the role's two text fields.
 *
 * Blank input keeps the stored value: the schema rejects an empty description
 * or prompt, so committing one would make the whole policy unsavable.
 */
export function setInSessionRoleText(
  policy: EpicRolePolicy,
  name: EpicInSessionRoleName,
  field: "description" | "prompt",
  value: string,
): EpicRolePolicy {
  const trimmed = value.trim();
  if (trimmed === "") return copyPolicy(policy);
  return updateInSessionRole(policy, name, (role) => ({ ...role, [field]: trimmed }));
}

export function buildEpicRolePolicyPatch(
  policy: EpicRolePolicy,
): Pick<ServerSettingsPatch, "epicRolePolicy"> {
  return { epicRolePolicy: policy };
}

export function isEpicRolePolicyDirty(policy: EpicRolePolicy): boolean {
  return !Equal.equals(policy, DEFAULT_EPIC_ROLE_POLICY);
}
