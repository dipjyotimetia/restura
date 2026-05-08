# Streaming + gRPC Web Streaming + HTTP/2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stream HTTP responses end-to-end (NDJSON, SSE-via-HTTP, large CSV) instead of buffering 100 MB into memory; make gRPC streaming methods (server / client / bidi) actually stream over the web client; switch Electron HTTP from `http`/`https` to `undici` so HTTP/2 is negotiated when the upstream supports it; surface the negotiated ALPN version in the response viewer.

**Architecture:** Extend the `Fetcher` contract from Plan 1 with an optional streaming variant — `body: ReadableStream<Uint8Array>` alongside the existing buffered `text()`. Worker handler chooses between buffered and streamed paths based on the request `Accept` header (or an explicit `streamingMode` flag). Renderer's `requestExecutor` dispatches a streaming reader for `text/event-stream` / `application/x-ndjson` responses; a new `StreamingResponseViewer` component renders chunks incrementally with a windowed list, falling back to Monaco for buffered responses under 1 MB. gRPC streaming uses Connect-Web's native streaming primitives directly from the renderer (no Worker proxy in the streaming path; Connect-Web speaks HTTP/2 via fetch). Electron's HTTP fetcher swaps Node `http`/`https` for `undici.request`, which negotiates h1.1 or h2 over ALPN; PAC, SOCKS, mTLS, CA, and the DNS-rebind guard from Plan 1 all stay in place.

**Tech Stack:** TypeScript (strict), `undici` (already a transitive dep via Electron's bundled Node 20 runtime — verify), `@connectrpc/connect-web` (already installed), no other new runtime deps. Adds a small windowed-list helper (no `react-window` dep — windowing logic is ~50 LOC).

---

## File structure

**Created:**
- `shared/protocol/streaming-types.ts` — `StreamingResponse`, `StreamingFetcher`, `StreamChunk` types
- `shared/protocol/sse-parser.ts` — backend-agnostic SSE event-frame parser (consumed by worker MCP, renderer viewer, and electron SSE)
- `shared/protocol/sse-parser.test.ts`
- `shared/protocol/ndjson-parser.ts` — line-delimited JSON streaming parser
- `shared/protocol/ndjson-parser.test.ts`
- `src/features/http/lib/streamingResponseReader.ts` — renderer-side stream consumer
- `src/features/http/lib/streamingResponseReader.test.ts`
- `src/components/shared/StreamingResponseViewer.tsx` — windowed incremental viewer
- `src/components/shared/StreamingResponseViewer.test.tsx`
- `src/components/shared/lib/windowedList.tsx` — small virtualization helper (~50 LOC)
- `src/components/shared/lib/windowedList.test.tsx`
- `src/features/grpc/lib/grpcStreamingClient.ts` — wraps Connect-Web's streaming primitives
- `src/features/grpc/lib/grpcStreamingClient.test.ts`
- `src/features/grpc/components/GrpcStreamingPanel.tsx` — UI for streaming methods (replaces unary message viewer)
- `docs/adr/0003-streaming-and-http2.md`

**Modified:**
- `shared/protocol/types.ts` — extend `FetcherResponse` with optional `body: ReadableStream<Uint8Array>`; add `negotiatedAlpn?: 'h1.1' | 'h2' | 'h3'` to `NormalizedResponse`
- `shared/protocol/http-proxy.ts` — switch on streaming mode; do not buffer when `streamingMode: true`
- `shared/protocol/http-proxy.test.ts` — tests for streaming mode
- `worker/handlers/proxy.ts` — return a streamed Response when streaming; auth/header sanitisation stays
- `worker/handlers/mcp.ts` — replace inline SSE reader with `shared/protocol/sse-parser`
- `electron/main/http-handler.ts` — replace `http`/`https` `request()` with `undici.request`; expose negotiated ALPN
- `electron/main/sse-handler.ts` — use shared SSE parser
- `src/features/sse/lib/sseManager.ts` (or `sseParser.ts` — verify path) — use shared SSE parser
- `src/features/http/lib/requestExecutor.ts` — dispatch streaming when Accept indicates a streaming type or `streamingMode` is set
- `src/components/shared/ResponseViewer.tsx` — switch to `StreamingResponseViewer` when response is streamed or buffered body is > 1 MB; show ALPN indicator in metadata bar
- `src/features/grpc/lib/grpcClient.ts` — delegate to `grpcStreamingClient` for non-unary methods
- `src/features/grpc/components/GrpcRequestBuilder.tsx` — render `GrpcStreamingPanel` for streaming method types

**Out of scope:**
- HTTP/3 — wait for Node `undici` h3 to stabilise (tracked separately).
- Server-sent gRPC events for the Worker streaming path — Worker is bypassed for gRPC streams (Connect-Web speaks directly to upstream when CORS permits). The Worker remains the proxy for unary gRPC and CORS-blocked streams.
- Renderer-side h2 negotiation — browser fetch handles it transparently. ALPN is reported informationally.

---

## Tasks

### Task 1: Extend `Fetcher` and `NormalizedResponse` for streaming

**Files:**
- Modify: `shared/protocol/types.ts`

The shared core's `FetcherResponse` currently exposes `text(): Promise<string>`. Add an optional `body: ReadableStream<Uint8Array> | null` so streaming-capable fetchers can hand off the upstream stream directly. Add `negotiatedAlpn` to `NormalizedResponse` so the renderer can surface "Served over HTTP/2".

- [ ] **Step 1: Edit `shared/protocol/types.ts`**

```ts
export interface NormalizedResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  size: number;
  /**
   * Negotiated ALPN protocol when known. The Worker doesn't have direct ALPN
   * visibility (the runtime negotiates), so this is populated only by Electron
   * (via undici) and surfaced informationally in the response viewer.
   */
  negotiatedAlpn?: 'h1.1' | 'h2' | 'h3';
}

export interface FetcherResponse {
  status: number;
  statusText: string;
  headers: Headers | Record<string, string | string[]>;
  text: () => Promise<string>;
  contentLengthHeader: string | null;
  /**
   * Optional access to the raw response stream. When present, the shared core
   * may choose to stream-through instead of buffering via text(). Streaming
   * consumers MUST NOT also call text() on the same response.
   */
  body?: ReadableStream<Uint8Array> | null;
  /** Negotiated ALPN for this response. Populated by Electron's undici fetcher. */
  negotiatedAlpn?: 'h1.1' | 'h2' | 'h3';
}
```

- [ ] **Step 2: Type-check**

```bash
cd /Users/dipjyotimetia/Documents/working/ccviews/restura
npx tsc --noEmit 2>&1 | tail -3
npx tsc --noEmit -p worker/tsconfig.json 2>&1 | tail -3
npx tsc --noEmit -p electron/tsconfig.json 2>&1 | tail -3
```

All clean.

- [ ] **Step 3: Commit**

```bash
git add shared/protocol/types.ts
git commit -m "feat(shared): extend Fetcher with optional streaming body + ALPN"
```

---

### Task 2: Add a streaming branch to `executeHttpProxy`

**Files:**
- Modify: `shared/protocol/http-proxy.ts`
- Modify: `shared/protocol/http-proxy.test.ts`

Add a `streamingMode: boolean` option to `executeHttpProxy`. When true, the function returns an `ExecuteResult` whose `response.body` is the upstream's `text()` representation BUT also exposes the underlying `ReadableStream` via a new `StreamingExecuteResult` shape. To avoid breaking existing call sites, introduce an alternative entry point `executeHttpProxyStreaming(spec, fetcher, options)` that returns a different result type: `{ ok: true; response: StreamingResponse } | { ok: false; status; payload }`.

```ts
// In http-proxy.ts
export interface StreamingResponseHandle {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  /** The upstream stream — caller is responsible for reading and closing it. */
  body: ReadableStream<Uint8Array>;
  negotiatedAlpn?: 'h1.1' | 'h2' | 'h3';
}

export type StreamingExecuteResult =
  | { ok: true; response: StreamingResponseHandle }
  | { ok: false; status: number; payload: { error: string } };

export async function executeHttpProxyStreaming(
  spec: RequestSpec,
  fetcher: Fetcher,
  options: ExecuteHttpProxyOptions
): Promise<StreamingExecuteResult> {
  // Same validation/header/body construction as executeHttpProxy ... but:
  // - Do not enforce content-length cap (streaming is unbounded; per-chunk cap applies elsewhere)
  // - Do not call response.text()
  // - Return response.body directly (or error if fetcher didn't produce one)
}
```

- [ ] **Step 1: Write the failing tests**

Add to `shared/protocol/http-proxy.test.ts`:

```ts
import { executeHttpProxyStreaming } from './http-proxy';

describe('executeHttpProxyStreaming', () => {
  it('returns the upstream body without calling text()', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('chunk1'));
        controller.enqueue(new TextEncoder().encode('chunk2'));
        controller.close();
      },
    });
    const fetcher: Fetcher = vi.fn(async () => ({
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'text/event-stream' },
      text: async () => { throw new Error('text() must not be called in streaming mode'); },
      contentLengthHeader: null,
      body: stream,
    }));
    const r = await executeHttpProxyStreaming(
      { method: 'GET', url: 'https://example.com/sse', timeout: 1000 },
      fetcher,
      { allowLocalhost: false }
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      const reader = r.response.body.getReader();
      const a = await reader.read();
      expect(new TextDecoder().decode(a.value)).toBe('chunk1');
      const b = await reader.read();
      expect(new TextDecoder().decode(b.value)).toBe('chunk2');
      const c = await reader.read();
      expect(c.done).toBe(true);
    }
  });

  it('returns 502 if the fetcher does not provide body', async () => {
    const fetcher: Fetcher = async () => ({
      status: 200,
      statusText: 'OK',
      headers: {},
      text: async () => 'oops',
      contentLengthHeader: null,
    });
    const r = await executeHttpProxyStreaming(
      { method: 'GET', url: 'https://example.com/', timeout: 1000 },
      fetcher,
      { allowLocalhost: false }
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(502);
  });

  it('still validates URL and method', async () => {
    const fetcher: Fetcher = vi.fn();
    const r = await executeHttpProxyStreaming(
      { method: 'TRACE', url: 'https://example.com/', timeout: 1000 },
      fetcher,
      { allowLocalhost: false }
    );
    expect(r.ok).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to fail, then implement**

Implement `executeHttpProxyStreaming` next to `executeHttpProxy`. Share the URL/header/body/timeout setup via a helper if both functions diverge enough to be hard to read; otherwise duplicate the setup (15 lines).

- [ ] **Step 3: Run tests, type-check, validate, commit**

```bash
npm run test:run -- shared/protocol/http-proxy
npm run validate
git add shared/protocol/http-proxy.ts shared/protocol/http-proxy.test.ts
git commit -m "feat(shared): add executeHttpProxyStreaming for streaming responses"
```

---

### Task 3: SSE event-frame parser in shared

**Files:**
- Create: `shared/protocol/sse-parser.ts`
- Create: `shared/protocol/sse-parser.test.ts`

Move and unify the SSE parsing logic that today lives in `worker/handlers/mcp.ts:36-81` (`readSseForReply`), `electron/main/sse-handler.ts`, and `src/features/sse/lib/sseParser.ts`. The shared parser is a pure transform: `Uint8Array` chunks → `SseEvent[]`. No I/O, no fetcher coupling.

`SseEvent` shape:
```ts
export interface SseEvent {
  id?: string;
  event?: string;
  data: string;
  retry?: number;
}
```

Public API:
```ts
export class SseParser {
  feed(chunk: Uint8Array): SseEvent[];
  flush(): SseEvent[]; // call when stream ends to emit a trailing partial event
}
```

- [ ] **Step 1: Write tests**

Cover: simple `data: foo\n\n`, multiple data lines, `event:` field, `id:` field, `retry:` field, `:` comment lines, BOM, CRLF normalization, value-leading-space stripping (`data: foo` → `'foo'`, `data:foo` → `'foo'` per spec — both equivalent), partial event split across two `feed()` calls.

- [ ] **Step 2: Implement**

The implementation reads bytes via a streaming `TextDecoder`, accumulates into a string buffer, and splits on `\n\n` (after CRLF→LF normalisation). Per W3C SSE spec, lines:
- starting with `:` are comments (skip)
- starting with `data:` append to the current event's data (joined with `\n` if multiple)
- `event:` sets event name
- `id:` sets last event id
- `retry:` sets retry interval (numeric)

Use an offset cursor instead of repeated `buffer.slice(...)` to avoid the O(n²) trap fixed in Plan 1's `simplify` pass.

- [ ] **Step 3: Migrate `worker/handlers/mcp.ts` and `electron/main/sse-handler.ts` to use the shared parser**

Replace the inline parsers. Test counts in worker/electron suites should stay flat.

- [ ] **Step 4: Run tests, validate, commit**

```bash
npm run validate
git add shared/protocol/sse-parser.ts shared/protocol/sse-parser.test.ts \
        worker/handlers/mcp.ts electron/main/sse-handler.ts \
        src/features/sse/lib/sseParser.ts  # if it exists; verify path
git commit -m "feat(shared): unify SSE parser; consume from worker/MCP, electron/SSE, renderer"
```

---

### Task 4: NDJSON parser in shared

**Files:**
- Create: `shared/protocol/ndjson-parser.ts`
- Create: `shared/protocol/ndjson-parser.test.ts`

Line-delimited JSON. Public API:
```ts
export class NdjsonParser {
  feed(chunk: Uint8Array): unknown[];  // returns parsed JSON values
  flush(): unknown[]; // emits trailing partial line if it parses
}
```

Skip empty lines. On JSON parse error for a line, emit a sentinel object `{ __parseError: line }` so the consumer can surface the bad line to the user without crashing the stream.

- [ ] **Step 1: Write tests**

Cover: single line, multiple lines, partial line carry-over, empty lines, malformed JSON producing parseError sentinel, CRLF and LF.

- [ ] **Step 2: Implement, run, commit**

```bash
git add shared/protocol/ndjson-parser.ts shared/protocol/ndjson-parser.test.ts
git commit -m "feat(shared): add NdjsonParser"
```

---

### Task 5: Renderer streaming response reader

**Files:**
- Create: `src/features/http/lib/streamingResponseReader.ts`
- Create: `src/features/http/lib/streamingResponseReader.test.ts`

Consumes a `Response` and emits incremental events to the caller. Detects format from `Content-Type`:
- `text/event-stream` → SseParser
- `application/x-ndjson` / `application/jsonl` → NdjsonParser
- `text/plain` / fallback → raw decoded chunks

Public API:
```ts
export interface StreamEvent {
  type: 'sse' | 'ndjson' | 'raw' | 'end' | 'error';
  payload?: SseEvent | unknown | string;  // shape depends on type
  error?: string;
}

export async function* readStreamingResponse(
  response: Response,
  options?: { signal?: AbortSignal }
): AsyncIterable<StreamEvent>;
```

The async generator yields events as the stream produces them, and a final `{ type: 'end' }` when the stream closes (or `{ type: 'error', error: ... }` on read failure). The viewer subscribes via `for await ... of`.

- [ ] **Step 1: Write tests using `ReadableStream` mocks**
- [ ] **Step 2: Implement**
- [ ] **Step 3: Wire into `requestExecutor.ts`**

In `src/features/http/lib/requestExecutor.ts`, dispatch streaming when:
```ts
const acceptHeader = headers['Accept'] ?? headers['accept'] ?? '';
const isStreaming = /event-stream|x-ndjson|jsonl/.test(acceptHeader);
```

If streaming, call `executeRequestStreaming(...)` (a new sibling function) instead of `executeRequest`. The streaming variant returns an `AsyncIterable<StreamEvent>` rather than a buffered `RequestExecutionResult`.

- [ ] **Step 4: Run tests, validate, commit**

---

### Task 6: Streaming response viewer (windowed)

**Files:**
- Create: `src/components/shared/lib/windowedList.tsx`
- Create: `src/components/shared/lib/windowedList.test.tsx`
- Create: `src/components/shared/StreamingResponseViewer.tsx`
- Create: `src/components/shared/StreamingResponseViewer.test.tsx`

`windowedList` is a small virtualization helper: given items[] and an itemHeight estimate, render only items visible in the viewport plus a small overscan. Roughly 50 LOC. Don't add `react-window` as a dep — the use case is constrained (uniform item height, append-only).

`StreamingResponseViewer` accepts an `AsyncIterable<StreamEvent>` and renders incoming events. UI:
- Top bar: "● Streaming" indicator with chunk count and total bytes; "Pause" button (stops `read()`) and "Resume"; "Close stream" button
- Body: windowed list, one row per event. SSE event renders as a card (event name, id, data); NDJSON renders as a one-line preview with "expand" to see full JSON
- Auto-scroll to bottom when new events arrive UNLESS the user scrolled up (then show "Jump to latest" pill)

- [ ] **Step 1: Write `windowedList` tests + implementation**
- [ ] **Step 2: Write `StreamingResponseViewer` tests with a stub async iterable**
- [ ] **Step 3: Implement the viewer**
- [ ] **Step 4: Wire into `ResponseViewer.tsx`**

In `src/components/shared/ResponseViewer.tsx`, switch rendering based on response shape:
- If response has `streamEvents: AsyncIterable<StreamEvent>` (new field on the active tab) → render `<StreamingResponseViewer events={...} />`
- Else if `response.body.length > 1_000_000` → render `<StreamingResponseViewer events={asSyncStream(response.body)} />` (one synthetic raw chunk)
- Else (existing path) → Monaco editor

Also: surface `response.negotiatedAlpn` ("HTTP/1.1" / "HTTP/2") in the metadata bar near status code.

- [ ] **Step 5: Run tests, validate, smoke test, commit**

```bash
npm run dev
# Manually test: hit https://stream.wikimedia.org/v2/stream/recentchange (SSE) — should render incrementally
# Manually test: a normal JSON response under 1 MB → still uses Monaco
# Manually test: a 5 MB JSON response → renders via windowed viewer (no Monaco lag)
```

---

### Task 7: Worker streaming proxy

**Files:**
- Modify: `worker/handlers/proxy.ts`
- Modify: existing tests if needed

When the proxied request has `Accept: text/event-stream | application/x-ndjson | application/jsonl` (or the request body contains an explicit `streamingMode: true` flag), the worker should pipe the upstream response body straight back to the renderer instead of `await response.text()`.

Use Hono's stream helper:
```ts
import { stream } from 'hono/streaming';

export async function proxy(c) {
  // ... existing validation, header sanitization, fetcher build ...
  if (isStreamingRequest(body)) {
    const result = await executeHttpProxyStreaming(spec, fetcher, options);
    if (!result.ok) return c.json(result.payload, result.status);
    // Forward upstream headers and pipe the body
    for (const [k, v] of Object.entries(result.response.headers)) {
      c.header(k, v);
    }
    c.status(result.response.status);
    return stream(c, async (s) => {
      const reader = result.response.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          await s.write(value);
        }
      } finally {
        reader.releaseLock();
      }
    });
  }
  // ... existing buffered path ...
}
```

- [ ] **Step 1: Add streaming detection logic**
- [ ] **Step 2: Write a test that asserts streaming Accept routes through executeHttpProxyStreaming**
- [ ] **Step 3: Implement, run worker tests**
- [ ] **Step 4: Smoke test against a real SSE endpoint via the dev server**
- [ ] **Step 5: Commit**

---

### Task 8: gRPC server-streaming via Connect-Web

**Files:**
- Create: `src/features/grpc/lib/grpcStreamingClient.ts`
- Create: `src/features/grpc/lib/grpcStreamingClient.test.ts`
- Modify: `src/features/grpc/lib/grpcClient.ts` — delegate non-unary methods
- Create: `src/features/grpc/components/GrpcStreamingPanel.tsx`
- Modify: `src/features/grpc/components/GrpcRequestBuilder.tsx`

Connect-Web exposes streaming via the transport's `serverStream`/`clientStream`/`bidiStream` methods. The current `grpcClient.ts` only wires unary. Add streaming.

`grpcStreamingClient.ts` exports:
```ts
export interface GrpcStreamingHandle {
  /** Async iterable of inbound messages from the server. */
  messages: AsyncIterable<unknown>;
  /** Send an outbound message (no-op for server-streaming methods). */
  send(message: unknown): Promise<void>;
  /** Close the outbound side (signals EOF for client-streaming and bidi). */
  closeSend(): void;
  /** Cancel the entire RPC. */
  cancel(): void;
  /** Final headers + trailers, resolved when the stream ends. */
  done: Promise<{ headers: Record<string, string>; trailers: Record<string, string>; status: GrpcStatus }>;
}

export async function startGrpcStream(
  request: GrpcRequest,
  resolveVariables: (text: string) => string,
  proto: ProtoServiceDefinition  // the loaded service descriptor
): Promise<GrpcStreamingHandle>;
```

- [ ] **Step 1: Tests with a mocked transport**

Use Connect-Web's testing utilities (`createRouterTransport` or similar) to run a fake server-streaming method. Assert messages flow.

- [ ] **Step 2: Implement**

Reuse the auth/metadata logic already in `grpcClient.ts:buildAuthMetadata`. The transport is the same `createConnectTransport` used today; only the method-call shape differs (`transport.serverStream(method, request)` instead of `transport.unary(...)`).

- [ ] **Step 3: Wire into `grpcClient.ts`**

Add a dispatch function: if `methodType === 'unary'`, use the existing path; otherwise delegate to `grpcStreamingClient`.

- [ ] **Step 4: Build `GrpcStreamingPanel.tsx`**

UI for streaming gRPC:
- Header bar: "● Streaming • <N> messages • <connected/disconnected>"
- Message list: incoming messages rendered via the windowed list helper from Task 6, with collapsed-by-default JSON (click to expand)
- For client-streaming and bidi: an input area to compose outbound messages, "Send" button calls `handle.send(msg)`; "Close stream" calls `handle.closeSend()`
- "Cancel" button calls `handle.cancel()` and tears the stream down

Render this panel from `GrpcRequestBuilder.tsx` when `currentRequest.methodType !== 'unary'`. Keep the existing unary-response viewer for `'unary'`.

- [ ] **Step 5: Smoke test against a real Connect/gRPC server (e.g. via `buf`)**

- [ ] **Step 6: Commit**

```bash
git add src/features/grpc/lib/grpcStreamingClient.ts \
        src/features/grpc/lib/grpcStreamingClient.test.ts \
        src/features/grpc/lib/grpcClient.ts \
        src/features/grpc/components/GrpcStreamingPanel.tsx \
        src/features/grpc/components/GrpcRequestBuilder.tsx
git commit -m "feat(grpc): server/client/bidi streaming via Connect-Web"
```

---

### Task 9: Electron undici migration

**Files:**
- Modify: `electron/main/http-handler.ts`

Replace Node `http`/`https` `request()` calls inside `buildElectronFetcher` with `undici.request`. `undici` is the standard Node HTTP client since Node 18 and supports HTTP/2 over ALPN automatically when the upstream advertises h2.

Critical: preserve every existing feature.

- **PAC**: stays — already runs above the fetcher, returns a resolved proxy; pass the proxy via `undici.Dispatcher.compose(proxyAgent)` or `new ProxyAgent(...)`.
- **HTTP/HTTPS proxy**: undici has `ProxyAgent` — use it.
- **SOCKS proxy**: undici doesn't ship a SOCKS dispatcher. Two options:
  1. Open the SOCKS tunnel manually (existing code) and pass the resulting `net.Socket` to undici via a custom `Dispatcher.connect`.
  2. Use `socks-proxy-agent` (small dep) but only if the existing manual SOCKS code can't be adapted.
  Pick option 1 (no new dep) — verify with a unit-style smoke test against a local SOCKS server (or skip; flag as needs-real-network test).
- **mTLS / CA**: undici accepts `tls` options via the dispatcher. Pass `pfx`/`cert`/`key`/`ca` through `new Agent({ connect: { ... } })`.
- **DNS rebind guard**: `createSecureLookup` is wired into `http.request({ lookup })`. undici accepts a custom `connect.lookup` via Agent options. Confirm and route.
- **Manual redirect handling**: stays in `makeHttpRequest` (the wrapper, not the fetcher).
- **Abort signal forwarding**: undici accepts `AbortSignal`. Pass `req.signal` directly.
- **Connection timeout**: undici supports `headersTimeout` and `bodyTimeout`. Use the existing 10s for `connectTimeout`.
- **Negotiated ALPN**: undici exposes `response.opaque` containing protocol info; capture into `negotiatedAlpn`.

After undici migration, update `FetcherResponse.body` to expose the upstream stream:
```ts
return {
  status: response.statusCode,
  statusText: '',
  headers: response.headers as Record<string, string | string[]>,
  text: () => response.body.text(),  // undici body helper
  contentLengthHeader: (response.headers['content-length'] as string | undefined) ?? null,
  body: Readable.toWeb(response.body) as ReadableStream<Uint8Array>,  // undici provides Web stream interop
  negotiatedAlpn: response.opaque?.alpnProtocol,  // verify shape
};
```

- [ ] **Step 1: Read existing `http-handler.ts` end-to-end (~500 lines) and map every feature to its undici equivalent. Write the mapping in a comment at the top of the file before editing.**

- [ ] **Step 2: Replace `protocol.request(requestOptions, callback)` with `undici.request(url, options)`**

- [ ] **Step 3: Re-wire SOCKS via custom dispatcher**

- [ ] **Step 4: Re-wire mTLS / CA via undici Agent**

- [ ] **Step 5: Add ALPN capture**

- [ ] **Step 6: Run all Electron tests; manually smoke-test:**

  - HTTPS GET to `https://www.cloudflare.com` → response should report `h2`
  - HTTPS GET to a known h1.1-only server → reports `h1.1`
  - HTTP proxy via local Charles or mitmproxy
  - SOCKS5 proxy via `ssh -D 1080`
  - mTLS to a server with client-cert auth

- [ ] **Step 7: Commit**

```bash
git add electron/main/http-handler.ts
git commit -m "refactor(electron): migrate HTTP fetcher from node:http to undici (h2 + ALPN)"
```

---

### Task 10: Renderer ALPN indicator

**Files:**
- Modify: `src/components/shared/ResponseViewer.tsx`
- Modify: `src/features/http/lib/requestExecutor.ts` — pass `negotiatedAlpn` from electron response into `Response` shape

In `requestExecutor.ts:ElectronResponse → ApiResponse` translation, propagate `negotiatedAlpn`. Add `negotiatedAlpn?: 'h1.1' | 'h2' | 'h3'` to the `Response` type in `src/types/index.ts`.

In `ResponseViewer.tsx`, near the existing status/time/size metadata, render:
```tsx
{response.negotiatedAlpn && (
  <span title={`Negotiated ${response.negotiatedAlpn.toUpperCase()}`}>
    {response.negotiatedAlpn === 'h2' ? 'HTTP/2' : 'HTTP/1.1'}
  </span>
)}
```

- [ ] **Step 1: Add type field; thread through executor**
- [ ] **Step 2: Render in viewer**
- [ ] **Step 3: Smoke test, commit**

---

### Task 11: Documentation + ADR

**Files:**
- Modify: `docs/ARCHITECTURE.md` — add "Streaming and HTTP/2" section
- Create: `docs/adr/0003-streaming-and-http2.md`

ADR captures:
- Why a separate `executeHttpProxyStreaming` instead of a flag on `executeHttpProxy` (different return shape; doesn't compose with size cap; sharper contract)
- Why the worker streaming path doesn't enforce `MAX_RESPONSE_SIZE` (streaming is unbounded by intent; per-chunk budget protects against giant single chunks but not total volume; users opting into streaming accept the trade-off)
- Why Connect-Web bypasses the worker for gRPC streaming (HTTP/2 client streams in browsers tunnel through the Worker poorly; same-origin restrictions only matter for the unary path)
- Why undici instead of `node:http2` directly (undici handles connection pooling, h2 multiplexing, ALPN negotiation, and h1.1 fallback; using h2 directly forces protocol-version handling on us)
- Why no `react-window` dep (constrained use case; ~50 LOC of windowing helper is enough)

- [ ] **Step 1: Write the architecture section**
- [ ] **Step 2: Write the ADR**
- [ ] **Step 3: Commit**

---

## Self-review checklist

- [ ] `rg -n "await response.text\(\)" worker/handlers/` returns matches only in handlers that genuinely need the buffered shape (gRPC unary, MCP one-shot)
- [ ] `rg -n "node:http|from 'http'|from 'https'" electron/main/` returns no matches (other than Node-API SOCKS code that needs `net`/`tls` directly)
- [ ] `rg -n "createConnectTransport" src/` returns matches in both `grpcClient.ts` and `grpcStreamingClient.ts` (both consume the same transport factory)
- [ ] `npm run validate` passes; new tests added per task
- [ ] Manual smoke tests:
  - SSE endpoint streams incrementally (events appear over seconds, not all at once)
  - 50 MB JSON response renders in the windowed viewer without freezing the page
  - gRPC server-streaming method returns multiple messages in the panel
  - HTTPS GET to an h2-capable upstream from Electron shows "HTTP/2" in the metadata bar
  - HTTPS GET to an h1.1-only upstream shows "HTTP/1.1"
  - mTLS request continues to work after undici migration

---

## Out of scope

- **HTTP/3:** Wait for Node `undici` h3 to stabilise. The ALPN field is already shaped for `'h3'` so the renderer can surface it later without a type change.
- **Worker-side h2:** Cloudflare Workers' `fetch` already negotiates h2/h3 with the upstream; the runtime doesn't expose ALPN.
- **gRPC streaming via the Worker:** Connect-Web speaks directly to the upstream when CORS permits. If a CORS-blocked upstream needs Worker-as-tunnel, that's a separate plan — gRPC streams over the Worker have HTTP/2 framing concerns the runtime doesn't fully support today.
- **Renderer h2 negotiation:** Browser fetch handles this transparently; no API.
- **GraphQL subscriptions over HTTP/2:** Out of scope; existing `graphql-ws` path stays.
