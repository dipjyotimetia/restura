---
name: restura-feature-dev
description: Use whenever adding, modifying, or extending features in the Restura codebase — a multi-protocol API client (HTTP, gRPC, GraphQL, WebSocket) shipping as both a Cloudflare Pages SPA and an Electron desktop app. Trigger on requests like "add support for SSE/MQTT/SignalR/<any new protocol>", "add a new auth method", "extend the gRPC feature with X", "add a collection importer", "add a panel/keyboard shortcut", or any work in `src/features/`, `worker/`, `electron/main/`. Even small UI changes benefit because the renderer is shared across web and Electron — assumptions break easily across that boundary.
---

# Restura feature development

Restura is a multi-protocol API client. One shared React SPA runs against three backends, and the CLI re-implements execution headlessly:

- **Web** — served from Cloudflare Pages. Network calls go through a Hono Worker at `worker/`.
- **Self-host** — the same Hono app, served by `worker/node-entry.ts`.
- **Electron** — same renderer, but `electron/main/` IPC handlers replace the Worker.
- **CLI** — `cli/src/runner/executors/*`; it must behave like the app or fail explicitly.

This multi-backend design is the central thing to understand. **Most feature bugs in this repo come from wiring one backend and forgetting the others.** The skill exists to keep that from happening.

## Step 1 — Categorize the feature

Before writing any code, identify which category the work falls into. Wiring requirements differ.

**A. New protocol or new request type** — e.g. SSE, MQTT, SignalR, GraphQL subscriptions.
The heaviest case. Touches: a new `src/features/<name>/` folder, an executor with `isElectron()` branching, a Worker handler in `worker/handlers/`, an Electron IPC handler in `electron/main/`, a Zod schema in `electron/main/ipc/validators/<area>.ts`, the preload bridge, and `electron/types/electron-api.ts` (plus a module under `electron/types/api/`). Read **`references/adding-new-protocol.md`** for the end-to-end walkthrough.

**B. Extension on an existing protocol** — e.g. new auth method, new gRPC streaming mode, new HTTP option.
Touches the existing executor in `src/features/<protocol>/lib/`, possibly the Worker handler and the Electron IPC handler. UI updates land in the existing `RequestBuilder`. **Most likely failure mode: forgetting the IPC handler — desktop silently uses the old code path with no compile error.**

**C. Cross-cutting or UI-only** — e.g. new collection importer, new export format, new panel, keyboard shortcut, script API addition.
Renderer-only most of the time. Check whether the feature needs filesystem access (Electron-only via `window.electron.fs`) or network access — if so it's actually category A or B.

**State the category before proceeding.** If unsure, ask the user.

## Step 2 — Universal conventions

These apply to every category.

### Path alias

- Always use `@/` (resolves to `src/`). Never relative `../../` from `src/`.
- **Cross-feature imports are forbidden.** Don't import from another feature's `lib/` or `store/`. Compose at the route or shared-component level.

### Platform detection

- Always use `isElectron()` from `@/lib/shared/platform`. Never check `process.env`, `navigator.userAgent`, or `import.meta.env.VITE_IS_ELECTRON_BUILD` for runtime branching — those are build-time only.
- `window.electron` is typed by `ElectronAPI` in `electron/types/electron-api.ts`, composed from modules under `electron/types/api/`. New IPC methods must be declared there, in a preload domain module (`electron/main/preload/`), and have a Zod schema under `electron/main/ipc/validators/` — **all three** or the call breaks at runtime in desktop.

### Validation philosophy — different at each layer

- **Electron IPC handlers**: Zod is mandatory. Always wrap with `createValidatedHandler(channel, schema, fn)` from `electron/main/ipc/validators/` (`boundary.ts`, re-exported by its `index.ts`).
- **Worker handlers**: Manual checks by default (method allow-list, `validateURL()` for SSRF, header strip-list) to keep the Worker bundle small for cold starts. Where a handler does validate a request body with Zod (`telemetry`, `remote-import`, `ws-ticket`), it goes through `worker/shared/validate-body.ts`; keep Zod off the hot proxy paths.
- **Zustand updates**: Soft Zod via `src/lib/shared/store-validators.ts` — failures log a warning but don't block the update. Mirror this for new stores.
- **Renderer code**: Zod where boundaries are crossed (parsing imports, untrusted inputs), not on internal data flow.

### Type sharing — there isn't any, by design

Types are duplicated across layers intentionally. For an IPC-bound config there are **three** definitions to keep in sync:

1. `src/types/index.ts` — canonical renderer type
2. `electron/main/ipc/validators/<area>.ts` — Zod schema + inferred type
3. `electron/types/electron-api.ts` (plus a module under `electron/types/api/`) — preload bridge declaration

The Worker has its own local interface in each handler file too. Do not try to centralize this into a shared package — it's been considered and rejected as the cost of letting each layer build independently. When you change one definition, change all of them in the same PR.

**Compile-time parity (the link between 2 and 3).** Centralising stays rejected, but drift is no longer a runtime-only surprise: `electron/main/ipc/validators/ipc-payload-parity.ts` asserts, per connect/send payload, that (a) the preload payload type is assignable to `z.input<typeof Schema>` (anything the renderer can send passes validation by type) and (b) every top-level schema key is nameable on the type. It is types-only, compiled by `electron/tsconfig.json`, so `npm run type-check:all` fails on drift. To cover a new IPC payload add one line:

```ts
export type MyConnectParity = Assert<PayloadParity<Arg0<Api['myfeature']['connect']>, typeof MyConnectSchema>>;
```

Fix drift by making the hand-written type match the schema. If the difference is deliberate (e.g. a deprecated field the schema still accepts), do not weaken the schema: add a `// drift: <reason>` comment and pass the key as the third argument (`PayloadParity<P, S, 'fromBeginning'>`). Nested-object fields are checked by assignability only, not key-by-key. Do not add a "Validated by …" comment instead of an assertion.

### `'use client'` directive

Several legacy files have `'use client'` at the top. **It's a no-op in Vite.** Don't add it to new files. Leave it where it exists.

## Step 3 — Wire the layers

Read the focused reference for each layer your category touches:

- `references/layer-renderer.md` — feature folder layout, executor pattern, Zustand stores, hooks, UI composition
- `references/layer-worker.md` — Hono handler signature, SSRF guards, error shape, response size limits
- `references/layer-electron.md` — IPC channel naming, Zod validation, preload bridge, rate limiting, type declarations
- `references/adding-new-protocol.md` — end-to-end checklist for category A
- `references/gotchas.md` — non-obvious traps; **read once before any non-trivial change**

Load only the references your category needs.

## Step 4 — Tests

Tests are colocated under `__tests__/`:

- `src/features/<feature>/lib/__tests__/<fn>.test.ts` — pure-function unit tests
- `worker/handlers/__tests__/<handler>.test.ts` — Worker handler tests (run in jsdom; no miniflare)
- `electron/main/__tests__/<module>.test.ts` — Electron main process tests

Vitest globals are enabled — no need to import `describe`/`it`/`expect`.

For new IPC schemas, add a test that asserts the Zod schema rejects malformed input and accepts the canonical input shape. For new SSRF-touching Worker handlers, test the URL validation branch.

Run before declaring done:

```bash
npm run validate   # full product gate: static policy + tests + builds + size
```

## Step 5 — Verify every backend the change reaches

If the change touches the dispatch path (executor, Worker handler, IPC handler, type declarations), test each backend it reaches before claiming complete:

```bash
npm run dev           # Web (Vite + Worker via Miniflare). http://localhost:5173
npm run electron:dev  # Electron renders the same Vite dev server in a window
npm run build:docker  # Self-host: confirms the Node entry still builds
```

For the CLI, run the executor tests (`npm test --workspace cli`). The Worker, IPC handlers and CLI executors are separate so each uses its native capabilities. They will diverge if you don't watch them.

## "Done" checklist

- [ ] Category identified and stated
- [ ] All applicable layers wired
- [ ] If IPC was touched: type added to `src/types/`, Zod schema under `electron/main/ipc/validators/`, preload bridge updated, `electron/types/electron-api.ts` (plus a module under `electron/types/api/`) updated
- [ ] If Worker was touched: SSRF validation applied, response-size cap enforced, error shape `{ error: string }` with proper status
- [ ] Tests added (unit minimum; schema tests for new IPC; SSRF test for new Worker handler)
- [ ] `npm run validate` passes
- [ ] If dispatch path was touched: manually verified in both `npm run dev` and `npm run electron:dev`
- [ ] If protocol, auth or transport changed: the CLI executor matches the app or refuses explicitly

## When _not_ to use this skill

- Pure documentation edits (README, CLAUDE.md, comments)
- Dependency bumps with no behavior change
- Build/CI configuration that doesn't add runtime behavior
- Style-only refactors with no protocol or storage involvement

For these, just edit directly — the layered checklist would be friction without benefit.
