# AGENTS.md

## Task Completion Requirements

- Keep local verification focused on the files and packages changed. Run the smallest relevant test set; do not run the full workspace test suite as a routine completion step.
  - Use `vp test run <test-files>` for focused built-in Vite+ tests. Use `vp run test` only when the affected package specifically requires its `test` script.
  - Backend changes must include and run focused tests for the changed behavior.
  - Run targeted formatting, lint, and type checks for the affected scope when available.
- Do not run repo-wide `vp check`, `vp run typecheck`, `vp run test`, or equivalent full-suite commands as a routine completion step. CI runs the full verification suite on pull requests and pushes to `main` or `mine`.
  - Exception: when a task hands you a specific gate command to run — an epic merge-fix child does, and the user may — run that command exactly as given. That is the request, and reporting a focused check in its place is a false pass.
- After frontend feature development or any user-visible frontend behavior change, the primary agent must run one integrated verification pass after integrating the work:
  - Use the `test-t3-app` skill. Launch one isolated environment, authenticate through the printed pairing URL, and verify the affected flow in the controlled browser.
  - The web app is the only client. Phones are served by the same React app, so check the affected flow at a phone viewport whenever the change touches layout, touch targets, or navigation.
  - Subagents must not independently launch dev servers or repeat integrated client verification unless their delegated task explicitly requires it.
  - Stop dev servers, watchers, and other long-running verification processes when the focused verification is complete.

## Package Roles

- `apps/server`: Node.js WebSocket server. Owns provider drivers and sessions, serves the React web app, and runs orchestration such as EpicRunner.
- `apps/web`: React/Vite UI and the only client. Owns session UX, conversation/event rendering, and client-side state. Connects to the server via WebSocket. Phones are served by this app, so treat mobile web as a first-class target, not an afterthought.
- `packages/contracts`: Shared effect/Schema schemas and TypeScript contracts for provider events, WebSocket protocol, and model/session types. Keep this package schema-only — no runtime logic.
- `packages/shared`: Shared runtime utilities consumed by both server and client applications. Uses explicit subpath exports (e.g. `@t3tools/shared/git`) — no barrel index.
- `packages/client-runtime`: Shared client runtime consumed by `apps/web`. It was built to share code with a native client that no longer exists, so its seams are wider than one consumer needs. Keep it — collapsing it into the web app is a separate decision.
- Do not inspect or edit generated `dist` files when source exists.

## Reference Repos

- Open-source Codex repo: https://github.com/openai/codex

Use these as implementation references when designing protocol handling, UX flows, and operational safeguards.

## Vendored Repositories

This project vendors external repositories under `.repos/` as read-only reference material for coding
agents.

- Prefer examples and patterns from the vendored source code over generated guesses or web search results.
- Do not edit files under `.repos/` unless explicitly asked.
- Do not import from `.repos/`; application code must continue importing from normal package dependencies.
- Manage vendored subtrees with `vpr sync:repos`; use `vpr sync:repos --repo <id>` to sync one configured repository.
- When updating a dependency with a configured vendored subtree, sync that subtree in the same change so
  `.repos/` matches the installed dependency version.
- When writing Effect code, read `.repos/effect-smol/LLMS.md` first and inspect `.repos/effect-smol/` for
  examples of idiomatic usage, tests, module structure, and API design.
- When writing relay infrastructure code with Alchemy, inspect `.repos/alchemy-effect/` for examples of
  idiomatic usage, tests, module structure, and API design.

## Beads Topology (this repo)

This section is hand-written and outranks the generated Beads blocks below. `bd setup <recipe>` rewrites
those blocks from an upstream template that assumes a local database. That assumption is wrong here. If
the two ever disagree, this section wins.

- Beads for this repo live in the **shared Dolt server on yiin-lt**, not in a local database:
  `dolt.host 100.107.50.39`, port `3306`, database `t3code` (`.beads/config.yaml`, `.beads/metadata.json`).
  Confirm with `bd config show | grep dolt`.
- Every `bd` write lands on that server immediately. Other machines and other projects read the same server,
  so there is nothing to sync for them to see your change. Do not tell the user their work is "local" or
  "unpushed".
- `bd dolt push` mirrors the database to `refs/dolt/data` on the git remote. That is an **off-site backup**,
  not the sync path. It is optional, and it is not needed for cross-machine visibility.
- `.beads/issues.jsonl` is a passive export. Never edit it, and never treat it as the source of truth.
- `.beads/embeddeddolt/` is a leftover from the pre-server setup. Ignore it.
- To verify data really landed, query the server directly rather than trusting `bd`'s own read path:

  ```bash
  dolt --host 100.107.50.39 --port 3306 --user root --password '' --no-tls --use-db t3code \
    sql -r csv -q "select id, status from issues where id = '<id>';"
  ```

- Known benign `bd doctor` error: "Database belongs to different repository" (stored `96efd996`, current
  `3b2da1be`). The git remote is SSH (`git@github.com:Yiin/t3code.git`) while `sync.remote` is HTTPS, and the
  two URL forms hash differently. It blocks nothing. Do not "fix" it with `rm -rf .beads && bd init`.

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:970c3bf2 -->

## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

**Architecture in one line (corrected for this repo):** issues live in the shared Dolt **server** on yiin-lt (`100.107.50.39:3306`, database `t3code`), so every write is instantly visible to every machine pointed at it; `bd dolt push` to `refs/dolt/data` is an off-site backup, not the sync path; `.beads/issues.jsonl` is a passive export. See "Beads Topology (this repo)" above, which outranks this generated block. Upstream reference: https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md

## Agent Context Profiles

The managed Beads block is task-tracking guidance, not permission to override repository, user, or orchestrator instructions.

- **Conservative (default)**: Use `bd` for task tracking. Do not run git commits, git pushes, or Dolt remote sync unless explicitly asked. At handoff, report changed files, validation, and suggested next commands.
- **Minimal**: Keep tool instruction files as pointers to `bd prime`; use the same conservative git policy unless active instructions say otherwise.
- **Team-maintainer**: Only when the repository explicitly opts in, agents may close beads, run quality gates, commit, and push as part of session close. A current "do not commit" or "do not push" instruction still wins.

## Session Completion

This protocol applies when ending a Beads implementation workflow. It is subordinate to explicit user, repository, and orchestrator instructions.

1. **File issues for remaining work** - Create beads for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **Handle git/sync by active profile**:

   ```bash
   # Conservative/minimal/default: report status and proposed commands; wait for approval.
   git status

   # Team-maintainer opt-in only, unless current instructions forbid it:
   git pull --rebase
   bd dolt push   # optional off-site backup only. Beads writes already landed on the
                  # shared server. Never report bd work as unsynced without this.
   git push
   git status
   ```

5. **Hand off** - Summarize changes, validation, issue status, and any blocked sync/commit/push step

**Critical rules:**

- Explicit user or orchestrator instructions override this Beads block.
- Do not commit or push without clear authority from the active profile or the current user request.
- If a required sync or push is blocked, stop and report the exact command and error.
<!-- END BEADS INTEGRATION -->

<!-- BEGIN BEADS CODEX SETUP: generated by bd setup codex -->

## Beads Issue Tracker

Use Beads (`bd`) for durable task tracking in repositories that include it. Use the `beads` skill at `.agents/skills/beads/SKILL.md` (project install) or `~/.agents/skills/beads/SKILL.md` (global install) for Beads workflow guidance, then use the `bd` CLI for issue operations.

### Quick Reference

```bash
bd ready                # Find available work
bd show <id>            # View issue details
bd update <id> --claim  # Claim work
bd close <id>           # Complete work
bd prime                # Refresh Beads context
```

### Rules

- Use `bd` for all task tracking; do not create markdown TODO lists.
- Run `bd prime` when Beads context is missing or stale. Codex 0.129.0+ can load Beads context automatically through native hooks; use `/hooks` to inspect or toggle them.
- Keep persistent project memory in Beads via `bd remember`; do not create ad hoc memory files.

**Architecture in one line (corrected for this repo):** issues live in the shared Dolt **server** on yiin-lt (`100.107.50.39:3306`, database `t3code`), so every write is instantly visible to every machine pointed at it; `bd dolt push` to `refs/dolt/data` is an off-site backup, not the sync path; `.beads/issues.jsonl` is a passive export. See "Beads Topology (this repo)" above, which outranks this generated block. Upstream reference: https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md

<!-- END BEADS CODEX SETUP -->
