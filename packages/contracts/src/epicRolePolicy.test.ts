import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { DEFAULT_EPIC_ROLE_POLICY, EPIC_ROLE_IDS, EpicRolePolicy } from "./epicRolePolicy.ts";

const decodeEpicRolePolicy = Schema.decodeUnknownSync(EpicRolePolicy);

describe("EpicRolePolicy", () => {
  it("defines the runner role ids and empty defaults", () => {
    expect(EPIC_ROLE_IDS).toEqual([
      "iteration-worker",
      "idle-inspection",
      "epic-note-fold",
      "merge-fix",
    ]);
    expect(DEFAULT_EPIC_ROLE_POLICY).toEqual({ tiers: {}, roles: {} });
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
});
