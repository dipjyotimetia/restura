# restura-cli

Run Restura API collections in CI — assert with scripts, get JUnit / HTML / JSON reports.

## Install

```bash
npm install -g restura-cli
# or, no install:
npx restura-cli run ./my-collection
```

Requires Node.js 24+.

## Quick start

Export a collection from the Restura app (File → Export → OpenCollection directory), then:

```bash
restura run ./my-collection --reporter junit --reporter-output junit=results.xml
```

Exit code is `0` when every request passed, `1` if any failed, `2` on internal errors (missing collection, bad flags).

## Supported collection formats

The loader auto-detects three layouts:

| Layout                                   | Detected when…                                                  |
| ---------------------------------------- | --------------------------------------------------------------- |
| **OpenCollection directory** (preferred) | the target directory contains `opencollection.yml` (or `.yaml`) |
| **OpenCollection bundled file**          | the target path ends in `.yaml`/`.yml`                          |
| **Legacy file-collection** (deprecated)  | the target directory contains `_collection.yaml`                |

The legacy format prints a stderr deprecation warning the first time it's loaded.

## Supported protocols

- **HTTP / REST** — full support
- **GraphQL** — runs as HTTP with body type `graphql`
- **gRPC** — via Connect protocol (JSON-encoded, no proto compilation needed)
- **SSE** — captures events for `--sse-duration` ms, or until `--sse-events N`
- **MCP** — single JSON-RPC POST per request
- **WebSocket** — standalone executor available; not yet wired into the dispatcher (see `executors/websocket.ts`)

Header-based auth (Bearer, Basic, API-key, OAuth2 access token) is applied to HTTP/GraphQL, gRPC (as metadata), SSE, and MCP requests. Wire-signed schemes (AWS SigV4, OAuth1, WSSE) are signed at the wire on the HTTP path. `x-www-form-urlencoded` bodies are sent for both inline (`raw`) and structured (OpenCollection field-array) forms; `multipart/form-data` and `protobuf` bodies are not yet supported by the CLI fetcher.

## CLI reference

```
restura run <collection> [options]
```

`<collection>` accepts a directory (any supported layout) or a bundled `.yaml`/`.yml` file.

| Flag                        | Default       | Description                                                                                          |
| --------------------------- | ------------- | ---------------------------------------------------------------------------------------------------- |
| `--env <file>`              |               | JSON or YAML env file. `${VAR}` placeholders are expanded from `process.env`.                        |
| `--reporter <list>`         | `live`        | Comma-separated. Mix and match: `live`, `json`, `junit`, `html`.                                     |
| `--output <file>`           |               | Shorthand for single file reporter.                                                                  |
| `--reporter-output <kv...>` |               | Per-reporter output: `--reporter-output junit=results.xml html=report.html`.                         |
| `--bail`                    | `false`       | Stop on first failure.                                                                               |
| `--timeout <ms>`            | `30000`       | Per-request timeout.                                                                                 |
| `--allow-localhost`         | `false`       | Permit requests to `localhost` / `127.0.0.1`. Off by default (SSRF guard).                           |
| `--folder <path>`           |               | Only run requests under this folder path (slash-joined).                                             |
| `--include <pattern...>`    |               | Substring or glob (e.g. `users/*`). Repeatable.                                                      |
| `--exclude <pattern...>`    |               | Same syntax as `--include`. Applied after.                                                           |
| `--data <file>`             |               | CSV (with header row) or JSON array. Runs the collection once per row; row keys are exposed as vars. |
| `--max-iterations <n>`      |               | Cap iterations when a `--data` file is large.                                                        |
| `--retry <n>`               | `0`           | Retry attempts per failing request.                                                                  |
| `--retry-on <list>`         | `network,5xx` | Comma-separated triggers: `network`, `5xx`, `4xx`, or specific status codes (`429,503`).             |
| `--sse-duration <ms>`       | `5000`        | How long to keep SSE streams open.                                                                   |
| `--sse-events <n>`          |               | Stop SSE early after N events.                                                                       |
| `--ws-duration <ms>`        | `5000`        | How long to keep WebSocket connections open.                                                         |
| `--ws-messages <n>`         |               | Stop WebSocket early after N messages.                                                               |

## Scripts and assertions

Pre-request and test scripts run in a sandboxed QuickJS WASM VM (no DOM, no filesystem, no network escape; 64 MB memory cap, 5 s sync / 30 s async execution timeout).

```yaml
# request.http.yaml
name: Get user
method: GET
url: '{{API_BASE}}/users/1'
testScript: |
  pm.test("status is 200", () => pm.response.to.have.status(200));
  pm.test("response has name", () => {
    pm.expect(pm.response.json()).to.have.property("name");
  });
```

When a test script runs and defines any `pm.test(...)` assertion, those drive pass/fail. Otherwise pass/fail falls back to the transport outcome (HTTP 2xx, gRPC OK, etc.).

Variables set inside a script (`pm.environment.set('K', 'v')`) propagate to subsequent requests in the same run.

## Variables

Three layered sources, in order of precedence (later wins):

1. `--env` file
2. Collection variables (declared in `opencollection.yml` or `_collection.yaml`)
3. Iteration row (when `--data` is set)

Substitutions are `{{NAME}}`. Unknown vars are left in place so the upstream sees them and you notice the gap.

### Dynamic helpers

Postman-compatible `{{$random*}}` / `{{$timestamp}}` helpers are expanded after user var substitution:

| Helper                 | Example                     |
| ---------------------- | --------------------------- |
| `{{$randomUUID}}`      | `f4d2e3...`                 |
| `{{$timestamp}}`       | `1700000000` (unix seconds) |
| `{{$isoTimestamp}}`    | `2026-05-22T13:42:00Z`      |
| `{{$randomEmail}}`     | `alice.42@example.com`      |
| `{{$randomFirstName}}` | `Olivia`                    |
| `{{$randomIP}}`        | `192.0.2.4`                 |

Full list in `src/lib/shared/dynamicVariables.ts`.

## Data-driven runs

```bash
restura run ./users-api --data ./users.csv --reporter junit --reporter-output junit=junit.xml
```

```csv
# users.csv
username,role
alice,admin
bob,viewer
charlie,editor
```

Each row exposes `username` and `role` as variables, overriding any same-named env or collection variable for that iteration only. JUnit testcase names carry an `[iter N]` suffix so each iteration is distinct in CI dashboards.

## Reporters

- **`live`** — coloured progress to stdout. Default.
- **`json`** — full `RunResult` dumped as JSON. Path required (`--output` or `--reporter-output json=...`).
- **`junit`** — JUnit XML for CI dashboards. One `<testcase>` per request.
- **`html`** — self-contained HTML page with embedded data + summary table.

Combine with a comma: `--reporter live,junit --reporter-output junit=results.xml`.

## Exit codes

| Code | Meaning                                                                         |
| ---- | ------------------------------------------------------------------------------- |
| `0`  | Every request passed AND at least one request ran                               |
| `1`  | One or more requests failed or errored (or no requests matched after filtering) |
| `2`  | Internal error: missing collection, bad reporter name, IO failure, …            |

## Troubleshooting

- **`No recognised collection layout`** — your target directory needs one of `opencollection.yml`, `opencollection.yaml`, or `_collection.yaml`. Re-export from the Restura app if unsure.
- **`Invalid URL`** — the URL after `{{var}}` resolution isn't a valid absolute URL. Check that `--env` is loaded and your var names match.
- **`Localhost URLs are not allowed`** — add `--allow-localhost` for local upstreams. Off by default to prevent SSRF in shared CI.
- **gRPC requests return `UNKNOWN`** — the upstream likely doesn't speak Connect protocol. The CLI uses Connect-over-HTTP, not gRPC-over-HTTP/2 binary framing.
- **`auth uses a desktop-only secret handle…`** — your auth references a secret handle that only the desktop app can decrypt. The request is errored (not sent unauthenticated); re-export the collection with inline secret values for CI use.

## Development

```bash
# from cli/
npm install
npm test                   # vitest
npm run type-check         # tsc --noEmit
npm run build              # tsup → dist/
```

The CLI imports from the parent project at compile-time via path aliases (`@/`, `@shared/`); `cli/tsconfig.json` controls which parent modules participate in type-checking.

## License

MIT.
