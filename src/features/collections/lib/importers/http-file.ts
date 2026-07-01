import { v4 as uuid } from 'uuid';
import { coerceHttpMethod, type ImportResult, type ImportWarning } from './types';
import type { BodyType, Collection, CollectionItem, HttpRequest, KeyValue } from '@/types';

/**
 * VS Code REST Client and JetBrains HTTP Client share the same base `.http`
 * grammar (`###` separators, `@name`, file-level `@var = value`, `{{var}}`).
 * JetBrains layers `< {% %}` / `> {% %}` script blocks on top — detecting
 * those only changes whether the script scanner runs; everything else is
 * parsed identically for both tools.
 */
export interface ImportHttpFileOptions {
  /** Source filename, used only to derive the collection/environment name. */
  fileName?: string;
}

const NAME_ANNOTATION = /^(?:\/\/|#)\s*@name\s+(.+)$/;
const FILE_VAR = /^@([A-Za-z_][\w-]*)\s*=\s*(.*)$/;
const REQUEST_LINE = /^([A-Za-z]+)\s+(\S+)(?:\s+HTTP\/\d(?:\.\d)?)?\s*$/;
const HEADER_LINE = /^([^:\s][^:]*):\s?(.*)$/;
const SCRIPT_OPEN = /^([<>])\s*\{%\s*(.*)$/;
const DYNAMIC_VAR = /\{\{\$([A-Za-z0-9_]+)(?:\([^)]*\))?\}\}/g;

export function importHttpFile(source: string, options: ImportHttpFileOptions = {}): ImportResult {
  const warnings: ImportWarning[] = [];
  const lines = source.split(/\r\n|\n/);

  const blockStarts: number[] = [];
  lines.forEach((line, i) => {
    if (/^###/.test(line)) blockStarts.push(i);
  });

  const filePrefixLines = lines.slice(0, blockStarts[0] ?? lines.length);
  const fileVariables = parseFileVariables(filePrefixLines);

  const dynamicVarCounts = new Map<string, number>();
  const items: CollectionItem[] = [];

  blockStarts.forEach((startIdx, i) => {
    const endIdx = blockStarts[i + 1] ?? lines.length;
    const blockLines = lines.slice(startIdx, endIdx);
    const item = parseBlock(blockLines, i + 1, warnings, dynamicVarCounts);
    if (item) items.push(item);
  });

  for (const [varName, count] of dynamicVarCounts) {
    warnings.push({ kind: 'unknown-dynamic-var', varName, count });
  }

  const collectionName = options.fileName
    ? options.fileName.replace(/\.(http|rest)$/i, '')
    : 'HTTP File Import';

  const collection: Collection = { id: uuid(), name: collectionName, items };
  const result: ImportResult = { collection, warnings };

  if (fileVariables.length > 0) {
    result.environments = [
      {
        id: uuid(),
        name: options.fileName ? `${collectionName} variables` : 'HTTP File Variables',
        variables: fileVariables,
      },
    ];
  }

  return result;
}

function parseFileVariables(lines: string[]): KeyValue[] {
  const vars: KeyValue[] = [];
  for (const raw of lines) {
    const match = FILE_VAR.exec(raw.trim());
    if (match) {
      vars.push({ id: uuid(), key: match[1]!, value: match[2] ?? '', enabled: true });
    }
  }
  return vars;
}

function parseBlock(
  blockLines: string[],
  index: number,
  warnings: ImportWarning[],
  dynamicVarCounts: Map<string, number>
): CollectionItem | null {
  const headerMatch = /^###\s?(.*)$/.exec(blockLines[0] ?? '');
  const headerName = headerMatch?.[1]?.trim() || undefined;

  let cursor = 1;
  let explicitName: string | undefined;
  let preRequestScript: string | undefined;

  while (cursor < blockLines.length) {
    const line = blockLines[cursor]!;
    const trimmed = line.trim();
    if (trimmed === '') {
      cursor++;
      continue;
    }
    const nameMatch = NAME_ANNOTATION.exec(trimmed);
    if (nameMatch) {
      explicitName = nameMatch[1]!.trim();
      cursor++;
      continue;
    }
    const scriptOpen = SCRIPT_OPEN.exec(trimmed);
    if (scriptOpen && scriptOpen[1] === '<') {
      const block = collectScriptBlock(blockLines, cursor);
      preRequestScript = block.content;
      cursor = block.nextIndex;
      continue;
    }
    if (trimmed.startsWith('//') || trimmed.startsWith('#')) {
      cursor++;
      continue;
    }
    break;
  }

  const requestName = explicitName ?? headerName ?? `Request ${index}`;
  const requestLineRaw = blockLines[cursor];
  if (requestLineRaw === undefined) return null;
  const requestMatch = REQUEST_LINE.exec(requestLineRaw.trim());
  if (!requestMatch) return null;
  cursor++;

  const method = coerceHttpMethod(requestMatch[1], requestName, warnings);
  const { url, params } = splitUrlAndParams(requestMatch[2]!);

  const headers: KeyValue[] = [];
  while (cursor < blockLines.length) {
    const line = blockLines[cursor]!;
    if (line.trim() === '') {
      cursor++;
      break;
    }
    const headerMatch2 = HEADER_LINE.exec(line);
    if (!headerMatch2) break;
    headers.push({
      id: uuid(),
      key: headerMatch2[1]!.trim(),
      value: headerMatch2[2]!.trim(),
      enabled: true,
    });
    cursor++;
  }

  let testScript: string | undefined;
  const bodyLines: string[] = [];
  while (cursor < blockLines.length) {
    const line = blockLines[cursor]!;
    const scriptOpen = SCRIPT_OPEN.exec(line.trim());
    if (scriptOpen && scriptOpen[1] === '>') {
      const block = collectScriptBlock(blockLines, cursor);
      testScript = block.content;
      cursor = block.nextIndex;
      continue;
    }
    bodyLines.push(line);
    cursor++;
  }
  const bodyText = bodyLines.join('\n').trim();

  const contentTypeHeader = headers.find((h) => h.key.toLowerCase() === 'content-type');
  const bodyType = inferBodyType(contentTypeHeader?.value, bodyText);

  trackDynamicVars(requestMatch[2]!, dynamicVarCounts);
  for (const h of headers) trackDynamicVars(h.value, dynamicVarCounts);
  trackDynamicVars(bodyText, dynamicVarCounts);

  const request: HttpRequest = {
    id: uuid(),
    name: requestName,
    type: 'http',
    method,
    url,
    headers,
    params,
    body: { type: bodyType, ...(bodyType !== 'none' ? { raw: bodyText } : {}) },
    auth: { type: 'none' },
    ...(preRequestScript ? { preRequestScript } : {}),
    ...(testScript ? { testScript } : {}),
  };

  if (preRequestScript) {
    warnings.push({
      kind: 'unrecognized-script-type',
      scriptType: 'jetbrains-http-client-script',
      requestName,
    });
  }
  if (testScript) {
    warnings.push({
      kind: 'unrecognized-script-type',
      scriptType: 'jetbrains-http-client-script',
      requestName,
    });
  }

  return { id: uuid(), name: requestName, type: 'request', request };
}

/**
 * Collects a `< {% ... %}` / `> {% ... %}` script block starting at
 * `startIndex`, handling both the same-line-close and multi-line forms.
 * Returns the raw script text (never eval'd — see http-file.ts module docs
 * on script handling) and the index of the first line after the block.
 */
function collectScriptBlock(
  lines: string[],
  startIndex: number
): { content: string; nextIndex: number } {
  const openLine = lines[startIndex]!;
  const openMatch = SCRIPT_OPEN.exec(openLine.trim());
  const collected: string[] = [];
  const remainder = openMatch?.[2] ?? '';

  const sameLineClose = remainder.indexOf('%}');
  if (sameLineClose !== -1) {
    const text = remainder.slice(0, sameLineClose).trim();
    if (text) collected.push(text);
    return { content: collected.join('\n').trim(), nextIndex: startIndex + 1 };
  }
  if (remainder.trim()) collected.push(remainder);

  let i = startIndex + 1;
  for (; i < lines.length; i++) {
    const line = lines[i]!;
    const closeAt = line.indexOf('%}');
    if (closeAt !== -1) {
      const before = line.slice(0, closeAt);
      if (before.trim()) collected.push(before);
      i++;
      break;
    }
    collected.push(line);
  }
  return { content: collected.join('\n').trim(), nextIndex: i };
}

function splitUrlAndParams(rawUrl: string): { url: string; params: KeyValue[] } {
  const qIndex = rawUrl.indexOf('?');
  if (qIndex === -1) return { url: rawUrl, params: [] };
  const base = rawUrl.slice(0, qIndex);
  const queryString = rawUrl.slice(qIndex + 1);
  const params: KeyValue[] = queryString
    .split('&')
    .filter(Boolean)
    .map((pair) => {
      const eqIdx = pair.indexOf('=');
      const key = eqIdx === -1 ? pair : pair.slice(0, eqIdx);
      const value = eqIdx === -1 ? '' : pair.slice(eqIdx + 1);
      return { id: uuid(), key, value, enabled: true };
    });
  return { url: base, params };
}

function inferBodyType(contentType: string | undefined, bodyText: string): BodyType {
  if (!bodyText) return 'none';
  const ct = contentType?.toLowerCase() ?? '';
  if (ct.includes('json')) return 'json';
  if (ct.includes('xml')) return 'xml';
  if (ct.includes('x-www-form-urlencoded')) return 'x-www-form-urlencoded';
  return 'text';
}

function trackDynamicVars(text: string, counts: Map<string, number>): void {
  if (!text) return;
  for (const match of text.matchAll(DYNAMIC_VAR)) {
    const name = match[1]!;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
}
