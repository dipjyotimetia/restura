# Audit Report: Renderer, Hooks, and Electron IPC

**Date:** 2026-07-25
**Mode:** Read-only review; no production source changed.

## Coverage

| Area | Reviewed | No finding | Findings |
| --- | ---: | ---: | ---: |
| Active production React TSX | 239 | 237 | 2 required |
| Active React hooks | 53 | 47 | 6 required |
| Electron IPC | 84 production sources plus 48 renderer consumers | — | 1 critical, 2 required |

The hook filename scan's additional `src/types/usebruno-lang.d.ts` is a type
declaration, not an active hook. The IPC review traced 125 canonical commands,
3 static events, 31 templated event prefixes, 7 namespace allowlists, and 8
generic menu/app events across renderer → preload → types → channels →
validation → handler → lifecycle → tests.

## Findings

### Critical: enforce per-window ownership for every ID-addressed stream/session

Connection records retain `webContentsId`, but many follow-up operations only
look up a caller-supplied ID. A second trusted window can operate another
window's WebSocket, Socket.IO, SSE, MCP, Kafka, MQTT, gRPC, AI, or AI Lab
resource. It can therefore use an authenticated session or cancel/reconnect a
resource it does not own.

- Evidence: `electron/main/handlers/websocket-handler.ts:84` stores ownership
  while `websocket-handler.ts:196` does not enforce it for send/disconnect;
  `socketio-handler.ts:245` has the equivalent gap. The correct counterexample
  is `electron/main/handlers/ai-lab-handler.ts:276`.
- Remedy: use `createValidatedEventHandler` for ownership-sensitive calls;
  reject a caller whose `event.sender.id` differs from the entry owner before
  every read, mutation, cancel, and same-ID reconnect. Bind gRPC pending
  buffers to the same owner.
- Verify: resources created by sender A cannot be requested, sent through,
  published through, cancelled, disconnected, or replaced by sender B.

### Required: give static preload subscriptions composable unsubscription

`capture.onReceived` and `collections.onFileChanged` return no unsubscribe,
and the exposed cleanup removes every listener on the channel. One component
unmounting can silence another subscriber.

- Evidence: `electron/main/preload/integration-api.ts:67`,
  `electron/main/preload/integration-api.ts:133`,
  `electron/types/api/integrations.ts:165`,
  `src/components/shared/CaptureImportListener.tsx:29`.
- Remedy: use the existing `subscribe` convention and return `() => void`;
  remove global `remove*Listener` APIs.
- Verify: after unsubscribing A, a subsequent event reaches B only.

### Required: prevent channel-name drift at registration/teardown

The IPC surface test accepts a textual `IPC.*` reference anywhere in a main
file, even when the actual handler is registered against a literal. A channel
rename can thus leave preload and main disconnected while CI remains green.

- Evidence: `electron/main/storage/file-operations.ts:213`,
  `electron/main/security/secret-handle-store.ts:249`, and
  `electron/main/__tests__/ipc-surface.test.ts:83`.
- Remedy: replace command literals with `IPC.*` and enforce a structural rule
  against literal `ipcMain.handle/on/removeHandler` registrations outside the
  documented static-event infrastructure.
- Verify: mock registrations and compare their actual names against
  `ALL_IPC_CHANNELS`, or fail on command-literal registrations.

### Required: keep request completion bound to its origin tab

HTTP completions and script results use active-tab store mutations. Switching
tabs during an in-flight request can write the result to the newly active tab.

- Evidence: `src/features/http/hooks/useHttpRequestPage.ts:100`,
  `useHttpRequestPage.ts:136`, `useHttpRequestPage.ts:155`,
  `src/features/registry/useRequestRunner.ts:92`, and
  `src/store/useRequestStore.ts:296`.
- Remedy: capture origin tab ID; introduce target-tab mutation actions that
  safely no-op after a tab closes; pass that ID through runners.
- Verify: defer a request, switch tabs, resolve it, and assert response and
  script output appear only on its origin tab.

### Required: reconcile MCP UI state when component cleanup disconnects

The component disconnects its client on connection change/unmount but leaves
persisted status and capabilities as connected. A later remount can display a
dead connection and invoke/discover through no client.

- Evidence: `src/features/mcp/components/McpRequestBuilder.tsx:50`.
- Remedy: teardown the prior ID by disconnecting, setting status to
  disconnected, clearing capabilities, and rejecting late connect/discover
  completions.
- Verify: connect A, switch/unmount/remount, and require A to reconnect before
  calls are enabled.

### Required: restrict untrusted HTML response previews with CSP

The sandboxed `srcDoc` preview allows scripts without a restrictive CSP. Its
opaque origin does not prevent outbound/localhost requests.

- Evidence: `src/components/shared/ResponseViewer.tsx:599`.
- Remedy: prepend a restrictive response-preview CSP (at least
  `default-src 'none'`, with only necessary inline-style/data-image
  allowances), while retaining sandbox isolation.
- Verify: assert CSP in unit tests and block script/image network traffic in a
  browser test.

### Required: clear Kafka inspector busy state after failed IPC

A rejected inspector action bypasses `setBusy(false)`; a mount-triggered
`void refresh()` also becomes an unhandled rejection.

- Evidence: `src/features/kafka/components/useInspectorFetch.ts:29`.
- Remedy: catch into visible error state, clear busy in `finally`, and guard
  late results after unmount/newer refresh.
- Verify: rejected initial and manual refreshes clear busy and show an error.

### Required: abort collection and load runs on unmount

Closing/removing the dialog does not stop work or prevent callbacks updating
unmounted hook state.

- Evidence: `src/features/collections/hooks/useCollectionRun.ts:117` and
  `src/features/load-testing/hooks/useLoadTest.ts:23`.
- Remedy: abort in effect cleanup and only commit state for the active
  controller.
- Verify: unmount a deferred run, assert abort, then prove late progress and
  completion do not commit state.

### Required: prevent stale Git dialog state

A late `Promise.all` result for one directory can overwrite a newly opened
directory's status, branches, or log.

- Evidence: `src/hooks/useGit.ts:34` and `src/hooks/useGit.ts:51`.
- Remedy: invalidate prior requests with a generation/cancellation guard.
- Verify: start A, switch to B, settle A last, and assert B stays visible.

### Required: prevent release-note response races

An earlier channel/reload request may overwrite newer releases, selection,
pagination, or loading state.

- Evidence: `src/components/shared/settings/useReleaseNotes.ts:17`,
  `useReleaseNotes.ts:41`, and `useReleaseNotes.ts:45`.
- Remedy: use a latest-request generation and serialize/dedupe `loadMore`.
- Verify: settle an old-channel request after a newer one; newer state wins.

### Required: make store hydration readiness truthful

`useStoreHydration` returns true after a timer without awaiting its
`rehydrate()` promises. Current Home ignores it, but its public readiness
contract is unsafe for future consumers.

- Evidence: `src/hooks/useStoreHydration.ts:42` and
  `useStoreHydration.ts:54`.
- Remedy: await all applicable hydrations with an unmount guard.
- Verify: delayed adapters retain `isHydrated = false` until the final store
  settles.

## Verified strengths

- No raw Electron or `ipcRenderer` capability is exposed to the renderer;
  bridge methods are narrow and typed.
- Context isolation, renderer sandboxing, top-frame sender pinning, Zod
  validation, rejected-payload redaction, rate limits, SecretRef main-process
  resolution, and relevant SSRF/DNS/broker protections are present.
- Renderer review found no production `localStorage/sessionStorage` use, no
  non-semantic click handlers lacking keyboard equivalents, no unscoped Zustand
  subscriptions, and no uncleaned global effects/listeners.
- Intentional Electron-only capabilities match the capability model; no
  unsupported web parity claim was found.

## Validation

- Passed: `npm run type-check:all`
- Passed: `npm run lint`
- Passed: `npm run architecture:check`
- Passed: IPC-focused tests — 5 files / 319 tests.
- `npm run test:coverage` was started twice; this runner returned only the
  Git-fixture setup output rather than a final Vitest exit summary. Do not
  treat full-coverage status as verified by this audit; rerun it in a normal
  terminal before remediation is merged.

## Recommended remediation order

1. Cross-window stream/session ownership (security boundary).
2. Response-preview CSP and IPC subscription/channel-contract fixes.
3. Origin-tab request result correctness.
4. Hook lifecycle/error/race fixes, each as an isolated, regression-tested
   slice.

The next phase is a human-approved remediation plan; no production change is
authorised by this report.
