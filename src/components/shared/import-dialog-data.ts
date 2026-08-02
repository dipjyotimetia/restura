import * as yaml from 'js-yaml';
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
    tagline: 'v2.1 collections & environments',
    initials: 'PM',
    color: '#ff6c37',
    accept: '.json,.yaml,.yml',
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
    'Collections and folders',
    'HTTP requests (all methods)',
    'Query parameters and headers',
    'Request body (JSON, form-data, etc.)',
    'Auth (Basic, Bearer, API Key, OAuth2, AWS Sig)',
    'Pre-request and test scripts',
    'Environment variables',
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
  const pathname = new URL(sourceUrl).pathname.toLowerCase();
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
  if (typeof record.opencollection === 'string') return 'opencollection';
  if (typeof record.openapi === 'string' || typeof record.swagger === 'string') return 'openapi';
  if (record.info && typeof record.info === 'object' && 'schema' in record.info) return 'postman';
  if (record._type === 'export' || Array.isArray(record.resources)) return 'insomnia';
  if ('v' in record && (Array.isArray(record.requests) || Array.isArray(record.folders)))
    return 'hoppscotch';
  throw new Error('Remote import is not a supported Restura collection or specification format.');
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
