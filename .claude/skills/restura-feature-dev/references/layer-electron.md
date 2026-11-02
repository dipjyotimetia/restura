# Electron IPC layer

When the app runs in Electron, the renderer's network calls bypass the Worker and go through IPC handlers in `electron/main/`. The preload script at `electron/main/preload.ts` exposes a typed bridge on `window.electron`.

Every IPC channel touches **four files**:

1. The handler implementation — `electron/main/<feature>-handler.ts`
2. The Zod validation schema — `electron/main/ipc/validators/<area>.ts`
3. The preload bridge — `electron/main/preload.ts`
4. The type declaration — `electron/types/electron-api.ts` (plus a module under `electron/types/api/`)

Forgetting any one of them produces silent breakage in desktop. The renderer compiles fine; the call throws at runtime. **Always edit all four together.**

## Channel naming

`<domain>:<verb>` lowercase: `http:request`, `grpc:request`, `ws:connect`, `fs:readFile`, `dialog:openFile`, `store:get`. New channels follow this scheme.

## Handler registration with validation

Always wrap with `createValidatedHandler` from `electron/main/ipc/validators/`:

```ts
// electron/main/myfeature-handler.ts
import { ipcMain } from 'electron';
import { createValidatedHandler, MyConfigSchema } from './ipc-validators';
import { createRateLimiter } from './ipc-rate-limiter';

const myFeatureRateLimiter = createRateLimiter(60, 60_000); // 60/min

export function registerMyFeatureIPC(): void {
  ipcMain.handle(
    'myfeature:do',
    createValidatedHandler('myfeature:do', MyConfigSchema, async (config) => {
      if (!myFeatureRateLimiter()) {
        return { error: 'Rate limit exceeded' };
      }
      // ...do the work...
      return result;
    })
  );
}
```

The wrapper Zod-parses the input before calling the handler. If parsing fails it throws a formatted error, which Electron serializes as an IPC rejection on the renderer side.

Then call `registerMyFeatureIPC()` from `electron/main/main.ts` during app init.

## Zod schema under `electron/main/ipc/validators/`

```ts
export const MyConfigSchema = z.object({
  url: z.string().url(),
  body: z.string().max(MAX_HTTP_BODY_BYTES).optional(),
  method: z.enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH']),
  // ...
});
export type MyConfig = z.infer<typeof MyConfigSchema>;
```

Use `z.string().url()`, size limits with `.max()`, and `.enum()` for constrained fields. Export the inferred type so the handler imports it.

## Preload bridge

Add the channel to the namespaced API in `electron/main/preload.ts`:

```ts
const electronAPI = {
  // ...existing namespaces...
  myfeature: {
    do: (config: MyConfig) => ipcRenderer.invoke('myfeature:do', config),
  },
};
contextBridge.exposeInMainWorld('electron', electronAPI);
```

Everything lives under `window.electron.<namespace>.<method>()`. Never expose raw `ipcRenderer` to the renderer — the preload's whole job is to be the typed, audited surface.

## Type declaration

`electron/types/electron-api.ts` (plus a module under `electron/types/api/`) is where `window.electron` is typed. Add your namespace interface and include it in the main `ElectronAPI`:

```ts
export interface ElectronMyFeatureAPI {
  do: (config: ElectronMyConfig) => Promise<MyResult>;
}

export interface ElectronAPI {
  // ...existing namespaces...
  myfeature: ElectronMyFeatureAPI;
}
```

This file has its own `ElectronMyConfig` type, structurally matching the Zod-inferred `MyConfig` in `ipc-validators.ts` and the canonical type in `src/types/`. Three definitions, all must match. Yes, this is duplication; it's the cost of keeping the layers independently buildable.

The Zod-vs-preload-type pair is checked at compile time: add a line to `electron/main/ipc/validators/ipc-payload-parity.ts` (`export type MyParity = Assert<PayloadParity<Arg0<Api['myfeature']['do']>, typeof MySchema>>;`). `npm run type-check:all` then fails if the type can send something the schema rejects, or the schema has a field the type cannot name. A deliberate difference needs a `// drift:` comment plus the third `PayloadParity` argument (schema-only keys). See "Type sharing" in `SKILL.md`.

## Rate limiting

`electron/main/ipc/ipc-rate-limiter.ts` exports `createRateLimiter(maxRequests, windowMs)`. Apply per-feature:

```ts
const myFeatureRateLimiter = createRateLimiter(60, 60_000); // 60 per minute
```

Inside the handler, check it and **return** a `{ error: 'Rate limit exceeded' }` object — don't throw. The renderer receives it as a resolved value and can handle it gracefully without going down the catch path.

## Error normalization

For non-rate-limit errors, throw a plain `Error` with a message. Electron serializes this as a rejection on the renderer side. The renderer's executor catches it and converts to the unified `Response` shape with `status: 0`.

Do not return `{ status: 0, ... }` directly from the IPC handler — that's the renderer's job. The IPC layer either succeeds with the protocol's success shape or rejects.

## Logging

Use `request-logger.ts` to emit structured log entries when a request completes. Pattern:

```ts
const onComplete = (entry: LogEntry) => mainWindow.webContents.send('log:entry', entry);
registerHttpHandlerIPC(onComplete);
```

This drives the Network Console feature. New protocol handlers should hook into this if they want to appear in the log.

## When IPC has a streaming or push pattern

For protocols that push events to the renderer (WebSocket, gRPC streaming, SSE):

- Initiation goes through `ipcMain.handle` (request/response, validated like above).
- Events go from main → renderer via `mainWindow.webContents.send('<domain>:event', payload)`.
- The renderer subscribes via the preload bridge: expose an `on(event, callback)` and `off(event, callback)` pair that internally use `ipcRenderer.on`/`removeListener`.
- Always provide a teardown channel (`<domain>:close`) so the main process can clean up open sockets when the renderer navigates away.

See `electron/main/handlers/websocket-handler.ts` for the canonical streaming example.

## Long-lived connections — required pattern

Any handler that holds connections per renderer (gRPC streaming, MCP, SSE, WebSocket, Socket.IO, Kafka, MQTT) MUST keep them in a `StreamRegistry` (`electron/main/ipc/stream-registry.ts`) rather than a hand-rolled `Map`. The registry owns the connection map, same-id replace, renderer-destroyed cleanup, templated events, `disposeAll`, and the connect claim that spans the awaited dial. Protocol policy (rate limits, concurrency caps, the transport itself, teardown mechanics) stays in the handler.

```ts
import { EVENT_PREFIX } from '../../shared/channels';
import { StreamRegistry } from '../ipc/stream-registry';

interface ActiveConn {
  webContentsId: number;
  close: () => void; /* ... */
}

const connections = new StreamRegistry<ActiveConn>({
  prefixes: EVENT_PREFIX.myproto,
  dispose: (entry) => entry.close(), // idempotent: cancel, replace and renderer death can all fire
});

ipcMain.handle(
  'myproto:open',
  createValidatedHandler('myproto:open', Schema, async (cfg, event) => {
    // After the handler's own rate-limit / concurrency checks. Synchronous, before the first await.
    const claim = connections.reserveClaim(cfg.connectionId, event.sender);
    if (!claim) return { error: 'Connection already in progress' };
    try {
      const conn = await openTransport(cfg); // DNS, keychain, handshake
      const entry = { webContentsId: event.sender.id, close: () => conn.terminate() };
      if (!connections.commitClaim(claim, event.sender, entry)) {
        entry.close(); // claim was cancelled, or a newer connection took the id
        return { error: 'Connection cancelled' };
      }
      return { id: cfg.connectionId };
    } finally {
      connections.releaseClaim(claim);
    }
  })
);
```

- `reserveClaim` returns `undefined` when this owner and id already has a live claim, or the sender is already destroyed. `commitClaim` registers the entry only through a live claim and returns `false` otherwise, in which case the caller tears the unregistered entry down. `releaseClaim` drops the claim without running `disposeClaim`.
- Whether an explicit disconnect cancels an in-flight claim is handler policy: call `connections.cancelClaim(connectionId, event.sender.id)` to cancel, or don't. Give the registry a `disposeClaim` option when a claim holds something to abort (an `AbortController`, an in-flight transport).
- Emit per-connection events with `connections.emit(connectionId, webContentsId, eventName, payload)` (needs the `prefixes` option, from `EVENT_PREFIX`), or build the channel yourself with `eventChannel(prefix, id)` from `electron/shared/channels.ts`. Never hand-write `'myproto:event:' + id` strings.
- Call `connections.disposeAll()` and `connections.disposeAllClaims()` from the handler's `stop*Cleanup()` (the `IPC_MODULES` dispose half).
- See `electron/main/handlers/sse-handler.ts` for a complete example.

`bindRendererCleanup` and `disposeByOwner` in `electron/main/ipc/connection-cleanup.ts` remain the lower-level primitives the registry is built on. Reach for them directly only for a resource that is not a stream connection (a map the registry doesn't fit). `bindRendererCleanup(map, wc, onDeath)` is idempotent per `(map, webContents)` pair, so reconnects do not stack `destroyed` listeners; `disposeByOwner(map, deadId, fn)` disposes exactly that renderer's entries.

## Pre-flight DNS guard — required for non-HTTP transports

The HTTP / gRPC paths get DNS-resolved SSRF protection from undici's `Agent.connect.lookup` (`createSecureLookup`). Other transports (`ws`, `socket.io-client`, native `fetch` for MCP SSE) don't accept a `lookup` hook. For those, call the pre-flight guard before opening the transport:

```ts
import { assertUrlHostnameSafe } from './dns-guard';

await assertUrlHostnameSafe(url, {
  allowLocalhost: env === 'development',
  allowedSchemes: ['ws', 'wss'], // override for non-http schemes
});
```

This applies the URL-string policy (`validateURL`) and resolves the hostname, calling `assertResolvedAddressAllowed` against every record. Throws synchronously on any violation. **Pre-flight only** — does not protect against TTL=0 DNS rebind during connect; see `references/gotchas.md` and ADR-0006 for the limit.

## Local dev

`npm run electron:dev` runs Vite + Electron together. The Electron main process loads `http://localhost:5173`. Main-process source changes require a restart; renderer changes hot-reload via Vite.

## Type-checking the main process

The main process has its own tsconfig:

```bash
npx tsc --noEmit -p electron/tsconfig.json
```

`npm run validate` runs the renderer's tsc — not the main process. Run the electron tsc explicitly when you change main-process code.
