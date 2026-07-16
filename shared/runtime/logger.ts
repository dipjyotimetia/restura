/**
 * Structured logger primitive. Single interface for renderer (console-backed),
 * Electron main (console + JSONL via request-logger), and Worker (no-op by
 * default, since console.* in a per-isolate hot path is wasteful).
 *
 * Usage:
 *   const log = createLogger('http-handler', { feature: 'http' });
 *   log.info('request received', { method, url, requestId });
 *
 * Field convention: lowercase keys, primitive values where possible. Avoid
 * logging credentials, tokens, or response bodies. Add a `requestId` when
 * one is available — that's how spans correlate across renderer → IPC →
 * upstream.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  child(scope: string, extraFields?: LogFields): Logger;
}

export interface LogRecord {
  level: LogLevel;
  scope: string;
  message: string;
  fields: LogFields;
  ts: number;
}

export type LogSink = (record: LogRecord) => void;

/**
 * Default sink: writes one line per record to `console.<level>`. Format is
 * single-line JSON so downstream tooling can parse it without state.
 */
export const consoleSink: LogSink = (record) => {
  const line = JSON.stringify({
    level: record.level,
    scope: record.scope,
    msg: record.message,
    ts: record.ts,
    ...record.fields,
  });
  switch (record.level) {
    case 'debug':
      console.debug(line);
      return;
    case 'info':
      console.info(line);
      return;
    case 'warn':
      console.warn(line);
      return;
    case 'error':
      console.error(line);
      return;
  }
};

/**
 * No-op sink. Worker default; renderer test default.
 */
export const noopSink: LogSink = () => {
  /* intentionally empty */
};

let activeSink: LogSink = consoleSink;
let minLevel: LogLevel = 'info';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function setLogSink(sink: LogSink): void {
  activeSink = sink;
}

export function setMinLogLevel(level: LogLevel): void {
  minLevel = level;
}

function emit(level: LogLevel, scope: string, message: string, fields: LogFields): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;
  activeSink({ level, scope, message, fields, ts: Date.now() });
}

export function createLogger(scope: string, baseFields: LogFields = {}): Logger {
  const log = (level: LogLevel, message: string, extra?: LogFields): void => {
    emit(level, scope, message, extra ? { ...baseFields, ...extra } : baseFields);
  };
  return {
    debug: (msg, fields) => log('debug', msg, fields),
    info: (msg, fields) => log('info', msg, fields),
    warn: (msg, fields) => log('warn', msg, fields),
    error: (msg, fields) => log('error', msg, fields),
    child: (childScope, extra) =>
      createLogger(`${scope}.${childScope}`, extra ? { ...baseFields, ...extra } : baseFields),
  };
}
