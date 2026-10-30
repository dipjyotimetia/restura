/**
 * Structured export report for Postman v3 (#1201) and v2.1 (#1229) export —
 * the export-side counterpart of `./report.ts`.
 *
 * Every Restura construct that the target file cannot hold (SSE requests, WSSE auth,
 * Restura-only settings, secret values, …) is dropped from the files or
 * approximated, and produces exactly one entry here. Entries carry only item
 * names, construct ids and fixed notes — never values — so a report is safe
 * to log and to show.
 */

export type PostmanExportConstruct =
  | 'sse-request'
  | 'wsse-auth'
  | 'auth-unsupported-for-kind'
  | 'auth-fields'
  | 'secret-variable'
  | 'secret-handle'
  | 'folder-variables'
  | 'restura-settings'
  | 'contract-spec'
  | 'body-unsupported'
  | 'form-file'
  | 'binary-body'
  | 'graphql-extras'
  | 'grpc-extras'
  | 'mcp-transport'
  | 'mcp-scripts'
  | 'mcp-stdio-extras'
  | 'mcp-params'
  | 'mqtt-extras'
  | 'kafka-extras'
  | 'kafka-mode'
  | 'websocket-extras'
  | 'socketio-extras'
  | 'description'
  | 'examples'
  | 'multi-auth'
  // v2.1 only (#1229)
  | 'non-http-request'
  | 'placeholder-item'
  | 'restored-events'
  | 'restored-file-path';

export interface PostmanExportIssue {
  /** `dropped`: not in the files at all; `emptied`: written without its value; `approximated`: written differently. */
  kind: 'dropped' | 'emptied' | 'approximated';
  construct: PostmanExportConstruct;
  /** Name of the collection / folder / request the entry is about. */
  itemName: string;
  detail: string;
}

export type PostmanExportTargetVersion = '2.1' | '3.0';

export interface PostmanExportReport {
  targetVersion: PostmanExportTargetVersion;
  entries: PostmanExportIssue[];
}

const DETAIL: Record<PostmanExportConstruct, string> = {
  'sse-request': 'Server-Sent Events requests have no Postman v3 kind; not exported',
  'wsse-auth': 'WSSE auth has no Postman equivalent; exported as no auth',
  'auth-unsupported-for-kind':
    'Postman does not allow this auth type for this request kind; exported as no auth',
  'auth-fields': 'Some auth fields have no Postman equivalent and were not exported',
  'secret-variable':
    'Secret variable exported as a plain variable with an EMPTY value (Postman vault references cannot be produced); re-enter it in Postman',
  'secret-handle': 'Keychain-stored secret exported with an EMPTY value; re-enter it in Postman',
  'folder-variables': 'Postman v3 folders have no variables; folder variables were not exported',
  'restura-settings': 'Restura-only request settings were not exported',
  'contract-spec': 'Attached contract spec is Restura-only; not exported',
  'body-unsupported': 'This body type has no Postman equivalent; exported without a body',
  'form-file': 'Form-data file fields exported without a file path; re-pick the files in Postman',
  'binary-body': 'Binary file body exported without its file; re-pick it in Postman',
  'graphql-extras': 'GraphQL schema / subscription settings are Restura-only; not exported',
  'grpc-extras':
    'gRPC schema snapshot, deadline, wire protocol and streaming kind are Restura-only; not exported',
  'mcp-transport':
    'Postman v3 only models the SSE remote MCP transport; Streamable HTTP was exported as SSE',
  'mcp-scripts': 'Postman v3 MCP requests have no scripts; not exported',
  'mcp-stdio-extras':
    'Working directory or arguments that cannot be quoted in one command line were not exported',
  'mcp-params': 'Default MCP params are not valid JSON; exported without params',
  'mqtt-extras':
    'Some MQTT preset options (username, TLS, session expiry, message properties) are Restura-only; not exported',
  'kafka-extras':
    'Some Kafka preset options (client id, SASL, schema registry, TLS paths, idempotence, transactions, group id) are Restura-only; not exported',
  'kafka-mode':
    'Postman Kafka requests are either producer or consumer; the consumer settings were not exported',
  'websocket-extras':
    'Some WebSocket options (subprotocols, heartbeat, permessage-deflate, frame assertion, an unsaved composer draft) are Restura-only; not exported',
  'socketio-extras':
    'Some Socket.IO options (namespace, handshake auth payload, transports, forceNew) are Restura-only; not exported',
  description: 'Postman v3 has no description for this kind; not exported',
  examples: 'Saved examples for this request kind cannot be restored; not exported',
  'multi-auth': 'Only the first credential set of a multi-set Postman auth is exported',
  'non-http-request':
    'Postman v2.1 has no item kind for this request type (only HTTP and GraphQL); not exported',
  'restored-events':
    'Extra scripts kept from the Postman import were restored; Restura never showed or ran them, but Postman / Newman will',
  'restored-file-path':
    'Local file paths kept from the Postman import were restored; Postman / Newman will upload the files at those paths',
  'placeholder-item':
    'This imported Postman item kind has no Postman v2.1 equivalent; not exported',
};

export class PostmanExportReportBuilder {
  readonly entries: PostmanExportIssue[] = [];

  add(
    kind: PostmanExportIssue['kind'],
    construct: PostmanExportConstruct,
    itemName: string,
    extra?: string
  ): void {
    this.entries.push({
      kind,
      construct,
      itemName,
      detail: extra ? `${DETAIL[construct]}: ${extra}` : DETAIL[construct],
    });
  }

  dropped(construct: PostmanExportConstruct, itemName: string, extra?: string): void {
    this.add('dropped', construct, itemName, extra);
  }

  emptied(construct: PostmanExportConstruct, itemName: string, extra?: string): void {
    this.add('emptied', construct, itemName, extra);
  }

  approximated(construct: PostmanExportConstruct, itemName: string, extra?: string): void {
    this.add('approximated', construct, itemName, extra);
  }

  build(targetVersion: PostmanExportTargetVersion = '3.0'): PostmanExportReport {
    return { targetVersion, entries: this.entries };
  }
}
