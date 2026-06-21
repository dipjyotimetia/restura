# AI Chat Foundation — Design

**Status:** Approved, ready for implementation plan
**Date:** 2026-05-24
**Owner:** Dipjyoti Metia
**Scope:** v1 = foundation + sidebar chat + Explain. NL→request and test-gen are follow-up specs that plug into the same foundation.
**Platform:** Electron (desktop) only. Web build does not load the AI bundle.

---

## 1. Goal

Add a single AI capability to Restura's desktop app: a sidebar chat that explains the user's current request and response in plain English, proposes likely causes for failures, and suggests next steps. Build it on a thin, reusable foundation (provider abstraction, BYO API key, streaming, redaction) so subsequent AI features — natural-language request building, test generation — plug into the same plumbing without re-inventing the pipe.

The privacy story is clean and quotable: _"Your API key never leaves your machine. AI calls go from your machine directly to OpenAI or Anthropic — Restura's servers are not in the path."_

## 2. Non-goals (v1)

- Natural-language request building. Higher risk (model-generated `RequestSpec` must validate; bad prompts produce confidently-wrong auth/headers). Own spec.
- Test generation. Needs design work on QuickJS sandbox integration and human review of generated scripts. Own spec.
- Tool calling. The model never calls a Restura function in v1. Pure text generation.
- Web / SPA support. Desktop only. Architecture leaves the door open to add `worker/handlers/ai.ts` later.
- Multi-modal (image / screenshot input). Text-only.
- Conversation sync across machines. No cloud. Export-to-JSON is the backup story.
- Per-conversation provider override. One active provider per workspace at a time.
- Custom system prompts. v1 uses a single hard-coded Explain prompt.
- Restura-side accounts or login. BYO key is the only path.
- Budget caps. We display estimated cost; we don't enforce a ceiling.

## 3. Decisions (locked during brainstorm)

| Decision          | Choice                                                        | Reason                                                                                                                        |
| ----------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Provider model    | BYO key, called from Electron main                            | Zero infra cost; cleanest "key never leaves your machine" privacy story; mirrors Restura's existing auth-at-the-wire pattern. |
| UI surface        | Sidebar chat panel only                                       | Aligns with chat-native UX; foundation supports inline buttons later if added.                                                |
| v1 scope          | Foundation + chat shell + Explain only                        | Validates UX cheaply; lowest blast radius; explain is read-only.                                                              |
| Providers         | OpenAI + Anthropic + OpenRouter                               | Covers ~95% of users with keys; OpenRouter is OpenAI-API-compatible so only two streaming parsers.                            |
| Redaction default | Aggressive + per-message "Send raw" override                  | Auth/cookies/tokens stripped by default; user opts in to send raw one turn at a time.                                         |
| Chat scope        | Global conversation with ambient context pill                 | One persistent chat; the pill shows what "this" refers to right now.                                                          |
| Architecture      | Lean — renderer assembles messages, backend relays the stream | Mirrors `shared/protocol/` pattern; symmetric across web/desktop if we ever add web.                                          |
| Platform          | Electron only for v1                                          | Cleanest privacy story; no anonymous-web key handling problem.                                                                |

## 4. Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Renderer  (src/features/ai/)                                           │
│                                                                         │
│  components/                                                            │
│    ChatPanel.tsx               sidebar UI, resizable, collapsible       │
│    ContextPill.tsx             "· HTTP · GET /users · 401" badge        │
│    MessageList.tsx, Message.tsx                                         │
│    Composer.tsx                textarea + send + "Send raw" toggle      │
│    ProviderSettings.tsx        BYO key form, model picker               │
│                                                                         │
│  lib/                                                                   │
│    promptBuilder.ts            messages[] = system + redacted context   │
│                                + history + user message                 │
│    contextSnapshot.ts          snapshots active tab/response/env        │
│    streamConsumer.ts           consumes ai:chat:chunk events from main  │
│    providers/                                                           │
│      types.ts                  Provider, Model, ChatRequest types       │
│      openai.ts                 model list + SSE event decoder           │
│      anthropic.ts              model list + SSE event decoder           │
│      openrouter.ts             OpenAI-compatible, thin wrapper          │
│                                                                         │
│  store.ts                      useAiChatStore (Zustand + persist)       │
│  protocol.ts                   feature manifest                         │
│                                                                         │
│  Shared:                                                                │
│  src/lib/shared/aiRedaction.ts header/body/env redaction (NEW)          │
└─────────────────────────────────────────────────────────────────────────┘
                                  │ window.electronAPI.ai.chat(spec)
                                  ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  Shared core  (shared/protocol/ai/)                                     │
│                                                                         │
│  types.ts             ChatRequestSpec, ChatStreamEvent (discriminated)  │
│  ai-proxy.ts          executeAiChat(spec, fetcher, secretResolver)      │
│                       Zod-validate · resolve SecretRef · pick adapter   │
│                       · call provider with streaming · return stream    │
│  provider-routes.ts   provider → {baseUrl, path, authHeader, model}     │
└─────────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
                ┌────────────────────────────────────────┐
                │  electron/main/ai-handler.ts           │
                │  · ipcMain.handle('ai:chat', …)        │
                │  · ipc-validator (Zod)                 │
                │  · ipc-rate-limiter                    │
                │  · Fetcher adapter (Node fetch +       │
                │    existing dns-guard)                 │
                │  · secretResolver (safeStorage +       │
                │    encrypted electron-store)           │
                │  · relays ChatStreamEvent via          │
                │    webContents.send('ai:chat:chunk')   │
                │  · cancellation: AbortController via   │
                │    'ai:chat:cancel'                    │
                └────────────────────────────────────────┘
                                  │
                                  ▼
          api.openai.com · api.anthropic.com · openrouter.ai
```

The renderer is loaded lazily via `lazyComponent`. The chat panel only mounts when `isElectron() === true` — the gate lives in the main app shell layout component (`src/routes/_layout.tsx` or wherever the right-side panel slot is owned), and the lazy import for `src/features/ai/components/ChatPanel.tsx` only fires inside that branch. Web builds pay no bundle cost.

`shared/protocol/ai/` is retained as a sibling of `shared/protocol/{http,grpc,mcp,sse}/` even though only one backend (Electron) uses it in v1. Keeps the architectural pattern consistent and makes a future Worker handler additive rather than a refactor.

## 5. Data flow — one chat turn

```
User types "why did this fail?" in Composer.
  │
  ▼
useAiChatStore.appendUserMessage({text, contextRef, rawMode})
  │
  ▼
contextSnapshot.captureActive()
  reads useRequestStore.tabs[activeTabId]
  reads useHistoryStore.lastResponseFor(tabId)
  reads useEnvironmentStore.activeEnvironment
  returns RawContext { request, response, env }
  │
  ▼
aiRedaction.redact(rawContext, mode)
  default mode: strips Authorization, Cookie, *-token, *-key, JWT-shaped
                strings; env values replaced with [REDACTED], names exposed
  raw mode:     passthrough; toggled per-message, never sticks
  returns RedactedContext
  │
  ▼
promptBuilder.build(SYSTEM_EXPLAIN, redactedContext, priorTurns, userText)
  → messages[] = [{role:"system",…}, …priorTurns, {role:"user",…}]
  │
  ▼
{provider, model} from useAiChatStore.activeProvider / providerConfigs
  │
  ▼
window.electronAPI.ai.chat({provider, model, messages, settings})
  → returns {streamId, cancel()}, plus AsyncIterable<ChatStreamEvent>
     fed by webContents.send('ai:chat:chunk', …)
  │
  ▼
electron/main/ai-handler.ts:
  1. ipc-validator: Zod-check the spec shape
  2. ipc-rate-limiter: per-channel token bucket
  3. secretResolver: handle.id → plaintext API key (from safeStorage)
  4. ai-proxy.executeAiChat(spec, electronFetcher, apiKey):
     a. validate spec
     b. paranoia pass: scan messages[] for unredacted Authorization /
        Bearer / sk- patterns; reject if rawMode !== true
     c. provider-routes.buildRequest → {url, headers, body, signal}
     d. fetcher.fetch with AbortController
     e. pipe upstream SSE through provider stream decoder
        → ReadableStream<ChatStreamEvent>
  5. for-await event of stream: webContents.send('ai:chat:chunk', event)
  6. on done / error / abort: send 'ai:chat:end' or 'ai:chat:error'
  │
  ▼
streamConsumer yields events; UI batches deltas into 30ms RAF windows
useAiChatStore.appendAssistantDelta(msgId, text)
  │
  ▼
On 'done' event: persist via Zustand persist → encrypted electron-store
```

### Redaction lives in the renderer (with a backend sanity pass)

Counter-intuitive but correct: the renderer is the only place that holds the _unredacted_ live state (rendered tabs, resolved env values, in-memory response bodies). It strips known-secret patterns before they ever leave the process. The backend runs a defense-in-depth scan and rejects messages that obviously still contain `Authorization:` / `Bearer sk-` / etc. when `rawMode !== true`.

`SecretRef` handles in the original `RequestSpec` never resolve in the renderer — so request-auth secrets (Bearer tokens, AWS keys, etc.) are not even available to redact. They're already absent.

### Streaming throttle

Token streams arrive 50–200 chunks/sec. Without batching, every chunk re-renders the chat. We coalesce into 30ms RAF windows — same trick Vercel AI SDK uses. Implementation is a few lines in `streamConsumer.ts`.

## 6. State model

```ts
// src/features/ai/store.ts
type Provider = 'openai' | 'anthropic' | 'openrouter';

type ProviderConfig = {
  provider: Provider;
  defaultModel: string; // e.g. "claude-sonnet-4-x"
  apiKeyRef: SecretRef; // always {kind:"handle"} (Electron-only)
  baseUrlOverride?: string; // self-hosted / OpenRouter region
};

type ContextRef = {
  kind: 'request' | 'response' | 'history-entry' | 'none';
  tabId?: string;
  historyId?: string;
  capturedAt: number;
};

type ChatMessage = {
  id: string; // ulid
  role: 'user' | 'assistant' | 'system';
  text: string;
  status: 'streaming' | 'done' | 'error';
  errorMessage?: string;
  usage?: { promptTokens: number; completionTokens: number; estimatedCostUSD: number };
  contextRef?: ContextRef;
  rawMode?: boolean;
  createdAt: number;
};

type Conversation = {
  id: string;
  title: string; // first 60 chars of first user message, ellipsised;
  // no LLM summarisation call in v1
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
};

type AiChatState = {
  conversations: Record<string, Conversation>;
  activeConversationId: string | null;
  panelOpen: boolean;
  panelWidth: number; // pixels, clamped to [280, 800] in UI
  providerConfigs: Record<Provider, ProviderConfig | null>;
  activeProvider: Provider;
  redactionMode: 'default' | 'raw';

  // actions: newConversation, setActive, appendUserMessage,
  // appendAssistantPlaceholder, appendAssistantDelta, finalizeAssistantMessage,
  // setMessageError, deleteConversation, setProviderConfig, setActiveProvider
};
```

Persistence: Zustand `persist` middleware → encrypted electron-store. Store name `ai-chat-store`. Validated by `AiChatStateSchema` in `src/lib/shared/store-validators.ts` on rehydrate; failed validation resets to defaults (matches existing pattern).

Settings UI: new "AI" section at `/settings`. Provider selector, "Add API key" (writes via SecretRef pattern through IPC), default model dropdown (populated from `providers/{p}.ts` model list), redaction mode default, "Clear all conversations", conversation export to JSON (redacted; secrets in env-var placeholder form).

## 7. Secrets

API-key handling reuses Restura's existing SecretRef pattern (ADR-0007) end-to-end:

1. User pastes API key in `ProviderSettings.tsx`.
2. Renderer calls `electronAPI.secrets.put({ scope: "ai", provider, value })`.
3. Main process generates a UUID handle, writes ciphertext to encrypted electron-store (key wrapped by Electron `safeStorage` → OS keychain), returns `{kind:"handle", id}`.
4. Renderer stores the handle in `useAiChatStore.providerConfigs[provider].apiKeyRef`. Plaintext never enters the renderer.
5. On every chat send, `electron/main/ai-handler.ts` resolves the handle → plaintext just before calling the provider, discards the plaintext immediately after. No long-lived in-memory cache.
6. Log-redaction denylist updated to include `apiKeyRef`. Exporter swaps the key for `{{AI_API_KEY}}` placeholder on conversation export. Both required-in-the-same-PR per the project's secret-handle discipline.

Base-URL override (self-hosted OpenRouter, OpenAI-compatible gateways) goes through `shared/protocol/url-validation.ts` SSRF guard. Electron `dns-guard.ts` covers DNS-rebind risk on overrides.

## 8. Redaction — single source of truth

`src/lib/shared/aiRedaction.ts`:

```ts
const HEADER_DENYLIST = [
  'authorization',
  'cookie',
  'set-cookie',
  'proxy-authorization',
  'x-api-key',
  'x-auth-token',
  'x-csrf-token',
  /^x-.*-token$/i,
  /^x-.*-key$/i,
  /^x-.*-secret$/i,
];

const BODY_TOKEN_PATTERNS = [
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWT
  /Bearer\s+[A-Za-z0-9._\-+/=]{20,}/g,
  /(api[_-]?key|secret|password|token)["']?\s*[:=]\s*["']?[A-Za-z0-9._\-+/=]{8,}/gi,
];
```

- `redactRequest(req, mode)` — strips denied headers, masks body tokens. Header values replaced by `"[REDACTED]"`.
- `redactResponse(res, mode)` — same plus drops `Set-Cookie`.
- `redactEnvironment(env, mode)` — replaces all values with `"[REDACTED]"`; exposes only var names so the model knows `{{baseUrl}}` exists without learning what it is. The existing `redactEnvironmentVariables` in `src/features/mcp-server/redaction.ts` is lifted into the shared module and reused by both.
- `mode: "raw"` skips all redaction. Toggled per-message via the Composer's "Send raw" switch. Toggle is **off by default for every message** — never persists.
- Backend paranoia pass in `ai-proxy.ts` re-scans `messages[]` content; if obvious unredacted secrets are found AND `rawMode !== true`, rejects with HTTP 400. Defense in depth — catches a future renderer bug that forgets to redact.

## 9. Error handling

| Failure                                                  | Handling                                                                                                                               |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| No API key configured                                    | Composer disabled, helper text "Add an API key in Settings → AI".                                                                      |
| Invalid API key (provider 401)                           | Surface provider error verbatim; message status `error`. Don't auto-clear the key.                                                     |
| Rate limited (provider 429)                              | Exponential backoff with jitter, max 3 retries. UI shows "Provider rate limited, retrying…"                                            |
| Network error / timeout (30s no first token, 5min total) | Message errored; "Send again" reuses the same context snapshot.                                                                        |
| Backend rejects unredacted content                       | Errored with "Looks like raw secrets in the prompt. Click 'Send raw' if intentional."                                                  |
| Provider returns malformed SSE                           | Stream aborts, message errored with raw bytes truncated to 500 chars for debugging.                                                    |
| Renderer reload mid-stream                               | In-flight messages restored from store as `status: "error"` with text "Interrupted by reload" — never `streaming` (lying about state). |
| IPC rate limiter triggers                                | Errored with "Slow down — too many AI requests in the last minute."                                                                    |

Cancellation: "Stop" button sends `electronAPI.ai.cancel(streamId)`; main process aborts upstream fetch and emits `ai:chat:end` with `reason: "cancelled"`.

## 10. Testing

| Layer       | What                                                                                      | Where                                                                                                   |
| ----------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Unit        | `aiRedaction.ts` — header denylist, JWT mask, env name-only, raw bypass                   | `src/lib/shared/__tests__/aiRedaction.test.ts`                                                          |
| Unit        | `promptBuilder.ts` — system prompt composition, message ordering, context attachment      | `src/features/ai/lib/__tests__/promptBuilder.test.ts`                                                   |
| Unit        | Provider stream decoders                                                                  | `src/features/ai/lib/providers/__tests__/*.test.ts` — feed recorded SSE fixtures, assert decoded events |
| Unit        | `ai-proxy.ts` — Zod validation, provider routing, paranoia pass                           | `shared/protocol/ai/__tests__/ai-proxy.test.ts` — fake Fetcher                                          |
| Integration | `useAiChatStore` — append/delta/error states, persist+rehydrate Zod validation round-trip | `src/features/ai/__tests__/store.test.ts`                                                               |
| Integration | Electron handler with mocked safeStorage and Fetcher                                      | `electron/main/__tests__/ai-handler.test.ts`                                                            |
| Component   | `ChatPanel`, `Message` streaming render, Stop, Send raw                                   | RTL + Vitest, mock streamConsumer                                                                       |
| e2e         | Real round-trip against echo server (Electron, no live keys in CI)                        | `e2e/real-ai.spec.ts`                                                                                   |
| Security    | Redaction regression — every header/body pattern that's ever leaked has a test            | `tests/security/ai-redaction.test.ts` — property-based, adversarial inputs                              |
| Fixtures    | Provider SSE event recordings                                                             | `src/features/ai/lib/providers/__fixtures__/*.sse.txt` — re-record quarterly                            |

Echo server additions (`echo/handlers/ai.ts`, ~150 LOC):

- `POST /v1/chat/completions` — OpenAI shape. Deterministic SSE stream + `data: [DONE]`.
- `POST /v1/messages` — Anthropic shape. `event: message_start` + content_block_delta events.
- Failure modes via query: `?fail=429`, `?fail=malformed`. Used by e2e to test error UI without flaking on real providers.

CI: `npx playwright test e2e/real-ai.spec.ts` added to e2e job. No real keys.

Manual smoke checklist:

1. `npm run electron:dev`
2. Settings → AI → paste a real Anthropic key
3. Send a request that returns 401
4. Open chat panel, type "why did this fail?"
5. Verify: context pill shows the request, first token in <2s, full response under 10s, `Authorization` redacted in the IPC payload (visible in devtools)
6. Click "Send raw" on a follow-up message, confirm prompt now includes the header
7. Switch tabs, ask follow-up — context pill updates
8. Reload — chat persists, in-flight message becomes `error: Interrupted by reload`

## 11. Risks acknowledged (not solved)

1. **Provider wire format drift.** OpenAI changed SSE shape twice in 2025. Mitigation: contract tests against fresh fixtures, re-recorded quarterly. CI does not catch silent drift — manual rotation is the safety net.
2. **Token-cost surprise.** Users on Opus / GPT-4o asking about huge JSON responses can rack up cost quickly. We display estimated cost per message and a per-conversation running total. Pricing constants are hardcoded per model in `providers/{p}.ts` (`{model, inputUSDPerMTok, outputUSDPerMTok}`), refreshed manually when providers change rates — same pattern as the SSE-fixture rotation. We do not enforce a cap.
3. **Hallucinated debugging advice.** Plausible-sounding wrong answers for niche APIs. Mitigation: persistent "AI can be wrong — verify before acting" footer beneath every assistant message.
4. **Provider TOS on retention.** Providers retain prompts up to 30 days unless on zero-retention contracts. Surfaced once in AI settings as a notice on first key entry. Documented, not engineered around.
5. **Redaction false negatives.** New token formats (PASETO, Macaroon, novel cloud schemes) won't match our regexes. Mitigation: property-based tests in section 10; reported leaks are handled via the standard GitHub issue template (no automated reporter in v1) — a new pattern lands as a one-line addition to `aiRedaction.ts` + a regression test.

## 12. Effort estimate (rough)

| Slice                                                                              |                 Days |
| ---------------------------------------------------------------------------------- | -------------------: |
| Foundation: `shared/protocol/ai/`, `electron/main/ai-handler.ts`, redaction, store |                    3 |
| Chat UI: panel, composer, message list, settings, context pill, streaming render   |                    3 |
| Provider decoders + echo endpoints + tests                                         |                    2 |
| Polish: error states, e2e, docs, ROADMAP.md update                                 |                    2 |
| **Total**                                                                          | **~10 working days** |

Add 30% buffer → **~2.5 weeks** for one engineer familiar with the codebase.

## 13. Follow-up specs (for trajectory, not for this implementation)

- **NL → Request builder.** Model returns a structured `RequestSpec`-shaped JSON; validate against the existing OpenCollection Zod schemas; surface in a preview-and-apply modal so users confirm before the spec writes to the active tab. Needs careful prompt engineering around auth — model must produce `{{env_var}}` placeholders, not literal secrets.
- **Test generation.** Model produces a QuickJS-compatible script for the Tests tab. Generated scripts run in the same sandbox as user-authored ones (no escalation). User reviews and edits before running. Output must respect existing `chai`/`expect` helpers exposed in the sandbox.
- **Tool calling — phase 2.** Wire the chat to call functions on Restura's existing MCP server (`list_collections`, `get_history`, `get_environment` are already implemented and redacted). Enables "show me my recent failed requests", "explain the diff between these two responses", etc. Approach C from the brainstorm — deferred until v2 to avoid the agent-framework jump.

---

_Spec written 2026-05-24 via the brainstorming skill. Next step: `writing-plans` skill creates the implementation plan._
