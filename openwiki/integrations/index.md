# Integrations

Restura imports from and exports to several external collection formats. This page maps the import/export surfaces, OpenCollection file layout, file/Git collections, the browser capture extension pipeline, and the CLI collection runner.

---

## Import formats

Entry points: `src/features/collections/lib/importers.ts` and `src/features/collections/lib/importers/index.ts`.

Supported formats:

- Postman Collection (v2.1)
- Postman Environment
- Insomnia Collection (v4 flat and v5 nested)
- OpenAPI / Swagger
- OpenCollection (directory or bundled file)
- Hoppscotch Collection & Environment
- Bruno Collection
- HTTP file (`importHttpFile`)

Types: `shared/types/import-export.ts` (with a renderer compatibility re-export at `src/types/import-export.ts`).

### Import behaviour

- Imported OpenCollection subtrees keep a verbatim `_oc` passthrough cache in `useCollectionStore`.
- Editing a request strips ancestor `_oc` bags so re-export rebuilds from the live model.
- Collection variables and script contexts are normalised across importers.

---

## OpenCollection format

Restura's native disk format is [OpenCollection v1.0.0](https://spec.opencollection.com/). See `docs/opencollection.md` for the full spec.

- Vendored schema: `vendor/opencollection/v1.0.0/schema.json`.
- Generated types: `shared/opencollection/spec-types.ts`.
- Parser/serializer and runtime schemas: `shared/opencollection/`.

Regenerate types with `npm run gen:opencollection-types`; CI verifies no drift with `npm run verify:opencollection-types`.

Collection layout:

```
my-api/
├── opencollection.yml
├── users/
│   ├── _folder.yaml
│   ├── get-user.yaml
│   └── create-user.yaml
└── posts/
    ├── _folder.yaml
    └── ...
```

Restura-specific extensions for SSE and MCP live under `extensions.x-restura-sse` and `extensions.x-restura-mcp`. They are roundtrip-stable: other tools can ignore them and Restura re-emits them verbatim.

On export, inline secrets render as `{{handle:<label>}}` rather than plaintext. Redaction helpers: `shared/secrets/collection-redaction.ts`, `shared/secrets/key-value-redaction.ts`, `electron/main/security/collection-export-redactor.ts`.

Directory saves are staged and parsed back before the destination is updated. A hidden managed-file manifest lets Restura remove renamed/deleted request files without deleting unrelated content such as `.git`, README files, or user fixtures.

---

## Export formats

Entry point: `src/features/collections/lib/exporters.ts`.

- Postman v2.1 (HTTP only; other protocols become stubs; `rs.*` scripts reverse-migrated to `pm.*`)
- Insomnia v4
- HAR
- OpenAPI 3.0
- OpenCollection
- Console exports: HAR, NDJSON, curl batch (`src/lib/shared/console-export.ts`)

Postman and Insomnia exports surface lossy-format warnings before download. Postman preserves collection variables but represents non-HTTP protocols as marked stubs; Insomnia also omits collection/folder scripts, inherited auth, and collection variables. Attached contracts are collection-scoped and are not execution-time response validators.

---

## Postman parity

The QuickJS sandbox exposes Postman-compatible `pm.*` globals in `src/features/scripts/lib/`:

- `pm.test` / `pm.expect`
- `pm.response.*`, `pm.request.*`, `pm.info.*`
- Variable namespaces: `pm.variables`, `pm.environment`, `pm.collectionVariables`, `pm.globals`
- `pm.sendRequest`, `pm.cookies`, dynamic variables

See `docs/postman-compat.md` for the full parity matrix and known gaps.

---

## File collections and Git

Desktop supports filesystem-backed YAML collections in addition to in-app IndexedDB collections.

- Store: `src/store/useFileCollectionStore.ts`.
- OpenCollection directory layout is the only writable desktop format.
- Legacy `_collection.yaml` directories are unsupported; opening a directory requires `opencollection.yml` or `opencollection.yaml`.
- Sync state, conflicts, and file watchers are Electron-only. Main suppresses watcher events from its own saves; clean external changes reload in place, while external changes against dirty local state create a conflict.
- Git operations and history are handled by `electron/main/handlers/git-handler.ts`.

Deleting a file-backed collection first stops its watcher, then removes linked workflows and detaches open saved-request tabs as dirty standalone copies. Collection-run history is retained as historical evidence.

---

## Browser capture extension

The capture extension records browser network traffic and converts it into Restura collections/HAR.

- Chrome extension workspace: `extension/chrome/` (`@restura/extension`).
- Shared capture pipeline: `shared/capture/` — normalizer, classifier, secret-extractor, HAR exporter, OpenCollection exporter.
- Desktop bridge: `electron/main/handlers/capture-bridge-handler.ts` receives loopback capture traffic.

Capture is desktop-only because it needs a local TCP listener. See ADR-0024 for design rationale.

---

## CLI collection runner

The `restura-cli` package runs Restura collections in CI. Entry: `cli/src/index.ts`. Runner: `cli/src/runner/runner.ts`.

Capabilities:

- HTTP/REST, GraphQL, gRPC (Connect), SSE, MCP.
- Bearer/Basic/API-key/OAuth2 token acquisition via client credentials.
- AWS SigV4, OAuth1, WSSE signing at the wire on HTTP.
- Inheritance: collection/folder auth and scripts propagate to descendant requests.
- Reporters: `tui`, `live`, `json`, `junit`, `html`, `stats`.
- Data-driven runs with `--data <csv/json>`.
- TLS flags: `--insecure`, `--ca`, `--client-cert`, `--client-key`, `--cert-passphrase`.
- Proxy flag: `--proxy <url>` + standard `HTTP_PROXY` / `HTTPS_PROXY` env vars.

Exit codes: `0` all pass, `1` test failure, `2` internal error.

See `cli/README.md` for the full CLI reference.

---

## MCP integration

Restura can act as an MCP client/proxy and as an MCP server.

- MCP client feature: `src/features/mcp/` + `shared/protocol/mcp-proxy.ts`.
- MCP server feature: `src/features/mcp-server/` and `electron/main/handlers/mcp-server-handler.ts` — exposes Restura's request execution as an MCP server to local tools.

---

## Source map

| Integration                 | Files                                                                                                                    |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Importers                   | `src/features/collections/lib/importers.ts`, `src/features/collections/lib/importers/*.ts`, `src/types/import-export.ts` |
| Exporters                   | `src/features/collections/lib/exporters.ts`                                                                              |
| Console exports             | `src/lib/shared/console-export.ts`                                                                                       |
| OpenCollection parser/types | `shared/opencollection/`, `vendor/opencollection/v1.0.0/schema.json`, `docs/opencollection.md`                         |
| Postman compat              | `docs/postman-compat.md`, `src/features/scripts/lib/pmExpect.ts`, `src/features/scripts/lib/scriptApiTypes.ts`           |
| File collections            | `src/store/useFileCollectionStore.ts`, `shared/collections/legacy-file-schema.ts`                                        |
| Git handler                 | `electron/main/handlers/git-handler.ts`                                                                                  |
| Capture pipeline            | `shared/capture/`, `extension/chrome/`, `electron/main/handlers/capture-bridge-handler.ts`                               |
| CLI runner                  | `cli/src/runner/runner.ts`, `cli/src/runner/collectionLoader.ts`, `cli/src/reporters/`                                   |
| MCP proxy                   | `shared/protocol/mcp-proxy.ts`, `src/features/mcp/`                                                                      |
| MCP server                  | `src/features/mcp-server/`, `electron/main/handlers/mcp-server-handler.ts`                                               |

---

## Change guidance

- When adding an import format, add a transformer in `src/features/collections/lib/` and update `importTransformer.ts` dispatch. Add fixtures in `src/features/collections/lib/__tests__/ `.
- When extending OpenCollection, update the vendored schema if you own it, regenerate `spec-types.ts`, and document any Restura-specific extension fields.
- When adding script APIs, update `scriptApiTypes.ts`, the host bridges, and the bootstrapping in `scriptExecutor.ts`. Test with the CLI contract tests (`cli/src/runner/__tests__/scripts.test.ts`) and `src/features/scripts/lib/__tests__/*`.
- When adding CLI protocols, add an executor under `cli/src/runner/executors/` and wire it in `runner.ts` for the collection path.
