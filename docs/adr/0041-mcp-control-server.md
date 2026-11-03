# ADR 0041: Desktop MCP control server

**Status:** Accepted, 2026-11-03. Supersedes the hosting and data-loading parts of [ADR 0011](./0011-mcp-server-mode.md); its consent-gating and redaction principles stand and are extended here.

## Context

ADR 0011 shipped Restura-as-an-MCP-server as a headless process (`Restura --mcp-server`) with five read-only tools over a snapshot. That process could never see any data: collections, environments and history live in the renderer's IndexedDB, which another process cannot read, so `mcp-context-loader.ts` returned an empty context and every call was refused. It also could not change anything, and its `execute_request` stub left open whether main should run its own executor.

The goal now is broader: let an agent (Claude Code, Claude Desktop, Codex, Cursor) do what the user does in the app — build collections, folders and requests for every protocol, manage environments, import specs, send requests and run collections — while the user stays in control.

## Decision

**Host the server in the running app; the renderer runs every tool.**

- Electron main hosts a streamable-HTTP MCP server on `127.0.0.1` (`electron/main/handlers/mcp-control-server.ts`). Each tool call is forwarded over IPC to the one renderer that turned the server on, parked until that renderer answers (`mcp-control-handler.ts`, `ToolCallBridge`), and bounded by a timeout, an in-flight cap and the agent's own cancellation.
- The renderer is the single source of truth and the single writer. Tools (`src/features/mcp-server/lib/tools/`) call the same store actions as the UI, so persistence, migrations and validation are shared, and the user watches changes appear. There is no second copy of user data in main.
- Sends go through the collection runner, the same path as the Runner dialog (protocol registry, real executors, SSRF guard, wire-level auth signing, inherited auth, scripts and tests). This settles ADR 0011's open question: main never executes requests for agents.
- `Restura --mcp-server` becomes a stdio shim (`mcp-server-handler.ts`). It exposes the same catalogue and relays each call to the running app, reading the port and token from a `0600` handshake file under userData, so no token goes into an agent's config. It skips the single-instance lock (it must run alongside the app), never opens a store, and retries a call only when the connection was refused, because a send is not idempotent.

**One shared catalogue.** `shared/mcp-server/control-tools.ts` defines each tool once: name, title, description, Zod input schema, tier and honest MCP annotations. Main registers it with the SDK (which validates arguments), the shim re-exposes it, and the renderer re-validates before running. Tiers: `read`, `ui`, `edit`, `destructive`, `execute`.

**Consent, extended.** Collections get `hidden / read-only / edit / full`; `full` adds sending. Environments get `hidden / read-only / edit`, plus a separate per-environment "agents may send with this environment" flag with no default level. History stays `hidden / read-only`. Everything defaults to hidden and the server defaults to off. Creating a collection or environment needs an existing edit grant, and the new item gets an `edit` grant for itself only.

**Approval.** Reads never ask. Edits ask unless the user picks "auto-approve edits". Deletes and sends always ask, and there is no mode that changes that. Closing the dialog denies, and Deny is the focused button. After approval the runtime re-reads settings and consent and prepares the call again, so revoking access while a card is open wins. Every edit, delete and send is logged with the client name, and reversible changes get Undo.

**Secrets.**

- Credential fields an agent writes accept only a `{{variable}}` reference.
- Secret values are typed by the user in Restura (`request_secret_variable`) and are never returned to the agent.
- Read tools redact auth descriptors, credential headers and params, URL userinfo, secret variables, SecretRef handle ids and token-like body fields.
- Send results mask credential headers and token-like JSON fields and JWTs (on by default), and cap the body.
- Imported documents have their credentials turned into keychain handles.
- No tool reads or writes MCP settings, AI keys, the vault, proxy or TLS settings, or the updater. A test checks that tool modules never touch settings.

**Transport security.**

- The listener requires a 256-bit bearer token, compared in constant time.
- It refuses any request with an `Origin`, `Sec-Fetch-Site` or `Sec-Fetch-Dest` header, which blocks browser CSRF. Node's `fetch` sends only `Sec-Fetch-Mode`, which is allowed.
- It refuses non-loopback `Host` headers, which blocks DNS rebinding.
- It rate-limits requests and bounds request read time.
- The token and port persist across restarts so configured clients keep working. Rotating the token is an explicit action.

## Consequences

**Positive**

- Agents work against the user's real, live workspace with the same request pipeline and security controls as a click on Send.
- One tool definition serves HTTP clients, stdio clients and the renderer, so they cannot drift apart.
- Users can see, approve and undo what agents do, and revoking access takes effect immediately.

**Negative**

- The app must be running; the shim reports this clearly instead of serving stale data. A headless "app closed" mode would need a read-only snapshot (ADR 0011's original plan) and is not built.
- Desktop-only (`mcp.serverMode` in the capability matrix). Web and self-host have no local process to host it, and the CLI does not serve MCP.
- Response bodies are a residual leak path. Redaction is pattern-based, so a credential in an unusual field name can still reach the agent. The approval card and the per-environment send flag are the primary controls, and redaction is defence in depth.
- Response bodies, headers and saved docs are untrusted input to the agent (prompt injection). They are labelled `untrustedContent`, and the approval gates are the real control.
- Saved scripts are returned verbatim, so a secret hard-coded in a script is visible to an agent with read access.

## References

- Code: `shared/mcp-server/{control-tools,control-bridge,consent,settings,redaction}.ts`, `electron/main/handlers/mcp-control-{server,handler,protocol}.ts`, `electron/main/handlers/mcp-server-handler.ts`, `src/features/mcp-server/`
- Tests: `shared/mcp-server/__tests__/`, `electron/main/__tests__/mcp-control-*.test.ts`, `electron/main/__tests__/mcp-server-handler.test.ts`, `src/features/mcp-server/lib/__tests__/`, `tests/security/mcp-control-server.test.ts`, `e2e-electron/specs/mcp-control-server.spec.ts`
- User guide: docs-site `/guides/mcp-server-mode/`
- Related: [ADR 0007 (SecretRef)](./0007-secret-ref-pattern.md), [ADR 0011](./0011-mcp-server-mode.md), [ADR 0012 (capability matrix)](./0012-capability-matrix-source-of-truth.md), [ADR 0023 (one execution path)](./0023-ai-lab-http-exec.md)
