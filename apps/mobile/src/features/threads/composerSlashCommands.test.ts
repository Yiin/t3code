import { describe, expect, it } from "vite-plus/test";

import {
  buildMobileSlashCommandItems,
  groupMobileSlashCommandItems,
  mobileSlashCommandGroups,
} from "./composerSlashCommands";

describe("mobile slash commands", () => {
  it("lists built-ins and provider commands in grouped sections", () => {
    const items = buildMobileSlashCommandItems({
      providerCommands: [{ name: "compact", description: "Compact the conversation" }],
      query: "",
    });

    expect(items.find((item) => item.label === "/compact")).toMatchObject({
      source: "provider",
      description: "Compact the conversation",
    });
    expect(groupMobileSlashCommandItems(items).map((group) => group.label)).toEqual([
      "Built-in",
      "Provider",
    ]);
  });

  it("keeps ranked search results in one ordered group", () => {
    const items = buildMobileSlashCommandItems({
      providerCommands: [
        { name: "ui", description: "Build interfaces" },
        { name: "cook-it", description: "UI task workflow" },
      ],
      query: "ui",
    });

    expect(items.map((item) => item.label)).toEqual(["/ui", "/cook-it"]);
    expect(mobileSlashCommandGroups(items, false)).toMatchObject([
      { label: null, items: [{ label: "/ui" }, { label: "/cook-it" }] },
    ]);
  });
});
