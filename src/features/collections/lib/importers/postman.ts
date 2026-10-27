import {
  importPostmanCollection as importPostmanShared,
  importPostmanV3Files as importPostmanV3FilesShared,
  type PostmanImportResult,
  type PostmanSourceVersion,
  type PostmanV3FileMap,
  type PostmanV21Collection,
} from '@shared/collections/postman';
import type { Collection } from '@/types';
import type { ImportResult, ImportWarning } from './types';

/**
 * Renderer adapter over the runtime-neutral Postman parser in
 * `shared/collections/postman/` (ADR 0034). Kept async and with its original
 * signature so existing callers (ImportDialog, tests) are unchanged.
 *
 * Accepts Postman v2.0 / v2.1 JSON and a v3 logical tree (`$kind:
 * "collection"`, single JSON / YAML file). v3 folders / zips go through
 * {@link importPostmanV3Files}. Report entries are forwarded into `warnings`;
 * constructs Restura cannot model are kept in the `_postman` sidecar. The
 * shared parser migrates Postman's `pm.*` namespace to `rs.*` by default.
 */
export async function importPostmanCollection(
  postmanData: PostmanV21Collection | unknown,
  warnings?: ImportWarning[]
): Promise<Collection> {
  const result = importPostmanWithReport(postmanData);
  if (warnings) warnings.push(...result.warnings);
  return result.collection;
}

/** "Postman v2.1" / "Postman v3" — shown in the import preview. */
export function postmanVersionLabel(version: PostmanSourceVersion): string {
  return version === '3.0' ? 'Postman v3' : `Postman v${version}`;
}

function toImportResult(result: PostmanImportResult): ImportResult & {
  detectedVersion: PostmanSourceVersion;
} {
  const warnings: ImportWarning[] = result.report.warnings;
  return {
    collection: result.collection,
    warnings: [...warnings],
    detectedVersion: result.detectedVersion,
    sourceLabel: postmanVersionLabel(result.detectedVersion),
  };
}

/** Import a v2.x / v3 single document, returning warnings + the detected version. */
export function importPostmanWithReport(data: unknown) {
  return toImportResult(importPostmanShared(data));
}

/** Import a v3 folder or unzipped archive given as `{ relativePath: contents }`. */
export function importPostmanV3Files(
  files: PostmanV3FileMap,
  options: { pickedRoot?: boolean } = {}
) {
  return toImportResult(importPostmanV3FilesShared(files, { v3: options }));
}
