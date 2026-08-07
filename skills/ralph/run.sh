#!/usr/bin/env bash
# ralph — fresh-context agent loop (Ralph pattern).
# Each iteration spawns the same headless harness that launched the skill.
# State lives in the repo (handoff file, issue tracker, git).
#
# Usage: run.sh <run-dir>        # run-dir must contain prompt.md
#
# Environment (all optional unless noted):
#   RALPH_HARNESS          auto, codex, claude, ccx, kimi, or opencode (default auto)
#   RALPH_MAX_ITER         max iterations                   (default 30)
#   RALPH_BUDGET_USD       total spend cap                  (Claude and ccx only)
#   RALPH_ITER_TIMEOUT     per-iteration timeout, seconds   (default 0 = none)
#   RALPH_PERMISSION_MODE  auto or bypassPermissions        (default auto)
#   RALPH_MODEL            harness-native model override
#   RALPH_BIN              selected harness binary override
#   RALPH_EPIC             beads epic this loop targets; sets the run-lock key
#                          (otherwise inferred from prompt.md, then hashed)
#   CODEX_BIN              Codex binary                     (default codex)
#   CLAUDE_BIN             Claude binary                    (default claude)
#   KIMI_BIN               Kimi Code binary                 (default kimi)
#   OPENCODE_BIN           OpenCode binary                  (default opencode)
#
# Stop early: touch <run-dir>/STOP
set -uo pipefail

RUN_DIR="${1:?usage: run.sh <run-dir>}"
PROMPT_FILE="$RUN_DIR/prompt.md"
LOG="$RUN_DIR/loop.log"
SUMMARY="$RUN_DIR/summary.md"
MAILBOX="$RUN_DIR/mailbox.jsonl"
[ -f "$PROMPT_FILE" ] || { printf 'error: no prompt.md in %s\nhelp: create %s before launching Ralph\n' "$RUN_DIR" "$PROMPT_FILE"; exit 2; }

# Create the feed before the first child starts so a watcher never times out
# while a long first iteration is still running.
: > "$LOG"
: > "$SUMMARY"
: > "$MAILBOX"

say() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*" | tee -a "$LOG"; }

detect_ccx_environment() {
  [[ "${ANTHROPIC_BASE_URL:-}" =~ ^http://(localhost|127(\.[0-9]{1,3}){3}|\[::1\])(:[0-9]+)?(/.*)?$ ]] \
    && [ "${ANTHROPIC_AUTH_TOKEN:-}" = unused ] \
    && [[ "${ANTHROPIC_MODEL:-}" == *'[1m]' ]] \
    && [[ "${ANTHROPIC_SMALL_FAST_MODEL:-}" == *'[1m]' ]] \
    && [ "${CLAUDE_CODE_AUTO_COMPACT_WINDOW:-}" = 372000 ] \
    && [ "${CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:-}" = 1 ] \
    && [ "${CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK:-}" = 1 ]
}

detect_harness() {
  case "${RALPH_HARNESS:-auto}" in
    codex|claude|kimi|opencode)
      printf '%s\n' "$RALPH_HARNESS"
      return
      ;;
    ccx)
      detect_ccx_environment || return 3
      printf 'ccx\n'
      return
      ;;
    auto|'') ;;
    *) return 2 ;;
  esac

  # ccx has no distinct executable: detect its inherited proxy environment
  # before inspecting the Claude process that it launches.
  if detect_ccx_environment; then
    printf 'ccx\n'
    return
  fi

  # Prefer the nearest harness process. This resolves nested launches even
  # when both harnesses' environment markers were inherited.
  local pid="$PPID" row comm parent
  while [[ "$pid" =~ ^[0-9]+$ ]] && [ "$pid" -gt 1 ]; do
    row=$(ps -o comm= -o ppid= -p "$pid" 2>/dev/null) || break
    read -r comm parent <<< "$row"
    comm=${comm##*/}
    case "$comm" in
      codex|codex-*) printf 'codex\n'; return ;;
      claude|claude-*) printf 'claude\n'; return ;;
      kimi|kimi-*) printf 'kimi\n'; return ;;
      opencode|opencode-*) printf 'opencode\n'; return ;;
    esac
    pid=${parent//[[:space:]]/}
  done

  if [ -n "${CODEX_THREAD_ID:-}" ] && [ -z "${CLAUDECODE:-}${CLAUDE_CODE_SESSION_ID:-}" ]; then
    printf 'codex\n'
  elif [ -z "${CODEX_THREAD_ID:-}" ] && { [ "${CLAUDECODE:-}" = 1 ] || [ -n "${CLAUDE_CODE_SESSION_ID:-}" ]; }; then
    printf 'claude\n'
  elif [ -z "${CODEX_THREAD_ID:-}${CLAUDECODE:-}${CLAUDE_CODE_SESSION_ID:-}" ] \
    && [ -n "${OPENCODE:-}${OPENCODE_PID:-}" ]; then
    printf 'opencode\n'
  else
    return 1
  fi
}

HARNESS=$(detect_harness)
detect_rc=$?
if [ "$detect_rc" -ne 0 ]; then
  if [ "$detect_rc" -eq 2 ]; then
    printf 'error: invalid RALPH_HARNESS %s\nhelp: set RALPH_HARNESS to codex, claude, ccx, kimi, or opencode\n' "${RALPH_HARNESS:-}"
  elif [ "$detect_rc" -eq 3 ]; then
    printf 'error: RALPH_HARNESS=ccx requires the inherited ccx proxy environment\nhelp: launch Ralph from ccx or set its complete ccx environment signature\n'
  else
    printf 'error: could not identify the invoking harness\nhelp: set RALPH_HARNESS to codex, claude, ccx, kimi, or opencode\n'
  fi
  exit 2
fi

MAX_ITER="${RALPH_MAX_ITER:-30}"
BUDGET="${RALPH_BUDGET_USD:-}"
ITER_TIMEOUT="${RALPH_ITER_TIMEOUT:-0}"
PERM_MODE="${RALPH_PERMISSION_MODE:-auto}"
RALPH_ALSO_WATCH="${RALPH_ALSO_WATCH:-}"
total_cost=0
iters_run=0

case "$HARNESS" in
  claude|ccx)
    AGENT_BIN="${RALPH_BIN:-${CLAUDE_BIN:-claude}}"
    COST_SUPPORTED=1
    # Let Claude-compatible children finish any implementation work they
    # started in the background instead of applying the print-mode wait ceiling.
    export CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS="${CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS:-0}"
    ;;
  codex)
    AGENT_BIN="${RALPH_BIN:-${CODEX_BIN:-codex}}"
    COST_SUPPORTED=0
    ;;
  kimi)
    AGENT_BIN="${RALPH_BIN:-${KIMI_BIN:-kimi}}"
    COST_SUPPORTED=0
    ;;
  opencode)
    AGENT_BIN="${RALPH_BIN:-${OPENCODE_BIN:-opencode}}"
    COST_SUPPORTED=0
    ;;
esac

finish_record() {
  local reason="$1" total_json
  if [ "$COST_SUPPORTED" -eq 1 ]; then total_json="$total_cost"; else total_json=null; fi
  jq -cn --arg reason "$reason" --arg harness "$HARNESS" --argjson total "$total_json" --argjson iters "$iters_run" \
    '{iter:null,status:"finished",reason:$reason,iters:$iters,total_cost:$total,harness:$harness}' >> "$MAILBOX"
}

usage_error() {
  local message="$1" help="$2"
  printf 'error: %s\nhelp: %s\n' "$message" "$help" | tee -a "$LOG"
  finish_record "$message"
  exit 2
}

[[ "$MAX_ITER" =~ ^[1-9][0-9]*$ ]] || usage_error 'RALPH_MAX_ITER must be a positive integer' 'set RALPH_MAX_ITER to 1 or greater'
[[ "$ITER_TIMEOUT" =~ ^[0-9]+$ ]] || usage_error 'RALPH_ITER_TIMEOUT must be zero or a positive integer' 'set RALPH_ITER_TIMEOUT in whole seconds'
[ -z "$BUDGET" ] || [[ "$BUDGET" =~ ^[0-9]+([.][0-9]+)?$ ]] || usage_error 'RALPH_BUDGET_USD must be a positive number' 'remove RALPH_BUDGET_USD or provide a dollar amount'
command -v jq >/dev/null 2>&1 || usage_error 'jq is required' 'install jq and rerun Ralph'
command -v timeout >/dev/null 2>&1 || usage_error 'GNU timeout is required' 'install GNU coreutils and rerun Ralph'
command -v flock >/dev/null 2>&1 || usage_error 'flock is required' 'install util-linux and rerun Ralph'
command -v "$AGENT_BIN" >/dev/null 2>&1 || usage_error "selected $HARNESS binary not found: $AGENT_BIN" "install $HARNESS or set RALPH_BIN"

if { [ "$HARNESS" = codex ] || [ "$HARNESS" = kimi ] || [ "$HARNESS" = opencode ]; } && [ -n "$BUDGET" ]; then
  usage_error "$HARNESS does not report USD cost, so RALPH_BUDGET_USD cannot be enforced" 'remove RALPH_BUDGET_USD or launch the loop from Claude Code or ccx'
fi

if [ "$HARNESS" = kimi ]; then
  case "$PERM_MODE" in
    # kimi prompt mode runs tools non-interactively; both accepted modes map
    # to the same flagless invocation (it rejects -y/--auto combined with -p).
    auto|bypassPermissions) ;;
    *) usage_error "unsupported Kimi permission mode: $PERM_MODE" 'use auto or bypassPermissions' ;;
  esac
fi

if [ "$HARNESS" = opencode ]; then
  case "$PERM_MODE" in
    # OpenCode has one unattended permission switch. Both Ralph modes map to
    # --auto; bypassPermissions is accepted for parity, not as a stronger mode.
    auto|bypassPermissions) ;;
    *) usage_error "unsupported OpenCode permission mode: $PERM_MODE" 'use auto or bypassPermissions' ;;
  esac
fi

if [ "$HARNESS" = codex ]; then
  case "$PERM_MODE" in
    auto|bypassPermissions|read-only|workspace-write|danger-full-access) ;;
    *) usage_error "unsupported Codex permission mode: $PERM_MODE" 'use auto, bypassPermissions, read-only, workspace-write, or danger-full-access' ;;
  esac
fi

# --------------------------------------------------------------- run lock ----
# This is now the only Bash copy of the run-lock block. cook-epic's identical
# copy retired with the legacy coordinator (t3code-06s.42); the shared core
# uses NodeEpicRunLock on the same file format.
#
# Why it exists: a t3code server run and a terminal /ralph or /cook-epic can aim
# at the same beads epic in the same repo. Per-child `bd update --claim` does
# not stop that — two coordinators still interleave gates, merges and the
# machine-global cook-epic.slice. Epic-level exclusion belongs in the runners
# because that is the one place both entry points pass through.
#
# Payload, at <beads-dir>/run-lock.<key>.json (a local POSIX filesystem is
# assumed — noclobber's O_EXCL is not dependable over NFS):
#   owner        t3code | terminal — which entry point holds it
#   host         a lock from another host is never stolen, only reported: we
#                cannot probe a pid we cannot see
#   bootId       /proc/sys/kernel/random/boot_id; a different boot makes every
#                recorded pid meaningless, so such a lock is stale outright
#   pid          the pid whose death ENDS the run. A long-lived server must
#                write a per-run supervisor pid here, never the daemon's, or a
#                leaked lock stays unstealable for as long as the daemon lives.
#   startTicks   that pid's start time (/proc/<pid>/stat field 22), so a
#                recycled pid is not mistaken for the original owner
#   pgid         process group containing in-flight workers. A stale lock is
#                stealable only after both pid and pgid are gone.
#   runDir       the holder's log/mailbox — what we point the user at
#   startedAt    ISO-8601, for humans reading the file
#   heartbeatAt  integer epoch seconds, for arithmetic here and server-side
RUNLOCK_HEARTBEAT_SECS="${RUNLOCK_HEARTBEAT_SECS:-30}"
RUNLOCK_STALE_SECS="${RUNLOCK_STALE_SECS:-300}"   # 10 missed heartbeats
RUNLOCK_FILE=''
RUNLOCK_HELD=0
RUNLOCK_HB_PID=''
RUNLOCK_GUARD_FD=''
RUNLOCK_EPIC=''
RUNLOCK_OWNER=''

run_lock_host() { printf '%s\n' "${HOSTNAME:-$(uname -n 2>/dev/null)}"; }
run_lock_boot_id() { cat /proc/sys/kernel/random/boot_id 2>/dev/null || true; }

# comm (field 2) can contain spaces and parens, so count from the final ')'.
run_lock_start_ticks() { # <pid> -> start time in clock ticks ('' when gone)
  local stat
  stat=$(cat "/proc/$1/stat" 2>/dev/null) || return 0
  awk '{print $20}' <<< "${stat##*') '}"
}
run_lock_pgid() {
  local stat
  stat=$(cat /proc/self/stat 2>/dev/null) || { printf '0\n'; return 0; }
  awk '{print $3}' <<< "${stat##*') '}"
}

run_lock_dir() { # -> directory the lock file belongs in (fails when there is none)
  local beads redirect
  if [ -d .beads ]; then
    beads=$(cd .beads && pwd -P) || return 1
    # In a worktree .beads is only a redirect stub pointing at the main
    # checkout's real beads dir. Follow it, or a worktree run and a main-checkout
    # run of the same epic would take two different locks and exclude nothing.
    # bd's redirect path is relative to the checkout root, not to .beads.
    if [ -f "$beads/redirect" ]; then
      redirect=$(cat "$beads/redirect" 2>/dev/null)
      case "$redirect" in
        '') ;;
        /*) ;;
        *) redirect="$(dirname "$beads")/$redirect" ;;
      esac
      [ -n "$redirect" ] && [ -d "$redirect" ] && beads=$(cd "$redirect" && pwd -P)
    fi
    printf '%s\n' "$beads"
    return 0
  fi
  # No beads: the common git dir is shared by every worktree of the repo and is
  # never tracked, so the lock needs no exclude entry there.
  ( cd "$(git rev-parse --git-common-dir 2>/dev/null)" 2>/dev/null && pwd -P )
}

run_lock_exclude() { # <lock dir> — repo-local, uncommitted, mirrors the .worktrees idiom
  local dir="$1" common exclude
  common=$( cd "$(git rev-parse --git-common-dir 2>/dev/null)" 2>/dev/null && pwd -P ) || return 0
  [ -n "$common" ] || return 0
  case "$dir" in "$common"*) return 0 ;; esac
  # .beads/.gitignore is bd-owned, ignores *.lock but not run-lock.*.json, and
  # forbids negation patterns — so the repo-local exclude is the right lever.
  exclude="$common/info/exclude"
  mkdir -p "$common/info" 2>/dev/null || return 0
  grep -qxF '.beads/run-lock.*' "$exclude" 2>/dev/null || printf '%s\n' '.beads/run-lock.*' >> "$exclude"
}

run_lock_payload() { # <owner>
  jq -cn --arg owner "$1" --arg host "$(run_lock_host)" --arg boot "$(run_lock_boot_id)" \
    --arg ticks "$(run_lock_start_ticks "$$")" --arg runDir "$RUN_DIR" --arg started "$(date -Is)" \
    --argjson pid "$$" --argjson pgid "$(run_lock_pgid)" --argjson now "$(date +%s)" \
    '{owner:$owner,host:$host,bootId:$boot,pid:$pid,pgid:$pgid,startTicks:$ticks,runDir:$runDir,startedAt:$started,heartbeatAt:$now}'
}

run_lock_stale() { # <lock file> -> 0 only when the recorded owner is provably gone
  local lock="$1" now host pid pgid boot ticks hb mtime
  local -a f=()
  now=$(date +%s)
  # One field per line via mapfile, NOT `IFS=$'\t' read`: tab is an IFS
  # WHITESPACE character, so adjacent separators collapse and every field after
  # an empty one shifts left. A t3code-written lock carries no bootId and no
  # startTicks, so that shift would read the heartbeat as a foreign boot id and
  # declare a live lock stale without ever checking the pid.
  mapfile -t f < <(jq -r '(.host // ""),(.pid // 0),(.pgid // 0),(.bootId // ""),(.startTicks // ""),(.heartbeatAt // 0)' "$lock" 2>/dev/null)
  if [ "${#f[@]}" -ne 6 ]; then
    # Unparseable: judge it by its own age, so a truncated write cannot wedge
    # the epic forever while a freshly written one is still respected.
    mtime=$(stat -c %Y "$lock" 2>/dev/null) || return 1
    [ $((now - mtime)) -ge "$RUNLOCK_STALE_SECS" ]
    return
  fi
  host="${f[0]}"; pid="${f[1]}"; pgid="${f[2]}"; boot="${f[3]}"; ticks="${f[4]}"; hb="${f[5]}"
  [ "$host" = "$(run_lock_host)" ] || return 1
  [ -z "$boot" ] || [ "$boot" = "$(run_lock_boot_id)" ] || return 0
  [[ "$hb" =~ ^[0-9]+$ ]] || hb=0
  [ $((now - hb)) -ge "$RUNLOCK_STALE_SECS" ] || return 1
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 0
  if kill -0 "$pid" 2>/dev/null; then
    # Empty startTicks is the minimal t3code payload. When ticks are present,
    # a mismatch means this is a recycled pid, not the recorded owner.
    if [ -z "$ticks" ] || [ "$ticks" = "$(run_lock_start_ticks "$pid")" ]; then
      return 1
    fi
  fi
  # A coordinator can die while an in-flight worker in its process group is
  # still editing the repo. Respect that group until it drains too.
  [[ "$pgid" =~ ^[1-9][0-9]*$ ]] && kill -0 -- "-$pgid" 2>/dev/null && return 1
  return 0
}

run_lock_guard_acquire() {
  exec {RUNLOCK_GUARD_FD}> "$RUNLOCK_FILE.guard" || return 1
  flock -w 10 "$RUNLOCK_GUARD_FD" || {
    exec {RUNLOCK_GUARD_FD}>&-
    RUNLOCK_GUARD_FD=''
    return 1
  }
}

run_lock_guard_release() {
  [ -n "$RUNLOCK_GUARD_FD" ] || return 0
  flock -u "$RUNLOCK_GUARD_FD" 2>/dev/null || true
  exec {RUNLOCK_GUARD_FD}>&-
  RUNLOCK_GUARD_FD=''
}

# Both runners block for long stretches — a ralph iteration, a cook-epic gate —
# so nothing else would touch the lock while the run is perfectly healthy.
run_lock_heartbeat() { # <lock file> <owner pid>
  local lock="$1" owner="$2" inode tmp
  while sleep "$RUNLOCK_HEARTBEAT_SECS"; do
    # An orphan that outlived a SIGKILLed run would keep a dead lock looking
    # fresh forever, so re-check the owner before every refresh.
    kill -0 "$owner" 2>/dev/null || return 0
    inode=$(stat -c %i "$lock" 2>/dev/null) || return 0
    [ "$(jq -r '.pid // ""' "$lock" 2>/dev/null)" = "$owner" ] || return 0
    tmp="$lock.hb"
    jq -c --argjson now "$(date +%s)" '.heartbeatAt = $now' "$lock" > "$tmp" 2>/dev/null || { rm -f "$tmp"; continue; }
    # Re-check the inode: had the lock been declared stale and re-created in
    # this window, the rename would silently clobber its new owner.
    if [ "$(stat -c %i "$lock" 2>/dev/null)" = "$inode" ]; then mv -f "$tmp" "$lock"; else rm -f "$tmp"; fi
  done
}

run_lock_report_held() {
  local info
  info=$(jq -c --arg lock "$RUNLOCK_FILE" \
      '{event:"lock_held",owner:(.owner // null),runDir:(.runDir // null),host:(.host // null),pid:(.pid // null),lock:$lock}' \
      "$RUNLOCK_FILE" 2>/dev/null) \
    || info=$(jq -cn --arg lock "$RUNLOCK_FILE" '{event:"lock_held",owner:null,runDir:null,host:null,pid:null,lock:$lock}')
  printf '%s\n' "$info"
  say "another run already owns this epic — reporting, not retrying: $info"
}

run_lock_note() { # <text> — observability only; the lock FILE is authoritative
  [ -n "$RUNLOCK_EPIC" ] || return 0
  command -v bd >/dev/null 2>&1 || return 0
  bd note "$RUNLOCK_EPIC" "$RUNLOCK_OWNER run $1 (runDir $RUN_DIR)" >/dev/null 2>&1 || true
}

run_lock_acquire() { # <key> <owner> [epic] -> 1 when another run holds this epic
  local key="$1" owner="$2" dir payload attempt=0
  RUNLOCK_EPIC="${3:-}"
  RUNLOCK_OWNER="$owner"
  dir=$(run_lock_dir) || dir=''
  if [ -z "$dir" ]; then
    say 'no beads dir and no git dir here — running WITHOUT an epic run lock'
    return 0
  fi
  RUNLOCK_FILE="$dir/run-lock.$(printf '%s' "$key" | tr -c 'a-zA-Z0-9._-' '-').json"
  run_lock_exclude "$dir"
  payload=$(run_lock_payload "$owner")
  # Serialize the stale-check/remove/re-create sequence. O_EXCL makes creation
  # atomic, but without this guard two contenders can both classify the old
  # owner stale and the slower one can unlink the faster one's new lock.
  run_lock_guard_acquire || {
    run_lock_report_held
    return 1
  }
  # Two attempts at most: one to take a free lock, one after stealing a dead
  # one. Losing the re-create to a third party means someone else is live.
  while [ "$attempt" -lt 2 ]; do
    attempt=$((attempt + 1))
    if ( set -o noclobber; printf '%s\n' "$payload" > "$RUNLOCK_FILE" ) 2>/dev/null; then
      RUNLOCK_HELD=1
      run_lock_heartbeat "$RUNLOCK_FILE" "$$" &
      RUNLOCK_HB_PID=$!
      say "run lock acquired: $RUNLOCK_FILE"
      run_lock_note started
      run_lock_guard_release
      return 0
    fi
    run_lock_stale "$RUNLOCK_FILE" || break
    say "run lock held by a process that is provably gone — taking over $RUNLOCK_FILE"
    rm -f "$RUNLOCK_FILE"
  done
  run_lock_report_held
  run_lock_guard_release
  return 1
}

run_lock_release() { # EXIT trap: never leave a lock behind, never delete another run's
  run_lock_guard_release
  [ -n "$RUNLOCK_FILE" ] || return 0
  RUNLOCK_HELD=0
  [ -z "$RUNLOCK_HB_PID" ] || kill "$RUNLOCK_HB_PID" 2>/dev/null || true
  RUNLOCK_HB_PID=''
  # The pid check, not an "acquired" flag, is what makes this safe: a run that
  # lost the race, or died between creating the file and finishing acquire, can
  # only ever remove a lock that names its own pid.
  if [ "$(jq -r '.pid // ""' "$RUNLOCK_FILE" 2>/dev/null)" = "$$" ]; then
    rm -f "$RUNLOCK_FILE" "$RUNLOCK_FILE.hb"
    run_lock_note finished
  fi
}

PROMPT_CONTENT=$(<"$PROMPT_FILE")

# A ralph loop names its target in prose, so the lock key has to be inferred.
# An explicit RALPH_EPIC or an "Epic: <id>" line wins; then the first bd id in
# the prompt that really is an epic; then a hash of the prompt itself, so two
# copies of the same loop still exclude each other. Shape-filtering before
# probing bd matters: ralph's own vocabulary (fresh-context, cook-epic,
# end-to-end) is hyphenated exactly like a bd id, and would otherwise fill the
# probe budget before the real epic id is reached.
ralph_lock_key() { # prints the key; returns 0 only when that key is an epic id
  local tok hash probed=0 type
  if [ -n "${RALPH_EPIC:-}" ]; then printf '%s\n' "$RALPH_EPIC"; return 0; fi
  tok=$(grep -m1 -ioE '^[[:space:]]*epic:[[:space:]]*[^[:space:]]+' <<< "$PROMPT_CONTENT" | sed -E 's/.*:[[:space:]]*//')
  if [ -n "$tok" ]; then printf '%s\n' "$tok"; return 0; fi
  if command -v bd >/dev/null 2>&1 && [ -d .beads ]; then
    while read -r tok; do
      # Real bd ids end in a digit-bearing segment: t3code-vst.9, vangrd-uqi2.
      [[ "${tok##*-}" =~ [0-9] ]] || continue
      probed=$((probed + 1))
      [ "$probed" -le 10 ] || break
      type=$(bd show "$tok" --json 2>/dev/null | jq -r 'if type=="array" then .[0] else . end | (.issue_type // .type // "")' 2>/dev/null)
      [ "$type" = epic ] || continue
      printf '%s\n' "$tok"
      return 0
    done < <(grep -oE '[a-z][a-z0-9]*(-[a-z0-9]+([.][a-z0-9]+)*)+' <<< "$PROMPT_CONTENT" | sort -u)
  fi
  hash=$(printf '%s' "$PROMPT_CONTENT" | sha256sum 2>/dev/null | cut -c1-12)
  printf 'prompt-%s\n' "${hash:-default}"
  return 1
}

if RALPH_LOCK_KEY=$(ralph_lock_key); then RALPH_LOCK_EPIC="$RALPH_LOCK_KEY"; else RALPH_LOCK_EPIC=''; fi
# Ralph had no traps at all. INT is not an EXIT in bash, so Ctrl-C — the normal
# way a human stops a loop — would otherwise leak the lock until it goes stale.
# They are armed before the acquire: a signal delivered while the lock file is
# being written would otherwise kill the loop with no trap at all.
trap 'run_lock_release' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
if ! run_lock_acquire "$RALPH_LOCK_KEY" terminal "$RALPH_LOCK_EPIC"; then
  # Tell watchers the loop is over instead of leaving them hanging on a mailbox
  # that will never get a record.
  finish_record "another run already owns ${RALPH_LOCK_EPIC:-this loop} (see the lock_held record on stdout)"
  exit 75
fi


# Appended to every iteration's prompt.
PROTOCOL='

---
Loop protocol (you are one iteration of an unattended fresh-context loop):
- Complete ONE well-scoped unit of work end-to-end: implement, pass the quality gates, commit, push. Then stop.
- Never weaken, skip, or delete tests to make a gate pass. Never edit an issue'"'"'s scope — only its status and notes.
- When you finish the unit of work, end your FINAL message with exactly one line:
  RALPH_MSG: {"summary":"<what you built, one clause>","why":"<why it was needed, one clause>"}
  It must be valid compact JSON on a single line. This is how the loop reports your work to the operator.
- If there is no remaining work to pick up, output RALPH_DONE on its own line and change nothing.'

run_agent() {
  local prompt="$1" artifact="$2" remaining_budget="${3:-}"
  local -a args

  if [ "$HARNESS" = claude ] || [ "$HARNESS" = ccx ]; then
    args=(-p --permission-mode "$PERM_MODE" --output-format json)
    [ -n "${RALPH_MODEL:-}" ] && args+=(--model "$RALPH_MODEL")
    [ -n "$remaining_budget" ] && args+=(--max-budget-usd "$remaining_budget")
  elif [ "$HARNESS" = kimi ]; then
    # kimi -p takes the prompt as the option value; stream-json is JSONL with
    # {"role":"assistant"|"tool"|"meta", ...} records.
    args=(-p "$prompt" --output-format stream-json)
    [ -n "${RALPH_MODEL:-}" ] && args+=(-m "$RALPH_MODEL")
  elif [ "$HARNESS" = opencode ]; then
    args=(run --format json --auto)
    [ -n "${RALPH_MODEL:-}" ] && args+=(-m "$RALPH_MODEL")
  else
    case "$PERM_MODE" in
      auto) args=(-a never -s danger-full-access) ;;
      bypassPermissions) args=(--dangerously-bypass-approvals-and-sandbox) ;;
      *) args=(-a never -s "$PERM_MODE") ;;
    esac
    [ -n "${RALPH_MODEL:-}" ] && args+=(-m "$RALPH_MODEL")
    args+=(exec --json)
  fi

  if [ "$HARNESS" = claude ] || [ "$HARNESS" = ccx ]; then
    timeout "$ITER_TIMEOUT" "$AGENT_BIN" "${args[@]}" -- "$prompt" >"$artifact" 2>>"$LOG"
  elif [ "$HARNESS" = kimi ]; then
    timeout "$ITER_TIMEOUT" "$AGENT_BIN" "${args[@]}" >"$artifact" 2>>"$LOG"
  elif [ "$HARNESS" = opencode ]; then
    timeout "$ITER_TIMEOUT" "$AGENT_BIN" "${args[@]}" -- "$prompt" >"$artifact" 2>>"$LOG"
  else
    timeout "$ITER_TIMEOUT" "$AGENT_BIN" "${args[@]}" "$prompt" >"$artifact" 2>>"$LOG"
  fi
}

normalize_result() {
  local artifact="$1" normalized

  if [ "$HARNESS" = claude ] || [ "$HARNESS" = ccx ]; then
    normalized=$(jq -cs '
      if length == 1 then
        .[0] | {cost:(.total_cost_usd // 0), result:(.result // ""), session:(.session_id // "")}
      else
        error("expected one Claude result object")
      end
    ' "$artifact" 2>>"$LOG") || return 1
  elif [ "$HARNESS" = kimi ]; then
    normalized=$(jq -cs '{
      cost:null,
      result:([.[] | select(.role == "assistant") | .content] | last // ""),
      session:([.[] | select(.role == "meta") | .session_id] | first // "")
    }' "$artifact" 2>>"$LOG") || return 1
  elif [ "$HARNESS" = opencode ]; then
    normalized=$(jq -cs '{
      cost:null,
      result:([.[] | select(.type == "text" and .part.type == "text") | .part.text] | last // ""),
      session:([.[] | .sessionID] | first // "")
    }' "$artifact" 2>>"$LOG") || return 1
  else
    normalized=$(jq -cs '{
      cost:null,
      result:([.[] | select(.type == "item.completed" and .item.type == "agent_message") | .item.text] | last // ""),
      session:([.[] | select(.type == "thread.started") | .thread_id] | first // "")
    }' "$artifact" 2>>"$LOG") || return 1
  fi

  cost=$(jq -r '.cost | if . == null then "" else tostring end' <<< "$normalized") || return 1
  result=$(jq -r '.result' <<< "$normalized") || return 1
  session=$(jq -r '.session' <<< "$normalized") || return 1

  if [ "$HARNESS" = claude ] || [ "$HARNESS" = ccx ]; then
    cost_json="${cost:-0}"
    total_cost=$(jq -cn --argjson total "$total_cost" --argjson cost "${cost:-0}" '$total + $cost') || return 1
  else
    cost_json=null
  fi
}

format_cost() {
  awk -v amount="$1" 'BEGIN {printf "%.2f", amount}'
}

no_commit_streak=0
stop_reason="max iterations ($MAX_ITER) reached"
cost_label='$none'
[ "$COST_SUPPORTED" -eq 0 ] && cost_label='n/a'
[ -n "$BUDGET" ] && cost_label="\$$BUDGET"

say "ralph loop start: harness=$HARNESS cwd=$(pwd) max_iter=$MAX_ITER timeout=$([ "$ITER_TIMEOUT" = 0 ] && echo none || echo "${ITER_TIMEOUT}s") perm=$PERM_MODE budget=$cost_label"
[ -n "$(git status --porcelain 2>/dev/null)" ] && say 'WARNING: working tree dirty at start — another agent may be active in this repo'

for ((i = 1; i <= MAX_ITER; i++)); do
  if [ -e "$RUN_DIR/STOP" ]; then
    stop_reason='STOP file'; say 'STOP file found — exiting'; break
  fi

  # Backlog-dry exit for beads projects; skipped elsewhere.
  if command -v bd >/dev/null 2>&1 && [ -d .beads ]; then
    ready=$(bd ready --json 2>/dev/null | jq -r 'length' 2>/dev/null || echo '?')
    if [ "$ready" = 0 ]; then
      stop_reason='backlog dry (bd ready empty)'; say 'bd ready is empty — exiting'; break
    fi
  fi

  head_before=$(git rev-parse --verify -q HEAD 2>/dev/null || echo none)
  head_before_alt=none
  [ -n "$RALPH_ALSO_WATCH" ] && head_before_alt=$(git -C "$RALPH_ALSO_WATCH" rev-parse --verify -q HEAD 2>/dev/null || echo none)
  say "iteration $i/$MAX_ITER starting (HEAD ${head_before:0:9})"

  artifact="$RUN_DIR/iter-$i.json"
  remaining_budget=''
  if { [ "$HARNESS" = claude ] || [ "$HARNESS" = ccx ]; } && [ -n "$BUDGET" ]; then
    remaining_budget=$(jq -cn --argjson budget "$BUDGET" --argjson spent "$total_cost" '$budget - $spent')
  fi

  iters_run=$((iters_run + 1))
  run_agent "$PROMPT_CONTENT$PROTOCOL" "$artifact" "$remaining_budget"
  rc=$?

  if [ "$rc" -eq 124 ]; then
    say "iteration $i TIMED OUT after ${ITER_TIMEOUT}s"
  elif [ "$rc" -ne 0 ]; then
    say "iteration $i exited rc=$rc"
  fi

  parse_ok=1
  if ! normalize_result "$artifact"; then
    parse_ok=0
    cost=''
    result=''
    session=''
    if [ "$COST_SUPPORTED" -eq 1 ]; then cost_json=0; else cost_json=null; fi
    say "iteration $i returned invalid $HARNESS JSON; see $artifact"
  fi
  if [ "$COST_SUPPORTED" -eq 1 ]; then
    say "iteration $i done: cost=\$$(format_cost "${cost:-0}") total=\$$(format_cost "$total_cost")"
  else
    say "iteration $i done: cost=n/a"
  fi

  head_after=$(git rev-parse --verify -q HEAD 2>/dev/null || echo none)
  head_after_alt=none
  [ -n "$RALPH_ALSO_WATCH" ] && head_after_alt=$(git -C "$RALPH_ALSO_WATCH" rev-parse --verify -q HEAD 2>/dev/null || echo none)
  committed=0
  { [ "$head_before" != "$head_after" ] && [ "$head_after" != none ]; } && committed=1
  { [ "$head_before_alt" != "$head_after_alt" ] && [ "$head_after_alt" != none ]; } && committed=1

  # Under pipefail a failed git log still lets jq print [] before the ||
  # fallback fires, yielding two lines — so clear-then-default instead.
  commits_json=$(git log --format='%s' "$head_before..$head_after" 2>/dev/null | jq -R . | jq -sc . 2>/dev/null) || commits_json=
  commits_json=${commits_json:-'[]'}
  msg_json=$(grep -oE 'RALPH_MSG:.*' <<< "$result" | tail -1 | sed 's/^RALPH_MSG:[[:space:]]*//')
  summary=$(jq -r '.summary // ""' <<< "$msg_json" 2>/dev/null || echo '')
  why=$(jq -r '.why // ""' <<< "$msg_json" 2>/dev/null || echo '')
  [ -z "$summary" ] && summary=$(git log --format='%s' "$head_before..$head_after" 2>/dev/null | paste -sd ';' - | sed 's/;/; /g')

  detail=''
  if [ "$rc" -eq 124 ]; then status=timeout
  elif [ "$rc" -ne 0 ]; then status=error
  elif [ "$parse_ok" -eq 0 ]; then status=protocol-error; detail="agent output was not valid $HARNESS JSON"
  elif grep -Eqx '[[:space:]]*RALPH_DONE[[:space:]]*' <<< "$result" && [ "$committed" = 1 ]; then
    status=protocol-error
    detail='RALPH_DONE was emitted after creating a commit'
  elif grep -Eqx '[[:space:]]*RALPH_DONE[[:space:]]*' <<< "$result"; then status=backlog-empty
  elif [ "$committed" = 1 ]; then status=done
  else status=no-commit
  fi

  jq -cn --argjson iter "$i" --arg ts "$(date +%H:%M:%S)" --arg status "$status" \
    --arg summary "$summary" --arg why "$why" --arg detail "$detail" --arg session "$session" --arg harness "$HARNESS" \
    --argjson cost "$cost_json" --argjson rc "$rc" --argjson commits "${commits_json:-[]}" \
    '{iter:$iter,ts:$ts,status:$status,summary:$summary,why:$why,detail:$detail,commits:$commits,session:$session,cost:$cost,rc:$rc,harness:$harness}' \
    >> "$MAILBOX"

  if [ "$committed" = 1 ]; then
    {
      printf '### iteration %s — %s [%s]\n' "$i" "$(date +%H:%M:%S)" "$status"
      [ -n "$summary" ] && printf '> %s' "$summary"
      [ -n "$why" ] && printf '  (why: %s)' "$why"
      printf '\n'
      git log --format='- %s' "$head_before..$head_after" 2>/dev/null
      printf '\n'
    } >> "$SUMMARY"
    if [ "$status" = done ]; then say "✅ done: $summary"; else say "⚠ commit created but iteration status is $status"; fi
  else
    say "○ [$status] no commit this iteration"
  fi

  case "$status" in
    backlog-empty)
      stop_reason='child reported RALPH_DONE'; say 'child reported RALPH_DONE — exiting'; break
      ;;
    timeout)
      stop_reason="iteration $i timed out after ${ITER_TIMEOUT}s"; say 'iteration timed out — exiting'; break
      ;;
    error)
      stop_reason="iteration $i child exited rc=$rc"; say 'child execution failed — exiting'; break
      ;;
    protocol-error)
      stop_reason="protocol error: $detail"; say "$stop_reason — exiting"; break
      ;;
    no-commit)
      no_commit_streak=$((no_commit_streak + 1))
      say "no new commit this iteration (streak $no_commit_streak)"
      if [ "$no_commit_streak" -ge "${RALPH_GUTTER_MAX:-2}" ]; then
        stop_reason='gutter (2 iterations without a commit)'; say 'gutter detected — exiting'; break
      fi
      ;;
    done)
      no_commit_streak=0
      ;;
  esac

  if [ -n "$BUDGET" ] && jq -en --argjson spent "$total_cost" --argjson budget "$BUDGET" '$spent >= $budget' >/dev/null; then
    # Keep the amount out of stop_reason: it lands in the mailbox and is
    # rendered into the chat transcript. The run log may carry the detail.
    stop_reason="budget cap reached"; say "budget \$$BUDGET reached (spent \$$(format_cost "$total_cost")) — exiting"; break
  fi
done

if [ "$COST_SUPPORTED" -eq 1 ]; then
  say "ralph loop finished: reason=[$stop_reason] total=\$$(format_cost "$total_cost")"
else
  say "ralph loop finished: reason=[$stop_reason] total=n/a"
fi
finish_record "$stop_reason"
