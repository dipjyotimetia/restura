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

**Persisted state is NOT encrypted at rest by default.** IndexedDB (via
Dexie) on the web platform is protected only by the browser's same-
origin policy. Users who require encryption at rest should either use the
desktop app or — _once the UI lands_ — opt in via:

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
- **gRPC** (`grpc-handler.ts`, request + stream) — `@connectrpc/connect-node`
  exposes `nodeOptions.lookup`, so the gRPC path pins the connect the same way
  the other handlers do (ADR 0022 replaced the old grpc-js IP-literal dial).
- **WebSocket** (`websocket-handler.ts`) — `resolveSafeAddress` +
  `createPinnedLookup` (from `safe-connect.ts`) passed as the `ws` `lookup` option.
- **SSE** (`sse-handler.ts`) — `createPinnedFetch`, an undici dispatcher whose
  `connect.lookup` returns the validated IP.
- **MCP** (`mcp-handler.ts`) — `resolveSafeAddress` + a policy-aware pinned
  fetch supplied to the MCP SDK transport.
- **gRPC reflection** (`grpc-reflection-handler.ts`) — the same pinned
  ConnectRPC dial path as unary and streaming gRPC calls.

**Pre-flight only (`electron/main/security/dns-guard.ts`):** Socket.IO
(`socket.io-client`), Kafka (`assertKafkaBrokersSafe`), and MQTT still resolve +
validate immediately before connect but cannot pin the address, so a TTL=0
rebind between the check and the connect is not mitigated for them.

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

> **Residual gap.** Socket.IO, Kafka, and MQTT remain pre-flight only (plus
> Kafka's post-connect broker auto-discovery). Bringing them onto connect-time pinning is tracked in
> `docs/adr/0006-electron-connection-and-dns-hardening.md`.

> **AI Lab http-exec.** The AI Lab `http-exec` eval target executes an
> **AI-generated** HTTP/GraphQL request and scores the upstream response. It
> does **not** add a new outbound path: it builds an `HttpRequest`
> (`auth: none`) and calls the standard `executeRequest`
> (`src/features/http/lib/requestExecutor.ts`), so the model-authored request
> flows through the same renderer pre-check + proxy-layer SSRF guard, redirect
> policy, and cookie jar as any user-issued HTTP request. Residual risk: the
> model (not the user) chooses the URL/method/body, so a poisoned dataset could
> steer a request to any _public_ endpoint the user could reach manually
> (private/CGNAT/link-local/loopback/metadata stay blocked). The eval builder
> surfaces an explicit warning on this target. See
> `docs/adr/0023-ai-lab-http-exec.md`.

## Renderer lockdown (Electron)

The desktop renderer is sandboxed (`sandbox: true`, `contextIsolation: true`,
`nodeIntegration: false`) and further pinned down by two policies in
`electron/main/main.ts`:

- **Default-deny web permissions** — `session.defaultSession.setPermissionRequestHandler`
  and `setPermissionCheckHandler` reject every web-platform permission except
  `clipboard-sanitized-write` (copy buttons). Everything privileged goes through
  the validated IPC surface instead. Growing the allowlist is an explicit,
  test-guarded change (see ADR-0026).
- **CSP** — production loads enforce `default-src 'self' file:` with
  `object-src 'none'`, `worker-src 'self' file:` (Monaco workers are same-origin
  Vite `?worker` chunks), `wasm-unsafe-eval` only (QuickJS), and no
  `unsafe-eval`. The policy exists twice — a response header in
  `electron/main/main.ts` and a `<meta>` fallback injected at build time in
  `vite.config.mts` (the header is not guaranteed to apply to `file://`
  main-frame documents) — and
  `electron/main/__tests__/security-hardening.test.ts` fails the build if the
  two ever diverge.

## Long-lived connection cleanup (Electron)

`electron/main/ipc/connection-cleanup.ts` is the shared bookkeeping for
streaming handlers that hold open connections per renderer (gRPC, MCP,
SSE, WebSocket, Socket.IO, Kafka, MQTT). It exposes:

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
