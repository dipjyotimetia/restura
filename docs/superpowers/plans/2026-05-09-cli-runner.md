# CLI Runner + JUnit/HTML Reporters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a `restura` CLI binary that consumes the Git-native file collections (`*.http.yaml`, `*.grpc.yaml`, etc. from Plan 1's file-collection schema), runs every request, executes pre/post test scripts via the existing QuickJS sandbox, and emits results in JSON / JUnit XML / self-contained HTML reporters. CI integration is the wedge — Bruno's `bru run` and Postman's `newman` are why teams adopt those tools, and Restura matches both with a single binary that reuses 90% of the existing shared protocol layer.

**Architecture:** New `cli/` directory at the repo root with its own `package.json` (workspace) and `tsconfig.json`. The CLI is the **third backend** that consumes `shared/protocol/`: where the Worker uses `globalThis.fetch` and Electron uses `undici`, the CLI also uses `undici`. All validation, header sanitisation, body building, and response shaping flow through `executeHttpProxy` / `executeGrpcProxy` / `validateMcpSpec` unchanged. Tests run via the existing `ScriptExecutor` (QuickJS WASM). Reporters are pluggable via a small `Reporter` interface; bundled reporters are JSON, JUnit, HTML.

**Tech Stack:** Node 22+ (per repo `engines`), `commander` for arg parsing (small, no flag-soup), `js-yaml` (already a dep — used for the file-collection format), `undici` (added as direct dep in Plan 4), `@bufbuild/protobuf` is NOT pulled in (gRPC unary uses Connect framing manually like `worker/handlers/grpc.ts`). The CLI is published as a separate npm package `@restura/cli` so users can `npm install -g @restura/cli` without pulling the entire renderer. Build via `tsc` + `pkg` or `tsup` for a single-file binary; pick `tsup` (simpler, ESM-friendly).

---

## File structure

**Created:**

```
cli/
  package.json              # @restura/cli, bin: { restura: ./dist/index.js }
  tsconfig.json             # extends ../tsconfig.base.json; baseUrl=..; paths to @shared
  src/
    index.ts                # CLI entry — commander setup
    commands/
      run.ts                # restura run <collection-dir>
      list.ts               # restura list <collection-dir> — prints requests
      version.ts            # restura version
    runner/
      runner.ts             # core: load → iterate → execute → report
      scriptHost.ts         # wraps ScriptExecutor for CLI use
      collectionLoader.ts   # loads file-collection from disk
      envLoader.ts          # loads --env JSON/YAML file → KeyValue[]
      undiciFetcher.ts      # Fetcher implementation for Node
      grpcConnectClient.ts  # Connect-protocol unary gRPC over undici
    reporters/
      types.ts              # Reporter interface
      json.ts
      junit.ts
      html.ts
    util/
      ansi.ts               # tiny color helpers (no chalk dep)
      time.ts
    __tests__/
      runner.test.ts
      collectionLoader.test.ts
      envLoader.test.ts
      reporters/junit.test.ts
      reporters/html.test.ts
      cli-e2e.test.ts       # spawns the CLI binary against a fixture collection
  fixtures/
    sample-collection/
      _collection.yaml
      get-user.http.yaml
      list-posts.http.yaml
docs/
  cli/
    README.md               # CLI usage docs
    ci-examples/
      github-actions.yml
      gitlab-ci.yml
      circleci.yml
docs/adr/0005-cli-runner.md
```

**Modified:**

- `package.json` (root) — add `cli` to `workspaces` array if using npm workspaces, OR keep cli's package.json fully independent (decide based on existing repo setup; check for existing `workspaces` field)
- `package-lock.json` — `npm install` with the new deps
- `docs/ARCHITECTURE.md` — add "CLI runner" section explaining how it reuses the shared protocol layer

---

## Tasks

### Task 1: CLI scaffolding (package, tsconfig, build)

**Files:**

- Create: `cli/package.json`
- Create: `cli/tsconfig.json`
- Create: `cli/src/index.ts` — minimal `restura --version` smoke
- Create: `cli/README.md` — placeholder
- Modify: root `package.json` — add cli as a workspace if appropriate

- [ ] **Step 1: Decide on the workspace strategy**

```bash
cd /Users/dipjyotimetia/Documents/working/ccviews/restura
grep -E '"workspaces"' package.json
```

If `workspaces` is already in the root `package.json` → add `cli` to it. If not → keep `cli/` as an independent npm package with its own `package-lock.json`. Pick based on existing convention.

- [ ] **Step 2: Create `cli/package.json`**

```json
{
  "name": "@restura/cli",
  "version": "0.1.0",
  "description": "Restura CLI — run API collections in CI with JUnit/HTML/JSON reporters",
  "license": "MIT",
  "type": "module",
  "main": "./dist/index.js",
  "bin": {
    "restura": "./dist/index.js"
  },
  "files": ["dist", "README.md"],
  "engines": { "node": ">=22" },
  "scripts": {
    "build": "tsup src/index.ts --format esm --target node22 --clean --dts",
    "dev": "tsup src/index.ts --format esm --target node22 --watch",
    "test": "vitest run",
    "type-check": "tsc --noEmit"
  },
  "dependencies": {
    "commander": "^12.0.0",
    "js-yaml": "^4.1.1",
    "undici": "^7.0.0",
    "quickjs-emscripten": "^0.32.0"
  },
  "devDependencies": {
    "tsup": "^8.0.0",
    "typescript": "^5"
  }
}
```

Note: `quickjs-emscripten` is duplicated in cli/ deps because the CLI runs scripts standalone. Consider hoisting to root if using workspaces.

- [ ] **Step 3: Create `cli/tsconfig.json`**

```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "types": ["node", "vitest/globals"],
    "outDir": "./dist",
    "rootDir": "..",
    "noEmit": false,
    "declaration": false,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": false,
    "baseUrl": "..",
    "paths": {
      "@shared/*": ["shared/*"]
    }
  },
  "include": ["src/**/*.ts", "../shared/**/*.ts"],
  "exclude": ["node_modules", "dist", "fixtures"]
}
```

- [ ] **Step 4: Create `cli/src/index.ts` smoke**

```ts
#!/usr/bin/env node
import { Command } from 'commander';

const program = new Command();
program.name('restura').description('Restura CLI — run API collections in CI').version('0.1.0');

program.parse();
```

- [ ] **Step 5: Build + smoke**

```bash
cd cli && npm install && npm run build && node ./dist/index.js --version
```

Expected: prints `0.1.0`.

- [ ] **Step 6: Commit**

```bash
cd /Users/dipjyotimetia/Documents/working/ccviews/restura
git add cli/package.json cli/tsconfig.json cli/src/index.ts cli/README.md package.json package-lock.json
git commit -m "feat(cli): scaffold restura CLI package"
```

---

### Task 2: Collection loader

**Files:**

- Create: `cli/src/runner/collectionLoader.ts`
- Create: `cli/src/runner/__tests__/collectionLoader.test.ts`
- Create: `cli/fixtures/sample-collection/_collection.yaml`
- Create: `cli/fixtures/sample-collection/get-user.http.yaml`

Reuse the file-collection schema from Plan 1 (`src/lib/shared/file-collection-schema.ts`). The loader walks a directory recursively, reads each `*.{http,grpc,sse,mcp}.yaml`, and returns a flat array of `{ filePath, request }` pairs. Folder structure becomes the request path.

- [ ] **Step 1: Write fixtures**

```yaml
# cli/fixtures/sample-collection/_collection.yaml
name: Sample
description: Demo collection for CLI tests
variables:
  - { key: API_BASE, value: https://api.example.com }

# cli/fixtures/sample-collection/get-user.http.yaml
name: Get user
method: GET
url: '{{API_BASE}}/users/1'
headers:
  - { key: Accept, value: application/json }
testScript: |
  pm.test('status is 200', () => {
    if (response.status !== 200) throw new Error('expected 200, got ' + response.status);
  });
```

- [ ] **Step 2: Write loader tests + implementation**

Public API:

```ts
export interface LoadedRequest {
  filePath: string; // absolute
  relativePath: string; // relative to collection root
  type: 'http' | 'grpc' | 'sse' | 'mcp';
  request: HttpRequest | GrpcRequest | SseRequest | McpRequest;
}

export async function loadCollection(directoryPath: string): Promise<{
  meta: FileCollectionMeta;
  requests: LoadedRequest[];
}>;
```

Reuse `file-collection-schema.ts` parsers (`fileHttpRequestSchema`, etc.). Walk the dir with `fs.readdir({ recursive: true })` (Node 20+).

- [ ] **Step 3: Run + commit**

```bash
cd cli && npm test -- collectionLoader
cd ..
git add cli/
git commit -m "feat(cli): collection loader from file-collection-schema"
```

---

### Task 3: Env loader

**Files:**

- Create: `cli/src/runner/envLoader.ts`
- Create: `cli/src/runner/__tests__/envLoader.test.ts`

`--env path/to/env.{json,yaml}` loads variables. Format compatible with Postman's environment export AND a simpler flat `{key: value}` object.

```ts
export async function loadEnv(filePath: string): Promise<Record<string, string>>;
```

Detect format by extension. Resolve `${ENV_VAR}` references in values from `process.env` so secrets can come from CI env vars instead of being committed.

- [ ] **Step 1-N: TDD as before, commit**

---

### Task 4: undici Fetcher (the third backend)

**Files:**

- Create: `cli/src/runner/undiciFetcher.ts`
- Create: `cli/src/runner/__tests__/undiciFetcher.test.ts`

Implements the `Fetcher` interface from `@shared/protocol/types` using `undici.request`. ~50 lines. Should support:

- All HTTP methods
- Streaming response body via `Readable.toWeb`
- ALPN capture (h1.1 / h2 — same pattern as the Electron undici fetcher in Plan 4)
- AbortSignal forwarding
- Custom dispatcher for proxies (later — not in scope for v0.1)

```ts
import { request as undiciRequest, Agent } from 'undici';
import { Readable } from 'node:stream';
import type { Fetcher, FetcherRequest, FetcherResponse } from '@shared/protocol/types';

export const undiciFetcher: Fetcher = async (req: FetcherRequest): Promise<FetcherResponse> => {
  const response = await undiciRequest(req.url, {
    method: req.method as Parameters<typeof undiciRequest>[1] extends { method?: infer M }
      ? M
      : never,
    headers: req.headers,
    body: req.body as undefined,
    signal: req.signal,
  });
  return {
    status: response.statusCode,
    statusText: '',
    headers: Object.fromEntries(
      Object.entries(response.headers).map(([k, v]) => [k, v as string | string[]])
    ),
    text: () => response.body.text(),
    contentLengthHeader: (response.headers['content-length'] as string | undefined) ?? null,
    body: Readable.toWeb(response.body) as ReadableStream<Uint8Array>,
  };
};
```

- [ ] **Step 1-N: TDD against a local HTTP fixture (use Vitest's `setupFiles` to spin up a small `http.createServer`)**

---

### Task 5: Script host

**Files:**

- Create: `cli/src/runner/scriptHost.ts`
- Create: `cli/src/runner/__tests__/scriptHost.test.ts`

Wraps `ScriptExecutor` from `src/features/scripts/lib/scriptExecutor.ts` for CLI use. The CLI's environment context comes from the loaded env file + collection variables; the result feeds back into the runner's pass/fail tally.

```ts
import ScriptExecutor, { type ScriptResult } from '@/features/scripts/lib/scriptExecutor';

export interface ScriptRunArgs {
  script: string;
  envVars: Record<string, string>;
  request: { url: string; method: string; headers: Record<string, string>; body?: unknown };
  response?: {
    status: number;
    statusText: string;
    headers: Record<string, string>;
    body: unknown;
    time: number;
    size: number;
  };
}

export async function runScript(args: ScriptRunArgs): Promise<ScriptResult>;
```

Note: importing `@/features/...` from the CLI requires the CLI tsconfig to have a path alias `@/* → src/*` AND the build to bundle the renderer code. Check for tree-shake side effects — the renderer's scriptExecutor must not pull in React or DOM globals. If it does, extract the QuickJS-using core into `shared/protocol/script-executor.ts` first (potential refactor at Task 5 step 0).

- [ ] **Step 0: Verify scriptExecutor has no DOM / React deps**

```bash
rg -n "import .* from 'react'|window\.|document\." src/features/scripts/lib/scriptExecutor.ts
```

If clean → CLI can import directly. If not → extract to `shared/protocol/`.

- [ ] **Step 1-N: TDD, commit**

---

### Task 6: Runner core

**Files:**

- Create: `cli/src/runner/runner.ts`
- Create: `cli/src/runner/__tests__/runner.test.ts`

The orchestrator. Iterates the loaded collection, executes each request via `executeHttpProxy(spec, undiciFetcher, ...)`, runs pre/post test scripts, accumulates a result tree, and feeds reporters.

Public API:

```ts
export interface RunResult {
  meta: { name: string; startedAt: number; durationMs: number };
  requests: RequestRunResult[];
  summary: { total: number; passed: number; failed: number; errored: number };
}

export interface RequestRunResult {
  request: LoadedRequest;
  response?: NormalizedResponse;
  preRequestScript?: ScriptResult;
  testScript?: ScriptResult;
  error?: string;
  durationMs: number;
}

export interface RunOptions {
  envVars: Record<string, string>;
  bail: boolean; // stop on first failure
  parallel: number; // concurrent requests; default 1
}

export async function runCollection(
  collectionDir: string,
  options: RunOptions,
  reporter: Reporter
): Promise<RunResult>;
```

Report events as the run progresses:

- `onStart(meta)`
- `onRequestStart(request)`
- `onRequestComplete(result)`
- `onEnd(result)`

So the `live` reporter (default — prints to terminal) can show progress in real time.

- [ ] **Step 1-N: TDD, commit**

---

### Task 7: JSON reporter

**Files:**

- Create: `cli/src/reporters/types.ts`
- Create: `cli/src/reporters/json.ts`
- Create: `cli/src/reporters/__tests__/json.test.ts`

```ts
export interface Reporter {
  onStart?(meta: { name: string; startedAt: number }): void;
  onRequestStart?(request: LoadedRequest): void;
  onRequestComplete?(result: RequestRunResult): void;
  onEnd(result: RunResult): void | Promise<void>;
}
```

JSON reporter: writes a single JSON file at `--output path/to/results.json` containing the full `RunResult`. Useful for downstream tooling.

- [ ] **Step 1-N: TDD, commit**

---

### Task 8: JUnit reporter

**Files:**

- Create: `cli/src/reporters/junit.ts`
- Create: `cli/src/reporters/__tests__/junit.test.ts`

JUnit XML format consumed by every CI system on earth. Each `LoadedRequest` becomes a `<testcase>`; each `pm.test()` inside the test script becomes a child assertion. A failing assertion or a network error becomes a `<failure>`.

```xml
<testsuites name="Sample" tests="2" failures="0" time="0.45">
  <testsuite name="Sample" tests="2" failures="0" time="0.45">
    <testcase classname="Get user" name="status is 200" time="0.21" />
    <testcase classname="List posts" name="returns array" time="0.24" />
  </testsuite>
</testsuites>
```

- [ ] **Step 1-N: TDD, commit**

---

### Task 9: HTML reporter

**Files:**

- Create: `cli/src/reporters/html.ts`
- Create: `cli/src/reporters/__tests__/html.test.ts`

Self-contained HTML page (no external assets, no JS frameworks). Inline CSS, inline JSON data via `<script type="application/json" id="results">`, small inline JS to render the tree. Aim for ~300 lines of generated HTML max.

- [ ] **Step 1-N: TDD, commit**

---

### Task 10: `restura run` command

**Files:**

- Create: `cli/src/commands/run.ts`
- Modify: `cli/src/index.ts`
- Create: `cli/src/__tests__/cli-e2e.test.ts` — spawns the binary against the sample fixture

```bash
restura run <collection-dir> [options]
  --env <file>          Path to env file (json or yaml)
  --reporter <name>     json | junit | html | live (default)
  --output <file>       Output path for json/junit/html
  --bail                Stop on first failure
  --parallel <n>        Concurrent requests (default 1)
  --timeout <ms>        Per-request timeout (default 30000)
  --allow-localhost     Permit requests to localhost / 127.0.0.1 (off by default for safety)
```

Exit code 0 on all-pass; exit code 1 on any failure or error.

E2E test: spawn `node cli/dist/index.js run cli/fixtures/sample-collection --reporter json --output /tmp/r.json` and assert exit code + JSON shape.

- [ ] **Step 1-N: TDD, commit**

---

### Task 11: gRPC unary support (HTTP support is enough for v0.1; gRPC is a value-add)

**Files:**

- Create: `cli/src/runner/grpcConnectClient.ts`
- Create: `cli/src/runner/__tests__/grpcConnectClient.test.ts`
- Modify: `cli/src/runner/runner.ts` — dispatch by request.type

For requests with `type: 'grpc'`, send Connect-protocol JSON (same shape as `worker/handlers/grpc.ts`). Use the same `executeGrpcProxy(spec, undiciFetcher, options)` from `shared/protocol/grpc-proxy.ts`. No proto loading required for unary Connect — JSON over HTTP/1.1 or h2 to `${url}/${service}/${method}`.

For SSE, MCP — out of scope for v0.1 (CLI users hitting SSE would want streaming output, which is a separate UX). Document as follow-up.

- [ ] **Step 1-N: TDD, commit**

---

### Task 12: CI examples + ADR + docs

**Files:**

- Create: `docs/cli/README.md` — usage docs
- Create: `docs/cli/ci-examples/github-actions.yml`
- Create: `docs/cli/ci-examples/gitlab-ci.yml`
- Create: `docs/cli/ci-examples/circleci.yml`
- Create: `docs/adr/0005-cli-runner.md`
- Modify: `docs/ARCHITECTURE.md` — add CLI runner section

GitHub Actions example:

```yaml
name: API tests
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '22' }
      - run: npm install -g @restura/cli
      - run: restura run ./api-tests --reporter junit --output junit.xml
      - if: always()
        uses: actions/upload-artifact@v4
        with: { name: junit-results, path: junit.xml }
```

ADR captures:

- Why a separate package (vs bundling into the existing electron build): users want `npm install -g` for CI without pulling Electron + Monaco + React
- Why undici (already a Plan 4 dep, single backend story)
- Why no proto codegen for gRPC (Connect-JSON over HTTP works without it)
- Why JUnit + HTML + JSON only (covers 99% of CI consumers; users with niche needs can write a custom reporter against the JSON output)

- [ ] **Step 1-N: write, commit**

---

## Self-review checklist

- [ ] `cd cli && npm run build && node dist/index.js --version` returns `0.1.0`
- [ ] `node dist/index.js run fixtures/sample-collection` runs against the fixture (with a network mock, OR a publicly reachable endpoint like `https://httpbin.org`)
- [ ] All three reporters produce parseable output (JSON parses; JUnit XML validates against an xsd; HTML opens in a browser)
- [ ] Exit code 1 on `--bail` after a failed test
- [ ] `npm run validate` (root) still passes — adding the CLI doesn't break the existing test suite
- [ ] CLI tests pass standalone: `cd cli && npm test`
- [ ] gRPC unary against a Connect server returns parsed messages
- [ ] CI example yaml files actually parse as valid GitHub Actions / GitLab CI / CircleCI configs (lint via `yamllint` or paste into a real CI to verify)

---

## Out of scope (future plans)

- **Streaming output for SSE/NDJSON in CLI**: needs a different UX (terminal streaming or per-event reporter)
- **gRPC streaming methods in CLI**: out of scope for v0.1
- **Proxy support in CLI** (HTTP/SOCKS): not needed for typical CI use; future enhancement
- **Watch mode** (`restura run --watch`): rerun on file changes; useful for local TDD against API contracts; future
- **Snapshot testing** (compare response to last-known-good): future
- **Workflow execution** (multi-request workflows from `useWorkflowStore`): the renderer has this; CLI delegates to it via shared module
