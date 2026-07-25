# Remediation Tasks: Renderer, Hooks, and Electron IPC

Source: 2026-07-25 audit report. Each task adds the regression test before or
alongside the smallest production change.

## Phase 1: Electron ownership boundary

### Task 1: Define and test owner-aware stream registry operations

- Acceptance: owner-aware lookup, cancellation, and replacement are internal,
  typed, and preserve renderer-destruction cleanup.
- Acceptance: non-owner calls are indistinguishable from missing resources and
  cannot dispose or replace the owner entry.
- Verify: npx vitest run electron/main/__tests__/stream-registry.test.ts
- Dependencies: None
- Files: electron/main/ipc/stream-registry.ts and its test
- Scope: S

### Task 2: Enforce ownership for WebSocket and Socket.IO

- Acceptance: send/emit/disconnect/reconnect reject a non-owner; the owner
  retains current events and behaviour.
- Acceptance: two-sender tests prove resources cannot cross-operate.
- Verify: npx vitest run electron/main/__tests__/websocket-handler.test.ts electron/main/__tests__/socketio-handler.test.ts
- Dependencies: Task 1
- Files: websocket-handler.ts, socketio-handler.ts, their two focused tests
- Scope: M

### Task 3: Enforce ownership for SSE and MCP

- Acceptance: SSE disconnect and MCP request/disconnect/reconnect use the
  creator window identity.
- Acceptance: a non-owner cannot invoke another window authenticated MCP client.
- Verify: npx vitest run electron/main/__tests__/sse-handler.test.ts electron/main/__tests__/mcp-handler.test.ts electron/main/__tests__/mcp-handler.integration.test.ts
- Dependencies: Task 1
- Files: sse-handler.ts, mcp-handler.ts, two focused test files
- Scope: M

### Task 4: Enforce ownership for Kafka and MQTT

- Acceptance: produce/publish, subscription administration, disconnect, and
  reconnect are owner-aware.
- Acceptance: broker credentials/messages cannot cross trusted windows and
  desktop broker guards remain unchanged.
- Verify: npx vitest run electron/main/__tests__/kafka-handler.test.ts electron/main/__tests__/mqtt-handler.test.ts
- Dependencies: Task 1
- Files: kafka-handler.ts, mqtt-handler.ts, their two handler tests
- Scope: M

### Task 5: Enforce ownership for gRPC stream controls

- Acceptance: message/end/cancel/pending-buffer paths bind stream IDs to their
  creator; a non-owner fire-and-forget call is ignored before mutation.
- Acceptance: owner lifecycle and cleanup remain functional.
- Verify: npx vitest run electron/main/__tests__/grpc-handler.test.ts
- Dependencies: Task 1
- Files: grpc-handler.ts and its test
- Scope: S

### Task 6: Enforce ownership for AI and AI Lab cancellation

- Acceptance: every AI chat/AI Lab cancellation and run lookup is owner-aware.
- Acceptance: the existing correct AI Lab completion cancel remains the model;
  a non-owner cannot cancel or inspect another window work.
- Verify: npx vitest run electron/main/__tests__/ai-handler.test.ts electron/main/__tests__/ai-lab-handler.test.ts
- Dependencies: Task 1
- Files: ai-handler.ts, ai-lab-handler.ts, their two tests
- Scope: M

## Checkpoint A

- [ ] Tasks 1-6 focused tests pass.
- [ ] npm run type-check:all, npm run lint, and npm run architecture:check pass.
- [ ] Two-window coverage reconciles every audited protocol family.

## Phase 2: IPC bridge integrity

### Task 7: Return individual unsubscribers for capture and collection events

- Acceptance: capture.onReceived and collections.onFileChanged return an
  individual disposer; no obsolete global removal API remains.
- Acceptance: all current consumers migrate atomically and Electron API types
  remain narrow and complete.
- Verify: focused preload/API test plus CaptureImportListener component test.
- Dependencies: None
- Files: integration-api.ts, integrations API type, CaptureImportListener.tsx,
  useFileCollectionStore.ts, focused test
- Scope: M

### Task 8: Make IPC channel registration mechanically rename-safe

- Acceptance: command registrations/teardown use IPC constants and preserve
  exact current channel values.
- Acceptance: surface test validates actual registrations or rejects raw
  command-literal registration, with documented static-event exceptions only.
- Verify: npx vitest run electron/main/__tests__/ipc-surface.test.ts electron/main/__tests__/file-operations.test.ts electron/main/__tests__/secret-handle-store.test.ts
- Dependencies: None
- Files: file-operations.ts, secret-handle-store.ts, ipc-surface test, focused handler test
- Scope: M

## Phase 3: Renderer correctness and response isolation

### Task 9: Route request and script completion to the origin tab

- Acceptance: target-tab mutations update only an extant origin tab; active-tab
  mutations retain existing semantics.
- Acceptance: HTTP page and generic runner pass origin tab ID through every
  completion/error/script result path.
- Verify: npx vitest run src/store/__tests__/useRequestStore.test.ts src/features/http/hooks/__tests__/useHttpRequestPage.test.ts src/features/registry/__tests__/useRequestRunner.test.tsx
- Dependencies: None
- Files: useRequestStore.ts/test, useHttpRequestPage.ts, useRequestRunner.ts/test
- Scope: M

### Task 10: Reconcile MCP store state with client teardown

- Acceptance: connection switch/unmount clears client status/capabilities and
  a late prior completion cannot revive it.
- Acceptance: remount enables invocation only after a current successful connection.
- Verify: npx vitest run src/features/mcp/components/__tests__/McpRequestBuilder.test.tsx
- Dependencies: None
- Files: McpRequestBuilder.tsx, MCP store module, focused component test
- Scope: S

### Task 11: Apply a network-denying CSP to response previews

- Acceptance: response srcDoc remains sandboxed; scripts, fetch/XHR/WebSocket,
  forms, navigation, image/font/media loads are denied by default.
- Acceptance: only necessary local presentation resources are explicitly allowed.
- Verify: focused ResponseViewer test plus Playwright request-interception case.
- Dependencies: None
- Files: ResponseViewer.tsx, its test, focused e2e response-preview spec
- Scope: S

## Checkpoint B

- [ ] Tasks 7-11 focused tests pass.
- [ ] Browser preview and Electron bridge smoke checks pass.
- [ ] Static gates pass.

## Phase 4: Hook lifecycle and latest-result safety

### Task 12: Make Kafka inspector refresh failure-safe

- Acceptance: rejected initial/manual loads clear busy state, surface an error,
  and cannot let a stale/unmounted refresh overwrite state.
- Verify: npx vitest run src/features/kafka/components/__tests__/useInspectorFetch.test.ts
- Dependencies: None
- Files: useInspectorFetch.ts and new focused hook test
- Scope: S

### Task 13: Abort collection and load-test runs on unmount

- Acceptance: dialog unmount aborts live work and late callbacks cannot commit.
- Acceptance: explicit stop and normal completion retain current result semantics.
- Verify: npx vitest run src/features/collections/hooks/__tests__/useCollectionRun.test.ts src/features/load-testing/hooks/__tests__/useLoadTest.test.ts
- Dependencies: None
- Files: useCollectionRun.ts/test, useLoadTest.ts/test
- Scope: M

### Task 14: Invalidate stale Git dialog refreshes

- Acceptance: closing/changing directory invalidates prior requests and late A
  results cannot overwrite active B state.
- Verify: npx vitest run src/components/shared/__tests__/GitDialog.test.tsx
- Dependencies: None
- Files: useGit.ts, GitDialog.tsx, focused dialog test
- Scope: S

### Task 15: Make release-note loading latest-request-safe

- Acceptance: channel change, refresh, and pagination cannot commit stale
  releases/selection/loading; repeated load-more is serialized or deduplicated.
- Verify: npx vitest run src/components/shared/settings/__tests__/useReleaseNotes.test.ts
- Dependencies: None
- Files: useReleaseNotes.ts and new focused hook test
- Scope: S

### Task 16: Make hydration readiness wait for every store

- Acceptance: hydration stays false until all selected stores resolve and
  unmount blocks late React state updates.
- Acceptance: current startup behaviour remains intact.
- Verify: npx vitest run src/hooks/__tests__/useStoreHydration.test.ts
- Dependencies: None
- Files: useStoreHydration.ts and new focused hook test
- Scope: S

## Phase 5: Integrated verification

### Task 17: Run final parity, coverage, and desktop/browser checks

- Acceptance: full coverage meets existing percentage and uncovered-branch budgets.
- Acceptance: no ownership, lifecycle, CSP, or preload regression occurs in
  web, self-hosted renderer, or Electron paths.
- Verify: npm run validate; npm run test:e2e; applicable npm run test:e2e:electron.
- Dependencies: Tasks 1-16
- Files: no production files expected; only narrowly scoped regression tests if needed
- Scope: S
