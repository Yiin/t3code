#!/usr/bin/env bash
# yiin-n7j.6: per-worker orientation metrics (time/tools/tokens before first
# edit). Part 1 unit-tests orientation_metrics()/append_orientation_summary()
# in isolation (extracted verbatim from run-legacy.sh, so this drifts with the real
# code rather than a hand-copied duplicate). Part 2 is a fixture end-to-end
# sequential run confirming the mailbox/summary wiring survives real reaping,
# including the non-claude harness (orientation:null) and a truncated-artifact
# case.
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNNER="$SKILL_DIR/run-legacy.sh" # legacy engine: the shim (run.sh) execs the shared core by default
TMP_ROOT="$(cd "$(mktemp -d /var/tmp/cook-epic-orientation-test.XXXXXX)" && pwd -P)"
trap '[ "${COOKEPIC_KEEP_TEST_TMP:-0}" = 1 ] || rm -rf "$TMP_ROOT"' EXIT

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
assert_contains() { grep -Fq -- "$2" "$1" || { sed -n '1,60p' "$1" >&2; fail "expected $1 to contain: $2"; }; }
assert_not_contains() { ! grep -Fq -- "$2" "$1" || fail "expected $1 not to contain: $2"; }

# ---------------------------------------------------- 1. unit: the helper ----
# Extract the shipped functions verbatim rather than reimplementing them, so
# this test fails the moment run-legacy.sh's behavior drifts from what's asserted here.
HELPERS="$TMP_ROOT/helpers.sh"
{
  awk '/^orientation_metrics\(\) \{/,/^}/' "$RUNNER"
  awk '/^append_orientation_summary\(\) \{/,/^}/' "$RUNNER"
} > "$HELPERS"
[ -s "$HELPERS" ] || fail 'could not extract orientation_metrics/append_orientation_summary from run-legacy.sh'
# shellcheck source=/dev/null
source "$HELPERS"

UNIT_HOME="$TMP_ROOT/unit-home"
mkdir -p "$UNIT_HOME/.claude/projects/-fixture"
export HOME="$UNIT_HOME"
COST_SUPPORTED=1

ARTIFACT="$TMP_ROOT/unit-artifact.log"
printf '{"type":"result","session_id":"fixture-sid","total_cost_usd":0}\n' > "$ARTIFACT"

# 2 pre-edit tool calls (Bash, Read) then an Edit — hand-computed:
# tokens before edit = (100+10+20) + (200+0+30) = 360; 12s to first edit; 2 calls.
cat > "$UNIT_HOME/.claude/projects/-fixture/fixture-sid.jsonl" <<'EOF'
{"type":"assistant","timestamp":"2026-08-04T10:00:00.000Z","message":{"content":[{"type":"tool_use","name":"Bash","id":"t1"}],"usage":{"input_tokens":100,"cache_creation_input_tokens":10,"cache_read_input_tokens":9999,"output_tokens":20}}}
{"type":"assistant","timestamp":"2026-08-04T10:00:05.000Z","message":{"content":[{"type":"tool_use","name":"Read","id":"t2"}],"usage":{"input_tokens":200,"cache_creation_input_tokens":0,"cache_read_input_tokens":1000,"output_tokens":30}}}
{"type":"assistant","timestamp":"2026-08-04T10:00:12.000Z","message":{"content":[{"type":"tool_use","name":"Edit","id":"t3"}],"usage":{"input_tokens":300,"cache_creation_input_tokens":0,"cache_read_input_tokens":500,"output_tokens":40}}}
EOF
got=$(orientation_metrics "$ARTIFACT")
want='{"secondsToFirstEdit":12,"toolCallsBeforeFirstEdit":2,"tokensBeforeFirstEdit":360}'
[ "$got" = "$want" ] || fail "orientation_metrics with an edit: got $got, want $want"

SUMMARY="$TMP_ROOT/unit-summary.md"
: > "$SUMMARY"
append_orientation_summary child-1 "$got"
assert_contains "$SUMMARY" '- child-1 orientation: 12s to first edit, 2 tool calls, 360 tokens before first edit'

# No edit tool anywhere: firstEditTs (and everything derived from it) is null,
# and reaping must still be able to treat this as "no orientation line".
cat > "$UNIT_HOME/.claude/projects/-fixture/fixture-sid.jsonl" <<'EOF'
{"type":"assistant","timestamp":"2026-08-04T10:00:00.000Z","message":{"content":[{"type":"tool_use","name":"Bash","id":"t1"}],"usage":{"input_tokens":100,"cache_creation_input_tokens":10,"cache_read_input_tokens":9999,"output_tokens":20}}}
{"type":"assistant","timestamp":"2026-08-04T10:00:05.000Z","message":{"content":[{"type":"tool_use","name":"Read","id":"t2"}],"usage":{"input_tokens":200,"cache_creation_input_tokens":0,"cache_read_input_tokens":1000,"output_tokens":30}}}
EOF
got=$(orientation_metrics "$ARTIFACT")
want='{"secondsToFirstEdit":null,"toolCallsBeforeFirstEdit":null,"tokensBeforeFirstEdit":null}'
[ "$got" = "$want" ] || fail "orientation_metrics with no edit: got $got, want $want"
: > "$SUMMARY"
append_orientation_summary child-2 "$got"
[ ! -s "$SUMMARY" ] || fail 'append_orientation_summary wrote a line for a null-fielded orientation object'

# Non-claude harness (COST_SUPPORTED=0): always null, never touches the FS.
COST_SUPPORTED=0
got=$(orientation_metrics "$ARTIFACT")
[ "$got" = null ] || fail "orientation_metrics with COST_SUPPORTED=0: got $got, want null"
: > "$SUMMARY"
append_orientation_summary child-3 "$got"
[ ! -s "$SUMMARY" ] || fail 'append_orientation_summary wrote a line for orientation:null'
COST_SUPPORTED=1

# Missing session_id in the artifact: null, no crash.
printf 'no session id in this artifact at all\n' > "$ARTIFACT"
got=$(orientation_metrics "$ARTIFACT")
[ "$got" = null ] || fail "orientation_metrics with no session_id: got $got, want null"

# session_id present but no matching transcript file: null, no crash.
printf '{"session_id":"no-such-session"}\n' > "$ARTIFACT"
got=$(orientation_metrics "$ARTIFACT")
[ "$got" = null ] || fail "orientation_metrics with an unresolvable transcript: got $got, want null"

# A truncated artifact (simulating the bounded rolling tail overflow case)
# still resolves via the LAST session_id line surviving in the tail.
printf '{"type":"assistant","garbage":"' > "$ARTIFACT"          # simulated cut-off head
printf '{"session_id":"fixture-sid"}\n' >> "$ARTIFACT"
cat > "$UNIT_HOME/.claude/projects/-fixture/fixture-sid.jsonl" <<'EOF'
{"type":"assistant","timestamp":"2026-08-04T10:00:00.000Z","message":{"content":[{"type":"tool_use","name":"Edit","id":"t1"}],"usage":{"input_tokens":100,"cache_creation_input_tokens":10,"cache_read_input_tokens":9999,"output_tokens":20}}}
EOF
got=$(orientation_metrics "$ARTIFACT")
want='{"secondsToFirstEdit":0,"toolCallsBeforeFirstEdit":0,"tokensBeforeFirstEdit":0}'
[ "$got" = "$want" ] || fail "orientation_metrics from a truncated artifact's surviving tail: got $got, want $want"

unset HOME
printf 'orientation_metrics unit tests passed\n'

# --------------------------------------------- 2. fixture: a real reap ----
make_repo() { # <repo>
  mkdir -p "$1/.beads"
  git init -q -b main "$1"
  git -C "$1" config user.name test
  git -C "$1" config user.email test@example.com
  printf 'base\n' > "$1/base.txt"
  git -C "$1" add . && git -C "$1" commit -qm base
}

make_bin() { # <bin dir> <state dir>
  local bin="$1" state="$2"
  mkdir -p "$bin"
  cat > "$bin/bd" <<EOF
#!/usr/bin/env bash
set -uo pipefail
state="$state"
cmd="\${1:-}"; shift || true
status=\$(cat "\$state/status" 2>/dev/null || printf open)
assignee=\$(cat "\$state/assignee" 2>/dev/null || true)
case "\$cmd" in
  show)
    if [ "\${1:-}" = epic ]; then
      printf '{"id":"epic","status":"open","title":"Epic","issue_type":"epic","comment_count":0}\n'
    else
      printf '{"id":"%s","status":"%s","title":"Child","issue_type":"task","assignee":"%s","comment_count":0}\n' \
        "\${1:-}" "\$status" "\$assignee"
    fi
    ;;
  ready) [ "\$status" = open ] && printf '[{"id":"child","title":"Child"}]\n' || printf '[]\n' ;;
  list) [ "\$status" = closed ] && printf '[]\n' || printf '[{"id":"child","status":"%s"}]\n' "\$status" ;;
  update)
    id="\${1:-}"; shift || true
    case " \$* " in
      *' --assignee '*)
        args=("\$@")
        for ((i = 0; i < \${#args[@]}; i++)); do [ "\${args[\$i]}" = --assignee ] && printf '%s' "\${args[\$((i + 1))]}" > "\$state/assignee"; done
        ;;
      *' --claim '*|*' --status open '*) printf open > "\$state/status" ;;
      *' --status blocked '*) printf blocked > "\$state/status" ;;
    esac
    ;;
  close) printf closed > "\$state/status" ;;
  note|comment|label|merge-slot|swarm) ;;
esac
exit 0
EOF
  chmod +x "$bin/bd"
}

# --- 2a. claude harness worker: emits a real session_id, transcript has 2
# pre-edit calls then an Edit. The done event and summary.md line must carry
# the matching orientation numbers.
CASE="$TMP_ROOT/claude-case"
REPO="$CASE/repo"; BIN="$CASE/bin"; STATE="$CASE/state"; RUN="$CASE/run"
FAKE_HOME="$CASE/home"
mkdir -p "$STATE" "$RUN" "$FAKE_HOME/.claude/projects/-fixture-repo"
make_repo "$REPO"
make_bin "$BIN" "$STATE"
printf open > "$STATE/status"
SID='11111111-1111-1111-1111-111111111111'
cat > "$FAKE_HOME/.claude/projects/-fixture-repo/$SID.jsonl" <<EOF
{"type":"assistant","timestamp":"2026-08-04T10:00:00.000Z","message":{"content":[{"type":"tool_use","name":"Bash","id":"t1"}],"usage":{"input_tokens":100,"cache_creation_input_tokens":10,"cache_read_input_tokens":9999,"output_tokens":20}}}
{"type":"assistant","timestamp":"2026-08-04T10:00:05.000Z","message":{"content":[{"type":"tool_use","name":"Read","id":"t2"}],"usage":{"input_tokens":200,"cache_creation_input_tokens":0,"cache_read_input_tokens":1000,"output_tokens":30}}}
{"type":"assistant","timestamp":"2026-08-04T10:00:12.000Z","message":{"content":[{"type":"tool_use","name":"Edit","id":"t3"}],"usage":{"input_tokens":300,"cache_creation_input_tokens":0,"cache_read_input_tokens":500,"output_tokens":40}}}
EOF
# A fake `claude` binary (not COOKEPIC_WORKER_CMD, which always forces
# HARNESS=worker-cmd and COST_SUPPORTED=0) so the real claude|ccx code path —
# and orientation_metrics's COST_SUPPORTED gate — actually runs.
cat > "$BIN/claude" <<EOF
#!/usr/bin/env bash
set -uo pipefail
printf 'work\n' >> work.txt
git add work.txt && git commit -qm 'child work'
bd close "\$COOKEPIC_CHILD"
jq -cn --arg sid "$SID" '{type:"result",session_id:\$sid,total_cost_usd:0,result:"done"}'
EOF
chmod +x "$BIN/claude"
# Real systemd-run supervision is required for the claude|ccx path (the
# DISABLE_SYSTEMD test hook only bypasses it for COOKEPIC_WORKER_CMD), so this
# case keeps the ambient session environment (DBUS/XDG_RUNTIME_DIR) and only
# overrides HOME plus any COOKEPIC_* this test might have inherited from an
# enclosing cook-epic run.
(
  cd "$REPO"
  for v in "${!COOKEPIC_@}"; do unset "$v"; done
  unset FLEET_UNIT  # this test may itself be running inside a cook-epic worker scope
  export HOME="$FAKE_HOME" PATH="$BIN:$PATH"
  export COOKEPIC_EPIC=epic COOKEPIC_HARNESS=claude COOKEPIC_BIN="$BIN/claude"
  export COOKEPIC_SEQUENTIAL=1 COOKEPIC_GATE=true COOKEPIC_NO_PUSH=1 COOKEPIC_SPAWN_DELAY=0
  export COOKEPIC_MAX_DISPATCHES=1 COOKEPIC_MAX_ATTEMPTS=1 COOKEPIC_WORKER_TIMEOUT=60
  exec "$RUNNER" "$RUN"
) > "$CASE/stdout" 2>&1 || fail "claude-harness fixture run failed: $(cat "$CASE/stdout")"
# mailbox.jsonl entries are jq-pretty-printed (mbox's second jq pass has no
# -c), so compare via jq rather than a compact-JSON substring match.
done_orientation=$(jq -s -c '[.[] | select(.event == "done")][-1].orientation' "$RUN/mailbox.jsonl")
[ "$done_orientation" = '{"secondsToFirstEdit":12,"toolCallsBeforeFirstEdit":2,"tokensBeforeFirstEdit":360}' ] \
  || fail "claude-harness done event orientation: got $done_orientation"
assert_contains "$RUN/summary.md" '- child orientation: 12s to first edit, 2 tool calls, 360 tokens before first edit'

# --- 2b. non-claude harness (COOKEPIC_WORKER_CMD with no claude/ccx harness):
# orientation:null in the mailbox, and reaping proceeds normally.
CASE="$TMP_ROOT/plain-case"
REPO="$CASE/repo"; BIN="$CASE/bin"; STATE="$CASE/state"; RUN="$CASE/run"
mkdir -p "$STATE" "$RUN"
make_repo "$REPO"
make_bin "$BIN" "$STATE"
printf open > "$STATE/status"
cat > "$BIN/worker.sh" <<'EOF'
#!/usr/bin/env bash
set -uo pipefail
printf 'work\n' >> work.txt
git add work.txt && git commit -qm 'child work'
bd close "$COOKEPIC_CHILD"
EOF
chmod +x "$BIN/worker.sh"
(
  cd "$REPO" && exec env -i PATH="$BIN:$PATH" \
    COOKEPIC_EPIC=epic COOKEPIC_HARNESS=worker-cmd COOKEPIC_WORKER_CMD="$BIN/worker.sh" \
    COOKEPIC_SEQUENTIAL=1 COOKEPIC_GATE=true COOKEPIC_NO_PUSH=1 COOKEPIC_SPAWN_DELAY=0 \
    COOKEPIC_MAX_DISPATCHES=1 COOKEPIC_MAX_ATTEMPTS=1 COOKEPIC_WORKER_TIMEOUT=60 COOKEPIC_DISABLE_SYSTEMD=1 \
    "$RUNNER" "$RUN"
) > "$CASE/stdout" 2>&1 || fail "non-claude fixture run failed: $(cat "$CASE/stdout")"
done_orientation=$(jq -s -c '[.[] | select(.event == "done")][-1].orientation' "$RUN/mailbox.jsonl")
[ "$done_orientation" = null ] || fail "non-claude done event orientation: got $done_orientation, want null"
assert_not_contains "$RUN/summary.md" 'orientation:'

printf 'cook-epic orientation-metrics fixture tests passed\n'
