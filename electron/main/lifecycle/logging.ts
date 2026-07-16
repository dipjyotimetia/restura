import log from 'electron-log/main';
import { type LogLevel, type LogSink, setLogSink, setMinLogLevel } from '@shared/runtime/logger';

/**
 * Electron-main logging foundation.
 *
 * `electron-log` is the backend (persisted, rotated file logs in the OS logs
 * dir + dev console). The repo's `createLogger()` abstraction stays the
 * frontend: every `electron/main/*` module logs via `createLogger('scope')`
 * with structured fields, and `electronLogSink` forwards those records into
 * `electron-log`. One interface for call sites, one backend doing persistence.
 *
 * File location (electron-log default): `app.getPath('logs')/main.log`
 *   macOS:   ~/Library/Logs/Restura/main.log
 *   Windows: %USERPROFILE%\AppData\Roaming\Restura\logs\main.log
 *   Linux:   ~/.config/Restura/logs/main.log
 * Rotation: when the file passes `maxSize`, electron-log renames it to
 * `main.old.log` (true rotation, not the truncate that request-logger uses).
 */

const VALID_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

function resolveLevel(isDev: boolean): LogLevel {
  const fromEnv = process.env['RESTURA_LOG_LEVEL'];
  if (fromEnv && (VALID_LEVELS as readonly string[]).includes(fromEnv)) {
    return fromEnv as LogLevel;
  }
  return isDev ? 'debug' : 'info';
}

/**
 * Sink that forwards a structured LogRecord into electron-log under its scope.
 * Fields are passed as a second arg only when present, so the formatter can
 * fold them into the JSON line.
 */
export const electronLogSink: LogSink = (record) => {
  const scoped = log.scope(record.scope);
  const hasFields = record.fields && Object.keys(record.fields).length > 0;
  if (hasFields) {
    scoped[record.level](record.message, record.fields);
  } else {
    scoped[record.level](record.message);
  }
};

export interface InitLoggingOptions {
  /**
   * Headless MCP stdio-server mode (`restura --mcp-server`). The MCP SDK owns
   * stdout for the JSON-RPC stream, and electron-log's console transport routes
   * info/debug to `console.info`/`console.debug` → stdout — which would corrupt
   * the protocol. Force the console transport off so the stream stays pristine;
   * the file transport still persists everything for debugging.
   */
  mcpServerMode?: boolean;
}

/**
 * Configure electron-log transports and point the shared logger's sink at it.
 * Call once, early in main.ts (before any log call), so module-init warnings
 * and the global error handlers are persisted from the first line.
 */
export function initLogging(isDev: boolean, options: InitLoggingOptions = {}): void {
  const level = resolveLevel(isDev);

  log.transports.file.level = level;
  // Console is invisible in packaged builds (only emitted during dev) and MUST
  // stay off in MCP stdio mode, where any stdout write corrupts JSON-RPC.
  log.transports.console.level = options.mcpServerMode ? false : isDev ? 'debug' : false;
  log.transports.file.maxSize = 5 * 1024 * 1024; // 5 MB, then rotate to *.old.log

  // Single-line JSON, mirroring the shared logger's consoleSink convention so
  // the file stays grep/parse-friendly: {"ts","level","scope","msg",...fields}.
  log.transports.file.format = ({ message }) => {
    const [msg, fields] = message.data as [unknown, unknown];
    const line: Record<string, unknown> = {
      ts: message.date.getTime(),
      level: message.level,
      scope: message.scope ?? '',
      msg,
    };
    if (fields && typeof fields === 'object') Object.assign(line, fields);
    return [JSON.stringify(line)];
  };

  // Enables the renderer→main bridge (cheap; lets future renderer logs land in
  // the same file). We deliberately do NOT call log.errorHandler/catchErrors —
  // main.ts already owns process.on('uncaughtException'|'unhandledRejection')
  // and those now persist through this sink; the library catcher would dup.
  log.initialize();

  setLogSink(electronLogSink);
  setMinLogLevel(level);
}
