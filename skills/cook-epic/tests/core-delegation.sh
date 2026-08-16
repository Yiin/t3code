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
# Cleanup must never decide the run's exit status. Under `set -e` a failing
# EXIT trap becomes the script's status, and `rm -rf` loses a race with any
# detached worker still writing into TMP_ROOT ("Directory not empty") — which
# turned a fully passing run into a FAIL on a loaded machine. Retry once, then
# leave the directory and say so.
cleanup() {
  if [ "${COOKEPIC_KEEP_TEST_TMP:-0}" = 1 ]; then
    return 0
  fi
  if rm -rf "$TMP_ROOT" 2>/dev/null; then
    return 0
  fi
  sleep 1
  rm -rf "$TMP_ROOT" 2>/dev/null ||
    printf 'warning: left %s behind (a worker was still writing)\n' "$TMP_ROOT" >&2
  return 0
}
trap cleanup EXIT

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

capture="$resolution_root/prime-explicit.args"
CAPTURE="$capture" run_core_shim "$checkout/skills/cook-epic/run.sh" \
  "$resolution_root/prime-explicit-run" "$resolution_root/prime-explicit.out" "$path_bin" \
  COOKEPIC_HARNESS=prime COOKEPIC_T3_BIN="$explicit" \
  || fail 'explicit Prime harness entrypoint failed'
assert_contains "$capture" 'harness=prime'

prime_parent="$resolution_root/prime-agent-test"
cp "$BASH_BIN" "$prime_parent"
ln -s "$(command -v ps)" "$path_bin/ps"
capture="$resolution_root/prime-ancestor.args"
set +e
env PATH="$path_bin" CAPTURE="$capture" COOKEPIC_EPIC=epic COOKEPIC_HARNESS=auto \
  COOKEPIC_T3_BIN="$explicit" "$prime_parent" -c '"$1" "$2" "$3"; rc=$?; true; exit "$rc"' \
  prime-parent "$BASH_BIN" "$checkout/skills/cook-epic/run.sh" \
  "$resolution_root/prime-ancestor-run" > "$resolution_root/prime-ancestor.out" 2>&1
rc=$?
set -e
[ "$rc" -eq 0 ] || fail 'Prime ancestor detection failed'
assert_contains "$capture" 'harness=prime'

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
  COOKEPIC_T3_BIN="$explicit" COOKEPIC_BUDGET_USD=10; then
  fail 'unsupported core knob exited successfully'
fi
assert_contains "$resolution_root/unsupported.out" 'COOKEPIC_BUDGET_USD is not supported'
assert_not_exists "$unsupported_marker"

empty_marker="$resolution_root/empty-unsupported.args"
make_capture_binary "$explicit" empty-unsupported
CAPTURE="$empty_marker" run_core_shim "$checkout/skills/cook-epic/run.sh" \
  "$resolution_root/empty-unsupported-run" "$resolution_root/empty-unsupported.out" \
  "$path_bin" COOKEPIC_T3_BIN="$explicit" COOKEPIC_WORKERS= \
  || fail 'empty unsupported knob did not act as unset'
assert_first_line "$empty_marker" empty-unsupported

workers_marker="$resolution_root/workers.args"
make_capture_binary "$explicit" workers
CAPTURE="$workers_marker" run_core_shim "$checkout/skills/cook-epic/run.sh" \
  "$resolution_root/workers-run" "$resolution_root/workers.out" "$path_bin" \
  COOKEPIC_T3_BIN="$explicit" COOKEPIC_WORKERS=2 COOKEPIC_SIBLINGS='/tmp/a /tmp/b' \
  || fail 'supported parallel knobs failed validation'
assert_first_line "$workers_marker" workers

if run_core_shim "$checkout/skills/cook-epic/run.sh" "$resolution_root/bad-workers-run" \
  "$resolution_root/bad-workers.out" "$path_bin" \
  COOKEPIC_T3_BIN="$explicit" COOKEPIC_WORKERS=abc; then
  fail 'invalid COOKEPIC_WORKERS exited successfully'
fi
assert_contains "$resolution_root/bad-workers.out" 'COOKEPIC_WORKERS must be a positive integer'

if run_core_shim "$checkout/skills/cook-epic/run.sh" "$resolution_root/contradiction-run" \
  "$resolution_root/contradiction.out" "$path_bin" \
  COOKEPIC_T3_BIN="$explicit" COOKEPIC_WORKERS=2 COOKEPIC_SEQUENTIAL=1; then
  fail 'contradictory execution knobs exited successfully'
fi
assert_contains "$resolution_root/contradiction.out" 'COOKEPIC_SEQUENTIAL=1 contradicts COOKEPIC_WORKERS>1'

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
if [ -z "$child" ]; then
  # The pool prompt carries the child inline instead of the marker.
  child=$(awk '/^Cook exactly / { gsub(/`/, ""); print $3 }' "${1:?prompt path}")
fi
[ -n "$child" ] || { echo 'no child in prompt' >&2; exit 1; }
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
  shift
  repo="$root/repo"
  epic="$(<"$root/epic-id")"
  run_dir="$root/run"
  set +e
  (
    cd "$repo"
    env -u BEADS_DIR -u BEADS_DOLT_SERVER_HOST HOME="$root/home" \
      XDG_CONFIG_HOME="$root/config" T3CODE_HOME="$root/home/.t3" \
      COOKEPIC_EPIC="$epic" \
      COOKEPIC_T3_BIN="$TMP_ROOT/t3-source" COOKEPIC_HARNESS=worker-cmd \
      COOKEPIC_WORKER_CMD="$root/worker.sh" \
      COOKEPIC_NO_GATE=1 COOKEPIC_NO_PUSH=1 COOKEPIC_MAX_DISPATCHES=1 \
      COOKEPIC_MAX_ATTEMPTS=1 COOKEPIC_WORKER_TIMEOUT=30 "$@" \
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

make_prime_fallback_binaries() {
  local root="$1"
  mkdir -p "$root/bin"
  cat > "$root/prime.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'prime\n' >> "${PROVIDER_TRACE:?}"
printf '%s\n' '{"type":"auto_retry_end","success":false,"attempt":3,"finalError":"rate limit exceeded"}'
EOF
  chmod +x "$root/prime.sh"
  cat > "$root/bin/claude" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'claude\n' >> "${PROVIDER_TRACE:?}"
printf '%s\n' "$@" > "${CLAUDE_ARGS:?}"
prompt="${!#}"
child=$(sed -n 's/^ASSIGNED_CHILD_ID=//p' <<< "$prompt")
if [ -z "$child" ]; then
  child=$(awk '/^Cook exactly / { gsub(/`/, ""); print $3 }' <<< "$prompt")
fi
[ -n "$child" ] || { printf 'no child in prompt\n' >&2; exit 1; }
printf '%s\n' "$child" >> work.txt
git add work.txt
git commit -qm "cook $child"
bd close "$child" --reason 'fallback worker completed' >/dev/null
printf '%s\n' '{"type":"result","result":"RALPH_MSG: {\"summary\":\"fallback completed\",\"why\":\"Prime failed\"}","session_id":"fallback-session"}'
EOF
  chmod +x "$root/bin/claude"
}

run_prime_fallback_fixture() {
  local root="$1" repo epic run_dir
  shift
  repo="$root/repo"
  epic="$(<"$root/epic-id")"
  run_dir="$root/run"
  set +e
  (
    cd "$repo"
    env -u BEADS_DIR -u BEADS_DOLT_SERVER_HOST HOME="$root/home" \
      XDG_CONFIG_HOME="$root/config" T3CODE_HOME="$root/home/.t3" \
      PATH="$root/bin:$PATH" COOKEPIC_EPIC="$epic" \
      COOKEPIC_T3_BIN="$TMP_ROOT/t3-source" COOKEPIC_HARNESS=prime \
      COOKEPIC_BIN="$root/prime.sh" COOKEPIC_MODEL=prime/custom-model \
      COOKEPIC_NO_GATE=1 COOKEPIC_NO_PUSH=1 COOKEPIC_MAX_DISPATCHES=2 \
      COOKEPIC_MAX_ATTEMPTS=1 COOKEPIC_WORKER_TIMEOUT=30 \
      PROVIDER_TRACE="$root/provider.trace" CLAUDE_ARGS="$root/claude.args" "$@" \
      "$RUNNER" "$run_dir"
  ) > "$root/stdout" 2>&1
  local rc=$?
  set -e
  [ "$rc" -eq 0 ] || {
    sed -n '1,160p' "$root/stdout" >&2
    fail "Prime fallback fixture exited $rc"
  }
  [ "$(grep -c '^prime$' "$root/provider.trace")" = 1 ] \
    || fail 'Prime fallback fixture did not run Prime exactly once'
  [ "$(grep -c '^claude$' "$root/provider.trace")" = 1 ] \
    || fail 'Prime fallback fixture did not run Claude exactly once'
  assert_contains "$root/claude.args" 'claude-sonnet-5'
  if grep -Fq 'prime/custom-model' "$root/claude.args"; then
    fail 'Claude fallback inherited the Prime model'
  fi
  [ "$(grep -c '"type":"provider-fallback"' "$run_dir/mailbox.jsonl")" = 1 ] \
    || fail 'Prime fallback fixture did not publish exactly one fallback event'
  jq -e '.status == "done" and .modelSelection.instanceId == "claude"' \
    "$run_dir/run.json" >/dev/null || fail 'Prime fallback fixture did not finish on Claude'
}

cat > "$TMP_ROOT/t3-source" <<EOF
#!/usr/bin/env bash
exec "$NODE_BIN" "$REPO_ROOT/apps/server/src/bin.ts" "\$@"
EOF
chmod +x "$TMP_ROOT/t3-source"

core_root="$TMP_ROOT/core"
make_fixture "$core_root"
run_fixture "$core_root" COOKEPIC_SEQUENTIAL=1
assert_contains "$core_root/final-state.json" '"status": "closed"'
jq -e '.status == "done"' "$core_root/run/run.json" >/dev/null \
  || fail 'shared core did not record a done run'

parallel_root="$TMP_ROOT/parallel"
make_fixture "$parallel_root"
# Mode is pinned: this section proves the worktree + merge-queue landing path,
# which auto would skip for a lone ready child by running it in place.
run_fixture "$parallel_root" COOKEPIC_WORKERS=2 COOKEPIC_MODE=parallel
assert_contains "$parallel_root/final-state.json" '"status": "closed"'
jq -e '.status == "done" and .config.parallel.workers == 2' \
  "$parallel_root/run/run.json" >/dev/null \
  || fail 'parallel cook did not record a done run with two workers'
# The child commit landed on the base branch through the merge queue, and the
# integration state is released. One landed child is three commits: the base,
# the child's, and the queue's merge commit.
[ "$(git -C "$parallel_root/repo" rev-list --count HEAD)" = 3 ] \
  || fail 'parallel cook did not land the child commit on the base branch'
assert_not_exists "$parallel_root/run/merge-queue.json"
assert_not_exists "$parallel_root/run/worktrees"
if [ -n "$(git -C "$parallel_root/repo" branch --list 'cook-epic-integration-*')" ]; then
  fail 'parallel cook left its integration branch behind'
fi

# No shape knob at all: the default is execution.mode auto with the shared
# three-worker cap, and auto runs a lone ready child in place — a direct
# commit on the base checkout, no worktree and no merge queue. Two commits:
# the base and the child's own.
default_root="$TMP_ROOT/default-shape"
make_fixture "$default_root"
run_fixture "$default_root"
assert_contains "$default_root/final-state.json" '"status": "closed"'
jq -e '.status == "done" and .config.parallel.workers == 3
  and .configProvenance["parallel.workers"] == "default"' \
  "$default_root/run/run.json" >/dev/null \
  || fail 'the default shape did not record a done three-worker pool run'
[ "$(git -C "$default_root/repo" rev-list --count HEAD)" = 2 ] \
  || fail 'the default auto shape did not commit the lone child in place on the base branch'
assert_not_exists "$default_root/run/merge-queue.json"
assert_not_exists "$default_root/run/worktrees"

prime_sequential_root="$TMP_ROOT/prime-sequential"
make_fixture "$prime_sequential_root"
make_prime_fallback_binaries "$prime_sequential_root"
run_prime_fallback_fixture "$prime_sequential_root" COOKEPIC_SEQUENTIAL=1

prime_parallel_root="$TMP_ROOT/prime-parallel"
make_fixture "$prime_parallel_root"
make_prime_fallback_binaries "$prime_parallel_root"
run_prime_fallback_fixture "$prime_parallel_root" COOKEPIC_WORKERS=2

echo 'core delegation tests passed'
