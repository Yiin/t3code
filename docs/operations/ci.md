# CI quality gates

`.github/workflows/ci.yml` runs on pull requests and on pushes to `main` or `mine`.

- The `check` job runs `vp check` (lint plus typecheck) and `vpr typecheck`.
- The `test` job runs `vp run test` across the workspace. It installs no Beads, so the cook-epic shell suite skips itself there with a stated reason.
- The `epic_runs` job installs Beads `v1.1.2`, verifies `bd --version`, runs `skills/cook-epic/tests/all.sh` with `COOKEPIC_REQUIRE_BD=1` (it is the suite's mandatory owner, so a missing `bd` fails the job instead of skipping green), then runs the terminal conformance driver with `T3CODE_CONFORMANCE_TERMINAL=1`.

## Runner labels

Every job that targets a `blacksmith-*` runner reads a repository variable first and falls back to the
original label:

```yaml
runs-on: ${{ vars.CI_RUNNER_LINUX || 'blacksmith-8vcpu-ubuntu-2404' }}
```

The Blacksmith runners belong to the upstream organization. A fork has none, so a job pinned to a
`blacksmith-*` label queues forever there. Set `CI_RUNNER_LINUX`, `CI_RUNNER_MACOS`, or
`CI_RUNNER_WINDOWS` as repository variables in the fork to redirect those jobs to GitHub-hosted runners,
for example `ubuntu-24.04`, `macos-latest`, and `windows-latest`. Leave the variables unset upstream and
nothing changes.

One variable covers every Linux job, so the 8, 16, and 32 vCPU tiers all collapse to the same label when
the override is set.

`scripts/workflow-runner-labels.test.ts` fails the `test` job if any workflow pins a bare `blacksmith-*`
label again, which is the shape an upstream merge brings back.

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

The shell suite is one file, `core-delegation.sh`. It needs the `bd` CLI; `all.sh` skips the suite with a stated reason when `bd` is absent unless `COOKEPIC_REQUIRE_BD=1`.

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
