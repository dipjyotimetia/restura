// Capability rows: Collections, workflows, the local mock server and browser capture.
// Order is significant: it is the row order of docs/CAPABILITY_MATRIX.md.
import type { CapabilityRow } from './types';

export const WORKSPACE_CAPABILITIES = {
  'collections.file': { label: 'Filesystem-backed collections', web: false, desktop: true },
  'collections.git': {
    label: 'Git operations on collections',
    web: false,
    desktop: true,
    notes:
      'System-Git status, diff, staging, commits, branches, fetch/pull/push, and explicit resumable merges for registered OpenCollection directories; structured YAML conflict resolution validates before staging',
  },
  'collections.brokerPresets': {
    label: 'Kafka / MQTT connection presets in collections',
    web: false,
    desktop: true,
    notes:
      'Save a Kafka or MQTT tab to a collection and reopen it prefilled; {{var}} resolved at send time. Presets round-trip through OpenCollection (x-restura-kafka / x-restura-mqtt) and git-native collections; credentials stay in the desktop secure store and are never exported. Web lists imported presets but opens the desktop-only panel; the CLI skips them. Postman v3 imports and exports carry Kafka / MQTT items (broker-only options such as SASL, TLS paths and schema registry are reported as not exported); the CLI still skips them without counting it as import loss',
  },
  'collections.streamPresets': {
    label: 'WebSocket / Socket.IO connections in collections',
    web: true,
    desktop: true,
    notes:
      'Save a WebSocket or Socket.IO tab to a collection and reopen it prefilled (URL, subprotocols / namespace / path, handshake headers, query and auth rows, reconnect options, subscribed events, composer draft and saved messages); {{var}} resolved at send time. OpenCollection: WebSocket is a native websocket item (Restura-only fields in x-restura-websocket), Socket.IO rides in x-restura-socketio; git-native collections round-trip. Postman v3 websocket-request / socket.io-request import as these items (older placeholder folders are upgraded) and export back. Not runnable: the collection runner and the CLI skip them with a notice; Postman v2.1 drops them (reported) and Insomnia / Bruno get named stubs. Export redaction blanks credential-named header / query rows, every literal Socket.IO handshake auth value and URL userinfo; these rows are stored as typed (not keychain handles), like the live connection',
  },
  'collections.postmanImport': {
    label: 'Postman v2.x / v3 import',
    web: true,
    desktop: true,
    notes:
      'Postman v2.0 / v2.1 JSON and v3 (a folder, a .zip, or a single JSON/YAML file) are auto-detected and parsed by one shared importer. Every dropped or approximated construct appears in an import report, and unmodelled data is kept in a store-scoped _postman sidecar (not in file-backed collections on disk; ADR 0034). Unsupported auth (hawk, jwt, edgegrid, asap, azure, sasl, akamai) imports as none with a warning (the raw auth is kept in the sidecar); WebSocket / Socket.IO items import as native collection items (collections.streamPresets); LLM / data items become placeholder folders; vault secret variables and v2.1 type: "secret" variables import value-less with a warning; archives are capped at 50 MB and path traversal is refused. An explicit Postman noauth is marked (_postman.noauth) and cuts inheritance, with an explicit-noauth import-report entry. Requests that would otherwise pick up an ancestor credential (an explicit noauth below a configured auth, or anything below a hawk / jwt / … folder or collection) are refused at send on web, desktop and the CLI: single sends of every protocol, the collection runner (skipped), workflows and AI Lab tools; before, only the CLI refused them. The CLI (restura run) accepts the same inputs, prints the report on stderr and in the json reporter, and --strict-import exits 2 on any report entry, including explicit-noauth',
  },
  'collections.postmanV3Export': {
    label: 'Postman export (v3 default, v2.1 single file)',
    web: true,
    desktop: true,
    notes:
      'Collection menu > Export: Postman v3 (folder / zip) is the default and listed first; Postman v2.1 (single file · Newman) is the Newman-compatible single-file option. v3: web and self-host download <name>.postman-v3.zip; desktop writes <picked>/<name>/, asks before replacing a non-empty folder and removes only Postman layout files. v2.1: one <name>.postman_collection.json download on every platform, valid against the v2.1.0 schema; all v2.1 auth types round-trip (basic, bearer, API key, digest, OAuth 1.0, OAuth 2.0, AWS SigV4, NTLM, no auth, inherit), and data kept from a v2.1 import (saved responses, protocolProfileBehavior, extra events, hawk / edgegrid auth, item and path variables, file paths) is restored. Both formats show an export report of what they cannot hold (v2.1: gRPC, SSE, MCP, WebSocket, Socket.IO, Kafka and MQTT items, WSSE and jwt / asap auth; both: secret variable values, keychain-stored secrets, Restura-only settings, and more). An explicit Postman noauth (kept from import) is exported as an explicit noauth block, never as inherit. Auth secrets follow the existing include-secrets prompt; with secrets excluded, credential-named form-body rows (urlencoded / form-data) and nested OAuth2 parameter rows are blanked too, in every exporter (Postman, Insomnia, OpenCollection, Bruno); keychain handles and secret variables are always exported empty. The CLI has no export command (#1204)',
  },
  'workflows.ows': {
    label: 'Workflows',
    web: true,
    desktop: true,
    notes:
      'Safe sequential, guarded, loop, and recovery controls execute with typed data/output, timeout/cancellation, and binding-only HTTP or GraphQL saved-request calls. GraphQL mutations require explicit approval. Other controls, event/process tasks, inline transport configuration, and unsupported transports are rejected before persistence or execution.',
  },
  'mock.localServer': {
    label: 'Local mock server',
    web: false,
    desktop: true,
    notes: 'Binds a localhost HTTP listener; no browser TCP',
  },
  'capture.desktopBridge': {
    label: 'Browser capture desktop bridge',
    web: false,
    desktop: true,
    notes: 'Loopback receiver for the Restura capture extension; no browser TCP listener',
  },
} as const satisfies Record<string, CapabilityRow>;
