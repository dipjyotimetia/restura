/**
 * Structured import report for Postman collections.
 *
 * Every construct the parser drops or approximates produces exactly one entry
 * here (and its raw Postman JSON is kept in the `_postman` sidecar, see
 * `./sidecar.ts`). Entry shapes are a structural subset of the renderer's
 * `ImportWarning` union (`src/features/collections/lib/importers/types.ts`),
 * so the renderer adapter forwards them verbatim and the CLI can print them
 * without depending on `src/`.
 *
 * Entries never carry sidecar contents: only names, kinds and fixed notes, so
 * a report is safe to log.
 */

export type PostmanSourceVersion = '2.0' | '2.1' | '3.0';

/** Postman constructs Restura has no typed model for (kept in the sidecar). */
export type PostmanUnmodelledConstruct =
  | 'saved-responses'
  | 'protocol-profile-behavior'
  | 'item-variables'
  | 'extra-events'
  | 'file-body'
  | 'oauth2-grant'
  | 'oauth1-options'
  | 'form-file'
  | 'explicit-noauth'
  // v3 (#1200)
  | 'multi-auth'
  | 'secret-variable'
  | 'protocol-scripts'
  | 'script-packages'
  | 'request-settings'
  | 'path-variables'
  | 'schema-reference'
  | 'unsupported-item-kind'
  | 'mcp-stdio'
  | 'collection-uses'
  | 'broker-leftovers'
  | 'connection-leftovers'
  | 'collection-script-scope'
  | 'unread-file';

export type PostmanImportIssue =
  | { kind: 'unsupported-auth'; authType: string; requestName: string }
  | { kind: 'unsupported-method'; method: string; requestName: string }
  | {
      kind: 'unmodelled-construct';
      construct: PostmanUnmodelledConstruct;
      requestName: string;
      detail: string;
    }
  | { kind: 'schema-version'; format: string; version: string; note: string }
  /** An imported setting that weakens transport security (TLS checks, auth on redirects). */
  | { kind: 'security-downgrade'; setting: string; requestName: string; detail: string };

export interface PostmanImportReport {
  sourceVersion: PostmanSourceVersion;
  warnings: PostmanImportIssue[];
}

const CONSTRUCT_DETAIL: Record<PostmanUnmodelledConstruct, string> = {
  'saved-responses': 'Saved responses (examples) are not modelled; kept for reference only',
  'protocol-profile-behavior':
    'protocolProfileBehavior settings are not applied; kept for reference only',
  'item-variables': 'Item-level variables are not modelled; kept for reference only',
  'extra-events':
    'Multiple scripts of the same kind; only the last one was imported, the others were kept for reference',
  'file-body': 'Binary file body imported without its file; the original path was kept',
  'oauth2-grant': 'OAuth 2.0 grant type approximated (implicit / PKCE details not modelled)',
  'oauth1-options': 'OAuth 1.0 options approximated (unsupported signature method or placement)',
  'form-file': 'Form-data file fields imported without their files; the original paths were kept',
  'explicit-noauth':
    'Explicit "No Auth" below a configured auth: Restura treats no auth as inherit, so the affected requests are NOT sent (no ancestor credential is substituted) until their auth is configured',
  'multi-auth':
    'Several credential sets selected by rule; only the first was imported, all were kept for reference',
  'secret-variable':
    'Secret variable imported without a value (Postman vaults are never contacted); re-enter it',
  'protocol-scripts':
    'Protocol-specific collection scripts have no Restura phase; kept for reference only',
  'script-packages':
    'Script uses Postman packages or cross-request references; it will likely fail in Restura',
  'request-settings': 'Some request settings have no Restura equivalent; kept for reference only',
  'path-variables':
    'URL path variables only partly applied (empty value, unused or described entries); originals kept for reference',
  'schema-reference': 'Linked schema is not modelled; kept for reference only',
  'unsupported-item-kind':
    'This Postman item kind is not yet supported as a Restura collection item; imported as an empty placeholder, original kept for reference',
  'mcp-stdio':
    'MCP stdio server — imported DISABLED as a placeholder (an imported file never launches a process). Only the launch shape is kept: the executable, option names and env names. Argument values and env values are NOT imported — re-enter them. Stdio is desktop-only: recreate it there, where Restura asks for consent before every launch',
  'collection-uses': 'Linked environments are not imported; kept for reference only',
  'broker-leftovers':
    'Some broker options (extra topics / messages, stop conditions, settings) have no Restura equivalent; kept for reference only',
  'connection-leftovers':
    'Some WebSocket / Socket.IO options (handshake timeout, max payload, TLS verification, client version, examples, event notes, message encodings) have no Restura equivalent; kept for reference only',
  'collection-script-scope':
    'Collection HTTP scripts run for EVERY request in Restura, including gRPC / MCP / broker requests',
  'unread-file':
    'A non-YAML file in a .resources folder (e.g. an external script) was not read; check the imported scripts',
};

export class PostmanReportBuilder {
  readonly warnings: PostmanImportIssue[] = [];

  unsupportedAuth(authType: string, requestName: string): void {
    this.warnings.push({ kind: 'unsupported-auth', authType, requestName });
  }

  unsupportedMethod(method: string, requestName: string): void {
    this.warnings.push({ kind: 'unsupported-method', method, requestName });
  }

  /**
   * `extra` is appended to the fixed note. Only pass values the user must see
   * at import (e.g. the command an MCP stdio item would launch) — never
   * credentials or sidecar contents.
   */
  unmodelled(construct: PostmanUnmodelledConstruct, requestName: string, extra?: string): void {
    this.warnings.push({
      kind: 'unmodelled-construct',
      construct,
      requestName,
      detail: extra ? `${CONSTRUCT_DETAIL[construct]}: ${extra}` : CONSTRUCT_DETAIL[construct],
    });
  }

  securityDowngrade(setting: string, requestName: string, detail: string): void {
    this.warnings.push({ kind: 'security-downgrade', setting, requestName, detail });
  }

  schemaVersion(version: string, note: string): void {
    this.warnings.push({ kind: 'schema-version', format: 'Postman', version, note });
  }
}
