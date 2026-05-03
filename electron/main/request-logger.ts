import { app, ipcMain } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
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
      return lines.slice(-n).map((line) => JSON.parse(line) as LogEntry);
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
