import { describe, it, expect, vi } from 'vitest';
import { formatBytes, formatTime, formatDate, keyValuePairsToRecord, debounce } from '../utils';

describe('formatBytes', () => {
  it('returns "0 Bytes" for 0', () => {
    expect(formatBytes(0)).toBe('0 Bytes');
  });
  it('formats bytes', () => {
    expect(formatBytes(512)).toBe('512 Bytes');
  });
  it('formats kilobytes', () => {
    expect(formatBytes(1024)).toBe('1 KB');
  });
  it('formats megabytes', () => {
    expect(formatBytes(1024 * 1024)).toBe('1 MB');
  });
});

describe('formatTime', () => {
  it('shows ms for values < 1000', () => {
    expect(formatTime(450)).toBe('450ms');
  });
  it('shows seconds for values >= 1000', () => {
    expect(formatTime(1500)).toBe('1.50s');
  });
});

describe('formatDate', () => {
  it('returns a non-empty string for a valid timestamp', () => {
    const result = formatDate(Date.now());
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });
});

describe('keyValuePairsToRecord', () => {
  it('converts enabled pairs to a record', () => {
    const items = [
      { key: 'X-Foo', value: 'bar', enabled: true },
      { key: 'X-Skip', value: 'v', enabled: false },
      { key: '', value: 'empty-key', enabled: true },
    ];
    expect(keyValuePairsToRecord(items)).toEqual({ 'X-Foo': 'bar' });
  });

  it('returns empty record for empty array', () => {
    expect(keyValuePairsToRecord([])).toEqual({});
  });

  it('trims whitespace from keys', () => {
    const items = [{ key: '  X-Key  ', value: 'v', enabled: true }];
    expect(keyValuePairsToRecord(items)).toEqual({ 'X-Key': 'v' });
  });
});

describe('debounce', () => {
  it('delays function execution', () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const debounced = debounce(fn, 100);

    debounced('a');
    debounced('b');
    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledOnce();
    expect(fn).toHaveBeenCalledWith('b');

    vi.useRealTimers();
  });
});
