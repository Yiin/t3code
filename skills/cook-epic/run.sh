#!/usr/bin/env bash
# cook-epic run — parallel fresh-context workers over a beads epic frontier.
#
# A coordinator loop: poll `bd ready --parent <EPIC>` (the dependency frontier),
# claim children atomically, dispatch one fresh headless agent session per child
# into its own git worktree, verify outcomes by effects (closed status + branch
# commits — never worker self-report), and land branches on the base branch
# through a serialized trial-merge + gate queue. Merge failures are parked and
# turned into ordinary "Merge fix:" children that the same worker pool repairs.
#
# Usage: run.sh <run-dir>          # launch from the project root
#
# Environment (all optional unless noted):
#   COOKEPIC_EPIC              beads epic id                       (REQUIRED)
#   COOKEPIC_HARNESS           auto, kimi, claude, ccx, codex, or opencode (default auto)
#   COOKEPIC_WORKERS           max concurrent workers              (default 3)
#   COOKEPIC_MAX_DISPATCHES    global spawn cap                    (default 50)
#   COOKEPIC_WORKER_TIMEOUT    per-worker timeout, seconds         (default 5400; 0 = none)
#   COOKEPIC_MAX_ATTEMPTS      attempts per child before blocked   (default 3)
#   COOKEPIC_GATE              integration gate run before landing (REQUIRED unless COOKEPIC_NO_GATE=1)
#   COOKEPIC_NO_GATE           1 = run without a gate; workers only do cheap checks, so
#                              nothing verifies builds/e2e — an explicit, eyes-open choice
#   COOKEPIC_CPU_WEIGHT        cook-epic.slice CPUWeight               (default 50)
#   COOKEPIC_IO_WEIGHT         cook-epic.slice IOWeight                (default 50)
#   COOKEPIC_MEMORY_HIGH       cook-epic.slice MemoryHigh              (default 60%)
#   COOKEPIC_PERMISSION_MODE   auto or bypassPermissions           (default auto)
#   COOKEPIC_MODEL             harness-native model override
#   COOKEPIC_BIN               selected harness binary override
#   OPENCODE_BIN               OpenCode binary                     (default opencode)
#   COOKEPIC_SPAWN_DELAY       seconds between dispatches          (default 2)
#   COOKEPIC_BUDGET_USD        soft spend cap (claude/ccx only; stops new dispatches)
#   COOKEPIC_WORKER_CMD        test hook: run this instead of a harness
#   COOKEPIC_PUSH_CMD         test hook: receives repo then git push arguments
#   COOKEPIC_SEQUENTIAL        1 = sequential mode: one worker at a time, directly
#                              in the main checkout on the base branch (no worktrees,
#                              no merge queue); the coordinator gates and pushes
#                              after each child. For epics whose children entangle —
#                              same-file clusters, cross-repo children, tight chains.
#   COOKEPIC_SIBLINGS          space-separated sibling repos (relative to the
#                              project root, e.g. "../proga-api") that sequential
#                              children may also commit in; HEAD movement there
#                              counts toward verification and gets pushed
#
# Stop gracefully: touch <run-dir>/STOP  (stops new dispatches, drains in-flight)
set -uo pipefail

RUN_DIR="${1:?usage: run.sh <run-dir>}"
LOG="$RUN_DIR/loop.log"
MAILBOX="$RUN_DIR/mailbox.jsonl"
SUMMARY="$RUN_DIR/summary.md"
SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE="$SKILL_DIR/worker-prompt.md"

mkdir -p "$RUN_DIR"
: > "$LOG"; : > "$MAILBOX"; : > "$SUMMARY"

say() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*" >> "$LOG"; }
mbox() {
  jq -cn "$@" \
    | jq --argjson pushed "${PUSH_ENABLED:-0}" --argjson verified "${VERIFIED:-0}" '. + {pushed: ($pushed == 1), verified: ($verified == 1)}' >> "$MAILBOX"
}

die() { # <message> <help>
  printf 'error: %s\nhelp: %s\n' "$1" "$2" | tee -a "$LOG"
  mbox --arg reason "$1" '{event:"finished",reason:$reason,fatal:true}'
  exit 2
}

# ---------------------------------------------------------------- config ----
EPIC="${COOKEPIC_EPIC:-}"
[ -n "$EPIC" ] || die 'COOKEPIC_EPIC is required' 'set it to the beads epic id'
WORKERS="${COOKEPIC_WORKERS:-3}"
MAX_DISPATCHES="${COOKEPIC_MAX_DISPATCHES:-50}"
WORKER_TIMEOUT="${COOKEPIC_WORKER_TIMEOUT:-5400}"
MAX_ATTEMPTS="${COOKEPIC_MAX_ATTEMPTS:-3}"
GATE="${COOKEPIC_GATE:-}"
NO_GATE="${COOKEPIC_NO_GATE:-0}"
VERIFIED=1
[ "$NO_GATE" = 1 ] && VERIFIED=0
CPU_WEIGHT="${COOKEPIC_CPU_WEIGHT:-50}"
IO_WEIGHT="${COOKEPIC_IO_WEIGHT:-50}"
MEMORY_HIGH="${COOKEPIC_MEMORY_HIGH:-60%}"
PERM_MODE="${COOKEPIC_PERMISSION_MODE:-auto}"
SPAWN_DELAY="${COOKEPIC_SPAWN_DELAY:-2}"
BUDGET="${COOKEPIC_BUDGET_USD:-}"
WORKER_CMD="${COOKEPIC_WORKER_CMD:-}"
RATE_LIMIT_BACKOFF="${COOKEPIC_RATE_LIMIT_BACKOFF:-120}"
NO_PUSH="${COOKEPIC_NO_PUSH:-}"
SEQUENTIAL="${COOKEPIC_SEQUENTIAL:-0}"
SIBLINGS=()
for s in ${COOKEPIC_SIBLINGS:-}; do SIBLINGS+=("$s"); done
if [ "$SEQUENTIAL" = 1 ]; then
  WORKERS=1
  TEMPLATE="$SKILL_DIR/worker-prompt-sequential.md"
fi

[[ "$WORKERS" =~ ^[1-9][0-9]*$ ]] || die 'COOKEPIC_WORKERS must be a positive integer' 'use 1 or more'
[[ "$MAX_DISPATCHES" =~ ^[1-9][0-9]*$ ]] || die 'COOKEPIC_MAX_DISPATCHES must be a positive integer' 'use 1 or more'
[[ "$MAX_ATTEMPTS" =~ ^[1-9][0-9]*$ ]] || die 'COOKEPIC_MAX_ATTEMPTS must be a positive integer' 'use 1 or more'
[[ "$WORKER_TIMEOUT" =~ ^[0-9]+$ ]] || die 'COOKEPIC_WORKER_TIMEOUT must be zero or a positive integer' 'use whole seconds'
[[ "$SPAWN_DELAY" =~ ^[0-9]+$ ]] || die 'COOKEPIC_SPAWN_DELAY must be zero or a positive integer' 'use whole seconds'
[[ "$RATE_LIMIT_BACKOFF" =~ ^[0-9]+$ ]] || die 'COOKEPIC_RATE_LIMIT_BACKOFF must be zero or a positive integer' 'use whole seconds'
[ -z "$BUDGET" ] || [[ "$BUDGET" =~ ^[0-9]+([.][0-9]+)?$ ]] || die 'COOKEPIC_BUDGET_USD must be a positive number' 'provide a dollar amount or remove it'
[ -z "$NO_PUSH" ] || [ "$NO_PUSH" = 1 ] || die 'COOKEPIC_NO_PUSH must be exactly 1 when set' 'unset it to enable pushes, or set COOKEPIC_NO_PUSH=1 for local-only landing'
if [ -z "$GATE" ] && [ "$NO_GATE" != 1 ]; then
  die 'COOKEPIC_GATE is required — workers only run cheap checks; the gate is the full verification' \
      'set COOKEPIC_GATE to the build+test command, or COOKEPIC_NO_GATE=1 to knowingly run unverified'
fi

for tool in jq timeout git bd flock; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool is required" "install $tool and rerun"
done
[ -d .beads ] || die 'no .beads directory here' 'launch from the project root of a beads-enabled repo'
[ -f "$TEMPLATE" ] || die "worker prompt template missing: $TEMPLATE" 'reinstall the cook-epic skill'
if git ls-files .beads | grep -qE '^\.beads/(dolt/|dolt-server\.|.*\.db$)'; then
  die 'the beads DATA dir is git-tracked; worktrees would fork the database' 'untrack the dolt data before running cook-epic'
fi

# Sequential workers commit directly in the main checkout and in any registered
# sibling repos. Normalize sibling paths before storing them in effect baselines
# or comparing them to `git worktree list` output, which is absolute.
REPO="$(pwd -P)"
PUSH_ENABLED=0
if [ "$NO_PUSH" = 1 ]; then
  : # Explicit local-only mode.
elif git remote get-url origin >/dev/null 2>&1; then
  PUSH_ENABLED=1
else
  die 'push-enabled run requires an origin remote' 'add origin or set COOKEPIC_NO_PUSH=1 for local-only landing'
fi
if [ "$SEQUENTIAL" = 1 ]; then
  canonical_siblings=()
  for s in "${SIBLINGS[@]}"; do
    s=$(realpath "$s" 2>/dev/null) \
      || die "sibling repo '$s' does not exist" 'COOKEPIC_SIBLINGS entries must be existing git repos relative to the project root'
    git -C "$s" rev-parse --git-dir >/dev/null 2>&1 \
      || die "sibling repo '$s' is not a git repository" 'COOKEPIC_SIBLINGS entries must be git repos relative to the project root'
    git -C "$s" symbolic-ref --short HEAD >/dev/null 2>&1 \
      || die "sibling repo '$s' is not on a branch" 'check out a branch there before launching'
    git -C "$s" diff-index --quiet HEAD -- . ':(exclude).beads' 2>/dev/null \
      || die "sibling repo '$s' has uncommitted changes" 'commit or stash there before launching; sequential workers commit on its branch'
    if [ "$PUSH_ENABLED" -eq 1 ]; then
      git -C "$s" remote get-url origin >/dev/null 2>&1 \
        || die "sibling repo '$s' has no origin remote" 'add an origin remote or set COOKEPIC_NO_PUSH=1'
    fi
    canonical_siblings+=("$s")
  done
  SIBLINGS=("${canonical_siblings[@]}")
fi

RUN_ID="${RUN_DIR##*/}"
# systemd unit names may not carry the dots a run-dir name has, so workers get
# a sanitized id. Naming each worker's scope deterministically is what lets the
# coordinator tell "my worker is gone" from "my bookkeeping subshell died but
# the worker is still running" — see worker_scope_active().
SCOPE_ID="$(printf '%s' "$RUN_ID" | tr -c 'a-zA-Z0-9' '-')"
WORKTREE_ROOT="$REPO/.worktrees/cook-epic-$RUN_ID"
INTEG_BRANCH="cook-epic-integration-$RUN_ID"
INTEG_WT="$WORKTREE_ROOT/.integration"

# -------------------------------------------------------------- harness ----
detect_ccx_environment() {
  [[ "${ANTHROPIC_BASE_URL:-}" =~ ^http://(localhost|127(\.[0-9]{1,3}){3}|\[::1\])(:[0-9]+)?(/.*)?$ ]] \
    && [ "${ANTHROPIC_AUTH_TOKEN:-}" = unused ] \
    && [[ "${ANTHROPIC_MODEL:-}" == *'[1m]' ]]
}

detect_harness() {
  case "${COOKEPIC_HARNESS:-auto}" in
    kimi|claude|codex|opencode) printf '%s\n' "$COOKEPIC_HARNESS"; return ;;
    ccx) detect_ccx_environment && { printf 'ccx\n'; return; } || return 3 ;;
    auto|'') ;;
    *) return 2 ;;
  esac
  if detect_ccx_environment; then printf 'ccx\n'; return; fi
  local pid="$PPID" row comm parent
  while [[ "$pid" =~ ^[0-9]+$ ]] && [ "$pid" -gt 1 ]; do
    row=$(ps -o comm= -o ppid= -p "$pid" 2>/dev/null) || break
    read -r comm parent <<< "$row"
    comm=${comm##*/}
    case "$comm" in
      kimi|kimi-*) printf 'kimi\n'; return ;;
      codex|codex-*) printf 'codex\n'; return ;;
      claude|claude-*) printf 'claude\n'; return ;;
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
  else return 1; fi
}

if [ -n "$WORKER_CMD" ]; then
  HARNESS=worker-cmd
else
  HARNESS=$(detect_harness) || {
    case $? in
      2) die "invalid COOKEPIC_HARNESS ${COOKEPIC_HARNESS:-}" 'use auto, kimi, claude, ccx, codex, or opencode' ;;
      3) die 'COOKEPIC_HARNESS=ccx requires the inherited ccx proxy environment' 'launch from ccx' ;;
      *) die 'could not identify the invoking harness' 'set COOKEPIC_HARNESS to kimi, claude, ccx, codex, or opencode' ;;
    esac
  }
fi

case "$HARNESS" in
  kimi)       AGENT_BIN="${COOKEPIC_BIN:-kimi}";   COST_SUPPORTED=0 ;;
  claude|ccx) AGENT_BIN="${COOKEPIC_BIN:-claude}"; COST_SUPPORTED=1 ;;
  codex)      AGENT_BIN="${COOKEPIC_BIN:-codex}";  COST_SUPPORTED=0 ;;
  opencode)   AGENT_BIN="${COOKEPIC_BIN:-${OPENCODE_BIN:-opencode}}"; COST_SUPPORTED=0 ;;
  worker-cmd) AGENT_BIN="$WORKER_CMD";             COST_SUPPORTED=0 ;;
esac
command -v "$AGENT_BIN" >/dev/null 2>&1 || die "harness binary not found: $AGENT_BIN" 'install it or set COOKEPIC_BIN'
[ -n "$BUDGET" ] && [ "$COST_SUPPORTED" -eq 0 ] && say "WARNING: budget not enforceable on $HARNESS (no cost reporting); ignoring COOKEPIC_BUDGET_USD"

if [ "$HARNESS" = opencode ]; then
  case "$PERM_MODE" in
    # OpenCode has one unattended permission switch. Both Cook Epic modes map
    # to --auto; bypassPermissions is accepted for parity, not as a stronger mode.
    auto|bypassPermissions) ;;
    *) die "unsupported OpenCode permission mode: $PERM_MODE" 'use auto or bypassPermissions' ;;
  esac
fi

# --------------------------------------------------------------- run lock ----
# MIRRORED BLOCK — cook-epic/run.sh and ralph/run.sh carry an identical copy.
# Both runners are standalone, copyable single scripts with no library to
# source, so this is duplicated on purpose: edit both or neither.
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

# Release on every exit path from here on. Nothing spawns workers before the
# drain trap below supersedes this one. INT is not an EXIT in bash, so both
# signals are turned into ordinary exits or a Ctrl-C would leak the lock — and
# they are armed before the acquire, because a signal delivered while the lock
# file is being written would otherwise kill us with no trap at all.
trap 'run_lock_release' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
if ! run_lock_acquire "$EPIC" terminal "$EPIC"; then
  mbox --arg reason "another run already owns epic $EPIC (see the lock_held record on stdout)" \
    '{event:"finished",reason:$reason,fatal:true,lockHeld:true}'
  exit 75
fi

# ------------------------------------------------------------- preflight ----
# The epic lock deliberately comes first. A live sequential holder may have a
# dirty checkout, and a contender must report lock_held instead of failing this
# ordinary single-run preflight before it discovers the owner.
BASE_BRANCH="$(git symbolic-ref --short HEAD 2>/dev/null)" \
  || die 'main checkout is not on a branch' 'check out the base branch first'
LAST_ACCEPTED_HEAD=$(git rev-parse HEAD)
# Tracked modifications are a hard stop (the coordinator merges into the base
# branch); untracked files only earn a warning (an ff-merge that would clobber
# one fails safely in the integration worktree first). .beads is excluded:
# bd's own activity (interactions.jsonl etc.) dirties it constantly and is not
# real work — repos whose bd init tracked those files must still be runnable.
git diff-index --quiet HEAD -- . ':(exclude).beads' 2>/dev/null \
  || die 'working tree has uncommitted changes' 'commit or stash before launching; cook-epic merges into the base branch'
[ -z "$(git status --porcelain)" ] || say 'WARNING: untracked files present — merges that add the same paths will stop for reconciliation'

EPIC_JSON="$(bd show "$EPIC" --json 2>/dev/null)" \
  || die "epic $EPIC not found" 'check the id with bd show'
EPIC_TYPE="$(jq -r 'if type=="array" then .[0] else . end | (.issue_type // .type // "")' <<< "$EPIC_JSON")"
[ "$EPIC_TYPE" = epic ] || say "WARNING: $EPIC is type '$EPIC_TYPE', not epic; continuing anyway"

# Keep our worktrees out of git status (repo-local exclude, not committed).
grep -qx '.worktrees' .git/info/exclude 2>/dev/null || echo '.worktrees' >> .git/info/exclude

# bd 1.x coordination primitives.
HOLDER="cook-epic-$RUN_ID"
# Merge slot: exclusive gate so no other actor (a second coordinator, a human
# running merges) interleaves conflict resolution on this repo. Never release
# a holder merely because its name resembles ours: a live coordinator may own it.
bd merge-slot create >/dev/null 2>&1 || true
# Swarm molecule: makes this parallel run discoverable to bd-aware tooling.
bd swarm create "$EPIC" >/dev/null 2>&1 || true

# Push-mode strings injected into the worker prompt (rendered before @BRANCH@/
# @BASE@, so those placeholders inside them still get substituted).
if [ "$PUSH_ENABLED" -eq 1 ]; then
  PUSH_RULE='Push only `@BRANCH@` (`git push -u origin @BRANCH@`); never push `@BASE@`.'
  PUSH_MERGE_FIX='Push the branch, then close the child, note the epic, and stop.'
  PUSH_VERIFY='branch pushed'
else
  PUSH_RULE='Do NOT push anything — pushing is disabled for this run; the coordinator lands your local branch itself.'
  PUSH_MERGE_FIX='Do not push (disabled this run). Close the child, note the epic, and stop.'
  PUSH_VERIFY='branch committed locally (pushing is disabled this run)'
fi

# Sequential-mode sibling rule, injected into the sequential worker prompt.
if [ "$SEQUENTIAL" = 1 ] && [ "${#SIBLINGS[@]}" -gt 0 ]; then
  SIBLING_RULE="This child may span sibling repositories: ${SIBLINGS[*]} (relative to the project root). You may read, write, build, and commit in them — commit on their current branch, never push; the coordinator pushes whatever moved after the gate. Say which repos gained commits in your close-out note."
else
  SIBLING_RULE='Work only in this repository.'
fi

mkdir -p "$WORKTREE_ROOT"

# ---------------------------------------------------- resource governance ----
# The whole fleet — every worker, everything it spawns (builds, browsers), and
# the integration gate — runs inside cook-epic.slice, so the interactive
# session always wins CPU/IO contention and the fleet cannot swap-thrash the
# machine. Falls back to `nice` when there is no systemd user session.
# heavy.lock additionally serializes the expensive commands (integration gate,
# Merge fix gate reruns) machine-wide: at most one runs at a time.
HEAVY_LOCK="$RUN_DIR/heavy.lock"
touch "$HEAVY_LOCK"
SCOPE_OK=0
if command -v systemd-run >/dev/null 2>&1 \
   && systemd-run --user --scope --quiet -- true >/dev/null 2>&1; then
  SCOPE_OK=1
  systemctl --user set-property --runtime cook-epic.slice \
    CPUWeight="$CPU_WEIGHT" IOWeight="$IO_WEIGHT" MemoryHigh="$MEMORY_HIGH" >>"$LOG" 2>&1 \
    || say 'WARNING: could not set cook-epic.slice properties; scoping without limits'
else
  say 'WARNING: systemd-run --user unavailable — falling back to nice (weaker isolation)'
fi

fleet_run() { # run a command under the fleet's resource cgroup (best effort)
  if [ "$SCOPE_OK" -eq 1 ]; then
    # FLEET_UNIT names the scope so the coordinator can later ask whether this
    # exact worker is still alive, and stop it rather than orphan it.
    if [ -n "${FLEET_UNIT:-}" ]; then
      systemd-run --user --scope --quiet --slice=cook-epic --unit="$FLEET_UNIT" -- "$@"
    else
      systemd-run --user --scope --quiet --slice=cook-epic -- "$@"
    fi
  else
    nice -n 10 "$@"
  fi
}

worker_scope_active() { # <worker> -> 0 when that worker's scope still has tasks
  [ "$SCOPE_OK" -eq 1 ] || return 1
  systemctl --user is-active --quiet "cook-epic-$SCOPE_ID-$1.scope" 2>/dev/null
}

# A scoped worker lives in its own cgroup, so a signal aimed at the
# coordinator's process group kills the bookkeeping subshell but NOT the worker
# — which then keeps mutating the checkout with nobody supervising it. Never
# exit leaving one behind.
stop_run_workers() {
  [ "$SCOPE_OK" -eq 1 ] || return 0
  local unit
  for unit in $(systemctl --user list-units --plain --no-legend --all \
                  "cook-epic-$SCOPE_ID-*.scope" 2>/dev/null | awk '{print $1}'); do
    say "stopping surviving worker scope $unit"
    systemctl --user stop "$unit" >>"$LOG" 2>&1 || true
  done
}
trap 'stop_run_workers; run_lock_release' EXIT

# Set up a worktree's untracked essentials. Beads access uses bd's native
# redirect mechanism (.beads/redirect holds the relative path to the main
# checkout's .beads; it is gitignored, so it can never be committed or block a
# merge) plus BEADS_DIR in the worker environment as an absolute-path backup.
# $1 = worktree path
setup_worktree() {
  local wt="$1" f rel
  mkdir -p "$wt/.beads"
  rel=$(realpath --relative-to="$wt" "$REPO/.beads")
  printf '%s' "$rel" > "$wt/.beads/redirect"
  [ -e "$wt/node_modules" ] || [ ! -d "$REPO/node_modules" ] || ln -s "$REPO/node_modules" "$wt/node_modules"
  for f in .env .env.local .env.development .env.development.local .env.test; do
    [ -f "$REPO/$f" ] && [ ! -e "$wt/$f" ] && cp "$REPO/$f" "$wt/$f"
  done
}

# Integration worktree: trial merges + gates run here. The base branch is only
# ever fast-forwarded in the main checkout after a green trial, so the user's
# checkout always stays buildable. Clear leftovers from any crashed prior run
# with the same run-id first. Sequential mode has no merge queue — the worker
# commits on the base branch in the main checkout — so it is skipped entirely.
if [ "$SEQUENTIAL" != 1 ]; then
  if git worktree list --porcelain | grep -Fxq "worktree $INTEG_WT"; then
    die "integration worktree already exists: $INTEG_WT" 'that run directory may belong to another coordinator; reconcile it before retrying'
  fi
  git show-ref --verify --quiet "refs/heads/$INTEG_BRANCH" \
    && die "integration branch already exists: $INTEG_BRANCH" 'that run directory may belong to another coordinator; reconcile it before retrying'
  git worktree add "$INTEG_WT" -b "$INTEG_BRANCH" "$BASE_BRANCH" >>"$LOG" 2>&1 \
    || die 'failed to create integration worktree' "see $LOG"
  setup_worktree "$INTEG_WT"
fi

# ---------------------------------------------------------------- state ----
declare -A PID2CHILD=() PID2BRANCH=() PID2WORKER=() PID2WT=() PID2ARTIFACT=()
declare -A ATTEMPTS=() REQUEUE_AT=() INFLIGHT=() PARKED=() PRECOMMENTS=()
declare -A PRE_HEAD=() PRE_SIB_HEAD=() FIRST_SIG=() FIRST_HEAD=() FIRST_SIB_HEAD=() FIRST_UNTRACKED=() # sequential verification
# Run-wide baselines are captured immediately before the first worker starts.
# Per-child baselines survive retries, so a cleanup-only retry still reports
# commits made by that child's earlier partial attempt.
RUN_BASE_HEAD=''
LAST_ACCEPTED_HEAD=''
declare -A RUN_SIB_HEAD=()
SEQUENTIAL_RECOVERY_CHILD=''
MERGE_QUEUE=()               # entries: "<child>|<branch>"
WORKER_NUM=0
DISPATCHED=0
MERGED=0
RESEARCHED=0
TOTAL_COST=0
STOPPING=0
FATAL_STOP=0
STOP_REASON=''

trap 'STOPPING=1; say "signal received — draining"' TERM INT

active_workers() { echo "${#PID2CHILD[@]}"; }

sequential_main_moved_unowned() {
  [ "$SEQUENTIAL" = 1 ] || return 1
  [ "$(active_workers)" -eq 0 ] || return 1
  [ -z "$LAST_ACCEPTED_HEAD" ] || [ "$(git rev-parse HEAD)" = "$LAST_ACCEPTED_HEAD" ] || return 0
  return 1
}

fatal_reconcile() { # <reason>
  STOPPING=1
  FATAL_STOP=1
  STOP_REASON="$1"
  say "$STOP_REASON"
}

# ------------------------------------------------------------- dispatch ----
claim_child() { # <child> <worker>
  local child="$1" worker="$2" assignee
  bd update "$child" --assignee "$worker" >/dev/null 2>>"$LOG"
  bd update "$child" --claim --actor "$worker" >/dev/null 2>>"$LOG" || return 1
  assignee=$(bd show "$child" --json 2>/dev/null | jq -r 'if type=="array" then .[0] else . end | .assignee // empty')
  [ "$assignee" = "$worker" ]
}

render_prompt() { # <child> <worker> <branch> <wt> <offset> <outfile>
  sed -e "s|@SIBLING_RULE@|$SIBLING_RULE|g" \
      -e "s|@PUSH_RULE@|$PUSH_RULE|g" \
      -e "s|@PUSH_MERGE_FIX@|$PUSH_MERGE_FIX|g" \
      -e "s|@PUSH_VERIFY@|$PUSH_VERIFY|g" \
      -e "s|@EPIC@|$EPIC|g" \
      -e "s|@CHILD@|$1|g" \
      -e "s|@WORKER@|$2|g" \
      -e "s|@BRANCH@|$3|g" \
      -e "s|@WORKTREE@|$4|g" \
      -e "s|@REPO@|$REPO|g" \
      -e "s|@BASE@|$BASE_BRANCH|g" \
      -e "s|@PORT_OFFSET@|$5|g" \
      "$TEMPLATE" > "$6"
}

is_research_child() { # <child> <title> -> 0 when findings-in-beads is the deliverable
  [[ "$2" =~ ^Research: ]] && return 0
  bd label list "$1" 2>/dev/null | grep -qiE '^[[:space:]]*-[[:space:]]*research$'
}

comment_count_of() { # <child> -> prints the bead's comment count (0 on any failure)
  bd show "$1" --json 2>/dev/null \
    | jq -r 'if type=="array" then .[0] else . end | .comment_count // 0' 2>/dev/null || echo 0
}

spawn_worker() { # <child> <title>
  local child="$1" title="$2"
  WORKER_NUM=$((WORKER_NUM + 1))
  local worker="w$WORKER_NUM" branch wt offset prompt artifact pid
  offset=$((WORKER_NUM * 20))

  if [ "$SEQUENTIAL" = 1 ]; then
    # Sequential: the worker commits directly on the base branch in the main
    # checkout. No worktree, no per-child branch, no merge queue.
    branch="$BASE_BRANCH"
    wt="$REPO"
  else
    if [[ "$title" =~ ^Merge\ fix:\ land\ ([^ ]+) ]]; then
      branch="${BASH_REMATCH[1]}"
    else
      branch="epic/$child"
    fi
    wt="$WORKTREE_ROOT/$child"
    if [ -e "$wt" ] || git worktree list --porcelain | grep -Fxq "worktree $wt"; then
      say "refusing existing worker worktree for $child: $wt"
      return 1
    fi
    if git show-ref --verify --quiet "refs/heads/$branch"; then
      git worktree add "$wt" "$branch" >>"$LOG" 2>&1
    else
      git worktree add "$wt" -b "$branch" "$BASE_BRANCH" >>"$LOG" 2>&1
    fi || { say "worktree creation failed for $child"; return 1; }
    setup_worktree "$wt"
  fi

  if ! claim_child "$child" "$worker"; then
    say "claim lost for $child — skipping this round"
    cleanup_worktree "$wt"
    return 1
  fi

  PRECOMMENTS[$child]=$(comment_count_of "$child")

  # Both modes need the run-wide baseline seeded immediately before the first
  # worker starts: sequential uses it for verify-by-effects, parallel needs the
  # LAST_ACCEPTED_HEAD it sets for the external-movement check at merge time.
  capture_run_baselines

  if [ "$SEQUENTIAL" = 1 ]; then
    # Baselines for verify-by-effects: the attempt baseline records the current
    # delta, while first-dispatch baselines retain commits from earlier attempts.
    PRE_HEAD[$child]=$(git rev-parse HEAD)
    local s
    for s in "${SIBLINGS[@]}"; do
      PRE_SIB_HEAD["$child|$s"]=$(git -C "$s" rev-parse HEAD)
      [ -n "${FIRST_SIB_HEAD[$child|$s]:-}" ] || FIRST_SIB_HEAD["$child|$s"]=${PRE_SIB_HEAD[$child|$s]}
    done
    [ -n "${FIRST_HEAD[$child]:-}" ] || FIRST_HEAD[$child]=${PRE_HEAD[$child]}
    [ -n "${FIRST_UNTRACKED[$child|$REPO]+x}" ] || capture_untracked_baseline "$REPO" "$child|$REPO"
    for s in "${SIBLINGS[@]}"; do
      [ -n "${FIRST_UNTRACKED[$child|$s]+x}" ] || capture_untracked_baseline "$s" "$child|$s"
    done
    [ -n "${FIRST_SIG[$child]:-}" ] || FIRST_SIG[$child]=$(tree_sig)
  fi

  prompt="$RUN_DIR/prompt-$child.md"
  render_prompt "$child" "$worker" "$branch" "$wt" "$offset" "$prompt"
  artifact="$RUN_DIR/worker-$child.log"

  (
    cd "$wt" || exit 98
    export BEADS_ACTOR="$worker" BEADS_DIR="$REPO/.beads"
    export COOKEPIC_EPIC="$EPIC" COOKEPIC_CHILD="$child" COOKEPIC_WORKER="$worker"
    export COOKEPIC_BRANCH="$branch" COOKEPIC_WORKTREE="$wt" COOKEPIC_BASE="$BASE_BRANCH"
    export COOKEPIC_PORT_OFFSET="$offset" COOKEPIC_GATE="$GATE" COOKEPIC_RUN_DIR="$RUN_DIR"
    # Deterministic scope name, so reap_finished can distinguish a finished
    # worker from a dead bookkeeping subshell, and stop_run_workers can reach it.
    export FLEET_UNIT="cook-epic-$SCOPE_ID-$worker"
    # Headless Claude exits as soon as it has emitted its final response. Remove
    # its background-wait ceiling for workers only; the coordinator's timeout
    # remains the outer bound. Respect an explicit caller setting.
    if { [ "$HARNESS" = claude ] || [ "$HARNESS" = ccx ]; } \
       && [ -z "${CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS+x}" ]; then
      export CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0
    fi
    case "$HARNESS" in
      worker-cmd)
        fleet_run timeout "$WORKER_TIMEOUT" "$AGENT_BIN" "$prompt" >"$artifact" 2>>"$LOG" ;;
      kimi)
        # kimi rejects permission flags (-y/--auto) combined with -p; prompt
        # mode already runs tools non-interactively, so PERM_MODE is a no-op.
        args=(-p "$(<"$prompt")" --output-format stream-json)
        [ -n "${COOKEPIC_MODEL:-}" ] && args+=(-m "$COOKEPIC_MODEL")
        fleet_run timeout "$WORKER_TIMEOUT" "$AGENT_BIN" "${args[@]}" >"$artifact" 2>>"$LOG" ;;
      claude|ccx)
        args=(-p --permission-mode "$PERM_MODE" --output-format json)
        [ -n "${COOKEPIC_MODEL:-}" ] && args+=(--model "$COOKEPIC_MODEL")
        fleet_run timeout "$WORKER_TIMEOUT" "$AGENT_BIN" "${args[@]}" -- "$(<"$prompt")" >"$artifact" 2>>"$LOG" ;;
      codex)
        case "$PERM_MODE" in
          auto) args=(-a never -s danger-full-access) ;;
          bypassPermissions) args=(--dangerously-bypass-approvals-and-sandbox) ;;
          *) args=(-a never -s "$PERM_MODE") ;;
        esac
        [ -n "${COOKEPIC_MODEL:-}" ] && args+=(-m "$COOKEPIC_MODEL")
        fleet_run timeout "$WORKER_TIMEOUT" "$AGENT_BIN" "${args[@]}" exec --json "$(<"$prompt")" >"$artifact" 2>>"$LOG" ;;
      opencode)
        args=(run --format json --auto)
        [ -n "${COOKEPIC_MODEL:-}" ] && args+=(-m "$COOKEPIC_MODEL")
        fleet_run timeout "$WORKER_TIMEOUT" "$AGENT_BIN" "${args[@]}" -- "$(<"$prompt")" >"$artifact" 2>>"$LOG" ;;
    esac
  ) &
  pid=$!

  PID2CHILD[$pid]="$child"; PID2BRANCH[$pid]="$branch"; PID2WORKER[$pid]="$worker"
  PID2WT[$pid]="$wt"; PID2ARTIFACT[$pid]="$artifact"
  INFLIGHT[$child]=1
  DISPATCHED=$((DISPATCHED + 1))
  mbox --arg child "$child" --arg worker "$worker" --arg branch "$branch" --arg ts "$(date +%H:%M:%S)" \
    '{event:"dispatched",child:$child,worker:$worker,branch:$branch,ts:$ts}'
  say "dispatched $child to $worker on $branch (pid $pid)"
  sleep "$SPAWN_DELAY"
}

# ----------------------------------------------------------------- reap ----
extract_cost() { # <artifact> -> prints cost or empty
  [ "$COST_SUPPORTED" -eq 1 ] || return 0
  jq -r '.total_cost_usd // empty' "$1" 2>/dev/null || true
}

cleanup_worktree() { # <wt> — only coordinator-owned run-scoped paths are removable
  [ "$1" = "$REPO" ] && return 0  # sequential mode: the "worktree" IS the main checkout
  if git worktree remove --force "$1" >>"$LOG" 2>&1; then
    return 0
  fi
  fatal_reconcile "could not remove coordinator worktree $1; refusing redispatch until operator reconciles"
  return 1
}

tree_sig() { # HEADs of the main repo + all siblings, joined — "did anything move?"
  local s
  { git rev-parse HEAD 2>/dev/null
    for s in "${SIBLINGS[@]}"; do git -C "$s" rev-parse HEAD 2>/dev/null; done
  } | paste -sd' ' -
}

registered_nested_worktree_dirty() { # <repo>
  local repo="$1" wt
  while IFS= read -r wt; do
    [[ "$wt" == "$repo/.claude/worktrees/"* ]] || continue
    [ -z "$(git -C "$wt" status --porcelain --untracked-files=all -- ':(exclude).beads' 2>/dev/null)" ] || return 0
  done < <(git -C "$repo" worktree list --porcelain 2>/dev/null | while IFS= read -r line; do
    case "$line" in worktree\ *) printf '%s\n' "${line#worktree }";; esac
  done)
  return 1
}

# Print untracked paths excluding .beads and clean registered nested worktrees.
sequential_untracked_paths() { # <repo>
  local repo="$1" rel wt wt_rel allowed
  while IFS= read -r -d '' rel; do
    allowed=0
    while IFS= read -r wt; do
      [[ "$wt" == "$repo/.claude/worktrees/"* ]] || continue
      wt_rel="${wt#"$repo/"}"
      [[ "$rel" == "$wt_rel" || "$rel" == "$wt_rel/"* ]] || continue
      [ -z "$(git -C "$wt" status --porcelain --untracked-files=all -- ':(exclude).beads' 2>/dev/null)" ] || break
      allowed=1
      break
    done < <(git -C "$repo" worktree list --porcelain 2>/dev/null | while IFS= read -r line; do
      case "$line" in worktree\ *) printf '%s\n' "${line#worktree }";; esac
    done)
    [ "$allowed" -eq 1 ] || printf '%s\n' "$rel"
  done < <(git -C "$repo" ls-files --others --exclude-standard -z -- . ':(exclude).beads')
}

capture_untracked_baseline() { # <repo> <key>
  FIRST_UNTRACKED[$2]=$(sequential_untracked_paths "$1" | sort)
}

# Return success when a repository has dirt beyond the child's first-dispatch
# baseline. Pre-existing untracked paths remain permitted, matching preflight.
sequential_repo_dirty() { # <repo> <child-key>
  local repo="$1" key="$2" current baseline
  if ! git -C "$repo" diff-index --quiet HEAD -- . ':(exclude).beads' 2>/dev/null; then
    return 0
  fi
  if registered_nested_worktree_dirty "$repo"; then
    return 0
  fi
  current=$(sequential_untracked_paths "$repo" | sort)
  baseline="${FIRST_UNTRACKED[$key]:-}"
  [ "$current" = "$baseline" ] || return 0
  return 1
}

capture_run_baselines() {
  [ -n "$RUN_BASE_HEAD" ] && return
  local s
  RUN_BASE_HEAD=$(git rev-parse HEAD)
  # Parallel mode never reaches reap_sequential, which is the only other place
  # that seeds LAST_ACCEPTED_HEAD before the first merge. Without this the
  # external-movement check in process_merges compares a real SHA against an
  # empty string, so the first queued merge always trips a reconciliation stop.
  LAST_ACCEPTED_HEAD=$RUN_BASE_HEAD
  for s in "${SIBLINGS[@]}"; do
    RUN_SIB_HEAD[$s]=$(git -C "$s" rev-parse HEAD)
  done
}

repo_effects_json() { # <main baseline> <sibling-baseline-prefix or child>
  local main_base="$1" child="${2:-}" s repo base head commits effects='[]'
  repo="$REPO"; base="$main_base"; head=$(git -C "$repo" rev-parse HEAD)
  commits=$(git -C "$repo" rev-list --count "$base..$head" 2>/dev/null || echo 0)
  [ "$commits" -gt 0 ] && effects=$(jq -cn --arg repo "$repo" --arg base "$base" --arg head "$head" --argjson commits "$commits" '[{repo:$repo,base:$base,head:$head,commits:$commits}]')
  for s in "${SIBLINGS[@]}"; do
    repo=$(realpath "$s")
    if [ -n "$child" ]; then base="${FIRST_SIB_HEAD[$child|$s]:-$(git -C "$s" rev-parse HEAD)}"
    else base="${RUN_SIB_HEAD[$s]:-$(git -C "$s" rev-parse HEAD)}"; fi
    head=$(git -C "$s" rev-parse HEAD)
    commits=$(git -C "$s" rev-list --count "$base..$head" 2>/dev/null || echo 0)
    [ "$commits" -gt 0 ] && effects=$(jq -cn --argjson effects "$effects" --arg repo "$repo" --arg base "$base" --arg head "$head" --argjson commits "$commits" '$effects + [{repo:$repo,base:$base,head:$head,commits:$commits}]')
  done
  printf '%s\n' "$effects"
}

sequential_claim_recovery_if_effects() { # <child>
  local child="$1" commits=0 dirty=0 s
  sequential_repo_dirty "$REPO" "$child|$REPO" && dirty=1
  commits=$(git rev-list --count "${FIRST_HEAD[$child]:-${PRE_HEAD[$child]:-HEAD}}..HEAD" 2>/dev/null || echo 0)
  for s in "${SIBLINGS[@]}"; do
    sequential_repo_dirty "$s" "$child|$s" && dirty=1
    commits=$(( commits + $(git -C "$s" rev-list --count "${FIRST_SIB_HEAD[$child|$s]:-${PRE_SIB_HEAD[$child|$s]:-HEAD}}..HEAD" 2>/dev/null || echo 0) ))
  done
  if [ "$dirty" -eq 1 ] || [ "$commits" -gt 0 ]; then
    SEQUENTIAL_RECOVERY_CHILD="$child"
  fi
}

push_repo() { # <repo> <git push arguments...>; test hook avoids network pushes
  local repo="$1"
  shift
  if [ -n "${COOKEPIC_PUSH_CMD:-}" ]; then
    "$COOKEPIC_PUSH_CMD" "$repo" "$@"
  else
    git -C "$repo" push "$@"
  fi
}

push_sequential_child_effects() { # <child> — push all repos changed since first dispatch
  local child="$1" s main_base sibling_base sibling_branch
  main_base="${FIRST_HEAD[$child]:-${PRE_HEAD[$child]:-HEAD}}"
  if [ "$(git -C "$REPO" rev-parse HEAD)" != "$main_base" ]; then
    push_repo "$REPO" origin "$BASE_BRANCH" >>"$LOG" 2>&1 || return 1
  fi
  for s in "${SIBLINGS[@]}"; do
    sibling_base="${FIRST_SIB_HEAD[$child|$s]:-${PRE_SIB_HEAD[$child|$s]:-HEAD}}"
    if [ "$(git -C "$s" rev-parse HEAD)" != "$sibling_base" ]; then
      sibling_branch=$(git -C "$s" symbolic-ref --short HEAD) || return 1
      push_repo "$s" origin "$sibling_branch" >>"$LOG" 2>&1 || return 1
    fi
  done
}

fail_attempt() { # <child> <worker> <reason> — reopen + back off, or block for a human
  local child="$1" worker="$2" reason="$3"
  ATTEMPTS[$child]=$(( ${ATTEMPTS[$child]:-0} + 1 ))
  bd update "$child" --status open >/dev/null 2>>"$LOG"
  if [ "${ATTEMPTS[$child]}" -lt "$MAX_ATTEMPTS" ]; then
    local backoff=$(( 10 * (1 << (ATTEMPTS[$child] - 1)) ))
    [ "$backoff" -gt 300 ] && backoff=300
    REQUEUE_AT[$child]=$(( $(date +%s) + backoff ))
    bd note "$child" "cook-epic: attempt ${ATTEMPTS[$child]}/$MAX_ATTEMPTS failed ($reason); requeued" >/dev/null 2>>"$LOG"
    mbox --arg child "$child" --arg worker "$worker" --arg reason "$reason" \
      --argjson attempt "${ATTEMPTS[$child]}" --argjson max "$MAX_ATTEMPTS" --arg ts "$(date +%H:%M:%S)" \
      '{event:"retry",child:$child,worker:$worker,reason:$reason,attempt:$attempt,max:$max,ts:$ts}'
    say "$child failed ($reason) — attempt ${ATTEMPTS[$child]}/$MAX_ATTEMPTS, retry in ${backoff}s"
  else
    bd update "$child" --status blocked >/dev/null 2>>"$LOG"
    bd note "$child" "cook-epic: blocked after $MAX_ATTEMPTS attempts (last: $reason). Needs a human." >/dev/null 2>>"$LOG"
    # A blocked child can leave its shared tree dirty. Stop rather than hand
    # that state to another child; the operator must reconcile it.
    if [ "$SEQUENTIAL" = 1 ] && [ "$SEQUENTIAL_RECOVERY_CHILD" = "$child" ]; then
      STOPPING=1
      STOP_REASON="$child blocked while owning a dirty shared checkout; operator must reconcile"
      say "$STOP_REASON"
    fi
    mbox --arg child "$child" --arg reason "$reason" --argjson attempts "${ATTEMPTS[$child]}" --arg ts "$(date +%H:%M:%S)" \
      '{event:"blocked",child:$child,reason:$reason,attempts:$attempts,ts:$ts}'
    say "$child BLOCKED after $MAX_ATTEMPTS attempts ($reason)"
  fi
}

reap_worker() { # <pid> <rc>
  local pid="$1" rc="$2"
  local child="${PID2CHILD[$pid]}" branch="${PID2BRANCH[$pid]}" worker="${PID2WORKER[$pid]}"
  local wt="${PID2WT[$pid]}" artifact="${PID2ARTIFACT[$pid]}"
  unset "PID2CHILD[$pid]" "PID2BRANCH[$pid]" "PID2WORKER[$pid]" "PID2WT[$pid]" "PID2ARTIFACT[$pid]"
  unset "INFLIGHT[$child]"

  local cost status commits title
  cost=$(extract_cost "$artifact")
  [ -n "$cost" ] && TOTAL_COST=$(jq -cn --argjson t "$TOTAL_COST" --argjson c "$cost" '$t + $c')
  status=$(bd show "$child" --json 2>/dev/null | jq -r 'if type=="array" then .[0] else . end | .status // "?"')
  commits=$(git rev-list --count "$BASE_BRANCH..$branch" 2>/dev/null || echo 0)
  title=$(bd show "$child" --json 2>/dev/null | jq -r 'if type=="array" then .[0] else . end | .title // ""')

  # Rate limit: don't burn an attempt; back off before re-dispatch.
  if [ "$status" != closed ] && grep -qiE 'rate.?limit|\b429\b|overloaded|quota exceeded' "$artifact" 2>/dev/null; then
    if [ "$SEQUENTIAL" = 1 ]; then
      sequential_claim_recovery_if_effects "$child"
      # A rate-limited sequential worker still owned the checkout and may have
      # committed before it was cut off. reap_sequential accepts the ending HEAD
      # for exactly that reason, but this path returns before reaching it —
      # leaving the worker's own commits to trip sequential_main_moved_unowned
      # on the next tick and abort the run as "external movement".
      LAST_ACCEPTED_HEAD=$(git rev-parse HEAD)
    fi
    REQUEUE_AT[$child]=$(( $(date +%s) + RATE_LIMIT_BACKOFF ))
    bd update "$child" --status open >/dev/null 2>>"$LOG"
    mbox --arg child "$child" --arg worker "$worker" --arg ts "$(date +%H:%M:%S)" \
      '{event:"rate-limited",child:$child,worker:$worker,ts:$ts}'
    say "$child hit provider rate limit on $worker; requeueing after ${RATE_LIMIT_BACKOFF}s"
    cleanup_worktree "$wt"
    return
  fi

  # Sequential mode has its own verification: commits are already on the base
  # branch in the main checkout, so "landing" means gate + push, not a merge.
  if [ "$SEQUENTIAL" = 1 ]; then
    reap_sequential "$child" "$worker" "$rc" "$status" "$title"
    return
  fi

  # Research always needs a new bead comment, even if it also produced code.
  # Verified research with commits follows the normal landing queue; findings
  # without commits are delivered directly to beads.
  if [ "$status" = closed ] && is_research_child "$child" "$title"; then
    local now_comments
    now_comments=$(comment_count_of "$child")
    if [ "$now_comments" -le "${PRECOMMENTS[$child]:-0}" ]; then
      fail_attempt "$child" "$worker" 'closed without findings (no new bead comment)'
      cleanup_worktree "$wt"
      return
    fi
    if [ "$commits" -eq 0 ]; then
      mbox --arg child "$child" --arg worker "$worker" --argjson comments "$now_comments" \
        --argjson cost "${cost:-null}" --arg ts "$(date +%H:%M:%S)" \
        '{event:"researched",child:$child,worker:$worker,comments:$comments,cost:$cost,ts:$ts}'
      say "$child researched on $worker (findings in beads, no code) — nothing to merge"
      RESEARCHED=$((RESEARCHED + 1))
      cleanup_worktree "$wt"
      git branch -D "$branch" >>"$LOG" 2>&1 || true
      return
    fi
  fi

  if [ "$status" = closed ] && [ "$commits" -gt 0 ]; then
    local summary
    summary=$(git log --format='%s' "$BASE_BRANCH..$branch" 2>/dev/null | paste -sd ';' -)
    mbox --arg child "$child" --arg worker "$worker" --arg branch "$branch" \
      --arg summary "$summary" --argjson commits "$commits" --argjson cost "${cost:-null}" --arg ts "$(date +%H:%M:%S)" \
      '{event:"done",child:$child,worker:$worker,branch:$branch,summary:$summary,commits:$commits,cost:$cost,ts:$ts}'
    say "$child done on $worker ($commits commits) — queued for merge"
    if [[ "$title" =~ ^Merge\ fix:\ land\ ([^ ]+) ]]; then
      # A repaired branch: re-enqueue the ORIGINAL child's merge.
      local orig
      orig=$(cat "$RUN_DIR/parked/${branch//\//_}" 2>/dev/null || echo "$child")
      MERGE_QUEUE+=("$orig|$branch")
    else
      MERGE_QUEUE+=("$child|$branch")
    fi
    cleanup_worktree "$wt"
    return
  fi

  # Failure path (incl. closed-without-commits, timeout, gutter).
  local reason="exited rc=$rc"
  [ "$rc" -eq 124 ] && reason="timed out after ${WORKER_TIMEOUT}s"
  if [ "$status" = closed ] && [ "$commits" -eq 0 ]; then
    if is_research_child "$child" "$title"; then
      reason="closed without findings (no new bead comment)"
    else
      reason="closed without commits"
    fi
  fi
  fail_attempt "$child" "$worker" "$reason"
  cleanup_worktree "$wt"
}

# Sequential mode: the worker committed directly on $BASE_BRANCH in the main
# checkout (and possibly in registered siblings). Verify by effects — closed,
# tree clean, and the tree moved since dispatch (or since the child's first
# dispatch, which covers crash-before-close retries that only needed to close)
# — then run the integration gate and push whatever moved.
reap_sequential() { # <child> <worker> <rc> <status> <title>
  local child="$1" worker="$2" rc="$3" status="$4" title="$5"
  local commits=0 dirty=0 s head summary now_comments reason effects landing
  # While a sequential worker owns the checkout its commits are indistinguishable
  # from an external writer. Accept its ending HEAD, then detect any movement
  # before the next unowned dispatch or gate transition.
  LAST_ACCEPTED_HEAD=$(git rev-parse HEAD)

  sequential_repo_dirty "$REPO" "$child|$REPO" && dirty=1
  for s in "${SIBLINGS[@]}"; do
    sequential_repo_dirty "$s" "$child|$s" && dirty=1
  done

  commits=$(git rev-list --count "${FIRST_HEAD[$child]:-${PRE_HEAD[$child]:-HEAD}}..HEAD" 2>/dev/null || echo 0)
  for s in "${SIBLINGS[@]}"; do
    commits=$(( commits + $(git -C "$s" rev-list --count "${FIRST_SIB_HEAD[$child|$s]:-${PRE_SIB_HEAD[$child|$s]:-HEAD}}..HEAD" 2>/dev/null || echo 0) ))
  done

  # Every first-dispatch effect, including a closed child that left dirt,
  # belongs to its child until success or operator reconciliation. A closed
  # status is not proof that the shared checkout is safe to hand off.
  if [ "$dirty" -eq 1 ] || [ "$commits" -gt 0 ]; then
    SEQUENTIAL_RECOVERY_CHILD="$child"
  fi

  # Research children always need a new bead comment. Research commits are
  # allowed and go through the normal gate/push path after findings verification.
  if [ "$status" = closed ] && is_research_child "$child" "$title"; then
    now_comments=$(comment_count_of "$child")
    if [ "$now_comments" -le "${PRECOMMENTS[$child]:-0}" ]; then
      fail_attempt "$child" "$worker" 'closed without findings (no new bead comment)'
      return
    fi
    if [ "$commits" -eq 0 ] && [ "$dirty" -eq 0 ]; then
      [ "$SEQUENTIAL_RECOVERY_CHILD" = "$child" ] && SEQUENTIAL_RECOVERY_CHILD=''
      mbox --arg child "$child" --arg worker "$worker" --argjson comments "$now_comments" --arg ts "$(date +%H:%M:%S)" \
        '{event:"researched",child:$child,worker:$worker,comments:$comments,ts:$ts}'
      say "$child researched on $worker (findings in beads, no code)"
      RESEARCHED=$((RESEARCHED + 1))
      return
    fi
  fi

  if [ "$status" = closed ] && [ "$dirty" -eq 0 ] \
     && { [ "$commits" -gt 0 ] || [ "${FIRST_SIG[$child]:-}" != "$(tree_sig)" ]; }; then
    if [ -n "$GATE" ]; then
      if ! ( cd "$REPO" && fleet_run flock "$HEAVY_LOCK" bash -c "$GATE" ) >>"$LOG" 2>&1; then
        # The child is still marked closed here. Claim its existing effects
        # before fail_attempt reopens it so another child cannot run first.
        sequential_claim_recovery_if_effects "$child"
        fail_attempt "$child" "$worker" "integration gate failed — fix forward: run \`$GATE\` and fix what it reports (details in $LOG)"
        return
      fi
    fi
    # Gates run in the shared sequential checkout and may leave artifacts.
    # Recheck every repository before pushing or declaring success.
    dirty=0
    sequential_repo_dirty "$REPO" "$child|$REPO" && dirty=1
    for s in "${SIBLINGS[@]}"; do
      sequential_repo_dirty "$s" "$child|$s" && dirty=1
    done
    if [ "$dirty" -eq 1 ]; then
      sequential_claim_recovery_if_effects "$child"
      fail_attempt "$child" "$worker" 'integration gate left uncommitted changes — this child owns cleanup before any other child can run'
      return
    fi
    if [ "$PUSH_ENABLED" -eq 1 ]; then
      if ! push_sequential_child_effects "$child"; then
        STOPPING=1; FATAL_STOP=1; STOP_REASON="push of sequential child $child rejected (remote moved?); operator must reconcile"
        say "$STOP_REASON"
        return
      fi
    fi
    head=$(git rev-parse --short HEAD)
    summary=$(git log --format='%s' "${FIRST_HEAD[$child]:-${PRE_HEAD[$child]:-HEAD}}..HEAD" 2>/dev/null | paste -sd ';' -)
    effects=$(repo_effects_json "${FIRST_HEAD[$child]:-${PRE_HEAD[$child]:-HEAD}}" "$child")
    [ "$SEQUENTIAL_RECOVERY_CHILD" = "$child" ] && SEQUENTIAL_RECOVERY_CHILD=''
    landing='gated, landed locally'
    [ "$VERIFIED" -eq 0 ] && landing='landed unverified locally'
    [ "$PUSH_ENABLED" -eq 1 ] && landing='gated, pushed, landed'
    [ "$PUSH_ENABLED" -eq 1 ] && [ "$VERIFIED" -eq 0 ] && landing='pushed, landed unverified'
    mbox --arg child "$child" --arg worker "$worker" --arg branch "$BASE_BRANCH" \
      --arg summary "$summary" --argjson commits "$commits" --argjson repos "$effects" --arg ts "$(date +%H:%M:%S)" \
      '{event:"done",child:$child,worker:$worker,branch:$branch,summary:$summary,commits:$commits,repositories:$repos,ts:$ts}'
    printf -- '- %s %s on `%s` (%s)\n' "$child" "$landing" "$BASE_BRANCH" "$head" >> "$SUMMARY"
    MERGED=$((MERGED + 1))
    say "$child done on $worker ($commits commits) — $landing on $BASE_BRANCH ($head)"
    return
  fi

  reason="exited rc=$rc"
  [ "$rc" -eq 124 ] && reason="timed out after ${WORKER_TIMEOUT}s"
  if [ "$dirty" -eq 1 ]; then
    reason="left uncommitted changes in the working tree — this child owns cleanup before any other child can run"
  elif [ "$status" = closed ] && [ "$commits" -eq 0 ]; then
    if is_research_child "$child" "$title"; then
      reason="closed without findings (no new bead comment)"
    else
      reason="closed without commits"
    fi
  fi
  fail_attempt "$child" "$worker" "$reason"
}

reap_finished() {
  local pid rc
  for pid in "${!PID2CHILD[@]}"; do
    if ! kill -0 "$pid" 2>/dev/null; then
      # The subshell being gone does NOT mean the worker is. A signal to the
      # coordinator's process group (session teardown, Ctrl-C) kills the
      # subshell while the scoped worker keeps running — and judging the child
      # now would read a working tree the live worker is still writing to,
      # declaring "left uncommitted changes" against work in progress and
      # freeing the checkout for a sibling. Wait for the scope to end.
      if worker_scope_active "${PID2WORKER[$pid]}"; then
        continue
      fi
      wait "$pid"; rc=$?
      reap_worker "$pid" "$rc"
    fi
  done
}

# ---------------------------------------------------------------- merge ----
park_branch() { # <child> <branch> <reason>
  local child="$1" branch="$2" reason="$3" fix_id desc
  desc="Branch \`$branch\` (child \`$child\`) failed to land on \`$BASE_BRANCH\`: $reason.

Repair procedure: you will be on branch \`$branch\` in an isolated worktree. Merge \`$BASE_BRANCH\` into it, resolve conflicts"
  if [ "$reason" = conflict ]; then
    desc="$desc, then run the project quality gates"
  else
    desc="$desc. The integration gate is: \`$GATE\` — run it and fix what it reports"
  fi
  if [ "$PUSH_ENABLED" -eq 1 ]; then
    desc="$desc. Push the branch, close this issue, and note the epic."
  else
    desc="$desc. Do not push (disabled this run). Close this issue and note the epic."
  fi
  desc="$desc Do NOT merge into $BASE_BRANCH yourself."
  fix_id=$(bd create "Merge fix: land $branch ($reason)" --type task --parent "$EPIC" -p 1 \
      -d "$desc" --json 2>>"$LOG" | jq -r 'if type=="array" then .[0] else . end | .id // empty')
  mkdir -p "$RUN_DIR/parked"
  echo "$child" > "$RUN_DIR/parked/${branch//\//_}"
  PARKED[$branch]=1
  bd note "$EPIC" "cook-epic: merge of $branch parked ($reason); merge-fix child ${fix_id:-unknown} created" >/dev/null 2>>"$LOG"
  mbox --arg child "$child" --arg branch "$branch" --arg reason "$reason" --arg fix "${fix_id:-?}" --arg ts "$(date +%H:%M:%S)" \
    '{event:"parked",child:$child,branch:$branch,reason:$reason,fix:$fix,ts:$ts}'
  say "merge of $branch parked ($reason) — merge-fix child ${fix_id:-?}"
}

process_merges() {
  [ "${#MERGE_QUEUE[@]}" -gt 0 ] || return 0
  if [ "$(git -C "$REPO" rev-parse HEAD)" != "$LAST_ACCEPTED_HEAD" ]; then
    fatal_reconcile "base branch $BASE_BRANCH moved externally; cannot trial-merge — operator must reconcile"
    return 1
  fi
  local queue=("${MERGE_QUEUE[@]}")
  local i entry child branch merge_commit

  # Exclusive merge gate (bd 1.x merge slot). If another actor holds it,
  # keep the queue intact and retry next tick.
  if ! bd merge-slot acquire --holder "$HOLDER" >/dev/null 2>>"$LOG"; then
    say 'merge slot held by another actor — deferring merges'
    return 0
  fi
  MERGE_QUEUE=()

  for ((i = 0; i < ${#queue[@]}; i++)); do
    entry="${queue[$i]}"
    child="${entry%%|*}"; branch="${entry#*|}"

    # The coordinator owns this integration worktree. Reset tracked state and
    # remove every untracked or ignored artifact before each trial merge.
    git -C "$INTEG_WT" reset --hard "$BASE_BRANCH" >>"$LOG" 2>&1
    git -C "$INTEG_WT" clean -fdx >>"$LOG" 2>&1
    setup_worktree "$INTEG_WT"
    if ! git -C "$INTEG_WT" merge --no-ff "$branch" -m "cook-epic: merge $branch ($child)" >>"$LOG" 2>&1; then
      git -C "$INTEG_WT" merge --abort >>"$LOG" 2>&1
      park_branch "$child" "$branch" conflict
      continue
    fi
    if [ -n "$GATE" ]; then
      if ! ( cd "$INTEG_WT" && fleet_run flock "$HEAVY_LOCK" bash -c "$GATE" ) >>"$LOG" 2>&1; then
        git -C "$INTEG_WT" reset --hard "$BASE_BRANCH" >>"$LOG" 2>&1
        park_branch "$child" "$branch" gate-failed
        continue
      fi
    fi
    if ! git -C "$REPO" merge --ff-only "$INTEG_BRANCH" >>"$LOG" 2>&1; then
      MERGE_QUEUE=("${queue[@]:$i}")
      STOPPING=1; FATAL_STOP=1
      STOP_REASON="base branch $BASE_BRANCH moved externally; cannot fast-forward — operator must reconcile"
      say "$STOP_REASON"
      bd merge-slot release --holder "$HOLDER" >/dev/null 2>>"$LOG"
      return 1
    fi
    if [ "$PUSH_ENABLED" -eq 1 ] && ! git -C "$REPO" push origin "$BASE_BRANCH" >>"$LOG" 2>&1; then
      MERGE_QUEUE=("${queue[@]:$i}")
      STOPPING=1; FATAL_STOP=1
      STOP_REASON="push of $BASE_BRANCH rejected (remote moved?); operator must reconcile"
      say "$STOP_REASON"
      bd merge-slot release --holder "$HOLDER" >/dev/null 2>>"$LOG"
      return 1
    fi
    merge_commit=$(git -C "$REPO" rev-parse --short HEAD)
    LAST_ACCEPTED_HEAD=$(git -C "$REPO" rev-parse HEAD)
    MERGED=$((MERGED + 1))
    unset "PARKED[$branch]"
    local merge_landing='gated, landed locally'
    [ "$VERIFIED" -eq 0 ] && merge_landing='landed unverified locally'
    [ "$PUSH_ENABLED" -eq 1 ] && merge_landing='gated, pushed, landed'
    [ "$PUSH_ENABLED" -eq 1 ] && [ "$VERIFIED" -eq 0 ] && merge_landing='pushed, landed unverified'
    mbox --arg child "$child" --arg branch "$branch" --arg commit "$merge_commit" --arg landing "$merge_landing" --arg ts "$(date +%H:%M:%S)" \
      '{event:"merged",child:$child,branch:$branch,commit:$commit,landing:$landing,ts:$ts}'
    printf -- '- %s %s via `%s` (%s)\n' "$child" "$merge_landing" "$branch" "$merge_commit" >> "$SUMMARY"
    say "$merge_landing $branch ($child) into $BASE_BRANCH ($merge_commit)"
    git branch -d "$branch" >>"$LOG" 2>&1 || true
    [ "$PUSH_ENABLED" -eq 1 ] && git -C "$REPO" push origin --delete "$branch" >>"$LOG" 2>&1 || true
  done

  bd merge-slot release --holder "$HOLDER" >/dev/null 2>>"$LOG"
}

# ----------------------------------------------------------------- tick ----
frontier() { # print "id<TAB>title" of ready children
  bd ready --parent "$EPIC" --json --limit 100 2>/dev/null \
    | jq -r 'if type=="array" then .[] else empty end | [.id, .title] | @tsv' 2>/dev/null || true
}

open_children_count() {
  bd list --parent "$EPIC" --all --flat --json 2>/dev/null \
    | jq --arg epic "$EPIC" '[.[] | select((.status != "closed") and (.id != $epic))] | length' 2>/dev/null || echo '?'
}

dispatchable() { # <child>
  local child="$1" now
  [ -z "${INFLIGHT[$child]:-}" ] || return 1
  # A sequential dirty-state failure belongs to the worker that caused it.
  # Do not let another ready child inherit that checkout or sibling state.
  [ "$SEQUENTIAL" != 1 ] || [ -z "$SEQUENTIAL_RECOVERY_CHILD" ] || [ "$child" = "$SEQUENTIAL_RECOVERY_CHILD" ] || return 1
  now=$(date +%s)
  [ "${REQUEUE_AT[$child]:-0}" -le "$now" ] || return 1
  [ "${ATTEMPTS[$child]:-0}" -lt "$MAX_ATTEMPTS" ] || return 1
  return 0
}

finish() { # <reason>
  local reason="$1" effects
  bd merge-slot release --holder "$HOLDER" >/dev/null 2>&1 || true
  if [ "$SEQUENTIAL" != 1 ]; then
    git worktree remove --force "$INTEG_WT" >>"$LOG" 2>&1 || true
    git branch -D "$INTEG_BRANCH" >>"$LOG" 2>&1 || true
  else
    capture_run_baselines
    effects=$(repo_effects_json "$RUN_BASE_HEAD")
    if [ "$effects" != '[]' ]; then
      printf '\n## Repository landing effects\n' >> "$SUMMARY"
      jq -r '.[] | "- `\(.repo)`: \(.commits) commits, \(.base[0:12]) → \(.head[0:12])"' <<< "$effects" >> "$SUMMARY"
    fi
  fi
  mbox --arg reason "$reason" --argjson dispatched "$DISPATCHED" --argjson merged "$MERGED" --argjson researched "$RESEARCHED" \
    --argjson repositories "${effects:-[]}" --argjson cost "${TOTAL_COST:-0}" --argjson costTracked "$COST_SUPPORTED" --arg ts "$(date +%H:%M:%S)" \
    '{event:"finished",reason:$reason,dispatched:$dispatched,merged:$merged,researched:$researched,repositories:$repositories,total_cost:(if $costTracked==1 then $cost else null end),ts:$ts}'
  say "cook-epic finished: $reason (dispatched=$DISPATCHED merged=$MERGED researched=$RESEARCHED)"
}

say "cook-epic start: epic=$EPIC harness=$HARNESS mode=$([ "$SEQUENTIAL" = 1 ] && echo "sequential(siblings:${SIBLINGS[*]:-none})" || echo "parallel:$WORKERS") base=$BASE_BRANCH gate='${GATE:-none}' timeout=${WORKER_TIMEOUT}s attempts=$MAX_ATTEMPTS push=$PUSH_ENABLED cgroup=$([ "$SCOPE_OK" -eq 1 ] && echo "cook-epic.slice cpu=$CPU_WEIGHT io=$IO_WEIGHT mem-high=$MEMORY_HIGH" || echo nice-fallback)"

TICK=5
while true; do
  [ -e "$RUN_DIR/STOP" ] && [ "$STOPPING" -eq 0 ] && { STOPPING=1; STOP_REASON='STOP file'; say 'STOP file found — draining'; }

  reap_finished
  if sequential_main_moved_unowned; then
    fatal_reconcile "base branch $BASE_BRANCH moved while no sequential worker owned the checkout; operator must reconcile"
  fi
  [ "$FATAL_STOP" -eq 1 ] || process_merges || true

  open_now=$(open_children_count)
  if [ "$STOPPING" -eq 0 ] && [ "$open_now" = 0 ] && [ "$(active_workers)" -eq 0 ] && [ "${#MERGE_QUEUE[@]}" -eq 0 ]; then
    bd note "$EPIC" "cook-epic: all children closed; $MERGED branches landed on $BASE_BRANCH${RESEARCHED:+, $RESEARCHED research children delivered findings in beads}." >/dev/null 2>>"$LOG"
    bd close "$EPIC" >/dev/null 2>>"$LOG"
    finish "epic complete — all children closed and merges landed"
    exit 0
  fi
  if [ "$STOPPING" -eq 1 ] && [ "$(active_workers)" -eq 0 ]; then
    if [ "$FATAL_STOP" -eq 1 ]; then
      finish "${STOP_REASON:-reconciliation required} (drained; merge queue frozen)"
      exit 1
    fi
    process_merges || true
    finish "${STOP_REASON:-stopped} (drained)"
    exit 0
  fi
  if [ "$open_now" != '?' ] && [ "$open_now" -gt 0 ]; then
    ready_now=$(frontier | grep -c . || true)
    if [ "$ready_now" -eq 0 ] && [ "$(active_workers)" -eq 0 ] && [ "${#MERGE_QUEUE[@]}" -eq 0 ]; then
      finish "stuck — $open_now open children but none ready (dependency-blocked or all attempts exhausted)"
      exit 1
    fi
  fi

  # Dispatch.
  if [ "$STOPPING" -eq 0 ] && [ "$DISPATCHED" -lt "$MAX_DISPATCHES" ]; then
    if [ -n "$BUDGET" ] && [ "$COST_SUPPORTED" -eq 1 ] \
      && jq -en --argjson spent "$TOTAL_COST" --argjson budget "$BUDGET" '$spent >= $budget' >/dev/null; then
      STOPPING=1; STOP_REASON="budget \$$BUDGET reached"
      say "budget reached — draining"
    else
      slots=$(( WORKERS - $(active_workers) ))
      while [ "$slots" -gt 0 ] && [ "$DISPATCHED" -lt "$MAX_DISPATCHES" ]; do
        [ -e "$RUN_DIR/STOP" ] && [ "$STOPPING" -eq 0 ] && { STOPPING=1; STOP_REASON='STOP file'; say 'STOP file found — draining'; }
        [ "$STOPPING" -eq 0 ] || break
        dispatched_one=0
        while IFS=$'\t' read -r child title; do
          [ "$DISPATCHED" -lt "$MAX_DISPATCHES" ] || break
          [ -e "$RUN_DIR/STOP" ] && [ "$STOPPING" -eq 0 ] && { STOPPING=1; STOP_REASON='STOP file'; say 'STOP file found — draining'; }
          [ "$STOPPING" -eq 0 ] || break
          [ -n "$child" ] || continue
          dispatchable "$child" || continue
          if spawn_worker "$child" "$title"; then
            dispatched_one=1
            slots=$((slots - 1))
            break
          fi
        done <<< "$(frontier)"
        [ "$dispatched_one" -eq 1 ] || break
      done
    fi
  fi
  if [ "$DISPATCHED" -ge "$MAX_DISPATCHES" ] && [ "$STOPPING" -eq 0 ]; then
    STOPPING=1; STOP_REASON="dispatch cap $MAX_DISPATCHES reached"; say "$STOP_REASON — draining"
  fi

  sleep "$TICK"
done
