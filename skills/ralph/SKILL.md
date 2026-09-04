---
name: ralph
description: "Fresh-context loop of headless sessions (claude -p, codex exec, kimi -p, opencode run) with state in the repo. Use when the user types /ralph <prompt>."
---

# ralph — fresh-context loop

Run the user's prompt in a loop of independent headless sessions through the `run.sh` beside this `SKILL.md`. Each iteration uses the same harness as the agent running this skill and starts with no conversation context. The runner enforces iteration, timeout, gutter, budget, and backlog guardrails.

## Steps

1. **Extract the loop prompt** — keep everything after `/ralph` verbatim.
   - Keep `@file` references literal so every child reads the latest file.
   - Keep skill invocations such as `/cook-it` literal so the child harness resolves them.
   - If the prompt is empty, ask what the loop should run.

2. **Create the run directory under `/var/tmp`, never in the project tree:**

   ```bash
   RUN_DIR=$(mktemp -d "/var/tmp/ralph.$(date +%Y%m%d-%H%M%S).XXXXXX")
   ```

   Write the exact prompt to `$RUN_DIR/prompt.md` with the current harness's file-writing tool. All artifacts (`prompt.md`, `summary.md`, `loop.log`, `mailbox.jsonl`, and `iter-N.json`) stay in this directory.

3. **Select the current harness yourself; never ask the user:**
   - Running in Codex: `HARNESS=codex`
   - Running in Claude Code: `HARNESS=claude`
   - Running through `ccx`: `HARNESS=ccx`
   - Running in Kimi Code: `HARNESS=kimi`
   - Running in OpenCode: `HARNESS=opencode`

   Always pass this value as `RALPH_HARNESS`. The runner's process/environment detection is only a fallback for direct invocations. It recognizes `ccx` only when its complete inherited signature matches: loopback HTTP base URL, `unused` auth token, both model names ending in `[1m]`, compact window `372000`, and both traffic/fallback disable flags set to `1`.

4. **Map optional user knobs:**

   | User says                            | Environment variable                      | Default               |
   | ------------------------------------ | ----------------------------------------- | --------------------- |
   | "20 iterations", "keep going longer" | `RALPH_MAX_ITER`                          | 30                    |
   | "budget $30", "cap spend"            | `RALPH_BUDGET_USD`                        | none; Claude/ccx only |
   | "1h per iteration"                   | `RALPH_ITER_TIMEOUT` (seconds)            | 0 (no limit)          |
   | "yolo", "skip permissions"           | `RALPH_PERMISSION_MODE=bypassPermissions` | `auto`                |
   | "use <model>"                        | `RALPH_MODEL`                             | harness default       |

   Pass model names through unchanged; model aliases are harness-specific. Codex, Kimi, and OpenCode do not report USD cost, so do not accept a dollar budget for those loops. Claude Code and `ccx` report and enforce the Claude-compatible USD budget.

   `ccx` uses the inherited proxy environment and runs the Claude-compatible binary directly. Ralph must not start, source, or stop a proxy in this mode; explicit `RALPH_HARNESS=ccx` fails before launch when that environment is absent.

   `kimi` children run as `kimi -p --output-format stream-json` (JSONL of `{"role":"assistant"|"tool"|"meta"}` records; the meta record carries the session id). The kimi CLI rejects `-y`/`--auto` combined with `-p`, and prompt mode already runs tools non-interactively, so both permission modes map to the same flagless invocation.

   `opencode` children run as `opencode run --format json --auto`, with an optional `-m <model>`, followed by the prompt. OpenCode exposes one unattended permission switch, so both `auto` and `bypassPermissions` map to `--auto`; the latter is not a stronger distinct bypass. OpenCode loads its normal global and project configuration, agents, commands, plugins, and skills.

5. **Resolve the runner from this skill, then launch from the project root.** Derive `SKILL_DIR` from the directory containing the `SKILL.md` you loaded. Use `${RALPH_RUNNER:-"$SKILL_DIR/run.sh"}`; this lets callers pin a specific copy with `RALPH_RUNNER`. Only when the loaded skill path is unavailable or ambiguous, fall back to `~/.agents/skills/ralph/run.sh`.

   In a server or remote harness, detach the loop by default so the OS owns it
   after the chat session closes:

   ```bash
   cd <project-root> && nohup setsid env RALPH_HARNESS="$HARNESS" \
     "${RALPH_RUNNER:-"$SKILL_DIR/run.sh"}" "$RUN_DIR" >/dev/null 2>&1 &
   ```

   Add the optional variables the user requested after `env`. In a plain
   interactive CLI, a non-detached launch is still fine when the user is
   watching it live:

   ```bash
   cd <project-root> && RALPH_HARNESS="$HARNESS" "${RALPH_RUNNER:-"$SKILL_DIR/run.sh"}" "$RUN_DIR"
   ```

   Inside t3code, prefer its server-owned EpicRunner for epic work. It persists
   run state, survives client disconnects, and supports reattachment through
   the Epics UI and `t3 epic` CLI. Use this terminal runner when the server-owned
   path is unavailable or the user explicitly asks for `/ralph`.

   The loop takes an epic run lock so it cannot collide with a t3code server run
   or a `/cook-epic` on the same epic. When the loop targets a beads epic, pass
   `RALPH_EPIC=<epic-id>` (or start `prompt.md` with an `Epic: <id>` line) so the
   lock keys on the epic rather than on the prompt's hash.

   **Exit 75 means another run already owns it.** The runner prints one line of
   JSON, `{"event":"lock_held","owner":...,"runDir":...,"host":...,"lock":...}`,
   and starts no iteration. Report and observe: tell the user who holds it
   (`owner`, on `host`), point them at the reported `runDir`, and say they can
   stop that run with `touch <runDir>/STOP`. Do NOT retry, relaunch with a fresh
   run directory, or delete the lock file.

6. **Report completed iterations:** run `"$SKILL_DIR/watch.sh" "$RUN_DIR"` with the harness's long-running monitor mechanism. Only when the loaded skill path is unavailable or ambiguous, fall back to `~/.agents/skills/ralph/watch.sh`.
   - Claude Code: use a persistent Monitor.
   - Codex: start a second ongoing exec session and poll it for new lines.
   - Kimi Code or OpenCode: run watch.sh as a background task; if the host only notifies on completion, also schedule a recurring check (e.g. every ~10 min) that drains new watcher lines into chat.

   Relay each emitted iteration line to the user. The watcher emits one record only
   after an iteration finishes; stay silent between those records. Do not send
   periodic heartbeats, internal phase updates, tool-call summaries, or "still
   running" messages. The only exception is an actionable blocker that requires
   user intervention, or a direct user request for status. Do not make the user
   tail files manually.

   The watcher is stateless: every invocation replays `mailbox.jsonl` from the
   first record and exits after the `finished` record. Any later session can
   reattach by running `"$SKILL_DIR/watch.sh" <run-dir>` or reading
   `<run-dir>/mailbox.jsonl` with `jq`. When resuming after a chat was reaped,
   inspect `/var/tmp/ralph.*` directories that do not yet contain a `finished`
   mailbox record, then re-run the watcher for the matching directory.

7. **Tell the user once, up front:** include the run directory, say that the
   detached loop survives the chat closing, and explain that a later session
   can reattach with `watch.sh <run-dir>`. Say that iteration results will
   appear in chat and that `touch $RUN_DIR/STOP` stops after the current
   iteration.

8. **When the loop finishes:** report the stop reason, iterations run, and the full list from `$RUN_DIR/summary.md`. If it stops on a gutter or timeout, inspect the last iteration artifact and explain what blocked the child. A loop that ended with exit 75 ran no iterations: report the holding run instead (see step 5) and stop there.

Each child must end its final response with `RALPH_MSG: {"summary","why"}` as required by the protocol appended in `run.sh`. The runner normalizes Claude/ccx JSON, Codex JSONL, Kimi stream-json, and OpenCode JSONL into the same mailbox records. For OpenCode, it uses the first top-level `sessionID`, the last `type:"text"` record's `part.text`, and reports cost as unavailable. Commit subjects remain the fallback when a child omits its message.

## Built-in guardrails

- One unit of work per iteration; run gates, commit, and push before stopping.
- `RALPH_DONE` on its own line ends a dry backlog cleanly.
- Two consecutive iterations without a new commit stop the loop.
- Beads projects stop when `bd ready` is empty.
- Claude Code and ccx load normal Claude skills and `CLAUDE.md`; Codex loads its normal skills and `AGENTS.md`; Kimi Code loads its normal user/project skills (`~/.agents/skills`, project `.agents/skills`); OpenCode loads its normal global/project configuration, agents, commands, plugins, and skills. The runner does not use any harness's bare/ignore-config mode.
- Claude Code and ccx use the `auto` permission classifier by default. Codex uses non-interactive full repository/network access without approval prompts because each iteration must edit and push; Kimi prompt mode likewise runs tools without approval prompts. Use Ralph only in a trusted repository. Explicit yolo mode maps to each harness's bypass flag.

## Cautions

- Ralph assumes exclusive use of the repo. Warn before launching when `git status` shows another agent's work.
- Codex, Kimi, and OpenCode loops cannot enforce `RALPH_BUDGET_USD`; the runner fails before starting instead of pretending a `$0` cost.
- `bypassPermissions` is only appropriate for trusted, reversible work. In OpenCode it maps to the same `--auto` switch as `auto`, because OpenCode has no stronger distinct bypass mode.
