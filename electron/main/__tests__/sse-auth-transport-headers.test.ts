import { describe, expect, it } from 'vitest';
import { SSE_REQUEST_TRANSPORT, WS_HANDSHAKE_TRANSPORT } from '../security/ws-handshake-auth';

// Auth the main process applies to a desktop SSE request follows the same
// header rules as the user's own SSE headers (SseConnectSchema): Cookie /
// Origin are allowed, as on the web Worker; hop-by-hop fields stay refused.
describe('SSE_REQUEST_TRANSPORT header rules', () => {
  it('lets applied auth set Cookie (an API key named Cookie) and Origin', () => {
    expect(SSE_REQUEST_TRANSPORT.isForbiddenHeader('Cookie')).toBe(false);
    expect(SSE_REQUEST_TRANSPORT.isForbiddenHeader('origin')).toBe(false);
  });

  it('still refuses hop-by-hop, proxy and body-framing headers', () => {
    for (const name of [
      'Host',
      'Connection',
      'Proxy-Authorization',
      'Content-Length',
      'content-type',
    ]) {
      expect(SSE_REQUEST_TRANSPORT.isForbiddenHeader(name)).toBe(true);
    }
  });

  it('leaves the WebSocket handshake rules unchanged', () => {
    expect(WS_HANDSHAKE_TRANSPORT.isForbiddenHeader('Cookie')).toBe(
      WS_HANDSHAKE_TRANSPORT.isForbiddenHeader('cookie')
    );
    expect(WS_HANDSHAKE_TRANSPORT.isForbiddenHeader('Sec-WebSocket-Key')).toBe(true);
  });
});
