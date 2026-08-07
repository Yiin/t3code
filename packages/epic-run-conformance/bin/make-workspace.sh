#!/usr/bin/env bash
set -euo pipefail
PACKAGE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec bun run "$PACKAGE_DIR/src/makeWorkspaceCli.ts" "$@"
