import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind } from "@t3tools/contracts";

import type { ComposerCommandItem } from "./ComposerCommandMenu";
import { mergeComposerSlashCommands, searchSlashCommandItems } from "./composerSlashCommandSearch";

describe("searchSlashCommandItems", () => {
  const claudeDriver = ProviderDriverKind.make("claudeAgent");

  it("moves exact provider command matches ahead of broader description matches", () => {
    const items = [
      {
        id: "slash:default",
        type: "slash-command",
        command: "default",
        label: "/default",
        description: "Switch this thread back to normal build mode",
      },
      {
        id: "provider-slash-command:claudeAgent:ui",
        type: "provider-slash-command",
        provider: claudeDriver,
        source: "provider",
        command: { name: "ui" },
        label: "/ui",
        description: "Explore, build, and refine UI.",
      },
      {
        id: "provider-slash-command:claudeAgent:frontend-design",
        type: "provider-slash-command",
        provider: claudeDriver,
        source: "provider",
        command: { name: "frontend-design" },
        label: "/frontend-design",
        description: "Create distinctive, production-grade frontend interfaces",
      },
    ] satisfies Array<
      Extract<ComposerCommandItem, { type: "slash-command" | "provider-slash-command" }>
    >;

    expect(searchSlashCommandItems(items, "ui").map((item) => item.id)).toEqual([
      "provider-slash-command:claudeAgent:ui",
      "slash:default",
    ]);
  });

  it("supports fuzzy provider command matches", () => {
    const items = [
      {
        id: "provider-slash-command:claudeAgent:gh-fix-ci",
        type: "provider-slash-command",
        provider: claudeDriver,
        source: "provider",
        command: { name: "gh-fix-ci" },
        label: "/gh-fix-ci",
        description: "Fix failing GitHub Actions",
      },
      {
        id: "provider-slash-command:claudeAgent:github",
        type: "provider-slash-command",
        provider: claudeDriver,
        source: "provider",
        command: { name: "github" },
        label: "/github",
        description: "General GitHub help",
      },
    ] satisfies Array<
      Extract<ComposerCommandItem, { type: "slash-command" | "provider-slash-command" }>
    >;

    expect(searchSlashCommandItems(items, "gfc").map((item) => item.id)).toEqual([
      "provider-slash-command:claudeAgent:gh-fix-ci",
    ]);
  });
});

describe("mergeComposerSlashCommands", () => {
  const provider = ProviderDriverKind.make("claudeAgent");

  it("includes workspace commands when the provider reports none", () => {
    expect(
      mergeComposerSlashCommands({
        provider,
        providerCommands: [],
        workspaceCommands: [{ name: "cook-it", description: "Cook a task", source: "workspace" }],
      }),
    ).toMatchObject([
      {
        command: { name: "cook-it", description: "Cook a task" },
        source: "workspace",
        label: "/cook-it",
        description: "Cook a task",
      },
    ]);
  });

  it("deduplicates case-insensitively with the provider command winning", () => {
    const items = mergeComposerSlashCommands({
      provider,
      providerCommands: [{ name: "Cook-It", description: "Provider description" }],
      workspaceCommands: [
        { name: "cook-it", description: "Workspace description", source: "workspace" },
        { name: "PLAN-EPIC", source: "workspace" },
        { name: "plan-epic", source: "workspace" },
      ],
    });

    expect(items.map((item) => item.command.name)).toEqual(["Cook-It", "PLAN-EPIC"]);
    expect(items[0]?.description).toBe("Provider description");
    expect(items[0]?.source).toBe("provider");
    expect(items[1]?.description).toBe("Run command");
    expect(items[1]?.source).toBe("workspace");
  });
});
