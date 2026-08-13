# Prime Agent

Prime Agent is an early-access provider in T3 Code. It runs as a per-thread
`prime-agent` process that T3 Code drives over Prime's RPC mode.

T3 Code never bundles, installs, or ships credentials for Prime Agent. You
install the CLI and log in yourself. No Prime key belongs in `.env.example` or
in a release secret.

## Install And Authenticate

1. Install the `prime-agent` CLI with Prime Agent's own installer, and log in
   with its own login command. T3 Code has no install or update button for it;
   the provider card marks maintenance as manual.
2. Confirm the CLI answers on your PATH:

   ```bash
   prime-agent --version
   ```

3. Confirm the account and the model list from a one-shot run:

   ```bash
   prime-agent --mode json --no-session --cwd . -- "reply with ok"
   ```

Update Prime Agent the same way you installed it. T3 Code picks the new binary
up on its next health check, at most five minutes later.

## Add The Provider In T3 Code

Open Settings and add a Prime Agent instance. The card has three fields:

```text
Binary path:      prime-agent
Launch arguments: (empty)
Session root:     (empty)
```

- `Binary path` defaults to `prime-agent` and is resolved on PATH. Give an
  absolute path when the binary is not on the server's PATH.
- `Launch arguments` are extra tokens passed on every session start.
- `Session root` overrides where Prime session files are kept. Leave it empty to
  use `<state-dir>/prime/<instance-id>`, which T3 Code creates with mode `0700`.

You can add more than one Prime Agent instance. The instance id is the routing
identity, so two instances never share sessions.

### Launch Arguments T3 Code Owns

T3 Code sets these flags itself. Putting any of them in `Launch arguments` turns
the provider card red with `Prime launch argument '<flag>' is controlled by T3
Code.`

```text
--mode        --session      --session-id   --session-dir
--fork        --continue     --resume       --no-session
--provider    --model        --thinking     --extension / -e
--no-extensions
```

Use environment variables on the instance for anything else the CLI reads.

## What The Health Check Does

T3 Code refreshes the provider snapshot every five minutes, and after any
settings change:

1. Runs `prime-agent --version`, with a 4-second timeout.
2. Starts a `--mode rpc --no-session` process and asks it for `get_state` and
   `get_available_models`, with a 15-second timeout.
3. Reads the model list, the active model, and the authentication flag from the
   answers.

T3 Code uses two Prime modes. `--mode rpc` is the interactive transport for a
session. `--mode json` is the headless one-shot form that `plan-epic` and
`cook-epic` use.

### Diagnose An Unhealthy Card

| Message                                                    | Cause                                    | Fix                                               |
| ---------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------- |
| `Prime Agent CLI is not installed or not on PATH.`         | The binary did not resolve               | Install it, or set an absolute `Binary path`      |
| `Prime Agent timed out while checking its version.`        | `--version` took over 4 seconds          | Check the binary and the host load                |
| `Prime Agent is installed but its version check failed.`   | `--version` exited nonzero               | Run the command in a terminal and read its output |
| `Prime Agent RPC health check timed out.`                  | RPC took over 15 seconds                 | Check the host load, then restart the server      |
| `Prime Agent RPC returned invalid data.`                   | RPC failed or answered off-contract      | Check the CLI version against this T3 Code build  |
| `Prime Agent is not authenticated.`                        | Prime reported no account                | Log in with Prime Agent's own login command       |
| `Prime Agent returned no available models.`                | The account has no model access          | Check the account's model entitlements            |
| `Prime launch argument '<flag>' is controlled by T3 Code.` | A reserved flag is in `Launch arguments` | Remove that token                                 |
| `Prime Agent is disabled in T3 Code settings.`             | The instance is off                      | Enable the instance                               |

## Models And Thinking

Prime model slugs are `<provider>/<id>`, taken straight from
`get_available_models`. The model Prime reports as active becomes the default.

A model that declares reasoning gets a **Thinking** option in the model picker.
The values come from the model's own thinking map, limited to `off`, `minimal`,
`low`, `medium`, `high`, `xhigh`, and `max`. A model whose inputs include images
accepts image attachments.

Files ride as an absolute path in the message text, not as an uploaded blob.
Prime reads the path when the runtime mode allows it.

## Sessions, Resume, And Fork

T3 Code owns Prime session identity. Each thread gets one `prime-agent` process
and one Prime session id, stored as a resume cursor next to the provider
binding.

- A new thread starts with `--session-id <generated>`.
- The owning thread reopens its own session with `--session <id>`.
- Another thread, or another instance, does not reuse that session. It forks:
  `--fork <id> --session-id <new>`. The fork gets its own cursor, so the two
  threads never write to one Prime session.
- The cursor survives a server restart, so an interrupted thread continues
  instead of starting over.
- Switching a thread to a different Prime instance is a different continuation
  identity. The thread starts fresh there.

Rollback in the UI maps to Prime's fork on a chosen message, and then refreshes
the cursor from Prime's new state. Rollback is refused while a turn is active.

## Permissions

T3 Code loads its own permission extension into every Prime session with
`--no-extensions --extension <t3-permission-extension.mjs>`, so only the T3
bridge is active.

- In **Full access** mode the extension allows everything.
- In **Supervised** mode a `ipython`, `python`, or `python_cell` tool call
  prompts in the app. You can answer Allow once, Allow for session, Decline, or
  Cancel. "Allow for session" lasts for that one Prime process.
- The bridge is fail-closed. A missing UI, a failed prompt, or a 5-minute
  timeout blocks the call.

Other Prime tools are not prompted. The runtime mode reaches Prime as
`T3_PRIME_RUNTIME_MODE`.

## Plan And Cook Epics From Prime

Prime runs installed skills with an explicit prefix. In a Prime thread the
canonical forms are:

```text
/skill:plan-epic <subject>
/skill:cook-epic <epic-id>
```

Typing `/plan-epic` or `$plan-epic` also works: the server rewrites the command
to `/skill:<name>` when Prime reports that skill as installed. When Prime does
not report it, the workspace skill body expands inline instead.

Prime reads its own skills directory. `skills/install.sh` links the canonical
skills into `${PRIME_SKILLS_DIR:-~/.prime/skills}`. Set `PRIME_SKILLS_DIR` when
Prime keeps its skills somewhere else. The installer skips Prime with a printed
reason when neither directory exists.

## Prime And Epic Runs

Prime works as both an EpicRunner origin and a terminal `cook-epic` worker.

- Cooking an epic from a Prime thread sends `inheritOriginModelSelection: true`,
  so the run keeps that thread's exact Prime instance, model, and options.
- In a terminal, `skills/cook-epic/run.sh` detects the harness from the binary
  name, or you set `COOKEPIC_HARNESS=prime`. Prime takes the prompt as an
  argument after `--`, never on stdin.
- Prime reports no per-iteration cost, so a Prime run shows no spend.
- Automatic fallback runs Prime → Claude → Codex → Kimi. Prime is a source only.
  Nothing ever falls back **to** Prime. Only structured Prime failure records
  move a run forward; assistant prose never does.

Ownership, locks, and recovery are the same for every provider. See
[Run an epic from a terminal or T3 Code](../epic-runs.md).

## Packaged Desktop App Cannot Find Prime

The packaged desktop app does not inherit the PATH of the terminal you use. On
macOS and Linux it hydrates PATH from a login shell, so a `prime-agent` that
your shell profile puts on PATH is usually found.

If the card still says the CLI is not installed:

1. Find the real path: `command -v prime-agent`.
2. Put that absolute path in the instance's `Binary path`.
3. If Prime needs extra variables, put them on the instance's Environment
   variables, not in shell startup files.

## Test The Prime UI Without The Real CLI

The repository ships a fake Prime RPC process,
[`apps/server/scripts/prime-rpc-mock.ts`](../../apps/server/scripts/prime-rpc-mock.ts).
Point an instance's `Binary path` at a shell wrapper that execs it:

```bash
#!/usr/bin/env bash
exec node /abs/path/to/t3code/apps/server/scripts/prime-rpc-mock.ts "$@"
```

Then start the dev server with a scenario:

```bash
T3_PRIME_RPC_SCENARIO=health-ready vp run dev --home-dir <base-dir>
```

Other scenarios include `health-unauthenticated`, `health-no-models`,
`version-timeout`, `version-nonzero`, `malformed`, `eof`, and `exit`. Provider
and cook-epic tests use fake Prime processes only. They need no credentials, no
network, and no running Prime daemon.
