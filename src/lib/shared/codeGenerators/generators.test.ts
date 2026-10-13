import { describe, expect, it } from 'vitest';
import type { HttpRequest, RequestSettings } from '@/types';
import { generateCurl } from './curl';
import { generateGo } from './go';
import { generateJavaScript } from './javascript';
import { generateNodeJS } from './nodejs';
import { generatePhp } from './php';
import { generatePython } from './python';
import { generateRuby } from './ruby';
import type { GenerateOptions } from './types';

const request = (body: HttpRequest['body']): HttpRequest => ({
  id: 'r',
  name: 'r',
  type: 'http',
  method: 'PUT',
  url: 'https://api.dev/x',
  headers: [],
  params: [],
  body,
  auth: { type: 'none' },
});

const settings = (over: Partial<RequestSettings> = {}): RequestSettings => ({
  timeout: 5000,
  followRedirects: false,
  maxRedirects: 5,
  verifySsl: false,
  proxy: {
    enabled: true,
    type: 'http',
    host: 'proxy.local',
    port: 8080,
    auth: { username: 'u', password: 'p' },
  },
  ...over,
});

const opts = (over: Partial<GenerateOptions> = {}): GenerateOptions => ({
  request: request({ type: 'json', raw: '{"a":1}' }),
  resolvedUrl: 'https://api.dev/x',
  resolvedHeaders: { Accept: 'application/json' },
  resolvedParams: { q: 'a b' },
  ...over,
});

describe('generateCurl', () => {
  it('emits method, query, headers, body and every transport setting', () => {
    const out = generateCurl(opts({ settings: settings() }));
    expect(out).toContain("curl -X PUT 'https://api.dev/x?q=a+b'");
    expect(out).toContain("-H 'Accept: application/json'");
    expect(out).toContain(`-d '{"a":1}'`);
    expect(out).toContain("--proxy 'http://u:p@proxy.local:8080'");
    expect(out).toContain('--max-time 5');
    expect(out).toContain('--insecure');
    expect(out).toContain('--no-location');
  });

  it('caps redirects when following, tolerates a templated URL, and falls back when empty', () => {
    const following = generateCurl(
      opts({ settings: settings({ followRedirects: true, verifySsl: true, timeout: 0 }) })
    );
    expect(following).toContain('--max-redirs 5');
    expect(following).not.toContain('--insecure');
    expect(generateCurl(opts({ resolvedUrl: '{{base}}/x', resolvedParams: {} }))).toContain(
      "'{{base}}/x'"
    );
    expect(generateCurl(opts({ resolvedUrl: '' }))).toContain('https://api.example.com');
  });
});

describe('generatePython', () => {
  it('emits params, headers, json body and settings', () => {
    const out = generatePython(opts({ settings: settings() }));
    expect(out).toContain('json_data = {"a":1}');
    expect(out).toContain('params=params');
    expect(out).toContain('headers=headers');
    expect(out).toContain('json=json_data');
    expect(out).toContain('"https": "http://u:p@proxy.local:8080"');
    expect(out).toContain('timeout=5');
    expect(out).toContain('verify=False');
    expect(out).toContain('allow_redirects=False');
  });

  it('sends text bodies as data and skips empty sections', () => {
    const out = generatePython(
      opts({
        request: request({ type: 'text', raw: 'hello' }),
        resolvedHeaders: {},
        resolvedParams: {},
      })
    );
    expect(out).toContain('data = """hello"""');
    expect(out).toContain('data=data');
    expect(out).not.toContain('params=params');
    expect(out).not.toContain('headers=headers');
  });

  it('builds multipart data and files from form fields', () => {
    const out = generatePython(
      opts({
        request: request({ type: 'form-data' }),
        formData: [
          { key: 'n', value: 'v', type: 'text' },
          { key: 'f', value: 'a.pdf', type: 'file' },
        ],
      })
    );
    expect(out).toContain('"n": "v"');
    expect(out).toContain('"f": open("a.pdf", "rb")');
    expect(out).toContain('data=data');
    expect(out).toContain('files=files');
  });
});

describe('generateJavaScript', () => {
  it('appends params, escapes text bodies, and handles an unparseable URL', () => {
    expect(generateJavaScript(opts())).toContain('https://api.dev/x?q=a+b');
    expect(
      generateJavaScript(opts({ request: request({ type: 'text', raw: 'say "hi"' }) }))
    ).toContain('body: "say \\"hi\\""');
    expect(generateJavaScript(opts({ resolvedUrl: '{{base}}/x' }))).toContain('"{{base}}/x"');
  });

  it('builds a FormData body', () => {
    const out = generateJavaScript(
      opts({
        request: request({ type: 'form-data' }),
        resolvedHeaders: {},
        formData: [
          { key: 'n', value: 'v', type: 'text' },
          { key: 'f', value: 'a.pdf', type: 'file' },
        ],
      })
    );
    expect(out).toContain('form.append("n", "v");');
    expect(out).toContain('form.append("f", fileInput.files[0], "a.pdf");');
    expect(out).not.toContain('headers:');
  });
});

describe('urlWithVariables', () => {
  it('keeps {{var}} references readable after query serialization', () => {
    const out = generateCurl(opts({ resolvedParams: { t: '{{token}}', q: 'a b' } }));
    expect(out).toContain("'https://api.dev/x?t={{token}}&q=a+b'");
  });
});

describe('extension HTTP methods (#857)', () => {
  const custom = (method: string): GenerateOptions =>
    opts({ request: { ...request({ type: 'json', raw: '{"q":1}' }), method } });

  it('cURL, fetch, Go and PHP send the token verbatim', () => {
    expect(generateCurl(custom('PROPFIND'))).toContain('curl -X PROPFIND');
    expect(generateJavaScript(custom('QUERY'))).toContain('method: "QUERY"');
    expect(generateGo(custom('PURGE'))).toContain('http.NewRequest("PURGE"');
    expect(generatePhp(custom('MKCOL'))).toContain("CURLOPT_CUSTOMREQUEST, 'MKCOL'");
  });

  it('Python uses requests.request for extension methods, shorthand for known ones', () => {
    const out = generatePython(custom('PROPFIND'));
    expect(out).toContain('requests.request(\n    "PROPFIND",\n    url');
    expect(out).not.toContain('requests.propfind');
    expect(generatePython(opts())).toContain('requests.put(');
  });

  it('axios keeps an extension method verbatim', () => {
    expect(generateNodeJS(custom('customVerb'))).toContain('method: "customVerb"');
    expect(generateNodeJS(opts())).toContain('method: "put"');
  });

  it('Ruby uses HTTPGenericRequest for methods without a Net::HTTP class', () => {
    const out = generateRuby(custom('PURGE'));
    expect(out).toContain("Net::HTTPGenericRequest.new('PURGE', true, true, uri)");
    expect(out).not.toContain('Net::HTTP::Purge');
    expect(generateRuby(opts())).toContain('Net::HTTP::Put.new(uri)');
  });

  // Single-quoted PHP/Ruby strings only interpret \\ and \' — no `$var`,
  // `{$x}`, `#{x}`, `#$x`, `#@x` interpolation from a hostile token.
  const singleQuoted = (m: string) => `'${m.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

  it.each(['$HOME', '{$x}', "it's"])('PHP emits %j as an inert single-quoted literal', (m) => {
    expect(generatePhp(custom(m))).toContain(`CURLOPT_CUSTOMREQUEST, ${singleQuoted(m)});`);
  });

  it.each(['#{x}', '#$x', '#@x', "it's"])(
    'Ruby emits %j as an inert single-quoted literal',
    (m) => {
      expect(generateRuby(custom(m))).toContain(`Net::HTTPGenericRequest.new(${singleQuoted(m)}, `);
    }
  );

  it('normalises a stored lower-case known method before picking an idiom', () => {
    expect(generatePython(custom('post'))).toContain('requests.post(');
    expect(generateRuby(custom('delete'))).toContain('Net::HTTP::Delete.new(uri)');
    expect(generateNodeJS(custom('Patch'))).toContain('method: "patch"');
    expect(generatePhp(custom('get'))).not.toContain('CURLOPT_CUSTOMREQUEST');
  });
});
