# OpenCollection in Restura

Restura speaks the [OpenCollection v1.0.0](https://spec.opencollection.com/) specification natively. Any tool that emits OpenCollection-compliant YAML — most notably **Bruno 3.1 and later** — produces files that Restura can open, edit, and write back without lossy conversion.

The OpenCollection JSON Schema is vendored at `vendor/opencollection/v1.0.0/schema.json` (pinned to a specific upstream commit), and TypeScript types are auto-generated from it. The runtime parser uses Zod schemas and validates every loaded file. See [`src/lib/opencollection/`](../src/lib/opencollection/) for the implementation.

## Layout

A collection on disk is either bundled (single file) or directory (multi-file).

### Bundled — convenient for sharing one file

```yaml
opencollection: "1.0.0"
info:
  name: My API
bundled: true
items:
  - info: { type: http, name: Health }
    http:
      method: GET
      url: https://example.com/health
```

### Directory — recommended for git

```
my-api/
├── opencollection.yml         # collection metadata + config
├── users/
│   ├── _folder.yaml           # folder metadata
│   ├── get-user.yaml          # one request per file (slugified name)
│   └── create-user.yaml
└── posts/
    ├── _folder.yaml
    └── ...
```

Each request file's `info.type` field discriminates the protocol — `http`, `grpc`, `graphql`, `websocket`, `sse`, or `mcp` — so file extensions don't need to vary.

## Restura-specific extensions

OpenCollection v1.0.0 covers HTTP, gRPC, GraphQL, and WebSocket as first-class request types. Restura also supports **Server-Sent Events** and **Model Context Protocol** requests, which v1.0.0 doesn't cover yet. These live under the spec's free-form `extensions` field:

```yaml
extensions:
  x-restura-sse:
    - info: { type: sse, name: User Events }
      sse:
        url: https://example.com/events
        eventFilter: ["user.created", "user.updated"]
  x-restura-mcp:
    - info: { type: mcp, name: Inspector }
      mcp:
        url: http://localhost:3000
        transport: streamable-http
```

These extensions are **roundtrip-stable**: tools that don't understand them ignore them, and Restura re-emits them verbatim on save.

## Authentication

OpenCollection v1.0.0 includes more authentication methods than Restura currently runs at the wire (OAuth1, NTLM, WSSE arrive in Phase 4). Importers and exporters preserve all of them so a Restura-imported file can roundtrip back to Bruno without losing auth configuration:

| OpenCollection auth | Restura runtime support |
|---|---|
| `none`, `basic`, `bearer`, `apikey`, `digest`, `oauth2`, `awsv4` | ✅ Wired |
| `oauth1`, `ntlm`, `wsse` | Round-trips, runs in Phase 4 |

## Importing & exporting

- **Import:** Click the import-collection button in the toolbar, choose the **OpenCollection** tab, then drop a bundled YAML file or click to browse.
- **Export:** Right-click a collection in the sidebar → **Export → OpenCollection (YAML)**. The download is a single bundled YAML file.

Directory-layout import/export through a native folder picker lands in **Phase 1** alongside the broader git-workspace work. The unit and filesystem-layer tests in [`src/lib/opencollection/__tests__/`](../src/lib/opencollection/__tests__/) already exercise the directory format end-to-end.

## Byte-stable roundtrip

The importer attaches the original parsed OpenCollection document to the in-memory collection as a non-typed `_oc` passthrough bag. When exporting, if every item still has its `_oc` bag intact (i.e. nothing has been edited), Restura emits the cached document verbatim — the YAML diff in your repo is whatever you actually changed, with no whitespace churn or key reordering.

If any item has been modified, the exporter falls back to rebuilding from the internal model, which produces clean OpenCollection YAML but may have minor stylistic differences from the source.

## Verifying the schema

The vendored schema can be re-pinned to a newer upstream commit. Re-pin instructions are at [`vendor/opencollection/v1.0.0/SOURCE.md`](../vendor/opencollection/v1.0.0/SOURCE.md). After bumping the schema, run:

```bash
npm run gen:opencollection-types  # regenerate TS types
npm run validate                  # type-check + lint + verify-types + tests
```

The `verify:opencollection-types` step (part of `npm run validate`) ensures the committed `spec-types.ts` matches what the generator produces from the vendored schema — type drift gets caught in CI.

## Related

- Vendored schema: [`vendor/opencollection/v1.0.0/`](../vendor/opencollection/v1.0.0/)
- Implementation: [`src/lib/opencollection/`](../src/lib/opencollection/)
- Phase 0 plan: [`docs/superpowers/plans/2026-05-10-phase-0-opencollection-foundation.md`](./superpowers/plans/2026-05-10-phase-0-opencollection-foundation.md)
- Roadmap: [`docs/superpowers/plans/2026-05-10-restura-roadmap.md`](./superpowers/plans/2026-05-10-restura-roadmap.md)
