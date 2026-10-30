import type { Fetcher } from '@shared/protocol/types';
import type { HttpRequest } from '@shared/types';
import { describe, expect, it, vi } from 'vitest';
import { executeHttp } from '../http';

// NTLM is desktop-only (#1069): its handshake needs the Electron fetcher's
// pinned connection. The CLI must fail explicitly instead of silently sending
// the request without authentication.
describe('CLI HTTP executor — NTLM', () => {
  it('refuses an NTLM request without touching the network', async () => {
    const fetcher = vi.fn<Fetcher>();
    const request: HttpRequest = {
      id: 'r',
      name: 'r',
      type: 'http',
      method: 'GET',
      url: 'https://intranet.example.com/x',
      headers: [],
      params: [],
      body: { type: 'none' },
      auth: { type: 'ntlm', ntlm: { username: 'alice', password: 'secret' } },
    };
    const outcome = await executeHttp(
      { relativePath: 'r', folderPath: [], type: 'http', request },
      { vars: {}, allowLocalhost: false, timeoutMs: 1000, fetcher }
    );
    expect(fetcher).not.toHaveBeenCalled();
    expect(outcome.passed).toBe(false);
    expect(outcome.errorMessage).toMatch(/NTLM authentication is desktop-only/);
  });
});
