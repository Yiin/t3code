#!/usr/bin/env bash
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNNER="$SKILL_DIR/run.sh"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
assert_contains() { grep -Fq -- "$2" "$1" || fail "expected $1 to contain: $2"; }

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
  local bin="$1"
  mkdir -p "$bin"
  printf open > "$FAKE_BD_STATE/child-status"
  printf open > "$FAKE_BD_STATE/epic-status"
  cat > "$bin/bd" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
state="${FAKE_BD_STATE:?}"
cmd="$1"; shift || true
case "$cmd" in
  show)
    id="$1"
    status=$(<"$state/$id-status")
    assignee=$(cat "$state/$id-assignee" 2>/dev/null || true)
    type=task; [ "$id" = epic ] && type=epic
    printf '{"id":"%s","status":"%s","title":"%s","issue_type":"%s","assignee":"%s","comment_count":0}\n' \
      "$id" "$status" "$id" "$type" "$assignee"
    ;;
  ready)
    if [ "$(<"$state/child-status")" = open ]; then
      printf '[{"id":"child","title":"Child"}]\n'
    else
      printf '[]\n'
    fi
    ;;
  list)
    if [ "$(<"$state/child-status")" = closed ]; then
      printf '[]\n'
    else
      printf '[{"id":"child","status":"%s"}]\n' "$(<"$state/child-status")"
    fi
    ;;
  update)
    id="$1"; shift
    case " $* " in
      *' --assignee '*)
        args=("$@")
        for ((i=0; i<${#args[@]}; i++)); do
          [ "${args[$i]}" = --assignee ] && printf '%s' "${args[$((i + 1))]}" > "$state/$id-assignee"
        done
        ;;
      *' --claim '*|*' --status open '*) printf open > "$state/$id-status" ;;
      *' --status blocked '*) printf blocked > "$state/$id-status" ;;
    esac
    ;;
  close) printf closed > "$state/$1-status" ;;
  merge-slot|swarm|note|label) ;;
esac
EOF
  chmod +x "$bin/bd"
}

make_opencode() {
  local path="$1" marker="$2"
  cat > "$path" <<EOF
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "\$@" > "\$COOKEPIC_RUN_DIR/argv"
printf '$marker\n' > "\$COOKEPIC_RUN_DIR/binary"
printf 'change\n' > opencode.txt
git add opencode.txt
git commit -qm opencode
bd close "\$COOKEPIC_CHILD"
printf '{"type":"step_start","part":{"type":"step-start"}}\n'
printf '{"type":"text","part":{"type":"text","text":"done"}}\n'
EOF
  chmod +x "$path"
}

run_valid_case() {
  local root="$TMP_ROOT/valid" repo="$TMP_ROOT/valid/repo" bin="$TMP_ROOT/valid/bin"
  local state="$TMP_ROOT/valid/state" run="$TMP_ROOT/valid/run"
  mkdir -p "$state" "$run"
  make_repo "$repo"
  FAKE_BD_STATE="$state" make_bd "$bin"
  make_opencode "$bin/opencode-env" env
  make_opencode "$bin/opencode-cookepic" cookepic
  (
    cd "$repo"
    for v in "${!COOKEPIC_@}"; do unset "$v"; done
    PATH="$bin:$PATH" FAKE_BD_STATE="$state" COOKEPIC_EPIC=epic \
      COOKEPIC_HARNESS=opencode OPENCODE_BIN="$bin/opencode-env" \
      COOKEPIC_BIN="$bin/opencode-cookepic" COOKEPIC_MODEL=test-model \
      COOKEPIC_PERMISSION_MODE=bypassPermissions COOKEPIC_SEQUENTIAL=1 \
      COOKEPIC_GATE="touch '$run/gate-ran'" COOKEPIC_NO_PUSH=1 \
      COOKEPIC_SPAWN_DELAY=0 COOKEPIC_MAX_DISPATCHES=1 \
      COOKEPIC_WORKER_TIMEOUT=30 "$RUNNER" "$run"
  ) >"$root/stdout" 2>&1

  [ "$(<"$run/binary")" = cookepic ] || fail 'COOKEPIC_BIN did not take precedence over OPENCODE_BIN'
  diff -u <(printf '%s\n' run --format json --auto -m test-model --) <(head -n 7 "$run/argv")
  [ "$(sed -n '8p' "$run/argv")" != -- ] || fail 'prompt delimiter was duplicated'
  assert_contains "$run/argv" 'a fresh-context worker executing one child'
  assert_contains "$run/worker-child.log" '"type":"step_start"'
  assert_contains "$run/worker-child.log" '"type":"text"'
  [ -f "$run/gate-ran" ] || fail 'integration gate did not run'
  [ "$(<"$state/child-status")" = closed ] || fail 'child was not closed'
  assert_contains "$run/mailbox.jsonl" '"event": "done"'
  assert_contains "$run/mailbox.jsonl" '"event": "finished"'
}

run_invalid_permission_case() {
  local root="$TMP_ROOT/invalid" repo="$TMP_ROOT/invalid/repo" bin="$TMP_ROOT/invalid/bin"
  local state="$TMP_ROOT/invalid/state" run="$TMP_ROOT/invalid/run" rc
  mkdir -p "$state" "$run"
  make_repo "$repo"
  FAKE_BD_STATE="$state" make_bd "$bin"
  make_opencode "$bin/opencode" invalid
  set +e
  (
    cd "$repo"
    for v in "${!COOKEPIC_@}"; do unset "$v"; done
    PATH="$bin:$PATH" FAKE_BD_STATE="$state" COOKEPIC_EPIC=epic \
      COOKEPIC_HARNESS=opencode COOKEPIC_PERMISSION_MODE=read-only \
      COOKEPIC_SEQUENTIAL=1 COOKEPIC_GATE=true COOKEPIC_NO_PUSH=1 \
      "$RUNNER" "$run"
  ) >"$root/stdout" 2>&1
  rc=$?
  set -e
  [ "$rc" -eq 2 ] || fail "invalid permission mode exited $rc instead of 2"
  assert_contains "$root/stdout" 'unsupported OpenCode permission mode: read-only'
  assert_contains "$root/stdout" 'use auto or bypassPermissions'
  [ ! -f "$run/argv" ] || fail 'invalid permission mode dispatched a worker'
}

run_valid_case
run_invalid_permission_case
printf 'opencode harness regressions: ok\n'
