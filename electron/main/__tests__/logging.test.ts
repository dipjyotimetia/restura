import './setup';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock electron-log/main with a controllable scoped logger + transports object.
// Built via vi.hoisted so the objects exist when the hoisted vi.mock factory runs.
const { scopedLogger, mockLog } = vi.hoisted(() => {
  const scoped = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return {
    scopedLogger: scoped,
    mockLog: {
      scope: vi.fn(() => scoped),
      initialize: vi.fn(),
      transports: {
        file: { level: 'silly' as unknown, maxSize: 0, format: undefined as unknown },
        console: { level: 'silly' as unknown },
      },
    },
  };
});
vi.mock('electron-log/main', () => ({ default: mockLog }));

import { electronLogSink, initLogging } from '../lifecycle/logging';
import type { LogRecord } from '../../../src/lib/shared/logger';

function record(partial: Partial<LogRecord>): LogRecord {
  return {
    level: 'info',
    scope: 'test',
    message: 'msg',
    fields: {},
    ts: 0,
    ...partial,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env['RESTURA_LOG_LEVEL'];
});

describe('electronLogSink', () => {
  it('routes a record to electron-log under its scope and level', () => {
    electronLogSink(record({ scope: 'http', level: 'warn', message: 'ssl bypassed' }));
    expect(mockLog.scope).toHaveBeenCalledWith('http');
    expect(scopedLogger.warn).toHaveBeenCalledWith('ssl bypassed');
  });

  it('passes fields as a second arg only when present', () => {
    electronLogSink(record({ level: 'error', message: 'boom', fields: { code: 42 } }));
    expect(scopedLogger.error).toHaveBeenCalledWith('boom', { code: 42 });
  });

  it('omits the fields arg when fields is empty', () => {
    electronLogSink(record({ level: 'info', message: 'ready', fields: {} }));
    expect(scopedLogger.info).toHaveBeenCalledWith('ready');
    expect(scopedLogger.info).not.toHaveBeenCalledWith('ready', {});
  });
});

describe('initLogging', () => {
  it('uses debug level in dev and info in prod', () => {
    initLogging(true);
    expect(mockLog.transports.file.level).toBe('debug');
    expect(mockLog.transports.console.level).toBe('debug');

    initLogging(false);
    expect(mockLog.transports.file.level).toBe('info');
    expect(mockLog.transports.console.level).toBe(false);
  });

  it('honors a valid RESTURA_LOG_LEVEL override', () => {
    process.env['RESTURA_LOG_LEVEL'] = 'warn';
    initLogging(false);
    expect(mockLog.transports.file.level).toBe('warn');
  });

  it('ignores an invalid RESTURA_LOG_LEVEL and falls back to the default', () => {
    process.env['RESTURA_LOG_LEVEL'] = 'bogus';
    initLogging(true);
    expect(mockLog.transports.file.level).toBe('debug');
  });

  it('configures rotation, calls initialize, and installs a JSON file formatter', () => {
    initLogging(false);
    expect(mockLog.transports.file.maxSize).toBe(5 * 1024 * 1024);
    expect(mockLog.initialize).toHaveBeenCalled();

    const format = mockLog.transports.file.format as (params: {
      message: { data: unknown[]; date: Date; level: string; scope?: string };
    }) => unknown[];
    expect(typeof format).toBe('function');

    const out = format({
      message: { data: ['hello', { a: 1 }], date: new Date(1234), level: 'info', scope: 'http' },
    });
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0] as string)).toEqual({
      ts: 1234,
      level: 'info',
      scope: 'http',
      msg: 'hello',
      a: 1,
    });
  });
});
