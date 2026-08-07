#!/usr/bin/env bash
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNNER="$SKILL_DIR/run-legacy.sh" # legacy engine: the shim (run.sh) execs the shared core by default
TMP_ROOT="$(mktemp -d /var/tmp/cook-epic-provider-fallback.XXXXXX)"
trap 'rm -rf "$TMP_ROOT"' EXIT

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

make_bd() {
  local bin="$1" state="$2"
  mkdir -p "$bin" "$state"
  printf open > "$state/child"
  printf open > "$state/epic"
  cat > "$bin/bd" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
state="${FAKE_BD_STATE:?}"
cmd="$1"; shift || true
case "$cmd" in
  show)
    id="$1"
    if [ "$id" = epic ]; then
      printf '{"id":"epic","status":"%s","title":"Epic","issue_type":"epic","comment_count":0,"description":"test epic"}\n' "$(<"$state/epic")"
    else
      printf '{"id":"child","status":"%s","title":"Child","issue_type":"task","assignee":"%s","comment_count":0}\n' \
        "$(<"$state/child")" "$(cat "$state/assignee" 2>/dev/null || true)"
    fi
    ;;
  ready)
    [ "$(<"$state/child")" = open ] && printf '[{"id":"child","title":"Child"}]\n' || printf '[]\n'
    ;;
  list)
    printf '[{"id":"child","status":"%s"}]\n' "$(<"$state/child")"
    ;;
  update)
    id="$1"; shift
    args=("$@")
    for ((i=0; i<${#args[@]}; i++)); do
      if [ "${args[$i]}" = --assignee ]; then
        printf '%s' "${args[$((i + 1))]}" > "$state/assignee"
      fi
    done
    case " $* " in
      *' --claim '*|*' --status open '*) printf open > "$state/$id" ;;
      *' --status blocked '*) printf blocked > "$state/$id" ;;
    esac
    ;;
  close) printf closed > "$state/$1" ;;
  merge-slot|swarm|note|label|comment) ;;
esac
EOF
  chmod +x "$bin/bd"
}

make_multi_bd() {
  local bin="$1" state="$2"
  mkdir -p "$bin" "$state"
  printf open > "$state/child-a"
  printf open > "$state/child-b"
  printf open > "$state/epic"
  cat > "$bin/bd" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
state="${FAKE_BD_STATE:?}"
cmd="$1"; shift || true
case "$cmd" in
  show)
    id="$1"
    if [ "$id" = epic ]; then
      printf '{"id":"epic","status":"%s","title":"Epic","issue_type":"epic","comment_count":0,"description":"test epic"}\n' "$(<"$state/epic")"
    else
      printf '{"id":"%s","status":"%s","title":"%s","issue_type":"task","assignee":"%s","comment_count":0}\n' \
        "$id" "$(<"$state/$id")" "$id" "$(cat "$state/$id.assignee" 2>/dev/null || true)"
    fi
    ;;
  ready)
    printf '['
    comma=''
    for id in child-a child-b; do
      if [ "$(<"$state/$id")" = open ]; then
        printf '%s{"id":"%s","title":"%s"}' "$comma" "$id" "$id"
        comma=,
      fi
    done
    printf ']\n'
    ;;
  list)
    printf '[{"id":"child-a","status":"%s"},{"id":"child-b","status":"%s"}]\n' \
      "$(<"$state/child-a")" "$(<"$state/child-b")"
    ;;
  update)
    id="$1"; shift
    args=("$@")
    for ((i=0; i<${#args[@]}; i++)); do
      [ "${args[$i]}" = --assignee ] && printf '%s' "${args[$((i + 1))]}" > "$state/$id.assignee"
    done
    case " $* " in
      *' --claim '*) printf in_progress > "$state/$id" ;;
      *' --status open '*) printf open > "$state/$id" ;;
      *' --status blocked '*) printf blocked > "$state/$id" ;;
    esac
    ;;
  close) printf closed > "$state/$1" ;;
  merge-slot|swarm|note|label|comment) ;;
esac
EOF
  chmod +x "$bin/bd"
}

make_claude() {
  local path="$1" message="$2"
  cat > "$path" <<EOF
#!/usr/bin/env bash
set -euo pipefail
if [[ "\$*" == *'Reply with exactly: ok'* ]]; then
  printf '{"total_cost_usd":0}\n'
  exit 0
fi
printf '%s\n' '{"type":"result","subtype":"error_during_execution","is_error":true,"result":"$message"}'
exit 1
EOF
  chmod +x "$path"
}

make_failing_codex() {
  local path="$1"
  cat > "$path" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$@" > "$COOKEPIC_RUN_DIR/codex.args"
printf '{"type":"error","message":"authentication failed: unauthorized"}\n'
exit 1
EOF
  chmod +x "$path"
}

make_success_kimi() {
  local path="$1"
  cat > "$path" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$@" > "$COOKEPIC_RUN_DIR/kimi.args"
printf 'fallback\n' > fallback.txt
git add fallback.txt
git commit -qm fallback
bd close "$COOKEPIC_CHILD"
printf '{"type":"result","text":"done"}\n'
EOF
  chmod +x "$path"
}

run_chain_case() {
  local root="$TMP_ROOT/chain" repo="$TMP_ROOT/chain/repo" bin="$TMP_ROOT/chain/bin"
  local state="$TMP_ROOT/chain/state" run="$TMP_ROOT/chain/run"
  mkdir -p "$run"
  make_repo "$repo"
  make_bd "$bin" "$state"
  make_claude "$bin/claude" 'monthly spend limit reached'
  make_failing_codex "$bin/codex"
  make_success_kimi "$bin/kimi"
  (
    cd "$repo"
    exec env PATH="$bin:$PATH" FAKE_BD_STATE="$state" \
      COOKEPIC_EPIC=epic COOKEPIC_HARNESS=claude COOKEPIC_BIN="$bin/claude" \
      COOKEPIC_MODEL=primary-model COOKEPIC_SEQUENTIAL=1 COOKEPIC_GATE=true \
      COOKEPIC_NO_PUSH=1 COOKEPIC_SPAWN_DELAY=0 COOKEPIC_SUPERVISION_TICK=1 \
      COOKEPIC_MAX_DISPATCHES=4 COOKEPIC_MAX_ATTEMPTS=1 "$RUNNER" "$run"
  ) > "$root/stdout" 2>&1

  assert_contains "$run/mailbox.jsonl" '"from": "claude"'
  assert_contains "$run/mailbox.jsonl" '"to": "codex"'
  assert_contains "$run/mailbox.jsonl" '"from": "codex"'
  assert_contains "$run/mailbox.jsonl" '"to": "kimi"'
  assert_not_contains "$run/mailbox.jsonl" '"event": "retry"'
  assert_contains "$run/codex.args" 'gpt-5.6-sol'
  assert_contains "$run/codex.args" 'model_reasoning_effort="high"'
  assert_not_contains "$run/codex.args" 'primary-model'
  assert_contains "$run/kimi.args" 'kimi-code/k3'
  [ "$(<"$state/child")" = closed ] || fail 'Kimi fallback did not finish the child'
}

run_generic_failure_case() {
  local root="$TMP_ROOT/generic" repo="$TMP_ROOT/generic/repo" bin="$TMP_ROOT/generic/bin"
  local state="$TMP_ROOT/generic/state" run="$TMP_ROOT/generic/run"
  mkdir -p "$run"
  make_repo "$repo"
  make_bd "$bin" "$state"
  make_claude "$bin/claude" 'ordinary worker failure'
  make_success_kimi "$bin/kimi"
  cat > "$bin/codex" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
: > "$COOKEPIC_RUN_DIR/codex-called"
EOF
  chmod +x "$bin/codex"
  set +e
  (
    cd "$repo"
    exec env PATH="$bin:$PATH" FAKE_BD_STATE="$state" \
      COOKEPIC_EPIC=epic COOKEPIC_HARNESS=claude COOKEPIC_BIN="$bin/claude" \
      COOKEPIC_SEQUENTIAL=1 COOKEPIC_GATE=true COOKEPIC_NO_PUSH=1 \
      COOKEPIC_SPAWN_DELAY=0 COOKEPIC_SUPERVISION_TICK=1 \
      COOKEPIC_MAX_DISPATCHES=2 COOKEPIC_MAX_ATTEMPTS=1 "$RUNNER" "$run"
  ) > "$root/stdout" 2>&1
  set -e

  assert_not_contains "$run/mailbox.jsonl" '"event": "provider-fallback"'
  assert_contains "$run/mailbox.jsonl" '"event": "blocked"'
  [ ! -f "$run/codex-called" ] || fail 'generic failure changed providers'
}

run_domain_text_case() {
  local root="$TMP_ROOT/domain-text" repo="$TMP_ROOT/domain-text/repo" bin="$TMP_ROOT/domain-text/bin"
  local state="$TMP_ROOT/domain-text/state" run="$TMP_ROOT/domain-text/run"
  mkdir -p "$run"
  make_repo "$repo"
  make_bd "$bin" "$state"
  cat > "$bin/claude" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == *'Reply with exactly: ok'* ]]; then
  printf '{"total_cost_usd":0}\n'
  exit 0
fi
printf '{"type":"result","subtype":"success","is_error":false,"result":"The task covers provider error handling for authentication, 401, 503, rate limit, overloaded, and a service unavailable page."}\n'
exit 1
EOF
  chmod +x "$bin/claude"
  cat > "$bin/codex" <<'EOF'
#!/usr/bin/env bash
: > "$COOKEPIC_RUN_DIR/codex-called"
EOF
  chmod +x "$bin/codex"
  set +e
  (
    cd "$repo"
    exec env PATH="$bin:$PATH" FAKE_BD_STATE="$state" \
      COOKEPIC_EPIC=epic COOKEPIC_HARNESS=claude COOKEPIC_BIN="$bin/claude" \
      COOKEPIC_SEQUENTIAL=1 COOKEPIC_GATE=true COOKEPIC_NO_PUSH=1 \
      COOKEPIC_SPAWN_DELAY=0 COOKEPIC_SUPERVISION_TICK=1 \
      COOKEPIC_MAX_DISPATCHES=2 COOKEPIC_MAX_ATTEMPTS=1 "$RUNNER" "$run"
  ) > "$root/stdout" 2>&1
  set -e

  assert_not_contains "$run/mailbox.jsonl" '"event": "provider-fallback"'
  assert_contains "$run/mailbox.jsonl" '"event": "blocked"'
  [ ! -f "$run/codex-called" ] || fail 'domain text changed providers'
}

run_exit_127_case() {
  local root="$TMP_ROOT/exit-127" repo="$TMP_ROOT/exit-127/repo" bin="$TMP_ROOT/exit-127/bin"
  local state="$TMP_ROOT/exit-127/state" run="$TMP_ROOT/exit-127/run"
  mkdir -p "$run"
  make_repo "$repo"
  make_bd "$bin" "$state"
  cat > "$bin/claude" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == *'Reply with exactly: ok'* ]]; then
  printf '{"total_cost_usd":0}\n'
  exit 0
fi
exit 127
EOF
  chmod +x "$bin/claude"
  make_success_kimi "$bin/kimi"
  (
    cd "$repo"
    exec env PATH="$bin:/usr/bin:/bin" FAKE_BD_STATE="$state" \
      COOKEPIC_EPIC=epic COOKEPIC_HARNESS=claude COOKEPIC_BIN="$bin/claude" \
      COOKEPIC_SEQUENTIAL=1 COOKEPIC_GATE=true COOKEPIC_NO_PUSH=1 \
      COOKEPIC_SPAWN_DELAY=0 COOKEPIC_SUPERVISION_TICK=1 \
      COOKEPIC_MAX_DISPATCHES=2 COOKEPIC_MAX_ATTEMPTS=1 "$RUNNER" "$run"
  ) > "$root/stdout" 2>&1

  assert_contains "$run/mailbox.jsonl" '"from": "claude"'
  assert_contains "$run/mailbox.jsonl" '"to": "kimi"'
  [ "$(<"$state/child")" = closed ] || fail 'exit 127 did not fall back'
}

run_drain_case() {
  local root="$TMP_ROOT/drain" repo="$TMP_ROOT/drain/repo" bin="$TMP_ROOT/drain/bin"
  local state="$TMP_ROOT/drain/state" run="$TMP_ROOT/drain/run"
  mkdir -p "$run"
  make_repo "$repo"
  make_multi_bd "$bin" "$state"
  cat > "$bin/claude" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == *'Reply with exactly: ok'* ]]; then
  printf '{"total_cost_usd":0}\n'
  exit 0
fi
if [ "$COOKEPIC_CHILD" = child-a ]; then
  printf '{"type":"result","subtype":"error_during_execution","is_error":true,"result":"monthly spend limit reached"}\n'
  exit 1
fi
sleep 2
printf 'old provider finished\n' > child-b.txt
git add child-b.txt
git commit -qm 'finish child b'
bd close child-b
: > "$COOKEPIC_RUN_DIR/old-provider-drained"
printf '{"type":"result","subtype":"success","is_error":false,"result":"done"}\n'
EOF
  chmod +x "$bin/claude"
  cat > "$bin/codex" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
[ -f "$COOKEPIC_RUN_DIR/old-provider-drained" ] || : > "$COOKEPIC_RUN_DIR/codex-before-drain"
printf 'fallback finished\n' > child-a.txt
git add child-a.txt
git commit -qm 'finish child a'
bd close child-a
printf '{"type":"result","text":"done"}\n'
EOF
  chmod +x "$bin/codex"
  (
    cd "$repo"
    exec env PATH="$bin:$PATH" FAKE_BD_STATE="$state" \
      COOKEPIC_EPIC=epic COOKEPIC_HARNESS=claude COOKEPIC_BIN="$bin/claude" \
      COOKEPIC_WORKERS=2 COOKEPIC_GATE=true COOKEPIC_NO_PUSH=1 \
      COOKEPIC_SPAWN_DELAY=0 COOKEPIC_SUPERVISION_TICK=1 \
      COOKEPIC_MAX_DISPATCHES=3 COOKEPIC_MAX_ATTEMPTS=1 "$RUNNER" "$run"
  ) > "$root/stdout" 2>&1

  assert_contains "$run/mailbox.jsonl" '"event": "provider-fallback"'
  [ -f "$run/old-provider-drained" ] || fail 'old provider worker did not finish'
  [ ! -f "$run/codex-before-drain" ] || fail 'Codex started before the old provider drained'
  [ "$(<"$state/child-a")" = closed ] || fail 'Codex did not finish child-a'
  [ "$(<"$state/child-b")" = closed ] || fail 'Claude did not finish child-b'
}

run_missing_intermediate_case() {
  local root="$TMP_ROOT/missing" repo="$TMP_ROOT/missing/repo" bin="$TMP_ROOT/missing/bin"
  local state="$TMP_ROOT/missing/state" run="$TMP_ROOT/missing/run"
  mkdir -p "$run"
  make_repo "$repo"
  make_bd "$bin" "$state"
  make_success_kimi "$bin/kimi"
  (
    cd "$repo"
    exec env PATH="$bin:/usr/bin:/bin" FAKE_BD_STATE="$state" \
      COOKEPIC_EPIC=epic COOKEPIC_HARNESS=claude COOKEPIC_BIN="$bin/missing-claude" \
      COOKEPIC_MODEL=primary-model COOKEPIC_SEQUENTIAL=1 COOKEPIC_GATE=true \
      COOKEPIC_NO_PUSH=1 COOKEPIC_SPAWN_DELAY=0 COOKEPIC_SUPERVISION_TICK=1 \
      COOKEPIC_MAX_DISPATCHES=2 COOKEPIC_MAX_ATTEMPTS=1 "$RUNNER" "$run"
  ) > "$root/stdout" 2>&1

  assert_contains "$run/mailbox.jsonl" '"from": "claude"'
  assert_contains "$run/mailbox.jsonl" '"to": "kimi"'
  assert_contains "$run/mailbox.jsonl" '"reason": "binary unavailable"'
  assert_not_contains "$run/mailbox.jsonl" '"to": "codex"'
  assert_contains "$run/kimi.args" 'kimi-code/k3'
}

run_chain_case
run_generic_failure_case
run_domain_text_case
run_exit_127_case
run_drain_case
run_missing_intermediate_case
printf 'provider fallback regressions: ok\n'
