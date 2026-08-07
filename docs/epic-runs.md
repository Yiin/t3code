# Run an epic from a terminal or T3 Code

You can start an epic in a plain terminal and continue it from T3 Code, or do
the reverse. Beads and Git are the shared source of truth. T3 Code observes that
state and launches work; it does not keep a second copy of issue status.

## Shared state

| State                                         | Location                                                                                                    | Owner                                 |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| Issue status, claims, dependencies, and notes | The repository's `.beads` database                                                                          | Workers using `bd`                    |
| Commits and branches                          | Git; parallel workers (legacy terminal engine, server runs) use `epic/<child-id>` branches and worktrees    | Workers and cook-epic                 |
| Loop prompt and reports                       | A Ralph `RUN_DIR` under `/var/tmp`, including `prompt.md`, `mailbox.jsonl`, `summary.md`, and `iter-N.json` | Ralph                                 |
| Epic run lock                                 | `<repo>/.beads/run-lock.<epic-id>.json`                                                                     | The active terminal or T3 Code runner |
| T3 Code run recovery state                    | `epic_runs` rows in `~/.t3/userdata/state.sqlite`                                                           | T3 Code server                        |

The branch and worktree rules live in
[`skills/cook-epic/SKILL.md`](../skills/cook-epic/SKILL.md) under **How it
works** (Isolation and Landing); they describe the legacy terminal engine and
the server runner's parallel loop.
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

## Engine selection

The default engine is `core`. The terminal `run.sh` is a shim that validates
the launch and execs `t3 epic cook`; the hosted runner drives the same shared
core. The deprecated Bash coordinator (`skills/cook-epic/run-legacy.sh`) stays
reachable for one release through `COOKEPIC_CORE=legacy` (or `0`) and prints a
deprecation notice on every start.

Set `engine` in `.t3code/epic-run.json` or in a run input. The default is
`core`. Config layers apply in this order, with the last value winning:

1. Built-in defaults.
2. `.t3code/epic-run.json` from the base checkout.
3. Deprecated environment settings.
4. The run input from the API, UI, or terminal adapter.

`T3CODE_EPIC_RUN_ENGINE` and `COOKEPIC_ENGINE` are migration settings. The
terminal adapter logs a warning when either variable is present. If both are
present, `T3CODE_EPIC_RUN_ENGINE` wins within the environment layer. Replace
both variables with the `engine` config key.

The config reader accepts these rollout values:

- `legacy` runs the existing adapter.
- `core` runs the shared orchestration core.
- `shadow` runs the legacy adapter and records shared-core policy decisions.

Shadow core is observation-only. It consumes each legacy iteration's head,
worktree fingerprint, child status, and classified outcome. It does not start
agents, write Beads, change Git, run gates, or push.

The selector is persisted on the run for provenance and rollout auditing.
Entry points choose the adapter themselves: `run.sh` and `t3 epic cook` run
the shared core, the hosted runner runs the same core, and
`COOKEPIC_CORE=legacy` selects the legacy terminal coordinator for one more
release.

Config is strict. An unknown engine value rejects the launch like any other
invalid config value. It does not silently select a different engine.

## Compare adapters

Run a real comparison only on a clean throwaway branch with a local embedded
Beads database:

```bash
node scripts/epic-shadow-compare.ts \
  --epic <id> \
  --cwd <repo> \
  --adapters terminal,core \
  --mode run
```

Run mode copies one exact Git and Beads snapshot into two temporary roots. It
runs each adapter once, disables pushes, and deletes only those temporary roots.
It refuses default branches, dirty trees, shared Dolt hosts, external Beads
databases, linked Git worktrees, and sibling repository layouts.

Shadow mode reads paired normalized transcripts without starting an adapter:

```bash
node scripts/epic-shadow-compare.ts \
  --epic <id> \
  --cwd <repo> \
  --adapters terminal,core \
  --mode shadow
```

The default files are
`.git/t3code/epic-shadow/<id>/terminal.jsonl` and `core.jsonl`. Use
`--transcript-dir <dir>` to read a copied artifact directory. A different event
sequence is structural drift and makes the command fail. Changes only to
`summary` or `why` are content drift and do not fail the command.

Only one runner may own an epic. Epic-targeted `ralph`, `cook-epic`, and the T3
Code server runner use the same run-lock file. If the lock is live, the second
runner reports that the run is already in progress instead of claiming another
child. `NodeEpicRunLock` in `packages/epic-core` is the shared implementation
for the terminal core and the hosted runner; the legacy Bash coordinator and
ralph keep their own holders on the same file. The `run-lock.sh` suite covers
the legacy holder, and the `NodeEpicRunLock` interop test covers the shared
file format and exclusive-create behavior across implementations.

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
