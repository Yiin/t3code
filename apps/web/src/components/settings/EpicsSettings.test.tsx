import {
  DEFAULT_EPIC_ROLE_POLICY,
  EpicInSessionRoleName,
  EpicTierId,
  type EpicRolePolicy,
} from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { InSessionRoleEditor } from "./EpicsSettings";
import { buildInSessionRoleRows } from "./EpicsSettings.logic";

const primaryTierId = EpicTierId.make("primary");
const plannerName = EpicInSessionRoleName.make("planner");

const policy: EpicRolePolicy = {
  tiers: { [primaryTierId]: { expandSameDriverAccounts: true, hops: [] } },
  roles: {},
  inSessionRoles: {
    [plannerName]: {
      tier: primaryTierId,
      description: "Plans one child.",
      prompt: "You plan.",
    },
  },
};

describe("InSessionRoleEditor", () => {
  it("renders the subagent's tier, description, and prompt", () => {
    const row = buildInSessionRoleRows(policy)[0]!;
    const markup = renderToStaticMarkup(
      <InSessionRoleEditor
        row={row}
        policy={policy}
        tierIds={[primaryTierId]}
        onPolicyChange={() => {}}
      />,
    );

    expect(markup).toContain("planner");
    expect(markup).toContain("Runs on tier primary");
    expect(markup).toContain("Plans one child.");
    expect(markup).toContain("You plan.");
  });

  it("nudges an untiered subagent without warning about it", () => {
    const untiered: EpicRolePolicy = {
      ...policy,
      inSessionRoles: {
        [plannerName]: { description: "Plans one child.", prompt: "You plan." },
      },
    };
    const markup = renderToStaticMarkup(
      <InSessionRoleEditor
        row={buildInSessionRoleRows(untiered)[0]!}
        policy={untiered}
        tierIds={[primaryTierId]}
        onPolicyChange={() => {}}
      />,
    );

    expect(markup).toContain("Runs on the worker&#x27;s session model.");
    expect(markup).toContain("Assign a tier for a dedicated fallback chain.");
    // Tier-less is the shipped state, so it must not read as a problem.
    expect(markup).not.toContain("no longer exists");
  });

  it("warns when a subagent names a tier the policy no longer has", () => {
    const orphaned: EpicRolePolicy = { ...policy, tiers: {} };
    const markup = renderToStaticMarkup(
      <InSessionRoleEditor
        row={buildInSessionRoleRows(orphaned)[0]!}
        policy={orphaned}
        tierIds={[]}
        onPolicyChange={() => {}}
      />,
    );

    expect(markup).toContain('<span class="text-destructive">');
    expect(markup).toContain("no longer exists");
  });

  it("renders every shipped stage subagent an untouched install starts with", () => {
    const rows = buildInSessionRoleRows(DEFAULT_EPIC_ROLE_POLICY);

    expect(rows.map((row) => row.name)).toEqual([
      "planner",
      "implementer",
      "reviewer",
      "tester",
      "cleanup",
      "investigator",
    ]);
    for (const row of rows) {
      const markup = renderToStaticMarkup(
        <InSessionRoleEditor
          row={row}
          policy={DEFAULT_EPIC_ROLE_POLICY}
          tierIds={[]}
          onPolicyChange={() => {}}
        />,
      );

      expect(markup).toContain(row.name);
      // Shipped roles carry no tier, so the editor nudges rather than warns.
      expect(markup).toContain("Runs on the worker&#x27;s session model.");
      expect(markup).not.toContain("no longer exists");
      expect(markup).toContain("Verification rules:");
    }
  });
});
