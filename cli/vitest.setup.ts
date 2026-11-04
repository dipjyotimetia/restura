// Keep the CLI suite hermetic: an ambient HTTP(S)_PROXY (corporate shells, CI
// runners, sandboxes) makes the DNS-pinned MCP transport refuse to run by
// design (`configuredProxyEnvironment` in src/runner/pinnedMcpFetch.ts) and
// routes the runner's plain fetches to the proxy, failing agent / MCP / runner
// tests for reasons unrelated to the code under test.
//
// Cleared at module top level, not in a beforeEach: setup files run before the
// test file is imported, and some modules (and Node's env-proxy dispatcher)
// read these variables at import time. Tests that exercise the proxy refusal
// set their own value and restore it.
const PROXY_ENV_VARS = ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy'] as const;

for (const name of PROXY_ENV_VARS) delete process.env[name];
