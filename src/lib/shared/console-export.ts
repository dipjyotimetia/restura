import { httpLikeStatus } from '@/lib/shared/console-format';
import { entryToCurl, type ConsoleEntry } from '@/store/useConsoleStore';

/**
 * Minimal HAR 1.2 shape. We emit just enough for the standard tools
 * (HAR Viewer, Charles, browser DevTools "Import HAR") to recognise the file
 * and render the per-request panes — request URL/method/headers/body and
 * response status/headers/body, plus timings. Fields like cookies, queryString
 * breakdowns, and content negotiation extras are omitted on purpose.
 */
interface HarHeader {
  name: string;
  value: string;
}

interface HarLog {
  log: {
    version: '1.2';
    creator: { name: string; version: string };
    entries: HarEntry[];
  };
}

interface HarEntry {
  startedDateTime: string;
  time: number;
  request: {
    method: string;
    url: string;
    httpVersion: string;
    headers: HarHeader[];
    queryString: HarHeader[];
    cookies: [];
    headersSize: -1;
    bodySize: -1;
    postData?: { mimeType: string; text: string };
  };
  response: {
    status: number;
    statusText: string;
    httpVersion: string;
    cookies: [];
    headers: HarHeader[];
    content: { size: number; mimeType: string; text: string };
    redirectURL: '';
    headersSize: -1;
    bodySize: -1;
  };
  cache: Record<string, never>;
  timings: { send: number; wait: number; receive: number };
}

function headersToHar(headers: Record<string, string | string[]>): HarHeader[] {
  const out: HarHeader[] = [];
  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      for (const v of value) out.push({ name, value: v });
    } else {
      out.push({ name, value });
    }
  }
  return out;
}

function queryStringFromUrl(url: string): HarHeader[] {
  try {
    const u = new URL(url);
    const out: HarHeader[] = [];
    for (const [name, value] of u.searchParams) {
      out.push({ name, value });
    }
    return out;
  } catch {
    return [];
  }
}

function contentTypeFromHeaders(headers: Record<string, string | string[]>): string {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === 'content-type') {
      return Array.isArray(value) ? (value[0] ?? '') : value;
    }
  }
  return '';
}

export function entriesToHar(entries: ConsoleEntry[]): HarLog {
  return {
    log: {
      version: '1.2',
      creator: { name: 'Restura', version: '1.0' },
      entries: entries.map((entry) => {
        const reqContentType = contentTypeFromHeaders(
          // sentHeaders is Record<string, string>; HAR helper accepts the wider shape.
          entry.request.headers as unknown as Record<string, string | string[]>
        );
        const har: HarEntry = {
          startedDateTime: new Date(entry.timestamp).toISOString(),
          time: entry.response.time,
          request: {
            method: entry.request.method,
            url: entry.request.url,
            httpVersion: 'HTTP/1.1',
            headers: headersToHar(
              entry.request.headers as unknown as Record<string, string | string[]>
            ),
            queryString: queryStringFromUrl(entry.request.url),
            cookies: [],
            headersSize: -1,
            bodySize: -1,
            ...(entry.request.body !== undefined && {
              postData: {
                mimeType: reqContentType || 'text/plain',
                text: entry.request.body,
              },
            }),
          },
          response: {
            // HAR consumers treat status 0 as "no response"; gRPC stores its
            // code in status (OK === 0), so map it onto the HTTP equivalent.
            status: httpLikeStatus(entry.protocol, entry.response.status),
            statusText: entry.response.statusText,
            httpVersion: 'HTTP/1.1',
            cookies: [],
            headers: headersToHar(entry.response.headers),
            content: {
              size: entry.response.size,
              mimeType: contentTypeFromHeaders(entry.response.headers) || 'text/plain',
              text: entry.response.body,
            },
            redirectURL: '',
            headersSize: -1,
            bodySize: -1,
          },
          cache: {},
          timings: { send: 0, wait: entry.response.time, receive: 0 },
        };
        return har;
      }),
    },
  };
}

export function entriesToNdjson(entries: ConsoleEntry[]): string {
  return entries
    .map((entry) =>
      JSON.stringify({
        id: entry.id,
        timestamp: entry.timestamp,
        protocol: entry.protocol ?? 'http',
        request: entry.request,
        response: entry.response,
        ...(entry.scriptLogs && { scriptLogs: entry.scriptLogs }),
        ...(entry.tests && { tests: entry.tests }),
      })
    )
    .join('\n');
}

export function entriesToCurlBatch(entries: ConsoleEntry[]): string {
  // Reverse so the file lists oldest first — matches the natural order users
  // expect when re-running a sequence of requests.
  return [...entries].reverse().map(entryToCurl).join('\n\n');
}

export interface ConsoleExportFile {
  filename: string;
  mimeType: string;
  contents: string;
}

export function buildExportFile(
  format: 'har' | 'ndjson' | 'curl',
  entries: ConsoleEntry[]
): ConsoleExportFile {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  if (format === 'har') {
    return {
      filename: `restura-console-${ts}.har`,
      mimeType: 'application/json',
      contents: JSON.stringify(entriesToHar(entries), null, 2),
    };
  }
  if (format === 'ndjson') {
    return {
      filename: `restura-console-${ts}.ndjson`,
      mimeType: 'application/x-ndjson',
      contents: entriesToNdjson(entries),
    };
  }
  return {
    filename: `restura-console-${ts}.sh`,
    mimeType: 'text/x-shellscript',
    contents: `#!/usr/bin/env bash\nset -euo pipefail\n\n${entriesToCurlBatch(entries)}\n`,
  };
}

/**
 * Trigger a browser download for the given export file. Falls back to a no-op
 * if `document` isn't available (test environment).
 */
export function downloadExportFile(file: ConsoleExportFile): void {
  if (typeof document === 'undefined') return;
  const blob = new Blob([file.contents], { type: file.mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = file.filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  // Revoke after a tick — some browsers won't honour the download if revoked
  // synchronously while the click is still being processed.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
