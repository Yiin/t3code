import { describe, expect, it } from "vite-plus/test";

import {
  buildMobileSlashCommandItems,
  groupMobileSlashCommandItems,
  mobileSlashCommandGroups,
} from "./composerSlashCommands";

describe("mobile slash commands", () => {
  it("merges case-insensitively with provider commands winning and preserves provenance", () => {
    const items = buildMobileSlashCommandItems({
      providerCommands: [{ name: "Cook-It", description: "Provider version" }],
      workspaceCommands: [
        { name: "cook-it", description: "Workspace version", source: "workspace" },
        { name: "plan-epic", description: "Plan work", source: "workspace" },
      ],
      query: "",
    });

    expect(items.filter((item) => item.label.toLowerCase() === "/cook-it")).toMatchObject([
      { source: "provider", description: "Provider version" },
    ]);
    expect(items.find((item) => item.label === "/plan-epic")).toMatchObject({
      source: "workspace",
    });
    expect(groupMobileSlashCommandItems(items).map((group) => group.label)).toEqual([
      "Built-in",
      "Workspace",
      "Provider",
    ]);
  });

  it("keeps ranked search results in one ordered group", () => {
    const items = buildMobileSlashCommandItems({
      providerCommands: [{ name: "ui", description: "Build interfaces" }],
      workspaceCommands: [
        { name: "cook-it", description: "UI task workflow", source: "workspace" },
      ],
      query: "ui",
    });

    expect(items.map((item) => item.label)).toEqual(["/ui", "/cook-it"]);
    expect(mobileSlashCommandGroups(items, false)).toMatchObject([
      { label: null, items: [{ label: "/ui" }, { label: "/cook-it" }] },
    ]);
  });
});
