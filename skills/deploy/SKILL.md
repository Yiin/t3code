---
name: deploy
disable-model-invocation: true
description: "Merge upstream T3 Code into branch upstream-patched and deploy it to yiin-lt, main-laptop, main-pc and travel-laptop. Use when the user types /deploy."
---

# Deploy T3 Code

Every host runs branch `upstream-patched` from the worktree
`~/Projects/t3code-upstream`. That branch is upstream `pingdotgg/t3code` plus
our patches. `~/Projects/t3code` (branch `mine`) is the old fork. No host runs
it any more.

`t3code.service` starts the server through the drop-in
`~/.config/systemd/user/t3code.service.d/upstream.conf`. yiin-lt also has
`open-access.conf`, `override.conf` and `resilience.conf`, and
`t3code-keepalive.service` restarts t3code when it stops. The database is
`~/.t3/userdata/statev2.sqlite`.

Do not deploy the hosted relay, Vercel app, desktop release or mobile release
unless the user asks.

## Safety rules

- Never use `git reset`, a force-push, a force-checkout or automatic stashing.
- Update `upstream-patched` only by merge, never by rebase, so every host can
  fast-forward.
- Never hide or overwrite dirty work on a host. A dirty or diverged host is
  blocked. Continue with the other hosts and report it.
- An unreachable host is skipped, not failed.
- Deploy the same pushed SHA everywhere.
- Back up the database before a deploy that runs migrations.

## Hosts

| Host          | Notes                                                                |
| ------------- | -------------------------------------------------------------------- |
| main-laptop   | Deploy first. It is the test host.                                   |
| main-pc       | 570 GB free. Use it for big backups.                                 |
| yiin-lt       | Serves code.yiin.lt. Disk is about 98% full. Database is over 20 GB. |
| travel-laptop | Deploy last if this session runs inside its t3code.service.          |

Run `hostname -s` and do not SSH to the local host. Check a remote host with
`ssh -o BatchMode=yes -o ConnectTimeout=5 HOST true`.

## 1. Merge upstream

Do the merge in a scratch worktree, not in a live one:

```bash
cd ~/Projects/t3code
git fetch origin upstream-patched
git fetch upstream main
git worktree add -b upstream-patched-next "$SCRATCH/t3-merge" origin/upstream-patched
cd "$SCRATCH/t3-merge"
git -c merge.renameLimit=20000 merge --no-ff upstream/main
```

Upstream moves fast (3000+ commits in 3 weeks), so expect conflicts in the
patched files. For each patch, drop it if upstream now does the same thing.
Keep or adapt it otherwise. Our patches:

- open access mode (`T3CODE_OPEN_ACCESS=1`). yiin-lt needs it.
- turn watchdog for a silent provider
- resume a thread when the provider process dies mid-turn
- Claude account sign-in with separate account directories, and shared skills
  and settings for them. The external `claude-accounts` tool reads those homes
  from `~/.t3/userdata/settings.json`, so keep that path layout.
- send a message while background work runs
- "Resume now on <account>" for a usage-limited thread
- this skill (`skills/deploy`)

Check the runtime pins in `package.json` (`engines.node`, `packageManager`).
`deploy-host.sh` pins Node and pnpm. Update it when upstream changes them.

Verify before you push:

```bash
vp i --frozen-lockfile
vp run check:changed upstream/main
bun run build
```

Smoke-test the build on a spare port with a copy of `~/.t3/userdata`, never
the real one. Confirm `/.well-known/t3/environment` answers and reports the
new `databaseMigration`. Check that our patches add no migrations that
collide with upstream ids.

Push the branch, then fast-forward `upstream-patched`:

```bash
git push origin upstream-patched-next
git push origin upstream-patched-next:upstream-patched
```

## 2. Deploy each host

`deploy-host.sh` takes the deploy SHA. It installs the pinned Node and pnpm
with mise, fast-forwards the worktree, stops when less than 6 GB is free,
installs, builds, backs up the database with `sqlite3 .backup`, points the
drop-ins at the pinned Node, restarts the service and waits for the
environment endpoint.

```bash
ssh -o BatchMode=yes HOST 'bash -s SHA' < skills/deploy/deploy-host.sh
```

Run it locally with `bash skills/deploy/deploy-host.sh SHA`.

Flags: `BUILD_ONLY=1` stops after the build. `SKIP_BUILD=1` skips install and
build. `SKIP_DB_BACKUP=1` skips the
local backup.

Do not pipe the run through `tail` or another filter. Read the log after it
ends. A healthy run ends with `DEPLOY-OK`. One `503` from curl while the server
starts is normal. The old process exits with status 130 on stop, so systemd
logs one "Failed" line on every restart. That line is harmless.

### yiin-lt

The database does not fit a local backup on yiin-lt. A local backup once
filled the disk to 100%. Do this instead:

1. Build while the old server runs: `BUILD_ONLY=1` with `deploy-host.sh`.
2. `systemctl --user stop t3code-keepalive.service t3code.service`
3. `sqlite3 ~/.t3/userdata/statev2.sqlite 'PRAGMA wal_checkpoint(TRUNCATE);'`
4. From main-pc:
   `rsync -a --compress --compress-choice=zstd yiin-lt:.t3/userdata/statev2.sqlite ~/backups/t3code-yiin-lt/`
   This takes about 3 minutes for 22 GB.
5. Run `deploy-host.sh` with `SKIP_BUILD=1 SKIP_DB_BACKUP=1`.
6. `systemctl --user start t3code-keepalive.service`
7. Check `https://code.yiin.lt/` and the boot log after the last
   `Migrations ran successfully` line.

The build on yiin-lt needs `pkg-config` and `libsecret-1-dev`. They are
installed.

Between a build and a restart, the worktree holds new code while the old
process still runs. If the old process dies, the keepalive starts the new code
with the old drop-in. Keep that window short.

### Local host

If this session runs inside the local `t3code.service`, a restart kills the
session and every process it started. Move work that must survive into its own
unit with `systemd-run --user`. Schedule the restart as the last action:

```bash
systemd-run --user --unit="t3code-restart-$(date +%s)" --on-active=15s \
  /usr/bin/systemctl --user restart t3code.service
```

Verify it on the next turn.

## 3. Clean up

After every host is healthy, delete the database backups
(`~/.t3/userdata/statev2.sqlite.pre-upstream-*.bak`, and the yiin-lt copy on
main-pc) and the `*.conf.bak-*` drop-in copies. Remove the scratch worktree
and the `upstream-patched-next` branch.

## 4. Report

Lead with the deployed SHA. Give one line per host: deployed and healthy,
skipped as unreachable, or blocked with the exact cause. Give the check, test
and build results, and the migration number.
