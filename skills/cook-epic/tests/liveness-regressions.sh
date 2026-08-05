#!/usr/bin/env bash
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNNER="$SKILL_DIR/run.sh"
TMP_ROOT="$(mktemp -d /var/tmp/cook-epic-liveness-test.XXXXXX)"
trap '[ "${COOKEPIC_KEEP_TEST_TMP:-0}" = 1 ] || rm -rf "$TMP_ROOT"' EXIT

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
assert_contains() { grep -Fq -- "$2" "$1" || fail "expected $1 to contain: $2"; }
assert_not_contains() { ! grep -Fq -- "$2" "$1" || fail "expected $1 not to contain: $2"; }
event_count() { jq -r --arg event "$2" 'select(.event == $event) | .event' "$1" | wc -l; }
assert_process_gone() {
  local pid="$1" state
  state=$(ps -o stat= -p "$pid" 2>/dev/null | tr -d ' ') || state=''
  [ -z "$state" ] || [[ "$state" == Z* ]] || fail "process $pid survived owned-group cleanup with state $state"
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
      printf '{"id":"child","status":"%s","title":"Liveness child","issue_type":"task","assignee":"%s","comment_count":0}\n' \
        "$(<"$state/child")" "$(cat "$state/assignee" 2>/dev/null || true)"
    fi
    ;;
  ready) [ "$(<"$state/child")" = open ] && printf '[{"id":"child","title":"Liveness child"}]\n' || printf '[]\n' ;;
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
  if [ -n "${MAKE_GIT_CAPTURE:-}" ]; then
    cat > "$bin/git" <<'EOF'
#!/usr/bin/env bash
case " $* " in
  *' --porcelain=v1 '*) printf 'parent=%s argv=%s\n' "$(ps -o comm= -p "$PPID" | tr -d ' ')" "$*" >> "$MAKE_GIT_CAPTURE" ;;
esac
exec /usr/bin/git "$@"
EOF
    chmod +x "$bin/git"
  fi
}

make_inspector() { # <path> <mode>
  local path="$1" mode="$2"
  cat > "$path" <<EOF
#!/usr/bin/env bash
set -euo pipefail
prompt="\$1"; result="\$2"
case "$mode" in
  continue) printf '%s\n' '{"decision":"continue","confidence":"high","rationale":"silent command is expected","next_check_seconds":2}' > "\$result" ;;
  stop)
    count=0; [ -f "\$COOKEPIC_RUN_DIR/inspect-count" ] && count=\$(<"\$COOKEPIC_RUN_DIR/inspect-count")
    count=\$((count + 1)); printf '%s' "\$count" > "\$COOKEPIC_RUN_DIR/inspect-count"
    printf '%s\n' '{"decision":"stop","confidence":"high","rationale":"sleeping worker has no active work"}' > "\$result"
    ;;
  uncertain) printf '%s\n' '{"decision":"uncertain","confidence":"low","rationale":"evidence is incomplete","next_check_seconds":1}' > "\$result" ;;
  low-stop) printf '%s\n' '{"decision":"stop","confidence":"medium","rationale":"possible wait with weak evidence"}' > "\$result" ;;
  malformed) printf 'not json\n' > "\$result" ;;
  failure) exit 7 ;;
  timeout) sleep 5 ;;
  delayed-stop) sleep 2; printf '%s\n' '{"decision":"stop","confidence":"high","rationale":"snapshot looked idle"}' > "\$result" ;;
  capture-evidence)
    cp -f "\$prompt" "\$COOKEPIC_RUN_DIR/captured-inspector-prompt"
    printf '%s\n' '{"decision":"continue","confidence":"high","rationale":"structural activity is safe","next_check_seconds":2}' > "\$result"
    ;;
  schema-sequence)
    count=0; [ -f "\$COOKEPIC_RUN_DIR/schema-count" ] && count=\$(<"\$COOKEPIC_RUN_DIR/schema-count")
    count=\$((count + 1)); printf '%s' "\$count" > "\$COOKEPIC_RUN_DIR/schema-count"
    case "\$count" in
      1) printf '%s\n' '[]' > "\$result" ;;
      2) printf '%s\n' '{"decision":"continue"}' > "\$result" ;;
      3) printf '%s\n' '{"decision":"continue","confidence":"high","rationale":"extra","extra":true}' > "\$result" ;;
      4) printf '%s\n' '{"decision":"continue","confidence":"high","rationale":"   "}' > "\$result" ;;
      5) printf '%s\n' '{"decision":"halt","confidence":"high","rationale":"bad decision"}' > "\$result" ;;
      6) printf '%s\n' '{"decision":"continue","confidence":"certain","rationale":"bad confidence"}' > "\$result" ;;
      7) printf '%s\n' '{"decision":"continue","confidence":"high","rationale":"fractional","next_check_seconds":1.5}' > "\$result" ;;
      8) printf '%s\n' '{"decision":"continue","confidence":"high","rationale":"negative","next_check_seconds":-1}' > "\$result" ;;
      9) printf '%s\n%s\n' '{"decision":"continue","confidence":"high","rationale":"first"}' '{"decision":"stop","confidence":"high","rationale":"second"}' > "\$result" ;;
      *) printf '%s\n' '{"decision":"continue","confidence":"high","rationale":"schema sequence complete","next_check_seconds":1}' > "\$result" ;;
    esac
    ;;
  storage)
    for i in {1..500}; do printf 'raw-inspector-line-%04d-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\n' "\$i"; done
    for i in {1..500}; do printf 'invalid-result-line-%04d-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\n' "\$i"; done > "\$result"
    ;;
  overflow-stop)
    for i in {1..500}; do printf 'discarded-result-line-%04d-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\n' "\$i"; done > "\$result"
    printf '%s\n' '{"decision":"stop","confidence":"high","rationale":"truncated prefix must remain invalid"}' >> "\$result"
    ;;
  bounded)
    count=0; [ -f "\$COOKEPIC_RUN_DIR/inspect-count" ] && count=\$(<"\$COOKEPIC_RUN_DIR/inspect-count")
    count=\$((count + 1)); printf '%s' "\$count" > "\$COOKEPIC_RUN_DIR/inspect-count"
    if [ "\$count" -eq 1 ]; then
      printf '%s\n' '{"decision":"continue","confidence":"high","rationale":"wait once","next_check_seconds":999}' > "\$result"
    else
      printf '%s\n' '{"decision":"stop","confidence":"high","rationale":"second check found no work"}' > "\$result"
    fi
    ;;
  cleanup)
    printf '%s' "\$\$" > "\$COOKEPIC_RUN_DIR/inspector-pid"
    (trap '' TERM INT HUP; printf '%s' "\$BASHPID" > "\$COOKEPIC_RUN_DIR/inspector-child-pid"; while true; do sleep 1; done) &
    trap 'touch "\$COOKEPIC_RUN_DIR/inspector-cleaned"; exit 143' TERM INT HUP
    wait
    ;;
  immutable)
    pwd > "\$COOKEPIC_RUN_DIR/inspector-cwd"
    GIT_OPTIONAL_LOCKS=0 git -C "\$TEST_REPO" status --porcelain > "\$COOKEPIC_RUN_DIR/status-during-inspection"
    printf '%s\n' '{"decision":"continue","confidence":"high","rationale":"checkout stayed unchanged","next_check_seconds":2}' > "\$result"
    ;;
esac
EOF
  chmod +x "$path"
}

run_case() { # <name> <worker body> <inspector mode> [timeout] [extra env...]
  local name="$1" worker_body="$2" inspector_mode="$3" worker_timeout="${4:-}"
  if [ "$#" -ge 4 ]; then shift 4; else set --; fi
  local root="$TMP_ROOT/$name" repo="$TMP_ROOT/$name/repo" state="$TMP_ROOT/$name/state"
  local bin="$TMP_ROOT/$name/bin" run="$TMP_ROOT/$name/run" rc=0
  mkdir -p "$state" "$run"
  make_repo "$repo"; make_bd "$bin"
  printf open > "$state/child"; printf open > "$state/epic"
  printf '%s\n' "$worker_body" > "$root/worker.sh"; chmod +x "$root/worker.sh"
  inspector=''
  if [ -n "$inspector_mode" ]; then inspector="$root/inspector.sh"; make_inspector "$inspector" "$inspector_mode"; fi
  (
    cd "$repo"
    for v in "${!COOKEPIC_@}"; do unset "$v"; done
    env PATH="$bin:$PATH" FAKE_BD_STATE="$state" TEST_REPO="$repo" \
      COOKEPIC_EPIC=epic COOKEPIC_HARNESS=claude COOKEPIC_WORKER_CMD="$root/worker.sh" \
      COOKEPIC_INSPECTOR_CMD="$inspector" COOKEPIC_SEQUENTIAL=1 COOKEPIC_GATE=true COOKEPIC_NO_PUSH=1 \
      COOKEPIC_SPAWN_DELAY=0 COOKEPIC_MAX_DISPATCHES=1 COOKEPIC_MAX_ATTEMPTS=1 \
      COOKEPIC_IDLE_THRESHOLD=2 COOKEPIC_INSPECTOR_TIMEOUT=1 COOKEPIC_INSPECT_RETRY_DELAY=1 \
      COOKEPIC_INSPECT_MIN_DELAY=1 COOKEPIC_INSPECT_MAX_DELAY=2 COOKEPIC_STOP_GRACE=1 \
      COOKEPIC_SUPERVISION_TICK=1 ${worker_timeout:+COOKEPIC_WORKER_TIMEOUT=$worker_timeout} "$@" \
      "$RUNNER" "$run"
  ) > "$root/stdout" 2>&1 || rc=$?
  printf '%s' "$rc" > "$root/rc"
  printf '%s\n' "$root"
}

make_harness_stub() { # <path>
  cat > "$1" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
kind=worker
for arg in "$@"; do [[ "$arg" == *'liveness inspector'* ]] && kind=inspector; done
argv="$COOKEPIC_RUN_DIR/$TEST_HARNESS-$kind.argv"
: > "$argv"
for arg in "$@"; do
  if [ -z "$arg" ]; then printf '<EMPTY>\n' >> "$argv"
  elif [ "${#arg}" -gt 500 ]; then printf '<PROMPT>\n' >> "$argv"
  else printf '%s\n' "$arg" >> "$argv"; fi
done
if [ "$kind" = inspector ]; then
  [ -z "${OPENCODE_CONFIG_CONTENT:-}" ] || printf '%s\n' "$OPENCODE_CONFIG_CONTENT" > "$COOKEPIC_RUN_DIR/opencode-inspector-config.json"
  if [ "$TEST_HARNESS" = opencode ]; then
    printf '%s\n' '{"part":{"text":"{\"decision\":\"continue\",\"confidence\":\"high\",\"rationale\":\"captured no-tool invocation\",\"next_check_seconds\":1}"}}'
  else
    printf '%s\n' '{"decision":"continue","confidence":"high","rationale":"captured no-tool invocation","next_check_seconds":1}'
  fi
  exit 0
fi
if [ "${TEST_COST_EARLY:-0}" = 1 ] && [ "$TEST_HARNESS" = claude ]; then
  printf '%s\n' '{"type":"result","total_cost_usd":1.25,"result":"early"}'
fi
if [ "${TEST_LARGE_OUTPUT:-0}" = 1 ]; then
  for i in {1..5000}; do printf '{"type":"noise","sequence":%s,"payload":"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"}\n' "$i"; done
fi
sleep 4
printf 'done\n' > harness-result.txt
git add harness-result.txt
git commit -qm done
bd close "$COOKEPIC_CHILD"
if [ "$TEST_HARNESS" = claude ] && [ "${TEST_COST_EARLY:-0}" != 1 ]; then
  printf '%s\n' '{"type":"result","total_cost_usd":1.25,"result":"done"}'
fi
EOF
  chmod +x "$1"
}

run_harness_case() { # <name> <harness> [extra env...]
  local name="$1" harness="$2"; shift 2
  local root="$TMP_ROOT/$name" rc=0
  local repo="$root/repo" state="$root/state" bin="$root/bin" run="$root/run"
  mkdir -p "$state" "$run"
  make_repo "$repo"; make_bd "$bin"; make_harness_stub "$root/harness"
  printf open > "$state/child"; printf open > "$state/epic"
  (
    cd "$repo"
    for v in "${!COOKEPIC_@}"; do unset "$v"; done
    env PATH="$bin:$PATH" FAKE_BD_STATE="$state" TEST_HARNESS="$harness" \
      COOKEPIC_EPIC=epic COOKEPIC_HARNESS="$harness" COOKEPIC_BIN="$root/harness" \
      COOKEPIC_SEQUENTIAL=1 COOKEPIC_GATE=true COOKEPIC_NO_PUSH=1 COOKEPIC_SPAWN_DELAY=0 \
      COOKEPIC_MAX_DISPATCHES=1 COOKEPIC_MAX_ATTEMPTS=1 COOKEPIC_IDLE_THRESHOLD=1 \
      COOKEPIC_INSPECTOR_TIMEOUT=3 COOKEPIC_INSPECT_RETRY_DELAY=1 COOKEPIC_INSPECT_MIN_DELAY=1 \
      COOKEPIC_INSPECT_MAX_DELAY=2 COOKEPIC_STOP_GRACE=1 COOKEPIC_SUPERVISION_TICK=1 "$@" \
      "$RUNNER" "$run"
  ) > "$root/stdout" 2>&1 || rc=$?
  [ "$rc" -eq 0 ] || fail "$harness capturing run failed with rc=$rc"
  assert_contains "$run/mailbox.jsonl" '"event": "done"'
  printf '%s\n' "$root"
}

finish_worker='#!/usr/bin/env bash
set -euo pipefail
finish() { printf "done\n" > result.txt; git add result.txt; git commit -qm done; bd close "$COOKEPIC_CHILD"; }
'

output_worker="$finish_worker"'for i in 1 2 3 4 5 6 7 8; do printf "heartbeat %s\n" "$i"; sleep 0.4; done; finish'
output_root=$(run_case output-heartbeat "$output_worker" '')
[ "$(event_count "$output_root/run/mailbox.jsonl" worker-idle)" -eq 0 ] || fail 'regular output was treated as idle'
assert_contains "$output_root/run/mailbox.jsonl" '"event": "done"'

cpu_worker="$finish_worker"'end=$((SECONDS + 4)); while [ "$SECONDS" -lt "$end" ]; do :; done; finish'
cpu_root=$(run_case silent-cpu "$cpu_worker" '')
[ "$(event_count "$cpu_root/run/mailbox.jsonl" worker-idle)" -eq 0 ] || fail 'silent CPU work was treated as idle'

io_worker="$finish_worker"'for i in 1 2 3 4 5 6 7 8; do dd if=/dev/zero of="$COOKEPIC_RUN_DIR/io.bin" bs=65536 count="$i" conv=notrunc status=none; sleep 0.4; done; finish'
cat > "$TMP_ROOT/io-sampler.sh" <<'EOF'
#!/usr/bin/env bash
size=$(stat -c %s "$TEST_IO_PATH" 2>/dev/null || echo 0)
printf '0 %s\n' "$size"
EOF
chmod +x "$TMP_ROOT/io-sampler.sh"
io_root=$(run_case silent-io "$io_worker" '' '' COOKEPIC_RESOURCE_SAMPLER_CMD="$TMP_ROOT/io-sampler.sh" TEST_IO_PATH="$TMP_ROOT/silent-io/run/io.bin")
[ "$(event_count "$io_root/run/mailbox.jsonl" worker-idle)" -eq 0 ] || fail 'silent I/O work was treated as idle'

sleep_worker="$finish_worker"'sleep 5; finish'
continue_root=$(run_case inspector-continue "$sleep_worker" continue)
assert_contains "$continue_root/run/mailbox.jsonl" '"event": "worker-idle"'
assert_contains "$continue_root/run/mailbox.jsonl" '"event": "inspection-continue"'
assert_not_contains "$continue_root/run/mailbox.jsonl" '"event": "inspection-stop"'

idle_worker='#!/usr/bin/env bash
sleep 30
'
stop_root=$(run_case inspector-stop "$idle_worker" stop)
[ "$(<"$stop_root/run/inspect-count")" -eq 2 ] || fail 'worker stopped without two matching stop inspections'
assert_contains "$stop_root/run/mailbox.jsonl" '"event": "inspection-stop-pending"'
assert_contains "$stop_root/run/mailbox.jsonl" '"event": "inspection-stop"'
assert_contains "$stop_root/run/loop.log" 'inspector requested stop: sleeping worker has no active work'

tree_worker='#!/usr/bin/env bash
trap "" TERM INT HUP
(trap "" TERM INT HUP
  printf "%s" "$BASHPID" > "$COOKEPIC_RUN_DIR/worker-child-pid"
  (trap "" TERM INT HUP; printf "%s" "$BASHPID" > "$COOKEPIC_RUN_DIR/worker-grandchild-pid"; while true; do sleep 1; done) &
  wait
) &
wait
'
tree_root=$(run_case inspector-stop-tree "$tree_worker" stop '' COOKEPIC_DISABLE_SYSTEMD=1)
assert_process_gone "$(<"$tree_root/run/worker-child-pid")"
assert_process_gone "$(<"$tree_root/run/worker-grandchild-pid")"

reparent_worker="$finish_worker"'(
  printf "%s" "$BASHPID" > "$COOKEPIC_RUN_DIR/reparented-pid"
  sleep 3
  finish
) &
exit 0'
reparent_root=$(run_case reparented-process-group "$reparent_worker" '' '' COOKEPIC_DISABLE_SYSTEMD=1)
assert_contains "$reparent_root/run/mailbox.jsonl" '"event": "done"'
assert_process_gone "$(<"$reparent_root/run/reparented-pid")"

fork_term_worker='#!/usr/bin/env bash
set -u
trap '\''trap "" TERM; (trap "" TERM; printf "%s" "$BASHPID" > "$COOKEPIC_RUN_DIR/term-child-pid"; while true; do sleep 1; done) &'\'' TERM
sleep 30
'
fork_term_root=$(run_case fork-on-term-cleanup "$fork_term_worker" stop '' COOKEPIC_DISABLE_SYSTEMD=1)
[ -f "$fork_term_root/run/term-child-pid" ] || fail 'TERM handler did not create its child'
assert_process_gone "$(<"$fork_term_root/run/term-child-pid")"

uncertain_root=$(run_case inspector-uncertain "$sleep_worker" uncertain)
assert_contains "$uncertain_root/run/mailbox.jsonl" '"event": "inspection-uncertain"'
assert_contains "$uncertain_root/run/mailbox.jsonl" '"event": "done"'

low_stop_root=$(run_case inspector-low-stop "$sleep_worker" low-stop)
assert_contains "$low_stop_root/run/mailbox.jsonl" 'decision=stop confidence=medium'
assert_not_contains "$low_stop_root/run/mailbox.jsonl" '"event": "inspection-stop"'

malformed_root=$(run_case inspector-malformed "$sleep_worker" malformed)
assert_contains "$malformed_root/run/mailbox.jsonl" 'inspector returned malformed output'

schema_worker="$finish_worker"'sleep 30; finish'
schema_root=$(run_case inspector-schema "$schema_worker" schema-sequence '' COOKEPIC_IDLE_THRESHOLD=1)
[ "$(<"$schema_root/run/schema-count")" -ge 9 ] || fail 'not every malformed schema fixture was inspected'
[ "$(event_count "$schema_root/run/mailbox.jsonl" inspection-uncertain)" -ge 9 ] || fail 'malformed schema stopped reinspection'
assert_not_contains "$schema_root/run/mailbox.jsonl" '"event": "inspection-stop"'
assert_contains "$schema_root/run/mailbox.jsonl" '"event": "done"'

delayed_worker="$finish_worker"'sleep 3; printf "progress during inspection\n"; sleep 3; finish'
delayed_root=$(run_case delayed-stale-stop "$delayed_worker" delayed-stop '' COOKEPIC_INSPECTOR_TIMEOUT=4)
assert_contains "$delayed_root/run/mailbox.jsonl" 'stale stop ignored'
assert_not_contains "$delayed_root/run/mailbox.jsonl" '"event": "inspection-stop"'
assert_contains "$delayed_root/run/mailbox.jsonl" '"event": "done"'

secret_worker="$finish_worker"'printf "%s\n" \
  "token=ghp_super_secret_token" \
  "AKIAIOSFODNN7EXAMPLE" \
  "Cookie: session=private-cookie" \
  "https://admin:password@example.test/private" \
  "quoted=\"private quoted value\"" \
  "-----BEGIN PRIVATE KEY-----" \
  "pem-private-material" \
  "-----END PRIVATE KEY-----";
ln -s /usr/bin/sleep "$COOKEPIC_RUN_DIR/ghp_tool_secret"; "$COOKEPIC_RUN_DIR/ghp_tool_secret" 5 & wait; finish'
secret_root=$(run_case structural-evidence "$secret_worker" capture-evidence)
for secret in ghp_super_secret_token ghp_tool_secret AKIAIOSFODNN7EXAMPLE private-cookie admin:password 'private quoted value' 'BEGIN PRIVATE KEY' pem-private-material; do
  assert_not_contains "$secret_root/run/captured-inspector-prompt" "$secret"
done
assert_contains "$secret_root/run/captured-inspector-prompt" 'Bounded allowlisted activity summary'
assert_contains "$secret_root/run/captured-inspector-prompt" 'Worker output bytes:'
assert_not_contains "$secret_root/run/captured-inspector-prompt" 'Recent worker output'

storage_worker="$finish_worker"'sleep 5; finish'
storage_root=$(run_case bounded-inspector-storage "$storage_worker" storage '' COOKEPIC_INSPECTOR_RESULT_BYTES=512 COOKEPIC_INSPECTOR_LOG_BYTES=1024)
[ "$(stat -c %s "$storage_root/run/inspector-w1.result.json")" -le 512 ] || fail 'inspector result exceeded its limit'
[ "$(stat -c %s "$storage_root/run/inspector-w1.raw.log")" -le 1024 ] || fail 'inspector raw log exceeded its limit'
assert_contains "$storage_root/run/mailbox.jsonl" 'inspector returned malformed output'

overflow_root=$(run_case inspector-overflow-stop "$sleep_worker" overflow-stop '' COOKEPIC_INSPECTOR_RESULT_BYTES=512)
assert_contains "$overflow_root/run/mailbox.jsonl" 'inspector returned malformed output'
assert_not_contains "$overflow_root/run/mailbox.jsonl" '"event": "inspection-stop"'
assert_contains "$overflow_root/run/mailbox.jsonl" '"event": "done"'

failure_root=$(run_case inspector-failure "$sleep_worker" failure)
assert_contains "$failure_root/run/mailbox.jsonl" 'inspector failed with rc=7'

timeout_root=$(run_case inspector-timeout "$sleep_worker" timeout)
assert_contains "$timeout_root/run/mailbox.jsonl" 'inspector timed out after 1s'

bounded_root=$(run_case bounded-reinspection "$idle_worker" bounded '' COOKEPIC_DISABLE_SYSTEMD=1)
[ "$(event_count "$bounded_root/run/mailbox.jsonl" inspection-started)" -eq 3 ] || fail 'bounded delay did not include stop confirmation inspection'
assert_contains "$bounded_root/run/mailbox.jsonl" '"nextCheckSeconds": 2'

cat > "$TMP_ROOT/static-sampler.sh" <<'EOF'
#!/usr/bin/env bash
printf '0 0\n'
EOF
chmod +x "$TMP_ROOT/static-sampler.sh"
fingerprint_worker='#!/usr/bin/env bash
set -euo pipefail
while [[ "$(<"$COOKEPIC_RUN_DIR/mailbox.jsonl")" != *inspection-stop-pending* ]]; do :; done
bash -c "sleep 30; :" &
printf "%s" "$!" > "$COOKEPIC_RUN_DIR/fingerprint-child-pid"
wait
'
fingerprint_root=$(run_case fingerprint-clears-stop "$fingerprint_worker" stop '' COOKEPIC_DISABLE_SYSTEMD=1 \
  COOKEPIC_RESOURCE_SAMPLER_CMD="$TMP_ROOT/static-sampler.sh")
[ "$(<"$fingerprint_root/run/inspect-count")" -ge 3 ] || fail 'changed process fingerprint did not clear stop confirmation'
[ "$(event_count "$fingerprint_root/run/mailbox.jsonl" inspection-stop-pending)" -ge 2 ] \
  || fail 'changed process fingerprint was not treated as a new first stop'
assert_process_gone "$(<"$fingerprint_root/run/fingerprint-child-pid")"

absolute_root=$(run_case explicit-timeout "$idle_worker" '' 1 COOKEPIC_IDLE_THRESHOLD=30)
assert_contains "$absolute_root/run/loop.log" 'timed out after 1s'

absolute_tree_root=$(run_case explicit-timeout-tree "$tree_worker" '' 1 COOKEPIC_IDLE_THRESHOLD=30 COOKEPIC_DISABLE_SYSTEMD=1)
assert_process_gone "$(<"$absolute_tree_root/run/worker-child-pid")"
assert_process_gone "$(<"$absolute_tree_root/run/worker-grandchild-pid")"

cat > "$TMP_ROOT/start-ticks.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
pid="$1"
stat=$(<"/proc/$pid/stat")
ticks=$(awk '{print $20}' <<< "${stat##*') '}")
if [ ! -f "$TEST_IDENTITY_ROOT" ]; then
  printf '%s' "$pid" > "$TEST_IDENTITY_ROOT"
elif [ "$pid" = "$(<"$TEST_IDENTITY_ROOT")" ] && grep -q 'reached its absolute' "$TEST_LOOP_LOG" 2>/dev/null; then
  touch "$TEST_PID_REUSED" "$TEST_CLEANUP_PROBED"
  ticks=$((ticks + 1))
fi
printf '%s\n' "$ticks"
EOF
chmod +x "$TMP_ROOT/start-ticks.sh"
reuse_worker="$finish_worker"'trap '\''touch "$COOKEPIC_RUN_DIR/unowned-process-signaled"; exit 143'\'' TERM
sleep 3; finish'
reuse_root=$(run_case pid-reuse-protection "$reuse_worker" '' 2 COOKEPIC_IDLE_THRESHOLD=30 COOKEPIC_DISABLE_SYSTEMD=1 \
  COOKEPIC_PROCESS_START_TICKS_CMD="$TMP_ROOT/start-ticks.sh" \
  TEST_IDENTITY_ROOT="$TMP_ROOT/pid-reuse-protection/root-pid" TEST_PID_REUSED="$TMP_ROOT/pid-reuse-protection/reused" \
  TEST_CLEANUP_PROBED="$TMP_ROOT/pid-reuse-protection/cleanup-probed" TEST_LOOP_LOG="$TMP_ROOT/pid-reuse-protection/run/loop.log")
[ -e "$reuse_root/cleanup-probed" ] || fail 'PID reuse seam did not run during cleanup'
[ ! -e "$reuse_root/run/unowned-process-signaled" ] || fail 'PID-reused process received an owned-group signal'
assert_contains "$reuse_root/run/mailbox.jsonl" '"event": "done"'

default_worker="$finish_worker"'sleep 3; finish'
default_root=$(run_case no-default-timeout "$default_worker" '' '' COOKEPIC_IDLE_THRESHOLD=30)
assert_contains "$default_root/run/mailbox.jsonl" '"event": "done"'
assert_not_contains "$default_root/run/loop.log" 'timed out after'

scope_worker="$finish_worker"'printf "%s" "$FLEET_UNIT" > "$COOKEPIC_RUN_DIR/scope-unit"; finish'
scope_one=$(run_case scope-identity-one "$scope_worker" '' '' COOKEPIC_DISABLE_SYSTEMD=1)
scope_two=$(run_case scope-identity-two "$scope_worker" '' '' COOKEPIC_DISABLE_SYSTEMD=1)
[ "$(<"$scope_one/run/scope-unit")" != "$(<"$scope_two/run/scope-unit")" ] \
  || fail 'canonical repo and run paths did not make scope ids unique'

collision_root="$TMP_ROOT/scope-collision"; collision_repo="$collision_root/repo"; collision_state="$collision_root/state"
collision_bin="$collision_root/bin"; collision_run="$collision_root/run"; collision_rc=0
mkdir -p "$collision_state" "$collision_run"; make_repo "$collision_repo"; make_bd "$collision_bin"
printf open > "$collision_state/child"; printf open > "$collision_state/epic"
cat > "$collision_bin/systemd-run" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
cat > "$collision_bin/systemctl" <<'EOF'
#!/usr/bin/env bash
case " $* " in
  *' list-units '*) printf 'cook-epic-collision-w1.scope loaded active running\n' ;;
esac
EOF
chmod +x "$collision_bin/systemd-run" "$collision_bin/systemctl"
printf '%s\n' "$idle_worker" > "$collision_root/worker.sh"; chmod +x "$collision_root/worker.sh"
(
  cd "$collision_repo"
  for v in "${!COOKEPIC_@}"; do unset "$v"; done
  env PATH="$collision_bin:$PATH" FAKE_BD_STATE="$collision_state" COOKEPIC_EPIC=epic COOKEPIC_HARNESS=claude \
    COOKEPIC_WORKER_CMD="$collision_root/worker.sh" COOKEPIC_SEQUENTIAL=1 COOKEPIC_GATE=true COOKEPIC_NO_PUSH=1 \
    "$RUNNER" "$collision_run"
) > "$collision_root/stdout" 2>&1 || collision_rc=$?
[ "$collision_rc" -eq 2 ] || fail 'pre-existing scope collision did not fail preflight'
assert_contains "$collision_root/stdout" 'pre-existing worker or inspector scope uses run identity'
[ "$(<"$collision_state/child")" = open ] || fail 'scope collision adopted or claimed a worker unit'

large_worker='#!/usr/bin/env bash
printf "429 rate limit before rolling output\n"
for i in {1..5000}; do printf "noise-%05d-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\n" "$i"; done
'
large_root=$(run_case bounded-worker-output "$large_worker" '' '' COOKEPIC_WORKER_ARTIFACT_BYTES=4096)
[ "$(stat -c %s "$large_root/run/worker-child.log")" -le 4096 ] || fail 'worker artifact exceeded its limit'
[ "$(<"$large_root/run/worker-child.log.bytes")" -gt 100000 ] || fail 'worker cumulative byte count did not survive rolling'
assert_contains "$large_root/run/mailbox.jsonl" '"event": "rate-limited"'

threshold_worker="$finish_worker"'for i in {1..260}; do printf "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"; done
while [ "$(<"$COOKEPIC_RUN_DIR/worker-child.log.bytes")" -lt 13000 ]; do sleep 0.05; done
stat -c %s "$COOKEPIC_RUN_DIR/worker-child.log" > "$COOKEPIC_RUN_DIR/pre-normalize-size"
sleep 1
finish'
threshold_root=$(run_case bounded-compaction-threshold "$threshold_worker" '' '' COOKEPIC_WORKER_ARTIFACT_BYTES=8192)
[ "$(<"$threshold_root/run/pre-normalize-size")" -gt 8192 ] || fail 'bounded log compacted before twice its retained limit'
[ "$(stat -c %s "$threshold_root/run/worker-child.log")" -le 8192 ] || fail 'bounded log final normalization exceeded its limit'

MAKE_GIT_CAPTURE="$TMP_ROOT/repo-probe.log"
probe_root=$(run_case bounded-hot-probe "$output_worker" '' '' MAKE_GIT_CAPTURE="$MAKE_GIT_CAPTURE" COOKEPIC_REPO_PROBE_INTERVAL=1)
unset MAKE_GIT_CAPTURE
[ ! -s "$TMP_ROOT/repo-probe.log" ] || fail 'repository status ran on the output-active hot path'

MAKE_GIT_CAPTURE="$TMP_ROOT/quiet-repo-probe.log"
quiet_probe_root=$(run_case bounded-quiet-probe "$sleep_worker" continue '' MAKE_GIT_CAPTURE="$MAKE_GIT_CAPTURE" COOKEPIC_REPO_PROBE_INTERVAL=1)
unset MAKE_GIT_CAPTURE
assert_contains "$TMP_ROOT/quiet-repo-probe.log" 'parent=timeout'
assert_contains "$TMP_ROOT/quiet-repo-probe.log" '--untracked-files=no'

invalid_timeout_root=$(run_case invalid-timeout "$idle_worker" '' 0)
[ "$(<"$invalid_timeout_root/rc")" -eq 2 ] || fail 'zero absolute timeout passed validation'
assert_contains "$invalid_timeout_root/stdout" 'COOKEPIC_WORKER_TIMEOUT must be a positive integer when set'

invalid_idle_root=$(run_case invalid-idle "$idle_worker" '' '' COOKEPIC_IDLE_THRESHOLD=0)
[ "$(<"$invalid_idle_root/rc")" -eq 2 ] || fail 'zero idle threshold passed validation'
assert_contains "$invalid_idle_root/stdout" 'COOKEPIC_IDLE_THRESHOLD must be a positive integer'

immutable_root=$(run_case no-checkout-mutation "$sleep_worker" immutable)
[ "$(<"$immutable_root/run/inspector-cwd")" = "$immutable_root/run" ] || fail 'inspector did not run from the run directory'
[ ! -s "$immutable_root/run/status-during-inspection" ] || fail 'checkout changed during read-only inspection'

# HUP follows the ordinary EXIT trap path. The trap must stop an in-flight
# inspector instead of leaving its scope or timeout process behind.
cleanup_root="$TMP_ROOT/inspector-cleanup"; cleanup_repo="$cleanup_root/repo"; cleanup_state="$cleanup_root/state"; cleanup_bin="$cleanup_root/bin"; cleanup_run="$cleanup_root/run"
mkdir -p "$cleanup_state" "$cleanup_run"; make_repo "$cleanup_repo"; make_bd "$cleanup_bin"
printf open > "$cleanup_state/child"; printf open > "$cleanup_state/epic"
printf '%s\n' "$idle_worker" > "$cleanup_root/worker.sh"; chmod +x "$cleanup_root/worker.sh"
make_inspector "$cleanup_root/inspector.sh" cleanup
(
  cd "$cleanup_repo"
  for v in "${!COOKEPIC_@}"; do unset "$v"; done
  exec env PATH="$cleanup_bin:$PATH" FAKE_BD_STATE="$cleanup_state" COOKEPIC_EPIC=epic COOKEPIC_HARNESS=claude \
    COOKEPIC_WORKER_CMD="$cleanup_root/worker.sh" COOKEPIC_INSPECTOR_CMD="$cleanup_root/inspector.sh" \
    COOKEPIC_SEQUENTIAL=1 COOKEPIC_GATE=true COOKEPIC_NO_PUSH=1 COOKEPIC_SPAWN_DELAY=0 COOKEPIC_MAX_DISPATCHES=1 \
    COOKEPIC_MAX_ATTEMPTS=1 COOKEPIC_IDLE_THRESHOLD=1 COOKEPIC_INSPECTOR_TIMEOUT=30 COOKEPIC_STOP_GRACE=1 \
    COOKEPIC_INSPECT_RETRY_DELAY=1 COOKEPIC_INSPECT_MIN_DELAY=1 COOKEPIC_INSPECT_MAX_DELAY=2 COOKEPIC_SUPERVISION_TICK=1 \
    COOKEPIC_DISABLE_SYSTEMD=1 \
    "$RUNNER" "$cleanup_run"
) > "$cleanup_root/stdout" 2>&1 &
coordinator=$!
deadline=$((SECONDS + 20))
while [ ! -f "$cleanup_run/inspector-pid" ] && [ "$SECONDS" -lt "$deadline" ]; do sleep 0.1; done
[ -f "$cleanup_run/inspector-pid" ] || fail 'cleanup inspector did not start'
inspector_pid=$(<"$cleanup_run/inspector-pid")
kill -HUP "$coordinator"
wait "$coordinator" 2>/dev/null || true
deadline=$((SECONDS + 10))
while kill -0 "$inspector_pid" 2>/dev/null && [ "$SECONDS" -lt "$deadline" ]; do sleep 0.1; done
kill -0 "$inspector_pid" 2>/dev/null && fail 'inspector survived coordinator exit'
assert_process_gone "$(<"$cleanup_run/inspector-child-pid")"

claude_root=$(run_harness_case harness-claude claude TEST_LARGE_OUTPUT=1 TEST_COST_EARLY=1 COOKEPIC_WORKER_ARTIFACT_BYTES=4096)
diff -u <(printf '%s\n' -p --safe-mode --disable-slash-commands --tools '<EMPTY>' --permission-mode plan \
  --no-session-persistence --output-format text --model sonnet -- '<PROMPT>') \
  "$claude_root/run/claude-inspector.argv"
[ "$(stat -c %s "$claude_root/run/worker-child.log")" -le 4096 ] || fail 'bounded Claude artifact exceeded its limit'
assert_contains "$claude_root/run/mailbox.jsonl" '"total_cost": 1.25'

kimi_root=$(run_harness_case harness-kimi kimi)
diff -u <(printf '%s\n' -p '<PROMPT>' --agent-file "$SKILL_DIR/inspector-agent.md" --output-format text) \
  "$kimi_root/run/kimi-inspector.argv"
assert_contains "$SKILL_DIR/inspector-agent.md" 'tools: []'
assert_contains "$SKILL_DIR/inspector-agent.md" 'subagents: []'

opencode_root=$(run_harness_case harness-opencode opencode)
diff -u <(printf '%s\n' run --pure --agent cook-epic-inspector --format json --dir "$opencode_root/run" -- '<PROMPT>') \
  "$opencode_root/run/opencode-inspector.argv"
jq -e '.permission == "deny" and .subagent_depth == 0 and .agent["cook-epic-inspector"].permission == "deny"' \
  "$opencode_root/run/opencode-inspector-config.json" >/dev/null || fail 'OpenCode inspector config did not deny tools'

codex_root=$(run_harness_case harness-codex codex)
diff -u <(printf '%s\n' -a never -s danger-full-access exec --json '<PROMPT>') "$codex_root/run/codex-worker.argv"
[ ! -e "$codex_root/run/codex-inspector.argv" ] || fail 'Codex inspector launched despite lacking no-tool isolation'
assert_contains "$codex_root/run/mailbox.jsonl" 'Codex inspection is disabled because Codex cannot enforce the no-tool contract'
[ "$(event_count "$codex_root/run/mailbox.jsonl" inspection-started)" -eq 0 ] || fail 'Codex recorded a launched inspector'

assert_not_contains "$RUNNER" 'timeout --foreground'
assert_not_contains "$RUNNER" 'RUN_INSPECTOR_PIDS'

watch_run="$TMP_ROOT/watcher/run"; mkdir -p "$watch_run"
cat > "$watch_run/mailbox.jsonl" <<'EOF'
{"event":"worker-idle","child":"child","worker":"w1","idleSeconds":1800}
{"event":"inspection-started","child":"child","worker":"w1","timeoutSeconds":120}
{"event":"inspection-continue","child":"child","rationale":"render is active","nextCheckSeconds":1800}
{"event":"inspection-uncertain","child":"child","reason":"malformed output","nextCheckSeconds":300}
{"event":"inspection-stop-pending","child":"child","rationale":"idle wait loop","nextCheckSeconds":60}
{"event":"inspection-stop","child":"child","rationale":"idle wait loop"}
{"event":"finished","reason":"test complete","dispatched":1,"merged":0,"verified":true,"pushed":false}
EOF
timeout 10 "$SKILL_DIR/watch.sh" "$watch_run" > "$TMP_ROOT/watcher/output"
assert_contains "$TMP_ROOT/watcher/output" 'idle child: w1 has no progress for 1800s'
assert_contains "$TMP_ROOT/watcher/output" 'continue child: render is active'
assert_contains "$TMP_ROOT/watcher/output" 'uncertain child: malformed output'
assert_contains "$TMP_ROOT/watcher/output" 'confirm stop child: idle wait loop'
assert_contains "$TMP_ROOT/watcher/output" 'stop child: inspector found the worker stuck'

printf 'cook-epic liveness regression tests passed\n'
