import { redactExchange } from '@shared/capture/secret-extractor';
import type { CapturedExchange } from '@shared/capture/types';
import { v4 as uuid } from 'uuid';
import type { Collection, FormDataItem, HttpRequest, KeyValue } from '@/types';
import { coerceHttpMethod, type ImportResult, type ImportWarning } from './types';

const MAX_INPUT_BYTES = 16 * 1024 * 1024;
const MAX_DEPTH = 32;
const MAX_ENTRIES = 10_000;
const MAX_HEADERS = 200;
const MAX_BODY_CHARS = 1024 * 1024;

type HarRecord = Record<string, unknown>;

export interface HarPreviewEntry {
  id: string;
  name: string;
  method: string;
  url: string;
  selected: boolean;
  stateChanging: boolean;
  /** Internal-only sanitized value; never expose raw HAR nodes to the UI. */
  request: HttpRequest;
  provenance: { pageRef?: string; startedDateTime?: string; timeMs?: number };
}

export interface HarPreviewGroup {
  id: string;
  name: string;
  entries: HarPreviewEntry[];
}

export interface HarEnvironmentCandidate {
  id: string;
  groupId: string;
  name: string;
  baseUrl: string;
}

export interface HarImportPreview {
  groups: HarPreviewGroup[];
  warnings: ImportWarning[];
  /** Optional suggestions only; callers must opt in before persistence. */
  environmentCandidates: HarEnvironmentCandidate[];
}

/**
 * Parse untrusted HAR 1.2 JSON into a bounded, already-redacted review model.
 * This function must stay free of persistence effects: ImportDialog only sends
 * the selected entry ids to buildHarImportCollections after user confirmation.
 */
export function parseHarImport(source: string): HarImportPreview {
  if (new TextEncoder().encode(source).byteLength > MAX_INPUT_BYTES) {
    throw new Error('HAR input exceeds the maximum size of 16 MiB');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error('HAR input must be valid JSON');
  }
  assertBoundedDepth(parsed);

  const root = record(parsed, 'HAR document');
  const log = record(root.log, 'HAR log');
  if (log.version !== '1.2') throw new Error('Only HAR 1.2 files are supported');
  if (!Array.isArray(log.entries)) throw new Error('HAR log.entries must be an array');
  if (log.entries.length > MAX_ENTRIES) {
    throw new Error(`HAR contains more than the maximum ${MAX_ENTRIES.toLocaleString()} entries`);
  }

  const pageNames = new Map<string, string>();
  if (Array.isArray(log.pages)) {
    for (const page of log.pages) {
      if (!isRecord(page) || typeof page.id !== 'string') continue;
      pageNames.set(page.id, safeText(page.title, page.id, 1024));
    }
  }

  const warnings: ImportWarning[] = [];
  const groups = new Map<string, HarPreviewGroup>();
  const seen = new Set<string>();

  for (const [index, rawEntry] of log.entries.entries()) {
    const entry = record(rawEntry, `HAR entry ${index + 1}`);
    const rawRequest = record(entry.request, `HAR entry ${index + 1} request`);
    const method = safeText(rawRequest.method, 'GET', 16).toUpperCase();
    const url = safeText(rawRequest.url, '', 64 * 1024);
    if (!url) {
      warnings.push({
        kind: 'har-entry-discarded',
        entry: `Entry ${index + 1}`,
        reason: 'missing URL',
      });
      continue;
    }
    if (!isHttpUrl(url)) {
      warnings.push({
        kind: 'har-entry-discarded',
        entry: `Entry ${index + 1}`,
        reason: 'invalid HTTP URL',
      });
      continue;
    }

    const pageRef = typeof entry.pageref === 'string' ? entry.pageref : undefined;
    const group = getGroup(groups, pageRef, pageNames, url);
    const requestName = requestNameFor(method, url, index + 1);
    const headers = toHeaders(rawRequest.headers, requestName, warnings);
    const cookies = Array.isArray(rawRequest.cookies) ? rawRequest.cookies.length : 0;
    if (cookies > 0 || headers.some((header) => header.key.toLowerCase() === 'cookie')) {
      warnings.push({ kind: 'har-cookies-discarded', requestName });
    }

    const rawBody = toCapturedBody(rawRequest.postData, requestName, warnings);
    const exchange: CapturedExchange = {
      id: `har-${index}`,
      protocol: 'rest',
      method,
      url,
      startedAt: dateMs(entry.startedDateTime),
      request: {
        headers: headers
          .filter((header) => header.key.toLowerCase() !== 'cookie')
          .map((header) => ({ name: header.key, value: header.value })),
        ...(rawBody ? { body: rawBody } : {}),
      },
    };
    const redacted = redactExchange(exchange).exchange;
    const request = toHttpRequest(redacted, rawRequest.postData, requestName, warnings);
    const duplicateKey = `${request.method}\n${request.url}\n${bodyFingerprint(request)}`;
    const selected = !seen.has(duplicateKey) && !isAssetRequest(request);
    seen.add(duplicateKey);

    const response = isRecord(entry.response) ? entry.response : undefined;
    if (response && Number(response.status) >= 300 && Number(response.status) < 400) {
      warnings.push({ kind: 'har-redirect', requestName, status: Number(response.status) });
    }
    if (response && hasResponseContent(response.content)) {
      warnings.push({ kind: 'har-response-discarded', requestName });
    }
    if (response && Array.isArray(response.cookies) && response.cookies.length > 0) {
      warnings.push({ kind: 'har-cookies-discarded', requestName });
    }

    group.entries.push({
      id: exchange.id,
      name: requestName,
      method: request.method,
      url: request.url,
      selected,
      stateChanging: !['GET', 'HEAD', 'OPTIONS'].includes(request.method),
      request,
      provenance: {
        ...(pageRef ? { pageRef } : {}),
        ...(typeof entry.startedDateTime === 'string'
          ? { startedDateTime: entry.startedDateTime }
          : {}),
        ...(typeof entry.time === 'number' && Number.isFinite(entry.time)
          ? { timeMs: entry.time }
          : {}),
      },
    });
  }

  const ordered = [...groups.values()].filter((group) => group.entries.length > 0);
  if (ordered.length === 0) throw new Error('HAR contains no importable requests');
  const environmentCandidates = ordered.flatMap((group) => {
    const origins = new Set(group.entries.map((entry) => originFor(entry.url)));
    if (origins.size !== 1) return [];
    const baseUrl = origins.values().next().value;
    if (typeof baseUrl !== 'string' || !/^https?:\/\//.test(baseUrl)) return [];
    return [
      {
        id: `environment:${group.id}`,
        groupId: group.id,
        name: `${group.name} environment`,
        baseUrl,
      },
    ];
  });
  return { groups: ordered, warnings, environmentCandidates };
}

/** Build canonical collections after the explicit preview confirmation. */
export function buildHarImportCollections(
  preview: HarImportPreview,
  selectedIds: ReadonlySet<string>,
  selectedEnvironmentIds: ReadonlySet<string> = new Set()
): ImportResult[] {
  return preview.groups.flatMap((group) => {
    const entries = group.entries.filter((entry) => selectedIds.has(entry.id));
    if (entries.length === 0) return [];
    const collection: Collection & { _oc?: unknown } = {
      id: uuid(),
      name: group.name,
      items: entries.map((entry) => ({
        id: uuid(),
        name: entry.name,
        type: 'request',
        request: { ...entry.request, id: uuid(), name: entry.name },
      })),
      _oc: {
        opencollection: '1.0.0',
        info: { name: group.name },
        extensions: {
          'x-restura-har': entries.map(({ id, provenance }) => ({ id, ...provenance })),
        },
      },
    };
    const environments = preview.environmentCandidates
      .filter(
        (candidate) => candidate.groupId === group.id && selectedEnvironmentIds.has(candidate.id)
      )
      .map((candidate) => ({
        id: uuid(),
        name: candidate.name,
        collectionId: collection.id,
        variables: [{ id: uuid(), key: 'baseUrl', value: candidate.baseUrl, enabled: true }],
      }));
    return [
      { collection, warnings: preview.warnings, ...(environments.length ? { environments } : {}) },
    ];
  });
}

function getGroup(
  groups: Map<string, HarPreviewGroup>,
  pageRef: string | undefined,
  pageNames: Map<string, string>,
  url: string
): HarPreviewGroup {
  const origin = originFor(url);
  const id = pageRef ? `page:${pageRef}` : `origin:${origin}`;
  const existing = groups.get(id);
  if (existing) return existing;
  const group: HarPreviewGroup = {
    id,
    name: pageRef ? (pageNames.get(pageRef) ?? pageRef) : origin,
    entries: [],
  };
  groups.set(id, group);
  return group;
}

function toHeaders(raw: unknown, requestName: string, warnings: ImportWarning[]): KeyValue[] {
  if (!Array.isArray(raw)) return [];
  if (raw.length > MAX_HEADERS) throw new Error(`${requestName} exceeds ${MAX_HEADERS} headers`);
  return raw.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.name !== 'string' || typeof entry.value !== 'string') {
      warnings.push({ kind: 'har-field-discarded', requestName, field: 'malformed header' });
      return [];
    }
    if (entry.name.length > 1024 || entry.value.length > 64 * 1024) {
      throw new Error(`${requestName} contains an oversized header`);
    }
    return [{ id: uuid(), key: entry.name, value: entry.value, enabled: true }];
  });
}

function toCapturedBody(raw: unknown, requestName: string, warnings: ImportWarning[]) {
  if (!isRecord(raw)) return undefined;
  const text = typeof raw.text === 'string' ? raw.text : undefined;
  if (text && text.length > MAX_BODY_CHARS) throw new Error(`${requestName} body exceeds 1 MiB`);
  if (raw.encoding === 'base64') {
    warnings.push({ kind: 'har-lossy-body', requestName, detail: 'base64 body retained as text' });
  }
  return text === undefined
    ? undefined
    : {
        text,
        ...(typeof raw.mimeType === 'string' ? { mimeType: raw.mimeType.slice(0, 256) } : {}),
      };
}

function toHttpRequest(
  exchange: CapturedExchange,
  rawPostData: unknown,
  requestName: string,
  warnings: ImportWarning[]
): HttpRequest {
  const headers = exchange.request.headers.map((header) => ({
    id: uuid(),
    key: header.name,
    value: header.value,
    enabled: true,
  }));
  const postData = isRecord(rawPostData) ? rawPostData : undefined;
  const mimeType = typeof postData?.mimeType === 'string' ? postData.mimeType.toLowerCase() : '';
  const raw = exchange.request.body?.text ?? '';
  let body: HttpRequest['body'] = { type: 'none' };

  if (raw || postData) {
    if (mimeType.includes('application/json') || mimeType.endsWith('+json'))
      body = { type: 'json', raw };
    else if (mimeType.includes('xml')) body = { type: 'xml', raw };
    else if (mimeType.includes('application/x-www-form-urlencoded')) {
      body = {
        type: 'x-www-form-urlencoded',
        formData: formParts(
          postData,
          typeof postData?.text === 'string' ? postData.text : raw,
          requestName,
          warnings
        ),
      };
    } else if (mimeType.includes('multipart/form-data')) {
      body = { type: 'form-data', formData: formParts(postData, raw, requestName, warnings) };
    } else if (postData?.encoding === 'base64') {
      body = { type: 'text', raw };
    } else body = { type: 'text', raw };
  }

  return {
    id: uuid(),
    name: requestName,
    type: 'http',
    method: coerceHttpMethod(exchange.method, requestName, warnings),
    url: exchange.url,
    headers,
    params: [],
    body,
    auth: { type: 'none' },
  };
}

function formParts(
  postData: HarRecord | undefined,
  raw: string,
  requestName: string,
  warnings: ImportWarning[]
): FormDataItem[] {
  if (Array.isArray(postData?.params)) {
    return postData.params.flatMap((param) => {
      if (!isRecord(param) || typeof param.name !== 'string') {
        warnings.push({ kind: 'har-field-discarded', requestName, field: 'malformed form field' });
        return [];
      }
      return [
        {
          id: uuid(),
          key: param.name,
          value: redactFormValue(param.name, typeof param.value === 'string' ? param.value : ''),
          enabled: true,
          type: typeof param.fileName === 'string' ? 'file' : 'text',
          ...(typeof param.fileName === 'string' ? { fileName: param.fileName } : {}),
          ...(typeof param.contentType === 'string' ? { contentType: param.contentType } : {}),
        },
      ];
    });
  }
  return [...new URLSearchParams(raw)].map(([key, value]) => ({
    id: uuid(),
    key,
    value: redactFormValue(key, value),
    enabled: true,
    type: 'text',
  }));
}

/**
 * HAR form params are separate from postData.text, so they do not pass through
 * the capture body's normal redactor. Route each value through the same URL
 * query denylist instead of carrying a second security-sensitive pattern list.
 */
function redactFormValue(key: string, value: string): string {
  const url = new URL('https://restura.invalid/');
  url.searchParams.set(key, value);
  const redacted = redactExchange({
    id: 'har-form-redaction',
    protocol: 'rest',
    method: 'POST',
    url: url.toString(),
    startedAt: 0,
    request: { headers: [] },
  }).exchange.url;
  return new URL(redacted).searchParams.get(key) ?? '«redacted»';
}

function assertBoundedDepth(value: unknown): void {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.depth > MAX_DEPTH)
      throw new Error(`HAR nesting exceeds the maximum depth of ${MAX_DEPTH}`);
    if (Array.isArray(node.value)) {
      for (const child of node.value) stack.push({ value: child, depth: node.depth + 1 });
    } else if (isRecord(node.value)) {
      for (const child of Object.values(node.value))
        stack.push({ value: child, depth: node.depth + 1 });
    }
  }
}

function isAssetRequest(request: HttpRequest): boolean {
  const type = request.headers.find((header) => header.key.toLowerCase() === 'accept')?.value ?? '';
  return (
    /text\/(css|javascript)|image\/|font\//i.test(type) ||
    /\.(?:css|js|map|png|jpe?g|gif|svg|ico|woff2?)$/i.test(request.url)
  );
}

function bodyFingerprint(request: HttpRequest): string {
  if ('raw' in request.body && typeof request.body.raw === 'string') return request.body.raw;
  return JSON.stringify(request.body.formData ?? []);
}

function requestNameFor(method: string, url: string, index: number): string {
  try {
    return `${method} ${new URL(url).pathname || '/'}`;
  } catch {
    return `${method} request ${index}`;
  }
}

function originFor(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return 'Ungrouped requests';
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname.length > 0;
  } catch {
    return false;
  }
}

function dateMs(value: unknown): number {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0;
}

function hasResponseContent(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    (typeof value.text === 'string' && value.text.length > 0) ||
    (typeof value.size === 'number' && Number.isFinite(value.size) && value.size > 0)
  );
}

function record(value: unknown, label: string): HarRecord {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function isRecord(value: unknown): value is HarRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeText(value: unknown, fallback: string, max: number): string {
  return typeof value === 'string' ? value.slice(0, max) : fallback;
}
