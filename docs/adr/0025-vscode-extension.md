# ADR 0025: VS Code Extension

**Status:** Accepted, 2026-06-29

## Context

Restura collections are git-native [OpenCollection](./0008-opencollection-native-format.md) YAML files that live in the repo. Once collections are just files in the tree, the editor is the natural place to work with them — but only for the things an editor does better than a separate GUI. The risk is building "the whole app in a panel": a second, drifting implementation of request execution and test running that has to be kept in parity with the renderer and the CLI.

Two reuse boundaries already exist and must not be duplicated:

- The **shared protocol core** (`shared/protocol/`, [ADR 0001](./0001-shared-protocol-layer.md)) — SSRF guard, header policy, body builder, redirect follower. A "send this request" feature must go through it, not a bare `fetch`.
- The **`restura` CLI** ([ADR 0005](./0005-cli-runner.md)) — the assertion runner CI already uses. A Test Explorer must shell out to it so local results match CI exactly, rather than re-implementing assertions.

## Decision

Ship a focused **VS Code extension** (`extension/vscode`, a separate npm workspace built with esbuild) that does only what the editor does best, organised as three independent "offerings" wired up in `extension.ts`:

- **Offering 1 — OpenCollection language support** (`offering1_lang/`). Schema validation of request files (`http` / `grpc` / `graphql` / `websocket`) against the OpenCollection element schemas, surfaced as diagnostics located to the offending line. Root `opencollection.{yml,yaml}` files get autocomplete + hover via the bundled JSON Schema (`schemas/opencollection-v1.0.0.json`) through the Red Hat YAML extension; request-file validation works without it.

- **Offering 2 — Test Explorer** (`offering2_test/`). Collections appear in VS Code's native **Testing** view, mirroring the folder structure. Runs **shell out to the `restura` CLI** so local results match CI exactly — no re-implemented assertion engine. CLI path auto-resolves (workspace `node_modules` → `PATH`), overridable via `restura.cliPath`.

- **Offering 3 — Inline Send / Run test** (`offering3_codelens/`). CodeLens actions above each request. **▶ Send** (HTTP/GraphQL) runs through the **shared protocol core** (`executeHttpProxy`) with a **Node extension-host fetcher** (`util/nodeFetcher.ts`) and shows the response in a side panel; variables resolve from the collection's default environment. **▶ Run test** runs that one request through the CLI.

**Trust posture.** `extensionKind: ["workspace"]`; `untrustedWorkspaces` and `virtualWorkspaces` are **unsupported** — the extension spawns a CLI and makes network requests, so it only operates in trusted, local workspaces.

## Security

The inline **Send** feature opens an outbound path from the extension host, so it carries the same SSRF posture as every other Restura backend:

- `executeHttpProxy` runs `validateURL` (literal-IP / loopback / cloud-metadata carve-outs) exactly as on Worker/Electron.
- `nodeFetcher` adds a **pre-flight DNS guard** for hostname targets — resolve, then `assertResolvedAddressAllowed` against every record — mirroring Electron's `dns-guard`. Like that guard it does **not** defend against true DNS-rebind (TTL=0 swap between check and connect); it closes the static name→private-address window a bare `fetch` would leave open.
- Localhost and private/RFC-1918 targets are **opt-in** via `restura.allowLocalhost` (default `true`) and `restura.allowPrivateIPs` (default `false`); cloud-metadata endpoints stay blocked regardless.

## Consequences

- **No parity drift on the two expensive surfaces.** Test runs are literally the CLI; inline sends are literally the shared protocol core. The extension owns only editor-specific glue (diagnostics, Test Explorer tree, CodeLens, the response webview).
- The OpenCollection JSON Schema is **vendored** into the extension (`schemas/`) rather than imported from the generated shared types — the extension is a standalone workspace and must not depend on renderer-owned `src/`. This schema can drift from `shared/opencollection/` and is not covered by `verify:opencollection-types`; it must be refreshed by hand when the spec version bumps.
- Two further offerings are scoped but **not shipped**: OpenAPI contract-drift (blocked on a Node-safe spec loader) and one-click MCP registration (blocked on the headless MCP context loader).
- The extension is type-checked and linted in CI (`type-check:all` runs `--workspace restura-vscode type-check`; `npm run lint` covers `extension/vscode`) and has unit tests (`test/unit/`) plus a VS Code integration test (`test/integration/`).

## Related

- [ADR 0001 — Shared protocol layer](./0001-shared-protocol-layer.md) — the core inline Send reuses.
- [ADR 0005 — CLI runner](./0005-cli-runner.md) — the runner the Test Explorer shells out to.
- [ADR 0008 — OpenCollection native format](./0008-opencollection-native-format.md) — the file format made first-class in the editor.
- [ADR 0024 — Browser capture extension](./0024-browser-capture-extension.md) — the sibling extension subproject.
