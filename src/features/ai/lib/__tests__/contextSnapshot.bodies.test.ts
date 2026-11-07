import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/store/useRequestStore', () => ({ useRequestStore: { getState: vi.fn() } }));
vi.mock('@/store/useEnvironmentStore', () => ({ useEnvironmentStore: { getState: vi.fn() } }));

import { captureActive } from '@/features/ai/lib/contextSnapshot';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';
import { useRequestStore } from '@/store/useRequestStore';

function withTab(request: Record<string, unknown>, response: unknown = null): void {
  vi.mocked(useRequestStore.getState).mockReturnValue({
    activeTabId: 't1',
    tabs: [{ id: 't1', request, response }],
  } as never);
}

beforeEach(() => {
  vi.mocked(useEnvironmentStore.getState).mockReturnValue({
    activeEnvironmentId: null,
    environments: [],
  } as never);
});

describe('captureActive edge cases', () => {
  it('returns kind: none when the active tab id is stale', () => {
    vi.mocked(useRequestStore.getState).mockReturnValue({ activeTabId: 'gone', tabs: [] } as never);
    expect(captureActive().contextRef.kind).toBe('none');
  });

  it('captures an explicitly named tab rather than the active one', () => {
    vi.mocked(useRequestStore.getState).mockReturnValue({
      activeTabId: 't1',
      tabs: [
        { id: 't1', request: { method: 'GET', url: 'https://one' }, response: null },
        { id: 't2', request: { method: 'PUT', url: 'https://two' }, response: null },
      ],
    } as never);
    const snap = captureActive('t2');
    expect(snap.contextRef).toMatchObject({ kind: 'request', tabId: 't2' });
    expect(snap.request?.url).toBe('https://two');
  });

  it('tolerates a non-HTTP request shape (no method/url/headers/body)', () => {
    withTab({ type: 'websocket' });
    const snap = captureActive();
    expect(snap.request).toEqual({ method: '', url: '', headers: {}, body: '' });
  });

  it('renders form fields with missing keys/values as empty strings', () => {
    withTab({ body: { type: 'form-data', formData: [{ value: 'v' }, { key: 'k' }] } });
    expect(captureActive().request?.body).toBe('=v\nk=');
  });

  it('renders multipart parts with their content type, defaulting to octet-stream', () => {
    withTab({
      body: {
        type: 'multipart',
        multipartParts: [{ contentType: 'application/json', content: '{"a":1}' }, {}],
      },
    });
    expect(captureActive().request?.body).toBe(
      '[part application/json]\n{"a":1}\n[part application/octet-stream]\n'
    );
  });

  it('summarizes a binary body and leaves other empty bodies blank', () => {
    withTab({ body: { type: 'binary' } });
    expect(captureActive().request?.body).toBe('(binary body)');
    withTab({ body: { type: 'json', raw: '', formData: [], multipartParts: [] } });
    expect(captureActive().request?.body).toBe('');
  });

  it('joins multi-value response headers and tolerates a missing body', () => {
    withTab(
      { method: 'GET', url: 'https://x' },
      { status: 200, headers: { 'set-cookie': ['a=1', 'b=2'], etag: 'x' } }
    );
    const snap = captureActive();
    expect(snap.contextRef.kind).toBe('response');
    expect(snap.response).toEqual({
      status: 200,
      headers: { 'set-cookie': 'a=1, b=2', etag: 'x' },
      body: '',
    });
  });

  it('omits the environment when the active one no longer exists', () => {
    vi.mocked(useEnvironmentStore.getState).mockReturnValue({
      activeEnvironmentId: 'deleted',
      environments: [{ id: 'other', name: 'o', variables: [] }],
    } as never);
    withTab({ method: 'GET', url: 'https://x' });
    expect(captureActive()).not.toHaveProperty('environment');
  });
});
