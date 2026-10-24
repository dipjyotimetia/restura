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

## HTTP request and response handling

### Response decompression limits (desktop)

The Electron HTTP handler decodes `Content-Encoding` itself
(`electron/main/handlers/http-response-stream.ts`), so it bounds the work a
hostile upstream can cause:

- At most **3 stacked codings** are decoded. A longer list is left raw, with a
  notice above the body (`bodyNotice`) instead of an error.
- **zstd** frames needing a window larger than **8 MB** (windowLog 23, RFC 9659)
  are rejected, instead of zstd's 128 MB default.
- The **10 MB** response cap is enforced after **every** decode stage, not just
  on the final output, so an intermediate layer cannot inflate past it.
- HEAD, 204 and 304 responses, and empty bodies, never reach a decoder.

The Worker and self-host server use the runtime `fetch`, which decodes
responses itself.

### gRPC response limits (desktop)

Both connect-node transports in `electron/main/handlers/grpc-connect.ts` set
`readMaxBytes` (and `writeMaxBytes`) to the same 10 MB `MAX_RESPONSE_SIZE`
instead of connect's ~4 GiB default. The limit applies per message: it is
checked against the envelope length prefix before the payload is buffered, and
it is handed to gzip/brotli as `maxOutputLength`, so a decompression bomb is
cut off at the cap. Either trip ends the call with `RESOURCE_EXHAUSTED`
(status 8) for unary, streaming and reflection calls alike.

### HTTP methods

`shared/protocol/http-method.ts` is the single method policy for the Worker,
self-host server, Electron and the CLI. Any RFC 9110 method token is accepted
and sent verbatim (the seven standard methods are upper-cased). `CONNECT`,
`TRACE` and `TRACK` are refused in every casing: `CONNECT` would turn the proxy
into a raw tunnel, and `TRACE` (with IIS's `TRACK` alias) reflects request
headers, credentials included, back to the caller. Persisted and imported state
accepts any token, so one bad method can't invalidate a whole collection; the
refusal happens at send time, and importers downgrade a denied or invalid
method to `GET` with a warning. Pinned by
`tests/security/http-method-policy.test.ts`.

Code generation treats the method as untrusted input, because RFC 9110 `tchar`
includes shell and interpolation metacharacters (`` ` | & $ ' # ``). cURL
snippets (including the network console's "Copy as cURL") quote any method that
isn't plain alphanumeric, and PHP and Ruby snippets emit it as a single-quoted
literal, so a shared collection can't smuggle a command into a pasted snippet.
Pinned by `tests/security/codegen-method-injection.test.ts`.

### Upstream cookies

Responses carry every upstream `Set-Cookie` field as `setCookies: string[]`
(`shared/protocol/set-cookie.ts`), and the cookie jar, Headers view, network
console, scripts and CLI all read from that list.

- **The streaming proxy never sets upstream cookies on the Restura origin.**
  On the Worker and self-host streaming path (SSE / NDJSON), forwarding a real
  `Set-Cookie` header would make the browser store the upstream's cookies for
  the Restura origin, where they'd ride along on later `/api/*` calls. The
  proxy strips `Set-Cookie` and sends the cookies in the
  `x-restura-set-cookies` header (a JSON array). It also drops any
  `x-restura-set-cookies` header the upstream sends, so a server can't forge
  entries into the client's jar.
- **The network console redacts cookie values.** Its Cookies view lists each
  response cookie's name and known attributes (`Domain`, `Path`, `Expires`,
  `Max-Age`, `HttpOnly`, `Secure`, `SameSite`, `Partitioned`, `Priority`), with
  the value replaced by `[REDACTED]`. Unknown attributes are dropped, and the
  raw `set-cookie` header stays fully redacted
  (`src/lib/shared/console-sanitization.ts`).

### Digest auth

Digest (RFC 7616) is answered in the shared HTTP core
(`shared/protocol/digest-auth.ts`), so the Worker, self-host server, Electron
and the CLI apply the same rules. See
[ADR 0029](adr/0029-digest-auth-challenge-retry.md).

- **No credentials before the challenge.** The first request carries no
  Digest credentials in any form.
- **Same origin on every hop.** A `401` Digest challenge is answered only if
  every hop of the redirect chain stayed on the initial origin. A chain that
  touched another origin on any hop (including `A → evil → A`) gets its `401`
  back unanswered, and so does a non-Digest `401`.
- **One retry, shared redirect budget.** Exactly one retry is sent, and it
  continues the original `maxRedirects` budget instead of starting a fresh
  one.
- **Secrets resolved at the wire.** The password is resolved in the process
  that sends the request (Electron main for keychain `SecretRef` handles, per
  ADR 0007); the Worker rejects handles with `400`. Only the hash is sent.
- **Single redirect owner on desktop.** Electron no longer runs its own
  redirect loop around the shared follower. That loop re-sent Digest,
  `Authorization` and `Cookie` for the 3xx statuses the follower deliberately
  doesn't follow (300, 304, 305, 306). Desktop now returns those as-is, like
  the web.
- **Residual risk: MD5 downgrade over `http:`.** The strongest offered
  algorithm is chosen (SHA-256 over MD5), but an on-path attacker on plain
  `http:` can strip the SHA-256 challenge and can see the exchange anyway.
  Use `https:`. `auth-int` and `userhash` are not supported.

Pinned by `tests/security/digest-auth.test.ts`.

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
  fetch supplied to the MCP SDK transport. The desktop-only **stdio** transport
  makes no network connection; it launches a local process instead, gated by a
  native per-launch consent prompt in main with an allowlisted child
  environment ([ADR 0030](adr/0030-mcp-stdio-transport.md)).
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
