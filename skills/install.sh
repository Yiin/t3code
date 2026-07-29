#!/usr/bin/env bash
set -euo pipefail

skills=(plan-epic cook-epic cook-it ralph)
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
agents_skills_dir="${HOME}/.agents/skills"

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
