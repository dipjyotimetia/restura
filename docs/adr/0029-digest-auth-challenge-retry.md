# ADR 0029: Digest Auth via Challenge-Retry in the Shared Core

**Status:** Accepted, 2026-10-13

## Context

HTTP Digest (RFC 7616) could be configured, imported, and exported, but no harness sent it ([#861](https://github.com/dipjyotimetia/restura/issues/861)). Digest doesn't fit the wire-signing model of [ADR 0016](./0016-wire-level-auth-signing.md). SigV4, OAuth 1.0a, and WSSE can sign the first request from local inputs. Digest can't: the client needs the server's `401` + `WWW-Authenticate: Digest` challenge (realm, nonce, qop, algorithm) before it can compute a response. It is a two-request exchange, and it interacts with redirects. A challenge can arrive at the end of a redirect chain, and a naive retry would re-send credentials to whichever host issued that final `401`.

Restura sends HTTP from four places: the Cloudflare Worker, the Node self-host server, the Electron main process, and the CLI. Implementing the exchange once per harness would let them drift, which is the failure mode [ADR 0001](./0001-shared-protocol-layer.md) exists to prevent. NTLM has a similar challenge shape but needs a connection-bound three-message handshake that the stateless Worker can't hold, so it is out of scope here.

## Decision

Implement Digest **once, in the shared HTTP core**, as a challenge-retry step around the redirect follower.

- `shared/protocol/digest-auth.ts` is pure (Web Crypto plus a small MD5, no Node APIs). It parses `WWW-Authenticate` (several challenges per field, quoted strings), picks the strongest usable Digest challenge (`SHA-256-sess` > `SHA-256` > `MD5-sess` > `MD5`), and builds the `Authorization: Digest …` header with `qop=auth` (or the legacy RFC 2069 no-qop form).
- `followRedirectsWithDigest` wraps `followRedirects` in `shared/protocol/http-proxy.ts`. Both `executeHttpProxy` and `executeHttpProxyStreaming` use it, so the Worker, self-host server, Electron, and CLI all inherit the behaviour without per-harness code.
- The renderer only flags the request as Digest. The exchange runs where the bytes are sent.

### Security boundary

- **No credentials before the challenge.** The first request carries no Digest credentials in any form.
- **Same origin on every hop.** The challenge is answered only if *every* hop of the redirect chain stayed on the initial origin. Comparing just the first and last hop isn't enough: `A → evil → A` doesn't qualify. A `401` reached through a chain that touched another origin is returned untouched, and so is a non-Digest `401`.
- **Exactly one retry, sharing the redirect budget.** The retry replays the final hop's method (as sent, case preserved), a freshly rebuilt body, and the exact request-target as the digest `uri`. It continues the original `maxRedirects` budget (`FollowRedirectsOptions.hopsUsed`) instead of starting a fresh one, so one request can't follow `2 × maxRedirects` hops. Redirects after the retry pass through the normal cross-origin credential stripping.
- **Secrets resolve at the wire ([ADR 0007](./0007-secret-ref-pattern.md)).** The password goes through the caller's `SecretResolver` in the process that sends the request. On desktop, `SecretRef` handles resolve in the Electron main process and never reach the renderer. The Worker can't resolve handles and rejects a request containing one with `400` before any upstream call. Only the hash goes on the wire, never the password.
- **One redirect owner on desktop.** The Electron HTTP handler used to wrap the shared follower in its own redirect loop, which re-sent the full request config (Digest, `Authorization`, `Cookie`) for 3xx responses the shared follower deliberately returns (300, 304, 305, 306). That bypassed cross-origin credential stripping, so the loop was removed. `followRedirects` now owns redirects on every harness. Desktop returns those statuses as-is, like the web. SOCKS opens a fresh tunnel per fetcher call, so the Digest retry and redirect hops each target the SSRF-validated hop URL.

Pinned by `tests/security/digest-auth.test.ts`, `shared/protocol/digest-auth.test.ts`, and `shared/protocol/http-proxy.digest.test.ts`.

## Consequences

**Positive**

- Digest works the same on web, self-host, desktop, and the CLI. The capability matrix has no platform split for it.
- The redirect and same-origin rules are written once and tested once.
- `UnappliedAuthNotice` no longer shows for Digest. It still shows for NTLM.

**Negative / residual risk**

- **MD5 downgrade.** Restura picks the strongest challenge the server *offers*. Over plain `http:`, an on-path attacker can strip the SHA-256 challenge so only MD5 is left, and can see the exchange anyway. Digest doesn't protect against an active network attacker; use `https:`.
- **Unsupported options.** `qop=auth-int`, `userhash`, and algorithms beyond MD5/SHA-256 (such as `SHA-512-256`) aren't implemented. A challenge that offers only those is treated as unusable, and the `401` is returned as-is.
- **One extra round trip** per request. Restura doesn't cache nonces, so every send costs a challenge.
- **Not on non-HTTP transports.** SSE, WebSocket, gRPC, and GraphQL subscriptions don't use Digest. Code generation emits a comment instead of a header.
- **NTLM is split out** to [#1069](https://github.com/dipjyotimetia/restura/issues/1069). It needs a connection-bound handshake and is expected to be desktop-only.

## References

- Code: `shared/protocol/digest-auth.ts`, `shared/protocol/http-proxy.ts`, `shared/protocol/redirect-follower.ts`, `shared/protocol/crypto-utils.ts`, `electron/main/handlers/http-handler.ts`, `worker/handlers/proxy.ts`
- Docs: docs-site `/guides/auth/`, [`docs/security.md`](../security.md)
- Related: [ADR 0016 (wire-level auth signing)](./0016-wire-level-auth-signing.md), [ADR 0007 (SecretRef)](./0007-secret-ref-pattern.md), [ADR 0001 (shared protocol layer)](./0001-shared-protocol-layer.md), [ADR 0006 (Electron connection hardening)](./0006-electron-connection-and-dns-hardening.md)
