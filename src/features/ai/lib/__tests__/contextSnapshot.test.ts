import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/store/useRequestStore', () => ({ useRequestStore: { getState: vi.fn() } }));
vi.mock('@/store/useEnvironmentStore', () => ({ useEnvironmentStore: { getState: vi.fn() } }));

import { captureActive } from '@/features/ai/lib/contextSnapshot';
import { useRequestStore } from '@/store/useRequestStore';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';

describe('captureActive', () => {
  beforeEach(() => {
    vi.mocked(useRequestStore.getState).mockReturnValue({
      activeTabId: 't1',
      tabs: [
        {
          id: 't1',
          request: {
            type: 'http',
            method: 'GET',
            url: 'https://api/users',
            headers: [{ id: 'h1', key: 'Authorization', value: 'Bearer x', enabled: true }],
            body: { type: 'none', raw: '' },
          },
          response: {
            status: 401,
            statusText: 'Unauthorized',
            headers: { 'WWW-Authenticate': 'Bearer' },
            body: '{"error":"unauth"}',
          },
        },
      ],
    } as never);
    vi.mocked(useEnvironmentStore.getState).mockReturnValue({
      activeEnvironmentId: 'staging',
      environments: [
        {
          id: 'staging',
          name: 'Staging',
          variables: [
            { id: 'v1', key: 'baseUrl', value: 'https://api', enabled: true },
            { id: 'v2', key: 'token', value: 'sk-1', enabled: true },
          ],
        },
      ],
    } as never);
  });

  it('returns a snapshot keyed to the active tab with the latest response', () => {
    const snap = captureActive();
    expect(snap.contextRef.kind).toBe('response');
    expect(snap.contextRef.tabId).toBe('t1');
    expect(snap.request?.url).toBe('https://api/users');
    expect(snap.request?.headers.Authorization).toBe('Bearer x');
    expect(snap.response?.status).toBe(401);
    expect(snap.environment?.baseUrl).toBe('https://api');
  });

  it('returns kind: request when the active tab has no response yet', () => {
    vi.mocked(useRequestStore.getState).mockReturnValue({
      activeTabId: 't1',
      tabs: [{ id: 't1', request: { type: 'http', method: 'POST', url: 'https://api/x', headers: [], body: { type: 'none' } }, response: null }],
    } as never);
    const snap = captureActive();
    expect(snap.contextRef.kind).toBe('request');
    expect(snap.response).toBeUndefined();
  });

  it('returns kind: none when no active tab', () => {
    vi.mocked(useRequestStore.getState).mockReturnValue({ activeTabId: null, tabs: [] } as never);
    const snap = captureActive();
    expect(snap.contextRef.kind).toBe('none');
    expect(snap.request).toBeUndefined();
  });
});
