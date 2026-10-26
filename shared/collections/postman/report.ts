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

export type PostmanSourceVersion = '2.0' | '2.1';

/** Postman constructs Restura has no typed model for (kept in the sidecar). */
export type PostmanUnmodelledConstruct =
  | 'saved-responses'
  | 'protocol-profile-behavior'
  | 'item-variables'
  | 'extra-events'
  | 'file-body'
  | 'oauth2-grant'
  | 'oauth1-options'
  | 'path-variables';

export type PostmanImportIssue =
  | { kind: 'unsupported-auth'; authType: string; requestName: string }
  | { kind: 'unsupported-method'; method: string; requestName: string }
  | {
      kind: 'unmodelled-construct';
      construct: PostmanUnmodelledConstruct;
      requestName: string;
      detail: string;
    }
  | { kind: 'schema-version'; format: string; version: string; note: string };

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
  'path-variables':
    'URL path variables only partly applied (empty value, unused or described entries); originals kept for reference',
};

export class PostmanReportBuilder {
  readonly warnings: PostmanImportIssue[] = [];

  unsupportedAuth(authType: string, requestName: string): void {
    this.warnings.push({ kind: 'unsupported-auth', authType, requestName });
  }

  unsupportedMethod(method: string, requestName: string): void {
    this.warnings.push({ kind: 'unsupported-method', method, requestName });
  }

  unmodelled(construct: PostmanUnmodelledConstruct, requestName: string): void {
    this.warnings.push({
      kind: 'unmodelled-construct',
      construct,
      requestName,
      detail: CONSTRUCT_DETAIL[construct],
    });
  }

  schemaVersion(version: string, note: string): void {
    this.warnings.push({ kind: 'schema-version', format: 'Postman', version, note });
  }
}
