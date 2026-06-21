# Renderer layer

The renderer is the React SPA in `src/`. It loads via `https://` in web mode and `file://` in Electron, with `createHashRouter` so the same routes work in both. The same compiled bundle ships to both harnesses — runtime branching via `isElectron()` is the only way to differentiate.

## Feature folder layout

HTTP is the canonical example. New features should follow:

```
src/features/<name>/
├── components/        # PascalCase. Complex components get a subdirectory with index.tsx.
├── hooks/             # camelCase, useXxx prefix. Orchestrates store + executor.
├── lib/               # camelCase. Pure functions, executors, helpers.
│   └── __tests__/     # Colocated *.test.ts
└── store/             # Feature-local Zustand stores (only if the state isn't global).
```

No `index.ts` barrels at the feature root. Consumers import directly:

```ts
import { executeRequest } from '@/features/http/lib/requestExecutor';
```

A complex component can have its own subdirectory with an `index.tsx` and internal sub-components, re-exported by a one-line file at the parent (`components/RequestBuilder.tsx` → `export { default } from './RequestBuilder/index'`). Use this when a component grows past ~300 lines, not preemptively.

## The executor pattern

The executor is the heart of any protocol feature. Plain async function — not a class, not a hook. The hook calls it; components call the hook.

Shape (see `src/features/http/lib/requestExecutor.ts`):

```ts
export async function executeRequest(
  options: RequestExecutorOptions
): Promise<RequestExecutionResult> {
  // Build config from options + environment + auth + scripts...

  let responseData;
  if (shouldUseCorsProxy(globalSettings)) {
    // Web mode: POST to /api/proxy on the Worker
    responseData = await executeViaCorsProxy(axiosConfig);
  } else if (isElectron()) {
    // Electron: native IPC bridge
    responseData = await window.electron!.http.request(config);
  } else {
    // Direct Axios (Electron without proxy, or web with proxy disabled)
    responseData = await axios(axiosConfig);
  }

  return { response: normalizeResponse(responseData), ... };
}
```

Branching order matters: `shouldUseCorsProxy` is checked first because in web mode it defaults to `true` (`corsProxy.enabled` ships true in `useSettingsStore`). Electron bypasses the Worker entirely.

## Error normalization

The executor never throws to the caller except in catastrophic cases. Errors are caught and converted into a `Response` with `status: 0`, `statusText: 'Error'`, and the message in the body. This unified shape (`Response` in `src/types/index.ts`) lets the UI handle success and failure uniformly.

When adding a new protocol, mirror this. Components should not have to wrap calls in try/catch.

## Zustand stores

Pattern (every store):

```ts
export const useXStore = create<XState>()(
  persist((set, get) => ({ ...state, ...actions }), {
    name: 'storage-key',
    version: N,
    // storage: dexieStorageAdapters.<name>(),  // for sensitive data
    // migrate: (persisted, version) => ...,
    // partialize: (state) => omit transient fields,
  })
);
```

- Naming: always `useXStore`. File name matches.
- Global stores live in `src/store/`. Feature-local stores (e.g. `useCookieStore` for HTTP) live in `src/features/<name>/store/`.
- Sensitive data (settings with secrets, cookies) → `dexieStorageAdapters` (encrypted IndexedDB). Default = localStorage.
- Use `partialize` to exclude transient state (`isLoading`, `currentResponse`) from persistence.
- Add a Zod schema in `src/lib/shared/validations.ts` and wire it through `store-validators.ts` for soft validation on updates.
- Outside React (in lib code), use `useXStore.getState()` for imperative access. Inside components, use the hook directly.

### Rehydration is async for encrypted stores

`useSettingsStore` and `useCookieStore` use IndexedDB and fetch their encryption key asynchronously (from `window.electron.store.get()` in Electron, locally generated on web). `getState()` is fully populated only after rehydration completes. Use the `onRehydrateStorage` callback for post-load logic.

## Hooks

Hooks bridge stores to executors. They:

- Read state from one or more stores
- Expose action callbacks that call executors and update stores
- Manage loading and error UI state

Convention: one main hook per feature (`useHttpRequest`, `useGrpcRequest`). Add a page-composition hook (`useHttpRequestPage`) if a route assembles multiple feature hooks.

## UI components

- Use `cn()` from `@/lib/shared/utils` to merge classes — it's `twMerge(clsx(...))`. Never string-concat Tailwind classes.
- New UI primitives: follow the Radix + `cva` + `asChild` pattern in `src/components/ui/button.tsx`.
- Tailwind v4: no `tailwind.config.js`. Use design tokens (`bg-primary`, `text-foreground`, `border-border`, `ring`) — don't reach for arbitrary values when a token exists.
- Composition: features import from `@/components/ui/` (primitives) and `@/components/shared/` (cross-feature composites like `ResponseViewer`, `KeyValueEditor`, `CodeEditor`). Never import from another feature's internals.

## Lazy loading

Use `lazyComponent` from `@/lib/shared/lazyComponent` (mirrors `next/dynamic` ergonomics, wraps `React.lazy` + `Suspense`). Use it for heavy panels (Monaco-based editors, the network console) that aren't on the initial route.

## Routes

Routes are declared in `src/routes/`. The router is `createHashRouter` — URL is `https://app/#/route`. `window.location.pathname` is `/` everywhere; use React Router hooks for navigation state.
