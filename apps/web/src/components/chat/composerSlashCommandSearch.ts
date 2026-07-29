import {
  insertRankedSearchResult,
  normalizeSearchQuery,
  scoreQueryMatch,
} from "@t3tools/shared/searchRanking";

import type { ComposerCommandItem } from "./ComposerCommandMenu";
import type {
  ProviderDriverKind,
  ServerProviderSlashCommand,
  ServerWorkspaceSlashCommand,
} from "@t3tools/contracts";

export function mergeComposerSlashCommands(input: {
  provider: ProviderDriverKind;
  providerCommands: ReadonlyArray<ServerProviderSlashCommand>;
  workspaceCommands: ReadonlyArray<ServerWorkspaceSlashCommand>;
}): Array<Extract<ComposerCommandItem, { type: "provider-slash-command" }>> {
  const providerNames = new Set(
    input.providerCommands.map((command) => command.name.toLowerCase()),
  );
  const commands = [
    ...input.providerCommands,
    ...input.workspaceCommands
      .filter((command) => !providerNames.has(command.name.toLowerCase()))
      .filter(
        (command, index, commands) =>
          commands.findIndex(
            (candidate) => candidate.name.toLowerCase() === command.name.toLowerCase(),
          ) === index,
      ),
  ];

  return commands.map((command) => ({
    id: `provider-slash-command:${input.provider}:${command.name}`,
    type: "provider-slash-command",
    provider: input.provider,
    source: "source" in command && command.source === "workspace" ? "workspace" : "provider",
    command,
    label: `/${command.name}`,
    description:
      command.description ??
      ("input" in command ? command.input?.hint : undefined) ??
      ("source" in command && command.source === "workspace"
        ? "Run command"
        : "Run provider command"),
  }));
}

function scoreSlashCommandItem(
  item: Extract<ComposerCommandItem, { type: "slash-command" | "provider-slash-command" }>,
  query: string,
): number | null {
  const primaryValue =
    item.type === "slash-command" ? item.command.toLowerCase() : item.command.name.toLowerCase();
  const description = item.description.toLowerCase();

  const scores = [
    scoreQueryMatch({
      value: primaryValue,
      query,
      exactBase: 0,
      prefixBase: 2,
      boundaryBase: 4,
      includesBase: 6,
      fuzzyBase: 100,
      boundaryMarkers: ["-", "_", "/"],
    }),
    scoreQueryMatch({
      value: description,
      query,
      exactBase: 20,
      prefixBase: 22,
      boundaryBase: 24,
      includesBase: 26,
    }),
  ].filter((score): score is number => score !== null);

  if (scores.length === 0) {
    return null;
  }

  return Math.min(...scores);
}

export function searchSlashCommandItems(
  items: ReadonlyArray<
    Extract<ComposerCommandItem, { type: "slash-command" | "provider-slash-command" }>
  >,
  query: string,
): Array<Extract<ComposerCommandItem, { type: "slash-command" | "provider-slash-command" }>> {
  const normalizedQuery = normalizeSearchQuery(query, { trimLeadingPattern: /^\/+/ });
  if (!normalizedQuery) {
    return [...items];
  }

  const ranked: Array<{
    item: Extract<ComposerCommandItem, { type: "slash-command" | "provider-slash-command" }>;
    score: number;
    tieBreaker: string;
  }> = [];

  for (const item of items) {
    const score = scoreSlashCommandItem(item, normalizedQuery);
    if (score === null) {
      continue;
    }

    insertRankedSearchResult(
      ranked,
      {
        item,
        score,
        tieBreaker:
          item.type === "slash-command"
            ? `0\u0000${item.command}`
            : `1\u0000${item.command.name}\u0000${item.provider}`,
      },
      Number.POSITIVE_INFINITY,
    );
  }

  return ranked.map((entry) => entry.item);
}
