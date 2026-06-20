# ADR 0017: Runtime Platform Detection

**Status:** Accepted, 2026-04-08

## Context

The same renderer bundle runs as a Cloudflare Pages SPA and inside Electron. The two differ only in _transport_: on the web, protocol executors call `/api/*` over HTTP; on desktop, they call Electron main-process handlers over the IPC bridge. We need a way for shared renderer code to pick the right transport. Two broad options: compile-time platform builds (separate bundles with dead-code elimination) or a single bundle that branches at runtime.

## Decision

Detect the platform **at runtime** via `isElectron()` in `src/lib/shared/platform.ts` (it checks for the `window.electron` bridge that the context-isolated preload exposes). Each feature's executor branches on `isElectron()` to choose IPC vs. HTTP; there is no behavioural difference beyond transport. This keeps a single bundle and a single code path, with the platform seam isolated to the executor boundary.

## Consequences

**Positive**

- One bundle to build, test, and ship; no per-platform build matrix for the renderer.
- The platform seam is explicit and centralized (`isElectron()` + per-executor branch), easy to reason about.

**Negative**

- A small amount of dead transport code ships to each platform (the unused branch), though it's negligible.
- Renderer code can be tempted to sprinkle `isElectron()` checks widely; the discipline is to confine them to executors/transport selection, not feature logic — capability differences belong in `capabilities.ts` ([ADR 0012](./0012-capability-matrix-source-of-truth.md)).

## References

- Code: `src/lib/shared/platform.ts`, per-feature executors in `src/features/*/lib/`
- Related: [ADR 0012 (capability matrix)](./0012-capability-matrix-source-of-truth.md), [ADR 0001 (shared protocol layer)](./0001-shared-protocol-layer.md)
