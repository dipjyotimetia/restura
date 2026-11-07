import { beforeEach, describe, expect, it } from 'vitest';
import type { Request, Response } from '@/types';
import { useHistoryStore } from '../useHistoryStore';

const httpRequest = {
  id: 'r1',
  type: 'http',
  name: 'r',
  method: 'GET',
  url: 'https://user:pw@api.test/x?api_key=abc&q=1',
  headers: [
    { id: 'h1', key: 'Authorization', value: 'Bearer secret', enabled: true },
    { id: 'h2', key: 'Accept', value: 'application/json', enabled: true },
  ],
  params: [],
  body: { type: 'none' },
  auth: { type: 'none' },
} as unknown as Request;

const response = {
  id: 'resp',
  requestId: 'r1',
  status: 200,
  statusText: 'OK',
  headers: { 'Set-Cookie': 'sid=1', 'Content-Type': 'text/plain' },
  setCookies: ['sid=1'],
  body: '',
  size: 0,
  time: 1,
} as unknown as Response;

describe('history redaction (#924)', () => {
  beforeEach(() => useHistoryStore.getState().clearHistory());

  it('blanks inline credentials, resolved URL secrets and Set-Cookie', () => {
    useHistoryStore
      .getState()
      .addHistoryItem(httpRequest, response, 'https://user:pw@api.test/x?api_key=abc&q=1');
    const item = useHistoryStore.getState().history[0];
    if (!item || item.request.type !== 'http') throw new Error('missing history item');
    expect(item.request.headers.find((h) => h.key === 'Authorization')?.value).toBe('');
    expect(item.request.headers.find((h) => h.key === 'Accept')?.value).toBe('application/json');
    expect(item.request.url).not.toContain('pw@');
    expect(item.request.url).not.toContain('abc');
    expect(item.resolvedUrl).not.toContain('pw@');
    expect(item.resolvedUrl).not.toContain('abc');
    expect(item.response?.headers['Set-Cookie']).toBe('');
    expect(item.response?.headers['Content-Type']).toBe('text/plain');
    expect(item.response?.setCookies).toEqual(['sid=[REDACTED]']);
  });
});
