import { describe, it, expect } from 'vitest';
import {
  detectLanguage,
  formatBytes,
  formatClockTime,
  formatLongTimestamp,
  formatRelativeTime,
  getMethodColor,
  getStatusBadgeColor,
  getStatusTextColor,
  methodColors,
} from '../console-format';

describe('getMethodColor', () => {
  it.each(Object.keys(methodColors))('returns a non-empty class for %s', (method) => {
    expect(getMethodColor(method)).toMatch(/\w/);
  });

  it('falls back to GET color for unknown methods', () => {
    expect(getMethodColor('CONNECT')).toBe(methodColors.GET);
  });
});

describe('getStatusBadgeColor / getStatusTextColor', () => {
  it.each([
    [200, 'emerald'],
    [201, 'emerald'],
    [299, 'emerald'],
    [301, 'blue'],
    [404, 'amber'],
    [500, 'red'],
    [503, 'red'],
  ])('badge for %i contains %s', (status, hue) => {
    expect(getStatusBadgeColor(status)).toContain(hue);
  });

  it('treats status === 0 as an error in text color (network failures)', () => {
    expect(getStatusTextColor(0)).toContain('red');
  });

  it('falls back to muted for non-classed status', () => {
    expect(getStatusTextColor(100)).toContain('muted');
  });
});

describe('formatBytes', () => {
  it('uses B for sub-KB', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1023)).toBe('1023 B');
  });

  it('uses KB up to 1 MB exclusive', () => {
    expect(formatBytes(1024)).toBe('1.00 KB');
    expect(formatBytes(1024 * 1024 - 1)).toMatch(/KB$/);
  });

  it('uses MB beyond 1 MB', () => {
    expect(formatBytes(1024 * 1024)).toBe('1.00 MB');
    expect(formatBytes(2.5 * 1024 * 1024)).toBe('2.50 MB');
  });
});

describe('formatClockTime / formatLongTimestamp', () => {
  it('formatClockTime is 24h HH:MM:SS.fff', () => {
    // 1700000000000 = 2023-11-14T22:13:20.000Z. We don't pin TZ but assert
    // the surface shape: 9 chars + .fff.
    expect(formatClockTime(1_700_000_000_000)).toMatch(/^\d{2}:\d{2}:\d{2}\.\d{3}$/);
  });

  it('formatLongTimestamp includes month, day and HH:MM:SS', () => {
    const text = formatLongTimestamp(1_700_000_000_000);
    expect(text).toMatch(/[A-Z][a-z]{2}/); // month abbrev
    expect(text).toMatch(/\d{2}:\d{2}:\d{2}/);
  });
});

describe('formatRelativeTime', () => {
  it('returns "now" within the first second', () => {
    expect(formatRelativeTime(Date.now())).toBe('now');
  });

  it('returns Ns ago in the first minute', () => {
    expect(formatRelativeTime(Date.now() - 5_000)).toMatch(/^\d+s ago$/);
  });

  it('returns Nm ago in the first hour', () => {
    expect(formatRelativeTime(Date.now() - 5 * 60_000)).toMatch(/^\d+m ago$/);
  });

  it('returns Nh ago beyond an hour', () => {
    expect(formatRelativeTime(Date.now() - 5 * 3_600_000)).toMatch(/^\d+h ago$/);
  });
});

describe('detectLanguage', () => {
  it('honours response content-type when present', () => {
    expect(detectLanguage('', { 'content-type': 'application/json' })).toBe('json');
    expect(detectLanguage('', { 'Content-Type': 'text/html' })).toBe('html');
    expect(detectLanguage('', { 'content-type': 'application/xml' })).toBe('xml');
    expect(detectLanguage('', { 'content-type': 'application/javascript' })).toBe('javascript');
  });

  it('flattens an array content-type header', () => {
    expect(detectLanguage('', { 'content-type': ['application/json; charset=utf-8'] })).toBe(
      'json'
    );
  });

  it('falls back to content sniffing when no headers given', () => {
    expect(detectLanguage('  {"a":1}')).toBe('json');
    expect(detectLanguage('[1,2,3]')).toBe('json');
    expect(detectLanguage('<root>')).toBe('xml');
    expect(detectLanguage('plain text')).toBe('text');
  });
});
