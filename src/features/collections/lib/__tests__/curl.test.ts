import { describe, expect, it } from 'vitest';
import type { HttpRequest } from '@/types';
import { importCurlCommand } from '../importers/curl';

describe('importCurlCommand', () => {
  it('normalizes quoted POSIX input into an HTTP request without evaluating shell syntax', () => {
    const result = importCurlCommand(
      "curl --request POST 'https://api.example.com/users?role=admin' -H 'Content-Type: application/json' -H 'X-Note: $(whoami); inert' --data-raw '{\"name\":\"Ada\"}'"
    );

    const request = result.collection.items[0]!.request as HttpRequest;
    expect(request).toMatchObject({
      type: 'http',
      method: 'POST',
      url: 'https://api.example.com/users',
      params: [expect.objectContaining({ key: 'role', value: 'admin', enabled: true })],
      body: { type: 'json', raw: '{"name":"Ada"}' },
    });
    expect(request?.headers).toContainEqual(
      expect.objectContaining({ key: 'X-Note', value: '$(whoami); inert', enabled: true })
    );
  });

  it('maps auth, cookies, redirect, timeout, proxy, and insecure TLS options', () => {
    const result = importCurlCommand(
      'curl https://api.example.com/data -u ada:secret -b session=abc -L --max-redirs 3 --max-time 12 --proxy http://proxy.example.com:8080 --insecure'
    );
    const request = result.collection.items[0]!.request as HttpRequest;

    expect(request).toMatchObject({
      auth: { type: 'basic', basic: { username: 'ada', password: 'secret' } },
      settings: {
        followRedirects: true,
        maxRedirects: 3,
        timeout: 12_000,
        verifySsl: false,
        proxy: { enabled: true, type: 'http', host: 'proxy.example.com', port: 8080 },
      },
    });
    expect(request?.headers).toContainEqual(
      expect.objectContaining({ key: 'Cookie', value: 'session=abc', enabled: true })
    );
  });

  it('preserves unsupported options as warnings and does not resolve local file references', () => {
    const result = importCurlCommand(
      'curl https://api.example.com/upload --form avatar=@/tmp/avatar.png --cacert ./ca.pem --compressed'
    );

    expect(result.warnings).toContainEqual(
      expect.objectContaining({
        kind: 'unresolved-file',
        option: '--form',
        path: '/tmp/avatar.png',
      })
    );
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ kind: 'unresolved-file', option: '--cacert', path: './ca.pem' })
    );
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ kind: 'unsupported-option', option: '--compressed' })
    );
  });

  it('rejects chained and non-POSIX commands without executing their metacharacters', () => {
    expect(() =>
      importCurlCommand('curl https://api.example.com; curl https://evil.example')
    ).toThrow(/one cURL command/i);
    expect(() => importCurlCommand('curl "https://api.example.com" `\n')).toThrow(/POSIX/i);
  });
});
