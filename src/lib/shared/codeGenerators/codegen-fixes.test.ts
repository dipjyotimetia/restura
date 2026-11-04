import { describe, expect, it } from 'vitest';
import type { HttpRequest } from '@/types';
import { generateCurl } from './curl';
import { generateJavaScript } from './javascript';
import { generatePython } from './python';
import type { GenerateOptions } from './types';

const request = (over: Partial<HttpRequest> = {}): HttpRequest => ({
  id: 'r',
  name: 'r',
  type: 'http',
  method: 'POST',
  url: 'https://api.dev/x',
  headers: [],
  params: [],
  body: { type: 'none' },
  auth: { type: 'none' },
  ...over,
});

const opts = (over: Partial<GenerateOptions> = {}): GenerateOptions => ({
  request: request(),
  resolvedUrl: 'https://api.dev/x',
  resolvedHeaders: {},
  resolvedParams: {},
  ...over,
});

describe('generatePython text-only form-data', () => {
  it('emits files={k: (None, v)} so requests sends multipart', () => {
    const out = generatePython(
      opts({
        request: request({ body: { type: 'form-data' } }),
        formData: [{ key: 'a', value: 'b', type: 'text' }],
      })
    );
    expect(out).toContain('"a": (None, "b")');
    expect(out).toContain('files=files');
    expect(out).not.toContain('data=data');
  });

  it('keeps data= + files= for mixed fields', () => {
    const out = generatePython(
      opts({
        request: request({ body: { type: 'form-data' } }),
        formData: [
          { key: 'a', value: 'b', type: 'text' },
          { key: 'f', value: 'x.bin', type: 'file' },
        ],
      })
    );
    expect(out).toContain('data=data');
    expect(out).toContain('files=files');
  });
});

describe('query string preservation', () => {
  it('curl keeps %20 in the given query when appending params', () => {
    const out = generateCurl(
      opts({ resolvedUrl: 'https://api.dev/x?a=b%20c', resolvedParams: { q: '1' } })
    );
    expect(out).toContain("'https://api.dev/x?a=b%20c&q=1'");
  });

  it('curl keeps %20 when there are no extra params', () => {
    const out = generateCurl(opts({ resolvedUrl: 'https://api.dev/x?a=b%20c' }));
    expect(out).toContain("'https://api.dev/x?a=b%20c'");
  });

  it('fetch keeps %20 in the given query', () => {
    const out = generateJavaScript(
      opts({ resolvedUrl: 'https://api.dev/x?a=b%20c', resolvedParams: { q: '1' } })
    );
    expect(out).toContain('https://api.dev/x?a=b%20c&q=1');
  });
});

describe('fetch snippet GET/HEAD with body', () => {
  it('omits body for GET', () => {
    const out = generateJavaScript(
      opts({
        request: request({ method: 'GET', body: { type: 'json', raw: '{"a":1}' } }),
      })
    );
    expect(out).not.toMatch(/^\s*body:/m);
    expect(out).toContain('GET/HEAD');
  });

  it('omits body for HEAD form-data', () => {
    const out = generateJavaScript(
      opts({
        request: request({ method: 'HEAD', body: { type: 'form-data' } }),
        formData: [{ key: 'a', value: 'b', type: 'text' }],
      })
    );
    expect(out).not.toMatch(/^\s*body:/m);
  });

  it('keeps body for POST', () => {
    const out = generateJavaScript(
      opts({ request: request({ body: { type: 'text', raw: 'hi' } }) })
    );
    expect(out).toMatch(/^\s*body:/m);
  });
});
