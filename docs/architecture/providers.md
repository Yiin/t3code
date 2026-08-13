# Provider architecture

The web app communicates with the server via WebSocket using a simple JSON-RPC-style protocol:

- **Request/Response**: `{ id, method, params }` → `{ id, result }` or `{ id, error }`
- **Push events**: typed envelopes with `channel`, `sequence` (monotonic per connection), and channel-specific `data`

Push channels: `server.welcome`, `server.configUpdated`, `terminal.event`, `orchestration.domainEvent`. Payloads are schema-validated at the transport boundary (`wsTransport.ts`). Decode failures produce structured `WsDecodeDiagnostic` with `code`, `reason`, and path info.

Methods mirror the `NativeApi` interface defined in `@t3tools/contracts`:

- `providers.startSession`, `providers.sendTurn`, `providers.interruptTurn`
- `providers.respondToRequest`, `providers.stopSession`
- `shell.openInEditor`, `server.getConfig`

## Drivers and instances

The server ships a static set of drivers in
[`builtInDrivers.ts`](../../apps/server/src/provider/builtInDrivers.ts): `codex`,
`claudeAgent`, `cursor`, `grok`, `kimi`, `opencode`, and `primeAgent`. A driver
says how to build a provider from settings. A **provider instance** is one
configured copy of a driver, and its instance id is the routing identity. A
`providerInstances` entry naming a driver that this build does not ship reads as
an `"unavailable"` snapshot instead of failing the server.

Each driver picks its own transport. Codex speaks JSON-RPC to `codex app-server`.
Cursor, Grok, and Kimi speak ACP through
`apps/server/src/provider/acp/AcpSessionRuntime.ts`. Prime Agent speaks Prime's
own RPC mode over stdio, in
[`PrimeRpcTransport.ts`](../../apps/server/src/provider/prime/PrimeRpcTransport.ts).
Prime deliberately does not go through the shared ACP path, because T3 Code needs
Prime's native permissions, model switching, resume, fork, and rollback.

Whatever the transport, every driver normalizes its native events into
`ProviderRuntimeEvent`, the canonical vocabulary shared by server and client. The
mapper for Prime is
[`PrimeEventMapper.ts`](../../apps/server/src/provider/prime/PrimeEventMapper.ts).

### Permission bridge

Approvals reach the app the same way for every driver, but each driver hooks its
own agent. Codex and the ACP drivers ask through their protocol's approval
request. Prime loads a T3-owned extension with `--no-extensions --extension`, so
only T3 Code's bridge is active in that session. The bridge is fail-closed: no
UI, a failed prompt, or a timeout blocks the tool call. The global runtime mode
reaches Prime as `T3_PRIME_RUNTIME_MODE`.

### Fallback

Automatic provider fallback is a property of epic runs, not of interactive
threads. The chain is Prime → Claude → Codex → Kimi, in
[`providerFallback.ts`](../../packages/epic-core/src/providerFallback.ts). Prime
is a source only; nothing falls back **to** Prime. Only a structured
provider-attributed failure moves a run forward. Assistant prose never does.

## Session lifecycle

An adapter declares what it can do with a session in
`ProviderAdapterCapabilities.sessionLifecycle`
(`apps/server/src/provider/Services/ProviderAdapter.ts`). Today it has one key,
`resume`, which is `"cursor"` or `"unsupported"`. The record is shaped so `fork`
can be added later as another key. `fork` is deliberately not implemented.

- `apps/server/src/provider/Layers/ProviderService.ts` — `startSession` inherits
  the persisted resume cursor when the provider instance id still matches, and
  reports the resulting `sessionOrigin` (`started`, `resumed`, `started-fresh`,
  or `forked`). `describeSessionResume` answers whether a thread could resume,
  without starting or writing anything.
- `apps/server/src/provider/Services/ProviderSessionDirectory.ts` — the
  in-process binding directory. Its `upsert` merges runtime payloads, so an
  absent key keeps the previous value.
- `apps/server/src/persistence/ProviderSessionRuntime.ts` — where the binding and
  its cursor live across a restart.
- `apps/server/src/provider/ProviderDriver.ts` — `ProviderContinuationIdentity`,
  which names the continuation domain a cursor belongs to. It is now persisted
  with the binding, so a reconfigured instance reads as a changed identity rather
  than a silently blank session.

## Client transport

`wsTransport.ts` manages connection state: `connecting` → `open` → `reconnecting` → `closed` → `disposed`. Outbound requests are queued while disconnected and flushed on reconnect. Inbound pushes are decoded and validated at the boundary, then cached per channel. Subscribers can opt into `replayLatest` to receive the last push on subscribe.

## Server-side orchestration layers

Provider runtime events flow through queue-based workers:

1. **ProviderRuntimeIngestion** — consumes provider runtime streams, emits orchestration commands
2. **ProviderCommandReactor** — reacts to orchestration intent events, dispatches provider calls
3. **CheckpointReactor** — captures git checkpoints on turn start/complete, publishes runtime receipts

All three use `DrainableWorker` internally and expose `drain()` for deterministic test synchronization.
