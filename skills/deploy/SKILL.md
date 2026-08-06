---
name: deploy
description: Commit, push, build, and restart the self-hosted T3 Code checkout on yiin-lt, travel-laptop, and main-laptop. Use when the user says `/deploy`, asks to deploy T3 Code, requests a rebuild and restart, or wants every available T3 Code host synchronized to the same `mine` commit.
---

# Deploy T3 Code

Deploy one reviewed revision to every available T3 Code host. Keep
`~/Projects/t3code` on branch `mine` as the source checkout on each host.

This workflow deploys the local web and server bundles served by
`t3code.service`. Do not deploy the hosted relay, Vercel app, desktop release,
or mobile release unless the user asks for them.

## Safety rules

- Never use `git reset`, force-push, force-checkout, or automatic stashing.
- Never hide or overwrite dirty work on any host.
- Stage only files that belong to the requested change. Do not use `git add .`.
- Treat an available but dirty, ahead, or diverged host as blocked. Continue
  with independent hosts and report the blocked host.
- Treat an unreachable laptop as skipped, not failed.
- Pull only with `--ff-only` on destination hosts.
- Deploy the same pushed commit SHA everywhere.
- Restart the host carrying the current agent session last.

## Hosts

Deploy to these three hosts:

| Host          | SSH alias       | Checkout            |
| ------------- | --------------- | ------------------- |
| VPS           | `yiin-lt`       | `~/Projects/t3code` |
| Travel laptop | `travel-laptop` | `~/Projects/t3code` |
| Main laptop   | `main-laptop`   | `~/Projects/t3code` |

Use `hostname -s` to identify the local host. Do not SSH to the local host.

Check remote availability without prompting:

```bash
ssh -o BatchMode=yes -o ConnectTimeout=5 HOST true
```

Skip a host only for connection failures. A repository or build failure is a
blocked deployment and must remain visible.

## 1. Prepare the source commit

Run from `~/Projects/t3code`.

1. Read `AGENTS.md` and run `bd prime`.
2. Inspect `git status --short --branch`, `git diff`, and `git diff --cached`.
3. Stop if unrelated work prevents a clean deployment commit.
4. Run the focused checks required by `AGENTS.md` for the changed files.
5. Update or close linked Beads issues only when their work is complete.
6. Stage explicit paths and create a Conventional Commit.
7. Confirm the worktree is clean.
8. Rebase on the remote branch without force:

```bash
git pull --rebase origin mine
```

Resolve no ambiguous conflict automatically. Stop and report it.

Push and capture the deployment SHA:

```bash
git push origin mine
deploy_sha="$(git rev-parse HEAD)"
git fetch origin mine
test "$(git rev-parse origin/mine)" = "$deploy_sha"
```

Confirm `origin/mine` resolves to `deploy_sha` before changing another host.

## 2. Update each available destination

Check remote destinations before building the local host. The destination
preflight must confirm all of these facts:

- `~/Projects/t3code/.git` exists.
- The current branch is `mine`.
- `git status --porcelain` is empty.
- The current commit is an ancestor of `origin/mine`.
- `t3code.service` is loaded.

For each clean destination, run this sequence through SSH:

```bash
export PATH="$HOME/.local/bin:$HOME/.vite-plus/bin:$HOME/.local/share/mise/shims:$PATH"
repo="$HOME/Projects/t3code"
cd "$repo"
old_sha="$(git rev-parse HEAD)"
git fetch origin mine
git merge-base --is-ancestor "$old_sha" origin/mine
git pull --ff-only origin mine
test "$(git rev-parse HEAD)" = "DEPLOY_SHA"
vp i --frozen-lockfile
./skills/install.sh
bun run build
systemctl --user restart t3code.service
systemctl --user is-active --quiet t3code.service
for attempt in $(seq 1 15); do
  if curl --fail --silent --show-error \
    http://127.0.0.1:3773/.well-known/t3/environment; then
    break
  fi
  test "$attempt" -lt 15
  sleep 1
done
```

Replace `DEPLOY_SHA` with the pushed SHA. Quote the remote script safely. Do
not interpolate remote `$HOME` or command substitutions in the local shell.

After restart, also record:

```bash
systemctl --user show t3code.service -p ExecMainStartTimestamp -p MainPID
git rev-parse HEAD
```

Run `./skills/install.sh` on every updated host. It repairs missing or stale
links from `~/.agents/skills` to the canonical repository skills.

## 3. Build and restart the local host

Run the same dependency, installer, and build commands locally:

```bash
export PATH="$HOME/.local/bin:$HOME/.vite-plus/bin:$HOME/.local/share/mise/shims:$PATH"
vp i --frozen-lockfile
./skills/install.sh
bun run build
```

If the current session does not use the local T3 Code server, restart normally
and verify it with the same service and HTTP checks.

If the current session uses `t3code.service`, a direct restart will terminate
the session. Make the restart the final tool action. Schedule it through the
user manager so it survives the session shutdown:

```bash
restart_unit="t3code-restart-$(date +%s)"
systemd-run --user --unit="$restart_unit" --on-active=15s \
  /usr/bin/systemctl --user restart t3code.service
```

Report that the local restart is scheduled. On the next user turn, verify
`ExecMainStartTimestamp` and the environment endpoint before claiming success.

## 4. Report the deployment

Lead with the pushed SHA. Report one result for each host:

- deployed and healthy
- skipped because unreachable
- blocked, with the exact dirty files, branch state, or failed command

Report the test and build results. Name any host that did not reach the pushed
SHA. Do not say all hosts are synchronized when one available host is blocked.
