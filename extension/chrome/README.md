# Restura Capture (Chrome extension)

Capture real **multi-protocol** browser traffic — HTTP, GraphQL, WebSocket, SSE, and gRPC-web — and turn it into a [Restura](https://restura.dev) collection (or a plain HAR file). This is Restura's answer to Postman Interceptor, built to win on Restura's home turf: protocols beyond plain HTTP, secrets that never leak, and a clean path into the desktop app's collection/AI workbench.

See [ADR 0024 — Browser Capture Extension](../../docs/adr/0024-browser-capture-extension.md) for the design rationale.

> **Phase 1 status.** Targets are **Standalone export** + **Send to Desktop** only. Web-app messaging and a CORS bridge for the web SPA are deferred to later phases.

## Why `chrome.debugger`

MV3's `chrome.webRequest` cannot see response bodies, so rich capture uses the **Chrome DevTools Protocol** (`chrome.debugger`). A single, per-tab attachment streams CDP Network / WebSocket / EventSource events through Restura's shared capture pipeline. The yellow "is debugging this browser" banner is the visible cost of seeing response bodies.

## How it works

The entire capture pipeline lives in [`shared/capture/`](../../shared/capture) — the same backend-agnostic, Zod-typed core the desktop app uses, so the extension and Restura share exactly one audited redaction path (mirrors the `shared/protocol/` pattern).

```
chrome.debugger (CDP)  →  shared/capture/cdp-normalizer  →  CapturedExchange[]
                                                              │
                              shared/capture/secret-extractor (redact → {{name}})
                                                              │
                          ┌───────────────────────────────────┴─────────────────┐
                          ▼                                                       ▼
                shared/capture/to-opencollection                    bridge-client → 127.0.0.1
                shared/capture/to-har  (standalone file export)     (Send to Desktop)
```

- **Service worker** (`src/background/`) owns the single per-tab debugger attachment, feeds events through the shared normalizer, redacts secrets as exchanges complete, and persists the redacted session to `chrome.storage.session` so an MV3 worker restart mid-capture loses nothing (it re-seeds the normalizer and re-attaches on startup).
- **UI** — side panel (`src/sidepanel/`, the request list + start/stop), popup (`src/popup/`), and options page (`src/options/`, where you paste the desktop pairing code).
- **Sinks** (`src/lib/export-actions.ts`, `src/lib/bridge-client.ts`) — standalone OpenCollection/HAR download (no Restura required), or push to the running desktop app.

### Send to Desktop

The desktop app (Settings → Data → Capture bridge) starts a **127.0.0.1-only** receiver and shows a one-time `<port>:<token>` pairing code. Paste it into this extension's options page; sessions are then POSTed to `http://127.0.0.1:<port>/ingest` with the bearer token. The token never leaves the extension except over loopback, and the desktop app shows a **confirmation dialog** before importing — never a silent import.

## Security

- `chrome.debugger` attaches only to the **user-selected tab** and detaches on stop, tab close, or worker teardown.
- **Redaction precedes every persistence, export, and transmit.** `secret-extractor` strips the credential-header denylist, `x-*-(token|key|secret)` headers, and JWT / Bearer / `key=val` / prefixed-provider-token body patterns into `{{name}}` placeholders. Completeness is enforced by a security regression test (`tests/security/capture-redaction.test.ts`).
- The desktop bridge is hardened with loopback bind, per-pairing bearer token, `Origin`/`Host` loopback validation (DNS-rebind / CSRF defence), Zod payload validation, and a body-size cap.

## Permissions

Declared in `public/manifest.json` (MV3, `minimum_chrome_version` 116):

| Permission                     | Why                                                          |
| ------------------------------ | ------------------------------------------------------------ |
| `debugger`                     | CDP capture of request/response bodies (the core capability) |
| `sidePanel`                    | The capture UI                                               |
| `storage`                      | Persist the in-progress session + the desktop pairing        |
| `cookies`                      | Capture cookie context for exchanges                         |
| `tabs`                         | Resolve the active tab to attach to                          |
| `host_permissions: <all_urls>` | Capture traffic on any site the user chooses                 |

## Development

This is an npm workspace (`@restura/extension`). Build is a plain Vite multi-entry MV3 build — [`@crxjs/vite-plugin`](https://github.com/crxjs/chrome-extension-tools) is avoided until it supports Vite 8, so there's no extension HMR but the build is version-proof.

```bash
# From the repo root
npm run build  --workspace @restura/extension      # one-shot build → extension/chrome/dist
npm run dev    --workspace @restura/extension       # vite build --watch
npm run type-check --workspace @restura/extension

# e2e (loads the real unpacked bundle in headless Chromium)
npm run test:e2e:extension
```

Then load the unpacked extension in Chrome: **chrome://extensions** → enable Developer mode → **Load unpacked** → select `extension/chrome/dist`.

> **Note on e2e.** Live `chrome.debugger` capture is not end-to-end tested — Playwright is itself a CDP client, and a second debugger attach on the same target conflicts. `e2e/extension-capture.spec.ts` exercises the UI → storage → shared-export path; the CDP path is covered by normalizer fixtures in `shared/capture/`.

## License

MIT
