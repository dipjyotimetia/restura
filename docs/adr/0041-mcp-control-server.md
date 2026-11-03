# ADR 0041: Desktop MCP control server

**Status:** Accepted, 2026-11-03. Supersedes the hosting and data-loading parts of [ADR 0011](./0011-mcp-server-mode.md); its consent-gating and redaction principles stand and are extended here.

## Context

ADR 0011 shipped Restura-as-an-MCP-server as a headless process (`Restura --mcp-server`) with five read-only tools over a snapshot. That process could never see any data: collections, environments and history live in the renderer's IndexedDB, which another process cannot read, so `mcp-context-loader.ts` returned an empty context and every call was refused. It also could not change anything, and its `execute_request` stub left open whether main should run its own executor.

The goal now is broader: let an agent (Claude Code, Claude Desktop, Codex, Cursor) do what the user does in the app — build collections, folders and requests, manage environments, import specs, send requests and run collections — while the user stays in control. The exploration spec (`docs/superpowers/specs/2026-11-03-mcp-control-server-exploration.md`) phases that work; this ADR records what ships now and what is deferred (see Scope).

## Decision

**Host the server in the running app; the renderer runs every tool.**

- Electron main hosts a streamable-HTTP MCP server on `127.0.0.1` (`electron/main/handlers/mcp-control-server.ts`). Each tool call is forwarded over IPC to the one renderer that turned the server on, parked until that renderer answers (`mcp-control-handler.ts`, `ToolCallBridge`), and bounded by a timeout, an in-flight cap and the agent's own cancellation. A reload or crash of that renderer answers parked calls at once, and new calls are refused ("reloading, retry") until the owner's new page asks for status. The reloaded page then adopts the running server.
- Every window keeps its own in-memory settings, so the owning window decides with the newest settings across windows (`getFreshMcpServerSettings`, by `updatedAt`).
  - When the persisted copy is newer, the window re-reads the whole persisted settings through the store's own `persist.rehydrate()`. This adopts them without writing anything back, so it never overwrites settings another window changed.
  - User edits in Settings refresh first and then apply on top of the newest copy (`updateMcpServerSettingsFresh`), so a stale window cannot undo another window's change.
  - A change made in any window, such as revoking access or turning the server off, applies to the next call.
- The renderer is the single source of truth and the single writer. Tools (`src/features/mcp-server/lib/tools/`) call the same store actions as the UI, so persistence, migrations and validation are shared, and the user watches changes appear. There is no second copy of user data in main.
- Sends go through the collection runner, the same path as the Runner dialog (protocol registry, real executors, SSRF guard, wire-level auth signing, inherited auth, scripts and tests). This settles ADR 0011's open question: main never executes requests for agents.
- `Restura --mcp-server` becomes a stdio shim (`mcp-server-handler.ts`). It exposes the same catalogue and relays each call to the running app, reading the port and token from a `0600` handshake file under userData, so no token goes into an agent's config. It skips the single-instance lock (it must run alongside the app), never opens a store, and retries a call only when the connection was refused, because a send is not idempotent. Main computes the command the agent should launch (`agentLaunchCommand`): the AppImage or Windows portable launcher rather than their temporary extraction paths, the entry script for an unpackaged build, and a custom `RESTURA_USER_DATA_DIR` when one is set. A macOS app running from App Translocation (opened from Downloads or a disk image) has no stable path, so Settings warns instead. Requests up to 40 MiB are accepted by both the SDK handler and its Node adapter, and by the shim's stdio buffer. That covers the largest `import_collection` document even fully JSON-escaped.

**One shared catalogue.** `shared/mcp-server/control-tools.ts` defines each tool once: name, title, description, Zod input schema, tier and honest MCP annotations. Main registers it with the SDK (which validates arguments), the shim re-exposes it, and the renderer re-validates before running. Tiers: `read`, `ui`, `edit`, `destructive`, `execute`.

**Consent, extended.** Collections get `hidden / read-only / edit / full`; `full` adds sending. Environments get `hidden / read-only / edit`, plus a separate per-environment "agents may send with this environment" flag with no default level. History stays `hidden / read-only`. Everything defaults to hidden and the server defaults to off. Creating a collection or environment needs an existing edit grant, and the new item gets an `edit` grant for itself only.

**Approval.** Reads never ask. Edits ask unless the user picks "auto-approve edits". Deletes and sends always ask, and there is no mode that changes that.

- **Scripts always ask.** Any edit or import that adds or changes a pre-request or test script asks in every mode, and the card shows the full code. Agent scripts are capped at 20,000 characters so the card can always show them whole. A script runs with full script powers (variables, vault, cookies, network) on every later send, so the user approves the code itself.
- **Approval is bound to what runs.** Every prepared call carries a fingerprint of the state it depends on: the target collection or environment, and for sends also the environment chain and globals. After approval the runtime re-reads settings and consent, prepares again and compares fingerprints. If anything changed while the card was open, including a change made by a concurrent agent call, the call is refused rather than run.
- **The cards show what will happen.** Update cards show the new values, and send cards show the resolved URL and the scripts that will run.
- **The dialog resists mistakes.** Closing it denies, and Deny is the focused button. Approve is disabled briefly whenever a new card comes to the front.

Every edit, delete and send is logged with the client name (from the client's `initialize` identity: forwarded by the stdio shim, or sent per request by 2026-07-28 clients; older HTTP clients fall back to `User-Agent`). Reversible changes get Undo, which restores the target only while it is still exactly as the agent left it. If anything changed since, the undo refuses rather than discarding the later changes, and undoing in reverse order works. Deleting a collection that is linked to a folder on disk cannot be undone.

**Secrets.**

- Credential fields an agent writes accept only a `{{variable}}` reference.
- Secret values are typed by the user in Restura (`request_secret_variable`) and are never returned to the agent.
- Read tools redact auth descriptors, credential headers and params, URL userinfo, secret variables, SecretRef handle ids and token-like body fields.
- A placeholder such as `(redacted)` that an agent copies back into `update_request` keeps the real saved value when it matches what `get_request` returned. Any other placeholder is refused, so a secret is never overwritten with a mask (`src/features/mcp-server/lib/savedRedaction.ts`).
  - Rows that share a key are matched in order, each saved row at most once.
  - Saved `user:pass@` (which reads strip without a mask) is re-attached to an edited URL only when the scheme and host are unchanged.
  - When `get_request` showed a body truncated (over 100,000 characters after redaction), the agent cannot change it: copying the shown text back keeps the saved body, and any other value is refused.
- Send results mask credential headers and token-like JSON fields and JWTs (on by default), and cap the body.
- Imported documents have their credentials turned into keychain handles.
- No tool changes MCP settings or access, apart from granting `edit` on a collection or environment it has just created. No tool touches AI keys, the vault, proxy or TLS settings, or the updater. A test checks that tool modules never write settings directly.

**Transport security.**

- The listener requires a 256-bit bearer token, compared in constant time.
- It refuses any request with an `Origin`, `Sec-Fetch-Site` or `Sec-Fetch-Dest` header, which blocks browser CSRF. Node's `fetch` sends only `Sec-Fetch-Mode`, which is allowed.
- It refuses non-loopback `Host` headers, which blocks DNS rebinding.
- It rate-limits requests and bounds request read time.
- A fresh token is minted on every start, so a token captured by another local user squatting the port while Restura is closed is useless. A handshake left `running` by a crash is marked stopped when the app starts, and the shim treats a PID it cannot signal (another user's process) as not running. The port is reused when free, and the shim re-reads the handshake on every call.

## Scope

**Shipped now:**
- Read, build, edit, delete and send collections, folders and requests for HTTP, GraphQL, gRPC, SSE and MCP (streamable-HTTP and HTTP+SSE transports).
- Environments and their variables.
- Imports from OpenAPI, Postman, Insomnia, OpenCollection and curl.
- Collection runs.

**Deferred from the exploration spec** and tracked on the roadmap (`mcp-server-next`):
- Creating WebSocket, Socket.IO, Kafka and MQTT connection presets. Their credentials live in the keychain and need their own consent flow.
- HAR import and `export_collection`, plus deleting whole environments.
- Further read tools: the active tab, the last response, capabilities and workflows. Workflows themselves, inline (unsaved) sends, and MCP resources and prompts.
- Reverting a whole session's or turn's changes at once. Undo is per change.
- A status-bar "agent connected" indicator. Status is shown in Settings only.

**Decided against for now:**
- Merging this tool set with the built-in assistant's tools (`src/features/ai/agent/tools.ts`). The assistant's tools act on the active tab with propose-and-apply in its chat panel; these act on saved items with consent and approval cards. Sharing the request builders is the first step if they converge.
- A CLI host (`restura mcp serve`).
- A "trust this session" mode.

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
- An approved agent script runs with the same powers as the user's own scripts. The controls are that the user reads the full script before approving, and that every send also needs approval.
- Adopting newer settings from another window re-reads the whole persisted settings blob. A setting this window changed in the same instant, before its own write was persisted, can be replaced by the other window's copy. The window is a few milliseconds and the user sees the result in Settings.
- HTTP-transport clients must update their token after every restart. The stdio shim is the recommended setup.

## References

- Code: `shared/mcp-server/{control-tools,control-bridge,consent,settings,redaction}.ts`, `electron/main/handlers/mcp-control-{server,handler,protocol}.ts`, `electron/main/handlers/mcp-server-handler.ts`, `src/features/mcp-server/`
- Tests: `shared/mcp-server/__tests__/`, `electron/main/__tests__/mcp-control-*.test.ts`, `electron/main/__tests__/mcp-server-handler.test.ts`, `src/features/mcp-server/lib/__tests__/`, `tests/security/mcp-control-server.test.ts`, `e2e-electron/specs/mcp-control-server.spec.ts`
- User guide: docs-site `/guides/mcp-server-mode/`
- Related: [ADR 0007 (SecretRef)](./0007-secret-ref-pattern.md), [ADR 0011](./0011-mcp-server-mode.md), [ADR 0012 (capability matrix)](./0012-capability-matrix-source-of-truth.md), [ADR 0023 (one execution path)](./0023-ai-lab-http-exec.md)
