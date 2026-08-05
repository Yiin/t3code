#!/usr/bin/env bash
# Epic run-lock contract tests. Cross-runner on purpose: the whole point of the
# lock is that a cook-epic run and a ralph run cannot both own the same epic in
# the same repo, so both runners are exercised against the same lock file.
# No live agent session is started; every worker is a fixture script.
set -euo pipefail

COOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COOK_RUNNER="$COOK_DIR/run.sh"
RALPH_RUNNER="$(cd "$COOK_DIR/../ralph" && pwd)/run.sh"
TMP_ROOT="$(cd "$(mktemp -d /var/tmp/run-lock-test.XXXXXX)" && pwd -P)"
trap '[ "${COOKEPIC_KEEP_TEST_TMP:-0}" = 1 ] || rm -rf "$TMP_ROOT"' EXIT

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
assert_contains() { grep -Fq -- "$2" "$1" || { sed -n '1,40p' "$1" >&2; fail "expected $1 to contain: $2"; }; }
assert_not_contains() { ! grep -Fq -- "$2" "$1" || fail "expected $1 not to contain: $2"; }
assert_rc() { [ "$1" = "$2" ] || fail "expected exit $2, got $1 ($3)"; }

# Poll rather than sleep: the tests must not depend on how fast a runner starts.
wait_until() { # <timeout secs> <command...>
  local deadline=$(( $(date +%s) + $1 ))
  shift
  until "$@"; do
    [ "$(date +%s)" -lt "$deadline" ] || return 1
    sleep 0.05
  done
}
lock_of() { printf '%s\n' "$1/.beads/run-lock.epic.json"; }
lock_field() { jq -r "$2" "$1" 2>/dev/null; }
heartbeat_after() { # <lock> <epoch> -> 0 once the lock has been refreshed past it
  local hb; hb=$(lock_field "$1" .heartbeatAt) || return 1
  [ -n "$hb" ] && [ "$hb" != null ] && [ "$hb" -gt "$2" ]
}
heartbeat_older_than() { # <lock> <secs>
  local hb; hb=$(lock_field "$1" .heartbeatAt) || return 1
  [ -n "$hb" ] && [ "$hb" != null ] && [ $(( $(date +%s) - hb )) -ge "$2" ]
}
start_ticks_of() { local stat; stat=$(cat "/proc/$1/stat"); awk '{print $20}' <<< "${stat##*') '}"; }

# ------------------------------------------------------------- fixtures ----
make_repo() { # <repo>
  mkdir -p "$1/.beads"
  git init -q -b main "$1"
  git -C "$1" config user.name test
  git -C "$1" config user.email test@example.com
  printf 'base\n' > "$1/base.txt"
  git -C "$1" add .
  git -C "$1" commit -qm base
}

make_bin() { # <bin dir>
  mkdir -p "$1"
  cat > "$1/bd" <<'EOF'
#!/usr/bin/env bash
set -uo pipefail
state="${FAKE_BD_STATE:?}"
cmd="${1:-}"; shift || true
status=$(cat "$state/status" 2>/dev/null || printf open)
case "$cmd" in
  show)
    if [ "${1:-}" = epic ]; then
      printf '{"id":"epic","status":"open","title":"Epic","issue_type":"epic","comment_count":0}\n'
    else
      printf '{"id":"%s","status":"%s","title":"Child","issue_type":"task","assignee":"%s","comment_count":0}\n' \
        "${1:-}" "$status" "$(cat "$state/assignee" 2>/dev/null || true)"
    fi
    ;;
  ready)
    if [ "$status" = open ]; then printf '[{"id":"child","title":"Child"}]\n'; else printf '[]\n'; fi
    ;;
  list)
    if [ "$status" = closed ]; then printf '[]\n'; else printf '[{"id":"child","status":"%s"}]\n' "$status"; fi
    ;;
  update)
    id="${1:-}"; shift || true
    case " $* " in
      *' --assignee '*)
        args=("$@"); for ((i = 0; i < ${#args[@]}; i++)); do [ "${args[$i]}" = --assignee ] && printf '%s' "${args[$((i + 1))]}" > "$state/assignee"; done
        ;;
      *' --claim '*) printf 'claim %s %s\n' "$id" "$*" >> "$state/claims"; printf open > "$state/status" ;;
      *' --status blocked '*) printf 'blocked' > "$state/status" ;;
      *' --status open '*) printf 'open' > "$state/status" ;;
    esac
    ;;
  close) printf closed > "$state/status" ;;
  note) printf '%s\n' "$*" >> "$state/notes" ;;
  *) ;;
esac
exit 0
EOF
  chmod +x "$1/bd"

  # cook-epic worker: sleeps FIXTURE_SLEEP seconds, then commits and closes.
  cat > "$1/worker.sh" <<'EOF'
#!/usr/bin/env bash
set -uo pipefail
sleep "${FIXTURE_SLEEP:-0}"
printf 'work %s\n' "$COOKEPIC_CHILD" >> work.txt
git add work.txt && git commit -qm "child work"
bd close "$COOKEPIC_CHILD"
EOF
  chmod +x "$1/worker.sh"

  # ralph child: same shape, in the Claude JSON the runner parses.
  cat > "$1/claude" <<'EOF'
#!/usr/bin/env bash
set -uo pipefail
sleep "${FIXTURE_SLEEP:-0}"
git commit --allow-empty -qm 'ralph iteration'
jq -cn '{result:"done\nRALPH_MSG: {\"summary\":\"unit\",\"why\":\"reason\"}",session_id:"s",total_cost_usd:0}'
EOF
  chmod +x "$1/claude"
}

new_case() { # <name> -> sets CASE, REPO, BIN, STATE
  CASE="$TMP_ROOT/$1"; REPO="$CASE/repo"; BIN="$CASE/bin"; STATE="$CASE/state"
  mkdir -p "$STATE"
  make_repo "$REPO"
  REPO="$(cd "$REPO" && pwd -P)"
  make_bin "$BIN"
  printf open > "$STATE/status"
}

cook() { # <run dir> <extra env...>; runs from the fixture repo
  local run="$1"; shift
  mkdir -p "$run"
  ( cd "$REPO" && for v in "${!COOKEPIC_@}"; do unset "$v"; done && exec setsid env PATH="$BIN:$PATH" FAKE_BD_STATE="$STATE" \
      COOKEPIC_EPIC=epic COOKEPIC_HARNESS=claude COOKEPIC_WORKER_CMD="$BIN/worker.sh" \
      COOKEPIC_SEQUENTIAL=1 COOKEPIC_GATE=true COOKEPIC_NO_PUSH=1 COOKEPIC_SPAWN_DELAY=0 \
      COOKEPIC_MAX_DISPATCHES=1 COOKEPIC_MAX_ATTEMPTS=1 COOKEPIC_WORKER_TIMEOUT=60 \
      "$@" "$COOK_RUNNER" "$run" )
}

ralph() { # <run dir> <extra env...>; runs from the fixture repo
  local run="$1"; shift
  mkdir -p "$run"
  printf 'Epic: epic\n\nDo one unit of work.\n' > "$run/prompt.md"
  ( cd "$REPO" && for v in "${!COOKEPIC_@}"; do unset "$v"; done && exec setsid env PATH="$BIN:$PATH" FAKE_BD_STATE="$STATE" \
      RALPH_HARNESS=claude RALPH_BIN="$BIN/claude" RALPH_MAX_ITER=1 \
      "$@" "$RALPH_RUNNER" "$run" )
}

plant_lock() { # <lock file> <host> <pid> <heartbeat age secs> [start ticks] [pgid]
  mkdir -p "$(dirname "$1")"
  jq -cn --arg host "$2" --argjson pid "$3" --arg boot "$(cat /proc/sys/kernel/random/boot_id)" \
    --arg ticks "${5:-}" --argjson hb "$(( $(date +%s) - $4 ))" \
    --argjson pgid "${6:-$3}" \
    '{owner:"t3code",host:$host,bootId:$boot,pid:$pid,pgid:$pgid,startTicks:$ticks,
      runDir:"/var/tmp/planted",startedAt:"2026-01-01T00:00:00+00:00",heartbeatAt:$hb}' > "$1"
}

# EXACTLY the interop payload the t3code server writes: no bootId, no
# startTicks. plant_lock's terminal/Linux shape hides field-parsing bugs that
# only bite when a middle field is empty.
plant_lock_minimal() { # <lock file> <host> <pid> <heartbeat age secs>
  mkdir -p "$(dirname "$1")"
  jq -cn --arg host "$2" --argjson pid "$3" --argjson hb "$(( $(date +%s) - $4 ))" \
    '{owner:"t3code",host:$host,pid:$pid,pgid:$pid,runDir:"/var/tmp/planted",
      startedAt:"2026-01-01T00:00:00+00:00",heartbeatAt:$hb}' > "$1"
}

dead_pid() { # a pid that has certainly exited
  local pid
  sleep 0 & pid=$!
  wait "$pid" 2>/dev/null || true
  printf '%s\n' "$pid"
}

# ------------------------------------------------- 1. cook-epic vs cook-epic ----
new_case cook-vs-cook
LOCK=$(lock_of "$REPO")
cook "$CASE/a" FIXTURE_SLEEP=3 > "$CASE/a.out" 2>&1 &
first=$!
wait_until 20 test -e "$LOCK" || fail 'first cook-epic run never took the lock'
rc=0; cook "$CASE/b" > "$CASE/b.out" 2>&1 || rc=$?
assert_rc "$rc" 75 'second concurrent cook-epic run'
assert_contains "$CASE/b.out" '"event":"lock_held"'
assert_contains "$CASE/b.out" '"lock":"'"$LOCK"'"'
[ "$(jq -r 'select(.event == "lock_held") | .runDir' "$CASE/b.out" 2>/dev/null | head -1)" = "$CASE/a" ] \
  || fail 'lock_held did not report the holder run dir'
assert_contains "$CASE/b/mailbox.jsonl" '"lockHeld": true'
wait "$first"
# The blocked run must not have touched the frontier: exactly one claim, by the
# run that owns the lock.
[ "$(wc -l < "$STATE/claims")" -eq 1 ] || fail "blocked run claimed a child: $(cat "$STATE/claims")"
[ ! -e "$CASE/b/prompt-child.md" ] || fail 'blocked run rendered a worker prompt'
[ ! -e "$LOCK" ] || fail 'lock survived a clean cook-epic run'
assert_contains "$STATE/notes" 'terminal run started'
assert_contains "$STATE/notes" 'terminal run finished'
grep -qxF '.beads/run-lock.*' "$REPO/.git/info/exclude" || fail 'lock was not added to .git/info/exclude'

# ------------------------------------------------------- 2. ralph vs ralph ----
new_case ralph-vs-ralph
LOCK=$(lock_of "$REPO")
ralph "$CASE/a" FIXTURE_SLEEP=3 > "$CASE/a.out" 2>&1 &
first=$!
wait_until 20 test -e "$LOCK" || fail 'first ralph run never took the lock'
rc=0; ralph "$CASE/b" > "$CASE/b.out" 2>&1 || rc=$?
assert_rc "$rc" 75 'second concurrent ralph run'
assert_contains "$CASE/b.out" '"event":"lock_held"'
# A blocked loop still has to close its mailbox or the watcher hangs forever.
assert_contains "$CASE/b/mailbox.jsonl" '"status":"finished"'
assert_contains "$CASE/b/mailbox.jsonl" 'already owns'
wait "$first"
[ ! -e "$LOCK" ] || fail 'lock survived a clean ralph run'

# ----------------------------------------------------- 3. cook-epic vs ralph ----
new_case cook-vs-ralph
LOCK=$(lock_of "$REPO")
cook "$CASE/a" FIXTURE_SLEEP=3 > "$CASE/a.out" 2>&1 &
first=$!
wait_until 20 test -e "$LOCK" || fail 'cook-epic never took the lock'
rc=0; ralph "$CASE/b" RALPH_EPIC=epic > "$CASE/b.out" 2>&1 || rc=$?
assert_rc "$rc" 75 'ralph against a cook-epic-held epic'
assert_contains "$CASE/b.out" '"owner":"terminal"'
assert_contains "$CASE/b.out" '"lock":"'"$LOCK"'"'
wait "$first"

# --------------------------------------- 4. dead owner + ancient heartbeat ----
new_case steal-dead
LOCK=$(lock_of "$REPO")
gone=$(dead_pid)
plant_lock "$LOCK" "$HOSTNAME" "$gone" 4000
rc=0; cook "$CASE/a" > "$CASE/a.out" 2>&1 || rc=$?
assert_rc "$rc" 0 'run blocked by a lock whose owner is gone'
assert_contains "$CASE/a/loop.log" 'taking over'
assert_not_contains "$CASE/a.out" 'lock_held'
[ ! -e "$LOCK" ] || fail 'stolen lock was not released at the end of the run'

# ----------------------------------------------- 5. live owner is respected ----
new_case respect-live
LOCK=$(lock_of "$REPO")
sleep 300 & live=$!
plant_lock "$LOCK" "$HOSTNAME" "$live" 4000 "$(start_ticks_of "$live")"
rc=0; cook "$CASE/a" > "$CASE/a.out" 2>&1 || rc=$?
kill "$live" 2>/dev/null || true
assert_rc "$rc" 75 'run against a live owner with an ancient heartbeat'
assert_contains "$CASE/a.out" '"event":"lock_held"'
[ "$(lock_field "$LOCK" .pid)" = "$live" ] || fail 'a live owner lock was overwritten'

# --------------------------- 6. a live worker process group is respected ----
new_case respect-live-pgid
LOCK=$(lock_of "$REPO")
setsid sleep 300 & live_group=$!
gone=$(dead_pid)
plant_lock "$LOCK" "$HOSTNAME" "$gone" 4000 "" "$live_group"
rc=0; cook "$CASE/a" > "$CASE/a.out" 2>&1 || rc=$?
kill -- "-$live_group" 2>/dev/null || true
assert_rc "$rc" 75 'run against a dead coordinator with a live worker process group'
assert_contains "$CASE/a.out" '"event":"lock_held"'
[ "$(lock_field "$LOCK" .pgid)" = "$live_group" ] || fail 'a live process-group lock was overwritten'

# A recycled pid must not bypass that same group check.
new_case respect-live-pgid-recycled-pid
LOCK=$(lock_of "$REPO")
setsid sleep 300 & live_group=$!
plant_lock "$LOCK" "$HOSTNAME" "$$" 4000 "definitely-not-$(start_ticks_of "$$")" "$live_group"
rc=0; cook "$CASE/a" > "$CASE/a.out" 2>&1 || rc=$?
kill -- "-$live_group" 2>/dev/null || true
assert_rc "$rc" 75 'run against a recycled coordinator pid with a live worker process group'
assert_contains "$CASE/a.out" '"event":"lock_held"'

# ------------------------------------------- 7. another host is never stolen ----
new_case respect-other-host
LOCK=$(lock_of "$REPO")
plant_lock "$LOCK" other-host "$(dead_pid)" 4000
before=$(cat "$LOCK")
rc=0; cook "$CASE/a" > "$CASE/a.out" 2>&1 || rc=$?
assert_rc "$rc" 75 'run against a dead-looking lock from another host'
assert_contains "$CASE/a.out" '"host":"other-host"'
[ "$(cat "$LOCK")" = "$before" ] || fail 'another host lock was modified'
rm -f "$LOCK"

# ------------------------------------------------- 8. the heartbeat refreshes ----
new_case heartbeat
LOCK=$(lock_of "$REPO")
cook "$CASE/a" FIXTURE_SLEEP=6 RUNLOCK_HEARTBEAT_SECS=1 RUNLOCK_STALE_SECS=4 > "$CASE/a.out" 2>&1 &
first=$!
wait_until 20 test -e "$LOCK" || fail 'run never took the lock'
hb0=$(lock_field "$LOCK" .heartbeatAt)
[ -n "$hb0" ] || fail 'lock has no heartbeatAt'
wait_until 15 heartbeat_after "$LOCK" "$hb0" || fail 'heartbeatAt never advanced'
# A refreshed lock is still held, however old the run gets.
rc=0; cook "$CASE/b" RUNLOCK_HEARTBEAT_SECS=1 RUNLOCK_STALE_SECS=4 > "$CASE/b.out" 2>&1 || rc=$?
assert_rc "$rc" 75 'run against a heartbeating lock'
wait "$first"
[ ! -e "$LOCK" ] || fail 'lock survived the heartbeating run'

# ------------------------------- 9. SIGKILL: no orphan keeps the lock fresh ----
new_case killed-owner
LOCK=$(lock_of "$REPO")
cook "$CASE/a" FIXTURE_SLEEP=20 RUNLOCK_HEARTBEAT_SECS=1 RUNLOCK_STALE_SECS=3 > "$CASE/a.out" 2>&1 &
first=$!
wait_until 20 test -e "$LOCK" || fail 'run never took the lock'
kill -9 "$(lock_field "$LOCK" .pid)"
wait "$first" 2>/dev/null || true
# The heartbeat subshell is orphaned, not killed. If it kept refreshing, the
# lock would never age out and the epic would be locked out forever.
wait_until 15 heartbeat_older_than "$LOCK" 4 || fail 'an orphaned heartbeat kept refreshing a dead run lock'
rc=0; cook "$CASE/b" RUNLOCK_HEARTBEAT_SECS=1 RUNLOCK_STALE_SECS=3 > "$CASE/b.out" 2>&1 || rc=$?
assert_rc "$rc" 0 'run after the previous owner was SIGKILLed'
assert_contains "$CASE/b/loop.log" 'taking over'
[ ! -e "$LOCK" ] || fail 'lock left behind after the takeover run'

# -------------------------------------- 10. a post-acquire die releases too ----
new_case die-after-acquire
LOCK=$(lock_of "$REPO")
git -C "$REPO" branch cook-epic-integration-a
rc=0; cook "$CASE/a" COOKEPIC_SEQUENTIAL=0 > "$CASE/a.out" 2>&1 || rc=$?
assert_rc "$rc" 2 'cook-epic dying on an existing integration branch'
assert_contains "$CASE/a.out" 'integration branch already exists'
[ ! -e "$LOCK" ] || fail 'a die() after acquire leaked the lock'

# ------------------------------------------------- 11. STOP-file shutdown ----
new_case stop-file
LOCK=$(lock_of "$REPO")
mkdir -p "$CASE/a"; touch "$CASE/a/STOP"
rc=0; cook "$CASE/a" > "$CASE/a.out" 2>&1 || rc=$?
assert_rc "$rc" 0 'cook-epic stopped by its STOP file'
[ ! -e "$LOCK" ] || fail 'STOP-file shutdown leaked the lock'

# -------------------------------------------------------- 12. signal paths ----
for signal in TERM INT; do
  new_case "signal-$signal-cook"
  LOCK=$(lock_of "$REPO")
  cook "$CASE/a" FIXTURE_SLEEP=2 > "$CASE/a.out" 2>&1 &
  first=$!
  wait_until 20 test -e "$LOCK" || fail "cook-epic never took the lock ($signal)"
  kill "-$signal" "$(lock_field "$LOCK" .pid)"
  wait "$first" 2>/dev/null || true
  wait_until 20 test ! -e "$LOCK" || fail "SIG$signal leaked the cook-epic lock"

  new_case "signal-$signal-ralph"
  LOCK=$(lock_of "$REPO")
  ralph "$CASE/a" FIXTURE_SLEEP=3 > "$CASE/a.out" 2>&1 &
  first=$!
  wait_until 20 test -e "$LOCK" || fail "ralph never took the lock ($signal)"
  kill "-$signal" "$(lock_field "$LOCK" .pid)"
  wait "$first" 2>/dev/null || true
  wait_until 20 test ! -e "$LOCK" || fail "SIG$signal leaked the ralph lock"
done

# ------------------------------- 13. worktree runs share the parent's lock ----
# A cook-epic worktree carries only a .beads redirect stub. Without following it
# a worktree run would take a second, useless lock for the same epic.
new_case worktree-redirect
LOCK=$(lock_of "$REPO")
git -C "$REPO" worktree add -q "$CASE/wt" -b side
mkdir -p "$CASE/wt/.beads"
printf '%s' "$(realpath --relative-to="$CASE/wt" "$REPO/.beads")" > "$CASE/wt/.beads/redirect"
cook "$CASE/a" FIXTURE_SLEEP=3 > "$CASE/a.out" 2>&1 &
first=$!
wait_until 20 test -e "$LOCK" || fail 'main-checkout run never took the lock'
rc=0
mkdir -p "$CASE/b"
printf 'Epic: epic\n\nDo one unit of work.\n' > "$CASE/b/prompt.md"
( cd "$CASE/wt" && exec env PATH="$BIN:$PATH" FAKE_BD_STATE="$STATE" \
    RALPH_HARNESS=claude RALPH_BIN="$BIN/claude" RALPH_MAX_ITER=1 RALPH_EPIC=epic \
    "$RALPH_RUNNER" "$CASE/b" ) > "$CASE/b.out" 2>&1 || rc=$?
assert_rc "$rc" 75 'worktree run against a main-checkout lock'
assert_contains "$CASE/b.out" '"lock":"'"$LOCK"'"'
wait "$first"

# ------------------------- 14. the t3code payload (no bootId/startTicks) ----
# The whole reason the lock exists is a t3code EpicRunner and a terminal run
# racing for one epic, and t3code writes neither bootId nor startTicks.

# 13a. live owner, heartbeat one second old -> plainly held.
new_case interop-live-fresh
LOCK=$(lock_of "$REPO")
sleep 300 & live=$!
plant_lock_minimal "$LOCK" "$HOSTNAME" "$live" 1
before=$(cat "$LOCK")
rc=0; cook "$CASE/a" > "$CASE/a.out" 2>&1 || rc=$?
kill "$live" 2>/dev/null || true
assert_rc "$rc" 75 'run against a live t3code lock with a fresh heartbeat'
assert_contains "$CASE/a.out" '"event":"lock_held"'
assert_contains "$CASE/a.out" '"owner":"t3code"'
[ "$(cat "$LOCK")" = "$before" ] || fail 'a live t3code lock was modified'

# 13b. live owner, ancient heartbeat. Without startTicks, pid liveness is the
# ONLY thing standing between this lock and a steal.
new_case interop-live-stale-hb
LOCK=$(lock_of "$REPO")
sleep 300 & live=$!
plant_lock_minimal "$LOCK" "$HOSTNAME" "$live" 4000
before=$(cat "$LOCK")
rc=0; cook "$CASE/a" > "$CASE/a.out" 2>&1 || rc=$?
kill "$live" 2>/dev/null || true
assert_rc "$rc" 75 'run against a live t3code lock whose heartbeat went stale'
assert_contains "$CASE/a.out" '"event":"lock_held"'
[ "$(cat "$LOCK")" = "$before" ] || fail 'a live t3code lock was stolen on heartbeat age alone'
[ ! -s "$STATE/claims" ] || fail "blocked run claimed a child: $(cat "$STATE/claims")"

# 13c. dead owner, ancient heartbeat -> stolen, same as the terminal shape.
new_case interop-dead
LOCK=$(lock_of "$REPO")
plant_lock_minimal "$LOCK" "$HOSTNAME" "$(dead_pid)" 4000
rc=0; cook "$CASE/a" > "$CASE/a.out" 2>&1 || rc=$?
assert_rc "$rc" 0 'run against a dead t3code lock'
assert_contains "$CASE/a/loop.log" 'taking over'
assert_not_contains "$CASE/a.out" 'lock_held'
[ ! -e "$LOCK" ] || fail 'stolen t3code lock was not released at the end of the run'

# --------------------------------- 15. malformed locks are judged by mtime ----
# A half-written lock must not wedge the epic forever, but a fresh one is a
# write in progress and has to be respected.
new_case malformed-fresh
LOCK=$(lock_of "$REPO")
mkdir -p "$(dirname "$LOCK")"
printf '{"owner":"t3co' > "$LOCK"
before=$(cat "$LOCK")
rc=0; cook "$CASE/a" > "$CASE/a.out" 2>&1 || rc=$?
assert_rc "$rc" 75 'run against a freshly written malformed lock'
assert_contains "$CASE/a.out" '"event":"lock_held"'
[ "$(cat "$LOCK")" = "$before" ] || fail 'a fresh malformed lock was modified'

new_case malformed-old
LOCK=$(lock_of "$REPO")
mkdir -p "$(dirname "$LOCK")"
printf 'not json at all\n' > "$LOCK"
touch -d '2 hours ago' "$LOCK"
rc=0; cook "$CASE/a" > "$CASE/a.out" 2>&1 || rc=$?
assert_rc "$rc" 0 'run against a stale malformed lock'
assert_contains "$CASE/a/loop.log" 'taking over'
[ ! -e "$LOCK" ] || fail 'stolen malformed lock was not released at the end of the run'

# ------------------- 16. lock wins over dirty-check failures in contenders ----
new_case lock-before-preflight
LOCK=$(lock_of "$REPO")
setsid sleep 300 & live=$!
plant_lock "$LOCK" "$HOSTNAME" "$live" 1 "$(start_ticks_of "$live")" "$live"
printf 'dirty\n' >> "$REPO/base.txt"
rc=0; cook "$CASE/a" > "$CASE/a.out" 2>&1 || rc=$?
git -C "$REPO" restore base.txt
kill -- "-$live" 2>/dev/null || true
assert_rc "$rc" 75 'lock-held contender with a dirty checkout'
assert_contains "$CASE/a.out" '"event":"lock_held"'
assert_not_contains "$CASE/a.out" 'working tree has uncommitted changes'

# ----------------------- 17. concurrent stale contenders have one winner ----
new_case concurrent-stale-takeover
LOCK=$(lock_of "$REPO")
plant_lock "$LOCK" "$HOSTNAME" "$(dead_pid)" 4000
set +e
cook "$CASE/a" FIXTURE_SLEEP=3 > "$CASE/a.out" 2>&1 &
a_pid=$!
cook "$CASE/b" FIXTURE_SLEEP=3 > "$CASE/b.out" 2>&1 &
b_pid=$!
wait "$a_pid"; a_rc=$?
wait "$b_pid"; b_rc=$?
set -e
if [ "$a_rc" -eq 0 ]; then
  assert_rc "$b_rc" 75 'second concurrent stale-lock contender'
elif [ "$b_rc" -eq 0 ]; then
  assert_rc "$a_rc" 75 'second concurrent stale-lock contender'
else
  fail "expected one stale-lock contender to win, got rc=$a_rc and rc=$b_rc"
fi
[ "$(wc -l < "$STATE/claims")" -eq 1 ] || fail "both stale-lock contenders claimed work: $(cat "$STATE/claims")"

printf 'cook-epic/ralph run-lock tests passed\n'
