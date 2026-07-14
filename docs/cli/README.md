# Restura CLI

Run Restura API collections in CI. The CLI consumes the same `*.http.yaml` /
`_collection.yaml` files Restura's desktop and web clients use, and emits
JUnit, JSON, or HTML reports for any CI system that consumes them.

> **Status:** v0.1 — HTTP requests only. See [Limitations](#limitations) for
> what is not yet supported.

## Install

```bash
npm install -g @restura/cli
```

Requires Node.js 24 or later. The binary is `restura`.

## `restura agent eval`

Run an AI Lab Agent Suite v2 in headless CI:

```bash
OPENAI_API_KEY=... restura agent eval ./checkout.agent-suite.json --output agent-report.json
```

The suite model uses `providerId: "openai.responses"` and an environment credential reference such as `{ "source": "env", "name": "OPENAI_API_KEY" }`. The adapter performs stateless encrypted reasoning and function-call replay with `store: false`; server-side `previous_response_id` continuation is disabled. The command emits a compact summary, optionally writes the complete typed traces and grader results, and exits `0` only when every trial passes (`1` for an evaluated failed, error, or cancelled report, including provider/runtime trial errors; `2` for invalid input, unsupported configuration, or command/I/O failure).

Current headless limits are deliberate and fail closed: only `openai.responses` is registered; suite base-URL overrides and desktop secret handles are refused; judge graders and all tool sources require trusted CLI adapters that do not ship yet. Agent step/time/tool/token/cost/output budgets still apply, and `maxTokens` covers total input plus output tokens across a trial. `--output` writes the complete local trace report, which can include task inputs and model/tool outputs; protect and expire that CI artifact according to your data policy.

## Quick start

A Restura collection is a directory containing a `_collection.yaml` plus one
or more `*.http.yaml` request files:

```
api-tests/
  _collection.yaml
  get-user.http.yaml
  list-posts.http.yaml
```

Run it:

```bash
restura run ./api-tests
```

You'll get coloured per-request progress on stdout and an exit code suitable
for CI:

```
▶ Running Sample
  ✓ GET Get user — 200 (124ms)
  ✓ GET List posts — 200 (98ms)

2/2 passed (0 failed, 0 errored) in 0.22s
```

## `restura run`

```
restura run <collection-dir> [options]
```

| Flag                | Default | Description                                                    |
| ------------------- | ------- | -------------------------------------------------------------- |
| `--env <file>`      |         | Path to env file (`.json`, `.yaml`, `.yml`)                    |
| `--reporter <name>` | `live`  | One of `live`, `json`, `junit`, `html`                         |
| `--output <file>`   |         | Output path. Required for `json`, `junit`, `html` reporters    |
| `--bail`            | `false` | Stop on first failure                                          |
| `--timeout <ms>`    | `30000` | Per-request timeout (ms)                                       |
| `--allow-localhost` | `false` | Permit `localhost` / `127.0.0.1` / RFC 1918 targets (SSRF off) |

`<collection-dir>` is the directory holding `_collection.yaml`. The CLI walks
it recursively for `*.http.yaml` files (sorted alphabetically by relative
path for stable ordering).

## Reporters

### `live` (default)

Coloured per-request progress to stdout. No `--output` needed. Designed for
local iteration and human-readable CI logs.

### `json`

Writes the full run result (every request, response status, headers, timing,
error message) as pretty-printed JSON. Suitable for downstream tooling or
archival.

```bash
restura run ./api-tests --reporter json --output run.json
```

```json
{
  "meta": {
    "collectionName": "Sample",
    "collectionDir": "./api-tests",
    "startedAt": 1715200000000
  },
  "durationMs": 224,
  "requests": [
    {
      "request": {
        "filePath": "...",
        "relativePath": "get-user.http.yaml",
        "type": "http",
        "request": { "name": "Get user", "method": "GET", "url": "..." }
      },
      "status": 200,
      "passed": true,
      "durationMs": 124,
      "bodyBytes": 482,
      "responseHeaders": { "content-type": "application/json" }
    }
  ],
  "summary": { "total": 2, "passed": 2, "failed": 0, "errored": 0 }
}
```

### `junit`

Writes JUnit XML — the lingua franca for CI test reporting. Works with
GitHub Actions test reporting actions, GitLab `artifacts:reports:junit`,
CircleCI `store_test_results`, Jenkins JUnit plugin, etc.

```bash
restura run ./api-tests --reporter junit --output junit.xml
```

```xml
<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="Sample" tests="2" failures="0" errors="0" time="0.224">
  <testsuite name="Sample" tests="2" failures="0" errors="0" time="0.224">
    <testcase classname="http" name="Get user" time="0.124"/>
    <testcase classname="http" name="List posts" time="0.098"/>
  </testsuite>
</testsuites>
```

Non-2xx responses become `<failure>`; network / fetcher errors become
`<error>`.

### `html`

Self-contained HTML report — single file, inline CSS, no external fetches.
The full run result is embedded as `<script type="application/json">` so
downstream tooling can re-parse without needing the JSON reporter alongside.
Designed to be uploaded as a CI artifact and opened in a browser.

```bash
restura run ./api-tests --reporter html --output report.html
```

## Variable substitution

Anywhere in URL, header value, query-param value, or raw body, `{{KEY}}`
placeholders resolve against the merged variable scope:

1. Env file (loaded via `--env`)
2. Collection variables (`_collection.yaml` `variables`) — override env file

Unresolved keys are left as `{{KEY}}` (so the upstream sees them and the user
notices).

### Env file format

JSON:

```json
{
  "API_BASE": "https://api.example.com",
  "API_TOKEN": "${API_TOKEN}"
}
```

YAML:

```yaml
API_BASE: https://api.example.com
API_TOKEN: ${API_TOKEN}
```

`${VAR}` references inside values resolve from `process.env` at load time —
so secrets stay in CI env vars and never need to be committed alongside the
env file.

## Exit codes

| Code | Meaning                                                                 |
| ---- | ----------------------------------------------------------------------- |
| `0`  | Every request passed (HTTP 2xx) and at least one request was run        |
| `1`  | One or more requests failed or errored, or the collection was empty     |
| `2`  | Internal error — missing collection, unknown reporter, IO failure, etc. |

## Limitations

- **Pre-request and test scripts run in the same QuickJS sandbox the app
  uses** (`quickjs-emscripten`, bundled into the CLI). `pm.test()` /
  `pm.expect()` assertions drive pass/fail alongside HTTP status;
  `pm.environment` / `pm.globals` / `pm.collectionVariables` /
  `pm.iterationData` are all live. `pm.sendRequest`, `pm.cookies`, and
  `pm.vault` are **not** wired in the CLI (no persistent cookie jar or OS
  keychain in a CI process) — those calls reject with a clear "not wired
  in" error rather than hanging.
- **HTTP, gRPC (unary), SSE, and MCP requests execute.** WebSocket has an
  executor (`executeWebSocket`) but isn't wired into collection runs yet.
- **Localhost is blocked by default.** Pass `--allow-localhost` if your CI
  runs against an in-job server (e.g., a sidecar in `services:`).
- **Postman / Insomnia collection imports are renderer-only.** Convert once
  in the desktop app and commit the resulting `*.yaml` files.

## CI examples

Copy-paste-ready pipelines:

- [GitHub Actions](./ci-examples/github-actions.yml)
- [GitLab CI](./ci-examples/gitlab-ci.yml)
- [CircleCI](./ci-examples/circleci.yml)

## See also

- [ADR 0005 — CLI Runner](../adr/0005-cli-runner.md) — design rationale
- [Architecture overview](../ARCHITECTURE.md) — § CLI runner
