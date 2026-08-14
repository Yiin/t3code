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
  tiers: { [primaryTierId]: { hops: [] } },
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

  it("says an untiered subagent inherits the session model", () => {
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

    expect(markup).toContain("Inherits the worker session&#x27;s model.");
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
      // Shipped roles carry no tier, so the editor offers the session model.
      expect(markup).toContain("Inherits the worker session&#x27;s model.");
      expect(markup).toContain("Verification rules:");
    }
  });
});
