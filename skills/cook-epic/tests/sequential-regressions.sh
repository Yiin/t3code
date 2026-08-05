#!/usr/bin/env bash
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

make_fake_tools() {
  local bin="$1"
  mkdir -p "$bin"
  cat > "$bin/bd" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
state="${FAKE_BD_STATE:?}"
cmd="$1"; shift || true
case "$cmd" in
  show)
    child="$1"
    status=$(<"$state/status")
    assignee=$(cat "$state/assignee" 2>/dev/null || true)
    printf '{"id":"%s","status":"%s","title":"Child","issue_type":"task","assignee":"%s","comment_count":0}\n' "$child" "$status" "$assignee"
    ;;
  ready)
    status=$(<"$state/status")
    if [ "$status" = open ]; then printf '[{"id":"child","title":"Child"}]\n'; else printf '[]\n'; fi
    ;;
  list)
    status=$(<"$state/status")
    if [ "$status" = closed ]; then printf '[]\n'; else printf '[{"id":"child","status":"%s"}]\n' "$status"; fi
    ;;
  update)
    child="$1"; shift
    case " $* " in
      *' --assignee '*)
        args=("$@"); for ((i=0; i<${#args[@]}; i++)); do [ "${args[$i]}" = --assignee ] && printf '%s' "${args[$((i + 1))]}" > "$state/assignee"; done
        ;;
      *' --claim '*) printf 'open' > "$state/status" ;;
      *' --status open '*) printf 'open' > "$state/status" ;;
      *' --status blocked '*) printf 'blocked' > "$state/status" ;;
    esac
    ;;
  close) printf 'closed' > "$state/status" ;;
  merge-slot|swarm|note|label) ;;
  *) ;;
esac
EOF
  chmod +x "$bin/bd"
}

run_case() {
  local case_name="$1" worker_script="$2" setup_case="${3:-}" push_mode="${4:-no-push}" gate="${5:-true}"
  local root repo sibling state bin run
  root="$TMP_ROOT/$case_name"; repo="$root/repo"; sibling="$root/api"; state="$root/state"; bin="$root/bin"; run="$root/run"
  mkdir -p "$state" "$run"
  make_repo "$repo"
  make_repo "$sibling"
  make_fake_tools "$bin"
  printf 'open' > "$state/status"
  printf '%s\n' "$worker_script" > "$root/worker.sh"
  chmod +x "$root/worker.sh"
  [ -z "$setup_case" ] || "$setup_case" "$repo" "$sibling"
  if [ "$push_mode" = push ]; then
    git -C "$repo" remote add origin test://coordinator-push
    git -C "$sibling" remote add origin test://sibling-push
    cat > "$root/push.sh" <<'EOF'
#!/usr/bin/env bash
printf '%s %s\n' "$1" "${*:2}" >> "${COOKEPIC_PUSH_LOG:?}"
EOF
    chmod +x "$root/push.sh"
  fi
  (
    cd "$repo"
    PATH="$bin:$PATH" FAKE_BD_STATE="$state" COOKEPIC_EPIC=epic COOKEPIC_HARNESS=claude \
      COOKEPIC_WORKER_CMD="$root/worker.sh" COOKEPIC_SEQUENTIAL=1 COOKEPIC_SIBLINGS="../api" \
      COOKEPIC_GATE="$gate" COOKEPIC_NO_PUSH=$([ "$push_mode" = push ] && printf '' || printf 1) COOKEPIC_PUSH_CMD="${root}/push.sh" COOKEPIC_PUSH_LOG="$run/pushes" COOKEPIC_SPAWN_DELAY=0 COOKEPIC_MAX_DISPATCHES=3 \
      COOKEPIC_MAX_ATTEMPTS=2 COOKEPIC_WORKER_TIMEOUT=30 "$RUNNER" "$run"
  ) >"$root/stdout" 2>&1 || true
  printf '%s\n' "$root"
}

contaminating_worker='#!/usr/bin/env bash
set -euo pipefail
attempt_file="$COOKEPIC_RUN_DIR/attempt"
attempt=0; [ -f "$attempt_file" ] && attempt=$(<"$attempt_file")
attempt=$((attempt + 1)); printf "%s" "$attempt" > "$attempt_file"
if [ "$attempt" -eq 1 ]; then
  printf "partial\\n" > partial.txt
else
  git add partial.txt && git commit -qm "finish partial"
  bd close "$COOKEPIC_CHILD"
fi
'
contamination_root=$(run_case contamination "$contaminating_worker")
assert_contains "$contamination_root/run/mailbox.jsonl" '"child": "child"'
assert_contains "$contamination_root/run/loop.log" 'this child owns cleanup'
assert_not_contains "$contamination_root/run/loop.log" 'gated, pushed'
assert_contains "$contamination_root/run/loop.log" 'gated, landed locally'
assert_contains "$contamination_root/run/mailbox.jsonl" '"pushed": false'

retry_commit_then_close_worker='#!/usr/bin/env bash
set -euo pipefail
attempt_file="$COOKEPIC_RUN_DIR/retry-attempt"
attempt=0; [ -f "$attempt_file" ] && attempt=$(<"$attempt_file")
attempt=$((attempt + 1)); printf "%s" "$attempt" > "$attempt_file"
if [ "$attempt" -eq 1 ]; then
  printf "first-attempt commit\\n" > retry.txt
  git add retry.txt && git commit -qm "first retry commit"
else
  bd close "$COOKEPIC_CHILD"
fi
'
retry_push_root=$(run_case retry-push-first-baseline "$retry_commit_then_close_worker" '' push)
assert_contains "$retry_push_root/run/pushes" "$retry_push_root/repo origin main"
assert_not_contains "$retry_push_root/run/pushes" "$retry_push_root/api"
assert_contains "$retry_push_root/run/mailbox.jsonl" '"pushed": true'

run_clean_commit_affinity_case() {
  local mode="${1:-clean}" root repo state bin run gate rate_backoff max_attempts
  root="$TMP_ROOT/clean-commit-affinity-$mode"; repo="$root/repo"; state="$root/state"; bin="$root/bin"; run="$root/run"
  rate_backoff=120; max_attempts=2
  case "$mode" in
    gate) gate="test -f '$run/gate-failed' || { touch '$run/gate-failed'; exit 1; }"; max_attempts=3 ;;
    gate-dirt) gate="test -f '$run/gate-dirted' || { touch '$run/gate-dirted'; printf dirt > gate-dirt.tmp; exit 0; }"; max_attempts=3 ;;
    rate) gate=true; rate_backoff=0 ;;
    *) gate=true ;;
  esac
  mkdir -p "$state" "$run" "$bin"
  make_repo "$repo"
  printf 'open' > "$state/a-status"
  printf 'open' > "$state/b-status"
  cat > "$bin/bd" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
state="${FAKE_BD_STATE:?}"; cmd="$1"; shift || true
case "$cmd" in
  show)
    child="$1"
    if [ "$child" = epic ]; then
      printf '{"id":"epic","status":"open","title":"Epic","issue_type":"epic","assignee":"","comment_count":0}\n'
      exit 0
    fi
    status=$(<"$state/${child}-status"); assignee=$(cat "$state/${child}-assignee" 2>/dev/null || true)
    printf '{"id":"%s","status":"%s","title":"Child %s","issue_type":"task","assignee":"%s","comment_count":0}\n' "$child" "$status" "$child" "$assignee"
    ;;
  ready)
    a=$(<"$state/a-status"); b=$(<"$state/b-status")
    if [ "$a" = open ]; then printf '[{"id":"a","title":"Child a"},{"id":"b","title":"Child b"}]\n'
    elif [ "$b" = open ]; then printf '[{"id":"b","title":"Child b"}]\n'; else printf '[]\n'; fi
    ;;
  list)
    a=$(<"$state/a-status"); b=$(<"$state/b-status"); printf '['; first=1
    for child in a b; do status=$(<"$state/${child}-status"); [ "$status" = closed ] && continue; [ "$first" = 1 ] || printf ','; printf '{"id":"%s","status":"%s"}' "$child" "$status"; first=0; done; printf ']\n'
    ;;
  update)
    child="$1"; shift; case " $* " in
      *' --assignee '*) args=("$@"); for ((i=0;i<${#args[@]};i++)); do [ "${args[$i]}" = --assignee ] && printf '%s' "${args[$((i+1))]}" > "$state/${child}-assignee"; done ;;
      *' --status open '*|*' --claim '*) printf open > "$state/${child}-status" ;;
      *' --status blocked '*) printf blocked > "$state/${child}-status" ;;
    esac
    ;;
  close) printf closed > "$state/$1-status" ;;
  merge-slot|swarm|note|label) ;;
esac
EOF
  chmod +x "$bin/bd"
  cat > "$root/worker.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [ "$COOKEPIC_CHILD" = a ]; then
  attempt_file="$COOKEPIC_RUN_DIR/a-attempt"; attempt=0; [ -f "$attempt_file" ] && attempt=$(<"$attempt_file")
  attempt=$((attempt + 1)); printf '%s' "$attempt" > "$attempt_file"
  if [ "$attempt" = 1 ]; then
    printf 'A\n' > a.txt; git add a.txt; git commit -qm 'A clean partial'
    if [ "${COOKEPIC_TEST_MODE:-}" = closed-dirty ]; then
      printf 'dirty\n' > closed-dirty.tmp; bd close a
    fi
    [ "${COOKEPIC_RATE_CASE:-0}" = 1 ] && printf '429 rate limit\n'
  else
    [ "${COOKEPIC_GATE_DIRT_CASE:-0}" = 1 ] && rm -f gate-dirt.tmp
    [ "${COOKEPIC_TEST_MODE:-}" = closed-dirty ] && { git add closed-dirty.tmp; git commit -qm 'cleanup closed dirt'; }
    bd close a
  fi
else
  printf 'B\n' > b.txt; git add b.txt; git commit -qm 'B commit'; bd close b
fi
EOF
  chmod +x "$root/worker.sh"
  (
    cd "$repo"
    PATH="$bin:$PATH" FAKE_BD_STATE="$state" COOKEPIC_EPIC=epic COOKEPIC_HARNESS=claude COOKEPIC_WORKER_CMD="$root/worker.sh" \
      COOKEPIC_SEQUENTIAL=1 COOKEPIC_GATE="$gate" COOKEPIC_NO_PUSH=1 COOKEPIC_RATE_LIMIT_BACKOFF="$rate_backoff" COOKEPIC_RATE_CASE=$([ "$mode" = rate ] && printf 1 || printf 0) COOKEPIC_GATE_DIRT_CASE=$([ "$mode" = gate-dirt ] && printf 1 || printf 0) COOKEPIC_TEST_MODE="$mode" COOKEPIC_SPAWN_DELAY=0 COOKEPIC_MAX_DISPATCHES=4 \
      COOKEPIC_MAX_ATTEMPTS="$max_attempts" COOKEPIC_WORKER_TIMEOUT=30 "$RUNNER" "$run"
  ) >"$root/stdout" 2>&1 || true
  printf '%s\n' "$root"
}

clean_affinity_root=$(run_clean_commit_affinity_case)
a_done_line=$(grep -n 'a done on' "$clean_affinity_root/run/loop.log" | cut -d: -f1)
b_dispatch_line=$(grep -n 'dispatched b' "$clean_affinity_root/run/loop.log" | cut -d: -f1)
[ "$a_done_line" -lt "$b_dispatch_line" ] || fail 'child b dispatched before child a resolved its clean partial commit'
first_done=$(grep -A12 '"event": "done"' "$clean_affinity_root/run/mailbox.jsonl" | head -n 13)
printf '%s\n' "$first_done" | grep -Fq '"child": "a"' || fail 'first landing event was not child a'
printf '%s\n' "$first_done" | grep -Fq 'B commit' && fail 'child a attribution absorbed child b commit'

gate_affinity_root=$(run_clean_commit_affinity_case gate)
gate_a_done_line=$(grep -n 'a done on' "$gate_affinity_root/run/loop.log" | cut -d: -f1)
gate_b_dispatch_line=$(grep -n 'dispatched b' "$gate_affinity_root/run/loop.log" | cut -d: -f1)
[ "$gate_a_done_line" -lt "$gate_b_dispatch_line" ] || fail 'child b dispatched before child a retried after its gate failure'
assert_contains "$gate_affinity_root/run/loop.log" 'integration gate failed'

rate_affinity_root=$(run_clean_commit_affinity_case rate)
rate_a_done_line=$(grep -n 'a done on' "$rate_affinity_root/run/loop.log" | cut -d: -f1)
rate_b_dispatch_line=$(grep -n 'dispatched b' "$rate_affinity_root/run/loop.log" | cut -d: -f1)
[ "$rate_a_done_line" -lt "$rate_b_dispatch_line" ] || fail 'child b dispatched before rate-limited child a retried'
assert_contains "$rate_affinity_root/run/loop.log" 'rate limit'

closed_dirty_affinity_root=$(run_clean_commit_affinity_case closed-dirty)
closed_dirty_a_done_line=$(grep -n 'a done on' "$closed_dirty_affinity_root/run/loop.log" | cut -d: -f1)
closed_dirty_b_dispatch_line=$(grep -n 'dispatched b' "$closed_dirty_affinity_root/run/loop.log" | cut -d: -f1)
[ "$closed_dirty_a_done_line" -lt "$closed_dirty_b_dispatch_line" ] || fail 'child b dispatched before closed dirty child a retried'
assert_contains "$closed_dirty_affinity_root/run/loop.log" 'this child owns cleanup'

gate_dirt_affinity_root=$(run_clean_commit_affinity_case gate-dirt)
gate_dirt_a_done_line=$(grep -n 'a done on' "$gate_dirt_affinity_root/run/loop.log" | cut -d: -f1)
gate_dirt_b_dispatch_line=$(grep -n 'dispatched b' "$gate_dirt_affinity_root/run/loop.log" | cut -d: -f1)
[ "$gate_dirt_a_done_line" -lt "$gate_dirt_b_dispatch_line" ] || fail 'child b dispatched before child a cleaned gate-created dirt'
assert_contains "$gate_dirt_affinity_root/run/loop.log" 'integration gate left uncommitted changes'

baseline_untracked_setup() {
  local repo="$1" sibling="$2"
  printf 'existing main artifact\n' > "$repo/existing-main.tmp"
  printf 'existing sibling artifact\n' > "$sibling/existing-sibling.tmp"
}
baseline_untracked_worker='#!/usr/bin/env bash
set -euo pipefail
printf "main commit\\n" > baseline-main.txt
git add baseline-main.txt && git commit -qm "baseline main"
printf "sibling commit\\n" > ../api/baseline-api.txt
git -C ../api add baseline-api.txt && git -C ../api commit -qm "baseline api"
bd close "$COOKEPIC_CHILD"
'
baseline_untracked_root=$(run_case baseline-untracked "$baseline_untracked_worker" baseline_untracked_setup)
assert_contains "$baseline_untracked_root/run/loop.log" 'gated, landed locally'
assert_not_contains "$baseline_untracked_root/run/loop.log" 'left uncommitted changes'

sibling_worker='#!/usr/bin/env bash
set -euo pipefail
printf "api change\\n" >> ../api/api.txt
git -C ../api add api.txt && git -C ../api commit -qm "api only"
bd close "$COOKEPIC_CHILD"
'
sibling_root=$(run_case sibling-only "$sibling_worker")
assert_contains "$sibling_root/run/summary.md" "$sibling_root/api"
assert_contains "$sibling_root/run/summary.md" '1 commits'
assert_contains "$sibling_root/run/mailbox.jsonl" '"repositories":'
assert_contains "$sibling_root/run/mailbox.jsonl" '"pushed": false'

clean_worktree_setup() {
  local repo="$1"
  mkdir -p "$repo/.claude/worktrees"
  git -C "$repo" worktree add -q "$repo/.claude/worktrees/tool" -b tool
}
clean_worktree_worker='#!/usr/bin/env bash
set -euo pipefail
printf "main change\\n" >> main.txt
git add main.txt && git commit -qm "main"
bd close "$COOKEPIC_CHILD"
'
worktree_root=$(run_case clean-nested-worktree "$clean_worktree_worker" clean_worktree_setup)
assert_contains "$worktree_root/run/loop.log" 'gated, landed locally'
assert_not_contains "$worktree_root/run/loop.log" 'left uncommitted changes'

unknown_worktree_worker='#!/usr/bin/env bash
set -euo pipefail
printf "unknown\\n" > .claude/unknown.txt
printf "main change\\n" >> main.txt
git add main.txt && git commit -qm "main"
bd close "$COOKEPIC_CHILD"
'
unknown_worktree_root=$(run_case unknown-nested-path "$unknown_worktree_worker" clean_worktree_setup)
assert_contains "$unknown_worktree_root/run/loop.log" 'this child owns cleanup'

run_env_case() {
  local root repo state bin run
  root="$TMP_ROOT/claude-env"; repo="$root/repo"; state="$root/state"; bin="$root/bin"; run="$root/run"
  mkdir -p "$state" "$run" "$bin"
  make_repo "$repo"
  make_fake_tools "$bin"
  printf 'open' > "$state/status"
  cat > "$bin/claude" <<'EOF'
#!/usr/bin/env bash
# The coordinator's cache warm-up also invokes claude, before any dispatch;
# only a real worker call carries COOKEPIC_CHILD.
[ -n "${COOKEPIC_CHILD:-}" ] || exit 0
printf '%s' "${CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS-unset}" > "$COOKEPIC_RUN_DIR/ceiling"
printf 'done\n' > claude.txt
git add claude.txt && git commit -qm claude
bd close "$COOKEPIC_CHILD"
EOF
  chmod +x "$bin/claude"
  (
    cd "$repo"
    PATH="$bin:$PATH" FAKE_BD_STATE="$state" COOKEPIC_EPIC=epic COOKEPIC_HARNESS=claude \
      COOKEPIC_SEQUENTIAL=1 COOKEPIC_GATE=true COOKEPIC_NO_PUSH=1 COOKEPIC_SPAWN_DELAY=0 \
      COOKEPIC_MAX_DISPATCHES=1 COOKEPIC_WORKER_TIMEOUT=30 "$RUNNER" "$run"
  ) >"$root/stdout" 2>&1 || true
  printf '%s\n' "$root"
}

env_root=$(run_env_case)
[ "$(<"$env_root/run/ceiling")" = 0 ] || fail 'Claude worker did not receive a zero background-wait ceiling'

run_env_preserved_case() {
  local root repo state bin run
  root="$TMP_ROOT/claude-env-preserved"; repo="$root/repo"; state="$root/state"; bin="$root/bin"; run="$root/run"
  mkdir -p "$state" "$run" "$bin"
  make_repo "$repo"
  make_fake_tools "$bin"
  printf 'open' > "$state/status"
  cat > "$bin/claude" <<'EOF'
#!/usr/bin/env bash
# See run_env_case: warm-up calls carry no COOKEPIC_CHILD.
[ -n "${COOKEPIC_CHILD:-}" ] || exit 0
printf '%s' "${CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS-unset}" > "$COOKEPIC_RUN_DIR/ceiling"
printf 'done\n' > claude.txt
git add claude.txt && git commit -qm claude
bd close "$COOKEPIC_CHILD"
EOF
  chmod +x "$bin/claude"
  (
    cd "$repo"
    PATH="$bin:$PATH" FAKE_BD_STATE="$state" CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=123 COOKEPIC_EPIC=epic COOKEPIC_HARNESS=claude \
      COOKEPIC_SEQUENTIAL=1 COOKEPIC_GATE=true COOKEPIC_NO_PUSH=1 COOKEPIC_SPAWN_DELAY=0 \
      COOKEPIC_MAX_DISPATCHES=1 COOKEPIC_WORKER_TIMEOUT=30 "$RUNNER" "$run"
  ) >"$root/stdout" 2>&1 || true
  printf '%s\n' "$root"
}

env_preserved_root=$(run_env_preserved_case)
[ "$(<"$env_preserved_root/run/ceiling")" = 123 ] || fail 'Claude worker overwrote the caller background-wait ceiling'

sibling_push_root=$(run_case sibling-explicit-push "$sibling_worker" '' push)
assert_contains "$sibling_push_root/run/pushes" "$sibling_push_root/api origin main"

sibling_clean_worktree_setup() {
  local sibling="$2"
  mkdir -p "$sibling/.claude/worktrees"
  git -C "$sibling" worktree add -q "$sibling/.claude/worktrees/tool" -b tool
}
sibling_dirty_worktree_setup() {
  local sibling="$2" nested
  sibling_clean_worktree_setup "$1" "$sibling"
  nested="$sibling/.claude/worktrees/tool"
  printf 'dirty nested worktree\n' > "$nested/dirty.txt"
}
sibling_nested_worker='#!/usr/bin/env bash
set -euo pipefail
printf "main change\\n" > sibling-nested-main.txt
git add sibling-nested-main.txt && git commit -qm "sibling nested check"
bd close "$COOKEPIC_CHILD"
'
sibling_clean_worktree_root=$(run_case relative-sibling-clean-worktree "$sibling_nested_worker" sibling_clean_worktree_setup)
assert_contains "$sibling_clean_worktree_root/run/loop.log" 'gated, landed locally'
assert_not_contains "$sibling_clean_worktree_root/run/loop.log" 'left uncommitted changes'

sibling_dirty_worktree_root=$(run_case relative-sibling-dirty-worktree "$sibling_nested_worker" sibling_dirty_worktree_setup)
assert_contains "$sibling_dirty_worktree_root/run/loop.log" 'this child owns cleanup'
assert_not_contains "$sibling_dirty_worktree_root/run/loop.log" 'gated, landed locally'

run_stop_inner_dispatch_case() {
  local root repo state bin run
  root="$TMP_ROOT/stop-inner-dispatch"; repo="$root/repo"; state="$root/state"; bin="$root/bin"; run="$root/run"
  mkdir -p "$state" "$run" "$bin"
  make_repo "$repo"
  printf 'open' > "$state/a-status"
  printf 'open' > "$state/b-status"
  cat > "$bin/bd" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
state="${FAKE_BD_STATE:?}"; cmd="$1"; shift || true
case "$cmd" in
  show)
    child="$1"
    if [ "$child" = epic ]; then
      printf '{"id":"epic","status":"open","title":"Epic","issue_type":"epic","assignee":"","comment_count":0}\n'
    else
      status=$(<"$state/${child}-status"); assignee=$(cat "$state/${child}-assignee" 2>/dev/null || true)
      printf '{"id":"%s","status":"%s","title":"Child %s","issue_type":"task","assignee":"%s","comment_count":0}\n' "$child" "$status" "$child" "$assignee"
    fi
    ;;
  ready) printf '[{"id":"a","title":"Child a"},{"id":"b","title":"Child b"}]\n' ;;
  list) printf '[{"id":"a","status":"%s"},{"id":"b","status":"%s"}]\n' "$(<"$state/a-status")" "$(<"$state/b-status")" ;;
  update)
    child="$1"; shift
    case " $* " in
      *' --assignee '*) args=("$@"); for ((i=0; i<${#args[@]}; i++)); do [ "${args[$i]}" = --assignee ] && printf '%s' "${args[$((i + 1))]}" > "$state/${child}-assignee"; done ;;
      *' --status open '*|*' --claim '*) printf open > "$state/${child}-status" ;;
      *' --status blocked '*) printf blocked > "$state/${child}-status" ;;
    esac
    ;;
  close) printf closed > "$state/$1-status" ;;
  merge-slot|swarm|note|label) ;;
esac
EOF
  chmod +x "$bin/bd"
  cat > "$root/worker.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
touch "$COOKEPIC_RUN_DIR/STOP"
EOF
  chmod +x "$root/worker.sh"
  (
    cd "$repo"
    PATH="$bin:$PATH" FAKE_BD_STATE="$state" COOKEPIC_EPIC=epic COOKEPIC_HARNESS=claude COOKEPIC_WORKER_CMD="$root/worker.sh" \
      COOKEPIC_WORKERS=2 COOKEPIC_GATE=true COOKEPIC_NO_PUSH=1 COOKEPIC_SPAWN_DELAY=1 COOKEPIC_MAX_DISPATCHES=2 \
      COOKEPIC_MAX_ATTEMPTS=2 COOKEPIC_WORKER_TIMEOUT=30 "$RUNNER" "$run"
  ) >"$root/stdout" 2>&1 || true
  printf '%s\n' "$root"
}

stop_dispatch_root=$(run_stop_inner_dispatch_case)
[ "$(grep -c '"event": "dispatched"' "$stop_dispatch_root/run/mailbox.jsonl")" -eq 1 ] \
  || fail 'STOP created during dispatch allowed another worker spawn'
assert_contains "$stop_dispatch_root/run/loop.log" 'STOP file found — draining'

run_upstream_only_case() {
  local root repo state bin run
  root="$TMP_ROOT/upstream-only"; repo="$root/repo"; state="$root/state"; bin="$root/bin"; run="$root/run"
  mkdir -p "$state" "$run"
  make_repo "$repo"; make_fake_tools "$bin"; printf open > "$state/status"
  git -C "$repo" remote add upstream test://upstream-only
  cat > "$root/worker.sh" <<'EOF'
#!/usr/bin/env bash
printf 'local\n' > local.txt
git add local.txt && git commit -qm local
bd close "$COOKEPIC_CHILD"
EOF
  chmod +x "$root/worker.sh"
  (
    cd "$repo"
    PATH="$bin:$PATH" FAKE_BD_STATE="$state" COOKEPIC_EPIC=epic COOKEPIC_HARNESS=claude COOKEPIC_WORKER_CMD="$root/worker.sh" \
      COOKEPIC_SEQUENTIAL=1 COOKEPIC_GATE=true COOKEPIC_NO_PUSH=1 COOKEPIC_SPAWN_DELAY=0 COOKEPIC_MAX_DISPATCHES=1 COOKEPIC_WORKER_TIMEOUT=30 "$RUNNER" "$run"
  ) >"$root/stdout" 2>&1 || true
  printf '%s\n' "$root"
}

upstream_only_root=$(run_upstream_only_case)
assert_contains "$upstream_only_root/run/mailbox.jsonl" '"pushed": false'
assert_contains "$upstream_only_root/run/mailbox.jsonl" '"verified": true'
assert_contains "$upstream_only_root/run/loop.log" 'gated, landed locally'

# Regression guards for coordinator ownership boundaries. The parallel worktree
# root is run-scoped, startup never releases a holder it does not own, and every
# integration trial clears only its coordinator-owned workspace.
assert_contains "$RUNNER" 'WORKTREE_ROOT="$REPO/.worktrees/cook-epic-$RUN_ID"'
assert_contains "$RUNNER" 'refusing existing worker worktree for $child'
assert_not_contains "$RUNNER" 'slot_holder='
assert_contains "$RUNNER" 'git -C "$INTEG_WT" clean -fdx'

run_push_preflight_case() {
  local mode="$1" root repo state bin run expected
  root="$TMP_ROOT/push-preflight-$mode"; repo="$root/repo"; state="$root/state"; bin="$root/bin"; run="$root/run"
  mkdir -p "$state" "$run"; make_repo "$repo"; make_fake_tools "$bin"; printf open > "$state/status"
  expected=2
  case "$mode" in
    no-push) expected=0; touch "$run/STOP" ;;
    zero) export_value=0 ;;
    invalid) export_value=true ;;
    missing-origin) unset export_value ;;
  esac
  set +e
  (
    cd "$repo"
    if [ "$mode" = no-push ]; then
      PATH="$bin:$PATH" FAKE_BD_STATE="$state" COOKEPIC_EPIC=epic COOKEPIC_HARNESS=claude COOKEPIC_WORKER_CMD=true COOKEPIC_SEQUENTIAL=1 COOKEPIC_NO_PUSH=1 COOKEPIC_GATE=true COOKEPIC_MAX_DISPATCHES=1 "$RUNNER" "$run"
    elif [ "$mode" = missing-origin ]; then
      PATH="$bin:$PATH" FAKE_BD_STATE="$state" COOKEPIC_EPIC=epic COOKEPIC_HARNESS=claude COOKEPIC_WORKER_CMD=true COOKEPIC_SEQUENTIAL=1 COOKEPIC_GATE=true COOKEPIC_MAX_DISPATCHES=1 "$RUNNER" "$run"
    else
      PATH="$bin:$PATH" FAKE_BD_STATE="$state" COOKEPIC_EPIC=epic COOKEPIC_HARNESS=claude COOKEPIC_WORKER_CMD=true COOKEPIC_SEQUENTIAL=1 COOKEPIC_NO_PUSH="$export_value" COOKEPIC_GATE=true COOKEPIC_MAX_DISPATCHES=1 "$RUNNER" "$run"
    fi
  ) >"$root/stdout" 2>&1
  rc=$?
  set -e
  [ "$rc" -eq "$expected" ] || fail "$mode preflight exited $rc, expected $expected"
  printf '%s\n' "$root"
}

missing_origin_root=$(run_push_preflight_case missing-origin)
assert_contains "$missing_origin_root/stdout" 'push-enabled run requires an origin remote'
zero_push_root=$(run_push_preflight_case zero)
assert_contains "$zero_push_root/stdout" 'COOKEPIC_NO_PUSH must be exactly 1'
invalid_push_root=$(run_push_preflight_case invalid)
assert_contains "$invalid_push_root/stdout" 'COOKEPIC_NO_PUSH must be exactly 1'
# NO_PUSH=1 reaches the loop in local-only mode; STOP keeps the test finite.
# Its preflight path is covered by every existing no-push sequential regression.

run_rejected_push_case() {
  local mode="$1" root repo sibling state bin run
  root="$TMP_ROOT/rejected-push-$mode"; repo="$root/repo"; sibling="$root/api"; state="$root/state"; bin="$root/bin"; run="$root/run"
  mkdir -p "$state" "$run" "$bin"
  make_repo "$repo"; make_repo "$sibling"; make_fake_tools "$bin"; printf open > "$state/status"
  git -C "$repo" remote add origin test://origin
  git -C "$sibling" remote add origin test://origin
  cat > "$root/worker.sh" <<EOF
#!/usr/bin/env bash
set -euo pipefail
printf 'main\\n' > rejected-main.txt
git add rejected-main.txt && git commit -qm rejected-main
$([ "$mode" = sibling ] && printf "printf 'sibling\\\\n' > ../api/rejected-sibling.txt; git -C ../api add rejected-sibling.txt && git -C ../api commit -qm rejected-sibling" || true)
bd close "\$COOKEPIC_CHILD"
EOF
  chmod +x "$root/worker.sh"
  cat > "$root/push.sh" <<'EOF'
#!/usr/bin/env bash
exit 1
EOF
  chmod +x "$root/push.sh"
  set +e
  (
    cd "$repo"
    PATH="$bin:$PATH" FAKE_BD_STATE="$state" COOKEPIC_EPIC=epic COOKEPIC_HARNESS=claude COOKEPIC_WORKER_CMD="$root/worker.sh" \
      COOKEPIC_SEQUENTIAL=1 COOKEPIC_SIBLINGS="../api" COOKEPIC_GATE=true COOKEPIC_PUSH_CMD="$root/push.sh" COOKEPIC_SPAWN_DELAY=0 COOKEPIC_MAX_DISPATCHES=1 COOKEPIC_WORKER_TIMEOUT=30 "$RUNNER" "$run"
  ) >"$root/stdout" 2>&1
  rc=$?
  set -e
  [ "$rc" -ne 0 ] || fail "rejected $mode push exited successfully"
  printf '%s\n' "$root"
}

rejected_primary_root=$(run_rejected_push_case primary)
assert_contains "$rejected_primary_root/run/loop.log" 'operator must reconcile'
assert_not_contains "$rejected_primary_root/run/loop.log" 'epic complete'
[ "$(<"$rejected_primary_root/state/status")" = closed ] || fail 'rejected primary push reopened or completed the child unexpectedly'

rejected_sibling_root=$(run_rejected_push_case sibling)
assert_contains "$rejected_sibling_root/run/loop.log" 'operator must reconcile'
assert_not_contains "$rejected_sibling_root/run/loop.log" 'epic complete'
[ "$(<"$rejected_sibling_root/state/status")" = closed ] || fail 'rejected sibling push reopened or completed the child unexpectedly'

run_no_gate_reporting_case() {
  local root repo state bin run
  root="$TMP_ROOT/no-gate-reporting"; repo="$root/repo"; state="$root/state"; bin="$root/bin"; run="$root/run"
  mkdir -p "$state" "$run"; make_repo "$repo"; make_fake_tools "$bin"; printf open > "$state/status"
  cat > "$root/worker.sh" <<'EOF'
#!/usr/bin/env bash
printf 'unverified\n' > unverified.txt
git add unverified.txt && git commit -qm unverified
bd close "$COOKEPIC_CHILD"
EOF
  chmod +x "$root/worker.sh"
  (
    cd "$repo"
    PATH="$bin:$PATH" FAKE_BD_STATE="$state" COOKEPIC_EPIC=epic COOKEPIC_HARNESS=claude COOKEPIC_WORKER_CMD="$root/worker.sh" \
      COOKEPIC_SEQUENTIAL=1 COOKEPIC_NO_PUSH=1 COOKEPIC_NO_GATE=1 COOKEPIC_SPAWN_DELAY=0 COOKEPIC_MAX_DISPATCHES=1 COOKEPIC_WORKER_TIMEOUT=30 "$RUNNER" "$run"
  ) >"$root/stdout" 2>&1 || true
  printf '%s\n' "$root"
}

no_gate_root=$(run_no_gate_reporting_case)
assert_contains "$no_gate_root/run/loop.log" 'landed unverified locally'
assert_not_contains "$no_gate_root/run/loop.log" 'gated, landed locally'
assert_contains "$no_gate_root/run/mailbox.jsonl" '"verified": false'

# The inner loop must test the cap before every candidate and every available
# slot, so parallel workers cannot exceed a global cap of one dispatch.
assert_contains "$RUNNER" 'while [ "$slots" -gt 0 ] && [ "$DISPATCHED" -lt "$MAX_DISPATCHES" ]; do'
assert_contains "$RUNNER" '[ "$DISPATCHED" -lt "$MAX_DISPATCHES" ] || break'

run_watcher_format_case() {
  local root run output
  root="$TMP_ROOT/watcher-format"; run="$root/run"; output="$root/output"
  mkdir -p "$run"
  cat > "$run/mailbox.jsonl" <<'EOF'
{"event":"done","child":"new","commits":1,"summary":"new result","verified":false,"pushed":false}
{"event":"merged","child":"pushed","branch":"epic/pushed","commit":"abc123","verified":false,"pushed":true}
{"event":"finished","reason":"complete","dispatched":2,"merged":2,"verified":false,"pushed":false,"total_cost":null}
EOF
  timeout 10 "$SKILL_DIR/watch.sh" "$run" >"$output"
  printf '%s\n' "$root"
}

watcher_root=$(run_watcher_format_case)
assert_contains "$watcher_root/output" 'landed unverified locally'
assert_contains "$watcher_root/output" 'pushed, landed unverified'
assert_contains "$watcher_root/output" 'complete — dispatched 2, landed 2, unverified'

# Older coordinator mailboxes omitted landing/verified; preserve their prior
# gated wording rather than failing or labelling them unverified.
old_watch_root="$TMP_ROOT/watcher-old"; mkdir -p "$old_watch_root/run"
printf '%s\n' '{"event":"merged","child":"old","branch":"epic/old","commit":"def456"}' '{"event":"finished","reason":"old complete","dispatched":1,"merged":1,"total_cost":null}' > "$old_watch_root/run/mailbox.jsonl"
timeout 10 "$SKILL_DIR/watch.sh" "$old_watch_root/run" > "$old_watch_root/output"
assert_contains "$old_watch_root/output" 'gated, landed locally'
assert_contains "$old_watch_root/output" 'old complete — dispatched 1, landed 1, verified'

printf 'cook-epic sequential regression tests passed\n'
