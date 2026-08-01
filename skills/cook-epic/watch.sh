#!/usr/bin/env bash
# cook-epic watch — stream a run's mailbox through the invoking harness's
# long-running monitor mechanism. One readable line per event; exits on the
# terminal "finished" record.
#
# Usage (as a Monitor/background command): watch.sh <run-dir>
set -uo pipefail

RUN_DIR="${1:?usage: watch.sh <run-dir>}"
MBOX="$RUN_DIR/mailbox.jsonl"

FMT='
  def landing:
    if has("landing") then .landing
    elif (.verified? == false) then
      if .pushed? == true then "pushed, landed unverified" else "landed unverified locally" end
    elif (.pushed? == true) then "gated, pushed, landed"
    else "gated, landed locally"
    end;
  def verification:
    if .verified? == false then "unverified"
    elif .verified? == true then "verified"
    else "verified" # mailbox lines written before verified existed
    end;
  # total_cost is deliberately not printed: dollar figures must not be
  # surfaced in chat. It stays in mailbox.jsonl for anyone who asks.
  # (Keep this comment apostrophe-free: FMT is a single-quoted shell string.)
  if .event=="finished" then
    "🏁 cook-epic finished: \(.reason) — dispatched \(.dispatched // 0), landed \(.merged // 0), \(verification)"
  elif .event=="dispatched" then
    "🚀 \(.child): \(.worker) dispatched on \(.branch)"
  elif .event=="done" then
    "✅ \(.child): \(landing) (\(.commits) commits) — \(.summary)"
  elif .event=="merged" then
    "🎯 \(.child): \(landing) on base via \(.branch) (\(.commit))"
  elif .event=="parked" then
    "⚠ \(.child): merge of \(.branch) parked (\(.reason)) — merge-fix \(.fix) created"
  elif .event=="retry" then
    "↻ \(.child): attempt \(.attempt)/\(.max) failed (\(.reason)) — requeued"
  elif .event=="blocked" then
    "⛔ \(.child): blocked after \(.attempts) attempts (\(.reason)) — needs a human"
  elif .event=="rate-limited" then
    "⏳ \(.child): \(.worker) hit a rate limit — requeueing in 120s"
  elif .event=="worker-idle" then
    "idle \(.child): \(.worker) has no progress for \(.idleSeconds)s"
  elif .event=="inspection-started" then
    "inspect \(.child): structural liveness check started (limit \(.timeoutSeconds)s)"
  elif .event=="inspection-continue" then
    "continue \(.child): \(.rationale) (check again in \(.nextCheckSeconds)s)"
  elif .event=="inspection-uncertain" then
    "uncertain \(.child): \(.reason) (check again in \(.nextCheckSeconds)s)"
  elif .event=="inspection-stop-pending" then
    "confirm stop \(.child): \(.rationale) (fresh check in \(.nextCheckSeconds)s)"
  elif .event=="inspection-stop" then
    "stop \(.child): inspector found the worker stuck (\(.rationale))"
  else
    "• \(.child // "-"): \(.event)"
  end
'

for ((attempt = 0; attempt < 60; attempt++)); do
  [ -f "$MBOX" ] && break
  sleep 1
done
[ -f "$MBOX" ] || { echo "cook-epic watch: no mailbox at $RUN_DIR"; exit 1; }

tail -n +1 -F -- "$MBOX" | jq --unbuffered -r "
  if .event == \"finished\" then
    ($FMT), halt
  else
    ($FMT)
  end
"
pipeline_status=("${PIPESTATUS[@]}")
tail_rc=${pipeline_status[0]}
jq_rc=${pipeline_status[1]}

[ "$jq_rc" -eq 0 ] || exit "$jq_rc"
# jq closes the pipe intentionally after the terminal record; SIGPIPE (141) is
# the expected successful exit for tail.
if [ "$tail_rc" -ne 0 ] && [ "$tail_rc" -ne 141 ]; then
  exit "$tail_rc"
fi
