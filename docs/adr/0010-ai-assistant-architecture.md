# ADR 0010: AI Assistant Architecture

**Status:** Accepted (feature in active development), 2026-02-04

## Context

Restura ships a chat assistant that can read the current request/response context and talk to OpenAI, Anthropic, or OpenRouter (bring-your-own-key). Two constraints shape the design. First, the assistant must never leak secrets or full URLs to a third-party model — the same secret surface [ADR 0007](./0007-secret-ref-pattern.md) protects. Second, the providers have different wire shapes and streaming formats, but the orchestration (build prompt, attach context, stream tokens, allow cancel) is identical across them.

## Decision

Make the AI path **Electron-first and provider-agnostic**, with the orchestrator in the shared layer.

- Transport: the renderer streams over the IPC bridge — `window.electron.ai` → `ai:chat` / `ai:chat:cancel`, with per-call event channels `ai:chat:chunk:<id>` / `ai:chat:end:<id>` → `electron/main/ai-handler.ts` → `shared/protocol/ai/ai-proxy.ts`. The renderer's `streamConsumer.ts` must subscribe to the chunk channel **before** invoking `chat` to avoid dropping the first tokens.
- Provider-agnostic core: `ai-proxy.ts` orchestrates and emits raw SSE bytes downstream. Per-provider wire shapes live in `provider-routes.ts`; decoders in `providers/{openai,anthropic,openrouter}.ts`, each paired with a fixture test.
- Redaction: the renderer captures context via `lib/contextSnapshot.ts` (method, path, protocol, redacted headers/body, response, active env name) and `redaction.ts` scrubs secrets (sensitive headers, body tokens, environment-variable values) before anything leaves the machine. The request URL is included as written; host redaction was part of the original design but was never implemented.
- **No `/api/ai` Worker route exists yet.** The web build is not wired through the proxy. Platform parity must be confirmed, not assumed — this is the main reason the feature is marked "active development."

## Increment: inline actions + Agent Mode (2026-06)

Two capabilities were layered on top of the propose-&-apply tool harness without
touching the IPC, provider, or security layers — a deliberate choice to avoid
quality/security drift (no new outbound transport, no new IPC channel, no new
provider, no `url-validation`/`secret-handle` change).

- **Inline AI actions** — "Fix request", "Generate tests", "Enrich docs" buttons
  mounted on the request UI (`UrlBar` AI menu, `ScriptsEditor` test tab). Each
  dispatches a seeded chat message via the store (`queuedAction` →
  `enqueueAction`), which the `ChatPanel` consumes through the **same**
  `handleSend` path (no forked streaming). The resulting tool proposal flows
  through the existing Apply card. New tools: `update_http_request`,
  `enrich_docs` (the latter writes a new optional `HttpRequest.description`,
  surfaced by `docGenerator`). "Generate tests" reuses `set_test_script`.
- **Agent Mode** — a bounded, multi-step loop for a user **goal**. Continuation
  is achieved by **re-sending over the existing `ai:chat` channel** with the
  agent system prompt and a freshly re-captured (re-redacted) context snapshot
  after each step — there is **no native tool-result wire protocol** (the
  `ChatMessageWire` shape stays `{role, content}`). Consent stays **strict**:
  the model proposes one tool call per turn, every mutation waits for an explicit
  Apply, and a pure state machine (`agent/agentSession.ts`) enforces a hard step
  cap, Stop, and Dismiss-ends-run. The loop lives in the renderer; the session is
  ephemeral (never persisted, no Dexie migration).

Both remain **Electron-only** (`ai.inlineActions`, `ai.agentMode` in the
capability matrix, `web: false`), consistent with the no-`/api/ai` decision above.

## Amendment (2026-10-31): URL host redaction was never implemented

The original Decision and Consequences said the context snapshot's URLs are
redacted. That was the design intent, but it was never built, and the user docs
repeated the claim (issue #977); the two bullets above were corrected in place. What the code does:

- `contextSnapshot.ts` captures the **full request URL** (scheme, host, path,
  query) and `promptBuilder.ts` sends it as written. Nothing replaces the host.
- In default mode, `promptBuilder.ts` replaces environment-variable **values of
  8+ characters** with `[REDACTED]` wherever they appear in the URL, headers or
  bodies. The ENVIRONMENT block masks every value.
- `shared/protocol/ai/redaction.ts` masks sensitive header names
  (`redactHeaders`) and token-shaped body values (`redactBody`).
- The composer's **Send raw (skip redaction)** switch turns all of this off for
  one message.

So internal hostnames and URL paths reach the provider. The decision is
otherwise unchanged; adding host redaction later would need a new amendment and a
`tests/security/` regression test.

## Consequences

**Positive**

- Adding a provider is a decoder + fixture, not an orchestration rewrite.
- Secrets are redacted at the renderer boundary, so the main process and the provider never see them. URLs (including hostnames) are not redacted and are visible to the provider.
- Streaming + cancel reuse the same IPC event-channel pattern as the other streaming protocols.

**Negative**

- Web has no AI path today; the capability is desktop-only until a Worker route is added. The capability matrix ([ADR 0012](./0012-capability-matrix-source-of-truth.md)) records this.
- The "subscribe before invoke" ordering is an easy bug to reintroduce in the renderer.
- BYOK means key handling quality depends on each provider's key storage path.

## References

- Code: `src/features/ai/` (`lib/promptBuilder.ts`, `lib/contextSnapshot.ts`, `lib/streamConsumer.ts`, `store.ts`), `electron/main/ai-handler.ts`, `shared/protocol/ai/`
- User guide: docs-site `/guides/ai-assistant/`
- Design: `docs/superpowers/specs/2026-05-24-ai-chat-foundation-design.md`
- Related: [ADR 0007 (SecretRef)](./0007-secret-ref-pattern.md), [ADR 0012 (capability matrix)](./0012-capability-matrix-source-of-truth.md)
