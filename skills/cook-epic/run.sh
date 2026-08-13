#!/usr/bin/env bash
# cook-epic run — compatibility shim over the shared epic core.
#
# Validates the invocation, detects the invoking harness, resolves the t3
# entrypoint, maps the COOKEPIC_* environment onto the shared run config, and
# execs `t3 epic cook`. All coordination lives in packages/epic-core; this
# script contains none.
#
# Usage: run.sh <run-dir>          # launch from the project root
#
# Supported environment, mapped onto the run config (prefer the committed
# .t3code/epic-run.json; the env layer is deprecated):
#   COOKEPIC_EPIC              beads epic id (REQUIRED)
#   COOKEPIC_HARNESS           auto, prime, kimi, claude, ccx, codex, or opencode (default auto)
#   COOKEPIC_GATE              integration gate command       -> gate.command
#   COOKEPIC_NO_GATE           1 = land unverified            -> gate.disabled
#   COOKEPIC_NO_PUSH           1 = land without pushing       -> vcs.noPush
#   COOKEPIC_SIBLINGS         space-separated sibling repos  -> parallel.siblings
#   COOKEPIC_WORKERS          parallel worker count          -> parallel.workers
#   COOKEPIC_MAX_DISPATCHES    global spawn cap               -> limits.maxIterations
#   COOKEPIC_MAX_ATTEMPTS      attempts per child             -> limits.maxAttemptsPerChild
#   COOKEPIC_WORKER_TIMEOUT    worker timeout, seconds        -> supervision.workerTimeoutSeconds
#   COOKEPIC_STOP_GRACE        TERM-to-KILL grace, seconds    -> supervision.stopGraceSeconds
#   COOKEPIC_MODEL             harness model override         -> provider.modelSelection
#   COOKEPIC_PERMISSION_MODE   auto or bypassPermissions      -> runtime.mode
#   COOKEPIC_ORIENTATION_FILE  orientation card path          -> orientation.file
#   COOKEPIC_BIN               harness binary override
#   COOKEPIC_WORKER_CMD        test hook: run this instead of a harness
#   COOKEPIC_T3_BIN            t3 entrypoint override
#   COOKEPIC_SEQUENTIAL        1 = force one worker in the base checkout -> execution.sequential
# Unset means the parallel pool loop at the shared default of three workers
# (per-worker worktrees, merge queue). COOKEPIC_SEQUENTIAL=1 and
# COOKEPIC_WORKERS=1 are the two escapes to one worker in the base checkout.
# Every other COOKEPIC_* knob refuses to start, loudly.
# docs/epic-runs-rollout.md lists each dropped knob and its reason.
#
# loop.log, mailbox.jsonl, summary.md, and the STOP control file keep their
# exact meanings from the retired Bash coordinator.
set -uo pipefail

RUN_DIR="${1:?usage: run.sh <run-dir>}"
mkdir -p "$RUN_DIR"
RUN_DIR="$(cd "$RUN_DIR" && pwd -P)"
LOG="$RUN_DIR/loop.log"
MAILBOX="$RUN_DIR/mailbox.jsonl"
SUMMARY="$RUN_DIR/summary.md"
SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

fail() { # <message> <help>
  printf 'error: %s\nhelp: %s\n' "$1" "$2" >&2
  exit 2
}

for name in COOKEPIC_BUDGET_USD \
  COOKEPIC_IDLE_THRESHOLD COOKEPIC_INSPECTOR_TIMEOUT \
  COOKEPIC_INSPECT_RETRY_DELAY COOKEPIC_INSPECT_MIN_DELAY \
  COOKEPIC_INSPECT_MAX_DELAY COOKEPIC_RATE_LIMIT_BACKOFF \
  COOKEPIC_CPU_WEIGHT COOKEPIC_IO_WEIGHT COOKEPIC_MEMORY_HIGH \
  COOKEPIC_DISABLE_SYSTEMD COOKEPIC_SPAWN_DELAY COOKEPIC_SUPERVISION_TICK \
  COOKEPIC_INSPECTOR_CMD COOKEPIC_FOLD_CMD COOKEPIC_CLOCK_CMD \
  COOKEPIC_RESOURCE_SAMPLER_CMD COOKEPIC_WORKER_ACTIVE_CMD \
  COOKEPIC_WORKER_STOP_CMD COOKEPIC_PROCESS_START_TICKS_CMD COOKEPIC_PUSH_CMD \
  COOKEPIC_WORKER_ARTIFACT_BYTES COOKEPIC_INSPECTOR_RESULT_BYTES \
  COOKEPIC_INSPECTOR_LOG_BYTES COOKEPIC_REPO_EVIDENCE_BYTES \
  COOKEPIC_REPO_PROBE_INTERVAL COOKEPIC_REPO_PROBE_TIMEOUT COOKEPIC_FOLD_TIMEOUT \
  RUNLOCK_HEARTBEAT_SECS RUNLOCK_STALE_SECS OPENCODE_BIN; do
  if [[ -v $name && -n ${!name} ]]; then
    fail "$name is not supported by the shared core" \
      "unset $name (see docs/epic-runs-rollout.md)"
  fi
done

[ -n "${COOKEPIC_EPIC:-}" ] || fail 'COOKEPIC_EPIC is required' 'set it to the beads epic id'
if [[ -v COOKEPIC_SEQUENTIAL && -n ${COOKEPIC_SEQUENTIAL} && ${COOKEPIC_SEQUENTIAL} != 1 ]]; then
  fail 'COOKEPIC_SEQUENTIAL must be 1 or unset' \
    'set COOKEPIC_SEQUENTIAL=1 to force sequential execution, or unset it'
fi
if [[ -v COOKEPIC_WORKERS && -n ${COOKEPIC_WORKERS} ]]; then
  [[ ${COOKEPIC_WORKERS} =~ ^[1-9][0-9]*$ ]] \
    || fail "COOKEPIC_WORKERS must be a positive integer, got '${COOKEPIC_WORKERS}'" \
      'set COOKEPIC_WORKERS to a positive integer or unset it'
  if [[ -v COOKEPIC_SEQUENTIAL && -n ${COOKEPIC_SEQUENTIAL} && ${COOKEPIC_WORKERS} -gt 1 ]]; then
    fail 'COOKEPIC_SEQUENTIAL=1 contradicts COOKEPIC_WORKERS>1' \
      'unset COOKEPIC_SEQUENTIAL for parallel execution, or unset COOKEPIC_WORKERS for sequential'
  fi
fi
if [[ -v COOKEPIC_NO_PUSH && -n ${COOKEPIC_NO_PUSH} && ${COOKEPIC_NO_PUSH} != 1 ]]; then
  fail 'COOKEPIC_NO_PUSH must be exactly 1 when set' \
    'unset it to enable pushes, or set COOKEPIC_NO_PUSH=1 for local-only landing'
fi
if [[ -v COOKEPIC_PERMISSION_MODE && -n ${COOKEPIC_PERMISSION_MODE} ]] \
  && [ "${COOKEPIC_PERMISSION_MODE}" != auto ] \
  && [ "${COOKEPIC_PERMISSION_MODE}" != bypassPermissions ]; then
  fail "unsupported COOKEPIC_PERMISSION_MODE $COOKEPIC_PERMISSION_MODE" 'use auto or bypassPermissions'
fi
if [[ -v COOKEPIC_HARNESS && -n ${COOKEPIC_HARNESS} && -z ${COOKEPIC_WORKER_CMD:-} ]]; then
  case "$COOKEPIC_HARNESS" in
    auto|prime|kimi|claude|ccx|codex|opencode) ;;
    *) fail "invalid COOKEPIC_HARNESS $COOKEPIC_HARNESS" \
      'use auto, prime, kimi, claude, ccx, codex, or opencode' ;;
  esac
fi

# The Bash coordinator treats empty values as unset through ${name:-default}.
for name in COOKEPIC_T3_BIN COOKEPIC_GATE COOKEPIC_NO_GATE COOKEPIC_NO_PUSH \
  COOKEPIC_MAX_DISPATCHES COOKEPIC_MAX_ATTEMPTS COOKEPIC_WORKER_TIMEOUT \
  COOKEPIC_STOP_GRACE COOKEPIC_MODEL COOKEPIC_ORIENTATION_FILE \
  COOKEPIC_HARNESS COOKEPIC_BIN COOKEPIC_WORKER_CMD COOKEPIC_PERMISSION_MODE \
  COOKEPIC_SEQUENTIAL COOKEPIC_WORKERS COOKEPIC_SIBLINGS; do
  if [[ -v $name && -z ${!name} ]]; then unset "$name"; fi
done

detect_ccx_environment() {
  [[ "${ANTHROPIC_BASE_URL:-}" =~ ^http://(localhost|127(\.[0-9]{1,3}){3}|\[::1\])(:[0-9]+)?(/.*)?$ ]] \
    && [ "${ANTHROPIC_AUTH_TOKEN:-}" = unused ] \
    && [[ "${ANTHROPIC_MODEL:-}" == *'[1m]' ]]
}

# The core cannot inspect its invoking parent process; detection stays in bash.
detect_harness() {
  [ -z "${COOKEPIC_WORKER_CMD:-}" ] || { printf 'worker-cmd\n'; return; }
  case "${COOKEPIC_HARNESS:-auto}" in
    prime|kimi|claude|codex|opencode) printf '%s\n' "$COOKEPIC_HARNESS"; return ;;
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
      prime-agent|prime-agent-*) printf 'prime\n'; return ;;
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

if COOKEPIC_HARNESS=$(detect_harness); then
  harness_status=0
else
  harness_status=$?
fi
case "$harness_status" in
  0) export COOKEPIC_HARNESS ;;
  2) fail "invalid COOKEPIC_HARNESS ${COOKEPIC_HARNESS:-}" \
    'use auto, prime, kimi, claude, ccx, codex, or opencode' ;;
  3) fail 'COOKEPIC_HARNESS=ccx requires the inherited ccx proxy environment' 'launch from ccx' ;;
  *) fail 'could not identify the invoking harness' \
    'set COOKEPIC_HARNESS to prime, kimi, claude, ccx, codex, or opencode' ;;
esac

# First hit wins: $COOKEPIC_T3_BIN, t3 on PATH, the built server CLI, then the
# server CLI from source (Node 24 strips types). Resolve the checkout through
# the physical path: the installed skill is a symlink into the repository.
checkout="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
if [ -n "${COOKEPIC_T3_BIN:-}" ] \
  && candidate=$(command -v -- "$COOKEPIC_T3_BIN" 2>/dev/null); then
  core_command=("$candidate")
elif candidate=$(command -v t3 2>/dev/null); then
  core_command=("$candidate")
elif [ -f "$checkout/apps/server/dist/bin.mjs" ]; then
  core_command=(node "$checkout/apps/server/dist/bin.mjs")
elif [ -f "$checkout/apps/server/src/bin.ts" ]; then
  core_command=(node "$checkout/apps/server/src/bin.ts")
else
  fail "could not resolve t3 from COOKEPIC_T3_BIN, t3 on PATH, $checkout/apps/server/dist/bin.mjs, or $checkout/apps/server/src/bin.ts" \
    'set COOKEPIC_T3_BIN to a t3 entrypoint'
fi

printf 'note: run.sh and the COOKEPIC_* environment are deprecated; prefer .t3code/epic-run.json plus: %s epic cook --epic %s --cwd %s --run-dir %s\n' \
  "${core_command[*]}" "$COOKEPIC_EPIC" "$(pwd -P)" "$RUN_DIR" >&2
: > "$LOG"; : > "$MAILBOX"; : > "$SUMMARY"
exec "${core_command[@]}" epic cook --epic "$COOKEPIC_EPIC" \
  --cwd "$(pwd -P)" --run-dir "$RUN_DIR"
fail 'failed to exec the resolved t3 entrypoint' 'check that the resolved path is executable'
