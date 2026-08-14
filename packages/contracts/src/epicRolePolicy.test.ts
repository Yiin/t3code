import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import {
  DEFAULT_EPIC_ROLE_POLICY,
  DEFAULT_EPIC_STAGE_SUBAGENTS,
  EPIC_ROLE_IDS,
  EpicRolePolicy,
  EpicTierId,
} from "./epicRolePolicy.ts";

const decodeEpicRolePolicy = Schema.decodeUnknownSync(EpicRolePolicy);

describe("EpicRolePolicy", () => {
  it("defines the runner role ids and empty tier defaults", () => {
    expect(EPIC_ROLE_IDS).toEqual([
      "iteration-worker",
      "idle-inspection",
      "epic-note-fold",
      "merge-fix",
    ]);
    expect(DEFAULT_EPIC_ROLE_POLICY.tiers).toEqual({});
    expect(DEFAULT_EPIC_ROLE_POLICY.roles).toEqual({});
  });

  it("ships the six stage subagents by default", () => {
    expect(Object.keys(DEFAULT_EPIC_ROLE_POLICY.inSessionRoles)).toEqual([
      "planner",
      "implementer",
      "reviewer",
      "tester",
      "cleanup",
      "investigator",
    ]);
    expect(DEFAULT_EPIC_ROLE_POLICY.inSessionRoles).toEqual(DEFAULT_EPIC_STAGE_SUBAGENTS);
  });

  it("ships every stage subagent tier-less, so each inherits the session model", () => {
    for (const role of Object.values(DEFAULT_EPIC_ROLE_POLICY.inSessionRoles)) {
      expect(role.tier).toBeUndefined();
      expect(role.tools).toBeUndefined();
      expect(role.description.length).toBeGreaterThan(0);
      expect(role.prompt).toContain("Verification rules:");
    }
  });

  it("keeps an explicitly persisted empty in-session role map empty", () => {
    expect(decodeEpicRolePolicy({ inSessionRoles: {} }).inSessionRoles).toEqual({});
    expect(
      Object.keys(
        decodeEpicRolePolicy({
          inSessionRoles: { planner: { description: "Plans.", prompt: "You plan." } },
        }).inSessionRoles,
      ),
    ).toEqual(["planner"]);
  });

  it("allows empty, partial, and complete role assignments", () => {
    expect(decodeEpicRolePolicy({}).roles).toEqual({});
    expect(decodeEpicRolePolicy({ roles: { "iteration-worker": "primary" } }).roles).toEqual({
      "iteration-worker": "primary",
    });
    expect(
      decodeEpicRolePolicy({
        roles: {
          "iteration-worker": "primary",
          "idle-inspection": "background",
          "epic-note-fold": "background",
          "merge-fix": "primary",
        },
      }).roles,
    ).toEqual({
      "iteration-worker": "primary",
      "idle-inspection": "background",
      "epic-note-fold": "background",
      "merge-fix": "primary",
    });
  });

  it("expands same-driver accounts by default and preserves an explicit false", () => {
    const primary = EpicTierId.make("primary");
    expect(
      decodeEpicRolePolicy({ tiers: { primary: { hops: [] } } }).tiers[primary]
        ?.expandSameDriverAccounts,
    ).toBe(true);
    expect(
      decodeEpicRolePolicy({
        tiers: { primary: { expandSameDriverAccounts: false, hops: [] } },
      }).tiers[primary]?.expandSameDriverAccounts,
    ).toBe(false);
  });
});
