# ADR 0011: Restura as an MCP Server

**Status:** Accepted, 2026-02-04. Hosting and data loading superseded by [ADR 0041](./0041-mcp-control-server.md) (2026-11-03): the server now runs inside the desktop app, tools run in the renderer, and `--mcp-server` is a stdio relay. The consent and redaction principles below stand.

## Context

Restura is an MCP _client_, but the inverse is also valuable: let an agent (Claude, or any MCP-capable tool) drive Restura — list the user's collections, read an environment, query history — so the agent can construct and reason about requests. This exposes Restura's stored data to an automated, potentially adversarial consumer, which is precisely the threat [ADR 0007](./0007-secret-ref-pattern.md) was written to contain (an agent calling `get_environment` and reading a plaintext AWS secret key).

## Decision

Ship a **Restura-as-MCP-server** mode (`src/features/mcp-server/`, originally hosted by a headless `electron/main/mcp-server-handler.ts` + `mcp-context-loader.ts`; see ADR 0041), with two safety properties baked in:

- **Pure, testable tool dispatch.** The tool surface (`list_collections`, `list_requests`, `list_environments`, `get_environment`, `get_history`) is implemented as pure functions over loaded context, so it is fully unit-testable without Electron.
- **Consent gating + redaction.** Agent access is gated by explicit user consent, and every tool response is run through secret redaction so `SecretRef` handles and inline secrets never reach the agent. This is the concrete consumer that motivated the SecretRef foundation.

The mode is **desktop-only** — it needs a long-lived local process to host the server.

## Consequences

**Positive**

- Agents can build and reason about requests against the user's real collections/environments without ever seeing secrets.
- Pure tool dispatch keeps the security-critical surface easy to test exhaustively.
- Consent gating keeps the user in control of what an agent can read.

**Negative**

- Another agent-readable surface to keep in sync with the redaction policy; any new tool must be audited against [ADR 0007](./0007-secret-ref-pattern.md).
- Desktop-only, so the capability differs across platforms ([ADR 0012](./0012-capability-matrix-source-of-truth.md)).

## References

- Code: `shared/mcp-server/`, `src/features/mcp-server/`, `electron/main/handlers/mcp-server-handler.ts`, `electron/main/handlers/mcp-control-*.ts` (ADR 0041)
- User guide: docs-site `/guides/mcp-server-mode/`
- Related: [ADR 0007 (SecretRef)](./0007-secret-ref-pattern.md), [ADR 0012 (capability matrix)](./0012-capability-matrix-source-of-truth.md)
