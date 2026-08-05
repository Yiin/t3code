import { describe, expect, it } from "vite-plus/test";

import { mergeComposerSkills } from "./composerSkills.ts";

describe("mergeComposerSkills", () => {
  it("appends workspace skills after provider skills", () => {
    expect(
      mergeComposerSkills({
        providerSkills: [{ name: "pdf", enabled: true, path: "/skills/pdf" }],
        workspaceCommands: [{ name: "cook-it", description: "Cook a task", source: "workspace" }],
      }),
    ).toEqual([
      { name: "pdf", enabled: true, path: "/skills/pdf" },
      { name: "cook-it", enabled: true, description: "Cook a task" },
    ]);
  });

  it("deduplicates case-insensitively with the provider skill winning", () => {
    const skills = mergeComposerSkills({
      providerSkills: [{ name: "Cook-It", enabled: true, description: "Provider version" }],
      workspaceCommands: [
        { name: "cook-it", description: "Workspace version", source: "workspace" },
        { name: "plan-epic", source: "workspace" },
        { name: "PLAN-EPIC", source: "workspace" },
      ],
    });

    expect(skills.map((skill) => skill.name)).toEqual(["Cook-It", "plan-epic"]);
    expect(skills[0]?.description).toBe("Provider version");
    expect(skills[1]?.description).toBeUndefined();
  });
});
