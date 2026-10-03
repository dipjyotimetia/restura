# Restura CLI

The full CLI reference lives in [`cli/README.md`](../../cli/README.md) — the same file published to npm as [`restura-cli`](https://www.npmjs.com/package/restura-cli) — and on the docs site at [docs.restura.dev/reference/cli](https://docs.restura.dev/reference/cli/). It covers:

- `restura run` — collection runs with `tui` / `live` / `json` / `junit` / `html` / `stats` reporters, data-driven iterations, retries, TLS/mTLS, proxies, and external-secret profiles
- `restura workflow run` — binding-only OWS workflows from an OpenCollection workspace
- `restura agent eval` — headless AI Lab Agent Suites and Agent Bundles
- the interactive wizard, supported collection formats and protocols, scripts, variables, and exit codes

```bash
npm install -g restura-cli   # Node.js 24+; the binary is `restura`
restura run ./api-tests --reporter junit --output junit.xml
```

## CI examples

Copy-paste-ready pipelines:

- [GitHub Actions](./ci-examples/github-actions.yml)
- [GitLab CI](./ci-examples/gitlab-ci.yml)
- [CircleCI](./ci-examples/circleci.yml)

## See also

- [ADR 0005 — CLI Runner](../adr/0005-cli-runner.md) — design rationale
- [Architecture overview](../ARCHITECTURE.md) — § CLI runner
- [Agent telemetry](../AGENT_TELEMETRY.md) — `--telemetry-config` for `restura agent eval`
