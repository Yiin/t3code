# T3 Code

T3 Code is a minimal web GUI for coding agents (currently Codex, Claude, Cursor, OpenCode, and Prime Agent, more coming soon).

## Installation

> [!WARNING]
> T3 Code currently supports Codex, Claude, Cursor, OpenCode, and Prime Agent.
> Install and authenticate at least one provider before use:
>
> - Codex: install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`
> - Claude: install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`
> - Cursor: install [Cursor CLI](https://cursor.com/cli) and run `cursor-agent login`
> - OpenCode: install [OpenCode](https://opencode.ai) and run `opencode auth login`
> - Prime Agent (early access): install the `prime-agent` CLI and log in with it, then see the [Prime Agent guide](./docs/providers/prime.md)

### Run without installing

```bash
npx t3@latest
```

Tip: Use `npx t3@latest --help` for the full CLI reference.

## Some notes

We are very very early in this project. Expect bugs.

We are not accepting contributions yet.

There's no public docs site yet, checkout the miscellaneous markdown files in [docs](./docs).

## Documentation

- [Getting started](./docs/getting-started/quick-start.md)
- [Remote access](./docs/user/remote-access.md)
- [Keeping T3 Code in sync](./docs/user/server-updates.md)
- [Architecture overview](./docs/architecture/overview.md)
- Provider guides: [Codex](./docs/providers/codex.md), [Claude](./docs/providers/claude.md), [Prime Agent](./docs/providers/prime.md)
- [Operations](./docs/operations/ci.md)
- [Reference](./docs/reference/encyclopedia.md)

## If you REALLY want to contribute still.... read this first

### Install `vp`

T3 Code uses Vite+ so you'll need to install the global `vp` command-line tool.

#### macOS / Linux

```bash
curl -fsSL https://vite.plus | bash
```

#### Windows

```bash
irm https://vite.plus/ps1 | iex
```

Checkout their getting started guide for more information: https://viteplus.dev/guide/

### Install dependencies

```bash
vp i
```

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before opening an issue or PR.

Need support? Join the [Discord](https://discord.gg/jn4EGJjrvv).
