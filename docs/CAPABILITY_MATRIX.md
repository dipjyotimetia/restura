# Restura Capability Matrix

> **Generated** from `src/lib/shared/capabilities.ts`. Do not edit by hand.
> CI fails if this file is stale; regenerate with `npm run capabilities:matrix`.

Restura ships as both a Cloudflare Pages SPA (web) and an Electron desktop
app from a single React renderer. Some features depend on capabilities the
browser sandbox doesn't expose (raw sockets, OS keychain, filesystem). This
table documents what works where so you can see the asymmetry at a glance
rather than discover it experimentally.

| Capability | Web | Desktop | Notes |
| --- | :-: | :-: | --- |
| HTTP / REST requests | ✅ | ✅ |  |
| SOCKS5 proxy | ❌ | ✅ | Browser fetch cannot route through SOCKS |
| PAC proxy script resolution | ❌ | ✅ |  |
| mTLS client certificates | ❌ | ✅ | Web build inherits browser cert store; no per-request control |
| Custom CA bundle | ❌ | ✅ |  |
| Manual redirect handling | ✅ | ✅ |  |
| DNS-pinning SSRF guard | ❌ | ✅ | Browser fetch resolves DNS opaquely |
| WebSocket connect | ✅ | ✅ |  |
| WebSocket custom request headers | ✅ | ✅ | Web build proxies through /api/ws-ticket → /api/ws since browser WS API forbids headers |
| WS through Worker (SSRF gate, header policy) | ✅ | ❌ | Desktop uses Node ws directly with the same guards |
| Server-Sent Events | ✅ | ✅ |  |
| SSE with custom headers | ❌ | ✅ | EventSource API in browsers has no headers option |
| MCP streamable-http / http-sse | ✅ | ✅ |  |
| MCP stdio (local subprocess) | ❌ | ✅ |  |
| gRPC unary + streaming | ✅ | ✅ | Web uses Connect transport over HTTP/2 |
| gRPC reflection | ✅ | ✅ |  |
| Kafka produce / consume | ❌ | ✅ | Native broker protocol; no browser TCP |
| Socket.IO client | ✅ | ✅ |  |
| Filesystem-backed collections | ❌ | ✅ |  |
| Git operations on collections | ❌ | ✅ |  |
| OS keychain (safeStorage) for secrets | ❌ | ✅ | Web falls back to encrypted IndexedDB |
| Encrypted local storage | ✅ | ✅ |  |
| Native shell.openExternal | ❌ | ✅ |  |
| Native OS notifications | ❌ | ✅ |  |
| System tray icon | ❌ | ✅ |  |

---

To gate UI on a capability:

```tsx
import { CapabilityBadge } from '@/components/shared/CapabilityBadge';
<CapabilityBadge feature="http.mtls" />
```

To gate logic:

```ts
import { isCapableHere } from '@/lib/shared/capabilities';
import { isElectron } from '@/lib/shared/platform';
if (isCapableHere('http.proxy.socks', isElectron())) {
  // ...
}
```
