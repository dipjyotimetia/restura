import { describe, expect, it } from 'vitest';
import type { HttpRequest, RequestSettings } from '@/types';
import { generateCurl } from './curl';
import { generateJavaScript } from './javascript';
import { generatePython } from './python';
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
