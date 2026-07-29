import type { ServerProviderSlashCommand, ServerWorkspaceSlashCommand } from "@t3tools/contracts";
import {
  insertRankedSearchResult,
  normalizeSearchQuery,
  scoreQueryMatch,
} from "@t3tools/shared/searchRanking";

export type MobileSlashCommandItem =
  | {
      readonly id: string;
      readonly type: "slash-command";
      readonly command: string;
      readonly source: "built-in";
      readonly label: string;
      readonly description: string;
    }
  | {
      readonly id: string;
      readonly type: "provider-slash-command";
      readonly command: ServerProviderSlashCommand;
      readonly source: "workspace" | "provider";
      readonly label: string;
      readonly description: string;
    };

export interface MobileSlashCommandGroup {
  readonly id: "built-in" | "workspace" | "provider" | "results";
  readonly label: "Built-in" | "Workspace" | "Provider" | null;
  readonly items: ReadonlyArray<MobileSlashCommandItem>;
}

const builtIns: ReadonlyArray<MobileSlashCommandItem> = [
  {
    id: "cmd:model",
    type: "slash-command",
    command: "model",
    source: "built-in",
    label: "/model",
    description: "Switch model",
  },
  {
    id: "cmd:plan",
    type: "slash-command",
    command: "plan",
    source: "built-in",
    label: "/plan",
    description: "Switch to plan mode",
  },
  {
    id: "cmd:default",
    type: "slash-command",
    command: "default",
    source: "built-in",
    label: "/default",
    description: "Switch to default mode",
  },
];

export function buildMobileSlashCommandItems(input: {
  readonly providerCommands: ReadonlyArray<ServerProviderSlashCommand>;
  readonly workspaceCommands: ReadonlyArray<ServerWorkspaceSlashCommand>;
  readonly query: string;
}): MobileSlashCommandItem[] {
  const providerNames = new Set(
    input.providerCommands.map((command) => command.name.toLowerCase()),
  );
  const commands = [
    ...input.providerCommands.map((command) => ({ command, source: "provider" as const })),
    ...input.workspaceCommands
      .filter((command) => !providerNames.has(command.name.toLowerCase()))
      .filter(
        (command, index, commands) =>
          commands.findIndex(
            (candidate) => candidate.name.toLowerCase() === command.name.toLowerCase(),
          ) === index,
      )
      .map((command) => ({ command, source: "workspace" as const })),
  ];
  const items: MobileSlashCommandItem[] = [
    ...builtIns,
    ...commands.map(({ command, source }) => ({
      id: `pcmd:${source}:${command.name}`,
      type: "provider-slash-command" as const,
      command,
      source,
      label: `/${command.name}`,
      description: command.description ?? (source === "workspace" ? "Run command" : ""),
    })),
  ];
  const query = normalizeSearchQuery(input.query, { trimLeadingPattern: /^\/+/ });
  if (!query) return items;

  const ranked: Array<{ item: MobileSlashCommandItem; score: number; tieBreaker: string }> = [];
  for (const item of items) {
    const name = item.type === "slash-command" ? item.command : item.command.name;
    const scores = [
      scoreQueryMatch({
        value: name.toLowerCase(),
        query,
        exactBase: 0,
        prefixBase: 2,
        boundaryBase: 4,
        includesBase: 6,
        fuzzyBase: 100,
        boundaryMarkers: ["-", "_", "/"],
      }),
      scoreQueryMatch({
        value: item.description.toLowerCase(),
        query,
        exactBase: 20,
        prefixBase: 22,
        boundaryBase: 24,
        includesBase: 26,
      }),
    ].filter((score): score is number => score !== null);
    if (scores.length === 0) continue;
    insertRankedSearchResult(
      ranked,
      { item, score: Math.min(...scores), tieBreaker: `${item.label}\u0000${item.id}` },
      Number.POSITIVE_INFINITY,
    );
  }
  return ranked.map(({ item }) => item);
}

export function groupMobileSlashCommandItems(
  items: ReadonlyArray<MobileSlashCommandItem>,
): MobileSlashCommandGroup[] {
  const definitions = [
    { id: "built-in", label: "Built-in" },
    { id: "workspace", label: "Workspace" },
    { id: "provider", label: "Provider" },
  ] as const;
  return definitions.flatMap((definition) => {
    const groupItems = items.filter((item) => item.source === definition.id);
    return groupItems.length > 0 ? [{ ...definition, items: groupItems }] : [];
  });
}

export function mobileSlashCommandGroups(
  items: ReadonlyArray<MobileSlashCommandItem>,
  groupSections: boolean,
): MobileSlashCommandGroup[] {
  return groupSections
    ? groupMobileSlashCommandItems(items)
    : [{ id: "results", label: null, items }];
}
