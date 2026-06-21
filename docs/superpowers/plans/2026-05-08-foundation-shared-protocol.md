# Foundation: Shared Protocol Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each protocol (HTTP, gRPC, MCP) is implemented once in `shared/protocol/` and consumed by both the Cloudflare Worker handler and the Electron IPC handler as thin adapters. Eliminates the SSRF-guard, header-policy, body-builder, and response-shaping duplication that exists today.

**Architecture:** Introduce a backend-agnostic `Fetcher` interface (`(req: NormalizedRequest) => Promise<NormalizedResponse>`) plus pure helpers for URL validation, header sanitisation, and body construction. Each backend supplies its own `Fetcher` (Worker uses native `fetch`; Electron wraps Node `http`/`https` retaining PAC, SOCKS, mTLS, and interceptors). The shared core takes a `RequestSpec`, validates and normalises it, calls the supplied Fetcher, and shapes the response. New protocols slot in as one shared module + two ~30-line adapters.

**Tech Stack:** TypeScript (strict, `noUncheckedIndexedAccess`), Vitest, no new runtime deps. Electron continues to use `@grpc/grpc-js` for gRPC reflection; Worker continues to speak Connect protocol.

---

## File structure

**Created:**

- `shared/protocol/types.ts` — `RequestSpec`, `NormalizedResponse`, `Fetcher`, `ProtocolError` discriminated union
- `shared/protocol/url-validation.ts` — unified SSRF guard (replaces both worker copy and Electron inline copy)
- `shared/protocol/url-validation.test.ts`
- `shared/protocol/header-policy.ts` — request/response header allow/deny lists
- `shared/protocol/header-policy.test.ts`
- `shared/protocol/body-builder.ts` — JSON / text / form-urlencoded / form-data / binary body construction (extracted from `worker/handlers/proxy.ts:64-113`)
- `shared/protocol/body-builder.test.ts`
- `shared/protocol/http-proxy.ts` — `executeHttpProxy(spec, fetcher)` shared core
- `shared/protocol/http-proxy.test.ts`
- `shared/protocol/grpc-status.ts` — moved verbatim from `worker/shared/grpc-status.ts`
- `shared/protocol/grpc-proxy.ts` — `executeGrpcProxy(spec, fetcher)`
- `shared/protocol/grpc-proxy.test.ts`
- `shared/protocol/mcp-proxy.ts` — `validateMcpSpec(spec, allowLocalhost)` (SSE reader stays per-backend; transport-specific)
- `shared/protocol/mcp-proxy.test.ts`

**Modified:**

- `tsconfig.base.json` — add `paths` and `baseUrl` for `@shared/*`
- `tsconfig.json` (root, renderer) — inherits paths
- `worker/tsconfig.json` — add `../shared/**/*.ts` to `include`
- `electron/tsconfig.json` — add `../shared/**/*.ts` to `include`, add path mapping
- `vite.config.mts` — add `@shared` alias to `resolve.alias`
- `vitest.config.ts` — add `@shared` alias and `shared/**/*.test.ts` to `include`
- `worker/handlers/proxy.ts` — collapse to ~50 LOC adapter
- `worker/handlers/grpc.ts` — collapse to ~50 LOC adapter
- `worker/handlers/mcp.ts` — collapse to ~70 LOC adapter (retains SSE reader since that's transport-specific)
- `worker/index.ts` — import paths only
- `electron/main/http-handler.ts` — keep PAC/SOCKS/interceptor/mTLS, delegate validation + sanitisation + body building + response shaping to shared
- `electron/main/grpc-handler.ts` — adapter
- `electron/main/mcp-handler.ts` — adapter

**Deleted (after migration completes):**

- `worker/shared/url-validation.ts`
- `worker/shared/grpc-status.ts`
- `worker/shared/constants.ts` if unused after migration
- The inline `isPrivateAddress` / `hostAllowsPrivateAddress` / `createSecureLookup` helpers in `electron/main/http-handler.ts:64-113` (moved to shared)

---

## Tasks

### Task 1: Wire up `shared/protocol/` directory and tsconfig paths

**Files:**

- Create: `shared/protocol/_smoke.ts`
- Create: `shared/protocol/_smoke.test.ts`
- Modify: `tsconfig.base.json`
- Modify: `worker/tsconfig.json:include`
- Modify: `electron/tsconfig.json:include`, `electron/tsconfig.json:compilerOptions`
- Modify: `vite.config.mts:resolve.alias`
- Modify: `vitest.config.ts:include`, `vitest.config.ts:resolve.alias`

- [ ] **Step 1: Write the smoke test**

Create `shared/protocol/_smoke.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { __sharedProtocolSmoke } from './_smoke';

describe('shared/protocol smoke', () => {
  it('is importable from the test runner', () => {
    expect(__sharedProtocolSmoke()).toBe(42);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:run -- shared/protocol/_smoke`
Expected: FAIL — `Cannot find module './_smoke'` or no tests collected.

- [ ] **Step 3: Create the placeholder module**

Create `shared/protocol/_smoke.ts`:

```ts
export function __sharedProtocolSmoke(): number {
  return 42;
}
```

- [ ] **Step 4: Update `tsconfig.base.json` to expose `@shared/*`**

Replace `tsconfig.base.json` with:

```json
{
  "compilerOptions": {
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "noImplicitOverride": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "baseUrl": ".",
    "paths": {
      "@shared/*": ["shared/*"]
    }
  }
}
```

Note: `baseUrl: "."` is relative to each _extending_ tsconfig, so the worker tsconfig (one level deep) and electron tsconfig need an override — handled in the next two steps.

- [ ] **Step 5: Update `worker/tsconfig.json`**

```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ESNext"],
    "types": ["@cloudflare/workers-types"],
    "noEmit": true,
    "isolatedModules": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": false,
    "baseUrl": "..",
    "paths": {
      "@shared/*": ["shared/*"]
    }
  },
  "include": ["**/*.ts", "../shared/**/*.ts"]
}
```

- [ ] **Step 6: Update `electron/tsconfig.json`**

```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": {
    "target": "ES2022",
    "module": "nodenext",
    "lib": ["ES2022", "DOM"],
    "outDir": "../dist/electron",
    "rootDir": "..",
    "moduleResolution": "nodenext",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "allowSyntheticDefaultImports": true,
    "types": ["node", "vitest/globals"],
    "baseUrl": "..",
    "paths": {
      "@shared/*": ["shared/*"]
    }
  },
  "include": ["**/*.ts", "../shared/**/*.ts"],
  "exclude": ["node_modules", "types"]
}
```

Note: `rootDir` widens from `.` to `..` because emitted output now needs to reflect the `shared/` tree. Verify in Step 9 that `dist/electron/main/main.js` still exists.

- [ ] **Step 7: Update `vite.config.mts`**

Read the current file first, then add `'@shared'` alongside existing aliases. Inside `resolve.alias`:

```ts
'@': path.resolve(__dirname, './src'),
'@shared': path.resolve(__dirname, './shared'),
```

- [ ] **Step 8: Update `vitest.config.ts`**

Modify `test.include` to add `'shared/**/*.{test,spec}.{ts,tsx}'` and `resolve.alias` to add `@shared`:

```ts
test: {
  // ...existing
  include: [
    'src/**/*.{test,spec}.{ts,tsx}',
    'tests/**/*.{test,spec}.{ts,tsx}',
    'electron/main/__tests__/**/*.{test,spec}.ts',
    'worker/**/__tests__/**/*.{test,spec}.ts',
    'shared/**/*.{test,spec}.{ts,tsx}',
  ],
  // ...existing
},
resolve: {
  alias: {
    '@': path.resolve(__dirname, './src'),
    '@shared': path.resolve(__dirname, './shared'),
    'cloudflare:sockets': path.resolve(__dirname, './tests/__mocks__/cloudflare-sockets.ts'),
  },
},
```

- [ ] **Step 9: Run tests and validate the build**

```bash
npm run test:run -- shared/protocol/_smoke
npx tsc --noEmit
npx tsc --noEmit -p worker/tsconfig.json
npx tsc --noEmit -p electron/tsconfig.json
```

Expected: smoke test PASSES; all three type-checks pass with zero errors. If the electron tsc complains about `outDir`/`rootDir`, accept the redirected output path — `dist/electron/electron/main/main.js` — and fix `package.json:main` and `electron-builder.json` paths in this same step before committing. Search for `dist/electron/main/main.js` in the repo and update each occurrence.

- [ ] **Step 10: Commit**

```bash
git add tsconfig.base.json tsconfig.json worker/tsconfig.json electron/tsconfig.json vite.config.mts vitest.config.ts shared/ package.json electron-builder.json
git commit -m "feat(foundation): wire up shared/protocol directory + @shared path alias"
```

---

### Task 2: Unified URL validation

**Files:**

- Create: `shared/protocol/url-validation.ts`
- Create: `shared/protocol/url-validation.test.ts`
- Reference: existing `worker/shared/url-validation.ts`, `electron/main/http-handler.ts:64-113`

The shared module must satisfy _both_ existing call sites. The Worker passes URL strings; the Electron handler uses the result both at request-build time and inside its DNS-resolved `lookup` callback. So we expose two functions: `validateURL(urlString, options)` (string-level) and `assertResolvedAddressAllowed(hostname, address, options)` (DNS-rebind guard for Node).

- [ ] **Step 1: Write the failing tests**

Create `shared/protocol/url-validation.test.ts`. Copy the entire test body from `worker/handlers/__tests__/url-validation.test.ts` so behaviour parity is locked in, then append the new DNS-rebind cases:

```ts
import { describe, it, expect } from 'vitest';
import { validateURL, assertResolvedAddressAllowed, isPrivateAddress } from './url-validation';

describe('validateURL', () => {
  it('accepts a public https URL', () => {
    expect(validateURL('https://api.example.com/v1', {}).valid).toBe(true);
  });

  it('rejects ftp:// schemes', () => {
    const r = validateURL('ftp://example.com', {});
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/scheme/);
  });

  it('rejects 169.254.169.254 (cloud metadata) by default', () => {
    expect(validateURL('http://169.254.169.254/latest/meta-data', {}).valid).toBe(false);
  });

  it('rejects metadata.google.internal by default', () => {
    expect(validateURL('http://metadata.google.internal/', {}).valid).toBe(false);
  });

  it('rejects RFC1918 ranges by default', () => {
    expect(validateURL('http://10.0.0.1/', {}).valid).toBe(false);
    expect(validateURL('http://192.168.1.1/', {}).valid).toBe(false);
    expect(validateURL('http://172.20.0.1/', {}).valid).toBe(false);
  });

  it('allows localhost only when allowLocalhost: true', () => {
    expect(validateURL('http://localhost:8080', {}).valid).toBe(false);
    expect(validateURL('http://localhost:8080', { allowLocalhost: true }).valid).toBe(true);
  });

  it('allowLocalhost does NOT also unblock RFC1918', () => {
    expect(validateURL('http://10.0.0.1/', { allowLocalhost: true }).valid).toBe(false);
  });

  it('rejects URLs over 2048 chars', () => {
    const longUrl = 'https://example.com/' + 'a'.repeat(3000);
    expect(validateURL(longUrl, {}).valid).toBe(false);
  });

  it('warns on URLs containing credentials', () => {
    const r = validateURL('https://user:pass@example.com/', {});
    expect(r.valid).toBe(true);
    expect(r.warnings?.some((w) => /credentials/i.test(w))).toBe(true);
  });
});

describe('assertResolvedAddressAllowed', () => {
  it('throws if a public hostname resolves to a private IP (DNS rebind)', () => {
    expect(() => assertResolvedAddressAllowed('attacker.example.com', '127.0.0.1', {})).toThrow(
      /private/
    );
    expect(() =>
      assertResolvedAddressAllowed('attacker.example.com', '169.254.169.254', {})
    ).toThrow(/private/);
  });

  it('does not throw if hostname is allowed-private and address is private', () => {
    expect(() =>
      assertResolvedAddressAllowed('localhost', '127.0.0.1', { allowLocalhost: true })
    ).not.toThrow();
  });

  it('does not throw on a normal public address', () => {
    expect(() =>
      assertResolvedAddressAllowed('api.example.com', '93.184.216.34', {})
    ).not.toThrow();
  });
});

describe('isPrivateAddress', () => {
  it('identifies RFC1918', () => {
    expect(isPrivateAddress('10.0.0.1')).toBe(true);
    expect(isPrivateAddress('192.168.1.1')).toBe(true);
    expect(isPrivateAddress('172.20.0.1')).toBe(true);
    expect(isPrivateAddress('8.8.8.8')).toBe(false);
  });

  it('identifies link-local', () => {
    expect(isPrivateAddress('169.254.169.254')).toBe(true);
  });

  it('identifies IPv6 loopback and unique-local', () => {
    expect(isPrivateAddress('::1')).toBe(true);
    expect(isPrivateAddress('fc00::1')).toBe(true);
    expect(isPrivateAddress('fe80::1')).toBe(true);
    expect(isPrivateAddress('2606:4700:4700::1111')).toBe(false);
  });

  it('strips IPv4-mapped IPv6 prefix', () => {
    expect(isPrivateAddress('::ffff:10.0.0.1')).toBe(true);
    expect(isPrivateAddress('::ffff:8.8.8.8')).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:run -- shared/protocol/url-validation`
Expected: FAIL — `Cannot find module './url-validation'`.

- [ ] **Step 3: Implement the module**

Create `shared/protocol/url-validation.ts`. Merge logic from both existing copies; the worker version's `isPrivateAddress` is missing carrier-grade-NAT (`100.64/10`) which the Electron version covers, so include it. Final implementation:

```ts
const PRIVATE_IPV4_RANGES: Array<RegExp> = [
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\./,
  /^0\./,
];

const BLOCKED_HOSTNAMES = [
  'localhost',
  'local',
  'internal',
  'metadata',
  'metadata.google.internal',
  '169.254.169.254',
  'instance-data',
  'kubernetes',
  'kubernetes.default',
  'kubernetes.default.svc',
];

const ALLOWED_SCHEMES = ['http:', 'https:'];

export interface URLValidationResult {
  valid: boolean;
  error?: string;
  warnings?: string[];
}

export interface URLValidationOptions {
  allowPrivateIPs?: boolean;
  allowLocalhost?: boolean;
  allowedSchemes?: string[];
  blockedHostnames?: string[];
  maxUrlLength?: number;
}

function stripV4MappedPrefix(addr: string): string {
  return addr.startsWith('::ffff:') ? addr.slice(7) : addr;
}

export function isPrivateAddress(hostname: string): boolean {
  const normalized = stripV4MappedPrefix(hostname);

  if (normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1') {
    return true;
  }

  for (const re of PRIVATE_IPV4_RANGES) {
    if (re.test(normalized)) return true;
  }

  const lower = normalized.toLowerCase();
  if (lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80:')) {
    return true;
  }

  return false;
}

export function validateURL(
  urlString: string,
  options: URLValidationOptions = {}
): URLValidationResult {
  const {
    allowPrivateIPs = false,
    allowLocalhost = false,
    allowedSchemes = ALLOWED_SCHEMES,
    blockedHostnames = BLOCKED_HOSTNAMES,
    maxUrlLength = 2048,
  } = options;

  const warnings: string[] = [];

  if (urlString.length > maxUrlLength) {
    return { valid: false, error: `URL exceeds maximum length of ${maxUrlLength} characters` };
  }

  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    return { valid: false, error: 'Invalid URL format' };
  }

  if (!allowedSchemes.includes(url.protocol)) {
    return { valid: false, error: `Invalid URL scheme. Allowed: ${allowedSchemes.join(', ')}` };
  }

  const hostname = url.hostname.toLowerCase();

  if (
    !allowLocalhost &&
    (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1')
  ) {
    return { valid: false, error: 'Localhost URLs are not allowed' };
  }

  for (const blocked of blockedHostnames) {
    const b = blocked.toLowerCase();
    if (allowLocalhost && (b === 'localhost' || b === '127.0.0.1')) continue;
    if (hostname === b || hostname.endsWith('.' + b)) {
      return { valid: false, error: `Hostname "${hostname}" is blocked for security reasons` };
    }
  }

  if (!allowPrivateIPs) {
    const isLoopback = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
    if (!(allowLocalhost && isLoopback) && isPrivateAddress(hostname)) {
      return { valid: false, error: `Private/internal IP addresses are not allowed: ${hostname}` };
    }
  }

  if (url.username || url.password) {
    warnings.push('URL contains credentials which may be logged or exposed');
  }

  if (url.pathname.includes('data:') || url.pathname.includes('javascript:')) {
    return { valid: false, error: 'URL path contains potentially malicious content' };
  }

  return { valid: true, warnings: warnings.length > 0 ? warnings : undefined };
}

export interface ResolvedAddressOptions {
  allowLocalhost?: boolean;
}

export function assertResolvedAddressAllowed(
  hostname: string,
  address: string,
  options: ResolvedAddressOptions = {}
): void {
  if (!isPrivateAddress(address)) return;

  const lower = hostname.toLowerCase();
  const isAllowedLocalhost =
    options.allowLocalhost && (lower === 'localhost' || lower.endsWith('.localhost'));

  if (isAllowedLocalhost) return;

  throw new Error(
    `DNS resolution for ${hostname} returned private address ${address}; refusing to connect`
  );
}
```

- [ ] **Step 4: Run tests to verify all pass**

Run: `npm run test:run -- shared/protocol/url-validation`
Expected: all PASS (worker-parity cases plus new DNS-rebind cases).

- [ ] **Step 5: Switch the worker to import from shared, keep the old file as a re-export shim**

Edit `worker/shared/url-validation.ts` to re-export from shared:

```ts
export {
  validateURL,
  isPrivateAddress,
  type URLValidationResult,
  type URLValidationOptions,
} from '@shared/protocol/url-validation';
```

(Shim, not delete — Task 11 deletes it once all imports are updated and verified.)

- [ ] **Step 6: Run worker tests**

```bash
npm run test:run -- worker/
npx tsc --noEmit -p worker/tsconfig.json
```

Expected: PASS, no TS errors.

- [ ] **Step 7: Migrate Electron's `createSecureLookup` to use the shared assertion**

In `electron/main/http-handler.ts:96-113`, replace the body of `createSecureLookup` so it calls `assertResolvedAddressAllowed` instead of inlining the check. Delete the helpers `isPrivateAddress` (line 64) and `hostAllowsPrivateAddress` (line 90) — they're now in shared.

Diff sketch:

```ts
// at top of file:
import { assertResolvedAddressAllowed } from '@shared/protocol/url-validation';

// delete: function isPrivateAddress(...) { ... }
// delete: function hostAllowsPrivateAddress(...) { ... }

function createSecureLookup(
  hostname: string,
  allowLocalhost: boolean
): NonNullable<http.RequestOptions['lookup']> {
  return (lookupHostname, options, callback) => {
    dns.lookup(lookupHostname, options, (error, address, family) => {
      if (error) {
        callback(error, address as never, family as never);
        return;
      }
      const addresses = Array.isArray(address) ? address : [{ address, family }];
      try {
        for (const entry of addresses) {
          assertResolvedAddressAllowed(hostname, entry.address, { allowLocalhost });
        }
        callback(null, address as never, family as never);
      } catch (err) {
        callback(err as Error, address as never, family as never);
      }
    });
  };
}
```

Update call sites to pass `allowLocalhost` — for now, hardcode `true` to preserve current behaviour; Task 12 plumbs it through configuration.

- [ ] **Step 8: Run Electron tests**

```bash
npm run test:run -- electron/
npx tsc --noEmit -p electron/tsconfig.json
```

Expected: PASS, no TS errors.

- [ ] **Step 9: Commit**

```bash
git add shared/protocol/url-validation.ts shared/protocol/url-validation.test.ts \
        worker/shared/url-validation.ts electron/main/http-handler.ts
git commit -m "feat(foundation): unify URL validation in shared/protocol"
```

---

### Task 3: Unified header policy

**Files:**

- Create: `shared/protocol/header-policy.ts`
- Create: `shared/protocol/header-policy.test.ts`
- Modify: `worker/handlers/proxy.ts:7-26` (will reference shared in Task 7)

The denylists are duplicated across `worker/handlers/proxy.ts:7`, `worker/handlers/grpc.ts:6`, and `worker/handlers/mcp.ts:18`. Centralise.

- [ ] **Step 1: Write the failing tests**

Create `shared/protocol/header-policy.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  sanitizeRequestHeaders,
  sanitizeResponseHeaders,
  REQUEST_DENY,
  RESPONSE_DENY,
} from './header-policy';

describe('sanitizeRequestHeaders', () => {
  it('strips hop-by-hop headers', () => {
    const out = sanitizeRequestHeaders({
      Host: 'attacker.example.com',
      Connection: 'close',
      Authorization: 'Bearer xyz',
      'X-Custom': 'ok',
    });
    expect(out).toEqual({
      Authorization: 'Bearer xyz',
      'X-Custom': 'ok',
    });
  });

  it('is case-insensitive on header names', () => {
    const out = sanitizeRequestHeaders({ HOST: 'foo' });
    expect(out).toEqual({});
  });

  it('strips Cookie when policy is "mcp"', () => {
    const out = sanitizeRequestHeaders({ Cookie: 'session=1', Authorization: 'Bearer x' }, 'mcp');
    expect(out).toEqual({ Authorization: 'Bearer x' });
  });

  it('keeps Cookie under default policy', () => {
    const out = sanitizeRequestHeaders({ Cookie: 'session=1' });
    expect(out).toEqual({ Cookie: 'session=1' });
  });
});

describe('sanitizeResponseHeaders', () => {
  it('strips hop-by-hop response headers', () => {
    const out = sanitizeResponseHeaders({
      'Transfer-Encoding': 'chunked',
      'Content-Type': 'application/json',
      Trailer: 'Expires',
    });
    expect(out).toEqual({ 'Content-Type': 'application/json' });
  });
});

describe('exported deny lists', () => {
  it('REQUEST_DENY contains expected entries', () => {
    expect(REQUEST_DENY.has('host')).toBe(true);
    expect(REQUEST_DENY.has('content-length')).toBe(true);
  });
  it('RESPONSE_DENY contains expected entries', () => {
    expect(RESPONSE_DENY.has('transfer-encoding')).toBe(true);
    expect(RESPONSE_DENY.has('connection')).toBe(true);
  });
});
```

- [ ] **Step 2: Run to fail**

Run: `npm run test:run -- shared/protocol/header-policy`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

Create `shared/protocol/header-policy.ts`:

```ts
export const REQUEST_DENY = new Set<string>([
  'host',
  'connection',
  'content-length',
  'transfer-encoding',
  'upgrade',
  'proxy-connection',
  'proxy-authenticate',
  'proxy-authorization',
]);

export const REQUEST_DENY_MCP = new Set<string>([...REQUEST_DENY, 'cookie']);

export const RESPONSE_DENY = new Set<string>([
  'transfer-encoding',
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'trailer',
  'upgrade',
]);

export type RequestPolicy = 'default' | 'mcp';

export function sanitizeRequestHeaders(
  input: Record<string, string> | undefined,
  policy: RequestPolicy = 'default'
): Record<string, string> {
  if (!input) return {};
  const deny = policy === 'mcp' ? REQUEST_DENY_MCP : REQUEST_DENY;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(input)) {
    if (!deny.has(k.toLowerCase())) out[k] = v;
  }
  return out;
}

export function sanitizeResponseHeaders(
  input: Record<string, string | string[]> | Headers
): Record<string, string> {
  const out: Record<string, string> = {};
  const visit = (key: string, value: string) => {
    if (!RESPONSE_DENY.has(key.toLowerCase())) out[key] = value;
  };
  if (input instanceof Headers) {
    input.forEach((v, k) => visit(k, v));
    return out;
  }
  for (const [k, v] of Object.entries(input)) {
    visit(k, Array.isArray(v) ? v.join(', ') : v);
  }
  return out;
}
```

- [ ] **Step 4: Run tests to pass**

Run: `npm run test:run -- shared/protocol/header-policy`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add shared/protocol/header-policy.ts shared/protocol/header-policy.test.ts
git commit -m "feat(foundation): add shared header-policy module"
```

---

### Task 4: Unified body builder

**Files:**

- Create: `shared/protocol/body-builder.ts`
- Create: `shared/protocol/body-builder.test.ts`
- Reference: `worker/handlers/proxy.ts:55-113`

- [ ] **Step 1: Write the failing tests**

Create `shared/protocol/body-builder.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildRequestBody } from './body-builder';

describe('buildRequestBody', () => {
  it('returns empty body for type "none"', () => {
    expect(buildRequestBody({ bodyType: 'none' })).toEqual({
      body: undefined,
      contentType: undefined,
    });
  });

  it('returns JSON body with content-type', () => {
    const r = buildRequestBody({ bodyType: 'json', data: '{"a":1}' });
    expect(r.body).toBe('{"a":1}');
    expect(r.contentType).toBe('application/json');
  });

  it('returns text body', () => {
    const r = buildRequestBody({ bodyType: 'text', data: 'hello' });
    expect(r.body).toBe('hello');
    expect(r.contentType).toBe('text/plain');
  });

  it('builds form-urlencoded from formData', () => {
    const r = buildRequestBody({
      bodyType: 'form-urlencoded',
      formData: [
        { name: 'a', value: '1' },
        { name: 'b', value: 'two & three' },
      ],
    });
    expect(r.contentType).toBe('application/x-www-form-urlencoded');
    expect(r.body).toBe('a=1&b=two+%26+three');
  });

  it('builds multipart form-data with file fields', () => {
    const r = buildRequestBody({
      bodyType: 'form-data',
      formData: [
        { name: 'name', value: 'Alice' },
        { name: 'avatar', value: btoa('PNGDATA'), filename: 'a.png', contentType: 'image/png' },
      ],
    });
    expect(r.body).toBeInstanceOf(FormData);
    expect(r.contentType).toBeUndefined(); // FormData sets its own boundary
    const fd = r.body as FormData;
    expect(fd.get('name')).toBe('Alice');
    const file = fd.get('avatar') as File;
    expect(file).toBeInstanceOf(Blob);
    expect(file.type).toBe('image/png');
  });

  it('decodes base64 binary body', () => {
    const r = buildRequestBody({ bodyType: 'binary', data: btoa('hi') });
    expect(r.contentType).toBe('application/octet-stream');
    expect(r.body).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(r.body as Uint8Array)).toBe('hi');
  });
});
```

- [ ] **Step 2: Run to fail**

Run: `npm run test:run -- shared/protocol/body-builder`
Expected: FAIL.

- [ ] **Step 3: Implement**

Move the body-builder logic from `worker/handlers/proxy.ts:55-113` verbatim into `shared/protocol/body-builder.ts`, exposing `buildRequestBody` as a single object-arg function:

```ts
export interface FormField {
  name: string;
  value: string;
  filename?: string;
  contentType?: string;
}

export type BodyType = 'none' | 'json' | 'text' | 'form-urlencoded' | 'form-data' | 'binary';

export interface BuildRequestBodyArgs {
  bodyType?: BodyType;
  data?: string;
  formData?: FormField[];
}

export interface BuiltRequestBody {
  body: BodyInit | undefined;
  contentType: string | undefined;
}

function base64ToUint8Array(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function buildRequestBody(args: BuildRequestBodyArgs): BuiltRequestBody {
  const { bodyType, data, formData } = args;

  if (!bodyType || bodyType === 'none') {
    return { body: undefined, contentType: undefined };
  }

  switch (bodyType) {
    case 'json':
      return { body: data, contentType: 'application/json' };
    case 'text':
      return { body: data, contentType: 'text/plain' };
    case 'form-urlencoded': {
      const params = new URLSearchParams();
      if (formData) {
        for (const field of formData) params.append(field.name, field.value);
      } else if (data) {
        return { body: data, contentType: 'application/x-www-form-urlencoded' };
      }
      return { body: params.toString(), contentType: 'application/x-www-form-urlencoded' };
    }
    case 'form-data': {
      const fd = new FormData();
      if (formData) {
        for (const field of formData) {
          if (field.filename) {
            const bytes = base64ToUint8Array(field.value);
            const blob = new Blob([bytes], {
              type: field.contentType || 'application/octet-stream',
            });
            fd.append(field.name, blob, field.filename);
          } else {
            fd.append(field.name, field.value);
          }
        }
      }
      return { body: fd, contentType: undefined };
    }
    case 'binary':
      if (data) return { body: base64ToUint8Array(data), contentType: 'application/octet-stream' };
      return { body: undefined, contentType: undefined };
  }
}
```

- [ ] **Step 4: Run tests to pass**

Run: `npm run test:run -- shared/protocol/body-builder`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add shared/protocol/body-builder.ts shared/protocol/body-builder.test.ts
git commit -m "feat(foundation): extract body-builder to shared/protocol"
```

---

### Task 5: Define `Fetcher` interface and shared types

**Files:**

- Create: `shared/protocol/types.ts`

This file is types only (no tests; tsc validates it).

- [ ] **Step 1: Create the types file**

```ts
import type { BodyType, FormField } from './body-builder';

export interface RequestSpec {
  method: string;
  url: string;
  headers?: Record<string, string>;
  params?: Record<string, string>;
  bodyType?: BodyType;
  data?: string;
  formData?: FormField[];
  timeout?: number;
}

export interface NormalizedResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  size: number;
}

export interface FetcherRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: BodyInit | undefined;
  signal: AbortSignal;
  /**
   * Hook for backend-specific extensions (Electron passes its proxy / mTLS / interceptor config
   * through here without the shared core caring). Worker fetcher ignores it.
   */
  backendOptions?: unknown;
}

export interface FetcherResponse {
  status: number;
  statusText: string;
  headers: Headers | Record<string, string | string[]>;
  /** Buffered text body. Streaming responses are out of scope for Plan 1; covered in Plan 4. */
  text: () => Promise<string>;
  contentLengthHeader: string | null;
}

export type Fetcher = (req: FetcherRequest) => Promise<FetcherResponse>;

export interface ProtocolErrorPayload {
  error: string;
  status?: number;
}

export type ExecuteResult =
  | { ok: true; response: NormalizedResponse }
  | { ok: false; status: number; payload: ProtocolErrorPayload };
```

- [ ] **Step 2: Type-check**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add shared/protocol/types.ts
git commit -m "feat(foundation): add Fetcher interface and shared protocol types"
```

---

### Task 6: HTTP proxy core (`executeHttpProxy`)

**Files:**

- Create: `shared/protocol/http-proxy.ts`
- Create: `shared/protocol/http-proxy.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `shared/protocol/http-proxy.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { executeHttpProxy, MAX_RESPONSE_SIZE } from './http-proxy';
import type { Fetcher } from './types';

const passingValidator = (url: string) => ({ valid: url.startsWith('https://') });

function makeFetcher(
  text: string,
  status = 200,
  headers: Record<string, string> = { 'content-type': 'application/json' },
  contentLength: string | null = String(text.length)
): Fetcher {
  return vi.fn(async () => ({
    status,
    statusText: 'OK',
    headers,
    text: async () => text,
    contentLengthHeader: contentLength,
  }));
}

describe('executeHttpProxy', () => {
  it('rejects disallowed methods', async () => {
    const fetcher = makeFetcher('');
    const r = await executeHttpProxy(
      { method: 'TRACE', url: 'https://example.com/', timeout: 1000 },
      fetcher,
      { allowLocalhost: false }
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects invalid URL', async () => {
    const fetcher = makeFetcher('');
    const r = await executeHttpProxy(
      { method: 'GET', url: 'http://10.0.0.1/', timeout: 1000 },
      fetcher,
      { allowLocalhost: false }
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
  });

  it('passes sanitized headers to the fetcher', async () => {
    const fetcher = vi.fn(makeFetcher('{"x":1}'));
    await executeHttpProxy(
      {
        method: 'GET',
        url: 'https://example.com/',
        headers: { Host: 'attacker.com', 'X-OK': 'yes' },
        timeout: 1000,
      },
      fetcher,
      { allowLocalhost: false }
    );
    const arg = fetcher.mock.calls[0]?.[0];
    expect(arg?.headers.Host).toBeUndefined();
    expect(arg?.headers['X-OK']).toBe('yes');
  });

  it('returns the body and sanitized response headers', async () => {
    const fetcher = makeFetcher('{"x":1}', 201, {
      'content-type': 'application/json',
      'transfer-encoding': 'chunked',
    });
    const r = await executeHttpProxy(
      { method: 'GET', url: 'https://example.com/', timeout: 1000 },
      fetcher,
      { allowLocalhost: false }
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.response.status).toBe(201);
      expect(r.response.body).toBe('{"x":1}');
      expect(r.response.headers['content-type']).toBe('application/json');
      expect(r.response.headers['transfer-encoding']).toBeUndefined();
    }
  });

  it('rejects responses larger than MAX_RESPONSE_SIZE by content-length', async () => {
    const fetcher = makeFetcher('', 200, {}, String(MAX_RESPONSE_SIZE + 1));
    const r = await executeHttpProxy(
      { method: 'GET', url: 'https://example.com/', timeout: 1000 },
      fetcher,
      { allowLocalhost: false }
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(413);
  });

  it('rejects responses larger than MAX_RESPONSE_SIZE by buffered text', async () => {
    const big = 'x'.repeat(MAX_RESPONSE_SIZE + 1);
    const fetcher = makeFetcher(big, 200, {}, null);
    const r = await executeHttpProxy(
      { method: 'GET', url: 'https://example.com/', timeout: 1000 },
      fetcher,
      { allowLocalhost: false }
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(413);
  });

  it('aborts on timeout', async () => {
    const fetcher: Fetcher = vi.fn(
      (req) =>
        new Promise((_, reject) => {
          req.signal.addEventListener('abort', () => reject(new Error('aborted')));
        })
    );
    const r = await executeHttpProxy(
      { method: 'GET', url: 'https://example.com/', timeout: 50 },
      fetcher,
      { allowLocalhost: false }
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(504);
  });

  it('appends params to the URL', async () => {
    const fetcher = vi.fn(makeFetcher('{}'));
    await executeHttpProxy(
      {
        method: 'GET',
        url: 'https://example.com/foo',
        params: { a: '1', b: 'two three' },
        timeout: 1000,
      },
      fetcher,
      { allowLocalhost: false }
    );
    expect(fetcher.mock.calls[0]?.[0]?.url).toBe('https://example.com/foo?a=1&b=two+three');
  });
});
```

Use the literal value `10 * 1024 * 1024` for `MAX_RESPONSE_SIZE` to match the existing constant in `worker/shared/constants.ts`.

- [ ] **Step 2: Run to fail**

Run: `npm run test:run -- shared/protocol/http-proxy`
Expected: FAIL.

- [ ] **Step 3: Implement**

Create `shared/protocol/http-proxy.ts`:

```ts
import { validateURL } from './url-validation';
import { sanitizeRequestHeaders, sanitizeResponseHeaders } from './header-policy';
import { buildRequestBody } from './body-builder';
import type { Fetcher, RequestSpec, ExecuteResult } from './types';

export const MAX_RESPONSE_SIZE = 10 * 1024 * 1024;
const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD']);

export interface ExecuteHttpProxyOptions {
  allowLocalhost: boolean;
}

export async function executeHttpProxy(
  spec: RequestSpec,
  fetcher: Fetcher,
  options: ExecuteHttpProxyOptions
): Promise<ExecuteResult> {
  const method = spec.method.toUpperCase();

  if (!ALLOWED_METHODS.has(method)) {
    return { ok: false, status: 400, payload: { error: `Method ${spec.method} is not allowed` } };
  }

  const validation = validateURL(spec.url, {
    allowPrivateIPs: false,
    allowLocalhost: options.allowLocalhost,
  });
  if (!validation.valid) {
    return { ok: false, status: 400, payload: { error: `Invalid URL: ${validation.error}` } };
  }

  const targetUrl = new URL(spec.url);
  if (spec.params) {
    for (const [k, v] of Object.entries(spec.params)) targetUrl.searchParams.append(k, v);
  }

  const headers = sanitizeRequestHeaders(spec.headers);
  const { body, contentType } = buildRequestBody({
    bodyType: spec.bodyType,
    data: spec.data,
    formData: spec.formData,
  });

  if (contentType && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
    headers['Content-Type'] = contentType;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), spec.timeout ?? 30_000);

  try {
    const finalBody = !['GET', 'HEAD'].includes(method) ? body : undefined;
    const response = await fetcher({
      url: targetUrl.toString(),
      method,
      headers,
      body: finalBody,
      signal: controller.signal,
    });

    if (response.contentLengthHeader && Number(response.contentLengthHeader) > MAX_RESPONSE_SIZE) {
      return {
        ok: false,
        status: 413,
        payload: { error: `Response too large (max ${MAX_RESPONSE_SIZE / 1024 / 1024}MB)` },
      };
    }

    const text = await response.text();
    if (text.length > MAX_RESPONSE_SIZE) {
      return {
        ok: false,
        status: 413,
        payload: { error: `Response too large (max ${MAX_RESPONSE_SIZE / 1024 / 1024}MB)` },
      };
    }

    return {
      ok: true,
      response: {
        status: response.status,
        statusText: response.statusText,
        headers: sanitizeResponseHeaders(response.headers),
        body: text,
        size: text.length,
      },
    };
  } catch (err) {
    if (controller.signal.aborted) {
      return {
        ok: false,
        status: 504,
        payload: { error: `Request timeout after ${spec.timeout ?? 30_000}ms` },
      };
    }
    const message = err instanceof Error ? err.message : 'Proxy request failed';
    return { ok: false, status: 502, payload: { error: `Proxy request failed: ${message}` } };
  } finally {
    clearTimeout(timer);
  }
}
```

- [ ] **Step 4: Run tests to pass**

Run: `npm run test:run -- shared/protocol/http-proxy`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add shared/protocol/http-proxy.ts shared/protocol/http-proxy.test.ts
git commit -m "feat(foundation): add executeHttpProxy shared core"
```

---

### Task 7: Migrate worker HTTP proxy handler to use shared core

**Files:**

- Modify: `worker/handlers/proxy.ts`
- Reference: existing tests `worker/handlers/__tests__/proxy.test.ts` must still pass.

This task is a refactor — no behaviour change. Tests are the regression guard.

- [ ] **Step 1: Run existing worker proxy tests as a baseline**

```bash
npm run test:run -- worker/handlers/__tests__/proxy
```

Capture the pass/fail summary; you will compare in Step 5.

- [ ] **Step 2: Replace `worker/handlers/proxy.ts` with the adapter**

```ts
import type { Context } from 'hono';
import type { Env } from '../index';
import { executeHttpProxy } from '@shared/protocol/http-proxy';
import type { Fetcher } from '@shared/protocol/types';
import { httpsViaConnectProxy, httpViaProxy } from '../shared/tcp-proxy';
import { validateURL } from '@shared/protocol/url-validation';

interface UpstreamProxyConfig {
  host: string;
  port: number;
  auth?: { username: string; password: string };
}

interface ProxyRequestBody {
  method: string;
  url: string;
  headers?: Record<string, string>;
  params?: Record<string, string>;
  bodyType?: 'json' | 'text' | 'form-urlencoded' | 'form-data' | 'binary' | 'none';
  data?: string;
  formData?: { name: string; value: string; filename?: string; contentType?: string }[];
  timeout?: number;
  upstreamProxy?: UpstreamProxyConfig;
}

function buildFetcher(isDev: boolean, upstream: UpstreamProxyConfig | undefined): Fetcher {
  return async (req) => {
    let response: Response;
    if (upstream) {
      if (!/^[a-zA-Z0-9.\-[\]:]+$/.test(upstream.host)) {
        throw new Error('Invalid proxy host: contains illegal characters');
      }
      const proxyValidation = validateURL(`http://${upstream.host}:${upstream.port}`, {
        allowPrivateIPs: false,
        allowLocalhost: isDev,
      });
      if (!proxyValidation.valid) {
        throw new Error(`Invalid upstream proxy: ${proxyValidation.error}`);
      }
      const targetUrl = new URL(req.url);
      const init: RequestInit = {
        method: req.method,
        headers: req.headers,
        signal: req.signal,
        redirect: 'follow',
      };
      if (req.body !== undefined) init.body = req.body;
      response =
        targetUrl.protocol === 'https:'
          ? await httpsViaConnectProxy(targetUrl, upstream, init, req.signal)
          : await httpViaProxy(targetUrl, upstream, init, req.signal);
    } else {
      const init: RequestInit = {
        method: req.method,
        headers: req.headers,
        signal: req.signal,
        redirect: 'follow',
      };
      if (req.body !== undefined) init.body = req.body;
      response = await fetch(req.url, init);
    }
    return {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
      text: () => response.text(),
      contentLengthHeader: response.headers.get('content-length'),
    };
  };
}

export async function proxy(c: Context<{ Bindings: Env }>) {
  const isDev = c.env.ENVIRONMENT === 'development';
  let body: ProxyRequestBody;
  try {
    body = await c.req.json<ProxyRequestBody>();
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return c.json({ error: `Proxy error: ${message}` }, 500);
  }

  const result = await executeHttpProxy(
    {
      method: body.method,
      url: body.url,
      headers: body.headers,
      params: body.params,
      bodyType: body.bodyType,
      data: body.data,
      formData: body.formData,
      timeout: body.timeout,
    },
    buildFetcher(isDev, body.upstreamProxy),
    { allowLocalhost: isDev }
  );

  if (!result.ok) {
    return c.json(result.payload, result.status as 400 | 413 | 502 | 504);
  }
  return c.json(result.response);
}
```

- [ ] **Step 3: Run worker proxy tests, expect identical pass/fail to baseline**

```bash
npm run test:run -- worker/handlers/__tests__/proxy
```

Expected: same number of tests pass as in Step 1. If any newly fail, the adapter has changed observable behaviour — investigate and fix the adapter (do not weaken tests).

- [ ] **Step 4: Type-check the worker**

```bash
npx tsc --noEmit -p worker/tsconfig.json
```

Expected: zero errors.

- [ ] **Step 5: Run full validate**

```bash
npm run validate
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add worker/handlers/proxy.ts
git commit -m "refactor(worker): collapse proxy.ts to shared/protocol adapter"
```

---

### Task 8: Migrate Electron HTTP handler to use shared core

**Files:**

- Modify: `electron/main/http-handler.ts`

This is the most subtle task. Electron retains PAC, SOCKS, mTLS, interceptors, and manual redirect handling. The shared core handles validation, header sanitisation, body building, response sanitisation, and timeout. Strategy: extract the existing `makeHttpRequest` body into a `buildElectronFetcher(config)` that returns a `Fetcher`, then call `executeHttpProxy(spec, fetcher, { allowLocalhost: true })`.

Manual redirects, SOCKS pre-tunnel, PAC resolution, interceptor pre/post hooks all happen _inside_ the fetcher closure, not in shared.

- [ ] **Step 1: Run existing Electron HTTP tests as baseline**

```bash
npm run test:run -- electron/main/__tests__/
```

Capture summary. Note that `http-handler.ts` may not have direct unit tests — that's fine, the integration tests in `worker/__tests__/index.test.ts` and feature tests provide coverage.

- [ ] **Step 2: Extract the request building into a Fetcher**

Inside `electron/main/http-handler.ts`, refactor `makeHttpRequest` so that the inner `new Promise<HttpResponse>` becomes a `Fetcher` returned by a builder. The builder closes over PAC/SOCKS/interceptor state. Keep mTLS, CA, SOCKS, redirect logic — they're Electron-only.

Sketch of the new shape (key changes only — full file is large; preserve everything else verbatim):

```ts
import { executeHttpProxy } from '@shared/protocol/http-proxy';
import type { Fetcher, FetcherRequest, FetcherResponse } from '@shared/protocol/types';
import { sanitizeResponseHeaders } from '@shared/protocol/header-policy';

// existing imports stay...

function buildFetcherForConfig(
  electronConfig: HttpRequestConfig,
  socksSocket: net.Socket | null
): Fetcher {
  return async (req: FetcherRequest): Promise<FetcherResponse> => {
    return new Promise<FetcherResponse>((resolve, reject) => {
      const url = new URL(req.url);
      const isHttps = url.protocol === 'https:';
      const verifySsl = electronConfig.verifySsl !== false;

      const requestOptions: http.RequestOptions | https.RequestOptions = {
        method: req.method,
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        headers: req.headers,
        timeout: electronConfig.timeout ?? 30_000,
        lookup: createSecureLookup(url.hostname, /* allowLocalhost */ true),
      };

      // Apply proxy (HTTP/SOCKS), mTLS, CA, etc. exactly as before — block unchanged from original
      // makeHttpRequest body, just calling resolve()/reject() with FetcherResponse shape:
      //
      //   resolve({
      //     status: res.statusCode || 0,
      //     statusText: res.statusMessage || '',
      //     headers: res.headers as Record<string, string | string[]>,
      //     text: () => Promise.resolve(Buffer.concat(chunks).toString('utf8')),
      //     contentLengthHeader: res.headers['content-length'] ?? null,
      //   });
      //
      // (size enforcement happens in the shared core via contentLengthHeader + buffered text;
      //  remove the Electron-side MAX_RESPONSE_SIZE chunk-counting since shared owns it now.)

      // Manual redirect handling stays Electron-side: if statusCode is 3xx, recursively call
      // executeHttpProxy from the redirect-resolved spec rather than re-implementing here.
    });
  };
}

async function makeHttpRequest(
  config: HttpRequestConfig,
  redirectCount = 0
): Promise<HttpResponse> {
  // PAC resolution stays here (mutates `resolvedConfig`)
  let resolvedConfig = config;
  // ... existing PAC block ...

  const interceptedConfig = await interceptorRegistry.runRequest(resolvedConfig);

  // Pre-establish SOCKS tunnel if needed
  let socksSocket: net.Socket | null = null;
  if (
    interceptedConfig.proxy?.enabled &&
    (interceptedConfig.proxy.type === 'socks4' || interceptedConfig.proxy.type === 'socks5')
  ) {
    const socksUrl = new URL(interceptedConfig.url);
    const socksTargetPort = parseInt(
      socksUrl.port || (socksUrl.protocol === 'https:' ? '443' : '80'),
      10
    );
    socksSocket = await openSocksSocket(
      interceptedConfig.proxy,
      socksUrl.hostname,
      socksTargetPort
    );
  }

  let rawResult: HttpResponse;
  try {
    const fetcher = buildFetcherForConfig(interceptedConfig, socksSocket);
    const result = await executeHttpProxy(
      {
        method: interceptedConfig.method ?? 'GET',
        url: interceptedConfig.url,
        headers: interceptedConfig.headers,
        params: interceptedConfig.params,
        data: interceptedConfig.data,
        timeout: interceptedConfig.timeout,
      },
      fetcher,
      { allowLocalhost: true }
    );

    if (!result.ok) {
      throw new Error(result.payload.error);
    }

    // Translate NormalizedResponse to legacy HttpResponse shape
    rawResult = {
      status: result.response.status,
      statusText: result.response.statusText,
      headers: result.response.headers,
      data: tryParseJson(result.response.body),
    };

    // Manual redirect handling
    if (rawResult.status >= 300 && rawResult.status < 400) {
      const location = rawResult.headers['location'];
      const max = interceptedConfig.maxRedirects ?? 5;
      if (location && redirectCount < max) {
        const locStr = Array.isArray(location) ? location[0] : (location as string);
        const newUrl = new URL(locStr, interceptedConfig.url).href;
        const isMethodReset =
          [301, 302, 303].includes(rawResult.status) &&
          (interceptedConfig.method ?? '').toUpperCase() === 'POST';
        const next: HttpRequestConfig = {
          ...interceptedConfig,
          url: newUrl,
          method: isMethodReset ? 'GET' : interceptedConfig.method,
          ...(isMethodReset ? { data: undefined } : {}),
        };
        return makeHttpRequest(next, redirectCount + 1);
      }
    }
  } catch (err) {
    if (socksSocket && !socksSocket.destroyed) socksSocket.destroy();
    throw err;
  }

  return interceptorRegistry.runResponse(rawResult, interceptedConfig);
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
```

Delete the inline `MAX_RESPONSE_SIZE` constant in `electron/main/http-handler.ts:59` and the `chunks`/`totalSize` logic — all owned by shared now. `CONNECTION_TIMEOUT` (the 10s pre-connect timer) stays — it's Electron-specific and operates below the shared core.

- [ ] **Step 3: Run Electron tests**

```bash
npm run test:run -- electron/main/__tests__/
npx tsc --noEmit -p electron/tsconfig.json
```

Expected: same baseline pass count from Step 1, zero TS errors.

- [ ] **Step 4: Manually smoke-test in Electron**

Run `npm run electron:dev` and exercise: a normal HTTPS GET, a 302 redirect (e.g., `https://httpbin.org/redirect/2`), an mTLS request if you have a cert handy, a SOCKS5 request through `localhost:1080` (start an `ssh -D 1080` tunnel), a PAC-configured proxy. None should regress vs. main.

- [ ] **Step 5: Commit**

```bash
git add electron/main/http-handler.ts
git commit -m "refactor(electron): route http-handler through shared/protocol core"
```

---

### Task 9: Move grpc-status and migrate worker gRPC handler

**Files:**

- Create: `shared/protocol/grpc-status.ts` (move from `worker/shared/grpc-status.ts`)
- Create: `shared/protocol/grpc-proxy.ts`
- Create: `shared/protocol/grpc-proxy.test.ts`
- Modify: `worker/handlers/grpc.ts`

- [ ] **Step 1: Move grpc-status verbatim**

Move `worker/shared/grpc-status.ts` to `shared/protocol/grpc-status.ts` (file-level move, content unchanged). Replace the original location with a re-export shim (kill in Task 11):

```ts
// worker/shared/grpc-status.ts
export * from '@shared/protocol/grpc-status';
```

- [ ] **Step 2: Write the failing tests for executeGrpcProxy**

Create `shared/protocol/grpc-proxy.test.ts`. Mirror the structure of `http-proxy.test.ts` but for gRPC: validate service/method names, build the Connect URL, return `grpcStatus`/`grpcStatusText`/`headers`/`trailers`/`data` shape; map Connect error codes to gRPC status. Replicate the test cases from `worker/handlers/__tests__/grpc.test.ts` against the new module. (Read that file first; the test names lock in behaviour parity.)

Sketch:

```ts
import { describe, it, expect, vi } from 'vitest';
import { executeGrpcProxy } from './grpc-proxy';
import { GrpcStatusCode } from './grpc-status';
import type { Fetcher } from './types';

const passingFetcher =
  (status = 200, body = '{}', headers: Record<string, string> = {}): Fetcher =>
  async () => ({
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers,
    text: async () => body,
    contentLengthHeader: String(body.length),
  });

describe('executeGrpcProxy', () => {
  it('rejects invalid service name', async () => {
    const r = await executeGrpcProxy(
      { url: 'https://example.com', service: '!!bad', method: 'Foo', timeout: 1000 },
      passingFetcher(),
      { allowLocalhost: false }
    );
    expect(r.ok).toBe(false);
  });

  it('rejects invalid method name', async () => {
    const r = await executeGrpcProxy(
      { url: 'https://example.com', service: 'svc.Foo', method: 'bad-name', timeout: 1000 },
      passingFetcher(),
      { allowLocalhost: false }
    );
    expect(r.ok).toBe(false);
  });

  it('builds Connect URL and returns OK on 200', async () => {
    const fetcher = vi.fn(passingFetcher(200, '{"x":1}'));
    const r = await executeGrpcProxy(
      {
        url: 'https://example.com',
        service: 'svc.Foo',
        method: 'Bar',
        message: { a: 1 },
        timeout: 1000,
      },
      fetcher,
      { allowLocalhost: false }
    );
    expect(fetcher.mock.calls[0]?.[0]?.url).toBe('https://example.com/svc.Foo/Bar');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.response.grpcStatus).toBe(GrpcStatusCode.OK);
      expect(r.response.data).toEqual({ x: 1 });
    }
  });

  it('maps Connect error codes', async () => {
    const fetcher = passingFetcher(404, JSON.stringify({ code: 'not_found', message: 'gone' }));
    const r = await executeGrpcProxy(
      { url: 'https://example.com', service: 'svc.Foo', method: 'Bar', timeout: 1000 },
      fetcher,
      { allowLocalhost: false }
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.response.grpcStatus).toBe(GrpcStatusCode.NOT_FOUND);
      expect((r.response.data as { error: string }).error).toBe('gone');
    }
  });

  it('separates trailer-prefixed headers into trailers map', async () => {
    const fetcher = passingFetcher(200, '{}', {
      'content-type': 'application/json',
      'trailer-grpc-status': '0',
      'trailer-x-extra': 'v',
    });
    const r = await executeGrpcProxy(
      { url: 'https://example.com', service: 'svc.Foo', method: 'Bar', timeout: 1000 },
      fetcher,
      { allowLocalhost: false }
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.response.trailers['grpc-status']).toBe('0');
      expect(r.response.trailers['x-extra']).toBe('v');
      expect(r.response.headers['trailer-grpc-status']).toBeUndefined();
    }
  });
});
```

- [ ] **Step 3: Run to fail**

Run: `npm run test:run -- shared/protocol/grpc-proxy`
Expected: FAIL.

- [ ] **Step 4: Implement `executeGrpcProxy`**

Create `shared/protocol/grpc-proxy.ts`. Translate `worker/handlers/grpc.ts` to the same `Fetcher`-based shape used in `http-proxy.ts`. Key additions:

- `validateServiceName` and `validateMethodName` helpers (move from `worker/handlers/grpc.ts:38-52`)
- `parseConnectError` helper (move from `worker/handlers/grpc.ts:54-85`)
- `GrpcResponse` shape with `grpcStatus`/`grpcStatusText`/`headers`/`trailers`/`data`/`size`
- Header sanitisation via `sanitizeRequestHeaders` (note: gRPC's deny list is a subset; pass `'default'` policy — `cookie` doesn't matter here)

```ts
import { GrpcStatusCode, GrpcStatusCodeName } from './grpc-status';
import { validateURL } from './url-validation';
import { sanitizeRequestHeaders, sanitizeResponseHeaders } from './header-policy';
import type { Fetcher } from './types';
import { MAX_RESPONSE_SIZE } from './http-proxy';

export interface GrpcSpec {
  url: string;
  service: string;
  method: string;
  metadata?: Record<string, string>;
  message?: unknown;
  timeout?: number;
}

export interface GrpcNormalizedResponse {
  grpcStatus: number;
  grpcStatusText: string;
  headers: Record<string, string>;
  trailers: Record<string, string>;
  data: unknown;
  size: number;
}

export type GrpcExecuteResult =
  | { ok: true; response: GrpcNormalizedResponse }
  | { ok: false; status: number; payload: { error: string } | GrpcNormalizedResponse };

const SERVICE_RE = /^[a-zA-Z][a-zA-Z0-9_.]*$/;
const METHOD_RE = /^[A-Za-z][a-zA-Z0-9]*$/;

function parseConnectError(body: string): { code: number; message: string } {
  try {
    const error = JSON.parse(body);
    if (error.code && typeof error.code === 'string') {
      const map: Record<string, number> = {
        canceled: GrpcStatusCode.CANCELLED,
        unknown: GrpcStatusCode.UNKNOWN,
        invalid_argument: GrpcStatusCode.INVALID_ARGUMENT,
        deadline_exceeded: GrpcStatusCode.DEADLINE_EXCEEDED,
        not_found: GrpcStatusCode.NOT_FOUND,
        already_exists: GrpcStatusCode.ALREADY_EXISTS,
        permission_denied: GrpcStatusCode.PERMISSION_DENIED,
        resource_exhausted: GrpcStatusCode.RESOURCE_EXHAUSTED,
        failed_precondition: GrpcStatusCode.FAILED_PRECONDITION,
        aborted: GrpcStatusCode.ABORTED,
        out_of_range: GrpcStatusCode.OUT_OF_RANGE,
        unimplemented: GrpcStatusCode.UNIMPLEMENTED,
        internal: GrpcStatusCode.INTERNAL,
        unavailable: GrpcStatusCode.UNAVAILABLE,
        data_loss: GrpcStatusCode.DATA_LOSS,
        unauthenticated: GrpcStatusCode.UNAUTHENTICATED,
      };
      return {
        code: map[error.code] ?? GrpcStatusCode.UNKNOWN,
        message: error.message || 'Unknown error',
      };
    }
    return { code: GrpcStatusCode.UNKNOWN, message: error.message || body };
  } catch {
    return { code: GrpcStatusCode.UNKNOWN, message: body };
  }
}

export interface ExecuteGrpcOptions {
  allowLocalhost: boolean;
}

export async function executeGrpcProxy(
  spec: GrpcSpec,
  fetcher: Fetcher,
  options: ExecuteGrpcOptions
): Promise<GrpcExecuteResult> {
  const urlValidation = validateURL(spec.url, {
    allowPrivateIPs: false,
    allowLocalhost: options.allowLocalhost,
  });
  if (!urlValidation.valid)
    return { ok: false, status: 400, payload: { error: `Invalid URL: ${urlValidation.error}` } };
  if (!spec.service || !SERVICE_RE.test(spec.service))
    return { ok: false, status: 400, payload: { error: 'Invalid service name format' } };
  if (!spec.method || !METHOD_RE.test(spec.method))
    return { ok: false, status: 400, payload: { error: 'Invalid method name format' } };

  const baseUrl = spec.url.endsWith('/') ? spec.url.slice(0, -1) : spec.url;
  const connectUrl = `${baseUrl}/${spec.service}/${spec.method}`;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Connect-Protocol-Version': '1',
    ...sanitizeRequestHeaders(spec.metadata),
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), spec.timeout ?? 30_000);

  try {
    const response = await fetcher({
      url: connectUrl,
      method: 'POST',
      headers,
      body: JSON.stringify(spec.message ?? {}),
      signal: controller.signal,
    });

    if (response.contentLengthHeader && Number(response.contentLengthHeader) > MAX_RESPONSE_SIZE) {
      return { ok: false, status: 413, payload: { error: 'Response too large' } };
    }
    const text = await response.text();
    if (text.length > MAX_RESPONSE_SIZE) {
      return { ok: false, status: 413, payload: { error: 'Response too large' } };
    }

    const sanitized = sanitizeResponseHeaders(response.headers);
    const trailers: Record<string, string> = {};
    const headersOut: Record<string, string> = {};
    for (const [k, v] of Object.entries(sanitized)) {
      if (k.toLowerCase().startsWith('trailer-')) trailers[k.slice(8).toLowerCase()] = v;
      else headersOut[k] = v;
    }

    let grpcStatus = GrpcStatusCode.OK;
    let grpcStatusText = 'OK';
    let data: unknown = {};
    if (response.status < 200 || response.status >= 300) {
      const info = parseConnectError(text);
      grpcStatus = info.code;
      grpcStatusText = GrpcStatusCodeName[grpcStatus as GrpcStatusCode] ?? 'UNKNOWN';
      data = { error: info.message };
    } else {
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        data = { raw: text };
      }
    }

    return {
      ok: true,
      response: {
        grpcStatus,
        grpcStatusText,
        headers: headersOut,
        trailers,
        data,
        size: text.length,
      },
    };
  } catch (err) {
    if (controller.signal.aborted) {
      return {
        ok: false,
        status: 504,
        payload: {
          grpcStatus: GrpcStatusCode.DEADLINE_EXCEEDED,
          grpcStatusText: 'DEADLINE_EXCEEDED',
          headers: {},
          trailers: {},
          data: { error: `Request timeout after ${spec.timeout ?? 30_000}ms` },
          size: 0,
        },
      };
    }
    const message = err instanceof Error ? err.message : 'Proxy request failed';
    return {
      ok: false,
      status: 502,
      payload: {
        grpcStatus: GrpcStatusCode.UNAVAILABLE,
        grpcStatusText: 'UNAVAILABLE',
        headers: {},
        trailers: {},
        data: { error: `Proxy request failed: ${message}` },
        size: 0,
      },
    };
  } finally {
    clearTimeout(timer);
  }
}
```

- [ ] **Step 5: Run shared tests to pass**

Run: `npm run test:run -- shared/protocol/grpc-proxy`
Expected: all PASS.

- [ ] **Step 6: Replace `worker/handlers/grpc.ts` with adapter**

```ts
import type { Context } from 'hono';
import type { Env } from '../index';
import { executeGrpcProxy } from '@shared/protocol/grpc-proxy';
import type { Fetcher } from '@shared/protocol/types';

const fetcher: Fetcher = async (req) => {
  const init: RequestInit = { method: req.method, headers: req.headers, signal: req.signal };
  if (req.body !== undefined) init.body = req.body;
  const r = await fetch(req.url, init);
  return {
    status: r.status,
    statusText: r.statusText,
    headers: r.headers,
    text: () => r.text(),
    contentLengthHeader: r.headers.get('content-length'),
  };
};

interface GrpcProxyRequestBody {
  url: string;
  service: string;
  method: string;
  metadata?: Record<string, string>;
  message?: unknown;
  timeout?: number;
}

export async function grpc(c: Context<{ Bindings: Env }>) {
  const isDev = c.env.ENVIRONMENT === 'development';
  let body: GrpcProxyRequestBody;
  try {
    body = await c.req.json<GrpcProxyRequestBody>();
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return c.json(
      {
        grpcStatus: 13,
        grpcStatusText: 'INTERNAL',
        headers: {},
        trailers: {},
        data: { error: `Proxy error: ${message}` },
        size: 0,
      },
      500
    );
  }

  const result = await executeGrpcProxy(body, fetcher, { allowLocalhost: isDev });

  if (!result.ok) {
    return c.json(result.payload, result.status as 400 | 413 | 502 | 504);
  }
  return c.json(result.response);
}
```

- [ ] **Step 7: Run worker gRPC tests**

```bash
npm run test:run -- worker/handlers/__tests__/grpc
npx tsc --noEmit -p worker/tsconfig.json
```

Expected: same baseline pass count, zero TS errors.

- [ ] **Step 8: Commit**

```bash
git add shared/protocol/grpc-status.ts shared/protocol/grpc-proxy.ts shared/protocol/grpc-proxy.test.ts \
        worker/shared/grpc-status.ts worker/handlers/grpc.ts
git commit -m "refactor(grpc): unify executeGrpcProxy in shared/protocol"
```

---

### Task 10: Migrate Electron gRPC handler and MCP handler

**Files:**

- Modify: `electron/main/grpc-handler.ts`
- Modify: `electron/main/mcp-handler.ts`
- Modify: `worker/handlers/mcp.ts`
- Create: `shared/protocol/mcp-proxy.ts` (only the JSON-RPC framing helpers; SSE reading stays in worker until Plan 4)

For Electron gRPC: the handler currently uses `@grpc/grpc-js` for reflection (which speaks raw HTTP/2) and a separate path for unary calls. Reflection stays as-is — it's binary protobuf, not JSON over Connect. **Only migrate the unary Connect path** in this task. Streaming and reflection are out of scope until Plan 4.

For MCP: the worker handler has bespoke SSE parsing (`readSseForReply`) that's worker-specific. The shared module should only own the parts that are duplicated: URL validation, JSON-RPC envelope construction, header policy. The SSE reader stays in `worker/handlers/mcp.ts`. The Electron MCP handler can call into shared for envelope + validation.

- [ ] **Step 1: Read both files end-to-end**

```bash
sed -n '1,200p' electron/main/grpc-handler.ts
sed -n '1,200p' electron/main/mcp-handler.ts
```

(Note: this is a read step, not a script step — review the contents to plan migration scope. If either handler is structurally different from what this plan assumes, write a one-paragraph note in the PR description and limit migration to the safe subset.)

- [ ] **Step 2: For Electron gRPC unary, route through `executeGrpcProxy`**

Replace the unary call path with a fetcher built around `undici.request` (already a transitive dep via Electron's bundled Node). Keep `@grpc/grpc-js` reflection untouched. Concretely: where the current code performs the Connect-protocol `fetch` for unary, swap to `executeGrpcProxy(spec, undiciFetcher, { allowLocalhost: true })`.

- [ ] **Step 3: For MCP, factor JSON-RPC envelope + URL/transport validation into shared**

Create `shared/protocol/mcp-proxy.ts`:

```ts
import { validateURL } from './url-validation';
import { sanitizeRequestHeaders } from './header-policy';

export type McpTransport = 'streamable-http' | 'http-sse';

export interface McpSpec {
  url: string;
  transport: McpTransport;
  postEndpoint?: string;
  sessionId?: string;
  headers?: Record<string, string>;
  jsonRpc: { method: string; params?: unknown; id: string | number };
  timeout?: number;
}

export type McpValidation =
  | {
      ok: true;
      targetUrl: string;
      headers: Record<string, string>;
      body: string;
      timeoutMs: number;
    }
  | { ok: false; status: number; error: string };

export function validateMcpSpec(spec: McpSpec, allowLocalhost: boolean): McpValidation {
  if (spec.transport !== 'streamable-http' && spec.transport !== 'http-sse') {
    return {
      ok: false,
      status: 400,
      error: 'Invalid `transport` (expected "streamable-http" or "http-sse")',
    };
  }
  if (!spec.jsonRpc || typeof spec.jsonRpc.method !== 'string' || spec.jsonRpc.id === undefined) {
    return { ok: false, status: 400, error: 'Invalid `jsonRpc` (method and id are required)' };
  }

  const targetUrl =
    spec.transport === 'http-sse'
      ? spec.postEndpoint && spec.postEndpoint.length > 0
        ? spec.postEndpoint
        : null
      : spec.url;
  if (!targetUrl)
    return { ok: false, status: 400, error: 'http-sse transport requires `postEndpoint`' };

  const v = validateURL(targetUrl, { allowPrivateIPs: false, allowLocalhost });
  if (!v.valid) return { ok: false, status: 400, error: `Invalid URL: ${v.error}` };

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    ...sanitizeRequestHeaders(spec.headers, 'mcp'),
  };
  if (spec.sessionId) headers['Mcp-Session-Id'] = spec.sessionId;

  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: spec.jsonRpc.id,
    method: spec.jsonRpc.method,
    ...(spec.jsonRpc.params !== undefined ? { params: spec.jsonRpc.params } : {}),
  });

  return {
    ok: true,
    targetUrl,
    headers,
    body,
    timeoutMs: Math.min(spec.timeout ?? 60_000, 120_000),
  };
}
```

- [ ] **Step 4: Update `worker/handlers/mcp.ts` to call `validateMcpSpec`**

Replace the inline validation block (lines 124-149) and header building (lines 156-161) with a single call to `validateMcpSpec`. The SSE parsing (`readSseForReply`) and the `fetch` call stay where they are. Net diff: ~50 lines removed.

- [ ] **Step 5: Update `electron/main/mcp-handler.ts` to call `validateMcpSpec`**

Replace its equivalent inline validation. Electron's MCP handler likely uses streamed `EventSource`-style parsing in Node — keep that. Only the validation + envelope construction migrates.

- [ ] **Step 6: Run all tests**

```bash
npm run validate
```

Expected: all pass. The existing `electron/main/__tests__/sse-mcp-validators.test.ts` already covers MCP validation — those tests must continue to pass.

- [ ] **Step 7: Commit**

```bash
git add shared/protocol/mcp-proxy.ts shared/protocol/mcp-proxy.test.ts \
        worker/handlers/mcp.ts electron/main/grpc-handler.ts electron/main/mcp-handler.ts
git commit -m "refactor(mcp,grpc): route Electron and worker handlers through shared/protocol"
```

---

### Task 11: Cleanup — delete shims and dead code

**Files:**

- Delete: `worker/shared/url-validation.ts`
- Delete: `worker/shared/grpc-status.ts`
- Delete: `worker/shared/constants.ts` (if no remaining importers)
- Modify: any worker file still importing from `worker/shared/url-validation`

- [ ] **Step 1: Find remaining importers**

```bash
rg -n "worker/shared/url-validation" --no-heading
rg -n "worker/shared/grpc-status" --no-heading
rg -n "worker/shared/constants" --no-heading
```

- [ ] **Step 2: Update each importer to use `@shared/protocol/...`**

For each match, replace the import path. `MAX_RESPONSE_SIZE` is now exported from `@shared/protocol/http-proxy`.

- [ ] **Step 3: Delete the shim files**

```bash
git rm worker/shared/url-validation.ts worker/shared/grpc-status.ts
# delete constants.ts only if Step 1 showed no remaining importers
```

- [ ] **Step 4: Run full validate**

```bash
npm run validate
```

Expected: all pass. If a build-time tool (e.g., `@cloudflare/vite-plugin`) complains about a missing path, it means a transitive consumer was missed in Step 2.

- [ ] **Step 5: Commit**

```bash
git add worker/ shared/
git commit -m "chore(foundation): delete worker shims now that all imports use @shared"
```

---

### Task 12: Documentation and ADR

**Files:**

- Modify: `docs/ARCHITECTURE.md`
- Create: `docs/adr/0001-shared-protocol-layer.md`

- [ ] **Step 1: Add an architecture section**

In `docs/ARCHITECTURE.md`, add a "Shared protocol layer" subsection that explains: (a) `shared/protocol/` is the single source of truth for URL validation, header policy, body building, and per-protocol orchestration; (b) Worker and Electron each provide a `Fetcher` that the shared core calls; (c) Electron-specific features (PAC, SOCKS, mTLS, interceptors) live in the Electron fetcher closure, not in shared; (d) new protocols add one shared module + two ~30-line adapters. Reference the file paths.

- [ ] **Step 2: Write the ADR**

Create `docs/adr/0001-shared-protocol-layer.md`:

```markdown
# ADR 0001: Shared Protocol Layer

**Status:** Accepted, 2026-05-08

## Context

Restura ships as both a Cloudflare Pages SPA (which proxies network calls through a Hono Worker) and an Electron desktop app (which uses native Node IPC handlers). Before this refactor, each protocol — HTTP, gRPC, MCP — was implemented twice with subtly different SSRF guards, header denylists, body-builders, and error-mapping. Two `isPrivateAddress` helpers existed (`worker/shared/url-validation.ts` and `electron/main/http-handler.ts`) and would drift over time.

## Decision

Promote protocol logic to `shared/protocol/`. Each protocol is implemented once as `executeXxxProxy(spec, fetcher, options)` returning a discriminated `ExecuteResult` union. Worker and Electron each supply their own `Fetcher` implementation but share validation, sanitisation, body construction, response shaping, and timeout handling.

## Consequences

**Positive:** New protocols slot in by adding one shared module and two ~30-line adapters. SSRF rule changes happen in one place. Test coverage on the core is reused by both backends.

**Negative:** Adds a `@shared` path alias which increases tsconfig surface area. Electron-specific features (PAC, SOCKS, mTLS, interceptors) still require thoughtful placement — they live in the fetcher closure, not in shared, but the boundary takes care to maintain.

## Alternatives considered

- **No-op (status quo):** Two independent code paths. Rejected — review identified active drift between the two `isPrivateAddress` implementations.
- **Single backend (Electron only or Worker only):** Either drops the web or desktop deployment. Rejected — both are strategic.
- **Plugin/extension model first:** Skip the refactor, build a plugin layer over the duplicated handlers. Rejected — plugins built atop diverged handlers inherit the divergence.
```

- [ ] **Step 3: Commit**

```bash
git add docs/ARCHITECTURE.md docs/adr/
git commit -m "docs(foundation): document shared protocol layer + ADR-0001"
```

---

## Self-review checklist

After completing all tasks, verify:

- [ ] `rg -n "isPrivateAddress" --no-heading` returns matches only in `shared/protocol/url-validation.ts` and its test.
- [ ] `rg -n "BLOCKED_REQUEST_HEADERS" --no-heading` returns no matches (renamed to `REQUEST_DENY` in shared).
- [ ] `rg -n "buildRequestBody" --no-heading` returns matches only in `shared/protocol/body-builder.ts` (and tests/usages).
- [ ] `worker/handlers/proxy.ts` is under 80 lines.
- [ ] `worker/handlers/grpc.ts` is under 80 lines.
- [ ] `worker/handlers/mcp.ts` is under 120 lines (SSE parsing keeps it longer).
- [ ] `npm run validate` passes (type-check + lint + tests).
- [ ] `npm run build` produces a working Worker bundle.
- [ ] `npm run electron:build:all` succeeds.
- [ ] No file in `electron/main/` references `worker/shared/`.
- [ ] No file in `worker/` references `electron/`.

---

## Out of scope (handled in later plans)

- **HTTP/2 + streaming responses end-to-end:** Plan 4. Today the shared core buffers the response body. The `Fetcher` interface is designed so a streaming variant (`stream(): ReadableStream`) can be added without breaking the existing buffered path.
- **Multi-tab request store:** Plan 2.
- **Real keychain encryption:** Plan 3.
- **CLI runner reusing this same shared core:** Plan 5. The CLI becomes the third backend (`undici` fetcher in Node) consuming the same `executeHttpProxy` — a few hundred lines instead of a thousand.
- **Web interceptor parity:** Plan 6.
