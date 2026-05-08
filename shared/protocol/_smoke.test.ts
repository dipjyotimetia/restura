import { describe, it, expect } from 'vitest';
import { __sharedProtocolSmoke } from './_smoke';

describe('shared/protocol smoke', () => {
  it('is importable from the test runner', () => {
    expect(__sharedProtocolSmoke()).toBe(42);
  });
});
