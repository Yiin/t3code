#!/usr/bin/env bash
# Shared prompt-cache prefix for claude/ccx workers (yiin-n7j.5): the warm-up
# request before the main loop uses the same --exclude-dynamic-system-prompt-
# sections flag and model as workers, exports ENABLE_PROMPT_CACHING_1H unless
# the caller already set it, never fails the run, and never fires for a
# harness other than claude/ccx (the COOKEPIC_WORKER_CMD test hook forces
# HARNESS=worker-cmd, which every other test in this directory relies on to
# bypass claude entirely).
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNNER="$SKILL_DIR/run.sh"
TMP_ROOT="$(mktemp -d)"
trap '[ "${COOKEPIC_KEEP_TEST_TMP:-0}" = 1 ] || rm -rf "$TMP_ROOT"' EXIT

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
assert_contains() { grep -Fq -- "$2" "$1" || fail "expected $1 to contain: $2"; }
assert_not_contains() { ! grep -Fq -- "$2" "$1" || fail "expected $1 not to contain: $2"; }

make_repo() {
  local repo="$1"
  mkdir -p "$repo/.beads"
  git init -q -b main "$repo"
  git -C "$repo" config user.name test
  git -C "$repo" config user.email test@example.com
  printf 'base\n' > "$repo/base.txt"
  git -C "$repo" add .
  git -C "$repo" commit -qm base
}

# The epic's one child starts (and stays) closed, so open_children_count is 0
# on the very first tick and the run closes the epic without ever dispatching
# a worker. That isolates the warm-up call, which runs before the loop.
make_bd() {
  local bin="$1"
  mkdir -p "$bin"
  cat > "$bin/bd" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
cmd="$1"; shift || true
case "$cmd" in
  show)
    id="$1"
    if [ "$id" = epic ]; then
      printf '{"id":"epic","status":"open","title":"Epic","issue_type":"epic","assignee":"","comment_count":0,"description":"test epic"}\n'
    else
      printf '{"id":"%s","status":"closed","title":"Child","issue_type":"task","assignee":"","comment_count":0}\n' "$id"
    fi
    ;;
  list) printf '[{"id":"child","status":"closed"}]\n' ;;
  ready) printf '[]\n' ;;
  close|note|merge-slot|swarm|update) ;;
esac
EOF
  chmod +x "$bin/bd"
}

# Fake `claude`: records every invocation's argv and its
# ENABLE_PROMPT_CACHING_1H so the test can assert both without a real call.
# Fails (exit 1) when $WARMUP_FAIL_MARKER exists, to exercise the warm-up
# failure path.
make_fake_claude() {
  local path="$1"
  cat > "$path" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
{ printf '%s\n' "$*"; printf 'ENABLE_PROMPT_CACHING_1H=%s\n' "${ENABLE_PROMPT_CACHING_1H:-<unset>}"; printf -- '---\n'; } >> "$CALLS_LOG"
if [ -n "${WARMUP_FAIL_MARKER:-}" ] && [ -f "$WARMUP_FAIL_MARKER" ]; then
  exit 1
fi
printf '{"session_id":"test-session","total_cost_usd":0.0}\n'
EOF
  chmod +x "$path"
}

run_case() { # <name> <warmup-fails: 0|1>
  local name="$1" warmup_fails="$2"
  local root="$TMP_ROOT/$name" repo="$TMP_ROOT/$name/repo" bin="$TMP_ROOT/$name/bin"
  local run="$TMP_ROOT/$name/run" calls="$TMP_ROOT/$name/calls.log" marker="$TMP_ROOT/$name/fail-marker"
  mkdir -p "$run"
  make_repo "$repo"
  make_bd "$bin"
  make_fake_claude "$bin/claude"
  [ "$warmup_fails" = 1 ] && : > "$marker"
  (
    cd "$repo" && exec env -i PATH="$bin:$PATH" HOME="$HOME" XDG_RUNTIME_DIR="$XDG_RUNTIME_DIR" DBUS_SESSION_BUS_ADDRESS="$DBUS_SESSION_BUS_ADDRESS" \
      CALLS_LOG="$calls" WARMUP_FAIL_MARKER="$marker" \
      COOKEPIC_EPIC=epic COOKEPIC_HARNESS=claude COOKEPIC_BIN="$bin/claude" \
      COOKEPIC_MODEL=test-model COOKEPIC_PERMISSION_MODE=bypassPermissions \
      COOKEPIC_SEQUENTIAL=1 COOKEPIC_GATE=true COOKEPIC_NO_PUSH=1 \
      COOKEPIC_SPAWN_DELAY=0 COOKEPIC_WORKER_TIMEOUT=30 "$RUNNER" "$run"
  ) >"$root.stdout" 2>&1 || fail "$name: run.sh exited nonzero — see $root.stdout"

  [ -f "$calls" ] || fail "$name: fake claude was never invoked (no warm-up call happened)"
  local warmup_call
  warmup_call="$(grep -B2 -- '^---$' "$calls" | grep -F 'Reply with exactly: ok' || true)"
  [ -n "$warmup_call" ] || fail "$name: no call carried the warm-up prompt"
  grep -qF -- '--exclude-dynamic-system-prompt-sections' <<< "$warmup_call" \
    || fail "$name: warm-up call missing --exclude-dynamic-system-prompt-sections"
  grep -qF -- '--model test-model' <<< "$warmup_call" \
    || fail "$name: warm-up call did not use COOKEPIC_MODEL"
  assert_contains "$calls" 'ENABLE_PROMPT_CACHING_1H=1'

  if [ "$warmup_fails" = 1 ]; then
    assert_contains "$run/loop.log" 'WARNING: cache warm-up failed; continuing'
  else
    assert_not_contains "$run/loop.log" 'WARNING: cache warm-up failed'
  fi
  # The run must reach epic-complete regardless of warm-up outcome.
  assert_contains "$run/loop.log" 'epic complete'
}

run_worker_cmd_never_invokes_claude() {
  local root="$TMP_ROOT/worker-cmd" repo="$TMP_ROOT/worker-cmd/repo" bin="$TMP_ROOT/worker-cmd/bin"
  local run="$TMP_ROOT/worker-cmd/run" calls="$TMP_ROOT/worker-cmd/calls.log"
  mkdir -p "$run"
  make_repo "$repo"
  make_bd "$bin"
  make_fake_claude "$bin/claude"
  (
    cd "$repo" && exec env -i PATH="$bin:$PATH" HOME="$HOME" CALLS_LOG="$calls" \
      COOKEPIC_EPIC=epic COOKEPIC_HARNESS=claude COOKEPIC_BIN="$bin/claude" \
      COOKEPIC_WORKER_CMD="$bin/claude" \
      COOKEPIC_MODEL=test-model COOKEPIC_PERMISSION_MODE=bypassPermissions \
      COOKEPIC_SEQUENTIAL=1 COOKEPIC_GATE=true COOKEPIC_NO_PUSH=1 \
      COOKEPIC_SPAWN_DELAY=0 COOKEPIC_WORKER_TIMEOUT=30 "$RUNNER" "$run"
  ) >"$root.stdout" 2>&1 || fail "worker-cmd: run.sh exited nonzero — see $root.stdout"
  [ ! -f "$calls" ] || fail "worker-cmd: COOKEPIC_WORKER_CMD run invoked the fake claude binary — flag/warm-up leaked into the test-hook path"
}

run_case warmup-ok 0
run_case warmup-fails 1
run_worker_cmd_never_invokes_claude
printf 'prompt-cache warm-up regressions: ok\n'
