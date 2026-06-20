# ADR 0018: Rate Limiting Strategy

**Status:** Accepted, 2026-04-29

## Context

Restura exposes two abuse surfaces that need throttling, and they are very different. The hosted Cloudflare Worker is internet-facing: it proxies arbitrary upstreams for anyone who can reach it, so it needs request-rate limiting to avoid being used as an open relay or DoS amplifier. The Electron main process is local but receives IPC calls from the renderer; a runaway renderer (or a misbehaving script) shouldn't be able to flood a handler and spawn unbounded upstream connections.

## Decision

Apply rate limiting **independently at each boundary**, matched to its threat model:

- **Worker** — `worker/middleware/rateLimiter.ts` throttles inbound `/api/*` requests. This is the internet-facing control, and it complements the production auth gate (`WORKER_PROXY_TOKEN` / Cloudflare Access).
- **Electron** — per-channel IPC rate limiting (`electron/main/ipc-rate-limiter.ts`, e.g. the keyed limiter used by the MQTT/Kafka handlers) bounds how fast the renderer can open connections or fire requests. The earlier monolithic IPC rate-limiter API is **deprecated** in favour of the per-handler keyed limiters introduced alongside the connection-hardening work ([ADR 0006](./0006-electron-connection-and-dns-hardening.md)).

There is intentionally no shared rate-limit abstraction across the two — the runtimes, the units (HTTP requests vs. IPC calls), and the keys (client IP vs. webContents/connection) don't align.

## Consequences

**Positive**

- Each boundary is throttled in the terms that make sense for it; neither is forced into the other's model.
- Per-channel IPC limiting bounds connection-based protocols (MQTT/Kafka) at the handler that owns them.

**Negative**

- Two separate rate-limit implementations to maintain and reason about.
- The deprecated legacy IPC limiter still exists during migration, so contributors must be steered to the keyed-limiter API.

## References

- Code: `worker/middleware/rateLimiter.ts`, `electron/main/ipc-rate-limiter.ts`
- Related: [ADR 0006 (connection + DNS hardening)](./0006-electron-connection-and-dns-hardening.md), [ADR 0009 (shared Hono app factory)](./0009-shared-hono-app-factory.md)
