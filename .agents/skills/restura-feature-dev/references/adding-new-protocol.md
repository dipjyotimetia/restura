# Adding a new protocol end-to-end

For: SSE, MQTT, SignalR, GraphQL subscriptions, AMQP, STOMP, or any new request type that needs its own dispatch path.

This is the heaviest case in the codebase. Skipping a step almost always produces a working web build with broken Electron behavior, or vice versa, with no compile error to catch it. **Follow the steps in order — they're sequenced so each step compiles cleanly on top of the previous one.**

The example throughout uses `sse` (Server-Sent Events) as a stand-in. Replace with your protocol name.

## Decide first: request/response, or streaming?

The shape of the IPC differs:

- **Request/response** (HTTP-like, gRPC unary): single `ipcMain.handle` call, single Worker POST endpoint. Mirror HTTP.
- **Streaming / push** (WebSocket, SSE, gRPC streaming): the IPC initiation handle returns a connection ID; events are pushed via `webContents.send('<domain>:event', ...)`. Worker-side, you'll need to think about whether streaming is even feasible — Cloudflare Workers support streamed responses but the renderer needs to consume them via `EventSource` or `ReadableStream`. For some protocols, the Worker may need to be a websocket relay or the web build simply isn't supported.

If the web build can't reasonably support the protocol, that's OK — many real protocols are Electron-only. State this explicitly and skip the Worker layer (Step 3 below). The renderer's executor should then return a clear "unsupported in browser" error in web mode.

## Step 1 — Define the canonical types

Edit `src/types/index.ts`. Add the request, response, and any auxiliary types:

```ts
export interface SseRequest {
  id: string;
  name: string;
  url: string;
  headers: KeyValue[];
  // ...
}

export interface SseEvent {
  id: string;
  event: string;
  data: string;
  timestamp: number;
}
```

Add the new request to the `Request` discriminated union if it should appear in collections / history. Add `'sse'` to any protocol enum (`RequestType` etc.).

Add a Zod schema in `src/lib/shared/validations.ts` mirroring the interface. Wire it through `src/lib/shared/store-validators.ts` so request updates get soft-validated.

## Step 2 — Create the feature folder

```
src/features/sse/
├── components/
│   └── SseRequestBuilder.tsx     # the UI
├── hooks/
│   └── useSseRequest.ts          # bridges store + executor + UI state
├── lib/
│   ├── sseExecutor.ts            # the dispatch function with isElectron() branching
│   └── __tests__/
│       └── sseExecutor.test.ts
└── store/                        # only if state is feature-local; otherwise extend useRequestStore
```

The executor is the centerpiece. It branches on `isElectron()` and `shouldUseCorsProxy()` (or the protocol's equivalent). See `references/layer-renderer.md` for the pattern.

For streaming protocols, the executor returns subscription handles, not promises of responses. Components subscribe via the hook and unsubscribe on unmount.

## Step 3 — Add the Worker handler (if web is supported)

`worker/handlers/sse.ts`:

```ts
import type { Context } from 'hono';
import type { Env } from '../index';
import { validateURL } from '../shared/url-validation';

export async function sse(c: Context<{ Bindings: Env }>) {
  const body = await c.req.json<SseRequestBody>();
  // SSRF, method allow-list, etc. — see references/layer-worker.md
  // Stream the upstream response back to the renderer
  const upstream = await fetch(body.url, { headers: ... });
  return new Response(upstream.body, {
    headers: { 'Content-Type': 'text/event-stream' },
  });
}
```

Mount in `worker/index.ts`: `app.post('/api/sse', sse);`

For non-streaming protocols, return the standard `c.json({ status, statusText, headers, data, size })` shape.

Add tests in `worker/handlers/__tests__/sse.test.ts` — at minimum the SSRF branches.

## Step 4 — Add the Electron IPC handler

This is the four-file step. Do all four together:

### 4a. Schema in `electron/main/ipc-validators.ts`

```ts
export const SseConfigSchema = z.object({
  url: z.string().url(),
  headers: z.array(z.tuple([z.string(), z.string()])),
  // ...
});
export type SseConfig = z.infer<typeof SseConfigSchema>;
```

### 4b. Handler in `electron/main/sse-handler.ts`

```ts
const sseRateLimiter = createRateLimiter(20, 60_000);
const connections = new Map<string, EventSource>();

export function registerSseHandlerIPC(): void {
  ipcMain.handle(
    'sse:connect',
    createValidatedHandler('sse:connect', SseConfigSchema, async (config) => {
      if (!sseRateLimiter()) return { error: 'Rate limit exceeded' };
      const id = crypto.randomUUID();
      const source = new EventSource(config.url);
      source.onmessage = (e) => {
        BrowserWindow.getAllWindows()[0]?.webContents.send('sse:event', { id, ...e });
      };
      connections.set(id, source);
      return { id };
    })
  );

  ipcMain.handle('sse:close', (_, id: string) => {
    connections.get(id)?.close();
    connections.delete(id);
  });
}
```

Streaming protocols **must** track open connections in a map and provide a close channel. Otherwise sockets leak when the user navigates away.

Call `registerSseHandlerIPC()` from `electron/main/main.ts`.

### 4c. Preload bridge in `electron/main/preload.ts`

```ts
sse: {
  connect: (config: SseConfig) => ipcRenderer.invoke('sse:connect', config),
  close: (id: string) => ipcRenderer.invoke('sse:close', id),
  on: (cb: (e: SseEvent) => void) => {
    const handler = (_: unknown, e: SseEvent) => cb(e);
    ipcRenderer.on('sse:event', handler);
    return () => ipcRenderer.removeListener('sse:event', handler);
  },
},
```

The `on` returns its own teardown function. Renderer code calls the returned function in a `useEffect` cleanup.

### 4d. Type declaration in `electron/types/electron.d.ts`

```ts
export interface ElectronSseAPI {
  connect: (config: ElectronSseConfig) => Promise<{ id: string } | { error: string }>;
  close: (id: string) => Promise<void>;
  on: (cb: (e: SseEvent) => void) => () => void;
}

export interface ElectronAPI {
  // ...
  sse: ElectronSseAPI;
}
```

## Step 5 — Wire the executor to dispatch correctly

```ts
// src/features/sse/lib/sseExecutor.ts
export function connectSse(config: SseRequest, onEvent: (e: SseEvent) => void): SseHandle {
  if (isElectron()) {
    let teardown: (() => void) | undefined;
    const promise = window.electron!.sse.connect(config).then((res) => {
      if ('error' in res) throw new Error(res.error);
      teardown = window.electron!.sse.on((e) => {
        if (e.id === res.id) onEvent(e);
      });
      return res.id;
    });
    return {
      close: async () => {
        const id = await promise;
        teardown?.();
        await window.electron!.sse.close(id);
      },
    };
  }

  // Web: EventSource directly, or via /api/sse if we need a proxy
  const source = new EventSource(/* ... */);
  source.onmessage = (e) => onEvent(/* convert */);
  return { close: () => source.close() };
}
```

The function shape is the same in both branches; the implementation differs. Components shouldn't know which branch they're on.

## Step 6 — Add UI

Build the request builder in `src/features/sse/components/SseRequestBuilder.tsx`. Compose Radix primitives from `@/components/ui/`. Use shared editors (`KeyValueEditor`, `CodeEditor`) from `@/components/shared/`.

Wire it into the route that picks request types (likely `src/routes/index.tsx` or wherever the type switcher lives).

Add a `'sse'` icon and label to whatever protocol picker exists.

## Step 7 — Tests

- `src/features/sse/lib/__tests__/sseExecutor.test.ts` — mock `window.electron.sse` and `EventSource`; assert dispatch branches correctly.
- `worker/handlers/__tests__/sse.test.ts` — at minimum the SSRF branches.
- `electron/main/__tests__/` — schema validation tests for `SseConfigSchema`.

## Step 8 — Verify both harnesses

```bash
npm run validate       # type-check + lint + test
npx tsc --noEmit -p worker/tsconfig.json    # if Worker was touched
npx tsc --noEmit -p electron/tsconfig.json  # if Electron main was touched

npm run dev            # Try the protocol in web mode
npm run electron:dev   # Try the same protocol in desktop mode
```

For streaming protocols, the smoke test is: connect, see events flow, navigate away, confirm no orphaned sockets in the main process logs.

## Common mistakes

- **Forgetting the type declaration in `electron.d.ts`.** The renderer compiles fine because `window.electron?.sse` is checked, but the call returns `undefined` at runtime.
- **Skipping the close channel for streaming protocols.** Sockets leak across navigations.
- **Returning `{ status: 0 }` from the IPC handler instead of throwing.** Loses the error normalization in the executor.
- **Adding the protocol to `worker/handlers/` but not to `worker/index.ts`.** Route 404s in web mode.
- **Putting protocol-specific Worker logic into the shared executor instead of behind an `isElectron()` check.** Bundles Worker-only code into the renderer.
- **Forgetting to add the protocol to collection import/export.** Users can't save or share their requests.
