# Restura — Roadmap

Current version: **v0.7.1**

This is an honest picture of what's done, what's being worked on, and what's next. It's not a commitment or a sprint board — things move around based on what surfaces as the most painful problem.

---

## What's shipped

### Protocol support

- HTTP/REST — all methods, body types, cookies, code gen (cURL, JS, Python, Go, Ruby, PHP)
- GraphQL — query builder, schema introspection, subscriptions
- gRPC — unary calls, server streaming, server reflection
- WebSocket — connect, send/receive, full message history
- Socket.IO — emit/listen, acks, full transcript (desktop)
- Server-Sent Events — live stream viewer with reconnection
- Kafka — produce/consume, SASL + TLS (desktop)
- MQTT — publish/subscribe, QoS levels, TLS (desktop)
- MCP — proxy to any MCP server, and Restura can expose itself as one

### Auth

Basic, Bearer, API Key, OAuth 2.0 (auth code with PKCE, client credentials, device, password), OAuth 1.0, Digest, NTLM, AWS SigV4, WSSE, mTLS (desktop). Auth signs at the wire — in the Worker or Electron main process — not in the renderer.

### Collections and environments

Folder hierarchy, environment variables with `{{variable}}` substitution, collection-level auth inheritance, multi-tab request model, request history with favorites.

### Import / export

Postman v2.1 (import + export), Insomnia (import + export), OpenAPI / Swagger (import), Bruno (import), Hoppscotch (import), OpenCollection (import + export), cURL (import). HAR import is not done yet.

### Scripting

Pre-request and test scripts in a QuickJS WASM sandbox — memory and time capped, no DOM, no network. Native `rs.*` API with full Postman `pm.*` compatibility.

### Workflows

Request chaining with branching, switches, loops, and parallel steps. Variable extraction via JSONPath, regex, or headers. Retry with fixed or exponential backoff. Visual builder.

### CLI runner

`restura-cli` runs OpenCollection collections in CI with JUnit, HTML, and JSON reporters.

### Load testing

Collection-based load runner with configurable concurrency and duration.

### Mock server

Local mock server for stubbing responses without a real upstream (desktop).

### AI

Chat panel with OpenAI, Anthropic, or OpenRouter. Sees the current request and response as context. Secrets and URLs redacted before reaching the model. BYO API key, stored in OS keychain.

AI Lab (desktop) — multi-model playground, datasets, eval runner with LLM-as-judge, OpenAPI-driven test generation.

### Contract testing

Import OpenAPI specs and validate responses against them.

### Platforms

Web app (Cloudflare Pages + Worker), desktop app (Electron — macOS, Windows, Linux), self-hosted Docker image. Same UI on all three — one React renderer.

### Editor & browser integrations

- **VS Code extension** (`extension/vscode`) — OpenCollection language support (schema diagnostics), a native Test Explorer backed by the `restura` CLI, and inline Send through the shared protocol core. See [ADR 0025](adr/0025-vscode-extension.md).
- **Browser capture extension** (`extension/chrome`, Phase 1) — captures multi-protocol browser traffic (HTTP, GraphQL, WebSocket, SSE, gRPC-web) via the Chrome DevTools Protocol, redacts secrets, and exports to OpenCollection/HAR or pushes to the desktop app over a loopback bridge. See [ADR 0024](adr/0024-browser-capture-extension.md).

---

## Actively being worked on

- **gRPC client streaming and bidirectional streaming** — unary and server streaming are done; the bidirectional path is next.
- **Test coverage** — currently patchy in places, working toward meaningful coverage on the protocol core and IPC layer.
- **Accessibility** — keyboard navigation and screen reader support needs work, particularly in the workflow builder and response viewer.

---

## What's next (no fixed dates)

These are things that are clearly needed and will happen, roughly in order of how much they're being asked for.

**HAR import** — useful for capturing real browser traffic and replaying it. Not complicated, just not done yet.

**OpenAPI export** — you can import OpenAPI, you should also be able to export to it. The reverse path.

**Environment export** — environments can't currently be exported standalone, only as part of a collection. That's a gap.

**WebSocket bidirectional scripting** — the scripting sandbox currently works for HTTP request/response. Extending it to WebSocket (run a script on each incoming message) is on the list.

**AI on web** — the AI assistant currently only works on the desktop app because there's no `/api/ai` route in the Worker. Adding web support requires some care around API key handling in the browser, but it's wanted.

**Connect/gRPC transcoding** — the echo Worker uses Connect for gRPC over HTTP/2. Bringing that to the web client so gRPC works without the desktop app.

---

## What we're probably not doing

**Cloud sync and shared workspaces** — the whole point of Restura is that your data stays on your machine. Adding cloud sync would mean becoming the thing we were trying to avoid. If you want to share collections across a team, self-host a Docker instance and share that — that's the intended path.

**Plugin marketplace** — a plugin system is interesting but a marketplace is a product in itself. Not something we're taking on.

**SSO and enterprise auth** — Restura doesn't have accounts, so SSO doesn't have anywhere to attach to. If this is something you need, the self-hosted Docker path with your own reverse proxy and auth layer in front is the right model.

---

## Longer term, no timeline

These are things that would be good to have but aren't being actively planned.

- JetBrains extension for in-editor request execution (the VS Code extension has shipped — see above)
- Natural-language to request builder (describe what you want, get a request)
- Scheduled test runs
- Audit logging for the self-hosted deployment

---

## How to influence this

Open an issue or add a 👍 to an existing one. The things that get built fastest are the ones where it's clear someone actually needs them — a concrete use case is worth more than a vote count.

[Feature request template](https://github.com/dipjyotimetia/restura/issues/new?template=feature_request.md) · [CONTRIBUTING.md](../CONTRIBUTING.md)

---

_Last updated: June 2026_
