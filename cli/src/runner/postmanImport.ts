import { readFile, stat } from 'node:fs/promises';
import {
  importPostmanCollection,
  importPostmanV3Files,
  isPostmanV3Paths,
  POSTMAN_V3_LIMITS,
  type PostmanImportIssue,
  type PostmanImportReport,
} from '@shared/collections/postman';
import { unzipPostmanV3Archive } from '@shared/collections/postman/v3-archive';
import type { PostmanV3Limits } from '@shared/collections/postman/v3-container';
import { collectPostmanFolderFiles } from '@shared/collections/postman/v3-folder';
import type { Collection } from '@shared/types';
import { walkPostmanFolder } from './postmanFolder.js';

/**
 * Postman input for the CLI (#1202): v2.0 / v2.1 JSON, and v3 as a folder, a
 * `.zip` or a single JSON / YAML document. Everything goes through the SAME
 * shared parser as the app (`shared/collections/postman/`, ADR 0034); this
 * file only reads bytes from disk under the shared caps.
 */

/** The shared report plus what the CLI's own fs walk refused. */
export interface CliPostmanImportReport extends PostmanImportReport {
  /** Symlinks inside a v3 folder that were skipped (never followed). */
  skippedSymlinks?: string[];
}

export interface PostmanLoadResult {
  collection: Collection;
  report: CliPostmanImportReport;
}

export type PostmanLimits = Partial<PostmanV3Limits>;

/** True for a parsed document that is a Postman v2.x or v3 collection. */
export function isPostmanDocument(data: unknown): boolean {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  const obj = data as Record<string, unknown>;
  if (obj.$kind === 'collection') return true;
  const info = obj.info;
  if (!info || typeof info !== 'object') return false;
  const i = info as Record<string, unknown>;
  return (
    (typeof i.schema === 'string' && i.schema.includes('getpostman.com')) ||
    typeof i._postman_id === 'string'
  );
}

/** Size-check a single input file against `cap` BEFORE reading it. */
export async function readCappedFile(path: string, cap: number, what: string): Promise<Buffer> {
  const info = await stat(path);
  if (info.size > cap) {
    throw new Error(`Invalid Postman collection: ${what} is too large (limit ${cap} bytes)`);
  }
  return readFile(path);
}

/** A parsed single-file document (v2.x JSON, or v3 JSON / YAML). */
export function importPostmanDocument(
  data: unknown,
  limits: PostmanLimits = {}
): PostmanLoadResult {
  const { collection, report } = importPostmanCollection(data, { v3: { limits } });
  return { collection, report };
}

/** A v3 `.zip`: archive size checked before it is read, then the shared reader. */
export async function importPostmanZip(
  path: string,
  limits: PostmanLimits = {}
): Promise<PostmanLoadResult> {
  const cap = limits.maxArchiveBytes ?? POSTMAN_V3_LIMITS.maxArchiveBytes;
  const info = await stat(path);
  if (info.size > cap) {
    throw new Error('Invalid Postman v3 collection: archive is too large');
  }
  const bytes = await readFile(path);
  const files = unzipPostmanV3Archive(new Uint8Array(bytes), limits);
  const { collection, report } = importPostmanV3Files(files, { v3: { limits } });
  return { collection, report };
}

/**
 * A v3 folder, or `null` when the directory does not look like one (no
 * `*.request.yaml`, no `.resources/definition.yaml`).
 */
export async function importPostmanFolder(
  dir: string,
  limits: PostmanLimits = {}
): Promise<PostmanLoadResult | null> {
  const walk = await walkPostmanFolder(dir, limits);
  if (!isPostmanV3Paths(walk.entries.map((e) => e.path))) return null;
  const files = await collectPostmanFolderFiles(walk.entries, limits);
  const { collection, report } = importPostmanV3Files(files, {
    v3: { limits, pickedRoot: true },
  });
  return {
    collection,
    report:
      walk.skippedSymlinks.length > 0
        ? { ...report, skippedSymlinks: walk.skippedSymlinks }
        : report,
  };
}

/** Number of entries `--strict-import` counts. */
export function importReportSize(report: CliPostmanImportReport): number {
  return report.warnings.length + (report.skippedSymlinks?.length ?? 0);
}

const MAX_NAMES = 5;

function groupLabel(w: PostmanImportIssue): string {
  switch (w.kind) {
    case 'unsupported-auth':
      return `unsupported auth "${w.authType}"`;
    case 'unsupported-method':
      return `unsupported method "${w.method}"`;
    case 'unmodelled-construct':
      return `not modelled: ${w.construct}`;
    case 'security-downgrade':
      return `security downgrade "${w.setting}"`;
    case 'schema-version':
      return `schema version ${w.version}`;
  }
}

function entryName(w: PostmanImportIssue): string | undefined {
  return 'requestName' in w ? w.requestName : undefined;
}

function entryDetail(w: PostmanImportIssue): string | undefined {
  if (w.kind === 'unmodelled-construct' || w.kind === 'security-downgrade') return w.detail;
  if (w.kind === 'schema-version') return w.note;
  return undefined;
}

/**
 * Human-readable import report: entries grouped by kind and counted, with the
 * affected item names. Report entries carry only names and fixed notes
 * (never sidecar contents), so this is safe to print.
 */
export function formatImportReport(report: CliPostmanImportReport): string {
  const size = importReportSize(report);
  const lines = [
    `[restura] Postman v${report.sourceVersion} import report: ${size} ${size === 1 ? 'entry' : 'entries'}`,
  ];
  const groups = new Map<string, { names: string[]; count: number; detail?: string }>();
  for (const w of report.warnings) {
    const key = groupLabel(w);
    const g = groups.get(key) ?? { names: [], count: 0 };
    g.count++;
    const name = entryName(w);
    if (name !== undefined && !g.names.includes(name)) g.names.push(name);
    g.detail ??= entryDetail(w);
    groups.set(key, g);
  }
  for (const [label, g] of groups) {
    const shown = g.names.slice(0, MAX_NAMES).join(', ');
    const more = g.names.length > MAX_NAMES ? ` (+${g.names.length - MAX_NAMES} more)` : '';
    lines.push(`  - ${label} (${g.count})${shown ? `: ${shown}${more}` : ''}`);
    if (g.detail) lines.push(`      ${g.detail}`);
  }
  if (report.skippedSymlinks && report.skippedSymlinks.length > 0) {
    const shown = report.skippedSymlinks.slice(0, MAX_NAMES).join(', ');
    lines.push(`  - symlink skipped, not followed (${report.skippedSymlinks.length}): ${shown}`);
  }
  return `${lines.join('\n')}\n`;
}
