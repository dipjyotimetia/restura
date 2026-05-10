# Phase 0 — OpenCollection Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Restura's custom YAML collection schema with the OpenCollection v1.0.0 spec so that any Bruno 3.1+ repository (and any future OpenCollection-compliant tool's repository) can be opened, edited, run, and saved back with clean, human-reviewable git diffs.

**Architecture:** Vendor the upstream OpenCollection JSON Schema. Auto-generate TypeScript types from it. Hand-write Zod runtime validators for the protocol subset Restura supports today (HTTP, gRPC, GraphQL, WebSocket). Wrap SSE and MCP — which OpenCollection v1 doesn't cover — inside the spec's `extensions` object as `x-restura-sse` / `x-restura-mcp`. Add bidirectional mappers between OpenCollection and Restura's internal `Collection` types. Replace both the renderer's and the Electron main process's duplicated YAML schemas with the new module. Harden the existing chokidar watcher in `electron/main/collection-manager.ts` so file changes propagate cleanly.

**Tech Stack:** TypeScript 5, Zod 4, `js-yaml` 4, `json-schema-to-typescript`, chokidar 5, Vitest 4, Playwright 1.59, Electron 41.

---

## File Structure

**New:**
- `vendor/opencollection/v1.0.0/schema.json` — pinned upstream JSON Schema
- `vendor/opencollection/v1.0.0/SOURCE.md` — commit hash, license note
- `vendor/opencollection/v1.0.0/LICENSE` — upstream MIT license text
- `src/lib/opencollection/index.ts` — public re-exports
- `src/lib/opencollection/spec-types.ts` — auto-generated TS types (committed)
- `src/lib/opencollection/schemas.ts` — hand-written Zod runtime validators
- `src/lib/opencollection/serializer.ts` — YAML parse/serialize
- `src/lib/opencollection/fs-reader.ts` — directory or single-file → OpenCollection
- `src/lib/opencollection/fs-writer.ts` — OpenCollection → directory or single-file
- `src/lib/opencollection/to-internal.ts` — OpenCollection → Restura internal `Collection`
- `src/lib/opencollection/from-internal.ts` — Restura internal `Collection` → OpenCollection
- `src/lib/opencollection/__tests__/serializer.test.ts`
- `src/lib/opencollection/__tests__/fs-reader.test.ts`
- `src/lib/opencollection/__tests__/fs-writer.test.ts`
- `src/lib/opencollection/__tests__/roundtrip.test.ts`
- `src/lib/opencollection/__tests__/to-internal.test.ts`
- `src/lib/opencollection/__tests__/from-internal.test.ts`
- `src/features/collections/lib/importers/opencollection.ts`
- `tests/fixtures/opencollection/simple-http.yaml`
- `tests/fixtures/opencollection/multi-protocol.yaml`
- `tests/fixtures/opencollection/dir-layout/opencollection.yml` (+ nested files)
- `tests/e2e/opencollection-roundtrip.spec.ts` (Playwright)
- `scripts/gen-opencollection-types.mjs`

**Modified:**
- `package.json` — add `json-schema-to-typescript` devDep + scripts
- `src/lib/shared/file-collection-schema.ts` — replaced with thin re-export shim
- `electron/main/collection-manager.ts` — remove duplicated schema, import from `src/lib/opencollection/schemas.ts`, debounce watcher
- `src/features/collections/lib/importers/index.ts` — re-export `importOpenCollection`
- `src/features/collections/lib/importers.ts` — re-export `importOpenCollection`
- `src/features/collections/lib/exporters.ts` — add `exportOpenCollection`
- `src/features/collections/components/CollectionImportMenu.tsx` (or equivalent) — wire OpenCollection menu item
- `src/features/collections/components/CollectionExportMenu.tsx` (or equivalent) — wire OpenCollection menu item

**Deleted:**
- None. The old `file-collection-schema.ts` becomes a re-export shim, not a deletion (callers keep working through one release for safety).

---

## Out of Scope (do not do in this plan)

- Bruno legacy `.bru` DSL parser (Phase 2)
- `restura init` CLI (Phase 1)
- Encrypted `.restura/secrets.enc` (Phase 1)
- New auth methods (OAuth1, NTLM) — types exist after Task 3, runtime support is Phase 4
- CLI runner gRPC/SSE/MCP support (Phase 3)
- Streaming response viewer changes (Phase 5)

---

## Task 1: Vendor the OpenCollection JSON Schema

**Why:** Pinning a copy of the schema kills "format drift" risk. Upstream is `opencollection-dev/opencollection`.

**Files:**
- Create: `vendor/opencollection/v1.0.0/schema.json`
- Create: `vendor/opencollection/v1.0.0/SOURCE.md`
- Create: `vendor/opencollection/v1.0.0/LICENSE`

- [ ] **Step 1: Fetch upstream schema and license**

```bash
mkdir -p vendor/opencollection/v1.0.0
gh api repos/opencollection-dev/opencollection/contents/packages/oc-schema/src/opencollection.schema.json --jq '.content' | base64 -d > vendor/opencollection/v1.0.0/schema.json
gh api repos/opencollection-dev/opencollection/contents/LICENSE --jq '.content' 2>/dev/null | base64 -d > vendor/opencollection/v1.0.0/LICENSE || echo "NO_LICENSE_FILE_AT_UPSTREAM" > vendor/opencollection/v1.0.0/LICENSE
COMMIT_SHA=$(gh api repos/opencollection-dev/opencollection/commits/main --jq '.sha')
echo "$COMMIT_SHA" > vendor/opencollection/v1.0.0/SOURCE.md
```

- [ ] **Step 2: Write SOURCE.md with commit hash and provenance**

Replace `vendor/opencollection/v1.0.0/SOURCE.md` with:

```markdown
# OpenCollection Schema Vendor

**Source:** https://github.com/opencollection-dev/opencollection
**Path:** `packages/oc-schema/src/opencollection.schema.json`
**Pinned commit:** <paste the SHA captured in Step 1>
**Vendored on:** 2026-05-10
**Spec version:** v1.0.0

To re-pin: bump the commit, re-run the fetch in Task 1, run `npm run gen:opencollection-types`,
re-run `npm run validate`, and update this file with the new SHA.
```

- [ ] **Step 3: Verify schema is valid JSON Schema draft-07**

```bash
node -e "const s=require('./vendor/opencollection/v1.0.0/schema.json'); if(s['\$schema']!=='http://json-schema.org/draft-07/schema#'){process.exit(1)}; console.log('OK', Object.keys(s['\$defs']).length, 'definitions')"
```

Expected: `OK 90 definitions` (or similar count > 80).

- [ ] **Step 4: Commit**

```bash
git add vendor/opencollection
git commit -m "feat(opencollection): vendor schema v1.0.0"
```

---

## Task 2: Auto-generate TypeScript types from the schema

**Why:** The schema has 90+ definitions. Hand-writing TS types is tedious and drift-prone. We commit the generated file so editors and CI don't need to regenerate.

**Files:**
- Modify: `package.json`
- Create: `scripts/gen-opencollection-types.mjs`
- Create: `src/lib/opencollection/spec-types.ts` (committed)

- [ ] **Step 1: Add devDependency and script**

```bash
npm install --save-dev json-schema-to-typescript@^15
```

Then edit `package.json` `scripts` to add:

```json
"gen:opencollection-types": "node scripts/gen-opencollection-types.mjs"
```

- [ ] **Step 2: Write the generator**

Create `scripts/gen-opencollection-types.mjs`:

```javascript
import { compileFromFile } from 'json-schema-to-typescript';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const SCHEMA = 'vendor/opencollection/v1.0.0/schema.json';
const OUT = 'src/lib/opencollection/spec-types.ts';

const banner = `/* eslint-disable */
/**
 * THIS FILE IS AUTO-GENERATED. DO NOT EDIT BY HAND.
 * Source: ${SCHEMA}
 * Regenerate with: npm run gen:opencollection-types
 */`;

const ts = await compileFromFile(SCHEMA, {
  bannerComment: banner,
  unreachableDefinitions: true,
  additionalProperties: false,
  declareExternallyReferenced: true,
  enableConstEnums: false,
});

await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, ts);
console.log('Wrote', OUT, ts.split('\n').length, 'lines');
```

- [ ] **Step 3: Run generator**

```bash
npm run gen:opencollection-types
```

Expected: `Wrote src/lib/opencollection/spec-types.ts <NNNN> lines` where NNNN > 500.

- [ ] **Step 4: Type-check the generated file**

```bash
npx tsc --noEmit src/lib/opencollection/spec-types.ts
```

Expected: zero errors. (If errors appear, the schema has a feature `json-schema-to-typescript` doesn't support — fix by adding a manual override at the bottom of `spec-types.ts` and document it in `SOURCE.md`.)

- [ ] **Step 5: Add CI check that types are up-to-date**

Edit `package.json` to add:

```json
"verify:opencollection-types": "npm run gen:opencollection-types && git diff --exit-code src/lib/opencollection/spec-types.ts"
```

And update the `validate` script:

```json
"validate": "npm run type-check && npm run lint && npm run verify:opencollection-types && npm run test:run"
```

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json scripts/gen-opencollection-types.mjs src/lib/opencollection/spec-types.ts
git commit -m "feat(opencollection): generate TS types from schema"
```

---

## Task 3: Vendor 3 fixture YAML files

**Why:** Tests need real OpenCollection input. Synthetic fixtures hide format quirks.

**Files:**
- Create: `tests/fixtures/opencollection/simple-http.yaml`
- Create: `tests/fixtures/opencollection/multi-protocol.yaml`
- Create: `tests/fixtures/opencollection/dir-layout/opencollection.yml`
- Create: `tests/fixtures/opencollection/dir-layout/users/get-user.yaml`
- Create: `tests/fixtures/opencollection/dir-layout/users/_folder.yaml` (uses spec's Folder, not legacy)

- [ ] **Step 1: Create `simple-http.yaml`**

```yaml
opencollection: "1.0.0"
info:
  name: Simple HTTP Demo
  version: "0.1.0"
  authors:
    - name: Restura Test Fixture
bundled: true
items:
  - info:
      type: http
      name: Get JSON Placeholder Post
      seq: 1
    http:
      method: GET
      url: https://jsonplaceholder.typicode.com/posts/1
      headers:
        - name: Accept
          value: application/json
```

- [ ] **Step 2: Create `multi-protocol.yaml`**

```yaml
opencollection: "1.0.0"
info:
  name: Multi-Protocol Demo
  version: "0.1.0"
bundled: true
config:
  environments:
    - name: dev
      variables:
        - name: API_HOST
          value: http://localhost:8080
items:
  - info: { type: http, name: Health Check, seq: 1 }
    http:
      method: GET
      url: "{{API_HOST}}/health"
  - info: { type: graphql, name: List Users, seq: 2 }
    graphql:
      url: "{{API_HOST}}/graphql"
      query: "query { users { id name } }"
  - info: { type: grpc, name: GetUser, seq: 3 }
    grpc:
      url: "{{API_HOST}}:9090"
      service: users.v1.UserService
      method: GetUser
      methodType: unary
      message: "{ \"id\": 1 }"
  - info: { type: websocket, name: Stock Ticker, seq: 4 }
    websocket:
      url: "ws://{{API_HOST}}/stream"
extensions:
  x-restura-sse:
    - info: { type: sse, name: Server Events, seq: 5 }
      sse:
        url: "{{API_HOST}}/events"
        eventFilter: ["user.created", "user.updated"]
```

- [ ] **Step 3: Create directory-layout fixture**

`tests/fixtures/opencollection/dir-layout/opencollection.yml`:

```yaml
opencollection: "1.0.0"
info:
  name: Dir Layout Demo
  version: "0.1.0"
bundled: false
config:
  environments:
    - name: dev
      variables:
        - { name: API_HOST, value: http://localhost:8080 }
```

`tests/fixtures/opencollection/dir-layout/users/_folder.yaml`:

```yaml
info:
  name: users
  description: User CRUD endpoints
```

`tests/fixtures/opencollection/dir-layout/users/get-user.yaml`:

```yaml
info:
  type: http
  name: Get User
http:
  method: GET
  url: "{{API_HOST}}/users/1"
```

- [ ] **Step 4: Commit**

```bash
git add tests/fixtures/opencollection
git commit -m "test(opencollection): add 3 fixture collections"
```

---

## Task 4: Hand-written Zod schemas for runtime validation

**Why:** TS types are compile-time only. We need runtime validation when reading user files. Restrict to the protocol subset Restura supports + the spec's open `extensions` field.

**Files:**
- Create: `src/lib/opencollection/schemas.ts`
- Create: `src/lib/opencollection/__tests__/schemas.test.ts`

- [ ] **Step 1: Write the failing test first**

Create `src/lib/opencollection/__tests__/schemas.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';
import { openCollectionSchema } from '../schemas';

const FIXTURES = 'tests/fixtures/opencollection';

describe('openCollectionSchema', () => {
  it('parses simple-http.yaml', () => {
    const raw = readFileSync(`${FIXTURES}/simple-http.yaml`, 'utf8');
    const parsed = yaml.load(raw);
    const result = openCollectionSchema.safeParse(parsed);
    if (!result.success) console.error(result.error.format());
    expect(result.success).toBe(true);
  });

  it('parses multi-protocol.yaml including SSE in extensions', () => {
    const raw = readFileSync(`${FIXTURES}/multi-protocol.yaml`, 'utf8');
    const parsed = yaml.load(raw);
    const result = openCollectionSchema.safeParse(parsed);
    expect(result.success).toBe(true);
  });

  it('rejects a collection without info.name', () => {
    const result = openCollectionSchema.safeParse({ opencollection: '1.0.0', info: {} });
    expect(result.success).toBe(false);
  });

  it('accepts unknown fields in extensions', () => {
    const result = openCollectionSchema.safeParse({
      opencollection: '1.0.0',
      info: { name: 'X' },
      extensions: { 'x-restura-anything': { foo: 'bar' } },
    });
    expect(result.success).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run src/lib/opencollection/__tests__/schemas.test.ts
```

Expected: FAIL — `Cannot find module '../schemas'`.

- [ ] **Step 3: Implement `schemas.ts`**

Create `src/lib/opencollection/schemas.ts`:

```typescript
import { z } from 'zod';

const description = z.union([z.string(), z.object({ content: z.string(), mimeType: z.string().optional() })]);

const author = z.object({
  name: z.string().optional(),
  email: z.string().optional(),
  url: z.string().optional(),
});

const info = z.object({
  name: z.string().min(1),
  summary: z.string().optional(),
  version: z.string().optional(),
  authors: z.array(author).optional(),
});

const variableValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);

const variable = z.object({
  name: z.string(),
  value: z.union([variableValue, z.array(z.object({ name: z.string().optional(), value: variableValue }))]).optional(),
  description: description.optional(),
  disabled: z.boolean().optional(),
});

const secretVariable = z.object({
  secret: z.literal(true),
  name: z.string(),
  type: z.enum(['string', 'number', 'boolean']).optional(),
  description: description.optional(),
  disabled: z.boolean().optional(),
});

const environment = z.object({
  name: z.string().min(1),
  color: z.string().optional(),
  description: description.optional(),
  variables: z.array(z.union([variable, secretVariable])).optional(),
  clientCertificates: z.array(z.unknown()).optional(),
  extends: z.string().optional(),
  dotEnvFilePath: z.string().optional(),
});

const httpHeader = z.object({
  name: z.string(),
  value: z.string(),
  enabled: z.boolean().optional(),
  description: description.optional(),
});

const httpParam = z.object({
  name: z.string(),
  value: z.string(),
  enabled: z.boolean().optional(),
  description: description.optional(),
});

const auth = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }),
  z.object({ type: z.literal('basic'), username: z.string(), password: z.string() }),
  z.object({ type: z.literal('bearer'), token: z.string() }),
  z.object({ type: z.literal('apiKey'), key: z.string(), value: z.string(), placement: z.enum(['header', 'query']) }),
  z.object({ type: z.literal('digest'), username: z.string(), password: z.string() }),
  z.object({ type: z.literal('ntlm'), username: z.string(), password: z.string(), domain: z.string().optional() }),
  z.object({ type: z.literal('oauth1'), consumerKey: z.string(), consumerSecret: z.string(), token: z.string().optional(), tokenSecret: z.string().optional() }),
  z.object({ type: z.literal('oauth2') }).passthrough(),
  z.object({ type: z.literal('awsv4'), accessKeyId: z.string(), secretAccessKey: z.string(), region: z.string(), service: z.string(), sessionToken: z.string().optional() }),
  z.object({ type: z.literal('wsse'), username: z.string(), password: z.string() }),
]);

const httpRequestBody = z.object({}).passthrough();

const httpRequestDetails = z.object({
  method: z.string(),
  url: z.string(),
  headers: z.array(httpHeader).optional(),
  params: z.array(httpParam).optional(),
  body: z.union([httpRequestBody, z.array(httpRequestBody)]).optional(),
  auth: auth.optional(),
});

const httpRequest = z.object({
  info: z.object({
    type: z.literal('http'),
    name: z.string().min(1),
    description: description.optional(),
    seq: z.number().optional(),
    tags: z.array(z.string()).optional(),
  }),
  http: httpRequestDetails,
  runtime: z.object({}).passthrough().optional(),
  settings: z.object({}).passthrough().optional(),
  examples: z.array(z.unknown()).optional(),
  docs: z.string().optional(),
});

const grpcRequest = z.object({
  info: z.object({
    type: z.literal('grpc'),
    name: z.string().min(1),
    description: description.optional(),
    seq: z.number().optional(),
  }),
  grpc: z.object({
    url: z.string(),
    service: z.string(),
    method: z.string(),
    methodType: z.enum(['unary', 'serverStreaming', 'clientStreaming', 'bidirectional']).optional(),
    message: z.union([z.string(), z.array(z.unknown())]).optional(),
    metadata: z.array(z.object({ name: z.string(), value: z.string() })).optional(),
    auth: auth.optional(),
  }),
});

const graphqlRequest = z.object({
  info: z.object({
    type: z.literal('graphql'),
    name: z.string().min(1),
  }),
  graphql: z.object({
    url: z.string(),
    query: z.string().optional(),
    variables: z.string().optional(),
    headers: z.array(httpHeader).optional(),
    auth: auth.optional(),
  }),
});

const websocketRequest = z.object({
  info: z.object({
    type: z.literal('websocket'),
    name: z.string().min(1),
  }),
  websocket: z.object({
    url: z.string(),
    headers: z.array(httpHeader).optional(),
  }),
});

const folder: z.ZodType<unknown> = z.lazy(() =>
  z.object({
    info: z.object({
      name: z.string().min(1),
      description: description.optional(),
    }),
    items: z.array(item).optional(),
    request: z.unknown().optional(),
    docs: description.optional(),
  })
);

const item: z.ZodType<unknown> = z.lazy(() =>
  z.union([httpRequest, grpcRequest, graphqlRequest, websocketRequest, folder])
);

export const openCollectionSchema = z.object({
  opencollection: z.string(),
  info: info,
  config: z
    .object({
      environments: z.array(environment).optional(),
      protobuf: z.unknown().optional(),
      proxy: z.unknown().optional(),
      clientCertificates: z.array(z.unknown()).optional(),
    })
    .optional(),
  items: z.array(item).optional(),
  request: z.unknown().optional(),
  docs: description.optional(),
  bundled: z.boolean().optional(),
  extensions: z.record(z.string(), z.unknown()).optional(),
});

export type OpenCollection = z.infer<typeof openCollectionSchema>;
export const httpRequestSchema = httpRequest;
export const grpcRequestSchema = grpcRequest;
export const graphqlRequestSchema = graphqlRequest;
export const websocketRequestSchema = websocketRequest;
export const folderSchema = folder;
export const authSchema = auth;
export const environmentSchema = environment;
```

- [ ] **Step 4: Run the test**

```bash
npx vitest run src/lib/opencollection/__tests__/schemas.test.ts
```

Expected: PASS (4/4).

- [ ] **Step 5: Type-check**

```bash
npm run type-check
```

Expected: zero errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/opencollection/schemas.ts src/lib/opencollection/__tests__/schemas.test.ts
git commit -m "feat(opencollection): add zod runtime validators"
```

---

## Task 5: YAML serializer module

**Why:** Wraps `js-yaml` with stable options (no anchors, sorted keys off, double-quote strings with `{{}}` so YAML doesn't try to interpret them) and validates on load.

**Files:**
- Create: `src/lib/opencollection/serializer.ts`
- Create: `src/lib/opencollection/__tests__/serializer.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/opencollection/__tests__/serializer.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseOpenCollectionYAML, serializeOpenCollectionYAML } from '../serializer';

const FIXTURES = 'tests/fixtures/opencollection';

describe('serializer', () => {
  it('parses a valid YAML file into a typed OpenCollection', () => {
    const raw = readFileSync(`${FIXTURES}/simple-http.yaml`, 'utf8');
    const oc = parseOpenCollectionYAML(raw);
    expect(oc.info.name).toBe('Simple HTTP Demo');
    expect(oc.items?.[0]).toMatchObject({ info: { type: 'http' } });
  });

  it('throws on schema-invalid YAML', () => {
    expect(() => parseOpenCollectionYAML('opencollection: "1.0.0"\ninfo:\n  bogus: 1')).toThrow();
  });

  it('throws on syntactically invalid YAML', () => {
    expect(() => parseOpenCollectionYAML('::not valid yaml::')).toThrow();
  });

  it('roundtrips byte-stable on the simple fixture', () => {
    const raw = readFileSync(`${FIXTURES}/simple-http.yaml`, 'utf8');
    const oc = parseOpenCollectionYAML(raw);
    const serialized = serializeOpenCollectionYAML(oc);
    const reparsed = parseOpenCollectionYAML(serialized);
    expect(reparsed).toEqual(oc);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npx vitest run src/lib/opencollection/__tests__/serializer.test.ts
```

Expected: FAIL — `Cannot find module '../serializer'`.

- [ ] **Step 3: Implement `serializer.ts`**

```typescript
import yaml from 'js-yaml';
import { openCollectionSchema, type OpenCollection } from './schemas';

export function parseOpenCollectionYAML(raw: string): OpenCollection {
  let doc: unknown;
  try {
    doc = yaml.load(raw, { schema: yaml.JSON_SCHEMA });
  } catch (err) {
    throw new Error(`Invalid YAML: ${(err as Error).message}`);
  }
  const result = openCollectionSchema.safeParse(doc);
  if (!result.success) {
    throw new Error(`Invalid OpenCollection: ${JSON.stringify(result.error.format(), null, 2)}`);
  }
  return result.data;
}

export function serializeOpenCollectionYAML(oc: OpenCollection): string {
  return yaml.dump(oc, {
    indent: 2,
    lineWidth: 120,
    noRefs: true,
    sortKeys: false,
    quotingType: '"',
    forceQuotes: false,
  });
}
```

- [ ] **Step 4: Run the test**

```bash
npx vitest run src/lib/opencollection/__tests__/serializer.test.ts
```

Expected: PASS (4/4).

- [ ] **Step 5: Commit**

```bash
git add src/lib/opencollection/serializer.ts src/lib/opencollection/__tests__/serializer.test.ts
git commit -m "feat(opencollection): add YAML serializer with validation"
```

---

## Task 6: Filesystem reader (directory and bundled file)

**Why:** OpenCollection supports two on-disk layouts: `bundled: true` (single file) and `bundled: false` (nested folders + files). We collapse both into a single in-memory `OpenCollection` object.

**Files:**
- Create: `src/lib/opencollection/fs-reader.ts`
- Create: `src/lib/opencollection/__tests__/fs-reader.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/opencollection/__tests__/fs-reader.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { loadCollectionFromFile, loadCollectionFromDir } from '../fs-reader';

const FIXTURES = 'tests/fixtures/opencollection';

describe('fs-reader', () => {
  it('loads a bundled single-file collection', async () => {
    const oc = await loadCollectionFromFile(`${FIXTURES}/simple-http.yaml`);
    expect(oc.info.name).toBe('Simple HTTP Demo');
    expect(oc.items?.length).toBe(1);
  });

  it('loads a directory-layout collection with one folder and one request', async () => {
    const oc = await loadCollectionFromDir(`${FIXTURES}/dir-layout`);
    expect(oc.info.name).toBe('Dir Layout Demo');
    expect(oc.items?.length).toBe(1);
    const folder = oc.items?.[0] as { info: { name: string }; items: unknown[] };
    expect(folder.info.name).toBe('users');
    expect(folder.items.length).toBe(1);
  });

  it('throws on directory missing opencollection.yml', async () => {
    await expect(loadCollectionFromDir('/tmp/definitely-not-an-oc-dir-12345')).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npx vitest run src/lib/opencollection/__tests__/fs-reader.test.ts
```

Expected: FAIL — `Cannot find module '../fs-reader'`.

- [ ] **Step 3: Implement `fs-reader.ts`**

```typescript
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, basename } from 'node:path';
import yaml from 'js-yaml';
import { parseOpenCollectionYAML, serializeOpenCollectionYAML } from './serializer';
import type { OpenCollection } from './schemas';

const ROOT_FILES = ['opencollection.yml', 'opencollection.yaml'];
const FOLDER_META = '_folder.yaml';

export async function loadCollectionFromFile(path: string): Promise<OpenCollection> {
  const raw = await readFile(path, 'utf8');
  return parseOpenCollectionYAML(raw);
}

export async function loadCollectionFromDir(dir: string): Promise<OpenCollection> {
  const rootPath = await findRootFile(dir);
  if (!rootPath) {
    throw new Error(`No opencollection.yml or opencollection.yaml in ${dir}`);
  }
  const rootRaw = await readFile(rootPath, 'utf8');
  const root = parseOpenCollectionYAML(rootRaw);
  const items = await readItems(dir);
  return { ...root, items, bundled: false };
}

async function findRootFile(dir: string): Promise<string | null> {
  for (const candidate of ROOT_FILES) {
    const p = join(dir, candidate);
    try {
      await stat(p);
      return p;
    } catch {
      // not present
    }
  }
  return null;
}

async function readItems(dir: string): Promise<unknown[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const items: unknown[] = [];

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      const folder = await readFolder(fullPath);
      items.push(folder);
      continue;
    }

    if (!entry.isFile()) continue;
    if (ROOT_FILES.includes(entry.name)) continue;
    if (entry.name === FOLDER_META) continue;
    if (!entry.name.endsWith('.yaml') && !entry.name.endsWith('.yml')) continue;

    const raw = await readFile(fullPath, 'utf8');
    const parsed = yaml.load(raw, { schema: yaml.JSON_SCHEMA });
    items.push(parsed);
  }

  // Sort items by info.seq if present, else by file name (stable)
  items.sort((a: any, b: any) => {
    const sa = a?.info?.seq ?? Number.MAX_SAFE_INTEGER;
    const sb = b?.info?.seq ?? Number.MAX_SAFE_INTEGER;
    return sa - sb;
  });

  return items;
}

async function readFolder(dir: string): Promise<unknown> {
  const metaPath = join(dir, FOLDER_META);
  let meta: unknown = { info: { name: basename(dir) } };
  try {
    const raw = await readFile(metaPath, 'utf8');
    meta = yaml.load(raw, { schema: yaml.JSON_SCHEMA });
  } catch {
    // _folder.yaml is optional; fall back to dir basename
  }
  const items = await readItems(dir);
  return { ...(meta as object), items };
}

// Re-export for callers that need to write back later
export { serializeOpenCollectionYAML };
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run src/lib/opencollection/__tests__/fs-reader.test.ts
```

Expected: PASS (3/3).

- [ ] **Step 5: Commit**

```bash
git add src/lib/opencollection/fs-reader.ts src/lib/opencollection/__tests__/fs-reader.test.ts
git commit -m "feat(opencollection): add filesystem reader"
```

---

## Task 7: Filesystem writer (directory and bundled file)

**Why:** Writing a multi-file directory layout means one file per request, slugified filenames, `_folder.yaml` for folder metadata. This is what makes git diffs reviewable.

**Files:**
- Create: `src/lib/opencollection/fs-writer.ts`
- Create: `src/lib/opencollection/__tests__/fs-writer.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveCollectionToDir, saveCollectionToFile } from '../fs-writer';
import { loadCollectionFromDir, loadCollectionFromFile } from '../fs-reader';
import type { OpenCollection } from '../schemas';

describe('fs-writer', () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'oc-writer-'));
  });

  it('saves a bundled single-file collection', async () => {
    const oc: OpenCollection = {
      opencollection: '1.0.0',
      info: { name: 'Bundled Demo' },
      bundled: true,
      items: [{ info: { type: 'http', name: 'Get root' }, http: { method: 'GET', url: 'https://example.com' } }],
    };
    const dest = join(tmp, 'bundled.yaml');
    await saveCollectionToFile(oc, dest);
    const content = await readFile(dest, 'utf8');
    expect(content).toContain('opencollection: "1.0.0"');
    expect(content).toContain('Get root');
    const reloaded = await loadCollectionFromFile(dest);
    expect(reloaded.info.name).toBe('Bundled Demo');
  });

  it('saves a directory layout with slugified filenames', async () => {
    const oc: OpenCollection = {
      opencollection: '1.0.0',
      info: { name: 'Dir Demo' },
      items: [
        {
          info: { name: 'users', description: 'User CRUD' },
          items: [
            { info: { type: 'http', name: 'Get User By ID' }, http: { method: 'GET', url: '/u/1' } },
          ],
        },
      ],
    };
    await saveCollectionToDir(oc, tmp);
    const root = await readFile(join(tmp, 'opencollection.yml'), 'utf8');
    expect(root).toContain('Dir Demo');
    const folderMeta = await readFile(join(tmp, 'users', '_folder.yaml'), 'utf8');
    expect(folderMeta).toContain('users');
    const req = await readFile(join(tmp, 'users', 'get-user-by-id.yaml'), 'utf8');
    expect(req).toContain('Get User By ID');
  });

  it('roundtrips dir-layout fixture without semantic loss', async () => {
    const original = await loadCollectionFromDir('tests/fixtures/opencollection/dir-layout');
    await saveCollectionToDir(original, tmp);
    const reloaded = await loadCollectionFromDir(tmp);
    expect(reloaded).toEqual(original);
  });

  it('cleans up empty trailing arrays so YAML stays compact', async () => {
    const oc: OpenCollection = {
      opencollection: '1.0.0',
      info: { name: 'Compact' },
      items: [],
    };
    const dest = join(tmp, 'c.yaml');
    await saveCollectionToFile(oc, dest);
    const content = await readFile(dest, 'utf8');
    expect(content).not.toContain('items: []');
  });

  afterEach?.(async () => rm(tmp, { recursive: true, force: true }));
});
```

(Note: if `afterEach` isn't imported, swap to `import { afterEach } from 'vitest'` at the top.)

- [ ] **Step 2: Run to verify it fails**

```bash
npx vitest run src/lib/opencollection/__tests__/fs-writer.test.ts
```

Expected: FAIL — module missing.

- [ ] **Step 3: Implement `fs-writer.ts`**

```typescript
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { serializeOpenCollectionYAML } from './serializer';
import type { OpenCollection } from './schemas';

export async function saveCollectionToFile(oc: OpenCollection, path: string): Promise<void> {
  const compact = compact(oc);
  const yaml = serializeOpenCollectionYAML({ ...compact, bundled: true } as OpenCollection);
  await writeFile(path, yaml, 'utf8');
}

export async function saveCollectionToDir(oc: OpenCollection, dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  const { items, ...rootRest } = oc;
  // Root file holds metadata + config; items live as nested files
  const root = compact({ ...rootRest, bundled: false });
  await writeFile(join(dir, 'opencollection.yml'), serializeOpenCollectionYAML(root as OpenCollection), 'utf8');
  await writeItems(items ?? [], dir);
}

async function writeItems(items: unknown[], dir: string): Promise<void> {
  for (const it of items) {
    const item = it as Record<string, unknown>;
    if (isFolder(item)) {
      const slug = slugify((item.info as { name: string }).name);
      const folderDir = join(dir, slug);
      await mkdir(folderDir, { recursive: true });
      const folderMeta = compact({ info: item.info, request: item.request, docs: item.docs });
      if (Object.keys(folderMeta as object).length > 0) {
        await writeFile(join(folderDir, '_folder.yaml'), serializeOpenCollectionYAML(folderMeta as OpenCollection), 'utf8');
      }
      await writeItems(((item.items as unknown[]) ?? []), folderDir);
    } else {
      const info = item.info as { name: string; type: string };
      const slug = slugify(info.name);
      const filename = `${slug}.yaml`;
      await writeFile(join(dir, filename), serializeOpenCollectionYAML(compact(item) as OpenCollection), 'utf8');
    }
  }
}

function isFolder(item: Record<string, unknown>): boolean {
  const info = item.info as { type?: string } | undefined;
  return !info?.type && Array.isArray(item.items);
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'item';
}

function compact<T>(obj: T): T {
  if (Array.isArray(obj)) {
    const out = obj.map(compact).filter((v) => v !== undefined);
    return (out.length === 0 ? undefined : out) as unknown as T;
  }
  if (obj && typeof obj === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      const c = compact(v);
      if (c !== undefined && !(Array.isArray(c) && c.length === 0)) {
        out[k] = c;
      }
    }
    return out as T;
  }
  return obj;
}

export { rm as _rmForTests };
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run src/lib/opencollection/__tests__/fs-writer.test.ts
```

Expected: PASS (4/4).

- [ ] **Step 5: Commit**

```bash
git add src/lib/opencollection/fs-writer.ts src/lib/opencollection/__tests__/fs-writer.test.ts
git commit -m "feat(opencollection): add filesystem writer with slugified filenames"
```

---

## Task 8: Roundtrip integration test

**Why:** A single test that loads each fixture, writes it, reloads, and asserts deep equality. Catches subtle losses (key ordering, optional fields, extensions block).

**Files:**
- Create: `src/lib/opencollection/__tests__/roundtrip.test.ts`

- [ ] **Step 1: Write the test**

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCollectionFromFile, loadCollectionFromDir } from '../fs-reader';
import { saveCollectionToFile, saveCollectionToDir } from '../fs-writer';

describe('OpenCollection roundtrip', () => {
  let tmp: string;
  beforeEach(async () => { tmp = await mkdtemp(join(tmpdir(), 'oc-rt-')); });
  afterEach(async () => { await rm(tmp, { recursive: true, force: true }); });

  it('simple-http.yaml: file → save → reload', async () => {
    const oc1 = await loadCollectionFromFile('tests/fixtures/opencollection/simple-http.yaml');
    const dest = join(tmp, 'simple.yaml');
    await saveCollectionToFile(oc1, dest);
    const oc2 = await loadCollectionFromFile(dest);
    expect(oc2).toEqual(oc1);
  });

  it('multi-protocol.yaml: file → save → reload preserves x-restura-sse', async () => {
    const oc1 = await loadCollectionFromFile('tests/fixtures/opencollection/multi-protocol.yaml');
    const dest = join(tmp, 'mp.yaml');
    await saveCollectionToFile(oc1, dest);
    const oc2 = await loadCollectionFromFile(dest);
    expect(oc2).toEqual(oc1);
    expect(oc2.extensions?.['x-restura-sse']).toBeDefined();
  });

  it('dir-layout: dir → save dir → reload', async () => {
    const oc1 = await loadCollectionFromDir('tests/fixtures/opencollection/dir-layout');
    await saveCollectionToDir(oc1, tmp);
    const oc2 = await loadCollectionFromDir(tmp);
    expect(oc2).toEqual(oc1);
  });
});
```

- [ ] **Step 2: Run**

```bash
npx vitest run src/lib/opencollection/__tests__/roundtrip.test.ts
```

Expected: PASS (3/3). If it fails on equality with a small drift (e.g. `bundled` flag), fix the writer's compact step accordingly.

- [ ] **Step 3: Commit**

```bash
git add src/lib/opencollection/__tests__/roundtrip.test.ts
git commit -m "test(opencollection): add roundtrip suite"
```

---

## Task 9: Bridge — OpenCollection → Restura internal Collection

**Why:** The renderer's stores work with Restura's existing `Collection`/`HttpRequest`/`GrpcRequest` types. We need a deterministic mapping.

Read the existing types first to align field names. The relevant files are `src/types/index.ts` (or wherever `Collection`, `HttpRequest`, `GrpcRequest`, `KeyValue`, `AuthConfig` are defined). The mapper preserves any unrecognized fields in `_oc` (a private "passthrough bag") so Task 10 can reverse-map without losing user data.

**Files:**
- Create: `src/lib/opencollection/to-internal.ts`
- Create: `src/lib/opencollection/__tests__/to-internal.test.ts`

- [ ] **Step 1: Read the existing internal types**

```bash
rg "export (type|interface) (Collection|HttpRequest|GrpcRequest|AuthConfig|KeyValue)" src/types src/lib --type ts
```

Capture the canonical field names (e.g. is it `headers` or `httpHeaders`? `id` required at root?). The mapper below assumes Restura's types; if names differ, adjust the implementation in Step 3.

- [ ] **Step 2: Write the failing tests**

Create `src/lib/opencollection/__tests__/to-internal.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { loadCollectionFromFile } from '../fs-reader';
import { ocToInternal } from '../to-internal';

describe('ocToInternal', () => {
  it('maps a single HTTP request', async () => {
    const oc = await loadCollectionFromFile('tests/fixtures/opencollection/simple-http.yaml');
    const collection = ocToInternal(oc);
    expect(collection.name).toBe('Simple HTTP Demo');
    expect(collection.items.length).toBe(1);
    const item = collection.items[0];
    expect(item.type).toBe('request');
    expect(item.request?.type).toBe('http');
    expect(item.request?.method).toBe('GET');
  });

  it('maps multi-protocol fixture: http, graphql, grpc, websocket, and SSE via extensions', async () => {
    const oc = await loadCollectionFromFile('tests/fixtures/opencollection/multi-protocol.yaml');
    const collection = ocToInternal(oc);
    const types = collection.items.map((i) => i.request?.type);
    expect(types).toContain('http');
    expect(types).toContain('graphql');
    expect(types).toContain('grpc');
    expect(types).toContain('websocket');
    expect(types).toContain('sse'); // from extensions['x-restura-sse']
  });

  it('preserves OpenCollection passthrough on each item via _oc bag', async () => {
    const oc = await loadCollectionFromFile('tests/fixtures/opencollection/simple-http.yaml');
    const collection = ocToInternal(oc);
    expect((collection.items[0] as any)._oc).toBeDefined();
  });
});
```

- [ ] **Step 3: Run to verify fail**

```bash
npx vitest run src/lib/opencollection/__tests__/to-internal.test.ts
```

Expected: FAIL — module missing.

- [ ] **Step 4: Implement `to-internal.ts`**

```typescript
import { v4 as uuid } from 'uuid';
import type { OpenCollection } from './schemas';

// NOTE: import the actual types from your project, e.g.:
// import type { Collection, CollectionItem, HttpRequest, GrpcRequest } from '@/types';
// Using `any` here for the plan's sake; replace with concrete imports during Task 9 Step 1.
type Internal = any;

export function ocToInternal(oc: OpenCollection): Internal {
  return {
    id: uuid(),
    name: oc.info.name,
    description: typeof oc.docs === 'string' ? oc.docs : undefined,
    variables: extractRootVariables(oc),
    auth: undefined,
    items: [
      ...((oc.items ?? []).map(itemToInternal)),
      ...extensionItems(oc.extensions),
    ],
    _oc: oc, // full passthrough — written back verbatim if user doesn't edit it
  };
}

function itemToInternal(item: any): any {
  if (isFolder(item)) {
    return {
      id: uuid(),
      type: 'folder',
      name: item.info.name,
      description: typeof item.info.description === 'string' ? item.info.description : undefined,
      items: (item.items ?? []).map(itemToInternal),
      _oc: item,
    };
  }
  const t = item.info.type as 'http' | 'grpc' | 'graphql' | 'websocket';
  return {
    id: uuid(),
    type: 'request',
    name: item.info.name,
    request: requestToInternal(item, t),
    _oc: item,
  };
}

function isFolder(item: any): boolean {
  return !item.info?.type && Array.isArray(item.items);
}

function requestToInternal(item: any, kind: 'http' | 'grpc' | 'graphql' | 'websocket'): any {
  switch (kind) {
    case 'http':
      return {
        type: 'http',
        method: item.http.method,
        url: item.http.url,
        headers: (item.http.headers ?? []).map(kvToInternal),
        params: (item.http.params ?? []).map(kvToInternal),
        body: bodyToInternal(item.http.body),
        auth: authToInternal(item.http.auth),
      };
    case 'grpc':
      return {
        type: 'grpc',
        url: item.grpc.url,
        service: item.grpc.service,
        method: item.grpc.method,
        methodType: methodTypeToInternal(item.grpc.methodType),
        message: typeof item.grpc.message === 'string' ? item.grpc.message : JSON.stringify(item.grpc.message ?? ''),
        metadata: (item.grpc.metadata ?? []).map(kvToInternal),
        auth: authToInternal(item.grpc.auth),
      };
    case 'graphql':
      return {
        type: 'graphql',
        url: item.graphql.url,
        query: item.graphql.query ?? '',
        variables: item.graphql.variables ?? '{}',
        headers: (item.graphql.headers ?? []).map(kvToInternal),
        auth: authToInternal(item.graphql.auth),
      };
    case 'websocket':
      return {
        type: 'websocket',
        url: item.websocket.url,
        headers: (item.websocket.headers ?? []).map(kvToInternal),
      };
  }
}

function kvToInternal(kv: any): any {
  return {
    id: uuid(),
    key: kv.name ?? kv.key,
    value: kv.value,
    enabled: kv.enabled ?? true,
    description: typeof kv.description === 'string' ? kv.description : undefined,
  };
}

function bodyToInternal(body: any): any {
  if (!body) return { type: 'none' };
  if (Array.isArray(body)) return { type: 'none', _oc: body }; // body variants — round-trip through _oc for now
  // Heuristic: spec-defined raw body has `raw.<lang>`, multipart has `multipartForm.parts`, formUrlEncoded has `formUrlEncoded.parts`
  if (body.raw) return { type: body.raw.format ?? 'text', raw: body.raw.value ?? '' };
  if (body.multipartForm) return { type: 'form-data', formData: body.multipartForm.parts };
  if (body.formUrlEncoded) return { type: 'x-www-form-urlencoded', formData: body.formUrlEncoded.parts };
  if (body.graphql) return { type: 'graphql', raw: JSON.stringify(body.graphql) };
  if (body.file) return { type: 'binary', binary: body.file };
  return { type: 'none' };
}

function authToInternal(auth: any): any {
  if (!auth || auth.type === 'none') return { type: 'none' };
  switch (auth.type) {
    case 'basic':   return { type: 'basic', basic: { username: auth.username, password: auth.password } };
    case 'bearer':  return { type: 'bearer', bearer: { token: auth.token } };
    case 'apiKey':  return { type: 'api-key', apiKey: { key: auth.key, value: auth.value, in: auth.placement } };
    case 'awsv4':   return { type: 'aws-signature', awsSignature: { accessKey: auth.accessKeyId, secretKey: auth.secretAccessKey, region: auth.region, service: auth.service, sessionToken: auth.sessionToken } };
    case 'digest':  return { type: 'digest', digest: { username: auth.username, password: auth.password } };
    case 'oauth2':  return { type: 'oauth2', oauth2: auth }; // pass-through; runtime not implemented for all flows in Phase 0
    case 'oauth1':
    case 'ntlm':
    case 'wsse':
      // Phase 4 features — store for roundtrip even though runtime support comes later
      return { type: auth.type, [auth.type]: auth };
  }
  return { type: 'none' };
}

function methodTypeToInternal(t?: string): string {
  switch (t) {
    case 'serverStreaming':   return 'server-streaming';
    case 'clientStreaming':   return 'client-streaming';
    case 'bidirectional':     return 'bidirectional-streaming';
    case 'unary':
    default:                  return 'unary';
  }
}

function extractRootVariables(oc: OpenCollection): any[] {
  const env = oc.config?.environments?.[0];
  if (!env?.variables) return [];
  return env.variables.map((v: any) => ({
    id: uuid(),
    key: v.name,
    value: typeof v.value === 'string' ? v.value : JSON.stringify(v.value ?? ''),
    enabled: !v.disabled,
    description: typeof v.description === 'string' ? v.description : undefined,
  }));
}

function extensionItems(ext?: Record<string, unknown>): any[] {
  const out: any[] = [];
  const sse = (ext?.['x-restura-sse'] ?? []) as any[];
  for (const s of sse) {
    out.push({
      id: uuid(),
      type: 'request',
      name: s.info.name,
      request: { type: 'sse', url: s.sse.url, eventFilter: s.sse.eventFilter },
      _oc: s,
    });
  }
  const mcp = (ext?.['x-restura-mcp'] ?? []) as any[];
  for (const m of mcp) {
    out.push({
      id: uuid(),
      type: 'request',
      name: m.info.name,
      request: { type: 'mcp', url: m.mcp.url, transport: m.mcp.transport },
      _oc: m,
    });
  }
  return out;
}
```

- [ ] **Step 5: Run tests**

```bash
npx vitest run src/lib/opencollection/__tests__/to-internal.test.ts
```

Expected: PASS (3/3).

- [ ] **Step 6: Replace `any` with real types**

After Step 1, you have the canonical names. Replace the `Internal = any` and downstream `any`s with the concrete types from `src/types/index.ts` (or wherever they live in this repo). Re-run `npm run type-check`. Fix until clean.

- [ ] **Step 7: Commit**

```bash
git add src/lib/opencollection/to-internal.ts src/lib/opencollection/__tests__/to-internal.test.ts
git commit -m "feat(opencollection): map spec → Restura internal Collection"
```

---

## Task 10: Bridge — Restura internal Collection → OpenCollection

**Why:** The reverse direction. Must use the `_oc` passthrough bag from Task 9 so unmodified items emit byte-stable YAML.

**Files:**
- Create: `src/lib/opencollection/from-internal.ts`
- Create: `src/lib/opencollection/__tests__/from-internal.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, it, expect } from 'vitest';
import { loadCollectionFromFile } from '../fs-reader';
import { ocToInternal } from '../to-internal';
import { internalToOC } from '../from-internal';

describe('internalToOC', () => {
  it('roundtrips simple-http via internal model', async () => {
    const oc = await loadCollectionFromFile('tests/fixtures/opencollection/simple-http.yaml');
    const internal = ocToInternal(oc);
    const oc2 = internalToOC(internal);
    expect(oc2).toEqual(oc);
  });

  it('roundtrips multi-protocol with SSE in extensions', async () => {
    const oc = await loadCollectionFromFile('tests/fixtures/opencollection/multi-protocol.yaml');
    const internal = ocToInternal(oc);
    const oc2 = internalToOC(internal);
    expect(oc2).toEqual(oc);
  });

  it('emits a fresh OC for an internal Collection without _oc passthrough', () => {
    const internal = {
      id: 'x', name: 'Fresh', items: [
        { id: 'r', type: 'request', name: 'Hello', request: { type: 'http', method: 'GET', url: 'https://x', headers: [], params: [], body: { type: 'none' }, auth: { type: 'none' } } },
      ],
    };
    const oc = internalToOC(internal as any);
    expect(oc.info.name).toBe('Fresh');
    expect(oc.items?.[0]).toMatchObject({ info: { type: 'http', name: 'Hello' }, http: { method: 'GET', url: 'https://x' } });
  });
});
```

- [ ] **Step 2: Run to verify fail**

```bash
npx vitest run src/lib/opencollection/__tests__/from-internal.test.ts
```

- [ ] **Step 3: Implement `from-internal.ts`**

```typescript
import type { OpenCollection } from './schemas';

type Internal = any; // Replace with concrete project types — see Task 9 Step 6

export function internalToOC(c: Internal): OpenCollection {
  // If the user hasn't edited anything, just return the cached OC verbatim.
  // Detection: every item still has its _oc bag and root has _oc. This is the byte-stable path.
  if (c._oc && allItemsHaveOcBag(c.items)) {
    return c._oc as OpenCollection;
  }

  // Otherwise rebuild from internal model. SSE/MCP go to extensions.
  const sseItems: unknown[] = [];
  const mcpItems: unknown[] = [];
  const items: unknown[] = [];

  for (const it of c.items ?? []) {
    if (it.type === 'folder') {
      items.push(folderFromInternal(it));
      continue;
    }
    const r = it.request;
    if (!r) continue;
    if (r.type === 'sse') { sseItems.push(it._oc ?? sseToOC(it)); continue; }
    if (r.type === 'mcp') { mcpItems.push(it._oc ?? mcpToOC(it)); continue; }
    items.push(it._oc ?? requestFromInternal(it));
  }

  const oc: OpenCollection = {
    opencollection: '1.0.0',
    info: { name: c.name, ...(c.description ? { summary: c.description } : {}) },
    items,
  };

  if (sseItems.length || mcpItems.length) {
    oc.extensions = {
      ...(sseItems.length ? { 'x-restura-sse': sseItems } : {}),
      ...(mcpItems.length ? { 'x-restura-mcp': mcpItems } : {}),
    };
  }

  if ((c.variables ?? []).length) {
    oc.config = {
      environments: [{
        name: 'default',
        variables: c.variables.filter((v: any) => v.enabled !== false).map((v: any) => ({
          name: v.key, value: v.value, ...(v.description ? { description: v.description } : {}),
        })),
      }],
    };
  }

  return oc;
}

function allItemsHaveOcBag(items: any[] | undefined): boolean {
  if (!items) return true;
  return items.every((it) => it._oc !== undefined && (it.type !== 'folder' || allItemsHaveOcBag(it.items)));
}

function folderFromInternal(it: any): unknown {
  if (it._oc) return it._oc;
  return {
    info: { name: it.name, ...(it.description ? { description: it.description } : {}) },
    items: (it.items ?? []).map((child: any) => child._oc ?? requestFromInternal(child)),
  };
}

function requestFromInternal(it: any): unknown {
  const r = it.request;
  switch (r.type) {
    case 'http':
      return {
        info: { type: 'http', name: it.name },
        http: {
          method: r.method,
          url: r.url,
          ...(r.headers?.length ? { headers: r.headers.filter((h: any) => h.enabled !== false).map(kv) } : {}),
          ...(r.params?.length ? { params: r.params.filter((p: any) => p.enabled !== false).map(kv) } : {}),
          ...(r.body && r.body.type !== 'none' ? { body: bodyFromInternal(r.body) } : {}),
          ...(r.auth && r.auth.type !== 'none' ? { auth: authFromInternal(r.auth) } : {}),
        },
      };
    case 'grpc':
      return {
        info: { type: 'grpc', name: it.name },
        grpc: {
          url: r.url, service: r.service, method: r.method,
          methodType: methodTypeFromInternal(r.methodType),
          ...(r.message ? { message: r.message } : {}),
          ...(r.metadata?.length ? { metadata: r.metadata.map(kv) } : {}),
          ...(r.auth && r.auth.type !== 'none' ? { auth: authFromInternal(r.auth) } : {}),
        },
      };
    case 'graphql':
      return {
        info: { type: 'graphql', name: it.name },
        graphql: { url: r.url, query: r.query, variables: r.variables },
      };
    case 'websocket':
      return {
        info: { type: 'websocket', name: it.name },
        websocket: { url: r.url },
      };
  }
}

function sseToOC(it: any): unknown {
  return {
    info: { type: 'sse', name: it.name },
    sse: { url: it.request.url, ...(it.request.eventFilter ? { eventFilter: it.request.eventFilter } : {}) },
  };
}

function mcpToOC(it: any): unknown {
  return {
    info: { type: 'mcp', name: it.name },
    mcp: { url: it.request.url, transport: it.request.transport },
  };
}

function kv(k: any) {
  return {
    name: k.key,
    value: k.value,
    ...(k.description ? { description: k.description } : {}),
  };
}

function bodyFromInternal(body: any): unknown {
  switch (body.type) {
    case 'json':                       return { raw: { format: 'json', value: body.raw ?? '' } };
    case 'xml':                        return { raw: { format: 'xml', value: body.raw ?? '' } };
    case 'text':                       return { raw: { format: 'text', value: body.raw ?? '' } };
    case 'graphql':                    return { graphql: JSON.parse(body.raw || '{}') };
    case 'binary':                     return { file: body.binary };
    case 'form-data':                  return { multipartForm: { parts: body.formData } };
    case 'x-www-form-urlencoded':      return { formUrlEncoded: { parts: body.formData } };
    default:                           return { raw: { format: 'text', value: '' } };
  }
}

function authFromInternal(a: any): unknown {
  switch (a.type) {
    case 'basic':           return { type: 'basic', username: a.basic.username, password: a.basic.password };
    case 'bearer':          return { type: 'bearer', token: a.bearer.token };
    case 'api-key':         return { type: 'apiKey', key: a.apiKey.key, value: a.apiKey.value, placement: a.apiKey.in };
    case 'aws-signature':   return { type: 'awsv4', accessKeyId: a.awsSignature.accessKey, secretAccessKey: a.awsSignature.secretKey, region: a.awsSignature.region, service: a.awsSignature.service, ...(a.awsSignature.sessionToken ? { sessionToken: a.awsSignature.sessionToken } : {}) };
    case 'digest':          return { type: 'digest', username: a.digest.username, password: a.digest.password };
    case 'oauth2':          return a.oauth2;
    case 'oauth1':
    case 'ntlm':
    case 'wsse':            return a[a.type];
    default:                return { type: 'none' };
  }
}

function methodTypeFromInternal(t?: string): string {
  switch (t) {
    case 'server-streaming':         return 'serverStreaming';
    case 'client-streaming':         return 'clientStreaming';
    case 'bidirectional-streaming':  return 'bidirectional';
    case 'unary':
    default:                         return 'unary';
  }
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run src/lib/opencollection/__tests__/from-internal.test.ts
```

Expected: PASS (3/3).

- [ ] **Step 5: Commit**

```bash
git add src/lib/opencollection/from-internal.ts src/lib/opencollection/__tests__/from-internal.test.ts
git commit -m "feat(opencollection): map Restura internal Collection → spec"
```

---

## Task 11: Public module index

**Why:** One import path for callers. Avoids deep imports leaking module structure.

**Files:**
- Create: `src/lib/opencollection/index.ts`

- [ ] **Step 1: Write the index**

```typescript
export { openCollectionSchema, type OpenCollection } from './schemas';
export { parseOpenCollectionYAML, serializeOpenCollectionYAML } from './serializer';
export { loadCollectionFromFile, loadCollectionFromDir } from './fs-reader';
export { saveCollectionToFile, saveCollectionToDir } from './fs-writer';
export { ocToInternal } from './to-internal';
export { internalToOC } from './from-internal';
```

- [ ] **Step 2: Type-check**

```bash
npm run type-check
```

- [ ] **Step 3: Commit**

```bash
git add src/lib/opencollection/index.ts
git commit -m "feat(opencollection): expose public API"
```

---

## Task 12: Replace renderer's `file-collection-schema.ts` with a re-export shim

**Why:** ~10–15 files import from `@/lib/shared/file-collection-schema`. We don't break them — we make the old module a thin shim that re-exports from `@/lib/opencollection` and keeps legacy filename helpers.

**Files:**
- Modify: `src/lib/shared/file-collection-schema.ts`

- [ ] **Step 1: Find all callers**

```bash
rg "from ['\"]@/lib/shared/file-collection-schema['\"]" --type ts -l
```

Capture the list. The shim needs to re-export everything those files import (specifically: `FILE_EXTENSIONS`, `getRequestTypeFromFilename`, `getFilenameForRequest`, `getNameFromFilename`, all `file*Schema` symbols, all `File*` types).

- [ ] **Step 2: Rewrite the file as a shim**

Replace the entire content of `src/lib/shared/file-collection-schema.ts`:

```typescript
/**
 * @deprecated This module is a compatibility shim. Import from `@/lib/opencollection` directly.
 * Kept so existing imports keep working through the OpenCollection migration. Remove after Phase 1.
 */
export {
  openCollectionSchema as fileCollectionSchema,
  type OpenCollection as FileCollection,
} from '@/lib/opencollection';

// Legacy file-extension constants. New code should not reference these — OpenCollection
// uses unified `.yaml` for everything. These exist only for the importer/exporter UI strings.
export const FILE_EXTENSIONS = {
  COLLECTION_META: 'opencollection.yml',
  FOLDER_META: '_folder.yaml',
  HTTP_REQUEST: '.yaml',
  GRPC_REQUEST: '.yaml',
  SSE_REQUEST: '.yaml',
  MCP_REQUEST: '.yaml',
} as const;

export function getRequestTypeFromFilename(_filename: string): null {
  // OpenCollection determines type from file content (info.type), not extension.
  return null;
}

export function getFilenameForRequest(name: string, _type: 'http' | 'grpc' | 'sse' | 'mcp'): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'item';
  return `${slug}.yaml`;
}

export function getNameFromFilename(filename: string): string {
  return filename
    .replace(/\.yaml$|\.yml$/, '')
    .replace(/-/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
```

- [ ] **Step 3: Type-check, fix any callers that break on shape**

```bash
npm run type-check
```

If any caller relied on the old `fileHttpRequestSchema`, `fileGrpcRequestSchema` (etc.) shape, they need a small fix. The most likely callers are importers and components that build a request preview from raw YAML — they should switch to importing `httpRequestSchema` from `@/lib/opencollection/schemas`.

- [ ] **Step 4: Run all tests**

```bash
npm run test:run
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/shared/file-collection-schema.ts
git commit -m "refactor(file-schema): shim to OpenCollection re-export"
```

---

## Task 13: Replace Electron `collection-manager.ts` duplicated schema

**Why:** `electron/main/collection-manager.ts:28-57` re-declares the file Zod schema. After Task 4, it should import from the renderer module via the relative path `../../src/lib/opencollection/schemas`.

**Files:**
- Modify: `electron/main/collection-manager.ts`

- [ ] **Step 1: Confirm tsconfig allows the import**

```bash
cat electron/tsconfig.json
```

Look for `"rootDir"` and `"include"`. The Electron tsconfig must include `src/lib/opencollection/**` in its compilation (Electron's main process compiles to `dist/electron/`). If `src/` isn't already included, add it.

- [ ] **Step 2: Update tsconfig if needed**

If `electron/tsconfig.json` `include` doesn't cover `src/lib/opencollection`, add:

```json
"include": ["main/**/*.ts", "../src/lib/opencollection/**/*.ts"]
```

And under `compilerOptions`, ensure `paths` resolves `@/*` if you use it. If the schema file uses `@/`-imports internally, switch the OpenCollection module to relative imports for portability — Electron main needs zero alias resolution.

- [ ] **Step 3: Rewrite the duplicated schema block**

In `electron/main/collection-manager.ts`, find lines 27-57 (the `fileKeyValueSchema`, `fileAuthConfigSchema`, `fileCollectionMetaSchema`, `fileFolderMetaSchema` block) and replace with:

```typescript
import {
  openCollectionSchema,
  authSchema,
  environmentSchema,
} from '../../src/lib/opencollection/schemas';

// File extension constants. After OpenCollection migration, all request files use `.yaml`.
const FILE_EXTENSIONS = {
  ROOT: 'opencollection.yml',
  ROOT_ALT: 'opencollection.yaml',
  FOLDER_META: '_folder.yaml',
  REQUEST: '.yaml',
} as const;
```

Then update every downstream reference (`FILE_EXTENSIONS.COLLECTION_META` → `FILE_EXTENSIONS.ROOT`, `FILE_EXTENSIONS.HTTP_REQUEST` → `FILE_EXTENSIONS.REQUEST`, etc.) inside this file. Compile the Electron main:

```bash
npm run electron:compile
```

Fix any errors that arise. The file is ~700 LOC; expect 8–12 lines of follow-on changes.

- [ ] **Step 4: Run all tests**

```bash
npm run test:run
```

- [ ] **Step 5: Smoke-test Electron**

```bash
npm run electron:dev
```

Open the app, open an existing collection (or import one), make sure no console errors. Quit.

- [ ] **Step 6: Commit**

```bash
git add electron/main/collection-manager.ts electron/tsconfig.json
git commit -m "refactor(electron): use shared OpenCollection schema in collection-manager"
```

---

## Task 14: OpenCollection importer

**Why:** Surface the new format as a first-class import option in the existing import menu.

**Files:**
- Create: `src/features/collections/lib/importers/opencollection.ts`
- Modify: `src/features/collections/lib/importers/index.ts`
- Modify: `src/features/collections/lib/importers.ts`

- [ ] **Step 1: Implement the importer**

Create `src/features/collections/lib/importers/opencollection.ts`:

```typescript
import {
  loadCollectionFromFile,
  loadCollectionFromDir,
  parseOpenCollectionYAML,
  ocToInternal,
} from '@/lib/opencollection';

export type OpenCollectionSource =
  | { kind: 'file'; path: string }
  | { kind: 'dir'; path: string }
  | { kind: 'raw'; content: string };

export async function importOpenCollection(source: OpenCollectionSource) {
  switch (source.kind) {
    case 'file': {
      const oc = await loadCollectionFromFile(source.path);
      return ocToInternal(oc);
    }
    case 'dir': {
      const oc = await loadCollectionFromDir(source.path);
      return ocToInternal(oc);
    }
    case 'raw': {
      const oc = parseOpenCollectionYAML(source.content);
      return ocToInternal(oc);
    }
  }
}
```

- [ ] **Step 2: Re-export from `importers/index.ts`**

Edit `src/features/collections/lib/importers/index.ts` to add:

```typescript
export { importOpenCollection } from './opencollection';
export type { OpenCollectionSource } from './opencollection';
```

And update `src/features/collections/lib/importers.ts` (if it's a barrel) similarly.

- [ ] **Step 3: Add a test**

Create `src/features/collections/lib/__tests__/import-opencollection.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { importOpenCollection } from '../importers/opencollection';

describe('importOpenCollection', () => {
  it('imports a file source', async () => {
    const c = await importOpenCollection({ kind: 'file', path: 'tests/fixtures/opencollection/simple-http.yaml' });
    expect(c.name).toBe('Simple HTTP Demo');
    expect(c.items.length).toBe(1);
  });
  it('imports a dir source', async () => {
    const c = await importOpenCollection({ kind: 'dir', path: 'tests/fixtures/opencollection/dir-layout' });
    expect(c.items.length).toBe(1);
  });
});
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run src/features/collections/lib/__tests__/import-opencollection.test.ts
```

- [ ] **Step 5: Wire into the import-menu UI**

Find the import-menu component:

```bash
rg "importPostmanCollection|importInsomniaCollection" src/features/collections --type tsx -l
```

In each component that lists import options, add an "OpenCollection (YAML)" entry that opens a file/folder picker (Electron: `dialog.showOpenDialog`; web: `<input type="file" webkitdirectory>` for directories or single-file). On success, call `importOpenCollection` and dispatch the result through the existing collection-store add path.

- [ ] **Step 6: Manual smoke**

Run `npm run dev`, click import → OpenCollection → choose `tests/fixtures/opencollection/simple-http.yaml`, confirm the request appears in the sidebar.

- [ ] **Step 7: Commit**

```bash
git add src/features/collections
git commit -m "feat(collections): add OpenCollection importer"
```

---

## Task 15: OpenCollection exporter

**Why:** Mirror of Task 14 — write the current Restura collection back to OpenCollection format, either as a single bundled file or a directory.

**Files:**
- Modify: `src/features/collections/lib/exporters.ts`

- [ ] **Step 1: Add the export function**

In `src/features/collections/lib/exporters.ts`, add:

```typescript
import { internalToOC, serializeOpenCollectionYAML, saveCollectionToDir, saveCollectionToFile } from '@/lib/opencollection';

export type OpenCollectionExportTarget =
  | { kind: 'bundled-file' } // returns YAML string in `files`
  | { kind: 'dir'; path: string }; // writes directly to disk (Electron only)

export async function exportOpenCollection(
  collection: any /* Collection */,
  target: OpenCollectionExportTarget
): Promise<{ files: Map<string, string> }> {
  const oc = internalToOC(collection);
  if (target.kind === 'bundled-file') {
    const yaml = serializeOpenCollectionYAML({ ...oc, bundled: true });
    return { files: new Map([['opencollection.yaml', yaml]]) };
  }
  // dir target writes directly
  await saveCollectionToDir(oc, target.path);
  return { files: new Map() };
}
```

- [ ] **Step 2: Add a test**

```typescript
// src/features/collections/lib/__tests__/export-opencollection.test.ts
import { describe, it, expect } from 'vitest';
import { exportOpenCollection } from '../exporters';
import { importOpenCollection } from '../importers/opencollection';

describe('exportOpenCollection', () => {
  it('roundtrips a collection through bundled-file export → import', async () => {
    const original = await importOpenCollection({ kind: 'file', path: 'tests/fixtures/opencollection/multi-protocol.yaml' });
    const { files } = await exportOpenCollection(original, { kind: 'bundled-file' });
    const yaml = files.get('opencollection.yaml')!;
    const reimported = await importOpenCollection({ kind: 'raw', content: yaml });
    // Compare on stable shape: same names, same types
    expect(reimported.items.map((i: any) => i.name)).toEqual(original.items.map((i: any) => i.name));
  });
});
```

- [ ] **Step 3: Run tests**

```bash
npx vitest run src/features/collections/lib/__tests__/export-opencollection.test.ts
```

- [ ] **Step 4: Wire into export menu**

Find the export menu component (parallel to import in Task 14 Step 5) and add an "OpenCollection (YAML)" option:
- For bundled-file: use the existing browser-download path with the returned string
- For directory: only show in Electron; calls `dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })`

- [ ] **Step 5: Manual smoke**

Run `npm run dev`. Open a built-in or imported collection, click export → OpenCollection (bundled). The downloaded file should re-import cleanly.

- [ ] **Step 6: Commit**

```bash
git add src/features/collections/lib
git commit -m "feat(collections): add OpenCollection exporter"
```

---

## Task 16: Chokidar watcher hardening

**Why:** Watcher already exists in `electron/main/collection-manager.ts` but lacks debouncing — saving multiple files in a burst (which Restura does on directory export) fires N events. Renderer should see one. Also verify the IPC channel name and event payload match what `useFileCollectionStore` expects.

**Files:**
- Modify: `electron/main/collection-manager.ts`

- [ ] **Step 1: Locate the watcher**

```bash
rg "chokidar.watch|activeWatchers" electron/main/collection-manager.ts -n
```

Find where `chokidar.watch(...)` is called and where it sends IPC events.

- [ ] **Step 2: Add a debounce helper**

Inside `collection-manager.ts`, add near the top:

```typescript
function debounce<F extends (...args: any[]) => void>(fn: F, ms: number): F {
  let timer: NodeJS.Timeout | null = null;
  let lastArgs: unknown[] = [];
  return ((...args: unknown[]) => {
    lastArgs = args;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...(lastArgs as Parameters<F>));
    }, ms);
  }) as F;
}
```

- [ ] **Step 3: Wrap the IPC emitter in the watcher's `on('all', ...)` handler**

Wherever the watcher currently does `mainWindow.webContents.send('collection:file-changed', payload)`, wrap that send in a debounced version with 250ms wait:

```typescript
const sendChanged = debounce((payload: { collectionId: string; changedFiles: string[] }) => {
  mainWindow.webContents.send('collection:file-changed', payload);
}, 250);

watcher.on('all', (event, filePath) => {
  // accumulate files in a Set keyed per collection — pseudocode; fit to your existing handler
  const ids = pendingChanges.get(collectionId) ?? new Set<string>();
  ids.add(filePath);
  pendingChanges.set(collectionId, ids);
  sendChanged({ collectionId, changedFiles: Array.from(ids) });
});
```

Where `pendingChanges` is a `Map<string, Set<string>>` declared at module scope and cleared inside the debounced function.

- [ ] **Step 4: Add an integration test**

Create `electron/main/__tests__/watcher.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Test the debounce helper in isolation. Full watcher integration is covered by the
// Playwright e2e test in Task 17.
import { debounce } from '../collection-manager';

describe('debounce', () => {
  it('coalesces multiple calls within the window', async () => {
    const fn = vi.fn();
    const d = debounce(fn, 50);
    d(1); d(2); d(3);
    expect(fn).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 80));
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(3);
  });
});
```

If `debounce` isn't exported, export it.

- [ ] **Step 5: Run tests**

```bash
npx vitest run electron/main/__tests__/watcher.test.ts
```

- [ ] **Step 6: Manual verification**

```bash
npm run electron:dev
```

Open a directory-layout collection (Task 14). In a terminal, `echo "  # noop" >> tests/fixtures/opencollection/dir-layout/users/get-user.yaml`. Within ~300ms the renderer should receive a `collection:file-changed` event (visible in DevTools console if you `console.log` in `useFileCollectionStore.markModified`).

- [ ] **Step 7: Commit**

```bash
git add electron/main/collection-manager.ts electron/main/__tests__/watcher.test.ts
git commit -m "feat(collection-manager): debounce watcher events"
```

---

## Task 17: End-to-end Playwright smoke test

**Why:** Proves the full loop: open a directory collection → run a request → modify → save → diff is clean.

**Files:**
- Create: `tests/e2e/opencollection-roundtrip.spec.ts`

- [ ] **Step 1: Write the test**

```typescript
import { test, expect } from '@playwright/test';
import { execSync } from 'node:child_process';
import { mkdtempSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test.describe('OpenCollection roundtrip @e2e', () => {
  let tmpRepo: string;

  test.beforeAll(() => {
    tmpRepo = mkdtempSync(join(tmpdir(), 'oc-e2e-'));
    cpSync('tests/fixtures/opencollection/dir-layout', tmpRepo, { recursive: true });
    execSync('git init -q && git add . && git -c user.email=test@x.y -c user.name=t commit -q -m base', { cwd: tmpRepo });
  });

  test.afterAll(() => { rmSync(tmpRepo, { recursive: true, force: true }); });

  test('open dir → run request → save back → diff is clean', async ({ page }) => {
    await page.goto('http://localhost:5173/');

    // Open via "Import OpenCollection (Directory)" menu
    await page.getByRole('button', { name: /import|new collection/i }).click();
    await page.getByText(/opencollection/i).click();
    await page.getByText(/directory/i).click();

    // The directory picker is OS-native in Electron; in web mode this test is skipped.
    test.skip(process.env.PLAYWRIGHT_TARGET !== 'electron', 'Directory import requires Electron in this test');

    // (Electron path — replace with your existing electron Playwright bootstrap)
    // ... select tmpRepo via dialog stub
    // ... assert "Get User" appears in the sidebar
    await expect(page.getByText('Get User')).toBeVisible();

    // Run the request — assumes a httpbin-like mock or skip if no network in CI
    // ... click Send, see status

    // Edit URL, save, expect diff
    await page.getByText('Get User').click();
    await page.getByLabel(/url/i).fill('{{API_HOST}}/users/2');
    await page.keyboard.press('Control+S'); // or your save shortcut

    const diff = execSync('git diff --unified=0', { cwd: tmpRepo, encoding: 'utf8' });
    expect(diff).toMatch(/-.*users\/1/);
    expect(diff).toMatch(/\+.*users\/2/);
    expect(diff.split('\n').filter((l) => l.startsWith('+') || l.startsWith('-')).length).toBeLessThan(10);
  });
});
```

- [ ] **Step 2: Run the test in web mode (skipped) and electron mode (full)**

```bash
PLAYWRIGHT_TARGET=electron npx playwright test tests/e2e/opencollection-roundtrip.spec.ts
```

If the existing Playwright suite doesn't have an Electron launcher, gate this test on `process.env.PLAYWRIGHT_TARGET === 'electron'` and document in the test how to run it. Don't block the plan on building Electron Playwright infra if it doesn't already exist — the unit-test roundtrips from Tasks 8 and 15 cover the format correctness; the e2e is a smoke for UX.

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/opencollection-roundtrip.spec.ts
git commit -m "test(e2e): OpenCollection directory roundtrip smoke"
```

---

## Task 18: Validation pass and changelog

**Why:** Bring everything together: full validate, update CHANGELOG, document the new format in user-facing docs.

**Files:**
- Modify: `docs/CHANGELOG.md`
- Modify: `docs/ARCHITECTURE.md`
- Create: `docs/opencollection.md`

- [ ] **Step 1: Run full validation**

```bash
npm run validate
```

Expected: all green. Fix any drift before continuing.

- [ ] **Step 2: Update `docs/CHANGELOG.md`**

Prepend a new entry under "Unreleased":

```markdown
### Added
- Native support for **OpenCollection v1.0.0** — Restura now reads and writes the same YAML format as Bruno 3.1+.
- Importer + exporter for OpenCollection (single-file and directory layouts).
- `src/lib/opencollection/` module: schemas, serializer, fs-reader, fs-writer, internal-model bridges.
- Vendored OpenCollection schema at `vendor/opencollection/v1.0.0/`.

### Changed
- `electron/main/collection-manager.ts` now imports its YAML schema from the shared OpenCollection module instead of redeclaring it.
- File watcher in Electron debounces with a 250ms window to avoid duplicate events on multi-file saves.

### Deprecated
- `src/lib/shared/file-collection-schema.ts` is now a thin shim re-exporting from `@/lib/opencollection`. Will be removed in Phase 1.
```

- [ ] **Step 3: Add `docs/opencollection.md`**

```markdown
# OpenCollection in Restura

Restura uses the [OpenCollection v1.0.0](https://spec.opencollection.com/) specification as its
git-native YAML format. This makes Restura collections directly compatible with Bruno 3.1+ and
any other OpenCollection-compliant tool.

## Layout

A collection on disk is either:

**Bundled (single file):**
```yaml
opencollection: "1.0.0"
info:
  name: My API
bundled: true
items:
  - info: { type: http, name: Health }
    http: { method: GET, url: https://example.com/health }
```

**Directory (multi-file, recommended for git):**
```
my-api/
├── opencollection.yml         # collection metadata + config
├── users/
│   ├── _folder.yaml           # folder metadata
│   ├── get-user.yaml          # one request per file (slugified name)
│   └── create-user.yaml
└── posts/
    └── ...
```

## Restura-specific extensions

OpenCollection v1.0.0 doesn't yet cover SSE or MCP. Restura stores them under the spec's
free-form `extensions` field:

```yaml
extensions:
  x-restura-sse:
    - info: { type: sse, name: Events }
      sse: { url: https://example.com/events }
  x-restura-mcp:
    - info: { type: mcp, name: Inspector }
      mcp: { url: http://localhost:3000, transport: streamable-http }
```

These extensions are roundtrip-stable: tools that don't understand them ignore them; Restura
re-emits them on save.

## Importing & exporting

- **Import:** Sidebar → Import → OpenCollection → choose file or directory
- **Export:** Collection menu → Export → OpenCollection (bundled file or directory)

Bundled output is convenient for sharing a single file; directory output is recommended for
checking into git, since each request is its own diffable file.
```

- [ ] **Step 4: Update `docs/ARCHITECTURE.md`**

Add a section "Collection format" pointing to `docs/opencollection.md`. Keep it short — one paragraph.

- [ ] **Step 5: Final commit**

```bash
git add docs
git commit -m "docs(opencollection): user guide and architecture note"
```

---

## Self-Review Checklist

Run through this before declaring Phase 0 complete:

- [ ] Every task in this plan is committed and pushed.
- [ ] `npm run validate` is green.
- [ ] `npm run electron:dev` opens the app, imports `tests/fixtures/opencollection/dir-layout`, and runs a request without errors.
- [ ] A modified request, saved, produces a `git diff` containing only the expected hunk (the value being changed) — no churn from re-emitted comments, key reordering, or whitespace.
- [ ] The vendored schema commit hash in `vendor/opencollection/v1.0.0/SOURCE.md` matches the actual upstream HEAD as of plan execution day, and `npm run verify:opencollection-types` passes.
- [ ] No file in `src/lib/opencollection/` exceeds 600 lines. If one does (likely `from-internal.ts`), split before declaring done.
- [ ] `git grep "fileCollectionMetaSchema\|fileFolderMetaSchema"` returns only the shim file. The duplicated schema is gone.

If any of these are false, fix before moving on. Phase 1 reads from this foundation and silent breakage compounds.

---

## Appendix A — Command cheat-sheet

```bash
# Regenerate types after upstream schema bump
npm run gen:opencollection-types

# Verify types are in sync
npm run verify:opencollection-types

# Single-task test runs
npx vitest run src/lib/opencollection/__tests__/

# Full validate
npm run validate

# Manual Electron smoke
npm run electron:dev
```

## Appendix B — Risk register

| Risk | Likelihood | Mitigation |
|---|---|---|
| OpenCollection spec adds breaking changes in v1.x | Medium | Pinned vendor copy. Bump intentionally with a re-test cycle. |
| `js-yaml` reorders keys on roundtrip | Low | Use `sortKeys: false`. Roundtrip tests in Task 8 catch drift. |
| `_oc` passthrough bag leaks into UI state | Medium | Do not bind UI components to `_oc`. Keep it on the model only. Filter before dispatching to Zustand if needed. |
| Auto-generated types don't match Zod-validated runtime | Low | Both derive from the same vendored schema. Mismatch surfaces in Task 4 tests immediately. |
| Slugified filename collides with another in same folder | Low | Append `-2`, `-3` on collision. Implement in Task 7's `slugify` if the e2e test catches it. |
| Watcher fires for files Restura just wrote | Medium | Already handled via mtime tracking in `collection-manager.ts`. Verify in Task 16's manual test. |
