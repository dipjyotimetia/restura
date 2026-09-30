import { describe, expect, it } from 'vitest';
import { buildSseStreamSpec } from '../sseManager';

describe('buildSseStreamSpec', () => {
  it('builds a GET streaming spec with the orchestrator timeout disabled', () => {
    expect(buildSseStreamSpec('https://example.com/stream', { 'X-Trace': '1' })).toEqual({
      method: 'GET',
      url: 'https://example.com/stream',
      headers: { 'X-Trace': '1' },
      streamingMode: true,
      timeout: 0,
    });
  });
});
