import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind } from "@t3tools/contracts";

import { groupCommandItems, type ComposerCommandItem } from "./ComposerCommandMenu";

describe("groupCommandItems", () => {
  it("partitions ranked slash commands without losing their order", () => {
    const provider = ProviderDriverKind.make("claudeAgent");
    const items = [
      {
        id: "provider",
        type: "provider-slash-command",
        provider,
        source: "provider",
        command: { name: "ui" },
        label: "/ui",
        description: "Provider",
      },
      {
        id: "workspace",
        type: "provider-slash-command",
        provider,
        source: "workspace",
        command: { name: "cook-it" },
        label: "/cook-it",
        description: "Workspace",
      },
      {
        id: "built-in",
        type: "slash-command",
        command: "plan",
        label: "/plan",
        description: "Built in",
      },
    ] satisfies ComposerCommandItem[];

    expect(groupCommandItems(items, "slash-command", true)).toMatchObject([
      { id: "built-in", items: [{ id: "built-in" }] },
      { id: "workspace", items: [{ id: "workspace" }] },
      { id: "provider", items: [{ id: "provider" }] },
    ]);
  });
});
