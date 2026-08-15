# Scripts

- `vp run dev` — Starts contracts, server, and web in watch mode.
- `vp run dev:server` — Starts just the WebSocket server. The server process runs on Bun (`@effect/platform-bun` + `BunPtyAdapter`), but task running uses `vp run`.
- `vp run dev:web` — Starts just the Vite dev server for the web app.
- Dev commands implicitly use `~/.t3/dev`, keeping development state separate from `~/.t3/userdata`. An explicit `--home-dir <path>` stores state under `<path>/userdata`; the base directory remains available for caches, worktrees, and other shared data.
- Web dev commands do not auto-open a browser. Open the one-time pairing URL printed by the server so the first browser navigation is authenticated. Set `T3CODE_NO_BROWSER=0` only when interactive auto-open is intentional.
- Pass dev-runner flags directly after the root task name, for example:
  `vp run dev --home-dir /tmp/t3code-dev`
- `vp run start` — Runs the production server (serves built web app as static files).
- `vp run build` — Builds contracts, web app, and server.
- `vp run typecheck` — Strict TypeScript checks for all packages.
- `vp run test` — Runs workspace tests.
- `node apps/server/scripts/t3-sqlite-state.ts <query|exec> --base-dir <path> ...` — Inspects or seeds an isolated T3 SQLite database; writes create a private backup first.

## Running multiple dev instances

Set `T3CODE_DEV_INSTANCE` to any value to deterministically shift all dev ports together.

- Default ports: server `13773`, web `5733`
- Shifted ports: `base + offset` (offset is hashed from `T3CODE_DEV_INSTANCE`)
- Example: `T3CODE_DEV_INSTANCE=branch-a vp run dev`

If you want full control instead of hashing, set `T3CODE_PORT_OFFSET` to a numeric offset.
