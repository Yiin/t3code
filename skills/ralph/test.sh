#!/usr/bin/env bash
# Deterministic Ralph adapter tests. No live agent session is started.
set -euo pipefail

SKILL_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
RUNNER="$SKILL_DIR/run.sh"
WATCHER="$SKILL_DIR/watch.sh"
TMP_ROOT=$(mktemp -d /var/tmp/ralph-test.XXXXXX)
trap 'rm -rf "$TMP_ROOT"' EXIT

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

assert_arg() {
  local expected="$1"
  call_args | grep -Fx -- "$expected" >/dev/null || fail "missing argument: $expected"
}

call_args() {
  tr '\0' '\n' < "$CALL_LOG"
}

assert_json() {
  local expression="$1" file="$2"
  jq -e "$expression" "$file" >/dev/null || fail "JSON assertion failed: $expression in $file"
}

MOCK_BIN="$TMP_ROOT/bin"
mkdir -p "$MOCK_BIN"

cat > "$MOCK_BIN/mock-agent" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
name=$(basename "$0")
printf '%s\0' "$name" "$@" >> "$MOCK_CALL_LOG"
[ -f "$MOCK_MAILBOX" ] || { printf 'mailbox missing before child start\n' >&2; exit 91; }
if [ "${MOCK_MODE:-}" = error ]; then
  exit "${MOCK_EXIT_CODE:-7}"
fi
if [ "${MOCK_MODE:-}" = malformed ]; then
  printf '{not json\n'
  exit 0
fi

iteration=1
if [ -n "${MOCK_STATE_FILE:-}" ]; then
  [ ! -f "$MOCK_STATE_FILE" ] || iteration=$(( $(<"$MOCK_STATE_FILE") + 1 ))
  printf '%s\n' "$iteration" > "$MOCK_STATE_FILE"
fi

if [ "${MOCK_MODE:-}" != opencode-stateful ] || [ "$iteration" -eq 1 ]; then
  git commit --allow-empty -m "mock $name commit" >/dev/null
fi

if [ "${MOCK_MODE:-}" = ralph-done ] || { [ "${MOCK_MODE:-}" = opencode-stateful ] && [ "$iteration" -eq 2 ]; }; then
  message=RALPH_DONE
else
  message="done
RALPH_MSG: {\"summary\":\"$name unit\",\"why\":\"$name reason\"}"
fi

if [ "$name" = codex ]; then
  printf '%s\n' \
    '{"type":"thread.started","thread_id":"codex-session"}' \
    '{"type":"turn.started"}'
  jq -cn --arg message "$message" '{type:"item.completed",item:{type:"agent_message",text:$message}}'
  printf '%s\n' '{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":2,"output_tokens":3,"reasoning_output_tokens":1}}'
elif [ "$name" = opencode ]; then
  printf '%s\n' '{"type":"step_start","sessionID":"opencode-session","part":{"type":"step-start"}}'
  printf '%s\n' '{"type":"text","sessionID":"later-session","part":{"type":"text","text":"superseded text"}}'
  jq -cn --arg message "$message" '{type:"text",sessionID:"later-session",part:{type:"text",text:$message}}'
else
  jq -cn --arg result "$message" --argjson cost "${MOCK_COST:-1.25}" \
    '{result:$result,session_id:"claude-session",total_cost_usd:$cost}'
fi
[ -z "${MOCK_ENV_LOG:-}" ] || printf '%s\n' "${ANTHROPIC_BASE_URL:-}|${ANTHROPIC_AUTH_TOKEN:-}|${ANTHROPIC_MODEL:-}" > "$MOCK_ENV_LOG"
MOCK
chmod +x "$MOCK_BIN/mock-agent"
ln -s mock-agent "$MOCK_BIN/codex"
ln -s mock-agent "$MOCK_BIN/claude"
ln -s mock-agent "$MOCK_BIN/opencode"

cat > "$MOCK_BIN/ps" <<'MOCK'
#!/usr/bin/env bash
if [ -n "${MOCK_PS_HARNESS:-}" ]; then
  printf '%s 1\n' "$MOCK_PS_HARNESS"
  exit 0
fi
exit 1
MOCK
chmod +x "$MOCK_BIN/ps"

new_case() {
  local name="$1"
  CASE_DIR="$TMP_ROOT/$name"
  REPO="$CASE_DIR/repo"
  RUN_DIR="$CASE_DIR/run"
  CALL_LOG="$CASE_DIR/call.args"
  mkdir -p "$REPO" "$RUN_DIR"
  git -C "$REPO" init -q
  git -C "$REPO" config user.name 'Ralph Test'
  git -C "$REPO" config user.email 'ralph-test@example.invalid'
  printf 'seed\n' > "$REPO/seed.txt"
  git -C "$REPO" add seed.txt
  git -C "$REPO" commit -q -m seed
  printf 'do one unit\n' > "$RUN_DIR/prompt.md"
}

run_case() {
  (
    cd "$REPO"
    env \
      -u RALPH_HARNESS -u RALPH_MAX_ITER -u RALPH_BUDGET_USD \
      -u RALPH_ITER_TIMEOUT -u RALPH_PERMISSION_MODE -u RALPH_MODEL \
      -u RALPH_BIN -u CODEX_BIN -u CLAUDE_BIN -u KIMI_BIN -u OPENCODE_BIN \
      -u CODEX_THREAD_ID -u CLAUDECODE -u CLAUDE_CODE_SESSION_ID \
      -u OPENCODE -u OPENCODE_PID \
      -u ANTHROPIC_BASE_URL -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_MODEL \
      -u ANTHROPIC_SMALL_FAST_MODEL -u CCX_PORT -u CCX_MODEL -u CCX_SMALL_MODEL \
      -u CLAUDE_CODE_AUTO_COMPACT_WINDOW \
      -u CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC -u CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK \
      -u CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS \
      -u MOCK_PS_HARNESS -u MOCK_MODE -u MOCK_EXIT_CODE -u MOCK_COST -u MOCK_ENV_LOG -u MOCK_STATE_FILE \
      PATH="$MOCK_BIN:$PATH" \
      MOCK_CALL_LOG="$CALL_LOG" \
      MOCK_MAILBOX="$RUN_DIR/mailbox.jsonl" \
      RALPH_MAX_ITER=1 \
      "$@" "$RUNNER" "$RUN_DIR"
  ) > "$CASE_DIR/stdout.txt"
}

new_case explicit-codex
run_case RALPH_HARNESS=codex RALPH_MODEL=codex-test-model MOCK_PS_HARNESS=claude CODEX_THREAD_ID=outer CLAUDECODE=1
[ "$(call_args | head -1)" = codex ] || fail 'explicit Codex selection did not win'
assert_arg '-a'
assert_arg 'never'
assert_arg '-s'
assert_arg 'danger-full-access'
assert_arg 'exec'
assert_arg '--json'
assert_arg '-m'
assert_arg 'codex-test-model'
grep -F 'Loop protocol (you are one iteration' "$CALL_LOG" >/dev/null || fail 'protocol was not appended to Codex prompt'
assert_json 'select(.status == "done" and .harness == "codex" and .session == "codex-session" and .summary == "codex unit" and .cost == null)' "$RUN_DIR/mailbox.jsonl"
assert_json 'select(.status == "finished" and .total_cost == null and .iters == 1)' "$RUN_DIR/mailbox.jsonl"
[ "$("$WATCHER" "$RUN_DIR" | grep -Fc 'cost unavailable')" -eq 2 ] || fail 'watcher did not render unavailable Codex iteration and total costs'

new_case explicit-claude
run_case RALPH_HARNESS=claude RALPH_MODEL=claude-test-model MOCK_PS_HARNESS=codex CODEX_THREAD_ID=outer
[ "$(call_args | head -1)" = claude ] || fail 'explicit Claude selection did not win'
assert_arg '-p'
assert_arg '--permission-mode'
assert_arg 'auto'
assert_arg '--output-format'
assert_arg 'json'
assert_arg '--model'
assert_arg 'claude-test-model'
assert_json 'select(.status == "done" and .harness == "claude" and .session == "claude-session" and .summary == "claude unit" and .cost == 1.25)' "$RUN_DIR/mailbox.jsonl"
assert_json 'select(.status == "finished" and .total_cost == 1.25 and .iters == 1)' "$RUN_DIR/mailbox.jsonl"
watch_output=$("$WATCHER" "$RUN_DIR")
grep -F 'cost $1.25' <<< "$watch_output" >/dev/null || fail 'watcher did not render iteration cost'
grep -F 'total cost $1.25' <<< "$watch_output" >/dev/null || fail 'watcher did not render total cost'

new_case claude-prompt-delimiter
printf '%s\n' '- /cook-it maximo-app-3ew' > "$RUN_DIR/prompt.md"
run_case RALPH_HARNESS=claude
mapfile -t claude_args < <(call_args)
delimiter_index=-1
prompt_index=-1
for index in "${!claude_args[@]}"; do
  [ "${claude_args[$index]}" = -- ] && delimiter_index=$index
  [ "${claude_args[$index]}" = '- /cook-it maximo-app-3ew' ] && prompt_index=$index
done
[ "$delimiter_index" -ge 0 ] && [ "$prompt_index" -eq $((delimiter_index + 1)) ] || fail 'Claude prompt was not preceded by --'

new_case explicit-ccx
CCX_ENV_LOG="$CASE_DIR/ccx.env"
printf '%s\n' '- /cook-it maximo-app-3ew' > "$RUN_DIR/prompt.md"
run_case RALPH_HARNESS=ccx RALPH_MODEL=ccx-test-model RALPH_PERMISSION_MODE=bypassPermissions \
  ANTHROPIC_BASE_URL=http://127.0.0.1:18765 ANTHROPIC_AUTH_TOKEN=unused ANTHROPIC_MODEL='gpt-5.6-sol[1m]' \
  ANTHROPIC_SMALL_FAST_MODEL='gpt-5.6-luna[1m]' CLAUDE_CODE_AUTO_COMPACT_WINDOW=372000 \
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK=1 \
  MOCK_ENV_LOG="$CCX_ENV_LOG"
mapfile -t ccx_args < <(call_args)
delimiter_index=-1
prompt_index=-1
for index in "${!ccx_args[@]}"; do
  [ "${ccx_args[$index]}" = -- ] && delimiter_index=$index
  [ "${ccx_args[$index]}" = '- /cook-it maximo-app-3ew' ] && prompt_index=$index
done
[ "$delimiter_index" -ge 0 ] && [ "$prompt_index" -eq $((delimiter_index + 1)) ] || fail 'ccx prompt was not preceded by --'
[ "$(call_args | head -1)" = claude ] || fail 'ccx did not use the Claude executable'
assert_arg '-p'
assert_arg '--permission-mode'
assert_arg 'bypassPermissions'
assert_arg '--model'
assert_arg 'ccx-test-model'
assert_json 'select(.status == "done" and .harness == "ccx" and .session == "claude-session" and .cost == 1.25)' "$RUN_DIR/mailbox.jsonl"
assert_json 'select(.status == "finished" and .harness == "ccx" and .total_cost == 1.25 and .iters == 1)' "$RUN_DIR/mailbox.jsonl"
[ "$(<"$CCX_ENV_LOG")" = 'http://127.0.0.1:18765|unused|gpt-5.6-sol[1m]' ] || fail 'ccx environment was not inherited by the child'
grep -F 'harness=ccx' "$RUN_DIR/loop.log" >/dev/null || fail 'ccx was not recorded in the log'

new_case explicit-opencode
run_case RALPH_HARNESS=opencode RALPH_MODEL=openai/test-model MOCK_PS_HARNESS=codex
[ "$(call_args | head -1)" = opencode ] || fail 'explicit OpenCode selection did not win'
assert_arg 'run'
assert_arg '--format'
assert_arg 'json'
assert_arg '--auto'
assert_arg '-m'
assert_arg 'openai/test-model'
grep -F 'Loop protocol (you are one iteration' "$CALL_LOG" >/dev/null || fail 'protocol was not appended to OpenCode prompt'
assert_json 'select(.status == "done" and .harness == "opencode" and .session == "opencode-session" and .summary == "opencode unit" and .cost == null)' "$RUN_DIR/mailbox.jsonl"
assert_json 'select(.status == "finished" and .total_cost == null and .iters == 1)' "$RUN_DIR/mailbox.jsonl"

new_case opencode-prompt-delimiter
printf '%s\n' '- /cook-it maximo-app-3ew' > "$RUN_DIR/prompt.md"
run_case RALPH_HARNESS=opencode
mapfile -t opencode_args < <(call_args)
delimiter_index=-1
prompt_index=-1
for index in "${!opencode_args[@]}"; do
  [ "${opencode_args[$index]}" = -- ] && delimiter_index=$index
  [ "${opencode_args[$index]}" = '- /cook-it maximo-app-3ew' ] && prompt_index=$index
done
[ "$delimiter_index" -ge 0 ] && [ "$prompt_index" -eq $((delimiter_index + 1)) ] || fail 'OpenCode prompt was not preceded by --'

new_case opencode-bypass
run_case RALPH_HARNESS=opencode RALPH_PERMISSION_MODE=bypassPermissions
[ "$(call_args | grep -Fxc -- '--auto')" -eq 1 ] || fail 'OpenCode bypass mode did not map to its sole --auto switch'

new_case opencode-invalid-permission
if run_case RALPH_HARNESS=opencode RALPH_PERMISSION_MODE=danger-full-access; then fail 'invalid OpenCode permission mode should fail'; fi
[ ! -e "$CALL_LOG" ] || fail 'OpenCode child launched for invalid permission mode'

new_case opencode-budget
if run_case RALPH_HARNESS=opencode RALPH_BUDGET_USD=10; then fail 'OpenCode dollar budget should fail before launch'; fi
[ ! -e "$CALL_LOG" ] || fail 'OpenCode child launched despite unsupported dollar budget'
assert_json 'select(.status == "finished" and .total_cost == null and (.reason | contains("cannot be enforced")))' "$RUN_DIR/mailbox.jsonl"

new_case auto-ccx
run_case RALPH_HARNESS=auto MOCK_PS_HARNESS=claude \
  ANTHROPIC_BASE_URL=http://127.0.0.1:18765 ANTHROPIC_AUTH_TOKEN=unused ANTHROPIC_MODEL='gpt-5.6-sol[1m]' \
  ANTHROPIC_SMALL_FAST_MODEL='gpt-5.6-luna[1m]' CLAUDE_CODE_AUTO_COMPACT_WINDOW=372000 \
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK=1
[ "$(call_args | head -1)" = claude ] || fail 'ccx proxy environment was not auto-detected'
assert_json 'select(.status == "done" and .harness == "ccx" and .cost == 1.25)' "$RUN_DIR/mailbox.jsonl"

new_case generic-proxy-near-miss
run_case RALPH_HARNESS=auto MOCK_PS_HARNESS=claude \
  ANTHROPIC_BASE_URL=https://proxy.example.invalid ANTHROPIC_AUTH_TOKEN=unused ANTHROPIC_MODEL='gpt-5.6-sol[1m]' \
  ANTHROPIC_SMALL_FAST_MODEL='gpt-5.6-luna[1m]' CLAUDE_CODE_AUTO_COMPACT_WINDOW=372000 \
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK=1
[ "$(call_args | head -1)" = claude ] || fail 'generic Anthropic proxy was misidentified as ccx'
assert_json 'select(.status == "done" and .harness == "claude" and .cost == 1.25)' "$RUN_DIR/mailbox.jsonl"

new_case ccx-budget
run_case RALPH_HARNESS=ccx RALPH_BUDGET_USD=10 RALPH_MAX_ITER=2 MOCK_COST=1.2345 \
  ANTHROPIC_BASE_URL=http://127.0.0.1:18765 ANTHROPIC_AUTH_TOKEN=unused ANTHROPIC_MODEL='gpt-5.6-sol[1m]' \
  ANTHROPIC_SMALL_FAST_MODEL='gpt-5.6-luna[1m]' CLAUDE_CODE_AUTO_COMPACT_WINDOW=372000 \
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK=1
[ "$(call_args | grep -Fxc -- '--max-budget-usd')" -eq 2 ] || fail 'ccx budget cap was not passed to every child'
assert_arg '10'
assert_arg '8.7655'
assert_json 'select(.status == "finished" and .harness == "ccx" and .total_cost == 2.469 and .iters == 2)' "$RUN_DIR/mailbox.jsonl"

new_case missing-ccx-environment
if run_case RALPH_HARNESS=ccx; then fail 'ccx without inherited environment should fail'; fi
[ ! -e "$CALL_LOG" ] || fail 'ccx child launched without inherited environment'
grep -F 'requires the inherited ccx proxy environment' "$CASE_DIR/stdout.txt" >/dev/null || fail 'ccx missing-environment error was unclear'

new_case ancestor-fallback
run_case RALPH_HARNESS=auto MOCK_PS_HARNESS=claude CODEX_THREAD_ID=outer CLAUDECODE=1
[ "$(call_args | head -1)" = claude ] || fail 'nearest harness ancestor was not preferred'

new_case opencode-ancestor-fallback
run_case RALPH_HARNESS=auto MOCK_PS_HARNESS=opencode-worker CODEX_THREAD_ID=outer CLAUDECODE=1
[ "$(call_args | head -1)" = opencode ] || fail 'nearest OpenCode ancestor was not preferred'

new_case opencode-marker-fallback
run_case RALPH_HARNESS=auto OPENCODE=1
[ "$(call_args | head -1)" = opencode ] || fail 'OPENCODE environment fallback failed'

new_case opencode-pid-fallback
run_case RALPH_HARNESS=auto OPENCODE_PID=1234
[ "$(call_args | head -1)" = opencode ] || fail 'OPENCODE_PID environment fallback failed'

new_case opencode-marker-near-miss
run_case RALPH_HARNESS=auto OPENCODE=1 CODEX_THREAD_ID=codex-thread
[ "$(call_args | head -1)" = codex ] || fail 'OpenCode marker overrode a competing Codex marker'

new_case codex-marker-fallback
run_case RALPH_HARNESS=auto CODEX_THREAD_ID=codex-thread
[ "$(call_args | head -1)" = codex ] || fail 'Codex environment fallback failed'

new_case claude-marker-fallback
run_case RALPH_HARNESS=auto CLAUDECODE=1
[ "$(call_args | head -1)" = claude ] || fail 'Claude environment fallback failed'

new_case codex-yolo
run_case RALPH_HARNESS=codex RALPH_PERMISSION_MODE=bypassPermissions
assert_arg '--dangerously-bypass-approvals-and-sandbox'
if call_args | grep -Fx -- '-s' >/dev/null; then fail 'Codex yolo mixed bypass and sandbox flags'; fi

new_case claude-budget
run_case RALPH_HARNESS=claude RALPH_BUDGET_USD=10 RALPH_MAX_ITER=2 MOCK_COST=1.2345
[ "$(call_args | grep -Fxc -- '--max-budget-usd')" -eq 2 ] || fail 'Claude budget cap was not passed to every child'
assert_arg '10'
assert_arg '8.7655'
assert_json 'select(.status == "finished" and .total_cost == 2.469 and .iters == 2)' "$RUN_DIR/mailbox.jsonl"

new_case done-with-commit
run_case RALPH_HARNESS=claude RALPH_MAX_ITER=3 MOCK_MODE=ralph-done
assert_json 'select(.status == "protocol-error" and (.detail | contains("RALPH_DONE")))' "$RUN_DIR/mailbox.jsonl"
assert_json 'select(.status == "finished" and .iters == 1 and (.reason | contains("protocol error")))' "$RUN_DIR/mailbox.jsonl"
"$WATCHER" "$RUN_DIR" | grep -F 'RALPH_DONE was emitted after creating a commit' >/dev/null || fail 'watcher did not render the protocol error'

new_case child-error
run_case RALPH_HARNESS=claude RALPH_MAX_ITER=3 MOCK_MODE=error MOCK_EXIT_CODE=7
assert_json 'select(.status == "error" and .rc == 7)' "$RUN_DIR/mailbox.jsonl"
assert_json 'select(.status == "finished" and .iters == 1 and (.reason | contains("child exited rc=7")))' "$RUN_DIR/mailbox.jsonl"
"$WATCHER" "$RUN_DIR" | grep -F 'exited rc=7 — cost $0' >/dev/null || fail 'watcher did not render failed iteration cost'

new_case opencode-malformed-json
run_case RALPH_HARNESS=opencode MOCK_MODE=malformed
assert_json 'select(.status == "protocol-error" and (.detail | contains("not valid opencode JSON")))' "$RUN_DIR/mailbox.jsonl"

new_case opencode-stateful-done
STATE_FILE="$CASE_DIR/state"
run_case RALPH_HARNESS=opencode RALPH_MAX_ITER=3 MOCK_MODE=opencode-stateful MOCK_STATE_FILE="$STATE_FILE"
assert_json 'select(.iter == 1 and .status == "done" and .summary == "opencode unit")' "$RUN_DIR/mailbox.jsonl"
assert_json 'select(.iter == 2 and .status == "backlog-empty")' "$RUN_DIR/mailbox.jsonl"
assert_json 'select(.status == "finished" and .iters == 2 and .reason == "child reported RALPH_DONE")' "$RUN_DIR/mailbox.jsonl"

new_case codex-budget
if run_case RALPH_HARNESS=codex RALPH_BUDGET_USD=10; then fail 'Codex dollar budget should fail before launch'; fi
[ ! -e "$CALL_LOG" ] || fail 'Codex child launched despite unsupported dollar budget'
assert_json 'select(.status == "finished" and .total_cost == null and (.reason | contains("cannot be enforced")))' "$RUN_DIR/mailbox.jsonl"

new_case invalid-harness
if run_case RALPH_HARNESS=other; then fail 'invalid harness should fail'; fi
[ ! -e "$CALL_LOG" ] || fail 'child launched for invalid harness'

printf 'PASS: Ralph selects, invokes, and parses Codex, Claude, ccx, and OpenCode correctly\n'
