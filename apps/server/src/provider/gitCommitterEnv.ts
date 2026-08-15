import type { GitCommitterIdentity } from "@t3tools/contracts";

/**
 * Maps a run-scoped git committer identity (t3code-e6l) onto the
 * `GIT_COMMITTER_*` env vars injected into an epic worker's spawn
 * environment. Committer only — this never sets `GIT_AUTHOR_*` — so a
 * normal commit's authorship stays whatever the process's own git config
 * says, and only the committer trailer carries the run's stamp.
 */
export function toGitCommitterEnv(identity: GitCommitterIdentity): Record<string, string> {
  return {
    GIT_COMMITTER_NAME: identity.name,
    GIT_COMMITTER_EMAIL: identity.email,
  };
}
