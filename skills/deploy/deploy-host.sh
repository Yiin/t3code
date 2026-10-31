#!/usr/bin/env bash
# Deploy origin/upstream-patched (must equal $1) to ~/Projects/t3code-upstream and restart t3code.service.
# Flags: BUILD_ONLY=1 stops after the build. SKIP_BUILD=1 skips install and build.
# SKIP_DB_BACKUP=1 skips the local sqlite backup.
set -eo pipefail
SHA="${1:?deploy sha}"
MISE="$(command -v mise || echo "$HOME/.local/bin/mise")"
NODE_BIN="$HOME/.local/share/mise/installs/node/26.12.1/bin"
PNPM_DIR="$HOME/.local/share/mise/installs/pnpm/12.14.0"
[ -x "$NODE_BIN/node" ] || "$MISE" install node@26.12.1
[ -x "$PNPM_DIR/pnpm" ] || "$MISE" install pnpm@12.14.0
export PATH="$NODE_BIN:$PNPM_DIR:$HOME/.vite-plus/bin:$HOME/.local/bin:$HOME/.bun/bin:$PATH"
node --version; pnpm --version

cd "$HOME/Projects/t3code-upstream"
test "$(git branch --show-current)" = upstream-patched
if [ -n "$(git status --porcelain)" ]; then git status --porcelain; echo "BLOCKED: dirty worktree"; exit 2; fi
git fetch origin upstream-patched
git merge --ff-only FETCH_HEAD
test "$(git rev-parse HEAD)" = "$SHA"
avail_kb="$(df --output=avail -k . | tail -1)"
if [ "$avail_kb" -lt 6000000 ]; then echo "BLOCKED: only ${avail_kb}kB free"; exit 3; fi

if [ "${SKIP_BUILD:-0}" != 1 ]; then
  vp i --frozen-lockfile
  bun run build
fi
test -f apps/server/dist/bin.mjs
test -f apps/web/dist/index.html
if [ "${BUILD_ONLY:-0}" = 1 ]; then echo BUILD-OK; exit 0; fi

ts="$(date +%Y%m%d-%H%M%S)"
db="$HOME/.t3/userdata/statev2.sqlite"
if [ "${SKIP_DB_BACKUP:-0}" != 1 ]; then
  sqlite3 "$db" ".backup '$db.pre-upstream-$ts.bak'"
  echo "db backup: $db.pre-upstream-$ts.bak"
fi

dropins="$HOME/.config/systemd/user/t3code.service.d"
for f in "$dropins"/*.conf; do
  if grep -qE 'mise/installs/node/[0-9.]+/bin' "$f"; then
    cp -f "$f" "$f.bak-$ts"
    sed -i -E 's#mise/installs/node/[0-9.]+/bin#mise/installs/node/26.12.1/bin#g' "$f"
  fi
done
grep -h 'node/26.12.1' "$dropins"/*.conf

systemctl --user daemon-reload
systemctl --user restart t3code.service
for attempt in $(seq 1 60); do
  if curl --fail --silent --show-error http://127.0.0.1:3773/.well-known/t3/environment; then echo; break; fi
  test "$attempt" -lt 60
  sleep 2
done
systemctl --user is-active t3code.service
systemctl --user show t3code.service -p ExecMainStartTimestamp -p MainPID
git rev-parse HEAD
echo DEPLOY-OK
