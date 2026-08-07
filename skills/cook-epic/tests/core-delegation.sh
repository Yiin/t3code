#!/usr/bin/env bash
set -euo pipefail

export PATH="$HOME/.local/bin:$HOME/.vite-plus/bin:$PATH"
SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
RUNNER="$SKILL_DIR/run.sh"
REPO_ROOT="$(cd "$SKILL_DIR/../.." && pwd -P)"
NODE_BIN="$(command -v node || true)"
[ -n "$NODE_BIN" ] || NODE_BIN="$HOME/.vite-plus/bin/node"
[ -x "$NODE_BIN" ] || { printf 'FAIL: node binary not found\n' >&2; exit 1; }
BASH_BIN="$(command -v bash)"
TMP_ROOT="$(mktemp -d)"
trap '[ "${COOKEPIC_KEEP_TEST_TMP:-0}" = 1 ] || rm -rf "$TMP_ROOT"' EXIT

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
assert_contains() { grep -Fq -- "$2" "$1" || fail "expected $1 to contain: $2"; }
assert_not_exists() { [ ! -e "$1" ] || fail "expected $1 not to exist"; }
assert_first_line() {
  [ "$(head -n 1 "$1")" = "$2" ] || fail "expected $1 to start with: $2"
}

make_minimal_path() {
  local path_bin="$1"
  mkdir -p "$path_bin"
  ln -s "$BASH_BIN" "$path_bin/bash"
  ln -s "$(command -v dirname)" "$path_bin/dirname"
  ln -s "$(command -v mkdir)" "$path_bin/mkdir"
  ln -s "$NODE_BIN" "$path_bin/node"
}

make_runner_checkout() {
  local checkout="$1"
  mkdir -p "$checkout/skills/cook-epic"
  cp "$RUNNER" "$checkout/skills/cook-epic/run.sh"
  chmod +x "$checkout/skills/cook-epic/run.sh"
}

make_capture_binary() {
  local file="$1" marker="$2"
  cat > "$file" <<EOF
#!/usr/bin/env bash
printf '%s\n' '$marker' > "\${CAPTURE:?}"
printf 'harness=%s\n' "\${COOKEPIC_HARNESS:-}" >> "\$CAPTURE"
printf '%s\n' "\$@" >> "\$CAPTURE"
EOF
  chmod +x "$file"
}

run_core_shim() {
  local runner="$1" run_dir="$2" output="$3" path_bin="$4"
  shift 4
  set +e
  env PATH="$path_bin" COOKEPIC_EPIC=epic COOKEPIC_HARNESS=codex "$@" \
    "$BASH_BIN" "$runner" "$run_dir" > "$output" 2>&1
  local rc=$?
  set -e
  return "$rc"
}

resolution_root="$TMP_ROOT/resolution"
checkout="$resolution_root/checkout"
path_bin="$resolution_root/path"
mkdir -p "$resolution_root"
make_runner_checkout "$checkout"
make_minimal_path "$path_bin"

explicit="$resolution_root/explicit-t3"
path_t3="$path_bin/t3"
capture="$resolution_root/explicit.args"
make_capture_binary "$explicit" explicit
make_capture_binary "$path_t3" path
mkdir -p "$checkout/apps/server/dist"
cat > "$checkout/apps/server/dist/bin.mjs" <<'EOF'
import { writeFileSync } from "node:fs";
writeFileSync(process.env.CAPTURE, `dist\n${process.argv.slice(2).join("\n")}\n`);
EOF
CAPTURE="$capture" run_core_shim "$checkout/skills/cook-epic/run.sh" \
  "$resolution_root/explicit-run" "$resolution_root/explicit.out" "$path_bin" \
  COOKEPIC_T3_BIN="$explicit" || fail 'COOKEPIC_T3_BIN entrypoint failed'
assert_first_line "$capture" explicit
assert_contains "$capture" 'epic'
assert_contains "$capture" 'cook'
assert_contains "$capture" '--run-dir'

capture="$resolution_root/path.args"
CAPTURE="$capture" run_core_shim "$checkout/skills/cook-epic/run.sh" \
  "$resolution_root/path-run" "$resolution_root/path.out" "$path_bin" \
  || fail 'PATH t3 entrypoint failed'
assert_first_line "$capture" path

capture="$resolution_root/auto.args"
CAPTURE="$capture" run_core_shim "$checkout/skills/cook-epic/run.sh" \
  "$resolution_root/auto-run" "$resolution_root/auto.out" "$path_bin" \
  COOKEPIC_HARNESS=auto CODEX_THREAD_ID= CLAUDECODE=1 \
  || fail 'auto harness entrypoint failed'
assert_contains "$capture" 'harness=claude'

rm "$path_t3"
mkdir -p "$checkout/apps/server/src"
cat > "$checkout/apps/server/src/bin.ts" <<'EOF'
import { writeFileSync } from "node:fs";
writeFileSync(process.env.CAPTURE, `source\n${process.argv.slice(2).join("\n")}\n`);
EOF
capture="$resolution_root/dist.args"
CAPTURE="$capture" run_core_shim "$checkout/skills/cook-epic/run.sh" \
  "$resolution_root/dist-run" "$resolution_root/dist.out" "$path_bin" \
  || fail 'dist entrypoint failed'
assert_first_line "$capture" dist

rm "$checkout/apps/server/dist/bin.mjs"
capture="$resolution_root/source.args"
CAPTURE="$capture" run_core_shim "$checkout/skills/cook-epic/run.sh" \
  "$resolution_root/source-run" "$resolution_root/source.out" "$path_bin" \
  || fail 'source entrypoint failed'
assert_first_line "$capture" source

rm "$checkout/apps/server/src/bin.ts"
if run_core_shim "$checkout/skills/cook-epic/run.sh" "$resolution_root/missing-run" \
  "$resolution_root/missing.out" "$path_bin"; then
  fail 'missing t3 entrypoint exited successfully'
fi
assert_contains "$resolution_root/missing.out" 'COOKEPIC_T3_BIN'
assert_contains "$resolution_root/missing.out" 't3 on PATH'
assert_contains "$resolution_root/missing.out" 'apps/server/dist/bin.mjs'
assert_contains "$resolution_root/missing.out" 'apps/server/src/bin.ts'

unsupported_marker="$resolution_root/unsupported-called"
make_capture_binary "$explicit" unsupported
if CAPTURE="$unsupported_marker" run_core_shim "$checkout/skills/cook-epic/run.sh" \
  "$resolution_root/unsupported-run" "$resolution_root/unsupported.out" "$path_bin" \
  COOKEPIC_T3_BIN="$explicit" COOKEPIC_WORKERS=2; then
  fail 'unsupported core knob exited successfully'
fi
assert_contains "$resolution_root/unsupported.out" 'COOKEPIC_WORKERS is not supported'
assert_not_exists "$unsupported_marker"

empty_marker="$resolution_root/empty-unsupported.args"
make_capture_binary "$explicit" empty-unsupported
CAPTURE="$empty_marker" run_core_shim "$checkout/skills/cook-epic/run.sh" \
  "$resolution_root/empty-unsupported-run" "$resolution_root/empty-unsupported.out" \
  "$path_bin" COOKEPIC_T3_BIN="$explicit" COOKEPIC_WORKERS= \
  || fail 'empty unsupported knob did not act as unset'
assert_first_line "$empty_marker" empty-unsupported

make_fixture() {
  local root="$1" repo fake_home
  repo="$root/repo"
  fake_home="$root/home"
  mkdir -p "$repo" "$fake_home"
  git init -q -b mine "$repo"
  git -C "$repo" config user.name test
  git -C "$repo" config user.email test@example.com
  printf 'base\n' > "$repo/work.txt"
  git -C "$repo" add work.txt
  git -C "$repo" commit -qm base
  (cd "$repo" && env -u BEADS_DIR -u BEADS_DOLT_SERVER_HOST HOME="$fake_home" \
    XDG_CONFIG_HOME="$root/config" bd init --non-interactive --stealth \
    --skip-agents --skip-hooks -p fixture >/dev/null)
  local epic
  epic=$(cd "$repo" && env -u BEADS_DIR -u BEADS_DOLT_SERVER_HOST HOME="$fake_home" \
    XDG_CONFIG_HOME="$root/config" bd create Epic --type epic --silent \
    -d 'Goal: compare terminal adapters')
  (cd "$repo" && env -u BEADS_DIR -u BEADS_DOLT_SERVER_HOST HOME="$fake_home" \
    XDG_CONFIG_HOME="$root/config" bd create Child --type task --parent "$epic" \
    --silent >/dev/null)
  printf '%s\n' "$epic" > "$root/epic-id"
  cat > "$root/worker.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
child="${COOKEPIC_CHILD:-}"
if [ -z "$child" ]; then
  child=$(sed -n 's/^ASSIGNED_CHILD_ID=//p' "${1:?prompt path}")
fi
printf '%s\n' "$child" >> work.txt
git add work.txt
git commit -qm "cook $child"
bd close "$child" --reason 'worker completed' >/dev/null
printf 'RALPH_MSG: {"summary":"completed %s","why":"adapter parity"}\n' "$child"
EOF
  chmod +x "$root/worker.sh"
}

run_fixture() {
  local root="$1" repo epic run_dir
  repo="$root/repo"
  epic="$(<"$root/epic-id")"
  run_dir="$root/run"
  set +e
  (
    cd "$repo"
    env -u BEADS_DIR -u BEADS_DOLT_SERVER_HOST HOME="$root/home" \
      XDG_CONFIG_HOME="$root/config" COOKEPIC_EPIC="$epic" \
      COOKEPIC_T3_BIN="$TMP_ROOT/t3-source" COOKEPIC_HARNESS=worker-cmd \
      COOKEPIC_WORKER_CMD="$root/worker.sh" COOKEPIC_SEQUENTIAL=1 \
      COOKEPIC_NO_GATE=1 COOKEPIC_NO_PUSH=1 COOKEPIC_MAX_DISPATCHES=1 \
      COOKEPIC_MAX_ATTEMPTS=1 COOKEPIC_WORKER_TIMEOUT=30 \
      "$RUNNER" "$run_dir"
  ) > "$root/stdout" 2>&1
  local rc=$?
  set -e
  [ "$rc" -eq 0 ] || {
    sed -n '1,160p' "$root/stdout" >&2
    fail "core fixture exited $rc"
  }
  (cd "$repo" && env -u BEADS_DIR -u BEADS_DOLT_SERVER_HOST HOME="$root/home" \
    XDG_CONFIG_HOME="$root/config" bd list --parent "$epic" --all --flat --json) \
    | jq -S '[.[] | {status,title}] | sort_by(.title)' > "$root/final-state.json"
}

cat > "$TMP_ROOT/t3-source" <<EOF
#!/usr/bin/env bash
exec "$NODE_BIN" "$REPO_ROOT/apps/server/src/bin.ts" "\$@"
EOF
chmod +x "$TMP_ROOT/t3-source"

core_root="$TMP_ROOT/core"
make_fixture "$core_root"
run_fixture "$core_root"
assert_contains "$core_root/final-state.json" '"status": "closed"'
jq -e '.status == "done"' "$core_root/run/run.json" >/dev/null \
  || fail 'shared core did not record a done run'

echo 'core delegation tests passed'
