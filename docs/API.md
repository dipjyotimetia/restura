# Restura - API Reference

The HTTP API served by the Restura backend. One Hono app (`createApp` in `worker/app.ts`) runs in both the Cloudflare Worker (`api.restura.dev`, `worker/index.ts`) and the self-hosted Node/Docker server (`worker/node-entry.ts`), so everything below applies to both unless noted. The desktop app does not use this API — it talks to the Electron main process over IPC.

The Zod schemas named below are the source of truth for request shapes; this page summarises them.

## Table of Contents

- [Endpoints](#endpoints)
- [Authentication](#authentication)
- [CORS, request IDs, and rate limiting](#cors-request-ids-and-rate-limiting)
- [`POST /api/proxy`](#post-apiproxy)
- [`POST /api/import/fetch`](#post-apiimportfetch)
- [gRPC and MCP](#grpc-and-mcp)
- [WebSocket: `/api/ws-ticket` + `/api/ws`](#websocket-apiws-ticket--apiws)
- [Health, feature flags, and telemetry](#health-feature-flags-and-telemetry)
- [Where the internal APIs are documented](#where-the-internal-apis-are-documented)

## Endpoints

| Method | Path                   | Auth   | Purpose                                                                    | Handler                                                             |
| ------ | ---------------------- | ------ | -------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `GET`  | `/health`              | none   | Liveness: `{ status: 'ok', version }`                                      | `worker/app.ts`                                                     |
| `GET`  | `/ready`               | none   | Readiness: `{ status: 'ready', version }`                                  | `worker/app.ts`                                                     |
| `POST` | `/api/proxy`           | yes    | HTTP/GraphQL upstream proxy (SSRF guard, body building, wire auth signing) | `worker/handlers/proxy.ts`                                          |
| `POST` | `/api/import/fetch`    | yes    | Fetch a public import artifact (OpenAPI, collection) by URL                | `worker/handlers/remote-import.ts`                                  |
| `POST` | `/api/grpc`            | yes    | gRPC unary + server streaming over Connect                                 | `worker/handlers/grpc.ts`                                           |
| `POST` | `/api/grpc/reflection` | yes    | gRPC server reflection                                                     | `worker/handlers/grpc-reflection.ts`                                |
| `POST` | `/api/grpc-web`        | yes    | gRPC-Web unary + server streaming (NDJSON event stream)                    | `worker/handlers/grpc-web.ts`                                       |
| `POST` | `/api/mcp`             | yes    | MCP client proxy (streamable HTTP)                                         | `worker/handlers/mcp.ts`                                            |
| `POST` | `/api/mcp/terminate`   | yes    | End an MCP session (upstream `DELETE` with `Mcp-Session-Id`)               | `worker/handlers/mcp-terminate.ts`                                  |
| `POST` | `/api/ws-ticket`       | yes    | Mint a one-shot ticket for the WebSocket proxy                             | `worker/handlers/ws-ticket.ts`                                      |
| `GET`  | `/api/ws?ticket=<id>`  | ticket | WebSocket upgrade to the upstream named by the ticket                      | `worker/handlers/websocket.ts` (Worker), `websocket-node.ts` (Node) |
| `GET`  | `/api/feature-flags`   | public | Protocol kill-switch flags                                                 | `worker/handlers/feature-flags.ts`                                  |
| `POST` | `/api/telemetry/error` | public | Scrubbed renderer error reports (opt-out)                                  | `worker/handlers/telemetry.ts`                                      |

The self-hosted server also serves the SPA from `RESTURA_STATIC_ROOT` on the same port.

## Authentication

`/api/*` routes (except the two public ones above and CORS preflights) go through `proxyAuthMiddleware` in `worker/app.ts`:

1. If `WORKER_PROXY_TOKEN` is set, the request must carry it as `X-Restura-Proxy-Token: <token>` or `Authorization: Bearer <token>` (constant-time compare). Otherwise `401`.
2. Else, if `REQUIRE_CF_ACCESS=true`, a `Cf-Access-Authenticated-User-Email` header from a trusted reverse proxy is required. Otherwise `401`.
3. Else the API fails closed with `503` ("Worker proxy authentication is not configured").

Local development bypasses the gate only under Miniflare (auto-detected) or with `DEV_BYPASS_AUTH=true` in `.dev.vars`. Never set `DEV_BYPASS_AUTH` in a deployed config. See [Self-hosting](SELF_HOSTING.md#auth-modes) for the reverse-proxy mode.

## CORS, request IDs, and rate limiting

- **CORS** — `ALLOWED_ORIGIN` is a comma-separated allow-list (supports `*` wildcards). In production with no `ALLOWED_ORIGIN`, no cross-origin access is granted (same-origin SPA requests still work); local dev allows the Vite/localhost origins.
- **Request IDs** — every `/api/*` request gets an `x-restura-request-id` (a valid incoming one is kept, otherwise one is minted) that is propagated across redirects and echoed on the response (`worker/middleware/requestId.ts`).
- **Rate limiting** — `worker/middleware/rateLimiter.ts`, keyed by client IP plus a fingerprint of the proxy token / Access identity (`shared/protocol/rate-limiter.ts`). Cloudflare uses the Workers rate-limiting binding; self-hosted uses a per-process in-memory limiter (`RATE_LIMITER=map`), so put a shared limiter in your reverse proxy when running multiple replicas. See [Self-hosting § Rate limiting](SELF_HOSTING.md#rate-limiting) and [ADR 0018](adr/0018-rate-limiting-strategy.md).

## `POST /api/proxy`

Request body — `ProxyRequestBodySchema` in `shared/protocol/proxy-schema.ts`:

| Field                                                | Type                                                                         | Notes                                                                                                                                                           |
| ---------------------------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `method`                                             | `string`                                                                     | Any RFC 9110 method token (≤ 64 chars); `CONNECT`, `TRACE` and `TRACK` are refused in any casing. See [Methods](#methods).                                    |
| `url`                                                | `string` (≤ 2048)                                                            | Absolute URL; validated by the SSRF guard (`shared/protocol/url-validation.ts`).                                                                                |
| `headers`                                            | `Record<string, string>`                                                     | Sanitised by `shared/protocol/header-policy.ts` (hop-by-hop and forbidden headers dropped).                                                                     |
| `params`                                             | `Record<string, string>`                                                     | Appended to the query string.                                                                                                                                   |
| `bodyType`                                           | body type enum                                                               | JSON / text / form-urlencoded / form-data / binary — built by `shared/protocol/body-builder.ts`.                                                                |
| `data`                                               | `string` (≤ 50 MB)                                                           | Raw body.                                                                                                                                                       |
| `formData`                                           | `{ name, value, filename?, contentType? }[]`                                 | Multipart fields.                                                                                                                                               |
| `timeout`                                            | `number` ms (0–300 000)                                                      |                                                                                                                                                                 |
| `auth`                                               | `ProtocolAuthConfig`                                                         | AWS SigV4, OAuth 1.0a, and WSSE are signed here against the final bytes (`shared/protocol/auth-signer.ts`). Digest is not signed up front: the first request goes out without credentials and a same-origin `401` Digest challenge gets one retry (`shared/protocol/digest-auth.ts`, [ADR 0029](adr/0029-digest-auth-challenge-retry.md)). `SecretRef` handles are desktop-only — a body containing one is rejected with `400`. |
| `upstreamProxy`                                      | `{ host, port, … }`                                                          | Explicit upstream HTTP proxy: Cloudflare Sockets API on the Worker (`worker/shared/tcp-proxy.ts`), `node:net` on self-host (`worker/shared/tcp-proxy-node.ts`). |
| `redirectPolicy`                                     | `{ followOriginalMethod?, followAuthHeader?, stripReferer?, maxRedirects? }` | `maxRedirects: 0` disables following; cap 50. Only 301/302/303/307/308 are followed. A Digest retry continues the same hop budget. |
| `encodeUrl`                                          | `boolean`                                                                    |                                                                                                                                                                 |
| `streamingMode`                                      | `boolean`                                                                    | Forces the streaming pass-through (also chosen automatically for SSE/NDJSON `Accept` types).                                                                    |
| `serverCipherOrder`, `minTlsVersion`, `cipherSuites` | —                                                                            | Desktop-only TLS fields; the server rejects requests that set them with `400`.                                                                                  |

Buffered success response (`200`):

```json
{
  "status": 200,
  "statusText": "OK",
  "headers": { "content-type": "application/json", "set-cookie": "a=1; Path=/, b=2; Path=/" },
  "setCookies": ["a=1; Path=/", "b=2; Path=/"],
  "data": "{\"id\":1}",
  "size": 8,
  "bodyEncoding": "base64",
  "timings": { "ttfb": 120, "download": 4 }
}
```

`bodyEncoding: "base64"` appears only for binary content types (`data` is then base64); `timings` only when measured. The body is `data`, not `body` — the renderer's `src/features/http/lib/requestExecutor.ts` reads `proxyResponse.data`. The buffered response is capped at 10 MB. Streaming requests return the upstream bytes as a stream instead.

The response may also carry `bodyNotice` (string): a human-readable note that the body was left undecoded — for example an unsupported or over-stacked `Content-Encoding` — and is shown above the body. Only the desktop (Electron) fetcher decodes bodies itself and sets it; the runtime `fetch` behind this API decodes on its own, so in practice this endpoint omits it.

`setCookies` (`string[]`, optional) lists every upstream `Set-Cookie` field, one entry each. The flat `headers` map holds one string per name, so it can't represent several cookies (RFC 6265 forbids comma-folding them for processing); treat `setCookies` as authoritative and `headers["set-cookie"]` as display-only. It is omitted when the upstream set no cookies.

Streaming responses (SSE / NDJSON, or `streamingMode: true`) are passed through with the upstream headers, **except** `Set-Cookie`. A real `Set-Cookie` header would make the browser store upstream cookies on the Restura origin, so it is never forwarded. Every upstream cookie travels in the `x-restura-set-cookies` response header instead: a JSON array of the raw `Set-Cookie` strings, with non-ASCII characters `\u`-escaped. An `x-restura-set-cookies` header sent by the upstream itself is dropped, so it can't forge cookies into the client's jar. CORS exposes this header (`exposeHeaders`), so a cross-origin SPA can read it.

Errors are `{ "error": "<message>" }` with `400` (validation / SSRF block), `413` (too large), `500`, `502` (upstream failure), or `504` (timeout).

### Methods

`shared/protocol/http-method.ts` is the method policy for every harness. Any RFC 9110 `token` is accepted. The seven standard methods are sent upper-cased; extension methods (`PROPFIND`, `QUERY`, `PURGE`, …) are sent exactly as given, case included. `CONNECT` (would turn the proxy into a tunnel) and `TRACE` / `TRACK` (reflect request headers, credentials included) are refused with `400` in any casing, as is anything that isn't a token.

The hosted Cloudflare Worker has one extra limit: workerd only sends methods from a fixed list — the standard methods, `PURGE`, the WebDAV/DeltaV set (`COPY`, `LOCK`, `MKCOL`, `MOVE`, `PROPFIND`, `PROPPATCH`, `UNLOCK`, `ACL`, `REPORT`, `MKACTIVITY`, `CHECKOUT`, `MERGE`), `SEARCH`, `QUERY`, `NOTIFY`, `SUBSCRIBE`, `UNSUBSCRIBE`, `MSEARCH` and `BAN` — and upper-cases them on the wire. Any other token gets `400` with an error that names the method and points to the desktop app or a self-hosted server (`worker/handlers/proxy.ts`). The self-hosted Node server, the desktop app, and the CLI send any token verbatim. Wire signers see the method as sent: SigV4 signs it as-is, and OAuth 1.0a upper-cases and percent-encodes it in the signature base string (RFC 5849).

## `POST /api/import/fetch`

Body `{ "url": string }` (≤ 2048 chars, 4 KB body cap). Fetches a public import artifact through `shared/import/remote-fetch.ts`. Deliberately narrower than `/api/proxy`: callers cannot set headers, auth, proxies, timeouts, or private-network access — localhost and private IPs are always refused.

## gRPC and MCP

- `/api/grpc` runs `shared/protocol/grpc-proxy.ts` (Connect protocol over HTTP/1.1). `/api/grpc/reflection` runs `shared/protocol/grpc-reflection-proxy.ts`: `ServerReflectionInfo` is bidi-streaming, so it is sent with Connect streaming framing (`application/connect+json`, enveloped messages; v1, then v1alpha) and needs an HTTP/2 upstream hop — Connect servers answer 505 over HTTP/1.1. The Node/Docker entry negotiates h2 over TLS (undici `allowH2`); cleartext h2c upstreams are desktop-only. The body accepts optional `metadata` (the request's resolved metadata + inline auth headers; token-validated, CR/LF rejected, 16 KiB total with no per-entry cap — the same limit as calls, hop-by-hop and proxy headers dropped). Upstream bodies are read with a 10 MB streaming cap (413 / `RESOURCE_EXHAUSTED`). Web supports unary and server streaming; client and bidirectional streaming are desktop-only. Status mapping and Connect envelope framing live in the shared core — see [ADR 0022](adr/0022-grpc-connectrpc-transport.md).
- `/api/grpc-web` runs `shared/protocol/grpc-web-proxy.ts` — a schema-less gRPC-Web relay for endpoints such as Envoy's `grpc_web` filter. Body `{ url, service, method, metadata?, message, timeout?, format? }` where `message` is the base64 protobuf-encoded request (the renderer encodes it from reflection descriptors or a `.proto`) and `format` is `binary` (`application/grpc-web+proto`, default) or `text` (`application/grpc-web-text`). Validation failures are a JSON `400`; otherwise the response is `application/x-ndjson` events — `{type:'headers'}`, one `{type:'message', data:<base64>}` per response message as it arrives, then `{type:'end', grpcStatus, grpcStatusText, grpcMessage?, trailers, size, statusDetails?}` — `statusDetails` is the schema-less decode of a `grpc-status-details-bin` trailer on a non-OK status (well-known `google.rpc` types as JSON, others as raw base64; the renderer re-decodes the raw trailer with the request's schema). Upstream failures, deadline, oversize (10 MB cap) and missing trailers are reported in-band on `end`. Redirects are never followed.
- `/api/mcp` runs `shared/protocol/mcp-proxy.ts` for streamable-HTTP MCP servers; the HTTP-SSE transport is desktop-only. Body `{ url, transport, headers?, sessionId?, protocolVersion?, jsonRpc: { method, params?, id? }, timeout? }`. `id` may be omitted only for `notifications/*` methods: the message goes upstream as a JSON-RPC notification and the reply is `{ ok: true, accepted: true }`. `protocolVersion` (the version negotiated by `initialize`) is sent upstream as `MCP-Protocol-Version` on every method except `initialize`. A successful reply is `{ ok: true, jsonRpc, sessionId?, serverMessages? }`. `serverMessages` holds the JSON-RPC notifications and requests the server sent on the SSE stream before the matching reply (capped at 100). An upstream non-2xx reply becomes a `502` with `upstreamStatus`. The web client treats `upstreamStatus: 404` on a request that carried a session as session expiry: it re-initializes once and retries.
- `/api/mcp/terminate` takes `{ url, transport: 'streamable-http', sessionId, protocolVersion?, headers?, timeout? }` and sends `DELETE` to the MCP endpoint with `Mcp-Session-Id`. It goes through the same `validateMcpSpec` SSRF guard and header policy (`shared/protocol/mcp-session.ts`) and the Node DNS guard. It doesn't follow redirects, and the timeout is capped at 10 s. Upstream `404` and `405` are reported as `{ ok: true, terminated: false }`. The web client calls it on disconnect. There is no standalone `GET` listening stream and no `Last-Event-ID` resumption on web.

Both apply the same SSRF guard as `/api/proxy`. The [capability matrix](CAPABILITY_MATRIX.md) is the authoritative web-vs-desktop breakdown.

## WebSocket: `/api/ws-ticket` + `/api/ws`

Browsers can't set headers on a WebSocket handshake, so the web client uses a ticket exchange:

1. `POST /api/ws-ticket` with `{ target, headers?, protocols? }` (≤ 64 headers, ≤ 8 subprotocols). The target passes the SSRF guard and the spec is stored server-side.
2. The response is `{ ticket, expiresAt }`. Tickets are single-use and expire after 30 seconds.
3. Open `GET /api/ws?ticket=<id>`; the server consumes the ticket and bridges to the upstream WebSocket.

Tickets live in process memory, so a ticket minted on one Worker isolate or self-hosted replica is unknown to another — run a single replica or use sticky sessions. See [Self-hosting § WebSocket tickets](SELF_HOSTING.md#websocket-tickets--single-replica-only).

## Health, feature flags, and telemetry

- `/health` and `/ready` sit outside `/api/*`, so they bypass auth, CORS, and rate limiting — safe for load-balancer and container probes.
- `/api/feature-flags` returns `{ version, asOf, flags: { 'protocol.http': true, … } }` with a 5-minute cache. The renderer fails open if it's unreachable.
- `/api/telemetry/error` accepts scrubbed renderer error reports; free text is redacted and no request URLs, headers, bodies, or identities are kept. See [ADR 0027](adr/0027-telemetry-and-privacy-preserving-usage-analytics.md).

## Where the internal APIs are documented

This file covers the network API only. For in-process APIs, read the source of truth directly:

| Area                                  | Source                                                                                                       |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Shared protocol orchestrators + types | `shared/protocol/` (`types.ts`: `RequestSpec`, `Fetcher`, `ExecuteResult`) — [Architecture](ARCHITECTURE.md) |
| Auth configuration                    | `shared/types/auth.ts` (`AuthConfig`, `SecretValue`) — [ADR 0007](adr/0007-secret-ref-pattern.md)            |
| Zustand stores                        | `src/store/` and `src/features/*/store/` — see `src/store/README.md`                                         |
| Store persistence validation          | `src/lib/shared/store-validators.ts`                                                                         |
| Electron IPC surface                  | `electron/types/api/` (renderer typings) and `electron/main/ipc/validators/`                                 |
| Script sandbox (`rs.*` / `pm.*`)      | `shared/scripts/script-executor.ts` — [Postman compatibility](postman-compat.md)                             |
| Collection formats                    | `shared/opencollection/` — [OpenCollection](opencollection.md)                                               |
| CLI                                   | [`cli/README.md`](../cli/README.md)                                                                          |
