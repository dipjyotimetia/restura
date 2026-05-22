import { app, ipcMain } from 'electron';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { z } from 'zod';
import { LogHistoryLimitSchema, validateIpcInput } from './ipc-validators';

/**
 * Set of protocols the request logger knows how to record. Streaming
 * protocols (ws/sse/mcp/socketio/kafka) log a single entry per session
 * with `method` describing the operation (e.g. "SUBSCRIBE", "PRODUCE"),
 * `status` mapped from the closing event, and `durationMs` covering the
 * session lifetime — not per-message events, which would flood the log.
 */
export type LogProtocol = 'http' | 'grpc' | 'ws' | 'sse' | 'mcp' | 'kafka' | 'socketio';

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
 * `requestId` is optional so older entries (pre-Gap-#2 rollout) load without
 * warnings.
 */
const LogEntrySchema = z.object({
  ts: z.number(),
  method: z.string(),
  url: z.string(),
  status: z.number(),
  durationMs: z.number(),
  protocol: z.enum(['http', 'grpc', 'ws', 'sse', 'mcp', 'kafka', 'socketio']),
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

export function logRequest(entry: LogEntry): void {
  writeChain = writeChain.then(async () => {
    try {
      const filePath = await getLogFilePath();
      try {
        const { size } = await fsp.stat(filePath);
        if (size >= MAX_LOG_SIZE) await fsp.writeFile(filePath, '');
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
      await fsp.appendFile(filePath, JSON.stringify(entry) + '\n', 'utf8');
    } catch {
      // Silently ignore logging errors — never crash the app
    }
  });
}

export function registerRequestLoggerIPC(): void {
  ipcMain.handle('log:getHistory', async (_event, rawLimit?: unknown) => {
    const limit = validateIpcInput(LogHistoryLimitSchema, rawLimit, 'log:getHistory');
    try {
      const filePath = await getLogFilePath();
      const content = await fsp.readFile(filePath, 'utf8');
      const lines = content.trim().split('\n').filter(Boolean);
      const n = limit ?? 100;
      const entries: LogEntry[] = [];
      for (const line of lines.slice(-n)) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch (err) {
          console.warn('[request-logger] skipping unparseable log line:', err);
          continue;
        }
        const result = LogEntrySchema.safeParse(parsed);
        if (!result.success) {
          console.warn('[request-logger] skipping invalid log entry:', result.error.issues);
          continue;
        }
        entries.push(result.data);
      }
      return entries;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      return [];
    }
  });

  ipcMain.handle('log:clear', async () => {
    try {
      await fsp.writeFile(await getLogFilePath(), '');
    } catch {
      // ignore
    }
  });
}
