# Local T3 Code setup notes (not tracked upstream)

Source build in `~/Projects/t3code`. Built on Vite+ (`vp`) + pnpm workspace.
Node is pinned to 24.18.0 via `mise.toml` (repo wants Node 24; system default is 26).

Run any command below from the repo root. `mise` auto-loads Node 24 here.
`vp` lives at `~/.vite-plus/bin/vp`, `bun` at `~/.local/bin/bun`.

## Run it

- Dev, hot reload (feature work): `bun run dev` → web + server, reloads on save
- Production build: `bun run build`
- Production run (foreground): `bun run start` → opens browser at http://localhost:3773
- Headless server (no browser): `node apps/server/dist/bin.mjs serve`

Pair a browser/device: open the printed `http://localhost:3773/pair#token=...`.
Tokens are short-lived; mint a fresh one anytime:
node apps/server/dist/bin.mjs auth pairing create

Providers must be authed (already are: claude, codex, opencode).

## Survives restarts — systemd --user service

Installed unit: `~/.config/systemd/user/t3code.service`
It runs THIS repo's `apps/server/dist/bin.mjs serve`, Restart=always, linger on
(starts at boot, stays up after logout). Listens on 127.0.0.1:3773.

    systemctl --user status t3code.service
    systemctl --user restart t3code.service     # after a rebuild
    systemctl --user stop t3code.service
    node apps/server/dist/bin.mjs service uninstall   # remove it

Logs: `~/.t3/userdata/logs/boot-service.log` (also `journalctl --user -u t3code.service`)

## Keep it up to date (upstream)

`upstream` = pingdotgg/t3code. `main` mirrors it. Features live on `mine`.

    git fetch upstream
    git switch main && git merge --ff-only upstream/main   # update the mirror
    git switch mine  && git rebase main                    # replay your features
    bun run build                                          # rebuild
    systemctl --user restart t3code.service                # ship it

If deps changed (pnpm-lock.yaml moved): run `vp i` before `bun run build`.

## Add your own features

You're on branch `mine`. Server code: `apps/server/`. Web UI: `apps/web/`.
Shared contracts (WS protocol / schemas): `packages/contracts/`.
`bun run dev` gives hot reload while you work. See `AGENTS.md` and `docs/` for
architecture. When happy: `bun run build` + `systemctl --user restart t3code.service`.
