# Gotchas

Non-obvious things that have caused bugs. Skim before any non-trivial change. Read in full before adding a new protocol or touching the dispatch path.

## `'use client'` is a no-op
Several files have `'use client'` at the top — leftover from when the project was Next.js. **It does nothing in Vite.** Don't add it to new files. Don't infer anything about server vs client rendering from its presence. Everything is client-side.

## CORS proxy is on by default in web mode
`useSettingsStore` ships with `corsProxy.enabled = true`. So in web mode, every HTTP request goes through `/api/proxy` (the Worker). If you're debugging why a request hits the Worker instead of going direct, this is why.

In Electron, `corsProxy.enabled` is irrelevant — `shouldUseCorsProxy()` returns `false` whenever `isElectron()` is true.

## Hash routing
The app uses `createHashRouter`. URLs look like `https://app/#/route`. Implications:
- Server-side route matching is impossible (and unnecessary).
- Deep links in Electron parse the hash portion (see `electron/main/deep-link-handler.ts`).
- Don't write code that assumes `window.location.pathname` reflects the current app route — it'll be `/` everywhere. Use the React Router hooks.

## Three duplicated type definitions per IPC config
For any IPC-bound type, three places hold a definition:
1. `src/types/index.ts` — canonical renderer type
2. `electron/main/ipc-validators.ts` — Zod schema + inferred type
3. `electron/types/electron.d.ts` — preload bridge declaration

Change one, change all three in the same PR. There's no compiler help to keep them aligned. This is intentional — separation lets each layer build independently.

## Worker handler types are also separate
The Worker's request body interfaces live locally in each handler file (`worker/handlers/<name>.ts`). They're not imported from the renderer — the renderer constructs the matching JSON payload by hand in its executor. When you change a Worker request shape, update the renderer's payload construction in the same PR.

## Storage rehydration is async
`useSettingsStore` and `useCookieStore` use `dexieStorageAdapters` (encrypted IndexedDB). Their `getState()` is fully populated only after rehydration completes. For post-load logic, use the `onRehydrateStorage` callback — don't read from the store synchronously at module top level.

## Validation is *soft* in Zustand stores
`store-validators.ts` calls `safeParse` and on failure logs a warning then **applies the update anyway**. This is deliberate — strict validation in the store would lock users out of bad-but-recoverable state. Don't tighten this without discussion.

In contrast, IPC validation is *strict* — invalid inputs are rejected at the boundary.

## Worker has no Zod
The Worker uses manual TS-cast validation. Don't add Zod to it — keeps the bundle small for cold starts on Cloudflare's edge. If validation gets complex, factor a helper function.

## Rate-limit failures are values, not exceptions
Electron IPC rate limiters return `{ error: 'Rate limit exceeded' }` rather than throwing. The renderer receives it as a *resolved* promise. If your renderer code forgets to check for the `error` field, it silently treats rate-limited responses as successful empty payloads.

## Don't expose raw `ipcRenderer` to the renderer
The preload bridge is the **only** place where `ipcRenderer` should be touched on the renderer-facing side. Adding raw `ipcRenderer.invoke` calls in renderer code defeats the audit and typing surface. Always go through `window.electron.<namespace>`.

## `VITE_IS_ELECTRON_BUILD` is build-time only
This env var controls Vite config (excluding the Cloudflare plugin, setting `base: './'` for `file://` serving). **Don't** use it for runtime branching — use `isElectron()` from `@/lib/shared/platform` instead. Runtime branching on a build flag means the same bundle can't serve both harnesses cleanly.

## quickjs-emscripten is excluded from optimizeDeps
`quickjs-emscripten` (the script sandbox) is in `vite.config.mts`'s `optimizeDeps.exclude` because it loads WASM at runtime. If you write tests that touch the script executor, mock it — actually loading WASM in jsdom is painful.

## Cross-feature imports are forbidden
Don't import `src/features/X/lib/` from `src/features/Y/`. Compose at the page or shared-component level (`src/routes/`, `src/components/shared/`). Cross-feature dependencies should go through `src/lib/shared/` or `src/components/shared/`.

If two features genuinely need to share logic, extract it to `src/lib/shared/` and import from both. Don't reach across.

## Electron build excludes the Worker bundle
`electron-builder.json`'s files glob excludes `_worker.js`. The Worker shouldn't ship in the desktop app — but if you accidentally import Worker code from the renderer, the renderer build will pull it in. **Keep Worker code purely in `worker/`.** No imports across that boundary in either direction.

## Renderer-side `urlValidator` mirrors the Worker
`src/features/http/lib/urlValidator.ts` is a renderer-side copy of the Worker's `validateURL`. The renderer copy is for instant UI feedback; the Worker copy is the security boundary. Keep them in sync — if you change one, change the other.

## `npm run validate` doesn't type-check the Worker or Electron main
It runs the renderer's `tsc` only. For full coverage:

```bash
npm run validate
npx tsc --noEmit -p worker/tsconfig.json
npx tsc --noEmit -p electron/tsconfig.json
```

CI runs all three. Add the relevant tsc to your local checklist whenever you've touched `worker/` or `electron/`.

## Electron-only protocols are a valid outcome
Not every protocol can sensibly run in a browser. MQTT, AMQP, raw TCP — these often have no path through a Worker. State this explicitly and have the renderer's executor return a clear "not supported in browser" error. Don't try to fake it with WebSocket bridges unless you've thought through the security implications.

## Collection import/export is per-protocol
When you add a new protocol, also extend `src/features/collections/lib/importers/` and `exporters.ts`. Otherwise users can't save or share requests for the new protocol. Postman and Insomnia format compatibility is a per-protocol concern.

## Logging hooks are opt-in
The Network Console only sees protocols whose IPC handlers call `request-logger.ts`. New handlers must explicitly hook into this — the Network Console won't auto-discover them.

## `dns-guard.ts` is pre-flight only
`electron/main/dns-guard.ts` resolves the hostname once *before* the transport connects. It does **not** mitigate true DNS rebind — an attacker who controls the resolver can return a public IP on the pre-flight lookup and a private IP on the actual connect (TTL=0). Full protection requires a custom transport-level dispatcher with a `lookup` hook that re-applies `assertResolvedAddressAllowed` at connect time. The HTTP/gRPC paths already do this via undici's `Agent.connect.lookup`; everything else (WebSocket, Socket.IO, SSE, MCP) is pre-flight only. When you wire a new transport, prefer a connector-level `lookup` hook over (or in addition to) the pre-flight check. See ADR-0006.

## `bindRendererCleanup` is per-handler, not global
The dedupe table in `connection-cleanup.ts` keys on `(handlerKey, webContents.id)`. The handler's own `activeConnections` Map is the conventional key — its object identity is stable for the handler's lifetime. Don't share one handlerKey across two handlers, and don't pass a fresh object each call (that defeats the dedupe). Also: when the destroyed listener fires, the dedupe entry is removed automatically — you don't have to clean it up yourself.

## Echo URLs come from a single constants module
`src/lib/shared/echo-defaults.ts` exports `ECHO_URLS` (http/grpc/graphql/websocket/sse) derived from `ECHO_BASE`. Both the store defaults AND the RequestBuilder placeholder strings import from it. If you change the hostname, update only `echo-defaults.ts` and `echo/wrangler.jsonc`. `e2e/real-sse.spec.ts` selects fields via `getByPlaceholder('https://echo.restura.dev/sse')` — a drift would break that test, which is exactly the regression the shared module prevents.
