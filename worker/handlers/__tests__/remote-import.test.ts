// @vitest-environment node

import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { createRemoteImportHandler } from '../remote-import';

function appFor(fetcher = fetch) {
  const app = new Hono();
  app.post('/remote-import', createRemoteImportHandler(undefined, fetcher));
  return app;
}

describe('remote import handler', () => {
  it('returns only bounded fetched text for a valid URL', async () => {
    const response = await appFor(
      vi
        .fn()
        .mockResolvedValue(
          new Response('{"openapi":"3.0.0"}', { headers: { 'content-type': 'application/json' } })
        )
    ).request('/remote-import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/openapi.json' }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      finalUrl: 'https://example.com/openapi.json',
      contentType: 'application/json',
    });
  });

  it('rejects invalid schemas and blocked URLs before fetch', async () => {
    const fetcher = vi.fn();
    const app = appFor(fetcher);
    const missing = await app.request('/remote-import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    const blocked = await app.request('/remote-import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://127.0.0.1/a' }),
    });

    expect(missing.status).toBe(400);
    expect(blocked.status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('uses the Node hostname guard and keeps unknown failures generic', async () => {
    const guard = vi.fn().mockResolvedValue(undefined);
    const app = new Hono();
    app.post(
      '/remote-import',
      createRemoteImportHandler(
        guard,
        vi.fn().mockResolvedValue(new Response('ok', { headers: { 'content-type': 'text/plain' } }))
      )
    );

    const response = await app.request('/remote-import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/import.txt' }),
    });
    expect(response.status).toBe(200);
    expect(guard).toHaveBeenCalledWith('example.com', {
      allowLocalhost: false,
      allowPrivateIPs: false,
    });

    const failed = await appFor(vi.fn().mockRejectedValue('unexpected')).request('/remote-import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/import.txt' }),
    });
    await expect(failed.json()).resolves.toEqual({ error: 'Remote import failed.' });
  });
});
