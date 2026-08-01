#!/usr/bin/env bash
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNNER="$SKILL_DIR/run.sh"
TMP_ROOT="$(mktemp -d /var/tmp/cook-epic-fallback-test.XXXXXX)"
COORDINATORS=()

cleanup() {
  local pid identity pgid
  for pid in "${COORDINATORS[@]}"; do
    kill -KILL "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  done
  for identity in "$TMP_ROOT"/*/run/*.owned; do
    [ -f "$identity" ] || continue
    read -r _ _ pgid < "$identity" || continue
    [[ "$pgid" =~ ^[1-9][0-9]*$ ]] && kill -KILL -- "-$pgid" 2>/dev/null || true
  done
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
assert_contains() { grep -Fq -- "$2" "$1" || fail "expected $1 to contain: $2"; }

assert_group_gone() { # <pgid>
  local pgid="$1" deadline=$((SECONDS + 5))
  while ps -eo pgid=,sid=,stat= 2>/dev/null \
      | awk -v pgid="$pgid" '$1 == pgid && $2 == pgid && $3 !~ /^Z/ {found=1} END {exit !found}'; do
    [ "$SECONDS" -lt "$deadline" ] || fail "owned session $pgid survived cleanup"
    sleep 0.05
  done
}

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
  cat > "$bin/bd" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
state="${FAKE_BD_STATE:?}"; cmd="$1"; shift || true
case "$cmd" in
  show)
    id="$1"
    if [ "$id" = epic ]; then
      printf '{"id":"epic","status":"%s","title":"Epic","issue_type":"epic","comment_count":0}\n' "$(<"$state/epic")"
    else
      printf '{"id":"child","status":"%s","title":"Fallback child","issue_type":"task","assignee":"%s","comment_count":0}\n' \
        "$(<"$state/child")" "$(cat "$state/assignee" 2>/dev/null || true)"
    fi
    ;;
  ready) [ "$(<"$state/child")" = open ] && printf '[{"id":"child","title":"Fallback child"}]\n' || printf '[]\n' ;;
  list) [ "$(<"$state/child")" = closed ] || [ "$(<"$state/child")" = blocked ] && printf '[]\n' || printf '[{"id":"child","status":"%s"}]\n' "$(<"$state/child")" ;;
  update)
    id="$1"; shift
    case " $* " in
      *' --assignee '*) args=("$@"); for ((i=0;i<${#args[@]};i++)); do [ "${args[$i]}" = --assignee ] && printf '%s' "${args[$((i+1))]}" > "$state/assignee"; done ;;
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

make_case() { # <name> <worker body> <inspector body>
  local name="$1" worker_body="$2" inspector_body="$3"
  CASE_ROOT="$TMP_ROOT/$name"
  CASE_REPO="$CASE_ROOT/repo"
  CASE_STATE="$CASE_ROOT/state"
  CASE_BIN="$CASE_ROOT/bin"
  CASE_RUN="$CASE_ROOT/run"
  mkdir -p "$CASE_STATE" "$CASE_RUN"
  make_repo "$CASE_REPO"
  make_bd "$CASE_BIN"
  printf open > "$CASE_STATE/child"
  printf open > "$CASE_STATE/epic"
  printf '%s\n' "$worker_body" > "$CASE_ROOT/worker.sh"
  chmod +x "$CASE_ROOT/worker.sh"
  INSPECTOR_ARG=()
  if [ -n "$inspector_body" ]; then
    printf '%s\n' "$inspector_body" > "$CASE_ROOT/inspector.sh"
    chmod +x "$CASE_ROOT/inspector.sh"
    INSPECTOR_ARG=(COOKEPIC_INSPECTOR_CMD="$CASE_ROOT/inspector.sh")
  fi
  RUNNER_ARGS=(env PATH="$CASE_BIN:$PATH" FAKE_BD_STATE="$CASE_STATE" \
    COOKEPIC_EPIC=epic COOKEPIC_HARNESS=claude COOKEPIC_WORKER_CMD="$CASE_ROOT/worker.sh" \
    COOKEPIC_SEQUENTIAL=1 COOKEPIC_GATE=true COOKEPIC_NO_PUSH=1 COOKEPIC_DISABLE_SYSTEMD=1 \
    COOKEPIC_SPAWN_DELAY=0 COOKEPIC_MAX_DISPATCHES=1 COOKEPIC_MAX_ATTEMPTS=1 \
    COOKEPIC_IDLE_THRESHOLD=1 COOKEPIC_INSPECTOR_TIMEOUT=10 COOKEPIC_INSPECT_RETRY_DELAY=1 \
    COOKEPIC_INSPECT_MIN_DELAY=1 COOKEPIC_INSPECT_MAX_DELAY=2 COOKEPIC_STOP_GRACE=1 \
    COOKEPIC_SUPERVISION_TICK=1 "${INSPECTOR_ARG[@]}" "$RUNNER" "$CASE_RUN")
}

finish_worker='#!/usr/bin/env bash
set -euo pipefail
printf "%s" "$$" > "$COOKEPIC_RUN_DIR/actual-worker-pid"
sleep 3
printf "done\n" > result.txt
git add result.txt
git commit -qm done
bd close "$COOKEPIC_CHILD"'
continue_inspector='#!/usr/bin/env bash
set -euo pipefail
printf '\''{"decision":"continue","confidence":"high","rationale":"silent sleep is idle","next_check_seconds":2}\n'\'' > "$2"'

make_case silent-inspection "$finish_worker" "$continue_inspector"
(cd "$CASE_REPO" && timeout --kill-after=2s 15s "${RUNNER_ARGS[@]}") > "$CASE_ROOT/stdout" 2>&1 || fail 'silent fallback run did not finish'
assert_contains "$CASE_RUN/mailbox.jsonl" '"event": "worker-idle"'
assert_contains "$CASE_RUN/mailbox.jsonl" '"event": "inspection-started"'
read -r worker_pid _ worker_pgid < "$CASE_RUN/worker-w1.owned"
[ "$worker_pid" = "$(<"$CASE_RUN/actual-worker-pid")" ] || fail 'recorded worker PID is not the actual command leader'
[ "$worker_pid" = "$worker_pgid" ] || fail 'worker command is not its process-group leader'
assert_group_gone "$worker_pgid"

quick_worker='#!/usr/bin/env bash
set -euo pipefail
printf "done\n" > result.txt
git add result.txt
git commit -qm done
bd close "$COOKEPIC_CHILD"'
make_case fifo-close "$quick_worker" ''
(cd "$CASE_REPO" && timeout --kill-after=2s 10s "${RUNNER_ARGS[@]}") > "$CASE_ROOT/stdout" 2>&1 || fail 'completed command left its capture path blocked'
[ ! -e "$CASE_RUN/worker-child.log.pipe" ] || fail 'worker FIFO survived command completion'

tree_worker='#!/usr/bin/env bash
trap "" TERM INT HUP
(trap "" TERM INT HUP; printf "%s" "$BASHPID" > "$COOKEPIC_RUN_DIR/worker-child-pid"; exec sleep 30) &
wait'
stop_inspector='#!/usr/bin/env bash
set -euo pipefail
printf '\''{"decision":"stop","confidence":"high","rationale":"confirmed idle worker"}\n'\'' > "$2"'
make_case descendant-kill "$tree_worker" "$stop_inspector"
(cd "$CASE_REPO" && timeout --kill-after=2s 15s "${RUNNER_ARGS[@]}") > "$CASE_ROOT/stdout" 2>&1 || true
[ -f "$CASE_RUN/worker-child-pid" ] || fail 'TERM-ignoring worker descendant did not start'
read -r _ _ worker_pgid < "$CASE_RUN/worker-w1.owned"
assert_group_gone "$worker_pgid"

idle_worker='#!/usr/bin/env bash
trap "" TERM INT HUP
sleep 30'
cleanup_inspector='#!/usr/bin/env bash
trap "" TERM INT HUP
(trap "" TERM INT HUP; printf "%s" "$BASHPID" > "$COOKEPIC_RUN_DIR/inspector-child-pid"; exec sleep 30) &
wait'
make_case coordinator-cleanup "$idle_worker" "$cleanup_inspector"
(
  cd "$CASE_REPO"
  exec "${RUNNER_ARGS[@]}"
) > "$CASE_ROOT/stdout" 2>&1 &
coordinator=$!
COORDINATORS+=("$coordinator")
deadline=$((SECONDS + 10))
while [ ! -f "$CASE_RUN/inspector-child-pid" ] && [ "$SECONDS" -lt "$deadline" ]; do sleep 0.05; done
[ -f "$CASE_RUN/inspector-child-pid" ] || fail 'fallback inspector did not start'
read -r _ _ worker_pgid < "$CASE_RUN/worker-w1.owned"
read -r _ _ inspector_pgid < "$CASE_RUN/inspector-w1.owned"
kill -HUP "$coordinator"
wait "$coordinator" 2>/dev/null || true
COORDINATORS=()
assert_group_gone "$worker_pgid"
assert_group_gone "$inspector_pgid"

printf 'cook-epic fallback session regression tests passed\n'
