# ADR 0006: Electron Connection Cleanup and Pre-flight DNS Guard

**Status:** Accepted, 2025-12-03

## Context

Two related gaps surfaced in the Electron streaming handlers (gRPC, MCP, SSE, WebSocket, Socket.IO):

1. **Renderer-destroy listener stacking.** Every long-lived-transport handler tracked active connections in a `Map<connectionId, { webContentsId, ... }>` and registered a `webContents.once('destroyed', cleanup)` listener on each new connection. From the same renderer this stacked one fresh listener per reconnect. Node warned at ten listeners (`MaxListenersExceededWarning`); the worse runtime cost was N teardowns firing on close, each walking the full connection map. The pattern was duplicated in five handlers with subtle drift.

2. **DNS-resolved SSRF coverage gap.** `shared/protocol/url-validation` rejects URL strings that point at private literals, localhost, link-local, cloud-metadata, etc. But several Electron transports (`fetch`, `ws`, `socket.io-client`) don't accept a connector-level `lookup` hook. A hostname like `internal-target.attacker.example` passes the string check; only the DNS resolver knows it resolves to `10.0.0.1`. The HTTP/gRPC paths handled this via custom undici dispatchers; WS, Socket.IO, SSE, and MCP didn't, leaving private targets reachable in practice on those transports.

## Decision

Extract both concerns into dedicated, narrowly-scoped modules under `electron/main/` and refactor the streaming handlers to use them.

**Module 1 — `electron/main/connection-cleanup.ts`**

- `bindRendererCleanup(handlerKey, webContents, teardown)`: idempotently registers a single `destroyed` listener per `(handlerKey, webContents.id)` pair. The handler's existing `activeConnections` Map serves as the `handlerKey` (an object identity), so dedupe is per-handler. If `webContents` is already destroyed, calls `teardown` synchronously and returns.
- `disposeByOwner(map, deadId, dispose)`: walks a connection map, invokes `dispose(entry)` on every entry whose `webContentsId === deadId`, swallows per-entry errors so cleanup is best-effort, and deletes the entry.

The dedupe set is held in a module-level `WeakMap<object, Set<number>>` so collected `webContents` IDs are removed automatically. The cleanup helpers do not know about any specific transport — they're pure bookkeeping.

**Module 2 — `electron/main/dns-guard.ts`**

- `assertHostnameSafe(hostname, options)`: resolves `hostname` via `dns.lookup(..., { all: true })`, then calls `assertResolvedAddressAllowed(hostname, address, ...)` from `shared/protocol/url-validation` against every record. If `hostname` is already an IP literal, the resolve step is skipped and the literal is checked directly. Throws on any rejection.
- `assertUrlHostnameSafe(url, options)`: applies the URL-string policy (`validateURL`: scheme allow-list, length, blocked names, literal-IP rules) and then runs the DNS check on the URL's hostname. The default scheme allow-list is `http/https`; the WS handler passes `ws/wss`, Socket.IO passes both pairs.
- Single `DnsGuardOptions` shape: `{ allowLocalhost, allowedSchemes? }`. `allowLocalhost` is wired from the same setting that gates `validateURL` so dev workflows that point at localhost work uniformly.

All streaming handlers in `electron/main/` (`grpc-handler.ts`, `grpc-reflection-handler.ts`, `mcp-handler.ts`, `sse-handler.ts`, `socketio-handler.ts`, `websocket-handler.ts`, `kafka-handler.ts`) call `assertUrlHostnameSafe` (or a transport-specific equivalent for Kafka — see below) before initiating the transport-level connect, and tear down on renderer destruction. The grpc / mcp / sse / socketio / websocket handlers share the `bindRendererCleanup` + `disposeByOwner` helpers; `kafka-handler.ts` does NOT — it predates the shared helpers and uses a per-connection `webContents.once('destroyed', …)` listener wired inside `kafka:connect`. Functionally equivalent but a separate code path; consolidating it onto the shared helpers is tracked as a follow-up.

**Native-binding transports (gRPC, Kafka): pre-flight only with no `lookup` hook**

`@grpc/grpc-js` and `@platformatic/kafka` resolve DNS inside their C++ bindings and don't expose a Node-level `lookup` callback the way `undici` and the Node `http`/`https` agents do. That means the safe-connect IP-pinning trick used for HTTP can't be ported here. We mitigate by calling `assertUrlHostnameSafe` (gRPC: in `makeGrpcRequest` and the `grpc:start-stream` listener; reflection: in `sendReflectionRequest`) or a Kafka-specific equivalent (`assertKafkaBrokersSafe` in `kafka-handler.ts`, which uses `validateURL` with `allowPrivateIPs: true` so production broker clusters on RFC1918 still connect, while cloud-metadata literals and blocked hostnames are rejected) immediately before constructing the client.

gRPC failures are surfaced as `INVALID_ARGUMENT` (code 3) so the renderer can distinguish URL-policy rejections from gRPC-server failures.

**Residual rebind window:** the pre-flight resolves once; if the DNS record is swapped with TTL=0 between the pre-flight and the C++ binding's own internal resolve, the connect lands on the post-swap address. Closing this requires either a custom channel built on top of `grpc-js`'s `subchannel-pool` (substantial) or routing gRPC over our own HTTP/2 stack (impractical given the protoc/protoLoader integration). For Kafka, the cluster also auto-discovers additional brokers via metadata after the first connect — those addresses bypass `assertKafkaBrokersSafe` entirely. Both are accepted limitations documented here.

## Consequences

**Positive**

- Listener-stacking eliminated. A renderer that reconnects N times during its lifetime now has exactly one `destroyed` listener for that handler — not N.
- DNS-resolved SSRF coverage now matches the URL-string policy across every transport. A hostname that resolves to a blocked address fails before the connect happens.
- Cleanup is no longer duplicated. The five handlers share one path for "renderer went away, dispose everything it owned."
- Adding a new streaming handler is now a single pattern to follow, not five inconsistent ones to copy from.

**Negative**

- **Pre-flight only.** True DNS-rebind (TTL=0 swap between the pre-flight resolve and the actual connect) is not mitigated. The complete fix requires a transport-level dispatcher with a `lookup` hook that re-applies `assertResolvedAddressAllowed` at connect time, per transport. That's a larger change and intentionally out of scope here. The pre-flight check raises the bar materially against unsophisticated attackers; the rebind window is small and requires the attacker to control DNS for the user's resolver.
- One extra DNS lookup per connection. For the streaming transports the cost is negligible relative to the connect itself.
- `dns-guard.ts` will reject any hostname that fails to resolve, including transient DNS failures. The previous code path would have surfaced this later as a connect error. Net behavior is the same to the user; the error message just arrives slightly earlier and is slightly different.

## Alternatives considered

- **Use a custom undici dispatcher across all transports.** Rejected for this round — `ws`, `socket.io-client`, and `mcp`'s SSE transport don't share a dispatcher interface. Per-transport dispatchers are the right end-state but require five separate implementations. Pre-flight `dns.lookup` is one module covering all five.
- **Keep cleanup inline in each handler.** Rejected — the dedup logic is non-obvious (every reviewer who saw it asked "why a WeakMap?"). Extracting it is the only way to share intent.
- **`dns.resolve4`/`dns.resolve6` instead of `dns.lookup`.** Rejected — `lookup` respects the OS hosts file and resolver behavior; users with `/etc/hosts` overrides for development would have been broken. `lookup` with `{ all: true }` returns every record across both families.

## Update (2026-05-27): connect-time pinning for ws / sse / grpc

The "pre-flight only" residual rebind window described above is now **closed for
WebSocket, SSE, and gRPC** — they resolve + validate once and then dial the
pinned address rather than letting the transport re-resolve the hostname:

- **WebSocket** (`websocket-handler.ts`): passes `lookup: createPinnedLookup(host, ip)`
  (from `safe-connect.ts`) into the `ws` client options, so the handshake dials
  the validated IP. SNI + Host header stay on the original hostname.
- **SSE** (`sse-handler.ts`): builds its fetcher with `createPinnedFetch(host, ip)`
  (an undici dispatcher whose `connect.lookup` returns the validated IP) via the
  new `fetchImpl` option on `makeFetchFetcher`.
- **gRPC** (`grpc-handler.ts`): `resolveGrpcDialAddress` resolves + validates,
  then `computeGrpcDial` rewrites the dial target to the **IP literal** while
  setting `grpc.default_authority` (and, for TLS, `grpc.ssl_target_name_override`)
  to the original hostname. grpc-js's C++ resolver therefore never gets the
  hostname to re-resolve. This is the IP-literal-target technique the original
  ADR didn't consider — it's far lighter than a custom subchannel pool. The
  pinning logic (`computeGrpcDial`, `createPinnedLookup`) is unit-tested in
  `electron/main/__tests__/dns-rebind-pinning.test.ts`; a live TLS handshake is
  not exercised by the suite, so the authority-override path carries some
  residual untested risk.
- **AI chat + AI Lab** (`ai-handler.ts`, `ai-lab-handler.ts`, via `makePinnedFetcher`
  in `fetch-fetcher.ts`): both build the provider fetcher with
  `createPinnedFetch(host, ip)` + `redirect: 'manual'`, so the request dials the
  validated IP and a 3xx can't bounce to a private/metadata host. Chat is
  cloud-only (`allowLocalhost: false`); AI Lab gates `allowLocalhost` on provider
  kind for local runtimes (Ollama / openai-compatible).

**Pinning tradeoff (every `createPinnedFetch` / `createPinnedLookup` consumer):**
resolution pins to the _first_ validated record (`resolveSafeAddress` →
`records[0]`), so the connector dials a single IP. This intentionally forgoes
Happy-Eyeballs / `autoSelectFamily` IPv6↔IPv4 fallback: on a host whose first
record is an unreachable AAAA, the pinned dial fails where an unpinned fetch
would have fallen back. Accepted as the cost of closing the rebind window;
multi-record pinning is possible future work (see below).

**Still pre-flight only:** `mcp-handler.ts`, `socketio-handler.ts` (socket.io-client
exposes no `lookup` hook), `grpc-reflection-handler.ts`, and `kafka-handler.ts`
(plus Kafka's post-connect broker auto-discovery). These remain accepted
limitations and are the next candidates for the same treatment.

## Out of scope (future work)

- Connect-time pinning for the remaining transports (mcp, socketio, grpc-reflection, kafka).
- Per-transport custom dispatchers with `lookup` hooks for true DNS-rebind protection.
- Multi-record pinning (validate every resolved record, hand the connector the full set) to restore Happy-Eyeballs IPv6↔IPv4 fallback for the pinned transports.
- A unified "destination policy" that takes both the URL-string check and the resolved-address check into one decision point shared with the renderer (currently the renderer has its own less-strict policy because it doesn't have `dns.lookup`).
- Metrics on DNS-guard rejections — observability for "how often does this fire in production" is unwritten.

## References

- Module: `electron/main/connection-cleanup.ts`
- Module: `electron/main/dns-guard.ts`
- Shared validation: `shared/protocol/url-validation.ts` (`assertResolvedAddressAllowed`, `validateURL`, `isPrivateAddress`)
- ADR-0001 (shared protocol layer): `docs/adr/0001-shared-protocol-layer.md`
- ADR-0004 (security hardening): `docs/adr/0004-security-hardening.md`
- Architecture: `docs/ARCHITECTURE.md` § Security § Network, § Electron main process
- Security overview: `docs/security.md`
