#!/usr/bin/env bash
# cook-epic watch — stream a run's mailbox through the invoking harness's
# long-running monitor mechanism. One readable line per event; exits when the
# run reports a terminal status (done, failed, or cancelled).
#
# The mailbox is the shared core's FileRunEvents stream: one JSON RunEvent per
# line (run-state-changed, iteration-state-changed, provider-fallback,
# child-claim-released, subagent-liveness-*).
#
# Usage (as a Monitor/background command): watch.sh <run-dir>
set -uo pipefail

RUN_DIR="${1:?usage: watch.sh <run-dir>}"
MBOX="$RUN_DIR/mailbox.jsonl"

FMT='
  def issue: (.iteration.issueId // .issueId // "-");
  # Keep this comment apostrophe-free: FMT is a single-quoted shell string.
  # run-state-changed fires on every journal save; only the terminal ones
  # render a line.
  if .type=="run-state-changed" then
    if .run.status == "running" then ""
    else "🏁 cook-epic finished: \(.run.status)\(if .run.lastError then " — \(.run.lastError)" else "" end) — iterations \(.run.iterationsCompleted)/\(.run.maxIterations)" end
  elif .type=="iteration-state-changed" then
    if .iteration.turnStatus == "running" then
      "🚀 \(issue): iteration \(.iteration.iterationIndex) dispatched"
    elif .iteration.turnStatus == "completed" then
      "✅ \(issue): completed — \(.iteration.summary // "done")"
    else
      "↻ \(issue): \(.iteration.turnStatus) (\(.iteration.failureReason // "unknown"))\(if .iteration.summary then " — \(.iteration.summary)" else "" end)"
    end
  elif .type=="provider-fallback" then
    "⇄ \(issue): provider fallback \(.fromDriver) → \(.toDriver) (\(.failureReason))"
  elif .type=="child-claim-released" then
    "⚠ \(issue): claim released — \(.reason)"
  elif .type=="subagent-liveness-degraded" then
    "• iteration \(.iterationIndex): liveness degraded — \(.evidence)"
  elif .type=="subagent-liveness-unavailable" then
    "• iteration \(.iterationIndex): liveness unavailable — \(.reason)"
  else ""
  end
'

for ((attempt = 0; attempt < 60; attempt++)); do
  [ -f "$MBOX" ] && break
  sleep 1
done
[ -f "$MBOX" ] || { echo "cook-epic watch: no mailbox at $RUN_DIR"; exit 1; }

watch_tmp=$(mktemp -d "${TMPDIR:-/tmp}/cook-epic-watch.XXXXXX")
watch_fifo="$watch_tmp/events"
tail_pid=''
cleanup() {
  [ -z "$tail_pid" ] || kill "$tail_pid" 2>/dev/null || true
  [ -z "$tail_pid" ] || wait "$tail_pid" 2>/dev/null || true
  rm -rf "$watch_tmp"
}
trap cleanup EXIT INT TERM HUP

mkfifo "$watch_fifo"
tail -n +1 -F -- "$MBOX" > "$watch_fifo" &
tail_pid=$!
terminal=0
while IFS= read -r event; do
  rendered=$(jq -r "$FMT" <<< "$event") || exit $?
  [ -z "$rendered" ] || printf '%s\n' "$rendered"
  status=$(jq -r 'select(.type=="run-state-changed") | .run.status // empty' <<< "$event") || exit $?
  case "$status" in
    done | failed | cancelled)
      terminal=1
      break
      ;;
  esac
done < "$watch_fifo"

[ "$terminal" -eq 1 ] || exit 1
