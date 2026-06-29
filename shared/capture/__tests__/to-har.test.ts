import { describe, expect, it } from 'vitest';
import { sessionToHar } from '../to-har';
import type { CaptureSession } from '../types';

const session: CaptureSession = {
  id: 's1',
  createdAt: 0,
  exchanges: [
    {
      id: '1',
      protocol: 'rest',
      method: 'POST',
      url: 'https://api.example.com/users',
      startedAt: 1700000000000,
      request: {
        headers: [{ name: 'content-type', value: 'application/json' }],
        body: { text: '{"name":"ada"}', mimeType: 'application/json' },
      },
      response: { status: 201, statusText: 'Created', headers: [] },
    },
  ],
};

describe('sessionToHar', () => {
  it('produces a HAR 1.2 log with one entry', () => {
    const har = sessionToHar(session);
    expect(har.log.version).toBe('1.2');
    expect(har.log.entries).toHaveLength(1);
    expect(har.log.entries[0]?.request.method).toBe('POST');
    expect(har.log.entries[0]?.request.url).toBe('https://api.example.com/users');
    expect(har.log.entries[0]?.response.status).toBe(201);
  });
});
