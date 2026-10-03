import { extensionForContentType } from './binaryBody';

type HeaderEntry = [string, string | string[]];

/** Headers whose name or any value contains `needle` (case-insensitive). */
export function filterHeaders(entries: HeaderEntry[], needle: string): HeaderEntry[] {
  const q = needle.trim().toLowerCase();
  if (!q) return entries;
  return entries.filter(([key, value]) =>
    [key, ...(Array.isArray(value) ? value : [value])].some((v) => v.toLowerCase().includes(q))
  );
}

/** `Name: value` lines; multi-value headers (e.g. set-cookie) get one line each. */
export function headersToText(entries: HeaderEntry[]): string {
  return entries
    .flatMap(([key, value]) => (Array.isArray(value) ? value : [value]).map((v) => `${key}: ${v}`))
    .join('\n');
}

const TEXT_EXT: Record<string, string> = {
  json: 'json',
  xml: 'xml',
  html: 'html',
  javascript: 'js',
  css: 'css',
  yaml: 'yaml',
};

/** File extension for a downloaded body. */
export function downloadExtension(
  contentType: string,
  options: { isBase64: boolean; language: string; isCsv: boolean }
): string {
  if (options.isBase64) return extensionForContentType(contentType);
  if (options.isCsv) return 'csv';
  return TEXT_EXT[options.language] ?? 'txt';
}

/** MIME type for a downloaded body: the response's own, else a text default. */
export function downloadMime(contentType: string, isBase64: boolean): string {
  if (contentType.trim()) return contentType;
  return isBase64 ? 'application/octet-stream' : 'text/plain;charset=utf-8';
}

/**
 * Safe file name from the request name: path separators, control and
 * reserved characters removed, whitespace collapsed, length capped.
 */
export function downloadFileName(requestName: string | undefined, extension: string): string {
  const base = (requestName ?? '')
    .split(/[\u0000-\u001f\u007f<>:"/\\|?*]+/)
    .filter((part) => !/^\s*\.*\s*$/.test(part))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
    .trim();
  return `${base || 'response'}.${extension}`;
}
