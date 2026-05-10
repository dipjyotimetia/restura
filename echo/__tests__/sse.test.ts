// @vitest-environment node
import { describe, it, expect } from 'vitest';
import app from '../index';

describe('sseEcho handler', () => {
  it('GET /sse returns Content-Type text/event-stream', async () => {
    const res = await app.request('http://localhost/sse');
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    // Cancel the body to avoid keeping the stream alive
    await res.body?.cancel();
  });

  it('first SSE event is "connected" with correct message', async () => {
    const res = await app.request('http://localhost/sse');
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    await reader.cancel();
    const text = new TextDecoder().decode(value);
    expect(text).toContain('event: connected');
    expect(text).toContain('"message":"connected"');
  });
});
