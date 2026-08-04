#!/usr/bin/env bash
# ralph watch — stream a run's mailbox through the invoking harness's
# long-running monitor/session mechanism.
#
# It reads $RUN_DIR/mailbox.jsonl — the structured, self-authored message each
# iteration posts (what it built + why, plus the commit subjects) — formats one
# readable line per new record, and exits when it sees the terminal "finished"
# record.
#
# Usage (as a Monitor command): watch.sh <run-dir>
set -uo pipefail

RUN_DIR="${1:?usage: watch.sh <run-dir>}"
MBOX="$RUN_DIR/mailbox.jsonl"

# jq program: render one mailbox record as a single human line.
# cost and total_cost are recorded in mailbox.jsonl but never rendered:
# dollar figures stay out of the chat transcript. Read the mailbox directly
# if you need them.
FMT='
  if .status=="finished" then
    "🏁 loop finished: \(.reason) — \(.iters) iterations"
  else
    (if .status=="done" then
      "✅ iter \(.iter): \(.summary)" + (if (.why // "")!="" then " — why: \(.why)" else "" end)
    elif .status=="backlog-empty" then
      "🏁 iter \(.iter): backlog empty (RALPH_DONE) — nothing left to build"
    elif .status=="no-commit" then
      "○ iter \(.iter): ran but committed nothing"
    elif .status=="timeout" then
      "⏱ iter \(.iter): timed out"
    elif .status=="error" then
      "⚠ iter \(.iter): exited rc=\(.rc)"
    elif .status=="protocol-error" then
      "⚠ iter \(.iter): protocol error" + (if (.detail // "")!="" then " — \(.detail)" else "" end)
    else
      "• iter \(.iter): \(.status)"
    end)
  end
'

# run.sh may still be spinning up — wait up to 60s for the mailbox to appear.
for ((attempt = 0; attempt < 60; attempt++)); do
  [ -f "$MBOX" ] && break
  sleep 1
done
[ -f "$MBOX" ] || { echo "ralph watch: no mailbox at $RUN_DIR"; exit 1; }

# Follow complete JSON records and let jq terminate the stream after rendering
# the final record. Invalid JSON remains visible and fails the watcher.
tail -n +1 -F -- "$MBOX" | jq --unbuffered -r "
  if .status == \"finished\" then
    ($FMT), halt
  else
    ($FMT)
  end
"
pipeline_status=("${PIPESTATUS[@]}")
tail_rc=${pipeline_status[0]}
jq_rc=${pipeline_status[1]}

[ "$jq_rc" -eq 0 ] || exit "$jq_rc"
# jq closes the pipe intentionally after the terminal record, so SIGPIPE is
# the expected successful exit for tail.
if [ "$tail_rc" -ne 0 ] && [ "$tail_rc" -ne 141 ]; then
  exit "$tail_rc"
fi
