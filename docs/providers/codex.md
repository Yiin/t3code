# Codex

This guide is for people who want to use more than one Codex account in T3 Code.

Common reasons:

- use a work account for work projects
- use a personal account for personal projects
- switch to another account when one account hits limits
- keep one shared Codex history instead of maintaining two separate Codex setups

## Turn lifecycle

These rules were tested against `codex-cli 0.146.1` on 2026-08-06.

Do not use a second `turn/start` response as the active turn ID. When a turn is running,
`turn/start` accepts the new input but returns a different turn ID. Codex adds the input to the
running turn. It does not start or queue a turn with the returned ID. No `turn/started` notification
arrives for that ID after the active turn completes. Treat this returned ID as a phantom turn ID.

Use `turn/steer` to add input to a running turn. Set `expectedTurnId` to the ID from the active
`turn/started` notification. A successful response returns that same ID in `turnId`. A wrong ID
fails with JSON-RPC code `-32600` and reports both the expected and active IDs. Steered input emits
the normal `item/started` and `item/completed` user-message notifications on the active turn. It
does not emit a separate steer notification.

Use the active turn ID for `turn/interrupt`. A wrong or phantom ID fails with JSON-RPC code
`-32600`; it is not a silent no-op. A successful interrupt returns `{}`. Codex then emits
`turn/completed` with status `interrupted`. It does not emit `turn/aborted`.

Normal turns emit `turn/completed` with status `completed`. This happens for both fresh threads and
threads opened with `thread/resume` on `0.146.1`.

`turn/steer` first appears in prerelease `0.99.0-alpha.4` and stable `0.99.0`. A method probe on
`0.98.0` returns JSON-RPC code `-32600` with an unknown-variant message. Clients that support older
binaries must treat this response as an unsupported method.

## I Only Use One Codex Account

Use the default provider.

In Settings, your Codex provider can stay like this:

```text
Display name: Codex
CODEX_HOME path: ~/.codex
Shadow home path: empty
```

Log in with Codex normally:

```bash
codex login
```

## I Want Work And Personal Codex Accounts

Use one real Codex home and one shadow home.

Recommended setup:

```text
~/.codex      shared Codex home
~/.codex_p    second account auth
```

The idea is:

- both accounts can see the same T3/Codex sessions
- each account keeps its own login
- existing threads can continue with either account

### Set Up The First Account

Log in normally:

```bash
codex login
```

This is the account used by `~/.codex`.

In T3 Code Settings, name it something obvious:

```text
Display name: Codex Work
CODEX_HOME path: ~/.codex
Shadow home path: empty
```

### Set Up The Second Account

Log in with a separate Codex home:

```bash
mkdir -p ~/.codex_p
CODEX_HOME=~/.codex_p codex login
```

In T3 Code Settings, add another Codex provider:

```text
Display name: Codex Personal
CODEX_HOME path: ~/.codex
Shadow home path: ~/.codex_p
```

The important part is that both providers use the same `CODEX_HOME path`, but only the second one
has a `Shadow home path`.

## Which Account Am I Using?

Open Settings and look at the provider row.

T3 Code shows the authenticated email for providers that report one. Emails are blurred by default;
click the blurred email to reveal it.

Use display names and accent colors to make accounts easy to tell apart in the model picker.

## I Need A Different API Key Or Endpoint

Use the provider's Environment variables section in Settings.

This is useful when a Codex-compatible setup needs account-specific variables. Add the variables to
the provider instance that should receive them, and mark API keys or tokens as sensitive. Sensitive
values are stored as server secrets and are not sent back to the app after saving.

## Can I Switch Accounts In An Existing Thread?

Yes, when both Codex providers share the same `CODEX_HOME path`.

For example:

```text
Codex Work      CODEX_HOME path: ~/.codex
Codex Personal  CODEX_HOME path: ~/.codex, Shadow home path: ~/.codex_p
```

Those two providers are considered compatible for continuation, so the locked model picker can show
both.

If you add a third Codex provider with a completely different `CODEX_HOME path`, T3 Code treats it
as a different workspace. It will not be offered for existing threads created under `~/.codex`.

## If Both Accounts Look The Same

If two Codex providers show the same account or the same unexpected model list:

1. Check the email in Settings.
2. Refresh provider status.
3. Confirm the second provider has `Shadow home path` set.
4. Confirm the shadow directory has its own `auth.json`.
5. If you copied `~/.codex` into the shadow directory, remove everything except `auth.json`.

Example cleanup:

```bash
find ~/.codex_p -mindepth 1 ! -name auth.json -exec rm -rf {} +
```

## When To Use A Separate CODEX_HOME

Use a totally separate `CODEX_HOME path` only when you want a separate Codex workspace.

That means separate sessions and less account switching inside old threads. Most dual-account users
should use the shared-home plus shadow-home setup instead.
