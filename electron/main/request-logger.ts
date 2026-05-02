import { app, ipcMain } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

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
    // Check file size — rotate (truncate) if over limit
    if (fs.existsSync(filePath)) {
      const { size } = fs.statSync(filePath);
      if (size >= MAX_LOG_SIZE) {
        fs.writeFileSync(filePath, '');
      }
    }
    fs.appendFileSync(filePath, JSON.stringify(entry) + '\n', 'utf8');
  } catch {
    // Silently ignore logging errors — never crash the app
  }
}

export function registerRequestLoggerIPC(): void {
  ipcMain.handle('log:getHistory', (_event, limit?: number) => {
    try {
      const filePath = getLogFilePath();
      if (!fs.existsSync(filePath)) return [];
      const content = fs.readFileSync(filePath, 'utf8');
      const lines = content.trim().split('\n').filter(Boolean);
      const n = limit ?? 100;
      const recent = lines.slice(-n);
      return recent.map((line) => JSON.parse(line) as LogEntry);
    } catch {
      return [];
    }
  });

  ipcMain.handle('log:clear', () => {
    try {
      const filePath = getLogFilePath();
      if (fs.existsSync(filePath)) {
        fs.writeFileSync(filePath, '');
      }
    } catch {
      // ignore
    }
  });
}
