# ADR 0016: Wire-Level Auth Signing

**Status:** Accepted, 2026-04-08

## Context

Some auth schemes sign the actual request bytes: AWS SigV4 hashes the canonical request (method, path, headers, and body), OAuth 1.0a builds an HMAC signature over request parameters, and WSSE derives a password digest. If the renderer computes these signatures and then the proxy (Worker/Electron) reshapes the request — normalizes headers, rebuilds the body, follows a redirect — the signature no longer matches the bytes the upstream receives, and auth fails intermittently and confusingly. The renderer also doesn't see the final wire form. [ADR 0004](./0004-security-hardening.md) established this for SigV4; this ADR records the general principle.

## Decision

Sign **at the wire**, in the backend that emits the final bytes, not in the renderer. Signing happens inside `executeHttpProxy` / `executeHttpProxyStreaming` _after_ body construction and header sanitisation, in the shared protocol layer:

- `shared/protocol/auth-signer.ts` — AWS SigV4, plus dispatch for the other wire-signing schemes.
- `shared/protocol/oauth1-signer.ts` — OAuth 1.0a.
- `shared/protocol/wsse-header.ts` — WSSE UsernameToken.

The renderer still applies the schemes that are just static headers (Bearer, Basic, API key, OAuth 2.0 access token) — those don't depend on the final byte stream. Because the signers live in `shared/`, the Worker, Electron main process, and CLI all sign identically.

## Consequences

**Positive**

- Signatures always match the exact bytes the upstream receives, across all three backends, regardless of body builder or header policy.
- The renderer (and exported collections, logs) never needs the signing secret at request time; it stays on the backend, consistent with [ADR 0007](./0007-secret-ref-pattern.md).

**Negative**

- Auth logic is split: simple header schemes in the renderer, wire-signing schemes in the backend. Contributors must know which side a new scheme belongs on.
- The backend must reconstruct enough request context (region/service for SigV4, realm for OAuth1) to sign, so that metadata has to flow through the `RequestSpec`.

## References

- Code: `shared/protocol/auth-signer.ts`, `shared/protocol/oauth1-signer.ts`, `shared/protocol/wsse-header.ts`, `shared/protocol/crypto-utils.ts`
- Docs: docs-site `/guides/auth/`
- Related: [ADR 0004 (security hardening)](./0004-security-hardening.md), [ADR 0001 (shared protocol layer)](./0001-shared-protocol-layer.md), [ADR 0007 (SecretRef)](./0007-secret-ref-pattern.md)
