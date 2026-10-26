import type { Collection } from '../../types';
import { parsePostmanV2 } from './parse-v2';
import {
  type PostmanImportReport,
  PostmanReportBuilder,
  type PostmanSourceVersion,
} from './report';

/**
 * Runtime-neutral Postman collection import (ADR 0034). Used by the renderer
 * importer and (later) the CLI; no DOM, no `src/` imports, no Postman SDK.
 *
 * Every supported format version is parsed into the same Restura `Collection`
 * through version-specific front ends (`parse-v2.ts` today; v3 plugs in beside
 * it) that share the auth mapping (`auth.ts`), the report (`report.ts`) and the
 * `_postman` sidecar (`sidecar.ts`).
 */

export type { PostmanAuthParams } from './auth';
export { authParamsV2, convertPostmanAuth } from './auth';
export type {
  PostmanImportIssue,
  PostmanImportReport,
  PostmanSourceVersion,
  PostmanUnmodelledConstruct,
} from './report';
export type { PostmanSidecar, WithPostmanSidecar } from './sidecar';
export { attachPostmanSidecar, getPostmanSidecar, POSTMAN_SIDECAR_KEY } from './sidecar';

export interface PostmanImportOptions {
  /**
   * Applied to every imported pre-request / test script. The renderer passes
   * the `pm.*` → `rs.*` namespace migration; defaults to identity.
   */
  transformScript?: (script: string) => string;
}

export interface PostmanImportResult {
  collection: Collection;
  report: PostmanImportReport;
}

const SCHEMA_VERSION_RE = /\/collection\/v(\d+\.\d+)(?:\.\d+)?\//;

function detectV2Version(schema: unknown, report: PostmanReportBuilder): PostmanSourceVersion {
  if (typeof schema !== 'string' || schema === '') return '2.1';
  const version = SCHEMA_VERSION_RE.exec(schema)?.[1];
  if (version === '2.0' || version === '2.1') return version;
  report.schemaVersion(version ?? 'unknown', 'Unrecognised schema; parsed as v2.1');
  return '2.1';
}

export function importPostmanCollection(
  data: unknown,
  options: PostmanImportOptions = {}
): PostmanImportResult {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('Invalid Postman collection: expected a JSON object');
  }
  const raw = data as Record<string, unknown>;
  const report = new PostmanReportBuilder();
  const info = raw.info as { schema?: unknown } | undefined;
  const sourceVersion = detectV2Version(info?.schema, report);
  const collection = parsePostmanV2(raw, {
    report,
    transformScript: options.transformScript ?? ((s) => s),
  });
  return { collection, report: { sourceVersion, warnings: report.warnings } };
}
