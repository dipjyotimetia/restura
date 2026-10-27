import {
  isPostmanV3Paths,
  POSTMAN_V3_LIMITS,
  PostmanV3ContainerError,
  type PostmanV3FileMap,
} from '@shared/collections/postman';
import { collectPostmanFolderFiles } from '@shared/collections/postman/v3-folder';
import * as yaml from 'js-yaml';
import type { ImportWarning } from '@/features/collections/lib/importers/types';
import { getElectronAPI, workerAuthHeaders, workerBaseUrl } from '@/lib/shared/platform';

export type ImportType =
  | 'postman'
  | 'insomnia'
  | 'openapi'
  | 'opencollection'
  | 'hoppscotch'
  | 'bruno'
  | 'http'
  | 'har'
  | 'curl'
  | 'url';

export type ParsedImportType = Exclude<ImportType, 'url' | 'har'>;

export interface FormatMeta {
  id: ImportType;
  name: string;
  tagline: string;
  initials: string;
  color: string;
  accept: string;
}

export const FORMATS: FormatMeta[] = [
  {
    id: 'postman',
    name: 'Postman',
    tagline: 'v2.1 & v3 collections, environments',
    initials: 'PM',
    color: '#ff6c37',
    accept: '.json,.yaml,.yml,.zip',
  },
  {
    id: 'insomnia',
    name: 'Insomnia',
    tagline: 'v4 & v5 workspaces',
    initials: 'IN',
    color: '#7e5cef',
    accept: '.json,.yaml,.yml',
  },
  {
    id: 'openapi',
    name: 'OpenAPI',
    tagline: 'OpenAPI 3.x · Swagger 2.0',
    initials: 'OA',
    color: '#6ba539',
    accept: '.json,.yaml,.yml',
  },
  {
    id: 'opencollection',
    name: 'OpenCollection',
    tagline: 'Bruno 3.1+ bundled format',
    initials: 'OC',
    color: '#2e91ff',
    accept: '.json,.yaml,.yml',
  },
  {
    id: 'hoppscotch',
    name: 'Hoppscotch',
    tagline: 'Collections & environments',
    initials: 'HP',
    color: '#22c55e',
    accept: '.json,.yaml,.yml',
  },
  {
    id: 'bruno',
    name: 'Bruno',
    tagline: 'Legacy .bru text DSL',
    initials: 'BR',
    color: '#f06b00',
    accept: '.bru,.zip',
  },
  {
    id: 'http',
    name: '.http File',
    tagline: 'VS Code REST Client · JetBrains HTTP Client',
    initials: 'HT',
    color: '#0ea5e9',
    accept: '.http,.rest',
  },
  {
    id: 'har',
    name: 'HAR',
    tagline: 'HTTP Archive 1.2 browser captures',
    initials: 'HR',
    color: '#f59e0b',
    accept: '.har,.json',
  },
  {
    id: 'curl',
    name: 'cURL',
    tagline: 'One POSIX-shell command',
    initials: 'cU',
    color: '#0f766e',
    accept: '.sh,.txt',
  },
  {
    id: 'url',
    name: 'Remote URL',
    tagline: 'Public HTTPS text artifact',
    initials: 'URL',
    color: '#7c3aed',
    accept: '',
  },
];

export const FEATURE_LISTS: Record<ImportType, string[]> = {
  postman: [
    'v2.1 JSON, or v3 as a folder, .zip or single JSON/YAML file',
    'Collections and folders',
    'HTTP requests (all methods)',
    'Query parameters and headers',
    'Request body (JSON, form-data, etc.)',
    'Auth (Basic, Bearer, API Key, OAuth2, AWS Sig)',
    'Pre-request and test scripts',
    'Environment variables',
    'v3: GraphQL, gRPC, MQTT, Kafka and MCP requests',
  ],
  insomnia: [
    'Workspaces and request groups',
    'HTTP requests',
    'Headers and parameters',
    'Request body',
    'Auth (Basic, Bearer, API Key, OAuth2)',
  ],
  openapi: [
    'OpenAPI 3.x and Swagger 2.0',
    'Paths and operations (all methods)',
    'Query, header, and path parameters',
    'Request bodies with example generation',
    'Tag-based folder organisation',
    'Security schemes',
    'Server URL configuration',
  ],
  opencollection: [
    'OpenCollection v1.0.0 (Bruno 3.1+)',
    'HTTP, gRPC, GraphQL, WebSocket',
    'SSE and MCP via x-restura-* extensions',
    'Auth (Basic, Bearer, API Key, Digest, OAuth2, AWS SigV4)',
    'Environment + secret variables',
    'Folder hierarchy & metadata',
  ],
  hoppscotch: [
    'Hoppscotch JSON exports',
    'Folders with full hierarchy',
    'Pre-request & test scripts',
    'Auth (Basic, Bearer, API Key, OAuth2, AWS SigV4, Digest)',
    'Environment variables with secret flag',
    'pw.* / hopp.* script aliases',
  ],
  bruno: [
    'Bruno legacy .bru files (text DSL)',
    'For Bruno 3.1+, use OpenCollection',
    'Single .bru: drop or paste the file',
    'Multi-file workspace: drop a .zip export',
    'Auth (Basic, Bearer, API Key, Digest, OAuth2, OAuth1, NTLM, WSSE, AWS SigV4)',
    'Pre-request, test scripts, assertions',
    'Pre-request and post-response variables',
  ],
  http: [
    '### request separators, one request per block',
    '@name and file-level @var declarations',
    'Headers and raw body, {{var}} passthrough',
    'Query params parsed from the request URL',
    'JetBrains < {% %} / > {% %} scripts (stored, not executed)',
    'VS Code {{$guid}} / {{$timestamp}} dynamic vars flagged as unsupported',
  ],
  har: [
    'HAR 1.2 browser capture entries',
    'Page-first grouping with origin fallback',
    'Methods, URLs, queries, headers, and request bodies',
    'Entry review and selection before persistence',
    'Authorization and token redaction before preview',
    'Cookies and captured response bodies discarded',
  ],
  curl: [
    'One POSIX-shell cURL command',
    'Method, URL, headers, cookies, Basic auth',
    'Raw, form, and binary body modes',
    'Redirect, timeout, proxy, and TLS settings',
    'Unsupported options shown as warnings',
  ],
  url: [
    'HTTPS only, without credentials',
    'Fetched through Restura’s secure backend',
    'JSON/YAML, Bruno, and HTTP text formats',
    'Private, local, metadata, and binary targets blocked',
    'Parsed review is required before import',
  ],
};

export function detectRemoteFormat(text: string, sourceUrl: string): ParsedImportType {
  const format = detectImportFormat(text, new URL(sourceUrl).pathname);
  if (format === 'har') {
    throw new Error('Remote import is not a supported Restura collection or specification format.');
  }
  return format;
}

/**
 * Detect an import file's format from its name and contents — used when a
 * file is dropped anywhere on the window, so no format tab was chosen.
 */
export function detectImportFormat(text: string, fileName: string): ParsedImportType | 'har' {
  const pathname = fileName.toLowerCase();
  if (pathname.endsWith('.har')) return 'har';
  if (pathname.endsWith('.bru')) return 'bruno';
  if (pathname.endsWith('.http') || pathname.endsWith('.rest')) return 'http';
  if (/^\s*(?:meta|vars)\s*\{/m.test(text)) return 'bruno';
  if (/^\s*(?:###|[A-Z]+\s+https?:\/\/)/m.test(text)) return 'http';
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    data = yaml.load(text);
  }
  if (!data || typeof data !== 'object')
    throw new Error('Remote import format could not be detected.');
  const record = data as Record<string, unknown>;
  if (
    record.log &&
    typeof record.log === 'object' &&
    Array.isArray((record.log as { entries?: unknown }).entries)
  ) {
    return 'har';
  }
  if (typeof record.opencollection === 'string') return 'opencollection';
  if (typeof record.openapi === 'string' || typeof record.swagger === 'string') return 'openapi';
  if (record.info && typeof record.info === 'object' && 'schema' in record.info) return 'postman';
  // Postman v3 logical tree (single JSON / YAML file).
  if (record.$kind === 'collection') return 'postman';
  if (record._type === 'export' || Array.isArray(record.resources)) return 'insomnia';
  if ('v' in record && (Array.isArray(record.requests) || Array.isArray(record.folders)))
    return 'hoppscotch';
  throw new Error('This file is not a supported collection, environment, or specification format.');
}

export async function fetchRemoteArtifact(url: string): Promise<string> {
  const electron = getElectronAPI();
  if (electron?.deepLinks) {
    const result = await electron.deepLinks.fetchImport(url);
    if (!result.ok) throw new Error(result.error);
    return result.text;
  }
  const response = await fetch(`${workerBaseUrl()}/api/import/fetch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...workerAuthHeaders() },
    body: JSON.stringify({ url }),
  });
  const result = (await response.json()) as { text?: unknown; error?: unknown };
  if (!response.ok || typeof result.text !== 'string') {
    throw new Error(typeof result.error === 'string' ? result.error : 'Remote import failed.');
  }
  return result.text;
}

/** A dropped / picked .zip is a Postman v3 archive when it holds v3 files; else Bruno. */
export function detectZipImportFormat(paths: readonly string[]): 'postman' | 'bruno' {
  return isPostmanV3Paths(paths) ? 'postman' : 'bruno';
}

/**
 * Thin File adapter over the shared folder walk (`collectPostmanFolderFiles`):
 * caps are applied to `File.size` before anything is read, only YAML / JSON is
 * read, and non-YAML files under `.resources/` are recorded as unread.
 */
export async function readPostmanFolderFiles(files: readonly File[]): Promise<PostmanV3FileMap> {
  return collectPostmanFolderFiles(
    files.map((f) => ({
      path: (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name,
      size: f.size,
      read: () => f.text(),
    }))
  );
}

/**
 * A picked folder with request files but no `.resources/` entries: either a
 * hand-made folder or a picker that skipped hidden directories. Collection and
 * folder metadata (auth, scripts, variables, examples) would then be missing.
 */
export function folderPickWarnings(files: PostmanV3FileMap): ImportWarning[] {
  const paths = Object.keys(files);
  const hasResources = paths.some((p) => p.split('/').includes('.resources'));
  if (hasResources || !isPostmanV3Paths(paths)) return [];
  return [
    {
      kind: 'unmodelled-construct',
      construct: 'folder-resources',
      requestName: paths[0]?.split('/')[0] ?? 'folder',
      detail:
        'No .resources folders were included, so collection / folder auth, scripts, variables and examples may be missing; import a .zip of the folder instead',
    },
  ];
}

/**
 * Read a picked / dropped .zip, refusing it by `File.size` BEFORE its bytes
 * are loaded into memory (the shared reader re-checks the byte length).
 */
export async function readZipBytes(file: File): Promise<Uint8Array> {
  if (file.size > POSTMAN_V3_LIMITS.maxArchiveBytes) {
    throw new PostmanV3ContainerError('archive is too large');
  }
  return new Uint8Array(await file.arrayBuffer());
}

/** A dropped .zip: a Postman v3 archive when it holds v3 files, else a Bruno export. */
export async function detectDroppedZip(file: File): Promise<'postman' | 'bruno'> {
  const bytes = await readZipBytes(file);
  const { listZipEntryNames } = await import('@shared/collections/postman/v3-archive');
  return detectZipImportFormat(listZipEntryNames(bytes));
}

/** True when a drop carries a directory (its File has no readable contents). */
export function isDirectoryDrop(dataTransfer: DataTransfer): boolean {
  const item = dataTransfer.items?.[0] as
    | (DataTransferItem & { webkitGetAsEntry?: () => { isDirectory?: boolean } | null })
    | undefined;
  return item?.webkitGetAsEntry?.()?.isDirectory === true;
}

export const DIRECTORY_DROP_MESSAGE =
  'Folders cannot be dropped here: drop a .zip of the collection folder, or use "Import folder".';
