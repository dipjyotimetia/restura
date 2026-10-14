# Restura — Roadmap

Current package version: **v1.12.1**

This is an honest picture of what's done, what's being worked on, and what's next. It's not a commitment or a sprint board — things move around based on what surfaces as the most painful problem.

---

## What's shipped

### Protocol support

- HTTP/REST — all methods, body types, cookies, code gen (cURL, JS, Python, Go, Ruby, PHP)
- GraphQL — query builder, schema introspection, subscriptions (on web, subscriptions connect browser-direct rather than through the Worker)
- gRPC — unary calls, server streaming, server reflection, and desktop client/bidirectional streaming; web uses Connect transport. Rich error details (`google.rpc.Status`) are decoded on every harness, and `BadRequest` field violations are highlighted in the request editor
- WebSocket — connect, send/receive, live message log for the session
- Socket.IO — emit/listen, acks, full transcript (web, desktop, and self-hosted)
- Server-Sent Events — live stream viewer; manual reconnect resumes with `Last-Event-ID`
- Kafka — typed produce/consume, batching, streams, transactions, guarded admin, SASL/OAuth + TLS (desktop)
- MQTT — publish/subscribe, QoS levels, TLS (desktop)
- MCP — proxy to any MCP server over streamable HTTP; the legacy HTTP+SSE transport is desktop-only (Restura-as-an-MCP-server is in progress; see below)

### Auth

Basic, Bearer, API Key, OAuth 2.0 (auth code with PKCE, client credentials, device, password), OAuth 1.0, AWS SigV4, WSSE, Digest, mTLS (desktop). Body- and URL-dependent schemes (SigV4, OAuth 1.0, WSSE) sign at the wire — in the Worker or Electron main process — not in the renderer. Digest (RFC 7616) is answered by one retry after a 401 challenge in the shared protocol core. NTLM can be selected and saved, but its handshake is not yet implemented on send (planned).

### Collections and environments

Folder hierarchy, environment variables with `{{variable}}` substitution, collection-level auth inheritance, multi-tab request model, request history with favorites.

### Import / export

Postman v2.1 (import + export), Insomnia (import + export), OpenAPI / Swagger (import), Bruno (import), Hoppscotch (import), OpenCollection (import + export), and one POSIX-shell cURL command (import). Public, credential-free HTTPS URLs can import the existing text collection/spec formats through a bounded backend fetch and mandatory preview. HAR import with mandatory review and OpenAPI 3.0 export are also available.

### Scripting

Pre-request and test scripts in a QuickJS WASM sandbox — memory and time capped, no DOM, no network. Native `rs.*` API with full Postman `pm.*` compatibility.

### Workflows

Expand the safe OWS workflow profile only when each control has a bounded, policy-enforced runtime. The current profile supports sequential, guarded, loop, and recovery controls with typed bindings, timeout/cancellation, and saved HTTP or GraphQL calls. Unsupported transports and inline transport configuration are rejected before execution.

### CLI runner

`restura-cli` runs OpenCollection collections in CI with JUnit, HTML, and JSON reporters.

### Load testing

Collection-based load runner with configurable concurrency and duration.

### Mock server

Local mock server for stubbing responses without a real upstream (desktop).

### AI

Chat panel with OpenAI, Anthropic, or OpenRouter. Sees the current request and response as context. Secrets and environment values are redacted before reaching the model; the request URL is sent as-is ([#977](https://github.com/dipjyotimetia/restura/issues/977)). BYO API key, stored in OS keychain.

AI Lab (desktop) — multi-model playground, datasets, eval runner with LLM-as-judge (incl. pairwise/preference), OpenAPI-driven test generation, an `http-exec` target that executes AI-generated requests through the real request executor, and Arena — round-robin model-vs-model judging with an Elo leaderboard.

### Contract specs

Attach an OpenAPI spec to a collection and generate mock-server routes from it. Validating live responses against the spec is in progress (see below).

### Platforms

Web app (Cloudflare Pages + Worker), desktop app (Electron — macOS, Windows, Linux), self-hosted Docker image. Same UI on all three — one React renderer.

### Editor & browser integrations

- **VS Code extension** (`extension/vscode`) — OpenCollection language support (schema diagnostics), a native Test Explorer backed by the `restura` CLI, and inline Send through the shared protocol core. See [ADR 0025](adr/0025-vscode-extension.md).
- **Browser capture extension** (`extension/chrome`, Phase 1) — captures multi-protocol browser traffic (HTTP, GraphQL, WebSocket, SSE, gRPC-web) via the Chrome DevTools Protocol, redacts secrets, and exports to OpenCollection/HAR or pushes to the desktop app over a loopback bridge. See [ADR 0024](adr/0024-browser-capture-extension.md).

---

## Actively being worked on

- **Test coverage** — currently patchy in places, working toward meaningful coverage on the protocol core and IPC layer.
- **Accessibility** — keyboard navigation and screen reader support needs work, particularly in the workflow builder and response viewer.
- **Contract testing** — the response validator exists and is tested but nothing calls it yet; next is validating on send, then in collection runs and CLI reports.
- **Restura as an MCP server** — the headless stdio server and fail-closed consent model ship; syncing collections to it and a consent Settings screen are next ([ADR 0011](adr/0011-mcp-server-mode.md)).
- **Secret handle management** — migrate the remaining credential fields to desktop secret handles, offer conversion on import, and list handles in Settings ([ADR 0007](adr/0007-secret-ref-pattern.md)).

---

## What's next (no fixed dates)

These are things that are clearly needed and will happen, roughly in order of how much they're being asked for.

**Environment export** — environments can't currently be exported standalone, only as part of a collection. That's a gap.

**WebSocket bidirectional scripting** — the scripting sandbox currently works for HTTP request/response. Extending it to WebSocket (run a script on each incoming message) is on the list.

**AI on web** — the AI assistant currently only works on the desktop app because there's no `/api/ai` route in the Worker. Adding web support requires some care around API key handling in the browser, but it's wanted.

**NTLM execution** — complete the NTLM handshake when sending requests; configuration and credential inheritance already exist. Expected to be desktop-only ([#1069](https://github.com/dipjyotimetia/restura/issues/1069)). Digest shipped in [#861](https://github.com/dipjyotimetia/restura/issues/861).

**Passphrase-protected web storage** — the key provider exists; it needs a Settings screen to set and unlock a passphrase.

**PAC proxy scripts** — desktop handler scaffolding exists, but proxy settings can't select PAC yet.

**WebSocket headers on web** — route browser WebSocket connections through the existing Worker relay so custom handshake headers aren't dropped.

**CLI protocol parity** — WebSocket requests in collection runs, per-domain client certificates, and protobuf bodies.

**More agent model providers** — Azure OpenAI, then Bedrock, then Gemini, each on desktop and the CLI ([#1044](https://github.com/dipjyotimetia/restura/issues/1044)). Today they exist as adapter profiles, not transports.

**AI Lab fixes and next steps** — the [AI Lab review](audits/ai-lab-review-2026-10-12.md) filed 23 bugs and the work below under [epic #1057](https://github.com/dipjyotimetia/restura/issues/1057); security and misleading-status bugs come first. Planned: decision models such as Cloudflare Clef and TypeSafe Jev as a provider kind and a fast eval scorer ([#1049](https://github.com/dipjyotimetia/restura/issues/1049), [#1050](https://github.com/dipjyotimetia/restura/issues/1050)); dataset evals with judges in the CLI ([#1045](https://github.com/dipjyotimetia/restura/issues/1045)); remote agents as tools over A2A ([#1043](https://github.com/dipjyotimetia/restura/issues/1043)). AI Lab stays desktop-only.

**Protocol gaps from the 2026-10-12 review** — the [protocol gap review](audits/protocol-gap-review-2026-10-12.md) filed every confirmed spec, competitor, and product gap as an issue under one epic per area: [HTTP #843](https://github.com/dipjyotimetia/restura/issues/843), [GraphQL #844](https://github.com/dipjyotimetia/restura/issues/844), [gRPC #845](https://github.com/dipjyotimetia/restura/issues/845), [WebSocket #846](https://github.com/dipjyotimetia/restura/issues/846), [Socket.IO #847](https://github.com/dipjyotimetia/restura/issues/847), [SSE #848](https://github.com/dipjyotimetia/restura/issues/848), [Kafka #849](https://github.com/dipjyotimetia/restura/issues/849), [MQTT #850](https://github.com/dipjyotimetia/restura/issues/850), [MCP #851](https://github.com/dipjyotimetia/restura/issues/851), [cross-cutting #852](https://github.com/dipjyotimetia/restura/issues/852), and [docs #853](https://github.com/dipjyotimetia/restura/issues/853). P0s (silent data loss in collection export/save, desktop WebSocket binary frames, CLI MCP, gRPC in the desktop runner and web reflection) come first.

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
- Code sandboxes for evaluated agents — script sandbox first ([#1042](https://github.com/dipjyotimetia/restura/issues/1042)), then an opt-in container provider ([#1055](https://github.com/dipjyotimetia/restura/issues/1055))
- Self-hosted scale-out: Helm chart, shared rate-limit store, upstream mTLS

### Exploring — ideas from the 2026-10-12 protocol gap review

Illustrative, not committed. Each has a feature issue with a design sketch.

- Unified streaming timeline across WebSocket, Socket.IO, SSE, Kafka, and MQTT ([#971](https://github.com/dipjyotimetia/restura/issues/971))
- Stream assertions in the app, reusing the CLI's stream-event script context ([#936](https://github.com/dipjyotimetia/restura/issues/936))
- Saved WebSocket / Socket.IO / MQTT message templates with variables ([#974](https://github.com/dipjyotimetia/restura/issues/974))
- GraphQL operation picker with automatic transport routing ([#903](https://github.com/dipjyotimetia/restura/issues/903))
- Click-through GraphQL errors to query and response locations ([#907](https://github.com/dipjyotimetia/restura/issues/907))
- Code snippets for every protocol, plus `grpcurl` / `buf curl` ([#940](https://github.com/dipjyotimetia/restura/issues/940))
- gRPC schema snapshot and drift check ([#937](https://github.com/dipjyotimetia/restura/issues/937))
- gRPC unknown-field warnings before send ([#944](https://github.com/dipjyotimetia/restura/issues/944))
- MQTT 5 request/response mode with round-trip latency ([#978](https://github.com/dipjyotimetia/restura/issues/978))
- Read-only Kafka topic browser without a consumer group ([#980](https://github.com/dipjyotimetia/restura/issues/980))
- Schema Registry subject picker ([#982](https://github.com/dipjyotimetia/restura/issues/982))
- Kafka / MQTT connection presets as collection items ([#984](https://github.com/dipjyotimetia/restura/issues/984))
- MCP server tests in collections and CI ([#901](https://github.com/dipjyotimetia/restura/issues/901))
- Import `mcp.json` from Claude Desktop, Cursor, and VS Code ([#906](https://github.com/dipjyotimetia/restura/issues/906))
- MCP conformance report across protocol versions ([#911](https://github.com/dipjyotimetia/restura/issues/911))
- One-click "try it" from the docs against the echo server ([#1013](https://github.com/dipjyotimetia/restura/issues/1013))
- Docs capability summary and port tables generated from source ([#1014](https://github.com/dipjyotimetia/restura/issues/1014))
- Docs link and claim checks in CI ([#1015](https://github.com/dipjyotimetia/restura/issues/1015))

### Exploring — ideas from the 2026-10-12 AI Lab review

- Regression datasets from recorded traffic, re-run when the model or prompt changes ([#1051](https://github.com/dipjyotimetia/restura/issues/1051))
- MCP server checks for tool-annotation honesty and agent task completion ([#1052](https://github.com/dipjyotimetia/restura/issues/1052))
- Model drift watch: scheduled evals with regression alerts ([#1053](https://github.com/dipjyotimetia/restura/issues/1053))
- API explorer agent that saves failures as requests and eval cases ([#1054](https://github.com/dipjyotimetia/restura/issues/1054))
- Risk-scored agent tool approvals using a decision model ([#1056](https://github.com/dipjyotimetia/restura/issues/1056))

---

## How to influence this

Open an issue or add a 👍 to an existing one. The things that get built fastest are the ones where it's clear someone actually needs them — a concrete use case is worth more than a vote count.

[Feature request template](https://github.com/dipjyotimetia/restura/issues/new?template=feature_request.yml) · [CONTRIBUTING.md](../CONTRIBUTING.md)

---

_Last reviewed: October 2026_

Explore the public [roadmap](https://docs.restura.dev/roadmap/) and [delivery plan](https://docs.restura.dev/overview/delivery-plan/). Its curated dataset lives in `docs-site/src/data/product-tree.ts`; keep public status changes aligned with this roadmap and current capabilities.
