# Run an epic from a terminal or T3 Code

You can start an epic in a plain terminal and continue it from T3 Code, or do
the reverse. Beads and Git are the shared source of truth. T3 Code observes that
state and launches work; it does not keep a second copy of issue status.

## Shared state

| State                                         | Location                                                                                                    | Owner                                 |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| Issue status, claims, dependencies, and notes | The repository's `.beads` database                                                                          | Workers using `bd`                    |
| Commits and branches                          | Git; parallel cook-epic workers use `epic/<child-id>` branches and worktrees                                | Workers and cook-epic                 |
| Loop prompt and reports                       | A Ralph `RUN_DIR` under `/var/tmp`, including `prompt.md`, `mailbox.jsonl`, `summary.md`, and `iter-N.json` | Ralph                                 |
| Epic run lock                                 | `<repo>/.beads/run-lock.<epic-id>.json`                                                                     | The active terminal or T3 Code runner |
| T3 Code run recovery state                    | `epic_runs` rows in `~/.t3/userdata/state.sqlite`                                                           | T3 Code server                        |

The branch and worktree rules come from
[`skills/cook-epic/SKILL.md:14-20`](../skills/cook-epic/SKILL.md#L14-L20).
Ralph's run artifacts are listed in
[`skills/ralph/SKILL.md:17-21`](../skills/ralph/SKILL.md#L17-L21).
The server derives `state.sqlite` in
[`apps/server/src/config.ts:101-106`](../apps/server/src/config.ts#L101-L106).

## Ownership rules

T3 Code reads Beads through `BeadsStatusBroadcaster`. A terminal `bd update`,
`bd close`, or dependency change appears in subscribed clients without a T3
Code refresh. The server-owned runner may launch a worker that runs `bd` and may
add run notes, but T3 Code does not change issue status as part of its read
model.

Terminal mode must work with no T3 Code process running. Use `cook-epic` or an
epic-targeted `ralph` run to own and advance an epic. Later, open the same
repository in T3 Code; it reads the current ready frontier from Beads.

`cook-it` handles one child. It may claim and close that child, but it does not
own the epic run lock and is not an epic mode to switch into or out of.

Only one runner may own an epic. Epic-targeted `ralph`, `cook-epic`, and the T3
Code server runner use the same run-lock file. If the lock is live, the second
runner reports that the run is already in progress instead of claiming another
child. The canonical terminal lock behavior is covered by the regression tests
installed with the `cook-epic` and `ralph` skills; the server integration test
covers the shared file format and exclusive-create behavior.

## Lifecycle

- Closing a browser or mobile client does not stop work. WebSocket cleanup only
  marks the session disconnected
  ([`apps/server/src/ws.ts:2257-2261`](../apps/server/src/ws.ts#L2257-L2261)).
- The server reaps a provider session after 30 minutes of inactivity, but skips
  any session with an active turn
  ([`ProviderSessionReaper.ts:16-17`](../apps/server/src/provider/Layers/ProviderSessionReaper.ts#L16-L17),
  [`ProviderSessionReaper.ts:56-70`](../apps/server/src/provider/Layers/ProviderSessionReaper.ts#L56-L70)).
- A server restart ends the old process and its provider subprocesses; no
  provider session reattaches. T3 Code therefore saves server-owned epic runs
  in SQLite and reconciles them at startup
  ([`serverRuntimeStartup.ts:344-353`](../apps/server/src/serverRuntimeStartup.ts#L344-L353)).

## Switch between modes

Before switching, let the current runner finish or stop it cleanly so it
releases the epic lock. Commit any work in the checkout. Then start the same
epic from the other mode. The new runner reads `bd ready --parent <epic-id>
--json`, so closed children stay closed and newly unblocked children become the
next work.
