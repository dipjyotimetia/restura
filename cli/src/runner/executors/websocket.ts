import { validateURL } from '@shared/protocol/url-validation';
import type { ExecuteOptions, ExecuteOutcome, StreamEvent } from './types';

/**
 * WebSocket executor. Standalone (not wired into the protocol dispatcher) —
 * `ocToInternal` surfaces WebSocket items in OpenCollection exports as
 * folders rather than as a runnable internal request type. Once the internal
 * Request union gains a 'websocket' variant, the dispatcher can route here.
 *
 * Until then, callers can drive this directly with a parsed WebSocket spec.
 */
export interface WebSocketSpec {
  url: string;
  /** Headers attached to the upgrade request. */
  headers?: Record<string, string>;
  /** Optional first message to send once the socket opens. */
  initialMessage?: string;
  /** Subprotocols, if any. */
  protocols?: string[];
}

const DEFAULT_DURATION_MS = 5000;

export async function executeWebSocket(
  spec: WebSocketSpec,
  opts: ExecuteOptions
): Promise<ExecuteOutcome> {
  const validation = validateURL(spec.url.replace(/^ws/, 'http'), {
    allowPrivateIPs: false,
    allowLocalhost: opts.allowLocalhost,
  });
  if (!validation.valid) {
    return {
      status: 400,
      passed: false,
      durationMs: 0,
      bodyBytes: 0,
      errorMessage: `Invalid URL: ${validation.error ?? 'unknown'}`,
    };
  }

  // Dynamic import keeps `ws` out of the bundle for users who never run a
  // WebSocket — and lets us produce a clear error if the dep is missing.
  let WebSocketCtor: typeof import('ws').WebSocket;
  try {
    const mod = await import('ws');
    WebSocketCtor = mod.WebSocket;
  } catch {
    return {
      status: 0,
      passed: false,
      durationMs: 0,
      bodyBytes: 0,
      errorMessage:
        'WebSocket support requires the `ws` package. Install it as a CLI dependency.',
    };
  }

  const durationMs = opts.wsDurationMs ?? DEFAULT_DURATION_MS;
  const maxMessages = opts.wsMaxMessages;
  const start = Date.now();
  const events: StreamEvent[] = [];
  let bodyBytes = 0;
  let errorMessage: string | undefined;

  await new Promise<void>((resolve) => {
    const ws = new WebSocketCtor(spec.url, spec.protocols ?? [], {
      headers: spec.headers ?? {},
      handshakeTimeout: opts.timeoutMs,
    });
    const timer = setTimeout(() => {
      try {
        ws.close();
      } catch {
        // ignore
      }
    }, durationMs);

    ws.on('open', () => {
      events.push({ event: 'open', data: '', timestamp: Date.now() });
      if (spec.initialMessage !== undefined) {
        ws.send(spec.initialMessage);
      }
    });
    ws.on('message', (raw: Buffer | ArrayBuffer | Buffer[]) => {
      const buf = Buffer.isBuffer(raw)
        ? raw
        : Array.isArray(raw)
          ? Buffer.concat(raw)
          : Buffer.from(raw as ArrayBuffer);
      bodyBytes += buf.byteLength;
      const text = isLikelyText(buf) ? buf.toString('utf-8') : buf.toString('base64');
      events.push({ event: 'message', data: text, timestamp: Date.now() });
      if (maxMessages !== undefined && events.filter((e) => e.event === 'message').length >= maxMessages) {
        try {
          ws.close();
        } catch {
          // ignore
        }
      }
    });
    ws.on('error', (err: Error) => {
      errorMessage = err.message;
    });
    ws.on('close', () => {
      events.push({ event: 'close', data: '', timestamp: Date.now() });
      clearTimeout(timer);
      resolve();
    });
  });

  return {
    status: errorMessage ? 0 : 101, // 101 Switching Protocols on successful upgrade
    passed: errorMessage === undefined,
    durationMs: Date.now() - start,
    bodyBytes,
    streamEvents: events,
    ...(errorMessage ? { errorMessage } : {}),
  };
}

function isLikelyText(buf: Buffer): boolean {
  // Heuristic: if every byte is printable ASCII or common whitespace, treat as text.
  for (let i = 0; i < Math.min(buf.length, 256); i++) {
    const b = buf[i]!;
    if (b === 9 || b === 10 || b === 13 || (b >= 32 && b <= 126)) continue;
    if (b >= 128) continue; // allow UTF-8 high bytes
    return false;
  }
  return true;
}
