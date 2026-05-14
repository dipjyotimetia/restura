import { app, ipcMain } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { LogHistoryLimitSchema, validateIpcInput } from './ipc-validators';

export interface LogEntry {
  ts: number;
  method: string;
  url: string;
  status: number;
  durationMs: number;
  protocol: 'http' | 'grpc';
  error?: string;
}

/**
 * Minimal Zod schema mirroring LogEntry. We validate on read because the
 * .jsonl file can be appended to by older app versions, partially flushed
 * after a crash, or hand-edited — a bad line should be skipped, not crash
 * the renderer's request-history view.
 */
const LogEntrySchema = z.object({
  ts: z.number(),
  method: z.string(),
  url: z.string(),
  status: z.number(),
  durationMs: z.number(),
  protocol: z.enum(['http', 'grpc']),
  error: z.string().optional(),
});

const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10MB
let logFilePath: string | null = null;

function getLogFilePath(): string {
  if (!logFilePath) {
    const logsDir = path.join(app.getPath('userData'), 'logs');
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }
    logFilePath = path.join(logsDir, 'requests.jsonl');
  }
  return logFilePath;
}

export function logRequest(entry: LogEntry): void {
  try {
    const filePath = getLogFilePath();
    try {
      const { size } = fs.statSync(filePath);
      if (size >= MAX_LOG_SIZE) fs.writeFileSync(filePath, '');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    fs.appendFileSync(filePath, JSON.stringify(entry) + '\n', 'utf8');
  } catch {
    // Silently ignore logging errors — never crash the app
  }
}

export function registerRequestLoggerIPC(): void {
  ipcMain.handle('log:getHistory', (_event, rawLimit?: unknown) => {
    const limit = validateIpcInput(LogHistoryLimitSchema, rawLimit, 'log:getHistory');
    try {
      const filePath = getLogFilePath();
      const content = fs.readFileSync(filePath, 'utf8');
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

  ipcMain.handle('log:clear', () => {
    try {
      fs.writeFileSync(getLogFilePath(), '');
    } catch {
      // ignore
    }
  });
}
