import * as fsp from 'fs/promises';
import * as path from 'path';
import { app, ipcMain } from 'electron';
import { z } from 'zod';
import { IPC } from '../../shared/channels';
import {
  LogHistoryLimitSchema,
  validateIpcInput,
  assertTrustedSender,
} from '../ipc/ipc-validators';

/**
 * Set of protocols the request logger knows how to record. Streaming
 * protocols (ws/sse/mcp/socketio/kafka) log a single entry per session
 * with `method` describing the operation (e.g. "SUBSCRIBE", "PRODUCE"),
 * `status` mapped from the closing event, and `durationMs` covering the
 * session lifetime — not per-message events, which would flood the log.
 */
export type LogProtocol = 'http' | 'grpc' | 'ws' | 'sse' | 'mcp' | 'kafka' | 'mqtt' | 'socketio';

export interface LogEntry {
  ts: number;
  method: string;
  url: string;
  status: number;
  durationMs: number;
  protocol: LogProtocol;
  /** Correlation id threaded from RequestSpec → handler → upstream. */
  requestId?: string;
  error?: string;
}

/**
 * Minimal Zod schema mirroring LogEntry. We validate on read because the
 * .jsonl file can be appended to by older app versions, partially flushed
 * after a crash, or hand-edited — a bad line should be skipped, not crash
 * the renderer's request-history view.
 *
 * `requestId` is optional so older entries (written before the field was
 * introduced) load without warnings.
 */
const LogEntrySchema = z.object({
  ts: z.number(),
  method: z.string(),
  url: z.string(),
  status: z.number(),
  durationMs: z.number(),
  protocol: z.enum(['http', 'grpc', 'ws', 'sse', 'mcp', 'kafka', 'mqtt', 'socketio']),
  requestId: z.string().optional(),
  error: z.string().optional(),
});

const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10MB
let logFilePath: string | null = null;
// Serialise appends — concurrent logRequest() calls would otherwise
// interleave bytes mid-line.
let writeChain: Promise<void> = Promise.resolve();

async function getLogFilePath(): Promise<string> {
  if (!logFilePath) {
    const logsDir = path.join(app.getPath('userData'), 'logs');
    await fsp.mkdir(logsDir, { recursive: true });
    logFilePath = path.join(logsDir, 'requests.jsonl');
  }
  return logFilePath;
}

/**
 * Strip secrets from a URL before it is persisted to the on-disk request log:
 *  - query string (api keys / tokens frequently ride in `?api_key=…`)
 *  - userinfo (`https://user:pass@host` → `https://host`)
 *  - fragment (not sent upstream, but redacted for parity with the renderer's
 *    sanitizeURL and to avoid logging anything secret-shaped)
 *
 * Best-effort: a target that doesn't parse as a URL (e.g. a bare gRPC
 * `host:port`) is returned with any `?…`/`#…` suffix dropped.
 */
function redactLogUrl(url: string): string {
  try {
    const u = new URL(url);
    u.search = '';
    u.username = '';
    u.password = '';
    u.hash = '';
    return u.toString();
  } catch {
    const cut = url.search(/[?#]/);
    return cut === -1 ? url : url.slice(0, cut);
  }
}

export function logRequest(entry: LogEntry): void {
  // Redact at the single choke point so every protocol caller is covered and a
  // secret in a query param / userinfo never reaches the plaintext log file.
  const safeEntry: LogEntry = { ...entry, url: redactLogUrl(entry.url) };
  writeChain = writeChain.then(async () => {
    try {
      const filePath = await getLogFilePath();
      try {
        const { size } = await fsp.stat(filePath);
        if (size >= MAX_LOG_SIZE) await fsp.writeFile(filePath, '');
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
      await fsp.appendFile(filePath, JSON.stringify(safeEntry) + '\n', 'utf8');
    } catch {
      // Silently ignore logging errors — never crash the app
    }
  });
}

export async function getRequestLogHistory(limit = 100): Promise<LogEntry[]> {
  try {
    const filePath = await getLogFilePath();
    const content = await fsp.readFile(filePath, 'utf8');
    const lines = content.trim().split('\n').filter(Boolean);
    const entries: LogEntry[] = [];
    for (const line of lines.slice(-limit)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      const result = LogEntrySchema.safeParse(parsed);
      if (result.success) entries.push(result.data);
    }
    return entries;
  } catch {
    return [];
  }
}

export function registerRequestLoggerIPC(): void {
  ipcMain.handle(IPC.log.getHistory, async (event, rawLimit?: unknown) => {
    assertTrustedSender(IPC.log.getHistory, event);
    const limit = validateIpcInput(LogHistoryLimitSchema, rawLimit, IPC.log.getHistory);
    return getRequestLogHistory(limit ?? 100);
  });

  ipcMain.handle(IPC.log.clear, async (event) => {
    assertTrustedSender(IPC.log.clear, event);
    try {
      await fsp.writeFile(await getLogFilePath(), '');
    } catch {
      // ignore
    }
  });
}
