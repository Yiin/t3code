import type { ThreadTurnDiffSubagentContribution } from "@t3tools/contracts";

/**
 * Which subagents wrote each path inside a turn diff.
 *
 * A thread-backed subagent edits the same worktree as the chat that spawned it,
 * and it always settles before the parent's checkpoint is captured, so its
 * files land in the parent's turn diff. The patch is a correct snapshot of the
 * worktree; only the attribution is wrong. This index lets the diff view name
 * the subagent on those files instead of letting the parent claim them.
 */
export type SubagentDiffAttribution = ReadonlyMap<string, ReadonlyArray<string>>;

const EMPTY_ATTRIBUTION: SubagentDiffAttribution = new Map();

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

/** Label one subagent by its title, falling back to its thread id. */
export function resolveSubagentLabel(contribution: ThreadTurnDiffSubagentContribution): string {
  const title = contribution.title.trim();
  return title.length > 0 ? title : contribution.threadId;
}

export function buildSubagentDiffAttribution(
  contributions: ReadonlyArray<ThreadTurnDiffSubagentContribution> | undefined,
): SubagentDiffAttribution {
  if (!contributions || contributions.length === 0) {
    return EMPTY_ATTRIBUTION;
  }
  const byPath = new Map<string, string[]>();
  for (const contribution of contributions) {
    const label = resolveSubagentLabel(contribution);
    for (const path of contribution.paths) {
      const key = normalizePath(path);
      const labels = byPath.get(key);
      if (labels) {
        if (!labels.includes(label)) labels.push(label);
      } else {
        byPath.set(key, [label]);
      }
    }
  }
  return byPath;
}

export function readSubagentDiffLabels(
  attribution: SubagentDiffAttribution,
  filePath: string,
): ReadonlyArray<string> {
  return attribution.get(normalizePath(filePath)) ?? [];
}

/** Badge text for a file a subagent wrote. Names one, counts the rest. */
export function formatSubagentDiffBadge(labels: ReadonlyArray<string>): string | null {
  const [first, ...rest] = labels;
  if (!first) return null;
  return rest.length === 0 ? first : `${first} +${String(rest.length)}`;
}
