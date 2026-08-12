# CI quality gates

`.github/workflows/ci.yml` runs on pull requests and on pushes to `main` or `mine`.

- The `check` job runs `vp check` (lint plus typecheck), `vpr typecheck`, and the desktop build.
- The `test` job runs `vp run test` across the workspace.
- The `epic_runs` job installs Beads `v1.1.2`, verifies `bd --version`, runs `skills/cook-epic/tests/all.sh`, then runs the terminal conformance driver with `T3CODE_CONFORMANCE_TERMINAL=1`.

## Conformance drivers

Three drivers replay the same scenario set through a different adapter.

- Core: `packages/epic-run-conformance/src/coreDriver.test.ts`. The `test` job covers it.
- Terminal: `packages/epic-run-conformance/src/terminalDriver.test.ts`. It skips unless `T3CODE_CONFORMANCE_TERMINAL` is set, so only the `epic_runs` job runs it.
- Server: `apps/server/integration/epicRunnerConformance.integration.test.ts`. The `test` job covers it.

## Measured runtimes

Measured locally on 2026-08-12, not on a CI runner.

| Command                                                                            | Time                       |
| ---------------------------------------------------------------------------------- | -------------------------- |
| `bash skills/cook-epic/tests/all.sh`                                               | 42 s                       |
| `vp run --filter @t3tools/epic-run-conformance test`                               | 17 s, terminal leg skipped |
| `T3CODE_CONFORMANCE_TERMINAL=1 vp run --filter @t3tools/epic-run-conformance test` | 38 s                       |
| `vp test run apps/server/integration/epicRunnerConformance.integration.test.ts`    | 23 s                       |

The shell suite is one file, `core-delegation.sh`. It has no skips.

## Budgets

Each suite bounds itself, so a hang reports a useful failure before the job timeout kills the runner.

- `skills/cook-epic/tests/all.sh:6` gives each shell file 120 s. Line 9 caps the whole suite at 600 s.
- `packages/epic-run-conformance/src/coreDriver.test.ts:534` gives each core scenario 120 s. Line 549 applies it.
- `packages/epic-run-conformance/src/terminalDriver.test.ts:159` gives each terminal spawn 60 s. Line 221 caps the whole terminal test at 600 s.
- `apps/server/integration/epicRunnerConformance.integration.test.ts:838` asserts each server scenario finishes in under 30 s. Line 842 caps the whole test at 300 s. Line 783 waits at most 60 s for a run to reach a terminal state.
- `apps/server/vite.config.ts:69` turns off file parallelism for the server suite. Lines 72 and 73 set the hook and test timeouts to 120 s each.

## Job timeout

The `epic_runs` job gets 25 minutes. The arithmetic:

- Shell suite ceiling: 600 s.
- Terminal conformance ceiling: 600 s.
- Both ceilings together: 1200 s, which is 20 minutes.
- Setup, meaning checkout, Go, `go install bd`, and Vite+ with a dependency install: 5 minutes.
- Total: 25 minutes.

Real work is 80 s, so the cap only bites when a suite hangs. Recompute it when either internal ceiling changes.

## Release workflow

- `.github/workflows/release.yml` builds macOS (`arm64` and `x64`), Linux (`x64`), and Windows (`x64`) desktop artifacts from a single `v*.*.*` tag and publishes one GitHub release.
- The release workflow auto-enables signing only when platform credentials are present. macOS passkey builds also need `APPLE_TEAM_ID` and the `MACOS_PROVISIONING_PROFILE` secret. Windows uses Azure Trusted Signing. Without the core signing credentials, it still releases unsigned artifacts.
- See [Release Checklist](./release.md) for the full release and signing setup checklist.
