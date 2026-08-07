#!/usr/bin/env bash
# Dispatch-time orientation injection regressions (yiin-n7j.3): the epic's
# description is spliced into every worker prompt as "Epic context (resolved
# at dispatch)" verbatim — pipes, ampersands, and multi-line markdown intact,
# never mangled by render_prompt's single-line sed pass, and never polluted
# by the epic's (potentially huge) append-only notes. The orientation card is
# read fresh from the worktree. Both templates drop the "bd show the epic"
# primary-orientation step and the body-file fold instruction in favor of
# capped DECISION:/GOTCHA: close-out markers.
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNNER="$SKILL_DIR/run-legacy.sh" # legacy engine: the shim (run.sh) execs the shared core by default
TMP_ROOT="$(mktemp -d)"
trap '[ "${COOKEPIC_KEEP_TEST_TMP:-0}" = 1 ] || rm -rf "$TMP_ROOT"' EXIT

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
assert_contains() { grep -Fq -- "$2" "$1" || fail "expected $1 to contain: $2"; }
assert_not_contains() { ! grep -Fq -- "$2" "$1" || fail "expected $1 not to contain: $2"; }

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

# Fake bd: `show epic --json` returns a description read from
# $FAKE_EPIC_DESC_FILE (raw, may contain pipes/ampersands/newlines) and a
# notes field from $FAKE_EPIC_NOTES_FILE that must NEVER reach a prompt.
make_fake_tools() {
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
      jq -n --rawfile description "${FAKE_EPIC_DESC_FILE:?}" --rawfile notes "${FAKE_EPIC_NOTES_FILE:?}" \
        '{id:"epic",status:"open",title:"Epic",issue_type:"epic",assignee:"",comment_count:0,description:$description,notes:$notes}'
    else
      status=$(<"$state/status")
      assignee=$(cat "$state/assignee" 2>/dev/null || true)
      printf '{"id":"%s","status":"%s","title":"Child","issue_type":"task","assignee":"%s","comment_count":0}\n' "$id" "$status" "$assignee"
    fi
    ;;
  ready)
    status=$(<"$state/status")
    if [ "$status" = open ]; then printf '[{"id":"child","title":"Child"}]\n'; else printf '[]\n'; fi
    ;;
  list)
    status=$(<"$state/status")
    if [ "$status" = closed ]; then printf '[]\n'; else printf '[{"id":"child","status":"%s"}]\n' "$status"; fi
    ;;
  update)
    child="$1"; shift
    case " $* " in
      *' --assignee '*)
        args=("$@"); for ((i=0; i<${#args[@]}; i++)); do [ "${args[$i]}" = --assignee ] && printf '%s' "${args[$((i + 1))]}" > "$state/assignee"; done
        ;;
      *' --claim '*) printf 'open' > "$state/status" ;;
      *' --status open '*) printf 'open' > "$state/status" ;;
      *' --status blocked '*) printf 'blocked' > "$state/status" ;;
    esac
    ;;
  close) printf 'closed' > "$state/status" ;;
  merge-slot|swarm|note|label|comment) ;;
  *) ;;
esac
EOF
  chmod +x "$bin/bd"
}

# A sentinel description exercising every character render_prompt's sed pass
# would mangle (pipe, ampersand) plus multi-line markdown structure — this
# stands in for a real epic's Goal + Context & architecture section.
write_desc_file() {
  cat > "$1" <<'EOF'
SENTINEL-CTX-9f3a
Line with a pipe | char and an ampersand & sign.

Second paragraph, multi-line markdown:
- item one
- item two
EOF
}

# A much larger notes blob (simulating the real 86%-notes/12x-bloat case from
# the audit) that must never leak into a rendered prompt.
write_notes_file() {
  local f="$1" i
  : > "$f"
  for i in $(seq 1 200); do printf 'NOTES-SHOULD-NEVER-APPEAR-%s\n' "$i" >> "$f"; done
}

run_sequential_case() {
  local root repo state bin run desc_file notes_file
  root="$TMP_ROOT/sequential"; repo="$root/repo"; state="$root/state"; bin="$root/bin"; run="$root/run"
  mkdir -p "$state" "$run" "$repo/docs"
  make_repo "$repo"
  printf 'ORIENTATION-CARD-SENTINEL-7b21\n' > "$repo/docs/agent-orientation.md"
  make_fake_tools "$bin"
  printf 'open' > "$state/status"
  desc_file="$root/desc.txt"; write_desc_file "$desc_file"
  notes_file="$root/notes.txt"; write_notes_file "$notes_file"
  (
    cd "$repo"
    for v in "${!COOKEPIC_@}"; do unset "$v"; done
    PATH="$bin:$PATH" FAKE_BD_STATE="$state" FAKE_EPIC_DESC_FILE="$desc_file" FAKE_EPIC_NOTES_FILE="$notes_file" \
      COOKEPIC_EPIC=epic COOKEPIC_HARNESS=claude COOKEPIC_WORKER_CMD=true COOKEPIC_SEQUENTIAL=1 COOKEPIC_SIBLINGS="" \
      COOKEPIC_GATE=true COOKEPIC_NO_PUSH=1 COOKEPIC_SPAWN_DELAY=0 COOKEPIC_MAX_DISPATCHES=1 \
      COOKEPIC_MAX_ATTEMPTS=1 COOKEPIC_WORKER_TIMEOUT=30 "$RUNNER" "$run"
  ) >"$root/stdout" 2>&1 || true
  printf '%s\n' "$root"
}

seq_root=$(run_sequential_case)
seq_prompt="$seq_root/run/prompt-child.md"
[ -f "$seq_prompt" ] || fail "no prompt rendered at $seq_prompt (stdout: $(cat "$seq_root/stdout"))"
assert_contains "$seq_prompt" 'SENTINEL-CTX-9f3a'
assert_contains "$seq_prompt" 'Line with a pipe | char and an ampersand & sign.'
assert_contains "$seq_prompt" 'Second paragraph, multi-line markdown:'
assert_contains "$seq_prompt" '- item one'
assert_contains "$seq_prompt" 'ORIENTATION-CARD-SENTINEL-7b21'
assert_not_contains "$seq_prompt" 'NOTES-SHOULD-NEVER-APPEAR'
assert_contains "$seq_prompt" 'DECISION:'
assert_contains "$seq_prompt" 'GOTCHA:'
assert_not_contains "$seq_prompt" 'body-file'
assert_contains "$seq_prompt" '## Epic context (resolved at dispatch)'

# No orientation card in the repo: workers get the literal fallback line, not
# a missing/empty section.
run_no_card_case() {
  local root repo state bin run desc_file notes_file
  root="$TMP_ROOT/no-card"; repo="$root/repo"; state="$root/state"; bin="$root/bin"; run="$root/run"
  mkdir -p "$state" "$run"
  make_repo "$repo"
  make_fake_tools "$bin"
  printf 'open' > "$state/status"
  desc_file="$root/desc.txt"; write_desc_file "$desc_file"
  notes_file="$root/notes.txt"; write_notes_file "$notes_file"
  (
    cd "$repo"
    for v in "${!COOKEPIC_@}"; do unset "$v"; done
    PATH="$bin:$PATH" FAKE_BD_STATE="$state" FAKE_EPIC_DESC_FILE="$desc_file" FAKE_EPIC_NOTES_FILE="$notes_file" \
      COOKEPIC_EPIC=epic COOKEPIC_HARNESS=claude COOKEPIC_WORKER_CMD=true COOKEPIC_SEQUENTIAL=1 COOKEPIC_SIBLINGS="" \
      COOKEPIC_GATE=true COOKEPIC_NO_PUSH=1 COOKEPIC_SPAWN_DELAY=0 COOKEPIC_MAX_DISPATCHES=1 \
      COOKEPIC_MAX_ATTEMPTS=1 COOKEPIC_WORKER_TIMEOUT=30 "$RUNNER" "$run"
  ) >"$root/stdout" 2>&1 || true
  printf '%s\n' "$root"
}

no_card_root=$(run_no_card_case)
assert_contains "$no_card_root/run/prompt-child.md" '(no orientation card in this repo)'

# COOKEPIC_ORIENTATION_FILE overrides the default candidate list.
run_override_case() {
  local root repo state bin run desc_file notes_file
  root="$TMP_ROOT/override"; repo="$root/repo"; state="$root/state"; bin="$root/bin"; run="$root/run"
  mkdir -p "$state" "$run"
  make_repo "$repo"
  printf 'CUSTOM-ORIENTATION-SENTINEL-1a2b\n' > "$repo/custom-orientation.md"
  make_fake_tools "$bin"
  printf 'open' > "$state/status"
  desc_file="$root/desc.txt"; write_desc_file "$desc_file"
  notes_file="$root/notes.txt"; write_notes_file "$notes_file"
  (
    cd "$repo"
    for v in "${!COOKEPIC_@}"; do unset "$v"; done
    PATH="$bin:$PATH" FAKE_BD_STATE="$state" FAKE_EPIC_DESC_FILE="$desc_file" FAKE_EPIC_NOTES_FILE="$notes_file" \
      COOKEPIC_EPIC=epic COOKEPIC_HARNESS=claude COOKEPIC_WORKER_CMD=true COOKEPIC_SEQUENTIAL=1 COOKEPIC_SIBLINGS="" \
      COOKEPIC_ORIENTATION_FILE=custom-orientation.md \
      COOKEPIC_GATE=true COOKEPIC_NO_PUSH=1 COOKEPIC_SPAWN_DELAY=0 COOKEPIC_MAX_DISPATCHES=1 \
      COOKEPIC_MAX_ATTEMPTS=1 COOKEPIC_WORKER_TIMEOUT=30 "$RUNNER" "$run"
  ) >"$root/stdout" 2>&1 || true
  printf '%s\n' "$root"
}

override_root=$(run_override_case)
assert_contains "$override_root/run/prompt-child.md" 'CUSTOM-ORIENTATION-SENTINEL-1a2b'

# Parallel mode gets the same close-out markers and injected context.
run_parallel_case() {
  local root repo state bin run desc_file notes_file
  root="$TMP_ROOT/parallel"; repo="$root/repo"; state="$root/state"; bin="$root/bin"; run="$root/run"
  mkdir -p "$state" "$run"
  make_repo "$repo"
  make_fake_tools "$bin"
  printf 'open' > "$state/status"
  desc_file="$root/desc.txt"; write_desc_file "$desc_file"
  notes_file="$root/notes.txt"; write_notes_file "$notes_file"
  (
    cd "$repo"
    for v in "${!COOKEPIC_@}"; do unset "$v"; done
    PATH="$bin:$PATH" FAKE_BD_STATE="$state" FAKE_EPIC_DESC_FILE="$desc_file" FAKE_EPIC_NOTES_FILE="$notes_file" \
      COOKEPIC_EPIC=epic COOKEPIC_HARNESS=claude COOKEPIC_WORKER_CMD=true COOKEPIC_WORKERS=1 COOKEPIC_SIBLINGS="" \
      COOKEPIC_GATE=true COOKEPIC_NO_PUSH=1 COOKEPIC_SPAWN_DELAY=0 COOKEPIC_MAX_DISPATCHES=1 \
      COOKEPIC_MAX_ATTEMPTS=1 COOKEPIC_WORKER_TIMEOUT=30 "$RUNNER" "$run"
  ) >"$root/stdout" 2>&1 || true
  printf '%s\n' "$root"
}

par_root=$(run_parallel_case)
par_prompt="$par_root/run/prompt-child.md"
[ -f "$par_prompt" ] || fail "no prompt rendered at $par_prompt (stdout: $(cat "$par_root/stdout"))"
assert_contains "$par_prompt" 'SENTINEL-CTX-9f3a'
assert_not_contains "$par_prompt" 'NOTES-SHOULD-NEVER-APPEAR'
assert_contains "$par_prompt" 'DECISION:'
assert_contains "$par_prompt" 'GOTCHA:'
assert_not_contains "$par_prompt" 'body-file'

# Static template regressions: neither template makes `bd show <epic>` the
# primary orientation step or instructs a body-file fold anymore.
assert_not_contains "$SKILL_DIR/worker-prompt.md" 'Orient: `bd show @EPIC@` (Goal'
assert_not_contains "$SKILL_DIR/worker-prompt-sequential.md" 'Orient: `bd show @EPIC@` (Goal'
assert_not_contains "$SKILL_DIR/worker-prompt.md" 'body-file'
assert_not_contains "$SKILL_DIR/worker-prompt-sequential.md" 'body-file'
assert_contains "$SKILL_DIR/worker-prompt.md" '@EPIC_CONTEXT@'
assert_contains "$SKILL_DIR/worker-prompt.md" '@ORIENTATION_CARD@'
assert_contains "$SKILL_DIR/worker-prompt-sequential.md" '@EPIC_CONTEXT@'
assert_contains "$SKILL_DIR/worker-prompt-sequential.md" '@ORIENTATION_CARD@'

printf 'cook-epic orientation-injection regression tests passed\n'
