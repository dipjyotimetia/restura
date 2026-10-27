import { migrateScriptPmToRs } from '../../scripts/script-migrations';
import type { Collection } from '../../types';
import { isObj } from './common';
import { parsePostmanV2 } from './parse-v2';
import { parsePostmanV3 } from './parse-v3';
import {
  type PostmanImportReport,
  PostmanReportBuilder,
  type PostmanSourceVersion,
} from './report';
import {
  isPostmanV3FileMap,
  type PostmanV3FileMap,
  type ReadV3Options,
  readPostmanV3Container,
} from './v3-container';

/**
 * Runtime-neutral Postman collection import (ADR 0034). Used by the renderer
 * importer and (later) the CLI; no DOM, no `src/` imports, no Postman SDK.
 *
 * Every supported format version is parsed into the same Restura `Collection`
 * through version-specific front ends (`parse-v2.ts`, `parse-v3.ts` behind the
 * `v3-container.ts` folder / file reader) that share the auth mapping (`auth.ts`), the report (`report.ts`) and the
 * `_postman` sidecar (`sidecar.ts`).
 */

export type { PostmanAuthParams } from './auth';
export { authParamsV2, convertPostmanAuth } from './auth';
export type {
  PostmanExportConstruct,
  PostmanExportIssue,
  PostmanExportReport,
  PostmanV3Export,
  PostmanV3ExportOptions,
} from './export-v3';
export { exportPostmanV3, exportPostmanV3Tree, postmanV3SafeFileName } from './export-v3';
export type {
  PostmanImportIssue,
  PostmanImportReport,
  PostmanSourceVersion,
  PostmanUnmodelledConstruct,
} from './report';
export type { PostmanSidecar, WithPostmanSidecar } from './sidecar';
export { attachPostmanSidecar, getPostmanSidecar, POSTMAN_SIDECAR_KEY } from './sidecar';
export type { PostmanV3FileMap, PostmanV3Limits } from './v3-container';
export {
  isPostmanV3FileMap,
  isPostmanV3Paths,
  POSTMAN_V3_LIMITS,
  PostmanV3ContainerError,
  readPostmanV3Container,
} from './v3-container';

export interface PostmanImportOptions {
  /**
   * Applied to every imported pre-request / test script. Defaults to the
   * `pm.*` → `rs.*` namespace migration (`shared/scripts/script-migrations.ts`).
   */
  transformScript?: (script: string) => string;
  /** Caps for v3 folder / file input (defaults: `POSTMAN_V3_LIMITS`). */
  v3?: ReadV3Options;
}

export interface PostmanImportResult {
  collection: Collection;
  report: PostmanImportReport;
  /** Same as `report.sourceVersion`. */
  detectedVersion: PostmanSourceVersion;
}

const SCHEMA_VERSION_RE = /\/collection\/v(\d+\.\d+)(?:\.\d+)?\//;

/**
 * `'3.0'` for a v3 logical tree (`$kind: "collection"` root) or a v3 folder
 * file map (`*.request.yaml` / `.resources/definition.yaml`); otherwise the
 * v2 schema version (`info.schema`), defaulting to `'2.1'`.
 */
export function detectPostmanVersion(data: unknown): PostmanSourceVersion {
  if (isObj(data) && data.$kind === 'collection') return '3.0';
  if (isPostmanV3FileMap(data)) return '3.0';
  const info = isObj(data) && isObj(data.info) ? data.info : undefined;
  const version =
    typeof info?.schema === 'string' ? SCHEMA_VERSION_RE.exec(info.schema)?.[1] : undefined;
  return version === '2.0' ? '2.0' : '2.1';
}

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
  const transformScript = options.transformScript ?? migrateScriptPmToRs;
  if (detectPostmanVersion(raw) === '3.0') return importV3(raw, options);
  const info = raw.info as { schema?: unknown } | undefined;
  const sourceVersion = detectV2Version(info?.schema, report);
  const collection = parsePostmanV2(raw, { report, transformScript });
  return {
    collection,
    report: { sourceVersion, warnings: report.warnings },
    detectedVersion: sourceVersion,
  };
}

/** Import a v3 folder / unzipped archive given as `{ relativePath: contents }`. */
export function importPostmanV3Files(
  files: PostmanV3FileMap,
  options: PostmanImportOptions = {}
): PostmanImportResult {
  return importV3(files, options);
}

/** The one v3 path: container reader → v3 front end → shared report. */
function importV3(input: unknown, options: PostmanImportOptions): PostmanImportResult {
  const { tree, unread } = readPostmanV3Container(input, options.v3);
  const report = new PostmanReportBuilder();
  for (const path of unread) report.unmodelled('unread-file', path);
  const collection = parsePostmanV3(tree, {
    report,
    transformScript: options.transformScript ?? migrateScriptPmToRs,
  });
  return {
    collection,
    report: { sourceVersion: '3.0', warnings: report.warnings },
    detectedVersion: '3.0',
  };
}
