import { describe, expect, it } from 'vitest';
import type { HttpRequest } from '@/types';
import { importCurlCommand, parseCurlCommand } from '../importers/curl';
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

  it('keeps query values exactly as typed (+ and %2B are not decoded)', () => {
    const result = importCurlCommand(
      "curl 'https://api.example.com/s?q=a%2Bb&p=hello+world&r=x%20y&dup=1&dup=2'"
    );
    const request = result.collection.items[0]!.request as HttpRequest;
    expect(request.url).toBe('https://api.example.com/s');
    expect(request.params.map(({ key, value }) => [key, value])).toEqual([
      ['q', 'a%2Bb'],
      ['p', 'hello+world'],
      ['r', 'x%20y'],
      ['dup', '1'],
      ['dup', '2'],
    ]);
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
      'curl --url https://api.example.com --header malformed --cookie a=1 --cookie b=2 --user ada --request TRACE --proxy socks5://proxy.example.com --max-redirs 0 --max-time 1.5 --tlsv1.2 --tlsv1.3'
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
        expect.objectContaining({ kind: 'unsupported-method', method: 'TRACE' }),
      ])
    );
  });

  it('preserves an extension method (PURGE) verbatim', () => {
    const result = importCurlCommand('curl -X PURGE https://cdn.example.com/page');
    const request = result.collection.items[0]!.request as HttpRequest;
    expect(request.method).toBe('PURGE');
    expect(result.warnings.some((w) => w.kind === 'unsupported-method')).toBe(false);
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
    expect(() => importCurlCommand('curl http://')).toThrow(/invalid URL/i);
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
    // curl sends -d family data as form-urlencoded bytes, verbatim; the @file is never read.
    expect((data.collection.items[0]!.request as HttpRequest).body).toMatchObject({
      type: 'x-www-form-urlencoded',
      raw: 'literal',
    });

    const continued = importCurlCommand(
      ['curl ', '\\', '\nhttps://api.example.com/continued'].join('')
    );
    expect((continued.collection.items[0]!.request as HttpRequest).url).toContain('/continued');

    const quoted = importCurlCommand('curl https://api.example.com/escaped\\ path');
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
      {
        kind: 'schema-version',
        format: 'Postman',
        version: '9',
        note: 'Unrecognised schema; parsed as v2.1',
      },
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

  it('keeps empty quoted arguments so the URL is not consumed as the -d value', () => {
    for (const empty of ["''", '""']) {
      const request = importCurlCommand(`curl -X POST -d ${empty} https://api.example.com/x`)
        .collection.items[0]?.request as HttpRequest;
      expect(request.url).toBe('https://api.example.com/x');
      expect(request.method).toBe('POST');
      expect(request.body.raw ?? '').toBe('');
    }
  });

  it("decodes bash ANSI-C quoting ($'…') as Chrome DevTools emits it", () => {
    const request = importCurlCommand(
      "curl 'https://api.example.com/x' -H $'X-Note: it\\'s' --data-raw $'{\"a\":\"line1\\nline2\\ttab \\\\ \\x41\\u00e9\"}'"
    ).collection.items[0]?.request as HttpRequest;
    expect(request.headers.find((h) => h.key === 'X-Note')?.value).toBe("it's");
    expect(request.body.raw).toBe('{"a":"line1\nline2\ttab \\ Aé"}');
  });

  it('treats a bare $ and $ inside quotes literally', () => {
    const request = importCurlCommand(
      "curl 'https://api.example.com/x' -H 'X-Cost: $5' -H \"X-Var: $'no'\""
    ).collection.items[0]?.request as HttpRequest;
    expect(request.headers.find((h) => h.key === 'X-Cost')?.value).toBe('$5');
    expect(request.headers.find((h) => h.key === 'X-Var')?.value).toBe("$'no'");
  });
});

describe('importCurlCommand --form-string', () => {
  it('imports --form-string fields literally, never as files', () => {
    const result = importCurlCommand(
      "curl https://api.example.com/upload --form-string 'note=@not-a-file' --form-string 'empty='"
    );
    const request = result.collection.items[0]!.request as HttpRequest;
    expect(request.body.type).toBe('form-data');
    expect(request.body.formData?.map((f) => [f.key, f.value, f.type])).toEqual([
      ['note', '@not-a-file', 'text'],
      ['empty', '', 'text'],
    ]);
    expect(result.warnings).toEqual([]);
  });
});

describe('parseCurlCommand', () => {
  it('reports only the settings the command\u2019s flags set', () => {
    expect(parseCurlCommand("curl 'https://x.dev'").explicitSettings).toEqual({});
    expect(parseCurlCommand("curl -L -k --max-time 3 'https://x.dev'").explicitSettings).toEqual({
      followRedirects: true,
      verifySsl: false,
      timeout: 3000,
    });
  });
});

const importOne = (command: string) => {
  const result = importCurlCommand(command);
  return { request: result.collection.items[0]!.request as HttpRequest, warnings: result.warnings };
};
const header = (request: HttpRequest, key: string) =>
  request.headers.find((h) => h.key.toLowerCase() === key.toLowerCase())?.value;

describe('importCurlCommand body semantics (curl defaults)', () => {
  it.each([
    [
      '-d defaults to form-urlencoded',
      "curl https://x.dev -d 'a=1'",
      'x-www-form-urlencoded',
      'a=1',
    ],
    [
      'joins repeated -d with &',
      'curl https://x.dev -d a=1 --data b=2',
      'x-www-form-urlencoded',
      'a=1&b=2',
    ],
    [
      '--data-binary sends the literal text, never base64',
      "curl https://x.dev --data-binary 'hello world'",
      'x-www-form-urlencoded',
      'hello world',
    ],
    [
      'a Content-Type header picks the body type',
      "curl https://x.dev -H 'Content-Type: text/plain' --data-binary 'hello world'",
      'text',
      'hello world',
    ],
    [
      'JSON Content-Type keeps a json body',
      `curl https://x.dev -H 'content-type: application/json' -d '{"a":1}'`,
      'json',
      '{"a":1}',
    ],
    [
      'XML Content-Type keeps an xml body',
      "curl https://x.dev -H 'Content-Type: application/xml' -d '<a/>'",
      'xml',
      '<a/>',
    ],
    [
      '--data-urlencode name=content encodes the content per curl',
      "curl https://x.dev --data-urlencode 'q=a b&c'",
      'x-www-form-urlencoded',
      'q=a%20b%26c',
    ],
    [
      '--data-urlencode =content encodes without a name',
      "curl https://x.dev --data-urlencode '=a b'",
      'x-www-form-urlencoded',
      'a%20b',
    ],
    [
      '--data-urlencode encodes reserved characters',
      "curl https://x.dev --data-urlencode 'it=is (ok)!'",
      'x-www-form-urlencoded',
      'it=is%20%28ok%29%21',
    ],
    [
      '--data-urlencode with no = or @ encodes the whole value',
      "curl https://x.dev --data-urlencode 'a b'",
      'x-www-form-urlencoded',
      'a%20b',
    ],
    ['--json sets a JSON body', `curl https://x.dev --json '{"a":1}'`, 'json', '{"a":1}'],
    [
      '--json pieces concatenate without &',
      `curl https://x.dev --json '{"a":' --json '1}'`,
      'json',
      '{"a":1}',
    ],
  ])('%s', (_name, command, type, raw) => {
    const { request } = importOne(command);
    expect(request.method).toBe('POST');
    expect(request.body).toEqual({ type, raw });
  });

  it('--json adds Content-Type and Accept application/json unless overridden', () => {
    const { request } = importOne(`curl https://x.dev --json '{}' -H 'Accept: text/csv'`);
    expect(header(request, 'Content-Type')).toBe('application/json');
    expect(header(request, 'Accept')).toBe('text/csv');
  });

  it('--data-urlencode name@file is a file reference, not data', () => {
    const { request, warnings } = importOne("curl https://x.dev --data-urlencode 'q@./q.txt'");
    expect(request.body).toEqual({ type: 'x-www-form-urlencoded', raw: '' });
    expect(warnings).toContainEqual(
      expect.objectContaining({ kind: 'unresolved-file', path: './q.txt' })
    );
  });

  it('-d @file and --data-binary @file warn instead of sending the path', () => {
    const { request, warnings } = importOne(
      'curl https://x.dev -d @./a.json --data-binary @./b.bin'
    );
    expect(request.method).toBe('POST');
    expect(request.body.raw).toBe('');
    expect(warnings.map((w) => (w.kind === 'unresolved-file' ? w.path : w.kind))).toEqual([
      './a.json',
      './b.bin',
    ]);
  });

  it('--data-raw keeps a leading @ literally', () => {
    expect(importOne("curl https://x.dev --data-raw '@me'").request.body.raw).toBe('@me');
  });

  it('-G moves data into the query string and sends GET', () => {
    const { request } = importOne(
      "curl -G 'https://x.dev/s?x=0' -d 'q=1' --data-urlencode 'name=a b'"
    );
    expect(request.method).toBe('GET');
    expect(request.body).toEqual({ type: 'none' });
    expect(request.params.map((p) => [p.key, p.value])).toEqual([
      ['x', '0'],
      ['q', '1'],
      // Stored as encoded, exactly as curl puts it on the wire.
      ['name', 'a%20b'],
    ]);
  });

  it('-F stays multipart', () => {
    expect(importOne('curl https://x.dev -F a=1').request.body.type).toBe('form-data');
  });
});

describe('importCurlCommand option table (curl(1))', () => {
  it.each([
    ['-A', "curl -A 'Agent/1' https://x.dev", 'User-Agent', 'Agent/1'],
    ['--user-agent', "curl --user-agent 'Agent/1' https://x.dev", 'User-Agent', 'Agent/1'],
    ['-e', 'curl -e https://ref.dev https://x.dev', 'Referer', 'https://ref.dev'],
    [
      '--referer ;auto',
      "curl --referer 'https://ref.dev;auto' https://x.dev",
      'Referer',
      'https://ref.dev',
    ],
    ['-b', "curl -b 'a=1' https://x.dev", 'Cookie', 'a=1'],
    ['attached -H', "curl -H'X-A: 1' https://x.dev", 'X-A', '1'],
    ['attached -HFoo:bar', 'curl -HFoo:bar https://x.dev', 'Foo', 'bar'],
    ['--header=value', "curl '--header=X-B: 2' https://x.dev", 'X-B', '2'],
    ['clustered -sSLH', "curl -sSLH 'X-C: 3' https://x.dev", 'X-C', '3'],
  ])('maps %s to a header', (_flag, command, key, value) => {
    const { request, warnings } = importOne(command);
    expect(request.url).toBe('https://x.dev/');
    expect(header(request, key)).toBe(value);
    expect(warnings).toEqual([]);
  });

  it.each([
    'curl -o out.json https://x.dev',
    'curl --output out.json https://x.dev',
    'curl -w "%{http_code}" https://x.dev',
    'curl -sS -v -i https://x.dev',
    'curl --compressed https://x.dev',
    'curl -D - https://x.dev',
    'curl --connect-timeout 5 https://x.dev',
    'curl --retry 3 https://x.dev',
    'curl --resolve x.dev:443:127.0.0.1 https://x.dev',
    'curl -c jar.txt https://x.dev',
    'curl -E ./client.pem https://x.dev',
    'curl --cacert ./ca.pem https://x.dev',
    'curl -m 5 https://x.dev',
    'curl --limit-rate 1k https://x.dev',
    'curl -y 10 -Y 100 https://x.dev',
    'curl --proxy-user a:b https://x.dev',
    'curl -U a:b https://x.dev',
    'curl --aws-sigv4 aws:amz:us-east-1:s3 https://x.dev',
  ])('consumes the value of a value-taking option: %s', (command) => {
    expect(importOne(command).request.url).toBe('https://x.dev/');
  });

  it('maps attached and --flag=value methods and data', () => {
    expect(importOne('curl -XPUT https://x.dev').request.method).toBe('PUT');
    expect(importOne('curl --request=DELETE https://x.dev').request.method).toBe('DELETE');
    expect(importOne('curl -dfoo=1 https://x.dev').request.body).toEqual({
      type: 'x-www-form-urlencoded',
      raw: 'foo=1',
    });
  });

  it('maps -m to the timeout, -I to HEAD and -T to PUT', () => {
    expect(importOne('curl -m 2 https://x.dev').request.settings?.timeout).toBe(2000);
    expect(importOne('curl -I https://x.dev').request.method).toBe('HEAD');
    const upload = importOne('curl -T ./file.bin https://x.dev');
    expect(upload.request.method).toBe('PUT');
    expect(upload.warnings).toContainEqual(
      expect.objectContaining({ kind: 'unresolved-file', path: './file.bin' })
    );
  });

  it('maps --oauth2-bearer and --digest auth', () => {
    expect(importOne('curl --oauth2-bearer tok https://x.dev').request.auth).toEqual({
      type: 'bearer',
      bearer: { token: 'tok' },
    });
    expect(importOne('curl --digest -u a:b https://x.dev').request.auth).toEqual({
      type: 'digest',
      digest: { username: 'a', password: 'b' },
    });
  });

  it('-b without = is a cookie file, not a cookie', () => {
    const { request, warnings } = importOne('curl -b cookies.txt https://x.dev');
    expect(header(request, 'Cookie')).toBeUndefined();
    expect(warnings).toContainEqual(
      expect.objectContaining({ kind: 'unresolved-file', path: 'cookies.txt' })
    );
  });

  it('-H wins over -A for User-Agent', () => {
    const { request } = importOne("curl -A a -H 'User-Agent: b' https://x.dev");
    expect(request.headers.filter((h) => h.key.toLowerCase() === 'user-agent')).toHaveLength(1);
    expect(header(request, 'User-Agent')).toBe('b');
  });

  it('accepts Windows CRLF line continuations', () => {
    const { request, warnings } = importOne(
      "curl https://x.dev/a \\\r\n  -H 'X-A: 1' \\\r\n  -d 'b=2'\r\n"
    );
    expect(warnings).toEqual([]);
    expect(request.url).toBe('https://x.dev/a');
    expect(header(request, 'X-A')).toBe('1');
    expect(request.body.raw).toBe('b=2');
  });

  it('warns for meaningful options it cannot model', () => {
    expect(importOne('curl --retry 3 https://x.dev').warnings).toContainEqual({
      kind: 'unsupported-option',
      option: '--retry',
    });
  });
});

describe('importCurlCommand — less common option forms', () => {
  it('reports an unknown short switch as unsupported and keeps parsing the cluster', () => {
    const { request, warnings } = importOne("curl -@L -H 'X-A: 1' https://x.dev");
    expect(warnings).toContainEqual({ kind: 'unsupported-option', option: '-@' });
    expect(header(request, 'X-A')).toBe('1');
  });

  it.each([
    ['--basic', 'basic'],
    ['--digest', 'digest'],
    ['--ntlm', 'ntlm'],
  ] as const)('%s selects the scheme for -u credentials', (flag, type) => {
    const { request } = importOne(`curl ${flag} -u alice:pw https://x.dev`);
    expect(request.auth).toEqual({ type, [type]: { username: 'alice', password: 'pw' } });
  });

  it('--url-query appends a +literal part verbatim and url-encodes the rest', () => {
    const { request } = importOne(
      "curl --url-query '+raw=a+b' --url-query 'q=hello world' 'https://x.dev/s?flag&x=1'"
    );
    expect(request.params.map(({ key, value }) => [key, value])).toEqual([
      ['flag', ''],
      ['x', '1'],
      ['raw', 'a+b'],
      ['q', 'hello%20world'],
    ]);
  });

  it('-F name=<file reads part content from a file: warned, never read, sent empty', () => {
    const { request, warnings } = importOne(
      "curl -F 'notes=<./notes.txt;type=text/plain' https://x.dev"
    );
    expect(warnings).toContainEqual({
      kind: 'unresolved-file',
      option: '-F',
      path: './notes.txt',
    });
    expect(request.body.formData).toEqual([
      expect.objectContaining({ key: 'notes', value: '', type: 'text' }),
    ]);
  });

  it('keeps -d data form-encoded under an explicit x-www-form-urlencoded header', () => {
    const { request } = importOne(
      "curl -H 'Content-Type: application/x-www-form-urlencoded; charset=utf-8' -d 'a=1' https://x.dev"
    );
    expect(request.body).toMatchObject({ type: 'x-www-form-urlencoded', raw: 'a=1' });
  });

  it('decodes bash ANSI-C quoting, keeping unknown and dangling escapes verbatim', () => {
    const { request } = importOne("curl -H $'X-A: a\\qb' -H $'X-B: \\x41\\u00e9' https://x.dev");
    expect(header(request, 'X-A')).toBe('a\\qb');
    expect(header(request, 'X-B')).toBe('Aé');
  });

  it('treats backslash-newline (LF or CRLF) inside double quotes as a line continuation', () => {
    const { request } = importOne(
      'curl -H "X-A: one\\\ntwo" -H "X-B: a\\\r\nb" -H "X-C: \\$x" https://x.dev'
    );
    expect(header(request, 'X-A')).toBe('onetwo');
    expect(header(request, 'X-B')).toBe('ab');
    expect(header(request, 'X-C')).toBe('$x');
  });
});
