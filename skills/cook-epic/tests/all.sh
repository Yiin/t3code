#!/usr/bin/env bash
set -uo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
FILTER=${COOKEPIC_TESTS_FILTER:-}
PER_FILE_TIMEOUT_SECONDS=${COOKEPIC_TESTS_TIMEOUT_SECONDS:-120}
# The measured local suite is documented in SKILL.md. Keep the total ceiling
# higher than the per-file budget so every spec gets a result line.
TOTAL_CEILING_SECONDS=${COOKEPIC_TESTS_TOTAL_CEILING_SECONDS:-600}

[[ "$PER_FILE_TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ ]] || {
  echo "COOKEPIC_TESTS_TIMEOUT_SECONDS must be a positive integer" >&2
  exit 2
}
[[ "$TOTAL_CEILING_SECONDS" =~ ^[1-9][0-9]*$ ]] || {
  echo "COOKEPIC_TESTS_TOTAL_CEILING_SECONDS must be a positive integer" >&2
  exit 2
}

mapfile -t tests < <(
  find "$SCRIPT_DIR" -maxdepth 1 -type f -name '*.sh' ! -name 'all.sh' -printf '%f\n' | sort
)

descendant_identities() { # <root pid> -> pid sid, including the root
  ps -eo pid=,ppid=,sid= | awk -v root="$1" '
    { parent[$1] = $2; session[$1] = $3 }
    END {
      wanted[root] = 1
      do {
        changed = 0
        for (pid in parent) {
          if (wanted[parent[pid]] && !wanted[pid]) {
            wanted[pid] = 1
            changed = 1
          }
        }
      } while (changed)
      for (pid in wanted) {
        if (session[pid] != "") print pid, session[pid]
      }
    }
  '
}

run_without_systemd() { # <test path> <output path>
  local test_path="$1" output="$2" leader_file waiter leader deadline rc
  local identities sessions pid sid
  leader_file=$(mktemp "${TMPDIR:-/tmp}/cook-epic-test-leader.XXXXXX")
  setsid -f --wait bash -c 'printf "%s\n" "$$" > "$1"; exec bash "$2"' \
    cook-epic-test "$leader_file" "$test_path" >"$output" 2>&1 &
  waiter=$!
  deadline=$((SECONDS + PER_FILE_TIMEOUT_SECONDS))
  while kill -0 "$waiter" 2>/dev/null && (( SECONDS < deadline )); do sleep 0.1; done
  if ! kill -0 "$waiter" 2>/dev/null; then
    wait "$waiter"
    rc=$?
    rm -f "$leader_file"
    return "$rc"
  fi

  leader=$(cat "$leader_file" 2>/dev/null || true)
  identities=$(descendant_identities "$leader")
  sessions=$(awk '{print $2}' <<<"$identities" | sort -un)
  while read -r sid; do
    [[ "$sid" =~ ^[1-9][0-9]*$ ]] && kill -TERM -- "-$sid" 2>/dev/null || true
  done <<<"$sessions"
  deadline=$((SECONDS + 5))
  while kill -0 "$waiter" 2>/dev/null && (( SECONDS < deadline )); do sleep 0.1; done
  while read -r pid sid; do
    [[ "$pid" =~ ^[1-9][0-9]*$ ]] && kill -KILL "$pid" 2>/dev/null || true
    [[ "$sid" =~ ^[1-9][0-9]*$ ]] && kill -KILL -- "-$sid" 2>/dev/null || true
  done <<<"$identities"
  kill -KILL "$waiter" 2>/dev/null || true
  wait "$waiter" 2>/dev/null || true
  rm -f "$leader_file"
  return 124
}

started_at=$SECONDS
failures=0
selected=0
use_systemd=0
if [[ "${COOKEPIC_TESTS_DISABLE_SYSTEMD:-0}" != 1 ]] && \
  command -v systemd-run >/dev/null 2>&1 && \
  systemctl --user show-environment >/dev/null 2>&1; then
  use_systemd=1
fi
for name in "${tests[@]}"; do
  if [[ -n "$FILTER" && "$name" != *"$FILTER"* ]]; then
    continue
  fi
  selected=$((selected + 1))
  file_started=$SECONDS
  output=$(mktemp "${TMPDIR:-/tmp}/cook-epic-test.XXXXXX")

  if [[ "$use_systemd" -eq 1 ]]; then
    unit="cook-epic-test-${PPID}-${name%.sh}"
    command=(systemd-run --user --wait --collect --pipe --quiet
      --unit "$unit"
      --property "RuntimeMaxSec=${PER_FILE_TIMEOUT_SECONDS}s"
      --property "TimeoutStopSec=5s"
      bash "$SCRIPT_DIR/$name")
  fi

  if [[ "$use_systemd" -eq 1 ]]; then
    "${command[@]}" >"$output" 2>&1
    code=$?
  else
    # CI shells often have no user systemd manager. Track every descendant
    # session so a timed-out spec cannot leave its own detached workers alive.
    run_without_systemd "$SCRIPT_DIR/$name" "$output"
    code=$?
  fi
  if [[ "$code" -eq 0 ]]; then
    status=PASS
  else
    failures=$((failures + 1))
    if [[ "$code" -eq 124 || "$code" -eq 137 ]]; then
      status=TIMEOUT
    else
      status=FAIL
    fi
  fi
  duration=$((SECONDS - file_started))
  printf '%s: %s (%ss)\n' "$status" "$name" "$duration"
  if [[ "$status" != PASS ]]; then
    sed 's/^/  /' "$output" >&2
  fi
  rm -f "$output"
done

elapsed=$((SECONDS - started_at))
if [[ "$selected" -eq 0 ]]; then
  echo "No cook-epic tests matched COOKEPIC_TESTS_FILTER=${FILTER}" >&2
  exit 2
fi
if (( elapsed > TOTAL_CEILING_SECONDS )); then
  echo "FAIL: total ceiling exceeded (${elapsed}s > ${TOTAL_CEILING_SECONDS}s)" >&2
  failures=$((failures + 1))
fi
exit "$failures"
