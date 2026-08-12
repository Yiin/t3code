import { ThreadId, type ThreadTurnDiffSubagentContribution } from "@t3tools/contracts";

/**
 * Read-time attribution of a subagent's files, shared by the turn diff and the
 * timeline's changed-files tree.
 *
 * A thread-backed child edits the same worktree as the parent that spawned it
 * and always settles before the parent's checkpoint is captured, so its files
 * land in the parent's checkpoint and in the parent's patch. Both surfaces
 * therefore need the same answer: which child wrote which path. Computing it at
 * read time keeps it out of the capture path, where it would race the child's
 * own checkpoint landing.
 */

/** One child checkpoint, as the projection stores it. */
export interface SubagentCheckpointRow {
  readonly threadId: string;
  readonly title: string;
  readonly files: ReadonlyArray<{ readonly path: string }>;
}

/** A child checkpoint with the time it completed, for windowing. */
export interface TimedSubagentCheckpointRow extends SubagentCheckpointRow {
  readonly completedAt: string;
}

/**
 * Fold every child checkpoint inside one window into one row per child.
 *
 * A child can checkpoint several of its own turns inside a single parent turn,
 * so its paths are de-duplicated and its rows collapse into one contribution. A
 * child that wrote no file is dropped: naming it would label nothing.
 */
export function foldSubagentContributions(
  rows: ReadonlyArray<SubagentCheckpointRow>,
): ReadonlyArray<ThreadTurnDiffSubagentContribution> {
  const byThreadId = new Map<string, { title: string; paths: Set<string> }>();
  for (const row of rows) {
    const existing = byThreadId.get(row.threadId);
    const entry = existing ?? { title: row.title, paths: new Set<string>() };
    for (const file of row.files) {
      entry.paths.add(file.path);
    }
    if (!existing) {
      byThreadId.set(row.threadId, entry);
    }
  }
  return Array.from(byThreadId.entries())
    .filter(([, entry]) => entry.paths.size > 0)
    .map(([threadId, entry]) => ({
      threadId: ThreadId.make(threadId),
      title: entry.title,
      paths: Array.from(entry.paths).toSorted((left, right) => left.localeCompare(right)),
    }));
}

/**
 * Split a parent's child checkpoints across the parent's own checkpoints.
 *
 * The result is aligned with `checkpoints` by index. Each parent checkpoint
 * takes the children that completed after the previous parent checkpoint and at
 * or before its own completion time, the same half-open window the turn diff
 * uses, so the tree and the diff cannot disagree. The first checkpoint has an
 * open lower bound, because the turn before it has no checkpoint to bound it.
 */
export function attributeSubagentCheckpointContributions(input: {
  readonly checkpoints: ReadonlyArray<{ readonly completedAt: string }>;
  readonly rows: ReadonlyArray<TimedSubagentCheckpointRow>;
}): ReadonlyArray<ReadonlyArray<ThreadTurnDiffSubagentContribution>> {
  if (input.checkpoints.length === 0) {
    return [];
  }
  if (input.rows.length === 0) {
    return input.checkpoints.map(() => []);
  }
  return input.checkpoints.map((checkpoint, index) => {
    const after = index === 0 ? null : (input.checkpoints[index - 1]?.completedAt ?? null);
    const windowed = input.rows.filter(
      (row) =>
        (after === null || row.completedAt > after) && row.completedAt <= checkpoint.completedAt,
    );
    return foldSubagentContributions(windowed);
  });
}
