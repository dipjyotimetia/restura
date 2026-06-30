import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '@/lib/shared/logger';
import { registerMigrationLogging } from '../registerMigrationLogging';
import { migrationTelemetry } from '../telemetry';

function fakeLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}
const asLogger = (l: ReturnType<typeof fakeLogger>): Logger => l as unknown as Logger;

describe('registerMigrationLogging', () => {
  let off: (() => void) | null = null;
  afterEach(() => {
    off?.();
    off = null;
  });

  it('logs quarantined outcomes at error level', () => {
    const log = fakeLogger();
    off = registerMigrationLogging(asLogger(log));

    migrationTelemetry.emit({
      kind: 'quarantined',
      store: 'globals',
      from: 0,
      reason: 'schema validation failed',
      quarantineKey: 'quarantine:globals:globals-storage:2026',
    });

    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining('quarantined'),
      expect.objectContaining({ store: 'globals', reason: 'schema validation failed' })
    );
  });

  it('logs lossy "ok" outcomes at warn level, and stays silent for clean ones', () => {
    const log = fakeLogger();
    off = registerMigrationLogging(asLogger(log));

    migrationTelemetry.emit({
      kind: 'ok',
      store: 'console',
      from: 0,
      to: 1,
      applied: ['v0->v1'],
      lossy: [{ field: 'entries[3].body', reason: 'truncated' }],
      state: {},
    });
    expect(log.warn).toHaveBeenCalledTimes(1);

    // A clean migration emits nothing.
    log.warn.mockClear?.();
    migrationTelemetry.emit({
      kind: 'ok',
      store: 'globals',
      from: 0,
      to: 1,
      applied: [],
      lossy: [],
      state: {},
    });
    migrationTelemetry.emit({ kind: 'noop', store: 'globals', at: 1 });
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
  });

  it('is idempotent: a second register does not double-log', () => {
    const log = fakeLogger();
    off = registerMigrationLogging(asLogger(log));
    off = registerMigrationLogging(asLogger(log)); // replaces the prior subscription

    migrationTelemetry.emit({
      kind: 'quarantined',
      store: 'globals',
      from: 0,
      reason: 'x',
      quarantineKey: 'k',
    });
    expect(log.error).toHaveBeenCalledTimes(1);
  });
});
