import { describe, expect, it } from 'vitest';
import { describeHttpStatus } from './httpStatus';

describe('describeHttpStatus', () => {
  it('explains common codes specifically', () => {
    expect(describeHttpStatus(404)).toMatch(/^Not found/);
    expect(describeHttpStatus(429)).toMatch(/Retry-After/);
  });

  it('falls back to the class for other codes', () => {
    expect(describeHttpStatus(299)).toBe('Success.');
    expect(describeHttpStatus(499)).toMatch(/^Client error/);
    expect(describeHttpStatus(599)).toMatch(/^Server error/);
    expect(describeHttpStatus(103)).toBe('Informational response.');
    expect(describeHttpStatus(399)).toMatch(/^Redirection/);
  });

  it('returns null when there was no HTTP response', () => {
    expect(describeHttpStatus(0)).toBeNull();
    expect(describeHttpStatus(600)).toBeNull();
    expect(describeHttpStatus(200.5)).toBeNull();
  });
});
