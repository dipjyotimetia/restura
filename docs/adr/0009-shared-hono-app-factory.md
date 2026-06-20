# ADR 0009: Shared Hono App Factory for Worker and Self-Hosted Node

**Status:** Accepted, 2026-01-14

## Context

Restura's HTTP backend ships to two runtimes: a Cloudflare Worker (the web app's `/api/*` proxy) and a single Node process for the self-hosted Docker image (SPA + `/api/*` on one port). These two share almost all of their logic — routing, SSRF validation, header policy, the protocol cores — but differ in a few platform-specific seams: the CONNECT/TCP proxy, native WebSocket upgrades, and DNS guarding. Maintaining two parallel HTTP apps would re-introduce exactly the kind of drift that [ADR 0001](./0001-shared-protocol-layer.md) eliminated for the protocol layer.

## Decision

Express the HTTP app once as a **`createApp(deps)` factory** in `worker/app.ts`. Each runtime composes it with its own adapters:

- `worker/index.ts` — Cloudflare entry. Supplies the Workers Sockets-based TCP proxy (`worker/shared/tcp-proxy.ts`) and Cloudflare WebSocket handling.
- `worker/node-entry.ts` — self-hosted Node entry. Supplies Node-native adapters: `worker/shared/tcp-proxy-node.ts`, `worker/shared/dns-guard-node.ts`, `worker/handlers/websocket-node.ts`, and static-file serving for `dist/web`.

Everything else — the routes (`/health`, `/ready`, `/api/proxy`, `/api/grpc`, `/api/mcp`, `/api/ws`, …), middleware, and the shared protocol cores — lives in the factory and runs identically on both.

One sharp edge is load-bearing and documented in code: `node-entry` must **`Object.assign` onto `c.env`** rather than reassigning it, because `@hono/node-ws` stamps connection state onto that exact object reference. Reassigning breaks WebSocket upgrades silently.

## Consequences

**Positive**

- The self-hosted server and the Worker can never drift on routing or security behaviour — there is one app.
- Adding a route or middleware automatically covers both deployment targets.
- The platform seams are small and explicit (a handful of adapter modules), which keeps the Cloudflare-specific and Node-specific code easy to find.

**Negative**

- The `Object.assign`-onto-`c.env` constraint is a non-obvious trap; it's mitigated only by a code comment and this ADR.
- The factory's `deps` interface is an extra abstraction that every new platform-specific capability must thread through.

## References

- Code: `worker/app.ts`, `worker/index.ts`, `worker/node-entry.ts`, `worker/shared/tcp-proxy-node.ts`, `worker/shared/dns-guard-node.ts`, `worker/handlers/websocket-node.ts`
- Self-hosting guide: `docs/SELF_HOSTING.md`, docs-site `/self-hosting/docker/`
- Related: [ADR 0001 (shared protocol layer)](./0001-shared-protocol-layer.md)
