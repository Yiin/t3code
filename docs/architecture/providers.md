# Provider architecture

The web app communicates with the server via WebSocket using a simple JSON-RPC-style protocol:

- **Request/Response**: `{ id, method, params }` → `{ id, result }` or `{ id, error }`
- **Push events**: typed envelopes with `channel`, `sequence` (monotonic per connection), and channel-specific `data`

Push channels: `server.welcome`, `server.configUpdated`, `terminal.event`, `orchestration.domainEvent`. Payloads are schema-validated at the transport boundary (`wsTransport.ts`). Decode failures produce structured `WsDecodeDiagnostic` with `code`, `reason`, and path info.

Methods mirror the `NativeApi` interface defined in `@t3tools/contracts`:

- `providers.startSession`, `providers.sendTurn`, `providers.interruptTurn`
- `providers.respondToRequest`, `providers.stopSession`
- `shell.openInEditor`, `server.getConfig`

Codex is the only implemented provider. `claudeCode` is reserved in contracts/UI.

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
