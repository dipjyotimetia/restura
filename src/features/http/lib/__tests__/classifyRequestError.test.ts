import { describe, expect, it } from 'vitest';
import { classifyRequestError } from '../classifyRequestError';

const fail = (body: string, statusText = 'Error', status = 0) => ({ status, statusText, body });

describe('classifyRequestError', () => {
  it('ignores real upstream responses, including upstream 4xx/5xx', () => {
    expect(classifyRequestError(fail('nope', 'Forbidden', 403), false)).toBeNull();
    expect(classifyRequestError(fail('boom', 'Internal Server Error', 500), true)).toBeNull();
  });

  it('treats a proxy-generated HTTP status as a transport failure', () => {
    const info = classifyRequestError(
      fail('Request timeout after 30000ms', 'Proxy Error', 504),
      false
    );
    expect(info?.title).toBe('Request timed out');
  });

  describe('private / internal addresses', () => {
    const rendererMsg = 'Private/internal IP addresses are not allowed: 10.0.0.5';
    const backendMsg = `Invalid URL: ${rendererMsg}`;

    it('web: never points at the Settings toggle (the Worker policy is an env var)', () => {
      const info = classifyRequestError(fail(backendMsg, 'Proxy Error', 400), false);
      expect(info?.title).toBe('Private or internal address blocked');
      expect(info?.hint).toMatch(/desktop app|ALLOW_PRIVATE_IPS/);
      expect(info?.hint).not.toMatch(/Settings/);
    });

    it('desktop: renderer-validator block points at the Settings toggle', () => {
      const info = classifyRequestError(fail(rendererMsg), true);
      expect(info?.hint).toMatch(/Settings → Security/);
    });

    it('desktop: a main-process block does not promise the toggle fixes it', () => {
      const info = classifyRequestError(fail(backendMsg, 'Proxy Error', 400), true);
      expect(info?.hint).not.toMatch(/Settings/);
    });
  });

  it.each([
    ['Cloud metadata endpoint is blocked: 169.254.169.254', 'Cloud metadata endpoint blocked'],
    ['Localhost URLs are not allowed', 'Local or reserved host blocked'],
    [
      'Hostname "metadata.google.internal" is blocked for security reasons',
      'Local or reserved host blocked',
    ],
    [
      'TLS cipher / protocol controls are desktop-only — open this request in the Restura desktop app.',
      'Needs the desktop app',
    ],
    ['Connection timeout after 10000ms', 'Request timed out'],
    [
      'DNS lookup failed for nope.invalid: getaddrinfo ENOTFOUND nope.invalid',
      'Couldn’t resolve the host',
    ],
    ['Response too large (max 50MB)', 'Response too large'],
  ])('classifies %s', (body, title) => {
    expect(classifyRequestError(fail(body), true)?.title).toBe(title);
  });

  it('localhost hint is web-only', () => {
    expect(classifyRequestError(fail('Localhost URLs are not allowed'), false)?.hint).toMatch(
      /desktop app/
    );
    expect(
      classifyRequestError(fail('Localhost URLs are not allowed'), true)?.hint
    ).toBeUndefined();
  });

  it('only reports an unreachable proxy on web', () => {
    expect(classifyRequestError(fail('Network Error'), false)?.title).toBe(
      'Couldn’t reach the Restura proxy'
    );
    expect(classifyRequestError(fail('Network Error'), true)?.title).toBe('Request failed');
  });

  it.each([
    'Proxy request failed: internal error; reference = hits80t4614prldqq1qkusdf',
    'Proxy request failed: Network connection lost.',
    'Proxy request failed: Fetch API cannot load: http://{{missinghost}}/x',
  ])('leaves opaque web-proxy failure %j generic (no guessed cause)', (body) => {
    expect(classifyRequestError(fail(body), false)).toEqual({ title: 'Request failed', raw: body });
  });

  it('falls back to the raw message without inventing advice', () => {
    const info = classifyRequestError(fail('something unforeseen'), false);
    expect(info).toEqual({ title: 'Request failed', raw: 'something unforeseen' });
  });

  describe('connection failures (messages captured from undici and the hosted proxy)', () => {
    it('connection refused', () => {
      const info = classifyRequestError(
        fail('Request failed: connect ECONNREFUSED 127.0.0.1:9'),
        true
      );
      expect(info?.title).toBe('Connection refused');
    });

    it('connection reset / closed early', () => {
      expect(classifyRequestError(fail('Request failed: other side closed'), true)?.title).toBe(
        'Connection closed by the server'
      );
      expect(classifyRequestError(fail('read ECONNRESET'), true)?.title).toBe(
        'Connection closed by the server'
      );
    });

    it('untrusted TLS certificates, with platform-specific advice', () => {
      const msg =
        'Request failed: self-signed certificate; if the root CA is installed locally, try running Node.js with --use-system-ca';
      const desktop = classifyRequestError(fail(msg), true);
      expect(desktop?.title).toBe('TLS certificate not trusted');
      expect(desktop?.hint).toMatch(/Settings → Certificates/);
      expect(classifyRequestError(fail(msg), false)?.hint).toMatch(/desktop app/);
      expect(
        classifyRequestError(fail('Request failed: certificate has expired'), true)?.title
      ).toBe('TLS certificate not trusted');
    });
  });
});
