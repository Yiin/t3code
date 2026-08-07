#!/usr/bin/env bash
# Coordinator fold: a landed child whose epic notes gained DECISION:/GOTCHA:
# lines since its dispatch triggers a one-shot fold agent; a landed child
# without markers spawns none. Sequential mode only (fold's landing hook is
# identical in the parallel merge-queue path; sequential is enough to cover
# the fold_epic_notes() logic itself without the extra worktree/merge machinery).
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNNER="$SKILL_DIR/run-legacy.sh" # legacy engine: the shim (run.sh) execs the shared core by default
TMP_ROOT="$(mktemp -d /var/tmp/cook-epic-fold-test.XXXXXX)"
trap 'rm -rf "$TMP_ROOT"' EXIT

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
assert_contains() { grep -Fq -- "$2" "$1" || { printf -- '--- %s ---\n' "$1" >&2; cat "$1" >&2; fail "expected $1 to contain: $2"; }; }
assert_not_contains() { ! grep -Fq -- "$2" "$1" || { printf -- '--- %s ---\n' "$1" >&2; cat "$1" >&2; fail "expected $1 not to contain: $2"; }; }

make_repo() {
  local repo="$1"
  mkdir -p "$repo/.beads"
  git init -q -b main "$repo"
  git -C "$repo" config user.name test
  git -C "$repo" config user.email test@example.com
  printf 'base\n' > "$repo/base.txt"
  git -C "$repo" add .
  git -C "$repo" commit -qm base
}

# Fake bd: tracks one epic (description + notes) and one child (status) as
# flat files under FAKE_BD_STATE. `update epic --body-file` and `note epic`
# are the two entry points the fold feature depends on.
make_bd() {
  local bin="$1"
  mkdir -p "$bin"
  cat > "$bin/bd" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
state="${FAKE_BD_STATE:?}"; cmd="${1:-}"; shift || true
case "$cmd" in
  show)
    id="$1"
    if [ "$id" = epic ]; then
      jq -cn --arg status "$(<"$state/epic")" \
        --arg desc "$(cat "$state/epic-description" 2>/dev/null || true)" \
        --arg notes "$(cat "$state/epic-notes" 2>/dev/null || true)" \
        '{id:"epic",status:$status,title:"Epic",issue_type:"epic",comment_count:0,description:$desc,notes:$notes}'
    else
      printf '{"id":"child","status":"%s","title":"Fold child","issue_type":"task","assignee":"%s","comment_count":0}\n' \
        "$(<"$state/child")" "$(cat "$state/assignee" 2>/dev/null || true)"
    fi
    ;;
  ready) [ "$(<"$state/child")" = open ] && printf '[{"id":"child","title":"Fold child"}]\n' || printf '[]\n' ;;
  list) [ "$(<"$state/child")" = closed ] && printf '[]\n' || printf '[{"id":"child","status":"%s"}]\n' "$(<"$state/child")" ;;
  update)
    id="$1"; shift
    args=("$@")
    for ((i = 0; i < ${#args[@]}; i++)); do
      if [ "${args[$i]}" = --body-file ] && [ "$id" = epic ]; then
        cat "${args[$((i+1))]}" > "$state/epic-description"
      fi
      [ "${args[$i]}" = --assignee ] && printf '%s' "${args[$((i+1))]}" > "$state/assignee"
    done
    case " $* " in
      *' --claim '*|*' --status open '*) printf open > "$state/$id" ;;
    esac
    ;;
  close) printf closed > "$state/$1" ;;
  note)
    id="$1"; shift
    [ "$id" = epic ] || exit 0
    printf '%s\n' "$1" >> "$state/epic-notes"
    ;;
  merge-slot|swarm|label|comment) ;;
esac
EOF
  chmod +x "$bin/bd"
}

make_case() { # <name> <worker body> <fold body>
  local name="$1" worker_body="$2" fold_body="$3"
  CASE_ROOT="$TMP_ROOT/$name"
  CASE_REPO="$CASE_ROOT/repo"
  CASE_STATE="$CASE_ROOT/state"
  CASE_BIN="$CASE_ROOT/bin"
  CASE_RUN="$CASE_ROOT/run"
  mkdir -p "$CASE_STATE" "$CASE_RUN"
  make_repo "$CASE_REPO"
  make_bd "$CASE_BIN"
  printf open > "$CASE_STATE/child"
  printf open > "$CASE_STATE/epic"
  printf '## Goal\nstays untouched\n\n## Context & architecture\n### Decisions\n- pre-existing bullet\n\n### Do not\n- pre-existing gotcha\n' \
    > "$CASE_STATE/epic-description"
  printf 'earlier unrelated note before this child was dispatched\n' > "$CASE_STATE/epic-notes"
  printf '%s\n' "$worker_body" > "$CASE_ROOT/worker.sh"
  chmod +x "$CASE_ROOT/worker.sh"
  FOLD_ARG=()
  if [ -n "$fold_body" ]; then
    printf '%s\n' "$fold_body" > "$CASE_ROOT/fold.sh"
    chmod +x "$CASE_ROOT/fold.sh"
    FOLD_ARG=(COOKEPIC_FOLD_CMD="$CASE_ROOT/fold.sh")
  fi
  RUNNER_ARGS=(env PATH="$CASE_BIN:$PATH" FAKE_BD_STATE="$CASE_STATE" \
    COOKEPIC_EPIC=epic COOKEPIC_HARNESS=claude COOKEPIC_WORKER_CMD="$CASE_ROOT/worker.sh" \
    COOKEPIC_SEQUENTIAL=1 COOKEPIC_SIBLINGS="" COOKEPIC_GATE=true COOKEPIC_NO_PUSH=1 COOKEPIC_DISABLE_SYSTEMD=1 \
    COOKEPIC_SPAWN_DELAY=0 COOKEPIC_MAX_DISPATCHES=1 COOKEPIC_MAX_ATTEMPTS=1 \
    COOKEPIC_IDLE_THRESHOLD=60 COOKEPIC_INSPECTOR_TIMEOUT=10 COOKEPIC_INSPECT_RETRY_DELAY=1 \
    COOKEPIC_INSPECT_MIN_DELAY=1 COOKEPIC_INSPECT_MAX_DELAY=2 COOKEPIC_STOP_GRACE=1 \
    COOKEPIC_SUPERVISION_TICK=1 COOKEPIC_FOLD_TIMEOUT=10 "${FOLD_ARG[@]}" "$RUNNER" "$CASE_RUN")
}

# ----------------------------------------------------- markers -> fold ----
marker_worker='#!/usr/bin/env bash
set -euo pipefail
printf "done\n" > result.txt
git add result.txt
git commit -qm done
bd note "$COOKEPIC_EPIC" "child done -- some clause. DECISION: use jq for JSON. GOTCHA: watch for nulls."
bd close "$COOKEPIC_CHILD"'
fold_agent='#!/usr/bin/env bash
set -euo pipefail
prompt="$1"
cp "$prompt" "$COOKEPIC_RUN_DIR/captured-fold-prompt"
tmp="$COOKEPIC_RUN_DIR/folded-description"
printf "## Goal\nstays untouched\n\n## Context & architecture\n### Decisions\n- pre-existing bullet\n- 2026-08-05 child: use jq for JSON\n\n### Do not\n- pre-existing gotcha\n- 2026-08-05 child: watch for nulls\n" > "$tmp"
bd update epic --body-file "$tmp"
printf "folded: ok\n"'

make_case marker-triggers-fold "$marker_worker" "$fold_agent"
(cd "$CASE_REPO" && for v in "${!COOKEPIC_@}"; do unset "$v"; done && timeout --kill-after=2s 20s "${RUNNER_ARGS[@]}") > "$CASE_ROOT/stdout" 2>&1 \
  || { cat "$CASE_ROOT/stdout" >&2; cat "$CASE_RUN/loop.log" >&2 2>/dev/null || true; fail 'marker-triggers-fold run did not finish'; }

[ -f "$CASE_RUN/captured-fold-prompt" ] || fail 'fold agent was never invoked despite DECISION:/GOTCHA: markers'
assert_contains "$CASE_RUN/captured-fold-prompt" 'DECISION: use jq for JSON'
assert_contains "$CASE_RUN/captured-fold-prompt" 'GOTCHA: watch for nulls'
# The note that predates this child's dispatch must not leak into "new" notes.
assert_not_contains "$CASE_RUN/captured-fold-prompt" 'earlier unrelated note'
assert_contains "$CASE_STATE/epic-description" '- 2026-08-05 child: use jq for JSON'
assert_contains "$CASE_STATE/epic-description" '- 2026-08-05 child: watch for nulls'
assert_contains "$CASE_RUN/mailbox.jsonl" '"event": "folded"'

# ------------------------------------------------- no markers -> no fold ----
plain_worker='#!/usr/bin/env bash
set -euo pipefail
printf "done\n" > result.txt
git add result.txt
git commit -qm done
bd note "$COOKEPIC_EPIC" "child done -- nothing worth folding here"
bd close "$COOKEPIC_CHILD"'
never_agent='#!/usr/bin/env bash
set -euo pipefail
touch "$COOKEPIC_RUN_DIR/fold-was-called"
printf "folded: ok\n"'

make_case no-markers-no-fold "$plain_worker" "$never_agent"
(cd "$CASE_REPO" && for v in "${!COOKEPIC_@}"; do unset "$v"; done && timeout --kill-after=2s 20s "${RUNNER_ARGS[@]}") > "$CASE_ROOT/stdout" 2>&1 \
  || { cat "$CASE_ROOT/stdout" >&2; cat "$CASE_RUN/loop.log" >&2 2>/dev/null || true; fail 'no-markers-no-fold run did not finish'; }

[ ! -e "$CASE_RUN/fold-was-called" ] || fail 'fold agent was spawned for a child with no DECISION:/GOTCHA: markers'
assert_not_contains "$CASE_RUN/mailbox.jsonl" '"event": "folded"'
assert_contains "$CASE_STATE/epic-description" 'pre-existing bullet'
assert_not_contains "$CASE_STATE/epic-description" '2026-08-05'

# --------------------------------------------- fold failure is non-fatal ----
failing_agent='#!/usr/bin/env bash
exit 1'
make_case fold-failure-non-fatal "$marker_worker" "$failing_agent"
(cd "$CASE_REPO" && for v in "${!COOKEPIC_@}"; do unset "$v"; done && timeout --kill-after=2s 20s "${RUNNER_ARGS[@]}") > "$CASE_ROOT/stdout" 2>&1 \
  || { cat "$CASE_ROOT/stdout" >&2; cat "$CASE_RUN/loop.log" >&2 2>/dev/null || true; fail 'fold-failure-non-fatal run did not finish'; }

assert_contains "$CASE_RUN/loop.log" 'fold skipped for child'
assert_not_contains "$CASE_RUN/mailbox.jsonl" '"event": "folded"'
# The child itself still landed even though its fold failed.
assert_contains "$CASE_RUN/mailbox.jsonl" '"event": "done"'
assert_contains "$CASE_STATE/epic-description" 'pre-existing bullet'

printf 'cook-epic fold regression tests passed\n'
