# ADR 0010: AI Assistant Architecture

**Status:** Accepted (feature in active development), 2026-06-02

## Context

Restura ships a chat assistant that can read the current request/response context and talk to OpenAI, Anthropic, or OpenRouter (bring-your-own-key). Two constraints shape the design. First, the assistant must never leak secrets or full URLs to a third-party model — the same secret surface [ADR 0007](./0007-secret-ref-pattern.md) protects. Second, the providers have different wire shapes and streaming formats, but the orchestration (build prompt, attach context, stream tokens, allow cancel) is identical across them.

## Decision

Make the AI path **Electron-first and provider-agnostic**, with the orchestrator in the shared layer.

- Transport: the renderer streams over the IPC bridge — `window.electron.ai` → `ai:chat` / `ai:chat:cancel`, with per-call event channels `ai:chat:chunk:<id>` / `ai:chat:end:<id>` → `electron/main/ai-handler.ts` → `shared/protocol/ai/ai-proxy.ts`. The renderer's `streamConsumer.ts` must subscribe to the chunk channel **before** invoking `chat` to avoid dropping the first tokens.
- Provider-agnostic core: `ai-proxy.ts` orchestrates and emits raw SSE bytes downstream. Per-provider wire shapes live in `provider-routes.ts`; decoders in `providers/{openai,anthropic,openrouter}.ts`, each paired with a fixture test.
- Redaction: the renderer captures context via `lib/contextSnapshot.ts` (method, path, protocol, redacted headers/body, response, active env name) and `redaction.ts` scrubs secrets and URLs before anything leaves the machine.
- **No `/api/ai` Worker route exists yet.** The web build is not wired through the proxy. Platform parity must be confirmed, not assumed — this is the main reason the feature is marked "active development."

## Consequences

**Positive**
- Adding a provider is a decoder + fixture, not an orchestration rewrite.
- Secrets/URLs are redacted at the renderer boundary, so the main process and the provider never see them.
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
