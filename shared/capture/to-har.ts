/**
 * Export a capture session to HAR 1.2. WebSocket / SSE frames have no native
 * HAR slot, so they are attached under the non-standard `_webSocketMessages`
 * field (the same convention Chrome DevTools uses).
 */
import { redactExchange } from './secret-extractor';
import type { CapturedExchange, CapturedHeader, CaptureSession } from './types';

interface HarNameValue {
  name: string;
  value: string;
}

interface HarEntry {
  startedDateTime: string;
  time: number;
  request: {
    method: string;
    url: string;
    httpVersion: string;
    headers: HarNameValue[];
    queryString: HarNameValue[];
    cookies: HarNameValue[];
    headersSize: number;
    bodySize: number;
    postData?: { mimeType: string; text: string };
  };
  response: {
    status: number;
    statusText: string;
    httpVersion: string;
    headers: HarNameValue[];
    cookies: HarNameValue[];
    content: { size: number; mimeType: string; text?: string };
    redirectURL: string;
    headersSize: number;
    bodySize: number;
  };
  cache: Record<string, never>;
  timings: { send: number; wait: number; receive: number };
  _webSocketMessages?: { type: 'send' | 'receive'; data: string; time: number }[];
}

export interface HarLog {
  log: {
    version: '1.2';
    creator: { name: string; version: string };
    entries: HarEntry[];
  };
}

function headers(list: CapturedHeader[]): HarNameValue[] {
  return list.map((h) => ({ name: h.name, value: h.value }));
}

function queryString(url: string): HarNameValue[] {
  try {
    const parsed = new URL(url);
    return [...parsed.searchParams.entries()].map(([name, value]) => ({ name, value }));
  } catch {
    return [];
  }
}

function toEntry(ex: CapturedExchange): HarEntry {
  const reqBody = ex.request.body?.text ?? '';
  const resBody = ex.response?.body?.text;
  const entry: HarEntry = {
    startedDateTime: new Date(ex.startedAt || 0).toISOString(),
    time: 0,
    request: {
      method: ex.method,
      url: ex.url,
      httpVersion: 'HTTP/1.1',
      headers: headers(ex.request.headers),
      queryString: queryString(ex.url),
      cookies: [],
      headersSize: -1,
      bodySize: reqBody.length,
      ...(ex.request.body
        ? { postData: { mimeType: ex.request.body.mimeType ?? '', text: reqBody } }
        : {}),
    },
    response: {
      status: ex.response?.status ?? 0,
      statusText: ex.response?.statusText ?? '',
      httpVersion: 'HTTP/1.1',
      headers: headers(ex.response?.headers ?? []),
      cookies: [],
      content: {
        size: resBody?.length ?? 0,
        mimeType: ex.response?.body?.mimeType ?? '',
        ...(resBody !== undefined ? { text: resBody } : {}),
      },
      redirectURL: '',
      headersSize: -1,
      bodySize: resBody?.length ?? -1,
    },
    cache: {},
    timings: { send: 0, wait: 0, receive: 0 },
  };
  if (ex.frames?.length) {
    entry._webSocketMessages = ex.frames.map((f) => ({
      type: f.direction === 'sent' ? 'send' : 'receive',
      data: f.payload.text ?? f.payload.base64 ?? '',
      time: f.at,
    }));
  }
  return entry;
}

/**
 * Convert a session to HAR. Each exchange is re-redacted (defence-in-depth,
 * mirroring `sessionToOpenCollection`) so a caller that passes raw exchanges
 * still cannot leak secrets through the HAR.
 */
export function sessionToHar(session: CaptureSession): HarLog {
  return {
    log: {
      version: '1.2',
      creator: { name: 'Restura Capture', version: '1.0.0' },
      entries: session.exchanges.map((ex) => toEntry(redactExchange(ex).exchange)),
    },
  };
}
