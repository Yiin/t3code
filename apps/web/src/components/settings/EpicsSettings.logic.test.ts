import {
  DEFAULT_EPIC_ROLE_POLICY,
  DEFAULT_EPIC_STAGE_SUBAGENTS,
  EPIC_ROLE_IDS,
  EpicInSessionRoleName,
  EpicTierId,
  ProviderInstanceId,
  type EpicRolePolicy,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { describe, expect, it } from "vite-plus/test";

import type { ProviderInstanceEntry } from "../../providerInstances";
import {
  addTierHop,
  assignRoleTier,
  buildEpicRolePolicyPatch,
  buildEpicRoleRows,
  buildInSessionRoleRows,
  createInSessionRole,
  createTier,
  deleteInSessionRole,
  deleteTier,
  isEpicRolePolicyDirty,
  moveTierHop,
  removeTierHop,
  renameTier,
  setInSessionRoleText,
  setInSessionRoleTier,
  setTierHopSelection,
  setTierHopSkipAboveUtilization,
} from "./EpicsSettings.logic";

const primaryTierId = EpicTierId.make("primary");
const backupTierId = EpicTierId.make("backup");
const plannerName = EpicInSessionRoleName.make("planner");
const claudeInstanceId = ProviderInstanceId.make("claude_work");
const codexInstanceId = ProviderInstanceId.make("codex_personal");

function selection(instanceId: typeof claudeInstanceId, model: string) {
  return createModelSelection(instanceId, model);
}

function makePolicy(): EpicRolePolicy {
  return {
    tiers: {
      [primaryTierId]: {
        label: "Primary",
        expandSameDriverAccounts: true,
        hops: [
          { selection: selection(claudeInstanceId, "first") },
          { selection: selection(codexInstanceId, "second") },
          { selection: selection(claudeInstanceId, "third") },
        ],
      },
      [backupTierId]: { expandSameDriverAccounts: true, hops: [] },
    },
    roles: {
      "iteration-worker": primaryTierId,
      "merge-fix": primaryTierId,
    },
    inSessionRoles: {
      [plannerName]: {
        tier: primaryTierId,
        description: "Plans one child.",
        prompt: "You plan.",
      },
    },
  };
}

function entry(instanceId: typeof claudeInstanceId): ProviderInstanceEntry {
  return { instanceId } as ProviderInstanceEntry;
}

describe("EpicsSettings.logic", () => {
  it("builds all role rows in contract order and keeps unassigned roles null", () => {
    const rows = buildEpicRoleRows({ policy: makePolicy(), entries: [entry(claudeInstanceId)] });

    expect(rows).toHaveLength(4);
    expect(rows.map((row) => row.roleId)).toEqual(EPIC_ROLE_IDS);
    expect(rows.map((row) => row.tierId)).toEqual([primaryTierId, null, null, primaryTierId]);
    expect(rows[0]).toMatchObject({ label: "Iteration worker", hopCount: 3 });
  });

  it("reports hops whose provider instance is missing", () => {
    const rows = buildEpicRoleRows({ policy: makePolicy(), entries: [entry(claudeInstanceId)] });

    expect(rows[0]?.unresolvedHops).toEqual([1]);
  });

  it("moves hops and does nothing at chain ends", () => {
    const policy = makePolicy();
    const moved = moveTierHop(policy, primaryTierId, 1, "up");
    const atStart = moveTierHop(policy, primaryTierId, 0, "up");
    const atEnd = moveTierHop(policy, primaryTierId, 2, "down");

    expect(moved.tiers[primaryTierId]?.hops.map((hop) => hop.selection.model)).toEqual([
      "second",
      "first",
      "third",
    ]);
    expect(atStart).toEqual(policy);
    expect(atEnd).toEqual(policy);
  });

  it("removes one hop without changing the relative order", () => {
    const policy = removeTierHop(makePolicy(), primaryTierId, 1);

    expect(policy.tiers[primaryTierId]?.hops.map((hop) => hop.selection.model)).toEqual([
      "first",
      "third",
    ]);
  });

  it("deletes a tier and clears every role that used it", () => {
    const policy = deleteTier(makePolicy(), primaryTierId);

    expect(policy.tiers[primaryTierId]).toBeUndefined();
    expect(policy.roles["iteration-worker"]).toBeUndefined();
    expect(policy.roles["merge-fix"]).toBeUndefined();
  });

  it("rejects duplicate and invalid tier IDs", () => {
    expect(createTier(makePolicy(), "primary")).toEqual({
      error: "A tier with this ID already exists.",
    });
    expect(createTier(makePolicy(), "not a slug")).toEqual({
      error: "Use 1 to 64 letters, numbers, underscores, or hyphens. Start with a letter.",
    });
  });

  it("renames a tier, preserves its contents, and updates role assignments", () => {
    const policy = makePolicy();
    const result = renameTier(policy, primaryTierId, "premium");

    expect(result).not.toHaveProperty("error");
    if ("error" in result) return;
    const premiumTierId = EpicTierId.make("premium");
    expect(result.policy.tiers[premiumTierId]).toEqual(policy.tiers[primaryTierId]);
    expect(result.policy.tiers[primaryTierId]).toBeUndefined();
    expect(result.policy.roles["iteration-worker"]).toBe(premiumTierId);
    expect(result.policy.roles["merge-fix"]).toBe(premiumTierId);
    expect(renameTier(policy, primaryTierId, "backup")).toHaveProperty("error");
    expect(renameTier(policy, primaryTierId, "bad id")).toHaveProperty("error");
  });

  it("sets and clears a hop utilization threshold", () => {
    const set = setTierHopSkipAboveUtilization(makePolicy(), primaryTierId, 0, 80);
    const cleared = setTierHopSkipAboveUtilization(set, primaryTierId, 0, undefined);
    const invalid = setTierHopSkipAboveUtilization(makePolicy(), primaryTierId, 0, 101);

    expect(set.tiers[primaryTierId]?.hops[0]?.skipAboveUtilization).toBe(80);
    expect(cleared.tiers[primaryTierId]?.hops[0]).not.toHaveProperty("skipAboveUtilization");
    expect(invalid).toEqual(makePolicy());
  });

  it("builds one row per in-session subagent", () => {
    const rows = buildInSessionRoleRows(makePolicy());

    expect(rows).toEqual([
      {
        name: plannerName,
        role: { tier: primaryTierId, description: "Plans one child.", prompt: "You plan." },
        tierId: primaryTierId,
        hopCount: 3,
        tierMissing: false,
      },
    ]);
  });

  it("flags an in-session subagent whose tier is gone", () => {
    const rows = buildInSessionRoleRows(deleteTier(makePolicy(), primaryTierId));

    expect(rows[0]).toMatchObject({ tierId: null, hopCount: 0, tierMissing: false });
    expect(rows[0]?.role).not.toHaveProperty("tier");
  });

  it("flags a subagent that still names a tier the policy dropped", () => {
    const policy = makePolicy();
    const orphaned: EpicRolePolicy = { ...policy, tiers: {} };
    const rows = buildInSessionRoleRows(orphaned);

    expect(rows[0]).toMatchObject({ tierId: null, hopCount: 0, tierMissing: true });
    expect(rows[0]?.role.tier).toBe(primaryTierId);
  });

  it("builds a tier-less row for every shipped default subagent", () => {
    const rows = buildInSessionRoleRows(DEFAULT_EPIC_ROLE_POLICY);

    expect(rows.map((row) => row.name)).toEqual(Object.keys(DEFAULT_EPIC_STAGE_SUBAGENTS));
    // Tier-less is the shipped state, so no row may render as a warning.
    for (const row of rows) {
      expect(row).toMatchObject({ tierId: null, hopCount: 0, tierMissing: false });
    }
  });

  it("repoints in-session subagents when their tier is renamed", () => {
    const result = renameTier(makePolicy(), primaryTierId, "premium");

    expect("policy" in result && result.policy.inSessionRoles[plannerName]?.tier).toBe(
      EpicTierId.make("premium"),
    );
  });

  it("creates, retiers, and deletes an in-session subagent", () => {
    const created = createInSessionRole(makePolicy(), "reviewer");
    expect("policy" in created).toBe(true);
    if (!("policy" in created)) return;

    const reviewerName = EpicInSessionRoleName.make("reviewer");
    expect(created.policy.inSessionRoles[reviewerName]).toEqual({
      description: "The reviewer subagent.",
      prompt: "You are the reviewer.",
    });

    const tiered = setInSessionRoleTier(created.policy, reviewerName, backupTierId);
    expect(tiered.inSessionRoles[reviewerName]?.tier).toBe(backupTierId);
    expect(
      setInSessionRoleTier(tiered, reviewerName, null).inSessionRoles[reviewerName],
    ).not.toHaveProperty("tier");

    expect(deleteInSessionRole(tiered, reviewerName).inSessionRoles[reviewerName]).toBeUndefined();
    // The tier the deleted subagent used stays; only the subagent goes.
    expect(deleteInSessionRole(tiered, reviewerName).tiers[backupTierId]).toBeDefined();
  });

  it("rejects duplicate and invalid in-session subagent names", () => {
    expect(createInSessionRole(makePolicy(), "planner")).toEqual({
      error: "A subagent with this name already exists.",
    });
    expect(createInSessionRole(makePolicy(), "not a name")).toEqual({
      error: "Use 1 to 64 letters, numbers, underscores, or hyphens. Start with a letter.",
    });
  });

  it("trims subagent text and refuses to store an empty value", () => {
    const trimmed = setInSessionRoleText(makePolicy(), plannerName, "prompt", "  You plan well.  ");
    expect(trimmed.inSessionRoles[plannerName]?.prompt).toBe("You plan well.");

    const blanked = setInSessionRoleText(makePolicy(), plannerName, "description", "   ");
    expect(blanked.inSessionRoles[plannerName]?.description).toBe("Plans one child.");
  });

  it("builds one whole-value settings patch", () => {
    const nextPolicy = removeTierHop(makePolicy(), primaryTierId, 1);
    const updates: ServerSettingsPatch[] = [];

    updates.push(buildEpicRolePolicyPatch(nextPolicy));

    expect(updates).toEqual([{ epicRolePolicy: nextPolicy }]);
    expect(Object.keys(updates[0] ?? {})).toEqual(["epicRolePolicy"]);
  });

  it("reports only policies that differ from the default as dirty", () => {
    expect(isEpicRolePolicyDirty(DEFAULT_EPIC_ROLE_POLICY)).toBe(false);
    const result = createTier(DEFAULT_EPIC_ROLE_POLICY, "primary");
    expect("policy" in result && isEpicRolePolicyDirty(result.policy)).toBe(true);
  });

  it("marks the policy dirty once a shipped subagent is deleted, and Reset restores it", () => {
    const trimmed = deleteInSessionRole(DEFAULT_EPIC_ROLE_POLICY, plannerName);

    expect(trimmed.inSessionRoles[plannerName]).toBeUndefined();
    expect(isEpicRolePolicyDirty(trimmed)).toBe(true);
    // Reset writes DEFAULT_EPIC_ROLE_POLICY back, which is dirty-free again.
    expect(isEpicRolePolicyDirty(DEFAULT_EPIC_ROLE_POLICY)).toBe(false);
    expect(Object.keys(DEFAULT_EPIC_ROLE_POLICY.inSessionRoles)).toEqual(
      Object.keys(DEFAULT_EPIC_STAGE_SUBAGENTS),
    );
  });

  it("deleting every shipped subagent leaves an empty map that stays dirty", () => {
    const emptied = Object.keys(DEFAULT_EPIC_ROLE_POLICY.inSessionRoles).reduce(
      (policy, name) => deleteInSessionRole(policy, EpicInSessionRoleName.make(name)),
      DEFAULT_EPIC_ROLE_POLICY,
    );

    expect(buildInSessionRoleRows(emptied)).toEqual([]);
    expect(isEpicRolePolicyDirty(emptied)).toBe(true);
  });

  it("refuses to re-add a shipped subagent name", () => {
    expect(createInSessionRole(DEFAULT_EPIC_ROLE_POLICY, "planner")).toEqual({
      error: "A subagent with this name already exists.",
    });
  });

  it("leaves all helper inputs unchanged", () => {
    const policy = makePolicy();
    const policySnapshot = structuredClone(policy);
    const entries = [entry(claudeInstanceId)];
    const entriesSnapshot = structuredClone(entries);
    const nextSelection = selection(claudeInstanceId, "replacement");

    buildEpicRoleRows({ policy, entries });
    createTier(policy, "new-tier");
    renameTier(policy, primaryTierId, "renamed-tier");
    deleteTier(policy, primaryTierId);
    assignRoleTier(policy, "idle-inspection", backupTierId);
    addTierHop(policy, primaryTierId, { selection: nextSelection });
    removeTierHop(policy, primaryTierId, 1);
    moveTierHop(policy, primaryTierId, 1, "up");
    setTierHopSelection(policy, primaryTierId, 0, nextSelection);
    setTierHopSkipAboveUtilization(policy, primaryTierId, 0, 75);
    buildInSessionRoleRows(policy);
    createInSessionRole(policy, "reviewer");
    setInSessionRoleTier(policy, plannerName, backupTierId);
    setInSessionRoleText(policy, plannerName, "prompt", "changed");
    deleteInSessionRole(policy, plannerName);
    buildEpicRolePolicyPatch(policy);
    isEpicRolePolicyDirty(policy);

    expect(policy).toEqual(policySnapshot);
    expect(entries).toEqual(entriesSnapshot);
  });
});
