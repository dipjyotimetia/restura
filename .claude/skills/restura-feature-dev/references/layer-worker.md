# Worker layer (Cloudflare Pages Functions)

The Worker is a Hono app at `worker/` deployed as Pages Functions. Routes live at `/api/*` — same origin as the SPA, so no CORS friction.

The Worker is **web-only**. Electron skips it entirely and uses native IPC handlers. Don't put logic that's needed in both places only in the Worker — it'll be missing in desktop. The two implementations need to behave identically from the renderer's perspective.

## Adding a new route

### 1. Create the handler in `worker/handlers/<name>.ts`

```ts
import type { Context } from 'hono';
import type { Env } from '../index';
import { validateURL } from '../shared/url-validation';
import { MAX_RESPONSE_SIZE } from '../shared/constants';

interface MyRequestBody {
  url: string;
  method: string;
  // ...
}

export async function myHandler(c: Context<{ Bindings: Env }>) {
  // 1. Parse body — manual cast, no Zod
  const body = await c.req.json<MyRequestBody>();

  // 2. Validate method allow-list
  const allowed = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'];
  if (!allowed.includes(body.method)) {
    return c.json({ error: `Method not allowed: ${body.method}` }, 400);
  }

  // 3. SSRF guard for any URL the user controls
  const isDev = c.env.ENVIRONMENT === 'development';
  const result = validateURL(body.url, {
    allowPrivateIPs: false,
    allowLocalhost: isDev,
  });
  if (!result.valid) {
    return c.json({ error: `Invalid URL: ${result.error}` }, 400);
  }

  // 4. Do the work...
  // ...remember to enforce MAX_RESPONSE_SIZE on streamed bodies...

  // 5. Return success — uniform shape
  return c.json({ status, statusText, headers, data, size });
}
```

### 2. Mount in `worker/index.ts`

```ts
app.post('/api/my-endpoint', myHandler);
```

CORS is applied globally (`app.use('/api/*', cors())`) — don't add per-handler CORS.

## SSRF protection

Mandatory for any handler that fetches a URL the user controls. `validateURL` is in `worker/shared/url-validation.ts`:

- Blocks private IPs (RFC 1918, link-local, loopback)
- `allowLocalhost` is gated by `ENVIRONMENT === 'development'` — set `.dev.vars` to `ENVIRONMENT=development` for local localhost proxying
- Checks for protocol allowlist (http/https only)

There's a renderer-side copy at `src/features/http/lib/urlValidator.ts` for client-side fast-fail. Keep them in sync — the renderer copy gives instant feedback in the UI; the Worker copy is the security boundary.

## Response size limit

Imported from `worker/shared/constants.ts` — default `MAX_RESPONSE_SIZE = 10 MB`. Apply consistently. The Electron IPC handler enforces the same limit so behavior is uniform across harnesses.

If you stream a response, check size as bytes accumulate and return `413` early when exceeded. Don't buffer the whole thing first.

## Error response shape

Always `{ error: string }` with the right status code:

| Status | Meaning |
| --- | --- |
| 400 | Bad input or validation failure |
| 413 | Payload or response too large |
| 502 | Upstream fetch error |
| 504 | Upstream timeout |
| 500 | Unexpected server error |

Don't return non-JSON or shapes that vary by error type. Renderer code expects this shape.

## Success shape

Mirror the existing handlers. For HTTP-style proxies:

```ts
return c.json({ status, statusText, headers, data, size });
```

`data` is always a string (`.text()` was called). The renderer JSON-parses it as needed. For protocol-specific shapes, define a clear shape and document it in the handler's comment block.

## Validation philosophy — no Zod here

The Worker uses **manual TS-cast validation**. This is intentional: keeps the bundle small for cold starts on Cloudflare's edge. Don't add Zod to the Worker. If validation gets complex, factor a small helper.

## Type drift

The Worker's `<Name>RequestBody` interface lives locally in the handler file. The matching renderer payload is constructed by hand in the executor (`requestExecutor.ts` for HTTP). They're not formally linked.

When you change a Worker request shape, update the renderer's payload construction in the same PR. There is no compiler help to keep them aligned.

## Testing

Tests live in `worker/handlers/__tests__/<name>.test.ts`. They run in jsdom (not miniflare) — they test the handler function as a unit, not the deployed Worker. Mock external `fetch` calls.

For a new handler with SSRF, always test:

- Rejects a private IP URL with 400
- Accepts a public URL when `ENVIRONMENT` is unset
- Accepts localhost when `ENVIRONMENT === 'development'`

## Local dev

`npm run dev` runs Vite + the Worker locally via Miniflare (the `@cloudflare/vite-plugin` glue). One command boots both. The Worker bundles into `dist/web/_worker.js` on production build.

## Compatibility flags

`wrangler.jsonc` has `nodejs_compat`. You can use `Buffer` and other Node-style APIs. But many Cloudflare-specific APIs (Durable Objects, KV, R2) are not provisioned — the only binding is `ENVIRONMENT`.

## Type-checking the Worker

The Worker has its own tsconfig:

```bash
npx tsc --noEmit -p worker/tsconfig.json
```

`npm run validate` runs the renderer's tsc but **not** the Worker's. Run the Worker tsc explicitly when you change Worker code.
