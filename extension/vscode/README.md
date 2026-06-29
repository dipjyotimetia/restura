# Restura for VS Code

Bring [Restura](https://restura.dev) API collections into your editor. Restura collections are git-native [OpenCollection](https://opencollection.com) YAML files that live in your repo — this extension makes them first-class, lint-able, runnable citizens of the codebase.

This is **not** the full Restura app in a panel. It deliberately does only what an editor can do better than a separate GUI: structured editing, a native Test Explorer, and inline send — all over the same files your team already commits.

## Features

### 1. OpenCollection language support

- **Schema validation** of request files (`http` / `grpc` / `graphql` / `websocket`) against the OpenCollection element schemas — squiggles on missing/invalid fields, located to the offending line.
- **Autocomplete + hover** on root `opencollection.{yml,yaml}` files via the bundled JSON Schema (requires the [YAML extension](https://marketplace.visualstudio.com/items?itemName=redhat.vscode-yaml); validation of request files works without it).

### 2. Test Explorer

Your collections appear in VS Code's native **Testing** view, mirroring the folder structure. Run the whole collection, a folder, or a single request — pass/fail, durations, and assertion details show inline. Runs shell out to the `restura` CLI, so local results match CI exactly.

### 3. Inline Send / Run test

CodeLens actions above each request:

- **▶ Send** (HTTP/GraphQL) — sends the request through Restura's shared protocol core (SSRF guard, header policy, redirect handling, wire-level auth) and shows the response in a side panel. Variables resolve from the collection's default environment.
- **▶ Run test** — runs just that request through the CLI and reports assertions.

## Requirements

- The [`restura` CLI](https://www.npmjs.com/package/restura-cli) on `PATH` or in your workspace `node_modules` (used by the Test Explorer and **Run test**). Override the path with `restura.cliPath`.
- Node.js 24+.
- Trusted, local workspaces only (no virtual/untrusted workspaces — the extension runs a CLI and makes network requests).

## Settings

| Setting                   | Default | Description                                                            |
| ------------------------- | ------- | ---------------------------------------------------------------------- |
| `restura.cliPath`         | `""`    | Path to the `restura` binary (auto-resolved if empty).                 |
| `restura.allowLocalhost`  | `true`  | Allow Send/test runs to target localhost.                              |
| `restura.allowPrivateIPs` | `false` | Allow private/RFC-1918 targets. Cloud-metadata endpoints stay blocked. |
| `restura.env`             | `""`    | Optional env file (JSON/YAML) passed to the CLI runner.                |

## Roadmap

Two further offerings are planned but not yet shipped:

- **OpenAPI contract drift** — generate requests from a spec in your repo and flag requests that drift from the contract. (Blocked on a Node-safe spec loader.)
- **One-click MCP registration** — register Restura's MCP server into the workspace MCP config. (Blocked on the headless MCP context loader.)

## License

MIT
