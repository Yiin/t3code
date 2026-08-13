#!/usr/bin/env bash
set -euo pipefail

skills=(plan-epic cook-epic cook-it ralph deploy)
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
agents_skills_dir="${SKILLS_INSTALL_AGENTS_DIR:-${HOME}/.agents/skills}"
# Prime Agent reads its own skills directory, so it needs its own links to the
# same canonical directories. Never copy: a copy forks the moment either side
# is edited. Prime Agent installs elsewhere on some machines, so point
# PRIME_SKILLS_DIR at the real directory there.
prime_skills_dir="${PRIME_SKILLS_DIR:-${PRIME_HOME:-${HOME}/.prime}/skills}"

# This installs links for the whole machine, so it must only ever run from the
# canonical checkout. An epic worker once ran it inside its own worktree and
# repointed every global skill there; the links dangled the moment the worktree
# was pruned, and the skills vanished from every project and harness.
#
# A linked worktree has its own .git dir but shares the common one.
if git_dir="$(git -C "$script_dir" rev-parse --absolute-git-dir 2>/dev/null)"; then
  common_dir="$(git -C "$script_dir" rev-parse --path-format=absolute --git-common-dir)"
  if [[ "$git_dir" != "$common_dir" ]] && [[ "${SKILLS_INSTALL_ALLOW_WORKTREE:-0}" != 1 ]]; then
    main_checkout="$(dirname -- "$common_dir")"
    printf 'error: refusing to install skills from a linked worktree.\n' >&2
    printf '  this checkout: %s\n' "$script_dir" >&2
    printf '  canonical:     %s\n' "$main_checkout" >&2
    printf 'Run %s/skills/install.sh instead, or set SKILLS_INSTALL_ALLOW_WORKTREE=1 to override.\n' \
      "$main_checkout" >&2
    exit 1
  fi
fi

if [[ ! -d "$agents_skills_dir" ]]; then
  printf 'error: skills directory does not exist or is not a directory: %s\n' "$agents_skills_dir" >&2
  exit 1
fi

# Check every source before changing any installed skill.
for skill in "${skills[@]}"; do
  source_dir="${script_dir}/${skill}"
  if [[ ! -d "$source_dir" ]]; then
    printf 'error: repository skill directory is missing: %s\n' "$source_dir" >&2
    exit 1
  fi
done

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"

link_skills() { # <target directory>
  local target_dir="$1" skill source_dir target backup counter

  for skill in "${skills[@]}"; do
    source_dir="${script_dir}/${skill}"
    target="${target_dir}/${skill}"

    if [[ -L "$target" ]] && [[ "$(readlink -- "$target")" == "$source_dir" ]]; then
      printf 'already installed: %s -> %s\n' "$target" "$source_dir"
      continue
    fi

    if [[ -L "$target" ]]; then
      unlink -- "$target"
      printf 'removed stale link: %s\n' "$target"
    elif [[ -e "$target" ]]; then
      backup="${target_dir}/${skill}.bak-${timestamp}"
      counter=0
      while [[ -e "$backup" || -L "$backup" ]]; do
        counter=$((counter + 1))
        backup="${target_dir}/${skill}.bak-${timestamp}.${counter}"
      done
      mv -- "$target" "$backup"
      printf 'backed up: %s -> %s\n' "$target" "$backup"
    fi

    ln -s -- "$source_dir" "$target"
    printf 'installed: %s -> %s\n' "$target" "$source_dir"
  done
}

link_skills "$agents_skills_dir"

# Prime Agent is optional. Install into it only when its home already exists,
# so a machine without Prime Agent still gets a clean run.
prime_home="$(dirname -- "$prime_skills_dir")"
if [[ -d "$prime_skills_dir" ]]; then
  link_skills "$prime_skills_dir"
elif [[ -d "$prime_home" ]]; then
  mkdir -p -- "$prime_skills_dir"
  printf 'created: %s\n' "$prime_skills_dir"
  link_skills "$prime_skills_dir"
else
  printf 'skipped Prime Agent: %s does not exist (set PRIME_SKILLS_DIR to override)\n' \
    "$prime_home"
fi
