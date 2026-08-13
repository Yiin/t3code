#!/usr/bin/env bash
set -euo pipefail

# Covers skills/install.sh link targets, including the Prime Agent directory.
# Every target is redirected into a temporary directory through
# SKILLS_INSTALL_AGENTS_DIR and PRIME_SKILLS_DIR, so this test never touches
# the machine's real skill links.

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
SKILLS_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
INSTALLER="$SKILLS_DIR/install.sh"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

assert_link() { # <link> <expected target>
  [ -L "$1" ] || fail "expected a symlink at $1"
  [ "$(readlink -- "$1")" = "$2" ] || fail "expected $1 -> $2, got $(readlink -- "$1")"
}

run_installer() { # <agents dir> <prime dir> <output file>
  SKILLS_INSTALL_ALLOW_WORKTREE=1 \
  SKILLS_INSTALL_AGENTS_DIR="$1" \
  PRIME_SKILLS_DIR="$2" \
    bash "$INSTALLER" >"$3" 2>&1 ||
    { sed 's/^/  /' "$3" >&2; fail "installer exited nonzero"; }
}

# 1. Both directories exist: every skill is linked to the canonical copy.
agents="$TMP_ROOT/one/.agents/skills"
prime="$TMP_ROOT/one/.prime/skills"
mkdir -p "$agents" "$prime"
run_installer "$agents" "$prime" "$TMP_ROOT/one.log"
for skill in plan-epic cook-epic cook-it ralph deploy; do
  assert_link "$agents/$skill" "$SKILLS_DIR/$skill"
  assert_link "$prime/$skill" "$SKILLS_DIR/$skill"
done

# 2. A second run changes nothing.
run_installer "$agents" "$prime" "$TMP_ROOT/one-again.log"
grep -Fq 'already installed' "$TMP_ROOT/one-again.log" ||
  fail "expected the second run to report already installed skills"
grep -Fq 'installed: ' <(grep -Fv 'already installed' "$TMP_ROOT/one-again.log") &&
  fail "expected the second run to install nothing"
assert_link "$prime/cook-epic" "$SKILLS_DIR/cook-epic"

# 3. Prime home exists but its skills directory does not: create and link it.
agents="$TMP_ROOT/two/.agents/skills"
prime="$TMP_ROOT/two/.prime/skills"
mkdir -p "$agents" "$TMP_ROOT/two/.prime"
run_installer "$agents" "$prime" "$TMP_ROOT/two.log"
assert_link "$prime/plan-epic" "$SKILLS_DIR/plan-epic"

# 4. No Prime home: skip it, report why, and still install the shared links.
agents="$TMP_ROOT/three/.agents/skills"
prime="$TMP_ROOT/three/.prime/skills"
mkdir -p "$agents"
run_installer "$agents" "$prime" "$TMP_ROOT/three.log"
assert_link "$agents/cook-epic" "$SKILLS_DIR/cook-epic"
[ ! -e "$prime" ] || fail "expected $prime to stay absent"
grep -Fq 'skipped Prime Agent' "$TMP_ROOT/three.log" ||
  fail "expected a skip line naming Prime Agent"

# 5. A real directory in a target is backed up, never replaced in place.
agents="$TMP_ROOT/four/.agents/skills"
prime="$TMP_ROOT/four/.prime/skills"
mkdir -p "$agents" "$prime/cook-epic"
printf 'local copy\n' > "$prime/cook-epic/SKILL.md"
run_installer "$agents" "$prime" "$TMP_ROOT/four.log"
assert_link "$prime/cook-epic" "$SKILLS_DIR/cook-epic"
backup=$(find "$prime" -maxdepth 1 -name 'cook-epic.bak-*' -print -quit)
[ -n "$backup" ] || fail "expected a backup of the replaced directory"
grep -Fq 'local copy' "$backup/SKILL.md" || fail "expected the backup to keep its content"

printf 'PASS: install-links.sh\n'
