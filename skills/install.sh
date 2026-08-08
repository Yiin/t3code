#!/usr/bin/env bash
set -euo pipefail

skills=(plan-epic cook-epic cook-it ralph deploy)
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
agents_skills_dir="${HOME}/.agents/skills"

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

for skill in "${skills[@]}"; do
  source_dir="${script_dir}/${skill}"
  target="${agents_skills_dir}/${skill}"

  if [[ -L "$target" ]] && [[ "$(readlink -- "$target")" == "$source_dir" ]]; then
    printf 'already installed: %s -> %s\n' "$target" "$source_dir"
    continue
  fi

  if [[ -L "$target" ]]; then
    unlink -- "$target"
    printf 'removed stale link: %s\n' "$target"
  elif [[ -e "$target" ]]; then
    backup="${agents_skills_dir}/${skill}.bak-${timestamp}"
    counter=0
    while [[ -e "$backup" || -L "$backup" ]]; do
      counter=$((counter + 1))
      backup="${agents_skills_dir}/${skill}.bak-${timestamp}.${counter}"
    done
    mv -- "$target" "$backup"
    printf 'backed up: %s -> %s\n' "$target" "$backup"
  fi

  ln -s -- "$source_dir" "$target"
  printf 'installed: %s -> %s\n' "$target" "$source_dir"
done
