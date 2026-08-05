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
        command: { name: "ui" },
        label: "/ui",
        description: "Provider",
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
      { id: "provider", items: [{ id: "provider" }] },
    ]);
  });
});
