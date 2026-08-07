#!/usr/bin/env bash
# Parallel-mode sibling layout regressions: mirrored worker layouts, set
# landing (all-or-nothing), gate-failure parking of the whole set, and the
# dynamic $RUN_DIR/WORKERS cap. No live agent session — every worker is a
# fixture script via COOKEPIC_WORKER_CMD.
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNNER="$SKILL_DIR/run-legacy.sh" # legacy engine: the shim (run.sh) execs the shared core by default
TMP_ROOT="$(cd "$(mktemp -d /var/tmp/cook-epic-parallel-siblings-test.XXXXXX)" && pwd -P)"
trap '[ "${COOKEPIC_KEEP_TEST_TMP:-0}" = 1 ] || rm -rf "$TMP_ROOT"' EXIT

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
assert_contains() { grep -Fq -- "$2" "$1" || fail "expected $1 to contain: $2"; }
assert_not_contains() { ! grep -Fq -- "$2" "$1" || fail "expected $1 not to contain: $2"; }
assert_branch_gone() { # <repo> <branch>
  git -C "$1" show-ref --verify --quiet "refs/heads/$2" && fail "branch $2 survived in $1" || true
}

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

# Multi-child fake bd with `create` support (park_branch files Merge fix
# children through it). Children live in $state/children, one id per line,
# with <id>-status and <id>-title files beside it.
make_bd() {
  local bin="$1"
  mkdir -p "$bin"
  cat > "$bin/bd" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
state="${FAKE_BD_STATE:?}"
cmd="$1"; shift || true
case "$cmd" in
  show)
    id="$1"
    if [ "$id" = epic ]; then
      printf '{"id":"epic","status":"open","title":"Epic","issue_type":"epic","assignee":"","comment_count":0}\n'
    else
      printf '{"id":"%s","status":"%s","title":"%s","issue_type":"task","assignee":"%s","comment_count":0}\n' \
        "$id" "$(<"$state/$id-status")" "$(<"$state/$id-title")" "$(cat "$state/$id-assignee" 2>/dev/null || true)"
    fi
    ;;
  ready)
    printf '['
    first=1
    while read -r id; do
      [ -n "$id" ] || continue
      [ "$(<"$state/$id-status")" = open ] || continue
      [ "$first" = 1 ] || printf ','
      printf '{"id":"%s","title":"%s"}' "$id" "$(<"$state/$id-title")"
      first=0
    done < "$state/children"
    printf ']\n'
    ;;
  list)
    printf '['
    first=1
    while read -r id; do
      [ -n "$id" ] || continue
      status=$(<"$state/$id-status")
      [ "$status" = closed ] && continue
      [ "$first" = 1 ] || printf ','
      printf '{"id":"%s","status":"%s"}' "$id" "$status"
      first=0
    done < "$state/children"
    printf ']\n'
    ;;
  update)
    id="$1"; shift
    case " $* " in
      *' --assignee '*) args=("$@"); for ((i=0;i<${#args[@]};i++)); do [ "${args[$i]}" = --assignee ] && printf '%s' "${args[$((i+1))]}" > "$state/$id-assignee"; done ;;
      *' --claim '*|*' --status open '*) printf open > "$state/$id-status" ;;
      *' --status blocked '*) printf blocked > "$state/$id-status" ;;
    esac
    ;;
  close) printf closed > "$state/$1-status" ;;
  create)
    title="$1"
    n=$(cat "$state/create-count" 2>/dev/null || echo 0); n=$((n + 1)); printf '%s' "$n" > "$state/create-count"
    id="mf$n"
    printf '%s\n' "$id" >> "$state/children"
    printf open > "$state/$id-status"
    printf '%s' "$title" > "$state/$id-title"
    printf '== create %s ==\n%s\n' "$id" "$*" >> "$state/created"
    printf '{"id":"%s"}\n' "$id"
    ;;
  label) ;;
  merge-slot|swarm|note|comment) ;;
esac
EOF
  chmod +x "$bin/bd"
}

new_case() { # <name> -> sets CASE REPO SIB STATE BIN RUN
  CASE="$TMP_ROOT/$1"; REPO="$CASE/repo"; SIB="$CASE/api"; STATE="$CASE/state"; BIN="$CASE/bin"; RUN="$CASE/run"
  mkdir -p "$STATE" "$RUN"
  make_repo "$REPO"
  make_repo "$SIB"
  make_bd "$BIN"
}

seed_child() { # <id> <title>
  printf '%s\n' "$1" >> "$STATE/children"
  printf open > "$STATE/$1-status"
  printf '%s' "$2" > "$STATE/$1-title"
}

launch() { # <extra env...> — later vars override the defaults
  local rc=0
  (
    cd "$REPO"
    for v in "${!COOKEPIC_@}"; do unset "$v"; done
    env PATH="$BIN:$PATH" FAKE_BD_STATE="$STATE" COOKEPIC_EPIC=epic COOKEPIC_HARNESS=claude \
      COOKEPIC_WORKER_CMD="$CASE/worker.sh" COOKEPIC_SIBLINGS="${CASE_SIBLINGS:-../api}" \
      COOKEPIC_GATE=true COOKEPIC_NO_PUSH=1 COOKEPIC_SPAWN_DELAY=0 COOKEPIC_SUPERVISION_TICK=1 \
      COOKEPIC_MAX_DISPATCHES=4 COOKEPIC_MAX_ATTEMPTS=2 COOKEPIC_WORKER_TIMEOUT=60 \
      "$@" "$RUNNER" "$RUN"
  ) > "$CASE/stdout" 2>&1 || rc=$?
  printf '%s' "$rc" > "$CASE/rc"
}

# ------------------- (a) child commits in BOTH repos and lands in both ----
new_case both-repos
seed_child a 'Cross-repo child'
git -C "$REPO" remote add origin test://main
git -C "$SIB" remote add origin test://api
cat > "$CASE/push.sh" <<'EOF'
#!/usr/bin/env bash
printf '%s %s\n' "$1" "${*:2}" >> "${COOKEPIC_PUSH_LOG:?}"
EOF
chmod +x "$CASE/push.sh"
cat > "$CASE/worker.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
pwd > "$COOKEPIC_RUN_DIR/worker-cwd"
git -C ../api rev-parse --show-toplevel > "$COOKEPIC_RUN_DIR/sibling-toplevel"
printf 'main work\n' > main-work.txt
git add main-work.txt && git commit -qm 'main work'
printf 'api work\n' > ../api/api-work.txt
git -C ../api add api-work.txt && git -C ../api commit -qm 'api work'
bd close "$COOKEPIC_CHILD"
EOF
chmod +x "$CASE/worker.sh"
# The gate references the sibling RELATIVELY: it can only pass when the
# integration layout mirrors the sibling trial merge beside the main worktree.
launch COOKEPIC_NO_PUSH= COOKEPIC_PUSH_CMD="$CASE/push.sh" COOKEPIC_PUSH_LOG="$RUN/pushes" \
  COOKEPIC_GATE='test -f main-work.txt && test -f ../api/api-work.txt'
[ "$(<"$CASE/rc")" -eq 0 ] || fail "both-repos run exited $(<"$CASE/rc")"
[ "$(<"$RUN/worker-cwd")" = "$RUN/layouts/a/repo" ] || fail "worker ran outside its layout: $(<"$RUN/worker-cwd")"
[ "$(<"$RUN/sibling-toplevel")" = "$RUN/layouts/a/api" ] || fail "../api resolved outside the layout: $(<"$RUN/sibling-toplevel")"
git -C "$REPO" log --format=%s | grep -Fq 'main work' || fail 'main repo did not land the main commit'
git -C "$SIB" log --format=%s | grep -Fq 'api work' || fail 'sibling repo did not land the sibling commit'
assert_contains "$RUN/mailbox.jsonl" '"event": "merged"'
assert_contains "$RUN/mailbox.jsonl" '"repositories":'
assert_contains "$RUN/mailbox.jsonl" "\"repo\": \"$SIB\""
assert_contains "$RUN/pushes" "$REPO origin main"
assert_contains "$RUN/pushes" "$SIB origin main"
assert_contains "$RUN/summary.md" 'Repository landing effects'
assert_contains "$RUN/summary.md" "$SIB"
assert_contains "$RUN/loop.log" 'gated, pushed, landed'
assert_contains "$RUN/loop.log" 'epic complete'
assert_branch_gone "$REPO" epic/a
assert_branch_gone "$SIB" epic/a
[ "$(git -C "$SIB" worktree list | wc -l)" -eq 1 ] || fail 'sibling worktrees leaked after the run'
[ "$(git -C "$REPO" worktree list | wc -l)" -eq 1 ] || fail 'main worktrees leaked after the run'

# ------------------------------- (b) child commits ONLY in the sibling ----
new_case sibling-only
seed_child a 'Sibling-only child'
cat > "$CASE/worker.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'api only\n' > ../api/api-only.txt
git -C ../api add api-only.txt && git -C ../api commit -qm 'api only'
bd close "$COOKEPIC_CHILD"
EOF
chmod +x "$CASE/worker.sh"
main_head_before=$(git -C "$REPO" rev-parse HEAD)
launch
[ "$(<"$CASE/rc")" -eq 0 ] || fail "sibling-only run exited $(<"$CASE/rc")"
[ "$(git -C "$REPO" rev-parse HEAD)" = "$main_head_before" ] || fail 'sibling-only child moved the main repo'
git -C "$SIB" log --format=%s | grep -Fq 'api only' || fail 'sibling repo did not land the sibling-only commit'
assert_contains "$RUN/mailbox.jsonl" '"event": "merged"'
assert_contains "$RUN/mailbox.jsonl" "\"repo\": \"$SIB\""
assert_contains "$RUN/summary.md" "$SIB"
assert_not_contains "$RUN/summary.md" "\`$REPO\`:"
assert_branch_gone "$REPO" epic/a
assert_branch_gone "$SIB" epic/a

# ------- (c) a gate failure parks the WHOLE set; merge-fix re-lands it ----
new_case gate-parks-set
seed_child a 'Cross-repo child'
cat > "$CASE/worker.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [ "$COOKEPIC_CHILD" = a ]; then
  printf 'main gate\n' > main-gate.txt
  git add main-gate.txt && git commit -qm 'main gate work'
  printf 'api gate\n' > ../api/api-gate.txt
  git -C ../api add api-gate.txt && git -C ../api commit -qm 'api gate work'
else
  # Merge-fix child: the branches are already sound; the gate flake cleared.
  git rev-parse --abbrev-ref HEAD > "$COOKEPIC_RUN_DIR/mergefix-branch"
  git -C ../api rev-parse --abbrev-ref HEAD > "$COOKEPIC_RUN_DIR/mergefix-sibling-branch"
fi
bd close "$COOKEPIC_CHILD"
EOF
chmod +x "$CASE/worker.sh"
launch COOKEPIC_GATE="test -f '$RUN/gate-passed' || { touch '$RUN/gate-passed'; exit 1; }"
[ "$(<"$CASE/rc")" -eq 0 ] || fail "gate-parks-set run exited $(<"$CASE/rc")"
assert_contains "$RUN/mailbox.jsonl" '"event": "parked"'
assert_contains "$RUN/mailbox.jsonl" '"reason": "gate-failed"'
assert_contains "$STATE/created" 'Merge fix: land epic/a (gate-failed)'
assert_contains "$STATE/created" "$REPO"
assert_contains "$STATE/created" "sibling \`$SIB\`"
# The merge-fix worker must have landed in a layout with BOTH repos on the set branch.
[ "$(<"$RUN/mergefix-branch")" = epic/a ] || fail 'merge-fix worker was not on the parked branch'
[ "$(<"$RUN/mergefix-sibling-branch")" = epic/a ] || fail 'merge-fix sibling worktree was not on the parked branch'
assert_contains "$RUN/mailbox.jsonl" '"event": "merged"'
git -C "$REPO" log --format=%s | grep -Fq 'main gate work' || fail 'main repo did not land after the merge fix'
git -C "$SIB" log --format=%s | grep -Fq 'api gate work' || fail 'sibling repo did not land after the merge fix'
parked_line=$(grep -n '"event": "parked"' "$RUN/mailbox.jsonl" | head -1 | cut -d: -f1)
merged_line=$(grep -n '"event": "merged"' "$RUN/mailbox.jsonl" | head -1 | cut -d: -f1)
[ "$parked_line" -lt "$merged_line" ] || fail 'set landed before it was parked'
assert_branch_gone "$REPO" epic/a
assert_branch_gone "$SIB" epic/a

# --------------------------- (d) dynamic $RUN_DIR/WORKERS cap re-read ----
new_case dynamic-cap
seed_child a 'Child a'
seed_child b 'Child b'
cat > "$CASE/worker.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [ "$COOKEPIC_CHILD" = a ]; then
  printf '2' > "$COOKEPIC_RUN_DIR/WORKERS"
  deadline=$((SECONDS + 20))
  until grep -q '"child": "b"' "$COOKEPIC_RUN_DIR/mailbox.jsonl" 2>/dev/null; do
    [ "$SECONDS" -lt "$deadline" ] || break
    sleep 0.2
  done
  printf 'a\n' > a.txt; git add a.txt; git commit -qm 'a work'
else
  printf 'banana' > "$COOKEPIC_RUN_DIR/WORKERS"
  sleep 3
  printf 'b\n' > b.txt; git add b.txt; git commit -qm 'b work'
fi
bd close "$COOKEPIC_CHILD"
EOF
chmod +x "$CASE/worker.sh"
launch COOKEPIC_WORKERS=1
[ "$(<"$CASE/rc")" -eq 0 ] || fail "dynamic-cap run exited $(<"$CASE/rc")"
assert_contains "$RUN/loop.log" 'worker cap set to 2'
[ "$(grep -c 'ignoring malformed worker cap' "$RUN/loop.log")" -eq 1 ] \
  || fail 'malformed worker cap did not produce exactly one warning'
jq -r '.event + ":" + (.child // "-")' "$RUN/mailbox.jsonl" > "$CASE/sequence"
dispatched_b=$(grep -n '^dispatched:b$' "$CASE/sequence" | head -1 | cut -d: -f1)
done_a=$(grep -n '^done:a$' "$CASE/sequence" | head -1 | cut -d: -f1)
[ -n "$dispatched_b" ] || fail 'child b never dispatched'
[ -n "$done_a" ] || fail 'child a never completed'
[ "$dispatched_b" -lt "$done_a" ] || fail 'live cap widening did not dispatch b while a was still running'
git -C "$REPO" log --format=%s | grep -Fq 'a work' || fail 'child a did not land'
git -C "$REPO" log --format=%s | grep -Fq 'b work' || fail 'child b did not land'

# ------------- preflight: push mode requires origin in EVERY sibling ----
new_case sibling-origin-preflight
seed_child a 'Child'
git -C "$REPO" remote add origin test://main
printf '#!/usr/bin/env bash\ntrue\n' > "$CASE/worker.sh"
chmod +x "$CASE/worker.sh"
launch COOKEPIC_NO_PUSH=
[ "$(<"$CASE/rc")" -eq 2 ] || fail "sibling-origin preflight exited $(<"$CASE/rc") instead of 2"
assert_contains "$CASE/stdout" 'has no origin remote'

# ------------- preflight: a sibling that cannot be mirrored fails fast ----
CASE="$TMP_ROOT/unmirrorable"; REPO="$CASE/nest/repo"; SIB="$CASE/api"; STATE="$CASE/state"; BIN="$CASE/bin"; RUN="$CASE/run"
mkdir -p "$STATE" "$RUN"
make_repo "$REPO"
make_repo "$SIB"
make_bd "$BIN"
seed_child a 'Child'
printf '#!/usr/bin/env bash\ntrue\n' > "$CASE/worker.sh"
chmod +x "$CASE/worker.sh"
CASE_SIBLINGS='../../api' launch
[ "$(<"$CASE/rc")" -eq 2 ] || fail "unmirrorable preflight exited $(<"$CASE/rc") instead of 2"
assert_contains "$CASE/stdout" 'escapes the worker layout root'

printf 'cook-epic parallel-siblings regression tests passed\n'
