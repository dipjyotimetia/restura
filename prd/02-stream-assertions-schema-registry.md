# PRD 02: Streaming Assertion Layer + Schema Registry Resolver

**Status:** Draft  
**Author:** Product (AI)  
**Created:** 2026-06-30  
**Target release:** Next major milestone after PRD review  
**Scope:** Electron desktop primary; SSE / WebSocket / Socket.IO / gRPC assertions also ship on web. Kafka / MQTT streams and all cross-protocol flows are desktop-only.

---

## 1. Summary

Restura is the only mainstream API client with first-class Kafka, MQTT, SSE, WebSocket, Socket.IO, and gRPC support — but today those protocols are viewers, not testers. This PRD adds two linked capabilities: a declarative assertion layer over all six streaming protocols ("message 3 matches Avro schema X," "stream closes with gRPC status OK," "event arrives within 300 ms"), and a completed Confluent Schema Registry resolver that auto-encodes/decodes Kafka and MQTT payloads instead of requiring users to hand-paste schema IDs. The two capabilities combine into a cross-protocol flow primitive in the Workflow canvas ("publish to Kafka → assert a downstream WebSocket event fires"), completing the protocol-breadth moat with a validation layer on top.

**Value prop:** The only developer tool that lets you write `rs.stream.assertMessageMatches(0, avroSchema)` across Kafka, MQTT, SSE, WebSocket, Socket.IO, and gRPC in a single UI — without spinning up Microcks or writing bespoke test harnesses.

---

## 2. Problem & Evidence

### The gap no competitor fills

Restura already ships Kafka, MQTT, SSE, WebSocket, Socket.IO, and gRPC support. None of Postman, Insomnia, Bruno, or Hoppscotch support Kafka as a first-class protocol. But protocol breadth alone is not a moat — it becomes one only when paired with a validation layer.

- **Postman gRPC** = single unary/server-streaming RPC with no multi-step session and no stream assertion API (https://learning.postman.com/docs/sending-requests/grpc/test-examples/). There is no `pm.expect` equivalent for message N of a stream.
- **Microcks** (CNCF incubating project May 2026, https://www.cncf.io/blog/2026/05/07/microcks-becomes-a-cncf-incubating-project/) proves conformance demand for event-driven APIs but requires Kubernetes and is a test-environment tool, not a developer client.
- No mainstream OSS API client performs live streaming assertions inline in the connection UI.

### The Schema Registry sub-problem

The Confluent Schema Registry integration for Kafka is partially shipped: `@kafkajs/confluent-schema-registry ^4.1.0` is installed, `electron/main/handlers/kafka-handler.ts:348-362` constructs the client, and `electron/main/handlers/kafka-serde.ts` exposes `encodeSchemaField` / `decodeField` / `isConfluentEncoded`. However:

- MQTT has zero registry integration (`useMqttStore.ts` carries no `registry` field).
- Registry credentials use a legacy sentinel `KAFKA_SECRET_SENTINEL = '__restura_secret__'` (`useKafkaStore.ts:19`) rather than the ADR-0007 `SecretRef` handle pattern — plaintext passwords can reach the renderer.
- Bearer-token auth is explicitly excluded in `kafka-handler.ts:351-354`.
- There is no UI to browse subjects; users must hand-paste numeric schema IDs (`kafka-handler.ts:434` encodes by integer ID only).
- `decodeField()` returns a plain `string` with no schema-ID metadata (`kafka-serde.ts:88-100`) — the renderer cannot distinguish a registry-decoded Avro object from a plain UTF-8 string, making schema-match assertions impossible without this metadata.

### Why Restura is uniquely positioned

An API client sees every request/response at the wire level and already buffers all streaming messages in typed Zustand stores. No external tool, proxy, or CI runner has that per-message visibility with zero integration overhead.

---

## 3. Goals / Non-Goals

### Goals

1. Declarative per-stream assertions that run in the renderer and surface results in a test-result panel, mirroring the HTTP test-script UX.
2. Complete the Schema Registry story: MQTT support, SecretRef credential migration, subject-browse UI, and schema-ID metadata surfaced on every decoded message.
3. Cross-protocol flow primitive in the Workflow canvas: Kafka/MQTT publish step wired to a downstream streaming-assertion step.

### Non-goals

- Per-message QuickJS invocation (too expensive at > 100 msg/s; custom predicates use QuickJS only at trigger time, not per message).
- A new assertion DSL — assertions extend the existing `rs.*` sandbox with `rs.stream.*`.
- gRPC schema validation against Protobuf descriptors (descriptors are already parsed at reflection time; conformance testing is out of scope).
- OpenCollection export of assertion specs in V1 (OpenCollection types are codegen-gated; assertion specs are excluded from export in phase 1, see section 10).
- Reactive "wait for event" triggers in cross-protocol flows (static `DelayNode` is sufficient for V1; reactive trigger is Phase 2).

---

## 4. Target Users & Top Use Cases

**Backend engineers testing event-driven microservices**

- Assert that every consumed Kafka message decodes against a named Avro subject without a separate consumer harness.
- Verify that a downstream WebSocket bridge emits the expected event within SLA after a Kafka publish.

**QA engineers automating streaming protocol smoke tests in CI**

- Use `e2e-electron/` with the Dockerised Redpanda/EMQX fixture (`echo-local/docker-compose.yml`) to assert "at least N messages consumed," "stream closes OK," "message 3 has field X."
- Include these assertions in collection runs via the CLI (`@restura/cli`).

**Frontend developers testing SSE and WebSocket integrations**

- Assert that an `price.update` SSE event arrives within 300 ms of connecting.
- Assert that the WebSocket initialization sequence sends exactly 5 frames in order.

**IoT engineers working with MQTT + binary payloads**

- Auto-decode Protobuf sensor payloads via Confluent Schema Registry without a separate decode step.
- Assert that retained messages carry the expected schema version.

**Platform engineers validating gRPC streaming RPCs**

- Assert that a server-streaming call closes with `status: OK` and emits at least one result message.
- Include gRPC stream assertions in the workflow canvas alongside HTTP request nodes.

---

## 5. User Stories

**U1 — Schema assertion on Kafka consume**
As a backend engineer, I want to assert that every consumed Kafka message decodes against a named Avro subject so that my consumer integration test fails immediately when a producer breaks the contract.

**U2 — Timing assertion on SSE**
As a frontend developer, I want to assert that an SSE event named `price.update` arrives within 300 ms of connecting so that I catch latency regressions in my event pipeline.

**U3 — Count and ordering assertions on WebSocket**
As a QA engineer, I want to assert that at least 5 WebSocket frames arrive and that the 3rd frame contains a specific JSON field so that I can verify the server sends a complete initialization sequence.

**U4 — Close-status assertion on gRPC stream**
As a platform engineer, I want to assert that a server-streaming gRPC call closes with `status: OK` and emits at least 1 result message so that I can smoke-test my streaming RPC in CI.

**U5 — MQTT schema decode**
As an IoT developer, I want Restura to auto-decode MQTT payloads via the Confluent Schema Registry so that binary Protobuf sensor payloads are readable in the message list without a separate decoder script.

**U6 — Subject browse**
As a developer, I want to browse subjects from the configured Schema Registry and pick one instead of pasting a numeric schema ID so that I don't need a separate Confluent Control Center tab open.

**U7 — Cross-protocol flow**
As an integration tester, I want to publish to a Kafka topic and assert that a downstream WebSocket client receives a specific event within 500 ms so that I can verify my Kafka-to-WebSocket bridge end-to-end in a single Restura workflow.

---

## 6. Functional Requirements

### 6.1 Assertion Vocabulary

Provide a pure evaluator module `shared/protocol/stream-assert/evaluator.ts` that accepts a typed message buffer snapshot and an `AssertionSpec[]` and returns `AssertionResult[]`. Zero Electron / DOM / React dependencies; Vitest-testable.

**Supported predicates across all protocols:**

| Predicate                              | Description                                                                                                                       |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `count.atLeast(n)`                     | Buffer contains >= n non-system messages                                                                                          |
| `count.exactly(n)`                     | Buffer contains exactly n messages                                                                                                |
| `message(n).matches(jsonSchema)`       | n-th message (0-indexed) body validates against an inline JSON-Schema object (using `ajv ^8.20.0`, already in `package.json:133`) |
| `message(n).field(path).equals(value)` | Deep-equal check on a dot-path in parsed body                                                                                     |
| `message(n).receivedWithin(ms)`        | Message timestamp minus connection-open timestamp is <= ms                                                                        |
| `stream.closedWith(status)`            | Stream terminal event matches the given protocol status value                                                                     |
| `stream.anyMessage(predicate)`         | At least one message satisfies a custom JS boolean predicate (QuickJS)                                                            |
| `stream.allMessages(predicate)`        | Every message satisfies a custom JS boolean predicate (QuickJS)                                                                   |

`rs.stream.anyMessage` / `rs.stream.allMessages` run custom predicates in QuickJS only at trigger time (on-disconnect / after-N / manual) — not per message.

### 6.2 Assertion Authoring

Expose predicates as `rs.stream.*` under the existing `rs.*` QuickJS sandbox API. The DTS in `src/features/scripts/lib/scriptApiTypes.ts` is extended so Monaco IntelliSense surfaces completions. The evaluator runs synchronously over the current buffer snapshot — it does not run per-message inside `StreamRegistry`.

Stream test scripts trigger at: on-disconnect/stream-close (default), after-N-messages (configurable), or manual "Run assertions" button.

### 6.3 Protocol Close-Status Mapping

Each protocol's terminal event maps to a normalized `StreamCloseStatus` for `stream.closedWith()`:

| Protocol  | Source                                                                    |
| --------- | ------------------------------------------------------------------------- |
| gRPC      | `GrpcStreamFinal.status: GrpcStatusCode` (`grpcStreamingClient.ts:40-57`) |
| WebSocket | WS close code (integer), `type: 'system'` message in `useWebSocketStore`  |
| SSE       | `kind: 'system'` entry in `useSseStore.log` on disconnect/error           |
| Socket.IO | Disconnect reason string from Socket.IO client                            |
| Kafka     | `CONSUMER_CLOSED` / `ERROR` events in `kafka-handler.ts:271-273`          |
| MQTT      | Broker disconnect / error in `mqtt-handler.ts`                            |

`closeStatus?: StreamCloseStatus` is added to each protocol's connection type (currently absent from all six stores).

### 6.4 Schema Registry — Kafka Completion

The Kafka registry client is already present. The remaining work:

**a. Metadata surfacing:** `decodeField()` currently returns `Promise<string>` with no schema-ID signal (`kafka-serde.ts:88-100`). Extend to return `{ decoded: unknown; schemaId?: number; encoding?: 'avro' | 'protobuf' | 'json'; raw: Buffer | null }`. Thread through `emitConsumedMessage` (`kafka-handler.ts:243`) to `KafkaMessage`. Without this, `message(n).matches()` cannot distinguish a decoded Avro object from plain text.

**b. SecretRef migration:** `KAFKA_SECRET_SENTINEL = '__restura_secret__'` (`useKafkaStore.ts:19`) is replaced by the ADR-0007 `SecretRef` handle pattern (`electron/main/security/secret-handle-store.ts`). Dexie migration block clears existing sentinel values and shows "Re-enter registry password" on next launch.

**c. Bearer-token auth:** `kafka-handler.ts:351-354` currently excludes bearer-token registry auth. Add bearer-token support, token stored as `SecretRef` handle.

**d. Subject browse API:** New IPC channels `kafka:registry:subjects` (returns `string[]`) and `kafka:registry:schema-by-subject` (accepts subject + version, returns schema + schemaId + schemaType) backed by the existing `entry.registry` client.

### 6.5 Schema Registry — MQTT Extension (net-new)

`MqttConnection` has no `registry` field today. Add `registry?: KafkaRegistry` (reuse the same shape). MQTT handler constructs a `SchemaRegistry` client on connect when configured, mirrors `kafka-handler.ts:348-362`. `decodeField()` from `kafka-serde.ts` is called when `isConfluentEncoded(payload)` is true. Decode metadata surfaces on `MqttMessage` using the same extended type from 6.4a.

### 6.6 Schema Registry — Subject Browse UI

A subject-picker dropdown in both Kafka and MQTT config panels replaces free-text schema-ID input. "Browse" button fetches subjects via the IPC channel (6.4d / 6.5 equivalents). Selecting a subject auto-populates the schema ID and shows an "Avro / Protobuf / JSON-Schema" badge. A decoded-payload indicator appears in the message list: "Avro #42" (clicking it shows raw hex + decoded object split view).

### 6.7 Cross-Protocol Flow Primitive

Three new Workflow canvas node types:

- **`KafkaPublishNode`**: produces one message to a configured topic on a named Kafka connection.
- **`MqttPublishNode`**: analogous for MQTT.
- **`StreamAssertNode`**: references a protocol connection, carries an assertion script (Monaco), completes on close/after-N/after-Ms, exposes `pass`, `results[]`, and `messageCount` as output variables for downstream `ConditionNode` / `SetVariableNode`.

The canonical cross-protocol flow ("Kafka publish → WS assert"): `StartNode → KafkaPublishNode → DelayNode → StreamAssertNode[WebSocket] → ConditionNode[pass?] → EndNode`.

The Workflow canvas already has `SseSubscribeNode.tsx` (with `completion.kind: 'eventCount' | 'timeoutMs' | 'eventMatch' | 'connectionClose'`) and `WsExchangeNode.tsx` ("send → match"). `StreamAssertNode` is complementary: it evaluates an assertion script over the buffer rather than matching a single message inline.

---

## 7. UX & Flows

### 7.1 Assertions Tab on Streaming Panels

Each streaming protocol panel gains an "Assertions" tab beside the existing "Messages" / "Log" tab:

```
┌─────────────────────────────────────────────────────────┐
│  Kafka Consumer — orders-topic            [Connected] ▶  │
├──────────┬───────────┬───────────────────────────────────┤
│ Messages │ Producers │ Assertions                         │
├──────────┴───────────┴───────────────────────────────────┤
│  Trigger: [On disconnect ▾]   After: [—]   [▶ Run]       │
├───────────────────────────────────────────────────────────┤
│  // Monaco editor with rs.stream.* IntelliSense           │
│  rs.stream.assertAtLeast(1);                              │
│  rs.stream.assertMessageMatches(0, {                      │
│    type: 'object',                                        │
│    required: ['orderId', 'amount']                        │
│  });                                                      │
│  rs.stream.assertMessageWithin(0, 300);                   │
├───────────────────────────────────────────────────────────┤
│  RESULTS  (last run: 2026-06-30 14:23:11)                 │
│  ✓  count >= 1             1 message received             │
│  ✓  message[0] matches     orderId, amount present        │
│  ✗  message[0] within 300  actual: 412ms  expected: 300ms │
└───────────────────────────────────────────────────────────┘
```

Assertion results show per-assertion pass/fail chips, name, expected vs. actual diff. This mirrors the HTTP "Tests" tab UX.

### 7.2 Schema Registry Panel

Current Kafka config "Registry" section changes:

- Replace free-text `valueSchemaId` / `keySchemaId` fields with subject picker (text field + "Browse" button).
- Registry auth credentials use the `SecretRef` "lock" widget (same as HTTP auth bearer tokens).
- MQTT connection config gains a collapsible "Registry" section matching the Kafka panel (currently absent).

### 7.3 Decoded-Payload Indicator

When a Kafka or MQTT message is registry-decoded, the message row shows a colored schema badge ("Avro #42" or "Protobuf #17"). Clicking it shows raw hex alongside the decoded object in a split view. When decode fails, a yellow "Raw (decode failed)" warning badge appears.

### 7.4 Workflow Canvas Nodes

`KafkaPublishNode` shows topic name + payload preview; `MqttPublishNode` shows topic + QoS. `StreamAssertNode` shows protocol badge + live pass/fail during run. Inspector panels for each node expose connection selector, assertion editor, and completion trigger.

---

## 8. Architecture & Implementation

### 8.1 Evaluator Module Placement

New module: `shared/protocol/stream-assert/evaluator.ts`

```
shared/protocol/stream-assert/
  evaluator.ts     — pure predicate engine; no Electron / DOM / React
  types.ts         — AssertionSpec, AssertionResult, StreamMessage, StreamCloseStatus
  json-schema.ts   — thin ajv wrapper (ajv ^8.20.0 is already in package.json:133)
  index.ts
```

Located in `shared/protocol/` (alongside `http-proxy.ts`, `grpc-proxy.ts`) so it is importable in the renderer, in `cli/`, and in future Worker-side usage without platform-specific imports.

**Why not in `StreamRegistry`?** `stream-registry.ts:18-24` owns only connection bookkeeping (connection map, renderer-destroyed cleanup, `emit` helpers). Assertion evaluation is protocol policy, not bookkeeping — mixing them violates the seam pattern documented in CLAUDE.md.

**Why not per-message QuickJS?** `scriptExecutor.ts` spins up a full QuickJS WASM context per invocation (memory + execution-time capped). At 500 msg/s this is prohibitive. The pure evaluator runs synchronously in the renderer's JS engine with no sandbox overhead. QuickJS is invoked only for custom predicate scripts (`stream.any` / `stream.all`) at the trigger point. [assumption: > 100 msg/s makes per-message QuickJS non-viable; benchmark in Vitest before shipping to confirm.]

### 8.2 ScriptHostBridges Extension

`src/features/scripts/lib/scriptExecutor.ts` exposes `ScriptHostBridges { sendRequest?, cookies?, vault?, judge? }`. Add `stream?: StreamBridge` where `StreamBridge.messages(connectionId)` reads the typed Zustand store at evaluation time and returns a `StreamMessage[]` snapshot. Follows the same extension pattern as the `judge` bridge.

### 8.3 decodeField Return-Type Change

This is the most impactful type change in Phase 2. Current:

```ts
// kafka-serde.ts:88
async function decodeField(registry, buf: Buffer | null): Promise<string>;
```

Proposed:

```ts
interface DecodeResult {
  decoded: unknown;
  schemaId?: number;
  encoding?: 'avro' | 'protobuf' | 'json';
  raw: Buffer | null;
}
async function decodeField(
  registry: SchemaDecoder | undefined,
  buf: Buffer | null
): Promise<DecodeResult>;
```

`emitConsumedMessage` in `kafka-handler.ts:243` passes `DecodeResult` onward. `KafkaMessage.value` changes from `string` to a `KafkaDecodedValue` union. Every consumer of `KafkaMessage.value` must be audited. Use `npm run type-check:all` (not just `type-check`) — the renderer `type-check` excludes `electron/main/` and will miss main-process callsites. Pay attention to `src/features/http/tsconfig.json` (`exactOptionalPropertyTypes: true`): if `KafkaDecodedValue` flows into the http feature tree it must be strictly optional-safe.

### 8.4 Desktop-Only Reality

`capabilities.ts` is the single source of truth. Kafka, MQTT, and cross-protocol flows are `web: false, desktop: true` (no browser TCP). SSE, WebSocket, Socket.IO, and gRPC streaming assertions are `web: true, desktop: true`. See section 11 for the full capability diff.

### 8.5 Keeping `shared/protocol/` Backend-Agnostic

The `stream-assert/` evaluator must not import from `electron/main/`, `worker/`, or `src/` (renderer). It is a pure function over a typed snapshot. Platform-specific concerns (reading Zustand stores, constructing `StreamBridge`) live in the renderer; the evaluator only receives the already-projected `StreamMessage[]`.

### 8.6 Workflow Executor Extension

`StreamAssertNode` executor mirrors `SseSubscribeNode.tsx` pattern: subscribe/wait on the completion trigger, then call `evaluate()` from `stream-assert/evaluator.ts`. `KafkaPublishNode` / `MqttPublishNode` executors call existing produce IPC channels. The `mqtt:publish` IPC channel already exists (`electron/main/handlers/mqtt-handler.ts:277-278`, registered via `createValidatedHandler` with `MqttPublishSchema`), so `MqttPublishNode` can reuse it directly.

---

## 9. Security

### 9.1 Registry Endpoint SSRF Guard

The Schema Registry URL is a new outbound endpoint. Both Kafka and MQTT registry connections must call `assertRegistryUrlSafe(url)` (already exists in `electron/main/security/kafka-broker-guard.ts:53`) before constructing the `SchemaRegistry` client. This guard allows private-RFC-1918 addresses (registries routinely run on internal networks) while blocking cloud-metadata endpoints (169.254.169.254, etc.). The MQTT handler must add this call at the same point `assertMqttBrokerSafe()` is called (`mqtt-broker-guard.ts`).

### 9.2 Registry Credentials as SecretRef Handles

Registry passwords and tokens must follow ADR-0007: stored in `electron/main/security/secret-handle-store.ts` (electron-store + `safeStorage` OS keychain), never reaching the renderer or Dexie. `KAFKA_SECRET_SENTINEL = '__restura_secret__'` is retired. The Dexie migration block (see section 10) clears sentinel values on upgrade. The `KafkaRegistry.auth` shape migrates to `{ username?: string; passwordRef?: SecretRef; tokenRef?: SecretRef }`. `collection-export-redactor.ts` must be updated to ensure registry credentials are stripped from exported collections (currently only the sentinel string pattern is caught).

### 9.3 No Secret Leakage via IPC Channels

The new `kafka:registry:subjects` and `kafka:registry:schema-by-subject` IPC channels return schema metadata only — they never return credential material. The IPC validator (`ipc-validators.ts`) must enforce that the input is a valid `connectionId` string; the handler resolves the live `SchemaRegistry` client from `StreamRegistry` (which already holds it after connect) rather than accepting a raw URL/credentials from the renderer.

### 9.4 Subject-Browse Scope

Registry subject enumeration exposes what topics exist. This is intentional (same as Kafka topic list). No additional guard beyond the existing connection-scoped registry client is needed — the renderer can only trigger the IPC call for a connection it has already opened.

---

## 10. Data Model / Persistence

### 10.1 StreamMessage (Normalized Cross-Protocol View Model)

```ts
interface StreamMessage {
  id: string;
  direction: 'in' | 'out' | 'system';
  protocol: 'kafka' | 'mqtt' | 'websocket' | 'sse' | 'socketio' | 'grpc';
  timestamp: number; // Date.now() at renderer receive (see NFR note below)
  body: unknown; // parsed object if decode succeeded, string otherwise
  bodyRaw?: string; // original UTF-8 string (text protocols)
  schemaId?: number; // Kafka/MQTT registry decode only
  schemaEncoding?: 'avro' | 'protobuf' | 'json';
  topic?: string; // Kafka/MQTT
  event?: string; // SSE event name
  closeCode?: number; // WebSocket close
  grpcStatus?: number; // gRPC terminal message only
}
```

View-model only — not stored in any Zustand store. Projected from the per-protocol store at evaluation time.

**Timestamp accuracy:** Renderer-side `Date.now()` is stamped at `addMessage` call time (current behavior in `useWebSocketStore.ts:262`, `useSseStore.ts:184`). For Kafka/MQTT, the timestamp is stamped when the IPC payload arrives in the renderer, not at the broker. IPC latency adds ~5-15 ms. [assumption: this is acceptable for most timing assertions; if wire-accurate timing is needed, the main process must stamp before encoding the IPC payload. Deferred to Phase 2.]

### 10.2 AssertionSpec (Stored)

```ts
type AssertionSpec =
  | { kind: 'count.atLeast'; n: number }
  | { kind: 'count.exactly'; n: number }
  | { kind: 'message.matches'; index: number; schema: Record<string, unknown> }
  | { kind: 'message.field'; index: number; path: string; expected: unknown }
  | { kind: 'message.within'; index: number; ms: number }
  | { kind: 'stream.closedWith'; status: StreamCloseStatus }
  | { kind: 'stream.any'; predicate: string }
  | { kind: 'stream.all'; predicate: string };
```

Zod schema for this union lives in `src/lib/shared/store-validators.ts` alongside `ConsoleFrameSchema`.

### 10.3 AssertionResult (Volatile)

```ts
interface AssertionResult {
  spec: AssertionSpec;
  pass: boolean;
  actual?: unknown;
  expected?: unknown;
  error?: string;
}
```

Not persisted. Recalculated on every trigger.

### 10.4 KafkaRegistry (Updated Shape)

Before:

```ts
interface KafkaRegistry {
  url: string;
  auth?: { username?: string; password?: string; token?: string };
}
```

After:

```ts
interface KafkaRegistry {
  url: string;
  auth?: {
    username?: string;
    passwordRef?: SecretRef; // replaces KAFKA_SECRET_SENTINEL password
    tokenRef?: SecretRef; // replaces KAFKA_SECRET_SENTINEL token
  };
}
```

### 10.5 Persistence Approach

Assertion specs (`assertionScript: string` on each connection) and `closeStatus?: StreamCloseStatus` are added to each protocol's connection config object in its existing Zustand store. They persist via Dexie (web) or encrypted electron-store (desktop). Message buffers and assertion results are excluded from persistence (already the pattern across all stores: `messages: []` in `partialize`).

**Dexie version bump required** in `dexie-storage.ts` for: (a) new connection config fields, (b) `KafkaRegistry.auth` shape change, (c) sentinel migration block. The migration block strips `KAFKA_SECRET_SENTINEL` values and writes `{ passwordRef: undefined }` placeholders, triggering a "Re-enter registry password" UI indicator on first launch after upgrade.

**OpenCollection exclusion (V1):** OpenCollection types are codegen-gated (`verify:opencollection-types`). Adding assertion specs requires modifying the OC JSON Schema and regenerating — cost deferred to Phase 2. Assertion specs are explicitly excluded from `from-internal.ts` export and `collection-export-redactor.ts` in Phase 1.

---

## 11. Capability Matrix Impact

`src/lib/shared/capabilities.ts` must be extended before `npm run capabilities:check` passes. After adding keys, run `npm run capabilities:matrix` to regenerate `docs/CAPABILITY_MATRIX.md`.

**New `CapabilityName` entries:**

```ts
| 'stream.assertions.web'       // SSE / WS / Socket.IO / gRPC assertions
| 'stream.assertions.kafka'     // Kafka stream assertions
| 'stream.assertions.mqtt'      // MQTT stream assertions
| 'stream.schemaRegistry.kafka' // Schema Registry for Kafka
| 'stream.schemaRegistry.mqtt'  // Schema Registry for MQTT (net-new)
| 'stream.crossProtocolFlow'    // Cross-protocol Workflow flows
```

**Proposed rows:**

| Key                           | Web   | Desktop | Notes                             |
| ----------------------------- | ----- | ------- | --------------------------------- |
| `stream.assertions.web`       | true  | true    | SSE / WS / Socket.IO / gRPC       |
| `stream.assertions.kafka`     | false | true    | No browser TCP for Kafka          |
| `stream.assertions.mqtt`      | false | true    | No browser TCP for MQTT           |
| `stream.schemaRegistry.kafka` | false | true    | Confluent client in Electron main |
| `stream.schemaRegistry.mqtt`  | false | true    | Extends Kafka registry client     |
| `stream.crossProtocolFlow`    | false | true    | Requires Kafka/MQTT               |

`rs.stream.any` / `rs.stream.all` (custom JS predicates in QuickJS) are desktop-only in V1 to avoid WASM bundle size impact on the Cloudflare Worker. `stream.assertions.web` covers only the pure evaluator predicates on web.

---

## 12. Acceptance Criteria & Test Plan

### Unit / Integration (Vitest)

- `shared/protocol/stream-assert/evaluator.ts`: each predicate kind (`count.atLeast`, `count.exactly`, `message.matches`, `message.field`, `message.within`, `stream.closedWith`, `stream.any`, `stream.all`) passes with a synthetic `StreamMessage[]` and fails with the right `AssertionResult.actual` on mismatch.
- `decodeField` extended return type: Avro-encoded buffer returns `{ decoded: object, schemaId: N, encoding: 'avro' }`; non-Confluent buffer returns `{ decoded: string, raw: buf }` with no `schemaId`.
- `json-schema.ts` ajv wrapper: valid schema passes, missing required field fails with descriptive error.
- `KafkaRegistry` Zod schema in `store-validators.ts`: accepts `SecretRef`-shaped auth, rejects old sentinel string shapes.
- Security regression: `assertRegistryUrlSafe('http://169.254.169.254/latest/meta-data')` throws (extend existing tests in `tests/security/`).

### Desktop E2E (`e2e-electron/`)

- **Kafka / Redpanda:** Use the `brokers` fixture (`echo-local/docker-compose.yml` Redpanda). Consume 3 Avro-encoded messages; `rs.stream.assertAtLeast(3)` passes; `rs.stream.assertMessageMatches(0, avroSchema)` passes; `rs.stream.assertMessageWithin(0, 500)` passes. Assertion result panel shows 3 green chips.
- **MQTT / EMQX:** Use the `brokers` fixture (EMQX). Subscribe; publish 2 Protobuf messages; `rs.stream.count()` === 2 in assertion result.
- **WebSocket:** Echo server; `rs.stream.assertAtLeast(1)` passes; `rs.stream.assertClosedWith(1000)` passes on clean disconnect.
- **SSE:** Echo server; `rs.stream.assertMessageWithin(0, 200)` passes; event-name filter assertion using `rs.stream.anyMessage(m => m.event === 'ping')` passes.
- **gRPC:** Echo server-streaming RPC; `rs.stream.assertClosedWith(0)` (OK) passes.
- **Cross-protocol flow:** Load the "Kafka → WS assert" example workflow from echo-local OpenCollection; run it; `StreamAssertNode` shows pass with `messageCount: 1`.

### Type-Check Gate

`npm run type-check:all` must pass after the `decodeField` return-type change. This is non-negotiable: `npm run type-check` (renderer only) will not catch main-process or Worker callsites.

---

## 13. Success Metrics

| Metric                                                                              | Target                           |
| ----------------------------------------------------------------------------------- | -------------------------------- |
| P50 assertion evaluation latency (pure evaluator, 1 000-message buffer)             | < 2 ms (Vitest benchmark)        |
| P50 assertion evaluation latency at 500 msg/s burst                                 | < 5 ms per evaluation run        |
| Time to write a "message 3 matches schema" assertion from scratch                   | < 2 min with Monaco IntelliSense |
| Subject-browse round-trip (registry fetch → schema-ID populated)                    | < 1 s on LAN                     |
| Kafka registry creds stored as SecretRef handle (no plaintext in renderer or Dexie) | 100% of new saves post-migration |
| Cross-protocol "Kafka publish → WS assert" workflow runs end-to-end in CI           | Working e2e-electron spec        |
| `npm run capabilities:check` passing with new capability entries                    | 100%                             |

---

## 14. Rollout Phases

Timelines are estimated for AI-assisted development. Each phase delivers a shippable increment.

### Phase 1 — Pure Evaluator + Web Streaming Assertions (Est. 2.5 h)

**Target protocols:** WebSocket and SSE (full web + desktop coverage, no registry dependency).

**Deliverables:**

- `shared/protocol/stream-assert/` module: `evaluator.ts`, `types.ts`, `json-schema.ts`
- `closeStatus` field on `WebSocketConnection` and `SseConnection`
- `ScriptHostBridges.stream` extension in `scriptExecutor.ts`
- DTS additions to `scriptApiTypes.ts` (`rs.stream.*`)
- Assertions tab in WebSocket and SSE panels (Monaco editor + result panel)
- `stream.assertions.web` capability entry + regenerated matrix

**Exit criteria:** e2e Playwright spec against echo WebSocket: `rs.stream.assertAtLeast(5)` passes on 5-frame sequence, fails on 6; result panel shows correct chips.

### Phase 2 — Kafka + MQTT Assertions + Schema Registry Completion (Est. 3 h)

**Deliverables:**

- `decodeField` return-type change + all callsite updates (type-check:all passes)
- `KafkaMessage` carries `schemaId`, `schemaEncoding`
- `KafkaRegistry.auth` migrated to `SecretRef`, Dexie migration block
- Bearer-token registry auth support
- MQTT `registry` field + handler registry client + `assertRegistryUrlSafe()` guard
- IPC channels: `kafka:registry:subjects`, `kafka:registry:schema-by-subject`, `mqtt:registry:subjects`
- Subject-browse dropdown in Kafka + MQTT config panels
- Decoded-payload schema badge in message lists
- Assertions tab for Kafka and MQTT panels
- All Phase 2 capability entries + regenerated matrix

**Exit criteria:** e2e-electron Redpanda/EMQX spec passes (see section 12).

### Phase 3 — Cross-Protocol Workflow Flows + gRPC Close-Status (Est. 2 h)

**Deliverables:**

- `StreamAssertNode`, `KafkaPublishNode`, `MqttPublishNode` flow node types + executors + Inspector UIs
- gRPC `closeStatus` threaded from `GrpcStreamFinal` to the gRPC store
- Assertions tab for Socket.IO and gRPC streaming panels
- `stream.crossProtocolFlow` capability entry
- "Kafka → WS assert" example workflow in echo-local OpenCollection

**Exit criteria:** e2e-electron cross-protocol workflow spec passes; gRPC `assertClosedWith(0)` spec passes.

---

## 15. Risks & Open Questions

### Risks

| Risk                                                                                         | Likelihood | Impact | Mitigation                                                                                                                                                                                                  |
| -------------------------------------------------------------------------------------------- | ---------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `decodeField` return-type change breaks hidden callsites                                     | High       | High   | Run `type-check:all` (not just renderer `type-check`). `src/features/http/tsconfig.json` has `exactOptionalPropertyTypes: true`; if the new union flows in, latent TS2375 errors surface. Fix before merge. |
| Dexie migration strips existing registry credentials                                         | Medium     | High   | Migration block writes `{ passwordRef: undefined }` placeholders; "Re-enter registry password" UI indicator on first launch post-upgrade.                                                                   |
| `@kafkajs/confluent-schema-registry v4.1.0` Protobuf/JSON-Schema decode unstable in Electron | Medium     | Medium | Avro is confirmed first-class. Protobuf and JSON-Schema need explicit integration test coverage in Phase 2 before shipping. Mark encoding badge "Protobuf (experimental)" if not covered.                   |
| Cross-protocol flow timing depends on network/broker                                         | High       | Medium | Static `DelayNode` in V1; document that `assertMessageWithin()` in workflows is best-effort. CI uses echo-local loopback.                                                                                   |
| `capabilities.ts` drift if new keys are not regenerated                                      | Low        | Medium | Already blocked by CI: `npm run capabilities:check` fails if `CAPABILITY_MATRIX.md` is stale.                                                                                                               |

### Open Questions

| Tag          | Question                                                                                                                                                                                                                                                                  |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [resolved]   | `mqtt-handler.ts` already exposes a `mqtt:publish` IPC channel (`electron/main/handlers/mqtt-handler.ts:277-278`, `MqttPublishSchema`). `MqttPublishNode` can reuse it; no new channel needed.                                                                            |
| [open]       | `WsExchangeNode` (`WsExchangeNode.tsx`) shows "send → match" but the full `WsExchangeFlowNode` data type was not read. Does it already carry a response-match predicate, or is "match" a stub? If a stub, `StreamAssertNode` would supersede it.                          |
| [open]       | `rs.stream.any` / `rs.stream.all` custom predicates: web-only or desktop-only in V1? Recommend desktop-only to avoid WASM bundle size on the Cloudflare Worker bundle; confirm with the platform team.                                                                    |
| [open]       | Subject-browse requires an active connection to the registry. Should subjects be browseable from a standalone registry URL (no broker connection required)? Recommended: yes — registry fetch should require only the registry URL + auth, not an open broker connection. |
| [assumption] | Per-message QuickJS invocation is prohibitive at > 100 msg/s. Benchmark before launch to confirm threshold and document it.                                                                                                                                               |
| [assumption] | `@kafkajs/confluent-schema-registry v4.1.0` Protobuf and JSON-Schema decode paths work correctly in the Electron main process. Needs explicit integration test coverage in Phase 2.                                                                                       |
| [assumption] | IPC round-trip latency (main → renderer) for Kafka/MQTT message timestamps is < 15 ms and acceptable for timing assertions. If not, main-process timestamp stamping must be added.                                                                                        |
| [assumption] | OpenCollection exclusion of assertion specs is acceptable in V1. Users who want to share stream-test collections must wait for Phase 2+ OC schema support.                                                                                                                |

---

_End of PRD 02_

---

## 16. Round-2 Review Addendum (verified findings)

Round-1 corrections (`KAFKA_SECRET_SENTINEL` → `:19`; mqtt:publish resolved) re-verified correct. Deeper findings:

| #    | Tag         | Sev  | Finding                                                                                                                                                                                                            | Fix                                                                                                                                                                                                                                                                                |
| ---- | ----------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R2-1 | CONSISTENCY | High | Assertion API naming drifts across sections: §6 predicate notation (`count.atLeast()`), §7 `rs.stream.assertAtLeast()`, §10 dot-kinds (`'count.atLeast'`); §12 cites `rs.stream.count()` which is defined nowhere. | Pick ONE surface API; add a single mapping table (API method → stored `kind`). Fix the §12 `rs.stream.count()` reference.                                                                                                                                                          |
| R2-2 | FEASIBILITY | High | Changing `decodeField`'s return type (`kafka-serde.ts`) ripples into the renderer: `KafkaClient.tryFormatJson` expects `value: string`.                                                                            | Decide: `KafkaMessage.value` becomes a union, or add a sibling `valueDecoded?: DecodeResult`. List the renderer call sites. Gate with `type-check:all` (the `exactOptionalPropertyTypes:true` trap in `src/features/http/tsconfig.json` won't show in renderer-only `type-check`). |
| R2-3 | ARCH        | Med  | §8.6 references `WsExchangeNode`'s "send → match" — unknown whether `match` is an existing predicate or a UI-only stub. If it carries assertions, `StreamAssertNode` collides with it.                             | Audit `WsExchangeNode.tsx` before locking the vocabulary; state whether `StreamAssertNode` subsumes or coexists.                                                                                                                                                                   |
| R2-4 | PARITY      | Med  | §11 implies only `stream.any/all` are desktop-only (QuickJS), but §6.1 doesn't mark per-predicate platform support.                                                                                                | Add a "Platform" column to the §6.1 table; confirm all non-custom predicates are pure-JS / web-capable.                                                                                                                                                                            |
| R2-5 | CONSISTENCY | Med  | §12 e2e only exercises ~5 of 8 predicates; `count.exactly`, `message.field`, `stream.all` have no listed coverage.                                                                                                 | Add explicit test cases per predicate.                                                                                                                                                                                                                                             |
| R2-6 | ARCH        | Low  | Renderer message timestamps include ~5–15 ms IPC latency, making `message(n).receivedWithin(ms)` flaky; buried in §10.1.                                                                                           | Promote to a §15 risk; document ±tolerance; main-process timestamping in Phase 2.                                                                                                                                                                                                  |
