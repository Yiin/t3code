# Verify an epic run survives a server restart

`systemctl --user restart t3code.service` must not kill an epic run. The boot
path continues each interrupted child's own agent session in its own iteration
row. This page holds the recipe that proves it on this machine, and the risk
register for the things that can still go wrong.

Read [epic-runs.md](../epic-runs.md) for what a boot resume checks and which
blockers park a run. This page does not repeat those rules.

## Run the check as a detached script

The restart kills the session that is watching it. Run the recipe from a plain
shell, never from inside a T3 Code thread, and detach it:

```bash
setsid nohup bash /tmp/verify-resume.sh > /tmp/verify-resume.out 2>&1 &
```

The script writes one `PASS` or `FAIL` line per check to
`/tmp/verify-resume.report`. It needs a run that is already `running`; it does
not start one.

`server.trace.ndjson` rotates about once a minute under an active run, into
eleven files of roughly 10 MB. The script therefore records byte offsets before
the restart and reads forward from them, rather than grepping the whole set
afterwards.

## The script

```bash
#!/usr/bin/env bash
# /tmp/verify-resume.sh — prove that an epic run survives a service restart.
set -uo pipefail

REPO="${REPO:-$HOME/Projects/t3code}"
DB="$HOME/.t3/userdata/state.sqlite"
LOG="$HOME/.t3/userdata/logs/boot-service.log"
TRACE="$HOME/.t3/userdata/logs/server.trace.ndjson"
REPORT=/tmp/verify-resume.report
: > "$REPORT"

say() { printf '%s %s\n' "$1" "$2" | tee -a "$REPORT"; }
die() { say FAIL "$1"; exit 1; }
q()   { sqlite3 -readonly "$DB" "$1"; }

cd "$REPO" || die "0 repo missing: $REPO"

# 0. Refuse to expose work the operator did not mean to expose.
DIRTY="$(git status --porcelain=2 --untracked-files=all)"
if [ -n "$DIRTY" ]; then
  printf '%s\n' "$DIRTY" >> "$REPORT"
  [ "${ALLOW_DIRTY:-0}" = 1 ] || die "0 working tree is dirty; re-run with ALLOW_DIRTY=1 after reading the paths above"
  say WARN "0 running with a dirty tree by request"
else
  say PASS "0 working tree is clean"
fi

# 1. The deployed binary must be at least as new as HEAD.
bun run build || die "1 build failed"
BIN_EPOCH="$(stat -c %Y apps/server/dist/bin.mjs)"
HEAD_EPOCH="$(git log -1 --format=%ct)"
[ "$BIN_EPOCH" -ge "$HEAD_EPOCH" ] ||
  die "1 apps/server/dist/bin.mjs ($(date -d @"$BIN_EPOCH" -Is)) is older than HEAD ($(date -d @"$HEAD_EPOCH" -Is))"
say PASS "1 dist/bin.mjs is newer than HEAD"

# 2. Snapshot the run and every iteration row it has in flight.
RUNS="$(q "select run_id||'|'||epic_id||'|'||status||'|'||coalesce(last_error,'') from epic_runs where status='running';")"
[ -n "$RUNS" ] || die "2 no epic run is running; start one and re-run"
RUN_ID="${RUNS%%|*}"
BEFORE="$(q "select iteration_index||'|'||coalesce(worker_id,'')||'|'||coalesce(issue_id,'')||'|'||coalesce(branch,'')||'|'||coalesce(worktree_path,'')||'|'||coalesce(thread_id,'') from epic_run_iterations where run_id='$RUN_ID' and turn_status='running' order by iteration_index;")"
[ -n "$BEFORE" ] || die "2 run $RUN_ID has no running iteration to interrupt"
printf 'run %s\n%s\n' "$RUNS" "$BEFORE" >> "$REPORT"
say PASS "2 snapshotted run $RUN_ID with $(printf '%s\n' "$BEFORE" | wc -l) in-flight iteration(s)"

# 3. Record log offsets before anything can rotate them.
LOG_OFFSET="$(wc -c < "$LOG")"
TRACE_OFFSET="$(wc -c < "$TRACE")"
say PASS "3 offsets recorded: log=$LOG_OFFSET trace=$TRACE_OFFSET"

# 4. Restart.
systemctl --user restart t3code.service || die "4 restart failed"
say PASS "4 restarted t3code.service"

# 5. Poll for the run to come back, up to 120 s.
for _ in $(seq 1 60); do
  STATUS="$(q "select status from epic_runs where run_id='$RUN_ID';")"
  [ "$STATUS" = running ] && break
  sleep 2
done
[ "$STATUS" = running ] || die "5 run $RUN_ID is '$STATUS' after 120 s, not running"
say PASS "5 run $RUN_ID is running again"

# 6. The same rows must still be the live ones.
LAST_ERROR="$(q "select coalesce(last_error,'') from epic_runs where run_id='$RUN_ID';")"
[ -z "$LAST_ERROR" ] || die "6 last_error is set: $LAST_ERROR"
while IFS='|' read -r IDX _ ISSUE _ _ _; do
  [ -n "$IDX" ] || continue
  ROW="$(q "select turn_status||'|'||coalesce(failure_reason,'')||'|'||resume_count from epic_run_iterations where run_id='$RUN_ID' and iteration_index=$IDX;")"
  case "$ROW" in
    abandoned\|server-restart*) die "6 iteration $IDX ($ISSUE) was abandoned, not resumed" ;;
    running\|*) say PASS "6 iteration $IDX ($ISSUE) still running, resume_count=${ROW##*|}" ;;
    *) die "6 iteration $IDX ($ISSUE) is '$ROW'" ;;
  esac
done <<< "$BEFORE"

# 7. The boot path must say what it did. The logger prints the annotation
#    object on the lines after the message, so grep needs -A6.
BOOT="$(tail -c "+$((LOG_OFFSET + 1))" "$LOG")"
printf '%s' "$BOOT" | grep -q "epic.runner.start-failed" && die "7 epic.runner.start-failed in boot log"
printf '%s' "$BOOT" | grep -q "epic.runner.restart-reconcile-failed" && die "7 epic.runner.restart-reconcile-failed in boot log"
printf '%s' "$BOOT" | grep -A6 "epic.runner.restart-resume" >> "$REPORT"
printf '%s' "$BOOT" | grep -A6 "epic.runner.restart-resume" | grep -q "resumed" ||
  die "7 no epic.runner.restart-resume in boot log"
printf '%s' "$BOOT" | grep -A6 "epic.runner.started" >> "$REPORT"
say PASS "7 boot log carries restart-resume and no start failure"

# 8. The typed per-session signal. epic.runner.resume-outcome is logged once per
#    resumed iteration with its outcome arm.
printf '%s' "$BOOT" | grep -A6 "epic.runner.resume-outcome" >> "$REPORT"
if printf '%s' "$BOOT" | grep -q "epic.runner.resume-outcome"; then
  say PASS "8 epic.runner.resume-outcome observed"
else
  say UNOBSERVABLE "8 no epic.runner.resume-outcome; the resume may have refused before dispatch"
fi
tail -c "+$((TRACE_OFFSET + 1))" "$TRACE" | grep -c "provider.session.resume.settled" >> "$REPORT"

# 9. The claims must have survived.
while IFS='|' read -r _ _ ISSUE _ _ _; do
  [ -n "$ISSUE" ] || continue
  S="$(bd show "$ISSUE" --json | jq -r '(if type=="array" then .[0] else . end).status')"
  [ "$S" = in_progress ] && say PASS "9 $ISSUE is still in_progress" || die "9 $ISSUE is '$S', not in_progress"
done <<< "$BEFORE"

say DONE "report at $REPORT"
```

## What was observed on 2026-08-12

Steps 0 to 3 ran on this machine. Steps 4 to 9 did not: the only `running` run
was the epic run that owned the session writing this page, so restarting the
service would have interrupted the very work being documented. Run them against
a run you are willing to interrupt.

Step 0 passed on a clean tree. Step 1 **failed**, and that is the point of the
check: `apps/server/dist/bin.mjs` was built at `09:58:16Z` while HEAD was
committed at `20:43:10Z`, ten hours later. The live `state.sqlite` still had no
`resume_count` column, so the deployed server had never run migration 056 and
could not have resumed anything. A restart test against that binary would have
measured the old code. Step 2 found run `7cd230d0` on `t3code-y5l` with one
in-flight iteration. Step 3 recorded `boot-service.log` at 7 432 791 bytes and
`server.trace.ndjson` at 7 480 560 bytes.

## Risk register

### The deployed binary is behind HEAD

Observed twice, on 2026-08-08 and 2026-08-12. A restart then tests the old
build, and a resume feature that has not shipped to `dist` reads as broken.
Mitigation: step 1 of the script, and `stat -c %y apps/server/dist/bin.mjs`
against `git log -1 --format=%cI` before any manual restart.

### The transcript is truncated mid-turn

The process dies between a tool-use block and its result, so the last thing in
the transcript is a tool call with no answer. Measured on 2026-08-12 across
`claudeAgent`, `codex`, `kimi`, `grok` and `opencode`: every one truncates at
that point and none rejects the dangling block on the next request, after a
`kill -9` just as after a clean stop. `cursor` is unmeasured; it shares
`AcpSessionRuntime.ts` with `kimi` and `grok`, which both pass. Covered by the
session-lifecycle conformance suite,
`apps/server/src/provider/testUtils/sessionLifecycleConformance.ts`.

### The resumed agent re-does work it already committed

`headBefore` never reaches the database. `EpicRunnerPoolPorts.ts` strips it and
`headAfter` before persisting an iteration row, so the boot path cannot tell the
agent where its own work started. Mitigation: the resume prompt does not claim
to know. `EPIC_RUN_RESTART_RESUME_PROMPT` in `packages/epic-core/src/policy.ts`
says the process died mid-command and that nothing the agent started is proven
to have landed, and carries `git status --porcelain=v1` plus `git diff --stat`
from `PoolVcsShape.worktreeEvidence`, each capped at 4000 characters. HEAD, the
fingerprint and the comment count are re-baselined at resume time.

### The resume adopts the operator's own edits

A resume forgives dirt so the interrupted agent can keep its unfinished work,
and could forgive the wrong dirt. `blockerPolicy` in
`packages/epic-core/src/EpicRunPreflight.ts` decides this from `mode` and
`intent`: only sequential plus resume accepts a dirty base tree, reported as a
`dirty_tree_accepted` warning with the paths. A parallel resume still blocks,
because a dirty base tree there belongs to the operator. Per-worker worktrees
are forgiven only when the run names them, and an unknown nested worktree still
blocks `dirty_tree`. Five runs in the live database failed `dirty_tree` before
this rule existed.

### The reaper boot sweep races the runner

`ProviderSessionReaper` stops every binding whose process died with the old
server. If it ran after `EpicRunner.start()` it would stop the sessions the
resume just picked up. `startBootReactors` in
`apps/server/src/serverRuntimeStartup.ts` fixes the order: orchestration
reactors, then the reaper's synchronous boot pass, then the runner. The stop
does not destroy the resume cursor. Covered by "starts the boot reactors in
reconciliation-safe order" in `serverRuntimeStartup.test.ts`.

### The provider silently drops the cursor

`ProviderService.startSession` inherits a persisted resume cursor only when the
provider instance id still matches. A reconfigured or disabled instance gets a
blank session instead of an error. Mitigation: `describeSessionResume` reports
the verdict before anything starts, including
`continuation-identity-changed`, and `resumeIteration` refuses unless the
adapter reports `sessionOrigin: "resumed"`. A refusal is scored, not hidden:
`infra:resume-unsupported`, `infra:resume-blocked` or `infra:resume-failed`.

### The server crash-loops instead of resuming

`Restart=always` with `RestartSec=10`, bounded by `StartLimitIntervalSec=900`
and `StartLimitBurst=30` from
`~/.config/systemd/user/t3code.service.d/resilience.conf`. Thirty restarts in
fifteen minutes stops the service outright. Each of those restarts spends resume
budget: `MAX_RESUMES_PER_ITERATION` in `EpicRunner.ts` is 1, so an iteration
resumes once and is handed to a fresh pinned iteration after that. A crash loop
therefore burns the run down rather than looping on it forever.

### A bead claim is stranded when the resume fails

A refused resume must not leave a child claimed with nothing driving it.
`abandonResume` in `ParallelEpicLoop.ts` returns `released` or `handoff`.
`workspace-missing` and `child-closed` release the claim and the worktree.
`capability`, `no-durable-state`, `not-continued` and `failed` hand both to a
fresh pinned iteration in the same worktree, which is why the claim is re-taken
before the capability is checked. A boot blocked at preflight releases every
claimed child and parks the run `paused`. Step 9 of the script is the check.

### Several iterations are interrupted at once

Runs are parallel by default, so one restart can interrupt N iterations.
`epic_run_iterations` carries `worker_id`, `branch` and `worktree_path` per row,
and `classifyInterruptedIterations` decides each row on its own: it resumes a
row only when it names a child, its worktree survived or is null in sequential
mode, and `resume_count` is under the cap. The rest are abandoned by index, so
abandoning one row cannot stop a session another row is about to continue. One
`epic.runner.restart-resume` line per run carries the counts and the per-row
refusal reasons. Step 6 of the script walks every row, not just the first.

### A worker scope unit outlives its server

Worker CLIs run in `cook-epic-<scopeId>-<worker>.scope` under
`cook-epic.slice`, outside the `t3code.service` cgroup, so a restart does not
kill them. Two outlived their server on 2026-08-08. A fresh probe would read the
leftover unit as a fatal name collision. `prepareWorkerScope(identity, {
reclaimOwnScopes })` in `packages/epic-core/src/workerScope.ts` stops the units
carrying the run's own identity at boot and re-probes to prove they are gone.
