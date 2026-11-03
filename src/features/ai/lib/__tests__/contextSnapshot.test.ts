import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/store/useRequestStore', () => ({ useRequestStore: { getState: vi.fn() } }));
vi.mock('@/store/useEnvironmentStore', () => ({ useEnvironmentStore: { getState: vi.fn() } }));

import { captureActive } from '@/features/ai/lib/contextSnapshot';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';
import { useRequestStore } from '@/store/useRequestStore';

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

  it('caps request and response bodies with a visible truncation marker', () => {
    const big = 'x'.repeat(300_000);
    vi.mocked(useRequestStore.getState).mockReturnValue({
      activeTabId: 't1',
      tabs: [
        {
          id: 't1',
          request: {
            type: 'http',
            method: 'POST',
            url: 'https://api/upload',
            headers: [],
            body: { type: 'text', raw: big },
          },
          response: { status: 200, statusText: 'OK', headers: {}, body: big },
        },
      ],
    } as never);
    const snap = captureActive();
    for (const body of [snap.request?.body ?? '', snap.response?.body ?? '']) {
      expect(body.length).toBeLessThan(33_000);
      expect(body.startsWith('x'.repeat(32_768))).toBe(true);
      expect(body).toMatch(/\[truncated: 267232 more characters\]$/);
    }
  });

  it('returns kind: request when the active tab has no response yet', () => {
    vi.mocked(useRequestStore.getState).mockReturnValue({
      activeTabId: 't1',
      tabs: [
        {
          id: 't1',
          request: {
            type: 'http',
            method: 'POST',
            url: 'https://api/x',
            headers: [],
            body: { type: 'none' },
          },
          response: null,
        },
      ],
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

  it('captures form-data bodies (not just raw) so the AI sees the payload', () => {
    vi.mocked(useRequestStore.getState).mockReturnValue({
      activeTabId: 't1',
      tabs: [
        {
          id: 't1',
          request: {
            type: 'http',
            method: 'POST',
            url: 'https://api/login',
            headers: [],
            body: {
              type: 'x-www-form-urlencoded',
              formData: [
                { id: 'f1', key: 'username', value: 'alice', enabled: true },
                { id: 'f2', key: 'grant_type', value: 'password', enabled: true },
                { id: 'f3', key: 'disabled', value: 'nope', enabled: false },
              ],
            },
          },
          response: null,
        },
      ],
    } as never);
    const snap = captureActive();
    expect(snap.request?.body).toContain('username=alice');
    expect(snap.request?.body).toContain('grant_type=password');
    expect(snap.request?.body).not.toContain('disabled=nope');
  });
});
