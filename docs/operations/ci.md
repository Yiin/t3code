# CI quality gates

- `.github/workflows/ci.yml` runs `vp check` (lint + typecheck), `vpr typecheck`, and `vp run test` on pull requests and pushes to `main` or `mine`.
- The separate `epic_runs` job installs Beads `v1.1.2` and verifies `bd --version`.
- It exports `T3CODE_CONFORMANCE_TERMINAL=1` and runs `skills/cook-epic/tests/all.sh`.
- The terminal and server conformance drivers remain pending under `t3code-06s.2` and `t3code-06s.6`.
- The shell suite has a 600-second internal ceiling. It took 186 seconds locally on 2026-08-07, with the two documented skips.
- The CI job has a 20-minute timeout. This exceeds the suite ceiling by 50%, plus five minutes for setup.
- Recalculate the job timeout when the pending conformance drivers land.
- `.github/workflows/release.yml` builds macOS (`arm64` and `x64`), Linux (`x64`), and Windows (`x64`) desktop artifacts from a single `v*.*.*` tag and publishes one GitHub release.
- The release workflow auto-enables signing only when platform credentials are present. macOS passkey builds additionally require `APPLE_TEAM_ID` and the `MACOS_PROVISIONING_PROFILE` secret; Windows uses Azure Trusted Signing. Without the core signing credentials, it still releases unsigned artifacts.
- See [Release Checklist](./release.md) for the full release/signing setup checklist.
