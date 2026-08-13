# Repository-managed skills

The copies in this directory are canonical. Edit them here, then run:

```bash
./skills/install.sh
```

The installer links
`~/.agents/skills/{plan-epic,cook-epic,cook-it,ralph,deploy}` to this checkout.
Plain Claude, Codex, and Kimi sessions then use the same files. Existing real
files or directories are backed up before linking.

Prime Agent reads its own skills directory, so the installer links the same
five directories into `~/.prime/skills` as well. It creates that directory when
`~/.prime` exists, and skips Prime Agent with a printed reason when it does
not. Set `PRIME_SKILLS_DIR` when Prime Agent keeps its skills somewhere else.
Both targets are links to this checkout, so there is one canonical copy of each
skill and no fork to keep in step.

The links are absolute, so moving this checkout breaks them. Run the installer
again from the new checkout location to repair the links.

## Tests

Run `bash skills/tests/install-links.sh` to check the installer's link targets.
It redirects every target into a temporary directory, so it never touches the
machine's real links.

Run the full cook-epic shell suite with `bash skills/cook-epic/tests/all.sh`.
Set `COOKEPIC_TESTS_FILTER=<name>` to select matching files.
Each file has a 120-second limit. The full suite has a 600-second ceiling.
Measured local wall time: 186 seconds on 2026-08-07, with the two documented skips.

- `fallback-session-regressions.sh` covers session fallback and recovery.
- `fold-regressions.sh` covers folded worker results and state updates.
- `liveness-regressions.sh` covers worker activity, inspection, and stop rules. It skips under `t3code-06s.32` because it exceeds 120 seconds.
- `opencode-harness.sh` covers the OpenCode harness command contract.
- `orientation-injection.sh` covers orientation-card selection and prompt injection.
- `orientation-metrics.sh` covers orientation metrics and diagnostic output.
- `parallel-siblings.sh` covers parallel sibling layouts and atomic landing.
- `prompt-cache-warmup.sh` covers prompt-cache warm-up behavior.
- `provider-fallback.sh` covers provider error classification and fallback order.
- `run-lock.sh` covers terminal lock ownership, exclusion, and stale-lock recovery.
- `sequential-regressions.sh` covers sequential dispatch, gates, and push rules. It skips under `t3code-06s.33` because it exceeds 120 seconds.
