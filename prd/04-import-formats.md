# PRD 04 — Momentum Import Formats

**Status:** Draft  
**Author:** Senior PM (AI-assisted)  
**Date:** 2026-06-30  
**Version:** 1.0

---

## 1. Summary

Add four new import capabilities to Restura that close the gap between Restura and the three most common adjacent developer tools — Bruno (`.bru` round-trip), VS Code / JetBrains HTTP files (`.http`), AsyncAPI 3.0 (event-driven streaming connections), and Arazzo 1.1 (workflow-as-code execution) — so that teams already organised around these formats can adopt Restura without a rewrite-from-scratch migration.

---

## 2. Problem & Evidence

### What Restura imports today

`src/components/shared/ImportDialog.tsx` currently defines:

```ts
type ImportType = 'postman' | 'insomnia' | 'openapi' | 'opencollection' | 'hoppscotch' | 'bruno';
```

The `bruno` entry calls `importBrunoCollection` from `src/features/collections/lib/importers/bruno.ts`, which handles Bruno's JSON/YAML OpenCollection format. It does **not** parse native `.bru` plain-text files.

> **Correction (post-audit):** a native `.bru` **exporter already exists, is tested, and is wired into the UI** — `src/features/collections/lib/bruno-exporter.ts` exports `exportBrunoCollection` / `exportBrunoRequest` (using `jsonToBruV2` / `envJsonToBruV2` / `jsonToCollectionBru` via `loadBrunoLang()`), with tests in `__tests__/bruno-exporter.test.ts` and an export menu entry in `Sidebar.tsx:302`. So Bruno **export is largely DONE**, not greenfield. The real remaining Bruno gaps are narrower: **(1)** native `.bru` _import_ (round-trip back in); **(2)** web download currently ships a `bruno-archive/v1` JSON wrapper (`Sidebar.tsx`), **not** a real `.zip` — true ZIP packaging is unbuilt; **(3)** Electron "save to folder" is explicitly deferred to the git-native-collections milestone. Scope below is revised accordingly: drop "build Bruno export" and replace with "add `.bru` import + real ZIP packaging."

### Gap analysis by format

| Format                                    | Status                            | Pain                                                                               |
| ----------------------------------------- | --------------------------------- | ---------------------------------------------------------------------------------- |
| Bruno `.bru` plain-text                   | Import-only, no round-trip export | Bruno users cannot keep using their existing `.bru` git repos                      |
| `.http` (VS Code REST Client / JetBrains) | Not imported                      | Tens of thousands of VS Code users have `.http` scratch files they cannot bring in |
| AsyncAPI 3.0                              | Not imported                      | Event-driven teams have no on-ramp for Kafka/MQTT/SSE channels                     |
| Arazzo 1.1                                | Not imported                      | Workflow-as-code is an emerging standard; first-movers have a durable advantage    |

### Market evidence

- Bruno has ~27 k GitHub stars and publishes `.bru` as its canonical storage format; teams on Bruno treat `.bru` files as source of truth in git.
- VS Code REST Client has >10 M installs; JetBrains HTTP Client ships in every JetBrains IDE by default. Both formats are the "scratch pad" prior art for the developer audience Restura targets.
- Anthropic's MCP specification references Arazzo as the recommended multi-step workflow description language. Execution engines that import Arazzo natively are scarce; this is a first-mover opportunity with a direct line to MCP users of Restura.
- AsyncAPI 3.0 GA'd in late 2023 and is the primary schema for event-driven APIs (Kafka, MQTT, SSE, WebSocket). Engineering teams doing API-first design for event buses already have `.asyncapi.yaml` files.

---

## 3. Goals / Non-Goals

### Goals (this PRD)

- **G1** — Parse native `.bru` request files and directory trees into Restura collections (already done via `importBrunoCollection`); add the reverse: export any Restura collection back to a `.bru` directory tree using `jsonToBruV2` / `envJsonToBruV2` from `@usebruno/lang`.
- **G2** — Parse `.http` files in VS Code REST Client dialect (separator: `###`, variables: `{{name}}`) and JetBrains HTTP Client dialect (pre-request blocks: `< {% %}`, response-handler blocks: `> {% %}`), producing `CollectionItem[]` with `ImportWarning[]` for unsupported dialect features.
- **G3** — Parse AsyncAPI 3.0 YAML/JSON documents and produce: `SseRequest` collection items for HTTP/SSE channels (web + desktop); `KafkaConnection` records seeded in `useKafkaStore` for Kafka channels (desktop-only); `MqttConnection` records seeded in `useMqttStore` for MQTT channels (desktop-only).
- **G4** — Parse Arazzo 1.1 YAML/JSON documents and produce a `Workflow` with `WorkflowGraph`, mapping each step to a `FlowNode` via the pattern established by `workflowIO.ts`.

### Non-Goals (explicitly out of scope)

- **NG1** — AsyncAPI WebSocket channels producing a collection item. No `WebSocketRequest` type exists in the collection model today (`WsExchangeFlowNode` is workflow-only). WebSocket AsyncAPI channels emit a `platform-unsupported` `ImportWarning` and are skipped.
- **NG2** — Round-trip `.bru` fidelity for Bruno gRPC or WebSocket meta-types. These are already downgraded to HTTP with a `platform-unsupported` warning on import (existing behaviour in `bruno.ts`); the exporter will emit them as HTTP requests.
- **NG3** — Arazzo runtime expression evaluation (`$url`, `$response.body#/...`). The importer converts expressions to literal strings with an `unknown-dynamic-var` warning. Actual expression execution in the workflow runner is a separate initiative.
- **NG4** — AsyncAPI Schema Registry integration. Kafka message schemas (Avro/Protobuf) are noted as warnings; the connection is seeded without a schema registry URL.
- **NG5** — `.env.json` / `http-client.private.env.json` automatic read. JetBrains environment files are separate file inputs, not auto-discovered from disk. Users paste or select them separately.
- **NG6** — Modifying `spec-types.ts` in `src/lib/opencollection/` (generated file; `verify:opencollection-types` is a CI gate — never hand-edit).

---

## 4. Target Users & Top Use Cases

### Primary users

| Persona                    | Description                                                                                                                                 | Entry Point                                                           |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| **Bruno Migrant**          | Individual or team with an existing `.bru` git repo. Needs lossless in/out to keep using the git repo as source of truth.                   | Drop `.bru` file or paste content; use Export → `.bru` to write back. |
| **HTTP Scratch Pad User**  | Developer with a `.http` file per microservice, committed in the same repo as the service.                                                  | Drag-and-drop `.http` into ImportDialog.                              |
| **Event-Driven Architect** | Platform engineer maintaining an AsyncAPI contract for a Kafka or MQTT bus. Wants to seed Restura connections directly from the spec.       | Import AsyncAPI YAML from URL or file.                                |
| **Arazzo Workflow Author** | API consumer writing a multi-step workflow using the Arazzo spec (often alongside an MCP-tool chain). Wants to run the workflow in Restura. | Import Arazzo YAML/JSON, select a target collection, run workflow.    |

### Top use cases (priority order)

1. `UC-1` — Import a directory of `.bru` files (already supported via Bruno importer). Export an edited collection back to `.bru` for git commit.
2. `UC-2` — Import a `.http` file, get one collection item per request block, run requests immediately.
3. `UC-3` — Paste an AsyncAPI 3.0 YAML URL; Restura reads it, creates SSE request items in a new collection and (desktop-only) seeds Kafka/MQTT connection entries.
4. `UC-4` — Import an Arazzo 1.1 workflow document alongside an existing Restura collection; run the workflow steps in order.

---

## 5. User Stories

### Epic A — Bruno round-trip

- **A1** As a Bruno Migrant, I can import a folder of `.bru` files and get a Restura collection with all requests, environments, and folder structure preserved, so I do not have to re-enter anything.  
  _(Already fulfilled by `importBrunoCollection`; listed here for completeness.)_
- **A2** As a Bruno Migrant, I can export any Restura collection to a `.bru` directory (ZIP download on web; native save-dialog on desktop), so I can commit it back to my team's git repo.
- **A3** As a Bruno Migrant, when I import and re-export a collection that I have not edited, the `.bru` files are identical byte-for-byte to the originals, so my git diff is empty.

### Epic B — `.http` files

- **B1** As an HTTP Scratch Pad User, I can drag a `.http` file into the import dialog and receive one request per `###`-separated block, so I can run and compare requests without manual copy-paste.
- **B2** As a JetBrains user, I can import a `.http` file whose `> {% %}` response-handler blocks are preserved as test scripts (pending QuickJS migration) and flagged with an `unrecognized-script-type` warning, so I am informed without the import being blocked.
- **B3** As an HTTP Scratch Pad User, environment variable references (`{{baseUrl}}`) are preserved as Restura environment variable references (`{{baseUrl}}`), so I can create a matching Restura environment and they resolve at send time.

### Epic C — AsyncAPI 3.0

- **C1** As an Event-Driven Architect, I can import an AsyncAPI 3.0 document and get one SSE request item per HTTP/SSE channel, so I can test event streams without hand-crafting the request.
- **C2** As a desktop user, I can import an AsyncAPI 3.0 document and have Kafka connection entries auto-created in the Kafka tab with the bootstrap brokers and default topic pre-filled.
- **C3** As a desktop user, I can import an AsyncAPI 3.0 document and have MQTT connection entries auto-created with the broker URL, protocol version, and topic subscriptions pre-filled.
- **C4** As a web user, I am shown a `platform-unsupported` warning for any Kafka or MQTT channels in an AsyncAPI document I import, explaining that those channels require the desktop app.

### Epic D — Arazzo 1.1

- **D1** As an Arazzo Workflow Author, I can import an Arazzo 1.1 document and select a Restura collection to bind it to; each `step` becomes a workflow node and the DAG edges are wired from `onSuccess`/`onFailure` actions.
- **D2** As a workflow author, `successCriteria` assertions are converted to `ConditionFlowNode` edges so the workflow engine can evaluate them at run time.
- **D3** As a workflow author, Arazzo `inputs` (JSON Schema) are mapped to `Workflow.variables` so I can supply them at run time via the workflow panel.
- **D4** As a workflow author, runtime expressions in Arazzo (e.g., `$response.body#/token`) are preserved as literal strings with an `unknown-dynamic-var` warning, so the workflow is importable even before full expression support lands.

---

## 6. Functional Requirements

### FR-A: Bruno Export (`.bru` round-trip)

The export direction is the only missing half; the import direction already exists.

#### A.1 — Exporter (already exists — extend, do not recreate)

The exporter lives at `src/features/collections/lib/bruno-exporter.ts` (**not** `importers/bru-exporter.ts`) and already exports:

```ts
exportBrunoCollection(collection: Collection, opts?: ExportBrunoOptions): Promise<BrunoExport>
exportBrunoRequest(request: HttpRequest): Promise<string>
```

These are implemented, tested (`__tests__/bruno-exporter.test.ts`), and called from `Sidebar.tsx:302`. The only export-side work is replacing the web `bruno-archive/v1` JSON wrapper with a real `.zip` (see A.2).

where `BruExportResult` is:

```ts
{
  files: Array<{ relativePath: string; content: string }>;
}
```

**Serialisation functions to use** (from `loadBrunoLang()` in `src/features/collections/lib/bruno-lang.ts`):

| Output                      | Function                              |
| --------------------------- | ------------------------------------- |
| Per-request `.bru` file     | `jsonToBruV2(requestJson)`            |
| Per-environment `.bru` file | `envJsonToBruV2(envJson)`             |
| `collection.bru` root file  | `jsonToCollectionBru(collectionJson)` |

#### A.2 — Field mapping: collection → `collection.bru`

| Restura field                 | Bruno `collection.bru` key    |
| ----------------------------- | ----------------------------- |
| `collection.auth`             | `auth {}` block               |
| `collection.variables[]`      | `vars {}` block               |
| `collection.preRequestScript` | `script:pre-request {}` block |
| `collection.testScript`       | `script:tests {}` block       |

#### A.3 — Field mapping: `CollectionItem` → per-request `.bru` file

| Restura `HttpRequest` field | Bruno `.bru` key                |
| --------------------------- | ------------------------------- |
| `method`                    | `meta.type` → method line       |
| `url`                       | `url` line                      |
| `name`                      | `meta.name`                     |
| `headers[].key / value`     | `headers {}` block              |
| `params[].key / value`      | `params:query {}` block         |
| `body.mode` → `json`        | `body:json {}` block            |
| `body.mode` → `form`        | `body:form-urlencoded {}` block |
| `auth` → bearer             | `auth:bearer {}` block          |
| `auth` → basic              | `auth:basic {}` block           |
| `preRequestScript`          | `script:pre-request {}` block   |
| `testScript`                | `script:tests {}` block         |
| `docs`                      | `docs` block                    |

#### A.4 — Round-trip accuracy requirement

An import of a `.bru` directory followed by an export with no intervening edits must produce `content` strings that are identical to the originals, modulo trailing newline normalisation. This is the acceptance criterion for lossless round-trip (see Section 12).

#### A.5 — Export UX entry points

- **Desktop:** `Export Collection → Bruno (.bru)` menu item in the collection context menu. Triggers a `showSaveDialog` with `{ properties: ['openDirectory', 'createDirectory'] }` via `electron/main/storage/file-operations.ts`; writes files to the selected directory.
- **Web:** Same menu item triggers a ZIP download containing the directory tree. **Note:** `fflate` is **not** currently a dependency (verify: absent from `package.json` and `node_modules`), and the shipped web path emits a `bruno-archive/v1` JSON wrapper instead of a real ZIP. Producing a true `.zip` requires **adding** a new dependency (`fflate` recommended — small, zero-dep, tree-shakeable) — treat it as a deliberate new dep, not a free one.

---

### FR-B: `.http` File Import

#### B.1 — New importer file

`src/features/collections/lib/importers/http-file.ts` exports:

```ts
importHttpFile(raw: string, dialectHint?: 'vscode' | 'jetbrains' | 'auto'): ImportResult
```

The default dialect is `'auto'`: the parser inspects the file for JetBrains-specific markers (`< {%`, `> {%`, `@name` in the `### Request name` form) to distinguish dialects.

#### B.2 — Common grammar (both dialects)

| Grammar element    | Rule                                                                                                             |
| ------------------ | ---------------------------------------------------------------------------------------------------------------- |
| Request separator  | `^###` (at line start, one or more `#`)                                                                          |
| Named request      | `// @name <id>` or `# @name <id>` on the line immediately before the method line                                 |
| File variable      | `@varName = value` at file top, before any `###`                                                                 |
| Method + URL line  | `METHOD URL` (e.g. `GET https://api.example.com/users`)                                                          |
| Headers            | `Header-Name: value` lines following method line                                                                 |
| Body               | Empty line after headers, then raw body until next `###` or EOF                                                  |
| Variable reference | `{{varName}}` → preserved as-is (maps to Restura `{{varName}}`)                                                  |
| System variable    | `{{$guid}}`, `{{$timestamp}}`, `{{$randomInt}}` → `ImportWarning { kind: 'unknown-dynamic-var', detail: '...' }` |
| Line comment       | `//` or `#` at line start (skip)                                                                                 |

#### B.3 — JetBrains-specific grammar

| Grammar element                         | Handling                                                                                                                                                                                                              |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pre-request script block `< {% ... %}`  | Content stored in `CollectionItem.preRequestScript` as raw string with `ImportWarning { kind: 'unrecognized-script-type', detail: 'JetBrains pre-request JS block — not yet executable in Restura QuickJS sandbox' }` |
| Response-handler block `> {% ... %}`    | Content stored in `CollectionItem.testScript` with same warning                                                                                                                                                       |
| `@baseUrl = ...` file variables         | Extracted to `ImportResult.environments[0].variables`                                                                                                                                                                 |
| `### Request Name` (name on `###` line) | Maps to `CollectionItem.name`                                                                                                                                                                                         |

**Security note:** Script content from JetBrains blocks is never auto-executed. It is stored as an inert string and only executes if the user explicitly runs it via the QuickJS sandbox (`src/features/scripts/lib/scriptExecutor.ts`). No eval, no Function constructor.

#### B.4 — Multi-request file → collection

A `.http` file containing `N` request blocks produces one `Collection` named after the filename (without extension), with `N` `CollectionItem` records of `type: 'request'`. Folder hierarchy is flat; nested folders are not encoded in the `.http` format.

#### B.5 — Environment extraction

File variables (`@varName = value`) before the first `###` block are collected into `ImportResult.environments[0]` named `"<filename> defaults"`. If no file variables exist, `environments` is omitted.

#### B.6 — `parseFileContent` update in `ImportDialog.tsx`

Add `'.http'` to the `accept` attribute for the new `ImportType = 'http-file'` entry. The `parseFileContent` function already branches on extension; add:

```ts
if (fileName.endsWith('.http')) return raw; // raw string passthrough, same as .bru
```

---

### FR-C: AsyncAPI 3.0 Import

#### C.1 — New importer file

`src/features/collections/lib/importers/asyncapi.ts` exports:

```ts
importAsyncAPIDocument(
  doc: unknown,
  options: { isDesktop: boolean }
): Promise<AsyncAPIImportResult>
```

where:

```ts
interface AsyncAPIImportResult extends ImportResult {
  kafkaConnections?: Partial<KafkaConnection>[]; // desktop-only seeds
  mqttConnections?: Partial<MqttConnection>[]; // desktop-only seeds
}
```

The `collection` field of `ImportResult` holds SSE request items only. Kafka/MQTT connections are returned as a sidecar array; the caller (ImportDialog) is responsible for dispatching them to the respective Zustand stores.

#### C.2 — Document object model consumed

| AsyncAPI 3.0 field                    | Used for                                                             |
| ------------------------------------- | -------------------------------------------------------------------- |
| `info.title`                          | Collection name                                                      |
| `info.description`                    | `collection.description`                                             |
| `servers[id].host`                    | Connection URL base                                                  |
| `servers[id].protocol`                | Protocol dispatch (`'http'`, `'https'`, `'kafka'`, `'mqtt'`, `'ws'`) |
| `servers[id].protocolVersion`         | Kafka: `protocolVersion`; MQTT: `protocolVersion`                    |
| `servers[id].bindings.kafka`          | Kafka broker config                                                  |
| `servers[id].bindings.mqtt`           | MQTT keep-alive, will                                                |
| `channels[id].address`                | Request URL path / topic address                                     |
| `channels[id].servers[]`              | Filters applicable servers                                           |
| `channels[id].bindings.http.method`   | HTTP method (defaults to `GET`)                                      |
| `channels[id].bindings.kafka.topic`   | Kafka default topic                                                  |
| `channels[id].bindings.mqtt.qos`      | MQTT QoS level                                                       |
| `operations[id].action`               | `'send'` or `'receive'` — drives operationLabel                      |
| `operations[id].channel.$ref`         | Links operation to channel                                           |
| `components.securitySchemes`          | Auth config (basic, bearer, apiKey)                                  |
| `components.messages[id].contentType` | Detect SSE (`text/event-stream`)                                     |

#### C.3 — Channel → target dispatch

| Server `protocol` | Message `contentType` | Output                                                                                                                                     |
| ----------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `http` / `https`  | `text/event-stream`   | `SseRequest` collection item                                                                                                               |
| `http` / `https`  | anything else         | `HttpRequest` collection item (GET)                                                                                                        |
| `kafka`           | any                   | `KafkaConnection` seed (desktop-only)                                                                                                      |
| `mqtt`            | any                   | `MqttConnection` seed (desktop-only)                                                                                                       |
| `ws` / `wss`      | any                   | `ImportWarning { kind: 'platform-unsupported', detail: 'WebSocket AsyncAPI channels require a future WS collection item type' }` — skipped |

#### C.4 — SSE channel → `SseRequest` field mapping

| AsyncAPI field                              | `SseRequest` field |
| ------------------------------------------- | ------------------ |
| `servers[id].host` + `channels[id].address` | `url`              |
| `channels[id].bindings.http.headers`        | `headers[]`        |
| `channels[id].bindings.http.query`          | `params[]`         |
| Auth scheme from `securitySchemes`          | `auth`             |
| `channels[id].address` (last segment)       | `name`             |

#### C.5 — Kafka channel → `KafkaConnection` seed field mapping

| AsyncAPI field                          | `KafkaConnection` field                                                                                |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `servers[id].host`                      | `bootstrapBrokers[0]`                                                                                  |
| `info.title` + serverId                 | `name`                                                                                                 |
| `channels[id].bindings.kafka.topic`     | `defaultTopic`                                                                                         |
| `components.securitySchemes` SASL-plain | `auth.type = 'sasl-plain'`, `auth.username`, `auth.password` [stored as `SecretRef` handle on desktop] |

#### C.6 — MQTT channel → `MqttConnection` seed field mapping

| AsyncAPI field                         | `MqttConnection` field                        |
| -------------------------------------- | --------------------------------------------- |
| `servers[id].host`                     | `brokerUrl`                                   |
| `servers[id].protocolVersion`          | `protocolVersion` (default: `5`)              |
| `servers[id].bindings.mqtt.keepAlive`  | `keepalive`                                   |
| `components.securitySchemes` user-pass | `username`, `password` [SecretRef on desktop] |
| `channels[id].address`                 | `subscriptions[0].topicFilter`                |
| `channels[id].bindings.mqtt.qos`       | `subscriptions[0].qos`                        |

#### C.7 — ImportDialog wiring for AsyncAPI

- Add `'asyncapi'` to `ImportType`.
- `FORMATS` entry: `{ id: 'asyncapi', name: 'AsyncAPI', tagline: 'Channels as connections', initials: 'AS', color: '#26a65b', accept: '.yaml,.yml,.json' }`.
- `IMPORTERS['asyncapi']` calls `importAsyncAPIDocument(data, { isDesktop: isElectron() })`, then:
  - Calls `addCollection(result.collection)`.
  - If `result.kafkaConnections?.length` and `isElectron()`: for each seed call `useKafkaStore.getState().createConnection({ name, bootstrapBrokers, clientId })` (the real action — there is **no** `addConnection`), then patch AsyncAPI-derived fields (`auth`, `defaultTopic`, …) via `updateConnection(id, ...)`.
  - If `result.mqttConnections?.length` and `isElectron()`: same pattern via `useMqttStore.getState().createConnection(...)` + `updateConnection(...)`.
  - Kafka/MQTT on web: adds an `ImportWarning { kind: 'platform-unsupported' }` in the warning panel.

---

### FR-D: Arazzo 1.1 Import

#### D.1 — New importer file

`src/features/collections/lib/importers/arazzo.ts` exports:

```ts
importArazzoWorkflow(
  doc: unknown,
  collectionId: string,
  collectionItems: CollectionItem[]
): ArazzoImportResult
```

where:

```ts
interface ArazzoImportResult {
  workflows: Workflow[];
  warnings: ImportWarning[];
}
```

The caller (ImportDialog) dispatches each `Workflow` via `useWorkflowStore.getState().addWorkflow(workflow)`.

#### D.2 — Arazzo 1.1 document object model consumed

| Arazzo field                          | Used for                                                                                                  |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `info.title`                          | `Workflow.name` (suffixed with workflow index if >1)                                                      |
| `info.summary`                        | `Workflow.description`                                                                                    |
| `workflows[i].workflowId`             | `Workflow.id` (nanoid fallback if missing)                                                                |
| `workflows[i].inputs`                 | `Workflow.variables[]` (JSON Schema properties → `KeyValue[]`)                                            |
| `workflows[i].steps[]`                | `Workflow.requests[]` + `WorkflowGraph.nodes[]`                                                           |
| `workflows[i].dependsOn[]`            | Edge from dependency workflow end-node → this workflow start-node                                         |
| `steps[j].stepId`                     | `WorkflowRequest.id` + `FlowNode.id`                                                                      |
| `steps[j].operationId`                | Looked up in `collectionItems` by `request.operationId` field or name match → `WorkflowRequest.requestId` |
| `steps[j].parameters[]`               | `WorkflowRequest.variables[]`                                                                             |
| `steps[j].requestBody.payload`        | `WorkflowRequest.body` override                                                                           |
| `steps[j].successCriteria[]`          | `ConditionFlowNode` inserted after step node                                                              |
| `steps[j].onSuccess[].type = 'goto'`  | Edge to named step node                                                                                   |
| `steps[j].onSuccess[].type = 'end'`   | Edge to end node                                                                                          |
| `steps[j].onFailure[].type = 'retry'` | `WorkflowRequest.retryCount` + `WorkflowRequest.retryDelay`                                               |
| `steps[j].onFailure[].type = 'goto'`  | Edge to named step node                                                                                   |
| `steps[j].timeout`                    | `WorkflowRequest.timeout`                                                                                 |

#### D.3 — Step → FlowNode type mapping

| Arazzo step characteristic              | Restura `FlowNodeKind`                                   |
| --------------------------------------- | -------------------------------------------------------- |
| `operationId` present                   | `request`                                                |
| `workflowId` present (nested workflow)  | `subWorkflow`                                            |
| `channelPath` present, action `receive` | `sseSubscribe` [assumption: channel must resolve to SSE] |
| Has `successCriteria` with `condition`  | `condition` (inserted as edge node after the step)       |
| `onFailure[].type = 'retry'`            | Loop edge back to step node                              |
| `forEach` in Arazzo extensions (future) | `forEach`                                                |

#### D.4 — Runtime expression handling

Any Arazzo runtime expression (`$url`, `$method`, `$request.body#/...`, `$response.body#/...`, `$inputs.<name>`, `$steps.<stepId>.outputs.<name>`) is preserved as a literal string in the relevant field and triggers:

```ts
ImportWarning { kind: 'unknown-dynamic-var', detail: 'Arazzo runtime expression "<expr>" — evaluate manually or await expression engine support' }
```

#### D.5 — ImportDialog wiring for Arazzo

- Add `'arazzo'` to `ImportType`.
- `FORMATS` entry: `{ id: 'arazzo', name: 'Arazzo', tagline: 'Workflow-as-code', initials: 'AZ', color: '#ff6b35', accept: '.yaml,.yml,.json' }`.
- `IMPORTERS['arazzo']` requires a second UI step: after format selection and file parse, a `<CollectionPicker>` dialog renders to let the user select which collection to bind the workflow to. The selected `collectionId` and flattened `collectionItems` are passed to `importArazzoWorkflow(doc, collectionId, items)`.
- Each returned `Workflow` is dispatched via `useWorkflowStore.getState().addWorkflow(...)`.
- `validateWorkflowGraph` (from `src/features/workflows/lib/workflowIO.ts`) is called on each `WorkflowGraph` before `addWorkflow`; failures emit a non-blocking warning rather than aborting.

---

## 7. UX & Flows

### Import dialog — new format tiles

```
┌─────────────────── Import Collection ──────────────────────┐
│                                                             │
│  Format:                                                    │
│  ┌──────┐  ┌──────┐  ┌──────┐  ┌──────┐  ┌──────┐        │
│  │  PM  │  │  IN  │  │  OA  │  │  BR  │  │  HO  │  ...   │
│  └──────┘  └──────┘  └──────┘  └──────┘  └──────┘        │
│                            [NEW TILES BELOW]               │
│  ┌──────┐  ┌──────┐  ┌──────┐  ┌──────┐                   │
│  │  HF  │  │  AS  │  │  AZ  │  │  OC  │                   │
│  │.http │  │Async │  │Arazzo│  │ OC   │                   │
│  │ file │  │ API  │  │      │  │      │                   │
│  └──────┘  └──────┘  └──────┘  └──────┘                   │
│                                                             │
│  Drop file here or paste content                           │
│  ┌─────────────────────────────────────────────────────┐   │
│  │                                                     │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  [storeSecretsAsHandles checkbox — desktop only]            │
│                                                             │
│  [Cancel]                              [Import]            │
└─────────────────────────────────────────────────────────────┘
```

### Arazzo — additional collection-picker step

```
After format selection and file parse, before final Import:

┌─────── Bind workflow to collection ───────────────────┐
│                                                       │
│  Arazzo: "Pet Store Auth Flow" (2 workflows, 6 steps) │
│                                                       │
│  Select collection:  [ My API Collection      ▾ ]    │
│                                                       │
│  Operations will be matched by operationId name.      │
│  Unmatched steps will use placeholder nodes.          │
│                                                       │
│  [Back]                              [Import Workflow] │
└───────────────────────────────────────────────────────┘
```

### Warning panel (all formats)

After import completes, if `result.warnings.length > 0`:

```
┌─── Import completed with N warning(s) ────────────────────┐
│ ⚠  JetBrains pre-request JS block — not yet executable    │
│    in Restura QuickJS sandbox  (2 requests affected)       │
│ ⚠  Arazzo runtime expression "$response.body#/token"       │
│    preserved as literal string  (step: "exchangeToken")    │
│ ⚠  Kafka channel "orders" requires Restura desktop app     │
│ [Dismiss]                                                  │
└────────────────────────────────────────────────────────────┘
```

### Bruno export flow (desktop)

```
Collection context menu
  → Export
    → Bruno (.bru) directory...      ← new menu item
        ↓
  Native save-dialog (openDirectory)
        ↓
  Write files via file-operations.ts
        ↓
  Toast: "Exported N requests to /path/to/dir"
```

### Bruno export flow (web)

```
Collection context menu
  → Export
    → Bruno (.bru) ZIP download      ← new menu item
        ↓
  Build ZIP in-memory (fflate)
        ↓
  Browser download: <collection-name>.bru.zip
```

---

## 8. Architecture & Implementation

### New files

| File                                                   | Purpose                                                                                                                   |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `src/features/collections/lib/importers/bru-import.ts` | Native `.bru` **import** (the exporter at `lib/bruno-exporter.ts` already exists — this is the missing inbound direction) |
| `src/features/collections/lib/importers/http-file.ts`  | `.http` parser: dialect-agnostic base + VS Code / JetBrains dialect detection                                             |
| `src/features/collections/lib/importers/asyncapi.ts`   | AsyncAPI 3.0 importer: SSE → collection items; Kafka/MQTT → connection seeds                                              |
| `src/features/collections/lib/importers/arazzo.ts`     | Arazzo 1.1 importer: steps → WorkflowRequest[] + WorkflowGraph                                                            |

### Modified files

| File                                              | Change                                                                                                                                                                                                              |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/features/collections/lib/importers/index.ts` | Add barrel exports: `importBruFile`, `importHttpFile`, `importAsyncAPIDocument`, `importArazzoWorkflow` (the existing `exportBrunoCollection` lives in `lib/bruno-exporter.ts`, imported directly by `Sidebar.tsx`) |
| `src/components/shared/ImportDialog.tsx`          | Add `'http-file' \| 'asyncapi' \| 'arazzo'` to `ImportType`; extend `FORMATS`, `FEATURE_LISTS`, `IMPORTERS`; extend `parseFileContent` for `.http`; add Arazzo collection-picker step                               |
| `src/lib/shared/capabilities.ts`                  | Add `'import.asyncapi.kafka'` and `'import.asyncapi.mqtt'` (web: false, desktop: true) as new `CapabilityName` entries so `<CapabilityBadge>` can gate the desktop-only warning                                     |
| `src/features/collections/components/Sidebar.tsx` | Bruno export menu item already exists (line 302); swap its `bruno-archive/v1` JSON download for a real `.zip` (web)                                                                                                 |
| `electron/main/storage/file-operations.ts`        | Add `saveBrunoExport(files: BruFile[], dir: string)` helper for the deferred Electron "save to folder" path                                                                                                         |
| `docs/CAPABILITY_MATRIX.md`                       | **Regenerate** via `npm run capabilities:matrix` after `capabilities.ts` edit — do not hand-edit                                                                                                                    |

### Dependency mapping

```
ImportDialog.tsx
    ├─ importers/http-file.ts        (no new npm deps — custom parser)
    ├─ importers/asyncapi.ts         (js-yaml already in tree for YAML parse)
    │     ├─ useKafkaStore (dispatch KafkaConnection seeds)
    │     └─ useMqttStore  (dispatch MqttConnection seeds)
    ├─ importers/arazzo.ts           (js-yaml; validateWorkflowGraph from workflowIO.ts)
    │     └─ useWorkflowStore (dispatch Workflow)
    ├─ importers/bru-import.ts       (NEW: native .bru → Request; @usebruno/lang already in tree)
    └─ lib/bruno-exporter.ts         (EXISTING: exportBrunoCollection, already wired to Sidebar.tsx)
          └─ loadBrunoLang() → @usebruno/lang (already in package.json)
                ├─ jsonToBruV2
                ├─ envJsonToBruV2
                └─ jsonToCollectionBru
```

### Dependency notes

- `@usebruno/lang` — already in `package.json` (`^0.37.0`); covers both the existing exporter and the new `.bru` importer.
- `js-yaml` — already used by the OpenAPI importer (covers AsyncAPI / Arazzo YAML parse).
- `fflate` — **NOT currently a dependency** (absent from `package.json` and `node_modules`). Required only if/when the web Bruno export is upgraded from the `bruno-archive/v1` JSON wrapper to a real `.zip`. Treat as a deliberate new dependency, scoped to that sub-task — not a free reuse.
- AsyncAPI and Arazzo schema validation libraries are **not** introduced; structural validation is handled by defensive property reads with `??.` chains and `ImportWarning` emission, consistent with the existing importer pattern.

---

## 9. Security

### Imported scripts — sandbox enforcement

JetBrains `{% %}` script blocks and Bruno `script:pre-request` / `script:tests` blocks are stored as inert strings in `preRequestScript` / `testScript` on `CollectionItem`. They are never auto-executed. Execution only occurs when the user explicitly triggers a request send or collection run, at which point `src/features/scripts/lib/scriptExecutor.ts` routes them through the QuickJS WASM sandbox with memory and execution-time caps. This is identical to how Postman `pm.*` scripts are handled after `migrateScriptPmToRs()`.

JetBrains scripts may call browser-like APIs (`client.global.set`, `client.test`) that do not exist in the QuickJS sandbox. These calls will throw at runtime, not at import time. A follow-on task can add a `jetbrains-to-rs` migration function analogous to `migrateScriptPmToRs()`.

### Secret handling — AsyncAPI and `.http` files

Any password, API key, or token literal found in an AsyncAPI `securitySchemes` or a `.http` Authorization header is handled the same way as all other imported secrets: if `storeSecretsAsHandles` is checked (Electron-only), the value is immediately transferred to the OS keychain via `electron/main/security/secret-handle-store.ts` and replaced with a `SecretRef { kind: 'handle', id, label }` before the collection or connection record is written to the Zustand store. On web, the value lands in the Dexie-backed store (encrypted at rest via `secure-storage.ts`).

### SSRF — no new outbound surface

These importers are pure parsing functions. They do not make network requests. The existing SSRF guard in `shared/protocol/url-validation.ts` is invoked at send time, not import time, which is correct and unchanged.

### AsyncAPI `$ref` resolution — no remote fetching

`$ref` values in AsyncAPI/Arazzo documents are resolved only within the parsed document object (in-memory JSON Pointer walk). Remote `$ref` URLs are not fetched. Unresolvable `$ref`s produce an `ImportWarning` and the referencing field is omitted.

### Arazzo `sourceDescriptions[].url` — not fetched

The `url` field of each `sourceDescriptions` entry is stored for informational display only. The importer does not fetch the referenced OpenAPI/AsyncAPI document. If the user wants to import the referenced spec, they do so separately.

---

## 10. Data Model / Persistence

### No schema changes to `Collection` or `CollectionItem`

The new importers produce collections using the existing `Collection` / `CollectionItem` / `SseRequest` types from `src/types/collection.ts` and `src/types/streaming.ts`. No migration is required.

### No schema changes to `Workflow` or `WorkflowGraph`

`importArazzoWorkflow` produces `Workflow` objects that conform to the existing type in `src/types/workflow.ts`. `WorkflowGraph.version` remains `1`.

### New connection seeds — Kafka and MQTT

`KafkaConnection` (from `src/features/kafka/store/useKafkaStore.ts`) and `MqttConnection` (from `src/features/mqtt/store/useMqttStore.ts`) are persisted by the respective Zustand stores (Dexie on web [**[assumption]**: MQTT/Kafka stores use Dexie persistence]; electron-store on desktop). The importer produces `Partial<KafkaConnection>` / `Partial<MqttConnection>` seeds; the store's `createConnection` action (the actual method — not `addConnection`) supplies the remaining defaults (status, messages, createdAt, etc.) and returns the new id, which the importer then patches with `updateConnection`.

### Secret persistence path

On Electron, `storeSecretsAsHandles = true` causes imported secrets to be routed through `secret-handle-store.ts` before any store write. On web, secrets land as `{ kind: 'inline', value }` in the encrypted Dexie store. This matches existing behaviour for all other importers.

### Bruno export — filesystem

Export writes are mediated by `electron/main/storage/file-operations.ts` on desktop (no new IPC channel; extend existing `saveFile` or add `saveBrunoExport`). On web, the export is a client-side ZIP blob; no server state is mutated.

---

## 11. Capability Matrix Impact

### Proposed new `CapabilityName` entries in `src/lib/shared/capabilities.ts`

```ts
'import.asyncapi.kafka': {
  label: 'AsyncAPI import → Kafka connection seed',
  web: false,
  desktop: true,
  notes: 'Kafka is native TCP; no browser support'
},
'import.asyncapi.mqtt': {
  label: 'AsyncAPI import → MQTT connection seed',
  web: false,
  desktop: true,
  notes: 'MQTT is native TCP; no browser support'
},
```

Adding these entries is a new pattern (no existing `import.*` keys). The benefit is that `<CapabilityBadge feature="import.asyncapi.kafka">` can render a "Desktop only" badge in the warning panel and documentation. The alternative is to hardcode the `isElectron()` check inside `ImportDialog.tsx` — acceptable but less consistent with the codebase's intent.

After adding entries: **`npm run capabilities:matrix` must be run** to regenerate `docs/CAPABILITY_MATRIX.md`; `npm run capabilities:check` is the CI gate.

### Formats that are web + desktop

| New format                | Web | Desktop | Notes                               |
| ------------------------- | --- | ------- | ----------------------------------- |
| `.http` import            | yes | yes     | Paste or file-picker                |
| Bruno `.bru` export (ZIP) | yes | —       | fflate in-browser                   |
| Bruno `.bru` export (dir) | —   | yes     | native save-dialog                  |
| AsyncAPI → SSE requests   | yes | yes     | SSE is `web: true` in capabilities  |
| AsyncAPI → Kafka seeds    | no  | yes     | New `import.asyncapi.kafka` cap     |
| AsyncAPI → MQTT seeds     | no  | yes     | New `import.asyncapi.mqtt` cap      |
| Arazzo → Workflow         | yes | yes     | Workflow model is platform-agnostic |

---

## 12. Acceptance Criteria & Test Plan

### Vitest unit tests (colocated `*.test.ts` pattern)

#### AC-A1 — Bruno round-trip (lossless)

**File:** `src/features/collections/lib/importers/__tests__/bru-roundtrip.test.ts`

```
Given: a fixture directory of .bru files (real Bruno collection)
When: importBrunoCollection(source) → exportBrunoCollection(collection)
Then: each output file.content === original file content
      (modulo trailing-newline normalisation, ±1 byte)
```

Fixture: copy 5–10 real `.bru` files from the Bruno public test corpus.

#### AC-A2 — Bruno export produces valid `.bru` syntax

```
Given: a Restura collection with HTTP, GraphQL, auth (basic, bearer, apikey) requests
When: exportBrunoCollection(collection)
Then: each file.content parses back via bruToJsonV2 without error
      the round-tripped name/url/method matches the original
```

#### AC-B1 — VS Code REST Client import

**File:** `src/features/collections/lib/importers/__tests__/http-file.test.ts`

```
Given: fixture.http with 3 ### blocks, @baseUrl file var, {{baseUrl}} references
When: importHttpFile(raw)
Then: result.collection.items.length === 3
      result.environments[0].variables[0].key === 'baseUrl'
      each item.request.url contains '{{baseUrl}}'
      result.warnings.length === 0
```

#### AC-B2 — JetBrains dialect detection and script warning

```
Given: fixture-jetbrains.http with a > {% client.test(...) %} block
When: importHttpFile(raw)
Then: result.collection.items[0].testScript is a non-empty string
      result.warnings contains one entry with kind === 'unrecognized-script-type'
```

#### AC-B3 — System variable warning

```
Given: fixture with {{$guid}} in a URL
When: importHttpFile(raw)
Then: result.warnings contains one entry with kind === 'unknown-dynamic-var'
      result.collection.items[0].request.url contains '{{$guid}}' (preserved)
```

#### AC-C1 — AsyncAPI SSE channel → SseRequest

**File:** `src/features/collections/lib/importers/__tests__/asyncapi.test.ts`

```
Given: fixture-asyncapi-sse.yaml with protocol: http, channel address /events, contentType: text/event-stream
When: importAsyncAPIDocument(doc, { isDesktop: false })
Then: result.collection.items[0].request.type === 'sse'
      result.collection.items[0].request.url ends with '/events'
      result.kafkaConnections === undefined
```

#### AC-C2 — AsyncAPI Kafka channel → KafkaConnection seed (desktop)

```
Given: fixture-asyncapi-kafka.yaml with protocol: kafka, channel binding topic: 'orders'
When: importAsyncAPIDocument(doc, { isDesktop: true })
Then: result.kafkaConnections.length === 1
      result.kafkaConnections[0].defaultTopic === 'orders'
      result.collection.items.length === 0  // no collection items for Kafka
```

#### AC-C3 — AsyncAPI Kafka channel → platform-unsupported warning (web)

```
Given: same fixture-asyncapi-kafka.yaml
When: importAsyncAPIDocument(doc, { isDesktop: false })
Then: result.warnings contains entry with kind === 'platform-unsupported'
      result.kafkaConnections === undefined
```

#### AC-C4 — AsyncAPI WebSocket channel → skipped with warning

```
Given: fixture-asyncapi-ws.yaml with protocol: ws
When: importAsyncAPIDocument(doc, { isDesktop: true })
Then: result.warnings contains entry with kind === 'platform-unsupported', detail mentioning WebSocket
      result.collection.items.length === 0
```

#### AC-D1 — Arazzo step → WorkflowRequest

**File:** `src/features/collections/lib/importers/__tests__/arazzo.test.ts`

```
Given: fixture-arazzo.yaml with 1 workflow, 3 steps, each with operationId matching a collectionItem
When: importArazzoWorkflow(doc, collectionId, collectionItems)
Then: result.workflows.length === 1
      result.workflows[0].requests.length === 3
      result.workflows[0].graph.nodes has a 'request' node for each step
```

#### AC-D2 — Arazzo successCriteria → ConditionFlowNode

```
Given: fixture with step having successCriteria[0].condition = '$response.statusCode == 200'
When: importArazzoWorkflow(doc, ...)
Then: graph.nodes contains a 'condition' node after the step's 'request' node
      result.warnings contains entry with kind === 'unknown-dynamic-var' for '$response.statusCode'
```

#### AC-D3 — Arazzo inputs → Workflow.variables

```
Given: fixture with workflow.inputs JSON Schema { properties: { token: { type: 'string' } } }
When: importArazzoWorkflow(doc, ...)
Then: result.workflows[0].variables[0].key === 'token'
```

#### AC-D4 — validateWorkflowGraph is called and failures are non-blocking

```
Given: a malformed Arazzo document producing an invalid graph
When: importArazzoWorkflow(doc, ...)
Then: result.workflows is empty OR result.warnings contains a schema-version / structural warning
      the function does not throw
```

### E2E test considerations

- No new Playwright e2e specs required for Phase 1 (`.bru` export + `.http` import). Unit tests cover the parsing logic entirely.
- Phase 2 (AsyncAPI) and Phase 3 (Arazzo) may warrant a light e2e smoke in `e2e/real-http.spec.ts` verifying the import dialog accepts the new format tiles and displays the warning panel.

---

## 13. Success Metrics

| Metric                                             | Baseline (current)   | Target (90 days post-Phase 3 launch)                    | Measurement                                                                  |
| -------------------------------------------------- | -------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Collections imported per week                      | Existing baseline    | +15% absolute increase                                  | Telemetry: `import.completed` event with `format` property                   |
| Bruno format share of imports                      | 100% JSON/YAML Bruno | >30% `.bru` plain-text                                  | `import.completed.format = 'bruno-bru'`                                      |
| `.http` imports per week                           | 0                    | >200/week (top-10 user cohort)                          | `import.completed.format = 'http-file'`                                      |
| AsyncAPI import → workflow run rate                | N/A                  | >40% of AsyncAPI imports result in a send within 10 min | Session funnel: import → first SSE connect                                   |
| Arazzo import → workflow execution rate            | N/A                  | >50% of Arazzo imports result in workflow run           | `workflow.run.started` within 30 min of `import.completed.format = 'arazzo'` |
| Import warning dismissal rate                      | N/A                  | <20% of imports with warnings abandoned                 | `import.abandoned` / `import.completed` ratio                                |
| P95 import parse time (AsyncAPI, 1000-channel doc) | N/A                  | <500 ms                                                 | Vitest bench or DevTools trace                                               |

**Telemetry note:** All import events must redact the imported content; only format, item count, and warning count are sent. This is consistent with the existing Sentry scrub policy in `electron/main/lifecycle/sentry.ts`.

---

## 14. Rollout Phases

### Phase 1 — Bruno round-trip export + `.http` import (Est. 2 weeks)

**Goal:** Close the two highest-demand gaps (Bruno Migrant and HTTP Scratch Pad User) with zero new protocol surface.

**Deliverables:**

- `bru-import.ts` (native `.bru` **import** — exporter already ships in `lib/bruno-exporter.ts`; real-ZIP web packaging is a separate optional sub-task needing `fflate`)
- `http-file.ts` (`.http` parser, both dialects)
- `ImportDialog.tsx` updated for `'http-file'` format tile
- Collection context-menu `Export → Bruno (.bru)` on web (ZIP) and desktop (dir save)
- Unit tests: `bru-roundtrip.test.ts`, `http-file.test.ts`
- `capabilities:check` and `type-check:all` passing

**Success criterion:** AC-A1, AC-A2, AC-B1, AC-B2, AC-B3 all green in CI.

### Phase 2 — AsyncAPI 3.0 import (Est. 3 weeks)

**Goal:** Give event-driven teams an SSE on-ramp on web + desktop, and Kafka/MQTT connection seeding on desktop.

**Deliverables:**

- `asyncapi.ts` importer
- `ImportDialog.tsx` updated for `'asyncapi'` format tile + Kafka/MQTT dispatch
- `capabilities.ts` new entries + `capabilities:matrix` regenerated
- `<CapabilityBadge>` used in ImportDialog warning panel for Kafka/MQTT web gap
- Unit tests: `asyncapi.test.ts` (AC-C1 through AC-C4)

**Success criterion:** AC-C1 through AC-C4 green; `capabilities:check` passes; no regression in existing importer tests.

### Phase 3 — Arazzo 1.1 import (Est. 3 weeks)

**Goal:** First-mover Arazzo execution engine; direct value for MCP workflow authors.

**Deliverables:**

- `arazzo.ts` importer
- `ImportDialog.tsx` updated for `'arazzo'` format tile + collection-picker step
- Unit tests: `arazzo.test.ts` (AC-D1 through AC-D4)
- Docs update: `docs/adr/NNNN-arazzo-import.md` (warranted: new workflow import surface)

**Success criterion:** AC-D1 through AC-D4 green; `type-check:all` passes; `validate` script passes end-to-end.

### Phase 4 — Follow-ons (post-launch, scoped separately)

- JetBrains script migration (`jetbrains-to-rs` function in `migrateScriptPmToRs` style)
- Arazzo runtime expression evaluation engine
- AsyncAPI → WebSocket collection item (requires WS request type in collection model)
- AsyncAPI `$ref` remote resolution (guarded by SSRF guard)
- Arazzo `sourceDescriptions` chained import

---

## 15. Risks & Open Questions

### R1 — `@usebruno/lang` serialiser output format drift

**Risk (Medium):** `jsonToBruV2` output format may diverge from what the Bruno app reads in future Bruno releases, breaking the round-trip for teams on newer Bruno versions.  
**Mitigation:** Pin `@usebruno/lang` version in `package.json` (already done for import); add `bru-roundtrip.test.ts` fixtures covering the Bruno version range actively used in the wild. Update the pin with explicit QA on each Bruno release.

### R2 — AsyncAPI 3.0 binding specs are sparse

**Risk (Low–Medium):** Kafka and MQTT binding objects in AsyncAPI 3.0 documents in the wild often omit optional fields (topic, QoS, security scheme). Importer produces thin `KafkaConnection` / `MqttConnection` seeds that users must complete manually.  
**Mitigation:** Emit informative `ImportWarning` for each omitted required field; surface them in the warning panel with suggested next steps. This is preferred over blocking the import.

### R3 — `.http` dialect misclassification

**Risk (Low):** A VS Code `.http` file that happens to contain `> {%` text in a comment or body could be misclassified as JetBrains dialect, triggering false `unrecognized-script-type` warnings.  
**Mitigation:** Dialect detection only fires on `> {%` that appears as the first non-whitespace content on its line (standalone block marker). Body content with this pattern is inside the body parse window and ignored by the dialect detector.

### R4 — Arazzo `operationId` name collisions

**Risk (Medium):** When an Arazzo step references `operationId: createUser` and the bound collection has multiple requests named "Create User" (different folders), the match is ambiguous.  
**Mitigation:** Match on `request.operationId` field first (if exposed), then on exact name, then on partial name. On ambiguity, use the first match and emit `ImportWarning { kind: 'unrecognized-body', detail: 'Multiple candidates for operationId ...' }` listing all matches for user review.

### R5 — `validateWorkflowGraph` rejects structurally valid Arazzo graphs

**Risk (Low):** The Arazzo → `WorkflowGraph` translation may produce graphs that pass semantic checks but fail the existing `validateWorkflowGraph` Zod schema (e.g., new `FlowNodeKind` values not yet in the schema).  
**Mitigation:** Treat `validateWorkflowGraph` failure as a non-blocking warning (see AC-D4). Log the validation error in `warnings`. Do not prevent the workflow from being added to the store — the user can edit the graph visually.

### Open Questions

| OQ   | Question                                                                                                                                                                                      | Owner            | Target                                          |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ----------------------------------------------- |
| OQ-1 | Should `.http` export (not just import) be in scope? Many teams want a two-way `.http` scratch pad workflow.                                                                                  | PM + Engineering | Phase 1 review                                  |
| OQ-2 | `fflate` is not yet a dependency. Do we ship real `.zip` web export (add `fflate`) now, or keep the existing `bruno-archive/v1` JSON wrapper until the git-native "save to folder" milestone? | PM + Engineering | Phase 1 kickoff                                 |
| OQ-3 | Should Arazzo `sourceDescriptions[].url` be displayed in the Workflow Panel UI, and if so, as a clickable link or a non-interactive label?                                                    | Design + PM      | Phase 3 design review                           |
| OQ-4 | Should AsyncAPI MQTT connections be pre-connected (auto-connect on import) or left disconnected for the user to connect manually?                                                             | PM               | Phase 2 review                                  |
| OQ-5 | Is `import.asyncapi.kafka` / `import.asyncapi.mqtt` the right `CapabilityName` pattern, or should the existing `kafka.basic` / `mqtt.basic` entries serve as the gate?                        | Engineering      | Phase 2 kickoff — before `capabilities.ts` edit |

---

_End of PRD 04 — Momentum Import Formats_

---

## 16. Round-2 Review Addendum (verified findings)

All 8 round-1 corrections (Bruno exporter exists/wired, `fflate` absent, path fixes, scope shift) **re-verified correct**. Remaining items:

| #    | Tag         | Sev  | Finding                                                                                                                                                                                                                                              | Fix                                                                                         |
| ---- | ----------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| R2-1 | CONSISTENCY | High | **FIXED INLINE:** PRD prescribed `useKafkaStore.addConnection(...)` / `useMqttStore.addConnection(...)`, which do not exist (would throw `TypeError`). Real action is `createConnection(...)` (returns id) + `updateConnection(id, …)` for defaults. | Done in §7 and §10.                                                                         |
| R2-2 | FEASIBILITY | Med  | `.http` "file defaults → `ImportResult.environments[0]`" must supply ALL required `Environment` fields (`id`, `createdAt`, …), not just `name`+`variables`.                                                                                          | Verify the `Environment` interface; synthesize missing fields with `nanoid()`/`Date.now()`. |
| R2-3 | OVERCLAIM   | Low  | §8 "no validation libraries" is right, but omits that `js-yaml.load()` is the YAML entry point for AsyncAPI/Arazzo, and `$ref` resolution is an in-document JSON-Pointer walk (no network, per §9 SSRF).                                             | Add a `resolveJsonPointer` helper to `importers/`; document "pointer walk only."            |
| R2-4 | POSITIVE    | —    | All Arazzo node types the mapping needs (`request`, `subWorkflow`, `condition`, `sseSubscribe`) already exist in `flowValidators.ts`; `validateWorkflowGraph` accepts Arazzo-generated graphs unmodified.                                            | De-risks Phase 3.                                                                           |
