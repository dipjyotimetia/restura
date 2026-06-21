# Quality, gRPC Streaming, Accessibility, and Auth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Raise Restura toward 80% test coverage, complete gRPC client-streaming and bidirectional-streaming support, meet WCAG 2.1 AA for the core UI, and finish OAuth2/collection-level auth behavior.

**Architecture:** Treat this as four coordinated tracks. Test coverage is cross-cutting and should land first so later changes have guardrails. gRPC streaming is an extension of the existing gRPC protocol path and must cover renderer, Electron IPC, and tests. Accessibility is renderer-only but broad. Auth changes must flow through request execution so HTTP, GraphQL-over-HTTP, gRPC metadata, collection runner, workflows, and CLI do not diverge.

**Tech Stack:** TypeScript, React 19, Zustand, Vitest, React Testing Library, Electron IPC, `@grpc/grpc-js`, QuickJS, existing Radix/shadcn UI components.

---

## Scope and Categories

- Test coverage: cross-cutting validation work.
- gRPC client/bidi streaming: existing protocol extension, category B from `restura-feature-dev`.
- Accessibility: cross-cutting UI-only work unless tests expose platform-specific behavior.
- OAuth2 PKCE/refresh/auth inheritance: existing auth and request-execution extension, category B/C depending on file.

## Current Observations

- Coverage thresholds are currently below the target: `vitest.config.ts` has lines/functions at 70 and branches at 60.
- Renderer gRPC streaming currently throws for `client-streaming` and `bidirectional-streaming` in `src/features/grpc/lib/grpcStreamingClient.ts`.
- Electron gRPC IPC already has event channels for `grpc:start-stream`, `grpc:send-message`, `grpc:end-stream`, and `grpc:cancel-stream`, including client and bidi call support in `electron/main/grpc-handler.ts`.
- Workflows and collection runner are HTTP-only today.
- OAuth2 Authorization Code + PKCE is partially implemented in `src/features/auth/lib/oauth2.ts` and `src/features/auth/components/AuthConfig.tsx`, but token persistence/refresh behavior and inheritance are incomplete.
- `Collection.auth` exists in `src/types/index.ts`, file collection schema, importers, and exporters, but execution paths do not consistently resolve effective inherited auth.

## Target Definition of Done

- `npm run test:coverage` reports at least 80% lines and functions, and branch target is raised meaningfully without hiding important files.
- `npm run validate` passes.
- gRPC server, client, and bidi streaming are usable in the renderer for Electron. Web mode gives an explicit limitation or supported Connect-streaming path, not silent failure.
- Keyboard-only user can operate request tabs, sidebar, protocol switcher, auth, collection runner, workflow runner, and gRPC streaming controls.
- Core interactive controls have accessible names, focus states, roles, and error announcements.
- OAuth2 Authorization Code + PKCE has tested state/verifier handling, token expiry metadata, refresh-token flow, and auto-refresh before request execution.
- Request auth can inherit from collection-level auth, with request-level auth overriding collection auth.

---

## File Map

### Coverage

- Modify: `vitest.config.ts` — target thresholds.
- Modify: `package.json` — optional dedicated coverage scripts if needed.
- Add/modify tests near touched modules:
  - `src/features/http/lib/__tests__/requestExecutor.test.ts`
  - `src/features/auth/lib/__tests__/oauth2.test.ts`
  - `src/features/auth/lib/__tests__/authInheritance.test.ts`
  - `src/features/grpc/lib/__tests__/grpcStreamingClient.test.ts`
  - `src/features/grpc/components/__tests__/GrpcStreamingPanel.test.tsx`
  - `src/features/collections/components/__tests__/CollectionRunner.test.tsx`
  - `src/features/workflows/lib/__tests__/workflowExecutor.test.ts`
  - `src/components/shared/__tests__/accessibility.test.tsx`

### gRPC Streaming

- Modify: `src/features/grpc/lib/grpcStreamingClient.ts` — support client and bidi handles.
- Modify: `src/features/grpc/components/GrpcStreamingPanel.tsx` — message composer and send/end controls.
- Modify: `src/features/grpc/components/GrpcRequestBuilder.tsx` — ensure streaming panel is shown for all streaming method types.
- Verify: `electron/main/grpc-handler.ts` — already has IPC event support; add tests if behavior gaps appear.
- Verify/modify: `electron/main/ipc-validators.ts` — ensure streaming message schema validates arrays/objects and request IDs.
- Verify/modify: `electron/main/preload.ts` and `electron/types/electron.d.ts` — ensure renderer API exposes stream send/end/cancel events.

### Accessibility

- Modify: `src/components/shared/IconRail.tsx`
- Modify: `src/components/shared/TopBar.tsx`
- Modify: `src/components/shared/TabBar.tsx`
- Modify: `src/features/collections/components/Sidebar.tsx`
- Modify: `src/features/http/components/RequestLine.tsx`
- Modify: `src/features/http/components/RequestBuilder/RequestBuilderTabs.tsx`
- Modify: `src/features/auth/components/AuthConfig.tsx`
- Modify: `src/features/grpc/components/GrpcStreamingPanel.tsx`
- Modify: `src/components/shared/CommandPalette.tsx`
- Modify: `src/components/shared/AriaLiveAnnouncer.tsx` if live-region support is insufficient.

### OAuth2 and Auth Inheritance

- Modify: `src/types/index.ts` — token expiry/refresh metadata and inherited auth type if needed.
- Modify: `src/features/auth/lib/oauth2.ts` — refresh token helper and PKCE state helper tests.
- Modify: `src/features/auth/components/AuthConfig.tsx` — expose expiry/refresh state and refresh errors.
- Add: `src/features/auth/lib/authInheritance.ts` — pure effective-auth resolver.
- Add: `src/features/auth/lib/tokenRefresh.ts` — pure auto-refresh decision and execution helper.
- Modify: `src/features/http/lib/requestExecutor.ts` — apply effective auth and refresh before signing.
- Modify: `src/features/grpc/lib/grpcClient.ts` — use effective auth metadata path where request context is available.
- Modify: `src/features/collections/components/CollectionRunner.tsx` — pass collection context into execution.
- Modify: `src/features/workflows/lib/workflowExecutor.ts` — pass collection/effective auth when executing saved requests.
- Modify: `cli/src/runner/runner.ts` — use collection-level auth for file collections.

---

## Track 1: Test Coverage to 80%

### Task 1: Establish the Coverage Baseline

**Files:**

- Read: `coverage/coverage-summary.json` after running coverage.
- Modify later: `vitest.config.ts`

- [ ] **Step 1: Run current coverage**

Run:

```bash
npm run test:coverage
```

Expected: tests complete and coverage summary shows current line/function/branch coverage.

- [ ] **Step 2: Record the lowest-value gaps**

Run:

```bash
node -e "const s=require('./coverage/coverage-summary.json'); const rows=Object.entries(s).filter(([k])=>k!=='total').map(([k,v])=>[k,v.lines.pct,v.functions.pct,v.branches.pct]).sort((a,b)=>a[1]-b[1]).slice(0,25); console.table(rows)"
```

Expected: table of files with weakest line coverage. Prioritize files that are core protocol/auth/state code, not generated types or thin barrels.

### Task 2: Raise Coverage on Pure Protocol and Auth Utilities

**Files:**

- Test: `src/features/auth/lib/__tests__/oauth2.test.ts`
- Test: `src/features/auth/lib/__tests__/authInheritance.test.ts`
- Test: `shared/protocol/*.test.ts` as needed

- [ ] **Step 1: Add OAuth2 refresh and PKCE unit tests**

Cover:

- `buildAuthorizationUrl` creates verifier, S256 challenge, and state.
- `exchangeCodeForToken` sends `code_verifier`.
- `fetchRefreshToken` sends `grant_type=refresh_token`.
- OAuth error bodies throw `OAuth2TokenError` with the machine code.

Example test shape:

```ts
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { buildAuthorizationUrl, exchangeCodeForToken, fetchRefreshToken } from '../oauth2';

describe('oauth2 PKCE and refresh helpers', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              access_token: 'next-token',
              token_type: 'Bearer',
              expires_in: 3600,
              refresh_token: 'refresh-next',
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          )
      )
    );
  });

  it('builds authorization URL with PKCE challenge and state', async () => {
    const result = await buildAuthorizationUrl({
      grantType: 'authorization_code',
      clientId: 'client',
      authorizationUrl: 'https://auth.example/authorize',
      tokenUrl: 'https://auth.example/token',
      redirectUri: 'https://app.example/callback',
      scope: 'read write',
    });

    const url = new URL(result.url);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('client');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toBe(result.state);
    expect(result.codeVerifier.length).toBeGreaterThan(30);
  });

  it('refreshes access tokens using refresh_token grant', async () => {
    await fetchRefreshToken({
      grantType: 'authorization_code',
      clientId: 'client',
      tokenUrl: 'https://auth.example/token',
      refreshToken: 'refresh-old',
    });

    const body = String((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(body).toContain('grant_type=refresh_token');
    expect(body).toContain('refresh_token=refresh-old');
  });
});
```

- [ ] **Step 2: Run targeted tests**

Run:

```bash
npm run test:run -- src/features/auth/lib
```

Expected: new tests fail until refresh helper exists, then pass after Track 4 implementation.

### Task 3: Cover Stores, Runners, and Edge Cases

**Files:**

- Modify: `src/store/__tests__/*.test.ts`
- Modify: `src/features/collections/components/__tests__/CollectionRunner.test.tsx`
- Modify: `src/features/workflows/lib/__tests__/workflowExecutor.test.ts`

- [ ] **Step 1: Add tests for runner non-HTTP behavior**

Before gRPC automation is generalized, assert existing behavior. After protocol executor is generalized, update expected behavior from skipped to executed for gRPC streaming-safe cases.

- [ ] **Step 2: Add workflow tests for inherited auth**

Use a saved HTTP request with `auth: { type: 'none' }` and a parent collection with bearer auth. Expected final request carries `Authorization: Bearer ...`.

- [ ] **Step 3: Run focused test files**

Run:

```bash
npm run test:run -- src/features/workflows src/features/collections src/store
```

Expected: pass after implementation.

### Task 4: Raise Coverage Thresholds

**Files:**

- Modify: `vitest.config.ts`

- [ ] **Step 1: Change thresholds**

Update:

```ts
thresholds: {
  lines: 80,
  functions: 80,
  branches: 70,
  statements: 80,
},
```

- [ ] **Step 2: Run full coverage**

Run:

```bash
npm run test:coverage
```

Expected: passes thresholds. If branch coverage remains below 70 because of platform guards, add focused tests rather than excluding application code.

---

## Track 2: gRPC Client Streaming and Bidirectional Streaming

### Task 5: Add Renderer Streaming Transport over Electron IPC

**Files:**

- Modify: `src/features/grpc/lib/grpcStreamingClient.ts`
- Test: `src/features/grpc/lib/__tests__/grpcStreamingClient.test.ts`

- [ ] **Step 1: Add failing tests for client and bidi handles**

Test behavior:

- `client-streaming` creates a handle instead of throwing.
- `send(message)` writes messages.
- `closeSend()` ends outbound stream.
- `bidirectional-streaming` yields inbound messages while allowing sends.
- `cancel()` cancels exactly once and resolves/finishes cleanly.

Example assertions:

```ts
it('supports client-streaming send and close through an injected transport', async () => {
  const writes: unknown[] = [];
  const ends: string[] = [];
  const handle = createInteractiveGrpcStreamForTest({
    methodType: 'client-streaming',
    onSend: (msg) => writes.push(msg),
    onEnd: () => ends.push('end'),
  });

  await handle.send({ id: 1 });
  await handle.send({ id: 2 });
  handle.closeSend();

  expect(writes).toEqual([{ id: 1 }, { id: 2 }]);
  expect(ends).toEqual(['end']);
});
```

- [ ] **Step 2: Implement a transport abstraction**

Add an internal interface:

```ts
interface InteractiveStreamTransport<TIn, TOut> {
  messages: AsyncIterable<TOut>;
  send(message: TIn): Promise<void>;
  closeSend(): void;
  cancel(): void;
  done: Promise<GrpcStreamFinal>;
}
```

Implementation rule:

- `server-streaming` keeps the existing Connect streaming fetch path.
- `client-streaming` and `bidirectional-streaming` use Electron IPC initially because `electron/main/grpc-handler.ts` already supports those calls.
- In web mode, return an explicit error: `client-streaming is currently available in the desktop app only`.

- [ ] **Step 3: Run gRPC streaming tests**

Run:

```bash
npm run test:run -- src/features/grpc/lib/__tests__/grpcStreamingClient.test.ts
```

Expected: pass.

### Task 6: Expose Streaming Send UI

**Files:**

- Modify: `src/features/grpc/components/GrpcStreamingPanel.tsx`
- Modify: `src/features/grpc/components/GrpcRequestBuilder.tsx`
- Test: `src/features/grpc/components/__tests__/GrpcStreamingPanel.test.tsx`

- [ ] **Step 1: Add UI tests**

Test cases:

- Server streaming shows Start/Cancel only.
- Client streaming shows Start, message editor, Send, End.
- Bidi streaming shows Start, message editor, Send, End, Cancel, and inbound messages.
- Error text is announced with `role="alert"`.

- [ ] **Step 2: Implement message composer**

Add:

- `<textarea aria-label="Streaming message JSON">`
- Send button disabled when not streaming or invalid JSON.
- End button disabled after `closeSend()`.
- A visible invalid JSON error with `role="alert"`.

- [ ] **Step 3: Run component tests**

Run:

```bash
npm run test:run -- src/features/grpc/components/__tests__/GrpcStreamingPanel.test.tsx
```

Expected: pass.

### Task 7: Verify Electron IPC Validation

**Files:**

- Modify: `electron/main/ipc-validators.ts`
- Test: `electron/main/__tests__/grpc-handler.test.ts` or `electron/main/__tests__/ipc-validators.test.ts`

- [ ] **Step 1: Add schema tests**

Assert:

- valid stream request accepts `methodType: 'client-streaming'`.
- valid send message accepts plain object and array payloads.
- invalid request ID rejects empty strings.

- [ ] **Step 2: Run Electron tests**

Run:

```bash
npm run test:run -- electron/main/__tests__
```

Expected: pass.

### Task 8: Manual Harness Verification

- [ ] **Step 1: Web harness**

Run:

```bash
npm run dev
```

Verify at `http://localhost:5173`:

- server-streaming works where supported.
- client/bidi show desktop-only limitation in web mode if Electron-only path is retained.

- [ ] **Step 2: Electron harness**

Run:

```bash
npm run electron:dev
```

Verify:

- client-streaming can send multiple JSON messages and receive final response.
- bidi can send messages and display inbound stream messages.
- cancel cleans up the active stream.

---

## Track 3: WCAG 2.1 AA Accessibility

### Task 9: Add Accessibility Test Utilities

**Files:**

- Modify: `tests/setup.ts`
- Add: `src/components/shared/__tests__/accessibility.test.tsx`

- [ ] **Step 1: Add semantic smoke tests without new dependencies**

Use React Testing Library queries first. Do not add `jest-axe` unless dependency install is approved.

Test examples:

```ts
it('top-level app landmarks are discoverable', () => {
  render(<Home />);
  expect(screen.getByRole('main')).toBeInTheDocument();
  expect(screen.getByRole('navigation', { name: /primary/i })).toBeInTheDocument();
});
```

- [ ] **Step 2: Run smoke tests**

Run:

```bash
npm run test:run -- src/components/shared/__tests__/accessibility.test.tsx
```

Expected: fail until landmarks/names are added.

### Task 10: Fix Landmarks, Labels, and Live Regions

**Files:**

- Modify: `src/routes/index.tsx`
- Modify: `src/components/shared/IconRail.tsx`
- Modify: `src/components/shared/TopBar.tsx`
- Modify: `src/features/collections/components/Sidebar.tsx`
- Modify: `src/components/shared/AriaLiveAnnouncer.tsx`

- [ ] **Step 1: Add landmarks**

Expected structure:

- Icon rail: `<nav aria-label="Primary">`
- Sidebar panel: `<aside aria-label="Collections, history, and workflows">`
- Main work area: `<main aria-label="Request workspace">`
- Status bar: `role="status"` or named footer if appropriate.

- [ ] **Step 2: Announce async state changes**

Use existing `AriaLiveAnnouncerProvider` for:

- request sent/completed/failed,
- stream started/closed/error,
- collection/workflow run completed,
- OAuth token success/failure.

### Task 11: Keyboard and Focus Remediation

**Files:**

- Modify: `src/components/shared/TabBar.tsx`
- Modify: `src/components/shared/CommandPalette.tsx`
- Modify: `src/features/collections/components/Sidebar.tsx`
- Modify: `src/features/grpc/components/GrpcStreamingPanel.tsx`

- [ ] **Step 1: TabBar keyboard behavior**

Implement:

- ArrowLeft/ArrowRight moves focus between tabs.
- Enter/Space activates focused tab.
- Delete closes focused tab when allowed.
- Add `aria-selected`, `role="tablist"`, `role="tab"`, and `aria-controls`.

- [ ] **Step 2: Sidebar tree behavior**

Collection folders/requests should be reachable by keyboard with visible focus. If full ARIA tree is too large for this phase, use semantic buttons/list items with clear names and document tree-view as a follow-up.

- [ ] **Step 3: Run keyboard tests**

Run:

```bash
npm run test:run -- src/components/shared src/features/collections src/features/grpc/components
```

Expected: pass.

### Task 12: Color Contrast and Error Semantics

**Files:**

- Modify: components with low-contrast `text-muted-foreground` on small text as discovered.
- Modify: `src/features/auth/components/AuthConfig.tsx`
- Modify: `src/features/grpc/components/GrpcStreamingPanel.tsx`
- Modify: `src/features/http/components/RequestLine.tsx`

- [ ] **Step 1: Ensure all error messages use `role="alert"`**

Auth errors, URL validation errors, stream errors, and import errors should be announced.

- [ ] **Step 2: Ensure inputs bind labels**

Every input must have either:

- visible `<label htmlFor>` with matching `id`, or
- `aria-label` when the visual layout has no label.

- [ ] **Step 3: Browser verification with Chrome DevTools MCP**

Run app and inspect with `mcp__chrome_devtools__take_snapshot`.

Expected:

- controls have names,
- no unlabeled textboxes/buttons in primary flows,
- focus order follows visual order.

---

## Track 4: OAuth2 PKCE, Token Refresh, and Collection Auth Inheritance

### Task 13: Complete OAuth2 Token Metadata

**Files:**

- Modify: `src/types/index.ts`
- Modify: `src/features/auth/lib/oauth2.ts`
- Test: `src/features/auth/lib/__tests__/oauth2.test.ts`

- [ ] **Step 1: Extend OAuth2 type**

Add fields:

```ts
oauth2?: {
  accessToken: string;
  tokenType?: string;
  refreshToken?: string;
  expiresAt?: number;
  scopes?: string[];
  grantType?: 'authorization_code' | 'client_credentials' | 'password' | 'device_code';
  clientId?: string;
  clientSecret?: string;
  authorizationUrl?: string;
  tokenUrl?: string;
  deviceAuthorizationUrl?: string;
  scope?: string;
  redirectUri?: string;
  username?: string;
  password?: string;
};
```

- [ ] **Step 2: Add refresh helper**

Add to `src/features/auth/lib/oauth2.ts`:

```ts
export interface RefreshTokenConfig {
  clientId: string;
  tokenUrl: string;
  refreshToken: string;
  clientSecret?: string;
  scope?: string;
}

export async function fetchRefreshToken(config: RefreshTokenConfig): Promise<OAuth2TokenResponse> {
  const params: Record<string, string> = {
    grant_type: 'refresh_token',
    client_id: config.clientId,
    refresh_token: config.refreshToken,
  };
  if (config.clientSecret) params.client_secret = config.clientSecret;
  if (config.scope) params.scope = config.scope;
  return postToken(config.tokenUrl, params);
}

export function tokenExpiresAt(nowMs: number, expiresInSeconds?: number): number | undefined {
  return expiresInSeconds ? nowMs + expiresInSeconds * 1000 : undefined;
}
```

- [ ] **Step 3: Persist refresh result from UI**

When token is acquired, write:

- `accessToken`
- `tokenType`
- `refreshToken`
- `expiresAt`

Do not drop existing refresh token if a provider omits a new one.

### Task 14: Add Auto-Refresh Before Execution

**Files:**

- Add: `src/features/auth/lib/tokenRefresh.ts`
- Test: `src/features/auth/lib/__tests__/tokenRefresh.test.ts`
- Modify: `src/features/http/lib/requestExecutor.ts`

- [ ] **Step 1: Add pure refresh decision helper**

```ts
import type { AuthConfig } from '@/types';
import { fetchRefreshToken, tokenExpiresAt } from './oauth2';

const REFRESH_SKEW_MS = 60_000;

export function shouldRefreshOAuth2(auth: AuthConfig, nowMs = Date.now()): boolean {
  if (auth.type !== 'oauth2') return false;
  const o = auth.oauth2;
  if (!o?.refreshToken || !o.tokenUrl || !o.clientId) return false;
  if (!o.expiresAt) return false;
  return o.expiresAt - nowMs <= REFRESH_SKEW_MS;
}

export async function refreshOAuth2Auth(auth: AuthConfig, nowMs = Date.now()): Promise<AuthConfig> {
  if (
    !shouldRefreshOAuth2(auth, nowMs) ||
    !auth.oauth2?.refreshToken ||
    !auth.oauth2.tokenUrl ||
    !auth.oauth2.clientId
  ) {
    return auth;
  }
  const res = await fetchRefreshToken({
    clientId: auth.oauth2.clientId,
    clientSecret: auth.oauth2.clientSecret,
    tokenUrl: auth.oauth2.tokenUrl,
    refreshToken: auth.oauth2.refreshToken,
    scope: auth.oauth2.scope,
  });
  return {
    ...auth,
    oauth2: {
      ...auth.oauth2,
      accessToken: res.access_token,
      tokenType: res.token_type ?? auth.oauth2.tokenType,
      refreshToken: res.refresh_token ?? auth.oauth2.refreshToken,
      expiresAt: tokenExpiresAt(nowMs, res.expires_in) ?? auth.oauth2.expiresAt,
    },
  };
}
```

- [ ] **Step 2: Apply before auth headers**

In `requestExecutor.ts`, compute `effectiveAuth = await refreshOAuth2Auth(request.auth)` before `applyAuthHeaders`. Return the refreshed auth in `RequestExecutionResult` or call a callback so stores can persist it.

- [ ] **Step 3: Run tests**

Run:

```bash
npm run test:run -- src/features/auth/lib src/features/http/lib/__tests__/requestExecutor.test.ts
```

Expected: pass.

### Task 15: Add Collection-Level Auth Inheritance

**Files:**

- Add: `src/features/auth/lib/authInheritance.ts`
- Test: `src/features/auth/lib/__tests__/authInheritance.test.ts`
- Modify: `src/features/collections/components/CollectionRunner.tsx`
- Modify: `src/features/workflows/lib/workflowExecutor.ts`
- Modify: `cli/src/runner/runner.ts`
- Consider modify: `src/features/http/hooks/useHttpRequest.ts` only if active saved request context is available.

- [ ] **Step 1: Define resolver**

```ts
import type { AuthConfig, Collection, CollectionItem, Request } from '@/types';

export function resolveEffectiveAuth(
  requestAuth: AuthConfig,
  inheritedAuth?: AuthConfig
): AuthConfig {
  if (requestAuth.type && requestAuth.type !== 'none') return requestAuth;
  return inheritedAuth ?? requestAuth;
}

export function findInheritedAuth(
  collection: Collection,
  requestId: string
): AuthConfig | undefined {
  const visit = (
    items: CollectionItem[],
    current: AuthConfig | undefined
  ): AuthConfig | undefined => {
    for (const item of items) {
      const next =
        item.request?.auth && item.request.auth.type !== 'none' ? item.request.auth : current;
      if (item.type === 'request' && item.request?.id === requestId) return current;
      if (item.items) {
        const found = visit(item.items, next);
        if (found) return found;
      }
    }
    return undefined;
  };
  return visit(collection.items, collection.auth);
}

export function withEffectiveAuth<T extends Request>(request: T, inheritedAuth?: AuthConfig): T {
  return {
    ...request,
    auth: resolveEffectiveAuth(request.auth, inheritedAuth),
  };
}
```

Note: if folder-level auth is added later, extend `CollectionItem` with `auth?: AuthConfig` and update this resolver. For this phase, collection-level inheritance is enough.

- [ ] **Step 2: Use resolver in runner/workflows/CLI**

Collection runner:

- get `selectedCollection.auth`
- pass `withEffectiveAuth(item.request, selectedCollection.auth)` into `executeRequest`.

Workflow executor:

- add optional `getInheritedAuth?: (requestId: string) => AuthConfig | undefined` to options.
- apply `withEffectiveAuth(request, getInheritedAuth?.(request.id))`.

CLI:

- when loading collection metadata, apply `loaded.meta.auth` to HTTP requests with no auth.

- [ ] **Step 3: Add tests**

Tests:

- request auth overrides collection auth.
- request `none` inherits collection bearer.
- missing collection auth leaves request `none`.
- CLI includes inherited auth in proxy spec.

### Task 16: Update UI for Collection Auth

**Files:**

- Modify: `src/features/collections/components/Sidebar.tsx`
- Add or reuse: collection settings dialog component.
- Reuse: `src/features/auth/components/AuthConfig.tsx`

- [ ] **Step 1: Add collection settings action**

For each collection menu, add “Collection settings”. Dialog contains:

- collection name,
- description,
- auth section using `AuthConfiguration`,
- save/cancel.

- [ ] **Step 2: Show inherited auth indicator**

In request auth tab, if active request has `auth.type === 'none'` and saved collection has auth, show a passive indicator: “Inheriting collection auth”. It must be associated with the auth region via `aria-describedby`.

- [ ] **Step 3: Run component tests**

Run:

```bash
npm run test:run -- src/features/collections src/features/auth
```

Expected: pass.

---

## Final Verification

- [ ] **Step 1: Full static validation**

Run:

```bash
npm run validate
```

Expected: type-check, lint, generated OpenCollection types check, and unit tests pass.

- [ ] **Step 2: Coverage target**

Run:

```bash
npm run test:coverage
```

Expected: coverage threshold passes at 80 lines/functions/statements and at least 70 branches.

- [ ] **Step 3: E2E smoke where relevant**

Run:

```bash
npm run test:e2e
```

Expected: existing e2e suite passes. If full e2e is too slow, run relevant protocol/auth specs first and record skipped scope.

- [ ] **Step 4: Manual web verification**

Run:

```bash
npm run dev
```

Verify:

- core request flow,
- auth token flow,
- collection runner inherited auth,
- accessibility snapshot for main controls.

- [ ] **Step 5: Manual Electron verification**

Run:

```bash
npm run electron:dev
```

Verify:

- gRPC client-streaming,
- gRPC bidirectional-streaming,
- cancel/cleanup,
- desktop auth paths.

---

## Suggested Commit Sequence

1. `test: record coverage baseline and add auth coverage`
2. `feat(auth): refresh oauth2 tokens before requests`
3. `feat(auth): inherit collection auth during execution`
4. `feat(grpc): support client and bidirectional streaming`
5. `fix(a11y): add landmarks labels and keyboard navigation`
6. `test: raise coverage thresholds to 80 percent`

## Risks and Mitigations

- **Risk:** Web gRPC client/bidi streaming may not be feasible with current browser/Connect runtime.
  **Mitigation:** Make desktop support complete and show explicit web limitations until a tested Connect-compatible web implementation exists.

- **Risk:** Auto-refresh mutates auth during execution but stores do not persist the refreshed token.
  **Mitigation:** return refreshed auth from execution and persist it at the hook/store boundary.

- **Risk:** Accessibility changes alter styling or layout.
  **Mitigation:** prefer semantic wrappers and ARIA attributes first; keep visual refactors small.

- **Risk:** Coverage target encourages low-value tests.
  **Mitigation:** prioritize pure protocol/auth/state modules and user-facing component behavior.
