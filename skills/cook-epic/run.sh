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
#   COOKEPIC_CORE              1 = delegate to the shared TypeScript core (default 0)
#   COOKEPIC_T3_BIN            t3 binary override for COOKEPIC_CORE=1
#   COOKEPIC_EPIC              beads epic id                       (REQUIRED)
#   COOKEPIC_HARNESS           auto, kimi, claude, ccx, codex, or opencode (default auto)
#                              claude/ccx workers all launch with
#                              --exclude-dynamic-system-prompt-sections so their
#                              system prompts share one cache prefix across
#                              worktrees; ENABLE_PROMPT_CACHING_1H=1 is exported
#                              (unless already set) for the longer cache TTL, and
#                              a one-shot warm-up request with the same flag/model
#                              runs before the first dispatch wave to seed that
#                              prefix — a warm-up failure only logs a WARNING and
#                              never stops the run. kimi/codex/opencode: unaffected.
#   COOKEPIC_WORKERS           max concurrent workers              (default 3)
#   COOKEPIC_MAX_DISPATCHES    global spawn cap                    (default 50)
#   COOKEPIC_WORKER_TIMEOUT    optional absolute worker timeout, seconds (unset = none)
#   COOKEPIC_IDLE_THRESHOLD    seconds without progress before inspection (default 1800)
#   COOKEPIC_INSPECTOR_TIMEOUT inspector timeout, seconds          (default 120)
#   COOKEPIC_INSPECT_RETRY_DELAY delay after failed inspection     (default 300)
#   COOKEPIC_INSPECT_MIN_DELAY minimum inspector next-check delay  (default 60)
#   COOKEPIC_INSPECT_MAX_DELAY maximum inspector next-check delay  (default 7200)
#   COOKEPIC_STOP_GRACE        grace before a stopped worker gets KILL (default 15)
#   COOKEPIC_REPO_PROBE_INTERVAL seconds between quiet repository probes (default 60)
#   COOKEPIC_REPO_PROBE_TIMEOUT repository probe timeout, seconds (default 2)
#   COOKEPIC_WORKER_ARTIFACT_BYTES rolling worker output limit (default 1048576)
#   COOKEPIC_INSPECTOR_RESULT_BYTES inspector result limit (default 4096)
#   COOKEPIC_INSPECTOR_LOG_BYTES inspector raw log limit (default 32768)
#   COOKEPIC_FOLD_TIMEOUT      fold agent timeout, seconds         (default 180)
#   COOKEPIC_REPO_EVIDENCE_BYTES aggregate repository evidence limit (default 8192)
#   COOKEPIC_MAX_ATTEMPTS      attempts per child before blocked   (default 3)
#   COOKEPIC_GATE              integration gate run before landing (REQUIRED unless COOKEPIC_NO_GATE=1)
#   COOKEPIC_NO_GATE           1 = run without a gate; workers only do cheap checks, so
#                              nothing verifies builds/e2e — an explicit, eyes-open choice
#   COOKEPIC_CPU_WEIGHT        cook-epic.slice CPUWeight               (default 50)
#   COOKEPIC_IO_WEIGHT         cook-epic.slice IOWeight                (default 50)
#   COOKEPIC_MEMORY_HIGH       cook-epic.slice MemoryHigh              (default 60%)
#   COOKEPIC_PERMISSION_MODE   auto or bypassPermissions           (default auto)
#   COOKEPIC_MODEL             primary harness model override; unset on claude/ccx
#                              means tiered defaults (sonnet workers, opus plans,
#                              fable reviews, opus when fable is out of quota).
#                              Fallback stages always use Codex gpt-5.6-sol/high
#                              and Kimi kimi-code/k3.
#   COOKEPIC_BIN               selected harness binary override
#   OPENCODE_BIN               OpenCode binary                     (default opencode)
#   COOKEPIC_SPAWN_DELAY       seconds between dispatches          (default 2)
#   COOKEPIC_BUDGET_USD        soft spend cap (claude/ccx only; stops new dispatches)
#   COOKEPIC_WORKER_CMD        test hook: run this instead of a harness
#   COOKEPIC_INSPECTOR_CMD     test hook: receives prompt and result paths
#   COOKEPIC_FOLD_CMD          test hook: receives the fold prompt path; unlike
#                              the inspector, this agent needs real bd/Bash
#                              access (it writes the epic body itself)
#   COOKEPIC_CLOCK_CMD         test hook: prints integer epoch seconds
#   COOKEPIC_RESOURCE_SAMPLER_CMD test hook: receives worker and pid; prints CPU-usec and I/O bytes
#   COOKEPIC_WORKER_ACTIVE_CMD test hook: receives worker and pid
#   COOKEPIC_WORKER_STOP_CMD   test hook: receives worker, pid, and grace seconds
#   COOKEPIC_PROCESS_START_TICKS_CMD test hook: receives pid; prints process start ticks
#   COOKEPIC_DISABLE_SYSTEMD   test hook: 1 forces owned process-group fallback
#   COOKEPIC_PUSH_CMD         test hook: receives repo then git push arguments
#   COOKEPIC_SEQUENTIAL        1 = sequential mode (explicit operator opt-in): one
#                              worker at a time, directly in the main checkout on
#                              the base branch (no worktrees, no merge queue); the
#                              coordinator gates and pushes after each child.
#   COOKEPIC_SIBLINGS          space-separated sibling repos (relative to the
#                              project root, e.g. "../proga-api") that children may
#                              also commit in. Parallel mode mirrors each sibling
#                              into the worker's layout under
#                              <run-dir>/layouts/<child>/ at its real relative
#                              position and lands every touched repo as one gated
#                              set; sequential mode commits in the real checkouts.
#                              HEAD movement there counts toward verification and
#                              gets pushed.
#   COOKEPIC_ORIENTATION_FILE  path, relative to the repo root, of the
#                              orientation card injected into every worker
#                              prompt at dispatch. Default candidates (first
#                              match wins): docs/agent-orientation.md, then
#                              AGENTS.md. When neither exists (or the override
#                              path doesn't), workers get the literal line
#                              "(no orientation card in this repo)".
#
# Stop gracefully: touch <run-dir>/STOP  (stops new dispatches, drains in-flight)
# Retune live:     echo N > <run-dir>/WORKERS  (worker cap re-read every tick)
set -uo pipefail

RUN_DIR="${1:?usage: run.sh <run-dir>}"
mkdir -p "$RUN_DIR"
RUN_DIR="$(cd "$RUN_DIR" && pwd -P)"
LOG="$RUN_DIR/loop.log"
MAILBOX="$RUN_DIR/mailbox.jsonl"
SUMMARY="$RUN_DIR/summary.md"
SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE="$SKILL_DIR/worker-prompt.md"
INSPECTOR_TEMPLATE="$SKILL_DIR/inspector-prompt.md"
FOLD_TEMPLATE="$SKILL_DIR/fold-prompt.md"

core_detect_ccx_environment() {
  [[ "${ANTHROPIC_BASE_URL:-}" =~ ^http://(localhost|127(\.[0-9]{1,3}){3}|\[::1\])(:[0-9]+)?(/.*)?$ ]] \
    && [ "${ANTHROPIC_AUTH_TOKEN:-}" = unused ] \
    && [[ "${ANTHROPIC_MODEL:-}" == *'[1m]' ]]
}

core_detect_harness() {
  [ -z "${COOKEPIC_WORKER_CMD:-}" ] || { printf 'worker-cmd\n'; return; }
  case "${COOKEPIC_HARNESS:-auto}" in
    kimi|claude|codex|opencode) printf '%s\n' "$COOKEPIC_HARNESS"; return ;;
    ccx) core_detect_ccx_environment && { printf 'ccx\n'; return; } || return 3 ;;
    auto|'') ;;
    *) return 2 ;;
  esac
  if core_detect_ccx_environment; then printf 'ccx\n'; return; fi
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
  elif [ -z "${CODEX_THREAD_ID:-}" ] \
    && { [ "${CLAUDECODE:-}" = 1 ] || [ -n "${CLAUDE_CODE_SESSION_ID:-}" ]; }; then
    printf 'claude\n'
  elif [ -z "${CODEX_THREAD_ID:-}${CLAUDECODE:-}${CLAUDE_CODE_SESSION_ID:-}" ] \
    && [ -n "${OPENCODE:-}${OPENCODE_PID:-}" ]; then
    printf 'opencode\n'
  else
    return 1
  fi
}

core_delegate() {
  local name candidate harness_status
  local -a unsupported=(
    COOKEPIC_WORKERS COOKEPIC_SIBLINGS COOKEPIC_BUDGET_USD
    COOKEPIC_IDLE_THRESHOLD COOKEPIC_INSPECTOR_TIMEOUT
    COOKEPIC_INSPECT_RETRY_DELAY COOKEPIC_INSPECT_MIN_DELAY
    COOKEPIC_INSPECT_MAX_DELAY COOKEPIC_RATE_LIMIT_BACKOFF
    COOKEPIC_CPU_WEIGHT COOKEPIC_IO_WEIGHT COOKEPIC_MEMORY_HIGH
    COOKEPIC_DISABLE_SYSTEMD COOKEPIC_SPAWN_DELAY COOKEPIC_SUPERVISION_TICK
    COOKEPIC_INSPECTOR_CMD COOKEPIC_FOLD_CMD COOKEPIC_CLOCK_CMD
    COOKEPIC_RESOURCE_SAMPLER_CMD COOKEPIC_WORKER_ACTIVE_CMD
    COOKEPIC_WORKER_STOP_CMD COOKEPIC_PROCESS_START_TICKS_CMD COOKEPIC_PUSH_CMD
    COOKEPIC_WORKER_ARTIFACT_BYTES COOKEPIC_INSPECTOR_RESULT_BYTES
    COOKEPIC_INSPECTOR_LOG_BYTES COOKEPIC_REPO_EVIDENCE_BYTES
    COOKEPIC_REPO_PROBE_INTERVAL COOKEPIC_REPO_PROBE_TIMEOUT COOKEPIC_FOLD_TIMEOUT
    RUNLOCK_HEARTBEAT_SECS RUNLOCK_STALE_SECS OPENCODE_BIN
  )
  for name in "${unsupported[@]}"; do
    if [[ -v $name && -n ${!name} ]]; then
      printf 'error: %s is not supported by COOKEPIC_CORE=1\n' "$name" >&2
      printf 'help: unset %s or use COOKEPIC_CORE=0\n' "$name" >&2
      exit 2
    fi
  done

  [ -n "${COOKEPIC_EPIC:-}" ] || {
    printf 'error: COOKEPIC_EPIC is required\n' >&2
    printf 'help: set it to the beads epic id\n' >&2
    exit 2
  }
  if [[ -v COOKEPIC_SEQUENTIAL && -n ${COOKEPIC_SEQUENTIAL} && ${COOKEPIC_SEQUENTIAL} != 1 ]]; then
    printf 'error: COOKEPIC_CORE=1 supports sequential execution only\n' >&2
    printf 'help: set COOKEPIC_SEQUENTIAL=1 or use COOKEPIC_CORE=0\n' >&2
    exit 2
  fi
  if [[ -v COOKEPIC_NO_PUSH && -n ${COOKEPIC_NO_PUSH} && ${COOKEPIC_NO_PUSH} != 1 ]]; then
    printf 'error: COOKEPIC_NO_PUSH must be exactly 1 when set\n' >&2
    printf 'help: unset it to enable pushes, or set COOKEPIC_NO_PUSH=1 for local-only landing\n' >&2
    exit 2
  fi
  if [[ -v COOKEPIC_PERMISSION_MODE && -n ${COOKEPIC_PERMISSION_MODE} ]] \
    && [ "${COOKEPIC_PERMISSION_MODE}" != auto ] \
    && [ "${COOKEPIC_PERMISSION_MODE}" != bypassPermissions ]; then
    printf 'error: unsupported COOKEPIC_PERMISSION_MODE %s\n' "$COOKEPIC_PERMISSION_MODE" >&2
    printf 'help: use auto or bypassPermissions\n' >&2
    exit 2
  fi
  if [[ -v COOKEPIC_HARNESS && -n ${COOKEPIC_HARNESS} && -z ${COOKEPIC_WORKER_CMD:-} ]]; then
    case "$COOKEPIC_HARNESS" in
      auto|kimi|claude|ccx|codex|opencode|worker-cmd) ;;
      *)
        printf 'error: invalid COOKEPIC_HARNESS %s\n' "$COOKEPIC_HARNESS" >&2
        printf 'help: use auto, kimi, claude, ccx, codex, opencode, or worker-cmd for tests\n' >&2
        exit 2
        ;;
    esac
  fi

  # The Bash path treats empty values as unset through ${name:-default}.
  for name in COOKEPIC_T3_BIN COOKEPIC_GATE COOKEPIC_NO_GATE COOKEPIC_NO_PUSH \
    COOKEPIC_MAX_DISPATCHES COOKEPIC_MAX_ATTEMPTS COOKEPIC_WORKER_TIMEOUT \
    COOKEPIC_STOP_GRACE COOKEPIC_MODEL COOKEPIC_ORIENTATION_FILE \
    COOKEPIC_HARNESS COOKEPIC_BIN COOKEPIC_WORKER_CMD COOKEPIC_PERMISSION_MODE \
    COOKEPIC_SEQUENTIAL; do
    if [[ -v $name && -z ${!name} ]]; then unset "$name"; fi
  done

  if COOKEPIC_HARNESS=$(core_detect_harness); then
    harness_status=0
  else
    harness_status=$?
  fi
  case "$harness_status" in
    0) export COOKEPIC_HARNESS ;;
    2)
      printf 'error: invalid COOKEPIC_HARNESS %s\n' "${COOKEPIC_HARNESS:-}" >&2
      printf 'help: use auto, kimi, claude, ccx, codex, or opencode\n' >&2
      exit 2
      ;;
    3)
      printf 'error: COOKEPIC_HARNESS=ccx requires the inherited ccx proxy environment\n' >&2
      printf 'help: launch from ccx\n' >&2
      exit 2
      ;;
    *)
      printf 'error: could not identify the invoking harness\n' >&2
      printf 'help: set COOKEPIC_HARNESS to kimi, claude, ccx, codex, or opencode\n' >&2
      exit 2
      ;;
  esac

  local core_skill_dir core_checkout repo_root
  local -a core_command
  core_skill_dir="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  core_checkout="$(cd "$core_skill_dir/../.." && pwd -P)"
  repo_root="$(pwd -P)"
  if [ -n "${COOKEPIC_T3_BIN:-}" ] \
    && candidate=$(command -v -- "$COOKEPIC_T3_BIN" 2>/dev/null); then
    core_command=("$candidate")
  elif candidate=$(command -v t3 2>/dev/null); then
    core_command=("$candidate")
  elif [ -f "$core_checkout/apps/server/dist/bin.mjs" ]; then
    core_command=(node "$core_checkout/apps/server/dist/bin.mjs")
  elif [ -f "$core_checkout/apps/server/src/bin.ts" ]; then
    core_command=(node "$core_checkout/apps/server/src/bin.ts")
  else
    printf 'error: could not resolve t3 from COOKEPIC_T3_BIN, t3 on PATH, %s, or %s\n' \
      "$core_checkout/apps/server/dist/bin.mjs" "$core_checkout/apps/server/src/bin.ts" >&2
    printf 'help: set COOKEPIC_T3_BIN or use COOKEPIC_CORE=0\n' >&2
    exit 2
  fi

  : > "$LOG"; : > "$MAILBOX"; : > "$SUMMARY"
  exec "${core_command[@]}" epic cook --epic "$COOKEPIC_EPIC" \
    --cwd "$repo_root" --run-dir "$RUN_DIR"
  printf 'error: failed to exec the resolved t3 entrypoint\n' >&2
  exit 2
}

CORE_MODE="${COOKEPIC_CORE:-0}"
case "$CORE_MODE" in
  0) ;;
  1) core_delegate ;;
  *)
    printf 'error: COOKEPIC_CORE must be 0 or 1\n' >&2
    printf 'help: use 1 for the shared core or 0 for the Bash coordinator\n' >&2
    exit 2
    ;;
esac

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
WORKER_TIMEOUT="${COOKEPIC_WORKER_TIMEOUT:-}"
IDLE_THRESHOLD="${COOKEPIC_IDLE_THRESHOLD:-1800}"
INSPECTOR_TIMEOUT="${COOKEPIC_INSPECTOR_TIMEOUT:-120}"
INSPECT_RETRY_DELAY="${COOKEPIC_INSPECT_RETRY_DELAY:-300}"
INSPECT_MIN_DELAY="${COOKEPIC_INSPECT_MIN_DELAY:-60}"
INSPECT_MAX_DELAY="${COOKEPIC_INSPECT_MAX_DELAY:-7200}"
STOP_GRACE="${COOKEPIC_STOP_GRACE:-15}"
SUPERVISION_TICK="${COOKEPIC_SUPERVISION_TICK:-5}"
REPO_PROBE_INTERVAL="${COOKEPIC_REPO_PROBE_INTERVAL:-60}"
REPO_PROBE_TIMEOUT="${COOKEPIC_REPO_PROBE_TIMEOUT:-2}"
WORKER_ARTIFACT_BYTES="${COOKEPIC_WORKER_ARTIFACT_BYTES:-1048576}"
INSPECTOR_RESULT_BYTES="${COOKEPIC_INSPECTOR_RESULT_BYTES:-4096}"
INSPECTOR_LOG_BYTES="${COOKEPIC_INSPECTOR_LOG_BYTES:-32768}"
REPO_EVIDENCE_BYTES="${COOKEPIC_REPO_EVIDENCE_BYTES:-8192}"
CPU_PROGRESS_USEC=100000
IO_PROGRESS_BYTES=4096
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
INSPECTOR_CMD="${COOKEPIC_INSPECTOR_CMD:-}"
FOLD_CMD="${COOKEPIC_FOLD_CMD:-}"
FOLD_TIMEOUT="${COOKEPIC_FOLD_TIMEOUT:-180}"
CLOCK_CMD="${COOKEPIC_CLOCK_CMD:-}"
RESOURCE_SAMPLER_CMD="${COOKEPIC_RESOURCE_SAMPLER_CMD:-}"
WORKER_ACTIVE_CMD="${COOKEPIC_WORKER_ACTIVE_CMD:-}"
WORKER_STOP_CMD="${COOKEPIC_WORKER_STOP_CMD:-}"
PROCESS_START_TICKS_CMD="${COOKEPIC_PROCESS_START_TICKS_CMD:-}"
DISABLE_SYSTEMD="${COOKEPIC_DISABLE_SYSTEMD:-0}"
RATE_LIMIT_BACKOFF="${COOKEPIC_RATE_LIMIT_BACKOFF:-120}"
NO_PUSH="${COOKEPIC_NO_PUSH:-}"
SEQUENTIAL="${COOKEPIC_SEQUENTIAL:-0}"
ORIENTATION_FILE="${COOKEPIC_ORIENTATION_FILE:-}"
SIBLINGS=()
for s in ${COOKEPIC_SIBLINGS:-}; do SIBLINGS+=("$s"); done
if [ "$SEQUENTIAL" = 1 ]; then
  WORKERS=1
  TEMPLATE="$SKILL_DIR/worker-prompt-sequential.md"
fi

[[ "$WORKERS" =~ ^[1-9][0-9]*$ ]] || die 'COOKEPIC_WORKERS must be a positive integer' 'use 1 or more'
[[ "$MAX_DISPATCHES" =~ ^[1-9][0-9]*$ ]] || die 'COOKEPIC_MAX_DISPATCHES must be a positive integer' 'use 1 or more'
[[ "$MAX_ATTEMPTS" =~ ^[1-9][0-9]*$ ]] || die 'COOKEPIC_MAX_ATTEMPTS must be a positive integer' 'use 1 or more'
[ -z "$WORKER_TIMEOUT" ] || [[ "$WORKER_TIMEOUT" =~ ^[1-9][0-9]*$ ]] || die 'COOKEPIC_WORKER_TIMEOUT must be a positive integer when set' 'use whole seconds or unset it for no absolute timeout'
[[ "$IDLE_THRESHOLD" =~ ^[1-9][0-9]*$ ]] || die 'COOKEPIC_IDLE_THRESHOLD must be a positive integer' 'use whole seconds'
[[ "$INSPECTOR_TIMEOUT" =~ ^[1-9][0-9]*$ ]] || die 'COOKEPIC_INSPECTOR_TIMEOUT must be a positive integer' 'use whole seconds'
[[ "$INSPECT_RETRY_DELAY" =~ ^[1-9][0-9]*$ ]] || die 'COOKEPIC_INSPECT_RETRY_DELAY must be a positive integer' 'use whole seconds'
[[ "$INSPECT_MIN_DELAY" =~ ^[1-9][0-9]*$ ]] || die 'COOKEPIC_INSPECT_MIN_DELAY must be a positive integer' 'use whole seconds'
[[ "$INSPECT_MAX_DELAY" =~ ^[1-9][0-9]*$ ]] || die 'COOKEPIC_INSPECT_MAX_DELAY must be a positive integer' 'use whole seconds'
[[ "$STOP_GRACE" =~ ^[1-9][0-9]*$ ]] || die 'COOKEPIC_STOP_GRACE must be a positive integer' 'use whole seconds'
[[ "$SUPERVISION_TICK" =~ ^([1-9][0-9]*([.][0-9]+)?|0[.][0-9]*[1-9][0-9]*)$ ]] \
  || die 'COOKEPIC_SUPERVISION_TICK must be a positive number' 'use seconds greater than zero'
[[ "$REPO_PROBE_INTERVAL" =~ ^[1-9][0-9]*$ ]] || die 'COOKEPIC_REPO_PROBE_INTERVAL must be a positive integer' 'use whole seconds'
[[ "$REPO_PROBE_TIMEOUT" =~ ^[1-9][0-9]*$ ]] || die 'COOKEPIC_REPO_PROBE_TIMEOUT must be a positive integer' 'use whole seconds'
[[ "$WORKER_ARTIFACT_BYTES" =~ ^[1-9][0-9]*$ ]] || die 'COOKEPIC_WORKER_ARTIFACT_BYTES must be a positive integer' 'use bytes'
[[ "$INSPECTOR_RESULT_BYTES" =~ ^[1-9][0-9]*$ ]] || die 'COOKEPIC_INSPECTOR_RESULT_BYTES must be a positive integer' 'use bytes'
[[ "$INSPECTOR_LOG_BYTES" =~ ^[1-9][0-9]*$ ]] || die 'COOKEPIC_INSPECTOR_LOG_BYTES must be a positive integer' 'use bytes'
[[ "$REPO_EVIDENCE_BYTES" =~ ^[1-9][0-9]*$ ]] || die 'COOKEPIC_REPO_EVIDENCE_BYTES must be a positive integer' 'use bytes'
[[ "$FOLD_TIMEOUT" =~ ^[1-9][0-9]*$ ]] || die 'COOKEPIC_FOLD_TIMEOUT must be a positive integer' 'use whole seconds'
[ "$DISABLE_SYSTEMD" = 0 ] || [ "$DISABLE_SYSTEMD" = 1 ] || die 'COOKEPIC_DISABLE_SYSTEMD must be 0 or 1' 'use 1 only in fallback tests'
[ "$INSPECT_MIN_DELAY" -le "$INSPECT_MAX_DELAY" ] || die 'COOKEPIC_INSPECT_MIN_DELAY must not exceed COOKEPIC_INSPECT_MAX_DELAY' 'raise the maximum or lower the minimum'
[[ "$SPAWN_DELAY" =~ ^[0-9]+$ ]] || die 'COOKEPIC_SPAWN_DELAY must be zero or a positive integer' 'use whole seconds'
[[ "$RATE_LIMIT_BACKOFF" =~ ^[0-9]+$ ]] || die 'COOKEPIC_RATE_LIMIT_BACKOFF must be zero or a positive integer' 'use whole seconds'
[ -z "$BUDGET" ] || [[ "$BUDGET" =~ ^[0-9]+([.][0-9]+)?$ ]] || die 'COOKEPIC_BUDGET_USD must be a positive number' 'provide a dollar amount or remove it'
[ -z "$NO_PUSH" ] || [ "$NO_PUSH" = 1 ] || die 'COOKEPIC_NO_PUSH must be exactly 1 when set' 'unset it to enable pushes, or set COOKEPIC_NO_PUSH=1 for local-only landing'
if [ -z "$GATE" ] && [ "$NO_GATE" != 1 ]; then
  die 'COOKEPIC_GATE is required — workers only run cheap checks; the gate is the full verification' \
      'set COOKEPIC_GATE to the build+test command, or COOKEPIC_NO_GATE=1 to knowingly run unverified'
fi

for tool in jq timeout git bd flock setsid sha256sum; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool is required" "install $tool and rerun"
done
[ -d .beads ] || die 'no .beads directory here' 'launch from the project root of a beads-enabled repo'
[ -f "$TEMPLATE" ] || die "worker prompt template missing: $TEMPLATE" 'reinstall the cook-epic skill'
[ -f "$INSPECTOR_TEMPLATE" ] || die "inspector prompt template missing: $INSPECTOR_TEMPLATE" 'reinstall the cook-epic skill'
[ -f "$FOLD_TEMPLATE" ] || die "fold prompt template missing: $FOLD_TEMPLATE" 'reinstall the cook-epic skill'
if git ls-files .beads | grep -qE '^\.beads/(dolt/|dolt-server\.|.*\.db$)'; then
  die 'the beads DATA dir is git-tracked; worktrees would fork the database' 'untrack the dolt data before running cook-epic'
fi

# Workers commit in the main checkout (sequential) or in per-child worktrees and
# mirrored sibling worktrees (parallel). Normalize sibling paths before storing
# them in effect baselines or comparing them to `git worktree list` output,
# which is absolute.
REPO="$(pwd -P)"
REPO_BASENAME="${REPO##*/}"
PUSH_ENABLED=0
if [ "$NO_PUSH" = 1 ]; then
  : # Explicit local-only mode.
elif git remote get-url origin >/dev/null 2>&1; then
  PUSH_ENABLED=1
else
  die 'push-enabled run requires an origin remote' 'add origin or set COOKEPIC_NO_PUSH=1 for local-only landing'
fi
# Parallel runs with siblings mirror each worker into a run-scoped layout root
# outside both repos, reproducing the siblings' real relative positions so
# references like `../proga-api` resolve inside the sandbox.
LAYOUT_MODE=0
[ "$SEQUENTIAL" != 1 ] && [ "${#SIBLINGS[@]}" -gt 0 ] && LAYOUT_MODE=1
LAYOUT_ROOT="$RUN_DIR/layouts"
declare -A SIB_BRANCH=() SIB_REL=() SIB_INTEG_WT=() SIB_LAST_ACCEPTED=()
if [ "${#SIBLINGS[@]}" -gt 0 ]; then
  canonical_siblings=()
  declare -A layout_mirror_seen=()
  for s in "${SIBLINGS[@]}"; do
    s=$(realpath "$s" 2>/dev/null) \
      || die "sibling repo '$s' does not exist" 'COOKEPIC_SIBLINGS entries must be existing git repos relative to the project root'
    git -C "$s" rev-parse --git-dir >/dev/null 2>&1 \
      || die "sibling repo '$s' is not a git repository" 'COOKEPIC_SIBLINGS entries must be git repos relative to the project root'
    SIB_BRANCH[$s]=$(git -C "$s" symbolic-ref --short HEAD 2>/dev/null) \
      || die "sibling repo '$s' is not on a branch" 'check out a branch there before launching'
    git -C "$s" update-index --refresh -q >/dev/null 2>&1 || true
    git -C "$s" diff-index --quiet HEAD -- . ':(exclude).beads' 2>/dev/null \
      || die "sibling repo '$s' has uncommitted changes" 'commit or stash there before launching; workers commit on its branch'
    if [ "$PUSH_ENABLED" -eq 1 ]; then
      git -C "$s" remote get-url origin >/dev/null 2>&1 \
        || die "sibling repo '$s' has no origin remote" 'add an origin remote or set COOKEPIC_NO_PUSH=1'
    fi
    if [ "$LAYOUT_MODE" -eq 1 ]; then
      rel=$(realpath --relative-to="$REPO" "$s" 2>/dev/null) \
        || die "cannot compute the relative path from $REPO to sibling '$s'" 'siblings must be reachable by a relative path from the project root'
      SIB_REL[$s]="$rel"
      # Validate mirrorability against a symbolic probe root: the mirrored path
      # must stay inside the layout and outside the main-repo worktree.
      probe="/cook-epic-layout-probe"
      mirrored=$(realpath -m "$probe/$REPO_BASENAME/$rel")
      case "$mirrored" in
        "$probe/$REPO_BASENAME"|"$probe/$REPO_BASENAME/"*)
          die "sibling repo '$s' resolves inside the main repository; parallel layouts cannot mirror it" \
            'move the sibling outside the project root or run with COOKEPIC_SEQUENTIAL=1' ;;
        "$probe/"*) ;;
        *)
          die "sibling repo '$s' escapes the worker layout root (relative path '$rel' cannot be mirrored)" \
            'place siblings beside the project root or run with COOKEPIC_SEQUENTIAL=1' ;;
      esac
      [ -z "${layout_mirror_seen[$mirrored]:-}" ] \
        || die "sibling repos '$s' and '${layout_mirror_seen[$mirrored]}' mirror to the same layout path" \
          'give the siblings distinct relative positions'
      layout_mirror_seen[$mirrored]="$s"
    fi
    canonical_siblings+=("$s")
  done
  SIBLINGS=("${canonical_siblings[@]}")
fi

RUN_ID="${RUN_DIR##*/}"
# Scope names must be stable without collapsing distinct repositories or run
# paths onto the same lossy basename. NUL separators make the tuple unambiguous.
SCOPE_ID="$(printf '%s\0%s\0%s\0%s\0' "$REPO" "$RUN_DIR" "$EPIC" "$RUN_ID" | sha256sum)"
SCOPE_ID="${SCOPE_ID%% *}"
SCOPE_ID="${SCOPE_ID:0:24}"
WORKTREE_ROOT="$REPO/.worktrees/cook-epic-$RUN_ID"
INTEG_BRANCH="cook-epic-integration-$RUN_ID"
if [ "$LAYOUT_MODE" -eq 1 ]; then
  # The integration layout mirrors the worker layouts, so the gate resolves
  # relative sibling references against the sibling trial merges.
  INTEG_WT="$LAYOUT_ROOT/.integration/$REPO_BASENAME"
else
  INTEG_WT="$WORKTREE_ROOT/.integration"
fi

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

PRIMARY_MODEL="${COOKEPIC_MODEL:-}"
ACTIVE_MODEL=''
CODEX_HIGH_REASONING=0
INITIAL_PROVIDER_FALLBACK_FROM=''

configure_harness() { # <harness> <is-primary: 0|1>
  local next="$1" primary="$2"
  HARNESS="$next"
  CODEX_HIGH_REASONING=0
  case "$HARNESS" in
    kimi)
      AGENT_BIN=$([ "$primary" -eq 1 ] && printf '%s' "${COOKEPIC_BIN:-kimi}" || printf kimi)
      ACTIVE_MODEL=$([ "$primary" -eq 1 ] && printf '%s' "$PRIMARY_MODEL" || printf 'kimi-code/k3')
      COST_SUPPORTED=0
      ;;
    claude|ccx)
      AGENT_BIN="${COOKEPIC_BIN:-claude}"
      ACTIVE_MODEL="$PRIMARY_MODEL"
      COST_SUPPORTED=1
      ;;
    codex)
      AGENT_BIN=$([ "$primary" -eq 1 ] && printf '%s' "${COOKEPIC_BIN:-codex}" || printf codex)
      ACTIVE_MODEL=$([ "$primary" -eq 1 ] && printf '%s' "$PRIMARY_MODEL" || printf 'gpt-5.6-sol')
      [ "$primary" -eq 1 ] || CODEX_HIGH_REASONING=1
      COST_SUPPORTED=0
      ;;
    opencode)
      AGENT_BIN="${COOKEPIC_BIN:-${OPENCODE_BIN:-opencode}}"
      ACTIVE_MODEL="$PRIMARY_MODEL"
      COST_SUPPORTED=0
      ;;
    worker-cmd)
      AGENT_BIN="$WORKER_CMD"
      ACTIVE_MODEL="$PRIMARY_MODEL"
      COST_SUPPORTED=0
      ;;
  esac
}

next_installed_harness() { # <current harness> -> first installed later stage
  local candidate
  local -a candidates=()
  case "$1" in
    claude|ccx) candidates=(codex kimi) ;;
    codex) candidates=(kimi) ;;
    *) candidates=() ;;
  esac
  for candidate in "${candidates[@]}"; do
    command -v "$candidate" >/dev/null 2>&1 && { printf '%s\n' "$candidate"; return 0; }
  done
  return 1
}

configure_harness "$HARNESS" 1
if ! command -v "$AGENT_BIN" >/dev/null 2>&1; then
  missing_harness="$HARNESS"
  if fallback_harness=$(next_installed_harness "$HARNESS"); then
    INITIAL_PROVIDER_FALLBACK_FROM="$missing_harness"
    configure_harness "$fallback_harness" 0
  else
    die "harness binary not found: $AGENT_BIN" 'install the selected harness or a later Codex/Kimi fallback'
  fi
fi
if [ -n "$INITIAL_PROVIDER_FALLBACK_FROM" ]; then
  mbox --arg from "$INITIAL_PROVIDER_FALLBACK_FROM" --arg to "$HARNESS" --arg reason 'binary unavailable' --arg ts "$(date +%H:%M:%S)" \
    '{event:"provider-fallback",from:$from,to:$to,reason:$reason,ts:$ts}'
  say "provider fallback: $INITIAL_PROVIDER_FALLBACK_FROM -> $HARNESS (binary unavailable)"
fi
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
process_start_ticks() { # <pid> -> owned-process identity, with a test seam for PID reuse
  if [ -n "$PROCESS_START_TICKS_CMD" ]; then
    "$PROCESS_START_TICKS_CMD" "$1" 2>>"$LOG" || true
  else
    run_lock_start_ticks "$1"
  fi
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
git update-index --refresh -q >/dev/null 2>&1 || true
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

# Sibling rule injected into the worker prompt. Sequential mode names the real
# checkouts; parallel layout mode builds a per-worker rule in spawn_worker,
# because every worker's mirrored sibling paths differ.
if [ "$SEQUENTIAL" = 1 ] && [ "${#SIBLINGS[@]}" -gt 0 ]; then
  SIBLING_RULE="This child may span sibling repositories: ${SIBLINGS[*]} (relative to the project root). You may read, write, build, and commit in them — commit on their current branch, never push; the coordinator pushes whatever moved after the gate. Say which repos gained commits in your close-out note."
elif [ "$LAYOUT_MODE" -eq 1 ]; then
  SIBLING_RULE='' # replaced per worker in spawn_worker
else
  SIBLING_RULE='Work only in this repository.'
fi

# Model tiers for Claude-family workers: implementation sessions launch on
# Sonnet (see spawn_worker), and the prompt tells them to raise planning to
# Opus and reviews to Fable via subagent model overrides. Reviews fall back to
# Opus when Fable is out of quota; the worker must not echo that limit error,
# because reap_worker reads rate-limit wording in worker output as a provider
# limit on the whole child. An explicit COOKEPIC_MODEL pins the primary stage.
MODEL_TIER_RULE=''
refresh_model_tier_rule() {
  MODEL_TIER_RULE=''
  if { [ "$HARNESS" = claude ] || [ "$HARNESS" = ccx ]; } && [ -z "$ACTIVE_MODEL" ]; then
    MODEL_TIER_RULE="Model tiers: your session runs on Sonnet — implement in it directly. When you dispatch a planning agent (a Plan or plan-composition subagent), pass model 'opus'; when you dispatch reviewer agents, pass model 'fable'. Mechanical work needs no subagents at all. If a 'fable' dispatch fails because the model is unavailable or its usage limit is exhausted, re-dispatch that same agent on model 'opus' and continue — never skip the review over a model limit. Report that fallback as 'reviews ran on opus' only: do NOT quote the limit error, the words 'rate limit', 'quota exceeded', 'overloaded', or the number 429 anywhere in your output, or the coordinator reads your whole child as provider rate-limited and requeues it."
  fi
}
refresh_model_tier_rule

[ "$LAYOUT_MODE" -eq 1 ] || mkdir -p "$WORKTREE_ROOT"

# ---------------------------------------------------- resource governance ----
# The whole fleet — every worker, everything it spawns (builds, browsers), and
# the integration gate — runs inside cook-epic.slice, so the interactive
# session always wins CPU/IO contention and the fleet cannot swap-thrash the
# machine. Real workers require a systemd user scope so descendants cannot
# escape supervision by changing their process group or session.
# heavy.lock additionally serializes the expensive commands (integration gate,
# Merge fix gate reruns) machine-wide: at most one runs at a time.
HEAVY_LOCK="$RUN_DIR/heavy.lock"
touch "$HEAVY_LOCK"
SCOPE_OK=0
if [ "$DISABLE_SYSTEMD" -ne 1 ] && command -v systemd-run >/dev/null 2>&1 \
   && systemd-run --user --scope --quiet -- true >/dev/null 2>&1; then
  if systemctl --user list-units --all --plain --no-legend --no-pager \
      "cook-epic-$SCOPE_ID-*.scope" 2>/dev/null | grep -q '[^[:space:]]'; then
    die "pre-existing worker or inspector scope uses run identity $SCOPE_ID" \
      'use a different run directory or reconcile the existing scope before launching'
  fi
  SCOPE_OK=1
  systemctl --user set-property --runtime cook-epic.slice \
    CPUWeight="$CPU_WEIGHT" IOWeight="$IO_WEIGHT" MemoryHigh="$MEMORY_HIGH" >>"$LOG" 2>&1 \
    || say 'WARNING: could not set cook-epic.slice properties; scoping without limits'
else
  [ -n "$WORKER_CMD" ] || die 'a systemd user session is required for worker supervision' \
    'start the systemd user manager or run this workload through the server-owned EpicRunner'
  say 'WARNING: systemd disabled for a test-hook worker; process sessions are not a production isolation seam'
fi

fleet_run() { # run a command under the fleet's resource cgroup
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

gate_run() { # run $GATE with this coordinator's own COOKEPIC_*/FLEET_UNIT vars stripped
  # A gate command may itself be (or invoke) cook-epic's own test suite —
  # self-testing this skill against a repo whose ambient environment already
  # carries this coordinator's COOKEPIC_EPIC/COOKEPIC_SIBLINGS/etc leaks that
  # state into the nested run, corrupting fixtures that assume a clean slate.
  # FLEET_UNIT isn't COOKEPIC_-prefixed but leaks the same way: unset it so
  # fleet_run asks systemd-run for an anonymous scope instead of reusing this
  # coordinator's own (possibly still-live) unit name, which nested/self-test
  # runs would otherwise collide with ("already loaded or has a fragment file").
  local name
  while IFS='=' read -r name _; do
    case "$name" in COOKEPIC_*) unset "$name" ;; esac
  done < <(env)
  unset FLEET_UNIT
  fleet_run flock "$HEAVY_LOCK" bash -c "$GATE"
}

fallback_exec() { # <identity file> <command...>
  local identity="$1" pid rc=0
  shift
  rm -f "$identity"
  setsid bash -c '
    identity=$1
    shift
    stat=$(cat "/proc/$$/stat" 2>/dev/null) || exit 125
    rest=${stat##*\) }
    read -ra fields <<< "$rest"
    pgid=${fields[2]:-0}
    sid=${fields[3]:-0}
    ticks=${fields[19]:-}
    [ "$pgid" = "$$" ] && [ "$sid" = "$$" ] && [ -n "$ticks" ] || exit 125
    tmp="$identity.tmp.$$"
    printf "%s %s %s\n" "$$" "$ticks" "$pgid" > "$tmp" || exit 125
    mv -f "$tmp" "$identity" || exit 125
    exec nice -n 10 "$@"
  ' bash "$identity" "$@" &
  pid=$!
  wait "$pid" || rc=$?
  return "$rc"
}

owned_identity_load() { # <identity file> <bookkeeping pid>
  local identity="$1" bookkeeping="$2" attempts=0 pid ticks pgid
  while [ "$attempts" -lt 500 ]; do
    if read -r pid ticks pgid 2>/dev/null < "$identity" \
       && [[ "$pid" =~ ^[1-9][0-9]*$ && "$ticks" =~ ^[1-9][0-9]*$ && "$pgid" = "$pid" ]]; then
      OWNED_PID="$pid"; OWNED_TICKS="$ticks"; OWNED_PGID="$pgid"
      return 0
    fi
    kill -0 "$bookkeeping" 2>/dev/null || break
    sleep 0.01
    attempts=$((attempts + 1))
  done
  return 1
}

worker_exec() { # <identity file> <command...>
  local identity="$1"
  shift
  if [ "$SCOPE_OK" -eq 1 ]; then fleet_run "$@"; else fallback_exec "$identity" "$@"; fi
}

inspector_exec() { # <identity file> <command...>
  local identity="$1"
  shift
  if [ "$SCOPE_OK" -eq 1 ]; then fleet_run "$@"; else fallback_exec "$identity" "$@"; fi
}

worker_scope_active() { # <worker> -> 0 when that worker's scope still has tasks
  [ "$SCOPE_OK" -eq 1 ] || return 1
  systemctl --user is-active --quiet "$(worker_unit "$1")" 2>/dev/null
}

PROVIDER_FAILURE_PHRASE_RE='rate.?limit|usage[[:space:]]+limit|spend[[:space:]]+limit|overloaded|quota[[:space:]]+exceeded|authentication|unauthorized|invalid[[:space:]]+api[[:space:]]+key|credit[[:space:]]+balance|service[[:space:]]+unavailable|temporarily[[:space:]]+unavailable|(^|[^0-9])(401|429|503)([^0-9]|$)'
PROVIDER_RATE_PHRASE_RE='rate.?limit|usage[[:space:]]+limit|spend[[:space:]]+limit|overloaded|quota[[:space:]]+exceeded|(^|[^0-9])429([^0-9]|$)'
PROVIDER_ERROR_LINE_RE='^[[:space:]]*provider[-_ ](error|failure):[[:space:]]*.+[[:space:]]*$'
STRUCTURED_ERROR_RE='"is_error"[[:space:]]*:[[:space:]]*true|"type"[[:space:]]*:[[:space:]]*"(error|failure|failed)"|"subtype"[[:space:]]*:[[:space:]]*"(error|failure|failed)[^"]*"|"error"[[:space:]]*:[[:space:]]*("|\{)'

structured_provider_error_text() { # <artifact> — strings only from structured harness error records
  jq -Rrs '
    [ split("\n")[] | fromjson?
      | .. | objects
      | select(
          (.is_error? == true)
          or (((.type? // "") | tostring) | test("^(error|failure|failed)$"; "i"))
          or (((.subtype? // "") | tostring) | test("^(error|failure|failed)([_-]|$)"; "i"))
          or ((.error? != null) and (.error? != false))
        )
      | [.. | strings] | join(" ")
    ] | join("\n")
  ' "$1" 2>/dev/null
}

provider_failure_evidence() { # <artifact> <bounded marker> <rc>
  local artifact="$1" marker="$2" rc="$3" structured provider_lines
  if [ "$rc" -eq 126 ] || [ "$rc" -eq 127 ]; then
    return 0
  fi
  [ -n "$marker" ] && [ -f "$marker" ] && return 0
  provider_lines="$(grep -iE "$PROVIDER_ERROR_LINE_RE" "$artifact" 2>/dev/null || true)"
  grep -qiE "$PROVIDER_FAILURE_PHRASE_RE" <<<"$provider_lines" && return 0
  structured="$(structured_provider_error_text "$artifact")"
  grep -qiE "$PROVIDER_FAILURE_PHRASE_RE" <<<"$structured"
}

provider_rate_failure_evidence() { # <artifact> <bounded marker>
  local artifact="$1" marker="$2" structured provider_lines
  [ -n "$marker" ] && [ "$(cat "$marker" 2>/dev/null || true)" = rate ] && return 0
  provider_lines="$(grep -iE "$PROVIDER_ERROR_LINE_RE" "$artifact" 2>/dev/null || true)"
  grep -qiE "$PROVIDER_RATE_PHRASE_RE" <<<"$provider_lines" && return 0
  structured="$(structured_provider_error_text "$artifact")"
  grep -qiE "$PROVIDER_RATE_PHRASE_RE" <<<"$structured"
}

stream_has_provider_failure_evidence() { # <bounded scan text>
  local scan="$1" evidence_lines
  evidence_lines="$(grep -iE "$PROVIDER_ERROR_LINE_RE|$STRUCTURED_ERROR_RE" <<<"$scan" || true)"
  grep -qiE "$PROVIDER_FAILURE_PHRASE_RE" <<<"$evidence_lines"
}

stream_has_provider_rate_failure_evidence() { # <bounded scan text>
  local scan="$1" evidence_lines
  evidence_lines="$(grep -iE "$PROVIDER_ERROR_LINE_RE|$STRUCTURED_ERROR_RE" <<<"$scan" || true)"
  grep -qiE "$PROVIDER_RATE_PHRASE_RE" <<<"$evidence_lines"
}

# Keep a rolling tail while recording state that must survive truncation.
bounded_stream() { # <path> <limit> [byte count] [provider-failure marker] [cost path] [overflow marker]
  local path="$1" limit="$2" count_path="${3:-}" rate_path="${4:-}" cost_path="${5:-}" overflow_path="${6:-}"
  local LC_ALL=C
  local chunk='' scan='' overlap='' remaining='' cost='' total=0 retained=0 size read_rc compact_at tmp="$path.tmp.$BASHPID"
  compact_at=$((limit + (limit > 65536 ? limit : 65536)))
  : > "$path"
  [ -z "$count_path" ] || printf '0\n' > "$count_path"
  [ -z "$overflow_path" ] || rm -f "$overflow_path"
  while true; do
    chunk=''; read_rc=0
    IFS= LC_ALL=C read -r -t 0.2 -N 4096 chunk || read_rc=$?
    if [ -n "$chunk" ]; then
      printf '%s' "$chunk" >> "$path"
      total=$((total + ${#chunk}))
      retained=$((retained + ${#chunk}))
      if [ -n "$count_path" ]; then
        printf '%s\n' "$total" > "$count_path"
      fi
      if [ -n "$rate_path$cost_path" ]; then
        scan="$overlap$chunk"
        if [ -n "$rate_path" ]; then
          if stream_has_provider_failure_evidence "$scan"; then
            [ -f "$rate_path" ] || printf 'provider\n' > "$rate_path"
            stream_has_provider_rate_failure_evidence "$scan" && printf 'rate\n' > "$rate_path"
          fi
        fi
        if [ -n "$cost_path" ]; then
          remaining="$scan"
          while [[ "$remaining" =~ \"total_cost_usd\"[[:space:]]*:[[:space:]]*([0-9]+([.][0-9]+)?) ]]; do
            cost="${BASH_REMATCH[1]}"
            remaining="${remaining#*"${BASH_REMATCH[0]}"}"
          done
          [ -z "$cost" ] || printf '%s\n' "$cost" > "$cost_path"
        fi
        overlap="${scan: -256}"
      fi
      [ -z "$overflow_path" ] || [ "$total" -le "$limit" ] || : > "$overflow_path"
      if [ "$retained" -ge "$compact_at" ]; then
        tail -c "$limit" "$path" > "$tmp" 2>/dev/null || : > "$tmp"
        mv -f "$tmp" "$path"
        retained="$limit"
      fi
    fi
    [ "$read_rc" -eq 1 ] && break
  done
  size="$retained"
  if [ "$size" -gt "$limit" ]; then
    tail -c "$limit" "$path" > "$tmp" 2>/dev/null || : > "$tmp"
    mv -f "$tmp" "$path"
  fi
}

capture_worker() { # <artifact> <bytes> <rate marker> <cost path> <command...>
  local artifact="$1" bytes="$2" rate="$3" cost="$4" fifo="$1.pipe" sink rc=0
  shift 4
  rm -f "$fifo"; mkfifo "$fifo"
  bounded_stream "$artifact" "$WORKER_ARTIFACT_BYTES" "$bytes" "$rate" "$cost" < "$fifo" & sink=$!
  "$@" > "$fifo" 2>&1 || rc=$?
  wait "$sink" 2>/dev/null || true
  rm -f "$fifo"
  return "$rc"
}

# Untracked per-worktree essentials that apply to ANY repo in a layout:
# node_modules symlink + dev env files, sourced from that repo's real checkout.
setup_worktree_assets() { # <source repo> <worktree>
  local src="$1" wt="$2" f
  [ -e "$wt/node_modules" ] || [ ! -d "$src/node_modules" ] || ln -s "$src/node_modules" "$wt/node_modules"
  for f in .env .env.local .env.development .env.development.local .env.test; do
    [ -f "$src/$f" ] && [ ! -e "$wt/$f" ] && cp "$src/$f" "$wt/$f"
  done
  return 0
}

# Set up a MAIN-repo worktree's untracked essentials. Beads access uses bd's
# native redirect mechanism (.beads/redirect holds the relative path to the main
# checkout's .beads; it is gitignored, so it can never be committed or block a
# merge) plus BEADS_DIR in the worker environment as an absolute-path backup.
# Sibling worktrees get only setup_worktree_assets — siblings have no beads db.
# $1 = worktree path
setup_worktree() {
  local wt="$1" rel
  mkdir -p "$wt/.beads"
  rel=$(realpath --relative-to="$wt" "$REPO/.beads")
  printf '%s' "$rel" > "$wt/.beads/redirect"
  setup_worktree_assets "$REPO" "$wt"
}

sibling_layout_wt() { # <layout root> <canonical sibling> -> mirrored worktree path
  realpath -m "$1/$REPO_BASENAME/${SIB_REL[$2]}"
}

branch_ahead() { # <repo> <base ref> <branch> -> commits on branch not on base (0 when the branch is missing)
  local n
  git -C "$1" show-ref --verify --quiet "refs/heads/$3" || { printf '0\n'; return 0; }
  n=$(git -C "$1" rev-list --count "$2..$3" 2>/dev/null) || n=0
  [[ "$n" =~ ^[0-9]+$ ]] || n=0
  printf '%s\n' "$n"
}

delete_branch_everywhere() { # <branch> — best-effort local deletion in main + siblings
  local s
  git branch -D "$1" >>"$LOG" 2>&1 || true
  [ "$LAYOUT_MODE" -eq 1 ] || return 0
  for s in "${SIBLINGS[@]}"; do
    git -C "$s" branch -D "$1" >>"$LOG" 2>&1 || true
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
  [ "$LAYOUT_MODE" -ne 1 ] || mkdir -p "$(dirname "$INTEG_WT")"
  git worktree add "$INTEG_WT" -b "$INTEG_BRANCH" "$BASE_BRANCH" >>"$LOG" 2>&1 \
    || die 'failed to create integration worktree' "see $LOG"
  setup_worktree "$INTEG_WT"
  if [ "$LAYOUT_MODE" -eq 1 ]; then
    # One integration worktree per sibling, mirrored beside the main one, so
    # set trial-merges and the gate see the same relative structure as workers.
    for s in "${SIBLINGS[@]}"; do
      SIB_INTEG_WT[$s]=$(sibling_layout_wt "$LAYOUT_ROOT/.integration" "$s")
      if git -C "$s" worktree list --porcelain | grep -Fxq "worktree ${SIB_INTEG_WT[$s]}"; then
        die "sibling integration worktree already exists: ${SIB_INTEG_WT[$s]}" 'that run directory may belong to another coordinator; reconcile it before retrying'
      fi
      git -C "$s" show-ref --verify --quiet "refs/heads/$INTEG_BRANCH" \
        && die "sibling integration branch already exists in $s: $INTEG_BRANCH" 'that run directory may belong to another coordinator; reconcile it before retrying'
      mkdir -p "$(dirname "${SIB_INTEG_WT[$s]}")"
      git -C "$s" worktree add "${SIB_INTEG_WT[$s]}" -b "$INTEG_BRANCH" "${SIB_BRANCH[$s]}" >>"$LOG" 2>&1 \
        || die "failed to create sibling integration worktree for $s" "see $LOG"
      setup_worktree_assets "$s" "${SIB_INTEG_WT[$s]}"
    done
  fi
fi

# ---------------------------------------------------------------- state ----
declare -A PID2CHILD=() PID2BRANCH=() PID2WORKER=() PID2WT=() PID2ARTIFACT=() PID2OUTPUT_BYTES=() PID2RATE_LIMIT=() PID2COST=()
declare -A PID2STOP_REASON=()
declare -A ATTEMPTS=() REQUEUE_AT=() INFLIGHT=() PARKED=() PRECOMMENTS=() PERM_DENIALS=() CHILD_ORIENTATION=() EPIC_NOTES_LEN=()
declare -A PENDING_FOLDS=()
declare -A PRE_HEAD=() PRE_SIB_HEAD=() FIRST_SIG=() FIRST_HEAD=() FIRST_SIB_HEAD=() FIRST_UNTRACKED=() # sequential verification
declare -A LIVE_STARTED=() LIVE_LAST_PROGRESS=() LIVE_OUTPUT_SIZE=() LIVE_CPU=() LIVE_IO=() LIVE_TREE=()
declare -A LIVE_NEXT_INSPECT=() LIVE_NEXT_REPO_PROBE=() LIVE_GENERATION=() LIVE_CGROUP=()
declare -A LIVE_INSPECT_PID=() LIVE_INSPECT_BOOK_PID=() LIVE_INSPECT_STARTED=() LIVE_INSPECT_GENERATION=() LIVE_INSPECT_TICKS=() LIVE_INSPECT_PGID=()
declare -A LIVE_INSPECT_RESULT=() LIVE_INSPECT_RAW=() LIVE_INSPECT_RC=() LIVE_INSPECT_FORCED_RC=()
declare -A LIVE_INSPECT_PROCESS_FP=() LIVE_INSPECT_REPO_FP=()
declare -A LIVE_PENDING_STOP_PROCESS_FP=() LIVE_PENDING_STOP_REPO_FP=() LIVE_PENDING_STOP_GENERATION=()
declare -A LIVE_AGENT_PID=() LIVE_ROOT_TICKS=() LIVE_ROOT_PGID=() LIVE_LAST_DELTA=() LIVE_DEADLINE=()
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
FALLBACK_PENDING=0
FALLBACK_FROM=''
FALLBACK_TO=''
FALLBACK_REASON=''
FALLBACK_CHILD=''

trap 'STOPPING=1; say "signal received — draining"' TERM INT HUP

active_workers() { echo "${#PID2CHILD[@]}"; }

# ---------------------------------------------------------- supervision ----
# The coordinator owns liveness state. Sampling can request an inspection, but
# only a valid high-confidence inspector decision can stop a worker.
clock_now() {
  local now
  if [ -n "$CLOCK_CMD" ]; then
    now=$("$CLOCK_CMD" 2>>"$LOG") || now=''
    [[ "$now" =~ ^[0-9]+$ ]] || { say 'WARNING: clock adapter returned invalid output; using system clock'; now=$(date +%s); }
    printf '%s\n' "$now"
  else
    date +%s
  fi
}

bounded_delay() { # <requested> -> configured inspection delay
  local delay="$1"
  [[ "$delay" =~ ^[1-9][0-9]*$ ]] || delay="$IDLE_THRESHOLD"
  [ "$delay" -ge "$INSPECT_MIN_DELAY" ] || delay="$INSPECT_MIN_DELAY"
  [ "$delay" -le "$INSPECT_MAX_DELAY" ] || delay="$INSPECT_MAX_DELAY"
  printf '%s\n' "$delay"
}

worker_unit() { printf 'cook-epic-%s-%s.scope\n' "$SCOPE_ID" "$1"; }
inspector_unit() { printf 'cook-epic-%s-inspect-%s.scope\n' "$SCOPE_ID" "$1"; }
CLK_TCK=$(getconf CLK_TCK 2>/dev/null || printf 100)

scope_control_group() { # <unit>
  systemctl --user show --property=ControlGroup --value "$1" 2>/dev/null
}

cache_worker_cgroup() { # <worker>
  local worker="$1" attempts=0
  [ "$SCOPE_OK" -eq 1 ] || return 0
  while [ "$attempts" -lt 50 ]; do
    if worker_scope_active "$worker"; then
      scope_control_group "$(worker_unit "$worker")"
      return
    fi
    sleep 0.01
    attempts=$((attempts + 1))
  done
}

owned_group_valid() { # <leader pid> <start ticks> <owned pgid>
  local root="$1" ticks="$2" pgid="$3" stat rest current
  [[ "$root" =~ ^[1-9][0-9]*$ && "$pgid" =~ ^[1-9][0-9]*$ ]] || return 1
  [ "$root" = "$pgid" ] && [ -n "$ticks" ] || return 1
  current=$(process_start_ticks "$root")
  if [ -n "$current" ]; then
    [ "$ticks" = "$current" ] || return 1
    if stat=$(cat "/proc/$root/stat" 2>/dev/null); then
      rest=${stat##*') '}
      read -ra fields <<< "$rest"
      [ "${fields[2]:-0}" = "$pgid" ] && [ "${fields[3]:-0}" = "$pgid" ] || return 1
      [ "${fields[0]:-}" = Z ] || return 0
    fi
  fi
  # Descendants retain the owned PGID and SID after their session leader exits.
  # Linux does not reuse that numeric ID until the remaining group is empty.
  ps -eo pgid=,sid=,stat= 2>/dev/null \
    | awk -v pgid="$pgid" '$1 == pgid && $2 == pgid && $3 !~ /^Z/ {found=1} END {exit !found}'
}

process_group_ids() { # <pgid> -> every non-zombie member, without asserting ownership
  ps -eo pid=,pgid=,stat= 2>/dev/null | awk -v pgid="$1" '$2 == pgid && $3 !~ /^Z/ {print $1}'
}

owned_process_ids() { # <leader pid> <start ticks> <owned pgid>
  owned_group_valid "$1" "$2" "$3" || return 0
  process_group_ids "$3"
}

worker_process_ids() { # <worker> <bookkeeping pid>
  local worker="$1" root="$2" cgroup="${LIVE_CGROUP[$1]:-}"
  if [ "$SCOPE_OK" -eq 1 ] && [ -n "$cgroup" ] && [ -r "/sys/fs/cgroup$cgroup/cgroup.procs" ]; then
    sort -n -u "/sys/fs/cgroup$cgroup/cgroup.procs" 2>/dev/null
    return
  fi
  owned_process_ids "${LIVE_AGENT_PID[$root]:-$root}" "${LIVE_ROOT_TICKS[$root]:-}" "${LIVE_ROOT_PGID[$root]:-0}"
}

sample_worker_resources() { # <worker> <bookkeeping pid> -> "cpu-usec io-bytes"
  local worker="$1" root="$2" agent="${LIVE_AGENT_PID[$2]:-$2}" cgroup="${LIVE_CGROUP[$1]:-}" cpu io pid stat rest ticks=0 bytes=0
  if [ -n "$RESOURCE_SAMPLER_CMD" ]; then
    "$RESOURCE_SAMPLER_CMD" "$worker" "$agent" 2>>"$LOG"
    return
  fi
  if [ "$SCOPE_OK" -eq 1 ]; then
    if [ -n "$cgroup" ] && [ -r "/sys/fs/cgroup$cgroup/cpu.stat" ]; then
      cpu=$(awk '$1 == "usage_usec" {print $2}' "/sys/fs/cgroup$cgroup/cpu.stat" 2>/dev/null)
      io=0
      if [ -r "/sys/fs/cgroup$cgroup/io.stat" ]; then
        io=$(awk '{for(i=1;i<=NF;i++){if($i~/^rbytes=/||$i~/^wbytes=/){split($i,a,"="); n+=a[2]}}} END{print n+0}' "/sys/fs/cgroup$cgroup/io.stat" 2>/dev/null)
      fi
      printf '%s %s\n' "${cpu:-0}" "${io:-0}"
      return
    fi
  fi
  while read -r pid; do
    stat=$(cat "/proc/$pid/stat" 2>/dev/null) || continue
    rest=${stat##*') '}
    read -ra fields <<< "$rest"
    ticks=$((ticks + ${fields[11]:-0} + ${fields[12]:-0}))
    if [ -r "/proc/$pid/io" ]; then
      bytes=$((bytes + $(awk '$1 == "read_bytes:" || $1 == "write_bytes:" {n += $2} END {print n+0}' "/proc/$pid/io" 2>/dev/null)))
    fi
  done < <(worker_process_ids "$worker" "$root")
  printf '%s %s\n' "$((ticks * 1000000 / CLK_TCK))" "$bytes"
}

repository_status() { # <repo>
  timeout --kill-after=1 "$REPO_PROBE_TIMEOUT" env GIT_OPTIONAL_LOCKS=0 git -C "$1" status \
    --porcelain=v1 --untracked-files=no -- . ':(exclude).beads' 2>/dev/null
}

repository_snapshot() { # <repo> <label> <hot|inspection>
  local repo="$1" label="$2" form="$3" status_hash diff_hash head summary
  if [ "$form" = hot ]; then
    status_hash=$(repository_status "$repo" | cksum) || { printf '%s hash=probe-timeout\n' "$label"; return; }
    diff_hash=$(timeout --kill-after=1 "$REPO_PROBE_TIMEOUT" env GIT_OPTIONAL_LOCKS=0 git -C "$repo" diff \
      --no-ext-diff --no-textconv HEAD -- . ':(exclude).beads' 2>/dev/null | cksum) \
      || { printf '%s hash=probe-timeout\n' "$label"; return; }
    head=$(timeout --kill-after=1 "$REPO_PROBE_TIMEOUT" env GIT_OPTIONAL_LOCKS=0 git -C "$repo" rev-parse HEAD 2>/dev/null) \
      || { printf '%s hash=probe-timeout\n' "$label"; return; }
    printf '%s\n%s\n%s\n' "$head" "$status_hash" "$diff_hash" | cksum \
      | awk -v label="$label" '{print label " hash=" $1 ":" $2}'
    return
  fi
  summary=$(repository_status "$repo" | awk -v label="$label" '
    BEGIN {modified=0; added=0; deleted=0; renamed=0; conflicted=0}
    {
      code=substr($0,1,2)
      if (code ~ /U|AA|DD/) conflicted++
      else if (code ~ /R/) renamed++
      else if (code ~ /A/) added++
      else if (code ~ /D/) deleted++
      else modified++
    }
    END {
      printf "%s tracked_modified=%d added=%d deleted=%d renamed=%d conflicted=%d probe_timeout=false\n", label, modified, added, deleted, renamed, conflicted
    }') || summary="$label tracked_modified=0 added=0 deleted=0 renamed=0 conflicted=0 probe_timeout=true"
  printf '%s\n' "$summary"
}

repository_snapshots() { # <worker bookkeeping pid> <hot|inspection>
  local root="$1" form="$2" output s index=0 layout
  output=$(repository_snapshot "${PID2WT[$root]}" main "$form")
  if [ "$SEQUENTIAL" = 1 ]; then
    for s in "${SIBLINGS[@]}"; do
      index=$((index + 1))
      output+=$'\n'"$(repository_snapshot "$s" "sibling-$index" "$form")"
      [ "${#output}" -lt "$REPO_EVIDENCE_BYTES" ] || break
    done
  elif [ "$LAYOUT_MODE" -eq 1 ] && [ "${PID2WT[$root]}" != "$REPO" ]; then
    # Probe the worker's mirrored sibling worktrees, not the real checkouts.
    layout="${PID2WT[$root]%/*}"
    for s in "${SIBLINGS[@]}"; do
      index=$((index + 1))
      output+=$'\n'"$(repository_snapshot "$(sibling_layout_wt "$layout" "$s")" "sibling-$index" "$form")"
      [ "${#output}" -lt "$REPO_EVIDENCE_BYTES" ] || break
    done
  fi
  printf '%s\n' "${output:0:REPO_EVIDENCE_BYTES}"
}

worker_is_active() { # <worker> <bookkeeping pid>
  local worker="$1" pid="$2" agent="${LIVE_AGENT_PID[$2]:-$2}"
  if [ -n "$WORKER_ACTIVE_CMD" ]; then "$WORKER_ACTIVE_CMD" "$worker" "$agent"; return; fi
  worker_scope_active "$worker" && return 0
  owned_group_active "$agent" "${LIVE_ROOT_TICKS[$pid]:-}" "${LIVE_ROOT_PGID[$pid]:-0}"
}

process_summary() { # <worker> <bookkeeping pid>
  local pids total
  pids=$(worker_process_ids "$1" "$2" | paste -sd, -)
  [ -n "$pids" ] || { printf 'no_live_processes=true\n'; return; }
  total=$(tr ',' '\n' <<< "$pids" | wc -l)
  printf 'process_count=%s\n' "$total"
  ps -o comm= -p "$pids" 2>/dev/null | awk '
    BEGIN {
      split("bash sh dash zsh fish git node bun deno python python3 ruby rails go cargo rustc make cmake ninja java javac gradle chromium chrome playwright vite tsc eslint pytest rspec sleep", names)
      for (i in names) allowed[names[i]]=1
    }
    {name=allowed[$1] ? $1 : "other"; count[name]++}
    END {for (name in count) print "tool=" name " count=" count[name]}
  ' | sort | sed -n '1,40p'
}

worker_process_fingerprint() { # <worker> <bookkeeping pid>
  local worker="$1" root="$2" pids shape
  pids=$(worker_process_ids "$worker" "$root" | paste -sd, -)
  [ -n "$pids" ] || { printf 'unavailable\n'; return; }
  # Compare process shape, not exact PIDs. Agents routinely replace short-lived
  # helpers such as sleep while their meaningful state remains unchanged.
  shape=$(ps -o comm= -p "$pids" 2>/dev/null | awk '
    $1 == "sleep" || $1 == "timeout" {next}
    {count[$1]++}
    END {for (key in count) print key "=" count[key]}
  ' | sort)
  [ -n "$shape" ] || shape='transient-helpers-only'
  printf '%s\n' "$shape" | sha256sum | awk '{print $1}'
}

inspection_repo_fingerprint() { # <worker bookkeeping pid>
  repository_snapshots "$1" hot
}

render_inspector_prompt() { # <worker bookkeeping pid> <now> <prompt path>
  local root="$1" now="$2" prompt="$3" child worker elapsed idle processes repos output_bytes
  child="${PID2CHILD[$root]}"; worker="${PID2WORKER[$root]}"
  elapsed=$((now - ${LIVE_STARTED[$root]})); idle=$((now - ${LIVE_LAST_PROGRESS[$root]}))
  output_bytes=$(<"${PID2OUTPUT_BYTES[$root]}")
  [[ "$output_bytes" =~ ^[0-9]+$ ]] || output_bytes=0
  processes=$(process_summary "$worker" "$root")
  repos=$(repository_snapshots "$root" inspection)
  cp -f "$INSPECTOR_TEMPLATE" "$prompt"
  cat >> "$prompt" <<EOF

## Bounded allowlisted activity summary

Worker: $worker
Child: $child
Elapsed seconds: $elapsed
Idle seconds: $idle
Last sample deltas: ${LIVE_LAST_DELTA[$root]:-unavailable}
Worker output bytes: $output_bytes
Worker exit state: running

### Process tree and resources

$processes

### Bounded repository activity

$repos
EOF
  if [ "$(stat -c %s "$prompt" 2>/dev/null || printf 0)" -gt $((REPO_EVIDENCE_BYTES + 8192)) ]; then
    truncate -s $((REPO_EVIDENCE_BYTES + 8192)) "$prompt"
  fi
  chmod 600 "$prompt"
}

capture_inspector() { # <result> <raw> <command...>
  local result="$1" raw="$2" result_fifo="$1.pipe" raw_fifo="$2.pipe" result_sink raw_sink rc=0
  shift 2
  rm -f "$result_fifo" "$raw_fifo"; mkfifo "$result_fifo" "$raw_fifo"
  bounded_stream "$result" "$INSPECTOR_RESULT_BYTES" '' '' '' "$result.overflow" < "$result_fifo" & result_sink=$!
  bounded_stream "$raw" "$INSPECTOR_LOG_BYTES" < "$raw_fifo" & raw_sink=$!
  "$@" > "$result_fifo" 2> "$raw_fifo" || rc=$?
  wait "$result_sink" 2>/dev/null || true
  wait "$raw_sink" 2>/dev/null || true
  rm -f "$result_fifo" "$raw_fifo"
  return "$rc"
}

capture_inspector_raw() { # <raw> <command...>
  local raw="$1" fifo="$1.pipe" sink rc=0
  shift
  rm -f "$fifo"; mkfifo "$fifo"
  bounded_stream "$raw" "$INSPECTOR_LOG_BYTES" < "$fifo" & sink=$!
  "$@" > "$fifo" 2>&1 || rc=$?
  wait "$sink" 2>/dev/null || true
  rm -f "$fifo"
  return "$rc"
}

run_inspector_harness() { # <worker> <prompt> <result> <raw> <identity file>
  local worker="$1" prompt="$2" result="$3" raw="$4" identity="$5" rc=0 config sink fifo
  export FLEET_UNIT="cook-epic-$SCOPE_ID-inspect-$worker" COOKEPIC_INSPECTOR=1 COOKEPIC_RUN_DIR="$RUN_DIR"
  if [ -n "$INSPECTOR_CMD" ]; then
    fifo="$result.pipe"
    rm -f "$fifo"; mkfifo "$fifo"
    bounded_stream "$result" "$INSPECTOR_RESULT_BYTES" '' '' '' "$result.overflow" < "$fifo" & sink=$!
    capture_inspector_raw "$raw" inspector_exec "$identity" "$INSPECTOR_CMD" "$prompt" "$fifo" || rc=$?
    if [ "$rc" -eq 0 ]; then wait "$sink" 2>/dev/null || true
    else kill "$sink" 2>/dev/null || true; fi
    wait "$sink" 2>/dev/null || true
    rm -f "$fifo"
    return "$rc"
  fi
  case "$HARNESS" in
    claude|ccx)
      capture_inspector "$result" "$raw" inspector_exec "$identity" \
        "$AGENT_BIN" -p --safe-mode --disable-slash-commands --tools '' --permission-mode plan \
        --no-session-persistence --output-format text --model "${ACTIVE_MODEL:-sonnet}" -- "$(<"$prompt")"
      ;;
    kimi)
      local -a kimi_args=(-p "$(<"$prompt")" --agent-file "$SKILL_DIR/inspector-agent.md" --output-format text)
      [ -n "$ACTIVE_MODEL" ] && kimi_args+=(-m "$ACTIVE_MODEL")
      capture_inspector "$result" "$raw" inspector_exec "$identity" "$AGENT_BIN" "${kimi_args[@]}"
      ;;
    codex) return 126 ;; # launch_inspector handles Codex without starting a process
    opencode)
      config='{"permission":"deny","snapshot":false,"share":"disabled","instructions":[],"subagent_depth":0,"agent":{"cook-epic-inspector":{"description":"Decide worker liveness from supplied evidence","mode":"primary","steps":1,"permission":"deny"}}}'
      OPENCODE_CONFIG_CONTENT="$config" capture_inspector "$raw" "$raw.stderr" inspector_exec "$identity" \
        "$AGENT_BIN" run --pure --agent cook-epic-inspector --format json --dir "$RUN_DIR" -- "$(<"$prompt")" || rc=$?
      [ "$rc" -eq 0 ] || return "$rc"
      [ ! -e "$raw.overflow" ] || return 65
      jq -rs '[.[] | .part.text? // .text? // empty] | join("")' "$raw" 2>>"$LOG" \
        | bounded_stream "$result" "$INSPECTOR_RESULT_BYTES" '' '' '' "$result.overflow"
      ;;
    worker-cmd) return 127 ;;
  esac
}

launch_inspector() { # <worker bookkeeping pid> <now>
  local root="$1" now="$2" child worker prompt result raw rcfile identity book_pid idle elapsed
  child="${PID2CHILD[$root]}"; worker="${PID2WORKER[$root]}"
  prompt="$RUN_DIR/inspector-$worker.prompt.md"; result="$RUN_DIR/inspector-$worker.result.json"
  raw="$RUN_DIR/inspector-$worker.raw.log"; rcfile="$RUN_DIR/inspector-$worker.rc"; identity="$RUN_DIR/inspector-$worker.owned"
  idle=$((now - ${LIVE_LAST_PROGRESS[$root]})); elapsed=$((now - ${LIVE_STARTED[$root]}))
  mbox --arg child "$child" --arg worker "$worker" --argjson idle "$idle" --argjson elapsed "$elapsed" --arg ts "$(date +%H:%M:%S)" \
    '{event:"worker-idle",child:$child,worker:$worker,idleSeconds:$idle,elapsedSeconds:$elapsed,ts:$ts}'
  if [ "$HARNESS" = codex ] && [ -z "$INSPECTOR_CMD" ]; then
    inspection_uncertain "$root" 'Codex inspection is disabled because Codex cannot enforce the no-tool contract' "$now"
    return 0
  fi
  LIVE_INSPECT_PROCESS_FP[$root]=$(worker_process_fingerprint "$worker" "$root")
  LIVE_INSPECT_REPO_FP[$root]=$(inspection_repo_fingerprint "$root")
  render_inspector_prompt "$root" "$now" "$prompt"
  : > "$result"; : > "$raw"; rm -f "$rcfile" "$identity" "$result.overflow" "$raw.overflow" "$raw.stderr.overflow"
  chmod 600 "$result" "$raw"
  say "$child on $worker has no progress for ${idle}s; starting read-only inspection"
  (
    cd "$RUN_DIR" || exit 98
    run_inspector_harness "$worker" "$prompt" "$result" "$raw" "$identity"
    rc=$?
    printf '%s\n' "$rc" > "$rcfile"
    exit "$rc"
  ) &
  book_pid=$!
  LIVE_INSPECT_BOOK_PID[$root]="$book_pid"; LIVE_INSPECT_STARTED[$root]="$now"
  LIVE_INSPECT_GENERATION[$root]="${LIVE_GENERATION[$root]}"
  if [ "$SCOPE_OK" -eq 1 ]; then
    LIVE_INSPECT_PID[$root]="$book_pid"
    LIVE_INSPECT_TICKS[$root]=$(process_start_ticks "$book_pid")
    LIVE_INSPECT_PGID[$root]=0
  elif owned_identity_load "$identity" "$book_pid"; then
    LIVE_INSPECT_PID[$root]="$OWNED_PID"
    LIVE_INSPECT_TICKS[$root]="$OWNED_TICKS"
    LIVE_INSPECT_PGID[$root]="$OWNED_PGID"
  else
    LIVE_INSPECT_PID[$root]=0; LIVE_INSPECT_TICKS[$root]=''; LIVE_INSPECT_PGID[$root]=0
  fi
  LIVE_INSPECT_RESULT[$root]="$result"; LIVE_INSPECT_RAW[$root]="$raw"; LIVE_INSPECT_RC[$root]="$rcfile"
  mbox --arg child "$child" --arg worker "$worker" --argjson timeout "$INSPECTOR_TIMEOUT" --arg ts "$(date +%H:%M:%S)" \
    '{event:"inspection-started",child:$child,worker:$worker,timeoutSeconds:$timeout,ts:$ts}'
}

valid_inspector_decision() { # <result path>
  [ ! -e "$1.overflow" ] || return 1
  [ "$(stat -c %s "$1" 2>/dev/null || printf 0)" -le "$INSPECTOR_RESULT_BYTES" ] || return 1
  jq -cse '
    select(length == 1) | .[0]
    | select(type == "object")
    | select(((keys_unsorted - ["decision","confidence","rationale","next_check_seconds"]) | length) == 0)
    | select(has("decision") and has("confidence") and has("rationale"))
    | select((.decision == "continue") or (.decision == "stop") or (.decision == "uncertain"))
    | select((.confidence == "high") or (.confidence == "medium") or (.confidence == "low"))
    | select((.rationale | type) == "string" and (.rationale | test("[^[:space:]]")) and (.rationale | length) <= 240)
    | select((has("next_check_seconds") | not) or ((.next_check_seconds | type) == "number" and (.next_check_seconds | floor) == .next_check_seconds and .next_check_seconds > 0))
    | select((.decision != "stop") or (has("next_check_seconds") | not))
  ' "$1" 2>/dev/null
}

owned_group_active() { # <leader pid> <start ticks> <pgid>
  [ -n "$(owned_process_ids "$1" "$2" "$3")" ]
}

owned_process_identities() { # <leader pid> <start ticks> <pgid> -> pid start-ticks
  local pid ticks
  while read -r pid; do
    ticks=$(run_lock_start_ticks "$pid")
    [ -n "$ticks" ] && printf '%s %s\n' "$pid" "$ticks"
  done < <(owned_process_ids "$1" "$2" "$3")
}

process_identity_active() { # <pid> <start ticks>
  local stat rest
  [ -n "$2" ] && [ "$2" = "$(run_lock_start_ticks "$1")" ] || return 1
  stat=$(cat "/proc/$1/stat" 2>/dev/null) || return 1
  rest=${stat##*') '}
  read -ra fields <<< "$rest"
  [ "${fields[0]:-}" != Z ]
}

wait_owned_identities() { # <newline-separated pid/start-ticks snapshot>
  local identities="$1" pid ticks active
  while true; do
    active=0
    while read -r pid ticks; do
      [ -n "$pid" ] || continue
      process_identity_active "$pid" "$ticks" && active=1
    done <<< "$identities"
    [ "$active" -eq 1 ] || return 0
    sleep 0.05
  done
}

owned_identities_active() { # <newline-separated pid/start-ticks snapshot>
  local identities="$1" pid ticks
  while read -r pid ticks; do
    [ -n "$pid" ] || continue
    process_identity_active "$pid" "$ticks" && return 0
  done <<< "$identities"
  return 1
}

signal_owned_group() { # <signal> <leader pid> <start ticks> <pgid>
  local signal="$1" root="$2" ticks="$3" pgid="$4"
  owned_group_valid "$root" "$ticks" "$pgid" || return 1
  kill "-$signal" -- "-$pgid" 2>/dev/null || true
}

stop_owned_group() { # <leader pid> <start ticks> <pgid>
  local root="$1" ticks="$2" pgid="$3" deadline identities
  owned_group_active "$root" "$ticks" "$pgid" || return 0
  deadline=$(( $(date +%s) + STOP_GRACE ))
  # Repeat TERM against a freshly validated group. A TERM handler can create a
  # child after the first group signal, and that child still owns the checkout.
  while owned_group_active "$root" "$ticks" "$pgid" && [ "$(date +%s)" -lt "$deadline" ]; do
    signal_owned_group TERM "$root" "$ticks" "$pgid" || return 0
    sleep 0.1
  done
  owned_group_active "$root" "$ticks" "$pgid" || return 0
  identities=$(owned_process_identities "$root" "$ticks" "$pgid")
  signal_owned_group KILL "$root" "$ticks" "$pgid" || return 0
  wait_owned_identities "$identities"
  # SIGKILL cannot run a handler, so no member can fork after the final signal.
  # Wait for every non-zombie member, including one created just before KILL.
  while [ -n "$(process_group_ids "$pgid")" ]; do sleep 0.05; done
}

stop_worker_action() { # <worker> <bookkeeping pid>
  local worker="$1" pid="$2" agent="${LIVE_AGENT_PID[$2]:-$2}" unit deadline
  if [ -n "$WORKER_STOP_CMD" ]; then "$WORKER_STOP_CMD" "$worker" "$agent" "$STOP_GRACE" >>"$LOG" 2>&1 || true; return; fi
  unit=$(worker_unit "$worker")
  if worker_scope_active "$worker"; then
    systemctl --user kill --kill-who=all --signal=TERM "$unit" >>"$LOG" 2>&1 || true
    deadline=$(( $(date +%s) + STOP_GRACE ))
    while worker_scope_active "$worker" && [ "$(date +%s)" -lt "$deadline" ]; do sleep 1; done
    if worker_scope_active "$worker"; then
      systemctl --user kill --kill-who=all --signal=KILL "$unit" >>"$LOG" 2>&1 || true
    fi
    systemctl --user stop "$unit" >>"$LOG" 2>&1 || true
  else
    stop_owned_group "$agent" "${LIVE_ROOT_TICKS[$pid]:-}" "${LIVE_ROOT_PGID[$pid]:-0}"
  fi
}

inspector_scope_active() { # <worker root pid>
  [ "$SCOPE_OK" -eq 1 ] || return 1
  systemctl --user is-active --quiet "$(inspector_unit "${PID2WORKER[$1]}")" 2>/dev/null
}

inspector_is_active() { # <worker root pid>
  inspector_scope_active "$1" && return 0
  owned_group_active "${LIVE_INSPECT_PID[$1]:-0}" "${LIVE_INSPECT_TICKS[$1]:-}" "${LIVE_INSPECT_PGID[$1]:-0}"
}

stop_inspector_action() { # <worker root pid>
  local root="$1" pid="${LIVE_INSPECT_PID[$1]}" book_pid="${LIVE_INSPECT_BOOK_PID[$1]}" unit deadline
  unit=$(inspector_unit "${PID2WORKER[$root]}")
  if inspector_scope_active "$root"; then
    systemctl --user kill --kill-who=all --signal=TERM "$unit" >>"$LOG" 2>&1 || true
    deadline=$(( $(date +%s) + STOP_GRACE ))
    while inspector_scope_active "$root" && [ "$(date +%s)" -lt "$deadline" ]; do sleep 0.1; done
    inspector_scope_active "$root" && systemctl --user kill --kill-who=all --signal=KILL "$unit" >>"$LOG" 2>&1 || true
    systemctl --user stop "$unit" >>"$LOG" 2>&1 || true
  else
    stop_owned_group "$pid" "${LIVE_INSPECT_TICKS[$root]:-}" "${LIVE_INSPECT_PGID[$root]:-0}"
  fi
  wait "$book_pid" 2>/dev/null || true
}

clear_inspector_record() { # <worker root pid>
  local root="$1"
  unset "LIVE_INSPECT_PID[$root]" "LIVE_INSPECT_BOOK_PID[$root]" "LIVE_INSPECT_STARTED[$root]" "LIVE_INSPECT_GENERATION[$root]"
  unset "LIVE_INSPECT_TICKS[$root]" "LIVE_INSPECT_PGID[$root]" "LIVE_INSPECT_FORCED_RC[$root]"
  unset "LIVE_INSPECT_RESULT[$root]" "LIVE_INSPECT_RAW[$root]" "LIVE_INSPECT_RC[$root]"
  unset "LIVE_INSPECT_PROCESS_FP[$root]" "LIVE_INSPECT_REPO_FP[$root]"
}

clear_pending_stop() { # <worker root pid>
  unset "LIVE_PENDING_STOP_PROCESS_FP[$1]" "LIVE_PENDING_STOP_REPO_FP[$1]" "LIVE_PENDING_STOP_GENERATION[$1]"
}

stop_run_inspectors() {
  local root
  for root in "${!LIVE_INSPECT_PID[@]}"; do
    inspector_is_active "$root" || { wait "${LIVE_INSPECT_BOOK_PID[$root]}" 2>/dev/null || true; clear_inspector_record "$root"; continue; }
    say "stopping active inspector for ${PID2CHILD[$root]:-unknown}"
    stop_inspector_action "$root"
    clear_inspector_record "$root"
  done
}

stop_run_workers() {
  local root
  for root in "${!PID2CHILD[@]}"; do
    if worker_is_active "${PID2WORKER[$root]}" "$root"; then
      say "stopping active worker ${PID2WORKER[$root]} for ${PID2CHILD[$root]}"
      stop_worker_action "${PID2WORKER[$root]}" "$root"
    fi
    wait "$root" 2>/dev/null || true
  done
}

trap 'stop_run_inspectors; stop_run_workers; run_lock_release' EXIT

inspection_uncertain() { # <worker root pid> <reason> <now>
  local root="$1" reason="$2" now="$3" child worker delay
  child="${PID2CHILD[$root]}"; worker="${PID2WORKER[$root]}"
  clear_pending_stop "$root"
  delay=$(bounded_delay "$INSPECT_RETRY_DELAY")
  LIVE_NEXT_INSPECT[$root]=$((now + delay))
  mbox --arg child "$child" --arg worker "$worker" --arg reason "$reason" --argjson delay "$delay" --arg ts "$(date +%H:%M:%S)" \
    '{event:"inspection-uncertain",child:$child,worker:$worker,reason:$reason,nextCheckSeconds:$delay,ts:$ts}'
  say "inspection for $child on $worker was uncertain: $reason; keeping worker alive and checking again in ${delay}s"
}

reap_inspector() { # <worker bookkeeping pid> <now>
  local root="$1" now="$2" inspector_pid rc=0 decision_json decision confidence rationale requested delay child worker result generation
  local process_fp repo_fp current_process_fp current_repo_fp pending_matches=0
  inspector_pid="${LIVE_INSPECT_BOOK_PID[$root]}"
  inspector_is_active "$root" && return 1
  wait "$inspector_pid" 2>/dev/null || rc=$?
  [ -f "${LIVE_INSPECT_RC[$root]}" ] && rc=$(<"${LIVE_INSPECT_RC[$root]}")
  [ -z "${LIVE_INSPECT_FORCED_RC[$root]:-}" ] || rc="${LIVE_INSPECT_FORCED_RC[$root]}"
  child="${PID2CHILD[$root]}"; worker="${PID2WORKER[$root]}"
  result="${LIVE_INSPECT_RESULT[$root]}"; generation="${LIVE_INSPECT_GENERATION[$root]}"
  process_fp="${LIVE_INSPECT_PROCESS_FP[$root]}"; repo_fp="${LIVE_INSPECT_REPO_FP[$root]}"
  clear_inspector_record "$root"
  if [ "$rc" -ne 0 ]; then
    if [ "$rc" -eq 124 ]; then inspection_uncertain "$root" "inspector timed out after ${INSPECTOR_TIMEOUT}s" "$now"
    else inspection_uncertain "$root" "inspector failed with rc=$rc" "$now"; fi
    return 0
  fi
  decision_json=$(valid_inspector_decision "$result") || {
    inspection_uncertain "$root" 'inspector returned malformed output' "$now"
    return 0
  }
  decision=$(jq -r .decision <<< "$decision_json")
  confidence=$(jq -r .confidence <<< "$decision_json")
  rationale=$(jq -r .rationale <<< "$decision_json" | tr '\n' ' ')
  requested=$(jq -r '.next_check_seconds // empty' <<< "$decision_json")
  case "$decision:$confidence" in
    stop:high)
      if [ "${LIVE_GENERATION[$root]}" -ne "$generation" ]; then
        inspection_uncertain "$root" 'worker made progress while inspection was running; stale stop ignored' "$now"
        return 0
      fi
      current_process_fp=$(worker_process_fingerprint "$worker" "$root")
      current_repo_fp=$(inspection_repo_fingerprint "$root")
      if [ "$process_fp" = unavailable ] || [[ "$repo_fp" == *probe-timeout* ]] \
         || [ "$current_process_fp" != "$process_fp" ] || [ "$current_repo_fp" != "$repo_fp" ]; then
        inspection_uncertain "$root" 'worker fingerprint changed during inspection; stop confirmation cleared' "$now"
        return 0
      fi
      if [ -n "${LIVE_PENDING_STOP_PROCESS_FP[$root]:-}" ] \
         && [ "${LIVE_PENDING_STOP_PROCESS_FP[$root]}" = "$process_fp" ] \
         && [ "${LIVE_PENDING_STOP_REPO_FP[$root]}" = "$repo_fp" ] \
         && [ "${LIVE_PENDING_STOP_GENERATION[$root]}" = "$generation" ]; then
        pending_matches=1
      fi
      if [ "$pending_matches" -ne 1 ]; then
        LIVE_PENDING_STOP_PROCESS_FP[$root]="$process_fp"
        LIVE_PENDING_STOP_REPO_FP[$root]="$repo_fp"
        LIVE_PENDING_STOP_GENERATION[$root]="$generation"
        delay=$(bounded_delay "$INSPECT_MIN_DELAY")
        LIVE_NEXT_INSPECT[$root]=$((now + delay))
        mbox --arg child "$child" --arg worker "$worker" --arg rationale "$rationale" --argjson delay "$delay" --arg ts "$(date +%H:%M:%S)" \
          '{event:"inspection-stop-pending",child:$child,worker:$worker,rationale:$rationale,nextCheckSeconds:$delay,ts:$ts}'
        say "inspector requested stop confirmation for $child on $worker: $rationale; checking a fresh snapshot in ${delay}s"
        return 0
      fi
      clear_pending_stop "$root"
      PID2STOP_REASON[$root]="inspector requested stop: $rationale"
      mbox --arg child "$child" --arg worker "$worker" --arg rationale "$rationale" --arg ts "$(date +%H:%M:%S)" \
        '{event:"inspection-stop",child:$child,worker:$worker,rationale:$rationale,ts:$ts}'
      say "inspector requested stop for $child on $worker: $rationale"
      stop_worker_action "$worker" "$root"
      ;;
    continue:*)
      clear_pending_stop "$root"
      delay=$(bounded_delay "${requested:-$IDLE_THRESHOLD}")
      LIVE_NEXT_INSPECT[$root]=$((now + delay))
      mbox --arg child "$child" --arg worker "$worker" --arg rationale "$rationale" --argjson delay "$delay" --arg ts "$(date +%H:%M:%S)" \
        '{event:"inspection-continue",child:$child,worker:$worker,rationale:$rationale,nextCheckSeconds:$delay,ts:$ts}'
      say "inspector continued $child on $worker: $rationale; next check in ${delay}s"
      ;;
    *) inspection_uncertain "$root" "decision=$decision confidence=$confidence: $rationale" "$now" ;;
  esac
  return 0
}

liveness_start() { # <worker bookkeeping pid>
  local root="$1" now cpu io size worker cgroup=''
  now=$(clock_now); worker="${PID2WORKER[$root]}"
  if [ "$SCOPE_OK" -eq 1 ]; then
    LIVE_AGENT_PID[$root]="$root"
    LIVE_ROOT_TICKS[$root]=$(process_start_ticks "$root")
  fi
  cgroup=$(cache_worker_cgroup "$worker")
  LIVE_CGROUP[$worker]="$cgroup"
  read -r cpu io <<< "$(sample_worker_resources "$worker" "$root")"
  [[ "$cpu" =~ ^[0-9]+$ ]] || cpu=0; [[ "$io" =~ ^[0-9]+$ ]] || io=0
  size=$(<"${PID2OUTPUT_BYTES[$root]}")
  [[ "$size" =~ ^[0-9]+$ ]] || size=0
  LIVE_STARTED[$root]="$now"; LIVE_LAST_PROGRESS[$root]="$now"; LIVE_NEXT_INSPECT[$root]=$((now + IDLE_THRESHOLD))
  LIVE_NEXT_REPO_PROBE[$root]=$((now + REPO_PROBE_INTERVAL)); LIVE_GENERATION[$root]=0
  LIVE_OUTPUT_SIZE[$root]="$size"; LIVE_CPU[$root]="$cpu"; LIVE_IO[$root]="$io"; LIVE_TREE[$root]=''
  [ -z "$WORKER_TIMEOUT" ] || LIVE_DEADLINE[$root]=$((now + WORKER_TIMEOUT))
  LIVE_LAST_DELTA[$root]='initial sample'
}

cleanup_worker_liveness() { # <worker bookkeeping pid>
  local root="$1" worker="${PID2WORKER[$1]}"
  if [ -n "${LIVE_INSPECT_PID[$root]:-}" ]; then
    inspector_is_active "$root" && stop_inspector_action "$root"
    wait "${LIVE_INSPECT_BOOK_PID[$root]}" 2>/dev/null || true
    clear_inspector_record "$root"
  fi
  unset "LIVE_STARTED[$root]" "LIVE_LAST_PROGRESS[$root]" "LIVE_OUTPUT_SIZE[$root]" "LIVE_CPU[$root]" "LIVE_IO[$root]" "LIVE_TREE[$root]"
  unset "LIVE_NEXT_INSPECT[$root]" "LIVE_NEXT_REPO_PROBE[$root]" "LIVE_GENERATION[$root]" "LIVE_CGROUP[$worker]"
  unset "LIVE_AGENT_PID[$root]" "LIVE_ROOT_TICKS[$root]" "LIVE_ROOT_PGID[$root]" "LIVE_LAST_DELTA[$root]" "LIVE_DEADLINE[$root]"
  clear_pending_stop "$root"
}

supervise_workers() {
  local root now worker size cpu io tree output_delta cpu_delta io_delta progress idle tree_changed=false
  now=$(clock_now)
  for root in "${!PID2CHILD[@]}"; do
    worker="${PID2WORKER[$root]}"
    if ! worker_is_active "$worker" "$root"; then
      [ -z "${LIVE_INSPECT_PID[$root]:-}" ] || cleanup_worker_liveness "$root"
      continue
    fi
    if [ -n "${LIVE_DEADLINE[$root]:-}" ] && [ "$now" -ge "${LIVE_DEADLINE[$root]}" ]; then
      PID2STOP_REASON[$root]="timed out after ${WORKER_TIMEOUT}s"
      say "${PID2CHILD[$root]} on $worker reached its absolute ${WORKER_TIMEOUT}s timeout"
      stop_worker_action "$worker" "$root"
      continue
    fi
    size=$(<"${PID2OUTPUT_BYTES[$root]}")
    [[ "$size" =~ ^[0-9]+$ ]] || size="${LIVE_OUTPUT_SIZE[$root]}"
    read -r cpu io <<< "$(sample_worker_resources "$worker" "$root")"
    [[ "$cpu" =~ ^[0-9]+$ ]] || cpu="${LIVE_CPU[$root]}"; [[ "$io" =~ ^[0-9]+$ ]] || io="${LIVE_IO[$root]}"
    output_delta=$((size - ${LIVE_OUTPUT_SIZE[$root]})); cpu_delta=$((cpu - ${LIVE_CPU[$root]})); io_delta=$((io - ${LIVE_IO[$root]}))
    progress=0
    [ "$output_delta" -gt 0 ] && progress=1
    [ "$cpu_delta" -ge "$CPU_PROGRESS_USEC" ] && progress=1
    [ "$io_delta" -ge "$IO_PROGRESS_BYTES" ] && progress=1
    tree_changed=false
    if [ "$progress" -eq 0 ] && [ "$now" -ge "${LIVE_NEXT_REPO_PROBE[$root]}" ]; then
      tree=$(repository_snapshots "$root" hot)
      if [ -n "${LIVE_TREE[$root]}" ] && [ "$tree" != "${LIVE_TREE[$root]}" ]; then progress=1; tree_changed=true; fi
      LIVE_TREE[$root]="$tree"; LIVE_NEXT_REPO_PROBE[$root]=$((now + REPO_PROBE_INTERVAL))
    fi
    LIVE_LAST_DELTA[$root]="output_bytes=$output_delta cpu_usec=$cpu_delta io_bytes=$io_delta repo_changed=$tree_changed"
    LIVE_OUTPUT_SIZE[$root]="$size"; LIVE_CPU[$root]="$cpu"; LIVE_IO[$root]="$io"
    if [ "$progress" -eq 1 ]; then
      clear_pending_stop "$root"
      LIVE_LAST_PROGRESS[$root]="$now"
      LIVE_NEXT_INSPECT[$root]=$((now + IDLE_THRESHOLD))
      LIVE_GENERATION[$root]=$(( ${LIVE_GENERATION[$root]} + 1 ))
    fi
    if [ -n "${LIVE_INSPECT_PID[$root]:-}" ]; then
      if inspector_is_active "$root" && [ $((now - ${LIVE_INSPECT_STARTED[$root]})) -ge "$INSPECTOR_TIMEOUT" ]; then
        LIVE_INSPECT_FORCED_RC[$root]=124
        stop_inspector_action "$root"
      fi
      reap_inspector "$root" "$now" || true
      continue
    fi
    idle=$((now - ${LIVE_LAST_PROGRESS[$root]}))
    if [ "$FALLBACK_PENDING" -eq 0 ] && [ "$idle" -ge "$IDLE_THRESHOLD" ] && [ "$now" -ge "${LIVE_NEXT_INSPECT[$root]}" ]; then
      launch_inspector "$root" "$now"
    fi
  done
}

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

request_provider_fallback() { # <child> <reason> -> 0 when a later harness is available
  local child="$1" reason="$2" target
  if [ "$FALLBACK_PENDING" -eq 1 ]; then
    return 0
  fi
  target=$(next_installed_harness "$HARNESS") || return 1
  FALLBACK_PENDING=1
  FALLBACK_FROM="$HARNESS"
  FALLBACK_TO="$target"
  FALLBACK_REASON="$reason"
  FALLBACK_CHILD="$child"
  stop_run_inspectors
  say "provider fallback pending: $FALLBACK_FROM -> $FALLBACK_TO; draining active workers"
}

apply_provider_fallback() {
  [ "$FALLBACK_PENDING" -eq 1 ] || return 0
  [ "$(active_workers)" -eq 0 ] || return 0
  stop_run_inspectors
  configure_harness "$FALLBACK_TO" 0
  refresh_model_tier_rule
  mbox --arg from "$FALLBACK_FROM" --arg to "$FALLBACK_TO" --arg child "$FALLBACK_CHILD" \
    --arg reason "$FALLBACK_REASON" --arg model "$ACTIVE_MODEL" --arg ts "$(date +%H:%M:%S)" \
    '{event:"provider-fallback",from:$from,to:$to,child:$child,reason:$reason,model:$model,ts:$ts}'
  say "provider fallback: $FALLBACK_FROM -> $FALLBACK_TO model=$ACTIVE_MODEL"
  if [ -n "$BUDGET" ] && [ "$COST_SUPPORTED" -eq 0 ]; then
    say "WARNING: budget not enforceable on $HARNESS after provider fallback"
  fi
  FALLBACK_PENDING=0
  FALLBACK_FROM=''
  FALLBACK_TO=''
  FALLBACK_REASON=''
  FALLBACK_CHILD=''
  retry_pending_folds
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
      -e "s|@MODEL_TIERS@|$MODEL_TIER_RULE|g" \
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

# render_prompt's sed pass is single-line-only (it substitutes with `s|@X@|...|g`,
# which breaks on multi-line values and literal `|` characters). Multi-line
# blocks (epic description, orientation card) splice in as a second pass: a
# line that is EXACTLY the marker gets replaced by the content file's lines
# verbatim, with no regex/pipe interpretation of that content.
splice_marker() { # <file> <marker> <content-file>
  awk -v marker="$2" -v contentfile="$3" '
    $0 == marker {
      while ((getline line < contentfile) > 0) print line
      close(contentfile)
      next
    }
    { print }
  ' "$1" > "$1.splice" && mv "$1.splice" "$1"
}

is_research_child() { # <child> <title> -> 0 when findings-in-beads is the deliverable
  [[ "$2" =~ ^Research: ]] && return 0
  bd label list "$1" 2>/dev/null | grep -qiE '^[[:space:]]*-[[:space:]]*research$'
}

comment_count_of() { # <child> -> prints the bead's comment count (0 on any failure)
  bd show "$1" --json 2>/dev/null \
    | jq -r 'if type=="array" then .[0] else . end | .comment_count // 0' 2>/dev/null || echo 0
}

epic_notes() { # -> prints the epic's current notes text verbatim (empty on any failure)
  bd show "$EPIC" --json 2>/dev/null \
    | jq -r 'if type=="array" then .[0] else . end | .notes // ""' 2>/dev/null
}

epic_notes_length() { # -> prints the char length of the epic's current notes text
  local notes
  notes="$(epic_notes)"
  printf '%s\n' "${#notes}"
}

spawn_worker() { # <child> <title>
  local child="$1" title="$2"
  WORKER_NUM=$((WORKER_NUM + 1))
  local worker="w$WORKER_NUM" branch wt offset prompt artifact bytes rate cost identity pid
  local s swt layout=''
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
    if [ "$LAYOUT_MODE" -eq 1 ]; then
      layout="$LAYOUT_ROOT/$child"
      wt="$layout/$REPO_BASENAME"
    else
      wt="$WORKTREE_ROOT/$child"
    fi
    if [ -e "${layout:-$wt}" ] || git worktree list --porcelain | grep -Fxq "worktree $wt"; then
      say "refusing existing worker worktree for $child: $wt"
      return 1
    fi
    [ -z "$layout" ] || mkdir -p "$layout"
    if git show-ref --verify --quiet "refs/heads/$branch"; then
      git worktree add "$wt" "$branch" >>"$LOG" 2>&1
    else
      git worktree add "$wt" -b "$branch" "$BASE_BRANCH" >>"$LOG" 2>&1
    fi || { say "worktree creation failed for $child"; return 1; }
    setup_worktree "$wt"
    if [ "$LAYOUT_MODE" -eq 1 ]; then
      # Mirror every sibling beside the main worktree, on the same branch name
      # (created from the sibling's current branch; reused on retry).
      for s in "${SIBLINGS[@]}"; do
        swt=$(sibling_layout_wt "$layout" "$s")
        if [ -e "$swt" ] || git -C "$s" worktree list --porcelain | grep -Fxq "worktree $swt"; then
          say "refusing existing sibling worktree for $child: $swt"
          cleanup_worktree "$wt"
          return 1
        fi
        mkdir -p "$(dirname "$swt")"
        if git -C "$s" show-ref --verify --quiet "refs/heads/$branch"; then
          git -C "$s" worktree add "$swt" "$branch" >>"$LOG" 2>&1
        else
          git -C "$s" worktree add "$swt" -b "$branch" "${SIB_BRANCH[$s]}" >>"$LOG" 2>&1
        fi || { say "sibling worktree creation failed for $child in $s"; cleanup_worktree "$wt"; return 1; }
        setup_worktree_assets "$s" "$swt"
      done
    fi
  fi

  if ! claim_child "$child" "$worker"; then
    say "claim lost for $child — skipping this round"
    cleanup_worktree "$wt"
    return 1
  fi

  PRECOMMENTS[$child]=$(comment_count_of "$child")
  EPIC_NOTES_LEN[$child]=$(epic_notes_length)

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

  # Per-worker sibling rule: layout paths differ per child, so the injected
  # text is built here. `local SIBLING_RULE="$SIBLING_RULE"` shadows the global
  # with a copy; render_prompt sees the shadow through dynamic scoping.
  local SIBLING_RULE="$SIBLING_RULE"
  if [ "$LAYOUT_MODE" -eq 1 ] && [ -n "$layout" ]; then
    local sib_paths='' real_paths=''
    for s in "${SIBLINGS[@]}"; do
      sib_paths="${sib_paths:+$sib_paths, }\`$(sibling_layout_wt "$layout" "$s")\` (mirror of \`${SIB_REL[$s]}\`)"
      real_paths="${real_paths:+$real_paths, }\`$s\`"
    done
    SIBLING_RULE="This child may span sibling repositories. Your sandbox is the whole layout \`$layout\`: it holds your main-repo worktree plus one worktree per sibling at its real relative position — $sib_paths — so relative references like \`${SIB_REL[${SIBLINGS[0]}]}\` resolve from inside your main worktree. Every worktree in the layout is on branch \`$branch\`; commit only on \`$branch\` in whichever repos you touch. In sibling repos commit only and never push them — the coordinator trial-merges every repo you touched as one set, gates once, and lands them together. Never touch the real checkouts ($real_paths) or any other layout under \`$LAYOUT_ROOT\`. Say which repos gained commits in your close-out note."
  fi
  # Epic context and orientation card are resolved fresh on every dispatch
  # (the preflight EPIC_JSON goes stale mid-run) and spliced in after
  # render_prompt, never through its single-line sed pass.
  local epic_json epic_context ctx_file orientation_path orient_file oc
  epic_json="$(bd show "$EPIC" --json 2>/dev/null)"
  epic_context="$(jq -r 'if type=="array" then .[0] else . end | .description // empty' <<< "$epic_json" 2>/dev/null)"
  [ -n "$epic_context" ] || epic_context='(epic description unavailable)'
  ctx_file="$RUN_DIR/ctx-$child.md"
  printf '%s\n' "$epic_context" > "$ctx_file"

  local -a orientation_candidates=()
  if [ -n "$ORIENTATION_FILE" ]; then
    orientation_candidates=("$ORIENTATION_FILE")
  else
    orientation_candidates=(docs/agent-orientation.md AGENTS.md)
  fi
  orientation_path=''
  for oc in "${orientation_candidates[@]}"; do
    if [ -f "$wt/$oc" ]; then orientation_path="$wt/$oc"; break; fi
  done
  orient_file="$RUN_DIR/orient-$child.md"
  if [ -n "$orientation_path" ]; then
    cp "$orientation_path" "$orient_file"
  else
    printf '(no orientation card in this repo)\n' > "$orient_file"
  fi

  prompt="$RUN_DIR/prompt-$child.md"
  render_prompt "$child" "$worker" "$branch" "$wt" "$offset" "$prompt"
  splice_marker "$prompt" '@EPIC_CONTEXT@' "$ctx_file"
  splice_marker "$prompt" '@ORIENTATION_CARD@' "$orient_file"
  artifact="$RUN_DIR/worker-$child.log"
  bytes="$artifact.bytes"; rate="$artifact.rate-limit"; cost="$artifact.cost"; identity="$RUN_DIR/worker-$worker.owned"
  : > "$artifact"; printf '0\n' > "$bytes"; rm -f "$rate" "$cost" "$identity"

  (
    cd "$wt" || exit 98
    export BEADS_ACTOR="$worker" BEADS_DIR="$REPO/.beads"
    export COOKEPIC_EPIC="$EPIC" COOKEPIC_CHILD="$child" COOKEPIC_WORKER="$worker"
    export COOKEPIC_BRANCH="$branch" COOKEPIC_WORKTREE="$wt" COOKEPIC_BASE="$BASE_BRANCH"
    [ -z "$layout" ] || export COOKEPIC_LAYOUT="$layout"
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
    # Long-lived prompt-cache TTL so the shared system-prompt prefix (see
    # --exclude-dynamic-system-prompt-sections below) survives the gap between
    # dispatch waves. Respect an explicit caller setting.
    if { [ "$HARNESS" = claude ] || [ "$HARNESS" = ccx ]; } \
       && [ -z "${ENABLE_PROMPT_CACHING_1H+x}" ]; then
      export ENABLE_PROMPT_CACHING_1H=1
    fi
    rc=0
    case "$HARNESS" in
      worker-cmd)
        capture_worker "$artifact" "$bytes" "$rate" "$cost" worker_exec "$identity" "$AGENT_BIN" "$prompt" || rc=$? ;;
      kimi)
        # kimi rejects permission flags (-y/--auto) combined with -p; prompt
        # mode already runs tools non-interactively, so PERM_MODE is a no-op.
        args=(-p "$(<"$prompt")" --output-format stream-json)
        [ -n "$ACTIVE_MODEL" ] && args+=(-m "$ACTIVE_MODEL")
        capture_worker "$artifact" "$bytes" "$rate" "$cost" worker_exec "$identity" "$AGENT_BIN" "${args[@]}" || rc=$? ;;
      claude|ccx)
        args=(-p --permission-mode "$PERM_MODE" --output-format json)
        # Default Claude-family workers to Sonnet: implementation does not need
        # the top-tier model, and the prompt raises plan/review stages itself.
        args+=(--model "${ACTIVE_MODEL:-sonnet}")
        # Move per-machine sections (cwd, env, git status) out of the system
        # prompt so parallel workers in distinct worktrees share one
        # prompt-cache prefix instead of fragmenting it.
        args+=(--exclude-dynamic-system-prompt-sections)
        capture_worker "$artifact" "$bytes" "$rate" "$cost" worker_exec "$identity" "$AGENT_BIN" "${args[@]}" -- "$(<"$prompt")" || rc=$? ;;
      codex)
        case "$PERM_MODE" in
          auto) args=(-a never -s danger-full-access) ;;
          bypassPermissions) args=(--dangerously-bypass-approvals-and-sandbox) ;;
          *) args=(-a never -s "$PERM_MODE") ;;
        esac
        [ -n "$ACTIVE_MODEL" ] && args+=(-m "$ACTIVE_MODEL")
        [ "$CODEX_HIGH_REASONING" -eq 0 ] || args+=(-c 'model_reasoning_effort="high"')
        capture_worker "$artifact" "$bytes" "$rate" "$cost" worker_exec "$identity" "$AGENT_BIN" "${args[@]}" exec --json "$(<"$prompt")" || rc=$? ;;
      opencode)
        args=(run --format json --auto)
        [ -n "$ACTIVE_MODEL" ] && args+=(-m "$ACTIVE_MODEL")
        capture_worker "$artifact" "$bytes" "$rate" "$cost" worker_exec "$identity" "$AGENT_BIN" "${args[@]}" -- "$(<"$prompt")" || rc=$? ;;
    esac
    exit "$rc"
  ) &
  pid=$!

  PID2CHILD[$pid]="$child"; PID2BRANCH[$pid]="$branch"; PID2WORKER[$pid]="$worker"
  PID2WT[$pid]="$wt"; PID2ARTIFACT[$pid]="$artifact"; PID2OUTPUT_BYTES[$pid]="$bytes"; PID2RATE_LIMIT[$pid]="$rate"; PID2COST[$pid]="$cost"
  if [ "$SCOPE_OK" -eq 1 ]; then
    LIVE_AGENT_PID[$pid]="$pid"; LIVE_ROOT_PGID[$pid]=0
  elif owned_identity_load "$identity" "$pid"; then
    LIVE_AGENT_PID[$pid]="$OWNED_PID"; LIVE_ROOT_TICKS[$pid]="$OWNED_TICKS"; LIVE_ROOT_PGID[$pid]="$OWNED_PGID"
  else
    LIVE_AGENT_PID[$pid]=0; LIVE_ROOT_TICKS[$pid]=''; LIVE_ROOT_PGID[$pid]=0
  fi
  INFLIGHT[$child]=1
  liveness_start "$pid"
  DISPATCHED=$((DISPATCHED + 1))
  mbox --arg child "$child" --arg worker "$worker" --arg branch "$branch" --arg ts "$(date +%H:%M:%S)" \
    '{event:"dispatched",child:$child,worker:$worker,branch:$branch,ts:$ts}'
  say "dispatched $child to $worker on $branch (pid $pid)"
  sleep "$SPAWN_DELAY"
}

# ----------------------------------------------------------------- reap ----
extract_cost() { # <artifact> <streamed cost path> -> prints cost or empty
  [ "$COST_SUPPORTED" -eq 1 ] || return 0
  if [ -s "$2" ]; then
    < "$2" tr -d '\n'
    return
  fi
  grep -aoE '"total_cost_usd"[[:space:]]*:[[:space:]]*[0-9]+([.][0-9]+)?' "$1" 2>/dev/null \
    | tail -n 1 | sed -E 's/.*:[[:space:]]*//' || true
}

# claude/ccx only: resolve the worker's transcript from its session_id and
# derive time/tools/tokens spent before its first Edit|Write|MultiEdit|
# NotebookEdit call. Any other harness, or a missing/unreadable transcript,
# prints the JSON literal null so reap_worker never breaks on it.
orientation_metrics() { # <artifact> -> prints one compact JSON object or null
  local artifact="$1" sid transcript f result
  [ "$COST_SUPPORTED" -eq 1 ] || { echo null; return 0; }
  sid=$(grep -aoE '"session_id"[[:space:]]*:[[:space:]]*"[^"]*"' "$artifact" 2>/dev/null \
    | tail -n 1 | sed -E 's/.*"session_id"[[:space:]]*:[[:space:]]*"([^"]*)"/\1/')
  [ -n "$sid" ] || { echo null; return 0; }
  transcript=''
  for f in "$HOME"/.claude/projects/*/"$sid.jsonl"; do
    [ -e "$f" ] && transcript="$f"
  done
  [ -n "$transcript" ] || { echo null; return 0; }
  result=$(jq -sc '
    def cleants: sub("\\.[0-9]+Z$"; "Z");
    [.[] | select(.type == "assistant" and (.timestamp != null))] as $a
    | ($a | to_entries
        | map(select(.value.message.content[]?
            | .type == "tool_use"
              and (.name as $n | ["Edit","Write","MultiEdit","NotebookEdit"] | index($n) != null)))
        | first) as $edit
    | if ($a | length) == 0 or $edit == null then
        {secondsToFirstEdit: null, toolCallsBeforeFirstEdit: null, tokensBeforeFirstEdit: null}
      else
        ($a[0:$edit.key]) as $before
        | {
            secondsToFirstEdit: (($edit.value.timestamp | cleants | fromdateiso8601)
              - ($a[0].timestamp | cleants | fromdateiso8601)),
            toolCallsBeforeFirstEdit: ([$before[].message.content[]? | select(.type == "tool_use")] | length),
            tokensBeforeFirstEdit: ([$before[].message.usage
              | (.input_tokens // 0) + (.cache_creation_input_tokens // 0) + (.output_tokens // 0)] | add // 0)
          }
      end
  ' "$transcript" 2>/dev/null)
  [ -n "$result" ] && printf '%s\n' "$result" || echo null
}

append_orientation_summary() { # <child> <orientation-json-or-null>
  local child="$1" o="$2" secs calls toks
  [ -n "$o" ] && [ "$o" != null ] || return 0
  secs=$(jq -r '.secondsToFirstEdit // empty' <<<"$o" 2>/dev/null)
  calls=$(jq -r '.toolCallsBeforeFirstEdit // empty' <<<"$o" 2>/dev/null)
  toks=$(jq -r '.tokensBeforeFirstEdit // empty' <<<"$o" 2>/dev/null)
  [ -n "$secs" ] && [ -n "$calls" ] && [ -n "$toks" ] || return 0
  printf -- '- %s orientation: %ss to first edit, %s tool calls, %s tokens before first edit\n' \
    "$child" "$secs" "$calls" "$toks" >> "$SUMMARY"
}

# ------------------------------------------------------------------ fold ----
# Coordinator-owned single-writer fold: after a landed child whose epic notes
# gained DECISION:/GOTCHA: lines since its dispatch, a one-shot agent (unlike
# the tool-less liveness inspector, this one needs real Bash/bd access) folds
# those payloads into the epic's Context & architecture section and writes the
# result back with `bd update $EPIC --body-file`. Runs inline inside the
# caller's already-serialized landing section (sequential tick / merge-slot-
# held merge loop) so it can never race another fold. Failure is non-fatal.
render_fold_prompt() { # <description> <new-notes> <prompt path>
  local desc="$1" new_notes="$2" prompt="$3"
  cp -f "$FOLD_TEMPLATE" "$prompt"
  cat >> "$prompt" <<EOF

## Epic id

$EPIC

## Today's date

$(date +%Y-%m-%d)

## Current description (verbatim — sections outside Context & architecture are shown for reference only; do not touch them)

$desc

## New DECISION:/GOTCHA: lines to fold in (from the epic notes added since this child's dispatch)

$new_notes
EOF
  chmod 600 "$prompt"
}

run_fold_harness() { # <prompt> <raw> <identity file>
  local prompt="$1" raw="$2" identity="$3" rc=0
  export FLEET_UNIT="cook-epic-$SCOPE_ID-fold" COOKEPIC_FOLD=1 COOKEPIC_RUN_DIR="$RUN_DIR"
  if [ -n "$FOLD_CMD" ]; then
    capture_inspector_raw "$raw" inspector_exec "$identity" "$FOLD_CMD" "$prompt" || rc=$?
    return "$rc"
  fi
  case "$HARNESS" in
    claude|ccx)
      capture_inspector_raw "$raw" inspector_exec "$identity" \
        flock "$HEAVY_LOCK" timeout "$FOLD_TIMEOUT" "$AGENT_BIN" -p --permission-mode "$PERM_MODE" \
        --output-format text --model "${ACTIVE_MODEL:-haiku}" --exclude-dynamic-system-prompt-sections \
        -- "$(<"$prompt")" || rc=$?
      ;;
    kimi)
      local -a kimi_args=(-p "$(<"$prompt")" --output-format stream-json)
      [ -n "$ACTIVE_MODEL" ] && kimi_args+=(-m "$ACTIVE_MODEL")
      capture_inspector_raw "$raw" inspector_exec "$identity" \
        flock "$HEAVY_LOCK" timeout "$FOLD_TIMEOUT" "$AGENT_BIN" "${kimi_args[@]}" || rc=$?
      ;;
    codex)
      local -a codex_args
      case "$PERM_MODE" in
        auto) codex_args=(-a never -s danger-full-access) ;;
        bypassPermissions) codex_args=(--dangerously-bypass-approvals-and-sandbox) ;;
        *) codex_args=(-a never -s "$PERM_MODE") ;;
      esac
      [ -n "$ACTIVE_MODEL" ] && codex_args+=(-m "$ACTIVE_MODEL")
      [ "$CODEX_HIGH_REASONING" -eq 0 ] || codex_args+=(-c 'model_reasoning_effort="high"')
      capture_inspector_raw "$raw" inspector_exec "$identity" \
        flock "$HEAVY_LOCK" timeout "$FOLD_TIMEOUT" "$AGENT_BIN" "${codex_args[@]}" exec --json "$(<"$prompt")" || rc=$?
      ;;
    opencode)
      local -a oc_args=(run --format json --auto)
      [ -n "$ACTIVE_MODEL" ] && oc_args+=(-m "$ACTIVE_MODEL")
      capture_inspector_raw "$raw" inspector_exec "$identity" \
        flock "$HEAVY_LOCK" timeout "$FOLD_TIMEOUT" "$AGENT_BIN" "${oc_args[@]}" -- "$(<"$prompt")" || rc=$?
      ;;
    worker-cmd) return 127 ;;
  esac
  return "$rc"
}

fold_skip() { # <child> <reason> — non-fatal: log and note the epic, run continues
  local child="$1" reason="$2"
  say "fold skipped for $child ($reason)"
  bd note "$EPIC" "cook-epic: fold skipped for $child ($reason)" >/dev/null 2>>"$LOG"
}

queue_pending_fold() { # <child>
  PENDING_FOLDS[$1]=1
  say "fold for $1 is waiting for the provider fallback"
}

retry_pending_folds() {
  local child
  [ "$FALLBACK_PENDING" -eq 0 ] || return 0
  for child in "${!PENDING_FOLDS[@]}"; do
    unset "PENDING_FOLDS[$child]"
    fold_epic_notes "$child"
    [ "$FALLBACK_PENDING" -eq 0 ] || break
  done
}

fold_epic_notes() { # <child> — no-op unless the epic notes gained DECISION:/GOTCHA: since dispatch
  local child="$1" epic_json notes old_len new_part desc prompt raw identity before after fold_rc=0
  if [ "$FALLBACK_PENDING" -eq 1 ]; then
    queue_pending_fold "$child"
    return 0
  fi
  old_len="${EPIC_NOTES_LEN[$child]:-}"
  [ -n "$old_len" ] || return 0
  epic_json="$(bd show "$EPIC" --json 2>/dev/null)" || { fold_skip "$child" "bd show $EPIC failed"; return 0; }
  notes="$(jq -r 'if type=="array" then .[0] else . end | .notes // ""' <<<"$epic_json" 2>/dev/null)"
  new_part="${notes:$old_len}"
  [[ "$new_part" == *DECISION:* || "$new_part" == *GOTCHA:* ]] || return 0
  desc="$(jq -r 'if type=="array" then .[0] else . end | .description // ""' <<<"$epic_json" 2>/dev/null)"
  before="$desc"
  prompt="$RUN_DIR/fold-$child.prompt.md"; raw="$RUN_DIR/fold-$child.raw.log"; identity="$RUN_DIR/fold-$child.owned"
  render_fold_prompt "$desc" "$new_part" "$prompt"
  rm -f "$raw" "$identity"
  say "$child landed with DECISION:/GOTCHA: markers in the epic notes; folding into $EPIC"
  ( cd "$REPO" && run_fold_harness "$prompt" "$raw" "$identity" ) || fold_rc=$?
  if [ "$fold_rc" -ne 0 ]; then
    if provider_failure_evidence "$raw" '' "$fold_rc" \
      && request_provider_fallback "$child" "provider unavailable during fold (rc=$fold_rc)"; then
      queue_pending_fold "$child"
      return 0
    fi
    fold_skip "$child" "fold agent failed to run (see $raw)"
    return 0
  fi
  after="$(bd show "$EPIC" --json 2>/dev/null | jq -r 'if type=="array" then .[0] else . end | .description // ""' 2>/dev/null)"
  if [ "$after" = "$before" ]; then
    fold_skip "$child" 'fold agent made no description change'
    return 0
  fi
  mbox --arg child "$child" --arg ts "$(date +%H:%M:%S)" '{event:"folded",child:$child,ts:$ts}'
  say "$child folded into $EPIC Context & architecture"
}

cleanup_worktree() { # <wt> — only coordinator-owned run-scoped paths are removable
  [ "$1" = "$REPO" ] && return 0  # sequential mode: the "worktree" IS the main checkout
  local wt="$1" layout s swt failed=0
  if [ "$LAYOUT_MODE" -eq 1 ] && [[ "$wt" == "$LAYOUT_ROOT/"*"/$REPO_BASENAME" ]]; then
    # A layout is one unit: remove every sibling worktree, the main worktree,
    # then the layout directory. Branches survive for retries.
    layout="${wt%/*}"
    for s in "${SIBLINGS[@]}"; do
      swt=$(sibling_layout_wt "$layout" "$s")
      git -C "$s" worktree list --porcelain | grep -Fxq "worktree $swt" || continue
      git -C "$s" worktree remove --force "$swt" >>"$LOG" 2>&1 || failed=1
    done
    if git worktree list --porcelain | grep -Fxq "worktree $wt"; then
      git worktree remove --force "$wt" >>"$LOG" 2>&1 || failed=1
    fi
    if [ "$failed" -eq 0 ]; then
      rm -rf "$layout" 2>/dev/null || true
      return 0
    fi
    fatal_reconcile "could not remove coordinator layout $layout; refusing redispatch until operator reconciles"
    return 1
  fi
  if git worktree remove --force "$wt" >>"$LOG" 2>&1; then
    return 0
  fi
  fatal_reconcile "could not remove coordinator worktree $wt; refusing redispatch until operator reconciles"
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
  local repo="$1" key="$2" current baseline added
  # Refresh stat info first: build steps may rewrite tracked files with
  # identical bytes (regenerated codegen output), and an unrefreshed
  # diff-index reports those as modified until any git status runs — a
  # phantom that fails attempts against dirt that does not exist.
  git -C "$repo" update-index --refresh -q >/dev/null 2>&1 || true
  if ! git -C "$repo" diff-index --quiet HEAD -- . ':(exclude).beads' 2>/dev/null; then
    say "dirty: $repo has uncommitted tracked changes: $(git -C "$repo" diff-index --name-only HEAD -- . ':(exclude).beads' 2>/dev/null | head -10 | paste -sd ' ' -)"
    return 0
  fi
  if registered_nested_worktree_dirty "$repo"; then
    say "dirty: $repo has a dirty or unknown registered nested worktree"
    return 0
  fi
  current=$(sequential_untracked_paths "$repo" | sort)
  baseline="${FIRST_UNTRACKED[$key]:-}"
  # Only paths ADDED since the child's first dispatch count as dirt. Paths that
  # vanish from the baseline (operator cleanup, hooks) must not fail every
  # remaining attempt against a stale snapshot.
  added=$(comm -13 <(printf '%s\n' "$baseline") <(printf '%s\n' "$current") | grep -v '^$' || true)
  if [ -n "$added" ]; then
    say "dirty: $repo gained untracked paths since first dispatch: $(printf '%s\n' "$added" | head -10 | paste -sd ' ' -)"
    return 0
  fi
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
    # Parallel external-movement detection tracks the last head this run
    # accepted per sibling; RUN_SIB_HEAD stays frozen for final reporting.
    SIB_LAST_ACCEPTED[$s]=${RUN_SIB_HEAD[$s]}
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

# A failed attempt whose worker recorded permission denials is unlikely to be
# fixed by identical retries: the auto-mode classifier blocks the same action
# again. One retry is allowed (denials can be stochastic); a second
# denial-bearing failure blocks the child for a human immediately instead of
# burning the remaining attempts. Sets ESCALATED_REASON; callers read it.
escalate_permission_denials() { # <child> <denied-flag> <reason>
  local child="$1" denied="$2" reason="$3"
  if [ "$denied" -eq 1 ]; then
    PERM_DENIALS[$child]=$(( ${PERM_DENIALS[$child]:-0} + 1 ))
    if [ "${PERM_DENIALS[$child]}" -ge 2 ]; then
      ATTEMPTS[$child]=$(( MAX_ATTEMPTS - 1 ))
      reason="persistent permission denials across ${PERM_DENIALS[$child]} attempts (last: $reason) — needs a human or an elevated session"
    else
      reason="$reason; permission denials recorded"
    fi
  fi
  ESCALATED_REASON="$reason"
}

reap_worker() { # <pid> <rc>
  local pid="$1" rc="$2"
  local child="${PID2CHILD[$pid]}" branch="${PID2BRANCH[$pid]}" worker="${PID2WORKER[$pid]}"
  local wt="${PID2WT[$pid]}" artifact="${PID2ARTIFACT[$pid]}"
  local stopped_reason="${PID2STOP_REASON[$pid]:-}"
  cleanup_worker_liveness "$pid"
  local rate_marker="${PID2RATE_LIMIT[$pid]}" cost_path="${PID2COST[$pid]}"
  unset "PID2CHILD[$pid]" "PID2BRANCH[$pid]" "PID2WORKER[$pid]" "PID2WT[$pid]" "PID2ARTIFACT[$pid]"
  unset "PID2OUTPUT_BYTES[$pid]" "PID2RATE_LIMIT[$pid]" "PID2COST[$pid]"
  unset "PID2STOP_REASON[$pid]"
  unset "INFLIGHT[$child]"

  local cost status commits title orientation provider_failure=0
  cost=$(extract_cost "$artifact" "$cost_path")
  [ -n "$cost" ] && TOTAL_COST=$(jq -cn --argjson t "$TOTAL_COST" --argjson c "$cost" '$t + $c')
  orientation=$(orientation_metrics "$artifact")
  status=$(bd show "$child" --json 2>/dev/null | jq -r 'if type=="array" then .[0] else . end | .status // "?"')
  commits=$(git rev-list --count "$BASE_BRANCH..$branch" 2>/dev/null || echo 0)
  title=$(bd show "$child" --json 2>/dev/null | jq -r 'if type=="array" then .[0] else . end | .title // ""')
  # Claude/ccx result records carry permission_denials only when non-empty;
  # other harnesses never match, leaving the flag 0.
  local perm_denied=0
  grep -q '"permission_denials":\[{' "$artifact" 2>/dev/null && perm_denied=1

  if provider_failure_evidence "$artifact" "$rate_marker" "$rc"; then
    provider_failure=1
  fi

  # Provider failures change the whole fleet. Reopen this child without an
  # attempt, stop new dispatches, and let current workers drain before the
  # harness, model, inspectors, and cost support change together.
  if [ -z "$stopped_reason" ] && [ "$status" != closed ] && [ "$provider_failure" -eq 1 ] \
    && request_provider_fallback "$child" "provider unavailable on $worker (rc=$rc)"; then
    if [ "$SEQUENTIAL" = 1 ]; then
      sequential_claim_recovery_if_effects "$child"
      LAST_ACCEPTED_HEAD=$(git rev-parse HEAD)
    fi
    REQUEUE_AT[$child]=$(date +%s)
    bd update "$child" --status open >/dev/null 2>>"$LOG"
    say "$child will retry after the provider fallback"
    cleanup_worktree "$wt"
    return
  fi

  # Rate limit: don't burn an attempt; back off before re-dispatch.
  if [ -z "$stopped_reason" ] && [ "$status" != closed ] \
    && provider_rate_failure_evidence "$artifact" "$rate_marker"; then
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
    reap_sequential "$child" "$worker" "$rc" "$status" "$title" "$stopped_reason" "$perm_denied" "$orientation"
    return
  fi

  # With mirrored sibling layouts, a child's effects can live in any repo of
  # the set: count commits on this branch name across main + every sibling.
  local total_commits="$commits" s
  if [ "$LAYOUT_MODE" -eq 1 ]; then
    for s in "${SIBLINGS[@]}"; do
      total_commits=$((total_commits + $(branch_ahead "$s" "${SIB_BRANCH[$s]}" "$branch")))
    done
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
    if [ "$total_commits" -eq 0 ]; then
      mbox --arg child "$child" --arg worker "$worker" --argjson comments "$now_comments" \
        --argjson cost "${cost:-null}" --argjson orientation "$orientation" --arg ts "$(date +%H:%M:%S)" \
        '{event:"researched",child:$child,worker:$worker,comments:$comments,cost:$cost,orientation:$orientation,ts:$ts}'
      say "$child researched on $worker (findings in beads, no code) — nothing to merge"
      RESEARCHED=$((RESEARCHED + 1))
      cleanup_worktree "$wt"
      delete_branch_everywhere "$branch"
      return
    fi
  fi

  # A non-research child may correctly close with an empty branch when its work
  # already exists (operator pre-commit, external/infra effects). Accept that
  # only with evidence: a new bead comment since dispatch. A bare close with no
  # commits and no comment still fails as unverifiable.
  if [ "$status" = closed ] && ! is_research_child "$child" "$title" && [ "$total_commits" -eq 0 ]; then
    local nc_comments
    nc_comments=$(comment_count_of "$child")
    if [ "$nc_comments" -gt "${PRECOMMENTS[$child]:-0}" ]; then
      mbox --arg child "$child" --arg worker "$worker" --argjson comments "$nc_comments" \
        --argjson cost "${cost:-null}" --argjson orientation "$orientation" --arg ts "$(date +%H:%M:%S)" \
        '{event:"completed-no-code",child:$child,worker:$worker,comments:$comments,cost:$cost,orientation:$orientation,ts:$ts}'
      say "$child completed on $worker with no new commits (evidence in bead comment) — nothing to merge"
      MERGED=$((MERGED + 1))
      cleanup_worktree "$wt"
      delete_branch_everywhere "$branch"
      return
    fi
  fi

  if [ "$status" = closed ] && [ "$total_commits" -gt 0 ]; then
    local summary sib_summary
    summary=$(git log --format='%s' "$BASE_BRANCH..$branch" 2>/dev/null | paste -sd ';' -)
    if [ "$LAYOUT_MODE" -eq 1 ]; then
      for s in "${SIBLINGS[@]}"; do
        [ "$(branch_ahead "$s" "${SIB_BRANCH[$s]}" "$branch")" -gt 0 ] || continue
        sib_summary=$(git -C "$s" log --format='%s' "${SIB_BRANCH[$s]}..$branch" 2>/dev/null | paste -sd ';' -)
        summary="${summary:+$summary; }[${s##*/}] $sib_summary"
      done
    fi
    mbox --arg child "$child" --arg worker "$worker" --arg branch "$branch" \
      --arg summary "$summary" --argjson commits "$total_commits" --argjson cost "${cost:-null}" \
      --argjson orientation "$orientation" --arg ts "$(date +%H:%M:%S)" \
      '{event:"done",child:$child,worker:$worker,branch:$branch,summary:$summary,commits:$commits,cost:$cost,orientation:$orientation,ts:$ts}'
    CHILD_ORIENTATION[$child]="$orientation"
    say "$child done on $worker ($total_commits commits) — queued for merge"
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
  local reason="${stopped_reason:-exited rc=$rc}"
  [ -z "$stopped_reason" ] && [ -n "$WORKER_TIMEOUT" ] && [ "$rc" -eq 124 ] && reason="timed out after ${WORKER_TIMEOUT}s"
  if [ -z "$stopped_reason" ] && [ "$status" = closed ] && [ "$total_commits" -eq 0 ]; then
    if is_research_child "$child" "$title"; then
      reason="closed without findings (no new bead comment)"
    else
      reason="closed without commits or bead-comment evidence"
    fi
  fi
  escalate_permission_denials "$child" "$perm_denied" "$reason"
  fail_attempt "$child" "$worker" "$ESCALATED_REASON"
  cleanup_worktree "$wt"
}

# Sequential mode: the worker committed directly on $BASE_BRANCH in the main
# checkout (and possibly in registered siblings). Verify by effects — closed,
# tree clean, and the tree moved since dispatch (or since the child's first
# dispatch, which covers crash-before-close retries that only needed to close)
# — then run the integration gate and push whatever moved.
reap_sequential() { # <child> <worker> <rc> <status> <title> <stop reason> <perm-denied> <orientation>
  local child="$1" worker="$2" rc="$3" status="$4" title="$5" stopped_reason="${6:-}" perm_denied="${7:-0}" orientation="${8:-null}"
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

  # Non-research child closed with zero new commits, clean tree, unmoved sig:
  # accept only with a new bead comment as evidence of verified completion.
  if [ "$status" = closed ] && ! is_research_child "$child" "$title" \
     && [ "$commits" -eq 0 ] && [ "$dirty" -eq 0 ] \
     && [ "${FIRST_SIG[$child]:-}" = "$(tree_sig)" ]; then
    now_comments=$(comment_count_of "$child")
    if [ "$now_comments" -gt "${PRECOMMENTS[$child]:-0}" ]; then
      [ "$SEQUENTIAL_RECOVERY_CHILD" = "$child" ] && SEQUENTIAL_RECOVERY_CHILD=''
      mbox --arg child "$child" --arg worker "$worker" --argjson comments "$now_comments" --arg ts "$(date +%H:%M:%S)" \
        '{event:"completed-no-code",child:$child,worker:$worker,comments:$comments,ts:$ts}'
      say "$child completed on $worker with no new commits (evidence in bead comment)"
      printf -- '- %s completed with no new commits (evidence in bead comment)\n' "$child" >> "$SUMMARY"
      MERGED=$((MERGED + 1))
      return
    fi
  fi

  if [ "$status" = closed ] && [ "$dirty" -eq 0 ] \
     && { [ "$commits" -gt 0 ] || [ "${FIRST_SIG[$child]:-}" != "$(tree_sig)" ]; }; then
    if [ -n "$GATE" ]; then
      if ! ( cd "$REPO" && gate_run ) >>"$LOG" 2>&1; then
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
      fail_attempt "$child" "$worker" "integration gate left uncommitted changes (see 'dirty:' lines in the run log) — this child owns cleanup before any other child can run"
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
      --arg summary "$summary" --argjson commits "$commits" --argjson repos "$effects" \
      --argjson orientation "$orientation" --arg ts "$(date +%H:%M:%S)" \
      '{event:"done",child:$child,worker:$worker,branch:$branch,summary:$summary,commits:$commits,repositories:$repos,orientation:$orientation,ts:$ts}'
    printf -- '- %s %s on `%s` (%s)\n' "$child" "$landing" "$BASE_BRANCH" "$head" >> "$SUMMARY"
    append_orientation_summary "$child" "$orientation"
    MERGED=$((MERGED + 1))
    fold_epic_notes "$child"
    say "$child done on $worker ($commits commits) — $landing on $BASE_BRANCH ($head)"
    return
  fi

  reason="${stopped_reason:-exited rc=$rc}"
  [ -z "$stopped_reason" ] && [ -n "$WORKER_TIMEOUT" ] && [ "$rc" -eq 124 ] && reason="timed out after ${WORKER_TIMEOUT}s"
  if [ -z "$stopped_reason" ] && [ "$dirty" -eq 1 ]; then
    reason="left uncommitted changes in the working tree (see 'dirty:' lines in the run log) — this child owns cleanup before any other child can run"
  elif [ -z "$stopped_reason" ] && [ "$status" = closed ] && [ "$commits" -eq 0 ]; then
    if is_research_child "$child" "$title"; then
      reason="closed without findings (no new bead comment)"
    else
      reason="closed without commits or bead-comment evidence"
    fi
  fi
  escalate_permission_denials "$child" "$perm_denied" "$reason"
  fail_attempt "$child" "$worker" "$ESCALATED_REASON"
}

reap_finished() {
  local pid rc
  for pid in "${!PID2CHILD[@]}"; do
    if ! worker_is_active "${PID2WORKER[$pid]}" "$pid"; then
      # The cgroup or owned process group must drain before the result is read.
      # Root PID identity includes start ticks, so a recycled PID is not live.
      wait "$pid"; rc=$?
      reap_worker "$pid" "$rc"
    fi
  done
}

# ---------------------------------------------------------------- merge ----
park_branch() { # <child> <branch> <reason> — with siblings, parks the WHOLE branch set
  local child="$1" branch="$2" reason="$3" fix_id desc s set_line=''
  if [ "$LAYOUT_MODE" -eq 1 ]; then
    [ "$(branch_ahead "$REPO" "$BASE_BRANCH" "$branch")" -eq 0 ] \
      || set_line="- this repository (\`$REPO\`, base \`$BASE_BRANCH\`)"
    for s in "${SIBLINGS[@]}"; do
      [ "$(branch_ahead "$s" "${SIB_BRANCH[$s]}" "$branch")" -gt 0 ] || continue
      set_line="${set_line:+$set_line
}- sibling \`$s\` (base \`${SIB_BRANCH[$s]}\`)"
    done
  fi
  if [ -n "$set_line" ]; then
    desc="Branch \`$branch\` (child \`$child\`) failed to land: $reason. The branch set spans several repositories and lands all-or-nothing; the whole set is parked together:

$set_line

Repair procedure: you will be on branch \`$branch\` in an isolated layout, with the same branch checked out in each sibling worktree beside your main worktree. In EVERY repository listed above, merge that repository's base branch into \`$branch\` and resolve conflicts"
  else
    desc="Branch \`$branch\` (child \`$child\`) failed to land on \`$BASE_BRANCH\`: $reason.

Repair procedure: you will be on branch \`$branch\` in an isolated worktree. Merge \`$BASE_BRANCH\` into it, resolve conflicts"
  fi
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
  if [ -n "$set_line" ]; then
    desc="$desc Do NOT merge into any base branch yourself, and never push sibling repos — the coordinator re-lands the whole set when this issue closes."
  else
    desc="$desc Do NOT merge into $BASE_BRANCH yourself."
  fi
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
  local s
  if [ "$(git -C "$REPO" rev-parse HEAD)" != "$LAST_ACCEPTED_HEAD" ]; then
    fatal_reconcile "base branch $BASE_BRANCH moved externally; cannot trial-merge — operator must reconcile"
    return 1
  fi
  if [ "$LAYOUT_MODE" -eq 1 ]; then
    for s in "${SIBLINGS[@]}"; do
      if [ "$(git -C "$s" rev-parse HEAD)" != "${SIB_LAST_ACCEPTED[$s]}" ]; then
        fatal_reconcile "sibling $s branch ${SIB_BRANCH[$s]} moved externally; cannot trial-merge — operator must reconcile"
        return 1
      fi
    done
  fi
  local queue=("${MERGE_QUEUE[@]}")
  local i entry child branch merge_commit main_ahead total_ahead conflict repos_json head
  local -A sib_ahead=()

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

    # Which repos does this branch set touch? Landing is all-or-nothing
    # across the set: main plus every sibling with commits on this branch.
    main_ahead=$(branch_ahead "$REPO" "$BASE_BRANCH" "$branch")
    total_ahead="$main_ahead"
    sib_ahead=()
    if [ "$LAYOUT_MODE" -eq 1 ]; then
      for s in "${SIBLINGS[@]}"; do
        sib_ahead[$s]=$(branch_ahead "$s" "${SIB_BRANCH[$s]}" "$branch")
        total_ahead=$((total_ahead + ${sib_ahead[$s]}))
      done
    fi
    if [ "$total_ahead" -eq 0 ]; then
      say "nothing to land for $branch ($child) — dropping empty branch set"
      unset "PARKED[$branch]"
      delete_branch_everywhere "$branch"
      continue
    fi

    # The coordinator owns these integration worktrees. Reset tracked state and
    # remove every untracked or ignored artifact before each trial merge.
    git -C "$INTEG_WT" reset --hard "$BASE_BRANCH" >>"$LOG" 2>&1
    git -C "$INTEG_WT" clean -fdx >>"$LOG" 2>&1
    setup_worktree "$INTEG_WT"
    if [ "$LAYOUT_MODE" -eq 1 ]; then
      for s in "${SIBLINGS[@]}"; do
        git -C "${SIB_INTEG_WT[$s]}" reset --hard "${SIB_BRANCH[$s]}" >>"$LOG" 2>&1
        git -C "${SIB_INTEG_WT[$s]}" clean -fdx >>"$LOG" 2>&1
        setup_worktree_assets "$s" "${SIB_INTEG_WT[$s]}"
      done
    fi

    # Trial-merge every repo in the set; ANY conflict parks the whole set.
    conflict=0
    if [ "$main_ahead" -gt 0 ] \
       && ! git -C "$INTEG_WT" merge --no-ff "$branch" -m "cook-epic: merge $branch ($child)" >>"$LOG" 2>&1; then
      git -C "$INTEG_WT" merge --abort >>"$LOG" 2>&1
      conflict=1
    fi
    if [ "$conflict" -eq 0 ] && [ "$LAYOUT_MODE" -eq 1 ]; then
      for s in "${SIBLINGS[@]}"; do
        [ "${sib_ahead[$s]}" -gt 0 ] || continue
        if ! git -C "${SIB_INTEG_WT[$s]}" merge --no-ff "$branch" -m "cook-epic: merge $branch ($child)" >>"$LOG" 2>&1; then
          git -C "${SIB_INTEG_WT[$s]}" merge --abort >>"$LOG" 2>&1
          conflict=1
          break
        fi
      done
    fi
    if [ "$conflict" -eq 1 ]; then
      park_branch "$child" "$branch" conflict
      continue
    fi

    # One gate for the whole set, run from the main integration worktree so
    # relative sibling references resolve against the sibling trial merges.
    if [ -n "$GATE" ]; then
      if ! ( cd "$INTEG_WT" && gate_run ) >>"$LOG" 2>&1; then
        git -C "$INTEG_WT" reset --hard "$BASE_BRANCH" >>"$LOG" 2>&1
        if [ "$LAYOUT_MODE" -eq 1 ]; then
          for s in "${SIBLINGS[@]}"; do
            git -C "${SIB_INTEG_WT[$s]}" reset --hard "${SIB_BRANCH[$s]}" >>"$LOG" 2>&1
          done
        fi
        park_branch "$child" "$branch" gate-failed
        continue
      fi
    fi

    # Land: fast-forward every repo in the set, then push each.
    if [ "$main_ahead" -gt 0 ] && ! git -C "$REPO" merge --ff-only "$INTEG_BRANCH" >>"$LOG" 2>&1; then
      MERGE_QUEUE=("${queue[@]:$i}")
      STOPPING=1; FATAL_STOP=1
      STOP_REASON="base branch $BASE_BRANCH moved externally; cannot fast-forward — operator must reconcile"
      say "$STOP_REASON"
      bd merge-slot release --holder "$HOLDER" >/dev/null 2>>"$LOG"
      return 1
    fi
    if [ "$LAYOUT_MODE" -eq 1 ]; then
      for s in "${SIBLINGS[@]}"; do
        [ "${sib_ahead[$s]}" -gt 0 ] || continue
        if ! git -C "$s" merge --ff-only "$INTEG_BRANCH" >>"$LOG" 2>&1; then
          MERGE_QUEUE=("${queue[@]:$i}")
          STOPPING=1; FATAL_STOP=1
          STOP_REASON="sibling $s branch ${SIB_BRANCH[$s]} moved externally; cannot fast-forward — operator must reconcile"
          say "$STOP_REASON"
          bd merge-slot release --holder "$HOLDER" >/dev/null 2>>"$LOG"
          return 1
        fi
      done
    fi
    if [ "$PUSH_ENABLED" -eq 1 ]; then
      if [ "$main_ahead" -gt 0 ] && ! push_repo "$REPO" origin "$BASE_BRANCH" >>"$LOG" 2>&1; then
        MERGE_QUEUE=("${queue[@]:$i}")
        STOPPING=1; FATAL_STOP=1
        STOP_REASON="push of $BASE_BRANCH rejected (remote moved?); operator must reconcile"
        say "$STOP_REASON"
        bd merge-slot release --holder "$HOLDER" >/dev/null 2>>"$LOG"
        return 1
      fi
      if [ "$LAYOUT_MODE" -eq 1 ]; then
        for s in "${SIBLINGS[@]}"; do
          [ "${sib_ahead[$s]}" -gt 0 ] || continue
          if ! push_repo "$s" origin "${SIB_BRANCH[$s]}" >>"$LOG" 2>&1; then
            MERGE_QUEUE=("${queue[@]:$i}")
            STOPPING=1; FATAL_STOP=1
            STOP_REASON="push of sibling $s branch ${SIB_BRANCH[$s]} rejected (remote moved?); operator must reconcile"
            say "$STOP_REASON"
            bd merge-slot release --holder "$HOLDER" >/dev/null 2>>"$LOG"
            return 1
          fi
        done
      fi
    fi
    merge_commit=$(git -C "$REPO" rev-parse --short HEAD)
    LAST_ACCEPTED_HEAD=$(git -C "$REPO" rev-parse HEAD)
    repos_json='[]'
    [ "$main_ahead" -eq 0 ] || repos_json=$(jq -cn --arg repo "$REPO" --argjson commits "$main_ahead" --arg head "$LAST_ACCEPTED_HEAD" \
      '[{repo:$repo,commits:$commits,head:$head}]')
    if [ "$LAYOUT_MODE" -eq 1 ]; then
      for s in "${SIBLINGS[@]}"; do
        head=$(git -C "$s" rev-parse HEAD)
        SIB_LAST_ACCEPTED[$s]="$head"
        [ "${sib_ahead[$s]}" -gt 0 ] || continue
        repos_json=$(jq -cn --argjson repos "$repos_json" --arg repo "$s" --argjson commits "${sib_ahead[$s]}" --arg head "$head" \
          '$repos + [{repo:$repo,commits:$commits,head:$head}]')
      done
    fi
    MERGED=$((MERGED + 1))
    unset "PARKED[$branch]"
    local merge_landing='gated, landed locally'
    [ "$VERIFIED" -eq 0 ] && merge_landing='landed unverified locally'
    [ "$PUSH_ENABLED" -eq 1 ] && merge_landing='gated, pushed, landed'
    [ "$PUSH_ENABLED" -eq 1 ] && [ "$VERIFIED" -eq 0 ] && merge_landing='pushed, landed unverified'
    mbox --arg child "$child" --arg branch "$branch" --arg commit "$merge_commit" --arg landing "$merge_landing" \
      --argjson repos "$repos_json" --arg ts "$(date +%H:%M:%S)" \
      '{event:"merged",child:$child,branch:$branch,commit:$commit,landing:$landing,repositories:$repos,ts:$ts}'
    printf -- '- %s %s via `%s` (%s)\n' "$child" "$merge_landing" "$branch" "$merge_commit" >> "$SUMMARY"
    append_orientation_summary "$child" "${CHILD_ORIENTATION[$child]:-null}"
    fold_epic_notes "$child"
    say "$merge_landing $branch ($child) into $BASE_BRANCH ($merge_commit)"
    delete_branch_everywhere "$branch"
    [ "$PUSH_ENABLED" -eq 1 ] && push_repo "$REPO" origin --delete "$branch" >>"$LOG" 2>&1 || true
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
  local reason="$1" effects s
  stop_run_inspectors
  bd merge-slot release --holder "$HOLDER" >/dev/null 2>&1 || true
  if [ "$SEQUENTIAL" != 1 ]; then
    git worktree remove --force "$INTEG_WT" >>"$LOG" 2>&1 || true
    git branch -D "$INTEG_BRANCH" >>"$LOG" 2>&1 || true
    if [ "$LAYOUT_MODE" -eq 1 ]; then
      for s in "${SIBLINGS[@]}"; do
        [ -n "${SIB_INTEG_WT[$s]:-}" ] || continue
        git -C "$s" worktree remove --force "${SIB_INTEG_WT[$s]}" >>"$LOG" 2>&1 || true
        git -C "$s" branch -D "$INTEG_BRANCH" >>"$LOG" 2>&1 || true
      done
    fi
  fi
  # Per-repo landing effects are reported for every mode: sequential runs and
  # parallel runs (with or without siblings) share the same baselines.
  capture_run_baselines
  effects=$(repo_effects_json "$RUN_BASE_HEAD")
  if [ "$effects" != '[]' ]; then
    printf '\n## Repository landing effects\n' >> "$SUMMARY"
    jq -r '.[] | "- `\(.repo)`: \(.commits) commits, \(.base[0:12]) → \(.head[0:12])"' <<< "$effects" >> "$SUMMARY"
  fi
  mbox --arg reason "$reason" --argjson dispatched "$DISPATCHED" --argjson merged "$MERGED" --argjson researched "$RESEARCHED" \
    --argjson repositories "${effects:-[]}" --argjson cost "${TOTAL_COST:-0}" --argjson costTracked "$COST_SUPPORTED" --arg ts "$(date +%H:%M:%S)" \
    '{event:"finished",reason:$reason,dispatched:$dispatched,merged:$merged,researched:$researched,repositories:$repositories,total_cost:(if $costTracked==1 then $cost else null end),ts:$ts}'
  say "cook-epic finished: $reason (dispatched=$DISPATCHED merged=$MERGED researched=$RESEARCHED)"
}

# Live worker-cap control: an operator can widen or narrow a running pool by
# writing a positive integer to $RUN_DIR/WORKERS; the loop re-reads it each
# tick. Malformed content is ignored with one logged warning per change.
# Sequential runs stay pinned to one worker.
DYN_WORKERS_LAST=''
reload_worker_cap() {
  local raw cap
  [ -f "$RUN_DIR/WORKERS" ] || return 0
  raw=$(tr -d '[:space:]' < "$RUN_DIR/WORKERS" 2>/dev/null) || return 0
  [ "$raw" != "$DYN_WORKERS_LAST" ] || return 0
  DYN_WORKERS_LAST="$raw"
  if [[ "$raw" =~ ^[0-9]+$ ]]; then
    cap="$raw"
    [ "$cap" -ge 1 ] || cap=1
    [ "$SEQUENTIAL" != 1 ] || cap=1
    if [ "$cap" -ne "$WORKERS" ]; then
      WORKERS="$cap"
      say "worker cap set to $WORKERS from $RUN_DIR/WORKERS"
      mbox --argjson workers "$WORKERS" --arg ts "$(date +%H:%M:%S)" \
        '{event:"worker-cap",workers:$workers,ts:$ts}'
    fi
  else
    say "WARNING: ignoring malformed worker cap in $RUN_DIR/WORKERS: '$raw'"
  fi
}

if [ "$SEQUENTIAL" = 1 ]; then
  MODE_DESC="sequential(siblings:${SIBLINGS[*]:-none})"
elif [ "$LAYOUT_MODE" -eq 1 ]; then
  MODE_DESC="parallel:$WORKERS(siblings:${SIBLINGS[*]})"
else
  MODE_DESC="parallel:$WORKERS"
fi
say "cook-epic start: epic=$EPIC harness=$HARNESS mode=$MODE_DESC base=$BASE_BRANCH gate='${GATE:-none}' timeout=${WORKER_TIMEOUT:-none} idle-threshold=${IDLE_THRESHOLD}s inspector-timeout=${INSPECTOR_TIMEOUT}s attempts=$MAX_ATTEMPTS push=$PUSH_ENABLED cgroup=$([ "$SCOPE_OK" -eq 1 ] && echo "cook-epic.slice cpu=$CPU_WEIGHT io=$IO_WEIGHT mem-high=$MEMORY_HIGH" || echo nice-fallback)"

# Populate the shared system-prompt cache prefix before the first dispatch
# wave (dispatches are only SPAWN_DELAY apart) so early parallel workers land
# a cache hit instead of racing to be first. Same flag/model shape as workers
# or the prefix won't match. HARNESS is forced to worker-cmd whenever
# COOKEPIC_WORKER_CMD is set (see line 313), so this never invokes claude
# under the test hook.
if [ "$HARNESS" = claude ] || [ "$HARNESS" = ccx ]; then
  if [ -z "${ENABLE_PROMPT_CACHING_1H+x}" ]; then
    export ENABLE_PROMPT_CACHING_1H=1
  fi
  timeout 120 "$AGENT_BIN" -p --permission-mode "$PERM_MODE" --output-format json \
    --exclude-dynamic-system-prompt-sections --model "${ACTIVE_MODEL:-sonnet}" \
    -- 'Reply with exactly: ok' >>"$LOG" 2>&1 \
    || say 'WARNING: cache warm-up failed; continuing'
fi

TICK="$SUPERVISION_TICK"
while true; do
  [ -e "$RUN_DIR/STOP" ] && [ "$STOPPING" -eq 0 ] && { STOPPING=1; STOP_REASON='STOP file'; say 'STOP file found — draining'; }
  reload_worker_cap

  supervise_workers
  reap_finished
  apply_provider_fallback
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
  if [ "$STOPPING" -eq 0 ] && [ "$FALLBACK_PENDING" -eq 0 ] && [ "$DISPATCHED" -lt "$MAX_DISPATCHES" ]; then
    if [ -n "$BUDGET" ] && [ "$COST_SUPPORTED" -eq 1 ] \
      && jq -en --argjson spent "$TOTAL_COST" --argjson budget "$BUDGET" '$spent >= $budget' >/dev/null; then
      # Keep the amount out of STOP_REASON: it lands in the mailbox and is
      # rendered into the chat transcript. The run log carries the detail.
      STOPPING=1; STOP_REASON="budget cap reached"
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
