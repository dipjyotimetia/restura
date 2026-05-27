# Restura storage encryption policy

## Electron desktop

All persisted state is encrypted with a per-install key held in the OS
keychain via Electron's `safeStorage` (macOS Keychain, Windows Credential
Manager, libsecret on Linux). The key is fetched once per session through
the `secureKey` IPC channel and cached in renderer memory.

Plain text only when the OS reports
`safeStorage.isEncryptionAvailable() === false`, in which case the user is
warned at startup.

## Web (Cloudflare Pages)

**Persisted state is NOT encrypted at rest by default.** localStorage and
IndexedDB on the web platform are protected only by the browser's same-
origin policy. Users who require encryption at rest should either use the
desktop app or — *once the UI lands* — opt in via:

```
Settings → Security → "Set workspace passphrase"   (PLANNED, not yet exposed in UI)
```

When enabled, all subsequently-saved state is encrypted with a key derived
from the user-supplied passphrase (PBKDF2, 100k iterations, SHA-256). The
passphrase is held in memory for the session only; closing the tab clears
it. On next page load the user must re-enter the passphrase to decrypt
existing data.

> The opt-in passphrase UI is tracked separately; the runtime hook
> (`setKeyProvider(new WebSessionPassphraseProvider(...))`) is already
> wired through `getKeyProvider()`. See the TODO in
> `src/lib/shared/keyProvider.ts`.

There is no "ephemeral encryption" mode any more — that mode created the
illusion of safety while corrupting data on tab close (the random in-memory
key was regenerated each session, leaving any encrypted blob from the
previous session unrecoverable). The previous default has been replaced by
the `PlaintextKeyProvider`, which stores JSON in IndexedDB without applying
the `ENC:` envelope. Existing ephemeral-key blobs are unreadable by design
and will fail the `decryptValue` round-trip; on read the storage adapter
logs and returns `null`, which is functionally the same outcome the user
was already experiencing on every page refresh.

## Worker (Cloudflare)

The Worker does not store user data. Requests are proxied and forgotten.
Cloudflare's network-level encryption applies; no application-layer
encryption is performed.

## SSRF / DNS-rebind guard (Electron)

All Electron transports validate the destination against the shared SSRF
policy (`shared/protocol/url-validation.ts`) before connecting. They split
into two tiers depending on whether the transport lets us pin the connect to
the address we validated:

**Connect-time pinned (no rebind window):**

- **HTTP** — undici `Agent.connect.lookup` (`createSecureLookup` in
  `http-handler.ts`) re-validates every resolved address at connect.
- **gRPC** (`grpc-handler.ts`, request + stream) — `@grpc/grpc-js` has no
  Node `lookup` hook, so `resolveGrpcDialAddress` resolves + validates once and
  `computeGrpcDial` dials the validated **IP literal** while keeping the original
  hostname as `grpc.default_authority` / `grpc.ssl_target_name_override`.
- **WebSocket** (`websocket-handler.ts`) — `resolveSafeAddress` +
  `createPinnedLookup` (from `safe-connect.ts`) passed as the `ws` `lookup` option.
- **SSE** (`sse-handler.ts`) — `createPinnedFetch`, an undici dispatcher whose
  `connect.lookup` returns the validated IP.

**Pre-flight only (`electron/main/dns-guard.ts`):** Socket.IO
(`socket.io-client`), MCP, gRPC reflection, and Kafka (`assertKafkaBrokersSafe`)
still resolve + validate immediately before connect but cannot pin the address,
so a TTL=0 rebind between the check and the connect is not mitigated for them.

`dns-guard.ts` API (used by the pre-flight tier and by `safe-connect.ts`):

- `assertUrlHostnameSafe(url, { allowLocalhost, allowedSchemes? })` —
  applies the URL-string policy (`validateURL`: scheme allow-list, length,
  blocked names, literal-IP rules) and then runs the DNS resolution check
  on the URL's hostname.
- `assertHostnameSafe(hostname, options)` — DNS-only variant. Used by
  callers that have already validated the URL string separately.
- `resolveUrlHostnameSafe(url, options)` — same checks, but returns the
  resolved records so callers (gRPC, `safe-connect.ts`) can pin without a
  second lookup.

All call `assertResolvedAddressAllowed` from
`shared/protocol/url-validation.ts` against every record returned by
`dns.lookup(hostname, { all: true })`. If `hostname` is an IP literal, the
resolve step is skipped and the literal is checked directly. Any
violation throws synchronously — handlers catch and surface the message
to the renderer.

> **Residual gap.** Socket.IO, MCP, gRPC reflection, and Kafka remain
> pre-flight only (plus Kafka's post-connect broker auto-discovery). Bringing
> them onto connect-time pinning is tracked in
> `docs/adr/0006-electron-connection-and-dns-hardening.md`.

## Long-lived connection cleanup (Electron)

`electron/main/connection-cleanup.ts` is the shared bookkeeping for
streaming handlers that hold open connections per renderer (gRPC, MCP,
SSE, WebSocket, Socket.IO). It exposes:

- `bindRendererCleanup(handlerKey, webContents, teardown)` — idempotent
  per-`(handlerKey, webContents.id)` registration of a single `destroyed`
  listener. Without it, every reconnect from the same renderer stacks a
  fresh listener (Node warns at ten; the worse cost is N teardowns per
  close).
- `disposeByOwner(map, deadId, dispose)` — walks a connection map and
  invokes `dispose(entry)` on every entry whose `webContentsId ===
  deadId`, then deletes the entry. Errors are swallowed (best-effort
  cleanup).

See `docs/adr/0006-electron-connection-and-dns-hardening.md` for the
design decision and the considered alternatives.
