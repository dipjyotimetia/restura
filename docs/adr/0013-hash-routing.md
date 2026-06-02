# ADR 0013: Hash Routing for Cross-Platform Portability

**Status:** Accepted, 2026-06-02

## Context

The same Vite-built SPA must run under two very different URL schemes: `https://` on Cloudflare Pages and `file://` inside the Electron desktop app. Browser-history routing (`createBrowserRouter`) needs a server (or a catch-all rewrite) to serve `index.html` for arbitrary deep paths. Under `file://` there is no server at all, and deep paths simply don't resolve. Maintaining two router configurations — one per target — would be a recurring source of "works on web, blank page on desktop" bugs.

## Decision

Use **`createHashRouter`** for the renderer. All routes live after the `#`, so the browser never asks the server (or the filesystem) for a deep path — `index.html` is always the document, and the router takes over from the fragment. This makes the identical build work unchanged on both Pages and Electron. There is no server-side routing anywhere in Restura.

## Consequences

**Positive**
- One build, one router config, runs identically on `https://` and `file://`.
- No Pages rewrite rules or Electron protocol interception needed for navigation.

**Negative**
- URLs carry a `#` (e.g. `/#/collections/...`), which is slightly less clean and changes how deep-links/anchors behave.
- Server-side rendering is off the table, but Restura is a client-only SPA, so this costs nothing here.

## References
- Code: `src/routes/`, renderer router setup; `vite.config.mts`
- Architecture: `docs/ARCHITECTURE.md` § Routing
