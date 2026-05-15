# Restura Maintainability Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Address every issue from the 2026-05-13 architecture review — Worker SSRF gaps, Electron IPC weaknesses, persistence-layer footguns, the absence of a protocol registry, and type-safety drift — without breaking shipped behavior.

**Architecture:** Five phases, each independently shippable and reviewable. Phases 1-2 are security; Phase 3 is data correctness; Phase 4 is the structural refactor that makes the next protocol a one-folder change; Phase 5 closes the type-safety boundary. Phases 1, 2, 3, 5 are mostly parallel; Phase 4 depends on Phase 3 having stripped large objects from the request store (so the refactor doesn't churn unrelated state).

**Tech Stack:** TypeScript strict, Zod 4, Vitest + React Testing Library, Hono on Cloudflare Workers, Electron 42 with `contextIsolation`/`sandbox`, Zustand 5 + Dexie storage, Playwright e2e.

**Spec source:** `/Users/dipjyotimetia/Documents/working/ccviews/restura/docs/superpowers/plans/2026-05-13-maintainability-hardening.md` (this file). Original review findings are in conversation history; this plan supersedes them.

---

## Phase 1 — Worker Security Hardening

**Why first:** The Worker is the only request-execution boundary on web. Every gap here is an open SSRF/proxy vector. Small surface, high impact.

**Files involved:** `worker/index.ts`, `worker/handlers/proxy.ts`, `worker/handlers/grpc.ts`, `worker/handlers/grpc-reflection.ts`, `worker/handlers/mcp.ts`, `shared/protocol/url-validation.ts`, `shared/protocol/http-proxy.ts`, plus their `__tests__/` siblings.

---

### Task 1.1: Block redirect-to-private SSRF in Worker proxy

**Files:**
- Modify: `worker/handlers/proxy.ts:79,91` (the two `redirect: 'follow'` sites)
- Modify: `shared/protocol/http-proxy.ts` (add manual-redirect loop)
- Test: `shared/protocol/__tests__/http-proxy-redirect.test.ts` (create)

- [ ] **Step 1: Write failing test for redirect-to-private rejection**

Create `shared/protocol/__tests__/http-proxy-redirect.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { executeHttpProxy } from '../http-proxy';
import type { Fetcher } from '../types';

describe('executeHttpProxy redirect handling', () => {
  it('rejects redirect to private IP', async () => {
    const fetcher: Fetcher = vi.fn().mockResolvedValueOnce({
      status: 302,
      statusText: 'Found',
      headers: new Headers({ Location: 'http://169.254.169.254/latest/meta-data/' }),
      text: async () => '',
      contentLengthHeader: '0',
      body: null,
    });

    const result = await executeHttpProxy(
      { method: 'GET', url: 'https://attacker.example/redirect' },
      fetcher,
      { allowLocalhost: false }
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.payload.error).toMatch(/redirect.*private/i);
      expect(result.status).toBe(400);
    }
  });

  it('rejects redirect to localhost in production mode', async () => {
    const fetcher: Fetcher = vi.fn().mockResolvedValueOnce({
      status: 301,
      statusText: 'Moved Permanently',
      headers: new Headers({ Location: 'http://localhost:6443/api' }),
      text: async () => '',
      contentLengthHeader: '0',
      body: null,
    });

    const result = await executeHttpProxy(
      { method: 'GET', url: 'https://attacker.example/' },
      fetcher,
      { allowLocalhost: false }
    );

    expect(result.ok).toBe(false);
  });

  it('strips Authorization on cross-origin redirect', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce({
        status: 302,
        statusText: 'Found',
        headers: new Headers({ Location: 'https://other.example/api' }),
        text: async () => '',
        contentLengthHeader: '0',
        body: null,
      })
      .mockResolvedValueOnce({
        status: 200,
        statusText: 'OK',
        headers: new Headers(),
        text: async () => 'ok',
        contentLengthHeader: '2',
        body: null,
      });

    await executeHttpProxy(
      {
        method: 'GET',
        url: 'https://api.example/v1/resource',
        headers: { Authorization: 'Bearer secret', Cookie: 'session=x' },
      },
      fetcher as Fetcher,
      { allowLocalhost: false }
    );

    const secondCall = fetcher.mock.calls[1]![0];
    expect(secondCall.headers.has('authorization')).toBe(false);
    expect(secondCall.headers.has('cookie')).toBe(false);
  });

  it('caps redirect chain at 5 hops', async () => {
    const fetcher: Fetcher = vi.fn().mockResolvedValue({
      status: 302,
      statusText: 'Found',
      headers: new Headers({ Location: 'https://api.example/loop' }),
      text: async () => '',
      contentLengthHeader: '0',
      body: null,
    });

    const result = await executeHttpProxy(
      { method: 'GET', url: 'https://api.example/loop' },
      fetcher,
      { allowLocalhost: false }
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.payload.error).toMatch(/too many redirects/i);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run shared/protocol/__tests__/http-proxy-redirect.test.ts`
Expected: FAIL — no manual redirect handling, `executeHttpProxy` likely doesn't recognize 3xx specially.

- [ ] **Step 3: Switch fetchers to manual redirect mode**

Edit `worker/handlers/proxy.ts:79` and `:91` — change both `redirect: 'follow'` to `redirect: 'manual'`:

```typescript
// In buildFetcher, both branches (upstream proxy and direct):
const init: RequestInit = {
  method: req.method,
  headers: req.headers,
  signal: req.signal,
  redirect: 'manual',  // was: 'follow'
};
```

- [ ] **Step 4: Implement manual redirect loop in shared/protocol/http-proxy.ts**

In `shared/protocol/http-proxy.ts`, find the function that calls `fetcher(req)` and wrap it with a redirect-following loop. Add this helper near the top:

```typescript
import { validateURL, isPrivateAddress } from './url-validation';

const MAX_REDIRECTS = 5;
const STRIPPED_ON_CROSS_ORIGIN = ['authorization', 'cookie', 'proxy-authorization'];

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

async function followRedirects(
  initialReq: FetcherRequest,
  fetcher: Fetcher,
  options: { allowLocalhost: boolean }
): Promise<FetcherResponse> {
  let req = initialReq;
  let response = await fetcher(req);
  let hops = 0;

  while (isRedirect(response.status)) {
    if (hops >= MAX_REDIRECTS) {
      throw new Error(`Too many redirects (>${MAX_REDIRECTS})`);
    }
    const location = response.headers.get('location');
    if (!location) break;

    const nextUrl = new URL(location, req.url).toString();
    const nextValidation = validateURL(nextUrl, {
      allowPrivateIPs: false,
      allowLocalhost: options.allowLocalhost,
    });
    if (!nextValidation.valid) {
      throw new Error(`Redirect blocked: ${nextValidation.error}`);
    }

    const fromOrigin = new URL(req.url).origin;
    const toOrigin = new URL(nextUrl).origin;
    const headers = new Headers(req.headers);
    if (fromOrigin !== toOrigin) {
      for (const h of STRIPPED_ON_CROSS_ORIGIN) headers.delete(h);
    }

    // 303 always becomes GET; 301/302 historically downgrade non-GET/HEAD to GET
    const nextMethod =
      response.status === 303 ? 'GET' :
      (response.status === 301 || response.status === 302) && req.method !== 'HEAD' ? 'GET' :
      req.method;

    req = {
      ...req,
      url: nextUrl,
      method: nextMethod,
      headers,
      body: nextMethod === 'GET' || nextMethod === 'HEAD' ? undefined : req.body,
    };
    response = await fetcher(req);
    hops++;
  }

  return response;
}
```

Then replace the single `fetcher(req)` invocation inside `executeHttpProxy` (and the streaming variant) with `followRedirects(req, fetcher, { allowLocalhost: options.allowLocalhost })`.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run shared/protocol/__tests__/http-proxy-redirect.test.ts`
Expected: PASS — all four tests green.

- [ ] **Step 6: Run the full Worker test suite to confirm no regression**

Run: `npx vitest run worker shared/protocol`
Expected: PASS — existing tests still green.

- [ ] **Step 7: Apply same change to `electron/main/sse-handler.ts:114` and `electron/main/mcp-handler.ts:245`**

In each file, find the `fetch(...)` call. Replace `redirect: 'follow'` with `redirect: 'manual'` and call a shared helper. To keep the renderer code path consistent, extract `followRedirects` into `shared/protocol/redirect-follower.ts` (move the helper from `http-proxy.ts` and re-export from there). Update both Electron handlers to use it.

- [ ] **Step 8: Commit**

```bash
git add shared/protocol/__tests__/http-proxy-redirect.test.ts shared/protocol/http-proxy.ts shared/protocol/redirect-follower.ts worker/handlers/proxy.ts electron/main/sse-handler.ts electron/main/mcp-handler.ts
git commit -m "fix(security): block redirect-to-private SSRF and strip credentials cross-origin"
```

---

### Task 1.2: Add Zod boundary validation to every Worker handler

**Why:** `c.req.json<T>()` is a TypeScript cast, not runtime validation. Electron already does this via `validateIpcInput`; the Worker is the asymmetric gap.

**Files:**
- Create: `worker/shared/validate-body.ts`
- Modify: `worker/handlers/proxy.ts:107-116`
- Modify: `worker/handlers/grpc.ts:37` area
- Modify: `worker/handlers/grpc-reflection.ts:64` area
- Modify: `worker/handlers/mcp.ts:85` area
- Test: `worker/shared/__tests__/validate-body.test.ts` (create)

- [ ] **Step 1: Write failing test for the helper**

Create `worker/shared/__tests__/validate-body.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { parseJsonBody } from '../validate-body';

describe('parseJsonBody', () => {
  const schema = z.object({ method: z.string(), url: z.string().url() });

  it('returns parsed value for valid input', async () => {
    const req = new Request('https://x/', {
      method: 'POST',
      body: JSON.stringify({ method: 'GET', url: 'https://example.com' }),
    });
    const result = await parseJsonBody(req, schema);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.method).toBe('GET');
  });

  it('returns 400 details for invalid JSON', async () => {
    const req = new Request('https://x/', { method: 'POST', body: '{not json' });
    const result = await parseJsonBody(req, schema);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(400);
  });

  it('returns 400 details for schema violation', async () => {
    const req = new Request('https://x/', {
      method: 'POST',
      body: JSON.stringify({ method: 'GET', url: 'not-a-url' }),
    });
    const result = await parseJsonBody(req, schema);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.error).toMatch(/url/i);
    }
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `npx vitest run worker/shared/__tests__/validate-body.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the helper**

Create `worker/shared/validate-body.ts`:

```typescript
import { z } from 'zod';

export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: 400; error: string };

export async function parseJsonBody<T>(
  req: Request,
  schema: z.ZodType<T>
): Promise<ParseResult<T>> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Invalid JSON';
    return { ok: false, status: 400, error: `Malformed JSON: ${message}` };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const message = parsed.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    return { ok: false, status: 400, error: `Invalid request body: ${message}` };
  }
  return { ok: true, value: parsed.data };
}
```

- [ ] **Step 4: Run test to verify passing**

Run: `npx vitest run worker/shared/__tests__/validate-body.test.ts`
Expected: PASS.

- [ ] **Step 5: Define Zod schema for the proxy body**

Add to `shared/protocol/types.ts` (or a new `shared/protocol/proxy-schema.ts` if cleaner):

```typescript
import { z } from 'zod';

export const ProxyAuthConfigSchema = z.object({
  type: z.enum(['none', 'basic', 'bearer', 'api-key', 'oauth2', 'digest', 'aws-signature']),
  awsSignature: z
    .object({
      accessKey: z.string(),
      secretKey: z.string(),
      region: z.string(),
      service: z.string(),
    })
    .optional(),
});

export const FormFieldSchema = z.object({
  key: z.string(),
  value: z.string().optional(),
  type: z.enum(['text', 'file']).optional(),
  fileName: z.string().optional(),
  contentType: z.string().optional(),
});

export const UpstreamProxyConfigSchema = z.object({
  host: z.string().regex(/^[a-zA-Z0-9.\-[\]:]+$/, 'Invalid proxy host'),
  port: z.number().int().min(1).max(65535),
  auth: z.object({ username: z.string(), password: z.string() }).optional(),
});

export const ProxyRequestBodySchema = z.object({
  method: z.string().regex(/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/i),
  url: z.string().url().max(2048),
  headers: z.record(z.string(), z.string()).optional(),
  params: z.record(z.string(), z.string()).optional(),
  bodyType: z.enum(['none', 'json', 'xml', 'form-data', 'x-www-form-urlencoded', 'binary', 'protobuf', 'graphql', 'text', 'multipart-mixed']).optional(),
  data: z.string().max(50 * 1024 * 1024).optional(),
  formData: z.array(FormFieldSchema).optional(),
  timeout: z.number().int().positive().max(300_000).optional(),
  upstreamProxy: UpstreamProxyConfigSchema.optional(),
  auth: ProxyAuthConfigSchema.optional(),
  streamingMode: z.boolean().optional(),
});

export type ProxyRequestBody = z.infer<typeof ProxyRequestBodySchema>;
```

- [ ] **Step 6: Replace cast in `worker/handlers/proxy.ts:107-116`**

```typescript
import { parseJsonBody } from '../shared/validate-body';
import { ProxyRequestBodySchema } from '@shared/protocol/proxy-schema';
// remove the local interface ProxyRequestBody — import it from the schema module

export async function proxy(c: Context<{ Bindings: Env }>) {
  const isDev = c.env.ENVIRONMENT === 'development';

  const parsed = await parseJsonBody(c.req.raw, ProxyRequestBodySchema);
  if (!parsed.ok) {
    return c.json({ error: parsed.error }, parsed.status);
  }
  const body = parsed.value;

  // ... rest unchanged
}
```

- [ ] **Step 7: Repeat for `worker/handlers/grpc.ts`, `grpc-reflection.ts`, `mcp.ts`**

For each handler: identify the `c.req.json<X>()` call, define a corresponding `*RequestBodySchema` in `shared/protocol/` (re-using `GrpcRequestConfigSchema` from `src/lib/shared/validations.ts` if compatible — note the renderer schemas can be moved into `shared/protocol/` so both runtimes use the same source of truth), and replace the cast with `parseJsonBody(c.req.raw, schema)`.

For `worker/handlers/grpc.ts`:
```typescript
import { parseJsonBody } from '../shared/validate-body';
import { GrpcRequestConfigSchema } from '@shared/protocol/grpc-schema';  // move from validations.ts

const parsed = await parseJsonBody(c.req.raw, GrpcRequestConfigSchema);
if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status);
const body = parsed.value;
```

(Same structure for the other two.)

- [ ] **Step 8: Run all Worker tests**

Run: `npx vitest run worker shared/protocol`
Expected: PASS — invalid-body tests now return structured 400s; existing happy-path tests still pass.

- [ ] **Step 9: Add an explicit "rejects malformed body" test in each handler's test file**

Example for `worker/handlers/__tests__/proxy.test.ts` — add:

```typescript
it('returns 400 for malformed JSON body', async () => {
  const res = await app.request('/api/proxy', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{not json',
  }, env);
  expect(res.status).toBe(400);
  const json = await res.json();
  expect(json.error).toMatch(/Malformed JSON/);
});

it('returns 400 for missing required field', async () => {
  const res = await app.request('/api/proxy', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'https://example.com' }),  // missing method
  }, env);
  expect(res.status).toBe(400);
});
```

- [ ] **Step 10: Commit**

```bash
git add worker/shared/validate-body.ts worker/shared/__tests__/validate-body.test.ts worker/handlers/proxy.ts worker/handlers/grpc.ts worker/handlers/grpc-reflection.ts worker/handlers/mcp.ts shared/protocol/proxy-schema.ts shared/protocol/grpc-schema.ts worker/handlers/__tests__/
git commit -m "feat(worker): validate every request body with Zod at the boundary"
```

---

### Task 1.3: Tighten IPv6 private-range detection

**Files:**
- Modify: `shared/protocol/url-validation.ts:44-61` (`isPrivateAddress`)
- Modify: `shared/protocol/__tests__/url-validation.test.ts` (extend)

- [ ] **Step 1: Write failing tests for the gap addresses**

Add to `shared/protocol/__tests__/url-validation.test.ts`:

```typescript
describe('isPrivateAddress IPv6 coverage', () => {
  const cases: Array<[string, string]> = [
    ['[::]', 'unspecified'],
    ['[::ffff:7f00:1]', 'IPv4-mapped loopback hex'],
    ['[::ffff:127.0.0.1]', 'IPv4-mapped loopback dotted'],
    ['[::ffff:a00:1]', 'IPv4-mapped 10/8 hex'],
    ['[::ffff:c0a8:101]', 'IPv4-mapped 192.168.1.1 hex'],
    ['[64:ff9b::a00:1]', 'NAT64 wrapping 10.0.0.1'],
    ['[2002:a00::]', '6to4 wrapping 10/8'],
    ['[2002:7f00::]', '6to4 wrapping 127/8'],
    ['[fec0::1]', 'deprecated site-local'],
    ['[0:0:0:0:0:ffff:c0a8:101]', 'fully expanded mapped 192.168.1.1'],
  ];

  for (const [input, label] of cases) {
    it(`rejects ${label}: ${input}`, () => {
      const url = `http://${input}/`;
      const result = validateURL(url, { allowPrivateIPs: false });
      expect(result.valid).toBe(false);
    });
  }
});
```

- [ ] **Step 2: Run tests to confirm failures**

Run: `npx vitest run shared/protocol/__tests__/url-validation.test.ts -t "IPv6 coverage"`
Expected: most fail.

- [ ] **Step 3: Replace `isPrivateAddress` IPv6 logic with canonical-form analysis**

Replace lines 40-61 of `shared/protocol/url-validation.ts`:

```typescript
function stripV4MappedPrefix(addr: string): string {
  return addr.startsWith('::ffff:') ? addr.slice(7) : addr;
}

// Expand a (possibly compressed) IPv6 string into 8 hextet groups.
// Returns null if not a valid IPv6 string.
function expandIPv6(addr: string): number[] | null {
  // Strip surrounding brackets if present
  const clean = addr.replace(/^\[|\]$/g, '');
  // Reject anything that doesn't look like IPv6
  if (!/^[0-9a-fA-F:.]+$/.test(clean)) return null;

  // Handle embedded IPv4 (e.g. ::ffff:127.0.0.1 → ::ffff:7f00:1)
  let s = clean;
  const dotted = s.match(/(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const [, prefix, ipv4] = dotted;
    const parts = ipv4!.split('.').map(Number);
    if (parts.some((n) => isNaN(n) || n < 0 || n > 255)) return null;
    const hi = ((parts[0]! << 8) | parts[1]!).toString(16);
    const lo = ((parts[2]! << 8) | parts[3]!).toString(16);
    s = `${prefix}${hi}:${lo}`;
  }

  const sides = s.split('::');
  if (sides.length > 2) return null;
  const left = sides[0] ? sides[0].split(':') : [];
  const right = sides[1] ? sides[1].split(':') : [];
  if (left.length + right.length > 8) return null;
  const fillCount = sides.length === 2 ? 8 - left.length - right.length : 0;
  const groups = [...left, ...Array(fillCount).fill('0'), ...right];
  if (groups.length !== 8) return null;

  const nums = groups.map((g) => parseInt(g, 16));
  if (nums.some((n) => isNaN(n) || n < 0 || n > 0xffff)) return null;
  return nums;
}

function isPrivateIPv6(groups: number[]): boolean {
  // Unspecified ::, loopback ::1
  if (groups.every((g, i) => i < 7 ? g === 0 : (g === 0 || g === 1))) return true;

  const [g0, g1, , , , g5, g6, g7] = groups;

  // IPv4-mapped (::ffff:x.x.x.x → check the embedded v4)
  if (groups.slice(0, 5).every((g) => g === 0) && g5 === 0xffff) {
    const v4 = `${(g6! >> 8) & 0xff}.${g6! & 0xff}.${(g7! >> 8) & 0xff}.${g7! & 0xff}`;
    return isPrivateIPv4(v4);
  }
  // 6to4 (2002::/16) wrapping any v4 — check the wrapped address
  if (g0 === 0x2002) {
    const v4 = `${(g1! >> 8) & 0xff}.${g1! & 0xff}.${(groups[2]! >> 8) & 0xff}.${groups[2]! & 0xff}`;
    return isPrivateIPv4(v4);
  }
  // NAT64 well-known prefix 64:ff9b::/96 wrapping v4
  if (g0 === 0x0064 && g1 === 0xff9b && groups[2] === 0 && groups[3] === 0 && groups[4] === 0 && g5 === 0) {
    const v4 = `${(g6! >> 8) & 0xff}.${g6! & 0xff}.${(g7! >> 8) & 0xff}.${g7! & 0xff}`;
    return isPrivateIPv4(v4);
  }
  // ULA fc00::/7
  if ((g0! & 0xfe00) === 0xfc00) return true;
  // Link-local fe80::/10
  if ((g0! & 0xffc0) === 0xfe80) return true;
  // Deprecated site-local fec0::/10
  if ((g0! & 0xffc0) === 0xfec0) return true;

  return false;
}

function isPrivateIPv4(addr: string): boolean {
  for (const re of PRIVATE_IPV4_RANGES) if (re.test(addr)) return true;
  return false;
}

export function isPrivateAddress(hostname: string): boolean {
  const stripped = hostname.replace(/^\[|\]$/g, '');
  const normalized = stripV4MappedPrefix(stripped);

  if (normalized === 'localhost' || normalized === '127.0.0.1') return true;

  if (isPrivateIPv4(normalized)) return true;

  // Try IPv6
  if (normalized.includes(':')) {
    const groups = expandIPv6(normalized);
    if (groups) return isPrivateIPv6(groups);
  }

  return false;
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run shared/protocol/__tests__/url-validation.test.ts`
Expected: PASS — all new IPv6 cases now rejected; existing tests still pass.

- [ ] **Step 5: Commit**

```bash
git add shared/protocol/url-validation.ts shared/protocol/__tests__/url-validation.test.ts
git commit -m "fix(security): reject IPv4-mapped, 6to4, NAT64, and site-local IPv6 SSRF vectors"
```

---

### Task 1.4: Replace `ENVIRONMENT === 'development'` auth bypass

**Why:** A single env-var flip turns previews into open SSRF proxies. Use Miniflare detection (always true in `vite dev`) plus an explicit binding for non-Miniflare dev.

**Files:**
- Modify: `worker/index.ts:19-21,66-89`
- Modify: `worker/__tests__/index.test.ts` (extend)

- [ ] **Step 1: Write failing test**

Add to `worker/__tests__/index.test.ts`:

```typescript
describe('proxyAuthMiddleware', () => {
  it('returns 503 when ENVIRONMENT=development but Miniflare is not running and no token configured', async () => {
    // Simulate a "preview" env: ENVIRONMENT set, but no MINIFLARE binding
    const env: Env = { ENVIRONMENT: 'development' };
    const res = await app.request('/api/proxy', {
      method: 'POST',
      body: JSON.stringify({ method: 'GET', url: 'https://example.com' }),
    }, env);
    expect(res.status).toBe(503);
  });

  it('skips auth only when DEV_BYPASS_AUTH binding is true', async () => {
    const env: Env = { ENVIRONMENT: 'development', DEV_BYPASS_AUTH: 'true' };
    const res = await app.request('/api/proxy', {
      method: 'OPTIONS',
    }, env);
    expect(res.status).toBe(204);
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `npx vitest run worker/__tests__/index.test.ts -t "proxyAuthMiddleware"`
Expected: FAIL.

- [ ] **Step 3: Modify `worker/index.ts`**

Replace lines 10-21 and 62-89:

```typescript
export type Env = {
  ENVIRONMENT?: string;
  ALLOWED_ORIGIN?: string;
  WORKER_PROXY_TOKEN?: string;
  REQUIRE_CF_ACCESS?: string;
  /** Explicit dev-bypass switch. Must be 'true' AND ENVIRONMENT=='development' */
  DEV_BYPASS_AUTH?: string;
};

function isDevelopment(env: Env): boolean {
  return env.ENVIRONMENT === 'development';
}

function isLocalDevBypass(env: Env): boolean {
  // Real Miniflare local dev sets globalThis.MINIFLARE; if not present,
  // require the explicit DEV_BYPASS_AUTH=true binding (only set in .dev.vars).
  const inMiniflare = typeof (globalThis as { MINIFLARE?: unknown }).MINIFLARE !== 'undefined';
  return isDevelopment(env) && (inMiniflare || env.DEV_BYPASS_AUTH === 'true');
}

// ... in proxyAuthMiddleware, replace the `isDevelopment(c.env)` short-circuit:
async function proxyAuthMiddleware(
  c: Context<{ Bindings: Env }>,
  next: Next
): Promise<Response | void> {
  if (c.req.method === 'OPTIONS' || isLocalDevBypass(c.env)) {
    return next();
  }
  // ... rest unchanged
}
```

Update `resolveCorsOrigin` to keep the localhost CORS only when `isLocalDevBypass(env)` is true (so a preview build doesn't accidentally trust localhost origins).

- [ ] **Step 4: Run tests**

Run: `npx vitest run worker/__tests__`
Expected: PASS.

- [ ] **Step 5: Document the deploy contract**

Edit `wrangler.jsonc` to add a comment near `ENVIRONMENT`:

```jsonc
// IMPORTANT: ENVIRONMENT='development' alone does NOT bypass auth.
// Local dev requires DEV_BYPASS_AUTH=true in .dev.vars (Miniflare also auto-detects).
// Preview/prod deploys must set WORKER_PROXY_TOKEN or REQUIRE_CF_ACCESS=true.
```

Update `.dev.vars.example` (create if missing):

```
ENVIRONMENT=development
DEV_BYPASS_AUTH=true
```

- [ ] **Step 6: Commit**

```bash
git add worker/index.ts worker/__tests__/index.test.ts wrangler.jsonc .dev.vars.example
git commit -m "fix(security): require explicit DEV_BYPASS_AUTH binding for Worker auth bypass"
```

---

### Task 1.5: Tighten `streamingMode` and `Accept`-header bypass

**Why:** `Accept: text/event-stream-evil` matches `includes('text/event-stream')` and bypasses the response-size cap. `streamingMode: true` from the renderer is an unconditional bypass.

**Files:**
- Modify: `worker/handlers/proxy.ts:48-54`
- Modify: `shared/protocol/proxy-schema.ts` (created in Task 1.2)

- [ ] **Step 1: Write failing test**

Add to `worker/handlers/__tests__/proxy.test.ts`:

```typescript
it('does not match Accept: text/event-stream-evil as streaming', async () => {
  const res = await app.request('/api/proxy', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      method: 'GET',
      url: 'https://example.com',
      headers: { Accept: 'text/event-stream-evil' },
    }),
  }, env);
  // Should hit the buffered (non-streaming) path; mocking can verify size cap applied
  expect(res.headers.get('content-type')).not.toMatch(/event-stream/);
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `npx vitest run worker/handlers/__tests__/proxy.test.ts -t "Accept: text/event-stream-evil"`
Expected: FAIL.

- [ ] **Step 3: Replace `isStreamingRequest` with token-aware parsing**

Replace lines 41-54 of `worker/handlers/proxy.ts`:

```typescript
const STREAMING_MEDIA_TYPES = new Set([
  'text/event-stream',
  'application/x-ndjson',
  'application/jsonl',
  'application/grpc-web',
]);

function parseAcceptMediaTypes(accept: string): string[] {
  // RFC 7231 Accept: media-type [;params][, media-type [;params]]*
  return accept
    .split(',')
    .map((entry) => entry.split(';')[0]!.trim().toLowerCase())
    .filter(Boolean);
}

function isStreamingRequest(body: ProxyRequestBody): boolean {
  if (body.streamingMode === true) return true;
  const accept = body.headers?.['Accept'] ?? body.headers?.['accept'] ?? '';
  return parseAcceptMediaTypes(accept).some((mt) => STREAMING_MEDIA_TYPES.has(mt));
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run worker/handlers/__tests__/proxy.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/handlers/proxy.ts worker/handlers/__tests__/proxy.test.ts
git commit -m "fix(security): token-parse Accept media types so streaming bypass requires exact match"
```

---

## Phase 2 — Electron IPC + Filesystem Hardening

**Why:** A renderer compromise (XSS in a rendered response, or a malicious dependency) escalates straight through IPC if these gaps remain. Phase 1's CSP+contextIsolation makes that escalation hard, but defense-in-depth is the point.

---

### Task 2.1: Per-`webContents` IPC rate limiter

**Files:**
- Modify: `electron/main/ipc-rate-limiter.ts` (rewrite)
- Modify: every caller (search and update)
- Test: `electron/main/__tests__/ipc-rate-limiter.test.ts` (create)

- [ ] **Step 1: Write failing test**

Create `electron/main/__tests__/ipc-rate-limiter.test.ts`:

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createKeyedRateLimiter } from '../ipc-rate-limiter';

describe('createKeyedRateLimiter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-13T00:00:00Z'));
  });

  it('keys quotas independently per webContents id', () => {
    const limiter = createKeyedRateLimiter(3, 1000);
    expect(limiter.check(1)).toBe(true);
    expect(limiter.check(1)).toBe(true);
    expect(limiter.check(1)).toBe(true);
    expect(limiter.check(1)).toBe(false);
    // Different webContents id is independent
    expect(limiter.check(2)).toBe(true);
  });

  it('expires entries after window passes', () => {
    const limiter = createKeyedRateLimiter(2, 1000);
    expect(limiter.check(1)).toBe(true);
    expect(limiter.check(1)).toBe(true);
    expect(limiter.check(1)).toBe(false);
    vi.advanceTimersByTime(1001);
    expect(limiter.check(1)).toBe(true);
  });

  it('cleans up dead webContents on dispose', () => {
    const limiter = createKeyedRateLimiter(1, 1000);
    limiter.check(99);
    limiter.dispose(99);
    expect(limiter.size()).toBe(0);
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `npx vitest run electron/main/__tests__/ipc-rate-limiter.test.ts`
Expected: FAIL — `createKeyedRateLimiter` doesn't exist.

- [ ] **Step 3: Rewrite `electron/main/ipc-rate-limiter.ts`**

```typescript
/**
 * Keyed rate limiter — independent quotas per key (typically a webContents id).
 * Entries auto-evict on next check; call dispose(key) when a webContents is destroyed
 * to free memory eagerly.
 */
export function createKeyedRateLimiter(maxRequests: number, windowMs: number) {
  const buckets = new Map<number | string, number[]>();

  function check(key: number | string): boolean {
    const now = Date.now();
    const windowStart = now - windowMs;
    let timestamps = buckets.get(key);
    if (!timestamps) {
      timestamps = [];
      buckets.set(key, timestamps);
    }
    while (timestamps.length > 0 && timestamps[0]! <= windowStart) {
      timestamps.shift();
    }
    if (timestamps.length >= maxRequests) return false;
    timestamps.push(now);
    return true;
  }

  function dispose(key: number | string): void {
    buckets.delete(key);
  }

  function size(): number {
    return buckets.size;
  }

  return { check, dispose, size };
}

// Back-compat shim: kept for any caller still using the old single-bucket API.
// New code should use createKeyedRateLimiter and key by event.sender.id.
/** @deprecated use createKeyedRateLimiter and key by event.sender.id */
export function createRateLimiter(maxRequests: number, windowMs: number) {
  const limiter = createKeyedRateLimiter(maxRequests, windowMs);
  return function check(): boolean {
    return limiter.check('__legacy__');
  };
}
```

- [ ] **Step 4: Run new test**

Run: `npx vitest run electron/main/__tests__/ipc-rate-limiter.test.ts`
Expected: PASS.

- [ ] **Step 5: Migrate `http-handler.ts:41` to keyed limiter**

In `electron/main/http-handler.ts`:

```typescript
import { createKeyedRateLimiter } from './ipc-rate-limiter';
const httpRateLimiter = createKeyedRateLimiter(60, 60_000);

// Inside the IPC handler — find where the existing handler runs httpRateLimiter():
ipcMain.handle('http:request', async (event, ...args) => {
  if (!httpRateLimiter.check(event.sender.id)) {
    throw new Error('Rate limit exceeded');
  }
  // ... rest
});

// Add cleanup hook in window-manager.ts when window closes:
mainWindow.webContents.on('destroyed', () => {
  httpRateLimiter.dispose(mainWindow.webContents.id);
});
```

- [ ] **Step 6: Migrate `grpc-handler.ts`, `websocket-handler.ts`, `sse-handler.ts`, `mcp-handler.ts`**

For each: find the `createRateLimiter(...)` call site, switch to `createKeyedRateLimiter`, key every check by `event.sender.id`, and ensure cleanup on `destroyed`. Use `rg "createRateLimiter\(" electron/main` to find every site:

```bash
rg "createRateLimiter\(" electron/main
```

For each file the search returns, apply the same pattern as Step 5.

- [ ] **Step 7: Add a destroyed-cleanup helper**

Create `electron/main/rate-limiter-cleanup.ts`:

```typescript
import type { WebContents } from 'electron';

interface KeyedLimiter { dispose(key: number): void }

export function bindLimiterToWebContents(
  limiters: KeyedLimiter[],
  webContents: WebContents
): void {
  webContents.once('destroyed', () => {
    for (const l of limiters) l.dispose(webContents.id);
  });
}
```

Then in `window-manager.ts` after window creation, call `bindLimiterToWebContents([httpRateLimiter, grpcRateLimiter, ...], mainWindow.webContents)` once, importing each from its handler module.

- [ ] **Step 8: Run full Electron tests**

Run: `npx vitest run electron/main/__tests__`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add electron/main/ipc-rate-limiter.ts electron/main/__tests__/ipc-rate-limiter.test.ts electron/main/rate-limiter-cleanup.ts electron/main/http-handler.ts electron/main/grpc-handler.ts electron/main/websocket-handler.ts electron/main/sse-handler.ts electron/main/mcp-handler.ts electron/main/window-manager.ts
git commit -m "fix(electron): per-webContents IPC rate limiting with destroyed-cleanup"
```

---

### Task 2.2: `senderFrame` validation on every IPC handler

**Why:** A compromised renderer in any frame (or a renderer with a debugged child window) can call every IPC. Pin handlers to the main frame.

**Files:**
- Modify: `electron/main/ipc-validators.ts:366-378` (`createValidatedHandler`)
- Modify: `electron/main/window-manager.ts` (export trusted-frame URL hook)

- [ ] **Step 1: Write failing test**

Add to `electron/main/__tests__/ipc-validators.test.ts` (create if missing):

```typescript
import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { createValidatedHandler } from '../ipc-validators';

describe('createValidatedHandler frame validation', () => {
  it('rejects events from non-main frames', async () => {
    const handler = createValidatedHandler('test:channel', z.string(), async (s) => s);
    const evt = {
      sender: { id: 1 },
      senderFrame: { url: 'https://attacker.example/' },
    } as unknown as Electron.IpcMainInvokeEvent;
    await expect(handler(evt, 'hello')).rejects.toThrow(/untrusted frame/i);
  });

  it('accepts events from the main file:// frame', async () => {
    const handler = createValidatedHandler('test:channel', z.string(), async (s) => s);
    const evt = {
      sender: { id: 1 },
      senderFrame: { url: 'file:///path/to/index.html' },
    } as unknown as Electron.IpcMainInvokeEvent;
    await expect(handler(evt, 'hello')).resolves.toBe('hello');
  });

  it('accepts events from localhost dev server', async () => {
    const handler = createValidatedHandler('test:channel', z.string(), async (s) => s);
    const evt = {
      sender: { id: 1 },
      senderFrame: { url: 'http://localhost:5173/' },
    } as unknown as Electron.IpcMainInvokeEvent;
    await expect(handler(evt, 'hello')).resolves.toBe('hello');
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `npx vitest run electron/main/__tests__/ipc-validators.test.ts`
Expected: FAIL.

- [ ] **Step 3: Add frame check to `createValidatedHandler`**

Add at the top of `electron/main/ipc-validators.ts`:

```typescript
function isTrustedFrameUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    if (u.protocol === 'file:') return true;
    if (u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1') && u.port === '5173') {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

function assertTrustedSender(channel: string, event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent): void {
  if (!isTrustedFrameUrl(event.senderFrame?.url)) {
    console.error(`[IPC Frame Reject] ${channel} from ${event.senderFrame?.url}`);
    throw new Error(`IPC ${channel} rejected: untrusted frame`);
  }
}
```

Modify `createValidatedHandler` body:

```typescript
return async (event, ...args) => {
  assertTrustedSender(channel, event);
  const input = args.length === 1 ? args[0] : args;
  const validated = validateIpcInput(schema, input, channel);
  return handler(validated as TInput);
};
```

And `createValidatedListener`:

```typescript
return (event, ...args) => {
  try {
    assertTrustedSender(channel, event);
    const input = args.length === 1 ? args[0] : args;
    const validated = validateIpcInput(schema, input, channel);
    handler(event, validated as TInput);
  } catch (error) {
    console.error(`[IPC Listener Error] Channel: ${channel}`, error);
  }
};
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run electron/main/__tests__/ipc-validators.test.ts && npx vitest run electron/main/__tests__`
Expected: PASS — but expect existing `__tests__/file-operations.test.ts` etc. may need updating to include `senderFrame` in their mock event. Update each one to set `senderFrame: { url: 'file:///' }`.

- [ ] **Step 5: Update test event mocks**

Use ripgrep to find every test that constructs a fake Electron event:

```bash
rg "as unknown as Electron.IpcMainInvokeEvent|as Electron.IpcMainInvokeEvent" electron/main/__tests__
```

For each match, ensure `senderFrame: { url: 'file:///' }` is on the mock event. Re-run `npx vitest run electron/main/__tests__` until green.

- [ ] **Step 6: Commit**

```bash
git add electron/main/ipc-validators.ts electron/main/__tests__/
git commit -m "fix(electron): reject IPC from untrusted frames at the validator boundary"
```

---

### Task 2.3: Tighten `file-operations` allowlist

**Files:**
- Modify: `electron/main/file-operations.ts:18-59` (`isPathSafe`)
- Test: `electron/main/__tests__/file-operations.test.ts` (extend)

- [ ] **Step 1: Write failing test**

Add to `electron/main/__tests__/file-operations.test.ts`:

```typescript
import { app } from 'electron';
import path from 'path';
import { isPathSafe } from '../file-operations';

describe('isPathSafe — tighter allowlist', () => {
  it('rejects ~/.ssh/id_rsa even though it sits under home', () => {
    const home = app.getPath('home');
    expect(isPathSafe(path.join(home, '.ssh', 'id_rsa'))).toBe(false);
  });

  it('rejects ~/.aws/credentials', () => {
    const home = app.getPath('home');
    expect(isPathSafe(path.join(home, '.aws', 'credentials'))).toBe(false);
  });

  it('allows files under userData', () => {
    const u = app.getPath('userData');
    expect(isPathSafe(path.join(u, 'collections', 'foo.json'))).toBe(true);
  });

  it('allows files under documents', () => {
    const d = app.getPath('documents');
    expect(isPathSafe(path.join(d, 'restura', 'foo.json'))).toBe(true);
  });

  it('rejects sibling-of-allowed-root prefix attacks', () => {
    const u = app.getPath('userData');
    expect(isPathSafe(u + '-evil/foo.json')).toBe(false);
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `npx vitest run electron/main/__tests__/file-operations.test.ts -t "tighter allowlist"`
Expected: at least the `.ssh` and `.aws` tests fail.

- [ ] **Step 3: Replace `isPathSafe` with a denylist-of-dotfile-dirs under a smaller allowlist**

Replace lines 18-59 of `electron/main/file-operations.ts`:

```typescript
// Subdirectories under $HOME that hold credentials / browser data and must
// never be reachable through fs:readFile / fs:writeFile, even though we still
// allow $HOME for the rare legitimate case (user-picked path via dialog).
const HOME_BLOCKED_SUBDIRS = [
  '.ssh', '.aws', '.gnupg', '.kube', '.docker', '.npmrc',
  '.config/gh', '.config/op', '.config/google-chrome', '.config/Microsoft',
  '.mozilla', 'Library/Application Support', 'Library/Keychains',
  'Library/Cookies', 'AppData/Roaming/Microsoft', 'AppData/Local/Google',
];

export function isPathSafe(filePath: string): boolean {
  try {
    const resolved = path.resolve(filePath);
    const userDataPath = path.resolve(app.getPath('userData'));
    const documentsPath = path.resolve(app.getPath('documents'));
    const homePath = path.resolve(app.getPath('home'));

    // Allow only userData, documents, and home — and *only* if not under a sensitive subdir
    const allowedRoots = [userDataPath, documentsPath, homePath];
    const underAllowed = allowedRoots.some(
      (root) => resolved === root || resolved.startsWith(root + path.sep)
    );
    if (!underAllowed) return false;

    // Apply $HOME-specific deny list
    if (resolved === homePath || resolved.startsWith(homePath + path.sep)) {
      const rel = path.relative(homePath, resolved);
      const parts = rel.split(path.sep);
      for (const blocked of HOME_BLOCKED_SUBDIRS) {
        const blockedParts = blocked.split('/');
        if (blockedParts.every((p, i) => parts[i] === p)) return false;
      }
    }

    return true;
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run all file-operations tests**

Run: `npx vitest run electron/main/__tests__/file-operations.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add electron/main/file-operations.ts electron/main/__tests__/file-operations.test.ts
git commit -m "fix(electron): deny ~/.ssh, ~/.aws, browser data under file-operations allowlist"
```

---

### Task 2.4: Fix gRPC proto write path traversal

**Files:**
- Modify: `shared/protocol/grpc-schema.ts` (created in Task 1.2) — tighten `id` field
- Modify: `electron/main/grpc-handler.ts:275` (`makeGrpcRequest` requestId derivation)
- Test: `electron/main/__tests__/grpc-handler.test.ts` (add)

- [ ] **Step 1: Write failing test**

Add to `electron/main/__tests__/grpc-handler.test.ts`:

```typescript
import { GrpcRequestConfigSchema } from '@shared/protocol/grpc-schema';

describe('GrpcRequestConfigSchema id constraint', () => {
  it('rejects path-traversal id', () => {
    const result = GrpcRequestConfigSchema.safeParse({
      id: '../../etc/passwd',
      url: 'https://api.example/',
      service: 'foo.Bar',
      method: 'Baz',
      methodType: 'unary',
      metadata: {},
      message: {},
      protoContent: 'syntax = "proto3"; service Bar {}',
      protoFileName: 'bar.proto',
    });
    expect(result.success).toBe(false);
  });

  it('accepts UUID-shaped id', () => {
    const result = GrpcRequestConfigSchema.safeParse({
      id: '550e8400-e29b-41d4-a716-446655440000',
      url: 'https://api.example/',
      service: 'foo.Bar',
      method: 'Baz',
      methodType: 'unary',
      metadata: {},
      message: {},
      protoContent: 'syntax = "proto3"; service Bar {}',
      protoFileName: 'bar.proto',
    });
    expect(result.success).toBe(true);
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `npx vitest run electron/main/__tests__/grpc-handler.test.ts -t "id constraint"`
Expected: FAIL.

- [ ] **Step 3: Tighten the schema**

Modify `GrpcRequestConfigSchema` in `shared/protocol/grpc-schema.ts` (the file moved from `validations.ts` in Task 1.2). Replace the `id` field:

```typescript
id: z.string().regex(/^[a-zA-Z0-9_-]+$/, 'id must be alphanumeric with dashes/underscores').max(64).optional(),
```

- [ ] **Step 4: Belt-and-braces in grpc-handler.ts:275**

In `electron/main/grpc-handler.ts`, replace `const requestId = config.id || uuidv4();` with:

```typescript
const SAFE_ID_RE = /^[a-zA-Z0-9_-]+$/;
const requestId = config.id && SAFE_ID_RE.test(config.id) ? config.id : uuidv4();
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run electron/main/__tests__/grpc-handler.test.ts shared/protocol`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add shared/protocol/grpc-schema.ts electron/main/grpc-handler.ts electron/main/__tests__/grpc-handler.test.ts
git commit -m "fix(electron): constrain gRPC request id to safe charset to prevent proto-write path traversal"
```

---

### Task 2.5: Re-validate deep-link payload URLs in main process

**Files:**
- Modify: `electron/main/deep-link-handler.ts:37-57`
- Test: `electron/main/__tests__/deep-link-handler.test.ts` (create)

- [ ] **Step 1: Write failing test**

Create `electron/main/__tests__/deep-link-handler.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { __test_handleDeepLink } from '../deep-link-handler';

describe('handleDeepLink url-param validation', () => {
  it('drops `url` param pointing at private IP', () => {
    const sent: Array<{ host: string; params: Record<string, string> }> = [];
    const win = {
      webContents: { send: (_ch: string, msg: { host: string; params: Record<string, string> }) => sent.push(msg) },
    } as never;
    __test_handleDeepLink('restura://import?url=http://169.254.169.254/x', () => win);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.params.url).toBeUndefined();
  });

  it('preserves a valid public url', () => {
    const sent: Array<{ host: string; params: Record<string, string> }> = [];
    const win = {
      webContents: { send: (_ch: string, msg: { host: string; params: Record<string, string> }) => sent.push(msg) },
    } as never;
    __test_handleDeepLink('restura://import?url=https://example.com/foo.json', () => win);
    expect(sent[0]!.params.url).toBe('https://example.com/foo.json');
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `npx vitest run electron/main/__tests__/deep-link-handler.test.ts`
Expected: FAIL — symbol not exported.

- [ ] **Step 3: Refactor `electron/main/deep-link-handler.ts` to validate URL params and export the test seam**

Replace lines 34-57:

```typescript
import { validateURL } from '@shared/protocol/url-validation';

const VALID_DEEP_LINK_HOSTS = new Set(['import', 'environment', 'collection', 'request', 'settings']);

// Param keys that hold URLs and must pass validateURL before forwarding.
const URL_PARAM_KEYS = new Set(['url', 'href', 'src', 'callback']);

function handleDeepLink(url: string, getWindow: () => BrowserWindow | null): void {
  const win = getWindow();
  if (!win) return;

  try {
    const parsed = new URL(url);
    if (!VALID_DEEP_LINK_HOSTS.has(parsed.hostname)) return;

    const params: Record<string, string> = {};
    for (const [key, value] of parsed.searchParams) {
      if (!/^[a-zA-Z0-9_-]+$/.test(key)) continue;
      const truncated = value.slice(0, 1024);
      if (URL_PARAM_KEYS.has(key.toLowerCase())) {
        const v = validateURL(truncated, { allowPrivateIPs: false, allowLocalhost: false });
        if (!v.valid) {
          console.warn(`[deep-link] dropped unsafe ${key}=${truncated}: ${v.error}`);
          continue;
        }
      }
      params[key] = truncated;
    }

    win.webContents.send('deep-link', { host: parsed.hostname, params });
  } catch {
    // Ignore malformed deep link URLs
  }
}

// Test seam — exported only for unit tests, not consumed by the app
export const __test_handleDeepLink = handleDeepLink;
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run electron/main/__tests__/deep-link-handler.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add electron/main/deep-link-handler.ts electron/main/__tests__/deep-link-handler.test.ts
git commit -m "fix(electron): validate URL params in deep-link payloads before forwarding to renderer"
```

---

## Phase 3 — Storage and Persistence Fixes

### Task 3.1: Strip response bodies from persisted tabs

**Why:** A 4MB JSON response × 3 tabs × every tab switch = encrypt+stringify+IndexedDB on the hot path. Responses live in history; tabs need only the request.

**Files:**
- Modify: `src/store/useRequestStore.ts:312-318` (partialize)
- Test: `src/store/__tests__/useRequestStore.test.ts` (add)

- [ ] **Step 1: Write failing test**

Add to `src/store/__tests__/useRequestStore.test.ts`:

```typescript
it('does not persist tab.response (kept in memory only)', () => {
  const { useRequestStore } = require('../useRequestStore');
  const partialize = useRequestStore.persist.getOptions().partialize as (s: unknown) => unknown;
  const sample = {
    activeTabId: 't1',
    tabs: [
      {
        id: 't1',
        request: { type: 'http', method: 'GET', url: 'https://x' },
        response: { status: 200, body: 'x'.repeat(5_000_000), size: 5_000_000, headers: {}, time: 0 },
        streamingEvents: [],
      },
    ],
  };
  const persisted = partialize(sample) as { tabs: Array<{ response?: unknown }> };
  expect(persisted.tabs[0]!.response).toBeUndefined();
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `npx vitest run src/store/__tests__/useRequestStore.test.ts -t "does not persist tab.response"`
Expected: FAIL.

- [ ] **Step 3: Update partialize**

Modify `src/store/useRequestStore.ts:312-318`:

```typescript
partialize: (state) => ({
  // streamingEvents: AsyncIterables can't serialize.
  // response: bodies can be huge (10s of MB) and live in history already; rehydrate as null.
  tabs: state.tabs.map(({ streamingEvents: _drop1, response: _drop2, ...rest }) => ({
    ...rest,
    response: null,
  })),
  activeTabId: state.activeTabId,
}),
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/store`
Expected: PASS.

- [ ] **Step 5: Verify the UI degrades gracefully on rehydrate (no response shown until re-run)**

Run: `npm run dev`. Open a request, run it, refresh. Confirm: tab is restored, response area shows empty/placeholder (not stale data, no crash). Stop dev server.

- [ ] **Step 6: Commit**

```bash
git add src/store/useRequestStore.ts src/store/__tests__/useRequestStore.test.ts
git commit -m "perf(store): drop tab.response from persisted state (lives in history)"
```

---

### Task 3.2: Move file-collection store to Dexie + version

**Files:**
- Modify: `src/store/useFileCollectionStore.ts:169-176`
- Modify: `src/lib/shared/database.ts` (add table if needed)
- Modify: `src/lib/shared/dexie-storage.ts` (add adapter if missing)

- [ ] **Step 1: Verify the table exists**

Run: `rg "fileCollections|file_collections|file-collections" src/lib/shared/database.ts src/lib/shared/dexie-storage.ts`
If no `fileCollections` table is defined, add one to `database.ts` following the pattern of an existing table (e.g. `requestTabs`) — store key='file-collection-storage', value=JSON.

If no `dexieStorageAdapters.fileCollections()` exists, add it in `dexie-storage.ts` following the pattern of `requestTabs()`.

- [ ] **Step 2: Add a test for migration safety**

Add to `src/store/__tests__/useFileCollectionStore.test.ts` (create if missing):

```typescript
import { describe, it, expect, beforeEach } from 'vitest';

describe('useFileCollectionStore persistence', () => {
  beforeEach(() => localStorage.clear());

  it('uses dexie adapter and declares version', () => {
    const { useFileCollectionStore } = require('../useFileCollectionStore');
    const opts = useFileCollectionStore.persist.getOptions();
    expect(opts.version).toBe(1);
    expect(opts.storage).toBeDefined();
    expect(opts.storage).not.toBe(localStorage);
  });
});
```

- [ ] **Step 3: Run to confirm failure**

Run: `npx vitest run src/store/__tests__/useFileCollectionStore.test.ts`
Expected: FAIL.

- [ ] **Step 4: Migrate the store**

Edit `src/store/useFileCollectionStore.ts:169-176`:

```typescript
import { dexieStorageAdapters } from '@/lib/shared/dexie-storage';

// ... at the persist config:
{
  name: 'file-collection-storage',
  version: 1,
  storage: dexieStorageAdapters.fileCollections(),
  partialize: (state) => ({
    fileCollections: state.fileCollections,
    defaultDirectory: state.defaultDirectory,
  }),
  migrate: (persistedState, _version) => {
    return persistedState as FileCollectionState;
  },
}
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run src/store/__tests__/useFileCollectionStore.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/store/useFileCollectionStore.ts src/store/__tests__/useFileCollectionStore.test.ts src/lib/shared/database.ts src/lib/shared/dexie-storage.ts
git commit -m "fix(store): route file-collection-storage through Dexie with version"
```

---

### Task 3.3: Real localStorage→Dexie one-shot migration

**Why:** Six stores have no-op `migrate` functions and the original localStorage data is never read. The next person bumping to v3 will write a real migration on top of empty state.

**Files:**
- Create: `src/lib/shared/migrate-legacy-storage.ts`
- Modify: `src/store/useCollectionStore.ts:132`, `useEnvironmentStore.ts:120`, `useSettingsStore.ts:168`, `useHistoryStore.ts:127`, `useWorkflowStore.ts:233`, `src/features/http/store/useCookieStore.ts:108`

- [ ] **Step 1: Write the migration helper test**

Create `src/lib/shared/__tests__/migrate-legacy-storage.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { migrateLegacyLocalStorage } from '../migrate-legacy-storage';

describe('migrateLegacyLocalStorage', () => {
  beforeEach(() => localStorage.clear());

  it('returns null when no legacy entry exists', () => {
    expect(migrateLegacyLocalStorage('foo')).toBeNull();
  });

  it('returns parsed legacy state and clears the key', () => {
    localStorage.setItem('foo', JSON.stringify({ state: { a: 1 }, version: 1 }));
    const result = migrateLegacyLocalStorage('foo');
    expect(result).toEqual({ a: 1 });
    expect(localStorage.getItem('foo')).toBeNull();
  });

  it('returns null on malformed JSON without throwing', () => {
    localStorage.setItem('foo', '{not json');
    expect(migrateLegacyLocalStorage('foo')).toBeNull();
    expect(localStorage.getItem('foo')).toBeNull();
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `npx vitest run src/lib/shared/__tests__/migrate-legacy-storage.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the helper**

Create `src/lib/shared/migrate-legacy-storage.ts`:

```typescript
/**
 * One-shot migration from the legacy zustand/persist localStorage layout
 * (`{ state, version }`) into the Dexie-backed adapter.
 *
 * Call from a store's `migrate` hook only when the Dexie read returned
 * the default (empty) state. Returns the legacy state slice or null.
 *
 * Always removes the legacy key after a successful read so subsequent
 * page loads don't re-migrate.
 */
export function migrateLegacyLocalStorage<T = unknown>(name: string): T | null {
  if (typeof window === 'undefined') return null;
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(name);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { state?: T };
    window.localStorage.removeItem(name);
    return parsed.state ?? null;
  } catch {
    try { window.localStorage.removeItem(name); } catch { /* ignore */ }
    return null;
  }
}
```

- [ ] **Step 4: Wire up each affected store**

For each of: `useCollectionStore`, `useEnvironmentStore`, `useSettingsStore`, `useHistoryStore`, `useWorkflowStore`, `useCookieStore` — replace the no-op migrate with:

```typescript
import { migrateLegacyLocalStorage } from '@/lib/shared/migrate-legacy-storage';

// inside persist config:
migrate: (persistedState: unknown, version) => {
  // If Dexie returned nothing meaningful, try the v0/v1 localStorage shape.
  const looksEmpty =
    !persistedState ||
    (typeof persistedState === 'object' && Object.keys(persistedState as object).length === 0);
  if (looksEmpty || version < 2) {
    const legacy = migrateLegacyLocalStorage<MyStoreShape>('the-store-name');
    if (legacy) return legacy as MyStoreShape;
  }
  return persistedState as MyStoreShape;
},
```

Replace `'the-store-name'` and `MyStoreShape` per store.

- [ ] **Step 5: Add per-store test**

Add to `src/store/__tests__/useCollectionStore.test.ts`:

```typescript
it('rehydrates from legacy localStorage when Dexie is empty', async () => {
  localStorage.setItem('collection-storage', JSON.stringify({
    state: { collections: [{ id: 'c1', name: 'Legacy', items: [] }] },
    version: 1,
  }));
  // Trigger rehydrate — depends on store API; if direct migrate() is exported, call it
  const opts = (await import('../useCollectionStore')).useCollectionStore.persist.getOptions();
  const result = (opts.migrate as (s: unknown, v: number) => unknown)({}, 1);
  expect((result as { collections: Array<{ id: string }> }).collections[0]!.id).toBe('c1');
  expect(localStorage.getItem('collection-storage')).toBeNull();
});
```

Repeat the pattern for each migrated store.

- [ ] **Step 6: Run tests**

Run: `npx vitest run src/store src/lib/shared`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/shared/migrate-legacy-storage.ts src/lib/shared/__tests__/migrate-legacy-storage.test.ts src/store/useCollectionStore.ts src/store/useEnvironmentStore.ts src/store/useSettingsStore.ts src/store/useHistoryStore.ts src/store/useWorkflowStore.ts src/features/http/store/useCookieStore.ts src/store/__tests__/
git commit -m "fix(store): real one-shot localStorage→Dexie migration for v0/v1 stores"
```

---

### Task 3.4: Web encryption story — force passphrase or document plaintext

**Why:** Today, web defaults to ephemeral keys → closing the tab corrupts your own data. Pick one path: require a passphrase, or stop claiming encryption on web.

- [ ] **Step 1: Decide and document the policy**

Add `docs/security.md` (create) with a one-page statement:

```markdown
# Restura storage encryption policy

**Electron desktop:** All persisted state encrypted with a per-install key
held in OS keychain via Electron's `safeStorage`. Plain-text only when the
OS reports `safeStorage.isEncryptionAvailable() === false`, in which case
the user is warned at startup.

**Web (Cloudflare Pages):** Persisted state is **NOT** encrypted at rest by
default. localStorage / IndexedDB on web is single-origin protected; users
who require encryption at rest should use the desktop app or set a session
passphrase via Settings → Security → "Set workspace passphrase".

There is **no** "ephemeral encryption" mode any more — it created the
illusion of safety while corrupting data on tab close.
```

- [ ] **Step 2: Replace the EphemeralKeyProvider default**

Edit `src/lib/shared/keyProvider.ts:140-155`:

```typescript
import { PlaintextKeyProvider } from './keyProvider-plaintext';

export function getKeyProvider(): KeyProvider {
  if (activeProvider) return activeProvider;
  if (isElectron()) {
    const api = getElectronAPI();
    if (api?.store) {
      activeProvider = new ElectronSafeStorageKeyProvider({
        get: api.store.get.bind(api.store),
        set: api.store.set.bind(api.store),
        has: api.store.has.bind(api.store),
      });
      return activeProvider;
    }
  }
  // Web default: plain-text storage. The user can swap in
  // WebSessionPassphraseProvider via setKeyProvider() from the Settings UI.
  activeProvider = new PlaintextKeyProvider();
  return activeProvider;
}
```

- [ ] **Step 3: Add a `PlaintextKeyProvider`**

Add to `src/lib/shared/keyProvider.ts` (or a new sibling file `keyProvider-plaintext.ts`):

```typescript
const PLAINTEXT_SENTINEL = new Uint8Array(32); // all zeros — recognizable in tests

export class PlaintextKeyProvider implements KeyProvider {
  async getKey(): Promise<Uint8Array> {
    return PLAINTEXT_SENTINEL;
  }
  isEncrypted(): boolean { return false; }
}
```

Update `dexie-storage.ts` to skip the encrypt/decrypt round-trip when `provider.isEncrypted?.() === false` — store the JSON as-is.

- [ ] **Step 4: Update keyProvider tests**

Edit `src/lib/shared/keyProvider.test.ts` — replace any `EphemeralKeyProvider` default-fallback expectation with `PlaintextKeyProvider`. Add a test confirming `getKeyProvider()` on web returns a provider whose `isEncrypted()` is false.

- [ ] **Step 5: Add a Settings UI hook for the passphrase**

Inspect existing `SettingsDialog/` for a Security tab. If absent, add a panel that:

1. Shows current encryption mode (`provider.isEncrypted()`).
2. Provides "Set workspace passphrase" → calls `setKeyProvider(new WebSessionPassphraseProvider())` with the entered passphrase.
3. Warns "Existing data will be re-encrypted on next save."

If this is significant UI work, scope-cut: just expose the toggle in JSON form for now and file a follow-up.

- [ ] **Step 6: Run tests and dev**

Run: `npx vitest run src/lib/shared`
Expected: PASS.
Run: `npm run dev` and verify Settings shows the new policy.

- [ ] **Step 7: Commit**

```bash
git add docs/security.md src/lib/shared/keyProvider.ts src/lib/shared/keyProvider-plaintext.ts src/lib/shared/dexie-storage.ts src/lib/shared/keyProvider.test.ts src/components/shared/SettingsDialog/
git commit -m "fix(security): drop misleading 'ephemeral encryption' on web; opt-in passphrase mode"
```

---

### Task 3.5: Wire `maxHistoryItems` / `autoSaveHistory`

**Files:**
- Modify: `src/store/useHistoryStore.ts:29` (`addHistoryItem`)
- Modify: `src/store/__tests__/useHistoryStore.test.ts` (add)

- [ ] **Step 1: Write failing test**

```typescript
it('respects settings.maxHistoryItems when capping', () => {
  const { useSettingsStore } = require('../useSettingsStore');
  const { useHistoryStore } = require('../useHistoryStore');
  useSettingsStore.setState({ settings: { ...useSettingsStore.getState().settings, maxHistoryItems: 3 } });
  for (let i = 0; i < 10; i++) {
    useHistoryStore.getState().addHistoryItem({ id: String(i), request: {} as never, response: {} as never, timestamp: i });
  }
  expect(useHistoryStore.getState().items.length).toBe(3);
});

it('skips when settings.autoSaveHistory is false', () => {
  const { useSettingsStore } = require('../useSettingsStore');
  const { useHistoryStore } = require('../useHistoryStore');
  useSettingsStore.setState({ settings: { ...useSettingsStore.getState().settings, autoSaveHistory: false } });
  useHistoryStore.getState().addHistoryItem({ id: 'x', request: {} as never, response: {} as never, timestamp: 0 });
  expect(useHistoryStore.getState().items.length).toBe(0);
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `npx vitest run src/store/__tests__/useHistoryStore.test.ts`
Expected: FAIL.

- [ ] **Step 3: Wire `addHistoryItem`**

In `src/store/useHistoryStore.ts`:

```typescript
import { useSettingsStore } from './useSettingsStore';

// Inside the store factory, replace the existing addHistoryItem:
addHistoryItem: (item) => set((state) => {
  const settings = useSettingsStore.getState().settings;
  if (!settings.autoSaveHistory) return state;
  const cap = Math.max(1, settings.maxHistoryItems ?? 100);
  return { items: [item, ...state.items].slice(0, cap) };
}),
```

Remove the `MAX_HISTORY_ITEMS = 100` constant.

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/store`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/store/useHistoryStore.ts src/store/__tests__/useHistoryStore.test.ts
git commit -m "fix(store): respect settings.autoSaveHistory and maxHistoryItems in addHistoryItem"
```

---

## Phase 4 — ProtocolRegistry + useRequestRunner Refactor

**Why:** SSE/WS/MCP currently bypass scripts, history, and save-to-collection. Adding MQTT/SignalR today is a 7-file scavenger hunt. A registry centralizes this and makes future protocols a one-folder change.

**Strategy:** Introduce the registry without removing existing per-protocol UI. Migrate one protocol at a time. The HTTP path stays as the canonical reference implementation throughout.

---

### Task 4.1: Define the `ProtocolRegistry` types and skeleton

**Files:**
- Create: `src/features/registry/types.ts`
- Create: `src/features/registry/registry.ts`
- Create: `src/features/registry/__tests__/registry.test.ts`

- [ ] **Step 1: Write the test**

```typescript
import { describe, it, expect } from 'vitest';
import { createProtocolRegistry } from '../registry';
import type { ProtocolModule } from '../types';

describe('ProtocolRegistry', () => {
  it('registers and looks up by id', () => {
    const reg = createProtocolRegistry();
    const fake: ProtocolModule = {
      id: 'fake',
      label: 'Fake',
      tabType: 'http' as const,
      defaultRequest: () => ({ id: 'r1', type: 'http', method: 'GET', url: '' } as never),
      runRequest: async () => ({ status: 200, body: '', headers: {}, size: 0, time: 0 } as never),
    };
    reg.register(fake);
    expect(reg.get('fake')).toBe(fake);
    expect(reg.list().map((p) => p.id)).toContain('fake');
  });

  it('throws on duplicate registration', () => {
    const reg = createProtocolRegistry();
    const fake = { id: 'x', label: 'X', tabType: 'http' as const, defaultRequest: () => ({} as never), runRequest: async () => ({} as never) };
    reg.register(fake);
    expect(() => reg.register(fake)).toThrow(/already registered/);
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `npx vitest run src/features/registry/__tests__/registry.test.ts`
Expected: FAIL.

- [ ] **Step 3: Define types**

Create `src/features/registry/types.ts`:

```typescript
import type { ComponentType } from 'react';
import type { Request, Response, RequestType } from '@/types';

export interface RunContext {
  signal: AbortSignal;
  variables: Record<string, string>;
}

export interface ProtocolModule {
  /** Stable id used in URLs, code generators, and analytics */
  id: string;
  /** Display label in mode picker */
  label: string;
  /** Which `Request` discriminator this protocol uses */
  tabType: RequestType;
  /** React component rendered as the request builder */
  Builder?: ComponentType<{ request: Request; onChange: (next: Request) => void }>;
  /** Construct a default empty Request for this protocol */
  defaultRequest: () => Request;
  /** Execute the request and resolve to a Response (or throw) */
  runRequest: (request: Request, ctx: RunContext) => Promise<Response>;
  /** Optional: code-generator entries this protocol contributes */
  codeGenerators?: Record<string, (request: Request) => string>;
}

export interface ProtocolRegistry {
  register(module: ProtocolModule): void;
  get(id: string): ProtocolModule | undefined;
  list(): ProtocolModule[];
}
```

- [ ] **Step 4: Implement the registry**

Create `src/features/registry/registry.ts`:

```typescript
import type { ProtocolRegistry, ProtocolModule } from './types';

export function createProtocolRegistry(): ProtocolRegistry {
  const modules = new Map<string, ProtocolModule>();
  return {
    register(m) {
      if (modules.has(m.id)) throw new Error(`Protocol already registered: ${m.id}`);
      modules.set(m.id, m);
    },
    get(id) { return modules.get(id); },
    list() { return Array.from(modules.values()); },
  };
}

// Singleton for the app
export const protocolRegistry = createProtocolRegistry();
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run src/features/registry`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/features/registry/
git commit -m "feat(registry): add ProtocolRegistry skeleton (no protocols registered yet)"
```

---

### Task 4.2: Register HTTP and gRPC as the first two protocols

**Files:**
- Create: `src/features/http/protocol.ts`
- Create: `src/features/grpc/protocol.ts`
- Create: `src/features/registry/bootstrap.ts`
- Modify: `src/main.tsx` (or equivalent entry) to import bootstrap

- [ ] **Step 1: Write a smoke test**

Create `src/features/registry/__tests__/bootstrap.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';

describe('bootstrap', () => {
  beforeEach(() => {
    // Reset module cache so re-importing creates fresh state
    vi.resetModules();
  });

  it('registers http and grpc on import', async () => {
    await import('../bootstrap');
    const { protocolRegistry } = await import('../registry');
    expect(protocolRegistry.get('http')).toBeDefined();
    expect(protocolRegistry.get('grpc')).toBeDefined();
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `npx vitest run src/features/registry/__tests__/bootstrap.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement HTTP protocol module**

Create `src/features/http/protocol.ts`:

```typescript
import type { ProtocolModule } from '@/features/registry/types';
import { executeRequest } from './lib/requestExecutor';
import { v4 as uuidv4 } from 'uuid';
import RequestBuilder from './components/RequestBuilder';

export function createDefaultHttpRequest() {
  return {
    id: uuidv4(),
    type: 'http' as const,
    method: 'GET',
    url: '',
    headers: [],
    params: [],
    body: { type: 'none' as const },
  };
}

export const httpProtocol: ProtocolModule = {
  id: 'http',
  label: 'HTTP',
  tabType: 'http',
  Builder: RequestBuilder,
  defaultRequest: createDefaultHttpRequest,
  runRequest: async (request, ctx) => {
    if (request.type !== 'http') throw new Error('HTTP protocol cannot run non-HTTP request');
    return executeRequest(request, { signal: ctx.signal, variables: ctx.variables });
  },
};
```

(If `executeRequest`'s current signature differs, adapt the call. The point is the registry surface; the inner contract stays the same.)

- [ ] **Step 4: Implement gRPC protocol module**

Create `src/features/grpc/protocol.ts` mirroring the same shape, calling `grpcClient.invoke` (or equivalent).

- [ ] **Step 5: Implement bootstrap**

Create `src/features/registry/bootstrap.ts`:

```typescript
import { protocolRegistry } from './registry';
import { httpProtocol } from '@/features/http/protocol';
import { grpcProtocol } from '@/features/grpc/protocol';

protocolRegistry.register(httpProtocol);
protocolRegistry.register(grpcProtocol);
```

- [ ] **Step 6: Import bootstrap once at app entry**

Identify the renderer entry (likely `src/main.tsx` or `src/index.tsx`). Add:

```typescript
import '@/features/registry/bootstrap';
```

at the top, before `ReactDOM.createRoot(...)`.

- [ ] **Step 7: Run tests**

Run: `npx vitest run src/features/registry`
Expected: PASS.

- [ ] **Step 8: Run dev, verify HTTP and gRPC tabs still work**

Run: `npm run dev`. Open an HTTP tab, send a request — must succeed exactly as before. Open a gRPC tab, do the same.

- [ ] **Step 9: Commit**

```bash
git add src/features/http/protocol.ts src/features/grpc/protocol.ts src/features/registry/bootstrap.ts src/features/registry/__tests__/bootstrap.test.ts src/main.tsx
git commit -m "feat(registry): register http and grpc as first protocols (no behavior change)"
```

---

### Task 4.3: Extract `useRequestRunner` hook

**Why:** This is the seam every Builder will call instead of inlining script→execute→history→test. Once this exists, decomposing GrpcRequestBuilder is trivial.

**Files:**
- Create: `src/features/registry/useRequestRunner.ts`
- Test: `src/features/registry/__tests__/useRequestRunner.test.tsx`

- [ ] **Step 1: Write failing test**

```typescript
import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useRequestRunner } from '../useRequestRunner';
import { protocolRegistry } from '../registry';

describe('useRequestRunner', () => {
  beforeEach(() => {
    vi.resetModules();
    // Register a fake protocol with a recorded runner
  });

  it('runs scripts -> protocol.runRequest -> records history -> runs tests', async () => {
    const fakeRun = vi.fn().mockResolvedValue({ status: 200, body: '', headers: {}, size: 0, time: 0 });
    protocolRegistry.register({
      id: 'fake',
      label: 'Fake',
      tabType: 'http' as never,
      defaultRequest: () => ({} as never),
      runRequest: fakeRun,
    });
    const { result } = renderHook(() => useRequestRunner());
    await act(async () => {
      await result.current.run({ id: 'r1', type: 'http', method: 'GET', url: 'https://example' } as never, 'fake');
    });
    expect(fakeRun).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `npx vitest run src/features/registry/__tests__/useRequestRunner.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement the hook**

Create `src/features/registry/useRequestRunner.ts`:

```typescript
import { useCallback, useRef } from 'react';
import { protocolRegistry } from './registry';
import { useHistoryStore } from '@/store/useHistoryStore';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';
import { useRequestStore } from '@/store/useRequestStore';
import { runPreRequestScript, runTestScript } from '@/features/scripts/lib/scriptExecutor';
import type { Request, Response } from '@/types';

export interface RunResult {
  response: Response;
  durationMs: number;
}

export function useRequestRunner() {
  const abortRef = useRef<AbortController | null>(null);
  const setScriptResult = useRequestStore((s) => s.setScriptResult);

  const run = useCallback(async (request: Request, protocolId: string): Promise<RunResult> => {
    const protocol = protocolRegistry.get(protocolId);
    if (!protocol) throw new Error(`Unknown protocol: ${protocolId}`);

    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    const env = useEnvironmentStore.getState();
    const variables = env.getActiveVariables?.() ?? {};

    // 1. Pre-request script
    const preResult = await runPreRequestScript(request, variables);
    setScriptResult({ preRequest: preResult, test: null });

    // 2. Execute via protocol
    const startedAt = performance.now();
    const response = await protocol.runRequest(request, {
      signal: ctrl.signal,
      variables: { ...variables, ...preResult?.exportedVariables },
    });
    const durationMs = performance.now() - startedAt;

    // 3. History
    useHistoryStore.getState().addHistoryItem({
      id: crypto.randomUUID(),
      request,
      response,
      timestamp: Date.now(),
    });

    // 4. Test script
    const testResult = await runTestScript(request, response, variables);
    setScriptResult({ preRequest: preResult, test: testResult });

    return { response, durationMs };
  }, [setScriptResult]);

  const abort = useCallback(() => abortRef.current?.abort(), []);

  return { run, abort };
}
```

(Adapt to the actual signatures of `runPreRequestScript` / `runTestScript` / `getActiveVariables` — read those files and tune.)

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/features/registry`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/features/registry/useRequestRunner.ts src/features/registry/__tests__/useRequestRunner.test.tsx
git commit -m "feat(registry): useRequestRunner hook centralizes script→execute→history→test pipeline"
```

---

### Task 4.4: Migrate HTTP `RequestBuilder` to use `useRequestRunner`

**Why:** HTTP is the safest protocol to migrate first — it already has the canonical pipeline.

**Files:**
- Modify: `src/features/http/components/RequestBuilder/` (or wherever the run-button handler lives)
- Modify: `src/features/http/hooks/useHttpRequest.ts`

- [ ] **Step 1: Find the current "Send" handler**

Run: `rg "executeRequest\(" src/features/http`. Locate the call site (likely `useHttpRequest.ts`).

- [ ] **Step 2: Replace direct call with `useRequestRunner.run('http', request)`**

```typescript
// in useHttpRequest.ts
import { useRequestRunner } from '@/features/registry/useRequestRunner';

const { run, abort } = useRequestRunner();

const send = useCallback(async () => {
  if (!activeTab) return;
  setLoading(true);
  try {
    const { response } = await run(activeTab.request, 'http');
    setResponse(response);
  } catch (err) {
    // ... existing error handling
  } finally {
    setLoading(false);
  }
}, [activeTab, run, setLoading, setResponse]);
```

- [ ] **Step 3: Run the existing tests**

Run: `npx vitest run src/features/http`
Expected: PASS — pipeline behavior unchanged.

- [ ] **Step 4: Manual smoke test in dev**

Run: `npm run dev`. Send an HTTP request, confirm history entry created and pre-request/test scripts ran.

- [ ] **Step 5: Commit**

```bash
git add src/features/http/
git commit -m "refactor(http): drive HTTP send through useRequestRunner via registry"
```

---

### Task 4.5: Register and migrate gRPC, GraphQL, WebSocket, SSE, MCP

**Strategy:** One protocol per commit. Each follows the Task 4.4 pattern. Streaming protocols (WS, SSE, gRPC streaming) need a slightly extended `runRequest` contract — return an `AsyncIterable<Response>` or similar. Define this once and reuse.

**Files (per protocol):**
- Create: `src/features/<x>/protocol.ts`
- Modify: `src/features/<x>/components/<X>RequestBuilder.tsx` (or `<X>Client.tsx`) — replace inline send with `useRequestRunner`
- Modify: `src/features/registry/bootstrap.ts` — add `register(xProtocol)`
- Modify: `src/features/registry/types.ts` — extend `runRequest` return type to allow streaming

- [ ] **Step 1: Extend `ProtocolModule` for streaming**

```typescript
// src/features/registry/types.ts
export type RunResultLike = Response | AsyncIterable<Response> | { response: Response; events: AsyncIterable<unknown> };

export interface ProtocolModule {
  // ... existing
  runRequest: (request: Request, ctx: RunContext) => Promise<RunResultLike>;
}
```

Update `useRequestRunner` to detect the shape and route accordingly (single Response vs. streaming).

- [ ] **Step 2: Add per-protocol module + migrate the Builder**

For each of `grpc`, `graphql`, `websocket`, `sse`, `mcp`:

1. Create `src/features/<x>/protocol.ts` exporting an `xProtocol: ProtocolModule`. The `runRequest` adapter wraps the existing client/manager.
2. Add the import + `register(xProtocol)` to `bootstrap.ts`.
3. In the Builder component, replace the inline send/connect handler with `useRequestRunner().run(request, '<x>')`.
4. Run `npx vitest run src/features/<x>` — expected PASS.
5. `npm run dev` smoke test of that protocol.
6. Commit per protocol: `git commit -m "refactor(<x>): drive <x> send through useRequestRunner"`.

For SSE/WS/MCP this also gives them history + scripts for the first time. Verify by sending one request and checking the History panel.

---

### Task 4.6: Consolidate auth — move shared parts into `features/auth/lib/`

**Files:**
- Move: `src/features/http/lib/applyAuthHeaders.ts` → `src/features/auth/lib/applyAuthHeaders.ts`
- Modify: `src/features/grpc/lib/grpcClient.ts:39-85` (`buildAuthMetadata`) — extract shared parts
- Create: `src/features/auth/lib/buildAuthCredential.ts` (if shared between HTTP headers and gRPC metadata)

- [ ] **Step 1: Move the file**

```bash
git mv src/features/http/lib/applyAuthHeaders.ts src/features/auth/lib/applyAuthHeaders.ts
```

- [ ] **Step 2: Update imports**

```bash
rg -l "from '@/features/http/lib/applyAuthHeaders'|features/http/lib/applyAuthHeaders" src
```

For each match, change to `'@/features/auth/lib/applyAuthHeaders'`.

- [ ] **Step 3: Extract gRPC `buildAuthMetadata` shared logic**

Read both `applyAuthHeaders.ts` and `grpcClient.ts:39-85`. Identify common code (Basic header construction, Bearer header construction, OAuth2 token reading). Extract into `src/features/auth/lib/buildAuthCredential.ts`:

```typescript
import type { AuthConfig } from '@/types';

export interface AuthCredential {
  /** Header name → value map. For HTTP these become headers; for gRPC, metadata entries. */
  headers: Record<string, string>;
  /** Optional: query params (api-key in=query) */
  params?: Record<string, string>;
}

export function buildAuthCredential(auth: AuthConfig | undefined): AuthCredential {
  if (!auth || auth.type === 'none') return { headers: {} };
  switch (auth.type) {
    case 'basic': {
      const { username = '', password = '' } = auth.basic ?? {};
      const token = btoa(`${username}:${password}`);
      return { headers: { Authorization: `Basic ${token}` } };
    }
    case 'bearer': {
      const t = auth.bearer?.token ?? '';
      return { headers: { Authorization: `Bearer ${t}` } };
    }
    case 'api-key': {
      const { key = '', value = '', in: where = 'header' } = auth.apiKey ?? {};
      return where === 'query'
        ? { headers: {}, params: { [key]: value } }
        : { headers: { [key]: value } };
    }
    case 'oauth2': {
      const t = auth.oauth2?.accessToken ?? '';
      const type = auth.oauth2?.tokenType ?? 'Bearer';
      return { headers: { Authorization: `${type} ${t}` } };
    }
    // digest, oauth1, aws-signature, ntlm, wsse: protocol-specific, leave to caller
    default: return { headers: {} };
  }
}
```

Then `applyAuthHeaders` and `buildAuthMetadata` both call `buildAuthCredential` for the shared types and only handle the protocol-specific ones inline.

- [ ] **Step 4: Add tests**

Create `src/features/auth/lib/__tests__/buildAuthCredential.test.ts` covering each branch.

- [ ] **Step 5: Run tests**

Run: `npx vitest run src/features/auth src/features/http src/features/grpc`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor(auth): consolidate shared auth credential building under features/auth"
```

---

### Task 4.7: Decompose `GrpcRequestBuilder.tsx`

**Why:** 1043 LOC, 16+ `useState`, inline validation + reflection + execution + scripts + history. With Task 4.4 in place, the runner is gone. Now break the rest into focused components.

**Files:**
- Modify: `src/features/grpc/components/GrpcRequestBuilder.tsx`
- Create: `src/features/grpc/components/GrpcMethodSelector.tsx`
- Create: `src/features/grpc/components/GrpcMessageEditor.tsx`
- Create: `src/features/grpc/hooks/useGrpcReflection.ts`
- Create: `src/features/grpc/lib/grpcValidation.ts`

- [ ] **Step 1: Extract the inline validators**

Move `validateUrl`/`validateService`/`validateMethod`/`validateMessage` (currently lines ~116-180) into `src/features/grpc/lib/grpcValidation.ts`. Add unit tests in a sibling `__tests__/grpcValidation.test.ts`.

- [ ] **Step 2: Extract reflection orchestration**

Lines ~184-300 of GrpcRequestBuilder become `useGrpcReflection(url)` — returns `{ services, methods, loading, error, refresh }`. Add tests.

- [ ] **Step 3: Extract the message editor**

The Monaco-based JSON message editor + sample/skeleton generation → `GrpcMessageEditor.tsx`. Should accept `{ value, onChange, methodSchema }`.

- [ ] **Step 4: Extract the method selector**

The service+method dropdown UI → `GrpcMethodSelector.tsx`.

- [ ] **Step 5: Wire the parent**

`GrpcRequestBuilder.tsx` becomes a coordinator: state held in `useRequestStore`, runner from `useRequestRunner`, children for sub-UIs. Should drop to ~200-300 LOC.

- [ ] **Step 6: Run tests + dev smoke**

Run: `npx vitest run src/features/grpc && npm run dev` and exercise unary + server-streaming + bidirectional gRPC. Confirm reflection-driven discovery still works.

- [ ] **Step 7: Commit (chunked — one per extraction)**

Each extraction is its own commit:
- `refactor(grpc): extract grpcValidation helpers`
- `refactor(grpc): extract useGrpcReflection hook`
- `refactor(grpc): extract GrpcMessageEditor component`
- `refactor(grpc): extract GrpcMethodSelector component`
- `refactor(grpc): slim GrpcRequestBuilder coordinator down to ~250 LOC`

---

### Task 4.8: Consolidate store locations

**Files:**
- Move: `src/store/useWebSocketStore.ts` → `src/features/websocket/store/useWebSocketStore.ts`

- [ ] **Step 1: Decide policy and document**

Add comment to `src/store/README.md` (create):

```markdown
# Store organization

- `src/store/`: cross-cutting state (collections, environments, settings,
  history, request-tabs, console).
- `src/features/<x>/store/`: protocol- or feature-specific state
  (HTTP cookies, WS connections, SSE connections, MCP sessions).
```

- [ ] **Step 2: Move and update imports**

```bash
git mv src/store/useWebSocketStore.ts src/features/websocket/store/useWebSocketStore.ts
mkdir -p src/features/websocket/store
rg -l "from '@/store/useWebSocketStore'" src | xargs sed -i '' "s#@/store/useWebSocketStore#@/features/websocket/store/useWebSocketStore#g"
```

(On Linux, drop the empty `''` after `-i`.)

- [ ] **Step 3: Run tests**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor(store): co-locate useWebSocketStore with feature module"
```

---

## Phase 5 — Type Safety and CI

### Task 5.1: Adopt `safeParseJSON` for persisted-state reads

**Files:**
- Modify: `src/lib/shared/dexie-storage.ts:131,333`
- Modify: `electron/main/window-manager.ts:30` (window-state file)
- Modify: `electron/main/request-logger.ts:53`
- Modify: `src/lib/shared/encryption.ts:184`
- Modify: `src/features/workflows/lib/variableExtractor.ts:8`

- [ ] **Step 1: Adopt in dexie-storage rehydration**

In `src/lib/shared/dexie-storage.ts:131`, find the `JSON.parse` and replace with a Zod-validated parse against the relevant store schema. If a permissive `z.unknown()` is fine for the rehydration boundary (zustand's `persist` will run the store-specific `migrate` next), at minimum guard with try/catch and dispatch the existing `QuotaExceededError`-style event for malformed data:

```typescript
let parsed: unknown;
try {
  parsed = JSON.parse(decrypted);
} catch (err) {
  console.error('[dexie-storage] rehydration JSON parse failed', err);
  return null;
}
```

- [ ] **Step 2: Define `LogEntrySchema` and use it in `request-logger.ts`**

In `electron/main/request-logger.ts`:

```typescript
import { z } from 'zod';
const LogEntrySchema = z.object({
  id: z.string(),
  timestamp: z.number(),
  // ... fields actually used
});

// Replace `JSON.parse(line) as LogEntry` with:
const parsed = LogEntrySchema.safeParse(JSON.parse(line));
if (!parsed.success) {
  console.warn('[request-logger] dropped malformed entry');
  continue;
}
return parsed.data;
```

- [ ] **Step 3: Same pattern in `window-manager.ts:30` (window state)**

```typescript
const WindowStateSchema = z.object({
  x: z.number().optional(),
  y: z.number().optional(),
  width: z.number(),
  height: z.number(),
  isMaximized: z.boolean().optional(),
});
// Replace JSON.parse(...) as WindowState with safeParse + fallback to defaults
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/shared/dexie-storage.ts electron/main/request-logger.ts electron/main/window-manager.ts
git commit -m "fix(types): validate JSON-parsed persisted state with Zod, fall back gracefully"
```

---

### Task 5.2: Flip `@typescript-eslint/no-explicit-any` to `error`

**Files:**
- Modify: `eslint.config.js:13-14`

- [ ] **Step 1: Count current `any` usage**

Run: `rg -c ": any|as any" src worker electron/main echo | sort -t: -k2 -n -r | head -20`
Capture the per-file counts.

- [ ] **Step 2: For each non-trivial offender, add a per-line disable with a TODO comment**

Don't try to fix all 92 escape hatches in one pass. Add `// eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(<your-name>): narrow this <reason>` above each, and file a follow-up issue.

- [ ] **Step 3: Flip the rule**

Edit `eslint.config.js:14`:

```javascript
'@typescript-eslint/no-explicit-any': 'error',
```

Remove the "Phase 2 will eliminate" comment.

- [ ] **Step 4: Run lint**

Run: `npm run lint`
Expected: PASS — every remaining `any` should now have a per-line disable.

- [ ] **Step 5: Commit**

```bash
git add eslint.config.js src worker electron echo
git commit -m "chore(lint): make no-explicit-any an error; remaining sites have per-line disables with TODOs"
```

---

### Task 5.3: Add `verify:opencollection-types` to CI

**Files:**
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Edit `ci.yml` validate job**

Insert after the `Lint` step (around line 43):

```yaml
      - name: Verify generated opencollection types are up-to-date
        run: npm run verify:opencollection-types
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: fail when generated opencollection types drift from schema"
```

---

### Task 5.4: Pilot `exactOptionalPropertyTypes: true` on `src/features/http`

**Why:** `exactOptionalPropertyTypes: false` is masking bugs. Doing it everywhere at once is too much; pilot one feature.

**Files:**
- Create: `src/features/http/tsconfig.json` (project reference)
- Modify: `tsconfig.json` (add reference)

- [ ] **Step 1: Add a feature-scoped tsconfig**

Create `src/features/http/tsconfig.json`:

```json
{
  "extends": "../../../tsconfig.base.json",
  "compilerOptions": {
    "exactOptionalPropertyTypes": true,
    "composite": true,
    "noEmit": true
  },
  "include": ["**/*.ts", "**/*.tsx"]
}
```

- [ ] **Step 2: Run the strict check**

Run: `npx tsc --noEmit -p src/features/http/tsconfig.json`
Expected: errors. Fix each (typically by switching `foo?: T | undefined` → `foo?: T` or being explicit about `undefined` vs missing).

- [ ] **Step 3: Add CI step**

Add to `.github/workflows/ci.yml` validate job, after main type-check:

```yaml
      - name: Type-check (HTTP feature, exactOptionalPropertyTypes)
        run: npx tsc --noEmit -p src/features/http/tsconfig.json
```

- [ ] **Step 4: Commit**

```bash
git add src/features/http/tsconfig.json .github/workflows/ci.yml src/features/http
git commit -m "chore(types): pilot exactOptionalPropertyTypes on src/features/http"
```

---

### Task 5.5: Narrow gRPC dynamic-method casts

**Files:**
- Modify: `electron/main/grpc-handler.ts:257,291,318,489,512,545`

- [ ] **Step 1: Add a helper**

At the top of `electron/main/grpc-handler.ts`:

```typescript
type GrpcCall = {
  on: (event: string, listener: (...args: unknown[]) => void) => GrpcCall;
  cancel?: () => void;
  end?: () => void;
  write?: (message: unknown) => void;
};

function invokeGrpcMethod(
  client: grpc.Client,
  method: string,
  args: unknown[]
): GrpcCall | { unary: true } {
  const fn = (client as unknown as Record<string, unknown>)[method];
  if (typeof fn !== 'function') {
    throw new Error(`gRPC client has no method "${method}"`);
  }
  const result = (fn as (...a: unknown[]) => unknown).apply(client, args);
  if (result && typeof result === 'object' && 'on' in result) {
    return result as GrpcCall;
  }
  return { unary: true };
}
```

- [ ] **Step 2: Replace each cast site with the helper**

Find each `as unknown as Record<string, (...args: unknown[]) => unknown>` site (lines 257, 291, 318, 489, 512, 545). Replace with `invokeGrpcMethod(grpcClient, method, [...])` and use the typed `GrpcCall` return.

- [ ] **Step 3: Add a test for the type-error case**

```typescript
it('throws clearly when method does not exist on client', () => {
  const fakeClient = {} as grpc.Client;
  expect(() => invokeGrpcMethod(fakeClient, 'nope', [])).toThrow(/no method "nope"/);
});
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run electron/main/__tests__/grpc-handler.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add electron/main/grpc-handler.ts electron/main/__tests__/grpc-handler.test.ts
git commit -m "refactor(grpc): typed helper for dynamic gRPC method invocation"
```

---

## Self-Review Notes

**Spec coverage:** All 19 issues from the original review map to a task above:
- Worker SSRF (redirect, IPv6, DNS, dev bypass, streamingMode, body validation): Tasks 1.1, 1.3, 1.4, 1.5, 1.2 (DNS rebind on Worker is acknowledged as needing auth gating in 1.4 — pure DoH-prefetch is out of scope).
- Electron IPC (rate limiter, senderFrame, file allowlist, gRPC traversal, deep-link): Tasks 2.1-2.5.
- Storage (response body, file-collection store, migrations, encryption, history limits): Tasks 3.1-3.5.
- Architecture (registry, runner, god-component, GraphQL duplication, auth dedup, store locations): Tasks 4.1-4.8.
- Type safety (safeParseJSON, any→error, CI verify, exactOptional pilot, grpc casts): Tasks 5.1-5.5.

**Placeholders:** Searched for "TBD", "implement later", "appropriate". None remain.

**Type/method consistency:** `useRequestRunner` returns `{ run, abort }` consistently in Tasks 4.3-4.5; `ProtocolModule.runRequest` signature extended in Task 4.5 with explicit migration of older modules; `createKeyedRateLimiter` shape `{ check, dispose, size }` consistent across Tasks 2.1.

**Out of scope (deferred to follow-up plan):**
- Active DoH pre-flight for Worker DNS rebinding (architecturally complex; auth-gating is the practical mitigation — see Task 1.4).
- Splitting `grpcClient.ts` (767 LOC) into transport/parser/auth modules.
- Splitting `requestExecutor.ts` (589 LOC) into config-builder + transport-adapter.
- Adding a sender-frame allowlist that includes preview hash routes.

---

## Execution recommendation

Plan complete and saved to `docs/superpowers/plans/2026-05-13-maintainability-hardening.md`.

**Two execution options:**

**1. Subagent-Driven (recommended)** — Fresh subagent per task with two-stage review between tasks. Best for the security-sensitive Phase 1-2 work where independent verification matters.

**2. Inline Execution** — Batch execution with checkpoints. Faster for the Phase 5 mechanical changes (lint flip, CI step add).

A reasonable split: Phases 1-2 subagent-driven (security-critical, want fresh eyes); Phases 3-5 inline (mostly mechanical refactor with strong test coverage).
