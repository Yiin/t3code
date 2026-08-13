/**
 * git rerere ("reuse recorded resolution") for parallel epic runs.
 *
 * A parallel run hits the same conflict more than once: the drain trial-merges
 * a branch, parks it, a merge-fix child resolves it by hand, and the next drain
 * merges that same branch again — plus every later drain that replays the same
 * base-versus-branch hunk. rerere records the resolution the first time a human
 * or an agent commits it and replays it every time after.
 *
 * The cache lives in the repository's COMMON git directory (`<repo>/.git/rr-cache`),
 * which every worktree of that repository shares. A merge-fix child resolving in
 * its own worker worktree therefore teaches the integration worktree, and vice
 * versa. Removing a worktree never touches the cache.
 *
 * Note that when a run shares the operator's checkout, `repositoryPath` IS the
 * operator's own repository, so {@link RERERE_CONFIG_ARGS} writes into the config
 * the operator uses by hand. That is deliberate: rerere is per-repository by
 * design, it only ever replays a resolution the repository itself recorded, and
 * an operator resolving the same conflict benefits from the same cache.
 */

/** `git config` invocations that turn rerere on for a repository, idempotently. */
export const RERERE_CONFIG_ARGS: ReadonlyArray<ReadonlyArray<string>> = [
  ["config", "rerere.enabled", "true"],
  ["config", "rerere.autoUpdate", "true"],
];

/**
 * Command-scoped `-c` flags for a merge, so replay does not depend on the
 * repository config staying set.
 *
 * Provisioning writes the config (see {@link RERERE_CONFIG_ARGS}), but a run can
 * outlive the write: an operator can unset it, a resumed run can adopt a
 * repository provisioned before this existed, and a sibling can be added by
 * hand. These flags make every trial merge record and replay regardless.
 */
export const RERERE_MERGE_FLAGS: ReadonlyArray<string> = [
  "-c",
  "rerere.enabled=true",
  "-c",
  "rerere.autoUpdate=true",
];

/**
 * Complete a merge that rerere resolved on its own.
 *
 * `git merge` always exits non-zero on a conflict, even when rerere staged a
 * recorded resolution for every conflicted path — it stages, it never commits.
 * Left alone, a trial merge whose conflict rerere already knows would park all
 * the same and spawn a merge-fix child with nothing to fix. So a non-zero merge
 * with a live `MERGE_HEAD` and zero unmerged paths is a success that needs one
 * more command.
 *
 * `--cleanup=strip` matters: `git commit --no-edit` reads `MERGE_MSG`, which git
 * appended a `# Conflicts:` comment block to, and only `strip` drops it. Without
 * it the merge commit's subject stops matching `trialMergeMessage`, which is
 * what `landedSubjects` parses. `--no-verify` keeps parity with the clean path,
 * where `git merge` commits without running pre-commit hooks.
 */
export const RERERE_COMMIT_ARGS: ReadonlyArray<string> = [
  "commit",
  "--no-verify",
  "--no-edit",
  "--cleanup=strip",
];

/** `git rev-parse` probe for an in-progress merge. */
export const MERGE_HEAD_ARGS: ReadonlyArray<string> = [
  "rev-parse",
  "--verify",
  "--quiet",
  "MERGE_HEAD",
];

/** `git diff` probe for paths still carrying conflict markers. */
export const UNMERGED_PATHS_ARGS: ReadonlyArray<string> = [
  "diff",
  "--name-only",
  "--diff-filter=U",
];
