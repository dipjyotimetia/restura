# ADR 0022: gRPC over ConnectRPC (connect-node)

**Status:** Accepted, 2026-06-17. Supersedes the gRPC-transport decision (§3) of [ADR 0003](./0003-streaming-and-http2.md).

## Context

[ADR 0003](./0003-streaming-and-http2.md) shipped the first streaming gRPC support: Connect-Web spoke HTTP/2 to the upstream directly for server-streaming, the Worker stayed in the unary path, and the desktop data plane ran on `@grpc/grpc-js`. Client-streaming and bidi were stubbed as "not yet implemented", and the streaming client (`grpcStreamingClient.ts`) hand-encoded Connect envelopes.

That arrangement accumulated real problems on desktop, all rooted in `grpc-js`:

1. **TLS knobs didn't work.** `grpc-js` has no equivalent of `rejectUnauthorized: false`, so the user's "verify SSL off" setting was silently ignored, and an encrypted client key + passphrase was not handled natively. For a developer tool that routinely hits self-signed staging endpoints and mTLS services, that is a correctness gap, not a nicety.
2. **SSRF IP-pinning was awkward.** The rest of the streaming handlers pin a pre-validated IP at connect time ([ADR 0006](./0006-electron-connection-and-dns-hardening.md)); `grpc-js` did not fit that `lookup`-based pattern cleanly.
3. **Two descriptor/encoding paths.** The web path used runtime descriptors + manual Connect envelopes; desktop used `grpc-js`. The same gRPC call was assembled two different ways, and only one of them could do client/bidi streaming.

## Decision

Adopt **ConnectRPC** as the single gRPC stack across every backend, driven by one backend-agnostic runtime descriptor registry.

- **One descriptor source.** `shared/protocol/grpc-registry.ts` builds `@bufbuild/protobuf` runtime descriptors from reflection or an uploaded `.proto` / FileDescriptorSet — no codegen — and both backends call against it.
- **Web** — the shared proxy (`shared/protocol/grpc-proxy.ts`) speaks the **Connect protocol** (`Connect-Protocol-Version: 1`) through the Worker for unary and server-streaming; browser-direct streaming uses `@connectrpc/connect-web`.
- **Desktop** — `electron/main/handlers/grpc-connect.ts` uses `@connectrpc/connect-node`'s `createGrpcTransport` (native gRPC over real HTTP/2) with an automatic `createConnectTransport` fallback for servers that only speak Connect. `grpc-js` is removed from the data plane.
- **TLS lives in Node's `http2`/`tls` options**, so `rejectUnauthorized: false`, a custom CA, and an encrypted client cert + passphrase all work.
- **SSRF pinning is a `nodeOptions.lookup`** that returns the already-validated IP; the authority / SNI stay on the hostname so certificate validation is unchanged.
- **Client-streaming and bidi now work on desktop** (real h2). The web target keeps unary + server-streaming, since browser `fetch` can't stream a request body.

## Consequences

**Positive**

- "Verify SSL off", custom CAs, and encrypted client certificates actually take effect for gRPC on desktop — closing a silent correctness gap.
- One descriptor registry and one protocol family (Connect) across web and desktop; the hand-rolled envelope path is gone.
- Client/bidi streaming is implemented on desktop, closing the ADR 0003 stub.
- gRPC SSRF pinning is unified with the other streaming handlers' `lookup` pattern (ADR 0006).

**Negative**

- `@connectrpc/connect`, `connect-node`, and `connect-web` are added dependencies.
- Web and desktop have different streaming capabilities (web can't do client/bidi over `fetch`) — recorded in the capability matrix, not hidden.
- The desktop Connect fallback means a gRPC call can land on either native gRPC or the Connect protocol depending on the server; the negotiated path is surfaced in the response, but it is one more thing to reason about.

## Alternatives considered

- **Keep `grpc-js`.** Rejected — no TLS-verification knob, no native encrypted-key handling, an awkward fit for `lookup`-based SSRF pinning, and a second descriptor/encoding path to maintain forever.
- **Generated `bufbuild` clients.** Rejected — Restura is built on _runtime_ proto reflection; codegen breaks the dynamic-descriptor model that lets a user point at any reflection endpoint and call it.
- **`node:http2` directly.** Rejected — that reimplements framing, pooling, and ALPN state machines that `connect-node` already provides.

## References

- Code: `shared/protocol/grpc-registry.ts`, `shared/protocol/grpc-proxy.ts`, `electron/main/handlers/grpc-connect.ts`, `src/features/grpc/lib/grpcStreamingClient.ts`
- History: PR #250 (`feat/grpc-connectrpc-migration`), PR #253 (connect-protocol fallback on desktop)
- Related: [ADR 0001](./0001-shared-protocol-layer.md), [ADR 0003](./0003-streaming-and-http2.md) (superseded in part), [ADR 0006](./0006-electron-connection-and-dns-hardening.md)
