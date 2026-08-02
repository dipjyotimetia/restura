import { describe, expect, it } from 'vitest';
import type { HttpRequest } from '@/types';
import { importCurlCommand } from '../importers/curl';
import { coerceHttpMethod, type ImportWarning, summarizeWarnings } from '../importers/types';

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

  it('normalizes form, binary, and repeated option variants while retaining unresolved paths', () => {
    const form = importCurlCommand(
      "curl --url https://api.example.com/upload -F title=hello -F empty -F 'asset=@./asset.png;type=image/png'"
    );
    const formRequest = form.collection.items[0]!.request as HttpRequest;
    expect(formRequest.body).toMatchObject({
      type: 'form-data',
      formData: [
        expect.objectContaining({ key: 'title', value: 'hello', type: 'text' }),
        expect.objectContaining({ key: 'empty', value: '', type: 'text' }),
        expect.objectContaining({ key: 'asset', value: '', type: 'file' }),
      ],
    });
    expect(form.warnings).toContainEqual(
      expect.objectContaining({ kind: 'unresolved-file', option: '-F', path: './asset.png' })
    );

    const binary = importCurlCommand(
      'curl https://api.example.com/raw --data-binary @./payload.bin --data-urlencode q=hello'
    );
    const binaryRequest = binary.collection.items[0]!.request as HttpRequest;
    expect(binaryRequest.body).toMatchObject({ type: 'x-www-form-urlencoded', raw: 'q=hello' });
    expect(binary.warnings).toContainEqual(
      expect.objectContaining({
        kind: 'unresolved-file',
        option: '--data-binary',
        path: './payload.bin',
      })
    );
  });

  it('handles aliases, defaulting, TLS settings, and downgraded methods', () => {
    const result = importCurlCommand(
      'curl --url https://api.example.com --header malformed --cookie a=1 --cookie b=2 --user ada --request PURGE --proxy socks5://proxy.example.com --max-redirs 0 --max-time 1.5 --tlsv1.2 --tlsv1.3'
    );
    const request = result.collection.items[0]!.request as HttpRequest;

    expect(request).toMatchObject({
      method: 'GET',
      auth: { type: 'basic', basic: { username: 'ada', password: '' } },
      settings: {
        maxRedirects: 0,
        timeout: 1500,
        minTlsVersion: 'TLSv1.3',
        proxy: expect.objectContaining({ type: 'socks5', host: 'proxy.example.com' }),
      },
    });
    expect(request.headers).toContainEqual(
      expect.objectContaining({ key: 'Cookie', value: 'a=1; b=2' })
    );
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'unsupported-option', option: '-H (malformed header)' }),
        expect.objectContaining({ kind: 'unsupported-method', method: 'PURGE' }),
      ])
    );
  });

  it('reports malformed values without treating them as shell input', () => {
    expect(() => importCurlCommand('wget https://api.example.com')).toThrow(
      /beginning with "curl"/i
    );
    expect(() => importCurlCommand('curl --request')).toThrow(/requires a value/i);
    expect(() => importCurlCommand('curl --max-redirs -1 https://api.example.com')).toThrow(
      /non-negative integer/i
    );
    expect(() => importCurlCommand('curl --max-time nope https://api.example.com')).toThrow(
      /non-negative number/i
    );
    expect(() =>
      importCurlCommand('curl --proxy ftp://proxy.example.com https://api.example.com')
    ).toThrow(/Unsupported cURL proxy/i);
    expect(() => importCurlCommand('curl https://api.example.com "unterminated')).toThrow(
      /Unterminated POSIX/i
    );
    expect(() => importCurlCommand('curl definitely-not-a-url')).toThrow(/invalid URL/i);
  });

  it('covers short cURL aliases without executing shell syntax', () => {
    const result = importCurlCommand(
      "curl -X PATCH -d alpha --data beta --data-raw gamma --data-ascii delta --data-urlencode q=hello -x https://proxy.example.com -k --location --cert ./client.pem --key ./client.key -- 'https://api.example.com/path'"
    );
    const request = result.collection.items[0]!.request as HttpRequest;

    expect(request).toMatchObject({
      method: 'PATCH',
      url: 'https://api.example.com/path',
      body: { type: 'x-www-form-urlencoded', raw: 'alpha&beta&gamma&delta&q=hello' },
      settings: {
        followRedirects: true,
        verifySsl: false,
        proxy: expect.objectContaining({ type: 'https', port: 443 }),
      },
    });
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'unresolved-file', option: '--cert' }),
        expect.objectContaining({ kind: 'unresolved-file', option: '--key' }),
      ])
    );

    const escaped = importCurlCommand('curl https://api.example.com/escaped');
    expect((escaped.collection.items[0]!.request as HttpRequest).url).toContain('/escaped');
  });

  it('rejects every shell command separator and empty positional URLs', () => {
    for (const separator of ['|', '||', '&', '&&']) {
      expect(() => importCurlCommand(`curl https://api.example.com ${separator} whoami`)).toThrow(
        /one cURL command/i
      );
    }
    expect(() => importCurlCommand('curl --')).toThrow(/does not contain a URL/i);
  });

  it('keeps file-backed data inert while supporting POSIX continuations and escaping', () => {
    const data = importCurlCommand(
      'curl https://api.example.com --data @./body.json --data-binary literal trailing-value'
    );
    expect(data.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'unresolved-file', option: '--data', path: './body.json' }),
        expect.objectContaining({ kind: 'unsupported-option', option: 'trailing-value' }),
      ])
    );
    expect((data.collection.items[0]!.request as HttpRequest).body).toMatchObject({
      type: 'binary',
      raw: 'literal',
    });

    const continued = importCurlCommand(
      ['curl ', '\\', '\nhttps://api.example.com/continued'].join('')
    );
    expect((continued.collection.items[0]!.request as HttpRequest).url).toContain('/continued');

    const quoted = importCurlCommand('curl "https://api.example.com/escaped\\ path"');
    expect((quoted.collection.items[0]!.request as HttpRequest).url).toContain('escaped%20path');

    const implicitProxy = importCurlCommand(
      'curl https://api.example.com --proxy proxy.example.com'
    );
    expect(
      (implicitProxy.collection.items[0]!.request as HttpRequest).settings?.proxy
    ).toMatchObject({
      type: 'http',
      host: 'proxy.example.com',
    });
  });

  it('summarizes cURL-specific warning messages for the review surface', () => {
    expect(
      summarizeWarnings([
        { kind: 'unsupported-option', option: '--compressed' },
        { kind: 'unresolved-file', option: '--cert', path: './client.pem' },
      ])
    ).toEqual([
      expect.objectContaining({ sample: 'cURL option "--compressed" is not supported' }),
      expect.objectContaining({ sample: 'Local file "./client.pem" from --cert was not read' }),
    ]);
  });

  it('summarizes every shared and HAR warning variant for import reviews', () => {
    const warnings = [
      { kind: 'unrecognized-body', requestName: 'Body' },
      { kind: 'unrecognized-script-type', scriptType: 'test', requestName: 'Script' },
      { kind: 'unsupported-auth', authType: 'Digest', requestName: 'Auth' },
      { kind: 'unsupported-method', method: 'PURGE', requestName: 'Method' },
      { kind: 'unknown-dynamic-var', varName: 'token', count: 1 },
      { kind: 'bruno-syntax', pattern: 'bru.getEnv', requestName: 'Bruno' },
      { kind: 'platform-unsupported', feature: 'Kafka', requestName: 'Kafka request' },
      { kind: 'schema-version', format: 'Postman', version: '3', note: 'newer export' },
      { kind: 'har-cookies-discarded', requestName: 'Cookies' },
      { kind: 'har-redirect', requestName: 'Redirect', status: 302 },
      { kind: 'har-response-discarded', requestName: 'Response' },
      { kind: 'har-entry-discarded', entry: 'Entry', reason: 'invalid URL' },
      { kind: 'har-field-discarded', requestName: 'Field', field: 'Header' },
      { kind: 'har-lossy-body', requestName: 'Body', detail: 'Binary content was discarded' },
    ] satisfies ImportWarning[];

    expect(summarizeWarnings(warnings)).toHaveLength(warnings.length);
  });

  it('defaults omitted methods and handles unquoted POSIX escapes without running shell input', () => {
    expect(coerceHttpMethod(undefined, 'Imported request')).toBe('GET');

    const escapedRequest = importCurlCommand('curl https://api.example.com/escaped\\ path')
      .collection.items[0]!.request as HttpRequest;
    expect(escapedRequest).toMatchObject({ url: 'https://api.example.com/escaped%20path' });

    const request = importCurlCommand('curl https://api.example.com\\').collection.items[0]!
      .request as HttpRequest;
    expect(request).toMatchObject({ url: 'https://api.example.com/' });
  });
});
