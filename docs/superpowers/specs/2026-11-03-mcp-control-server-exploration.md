# Exploration: Restura Desktop as an agent-controllable MCP server

**Status:** Exploration / pre-ADR · **Date:** 2026-11-03 · **Extends:** [ADR 0011](../../adr/0011-mcp-server-mode.md)

## 1. The idea

The user flips **Settings → MCP Server → On** in the desktop app. Claude (Claude Code, Claude Desktop) or Codex connects, and the agent can do what the user does in the app: build collections and folders, write requests for any protocol, manage environments, import an OpenAPI spec, send requests, run a collection and read the test results. All of this goes through the user's consent rules, and the user watches it happen in the UI as it runs.

Example prompts this should support:

- "Import `openapi.yaml`, group the endpoints into folders by tag, and add a smoke test for each GET endpoint."
- "Set up `staging` and `prod` environments for this collection. Base URLs are X and Y. The token goes in a secret variable, and I'll paste it in myself."
- "Run the *Orders* collection against staging, tell me which tests fail, and fix the request bodies."
- "Here's a curl command from the logs. Save it under *Payments/Refunds* and parameterise the host."

## 2. Where we are today (code facts)

| Piece | State |
|---|---|
| `shared/mcp-server/dispatch.ts` | Five **read-only** tools: `list_collections`, `list_requests`, `list_environments`, `get_environment`, `get_history`. `execute_request` is a stub that always refuses. Dispatch is a pure function over a `McpDispatchContext` snapshot. |
| `shared/mcp-server/consent.ts` | Collections: `hidden / read-only / full`. Environments and history: `hidden / read-only`. Everything defaults to hidden. `canExecute` is wired up but never reached. |
| `shared/mcp-server/redaction.ts` | Deep secret redaction, URL credential stripping, env-var redaction. |
| `electron/main/handlers/mcp-server-handler.ts` | Stdio-only SDK glue that runs when the app is launched as `Restura --mcp-server` (headless, no window). |
| `electron/main/handlers/mcp-context-loader.ts` | **Returns an empty context.** Collections, environments and history live in the renderer's Dexie/IndexedDB, and main cannot read them. The headless process therefore sees no data. |
| Consent UI | Does not exist. |
| `src/features/ai/agent/tools.ts` | A separate tool surface for the built-in assistant: `create_http_request`, `update_http_request`, `set_test_script`, `enrich_docs`. These mutate Zustand stores directly, using propose-and-apply. |
| `electron/main/handlers/capture-bridge-handler.ts` | Existing precedent for a **127.0.0.1 HTTP listener + per-pairing bearer token + handshake file + Origin check → push to renderer**. |

**The main gap:** the current design hosts the server in a separate headless process that has no access to the source of truth. That is fine for a read-only demo. It does not work for "control everything".

## 3. Architecture options

### A. Host the server in the running app, with the renderer executing tools (recommended)

```
Claude Code / Codex / Claude Desktop
        │  stdio                      │  streamable HTTP (127.0.0.1, bearer token)
        ▼                             ▼
 `Restura --mcp-server`  ──────►  Electron main: McpControlServer
   (thin stdio↔loopback shim;       • transport, auth, Origin/Host check
    reads port+token from            • rate limit, audit log
    userData handshake file)         • tool-call → IPC request/response
                                              │  (Zod-validated, correlation id)
                                              ▼
                                  Renderer: agent tool registry
                                     • consent gate → approval UI
                                     • Zustand stores (collections/env/tabs…)
                                     • real requestExecutor (SSRF guard, auth
                                       signing, scripts — no parallel path)
                                     • redaction → result
```

- **One writer and one source of truth.** Agent edits go through the same store actions as clicks, so persistence, migrations, Zod validation and the UI all stay consistent, and the user sees changes appear in real time.
- **Execution reuses `requestExecutor`.** This is the same rule ADR 0023 set for AI Lab `http-exec`. The SSRF guard, wire-level auth signing, PAC/SOCKS/mTLS, pre/post scripts and tests all apply.
- **The stdio shim keeps the agent config simple.** The shim finds the running app's port and token in the `0600` handshake file, so tokens never have to be written into agent config files.
- **Cost:** the app must be running. The shim should fail with a clear message: "Restura isn't running, or MCP server is off".

### B. Sync a renderer snapshot to main, and dispatch in main (the ADR 0011 follow-up plan)

This works for read-only access and allows a "headless, app closed" mode. It does not work for writes. Main would become a second writer with a stale copy, conflicts would have to be resolved, and request execution would need a second executor. **Keep it, at most, as a later read-only fallback for when the app is closed.**

### C. Move persistence for collections and environments into main

This is the cleanest long-term model, but it is a large migration that touches every store and the web build. It is out of proportion to this feature.

**Recommendation: A.** It also resolves the open question in ADR 0011 about whether main proxies to the renderer or runs its own executor: main proxies to the renderer.

## 4. Tool surface (tiers)

Every tool declares honest MCP annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`). Roadmap item #1052 already plans checks for annotation honesty.

| Tier | Tools | Consent needed |
|---|---|---|
| **Read** | existing 5 + `get_request` (full redacted definition, any protocol), `get_collection_tree`, `list_workflows`, `get_active_tab`, `get_last_response(tabOrRequestId)`, `get_capabilities` | `read-only` |
| **Author** | `create_collection`, `create_folder`, `create_request` (http/graphql/grpc/ws/sse/socketio/kafka/mqtt/mcp, discriminated by `type`), `update_request` (JSON-merge patch), `set_scripts` (pre/test), `move_item`, `rename_item`, `create_environment`, `set_variable` (non-secret only), `request_secret_input` (opens a UI prompt; the user types the value and the agent only receives "set"), `set_active_environment`, `import` (OpenAPI/Postman/HAR/curl/Insomnia, via existing importers), `export_collection` (OpenCollection) | new `edit` level |
| **Destructive** | `delete_item`, `delete_collection`, `delete_environment` | `edit` + always-ask approval |
| **Execute** | `send_request(savedId \| inline, environmentId?)` returns a redacted, size-capped response plus test results. `run_collection(id, folder?, env?)` uses the collection runner and returns a summary. | `full` + environment marked "agent may execute" |
| **UI** | `open_request` (focus a tab), `reveal_in_sidebar` | read-only (harmless) |
| **Later** | streaming sessions (`ws_connect/send/read/close`), workflows, mock server routes, load tests, gRPC reflection, git sync | per-feature |

**Out of scope on purpose (the agent must never be able to widen its own access):** MCP consent settings, MCP server settings, AI provider keys, the secret store/vault, proxy/TLS/CA settings, telemetry, auto-update.

**Unify with the assistant's tools.** `src/features/ai/agent/tools.ts` and this server should share one registry, for example `src/features/agent-tools/` with Zod input schemas, store-backed `run`, annotations and a redacted result. The built-in assistant and external agents would then call the same code, and the two tool surfaces cannot drift apart. The pure read-only dispatch in `shared/mcp-server/` stays where it is, for a possible later snapshot fallback (option B).

**MCP resources and prompts (cheap wins):** expose `restura://collection/{id}` and `restura://request/{id}` as resources, and add a few prompts such as "write tests for this collection" or "document this collection".

## 5. Consent and safety model

Today's model already has the right starting point: hidden by default with an explicit opt-in. These are the extensions:

1. **Consent levels.** Collections: `hidden / read-only / edit / full(execute)`. Environments: `hidden / read-only / edit`, plus a per-environment flag **"agents may send requests using this environment"**. That flag is off by default, and the UI warns when it is set on an environment named `prod`.
2. **Approval mode for each session:** *Ask for every change* (default), *Auto-approve edits but ask before execute/delete*, or *Trust this session*. The approval card reuses the assistant's propose-and-apply card and shows a diff of the change. A tool call blocks until the user approves, the request times out, or the user denies it; a timeout or denial returns `isError` with a clear reason.
3. **Visibility.** A status-bar pill shows "Claude Code connected" with the client name from `initialize`. A live **activity log** records every tool call, its arguments (redacted), its result status and the approver. A **kill switch** disconnects the session and rotates the token.
4. **Undo.** Agent mutations are grouped into change sets per session or turn, and a "Revert agent changes" action undoes a whole set. This is the safety net for runs where the agent restructures a collection.
5. **Redaction (ADR 0007).** Outgoing data passes through `postProcessResult` deep redaction. Response headers `Authorization`, `Cookie`, `Set-Cookie` and `Proxy-Authorization` are masked. `SecretRef` handles are never resolved. **Response bodies are a new leak path** (for example a login endpoint that returns a token), so offer a body cap and an optional "redact token-like fields" pass. Document this residual risk.
6. **Prompt injection.** Response bodies and collection docs are untrusted content. Tool results should wrap them (`{"untrusted_content": …}`), and the tool descriptions should say so. The approval gates are the real defence, not the wording.
7. **Transport hardening.** Copy the capture-bridge setup: bind to loopback only, require a 256-bit bearer token, check Host and Origin (DNS rebinding), write the handshake file with `0600` permissions under userData, rotate the token on toggle-off, rate-limit per session, and cap request size. Tool arguments are validated with Zod again in main **and** in the renderer.
8. **IPC.** Use the new channel triple required by CLAUDE.md: Zod schema with `createValidatedHandler`, a preload domain module, and an `electron/types/api/` type, with register/dispose added to `IPC_MODULES`. The renderer replies by correlation id, and main enforces a timeout.

## 6. Connecting Claude / Codex (setup UX)

The Settings screen gets a **"Connect an agent"** panel with copy buttons that show the real executable path:

- **Claude Code:** `claude mcp add restura -- "<Restura path>" --mcp-server` (stdio shim). An HTTP variant can also be shown: `claude mcp add --transport http restura http://127.0.0.1:<port>/mcp --header "Authorization: Bearer <token>"`.
- **Claude Desktop:** the `mcpServers` JSON snippet that is already in the docs-site guide.
- **Codex:** add this to `~/.codex/config.toml`:
  ```toml
  [mcp_servers.restura]
  command = "<Restura path>"
  args = ["--mcp-server"]
  ```
- Optionally, a "Write config for me" button that edits these files after the user confirms. The existing `mcp-import-paths.ts` already knows where they live.

## 7. Parity and capabilities

- **Desktop only.** Add `mcpServer.control`, `mcpServer.execute` and `mcpServer.httpTransport` to `src/lib/shared/capabilities.ts` and regenerate the matrix. On the web build, the settings entry is shown disabled with the explanation "needs the desktop app".
- **CLI (later, optional):** `restura mcp serve --collection ./dir` would serve file-backed OpenCollection directories headlessly, with execution through `cli/src/runner/executors/*`. This would be useful for CI and for agents running on a dev box without the GUI. It is a separate host with its own consent configuration file, and it would need parity tests against the desktop tool schemas.

## 8. Phased delivery

| Phase | Scope | Outcome |
|---|---|---|
| **P0 — make what exists real** | Renderer bridge IPC, loopback HTTP transport, stdio→loopback shim, Settings screen (toggle, consent, connect-an-agent), the 5 existing read tools on live data | Finishes ADR 0011 v1. Delivers real value right away: agents can read real collections. |
| **P1 — authoring** | Shared agent-tool registry (migrate the assistant's tools), author-tier tools, approval cards, activity log, undo change sets, `request_secret_input` | "Build my collection" works. |
| **P2 — execution** | `send_request`, `run_collection`, per-environment execute flag, response redaction/caps, untrusted-content wrapping | "Run and fix the failing tests" works. |
| **P3 — breadth** | imports/exports, workflows, mocks, streaming sessions, resources/prompts, CLI `mcp serve` | "Every feature" coverage. |

Each phase is a small number of PRs split by file ownership, per `docs/agents/delivery.md`. P0 and P1 both need the security-auditor pass because they touch IPC, a new listener and secrets.

## 9. Decisions to make (→ new ADR extending/superseding 0011)

1. Hosting model A (in-app plus shim) versus keeping headless snapshot dispatch. *Recommend A.*
2. Unify the assistant's tools and the MCP tools into one registry. *Recommend yes.*
3. Default approval mode, and whether "Trust this session" should exist at all.
4. Should the agent ever be able to **write** a secret value? *Recommend no:* use `request_secret_input` so plaintext never goes through the agent's context.
5. Response-body redaction policy and its default size cap.
6. Behaviour when several windows are open (which renderer owns the tools: the focused window, or the main window only).
7. Whether a CLI host (`restura mcp serve`) is in scope, or stays a separate track.

## 10. Files likely touched

- `electron/main/handlers/mcp-server-handler.ts` (HTTP transport and shim mode), new `mcp-control-bridge.ts`, `electron/main/main.ts` (`IPC_MODULES`, startup), `electron/main/ipc/validators/*`, `electron/main/preload/*`, `electron/types/api/*`
- `shared/mcp-server/consent.ts` (new levels and execute flag), `redaction.ts` (response headers/bodies), new shared tool-schema module
- `src/features/mcp-server/` (renderer bridge, approval UI, activity log, settings screen), `src/features/ai/agent/tools.ts` (migrated to the shared registry), `src/store/useSettingsStore.ts`
- `src/lib/shared/capabilities/*` with the regenerated `docs/CAPABILITY_MATRIX.md`, `docs-site/.../guides/mcp-server-mode.mdx`, `docs/ROADMAP.md`, the roadmap tree, and a new ADR
- Tests: `tests/security/` (token, Origin, consent bypass, redaction of responses, no self-escalation tools), `electron/main/__tests__/`, and an e2e-electron spec that drives the server with a real MCP client
